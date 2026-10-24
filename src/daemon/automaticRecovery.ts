import {createHash,randomUUID} from 'node:crypto';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {enqueueOutbox} from '../persistence/outbox.ts';
import {appendDomainEvent} from '../persistence/events.ts';

export interface RecoveryExecution {
  dispatchKey:string;
  writeScope:string;
  phase:'planning'|'child'|'integration'|null;
  rootTurnId:string;
  extraAttempts:number;
}
export interface AutomaticRecovery extends RecoveryExecution {
  taskId:string;runId:string;sourceTurnId:string;targetDispatchKey:string;
  kind:'transient'|'output';stopGeneration:number;nextAttemptAt:number;
  state:'waiting'|'queued'|'running'|'completed'|'stopped';reason:string;
}
function read<T>(db:ZhongshuoDatabase,key:string):T|undefined{
  const row=db.prepare('SELECT value FROM daemon_state WHERE key=?').get(key) as {value:string}|undefined;
  return row?JSON.parse(row.value) as T:undefined;
}
function save(db:ZhongshuoDatabase,key:string,value:unknown){
  db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,JSON.stringify(value),Date.now());
}
export function recoveryExecution(db:ZhongshuoDatabase,turnId:string){return read<RecoveryExecution>(db,`execution-context:${turnId}`);}
export function saveRecoveryExecution(db:ZhongshuoDatabase,turnId:string,value:RecoveryExecution){save(db,`execution-context:${turnId}`,value);}
export function continuedRecoveryExecution(db:ZhongshuoDatabase,taskId:string,dispatchKey:string):RecoveryExecution|undefined{
  const event=db.prepare(`SELECT json_extract(payload_json,'$.sourceRunId') sourceRunId FROM domain_events WHERE task_id=? AND kind='task.redispatchEnqueued' AND json_extract(payload_json,'$.dispatchKey')=? ORDER BY seq DESC LIMIT 1`).get(taskId,dispatchKey) as {sourceRunId:string|null}|undefined;
  if(!event?.sourceRunId)return;
  const turn=db.prepare("SELECT id FROM agent_turns WHERE run_id=? AND status='FAILED' ORDER BY rowid DESC LIMIT 1").get(event.sourceRunId) as {id:string}|undefined;
  return turn?recoveryExecution(db,turn.id):undefined;
}
export function automaticRecoveryForDispatch(db:ZhongshuoDatabase,key:string):AutomaticRecovery|undefined{
  const row=db.prepare(`SELECT value FROM daemon_state WHERE key LIKE 'automatic-recovery:%' AND json_extract(value,'$.targetDispatchKey')=?`).get(key) as {value:string}|undefined;
  return row?JSON.parse(row.value) as AutomaticRecovery:undefined;
}
export function hasBusinessToolEvidence(db:ZhongshuoDatabase,turnId:string):boolean{
  return Boolean(db.prepare(`SELECT 1 FROM domain_events e WHERE e.turn_id=? AND
    (e.kind='tool.started' AND COALESCE(json_extract(e.payload_json,'$.toolName'),'')!='StructuredOutput'
    OR e.kind='tool.completed' AND NOT EXISTS(SELECT 1 FROM domain_events s WHERE s.turn_id=e.turn_id AND s.kind='tool.started'
      AND json_extract(s.payload_json,'$.toolName')='StructuredOutput' AND json_extract(s.payload_json,'$.toolCallId')=json_extract(e.payload_json,'$.toolCallId'))) LIMIT 1`).get(turnId));
}
function record(db:ZhongshuoDatabase,job:AutomaticRecovery,kind:string,message:string,now:number){
  const task=db.prepare('SELECT project_id,conversation_id,conversation_thread_id FROM tasks WHERE id=?').get(job.taskId) as {project_id:string;conversation_id:string;conversation_thread_id:string};
  appendDomainEvent(db,{eventId:`evt_${randomUUID()}`,schemaVersion:1,projectId:task.project_id,conversationId:task.conversation_id,threadId:task.conversation_thread_id,taskId:job.taskId,runId:job.runId,turnId:job.sourceTurnId,kind,payload:{message,attempt:job.extraAttempts,maxExtraAttempts:2,nextAttemptAt:job.nextAttemptAt,recoveryKind:job.kind},createdAt:now});
}
/** Only a confirmed terminal failure may create a new, bounded intent. Unknown
 * execution and failures with possible business side effects are never replayed. */
export function requestAutomaticRecovery(db:ZhongshuoDatabase,args:{taskId:string;runId:string;turnId:string;kind:'transient'|'output';reason:string;code?:string;output?:string;businessChanges?:boolean;now:number}):boolean{
  const execution=recoveryExecution(db,args.turnId);
  if(!execution||read(db,`automatic-recovery:${args.turnId}`))return false;
  const source=db.prepare('SELECT status,stop_generation_snapshot,turn_purpose FROM agent_turns WHERE id=? AND run_id=?').get(args.turnId,args.runId) as {status:string;stop_generation_snapshot:number;turn_purpose:string}|undefined;
  const task=db.prepare('SELECT status,stop_generation FROM tasks WHERE id=?').get(args.taskId) as {status:string;stop_generation:number};
  if(source?.status!=='FAILED'||task.status==='CANCELLED'||source.stop_generation_snapshot!==task.stop_generation)return false;
  if(db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND (a.status='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='recovery.protectionReleased' AND json_extract(e.payload_json,'$.released')=1) OR a.protection_state='retained') LIMIT 1`).get(args.taskId))return false;
  const retryHint=/retry[- _]?after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds)?/i.exec(args.reason);
  const hintedMs=retryHint?Number(retryHint[1])*(retryHint[2]?.toLowerCase()==='ms'?1:1000):0;
  const delay=Math.max(execution.extraAttempts===0?2000:8000,Math.min(300000,hintedMs));
  const job:AutomaticRecovery={...execution,extraAttempts:execution.extraAttempts+1,taskId:args.taskId,runId:args.runId,sourceTurnId:args.turnId,targetDispatchKey:`task:${args.taskId}:redispatch:auto_${args.turnId}`,kind:args.kind,stopGeneration:task.stop_generation,nextAttemptAt:args.now+delay,state:'waiting',reason:args.reason.slice(0,1000)};
  if(hintedMs>300000){job.state='stopped';save(db,`automatic-recovery:${args.turnId}`,job);record(db,job,'recovery.stopped',`服务端要求等待超过5分钟，未提前重发。最后原因：${job.reason}。请稍后从原任务继续。`,args.now);return false;}
  const noRetry=/auth|unauthori|forbidden|api.?key|credential|billing|balance|credit|insufficient|quota|usage.limit|payment|cancel|interrupt|permission|认证|余额|欠费|权限|配置|名单|代次|停止|预算|未开放|不存在|已失效|目录|成员停用/i.test(`${args.code??''} ${args.reason}`);
  const exhausted=execution.extraAttempts>=2||source.turn_purpose==='format_repair';
  const transient=/429|\b50[234]\b|rate.?limit|overloaded|temporar|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|socket|fetch failed|upstream|网络|限流|暂时|繁忙/i.test(`${args.code??''} ${args.reason}`);
  const tool=hasBusinessToolEvidence(db,args.turnId);
  if(noRetry||exhausted||args.kind==='transient'&&(!transient||tool||args.businessChanges)){
    if(exhausted){job.state='stopped';save(db,`automatic-recovery:${args.turnId}`,job);record(db,job,'recovery.exhausted',`自动恢复已停止（额外尝试上限2次；输出只补交一次）。最后原因：${job.reason}。已有成果保留，请处理原因后从原任务继续。`,args.now);}
    return false;
  }
  if(args.kind==='output'){
    const invalid=db.prepare("SELECT event_id,payload_json FROM domain_events WHERE turn_id=? AND kind='turn.outputInvalid' ORDER BY seq DESC LIMIT 1").get(args.turnId) as {event_id:string;payload_json:string}|undefined;
    const created=db.prepare("SELECT json_extract(payload_json,'$.resultKey') resultKey FROM domain_events WHERE turn_id=? AND kind='run.created' ORDER BY seq DESC LIMIT 1").get(args.turnId) as {resultKey:string}|undefined;
    if(!invalid||!created?.resultKey||args.output===undefined||db.prepare('SELECT 1 FROM format_repair_workitems WHERE task_id=? AND logical_output_id=?').get(args.taskId,execution.rootTurnId))return false;
    db.prepare(`INSERT INTO format_repair_workitems(id,task_id,source_turn_id,source_result_key,logical_output_id,invalid_event_id,source_output_hash,source_output_text,invalid_issues_json,target_dispatch_key,budget_run_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(`frw_${randomUUID()}`,args.taskId,args.turnId,created.resultKey,execution.rootTurnId,invalid.event_id,createHash('sha256').update(args.output).digest('hex'),args.output,JSON.stringify((JSON.parse(invalid.payload_json) as {issues:string[]}).issues),job.targetDispatchKey,args.runId,args.now,args.now);
  }
  save(db,`automatic-recovery:${args.turnId}`,job);
  // Keep the exact original coordination/run identity; failed turns remain audit
  // facts while a separate durable intent waits for confirmed resource release.
  db.prepare("UPDATE coordination_runs SET state=?,error_message=NULL WHERE (run_id=? OR integration_run_id=?) AND state='blocked'").run(execution.phase==='planning'?'planning':'integrating',args.runId,args.runId);
  db.prepare("UPDATE workflow_runs SET status='WAITING',stage=? WHERE id=?").run(args.kind==='output'?'等待只读补交结果':'等待自动重试',args.runId);
  db.prepare("UPDATE tasks SET status='ACTIVE',revision=revision+1 WHERE id=? AND status!='CANCELLED'").run(args.taskId);
  record(db,job,'recovery.scheduled',`第${job.extraAttempts}/2次额外尝试将在${(job.nextAttemptAt-args.now)/1000}秒后${args.kind==='output'?'只读补交结果，不重复修改':'重试'}。上次原因：${job.reason}`,args.now);
  return true;
}
export function pendingAutomaticRecovery(db:ZhongshuoDatabase,taskId:string):AutomaticRecovery|undefined{
  const row=db.prepare(`SELECT value FROM daemon_state WHERE key LIKE 'automatic-recovery:%' AND json_extract(value,'$.taskId')=? AND json_extract(value,'$.state') IN ('waiting','queued','running') ORDER BY rowid DESC LIMIT 1`).get(taskId) as {value:string}|undefined;
  return row?JSON.parse(row.value) as AutomaticRecovery:undefined;
}
export function markAutomaticRecovery(db:ZhongshuoDatabase,job:AutomaticRecovery,state:AutomaticRecovery['state']){save(db,`automatic-recovery:${job.sourceTurnId}`,{...job,state});}
export function rebindAutomaticRecovery(db:ZhongshuoDatabase,job:AutomaticRecovery,turnId:string,now:number){
  for(const table of ['thread_reply_requests','conversation_reply_requests'])db.prepare(`UPDATE ${table} SET status='running',turn_id=?,error_message=NULL,updated_at=? WHERE task_id=? AND run_id=? AND turn_id=? AND status='failed'`).run(turnId,now,job.taskId,job.runId,job.sourceTurnId);
  db.prepare(`UPDATE coordination_messages SET status='queued',target_turn_id=?,error_message=NULL,updated_at=? WHERE target_turn_id=? AND status='blocked' AND
    (child_task_id=? OR coordination_run_id IN(SELECT coordination_run_id FROM coordination_integration_attempts WHERE execution_run_id=?))`).run(turnId,now,job.sourceTurnId,job.taskId,job.runId);
}
export function cancelWaitingAutomaticRecovery(db:ZhongshuoDatabase,taskId:string,runId:string,now:number){
  const job=pendingAutomaticRecovery(db,taskId);if(!job||job.runId!==runId||!['waiting','queued'].includes(job.state))return false;
  if(db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND (a.status NOT IN ('FAILED','SUCCEEDED','CANCELLED','UNKNOWN') OR a.status='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='recovery.protectionReleased' AND json_extract(e.payload_json,'$.released')=1) OR a.protection_state='retained' OR EXISTS(SELECT 1 FROM workspace_leases l WHERE l.owner_turn_id=a.id AND l.status!='released'))`).get(taskId))return false;
  if(db.prepare('SELECT 1 FROM agent_turns WHERE dispatch_key=?').get(job.targetDispatchKey))return false;
  markAutomaticRecovery(db,job,'stopped');
  db.prepare("UPDATE outbox SET status='done',lease_owner=NULL,lease_until=NULL WHERE dispatch_key=? AND status IN ('pending','leased')").run(job.targetDispatchKey);
  db.prepare("UPDATE workflow_runs SET status='CANCELLED',stage='用户停止自动恢复' WHERE id=? AND task_id=? AND status='STOPPING'").run(runId,taskId);
  db.prepare("UPDATE tasks SET status='CANCELLED',revision=revision+1 WHERE id=?").run(taskId);
  for(const table of ['thread_reply_requests','conversation_reply_requests'])db.prepare(`UPDATE ${table} SET status='cancelled',error_message='用户停止自动恢复；未再次执行',updated_at=? WHERE task_id=? AND turn_id=? AND status='failed'`).run(now,taskId,job.sourceTurnId);
  record(db,job,'recovery.cancelled','用户已停止自动恢复；没有在途执行，等待与排队已取消。已有成果和失败记录保留。',now);return true;
}
export function settleRejectedRecoveryDispatch(db:ZhongshuoDatabase,dispatchKey:string,now:number){
  const job=automaticRecoveryForDispatch(db,dispatchKey);if(!job||!['queued','running'].includes(job.state))return;
  if(db.prepare('SELECT 1 FROM agent_turns WHERE dispatch_key=?').get(dispatchKey))return;
  const outbox=db.prepare('SELECT status FROM outbox WHERE dispatch_key=?').get(dispatchKey) as {status:string}|undefined;
  if(!outbox||!['done','failed'].includes(outbox.status))return;
  markAutomaticRecovery(db,job,'stopped');
  db.prepare("UPDATE workflow_runs SET status='FAILED' WHERE id=? AND status='WAITING'").run(job.runId);
  record(db,job,'recovery.stopped','自动恢复未启动：当前权限、成员、文件版本或调用预算不满足派发条件。请查看本次运行的具体阻断原因；已有成果保留。',now);
}
/** Safe waiting intents have no possible provider execution. This is the only
 * restart exception to the ordinary interrupted-run/manual-gate policy. */
export function safeRecoveryWaiting(db:ZhongshuoDatabase):{runIds:string[];dispatchKeys:string[]}{
  const rows=db.prepare(`SELECT value FROM daemon_state WHERE key LIKE 'automatic-recovery:%' AND json_extract(value,'$.state') IN ('waiting','queued')`).all() as {value:string}[];
  const safe=rows.map(row=>JSON.parse(row.value) as AutomaticRecovery).filter(job=>{
    const source=db.prepare(`SELECT a.status,t.status task_status,t.stop_generation,a.protection_state FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id WHERE a.id=? AND a.run_id=? AND t.id=?`).get(job.sourceTurnId,job.runId,job.taskId) as {status:string;task_status:string;stop_generation:number;protection_state:string|null}|undefined;
    return source?.status==='FAILED'&&source.task_status!=='CANCELLED'&&source.stop_generation===job.stopGeneration&&source.protection_state!=='retained'
      &&!db.prepare('SELECT 1 FROM agent_turns WHERE dispatch_key=?').get(job.targetDispatchKey)
      &&!db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND (a.status NOT IN ('FAILED','SUCCEEDED','CANCELLED','UNKNOWN') OR a.status='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='recovery.protectionReleased' AND json_extract(e.payload_json,'$.released')=1) OR a.protection_state='retained' OR EXISTS(SELECT 1 FROM workspace_leases l WHERE l.owner_turn_id=a.id AND l.status!='released'))`).get(job.taskId);
  });
  const runIds=safe.map(job=>job.runId);
  for(const job of safe){
    const parent=db.prepare(`SELECT c.run_id FROM coordination_steps s JOIN coordination_runs c ON c.run_id=s.run_id WHERE s.child_task_id=? AND c.state='running'`).get(job.taskId) as {run_id:string}|undefined;
    if(parent){const unfinished=db.prepare(`SELECT t.id FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id WHERE s.run_id=? AND t.status!='DONE'`).all(parent.run_id) as {id:string}[];if(unfinished.every(child=>safe.some(item=>item.taskId===child.id)))runIds.push(parent.run_id);}
  }
  return{runIds:[...new Set(runIds)],dispatchKeys:safe.map(job=>job.targetDispatchKey)};
}
export function pumpAutomaticRecoveries(db:ZhongshuoDatabase,now:number){
  const rows=db.prepare(`SELECT value FROM daemon_state WHERE key LIKE 'automatic-recovery:%' AND json_extract(value,'$.state') IN ('waiting','queued','running')`).all() as {value:string}[];
  for(const row of rows)db.transaction(()=>{
    const job=JSON.parse(row.value) as AutomaticRecovery;
    const task=db.prepare('SELECT status,stop_generation FROM tasks WHERE id=?').get(job.taskId) as {status:string;stop_generation:number}|undefined;
    const turn=db.prepare('SELECT status,protection_state FROM agent_turns WHERE dispatch_key=?').get(job.targetDispatchKey) as {status:string;protection_state:string|null}|undefined;
    if(turn&&['SUCCEEDED','FAILED','CANCELLED','UNKNOWN'].includes(turn.status)){
      markAutomaticRecovery(db,job,turn.status==='SUCCEEDED'?'completed':'stopped');return;
    }
    if(!task||task.status==='CANCELLED'||task.stop_generation!==job.stopGeneration){markAutomaticRecovery(db,job,'stopped');return;}
    if(job.state==='waiting'&&job.nextAttemptAt<=now){
      // A restart never treats a still-live/retained/UNKNOWN source as safe.
      const unsafe=db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND (a.status NOT IN ('SUCCEEDED','FAILED','CANCELLED','UNKNOWN') OR a.status='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='recovery.protectionReleased' AND json_extract(e.payload_json,'$.released')=1) OR a.protection_state='retained') LIMIT 1`).get(job.taskId);
      const lease=db.prepare("SELECT 1 FROM workspace_leases WHERE owner_turn_id=? AND status!='released'").get(job.sourceTurnId);
      if(unsafe||lease)return;
      enqueueOutbox(db,{dispatchKey:job.targetDispatchKey,stopGenerationAtEnqueue:job.stopGeneration});markAutomaticRecovery(db,job,'queued');
      record(db,job,'recovery.queued',`第${job.extraAttempts}/2次额外尝试已排队（${job.kind==='output'?'仅补交结果':'临时故障重试'}）。上次原因：${job.reason}`,now);
    }
  })();
}
