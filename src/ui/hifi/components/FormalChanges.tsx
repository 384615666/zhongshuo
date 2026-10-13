import {useEffect,useRef,useState} from 'react';
import type {ChangeSnapshot} from '../../../contracts/changeSnapshot';
import {command} from '../bridge';
import {fullTime} from '../lib/format';
export interface FormalChange {changeSetId:string;taskId:string|null;taskTitle:string|null;applicationStatus:string;beforeRef:string;afterRef:string;locate:string|null}
const pages=new Map<string,Promise<{groups:Array<{projectId:string;drafts:FormalChange[]}>}>>();
/** Bounded visible reader; preserves confirmed facts on failure, no local task inference. */
export function useFormalChanges(projectId:string){
  const [state,setState]=useState<{items:FormalChange[]|null;error:string|null;at:number|null}>({items:null,error:null,at:null});
  const refresh=useRef<()=>void>(()=>{});
  useEffect(()=>{let alive=true,busy=false,generation=0,again=false;
    const visible=()=>document.visibilityState!=='hidden'&&!document.body.classList.contains('legacy-on');
    const load=()=>{if(!alive||busy||!visible())return;busy=true;const ticket=++generation;
      let pending=pages.get(projectId);if(!pending){pending=command<{groups:Array<{projectId:string;drafts:FormalChange[]}>}>('files.view',{scope:'project',projectId}).finally(()=>pages.delete(projectId));pages.set(projectId,pending);}
      void pending.then(r=>{if(alive&&ticket===generation&&visible()){const group=r.groups.find(g=>g.projectId===projectId);if(!group)throw Error('改动集回执没有当前项目');setState({items:group.drafts,error:null,at:Date.now()});}},(e:unknown)=>{if(alive&&ticket===generation&&visible())setState(s=>({...s,error:e instanceof Error?e.message:String(e)}));}).catch(e=>{if(alive&&ticket===generation&&visible())setState(s=>({...s,error:String(e)}));}).finally(()=>{busy=false;if(alive&&again&&visible()){again=false;load();}});
    };
    refresh.current=load;const visibility=()=>{generation++;again=true;if(visible()&&!busy){again=false;load();}};document.addEventListener('visibilitychange',visibility);const timer=window.setInterval(load,5000);load();
    return()=>{alive=false;generation++;window.clearInterval(timer);document.removeEventListener('visibilitychange',visibility);refresh.current=()=>{};};
  },[projectId]);
  return{...state,refresh:()=>refresh.current()};
}
export function FormalChangeList({facts,selected,onSelect}:{facts:ReturnType<typeof useFormalChanges>;selected?:string;onSelect:(id:string)=>void}){
  return <div data-zs-formal-changes>
    <div className="small faint">最近最多100项（权限过滤的确认窗口）{facts.at?` · ${fullTime(facts.at)}`:''}<button className="btn ghost sm" onClick={facts.refresh}>刷新改动集</button></div>
    {facts.error?<div role="alert" className="panel warning">改动集读取失败：{facts.error}；保留上次确认列表，可刷新重试。</div>:null}
    {facts.items===null?<div className="small faint">尚未取得改动集列表。</div>:facts.items.length===0?<div className="small faint">本次确认此项目没有可见改动集。</div>:facts.items.map(c=><button key={c.changeSetId} data-zs-formal-change={c.changeSetId} className={`card tight${selected===c.changeSetId?' selected':''}`} style={{width:'100%',textAlign:'left',marginTop:6}} onClick={()=>onSelect(c.changeSetId)}><strong>{c.taskTitle??'未提供任务标题'}</strong><div className="small faint">文件应用：{({applied:'已写入',reverted:'已还原',not_applied:'尚未应用',partial:'部分应用'} as Record<string,string>)[c.applicationStatus]??c.applicationStatus}；验收状态在所属任务</div><details className="small faint"><summary>改动集身份</summary>{c.changeSetId}</details></button>)}
  </div>;
}
export function FormalChangeDetail({projectId,entry}:{projectId:string;entry?:FormalChange}){
  const [snapshot,setSnapshot]=useState<ChangeSnapshot|null>(null),[error,setError]=useState<string|null>(null),[chosen,setChosen]=useState<string|undefined>(),[retry,setRetry]=useState(0);
  const id=entry?.changeSetId,taskId=entry?.taskId;
  useEffect(()=>{setSnapshot(null);setChosen(undefined);setError(null);},[projectId,id]);
  useEffect(()=>{if(!id||!taskId)return;let alive=true;
    void command<ChangeSnapshot>('changeset.readSnapshot',{projectId,taskId,changeSetId:id,...(chosen?{path:chosen}:{})}).then(r=>{if(!alive)return;if(r.projectId!==projectId||r.taskId!==taskId||r.changeSetId!==id||(chosen&&r.content?.path!==chosen))throw Error('快照回执不属于当前项目/任务/文件');setSnapshot(r);setError(null);},e=>{if(alive)setError((e as Error).message);}).catch(e=>{if(alive)setError(String(e));});
    return()=>{alive=false;};
  },[projectId,id,taskId,chosen,retry,entry?.afterRef,entry?.applicationStatus]);
  if(!entry)return <div className="card">请选择一个正式改动集；列表未读取时不推断没有修改。</div>;
  const data=snapshot?.changeSetId===id?snapshot:null;
  return <div className="card" data-zs-formal-change-detail={id}>
    <strong>{entry.taskTitle??'未提供任务标题'}</strong><p className="small faint">实际文件前后快照；当前磁盘文件与历史快照分列。验收仍在所属任务，阅读不会撤销或暂存文件。</p>
    {entry.locate?<a href={entry.locate}>查看所属任务与交付</a>:null}
    {error?<div role="alert" className="panel warning">快照读取失败：{error}；已确认内容保留。<button className="btn sm" onClick={()=>setRetry(n=>n+1)}>重试读取</button></div>:null}
    {!data?<div className="small faint">尚未取得文件差异。</div>:<>
      {data.files.length===0?<div className="small faint">{entry.afterRef?'本次确认没有文件内容变化。':'改动后快照尚未定型，不推断没有变化。'}</div>:null}
      {data.files.map(f=><div key={f.path} className="card tight" style={{marginTop:8}}><button className="btn ghost sm" data-zs-change-path={f.path} onClick={()=>setChosen(f.path)}>{f.path} · {({added:'新增',removed:'删除',modified:'修改',unknown:'无法判断'} as Record<string,string>)[f.change]}</button><details className="small faint"><summary>文件hash</summary>前：{f.beforeHash??'未提供'}<br/>后：{f.afterHash??'未提供'}</details></div>)}
      {data.truncated?<div className="small faint">仅显示前100个路径，未冒充完整改动。</div>:null}
      {data.content?.path===chosen?<div data-zs-change-content={chosen} style={{marginTop:12}}><strong>{chosen} · 前后内容</strong>{(['before','after'] as const).map(side=><div key={side}><div className="small faint">{side==='before'?'修改前快照':'修改后快照'} · {data.content![side].reason??'hash已核验的UTF-8文本'}</div>{data.content![side].text!=null?<pre style={{maxHeight:240,overflow:'auto',whiteSpace:'pre',border:'1px solid var(--border)',padding:8}}>{data.content![side].text}</pre>:null}</div>)}</div>:null}
    </>}
  </div>;
}
