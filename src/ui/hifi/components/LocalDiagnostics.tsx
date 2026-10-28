import { userFacingSystemText } from '../../../contracts/userFacingText';
import { useEffect, useRef, useState } from 'react';
import { command, bridgeErrorFacts } from '../bridge';
import { getState, useStore } from '../data/store';
import { DetailFold } from './SettingsRow';
import { readingStorageCode } from '../data/readingPositions';
type Local={build:{buildId:string;commit:string;dirty:boolean}|null;connection:{phase:string;code:string|null;updatedAt:number;monitorTimers:number;inFlight:number;attempts:number};dataRootIdentity:string;daemon:{spawned:boolean;exit:unknown;shuttingDown:boolean};at:number};
type Service={at:number;service:string;runtime:Array<{memberId:string;channel:string|null;kind:string|null;model:string|null;status:string;configuration:string;source:string;reason:string;identityKey:string|null}>;truncated:boolean;protection:{dispatchGateHeld:boolean;unknownTurns:number;pendingDispatches:number}};
/** Only structured allowlisted facts are copied. Raw errors and draft payloads never enter the report. */
export function LocalDiagnostics(){
  const projectId=useStore(s=>s.activeProjectId);const draft=useStore(s=>s.draftPersist);const conn=useStore(s=>s.conn);
  const [facts,setFacts]=useState<{projectId:string|null;local:Local|null;service:Service|null;at:number|null;error:boolean;loading:boolean}>({projectId:null,local:null,service:null,at:null,error:false,loading:false});
  const [opened,setOpened]=useState(false);const [copyState,setCopyState]=useState<string|null>(null);const ticket=useRef(0);const busy=useRef(false);
  useEffect(()=>{ticket.current++;busy.current=false;return()=>{ticket.current++;};},[projectId]);
  const refresh=async()=>{if(busy.current)return;busy.current=true;const id=++ticket.current;setFacts(old=>({...old,loading:true}));
    const zs=(window as unknown as {zs?:{diagnostics?:()=>Promise<Local>}}).zs;
    const values=await Promise.allSettled([zs?.diagnostics?zs.diagnostics():Promise.reject(Error('no local bridge')),command<Service>('app.diagnostics',projectId?{projectId}:{})]);
    if(id!==ticket.current)return;const [local,service]=values;
    setFacts(old=>({projectId,local:local.status==='fulfilled'?local.value:old.local,service:service.status==='fulfilled'?service.value:old.projectId===projectId?old.service:null,at:service.status==='fulfilled'?Date.now():old.projectId===projectId?old.at:null,error:values.some(v=>v.status==='rejected'),loading:false}));busy.current=false;
  };
  const unknownCount=()=>Object.values(getState().pendingSends).reduce((n,e)=>n+1+(e.queued?.length??0),0);
  const report=()=>({format:'zhongshuo-local-diagnostics-v1',build:facts.local?.build??null,dataRootIdentity:facts.local?.dataRootIdentity??'unread',connection:facts.local?.connection??{phase:conn},service:facts.projectId===projectId?facts.service:null,lastSuccessfulRead:facts.at,readErrorCode:facts.error?'DIAGNOSTIC_READ_FAILED':null,recentErrors:bridgeErrorFacts(),readingStorageCode,draft:{mode:draft.mode,storageCode:draft.error?'DRAFT_STORAGE_UNAVAILABLE':null,unknownSendCount:unknownCount(),stagedSendCount:Object.values(getState().outboundLedger).reduce((n,v)=>n+v.length,0)}});
  const copy=async()=>{try{await navigator.clipboard.writeText(JSON.stringify(report(),null,2));setCopyState('已复制脱敏诊断；请自行决定分享给谁。');}catch{setCopyState('复制失败；可选择下方脱敏文本复制。');}};
  const service=facts.projectId===projectId?facts.service:null;
  return <div className="card" data-zs-local-diagnostics="1"><div className="row wrap tight"><button className="btn sm" disabled={facts.loading} onClick={()=>{setOpened(true);void refresh();}}>查看诊断 / 刷新</button><button className="btn sm" disabled={!opened} onClick={()=>void copy()}>复制诊断</button></div>
    <div className="small faint">只在本机读取；复制内容不含正文、提示词、密钥、图片或完整私密路径。</div>
    {copyState?<div role="status">{copyState}</div>:null}
    {opened?<><div>连接：{conn} · 服务：{service?.service??'尚未读取'} · 更新：{facts.at?new Date(facts.at).toLocaleString():'尚未成功读取'}</div>
      {facts.error?<div className="panel warning">诊断读取失败；保留已确认事实。确认连接可用后点刷新，必要时正常关窗重开。不会重发或继续任务。</div>:null}
      <div>BUILD：{facts.local?.build?.buildId??'未提供'} · 源码：{facts.local?.build?.commit??'未提供'}</div><div>数据根身份：{facts.local?.dataRootIdentity??'尚未读取'}</div>
      <div>草稿存储：{draft.mode}{draft.error?' · 保存失败，输入保留在当前窗口；恢复存储后明确重试':' ' } · 未知发送：{unknownCount()}</div>
      <div>恢复保护：{service?service.protection.dispatchGateHeld?'继续派发需显式确认':'未持有派发门':'未读取'} · 未知执行：{service?.protection.unknownTurns??'未读取'}</div>
      {readingStorageCode?<div className="panel warning">阅读位置存储不可用（{readingStorageCode}）；当前窗口的位置仍保留，旧键不覆盖。恢复存储后再保存位置。</div>:null}
      {service?.runtime.map((r,i)=><div key={r.memberId} className="small">成员 {i+1}：{r.kind??'未配置'} · 渠道 {r.channel??'无法确定'} · 模型ID {r.model??'未指定'} · 配置 {r.configuration} / {r.source} · 图片 {r.status}（{userFacingSystemText(r.reason ?? '')}）</div>)}{service?.truncated?<div>只读前20位成员；其他成员未读取。</div>:null}
      <DetailFold summary="脱敏技术详情"><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(report(),null,2)}</pre></DetailFold></>:null}
  </div>;
}
