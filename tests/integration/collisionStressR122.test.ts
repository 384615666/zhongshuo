import {afterEach,describe,expect,it,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {collisionFixture,finish,ObservedAdapter,pause} from '../helpers/collisionHarnessR122.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';

afterEach(()=>vi.unstubAllEnvs());
function simulation(){vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');}

describe('R122 disruptive overlapping user requests through formal commands and worker',()=>{
  it('20 follow-ups arriving in one busy thread are queued and settled exactly once in arrival order',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish(text.includes('TOKEN_ROOT_ONLY')?'根回复':'后续回复',35)});
    const f=await collisionFixture('same-thread-followup-flood',{adapter});
    try{
      const root=await f.send(0,0,[0],'TOKEN_ROOT_ONLY 先开始');await f.worker.runOnce();
      const p=f.projects[0]!,room=p.rooms[0]!;
      const responses=await Promise.all(Array.from({length:20},(_,i)=>f.raw('message.submit',{target:{kind:'thread',projectId:p.id,conversationId:room.conversationId,threadId:root.threadId},body:`FOLLOWUP_${i} 又有一个要求`,intent:'default',mentions:[{kind:'member',memberId:p.members[0]}]})));
      expect(responses.every(r=>r.ok),JSON.stringify(responses.filter(r=>!r.ok))).toBe(true);
      await f.pumpUntil(()=>f.count("SELECT count(*) n FROM thread_reply_requests WHERE status IN ('queued','running')")===0&&f.taskStatus(root.taskId)==='DONE');
      const states=f.db.prepare('SELECT status,count(*) n FROM thread_reply_requests GROUP BY status').all();
      expect(adapter.turns).toHaveLength(21);
      expect(f.count("SELECT count(*) n FROM thread_reply_requests WHERE status='succeeded'")).toBe(20);
      const requests=f.db.prepare('SELECT q.turn_id,m.body_json FROM thread_reply_requests q JOIN messages m ON m.id=q.message_id ORDER BY q.rowid').all() as Array<{turn_id:string;body_json:string}>;
      expect(requests.map(r=>r.turn_id)).toEqual(adapter.turns.slice(1).map(t=>t.turnId));
      f.save({ok:true,followups:20,executions:adapter.turns.length,states});
    }finally{await f.close();}
  },30000);

  it('ten distinct command IDs with identical text remain ten independent user requests',async()=>{
    simulation();const f=await collisionFixture('identical-body-new-intents');
    try{
      const roots=await Promise.all(Array.from({length:10},()=>f.send(0,0,[0],'TOKEN_IDENTICAL 每次确实都要做')));
      expect(new Set(roots.map(r=>r.taskId)).size).toBe(10);
      await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE'));
      expect(f.adapter.turns).toHaveLength(10);f.save({ok:true,requests:10,independentTasks:10,executions:10});
    }finally{await f.close();}
  });
  it('36 simultaneous requests across three rooms run the same role at peak two and keep every reply in its original thread',async()=>{
    simulation();const f=await collisionFixture('same-role-burst',{members:1});
    try{
      const roots=await Promise.all(Array.from({length:36},(_,i)=>f.send(0,i%3,[0],`TOKEN_A_${i} 独立处理这件事`)));
      await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE'));
      expect(f.adapter.turns).toHaveLength(36);expect(f.adapter.peakMember).toBe(2);
      expect(new Set(f.adapter.turns.map(t=>t.sessionId)).size).toBe(36);
      for(let i=0;i<roots.length;i++){
        const root=roots[i]!,turn=f.adapter.turns.find(t=>t.taskId===root.taskId)!;
        expect(turn.text).toContain(`TOKEN_A_${i}`);
        const others=[...turn.text.matchAll(/TOKEN_A_(\d+)\b/g)].map(m=>Number(m[1]));
        expect(new Set(others)).toEqual(new Set([i]));
        const replies=f.db.prepare("SELECT body_json FROM messages WHERE thread_id=? AND author_type='agent'").all(root.threadId) as Array<{body_json:string}>;
        expect(replies).toHaveLength(1);expect(replies[0]!.body_json).toContain(`TOKEN_A_${i}`);
      }
      f.save({ok:true,requests:36,uniqueSessions:36,peak:f.adapter.peak,peakMember:f.adapter.peakMember,threadLeaks:0});
    }finally{await f.close();}
  },30000);

  it('12 roots each address three roles while two other projects compete; every selected recipient replies once',async()=>{
    simulation();let script:FakeTurnScript=finish('ready');const adapter=new ObservedAdapter({turnScriptSequencer:()=>script});
    const f=await collisionFixture('many-roles-projects',{projects:3,adapter});
    adapter.onStart=(_session,input,scope)=>{
      const task=f.db.prepare('SELECT parent_task_id,project_id FROM tasks WHERE id=?').get(scope.taskId) as {parent_task_id:string|null;project_id:string};
      const planning=f.db.prepare("SELECT 1 FROM coordination_runs WHERE task_id=? AND state='planning'").get(scope.taskId);
      const token=/TOKEN_[A-Za-z0-9_]+/.exec(input.text)?.[0]??'done';
      script=finish(token,35);
      if(!task.parent_task_id&&planning){
        const members=f.projects.find(p=>p.id===task.project_id)!.members;
        script=finish(JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',changeSummary:token,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],coordinationPlan:{summary:'三位成员独立执行',steps:members.map((memberId,i)=>({key:`s${i}`,memberId,title:'独立处理',objective:token,role:'analysis',dependsOn:[]}))}}),20);
      }
    };
    try{
      const roots=await Promise.all(Array.from({length:12},(_,i)=>f.send(i%3,Math.floor(i/3)%3,[0,1,2],`TOKEN_MULTI_${i} 请分别完成独立工作`)));
      await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE'),20000);
      expect(f.adapter.turns).toHaveLength(60);expect(f.adapter.peak).toBeGreaterThan(1);expect(f.adapter.peak).toBeLessThanOrEqual(2);
      for(const root of roots){
        const children=f.db.prepare('SELECT id,owner_member_id,status FROM tasks WHERE parent_task_id=?').all(root.taskId) as Array<{id:string;owner_member_id:string;status:string}>;
        expect(children).toHaveLength(3);expect(new Set(children.map(t=>t.owner_member_id)).size).toBe(3);expect(children.every(t=>t.status==='DONE')).toBe(true);
        for(const child of children)expect(f.adapter.turns.filter(t=>t.taskId===child.id)).toHaveLength(1);
      }
      f.save({ok:true,roots:12,childExecutions:36,totalExecutions:60,peak:f.adapter.peak,peakMember:f.adapter.peakMember,providerLimit:2});
    }finally{await f.close();}
  },30000);

  it('24 writable requests targeting one file serialize read-modify-write without losing updates',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('文件已更新',25)});
    const f=await collisionFixture('same-file-writes',{writable:true,adapter});
    const file=join(f.projects[0]!.path,'counter.txt');writeFileSync(file,'0');
    const writes:Array<Promise<void>>=[];
    adapter.onStart=async()=>{const value=Number(readFileSync(file,'utf8'));const op=pause(10).then(()=>writeFileSync(file,String(value+1)));writes.push(op);await op;};
    try{
      const roots=await Promise.all(Array.from({length:24},(_,i)=>f.send(0,i%3,[i%3],`TOKEN_WRITE_${i} 修改同一文件`)));
      const started=Date.now();await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE'),90000);await Promise.all(writes);
      expect(readFileSync(file,'utf8')).toBe('24');expect(adapter.peakWritableRoot).toBe(1);expect(adapter.turns).toHaveLength(24);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
      expect(f.count("SELECT count(*) n FROM domain_events WHERE kind='changeset.baselineCaptured'")).toBe(24);
      f.save({ok:true,requests:24,finalCounter:24,peakWritableRoot:adapter.peakWritableRoot,elapsedMs:Date.now()-started,baselines:f.count("SELECT count(*) n FROM domain_events WHERE kind='changeset.baselineCaptured'")});
    }finally{await f.close();}
  },100000);

  it('30 concurrent retries of the same send create exactly one message, task and execution',async()=>{
    simulation();const f=await collisionFixture('duplicate-send');
    try{
      const commandId=randomUUID(),results=await Promise.all(Array.from({length:30},()=>f.send(0,0,[0],'TOKEN_DUP 重复点击发送',commandId)));
      expect(new Set(results.map(r=>r.taskId)).size).toBe(1);
      await f.pumpUntil(()=>f.taskStatus(results[0]!.taskId)==='DONE');
      expect(f.adapter.turns).toHaveLength(1);
      expect(f.count("SELECT count(*) n FROM messages WHERE author_type='human' AND json_extract(body_json,'$.text') LIKE '%TOKEN_DUP%'")).toBe(1);
      f.save({ok:true,retries:30,tasks:1,executions:1});
    }finally{await f.close();}
  });

  it('stop spam cancels only one active task while 15 other requests complete',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish(/TOKEN_[A-Za-z0-9_]+/.exec(text)?.[0]??'done',text.includes('TOKEN_STOP_0')?5000:25)});
    const f=await collisionFixture('targeted-stop',{projects:2,adapter});
    try{
      const stopped=await f.send(0,0,[0],'TOKEN_STOP_0 请先工作');await f.worker.runOnce();
      const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(stopped.taskId) as {id:string};
      const roots=await Promise.all(Array.from({length:15},(_,i)=>f.send(i%2,i%3,[i%3],`TOKEN_OTHER_${i} 继续独立工作`)));
      const stop=()=>f.raw('task.stop',{taskId:stopped.taskId,targetRunId:run.id,expectedStopGeneration:0});
      const stops=await Promise.all(Array.from({length:12},stop));expect(stops.every(s=>s.ok)).toBe(true);
      await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE')&&f.taskStatus(stopped.taskId)==='CANCELLED');
      expect(adapter.turns.filter(t=>t.taskId===stopped.taskId)).toHaveLength(1);
      expect(f.count("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'")).toBe(0);
      f.save({ok:true,repeatedStops:12,unrelatedTasksCompleted:15,stoppedExecutions:1});
    }finally{await f.close();}
  },30000);

  it('changing a writable role while its queue is full blocks old snapshots and leaves unrelated roles runnable',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('已处理',80)});const f=await collisionFixture('configuration-churn',{adapter,writable:true});
    try{
      const first=await f.send(0,0,[0],'TOKEN_CONFIG_0 开始');await f.worker.runOnce();
      const queued=await Promise.all(Array.from({length:10},(_,i)=>f.send(0,i%3,[0],`TOKEN_CHANGED_${i} 继续`)));
      await f.cmd('member.setRuntime',{memberId:f.projects[0]!.members[0],kind:'fake',permissionMode:'plan'});
      const independent=await f.send(0,1,[1],'TOKEN_SAFE 独立成员继续');
      await f.pumpUntil(()=>f.taskStatus(first.taskId)==='DONE'&&f.taskStatus(independent.taskId)==='DONE'&&queued.every(r=>f.taskStatus(r.taskId)==='BLOCKED'));
      for(const root of queued)expect(adapter.turns.some(t=>t.taskId===root.taskId)).toBe(false);
      f.save({ok:true,changedQueuedRequestsBlocked:10,unrelatedCompleted:1,existingExecutionCompleted:1});
    }finally{await f.close();}
  },30000);

  it('production session-scoped role slots allow two same-role read-only threads to run concurrently without mixing context',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish(/TOKEN_[A-Za-z0-9_]+/.exec(text)?.[0]??'done',120)});
    const f=await collisionFixture('session-parallel-production',{members:1,adapter});
    try{
      const roots=await Promise.all(Array.from({length:12},(_,i)=>f.send(0,i%3,[0],`TOKEN_SESSION_${i} 独立分析`)));
      await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE'));
      expect(adapter.peakMember).toBe(2);expect(new Set(adapter.turns.map(t=>t.sessionId)).size).toBe(12);
      for(let i=0;i<roots.length;i++)expect(new Set([...adapter.turns.find(t=>t.taskId===roots[i]!.taskId)!.text.matchAll(/TOKEN_SESSION_(\d+)\b/g)].map(m=>Number(m[1])))).toEqual(new Set([i]));
      f.save({ok:true,productionAdmission:true,requests:12,peakSameRole:adapter.peakMember,threadLeaks:0});
    }finally{await f.close();}
  },30000);

  it('production session-scoped role slots still serialize same-project writes',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('已更新',50)});
    const f=await collisionFixture('session-write-production',{members:1,writable:true,adapter});
    try{
      const roots=await Promise.all(Array.from({length:8},(_,i)=>f.send(0,i%3,[0],`TOKEN_SERIAL_${i} 修改文件`)));
      await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE'));
      expect(adapter.peakMember).toBe(1);expect(adapter.peakWritableRoot).toBe(1);
      f.save({ok:true,productionAdmission:true,requests:8,peakSameRole:adapter.peakMember,peakWritableRoot:adapter.peakWritableRoot});
    }finally{await f.close();}
  },30000);

  it('unmanaged external JSON read-modify-write loses an update; this is not the product role-memory API',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('记忆已更新',30)});
    const f=await collisionFixture('shared-memory-collision',{projects:2,writable:true,adapter});
    const memory=join(f.dir,'shared-role-memory.json');writeFileSync(memory,JSON.stringify({entries:[]}));
    let release!:()=>void;const both=new Promise<void>(r=>{release=r;}),captured:Array<{entries:string[]}>=[];
    const writes:Array<Promise<void>>=[];
    adapter.onStart=(_session,_input,scope)=>{
      const before=JSON.parse(readFileSync(memory,'utf8')) as {entries:string[]};captured.push(before);
      if(captured.length===2)release();
      writes.push(both.then(()=>{before.entries.push(scope.taskId);writeFileSync(memory,JSON.stringify(before));}));
    };
    try{
      const roots=await Promise.all([f.send(0,0,[0],'TOKEN_MEM_A 更新共享记忆'),f.send(1,0,[0],'TOKEN_MEM_B 更新共享记忆')]);
      await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE'));
      await Promise.all(writes);const stored=JSON.parse(readFileSync(memory,'utf8')) as {entries:string[]};
      expect(captured).toHaveLength(2);expect(stored.entries).toHaveLength(1);expect(adapter.peak).toBe(2);
      f.save({ok:true,unmanagedExternalJson:true,productMemoryApi:false,successfulTasks:2,expectedMemoryEntries:2,actualMemoryEntries:stored.entries.length,lostUpdates:1});
    }finally{release();await f.close();}
  });

  it('an unresponsive writer retains protection while an unrelated project still completes',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>text.includes('TOKEN_HUNG')?[{kind:'unresponsiveToInterrupt'},{kind:'stall',ms:60000}]:finish('另一个项目完成',30)});
    const f=await collisionFixture('hung-writer-isolation',{projects:2,writable:true,adapter});
    try{
      const hung=await f.send(0,0,[0],'TOKEN_HUNG 这位执行端失去响应');await f.worker.runOnce();await pause(10);
      const queued=await f.send(0,1,[1],'TOKEN_WAIT 同目录需要修改');
      const other=await f.send(1,0,[0],'TOKEN_UNRELATED 另项目继续');
      const run=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=?').get(hung.taskId) as {id:string};
      expect((await f.raw('task.stop',{taskId:hung.taskId,targetRunId:run.id,expectedStopGeneration:0})).ok).toBe(true);
      await f.pumpUntil(()=>f.taskStatus(other.taskId)==='DONE'&&f.count("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'")===1);
      expect(adapter.turns.some(t=>t.taskId===queued.taskId)).toBe(false);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(1);
      f.save({ok:true,unknownWriters:1,sameRootHeld:true,unrelatedProjectCompleted:true});
    }finally{await f.close();}
  },30000);

  it('12 queued writes capture exactly 12 baselines in a fresh standalone Git repository with a captured real file',async()=>{
    simulation();const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish('计数已更新',20)});
    const f=await collisionFixture('standalone-git-write-pressure',{writable:true,adapter,isolatedGit:true});
    const file=join(f.projects[0]!.path,'counter.txt');writeFileSync(file,'0');
    adapter.onStart=()=>{writeFileSync(file,String(Number(readFileSync(file,'utf8'))+1));};
    try{
      const roots=await Promise.all(Array.from({length:12},(_,i)=>f.send(0,i%3,[i%3],`TOKEN_GIT_${i} 更新计数`)));
      const started=Date.now();await f.pumpUntil(()=>roots.every(r=>f.taskStatus(r.taskId)==='DONE'),45000);
      const baselines=f.count("SELECT count(*) n FROM domain_events WHERE kind='changeset.baselineCaptured'");
      expect(readFileSync(file,'utf8')).toBe('12');expect(baselines).toBe(12);
      const captured=f.db.prepare("SELECT json_extract(payload_json,'$.fileCount') n FROM domain_events WHERE kind='changeset.baselineCaptured' ORDER BY seq LIMIT 1").get() as {n:number};expect(captured.n).toBe(1);
      f.save({ok:true,standaloneGit:true,requests:12,finalCounter:12,baselines,elapsedMs:Date.now()-started,capturedFiles:captured.n});
    }finally{await f.close();}
  },50000);
});
