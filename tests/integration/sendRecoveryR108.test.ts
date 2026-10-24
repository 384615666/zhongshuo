import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {computeCommandPayloadHash} from '../../src/domain/idempotency.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {successTurn} from '../../src/adapter/fake/script.ts';
import type {SendLookupResult} from '../../src/contracts/sendRecovery.ts';
import type {TaskExecutionStatus} from '../../src/contracts/executionStatus.ts';

const dirs:string[]=[];
beforeEach(()=>{vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','');});
afterEach(()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'zs-r108-send-'));dirs.push(root);
  const db=openDatabase(':memory:');
  db.prepare("INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at) VALUES('p','R108',?,?, '{}',0)").run(root,root);
  db.prepare("INSERT INTO project_members(id,project_id,display_name,principal_type,enabled) VALUES('m','p','Codex','agent',1)").run();
  db.prepare("INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('r','p','room','m')").run();
  db.prepare("INSERT INTO room_members(room_id,member_id) VALUES('r','m')").run();
  db.prepare("INSERT INTO conversations(id,project_id,kind,room_id) VALUES('c','p','room','r')").run();
  const deps={db,localUserId:'u_local',interruptTurn:async()=>{}};
  const raw=(method:string,params:unknown,commandId='r108-'+randomUUID(),localUserId='u_local')=>dispatchDaemonCommand({...deps,localUserId},{protocolVersion:1,commandId,method,params}) as Promise<{ok:boolean;data?:unknown;error?:{code:string;message:string}}>;
  async function cmd<T>(method:string,params:unknown,commandId?:string):Promise<T>{const result=await raw(method,params,commandId);if(!result.ok)throw Error(result.error?.message);return result.data as T;}
  const request=(target:Record<string,unknown>,intent='record_only')=>({commandId:'send-'+randomUUID(),method:'message.submit' as const,params:{target,body:'只查询原请求，不重新执行',intent,mentions:[]}});
  const lookup=(ref:ReturnType<typeof request>)=>cmd<SendLookupResult>('message.lookupSubmission',{request:ref,payloadHash:computeCommandPayloadHash({method:ref.method,target:null,params:ref.params,expectedRevision:null})});
  return{db,root,raw,cmd,request,lookup};
}
describe('R108 authenticated read-only original send lookup',()=>{
  it('registers durable notification poll, claim and native-stage acknowledgements through the formal gateway',async()=>{
    const f=await fixture();const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter(),leaseOwner:'r108-notification-api',appDataDir:join(f.root,'app')});
    try{
      expect(await f.cmd('taskNotification.poll',{limit:1})).toMatchObject({items:[]});
      const ref=f.request({kind:'room_root',projectId:'p',conversationId:'c',roomId:'r'},'default');
      const accepted=await f.cmd<{taskId:string}>('message.submit',ref.params,ref.commandId);
      await worker.runOnce();await worker.awaitSettlement(2000);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(accepted.taskId)).toEqual({status:'DONE'});
      const inbox=await f.cmd<{items:Array<{notificationId:string}>}>('taskNotification.poll',{limit:5});
      expect(inbox.items).toHaveLength(1);const id=inbox.items[0]!.notificationId;
      expect(await f.cmd('taskNotification.claim',{notificationId:id})).toMatchObject({claimed:true,notification:{locator:{taskId:accepted.taskId}}});
      expect(await f.cmd('taskNotification.ack',{notificationId:id,stage:'show_requested'})).toMatchObject({state:'show_requested'});
      expect(await f.cmd('taskNotification.ack',{notificationId:id,stage:'shown'})).toMatchObject({state:'shown'});
      expect(await f.cmd('taskNotification.poll',{limit:5})).toMatchObject({items:[],health:{shown:1}});
      const wrong=await f.raw('taskNotification.ack',{notificationId:id,stage:'shown'},undefined,'other');
      expect(wrong).toMatchObject({ok:false,error:{code:'TASK_NOTIFICATION_NOT_FOUND'}});
    }finally{worker.stopAccepting();await worker.awaitSettlement(2000);f.db.close();}
  });
  it('publishes the same queue and zero-call launch failure facts through task, thread details and room pool',async()=>{
    const f=await fixture();const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter(),leaseOwner:'r108-status',appDataDir:join(f.root,'app')});
    try{
      const ref=f.request({kind:'room_root',projectId:'p',conversationId:'c',roomId:'r'},'default');
      const accepted=await f.cmd<{taskId:string}>('message.submit',ref.params,ref.commandId);
      const queued=await f.cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId:accepted.taskId});
      expect(queued.executionStatus.phase).toBe('QUEUED');
      f.db.prepare("UPDATE project_members SET enabled=0 WHERE id='m'").run();await worker.runOnce();
      const task=await f.cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId:accepted.taskId});
      const detail=await f.cmd<{executionStatus:TaskExecutionStatus}>('task.details',{taskId:accepted.taskId,projectId:'p'});
      const pool=await f.cmd<{items:Array<{taskId:string;executionStatus:TaskExecutionStatus}>}>('room.pool',{roomId:'r'});
      for(const status of [task.executionStatus,detail.executionStatus,pool.items.find(item=>item.taskId===accepted.taskId)!.executionStatus]){
        expect(status).toMatchObject({taskId:accepted.taskId,phase:'NOT_STARTED_FAILED',actualPerformingMembers:[]});
        expect(status.reason.message).toContain('停用');
      }
      expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{worker.stopAccepting();await worker.awaitSettlement(2000);f.db.close();}
  });
  it('finds root/thread/DM by the original frozen request without changing any durable state',async()=>{
    const f=await fixture();try{
      const room=f.request({kind:'room_root',projectId:'p',conversationId:'c',roomId:'r'});
      const root=await f.cmd<{messageId:string;threadId:string}>('message.submit',room.params,room.commandId);
      const thread=f.request({kind:'thread',projectId:'p',conversationId:'c',threadId:root.threadId});
      const reply=await f.cmd<{messageId:string}>('message.submit',thread.params,thread.commandId);
      const dm=await f.cmd<{conversationId:string}>('conversation.create',{projectId:'p',peerMemberId:'m'});
      const direct=f.request({kind:'dm',projectId:'p',conversationId:dm.conversationId});
      const directResult=await f.cmd<{messageId:string}>('message.submit',direct.params,direct.commandId);
      const before=f.db.prepare('SELECT total_changes() n').get();
      for(const [ref,id] of [[room,root.messageId],[thread,reply.messageId],[direct,directResult.messageId]] as const){
        const result=await f.lookup(ref);expect(result.status).toBe('found');if(result.status==='found')expect(result.location.messageId).toBe(id);
      }
      expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before);
      expect(f.db.prepare('SELECT count(*) n FROM workflow_runs').get()).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('keeps a lost acknowledgement tied to one actual worker execution; lookup cannot create a second call',async()=>{
    const f=await fixture();const adapter=new FakeRuntimeAdapter({turnScripts:[successTurn()]});
    const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r108',appDataDir:join(f.root,'app')});
    try{
      const dm=await f.cmd<{conversationId:string}>('conversation.create',{projectId:'p',peerMemberId:'m'});
      const ref=f.request({kind:'dm',projectId:'p',conversationId:dm.conversationId},'default');
      const accepted=await f.cmd<{taskId:string;messageId:string}>('message.submit',ref.params,ref.commandId);
      // Simulate a lost transport response: lookup uses only the saved request.
      const recovered=await f.lookup(ref);expect(recovered.status).toBe('found');
      if(recovered.status==='found')expect(recovered.location.taskId).toBe(accepted.taskId);
      const taskStatus=await f.cmd<{executionStatus:TaskExecutionStatus}>('task.get',{taskId:accepted.taskId});
      const dmStatus=await f.cmd<{conversations:Array<{conversationId:string;executionStatus:TaskExecutionStatus}>}>('conversation.list',{projectId:'p'});
      expect(dmStatus.conversations.find(item=>item.conversationId===dm.conversationId)?.executionStatus.phase).toBe(taskStatus.executionStatus.phase);
      await worker.runOnce();
      await vi.waitFor(()=>expect(f.db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:1}));
      const before=f.db.prepare('SELECT total_changes() n').get();await f.lookup(ref);await f.lookup(ref);
      expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before);
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:1});
    }finally{worker.stopAccepting();await worker.awaitSettlement(2000);f.db.close();}
  });
  it('separates missing/expired receipts and rejects altered payload, target or another user without writes',async()=>{
    const f=await fixture();try{
      const ref=f.request({kind:'room_root',projectId:'p',conversationId:'c',roomId:'r'});
      const missing=await f.lookup(ref);expect(missing.status).toBe('not-found');
      await f.cmd('message.submit',ref.params,ref.commandId);
      const changed={...ref,params:{...ref.params,body:'different'}};
      await expect(f.lookup(changed)).rejects.toThrow(/不匹配/);
      const hash=computeCommandPayloadHash({method:ref.method,target:null,params:ref.params,expectedRevision:null});
      const other=await f.raw('message.lookupSubmission',{request:ref,payloadHash:hash},undefined,'other');
      expect(other.ok&&((other.data as SendLookupResult).status==='not-found')).toBe(true);
      const badTarget={...ref,params:{...ref.params,target:{kind:'room_root',projectId:'other',conversationId:'c',roomId:'r'}}};
      await expect(f.lookup(badTarget)).rejects.toThrow(/归属/);
      f.db.prepare('UPDATE command_receipts SET result_json=NULL WHERE command_id=?').run(ref.commandId);
      expect((await f.lookup(ref)).status).toBe('expired');
      expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:1});
    }finally{f.db.close();}
  });
});
