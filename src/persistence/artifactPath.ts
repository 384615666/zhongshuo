import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {ZhongshuoDatabase} from './db.ts';
const roots=new WeakMap<ZhongshuoDatabase,string>();
export function bindArtifactDataRoot(db:ZhongshuoDatabase,root:string):void {roots.set(db,resolve(root));}

/** Managed deliberation blobs travel with the DB, even when the old root exists. */
export function artifactPath(db:ZhongshuoDatabase,path:string):string {
  if(db.name===':memory:'||!db.name)return path;
  const declaredRoot=roots.get(db);
  const root=declaredRoot??dirname(resolve(db.name));
  if(!isAbsolute(path)) {
    const target=resolve(root,path), rel=relative(root,target);
    if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw Error('成果路径超出数据目录');
    return target;
  }
  if(declaredRoot&&basename(dirname(path))==='artifacts')return join(root,'artifacts',basename(path));
  return path;
}

