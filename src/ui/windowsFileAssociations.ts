import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,join,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import type * as Koffi from 'koffi';

export interface FileAssociation {id:string;label:string;kind:'editor'}
const associationId=(extension:string,name:string)=>`association:${createHash('sha256').update(extension+'\0'+name).digest('hex')}`;
let native:ReturnType<typeof loadNative>|undefined;
function loadNative(){
  const filename=typeof __filename==='string'?__filename:fileURLToPath(import.meta.url);
  const require=createRequire(filename);
  let ffi:typeof Koffi;
  try{ffi=require('koffi') as typeof Koffi;}
  catch{ffi=require(join(dirname(filename),'../../daemon/node_modules/koffi')) as typeof Koffi;}
  const shell=ffi.load('shell32.dll'),ole=ffi.load('ole32.dll');
  const initialize=ole.func('int32_t __stdcall CoInitializeEx(void*, uint32_t)');
  const uninitialize=ole.func('void __stdcall CoUninitialize()');
  const free=ole.func('void __stdcall CoTaskMemFree(void*)');
  const enumerate=shell.func('int32_t __stdcall SHAssocEnumHandlers(const char16_t*, uint32_t, _Out_ void**)');
  const parse=shell.func('int32_t __stdcall SHParseDisplayName(const char16_t*, void*, _Out_ void**, uint32_t, void*)');
  const bind=shell.func('int32_t __stdcall SHBindToParent(void*, const void*, _Out_ void**, _Out_ void**)');
  const releaseType=ffi.proto('uint32_t __stdcall ZsAssociationRelease(void*)');
  const stringType=ffi.proto('int32_t __stdcall ZsAssociationString(void*, _Out_ void**)');
  const nextType=ffi.proto('int32_t __stdcall ZsAssociationNext(void*, uint32_t, _Out_ void**, _Out_ uint32_t*)');
  const invokeType=ffi.proto('int32_t __stdcall ZsAssociationInvoke(void*, void*)');
  const uiObjectType=ffi.proto('int32_t __stdcall ZsAssociationUiObject(void*, void*, uint32_t, void**, const void*, void*, _Out_ void**)');
  const method=(object:unknown,index:number)=>ffi.decode(ffi.decode(object,'void*'),index*ffi.sizeof('void*'),'void*');
  const release=(object:unknown)=>{if(object!=null)ffi.call(method(object,2),releaseType,object);};
  const text=(object:unknown,index:number):string=>{
    const out:unknown[]=[null];
    if(ffi.call(method(object,index),stringType,object,out)<0||out[0]==null)return '';
    try{return String(ffi.decode(out[0],'char16_t',-1));}finally{free(out[0]);}
  };
  const invoke=(handler:unknown,path:string)=>{
    const pidl:unknown[]=[null],parent:unknown[]=[null],child:unknown[]=[null],data:unknown[]=[null];
    const shellFolder=Buffer.from('e614020000000000c000000000000046','hex');
    const dataObject=Buffer.from('0e01000000000000c000000000000046','hex');
    try{
      if(parse(path,null,pidl,0,null)<0||pidl[0]==null)throw Error('文件已不可用，请刷新后重试。');
      if(bind(pidl[0],shellFolder,parent,child)<0||parent[0]==null||child[0]==null)throw Error('无法定位文件所在的文件夹。');
      if(ffi.call(method(parent[0],10),uiObjectType,parent[0],null,1,[child[0]],dataObject,null,data)<0||data[0]==null)throw Error('无法将文件交给所选程序。');
      if(ffi.call(method(handler,8),invokeType,handler,data[0])<0)throw Error('所选程序未能打开文件，请重试或使用默认程序。');
    }finally{release(data[0]);release(parent[0]);if(pidl[0]!=null)free(pidl[0]);}
  };
  return{initialize,uninitialize,enumerate,release,text,invoke,next:(object:unknown,out:unknown[],fetched:number[])=>ffi.call(method(object,3),nextType,object,1,out,fetched) as number};
}

/** Enumerate Windows' file-type handlers, including packaged apps. COM objects
 * never cross IPC; selection is re-resolved from an opaque, extension-bound ID.
 * Docs: learn.microsoft.com/windows/win32/api/shobjidl_core/nf-shobjidl_core-shassocenumhandlers */
function withAssociations(path:string,selectedId?:string):FileAssociation[]{
  if(process.platform!=='win32')return [];
  const extension=win32.extname(path).toLowerCase();
  if(!/^\.[^\\/\0.]{1,64}$/.test(extension))return [];
  const api=native??=loadNative(),initialized=api.initialize(null,2) as number;
  if(initialized<0&&initialized!==-2147417850)throw Error('系统打开方式暂时不可用。');
  const enumeration:unknown[]=[null],items:FileAssociation[]=[],seen=new Set<string>();
  let invoked=false;
  try{
    if(api.enumerate(extension,1,enumeration)<0||enumeration[0]==null){
      if(selectedId)throw Error('所选打开方式已变化，请重新选择。');
      return [];
    }
    for(let i=0;i<128;i++){
      const handler:unknown[]=[null],fetched=[0];
      const hr=api.next(enumeration[0],handler,fetched);
      if(hr!==0||handler[0]==null){api.release(handler[0]);break;}
      try{
        const name=api.text(handler[0],3),label=api.text(handler[0],4);
        if(!name||!label||name.length>4096||label.length>256)continue;
        const id=associationId(extension,name);
        if(seen.has(id))continue;seen.add(id);
        if(selectedId===id){api.invoke(handler[0],win32.normalize(path));invoked=true;break;}
        items.push({id,label,kind:'editor'});
      }finally{api.release(handler[0]);}
    }
    if(selectedId&&!invoked)throw Error('所选打开方式已变化，请重新选择。');
    return items;
  }finally{api.release(enumeration[0]);if(initialized>=0)api.uninitialize();}
}
export function windowsFileAssociations(path:string):FileAssociation[]{return withAssociations(path);}
export function openWindowsFileAssociation(id:string,path:string):void{
  if(process.platform!=='win32'||!id.startsWith('association:')||!win32.extname(path))throw Error('所选打开方式不可用。');
  withAssociations(path,id);
}
