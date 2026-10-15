import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {createCodexConfigurationPreparation} from '../../src/daemon/prepareCodexConfiguration.ts';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import {effectiveTaskWriteAccess} from '../../src/daemon/projectWriteAccess.ts';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'zs-r84-preparation-')),project=join(root,'project'),config=join(root,'config');mkdirSync(project);mkdirSync(config);writeFileSync(join(config,'config.toml'),'model_provider="own"\n');vi.stubEnv('CODEX_HOME',config);
  const db=openDatabase(join(root,'state.sqlite')),deps={db,localUserId:'u_local',interruptTurn:async()=>{}};
  const raw=async(method:string,params:unknown,id=randomUUID(),prepared=false)=>await dispatchDaemonCommand({...deps,...(prepared?{prepareRuntimeConfiguration:prepare}:{})},{protocolVersion:1,commandId:id,method,params}) as {ok:boolean;data:Record<string,unknown>;error?:{code:string}};
  const cmd=async(method:string,params:unknown)=>{const r=await raw(method,params);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data;};
  const projectId=((await cmd('project.open',{path:project})).project as {id:string}).id;
  const memberId=(await cmd('member.create',{projectId,displayName:'Codex'})).memberId as string;
  await cmd('member.setRuntime',{memberId,kind:'codex',model:'gpt-6.1-sol',permissionMode:'bypassPermissions'});
  const room=((await cmd('room.list',{projectId})).items as Array<{id:string;conversationId:string}>)[0]!;
  const params={target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'合成问题',intent:'default',mentions:[{kind:'member',memberId}]};
  const prepare=createCodexConfigurationPreparation(db);
  vi.spyOn(CodexAppServerAdapter.prototype,'close').mockResolvedValue();vi.spyOn(CodexAppServerAdapter.prototype,'dispose').mockResolvedValue();
  const start=vi.spyOn(CodexAppServerAdapter.prototype,'startTurn').mockRejectedValue(Error('must never start inference'));
  const open=vi.spyOn(CodexAppServerAdapter.prototype,'openSession').mockImplementation(async input=>({id:'own-preflight',providerSessionId:'metadata-only',runtimeInstallationId:'own',adapterVersion:'fixture',threadId:input.threadId,sessionGeneration:0,cwd:input.cwd}));
  return{db,project,projectId,memberId,config,prepare,raw,cmd,params,open,start};
}
describe('R84 Codex new-intent configuration preparation, isolated adapter fixture, zero processes/models',()=>{
  it('AUTO prepares the complete eligible Codex roster before freezing any parent or child scope',async()=>{
    const f=await fixture();try{
      const second=(await f.cmd('member.create',{projectId:f.projectId,displayName:'独立成员'})).memberId as string;
      await f.cmd('member.setRuntime',{memberId:second,kind:'codex',model:'gpt-6-sol',permissionMode:'bypassPermissions'});
      const roomId=f.params.target.roomId,revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(roomId) as {revision:number}).revision;
      await f.cmd('room.update',{roomId,expectedRevision:revision,coordinatorMemberId:f.memberId});
      f.open.mockImplementation(async input=>{writeFileSync(join(f.config,'config.toml'),'model_provider="own"\n[projects.synthetic]\ntrust_level="trusted"\n');return{id:'own-'+input.memberId,providerSessionId:'metadata',runtimeInstallationId:'own',adapterVersion:'fixture',threadId:input.threadId,sessionGeneration:0,cwd:input.cwd};});
      const id=randomUUID(),r=await f.raw('message.submit',{...f.params,mentions:[]},id,true);expect(r.ok,JSON.stringify(r)).toBe(true);
      expect(f.open.mock.calls.map(call=>call[0].memberId).sort()).toEqual([f.memberId,second].sort());expect(f.start).not.toHaveBeenCalled();
      const taskId=r.data.taskId as string,roster=JSON.parse((f.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(taskId) as {roster_json:string}).roster_json) as Array<{memberId:string;writeScope:string|null}>;
      for(const memberId of [f.memberId,second])expect(effectiveTaskWriteAccess(f.db,taskId,memberId,null,roster.find(m=>m.memberId===memberId)!.writeScope!).fullAccess).toBe(true);
      await f.raw('message.submit',{...f.params,mentions:[]},id,true);expect(f.open).toHaveBeenCalledTimes(2);
      const before=f.open.mock.calls.length;expect((await f.raw('message.submit',{...f.params,mentions:[],intent:'record_only'},randomUUID(),true)).ok).toBe(true);expect(f.open).toHaveBeenCalledTimes(before);
      writeFileSync(join(f.config,'config.toml'),'model_provider="changed"\n');expect(()=>effectiveTaskWriteAccess(f.db,taskId,f.memberId,null)).toThrow('有效执行配置已变化');
    }finally{f.db.close();}
  });
  it('AUTO refuses a roster change during metadata preparation before saving input or calling a model',async()=>{
    const f=await fixture();try{
      const roomId=f.params.target.roomId,revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(roomId) as {revision:number}).revision;
      await f.cmd('room.update',{roomId,expectedRevision:revision,coordinatorMemberId:f.memberId});
      const original=f.open.getMockImplementation()!;
      f.open.mockImplementation(async input=>{await f.cmd('member.create',{projectId:f.projectId,displayName:'途中新增'});return original(input);});
      expect(await f.raw('message.submit',{...f.params,mentions:[]},randomUUID(),true)).toMatchObject({ok:false,error:{code:'CONFIGURATION_NOT_READY'}});
      expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0});expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:0});expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('selected deliberation prepares only selected eligible room members, not another configured member',async()=>{
    const f=await fixture();try{
      const ids=[f.memberId];for(const name of ['选中','不选中']){const id=(await f.cmd('member.create',{projectId:f.projectId,displayName:name})).memberId as string;await f.cmd('member.setRuntime',{memberId:id,kind:'codex',model:'gpt-6-sol',permissionMode:'bypassPermissions'});ids.push(id);}
      const r=await f.raw('message.submit',{...f.params,mentions:ids.slice(0,2).map(memberId=>({kind:'member',memberId}))},randomUUID(),true);
      expect(r.ok,JSON.stringify(r)).toBe(true);expect(f.open.mock.calls.map(call=>call[0].memberId).sort()).toEqual(ids.slice(0,2).sort());expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('archiving the original room while preparing rejects input without retargeting or model calls',async()=>{
    const f=await fixture();try{
      const original=f.open.getMockImplementation()!;f.open.mockImplementation(async input=>{const roomId=f.params.target.roomId,revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(roomId) as {revision:number}).revision;await f.cmd('room.archive',{roomId,expectedRevision:revision,action:'archive'});return original(input);});
      expect(await f.raw('message.submit',f.params,randomUUID(),true)).toMatchObject({ok:false,error:{code:'CONVERSATION_UNAVAILABLE'}});expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0});expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('trust initialization precedes new durable scope; old queued snapshot remains unchanged and invalid',async()=>{
    const f=await fixture();try{
      const old=(await f.raw('message.submit',f.params)).data.taskId as string;const scope=f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(old);
      f.open.mockImplementation(async input=>{writeFileSync(join(f.config,'config.toml'),'model_provider="own"\n[projects.synthetic]\ntrust_level="trusted"\n');return{id:'own',providerSessionId:'metadata',runtimeInstallationId:'own',adapterVersion:'fixture',threadId:input.threadId,sessionGeneration:0,cwd:input.cwd};});
      const id=randomUUID(),fresh=await f.raw('message.submit',f.params,id,true);expect(fresh.ok).toBe(true);
      expect(f.open.mock.calls[0]![0].cwd).toBe(f.project);expect(f.open.mock.calls[0]![0].policyId).toBe('configuration-preparation');expect(f.open.mock.calls[0]![0].writeAccess).toMatchObject({fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[]});expect(f.start).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(old)).toEqual(scope);expect(()=>effectiveTaskWriteAccess(f.db,old,f.memberId,null)).toThrow('有效执行配置已变化');expect(effectiveTaskWriteAccess(f.db,fresh.data.taskId as string,f.memberId,null).fullAccess).toBe(true);
      await f.raw('message.submit',f.params,id,true);expect(f.open).toHaveBeenCalledTimes(1);
      writeFileSync(join(f.config,'config.toml'),'model_provider="different"\n');expect(()=>effectiveTaskWriteAccess(f.db,fresh.data.taskId as string,f.memberId,null)).toThrow('有效执行配置已变化');expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('same actual target/configuration preparation coalesces in flight, disposes, and does not cache future readiness',async()=>{
    const f=await fixture();try{
      let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});f.open.mockImplementation(async input=>{await gate;return{id:'own',providerSessionId:'metadata',runtimeInstallationId:'own',adapterVersion:'fixture',threadId:input.threadId,sessionGeneration:0,cwd:input.cwd};});
      const a=f.prepare(f.memberId,f.projectId),b=f.prepare(f.memberId,f.projectId);expect(f.open).toHaveBeenCalledTimes(1);finish();await Promise.all([a,b]);await f.prepare(f.memberId,f.projectId);expect(f.open).toHaveBeenCalledTimes(2);expect(f.start).not.toHaveBeenCalled();expect(CodexAppServerAdapter.prototype.dispose).toHaveBeenCalledTimes(2);
    }finally{f.db.close();}
  });
  it.each(['provider','permission','mcp','current-trust'])('%s changes remain guarded after preparation, including queued scopes',async field=>{
    const f=await fixture();try{
      const result=await f.raw('message.submit',f.params,randomUUID(),true);expect(result.ok).toBe(true);
      const taskId=result.data.taskId as string,before=f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(taskId);
      if(field==='permission')await f.cmd('member.setRuntime',{memberId:f.memberId,kind:'codex',model:'gpt-6.1-sol',permissionMode:'plan'});
      else writeFileSync(join(f.config,'config.toml'),field==='provider'?'model_provider="changed"\n':field==='mcp'?'model_provider="own"\n[mcp_servers.synthetic]\ncommand="changed"\n':'model_provider="own"\n[projects.synthetic]\ntrust_level="untrusted"\n');
      expect(()=>effectiveTaskWriteAccess(f.db,taskId,f.memberId,null)).toThrow(/配置已变化/);expect(f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(taskId)).toEqual(before);expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it.each(['plan','scoped'])('metadata preparation preserves actual %s permission and does not promote it to full access',async mode=>{
    const f=await fixture();try{
      await f.cmd('member.setRuntime',{memberId:f.memberId,kind:'codex',model:'gpt-6.1-sol',permissionMode:mode==='plan'?'plan':'acceptEdits'});
      if(mode==='scoped')await f.cmd('project.writeAccess.set',{projectId:f.projectId,expectedRevision:0,authorized:true});
      await f.prepare(f.memberId,f.projectId);expect(f.open.mock.calls[0]![0].writeAccess).toMatchObject({fullAccess:false,modificationAuthorized:mode==='scoped',allowedWriteRoots:mode==='scoped'?[f.project]:[]});expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('grant revocation while preparing rejects before freezing a business intent',async()=>{
    const f=await fixture();try{
      await f.cmd('member.setRuntime',{memberId:f.memberId,kind:'codex',model:'gpt-6.1-sol',permissionMode:'acceptEdits'});await f.cmd('project.writeAccess.set',{projectId:f.projectId,expectedRevision:0,authorized:true});
      const original=f.open.getMockImplementation()!;f.open.mockImplementation(async input=>{await f.cmd('project.writeAccess.set',{projectId:f.projectId,expectedRevision:1,authorized:false});return original(input);});
      expect(await f.raw('message.submit',f.params,randomUUID(),true)).toMatchObject({ok:false,error:{code:'CONFIGURATION_NOT_READY'}});expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:0});expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('preparation timeout/rejection saves no intent and record-only never initializes a session',async()=>{
    const f=await fixture();try{
      f.open.mockRejectedValue(Error('isolated metadata timeout'));const r=await f.raw('message.submit',f.params,randomUUID(),true);expect(r).toMatchObject({ok:false,error:{code:'CONFIGURATION_NOT_READY'}});expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0});expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:0});
      expect((await f.raw('message.submit',{...f.params,intent:'record_only'},randomUUID(),true)).ok).toBe(true);expect(f.open).toHaveBeenCalledTimes(1);expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
});
