import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {collisionFixture,finish,ObservedAdapter} from '../helpers/collisionHarnessR122.ts';

beforeEach(()=>{vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');});
afterEach(()=>vi.unstubAllEnvs());
const output=(extra:Record<string,unknown>={})=>JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',
  answer:'合成回复',responseKind:'work',changeSummary:'合成说明',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...extra});
const silent=()=>output({answer:'',changeSummary:'',responseKind:'conversation',replyDisposition:'none',document:null,handoffs:[]});
const toolWrite=(path:string):FakeTurnScript=>[
  {kind:'event',event:{kind:'tool.started',toolCallId:'own-write',toolName:'Write',argumentsSummary:'synthetic write',paths:[path]}},
  {kind:'writeFile',path,content:'own tool bytes'},
  {kind:'event',event:{kind:'tool.completed',toolCallId:'own-write',outcome:'success'}},
];
type Fixture=Awaited<ReturnType<typeof collisionFixture>>;
const fileNames=(f:Fixture,taskId:string)=>f.db.prepare("SELECT source_name FROM artifacts WHERE task_id=? AND source_name IN ('declared.md','tool.md','peer.txt','legacy.md') ORDER BY source_name").all(taskId) as Array<{source_name:string}>;

describe('R127 shared source repair and per-turn file attribution through formal worker',()=>{
  it.each([true,false])('repairs a shared source after worker restart, admitting only source declarations/tools (own evidence=%s)',async own=>{
    let repairing=false;
    const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>{
      if(text.includes('TOKEN_PEER'))return [{kind:'writeFile',path:'peer.txt',content:'peer bytes'},...finish(output({files:['peer.txt']}),260)];
      if(repairing)return finish(output({files:['peer.txt']})); // A repair cannot invent source ownership.
      return [{kind:'stall',ms:80},...(own?[
        {kind:'writeFile' as const,path:'declared.md',content:'own declared bytes'},...toolWrite('tool.md'),
      ]:[]),...finish(output({files:own?['declared.md']:[],invalidExtra:'force format repair'}),60)];
    }});
    const f=await collisionFixture('r127-shared-repair-'+own,{members:1,writable:true,isolatedGit:true,adapter});
    try{
      const source=await f.send(0,0,[0],'TOKEN_SOURCE 原轮需要补交');
      const peer=await f.send(0,0,[0],'TOKEN_PEER 别串写入');
      await f.worker.drain();expect(adapter.active.size).toBe(2);
      await f.pumpUntil(()=>f.count("SELECT count(*) n FROM agent_turns WHERE status='FAILED'")===1&&f.taskStatus(peer.taskId)==='DONE');
      await f.worker.awaitInFlightTurns(2000);
      const sourceTurn=adapter.turns.find(t=>t.taskId===source.taskId)!;
      const sourceSet=f.db.prepare('SELECT id,manifest_json FROM change_sets WHERE task_id=?').get(source.taskId) as {id:string;manifest_json:string};
      expect(JSON.parse(sourceSet.manifest_json).concurrentWriteObservation).toBe(true);
      expect(f.count("SELECT count(*) n FROM change_set_files WHERE change_set_id=? AND path='peer.txt' AND role='after' AND state='present'",sourceSet.id)).toBe(1);
      // The durable source manifest must suffice; do not rely on the old worker's overlap cache.
      f.db.prepare('DELETE FROM daemon_state WHERE key=?').run(`write-overlap:${sourceTurn.turnId}`);
      repairing=true;
      await f.cmd('task.redispatch',{taskId:source.taskId,formatRepair:true,reason:'仅补交格式'});
      const restarted=new DispatchWorker({db:f.db,adapter,leaseOwner:randomUUID(),appDataDir:f.dir,detachedTurnConsumption:true,automaticRecovery:false});
      await restarted.drain();await restarted.awaitInFlightTurns(3000);
      expect(f.taskStatus(source.taskId)).toBe('DONE');
      const repair=adapter.turns.filter(t=>t.taskId===source.taskId).at(-1)!;
      expect(repair.turnId).not.toBe(sourceTurn.turnId);
      const prompt=adapter.startTurnLog.find(t=>t.turnId===repair.turnId)!.text;
      expect(prompt).not.toContain('"path":"peer.txt"');
      if(own){expect(prompt).toContain('"path":"declared.md"');expect(prompt).toContain('"path":"tool.md"');}
      const marker=f.db.prepare('SELECT value FROM daemon_state WHERE key=?').get(`write-overlap:${repair.turnId}`) as {value:string};
      expect(marker.value).toBe('true');
      expect(f.count("SELECT count(*) n FROM change_sets WHERE task_id=? AND json_extract(manifest_json,'$.concurrentWriteObservation')=1",source.taskId)).toBe(2);
      const repairFiles=f.db.prepare("SELECT path,change_set_id FROM message_file_changes WHERE turn_id=? AND artifact_id IS NOT NULL AND path IN ('declared.md','tool.md','peer.txt') ORDER BY path").all(repair.turnId) as Array<{path:string;change_set_id:string|null}>;
      expect(repairFiles.map(file=>file.path)).toEqual(own?['declared.md','tool.md']:[]);
      expect(repairFiles.every(file=>file.change_set_id===null)).toBe(true);
      expect(fileNames(f,source.taskId).some(file=>file.source_name==='peer.txt')).toBe(false);
      expect(fileNames(f,peer.taskId).map(file=>file.source_name)).toEqual(['peer.txt']);
      expect(readFileSync(join(f.projects[0]!.path,'peer.txt'),'utf8')).toBe('peer bytes');
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it('keeps the existing unshared repair behavior for an undeclared source file',async()=>{
    let repairing=false;
    const adapter=new ObservedAdapter({turnScriptSequencer:()=>repairing?finish(output()):[
      {kind:'writeFile',path:'legacy.md',content:'unshared original bytes'},...finish(output({invalidExtra:true})),
    ]});
    const f=await collisionFixture('r127-unshared-repair',{members:1,writable:true,isolatedGit:true,adapter});
    try{
      const source=await f.send(0,0,[0],'TOKEN_SOURCE 非共享补交');
      await f.worker.drain();await f.worker.awaitInFlightTurns(2000);
      expect(f.count("SELECT count(*) n FROM agent_turns WHERE status='FAILED'")).toBe(1);
      repairing=true;await f.cmd('task.redispatch',{taskId:source.taskId,formatRepair:true,reason:'保留旧补交规则'});
      await f.pumpUntil(()=>f.taskStatus(source.taskId)==='DONE');
      expect(fileNames(f,source.taskId).map(file=>file.source_name)).toContain('legacy.md');
      expect(f.count("SELECT count(*) n FROM change_sets WHERE json_extract(manifest_json,'$.concurrentWriteObservation')=1")).toBe(0);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it.each([false,true])('does not reject a shared silent conversation for peer changes, but keeps the real-write guard (own write=%s)',async own=>{
    const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>text.includes('TOKEN_PEER')
      ?[{kind:'writeFile',path:'peer.txt',content:'peer bytes'},...finish(output({files:['peer.txt']}),260)]
      :[{kind:'stall',ms:80},...(own?toolWrite('tool.md'):[]),...finish(silent(),60)]});
    const f=await collisionFixture('r127-shared-silent-'+own,{members:1,writable:true,isolatedGit:true,adapter});
    try{
      const chat=await f.send(0,0,[0],'TOKEN_SILENT 无待办的交流');
      const peer=await f.send(0,0,[0],'TOKEN_PEER 别串文件');
      await f.worker.drain();expect(adapter.active.size).toBe(2);
      await f.pumpUntil(()=>f.taskStatus(peer.taskId)==='DONE'&&f.count("SELECT count(*) n FROM agent_turns WHERE status IN ('RUNNING','DISPATCHING')")===0);
      const turn=adapter.turns.find(t=>t.taskId===chat.taskId)!;
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(turn.turnId)).toEqual({status:own?'FAILED':'SUCCEEDED'});
      expect(f.count('SELECT count(*) n FROM task_deliveries WHERE task_id=?',chat.taskId)).toBe(0);
      expect(fileNames(f,chat.taskId).some(file=>file.source_name==='peer.txt')).toBe(false);
      if(own){
        const invalid=f.db.prepare("SELECT payload_json FROM domain_events WHERE turn_id=? AND kind='turn.outputInvalid'").get(turn.turnId) as {payload_json:string};
        expect(invalid.payload_json).toMatch(/工具执行|本轮已有实际文件变化/);
      }else expect(f.taskStatus(chat.taskId)).toBe('DONE');
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);

  it('accepts a real AUTO coordination plan while another writable thread changes the directory',async()=>{
    let plan:unknown,planned=false;
    const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>{
      if(text.includes('TOKEN_PEER'))return [{kind:'writeFile',path:'peer.txt',content:'peer bytes'},...finish(output({files:['peer.txt']}),300)];
      if(!planned&&text.includes('TOKEN_PLAN')){planned=true;return finish(output({coordinationPlan:plan}),120);}
      return finish(output({answer:'协作步骤完成'}),40);
    }});
    const f=await collisionFixture('r127-shared-plan',{members:2,writable:true,isolatedGit:true,adapter});
    try{
      const project=f.projects[0]!,room=project.rooms[0]!;
      const revision=(f.db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision:number}).revision;
      await f.cmd('room.update',{roomId:room.id,expectedRevision:revision,coordinatorMemberId:project.members[0]});
      plan={summary:'独立核对',steps:[{key:'review',memberId:project.members[1],title:'核对',objective:'核对本串请求',role:'review',dependsOn:[]}]};
      const root=await f.send(0,0,[],'TOKEN_PLAN 请协作分析后核对');
      const peer=await f.send(0,0,[1],'TOKEN_PEER 别串文件');
      await f.worker.drain();expect(adapter.active.size).toBe(2);
      await f.pumpUntil(()=>f.count('SELECT count(*) n FROM coordination_steps')===1);
      await f.pumpUntil(()=>f.taskStatus(root.taskId)==='DONE'&&f.taskStatus(peer.taskId)==='DONE');
      expect(f.count("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='turn.outputInvalid'",root.taskId)).toBe(0);
      expect(fileNames(f,root.taskId).some(file=>file.source_name==='peer.txt')).toBe(false);
      expect(fileNames(f,peer.taskId).map(file=>file.source_name)).toEqual(['peer.txt']);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    }finally{await f.close();}
  },10000);
});
