import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker,type DispatchWorkerOptions} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
afterEach(()=>vi.unstubAllEnvs());
const output=(answer:string,coordinationPlan?:unknown,extra:Record<string,unknown>={}):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',answer,responseKind:'work',changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...(coordinationPlan?{coordinationPlan}:{}),...extra})}}];
async function fixture(enableDeliberate=false,options:Partial<Pick<DispatchWorkerOptions,'turnDeadlineMs'|'interruptGraceMs'|'coordinationMaxCalls'|'detachedTurnConsumption'>>={}) {
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r86-coordination-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  let script:FakeTurnScript=output('你好');
  const adapter=new FakeRuntimeAdapter({structuredFinal:!enableDeliberate,turnScriptSequencer:()=>script});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r86',appDataDir:dir,enableDeliberate,coordinationMaxCalls:6,...options});
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:(id:string)=>worker.interruptTurn(id),prepareRuntimeConfiguration:async()=>{throw Error('No real runtime preparation permitted in fixture');}};
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


describe('R119 work is not rejected by proposal or roster counts',()=>{
 it('executes a twelve-step proposal with eleven dependencies while the call budget is disabled',async()=>{
  const f=await fixture();try{
   const root=await f.send();
   const steps=Array.from({length:12},(_,index)=>({key:`step${index}`,memberId:index%2?f.b:f.a,title:`工作${index}`,objective:index===0?'完整要求。'.repeat(2000):`完成第${index}项工作`,role:'analysis',dependsOn:index===11?Array.from({length:11},(_,n)=>`step${n}`):[]}));
   expect(await f.run(output('按实际需求安排12项工作',{summary:'分工依据。'.repeat(1000),steps}))).toBe(true);
   for(let index=0;index<12;index++)expect(await f.run(output(`第${index}项完成`))).toBe(true);
   expect(await f.run(output('12项工作均已整合'))).toBe(true);
   expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
   expect(f.db.prepare('SELECT count(*) n FROM coordination_steps').get()).toEqual({n:12});
   expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='FAILED'").get()).toEqual({n:0});
  }finally{await f.adapter.closeAllSessions();f.db.close();}
 });
 it('accepts five distinct handoffs in one model result without a format-repair failure',async()=>{
  const f=await fixture();try{
   const root=await f.send();
   const handoffs=Array.from({length:5},(_,index)=>({toMemberId:f.b,purpose:'ask',message:index===0?'完整交接。'.repeat(1600):`请独立核对第${index}项要求`}));
   expect(await f.run(output('交接五项具体核对',undefined,{handoffs}))).toBe(true);
   for(let index=0;index<5;index++)expect(await f.run(output(`第${index}项核对完成`))).toBe(true);
   expect(await f.run(output('五项核对已整合'))).toBe(true);
   expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
   expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE kind='turn.outputInvalid'").get()).toEqual({n:0});
  }finally{await f.adapter.closeAllSessions();f.db.close();}
 });
 it('prepares and executes thirteen explicitly selected members through the formal command path',async()=>{
  const f=await fixture();try{
   const members=[f.a,f.b];
   for(let index=2;index<13;index++){
    const {memberId}=await f.cmd<{memberId:string}>('member.create',{projectId:f.projectId,displayName:`额外AI${index}`});
    await f.cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});members.push(memberId);
   }
   const root=await f.send(members);
   const steps=members.map((memberId,index)=>({key:`member${index}`,memberId,title:`成员核对${index}`,objective:`分别完成第${index}项核对`,role:'analysis',dependsOn:[]}));
   expect(await f.run(output('让所有选定成员核对',{summary:'13位成员各自核对',steps}))).toBe(true);
   expect(f.adapter.startTurnLog[0]?.text).toContain(members[12]);
   for(let index=0;index<13;index++)expect(await f.run(output(`第${index}位成员已完成`))).toBe(true);
   expect(await f.run(output('13位成员的结果已整合'))).toBe(true);
   expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
   const actual=f.db.prepare('SELECT DISTINCT owner_member_id id FROM tasks WHERE parent_task_id=?').all(root.taskId) as {id:string}[];
   expect(actual.map(row=>row.id).sort()).toEqual([...members].sort());
  }finally{await f.adapter.closeAllSessions();f.db.close();}
 });
 it('keeps a complete long clarification instead of rejecting the model result as malformed',async()=>{
  const f=await fixture();try{
   const root=await f.send();
   const question='请确认以下具体资料与要求。'.repeat(1000);
   expect(await f.run(output('需要补充资料',undefined,{userQuestion:question}))).toBe(true);
   expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE kind='turn.outputInvalid'").get()).toEqual({n:0});
   const persisted=f.db.prepare('SELECT payload_json FROM domain_events WHERE task_id=?').all(root.taskId) as {payload_json:string}[];
   expect(persisted.some(row=>row.payload_json.includes(question))).toBe(true);
  }finally{await f.adapter.closeAllSessions();f.db.close();}
 });
});
