import {useCallback,useEffect,useRef,useState} from 'react';
import {userFacingSystemText} from '../../../contracts/userFacingText';
import {Icon} from './Icon';
import {command} from '../bridge';
import {toast} from '../shell';
import {recordWrite} from '../data/store';
import {openExternalDeepLink} from '../loader';
import {previousReplyStillHeld} from '../lib/checkPreviousReply';
import {loadRecoveryTasks,type RecoveryTask,type RecoveryTarget} from '../lib/recovery';
import {ContinueTaskButton} from './ContinueTaskButton';

interface RecoveryStatus {
  gateHeld:boolean;pendingDispatchCount:number;
  interruptedRuns:Array<{id:string;task_id:string;status:string}>;
  unknownTurns:Array<{id:string;taskId:string;protectionReleased?:boolean}>;
  pendingRelease:Array<{turnId:string;taskId?:string}>;
  heldLeases:Array<{owner_turn_id:string}>;
  activeUndos:Array<{id:string;changeSetId:string;status:string}>;
}
/** Recovery offers the original tasks directly; the backend owns continuation. */
export function RecoveryPanel({onClose,target}:{onClose:()=>void;origin?:'startup'|'runtime'|null;target?:RecoveryTarget}) {
  const [data,setData]=useState<RecoveryStatus|null>(null),[tasks,setTasks]=useState<RecoveryTask[]>([]);
  const [error,setError]=useState<string|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState<string|null>(null);
  const [locateError,setLocateError]=useState<string|null>(null),[undoResult,setUndoResult]=useState<{ok:boolean;message:string}|null>(null);
  const generation=useRef(0),actionBusy=useRef(false),focused=useRef<HTMLDivElement|null>(null);
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
  useEffect(()=>{focused.current?.scrollIntoView({block:'nearest'});},[tasks]);
  const locate=(taskId:string)=>{
    setLocateError(null);
    void openExternalDeepLink(`#task=${taskId}`).then(onClose).catch(reason=>{
      const message=`定位失败：${userFacingSystemText(reason instanceof Error?reason.message:String(reason))}`;setLocateError(message);toast(message,'error');
    });
  };
  const resumeQueue=async()=>{
    if(actionBusy.current)return;actionBusy.current=true;setBusy('queue');
    try{await command('dispatch.resume',{confirm:true});recordWrite('dispatch.resume','继续处理排队消息');await reload();}
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
    finally{await reload();actionBusy.current=false;setBusy(null);}
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
        {data?<div data-zs-recovery-summary="1">
          {!loading&&!tasks.length&&!data.gateHeld&&!data.activeUndos.length&&!error?<div className="panel info">没有需要恢复的任务。可以正常继续使用。</div>:null}
          {tasks.map((item,index)=>{
            const phase=item.executionStatus?.phase;
            const ongoing=['RUNNING','STOPPING','QUEUED','WAITING_FOR_PEER','WAITING_FOR_USER'].includes(phase??'');
            const done=item.task.status==='DONE';
            const isFocused=target?.requestTaskId===item.task.id||target?.taskId===item.task.id;
            return <div key={item.task.id} ref={isFocused?focused:undefined} className="card tight" data-zs-recovery-task={item.task.id} data-zs-recovery-focused={isFocused?'1':undefined} style={{marginTop:index?8:0}}>
              <strong>{item.task.title}</strong>
              <div className="small" style={{marginTop:5}}>{done?'任务已完成，已有结果可查看。':ongoing?phase==='STOPPING'?'任务正在停止。':'任务已在处理中。':'已有回复和文件保留，可以继续任务。'}</div>
              <div className="row tight wrap" style={{marginTop:8}}>
                {!ongoing&&!done?<ContinueTaskButton key={JSON.stringify(item.binding)} binding={item.binding} projectId={item.task.project_id} onContinued={()=>void reload()}/>:null}
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
