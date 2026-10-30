import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {collisionFixture,finish,ObservedAdapter} from '../helpers/collisionHarnessR122.ts';
import type {TaskDetailsResult} from '../../src/contracts/taskDetails.ts';
import type {TaskExecutionStatus} from '../../src/contracts/executionStatus.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';

beforeEach(()=>{vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');});
afterEach(()=>vi.unstubAllEnvs());
const failure:FakeTurnScript=[{kind:'event',event:{kind:'turn.failed',code:'PROVIDER_ERROR',message:'隔离测试执行失败',retryable:false}}];
const actionOf=async(f:Awaited<ReturnType<typeof collisionFixture>>,taskId:string,kind:'retry'|'close')=>{
  const detail=await f.cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId});
  const action=detail.executionStatus.actions.find(action=>action.kind===kind);
  expect(action,JSON.stringify(detail.executionStatus)).toBeDefined();return action!;
};

describe('R128 task actions through the formal command and worker',()=>{
  it.each(['FAILED','PARTIAL','INTERRUPTED'])('continues a blocked %s attempt using its frozen action and retains the old run',async status=>{
    const scripts=[failure,finish('新的执行完成',20)];
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>scripts.shift()!});
    const f=await collisionFixture('r128-retry-'+status,{members:1,adapter});
    try{
      const root=await f.send(0,0,[0],'从原请求继续');await f.worker.runOnce();await f.worker.awaitInFlightTurns(3000);
      const original=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=?').get(root.taskId) as {id:string};
      // Persisted states seen in historical versions: a run has ended while the
      // user task remains blocked. Execution evidence is retained unchanged.
      f.db.prepare('UPDATE workflow_runs SET status=? WHERE id=?').run(status,original.id);
      f.db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id=?").run(root.taskId);
      const details=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projects[0]!.id,taskId:root.taskId});
      expect(details.failedRetry.available).toBe(true);
      const close=await actionOf(f,root.taskId,'close');expect(close.kind).toBe('close');
      const retry=await actionOf(f,root.taskId,'retry');if(retry.kind!=='retry'||retry.binding.sourceRunId==null)throw Error('missing bound retry');
      const {method,...params}=retry.binding;const commandId=randomUUID();
      expect((await f.raw(method,{...params,expectedTaskRevision:params.expectedTaskRevision+1})).error?.code).toBe('STALE_REVISION');
      const [sent,replayed]=await Promise.all([f.raw(method,params,commandId),f.raw(method,params,commandId)]);
      expect(sent.ok).toBe(true);expect(replayed.ok).toBe(true);
      expect(f.count("SELECT count(*) n FROM outbox WHERE dispatch_key=?",`task:${root.taskId}:redispatch:${original.id}`)).toBe(1);
      expect((await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projects[0]!.id,taskId:root.taskId})).failedRetry.pending).toBe(true);
      await f.pumpUntil(()=>f.taskStatus(root.taskId)==='DONE');
      expect(adapter.turns).toHaveLength(2);
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(original.id)).toEqual({status});
      if(close.kind==='close')expect((await f.raw('task.close',close.binding)).error?.code).toBe('STALE_REVISION');
      expect((await f.raw(method,params)).ok).toBe(false);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it('closes a preparation failure with no run, clears unfinished work, and preserves the message',async()=>{
    const f=await collisionFixture('r128-close-no-run',{members:1});
    try{
      const root=await f.send(0,0,[0],'准备失败后结束');
      f.db.prepare("UPDATE tasks SET write_scope_json=json_set(write_scope_json,'$.launchFingerprintVersion',99) WHERE id=?").run(root.taskId);
      await f.worker.runOnce();
      expect(f.taskStatus(root.taskId)).toBe('BLOCKED');expect(f.count('SELECT count(*) n FROM workflow_runs WHERE task_id=?',root.taskId)).toBe(0);
      const action=await actionOf(f,root.taskId,'close');if(action.kind!=='close')throw Error('missing close');
      const id=randomUUID();expect((await f.raw('task.close',action.binding,id)).ok).toBe(true);
      expect((await f.raw('task.close',action.binding,id)).ok).toBe(true);
      expect(f.taskStatus(root.taskId)).toBe('CANCELLED');
      const after=await f.cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId:root.taskId});
      expect(after.executionStatus.phase).toBe('CANCELLED');
      expect(after.executionStatus.actions.some(a=>a.kind==='retry'||a.kind==='close')).toBe(false);
      expect((await f.cmd<{unfinishedTasks:number}>('project.taskSummary',{projectId:f.projects[0]!.id})).unfinishedTasks).toBe(0);
      expect(f.count('SELECT count(*) n FROM messages WHERE id=?',root.messageId)).toBe(1);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  });

  it.each(['PENDING','DISPATCHING','WAITING_INPUT','WAITING_APPROVAL','STOPPING'])('does not offer or accept continuation past a %s turn under a terminal run',async state=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>failure});
    const f=await collisionFixture('r128-live-'+state,{members:1,adapter});
    try{
      const root=await f.send(0,0,[0],'未结束执行的保护');await f.worker.runOnce();await f.worker.awaitInFlightTurns(3000);
      const row=f.db.prepare(`SELECT a.id,r.id runId FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?`).get(root.taskId) as {id:string;runId:string};
      f.db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id=?").run(root.taskId);
      f.db.prepare('UPDATE agent_turns SET status=? WHERE id=?').run(state,row.id);
      const d=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projects[0]!.id,taskId:root.taskId});
      expect(d.failedRetry.available).toBe(false);
      const status=(await f.cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId:root.taskId})).executionStatus;
      expect(status.actions.some(a=>a.kind==='retry'||a.kind==='close')).toBe(false);
      const result=await f.raw('task.redispatch',{taskId:root.taskId,sourceRunId:row.runId,expectedRunStatus:'FAILED',expectedTaskRevision:d.task.revision,expectedStopGeneration:d.task.stopGeneration});
      expect(result).toMatchObject({ok:false,error:{code:'WORKER_STILL_RUNNING'}});
    }finally{await f.close();}
  });
});
