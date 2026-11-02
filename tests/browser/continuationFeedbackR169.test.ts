import {describe,expect,it} from 'vitest';
import {dispatchBlockedFixture} from '../fixtures/dispatchBlockedR154.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';
import {loadRecoveryTasks} from '../../src/ui/hifi/lib/recovery';
import {taskContinuationFailure} from '../../src/ui/hifi/lib/checkPreviousReply';
import {userFacingSystemText} from '../../src/contracts/userFacingText';

describe('R169 user-facing continuation feedback and binding',()=>{
  it('preserves the authoritative source binding when loading a recovered root',async()=>{
    const {db,event}=dispatchBlockedFixture();
    try{
      db.exec("UPDATE workflow_runs SET status='INTERRUPTED' WHERE id='parent-current'");
      db.exec("INSERT INTO outbox(dispatch_key,status) VALUES('task:parent:redispatch:parent-current','done')");
      event('parent',null,'task.redispatchEnqueued',{sourceRunId:'parent-current',dispatchKey:'task:parent:redispatch:parent-current'});
      const status=readTaskExecutionStatus(db,'parent')!;
      const tasks=await loadRecoveryTasks(['parent'],async()=>({task:{id:'parent',title:'原任务',status:'ACTIVE',revision:0,stop_generation:0},executionStatus:status}));
      expect(tasks[0]?.binding).toEqual({taskId:'parent',sourceRunId:'parent-current',expectedTaskRevision:0,expectedStopGeneration:0});
    }finally{db.close();}
  });
  it('also translates legacy diagnostics on existing run-details and DM controls',()=>{
    expect(userFacingSystemText('源执行（run run_private）的恢复派发已完成：不重复派发——新意图'))
      .toBe('这次继续请求已处理，请刷新查看任务的最新进展。');
    expect(userFacingSystemText('该任务已有在途恢复派发（task:private:redispatch）：不重复入队'))
      .toBe('已有继续请求在处理中，请稍候查看任务进展。');
  });
  it.each(['STALE_REVISION','IDEMPOTENCY_CONFLICT','RECONCILE_REQUIRED','WORKER_STILL_RUNNING','ERROR'])('keeps technical %s diagnostics out of task controls',code=>{
    const message=taskContinuationFailure({status:'failed',code,error:'源执行（run run_private-123）的恢复派发已完成：不重复派发，新意图 sourceRunId outbox'});
    expect(message).not.toMatch(/run_private|sourceRunId|outbox|恢复派发|新意图/);
    expect(message.length).toBeGreaterThan(6);
  });
  it('keeps uncertain delivery distinct from a rejection without raw transport details',()=>{
    expect(taskContinuationFailure({status:'unknown',error:"Error invoking remote method 'zs:command': secret-path"}))
      .toBe('继续请求尚未收到回执，请稍后重试。');
  });
});
