import { userFacingSystemText } from '../../../contracts/userFacingText';
import {useEffect,useRef,useState} from 'react';
import type {SendLookupResult} from '../../../contracts/sendRecovery.ts';
import {querySubmittedSend,openRecoveredSend} from '../loader';
import {getDraftFull,useStore,toast} from '../data/store';
import type {HifiDraft,PendingSendEnvelope} from '../data/store';

/** A durable original request is queried independently from resending it. */
export function SendRecoveryAction({draftKey,onRecovered}:{draftKey:string;onRecovered:(draft:HifiDraft,reference:{draftKey:string;commandId:string})=>void}){
  const reference=useStore(state=>state.pendingSends[draftKey]??state.lastSendReferences[draftKey]);
  const last=useStore(state=>state.lastSendReferences[draftKey]);
  const pending=useStore(state=>state.pendingSends[draftKey]);
  const [state,setState]=useState<{identity:string;busy:boolean;result?:SendLookupResult;error?:string}|null>(null);
  const generation=useRef(0),current=useRef('');
  const identity=JSON.stringify([draftKey,reference?.commandId]);
  current.current=identity;
  useEffect(()=>{generation.current+=1;},[identity]);
  if(!reference||!pending&&last?.outcome!=='unknown')return null;
  const visible=state?.identity===identity?state:null;
  const found=visible?.result?.status==='found'?visible.result:null;
  const query=async()=>{
    const ticket=++generation.current;
    const frozen=JSON.parse(JSON.stringify(reference)) as PendingSendEnvelope;
    setState({identity,busy:true});
    try{
      const result=await querySubmittedSend(frozen);
      if(current.current!==identity||ticket!==generation.current)return;
      setState({identity,busy:false,result});
      if(result.status==='found'){
        onRecovered(getDraftFull(draftKey),{draftKey,commandId:frozen.commandId});
        await openRecoveredSend(result.location).catch(error=>toast(`定位原消息失败：${userFacingSystemText((error as Error).message ?? '')}`,'error'));
      }
    }catch(error){if(current.current===identity&&ticket===generation.current)setState({identity,busy:false,error:(error as Error).message});}
  };
  return <div className="small panel info" data-zs-send-recovery="1">
    <button type="button" className="btn ghost sm" disabled={visible?.busy} onClick={()=>void query()}>{visible?.busy?'正在查询原发送…':'查询刚才的发送'}</button>
    {last?.commandId===reference.commandId&&last.outcome==='rejected'?<span>上次发送已明确拒绝：{userFacingSystemText(last.error??'草稿保留')}</span>:null}
    {visible?.error?<div role="alert">查询未确认：{userFacingSystemText(visible.error ?? '')}。原请求保留，没有重新发送。</div>:null}
    {found?<div>已找到原消息。</div>:null}
    {visible?.result&&visible.result.status!=='found'?<div role="status">{visible.result.message}</div>:null}
  </div>;
}
