import {useEffect,useRef,useState} from 'react';
import {command} from '../bridge';
import {Select} from './ui';

type Catalog={models:Array<{id:string;label:string;source:'reported'|'configured'}>;defaultModel:string|null;source:string;warning:string|null;truncated:boolean;program:{status:string;reason:string}};
/** One metadata read per visible target; obsolete responses never change a new form. */
export function RuntimeModel({projectId,kind,executable,value,onChange,disabled}:{projectId:string;kind:string;executable:string;value:string;onChange:(value:string)=>void;disabled?:boolean}){
  const [catalog,setCatalog]=useState<Catalog|null>(null),[error,setError]=useState<string|null>(null),[refresh,setRefresh]=useState(0);
  const valueRef=useRef(value),changeRef=useRef(onChange);valueRef.current=value;changeRef.current=onChange;
  useEffect(()=>{let alive=true;setCatalog(null);setError(null);
    const timer=setTimeout(()=>{void command<Catalog>('member.runtimeCatalog',{projectId,kind,...(executable?{executable}:{})}).then(result=>{
      if(!alive)return;setCatalog(result);
      if(!valueRef.current&&result.defaultModel)changeRef.current(result.defaultModel);
    }).catch(e=>{if(alive)setError((e as Error).message);});},200);
    return()=>{alive=false;clearTimeout(timer);};
  },[projectId,kind,executable,refresh]);
  const models=catalog?.models??[];
  return <div className="field"><span className="field-label">模型</span>
    <Select ariaLabel="模型" searchable disabled={disabled} value={value} onChange={onChange} options={[
      {value:'',label:catalog?'选择模型':'正在读取模型清单…'},
      ...models.map(m=>({value:m.id,label:`${m.label}${m.label!==m.id?' · '+m.id:''}${m.source==='configured'?' · 已配置':''}`})),
      ...(value&&!models.some(m=>m.id===value)?[{value,label:`${value} · 当前保存值`}]:[]),
    ]}/>
    <div className="field-hint">{error?`模型清单读取失败：${error}；保存值保留。`:catalog?.warning??(catalog?`${catalog.source}${catalog.truncated?'（部分列表）':''}`:'读取元数据，不发送任务。')}
      <button className="btn ghost sm" disabled={disabled} onClick={()=>setRefresh(n=>n+1)}>重新读取</button>
    </div>
    {catalog?.program.status==='missing'?<div className="panel warning">当前未找到执行程序，可在高级设置选择程序后再使用。</div>:null}
    <details><summary className="small faint">高级：手动指定模型 ID</summary><input className="input" aria-label="手动模型 ID" disabled={disabled} value={value} onChange={e=>onChange(e.target.value)} placeholder="使用当前渠道实际支持的模型 ID"/></details>
  </div>;
}
