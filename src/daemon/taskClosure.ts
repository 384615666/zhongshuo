import { randomUUID } from 'node:crypto';
import type { TaskClosureBinding, TaskClosureBlockReason, TaskClosureRead, TaskClosureResult } from '../contracts/taskClosure.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { classifyProtectionFactComplete } from '../persistence/migrations/044-turn-protection-evidence-complete.ts';
import { DaemonCommandError } from './commandError.ts';

interface TaskRow {
  id: string;
  project_id: string;
  conversation_id: string;
  conversation_thread_id: string | null;
  status: string;
  revision: number;
  stop_generation: number;
}
interface RecoveryRow { key: string; value: string; }
interface ScopedOutboxRow { id:number; status:string; lease_owner:string|null; lease_until:number|null; }

const terminalTasks = new Set(['DONE', 'CANCELLED']);
const terminalTurns = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']);
const terminalRuns = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
const closureMessage = '用户已结束任务；排队工作未执行，原结果与失败记录保留';

function latestRunId(db: ZhongshuoDatabase, taskId: string): string | null {
  return (db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as {id:string} | undefined)?.id ?? null;
}

/** UNION also terminates safely if damaged legacy data contains a parent cycle. */
function taskTree(db: ZhongshuoDatabase, taskId: string): TaskRow[] {
  return db.prepare(`WITH RECURSIVE tree(id) AS (
    SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN tree p ON t.parent_task_id=p.id
  ) SELECT t.* FROM tasks t JOIN tree ON tree.id=t.id ORDER BY t.rowid`).all(taskId) as TaskRow[];
}

function recoveryRows(db: ZhongshuoDatabase, taskId: string): RecoveryRow[] {
  return db.prepare(`SELECT key,value FROM daemon_state WHERE key GLOB 'automatic-recovery:*'
    AND CASE WHEN json_valid(value) THEN json_extract(value,'$.taskId') END=?`).all(taskId) as RecoveryRow[];
}

/** Task IDs are compared literally (never LIKE patterns). Durable relational
 * owners also cover nonstandard keys and old reply/repair dispatch identities. */
function scopedOutbox(db: ZhongshuoDatabase, taskId: string): ScopedOutboxRow[] {
  const rows = db.prepare(`WITH owned AS (SELECT o.id,o.dispatch_key,o.status,o.lease_owner,o.lease_until,
    (EXISTS(SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
      WHERE r.task_id=? AND (a.id=o.turn_id OR a.dispatch_key=o.dispatch_key))
    OR EXISTS(SELECT 1 FROM thread_reply_requests q WHERE q.task_id=? AND (q.dispatch_key=o.dispatch_key OR q.dispatch_identity=o.dispatch_key))
    OR EXISTS(SELECT 1 FROM conversation_reply_requests q WHERE q.task_id=? AND q.dispatch_key=o.dispatch_key)
    OR EXISTS(SELECT 1 FROM format_repair_workitems f WHERE f.task_id=? AND f.target_dispatch_key=o.dispatch_key)
    OR EXISTS(SELECT 1 FROM domain_events e WHERE e.task_id=? AND e.kind IN ('task.redispatchEnqueued','task.resumeEnqueued')
      AND CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json,'$.dispatchKey') END=o.dispatch_key)
    OR EXISTS(SELECT 1 FROM daemon_state d WHERE d.key GLOB 'automatic-recovery:*' AND json_valid(d.value)
      AND json_extract(d.value,'$.taskId')=? AND json_extract(d.value,'$.targetDispatchKey')=o.dispatch_key)) AS linked FROM outbox o)
    SELECT * FROM owned WHERE linked OR substr(dispatch_key,1,length(?))=? OR substr(dispatch_key,1,length(?))=?
    ORDER BY id`).all(taskId,taskId,taskId,taskId,taskId,taskId,
      `task:${taskId}:`,`task:${taskId}:`,`dmtask:${taskId}:`,`dmtask:${taskId}:`) as Array<ScopedOutboxRow & {dispatch_key:string;linked:number}>;
  return rows.filter(row => {
    if (row.linked) return true;
    // Match the worker's complete key grammars, rather than treating a longer
    // task ID containing ':' as a child of this ID's textual prefix.
    const ordinary = row.dispatch_key.match(/^(?:dm)?task:(.+):(?:initial|redispatch(?::[^:]+)?|repair:[^:]+|conversation:[^:]+|thread-reply:[^:]+|reminder:[^:]+:[^:]+)$/);
    const deliberation = row.dispatch_key.match(/^task:([^:]+):delib:(run_[^:]+):/);
    return (ordinary?.[1] ?? deliberation?.[1]) === taskId;
  });
}

function safetyBlock(db: ZhongshuoDatabase, task: TaskRow): TaskClosureBlockReason | null {
  const blocked = (code: TaskClosureBlockReason['code'], message: string): TaskClosureBlockReason => ({code,message,taskId:task.id});
  const runs = db.prepare('SELECT id,status FROM workflow_runs WHERE task_id=?').all(task.id) as Array<{id:string;status:string}>;
  if (runs.some(run => !terminalRuns.has(run.status))) return blocked('WORKER_STILL_RUNNING','任务或子任务仍有活动运行；请先停止并确认执行退出');
  const turns = db.prepare(`SELECT a.id,a.status,a.protection_state,a.budget_mark FROM agent_turns a
    JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?`).all(task.id) as Array<{id:string;status:string;protection_state:string|null;budget_mark:string|null}>;
  for (const turn of turns) {
    // Includes PENDING / DISPATCHING / WAITING_INPUT / WAITING_APPROVAL, which
    // the redispatch readiness helper's legacy in-flight list does not cover.
    if (!terminalTurns.has(turn.status)) return blocked('WORKER_STILL_RUNNING','任务或子任务仍有在途执行；请先停止并确认执行退出');
    if (turn.protection_state === 'retained') return blocked('RECONCILE_REQUIRED','任务或子任务仍保留执行保护；请先在恢复中心核实并解除保护');
    if (db.prepare("SELECT 1 FROM workspace_leases WHERE owner_turn_id=? AND status!='released' LIMIT 1").get(turn.id)) {
      return blocked('RECONCILE_REQUIRED','任务或子任务仍有未释放的物理租约；结束任务不会解除写入保护');
    }
    if (turn.status === 'UNKNOWN') {
      const events = db.prepare(`SELECT kind,payload_json FROM domain_events WHERE turn_id=?
        AND kind IN ('recovery.reconciled','recovery.protectionReleased') ORDER BY seq DESC`).all(turn.id) as Array<{kind:string;payload_json:string}>;
      const fact = events.map(event => classifyProtectionFactComplete(event.kind,event.payload_json)).find(value => value != null);
      if (turn.budget_mark == null || fact !== 'released') return blocked('RECONCILE_REQUIRED','任务或子任务存在未闭环的 UNKNOWN 执行；请先在恢复中心完成核实');
    }
  }
  if (scopedOutbox(db,task.id).some(row => row.status === 'leased' || row.status === 'pending' && (row.lease_owner != null || row.lease_until != null))) {
    return blocked('WORKER_STILL_RUNNING','任务或子任务的排队工作已被领取；请先停止并确认执行退出');
  }
  for (const row of recoveryRows(db,task.id)) {
    if ((JSON.parse(row.value) as {state?:string}).state === 'running') return blocked('WORKER_STILL_RUNNING','任务或子任务的自动恢复已开始；请先停止并确认执行退出');
  }
  for (const table of ['thread_reply_requests','conversation_reply_requests']) {
    const requests = db.prepare(`SELECT status,run_id,turn_id FROM ${table} WHERE task_id=? AND status IN ('unknown','running')`).all(task.id) as Array<{status:string;run_id:string|null;turn_id:string|null}>;
    for (const request of requests) {
      // Summaries can outlive formal reconciliation. Only real execution
      // identities prove that an unknown request belongs to the safe turns
      // checked above; its source_turn_id is the previous answer, not proof of
      // this reply's execution. A missing/foreign identity remains protected.
      const run = request.run_id == null ? undefined : db.prepare('SELECT id FROM workflow_runs WHERE id=? AND task_id=?').get(request.run_id,task.id) as {id:string}|undefined;
      const turn = request.turn_id == null ? undefined : db.prepare(`SELECT a.run_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
        WHERE a.id=? AND r.task_id=?`).get(request.turn_id,task.id) as {run_id:string}|undefined;
      if (request.run_id != null && !run || request.turn_id != null && !turn || run && turn && run.id !== turn.run_id) {
        return blocked('RECONCILE_REQUIRED','续问的执行归属尚未核实；请先在恢复中心核实执行结果');
      }
      if (request.status === 'unknown' && !turn && (!run || !db.prepare('SELECT 1 FROM agent_turns WHERE run_id=? LIMIT 1').get(run.id))) {
        return blocked('RECONCILE_REQUIRED','结果未知的续问无法定位实际执行；请先在恢复中心核实执行结果');
      }
    }
  }
  return null;
}

/** Read-only availability: never repairs state, cancels work, or releases locks. */
export function readTaskClosure(db: ZhongshuoDatabase, taskId: string): TaskClosureRead {
  const tree = taskTree(db,taskId);
  const task = tree.find(row => row.id === taskId);
  if (!task) return {available:false,blockReason:{code:'RESOURCE_NOT_FOUND',message:'任务不存在',taskId}};
  if (terminalTasks.has(task.status)) return {available:false,blockReason:{code:'VALIDATION_INVALID',message:'任务已经结束',taskId}};
  for (const scoped of tree) {
    const blockReason = safetyBlock(db,scoped);
    if (blockReason) return {available:false,blockReason};
  }
  return {available:true,binding:{taskId,expectedTaskRevision:task.revision,expectedStopGeneration:task.stop_generation,sourceRunId:latestRunId(db,taskId)},blockReason:null};
}

/** Synchronous transaction kernel. The command entry owns runCommand receipts
 * and authorization. Nested use is a savepoint in that same command transaction. */
export function closeIdleTask(db: ZhongshuoDatabase, binding: TaskClosureBinding, now: number): TaskClosureResult {
  return db.transaction((): TaskClosureResult => {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(binding.taskId) as TaskRow | undefined;
    if (!task) throw new DaemonCommandError('RESOURCE_NOT_FOUND','任务不存在');
    if (task.revision !== binding.expectedTaskRevision || task.stop_generation !== binding.expectedStopGeneration || latestRunId(db,task.id) !== binding.sourceRunId) {
      throw new DaemonCommandError('STALE_REVISION','任务状态或最新执行已变化，请刷新后重新确认结束');
    }
    const readiness = readTaskClosure(db,task.id);
    if (!readiness.available) throw new DaemonCommandError(readiness.blockReason!.code,readiness.blockReason!.message);
    const tree = taskTree(db,task.id);
    const cancelledTaskIds: string[] = [];
    let cancelledOutboxCount = 0;
    for (const scoped of tree) {
      for (const row of scopedOutbox(db,scoped.id)) {
        cancelledOutboxCount += db.prepare("UPDATE outbox SET status='done' WHERE id=? AND status='pending' AND lease_owner IS NULL AND lease_until IS NULL").run(row.id).changes;
      }
      for (const table of ['thread_reply_requests','conversation_reply_requests']) {
        db.prepare(`UPDATE ${table} SET status='cancelled',error_message=COALESCE(error_message||char(10),'')||?,updated_at=? WHERE task_id=? AND status IN ('queued','blocked','running')`).run(closureMessage,now,scoped.id);
      }
      for (const row of recoveryRows(db,scoped.id)) {
        const job = JSON.parse(row.value) as {state?:string};
        if (job.state === 'waiting' || job.state === 'queued') {
          db.prepare('UPDATE daemon_state SET value=?,updated_at=? WHERE key=?').run(JSON.stringify({...job,state:'stopped'}),now,row.key);
        }
      }
      db.prepare(`UPDATE format_repair_workitems SET status='closed',note=COALESCE(note||char(10),'')||?,updated_at=? WHERE task_id=? AND status IN ('pending','blocked')`).run(closureMessage,now,scoped.id);
      db.prepare(`UPDATE coordination_messages SET status='cancelled',error_message=COALESCE(error_message||char(10),'')||?,updated_at=? WHERE status IN ('accepted','queued','blocked')
        AND (child_task_id=? OR coordination_run_id IN (SELECT run_id FROM coordination_runs WHERE task_id=?))`).run(closureMessage,now,scoped.id,scoped.id);
      db.prepare("UPDATE coordination_runs SET state='cancelled',error_message=COALESCE(error_message||char(10),'')||? WHERE task_id=? AND state NOT IN ('completed','cancelled')").run(closureMessage,scoped.id);
      db.prepare("UPDATE reminder_calls SET status='released',updated_at=? WHERE task_id=? AND turn_id IS NULL AND status='reserved'").run(now,scoped.id);
      if (terminalTasks.has(scoped.status)) continue;
      const sourceRunId = latestRunId(db,scoped.id);
      db.prepare("UPDATE tasks SET status='CANCELLED',stop_generation=stop_generation+1,revision=revision+1 WHERE id=?").run(scoped.id);
      cancelledTaskIds.push(scoped.id);
      appendDomainEvent(db,{
        schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:scoped.project_id,conversationId:scoped.conversation_id,
        ...(scoped.conversation_thread_id == null ? {} : {threadId:scoped.conversation_thread_id}),taskId:scoped.id,
        ...(sourceRunId == null ? {} : {runId:sourceRunId}),kind:'task.closed',createdAt:now,
        payload:{status:'CANCELLED',previousStatus:scoped.status,stopGeneration:scoped.stop_generation+1,taskRevision:scoped.revision+1,sourceRunId,closedByTaskId:task.id},
      });
    }
    return {closed:true,taskId:task.id,status:'CANCELLED',stopGeneration:task.stop_generation+1,taskRevision:task.revision+1,
      sourceRunId:binding.sourceRunId,cancelledTaskIds,cancelledOutboxCount};
  }).immediate();
}
