import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dispatchBlockedFixture} from '../fixtures/dispatchBlockedR154.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';

const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0))close();vi.unstubAllEnvs();});
type Reply={ok:boolean;replayed?:boolean;data?:{enqueued:boolean;dispatchKey:string;interruptedTasks:Array<{taskId:string}>};error?:{code:string;message:string}};
function fixture(){
  vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_ALLOW_FAKE','1');
  const root=mkdtempSync(join(tmpdir(),'zs-r169-')),{db,event}=dispatchBlockedFixture();
  cleanups.push(()=>{db.close();rmSync(root,{recursive:true,force:true});});
  const project=realpathSync.native(root);
  db.prepare("UPDATE projects SET root_path=?,canonical_path=? WHERE id='p'").run(project,project);
  db.exec("UPDATE workflow_runs SET status='INTERRUPTED' WHERE id='parent-current'; UPDATE tasks SET status='ACTIVE' WHERE id='parent'; UPDATE conversation_threads SET root_task_id='parent' WHERE id='thread'; UPDATE conversations SET last_message_seq=1 WHERE id='conv'");
  db.prepare("UPDATE tasks SET route_json=? WHERE id='parent'").run(JSON.stringify({kind:'dispatch',mode:'DIRECT',targetMemberId:'owner',frozenMemberIds:['owner'],initialWakeMemberIds:['owner']}));
  db.prepare("UPDATE messages SET body_json=? WHERE id='msg'").run(JSON.stringify({text:'继续原任务',mentions:[]}));
  const key='task:parent:redispatch:parent-current';
  db.prepare("INSERT INTO outbox(dispatch_key,status,stop_generation_at_enqueue) VALUES(?,'done',0)").run(key);
  event('parent','parent-current','recovery.protectionReleased',{released:true,reason:'user-continue-interrupted-task'});
  event('parent',null,'task.redispatchEnqueued',{sourceRunId:'parent-current',dispatchKey:key});
  const binding={taskId:'parent',sourceRunId:'parent-current',expectedTaskRevision:0,expectedStopGeneration:0};
  const command=(method:string,params:unknown={},commandId=randomUUID())=>dispatchDaemonCommand({db,localUserId:'u',appDataDir:root,interruptTurn:async()=>{}},
    {protocolVersion:1,commandId,method,params}) as Promise<Reply>;
  return {db,event,root,key,binding,command};
}
function snapshot(f:ReturnType<typeof fixture>){
  return Object.fromEntries(['tasks','workflow_runs','agent_turns','outbox','domain_events','workspace_leases','command_receipts']
    .map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

describe('R169 recovery and conversation use current execution facts',()=>{
  it('finds the interrupted root after protection release and an earlier consumed continuation, without writes',async()=>{
    const f=fixture(),before=snapshot(f);
    const status=readTaskExecutionStatus(f.db,'parent')!;
    expect(status).toMatchObject({phase:'UNKNOWN',reason:{code:'NO_EXECUTION_EVIDENCE'}});
    expect(status.actions).toContainEqual(expect.objectContaining({kind:'continue',binding:f.binding}));
    expect((await f.command('recovery.status')).data?.interruptedTasks).toContainEqual({taskId:'parent'});
    expect(snapshot(f)).toEqual(before);
  });

  it.each(['queued','running','completed','cancelled'] as const)('does not offer a recovered %s task as an interruption',async state=>{
    const f=fixture();
    if(state==='queued')f.db.prepare("INSERT INTO outbox(dispatch_key,status) VALUES('task:parent:thread-reply:new','pending')").run();
    if(state==='running')f.db.exec(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES('new-run','parent','conv','thread','DIRECT','RUNNING');
      INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status) VALUES('new-turn','new-run','conv','thread','owner','direct.work','RUNNING')`);
    if(state==='completed'||state==='cancelled')f.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(state==='completed'?'DONE':'CANCELLED','parent');
    expect((await f.command('recovery.status')).data?.interruptedTasks).not.toContainEqual({taskId:'parent'});
  });

  it('does not disclose a task from another human DM in the added recovery list',async()=>{
    const f=fixture();
    f.db.exec("UPDATE conversations SET kind='dm',room_id=NULL WHERE id='conv'; INSERT INTO dm_participants(conversation_id,project_id,principal_type,principal_id) VALUES('conv','p','human','other-human')");
    expect((await f.command('recovery.status')).data?.interruptedTasks).toEqual([]);
  });
});

describe('R169 deliberate continuation after a consumed, never-started dispatch',()=>{
  it('supports the existing run-details action when it binds the exact interrupted run and current task versions',async()=>{
    const f=fixture();
    expect(await f.command('task.redispatch',{...f.binding,expectedRunStatus:'INTERRUPTED'}))
      .toMatchObject({ok:true,data:{enqueued:true,dispatchKey:expect.stringMatching(/^task:parent:redispatch:unstarted_/u)}});
  });
  it('creates a new intent once, preserves the old row and source history, and executes through the formal worker',async()=>{
    const f=fixture(),old=f.db.prepare('SELECT * FROM outbox WHERE dispatch_key=?').get(f.key),commandId=randomUUID();
    const result=await f.command('task.continue',f.binding,commandId);
    expect(result).toMatchObject({ok:true,data:{enqueued:true,dispatchKey:expect.stringMatching(/^task:parent:redispatch:unstarted_/u)}});
    expect(f.db.prepare('SELECT * FROM outbox WHERE dispatch_key=?').get(f.key)).toEqual(old);
    expect(f.db.prepare("SELECT status FROM workflow_runs WHERE id='parent-current'").get()).toEqual({status:'INTERRUPTED'});
    expect((await f.command('task.continue',f.binding,commandId))).toMatchObject({ok:true,replayed:true,data:result.data});
    expect((await f.command('task.continue',f.binding))).toMatchObject({ok:false,error:{code:'IDEMPOTENCY_CONFLICT'}});
    expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get()).toEqual({n:1});
    expect(readTaskExecutionStatus(f.db,'parent')?.phase).toBe('QUEUED');
    expect((await f.command('recovery.status')).data?.interruptedTasks).toEqual([]);
    const adapter=new FakeRuntimeAdapter({sessionStoreDir:join(f.root,'sessions'),turnScriptSequencer:()=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({
      schemaVersion:'task-complete-v1',resultKey:'fixture',answer:'原任务已继续',responseKind:'conversation',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],
    })}}]});
    try{
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r169-worker',appDataDir:f.root});
      expect(await worker.runOnce()).toBe(true);
      expect(adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns WHERE dispatch_key=?').get(result.data!.dispatchKey)).toEqual({n:1});
      expect(f.db.prepare("SELECT status FROM workflow_runs WHERE id='parent-current'").get()).toEqual({status:'INTERRUPTED'});
      expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{await adapter.closeAllSessions();}
  });

  it.each(['missing-binding','stale-revision','stale-stop','ordinary-redispatch','turn','turn-without-row-link','coordination-run','missing-audit'] as const)
    ('does not use the unstarted exception for %s',async scenario=>{
      const f=fixture();
      if(scenario==='turn'||scenario==='turn-without-row-link'){
        f.db.prepare(`INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,dispatch_key)
          VALUES('already-executed','parent-current','conv','thread','owner','direct.work','SUCCEEDED',?)`).run(f.key);
        if(scenario==='turn')f.db.prepare("UPDATE outbox SET turn_id='already-executed' WHERE dispatch_key=?").run(f.key);
      }
      if(scenario==='coordination-run')f.db.prepare("UPDATE workflow_runs SET dispatch_identity=? WHERE id='parent-current'").run(f.key);
      if(scenario==='missing-audit')f.db.prepare("DELETE FROM domain_events WHERE kind='task.redispatchEnqueued'").run();
      const params:Record<string,unknown>={...f.binding};
      if(scenario==='missing-binding')delete params.expectedTaskRevision;
      if(scenario==='stale-revision')params.expectedTaskRevision=9;
      if(scenario==='stale-stop')params.expectedStopGeneration=1;
      const before=snapshot(f);
      expect(await f.command(scenario==='ordinary-redispatch'?'task.redispatch':'task.continue',params)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
      expect(snapshot(f)).toEqual(before);
    });
});

