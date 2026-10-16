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
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';

afterEach(()=>vi.unstubAllEnvs());
async function fixture(){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r87-members-')),project=join(dir,'project');mkdirSync(project);
  const file=join(dir,'state.sqlite');const db=openDatabase(file);
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:async()=>{}};
  const raw=async<T>(method:string,params:unknown,id:string=randomUUID())=>await dispatchDaemonCommand(deps,{protocolVersion:1,commandId:id,method,params}) as {ok:boolean;data:T;replayed?:boolean;error?:{code:string}};
  const cmd=async<T>(method:string,params:unknown,id?:string)=>{const r=await raw<T>(method,params,id);expect(r.ok,JSON.stringify(r.error)).toBe(true);return r.data;};
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:Array<{id:string;conversationId:string}>}>('room.list',{projectId})).items[0]!;
  const ids:string[]=[];for(const name of ['同名','同名','房间其他成员'])ids.push((await cmd<{memberId:string}>('member.create',{projectId,displayName:name})).memberId);
  const root=await cmd<{threadId:string;taskId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'你好',intent:'default',mentions:[{kind:'member',memberId:ids[0]}]});
  const get=async()=>(await cmd<{members:ThreadMembersSnapshot}>('thread.get',{threadId:root.threadId})).members;
  const change=(memberId:string,action:'add'|'remove',expectedVersion:string)=>({projectId,threadId:root.threadId,memberId,action,expectedVersion});
  return{file,db,raw,cmd,get,change,ids,projectId,room,root};
}

describe('R87 durable thread participants, formal commands, zero inference',()=>{
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
