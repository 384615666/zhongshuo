import {randomUUID} from 'node:crypto';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {appendDomainEvent} from '../persistence/events.ts';
import {assessTaskRedispatchReadiness} from '../persistence/stores/recoveryGuard.ts';
import {DaemonCommandError} from './commandError.ts';

/** Only an accepted user command may reopen a stopped root. Keep the stop
 * generation and all old execution/queue facts: only the new intent may run. */
export function continueStoppedTask(db:ZhongshuoDatabase,taskId:string,now=Date.now()):void {
  const task=db.prepare('SELECT project_id,conversation_id,conversation_thread_id,parent_task_id,status,stop_generation FROM tasks WHERE id=?')
    .get(taskId) as {project_id:string;conversation_id:string;conversation_thread_id:string|null;parent_task_id:string|null;status:string;stop_generation:number}|undefined;
  if(task?.status!=='CANCELLED')return;
  if(task.stop_generation===0)throw new DaemonCommandError('STALE_REVISION','任务已结束；请新建工作请求');
  if(task.parent_task_id)throw new DaemonCommandError('STALE_REVISION','已停止的协作步骤不能单独恢复；请从原任务继续');
  const blocked=assessTaskRedispatchReadiness(db,taskId);
  if(blocked)throw new DaemonCommandError(blocked.code,blocked.message);
  const source=db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as {id:string}|undefined;
  const turns=db.prepare(`WITH RECURSIVE scope(id) AS (
    SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN scope s ON t.parent_task_id=s.id
  ) SELECT a.id,a.run_id,r.task_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
    WHERE r.task_id IN (SELECT id FROM scope) AND NOT EXISTS(SELECT 1 FROM domain_events e
      WHERE e.turn_id=a.id AND e.kind='turn.supersededByContinue')`).all(taskId) as {id:string;run_id:string;task_id:string}[];
  for(const turn of turns)appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:task.project_id,
    taskId:turn.task_id,runId:turn.run_id,turnId:turn.id,kind:'turn.supersededByContinue',createdAt:now,
    payload:{requestTaskId:taskId,stopGeneration:task.stop_generation}});
  db.prepare("UPDATE tasks SET status='ACTIVE',revision=revision+1 WHERE id=? AND status='CANCELLED'").run(taskId);
  appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:task.project_id,
    conversationId:task.conversation_id,threadId:task.conversation_thread_id,taskId,runId:source?.id,
    kind:'task.resumed',createdAt:now,payload:{stopGeneration:task.stop_generation}});
}

/** Durable proof that a previous continuation was consumed before any model or
 * coordination execution was created. A done queue flag alone is insufficient. */
export function unstartedContinuationKey(db:ZhongshuoDatabase,taskId:string,sourceRunId:string):string|undefined{
  const key=`task:${taskId}:redispatch:${sourceRunId}`;
  return db.prepare(`SELECT 1 FROM outbox o JOIN domain_events e
    ON e.task_id=? AND e.kind='task.redispatchEnqueued'
      AND json_extract(e.payload_json,'$.dispatchKey')=o.dispatch_key
      AND json_extract(e.payload_json,'$.sourceRunId')=?
    JOIN workflow_runs source ON source.id=? AND source.task_id=e.task_id AND source.status='INTERRUPTED'
    WHERE o.dispatch_key=? AND o.status='done' AND o.turn_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM agent_turns a WHERE a.dispatch_key=o.dispatch_key)
      AND NOT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.dispatch_identity=o.dispatch_key)
    LIMIT 1`).get(taskId,sourceRunId,sourceRunId,key)!=null?key:undefined;
}

/** Called inside the accepted user command's transaction. Continuing is the
 * user's decision to move past an interruption, not a claim of successful work
 * or proof that an old OS process exited. Never changes a currently active turn.
 */
export function continueInterruptedTask(db:ZhongshuoDatabase,taskId:string,now=Date.now()):string[]{
  const turns=db.prepare(`WITH RECURSIVE scope(id) AS (
    SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN scope s ON t.parent_task_id=s.id
  ) SELECT a.id,a.run_id,a.status,a.budget_mark,r.task_id,t.project_id,r.budget_json
    FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
    WHERE r.task_id IN (SELECT id FROM scope)
      AND a.status IN ('UNKNOWN','SUCCEEDED','FAILED','CANCELLED')
      AND (a.protection_state='retained'
        OR EXISTS(SELECT 1 FROM workspace_leases l WHERE l.owner_turn_id=a.id AND l.status!='released')
        OR (a.status='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id
          AND e.kind='recovery.protectionReleased' AND json_extract(e.payload_json,'$.released')=1)))
    ORDER BY a.rowid`).all(taskId) as {id:string;run_id:string;status:string;budget_mark:string|null;task_id:string;project_id:string;budget_json:string|null}[];
  for(const turn of turns){
    if(turn.budget_mark==null&&turn.status==='UNKNOWN'){
      // Re-read per turn: multiple interrupted turns may share a run budget.
      const run=db.prepare('SELECT budget_json FROM workflow_runs WHERE id=?').get(turn.run_id) as {budget_json:string|null};
      if(run.budget_json){
        const budget=JSON.parse(run.budget_json) as {usedTurns:number;inFlightReservedTurns:number};
        db.prepare('UPDATE workflow_runs SET budget_json=? WHERE id=?').run(JSON.stringify({...budget,
          usedTurns:budget.usedTurns+1,inFlightReservedTurns:Math.max(0,budget.inFlightReservedTurns-1)}),turn.run_id);
      }
      db.prepare("UPDATE agent_turns SET budget_mark='settled' WHERE id=? AND budget_mark IS NULL").run(turn.id);
    }
    const leases=db.prepare("SELECT lock_domain FROM workspace_leases WHERE owner_turn_id=? AND status!='released'").all(turn.id) as {lock_domain:string}[];
    db.prepare("UPDATE workspace_leases SET status='released' WHERE owner_turn_id=? AND status!='released'").run(turn.id);
    db.prepare("UPDATE agent_turns SET protection_state='released' WHERE id=?").run(turn.id);
    // Fence only the interrupted attempt's old delivery row. A fresh continuation
    // gets its own dispatch identity; the abandoned attempt must not be reclaimed.
    db.prepare(`UPDATE outbox SET status='done',attempt_epoch=attempt_epoch+1,lease_owner=NULL,lease_until=NULL
      WHERE turn_id=? AND status IN ('pending','leased')`).run(turn.id);
    for(const table of ['thread_reply_requests','conversation_reply_requests']){
      db.prepare(`UPDATE ${table} SET status='unknown',updated_at=? WHERE turn_id=? AND status IN ('queued','running')`).run(now,turn.id);
    }
    appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:turn.project_id,
      taskId:turn.task_id,runId:turn.run_id,turnId:turn.id,kind:'recovery.protectionReleased',createdAt:now,
      payload:{released:true,reason:'user-continue-interrupted-task',requestTaskId:taskId,
        releasedLeases:leases.map(l=>l.lock_domain),businessResultUnchanged:true}});
    // An interrupted turn can survive an old run status. Close only that stale
    // run when no genuinely active turns remain; real active work still queues.
    db.prepare(`UPDATE workflow_runs SET status='INTERRUPTED' WHERE id=? AND status IN ('RUNNING','WAITING','QUEUED')
      AND NOT EXISTS(SELECT 1 FROM agent_turns WHERE run_id=? AND status NOT IN ('UNKNOWN','SUCCEEDED','FAILED','CANCELLED'))`).run(turn.run_id,turn.run_id);
  }
  return turns.map(turn=>turn.id);
}
