/**
 * R93: host one complete Markdown detail as an immutable, app-managed attachment.
 *
 * The model never needs project write permission. A successfully validated answer is
 * bound to a formal message first; this helper then writes the bytes into the existing
 * content-addressed blobstore and inserts artifacts/message_attachments rows. The full
 * file is never split into user-visible cards.
 */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ZhongshuoDatabase} from '../persistence/db.ts';
import {atomicWriteFile} from '../contracts/atomicFile.ts';
import {ATT_MAX_BYTES} from './attachments.ts';
import {isSafeDocumentFilename} from '../contracts/document.ts';

export const DETAIL_MARKDOWN_MAX_BYTES=ATT_MAX_BYTES;
export const DETAIL_ATTACHMENT_ID_PREFIX='matt_detail_';
export const DETAIL_ARTIFACT_ID_PREFIX='art_detail_';

export interface DetailMarkdownPersistInput {
  db:ZhongshuoDatabase;
  appDataDir:string;
  projectId:string;
  conversationId:string;
  threadId:string|null;
  taskId:string;
  runId:string;
  turnId:string;
  messageId:string;
  memberId:string;
  markdown:string;
  /** New model-authored document basename; omitted for legacy detail fallback. */
  filename?:string;
  now?:number;
}

export type DetailMarkdownPersistResult =
  | {status:'ready';artifactId:string;attachmentId:string;filename:string;hash:string;bytes:number;blobPath:string;reused:boolean}
  | {status:'too-large';bytes:number;maxBytes:number;message:string}
  | {status:'failed';code:string;message:string};

const sha256=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');

/** Persist exactly one full detail file. Caller must run this before final DONE/queued integration. */
export function persistDetailMarkdown(input:DetailMarkdownPersistInput):DetailMarkdownPersistResult{
  const bytes=Buffer.from(input.markdown,'utf8');
  if(bytes.length===0||input.markdown.trim().length===0)return{status:'failed',code:'EMPTY_DETAIL',message:'详情为空'};
  const filename=input.filename??'完整详情.md';
  if(!isSafeDocumentFilename(filename))return{status:'failed',code:'INVALID_FILENAME',message:'文档文件名不安全'};
  if(bytes.length>DETAIL_MARKDOWN_MAX_BYTES)return{status:'too-large',bytes:bytes.length,maxBytes:DETAIL_MARKDOWN_MAX_BYTES,message:'完整详情超过托管文本上限；保留原文，不生成附件'};
  const message=input.db.prepare(
    `SELECT id,project_id,conversation_id,thread_id,task_id,author_type,author_id,status
       FROM messages WHERE id=?`,
  ).get(input.messageId) as {id:string;project_id:string;conversation_id:string;thread_id:string|null;task_id:string|null;author_type:string;author_id:string;status:string}|undefined;
  if(message==null)return{status:'failed',code:'MESSAGE_MISSING',message:'最终消息不存在'};
  if(message.project_id!==input.projectId||message.conversation_id!==input.conversationId||message.thread_id!==input.threadId
    ||message.task_id!==input.taskId||message.author_type!=='agent'||message.author_id!==input.memberId||message.status!=='final'){
    return{status:'failed',code:'IDENTITY_MISMATCH',message:'最终消息归属与详情作者/任务不一致'};
  }
  const task=input.db.prepare('SELECT project_id,conversation_id,conversation_thread_id,kind,owner_member_id FROM tasks WHERE id=?').get(input.taskId) as
    {project_id:string;conversation_id:string;conversation_thread_id:string|null;kind:string;owner_member_id:string}|undefined;
  if(task==null||task.project_id!==input.projectId||task.conversation_id!==input.conversationId||task.conversation_thread_id!==input.threadId){
    return{status:'failed',code:'TASK_IDENTITY_MISMATCH',message:'任务身份与详情绑定不一致'};
  }
  const run=input.db.prepare('SELECT task_id FROM workflow_runs WHERE id=?').get(input.runId) as {task_id:string}|undefined;
  if(run?.task_id!==input.taskId)return{status:'failed',code:'RUN_IDENTITY_MISMATCH',message:'运行身份与详情任务不一致'};
  const turn=input.db.prepare(`SELECT a.run_id,a.member_id,r.task_id
    FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE a.id=?`).get(input.turnId) as
    {run_id:string;member_id:string;task_id:string}|undefined;
  if(turn==null||turn.run_id!==input.runId||turn.member_id!==input.memberId||turn.task_id!==input.taskId){
    return{status:'failed',code:'TURN_IDENTITY_MISMATCH',message:'轮次身份与详情运行/成员/任务不一致'};
  }

  const hash=sha256(bytes);
  const messageKey=sha256(input.messageId).slice(0,16);
  const artifactId=`${DETAIL_ARTIFACT_ID_PREFIX}${messageKey}_${hash.slice(0,16)}`;
  const attachmentId=`${DETAIL_ATTACHMENT_ID_PREFIX}${sha256(`${input.messageId}\0${artifactId}`).slice(0,24)}`;
  const blobDir=join(input.appDataDir,'blobstore');
  const blobPath=join(blobDir,`${hash}.txt`);
  let reusedBlob=false;
  try{
    mkdirSync(blobDir,{recursive:true});
    if(existsSync(blobPath)){
      const existing=readFileSync(blobPath);
      if(sha256(existing)!==hash)return{status:'failed',code:'BLOB_CONFLICT',message:'内容寻址副本与本次详情不一致'};
      reusedBlob=true;
    }else atomicWriteFile(blobPath,bytes);
  }catch(error){
    return{status:'failed',code:'BLOB_WRITE_FAILED',message:`托管详情写入失败：${(error as Error).message}`};
  }
  const now=input.now??Date.now();
  try{
    const tx=input.db.transaction(()=>{
      const artifact=input.db.prepare('SELECT id,project_id,conversation_id,thread_id,task_id,run_id,author_id,kind,revision,hash,blob_path,source_name FROM artifacts WHERE id=?').get(artifactId) as
        {id:string;project_id:string;conversation_id:string|null;thread_id:string|null;task_id:string|null;run_id:string|null;author_id:string;kind:string;revision:number;hash:string;blob_path:string;source_name:string|null}|undefined;
      if(artifact==null){
        input.db.prepare(
          `INSERT INTO artifacts (id,project_id,conversation_id,thread_id,task_id,run_id,author_id,kind,revision,hash,blob_path,source_name,created_at)
           VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`,
        ).run(artifactId,input.projectId,input.conversationId,input.threadId,input.taskId,input.runId,input.memberId,'text_file',hash,blobPath,filename,now);
      }else if(artifact.project_id!==input.projectId||artifact.conversation_id!==input.conversationId||artifact.thread_id!==input.threadId
        ||artifact.task_id!==input.taskId||artifact.run_id!==input.runId||artifact.author_id!==input.memberId
        ||artifact.kind!=='text_file'||artifact.hash!==hash||artifact.blob_path!==blobPath||artifact.source_name!==filename){
        throw Object.assign(new Error('detail artifact identity mismatch'),{code:'ARTIFACT_IDENTITY_MISMATCH'});
      }
      const attached=input.db.prepare('SELECT id,message_id,thread_id,artifact_id,display_name,mime_type,source_hash FROM message_attachments WHERE id=?').get(attachmentId) as
        {id:string;message_id:string;thread_id:string|null;artifact_id:string;display_name:string;mime_type:string|null;source_hash:string}|undefined;
      if(attached==null){
        input.db.prepare(
          'INSERT INTO message_attachments (id,message_id,thread_id,artifact_id,display_name,mime_type,source_hash) VALUES (?,?,?,?,?,?,?)',
        ).run(attachmentId,input.messageId,input.threadId,artifactId,filename,'text/markdown',hash);
      }else if(attached.message_id!==input.messageId||attached.thread_id!==input.threadId||attached.artifact_id!==artifactId
        ||attached.display_name!==filename||attached.mime_type!=='text/markdown'||attached.source_hash!==hash){
        throw Object.assign(new Error('detail attachment identity mismatch'),{code:'ATTACHMENT_IDENTITY_MISMATCH'});
      }
    });
    tx();
    return{status:'ready',artifactId,attachmentId,filename,hash,bytes:bytes.length,blobPath,reused:reusedBlob};
  }catch(error){
    const code=typeof(error as {code?:unknown}).code==='string'?(error as {code:string}).code:'DB_BIND_FAILED';
    return{status:'failed',code,message:`详情附件登记失败：${(error as Error).message}`};
  }
}

export function isDetailAttachmentRowId(value:string|null|undefined):boolean{
  return typeof value==='string'&&value.startsWith(DETAIL_ATTACHMENT_ID_PREFIX);
}

/** Reuse one already content-addressed document on another message without copying bytes. */
export function attachExistingDocument(input:{
  db:ZhongshuoDatabase;messageId:string;threadId:string|null;projectId:string;conversationId:string;
  taskId:string;runId:string;artifactId:string;memberId:string;filename?:string;
}):{status:'ready';artifactId:string;attachmentId:string;filename:string}|{status:'failed';code:string;message:string}{
  const message=input.db.prepare(
    `SELECT project_id,conversation_id,thread_id,task_id,author_type,author_id,status
       FROM messages WHERE id=?`,
  ).get(input.messageId) as {project_id:string;conversation_id:string;thread_id:string|null;task_id:string|null;author_type:string;author_id:string;status:string}|undefined;
  if(message==null)return{status:'failed',code:'MESSAGE_MISSING',message:'目标消息不存在'};
  if(message.project_id!==input.projectId||message.conversation_id!==input.conversationId||message.thread_id!==input.threadId
    ||message.task_id!==input.taskId||message.author_type!=='agent'||message.author_id!==input.memberId||message.status!=='final'){
    return{status:'failed',code:'MESSAGE_IDENTITY_MISMATCH',message:'目标消息归属不一致'};
  }
  const artifact=input.db.prepare(
    `SELECT id,project_id,conversation_id,thread_id,task_id,run_id,author_id,kind,hash,blob_path,source_name
       FROM artifacts WHERE id=?`,
  ).get(input.artifactId) as {id:string;project_id:string;conversation_id:string|null;thread_id:string|null;task_id:string|null;run_id:string|null;author_id:string;kind:string;hash:string;blob_path:string;source_name:string|null}|undefined;
  if(artifact==null)return{status:'failed',code:'ARTIFACT_MISSING',message:'文档成果不存在'};
  if(artifact.project_id!==input.projectId||artifact.conversation_id!==input.conversationId||artifact.thread_id!==input.threadId
    ||artifact.task_id!==input.taskId||artifact.run_id!==input.runId||artifact.author_id!==input.memberId||artifact.kind!=='text_file')return{status:'failed',code:'ARTIFACT_IDENTITY_MISMATCH',message:'文档成果归属不一致'};
  try{
    if(!existsSync(artifact.blob_path)||sha256(readFileSync(artifact.blob_path))!==artifact.hash)return{status:'failed',code:'ARTIFACT_BLOB_INVALID',message:'文档副本缺失或 hash 不一致'};
  }catch(error){
    return{status:'failed',code:'ARTIFACT_BLOB_INVALID',message:`文档副本不可读：${(error as Error).message}`};
  }
  const filename=input.filename??artifact.source_name??'完整详情.md';
  if(!isSafeDocumentFilename(filename))return{status:'failed',code:'INVALID_FILENAME',message:'文档文件名不安全'};
  const attachmentId=`${DETAIL_ATTACHMENT_ID_PREFIX}${sha256(`${input.messageId}\0${artifact.id}`).slice(0,24)}`;
  try{
    const tx=input.db.transaction(()=>{
      const existing=input.db.prepare('SELECT id,message_id,thread_id,artifact_id,display_name,mime_type,source_hash FROM message_attachments WHERE id=?').get(attachmentId) as
        {id:string;message_id:string;thread_id:string|null;artifact_id:string;display_name:string;mime_type:string|null;source_hash:string}|undefined;
      if(existing==null){
        input.db.prepare('INSERT INTO message_attachments (id,message_id,thread_id,artifact_id,display_name,mime_type,source_hash) VALUES (?,?,?,?,?,?,?)')
          .run(attachmentId,input.messageId,input.threadId,artifact.id,filename,'text/markdown',artifact.hash);
      }else if(existing.message_id!==input.messageId||existing.thread_id!==input.threadId||existing.artifact_id!==artifact.id
        ||existing.display_name!==filename||existing.mime_type!=='text/markdown'||existing.source_hash!==artifact.hash){
        throw Object.assign(new Error('existing attachment mismatch'),{code:'ATTACHMENT_IDENTITY_MISMATCH'});
      }
    });
    tx();
    return{status:'ready',artifactId:artifact.id,attachmentId,filename};
  }catch(error){
    return{status:'failed',code:typeof(error as {code?:unknown}).code==='string'?(error as {code:string}).code:'DB_BIND_FAILED',message:(error as Error).message};
  }
}
