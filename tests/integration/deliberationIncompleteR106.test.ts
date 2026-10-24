import {afterAll,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../../src/persistence/db.ts';
import {appendDomainEvent} from '../../src/persistence/events.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {pumpDeliberation} from '../../src/daemon/deliberationRunner.ts';
import {listRunArtifacts} from '../../src/persistence/stores/deliberation.ts';
import {readTaskDetails} from '../../src/daemon/taskDetails.ts';
import {seed,createDelibTask,done,draft,runIdOf} from './deliberationFlow.test.ts';

const root=mkdtempSync(join(tmpdir(),'zs-r106-incomplete-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));

describe('R106 incomplete independent deliberation, isolated fake adapter',()=>{
  it.each([false,true])('keeps the valid draft and never self-synthesizes after a peer pre-dispatch failure, exhausted budget=%s',async exhausted=>{
    const db=openDatabase(':memory:');seed(db,['m1','m2']);
    const taskId=createDelibTask(db,exhausted?11:10,['m1','m2']);
    const adapter=new FakeRuntimeAdapter({structuredFinal:false,turnScripts:[done(draft('已完成的独立初稿',[{claimId:'one',statement:'已有证据'}]))]});
    const worker=new DispatchWorker({db,adapter,leaseOwner:'r106',enableDeliberate:true,appDataDir:root});
    try{
      await worker.runOnce(); // Prepare/freeze both seats.
      await worker.runOnce(); // Only the first member calls the fake adapter.
      const runId=runIdOf(db),drafts=listRunArtifacts(db,runId,'analysis_draft');
      expect(drafts).toHaveLength(1);
      if(exhausted){
        const row=db.prepare('SELECT budget_json FROM workflow_runs WHERE id=?').get(runId) as {budget_json:string};
        const budget=JSON.parse(row.budget_json) as Record<string,unknown>;
        db.prepare('UPDATE workflow_runs SET budget_json=? WHERE id=?').run(JSON.stringify({...budget,usedTurns:budget.runMaxTurns,callBudget:{version:1,mode:'DELIBERATE',enforcement:'enabled',counting:'always',limit:budget.runMaxTurns,limitSource:'default'}}),runId);
      }
      // Persist the exact legacy pre-dispatch shape observed in the user's run.
      db.prepare("UPDATE run_participants SET status='failed' WHERE run_id=? AND member_id='m2'").run(runId);
      db.prepare("UPDATE outbox SET status='failed' WHERE dispatch_key LIKE ?").run(`task:${taskId}:delib:${runId}:IND:m2:%`);
      appendDomainEvent(db,{schemaVersion:1,eventId:`r106-${taskId}`,projectId:'p1',conversationId:'c1',taskId,runId,kind:'run.stepFailed',createdAt:2000,payload:{stage:'IND',memberId:'m2',message:'有效执行配置已变化；未沿用旧会话'}});
      pumpDeliberation(db,taskId,{absenceToleranceMs:60_000,blobDir:join(root,'artifacts')});
      expect(db.prepare('SELECT status,stage FROM workflow_runs WHERE id=?').get(runId)).toMatchObject({status:'PARTIAL',stage:'INDEPENDENT'});
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toMatchObject({status:'BLOCKED'});
      expect(listRunArtifacts(db,runId,'analysis_draft')).toEqual(drafts);
      expect(db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key LIKE ? AND status IN ('pending','leased')").get(`task:${taskId}:delib:${runId}:%`)).toEqual({n:0});
      expect(db.prepare('SELECT count(*) n FROM agent_turns WHERE run_id=?').get(runId)).toEqual({n:1});
      expect(adapter.startTurnLog).toHaveLength(1);
      expect(db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(taskId)).toEqual({n:0});
      // A noisy successful peer cannot age the missing seat out of a 120-event page.
      for(let n=0;n<125;n++)appendDomainEvent(db,{schemaVersion:1,eventId:`noise-${taskId}-${n}`,projectId:'p1',conversationId:'c1',taskId,runId,kind:'tool.completed',createdAt:3000+n,payload:{toolName:'read'}});
      const detail=readTaskDetails(db,taskId);
      expect(detail.runs[0]?.participants.find(p=>p.memberId==='m2')).toMatchObject({status:'failed',notStarted:true,failure:{message:'有效执行配置已变化；未沿用旧会话'}});
      expect(detail.runs[0]?.eventsTruncated).toBe(true);
      expect(db.prepare("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='run.independentIncomplete'").get(taskId)).toEqual({n:1});
      pumpDeliberation(db,taskId,{absenceToleranceMs:60_000,blobDir:join(root,'artifacts')});
      expect(adapter.startTurnLog).toHaveLength(1);
    }finally{await adapter.closeAllSessions();db.close();}
  });
});
