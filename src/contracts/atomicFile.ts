import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
/** A failed write cannot truncate the existing destination. Rename is the commit point. */
export function atomicWriteFile(target:string,bytes:Uint8Array|string):void {
  const temp=`${target}.zs-pending-${randomUUID()}`;
  let fd:number|undefined;
  try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,target);}
  catch(e){if(fd!==undefined){try{closeSync(fd);}catch{/* own descriptor */}}try{unlinkSync(temp);}catch{/* only our temporary file; original stays */}throw e;}
}
