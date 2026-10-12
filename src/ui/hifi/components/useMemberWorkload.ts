import { useEffect, useRef, useState } from 'react';
import { command } from '../bridge';
interface Workload { projectId: string; items: Array<{memberId:string;unfinishedTasks:number;activeTurns:number;unknownTurns:number}>; truncated:boolean }
const pending = new Map<string,Promise<Workload>>();
function read(projectId:string) {
  const existing=pending.get(projectId);if(existing)return existing;
  const promise=command<Workload>('project.memberWorkload',{projectId}).finally(()=>{if(pending.get(projectId)===promise)pending.delete(projectId);});pending.set(projectId,promise);return promise;
}
export function useMemberWorkload(projectId:string) {
  const refresh=useRef<(()=>void)|null>(null);
  const [state,setState]=useState<{projectId:string;data:Workload|null;error:string|null;updatedAt:number|null}>({projectId:'',data:null,error:null,updatedAt:null});
  useEffect(()=>{
    if(!projectId)return;
    let alive=true;let busy=false;let ticket=0;let queued=false;
    const visible=()=>document.visibilityState!=='hidden'&&!document.body.classList.contains('legacy-on');
    const load=()=>{if(!alive||!visible())return;if(busy){queued=true;return;}busy=true;queued=false;const id=++ticket;
      void read(projectId).then(data=>{if(alive&&ticket===id&&visible()&&data.projectId===projectId)setState({projectId,data,error:null,updatedAt:Date.now()});},(e:unknown)=>{if(alive&&ticket===id&&visible())setState(old=>({projectId,data:old.projectId===projectId?old.data:null,updatedAt:old.projectId===projectId?old.updatedAt:null,error:e instanceof Error?e.message:String(e)}));}).finally(()=>{busy=false;if(alive&&queued&&visible())load();});};
    const visibility=()=>{if(visible())load();else{ticket++;queued=true;}};
    refresh.current=load;
    document.addEventListener('visibilitychange',visibility);
    let wasVisible=visible();const observer=new MutationObserver(()=>{const now=visible();if(now!==wasVisible){wasVisible=now;visibility();}});observer.observe(document.body,{attributes:true,attributeFilter:['class']});
    const timer=window.setInterval(()=>{if(!busy)load();},5000);load();
    return()=>{alive=false;ticket++;refresh.current=null;window.clearInterval(timer);observer.disconnect();document.removeEventListener('visibilitychange',visibility);};
  },[projectId]);
  return {...(state.projectId===projectId?state:{projectId,data:null,error:null,updatedAt:null}),refresh:()=>refresh.current?.()};
}
