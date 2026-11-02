import {sendCommand,type BridgeOutcome} from '../bridge';
import {userFacingSystemText} from '../../../contracts/userFacingText';

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

/** Command diagnostics stay with the backend; task controls explain the next
 * useful step without exposing run IDs, queue keys or protocol terminology. */
export function taskContinuationFailure(result:Exclude<BridgeOutcome<unknown>,{status:'ok'}>):string{
  if(result.status==='unknown')return '继续请求尚未收到回执，请稍后重试。';
  const messages:Record<string,string>={
    STALE_REVISION:'任务状态已变化，已重新读取。请查看最新进展后再试。',
    IDEMPOTENCY_CONFLICT:'已有继续请求在处理中，请稍候查看任务进展。',
    WORKER_STILL_RUNNING:'任务仍在执行，请稍后继续。',
    RECONCILE_REQUIRED:'任务暂时无法继续，请刷新后查看执行状态。已有回复和文件会保留。',
    RESOURCE_NOT_FOUND:'未找到这项任务，请刷新后重试。',
    FORBIDDEN:'当前无法操作这项任务，请确认项目与会话是否可用。',
    PERMISSION_DENIED:'当前无法操作这项任务，请确认项目与会话是否可用。',
  };
  if(messages[result.code])return messages[result.code]!;
  const text=userFacingSystemText(result.error);
  return /\b(?:run|turn|outbox|dispatchKey|sourceRunId|STALE_REVISION)\b|(?:run|turn)_[\w-]+|恢复派发|幂等|新意图|protection_state/i.test(text)
    ?'暂时无法继续任务，请刷新后重试。已有回复和文件会保留。':text;
}

export function previousReplyStillHeld(status:{unknownTurns:readonly {id:string;protectionReleased?:boolean}[];pendingRelease:readonly {turnId:string}[];heldLeases:readonly {owner_turn_id:string}[]},turnId:string):boolean {
  return status.unknownTurns.find(turn=>turn.id===turnId)?.protectionReleased!==true
    ||status.pendingRelease.some(item=>item.turnId===turnId)||status.heldLeases.some(item=>item.owner_turn_id===turnId);
}
