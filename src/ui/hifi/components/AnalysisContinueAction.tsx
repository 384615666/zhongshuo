import { userFacingSystemText } from '../../../contracts/userFacingText';
import {useRef,useState} from 'react';
import type {PreDispatchFailureProjection} from '../../../contracts/taskDetails';
import {sendCommand} from '../bridge';
import {loadRoomPool,refreshThreadTask} from '../loader';
import {toast} from '../data/store';

/** A fresh explicit intent on the existing request, with a frozen CAS binding. */
export function AnalysisContinueAction({failure,roomId}:{failure:PreDispatchFailureProjection|null|undefined;roomId:string}) {
  const [busy,setBusy]=useState(false);
  const pending=useRef<{key:string;commandId:string}|null>(null);
  const binding=failure?.recoveryBinding;
  if(!binding)return null;
  const continueAnalysis=async()=>{
    if(busy)return;
    const key=JSON.stringify(binding);
    if(pending.current?.key!==key)pending.current={key,commandId:crypto.randomUUID()};
    setBusy(true);
    try {
      const outcome=await sendCommand(pending.current.commandId,'task.redispatch',{taskId:binding.taskId,
        expectedTaskRevision:binding.expectedTaskRevision,expectedStopGeneration:binding.expectedStopGeneration,
        reason:'continue-original-after-preflight-failure'});
      if(outcome.status!=='ok'){
        if(outcome.status==='failed')pending.current=null;
        throw Error(outcome.error);
      }
      pending.current=null;
      toast('已按原请求继续','success');
      await Promise.allSettled([loadRoomPool(roomId),...(failure.threadId?[refreshThreadTask(failure.threadId)]:[])]);
    }catch(error){toast(`未确认继续结果：${userFacingSystemText((error as Error).message ?? '')}。可同号重试。`,'error');}
    finally{setBusy(false);}
  };
  return <div className="small" onClick={event=>event.stopPropagation()} data-zs-analysis-recovery="1">
    <button type="button" className="btn sm" disabled={busy} onClick={()=>void continueAnalysis()}>{busy?'正在提交…':'按原请求继续'}</button>
  </div>;
}
