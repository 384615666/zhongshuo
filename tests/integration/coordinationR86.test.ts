import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync,writeFileSync,readFileSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, type ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker,type DispatchWorkerOptions } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { parseDelibStep } from '../../src/daemon/deliberationRunner.ts';
import { listRunArtifacts } from '../../src/persistence/stores/deliberation.ts';
import type {TaskDetailsResult} from '../../src/contracts/taskDetails.ts';
import {applyRecovery} from '../../src/daemon/stopFlow.ts';
import {readTaskExecutionStatus} from '../../src/daemon/executionStatus.ts';
import {reworkPendingOf} from '../../src/persistence/stores/dm.ts';

afterEach(() => vi.unstubAllEnvs());
const output = (answer: string, coordinationPlan?: unknown,extra:Record<string,unknown>={}): FakeTurnScript => [{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({
  schemaVersion:'task-complete-v1',resultKey:'fixture',answer,responseKind:coordinationPlan?'work':'conversation',changeSummary:answer,
  files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...(coordinationPlan?{coordinationPlan}:{}),...extra
})}}];

function requireDetailBeforeChild(db:ZhongshuoDatabase,parentTaskId:string):void{
  db.exec(`
    CREATE TRIGGER r93_planning_detail_before_child
    BEFORE INSERT ON tasks
    WHEN NEW.parent_task_id='${parentTaskId}'
    BEGIN
      SELECT CASE WHEN EXISTS(
        SELECT 1 FROM messages m
          JOIN message_attachments ma ON ma.message_id=m.id
          JOIN artifacts a ON a.id=ma.artifact_id
         WHERE m.thread_id=NEW.conversation_thread_id AND m.author_type='agent'
           AND ma.id LIKE 'matt_detail_%' AND a.kind='text_file'
      ) THEN 1 ELSE RAISE(ABORT, 'R93 planning detail must exist before child task/queue') END;
    END;
  `);
}

function assertDetailInContext(db:ZhongshuoDatabase,taskId:string,marker:string):void{
  const row=db.prepare(`SELECT c.included_refs_json FROM context_bundles c
    JOIN agent_turns a ON a.id=c.turn_id JOIN workflow_runs r ON r.id=a.run_id
    WHERE r.task_id=? ORDER BY c.rowid DESC LIMIT 1`).get(taskId) as {included_refs_json:string}|undefined;
  expect(row).toBeDefined();
  const envelope=JSON.parse(row!.included_refs_json) as {attachments?:Array<{detail?:boolean;text?:string}>};
  expect((envelope.attachments??[]).find(item=>item.detail===true)?.text).toContain(marker);
}

async function fixture(enableDeliberate=false,options:Partial<Pick<DispatchWorkerOptions,'turnDeadlineMs'|'interruptGraceMs'|'coordinationMaxCalls'|'detachedTurnConsumption'>>={}) {
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r86-coordination-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  let script:FakeTurnScript=output('你好');
  const adapter=new FakeRuntimeAdapter({structuredFinal:!enableDeliberate,turnScriptSequencer:()=>script});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r86',appDataDir:dir,enableDeliberate,coordinationMaxCalls:6,...options});
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:(id:string)=>worker.interruptTurn(id)};
  async function raw(method:string,params:unknown,commandId:string=randomUUID()) {return await dispatchDaemonCommand(deps,{protocolVersion:1,commandId,method,params}) as {ok:boolean;data?:unknown;error?:unknown};}
  async function cmd<T>(method:string,params:unknown,commandId?:string):Promise<T> {const r=await raw(method,params,commandId);expect(r.ok,JSON.stringify(r)).toBe(true);return (r as {data:unknown}).data as T;}
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:{id:string;conversationId:string}[]}>('room.list',{projectId})).items[0]!;
  const a=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'同名成员'})).memberId;
  const b=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'同名成员'})).memberId;
  for(const memberId of [a,b]) await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
  const revision=(db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision:number}).revision;
  await cmd('room.update',{roomId:room.id,expectedRevision:revision,coordinatorMemberId:a});
  const send=(mentions:string[]=[])=>cmd<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请两位成员协作分析再复核',intent:'default',...(enableDeliberate?{collaboration:'deliberate'}:{}),mentions:mentions.map(memberId=>({kind:'member',memberId}))});
  const plan={summary:'独立分析后复核',steps:[{key:'analysis',memberId:a,title:'分析',objective:'提出实现方案',role:'analysis',dependsOn:[]},{key:'review',memberId:b,title:'复核',objective:'读取并复核上游方案',role:'review',dependsOn:['analysis']}]};
  const run=async(s:FakeTurnScript)=>{script=s;return worker.runOnce();};
  return {db,dir,worker,adapter,cmd,raw,send,run,plan,a,b,room,projectId};
}

async function completeDeliberationRound(f:Awaited<ReturnType<typeof fixture>>) {
  await f.worker.runOnce(); // formal queued root -> prepare, no model
  for(let count=0;count<30;count++){
    const next=f.db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key:string}|undefined;
    if(!next)break;const step=parseDelibStep(next.dispatch_key);expect(step).not.toBeNull();
    let value:unknown;
    if(step!.stage==='IND')value={schemaVersion:'analysis-draft-v1',summary:`${step!.memberId}独立方案`,claims:[{claimId:'c1',statement:'方案甲可行',kind:'proposal',evidenceIds:[]}],recommendations:['核对约束'],openQuestions:[]};
    else if(step!.stage==='CR'){
      const draft=listRunArtifacts(f.db,step!.runId,'analysis_draft').find(a=>a.author_id!==step!.memberId)!;
      value={schemaVersion:'cross-review-v1',reviews:[{targetArtifactId:draft.id,targetRevision:1,targetClaimId:'c1',stance:'agree',reason:'已读取他方方案，约束一致',evidenceIds:[]}]};
    }else if(step!.stage==='SYN')value={schemaVersion:'synthesis-v1',summary:'两位成员汇总的自然结论',claims:[{statement:'按方案甲推进',sourceRefs:['c1']}],disputedClaims:[],recommendations:['下一步核实工程条件']};
    else if(step!.stage==='RAT')value={schemaVersion:'ratify-v1',responses:[{claimId:'clm_1',stance:'confirm'}]};
    else throw Error(`非预期阶段 ${step!.stage}`);
    await f.run([{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify(value)}}]);
  }
}

describe('R86 formal command → persistent coordination → DIRECT child worker',()=>{
  it('R109 lets the model plan adjacent Chinese names and waits for the dependent review',async()=>{
    const f=await fixture();
    try{
      f.db.prepare('UPDATE project_members SET display_name=? WHERE id=?').run('Claude',f.a);
      f.db.prepare('UPDATE project_members SET display_name=? WHERE id=?').run('Codex',f.b);
      const root=await f.cmd<{taskId:string;threadId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'@Claude 比较方案，然后@Codex 核对这次结果',intent:'default',
        mentions:[{kind:'member',memberId:f.a}],
      });
      expect(f.db.prepare('SELECT count(*) n FROM coordination_steps').get()).toEqual({n:0});
      await f.run(output('已理解先比较再核对',f.plan));
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'ACTIVE'});
      const steps=f.db.prepare('SELECT step_key,child_task_id FROM coordination_steps ORDER BY rowid').all() as Array<{step_key:string;child_task_id:string}>;
      expect(steps).toHaveLength(2);
      expect(f.db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?').get(steps[1]!.child_task_id)).toEqual({depends_on_task_id:steps[0]!.child_task_id});
      await f.run(output('MODEL_STEP_A'));
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).not.toEqual({status:'DONE'});
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(steps[1]!.child_task_id)).toEqual({n:0});
      await f.run(output('MODEL_STEP_B_REVIEW'));
      const review=f.db.prepare('SELECT handoff_json FROM coordination_steps WHERE child_task_id=?').get(steps[1]!.child_task_id) as {handoff_json:string};
      expect(review.handoff_json).toContain('MODEL_STEP_A');
      await f.run(output('两位成员已完成本次比较和核对'));
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('R109 exposes room handoff for a single-recipient follow-up without another input setting',async()=>{
    const f=await fixture();
    try{
      const root=await f.send([f.a]);
      await f.run(output('先回答普通问题',undefined,{responseKind:'conversation'}));
      await f.cmd('message.submit',{
        target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId},
        body:'请先处理，再让另一位成员核对本次结果',intent:'default',mentions:[{kind:'member',memberId:f.a}],
      });
      const request=f.db.prepare('SELECT roster_json FROM thread_reply_requests ORDER BY rowid DESC LIMIT 1').get() as {roster_json:string};
      expect(JSON.parse(request.roster_json).some((m:{memberId:string})=>m.memberId===f.b)).toBe(true);
      await f.run(output('按新消息分工',f.plan));
      expect(f.db.prepare('SELECT count(*) n FROM coordination_steps').get()).toEqual({n:2});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).not.toEqual({status:'DONE'});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('explicitly continues with current member configurations without editing old scopes or adding members',async()=>{
    const f=await fixture(true);try{
      const root=await f.send([f.a,f.b]);await f.worker.runOnce();
      const previous=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=?').get(root.taskId) as {id:string};
      const oldScope=f.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId);
      const oldTask=f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId);
      f.db.prepare("UPDATE workflow_runs SET status='INTERRUPTED' WHERE id=?").run(previous.id);
      f.db.prepare("UPDATE outbox SET status='done'").run();
      await f.cmd('member.setRuntime',{memberId:f.b,kind:'fake',permissionMode:'bypassPermissions',effort:'high'});
      await f.cmd('member.create',{projectId:f.projectId,displayName:'不在原名单'});
      await f.cmd('task.redispatch',{taskId:root.taskId,sourceRunId:previous.id});
      await f.worker.runOnce();
      const current=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(root.taskId) as {id:string};
      expect(current.id).not.toBe(previous.id);
      const frozen=f.db.prepare("SELECT json_extract(e.payload_json,'$.execution.roster') roster_json FROM domain_events e JOIN workflow_runs r ON json_extract(e.payload_json,'$.dispatchKey')=r.dispatch_identity WHERE r.id=? AND e.kind='task.redispatchEnqueued'").get(current.id) as {roster_json:string};
      expect(JSON.parse(frozen.roster_json).map((m:{memberId:string})=>m.memberId).sort()).toEqual([f.a,f.b].sort());
      for(let i=0;i<2;i++)await f.run([{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'analysis-draft-v1',summary:'有效独立结果',claims:[{claimId:'c1',statement:'方案可行',kind:'proposal',evidenceIds:[]}],recommendations:[],openQuestions:[]})}}]);
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns WHERE run_id=? AND status=\'SUCCEEDED\'').get(current.id)).toEqual({n:2});
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns WHERE run_id=?').get(previous.id)).toEqual({n:0});
      expect(f.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId)).toEqual(oldScope);
      expect(f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId)).toEqual(oldTask);
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('keeps the explicit continue snapshot frozen when member settings change again before dispatch',async()=>{
    const f=await fixture(true);try{
      const root=await f.send([f.a,f.b]);await f.worker.runOnce();
      const previous=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=?').get(root.taskId) as {id:string};
      f.db.prepare("UPDATE workflow_runs SET status='INTERRUPTED' WHERE id=?").run(previous.id);f.db.prepare("UPDATE outbox SET status='done'").run();
      await f.cmd('task.redispatch',{taskId:root.taskId,sourceRunId:previous.id});
      await f.cmd('member.setRuntime',{memberId:f.b,kind:'fake',permissionMode:'bypassPermissions',effort:'high'});
      await f.worker.runOnce();
      for(let i=0;i<2;i++)await f.run([{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'analysis-draft-v1',summary:'独立结果',claims:[],recommendations:[],openQuestions:[]})}}]);
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE member_id=?").get(f.b)).toEqual({n:0});
      expect(f.db.prepare("SELECT payload_json FROM domain_events WHERE kind='run.stepFailed' ORDER BY seq DESC LIMIT 1").get()).toMatchObject({payload_json:expect.stringContaining('成员执行配置已变化')});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('carries refreshed AUTO owner scope through planning, children and final integration',async()=>{
    const f=await fixture();try{
      const root=await f.send();
      f.db.prepare("UPDATE outbox SET status='done'").run();
      await f.cmd('member.setRuntime',{memberId:f.a,kind:'fake',permissionMode:'bypassPermissions',effort:'high'});
      await f.cmd('task.redispatch',{taskId:root.taskId});
      await f.run(output('当前配置新规划',f.plan));
      await f.run(output('新分析',undefined,{responseKind:'work'}));await f.run(output('新复核',undefined,{responseKind:'work'}));await f.run(output('整合成功',undefined,{responseKind:'work'}));
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId),JSON.stringify(f.db.prepare("SELECT kind,payload_json FROM domain_events WHERE kind LIKE '%Failed' OR kind LIKE '%Blocked' OR kind LIKE '%Invalid'").all())).toEqual({status:'DONE'});
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE (r.task_id=? OR r.task_id IN(SELECT id FROM tasks WHERE parent_task_id=?)) AND a.status='SUCCEEDED'").get(root.taskId,root.taskId)).toEqual({n:4});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('uses the explicit current owner configuration for a DIRECT continuation',async()=>{
    const f=await fixture();try{
      const root=await f.send([f.a]);f.db.prepare("UPDATE outbox SET status='done'").run();
      const before=f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId);
      await f.cmd('member.setRuntime',{memberId:f.a,kind:'fake',permissionMode:'bypassPermissions',effort:'high'});
      await f.cmd('task.redispatch',{taskId:root.taskId});await f.run(output('正常回复'));
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
      expect(f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId)).toEqual(before);
      expect(f.adapter.startTurnLog).toHaveLength(1);
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('captures a DELIB project document from actual changes without a files contract or duplicate document.markdown',async()=>{
    const f=await fixture(true);try{
      const root=await f.send([f.a,f.b]);await f.worker.runOnce();
      const content='# 独立必要证据\n\n按用户原文核对边界。\n';
      await f.run([{kind:'writeFile',path:'independent-evidence.md',content},{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({
        schemaVersion:'analysis-draft-v1',summary:'边界核对见 independent-evidence.md。',document:null,
        claims:[{claimId:'c1',statement:'用户已明确全额退费',kind:'observed',evidenceIds:[]}],recommendations:[],openQuestions:[],
      })}}]);
      const message=f.db.prepare("SELECT id,body_json FROM messages WHERE thread_id=? AND json_extract(body_json,'$.collaborationStage.stage')='INDEPENDENT'").get(root.threadId) as {id:string;body_json:string};
      expect(JSON.parse(message.body_json).document??null).toBeNull();
      const attachments=f.db.prepare('SELECT a.blob_path FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?').all(message.id) as Array<{blob_path:string}>;
      expect(attachments).toHaveLength(1);
      expect(readFileSync(attachments[0]!.blob_path,'utf8')).toBe(content);
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('binds planning coordinationPlan detail before child tasks exist and gives the child the full tail',async()=>{
    const f=await fixture();
    try{
      const root=await f.send();
      requireDetailBeforeChild(f.db,root.taskId);
      const detail=`# 规划完整详情\n\n${'规划证据。'.repeat(120)}\n\nR93_PLANNING_PLAN_TAIL`;
      await f.run(output('计划已提交',f.plan,{detailMarkdown:detail}));
      const step=f.db.prepare('SELECT child_task_id FROM coordination_steps WHERE run_id=(SELECT run_id FROM coordination_runs WHERE task_id=?) ORDER BY rowid LIMIT 1').get(root.taskId) as {child_task_id:string};
      expect(step.child_task_id).toBeTruthy();
      await f.run(output('分析完成'));
      assertDetailInContext(f.db,step.child_task_id,'R93_PLANNING_PLAN_TAIL');
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('binds planning handoff detail before downstream enqueue and gives the receiver the full tail',async()=>{
    const f=await fixture();
    try{
      const root=await f.send([f.a,f.b]);
      requireDetailBeforeChild(f.db,root.taskId);
      const detail=`# 交接规划详情\n\n${'交接证据。'.repeat(120)}\n\nR93_PLANNING_HANDOFF_TAIL`;
      await f.run(output('交接计划已提交',undefined,{
        responseKind:'work',detailMarkdown:detail,
        handoffs:[{toMemberId:f.b,purpose:'ask',message:'请接收者复核合成样例。'}],
      }));
      const handoff=f.db.prepare(`SELECT child_task_id FROM coordination_messages
        WHERE target_member_id=? AND purpose='ask' ORDER BY rowid DESC LIMIT 1`).get(f.b) as {child_task_id:string};
      expect(handoff.child_task_id).toBeTruthy();
      for(let i=0;i<4;i+=1){
        await f.run(output(`接收者完成复核${i+1}`));
        if(f.db.prepare('SELECT 1 FROM context_bundles WHERE turn_id IN (SELECT id FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id=?))').get(handoff.child_task_id))break;
      }
      assertDetailInContext(f.db,handoff.child_task_id,'R93_PLANNING_HANDOFF_TAIL');
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('projects model-authored DELIBERATE summary and Markdown detail verbatim without replacing the canonical artifact',async()=>{
    const f=await fixture(true);
    try{
      const root=await f.send([f.a,f.b]);
      await f.worker.runOnce();
      const next=f.db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key:string};
      const step=parseDelibStep(next.dispatch_key)!;
      const summary='阶段总览：完整证据与待确认事项见详情附件。';
      const detailMarkdown=`# 阶段完整详情\n\n${'这是需要完整保存但不应全部铺进聊天的证据。'.repeat(80)}\n\n待确认：R93_STAGE_CRITICAL_MARKER`;
      const document={filename:'阶段证据.md',purpose:'保留完整阶段证据与待确认事项',markdown:detailMarkdown};
      await f.run([{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({
        schemaVersion:'analysis-draft-v1',summary,document,
        claims:[{claimId:'c1',statement:'R93 阶段关键结论',kind:'proposal',evidenceIds:[]}],
        recommendations:['核对完整证据'],openQuestions:[],
      })}}]);
      const row=f.db.prepare(`SELECT id,body_json FROM messages
        WHERE thread_id=? AND json_extract(body_json,'$.collaborationStage.stage')='INDEPENDENT'
        ORDER BY rowid DESC LIMIT 1`).get(root.threadId) as {id:string;body_json:string};
      const body=JSON.parse(row.body_json) as {text:string;detailMarkdown?:string;document?:{filename?:string;purpose?:string;artifactId?:string;markdown?:string};collaborationStage?:{stage:string}};
      expect(body.collaborationStage?.stage).toBe('INDEPENDENT');
      expect(body.text).toBe(summary);
      expect(body.text).not.toContain('R93_STAGE_CRITICAL_MARKER');
      expect(body.detailMarkdown).toBeUndefined();
      expect(body.document).toMatchObject({filename:'阶段证据.md',purpose:'保留完整阶段证据与待确认事项'});
      expect(body.document?.artifactId).toBeTruthy();
      const attachment=f.db.prepare(`SELECT ma.id,a.id artifactId,a.kind,a.hash,a.blob_path,a.author_id
        FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?`).get(row.id) as
        {id:string;artifactId:string;kind:string;hash:string;blob_path:string;author_id:string};
      expect(attachment).toMatchObject({kind:'text_file',author_id:step.memberId});
      expect(attachment.id.startsWith('matt_detail_')).toBe(true);
      const fullDetail=readFileSync(attachment.blob_path,'utf8');
      expect(fullDetail).toBe(detailMarkdown);
      expect(fullDetail).toContain('这是需要完整保存但不应全部铺进聊天的证据');
      expect(fullDetail).toContain('R93_STAGE_CRITICAL_MARKER');
      expect(body.text.length).toBeLessThan(fullDetail.length);
      expect(attachment.hash).toBe(createHash('sha256').update(fullDetail, 'utf8').digest('hex'));
      const canonical=listRunArtifacts(f.db,step.runId,'analysis_draft');
      expect(canonical).toHaveLength(1);
      expect(canonical[0]!.author_id).toBe(step.memberId);
      expect(canonical[0]!.id).not.toBe(attachment.artifactId);
      const canonicalPayload=JSON.parse(readFileSync(canonical[0]!.blob_path,'utf8')) as {summary?:string;document?:{filename?:string;purpose?:string;markdown?:string};claims?:unknown[]};
      expect(canonicalPayload.summary).toBe(summary);
      expect(canonicalPayload.document).toEqual(document);
      expect(canonicalPayload.claims).toHaveLength(1);
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('keeps every model-authored synthesis dispute and final MD tail without programmatic excerpting',async()=>{
    const f=await fixture(true);
    try{
      const root=await f.send([f.a,f.b]);
      await f.worker.runOnce();
      const runId=(f.db.prepare("SELECT id FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE' ORDER BY rowid DESC LIMIT 1").get(root.taskId) as {id:string}).id;
      let synthesisStageSeen=false;
      for(let count=0;count<30;count+=1){
        const next=f.db.prepare("SELECT dispatch_key FROM outbox WHERE status='pending' ORDER BY id LIMIT 1").get() as {dispatch_key:string}|undefined;
        if(!next)break;
        const step=parseDelibStep(next.dispatch_key);expect(step).not.toBeNull();
        let value:unknown;
        if(step!.stage==='IND'){
          value={schemaVersion:'analysis-draft-v1',summary:`${step!.memberId}独立方案`,claims:[{claimId:'c1',statement:'方案甲可行',kind:'proposal',evidenceIds:[]}],recommendations:['核对约束'],openQuestions:[]};
        }else if(step!.stage==='CR'){
          const draft=listRunArtifacts(f.db,step!.runId,'analysis_draft').find(a=>a.author_id!==step!.memberId)!;
          value={schemaVersion:'cross-review-v1',reviews:[{targetArtifactId:draft.id,targetRevision:1,targetClaimId:'c1',stance:'agree',reason:'已读取他方方案，约束一致',evidenceIds:[]}]};
        }else if(step!.stage==='SYN'){
          const disputed=Array.from({length:5},(_,index)=>({
            statement:`需要保留的分歧 ${index+1}`,
            disagreementSummary:`这是需要完整保存但不应全部塞进摘要的分歧说明。${'证据和边界。'.repeat(12)}R93_SYN_DISPUTE_${index+1}_TAIL`,
            sourceRefs:['c1'],
          }));
          const detailMarkdown=`# 整合完整详情\n\n${disputed.map((item,index)=>`${index+1}. ${item.statement}\n   ${item.disagreementSummary}`).join('\n\n')}`;
          value={schemaVersion:'synthesis-v1',summary:'两位成员汇总的自然结论',document:{filename:'整合方案.md',purpose:'保留全部整合分歧与执行建议',markdown:detailMarkdown},issueResolutions:[],claims:[{statement:'按方案甲推进',sourceRefs:['c1']}],disputedClaims:disputed,recommendations:['下一步核实工程条件']};
          synthesisStageSeen=true;
        }else if(step!.stage==='RAT'){
          value={schemaVersion:'ratify-v1',responses:[{claimId:'clm_1',stance:'confirm'}]};
        }else throw Error(`非预期阶段 ${step!.stage}`);
        await f.run([{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify(value)}}]);
      }
      expect(synthesisStageSeen).toBe(true);
      const row=f.db.prepare(`SELECT id,body_json FROM messages
        WHERE thread_id=? AND json_extract(body_json,'$.collaborationStage.stage')='SYNTHESIS'
        ORDER BY rowid DESC LIMIT 1`).get(root.threadId) as {id:string;body_json:string};
      const body=JSON.parse(row.body_json) as {text:string;detailMarkdown?:string;document?:{artifactId?:string;filename?:string}};
      expect(body.text).toBe('两位成员汇总的自然结论');
      expect(body.detailMarkdown).toBeUndefined();
      expect(body.document?.artifactId).toBeTruthy();
      const attachment=f.db.prepare(`SELECT a.id artifactId,a.hash,a.blob_path FROM message_attachments ma
        JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?`).get(row.id) as {artifactId:string;hash:string;blob_path:string};
      const fullDetail=readFileSync(attachment.blob_path,'utf8');
      for(let index=1;index<=5;index+=1)expect(fullDetail).toContain(`R93_SYN_DISPUTE_${index}_TAIL`);
      expect(createHash('sha256').update(fullDetail,'utf8').digest('hex')).toBe(attachment.hash);
      const frozen=listRunArtifacts(f.db,runId,'synthesis');
      const ratify=listRunArtifacts(f.db,runId,'ratify_response');
      expect(frozen.length).toBeGreaterThan(0);
      expect(ratify.length).toBeGreaterThan(0);
      const frozenPayload=JSON.parse(readFileSync(frozen[0]!.blob_path,'utf8')) as {document?:{markdown?:string};disputedClaims?:unknown[]};
      expect(frozenPayload.document?.markdown).toBe(fullDetail);
      expect(frozenPayload.disputedClaims).toHaveLength(5);
      for(const artifact of [...frozen,...ratify]){
        expect(createHash('sha256').update(readFileSync(artifact.blob_path)).digest('hex')).toBe(artifact.hash);
        expect(artifact.id).not.toBe(attachment.artifactId);
      }
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });

  it('AUTO rework stays executing after its planning outbox settles and while child steps run',async()=>{
    const f=await fixture();try{
      const revision=(f.db.prepare('SELECT revision FROM projects WHERE id=?').get(f.projectId) as {revision:number}).revision;
      await f.cmd('project.reviewPolicy.set',{projectId:f.projectId,taskReviewEnabled:true,expectedRevision:revision});
      const root=await f.send();await f.run(output('计划',f.plan));await f.run(output('分析'));await f.run(output('评审'));await f.run(output('第一版'));
      const first=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=?').get(root.taskId) as {id:string;revision:number;manifest_hash:string;run_id:string};
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,decision:'changes_requested',note:'补充边界'});
      expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:false,deliveryId:first.id});
      const request={taskId:root.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,sourceRunId:first.run_id};
      await f.cmd('task.executeRework',request);expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:true});
      await f.run(output('新版计划',f.plan));
      expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key GLOB ? AND status!='done'").get(`task:${root.taskId}:redispatch*`)).toEqual({n:0});
      expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:true,deliveryId:first.id});
      const detail=await f.cmd<{reworkPending:{queued:boolean}}>('task.get',{taskId:root.taskId});expect(detail.reworkPending.queued).toBe(true);
      expect((await f.raw('task.executeRework',request)).ok).toBe(false);
      await f.run(output('新版分析'));expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:true});
      await f.run(output('新版评审'));await f.run(output('第二版'));expect(reworkPendingOf(f.db,root.taskId)).toBeNull();
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:2});
      const second=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(root.taskId) as typeof first;
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:second.id,deliveryRevision:2,manifestHash:second.manifest_hash,decision:'changes_requested',note:'第三版另行决定'});
      const other=await f.send();await f.run(output('另一任务计划',f.plan));
      expect(reworkPendingOf(f.db,root.taskId)).toMatchObject({queued:false,deliveryId:second.id});
      const otherRun=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(other.taskId) as {run_id:string};
      await f.cmd('task.stop',{taskId:other.taskId,targetRunId:otherRun.run_id,expectedStopGeneration:0});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('a peer opening session cannot launch after another detached member becomes UNKNOWN',async()=>{
    const f=await fixture(true,{detachedTurnConsumption:true,turnDeadlineMs:150,interruptGraceMs:10});let release=()=>{};
    try{
      for(const memberId of [f.a,f.b])await f.cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'plan'});
      const root=await f.send([f.a,f.b]);await f.worker.runOnce();
      await f.run([{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:2000}]);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'ACTIVE'});
      let entered!:()=>void;const openEntered=new Promise<void>(resolve=>{entered=resolve;});const barrier=new Promise<void>(resolve=>{release=resolve;});
      const original=f.adapter.openSession.bind(f.adapter);f.adapter.openSession=async input=>{entered();await barrier;return original(input);};
      const pending=f.run([{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'analysis-draft-v1',summary:'不可启动',claims:[{claimId:'c1',statement:'不可启动',kind:'proposal',evidenceIds:[]}],recommendations:[],openQuestions:[]})}}]);
      await openEntered;
      const deadline=Date.now()+3000;while(!f.db.prepare("SELECT 1 FROM agent_turns WHERE status='UNKNOWN'").get()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'").get()).toEqual({n:1});
      release();await pending;expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='CANCELLED' AND budget_mark='refunded'").get()).toEqual({n:1});
      const run=f.db.prepare('SELECT status,budget_json FROM workflow_runs').get() as {status:string;budget_json:string};expect(run.status).toBe('INTERRUPTED');
      expect(JSON.parse(run.budget_json)).toMatchObject({usedTurns:0,inFlightReservedTurns:1});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
    }finally{release();await f.adapter.closeAllSessions();await f.worker.awaitSettlement(1000);f.db.close();}
  });
  it('stopping the prepared second deliberation run leaves old success and cancels only this run',async()=>{
    const f=await fixture(true);try{
      const revision=(f.db.prepare('SELECT revision FROM projects WHERE id=?').get(f.projectId) as {revision:number}).revision;
      await f.cmd('project.reviewPolicy.set',{projectId:f.projectId,taskReviewEnabled:true,expectedRevision:revision});
      const root=await f.send([f.a,f.b]);await completeDeliberationRound(f);
      const first=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=?').get(root.taskId) as {id:string;revision:number;manifest_hash:string;run_id:string};
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,decision:'changes_requested',note:'请补充边界'});
      await f.cmd('task.executeRework',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,sourceRunId:first.run_id});
      await f.worker.runOnce();const next=f.db.prepare('SELECT id FROM workflow_runs ORDER BY rowid DESC LIMIT 1').get() as {id:string};
      const before=f.adapter.startTurnLog.length;
      await f.cmd('task.stop',{taskId:root.taskId,targetRunId:next.id,expectedStopGeneration:0});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(next.id)).toEqual({status:'CANCELLED'});
      await f.worker.drain();
      expect(f.adapter.startTurnLog).toHaveLength(before);
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(first.run_id)).toEqual({status:'SUCCEEDED'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(next.id)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare('SELECT status,current_delivery_id FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'CANCELLED',current_delivery_id:first.id});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('does not continue deliberation or falsely publish when a member result becomes UNKNOWN',async()=>{
    const f=await fixture(true,{turnDeadlineMs:20,interruptGraceMs:10});try{
      const root=await f.send([f.a,f.b]);await f.worker.runOnce();
      await f.run([{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:1000}]);
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
      expect((await f.raw('task.redispatch',{taskId:root.taskId})).ok).toBe(false);
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('zero parent budget starts no coordinator and no child',async()=>{
    const f=await fixture(false,{coordinationMaxCalls:0});try{
      await f.cmd('app.settings.set',{key:'callBudget.enabled',value:'true'});
      const root=await f.send();await f.run(output('不应启动',f.plan));
      expect(f.adapter.startTurnLog).toHaveLength(0);expect(f.db.prepare('SELECT count(*) n FROM workflow_runs').get()).toEqual({n:0});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
    }finally{f.db.close();}
  });
  it('an UNKNOWN child blocks parent success and fresh parent redispatch without releasing its original identity',async()=>{
    const f=await fixture(false,{turnDeadlineMs:20,interruptGraceMs:10});try{
      const root=await f.send();await f.run(output('计划',f.plan));
      await f.run([{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:1000}]);await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
      expect((await f.raw('task.redispatch',{taskId:root.taskId})).ok).toBe(false);
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'").get()).toEqual({n:1});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it('sends exact formal image bytes into each independent read-only deliberation input, zero inference',async()=>{
    const f=await fixture(true);try{
      // Saved program reference is a synthetic file; FakeRuntimeAdapter is the sole executor.
      const executable=join(f.dir,'fixture-codex.exe');writeFileSync(executable,'engineering reference, never spawned');
      for(const memberId of [f.a,f.b])await f.cmd('member.setRuntime',{memberId,kind:'codex',model:'gpt-6.1-sol',permissionMode:'plan',executable});
      const raw=readFileSync(join(process.cwd(),'scripts','dev25-dual','samples','preview-r52-样例.png'));
      const upload=await f.cmd<{attachmentId:string}>('attachment.uploadImage',{conversationId:f.room.conversationId,filename:'工程图片.png',contentBase64:raw.toString('base64')});
      const turns=vi.spyOn(f.adapter,'startTurn');
      await f.cmd('message.submit',{target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},body:'',intent:'default',collaboration:'deliberate',mentions:[f.a,f.b].map(memberId=>({kind:'member',memberId})),attachmentRefs:[upload.attachmentId]});
      await f.worker.runOnce();
      const done:FakeTurnScript=[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'analysis-draft-v1',summary:'工程协议输入验证',claims:[{claimId:'c1',statement:'夹具不作识图结论',kind:'proposal',evidenceIds:[]}],recommendations:[],openQuestions:[]})}}];
      await f.run(done);await f.run(done);
      expect(turns.mock.calls).toHaveLength(2);
      for(const [,request] of turns.mock.calls){expect(request.images).toHaveLength(1);expect(Buffer.from(request.images![0]!.dataBase64,'base64')).toEqual(raw);expect(request.policyId).toBe('policy-analyze');expect(request.outputSchema).toBeTruthy();}
    }finally{f.db.close();}
  });
  it('formal selected-member deliberation keeps effective full permissions, schemas, readable reports and version-bound rework',async()=>{
    const f=await fixture(true);try{
      const revision=(f.db.prepare('SELECT revision FROM projects WHERE id=?').get(f.projectId) as {revision:number}).revision;
      await f.cmd('project.reviewPolicy.set',{projectId:f.projectId,taskReviewEnabled:true,expectedRevision:revision});
      const sessions=vi.spyOn(f.adapter,'openSession'),turns=vi.spyOn(f.adapter,'startTurn');
      const root=await f.send([f.a,f.b]);
      const completeRound=()=>completeDeliberationRound(f);
      await completeRound();
      type Delivery={id:string;revision:number;manifest_hash:string;run_id:string};
      const first=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=?').get(root.taskId) as Delivery;
      expect(first.revision).toBe(1);expect(first.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
      // R91：正式研讨现在会把已验证阶段产物投影为串内正式消息（body_json.collaborationStage）。
      // 原契约继续成立：自然/交付消息仍恰好一条且正文是自然结论（不是阶段消息、不是原 JSON）。
      const agentMessages=f.db.prepare("SELECT id,author_id,body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY conversation_seq").all(root.taskId) as Array<{id:string;author_id:string;body_json:string}>;
      const parsedAgent=agentMessages.map(row=>({row,body:JSON.parse(row.body_json) as {text?:string;collaborationStage?:{stage:string;roundNo:number;turnId:string;runId:string}}}));
      const naturalMessages=parsedAgent.filter(item=>item.body.collaborationStage==null);
      expect(naturalMessages).toHaveLength(1);
      expect(naturalMessages[0]!.body.text).toContain('两位成员汇总的自然结论');
      expect(naturalMessages[0]!.body.text).not.toContain('schemaVersion');
      // R91 新增阶段消息：只断言真实产物投影（数量/作者/阶段/run 身份/稳定去重/作用域）。
      const stageMessages=parsedAgent.filter(item=>item.body.collaborationStage!=null);
      expect(stageMessages).toHaveLength(7);
      expect(new Set(stageMessages.map(item=>item.body.collaborationStage!.stage))).toEqual(new Set(['INDEPENDENT','CROSS_REVIEW','SYNTHESIS','RATIFY']));
      expect(new Set(stageMessages.map(item=>item.row.author_id))).toEqual(new Set([f.a,f.b]));
      for(const item of stageMessages){
        const stage=item.body.collaborationStage!;
        expect(stage.runId).toBe(first.run_id);
        expect(stage.turnId.length).toBeGreaterThan(0);
        expect(stage.roundNo).toBeGreaterThanOrEqual(0);
        expect(item.row.id.startsWith(`msg_delib_${stage.runId}_`)).toBe(true);
        expect(item.row.id).not.toContain(stage.turnId); // 稳定身份=run/阶段/成员/轮次，不是 turn 命名空间
      }
      const stageIdentities=stageMessages.map(item=>`${item.body.collaborationStage!.runId}|${item.body.collaborationStage!.stage}|${item.row.author_id}|${item.body.collaborationStage!.roundNo}`);
      expect(new Set(stageIdentities).size).toBe(stageMessages.length); // 不重复投影
      const calls=f.adapter.startTurnLog.length;
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:1,manifestHash:first.manifest_hash,decision:'changes_requested',note:'请补充实施约束'});
      expect(f.adapter.startTurnLog).toHaveLength(calls);
      await f.cmd('task.executeRework',{taskId:root.taskId,deliveryId:first.id,deliveryRevision:1,manifestHash:first.manifest_hash,sourceRunId:first.run_id});
      await completeRound();
      const second=f.db.prepare('SELECT * FROM task_deliveries WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(root.taskId) as Delivery;
      expect(second.revision,JSON.stringify({runs:f.db.prepare('SELECT id,status,stage FROM workflow_runs').all(),outbox:f.db.prepare("SELECT dispatch_key,status FROM outbox WHERE status!='done'").all(),events:f.db.prepare('SELECT kind,payload_json FROM domain_events ORDER BY seq DESC LIMIT 4').all()})).toBe(2);expect(second.manifest_hash).not.toBe(first.manifest_hash);
      expect(f.adapter.startTurnLog[calls]!.text).toContain('请补充实施约束');
      for(const call of sessions.mock.calls)expect(call[0].writeAccess?.modificationAuthorized).toBe(true);
      for(const call of turns.mock.calls)expect(call[1].outputSchema).toBeTruthy();
      const recorded=f.db.prepare('SELECT s.capabilities_json FROM runtime_sessions s JOIN agent_turns a ON a.session_id=s.id').all() as {capabilities_json:string}[];
      expect(recorded).toHaveLength(f.adapter.startTurnLog.length);for(const row of recorded)expect(JSON.parse(row.capabilities_json)).toMatchObject({effectivePolicy:'policy-full-access',writeAccessMode:{fullAccess:true,modificationAuthorized:true},runtime:{kind:'fake'}});
      await f.cmd('task.review',{taskId:root.taskId,deliveryId:second.id,deliveryRevision:2,manifestHash:second.manifest_hash,decision:'accept'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
    }finally{f.db.close();}
  });
  it('publishes a readable planning message before any child finishes, retaining the original protocol in formal history',async()=>{
    const f=await fixture();try{
      const root=await f.send(),answer='已排好分工，正在逐步执行。';await f.run(output(answer,f.plan));
      expect(f.adapter.startTurnLog).toHaveLength(1);expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
      const row=f.db.prepare("SELECT id,body_json FROM messages WHERE thread_id=? AND author_type='agent' ORDER BY conversation_seq DESC LIMIT 1").get(root.threadId) as {id:string;body_json:string},saved=JSON.parse(row.body_json) as {text:string;runtimeControlResult:string};
      expect(saved.text).toBe(answer);expect(JSON.parse(saved.runtimeControlResult).coordinationPlan).toEqual(f.plan);
      const history=await f.cmd<{items:Array<{id:string;body:{text:string;runtimeControlResult:string}}>}>('thread.history',{threadId:root.threadId});expect(history.items.find(m=>m.id===row.id)?.body).toEqual(saved);
      const pool=await f.cmd<{items:Array<{threadId:string;taskId:string;replyCount:number}>}>('room.pool',{roomId:f.room.id});expect(pool.items.find(m=>m.threadId===root.threadId)).toMatchObject({taskId:root.taskId,replyCount:1});
      expect(f.db.prepare('SELECT body_json FROM messages WHERE id=?').get(row.id)).toEqual({body_json:row.body_json});
    }finally{f.db.close();}
  });
  it('creates genuine independent children, freezes upstream versions, integrates and reopens',async()=>{
    const f=await fixture();
    try{
      const root=await f.send();await f.run(output('准备分工',f.plan));
      expect((f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId) as {status:string}).status).toBe('ACTIVE');
      expect((f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId) as {n:number}).n).toBe(2);
      const child=f.db.prepare('SELECT id FROM tasks WHERE parent_task_id=? ORDER BY rowid LIMIT 1').get(root.taskId) as {id:string};
      const located=await f.cmd<{taskId:string;parentTaskId:string;threadId:string}>('deepLink.resolve',{hash:`#task=${child.id}`});
      expect(located).toMatchObject({taskId:child.id,parentTaskId:root.taskId,threadId:root.threadId});
      const board=await f.cmd<{groups:Array<{rooms:Array<{cards:Array<{taskId:string}>}>}>}>('board.view',{scope:'project',projectId:f.projectId});
      expect(board.groups.flatMap(g=>g.rooms.flatMap(r=>r.cards)).map(c=>c.taskId)).toEqual([root.taskId]);
      await f.run(output('上游独立分析：采用方案甲'));
      await f.run(output('独立复核已读取方案甲'));
      expect(f.adapter.startTurnLog[2]!.text).toContain('上游独立分析：采用方案甲');
      expect(f.adapter.startTurnLog[2]!.text).toContain('manifest_hash');
      await f.run(output('综合两位成员结论'));
      expect(f.adapter.startTurnLog).toHaveLength(4);
      expect((f.db.prepare('SELECT state FROM coordination_runs').get() as {state:string}).state).toBe('completed');
      expect((f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId) as {n:number}).n).toBe(1);
      const saved=f.db.prepare('SELECT child_task_id,handoff_json FROM coordination_steps ORDER BY step_key').all();
      f.db.close();const reopened=openDatabase(join(f.dir,'state.sqlite'));
      expect(reopened.prepare('SELECT child_task_id,handoff_json FROM coordination_steps ORDER BY step_key').all()).toEqual(saved);reopened.close();
    }finally{if(f.db.open)f.db.close();}
  });
  it('does not duplicate a planned downstream child when the upstream step also emits a handoff',async()=>{
    const f=await fixture();
    try{
      const root=await f.send();
      await f.run(output('准备分工',f.plan));
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:2});
      await f.run(output('分析完成',undefined,{
        responseKind:'work',
        handoffs:[{toMemberId:f.b,message:'请复核上游分析',purpose:'review'}],
      }));
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:2});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_messages').get()).toEqual({n:0});
      expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE kind='member.messageIgnoredRedundantPlan'").get()).toEqual({n:1});
      await f.run(output('评审完成'));
      await f.run(output('综合完成'));
      expect(f.db.prepare('SELECT count(*) n FROM coordination_steps').get()).toEqual({n:2});
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'completed'});
    }finally{f.db.close();}
  });
  it('rejects a model-invented member without creating children or dispatching it',async()=>{
    const f=await fixture();try{
      const other=join(f.dir,'other-project');mkdirSync(other);
      const foreignProject=(await f.cmd<{project:{id:string}}>('project.open',{path:other})).project.id;
      const foreignMember=(await f.cmd<{memberId:string}>('member.create',{projectId:foreignProject,displayName:'同名成员'})).memberId;
      const root=await f.send();await f.run(output('计划',{...f.plan,steps:[{...f.plan.steps[0],memberId:foreignMember}]}));
      expect((f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId) as {n:number}).n).toBe(0);
      expect((f.db.prepare('SELECT state FROM coordination_runs').get() as {state:string}).state).toBe('blocked');
      expect(f.adapter.startTurnLog).toHaveLength(1);
    }finally{f.db.close();}
  });
  it('keeps ordinary no-mention questions as one natural coordinator response',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('你好！',undefined,{coordinationPlan:null}));
      expect((f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId) as {status:string}).status).toBe('DONE');
      expect((f.db.prepare('SELECT count(*) n FROM coordination_steps').get() as {n:number}).n).toBe(0);
      const first=f.db.prepare("SELECT body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY conversation_seq DESC LIMIT 1").get(root.taskId) as {body_json:string};expect(JSON.parse(first.body_json).text).toBe('你好！');expect(JSON.parse(JSON.parse(first.body_json).runtimeControlResult).coordinationPlan).toBeNull();expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
      expect(f.adapter.startTurnLog).toHaveLength(1);
      await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId},body:'刚才说了什么？',intent:'default',mentions:[]});
      await f.run(output('刚才向你问好了。'));expect(f.adapter.startTurnLog).toHaveLength(2);
      expect((f.db.prepare('SELECT count(*) n FROM tasks').get() as {n:number}).n).toBeGreaterThanOrEqual(1);
    }finally{f.db.close();}
  });
  it('parent stop before the next child dispatch cancels queued work without new calls',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',f.plan));
      const run=f.db.prepare('SELECT run_id FROM coordination_runs').get() as {run_id:string};
      await f.cmd('task.stop',{taskId:root.taskId,targetRunId:run.run_id,expectedStopGeneration:0});
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare("SELECT count(*) n FROM tasks WHERE parent_task_id=? AND status!='CANCELLED'").get(root.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('configuration changes after planning prevent old-snapshot child execution',async()=>{
    const f=await fixture();try{
      await f.send();await f.run(output('计划',f.plan));
      await f.cmd('member.setRuntime',{memberId:f.a,kind:'fake',permissionMode:'bypassPermissions',effort:'high'});
      await f.run(output('不可发出'));await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
    }finally{f.db.close();}
  });
  it('does not silently elevate a read-only member to implement a plan',async()=>{
    const f=await fixture();try{
      await f.cmd('member.setRuntime',{memberId:f.b,kind:'fake',permissionMode:'plan'});
      const root=await f.send();await f.run(output('不合法提权计划',{summary:'只读成员不写文件',steps:[{...f.plan.steps[1],role:'implementation',dependsOn:[]}]}));
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:0});
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
    }finally{f.db.close();}
  });
  it('stopping while a child session opens prevents startTurn and leaves no runnable siblings',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',f.plan));
      let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
      const original=f.adapter.openSession.bind(f.adapter);
      f.adapter.openSession=async input=>{await barrier;return original(input);};
      const opening=f.run(output('不应执行'));
      await new Promise<void>(resolve=>setImmediate(resolve));
      const run=f.db.prepare('SELECT run_id FROM coordination_runs').get() as {run_id:string};
      await f.cmd('task.stop',{taskId:root.taskId,targetRunId:run.run_id,expectedStopGeneration:0});
      release();await opening;await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status IN ('RUNNING','STOPPING')").get()).toEqual({n:0});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'CANCELLED'});
    }finally{f.db.close();}
  });
  it('does not falsely integrate when a child explicitly fails',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',f.plan));
      await f.run([{kind:'event',event:{kind:'turn.failed',code:'PROVIDER_ERROR',message:'隔离故障',retryable:false}}]);await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('rejects a plan exceeding the aggregate parent budget including integration reserve',async()=>{
    const f=await fixture();try{
      await f.cmd('app.settings.set',{key:'callBudget.enabled',value:'true'});
      const root=await f.send();const steps=Array.from({length:4},(_,i)=>({...f.plan.steps[0]!,key:`step${i}`}));await f.run(output('过量计划',{...f.plan,steps}));
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:0});
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
    }finally{f.db.close();}
  });
  it('refuses stale file bytes before the reviewer starts, preserving the original delivery',async()=>{
    const f=await fixture();try{
      const root=await f.send();const plan={...f.plan,steps:[{...f.plan.steps[0]!,role:'implementation'},f.plan.steps[1]!]};await f.run(output('计划',plan));
      await f.run([{kind:'writeFile',path:'result.txt',content:'original'},...output('已生成文件')]);
      writeFileSync(join(f.dir,'project','result.txt'),'external-change');
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'BLOCKED'});
    }finally{f.db.close();}
  });
  it.each([false,true])('accepts dependent implementation versions with a forward-reference array=%s',async reverse=>{
    const f=await fixture();try{
      const root=await f.send();const plan={...f.plan,steps:f.plan.steps.map((s,i)=>({...s,role:'implementation',objective:i?'读取上游并完善文件':'创建文件'}))};
      if(reverse)plan.steps.reverse();
      await f.run(output('计划',plan));
      await f.run([{kind:'writeFile',path:'result.txt',content:'managed-v1'},...output('第一版')]);
      await f.run([{kind:'writeFile',path:'result.txt',content:'managed-v2'},...output('完善第二版')]);
      await f.run(output('最终整合'));
      expect(readFileSync(join(f.dir,'project','result.txt'),'utf8')).toBe('managed-v2');
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'completed'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:1});
      const saved=f.db.prepare('SELECT handoff_json FROM coordination_steps ORDER BY rowid').all() as {handoff_json:string}[];
      const hashes=saved.map(s=>(JSON.parse(s.handoff_json) as {output:{files:{sha256:string}[]}}).output.files[0]!.sha256);
      expect(hashes[0]).not.toBe(hashes[1]);
    }finally{f.db.close();}
  });
  it.each(['dependent','unrelated','external-change'] as const)('keeps the write → review → revision chain honest: %s',async variant=>{
    const f=await fixture();try{
      const root=await f.send();
      const steps=[
        {key:'write',memberId:f.a,title:'初稿',objective:'创建统一文档',role:'implementation',dependsOn:[]},
        {key:'review',memberId:f.b,title:'核对',objective:'检查初稿并提出纠正',role:'review',dependsOn:['write']},
        {key:'revise',memberId:f.a,title:'后继修订',objective:'根据核对结果修订初稿',role:'implementation',dependsOn:variant==='unrelated'?[]:['review']},
      ];
      await f.run(output('明确初稿、复核及后继修订分工',{summary:'统一文档版本链',steps}));
      await f.run([{kind:'writeFile',path:'decision.md',content:'# 初稿\n金额待核对'},...output('初稿完成')]);
      await f.run(output('复核发现实际付款应含税，交回作者修订'));
      await f.run([{kind:'writeFile',path:'decision.md',content:'# 定稿\n含税金额已更正'},...output('已按复核纠正含税金额')]);
      if(variant==='external-change')writeFileSync(join(f.dir,'project','decision.md'),'未经交付的外部修改');
      await f.run(output('统一交付：已核验含税金额'));
      const coordination=f.db.prepare('SELECT state,error_message FROM coordination_runs WHERE task_id=?').get(root.taskId) as {state:string;error_message:string|null};
      if(variant==='dependent'){
        expect(coordination.state).toBe('completed');
        expect(f.adapter.startTurnLog).toHaveLength(5); // plan + write + review + revise + one integration
        expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:1});
        expect(readFileSync(join(f.dir,'project','decision.md'),'utf8')).toContain('含税金额已更正');
        const handoffs=f.db.prepare('SELECT step_key,handoff_json FROM coordination_steps ORDER BY rowid').all() as Array<{step_key:string;handoff_json:string}>;
        const first=JSON.parse(handoffs.find(row=>row.step_key==='write')!.handoff_json) as {output:{id:string;files:Array<{sha256:string}>}};
        const review=JSON.parse(handoffs.find(row=>row.step_key==='review')!.handoff_json) as {upstream:Array<{id:string}>};
        const last=JSON.parse(handoffs.find(row=>row.step_key==='revise')!.handoff_json) as {output:{files:Array<{sha256:string}>}};
        expect(review.upstream[0]?.id).toBe(first.output.id);
        expect(first.output.files[0]?.sha256).not.toBe(last.output.files[0]?.sha256);
      }else{
        expect(coordination.state).toBe('blocked');
        expect(coordination.error_message).toContain(variant==='unrelated'?'没有显式依赖交接':'文件字节已变化');
        expect(f.adapter.startTurnLog).toHaveLength(4);
        expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
      }
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
  it.each(['unchanged','downstream','integration'] as const)('binds review to its actual input version when final files are %s',async variant=>{
    const f=await fixture();try{
      const root=await f.send();
      const steps=[{key:'impl',memberId:f.a,title:'实施',objective:'创建结果',role:'implementation',dependsOn:[]},{key:'review',memberId:f.b,title:'评审',objective:'读取上游文件',role:'review',dependsOn:['impl']}];
      if(variant==='downstream')steps.push({key:'revise',memberId:f.a,title:'完善',objective:'修改文件',role:'implementation',dependsOn:['review']});
      await f.run(output('计划',{summary:'核对评审版本',steps}));
      await f.run([{kind:'writeFile',path:'result.txt',content:'v1'},...output('第一版')]);
      await f.run(output('已读第一版'));
      if(variant==='downstream')await f.run([{kind:'writeFile',path:'result.txt',content:'v2'},...output('第二版')]);
      await f.run([...(variant==='integration'?[{kind:'writeFile' as const,path:'result.txt',content:'v3'}]:[]),...output('整合')]);
      const detail=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projectId,taskId:root.taskId});
      const review=detail.coordination!.steps.find(s=>s.key==='review')!;
      expect(review.reviewVersionCurrent).toBe(variant==='unchanged');
      expect(review.inputVersions).toHaveLength(1);
      const child=detail.coordination!.steps.find(s=>s.key==='impl')!;
      expect(review.inputVersions![0]).toMatchObject({deliveryId:child.deliveryId,revision:child.deliveryRevision,manifestHash:child.manifestHash});
      const selected=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projectId,taskId:child.taskId,conversationId:f.room.conversationId,deliveryId:child.deliveryId});
      expect(selected.deliveries.some(d=>d.id===child.deliveryId&&d.runId===selected.selectedRunId)).toBe(true);
      expect((await f.raw('task.details',{projectId:f.projectId,taskId:review.taskId,deliveryId:child.deliveryId})).ok).toBe(false);
    }finally{f.db.close();}
  });
  it('keeps explicit integration format repair in the original plan and aggregate budget',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('计划',f.plan));await f.run(output('分析甲'));await f.run(output('复核甲'));
      await f.run(output('坏协议',undefined,{remainingIssues:123}));
      const original=f.db.prepare('SELECT run_id FROM coordination_runs').get() as {run_id:string};
      const facts=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projectId,taskId:root.taskId});
      expect(facts.failedRetry).toMatchObject({available:true,formatRepair:true,pending:false});
      await f.cmd('task.redispatch',{taskId:root.taskId,formatRepair:true,reason:'人工明确修复原输出',sourceRunId:facts.latestRunId,expectedRunStatus:'FAILED',expectedTaskRevision:facts.task.revision,expectedStopGeneration:facts.task.stopGeneration});
      const queued=await f.cmd<TaskDetailsResult>('task.details',{projectId:f.projectId,taskId:root.taskId});expect(queued.failedRetry).toMatchObject({available:false,pending:true});
      await f.run(output('合法整合'));
      expect(f.adapter.startTurnLog).toHaveLength(5);
      expect(f.db.prepare('SELECT count(*) n FROM coordination_runs').get()).toEqual({n:1});
      expect(f.db.prepare('SELECT state FROM coordination_runs WHERE run_id=?').get(original.run_id)).toEqual({state:'completed'});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_integration_attempts WHERE coordination_run_id=?').get(original.run_id)).toEqual({n:2});
      const delivery=f.db.prepare('SELECT artifact_refs_json FROM task_deliveries WHERE task_id=?').get(root.taskId) as {artifact_refs_json:string};
      expect(JSON.parse(delivery.artifact_refs_json)).toHaveLength(3);
    }finally{f.db.close();}
  });
  it('still refuses two independent implementations overwriting the same file without a dependency',async()=>{
    const f=await fixture();try{
      const root=await f.send();const steps=f.plan.steps.map(s=>({...s,role:'implementation',dependsOn:[]}));
      await f.run(output('计划',{...f.plan,steps}));
      await f.run([{kind:'writeFile',path:'result.txt',content:'first'},...output('首次实施')]);
      await f.run([{kind:'writeFile',path:'result.txt',content:'second'},...output('无依赖覆盖')]);
      await f.worker.runOnce();expect(f.adapter.startTurnLog).toHaveLength(3);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('rejects recreation of an absent file before review (isolated fake deletion injection)',async()=>{
    const f=await fixture();try{
      const path=join(f.dir,'project','removed.txt');writeFileSync(path,'before');
      const root=await f.send();await f.run(output('计划',{...f.plan,steps:[{...f.plan.steps[0],role:'implementation'},f.plan.steps[1]]}));
      const events=f.adapter.events.bind(f.adapter);let removed=false;
      f.adapter.events=async function*(session){for await(const event of events(session)){if(event.kind==='turn.completed'&&!removed){unlinkSync(path);removed=true;}yield event;}};
      await f.run(output('工程夹具模拟删除'));
      writeFileSync(path,'EXTERNAL RECREATION');
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'blocked'});
      expect(f.db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(root.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('does not starve current work behind more than 100 closed cancellation records (history fixture)',async()=>{
    const f=await fixture();try{
      const old=await f.send();await f.run(output('旧计划',f.plan));
      const prior=f.db.prepare('SELECT run_id FROM coordination_runs').get() as {run_id:string};
      await f.cmd('task.stop',{taskId:old.taskId,targetRunId:prior.run_id,expectedStopGeneration:0});await f.worker.runOnce();
      // Historical scale injection is separate from normal task-state generation above.
      for(let i=0;i<105;i++){const id=`history_${i}`;
        f.db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES(?,?,?,?,'AUTO','CANCELLED')").run(id,old.taskId,f.room.conversationId,old.threadId);
        f.db.prepare("INSERT INTO coordination_runs(run_id,task_id,stop_generation,state,created_at) VALUES(?,?,1,'cancelled',?)").run(id,old.taskId,i);
      }
      await f.send();await f.run(output('新计划',f.plan));await f.run(output('新任务实际开始'));
      expect(f.adapter.startTurnLog).toHaveLength(3);
      expect((f.db.prepare("SELECT count(*) n FROM task_deliveries d JOIN tasks t ON t.id=d.task_id WHERE t.parent_task_id!=?").get(old.taskId) as {n:number}).n).toBe(1);
    }finally{f.db.close();}
  });
});


describe('R116 user confirmation in independent collaboration steps',()=>{
  it('continues independent work, takes a reply in the same thread and resumes the original child',async()=>{
    const f=await fixture(false,{coordinationMaxCalls:20});
    try{
      const root=await f.send();
      const plan={summary:'先推进可独立处理的工作',steps:[
        {...f.plan.steps[0]!,key:'choice',objective:'需要用户选择后完成'},
        {...f.plan.steps[1]!,key:'independent',dependsOn:[],objective:'不依赖选择的独立核对'},
        {...f.plan.steps[1]!,key:'dependent',dependsOn:['choice'],objective:'读取选择后的成果'},
      ]};
      await f.run(output('安排独立工作',plan));
      const choice=f.db.prepare("SELECT child_task_id id FROM coordination_steps WHERE step_key='choice'").get() as {id:string};
      await f.run(output('已保存可确认部分',undefined,{responseKind:'work',userQuestion:'请选择方案甲或乙；建议甲'}));
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(choice.id)).toEqual({status:'WAITING_USER'});
      expect(f.db.prepare("SELECT body_json FROM messages WHERE task_id=? AND body_json LIKE '%请选择方案甲或乙%' LIMIT 1").get(choice.id)).toBeTruthy();
      expect(f.db.prepare('SELECT state FROM coordination_runs').get()).toEqual({state:'running'});
      expect(await f.run(output('独立核对已完成',undefined,{responseKind:'work'}))).toBe(true);
      expect(await f.worker.runOnce()).toBe(false);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'WAITING_USER'});
      expect(readTaskExecutionStatus(f.db,root.taskId)?.waitingForUser?.message).toBe('请选择方案甲或乙；建议甲');
      expect(await f.worker.runOnce()).toBe(false);
      const recovery=applyRecovery(f.db,Date.now());
      expect(recovery).toMatchObject({interruptedRuns:0,unknownTurns:0});
      const reply=await f.cmd<{messageId:string}>('message.submit',{
        target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId},
        body:'选择方案甲，请接着原步骤做',intent:'default',mentions:[],
      });
      expect(f.db.prepare('SELECT task_id FROM thread_reply_requests WHERE message_id=?').get(reply.messageId)).toEqual({task_id:choice.id});
      expect(await f.run(output('按选择甲完成原步骤',undefined,{responseKind:'work'}))).toBe(true);
      expect(f.adapter.startTurnLog.at(-1)?.text).toContain('选择方案甲，请接着原步骤做');
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(choice.id)).toEqual({status:'DONE'});
      expect(await f.run(output('依赖复核完成',undefined,{responseKind:'work'}))).toBe(true);
      expect(f.adapter.startTurnLog.at(-1)?.text).toContain('按选择甲完成原步骤');
      expect(await f.run(output('整合前需要选择发布位置',undefined,{responseKind:'work',userQuestion:'请确认发布在项目目录还是另存'}))).toBe(true);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'WAITING_USER'});
      await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId},body:'发布在项目目录',intent:'default',mentions:[]});
      expect(await f.run(output('工作全部完成',undefined,{responseKind:'work'}))).toBe(true);
      expect(f.adapter.startTurnLog.at(-1)?.text).toContain('发布在项目目录');
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
      expect(readTaskExecutionStatus(f.db,root.taskId)?.waitingForUser).toBeNull();
      expect(f.db.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(root.taskId)).toEqual({n:3});
      expect(f.db.prepare("SELECT count(*) n FROM agent_turns WHERE status='FAILED'").get()).toEqual({n:0});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
});


describe('R116 complete file handoff without arbitrary file counts',()=>{
  it('verifies 101 actual changed files and preserves all of them for the reviewer',async()=>{
    const f=await fixture();try{
      const root=await f.send();await f.run(output('准备修改后复核',f.plan));
      const writes:FakeTurnScript=[...Array.from({length:101},(_,i)=>({kind:'writeFile' as const,path:`part-${i}.md`,content:`完整成果${i}`})),
        ...output('已完成101个文件',undefined,{responseKind:'work'})];
      await f.run(writes);
      expect(await f.run(output('逐一核验101个文件',undefined,{responseKind:'work'}))).toBe(true);
      const source=f.db.prepare("SELECT handoff_json FROM coordination_steps WHERE step_key='analysis'").get() as {handoff_json:string};
      expect(JSON.parse(source.handoff_json).output.files).toHaveLength(101);
      expect(f.adapter.startTurnLog.at(-1)?.text).toContain('part-100.md');
      await f.run(output('全部核验并交付',undefined,{responseKind:'work'}));
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
});


describe('R116 confirmation routing boundaries',()=>{
  it('requires a recipient for different pending questions and preserves stop after a reply is queued',async()=>{
    const f=await fixture();try{
      const root=await f.send();
      await f.run(output('两项独立工作',{...f.plan,steps:[f.plan.steps[0]!,{...f.plan.steps[1]!,dependsOn:[]}]}));
      await f.run(output('问题甲',undefined,{userQuestion:'甲的方案是否采用？'}));
      await f.run(output('问题乙',undefined,{userQuestion:'乙的日期是否采用？'}));
      await f.worker.runOnce();
      const target={kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId};
      const ambiguous=await f.raw('message.submit',{target,body:'可以',intent:'default',mentions:[]});
      expect(ambiguous.ok).toBe(false);expect(JSON.stringify(ambiguous.error)).toContain('@');
      const reply=await f.cmd<{messageId:string}>('message.submit',{target,body:'乙按建议日期进行',intent:'default',mentions:[{kind:'member',memberId:f.b}]});
      const child=f.db.prepare("SELECT child_task_id id FROM coordination_steps WHERE step_key='review'").get() as {id:string};
      expect(f.db.prepare('SELECT task_id FROM thread_reply_requests WHERE message_id=?').get(reply.messageId)).toEqual({task_id:child.id});
      const before=f.adapter.startTurnLog.length;
      const parentRun=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(root.taskId) as {run_id:string};
      await f.cmd('task.stop',{taskId:root.taskId,targetRunId:parentRun.run_id,expectedStopGeneration:0});
      await f.worker.runOnce();
      expect(f.adapter.startTurnLog).toHaveLength(before);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'CANCELLED'});
    }finally{await f.adapter.closeAllSessions();f.db.close();}
  });
});
