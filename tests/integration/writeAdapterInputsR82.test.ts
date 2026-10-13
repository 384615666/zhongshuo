import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import {ClaudeCliAdapter} from '../../src/adapter/claude/cliAdapter.ts';
import type {OpenSessionInput,TurnRequest} from '../../src/contracts/runtime.ts';
const turn:TurnRequest={turnId:'t',dispatchKey:'d',inputBundleId:'b',text:'synthetic protocol only',policyId:'policy-project-write',taskRevision:0};
describe('R82 actual adapter permission inputs; intercepted before CLI/model execution',()=>{
  it.each([false,true])('Codex explicit thread and turn sandbox writable=%s',async writable=>{
    const calls:Array<{method:string;params:Record<string,unknown>}>=[];
    const adapter=new CodexAppServerAdapter({sandboxMode:'workspace-write',model:'gpt-6-luna'});
    const wire=adapter as unknown as {ensureProcess:()=>void;writeLine:()=>void;request:(method:string,params:Record<string,unknown>,onReply?:(value:unknown)=>void)=>Promise<unknown>};
    wire.ensureProcess=()=>{};wire.writeLine=()=>{};wire.request=async(method,params,cb)=>{calls.push({method,params});const reply=method==='turn/start'?{turn:{id:'provider-turn'}}:{thread:{id:'provider-thread'}};cb?.(reply);return reply;};
    const input:OpenSessionInput={projectId:'p',memberId:'m',taskId:'t',threadId:'th',sessionGeneration:0,cwd:'D:\\独立工程',policyId:'p',writeAccess:{modificationAuthorized:writable,allowedWriteRoots:writable?['D:\\独立工程']:[],identityKey:'frozen'}};
    const session=await adapter.openSession(input);await adapter.startTurn(session,turn);
    expect(calls.find(c=>c.method==='thread/start')!.params).toMatchObject({model:'gpt-6-luna',sandbox:writable?'workspace-write':'read-only',approvalPolicy:'never'});
    const policy=calls.find(c=>c.method==='turn/start')!.params.sandboxPolicy;
    expect(policy).toEqual(writable?{type:'workspaceWrite',writableRoots:['D:\\独立工程'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false});
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
});
