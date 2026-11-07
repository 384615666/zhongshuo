import { userFacingSystemText } from '../../../contracts/userFacingText';
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
    catch(e){if(guard.valid()&&n===ticket.current)setError(`授权读取失败：${userFacingSystemText((e as Error).message ?? '')}；保留上次确认状态。`);}
  };
  useEffect(()=>{void read();return()=>{ticket.current++;};},[projectId]);
  const save=async(replay=false)=>{
    if(!facts||!guard.valid()||inFlight.current)return;
    inFlight.current=true;setBusy(true);
    const result=await memberWrite<Access>(scope,'project.writeAccess.set',{projectId,expectedRevision:facts.revision,authorized:!facts.authorized},replay);
    if(guard.valid()){
      setConfirm(false);
      if(result.status==='ok'){setFacts(result.data);setUnknown(false);await read();}
      else {setUnknown(result.status==='unknown');setError(result.status==='unknown'?`结果未知：${userFacingSystemText(result.error ?? '')}。原授权请求已保留，请确认结果后再决定是否重试。`:`授权未变更：${userFacingSystemText(result.error ?? '')}`);}
      setBusy(false);
    }
    inFlight.current=false;
  };
  return <div data-zs-project-write>
    <strong>项目范围编辑授权</strong>{' '}<Tag tone={facts?.authorized?'warning':'neutral'}>{facts==null?'尚未读取':facts.authorized?'项目内文件编辑：已授权':'项目内文件编辑：未授权'}</Tag>
    <p className="small faint">新任务权限由成员配置决定，不受本项限制；已有任务保持创建时的权限。</p>
    <p className="small faint">仅对「项目内文件编辑」档生效，授权目录为「{name}」：只能创建和编辑文件，不开放命令行、网络工具或委派；撤销本项不会影响完整权限。</p>
    {facts?.authorized?<div className="small mono" style={{overflowWrap:'anywhere'}}>允许目录：{facts.root}</div>:null}
    {error?<div role="alert" className="small">{userFacingSystemText(error ?? '')}</div>:null}
    <div className="row" style={{marginTop:8}}>
      <button className="btn sm" disabled={busy||guard.invalid} onClick={()=>void read()}>刷新授权</button>
      {unknown?<button className="btn sm" disabled={busy||guard.invalid} onClick={()=>void save(true)}>使用原授权请求重试</button>:<button className="btn sm" data-zs-write-toggle disabled={!facts||busy||guard.invalid} onClick={()=>setConfirm(true)}>{facts?.authorized?'撤销项目写入授权':'明确授权此项目文件编辑…'}</button>}
    </div>
    {confirm?<Modal title={facts?.authorized?'撤销项目写入授权':'授权项目内文件编辑'} size="sm" onClose={()=>{if(!busy)setConfirm(false);}} footer={<><button className="btn" disabled={busy} onClick={()=>setConfirm(false)}>取消</button><button className="btn primary" data-zs-write-confirm disabled={busy||guard.invalid} onClick={()=>void save()}>{facts?.authorized?'确认撤销':'确认授权此目录'}</button></>}>
      <p>目标项目：{name}</p><p className="small mono" style={{overflowWrap:'anywhere'}}>{path}</p><p>本操作只改变这个项目的文件编辑授权，不派发任务、不影响其他项目或完整权限，也不会让已有只读任务获得写入权限。有任务正在运行时，请先停止并确认退出后再变更授权。</p>
    </Modal>:null}
  </div>;
}
