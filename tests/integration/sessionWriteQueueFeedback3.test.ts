import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {DispatchAdmission} from '../../src/daemon/admission.ts';
import {acquireLease} from '../../src/daemon/workspaceLocks.ts';
import {collisionFixture,finish,ObservedAdapter,pause} from '../helpers/collisionHarnessR122.ts';

beforeEach(()=>{
  vi.stubEnv('ZS_ALLOW_FAKE','1');
  vi.stubEnv('ZS_RUNTIME','fake');
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
});
afterEach(()=>vi.unstubAllEnvs());

describe('feedback 3: formal writable dispatch, independent sessions and physical write queues',()=>{
  it('retries a pending physical write lease after another consumer releases it, without unrelated work waking the queue',async()=>{
    const writer=new ObservedAdapter({turnScriptSequencer:()=>finish('持有者完成',150)});
    const waiting=new ObservedAdapter({turnScriptSequencer:()=>finish('等待者完成',20)});
    const f=await collisionFixture('feedback3-external-write-release',{members:1,writable:true,adapter:waiting});
    // Both consumers exist before the first dispatch, so neither restores an
    // in-memory admission slot belonging to the other. SQLite is authoritative.
    const owner=new DispatchWorker({db:f.db,adapter:writer,leaseOwner:randomUUID(),appDataDir:f.dir,detachedTurnConsumption:true,automaticRecovery:false});
    try{
      const project=f.projects[0]!;
      await f.cmd('member.setRuntime',{memberId:project.members[0],kind:'fake',permissionMode:'acceptEdits'});
      await f.cmd('project.writeAccess.set',{projectId:project.id,authorized:true,expectedRevision:0});
      const a=await f.send(0,0,[0],'TOKEN_OWNER 独立会话先持有目录');
      await owner.runOnce();
      const b=await f.send(0,0,[0],'TOKEN_WAIT 后一串等待真实写锁');
      await f.worker.drain();
      expect(waiting.turns).toHaveLength(0);
      expect(f.count("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='changeset.baselineCaptured'",b.taskId)).toBe(0);
      await owner.awaitInFlightTurns(3000);
      expect(f.taskStatus(a.taskId)).toBe('DONE');
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
      // This must start b even though f.worker has received no completion callback.
      await f.worker.drain();
      expect(waiting.turns.map(t=>t.taskId)).toEqual([b.taskId]);
      await f.pumpUntil(()=>f.taskStatus(b.taskId)==='DONE');
      expect(f.count("SELECT count(*) n FROM domain_events WHERE kind='changeset.baselineCaptured'")).toBe(2);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{
      await writer.closeAllSessions();
      await owner.awaitInFlightTurns(3000);
      await f.close();
    }
  },10000);

  it('starts default full-access threads concurrently with separate sessions, snapshots and files, and guards overlapping undo',async()=>{
    const nameFor=(text:string)=>text.includes('TOKEN_FIRST')?'a.txt':text.includes('TOKEN_SECOND')?'b.txt':'c.txt';
    const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish(JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',answer:'写入完成',responseKind:'work',changeSummary:'写入自己的文件',files:[nameFor(text)],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]}),1200)});
    const f=await collisionFixture('feedback3-default-write-lock',{members:1,writable:true,isolatedGit:true,adapter,admission:new DispatchAdmission({globalMaxInFlight:4,perProjectMaxInFlight:4,perProviderMaxInFlight:4})});
    const counter=join(f.projects[0]!.path,'counter.txt');writeFileSync(counter,'original');
    adapter.onStart=async(_session,request,input)=>{
      expect(input.writeAccess?.fullAccess).toBe(true);
      expect(input.writeAccess?.modificationAuthorized).toBe(true);
      expect(input.writeAccess?.analysisOnly).not.toBe(true);
      writeFileSync(join(input.cwd,input.threadId+'.txt'),input.threadId);
      writeFileSync(join(input.cwd,nameFor(request.text)),input.threadId);
      writeFileSync(counter,input.threadId);
    };
    try{
      const a=await f.send(0,0,[0],'TOKEN_FIRST 普通可写请求');
      const b=await f.send(0,0,[0],'TOKEN_SECOND 另一串普通可写请求');
      const c=await f.send(0,0,[0],'TOKEN_THIRD 第三串普通可写请求');
      await f.worker.runOnce();await f.worker.drain();
      expect(adapter.turns.map(t=>t.taskId)).toEqual([a.taskId,b.taskId,c.taskId]);
      expect(adapter.active.size).toBe(3);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status='active'")).toBe(3);
      expect(f.count("SELECT count(*) n FROM domain_events WHERE kind='changeset.baselineCaptured'")).toBe(3);
      const cs=f.db.prepare('SELECT id FROM change_sets WHERE task_id=?').get(a.taskId) as {id:string};
      expect((await f.raw('changeset.undo',{changeSetId:cs.id})).ok).toBe(false);
      await f.pumpUntil(()=>[a,b,c].every(t=>f.taskStatus(t.taskId)==='DONE'));
      expect(readFileSync(counter,'utf8')).toBe(c.threadId);
      for(const root of [a,b,c])expect(readFileSync(join(f.projects[0]!.path,root.threadId+'.txt'),'utf8')).toBe(root.threadId);
      expect(new Set(adapter.turns.map(t=>t.sessionId)).size).toBe(3);
      const inputs=adapter.turns.map(t=>adapter.sessionsSeen.get(t.sessionId)!);
      expect(inputs.map(s=>s.threadId)).toEqual([a.threadId,b.threadId,c.threadId]);
      expect(inputs.every(s=>s.resume==null)).toBe(true);
      expect(adapter.peakWritableRoot).toBe(3);
      const snapshot=f.db.prepare("SELECT state,sha256,content_ref,error FROM change_set_files WHERE change_set_id=? AND path='counter.txt' AND role='before'").get(cs.id) as {state:string;sha256:string;content_ref:string;error:string};
      expect(snapshot.state).toBe('present');expect(snapshot.sha256).toBeTruthy();expect(snapshot.content_ref).toBeTruthy();
      for(const [root,name] of [[a,'a.txt'],[b,'b.txt'],[c,'c.txt']] as const){
        const files=f.db.prepare("SELECT a.source_name,a.blob_path FROM message_attachments ma JOIN messages m ON m.id=ma.message_id JOIN artifacts a ON a.id=ma.artifact_id WHERE m.task_id=? AND a.source_name IN ('a.txt','b.txt','c.txt')").all(root.taskId) as Array<{source_name:string;blob_path:string}>;
        expect(files.map(file=>file.source_name)).toEqual([name]);
        expect(readFileSync(files[0]!.blob_path,'utf8')).toBe(root.threadId);
        const observations=f.db.prepare("SELECT role,state,sha256,content_ref FROM change_set_files WHERE change_set_id=(SELECT id FROM change_sets WHERE task_id=?) AND path=?").all(root.taskId,name) as Array<{role:string;state:string;sha256:string|null;content_ref:string|null}>;
        expect(observations.find(file=>file.role==='after')?.state).toBe('present');
        expect(f.count("SELECT count(*) n FROM message_file_changes WHERE task_id=? AND path IN ('a.txt','b.txt','c.txt') AND change_set_id IS NOT NULL",root.taskId)).toBe(0);
      }
      writeFileSync(counter,'later user edit');
      const undo=await f.raw('changeset.undo',{changeSetId:cs.id});
      expect(undo.ok).toBe(false);expect(undo.error?.message).toContain('并行');
      expect(readFileSync(counter,'utf8')).toBe('later user edit');
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it('does not let a different project reuse a same-root shared writer admission or lease',async()=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('完成',450)});
    const f=await collisionFixture('feedback3-foreign-shared-root',{projects:2,members:1,writable:true,adapter});
    try{
      await f.send(0,0,[0],'TOKEN_PROJECT_A');await f.send(1,0,[0],'TOKEN_PROJECT_B');
      await f.worker.drain();expect(adapter.active.size).toBe(2);
      const owner=adapter.turns[0]!,foreign=adapter.turns[1]!;
      const root=f.db.prepare('SELECT lock_domain FROM workspace_leases WHERE owner_turn_id=?').get(owner.turnId) as {lock_domain:string};
      const denied=acquireLease(f.db,{ownerTurnId:foreign.turnId,lockDomain:root.lock_domain,policy:'session_scope',now:Date.now()});
      expect(denied.ok).toBe(false);
      expect(f.count('SELECT count(*) n FROM workspace_leases WHERE owner_turn_id=?',foreign.turnId)).toBe(1);
      const admission=new DispatchAdmission({globalMaxInFlight:4,perProjectMaxInFlight:4,perProviderMaxInFlight:4});
      expect(admission.tryAcquire('a',{memberId:'a',projectId:'a',providerKey:'fake',executionScopeKey:'a',writeRootKey:root.lock_domain,writePolicy:'session_scope',writeSessionScopeKey:'a'}).granted).toBe(true);
      expect(admission.tryAcquire('b',{memberId:'b',projectId:'b',providerKey:'fake',executionScopeKey:'b',writeRootKey:root.lock_domain,writePolicy:'session_scope',writeSessionScopeKey:'b'})).toEqual({granted:false,reason:'write-root'});
      await f.pumpUntil(()=>f.count("SELECT count(*) n FROM tasks WHERE status!='DONE'")===0);
    }finally{await f.close();}
  },10000);

  it.each(['UNKNOWN','retained','expired'] as const)('blocks new full-access writers when an earlier shared writer becomes %s',async(protection)=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('完成',350)});
    const f=await collisionFixture('feedback3-protected-'+protection,{members:1,writable:true,adapter});
    try{
      await f.send(0,0,[0],'TOKEN_PROTECTED 首串');await f.worker.runOnce();
      const turn=adapter.turns[0]!;
      if(protection==='UNKNOWN')f.db.prepare("UPDATE agent_turns SET status='UNKNOWN' WHERE id=?").run(turn.turnId);
      else if(protection==='retained')f.db.prepare("UPDATE agent_turns SET protection_state='retained' WHERE id=?").run(turn.turnId);
      else f.db.prepare("UPDATE workspace_leases SET status='expired' WHERE owner_turn_id=?").run(turn.turnId);
      const b=await f.send(0,0,[0],'TOKEN_BLOCKED 不得穿过保护');
      await f.worker.drain();
      expect(adapter.turns).toHaveLength(1);
      expect(f.count("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='changeset.baselineCaptured'",b.taskId)).toBe(0);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE owner_turn_id=? AND status!='released'",turn.turnId)).toBe(1);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it('queues follow-ups only behind their own writable thread while another writable thread is active',async()=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('回复',250)});
    const f=await collisionFixture('feedback3-full-follow',{members:1,writable:true,adapter});
    let threadPeak=0;
    adapter.onStart=(_session,_request,input)=>{
      threadPeak=Math.max(threadPeak,[...adapter.active.values()].filter(s=>s.threadId===input.threadId).length);
    };
    try{
      const a=await f.send(0,0,[0],'TOKEN_A 第一串');
      const b=await f.send(0,0,[0],'TOKEN_B 第二串');
      await f.worker.drain();expect(adapter.active.size).toBe(2);
      const project=f.projects[0]!,room=project.rooms[0]!;
      for(const body of ['TOKEN_FOLLOW_1','TOKEN_FOLLOW_2'])await f.cmd('message.submit',{
        target:{kind:'thread',projectId:project.id,conversationId:room.conversationId,threadId:a.threadId},
        body,intent:'default',mentions:[{kind:'member',memberId:project.members[0]}],
      });
      await f.worker.drain();expect(adapter.turns).toHaveLength(2);
      await f.pumpUntil(()=>[a,b].every(t=>f.taskStatus(t.taskId)==='DONE')&&f.count("SELECT count(*) n FROM thread_reply_requests WHERE status IN ('queued','running')")===0);
      expect(threadPeak).toBe(1);expect(adapter.peakWritableRoot).toBe(2);
      const follow=adapter.turns.filter(t=>adapter.sessionsSeen.get(t.sessionId)!.threadId===a.threadId).slice(1);
      expect(follow).toHaveLength(2);expect(follow[0]!.text).toContain('TOKEN_FOLLOW_1');expect(follow[1]!.text).toContain('TOKEN_FOLLOW_2');
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it('does not turn a conversation into a work delivery or attach a peer file merely because the shared directory changed',async()=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>{
      const writer=text.includes('TOKEN_WRITER');
      return finish(JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',answer:writer?'产物已保存':'只回答本串问题',responseKind:writer?'work':'conversation',changeSummary:'完成',files:writer?['peer.txt']:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]}),350);
    }});
    const f=await collisionFixture('feedback3-directory-attribution',{members:1,writable:true,isolatedGit:true,adapter});
    adapter.onStart=(_session,input,scope)=>{if(input.text.includes('TOKEN_WRITER'))writeFileSync(join(scope.cwd,'peer.txt'),'peer bytes');};
    try{
      const chat=await f.send(0,0,[0],'TOKEN_CHAT 回答本串问题');
      const writer=await f.send(0,0,[0],'TOKEN_WRITER 产生自己的文件');
      await f.worker.drain();expect(adapter.active.size).toBe(2);
      await f.pumpUntil(()=>[chat,writer].every(t=>f.taskStatus(t.taskId)==='DONE'));
      expect(f.count('SELECT count(*) n FROM task_deliveries WHERE task_id=?',chat.taskId)).toBe(0);
      expect(f.count("SELECT count(*) n FROM artifacts WHERE task_id=? AND source_name='peer.txt'",chat.taskId)).toBe(0);
      expect(f.count("SELECT count(*) n FROM artifacts WHERE task_id=? AND source_name='peer.txt'",writer.taskId)).toBe(1);
      expect(f.count("SELECT count(*) n FROM change_set_files WHERE change_set_id=(SELECT id FROM change_sets WHERE task_id=?) AND path='peer.txt' AND role='after' AND state='present'",chat.taskId)).toBe(1);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it('does not mistake another thread file write for work by a short multi-member conversation',async()=>{
    const adapter=new ObservedAdapter({structuredFinal:false,turnScriptSequencer:()=>finish(JSON.stringify({schemaVersion:'analysis-draft-v1',summary:'你好！',document:null,
      completion:{disposition:'conversation',reason:'仅回应问候'},claims:[],recommendations:[],openQuestions:[]}),100)});
    const writerAdapter=new ObservedAdapter({turnScriptSequencer:()=>finish(JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',answer:'已保存文件',responseKind:'work',changeSummary:'保存',files:['peer.txt'],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]}),600)});
    const f=await collisionFixture('feedback3-deliberation-attribution',{members:3,writable:true,isolatedGit:true,adapter});
    const writerMember=f.projects[0]!.members[2]!;
    const worker=new DispatchWorker({db:f.db,adapter,adapterFor:memberId=>memberId===writerMember?writerAdapter:adapter,leaseOwner:randomUUID(),appDataDir:f.dir,enableDeliberate:true,detachedTurnConsumption:true,automaticRecovery:false});
    writerAdapter.onStart=(_session,_input,scope)=>writeFileSync(join(scope.cwd,'peer.txt'),'unrelated writer bytes');
    try{
      const project=f.projects[0]!,room=project.rooms[0]!;
      const chat=await f.cmd<{taskId:string}>('message.submit',{target:{kind:'room_root',projectId:project.id,roomId:room.id,conversationId:room.conversationId},
        body:'你好',intent:'default',collaboration:'deliberate',mentions:project.members.slice(0,2).map(memberId=>({kind:'member',memberId}))});
      await worker.runOnce();await worker.runOnce();
      const writer=await f.send(0,0,[2],'TOKEN_PEER_WRITE 保存文件');
      const deadline=Date.now()+6000;
      while(Date.now()<deadline&&![chat,writer].every(t=>f.taskStatus(t.taskId)==='DONE')){await worker.drain();await pause(5);}
      expect(f.taskStatus(chat.taskId)).toBe('DONE');expect(f.taskStatus(writer.taskId)).toBe('DONE');
      expect(f.count("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='run.shortExchangeCompleted'",chat.taskId)).toBe(1);
      expect(f.count('SELECT count(*) n FROM task_deliveries WHERE task_id=?',chat.taskId)).toBe(0);
      expect(f.count("SELECT count(*) n FROM artifacts WHERE task_id=? AND source_name='peer.txt'",chat.taskId)).toBe(0);
      expect(f.count("SELECT count(*) n FROM artifacts WHERE task_id=? AND source_name='peer.txt'",writer.taskId)).toBe(1);
    }finally{await adapter.closeAllSessions();await writerAdapter.closeAllSessions();await worker.awaitInFlightTurns(3000);await f.close();}
  },10000);

  it('stopping one full-access thread leaves another full-access thread running to completion',async()=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish('独立串完成',text.includes('TOKEN_STOP')?5000:350)});
    const f=await collisionFixture('feedback3-full-stop',{members:1,writable:true,adapter});
    try{
      const a=await f.send(0,0,[0],'TOKEN_STOP 停止本串');
      const b=await f.send(0,0,[0],'TOKEN_KEEP 另一串继续');
      await f.worker.drain();expect(adapter.active.size).toBe(2);
      const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=?').get(a.taskId) as {id:string};
      expect((await f.raw('task.stop',{taskId:a.taskId,targetRunId:run.id,expectedStopGeneration:0})).ok).toBe(true);
      await f.pumpUntil(()=>f.taskStatus(a.taskId)==='CANCELLED'&&f.taskStatus(b.taskId)==='DONE');
      expect(adapter.turns.filter(t=>t.taskId===b.taskId)).toHaveLength(1);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it('runs ordinary full-access requests concurrently in disjoint physical projects, without the analysis-only switch',async()=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('本目录写入完成',150)});
    const f=await collisionFixture('feedback3-disjoint-writes',{projects:2,members:1,writable:true,adapter});
    adapter.onStart=(_session,request,input)=>{
      expect(input.writeAccess?.fullAccess).toBe(true);
      expect(input.writeAccess?.analysisOnly).not.toBe(true);
      writeFileSync(join(input.cwd,'result.txt'),request.turnId);
    };
    try{
      const a=await f.send(0,0,[0],'TOKEN_PROJECT_A 写自己的目录');
      const b=await f.send(1,0,[0],'TOKEN_PROJECT_B 写另一个目录');
      await f.worker.runOnce();await f.worker.runOnce();
      expect(adapter.active.size).toBe(2);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status='active'")).toBe(2);
      await f.pumpUntil(()=>[a,b].every(t=>f.taskStatus(t.taskId)==='DONE'));
      for(const turn of adapter.turns){
        const input=adapter.sessionsSeen.get(turn.sessionId)!;
        expect(readFileSync(join(input.cwd,'result.txt'),'utf8')).toBe(turn.turnId);
      }
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);
});
