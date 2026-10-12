import { useEffect, useRef, useState } from 'react';
import type { ConversationTaskPage } from '../../../contracts/conversationTasks.ts';
import type { TaskDetailsResult } from '../../../contracts/taskDetails.ts';
import { command } from '../bridge';
import { fullTime } from '../lib/format';
import { Modal, Select, TaskStatusTag } from './ui';
import { ActualMembers, DeliveryHistoryFacts, DetailReadState, RunExtraFacts, TaskEventFacts, TaskExtraFacts, useTaskDetails } from './TaskDetailsFacts';

const pending=new Map<string,Promise<ConversationTaskPage>>();
function readPage(projectId:string,conversationId:string,beforeTaskId?:string){
  const key=JSON.stringify([projectId,conversationId,beforeTaskId]);const old=pending.get(key);if(old)return old;
  const promise=command<ConversationTaskPage>('conversation.tasks',{projectId,conversationId,...(beforeTaskId?{beforeTaskId}:{})}).finally(()=>{if(pending.get(key)===promise)pending.delete(key);});pending.set(key,promise);return promise;
}

/** A bounded reader in the existing modal; conversation messages/draft/preview remain mounted. */
export function DmTaskRecords({projectId,conversationId,onClose,onRetry,retryBusy=false,acceptedRetry}:{projectId:string;conversationId:string;onClose:()=>void;onRetry?:(detail:TaskDetailsResult)=>Promise<void>;retryBusy?:boolean;acceptedRetry?:string|null}){
  const key=JSON.stringify([projectId,conversationId]);
  const [page,setPage]=useState<{key:string;data:ConversationTaskPage|null;before?:string;error:string|null;loading:boolean;at:number|null}>({key:'',data:null,error:null,loading:false,at:null});
  const [chosen,setChosen]=useState<{key:string;id:string}|null>(null);
  const generation=useRef(0);const trigger=useRef<((before?:string|null)=>void)|null>(null);
  useEffect(()=>{
    let alive=true;let busy=false;let before:string|undefined;let wanted:string|undefined;let reread=false;
    const visible=()=>document.visibilityState!=='hidden'&&!document.body.classList.contains('legacy-on');
    const load=(cursor:string|null|undefined=wanted)=>{if(!alive||!visible())return;const desired=cursor===null?undefined:cursor;if(busy){if(wanted!==desired)generation.current++;wanted=desired;reread=true;return;}wanted=desired;busy=true;reread=false;const id=++generation.current;
      setPage(old=>({key,data:old.key===key?old.data:null,before:old.key===key?old.before:undefined,error:old.key===key?old.error:null,at:old.key===key?old.at:null,loading:true}));
      void readPage(projectId,conversationId,desired).then(data=>{if(alive&&id===generation.current&&visible()){if(data.conversationId!==conversationId){setPage(old=>({...old,error:'任务列表回执不属于当前私信',loading:false}));return;}before=desired;setPage({key,data,before:desired,error:null,loading:false,at:Date.now()});setChosen(old=>old?.key===key?old:data.items[0]?{key,id:data.items[0].id}:null);}},(e:unknown)=>{if(alive&&id===generation.current&&visible())setPage(old=>({...old,error:e instanceof Error?e.message:String(e),loading:false}));}).finally(()=>{busy=false;if(alive&&reread&&visible())load();});};
    trigger.current=load;
    const visibility=()=>{if(visible())load();else{generation.current++;reread=true;}};
    document.addEventListener('visibilitychange',visibility);
    let wasVisible=visible();const observer=new MutationObserver(()=>{const now=visible();if(now!==wasVisible){wasVisible=now;visibility();}});observer.observe(document.body,{attributes:true,attributeFilter:['class']});
    const timer=window.setInterval(()=>{if(!busy&&before===undefined)load();},5000);load();
    return()=>{alive=false;generation.current++;trigger.current=null;window.clearInterval(timer);observer.disconnect();document.removeEventListener('visibilitychange',visibility);};
  },[key,projectId,conversationId]);
  const current=page.key===key?page:null;const taskId=chosen?.key===key?chosen.id:undefined;
  const row=current?.data?.items.find(x=>x.id===taskId);
  const options=current?.data?.items.map(t=>({value:t.id,label:t.title}))??[];
  if(taskId&&!options.some(o=>o.value===taskId))options.unshift({value:taskId,label:'继续查看当前任务（本页之外）'});
  return <Modal title="私信任务记录" subtitle="读取当前会话的任务、运行和版本；继续失败运行仍沿用正式快照合同。" size="lg" onClose={onClose}>
    <div data-zs-dm-task-records="1" className="thread-details" style={{height:'min(65vh,680px)',minHeight:240}}>
      <div className="row tight wrap" style={{padding:'8px 0'}}>
        <Select value={taskId??''} options={options} ariaLabel="选择私信任务" onChange={id=>setChosen({key,id})}/>
        {row?<TaskStatusTag status={row.status as Parameters<typeof TaskStatusTag>[0]['status']}/>:null}
        {current?.before?<button className="btn ghost sm" disabled={current.loading} onClick={()=>trigger.current?.(null)}>返回最近任务</button>:null}
        {current?.data?.nextCursor?<button className="btn ghost sm" disabled={current.loading} onClick={()=>trigger.current?.(current.data!.nextCursor!)}>加载更早任务</button>:null}
        <button className="btn ghost sm" disabled={current?.loading} onClick={()=>trigger.current?.()}>刷新任务列表</button>
      </div>
      {current?.at?<span className="faint small">任务列表更新于 {fullTime(current.at)} · 每页最多20项</span>:null}
      {current?.error?<div className="panel warning">任务列表读取失败：{current.error}；{current.data?'保留本页':'尚未取得快照'}，可刷新重试。</div>:null}
      {current?.loading?<span className="faint small">正在读取任务列表…</span>:null}
      {current?.data?.items.length===0?<div className="panel info">{current.before?'本页没有更早任务；其他窗口保留。':'本次确认此会话尚无正式任务；仅记录消息不创建任务。'}</div>:null}
      {taskId?<DmTaskRecord key={`${key}:${taskId}`} projectId={projectId} conversationId={conversationId} taskId={taskId} revision={row?.revision} runStatus={row?.latestRun?.status} onRetry={onRetry} retryBusy={retryBusy} acceptedRetry={acceptedRetry}/>:null}
    </div>
  </Modal>;
}
function DmTaskRecord({projectId,conversationId,taskId,revision,runStatus,onRetry,retryBusy,acceptedRetry}:{projectId:string;conversationId:string;taskId:string;revision?:number;runStatus?:string;onRetry?:(detail:TaskDetailsResult)=>Promise<void>;retryBusy:boolean;acceptedRetry?:string|null}){
  const formal=useTaskDetails(projectId,taskId,revision,undefined,runStatus,conversationId);
  const [section,setSection]=useState('run');
  const detail=formal.data?.task.conversationId===conversationId?formal.data:null;
  return <>
    <div className="details-subnav" role="tablist" aria-label="私信任务详情分组">{[['overview','任务概况'],['run','运行详情'],['activity','活动与进展'],['delivery','交付历史']].map(([value,label])=><button key={value} className={`details-chip${section===value?' on':''}`} role="tab" aria-selected={section===value} onClick={()=>setSection(value!)}>{label}</button>)}</div>
    <div className="details-body">
      <DetailReadState {...formal}/>
      {detail?<>
        <div className="card tight"><strong>{detail.task.title}</strong><TaskStatusTag status={detail.task.status as Parameters<typeof TaskStatusTag>[0]['status']}/></div>
        {section==='overview'?<><TaskExtraFacts detail={detail}/><ActualMembers detail={detail}/></>:null}
        {section==='run'?<>{detail.failedRetry.available&&!onRetry?<div className="panel info">私信失败入口正在读取；详情保留，等待会话快照或回到原失败任务卡核对。历史阅读不会派发。</div>:null}<RunExtraFacts detail={detail} onSelectRun={formal.selectRun} onRetryFailed={onRetry?()=>{void onRetry(detail).finally(formal.refresh);}:undefined} retryBusy={retryBusy||acceptedRetry===`${detail.task.id}:${detail.latestRunId}`}/></>:null}
        {section==='activity'?<TaskEventFacts detail={detail}/>:null}
        {section==='delivery'?<DeliveryHistoryFacts detail={detail}/>:null}
      </>:null}
    </div>
  </>;
}
