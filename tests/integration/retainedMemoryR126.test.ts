import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {disposeManagedJob,managedJobById,spawnManagedBridge} from '../../src/daemon/managed/bridge.ts';
import {readRoleMemory} from '../../src/persistence/stores/roleMemory.ts';

const evidenceRoot=resolve('dist/r126-review');
const cleanups:Array<()=>Promise<void>>=[];
const pause=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
beforeEach(()=>{
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY','0');
  vi.stubGlobal('fetch',()=>{throw Error('R126 retained memory forbids network');});
});
afterEach(async()=>{
  try{for(const close of cleanups.splice(0))await close();}
  finally{vi.unstubAllEnvs();vi.unstubAllGlobals();}
});

async function fixture(label:string){
  mkdirSync(evidenceRoot,{recursive:true});
  const dir=mkdtempSync(join(evidenceRoot,'retained-test-'+label+'-'));
  const releaseFile=join(dir,'release-child');
  // Real local Windows Job, no model/CLI. Shared identity keeps its exit evidence
  // available after the late business success, until formal releaseProtection.
  const child=spawnManagedBridge(process.execPath,['-e',
    "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(t)},20)",releaseFile],{cwd:dir});
  const childClosed=once(child,'close');child.stdout.resume();child.stderr.resume();
  let db=openDatabase(join(dir,'state.sqlite')),now=Date.now();
  const store=join(dir,'events');
  const adapter=new FakeRuntimeAdapter({sessionStoreDir:store,
    processIdentityOverride:()=>({model:'shared',pid:child.pid,managedJobId:child.managedJobId}),
    turnScriptSequencer:({text})=>text.includes('TOKEN_RETAINED')
      ?[{kind:'event',event:{kind:'process.exited',exitCode:7,expected:false}}]
      :[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',
        answer:'其他范围正常完成',responseKind:'conversation',changeSummary:'',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}]});
  const adapters=[adapter];
  const newWorker=(runtime:FakeRuntimeAdapter)=>new DispatchWorker({db,adapter:runtime,leaseOwner:randomUUID(),appDataDir:dir,
    detachedTurnConsumption:true,automaticRecovery:true,clock:()=>now});
  let worker=newWorker(adapter);
  const responses:unknown[]=[];
  const n=(sql:string,...args:unknown[])=>(db.prepare(sql).get(...args) as {n:number}).n;
  async function cmd<T>(method:string,params:unknown):Promise<T>{
    const r=await dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:dir,
      interruptTurn:id=>worker.interruptTurn(id),releaseAdmission:id=>worker.reconcileRelease(id),
      pumpLateEvents:id=>worker.pumpLateEventsForTurn(id)},
      {protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data?:T};
    responses.push({method,params,result:r});expect(r.ok,JSON.stringify(r)).toBe(true);return r.data as T;
  }
  cleanups.push(async()=>{
    try{writeFileSync(releaseFile,'release');await childClosed;}
    finally{
      for(const runtime of adapters)await runtime.closeAllSessions();
      await worker.awaitInFlightTurns(2000);
      try{expect(n('SELECT count(*) n FROM real_calls')).toBe(0);}
      finally{db.close();disposeManagedJob(child.managedJobId);}
    }
  });
  await cmd('app.settings.set',{key:'callBudget.enabled',value:'false'});
  const path=join(dir,'project');mkdirSync(path);
  const {project}=await cmd<{project:{id:string}}>('project.open',{path,agentNames:[]});
  const {memberId}=await cmd<{memberId:string}>('member.create',{projectId:project.id,displayName:'本地合成角色'});
  await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'plan'});
  const rooms:Array<{id:string;conversationId:string}>=[];
  for(let i=0;i<2;i++)rooms.push((await cmd<{room:{id:string;conversationId:string}}>('room.create',{
    projectId:project.id,name:'本地房间'+i,memberIds:[memberId]})).room);
  const send=(roomIndex:number,body:string)=>cmd<{taskId:string}>('message.submit',{
    target:{kind:'room_root',projectId:project.id,roomId:rooms[roomIndex]!.id,conversationId:rooms[roomIndex]!.conversationId},
    body,intent:'default',mentions:[{kind:'member',memberId}]});
  const task=await send(0,'TOKEN_RETAINED 等待核实的合成请求');
  await worker.runOnce();expect((await worker.awaitInFlightTurns(2000)).remaining).toEqual([]);
  const turn=db.prepare('SELECT a.* FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(task.taskId) as
    {id:string;run_id:string;session_id:string;status:string;stop_generation_snapshot:number};
  expect(turn.status).toBe('UNKNOWN');
  const reconcile=await cmd<{protectionRetained:boolean}>('recovery.reconcile',{
    turnId:turn.id,verdict:'executed',note:'合成本地载体仍在运行，退出事实尚未确认'});
  expect(reconcile.protectionRetained).toBe(true);
  adapter.pushLateEvent(turn.session_id,turn.id,{kind:'turn.completed',finalText:JSON.stringify({
    schemaVersion:'task-complete-v1',resultKey:'result_'+turn.id,answer:'迟到合法答复',responseKind:'conversation',changeSummary:'',
    files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],memoryUpdates:[{key:'fact',text:'RETAINED_LATE_NOTE'}]})});
  await cmd('recovery.pumpLateEvents',{turnId:turn.id});
  const scope={projectId:project.id,memberId,conversationId:rooms[0]!.conversationId};
  const state=()=>({turn:db.prepare('SELECT status,protection_state FROM agent_turns WHERE id=?').get(turn.id),
    pending:n('SELECT count(*) n FROM daemon_state WHERE key=?','role-memory-pending:'+turn.id),
    commits:n('SELECT count(*) n FROM role_memory_commits WHERE source_turn_id=?',turn.id),
    memory:readRoleMemory(db,scope),starts:adapters.reduce((sum,a)=>sum+a.startTurnLog.length,0)});
  const record=(stage:string)=>writeFileSync(join(dir,stage+'.json'),JSON.stringify({label,dir,turnId:turn.id,state:state(),responses},null,2));
  const retry=async()=>{now+=1001;await worker.runOnce();};
  async function release(){
    writeFileSync(releaseFile,'release');await childClosed;
    const until=Date.now()+5000;
    while(!managedJobById(child.managedJobId)!.releaseEvidence().releasable&&Date.now()<until)await pause(20);
    expect(managedJobById(child.managedJobId)!.releaseEvidence().releasable).toBe(true);
    const released=await cmd<{stateChanged:boolean}>('recovery.releaseProtection',{turnId:turn.id,note:'合成本地载体已真实完整退出'});
    expect(released.stateChanged).toBe(true);
  }
  async function reopen(){
    for(const runtime of adapters)await runtime.closeAllSessions();
    await worker.awaitInFlightTurns(2000);db.close();db=openDatabase(join(dir,'state.sqlite'));
    const fresh=new FakeRuntimeAdapter({sessionStoreDir:store});adapters.push(fresh);worker=newWorker(fresh);
  }
  return{get db(){return db;},get worker(){return worker;},task,turn,state,retry,release,reopen,record,send,n};
}

describe.skipIf(process.platform!=='win32')('R126 retained late memory: real Windows Job and formal recovery commands',()=>{
  it('preserves pending without merging while retained, across retry/reopen, while another scope completes',async()=>{
    const f=await fixture('waiting');
    expect(f.state()).toMatchObject({turn:{status:'SUCCEEDED',protection_state:'retained'},pending:1,commits:0});
    await f.retry();expect(f.state().pending).toBe(1);expect(f.state().memory.entries).toEqual([]);
    const other=await f.send(1,'TOKEN_OTHER_SCOPE 其他范围继续');await f.worker.drain();await f.worker.awaitInFlightTurns(2000);
    expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(other.taskId)).toEqual({status:'DONE'});
    await f.reopen();await f.retry();
    expect(f.state()).toMatchObject({pending:1,commits:0,starts:2});f.record('protected-reopen');
  });

  it('merges exactly once after real exit proof and formal release, including reopen and pump replay without model execution',async()=>{
    const f=await fixture('released');expect(f.state().pending).toBe(1);expect(f.state().commits).toBe(0);
    f.record('before-release');await f.release();await f.retry();
    expect(f.state()).toMatchObject({turn:{status:'SUCCEEDED',protection_state:'released'},pending:0,commits:1,starts:1});
    expect(f.state().memory.entries[0]!.values.map(v=>v.text)).toEqual(['RETAINED_LATE_NOTE']);
    await f.reopen();await f.worker.pumpLateEventsForTurn(f.turn.id);await f.reopen();await f.retry();
    expect(f.state()).toMatchObject({pending:0,commits:1,starts:1});expect(f.state().memory.revision).toBe(1);f.record('released-reopen-replay');
  });

  it('rejects the pending note when an effective user stop appears during protection waiting, without blocking another scope',async()=>{
    const f=await fixture('stopped');expect(f.state().pending).toBe(1);
    // A completed run cannot be stopped again through task.stop. Inject exactly
    // the authoritative effective-stop boundary, without changing the proposal,
    // bundle/hash, protection or SUCCEEDED turn. Historical stops are not enough.
    f.db.prepare('UPDATE tasks SET stop_generation=? WHERE id=?').run(f.turn.stop_generation_snapshot+1,f.task.taskId);
    await f.retry();expect(f.state()).toMatchObject({pending:0,commits:0});
    const other=await f.send(1,'TOKEN_OTHER_SCOPE_STOP 其他范围继续');await f.worker.drain();await f.worker.awaitInFlightTurns(2000);
    expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(other.taskId)).toEqual({status:'DONE'});
    await f.release();await f.reopen();await f.retry();
    expect(f.state()).toMatchObject({pending:0,commits:0,starts:2});expect(f.state().memory.entries).toEqual([]);f.record('stopped-release-reopen');
  });
});
