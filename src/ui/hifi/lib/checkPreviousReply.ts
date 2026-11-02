import {sendCommand,type BridgeOutcome} from '../bridge';

export interface TaskContinuationBinding {
  taskId: string;
  expectedTaskRevision?: number;
  expectedStopGeneration?: number;
  sourceRunId?: string;
}
export interface TaskContinuationResult {enqueued: boolean; dispatchKey: string}
type SendContinuation = (commandId:string,method:string,params:Record<string,unknown>)=>Promise<BridgeOutcome<TaskContinuationResult>>;

/** Reuse the command identity after an uncertain transport; a rejected attempt can be retried. */
export function createTaskContinuation(send:SendContinuation) {
  const attempts=new Map<string,{commandId:string;pending?:Promise<BridgeOutcome<TaskContinuationResult>>}>();
  return (binding:TaskContinuationBinding):Promise<BridgeOutcome<TaskContinuationResult>>=>{
    const params={taskId:binding.taskId,...(binding.expectedTaskRevision!=null?{expectedTaskRevision:binding.expectedTaskRevision}:{}),
      ...(binding.expectedStopGeneration!=null?{expectedStopGeneration:binding.expectedStopGeneration}:{}),...(binding.sourceRunId?{sourceRunId:binding.sourceRunId}:{})};
    const key=JSON.stringify(params);
    let attempt=attempts.get(key);
    if(attempt?.pending)return attempt.pending;
    if(!attempt){attempt={commandId:crypto.randomUUID()};attempts.set(key,attempt);}
    const current=attempt;
    current.pending=Promise.resolve().then(()=>send(current.commandId,'task.continue',params)).then(result=>{
      if(result.status!=='unknown')attempts.delete(key);
      return result;
    }).finally(()=>{current.pending=undefined;});
    return current.pending;
  };
}
export const continueTask=createTaskContinuation(sendCommand);

export function previousReplyStillHeld(status:{unknownTurns:readonly {id:string;protectionReleased?:boolean}[];pendingRelease:readonly {turnId:string}[];heldLeases:readonly {owner_turn_id:string}[]},turnId:string):boolean {
  return status.unknownTurns.find(turn=>turn.id===turnId)?.protectionReleased!==true
    ||status.pendingRelease.some(item=>item.turnId===turnId)||status.heldLeases.some(item=>item.owner_turn_id===turnId);
}
