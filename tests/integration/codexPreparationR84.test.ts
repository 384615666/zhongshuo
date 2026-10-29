import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {createCodexConfigurationPreparation} from '../../src/daemon/prepareCodexConfiguration.ts';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import {effectiveTaskWriteAccess} from '../../src/daemon/projectWriteAccess.ts';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllEnvs();});
const initializedTrust=(project:string)=>`model_provider="own"\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`;
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
  it.each(['model','provider','mcp','permission','environment','existing-trust'])('rejects %s drift during preparation instead of freezing the changed configuration',async field=>{
    const f=await fixture();try{
      if(field==='existing-trust')writeFileSync(join(f.config,'config.toml'),initializedTrust(f.project).replace('"trusted"','"untrusted"'));
      const original=f.open.getMockImplementation()!;
      f.open.mockImplementation(async input=>{
        if(field==='environment')vi.stubEnv('OPENAI_PREPARATION_FIXTURE','changed');
        else if(field==='permission')await f.cmd('member.setRuntime',{memberId:f.memberId,kind:'codex',model:'gpt-6.1-sol',permissionMode:'plan'});
        else writeFileSync(join(f.config,'config.toml'),field==='mcp'?'model_provider="own"\n[mcp_servers.changed]\ncommand="changed"\n':field==='provider'?'model_provider="different"\n':field==='existing-trust'?initializedTrust(f.project):'model_provider="own"\nmodel="changed"\n');
        return original(input);
      });
      expect(await f.raw('message.submit',f.params,randomUUID(),true)).toMatchObject({ok:false,error:{code:'CONFIGURATION_NOT_READY'}});
      expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n:0});
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:0});expect(f.start).not.toHaveBeenCalled();
      expect(CodexAppServerAdapter.prototype.dispose).toHaveBeenCalledTimes(1);
    }finally{f.db.close();}
  });
  it('checks configuration after dispose as well as open/close',async()=>{
    const f=await fixture();try{
      vi.mocked(CodexAppServerAdapter.prototype.dispose).mockImplementation(async()=>{writeFileSync(join(f.config,'config.toml'),'model_provider="changed-during-dispose"\n');});
      expect(await f.raw('message.submit',f.params,randomUUID(),true)).toMatchObject({ok:false,error:{code:'CONFIGURATION_NOT_READY'}});
      expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:0});expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('prepares an explicitly retried 0-run Codex DM before freezing its new execution, preserving the old scope',async()=>{
    const f=await fixture();try{
      const conversationId=(await f.cmd('conversation.create',{projectId:f.projectId,peerMemberId:f.memberId,title:'未派发恢复'})).conversationId as string;
      const sent=await f.raw('message.submit',{target:{kind:'dm',projectId:f.projectId,conversationId},body:'只处理当前原消息',intent:'default',mentions:[]});
      const taskId=sent.data.taskId as string;
      const scope=f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(taskId);
      f.db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id=?").run(taskId);
      f.db.prepare("UPDATE outbox SET status='done' WHERE dispatch_key=?").run(`dmtask:${taskId}:initial`);
      f.db.prepare(`INSERT INTO domain_events(event_id,schema_version,project_id,conversation_id,task_id,kind,payload_json,created_at) VALUES(?,1,?,?,?,'task.contextAssemblyFailed',?,0)`).run(randomUUID(),f.projectId,conversationId,taskId,JSON.stringify({reason:'write-authorization-changed',message:'有效执行配置已变化'}));
      const original=f.open.getMockImplementation()!;
      f.open.mockImplementation(async input=>{writeFileSync(join(f.config,'config.toml'),initializedTrust(f.project));return original(input);});
      const id=randomUUID(),retry=await f.raw('task.redispatch',{taskId,reason:'manual-dm-continue'},id,true);
      expect(retry.ok,JSON.stringify(retry)).toBe(true);
      expect(f.open).toHaveBeenCalledTimes(1);expect(f.start).not.toHaveBeenCalled();
      expect(f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(taskId)).toEqual(scope);
      const execution=JSON.parse((f.db.prepare("SELECT payload_json FROM domain_events WHERE task_id=? AND kind='task.redispatchEnqueued'").get(taskId) as {payload_json:string}).payload_json) as {execution:{writeScope:string}};
      expect(JSON.parse(execution.execution.writeScope)).toMatchObject({launchFingerprintVersion:3});
      await f.raw('task.redispatch',{taskId,reason:'manual-dm-continue'},id,true);expect(f.open).toHaveBeenCalledTimes(1);
    }finally{f.db.close();}
  });
  it.each(['open','close','dispose'])('bounds a hung %s without saving intent or starting a model',async phase=>{
    const f=await fixture();try{
      vi.useFakeTimers();
      const never=new Promise<never>(()=>{});
      if(phase==='open')f.open.mockReturnValue(never);
      else vi.mocked(CodexAppServerAdapter.prototype[phase as 'close'|'dispose']).mockReturnValue(never);
      const pending=f.raw('message.submit',f.params,randomUUID(),true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toMatchObject({ok:false,error:{code:'CONFIGURATION_NOT_READY'}});
      expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:0});expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('rechecks earlier prepared members if a later member changes global configuration',async()=>{
    const f=await fixture();try{
      const second=(await f.cmd('member.create',{projectId:f.projectId,displayName:'第二成员'})).memberId as string;
      await f.cmd('member.setRuntime',{memberId:second,kind:'codex',model:'gpt-6-sol',permissionMode:'bypassPermissions'});
      let n=0;
      const prepare=async(memberId:string,projectId:string)=>{
        if(++n===2)writeFileSync(join(f.config,'config.toml'),'model_provider="changed-before-second-prepare"\n');
        return await f.prepare(memberId,projectId);
      };
      const r=await dispatchDaemonCommand({db:f.db,localUserId:'u_local',interruptTurn:async()=>{},prepareRuntimeConfiguration:prepare},{protocolVersion:1,commandId:randomUUID(),method:'message.submit',params:{...f.params,mentions:[f.memberId,second].map(memberId=>({kind:'member',memberId}))}});
      expect(r).toMatchObject({ok:false,error:{code:'CONFIGURATION_NOT_READY'}});
      expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:0});expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it.each(['room','dm'])('rejects configuration drift after the verified preparation returns its proof, target=%s',async target=>{
    const f=await fixture();try{
      let taskId:string|undefined;
      if(target==='dm'){
        const conversationId=(await f.cmd('conversation.create',{projectId:f.projectId,peerMemberId:f.memberId,title:'准备后变化'})).conversationId as string;
        taskId=(await f.raw('message.submit',{target:{kind:'dm',projectId:f.projectId,conversationId},body:'原消息保留',intent:'default',mentions:[]})).data.taskId as string;
        f.db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id=?").run(taskId);
        f.db.prepare("UPDATE outbox SET status='done' WHERE dispatch_key=?").run(`dmtask:${taskId}:initial`);
        f.db.prepare(`INSERT INTO domain_events(event_id,schema_version,project_id,conversation_id,task_id,kind,payload_json,created_at) VALUES(?,1,?,?,?,'task.contextAssemblyFailed',?,0)`).run(randomUUID(),f.projectId,conversationId,taskId,JSON.stringify({message:'有效执行配置已变化'}));
      }
      const messages=f.db.prepare('SELECT count(*) n FROM messages').get(),tasks=f.db.prepare('SELECT count(*) n FROM tasks').get();
      const prepare=async(memberId:string,projectId:string)=>{
        const receipt=await f.prepare(memberId,projectId);
        writeFileSync(join(f.config,'config.toml'),'model_provider="changed-after-proof"\n');
        return receipt;
      };
      const r=await dispatchDaemonCommand({db:f.db,localUserId:'u_local',interruptTurn:async()=>{},prepareRuntimeConfiguration:prepare},{protocolVersion:1,commandId:randomUUID(),method:target==='dm'?'task.redispatch':'message.submit',params:target==='dm'?{taskId,reason:'manual-dm-continue'}:f.params});
      expect(r).toMatchObject({ok:false,error:{code:'CONFIGURATION_NOT_READY'}});
      expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual(tasks);expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual(messages);
      expect(f.db.prepare("SELECT 1 FROM domain_events WHERE kind='task.redispatchEnqueued'").get()).toBeUndefined();expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('AUTO prepares the complete eligible Codex roster before freezing any parent or child scope',async()=>{
    const f=await fixture();try{
      const second=(await f.cmd('member.create',{projectId:f.projectId,displayName:'独立成员'})).memberId as string;
      await f.cmd('member.setRuntime',{memberId:second,kind:'codex',model:'gpt-6-sol',permissionMode:'bypassPermissions'});
      const roomId=f.params.target.roomId,revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(roomId) as {revision:number}).revision;
      await f.cmd('room.update',{roomId,expectedRevision:revision,coordinatorMemberId:f.memberId});
      f.open.mockImplementation(async input=>{writeFileSync(join(f.config,'config.toml'),initializedTrust(f.project));return{id:'own-'+input.memberId,providerSessionId:'metadata',runtimeInstallationId:'own',adapterVersion:'fixture',threadId:input.threadId,sessionGeneration:0,cwd:input.cwd};});
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
  it('reopening a project never silently adds a removed member back into the AUTO room roster',async()=>{
    const f=await fixture();try{
      const roomId=f.params.target.roomId,coordinator=f.memberId,revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(roomId) as {revision:number}).revision;
      await f.cmd('room.update',{roomId,expectedRevision:revision,coordinatorMemberId:coordinator});
      const removed=(f.db.prepare('SELECT member_id FROM room_members WHERE room_id=? AND member_id!=? LIMIT 1').get(roomId,coordinator) as {member_id:string}).member_id;
      await f.cmd('room.members.set',{roomId,memberId:removed,action:'remove'});
      await f.cmd('project.open',{path:f.project});await f.cmd('project.open',{path:f.project});
      expect(f.db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND member_id=?').get(roomId,removed)).toBeUndefined();
      const sent=await f.raw('message.submit',{...f.params,mentions:[]},randomUUID(),true);expect(sent.ok).toBe(true);
      const scope=f.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(sent.data.taskId) as {roster_json:string};
      expect((JSON.parse(scope.roster_json) as Array<{memberId:string}>).map(m=>m.memberId)).not.toContain(removed);expect(f.start).not.toHaveBeenCalled();
      await f.cmd('room.members.set',{roomId,memberId:removed,action:'add'});await f.cmd('project.open',{path:f.project});expect(f.db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND member_id=?').get(roomId,removed)).toBeDefined();
    }finally{f.db.close();}
  });
  it('opening an archived room never backfills a newly created member into its preserved roster',async()=>{
    const f=await fixture();try{
      const roomId=f.params.target.roomId,revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(roomId) as {revision:number}).revision;
      const before=f.db.prepare('SELECT member_id FROM room_members WHERE room_id=? ORDER BY member_id').all(roomId);
      await f.cmd('room.archive',{roomId,expectedRevision:revision,action:'archive'});
      const added=(await f.cmd('member.create',{projectId:f.projectId,displayName:'归档后新成员'})).memberId;
      await f.cmd('project.open',{path:f.project});
      expect(f.db.prepare('SELECT member_id FROM room_members WHERE room_id=? ORDER BY member_id').all(roomId)).toEqual(before);
      expect(f.db.prepare('SELECT 1 FROM room_members WHERE room_id=? AND member_id=?').get(roomId,added)).toBeUndefined();expect(f.start).not.toHaveBeenCalled();
    }finally{f.db.close();}
  });
  it('trust initialization precedes new durable scope; old queued snapshot remains unchanged and invalid',async()=>{
    const f=await fixture();try{
      const old=(await f.raw('message.submit',f.params)).data.taskId as string;const scope=f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(old);
      f.open.mockImplementation(async input=>{writeFileSync(join(f.config,'config.toml'),initializedTrust(f.project));return{id:'own',providerSessionId:'metadata',runtimeInstallationId:'own',adapterVersion:'fixture',threadId:input.threadId,sessionGeneration:0,cwd:input.cwd};});
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
