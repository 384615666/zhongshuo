import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../../src/adapter/pi/adapter.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, RuntimeAdapter, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';
const fixture=fileURLToPath(new URL('../fixtures/piRuntimeR136.mjs',import.meta.url));
const roots:string[]=[],adapters:PiAdapter[]=[];
function directory(){const path=mkdtempSync(join(tmpdir(),'zs-pi-r136-'));roots.push(path);return path;}
function input(cwd:string):OpenSessionInput{return{projectId:'p',memberId:'m',taskId:'t',threadId:'thread',sessionGeneration:0,cwd,policyId:'full',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'test'}};}
const request=(text='中文🙂\n$() literal'):TurnRequest=>({turnId:'turn',dispatchKey:'dispatch',inputBundleId:'bundle',text,policyId:'full',taskRevision:0});
function adapter(cwd:string,scenario='success',observe?:(args:string[])=>void){
  const sessionDir=join(cwd,'sessions');mkdirSync(sessionDir,{recursive:true});
  const a=new PiAdapter({executable:process.execPath,sessionDir,spawnFn:(_cmd,args,root)=>{observe?.(args);return spawn(process.execPath,[fixture,scenario,...args],{cwd:root,stdio:'pipe',windowsHide:true});}});adapters.push(a);return a;
}
async function terminal(a:RuntimeAdapter,s:SessionRef){const events:NormalizedRuntimeEvent[]=[];for await(const event of a.events(s)){events.push(event);if(event.kind==='turn.completed'||event.kind==='turn.failed'||event.kind==='process.exited')return events;}throw Error('no terminal');}
afterEach(async()=>{for(const a of adapters.splice(0))await a.disposeAll();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('Pi native RPC adapter lifecycle',()=>{
  it('sends the full prompt through stdin and standing instructions through a native system file',async()=>{
    const cwd=directory();let argv:string[]=[];const a=adapter(cwd,'success',args=>{argv=args;});const s=await a.openSession({...input(cwd),developerInstructions:'保持角色\n独立指令'});
    const r=request('中文🙂\n\u2028\u2029 $() & '+ 'x'.repeat(70000));await a.startTurn(s,r);const events=await terminal(a,s);
    const end=events.at(-1);expect(end?.kind).toBe('turn.completed');if(end?.kind==='turn.completed')expect(JSON.parse(end.finalText!)).toMatchObject({prompt:r.text,developer:'保持角色\n独立指令'});
    expect(argv).not.toContain(r.text);expect(argv).toContain('--append-system-prompt');
    expect(events.find(event=>event.kind==='tool.started')).toMatchObject({action:'read',toolCallId:'tool'});
    expect(events.find(event=>event.kind==='usage.updated')).toMatchObject({inputTokens:10,cachedTokens:3,outputTokens:5});
    const system=argv[argv.indexOf('--append-system-prompt')+1]!;await a.close(s);expect(()=>readFileSync(system)).toThrow();
  });
  it('resumes an exact native session, refusing a missing or changed session header before spawn',async()=>{
    const cwd=directory();let count=0;const a=adapter(cwd,'success',()=>{count++;});const s=await a.openSession(input(cwd));await a.startTurn(s,request());await terminal(a,s);await a.close(s);
    const resumed=await a.openSession({...input(cwd),resume:s});await a.startTurn(resumed,request());await terminal(a,resumed);await a.close(resumed);expect(resumed.providerSessionId).toBe(s.providerSessionId);
    const path=join(cwd,'sessions',`${s.providerSessionId}.jsonl`);writeFileSync(path,JSON.stringify({type:'session',id:s.providerSessionId,cwd:directory()})+'\n');
    const wrong=await a.openSession({...input(cwd),resume:s});await expect(a.startTurn(wrong,request())).rejects.toMatchObject({code:'THREAD_SCOPE_MISMATCH',notStarted:true});
    rmSync(path);const missing=await a.openSession({...input(cwd),resume:s});await expect(a.startTurn(missing,request())).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND',notStarted:true});expect(count).toBe(2);
  });
  it('waits through a retry after agent_end until agent_settled and a successful final assistant',async()=>{
    const cwd=directory(),a=adapter(cwd,'retry'),s=await a.openSession(input(cwd));await a.startTurn(s,request());const events=await terminal(a,s);expect(events.at(-1)?.kind).toBe('turn.completed');expect(events.filter(e=>e.kind==='turn.completed')).toHaveLength(1);
  });
  it.each(['error','truncated','wrong-session','malformed','dialog'])('does not accept %s as task completion',async scenario=>{
    const cwd=directory(),a=adapter(cwd,scenario),s=await a.openSession(input(cwd));await a.startTurn(s,request());const events=await terminal(a,s);expect(events.at(-1)?.kind).toBe('turn.failed');expect(events.some(e=>e.kind==='turn.completed')).toBe(false);
  });
  it.each(['ack-only','end-only'])('leaves %s without a known outcome for worker reconciliation',async scenario=>{
    const cwd=directory(),a=adapter(cwd,scenario),s=await a.openSession(input(cwd));await a.startTurn(s,request());const events=await terminal(a,s);
    expect(events.at(-1)).toMatchObject({kind:'process.exited',expected:false});expect(events.some(e=>e.kind==='turn.completed'||e.kind==='turn.failed')).toBe(false);
  });
  it('sends abort for the exact turn and confirms process exit',async()=>{
    const cwd=directory(),a=adapter(cwd,'hang'),s=await a.openSession(input(cwd));await a.startTurn(s,request());
    for await(const event of a.events(s)){if(event.kind==='turn.started')break;}
    await a.interrupt(s,'other');expect((await a.waitForTurnExit(s,'turn',20))?.exitConfirmed).toBe(false);
    await a.interrupt(s,'turn');expect((await terminal(a,s)).at(-1)).toMatchObject({kind:'turn.failed',code:'INTERRUPTED'});expect(await a.waitForTurnExit(s,'turn',3000)).toMatchObject({exitConfirmed:true});
  });
});
