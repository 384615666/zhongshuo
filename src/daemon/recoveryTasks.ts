import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {readTaskExecutionStatus} from './executionStatus.ts';

/** Use the same execution facts as the conversation banner. Released protection
 * and a consumed queue item do not, by themselves, finish the original task. */
export function readInterruptedTasks(db:ZhongshuoDatabase,viewerId:string):Array<{taskId:string}>{
  const roots=db.prepare(`SELECT t.id FROM tasks t JOIN projects p ON p.id=t.project_id
    JOIN conversations c ON c.id=t.conversation_id
    WHERE t.parent_task_id IS NULL AND t.status NOT IN ('DONE','CANCELLED') AND p.status='active'
      AND (c.kind!='dm' OR EXISTS(SELECT 1 FROM dm_participants d WHERE d.conversation_id=c.id
        AND d.principal_type='human' AND d.principal_id=?)) ORDER BY t.rowid`).all(viewerId) as {id:string}[];
  return roots.filter(task=>readTaskExecutionStatus(db,task.id,{includeActions:false})?.phase==='UNKNOWN')
    .map(task=>({taskId:task.id}));
}
