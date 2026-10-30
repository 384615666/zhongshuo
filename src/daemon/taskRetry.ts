import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {assessTaskRedispatchReadiness} from '../persistence/stores/recoveryGuard.ts';
import {isRetryRunStatus,type FailedTaskRecoveryBinding} from '../contracts/taskRecovery.ts';

/** Shared action eligibility for task details and compact room/thread headers. */
export function readFailedTaskRetry(db:ZhongshuoDatabase,taskId:string):{
  available:boolean;pending:boolean;blockReason:string|null;formatRepair?:boolean;binding?:FailedTaskRecoveryBinding;
}{
  const task=db.prepare(`SELECT t.status,t.revision,t.stop_generation,p.status project_status,c.archived_at conversation_archived,
    room.archived_at room_archived,wr.id run_id,wr.status run_status,
    (SELECT stop_generation_snapshot FROM agent_turns WHERE run_id=wr.id ORDER BY rowid DESC LIMIT 1) generation
    FROM tasks t JOIN projects p ON p.id=t.project_id JOIN conversations c ON c.id=t.conversation_id
    LEFT JOIN rooms room ON room.id=t.room_id
    LEFT JOIN workflow_runs wr ON wr.rowid=(SELECT rowid FROM workflow_runs WHERE task_id=t.id ORDER BY rowid DESC LIMIT 1)
    WHERE t.id=?`).get(taskId) as {status:string;revision:number;stop_generation:number;project_status:string;conversation_archived:number|null;room_archived:number|null;run_id:string|null;run_status:string|null;generation:number|null}|undefined;
  const run=task?.run_id&&task.run_status?{id:task.run_id,status:task.run_status}:undefined;
  const generation=task?.generation;
  if(!task||!run||!isRetryRunStatus(run.status)||!['ACTIVE','BLOCKED'].includes(task.status)
    ||(generation==null?task.stop_generation!==0:generation!==task.stop_generation))return{available:false,pending:false,blockReason:null};
  const formatRepair=run.status==='FAILED'&&db.prepare(`SELECT 1 FROM agent_turns a WHERE a.run_id=? AND a.status='FAILED'
    AND EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='turn.outputInvalid')
    AND NOT EXISTS(SELECT 1 FROM format_repair_workitems f WHERE f.source_turn_id=a.id OR f.consumed_turn_id=a.id) LIMIT 1`).get(run.id)!=null;
  const pending=db.prepare(`SELECT 1 FROM outbox WHERE dispatch_key=? AND status IN ('pending','leased')
    UNION ALL SELECT 1 FROM format_repair_workitems f JOIN outbox o ON o.dispatch_key=f.target_dispatch_key
    WHERE f.task_id=? AND f.status='pending' AND o.status IN ('pending','leased') LIMIT 1`).get(`task:${taskId}:redispatch:${run.id}`,taskId)!=null;
  const scopeBlock=task.project_status!=='active'?'项目已归档或不可用；先恢复项目。'
    :task.conversation_archived!=null?'会话已归档；先恢复会话。':task.room_archived!=null?'房间已归档；先恢复房间。':null;
  const blockReason=scopeBlock??(!pending?assessTaskRedispatchReadiness(db,taskId)?.message??null:null);
  const available=!pending&&blockReason==null;
  return{available,pending,blockReason,...(formatRepair?{formatRepair:true}:{}),...(available?{binding:{method:'task.redispatch',taskId,
    sourceRunId:run.id,expectedTaskRevision:task.revision,expectedStopGeneration:task.stop_generation,expectedRunStatus:run.status,
    ...(formatRepair?{formatRepair:true,useCurrentExecutionSnapshot:true}:{})}}:{})};
}
