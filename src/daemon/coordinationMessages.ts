import {createHash} from 'node:crypto';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import type {TurnBundleEnvelope} from '../contracts/prompts.ts';
import {validateCoordinationPlan,type CoordinationPlan,type MemberHandoff} from '../contracts/coordination.ts';
import {acceptCoordinationPlan,childCoordination,coordinationRoster,coordinationCallLimit,coordinationCallsUsed,coordinationCallEnforcement,isBroadcastRun} from './coordination.ts';
import {effectiveTaskWriteAccess} from './projectWriteAccess.ts';
import {appendDomainEvent} from '../persistence/events.ts';

type Phase='planning'|'child'|'integration';
type Parent={id:string;project_id:string;conversation_id:string;conversation_thread_id:string;room_id:string;root_message_id:string;owner_member_id:string;source_connection_id:string|null};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');

function sourceContext(db:ZhongshuoDatabase,taskId:string,runId:string){
  const child=childCoordination(db,taskId);
  const root=child??db.prepare('SELECT run_id,task_id,state FROM coordination_runs WHERE run_id=? OR integration_run_id=?').get(runId,runId) as {run_id:string;task_id:string;state:string}|undefined;
  if(!root)return null;
  const phase:Phase=child?'child':root.run_id===runId?'planning':'integration';
  const parent=db.prepare('SELECT * FROM tasks WHERE id=?').get(root.task_id) as Parent;
  const request=db.prepare('SELECT member_id,message_id FROM thread_reply_requests WHERE task_id=? AND run_id=?').get(root.task_id,root.run_id) as {member_id:string;message_id:string}|undefined;
  if(request){parent.owner_member_id=request.member_id;parent.root_message_id=request.message_id;}
  return{rootRunId:root.run_id,parent,phase,child,roster:coordinationRoster(db,root.task_id,root.run_id)};
}

function targetAvailable(db:ZhongshuoDatabase,parent:Parent,memberId:string){
  return Boolean(db.prepare(`SELECT 1 FROM project_members pm JOIN room_members rm ON rm.member_id=pm.id AND rm.room_id=?
    WHERE pm.id=? AND pm.project_id=? AND pm.principal_type='agent' AND pm.enabled=1
    AND NOT EXISTS(SELECT 1 FROM thread_agent_followers f WHERE f.thread_id=? AND f.member_id=pm.id AND f.status!='following')`)
    .get(parent.room_id,memberId,parent.project_id,parent.conversation_thread_id));
}

/** A discoverable, actual result-message channel; no imaginary zs/MCP tool. */
export function communicationForTurn(db:ZhongshuoDatabase,taskId:string,memberId:string,phase?:Phase,rootRunId?:string,dispatchKey?:string):TurnBundleEnvelope['communicationContract'] {
  if(!phase||phase==='integration')return{mentionEnabled:false,disabledReason:phase==='integration'?'本轮汇总已收到的结果，不再追加交接':'本条只请求你回应；没有开放额外成员交接'};
  const child=phase==='child'?childCoordination(db,taskId):undefined;
  if(child&&isBroadcastRun(db,child.run_id))return{mentionEnabled:false,disabledReason:'本条已分别发送给全体成员，各自回应，不追加互评或汇总'};
  const parentId=child?.task_id??taskId;
  const parent=db.prepare('SELECT * FROM tasks WHERE id=?').get(parentId) as Parent;
  const request=dispatchKey?db.prepare('SELECT member_id,roster_json FROM thread_reply_requests WHERE dispatch_key=?').get(dispatchKey) as {member_id:string;roster_json:string}|undefined:undefined;
  const runRequest=rootRunId?db.prepare('SELECT member_id FROM thread_reply_requests WHERE run_id=?').get(rootRunId) as {member_id:string}|undefined:undefined;
  const scope=request?JSON.parse(request.roster_json) as ReturnType<typeof coordinationRoster>:coordinationRoster(db,parentId,rootRunId);
  const reply=db.prepare('SELECT source_member_id FROM coordination_messages WHERE child_task_id=?').get(taskId) as {source_member_id:string}|undefined;
  const ownerReply=scope.some(m=>m.memberId===parent.owner_member_id&&m.writeScope&&targetAvailable(db,parent,parent.owner_member_id))?parent.owner_member_id:null;
  const replyCandidate=phase==='child'?(reply?.source_member_id??runRequest?.member_id??ownerReply):null;
  const replyTo=replyCandidate&&replyCandidate!==memberId&&scope.some(m=>m.memberId===replyCandidate&&m.writeScope&&targetAvailable(db,parent,replyCandidate))?replyCandidate:null;
  return{mentionEnabled:true,submitVia:'final-result',
    members:scope.filter(m=>m.writeScope&&targetAvailable(db,parent,m.memberId)).map(m=>({memberId:m.memberId,displayName:m.displayName,description:m.description??null})),
    allowedPurposes:phase==='planning'?['ask','review','implement']:replyTo?['ask','review','implement','reply']:['ask','review','implement'],
    replyToMemberId:replyTo};
}

function proposedSteps(sourceTurnId:string,messages:readonly MemberHandoff[],sourceMemberId:string,dependsOn:string[]){
  return messages.map((message,index)=>({key:`msg_${hash(sourceTurnId).slice(0,18)}_${index}`,memberId:message.toMemberId,
    title:message.message.slice(0,120),objective:`来自成员 ${sourceMemberId} 的具体消息：\n${message.message}`,
    role:message.purpose==='implement'?'implementation' as const:message.purpose==='review'?'review' as const:'analysis' as const,
    dependsOn:[...dependsOn]}));
}

/** Pure validation against authentic turn, frozen roster, current availability,
 * role, aggregate budget and bounded dependency graph. No dispatch here. */
export function validateMemberHandoffs(db:ZhongshuoDatabase,taskId:string,runId:string,turnId:string,messages:readonly MemberHandoff[],hasPlan=false){
  if(!messages.length)return null;
  if(hasPlan)throw Error('同一结果不能同时提出分工计划和消息交接');
  const context=sourceContext(db,taskId,runId);
  if(context&&isBroadcastRun(db,context.rootRunId))throw Error('本条全体收件人已分别接单，不追加成员交接');
  if(!context||context.phase==='integration')throw Error('本轮没有开放追加成员消息');
  const source=db.prepare(`SELECT a.member_id,a.status,a.stop_generation_snapshot,t.stop_generation
    FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
    WHERE a.id=? AND a.run_id=? AND t.id=?`).get(turnId,runId,taskId) as {member_id:string;status:string;stop_generation_snapshot:number;stop_generation:number}|undefined;
  if(!source)throw Error('发件执行身份不存在');
  const live=db.prepare(`SELECT c.state,c.stop_generation,t.stop_generation current_generation,t.status
    FROM coordination_runs c JOIN tasks t ON t.id=c.task_id WHERE c.run_id=?`).get(context.rootRunId) as {state:string;stop_generation:number;current_generation:number;status:string};
  if(!['planning','running'].includes(live.state)||live.status==='CANCELLED'||live.stop_generation!==live.current_generation
    ||!['RUNNING','SUCCEEDED'].includes(source.status)||source.stop_generation_snapshot!==source.stop_generation)
    throw Error('交接来源已停止、代次变化或结果待核实；未追加消息');
  const explicitRun=db.prepare('SELECT 1 FROM coordination_run_rosters WHERE run_id=?').get(context.rootRunId)!=null;
  const plannedTargets=new Set<string>();
  if(context.phase==='child'&&context.child&&!explicitRun){
    const planned=db.prepare('SELECT plan_json FROM coordination_runs WHERE run_id=?').get(context.rootRunId) as {plan_json:string}|undefined;
    if(planned){
      const plan=JSON.parse(planned.plan_json) as CoordinationPlan;
      for(const step of plan.steps)if(step.dependsOn.includes(context.child.step_key))plannedTargets.add(step.memberId);
    }
  }
  const effectiveMessages=messages.filter(message=>!plannedTargets.has(message.toMemberId));
  const ignored=(list:readonly MemberHandoff[])=>list.map(message=>({toMemberId:message.toMemberId,purpose:message.purpose,bodyHash:hash(message.message)}));
  const ignoredMessages=ignored(messages.filter(message=>plannedTargets.has(message.toMemberId)));
  if(effectiveMessages.length===0)return{...context,sourceMemberId:source.member_id,effectiveMessages,ignoredMessages,deferred:[],merged:[],additions:[],plan:null};
  const seen=new Set<string>();
  const inboundReplySource=(db.prepare('SELECT source_member_id FROM coordination_messages WHERE child_task_id=?').get(taskId) as {source_member_id:string}|undefined)?.source_member_id;
  const coordinatorReply=context.roster.some(m=>m.memberId===context.parent.owner_member_id&&m.writeScope)?context.parent.owner_member_id:null;
  const allowedReplyTargets=new Set([inboundReplySource,coordinatorReply].filter((memberId):memberId is string=>Boolean(memberId)));
  for(const message of effectiveMessages){
    const member=context.roster.find(m=>m.memberId===message.toMemberId);
    if(!member?.writeScope||!targetAvailable(db,context.parent,message.toMemberId))throw Error('收件人不在本轮获准可用名单中');
    if(message.toMemberId===source.member_id&&message.purpose!=='implement')throw Error('不向自己发送重复提问或回声');
    if(message.purpose==='reply'&&!allowedReplyTargets.has(message.toMemberId))throw Error('回复只能发给实际来源成员或本轮协调者');
    if(message.purpose==='reply'&&context.phase!=='child')throw Error('当前没有需要回复的来源成员');
    const fingerprint=message.toMemberId+':'+message.purpose+':'+hash(message.message);
    if(seen.has(fingerprint)||db.prepare('SELECT 1 FROM coordination_messages WHERE coordination_run_id=? AND source_member_id=? AND target_member_id=? AND purpose=? AND body_hash=?').get(context.rootRunId,source.member_id,message.toMemberId,message.purpose,hash(message.message)))throw Error('同一轮重复交接相同消息，不会再次唤醒');
    seen.add(fingerprint);
    const access=effectiveTaskWriteAccess(db,context.parent.id,member.memberId,process.env.ZS_RUNTIME??null,member.writeScope);
    if(message.purpose==='implement'&&!access.modificationAuthorized)throw Error('不能把实施工作交给未获写权限的成员');
  }
  const deferred=effectiveMessages.map(m=>context.phase==='child'&&m.purpose==='reply'&&m.toMemberId===context.parent.owner_member_id);
  const explicit=context.child&&explicitRun;
  const merged=effectiveMessages.map((message,index)=>{
    if(!explicit||deferred[index]||!['ask','review'].includes(message.purpose))return null;
    const candidate=db.prepare(`SELECT s.step_key stepKey,t.id childTaskId FROM coordination_steps s
      JOIN tasks t ON t.id=s.child_task_id JOIN outbox o ON o.dispatch_key='task:'||t.id||':initial'
      WHERE s.run_id=? AND t.owner_member_id=? AND t.parent_task_id=? AND t.status='OPEN'
        AND t.stop_generation=? AND o.stop_generation_at_enqueue=t.stop_generation AND o.status='pending' AND o.turn_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.task_id=t.id)
      ORDER BY s.rowid LIMIT 1`).get(context.rootRunId,message.toMemberId,context.parent.id,live.current_generation) as {stepKey:string;childTaskId:string}|undefined;
    return candidate&&/^r\d+$/.test(candidate.stepKey)?candidate:null;
  });
  const additions=proposedSteps(turnId,effectiveMessages,source.member_id,context.child?[context.child.step_key]:[]).filter((_,index)=>!deferred[index]&&!merged[index]);
  for(let i=1;i<additions.length;i++)additions[i]!.dependsOn=[additions[i-1]!.key];
  const current=context.phase==='child'?JSON.parse((db.prepare('SELECT plan_json FROM coordination_runs WHERE run_id=?').get(context.rootRunId) as {plan_json:string}).plan_json) as CoordinationPlan:null;
  const mergedKeys=new Set(merged.filter(item=>item!=null).map(item=>item.stepKey));
  const plan:CoordinationPlan={summary:current?.summary??'成员消息交接',steps:[...(current?.steps??[]).map(step=>mergedKeys.has(step.key)
    ?{...step,dependsOn:[...new Set([...step.dependsOn,context.child!.step_key])]}:step),...additions]};
  if(plan.steps.length)validateCoordinationPlan(plan,context.roster.filter(m=>m.writeScope).map(m=>m.memberId),{accumulated:context.phase==='child'});
  const unstarted=(db.prepare(`SELECT count(*) n FROM coordination_steps s WHERE s.run_id=? AND NOT EXISTS(SELECT 1 FROM workflow_runs r JOIN agent_turns a ON a.run_id=r.id WHERE r.task_id=s.child_task_id)`).get(context.rootRunId) as {n:number}).n;
  if(coordinationCallEnforcement(db,context.rootRunId)!=='disabled'
    &&coordinationCallsUsed(db,context.rootRunId)+unstarted+additions.length+2>coordinationCallLimit(db,context.rootRunId))
    throw Error('消息交接超出本轮剩余额度及汇总预留');
  return{...context,sourceMemberId:source.member_id,effectiveMessages,ignoredMessages,deferred,merged,additions,plan};
}

/** Transactional acceptance. The actual receiver is a formal worker task;
 * replying to the coordinator shares its one final integration wakeup. */
export function acceptMemberHandoffs(db:ZhongshuoDatabase,taskId:string,runId:string,turnId:string,messages:readonly MemberHandoff[]){
  const validated=validateMemberHandoffs(db,taskId,runId,turnId,messages);
  if(!validated)return[];
  const {parent,rootRunId,sourceMemberId,phase,plan,additions,deferred,merged,effectiveMessages,ignoredMessages}=validated;
  if(ignoredMessages.length>0)appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${hash(`ignored:${turnId}:${JSON.stringify(ignoredMessages)}`)}`,projectId:parent.project_id,conversationId:parent.conversation_id,threadId:parent.conversation_thread_id,taskId:parent.id,runId:rootRunId,turnId,
    kind:'member.messageIgnoredRedundantPlan',createdAt:Date.now(),payload:{sourceMemberId,messages:ignoredMessages,note:'计划已包含同一接收成员的下游步骤；程序自动传递本步骤结果，不再追加重复任务'}});
  if(effectiveMessages.length===0)return[];
  if(phase==='planning')acceptCoordinationPlan(db,parent.id,rootRunId,plan);
  else {
    for(const target of merged){
      if(!target)continue;
      db.prepare('UPDATE coordination_steps SET handoff_json=NULL WHERE run_id=? AND step_key=?').run(rootRunId,target.stepKey);
      db.prepare('INSERT OR IGNORE INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)').run(target.childTaskId,taskId);
    }
    for(const step of additions){
      const member=validated.roster.find(m=>m.memberId===step.memberId)!;
      const childId=`task_${hash(turnId+':'+step.key).slice(0,32)}`;
      const route={kind:'dispatch',mode:'DIRECT',targetMemberId:step.memberId,frozenMemberIds:[step.memberId],initialWakeMemberIds:[step.memberId]};
      db.prepare(`INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,owner_member_id,parent_task_id,title,objective,status,review_policy,route_json,write_scope_json)
        VALUES(?,?,?,'room_task',?,?,?,?,?,?,?,'OPEN','auto_deliver',?,?)`).run(childId,parent.project_id,parent.conversation_id,parent.room_id,parent.conversation_thread_id,parent.root_message_id,step.memberId,parent.id,step.title,step.objective,JSON.stringify(route),member.writeScope);
      db.prepare('UPDATE tasks SET write_scope_json=?,source_connection_id=? WHERE id=?').run(member.writeScope,parent.source_connection_id,childId);
      db.prepare('INSERT INTO coordination_steps(run_id,step_key,child_task_id,role) VALUES(?,?,?,?)').run(rootRunId,step.key,childId,step.role);
      for(const key of step.dependsOn){const previous=db.prepare('SELECT child_task_id FROM coordination_steps WHERE run_id=? AND step_key=?').get(rootRunId,key) as {child_task_id:string};db.prepare('INSERT INTO task_dependencies(task_id,depends_on_task_id) VALUES(?,?)').run(childId,previous.child_task_id);}
    }
    db.prepare('UPDATE coordination_runs SET plan_json=? WHERE run_id=?').run(JSON.stringify(plan),rootRunId);
  }
  return effectiveMessages.map((message,index)=>{
    const key=proposedSteps(turnId,[message],sourceMemberId,[])[0]!.key.replace(/_0$/,`_${index}`);
    const child=deferred[index]?null:merged[index]?.childTaskId??(db.prepare('SELECT child_task_id FROM coordination_steps WHERE run_id=? AND step_key=?').get(rootRunId,key) as {child_task_id:string}).child_task_id;
    const id=`handoff_${hash(turnId+':'+index).slice(0,32)}`,now=Date.now();
    db.prepare(`INSERT INTO coordination_messages(id,coordination_run_id,project_id,conversation_id,thread_id,source_turn_id,source_index,
      source_member_id,target_member_id,purpose,body,body_hash,child_task_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?)`)
      .run(id,rootRunId,parent.project_id,parent.conversation_id,parent.conversation_thread_id,turnId,index,sourceMemberId,message.toMemberId,message.purpose,message.message,hash(message.message),child,now,now);
    appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${id}`,projectId:parent.project_id,conversationId:parent.conversation_id,threadId:parent.conversation_thread_id,taskId:parent.id,runId:rootRunId,turnId,
      kind:'member.messageAccepted',createdAt:now,payload:{messageId:id,sourceMemberId,targetMemberId:message.toMemberId,purpose:message.purpose,bodyHash:hash(message.message),childTaskId:child,...(merged[index]?{mergedIntoInitialStep:merged[index]!.stepKey}:{})}});
    return{id,toMemberId:message.toMemberId,text:message.message};
  });
}

export function bindMemberMessageTurn(db:ZhongshuoDatabase,taskId:string,runId:string,turnId:string){
  db.prepare(`UPDATE coordination_messages SET target_turn_id=?,status='queued',updated_at=? WHERE status IN ('accepted','queued') AND
    (child_task_id=? OR (child_task_id IS NULL AND coordination_run_id IN(SELECT coordination_run_id FROM coordination_integration_attempts WHERE execution_run_id=?)))`).run(turnId,Date.now(),taskId,runId);
}
export function markMemberMessageStarted(db:ZhongshuoDatabase,turnId:string){
  db.prepare("UPDATE coordination_messages SET status='running',updated_at=? WHERE target_turn_id=? AND status='queued'").run(Date.now(),turnId);
}
export function settleMemberMessageTurn(db:ZhongshuoDatabase,taskId:string,turnId:string,status:string,error?:string){
  const delivery=status==='SUCCEEDED'?(db.prepare('SELECT current_delivery_id FROM tasks WHERE id=?').get(taskId) as {current_delivery_id:string|null})?.current_delivery_id:null;
  db.prepare(`UPDATE coordination_messages SET status=?,target_delivery_id=COALESCE(?,target_delivery_id),error_message=COALESCE(?,error_message),updated_at=?
    WHERE target_turn_id=? AND status IN ('queued','running','blocked')`).run(status==='SUCCEEDED'?'completed':status==='CANCELLED'?'cancelled':'blocked',delivery,error??null,Date.now(),turnId);
}
