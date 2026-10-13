import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {effectiveTaskWriteAccess} from '../../src/daemon/projectWriteAccess.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {DispatchAdmission} from '../../src/daemon/admission.ts';
import {acquireLease} from '../../src/daemon/workspaceLocks.ts';
import type {OpenSessionInput,SessionRef} from '../../src/contracts/runtime.ts';
afterEach(()=>vi.unstubAllEnvs());
interface Facts {project:{id:string};memberId:string;taskId:string;conversationId:string;id:string;revision:number;authorized:boolean;items:Array<{id:string;revision:number;conversationId:string}>}
interface Reply {ok:boolean;replayed?:boolean;data?:Facts;error?:{code:string;message:string}}
async function fixture(){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');vi.stubEnv('ZS_RUNTIME','fake');
  const root=mkdtempSync(join(tmpdir(),'zs-r82-')),data=join(root,'data'),a=join(root,'中文项目'),b=join(root,'旁边');for(const p of [data,a,b])mkdirSync(p);
  const db=openDatabase(join(data,'state.sqlite'));
  const raw=(method:string,params:unknown,id:string=randomUUID())=>dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:data,interruptTurn:async()=>{}} ,{protocolVersion:1,commandId:id,method,params}) as Promise<Reply>;
  const cmd=async(method:string,params:unknown,id?:string)=>{const r=await raw(method,params,id);if(!r.ok)throw Error(JSON.stringify(r.error));return r.data!;};
  const p=(await cmd('project.open',{path:a})).project.id as string,q=(await cmd('project.open',{path:b})).project.id as string;
  const member=(await cmd('member.create',{projectId:p,displayName:'工程成员'})).memberId as string;
  await cmd('member.setRuntime',{memberId:member,kind:'fake',permissionMode:'acceptEdits'});
  const room=(await cmd('room.list',{projectId:p})).items[0]!;
  const send=async(dm=false)=>{const target=dm?{kind:'dm',projectId:p,conversationId:(await cmd('conversation.create',{projectId:p,peerMemberId:member})).conversationId}:{kind:'room_root',projectId:p,roomId:room.id,conversationId:room.conversationId};return cmd('message.submit',{target,body:'合成工程任务',intent:'default',mentions:dm?[]:[{kind:'member',memberId:member}]});};
  const grant=(authorized:boolean,expectedRevision:number,id?:string)=>cmd('project.writeAccess.set',{projectId:p,authorized,expectedRevision},id);
  return {db,root,data,a,p,q,member,raw,cmd,send,grant};
}
describe('R82 explicit project write contracts (isolated fake/protocol, zero real calls)',()=>{
  it('display rename does not change execution identity; actual runtime change does',async()=>{const f=await fixture();try{
    await f.grant(true,0);const t=await f.send();const before=effectiveTaskWriteAccess(f.db,t.taskId,f.member,'fake');
    const member=(await f.cmd('member.list',{projectId:f.p})).items.find(m=>m.id===f.member)!;
    await f.cmd('member.update',{projectId:f.p,memberId:f.member,expectedRevision:member.revision,displayName:'仅显示改名',description:'不改变执行'});
    expect(effectiveTaskWriteAccess(f.db,t.taskId,f.member,'fake').identityKey).toBe(before.identityKey);
  }finally{f.db.close();}});
  it('configuration change during openSession prevents startTurn and releases only confirmed unstarted lease',async()=>{const f=await fixture();try{
    await f.grant(true,0);const t=await f.send();let starts=0;
    class Changed extends FakeRuntimeAdapter {override async openSession(i:OpenSessionInput){const s=await super.openSession(i);await f.cmd('member.setRuntime',{memberId:f.member,kind:'fake',permissionMode:'plan'});return s;}override async startTurn(s:SessionRef,i:Parameters<FakeRuntimeAdapter['startTurn']>[1]){starts++;return super.startTurn(s,i);}}
    const worker=new DispatchWorker({db:f.db,adapter:new Changed(),leaseOwner:'r82-change',appDataDir:f.data});try{await worker.runOnce();}catch{/* expected dispatch rejection, original fact below */}
    expect(starts).toBe(0);expect((f.db.prepare('SELECT a.status FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(t.taskId) as {status:string}).status).toBe('FAILED');
    expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status!='released'").get()).toBeUndefined();
  }finally{f.db.close();}});
  it('injected unconfirmed per-turn exit keeps UNKNOWN and durable single writer protection',async()=>{const f=await fixture();try{
    await f.grant(true,0);const t=await f.send();
    class NoExit extends FakeRuntimeAdapter { waitForTurnExit(){return Promise.resolve({exitConfirmed:false});} }
    const adapter=new NoExit({processIdentityOverride:()=>({model:'per-turn',pid:null})});
    const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r82-exit-fault',appDataDir:f.data});await worker.runOnce();
    expect((f.db.prepare('SELECT a.status FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(t.taskId) as {status:string}).status).toBe('UNKNOWN');
    expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status='active'").get()).toBeDefined();
    expect((await f.raw('project.writeAccess.set',{projectId:f.p,authorized:false,expectedRevision:1})).error?.code).toBe('WORKER_STILL_RUNNING');
    const admission=new DispatchAdmission();new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter(),leaseOwner:'r82-restored',appDataDir:f.data,admission});expect(admission.snapshot().global).toBe(1);
  }finally{f.db.close();}});
  it('default read-only; later grant never elevates queued task; CAS and same receipt',async()=>{const f=await fixture();try{
    const t=await f.send();expect(effectiveTaskWriteAccess(f.db,t.taskId,f.member,'fake').modificationAuthorized).toBe(false);
    await f.grant(true,0,'grant-fixed');expect((await f.raw('project.writeAccess.set',{projectId:f.p,authorized:true,expectedRevision:0},'grant-fixed')).replayed).toBe(true);
    expect(effectiveTaskWriteAccess(f.db,t.taskId,f.member,'fake').modificationAuthorized).toBe(false);
    expect((await f.raw('project.writeAccess.set',{projectId:f.p,authorized:false,expectedRevision:0})).ok).toBe(false);
    expect((await f.cmd('project.writeAccess.get',{projectId:f.q})).authorized).toBe(false);
  }finally{f.db.close();}});
  it.each([false,true])('formal room/DM worker scope and actual fake byte/diff evidence dm=%s',async dm=>{const f=await fixture();try{
    await f.grant(true,0);const t=await f.send(dm);const scopes:OpenSessionInput[]=[];
    class Capturing extends FakeRuntimeAdapter { override async openSession(i:OpenSessionInput):Promise<SessionRef>{scopes.push(i);return super.openSession(i);} }
    const adapter=new Capturing({turnScripts:[[{kind:'writeFile',path:'工程结果.md',content:'FAKE ENGINEERING ONLY'},{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',changeSummary:'工程夹具',files:['工程结果.md'],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}]]});
    const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r82',appDataDir:f.data});for(let i=0;i<8&&await worker.runOnce();i++);
    expect(scopes[0]?.writeAccess?.modificationAuthorized).toBe(true);expect(scopes[0]?.writeAccess?.allowedWriteRoots).toEqual([f.a]);
    expect(readFileSync(join(f.a,'工程结果.md'),'utf8')).toBe('FAKE ENGINEERING ONLY');
    const cs=f.db.prepare('SELECT after_ref,application_status FROM change_sets WHERE task_id=?').get(t.taskId) as {after_ref:string;application_status:string};expect(cs.after_ref).not.toBe('');expect(cs.application_status).toBe('applied');
    const d=f.db.prepare('SELECT change_set_refs_json FROM task_deliveries WHERE task_id=?').get(t.taskId) as {change_set_refs_json:string};expect(JSON.parse(d.change_set_refs_json)).toHaveLength(1);
    expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status!='released'").get()).toBeUndefined();
  }finally{f.db.close();}});
  it('revocation invalidates frozen task; changing member config does not silently elevate',async()=>{const f=await fixture();try{
    await f.grant(true,0);const t=await f.send();expect(effectiveTaskWriteAccess(f.db,t.taskId,f.member,'fake').modificationAuthorized).toBe(true);
    await f.grant(false,1);expect(()=>effectiveTaskWriteAccess(f.db,t.taskId,f.member,'fake')).toThrow(/授权/);
    await f.grant(true,2);const t2=await f.send();await f.cmd('member.setRuntime',{memberId:f.member,kind:'fake',permissionMode:'plan'});expect(()=>effectiveTaskWriteAccess(f.db,t2.taskId,f.member,'fake')).toThrow(/配置/);
  }finally{f.db.close();}});
  it('template snapshot creates independent member and never grants destination project',async()=>{const f=await fixture();try{
    await f.grant(true,0);const member=(await f.cmd('member.list',{projectId:f.p})).items.find(m=>m.id===f.member)!;
    const tpl=await f.cmd('memberTemplate.saveFromMember',{projectId:f.p,memberId:f.member,expectedRevision:member.revision,name:'独立配置',description:''});
    await f.cmd('memberTemplate.createMember',{projectId:f.q,templateId:tpl.id,expectedRevision:tpl.revision,displayName:'模板成员',description:''});
    expect((await f.cmd('project.writeAccess.get',{projectId:f.q})).authorized).toBe(false);
    expect(JSON.stringify(tpl)).not.toContain(f.a);
  }finally{f.db.close();}});
  it('single writer durable lease denies parent/child and adjacent-prefix remains independent',async()=>{const f=await fixture();try{
    const ids:string[]=[];const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter(),leaseOwner:'lease-fixture',appDataDir:f.data});
    for(let n=0;n<3;n++){const t=await f.send();for(let i=0;i<8&&await worker.runOnce();i++);ids.push((f.db.prepare('SELECT a.id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(t.taskId) as {id:string}).id);}
    expect(acquireLease(f.db,{lockDomain:f.a,ownerTurnId:ids[0]!,policy:'single_writer',now:1}).ok).toBe(true);
    expect(acquireLease(f.db,{lockDomain:join(f.a,'child'),ownerTurnId:ids[1]!,policy:'single_writer',now:2}).ok).toBe(false);
    expect(acquireLease(f.db,{lockDomain:f.a+'-other',ownerTurnId:ids[2]!,policy:'single_writer',now:2}).ok).toBe(true);
  }finally{f.db.close();}});
});
