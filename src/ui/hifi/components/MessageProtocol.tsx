import { userFacingSystemText } from '../../../contracts/userFacingText';
import {useEffect,useState} from 'react';
import {Modal} from './ui';
import {command} from '../bridge';
export function MessageProtocol({projectId,messageId,onClose}:{projectId:string;messageId:string;onClose:()=>void}) {
  const [result,setResult]=useState<{text:string|null;sha256:string|null;note:string}|null>(null),[error,setError]=useState<string|null>(null),[attempt,setAttempt]=useState(0);
  useEffect(()=>{let alive=true;setError(null);void command<{text:string|null;sha256:string|null;note:string}>('message.protocol',{projectId,messageId}).then(r=>{if(alive)setResult(r);}).catch(e=>{if(alive)setError(e.message??String(e));});return()=>{alive=false;};},[projectId,messageId,attempt]);
  return <Modal title="运行协议 · 原始记录" subtitle="只读高级详情；不会派发、重试或改变成果" size="lg" onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
    {error?<div className="panel warning">读取失败：{userFacingSystemText(error ?? '')} <button className="btn sm" onClick={()=>setAttempt(a=>a+1)}>重试读取</button></div>:null}
    {result?<><div className="small faint">{result.note}</div>{result.text?<pre data-zs-message-protocol style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{result.text}</pre>:null}<details><summary>原件身份</summary><code>{result.sha256??'无控制协议'}</code></details></>:!error?<div className="small faint">正在读取原始记录…</div>:null}
  </Modal>;
}
