import {useLayoutEffect,useRef} from 'react';
import {readingNamespace,readingPosition,saveReadingPosition} from '../data/readingPositions';

type Position={top:number;pinned:boolean;anchor?:string;offset?:number};
/** Reading metadata is scoped to the data root/project/conversation. Content
 * grows at the bottom only while the reader was already following it. */
export function useChatReading(scope:string,contentKey:string){
  const ref=useRef<HTMLDivElement>(null),ready=useRef(false),pinned=useRef(true);
  const namespace=readingNamespace();
  useLayoutEffect(()=>{
    ready.current=false;pinned.current=true;
    return()=>{ready.current=false;};
  },[scope,namespace]);
  useLayoutEffect(()=>{
    const box=ref.current;if(!box||!contentKey)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const capture=():Position=>{
      const top=box.getBoundingClientRect().top;
      const anchor=Array.from(box.querySelectorAll<HTMLElement>('[data-reading-message]')).find(el=>el.getBoundingClientRect().bottom>top);
      return{top:box.scrollTop,pinned:pinned.current,...(anchor?{anchor:anchor.dataset.readingMessage,offset:anchor.getBoundingClientRect().top-top}:{})};
    };
    if(!ready.current){
      const saved=readingPosition<Position>(scope);pinned.current=saved?.pinned!==false;
      if(pinned.current)box.scrollTop=box.scrollHeight;
      else{
        box.scrollTop=saved&&Number.isFinite(saved.top)?saved.top:0;
        const anchor=Array.from(box.querySelectorAll<HTMLElement>('[data-reading-message]')).find(el=>el.dataset.readingMessage===saved?.anchor);
        if(anchor&&Number.isFinite(saved?.offset))box.scrollTop+=anchor.getBoundingClientRect().top-box.getBoundingClientRect().top-saved!.offset!;
      }
      ready.current=true;
    }else if(pinned.current)box.scrollTop=box.scrollHeight;
    let snapshot=capture();
    const save=()=>saveReadingPosition(scope,snapshot);
    const scrolled=()=>{pinned.current=box.scrollHeight-box.scrollTop-box.clientHeight<40;snapshot=capture();if(timer)clearTimeout(timer);timer=setTimeout(save,220);};
    const resized=()=>{if(pinned.current)box.scrollTop=box.scrollHeight;snapshot=capture();};
    const observer=new ResizeObserver(resized);for(const child of Array.from(box.children))observer.observe(child);
    box.addEventListener('scroll',scrolled);
    return()=>{observer.disconnect();box.removeEventListener('scroll',scrolled);if(timer)clearTimeout(timer);save();};
  },[scope,namespace,contentKey]);
  return ref;
}
