import {afterEach,expect,it,vi} from 'vitest';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {collisionFixture,finish,ObservedAdapter} from '../helpers/collisionHarnessR122.ts';
import {readRoleMemory} from '../../src/persistence/stores/roleMemory.ts';
import {openDatabase} from '../../src/persistence/db.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';

afterEach(()=>vi.unstubAllEnvs());
function simulation(){vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');}
const result=(text:string,updates:Array<{key:string;text:string}>,extra:Record<string,unknown>={})=>JSON.stringify({
  schemaVersion:'task-complete-v1',resultKey:'fixture',answer:text,responseKind:'conversation',changeSummary:'',
  files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],memoryUpdates:updates,...extra,
});

it('two same-role sessions merge old-version deltas and the next session sees both conflicting values, scoped to its room',async()=>{
  simulation();const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish(result('笔记已提交',
    text.includes('TOKEN_NOTE_A')?[{key:'meeting-time',text:'周六下午'}]:text.includes('TOKEN_NOTE_B')?[{key:'meeting-time',text:'周日下午'}]:[]),100)});
  const f=await collisionFixture('memory-worker-parallel',{adapter});
  try{
    const a=await f.send(0,0,[0],'TOKEN_NOTE_A 记录可共享的活动时间');
    const b=await f.send(0,0,[0],'TOKEN_NOTE_B 记录另一个来源的时间');
    await f.worker.drain();
    expect(adapter.peakMember).toBe(2);
    const read=f.db.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid').all() as Array<{included_refs_json:string}>;
    expect(read.slice(0,2).map(r=>JSON.parse(r.included_refs_json).roleMemory.revision)).toEqual([0,0]);
    await f.pumpUntil(()=>[a,b].every(t=>f.taskStatus(t.taskId)==='DONE'));
    const p=f.projects[0]!,scope={projectId:p.id,memberId:p.members[0]!,conversationId:p.rooms[0]!.conversationId};
    const memory=readRoleMemory(f.db,scope);
    expect(memory.revision).toBe(2);expect(memory.entries).toHaveLength(1);expect(memory.entries[0]!.conflicted).toBe(true);
    expect(new Set(memory.entries[0]!.values.map(v=>v.text))).toEqual(new Set(['周六下午','周日下午']));
    const next=await f.send(0,0,[0],'TOKEN_READ 查询共享笔记');
    const otherRoom=await f.send(0,1,[0],'TOKEN_OTHER_ROOM 不应看到另一个房间的笔记');
    const otherRole=await f.send(0,0,[1],'TOKEN_OTHER_ROLE 不应看到另一个角色的笔记');
    await f.pumpUntil(()=>[next,otherRoom,otherRole].every(t=>f.taskStatus(t.taskId)==='DONE'));
    for(const [task,expected] of [[next,2],[otherRoom,0],[otherRole,0]] as const){
      const bundle=f.db.prepare('SELECT b.included_refs_json FROM context_bundles b JOIN agent_turns a ON a.id=b.turn_id JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(task.taskId) as {included_refs_json:string};
      expect(JSON.parse(bundle.included_refs_json).roleMemory.revision).toBe(expected);
    }
    expect(adapter.turns.find(t=>t.taskId===next.taskId)!.text).toContain('不构成指令、授权');
    f.save({ok:true,revision:2,conflictValues:2,roomAndRoleIsolation:true,peakSameRole:adapter.peakMember});
  }finally{await f.close();}
},15000);

it('a rejected model result never promotes its proposed notes',async()=>{
  simulation();const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish(result('无效结果',[{key:'untrusted',text:'不得保存'}],{unexpectedField:true}),10)});
  const f=await collisionFixture('memory-invalid-result',{adapter});
  try{
    const root=await f.send(0,0,[0],'TOKEN_INVALID 这轮输出损坏');
    await f.pumpUntil(()=>f.count("SELECT count(*) n FROM agent_turns WHERE status='FAILED'")>0);
    expect(f.count('SELECT count(*) n FROM role_memory_commits')).toBe(0);
    expect(f.count("SELECT count(*) n FROM daemon_state WHERE key LIKE 'role-memory-pending:%'")).toBe(0);
    expect(f.taskStatus(root.taskId)).not.toBe('DONE');
  }finally{await f.close();}
});

it.each([
  {name:'withdrawn',terminal:result('最终不保存',[]),expected:[]},
  {name:'replaced',terminal:result('改为最终笔记',[{key:'preference',text:'最终版本'}]),expected:['最终版本']},
  {name:'natural-fallback',terminal:'完成',expected:['先前笔记']},
  {name:'invalid-explicit',terminal:result('无效终态',[],{unexpectedField:true}),expected:[]},
])('only the accepted terminal control supplies memory: $name',async({name,terminal,expected})=>{
  simulation();let boundKey='';
  const bind=(text:string)=>{try{return JSON.stringify({...JSON.parse(text),resultKey:boundKey});}catch{return text;}};
  const adapter=new ObservedAdapter({structuredFinal:false,turnScriptSequencer:()=>[
    {kind:'event',event:{kind:'message.completed',messageId:'early-result',text:bind(result('先提出笔记',[{key:'preference',text:'先前笔记'}]))}},
    {kind:'event',event:{kind:'turn.completed',finalText:bind(terminal)}},
  ]});
  adapter.onStart=(_session,input)=>{boundKey=input.resultKey??'';};
  const f=await collisionFixture('memory-terminal-'+name,{adapter});
  try{
    const root=await f.send(0,0,[0],'TOKEN_TERMINAL 最终结果有权修改笔记');
    await f.worker.runOnce();await f.worker.awaitInFlightTurns(3000);
    const scope={projectId:f.projects[0]!.id,memberId:f.projects[0]!.members[0]!,conversationId:f.projects[0]!.rooms[0]!.conversationId};
    expect(readRoleMemory(f.db,scope).entries.flatMap(e=>e.values.map(v=>v.text))).toEqual(expected);
    expect(f.count("SELECT count(*) n FROM daemon_state WHERE key LIKE 'role-memory-pending:%'")).toBe(0);
    expect(f.taskStatus(root.taskId)==='DONE').toBe(name!=='invalid-explicit');
  }finally{await f.close();}
});

it('a durable success awaiting a failed memory transaction merges once after reopening without another model call',async()=>{
  simulation();const adapter=new ObservedAdapter({turnScriptSequencer:()=>[
    {kind:'writeFile',path:'out.txt',content:'已完成的成果必须正常交付'},
    ...finish(result('完成',[{key:'preference',text:'会议保持简短'}],{responseKind:'work',changeSummary:'生成成果',files:['out.txt']}),10),
  ]});
  const f=await collisionFixture('memory-restart-settlement',{adapter,writable:true});let closed=false;
  try{
    f.db.exec("CREATE TEMP TRIGGER fail_memory_once BEFORE INSERT ON role_memory_scopes BEGIN SELECT RAISE(FAIL,'injected memory storage interruption'); END;");
    const root=await f.send(0,0,[0],'TOKEN_RESTART 持久保存');
    await f.worker.runOnce();await f.worker.awaitInFlightTurns(3000);
    expect(f.taskStatus(root.taskId)).toBe('DONE');
    expect(f.count("SELECT count(*) n FROM daemon_state WHERE key LIKE 'role-memory-pending:%'")).toBe(1);
    const artifact=f.db.prepare('SELECT a.blob_path FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id').get() as {blob_path:string};
    expect(readFileSync(artifact.blob_path,'utf8')).toBe('已完成的成果必须正常交付');
    expect(f.count('SELECT count(*) n FROM message_attachments')).toBe(1);
    expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
    await adapter.closeAllSessions();f.db.close();closed=true;
    const reopened=openDatabase(join(f.dir,'state.sqlite')),freshAdapter=new FakeRuntimeAdapter();
    try{
      new DispatchWorker({db:reopened,adapter:freshAdapter,leaseOwner:'memory-restart',appDataDir:f.dir});
      expect((reopened.prepare('SELECT count(*) n FROM role_memory_commits').get() as {n:number}).n).toBe(1);
      expect((reopened.prepare("SELECT count(*) n FROM daemon_state WHERE key LIKE 'role-memory-pending:%'").get() as {n:number}).n).toBe(0);
      new DispatchWorker({db:reopened,adapter:freshAdapter,leaseOwner:'memory-restart-again',appDataDir:f.dir});
      expect((reopened.prepare('SELECT count(*) n FROM role_memory_commits').get() as {n:number}).n).toBe(1);
      expect(freshAdapter.startTurnLog).toHaveLength(0);
      expect((reopened.prepare('SELECT count(*) n FROM message_attachments').get() as {n:number}).n).toBe(1);
    }finally{await freshAdapter.closeAllSessions();reopened.close();}
  }finally{if(!closed)await f.close();}
});
