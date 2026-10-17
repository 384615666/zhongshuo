import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {conversationFacts} from '../../src/daemon/conversationReplies.ts';
import {applyRecovery} from '../../src/daemon/stopFlow.ts';

afterEach(()=>vi.unstubAllEnvs());
const final=(answer:string,work=false):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture-key',responseKind:work?'work':'conversation',answer,changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}];
type Root={taskId:string;threadId:string;messageId:string;disposition:string};
async function fixture(scripts:FakeTurnScript[]){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r84-chat-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));let sequence=0;
  const adapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>scripts[Math.min(sequence++,scripts.length-1)]!});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r84-fixture',appDataDir:dir});
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:(id:string)=>worker.interruptTurn(id)};
  async function raw<T=unknown>(method:string,params:unknown,commandId=randomUUID()){return await dispatchDaemonCommand(deps,{protocolVersion:1,commandId,method,params}) as {ok:boolean;data:T;replayed?:boolean;error?:{code:string;message:string}};}
  async function cmd<T=unknown>(method:string,params:unknown){const r=await raw<T>(method,params);expect(r.ok,JSON.stringify(r.error)).toBe(true);return r.data;}
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  await cmd('project.reviewPolicy.set',{projectId,taskReviewEnabled:true,expectedRevision:(db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId) as {revision:number}).revision});
  const memberId=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'原执行成员'})).memberId;
  await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions',effort:'high'});
  const room=(await cmd<{items:Array<{id:string;conversationId:string}>}>('room.list',{projectId})).items[0]!;
  const root=await cmd<Root>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'你好',intent:'default',mentions:[{kind:'member',memberId}]});
  await worker.runOnce();
  const params=(body:string,intent='default')=>({target:{kind:'thread',projectId,conversationId:room.conversationId,threadId:root.threadId},body,intent,mentions:[]});
  const count=(table:string)=>(db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n;
  return{dir,db,adapter,worker,raw,cmd,projectId,memberId,room,root,params,count};
}

describe('R84 ordinary same-thread replies, formal commands and worker, zero real inference',()=>{
  it('three rounds retain original task/member/thread, natural context, exact replay and explicit record-only',async()=>{
    const f=await fixture([final('你好！'),final('我刚才向你问好了。'),final('这是我们的第三轮。')]);
    try{
      const id=randomUUID(),p=f.params('你刚才怎么回答我的问候的？');
      const reply=await f.raw<Root>('message.submit',p,id);expect(reply.ok).toBe(true);expect(reply.data).toMatchObject({taskId:f.root.taskId,threadId:f.root.threadId,disposition:'enqueued'});
      const replay=await f.raw<Root>('message.submit',p,id);expect(replay.replayed).toBe(true);expect(replay.data.messageId).toBe(reply.data.messageId);
      expect((await f.raw('message.submit',{...p,body:'不同参数'},id)).ok).toBe(false);
      await f.worker.runOnce();
      await f.cmd('message.submit',f.params('这是第几轮？请结合前文。'));await f.worker.runOnce();
      expect(f.count('tasks')).toBe(1);expect(f.count('workflow_runs')).toBe(3);expect(f.count('agent_turns')).toBe(3);expect(f.count('task_deliveries')).toBe(0);
      expect(f.db.prepare('SELECT DISTINCT member_id FROM agent_turns').all()).toEqual([{member_id:f.memberId}]);
      const bundle=f.db.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid DESC LIMIT 1').get() as {included_refs_json:string};
      const context=JSON.parse(bundle.included_refs_json) as {task:{objective:string};threadDigest:{rootText:string;messages:Array<{text:string}>}};
      expect(context.task.objective).toBe('这是第几轮？请结合前文。');expect(context.threadDigest.rootText).toBe('你好');
      expect(context.threadDigest.messages.map(m=>m.text)).toContain('你好！');expect(context.threadDigest.messages.map(m=>m.text)).toContain('我刚才向你问好了。');expect(JSON.stringify(context.threadDigest)).not.toContain('schemaVersion');
      const before=f.count('outbox');await f.cmd('message.submit',f.params('本条仅记录','record_only'));expect(f.count('outbox')).toBe(before);await f.worker.runOnce();expect(f.count('agent_turns')).toBe(3);
      expect(f.db.prepare('SELECT status FROM thread_reply_requests').all()).toEqual([{status:'succeeded'},{status:'succeeded'}]);expect(f.count('real_calls')).toBe(0);
    }finally{f.db.close();}
  });
  it('queued requests have fixed human boundary but include preceding answer arriving after the next question; local-only text stays out',async()=>{
    const f=await fixture([final('你好！'),final('前一轮回答'),final('当前第三轮回答')]);
    try{
      await f.cmd('message.submit',f.params('先回答这一条'));await f.cmd('message.submit',f.params('再结合你的前一轮回答说明'));
      await f.cmd('message.submit',f.params('PRIVATE_LOCAL_ONLY','record_only'));
      await f.worker.runOnce();let bundle=f.db.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid DESC LIMIT 1').get() as {included_refs_json:string};
      expect(bundle.included_refs_json).not.toContain('再结合你的前一轮回答说明');expect(bundle.included_refs_json).not.toContain('PRIVATE_LOCAL_ONLY');
      await f.worker.runOnce();bundle=f.db.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid DESC LIMIT 1').get() as {included_refs_json:string};
      expect(bundle.included_refs_json).toContain('前一轮回答');expect(bundle.included_refs_json).toContain('再结合你的前一轮回答说明');expect(bundle.included_refs_json).not.toContain('PRIVATE_LOCAL_ONLY');expect(f.count('workflow_runs')).toBe(3);
    }finally{f.db.close();}
  });
  it('R87 a queued ordinary question is answered after natural work delivery without automatically replacing it',async()=>{
    const work:FakeTurnScript=[{kind:'event',event:{kind:'tool.started',toolCallId:'write',toolName:'Write',argumentsSummary:'result.txt'}},{kind:'writeFile',path:'result.txt',content:'formal fake engineering result'},{kind:'event',event:{kind:'tool.completed',toolCallId:'write',outcome:'success'}},...final('工作已完成',true)];
    const f=await fixture([final('你好！'),work,final('这是对刚完成文件的解释，不修改文件')]);
    try{
      await f.cmd('message.submit',f.params('创建文件'));const later=await f.cmd<Root>('message.submit',f.params('随后的一条普通追问'));
      await f.worker.runOnce();expect(f.count('task_deliveries')).toBe(1);expect(conversationFacts(f.db,f.root.threadId)).toBeNull();await f.worker.runOnce();expect(f.count('workflow_runs')).toBe(3);expect(f.count('task_deliveries')).toBe(1);
      expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(later.messageId)).toEqual({status:'succeeded'});
      const before=f.count('outbox');expect(await f.cmd<Root>('message.submit',f.params('这条工作修改意见先保存','record_only'))).toMatchObject({disposition:'none'});expect(f.count('outbox')).toBe(before);expect(f.count('task_deliveries')).toBe(1);
    }finally{f.db.close();}
  });
  it('disabled original member rejects before saving/queuing; explicit record still saves',async()=>{
    const f=await fixture([final('你好！')]);
    try{
      await f.cmd('member.setEnabled',{memberId:f.memberId,enabled:false});
      const before={messages:f.count('messages'),outbox:f.count('outbox')};const rejected=await f.raw('message.submit',f.params('普通续问'));
      expect(rejected.ok).toBe(false);expect(rejected.error?.code).toBe('MEMBER_DISABLED');expect(f.count('messages')).toBe(before.messages);expect(f.count('outbox')).toBe(before.outbox);
      await f.cmd('message.submit',f.params('只保存我的原文','record_only'));expect(f.count('messages')).toBe(before.messages+1);expect(f.count('outbox')).toBe(before.outbox);
    }finally{f.db.close();}
  });
  it('queued configuration stays frozen; a new explicit question uses current configuration without changing the parent',async()=>{
    const f=await fixture([final('你好！'),final('当前只读配置的回答')]);
    try{
      const parent=f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(f.root.taskId);
      const queued=await f.cmd<Root>('message.submit',f.params('按旧配置排队'));
      const snapshot=f.db.prepare('SELECT write_scope_json FROM thread_reply_requests WHERE message_id=?').get(queued.messageId);
      await f.cmd('member.setRuntime',{memberId:f.memberId,kind:'fake',permissionMode:'plan',effort:'low'});
      await f.worker.runOnce();expect(f.count('agent_turns')).toBe(1);
      expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(queued.messageId)).toEqual({status:'blocked'});
      expect(f.db.prepare('SELECT write_scope_json FROM thread_reply_requests WHERE message_id=?').get(queued.messageId)).toEqual(snapshot);
      const current=await f.cmd<Root>('message.submit',f.params('明确使用当前保存配置回答'));
      const currentScope=f.db.prepare('SELECT write_scope_json FROM thread_reply_requests WHERE message_id=?').get(current.messageId) as {write_scope_json:string};
      expect(JSON.parse(currentScope.write_scope_json)).toMatchObject({executionMode:'readonly',runtime:{permissionMode:'plan',effort:'low'}});
      await f.worker.runOnce();expect(f.count('agent_turns')).toBe(2);
      expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(current.messageId)).toEqual({status:'succeeded'});
      expect(f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(f.root.taskId)).toEqual(parent);
      expect(f.db.prepare('SELECT count(DISTINCT session_id) n FROM agent_turns').get()).toEqual({n:2});
    }finally{f.db.close();}
  });
  it.each(['Bash','commandExecution','Write'])('read command or rejected %s attempt with no actual diff does not create a fake delivery or disable ordinary followups',async toolName=>{
    const query:FakeTurnScript=[{kind:'event',event:{kind:'tool.started',toolCallId:'query',toolName,argumentsSummary:'isolated query'}},{kind:'event',event:{kind:'tool.completed',toolCallId:'query',outcome:toolName==='Write'?'failure':'success'}},...final('查询回答')];
    const f=await fixture([final('你好！'),query,final('仍然可以继续回答')]);
    try{await f.cmd('message.submit',f.params('查询一下'));await f.worker.runOnce();expect(f.count('task_deliveries')).toBe(0);expect(conversationFacts(f.db,f.root.threadId)).not.toBeNull();await f.cmd('message.submit',f.params('继续解释前文'));await f.worker.runOnce();expect(f.count('agent_turns')).toBe(3);expect(f.count('task_deliveries')).toBe(0);}finally{f.db.close();}
  });
  it('an unnamed tool causing real file differences cannot leave the thread classified as ordinary',async()=>{
    const f=await fixture([final('你好！'),[{kind:'writeFile',path:'real-difference.txt',content:'engineering fixture'},...final('完成')]]);
    try{await f.cmd('message.submit',f.params('产生文件变化'));await f.worker.runOnce();expect(f.count('task_deliveries')).toBe(1);expect(conversationFacts(f.db,f.root.threadId)).toBeNull();}finally{f.db.close();}
  });
  it('successful fileChange outside the managed project is work evidence, separately from the project changeset',async()=>{
    const f=await fixture([final('你好！'),[{kind:'event',event:{kind:'tool.started',toolCallId:'outside',toolName:'fileChange',argumentsSummary:'own outside fixture'}},{kind:'event',event:{kind:'tool.completed',toolCallId:'outside',outcome:'success'}},...final('已写入外部目录')],final('对完成结果的普通解释')]);
    try{
      const outside=join(f.dir,'outside.txt');const events=f.adapter.events.bind(f.adapter);
      vi.spyOn(f.adapter,'events').mockImplementation(session=>({async *[Symbol.asyncIterator](){for await(const event of events(session)){if(event.kind==='tool.completed'&&event.toolCallId==='outside')writeFileSync(outside,'synthetic formal adapter side effect');yield event;}}}));
      await f.cmd('message.submit',f.params('修改自有项目外合成文件'));const queued=await f.cmd<Root>('message.submit',f.params('排队追问不能自动返工'));
      await f.worker.runOnce();expect(readFileSync(outside,'utf8')).toBe('synthetic formal adapter side effect');expect(f.count('task_deliveries')).toBe(1);expect(conversationFacts(f.db,f.root.threadId)).toBeNull();
      await f.worker.runOnce();expect(f.count('agent_turns')).toBe(3);expect(f.count('task_deliveries')).toBe(1);expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(queued.messageId)).toEqual({status:'succeeded'});
      expect(f.db.prepare("SELECT response_kind FROM tasks WHERE id=?").get(f.root.taskId)).toEqual({response_kind:'work'});
    }finally{f.db.close();}
  });
  it('archive blocks default and record-only, including receipt replay; restore allows a new explicit question',async()=>{
    const f=await fixture([final('你好！'),final('恢复后回答')]);
    try{
      const revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(f.room.id) as {revision:number}).revision;
      await f.cmd('room.archive',{roomId:f.room.id,expectedRevision:revision,action:'archive'});
      const before=f.count('messages');for(const intent of ['default','record_only'])expect((await f.raw('message.submit',f.params('归档不写',intent))).error?.code).toBe('CONVERSATION_UNAVAILABLE');expect(f.count('messages')).toBe(before);
      await f.cmd('room.archive',{roomId:f.room.id,expectedRevision:revision+1,action:'unarchive'});await f.cmd('message.submit',f.params('恢复后明确提问'));await f.worker.runOnce();expect(f.count('agent_turns')).toBe(2);
    }finally{f.db.close();}
  });
  it('stopping the active reply durably cancels queued intents and rejects further automatic continuation',async()=>{
    const f=await fixture([final('你好！'),[{kind:'stall',ms:250},...final('不可迟到复活')]]);
    try{
      await f.cmd('message.submit',f.params('正在回答的提问'));const executing=f.worker.runOnce();
      for(let i=0;i<100&&!f.db.prepare("SELECT 1 FROM agent_turns WHERE status='RUNNING'").get();i++)await new Promise(r=>setTimeout(r,5));
      const run=f.db.prepare("SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(f.root.taskId) as {id:string};
      const queued=await f.cmd<Root>('message.submit',f.params('还在排队的提问'));
      await f.cmd('task.stop',{taskId:f.root.taskId,targetRunId:run.id,expectedStopGeneration:0});await executing;await f.worker.runOnce();
      expect(f.count('agent_turns')).toBe(2);expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(queued.messageId)).toEqual({status:'cancelled'});
      expect((await f.raw('message.submit',f.params('停止后不自动恢复'))).error?.code).toBe('TASK_STOPPED');
    }finally{f.db.close();}
  });
  it('an accepted ordinary reply remains held across a real database reopen and startup recovery without a new turn',async()=>{
    const f=await fixture([final('你好！')]);
    try{
      const commandId=randomUUID(),params=f.params('已接收但尚未领取的续问');
      const accepted=await f.raw<Root>('message.submit',params,commandId);expect(accepted.ok).toBe(true);
      const before=f.db.prepare('SELECT message_id,dispatch_key,write_scope_json,status FROM thread_reply_requests WHERE message_id=?').get(accepted.data.messageId);
      expect(before).toMatchObject({status:'queued'});expect(f.count('agent_turns')).toBe(1);
      f.db.close();
      const reopened=openDatabase(join(f.dir,'state.sqlite'));
      try{
        applyRecovery(reopened,Date.now());
        const adapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>final('不得自动运行')});
        const started=vi.spyOn(adapter,'startTurn');
        const worker=new DispatchWorker({db:reopened,adapter,leaseOwner:'r84-reopened',appDataDir:f.dir});
        expect(await worker.runOnce()).toBe(false);expect(started).not.toHaveBeenCalled();
        expect(reopened.prepare('SELECT message_id,dispatch_key,write_scope_json,status FROM thread_reply_requests WHERE message_id=?').get(accepted.data.messageId)).toEqual(before);
        expect(reopened.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:1});
        expect(reopened.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
        expect(reopened.prepare('SELECT command_id FROM command_receipts WHERE command_id=?').get(commandId)).toEqual({command_id:commandId});
      }finally{reopened.close();}
    }finally{if(f.db.open)f.db.close();}
  });
  it('work clarification preserves delivery identity; only the latest confirmed clarification with exact task/run/generation can explicitly continue',async()=>{
    const f=await fixture([final('真实工作交付',true),final('需要补充目标，暂未产生新版'),final('补充后工作新版',true)]);
    try{
      const delivery=f.db.prepare('SELECT id,revision,manifest_hash,run_id FROM task_deliveries WHERE task_id=?').get(f.root.taskId) as {id:string;revision:number;manifest_hash:string;run_id:string};
      const identity={taskId:f.root.taskId,deliveryId:delivery.id,deliveryRevision:delivery.revision,manifestHash:delivery.manifest_hash};
      await f.cmd('task.review',{...identity,decision:'changes_requested',note:'自然返工意见'});await f.cmd('task.executeRework',{...identity,sourceRunId:delivery.run_id});await f.worker.runOnce();
      expect(f.count('task_deliveries')).toBe(1);expect(f.db.prepare('SELECT status,current_delivery_id FROM tasks WHERE id=?').get(f.root.taskId)).toEqual({status:'WAITING_USER',current_delivery_id:delivery.id});
      const details=await f.cmd<{task:{revision:number;stopGeneration:number};latestRunId:string;clarificationRetry:{available:boolean}}>('task.details',{projectId:f.projectId,taskId:f.root.taskId});expect(details.clarificationRetry.available).toBe(true);
      const snapshot={taskId:f.root.taskId,sourceRunId:details.latestRunId,expectedTaskRevision:details.task.revision,expectedStopGeneration:details.task.stopGeneration,expectedRunStatus:'SUCCEEDED'};
      expect((await f.raw('task.redispatch',{...snapshot,sourceRunId:delivery.run_id})).ok).toBe(false);expect((await f.raw('task.redispatch',{...snapshot,expectedTaskRevision:snapshot.expectedTaskRevision-1})).ok).toBe(false);
      await f.cmd('message.submit',f.params('补充的原文','record_only'));await f.cmd('task.redispatch',snapshot);await f.worker.runOnce();expect(f.count('task_deliveries')).toBe(2);expect(f.db.prepare('SELECT max(revision) n FROM task_deliveries').get()).toEqual({n:2});
    }finally{f.db.close();}
  });
  it('legacy encoding injection: unmarked old human followups remain readable but are never presumed model input',async()=>{
    const f=await fixture([final('你好！'),final('只结合明确输入回答')]);
    try{
      const legacy=await f.cmd<Root>('message.submit',f.params('LEGACY_PRIVATE_RECORD_ONLY','record_only'));
      // Compatibility fixture only: remove the new intent field to represent a
      // pre-051 encoding. No normal business state/completion is fabricated.
      f.db.prepare("UPDATE messages SET body_json=json_remove(body_json,'$.conversationIntent') WHERE id=?").run(legacy.messageId);
      await f.cmd('message.submit',f.params('新明确续问'));await f.worker.runOnce();
      const bundle=f.db.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid DESC LIMIT 1').get() as {included_refs_json:string};expect(bundle.included_refs_json).not.toContain('LEGACY_PRIVATE_RECORD_ONLY');
      const history=await f.cmd<{items:Array<{id:string;body:{text:string}}>}>('thread.history',{threadId:f.root.threadId});expect(history.items.find(m=>m.id===legacy.messageId)?.body.text).toBe('LEGACY_PRIVATE_RECORD_ONLY');expect(f.count('real_calls')).toBe(0);
    }finally{f.db.close();}
  });
  it('R87 an explicit room member is invited and receives this request without rewriting the original task owner',async()=>{
    const f=await fixture([final('你好！'),final('我是新受邀成员，已读到原串上下文')]);
    try{
      const other=(await f.cmd<{memberId:string}>('member.create',{projectId:f.projectId,displayName:'新同伴'})).memberId;
      const saved=await f.cmd<Root>('message.submit',{...f.params('请新同伴看一下'),mentions:[{kind:'member',memberId:other}]});
      await f.worker.runOnce();
      expect(f.db.prepare('SELECT member_id FROM agent_turns ORDER BY rowid DESC LIMIT 1').get()).toEqual({member_id:other});
      expect(f.db.prepare('SELECT owner_member_id FROM tasks WHERE id=?').get(f.root.taskId)).toEqual({owner_member_id:f.memberId});
      expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(saved.messageId)).toEqual({status:'succeeded'});
      const before=f.count('outbox');await f.cmd('message.submit',{...f.params('只保存提及','record_only'),mentions:[{kind:'all'}]});expect(f.count('outbox')).toBe(before);
    }finally{f.db.close();}
  });
  it('unknown provider outcome stays unknown across reopen and exact command replay never starts another turn',async()=>{
    const f=await fixture([final('你好！'),[{kind:'event',event:{kind:'turn.failed',code:'INTERRUPTED',message:'isolated unconfirmed deadline',retryable:false}}]]);
    try{
      const id=randomUUID(),p=f.params('本次回复结果将未知');const saved=await f.raw<Root>('message.submit',p,id);await f.worker.runOnce();expect(f.db.prepare('SELECT status FROM thread_reply_requests').get()).toEqual({status:'unknown'});
      const replay=await f.raw<Root>('message.submit',p,id);expect(replay.replayed).toBe(true);expect(replay.data.messageId).toBe(saved.data.messageId);await f.worker.runOnce();expect(f.count('agent_turns')).toBe(2);
      expect((await f.raw('message.submit',f.params('不能新号绕过未知'))).error?.code).toBe('RECONCILE_REQUIRED');
      const readonly=openDatabase(join(f.dir,'state.sqlite'));try{expect(readonly.prepare('SELECT status FROM thread_reply_requests').get()).toEqual({status:'unknown'});}finally{readonly.close();}
    }finally{f.db.close();}
  });
  it('explicit failure is projected next to the original human message with actual reason',async()=>{
    const f=await fixture([final('你好！'),[{kind:'event',event:{kind:'turn.failed',code:'PROVIDER_ERROR',message:'isolated known rejection',retryable:false}}]]);
    try{const saved=await f.cmd<Root>('message.submit',f.params('这条会明确失败'));await f.worker.runOnce();const history=await f.cmd<{items:Array<{id:string;replyExecution?:{status:string;error:string}}>}>('thread.history',{threadId:f.root.threadId});expect(history.items.find(m=>m.id===saved.messageId)?.replyExecution).toMatchObject({status:'failed',error:'isolated known rejection'});}finally{f.db.close();}
  });
});
