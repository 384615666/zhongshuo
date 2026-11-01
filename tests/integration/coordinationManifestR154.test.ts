import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {collisionFixture,finish,ObservedAdapter,pause} from '../helpers/collisionHarnessR122.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {assertCoordinationDispatch,pumpCoordinations,readCoordination} from '../../src/daemon/coordination.ts';

afterEach(()=>vi.unstubAllEnvs());
const complete=(answer:string,files:string[]=[],extra:Record<string,unknown>={},delay=10):FakeTurnScript=>finish(JSON.stringify({
  schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'work',answer,changeSummary:answer,files,
  executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...extra,
}),delay);

async function fixture(mode:'parallel'|'conflict'|'converged'|'rework'='parallel',fourProducers=false){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
  let plan:unknown;
  const scripts=new Map<string,FakeTurnScript>();
  const started:string[]=[];
  const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>{
    const turnId=/\bturn=([^\s]+)/.exec(text)?.[1];
    const step=f.db.prepare(`SELECT s.step_key FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
      JOIN coordination_steps s ON s.child_task_id=r.task_id WHERE a.id=?`).get(turnId) as {step_key:string}|undefined;
    if(step){started.push(step.step_key);return scripts.get(step.step_key)??complete('已核对实际文件');}
    const run=f.db.prepare('SELECT state FROM coordination_runs WHERE task_id=? AND state=\'planning\'').get(
      f.db.prepare('SELECT r.task_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE a.id=?').pluck().get(turnId),
    );
    return run?complete('先分工，再核验',[],{coordinationPlan:plan}):complete('完成真实成果汇总');
  }});
  const f=await collisionFixture('r154-'+mode,{members:fourProducers?5:3,writable:true,adapter,isolatedGit:true});
  const p=f.projects[0]!;
  if(mode==='converged'){
    const originalEvents=adapter.events.bind(adapter);
    adapter.events=session=>({async *[Symbol.asyncIterator](){
      for await(const event of originalEvents(session)){
        if((event.kind==='message.completed'||event.kind==='turn.completed')&&event.turnId
          &&f.db.prepare(`SELECT 1 FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
            JOIN coordination_steps s ON s.child_task_id=r.task_id WHERE a.id=?`).get(event.turnId)){
          const deadline=Date.now()+4000;
          while(adapter.writtenFiles.length<2&&Date.now()<deadline)await pause(5);
          expect(adapter.writtenFiles).toHaveLength(2);
        }
        yield event;
      }
    }});
  }
  if(mode!=='rework'){
    const revision=f.db.prepare('SELECT revision FROM projects WHERE id=?').pluck().get(p.id) as number;
    await f.cmd('project.writeConcurrency.set',{projectId:p.id,expectedRevision:revision,override:'parallel_writers'});
    const extras=fourProducers?['c','d']:[];
    plan={summary:'独立文件生成后统一核对',steps:[
      {key:'a',memberId:p.members[0],title:'甲生成',objective:'生成甲自己的文件',role:'implementation',dependsOn:[]},
      {key:'b',memberId:p.members[1],title:'乙生成',objective:'生成乙自己的文件',role:'implementation',dependsOn:[]},
      ...extras.map((key,i)=>({key,memberId:p.members[i+2],title:'生成'+key,objective:'生成独立文件'+key,role:'implementation',dependsOn:[]})),
      {key:'verify',memberId:p.members[fourProducers?4:2],title:'核对',objective:'核对实际文件',role:'review',dependsOn:['a','b',...extras]},
    ]};
    for(const key of extras)scripts.set(key,[{kind:'writeFile',path:key+'.md',content:key+' own bytes'},...complete(key+'完成',[join(p.path,key+'.md')])]);
    const same=mode==='conflict'||mode==='converged';
    const a=same?'same.md':'a.md',b=same?'same.md':'b.md';
    scripts.set('a',[{kind:'writeFile',path:a,content:'first version'},...complete('甲文件完成',[join(p.path,a)],{},100)]);
    scripts.set('b',[{kind:'writeFile',path:b,content:'second version'},...complete('乙文件完成',[join(p.path,b)])]);
    adapter.onStart=async(_session,input)=>{
      const step=f.db.prepare(`SELECT s.step_key FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id
        JOIN coordination_steps s ON s.child_task_id=r.task_id WHERE a.id=?`).get(input.turnId) as {step_key:string}|undefined;
      if(step?.step_key!=='b'||mode==='converged')return;
      writeFileSync(join(p.path,b),'peer work in progress');
      const aTask=f.db.prepare("SELECT child_task_id FROM coordination_steps WHERE step_key='a'").pluck().get() as string;
      const deadline=Date.now()+4000;
      while(f.taskStatus(aTask)!=='DONE'&&Date.now()<deadline)await pause(5);
      expect(f.taskStatus(aTask)).toBe('DONE');
    };
  }else{
    plan={summary:'生成、核对后分别落实修正',steps:[
      {key:'generate',memberId:p.members[0],title:'生成',objective:'创建两份文件',role:'implementation',dependsOn:[]},
      {key:'review',memberId:p.members[2],title:'核对',objective:'核对并提出两份修正',role:'review',dependsOn:['generate']},
      {key:'fix_a',memberId:p.members[0],title:'甲修正',objective:'修正甲文件',role:'implementation',dependsOn:['review']},
      {key:'fix_b',memberId:p.members[1],title:'乙修正',objective:'修正乙文件',role:'implementation',dependsOn:['review']},
    ]};
    scripts.set('generate',[{kind:'writeFile',path:'a.md',content:'A v1'},{kind:'writeFile',path:'b.md',content:'B v1'},...complete('文件已生成',['a.md','b.md'])]);
    scripts.set('fix_a',[{kind:'writeFile',path:'a.md',content:'A v2'},...complete('甲修正完成',['a.md'])]);
    scripts.set('fix_b',[{kind:'writeFile',path:'b.md',content:'B v2'},...complete('乙修正完成',['b.md'])]);
  }
  const root=await f.send(0,0,[0],'请按计划生成真实文件，并核对和落实必要修正');
  if(mode!=='rework'){
    await f.worker.runOnce();await f.worker.awaitInFlightTurns(3000); // planner
    // Both actual independent dispatches overlap; B cannot finish until A's
    // frozen observation and actual own-file snapshot have been persisted.
    await Promise.all(Array.from({length:fourProducers?4:2},()=>f.worker.runOnce()));
  }
  return {...f,root,started,scripts};
}

describe('R154 coordination manifests retain ownership and causal file versions',()=>{
  it('accepts a frozen version line followed by baseline notes but rejects a changed version binding',async()=>{
    const f=await fixture('rework');
    // Real content-store failure produces the worker's appended baseline note.
    // File hashes and explicit full permissions remain available.
    mkdirSync(join(f.dir,'preimages'),{recursive:true});
    writeFileSync(join(f.dir,'preimages',f.projects[0]!.id),'synthetic storage obstruction');
    let checked=false;
    f.adapter.onStart=async(_session,input,scope)=>{
      const step=f.db.prepare('SELECT step_key FROM coordination_steps WHERE child_task_id=?').pluck().get(scope.taskId);
      if(step!=='review')return;
      const row=f.db.prepare('SELECT included_refs_json FROM context_bundles WHERE turn_id=?').get(input.turnId) as {included_refs_json:string};
      const bundle=JSON.parse(row.included_refs_json) as {notes:string[]};
      const note=bundle.notes.findIndex(note=>note.includes('\nworkspaceVersions='));
      expect(note).toBeGreaterThanOrEqual(0);
      expect(bundle.notes[note]).toMatch(/workspaceVersions=.*\n项目内有/);
      const valid=row.included_refs_json;
      expect(()=>assertCoordinationDispatch(f.db,scope.taskId,input.dispatchKey,input.turnId)).not.toThrow();
      bundle.notes[note]=bundle.notes[note]!.replace(/workspaceVersions=.*\n/,'workspaceVersions=[]\n');
      f.db.prepare('UPDATE context_bundles SET included_refs_json=? WHERE turn_id=?').run(JSON.stringify(bundle),input.turnId);
      expect(()=>assertCoordinationDispatch(f.db,scope.taskId,input.dispatchKey,input.turnId)).toThrow('交接版本在启动等待期间已变化');
      f.db.prepare('UPDATE context_bundles SET included_refs_json=? WHERE turn_id=?').run(valid,input.turnId);
      checked=true;
    };
    try{
      await f.pumpUntil(()=>['DONE','BLOCKED'].includes(f.taskStatus(f.root.taskId)));
      expect(checked).toBe(true);expect(f.taskStatus(f.root.taskId)).toBe('DONE');
    }finally{await f.close();}
  });

  it('hands off only each parallel generator\'s verified files while retaining the complete directory audit',async()=>{
    const f=await fixture(undefined,true);
    try{
      await f.pumpUntil(()=>['DONE','BLOCKED'].includes(f.taskStatus(f.root.taskId)));
      expect(f.taskStatus(f.root.taskId)).toBe('DONE');
      const steps=f.db.prepare('SELECT step_key,handoff_json FROM coordination_steps ORDER BY rowid').all() as Array<{step_key:string;handoff_json:string}>;
      const output=(key:string)=>(JSON.parse(steps.find(s=>s.step_key===key)!.handoff_json) as {output:{files:Array<{path:string;sha256:string}>}}).output.files;
      expect(output('a').map(x=>x.path)).toEqual(['a.md']);expect(output('b').map(x=>x.path)).toEqual(['b.md']);
      const captured=f.db.prepare(`SELECT c.manifest_json,f.path FROM change_sets c JOIN tasks t ON t.id=c.task_id
        JOIN coordination_steps s ON s.child_task_id=t.id JOIN change_set_files f ON f.change_set_id=c.id
        WHERE s.step_key='a' AND f.role='after' AND f.path='b.md'`).get() as {manifest_json:string;path:string};
      expect(JSON.parse(captured.manifest_json).concurrentWriteObservation).toBe(true);expect(captured.path).toBe('b.md');
      expect(f.started).toContain('verify');expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  });

  it('still blocks genuine independent overwrites of the same file',async()=>{
    const f=await fixture('conflict');
    try{
      await f.pumpUntil(()=>['DONE','BLOCKED'].includes(f.taskStatus(f.root.taskId)));
      expect(f.taskStatus(f.root.taskId)).toBe('BLOCKED');expect(f.started).not.toContain('verify');
      expect(f.count('SELECT count(*) n FROM task_deliveries WHERE task_id=?',f.root.taskId)).toBe(0);
    }finally{await f.close();}
  });

  it('rejects independent overlapping writers even when both final directory observations have the same hash',async()=>{
    const f=await fixture('converged');
    try{
      await f.pumpUntil(()=>['DONE','BLOCKED'].includes(f.taskStatus(f.root.taskId)));
      expect(f.started.filter(step=>step==='a'||step==='b')).toHaveLength(2);
      expect(f.adapter.peakWritableRoot).toBeGreaterThanOrEqual(2);
      expect(['first version','second version']).toContain(readFileSync(join(f.projects[0]!.path,'same.md'),'utf8'));
      const observed=f.db.prepare(`SELECT cf.sha256 FROM change_set_files cf JOIN change_sets c ON c.id=cf.change_set_id
        JOIN coordination_steps s ON s.child_task_id=c.task_id
        WHERE s.step_key IN ('a','b') AND cf.path='same.md' AND cf.role='after'`).all() as {sha256:string}[];
      expect(observed).toHaveLength(2);expect(new Set(observed.map(file=>file.sha256)).size).toBe(1);
      expect(f.taskStatus(f.root.taskId)).toBe('BLOCKED');expect(f.started).not.toContain('verify');
      expect(f.count('SELECT count(*) n FROM task_deliveries WHERE task_id=?',f.root.taskId)).toBe(0);
    }finally{await f.close();}
  });

  it('keeps an old completed record readable when its frozen manifests fail the strengthened conflict checks',async()=>{
    const f=await fixture('converged');
    try{
      await f.pumpUntil(()=>['DONE','BLOCKED'].includes(f.taskStatus(f.root.taskId)));
      const run=f.db.prepare('SELECT run_id FROM coordination_runs WHERE task_id=?').pluck().get(f.root.taskId) as string;
      // Compatibility fixture: older builds accepted the equal after-images.
      for(const step of f.db.prepare(`SELECT s.child_task_id,s.step_key,s.handoff_json,d.id,d.revision,d.manifest_hash
        FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id JOIN task_deliveries d ON d.id=t.current_delivery_id
        WHERE s.run_id=? AND s.step_key IN ('a','b')`).all(run) as {child_task_id:string;step_key:string;handoff_json:string;id:string;revision:number;manifest_hash:string}[]){
        const handoff=JSON.parse(step.handoff_json) as {output?:unknown};
        if(handoff.output)continue;
        const files=f.db.prepare(`SELECT cf.path,cf.state,cf.sha256 FROM change_set_files cf JOIN change_sets c ON c.id=cf.change_set_id
          WHERE c.task_id=? AND cf.role='after' AND cf.path='same.md'`).all(step.child_task_id);
        handoff.output={id:step.id,revision:step.revision,manifest_hash:step.manifest_hash,files};
        f.db.prepare('UPDATE coordination_steps SET handoff_json=? WHERE run_id=? AND step_key=?').run(JSON.stringify(handoff),run,step.step_key);
      }
      f.db.prepare("UPDATE coordination_runs SET state='completed',error_message=NULL WHERE run_id=?").run(run);
      const before=f.db.prepare('SELECT total_changes() n').get();
      const detail=readCoordination(f.db,f.root.taskId,run);
      expect(detail?.state).toBe('completed');expect(detail?.errorMessage).toContain('没有显式依赖交接');
      expect(detail?.steps.every(step=>step.reviewVersionCurrent===null)).toBe(true);
      expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before);
    }finally{await f.close();}
  });

  it('allows a later sibling repair after an already completed causal repair, with actual current versions in its input',async()=>{
    const f=await fixture('rework');
    try{
      await f.pumpUntil(()=>['DONE','BLOCKED'].includes(f.taskStatus(f.root.taskId)));
      expect(f.taskStatus(f.root.taskId)).toBe('DONE');expect(f.started).toEqual(['generate','review','fix_b','fix_a']);
      expect(readFileSync(join(f.projects[0]!.path,'a.md'),'utf8')).toBe('A v2');
      expect(readFileSync(join(f.projects[0]!.path,'b.md'),'utf8')).toBe('B v2');
      const last=f.adapter.turns.find(t=>t.taskId===f.db.prepare("SELECT child_task_id FROM coordination_steps WHERE step_key='fix_a'").pluck().get())!;
      expect(last.text).toContain('workspaceVersions');expect(last.text).toContain('fix_b');
    }finally{await f.close();}
  });

  it('still rejects an external mutation after completed generators',async()=>{
    const f=await fixture();
    try{
      await f.worker.awaitInFlightTurns(3000);
      expect(new Set(f.started)).toEqual(new Set(['a','b']));
      writeFileSync(join(f.projects[0]!.path,'b.md'),'external unowned bytes');
      await f.pumpUntil(()=>['DONE','BLOCKED'].includes(f.taskStatus(f.root.taskId)));
      expect(f.taskStatus(f.root.taskId)).toBe('BLOCKED');expect(f.started).not.toContain('verify');
    }finally{await f.close();}
  });

  it('explicitly retries a historical blocked validator through corrected cached handoffs without editing original snapshots or rerunning producers',async()=>{
    const f=await fixture(undefined,true);
    try{
      await f.worker.awaitInFlightTurns(3000);pumpCoordinations(f.db);
      const a=f.db.prepare("SELECT child_task_id,handoff_json,run_id FROM coordination_steps WHERE step_key='a'").get() as {child_task_id:string;handoff_json:string;run_id:string};
      const bad=JSON.parse(a.handoff_json) as {output:{files:Array<{path:string;state:string;sha256:string}>}};
      const observed=f.db.prepare(`SELECT cf.sha256 FROM change_sets c JOIN change_set_files cf ON cf.change_set_id=c.id
        WHERE c.task_id=? AND cf.role='after' AND cf.path='b.md'`).get(a.child_task_id) as {sha256:string};
      bad.output.files.push({path:'b.md',state:'present',sha256:observed.sha256});
      const original=JSON.stringify(bad);
      f.db.prepare("UPDATE coordination_steps SET handoff_json=? WHERE step_key='a'").run(original);
      const verify=f.db.prepare("SELECT child_task_id FROM coordination_steps WHERE step_key='verify'").pluck().get() as string;
      // Persisted old-build startup failure: no model ever started this validator.
      f.db.prepare("UPDATE outbox SET status='failed' WHERE dispatch_key=?").run(`task:${verify}:initial`);
      f.db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id IN (?,?)").run(verify,f.root.taskId);
      f.db.prepare("UPDATE coordination_runs SET state='blocked',error_message='旧并行观察误归属' WHERE run_id=?").run(a.run_id);
      f.db.prepare("UPDATE workflow_runs SET status='FAILED' WHERE id=?").run(a.run_id);
      const before=f.db.prepare('SELECT id,manifest_json,after_ref FROM change_sets ORDER BY id').all();
      await f.cmd('task.redispatch',{taskId:verify,reason:'用户显式继续原校验步骤'});
      await f.pumpUntil(()=>['DONE','BLOCKED'].includes(f.taskStatus(f.root.taskId)));
      expect(f.taskStatus(f.root.taskId)).toBe('DONE');
      for(const key of ['a','b','c','d'])expect(f.started.filter(step=>step===key)).toHaveLength(1);
      expect(f.started.filter(key=>key==='verify')).toHaveLength(1);
      expect(f.db.prepare("SELECT handoff_json FROM coordination_steps WHERE step_key='a'").pluck().get()).toBe(original);
      for(const row of before as Array<{id:string;manifest_json:string;after_ref:string}>)expect(f.db.prepare('SELECT id,manifest_json,after_ref FROM change_sets WHERE id=?').get(row.id)).toEqual(row);
    }finally{await f.close();}
  });
});
