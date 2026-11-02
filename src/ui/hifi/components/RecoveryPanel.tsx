import {useCallback,useEffect,useRef,useState} from 'react';
import {userFacingSystemText} from '../../../contracts/userFacingText';
import {Icon} from './Icon';
import {command} from '../bridge';
import {toast} from '../shell';
import {recordWrite} from '../data/store';
import {openExternalDeepLink} from '../loader';
import {continueTask,previousReplyStillHeld} from '../lib/checkPreviousReply';
import {canContinueRecoveryTask,loadRecoveryTasks,notifyRecoveryChanged,refreshRecoveryViews,type RecoveryStatus,type RecoveryTask,type RecoveryTarget} from '../lib/recovery';
import {ContinueTaskButton} from './ContinueTaskButton';

/** Recovery offers the original tasks directly; the backend owns continuation. */
export function RecoveryPanel({onClose,target}:{onClose:()=>void;origin?:'startup'|'runtime'|null;target?:RecoveryTarget}) {
  const [data,setData]=useState<RecoveryStatus|null>(null),[tasks,setTasks]=useState<RecoveryTask[]>([]);
  const [error,setError]=useState<string|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null);
  const [locateError,setLocateError]=useState<string|null>(null),[undoResult,setUndoResult]=useState<{ok:boolean;message:string}|null>(null);
  const [batchResult,setBatchResult]=useState<{completed:number;failures:Array<{label:string;message:string}>}|null>(null);
  const generation=useRef(0),actionBusy=useRef(false),focused=useRef<HTMLDivElement|null>(null),mounted=useRef(true);
  const reload=useCallback(async()=>{
    const gen=++generation.current;setLoading(true);setError(null);
    try{
      const value=await command<RecoveryStatus>('recovery.status',{});
      if(gen!==generation.current)return;
      setData(value);
      const ids=[...value.unknownTurns.filter(turn=>previousReplyStillHeld(value,turn.id)).map(turn=>turn.taskId),
        ...value.interruptedRuns.map(run=>run.task_id),...value.pendingRelease.map(item=>item.taskId??value.unknownTurns.find(turn=>turn.id===item.turnId)?.taskId),
        target?.requestTaskId??target?.taskId].filter((id):id is string=>!!id);
      const list=await loadRecoveryTasks(ids);
      if(gen===generation.current)setTasks(list);
    }catch(reason){if(gen===generation.current)setError(userFacingSystemText(reason instanceof Error?reason.message:String(reason)));}
    finally{if(gen===generation.current)setLoading(false);}
  },[target?.taskId,target?.requestTaskId]);
  useEffect(()=>{void reload();return()=>{generation.current++;};},[reload]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{focused.current?.scrollIntoView({block:'nearest'});},[tasks]);
  const locate=(taskId:string)=>{
    setLocateError(null);
    void openExternalDeepLink(`#task=${taskId}`).then(onClose).catch(reason=>{
      const message=`定位失败：${userFacingSystemText(reason instanceof Error?reason.message:String(reason))}`;setLocateError(message);toast(message,'error');
    });
  };
  const resumeQueue=async()=>{
    if(actionBusy.current)return;actionBusy.current=true;setBusy('queue');
    try{await command('dispatch.resume',{confirm:true});recordWrite('dispatch.resume','继续处理排队消息');notifyRecoveryChanged();await reload();}
    catch(reason){setError(userFacingSystemText(reason instanceof Error?reason.message:String(reason)));}
    finally{actionBusy.current=false;setBusy(null);}
  };
  const continueUndo=async(undo:RecoveryStatus['activeUndos'][number])=>{
    if(actionBusy.current)return;actionBusy.current=true;setBusy(undo.id);setUndoResult(null);
    try{
      const result=await command<{status:'succeeded'|'failed'|'conflict';manualPaths:string[]}>('changeset.undo',{changeSetId:undo.changeSetId});
      recordWrite('changeset.undo',`继续撤销：${result.status}`);
      const paths=result.manualPaths.length?` 待处理文件：${result.manualPaths.join('、')}`:'';
      setUndoResult(result.status==='succeeded'?{ok:true,message:'撤销已完成。文件状态已重新检查，不会自动重发原任务。'}:
        {ok:false,message:`${result.status==='conflict'?'撤销遇到冲突，冲突文件未被覆盖。请先核对文件版本。':'撤销尚未完成，已完成的步骤保留。请核对文件版本后重试。'}${paths}`});
    }catch(reason){setUndoResult({ok:false,message:`撤销未完成：${userFacingSystemText(reason instanceof Error?reason.message:String(reason))}。可刷新后重试。`});}
    finally{notifyRecoveryChanged();await reload();actionBusy.current=false;setBusy(null);}
  };
  const continuable=tasks.filter(canContinueRecoveryTask);
  const actionCount=continuable.length+(data?.gateHeld?1:0)+(data?.activeUndos.length??0);
  const processAll=async()=>{
    if(actionBusy.current||loading||error||!data||!actionCount)return;
    actionBusy.current=true;setBusy('all');setBatchResult(null);setUndoResult(null);
    const failures:Array<{label:string;message:string}>=[];
    let completed=0;
    const perform=async(label:string,action:()=>Promise<void>)=>{
      try{await action();completed++;}
      catch(reason){failures.push({label,message:userFacingSystemText(reason instanceof Error?reason.message:String(reason))});}
    };
    try{
      // Finish interrupted file operations before starting tasks that may edit them.
      for(const [index,undo] of data.activeUndos.entries())await perform(`撤销记录 ${index+1}`,async()=>{
        const result=await command<{status:string;manualPaths:string[]}>('changeset.undo',{changeSetId:undo.changeSetId});
        recordWrite('changeset.undo',`批量处理撤销：${result.status}`);
        if(result.status!=='succeeded')throw Error(`撤销${result.status==='conflict'?'遇到文件冲突':'尚未完成'}，请核对文件后重试。${result.manualPaths.length?`待处理文件：${result.manualPaths.join('、')}`:''}`);
      });
      if(!failures.length){
        for(const item of continuable)await perform(item.task.title,async()=>{
          const result=await continueTask(item.binding);
          if(result.status!=='ok')throw Error(result.status==='unknown'?`继续请求尚未收到回执，可重试。${result.error}`:result.error);
          recordWrite('task.continue',`批量继续：${item.task.title}`);
        });
        if(data.gateHeld)await perform('排队消息',async()=>{
          await command('dispatch.resume',{confirm:true});recordWrite('dispatch.resume','批量继续排队消息');
        });
      }
      if(mounted.current)setBatchResult({completed,failures});
      notifyRecoveryChanged();
      await refreshRecoveryViews();
      if(failures.length){if(mounted.current)await reload();else toast('部分恢复事项未处理完成，可从恢复任务中重试。','warn');}
      else{toast('已处理恢复事项，任务会在后台继续。','success');if(mounted.current)onClose();}
    }finally{actionBusy.current=false;if(mounted.current)setBusy(null);}
  };
  return <div className="scrim center" onClick={onClose} style={{zIndex:92}} data-zs-recovery="hifi">
    <div className="modal lg" onClick={event=>event.stopPropagation()} role="dialog" aria-modal="true" aria-label="恢复任务" style={{maxHeight:'78vh',display:'flex',flexDirection:'column',width:'min(800px,94vw)'}}>
      <div className="row tight wrap" style={{padding:'12px 16px',borderBottom:'1px solid var(--border)'}}>
        <Icon name="play" size={15}/><strong>恢复任务</strong><span style={{flex:1}}/>
        <button className="btn ghost sm" disabled={loading||busy!=null} onClick={()=>void reload()}>刷新</button>
        <button className="btn ghost sm" onClick={onClose}>关闭</button>
      </div>
      <div className="page-stack" style={{padding:'12px 16px',overflow:'auto'}}>
        {error?<div className="panel warning" role="alert">读取失败：{error}</div>:null}
        {locateError?<div className="panel warning" role="alert">{locateError}</div>:null}
        {loading?<div className="small muted">正在读取任务…</div>:null}
        {data&&actionCount>0?<div className="panel info" data-zs-recovery-batch="1">
          <div className="row tight wrap"><strong>共 {actionCount} 项待处理</strong><span style={{flex:1}}/>
            <button className="btn primary sm" disabled={loading||busy!=null||!!error} onClick={()=>void processAll()} data-zs-recovery-process-all="1">{busy==='all'?'正在处理…':'一键继续'}</button>
          </div>
          <div className="small muted" style={{marginTop:6}}>{data.activeUndos.length?'继续任务、排队消息，并完成未结束的撤销。':'继续所有待恢复任务和排队消息。'}提交后在后台处理，无需逐条操作。</div>
        </div>:null}
        {batchResult?.failures.length?<div className="panel warning" role="alert" data-zs-recovery-batch-result="1">
          <strong>{batchResult.completed?`已处理 ${batchResult.completed} 项。`:''}以下事项需要处理后重试：</strong>
          {batchResult.failures.map((failure,index)=><div key={index} className="small" style={{marginTop:5}}>{failure.label}：{failure.message}</div>)}
        </div>:null}
        {data?<div data-zs-recovery-summary="1">
          {!loading&&!tasks.length&&!data.gateHeld&&!data.activeUndos.length&&!error?<div className="panel info">没有需要恢复的任务。可以正常继续使用。</div>:null}
          {tasks.map((item,index)=>{
            const phase=item.executionStatus?.phase;
            const canContinue=canContinueRecoveryTask(item);
            const ongoing=!canContinue&&['RUNNING','STOPPING','QUEUED','WAITING_FOR_PEER','WAITING_FOR_USER'].includes(phase??'');
            const done=['DONE','CANCELLED'].includes(item.task.status);
            const isFocused=target?.requestTaskId===item.task.id||target?.taskId===item.task.id;
            return <div key={item.task.id} ref={isFocused?focused:undefined} className="card tight" data-zs-recovery-task={item.task.id} data-zs-recovery-focused={isFocused?'1':undefined} style={{marginTop:index?8:0}}>
              <strong>{item.task.title}</strong>
              <div className="small" style={{marginTop:5}}>{done?item.task.status==='CANCELLED'?'任务已取消，已有记录可查看。':'任务已完成，已有结果可查看。':ongoing?phase==='STOPPING'?'任务正在停止。':'任务已在处理中。':'已有回复和文件保留，可以继续任务。'}</div>
              <div className="row tight wrap" style={{marginTop:8}}>
                {canContinue?<ContinueTaskButton key={JSON.stringify(item.binding)} binding={item.binding} projectId={item.task.project_id} disabled={busy!=null} canSubmit={()=>!actionBusy.current} onBusyChange={value=>{actionBusy.current=value;setBusy(value?item.task.id:null);}} onContinued={()=>void reload()}/>:null}
                <button className="btn ghost sm" onClick={()=>locate(item.task.id)}>查看任务</button>
              </div>
            </div>;
          })}
          {data.gateHeld?<div className="panel info" style={{marginTop:8}}><div>有 {data.pendingDispatchCount} 条消息等待继续处理。</div><button className="btn sm" disabled={busy!=null} onClick={()=>void resumeQueue()}>{busy==='queue'?'正在继续…':'继续处理排队消息'}</button></div>:
            data.pendingDispatchCount>0?<div className="small muted" style={{marginTop:8}}>有 {data.pendingDispatchCount} 条消息正在排队。</div>:null}
        </div>:null}
        {undoResult?<div className={`panel ${undoResult.ok?'info':'warning'}`} role={undoResult.ok?'status':'alert'} data-zs-undo-result="1">{undoResult.message}</div>:null}
        {data?.activeUndos.length?<div className="panel info" data-zs-undo-records="1"><strong>未完成的撤销</strong>
          {data.activeUndos.map((undo,index)=><div key={undo.id} className="row tight wrap" style={{marginTop:8}}><span>撤销记录 {index+1} · {undo.status==='failed'?'上次未完成':'尚未完成'}</span><button className="btn sm" disabled={busy!=null} data-zs-continue-undo={undo.id} onClick={()=>void continueUndo(undo)}>{busy===undo.id?'正在撤销…':'继续撤销'}</button></div>)}
        </div>:null}
      </div>
    </div>
  </div>;
}
