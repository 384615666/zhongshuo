import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { enqueueOutbox } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { coordinationCallAvailable, validateCoordinationPlan, type CoordinationPlan, type CoordinationDetails } from '../contracts/coordination.ts';
import { snapshotConversationWriteAccess } from './projectWriteAccess.ts';

type ScopeMember = { memberId: string; displayName: string; description: string | null; writeScope: string | null; unavailableReason?: string };
type Parent = { id: string; project_id: string; conversation_id: string; room_id: string; conversation_thread_id: string; root_message_id: string; owner_member_id: string; title: string; stop_generation: number; status: string };
export type CoordinationRun = { run_id: string; task_id: string; stop_generation: number; state: string; plan_json: string | null; integration_run_id: string | null };

function event(db: ZhongshuoDatabase, task: Parent, runId: string, kind: string, payload: Record<string, unknown>) {
  appendDomainEvent(db, { schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: task.project_id,
    conversationId: task.conversation_id, threadId: task.conversation_thread_id, taskId: task.id,
    runId, kind, payload, createdAt: Date.now() });
}

/** Called in the original send transaction; never lets the model grant itself new members. */
export function freezeCoordinationScope(db: ZhongshuoDatabase, taskId: string | null) {
  if (!taskId) return;
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as Parent & { route_json: string | null };
  if (!task?.route_json || JSON.parse(task.route_json).mode !== 'AUTO') return;
  if (db.prepare('SELECT 1 FROM coordination_scopes WHERE task_id=?').get(taskId)) return;
  const members = db.prepare(`SELECT pm.id,pm.display_name,pm.description FROM room_members rm
    JOIN project_members pm ON pm.id=rm.member_id WHERE rm.room_id=? AND pm.project_id=? AND pm.enabled=1 AND pm.principal_type='agent' ORDER BY pm.id LIMIT 13`)
    .all(task.room_id, task.project_id) as {id:string;display_name:string;description:string|null}[];
  if (members.length > 12) throw Error('自动协作最多选择 12 位房间成员；请先调整房间名单');
  if(!members.some(m=>m.id===task.owner_member_id))throw Error('协调者必须是本房间启用的 AI 成员');
  const roster: ScopeMember[] = members.map(m => {
    try { return { memberId:m.id, displayName:m.display_name, description:m.description,
      writeScope:snapshotConversationWriteAccess(db,taskId,process.env.ZS_RUNTIME??null,m.id) }; }
    catch (error) { return { memberId:m.id,displayName:m.display_name,description:m.description,writeScope:null,unavailableReason:String(error) }; }
  });
  db.prepare('INSERT INTO coordination_scopes(task_id,roster_json,created_at) VALUES(?,?,?)').run(taskId,JSON.stringify(roster),Date.now());
}

export function coordinationRoster(db: ZhongshuoDatabase, taskId: string): ScopeMember[] {
  const row=db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(taskId) as {roster_json:string}|undefined;
  return row ? JSON.parse(row.roster_json) as ScopeMember[] : [];
}

export function childCoordination(db: ZhongshuoDatabase, taskId: string) {
  return db.prepare(`SELECT c.*,s.role,s.step_key,s.handoff_json FROM coordination_steps s JOIN coordination_runs c ON c.run_id=s.run_id WHERE s.child_task_id=?`)
    .get(taskId) as (CoordinationRun & {role:string;step_key:string;handoff_json:string|null})|undefined;
}

export function coordinationDispatchContext(db: ZhongshuoDatabase, taskId: string, dispatchKey: string) {
  const child = childCoordination(db,taskId);
  if (child) return { kind:'child' as const, run:child, readonly:child.role!=='implementation',
    note:`你正在执行协调分工步骤 ${child.step_key}，角色 ${child.role}。只完成本步骤，不自行派发成员。分析和评审只读；结论作为正式工作交付提交 responseKind=work。\n冻结的上游交接：${child.handoff_json??'无前置步骤'}` };
  const integration=db.prepare("SELECT * FROM coordination_runs WHERE task_id=? AND state='integrating'").get(taskId) as CoordinationRun|undefined;
  if(integration && dispatchKey===`task:${taskId}:redispatch:coord_${integration.run_id}`) {
    const steps=db.prepare(`SELECT s.step_key,s.role,s.handoff_json,t.id,t.title,t.current_delivery_id FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id WHERE s.run_id=? ORDER BY s.rowid`).all(integration.run_id);
    return {kind:'integration' as const,run:integration,readonly:false,note:`整合已完成的真实成员工作。不得声称自己代替其他成员执行；核对成果与评审，按用户请求补齐必要整合并交付。不得再次生成计划。\n本轮计划：${integration.plan_json}\n步骤与版本交接：${JSON.stringify(steps)}`};
  }
  const task=db.prepare('SELECT route_json FROM tasks WHERE id=?').get(taskId) as {route_json:string|null};
  if(task.route_json && JSON.parse(task.route_json).mode==='AUTO' && !dispatchKey.includes(':conversation:')) {
    return {kind:'planning' as const,run:null,readonly:true,note:`你是协调成员。本轮只读规划，不修改文件。简单问候、普通提问直接自然回答，responseKind=conversation，coordinationPlan=null。需要多成员合作的工作提交 coordinationPlan（summary 与 steps，最多8步；每步 key/memberId/title/objective/role/dependsOn）。role 为 analysis/implementation/review；分析评审程序强制只读；实施按成员现有权限执行、共享目录单写。按需安排不同成员，评审须依赖实施并读取实际文件。依赖只能引用本计划key且无环。只有程序接受计划才算已派发。最终整合由你完成。可用成员及配置范围：${JSON.stringify(coordinationRoster(db,taskId).map(m=>({memberId:m.memberId,displayName:m.displayName,description:m.description,available:m.writeScope!=null,reason:m.unavailableReason})))}`};
  }
  return null;
}

/** Conservative aggregate accounting includes failed startup and UNKNOWN reservations. */
export function coordinationCallsUsed(db: ZhongshuoDatabase, runId: string): number {
  return (db.prepare(`SELECT count(*) n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
    WHERE a.run_id=? OR a.run_id=(SELECT integration_run_id FROM coordination_runs WHERE run_id=?)
      OR r.task_id IN (SELECT child_task_id FROM coordination_steps WHERE run_id=?)`).get(runId,runId,runId) as {n:number}).n;
}

function coordinationCallLimit(db: ZhongshuoDatabase,runId:string) {
  const row=db.prepare('SELECT budget_json FROM workflow_runs WHERE id=?').get(runId) as {budget_json:string|null};
  const budget=row.budget_json?JSON.parse(row.budget_json) as {maxTurns?:number}:{};
  return Math.min(24,budget.maxTurns??24);
}

export function validatePlanForRun(db:ZhongshuoDatabase,taskId:string,runId:string,value:unknown) {
  const plan=validateCoordinationPlan(value,coordinationRoster(db,taskId).filter(m=>m.writeScope).map(m=>m.memberId));
  if(coordinationCallsUsed(db,runId)+plan.steps.length+2>coordinationCallLimit(db,runId))throw Error('分工步骤超出本轮总预算与整合预留；请缩减步骤');
  return plan;
}

export function assertCoordinationDispatch(db: ZhongshuoDatabase, taskId: string, dispatchKey: string, reservedTurnId?: string) {
  const context=coordinationDispatchContext(db,taskId,dispatchKey);
  if (!context?.run) return;
  const parent=db.prepare('SELECT stop_generation,status FROM tasks WHERE id=?').get(context.run.task_id) as {stop_generation:number;status:string};
  if(parent.stop_generation!==context.run.stop_generation || parent.status==='CANCELLED' || !['running','integrating'].includes(context.run.state)) throw Error('父协作已停止或本轮分工已失效；未派发');
  const handoffs=context.kind==='child'?[context.run.handoff_json]:db.prepare('SELECT handoff_json FROM coordination_steps WHERE run_id=? LIMIT 8').all(context.run.run_id).map(r=>(r as {handoff_json:string|null}).handoff_json);
  const root=(db.prepare('SELECT p.canonical_path FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=?').get(taskId) as {canonical_path:string}).canonical_path;
  for(const raw of handoffs)if(raw)verifyHandoffFiles(JSON.parse(raw) as unknown,root);
  const ownReservation=reservedTurnId&&db.prepare('SELECT 1 FROM agent_turns WHERE id=?').get(reservedTurnId)?1:0;
  const used=coordinationCallsUsed(db,context.run.run_id)-ownReservation;
  const reserve=context.kind==='integration'?0:2;
  if(!coordinationCallAvailable(used,context.kind==='integration'?'integration':'work') || used>=coordinationCallLimit(db,context.run.run_id)-reserve) throw Error('本轮协作总调用预算已用尽；保留成果，未继续派发');
}

function verifyHandoffFiles(value:unknown,root:string,depth=0):void {
  if(depth>12)throw Error('交接记录超出有界嵌套范围');
  if(!value || typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value)verifyHandoffFiles(item,root,depth+1);return;}
  const row=value as Record<string,unknown>;
  if(Array.isArray(row.files))for(const raw of row.files){
    if(!raw||typeof raw!=='object')continue;
    const file=raw as {path?:string;sha256?:string;state?:string};if(!file.path||!file.sha256)continue;
    const path=resolve(root,file.path),rel=relative(root,path);
    if(rel==='..'||rel.startsWith('../')||rel.startsWith('..\\')||isAbsolute(rel))throw Error('交接文件越出项目');
    const stat=statSync(path);if(!stat.isFile()||stat.size>32*1024*1024||createHash('sha256').update(readFileSync(path)).digest('hex')!==file.sha256)throw Error('交接版本的文件字节已变化；未继续派发');
  }
  for(const key of ['upstream','output'])if(row[key])verifyHandoffFiles(row[key],root,depth+1);
}

export function beginCoordination(db: ZhongshuoDatabase, taskId: string, runId: string, kind: 'planning'|'integration') {
  if(kind==='integration') {
    db.prepare("UPDATE coordination_runs SET integration_run_id=? WHERE task_id=? AND state='integrating'").run(runId,taskId);
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
  if(parent.stop_generation!==existing.stop_generation || parent.status==='CANCELLED') throw Error('规划期间用户已停止');
  const roster=coordinationRoster(db,taskId);
  const plan=validatePlanForRun(db,taskId,runId,value);
  for(const step of plan.steps) {
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
    WHERE c.task_id=? AND c.id IN (SELECT value FROM json_each(?)) AND f.role='after' ORDER BY f.path LIMIT 101`).all(taskId,row.change_set_refs_json) as {path:string;sha256:string|null;state:string}[];
  if(changes.length>100)throw Error('成果文件超过交接核验上限；保留原件，不能冒充完整评审');
  const files=changes.map(file=>{
    const path=resolve(root,file.path),rel=relative(root,path);
    if(rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))throw Error('交接文件路径越出当前项目');
    if(file.state==='absent')return {...file};
    if(!file.sha256)return {...file,verification:'未提供文件hash'};
    const stat=statSync(path);if(!stat.isFile()||stat.size>32*1024*1024)throw Error('交接文件不可读取或超出32MiB核验上限');
    if(createHash('sha256').update(readFileSync(path)).digest('hex')!==file.sha256)throw Error('上游交付文件已变化；不能将旧评审绑定新文件');
    return {...file,verification:'当前字节与交付一致'};
  });
  return {...row,files,final:final ? JSON.parse(final.body_json) as unknown : null};
}

/** Bounded pump; serialized steps prevent concurrent full-access writers and stale read/write overlap. */
export function pumpCoordinations(db: ZhongshuoDatabase) {
  const runs=db.prepare("SELECT * FROM coordination_runs WHERE state IN ('running','integrating','cancelled') ORDER BY created_at LIMIT 100").all() as CoordinationRun[];
  for(const run of runs) { try { db.transaction(()=>{
    const parent=db.prepare('SELECT * FROM tasks WHERE id=?').get(run.task_id) as Parent;
    if(run.state==='cancelled'){
      const active=db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
        WHERE (r.id=? OR r.id=? OR t.parent_task_id=?) AND a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING','UNKNOWN') LIMIT 1`).get(run.run_id,run.integration_run_id,run.task_id);
      if(!active){db.prepare("UPDATE workflow_runs SET status='CANCELLED' WHERE id IN (?,?) AND status IN ('RUNNING','WAITING','STOPPING')").run(run.run_id,run.integration_run_id);if(parent.status!=='CANCELLED')db.prepare("UPDATE tasks SET status='CANCELLED',revision=revision+1 WHERE id=?").run(parent.id);}
      return;
    }
    if(parent.stop_generation!==run.stop_generation || parent.status==='CANCELLED') {
      db.prepare("UPDATE coordination_runs SET state='cancelled',error_message='用户已停止' WHERE run_id=?").run(run.run_id);
      return;
    }
    if(run.state!=='running') return;
    const steps=db.prepare(`SELECT s.*,t.status,t.current_delivery_id FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id WHERE s.run_id=? ORDER BY s.rowid`).all(run.run_id) as {step_key:string;child_task_id:string;status:string;handoff_json:string|null;current_delivery_id:string|null}[];
    const blocked=steps.find(s=>['BLOCKED','CANCELLED','WAITING_USER'].includes(s.status) || db.prepare("SELECT 1 FROM workflow_runs WHERE task_id=? AND status IN ('FAILED','INTERRUPTED')").get(s.child_task_id) || db.prepare("SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND a.status='UNKNOWN'").get(s.child_task_id));
    if(blocked) {
      db.prepare("UPDATE coordination_runs SET state='blocked',error_message=? WHERE run_id=?").run(`步骤「${blocked.step_key}」未完成或结果待核实；不会自动重试`,run.run_id);
      db.prepare("UPDATE workflow_runs SET status='FAILED' WHERE id=?").run(run.run_id);
      db.prepare("UPDATE tasks SET status='BLOCKED',revision=revision+1 WHERE id=?").run(parent.id);
      event(db,parent,run.run_id,'coordination.blocked',{stepKey:blocked.step_key});return;
    }
    // Any dispatched unfinished child remains the sole active step, including startup and unknown windows.
    if(steps.some(s=>s.handoff_json!=null && s.status!=='DONE')) return;
    const plan=JSON.parse(run.plan_json!) as CoordinationPlan;
    const next=plan.steps.find(p=>steps.find(s=>s.step_key===p.key)!.handoff_json==null && p.dependsOn.every(key=>steps.find(s=>s.step_key===key)!.status==='DONE'));
    if(next) {
      const step=steps.find(s=>s.step_key===next.key)!;
      const upstream=next.dependsOn.map(key=>finalHandoff(db,steps.find(s=>s.step_key===key)!.child_task_id));
      if(upstream.some(h=>h==null)) throw Error('上游没有可交接的正式版本');
      db.prepare('UPDATE coordination_steps SET handoff_json=? WHERE run_id=? AND step_key=?').run(JSON.stringify({upstream}),run.run_id,next.key);
      enqueueOutbox(db,{dispatchKey:`task:${step.child_task_id}:initial`,stopGenerationAtEnqueue:0});
      event(db,parent,run.run_id,'coordination.stepQueued',{stepKey:next.key,childTaskId:step.child_task_id,upstream});return;
    }
    if(steps.every(s=>s.status==='DONE' && s.current_delivery_id)) {
      for(const s of steps) db.prepare('UPDATE coordination_steps SET handoff_json=? WHERE run_id=? AND step_key=?').run(JSON.stringify({upstream:JSON.parse(s.handoff_json??'{}') as unknown,output:finalHandoff(db,s.child_task_id)}),run.run_id,s.step_key);
      db.prepare("UPDATE coordination_runs SET state='integrating' WHERE run_id=?").run(run.run_id);
      enqueueOutbox(db,{dispatchKey:`task:${parent.id}:redispatch:coord_${run.run_id}`,stopGenerationAtEnqueue:parent.stop_generation});
      event(db,parent,run.run_id,'coordination.integrationQueued',{steps:steps.map(s=>s.child_task_id)});
    }
  })(); } catch(error) {
    db.transaction(()=>{
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
    WHERE c.task_id=? AND (c.run_id=? OR c.integration_run_id=?)`).get(taskId,selectedRunId,selectedRunId) as (CoordinationRun&{error_message:string|null})|undefined;
  if(!run)return null;
  const plan=run.plan_json?JSON.parse(run.plan_json) as CoordinationPlan:null;
  const scope=coordinationRoster(db,taskId);
  const rows=db.prepare(`SELECT s.step_key,s.role,t.id,t.title,t.status,t.owner_member_id,m.display_name,
    d.id delivery_id,d.revision delivery_revision,d.manifest_hash FROM coordination_steps s
    JOIN tasks t ON t.id=s.child_task_id JOIN project_members m ON m.id=t.owner_member_id AND m.project_id=t.project_id
    JOIN tasks parent ON parent.id=t.parent_task_id AND parent.project_id=t.project_id AND parent.conversation_id=t.conversation_id
    LEFT JOIN task_deliveries d ON d.id=t.current_delivery_id WHERE s.run_id=? AND parent.id=? ORDER BY s.rowid LIMIT 8`).all(run.run_id,taskId) as {step_key:string;role:string;id:string;title:string;status:string;owner_member_id:string;display_name:string;delivery_id:string|null;delivery_revision:number|null;manifest_hash:string|null}[];
  return {runId:run.run_id,state:run.state,summary:plan?.summary??(run.state==='completed'?'本次由协调成员直接回答，未分工':'协调成员正在判断是否需要分工'),errorMessage:run.error_message,
    usedCalls:coordinationCallsUsed(db,run.run_id),maxCalls:coordinationCallLimit(db,run.run_id),steps:rows.map(r=>{
      const snapshot=scope.find(m=>m.memberId===r.owner_member_id)?.writeScope;
      const runtime=snapshot?(JSON.parse(snapshot) as {runtime?:{kind?:string;model?:string}}).runtime:null;
      return {key:r.step_key,taskId:r.id,title:r.title,status:r.status,role:r.role,memberId:r.owner_member_id,displayName:r.display_name,
        model:runtime?.model??null,channel:runtime?.kind??null,dependsOn:plan?.steps.find(s=>s.key===r.step_key)?.dependsOn??[],
        deliveryId:r.delivery_id,deliveryRevision:r.delivery_revision,manifestHash:r.manifest_hash,locate:`#task=${r.id}`};})};
}

/** In the parent's stop transaction: generation fences protect queued and opening children. */
export function stopCoordinationChildren(db: ZhongshuoDatabase, parentTaskId: string) {
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
