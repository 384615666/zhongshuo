import type {ZhongshuoDatabase} from '../persistence/db.ts';
import type {SendLookupRequest,SendLookupResult} from '../contracts/sendRecovery.ts';
import {computeCommandPayloadHash} from '../domain/idempotency.ts';
import {DaemonCommandError} from './commandError.ts';

/** The authenticated caller supplies no idempotency scope; this path never dispatches. */
export function lookupSubmittedMessage(db:ZhongshuoDatabase,userId:string,input:SendLookupRequest):SendLookupResult{
  const expected=computeCommandPayloadHash({method:'message.submit',target:null,params:input.request.params,expectedRevision:input.request.expectedRevision??null});
  if(expected!==input.payloadHash)throw new DaemonCommandError('IDEMPOTENCY_CONFLICT','原发送参数与冻结摘要不一致；没有重新发送');
  const receipt=db.prepare('SELECT payload_hash,result_json,created_at FROM command_receipts WHERE idempotency_scope=? AND command_id=?').get(`user:${userId}`,input.request.commandId) as {payload_hash:string;result_json:string|null;created_at:number}|undefined;
  const identity={commandId:input.request.commandId,payloadHash:expected};
  if(!receipt)return{...identity,status:'not-found',message:'尚未查到原发送回执。这不证明未发送；原信封与草稿保留，没有重新发送。'};
  if(receipt.payload_hash!==expected)throw new DaemonCommandError('IDEMPOTENCY_CONFLICT','同一命令号的原回执与本次引用不匹配；没有重新发送');
  if(receipt.result_json==null)return{...identity,status:'expired',message:'原回执正文已过期；原请求不会重新执行，请从原会话核对历史。'};
  const result=JSON.parse(receipt.result_json) as {messageId?:unknown;taskId?:unknown;threadId?:unknown;conversationId?:unknown};
  if(typeof result.messageId!=='string')throw new DaemonCommandError('RESOURCE_NOT_FOUND','原回执没有可验证的消息引用');
  const target=input.request.params.target as {kind:string;projectId:string;conversationId:string;roomId?:string;threadId?:string};
  const message=db.prepare(`SELECT m.project_id,m.conversation_id,m.room_id,m.thread_id,m.author_id,m.author_type,m.task_id,
    th.id resolved_thread_id,th.anchor_message_id,th.root_task_id FROM messages m LEFT JOIN conversation_threads th ON th.id=m.thread_id OR th.anchor_message_id=m.id WHERE m.id=?`).get(result.messageId) as {project_id:string;conversation_id:string;room_id:string|null;thread_id:string|null;resolved_thread_id:string|null;author_id:string;author_type:string;task_id:string|null;anchor_message_id:string|null;root_task_id:string|null}|undefined;
  if(!message||message.project_id!==target.projectId||message.conversation_id!==target.conversationId||message.author_type!=='human'||message.author_id!==userId
    ||target.kind==='room_root'&&(message.room_id!==target.roomId||message.anchor_message_id!==result.messageId)
    ||target.kind==='thread'&&message.thread_id!==target.threadId
    ||target.kind==='dm'&&(message.room_id!=null||message.thread_id!=null)
    ||result.threadId!=null&&result.threadId!==message.resolved_thread_id
    ||result.conversationId!=null&&result.conversationId!==message.conversation_id){
    throw new DaemonCommandError('RESOURCE_NOT_FOUND','原发送回执与目标会话或消息归属不一致');
  }
  const taskId=typeof result.taskId==='string'?result.taskId:message.task_id??message.root_task_id;
  if(typeof result.taskId==='string'&&message.task_id!=null&&result.taskId!==message.task_id)throw new DaemonCommandError('RESOURCE_NOT_FOUND','原回执任务与原消息绑定不一致');
  if(taskId&&!db.prepare('SELECT 1 FROM tasks WHERE id=? AND project_id=? AND conversation_id=?').get(taskId,target.projectId,target.conversationId))throw new DaemonCommandError('RESOURCE_NOT_FOUND','原任务归属与发送会话不一致');
  return{...identity,status:'found',acceptedAt:receipt.created_at,location:{projectId:message.project_id,conversationId:message.conversation_id,roomId:message.room_id,threadId:message.resolved_thread_id,messageId:result.messageId,taskId}};
}
