import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {z} from 'zod';

const path=z.string().min(1).max(4096);
export const dataLocationSchema=z.strictObject({
  format:z.literal('zhongshuo-data-location-v1'),
  baseKey:z.string(),
  operationId:z.uuid(),
  dataRoot:path,
  manifestHash:z.string().regex(/^[a-f0-9]{64}$/),
});

export function dataControlPaths(baseRoot:string){
  const resolved=resolve(baseRoot),key=createHash('sha256').update(process.platform==='win32'?resolved.toLowerCase():resolved).digest('hex').slice(0,16);
  const root=join(dirname(resolved),`.zhongshuo-data-${key}`);
  return{root,key,location:join(root,'location.json'),active:join(root,'active.json')};
}

export function dataLocationHash(baseRoot:string){
  const file=dataControlPaths(baseRoot).location;
  return existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null;
}

export function readDataLocationPointer(baseRoot:string){
  const control=dataControlPaths(baseRoot),file=control.location;
  if(!existsSync(file))return null;
  const stat=lstatSync(file);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>16384)throw Error('DATA_LOCATION_INVALID：保存的数据位置不可读，请重新选择已有数据。');
  const pointer=dataLocationSchema.parse(JSON.parse(readFileSync(file,'utf8')));
  return{...pointer,control};
}

export function readDataLocation(baseRoot:string){
  const pointer=readDataLocationPointer(baseRoot);
  if(pointer==null)return resolve(baseRoot);
  const control=pointer.control;
  let actual:string;
  try{actual=realpathSync(pointer.dataRoot);}catch(error){throw Error('DATA_LOCATION_CHANGED：保存的数据位置已变化，请重新选择已有数据。',{cause:error});}
  const equal=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  if(pointer.baseKey!==control.key||!equal(resolve(pointer.dataRoot),actual)||!existsSync(join(actual,'state.sqlite')))throw Error('DATA_LOCATION_CHANGED：保存的数据位置已变化，请重新选择已有数据。');
  return actual;
}
