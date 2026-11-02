import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {readTaskExecutionStatus} from './executionStatus.ts';
import {roomActivityState,summarizeRoomActivity,type RoomActivityState,type RoomActivitySummary} from '../contracts/roomActivity.ts';

/** Independent of the currently mounted room page. Finished conversational
 * runs may leave their task ACTIVE; that is not evidence of a running model. */
export function readProjectRoomActivity(db:ZhongshuoDatabase,projectId:string):Record<string,RoomActivitySummary>{
  const rows=db.prepare(`SELECT t.id,t.room_id FROM tasks t WHERE t.project_id=? AND t.kind='room_task' AND t.parent_task_id IS NULL AND (
    t.status IN ('OPEN','ACTIVE','WAITING_USER','BLOCKED','REVIEW') OR EXISTS(SELECT 1 FROM workflow_runs r WHERE r.task_id=t.id AND r.status IN ('QUEUED','RUNNING','WAITING','STOPPING'))
    OR EXISTS(SELECT 1 FROM agent_turns a JOIN workflow_runs ar ON ar.id=a.run_id WHERE ar.task_id=t.id AND a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING','UNKNOWN')))`)
    .all(projectId) as Array<{id:string;room_id:string|null}>;
  const byRoom=new Map<string,Array<RoomActivityState|undefined>>();
  for(const row of rows){
    if(!row.room_id)continue;
    const status=readTaskExecutionStatus(db,row.id);
    if(!status)continue;
    const states=byRoom.get(row.room_id)??[];states.push(roomActivityState(status));byRoom.set(row.room_id,states);
  }
  return Object.fromEntries([...byRoom].map(([roomId,states])=>[roomId,summarizeRoomActivity(states)]));
}
