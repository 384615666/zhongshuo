import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { effectiveTaskWriteAccess,snapshotConversationWriteAccess } from './projectWriteAccess.ts';
import { assessTaskRedispatchReadiness } from '../persistence/stores/recoveryGuard.ts';
import { enqueueOutbox } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { randomUUID } from 'node:crypto';

export interface ConversationFacts {
  taskId:string;projectId:string;conversationId:string;threadId:string;roomId:string;
  memberId:string;rootAuthorId:string;sourceTurnId:string;sourceStopGeneration:number;
}
/** Program-confirmed ordinary answer, with no actual work or delivery. Never
 * classify a human JSON body, a task title, or a lone unvalidated model marker. */
export function conversationFacts(db:ZhongshuoDatabase,threadId:string):ConversationFacts|null {
  const task=db.prepare(`SELECT t.id taskId,t.project_id projectId,t.conversation_id conversationId,
    t.conversation_thread_id threadId,t.room_id roomId,t.owner_member_id memberId,m.author_id rootAuthorId
    FROM conversation_threads th JOIN tasks t ON t.id=th.root_task_id JOIN messages m ON m.id=th.anchor_message_id
    WHERE th.id=? AND t.kind='room_task' AND t.conversation_thread_id=th.id AND t.root_message_id=m.id
      AND t.project_id=th.project_id AND t.conversation_id=th.conversation_id AND m.author_type='human'
      AND t.owner_member_id IS NOT NULL AND t.current_delivery_id IS NULL
      AND json_extract(t.route_json,'$.kind')='dispatch' AND json_extract(t.route_json,'$.mode') IN ('DIRECT','AUTO')
      AND json_array_length(json_extract(t.route_json,'$.frozenMemberIds'))=1
      AND json_extract(t.route_json,'$.frozenMemberIds[0]')=t.owner_member_id
      AND NOT EXISTS(SELECT 1 FROM task_deliveries d WHERE d.task_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.task_id=t.id AND e.kind='changeset.finalized'
        AND (COALESCE(json_array_length(json_extract(e.payload_json,'$.added')),0)+COALESCE(json_array_length(json_extract(e.payload_json,'$.removed')),0)+COALESCE(json_array_length(json_extract(e.payload_json,'$.modified')),0))>0)`).get(threadId) as Omit<ConversationFacts,'sourceTurnId'|'sourceStopGeneration'>|undefined;
  if(!task)return null;
  const source=db.prepare(`SELECT a.id,a.stop_generation_snapshot FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
    WHERE r.task_id=? AND a.status='SUCCEEDED' AND a.member_id=? AND EXISTS(SELECT 1 FROM domain_events e
      WHERE e.turn_id=a.id AND e.task_id=r.task_id AND e.kind='turn.statusChanged'
      AND json_extract(e.payload_json,'$.status')='SUCCEEDED' AND json_extract(e.payload_json,'$.responseKind')='conversation')
    ORDER BY a.rowid DESC LIMIT 1`).get(task.taskId,task.memberId) as {id:string;stop_generation_snapshot:number}|undefined;
  return source?{...task,sourceTurnId:source.id,sourceStopGeneration:source.stop_generation_snapshot}:null;
}
export function conversationBlock(db:ZhongshuoDatabase,f:ConversationFacts,defaultKind:string|null,authorId?:string,requestSnapshot?:string):{code:string;message:string}|null {
  if(authorId!=null&&authorId!==f.rootAuthorId)return{code:'FORBIDDEN',message:'只有原发起用户可以请求该普通对话继续回答'};
  const current=db.prepare(`SELECT t.status,t.stop_generation,p.status projectStatus,r.archived_at,pm.enabled,
    th.status threadStatus FROM tasks t JOIN projects p ON p.id=t.project_id JOIN rooms r ON r.id=t.room_id
    JOIN project_members pm ON pm.id=t.owner_member_id JOIN conversation_threads th ON th.id=t.conversation_thread_id WHERE t.id=?`).get(f.taskId) as {status:string;stop_generation:number;projectStatus:string;archived_at:number|null;enabled:number;threadStatus:string}|undefined;
  if(!current||current.projectStatus!=='active'||current.archived_at!=null||current.threadStatus!=='open')return{code:'CONVERSATION_UNAVAILABLE',message:'项目、房间或对话已归档或不可执行；输入保留'};
  if(!current.enabled)return{code:'MEMBER_DISABLED',message:'原执行成员已停用；不会替换成员，输入保留'};
  if(current.status==='CANCELLED'||current.stop_generation>Math.max(0,f.sourceStopGeneration))return{code:'TASK_STOPPED',message:'该对话已停止；不会自动恢复，输入保留'};
  const recovery=assessTaskRedispatchReadiness(db,f.taskId,{queueOnly:true});if(recovery)return{code:recovery.code,message:recovery.message};
  try{const snapshot=requestSnapshot??snapshotConversationWriteAccess(db,f.taskId,defaultKind);effectiveTaskWriteAccess(db,f.taskId,f.memberId,defaultKind,snapshot);}catch(e){return{code:'CONFIGURATION_CHANGED',message:`执行配置无法使用或已变化：${(e as Error).message}；输入保留`};}
  return null;
}
export function enqueueConversationReply(db:ZhongshuoDatabase,f:ConversationFacts,messageId:string,inputSeq:number) {
  const dispatchKey=`task:${f.taskId}:conversation:${messageId}`,now=Date.now();
  const snapshot=snapshotConversationWriteAccess(db,f.taskId,process.env.ZS_RUNTIME??null);
  db.prepare(`INSERT INTO conversation_reply_requests(message_id,project_id,conversation_id,thread_id,task_id,member_id,source_turn_id,input_thread_seq,dispatch_key,write_scope_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?)`).run(messageId,f.projectId,f.conversationId,f.threadId,f.taskId,f.memberId,f.sourceTurnId,inputSeq,dispatchKey,snapshot,now,now);
  const gen=(db.prepare('SELECT stop_generation FROM tasks WHERE id=?').get(f.taskId) as {stop_generation:number}).stop_generation;
  enqueueOutbox(db,{dispatchKey,stopGenerationAtEnqueue:gen});
  db.prepare("UPDATE tasks SET status='ACTIVE',revision=revision+1 WHERE id=? AND status!='ACTIVE'").run(f.taskId);
  appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:f.projectId,conversationId:f.conversationId,threadId:f.threadId,taskId:f.taskId,kind:'conversation.replyEnqueued',createdAt:now,payload:{messageId,memberId:f.memberId,dispatchKey,sourceTurnId:f.sourceTurnId,intent:'default'}});
  return dispatchKey;
}
export interface ConversationReplyRow extends ConversationFacts {messageId:string;inputSeq:number;status:string;dispatchKey:string;writeScopeJson:string;}
export function conversationReplyForDispatch(db:ZhongshuoDatabase,key:string):ConversationReplyRow|undefined {
  return db.prepare(`SELECT q.message_id messageId,q.project_id projectId,q.conversation_id conversationId,q.thread_id threadId,q.task_id taskId,q.member_id memberId,
    q.source_turn_id sourceTurnId,q.input_thread_seq inputSeq,q.dispatch_key dispatchKey,q.status,q.write_scope_json writeScopeJson,a.stop_generation_snapshot sourceStopGeneration FROM conversation_reply_requests q JOIN agent_turns a ON a.id=q.source_turn_id WHERE q.dispatch_key=?`).get(key) as ConversationReplyRow|undefined;
}
export function setConversationReplyState(db:ZhongshuoDatabase,messageId:string,status:string,error?:string,runId?:string,turnId?:string) {
  db.prepare(`UPDATE thread_reply_requests SET status=?,error_message=?,run_id=COALESCE(run_id,?),turn_id=COALESCE(?,turn_id),updated_at=?
    WHERE message_id=? AND status IN ('queued','running')`).run(status,error?.slice(0,500)??null,runId??null,turnId??null,Date.now(),messageId);
  db.prepare(`UPDATE conversation_reply_requests SET status=?,error_message=?,run_id=COALESCE(?,run_id),turn_id=COALESCE(?,turn_id),updated_at=?
    WHERE message_id=? AND status IN ('queued','running')`).run(status,error?.slice(0,500)??null,runId??null,turnId??null,Date.now(),messageId);
}
export function settleConversationReplyForTurn(db:ZhongshuoDatabase,turnId:string,status:string,error?:string) {
  const terminal=['SUCCEEDED','FAILED','CANCELLED','UNKNOWN'];if(!terminal.includes(status))return;
  db.prepare(`UPDATE conversation_reply_requests SET status=?,error_message=?,updated_at=? WHERE turn_id=? AND status IN ('running',?)`)
    .run(status.toLowerCase(),status==='SUCCEEDED'?null:error?.slice(0,500)??(status==='UNKNOWN'?'回复结果未知；原请求保留，请查看恢复状态':status==='CANCELLED'?'回复已停止':'回复失败；查看运行详情后明确处理'),Date.now(),turnId,status.toLowerCase());
}
