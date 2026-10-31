import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {readThreadMembers} from '../../src/daemon/threadMembers.ts';

afterEach(()=>vi.unstubAllEnvs());
async function fixture(){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r134-broadcast-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  const cmd=async<T>(method:string,params:unknown,commandId:string=randomUUID())=>{
    const result=await dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:dir,interruptTurn:async()=>{}},{protocolVersion:1,commandId,method,params}) as {ok:boolean;data:T;error?:unknown};
    expect(result.ok,JSON.stringify(result.error)).toBe(true);return result.data;
  };
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:Array<{id:string;conversationId:string;revision:number}>}>('room.list',{projectId})).items[0]!;
  const members:string[]=[];
  for(const displayName of ['甲','乙']){
    const id=(await cmd<{memberId:string}>('member.create',{projectId,displayName})).memberId;members.push(id);
    await cmd('member.setRuntime',{memberId:id,kind:'fake',permissionMode:'bypassPermissions'});
  }
  const current=(await cmd<{items:Array<{id:string;revision:number}>}>('room.list',{projectId})).items.find(r=>r.id===room.id)!;
  await cmd('room.update',{roomId:room.id,expectedRevision:current.revision,coordinatorMemberId:members[0]});
  for(const m of (await cmd<{items:Array<{id:string}>}>('member.list',{projectId,roomId:room.id})).items)if(!members.includes(m.id))await cmd('room.members.set',{roomId:room.id,memberId:m.id,action:'remove'});
  const rootTarget={kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId};
  const submit=(body:string,target:unknown=rootTarget,id?:string,extra:Record<string,unknown>={})=>cmd<{taskId:string;threadId:string;messageId:string}>('message.submit',{target,body,intent:'default',mentions:[{kind:'all'}],...extra},id);
  let behavior:(id:string,text:string)=>FakeTurnScript=(id)=>complete(`真实回复 ${id}`);
  const adapter=new FakeRuntimeAdapter({structuredFinal:false,turnScriptSequencer:input=>{
    const turn=/\bturn=([^\s]+)/.exec(input.text)?.[1];
    const row=db.prepare('SELECT member_id FROM agent_turns WHERE id=?').get(turn) as {member_id:string};
    const key=input.text.match(/resultKey=([^；\n]+)/)?.[1]??input.text.match(/"resultKey":"(result_[^"]+)"/)?.[1];
    expect(key).toBeTruthy();
    return behavior(row.member_id,input.text).map(item=>item.kind==='event'&&item.event.kind==='turn.completed'?{kind:'event' as const,event:{...item.event,finalText:item.event.finalText?.replace('"resultKey":"fixture"',`"resultKey":"${key}"`)}}:item);
  }});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r134-broadcast',appDataDir:dir});
  const drain=async()=>{for(let i=0;i<5;i++)await worker.drain();};
  const replies=(threadId:string)=>db.prepare("SELECT author_id,body_json FROM messages WHERE thread_id=? AND author_type='agent' ORDER BY thread_message_seq").all(threadId) as {author_id:string;body_json:string}[];
  return{dir,db,cmd,members,adapter,worker,submit,drain,replies,projectId,room,setBehavior:(f:typeof behavior)=>{behavior=f;},close:async()=>{await adapter.closeAllSessions();db.close();}};
}
function complete(answer:string,extra:Record<string,unknown>={}):FakeTurnScript{return[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',answer,changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...extra})}}];}

describe('R134 ordinary all is independently dispatched by the formal worker',()=>{
  it.each(['conversation','work'] as const)('delivers %s to both authors once without planning, review or synthesis',async responseKind=>{
    const f=await fixture();try{
      f.setBehavior((id,text)=>{expect(text).toContain('同一条原始请求');return complete(`真实回复 ${id}`,{responseKind});});
      const id=randomUUID(),sent=await f.submit('同一条原始请求',undefined,id);
      expect(await f.submit('同一条原始请求',undefined,id)).toEqual(sent);
      await f.drain();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.replies(sent.threadId).map(r=>r.author_id).sort()).toEqual([...f.members].sort());
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'DONE'});
      expect(f.db.prepare('SELECT state,integration_run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId)).toEqual({state:'completed',integration_run_id:null});
      expect(f.db.prepare('SELECT count(*) n FROM coordination_integration_attempts').get()).toEqual({n:0});
      await f.drain();expect(f.adapter.startTurnLog).toHaveLength(2);
    }finally{await f.close();}
  });
  it('queues independent thread requests with frozen recipients, preserves the anchor and excludes room-only members',async()=>{
    const f=await fixture();try{
      const sent=await f.submit('根问题');await f.drain();
      const c=(await f.cmd<{memberId:string}>('member.create',{projectId:f.projectId,displayName:'房间丙'})).memberId;
      const threadTarget={kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:sent.threadId};
      await f.submit('跟进甲',threadTarget);await f.submit('跟进乙',threadTarget);await f.drain();
      expect(f.adapter.startTurnLog).toHaveLength(6);
      expect(f.replies(sent.threadId)).toHaveLength(6);expect(f.replies(sent.threadId).some(r=>r.author_id===c)).toBe(false);
      expect(f.db.prepare('SELECT root_message_id FROM tasks WHERE id=?').get(sent.taskId)).toEqual({root_message_id:sent.messageId});
      expect(f.db.prepare('SELECT status FROM thread_reply_requests ORDER BY rowid').all()).toEqual([{status:'succeeded'},{status:'succeeded'}]);
    }finally{await f.close();}
  });
  it('keeps intentional silent replies silent without hiding the other member',async()=>{
    const f=await fixture();try{
      f.setBehavior(id=>id===f.members[0]?complete('',{replyDisposition:'none',changeSummary:''}):complete('乙仍可见'));
      const sent=await f.submit('无需每人强制发言');await f.drain();
      expect(f.adapter.startTurnLog).toHaveLength(2);expect(f.replies(sent.threadId).map(r=>r.author_id)).toEqual([f.members[1]]);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'DONE'});
    }finally{await f.close();}
  });
  it('one failed recipient does not prevent the other from receiving its request',async()=>{
    const f=await fixture();try{
      const first=[...f.members].sort()[0];f.setBehavior(id=>id===first?[{kind:'event',event:{kind:'turn.failed',code:'SYNTHETIC_FAILURE',message:'合成失败',retryable:false}}]:complete('未失败的真实答复'));
      const sent=await f.submit('各自接收');await f.drain();
      expect(f.adapter.startTurnLog).toHaveLength(2);expect(f.replies(sent.threadId)).toHaveLength(1);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'BLOCKED'});
      expect(f.db.prepare('SELECT status FROM workflow_runs WHERE task_id=?').get(sent.taskId)).toEqual({status:'PARTIAL'});
    }finally{await f.close();}
  });
  it('stopping the parent before recipients start cancels all accepted steps',async()=>{
    const f=await fixture();try{
      const sent=await f.submit('稍后执行');await f.worker.runOnce();
      const run=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').get(sent.taskId) as {run_id:string};
      await f.cmd('task.stop',{taskId:sent.taskId,targetRunId:run.run_id,expectedStopGeneration:0});await f.drain();
      expect(f.adapter.startTurnLog).toHaveLength(0);
      expect(f.db.prepare('SELECT status FROM tasks WHERE parent_task_id=?').all(sent.taskId)).toEqual([{status:'CANCELLED'},{status:'CANCELLED'}]);
    }finally{await f.close();}
  });
  it('resumes a persisted fan-out after worker restart without starting a planning turn',async()=>{
    const f=await fixture();try{
      const sent=await f.submit('重启后继续派给原名单');await f.worker.runOnce();
      const restarted=new DispatchWorker({db:f.db,adapter:f.adapter,leaseOwner:'r134-restart',appDataDir:f.dir});
      await restarted.drain();await restarted.drain();
      expect(f.adapter.startTurnLog).toHaveLength(2);expect(f.replies(sent.threadId)).toHaveLength(2);
      expect(f.db.prepare('SELECT count(*) n FROM coordination_runs WHERE task_id=?').get(sent.taskId)).toEqual({n:1});
    }finally{await f.close();}
  });
  it('enforces the shared frozen budget without reserving two unnecessary integration calls',async()=>{
    const f=await fixture();try{
      await f.cmd('app.settings.set',{key:'callBudget.enabled',value:'true'});
      const sent=await f.submit('恰好两次');
      const policy=JSON.parse((f.db.prepare('SELECT deliberation_budget_json FROM tasks WHERE id=?').get(sent.taskId) as {deliberation_budget_json:string}).deliberation_budget_json);
      policy.maxTurns=2;policy.callBudget.limit=2;policy.callBudget.limitSource='override';
      f.db.prepare('UPDATE tasks SET deliberation_budget_json=? WHERE id=?').run(JSON.stringify(policy),sent.taskId);
      await f.drain();expect(f.adapter.startTurnLog).toHaveLength(2);expect(f.replies(sent.threadId)).toHaveLength(2);
      const second=await f.submit('不足两次');policy.maxTurns=1;policy.callBudget.limit=1;
      f.db.prepare('UPDATE tasks SET deliberation_budget_json=? WHERE id=?').run(JSON.stringify(policy),second.taskId);
      await f.drain();expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(second.taskId)).toEqual({status:'BLOCKED'});
    }finally{await f.close();}
  });
  it('retains each completed member question and resumes only the explicitly addressed child',async()=>{
    const f=await fixture();try{
      f.setBehavior(id=>complete(`成员问题 ${id}`,{userQuestion:`请确认 ${id} 的预算？`}));
      const sent=await f.submit('分别问我各自缺少的信息');await f.drain();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'WAITING_USER'});
      f.setBehavior(()=>complete('本成员问题已收到答复'));
      await f.submit('仅答复甲：预算100元',{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:sent.threadId},undefined,{mentions:[{kind:'member',memberId:f.members[0]}]});
      await f.drain();expect(f.adapter.startTurnLog).toHaveLength(3);
      expect(f.replies(sent.threadId).at(-1)?.author_id).toBe(f.members[0]);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'WAITING_USER'});
    }finally{await f.close();}
  });
  it('keeps one acceptance point for actual member work without a synthesis call',async()=>{
    const f=await fixture();try{
      const revision=(f.db.prepare('SELECT revision FROM projects WHERE id=?').get(f.projectId) as {revision:number}).revision;
      await f.cmd('project.reviewPolicy.set',{projectId:f.projectId,taskReviewEnabled:true,expectedRevision:revision});
      f.setBehavior(id=>complete(`成员工作 ${id}`,{responseKind:'work'}));
      const sent=await f.submit('每人独立交付，待我验收');await f.drain();
      expect(f.adapter.startTurnLog).toHaveLength(2);expect(f.replies(sent.threadId)).toHaveLength(2);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'REVIEW'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE parent_task_id=?').all(sent.taskId)).toEqual([{status:'DONE'},{status:'DONE'}]);
      const delivery=f.db.prepare('SELECT d.* FROM task_deliveries d JOIN tasks t ON t.current_delivery_id=d.id WHERE t.id=?').get(sent.taskId) as {id:string;revision:number;manifest_hash:string;artifact_refs_json:string};
      expect(JSON.parse(delivery.artifact_refs_json)).toHaveLength(2);
      const document=await f.cmd<{text:string;hashMatch:boolean}>('delivery.document',{deliveryId:delivery.id});
      expect(document.hashMatch).toBe(true);
      for(const id of f.members)expect(document.text).toContain(`成员工作 ${id}`);
      f.setBehavior(()=>complete('这次只解释，不变更成果'));
      await f.submit('解释这份成果',{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:sent.threadId});
      await f.drain();
      expect(f.db.prepare('SELECT status,current_delivery_id FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'REVIEW',current_delivery_id:delivery.id});
      await f.cmd('task.review',{taskId:sent.taskId,deliveryId:delivery.id,deliveryRevision:delivery.revision,manifestHash:delivery.manifest_hash,decision:'accept'});
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'DONE'});
      await f.drain();expect(f.adapter.startTurnLog).toHaveLength(4);
    }finally{await f.close();}
  });
  it('a sibling failure keeps the other member question answerable until it is resolved',async()=>{
    const f=await fixture();try{
      const first=[...f.members].sort()[0],other=f.members.find(id=>id!==first)!;
      f.setBehavior(id=>id===first?[{kind:'event',event:{kind:'turn.failed',code:'SYNTHETIC_FAILURE',message:'合成失败',retryable:false}}]:complete('需确认预算',{userQuestion:'预算是多少？'}));
      const sent=await f.submit('两个独立步骤');await f.drain();
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'WAITING_USER'});
      const question=f.replies(sent.threadId).find(r=>r.author_id===other)!;
      const questionId=(f.db.prepare('SELECT id FROM messages WHERE thread_id=? AND author_id=?').get(sent.threadId,question.author_id) as {id:string}).id;
      f.setBehavior(()=>complete('已按100元完成确认'));
      await f.submit('预算100元',{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:sent.threadId,replyToMessageId:questionId},undefined,{mentions:[{kind:'member',memberId:other}]});
      await f.drain();expect(f.adapter.startTurnLog).toHaveLength(3);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'BLOCKED'});
    }finally{await f.close();}
  });
  it.each([false,true])('checks actual file versions before collecting independent results (overlap=%s)',async overlap=>{
    const f=await fixture();try{
      f.setBehavior(id=>{
        const path=overlap?'same.txt':`${id}.txt`;
        return[{kind:'writeFile',path,content:`version ${id}`},...complete(`独立修改 ${id}`,{responseKind:'work',files:[path]})];
      });
      const sent=await f.submit('分别处理文件');await f.drain();
      expect(f.adapter.startTurnLog).toHaveLength(2);expect(f.replies(sent.threadId)).toHaveLength(2);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:overlap?'BLOCKED':'DONE'});
      const details=await f.cmd<{coordination:{state:string;errorMessage:string|null}}>('task.details',{projectId:f.projectId,taskId:sent.taskId});
      expect(details.coordination.state).toBe(overlap?'blocked':'completed');
      if(overlap)expect(details.coordination.errorMessage).toContain('同一路径');
    }finally{await f.close();}
  });
  it('freezes the accepted rework note into every new child without adding a synthesis turn',async()=>{
    const f=await fixture();try{
      const revision=(f.db.prepare('SELECT revision FROM projects WHERE id=?').get(f.projectId) as {revision:number}).revision;
      await f.cmd('project.reviewPolicy.set',{projectId:f.projectId,taskReviewEnabled:true,expectedRevision:revision});
      f.setBehavior(id=>complete(`原成果 ${id}`,{responseKind:'work'}));
      const sent=await f.submit('分别交付');await f.drain();
      const first=f.db.prepare('SELECT d.* FROM task_deliveries d JOIN tasks t ON t.current_delivery_id=d.id WHERE t.id=?').get(sent.taskId) as {id:string;revision:number;manifest_hash:string;run_id:string};
      const note='每位保留自己的正文，补充预算上限 R134_REWORK_BOUND';
      await f.cmd('task.review',{taskId:sent.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,decision:'changes_requested',note});
      let count=0;f.setBehavior((id,text)=>{expect(text).toContain(note);expect(text).toContain(first.id);count++;return complete(`新成果 ${id}`,{responseKind:'work'});});
      await f.cmd('task.executeRework',{taskId:sent.taskId,deliveryId:first.id,deliveryRevision:first.revision,manifestHash:first.manifest_hash,sourceRunId:first.run_id});await f.drain();
      expect(count).toBe(2);expect(f.adapter.startTurnLog).toHaveLength(4);
      const second=f.db.prepare('SELECT d.* FROM task_deliveries d JOIN tasks t ON t.current_delivery_id=d.id WHERE t.id=?').get(sent.taskId) as {revision:number};
      expect(second.revision).toBe(first.revision+1);
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId)).toEqual({status:'REVIEW'});
    }finally{await f.close();}
  });
  it('removed members invalidate a frozen queued broadcast instead of silently narrowing it',async()=>{
    const f=await fixture();try{
      const sent=await f.submit('根问题');await f.drain();
      const target={kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:sent.threadId};
      await f.submit('冻结全体',target);
      const snapshot=readThreadMembers(f.db,sent.threadId);
      await f.cmd('thread.members.change',{projectId:f.projectId,threadId:sent.threadId,memberId:f.members[1],action:'remove',expectedVersion:snapshot.version});await f.drain();
      expect(f.adapter.startTurnLog).toHaveLength(2);
      expect(f.db.prepare('SELECT status,error_message FROM thread_reply_requests').get()).toMatchObject({status:'blocked'});
    }finally{await f.close();}
  });
});
