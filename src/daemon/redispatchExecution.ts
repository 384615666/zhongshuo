import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {coordinationRoster, coordinationRoomMembers} from './coordination.ts';
import {snapshotConversationWriteAccess} from './projectWriteAccess.ts';

export interface RedispatchExecution {
  writeScope: string;
  roster: ReturnType<typeof coordinationRoster>;
}

/** A deliberate continue action authorizes a new configuration snapshot. It
 * neither edits historical envelopes nor adds members outside the original group. */
export function snapshotRedispatchExecution(db: ZhongshuoDatabase, taskId: string): RedispatchExecution|undefined {
  const task=db.prepare('SELECT project_id,room_id,owner_member_id FROM tasks WHERE id=?').get(taskId) as {project_id:string;room_id:string|null;owner_member_id:string|null};
  // Legacy records may have no owner. Preserve their existing continuation
  // behavior; there is no current member configuration to freeze for them.
  if(!task.owner_member_id)return undefined;
  const original=coordinationRoster(db,taskId);
  const members=task.room_id?coordinationRoomMembers(db,task.room_id,task.project_id,original.map(m=>m.memberId)):[];
  const roster=original.map(previous=>{
    const member=members.find(m=>m.id===previous.memberId);
    if(!member)return {...previous,writeScope:null,unavailableReason:'这位成员已停用或离开房间'};
    try{return {...previous,displayName:member.display_name,description:member.description,writeScope:snapshotConversationWriteAccess(db,taskId,process.env.ZS_RUNTIME??null,member.id),unavailableReason:undefined};}
    catch(error){return {...previous,writeScope:null,unavailableReason:String(error)};}
  });
  return {writeScope:snapshotConversationWriteAccess(db,taskId,process.env.ZS_RUNTIME??null),roster};
}

/** Only the exact formal continue intent may consume its frozen snapshot. */
export function redispatchExecution(db:ZhongshuoDatabase,taskId:string,dispatchKey:string):RedispatchExecution|undefined {
  const row=db.prepare(`SELECT payload_json FROM domain_events WHERE task_id=? AND kind='task.redispatchEnqueued'
    AND json_extract(payload_json,'$.dispatchKey')=? ORDER BY seq DESC LIMIT 1`).get(taskId,dispatchKey) as {payload_json:string}|undefined;
  return row?(JSON.parse(row.payload_json) as {execution?:RedispatchExecution}).execution:undefined;
}
