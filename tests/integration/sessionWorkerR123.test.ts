import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {DispatchAdmission,type AdmissionDimensions} from '../../src/daemon/admission.ts';
import {collisionFixture,finish,ObservedAdapter,pause} from '../helpers/collisionHarnessR122.ts';

beforeEach(()=>{
  vi.stubEnv('ZS_ALLOW_FAKE','1');
  vi.stubEnv('ZS_RUNTIME','fake');
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
});
afterEach(()=>vi.unstubAllEnvs());

type Fixture=Awaited<ReturnType<typeof collisionFixture>>;
type Root={taskId:string;threadId:string};
const follow=(f:Fixture,root:Root,body:string)=>f.cmd('message.submit',{
  target:{kind:'thread',projectId:f.projects[0]!.id,conversationId:(f.db.prepare('SELECT conversation_id FROM tasks WHERE id=?').get(root.taskId) as {conversation_id:string}).conversation_id,threadId:root.threadId},
  body,intent:'default',mentions:[{kind:'member',memberId:f.projects[0]!.members[0]}],
});
const scope=(f:Fixture,taskId:string)=>JSON.stringify({
  task:f.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(taskId),
  replies:f.db.prepare('SELECT write_scope_json FROM thread_reply_requests WHERE task_id=? ORDER BY rowid').all(taskId),
});
const noRealCalls=(f:Fixture)=>expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);

/** Observe the actual worker dimensions without changing any admission decision. */
class RecordedAdmission extends DispatchAdmission{
  readonly acquired=new Map<string,AdmissionDimensions>();
  readonly restored=new Map<string,AdmissionDimensions>();
  override tryAcquire(turnId:string,dims:AdmissionDimensions){
    const decision=super.tryAcquire(turnId,dims);
    if(decision.granted)this.acquired.set(turnId,{...dims});
    return decision;
  }
  override restore(turnId:string,dims:AdmissionDimensions){
    this.restored.set(turnId,{...dims});super.restore(turnId,dims);
  }
}

describe('R123 production worker session scope isolation with no real models',()=>{
  it('runs two threads of the same member concurrently while each thread settles follow-ups in arrival order',async()=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('本串回复',180)});
    const f=await collisionFixture('r123-parallel-ordered',{members:1,adapter});
    let peakPerThread=0;
    adapter.onStart=(_session,_input,current)=>{
      peakPerThread=Math.max(peakPerThread,[...adapter.active.values()].filter(s=>s.threadId===current.threadId).length);
    };
    try{
      const a=await f.send(0,0,[0],'TOKEN_SCOPE_A 独立问题');
      const b=await f.send(0,0,[0],'TOKEN_SCOPE_B 另一独立问题');
      await f.worker.runOnce();await f.worker.runOnce();
      expect(adapter.active.size).toBe(2);
      for(let i=0;i<4;i++){
        await follow(f,a,`A_FOLLOW_${i} 继续`);
        await follow(f,b,`B_FOLLOW_${i} 继续`);
      }
      await f.pumpUntil(()=>[a,b].every(r=>f.taskStatus(r.taskId)==='DONE')&&f.count("SELECT count(*) n FROM thread_reply_requests WHERE status IN ('queued','running')")===0);
      expect(adapter.peakMember).toBe(2);expect(peakPerThread).toBe(1);
      expect(adapter.turns).toHaveLength(10);
      for(const [root,prefix] of [[a,'A'],[b,'B']] as const){
        const turns=adapter.turns.filter(t=>adapter.sessionsSeen.get(t.sessionId)!.threadId===root.threadId);
        const queued=f.db.prepare('SELECT turn_id,status FROM thread_reply_requests WHERE thread_id=? ORDER BY rowid').all(root.threadId) as Array<{turn_id:string;status:string}>;
        expect(queued).toHaveLength(4);
        expect(queued.every(q=>q.status==='succeeded')).toBe(true);
        expect(queued.map(q=>q.turn_id)).toEqual(turns.slice(1).map(t=>t.turnId));
        for(let i=0;i<4;i++)expect(turns[i+1]!.text).toContain(`${prefix}_FOLLOW_${i}`);
        expect(turns.every(t=>!t.text.includes(`TOKEN_SCOPE_${prefix==='A'?'B':'A'}`))).toBe(true);
      }
      noRealCalls(f);
    }finally{await f.close();}
  },20000);

  it('stopping one active thread does not interrupt another active thread of the same member',async()=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish('另一串完成',text.includes('TOKEN_STOP_A')?5000:350)});
    const f=await collisionFixture('r123-stop-same-member',{members:1,adapter});
    try{
      const a=await f.send(0,0,[0],'TOKEN_STOP_A 停止目标');
      const b=await f.send(0,0,[0],'TOKEN_KEEP_B 继续目标');
      await f.worker.runOnce();await f.worker.runOnce();
      expect(adapter.active.size).toBe(2);
      const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=?').get(a.taskId) as {id:string};
      expect((await f.raw('task.stop',{taskId:a.taskId,targetRunId:run.id,expectedStopGeneration:0})).ok).toBe(true);
      await f.pumpUntil(()=>f.taskStatus(a.taskId)==='CANCELLED'&&f.taskStatus(b.taskId)==='DONE');
      expect(adapter.turns.filter(t=>t.taskId===b.taskId)).toHaveLength(1);
      expect(f.count("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'")).toBe(0);
      const replies=f.db.prepare("SELECT body_json FROM messages WHERE thread_id=? AND author_type='agent'").all(b.threadId) as Array<{body_json:string}>;
      expect(replies.some(r=>r.body_json.includes('另一串完成'))).toBe(true);
      noRealCalls(f);
    }finally{await f.close();}
  },15000);

  it('a restarted worker restores the UNKNOWN original scope and keeps it protected while another read-only scope runs',async()=>{
    const admission=new RecordedAdmission();
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>[{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:60000}]});
    const f=await collisionFixture('r123-restart-unknown',{members:1,adapter,admission});
    let restarted:DispatchWorker|undefined;
    const nextAdapter=new ObservedAdapter({turnScriptSequencer:()=>finish('独立串完成',60)});
    try{
      const hung=await f.send(0,0,[0],'TOKEN_UNKNOWN 原串');
      const frozen=scope(f,hung.taskId);
      await f.worker.runOnce();await pause(15);
      const turn=adapter.turns[0]!,original=admission.acquired.get(turn.turnId)!;
      const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=?').get(hung.taskId) as {id:string};
      expect((await f.raw('task.stop',{taskId:hung.taskId,targetRunId:run.id,expectedStopGeneration:0})).ok).toBe(true);
      await f.pumpUntil(()=>f.count("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'")===1);
      await f.worker.awaitInFlightTurns(3000);f.worker.stopAccepting();await adapter.closeAllSessions();
      const restored=new RecordedAdmission();
      restarted=new DispatchWorker({db:f.db,adapter:nextAdapter,admission:restored,leaseOwner:randomUUID(),appDataDir:f.dir,detachedTurnConsumption:true,automaticRecovery:false});
      expect(restored.restored.get(turn.turnId)).toEqual(original);
      expect(original.executionScopeKey).toBe(JSON.stringify([f.projects[0]!.id,f.projects[0]!.rooms[0]!.conversationId,hung.threadId,f.projects[0]!.members[0]]));
      // Probe the restored production gate without releasing or rewriting its UNKNOWN slot.
      expect(restored.tryAcquire('same-scope-probe',original)).toEqual({granted:false,reason:'member'});
      await expect(follow(f,hung,'原串尚未核实，不得绕保护')).rejects.toThrow('RECONCILE_REQUIRED');
      const other=await f.send(0,0,[0],'TOKEN_AFTER_RESTART 另一个只读串');
      const deadline=Date.now()+5000;
      while(f.taskStatus(other.taskId)!=='DONE'&&Date.now()<deadline){await restarted.drain();await pause(5);}
      expect(f.taskStatus(other.taskId)).toBe('DONE');
      expect(nextAdapter.turns.map(t=>t.taskId)).toEqual([other.taskId]);
      expect(restored.has(turn.turnId)).toBe(true);
      expect(f.count("SELECT count(*) n FROM agent_turns WHERE id=? AND status='UNKNOWN' AND protection_state IS NOT 'released'",turn.turnId)).toBe(1);
      expect(scope(f,hung.taskId)).toBe(frozen);
      noRealCalls(f);
    }finally{await nextAdapter.closeAllSessions();await restarted?.awaitInFlightTurns(3000);await f.close();}
  },15000);

  it('parallel admission preserves frozen task scopes, real member identity and read-only adapter permissions',async()=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('只读完成',120)});
    const f=await collisionFixture('r123-scope-immutable',{members:1,adapter});
    try{
      const roots=await Promise.all(Array.from({length:6},(_,i)=>f.send(0,i%3,[0],`TOKEN_IMMUTABLE_${i} 只读分析`)));
      for(const root of roots)await follow(f,root,'TOKEN_FROZEN_FOLLOW 只读追问');
      const before=roots.map(r=>scope(f,r.taskId));
      expect(f.count("SELECT count(*) n FROM thread_reply_requests WHERE write_scope_json!='{}'")).toBe(6);
      await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE')&&f.count("SELECT count(*) n FROM thread_reply_requests WHERE status='succeeded'")===6);
      expect(roots.map(r=>scope(f,r.taskId))).toEqual(before);
      expect(adapter.peakMember).toBe(2);
      for(const input of adapter.sessionsSeen.values()){
        expect(input.memberId).toBe(f.projects[0]!.members[0]);
        expect(input.policyId).toBe('policy-analyze');
        expect(input.writeAccess?.modificationAuthorized).toBe(false);
        expect(input.writeAccess?.fullAccess).not.toBe(true);
        expect(input.writeAccess?.allowedWriteRoots??[]).toEqual([]);
      }
      expect(f.count('SELECT count(*) n FROM workspace_leases')).toBe(0);
      expect(f.count("SELECT count(*) n FROM domain_events WHERE kind='changeset.baselineCaptured'")).toBe(0);
      noRealCalls(f);
    }finally{await f.close();}
  });

  it('a queued read-only scope cannot adopt a subsequent permission increase',async()=>{
    const f=await collisionFixture('r123-permission-drift',{members:1});
    try{
      const root=await f.send(0,0,[0],'TOKEN_FROZEN 不得扩大权限');
      await f.pumpUntil(()=>f.taskStatus(root.taskId)==='DONE');
      await follow(f,root,'TOKEN_QUEUED 这条已冻结的只读追问不得扩大权限');
      const before=scope(f,root.taskId);
      await f.cmd('member.setRuntime',{memberId:f.projects[0]!.members[0],kind:'fake',permissionMode:'bypassPermissions'});
      await f.pumpUntil(()=>f.count("SELECT count(*) n FROM thread_reply_requests WHERE task_id=? AND status='blocked'",root.taskId)===1);
      expect(scope(f,root.taskId)).toBe(before);
      expect(f.adapter.turns).toHaveLength(1);
      expect(f.adapter.sessionsSeen.size).toBe(1);
      expect(f.count('SELECT count(*) n FROM workspace_leases')).toBe(0);
      noRealCalls(f);
    }finally{await f.close();}
  });
});
