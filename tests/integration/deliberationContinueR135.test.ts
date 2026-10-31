import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {TaskExecutionStatus} from '../../src/contracts/executionStatus.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';

afterEach(()=>vi.unstubAllEnvs());
async function fixture(){
  vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_ALLOW_FAKE','1');
  const dir=mkdtempSync(join(tmpdir(),'zs-r135-continue-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  let fail=true,onOpen:(()=>Promise<void>)|undefined;
  class Adapter extends FakeRuntimeAdapter{
    override async openSession(input:Parameters<FakeRuntimeAdapter['openSession']>[0]){const session=await super.openSession(input);await onOpen?.();return session;}
  }
  const adapter=new Adapter({structuredFinal:false,turnScriptSequencer:()=>fail
    ?[{kind:'event',event:{kind:'turn.failed',code:'SYNTHETIC_FAILURE',message:'合成执行失败',retryable:false}}]
    :[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'analysis-draft-v1',summary:'新的本人成员回复',document:null,completion:{disposition:'conversation',reason:'仅简短交流'},claims:[],recommendations:[],openQuestions:[]})}}] as FakeTurnScript});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r135-continue',appDataDir:dir,enableDeliberate:true});
  const cmd=async<T>(method:string,params:unknown,commandId:string=randomUUID())=>{
    const r=await dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:dir,interruptTurn:id=>worker.interruptTurn(id)},{protocolVersion:1,commandId,method,params}) as {ok:boolean;data:T;error?:unknown};
    expect(r.ok,JSON.stringify(r.error)).toBe(true);return r.data;
  };
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:Array<{id:string;conversationId:string}>}>('room.list',{projectId})).items[0]!;
  const members:string[]=[];for(const displayName of ['合成甲','合成乙']){
    const memberId=(await cmd<{memberId:string}>('member.create',{projectId,displayName})).memberId;members.push(memberId);
    await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
  }
  const root=await cmd<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请两位独立回应',intent:'default',collaboration:'deliberate',mentions:members.map(memberId=>({kind:'member',memberId}))});
  await worker.drain();await worker.drain();
  const old=db.prepare('SELECT id,status FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(root.taskId) as {id:string;status:string};
  expect(old.status).toBe('FAILED');
  const failedStatus=await cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId:root.taskId});
  expect(failedStatus.executionStatus.reason.message).toBe('合成执行失败');
  const retry=async()=>{
    const detail=await cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId:root.taskId});
    const action=detail.executionStatus.actions.find(a=>a.kind==='retry');if(action?.kind!=='retry')throw Error('No formal retry action');
    const {method,...params}=action.binding;await cmd(method,params);
    await worker.runOnce();
    return(db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(root.taskId) as {id:string}).id;
  };
  return{db,adapter,worker,root,old,cmd,retry,setSuccess:()=>{fail=false;},setOpen:(fn:()=>Promise<void>)=>{onOpen=fn;},close:async()=>{await adapter.closeAllSessions();db.close();}};
}
describe('R135 explicitly continuing an independent discussion',()=>{
  it.each(['FAILED','PARTIAL','INTERRUPTED'])('starts both actual members after a blocked %s run and preserves that history',async status=>{
    const f=await fixture();try{
      f.db.prepare('UPDATE workflow_runs SET status=? WHERE id=?').run(status,f.old.id);
      f.setSuccess();const before=f.adapter.startTurnLog.length,newRunId=await f.retry();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(f.root.taskId)).toEqual({status:'ACTIVE'});
      await f.worker.drain();await f.worker.drain();
      expect(f.adapter.startTurnLog.length-before).toBe(2);
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(newRunId)).toEqual({status:'SUCCEEDED'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(f.old.id)).toEqual({status});
      expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE run_id=? AND kind='turn.startupCancelled'").get(newRunId)).toEqual({n:0});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(f.root.taskId)).toEqual({status:'DONE'});
      expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{await f.close();}
  });
  it('still prevents startTurn when stopped during session opening after an explicit continue',async()=>{
    const f=await fixture();try{
      f.setSuccess();const before=f.adapter.startTurnLog.length,newRunId=await f.retry();let stopped=false;
      f.setOpen(async()=>{if(stopped)return;stopped=true;await f.cmd('task.stop',{taskId:f.root.taskId,targetRunId:newRunId,expectedStopGeneration:0});});
      await f.worker.drain();await f.worker.drain();
      expect(stopped).toBe(true);expect(f.adapter.startTurnLog).toHaveLength(before);
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(newRunId)).toEqual({status:'CANCELLED'});
    }finally{await f.close();}
  });
});
