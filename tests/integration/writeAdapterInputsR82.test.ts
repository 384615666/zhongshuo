import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import {ClaudeCliAdapter} from '../../src/adapter/claude/cliAdapter.ts';
import type {OpenSessionInput,TurnRequest} from '../../src/contracts/runtime.ts';
import {renderStandingPrompt,selectStageInstruction} from '../../src/contracts/prompts.ts';
const turn:TurnRequest={turnId:'t',dispatchKey:'d',inputBundleId:'b',text:'synthetic protocol only',policyId:'policy-project-write',taskRevision:0};
// Parameter-only interceptors explicitly model an already-live transport.
// They spawn nothing; actual lifecycle behavior is covered by the local R126 protocol tests.
describe('R82 actual adapter permission inputs; intercepted before CLI/model execution',()=>{
  it.each([false,true])('Codex explicit thread and turn sandbox writable=%s',async writable=>{
    const calls:Array<{method:string;params:Record<string,unknown>}>=[];
    const adapter=new CodexAppServerAdapter({sandboxMode:'workspace-write',model:'gpt-6-luna'});
    const wire=adapter as unknown as {child:{exitCode:null;signalCode:null};ensureProcess:()=>unknown;writeLine:()=>void;request:(method:string,params:Record<string,unknown>,onReply?:(value:unknown)=>void)=>Promise<unknown>};
    wire.child={exitCode:null,signalCode:null};wire.ensureProcess=()=>wire.child;wire.writeLine=()=>{};wire.request=async(method,params,cb)=>{calls.push({method,params});const reply=method==='turn/start'?{turn:{id:'provider-turn'}}:{thread:{id:'provider-thread'}};cb?.(reply);return reply;};
    const input:OpenSessionInput={projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd:'D:\\独立工程',policyId:'p',writeAccess:{modificationAuthorized:writable,allowedWriteRoots:writable?['D:\\独立工程']:[],identityKey:'frozen'}};
    const session=await adapter.openSession(input);await adapter.startTurn(session,turn);
    expect(calls.find(c=>c.method==='thread/start')!.params).toMatchObject({model:'gpt-6-luna',sandbox:writable?'workspace-write':'read-only',approvalPolicy:'never'});
    const policy=calls.find(c=>c.method==='turn/start')!.params.sandboxPolicy;
    expect(policy).toEqual(writable?{type:'workspaceWrite',writableRoots:['D:\\独立工程'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false});
  });
  it('Codex real adapter request-parameter stub carries full developer instructions and full-access turn text',async()=>{
    const calls:Array<{method:string;params:Record<string,unknown>}>=[];
    const adapter=new CodexAppServerAdapter({sandboxMode:'danger-full-access',model:'gpt-6-luna'});
    const wire=adapter as unknown as {child:{exitCode:null;signalCode:null};ensureProcess:()=>unknown;writeLine:()=>void;request:(method:string,params:Record<string,unknown>,onReply?:(value:unknown)=>void)=>Promise<unknown>};
    wire.child={exitCode:null,signalCode:null};wire.ensureProcess=()=>wire.child;wire.writeLine=()=>{};wire.request=async(method,params,cb)=>{calls.push({method,params});const reply=method==='turn/start'?{turn:{id:'provider-turn'}}:{thread:{id:'provider-thread'}};cb?.(reply);return reply;};
    const standingResult=renderStandingPrompt({conversationKind:'room',vars:{memberId:'m',memberDisplayName:'成员',projectId:'p',projectName:'项目',roomId:'r',roomName:'房间',threadId:'th',taskId:'t',workspacePath:'D:\\独立工程',draftDir:'D:\\drafts'}});
    expect(standingResult.ok).toBe(true);if(!standingResult.ok)return;
    const standing=standingResult.value.text;
    const instruction=selectStageInstruction({mode:'DELIBERATE',role:'host',stage:'SYNTHESIS',turnPurpose:'stage_work'});
    expect(instruction.ok).toBe(true);if(!instruction.ok)return;
    const text=`R97_NATIVE_TURN_PREFIX\n${instruction.value}\nR97_NATIVE_TURN_SUFFIX`;
    const session=await adapter.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd:'D:\\独立工程',policyId:'policy-full-access',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'fingerprint'},developerInstructions:standing});
    await adapter.startTurn(session,{...turn,text,policyId:'policy-full-access'});
    const thread=calls.find(c=>c.method==='thread/start')!.params;
    expect(thread.sandbox).toBe('danger-full-access');
    expect(thread.developerInstructions).toContain(standing);
    const started=calls.find(c=>c.method==='turn/start')!.params;
    expect(started.sandboxPolicy).toEqual({type:'dangerFullAccess'});
    const input=(started.input as Array<{type:string;text:string}>)[0]!;
    expect(input.type).toBe('text');
    expect(input.text).toBe(text);
  });
  it('Codex grant cannot use mismatched roots or readonly member option; no request',async()=>{
    const spawn=vi.fn(()=>{throw Error('must not spawn');});const adapter=new CodexAppServerAdapter({spawnFn:spawn});
    await expect(adapter.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd:'D:\\p',policyId:'p',writeAccess:{modificationAuthorized:true,allowedWriteRoots:['D:\\p'],identityKey:'x'}})).rejects.toThrow(/权限不匹配/);expect(spawn).not.toHaveBeenCalled();
  });
  it.each([false,true])('Claude actual argv contains effective tool enforcement writable=%s',async writable=>{
    const cwd=mkdtempSync(join(tmpdir(),'r82-argv-'));const args:string[][]=[];
    const adapter=new ClaudeCliAdapter({model:'deepseek-flash',permissionMode:'acceptEdits'},a=>{args.push(a);throw Error('INTERCEPTED_BEFORE_PROCESS');});
    const s=await adapter.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd,policyId:'p',writeAccess:{modificationAuthorized:writable,allowedWriteRoots:writable?[cwd]:[],identityKey:'x'}});
    await expect(adapter.startTurn(s,turn)).rejects.toThrow('INTERCEPTED_BEFORE_PROCESS');
    expect(args).toHaveLength(1);const a=args[0]!;
    expect(a[a.indexOf('--permission-prompts')+1]).toBe('none');expect(a).toContain('--strict-mcp-config');
    if(writable){expect(a).toContain('--restricted');expect(a[a.indexOf('--tools')+1]).toBe('Read,Glob,Grep,Write,Edit');expect(a[a.indexOf('--permission-mode')+1]).toBe('dontAsk');}
    else expect(a[a.indexOf('--disallowedTools')+1]).toContain('Write,Edit');
    expect(a).not.toContain('--dangerously-skip-permissions');expect(a).not.toContain('--add-dir');
  });
  it('Claude real adapter argv/standing-file intercept carries full-access flags and complete prompt',async()=>{
    const cwd=mkdtempSync(join(tmpdir(),'r97-full-claude-')),args:string[][]=[];let standingFile='';
    const adapter=new ClaudeCliAdapter({model:'deepseek-flash',permissionMode:'bypassPermissions'},a=>{args.push(a);const file=a[a.indexOf('--append-system-prompt-file')+1];standingFile=file?readFileSync(file,'utf8'):'';throw Error('INTERCEPTED_BEFORE_PROCESS');});
    const standingResult=renderStandingPrompt({conversationKind:'room',vars:{memberId:'m',memberDisplayName:'成员',projectId:'p',projectName:'项目',roomId:'r',roomName:'房间',threadId:'th',taskId:'t',workspacePath:cwd,draftDir:join(cwd,'drafts')}});
    expect(standingResult.ok).toBe(true);if(!standingResult.ok)return;
    const standing=standingResult.value.text;
    const instruction=selectStageInstruction({mode:'DELIBERATE',role:'host',stage:'SYNTHESIS',turnPurpose:'stage_work'});
    expect(instruction.ok).toBe(true);if(!instruction.ok)return;
    const s=await adapter.openSession({projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd,policyId:'policy-full-access',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'fingerprint'},developerInstructions:standing});
    const text=`R97_CLAUDE_TURN_PREFIX\n${instruction.value}\nR97_CLAUDE_TURN_SUFFIX`;
    await expect(adapter.startTurn(s,{...turn,text,policyId:'policy-full-access'})).rejects.toThrow('INTERCEPTED_BEFORE_PROCESS');
    expect(args).toHaveLength(1);const a=args[0]!;
    expect(a[a.indexOf('--permission-mode')+1]).toBe('bypassPermissions');
    expect(a).toContain('--dangerously-skip-permissions');
    expect(standingFile).toBe(standing);
  });
});
