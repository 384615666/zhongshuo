import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase,type ZhongshuoDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {pumpCoordinations} from '../../src/daemon/coordination.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';

afterEach(()=>vi.unstubAllEnvs());

const A_ANSWER='合成甲结果：已核对短样例。';
const B_ANSWER='合成乙结果：已核对短样例。';
const C_ANSWER='合成丙结果：已核对短样例。';
const B_REPLY='合成乙回复：短样例复核完成。';
const INTEGRATION_ANSWER='合成最终答复：两位成员的结果均已收齐。';

function complete(answer:string,extra:Record<string,unknown>={}):FakeTurnScript{
  return [{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({
    schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'work',answer,
    changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...extra,
  })}}];
}

function turnIdentity(db:ZhongshuoDatabase,text:string){
  const turnId=/\bturn=([^\s]+)/.exec(text)?.[1];
  if(!turnId)throw Error('合成 fixture 未拿到 turn id');
  const row=db.prepare(`SELECT r.task_id,t.owner_member_id,c.integration_run_id
    FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id
    LEFT JOIN coordination_runs c ON c.integration_run_id=r.id WHERE a.id=?`).get(turnId) as
    {task_id:string;owner_member_id:string;integration_run_id:string|null}|undefined;
  if(!row)throw Error('合成 fixture 未找到 turn 身份');
  return row;
}

async function fixture(){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r92-handoff-')),project=join(dir,'project');mkdirSync(project);
  const file=join(dir,'state.sqlite'),db=openDatabase(file);
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:async()=>{}};
  const raw=async<T>(method:string,params:unknown,commandId:string=randomUUID())=>{
    const result=await dispatchDaemonCommand(deps,{protocolVersion:1,commandId,method,params});
    return result as {ok:boolean;data:T;error?:unknown};
  };
  const cmd=async<T>(method:string,params:unknown,commandId?:string)=>{
    const result=await raw<T>(method,params,commandId);expect(result.ok,JSON.stringify(result.error)).toBe(true);return result.data;
  };
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:Array<{id:string;conversationId:string;revision:number}>}>('room.list',{projectId})).items[0]!;
  const a=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'协调者甲'})).memberId;
  const b=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'回复者乙'})).memberId;
  for(const memberId of [a,b])await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
  const currentRoom=(await cmd<{items:Array<{id:string;revision:number}>}>('room.list',{projectId})).items.find(item=>item.id===room.id)!;
  await cmd('room.update',{roomId:room.id,expectedRevision:currentRoom.revision,coordinatorMemberId:a});
  const roomMembers=await cmd<{items:Array<{id:string}>}>('member.list',{projectId,roomId:room.id});
  for(const member of roomMembers.items)if(member.id!==a&&member.id!==b)await cmd('room.members.set',{roomId:room.id,memberId:member.id,action:'remove'});
  return {dir,file,db,cmd,projectId,room,a,b};
}

describe('R92 coordinator handoff completion',()=>{
  it('injects both child complete-detail tails into the formal integration context',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      const aDetail='# 甲完整详情\n\n甲侧完整证据尾部 R93_CHILD_A_TAIL';
      const bDetail='# 乙完整详情\n\n乙侧完整证据尾部 R93_CHILD_B_TAIL';
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.integration_run_id!=null)return complete(INTEGRATION_ANSWER);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{detailMarkdown:bDetail,handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER,{detailMarkdown:aDetail});
        throw Error('合成 fixture 收到未授权成员 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r93-child-detail',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：两位成员分别给出短结论和完整详情。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      for(let i=0;i<5&&await worker.runOnce();i++){/* child+integration */}
      const handoff=f.db.prepare("SELECT target_turn_id,status FROM coordination_messages WHERE purpose='reply'").get() as {target_turn_id:string;status:string};
      expect(handoff.status).toBe('completed');
      const context=f.db.prepare('SELECT included_refs_json FROM context_bundles WHERE turn_id=?').get(handoff.target_turn_id) as {included_refs_json:string};
      const envelope=JSON.parse(context.included_refs_json) as {attachments?:Array<{detail?:boolean;text?:string;ref?:string;truncated?:boolean}>};
      const details=(envelope.attachments??[]).filter((item)=>item.detail);
      expect(details).toHaveLength(2);
      expect(details.map((item)=>item.text).join('\n')).toContain('R93_CHILD_A_TAIL');
      expect(details.map((item)=>item.text).join('\n')).toContain('R93_CHILD_B_TAIL');
      expect(details.every((item)=>item.truncated===false)).toBe(true);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'DONE'});
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('routes a deferred reply-to-owner through the visible integration turn instead of completing as explicit-recipients',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.integration_run_id!=null)return complete(INTEGRATION_ANSWER);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 收到未授权成员 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-core',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string;threadId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：请两位成员分别核对短样例。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });

      expect(f.db.prepare('SELECT count(*) n FROM coordination_steps WHERE run_id=(SELECT run_id FROM coordination_runs WHERE task_id=?)').get(sent.taskId)).toEqual({n:2});
      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(true);

      const accepted=f.db.prepare(`SELECT id,source_member_id,target_member_id,purpose,child_task_id,target_turn_id,status
        FROM coordination_messages WHERE purpose='reply'`).get() as
        {id:string;source_member_id:string;target_member_id:string;purpose:string;child_task_id:string|null;target_turn_id:string|null;status:string}|undefined;
      expect(accepted).toMatchObject({source_member_id:f.b,target_member_id:f.a,purpose:'reply',child_task_id:null,target_turn_id:null,status:'accepted'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE parent_task_id=? ORDER BY rowid').all(sent.taskId)).toEqual([{status:'DONE'},{status:'DONE'}]);
      expect(f.db.prepare('SELECT state,integration_run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId)).toEqual({state:'running',integration_run_id:null});
      const ownerContext=f.db.prepare("SELECT c.included_refs_json FROM context_bundles c JOIN agent_turns a ON a.id=c.turn_id JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id LEFT JOIN coordination_runs cr ON cr.integration_run_id=r.id WHERE t.parent_task_id=? AND t.owner_member_id=? AND cr.run_id IS NULL LIMIT 1").get(sent.taskId,f.a) as {included_refs_json:string};
      expect(ownerContext.included_refs_json).toContain('"replyToMemberId":null');
      expect(ownerContext.included_refs_json).not.toContain('"replyToMemberId":"'+f.a+'"');

      // The old implementation stops here by completing the explicit-recipient run. A correct
      // implementation must instead enqueue and execute the one shared integration turn.
      for(let i=0;i<3;i++)if(!(await worker.runOnce()))break;

      const run=f.db.prepare('SELECT state,integration_run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId) as
        {state:string;integration_run_id:string|null};
      expect(run.integration_run_id).not.toBeNull();
      expect(run.state).toBe('completed');
      expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='coordination.integrationQueued'").get(sent.taskId)).toEqual({n:1});
      expect(f.db.prepare(`SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='coordination.completed'
        AND json_extract(payload_json,'$.source')='explicit-recipients'`).get(sent.taskId)).toEqual({n:0});

      const settled=f.db.prepare(`SELECT status,target_turn_id,target_delivery_id,child_task_id FROM coordination_messages WHERE id=?`).get(accepted!.id) as
        {status:string;target_turn_id:string|null;target_delivery_id:string|null;child_task_id:string|null};
      expect(settled).toMatchObject({status:'completed',child_task_id:null});
      expect(settled.target_turn_id).not.toBeNull();
      expect(settled.target_delivery_id).not.toBeNull();

      const target=f.db.prepare(`SELECT a.id,a.status,r.task_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE a.id=?`).get(settled.target_turn_id) as
        {id:string;status:string;task_id:string}|undefined;
      expect(target).toMatchObject({id:settled.target_turn_id,status:'SUCCEEDED',task_id:sent.taskId});

      const history=await f.cmd<{items:Array<{authorType:string;authorId:string;body:{text:string}}>}>('thread.history',{threadId:sent.threadId,limit:50});
      const final=history.items.at(-1)!;
      expect(final).toMatchObject({authorType:'agent',authorId:f.a,body:{text:INTEGRATION_ANSWER}});
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });
  it('does not wake the coordinator without a handoff and does not replay completed work after restart',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined,restartedAdapter:FakeRuntimeAdapter|undefined;let activeDb=f.db;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER);
        throw Error('合成 fixture 不应产生协调者 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-no-handoff',appDataDir:f.dir});
      await f.cmd('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：请两位成员分别回复，不必互相转交。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      for(let i=0;i<4;i++)if(!(await worker.runOnce()))break;

      expect(f.db.prepare('SELECT state,integration_run_id FROM coordination_runs').get()).toEqual({state:'completed',integration_run_id:null});
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:2});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_messages').get()).toEqual({n:0});
      expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE kind='coordination.integrationQueued'").get()).toEqual({n:0});
      expect(adapter.startTurnLog).toHaveLength(2);
      expect(await worker.runOnce()).toBe(false);
      expect(f.db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:2});

      await adapter.closeAllSessions();adapter=undefined;f.db.close();
      const reopened=openDatabase(f.file);activeDb=reopened;
      let restartedCalls=0;
      restartedAdapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>{restartedCalls+=1;return complete('不应执行');}});
      const restartedWorker=new DispatchWorker({db:reopened,adapter:restartedAdapter,leaseOwner:'r92-restart',appDataDir:f.dir});
      await expect(restartedWorker.runOnce()).resolves.toBe(false);
      await expect(restartedWorker.runOnce()).resolves.toBe(false);
      expect(restartedCalls).toBe(0);
      expect(reopened.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:2});
      expect(reopened.prepare('SELECT state,integration_run_id FROM coordination_runs').get()).toEqual({state:'completed',integration_run_id:null});
    }finally{await restartedAdapter?.closeAllSessions();await adapter?.closeAllSessions();if(activeDb.open)activeDb.close();}
  });
  it('creates and binds a formal child execution when a handoff targets a non-owner member',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      const c=(await f.cmd<{memberId:string}>('member.create',{projectId:f.projectId,displayName:'核对者丙'})).memberId;
      await f.cmd('member.setRuntime',{memberId:c,kind:'fake',permissionMode:'bypassPermissions'});
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:c,purpose:'ask',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        if(identity.owner_member_id===c)return complete(C_ANSWER);
        throw Error('合成 fixture 收到未授权成员 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-peer',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string;threadId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：请三位成员分别核对短样例。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b},{kind:'member',memberId:c}],
      });
      for(let i=0;i<3;i++)expect(await worker.runOnce()).toBe(true);

      const accepted=f.db.prepare(`SELECT id,child_task_id,target_turn_id,status FROM coordination_messages WHERE purpose='ask' AND target_member_id=?`).get(c) as
        {id:string;child_task_id:string|null;target_turn_id:string|null;status:string}|undefined;
      expect(accepted).toMatchObject({target_turn_id:null,status:'accepted'});
      expect(accepted?.child_task_id).not.toBeNull();
      expect(f.db.prepare('SELECT owner_member_id,status FROM tasks WHERE id=?').get(accepted!.child_task_id)).toEqual({owner_member_id:c,status:'OPEN'});

      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(false);
      const settled=f.db.prepare('SELECT status,target_turn_id,child_task_id FROM coordination_messages WHERE id=?').get(accepted!.id) as
        {status:string;target_turn_id:string|null;child_task_id:string|null};
      expect(settled.status).toBe('completed');expect(settled.target_turn_id).not.toBeNull();
      const target=f.db.prepare('SELECT a.id,a.status,r.task_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE a.id=?').get(settled.target_turn_id) as
        {id:string;status:string;task_id:string}|undefined;
      expect(target).toMatchObject({id:settled.target_turn_id,status:'SUCCEEDED',task_id:settled.child_task_id});
      const context=f.db.prepare('SELECT included_refs_json FROM context_bundles WHERE turn_id=?').get(settled.target_turn_id) as {included_refs_json:string};
      expect(context.included_refs_json).toContain(B_REPLY);
      expect(f.db.prepare('SELECT state FROM coordination_runs WHERE task_id=?').get(sent.taskId)).toEqual({state:'completed'});
      expect(adapter.startTurnLog).toHaveLength(4);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('blocks a deferred handoff with an explicit terminal state when no integration budget remains',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 不应产生额外 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-budget',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：预算边界。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(true);
      const run=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {run_id:string};
      f.db.prepare('UPDATE workflow_runs SET budget_json=? WHERE id=?').run(JSON.stringify({maxTurns:2}),run.run_id);
      pumpCoordinations(f.db);pumpCoordinations(f.db);

      expect(f.db.prepare('SELECT state,integration_run_id,error_message FROM coordination_runs WHERE task_id=?').get(sent.taskId)).toMatchObject({state:'blocked',integration_run_id:null,error_message:expect.stringContaining('预算已用尽')});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare("SELECT status,error_message FROM coordination_messages WHERE purpose='reply'").get()).toMatchObject({status:'blocked',error_message:expect.stringContaining('预算已用尽')});
      expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE kind='coordination.integrationQueued'").get()).toEqual({n:0});
      expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key LIKE '%:redispatch:coord_%'").get()).toEqual({n:0});
      expect(adapter.startTurnLog).toHaveLength(2);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('queues exactly one integration turn across repeated pump and database restart',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;let reopened:ZhongshuoDatabase|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 不应执行整合 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-idempotent',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：重复泵边界。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      await worker.runOnce();await worker.runOnce();
      const run=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {run_id:string};
      const key='task:'+sent.taskId+':redispatch:coord_'+run.run_id;
      pumpCoordinations(f.db);pumpCoordinations(f.db);
      expect(f.db.prepare('SELECT state,integration_run_id FROM coordination_runs WHERE run_id=?').get(run.run_id)).toEqual({state:'integrating',integration_run_id:null});
      expect(f.db.prepare('SELECT status,attempt_epoch,stop_generation_at_enqueue FROM outbox WHERE dispatch_key=?').get(key)).toMatchObject({status:'pending',attempt_epoch:0,stop_generation_at_enqueue:0});
      expect(f.db.prepare('SELECT count(*) n FROM outbox WHERE dispatch_key=?').get(key)).toEqual({n:1});
      expect(f.db.prepare("SELECT status,target_turn_id FROM coordination_messages WHERE purpose='reply'").get()).toEqual({status:'queued',target_turn_id:null});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_integration_attempts').get()).toEqual({n:0});

      await adapter.closeAllSessions();adapter=undefined;f.db.close();
      reopened=openDatabase(f.file);
      pumpCoordinations(reopened);pumpCoordinations(reopened);
      expect(reopened.prepare('SELECT count(*) n FROM outbox WHERE dispatch_key=?').get(key)).toEqual({n:1});
      expect(reopened.prepare('SELECT count(*) n FROM coordination_integration_attempts').get()).toEqual({n:0});
      expect(reopened.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:2});
    }finally{await adapter?.closeAllSessions();if(reopened?.open)reopened.close();if(f.db.open)f.db.close();}
  });

  it('does not execute an accepted handoff after the user stops the coordination',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 不应执行整合 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-stop',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：停止边界。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      await worker.runOnce();await worker.runOnce();
      const run=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {run_id:string};
      await f.cmd('task.stop',{taskId:sent.taskId,targetRunId:run.run_id,expectedStopGeneration:0});
      pumpCoordinations(f.db);pumpCoordinations(f.db);
      expect(f.db.prepare('SELECT state,integration_run_id FROM coordination_runs WHERE run_id=?').get(run.run_id)).toEqual({state:'cancelled',integration_run_id:null});
      expect(f.db.prepare('SELECT status FROM coordination_messages WHERE purpose=?').get('reply')).toEqual({status:'cancelled'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(run.run_id)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key LIKE '%:redispatch:coord_%'").get()).toEqual({n:0});
      expect(adapter.startTurnLog).toHaveLength(2);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('blocks rather than integrating when the reply source turn becomes UNKNOWN',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 不应执行整合 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-unknown',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：未知结果边界。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      await worker.runOnce();await worker.runOnce();
      const handoff=f.db.prepare("SELECT id,source_turn_id FROM coordination_messages WHERE purpose='reply'").get() as {id:string;source_turn_id:string};
      f.db.prepare("UPDATE agent_turns SET status='UNKNOWN' WHERE id=?").run(handoff.source_turn_id);
      pumpCoordinations(f.db);pumpCoordinations(f.db);
      expect(f.db.prepare('SELECT state,integration_run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId)).toMatchObject({state:'blocked',integration_run_id:null});
      expect(f.db.prepare('SELECT status,error_message FROM coordination_messages WHERE id=?').get(handoff.id)).toMatchObject({status:'blocked',error_message:expect.stringContaining('不会自动继续')});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key LIKE '%:redispatch:coord_%'").get()).toEqual({n:0});
      expect(adapter.startTurnLog).toHaveLength(2);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('integrates a valid conversation reply with a deferred handoff even when the child has no delivery',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.integration_run_id!=null)return complete(INTEGRATION_ANSWER);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{responseKind:'conversation',handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER,{responseKind:'conversation'});
        throw Error('合成 fixture 收到未授权成员 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-conversation',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string;threadId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：会话式答复后整合。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      await worker.runOnce();await worker.runOnce();
      expect(f.db.prepare('SELECT current_delivery_id FROM tasks WHERE parent_task_id=? ORDER BY rowid').all(sent.taskId)).toEqual([{current_delivery_id:null},{current_delivery_id:null}]);
      expect(f.db.prepare('SELECT state FROM coordination_runs WHERE task_id=?').get(sent.taskId)).toEqual({state:'running'});
      for(let i=0;i<3;i++)if(!(await worker.runOnce()))break;

      const run=f.db.prepare('SELECT state,integration_run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {state:string;integration_run_id:string|null};
      expect(run.state).toBe('completed');expect(run.integration_run_id).not.toBeNull();
      const handoff=f.db.prepare("SELECT status,target_turn_id,target_delivery_id FROM coordination_messages WHERE purpose='reply'").get() as {status:string;target_turn_id:string|null;target_delivery_id:string|null};
      expect(handoff.status).toBe('completed');expect(handoff.target_turn_id).not.toBeNull();expect(handoff.target_delivery_id).not.toBeNull();
      const integrationContext=f.db.prepare('SELECT included_refs_json FROM context_bundles WHERE turn_id=?').get(handoff.target_turn_id) as {included_refs_json:string};
      expect(integrationContext.included_refs_json).toContain(A_ANSWER);
      expect(integrationContext.included_refs_json).toContain(B_ANSWER);
      expect(integrationContext.included_refs_json).toContain(B_REPLY);
      expect(integrationContext.included_refs_json).toContain('"author":"'+f.a+'"');
      expect(integrationContext.included_refs_json).toContain('"author":"'+f.b+'"');
      const history=await f.cmd<{items:Array<{authorId:string;body:{text:string}}>}>('thread.history',{threadId:sent.threadId,limit:50});
      expect(history.items.at(-1)).toMatchObject({authorId:f.a,body:{text:INTEGRATION_ANSWER}});
      expect(adapter.startTurnLog).toHaveLength(3);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('settles the coordination as BLOCKED if the integration launch loses its coordinator',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 不应执行整合 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-launch-lost',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string;threadId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：整合启动前成员变化。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      await worker.runOnce();await worker.runOnce();
      pumpCoordinations(f.db);
      const run=f.db.prepare('SELECT run_id,state FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {run_id:string;state:string};
      expect(run.state).toBe('integrating');
      const members=(await f.cmd<{members:{version:string}}>('thread.get',{threadId:sent.threadId})).members;
      await f.cmd('thread.members.change',{projectId:f.projectId,threadId:sent.threadId,memberId:f.a,action:'remove',expectedVersion:members.version});

      expect(await worker.runOnce()).toBe(true);
      expect(f.db.prepare('SELECT state,integration_run_id,error_message FROM coordination_runs WHERE run_id=?').get(run.run_id)).toMatchObject({state:'blocked',integration_run_id:null,error_message:expect.stringContaining('移出本串')});
      expect(f.db.prepare("SELECT status,error_message FROM coordination_messages WHERE purpose='reply'").get()).toMatchObject({status:'blocked',error_message:expect.stringContaining('移出本串')});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(run.run_id)).toEqual({status:'FAILED'});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_integration_attempts').get()).toEqual({n:0});
      expect(adapter.startTurnLog).toHaveLength(2);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('settles pre-attempt permission failure before coordination integration starts',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 不应执行整合 turn');
      }});
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-pre-attempt',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：attempt 前权限变化。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      await worker.runOnce();await worker.runOnce();
      pumpCoordinations(f.db);
      const run=f.db.prepare('SELECT run_id,state FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {run_id:string;state:string};
      expect(run.state).toBe('integrating');
      await f.cmd('member.setRuntime',{memberId:f.a,kind:'fake',permissionMode:'plan'});

      expect(await worker.runOnce()).toBe(true);
      expect(f.db.prepare('SELECT state,integration_run_id,error_message FROM coordination_runs WHERE run_id=?').get(run.run_id)).toMatchObject({state:'blocked',integration_run_id:null,error_message:expect.stringContaining('配置已变化')});
      expect(f.db.prepare("SELECT status,error_message FROM coordination_messages WHERE purpose='reply'").get()).toMatchObject({status:'blocked',error_message:expect.stringContaining('配置已变化')});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(run.run_id)).toEqual({status:'FAILED'});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_integration_attempts').get()).toEqual({n:0});
      expect(f.db.prepare("SELECT status FROM outbox WHERE dispatch_key LIKE '%:redispatch:coord_%'").get()).toEqual({status:'done'});
      expect(adapter.startTurnLog).toHaveLength(2);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('settles a real pre-start integration failure after the attempt is created',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 不应真正启动整合 turn');
      }});
      const originalOpen=adapter.openSession.bind(adapter);let parentTaskId='',mutated=false;
      adapter.openSession=async input=>{
        const session=await originalOpen(input);
        if(input.taskId===parentTaskId&&!mutated){
          mutated=true;
          await f.cmd('member.setRuntime',{memberId:f.a,kind:'fake',permissionMode:'plan'});
        }
        return session;
      };
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-pre-start',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：会话建立后启动前权限变化。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      parentTaskId=sent.taskId;
      await worker.runOnce();await worker.runOnce();
      await expect(worker.runOnce()).rejects.toThrow('配置已变化');

      const run=f.db.prepare('SELECT run_id,state,integration_run_id,error_message FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {run_id:string;state:string;integration_run_id:string|null;error_message:string|null};
      expect(mutated).toBe(true);
      expect(run.state).toBe('blocked');expect(run.integration_run_id).not.toBeNull();expect(run.error_message).toContain('执行配置已变化');
      expect(f.db.prepare("SELECT status,error_message,target_turn_id FROM coordination_messages WHERE purpose='reply'").get()).toMatchObject({status:'blocked',error_message:expect.stringContaining('执行配置已变化'),target_turn_id:expect.any(String)});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(run.run_id)).toEqual({status:'FAILED'});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_integration_attempts WHERE coordination_run_id=?').get(run.run_id)).toEqual({n:1});
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE run_id=?').get(run.integration_run_id)).toEqual({status:'FAILED'});
      expect(adapter.startTurnLog).toHaveLength(2);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });

  it('preserves CANCELLED when the user stops during integration openSession',async()=>{
    const f=await fixture();let adapter:FakeRuntimeAdapter|undefined;
    try{
      adapter=new FakeRuntimeAdapter({turnScriptSequencer:({text})=>{
        const identity=turnIdentity(f.db,text);
        if(identity.owner_member_id===f.b)return complete(B_ANSWER,{handoffs:[{toMemberId:f.a,purpose:'reply',message:B_REPLY}]});
        if(identity.owner_member_id===f.a)return complete(A_ANSWER);
        throw Error('合成 fixture 不应真正启动整合 turn');
      }});
      const originalOpen=adapter.openSession.bind(adapter);let parentTaskId='',stopped=false;
      adapter.openSession=async input=>{
        const session=await originalOpen(input);
        if(input.taskId===parentTaskId&&!stopped){
          stopped=true;
          const integrationRun=f.db.prepare('SELECT integration_run_id FROM coordination_runs WHERE task_id=?').get(parentTaskId) as {integration_run_id:string|null};
          expect(integrationRun.integration_run_id).not.toBeNull();
          await f.cmd('task.stop',{taskId:parentTaskId,targetRunId:integrationRun.integration_run_id,expectedStopGeneration:0});
        }
        return session;
      };
      const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r92-open-stop',appDataDir:f.dir});
      const sent=await f.cmd<{taskId:string}>('message.submit',{
        target:{kind:'room_root',projectId:f.projectId,roomId:f.room.id,conversationId:f.room.conversationId},
        body:'合成短消息：openSession 期间停止。',intent:'default',
        mentions:[{kind:'member',memberId:f.a},{kind:'member',memberId:f.b}],
      });
      parentTaskId=sent.taskId;
      await worker.runOnce();await worker.runOnce();await worker.runOnce();

      const run=f.db.prepare('SELECT state,integration_run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {state:string;integration_run_id:string|null};
      expect(stopped).toBe(true);expect(run.state).toBe('cancelled');expect(run.integration_run_id).not.toBeNull();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare("SELECT status FROM coordination_messages WHERE purpose='reply'").get()).toEqual({status:'cancelled'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(run.integration_run_id)).toEqual({status:'CANCELLED'});
      expect(f.db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key LIKE '%:redispatch:coord_%' AND status!='done'").get()).toEqual({n:0});
      expect(adapter.startTurnLog).toHaveLength(2);
    }finally{await adapter?.closeAllSessions();if(f.db.open)f.db.close();}
  });
});
