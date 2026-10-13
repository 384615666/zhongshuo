import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startDaemon } from '../../src/daemon/entry.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { CodexAppServerAdapter, resolveCodexInvocation } from '../../src/adapter/codex/appServerAdapter.ts';
import { memberExecutableStatus } from '../../src/daemon/memberManagement.ts';

afterEach(()=>vi.unstubAllEnvs());
describe('R81 explicit program references, zero process/model calls',()=>{
  it('actual production Codex factory receives member reference and model; explicit missing reference never selects PATH default',async()=>{
    vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_REAL_DISPATCH_GUARD',undefined);
    const root=mkdtempSync(join(tmpdir(),'zs-r81-reference-'));
    const daemon=await startDaemon({appDataDir:join(root,'data'),runtime:'fake',pipeName:String.raw`\\.\pipe\r81-${randomUUID()}`,localUserId:'u_local',tickMs:10000});
    try{
      const cmd=async(method:string,params:unknown)=>{const r=await dispatchDaemonCommand({db:daemon.db,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:`r81-${randomUUID()}`,method,params}) as {ok:boolean;data:{project:{id:string};memberId:string};error?:{message:string}};if(!r.ok)throw Error(r.error?.message);return r.data;};
      const cwd=join(root,'project');mkdirSync(cwd);const p=(await cmd('project.open',{path:cwd})).project.id;
      const memberId=(await cmd('member.create',{projectId:p,displayName:'Codex引用'})).memberId;
      const executable=join(root,'missing-codex.exe');await cmd('member.setRuntime',{memberId,kind:'codex',executable,model:'gpt-6-luna',permissionMode:'plan'});
      const actual=daemon.memberRuntime.adapterFor(memberId) as unknown as {options:{executable:string;model:string;sandboxMode:string}};
      expect(actual.options.executable).toBe(executable);expect(actual.options.model).toBe('gpt-6-luna');expect(actual.options.sandboxMode).toBe('read-only');
      expect(memberExecutableStatus('codex',executable).status).toBe('missing');
      expect((daemon.db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c).toBe(0);
    }finally{expect((await daemon.stop()).complete).toBe(true);}
  });
  it('formal adapter spawning receives exact explicit script/native program, with no session or model request executed',async()=>{
    const root=mkdtempSync(join(tmpdir(),'zs-r81-program-'));const script=join(root,'工程 codex.js');writeFileSync(script,'// must never execute');
    for(const executable of [script,join(root,'missing-codex.exe')]){
      const spawn=vi.fn(()=>{throw Error('R81_STOP_BEFORE_PROCESS_CREATION');});
      const adapter=new CodexAppServerAdapter({executable,model:'gpt-6-luna',spawnFn:spawn});
      await expect(adapter.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',cwd:root,sessionGeneration:0,policyId:'p'})).rejects.toThrow('R81_STOP_BEFORE_PROCESS_CREATION');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]).toEqual(executable===script?[process.execPath,[script,'app-server']]:[executable,['app-server']]);
    }
  });
  it('missing explicit shim cannot fall through to adjacent installed npm script; Claude native default lookup shares the real resolver',()=>{
    const root=mkdtempSync(join(tmpdir(),'zs-r81-resolve-'));
    const appData=join(root,'appdata'),npm=join(appData,'npm'),bin=join(npm,'node_modules/@openai/codex/bin');mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'codex.js'),'// engineering only');
    expect(()=>resolveCodexInvocation(join(npm,'missing.cmd'))).toThrow('不回落');
    const shim=join(npm,'codex.cmd');writeFileSync(shim,'@echo off\nnode "%~dp0node_modules/@openai/codex/bin/codex.js"');
    expect(resolveCodexInvocation(shim).identityPath).toBe(join(bin,'codex.js'));
    const native=join(npm,'node_modules/@anthropic-ai/claude-code/bin/claude.exe');mkdirSync(join(native,'..'),{recursive:true});writeFileSync(native,'// reference lookup only, never executed');
    vi.stubEnv('APPDATA',appData);vi.stubEnv('PATH',join(root,'empty-path'));
    expect(memberExecutableStatus('claude','claude').status).toBe('found');
  });
});
