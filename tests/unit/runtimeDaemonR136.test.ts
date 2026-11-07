import {afterEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {DeepSeekHarnessAdapter} from '../../src/adapter/deepseekHarness/adapter.ts';
import {PiAdapter} from '../../src/adapter/pi/adapter.ts';
import {runtimeExecutable} from '../../src/contracts/runtimeKinds.ts';
import * as bridge from '../../src/daemon/managed/bridge.ts';
import {startDaemon} from '../../src/daemon/entry.ts';
import {runtimeOptions} from '../../src/daemon/runtimeOptions.ts';
import {runtimeCatalog} from '../../src/daemon/runtimeCatalog.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {openDatabase} from '../../src/persistence/db.ts';
import {runtimeChannelPatch} from '../../src/contracts/runtimeSelection.ts';
import {fileWriteCapability} from '../../src/adapter/writeCapability.ts';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'zs-r136-daemon-unit-'));const executable=join(root,'never-run.cjs');
  writeFileSync(executable,'throw Error("fixture must never execute");');
  vi.stubEnv('ZS_MANAGED_RUNTIME',undefined);vi.stubEnv('ZS_REAL_BATCH_ID',undefined);vi.stubEnv('ZS_REAL_DISPATCH_GUARD',undefined);
  vi.stubEnv('ZS_DSH_MODEL',undefined);vi.stubEnv('ZS_PI_MODEL',undefined);vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  vi.stubEnv('DSH_HOME',join(root,'config'));vi.stubEnv('PI_CODING_AGENT_DIR',join(root,'config'));vi.stubEnv('CODEX_HOME',join(root,'config'));vi.stubEnv('CLAUDE_CONFIG_DIR',join(root,'config'));
  return{root,executable};
}

describe.each(['deepseek-harness','pi'] as const)('R136 daemon %s metadata, no provider calls',kind=>{
  const Adapter=kind==='pi'?PiAdapter:DeepSeekHarnessAdapter;
  it('uses reported model efforts through both formal metadata commands, keeping image input automatic',async()=>{
    const f=fixture();const listed=vi.spyOn(Adapter.prototype,'listModels').mockResolvedValue([{id:'fixture-model',label:'Fixture',efforts:['low','high']}]);
    const starts=vi.spyOn(Adapter.prototype,'startTurn').mockRejectedValue(Error('inference must never start'));
    expect(runtimeChannelPatch(kind)).toEqual({kind:kind,executable:runtimeExecutable(kind),model:null,effort:null});
    // R194：所有 AI 都能看图——元数据里图片输入恒 automatic，不再按模型/渠道声明 unsupported。
    expect(await runtimeOptions(kind,f.executable,'fixture-model',f.root)).toMatchObject({efforts:['low','high'],imageInput:'automatic'});
    vi.stubEnv(kind==='pi'?'ZS_PI_MODEL':'ZS_DSH_MODEL','fixture-model');
    expect(await runtimeCatalog(kind,f.executable,f.root)).toMatchObject({kind:kind,defaultModel:'fixture-model',models:[{id:'fixture-model',label:'Fixture',source:'reported'}]});
    const db=openDatabase(':memory:');
    try{
      const cmd=async(method:string,params:unknown)=>dispatchDaemonCommand({db,localUserId:'r136',appDataDir:f.root,interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params});
      const opened=await cmd('project.open',{path:f.root}) as {data:{project:{id:string}}};const projectId=opened.data.project.id;
      expect(await cmd('member.runtimeOptions',{projectId,kind:kind,executable:f.executable,model:'fixture-model'})).toMatchObject({ok:true,data:{efforts:['low','high'],imageInput:'automatic'}});
      expect(await cmd('member.runtimeCatalog',{projectId,kind:kind,executable:f.executable})).toMatchObject({ok:true,data:{kind:kind,models:[{id:'fixture-model',label:'Fixture',source:'reported'}]}});
      expect(db.prepare('SELECT 1 FROM real_calls').get()).toBeUndefined();
    }finally{db.close();}
    expect(listed).toHaveBeenCalledTimes(4);expect(starts).not.toHaveBeenCalled();
    expect(fileWriteCapability({kind:kind,model:null,executable:f.executable,permissionMode:'bypassPermissions'},f.root).status).toBe('unverified');
    expect(fileWriteCapability({kind:kind,model:null,executable:f.executable,permissionMode:'plan'},f.root).status).toBe('unsupported');
  });

  it('does not manufacture metadata for a missing executable and preserves metadata failures',async()=>{
    const f=fixture();const list=vi.spyOn(Adapter.prototype,'listModels').mockRejectedValue(Error('fixture metadata unavailable'));
    expect(await runtimeCatalog(kind,join(f.root,'missing.cjs'),f.root)).toMatchObject({program:{status:'missing'},models:[]});expect(list).not.toHaveBeenCalled();
    await expect(runtimeOptions(kind,f.executable,undefined,f.root)).rejects.toThrow('fixture metadata unavailable');
  });

});

describe.each(['deepseek-harness','pi'] as const)('R136 daemon %s managed production channel plumbing, no provider calls',kind=>{
  it('injects the managed spawn into both global and member production adapters with the real executable and project cwd',async()=>{
    const f=fixture();const data=join(f.root,'data');mkdirSync(data);vi.stubEnv('ZS_MANAGED_RUNTIME','1');
    vi.spyOn(bridge,'managedBridgeAvailable').mockReturnValue({ok:true});
    vi.spyOn(bridge,'disposeAllManagedJobs').mockReturnValue([]);
    writeFileSync(join(f.root,runtimeExecutable(kind)+'.cmd'),`@node "${f.executable}"`);
    vi.stubEnv('PATH',f.root+delimiter+(process.env.PATH??''));
    const spawn=vi.spyOn(bridge,'spawnManagedBridge').mockImplementation((_command,args)=>{
      void _command;
      const child=new EventEmitter() as EventEmitter & {stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;pid:number;managedJobId:string;kill:()=>boolean};
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=987654321;child.managedJobId='r136-mock-job';child.kill=()=>true;
      child.stdin.on('data',(bytes:Buffer)=>{
        const request=JSON.parse(bytes.toString()) as {type:string;requestId:string;id:string};
        if(kind==='pi'&&request.type==='get_state')queueMicrotask(()=>child.stdout.write(JSON.stringify({type:'response',id:request.id,command:'get_state',success:true,data:{sessionId:args[args.indexOf('--session-id')+1],sessionFile:join(args[args.indexOf('--session-dir')+1]!,args[args.indexOf('--session-id')+1]+'.jsonl'),isStreaming:false,pendingMessageCount:0}})+'\n'));
        if(kind==='pi'&&request.type==='prompt')queueMicrotask(()=>{
          child.stdout.write(JSON.stringify({type:'response',id:request.id,command:'prompt',success:true,data:{}})+'\n');
          child.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'local protocol fixture'}]}})+'\n');
          child.stdout.write(JSON.stringify({type:'agent_settled',aborted:false})+'\n');child.emit('close',0);
        });
        if(request.type==='execute')queueMicrotask(()=>{
          child.stdout.write(JSON.stringify({v:1,type:'session',requestId:request.requestId,sessionId:'r136-session',resumed:false})+'\n');
          child.stdout.write(JSON.stringify({v:1,type:'result',requestId:request.requestId,status:'completed',text:'local protocol fixture'})+'\n');
          child.emit('close',0);
        });
      });
      if(kind==='deepseek-harness')queueMicrotask(()=>child.stdout.write(JSON.stringify({v:1,type:'ready',runtime:'zhongshuo-dsh',protocol:1,capabilities:{structuredEvents:true,sessionResume:true,sessionCancel:true,privateSessions:true}})+'\n'));
      return child as unknown as ReturnType<typeof bridge.spawnManagedBridge>;
    });
    const daemon=await startDaemon({appDataDir:data,runtime:kind,pipeName:'r136-managed-'+randomUUID(),tickMs:60000});
    try{
      const globalRef=await daemon.adapter.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd:f.root,policyId:'full',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'local'}});
      await daemon.adapter.startTurn(globalRef,{turnId:'managed-global',dispatchKey:'k',inputBundleId:'b',text:'local fixture',policyId:'full',taskRevision:0});
      const launchOptions=kind==='pi'?{cwd:f.root}:expect.objectContaining({cwd:f.root,env:expect.objectContaining({ZHONGSHUO_DSH_PRIVATE_SESSIONS:'1'})});
      expect(spawn).toHaveBeenCalledWith(expect.any(String),expect.arrayContaining(kind==='pi'?['--mode','rpc','--offline']:['--profile','zhongshuo','--zs-stdio']),launchOptions);
      const raw=async(method:string,params:unknown)=>{const r=await dispatchDaemonCommand({db:daemon.db,localUserId:'r136',appDataDir:data,interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:Record<string,unknown>;error?:unknown};if(!r.ok)throw Error(JSON.stringify(r.error));return r.data;};
      const opened=await raw('project.open',{path:f.root});const projectId=(opened.project as {id:string}).id;
      const made=await raw('member.create',{projectId,displayName:'Managed Harness'});const memberId=made.memberId as string;
      await raw('member.setRuntime',{memberId,kind:kind,executable:f.executable});
      const adapter=daemon.memberRuntime.adapterFor(memberId);
      const ref=await adapter.openSession({projectId,memberId,taskId:'t',threadId:'th',sessionGeneration:0,cwd:f.root,policyId:'full',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'local'}});
      await adapter.startTurn(ref,{turnId:'managed-member',dispatchKey:'k',inputBundleId:'b',text:'local fixture',policyId:'full',taskRevision:0});
      expect(spawn).toHaveBeenLastCalledWith(process.execPath,kind==='pi'?expect.arrayContaining([f.executable,'--mode','rpc','--offline']):[f.executable,'--profile','zhongshuo','--zs-stdio'],launchOptions);
      expect(adapter.processIdentity?.(ref,'managed-member')).toMatchObject({model:'per-turn',pid:987654321,managedJobId:'r136-mock-job'});
      expect(daemon.db.prepare('SELECT runtime_kind FROM real_calls ORDER BY id').all()).toEqual([{runtime_kind:kind},{runtime_kind:kind}]);
      expect(spawn).toHaveBeenCalledTimes(2);
      // The fake bridge exposes only streams/events; it never starts an OS process.
      expect((spawn.mock.results[0]!.value as ChildProcessWithoutNullStreams).pid).toBe(987654321);
    }finally{await daemon.stop({force:true});}
  });
});
