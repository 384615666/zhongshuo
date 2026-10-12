import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { ConversationTaskPage } from '../../src/contracts/conversationTasks.ts';
import type { TaskDetailsResult } from '../../src/contracts/taskDetails.ts';
process.env.ZS_ALLOW_FAKE='1';
const root=mkdtempSync(join(tmpdir(),'zs-r79-dm-records-'));mkdirSync(join(root,'app'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));
describe('R79 scoped private task records',()=>{
  it('lists a natural worker delivery, pages separately labelled scale tasks and rechecks every audience/context',async()=>{
    const db=openDatabase(':memory:');let count=0;
    const raw=(method:string,params:unknown)=>dispatchDaemonCommand({db,localUserId:'u',appDataDir:join(root,'app'),interruptTurn:async()=>{}},{protocolVersion:1,commandId:`r79-dm-records-${++count}`,method,params}) as Promise<{ok:boolean;data:unknown;error?:{code:string}}>;
    const adapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',changeSummary:'正式DM工程交付',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}]});
    try{
      db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at,task_review_enabled) VALUES('p','私信工程',?,?,'{}',0,1)").run(root,root);
      db.exec("INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('m','p','模拟成员','agent',1);INSERT INTO conversations(id,project_id,kind) VALUES('a','p','dm'),('b','p','dm');INSERT INTO dm_participants(project_id,conversation_id,principal_type,principal_id) VALUES('p','a','human','u'),('p','a','agent','m'),('p','b','human','u'),('p','b','agent','m');");
      const sent=(await raw('message.submit',{target:{kind:'dm',projectId:'p',conversationId:'a'},body:'正式DM任务记录',intent:'default',mentions:[]})).data as {taskId:string};
      await new DispatchWorker({db,adapter,appDataDir:join(root,'app'),leaseOwner:'r79-dm-reader'}).runOnce();
      const first=(await raw('conversation.tasks',{projectId:'p',conversationId:'a'})).data as ConversationTaskPage;
      expect(first.items).toHaveLength(1);expect(first.items[0]).toMatchObject({id:sent.taskId,status:'REVIEW',latestRun:{status:'SUCCEEDED'}});
      const natural=(await raw('task.details',{projectId:'p',conversationId:'a',taskId:sent.taskId})).data as TaskDetailsResult;
      expect(natural.task.conversationId).toBe('a');expect(natural.deliveries).toHaveLength(1);
      expect((await raw('task.details',{projectId:'p',conversationId:'b',taskId:sent.taskId})).ok).toBe(false);
      expect((await raw('task.history',{projectId:'p',conversationId:'b',taskId:sent.taskId,kind:'runs'})).ok).toBe(false);
      // History scale only; never fabricate the natural task/run/delivery above.
      for(let i=0;i<24;i++)db.prepare("INSERT INTO tasks(id,project_id,conversation_id,kind,title,status) VALUES(?,'p','a','dm_turn',?,'OPEN')").run(`scale${i}`,`历史规模 ${i}`);
      const head=(await raw('conversation.tasks',{projectId:'p',conversationId:'a'})).data as ConversationTaskPage;
      expect(head.items).toHaveLength(20);expect(head.nextCursor).toBeTruthy();
      db.exec("INSERT INTO tasks(id,project_id,conversation_id,kind,title,status) VALUES('new-head','p','a','dm_turn','新头规模','OPEN');");
      const older=(await raw('conversation.tasks',{projectId:'p',conversationId:'a',beforeTaskId:head.nextCursor})).data as ConversationTaskPage;
      expect(older.items).toHaveLength(5);expect(older.nextCursor).toBeNull();expect(new Set([...head.items,...older.items].map(t=>t.id)).size).toBe(25);expect(older.items.at(-1)?.id).toBe(sent.taskId);
      expect((await raw('conversation.tasks',{projectId:'p',conversationId:'b',beforeTaskId:head.nextCursor})).ok).toBe(false);
      expect((await raw('conversation.tasks',{projectId:'wrong',conversationId:'a'})).ok).toBe(false);
      expect(((await raw('conversation.tasks',{projectId:'p',conversationId:'b'})).data as ConversationTaskPage).items).toEqual([]);
      db.prepare("UPDATE dm_participants SET principal_id='other' WHERE conversation_id='a' AND principal_type='human'").run();
      expect((await raw('conversation.tasks',{projectId:'p',conversationId:'a',beforeTaskId:head.nextCursor})).error?.code).toBe('FORBIDDEN');
      expect((await raw('task.details',{projectId:'p',conversationId:'a',taskId:sent.taskId})).error?.code).toBe('FORBIDDEN');
    }finally{await adapter.closeAllSessions();db.close();}
  });
});
