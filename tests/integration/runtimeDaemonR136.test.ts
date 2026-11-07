import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {tmpdir} from 'node:os';
import {delimiter,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase,type ZhongshuoDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {MemberRuntimeRegistry,defaultModelOf,resolveMemberRuntime} from '../../src/daemon/memberRuntime.ts';
import {effectiveTaskWriteAccess} from '../../src/daemon/projectWriteAccess.ts';
import {wrapRealCallLedger,recordRealCallUsage,settleRealCall} from '../../src/daemon/realCallLedger.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {startDaemon} from '../../src/daemon/entry.ts';
import {externalRuntimeAdapter} from '../../src/daemon/externalRuntime.ts';
import {runtimeExecutable} from '../../src/contracts/runtimeKinds.ts';
import type {ExternalRuntimeKind} from '../../src/adapter/cli/executable.ts';
import type {OpenSessionInput,SessionRef,TurnRequest} from '../../src/contracts/runtime.ts';

const databases:ZhongshuoDatabase[]=[];
afterEach(()=>{for(const db of databases.splice(0))if(db.open)db.close();vi.unstubAllEnvs();vi.restoreAllMocks();});
interface Reply<T=Record<string,unknown>>{ok:boolean;data?:T;replayed?:boolean;error?:{code:string;message:string}}
async function fixture(kind:ExternalRuntimeKind='deepseek-harness'){
  const root=mkdtempSync(join(tmpdir(),'zs-r136-daemon-')),data=join(root,'data'),project=join(root,'project'),config=join(root,'config');
  for(const dir of [data,project,config])mkdirSync(dir);
  vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_REAL_DISPATCH_GUARD',undefined);
  vi.stubEnv('ZS_REAL_BATCH_ID',undefined);vi.stubEnv('ZS_CLAUDE_MODEL',undefined);vi.stubEnv('ZS_E2E_MODEL',undefined);vi.stubEnv('ZS_DSH_MODEL',undefined);vi.stubEnv('ZS_PI_MODEL',undefined);
  vi.stubEnv('CLAUDE_CONFIG_DIR',config);vi.stubEnv('CODEX_HOME',config);vi.stubEnv('DSH_HOME',config);vi.stubEnv('PI_CODING_AGENT_DIR',config);vi.stubEnv('ZS_MANAGED_RUNTIME',undefined);
  const executable=join(root,'never-execute.cjs');writeFileSync(executable,'throw Error("hash-only fixture must never execute");');
  const db=openDatabase(':memory:');databases.push(db);
  const raw=<T=Record<string,unknown>>(method:string,params:unknown,commandId:string=randomUUID())=>dispatchDaemonCommand({db,localUserId:'r136',appDataDir:data,interruptTurn:async()=>{}},{protocolVersion:1,commandId,method,params}) as Promise<Reply<T>>;
  const cmd=async<T=Record<string,unknown>>(method:string,params:unknown,commandId?:string)=>{const r=await raw<T>(method,params,commandId);if(!r.ok)throw Error(JSON.stringify(r.error));return r.data!;};
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:Array<{id:string;conversationId:string;coordinatorMemberId:string}>}>('room.list',{projectId})).items[0]!;
  const memberId=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'Harness fixture'})).memberId;
  const bind=(permissionMode?:string)=>cmd('member.setRuntime',{memberId,kind,executable,model:'fixture-model',...(permissionMode?{permissionMode}:{})});
  const send=()=>cmd<{taskId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请完成这个独立工程任务',intent:'default',mentions:[{kind:'member',memberId}]});
  const revision=()=> (db.prepare('SELECT settings_revision FROM project_members WHERE id=?').get(memberId) as {settings_revision:number}).settings_revision;
  return{root,data,project,config,executable,db,raw,cmd,projectId,memberId,room,bind,send,revision};
}
const turn=(id:string):TurnRequest=>({turnId:id,dispatchKey:id,inputBundleId:id,text:'local fake only',policyId:'policy-full-access',taskRevision:0});
const session=(cwd:string):OpenSessionInput=>({projectId:'fixture',memberId:'fixture',taskId:'fixture',threadId:'fixture',sessionGeneration:0,cwd,policyId:'policy-full-access'});

// This is an actual local Node child process speaking only the Harness transport.
// It performs no network requests, provider calls or business file modifications.
const localHarnessProcess=String.raw`
const {createInterface}=require('node:readline');
const {appendFileSync}=require('node:fs');
const mode=MODE;
const reader=createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const trace=value=>appendFileSync(__filename+'.trace',JSON.stringify(value)+'\n');
let active=null;
reader.on('line',line=>{
  const request=JSON.parse(line);trace({type:request.type,cwd:process.cwd(),schema:request.outputSchema,mode:request.mode});
  if(request.type==='cancel'){
    send({v:1,type:'result',requestId:request.requestId,sessionId:active.sessionId,status:'cancelled'});
    reader.close();process.stdin.destroy();return;
  }
  if(request.type!=='execute')return;
  if(mode==='no-result'){reader.close();process.stdin.destroy();return;}
  active={sessionId:request.sessionId||'local-session-'+request.requestId};
  send({v:1,type:'session',requestId:request.requestId,sessionId:active.sessionId,resumed:Boolean(request.sessionId)});
  send({v:1,type:'event',requestId:request.requestId,event:{kind:'usage',inputTokens:19,outputTokens:7,model:'local-reported-model'}});
  send({v:1,type:'event',requestId:request.requestId,event:{kind:'text',text:'本地协议进程已开始'}});
  if(mode==='hang')return;
  const key=request.outputSchema.properties.resultKey.const;
  const result={schemaVersion:'task-complete-v1',resultKey:mode==='wrong-key'?'unrelated-result-key':key,
    changeSummary:'本地协议验证完成',answer:'本地协议验证完成',document:null,responseKind:'work',replyDisposition:'reply',userQuestion:null,
    files:[],executedVerifications:['isolated local child process'],unexecutedVerifications:[],remainingIssues:[],handoffs:[],memoryUpdates:[]};
  send({v:1,type:'result',requestId:request.requestId,sessionId:active.sessionId,status:'completed',stopReason:'completed',text:JSON.stringify(result)});
  reader.close();process.stdin.destroy();
});
send({v:1,type:'ready',runtime:'zhongshuo-dsh',protocol:1,capabilities:{structuredEvents:true,sessionResume:true,sessionCancel:true,outputSchema:true,formatRepair:true,planningOnly:true,privateSessions:true}});
`;

const localPiProcess=String.raw`
if(process.argv.includes('--version')){console.log('1.4.0');process.exit(0);}
const {createInterface}=require('node:readline');
const {appendFileSync,writeFileSync}=require('node:fs');
const {join}=require('node:path');
const mode=MODE;
const argv=process.argv.slice(2),arg=name=>argv[argv.indexOf(name)+1];
const sessionId=arg('--session-id'),sessionFile=join(arg('--session-dir'),sessionId+'.jsonl');
writeFileSync(sessionFile,JSON.stringify({type:'session',id:sessionId,cwd:process.cwd()})+'\n');
const reader=createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
reader.on('line',line=>{
  const request=JSON.parse(line);appendFileSync(__filename+'.trace',JSON.stringify({type:request.type,cwd:process.cwd(),message:request.message,toolFree:argv.includes('--no-tools')&&argv.includes('--no-mcp')})+'\n');
  const response=data=>send({type:'response',command:request.type,id:request.id,success:true,data});
  if(request.type==='set_auto_retry'||request.type==='set_auto_compaction'){
    if(request.enabled!==false)throw Error('Planning must disable automatic retry and compaction');
    response({});return;
  }
  if(request.type==='get_state'){response({sessionId,sessionFile,isStreaming:false,pendingMessageCount:0,messageCount:0,isCompacting:false});return;}
  if(request.type==='abort'){
    response({});send({type:'agent_settled',aborted:true});reader.close();process.stdin.destroy();return;
  }
  if(request.type!=='prompt')return;
  if(mode==='no-result'){reader.close();process.stdin.destroy();return;}
  response({});send({type:'agent_start'});
  const key=/"resultKey":"([^"]+)"/.exec(request.message)?.[1];
  if(!key)throw Error('Missing authoritative task resultKey in prompt');
  const result={schemaVersion:'task-complete-v1',resultKey:mode==='wrong-key'?'unrelated-result-key':key,
    changeSummary:'本地协议验证完成',answer:'本地协议验证完成',document:null,responseKind:'work',replyDisposition:'reply',userQuestion:null,
    files:[],executedVerifications:['isolated local child process'],unexecutedVerifications:[],remainingIssues:[],handoffs:[],memoryUpdates:[]};
  send({type:'message_end',message:{role:'assistant',stopReason:'stop',model:'local-reported-model',usage:{input:19,output:7},content:[{type:'text',text:JSON.stringify(result)}]}});
  if(mode==='hang')return;
  send({type:'agent_settled',aborted:false});reader.close();process.stdin.destroy();
});
`;

async function processFixture(mode:'success'|'wrong-key'|'hang'|'no-result',kind:ExternalRuntimeKind='deepseek-harness'){
  const f=await fixture(kind);writeFileSync(f.executable,(kind==='pi'?localPiProcess:localHarnessProcess).replace('MODE',JSON.stringify(mode)));await f.bind();
  const children:ChildProcessWithoutNullStreams[]=[];
  const registry=new MemberRuntimeRegistry(f.db,new FakeRuntimeAdapter(),{[kind]:binding=>wrapRealCallLedger(externalRuntimeAdapter(kind,{
    executable:binding.executable??undefined,model:binding.model??undefined,permissionMode:binding.permissionMode??undefined,installationId:binding.installationId??undefined,cwd:f.project,
    spawnFn:(command,args,cwd)=>{const child=spawn(command,args,{cwd,windowsHide:true,stdio:'pipe'});children.push(child);return child;},
  }),kind,f.db,binding.model)},{defaultKind:'fake'});
  const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter(),adapterFor:id=>registry.adapterFor(id),leaseOwner:'r136-real-child',appDataDir:f.data,defaultProviderKey:'fake',automaticRecovery:mode==='no-result'});
  const close=async()=>{const report=await registry.disposeAll();for(const child of children)if(child.exitCode===null)child.kill();expect(report.failed).toEqual([]);expect(report.unconfirmed).toEqual([]);};
  return{...f,registry,worker,children,close};
}

describe.each(['deepseek-harness','pi'] as const)('R136 daemon %s: formal commands and isolated fake dispatch, zero provider calls',kind=>{
  it('persists Harness and independent template snapshots without creating a new default member or implying certification',async()=>{
    const f=await fixture(kind);await f.bind();
    const info=await f.cmd<{binding:{kind:string;permissionMode:string;executable:string};permissionExecution:{effective:string};installation:{capabilities_json:string};imageInput:{status:string;protocol:string;reason:string}}>('member.runtime',{memberId:f.memberId});
    expect(info.binding).toMatchObject({kind:kind,permissionMode:'bypassPermissions',executable:f.executable});
    expect(info.permissionExecution.effective).toBe('CLI 完整权限');
    // R194：所有运行时都随消息直接接收图片字节——不再有人为的「未认证」图片状态。
    expect(info.imageInput.status).toBe('supported');expect(info.imageInput.protocol).toContain('图片字节');expect(info.imageInput.reason).toContain('图片随消息直接发送');
    const capabilities=JSON.parse(info.installation.capabilities_json) as {permissionAuth:string;toolCapabilities:{restrictWrites:string}};
    expect(capabilities.permissionAuth).toBe('unverified');expect(capabilities.toolCapabilities.restrictWrites).not.toBe('supported');
    const saved=await f.cmd<{id:string;config:unknown}>('memberTemplate.saveFromMember',{projectId:f.projectId,memberId:f.memberId,expectedRevision:f.revision(),name:'Harness template',description:''});
    const clone=await f.cmd<{memberId:string}>('memberTemplate.createMember',{projectId:f.projectId,templateId:saved.id,expectedRevision:0,displayName:'Harness clone',description:''});
    const copied=resolveMemberRuntime(f.db,clone.memberId,'fake');expect(copied).toMatchObject({kind:kind,model:'fixture-model',permissionMode:'bypassPermissions'});
    const original=f.db.prepare('SELECT profile_id FROM project_members WHERE id=?').get(f.memberId);
    expect(f.db.prepare('SELECT profile_id FROM project_members WHERE id=?').get(clone.memberId)).not.toEqual(original);
    expect(f.db.prepare('SELECT coordinator_member_id FROM rooms WHERE id=?').get(f.room.id)).toEqual({coordinator_member_id:f.room.coordinatorMemberId});
    expect(f.db.prepare('SELECT count(*) n FROM runtime_installations WHERE kind=?').get(kind)).toEqual({n:1});
    expect(f.db.prepare('SELECT 1 FROM real_calls').get()).toBeUndefined();
  });

  it.each(['plan','manual','acceptEdits','dontAsk','auto'])('rejects uncertified permission %s before saving member or template configuration',async permissionMode=>{
    const f=await fixture(kind);const revision=f.revision();
    expect((await f.raw('member.setRuntime',{memberId:f.memberId,kind:kind,executable:f.executable,permissionMode})).error?.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(f.revision()).toBe(revision);
    const result=await f.raw('member.create',{projectId:f.projectId,displayName:'rejected',runtime:{kind:kind,model:null,executable:f.executable,permissionMode,effort:null}});
    expect(result.error?.code).toBe('CAPABILITY_UNSUPPORTED');
    await f.bind();const saved=await f.cmd<{id:string;config:Record<string,unknown>}>('memberTemplate.saveFromMember',{projectId:f.projectId,memberId:f.memberId,expectedRevision:f.revision(),name:'Full only',description:''});
    expect((await f.raw('memberTemplate.update',{templateId:saved.id,expectedRevision:0,name:'rejected',description:'',enabled:true,config:{...saved.config,permissionMode}})).error?.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(f.db.prepare('SELECT 1 FROM agent_turns').get()).toBeUndefined();
  });

  it('uses dsh as the channel default executable and preserves receipts, CAS and cross-project checks',async()=>{
    const f=await fixture(kind);const params={memberId:f.memberId,projectId:f.projectId,expectedRevision:f.revision(),kind:kind};
    const saved=await f.raw('member.setRuntime',params,'r136-default-bin');expect(saved.ok).toBe(true);
    expect((await f.raw('member.setRuntime',params,'r136-default-bin')).replayed).toBe(true);
    expect((await f.cmd<{binding:{executable:string}}>('member.runtime',{memberId:f.memberId})).binding.executable).toBe(runtimeExecutable(kind));
    expect((await f.raw('member.setRuntime',params)).error?.code).toBe('STALE_REVISION');
    expect((await f.raw('member.setRuntime',{...params,projectId:'wrong',expectedRevision:f.revision()})).error?.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('resolves the global executable alias when freezing an unbound member into coordination scope',async()=>{
    const f=await fixture(kind);const bin=runtimeExecutable(kind);
    writeFileSync(join(f.root,bin+'.cmd'),`@node "${f.executable}"`);vi.stubEnv('PATH',f.root+delimiter+(process.env.PATH??''));vi.stubEnv('ZS_RUNTIME',kind);
    const task=await f.send();
    const scope=f.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(task.taskId) as {roster_json:string};
    const own=(JSON.parse(scope.roster_json) as Array<{memberId:string;writeScope:string|null}>).find(m=>m.memberId===f.memberId)!;
    expect(own.writeScope).not.toBeNull();expect(JSON.parse(own.writeScope!)).toMatchObject({executionMode:'full',runtime:{kind,bound:false,model:null}});
    expect(f.db.prepare('SELECT 1 FROM real_calls').get()).toBeUndefined();
  });

  it('refuses new bindings under real dispatch guard and refuses existing/global bindings before constructing adapters',async()=>{
    const f=await fixture(kind);await f.bind();vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
    expect((await f.raw('member.setRuntime',{memberId:f.memberId,kind:kind,executable:f.executable})).error?.code).toBe('CAPABILITY_UNSUPPORTED');
    const factory=vi.fn(()=>new FakeRuntimeAdapter());
    const registry=new MemberRuntimeRegistry(f.db,new FakeRuntimeAdapter(),{[kind]:factory},{defaultKind:'fake',realDispatchGuard:true});
    expect(()=>registry.adapterFor(f.memberId)).toThrow(/验收防护/);expect(factory).not.toHaveBeenCalled();
    const unbound=(await f.cmd<{memberId:string}>('member.create',{projectId:f.projectId,displayName:'Unbound fixture'})).memberId;
    expect(()=>new MemberRuntimeRegistry(f.db,new FakeRuntimeAdapter(),{}, {defaultKind:kind,realDispatchGuard:true}).adapterFor(unbound)).toThrow(/全局默认/);
    expect(f.db.prepare('SELECT 1 FROM real_calls').get()).toBeUndefined();
  });

  it('freezes native full access and prevents execution after effective config or executable bytes change',async()=>{
    const f=await fixture(kind);await f.bind();writeFileSync(join(f.config,kind==='pi'?'settings.json':'settings.yaml'),'model: fixture-a');
    const task=await f.send();const before=effectiveTaskWriteAccess(f.db,task.taskId,f.memberId,'fake');
    expect(before).toMatchObject({fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],policyId:'policy-full-access'});
    expect(f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(task.taskId)).toEqual({write_scope_json:expect.stringContaining('"launchFingerprintVersion":3')});
    const roster=f.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(task.taskId) as {roster_json:string};
    const own=(JSON.parse(roster.roster_json) as Array<{memberId:string;writeScope:string}>).find(m=>m.memberId===f.memberId)!;
    expect(JSON.parse(own.writeScope)).toMatchObject({executionMode:'full',runtime:{kind:kind}});
    writeFileSync(join(f.config,kind==='pi'?'settings.json':'settings.yaml'),'model: fixture-b-longer');
    expect(()=>effectiveTaskWriteAccess(f.db,task.taskId,f.memberId,'fake')).toThrow(/配置已变化/);
    const next=await f.send();writeFileSync(f.executable,'throw Error("changed executable bytes must never execute");');
    expect(()=>effectiveTaskWriteAccess(f.db,next.taskId,f.memberId,'fake')).toThrow(/配置已变化/);
    expect(f.db.prepare('SELECT 1 FROM real_calls').get()).toBeUndefined();
  });

  it('invalidates a cached adapter when external launch configuration changes and disposes all instances',async()=>{
    const f=await fixture(kind);await f.bind();let disposed=0;
    class Disposable extends FakeRuntimeAdapter{async dispose(){disposed++;}}
    const factory=vi.fn(()=>new Disposable());const fallback=new FakeRuntimeAdapter();
    const registry=new MemberRuntimeRegistry(f.db,fallback,{[kind]:factory});
    const first=registry.adapterFor(f.memberId);expect(registry.adapterFor(f.memberId)).toBe(first);
    writeFileSync(join(f.config,kind==='pi'?'settings.json':'settings.yaml'),'model: changed');
    expect(registry.adapterFor(f.memberId)).not.toBe(first);expect(factory).toHaveBeenCalledTimes(2);
    expect((await registry.disposeAll()).failed).toEqual([]);expect(disposed).toBe(2);
  });

  it('dispatches an ordinary schema task using the frozen member channel and settles attributed usage in the ledger',async()=>{
    const f=await fixture(kind);await f.bind();const task=await f.send();let scope:OpenSessionInput|undefined;
    class Capture extends FakeRuntimeAdapter{override async openSession(input:OpenSessionInput){scope=input;return super.openSession(input);}}
    const adapter=wrapRealCallLedger(new Capture(),kind,f.db,'fixture-model');
    const registry=new MemberRuntimeRegistry(f.db,new FakeRuntimeAdapter(),{[kind]:()=>adapter},{defaultKind:'fake'});
    const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter(),adapterFor:id=>registry.adapterFor(id),leaseOwner:'r136-local',appDataDir:f.data,defaultProviderKey:'fake'});
    for(let n=0;n<8&&await worker.runOnce();n++);
    expect(scope?.writeAccess).toMatchObject({fullAccess:true,modificationAuthorized:true});
    const call=f.db.prepare('SELECT runtime_kind,member_id,task_id,model,status,turn_id FROM real_calls WHERE task_id=?').get(task.taskId) as {turn_id:string};
    expect(call).toMatchObject({runtime_kind:kind,member_id:f.memberId,task_id:task.taskId,model:'fixture-model',status:'succeeded'});
    expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(call.turn_id)).toEqual({status:'SUCCEEDED'});
    expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status!='released'").get()).toBeUndefined();
  });

  it('counts new-runtime calls before start, enforces batch cap, and forwards lifecycle and usage methods',async()=>{
    const f=await fixture(kind);vi.stubEnv('ZS_REAL_BATCH_DIR',join(f.root,'batch'));vi.stubEnv('ZS_REAL_BATCH_ID','r136-batch');vi.stubEnv('ZS_REAL_BATCH_CAP','1');
    class Counted extends FakeRuntimeAdapter{starts=0;closed=false;override async startTurn(ref:SessionRef,input:TurnRequest){this.starts++;return super.startTurn(ref,input);}async dispose(){this.closed=true;}}
    const raw=new Counted();const adapter=wrapRealCallLedger(raw,kind,f.db,'fixture-request');const ref=await adapter.openSession(session(f.project));
    await adapter.startTurn(ref,turn('r136-a'));expect(raw.starts).toBe(1);
    await expect(adapter.startTurn(ref,turn('r136-b'))).rejects.toThrow(/上限/);expect(raw.starts).toBe(1);
    recordRealCallUsage(f.db,'r136-a',{kind:'usage.updated',eventKey:'usage',sessionId:ref.id,turnId:'r136-a',receivedAt:1,accounting:'cumulative',inputTokens:8,outputTokens:3,costQuality:'unknown',model:'fixture-reported'});
    settleRealCall(f.db,'r136-a','succeeded','local fixture');
    expect(f.db.prepare('SELECT runtime_kind,model,response_model,status FROM real_calls').all()).toEqual([{runtime_kind:kind,model:'fixture-request',response_model:'fixture-reported',status:'succeeded'}]);
    await (adapter as Counted).dispose();expect(raw.closed).toBe(true);expect(adapter.processIdentity?.(ref,'r136-a')?.model).toBe('none');
  });

  it('wires both global and injected member factories through the real-call wrapper without spawning a provider',async()=>{
    const f=await fixture(kind);vi.stubEnv(kind==='pi'?'ZS_PI_MODEL':'ZS_DSH_MODEL','isolated-default');expect(defaultModelOf(kind)).toBe('isolated-default');
    const fallback=new FakeRuntimeAdapter(),memberAdapter=new FakeRuntimeAdapter(),factory=vi.fn(()=>memberAdapter);
    const daemon=await startDaemon({appDataDir:f.data,runtime:kind,testAdapter:fallback,testAdapterFactories:{[kind]:factory},pipeName:'r136-'+randomUUID(),tickMs:60000});
    try{
      const globalRef=await daemon.adapter.openSession(session(f.project));await daemon.adapter.startTurn(globalRef,turn('r136-global'));
      expect(daemon.db.prepare('SELECT runtime_kind,model FROM real_calls').all()).toEqual([{runtime_kind:kind,model:'isolated-default'}]);
      // Persist only this fixture's formal member configuration in the daemon's independent database.
      const cmd=async(method:string,params:unknown)=>{const r=await dispatchDaemonCommand({db:daemon.db,localUserId:'r136',appDataDir:f.data,interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params}) as Reply;if(!r.ok)throw Error(JSON.stringify(r.error));return r.data!;};
      const opened=await cmd('project.open',{path:f.project});const projectId=(opened.project as {id:string}).id;
      const created=await cmd('member.create',{projectId,displayName:'Injected Harness'});const memberId=created.memberId as string;
      await cmd('member.setRuntime',{memberId,kind:kind,executable:f.executable,model:'member-model'});
      const bound=daemon.memberRuntime.adapterFor(memberId);const ref=await bound.openSession(session(f.project));await bound.startTurn(ref,turn('r136-bound'));
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({kind:kind,model:'member-model'}));
      expect(daemon.db.prepare('SELECT model FROM real_calls WHERE turn_id=?').get('r136-bound')).toEqual({model:'member-model'});
    }finally{expect((await daemon.stop({force:true})).complete).toBe(true);}
  });

});

describe.each(['deepseek-harness','pi'] as const)('R136 %s worker with actual isolated local child processes',kind=>{
  it('no-result local CLI exit preserves UNKNOWN protection and never automatically retries',async()=>{
    const f=await processFixture('no-result',kind);try{
      const task=await f.send();await f.worker.runOnce();
      const call=f.db.prepare('SELECT runtime_kind,member_id,task_id,run_id,turn_id,status FROM real_calls WHERE task_id=?').get(task.taskId) as {run_id:string;turn_id:string};
      expect(call).toMatchObject({runtime_kind:kind,member_id:f.memberId,task_id:task.taskId,status:'unknown'});
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(call.turn_id)).toEqual({status:'UNKNOWN'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(call.run_id)).toEqual({status:'INTERRUPTED'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId)).not.toEqual({status:'DONE'});
      expect(f.db.prepare('SELECT 1 FROM task_deliveries WHERE task_id=?').get(task.taskId)).toBeUndefined();
      expect(f.db.prepare("SELECT 1 FROM agent_turns WHERE id=? AND protection_state='released'").get(call.turn_id)).toBeUndefined();
      expect(f.db.prepare("SELECT owner_turn_id FROM workspace_leases WHERE owner_turn_id=? AND status='active'").get(call.turn_id)).toEqual({owner_turn_id:call.turn_id});
      expect(f.db.prepare("SELECT 1 FROM domain_events WHERE turn_id=? AND kind='recovery.protectionReleased'").get(call.turn_id)).toBeUndefined();
      expect(f.db.prepare("SELECT payload_json FROM domain_events WHERE turn_id=? AND kind='turn.runtimeProcessExited'").get(call.turn_id)).toEqual({payload_json:expect.stringContaining('"expected":false')});
      expect(f.db.prepare("SELECT 1 FROM domain_events WHERE task_id=? AND kind='recovery.scheduled'").get(task.taskId)).toBeUndefined();
      expect(f.db.prepare("SELECT 1 FROM daemon_state WHERE key LIKE 'automatic-recovery:%'").get()).toBeUndefined();
      expect(await f.worker.runOnce()).toBe(false);
      expect(f.db.prepare('SELECT count(*) n FROM real_calls WHERE task_id=?').get(task.taskId)).toEqual({n:1});
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns WHERE run_id=?').get(call.run_id)).toEqual({n:1});
      const trace=readFileSync(f.executable+'.trace','utf8').trim().split('\n').map(line=>JSON.parse(line) as {type:string});
      expect(trace.map(row=>row.type)).toEqual(kind==='pi'?['set_auto_retry','set_auto_compaction','get_state','prompt']:['execute']);
      expect(f.children).toHaveLength(1);expect(f.children[0]!.exitCode).toBe(0);
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(call.turn_id)).toEqual({status:'UNKNOWN'});
      expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE owner_turn_id=? AND status='active'").get(call.turn_id)).toBeDefined();
    }finally{await f.close();}
  },30000);

  it('real local Harness child: formal task reaches DONE with correct resultKey, attributed ledger and confirmed process exit',async()=>{
    const f=await processFixture('success',kind);try{
      const task=await f.send();await f.worker.runOnce();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId)).toEqual({status:'DONE'});
      const call=f.db.prepare('SELECT runtime_kind,member_id,task_id,run_id,turn_id,model,response_model,status FROM real_calls WHERE task_id=?').get(task.taskId) as {turn_id:string;run_id:string};
      expect(call).toMatchObject({runtime_kind:kind,member_id:f.memberId,task_id:task.taskId,model:'fixture-model',response_model:'local-reported-model',status:'succeeded'});
      expect(f.db.prepare('SELECT status,member_id,run_id FROM agent_turns WHERE id=?').get(call.turn_id)).toEqual({status:'SUCCEEDED',member_id:f.memberId,run_id:call.run_id});
      expect(f.db.prepare('SELECT adapter_kind,process_model,pid FROM runtime_process_registry WHERE turn_id=?').get(call.turn_id)).toEqual({adapter_kind:kind,process_model:'per-turn',pid:f.children[0]!.pid});
      expect(f.children).toHaveLength(1);expect(f.children[0]!.exitCode).toBe(0);
      expect(f.db.prepare('SELECT 1 FROM task_deliveries WHERE task_id=?').get(task.taskId)).toBeDefined();
      const trace=readFileSync(f.executable+'.trace','utf8').trim().split('\n').map(line=>JSON.parse(line) as {type:string;cwd:string;message?:string;mode?:string;toolFree?:boolean;schema?:{properties:{resultKey:{const:string}}}});
      const request=trace.find(row=>row.type===(kind==='pi'?'prompt':'execute'))!;
      expect(request.cwd.toLowerCase()).toBe(f.project.toLowerCase());
      if(kind==='pi'){expect(request.message).toContain('resultKey');expect(request.toolFree).toBe(true);}
      else {expect(request.schema?.properties.resultKey.const).toBeTruthy();expect(request.mode).toBe('planning');}
      expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status!='released'").get()).toBeUndefined();
    }finally{await f.close();}
  },30000);

  it('real local Harness child: wrong resultKey fails the turn and ledger without creating delivery',async()=>{
    const f=await processFixture('wrong-key',kind);try{
      const task=await f.send();await f.worker.runOnce();
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE run_id IN(SELECT id FROM workflow_runs WHERE task_id=?)').get(task.taskId)).toEqual({status:'FAILED'});
      expect(f.db.prepare('SELECT status,runtime_kind,member_id,task_id FROM real_calls WHERE task_id=?').get(task.taskId)).toEqual({status:'failed',runtime_kind:kind,member_id:f.memberId,task_id:task.taskId});
      expect(f.db.prepare('SELECT 1 FROM task_deliveries WHERE task_id=?').get(task.taskId)).toBeUndefined();
      expect(f.db.prepare("SELECT payload_json FROM domain_events WHERE task_id=? AND kind='turn.outputInvalid'").get(task.taskId)).toEqual({payload_json:expect.stringContaining('resultKey 不匹配')});
      expect(f.children[0]!.exitCode).toBe(0);expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status!='released'").get()).toBeUndefined();
    }finally{await f.close();}
  },30000);

  it('real local Harness child: formal stop sends cancel, confirms exit, settles interrupted ledger and releases lease',async()=>{
    const f=await processFixture('hang',kind);let running:Promise<boolean>|undefined;try{
      const task=await f.send();running=f.worker.runOnce();
      await vi.waitFor(()=>expect(f.db.prepare('SELECT response_model FROM real_calls WHERE task_id=?').get(task.taskId)).toEqual({response_model:'local-reported-model'}),{timeout:20000,interval:25});
      const call=f.db.prepare('SELECT run_id,turn_id FROM real_calls WHERE task_id=?').get(task.taskId) as {run_id:string;turn_id:string};
      const stop=await dispatchDaemonCommand({db:f.db,localUserId:'r136',appDataDir:f.data,interruptTurn:id=>f.worker.interruptTurn(id)},{protocolVersion:1,commandId:randomUUID(),method:'task.stop',params:{taskId:task.taskId,targetRunId:call.run_id,expectedStopGeneration:0}});
      expect(stop).toMatchObject({ok:true});await running;
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(call.turn_id)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare('SELECT status FROM real_calls WHERE task_id=?').get(task.taskId)).toEqual({status:'interrupted'});
      const trace=readFileSync(f.executable+'.trace','utf8').trim().split('\n').map(line=>JSON.parse(line) as {type:string});expect(trace.map(row=>row.type)).toEqual(kind==='pi'?['set_auto_retry','set_auto_compaction','get_state','prompt','abort']:['execute','cancel']);
      expect(f.children[0]!.exitCode).toBe(0);expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE status!='released'").get()).toBeUndefined();
    }finally{await f.close();await running;}
  },30000);
});
