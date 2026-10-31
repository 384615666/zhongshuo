import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarnessAdapter } from '../../src/adapter/deepseekHarness/adapter.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, RuntimeAdapter, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

const fixture = fileURLToPath(new URL('../fixtures/externalRuntimeR136.mjs', import.meta.url));
const adapters: DeepSeekHarnessAdapter[] = [];
const input = (threadId = 'thread'): OpenSessionInput => ({projectId:'p',memberId:'m',taskId:'t',threadId,sessionGeneration:0,cwd:process.cwd(),policyId:'policy-full',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[process.cwd()],identityKey:'test'}});
const request = (text = '中文🙂\n$() `touch` & literal'): TurnRequest => ({turnId:'turn',dispatchKey:'dispatch',inputBundleId:'bundle',text,policyId:'policy-full',taskRevision:0});
function adapter(scenario = 'success', observe?: (args: string[]) => void) {
  const result = new DeepSeekHarnessAdapter({executable:process.execPath,model:'deepseek/test',spawnFn:(_command,args,cwd)=>{
    observe?.(args);return spawn(process.execPath,[fixture,scenario,...args],{cwd,stdio:'pipe',windowsHide:true});
  }});adapters.push(result);return result;
}
async function terminal(adapter: RuntimeAdapter, session: SessionRef) {
  const collected: NormalizedRuntimeEvent[] = [];
  const iterator = adapter.events(session)[Symbol.asyncIterator]();
  const timer = setTimeout(()=>{},5000);
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(),new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(Error('no terminal')),4000).unref())]);
      if(next.done)throw Error('closed without terminal');collected.push(next.value);
      if(next.value.kind==='turn.completed'||next.value.kind==='turn.failed'||next.value.kind==='process.exited')return collected;
    }
  } finally {clearTimeout(timer);await iterator.return?.();}
}
afterEach(async()=>{for(const item of adapters.splice(0))await item.disposeAll();});
describe('DeepSeek Harness structured profile and actual child lifecycle',()=>{
  it('preserves long stdin prompts, standing instructions, tool facts and reported usage',async()=>{
    let argv:string[]=[];const a=adapter('success',args=>{argv=args;});const s=await a.openSession({...input(),developerInstructions:'长期指令\n保留原文'});
    const prompt=request('中文🙂\n$() `literal` & '+ 'x'.repeat(70000));await a.startTurn(s,prompt);const events=await terminal(a,s);
    expect(argv).toEqual(['--profile','zhongshuo','--zs-stdio']);
    const done=events.find(e=>e.kind==='turn.completed');expect(done?.kind).toBe('turn.completed');
    if(done?.kind==='turn.completed')expect(JSON.parse(done.finalText!)).toMatchObject({prompt:prompt.text,developer:'长期指令\n保留原文'});
    expect(events.some(e=>e.kind==='tool.started'&&e.action==='read')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private body');expect(JSON.stringify(events)).not.toContain('sk-not-recorded');
    expect(events.find(e=>e.kind==='usage.updated')).toMatchObject({inputTokens:12,cachedTokens:5,outputTokens:3,costQuality:'unknown',model:'fixture-model'});
    expect(await a.waitForTurnExit(s,'turn',3000)).toMatchObject({exitConfirmed:true});
  });
  it('cold resumes the exact provider session and separates a new task',async()=>{
    const a=adapter();const first=await a.openSession(input());await a.startTurn(first,request());await terminal(a,first);await a.close(first);
    const resumed=await a.openSession({...input(),resume:first});await a.startTurn(resumed,request('followup'));await terminal(a,resumed);await a.close(resumed);
    const other=await a.openSession(input('other'));await a.startTurn(other,request());await terminal(a,other);
    expect(resumed.providerSessionId).toBe(first.providerSessionId);expect(other.providerSessionId).not.toBe(first.providerSessionId);
  });
  it('rejects a resume from a different conversation before spawning',async()=>{
    const a=adapter();const prior=await a.openSession(input());prior.providerSessionId='provider-session';
    await expect(a.openSession({...input('another'),resume:prior})).rejects.toMatchObject({code:'THREAD_SCOPE_MISMATCH',notStarted:true});
  });
  it.each(['malformed','wrong-request','wrong-session','truncated','empty','failure'])('does not manufacture completion for %s',async scenario=>{
    const a=adapter(scenario);const s=await a.openSession({...input(),...(scenario==='wrong-session'?{resume:{...input(),id:'old',providerSessionId:'expected',runtimeInstallationId:'test',adapterVersion:'test',threadId:'thread',sessionGeneration:0,cwd:process.cwd()}}:{})});
    await a.startTurn(s,request());const events=await terminal(a,s);expect(events.some(e=>e.kind==='turn.completed')).toBe(false);expect(events.at(-1)?.kind).toBe('turn.failed');
    if(scenario==='failure')expect(events.at(-1)).toMatchObject({code:'AUTH_REQUIRED',failureEvidence:{source:'provider-terminal'}});
  });
  it('preserves unknown outcome when the child exits without a provider terminal',async()=>{
    const a=adapter('no-result'),s=await a.openSession(input());await a.startTurn(s,request());const events=await terminal(a,s);
    expect(events.at(-1)).toMatchObject({kind:'process.exited',expected:false});expect(events.some(e=>e.kind==='turn.failed'||e.kind==='turn.completed')).toBe(false);
  });
  it('records every conflicting reported identity so DM reconciliation cannot claim native resume',async()=>{
    const a=adapter('conflicting-session'),s=await a.openSession(input());await a.startTurn(s,request());const events=await terminal(a,s);
    expect(events.at(-1)).toMatchObject({kind:'turn.failed',code:'OUTPUT_INVALID'});expect(s.observedSessionIds).toHaveLength(2);
    expect(s.observedSessionIds?.at(-1)).toBe('second-session');expect(s.providerSessionId).toBe('second-session');
  });
  it('cancels a running turn and confirms its actual child exit',async()=>{
    const a=adapter('hang');const s=await a.openSession(input());await a.startTurn(s,request());
    const iterator=a.events(s)[Symbol.asyncIterator]();expect((await iterator.next()).value).toMatchObject({kind:'session.ready'});await iterator.return?.(undefined);
    await a.interrupt(s,'different-turn');expect((await a.waitForTurnExit(s,'turn',20))?.exitConfirmed).toBe(false);
    await a.interrupt(s,'turn');const events=await terminal(a,s);expect(events.at(-1)).toMatchObject({kind:'turn.failed',code:'INTERRUPTED'});
    expect(await a.waitForTurnExit(s,'turn',3000)).toMatchObject({exitConfirmed:true});
  });
  it('honors cancellation during the handshake without executing the prompt',async()=>{
    const a=adapter('slow-ready');const s=await a.openSession(input());await a.startTurn(s,request());await a.interrupt(s,'turn');
    const events=await terminal(a,s);expect(events.some(e=>e.kind==='turn.started')).toBe(false);expect(events.at(-1)).toMatchObject({kind:'turn.failed',code:'INTERRUPTED'});
  });
  it('rejects unsupported scopes, images and malformed repair requests before starting any child',async()=>{
    let calls=0;const a=adapter('success',()=>{calls++;});const readOnly=await a.openSession({...input(),writeAccess:undefined});
    await expect(a.startTurn(readOnly,request())).rejects.toMatchObject({code:'CAPABILITY_UNSUPPORTED',notStarted:true});
    const full=await a.openSession(input());await expect(a.startTurn(full,{...request(),repairOnly:true})).rejects.toMatchObject({notStarted:true});
    await expect(a.startTurn(full,{...request(),images:[{artifactId:'a',hash:'h',mime:'image/png',dataBase64:'AA=='}]})).rejects.toMatchObject({notStarted:true});
    expect(calls).toBe(0);
  });
  it('carries the result schema and confines repair to the separate tool-free mode',async()=>{
    const a=adapter(),s=await a.openSession({...input(),writeAccess:undefined});
    const outputSchema={type:'object',properties:{resultKey:{const:'result-original'}}};
    await a.startTurn(s,{...request(),repairOnly:true,outputSchema});
    const events=await terminal(a,s),done=events.find(e=>e.kind==='turn.completed');
    expect(done?.kind).toBe('turn.completed');
    if(done?.kind==='turn.completed')expect(JSON.parse(done.finalText!)).toMatchObject({mode:'format-repair',outputSchema});
    expect(events.some(e=>e.kind==='tool.started'||e.kind==='tool.completed')).toBe(false);
  });
  it.each([false,true])('blocks outdated plugins before submitting a structured request (repair=%s)',async repairOnly=>{
    const a=adapter('old-plugin'),s=await a.openSession(input());
    await a.startTurn(s,{...request(),repairOnly,outputSchema:{type:'object'}});
    const events=await terminal(a,s);
    expect(events.at(-1)).toMatchObject({kind:'turn.failed',code:'CAPABILITY_UNSUPPORTED'});
    expect(events.some(e=>e.kind==='turn.started'||e.kind==='session.ready')).toBe(false);
    expect(await a.waitForTurnExit(s,'turn',3000)).toMatchObject({exitConfirmed:true});
  });
  it('rejects tool events during format repair without accepting completion',async()=>{
    const a=adapter('repair-tool'),s=await a.openSession(input());
    await a.startTurn(s,{...request(),repairOnly:true,outputSchema:{type:'object'}});
    const events=await terminal(a,s);
    expect(events.at(-1)).toMatchObject({kind:'turn.failed',code:'OUTPUT_INVALID'});
    expect(events.some(e=>e.kind==='turn.completed'||e.kind==='tool.started')).toBe(false);
  });
  it('requires a fresh session for repair instead of replaying pending provider work',async()=>{
    let calls=0;const a=adapter('success',()=>{calls++;});
    const previous=await a.openSession(input());previous.providerSessionId='original-session';
    const s=await a.openSession({...input(),resume:previous});
    await expect(a.startTurn(s,{...request(),repairOnly:true,outputSchema:{type:'object'}})).rejects.toMatchObject({code:'VALIDATION_INVALID',notStarted:true});
    expect(calls).toBe(0);
  });
});
