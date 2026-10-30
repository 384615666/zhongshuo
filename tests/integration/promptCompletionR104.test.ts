import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {assembleStepInput,parseDelibStep} from '../../src/daemon/deliberationRunner.ts';
import {listRunArtifacts} from '../../src/persistence/stores/deliberation.ts';

afterEach(()=>vi.unstubAllEnvs());
const done=(payload:unknown):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify(payload)}}];
function draft(disposition:string,summary='你好！',statements:string[]=[],extra:Record<string,unknown>={}){
  return {schemaVersion:'analysis-draft-v1',summary,document:null,completion:{disposition,reason:'根据当前明确请求判断'},claims:statements.map((statement,index)=>({claimId:`c${index+1}`,statement,kind:'observed',evidenceIds:[],uncertainty:''})),recommendations:[],openQuestions:[],...extra};
}
async function fixture(deliberate=true){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r104-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  let script:FakeTurnScript=[];
  const adapter=new FakeRuntimeAdapter({structuredFinal:!deliberate,turnScriptSequencer:()=>script});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r104',appDataDir:dir,enableDeliberate:deliberate});
  const deps={db,localUserId:'r104-human',appDataDir:dir,interruptTurn:(id:string)=>worker.interruptTurn(id)};
  async function cmd<T>(method:string,params:unknown):Promise<T>{const r=await dispatchDaemonCommand(deps,{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error:unknown};if(!r.ok)throw Error(JSON.stringify(r.error));return r.data;}
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:{id:string;conversationId:string}[]}>('room.list',{projectId})).items[0]!;
  const a=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'主持'})).memberId;
  const b=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'复核'})).memberId;
  for(const memberId of [a,b])await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
  const revision=(db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision:number}).revision;
  await cmd('room.update',{roomId:room.id,expectedRevision:revision,coordinatorMemberId:a});
  const send=(body='你好')=>cmd<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body,intent:'default',...(deliberate?{collaboration:'deliberate',mentions:[a,b].map(memberId=>({kind:'member',memberId}))}:{mentions:[]})});
  const run=async(payload:unknown,prefix:FakeTurnScript=[])=>{script=[...prefix,...done(payload)];await worker.runOnce();};
  const state=(taskId:string)=>db.prepare('SELECT status,response_kind,current_delivery_id FROM tasks WHERE id=?').get(taskId);
  const count=(table:string,where='')=>(db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get() as {n:number}).n;
  const cleanup=async()=>{await adapter.closeAllSessions();db.close();rmSync(dir,{recursive:true,force:true});};
  return {db,dir,project,projectId,room,a,b,adapter,worker,cmd,send,run,state,count,cleanup};
}

describe('R104 semantic completion through formal worker dispatch',()=>{
  it('R127 labels concurrent file versions as shared observations instead of claiming this run authored them',async()=>{
    const f=await fixture();try{
      writeFileSync(join(f.project,'共享.md'),'原始版本');
      const root=await f.send('分别核对文件');await f.worker.runOnce();
      await f.run(draft('continue','文件已更新',['需要复核']),[{kind:'writeFile',path:'共享.md',content:'更新版本'}]);
      await f.run(draft('continue','读取当前版本',['需要复核']));
      f.db.prepare("UPDATE change_sets SET manifest_json=json_set(manifest_json,'$.concurrentWriteObservation',json('true')) WHERE task_id=?").run(root.taskId);
      const key=(f.db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key:string}).dispatch_key;
      const step=parseDelibStep(key)!;
      const assembled=assembleStepInput(f.db,{taskId:root.taskId,runId:step.runId,step,appDataDir:f.dir});
      expect(assembled.ok).toBe(true);if(!assembled.ok)return;
      expect(assembled.value.text).toContain('文件版本观察：修改前/后快照');
      expect(assembled.value.text).toContain('shared-directory-observation');
      expect(assembled.value.text).toContain('不证明本运行或某位成员实际修改');
      expect(assembled.value.text).not.toContain('本运行真实文件修改');
      expect(assembled.value.text).toContain('原始版本');expect(assembled.value.text).toContain('更新版本');
    }finally{await f.cleanup();}
  });
  it.each([false,true])('supplies verified original and revised evidence without mixing later disk state (corrupt=%s)',async(corrupt)=>{
    const f=await fixture();try{
      writeFileSync(join(f.project,'预算.md'),'原稿1140/60/2');const root=await f.send('核对并修订预算');await f.worker.runOnce();
      await f.run(draft('continue','已改为1160/40/1',['当前总额1160']),[{kind:'writeFile',path:'预算.md',content:'修订1160/40/1'}]);
      await f.run(draft('continue','读取当前修订版',['当前总额1160']));
      expect(f.adapter.startTurnLog.slice(0,2).every(call=>!call.text.includes('本运行真实文件修改'))).toBe(true);
      const before=f.db.prepare("SELECT f.content_ref FROM change_set_files f JOIN change_sets c ON c.id=f.change_set_id WHERE c.task_id=? AND f.role='before' AND f.path='预算.md' ORDER BY c.rowid LIMIT 1").get(root.taskId) as {content_ref:string};
      if(corrupt)writeFileSync(join(f.dir,'preimages',f.projectId,before.content_ref),'篡改值9999');
      writeFileSync(join(f.project,'预算.md'),'后来磁盘值不替代冻结快照');
      const key=(f.db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key:string}).dispatch_key;
      const step=parseDelibStep(key)!;const assembled=assembleStepInput(f.db,{taskId:root.taskId,runId:step.runId,step,appDataDir:f.dir});
      expect(assembled.ok).toBe(true);if(!assembled.ok)return;
      expect(assembled.value.text).toContain('修改前/后快照');expect(assembled.value.text).toContain('修订1160/40/1');
      expect(assembled.value.text).not.toContain('后来磁盘值不替代冻结快照');expect(assembled.value.text).not.toContain('篡改值9999');
      if(corrupt){expect(assembled.value.text).toContain('快照缺失、损坏');expect(assembled.value.text).not.toContain('原稿1140/60/2');}
      else expect(assembled.value.text).toContain('原稿1140/60/2');
    }finally{await f.cleanup();}
  });
  it.each(['conversation','no_reply'])('%s ends after both independent calls without work acceptance',async(disposition)=>{
    const f=await fixture();try{
      const root=await f.send(disposition==='no_reply'?'谢谢，无需继续回复':'你好');
      f.db.prepare("UPDATE tasks SET review_policy='user_review' WHERE id=?").run(root.taskId);
      await f.worker.runOnce();await f.run(draft(disposition));await f.run(draft(disposition));
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.state(root.taskId)).toMatchObject({status:'DONE',response_kind:'conversation',current_delivery_id:null});
      expect(f.count('task_deliveries')).toBe(0);
      expect(f.count('messages',"WHERE author_type='agent'")).toBe(disposition==='no_reply'?0:1);
      expect(f.count('domain_events',"WHERE kind='run.shortExchangeCompleted'")).toBe(1);
    }finally{await f.cleanup();}
  });
  it('does not fabricate claims when members differ only on social acknowledgement',async()=>{
    const f=await fixture();try{await f.send();await f.worker.runOnce();await f.run(draft('conversation'));await f.run(draft('no_reply','没有新任务'));expect(f.adapter.startTurnLog).toHaveLength(2);expect(f.count('task_deliveries')).toBe(0);expect(f.count('messages',"WHERE author_type='agent'")).toBe(1);}finally{await f.cleanup();}
  });
  it('compares explicit simple answers and restores both drafts when they conflict',async()=>{
    const f=await fixture();try{await f.send('25×80=?');await f.worker.runOnce();await f.run(draft('direct_answer','2000',['25×80=2000']));await f.run(draft('direct_answer','2001',['25×80=2001']));expect(f.count('messages',"WHERE author_type='agent'")).toBe(2);expect(f.db.prepare('SELECT stage FROM workflow_runs').get()).toEqual({stage:'CROSS_REVIEW'});expect(f.count('task_deliveries')).toBe(0);}finally{await f.cleanup();}
  });
  it('completes matching simple answers without claiming a ratification consensus',async()=>{
    const f=await fixture();try{const root=await f.send('25×80=?');await f.worker.runOnce();await f.run(draft('direct_answer','2000',['25×80=2000']));await f.run(draft('direct_answer','结果为2000',['25×80=2000']));expect(f.adapter.startTurnLog).toHaveLength(2);expect(f.state(root.taskId)).toMatchObject({status:'DONE',response_kind:'conversation'});const body=JSON.parse((f.db.prepare("SELECT body_json FROM messages WHERE author_type='agent'").get() as {body_json:string}).body_json);expect(body).toEqual({text:'2000'});expect(f.count('ratification_records')).toBe(0);}finally{await f.cleanup();}
  });
  it('does not shortcut a draft with unfinished work',async()=>{
    const f=await fixture();try{await f.send();await f.worker.runOnce();await f.run(draft('conversation'));await f.run(draft('continue','仍需检查',['资料待核验'],{openQuestions:['尚未得到材料']}));expect(f.db.prepare('SELECT stage FROM workflow_runs').get()).toEqual({stage:'CROSS_REVIEW'});expect(f.count('messages',"WHERE author_type='agent'")).toBe(2);}finally{await f.cleanup();}
  });
  it('does not hide an actual file write without a tool notification',async()=>{
    const f=await fixture();try{const root=await f.send();await f.worker.runOnce();await f.run(draft('conversation'),[{kind:'writeFile',path:'实际修改.md',content:'实际内容'}]);await f.run(draft('conversation'));expect(readFileSync(join(f.project,'实际修改.md'),'utf8')).toBe('实际内容');expect(f.state(root.taskId)).toMatchObject({status:'BLOCKED',current_delivery_id:null});expect(f.db.prepare('SELECT status,stage FROM workflow_runs').get()).toEqual({status:'PARTIAL',stage:'INDEPENDENT'});expect(f.count('messages',"WHERE author_type='agent'")).toBe(2);expect(f.count('artifacts',"WHERE kind IN ('cross_review','synthesis','final_report')")).toBe(0);expect(await f.worker.runOnce()).toBe(false);}finally{await f.cleanup();}
  });
  it.each(['StructuredOutput','Read'])('distinguishes the protocol submission tool from actual execution (%s)',async(toolName)=>{
    const f=await fixture();try{const root=await f.send();await f.worker.runOnce();await f.run(draft('conversation'),[
      {kind:'event',event:{kind:'tool.started',toolCallId:'r104-tool',toolName,argumentsSummary:''}},
      {kind:'event',event:{kind:'tool.completed',toolCallId:'r104-tool',outcome:'success'}},
    ]);await f.run(draft('conversation'));
      expect(f.state(root.taskId)).toMatchObject({status:toolName==='StructuredOutput'?'DONE':'BLOCKED',current_delivery_id:null});
      expect(f.count('task_deliveries')).toBe(0);expect(f.count('artifacts',"WHERE kind IN ('cross_review','synthesis')")).toBe(0);expect(await f.worker.runOnce()).toBe(false);
    }finally{await f.cleanup();}
  });
  it('closes an empty-claim social reply plus a failed seat with an explicit reason, never a fabricated synthesis',async()=>{
    const f=await fixture();try{const root=await f.send();await f.worker.runOnce();await f.run(draft('conversation'));
      await f.run(draft('conversation'),[{kind:'event',event:{kind:'turn.failed',code:'PROVIDER_FAILED',message:'合成成员启动失败',retryable:false}}]);
      expect(f.state(root.taskId)).toMatchObject({status:'BLOCKED',current_delivery_id:null});expect(f.db.prepare('SELECT status FROM workflow_runs').get()).toEqual({status:'PARTIAL'});
      expect(f.count('artifacts',"WHERE kind IN ('cross_review','synthesis','final_report')")).toBe(0);expect(f.count('messages',"WHERE author_type='agent'")).toBe(1);
      expect((f.db.prepare("SELECT payload_json FROM domain_events WHERE kind='run.shortExchangeBlocked'").get() as {payload_json:string}).payload_json).toContain('指定成员未全部完成');expect(await f.worker.runOnce()).toBe(false);
    }finally{await f.cleanup();}
  });
  it.each([false,true])('skips RAT only for unchanged fully reviewed text (new summary=%s)',async(changed)=>{
    const f=await fixture();try{
      await f.send('两人独立核查后给结论');await f.worker.runOnce();
      for(let i=0;i<2;i++)await f.run(draft('continue','已核验的结论',['结论一']));
      for(let i=0;i<2;i++){
        const key=(f.db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key:string}).dispatch_key;
        const step=parseDelibStep(key)!;const peer=listRunArtifacts(f.db,step.runId,'analysis_draft').find(d=>d.author_id!==step.memberId)!;
        await f.run({schemaVersion:'cross-review-v1',summary:'',document:null,reviews:[{targetArtifactId:peer.id,targetRevision:1,targetClaimId:'c1',stance:'agree',reason:'独立核对完整',evidenceIds:[]}]});
      }
      await f.run({schemaVersion:'synthesis-v1',summary:changed?'新结论必须复核':'已核验的结论',document:null,ratification:{disposition:'skip_if_unchanged',reason:'没有新增'},issueResolutions:[],claims:[{statement:'结论一',sourceRefs:['c1']}],disputedClaims:[],recommendations:[]});
      expect(f.adapter.startTurnLog).toHaveLength(5);
      expect(f.db.prepare('SELECT stage FROM workflow_runs').get()).toEqual({stage:changed?'RATIFY':'PUBLISH'});
      expect(f.count('ratification_records')).toBe(changed?2:0);
    }finally{await f.cleanup();}
  });
  it('rejects incomplete peer review in the new contract instead of silently accepting it',async()=>{
    const f=await fixture();try{await f.send();await f.worker.runOnce();for(let i=0;i<2;i++)await f.run(draft('continue','两项结论',['一','二']));const key=(f.db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key:string}).dispatch_key;const step=parseDelibStep(key)!;const peer=listRunArtifacts(f.db,step.runId,'analysis_draft').find(d=>d.author_id!==step.memberId)!;await f.run({schemaVersion:'cross-review-v1',summary:'',document:null,reviews:[{targetArtifactId:peer.id,targetRevision:1,targetClaimId:'c1',stance:'agree',reason:'只审了一项',evidenceIds:[]}]});expect(f.count('artifacts',"WHERE kind='cross_review'")).toBe(0);expect(f.count('domain_events',"WHERE kind='turn.outputInvalid'")).toBeGreaterThan(0);}finally{await f.cleanup();}
  });
  it('settles silent DM without publishing bookkeeping text or creating delivery',async()=>{
    const f=await fixture(false);try{const dm=await f.cmd<{conversationId:string}>('conversation.create',{projectId:f.projectId,peerMemberId:f.a});await f.cmd('message.submit',{target:{kind:'dm',projectId:f.projectId,conversationId:dm.conversationId},body:'谢谢，无需回复',intent:'default',mentions:[]});await f.run({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',replyDisposition:'none',answer:'',changeSummary:'',document:null,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],handoffs:[]});expect(f.count('messages',"WHERE author_type='agent'")).toBe(0);expect(f.count('task_deliveries')).toBe(0);expect(f.db.prepare('SELECT status FROM tasks').get()).toEqual({status:'DONE'});}finally{await f.cleanup();}
  });
  it('AUTO answers once and the actual planning input includes its nullable plan field',async()=>{
    const f=await fixture(false);try{await f.send('25×80=?');await f.run({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',replyDisposition:'reply',answer:'2000',changeSummary:'',document:null,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],handoffs:[],coordinationPlan:null});expect(f.adapter.startTurnLog).toHaveLength(1);expect(f.adapter.startTurnLog[0]!.text).toContain('"coordinationPlan":null');expect(f.count('task_deliveries')).toBe(0);expect(f.count('coordination_steps')).toBe(0);}finally{await f.cleanup();}
  });
});
