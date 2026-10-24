/** Formal hifi loader tests mount below bootRemembered. Reproduce its durable
 * per-root/user storage initialization before exercising message.submit. */
export function initializeHifiSendPersistence(store:{initDraftPersistence:(namespace:string,rootId?:string)=>boolean},namespace:string):void{
  if(typeof globalThis.localStorage==='undefined'){
    const rows=new Map<string,string>();
    Object.defineProperty(globalThis,'localStorage',{configurable:true,writable:true,value:{
      getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>rows.set(key,String(value)),
      removeItem:(key:string)=>rows.delete(key),clear:()=>rows.clear(),key:(index:number)=>[...rows.keys()][index]??null,
      get length(){return rows.size;},
    }});
  }
  store.initDraftPersistence(namespace,`fixture-root:${namespace}`);
  if(globalThis.localStorage.getItem(`zs.hifi.persist.${namespace}`)==null)throw Error('HiFi fixture failed to initialize durable send storage');
}
