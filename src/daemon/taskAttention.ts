import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {readTaskExecutionStatus} from './executionStatus.ts';

type AttentionTask={id:string;parent_task_id:string|null;project_id:string;conversation_id:string;status:string};
/** Read-only selection. Old failed children stay in history; current failures
 * and unresolved execution/protection remain reachable from attention. */
export function currentAttentionTaskIds(db:ZhongshuoDatabase,ids:readonly string[]):Set<string>{
  const candidates=new Set(ids),selected=new Set<string>();
  const tasks=new Map<string,AttentionTask|undefined>();
  const taskOf=(id:string)=>{
    if(!tasks.has(id))tasks.set(id,db.prepare('SELECT id,parent_task_id,project_id,conversation_id,status FROM tasks WHERE id=?').get(id) as AttentionTask|undefined);
    return tasks.get(id);
  };
  for(const id of ids){
    const task=taskOf(id);if(!task)continue;
    const parents:AttentionTask[]=[],seen=new Set([id]);let cursor=task,obsolete=false;
    while(cursor.parent_task_id){
      const parent=taskOf(cursor.parent_task_id);
      if(!parent||seen.has(parent.id)||parent.project_id!==task.project_id||parent.conversation_id!==task.conversation_id)break;
      seen.add(parent.id);parents.push(parent);
      if(['DONE','CANCELLED'].includes(parent.status))obsolete=true;
      const plan=db.prepare('SELECT run_id FROM coordination_steps WHERE child_task_id=?').get(cursor.id) as {run_id:string}|undefined;
      if(plan){
        const latest=db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(parent.id) as {id:string}|undefined;
        if(latest&&!db.prepare(`SELECT 1 FROM coordination_runs c WHERE c.run_id=? AND c.task_id=? AND
          (c.run_id=? OR c.integration_run_id=? OR EXISTS(SELECT 1 FROM coordination_integration_attempts a WHERE a.coordination_run_id=c.run_id AND a.execution_run_id=?))`)
          .get(plan.run_id,parent.id,latest.id,latest.id,latest.id))obsolete=true;
      }
      cursor=parent;
    }
    if(obsolete){
      const actual=readTaskExecutionStatus(db,id);
      const evidence=actual?.evidence;
      if(!actual||(!evidence?.recovery&&!evidence?.unknownTurnIds.length&&!evidence?.activeRunIds.length
        &&!evidence?.outbox&&!actual.actualPerformingMembers.length))continue;
    }else if(parents.some(parent=>candidates.has(parent.id)))continue;
    selected.add(id);
  }
  return selected;
}
