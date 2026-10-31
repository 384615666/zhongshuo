import {createHash,randomUUID} from 'node:crypto';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import type {MentionNode,TopLevelRouteOutcome} from '../contracts/routing.ts';
import type {FrozenCallBudgetPolicy} from '../contracts/callBudget.ts';
import {DaemonCommandError} from './commandError.ts';
import {readThreadMembers,persistThreadMember} from './threadMembers.ts';
import {snapshotConversationWriteAccess,effectiveTaskWriteAccess} from './projectWriteAccess.ts';
import {snapshotTaskWriteAccess} from './projectWriteAccess.ts';
import {assessTaskRedispatchReadiness} from '../persistence/stores/recoveryGuard.ts';
import {enqueueOutbox} from '../persistence/outbox.ts';
import {appendDomainEvent} from '../persistence/events.ts';
import type {ConversationReplyRow} from './conversationReplies.ts';

export interface ThreadReplyScopeMember {
  memberId:string;displayName:string;description:string|null;writeScope:string|null;unavailableReason?:string;
}
export interface ThreadQuestionSource {
  taskId:string;memberId:string;eventId:string;turnId:string;messageId:string;
}
export interface ThreadReplySelection {
  questionSource?:ThreadQuestionSource;
  resumeTaskId?:string;
  memberId:string;recipientIds:string[];candidateIds:string[];inviteIds:string[];
  route:TopLevelRouteOutcome;membershipVersion:string;
}

/** Explicit @ selects recipients, never an implicit fixed deliberation mode.
 * All is scoped to this thread. An explicit individual room member is an
 * invitation, applied atomically with the message only after validation. */
export function selectThreadRecipients(
  db:ZhongshuoDatabase,
  threadId:string,
  mentions:readonly MentionNode[],
  expectedVersion?:string,
  collaboration?:'deliberate',
  source?:{replyToMessageId?:string},
):ThreadReplySelection {
  const snapshot=readThreadMembers(db,threadId);
  if(expectedVersion&&expectedVersion!==snapshot.version)throw new DaemonCommandError('STALE_REVISION','本串成员已变化，请刷新名单后再发送；输入保留');
  const th=db.prepare('SELECT root_task_id FROM conversation_threads WHERE id=?').get(threadId) as {root_task_id:string|null};
  const owner=th.root_task_id?(db.prepare('SELECT owner_member_id FROM tasks WHERE id=?').get(th.root_task_id) as {owner_member_id:string|null})?.owner_member_id:null;
  const all=mentions.some(m=>m.kind==='all');
  const explicit=[...new Set(mentions.flatMap(m=>m.kind==='member'?[m.memberId]:[]))];
  // Order by the persisted question event, never by text or task creation time.
  const waitingChildren=db.prepare(`SELECT t.id,t.owner_member_id,e.event_id,e.turn_id,e.seq,m.id message_id
    FROM tasks t JOIN coordination_steps s ON s.child_task_id=t.id
    JOIN coordination_runs c ON c.run_id=s.run_id JOIN tasks parent ON parent.id=c.task_id
    JOIN domain_events e ON e.task_id=t.id AND e.kind='turn.workClarification'
    JOIN agent_turns a ON a.id=e.turn_id AND a.member_id=t.owner_member_id
    JOIN messages m ON m.id=(SELECT json_extract(reply.payload_json,'$.messageId') FROM domain_events reply
      JOIN messages visible ON visible.id=json_extract(reply.payload_json,'$.messageId') AND visible.author_type='agent'
      WHERE reply.turn_id=e.turn_id AND reply.kind='thread.replyAdded' ORDER BY reply.seq DESC LIMIT 1)
      AND m.task_id=t.id AND m.thread_id=?
      AND m.author_type='agent' AND m.author_id=t.owner_member_id
    WHERE t.parent_task_id=? AND t.conversation_thread_id=? AND t.status='WAITING_USER' AND c.state='running'
      AND parent.status NOT IN ('DONE','CANCELLED') AND parent.stop_generation=c.stop_generation
      AND e.run_id=(SELECT id FROM workflow_runs WHERE task_id=t.id ORDER BY rowid DESC LIMIT 1)
      AND e.seq=(SELECT MAX(seq) FROM domain_events WHERE task_id=t.id AND kind='turn.workClarification')
    ORDER BY e.seq`).all(threadId,th.root_task_id,threadId) as Array<{id:string;owner_member_id:string;event_id:string;turn_id:string;seq:number;message_id:string}>;
  const occupied=(id:string)=>Boolean(db.prepare(`SELECT 1 FROM thread_reply_requests
    WHERE task_id=? AND status IN ('queued','running','unknown') LIMIT 1`).get(id));
  const referenced=source?.replyToMessageId;
  let resumeChild:typeof waitingChildren[number]|undefined;
  if(referenced){
    resumeChild=waitingChildren.find(child=>child.message_id===referenced);
    // An ordinary citation stays an ordinary reply. A citation to a coordination
    // child must identify its current, unanswered question; stale citations fail closed.
    const childReference=db.prepare(`SELECT 1 FROM messages m JOIN tasks t ON t.id=m.task_id
      JOIN coordination_steps s ON s.child_task_id=t.id WHERE m.id=?`).get(referenced);
    if(resumeChild||childReference){
      if(!resumeChild||all||explicit.length>1||collaboration==='deliberate'
        ||explicit.length===1&&explicit[0]!==resumeChild.owner_member_id||occupied(resumeChild.id))
        throw new DaemonCommandError('STALE_REVISION','引用的问题已变化或已有答复，请刷新后发送；输入保留');
    }
  }
  if(!resumeChild&&!all&&explicit.length<=1&&collaboration!=='deliberate'){
    const pending=waitingChildren.filter(child=>(!explicit.length||explicit[0]===child.owner_member_id)&&!occupied(child.id));
    if(new Set(pending.map(child=>child.owner_member_id)).size>1)
      throw new DaemonCommandError('VALIDATION_INVALID','有多位 AI 正在等你答复，请在输入框 @ 本次要答复的 AI；原输入已保留。');
    resumeChild=pending[0];
    if(!resumeChild&&waitingChildren.some(child=>!explicit.length||explicit[0]===child.owner_member_id))
      throw new DaemonCommandError('STALE_REVISION','待确认的问题已有答复正在处理，请稍候；输入保留');
  }
  const available=(db.prepare(`SELECT pm.id FROM room_members rm JOIN project_members pm ON pm.id=rm.member_id
    WHERE rm.room_id=? AND pm.project_id=? AND pm.enabled=1 AND pm.principal_type='agent' ORDER BY pm.id`).all(snapshot.roomId,snapshot.projectId) as {id:string}[]).map(m=>m.id);
  if(!all&&explicit.some(id=>!available.includes(id)))throw new DaemonCommandError('MEMBER_UNAVAILABLE','请选择本房间可用的 AI；输入保留');
  if(collaboration==='deliberate'){
    const outside=explicit.filter(id=>!snapshot.eligibleMemberIds.includes(id));
    if(outside.length>0)throw new DaemonCommandError('MEMBER_UNAVAILABLE','独立研讨只使用本回复串当前可用的 AI；请先在本串添加成员，输入保留');
    const frozen=all||explicit.length===0?[...snapshot.eligibleMemberIds]:explicit;
    if(frozen.length<2){
      throw new DaemonCommandError(
        'VALIDATION_INVALID',
        snapshot.eligibleMemberIds.length===0
          ? '本回复串当前没有可用 AI；请先添加至少两位成员，输入保留'
          : '本回复串至少需要两位可用 AI 才能独立研讨；请添加成员后重试，输入保留',
      );
    }
    const roomCoordinator=(db.prepare('SELECT coordinator_member_id FROM rooms WHERE id=?').get(snapshot.roomId) as {coordinator_member_id:string|null})?.coordinator_member_id;
    const memberId=owner&&frozen.includes(owner)?owner:roomCoordinator&&frozen.includes(roomCoordinator)?roomCoordinator:frozen[0]!;
    const route:TopLevelRouteOutcome={
      kind:'dispatch',
      mode:'DELIBERATE',
      rosterSource:all?'all':'selected',
      frozenMemberIds:frozen,
      initialWakeMemberIds:[memberId,...frozen.filter(id=>id!==memberId)],
    };
    return{memberId,recipientIds:frozen,candidateIds:frozen,inviteIds:[],route,membershipVersion:snapshot.version};
  }
  const recipientIds=resumeChild?[resumeChild.owner_member_id]:all?[...snapshot.eligibleMemberIds]:explicit.length?explicit:[owner&&snapshot.eligibleMemberIds.includes(owner)?owner:snapshot.eligibleMemberIds[0]].filter((id):id is string=>Boolean(id));
  if(!recipientIds.length)throw new DaemonCommandError(snapshot.memberIds.length?'MEMBER_DISABLED':'MEMBER_UNAVAILABLE',snapshot.memberIds.length?'本串没有可用的 AI，请启用成员或添加其他 AI':'请先为本串添加一位可用的 AI');
  const roomCoordinator=(db.prepare('SELECT coordinator_member_id FROM rooms WHERE id=?').get(snapshot.roomId) as {coordinator_member_id:string|null})?.coordinator_member_id;
  const memberId=owner&&recipientIds.includes(owner)?owner:roomCoordinator&&recipientIds.includes(roomCoordinator)?roomCoordinator:recipientIds[0]!;
  const inviteIds=all?[]:explicit.filter(id=>!snapshot.memberIds.includes(id));
  const removed=(db.prepare("SELECT member_id FROM thread_agent_followers WHERE thread_id=? AND status!='following'").all(threadId) as {member_id:string}[]).map(m=>m.member_id);
  const candidateIds=!all&&explicit.length<2?available.filter(id=>explicit.includes(id)||!removed.includes(id)):recipientIds;
  const explicitScope=all||explicit.length>1;
  const route:TopLevelRouteOutcome=recipientIds.length===1&&(resumeChild!=null||explicit.length===1||candidateIds.length===1)
    ?{kind:'dispatch',mode:'DIRECT',targetMemberId:memberId,frozenMemberIds:recipientIds,initialWakeMemberIds:[memberId]}
    :{kind:'dispatch',mode:'AUTO',coordinatorMemberId:memberId,...(explicitScope?{participantScope:'selected' as const}:{}),...(all?{dispatchStyle:'broadcast' as const}:{}),frozenMemberIds:recipientIds,initialWakeMemberIds:all?recipientIds:[memberId]};
  return{memberId,recipientIds,candidateIds:resumeChild?recipientIds:candidateIds,inviteIds,route,membershipVersion:snapshot.version,...(resumeChild?{resumeTaskId:resumeChild.id,questionSource:{taskId:resumeChild.id,memberId:resumeChild.owner_member_id,eventId:resumeChild.event_id,turnId:resumeChild.turn_id,messageId:resumeChild.message_id}}:{})};
}

export interface GeneralThreadReply extends ConversationReplyRow {
  isGeneral:true;routeJson:string;rosterJson:string;membershipVersion:string;
  sourceDeliveryId:string|null;sourceTaskStatus:string;
  deliberationBudgetJson:string|null;dispatchIdentity:string;resultMessageId:string|null;
}

export function assertThreadTaskReady(db:ZhongshuoDatabase,threadId:string){
  const task=db.prepare(`SELECT t.id,t.status FROM conversation_threads th JOIN tasks t ON t.id=th.root_task_id WHERE th.id=?`).get(threadId) as {id:string;status:string}|undefined;
  if(!task)return;
  if(task.status==='CANCELLED')throw new DaemonCommandError('TASK_STOPPED','该任务已停止，请明确选择新的工作；输入保留');
  const blocked=assessTaskRedispatchReadiness(db,task.id,{queueOnly:true});
  if(blocked)throw new DaemonCommandError(blocked.code,blocked.message);
}

/** Explicitly requesting an AI in a record thread creates its first task, not
 * another human/root message. The old record and its local-only attachments
 * remain untouched; the new request is the task input anchor. */
export function createTaskForRecordThread(db:ZhongshuoDatabase,threadId:string,messageId:string,title:string,selection:ThreadReplySelection,reviewPolicy:'auto_deliver'|'user_review'){
  const th=db.prepare('SELECT project_id,conversation_id,room_id,root_task_id FROM conversation_threads WHERE id=?').get(threadId) as {project_id:string;conversation_id:string;room_id:string;root_task_id:string|null};
  if(th.root_task_id)return th.root_task_id;
  const taskId=`task_${randomUUID()}`,number=(db.prepare('SELECT COALESCE(MAX(room_task_number),0)+1 n FROM tasks WHERE room_id=?').get(th.room_id) as {n:number}).n;
  db.prepare(`INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,room_task_number,owner_member_id,title,status,review_policy,route_json)
    VALUES(?,?,?,'room_task',?,?,?,?,?,?,'OPEN',?,?)`).run(taskId,th.project_id,th.conversation_id,th.room_id,threadId,messageId,number,selection.memberId,title,reviewPolicy,JSON.stringify(selection.route));
  db.prepare('UPDATE conversation_threads SET root_task_id=?,revision=revision+1 WHERE id=? AND root_task_id IS NULL').run(taskId,threadId);
  db.prepare('UPDATE messages SET task_id=? WHERE id=? AND thread_id=?').run(taskId,messageId,threadId);
  snapshotTaskWriteAccess(db,taskId);
  appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:th.project_id,conversationId:th.conversation_id,threadId,taskId,kind:'task.created',createdAt:Date.now(),payload:{source:'thread-message',messageId}});
  return taskId;
}

/** Original task, anchor and older request envelopes are never rewritten. */
export function enqueueThreadReply(
  db:ZhongshuoDatabase,
  threadId:string,
  messageId:string,
  inputSeq:number,
  selection:ThreadReplySelection,
  authorId:string,
  callBudgetSnapshot?:{maxTurns:number;callBudget:FrozenCallBudgetPolicy},
){
  const th=db.prepare(`SELECT th.project_id,th.conversation_id,th.room_id,th.root_task_id,t.stop_generation,t.status,t.current_delivery_id
    FROM conversation_threads th JOIN tasks t ON t.id=th.root_task_id WHERE th.id=?`).get(threadId) as {project_id:string;conversation_id:string;room_id:string;root_task_id:string;stop_generation:number;status:string;current_delivery_id:string|null};
  if(selection.resumeTaskId){
    const child=db.prepare(`SELECT id,stop_generation,status,current_delivery_id FROM tasks
      WHERE id=? AND parent_task_id=? AND conversation_thread_id=? AND status='WAITING_USER' AND owner_member_id=?`)
      .get(selection.resumeTaskId,th.root_task_id,threadId,selection.memberId) as {id:string;stop_generation:number;status:string;current_delivery_id:string|null}|undefined;
    if(!child)throw new DaemonCommandError('STALE_REVISION','待答复的步骤已变化，请刷新后发送；输入保留');
    const bound=db.prepare('UPDATE messages SET task_id=? WHERE id=? AND thread_id=? AND task_id=?')
      .run(child.id,messageId,threadId,th.root_task_id);
    if(bound.changes!==1)throw new DaemonCommandError('THREAD_SCOPE_MISMATCH','答复消息与当前任务不匹配；未派发');
    Object.assign(th,{root_task_id:child.id,stop_generation:child.stop_generation,status:child.status,current_delivery_id:child.current_delivery_id});
  }
  if(selection.questionSource){
    const current=selectThreadRecipients(db,threadId,[{kind:'member',memberId:selection.memberId}],undefined,undefined,{replyToMessageId:selection.questionSource.messageId});
    if(JSON.stringify(current.questionSource)!==JSON.stringify(selection.questionSource))
      throw new DaemonCommandError('STALE_REVISION','待答复的问题已变化；输入保留');
  }
  const frozenRoute={...selection.route,...(selection.questionSource?{questionSource:selection.questionSource}:{})};
  const roster=selection.candidateIds.map(memberId=>{
    const member=db.prepare('SELECT display_name,description FROM project_members WHERE id=? AND project_id=?').get(memberId,th.project_id) as {display_name:string;description:string|null};
    try{return{memberId,displayName:member.display_name,description:member.description,writeScope:snapshotConversationWriteAccess(db,th.root_task_id,process.env.ZS_RUNTIME??null,memberId)};}
    catch(error){
      if(memberId===selection.memberId)throw error;
      return{memberId,displayName:member.display_name,description:member.description,writeScope:null,unavailableReason:String(error)};
    }
  });
  for(const id of selection.inviteIds)persistThreadMember(db,threadId,id,'add',authorId);
  const source=db.prepare(`SELECT a.id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? ORDER BY a.rowid DESC LIMIT 1`).get(th.root_task_id) as {id:string}|undefined;
  const writeScope=roster.find(m=>m.memberId===selection.memberId)!.writeScope;
  const now=Date.now(),dispatchKey=`task:${th.root_task_id}:thread-reply:${messageId}`;
  const budgetJson=selection.route.kind==='dispatch'&&callBudgetSnapshot!=null
    ?JSON.stringify(callBudgetSnapshot)
    :null;
  const membershipVersion=readThreadMembers(db,threadId).version;
  const dispatchIdentity=createHash('sha256').update(JSON.stringify({
    version:1,
    messageId,
    route:frozenRoute,
    roster:roster.map(member=>member.memberId),
    membershipVersion,
    callBudgetSnapshot:callBudgetSnapshot??null,
  })).digest('hex');
  db.prepare(`INSERT INTO thread_reply_requests(message_id,project_id,conversation_id,thread_id,task_id,member_id,
    source_turn_id,stop_generation,input_thread_seq,dispatch_key,route_json,roster_json,write_scope_json,membership_version,
    source_delivery_id,source_task_status,deliberation_budget_json,dispatch_identity,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`)
    .run(messageId,th.project_id,th.conversation_id,threadId,th.root_task_id,selection.memberId,selection.questionSource?.turnId??source?.id??null,th.stop_generation,inputSeq,dispatchKey,
      JSON.stringify(frozenRoute),JSON.stringify(roster),writeScope,membershipVersion,th.current_delivery_id,th.status,budgetJson,dispatchIdentity,now,now);
  enqueueOutbox(db,{dispatchKey,stopGenerationAtEnqueue:th.stop_generation});
  // The request is queued independently; don't turn an accepted delivery into an
  // unaccepted one or replace its version just because the user asks a question.
  appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:th.project_id,conversationId:th.conversation_id,threadId,taskId:th.root_task_id,
    kind:'thread.replyEnqueued',createdAt:now,payload:{messageId,memberId:selection.memberId,recipientIds:selection.recipientIds,dispatchKey}});
  return dispatchKey;
}

export function threadReplyForDispatch(db:ZhongshuoDatabase,key:string):GeneralThreadReply|undefined {
  const row=db.prepare(`SELECT q.message_id messageId,q.project_id projectId,q.conversation_id conversationId,q.thread_id threadId,q.task_id taskId,q.member_id memberId,
    COALESCE(q.source_turn_id,'') sourceTurnId,q.input_thread_seq inputSeq,q.dispatch_key dispatchKey,q.status,q.write_scope_json writeScopeJson,
    q.stop_generation sourceStopGeneration,th.room_id roomId,m.author_id rootAuthorId,q.route_json routeJson,q.roster_json rosterJson,
    q.membership_version membershipVersion,q.source_delivery_id sourceDeliveryId,q.source_task_status sourceTaskStatus,
    q.deliberation_budget_json deliberationBudgetJson,q.dispatch_identity dispatchIdentity,q.result_message_id resultMessageId
    FROM thread_reply_requests q JOIN conversation_threads th ON th.id=q.thread_id JOIN messages m ON m.id=th.anchor_message_id
    WHERE q.dispatch_key=?`).get(key) as Omit<GeneralThreadReply,'isGeneral'>|undefined;
  return row?{...row,isGeneral:true}:undefined;
}

export function threadReplyBlock(db:ZhongshuoDatabase,q:GeneralThreadReply,defaultKind:string|null,authorId?:string):{code:string;message:string}|null {
  if(authorId&&authorId!==q.rootAuthorId)return{code:'FORBIDDEN',message:'这段对话不属于当前用户'};
  const t=db.prepare(`SELECT t.project_id,t.conversation_id,t.conversation_thread_id,t.status,t.stop_generation,t.current_delivery_id,
    th.root_task_id,th.status threadStatus,p.status projectStatus,r.archived_at FROM tasks t JOIN projects p ON p.id=t.project_id
    JOIN conversation_threads th ON th.id=t.conversation_thread_id JOIN rooms r ON r.id=th.room_id WHERE t.id=?`).get(q.taskId) as {project_id:string;conversation_id:string;conversation_thread_id:string;status:string;stop_generation:number;current_delivery_id:string|null;root_task_id:string;threadStatus:string;projectStatus:string;archived_at:number|null}|undefined;
  const childTarget=t&&t.root_task_id!==q.taskId?db.prepare(`SELECT 1 FROM coordination_steps s
    JOIN coordination_runs c ON c.run_id=s.run_id JOIN tasks parent ON parent.id=c.task_id
    JOIN tasks child ON child.id=s.child_task_id WHERE child.id=? AND child.parent_task_id=? AND child.owner_member_id=?
      AND c.state='running' AND parent.status NOT IN ('DONE','CANCELLED') AND parent.stop_generation=c.stop_generation`).get(q.taskId,t.root_task_id,q.memberId):null;
  if(!t||t.project_id!==q.projectId||t.conversation_id!==q.conversationId||t.conversation_thread_id!==q.threadId||(t.root_task_id!==q.taskId&&!childTarget))return{code:'THREAD_SCOPE_MISMATCH',message:'对话目标已变化；输入保留'};
  if(t.threadStatus!=='open'||t.projectStatus!=='active'||t.archived_at!=null)return{code:'CONVERSATION_UNAVAILABLE',message:'项目或对话已归档；输入保留'};
  if(t.status==='CANCELLED'||t.stop_generation!==q.sourceStopGeneration)return{code:'TASK_STOPPED',message:'这条请求之前的任务已停止；不会自动继续'};
  const frozen=JSON.parse(q.routeJson) as {questionSource?:ThreadQuestionSource};
  if(frozen.questionSource){
    const source=frozen.questionSource;
    const event=db.prepare(`SELECT e.event_id,e.turn_id,m.id message_id FROM domain_events e
      JOIN agent_turns a ON a.id=e.turn_id AND a.member_id=?
      JOIN messages m ON m.id=(SELECT json_extract(reply.payload_json,'$.messageId') FROM domain_events reply
        JOIN messages visible ON visible.id=json_extract(reply.payload_json,'$.messageId') AND visible.author_type='agent'
        WHERE reply.turn_id=e.turn_id AND reply.kind='thread.replyAdded' ORDER BY reply.seq DESC LIMIT 1) AND m.task_id=e.task_id AND m.thread_id=? AND m.author_id=a.member_id AND m.author_type='agent'
      WHERE e.task_id=? AND e.kind='turn.workClarification'
        AND e.seq=(SELECT MAX(seq) FROM domain_events WHERE task_id=e.task_id AND kind='turn.workClarification') ORDER BY e.seq DESC LIMIT 1`).get(q.memberId,q.threadId,q.taskId) as {event_id:string;turn_id:string;message_id:string}|undefined;
    const advanced=db.prepare(`SELECT 1 FROM workflow_runs WHERE task_id=? AND id!=(SELECT run_id FROM agent_turns WHERE id=?)
      AND id!=COALESCE((SELECT run_id FROM thread_reply_requests WHERE message_id=?),'')
      AND rowid>(SELECT rowid FROM workflow_runs WHERE id=(SELECT run_id FROM agent_turns WHERE id=?)) LIMIT 1`).get(q.taskId,source.turnId,q.messageId,source.turnId);
    if(source.taskId!==q.taskId||source.memberId!==q.memberId||source.turnId!==q.sourceTurnId||!event||event.event_id!==source.eventId
      ||event.turn_id!==source.turnId||event.message_id!==source.messageId||advanced
      ||!(t.status==='WAITING_USER'||t.status==='ACTIVE'&&db.prepare("SELECT 1 FROM thread_reply_requests WHERE message_id=? AND status='running' AND run_id IS NOT NULL").get(q.messageId)))
      return{code:'STALE_REVISION',message:'待答复的问题已解决或变化；不会重放旧答复'};
  }
  // This is an ordinary user message, not task.review/executeRework. Its target
  // and accepted facts stay frozen, while execution assembles the then-current
  // factual delivery in its immutable input bundle. A preceding queued task's
  // natural delivery must not make the user send the same question again.
  const recovery=assessTaskRedispatchReadiness(db,q.taskId,{queueOnly:true});if(recovery)return recovery;
  const eligible=readThreadMembers(db,q.threadId).eligibleMemberIds;
  const roster=JSON.parse(q.rosterJson) as ThreadReplyScopeMember[];
  const route=JSON.parse(q.routeJson) as {mode:string;participantScope?:string;frozenMemberIds:string[]};
  const required=route.mode==='DELIBERATE'||route.participantScope==='selected'?route.frozenMemberIds:[q.memberId];
  if(required.some(id=>!eligible.includes(id)))return{code:'MEMBER_UNAVAILABLE',message:'本次请求中的 AI 已移出或停用，请调整成员后重新发送'};
  try{for(const member of roster.filter(m=>required.includes(m.memberId)))effectiveTaskWriteAccess(db,q.taskId,member.memberId,defaultKind,member.writeScope??undefined);}
  catch(error){return{code:'CONFIGURATION_CHANGED',message:`AI 配置已变化，请确认配置后重新发送；${(error as Error).message}`};}
  return null;
}

export function setThreadReplyState(db:ZhongshuoDatabase,messageId:string,status:string,error?:string,runId?:string,turnId?:string){
  db.prepare(`UPDATE thread_reply_requests SET status=?,error_message=?,run_id=COALESCE(run_id,?),turn_id=COALESCE(?,turn_id),updated_at=?
    WHERE message_id=? AND status IN ('queued','running',?)`).run(status,error?.slice(0,500)??null,runId??null,turnId??null,Date.now(),messageId,status);
}

/** Bind one frozen request to its own DELIBERATE run. A stale request cannot
 * overwrite a terminal state, and a different active run is never adopted. */
export function bindThreadReplyRun(db:ZhongshuoDatabase,messageId:string,runId:string):void{
  db.prepare(`UPDATE thread_reply_requests SET run_id=?,status='running',error_message=NULL,updated_at=?
    WHERE message_id=? AND status IN ('queued','running') AND (run_id IS NULL OR run_id=?)`)
    .run(runId,Date.now(),messageId,runId);
}

export function settleThreadReplyForRun(
  db:ZhongshuoDatabase,
  runId:string,
  status:'succeeded'|'failed'|'cancelled'|'unknown',
  error?:string,
  resultMessageId?:string,
):void{
  db.prepare(`UPDATE thread_reply_requests
    SET status=?,error_message=?,result_message_id=COALESCE(?,result_message_id),updated_at=?
    WHERE run_id=? AND status IN ('queued','running')`)
    .run(status,error?.slice(0,500)??null,resultMessageId??null,Date.now(),runId);
}

export function settleThreadReplyForTurn(db:ZhongshuoDatabase,turnId:string,status:string,error?:string){
  const q=db.prepare(`SELECT q.message_id,q.run_id FROM thread_reply_requests q WHERE q.turn_id=? OR q.run_id IN(
    SELECT coordination_run_id FROM coordination_integration_attempts WHERE execution_run_id=(SELECT run_id FROM agent_turns WHERE id=?))`).get(turnId,turnId) as {message_id:string;run_id:string}|undefined;
  if(!q)return;
  const coordination=db.prepare('SELECT state FROM coordination_runs WHERE run_id=?').get(q.run_id) as {state:string}|undefined;
  if(status==='SUCCEEDED'&&coordination&&!['completed','blocked','cancelled'].includes(coordination.state))return;
  setThreadReplyState(db,q.message_id,status==='SUCCEEDED'?'succeeded':status==='CANCELLED'?'cancelled':status==='UNKNOWN'?'unknown':'failed',error??(status==='SUCCEEDED'?undefined:status==='UNKNOWN'?'发送结果待确认，原请求保留':status==='CANCELLED'?'回复已停止':'AI 未完成回复，请查看任务详情'));
}
