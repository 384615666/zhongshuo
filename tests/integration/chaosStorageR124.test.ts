import {afterEach,expect,it,vi} from 'vitest';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {collisionFixture,finish,ObservedAdapter,pause} from '../helpers/collisionHarnessR122.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {openDatabase} from '../../src/persistence/db.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';

afterEach(()=>vi.unstubAllEnvs());
function simulation(){vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');}
const evidence=resolve('dist/r124-chaos/storage');
function save(name:string,facts:Record<string,unknown>){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,name+'.json'),JSON.stringify(facts,null,2));}
const noteResult=JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',answer:'已提交共同笔记',responseKind:'conversation',changeSummary:'',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],memoryUpdates:[{key:'schedule',text:'周六下午'}]});

it('a failed memory merge does not starve unrelated projects and retries without repeating successful work',async()=>{
  simulation();const adapter=new ObservedAdapter({turnScriptSequencer:({text})=>finish(text.includes('TOKEN_NOTE')?noteResult:'独立工作完成',10)});
  const f=await collisionFixture('r124-memory-outage-global',{projects:2,adapter});
  try{
    f.db.exec("CREATE TEMP TRIGGER r124_memory_fault BEFORE INSERT ON role_memory_scopes BEGIN SELECT RAISE(FAIL,'R124 memory-only storage outage'); END;");
    const note=await f.send(0,0,[0],'TOKEN_NOTE 保存共同笔记');
    await f.worker.runOnce();await f.worker.awaitInFlightTurns(3000);
    expect(f.taskStatus(note.taskId)).toBe('DONE');
    const independent=await Promise.all(Array.from({length:8},(_,i)=>f.send(1,i%3,[i%3],`TOKEN_UNRELATED_${i} 独立项目工作`)));
    const failures:string[]=[];
    for(let i=0;i<6;i++){try{await f.worker.runOnce();}catch(error){failures.push(String(error));}}
    await f.pumpUntil(()=>independent.every(r=>f.taskStatus(r.taskId)==='DONE'));
    const during={failedQueueTicks:failures.length,independentStarts:adapter.turns.filter(t=>independent.some(r=>r.taskId===t.taskId)).length,pending:f.count("SELECT count(*) n FROM daemon_state WHERE key LIKE 'role-memory-pending:%'")};
    expect(during).toEqual({failedQueueTicks:0,independentStarts:8,pending:1});
    expect(f.count('SELECT count(*) n FROM role_memory_commits')).toBe(0);
    expect(f.count("SELECT count(*) n FROM domain_events WHERE kind='roleMemory.deferred'")).toBeGreaterThan(0);
    f.db.exec('DROP TRIGGER r124_memory_fault');
    await f.pumpUntil(()=>f.count("SELECT count(*) n FROM daemon_state WHERE key LIKE 'role-memory-pending:%'")===0);
    expect(f.count('SELECT count(*) n FROM role_memory_commits')).toBe(1);
    expect(adapter.turns).toHaveLength(9);
    save('memory-outage-global',{fixture:f.dir,classification:'guarded',...during,afterRecoveryDone:8,realCalls:f.count('SELECT count(*) n FROM real_calls')});
  }finally{await f.close();}
});

it('a pending room note with a persistent storage fault allows restart and new work before the note store recovers',async()=>{
  simulation();const adapter=new ObservedAdapter({turnScriptSequencer:()=>finish(noteResult,10)});
  const f=await collisionFixture('r124-memory-outage-restart',{adapter});let closed=false;
  try{
    f.db.exec("CREATE TRIGGER r124_memory_persistent_fault BEFORE INSERT ON role_memory_scopes BEGIN SELECT RAISE(FAIL,'R124 persistent note storage fault'); END;");
    const root=await f.send(0,0,[0],'TOKEN_NOTE 保存后重启');
    await f.worker.runOnce();await f.worker.awaitInFlightTurns(3000);
    expect(f.taskStatus(root.taskId)).toBe('DONE');
    const independent=await f.send(0,1,[1],'TOKEN_NEW_WORK 新任务不依赖共同笔记');
    await adapter.closeAllSessions();f.db.close();closed=true;
    const reopened=openDatabase(join(f.dir,'state.sqlite')),next=new FakeRuntimeAdapter();
    try{
      const restarted=new DispatchWorker({db:reopened,adapter:next,leaseOwner:randomUUID(),appDataDir:f.dir,detachedTurnConsumption:true});
      const pending=(reopened.prepare("SELECT count(*) n FROM daemon_state WHERE key LIKE 'role-memory-pending:%'").get() as {n:number}).n;
      expect(pending).toBe(1);
      await restarted.drain();await restarted.awaitInFlightTurns(3000);
      expect(reopened.prepare('SELECT status FROM tasks WHERE id=?').get(independent.taskId)).toEqual({status:'DONE'});
      reopened.exec('DROP TRIGGER r124_memory_persistent_fault');
      new DispatchWorker({db:reopened,adapter:next,leaseOwner:randomUUID(),appDataDir:f.dir});
      expect((reopened.prepare('SELECT count(*) n FROM role_memory_commits').get() as {n:number}).n).toBe(1);
      expect(next.startTurnLog).toHaveLength(1);
      expect((reopened.prepare('SELECT count(*) n FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(root.taskId) as {n:number}).n).toBe(1);
      save('memory-outage-restart',{fixture:f.dir,classification:'guarded',startupError:null,pending,independentWorkDone:true,recoversAfterFaultRemoval:true,realCalls:0});
    }finally{await next.closeAllSessions();reopened.close();}
  }finally{if(!closed)await f.close();}
});

it('a queued project folder moved away rejects its twelve writes while another project completes without leaked write leases',async()=>{
  simulation();const f=await collisionFixture('r124-moved-root',{projects:2,writable:true});
  try{
    const missing=await Promise.all(Array.from({length:12},(_,i)=>f.send(0,i%3,[i%3],`TOKEN_MISSING_${i} 修改文件`)));
    const independent=await Promise.all(Array.from({length:6},(_,i)=>f.send(1,i%3,[i%3],`TOKEN_KEEP_${i} 继续工作`)));
    renameSync(f.projects[0]!.path,f.projects[0]!.path+'-moved');
    await f.pumpUntil(()=>missing.every(r=>f.taskStatus(r.taskId)==='BLOCKED')&&independent.every(r=>f.taskStatus(r.taskId)==='DONE'));
    expect(f.adapter.turns).toHaveLength(6);
    expect(f.adapter.turns.every(t=>independent.some(r=>r.taskId===t.taskId))).toBe(true);
    expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
    expect(f.count("SELECT count(*) n FROM agent_turns WHERE status='UNKNOWN'")).toBe(0);
    expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    save('moved-root',{fixture:f.dir,classification:'guarded',blockedWithoutModel:12,unrelatedDone:6,remainingWriteLeases:0,realCalls:0});
  }finally{await f.close();}
},20000);

it.skipIf(process.platform!=='win32')('a real exclusive Windows file remains unknown rather than absent or unchanged while unrelated work completes and a later request can read it',async()=>{
  simulation();const f=await collisionFixture('r124-exclusive-file',{projects:2,writable:true,isolatedGit:true});
  const file=join(f.projects[0]!.path,'locked-document.txt'),ready=join(f.dir,'lock-ready'),release=join(f.dir,'lock-release');
  writeFileSync(file,'原内容');
  const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
  const script=`$ErrorActionPreference='Stop'; $handle=[IO.File]::Open(${quote(file)},[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); try { [IO.File]::WriteAllText(${quote(ready)},'ready'); while (-not [IO.File]::Exists(${quote(release)})) { Start-Sleep -Milliseconds 20 } } finally { $handle.Dispose() }`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});
  const exited=once(child,'exit');
  try{
    const deadline=Date.now()+5000;
    while(!existsSync(ready)&&Date.now()<deadline&&child.exitCode==null)await pause(20);
    expect(existsSync(ready),'fixture must hold a genuine exclusive OS file handle').toBe(true);
    expect(()=>readFileSync(file),'the file really must be unreadable before testing').toThrow();
    const blocked=await f.send(0,0,[0],'TOKEN_LOCKED 修改被其他程序占用的文件');
    const others=await Promise.all(Array.from({length:4},(_,i)=>f.send(1,i%3,[i%3],`TOKEN_UNLOCKED_${i} 继续工作`)));
    await f.pumpUntil(()=>f.taskStatus(blocked.taskId)==='DONE'&&others.every(r=>f.taskStatus(r.taskId)==='DONE'));
    expect(f.adapter.turns).toHaveLength(5);
    const snapshots=f.db.prepare(`SELECT role,state,error FROM change_set_files f JOIN change_sets c ON c.id=f.change_set_id WHERE c.task_id=? AND f.path='locked-document.txt' ORDER BY f.role`).all(blocked.taskId) as Array<{role:string;state:string;error:string}>;
    expect(snapshots).toHaveLength(2);expect(snapshots.every(s=>s.state==='unknown'&&s.error.length>0)).toBe(true);
    expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
    writeFileSync(release,'release');await exited;
    const next=await f.send(0,0,[0],'TOKEN_RETRY 关闭占用程序后再发送');
    await f.pumpUntil(()=>f.taskStatus(next.taskId)==='DONE');
    expect(f.adapter.turns.filter(t=>t.taskId===next.taskId)).toHaveLength(1);
    expect(readFileSync(file,'utf8')).toBe('原内容');
    expect(f.count("SELECT count(*) n FROM change_set_files f JOIN change_sets c ON c.id=f.change_set_id WHERE c.task_id=? AND f.path='locked-document.txt' AND f.state='present'",next.taskId)).toBe(2);
    save('exclusive-file',{fixture:f.dir,classification:'guarded-with-limitation',realExclusiveHandle:true,executionAllowedWithUnknownPreimage:true,snapshots,unrelatedDone:4,retryExecutions:1,realCalls:f.count('SELECT count(*) n FROM real_calls')});
  }finally{
    writeFileSync(release,'release');
    if(child.exitCode==null){child.kill();await exited;}
    await f.close();
  }
},20000);
