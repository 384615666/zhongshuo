import {useState,type ReactNode} from 'react';

/** Reveal more rows without changing ordering or the selected conversation. */
export function ProjectConversationList<T>({items,projectId,kind,children}:{items:T[];projectId:string;kind:'room'|'dm'|'dm-archive';children:(item:T)=>ReactNode}){
  const [more,setMore]=useState(0);
  const limit=items.length>20?5+more*10:items.length;
  const remaining=Math.max(0,items.length-limit);
  return <div data-zs-project-list={`${kind}:${projectId}`}>
    {items.slice(0,limit).map(children)}
    {remaining>0?<button className={`conversation-show-more${kind==='room'?' room-more':''}`} data-zs-show-more={`${kind}:${projectId}`}
      aria-label={`显示更多${kind==='room'?'房间':'私信'}，还有${remaining}条`} title={`再显示${Math.min(10,remaining)}条`}
      onClick={()=>setMore(current=>current+1)}>显示更多</button>:null}
  </div>;
}
