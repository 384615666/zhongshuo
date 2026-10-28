import { userFacingSystemText } from '../../../contracts/userFacingText';
import {useEffect,useState} from 'react';
import {command} from '../bridge';
import {Select} from './ui';
export function RuntimeEffort({projectId,kind,model,executable,value,onChange}:{projectId:string;kind:string;model:string;executable:string;value:string;onChange:(value:string)=>void}) {
  const [read,setRead]=useState<{efforts:string[];source:string;reason:string}|null>(null);
  const [error,setError]=useState<string|null>(null);
  useEffect(()=>{let alive=true;setRead(null);setError(null);const timer=setTimeout(()=>{void command<{efforts:string[];source:string;reason:string}>('member.runtimeOptions',{projectId,kind,model,...(executable?{executable}:{})}).then(result=>{if(alive)setRead(result);}).catch(e=>{if(alive)setError(String(e.message??e));});},500);return()=>{alive=false;clearTimeout(timer);};},[projectId,kind,model,executable]);
  const available=read?.efforts??[];
  return <label className="field"><span className="field-label">思考等级</span><Select value={value} ariaLabel="思考等级" onChange={onChange} options={[{value:'',label:'渠道默认'},...available.map(value=>({value,label:value})),...(value&&!available.includes(value)?[{value,label:`${value} · 当前尚未确认支持`}]:[])]}/><div className="field-hint">{error?`选项读取失败：${userFacingSystemText(error ?? '')}；可保留渠道默认。`:read?`${read.source}；${userFacingSystemText(read.reason ?? '')}`:'正在读取本机选项，不调用模型…'}</div></label>;
}
