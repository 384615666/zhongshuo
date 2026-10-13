/** Bounded local reading metadata only. Never a fact cache or a business command queue. */
let key:string|null=null;
let entries:Record<string,{at:number;value:unknown}>={};
let locked=false;
let order=0;
export let readingStorageCode:string|null=null;
export function configureReadingPositions(ns:string){
  const next=`zs.hifi.reading.${ns}`;if(key===next)return;key=next;entries={};locked=false;order=0;readingStorageCode=null;
  try{const raw=localStorage.getItem(next);if(!raw)return;if(raw.length>524288)throw Error('size');const parsed=JSON.parse(raw);if(parsed.v!==1||!parsed.entries||typeof parsed.entries!=='object'||Array.isArray(parsed.entries)||Object.keys(parsed.entries).length>64||Object.values(parsed.entries).some(e=>e==null||typeof e!=='object'||typeof (e as {at?:unknown}).at!=='number'||!Number.isFinite((e as {at:number}).at)))throw Error('format');entries=parsed.entries;order=Math.max(0,...Object.values(entries).map(e=>e.at));}
  catch{locked=true;readingStorageCode='READING_STORAGE_UNREADABLE';}
}
export function readingPosition<T>(scope:string):T|undefined{return entries[scope]?.value as T|undefined;}
export function readingNamespace(){return key;}
export function forgetReadingPositions(prefix:string){if(!key)return;for(const scope of Object.keys(entries))if(scope.startsWith(prefix))delete entries[scope];if(locked)return;try{localStorage.setItem(key,JSON.stringify({v:1,entries}));}catch{readingStorageCode='READING_STORAGE_WRITE_FAILED';}}
export function saveReadingPosition(scope:string,value:unknown){
  if(!key)return;
  const next={...entries,[scope]:{at:++order,value}};
  const bounded=Object.fromEntries(Object.entries(next).sort((a,b)=>b[1].at-a[1].at).slice(0,64));
  entries=bounded;if(locked)return;
  try{const raw=JSON.stringify({v:1,entries:bounded});if(raw.length>524288)throw Error('size');localStorage.setItem(key,raw);entries=bounded;readingStorageCode=null;}
  catch{entries=bounded;readingStorageCode='READING_STORAGE_WRITE_FAILED';}
}
