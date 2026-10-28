import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {appendDomainEvent} from '../../src/persistence/events.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker,type DispatchWorkerOptions} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {threadReplyForDispatch,threadReplyBlock} from '../../src/daemon/threadReplies.ts';
afterEach(() => vi.unstubAllEnvs());
const output = (answer: string, coordinationPlan?: unknown,extra:Record<string,unknown>={}): FakeTurnScript => [{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({
  schemaVersion:'task-complete-v1',resultKey:'fixture',answer,responseKind:coordinationPlan?'work':'conversation',changeSummary:answer,
  files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...(coordinationPlan?{coordinationPlan}:{}),...extra
})}}];

async function fixture(enableDeliberate=false,options:Partial<Pick<DispatchWorkerOptions,'turnDeadlineMs'|'interruptGraceMs'|'coordinationMaxCalls'|'detachedTurnConsumption'>>={}) {
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r86-coordination-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  let script:FakeTurnScript=output('你好');
  const adapter=new FakeRuntimeAdapter({structuredFinal:!enableDeliberate,turnScriptSequencer:()=>script});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r86',appDataDir:dir,enableDeliberate,coordinationMaxCalls:6,...options});
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:(id:string)=>worker.interruptTurn(id)};
  async function raw(method:string,params:unknown,commandId:string=randomUUID()) {return await dispatchDaemonCommand(deps,{protocolVersion:1,commandId,method,params}) as {ok:boolean;data?:unknown;error?:unknown};}
  async function cmd<T>(method:string,params:unknown,commandId?:string):Promise<T> {const r=await raw(method,params,commandId);expect(r.ok,JSON.stringify(r)).toBe(true);return (r as {data:unknown}).data as T;}
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:{id:string;conversationId:string}[]}>('room.list',{projectId})).items[0]!;
  const a=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'同名成员'})).memberId;
  const b=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'同名成员'})).memberId;
  for(const memberId of [a,b]) await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
  const revision=(db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision:number}).revision;
  await cmd('room.update',{roomId:room.id,expectedRevision:revision,coordinatorMemberId:a});
  const send=(mentions:string[]=[])=>cmd<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请两位成员协作分析再复核',intent:'default',...(enableDeliberate?{collaboration:'deliberate'}:{}),mentions:mentions.map(memberId=>({kind:'member',memberId}))});
  const plan={summary:'独立分析后复核',steps:[{key:'analysis',memberId:a,title:'分析',objective:'提出实现方案',role:'analysis',dependsOn:[]},{key:'review',memberId:b,title:'复核',objective:'读取并复核上游方案',role:'review',dependsOn:['analysis']}]};
  const run=async(s:FakeTurnScript)=>{script=s;return worker.runOnce();};
  const rawPrepared=async(params:unknown)=>dispatchDaemonCommand({...deps,prepareRuntimeConfiguration:async()=>{throw Error('fake must not prepare a real runtime');}},
    {protocolVersion:1,commandId:randomUUID(),method:'message.submit',params}) as Promise<{ok:boolean;data?:unknown;error?:unknown}>;
  return {db,dir,worker,adapter,cmd,raw,rawPrepared,send,run,plan,a,b,room,projectId};
}


async function questions(different=false){
  const f=await fixture(false,{coordinationMaxCalls:20});
  const root=await f.send();
  await f.run(output('两项独立工作',{...f.plan,steps:[
    {...f.plan.steps[0]!,key:'first'},
    {...f.plan.steps[1]!,key:'second',memberId:different?f.b:f.a,dependsOn:[]},
  ]}));
  await f.run(output('第一个问题',undefined,{responseKind:'work',userQuestion:'第一个选项是否采用？'}));
  await f.run(output('第二个问题',undefined,{responseKind:'work',userQuestion:'第二个日期是否采用？'}));
  await f.worker.runOnce();
  const target={kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId};
  const children=f.db.prepare(`SELECT t.id,m.id messageId FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id
    JOIN domain_events e ON e.task_id=t.id AND e.kind='turn.workClarification'
    JOIN domain_events reply ON reply.turn_id=e.turn_id AND reply.kind='thread.replyAdded'
    JOIN messages m ON m.id=json_extract(reply.payload_json,'$.messageId') AND m.author_type='agent' ORDER BY e.seq`).all() as Array<{id:string;messageId:string}>;
  expect(children).toHaveLength(2);
  const reply=(replyToMessageId?:string,memberId?:string)=>f.raw('message.submit',{
    target:{...target,...(replyToMessageId?{replyToMessageId}:{})},body:'按建议继续',intent:'default',
    mentions:memberId?[{kind:'member',memberId}]:[],
  });
  const bound=(result:Awaited<ReturnType<typeof reply>>)=>{
    expect(result.ok,JSON.stringify(result)).toBe(true);
    return f.db.prepare('SELECT task_id,dispatch_key,route_json FROM thread_reply_requests WHERE message_id=?')
      .get((result.data as {messageId:string}).messageId) as {task_id:string;dispatch_key:string;route_json:string};
  };
  return {...f,root,target,children,reply,bound};
}
async function close(f:Awaited<ReturnType<typeof questions>>){await f.adapter.closeAllSessions();f.db.close();}

describe('R117 ordered clarification replies',()=>{
  it('binds two consecutive replies to the same AI in question event order and completes both original children',async()=>{
    const f=await questions();try{
      const first=f.bound(await f.reply());const second=f.bound(await f.reply(undefined,f.a));
      expect([first.task_id,second.task_id]).toEqual(f.children.map(c=>c.id));
      expect(JSON.parse(first.route_json).questionSource.messageId).toBe(f.children[0]!.messageId);
      expect(await f.run(output('第一个已完成',undefined,{responseKind:'work'}))).toBe(true);
      expect(await f.run(output('第二个已完成',undefined,{responseKind:'work'}))).toBe(true);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id IN (?,?)').all(...f.children.map(c=>c.id))).toEqual([{status:'DONE'},{status:'DONE'}]);
    }finally{await close(f);}
  });
  it('explicitly selects the second question and then defaults to the first',async()=>{
    const f=await questions();try{
      expect(f.bound(await f.reply(f.children[1]!.messageId)).task_id).toBe(f.children[1]!.id);
      expect(f.bound(await f.reply()).task_id).toBe(f.children[0]!.id);
    }finally{await close(f);}
  });
  it('keeps different AI ambiguous until @ or an exact question identifies it',async()=>{
    const f=await questions(true);try{
      const ambiguous=await f.reply();expect(ambiguous.ok).toBe(false);expect(JSON.stringify(ambiguous.error)).toContain('@');
      expect(f.bound(await f.reply(undefined,f.b)).task_id).toBe(f.children[1]!.id);
      expect(f.bound(await f.reply()).task_id).toBe(f.children[0]!.id);
    }finally{await close(f);}
  });
  it.each(['queued','running','unknown'])('does not bind an already %s question twice',async status=>{
    const f=await questions();try{
      const first=f.bound(await f.reply());
      f.db.prepare('UPDATE thread_reply_requests SET status=? WHERE dispatch_key=?').run(status,first.dispatch_key);
      expect((await f.reply(f.children[0]!.messageId)).ok).toBe(false);
      expect(f.bound(await f.reply()).task_id).toBe(f.children[1]!.id);
      expect((await f.reply()).ok).toBe(false);
    }finally{await close(f);}
  });
  it('does not replay a resolved old question or dispatch a stale frozen question',async()=>{
    const f=await questions();try{
      const first=f.bound(await f.reply(f.children[0]!.messageId));
      const request=threadReplyForDispatch(f.db,first.dispatch_key)!;
      f.db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(f.children[0]!.id);
      expect((await f.reply(f.children[0]!.messageId)).ok).toBe(false);
      expect(threadReplyBlock(f.db,request,'fake')?.code).toBe('STALE_REVISION');
      expect(f.bound(await f.reply()).task_id).toBe(f.children[1]!.id);
    }finally{await close(f);}
  });
  it('rejects a question whose explicit @ identifies a different member',async()=>{
    const f=await questions(true);try{
      expect((await f.reply(f.children[1]!.messageId,f.a)).ok).toBe(false);
      expect(f.db.prepare('SELECT count(*) n FROM thread_reply_requests').get()).toEqual({n:0});
    }finally{await close(f);}
  });
  it('keeps the explicit second-question source through all preparation and revalidation selections',async()=>{
    const f=await questions();try{
      const result=await f.rawPrepared({target:{...f.target,replyToMessageId:f.children[1]!.messageId},body:'继续第二项',intent:'default',mentions:[]});
      const request=f.bound(result);
      expect(request.task_id).toBe(f.children[1]!.id);
      expect(JSON.parse(request.route_json).questionSource.messageId).toBe(f.children[1]!.messageId);
      expect(await f.run(output('第二项已完成',undefined,{responseKind:'work'}))).toBe(true);
    }finally{await close(f);}
  });
  it('rejects a question cited from another thread',async()=>{
    const f=await questions();try{
      const other=await f.send();
      const result=await f.raw('message.submit',{target:{...f.target,threadId:other.threadId,replyToMessageId:f.children[1]!.messageId},body:'继续',intent:'default',mentions:[]});
      expect(result.ok).toBe(false);
      expect(f.db.prepare('SELECT count(*) n FROM thread_reply_requests').get()).toEqual({n:0});
    }finally{await close(f);}
  });
  it('rejects an old question after the same child asks a new one',async()=>{
    const f=await questions();try{
      f.bound(await f.reply(f.children[0]!.messageId));
      expect(await f.run(output('需追加确认',undefined,{responseKind:'work',userQuestion:'第三个选项是否采用？'}))).toBe(true);
      expect((await f.reply(f.children[0]!.messageId)).ok).toBe(false);
      const newer=f.db.prepare(`SELECT json_extract(reply.payload_json,'$.messageId') id FROM domain_events reply
        JOIN messages m ON m.id=json_extract(reply.payload_json,'$.messageId') AND m.author_type='agent'
        WHERE reply.task_id=? AND reply.kind='thread.replyAdded' ORDER BY reply.seq DESC LIMIT 1`).get(f.children[0]!.id) as {id:string};
      expect(newer.id).not.toBe(f.children[0]!.messageId);
      expect(f.bound(await f.reply(newer.id)).task_id).toBe(f.children[0]!.id);
    }finally{await close(f);}
  });
  it('does not start a model when the parent stops while openSession is pending',async()=>{
    const f=await questions();try{
      const request=f.bound(await f.reply());
      const open=f.adapter.openSession.bind(f.adapter);
      const before=f.adapter.startTurnLog.length;
      const spy=vi.spyOn(f.adapter,'openSession').mockImplementationOnce(async options=>{
        const session=await open(options);
        const run=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(f.root.taskId) as {run_id:string};
        await f.cmd('task.stop',{taskId:f.root.taskId,targetRunId:run.run_id,expectedStopGeneration:0});
        return session;
      });
      try{await f.run(output('不应执行',undefined,{responseKind:'work'}));}finally{spy.mockRestore();}
      expect(f.adapter.startTurnLog).toHaveLength(before);
      expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE dispatch_key=?').get(request.dispatch_key)).toEqual({status:'cancelled'});
    }finally{await close(f);}
  });
  it('revalidates the frozen question after asynchronous openSession and does not start a stale reply',async()=>{
    const f=await questions();try{
      const request=f.bound(await f.reply());
      const source=JSON.parse(request.route_json).questionSource as {taskId:string;turnId:string};
      const open=f.adapter.openSession.bind(f.adapter);
      const before=f.adapter.startTurnLog.length;
      const spy=vi.spyOn(f.adapter,'openSession').mockImplementationOnce(async options=>{
        const session=await open(options);
        const run=f.db.prepare('SELECT run_id FROM agent_turns WHERE id=?').get(source.turnId) as {run_id:string};
        appendDomainEvent(f.db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:f.projectId,
          conversationId:f.room.conversationId,threadId:f.root.threadId,taskId:source.taskId,runId:run.run_id,
          turnId:source.turnId,kind:'turn.workClarification',createdAt:Date.now(),payload:{question:'等待期间问题已更新'}});
        return session;
      });
      try{await expect(f.run(output('不应执行',undefined,{responseKind:'work'}))).rejects.toThrow('待答复的问题已解决或变化');}finally{spy.mockRestore();}
      expect(f.adapter.startTurnLog).toHaveLength(before);
      expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE dispatch_key=?').get(request.dispatch_key)).toEqual({status:'failed'});
    }finally{await close(f);}
  });
  it('does not dispatch queued replies after parent stop',async()=>{
    const f=await questions();try{
      f.bound(await f.reply());f.bound(await f.reply());
      const before=f.adapter.startTurnLog.length;
      const run=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(f.root.taskId) as {run_id:string};
      await f.cmd('task.stop',{taskId:f.root.taskId,targetRunId:run.run_id,expectedStopGeneration:0});
      await f.worker.runOnce();await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(before);
    }finally{await close(f);}
  });
});
