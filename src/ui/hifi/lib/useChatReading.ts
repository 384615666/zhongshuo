import {useLayoutEffect,useRef} from 'react';
import {readingNamespace,readingPosition,saveReadingPosition} from '../data/readingPositions';

type Position={top:number;pinned:boolean;anchor?:string;offset?:number};
/** Reading metadata is scoped to the data root/project/conversation. Content
 * grows at the bottom only while the reader was already following it. */
export function useChatReading(scope:string,contentKey:string){
  const ref=useRef<HTMLDivElement>(null),ready=useRef(false),pinned=useRef(true),restore=useRef<{position:Position;until:number}|null>(null);
  const namespace=readingNamespace();
  useLayoutEffect(()=>{
    ready.current=false;pinned.current=true;restore.current=null;
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
    const applyPosition=(saved:Position)=>{
      box.scrollTop=Number.isFinite(saved.top)?saved.top:0;
      const anchor=Array.from(box.querySelectorAll<HTMLElement>('[data-reading-message]')).find(el=>el.dataset.readingMessage===saved.anchor);
      if(anchor&&Number.isFinite(saved.offset))box.scrollTop+=anchor.getBoundingClientRect().top-box.getBoundingClientRect().top-saved.offset!;
    };
    if(!ready.current){
      const saved=readingPosition<Position>(scope);pinned.current=saved?.pinned!==false;
      if(pinned.current)box.scrollTop=box.scrollHeight;
      else if(saved){restore.current={position:saved,until:performance.now()+8000};applyPosition(saved);}
      ready.current=true;
    }else if(pinned.current)box.scrollTop=box.scrollHeight;
    let snapshot=restore.current?.position??capture();
    const save=()=>saveReadingPosition(scope,snapshot);
    const releaseRestore=()=>{restore.current=null;snapshot=capture();};
    // Input cancels restoration. Programmatic scroll events do not cancel a
    // pending anchor merely because the first layout clamped scrollTop.
    const userInput=(event:Event)=>{
      if(event instanceof KeyboardEvent&&!['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key))return;
      releaseRestore();
    };
    const scrolled=()=>{if(restore.current)return;pinned.current=box.scrollHeight-box.scrollTop-box.clientHeight<40;snapshot=capture();if(timer)clearTimeout(timer);timer=setTimeout(save,220);};
    const resized=()=>{
      if(pinned.current)box.scrollTop=box.scrollHeight;
      else if(restore.current&&performance.now()<restore.current.until)applyPosition(restore.current.position);
      else restore.current=null;
      snapshot=restore.current?.position??capture();
    };
    const deadline=restore.current?setTimeout(()=>{resized();releaseRestore();save();},Math.max(0,restore.current.until-performance.now())):undefined;
    const observer=new ResizeObserver(resized);for(const child of Array.from(box.children))observer.observe(child);
    box.addEventListener('wheel',userInput,{passive:true});box.addEventListener('pointerdown',userInput);box.addEventListener('keydown',userInput);box.addEventListener('touchstart',userInput,{passive:true});
    box.addEventListener('scroll',scrolled);
    return()=>{observer.disconnect();box.removeEventListener('scroll',scrolled);box.removeEventListener('wheel',userInput);box.removeEventListener('pointerdown',userInput);box.removeEventListener('keydown',userInput);box.removeEventListener('touchstart',userInput);if(timer)clearTimeout(timer);if(deadline)clearTimeout(deadline);save();};
  },[scope,namespace,contentKey]);
  return ref;
}
