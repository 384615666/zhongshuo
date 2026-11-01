import {resolve} from 'node:path';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {comparisonKey} from './directoryIdentity.ts';
import {changeSetFilesForDelivery} from './clarificationWork.ts';

/** A shared directory scan records observations, not exclusive file ownership.
 * Project its frozen bytes through the source turns' actual declared/snapshotted
 * paths. Never change the stored audit, cached handoff, or historical delivery. */
export function deliveryFilesForHandoff(db:ZhongshuoDatabase,taskId:string,runId:string,refs:readonly string[]){
  const root=(db.prepare('SELECT p.canonical_path FROM projects p JOIN tasks t ON t.project_id=p.id WHERE t.id=?').get(taskId) as {canonical_path:string}).canonical_path;
  const key=(path:string)=>comparisonKey(resolve(root,path));
  const owned=new Map<string,Set<string>>();
  for(const ref of refs){
    if(!db.prepare("SELECT 1 FROM change_sets WHERE id=? AND task_id=? AND json_extract(manifest_json,'$.concurrentWriteObservation')=1").get(ref,taskId))continue;
    const sources=db.prepare(`SELECT DISTINCT run_id FROM domain_events WHERE task_id=? AND kind='changeset.baselineCaptured'
      AND json_extract(payload_json,'$.changeSetId')=? AND run_id IS NOT NULL`).all(taskId,ref) as {run_id:string}[];
    const sourceRuns=sources.length?sources.map(r=>r.run_id):[runId];
    const repairs=db.prepare(`SELECT repaired.run_id FROM format_repair_workitems f
      JOIN agent_turns source ON source.id=f.source_turn_id JOIN agent_turns repaired ON repaired.id=f.consumed_turn_id
      WHERE source.run_id IN(SELECT value FROM json_each(?)) AND repaired.run_id=?`).all(JSON.stringify(sourceRuns),runId) as {run_id:string}[];
    const runs=[...new Set([...sourceRuns,...repairs.map(r=>r.run_id)])];
    const paths=new Set<string>();
    const messages=db.prepare(`SELECT m.body_json FROM messages m JOIN agent_turns a ON m.author_id=a.member_id
      AND substr(m.id,1,length('msg_'||a.id||'_'))='msg_'||a.id||'_'
      JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND m.task_id=r.task_id AND m.author_type='agent'
      AND a.status='SUCCEEDED' AND a.run_id IN(SELECT value FROM json_each(?)) ORDER BY m.rowid`).all(taskId,JSON.stringify(runs)) as {body_json:string}[];
    for(const message of messages){
      try{
        const body=JSON.parse(message.body_json) as {runtimeControlResult?:string;text?:string};
        const result=JSON.parse(body.runtimeControlResult??body.text??'') as {schemaVersion?:string;files?:unknown};
        if(result.schemaVersion==='task-complete-v1'&&Array.isArray(result.files))for(const path of result.files)if(typeof path==='string'&&path.trim())paths.add(key(path));
      }catch{/* Natural text cannot establish a declared delivery path. */}
    }
    // The existing snapshot writer already excludes peer directory differences
    // on this path. Include tool-discovered files only with an exact bound blob hash.
    const snapshots=db.prepare(`SELECT f.path,f.after_sha256 FROM message_file_changes f JOIN artifacts a ON a.id=f.artifact_id AND a.hash=f.after_sha256
      JOIN agent_turns t ON t.id=f.turn_id JOIN workflow_runs r ON r.id=t.run_id
      WHERE f.task_id=? AND r.task_id=f.task_id AND f.run_id=r.id AND a.task_id=f.task_id
        AND a.project_id=f.project_id AND a.conversation_id=f.conversation_id AND t.status='SUCCEEDED' AND f.change_set_id IS NULL
        AND f.run_id IN(SELECT value FROM json_each(?))`).all(taskId,JSON.stringify(runs)) as {path:string;after_sha256:string}[];
    for(const snapshot of snapshots)paths.add(key(snapshot.path));
    const after=db.prepare("SELECT path,state,sha256 FROM change_set_files WHERE change_set_id=? AND role='after'").all(ref) as {path:string;state:string;sha256:string|null}[];
    for(const snapshot of snapshots){
      const observation=after.find(file=>key(file.path)===key(snapshot.path));
      if(observation&&(observation.state!=='present'||observation.sha256!==snapshot.after_sha256)){
        throw Error('成果快照与共享目录观察版本不符；不能以其他写入替代原成果');
      }
    }
    owned.set(ref,paths);
  }
  // Hash/state still come from immutable before/after captures. The caller
  // verifies those hashes against real files before any model can start.
  return changeSetFilesForDelivery(db,taskId,refs,{
    include:(ref,path)=>!owned.has(ref)||owned.get(ref)!.has(key(path)),
    includeUnchanged:(ref,path)=>owned.get(ref)?.has(key(path))===true,
  });
}

/** Re-project an old polluted cache on read; its original JSON remains intact. */
export function correctedSharedHandoffFiles(db:ZhongshuoDatabase,taskId:string,deliveryId:string){
  const delivery=db.prepare('SELECT run_id,change_set_refs_json FROM task_deliveries WHERE id=? AND task_id=?').get(deliveryId,taskId) as {run_id:string;change_set_refs_json:string}|undefined;
  if(!delivery)return null;
  const refs=JSON.parse(delivery.change_set_refs_json) as string[];
  if(!refs.some(ref=>db.prepare("SELECT 1 FROM change_sets WHERE id=? AND task_id=? AND json_extract(manifest_json,'$.concurrentWriteObservation')=1").get(ref,taskId)))return null;
  return deliveryFilesForHandoff(db,taskId,delivery.run_id,refs);
}
