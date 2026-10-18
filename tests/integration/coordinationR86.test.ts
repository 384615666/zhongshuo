import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync,writeFileSync,readFileSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker,type DispatchWorkerOptions } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { parseDelibStep } from '../../src/daemon/deliberationRunner.ts';
import { listRunArtifacts } from '../../src/persistence/stores/deliberation.ts';
import type {TaskDetailsResult} from '../../src/contracts/taskDetails.ts';
import {reworkPendingOf} from '../../src/persistence/stores/dm.ts';

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
  return {db,dir,worker,adapter,cmd,raw,send,run,plan,a,b,room,projectId};
}

async function completeDeliberationRound(f:Awaited<ReturnType<typeof fixture>>) {
  await f.worker.runOnce(); // formal queued root -> prepare, no model
  for(let count=0;count<30;count++){
    const next=f.db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key:string}|undefined;
    if(!next)break;const step=parseDelibStep(next.dispatch_key);expect(step).not.toBeNull();
    let value:unknown;
    if(step!.stage==='IND')value={schemaVersion:'analysis-draft-v1',summary:`${step!.memberId}独立方案`,claims:[{claimId:'c1',statement:'方案甲可行',kind:'proposal',evidenceIds:[]}],recommendations:['核对约束'],openQuestions:[]};
    else if(step!.stage==='CR'){
      const draft=listRunArtifacts(f.db,step!.runId,'analysis_draft').find(a=>a.author_id!==step!.memberId)!;
      value={schemaVersion:'cross-review-v1',reviews:[{targetArtifactId:draft.id,targetRevision:1,targetClaimId:'c1',stance:'agree',reason:'已读取他方方案，约束一致',evidenceIds:[]}]};
    }else if(step!.stage==='SYN')value={schemaVersion:'synthesis-v1',summary:'两位成员汇总的自然结论',claims:[{statement:'按方案甲推进',sourceRefs:['c1']}],disputedClaims:[],recommendations:['下一步核实工程条件']};
    else if(step!.stage==='RAT')value={schemaVersion:'ratify-v1',responses:[{claimId:'clm_1',stance:'confirm'}]};
    else throw Error(`非预期阶段 ${step!.stage}`);
    await f.run([{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify(value)}}]);
  }
}

describe('R86 formal command → persistent coordination → DIRECT child worker',()=>{
  it('AUTO rework stays executing after its planning outbox settles and while child steps run',async()=>{
    const f=await fixture();try{
      const revision=(f.db.prepare('SELECT revision FROM projects WHERE id=?').get(f.projectId) as {revision:number}).revision;
      await f.cmd('project.reviewPolicy.set',{projectId:f.projectId,taskReviewEnabled:true,expectedRevision:revision});
      const root=await f.send();await f.run(output('计划',f.plan));await f.run(output('分析'));await f.run(output('评审'));await f.run(output('第一版'));
      const first=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=?').get(root.taskId) as {id:string;revision:number;manifest_hash:string;run_id:string};
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,decision:'changes_requested',note:'补充边界'});
      expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:false,deliveryId:first.id});
      const request={taskId:root.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,sourceRunId:first.run_id};
      await f.cmd('task.executeRework',request);expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:true});
      await f.run(output('新版计划',f.plan));
      expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key GLOB ? AND status!='done'").get(`task:${root.taskId}:redispatch*`)).toEqual({n:0});
      expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:true,deliveryId:first.id});
      const detail=await f.cmd<{reworkPending:{queued:boolean}}>('task.get',{taskId:root.taskId});expect(detail.reworkPending.queued).toBe(true);
      expect((await f.raw('task.executeRework',request)).ok).toBe(false);
      await f.run(output('新版分析'));expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:true});
      await f.run(output('新版评审'));await f.run(output('第二版'));expect(reworkPendingOf(f.db,root.taskId)).toBeNull();
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:2});
      const second=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(root.taskId) as typeof first;
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:second.id,deliveryRevision:2,manifestHash:second.manifest_hash,decision:'changes_requested',note:'第三版另行决定'});
      const other=await f.send();await f.run(output('另一任务计划',f.plan));
      expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:false,deliveryId:second.id});
      const otherRun=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(other.taskId) as {run_id:string};
      await f.cmd('task.stop',{taskId:other.taskId,targetRunId:otherRun.run_id,expectedStopGeneration:0});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('a peer opening session cannot launch after another detached member becomes UNKNOWN',async()=>{
    const f=await fixture(true,{detachedTurnConsumption:true,turnDeadlineMs:150,interruptGraceMs:10});let release=()=>{};
    try{
      const root=await f.send([f.a,f.b]);await f.worker.runOnce();
      await f.run([{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:2000}]);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'ACTIVE'});
      let entered!:()=>void;const openEntered=new Promise<void>(resolve=>{entered=resolve;});const barrier=new Promise<void>(resolve=>{release=resolve;});
      const original=f.adapter.openSession.bind(f.adapter);f.adapter.openSession=async input=>{entered();await barrier;return original(input);};
      const pending=f.run([{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'analysis-draft-v1',summary:'不可启动',claims:[{claimId:'c1',statement:'不可启动',kind:'proposal',evidenceIds:[]}],recommendations:[],openQuestions:[]})}}]);
      await openEntered;
      const deadline=Date.now()+3000;while(!f.db.prepare("SELECT 1 FROM agent_turns WHERE status='UNKNOWN'").get()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'").get()).toEqual({n:1});
      release();await pending;expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='CANCELLED' AND budget_mark='refunded'").get()).toEqual({n:1});
      const run=f.db.prepare('SELECT status,budget_json FROM workflow_runs').get() as {status:string;budget_json:string};expect(run.status).toBe('INTERRUPTED');
      expect(JSON.parse(run.budget_json)).toMatchObject({usedTurns:0,inFlightReservedTurns:1});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
    }finally{release();await f.adapter.closeAllSessions();await f.worker.awaitSettlement(1000);f.db.close();}
  });
  it('stopping the prepared second deliberation run leaves old success and cancels only this run',async()=>{
    const f=await fixture(true);try{
      const revision=(f.db.prepare('SELECT revision FROM projects WHERE id=?').get(f.projectId) as {revision:number}).revision;
      await f.cmd('project.reviewPolicy.set',{projectId:f.projectId,taskReviewEnabled:true,expectedRevision:revision});
      const root=await f.send([f.a,f.b]);await completeDeliberationRound(f);
      const first=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=?').get(root.taskId) as {id:string;revision:number;manifest_hash:string;run_id:string};
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,decision:'changes_requested',note:'请补充边界'});
      await f.cmd('task.executeRework',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,sourceRunId:first.run_id});
      await f.worker.runOnce();const next=f.db.prepare('SELECT id FROM workflow_runs ORDER BY rowid DESC LIMIT 1').get() as {id:string};
      const before=f.adapter.startTurnLog.length;
      await f.cmd('task.stop',{taskId:root.taskId,targetRunId:next.id,expectedStopGeneration:0});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(next.id)).toEqual({status:'CANCELLED'});
      await f.worker.drain();
      expect(f.adapter.startTurnLog).toHaveLength(before);
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(first.run_id)).toEqual({status:'SUCCEEDED'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(next.id)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare('SELECT status,current_delivery_id FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'CANCELLED',current_delivery_id:first.id});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('does not continue deliberation or falsely publish when a member result becomes UNKNOWN',async()=>{
    const f=await fixture(true,{turnDeadlineMs:20,interruptGraceMs:10});try{
      const root=await f.send([f.a,f.b]);await f.worker.runOnce();
      await f.run([{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:1000}]);
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
      expect((await f.raw('task.redispatch',{taskId:root.taskId})).ok).toBe(false);
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('zero parent budget starts no coordinator and no child',async()=>{
    const f=await fixture(false,{coordinationMaxCalls:0});try{
      const root=await f.send();await f.run(output('不应启动',f.plan));
      expect(f.adapter.startTurnLog).toHaveLength(0);expect(f.db.prepare('SELECT count(*) n FROM workflow_runs').get()).toEqual({n:0});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
    }finally{f.db.close();}
  });
  it('an UNKNOWN child blocks parent success and fresh parent redispatch without releasing its original identity',async()=>{
    const f=await fixture(false,{turnDeadlineMs:20,interruptGraceMs:10});try{
      const root=await f.send();await f.run(output('计划',f.plan));
      await f.run([{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:1000}]);await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
      expect((await f.raw('task.redispatch',{taskId:root.taskId})).ok).toBe(false);
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'").get()).toEqual({n:1});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('sends exact formal image bytes into each independent read-only deliberation input, zero inference',async()=>{
    const f=await fixture(true);try{
      // Saved program reference is a synthetic file; FakeRuntimeAdapter is the sole executor.
      const executable=join(f.dir,'fixture-codex.exe');writeFileSync(executable,'engineering reference, never spawned');
      for(const memberId of [f.a,f.b])await f.cmd('member.setRuntime',{memberId,kind:'codex',model:'gpt-6.1-sol',permissionMode:'plan',executable});
      const raw=readFileSync(join(process.cwd(),'scripts','dev25-dual','samples','preview-r52-样例.png'));
      const upload=await f.cmd<{attachmentId:string}>('attachment.uploadImage',{conversationId:f.room.conversationId,filename:'工程图片.png',contentBase64:raw.toString('base64')});
      const turns=vi.spyOn(f.adapter,'startTurn');
      await f.cmd('message.submit',{target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},body:'',intent:'default',collaboration:'deliberate',mentions:[f.a,f.b].map(memberId=>({kind:'member',memberId})),attachmentRefs:[upload.attachmentId]});
      await f.worker.runOnce();
      const done:FakeTurnScript=[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'analysis-draft-v1',summary:'工程协议输入验证',claims:[{claimId:'c1',statement:'夹具不作识图结论',kind:'proposal',evidenceIds:[]}],recommendations:[],openQuestions:[]})}}];
      await f.run(done);await f.run(done);
      expect(turns.mock.calls).toHaveLength(2);
      for(const [,request] of turns.mock.calls){expect(request.images).toHaveLength(1);expect(Buffer.from(request.images![0]!.dataBase64,'base64')).toEqual(raw);expect(request.policyId).toBe('policy-analyze');expect(request.outputSchema).toBeTruthy();}
    }finally{f.db.close();}
  });
  it('formal selected-member deliberation keeps read-only schemas, readable reports and version-bound rework',async()=>{
    const f=await fixture(true);try{
      const revision=(f.db.prepare('SELECT revision FROM projects WHERE id=?').get(f.projectId) as {revision:number}).revision;
      await f.cmd('project.reviewPolicy.set',{projectId:f.projectId,taskReviewEnabled:true,expectedRevision:revision});
      const sessions=vi.spyOn(f.adapter,'openSession'),turns=vi.spyOn(f.adapter,'startTurn');
      const root=await f.send([f.a,f.b]);
      const completeRound=()=>completeDeliberationRound(f);
      await completeRound();
      type Delivery={id:string;revision:number;manifest_hash:string;run_id:string};
      const first=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=?').get(root.taskId) as Delivery;
      expect(first.revision).toBe(1);expect(first.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(f.db.prepare('SELECT count(*) n FROM messages WHERE task_id=? AND author_type=\'agent\'').get(root.taskId)).toEqual({n:1});
      const message=f.db.prepare("SELECT body_json FROM messages WHERE task_id=? AND author_type='agent'").get(root.taskId) as {body_json:string};
      expect(JSON.parse(message.body_json).text).toContain('两位成员汇总的自然结论');expect(JSON.parse(message.body_json).text).not.toContain('schemaVersion');
      const calls=f.adapter.startTurnLog.length;
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:1,manifestHash:first.manifest_hash,decision:'changes_requested',note:'请补充实施约束'});
      expect(f.adapter.startTurnLog).toHaveLength(calls);
      await f.cmd('task.executeRework',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:1,manifestHash:first.manifest_hash,sourceRunId:first.run_id});
      await completeRound();
      const second=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(root.taskId) as Delivery;
      expect(second.revision,JSON.stringify({runs:f.db.prepare('SELECT id,status,stage FROM workflow_runs').all(),outbox:f.db.prepare("SELECT dispatch_key,status FROM outbox WHERE status!='done'").all(),events:f.db.prepare('SELECT kind,payload_json FROM domain_events ORDER BY seq DESC LIMIT 4').all()})).toBe(2);expect(second.manifest_hash).not.toBe(first.manifest_hash);
      expect(f.adapter.startTurnLog[calls]!.text).toContain('请补充实施约束');
      for(const call of sessions.mock.calls)expect(call[0].writeAccess?.modificationAuthorized).toBe(false);
      for(const call of turns.mock.calls)expect(call[1].outputSchema).toBeTruthy();
      const recorded=f.db.prepare('SELECT s.capabilities_json FROM runtime_sessions s JOIN agent_turns a ON a.session_id=s.id').all() as {capabilities_json:string}[];
      expect(recorded).toHaveLength(f.adapter.startTurnLog.length);for(const row of recorded)expect(JSON.parse(row.capabilities_json)).toMatchObject({effectivePolicy:'policy-analyze',fullAccess:false,runtime:{kind:'fake'}});
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:second.id,deliveryRevision:2,manifestHash:second.manifest_hash,decision:'accept'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
    }finally{f.db.close();}
  });
  it('publishes a readable planning message before any child finishes, retaining the original protocol in formal history',async()=>{
    const f=await fixture();try{
      const root=await f.send(),answer='已排好分工，正在逐步执行。';await f.run(output(answer,f.plan));
      expect(f.adapter.startTurnLog).toHaveLength(1);expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
      const row=f.db.prepare("SELECT id,body_json FROM messages WHERE thread_id=? AND author_type='agent' ORDER BY conversation_seq DESC LIMIT 1").get(root.threadId) as {id:string;body_json:string},saved=JSON.parse(row.body_json) as {text:string;runtimeControlResult:string};
      expect(saved.text).toBe(answer);expect(JSON.parse(saved.runtimeControlResult).coordinationPlan).toEqual(f.plan);
      const history=await f.cmd<{items:Array<{id:string;body:{text:string;runtimeControlResult:string}}>}>('thread.history',{threadId:root.threadId});expect(history.items.find(m=>m.id===row.id)?.body).toEqual(saved);
      const pool=await f.cmd<{items:Array<{threadId:string;taskId:string;replyCount:number}>}>('room.pool',{roomId:f.room.id});expect(pool.items.find(m=>m.threadId===root.threadId)).toMatchObject({taskId:root.taskId,replyCount:1});
      expect(f.db.prepare('SELECT body_json FROM messages WHERE id=?').get(row.id)).toEqual({body_json:row.body_json});
    }finally{f.db.close();}
  });
  it('creates genuine independent children, freezes upstream versions, integrates and reopens',async()=>{
    const f=await fixture();
    try{
      const root=await f.send();await f.run(output('准备分工',f.plan));
      expect((f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId) as {status:string}).status).toBe('ACTIVE');
      expect((f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId) as {n:number}).n).toBe(2);
      const child=f.db.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY rowid LIMIT 1').get(root.taskId) as {id:string};
      const located=await f.cmd<{taskId:string;parentTaskId:string;threadId:string}>('deepLink.resolve',{hash:`#task=${child.id}`});
      expect(located).toMatchObject({taskId:child.id,parentTaskId:root.taskId,threadId:root.threadId});
      const board=await f.cmd<{groups:Array<{rooms:Array<{cards:Array<{taskId:string}>}>}>}>('board.view',{scope:'project',projectId:f.projectId});
      expect(board.groups.flatMap(g=>g.rooms.flatMap(r=>r.cards)).map(c=>c.taskId)).toEqual([root.taskId]);
      await f.run(output('上游独立分析：采用方案甲'));
      await f.run(output('独立复核已读取方案甲'));
      expect(f.adapter.startTurnLog[2]!.text).toContain('上游独立分析：采用方案甲');
      expect(f.adapter.startTurnLog[2]!.text).toContain('manifest_hash');
      await f.run(output('综合两位成员结论'));
      expect(f.adapter.startTurnLog).toHaveLength(4);
      expect((f.db.prepare('SELECT state FROM coordination_runs').get() as {state:string}).state).toBe('completed');
      expect((f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId) as {n:number}).n).toBe(1);
      const saved=f.db.prepare('SELECT child_task_id,handoff_json FROM coordination_steps ORDER BY step_key').all();
      f.db.close();const reopened=openDatabase(join(f.dir,'state.sqlite'));
      expect(reopened.prepare('SELECT child_task_id,handoff_json FROM coordination_steps ORDER BY step_key').all()).toEqual(saved);reopened.close();
    }finally{if(f.db.open)f.db.close();}
  });
  it('does not duplicate a planned downstream child when the upstream step also emits a handoff',async()=>{
    const f=await fixture();
    try{
      const root=await f.send();
      await f.run(output('准备分工',f.plan));
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:2});
      await f.run(output('分析完成',undefined,{
        responseKind:'work',
        handoffs:[{toMemberId:f.b,message:'请复核上游分析',purpose:'review'}],
      }));
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:2});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_messages').get()).toEqual({n:0});
      expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE kind='member.messageIgnoredRedundantPlan'").get()).toEqual({n:1});
      await f.run(output('评审完成'));
      await f.run(output('综合完成'));
      expect(f.db.prepare('SELECT count(*) n FROM coordination_steps').get()).toEqual({n:2});
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'completed'});
    }finally{f.db.close();}
  });
  it('rejects a model-invented member without creating children or dispatching it',async()=>{
    const f=await fixture();try{
      const other=join(f.dir,'other-project');mkdirSync(other);
      const foreignProject=(await f.cmd<{project:{id:string}}>('project.open',{path:other})).project.id;
      const foreignMember=(await f.cmd<{memberId:string}>('member.create',{projectId:foreignProject,displayName:'同名成员'})).memberId;
      const root=await f.send();await f.run(output('计划',{...f.plan,steps:[{...f.plan.steps[0],memberId:foreignMember}]}));
      expect((f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId) as {n:number}).n).toBe(0);
      expect((f.db.prepare('SELECT state FROM coordination_runs').get() as {state:string}).state).toBe('blocked');
      expect(f.adapter.startTurnLog).toHaveLength(1);
    }finally{f.db.close();}
  });
  it('keeps ordinary no-mention questions as one natural coordinator response',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('你好！',undefined,{coordinationPlan:null}));
      expect((f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId) as {status:string}).status).toBe('DONE');
      expect((f.db.prepare('SELECT count(*) n FROM coordination_steps').get() as {n:number}).n).toBe(0);
      const first=f.db.prepare("SELECT body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY conversation_seq DESC LIMIT 1").get(root.taskId) as {body_json:string};expect(JSON.parse(first.body_json).text).toBe('你好！');expect(JSON.parse(JSON.parse(first.body_json).runtimeControlResult).coordinationPlan).toBeNull();expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
      expect(f.adapter.startTurnLog).toHaveLength(1);
      await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId},body:'刚才说了什么？',intent:'default',mentions:[]});
      await f.run(output('刚才向你问好了。'));expect(f.adapter.startTurnLog).toHaveLength(2);
      expect((f.db.prepare('SELECT count(*) n FROM tasks').get() as {n:number}).n).toBeGreaterThanOrEqual(1);
    }finally{f.db.close();}
  });
  it('parent stop before the next child dispatch cancels queued work without new calls',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',f.plan));
      const run=f.db.prepare('SELECT run_id FROM coordination_runs').get() as {run_id:string};
      await f.cmd('task.stop',{taskId:root.taskId,targetRunId:run.run_id,expectedStopGeneration:0});
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare("SELECT count(*) n FROM tasks WHERE parent_task_id=? AND status!='CANCELLED'").get(root.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('configuration changes after planning prevent old-snapshot child execution',async()=>{
    const f=await fixture();try{
      await f.send();await f.run(output('计划',f.plan));
      await f.cmd('member.setRuntime',{memberId:f.a,kind:'fake',permissionMode:'bypassPermissions',effort:'high'});
      await f.run(output('不可发出'));await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
    }finally{f.db.close();}
  });
  it('does not silently elevate a read-only member to implement a plan',async()=>{
    const f=await fixture();try{
      await f.cmd('member.setRuntime',{memberId:f.b,kind:'fake',permissionMode:'plan'});
      const root=await f.send();await f.run(output('不合法提权计划',{summary:'只读成员不写文件',steps:[{...f.plan.steps[1],role:'implementation',dependsOn:[]}]}));
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:0});
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
    }finally{f.db.close();}
  });
  it('stopping while a child session opens prevents startTurn and leaves no runnable siblings',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',f.plan));
      let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
      const original=f.adapter.openSession.bind(f.adapter);
      f.adapter.openSession=async input=>{await barrier;return original(input);};
      const opening=f.run(output('不应执行'));
      await new Promise<void>(resolve=>setImmediate(resolve));
      const run=f.db.prepare('SELECT run_id FROM coordination_runs').get() as {run_id:string};
      await f.cmd('task.stop',{taskId:root.taskId,targetRunId:run.run_id,expectedStopGeneration:0});
      release();await opening;await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status IN ('RUNNING','STOPPING')").get()).toEqual({n:0});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'CANCELLED'});
    }finally{f.db.close();}
  });
  it('does not falsely integrate when a child explicitly fails',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',f.plan));
      await f.run([{kind:'event',event:{kind:'turn.failed',code:'PROVIDER_ERROR',message:'隔离故障',retryable:false}}]);await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('rejects a plan exceeding the aggregate parent budget including integration reserve',async()=>{
    const f=await fixture();try{
      const root=await f.send();const steps=Array.from({length:4},(_,i)=>({...f.plan.steps[0]!,key:`step${i}`}));await f.run(output('过量计划',{...f.plan,steps}));
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:0});
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
    }finally{f.db.close();}
  });
  it('refuses stale file bytes before the reviewer starts, preserving the original delivery',async()=>{
    const f=await fixture();try{
      const root=await f.send();const plan={...f.plan,steps:[{...f.plan.steps[0]!,role:'implementation'},f.plan.steps[1]!]};await f.run(output('计划',plan));
      await f.run([{kind:'writeFile',path:'result.txt',content:'original'},...output('已生成文件')]);
      writeFileSync(join(f.dir,'project','result.txt'),'external-change');
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
    }finally{f.db.close();}
  });
  it.each([false,true])('accepts dependent implementation versions with a forward-reference array=%s',async reverse=>{
    const f=await fixture();try{
      const root=await f.send();const plan={...f.plan,steps:f.plan.steps.map((s,i)=>({...s,role:'implementation',objective:i?'读取上游并完善文件':'创建文件'}))};
      if(reverse)plan.steps.reverse();
      await f.run(output('计划',plan));
      await f.run([{kind:'writeFile',path:'result.txt',content:'managed-v1'},...output('第一版')]);
      await f.run([{kind:'writeFile',path:'result.txt',content:'managed-v2'},...output('完善第二版')]);
      await f.run(output('最终整合'));
      expect(readFileSync(join(f.dir,'project','result.txt'),'utf8')).toBe('managed-v2');
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'completed'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:1});
      const saved=f.db.prepare('SELECT handoff_json FROM coordination_steps ORDER BY rowid').all() as {handoff_json:string}[];
      const hashes=saved.map(s=>(JSON.parse(s.handoff_json) as {output:{files:{sha256:string}[]}}).output.files[0]!.sha256);
      expect(hashes[0]).not.toBe(hashes[1]);
    }finally{f.db.close();}
  });
  it.each(['unchanged','downstream','integration'] as const)('binds review to its actual input version when final files are %s',async variant=>{
    const f=await fixture();try{
      const root=await f.send();
      const steps=[{key:'impl',memberId:f.a,title:'实施',objective:'创建结果',role:'implementation',dependsOn:[]},{key:'review',memberId:f.b,title:'评审',objective:'读取上游文件',role:'review',dependsOn:['impl']}];
      if(variant==='downstream')steps.push({key:'revise',memberId:f.a,title:'完善',objective:'修改文件',role:'implementation',dependsOn:['review']});
      await f.run(output('计划',{summary:'核对评审版本',steps}));
      await f.run([{kind:'writeFile',path:'result.txt',content:'v1'},...output('第一版')]);
      await f.run(output('已读第一版'));
      if(variant==='downstream')await f.run([{kind:'writeFile',path:'result.txt',content:'v2'},...output('第二版')]);
      await f.run([...(variant==='integration'?[{kind:'writeFile' as const,path:'result.txt',content:'v3'}]:[]),...output('整合')]);
      const detail=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projectId,taskId:root.taskId});
      const review=detail.coordination!.steps.find(s=>s.key==='review')!;
      expect(review.reviewVersionCurrent).toBe(variant==='unchanged');
      expect(review.inputVersions).toHaveLength(1);
      const child=detail.coordination!.steps.find(s=>s.key==='impl')!;
      expect(review.inputVersions![0]).toMatchObject({deliveryId:child.deliveryId,revision:child.deliveryRevision,manifestHash:child.manifestHash});
      const selected=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projectId,taskId:child.taskId,conversationId:f.room.conversationId,deliveryId:child.deliveryId});
      expect(selected.deliveries.some(d=>d.id===child.deliveryId&&d.runId===selected.selectedRunId)).toBe(true);
      expect((await f.raw('task.details',{projectId:f.projectId,taskId:review.taskId,deliveryId:child.deliveryId})).ok).toBe(false);
    }finally{f.db.close();}
  });
  it('keeps explicit integration format repair in the original plan and aggregate budget',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',f.plan));await f.run(output('分析甲'));await f.run(output('复核甲'));
      await f.run(output('坏协议',undefined,{remainingIssues:123}));
      const original=f.db.prepare('SELECT run_id FROM coordination_runs').get() as {run_id:string};
      const facts=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projectId,taskId:root.taskId});
      expect(facts.failedRetry).toMatchObject({available:true,formatRepair:true,pending:false});
      await f.cmd('task.redispatch',{taskId:root.taskId,formatRepair:true,reason:'人工明确修复原输出',sourceRunId:facts.latestRunId,expectedRunStatus:'FAILED',expectedTaskRevision:facts.task.revision,expectedStopGeneration:facts.task.stopGeneration});
      const queued=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projectId,taskId:root.taskId});expect(queued.failedRetry).toMatchObject({available:false,pending:true});
      await f.run(output('合法整合'));
      expect(f.adapter.startTurnLog).toHaveLength(5);
      expect(f.db.prepare('SELECT count(*) n FROM coordination_runs').get()).toEqual({n:1});
      expect(f.db.prepare('SELECT state FROM coordination_runs WHERE run_id=?').get(original.run_id)).toEqual({state:'completed'});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_integration_attempts WHERE coordination_run_id=?').get(original.run_id)).toEqual({n:2});
      const delivery=f.db.prepare('SELECT artifact_refs_json FROM task_deliveries WHERE task_id=?').get(root.taskId) as {artifact_refs_json:string};
      expect(JSON.parse(delivery.artifact_refs_json)).toHaveLength(3);
    }finally{f.db.close();}
  });
  it('still refuses two independent implementations overwriting the same file without a dependency',async()=>{
    const f=await fixture();try{
      const root=await f.send();const steps=f.plan.steps.map(s=>({...s,role:'implementation',dependsOn:[]}));
      await f.run(output('计划',{...f.plan,steps}));
      await f.run([{kind:'writeFile',path:'result.txt',content:'first'},...output('首次实施')]);
      await f.run([{kind:'writeFile',path:'result.txt',content:'second'},...output('无依赖覆盖')]);
      await f.worker.runOnce();expect(f.adapter.startTurnLog).toHaveLength(3);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('rejects recreation of an absent file before review (isolated fake deletion injection)',async()=>{
    const f=await fixture();try{
      const path=join(f.dir,'project','removed.txt');writeFileSync(path,'before');
      const root=await f.send();await f.run(output('计划',{...f.plan,steps:[{...f.plan.steps[0],role:'implementation'},f.plan.steps[1]]}));
      const events=f.adapter.events.bind(f.adapter);let removed=false;
      f.adapter.events=async function*(session){for await(const event of events(session)){if(event.kind==='turn.completed'&&!removed){unlinkSync(path);removed=true;}yield event;}};
      await f.run(output('工程夹具模拟删除'));
      writeFileSync(path,'EXTERNAL RECREATION');
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('does not starve current work behind more than 100 closed cancellation records (history fixture)',async()=>{
    const f=await fixture();try{
      const old=await f.send();await f.run(output('旧计划',f.plan));
      const prior=f.db.prepare('SELECT run_id FROM coordination_runs').get() as {run_id:string};
      await f.cmd('task.stop',{taskId:old.taskId,targetRunId:prior.run_id,expectedStopGeneration:0});await f.worker.runOnce();
      // Historical scale injection is separate from normal task-state generation above.
      for(let i=0;i<105;i++){const id=`history_${i}`;
        f.db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES(?,?,?,?,'AUTO','CANCELLED')").run(id,old.taskId,f.room.conversationId,old.threadId);
        f.db.prepare("INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,created_at) VALUES(?,?,1,'cancelled',?)").run(id,old.taskId,i);
      }
      await f.send();await f.run(output('新计划',f.plan));await f.run(output('新任务实际开始'));
      expect(f.adapter.startTurnLog).toHaveLength(3);
      expect((f.db.prepare("SELECT count(*) n FROM task_deliveries d JOIN tasks t ON t.id=d.task_id WHERE t.parent_task_id!=?").get(old.taskId) as {n:number}).n).toBe(1);
    }finally{f.db.close();}
  });
});
