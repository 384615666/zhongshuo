import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';

afterEach(() => vi.unstubAllEnvs());
const output = (answer: string, coordinationPlan?: unknown): FakeTurnScript => [{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({
  schemaVersion:'task-complete-v1',resultKey:'fixture',answer,responseKind:coordinationPlan?'work':'conversation',changeSummary:answer,
  files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...(coordinationPlan?{coordinationPlan}:{})
})}}];

async function fixture() {
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r86-coordination-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  let script:FakeTurnScript=output('你好');
  const adapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>script});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r86',appDataDir:dir});
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
  const send=()=>cmd<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请两位成员协作分析再复核',intent:'default',mentions:[]});
  const plan={summary:'独立分析后复核',steps:[{key:'analysis',memberId:a,title:'分析',objective:'提出实现方案',role:'analysis',dependsOn:[]},{key:'review',memberId:b,title:'复核',objective:'读取并复核上游方案',role:'review',dependsOn:['analysis']}]};
  const run=async(s:FakeTurnScript)=>{script=s;return worker.runOnce();};
  return {db,dir,worker,adapter,cmd,raw,send,run,plan,a,b,room,projectId};
}

describe('R86 formal command → persistent coordination → DIRECT child worker',()=>{
  it('creates genuine independent children, freezes upstream versions, integrates and reopens',async()=>{
    const f=await fixture();
    try{
      const root=await f.send();await f.run(output('准备分工',f.plan));
      expect((f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId) as {status:string}).status).toBe('ACTIVE');
      expect((f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId) as {n:number}).n).toBe(2);
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
  it('rejects a model-invented member without creating children or dispatching it',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',{...f.plan,steps:[{...f.plan.steps[0],memberId:'cross-project'}]}));
      expect((f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId) as {n:number}).n).toBe(0);
      expect((f.db.prepare('SELECT state FROM coordination_runs').get() as {state:string}).state).toBe('blocked');
      expect(f.adapter.startTurnLog).toHaveLength(1);
    }finally{f.db.close();}
  });
  it('keeps ordinary no-mention questions as one natural coordinator response',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('你好！'));
      expect((f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId) as {status:string}).status).toBe('DONE');
      expect((f.db.prepare('SELECT count(*) n FROM coordination_steps').get() as {n:number}).n).toBe(0);
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
});
