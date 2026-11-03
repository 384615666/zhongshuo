import {spawn} from 'node:child_process';
import {win32} from 'node:path';
import type {LocalOpener} from './localOpeners.ts';
import type {FileAssociation} from './windowsFileAssociations.ts';
export interface LocalFileResult {ok:boolean;error?:string}
export interface FileOpener {id:string;label:string;kind:'default'|'explorer'|'editor'}
const openerLabelKey=(label:string)=>label.toLowerCase().replaceAll('visual studio code','vs code').replace(/\s+/g,'');

/** A spawn return value is not a successful launch. Keep an error listener even
 * after the spawn event so later errors cannot become uncaught main exceptions. */
export function launchLocalEditor(executable:string,path:string):Promise<LocalFileResult>{
  return new Promise(resolve=>{
    const failed=()=>resolve({ok:false,error:'打开程序已不可用，请重新选择打开方式或使用默认程序。'});
    try{
      const child=spawn(executable,[path],{detached:true,stdio:'ignore',windowsHide:false});
      child.once('error',failed);
      child.once('spawn',()=>{child.unref();resolve({ok:true});});
    }catch{failed();}
  });
}
export function createLocalFileActions(io:{
  validate:(path:unknown)=>string;
  editors:()=>LocalOpener[];
  associations:(path:string)=>FileAssociation[];
  invokeAssociation:(id:string,path:string)=>void;
  openDefault:(path:string)=>Promise<string>;
  launch?:(executable:string,path:string)=>Promise<LocalFileResult>;
}){
  const list=(target:unknown):FileOpener[]=>{
    const path=io.validate(target),items:FileOpener[]=[{id:'default',label:'按默认程序打开',kind:'default'},{id:'explorer',label:'资源管理器',kind:'explorer'}];
    try{items.push(...io.associations(path));}catch{/* Default opening remains usable if association enumeration fails. */}
    // Keep optional code editors for text/source files; Office/media menus use
    // their registered applications rather than unrelated code editors.
    if(/\.(?:txt|md|markdown|log|json|csv|ts|tsx|js|jsx|mjs|cjs|py|go|java|rs|html?|css|xml|ya?ml|toml|ini|sql|sh|ps1|bat|cmd)$/i.test(win32.extname(path))){
      for(const opener of io.editors())if(opener.kind==='editor'&&!items.some(item=>openerLabelKey(item.label)===openerLabelKey(opener.label)))items.push({id:opener.id,label:opener.label,kind:'editor'});
    }
    return items;
  };
  const open=async(appId:unknown,target:unknown):Promise<LocalFileResult>=>{
    const path=io.validate(target);
    if(typeof appId!=='string'||!list(path).some(item=>item.id===appId&&item.kind!=='explorer'))return{ok:false,error:'所选打开方式已变化，请重新选择。'};
    try{
      if(appId==='default'){const error=await io.openDefault(path);return error?{ok:false,error}:{ok:true};}
      if(appId.startsWith('association:')){io.invokeAssociation(appId,path);return{ok:true};}
      const editor=io.editors().find(item=>item.id===appId&&item.kind==='editor');
      if(!editor?.executable)return{ok:false,error:'所选程序已不可用，请重新选择。'};
      return await(io.launch??launchLocalEditor)(editor.executable,path);
    }catch{return{ok:false,error:'所选程序未能打开文件，请重试或使用默认程序。'};}
  };
  return{list,open};
}
