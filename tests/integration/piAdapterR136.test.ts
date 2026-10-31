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
  const executable=join(cwd,'pi-fixture.cjs');writeFileSync(executable,`setTimeout(()=>console.log('${scenario==='old-version'?'1.3.0':'1.4.0'}'),${scenario==='slow-version'?250:0});`);
  const a=new PiAdapter({executable,sessionDir,spawnFn:(_cmd,args,root)=>{const flags=args.slice(1);observe?.(flags);return spawn(process.execPath,[fixture,scenario,...flags],{cwd:root,stdio:'pipe',windowsHide:true});}});adapters.push(a);return a;
}
async function terminal(a:RuntimeAdapter,s:SessionRef,turnId='turn'){const events:NormalizedRuntimeEvent[]=[];for await(const event of a.events(s)){if(event.turnId!==turnId)continue;events.push(event);if(event.kind==='turn.completed'||event.kind==='turn.failed'||event.kind==='process.exited')return events;}throw Error('no terminal');}
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
  it('adds the complete current schema to native instructions, including on the next turn',async()=>{
    const cwd=directory(),a=adapter(cwd),s=await a.openSession({...input(cwd),developerInstructions:'保留常驻指令'});
    for(const key of ['original-result','next-result']){
      const outputSchema={type:'object',properties:{resultKey:{const:key}}};
      await a.startTurn(s,{...request(),turnId:key,outputSchema});const done=(await terminal(a,s,key)).at(-1);
      expect(done?.kind).toBe('turn.completed');
      if(done?.kind==='turn.completed')expect(JSON.parse(done.finalText!).developer).toContain(JSON.stringify(outputSchema));
      expect(await a.waitForTurnExit(s,key,3000)).toMatchObject({exitConfirmed:true});
    }
  });
  it('repairs only in a fresh, tool-free session with a replacement system prompt',async()=>{
    const cwd=directory();let flags:string[]=[];const a=adapter(cwd,'success',args=>{flags=args;});
    const s=await a.openSession({...input(cwd),writeAccess:undefined,developerInstructions:'不要把原执行指令带入补交'});
    const outputSchema={type:'object',properties:{resultKey:{const:'source-key'}}};
    await a.startTurn(s,{...request(),repairOnly:true,outputSchema});const events=await terminal(a,s);
    expect(events.at(-1)?.kind).toBe('turn.completed');
    expect(events.some(e=>e.kind==='tool.started'||e.kind==='tool.completed')).toBe(false);
    expect(flags).toEqual(expect.arrayContaining(['--no-tools','--exclude-tools','*','--no-extensions','--no-mcp','--no-context-files','--no-skills','--no-prompt-templates','--no-approve','--system-prompt']));
    const done=events.at(-1);if(done?.kind==='turn.completed'){
      const value=JSON.parse(done.finalText!);expect(value.system).toContain(JSON.stringify(outputSchema));
      expect(value.system).toContain('FORMAT-ONLY REPAIR');expect(value.system).not.toContain('不要把原执行指令带入补交');expect(value.developer).toBeNull();
    }
  });
  it.each(['repair-tool','repair-tool-call','repair-setup-failed','dirty-repair'])('never completes unsafe repair: %s',async scenario=>{
    const cwd=directory(),a=adapter(cwd,scenario),s=await a.openSession(input(cwd));
    await a.startTurn(s,{...request(),repairOnly:true,outputSchema:{type:'object'}});const events=await terminal(a,s);
    expect(events.at(-1)?.kind).toBe('turn.failed');expect(events.some(e=>e.kind==='turn.completed'||e.kind==='tool.started')).toBe(false);
  });
  it('refuses repairs with missing schema, a resumed session or an uncertified CLI version',async()=>{
    const cwd=directory();let calls=0;const a=adapter(cwd,'old-version',()=>{calls++;}),s=await a.openSession(input(cwd));
    await expect(a.startTurn(s,{...request(),repairOnly:true})).rejects.toMatchObject({code:'VALIDATION_INVALID',notStarted:true});
    await expect(a.startTurn(s,{...request(),repairOnly:true,outputSchema:{type:'object'}})).rejects.toMatchObject({code:'CAPABILITY_UNSUPPORTED',notStarted:true});
    s.providerSessionId='00000000-0000-0000-0000-000000000001';const resumed=await a.openSession({...input(cwd),resume:s});
    await expect(a.startTurn(resumed,{...request(),repairOnly:true,outputSchema:{type:'object'}})).rejects.toMatchObject({code:'VALIDATION_INVALID',notStarted:true});
    expect(calls).toBe(0);
  });
  it('honors stop during version validation without starting task execution',async()=>{
    const cwd=directory();let calls=0;const a=adapter(cwd,'slow-version',()=>{calls++;}),s=await a.openSession(input(cwd));
    const started=a.startTurn(s,{...request(),repairOnly:true,outputSchema:{type:'object'}});
    await a.interrupt(s,'turn');await expect(started).rejects.toMatchObject({code:'STALE_EXECUTION',notStarted:true});expect(calls).toBe(0);
  });
});
