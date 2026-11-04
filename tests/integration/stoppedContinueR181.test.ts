import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand,type DaemonCommandDeps} from '../../src/daemon/commands.ts';
import {DispatchWorker,type TaskRow} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import type {TaskExecutionStatus} from '../../src/contracts/executionStatus.ts';

type Reply={ok:boolean;data?:unknown;error?:{code:string;message:string};replayed?:boolean};
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0))await close();vi.unstubAllEnvs();});

async function fixture(mode:'DIRECT'|'DELIBERATE'|'AUTO'='DIRECT',partialFirst=false){
  vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY','0');
  const dir=mkdtempSync(join(tmpdir(),'zs-r181-stopped-')),projectPath=join(dir,'project');mkdirSync(projectPath);
  const db=openDatabase(join(dir,'state.sqlite'));
  let stall=true,initialReplies=0;
  const adapter=new FakeRuntimeAdapter({structuredFinal:mode!=='DELIBERATE',turnScriptSequencer:()=>stall&&(!partialFirst||initialReplies++>0)
    ?[{kind:'stall',ms:60_000}]
    :[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify(mode==='DELIBERATE'
      ?{schemaVersion:'analysis-draft-v1',summary:'接续已有讨论',document:null,completion:{disposition:partialFirst&&stall?'continue':'conversation',reason:'讨论回复'},
        claims:partialFirst&&stall?[{claimId:'c1',statement:'已保存的成员发言',kind:'observed',evidenceIds:['ev1'],uncertainty:''}]:[],recommendations:[],openQuestions:[]}
      :{schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',answer:'接续已有讨论',changeSummary:'接续已有讨论',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}] as FakeTurnScript});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r181',appDataDir:dir,enableDeliberate:true});
  cleanups.push(async()=>{await adapter.closeAllSessions();expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});db.close();rmSync(dir,{recursive:true,force:true});});
  const raw=(method:string,params:unknown,commandId:string=randomUUID(),overrides:Partial<DaemonCommandDeps>={})=>
    dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:dir,interruptTurn:id=>worker.interruptTurn(id),...overrides},
      {protocolVersion:1,commandId,method,params}) as Promise<Reply>;
  const cmd=async<T>(method:string,params:unknown,commandId?:string)=>{
    const result=await raw(method,params,commandId);expect(result.ok,JSON.stringify(result)).toBe(true);return result.data as T;
  };
  await cmd('app.settings.set',{key:'callBudget.enabled',value:'false'});
  const {project}=await cmd<{project:{id:string}}>('project.open',{path:projectPath,agentNames:[]});
  const members:string[]=[];
  for(const displayName of ['成员甲','成员乙']){
    const {memberId}=await cmd<{memberId:string}>('member.create',{projectId:project.id,displayName});
    await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'plan'});members.push(memberId);
  }
  const {room}=await cmd<{room:{id:string;conversationId:string}}>('room.create',{projectId:project.id,name:'续接测试',memberIds:members});
  const root=await cmd<{taskId:string;threadId:string}>('message.submit',{
    target:{kind:'room_root',projectId:project.id,conversationId:room.conversationId,roomId:room.id},
    body:'保留这段原始讨论并继续完善',intent:'default',mentions:(mode==='DIRECT'?members.slice(0,1):members).map(memberId=>({kind:'member',memberId})),
    ...(mode==='DELIBERATE'?{collaboration:'deliberate'}:{}),
  });
  const state=()=>db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get(root.taskId) as {status:string;revision:number;stop_generation:number};
  const latest=()=>db.prepare('SELECT id,status,mode FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(root.taskId) as {id:string;status:string;mode:string};
  const follow=(body='继续',extra:Record<string,unknown>={})=>({target:{kind:'thread',projectId:project.id,conversationId:room.conversationId,threadId:root.threadId},body,intent:'default',mentions:[],...extra});
  const binding=()=>({taskId:root.taskId,expectedTaskRevision:state().revision,expectedStopGeneration:state().stop_generation});
  const stop=async()=>{
    const work=worker.drain();
    if(partialFirst)await vi.waitFor(()=>expect((db.prepare("SELECT count(*) n FROM messages WHERE author_type='agent'").get() as {n:number}).n).toBeGreaterThan(0));
    await vi.waitFor(()=>expect((db.prepare("SELECT count(*) n FROM agent_turns WHERE status='RUNNING'").get() as {n:number}).n).toBeGreaterThan(0));
    await cmd('task.stop',{taskId:root.taskId,targetRunId:latest().id,expectedStopGeneration:state().stop_generation});
    await work;await worker.drain();
    await vi.waitFor(()=>expect(state().status).toBe('CANCELLED'));
  };
  return{db,worker,adapter,raw,cmd,root,room,project,members,state,latest,follow,binding,stop,succeed:()=>{stall=false;}};
}

describe('R181 explicit continuation after a confirmed user stop (isolated, zero models)',()=>{
  it.each(['DIRECT','DELIBERATE','AUTO'] as const)('%s: sending Continue reuses the thread, preserves history and fences late output',async mode=>{
    const f=await fixture(mode);await f.stop();
    const old=f.latest(),oldTurns=f.db.prepare('SELECT * FROM agent_turns WHERE run_id=?').all(old.id) as Array<{id:string;run_id:string}>;
    const history=f.db.prepare('SELECT * FROM messages ORDER BY rowid').all();
    const queued=await f.cmd<{messageId:string;dispatchKey:string;taskId:string}>('message.submit',f.follow(),'same-follow-up');
    expect(queued.taskId).toBe(f.root.taskId);expect(f.state()).toMatchObject({status:'ACTIVE',stop_generation:1});
    expect(f.db.prepare('SELECT stop_generation_at_enqueue FROM outbox WHERE dispatch_key=?').get(queued.dispatchKey)).toEqual({stop_generation_at_enqueue:1});
    expect(f.db.prepare('SELECT * FROM messages ORDER BY rowid').all().slice(0,history.length)).toEqual(history);
    expect(f.db.prepare('SELECT * FROM agent_turns WHERE run_id=?').all(old.id)).toEqual(oldTurns);
    expect(await f.raw('message.submit',f.follow(),'same-follow-up')).toMatchObject({ok:true,replayed:true});
    f.succeed();await f.worker.drain();await f.worker.drain();
    expect(f.latest()).toMatchObject({mode:mode==='DELIBERATE'?'DELIBERATE':'AUTO',status:'SUCCEEDED'});expect(f.latest().id).not.toBe(old.id);
    expect(f.state()).toMatchObject({status:'DONE',stop_generation:1});
    const before={state:f.state(),messages:f.db.prepare('SELECT * FROM messages').all(),run:f.latest()};
    const task=f.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.root.taskId) as TaskRow;
    for(const turn of oldTurns)for(const kind of ['turn.completed','turn.failed','message.completed'] as const){
      const common={eventKey:randomUUID(),sessionId:'old',turnId:turn.id,receivedAt:Date.now()};
      f.worker.applyEvent(task,old.id,turn.id,kind==='turn.completed'?{...common,kind,finalText:'迟到结果'}:kind==='turn.failed'
        ?{...common,kind,code:'LATE',message:'迟到错误',retryable:false}:{...common,kind,messageId:randomUUID(),text:'迟到正文'});
    }
    expect({state:f.state(),messages:f.db.prepare('SELECT * FROM messages').all(),run:f.latest()}).toEqual(before);
    expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(old.id)).toEqual({status:'CANCELLED'});
  });

  it.each(['DIRECT','DELIBERATE'] as const)('%s: the formal Continue action works once with the current stop snapshot',async mode=>{
    const f=await fixture(mode);await f.stop();const binding=f.binding();
    const detail=await f.cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId:f.root.taskId});
    expect(detail.executionStatus.actions).toContainEqual(expect.objectContaining({kind:'continue',binding}));
    f.succeed();expect(await f.raw('task.continue',binding,'same-continue')).toMatchObject({ok:true});
    expect(await f.raw('task.continue',binding,'same-continue')).toMatchObject({ok:true,replayed:true});
    expect(await f.raw('task.continue',binding)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
    await f.worker.drain();await f.worker.drain();
    expect(f.latest()).toMatchObject({mode:mode==='DELIBERATE'?'DELIBERATE':'AUTO',status:'SUCCEEDED'});expect(f.state().status).toBe('DONE');
  });

  it('does not resume on record-only or invalid input; a second stop cancels the new queued intent',async()=>{
    const f=await fixture();await f.stop();
    await f.cmd('message.submit',f.follow('仅记录',{intent:'record_only'}));
    expect(f.state().status).toBe('CANCELLED');
    expect(await f.raw('message.submit',f.follow('继续',{attachmentRefs:['nonexistent']}))).toMatchObject({ok:false});
    expect(f.state().status).toBe('CANCELLED');
    const queued=await f.cmd<{dispatchKey:string}>('message.submit',f.follow());
    // Once a new execution actually starts, another explicit stop must supersede it.
    await f.stop();expect(f.state().stop_generation).toBe(2);
    f.succeed();await f.worker.drain();
    expect(f.state().status).toBe('CANCELLED');
    expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE dispatch_key=?').get(queued.dispatchKey)).toEqual({status:'cancelled'});
  });

  it('rejects continuation while a stop is still waiting for an execution to exit',async()=>{
    const f=await fixture();await f.stop();
    f.db.prepare("UPDATE workflow_runs SET status='STOPPING' WHERE id=?").run(f.latest().id);
    f.db.prepare("UPDATE agent_turns SET status='STOPPING' WHERE run_id=?").run(f.latest().id);
    expect(await f.raw('message.submit',f.follow())).toMatchObject({ok:false,error:{code:'WORKER_STILL_RUNNING'}});
    expect(await f.raw('task.continue',f.binding())).toMatchObject({ok:false,error:{code:'WORKER_STILL_RUNNING'}});
    expect(f.state().status).toBe('CANCELLED');
  });

  it('keeps the already published member draft in the continued discussion context',async()=>{
    const f=await fixture('DELIBERATE',true);await f.stop();
    const replies=f.db.prepare("SELECT id,body_json FROM messages WHERE author_type='agent'").all();
    expect(replies.length).toBeGreaterThan(0);
    const before=f.adapter.startTurnLog.length;
    await f.cmd('message.submit',f.follow());f.succeed();await f.worker.drain();await f.worker.drain();
    expect(f.state().status).toBe('DONE');
    for(const reply of replies as Array<{id:string;body_json:string}>)
      expect(f.db.prepare('SELECT body_json FROM messages WHERE id=?').get(reply.id)).toEqual({body_json:reply.body_json});
    expect(f.adapter.startTurnLog.slice(before).some(turn=>turn.text.includes('接续已有讨论'))).toBe(true);
  });

  it('Continue uses the stopped follow-up mode even when the root originally used a different mode',async()=>{
    const f=await fixture();await f.stop();
    const detail=await f.cmd<{members:{version:string}}>('thread.get',{threadId:f.root.threadId});
    await f.cmd('thread.members.change',{projectId:f.project.id,threadId:f.root.threadId,memberId:f.members[1],action:'add',expectedVersion:detail.members.version});
    await f.cmd('message.submit',f.follow('请独立研讨',{collaboration:'deliberate'}));await f.stop();
    expect(f.latest().mode).toBe('DELIBERATE');
    await f.cmd('task.continue',f.binding());
    const request=f.db.prepare('SELECT route_json,stop_generation FROM thread_reply_requests ORDER BY rowid DESC LIMIT 1').get() as {route_json:string;stop_generation:number};
    expect(JSON.parse(request.route_json)).toMatchObject({mode:'DELIBERATE'});
    expect(request.stop_generation).toBe(2);
  });

  it('rejects stale stop snapshots and archived scopes without reopening or publishing a new message',async()=>{
    const f=await fixture();await f.stop();
    const before=f.state(),messages=f.db.prepare('SELECT count(*) n FROM messages').get();
    expect(await f.raw('task.continue',{...f.binding(),expectedStopGeneration:0})).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
    f.db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.project.id);
    expect(await f.raw('message.submit',f.follow())).toMatchObject({ok:false});
    expect(await f.raw('task.continue',f.binding())).toMatchObject({ok:false});
    expect(f.state()).toEqual(before);expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual(messages);
  });
});
