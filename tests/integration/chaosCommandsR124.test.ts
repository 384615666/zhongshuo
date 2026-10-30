import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {DispatchAdmission} from '../../src/daemon/admission.ts';
import {FakeRuntimeAdapter,type FakeAdapterOptions} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import type {OpenSessionInput,SessionRef,TurnRequest} from '../../src/contracts/runtime.ts';

// Own fixture: no shared helper edits and no evidence outside this agent's path.
const evidenceRoot=resolve('dist/r124-chaos/commands');
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const complete=(answer:string,extra:Record<string,unknown>={},ms=15):FakeTurnScript=>[
  {kind:'stall',ms},
  {kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',answer,changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...extra})}},
];
function latch(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return{promise,release};}

class CommandAdapter extends FakeRuntimeAdapter{
  readonly scopes=new Map<string,OpenSessionInput>();
  readonly starts:Array<{turnId:string;sessionId:string;taskId:string;memberId:string;threadId:string|null|undefined;text:string;repairOnly:boolean}>=[];
  readonly closed:string[]=[];
  onOpen?:(input:OpenSessionInput,session:SessionRef)=>Promise<void>;
  constructor(options:FakeAdapterOptions={}){super(options);}
  override async openSession(input:OpenSessionInput){
    const session=await super.openSession(input);this.scopes.set(session.id,input);
    await this.onOpen?.(input,session);return session;
  }
  override async startTurn(session:SessionRef,input:TurnRequest){
    const scope=this.scopes.get(session.id)!;
    this.starts.push({turnId:input.turnId,sessionId:session.id,taskId:scope.taskId,memberId:scope.memberId,threadId:scope.threadId,text:input.text,repairOnly:input.repairOnly===true});
    await super.startTurn(session,input);
  }
  override async close(session:SessionRef){this.closed.push(session.id);await super.close(session);}
}

type Root={taskId:string;threadId:string;messageId:string};
type Reply={ok:boolean;data?:unknown;error?:{code:string;message:string};replayed?:boolean};
type Fixture=Awaited<ReturnType<typeof fixture>>;
let completedOutcome='not-opened';
let completedAudit:{realCalls:number;scopeViolations:string[];messageScopeViolations:number;duplicateStarts:number}|undefined;
beforeEach(()=>{
  completedOutcome='not-opened';completedAudit=undefined;
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
  vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY','0');
});
afterEach(()=>{
  try{
    expect(['guarded','defect-reproduced','boundary-counterexample'],'test must reach its business oracle; expected-failure cannot hide fixture errors').toContain(completedOutcome);
    // Hooks are outside it.fails: infrastructure/isolation failures stay red.
    expect(completedAudit,'all scenarios must close with independently checked execution identities').toEqual({realCalls:0,scopeViolations:[],messageScopeViolations:0,duplicateStarts:0});
  }
  finally{vi.unstubAllEnvs();}
});

async function fixture(label:string,options:{adapter?:CommandAdapter;projects?:number;writable?:boolean}={}){
  mkdirSync(evidenceRoot,{recursive:true});
  const dir=mkdtempSync(join(evidenceRoot,label+'-')),db=openDatabase(join(dir,'state.sqlite'));
  const adapter=options.adapter??new CommandAdapter({turnScriptSequencer:()=>complete('本串完成')});
  const admission=new DispatchAdmission({globalMaxInFlight:4,perProjectMaxInFlight:2,perProviderMaxInFlight:2});
  const worker=new DispatchWorker({db,adapter,admission,leaseOwner:randomUUID(),appDataDir:dir,detachedTurnConsumption:true,interruptGraceMs:55,automaticRecovery:false});
  const commands:Array<{method:string;params:unknown;commandId:string;result:Reply}>=[];
  const raw=async(method:string,params:unknown,commandId:string=randomUUID())=>{
    const result=await dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:dir,interruptTurn:id=>worker.interruptTurn(id),releaseAdmission:id=>{admission.release(id);}},{protocolVersion:1,commandId,method,params}) as Reply;
    commands.push({method,params,commandId,result});return result;
  };
  const cmd=async<T=unknown>(method:string,params:unknown,commandId?:string):Promise<T>=>{
    const result=await raw(method,params,commandId);if(!result.ok)throw Error(`${method}: ${JSON.stringify(result.error)}`);return result.data as T;
  };
  await cmd('app.settings.set',{key:'callBudget.enabled',value:'false'});
  const projects:Array<{id:string;path:string;members:string[];rooms:Array<{id:string;conversationId:string}>}>=[];
  for(let i=0;i<(options.projects??1);i++){
    const path=join(dir,`project-${i}`);mkdirSync(path);
    const {project}=await cmd<{project:{id:string}}>('project.open',{path,agentNames:[]});
    const members:string[]=[];
    for(let m=0;m<3;m++){
      const {memberId}=await cmd<{memberId:string}>('member.create',{projectId:project.id,displayName:`R124角色${m}`});
      await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:options.writable?'bypassPermissions':'plan'});members.push(memberId);
    }
    const rooms=[];
    for(let r=0;r<3;r++)rooms.push((await cmd<{room:{id:string;conversationId:string}}>('room.create',{projectId:project.id,name:`R124房间${r}`,memberIds:members})).room);
    projects.push({id:project.id,path,members,rooms});
  }
  const params=(p:number,r:number,m:number[],body:string)=>({target:{kind:'room_root',projectId:projects[p]!.id,roomId:projects[p]!.rooms[r]!.id,conversationId:projects[p]!.rooms[r]!.conversationId},body,intent:'default',mentions:m.map(i=>({kind:'member',memberId:projects[p]!.members[i]}))});
  const send=(p:number,r:number,m:number[],body:string,id?:string)=>cmd<Root>('message.submit',params(p,r,m,body),id);
  const status=(id:string)=>(db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as {status:string}).status;
  const count=(sql:string,...args:unknown[])=>(db.prepare(sql).get(...args) as {n:number}).n;
  const wait=async(predicate:()=>boolean,timeout=6000)=>{
    const end=Date.now()+timeout;while(!predicate()&&Date.now()<end)await pause(3);
    expect(predicate(),'bounded event wait').toBe(true);
  };
  const pump=async(predicate:()=>boolean,timeout=8000)=>{
    const end=Date.now()+timeout;
    do{await worker.drain();if(predicate())return;await pause(3);}while(Date.now()<end);
    throw Error(`pump timeout ${JSON.stringify({tasks:db.prepare('SELECT id,status,stop_generation FROM tasks').all(),outbox:db.prepare('SELECT dispatch_key,status FROM outbox').all()})}`);
  };
  const run=(taskId:string)=>(db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as {id:string}).id;
  const generation=(taskId:string)=>(db.prepare('SELECT stop_generation g FROM tasks WHERE id=?').get(taskId) as {g:number}).g;
  const stop=(root:Root,id?:string)=>cmd('task.stop',{taskId:root.taskId,targetRunId:run(root.taskId),expectedStopGeneration:generation(root.taskId)},id);
  let facts:Record<string,unknown>={outcome:'incomplete'};
  const save=(value:Record<string,unknown>)=>{facts=value;};
  const close=async()=>{
    completedOutcome=String(facts.outcome);
    const scopeViolations=adapter.starts.filter(start=>{
      const row=db.prepare('SELECT r.task_id,a.member_id,a.thread_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE a.id=?').get(start.turnId) as {task_id:string;member_id:string;thread_id:string}|undefined;
      return !row||row.task_id!==start.taskId||row.member_id!==start.memberId||row.thread_id!==start.threadId;
    }).map(start=>start.turnId);
    const messageScopeViolations=count(`SELECT count(*) n FROM messages m JOIN tasks t ON t.id=m.task_id
      WHERE m.thread_id IS NOT NULL AND (m.project_id!=t.project_id OR m.conversation_id!=t.conversation_id OR m.thread_id!=t.conversation_thread_id)`);
    completedAudit={realCalls:count('SELECT count(*) n FROM real_calls'),scopeViolations,messageScopeViolations,duplicateStarts:adapter.starts.length-new Set(adapter.starts.map(start=>start.turnId)).size};
    writeFileSync(join(dir,'evidence.json'),JSON.stringify({label,dir,seed:null,...facts,realCalls:completedAudit.realCalls,audit:completedAudit,guards:{allowFake:process.env.ZS_ALLOW_FAKE,runtime:process.env.ZS_RUNTIME,realDispatchGuard:process.env.ZS_REAL_DISPATCH_GUARD,defaultMemberDiscovery:process.env.ZS_DEFAULT_MEMBER_DISCOVERY},commands,starts:adapter.starts,writtenFiles:adapter.writtenFiles,scopes:[...adapter.scopes.values()],admission:admission.snapshot(),tasks:db.prepare('SELECT id,status,owner_member_id,parent_task_id,conversation_thread_id,stop_generation FROM tasks').all(),runs:db.prepare('SELECT id,task_id,status FROM workflow_runs').all(),turns:db.prepare('SELECT id,run_id,status,turn_purpose,protection_state FROM agent_turns').all(),outbox:db.prepare('SELECT dispatch_key,status,stop_generation_at_enqueue FROM outbox').all(),replies:db.prepare('SELECT message_id,task_id,member_id,status,error_message,turn_id FROM thread_reply_requests').all(),repairs:db.prepare('SELECT id,task_id,status,consumed_turn_id FROM format_repair_workitems').all(),leases:db.prepare('SELECT * FROM workspace_leases').all(),events:db.prepare('SELECT seq,kind,task_id,run_id,turn_id,payload_json FROM domain_events ORDER BY seq').all()},null,2));
    expect(count('SELECT count(*) n FROM real_calls'),'zero real model calls').toBe(0);
    worker.stopAccepting();await adapter.closeAllSessions();await worker.awaitInFlightTurns(2500);db.close();
  };
  return{dir,db,adapter,admission,worker,commands,raw,cmd,projects,params,send,status,count,wait,pump,run,generation,stop,save,close};
}

function followParams(f:Fixture,root:Root,memberId:string,body:string){
  const row=f.db.prepare('SELECT project_id,conversation_id FROM tasks WHERE id=?').get(root.taskId) as {project_id:string;conversation_id:string};
  return{target:{kind:'thread',projectId:row.project_id,conversationId:row.conversation_id,threadId:root.threadId},body,intent:'default',mentions:[{kind:'member',memberId}]};
}
async function removeThread(f:Fixture,root:Root,memberId:string){
  const {members}=await f.cmd<{members:{version:string}}>('thread.get',{threadId:root.threadId});
  await f.cmd('thread.members.change',{projectId:f.projects[0]!.id,threadId:root.threadId,memberId,action:'remove',expectedVersion:members.version});
}
function noDuplicateStarts(f:Fixture){expect(new Set(f.adapter.starts.map(t=>t.turnId)).size).toBe(f.adapter.starts.length);}

describe('R124 command order and scheduler chaos; isolated Fake only',()=>{
  it('A01 cross-target IDs reject with IDEMPOTENCY_CONFLICT and preserve the original execution',async()=>{
    const adapter=new CommandAdapter({turnScriptSequencer:()=>complete('本串专属答复',{},200)});
    const f=await fixture('a01-cross-target-id',{adapter,projects:2});
    try{
      const id='r124-a01-collision',params=f.params(0,0,[0],'A01_FIRST_ROOT');
      const a=await f.cmd<Root>('message.submit',params,id);await f.worker.runOnce();
      const b=await f.send(1,1,[1],'A01_SECOND_PROJECT');
      const collisions=await Promise.all([
        f.raw('message.submit',f.params(1,1,[1],'A01_RETARGET'),id),
        f.raw('message.submit',followParams(f,a,f.projects[0]!.members[0]!,'A01_THREAD_RETARGET'),id),
        f.raw('task.stop',{taskId:a.taskId,targetRunId:f.run(a.taskId),expectedStopGeneration:0},id),
      ]);
      expect(collisions.every(r=>!r.ok)).toBe(true);
      expect(collisions.slice(0,2).map(r=>r.error?.code)).toEqual(Array(2).fill('IDEMPOTENCY_CONFLICT'));
      expect((await f.cmd<Root>('message.submit',params,id)).taskId).toBe(a.taskId);
      await f.pump(()=>[a,b].every(r=>f.status(r.taskId)==='DONE'));
      expect(adapter.starts).toHaveLength(2);expect(f.generation(a.taskId)).toBe(0);
      expect(f.count('SELECT count(*) n FROM thread_reply_requests')).toBe(0);
      expect(adapter.starts.find(t=>t.taskId===b.taskId)!.text).not.toContain('A01_FIRST_ROOT');
      noDuplicateStarts(f);
      f.save({outcome:collisions[2]!.error?.code==='STORAGE_UNAVAILABLE'?'defect-reproduced':'guarded',oracle:'cross-method id collision returns IDEMPOTENCY_CONFLICT',conflictResults:collisions,retargetPrevented:true,starts:2});
      expect(collisions.map(r=>r.error?.code),'same idempotency conflict must have the same public business error across methods').toEqual(Array(3).fill('IDEMPOTENCY_CONFLICT'));
    }finally{await f.close();}
  });

  it('A02 stop cancels queued replies; disabled/re-enabled role and accepted send replay do not resurrect them',async()=>{
    const adapter=new CommandAdapter({turnScriptSequencer:({text})=>complete('独立完成',{},text.includes('A02_STOP_ROOT')?5000:20)});
    const f=await fixture('a02-stop-replay-disable',{adapter,projects:2});
    try{
      const id='r124-a02-root-replay',params=f.params(0,0,[1],'A02_STOP_ROOT');
      const a=await f.cmd<Root>('message.submit',params,id);await f.worker.runOnce();
      for(let i=0;i<4;i++)await f.cmd('message.submit',followParams(f,a,f.projects[0]!.members[1]!,`A02_OLD_FOLLOW_${i}`));
      const oldRun=f.run(a.taskId);await f.stop(a);
      await f.cmd('member.setEnabled',{memberId:f.projects[0]!.members[1],enabled:false});
      await f.cmd('member.setEnabled',{memberId:f.projects[0]!.members[1],enabled:true});
      const replay=await f.raw('message.submit',params,id);expect(replay.ok).toBe(true);expect(replay.replayed).toBe(true);
      const b=await f.send(1,2,[2],'A02_OTHER_PROJECT');
      await f.pump(()=>f.status(a.taskId)==='CANCELLED'&&f.status(b.taskId)==='DONE');
      const stale=await f.raw('task.stop',{taskId:a.taskId,targetRunId:oldRun,expectedStopGeneration:0});expect(stale.ok).toBe(true);
      await f.worker.drain();
      expect(f.count("SELECT count(*) n FROM thread_reply_requests WHERE task_id=? AND status='cancelled'",a.taskId)).toBe(4);
      expect(adapter.starts.filter(t=>t.taskId===a.taskId)).toHaveLength(1);
      expect(f.generation(a.taskId)).toBe(1);expect(f.admission.snapshot().global).toBe(0);
      noDuplicateStarts(f);f.save({outcome:'guarded',cancelledReplies:4,replayedRoot:true,unrelatedDone:1});
    }finally{await f.close();}
  });

  it('A03 repeated stops during one session-open window advance only once',async()=>{
    const gate=latch(),entered=latch();const adapter=new CommandAdapter({turnScriptSequencer:()=>complete('不会启动')});
    const f=await fixture('a03-stop-generation',{adapter,projects:2});let opening:Promise<boolean>|undefined;
    try{
      const a=await f.send(0,0,[1],'A03_OPEN_GATE');
      adapter.onOpen=async scope=>{if(scope.taskId===a.taskId){entered.release();await gate.promise;}};
      opening=f.worker.runOnce();await entered.promise;
      const targetRunId=f.run(a.taskId),params={taskId:a.taskId,targetRunId,expectedStopGeneration:0};
      const results=[];for(let i=0;i<5;i++)results.push(await f.raw('task.stop',params,`r124-a03-stop-${i}`));
      expect(results.every(r=>r.ok)).toBe(true);const observedGeneration=f.generation(a.taskId);
      const heldBeforeRelease=f.admission.snapshot().global;
      gate.release();await opening;
      const b=await f.send(1,0,[0],'A03_OTHER');await f.pump(()=>f.status(b.taskId)==='DONE');
      expect(f.status(a.taskId)).toBe('CANCELLED');expect(adapter.starts.some(t=>t.taskId===a.taskId)).toBe(false);
      expect(heldBeforeRelease).toBe(1);expect(f.admission.snapshot().global).toBe(0);
      f.save({outcome:observedGeneration===1?'guarded':'defect-reproduced',oracle:'same run stop must advance generation once',observedGeneration,expectedGeneration:1,stopResults:results,unrelatedDone:1});
      expect(observedGeneration,'same STOPPING run, five fresh commandIds, frozen expectedStopGeneration=0').toBe(1);
    }finally{gate.release();await opening;await f.close();}
  });

  it('A04 queued reply roster removal and permission drift block their own envelopes while another thread advances',async()=>{
    const f=await fixture('a04-roster-config-interleave');
    try{
      const a=await f.send(0,0,[0],'A04_ROOT');await f.pump(()=>f.status(a.taskId)==='DONE');
      const m=f.projects[0]!.members;
      await f.cmd('message.submit',followParams(f,a,m[1]!,'A04_REMOVED_RECIPIENT'));
      await f.cmd('message.submit',followParams(f,a,m[2]!,'A04_CONFIG_CHANGED_RECIPIENT'));
      const scopes=f.db.prepare('SELECT message_id,write_scope_json,roster_json FROM thread_reply_requests ORDER BY rowid').all();
      await removeThread(f,a,m[1]!);
      await f.cmd('member.setRuntime',{memberId:m[2],kind:'fake',permissionMode:'bypassPermissions'});
      const b=await f.send(0,1,[0],'A04_UNRELATED_THREAD');
      await f.pump(()=>f.count("SELECT count(*) n FROM thread_reply_requests WHERE status='blocked'")===2&&f.status(b.taskId)==='DONE');
      expect(f.db.prepare('SELECT message_id,write_scope_json,roster_json FROM thread_reply_requests ORDER BY rowid').all()).toEqual(scopes);
      expect(f.count("SELECT count(*) n FROM thread_reply_requests WHERE error_message LIKE '%移出%' OR error_message LIKE '%配置%'")).toBe(2);
      await f.cmd('member.setRuntime',{memberId:m[2],kind:'fake',permissionMode:'plan'});await f.worker.drain();
      expect(f.count("SELECT count(*) n FROM thread_reply_requests WHERE status='blocked'")).toBe(2);
      expect(f.adapter.starts.map(t=>t.taskId)).toEqual([a.taskId,b.taskId]);
      noDuplicateStarts(f);f.save({outcome:'guarded',blockedReplies:2,immutableSnapshots:true,unrelatedDone:1});
    }finally{await f.close();}
  });

  it('A05 room archive rejects OPEN queued work; accepted work and replay remain valid until completion',async()=>{
    const adapter=new CommandAdapter({turnScriptSequencer:({text})=>text.includes('A05_QUEUED_ROOT')?[{kind:'writeFile',path:'archived-output.txt',content:'A05_WRITTEN_AFTER_ARCHIVE'},...complete('A05_WRITER_DONE')]:complete('A05_OTHER_DONE')});
    const f=await fixture('a05-archive-queued',{adapter,writable:true});
    try{
      const id='r124-a05-queued-root',params=f.params(0,0,[1],'A05_QUEUED_ROOT');
      const a=await f.cmd<Root>('message.submit',params,id);
      const roomId=f.projects[0]!.rooms[0]!.id;
      const {revision}=f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(roomId) as {revision:number};
      expect(f.status(a.taskId)).toBe('OPEN');expect(adapter.starts).toHaveLength(0);
      const archived=await f.raw('room.archive',{roomId,expectedRevision:revision,action:'archive'});
      const replay=await f.raw('message.submit',params,id);
      const b=await f.send(0,1,[2],'A05_OTHER_ROOM');await f.pump(()=>f.status(b.taskId)==='DONE');
      const queuedStarts=f.adapter.starts.filter(t=>t.taskId===a.taskId).length;
      // Refusing archive while queued work exists OR fencing dispatch is valid.
      const archivedStarted=archived.ok&&queuedStarts>0;
      if(archived.ok){expect(replay.ok).toBe(false);expect(replay.error?.code).toBe('CONVERSATION_UNAVAILABLE');}
      else expect(archived.error?.code).toBe('WORKER_STILL_RUNNING');
      expect(archived).toMatchObject({ok:false,error:{code:'WORKER_STILL_RUNNING'}});
      expect(f.db.prepare('SELECT archived_at,revision FROM rooms WHERE id=?').get(roomId)).toEqual({archived_at:null,revision});
      expect(replay).toMatchObject({ok:true,replayed:true,data:{taskId:a.taskId}});
      expect(queuedStarts).toBe(1);
      expect(readFileSync(join(f.projects[0]!.path,'archived-output.txt'),'utf8')).toBe('A05_WRITTEN_AFTER_ARCHIVE');
      await f.pump(()=>f.status(a.taskId)==='DONE');
      expect(await f.raw('room.archive',{roomId,expectedRevision:revision,action:'archive'})).toMatchObject({ok:true});
      expect(await f.raw('message.submit',params,id)).toMatchObject({ok:false,error:{code:'CONVERSATION_UNAVAILABLE'}});
      if(archivedStarted)expect(readFileSync(join(f.projects[0]!.path,'archived-output.txt'),'utf8')).toBe('A05_WRITTEN_AFTER_ARCHIVE');
      noDuplicateStarts(f);
      f.save({outcome:archivedStarted?'defect-reproduced':'guarded',oracle:'no task starts in successfully archived room',archived,replay,queuedStarts,actualProjectFileWritten:existsSync(join(f.projects[0]!.path,'archived-output.txt')),unrelatedDone:1});
      expect(archivedStarted,'archive was accepted before any root turn started, then worker started that archived room').toBe(false);
    }finally{await f.close();}
  });

  it.fails('A06 [BOUNDARY COUNTEREXAMPLE: disabled already-DISPATCHING writer] stronger no-first-start-after-disable oracle',async()=>{
    const gate=latch(),entered=latch();const adapter=new CommandAdapter({turnScriptSequencer:({text})=>text.includes('A06_NOT_STARTED')?[{kind:'writeFile',path:'disabled-output.txt',content:'A06_WRITTEN_WHILE_DISABLED'},...complete('A06_FAKE')]:complete('A06_OTHER_DONE')});
    const f=await fixture('a06-disable-open',{adapter,projects:2,writable:true});let opening:Promise<boolean>|undefined;
    try{
      const a=await f.send(0,0,[1],'A06_NOT_STARTED');
      adapter.onOpen=async scope=>{if(scope.taskId===a.taskId){entered.release();await gate.promise;}};
      opening=f.worker.runOnce();await entered.promise;expect(adapter.starts).toHaveLength(0);
      await f.cmd('member.setEnabled',{memberId:f.projects[0]!.members[1],enabled:false});
      gate.release();await opening;
      const b=await f.send(1,1,[2],'A06_OTHER');await f.pump(()=>f.status(b.taskId)==='DONE'&&f.admission.snapshot().global===0);
      const disabledStarts=adapter.starts.filter(t=>t.taskId===a.taskId).length;
      expect(f.count('SELECT count(*) n FROM project_members WHERE id=? AND enabled=0',f.projects[0]!.members[1])).toBe(1);
      if(disabledStarts)expect(readFileSync(join(f.projects[0]!.path,'disabled-output.txt'),'utf8')).toBe('A06_WRITTEN_WHILE_DISABLED');
      // commands.ts explicitly exempts in-flight turns from disable. This proves
      // a stronger startTurn-boundary oracle, not an unambiguous spec defect.
      f.save({outcome:disabledStarts?'boundary-counterexample':'guarded',oracle:'stronger proposed boundary: disable before first startTurn means no new dispatch',contractCaveat:'current member.setEnabled contract exempts in-flight turns; DISPATCHING already exists before openSession',disabledStarts,actualProjectFileWritten:existsSync(join(f.projects[0]!.path,'disabled-output.txt')),disabledTaskStatus:f.status(a.taskId),unrelatedDone:1});
      expect(disabledStarts,'member.setEnabled(false) completed while openSession was held and before any startTurn').toBe(0);
    }finally{gate.release();await opening;await f.close();}
  });

  it('A07 failed writer configuration recheck releases only its own protection; stale stop cannot unlock a subsequent writer',async()=>{
    const gate=latch(),entered=latch();const adapter=new CommandAdapter({turnScriptSequencer:({text})=>complete('A07_OK',{},text.includes('A07_NEXT_WRITER')?1000:20)});
    const f=await fixture('a07-writer-lock-handover',{adapter,writable:true,projects:2});let opening:Promise<boolean>|undefined;
    try{
      const a=await f.send(0,0,[1],'A07_OLD_WRITER');
      adapter.onOpen=async scope=>{if(scope.taskId===a.taskId){entered.release();await gate.promise;}};
      opening=f.worker.runOnce();await entered.promise;
      const oldRun=f.run(a.taskId),oldTurn=(f.db.prepare('SELECT id FROM agent_turns WHERE run_id=?').get(oldRun) as {id:string}).id;
      await f.cmd('member.setRuntime',{memberId:f.projects[0]!.members[1],kind:'fake',permissionMode:'plan'});
      gate.release();await expect(opening).rejects.toThrow('配置已变化');
      expect(adapter.starts.some(t=>t.taskId===a.taskId)).toBe(false);expect(f.admission.has(oldTurn)).toBe(false);
      // This oracle deliberately exercises the restricted single-writer queue;
      // R127 full-access independent threads now share the physical directory.
      for(const memberId of [f.projects[0]!.members[0]!,f.projects[0]!.members[2]!])await f.cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'acceptEdits'});
      await f.cmd('project.writeAccess.set',{projectId:f.projects[0]!.id,authorized:true,expectedRevision:0});
      const b=await f.send(0,1,[2],'A07_NEXT_WRITER');await f.worker.runOnce();
      const nextTurn=adapter.starts.find(t=>t.taskId===b.taskId)!.turnId;
      const stale=await f.raw('task.stop',{taskId:a.taskId,targetRunId:oldRun,expectedStopGeneration:0});expect(stale.ok).toBe(true);
      expect(f.admission.has(nextTurn)).toBe(true);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE owner_turn_id=? AND status!='released'",nextTurn)).toBe(1);
      const c=await f.send(0,2,[0],'A07_THIRD_WRITER'),d=await f.send(1,0,[2],'A07_OTHER_PROJECT');
      await f.worker.drain();expect(adapter.starts.some(t=>t.taskId===c.taskId)).toBe(false);
      await f.pump(()=>[b,c,d].every(r=>f.status(r.taskId)==='DONE'));
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);expect(f.admission.snapshot().global).toBe(0);
      noDuplicateStarts(f);f.save({outcome:'guarded',oldWriterNeverStarted:true,newWriterProtectionSurvivedStaleStop:true,completedWriters:3});
    }finally{gate.release();await opening?.catch(()=>{});await f.close();}
  },15000);

  it('A08 child repair preserves review obligation; duplicate repair and late stop on failed parent do not dispatch more work',async()=>{
    let currentScript:FakeTurnScript=complete('fallback'),parentId='';
    const adapter=new CommandAdapter({turnScriptSequencer:()=>currentScript});
    const f=await fixture('a08-repair-handoff-stop',{adapter,projects:2});
    const originalStart=adapter.startTurn.bind(adapter);
    adapter.startTurn=async(session,input)=>{
      const scope=adapter.scopes.get(session.id)!;
      const task=f.db.prepare('SELECT parent_task_id FROM tasks WHERE id=?').get(scope.taskId) as {parent_task_id:string|null};
      let extra:Record<string,unknown>={};
      if(scope.taskId===parentId&&!input.repairOnly)extra={coordinationPlan:{summary:'先分析后核对',steps:[{key:'work',memberId:f.projects[0]!.members[1],title:'分析',objective:'A08_CHILD',role:'analysis',dependsOn:[]}]}};
      else if(task.parent_task_id&&!input.repairOnly)extra={unexpectedField:'deliberate strict-schema error',handoffs:[{toMemberId:f.projects[0]!.members[2],purpose:'review',message:'A08_REVIEW_MUST_SURVIVE'}]};
      // Fake script is selected by the real adapter after this synchronous hook.
      currentScript=complete('A08_ANSWER',extra);
      await originalStart(session,input);
    };
    try{
      const root=await f.send(0,0,[0,1,2],'A08_ROOT');parentId=root.taskId;
      await f.pump(()=>f.count("SELECT count(*) n FROM domain_events WHERE kind='turn.outputInvalid'")===1);
      const child=(f.db.prepare('SELECT id FROM tasks WHERE parent_task_id=?').get(root.taskId) as {id:string}).id;
      expect(f.count('SELECT count(*) n FROM coordination_messages')).toBe(0);
      const repairId='r124-a08-repair-intent',params={taskId:child,formatRepair:true,reason:'只修格式，保留复核交接'};
      expect((await f.raw('task.redispatch',params,repairId)).ok).toBe(true);
      expect((await f.raw('task.redispatch',params,repairId)).replayed).toBe(true);
      const independent=await f.send(1,1,[1],'A08_OTHER');
      await f.pump(()=>f.count("SELECT count(*) n FROM agent_turns WHERE turn_purpose='format_repair' AND status='FAILED'")===1&&f.status(independent.taskId)==='DONE');
      expect(f.status(child)).toBe('BLOCKED');
      expect(f.count("SELECT count(*) n FROM domain_events WHERE kind='turn.outputInvalid' AND payload_json LIKE '%遗漏%handoffs%'")).toBe(1);
      expect(f.count('SELECT count(*) n FROM coordination_messages')).toBe(0);
      const rootParams={taskId:root.taskId,targetRunId:f.run(root.taskId),expectedStopGeneration:f.generation(root.taskId)};
      const lateStop=await f.raw('task.stop',rootParams);
      expect(lateStop).toMatchObject({ok:true,data:{outcome:'already_stopped',stopGeneration:0}});await f.worker.drain();
      expect(f.status(root.taskId)).toBe('BLOCKED');
      const retry=await f.raw('task.redispatch',params);expect(retry.ok).toBe(false);
      expect(adapter.starts.filter(t=>t.taskId===child)).toHaveLength(2);
      noDuplicateStarts(f);f.save({outcome:'guarded',originalChildFailed:true,repairFailedForDroppedReview:true,repairIntentReplay:true,reviewExecutions:0,parentLateStop:lateStop,parentRemainedBlocked:true,unrelatedDone:1});
    }finally{await f.close();}
  },15000);

  it('A09 UNKNOWN writer keeps its lease across disable/removal/config changes and send/stop replay; another project progresses',async()=>{
    const adapter=new CommandAdapter({turnScriptSequencer:({text})=>text.includes('A09_UNKNOWN')?[{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:60000}]:complete('A09_OTHER_DONE')});
    const f=await fixture('a09-unknown-mutation-lock',{adapter,writable:true,projects:2});
    try{
      const rootId='r124-a09-root',params=f.params(0,0,[1],'A09_UNKNOWN');
      const a=await f.cmd<Root>('message.submit',params,rootId);await f.worker.runOnce();await pause(8);
      const turn=adapter.starts[0]!.turnId,stopId='r124-a09-stop',stopParams={taskId:a.taskId,targetRunId:f.run(a.taskId),expectedStopGeneration:0};
      expect((await f.raw('task.stop',stopParams,stopId)).ok).toBe(true);
      await f.pump(()=>f.count("SELECT count(*) n FROM agent_turns WHERE id=? AND status='UNKNOWN'",turn)===1);
      await f.cmd('member.setEnabled',{memberId:f.projects[0]!.members[1],enabled:false});
      await f.cmd('room.members.set',{roomId:f.projects[0]!.rooms[0]!.id,memberId:f.projects[0]!.members[1],action:'remove'});
      await f.cmd('member.setRuntime',{memberId:f.projects[0]!.members[1],kind:'fake',permissionMode:'plan'});
      expect((await f.raw('task.stop',stopParams,stopId)).ok).toBe(true);
      await f.raw('message.submit',params,rootId);
      const blocked=await f.send(0,1,[2],'A09_SAME_ROOT_WAITING'),other=await f.send(1,1,[2],'A09_OTHER_PROJECT');
      await f.pump(()=>f.status(other.taskId)==='DONE');await f.worker.drain();
      expect(adapter.starts.some(t=>t.taskId===blocked.taskId)).toBe(false);
      expect(adapter.starts.filter(t=>t.taskId===a.taskId)).toHaveLength(1);
      expect(f.admission.has(turn)).toBe(true);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE owner_turn_id=? AND status!='released'",turn)).toBe(1);
      expect(f.count("SELECT count(*) n FROM domain_events WHERE turn_id=? AND kind='recovery.protectionReleased'",turn)).toBe(0);
      expect(f.count("SELECT count(*) n FROM agent_turns WHERE id=? AND status='UNKNOWN'",turn)).toBe(1);
      noDuplicateStarts(f);f.save({outcome:'guarded',unknownLeaseRetained:true,samePhysicalRootStarts:0,unrelatedDone:1});
    }finally{await f.close();}
  },15000);
});
