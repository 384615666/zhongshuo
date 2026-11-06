import {promises as fs,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {ZhongshuoDatabase} from '../persistence/db.ts';

/** Preserve all referenced history/undo content and idempotency identities. */
export async function maintainStorage(db:ZhongshuoDatabase,root:string,now=Date.now()) {
  const result={removedFiles:0,reclaimedBytes:0,expiredReceipts:0,skippedActive:false};
  if(db.prepare("SELECT 1 FROM agent_turns WHERE status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING') OR protection_state='retained' LIMIT 1").get()){
    result.skippedActive=true;return result;
  }
  // Keep tombstones: deleting a command ID would permit its side effects again.
  result.expiredReceipts=db.prepare('UPDATE command_receipts SET result_json=NULL,result_expires_at=? WHERE created_at<? AND result_json IS NOT NULL')
    .run(now,now-90*86400_000).changes;
  const old=now-7*86400_000;
  const clean=async(directory:string,referenced:(name:string)=>boolean)=>{
    const path=resolve(directory);
    try{if(await fs.realpath(path)!==path)return;}catch{return;}
    for(const entry of await fs.readdir(path,{withFileTypes:true})){
      if(!entry.isFile()||!/^([a-f0-9]{64})(?:\.(?:bin|txt))?$/.test(entry.name)||referenced(entry.name))continue;
      const file=join(path,entry.name),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.mtimeMs>=old)continue;
      // Recheck synchronous DB references immediately before unlink, with no await.
      if(referenced(entry.name))continue;
      if(db.prepare("SELECT 1 FROM agent_turns WHERE status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING') OR protection_state='retained' LIMIT 1").get()){result.skippedActive=true;return;}
      try{unlinkSync(file);result.removedFiles++;result.reclaimedBytes+=stat.size;}catch{/* retry next maintenance */}
    }
  };
  // Upload parsing may precede its artifact row. Keep blobstore and completed
  // exports until their in-flight ownership can be proven by a durable record.
  const preimages=join(root,'preimages');
  try{
    if(await fs.realpath(preimages)===resolve(preimages))for(const entry of await fs.readdir(preimages,{withFileTypes:true})){
      if(!entry.isDirectory()||entry.isSymbolicLink())continue;
      await clean(join(preimages,entry.name),name=>db.prepare('SELECT 1 FROM change_set_files WHERE content_ref=? LIMIT 1').get(name)!=null
        ||db.prepare("SELECT 1 FROM change_set_undos WHERE steps_json LIKE ? LIMIT 1").get(`%${name}%`)!=null);
    }
  }catch{/* directory absent or inaccessible */}
  db.prepare('INSERT INTO daemon_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run('storage:last-cleanup',JSON.stringify(result),now);
  return result;
}
