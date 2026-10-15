import { useEffect, useRef, useState } from 'react';
import { command } from '../bridge';
import { memberWrite, pendingMemberWrites } from '../data/memberWrites';
import { useFormGuard } from './MemberManagementForms';
import { Modal, Tag } from './ui';

interface Access { authorized:boolean; root:string; revision:number }
export function ProjectWriteAccessPanel({projectId,name,path}:{projectId:string;name:string;path:string}) {
  const guard=useFormGuard(projectId),scope=`project-write:${projectId}`;
  const [facts,setFacts]=useState<Access|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false),[unknown,setUnknown]=useState(false);
  const inFlight=useRef(false),ticket=useRef(0);
  const read=async()=>{
    const n=++ticket.current;
    try {const value=await command<Access>('project.writeAccess.get',{projectId});if(guard.valid()&&n===ticket.current){setFacts(value);setError(null);setUnknown(pendingMemberWrites().some(p=>p.scope===scope));}}
    catch(e){if(guard.valid()&&n===ticket.current)setError(`授权读取失败：${(e as Error).message}；保留上次确认状态。`);}
  };
  useEffect(()=>{void read();return()=>{ticket.current++;};},[projectId]);
  const save=async(replay=false)=>{
    if(!facts||!guard.valid()||inFlight.current)return;
    inFlight.current=true;setBusy(true);
    const result=await memberWrite<Access>(scope,'project.writeAccess.set',{projectId,expectedRevision:facts.revision,authorized:!facts.authorized},replay);
    if(guard.valid()){
      setConfirm(false);
      if(result.status==='ok'){setFacts(result.data);setUnknown(false);await read();}
      else {setUnknown(result.status==='unknown');setError(result.status==='unknown'?`结果未知：${result.error}。原授权信封已保留，不会自动重放。`:`授权未变更：${result.error}`);}
      setBusy(false);
    }
    inFlight.current=false;
  };
  return <div data-zs-project-write>
    <strong>项目范围编辑授权</strong>{' '}<Tag tone={facts?.authorized?'warning':'neutral'}>{facts==null?'尚未读取':facts.authorized?'项目范围档：已授权':'项目范围档：未授权'}</Tag>
    <p className="small faint">新任务权限由成员配置决定：默认 CLI 完整权限可读写电脑并执行命令，不受本项的项目范围限制；显式只读仍然只读。已有任务保留创建时的权限快照。</p>
    <p className="small faint">本项只供「项目内文件编辑」档使用，授权目录为「{name}」。该档只允许文件创建和编辑，不开放 Shell、网络工具或委派；撤销本项不会限制完整权限。模板不会复制项目授权，单写者策略不变。</p>
    {facts?.authorized?<div className="small mono" style={{overflowWrap:'anywhere'}}>允许目录：{facts.root}</div>:null}
    {error?<div role="alert" className="small">{error}</div>:null}
    <div className="row" style={{marginTop:8}}>
      <button className="btn sm" disabled={busy||guard.invalid} onClick={()=>void read()}>刷新授权</button>
      {unknown?<button className="btn sm" disabled={busy||guard.invalid} onClick={()=>void save(true)}>人工同号重放原授权操作</button>:<button className="btn sm" data-zs-write-toggle disabled={!facts||busy||guard.invalid} onClick={()=>setConfirm(true)}>{facts?.authorized?'撤销项目写入授权':'明确授权此项目文件编辑…'}</button>}
    </div>
    {confirm?<Modal title={facts?.authorized?'撤销项目写入授权':'授权项目内文件编辑'} size="sm" onClose={()=>{if(!busy)setConfirm(false);}} footer={<><button className="btn" disabled={busy} onClick={()=>setConfirm(false)}>取消</button><button className="btn primary" data-zs-write-confirm disabled={busy||guard.invalid} onClick={()=>void save()}>{facts?.authorized?'确认撤销':'确认授权此目录'}</button></>}>
      <p>目标项目：{name}</p><p className="small mono" style={{overflowWrap:'anywhere'}}>{path}</p><p>本操作只改变项目范围档，不派发任务、不改变其他项目或完整权限，也不会让已有只读任务获得写入权限。在途或结果未知时，请先停止并确认退出后再变更授权。</p>
    </Modal>:null}
  </div>;
}
