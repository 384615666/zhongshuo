import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarnessAdapter } from '../../src/adapter/deepseekHarness/adapter.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, RuntimeAdapter, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

const fixture = fileURLToPath(new URL('../fixtures/externalRuntimeR136.mjs', import.meta.url));
const adapters: DeepSeekHarnessAdapter[] = [];
const input = (threadId = 'thread'): OpenSessionInput => ({projectId:'p',memberId:'m',taskId:'t',threadId,sessionGeneration:0,cwd:process.cwd(),policyId:'policy-full',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[process.cwd()],identityKey:'test'}});
const request = (text = '中文🙂\n$() `touch` & literal'): TurnRequest => ({turnId:'turn',dispatchKey:'dispatch',inputBundleId:'bundle',text,policyId:'policy-full',taskRevision:0});
function adapter(scenario = 'success', observe?: (args: string[], env?: NodeJS.ProcessEnv) => void, requestTimeoutMs?: number) {
  const result = new DeepSeekHarnessAdapter({executable:process.execPath,model:'deepseek/test',requestTimeoutMs,spawnFn:(_command,args,cwd,env)=>{
    observe?.(args,env);return spawn(process.execPath,[fixture,scenario,...args],{cwd,env,stdio:'pipe',windowsHide:true});
  }});adapters.push(result);return result;
}
async function terminal(adapter: RuntimeAdapter, session: SessionRef, timeoutMs = 4000) {
  const collected: NormalizedRuntimeEvent[] = [];
  const iterator = adapter.events(session)[Symbol.asyncIterator]();
  const timer = setTimeout(()=>{},5000);
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(),new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(Error('no terminal')),timeoutMs).unref())]);
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
    expect(first.providerSessionId).toMatch(/^zhongshuo-session-/);
  });
  it('requires private storage support before sending a new request to an older component',async()=>{
    const a=adapter('shared-history-plugin'),s=await a.openSession(input());
    await a.startTurn(s,request());const events=await terminal(a,s);
    expect(events.at(-1)).toMatchObject({kind:'turn.failed',code:'CAPABILITY_UNSUPPORTED',message:expect.stringContaining('setup.cmd')});
    expect(events.some(event=>event.kind==='session.ready'||event.kind==='turn.started')).toBe(false);
  });
  it('continues an existing shared-history session with its exact ID and original storage',async()=>{
    let storageMode:string|undefined;
    const a=adapter('shared-history-plugin',(_args,env)=>{storageMode=env?.ZHONGSHUO_DSH_PRIVATE_SESSIONS;}),prior=await a.openSession(input());
    const s=await a.openSession({...input(),resume:{...prior,providerSessionId:'session-existing-history'}});
    await a.startTurn(s,request('continue existing'));const events=await terminal(a,s);
    expect(events.at(-1)?.kind).toBe('turn.completed');expect(s.providerSessionId).toBe('session-existing-history');
    expect(storageMode).toBe('0');
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
  it('allows the native composition to take over ten seconds before ready without declaring incompatibility',async()=>{
    const a=adapter('cold-start'),s=await a.openSession(input());await a.startTurn(s,request());
    const events=await terminal(a,s,15000);
    expect(events.at(-1)).toMatchObject({kind:'turn.completed'});
    expect(events.some(e=>e.kind==='turn.failed')).toBe(false);
    expect(await a.waitForTurnExit(s,'turn',3000)).toMatchObject({exitConfirmed:true});
  },20000);
  it('bounds startup without sending a prompt or misreporting protocol incompatibility',async()=>{
    const a=adapter('no-ready',undefined,150),s=await a.openSession(input());await a.startTurn(s,request());
    const events=await terminal(a,s);
    expect(events.at(-1)).toMatchObject({kind:'turn.failed',code:'CAPABILITY_UNSUPPORTED',message:expect.stringContaining('启动等待超时')});
    expect(events.some(e=>e.kind==='turn.started'||e.kind==='session.ready'||e.kind==='turn.completed')).toBe(false);
    expect(await a.waitForTurnExit(s,'turn',3000)).toMatchObject({exitConfirmed:true});
  });
  it('rejects unsupported scopes and malformed repair requests before starting any child; images reach the model only in full mode',async()=>{
    let calls=0;const a=adapter('success',()=>{calls++;});const readOnly=await a.openSession({...input(),writeAccess:undefined});
    await expect(a.startTurn(readOnly,request())).rejects.toMatchObject({code:'CAPABILITY_UNSUPPORTED',notStarted:true});
    const full=await a.openSession(input());await expect(a.startTurn(full,{...request(),repairOnly:true})).rejects.toMatchObject({notStarted:true});
    expect(calls).toBe(0);
    // R194：图片随消息直接发送——full 模式 execute 帧携带图片字节；planning/format-repair 只接受文字。
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=','base64');
    const {createHash}=await import('node:crypto');
    const image={artifactId:'a',hash:createHash('sha256').update(png).digest('hex'),mime:'image/png' as const,dataBase64:png.toString('base64')};
    const imageSession=await a.openSession(input());await a.startTurn(imageSession,{...request('看图'),images:[image]});
    const events=await terminal(a,imageSession);const done=events.find(e=>e.kind==='turn.completed');
    expect(done?.kind).toBe('turn.completed');
    if(done?.kind==='turn.completed'){const echoed=JSON.parse(done.finalText!) as {mode:string;images:Array<{data:string;mediaType:string}>|null};
      expect(echoed.mode).toBe('full');expect(echoed.images).toHaveLength(1);expect(echoed.images![0]!.mediaType).toBe('image/png');
      expect(Buffer.from(echoed.images![0]!.data,'base64')).toEqual(png);}
    const planning=await a.openSession({...input(),writeAccess:undefined});
    await a.startTurn(planning,{...request('计划'),stage:'coordination.planning',outputSchema:{type:'object'},images:[image]});
    const planEvents=await terminal(a,planning);const planDone=planEvents.find(e=>e.kind==='turn.completed');
    if(planDone?.kind==='turn.completed'){const echoed=JSON.parse(planDone.finalText!) as {mode:string;images:unknown};
      expect(echoed.mode).toBe('planning');expect(echoed.images).toBeNull();}
    expect(calls).toBe(2);
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
