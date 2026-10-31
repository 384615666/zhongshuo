import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveAgentExecutable } from '../../src/adapter/cli/executable.ts';
import { externalRuntimeLaunchIdentity } from '../../src/adapter/cli/configuration.ts';
import { DeepSeekHarnessAdapter } from '../../src/adapter/deepseekHarness/adapter.ts';
import { memberExecutableStatus } from '../../src/daemon/memberManagement.ts';

const dirs:string[]=[];
const directory=()=>{const path=mkdtempSync(join(tmpdir(),'zs-r137-install-'));dirs.push(path);return path;};
function desktop(){
  const root=directory(),executable=join(root,'DeepSeek Harness.exe'),archive=join(root,'resources','app.asar'),bin=join(root,'resources','runtime','cli','bin');
  mkdirSync(bin,{recursive:true});writeFileSync(executable,'fixture exe');writeFileSync(archive,'fixture archive');
  const shim=join(bin,'dsh.cmd');writeFileSync(shim,'@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\nexit /b %errorlevel%\r\n');
  return{root,executable,archive,bin,shim};
}
afterEach(()=>{vi.unstubAllEnvs();for(const path of dirs.splice(0))rmSync(path,{recursive:true,force:true});});
describe('official Windows installer launchers',()=>{
  it('decodes Harness Desktop as Electron Node mode with a real ASAR identity',()=>{
    const f=desktop(),entry=resolveAgentExecutable('deepseek-harness',f.shim);
    expect(entry).toEqual({command:f.executable,prefixArgs:['--expose-internals',join(f.archive,'dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js')],env:{ELECTRON_RUN_AS_NODE:'1'},integrityFiles:[f.shim,f.archive]});
    expect(memberExecutableStatus('deepseek-harness',f.shim).status).toBe('found');
    expect(resolveAgentExecutable('deepseek-harness',f.executable)).toMatchObject({command:f.executable,env:{ELECTRON_RUN_AS_NODE:'1'},integrityFiles:[f.archive]});
    const before=externalRuntimeLaunchIdentity('deepseek-harness',{executable:f.shim},f.root);writeFileSync(f.archive,'updated fixture archive');
    expect(externalRuntimeLaunchIdentity('deepseek-harness',{executable:f.shim},f.root).identityKey).not.toBe(before.identityKey);
  });
  it('rejects a desktop shim whose virtual script is outside the recognized app layout',()=>{
    const f=desktop();const text='@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0other\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\n';
    writeFileSync(f.shim,text);expect(()=>resolveAgentExecutable('deepseek-harness',f.shim)).toThrow('资源目录不一致');
  });
  it('prioritizes the Windows Pi launcher over the Unix shim and retains the dp0 separator',()=>{
    const dir=directory(),script=join(dir,'pi-launcher.js');writeFileSync(script,'// fixture');writeFileSync(join(dir,'pi'),'#!/bin/sh\n');
    writeFileSync(join(dir,'pi.cmd'),'@echo off\r\n"%node%" "%~dp0pi-launcher.js" %*\r\n');vi.stubEnv('PATH',dir+delimiter+(process.env.PATH??''));
    expect(resolveAgentExecutable('pi')).toEqual({command:process.execPath,prefixArgs:[script]});
    expect(memberExecutableStatus('pi','pi').status).toBe('found');
  });
  it('passes desktop launch environment through the managed spawn boundary without mutating the host environment',async()=>{
    const f=desktop();let captured:NodeJS.ProcessEnv|undefined;
    const a=new DeepSeekHarnessAdapter({executable:f.shim,spawnFn:(_cmd,_args,_cwd,env)=>{
      captured=env;const child=new EventEmitter() as EventEmitter & {stdin:PassThrough;stdout:PassThrough;stderr:PassThrough;pid:number;kill:()=>boolean};
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.pid=123;child.kill=()=>true;
      child.stdin.on('data',chunk=>{const r=JSON.parse(String(chunk)) as {requestId:string};queueMicrotask(()=>{
        child.stdout.write(JSON.stringify({v:1,type:'session',requestId:r.requestId,sessionId:'fixture',resumed:false})+'\n');
        child.stdout.write(JSON.stringify({v:1,type:'result',requestId:r.requestId,sessionId:'fixture',status:'completed',text:'fixture'})+'\n');child.emit('close',0);
      });});
      queueMicrotask(()=>child.stdout.write(JSON.stringify({v:1,type:'ready',runtime:'zhongshuo-dsh',protocol:1,capabilities:{structuredEvents:true,sessionResume:true,sessionCancel:true}})+'\n'));
      return child as unknown as ChildProcessWithoutNullStreams;
    }});
    vi.stubEnv('ELECTRON_RUN_AS_NODE',undefined);
    const session=await a.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd:f.root,policyId:'full',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'test'}});
    await a.startTurn(session,{turnId:'turn',dispatchKey:'d',inputBundleId:'b',text:'fixture',policyId:'full',taskRevision:0});
    for await(const event of a.events(session))if(event.kind==='turn.completed')break;
    expect(captured?.ELECTRON_RUN_AS_NODE).toBe('1');expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();await a.disposeAll();
  });
});
