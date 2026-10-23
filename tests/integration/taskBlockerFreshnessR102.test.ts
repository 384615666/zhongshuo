import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import type { TaskExecutionBlocker } from '../../src/contracts/executionBlockers.ts';

it('clears settled task blockers and rejects older pool/thread projections in both directions',async()=>{
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r102-blocker-freshness-')),project=join(dir,'project');mkdirSync(project);
  const db=openDatabase(join(dir,'state.sqlite'));
  const raw=(method:string,params:unknown)=>dispatchDaemonCommand({db,appDataDir:dir,localUserId:'u_local',interruptTurn:async()=>{}},
    {protocolVersion:1,commandId:randomUUID(),method,params}) as Promise<{ok:boolean;data:unknown}>;
  const cmd=async<T>(method:string,params:unknown)=>{const r=await raw(method,params);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data as T;};
  let release:(()=>void)|undefined;
  try{
    const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
    const room=(await cmd<{items:Array<{id:string;conversationId:string}>}>('room.list',{projectId})).items[0]!;
    const member=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'主持'})).memberId;
    await cmd('member.setRuntime',{memberId:member,kind:'fake',permissionMode:'bypassPermissions'});
    const sent=await cmd<{taskId:string;threadId:string}>('message.submit',{
      target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'交付采购方案',intent:'default',mentions:[{kind:'member',memberId:member}],
    });
    db.prepare("INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status) VALUES('blocker_run',?,?,?,'DIRECT','WAITING')").run(sent.taskId,room.conversationId,sent.threadId);
    const queued=()=>{
      db.prepare("UPDATE tasks SET status='ACTIVE' WHERE id=?").run(sent.taskId);
      db.prepare("UPDATE workflow_runs SET status='WAITING' WHERE id='blocker_run'").run();
      db.prepare("UPDATE outbox SET status='pending' WHERE dispatch_key=?").run(`task:${sent.taskId}:initial`);
    };
    const settled=()=>{
      db.prepare("UPDATE tasks SET status='DONE',revision=revision+1 WHERE id=?").run(sent.taskId);
      db.prepare("UPDATE workflow_runs SET status='SUCCEEDED' WHERE id='blocker_run'").run();
      db.prepare("UPDATE outbox SET status='done' WHERE dispatch_key=?").run(`task:${sent.taskId}:initial`);
    };
    const occupied={reason:'write-root-occupied',note:'待执行队列1项；同一写入目录的任务#2占用',pendingOutboxCount:1} as TaskExecutionBlocker;
    let projection:TaskExecutionBlocker|null=occupied,pauseMethod:string|null=null,captured=false;
    vi.stubGlobal('window',{zs:{command:async(env:{method:string;params:unknown})=>{
      const result=await raw(env.method,env.params);
      if(env.method==='task.get')Object.assign(result.data as object,{executionBlocker:projection});
      if(env.method==='room.pool')for(const card of (result.data as {items:Array<{taskId:string;executionBlocker:unknown}>}).items)if(card.taskId===sent.taskId)card.executionBlocker=projection;
      if(env.method===pauseMethod){pauseMethod=null;captured=true;await new Promise<void>(done=>{release=done;});}
      return result;
    }}});
    const entry=join(dir,'entry.ts'),bundle=join(dir,'bundle.mjs');
    writeFileSync(entry,`export * as loader from ${JSON.stringify(resolve('src/ui/hifi/loader.ts').replaceAll('\\','/'))};export * as store from ${JSON.stringify(resolve('src/ui/hifi/data/store.ts').replaceAll('\\','/'))};export * as hints from ${JSON.stringify(resolve('src/ui/hifi/lib/taskRunHint.ts').replaceAll('\\','/'))};`);
    await build({entryPoints:[entry],bundle:true,platform:'browser',format:'esm',outfile:bundle});
    type Snapshot={executionBlocker:TaskExecutionBlocker|null};
    const {loader,store,hints}=await import(pathToFileURL(bundle).href) as {
      loader:{openProjectByPath(path:string):Promise<void>;loadRoomPool(id:string):Promise<void>;loadThread(id:string):Promise<void>};
      store:{getState():{threadTasks:Record<string,Snapshot>;roomPool:Record<string,Array<Snapshot&{threadId:string}>>;tasks:Array<{id:string;status:string}>}};
      hints:{taskExecutionBlocker(thread:Snapshot|undefined,pool:Snapshot|undefined):TaskExecutionBlocker|null};
    };
    const blocker=()=>{const s=store.getState();return hints.taskExecutionBlocker(s.threadTasks[sent.threadId],s.roomPool[room.id]?.find(card=>card.threadId===sent.threadId));};
    const done=()=>{expect(blocker()).toBeNull();expect(store.getState().tasks.find(task=>task.id===sent.taskId)?.status).toBe('DONE');};
    queued();await loader.openProjectByPath(project);await loader.loadThread(sent.threadId);expect(blocker()?.reason).toBe('write-root-occupied');
    settled();projection=null;await loader.loadRoomPool(room.id);done(); // completed while the thread was away

    queued();projection=occupied;pauseMethod='room.pool';captured=false;
    const oldPool=loader.loadRoomPool(room.id);await vi.waitFor(()=>expect(captured).toBe(true));
    settled();projection=null;await loader.loadThread(sent.threadId);done();release!();await oldPool;done();

    queued();projection=occupied;pauseMethod='task.get';captured=false;
    const oldTask=loader.loadThread(sent.threadId);await vi.waitFor(()=>expect(captured).toBe(true));
    settled();projection=null;await loader.loadRoomPool(room.id);done();release!();await oldTask;done();

    queued();projection={...occupied,reason:'unknown-turn',note:'前序结果未知，不会自动执行'};
    await loader.loadRoomPool(room.id);expect(blocker()?.reason).toBe('unknown-turn'); // a newer real blocker must remain visible
  }finally{release?.();db.close();vi.unstubAllGlobals();vi.unstubAllEnvs();}
},30_000);
