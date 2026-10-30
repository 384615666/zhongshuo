import {afterAll,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../../src/persistence/db.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {pumpDeliberation} from '../../src/daemon/deliberationRunner.ts';
import {listRunArtifacts} from '../../src/persistence/stores/deliberation.ts';
import {seed,createDelibTask,done,draft,runIdOf,step} from './deliberationFlow.test.ts';

const root=mkdtempSync(join(tmpdir(),'zs-r127-discussion-'));
afterAll(()=>rmSync(root,{recursive:true,force:true}));

describe('R127 discussion launch failures',()=>{
  it.each(['CR','ISS'] as const)('preserves the valid peer reply and stops after %s fails before inference',async stage=>{
    const db=openDatabase(':memory:');seed(db,['m1','m2']);
    const taskId=createDelibTask(db,127,['m1','m2']);
    const scripts:FakeTurnScript[]=[];
    const adapter=new FakeRuntimeAdapter({structuredFinal:false,turnScriptSequencer:()=>scripts.shift()!});
    const worker=new DispatchWorker({db,adapter,leaseOwner:'r127',enableDeliberate:true,appDataDir:root});
    try{
      await step(worker,scripts);
      for(const id of ['m1','m2'])await step(worker,scripts,done(draft(`${id}独立分析`,[{claimId:'c1',statement:`${id}观点`}],null)));
      const runId=runIdOf(db);
      const drafts=listRunArtifacts(db,runId,'analysis_draft');
      const review=(peer:string)=>done({schemaVersion:'cross-review-v1',summary:'需要核实',document:null,reviews:[{
        targetArtifactId:drafts.find(d=>d.author_id===peer)!.id,targetRevision:1,targetClaimId:'c1',stance:'needs_evidence',reason:'请补证据',evidenceIds:[],
      }]});
      if(stage==='ISS'){
        await step(worker,scripts,review('m2'));
        await step(worker,scripts,review('m1'));
      }
      // The formal worker performs this frozen configuration check before it
      // creates a turn or calls the adapter; no fake failed message is injected.
      const roster=['m1','m2'].map(memberId=>({memberId,displayName:memberId,description:null,
        writeScope:JSON.stringify(memberId==='m2'?{launchFingerprintVersion:99}:{})}));
      db.prepare('INSERT INTO coordination_scopes(task_id,roster_json,created_at) VALUES(?,?,?)').run(taskId,JSON.stringify(roster),Date.now());
      const before=adapter.startTurnLog.length;
      if(stage==='CR')await step(worker,scripts,review('m2'));
      else{
        const issues=db.prepare('SELECT id FROM issues WHERE run_id=?').all(runId) as Array<{id:string}>;
        await step(worker,scripts,done({schemaVersion:'issue-position-v1',summary:'保留分歧',document:null,
          positions:issues.map(i=>({issueId:i.id,stance:'needs_evidence',reason:'需要证据',newEvidence:[]}))}));
      }
      await step(worker,scripts);
      expect(adapter.startTurnLog).toHaveLength(before+1);
      expect(db.prepare('SELECT status,stage FROM workflow_runs WHERE id=?').get(runId),JSON.stringify({participants:db.prepare('SELECT member_id,status FROM run_participants WHERE run_id=?').all(runId),queue:db.prepare('SELECT dispatch_key,status FROM outbox').all(),events:db.prepare("SELECT kind,payload_json FROM domain_events WHERE run_id=? AND kind='run.stepFailed'").all(runId)})).toEqual({status:'PARTIAL',stage:stage==='CR'?'CROSS_REVIEW':'ISSUE_DISCUSSION'});
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({status:'BLOCKED'});
      expect(listRunArtifacts(db,runId,'analysis_draft')).toEqual(drafts);
      expect(listRunArtifacts(db,runId,stage==='CR'?'cross_review':'issue_position')).toHaveLength(1);
      expect(db.prepare("SELECT count(*) n FROM domain_events WHERE run_id=? AND kind='run.discussionIncomplete' AND json_extract(payload_json,'$.failedBeforeDispatchMemberIds[0]')='m2'").get(runId)).toEqual({n:1});
      expect(db.prepare("SELECT count(*) n FROM outbox WHERE dispatch_key LIKE ? AND status IN ('pending','leased')").get(`task:${taskId}:delib:${runId}:%`)).toEqual({n:0});
      pumpDeliberation(db,taskId,{absenceToleranceMs:60_000,blobDir:join(root,'artifacts')});
      expect(adapter.startTurnLog).toHaveLength(before+1);
      expect(db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(taskId)).toEqual({n:0});
    }finally{await adapter.closeAllSessions();db.close();}
  });
});
