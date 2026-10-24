import {useRef,useState} from 'react';
import type {TaskExecutionAction,TaskExecutionStatus} from '../../../contracts/executionStatus.ts';
import {ExecutionStatus} from './ExecutionStatus';
import {sendCommand} from '../bridge';
import {loadRoomPool,refreshDms,refreshThreadTask,openExternalDeepLink} from '../loader';
import {requestRecoveryOpen} from '../lib/recovery';
import {navigate} from '../lib/router';

/** Bind the shared factual view to existing local actions; rendering never dispatches. */
export function TaskExecutionStatusView({status,density='compact'}:{status:TaskExecutionStatus|null|undefined;density?:'compact'|'detail'}){
  const [error,setError]=useState<string|null>(null);
  const pending=useRef<{key:string;commandId:string}|null>(null);
  const busy=useRef(false);
  if(!status)return null;
  const handle=async(action:TaskExecutionAction)=>{
    if(busy.current)return;
    busy.current=true;setError(null);
    try{
      if(action.kind==='recover'){requestRecoveryOpen();return;}
      if(action.kind==='retry'){
        const key=JSON.stringify(action.binding);
        if(pending.current?.key!==key)pending.current={key,commandId:crypto.randomUUID()};
        const result=await sendCommand(pending.current.commandId,'task.redispatch',{
          taskId:action.binding.taskId,expectedTaskRevision:action.binding.expectedTaskRevision,
          expectedStopGeneration:action.binding.expectedStopGeneration,analysisOnly:true,reason:'execution-status-read-only-continue',
        });
        if(result.status!=='ok'){if(result.status==='failed')pending.current=null;throw Error(result.error);}
        pending.current=null;
        await Promise.allSettled([...(status.scope.roomId?[loadRoomPool(status.scope.roomId)]:[refreshDms(status.scope.projectId)]),...(status.scope.threadId?[refreshThreadTask(status.scope.threadId)]:[])]);
        return;
      }
      const target=action.target;
      if(target.kind==='recovery')requestRecoveryOpen();
      else if(target.kind==='thread')navigate(`/thread/${target.id}?tab=run`);
      else if(target.kind==='room')await openExternalDeepLink(`#task=${status.taskId}`);
      else await openExternalDeepLink(`#${target.kind==='delivery'?'delivery':target.kind==='dm'?'dm':'task'}=${target.id}`);
    }catch(reason){setError((reason as Error).message);}
    finally{busy.current=false;}
  };
  return <div>
    <ExecutionStatus status={status} density={density} onAction={action=>void handle(action)}/>
    {status.phase!=='COMPLETED'&&status.lastBusinessActivity?<div className="small faint" title={status.lastBusinessActivity.summary}>最近活动：{new Date(status.lastBusinessActivity.at).toLocaleTimeString('zh-CN')}</div>:null}
    {error?<div className="small warning" role="alert">{error}</div>:null}
  </div>;
}
