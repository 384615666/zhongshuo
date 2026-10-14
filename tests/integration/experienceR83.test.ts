import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {effectiveTaskWriteAccess} from '../../src/daemon/projectWriteAccess.ts';
import {chatAnswer} from '../../src/contracts/chatAnswer.ts';
import {ClaudeCliAdapter} from '../../src/adapter/claude/cliAdapter.ts';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import {claudeEffortsFromHelp} from '../../src/daemon/runtimeOptions.ts';
import * as runtimeOptionsModule from '../../src/daemon/runtimeOptions.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {fileWriteCapability} from '../../src/adapter/writeCapability.ts';
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
const control={schemaVersion:'task-complete-v1',resultKey:'result_a',answer:'你好！',changeSummary:'回应问候',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]};
interface FixtureFacts {project:{id:string};memberId:string;items:Array<{id:string;revision:number;conversationId:string}>;taskId:string;id:string;revision:number;config:{effort:string};binding:{permissionMode:string;effort:string};text:string|null}
describe('R83 effective execution and readable conversation, no real inference',()=>{
  it.each(['claude','codex'])('full %s execution is not described as readonly by old scoped certification',kind=>{
    for(const permissionMode of [null,'bypassPermissions']){
      const evidence=fileWriteCapability({kind,model:'own-model',permissionMode,executable:null},'own-cwd');
      expect(evidence.status).toBe('unverified');expect(evidence.reason).toContain('CLI 原生完整权限');expect(evidence.reason).not.toContain('当前只读');
    }
  });
  it('Claude wrapped help yields only the actual declared levels, absent or limited CLI stays honest',()=>{
    expect(claudeEffortsFromHelp('  --effort <level> Effort for session\n    (low, medium, high, xhigh, max)\n  --environment <id> unrelated')).toEqual(['low','medium','high','xhigh','max']);
    expect(claudeEffortsFromHelp('  --effort <level> (low, high)\n  --another high medium')).toEqual(['low','high']);
    expect(claudeEffortsFromHelp('  --unrelated low medium high')).toEqual([]);
  });
  it('projects and members created by commands freeze full/readonly policy; config change rejects old dispatch; templates keep independent effort',async()=>{
    vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
    const root=mkdtempSync(join(tmpdir(),'r83-policy-'));const project=join(root,'工程');mkdirSync(project);
    const db=openDatabase(join(root,'state.sqlite'));const deps={db,localUserId:'u_local',appDataDir:root,interruptTurn:async()=>{}};
    const cmd=async(method:string,params:unknown)=>{const response=await dispatchDaemonCommand(deps,{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:FixtureFacts;error?:unknown};expect(response.ok,JSON.stringify(response.error)).toBe(true);return response.data;};
    try{
      const p=(await cmd('project.open',{path:project})).project.id;
      const member=(await cmd('member.create',{projectId:p,displayName:'执行者'})).memberId;
      await cmd('member.setRuntime',{memberId:member,kind:'fake',permissionMode:'bypassPermissions',effort:'high'});
      const room=(await cmd('room.list',{projectId:p})).items[0]!;
      const send=()=>cmd('message.submit',{target:{kind:'room_root',projectId:p,conversationId:room.conversationId,roomId:room.id},body:'创建一个简单函数',intent:'default',mentions:[{kind:'member',memberId:member}]});
      const first=await send();expect(effectiveTaskWriteAccess(db,first.taskId,member,'fake')).toMatchObject({fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[]});
      const revision=(await cmd('member.list',{projectId:p})).items.find(m=>m.id===member)!.revision;
      const template=await cmd('memberTemplate.saveFromMember',{projectId:p,memberId:member,expectedRevision:revision,name:'完整配置',description:''});expect(template.config.effort).toBe('high');
      await cmd('member.setRuntime',{memberId:member,kind:'fake',permissionMode:'plan',effort:'low'});
      expect(()=>effectiveTaskWriteAccess(db,first.taskId,member,'fake')).toThrow(/配置已变化/);
      const second=await send();expect(effectiveTaskWriteAccess(db,second.taskId,member,'fake')).toMatchObject({fullAccess:false,modificationAuthorized:false});
      const adapter=new FakeRuntimeAdapter({turnScripts:[[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({...control,responseKind:'conversation',files:['合成图片引用.png'],unexecutedVerifications:[{item:'像素精确测量',reason:'仅目视识别，无此工作请求'}]})}}]]});
      const worker=new DispatchWorker({db,adapter,leaseOwner:'r83-conversation',appDataDir:root});
      await worker.runOnce();await worker.runOnce();
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(first.taskId)).toMatchObject({status:'BLOCKED'});
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(second.taskId)).toMatchObject({status:'DONE'});
      expect((db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(second.taskId) as {n:number}).n).toBe(0);
      const reply=db.prepare("SELECT id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(second.taskId) as {id:string;body_json:string};
      expect(JSON.parse(reply.body_json)).toMatchObject({text:'你好！'});expect(JSON.parse(reply.body_json).runtimeControlResult).toContain('responseKind');
      expect((await cmd('message.protocol',{projectId:p,messageId:reply.id})).text).toBe(JSON.parse(reply.body_json).runtimeControlResult);
      const wrongProject=await dispatchDaemonCommand(deps,{protocolVersion:1,commandId:randomUUID(),method:'message.protocol',params:{projectId:'another-project',messageId:reply.id}}) as {ok:boolean};expect(wrongProject.ok).toBe(false);
      const dm=await cmd('conversation.create',{projectId:p,peerMemberId:member});
      const dmTask=await cmd('message.submit',{target:{kind:'dm',projectId:p,conversationId:(dm as unknown as {conversationId:string}).conversationId},body:'测试',intent:'default',mentions:[]});await worker.runOnce();
      const dmReply=db.prepare("SELECT id FROM messages WHERE task_id=? AND author_type='agent'").get(dmTask.taskId) as {id:string};
      const outsider=await dispatchDaemonCommand({...deps,localUserId:'outside-audience'},{protocolVersion:1,commandId:randomUUID(),method:'message.protocol',params:{projectId:p,messageId:dmReply.id}}) as {ok:boolean};expect(outsider.ok).toBe(false);
      const copy=await cmd('memberTemplate.createMember',{projectId:p,templateId:template.id,expectedRevision:template.revision,displayName:'另一成员',description:''});
      const binding=(await cmd('member.runtime',{memberId:copy.memberId})).binding;expect(binding).toMatchObject({permissionMode:'bypassPermissions',effort:'high'});
      await cmd('member.setRuntime',{memberId:member,kind:'fake',permissionMode:'bypassPermissions',effort:'low'});
      const actualWork=await send();
      const workAdapter=new FakeRuntimeAdapter({turnScripts:[[
        {kind:'event',event:{kind:'tool.started',toolCallId:'write-one',toolName:'Write',argumentsSummary:'result.txt'}},
        {kind:'writeFile',path:'result.txt',content:'独立工程工具产出'},
        {kind:'event',event:{kind:'tool.completed',toolCallId:'write-one',outcome:'success'}},
        {kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({...control,responseKind:'conversation',files:['result.txt']})}},
      ]]});
      await new DispatchWorker({db,adapter:workAdapter,leaseOwner:'r83-work-evidence',appDataDir:root}).runOnce();
      expect(readFileSync(join(project,'result.txt'),'utf8')).toBe('独立工程工具产出');
      expect((db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(actualWork.taskId) as {n:number}).n).toBe(1);
      expect((db.prepare("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='turn.conversationWorkObserved'").get(actualWork.taskId) as {n:number}).n).toBe(1);
      vi.stubEnv('ZS_REAL_DISPATCH_GUARD','0'); // Configuration only, worker has already finished; no real adapter factory.
      const optionsSpy=vi.spyOn(runtimeOptionsModule,'runtimeOptions').mockResolvedValue({efforts:['high'],source:'isolated CLI declaration fixture',reason:'protocol only',imageInput:'automatic'});
      const currentRevision=(await cmd('member.list',{projectId:p})).items.find(m=>m.id===member)!.revision;
      const envelope={protocolVersion:1,commandId:'r83-effort-saved-original',method:'member.setRuntime',params:{projectId:p,memberId:member,expectedRevision:currentRevision,kind:'claude',model:'glm-5.3-flash',effort:'high'}};
      const saved=await dispatchDaemonCommand(deps,envelope) as {ok:boolean;error?:unknown};expect(saved.ok,JSON.stringify(saved.error)).toBe(true);
      expect(await dispatchDaemonCommand(deps,envelope)).toMatchObject({ok:true,replayed:true});expect(optionsSpy).toHaveBeenCalledTimes(1);
      expect((db.prepare('SELECT count(*) n FROM real_calls').get() as {n:number}).n).toBe(0);
    }finally{db.close();}
  });
  it('full Claude argv restores native tools/commands and sends actual effort; explicit old readonly stays readonly',async()=>{
    const cwd=mkdtempSync(join(tmpdir(),'r83-argv-'));const calls:string[][]=[];
    const adapter=new ClaudeCliAdapter({model:'glm-5.3-flash',permissionMode:'bypassPermissions',effort:'high'},args=>{calls.push(args);throw Error('INTERCEPTED');});
    const s=await adapter.openSession({projectId:'p',taskId:'t',memberId:'m',threadId:'th',sessionGeneration:0,cwd,policyId:'full',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'snapshot'}});
    await expect(adapter.startTurn(s,{turnId:'t',dispatchKey:'d',inputBundleId:'i',text:'你好',policyId:'full',taskRevision:0})).rejects.toThrow('INTERCEPTED');
    expect(calls[0]).toContain('--dangerously-skip-permissions');expect(calls[0]).not.toContain('--restricted');expect(calls[0]).not.toContain('--tools');expect(calls[0]).not.toContain('--disallowedTools');expect(calls[0]![calls[0]!.indexOf('--effort')+1]).toBe('high');
  });
  it('Codex uses model/list effort and native full sandbox at thread and turn; no real process',async()=>{
    const calls:Array<{method:string;params:Record<string,unknown>}>=[];const adapter=new CodexAppServerAdapter({model:'gpt-6-luna',effort:'high'});
    const wire=adapter as unknown as {ensureProcess:()=>void;writeLine:()=>void;request:(method:string,params:Record<string,unknown>,cb?:(value:unknown)=>void)=>Promise<unknown>};wire.ensureProcess=()=>{};wire.writeLine=()=>{};wire.request=async(method,params,cb)=>{calls.push({method,params});const result=method==='model/list'?{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}:method==='turn/start'?{turn:{id:'pt'}}:{thread:{id:'ps'}};cb?.(result);return result;};
    const s=await adapter.openSession({projectId:'p',taskId:'t',memberId:'m',threadId:'th',sessionGeneration:0,cwd:'D:\\工程',policyId:'full',writeAccess:{fullAccess:true,modificationAuthorized:true,allowedWriteRoots:[],identityKey:'snapshot'}});
    await adapter.startTurn(s,{turnId:'t',dispatchKey:'d',inputBundleId:'i',text:'你好',policyId:'full',taskRevision:0});
    expect(calls.find(c=>c.method==='thread/start')?.params.sandbox).toBe('danger-full-access');expect(calls.find(c=>c.method==='turn/start')?.params).toMatchObject({effort:'high',sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'never'});
  });
  it('runtime protocol projects answer, legacy projects summary, human JSON and arbitrary JSON stay exact',()=>{
    const raw=JSON.stringify(control);expect(chatAnswer(raw,'agent')).toBe('你好！');expect(chatAnswer(raw,'human')).toBe(raw);expect(chatAnswer('{"changeSummary":"用户的 JSON"}','agent')).toBe('{"changeSummary":"用户的 JSON"}');
    const {answer,...legacy}=control;expect(answer).toBe('你好！');expect(chatAnswer(JSON.stringify(legacy),'agent')).toBe('回应问候');
  });
});
