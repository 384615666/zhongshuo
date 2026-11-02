import {command} from '../bridge';
import {getState} from '../data/store';
import {refreshDms,refreshRooms,loadRoomPool,loadThread,loadDmHistory} from '../loader';
import type {TaskExecutionStatus} from '../../../contracts/executionStatus';
import type {TaskContinuationBinding} from './checkPreviousReply';

export const OPEN_RECOVERY_EVENT = 'zs:open-recovery';
export const RECOVERY_CHANGED_EVENT = 'zs:recovery-changed';
export function notifyRecoveryChanged():void {
  if(typeof window!=='undefined')window.dispatchEvent(new Event(RECOVERY_CHANGED_EVENT));
}
export interface RecoveryStatus {
  gateHeld:boolean;pendingDispatchCount:number;
  interruptedRuns:Array<{id:string;task_id:string;status:string}>;
  interruptedTasks?:Array<{taskId:string}>;
  unknownTurns:Array<{id:string;taskId:string;protectionReleased?:boolean}>;
  pendingRelease:Array<{turnId:string;taskId?:string}>;
  heldLeases:Array<{owner_turn_id:string}>;
  activeUndos:Array<{id:string;changeSetId:string;status:string}>;
}
export interface RecoveryTarget {
  turnId?: string;
  taskId?: string;
  runId?: string;
  projectId?: string;
  requestTaskId?: string;
}
export function requestRecoveryOpen(target?:RecoveryTarget):void {
  if(typeof window==='undefined')return;
  window.dispatchEvent(new CustomEvent(OPEN_RECOVERY_EVENT,{detail:{origin:'runtime',target}}));
}
interface RecoveryTaskFact {
  id:string;title:string;status:string;parent_task_id?:string|null;project_id?:string;
  revision?:number;stop_generation?:number;
}
export interface RecoveryTask {
  task:RecoveryTaskFact;
  binding:TaskContinuationBinding;
  executionStatus?:TaskExecutionStatus|null;
}
export function canContinueRecoveryTask(item:RecoveryTask):boolean {
  if(['DONE','CANCELLED'].includes(item.task.status))return false;
  if(item.executionStatus)return item.executionStatus.actions.some(action=>action.kind==='continue');
  return !['RUNNING','STOPPING','QUEUED','WAITING_FOR_PEER','WAITING_FOR_USER'].includes(item.executionStatus?.phase??'');
}
type ReadTask=(taskId:string)=>Promise<{task:RecoveryTaskFact;executionStatus?:TaskExecutionStatus|null}>;
/** Resolve each affected task to its actual root and combine sibling interruptions. */
export async function loadRecoveryTasks(ids:readonly string[],read:ReadTask=id=>command('task.get',{taskId:id})) {
  const reads=new Map<string,ReturnType<ReadTask>>();
  const get=(id:string)=>{let value=reads.get(id);if(!value){value=read(id);reads.set(id,value);}return value;};
  const result=await Promise.all([...new Set(ids)].map(async id=>{
    const seen=new Set<string>();
    for(let depth=0;depth<64;depth++){
      if(seen.has(id))throw Error('任务归属记录异常，请刷新后重试。');
      seen.add(id);
      const value=await get(id);
      if(value.task.id!==id)throw Error('返回的任务不匹配，请刷新后重试。');
      if(value.task.parent_task_id){id=value.task.parent_task_id;continue;}
      const continuation=value.executionStatus?.actions.find(action=>action.kind==='continue');
      return {task:value.task,executionStatus:value.executionStatus,binding:continuation?.binding??{taskId:id,
        ...(value.task.revision!=null?{expectedTaskRevision:value.task.revision}:{}),
        ...(value.task.stop_generation!=null?{expectedStopGeneration:value.task.stop_generation}:{})}} satisfies RecoveryTask;
    }
    throw Error('暂时无法读取任务归属，请刷新后重试。');
  }));
  return [...new Map(result.map(item=>[item.task.id,item])).values()];
}
export async function refreshRecoveryViews(projectId?:string):Promise<void> {
  const state=getState();
  const activeDm=typeof window!=='undefined'?window.location.hash.match(/^#\/dm\/([^?]+)/)?.[1]:undefined;
  await Promise.allSettled([refreshDms(projectId),refreshRooms(projectId),
    ...(state.ui.activeRoomId?[loadRoomPool(state.ui.activeRoomId)]:[]),
    ...(state.ui.activeThreadId?[loadThread(state.ui.activeThreadId)]:[]),
    ...(activeDm?[loadDmHistory(decodeURIComponent(activeDm))]:[])]);
}
