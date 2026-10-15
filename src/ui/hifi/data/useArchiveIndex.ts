import {useCallback,useEffect,useRef,useState} from 'react';
import {command} from '../bridge';
import {readingNamespace} from './readingPositions';

export interface ArchiveFact {projectId:string;projectName:string;projectRevision:number;projectArchived:boolean;roomId:string|null;roomName:string|null;roomRevision:number|null;roomArchivedAt:number|null}
interface Page {items:ArchiveFact[];nextCursor:string|null;readAt:number}
const MAX_ROWS=1200;
export function useArchiveIndex(projectId?:string){
  const key=`${readingNamespace()}:${projectId??'*'}`;
  const [snapshot,setSnapshot]=useState<(Page&{key:string})|null>(null);
  const [error,setError]=useState<{key:string;message:string}|null>(null),[reading,setReading]=useState(false);
  const generation=useRef(0),flight=useRef<string|null>(null),currentKey=useRef(key);currentKey.current=key;
  const visible=snapshot?.key===key?snapshot:null, visibleRef=useRef(visible);visibleRef.current=visible;
  const load=useCallback(async(more=false)=>{
    if(flight.current===key)return;
    const prior=visibleRef.current;if(more&&(!prior?.nextCursor||prior.items.length>=MAX_ROWS))return;
    const ticket=++generation.current;flight.current=key;setReading(true);
    try{const page=await command<Page>('archive.list',{...(projectId?{projectId}:{}),limit:60,...(more?{cursor:prior!.nextCursor}: {})});
      if(ticket!==generation.current||currentKey.current!==key)return;
      const rows=more?[...prior!.items,...page.items]:page.items;
      const unique=new Map(rows.map(row=>[JSON.stringify([row.projectId,row.roomId]),row]));
      setSnapshot({...page,key,items:[...unique.values()].slice(0,MAX_ROWS)});setError(null);
    }catch(e){if(ticket===generation.current&&currentKey.current===key)setError({key,message:(e as Error).message});}
    finally{if(ticket===generation.current&&currentKey.current===key){flight.current=null;setReading(false);}}
  },[key,projectId]);
  useEffect(()=>{void load();return()=>{++generation.current;flight.current=null;};},[load]);
  return{data:visible,error:error?.key===key?error.message:null,reading,load,capped:(visible?.items.length??0)>=MAX_ROWS};
}
