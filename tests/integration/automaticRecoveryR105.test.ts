import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {pendingAutomaticRecovery,pumpAutomaticRecoveries} from '../../src/daemon/automaticRecovery.ts';
import {applyRecovery} from '../../src/daemon/stopFlow.ts';
import {registerTurnProcess} from '../../src/daemon/processRegistry.ts';
import {DispatchAdmission} from '../../src/daemon/admission.ts';
import {seedExplicitRecipientCoordination} from '../../src/daemon/coordination.ts';

afterEach(()=>vi.unstubAllEnvs());
const complete=(extra:Record<string,unknown>={}):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'work',answer:'已完成核对',changeSummary:'已完成核对',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],handoffs:[],coordinationPlan:null,...extra})}}];
const failure=(message='503 upstream temporarily unavailable',code='PROVIDER_ERROR'):FakeTurnScript=>[{kind:'event',event:{kind:'turn.failed',code,message,retryable:false}}];
async function fixture(structured=true){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r105-')),project=join(dir,'project'),file=join(dir,'state.sqlite');mkdirSync(project);
  let db=openDatabase(file),now=100000,script:FakeTurnScript=complete();
  const adapter=new FakeRuntimeAdapter({structuredFinal:structured,turnScriptSequencer:()=>script});
  let admission=new DispatchAdmission();
  const workerFor=()=>new DispatchWorker({db,adapter,admission,leaseOwner:'r105',appDataDir:dir,automaticRecovery:true,clock:()=>now,turnDeadlineMs:0});
  let worker=workerFor();
  async function cmd<T>(method:string,params:unknown):Promise<T>{const result=await dispatchDaemonCommand({db,localUserId:'u',appDataDir:dir,interruptTurn:id=>worker.interruptTurn(id)},{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error:unknown};if(!result.ok)throw Error(JSON.stringify(result.error));return result.data;}
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:{id:string;conversationId:string}[]}>('room.list',{projectId})).items[0]!;
  const a=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'主持'})).memberId,b=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'复核'})).memberId;
  for(const memberId of [a,b])await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
  const revision=(db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision:number}).revision;
  await cmd('room.update',{roomId:room.id,expectedRevision:revision,coordinatorMemberId:a});
  const send=async(both=false,direct=false)=>{
    const body='核对需求，保留成果并交给同伴复核';
    const sent=await cmd<{taskId:string;threadId:string;messageId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body,intent:'default',mentions:both?[a,b].map(memberId=>({kind:'member',memberId})):direct?[{kind:'member',memberId:a}]:[]});
    // Recovery cases exercise persisted pre-R109 queues, independently of new planning.
    if(both){db.prepare("UPDATE outbox SET status='done' WHERE dispatch_key=? AND status='pending'").run(`task:${sent.taskId}:initial`);seedExplicitRecipientCoordination(db,sent.taskId,sent.messageId,body,[a,b]);}
    if(direct)db.prepare('DELETE FROM coordination_scopes WHERE task_id=?').run(sent.taskId);
    return sent;
  };
  const run=async(value:FakeTurnScript=complete())=>{script=value;return worker.runOnce();};
  const advance=(ms:number)=>{now+=ms;};
  const count=(table:string,where='')=>(db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get() as {n:number}).n;
  const state=(id:string)=>db.prepare('SELECT status,current_delivery_id FROM tasks WHERE id=?').get(id);
  const restart=()=>{db.close();db=openDatabase(file);applyRecovery(db,now);admission=new DispatchAdmission();worker=workerFor();};
  const cleanup=async()=>{await adapter.closeAllSessions();db.close();rmSync(dir,{recursive:true,force:true});};
  return {get db(){return db;},get worker(){return worker;},get admission(){return admission;},dir,project,a,b,projectId,room,adapter,cmd,send,run,advance,count,state,restart,cleanup};
}

describe('R105 formal bounded recovery and completed-work handoffs',()=>{
  it('can remove an originally invalid reply target during repair instead of requiring it forever',async()=>{
    const f=await fixture();try{const c=(await f.cmd<{memberId:string}>('member.create',{projectId:f.projectId,displayName:'非来源同伴'})).memberId;const root=await f.send();await f.run(complete({handoffs:[{toMemberId:f.b,purpose:'review',message:'复核结果'}]}));await f.run(complete({handoffs:[{toMemberId:c,purpose:'reply',message:'错误回复给非来源成员'}]}));const child=f.db.prepare('SELECT child_task_id FROM coordination_steps').get() as {child_task_id:string};expect(pendingAutomaticRecovery(f.db,child.child_task_id)?.kind).toBe('output');f.advance(2000);await f.run(complete({handoffs:[]}));await f.run();expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.adapter.startTurnLog).toHaveLength(4);}finally{await f.cleanup();}
  });
  it('freezes a recovered source with released historical UNKNOWN into a still-unstarted original recipient',async()=>{
    const f=await fixture();try{
      const root=await f.send(true);await f.run(failure('connection interrupted','INTERRUPTED'));
      const turn=f.db.prepare("SELECT a.id,a.run_id,a.member_id,r.task_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE a.status='UNKNOWN'").get() as {id:string;run_id:string;member_id:string;task_id:string};
      const identity={turnId:turn.id,runId:turn.run_id,memberId:turn.member_id,adapterKind:'fake',pid:null,startedAtMs:null};
      registerTurnProcess(f.db,{...identity,processModel:'unknown',identitySource:'pre-launch'});await f.cmd('recovery.reconcile',{turnId:turn.id,verdict:'executed',note:'合成已执行、初始载体身份缺失'});registerTurnProcess(f.db,{...identity,processModel:'none',identitySource:'none'});await f.cmd('recovery.releaseProtection',{turnId:turn.id,note:'合成inline无OS载体程序事实'});
      f.restart();await f.cmd('dispatch.resume',{confirm:true});
      expect(f.admission.tryAcquire('synthetic-other-b',{memberId:f.b,projectId:f.projectId,providerKey:'fake',writeRootKey:null}).granted).toBe(true);
      await f.cmd('task.redispatch',{taskId:turn.task_id});await f.run(); // B remains unstarted due to member admission.
      await f.run(complete({handoffs:[{toMemberId:f.b,purpose:'review',message:'只读复核本轮恢复后接受的结果'}]}));
      f.admission.release('synthetic-other-b');await f.run();await f.run();
      expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.adapter.startTurnLog).toHaveLength(4);
      expect(f.count('domain_events',"WHERE kind='member.messageAccepted' AND json_extract(payload_json,'$.mergedIntoInitialStep') IS NOT NULL")).toBe(1);
      expect(f.db.prepare('SELECT status,protection_state FROM agent_turns WHERE id=?').get(turn.id)).toEqual({status:'UNKNOWN',protection_state:'released'});
    }finally{await f.cleanup();}
  });
  it.each([false,true])('preserves valid pending review through a write-result repair (kept=%s)',async(kept)=>{
    const f=await fixture();try{const root=await f.send(),handoff={toMemberId:f.b,purpose:'review',message:'只读核对当前result.md，不重复实施'};await f.run([{kind:'writeFile',path:'result.md',content:'已有业务成果'},...complete({files:['result.md'],handoffs:[handoff],unexpected:true})]);f.advance(2000);await f.run(complete({files:['result.md'],handoffs:kept?[handoff]:[]}));if(kept){expect(f.state(root.taskId)).toMatchObject({status:'ACTIVE'});await f.run();await f.run();expect(f.state(root.taskId)).toMatchObject({status:'DONE'});}else{expect(f.state(root.taskId)).toMatchObject({status:'BLOCKED'});expect(f.count('coordination_steps')).toBe(0);expect(f.count('domain_events',"WHERE kind='turn.outputInvalid' AND json_extract(payload_json,'$.issues[0]') LIKE '%遗漏%'")).toBe(1);}expect(f.adapter.writtenFiles).toHaveLength(1);}finally{await f.cleanup();}
  });
  it('keeps an unverified UNKNOWN blocked, then integrates after formal reconciliation, protection release and explicit child continuation',async()=>{
    const f=await fixture();try{
      const root=await f.send(true);await f.run();await f.run(failure('connection interrupted','INTERRUPTED'));await f.worker.runOnce();
      const turn=f.db.prepare("SELECT a.id,a.run_id,a.member_id,r.task_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE a.status='UNKNOWN'").get() as {id:string;run_id:string;member_id:string;task_id:string};
      await expect(f.cmd('task.redispatch',{taskId:turn.task_id})).rejects.toThrow();
      // Protocol fixture: initially missing carrier identity; later the inline
      // adapter confirms its real no-OS-process model through the registry API.
      const identity={turnId:turn.id,runId:turn.run_id,memberId:turn.member_id,adapterKind:'fake',pid:null,startedAtMs:null};
      registerTurnProcess(f.db,{...identity,processModel:'unknown',identitySource:'pre-launch'});
      await f.cmd('recovery.reconcile',{turnId:turn.id,verdict:'executed',note:'合成执行已发生，载体身份尚待补齐'});
      expect(f.db.prepare('SELECT status,budget_mark FROM agent_turns WHERE id=?').get(turn.id)).toEqual({status:'UNKNOWN',budget_mark:'settled'});
      await expect(f.cmd('task.redispatch',{taskId:turn.task_id})).rejects.toThrow();
      registerTurnProcess(f.db,{...identity,processModel:'none',identitySource:'none'});
      await f.cmd('recovery.releaseProtection',{turnId:turn.id,note:'合成内联适配器程序证据：无OS载体'});
      expect(f.db.prepare('SELECT status,protection_state FROM agent_turns WHERE id=?').get(turn.id)).toEqual({status:'UNKNOWN',protection_state:'released'});
      f.restart();await f.cmd('task.redispatch',{taskId:turn.task_id});await f.run();await f.run();
      expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.state(turn.task_id)).toMatchObject({status:'DONE'});
      expect(f.adapter.startTurnLog).toHaveLength(4);expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(turn.id)).toEqual({status:'UNKNOWN'});
    }finally{await f.cleanup();}
  });
  it('explicitly closes obsolete failed child tasks against a later accepted parent delivery without rewriting the failed execution',async()=>{
    const f=await fixture();try{const root=await f.send(true);await f.run();await f.run(failure('permission denied'));await f.worker.runOnce();const failed=f.db.prepare("SELECT r.task_id,a.id turnId FROM workflow_runs r JOIN agent_turns a ON a.run_id=r.id WHERE a.status='FAILED'").get() as {task_id:string;turnId:string};await f.cmd('task.redispatch',{taskId:root.taskId});await f.run();const current=f.db.prepare('SELECT revision,current_delivery_id FROM tasks WHERE id=?').get(root.taskId) as {revision:number;current_delivery_id:string};const source=f.db.prepare('SELECT run_id FROM task_deliveries WHERE id=?').get(current.current_delivery_id) as {run_id:string};const settled=await f.cmd<{closed:string[]}>('task.settleSupersededSteps',{taskId:root.taskId,sourceRunId:source.run_id,expectedTaskRevision:current.revision});expect(settled.closed).toEqual([failed.task_id]);expect(f.state(failed.task_id)).toMatchObject({status:'CANCELLED'});expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(failed.turnId)).toEqual({status:'FAILED'});expect(f.count('domain_events',"WHERE kind='coordination.stepSuperseded'")).toBe(1);}finally{await f.cleanup();}
  });
  it('persists a bounded Retry-After hint and never retries earlier than the service requested',async()=>{
    const f=await fixture();try{const root=await f.send();await f.run(failure('429 rate limit; Retry-After: 45 seconds'));expect(pendingAutomaticRecovery(f.db,root.taskId)?.nextAttemptAt).toBe(145000);f.advance(44000);f.restart();expect(await f.run()).toBe(false);f.advance(1000);await f.run();expect(f.state(root.taskId)).toMatchObject({status:'DONE'});}finally{await f.cleanup();}
  });
  it('stops instead of shortening an excessive server Retry-After hint',async()=>{
    const f=await fixture();try{await f.send();await f.run(failure('429 rate limit; Retry-After: 3600 seconds'));f.advance(300000);expect(await f.run()).toBe(false);expect(f.adapter.startTurnLog).toHaveLength(1);expect(f.count('domain_events',"WHERE kind='recovery.stopped'")).toBe(1);}finally{await f.cleanup();}
  });
  it('rebinds only the exact failed thread request and settles it as succeeded after automatic recovery',async()=>{
    const f=await fixture();try{const root=await f.send(false,true);await f.run(complete({responseKind:'conversation',changeSummary:''}));const reply=await f.cmd<{messageId:string}>('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId},body:'请补充核对结果',intent:'default',mentions:[]});await f.run(failure());expect(f.db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(reply.messageId)).toEqual({status:'failed'});f.advance(2000);await f.run(complete({responseKind:'conversation',changeSummary:''}));expect(f.db.prepare('SELECT status,error_message FROM thread_reply_requests WHERE message_id=?').get(reply.messageId)).toEqual({status:'succeeded',error_message:null});expect(f.adapter.startTurnLog).toHaveLength(3);}finally{await f.cleanup();}
  });
  it('rebinds the exact blocked peer handoff after recovery and clears its old failure reason',async()=>{
    const f=await fixture();try{const root=await f.send();await f.run(complete({handoffs:[{toMemberId:f.b,purpose:'review',message:'独立复核结果'}]}));await f.run(failure());expect(f.db.prepare('SELECT status FROM coordination_messages').get()).toEqual({status:'blocked'});f.advance(2000);await f.run();await f.run();expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.db.prepare('SELECT status,error_message FROM coordination_messages').get()).toEqual({status:'completed',error_message:null});}finally{await f.cleanup();}
  });
  it.each(['direct-waiting','direct-queued','dm-waiting','dm-queued'])('immediately settles a stop during %s without an orphan STOPPING run',async(kind)=>{
    const f=await fixture();try{
      let taskId:string;
      if(kind.startsWith('dm')){const dm=await f.cmd<{conversationId:string}>('conversation.create',{projectId:f.projectId,peerMemberId:f.a});await f.cmd('message.submit',{target:{kind:'dm',projectId:f.projectId,conversationId:dm.conversationId},body:'请核对',intent:'default',mentions:[]});taskId=(f.db.prepare('SELECT id FROM tasks ORDER BY rowid DESC LIMIT 1').get() as {id:string}).id;}
      else taskId=(await f.send(false,true)).taskId;
      await f.run(failure());const run=f.db.prepare('SELECT id,mode FROM workflow_runs WHERE task_id=?').get(taskId) as {id:string;mode:string};expect(run.mode).toBe('DIRECT');
      if(kind.endsWith('queued')){f.advance(2000);pumpAutomaticRecoveries(f.db,102000);}
      await f.cmd('task.stop',{taskId,targetRunId:run.id,expectedStopGeneration:0});
      expect(f.state(taskId)).toMatchObject({status:'CANCELLED'});expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(run.id)).toEqual({status:'CANCELLED'});
      f.advance(60000);f.restart();expect(await f.run()).toBe(false);expect(f.adapter.startTurnLog).toHaveLength(1);expect(f.count('workflow_runs',"WHERE status IN ('STOPPING','INTERRUPTED')")).toBe(0);
    }finally{await f.cleanup();}
  });
  it('does not replay a successful completed-only tool whose started event was missing',async()=>{
    const f=await fixture();try{const root=await f.send();await f.run([{kind:'event',event:{kind:'tool.completed',toolCallId:'possibly-executed-remote-operation',outcome:'success'}},...failure()]);f.advance(60000);expect(await f.run()).toBe(false);expect(pendingAutomaticRecovery(f.db,root.taskId)).toBeUndefined();expect(f.adapter.startTurnLog).toHaveLength(1);}finally{await f.cleanup();}
  });
  it('can submit a genuinely empty original result once through the read-only repair contract',async()=>{
    const f=await fixture(false);try{const root=await f.send();await f.run([{kind:'event',event:{kind:'turn.completed',finalText:''}}]);const job=pendingAutomaticRecovery(f.db,root.taskId);expect(job?.kind).toBe('output');f.advance(2000);await f.run(complete({resultKey:`result_${job!.sourceTurnId}`}));expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.adapter.startTurnLog[1]!.text).toContain('不重复执行业务写入');}finally{await f.cleanup();}
  });
  it('restarts a queued but never launched retry through the normal startup recovery gate',async()=>{
    const f=await fixture();try{const root=await f.send();await f.run(failure());f.advance(2000);pumpAutomaticRecoveries(f.db,102000);expect(pendingAutomaticRecovery(f.db,root.taskId)?.state).toBe('queued');f.restart();await f.run();expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.adapter.startTurnLog).toHaveLength(2);}finally{await f.cleanup();}
  });
  it('keeps two failed attempts, persists backoff across restart, succeeds in the same run and releases ownership',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(failure());
      expect(pendingAutomaticRecovery(f.db,root.taskId)).toMatchObject({extraAttempts:1,nextAttemptAt:102000});
      expect(await f.run()).toBe(false);f.advance(1999);f.restart();expect(await f.run()).toBe(false);
      f.advance(1);await f.run(failure('429 rate limit, retry later'));
      expect(pendingAutomaticRecovery(f.db,root.taskId)).toMatchObject({extraAttempts:2,nextAttemptAt:110000});
      expect(f.adapter.startTurnLog).toHaveLength(2);f.restart();f.advance(8000);await f.run();await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(3);expect(f.state(root.taskId)).toMatchObject({status:'DONE'});
      expect(f.count('workflow_runs')).toBe(1);expect(f.count('agent_turns',"WHERE status='FAILED'")).toBe(2);
      expect(f.count('workspace_leases',"WHERE status!='released'")).toBe(0);expect(pendingAutomaticRecovery(f.db,root.taskId)).toBeUndefined();
    }finally{await f.cleanup();}
  });
  it('stops after two extra attempts without resetting the count on restart',async()=>{
    const f=await fixture();try{await f.send();await f.run(failure());f.advance(2000);await f.run(failure());f.advance(8000);await f.run(failure());f.restart();f.advance(60000);expect(await f.run()).toBe(false);expect(f.adapter.startTurnLog).toHaveLength(3);expect(f.count('domain_events',"WHERE kind='recovery.exhausted'")).toBe(1);}finally{await f.cleanup();}
  });
  it.each(['401 authentication failed','insufficient balance','usage quota exceeded','permission denied','user cancelled'])('does not replay %s',async(reason)=>{
    const f=await fixture();try{const root=await f.send();await f.run(failure(reason));f.advance(60000);expect(await f.run()).toBe(false);expect(pendingAutomaticRecovery(f.db,root.taskId)).toBeUndefined();expect(f.adapter.startTurnLog).toHaveLength(1);}finally{await f.cleanup();}
  });
  it('does not replay network failure after silent business file changes',async()=>{
    const f=await fixture();try{const root=await f.send();await f.run([{kind:'writeFile',path:'result.md',content:'业务只执行一次'},...failure()]);f.advance(60000);expect(await f.run()).toBe(false);expect(pendingAutomaticRecovery(f.db,root.taskId)).toBeUndefined();expect(readFileSync(join(f.project,'result.md'),'utf8')).toBe('业务只执行一次');}finally{await f.cleanup();}
  });
  it('only repairs output after a write and binds the original change set without repeating the write',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run([{kind:'writeFile',path:'result.md',content:'业务只执行一次'},...complete({files:['result.md'],unexpected:'invalid'})]);
      expect(pendingAutomaticRecovery(f.db,root.taskId)).toMatchObject({kind:'output'});f.advance(2000);await f.run(complete({files:['result.md']}));await f.worker.runOnce();
      expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT turn_purpose FROM agent_turns ORDER BY rowid DESC LIMIT 1').get()).toEqual({turn_purpose:'format_repair'});expect(f.adapter.startTurnLog[1]!.text).toContain('result.md');
      expect(f.adapter.writtenFiles).toHaveLength(1);
      expect(readFileSync(join(f.project,'result.md'),'utf8')).toBe('业务只执行一次');expect(f.count('task_deliveries')).toBe(1);
      expect(f.count('format_repair_workitems',"WHERE status='consumed'")).toBe(1);
    }finally{await f.cleanup();}
  });
  it('preserves an implementation delivery and starts a separate review without rejecting its file changes',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run([{kind:'writeFile',path:'result.md',content:'v2'},...complete({files:['result.md'],handoffs:[{toMemberId:f.b,purpose:'review',message:'只读核对当前result.md v2，不重复实施'}]})]);
      expect(f.state(root.taskId)).toMatchObject({status:'ACTIVE'});expect(f.count('task_deliveries')).toBe(1);expect(f.count('domain_events',"WHERE kind='turn.outputInvalid'")).toBe(0);
      await f.run();await f.run();expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.adapter.startTurnLog).toHaveLength(3);expect(readFileSync(join(f.project,'result.md'),'utf8')).toBe('v2');
    }finally{await f.cleanup();}
  });
  it('keeps a successful peer and automatically continues the parent after the other peer recovers',async()=>{
    const f=await fixture();try{const root=await f.send(true);await f.run();await f.run(failure());expect(f.state(root.taskId)).toMatchObject({status:'ACTIVE'});expect(await f.run()).toBe(false);f.advance(2000);await f.run();await f.run();expect(f.state(root.taskId)).toMatchObject({status:'DONE'});expect(f.adapter.startTurnLog).toHaveLength(4);expect(f.count('domain_events',"WHERE kind='coordination.blocked'")).toBe(0);}finally{await f.cleanup();}
  });
  it('cancels a durable retry when the user stops, including across restart',async()=>{
    const f=await fixture();try{const root=await f.send();await f.run(failure());const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=?').get(root.taskId) as {id:string};await f.cmd('task.stop',{taskId:root.taskId,targetRunId:run.id,expectedStopGeneration:0});f.advance(60000);f.restart();expect(await f.run()).toBe(false);expect(f.adapter.startTurnLog).toHaveLength(1);expect(f.state(root.taskId)).toMatchObject({status:'CANCELLED'});}finally{await f.cleanup();}
  });
  it('preserves UNKNOWN instead of automatically replaying an unconfirmed interrupt',async()=>{
    const f=await fixture();try{const root=await f.send();await f.run(failure('connection interrupted','INTERRUPTED'));f.advance(60000);f.restart();expect(await f.run()).toBe(false);expect(f.count('agent_turns',"WHERE status='UNKNOWN'")).toBe(1);expect(pendingAutomaticRecovery(f.db,root.taskId)).toBeUndefined();}finally{await f.cleanup();}
  });
});
