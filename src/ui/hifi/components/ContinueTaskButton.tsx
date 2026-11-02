import {useRef,useState} from 'react';
import {userFacingSystemText} from '../../../contracts/userFacingText';
import {continueTask,type TaskContinuationBinding} from '../lib/checkPreviousReply';
import {refreshRecoveryViews} from '../lib/recovery';
import {recordWrite} from '../data/store';

export function ContinueTaskButton({binding,projectId,className='btn sm',onContinued}:{binding:TaskContinuationBinding;projectId?:string;className?:string;onContinued?:()=>void}) {
  const active=useRef(false);
  const [busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState<string|null>(null);
  const submit=async()=>{
    if(active.current||done)return;
    active.current=true;setBusy(true);setError(null);
    try{
      const result=await continueTask(binding);
      if(result.status!=='ok')throw Error(result.status==='unknown'?`继续请求尚未收到回执，可重试。${result.error}`:result.error);
      recordWrite('task.continue','已提交继续任务');setDone(true);
      await refreshRecoveryViews(projectId);onContinued?.();
    }catch(reason){setError(userFacingSystemText(reason instanceof Error?reason.message:String(reason)));}
    finally{active.current=false;setBusy(false);}
  };
  return <span onClick={event=>event.stopPropagation()}>
    <button type="button" className={className} data-zs-continue-task={binding.taskId} disabled={busy||done} onClick={()=>void submit()}>{busy?'正在继续…':done?'已提交继续':'继续任务'}</button>
    {error?<span className="small warning" role="alert" style={{display:'block'}}>继续失败：{error}</span>:null}
  </span>;
}
