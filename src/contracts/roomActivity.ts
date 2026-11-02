import type {TaskExecutionStatus} from './executionStatus.ts';

export const ROOM_ACTIVITY_RANK=['BLOCKED','WAITING_USER','REVIEW','STOPPING','ACTIVE','WAITING_PEER','QUEUED'] as const;
export type RoomActivityState=(typeof ROOM_ACTIVITY_RANK)[number];
export interface RoomActivitySummary {state?:RoomActivityState;counts:Array<{state:RoomActivityState;count:number}>;total:number}
export function roomActivityState(status:TaskExecutionStatus):RoomActivityState|undefined{
  switch(status.phase){
    case 'RUNNING':return 'ACTIVE';
    case 'STOPPING':return 'STOPPING';
    case 'QUEUED':case 'ADMISSION_WAITING':return 'QUEUED';
    case 'WAITING_FOR_PEER':return 'WAITING_PEER';
    case 'WAITING_FOR_USER':return status.waitingForUser?.kind==='review'?'REVIEW':'WAITING_USER';
    case 'UNKNOWN':case 'NOT_STARTED_FAILED':case 'FAILED':return 'BLOCKED';
    case 'COMPLETED':return status.waitingForUser?.kind==='review'||status.evidence.taskStatus==='REVIEW'?'REVIEW':undefined;
    default:return undefined;
  }
}
export function summarizeRoomActivity(states:Array<RoomActivityState|undefined>):RoomActivitySummary{
  const counts=ROOM_ACTIVITY_RANK.map(state=>({state,count:states.filter(item=>item===state).length})).filter(item=>item.count>0);
  return {state:counts[0]?.state,counts,total:counts.reduce((sum,item)=>sum+item.count,0)};
}
