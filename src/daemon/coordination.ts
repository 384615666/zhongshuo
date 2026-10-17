import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync, lstatSync,realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { enqueueOutbox } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { coordinationCallAvailable, validateCoordinationPlan, coordinationTopologicalSteps,type CoordinationPlan, type CoordinationDetails } from '../contracts/coordination.ts';
import { snapshotConversationWriteAccess } from './projectWriteAccess.ts';
import { resolveMemberRuntime } from './memberRuntime.ts';
import { memberExecutableStatus } from './memberManagement.ts';
import {readThreadMembers} from './threadMembers.ts';

type ScopeMember = { memberId: string; displayName: string; description: string | null; writeScope: string | null; unavailableReason?: string };
type Parent = { id: string; project_id: string; conversation_id: string; room_id: string; conversation_thread_id: string; root_message_id: string; owner_member_id: string; title: string; stop_generation: number; status: string; source_connection_id:string|null };
export type CoordinationRun = { run_id: string; task_id: string; stop_generation: number; state: string; plan_json: string | null; integration_run_id: string | null };

function event(db: ZhongshuoDatabase, task: Parent, runId: string, kind: string, payload: Record<string, unknown>) {
  appendDomainEvent(db, { schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: task.project_id,
    conversationId: task.conversation_id, threadId: task.conversation_thread_id, taskId: task.id,
    runId, kind, payload, createdAt: Date.now() });
}

/** Shared bounded room roster for pre-submit CLI initialization and durable scope. */
export function coordinationRoomMembers(db:ZhongshuoDatabase,roomId:string,projectId:string,selectedIds?:readonly string[]) {
  return db.prepare(`SELECT pm.id,pm.display_name,pm.description FROM room_members rm
    JOIN project_members pm ON pm.id=rm.member_id WHERE rm.room_id=? AND pm.project_id=? AND pm.enabled=1 AND pm.principal_type='agent'
    AND (? IS NULL OR pm.id IN(SELECT value FROM json_each(?))) ORDER BY pm.id LIMIT 13`)
    .all(roomId,projectId,selectedIds?JSON.stringify(selectedIds):null,selectedIds?JSON.stringify(selectedIds):null) as {id:string;display_name:string;description:string|null}[];
}

/** Called in the original send transaction; never lets the model grant itself new members. */
export function freezeCoordinationScope(db: ZhongshuoDatabase, taskId: string | null) {
  if (!taskId) return;
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as Parent & { route_json: string | null };
  if (!task?.route_json || !['AUTO','DELIBERATE'].includes(JSON.parse(task.route_json).mode)) return;
  if(task.source_connection_id!=null)throw Error('本版协作仅开放本机已授权发送；外部来源协作尚未接入授权预算');
  if (db.prepare('SELECT 1 FROM coordination_scopes WHERE task_id=?').get(taskId)) return;
  const route=JSON.parse(task.route_json) as {mode:string;frozenMemberIds:string[];participantScope?:'selected'};
  const members=coordinationRoomMembers(db,task.room_id,task.project_id,route.mode==='AUTO'&&route.participantScope!=='selected'?undefined:route.frozenMemberIds);
  if (members.length > 12) throw Error('自动协作最多选择 12 位房间成员；请先调整房间名单');
  if(!members.some(m=>m.id===task.owner_member_id))throw Error('协调者必须是本房间启用的 AI 成员');
  const roster: ScopeMember[] = members.map(m => {
    try {
      const runtime=resolveMemberRuntime(db,m.id,process.env.ZS_RUNTIME??null);
      if(!['claude','codex','fake'].includes(runtime.kind??''))throw Error('成员未配置可执行渠道');
      const program=memberExecutableStatus(runtime.kind,runtime.executable??runtime.kind);if(program.status==='missing')throw Error(program.reason);
      return { memberId:m.id, displayName:m.display_name, description:m.description,
      writeScope:snapshotConversationWriteAccess(db,taskId,process.env.ZS_RUNTIME??null,m.id) }; }
    catch (error) { return { memberId:m.id,displayName:m.display_name,description:m.description,writeScope:null,unavailableReason:String(error) }; }
  });
  db.prepare('INSERT INTO coordination_scopes(task_id,roster_json,created_at) VALUES(?,?,?)').run(taskId,JSON.stringify(roster),Date.now());
}

function memberBrief(member:ScopeMember) {
  const snapshot=member.writeScope?JSON.parse(member.writeScope) as {runtime?:{kind:string;model:string|null;permissionMode:string|null}}:null;
  return {memberId:member.memberId,displayName:member.displayName,description:member.description,available:member.writeScope!=null,
    channel:snapshot?.runtime?.kind??null,model:snapshot?.runtime?.model??null,permissionMode:snapshot?.runtime?.permissionMode??null,reason:member.unavailableReason};
}

export function coordinationRoster(db: ZhongshuoDatabase, taskId: string,runId?:string): ScopeMember[] {
  if(runId){const request=db.prepare('SELECT roster_json FROM thread_reply_requests WHERE task_id=? AND run_id=?').get(taskId,runId) as {roster_json:string}|undefined;if(request)return JSON.parse(request.roster_json) as ScopeMember[];}
  const row=db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(taskId) as {roster_json:string}|undefined;
  return row ? JSON.parse(row.roster_json) as ScopeMember[] : [];
}

export function childCoordination(db: ZhongshuoDatabase, taskId: string) {
  return db.prepare(`SELECT c.*,s.role,s.step_key,s.handoff_json FROM coordination_steps s JOIN coordination_runs c ON c.run_id=s.run_id WHERE s.child_task_id=?`)
    .get(taskId) as (CoordinationRun & {role:string;step_key:string;handoff_json:string|null})|undefined;
}

export function coordinationDispatchContext(db: ZhongshuoDatabase, taskId: string, dispatchKey: string) {
  type Request={messageId:string;memberId:string;text:string;seq:number;writeScopeJson:string};
  const requestRow=(where:string,key:string)=>db.prepare(`SELECT q.message_id messageId,q.member_id memberId,json_extract(m.body_json,'$.text') text,q.input_thread_seq seq,q.write_scope_json writeScopeJson
    FROM thread_reply_requests q JOIN messages m ON m.id=q.message_id WHERE q.task_id=? AND ${where}=?`).get(taskId,key) as Request|undefined;
  const request=requestRow('q.dispatch_key',dispatchKey);
  const child = childCoordination(db,taskId);
  if (child) return { kind:'child' as const, run:child, request:undefined as Request|undefined, readonly:child.role!=='implementation',
    note:`你正在执行协调分工步骤 ${child.step_key}，角色 ${child.role}。只完成本步骤；需要同伴继续核对时使用本轮已开放的 handoffs，不提升写权限或扩大目标。分析和评审只读；结论作为正式工作交付提交 responseKind=work。\n冻结的上游交接：${child.handoff_json??'无前置步骤'}` };
  const repair=db.prepare(`SELECT c.* FROM format_repair_workitems f JOIN agent_turns a ON a.id=f.source_turn_id
    JOIN coordination_integration_attempts i ON i.execution_run_id=a.run_id JOIN coordination_runs c ON c.run_id=i.coordination_run_id
    WHERE f.target_dispatch_key=? AND f.status IN ('pending','consumed') AND c.task_id=? AND c.state IN ('blocked','integrating')`).get(dispatchKey,taskId) as CoordinationRun|undefined;
  const integration=repair??db.prepare("SELECT * FROM coordination_runs WHERE task_id=? AND state='integrating'").get(taskId) as CoordinationRun|undefined;
  if(integration && (repair || dispatchKey===`task:${taskId}:redispatch:coord_${integration.run_id}`)) {
    const steps=db.prepare(`SELECT s.step_key,s.role,s.handoff_json,t.id,t.title,t.current_delivery_id FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id WHERE s.run_id=? ORDER BY s.rowid`).all(integration.run_id);
    const incoming=db.prepare(`SELECT h.id,h.source_member_id,h.target_member_id,h.body,h.body_hash,d.id deliveryId,d.revision,d.manifest_hash manifestHash FROM coordination_messages h JOIN agent_turns a ON a.id=h.source_turn_id LEFT JOIN task_deliveries d ON d.run_id=a.run_id WHERE h.coordination_run_id=? AND h.child_task_id IS NULL ORDER BY h.created_at,h.id LIMIT 32`).all(integration.run_id);
    return {kind:'integration' as const,run:integration,request:requestRow('q.run_id',integration.run_id),repair:Boolean(repair),readonly:false,note:`整合已完成的真实成员工作。不得声称自己代替其他成员执行；核对成果与评审，按用户请求补齐必要整合并交付。不得再次生成计划。历史版本仅代表当时材料；后继实施可能已形成新版本，评审只对其冻结输入负责。\n本轮计划：${integration.plan_json}\n步骤与版本交接：${JSON.stringify(steps)}\n同伴交回的真实消息（保留作者、消息hash和来源版本）：${JSON.stringify(incoming)}`};
  }
  const task=db.prepare('SELECT route_json FROM tasks WHERE id=?').get(taskId) as {route_json:string|null};
  const queued=db.prepare('SELECT route_json,roster_json FROM thread_reply_requests WHERE dispatch_key=? AND task_id=?').get(dispatchKey,taskId) as {route_json:string;roster_json:string}|undefined;
  const routeJson=queued?.route_json??task.route_json;
  if(routeJson && JSON.parse(routeJson).mode==='AUTO' && !dispatchKey.includes(':conversation:')) {
    return {kind:'planning' as const,run:null,request,readonly:true,note:`你是协调成员。本轮只读规划，不修改文件。房间已授权名单内的正式分工不需要用户逐步确认，不使用 request_participant；超出名单的成员不得派发。需要创建或修改文件时请安排实施步骤，不以规划角色只读为由拒绝整个任务；需要协作时优先不同成员实施和独立评审。所有步骤连同本次规划共用信封预算，必须预留2次整合，不能给子任务重新扩充总预算。简单问候、普通提问直接自然回答，responseKind=conversation，coordinationPlan=null。需要同伴接手时可在 handoffs 提交具体消息（toMemberId、message、purpose）；复杂依赖也可提交 coordinationPlan，不能两者同时提交。coordinationPlan 字段为（summary 与 steps，最多8步；每步 key/memberId/title/objective/role/dependsOn）。role 为 analysis/implementation/review；分析评审程序强制只读；实施按成员现有权限执行、共享目录单写。按需安排不同成员，评审须依赖实施并读取实际文件。依赖只能引用本计划key且无环。只有程序接受计划才算已派发。最终整合由你完成。可用成员及配置范围：${JSON.stringify((queued?JSON.parse(queued.roster_json) as ScopeMember[]:coordinationRoster(db,taskId)).map(memberBrief))}`};
  }
  return null;
}

/** Conservative aggregate accounting includes failed startup and UNKNOWN reservations. */
export function coordinationCallsUsed(db: ZhongshuoDatabase, runId: string): number {
  return (db.prepare(`SELECT count(*) n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
    WHERE a.run_id=? OR a.run_id IN (SELECT execution_run_id FROM coordination_integration_attempts WHERE coordination_run_id=?)
      OR r.task_id IN (SELECT child_task_id FROM coordination_steps WHERE run_id=?)`).get(runId,runId,runId) as {n:number}).n;
}

export function coordinationCallLimit(db: ZhongshuoDatabase,runId:string) {
  const row=db.prepare('SELECT budget_json FROM workflow_runs WHERE id=?').get(runId) as {budget_json:string|null};
  const budget=row.budget_json?JSON.parse(row.budget_json) as {maxTurns?:number}:{};
  return Math.min(24,budget.maxTurns??24);
}

export function validatePlanForRun(db:ZhongshuoDatabase,taskId:string,runId:string,value:unknown) {
  const roster=coordinationRoster(db,taskId,runId);
  const plan=validateCoordinationPlan(value,roster.filter(m=>m.writeScope).map(m=>m.memberId));
  for(const step of plan.steps)if(step.role==='implementation'){
    const scope=JSON.parse(roster.find(m=>m.memberId===step.memberId)!.writeScope!) as {executionMode?:string;authorized?:boolean|number;memberPermission?:string};
    if(scope.executionMode!=='full'&&!(scope.authorized&&['acceptEdits','dontAsk'].includes(scope.memberPermission??'')))throw Error('计划把实施工作分给了只读成员；请选择本轮已获写权限的成员或改为分析/评审');
  }
  if(coordinationCallsUsed(db,runId)+plan.steps.length+2>coordinationCallLimit(db,runId))throw Error('分工步骤超出本轮总预算与整合预留；请缩减步骤');
  return plan;
}

export function assertCoordinationDispatch(db: ZhongshuoDatabase, taskId: string, dispatchKey: string, reservedTurnId?: string) {
  const context=coordinationDispatchContext(db,taskId,dispatchKey);
  if(context&&(db.prepare('SELECT source_connection_id FROM tasks WHERE id=?').get(taskId) as {source_connection_id:string|null}).source_connection_id!=null)throw Error('外部来源协作授权未开放；未派发');
  if (!context?.run) return;
  const parent=db.prepare('SELECT stop_generation,status FROM tasks WHERE id=?').get(context.run.task_id) as {stop_generation:number;status:string};
  if(parent.stop_generation!==context.run.stop_generation || parent.status==='CANCELLED' || (!['running','integrating'].includes(context.run.state)&&!(context.kind==='integration'&&context.repair&&context.run.state==='blocked'))) throw Error('父协作已停止或本轮分工已失效；未派发');
  const target=db.prepare('SELECT owner_member_id,conversation_thread_id FROM tasks WHERE id=?').get(taskId) as {owner_member_id:string;conversation_thread_id:string};
  const member=context.request?.memberId??target.owner_member_id;
  if(!readThreadMembers(db,target.conversation_thread_id).eligibleMemberIds.includes(member))throw Error('接手的 AI 已移出本串或停用；未派发，已保存的历史保留');
  const root=(db.prepare('SELECT p.canonical_path FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=?').get(taskId) as {canonical_path:string}).canonical_path;
  const keys=context.kind==='child'?dependencyKeys(JSON.parse(context.run.plan_json!) as CoordinationPlan,context.run.step_key):undefined;
  verifyHandoffFiles({files:managedHandoffFiles(db,context.run.run_id,keys)},root);
  const ownReservation=reservedTurnId&&db.prepare('SELECT 1 FROM agent_turns WHERE id=?').get(reservedTurnId)?1:0;
  const used=coordinationCallsUsed(db,context.run.run_id)-ownReservation;
  const reserve=context.kind==='integration'?0:2;
  if(!coordinationCallAvailable(used,context.kind==='integration'?'integration':'work') || used>=coordinationCallLimit(db,context.run.run_id)-reserve) throw Error('本轮协作总调用预算已用尽；保留成果，未继续派发');
}

function verifyHandoffFiles(value:unknown,root:string,depth=0,budget={remaining:32*1024*1024}):void {
  if(depth>12)throw Error('交接记录超出有界嵌套范围');
  if(!value || typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value)verifyHandoffFiles(item,root,depth+1,budget);return;}
  const row=value as Record<string,unknown>;
  if(Array.isArray(row.files))for(const raw of row.files){
    if(!raw||typeof raw!=='object')continue;
    const file=raw as {path?:string;sha256?:string;state?:string};if(!file.path)throw Error('交接文件缺少路径');
    const path=resolve(root,file.path),rel=relative(root,path);
    if(rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw Error('交接文件越出项目');
    if(file.state==='absent'){
      try{lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      throw Error('交接版本已删除的文件被重新创建；未继续派发');
    }
    if(file.state!=='present'||!file.sha256)throw Error('交接文件状态或hash未知，不能冒充已核验');
    const physical=realpathSync.native(path),physicalRelative=relative(realpathSync.native(root),physical);
    if(physicalRelative==='..'||physicalRelative.startsWith('../')||physicalRelative.startsWith('..\\')||isAbsolute(physicalRelative))throw Error('交接文件物理身份越出项目');
    const stat=statSync(physical);budget.remaining-=stat.size;
    if(!stat.isFile()||budget.remaining<0||createHash('sha256').update(readFileSync(physical)).digest('hex')!==file.sha256)throw Error('交接版本的文件字节已变化或超过32MiB总核验上限；未继续派发');
  }
  for(const key of ['upstream','output'])if(row[key])verifyHandoffFiles(row[key],root,depth+1,budget);
}

type FrozenFile={path:string;sha256:string|null;state:string};
function dependencyKeys(plan:CoordinationPlan,key:string):Set<string> {
  const keys=new Set<string>();
  const visit=(current:string)=>{for(const dependency of plan.steps.find(s=>s.key===current)?.dependsOn??[]){if(keys.has(dependency))continue;keys.add(dependency);visit(dependency);}};
  visit(key);return keys;
}
function managedHandoffFiles(db:ZhongshuoDatabase,runId:string,keys?:Set<string>):FrozenFile[] {
  const run=db.prepare('SELECT plan_json FROM coordination_runs WHERE run_id=?').get(runId) as {plan_json:string};
  const plan=JSON.parse(run.plan_json) as CoordinationPlan;
  const steps=db.prepare('SELECT step_key,handoff_json FROM coordination_steps WHERE run_id=? ORDER BY rowid LIMIT 8').all(runId) as {step_key:string;handoff_json:string|null}[];
  const latest=new Map<string,{file:FrozenFile;producer:string}>();
  for(const ordered of coordinationTopologicalSteps(plan)){
    const step=steps.find(s=>s.step_key===ordered.key);if(!step)throw Error('分工步骤身份缺失');
    if(keys&&!keys.has(step.step_key))continue;
    const data=JSON.parse(step.handoff_json??'{}') as {output?:{files:FrozenFile[]}};
    const dependencies=dependencyKeys(plan,step.step_key);
    for(const file of data.output?.files??[]){
      const previous=latest.get(file.path);
      const changed=previous&&(previous.file.state!==file.state||previous.file.sha256!==file.sha256);
      if(changed&&!dependencies.has(previous.producer))throw Error('多个实施步骤改动同一路径但没有显式依赖交接；不能覆盖先前成果');
      if(!previous||changed)latest.set(file.path,{file,producer:step.step_key});
    }
  }
  return [...latest.values()].map(x=>x.file);
}

export function beginCoordination(db: ZhongshuoDatabase, taskId: string, runId: string, kind: 'planning'|'integration',coordinationRunId?:string) {
  if(kind==='integration') {
    if(!coordinationRunId)throw Error('整合缺少原协作身份');
    db.prepare("UPDATE coordination_runs SET integration_run_id=?,state='integrating',error_message=NULL WHERE run_id=? AND task_id=? AND state IN ('integrating','blocked')").run(runId,coordinationRunId,taskId);
    db.prepare('INSERT INTO coordination_integration_attempts(coordination_run_id,execution_run_id) VALUES(?,?)').run(coordinationRunId,runId);
    db.prepare("UPDATE workflow_runs SET status='SUCCEEDED',stage='分工已完成' WHERE id=(SELECT run_id FROM coordination_runs WHERE integration_run_id=?)").run(runId);
    db.prepare("UPDATE workflow_runs SET stage='整合交付' WHERE id=?").run(runId);
    return;
  }
  const t=db.prepare('SELECT stop_generation FROM tasks WHERE id=?').get(taskId) as {stop_generation:number};
  db.prepare("INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,created_at) VALUES(?,?,?,'planning',?)").run(runId,taskId,t.stop_generation,Date.now());
  db.prepare("UPDATE workflow_runs SET stage='规划分工' WHERE id=?").run(runId);
}

/** Must be called inside the validated planning output transaction. */
export function acceptCoordinationPlan(db: ZhongshuoDatabase, taskId: string, runId: string, value: unknown) {
  const existing=db.prepare('SELECT * FROM coordination_runs WHERE run_id=? AND task_id=?').get(runId,taskId) as CoordinationRun|undefined;
  if (!existing || existing.state!=='planning') throw Error('本轮规划身份已失效');
  const parent=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as Parent;
  const request=db.prepare('SELECT message_id,member_id FROM thread_reply_requests WHERE task_id=? AND run_id=?').get(taskId,runId) as {message_id:string;member_id:string}|undefined;
  if(request){parent.root_message_id=request.message_id;parent.owner_member_id=request.member_id;}
  if(parent.stop_generation!==existing.stop_generation || parent.status==='CANCELLED') throw Error('规划期间用户已停止');
  const roster=coordinationRoster(db,taskId,runId);
  const plan=validatePlanForRun(db,taskId,runId,value);
  for(const step of coordinationTopologicalSteps(plan)) {
    const member=roster.find(m=>m.memberId===step.memberId)!;
    const current=db.prepare('SELECT project_id,enabled FROM project_members WHERE id=?').get(step.memberId) as {project_id:string;enabled:number}|undefined;
    if(current?.project_id!==parent.project_id || current.enabled!==1) throw Error('计划成员已停用或不属于项目');
    const childId=`task_${randomUUID()}`;
    const route={kind:'dispatch',mode:'DIRECT',targetMemberId:step.memberId,frozenMemberIds:[step.memberId],initialWakeMemberIds:[step.memberId]};
    db.prepare(`INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,owner_member_id,parent_task_id,title,objective,status,review_policy,route_json,write_scope_json)
      VALUES(?,?,?,'room_task',?,?,?,?,?,?,?,'OPEN','auto_deliver',?,?)`).run(childId,parent.project_id,parent.conversation_id,parent.room_id,parent.conversation_thread_id,parent.root_message_id,step.memberId,taskId,step.title,step.objective,JSON.stringify(route),member.writeScope);
    // Migration 050's frozen legacy AFTER INSERT trigger initializes every task.
    // Apply the already-authorized send snapshot afterwards, in this same transaction.
    db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(member.writeScope,childId);
    db.prepare('UPDATE tasks SET source_connection_id=? WHERE id=?').run(parent.source_connection_id,childId);
    db.prepare('INSERT INTO coordination_steps(run_id,step_key,child_task_id,role) VALUES(?,?,?,?)').run(runId,step.key,childId,step.role);
  }
  const children=db.prepare('SELECT step_key,child_task_id FROM coordination_steps WHERE run_id=?').all(runId) as {step_key:string;child_task_id:string}[];
  for(const step of plan.steps) for(const key of step.dependsOn) db.prepare('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)').run(children.find(c=>c.step_key===step.key)!.child_task_id,children.find(c=>c.step_key===key)!.child_task_id);
  db.prepare("UPDATE coordination_runs SET state='running',plan_json=? WHERE run_id=?").run(JSON.stringify(plan),runId);
  db.prepare("UPDATE workflow_runs SET status='WAITING',stage='分工执行' WHERE id=?").run(runId);
  db.prepare("UPDATE tasks SET status='ACTIVE',revision=revision+1 WHERE id=?").run(taskId);
  event(db,parent,runId,'coordination.planAccepted',{summary:plan.summary,steps:children});
}

function finalHandoff(db: ZhongshuoDatabase, taskId: string) {
  const row=db.prepare(`SELECT d.id,d.revision,d.manifest_hash,d.run_id,d.artifact_refs_json,d.change_set_refs_json,t.owner_member_id FROM tasks t JOIN task_deliveries d ON d.id=t.current_delivery_id WHERE t.id=?`).get(taskId) as {id:string;revision:number;manifest_hash:string;run_id:string;artifact_refs_json:string;change_set_refs_json:string;owner_member_id:string}|undefined;
  if(!row) return null;
  const final=db.prepare("SELECT body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY conversation_seq DESC LIMIT 1").get(taskId) as {body_json:string}|undefined;
  const root=(db.prepare('SELECT p.canonical_path FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=?').get(taskId) as {canonical_path:string}).canonical_path;
  const changes=db.prepare(`SELECT f.path,f.sha256,f.state FROM change_set_files f JOIN change_sets c ON c.id=f.change_set_id
    WHERE c.task_id=? AND c.id IN (SELECT value FROM json_each(?)) AND f.role='after'
    AND NOT EXISTS(SELECT 1 FROM change_set_files b WHERE b.change_set_id=f.change_set_id AND b.role='before' AND b.path=f.path AND b.state=f.state AND b.sha256 IS f.sha256)
    ORDER BY f.path LIMIT 101`).all(taskId,row.change_set_refs_json) as FrozenFile[];
  if(changes.length>100)throw Error('成果文件超过交接核验上限；保留原件，不能冒充完整评审');
  verifyHandoffFiles({files:changes},root);
  return {...row,files:changes,final:final ? JSON.parse(final.body_json) as unknown : null};
}

/** Bounded pump; serialized steps prevent concurrent full-access writers and stale read/write overlap. */
export function pumpCoordinations(db: ZhongshuoDatabase) {
  const page=(key:string,predicate:string,limit:number)=>{
    const cursor=Number((db.prepare('SELECT value FROM daemon_state WHERE key=?').get(key) as {value:string}|undefined)?.value??0);
    let rows=db.prepare(`SELECT c.rowid cursor_id,c.* FROM coordination_runs c WHERE ${predicate} AND c.rowid>? ORDER BY c.rowid LIMIT ?`).all(cursor,limit) as (CoordinationRun&{cursor_id:number})[];
    if(!rows.length)rows=db.prepare(`SELECT c.rowid cursor_id,c.* FROM coordination_runs c WHERE ${predicate} ORDER BY c.rowid LIMIT ?`).all(limit) as (CoordinationRun&{cursor_id:number})[];
    if(rows.length)db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,String(rows.at(-1)!.cursor_id),Date.now());
    return rows;
  };
  const runs=[...page('coordination:pump-active',"c.state IN ('running','integrating')",100),
    ...page('coordination:pump-stops',"c.state='cancelled' AND EXISTS(SELECT 1 FROM workflow_runs r WHERE r.id IN (c.run_id,c.integration_run_id) AND r.status IN ('RUNNING','WAITING','STOPPING'))",20)];
  for(const run of runs) { try { db.transaction(()=>{
    const parent=db.prepare('SELECT * FROM tasks WHERE id=?').get(run.task_id) as Parent;
    if(run.state==='cancelled'){settleStoppedCoordination(db,run.task_id,run.run_id);return;}
    if(parent.stop_generation!==run.stop_generation || parent.status==='CANCELLED') {
      db.prepare("UPDATE coordination_runs SET state='cancelled',error_message='用户已停止' WHERE run_id=?").run(run.run_id);
      return;
    }
    if(run.state!=='running') return;
    const steps=db.prepare(`SELECT s.*,t.status,t.current_delivery_id FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id WHERE s.run_id=? ORDER BY s.rowid`).all(run.run_id) as {step_key:string;child_task_id:string;status:string;handoff_json:string|null;current_delivery_id:string|null}[];
    for(const step of steps)if(step.status==='DONE'){
      const saved=JSON.parse(step.handoff_json??'{}') as {output?:unknown};
      if(!saved.output){step.handoff_json=JSON.stringify({...saved,output:finalHandoff(db,step.child_task_id)});db.prepare('UPDATE coordination_steps SET handoff_json=? WHERE run_id=? AND step_key=?').run(step.handoff_json,run.run_id,step.step_key);}
    }
    const blocked=steps.find(s=>['BLOCKED','CANCELLED','WAITING_USER'].includes(s.status) || db.prepare("SELECT 1 FROM workflow_runs WHERE task_id=? AND status IN ('FAILED','INTERRUPTED')").get(s.child_task_id) || db.prepare("SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND a.status='UNKNOWN'").get(s.child_task_id));
    if(blocked) {
      db.prepare(`UPDATE coordination_messages SET status='blocked',error_message='同伴步骤未完成或结果待核实；不会自动继续',updated_at=? WHERE coordination_run_id=? AND status IN ('accepted','queued') AND target_turn_id IS NULL`).run(Date.now(),run.run_id);
      db.prepare("UPDATE coordination_runs SET state='blocked',error_message=? WHERE run_id=?").run(`步骤「${blocked.step_key}」未完成或结果待核实；不会自动重试`,run.run_id);
      db.prepare("UPDATE workflow_runs SET status='FAILED' WHERE id=?").run(run.run_id);
      db.prepare("UPDATE tasks SET status='BLOCKED',revision=revision+1 WHERE id=?").run(parent.id);
      db.prepare("UPDATE thread_reply_requests SET status='blocked',error_message=?,updated_at=? WHERE run_id=? AND status IN ('queued','running')").run(`同伴步骤「${blocked.step_key}」未完成，请查看原因后决定下一步`,Date.now(),run.run_id);
      event(db,parent,run.run_id,'coordination.blocked',{stepKey:blocked.step_key});return;
    }
    // Any dispatched unfinished child remains the sole active step, including startup and unknown windows.
    if(steps.some(s=>s.handoff_json!=null && s.status!=='DONE')) return;
    const plan=JSON.parse(run.plan_json!) as CoordinationPlan;
    const next=plan.steps.find(p=>steps.find(s=>s.step_key===p.key)!.handoff_json==null && p.dependsOn.every(key=>steps.find(s=>s.step_key===key)!.status==='DONE'));
    if(next) {
      const step=steps.find(s=>s.step_key===next.key)!;
      const upstream=next.dependsOn.map(key=>(JSON.parse(steps.find(s=>s.step_key===key)!.handoff_json!) as {output:unknown}).output);
      if(upstream.some(h=>h==null)) throw Error('上游没有可交接的正式版本');
      db.prepare('UPDATE coordination_steps SET handoff_json=? WHERE run_id=? AND step_key=?').run(JSON.stringify({upstream}),run.run_id,next.key);
      enqueueOutbox(db,{dispatchKey:`task:${step.child_task_id}:initial`,stopGenerationAtEnqueue:0});
      db.prepare("UPDATE coordination_messages SET status='queued',updated_at=? WHERE child_task_id=? AND status='accepted'").run(Date.now(),step.child_task_id);
      event(db,parent,run.run_id,'coordination.stepQueued',{stepKey:next.key,childTaskId:step.child_task_id,upstream});return;
    }
    if(steps.every(s=>s.status==='DONE' && s.current_delivery_id)) {
      const root=(db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(parent.project_id) as {canonical_path:string}).canonical_path;
      verifyHandoffFiles({files:managedHandoffFiles(db,run.run_id)},root);
      db.prepare("UPDATE coordination_runs SET state='integrating' WHERE run_id=?").run(run.run_id);
      enqueueOutbox(db,{dispatchKey:`task:${parent.id}:redispatch:coord_${run.run_id}`,stopGenerationAtEnqueue:parent.stop_generation});
      db.prepare("UPDATE coordination_messages SET status='queued',updated_at=? WHERE coordination_run_id=? AND child_task_id IS NULL AND status='accepted'").run(Date.now(),run.run_id);
      event(db,parent,run.run_id,'coordination.integrationQueued',{steps:steps.map(s=>s.child_task_id)});
    }
  })(); } catch(error) {
    db.transaction(()=>{
      db.prepare(`UPDATE coordination_messages SET status='blocked',error_message=?,updated_at=? WHERE coordination_run_id=? AND status IN ('accepted','queued') AND target_turn_id IS NULL`).run(String(error).slice(0,1000),Date.now(),run.run_id);
      db.prepare("UPDATE coordination_runs SET state='blocked',error_message=? WHERE run_id=?").run(String(error).slice(0,1000),run.run_id);
      db.prepare("UPDATE workflow_runs SET status='FAILED' WHERE id=?").run(run.run_id);
      db.prepare("UPDATE tasks SET status='BLOCKED',revision=revision+1 WHERE id=?").run(run.task_id);
      const parent=db.prepare('SELECT * FROM tasks WHERE id=?').get(run.task_id) as Parent;
      event(db,parent,run.run_id,'coordination.blocked',{reason:String(error).slice(0,1000)});
    })();
  } }
}

export function coordinationPlanHash(plan: CoordinationPlan) { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }

export function coordinationDeliveryRefs(db:ZhongshuoDatabase,integrationRunId:string) {
  const run=db.prepare('SELECT run_id,plan_json FROM coordination_runs WHERE integration_run_id=?').get(integrationRunId) as {run_id:string;plan_json:string}|undefined;
  if(!run)return null;
  const rows=db.prepare(`SELECT d.id,d.manifest_hash,d.artifact_refs_json,d.change_set_refs_json,t.owner_member_id
    FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id JOIN task_deliveries d ON d.id=t.current_delivery_id WHERE s.run_id=? ORDER BY s.rowid`).all(run.run_id) as {id:string;manifest_hash:string;artifact_refs_json:string;change_set_refs_json:string;owner_member_id:string}[];
  return {planRunId:run.run_id,planHash:coordinationPlanHash(JSON.parse(run.plan_json) as CoordinationPlan),
    versions:rows.map(r=>({deliveryId:r.id,manifestHash:r.manifest_hash,memberId:r.owner_member_id})),
    artifactRefs:rows.flatMap(r=>JSON.parse(r.artifact_refs_json) as string[]),changeSetRefs:rows.flatMap(r=>JSON.parse(r.change_set_refs_json) as string[])};
}

export function readCoordination(db:ZhongshuoDatabase,taskId:string,selectedRunId:string|null):CoordinationDetails|null {
  if(!selectedRunId)return null;
  const run=db.prepare(`SELECT c.* FROM coordination_runs c JOIN tasks t ON t.id=c.task_id
    WHERE c.task_id=? AND (c.run_id=? OR c.run_id IN(SELECT coordination_run_id FROM coordination_integration_attempts WHERE execution_run_id=?))`).get(taskId,selectedRunId,selectedRunId) as (CoordinationRun&{error_message:string|null})|undefined;
  if(!run)return null;
  const plan=run.plan_json?JSON.parse(run.plan_json) as CoordinationPlan:null;
  const scope=coordinationRoster(db,taskId,run.run_id);
  const rows=db.prepare(`SELECT s.step_key,s.role,s.handoff_json,t.id,t.title,t.status,t.owner_member_id,m.display_name,
    d.id delivery_id,d.revision delivery_revision,d.manifest_hash FROM coordination_steps s
    JOIN tasks t ON t.id=s.child_task_id JOIN project_members m ON m.id=t.owner_member_id AND m.project_id=t.project_id
    JOIN tasks parent ON parent.id=t.parent_task_id AND parent.project_id=t.project_id AND parent.conversation_id=t.conversation_id
    LEFT JOIN task_deliveries d ON d.id=t.current_delivery_id WHERE s.run_id=? AND parent.id=? ORDER BY s.rowid LIMIT 8`).all(run.run_id,taskId) as {step_key:string;role:string;handoff_json:string|null;id:string;title:string;status:string;owner_member_id:string;display_name:string;delivery_id:string|null;delivery_revision:number|null;manifest_hash:string|null}[];
  const finalFiles=plan&&run.state==='completed'?new Map(managedHandoffFiles(db,run.run_id).map(f=>[f.path,f])):null;
  if(finalFiles&&run.integration_run_id){
    const after=db.prepare(`SELECT f.path,f.sha256,f.state FROM task_deliveries d JOIN change_sets c ON c.id IN(SELECT value FROM json_each(d.change_set_refs_json))
      JOIN change_set_files f ON f.change_set_id=c.id AND f.role='after' WHERE d.task_id=? AND d.run_id=? AND c.task_id=? ORDER BY f.rowid LIMIT 101`).all(taskId,run.integration_run_id,taskId) as FrozenFile[];
    if(after.length>100)finalFiles.clear();else for(const file of after)finalFiles.set(file.path,file);
  }
  return {runId:run.run_id,state:run.state,summary:plan?.summary??(run.state==='completed'?'本次由协调成员直接回答，未分工':'协调成员正在判断是否需要分工'),errorMessage:run.error_message,
    usedCalls:coordinationCallsUsed(db,run.run_id),maxCalls:coordinationCallLimit(db,run.run_id),steps:rows.map(r=>{
      const snapshot=scope.find(m=>m.memberId===r.owner_member_id)?.writeScope;
      const runtime=snapshot?(JSON.parse(snapshot) as {runtime?:{kind?:string;model?:string}}).runtime:null;
      const handoff=JSON.parse(r.handoff_json??'{}') as {upstream?:Array<{id:string;revision:number;manifest_hash:string}>};
      let reviewVersionCurrent:boolean|null=null;
      if(r.role==='review'&&plan&&finalFiles?.size){
        const expected=managedHandoffFiles(db,run.run_id,dependencyKeys(plan,r.step_key));
        if(expected.length&&expected.every(f=>finalFiles.has(f.path)&&finalFiles.get(f.path)!.state!=='unknown'))reviewVersionCurrent=expected.every(f=>{const current=finalFiles.get(f.path)!;return f.state===current.state&&f.sha256===current.sha256;});
      }
      return {key:r.step_key,taskId:r.id,title:r.title,status:r.status,role:r.role,memberId:r.owner_member_id,displayName:r.display_name,
        model:runtime?.model??null,channel:runtime?.kind??null,dependsOn:plan?.steps.find(s=>s.key===r.step_key)?.dependsOn??[],
        deliveryId:r.delivery_id,deliveryRevision:r.delivery_revision,manifestHash:r.manifest_hash,locate:`#task=${r.id}`,
        inputVersions:handoff.upstream?.map(input=>({deliveryId:input.id,revision:input.revision,manifestHash:input.manifest_hash}))??[],reviewVersionCurrent};})};
}

/** In the parent's stop transaction: generation fences protect queued and opening children. */
export function stopCoordinationChildren(db: ZhongshuoDatabase, parentTaskId: string) {
  db.prepare(`UPDATE coordination_messages SET status='cancelled',error_message='用户已停止；这条排队消息未执行',updated_at=?
    WHERE coordination_run_id IN(SELECT run_id FROM coordination_runs WHERE task_id=? AND state IN ('planning','running','integrating'))
    AND status IN ('accepted','queued') AND target_turn_id IS NULL`).run(Date.now(),parentTaskId);
  db.prepare(`UPDATE tasks SET stop_generation=stop_generation+1,revision=revision+1,
    status=CASE WHEN status IN ('DONE','CANCELLED') THEN status ELSE 'CANCELLED' END
    WHERE id IN (SELECT s.child_task_id FROM coordination_steps s JOIN coordination_runs c ON c.run_id=s.run_id
      WHERE c.task_id=? AND c.state IN ('planning','running','integrating'))`).run(parentTaskId);
  db.prepare(`UPDATE agent_turns SET status='STOPPING' WHERE status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT')
    AND run_id IN (SELECT r.id FROM workflow_runs r JOIN tasks t ON t.id=r.task_id WHERE t.parent_task_id=?)`).run(parentTaskId);
  db.prepare(`UPDATE workflow_runs SET status='STOPPING' WHERE status IN ('QUEUED','RUNNING','WAITING') AND task_id IN
    (SELECT child_task_id FROM coordination_steps s JOIN coordination_runs c ON c.run_id=s.run_id WHERE c.task_id=? AND c.state IN ('planning','running','integrating'))`).run(parentTaskId);
  db.prepare("UPDATE coordination_runs SET state='cancelled',error_message='用户已停止' WHERE task_id=? AND state IN ('planning','running','integrating')").run(parentTaskId);
}

export function settleStoppedCoordination(db:ZhongshuoDatabase,taskId:string,targetRunId:string) {
  const run=db.prepare("SELECT * FROM coordination_runs WHERE task_id=? AND state='cancelled' AND (run_id=? OR integration_run_id=?)").get(taskId,targetRunId,targetRunId) as CoordinationRun|undefined;
  if(!run)return;
  const active=db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
    WHERE (r.id=? OR r.id=? OR t.parent_task_id=?) AND (a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')
      OR a.status='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='recovery.protectionReleased' AND json_extract(e.payload_json,'$.released')=1)) LIMIT 1`).get(run.run_id,run.integration_run_id,taskId);
  if(active)return;
  db.prepare("UPDATE workflow_runs SET status='CANCELLED' WHERE id IN (?,?) AND status IN ('RUNNING','WAITING','STOPPING')").run(run.run_id,run.integration_run_id);
  const latest=db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as {id:string}|undefined;
  if(latest&&(latest.id===run.run_id||latest.id===run.integration_run_id))db.prepare("UPDATE tasks SET status='CANCELLED',revision=revision+1 WHERE id=? AND status!='CANCELLED'").run(taskId);
}
