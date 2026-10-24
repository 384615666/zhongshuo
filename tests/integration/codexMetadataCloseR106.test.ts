import {afterEach,describe,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';

afterEach(()=>vi.useRealTimers());
describe('R106 metadata initialization requires bounded confirmed child closure',()=>{
  it('does not treat sending a kill signal as confirmed exit, and retains the child for cleanup',async()=>{
    vi.useFakeTimers();
    const child=Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null,kill:vi.fn(()=>true)});
    const adapter=new CodexAppServerAdapter({requireConfirmedClose:true});
    const owned=adapter as unknown as {child:ChildProcessWithoutNullStreams|null};
    owned.child=child as unknown as ChildProcessWithoutNullStreams;
    const failed=expect(adapter.dispose()).rejects.toThrow('尚未确认关闭');
    await vi.advanceTimersByTimeAsync(5_001);await failed;
    expect(owned.child).toBe(child);expect(child.kill).toHaveBeenCalledTimes(1);
    child.exitCode=0;
    await adapter.dispose();expect(owned.child).toBeNull();
  });
  it('accepts an actual close event, without waiting out the timeout',async()=>{
    vi.useFakeTimers();
    const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill:vi.fn(()=>true)});
    const adapter=new CodexAppServerAdapter({requireConfirmedClose:true});
    (adapter as unknown as {child:ChildProcessWithoutNullStreams}).child=child as unknown as ChildProcessWithoutNullStreams;
    const closing=adapter.dispose();child.emit('close',0);await closing;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('opens and closes only a local replay thread with zero turn/start protocol calls',async()=>{
    const root=mkdtempSync(join(tmpdir(),'zs-r106-metadata-close-'));
    const scenario=join(root,'scenario.json'),log=join(root,'rpc.jsonl');writeFileSync(scenario,JSON.stringify({turns:[]}));
    const adapter=new CodexAppServerAdapter({cwd:root,requireConfirmedClose:true,requestTimeoutMs:3_000,mockEntry:{executable:resolve('tests/fixtures/mockAppServer.mjs'),args:[scenario,log]}});
    try{
      const session=await adapter.openSession({projectId:'p',memberId:'m',taskId:'configuration-preparation',threadId:'configuration-preparation',sessionGeneration:0,cwd:root,policyId:'configuration-preparation'});
      await adapter.close(session);await adapter.dispose();
      const methods=readFileSync(log,'utf8').trim().split('\n').map(line=>(JSON.parse(line) as {method?:string}).method);
      expect(methods).toContain('thread/start');expect(methods).not.toContain('turn/start');
    }finally{await adapter.dispose();rmSync(root,{recursive:true,force:true});}
  });
});
