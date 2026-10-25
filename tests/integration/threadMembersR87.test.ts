import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import type {ThreadMembersSnapshot} from '../../src/contracts/threadMembers.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {successTurn,type FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {runtimeProgressWaitLabel,type ThreadVisibleProgress} from '../../src/contracts/runtimeProgress.ts';
import {seedExplicitRecipientCoordination} from '../../src/daemon/coordination.ts';
import {readThreadMembers} from '../../src/daemon/threadMembers.ts';

afterEach(()=>vi.unstubAllEnvs());
async function fixture(legacyExplicit=false){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r87-members-')),project=join(dir,'project');mkdirSync(project);
  const file=join(dir,'state.sqlite');const db=openDatabase(file);
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:async()=>{}};
  const raw=async<T>(method:string,params:unknown,id:string=randomUUID())=>await dispatchDaemonCommand(deps,{protocolVersion:1,commandId:id,method,params}) as {ok:boolean;data:T;replayed?:boolean;error?:{code:string}};
  const cmd=async<T>(method:string,params:unknown,id?:string)=>{
    const r=await raw<T>(method,params,id);expect(r.ok,JSON.stringify(r.error)).toBe(true);
    const input=params as {target?:{kind:string;threadId?:string};body?:string;collaboration?:string;mentions?:Array<{kind:string;memberId?:string}>};
    if(legacyExplicit&&method==='message.submit'&&input.collaboration!=='deliberate'&&(input.mentions?.some(m=>m.kind==='all')||(input.mentions?.length??0)>1)){
      const sent=r.data as {taskId:string;messageId:string};
      const recipients=input.mentions!.some(m=>m.kind==='all')?readThreadMembers(db,input.target!.threadId!).eligibleMemberIds:input.mentions!.map(m=>m.memberId!);
      db.prepare("DELETE FROM outbox WHERE dispatch_key IN (?,?) AND status='pending'").run(`task:${sent.taskId}:initial`,`task:${sent.taskId}:thread-reply:${sent.messageId}`);
      db.prepare('DELETE FROM thread_reply_requests WHERE message_id=?').run(sent.messageId);
      seedExplicitRecipientCoordination(db,sent.taskId,sent.messageId,input.body!,recipients);
    }
    return r.data;
  };
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:Array<{id:string;conversationId:string}>}>('room.list',{projectId})).items[0]!;
  const ids:string[]=[];for(const name of ['同名','同名','房间其他成员'])ids.push((await cmd<{memberId:string}>('member.create',{projectId,displayName:name})).memberId);
  const root=await cmd<{threadId:string;taskId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'你好',intent:'default',mentions:[{kind:'member',memberId:ids[0]}]});
  const get=async()=>(await cmd<{members:ThreadMembersSnapshot}>('thread.get',{threadId:root.threadId})).members;
  const change=(memberId:string,action:'add'|'remove',expectedVersion:string)=>({projectId,threadId:root.threadId,memberId,action,expectedVersion});
  return{dir,file,db,raw,cmd,get,change,ids,projectId,room,root};
}

describe('R87 durable thread participants, formal commands, zero inference',()=>{
  it('does not borrow a long-running stage clock for a member that has never started execution',async()=>{
    const f=await fixture();try{
      f.db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status,stage,stage_started_at) VALUES('run_not_started',?,?,?,'DIRECT','RUNNING','INDEPENDENT',?)")
        .run(f.root.taskId,f.room.conversationId,f.root.threadId,Date.now()-17*60_000);
      f.db.prepare("INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status) VALUES('turn_not_started','run_not_started',?,?,?,'delib.independent','PENDING')")
        .run(f.room.conversationId,f.root.threadId,f.ids[0]);
      for(const status of ['PENDING','RUNNING']){
        f.db.prepare('UPDATE agent_turns SET status=? WHERE id=?').run(status,'turn_not_started');
        const progress=(await f.cmd<{progress:ThreadVisibleProgress[]}>('thread.get',{threadId:f.root.threadId})).progress[0]!;
        expect(progress.executionStartedAt).toBeNull();expect(progress.waitStartedAt).toBeNull();expect(progress.lastActivityAt).toBeNull();
        expect(runtimeProgressWaitLabel(progress)).toBe(status==='PENDING'?'等待执行席位':'准备执行');
      }
    }finally{f.db.close();}
  });
  it('an explicit AI request can start in a record thread without resending its private record or duplicating the root',async()=>{
    const f=await fixture();try{
      const record=await f.cmd<{threadId:string;messageId:string}>('message.submit',{target:{kind:'room_root',projectId:f.projectId,conversationId:f.room.conversationId,roomId:f.room.id},body:'PRIVATE_RECORD_ONLY',intent:'record_only',mentions:[]});
      const before=(await f.cmd<{members:ThreadMembersSnapshot}>('thread.get',{threadId:record.threadId})).members;
      await f.cmd('thread.members.change',{projectId:f.projectId,threadId:record.threadId,memberId:f.ids[0],action:'add',expectedVersion:before.version});
      const sent=await f.cmd<{taskId:string;messageId:string}>('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:record.threadId},body:'这是新的公开问题',intent:'default',mentions:[]});
      const finish:FakeTurnScript=[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',answer:'这是新问题的回答',changeSummary:'这是新问题的回答',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}];
      const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({turnScriptSequencer:()=>finish}),leaseOwner:'r87-record',appDataDir:f.dir});
      await worker.runOnce();await worker.runOnce();
      const bundle=f.db.prepare('SELECT included_refs_json FROM context_bundles c JOIN agent_turns a ON a.id=c.turn_id JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(sent.taskId) as {included_refs_json:string};
      expect(bundle.included_refs_json).toContain('这是新的公开问题');expect(bundle.included_refs_json).not.toContain('PRIVATE_RECORD_ONLY');
      expect(f.db.prepare('SELECT task_id FROM messages WHERE id=?').get(record.messageId)).toEqual({task_id:null});
      expect(f.db.prepare('SELECT anchor_message_id FROM conversation_threads WHERE id=?').get(record.threadId)).toEqual({anchor_message_id:record.messageId});
      expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:2});
    }finally{f.db.close();}
  });
  it('V51 persisted: thread all fans out to every current participant, excludes room C, and keeps each reply visible',async()=>{
    const f=await fixture(true);try{
      const answers=['你好！','甲的明确回复','乙的明确回复'];
      let index=0;const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({structuredFinal:false,turnScriptSequencer:(input)=>{
        const match=input.text.match(/resultKey=([^；\n]+)/)??input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key=match?.[1]??'result_unknown';
        const answer=answers[index++]!;
        const finalText=JSON.stringify({schemaVersion:'task-complete-v1',resultKey:key,responseKind:'conversation',answer,changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],handoffs:[]});
        return[{kind:'event',event:{kind:'message.completed',messageId:`r89_${index}`,text:finalText}},{kind:'event',event:{kind:'turn.completed',finalText}}] as FakeTurnScript;
      }}),leaseOwner:'r89-thread-all',appDataDir:f.dir});
      await worker.runOnce();
      const added=await f.cmd<ThreadMembersSnapshot>('thread.members.change',f.change(f.ids[1]!,'add',(await f.get()).version));
      const sent=await f.cmd<{messageId:string;taskId:string}>('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:f.root.threadId},body:'@全体 请分别回复',intent:'default',mentions:[{kind:'all'}],threadMemberVersion:added.version});
      expect(sent.taskId).toBe(f.root.taskId);
      const children=f.db.prepare(`SELECT t.owner_member_id owner,t.id FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id
        JOIN coordination_runs c ON c.run_id=s.run_id WHERE c.task_id=? ORDER BY t.owner_member_id`).all(f.root.taskId) as Array<{owner:string;id:string}>;
      expect(children.map(row=>row.owner).sort()).toEqual([f.ids[0],f.ids[1]].sort());
      expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key=? AND status!='done'").get(`task:${f.root.taskId}:initial`)).toEqual({n:0});
      for(let i=0;i<6&&await worker.runOnce();i++){ /* one formal turn per explicit child */ }
      expect(index).toBe(3);
      const history=await f.cmd<{items:Array<{authorId:string;body:{text:string}}>}>('thread.history',{threadId:f.root.threadId});
      expect(history.items.some(m=>m.body.text.includes('甲的明确回复'))).toBe(true);
      expect(history.items.some(m=>m.body.text.includes('乙的明确回复'))).toBe(true);
      expect([...new Set(history.items.filter(m=>m.body.text.includes('明确回复')).map(m=>m.authorId))].sort()).toEqual([f.ids[0],f.ids[1]].sort());
      expect(f.db.prepare('SELECT 1 FROM agent_turns WHERE member_id=?').get(f.ids[2])).toBeUndefined();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(f.root.taskId)).toEqual({status:'DONE'});
    }finally{f.db.close();}
  });
  it.each(['invalid-output','unknown','provider-failure'] as const)('a receiver %s cannot be marked as a completed message or automatically retried',async failure=>{
    const f=await fixture();try{
      const finish=(extra:Record<string,unknown>={}):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'work',answer:'请核对数字',changeSummary:'核对',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...extra})}}];
      let index=0;const scripts:FakeTurnScript[]=[finish(),finish({handoffs:[{toMemberId:f.ids[1],purpose:'review',message:'请核对明细总计。'}]}),failure==='invalid-output'?[{kind:'event',event:{kind:'turn.completed',finalText:'{"schemaVersion":"task-complete-v1","unexpected":true}'}}]:[{kind:'event',event:{kind:'turn.failed',code:failure==='unknown'?'INTERRUPTED':'PROVIDER_ERROR',message:'isolated receiver failure',retryable:false}}]];
      const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({turnScriptSequencer:()=>scripts[index++]!}),leaseOwner:'r87-failed-message',appDataDir:f.dir});
      await worker.runOnce();
      await f.cmd('thread.members.change',f.change(f.ids[1]!,'add',(await f.get()).version));
      await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:f.root.threadId},body:'请大家核对',intent:'default',mentions:[]});
      await worker.runOnce();await worker.runOnce();
      const message=f.db.prepare('SELECT status,error_message,target_delivery_id,target_turn_id FROM coordination_messages').get() as {status:string;error_message:string|null;target_delivery_id:string|null;target_turn_id:string};
      expect(message).toMatchObject({status:'blocked',target_delivery_id:null,error_message:expect.any(String)});
      const turn=f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(message.target_turn_id);
      expect(turn).toEqual({status:failure==='unknown'?'UNKNOWN':'FAILED'});
      for(let i=0;i<3;i++)await worker.runOnce();
      expect(index).toBe(3);expect(f.db.prepare('SELECT count(*) n FROM coordination_messages').get()).toEqual({n:1});
    }finally{f.db.close();}
  });
  it.each(['foreign-recipient','duplicate','self-echo','child-write-escalation'] as const)('rejects an actual %s proposal without dispatching it',async bad=>{
    const f=await fixture();try{
      const finish=(handoffs:unknown[]=[]):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'work',answer:'核对请求',changeSummary:'核对请求',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],handoffs})}}];
      const valid={toMemberId:f.ids[1],purpose:'review',message:'请核对总额。'};
      let foreignId='foreign';
      if(bad==='foreign-recipient'){const other=join(f.dir,'other-project');mkdirSync(other);const p=await f.cmd<{project:{id:string}}>('project.open',{path:other});foreignId=(await f.cmd<{memberId:string}>('member.create',{projectId:p.project.id,displayName:'其他项目成员'})).memberId;}
      const invalid=bad==='foreign-recipient'?[{...valid,toMemberId:foreignId}]:bad==='duplicate'?[valid,valid]:bad==='self-echo'?[{...valid,toMemberId:f.ids[0]}]:[{toMemberId:f.ids[0],purpose:'implement',message:'请修改项目文件。'}];
      const scripts=bad==='child-write-escalation'?[finish(),finish([valid]),finish(invalid)]:[finish(),finish(invalid)];let index=0;
      const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({turnScriptSequencer:()=>scripts[index++]!}),leaseOwner:'r87-invalid-message',appDataDir:f.dir});
      await worker.runOnce();await f.cmd('thread.members.change',f.change(f.ids[1]!,'add',(await f.get()).version));
      await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:f.root.threadId},body:'请大家核对',intent:'default',mentions:[]});
      for(let i=0;i<6;i++)await worker.runOnce();
      expect(index).toBe(scripts.length);
      expect(f.db.prepare('SELECT status FROM agent_turns ORDER BY rowid DESC LIMIT 1').get()).toEqual({status:'FAILED'});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_messages').get()).toEqual({n:bad==='child-write-escalation'?1:0});
      expect(f.db.prepare('SELECT 1 FROM agent_turns WHERE member_id=?').get(f.ids[2])).toBeUndefined();
    }finally{f.db.close();}
  });
  it('a receiver can ask a third authorized peer and receive its actual reply before replying to the coordinator',async()=>{
    const f=await fixture();try{
      const finish=(answer:string,handoffs:unknown[]=[]):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'work',answer,changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],handoffs})}}];
      const scripts=[finish('你好'),finish('请乙核对',[{toMemberId:f.ids[1],purpose:'review',message:'请核对明细总额。'}]),finish('请丙查原始表',[{toMemberId:f.ids[2],purpose:'ask',message:'请核实原始明细是40和30吗？'}]),finish('原始明细确认40和30',[{toMemberId:f.ids[1],purpose:'reply',message:'我核对原表，40和30合计70。'}]),finish('已收到丙实际核对结果',[{toMemberId:f.ids[0],purpose:'reply',message:'丙已核实明细，正确总额是70。'}]),finish('三位核对后建议总额改为70')];
      let index=0;const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({turnScriptSequencer:()=>scripts[index++]!}),leaseOwner:'r87-peer-chain',appDataDir:f.dir});
      await worker.runOnce();for(const member of f.ids.slice(1))await f.cmd('thread.members.change',f.change(member!,'add',(await f.get()).version));
      await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:f.root.threadId},body:'请大家核对明细',intent:'default',mentions:[]});
      for(let i=0;i<12;i++)await worker.runOnce();
      expect(index).toBe(6);
      const messages=f.db.prepare('SELECT source_member_id,target_member_id,status,target_turn_id FROM coordination_messages ORDER BY rowid').all() as Array<{source_member_id:string;target_member_id:string;status:string;target_turn_id:string}>;
      expect(messages.map(m=>[m.source_member_id,m.target_member_id])).toEqual([[f.ids[0],f.ids[1]],[f.ids[1],f.ids[2]],[f.ids[2],f.ids[1]],[f.ids[1],f.ids[0]]]);
      expect(messages.every(m=>m.status==='completed'&&m.target_turn_id)).toBe(true);
      const secondB=f.db.prepare('SELECT c.included_refs_json FROM context_bundles c JOIN agent_turns a ON a.id=c.turn_id WHERE a.member_id=? ORDER BY a.rowid DESC LIMIT 1').get(f.ids[1]) as {included_refs_json:string};
      expect(secondB.included_refs_json).toContain('我核对原表，40和30合计70');
      expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});
    }finally{f.db.close();}
  });
  it.each(['before-dispatch','opening-session','removed-recipient'] as const)('%s does not wake a stopped or removed receiver',async boundary=>{
    const f=await fixture();try{
      const finish=(handoffs:unknown[]=[]):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'work',answer:'核对报告',changeSummary:'核对报告',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],handoffs})}}];
      let index=0;const adapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>index++===1?finish([{toMemberId:f.ids[1],purpose:'review',message:'请核对明细合计。'}]):finish()});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r87-message-boundary',appDataDir:f.dir});
      await worker.runOnce();await f.cmd('thread.members.change',f.change(f.ids[1]!,'add',(await f.get()).version));
      await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:f.root.threadId},body:'请大家核对',intent:'default',mentions:[]});
      await worker.runOnce();
      const rootRun=f.db.prepare("SELECT run_id FROM coordination_runs WHERE task_id=? AND state IN ('planning','running','integrating') ORDER BY created_at DESC LIMIT 1").get(f.root.taskId) as {run_id:string};
      let opening:Promise<boolean>|undefined,release:(()=>void)|undefined;
      if(boundary==='opening-session'){
        const barrier=new Promise<void>(resolve=>{release=resolve;});const original=adapter.openSession.bind(adapter);let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
        adapter.openSession=async input=>{entered();await barrier;return original(input);};opening=worker.runOnce();await ready;
      }
      if(boundary==='removed-recipient')await f.cmd('thread.members.change',f.change(f.ids[1]!,'remove',(await f.get()).version));
      else await f.cmd('task.stop',{taskId:f.root.taskId,targetRunId:rootRun.run_id,expectedStopGeneration:0});
      release?.();if(opening)await opening;
      for(let i=0;i<4;i++)await worker.runOnce();
      expect(index).toBe(2);expect(adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT status FROM coordination_messages').get()).toEqual({status:boundary==='removed-recipient'?'blocked':'cancelled'});
    }finally{f.db.close();}
  });
  it('room multi-mention is natural AUTO and its authorized scope excludes unselected room C',async()=>{
    const f=await fixture();try{
      const sent=await f.cmd<{taskId:string}>('message.submit',{target:{kind:'room_root',projectId:f.projectId,conversationId:f.room.conversationId,roomId:f.room.id},body:'请两位一起看看',intent:'default',mentions:f.ids.slice(0,2).map(memberId=>({kind:'member',memberId}))});
      const task=f.db.prepare('SELECT route_json FROM tasks WHERE id=?').get(sent.taskId) as {route_json:string};
      expect(JSON.parse(task.route_json)).toMatchObject({mode:'AUTO',participantScope:'selected',initialWakeMemberIds:[f.ids[0]]});
      const children=f.db.prepare(`SELECT t.owner_member_id owner FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id
        JOIN coordination_runs c ON c.run_id=s.run_id WHERE c.task_id=? ORDER BY t.owner_member_id`).all(sent.taskId) as Array<{owner:string}>;
      expect(children).toEqual([]);
      const parentInitial=f.db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key=?").get(`task:${sent.taskId}:initial`) as {n:number};
      expect(parentInitial.n).toBe(1);
      const scope=f.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(sent.taskId) as {roster_json:string};
      expect((JSON.parse(scope.roster_json) as Array<{memberId:string}>).map(m=>m.memberId).sort()).toEqual(f.ids.slice(0,2).sort());
      expect(scope.roster_json).not.toContain(f.ids[2]);
      const explicit=await f.cmd<{taskId:string}>('message.submit',{target:{kind:'room_root',projectId:f.projectId,conversationId:f.room.conversationId,roomId:f.room.id},body:'独立研讨',intent:'default',collaboration:'deliberate',mentions:f.ids.slice(0,2).map(memberId=>({kind:'member',memberId}))});
      const advanced=f.db.prepare('SELECT route_json FROM tasks WHERE id=?').get(explicit.taskId) as {route_json:string};expect(JSON.parse(advanced.route_json)).toMatchObject({mode:'DELIBERATE'});
    }finally{f.db.close();}
  });
  it('V51 persisted: room explicit two-recipient message executes both selected members and no hidden coordinator',async()=>{
    const f=await fixture(true);try{
      const answers=['根回复','第一位明确回复','第二位明确回复'];
      let index=0;
      const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({structuredFinal:false,turnScriptSequencer:(input)=>{
        const match=input.text.match(/resultKey=([^；\n]+)/)??input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key=match?.[1]??'result_unknown';
        const answer=answers[index++]!;
        const finalText=JSON.stringify({schemaVersion:'task-complete-v1',resultKey:key,responseKind:'conversation',answer,changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],handoffs:[]});
        return[{kind:'event',event:{kind:'message.completed',messageId:`r89_room_${index}`,text:finalText}},{kind:'event',event:{kind:'turn.completed',finalText}}] as FakeTurnScript;
      }}),leaseOwner:'r89-room-multi',appDataDir:f.dir});
      await worker.runOnce();
      const uploaded=await f.cmd<{attachmentId:string}>('attachment.uploadText',{conversationId:f.room.conversationId,filename:'R89合成资料.txt',content:'R89_DOC_MARKER_42\n两位必须读取这段实际内容。'});
      const sent=await f.cmd<{taskId:string}>('message.submit',{target:{kind:'room_root',projectId:f.projectId,conversationId:f.room.conversationId,roomId:f.room.id},body:'@两位 请分别回复',intent:'default',mentions:f.ids.slice(0,2).map(memberId=>({kind:'member',memberId})),attachmentRefs:[uploaded.attachmentId]});
      expect(f.db.prepare('SELECT count(*) n FROM outbox WHERE dispatch_key=?').get(`task:${sent.taskId}:initial`)).toEqual({n:0});
      const children=f.db.prepare(`SELECT t.id,t.owner_member_id owner FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id
        JOIN coordination_runs c ON c.run_id=s.run_id WHERE c.task_id=? ORDER BY t.owner_member_id`).all(sent.taskId) as Array<{id:string;owner:string}>;
      expect(children.map(row=>row.owner).sort()).toEqual(f.ids.slice(0,2).sort());
      for(let i=0;i<6&&await worker.runOnce();i++){ /* one turn per explicit recipient */ }
      expect(index).toBe(3);
      const replies=f.db.prepare(`SELECT t.owner_member_id owner,m.body_json FROM messages m JOIN tasks t ON t.id=m.task_id
        WHERE t.parent_task_id=? AND m.author_type='agent' ORDER BY m.rowid`).all(sent.taskId) as Array<{owner:string;body_json:string}>;
      expect(replies.map(row=>JSON.parse(row.body_json).text).sort()).toEqual(answers.slice(1).sort());
      expect([...new Set(replies.map(row=>row.owner))].sort()).toEqual(f.ids.slice(0,2).sort());
      const contexts=f.db.prepare(`SELECT c.included_refs_json FROM context_bundles c JOIN agent_turns a ON a.id=c.turn_id
        JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id WHERE t.parent_task_id=?`).all(sent.taskId) as Array<{included_refs_json:string}>;
      expect(contexts).toHaveLength(2);
      expect(contexts.every(row=>row.included_refs_json.includes('R89_DOC_MARKER_42'))).toBe(true);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'DONE'});
      expect(f.db.prepare('SELECT 1 FROM agent_turns WHERE member_id=?').get(f.ids[2])).toBeUndefined();
    }finally{f.db.close();}
  });
  it('V51 persisted: explicit recipients accept a natural plain-text reply when there is no work evidence',async()=>{
    const f=await fixture(true);try{
      const rootFinal:FakeTurnScript=[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',answer:'根回复',changeSummary:'根回复',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}];
      const scripts:FakeTurnScript[]=[rootFinal,successTurn('第一位自然回复'),successTurn('第二位自然回复')];
      const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({structuredFinal:false,turnScriptSequencer:()=>scripts.shift()??successTurn('extra')}),leaseOwner:'r90-natural-child',appDataDir:f.dir});
      await worker.runOnce();
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,conversationId:f.room.conversationId,roomId:f.room.id},
        body:'@两位 请分别用自然中文回复',intent:'default',mentions:f.ids.slice(0,2).map(memberId=>({kind:'member',memberId})),
      });
      for(let i=0;i<6&&await worker.runOnce();i++){/* one child per turn */}
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'DONE'});
      const children=f.db.prepare('SELECT status,owner_member_id FROM tasks WHERE parent_task_id=? ORDER BY rowid').all(sent.taskId) as Array<{status:string;owner_member_id:string}>;
      expect(children.map(row=>row.status)).toEqual(['DONE','DONE']);
      expect(children.map(row=>row.owner_member_id).sort()).toEqual(f.ids.slice(0,2).sort());
      const replies=f.db.prepare(`SELECT body_json FROM messages WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id=?) AND author_type='agent' ORDER BY rowid`).all(sent.taskId) as Array<{body_json:string}>;
      expect(replies.map(row=>JSON.parse(row.body_json).text).sort()).toEqual(['第一位自然回复','第二位自然回复']);
      expect(f.db.prepare('SELECT id,task_id,run_id FROM task_deliveries WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id=?)').all(sent.taskId)).toEqual([]);
      expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE task_id IN (SELECT id FROM tasks WHERE parent_task_id=?) AND kind='turn.outputInvalid'").get(sent.taskId)).toEqual({n:0});
    }finally{f.db.close();}
  });
  it('shows factual natural progress while running, suppresses control JSON, and stops showing it at terminal',async()=>{
    const f=await fixture();try{
      const script:FakeTurnScript=[
        {kind:'event',event:{kind:'message.progress',messageId:'natural',text:'我已发现两处数字不一致，正在核对表格。'}},
        {kind:'event',event:{kind:'message.progress',messageId:'control',text:'{"schemaVersion":"task-complete-v1","resultKey":"unfinished'}},
        {kind:'stall',ms:150},
        {kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',answer:'核对完成',changeSummary:'核对完成',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}},
      ];
      const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({turnScriptSequencer:()=>script}),leaseOwner:'r87-progress',appDataDir:f.file+'.worker'});
      const executing=worker.runOnce();
      for(let i=0;i<100&&!f.db.prepare('SELECT 1 FROM turn_visible_progress').get();i++)await new Promise(r=>setTimeout(r,5));
      const during=await f.cmd<{progress:Array<{turnId:string;text:string;phase:string}>}>('thread.get',{threadId:f.root.threadId});
      expect(during.progress).toHaveLength(1);expect(during.progress[0]).toMatchObject({text:'我已发现两处数字不一致，正在核对表格。',phase:'responding'});
      const prior=f.db.prepare('SELECT count(*) n FROM messages').get();
      expect(f.db.prepare("SELECT 1 FROM messages WHERE body_json LIKE '%两处数字%'").get()).toBeUndefined();
      await executing;
      const after=await f.cmd<{progress:unknown[]}>('thread.get',{threadId:f.root.threadId});expect(after.progress).toEqual([]);
      expect(prior).toEqual({n:1});
      const task=f.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.root.taskId) as Parameters<DispatchWorker['applyEvent']>[0];
      const turn=f.db.prepare('SELECT id,run_id FROM agent_turns ORDER BY rowid DESC LIMIT 1').get() as {id:string;run_id:string};
      const saved=f.db.prepare('SELECT * FROM turn_visible_progress').get();
      worker.applyEvent(task,turn.run_id,turn.id,{kind:'message.progress',messageId:'late',text:'迟到进度不得覆盖',eventKey:'late',sessionId:'old',turnId:turn.id,receivedAt:Date.now()});
      expect(f.db.prepare('SELECT * FROM turn_visible_progress').get()).toEqual(saved);
    }finally{f.db.close();}
  });
  it('an actually assigned AUTO child joins the parent thread, without importing room candidate C',async()=>{
    const f=await fixture();try{
      const revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(f.room.id) as {revision:number}).revision;
      await f.cmd('room.update',{roomId:f.room.id,expectedRevision:revision,coordinatorMemberId:f.ids[0]});
      const root=await f.cmd<{threadId:string;taskId:string}>('message.submit',{target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},body:'请合作检查报告',intent:'default',mentions:[]});
      const plan={summary:'请同伴独立检查',steps:[{key:'review',memberId:f.ids[1],title:'检查报告',objective:'指出事实问题',role:'review',dependsOn:[]}]};
      const script:FakeTurnScript=[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'work',answer:'请同伴检查',changeSummary:'请同伴检查',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],coordinationPlan:plan})}}];
      const worker=new DispatchWorker({db:f.db,adapter:new FakeRuntimeAdapter({turnScriptSequencer:()=>script}),leaseOwner:'r87-members',appDataDir:f.file+'.worker'});
      // The first direct greeting intent is settled through the same worker too.
      await worker.runOnce();await worker.runOnce();
      const parent=await f.cmd<{members:ThreadMembersSnapshot}>('thread.get',{threadId:root.threadId});
      expect(parent.members.memberIds).toEqual([f.ids[0],f.ids[1]].sort());
      expect(parent.members.memberIds).not.toContain(f.ids[2]);
      const removed=await f.cmd<ThreadMembersSnapshot>('thread.members.change',{projectId:f.projectId,threadId:root.threadId,memberId:f.ids[1],action:'remove',expectedVersion:parent.members.version});
      expect(removed.memberIds).toEqual([f.ids[0]]);
    }finally{f.db.close();}
  });
  it('the addressed AI is already in the thread; adding B never includes room member C and survives reopen',async()=>{
    const f=await fixture();
    try{
      const original=await f.get();expect(original.memberIds).toEqual([f.ids[0]]);
      const commandId=randomUUID(),params=f.change(f.ids[1]!,'add',original.version);
      const added=await f.cmd<ThreadMembersSnapshot>('thread.members.change',params,commandId);
      expect(added.memberIds).toEqual([f.ids[0],f.ids[1]].sort());expect(added.eligibleMemberIds).toEqual(added.memberIds);
      expect(added.memberIds).not.toContain(f.ids[2]);
      expect((await f.raw('thread.members.change',params,commandId)).replayed).toBe(true);
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:0});
      expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n:1});
      f.db.close();const reopened=openDatabase(f.file);
      try{
        const read=await dispatchDaemonCommand({db:reopened,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method:'thread.get',params:{threadId:f.root.threadId}}) as {ok:boolean;data:{members:ThreadMembersSnapshot}};
        expect(read.ok).toBe(true);expect(read.data.members).toEqual(added);
      }finally{reopened.close();}
    }finally{if(f.db.open)f.db.close();}
  });

  it('removal overrides the original owner and ABA still rejects an old membership snapshot',async()=>{
    const f=await fixture();try{
      const before=await f.get();
      const removed=await f.cmd<ThreadMembersSnapshot>('thread.members.change',f.change(f.ids[0]!,'remove',before.version));
      expect(removed.memberIds).toEqual([]);expect((await f.get()).memberIds).toEqual([]);
      const restored=await f.cmd<ThreadMembersSnapshot>('thread.members.change',f.change(f.ids[0]!,'add',removed.version));
      expect(restored.memberIds).toEqual(before.memberIds);expect(restored.version).not.toBe(before.version);
      expect((await f.raw('thread.members.change',f.change(f.ids[1]!,'add',before.version))).error?.code).toBe('STALE_REVISION');
      expect(f.db.prepare('SELECT owner_member_id FROM tasks WHERE id=?').get(f.root.taskId)).toEqual({owner_member_id:f.ids[0]});
    }finally{f.db.close();}
  });

  it('rejects foreign project/member, disabled members and archived target, including receipt replay',async()=>{
    const f=await fixture();try{
      const current=await f.get();
      expect((await f.raw('thread.members.change',{...f.change(f.ids[1]!,'add',current.version),projectId:'foreign'})).error?.code).toBe('THREAD_SCOPE_MISMATCH');
      expect((await f.raw('thread.members.change',f.change('foreign','add',current.version))).error?.code).toBe('MEMBER_DISABLED');
      const commandId=randomUUID(),params=f.change(f.ids[1]!,'add',current.version);
      await f.cmd('thread.members.change',params,commandId);
      const revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(f.room.id) as {revision:number}).revision;
      await f.cmd('room.archive',{roomId:f.room.id,expectedRevision:revision,action:'archive'});
      expect((await f.raw('thread.members.change',params,commandId)).error?.code).toBe('CONVERSATION_UNAVAILABLE');
      expect((await f.get()).memberIds).toEqual([f.ids[0],f.ids[1]].sort());
    }finally{f.db.close();}
  });
});
