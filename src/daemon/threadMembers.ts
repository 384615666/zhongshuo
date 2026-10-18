import {createHash} from 'node:crypto';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import type {ThreadMembersSnapshot} from '../contracts/threadMembers.ts';
import type {ThreadVisibleProgress} from '../contracts/runtimeProgress.ts';

/** One membership source. Legacy reconstruction uses actual addressed/assigned
 * identities only, never the room-wide AUTO candidate roster. Explicit removal
 * always overrides historical evidence and does not rewrite a frozen run. */
export function readThreadMembers(db:ZhongshuoDatabase,threadId:string):ThreadMembersSnapshot {
  const thread=db.prepare('SELECT project_id,room_id,root_task_id FROM conversation_threads WHERE id=?').get(threadId) as {project_id:string;room_id:string;root_task_id:string|null};
  const root=thread.root_task_id?db.prepare('SELECT owner_member_id,route_json FROM tasks WHERE id=?').get(thread.root_task_id) as {owner_member_id:string|null;route_json:string|null}|undefined:undefined;
  const known=new Set<string>();
  if(root?.owner_member_id)known.add(root.owner_member_id);
  if(root?.route_json){
    const route=JSON.parse(root.route_json) as {frozenMemberIds?:string[]};
    for(const id of route.frozenMemberIds??[])known.add(id);
  }
  const assigned=db.prepare(`SELECT DISTINCT a.member_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
    JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? AND t.conversation_thread_id=?`).all(thread.project_id,threadId) as {member_id:string}[];
  for(const row of assigned)known.add(row.member_id);
  const children=db.prepare(`SELECT DISTINCT child.owner_member_id member_id FROM coordination_steps s
    JOIN coordination_runs cr ON cr.run_id=s.run_id JOIN tasks parent ON parent.id=cr.task_id
    JOIN tasks child ON child.id=s.child_task_id WHERE parent.project_id=? AND parent.conversation_thread_id=?
    AND child.owner_member_id IS NOT NULL`).all(thread.project_id,threadId) as {member_id:string}[];
  for(const row of children)known.add(row.member_id);
  const explicit=db.prepare('SELECT member_id,status,revision FROM thread_agent_followers WHERE thread_id=? ORDER BY member_id').all(threadId) as {member_id:string;status:string;revision:number}[];
  for(const row of explicit){if(row.status==='following')known.add(row.member_id);else known.delete(row.member_id);}
  const members=db.prepare("SELECT id,enabled FROM project_members WHERE project_id=? AND principal_type='agent' ORDER BY id").all(thread.project_id) as {id:string;enabled:number}[];
  const available=new Set((db.prepare('SELECT member_id FROM room_members WHERE room_id=?').all(thread.room_id) as {member_id:string}[]).map(m=>m.member_id));
  const memberIds=members.filter(m=>known.has(m.id)).map(m=>m.id);
  const eligibleMemberIds=members.filter(m=>known.has(m.id)&&m.enabled===1&&available.has(m.id)).map(m=>m.id);
  const runningMemberIds=(db.prepare(`SELECT DISTINCT a.member_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
    JOIN tasks t ON t.id=r.task_id WHERE t.project_id=? AND (t.conversation_thread_id=? OR EXISTS(
      SELECT 1 FROM coordination_steps s JOIN coordination_runs cr ON cr.run_id=s.run_id JOIN tasks parent ON parent.id=cr.task_id
      WHERE s.child_task_id=t.id AND parent.project_id=t.project_id AND parent.conversation_thread_id=?))
    AND a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING') ORDER BY a.member_id`).all(thread.project_id,threadId,threadId) as {member_id:string}[]).map(m=>m.member_id);
  const version=createHash('sha256').update(JSON.stringify({memberIds,eligibleMemberIds,explicit})).digest('hex');
  return{projectId:thread.project_id,threadId,roomId:thread.room_id,version,memberIds,eligibleMemberIds,runningMemberIds};
}

/** Called only inside the formal command transaction after audience/CAS checks. */
export function persistThreadMember(db:ZhongshuoDatabase,threadId:string,memberId:string,action:'add'|'remove',authorId:string) {
  const th=db.prepare('SELECT project_id,conversation_id FROM conversation_threads WHERE id=?').get(threadId) as {project_id:string;conversation_id:string};
  db.prepare(`INSERT INTO thread_agent_followers(project_id,conversation_id,thread_id,member_id,status,revision,added_by,updated_at)
    VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(thread_id,member_id) DO UPDATE SET status=excluded.status,
    revision=thread_agent_followers.revision+1,added_by=excluded.added_by,updated_at=excluded.updated_at`)
    .run(th.project_id,th.conversation_id,threadId,memberId,action==='add'?'following':'removed',authorId,Date.now());
  return readThreadMembers(db,threadId);
}

export function readThreadProgress(db:ZhongshuoDatabase,threadId:string):ThreadVisibleProgress[] {
  const rows=db.prepare(`SELECT a.id turnId,a.member_id memberId,a.status,p.text,p.updated_at updatedAt,
    r.id runId,r.stage stage,a.exec_started_at execStartedAt,r.stage_started_at stageStartedAt,
    (SELECT MAX(e.created_at) FROM domain_events e WHERE e.turn_id=a.id
      AND e.kind='turn.statusChanged' AND json_extract(e.payload_json,'$.status')=a.status) waitChangedAt,
    CASE WHEN p.text IS NOT NULL THEN 'responding' WHEN rs.provider_session_id IS NOT NULL AND rs.provider_session_id!='' THEN 'connected' ELSE 'connecting' END phase
    FROM conversation_threads th JOIN tasks t ON t.project_id=th.project_id AND (t.conversation_thread_id=th.id OR EXISTS(
      SELECT 1 FROM coordination_steps s JOIN coordination_runs cr ON cr.run_id=s.run_id JOIN tasks parent ON parent.id=cr.task_id
      WHERE s.child_task_id=t.id AND parent.conversation_thread_id=th.id AND parent.project_id=th.project_id))
    JOIN workflow_runs r ON r.task_id=t.id JOIN agent_turns a ON a.run_id=r.id
    LEFT JOIN turn_visible_progress p ON p.turn_id=a.id LEFT JOIN runtime_sessions rs ON rs.id=a.session_id
    WHERE th.id=? AND a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')
    ORDER BY a.rowid DESC LIMIT 13`).all(threadId) as Array<Omit<ThreadVisibleProgress,'waitStartedAt'>&{execStartedAt:number|null;stageStartedAt:number|null;waitChangedAt:number|null}>;
  return rows.map(row=>({
    turnId:row.turnId,
    memberId:row.memberId,
    status:row.status,
    text:row.text,
    updatedAt:row.updatedAt,
    phase:row.phase,
    runId:row.runId,
    stage:row.stage,
    waitStartedAt:row.status==='WAITING_APPROVAL'||row.status==='WAITING_INPUT'
      ?row.waitChangedAt??row.updatedAt??row.stageStartedAt
      :row.execStartedAt??row.stageStartedAt??row.updatedAt,
  }));
}
