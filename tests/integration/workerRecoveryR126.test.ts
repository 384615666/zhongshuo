import {afterEach,expect,it,vi} from 'vitest';
import {collisionFixture,finish,ObservedAdapter} from '../helpers/collisionHarnessR122.ts';
import {readRoleMemory} from '../../src/persistence/stores/roleMemory.ts';

afterEach(()=>vi.unstubAllEnvs());
function simulation(){vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');}
const note=(text:string)=>JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',answer:text,responseKind:'conversation',changeSummary:'',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],memoryUpdates:[{key:'preference',text}]});

it.each(['process-exit','invalid-terminal'] as const)('an unconfirmed writer ($0) ends its consumer as UNKNOWN without freeing write protection or blocking another project',async mode=>{
  simulation();const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>text.includes('TOKEN_EXIT')
    ?[{kind:'event',event:mode==='process-exit'?{kind:'process.exited',exitCode:7,expected:false}:{kind:'turn.failed',code:'CODEX_INVALID_TERMINAL_STATUS',message:'执行连接没有返回明确的成功或失败终态',retryable:false}}]
    :finish('其他项目完成',20)});
  const f=await collisionFixture('r126-unconfirmed-writer-'+mode,{projects:2,writable:true,adapter,automaticRecovery:true});
  try{
    const lost=await f.send(0,0,[0],'TOKEN_EXIT 执行进程意外退出');await f.worker.runOnce();
    expect((await f.worker.awaitInFlightTurns(2000)).remaining).toEqual([]);
    const turn=f.db.prepare('SELECT a.id,a.status,r.status run_status FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(lost.taskId) as {id:string;status:string;run_status:string};
    expect(turn).toMatchObject({status:'UNKNOWN',run_status:'INTERRUPTED'});
    expect(f.admission.has(turn.id)).toBe(true);
    expect(f.count("SELECT count(*) n FROM workspace_leases WHERE owner_turn_id=? AND status!='released'",turn.id)).toBe(1);
    expect(f.count("SELECT count(*) n FROM outbox WHERE status='leased'")).toBe(0);
    const waiting=await f.send(0,1,[1],'TOKEN_SAME_ROOT 同目录等待核实');
    const other=await f.send(1,0,[0],'TOKEN_OTHER_PROJECT 独立项目继续');
    await f.pumpUntil(()=>f.taskStatus(other.taskId)==='DONE');
    expect(adapter.turns.some(t=>t.taskId===waiting.taskId)).toBe(false);
    expect(f.admission.has(turn.id)).toBe(true);
    expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    expect(adapter.turns.filter(t=>t.taskId===lost.taskId)).toHaveLength(1);
  }finally{await f.close();}
});

it('a room already archived in recovered storage blocks its old root dispatch before opening a model',async()=>{
  simulation();const f=await collisionFixture('r126-archived-root',{writable:true});
  try{
    const root=await f.send(0,0,[0],'TOKEN_ARCHIVED 排队根请求');
    // Simulate an old/recovered lifecycle fact; the public archive command is
    // separately checked to refuse OPEN work by the command regression.
    f.db.prepare('UPDATE rooms SET archived_at=? WHERE id=?').run(Date.now(),f.projects[0]!.rooms[0]!.id);
    const other=await f.send(0,1,[1],'TOKEN_OTHER_ROOM 其他房间继续');
    await f.pumpUntil(()=>f.taskStatus(root.taskId)==='BLOCKED'&&f.taskStatus(other.taskId)==='DONE');
    expect(f.adapter.turns.some(t=>t.taskId===root.taskId)).toBe(false);
    expect(f.count('SELECT count(*) n FROM workflow_runs WHERE task_id=?',root.taskId)).toBe(0);
    expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
  }finally{await f.close();}
});

it('a room archived while its session opens cannot start a writer and releases only its own preparation lease',async()=>{
  simulation();const adapter=new ObservedAdapter(),f=await collisionFixture('r126-archive-during-open',{writable:true,adapter});
  const open=adapter.openSession.bind(adapter);
  const spy=vi.spyOn(adapter,'openSession').mockImplementation(async input=>{
    const session=await open(input);
    f.db.prepare('UPDATE rooms SET archived_at=? WHERE id=?').run(Date.now(),f.projects[0]!.rooms[0]!.id);
    return session;
  });
  try{
    const root=await f.send(0,0,[0],'TOKEN_ARCHIVE_OPEN 连接窗口变化');
    await expect(f.worker.drain()).rejects.toThrow('房间已归档');
    expect(adapter.turns).toHaveLength(0);
    expect(f.count("SELECT count(*) n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? AND a.status='FAILED'",root.taskId)).toBe(1);
    expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
    expect(f.admission.snapshot().global).toBe(0);
    expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
  }finally{spy.mockRestore();await f.close();}
});

it('a failing note scope does not stop another member from committing its own note',async()=>{
  simulation();const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish(note(text.includes('TOKEN_BAD_NOTE')?'故障范围笔记':'正常范围笔记'),20)});
  const f=await collisionFixture('r126-note-scope-isolation',{adapter});
  try{
    const member=f.projects[0]!.members[0]!;
    f.db.exec(`CREATE TEMP TRIGGER r126_scope_fault BEFORE INSERT ON role_memory_scopes WHEN NEW.member_id='${member.replaceAll("'","''")}' BEGIN SELECT RAISE(FAIL,'one note scope unavailable'); END;`);
    const bad=await f.send(0,0,[0],'TOKEN_BAD_NOTE 保存失败范围');
    const good=await f.send(0,0,[1],'TOKEN_GOOD_NOTE 保存正常范围');
    await f.pumpUntil(()=>[bad,good].every(t=>f.taskStatus(t.taskId)==='DONE'));
    const base={projectId:f.projects[0]!.id,conversationId:f.projects[0]!.rooms[0]!.conversationId};
    expect(readRoleMemory(f.db,{...base,memberId:member}).entries).toEqual([]);
    expect(readRoleMemory(f.db,{...base,memberId:f.projects[0]!.members[1]!}).entries[0]!.values[0]!.text).toBe('正常范围笔记');
    expect(f.count("SELECT count(*) n FROM daemon_state WHERE key LIKE 'role-memory-pending:%'")).toBe(1);
    expect(adapter.turns).toHaveLength(2);
  }finally{await f.close();}
});
