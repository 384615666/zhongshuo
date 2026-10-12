import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

const root = mkdtempSync(join(tmpdir(),'zs-r78-projection-'));
afterAll(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(root,{recursive:true,force:true});});
describe('R78 cold pool and thread projections contain authoritative task facts',()=>{
  it('matches stored DIRECT/auto-deliver policy, never manufactures a full run/budget/delivery from hints, and picks latest created run',async()=>{
    vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_REAL_DISPATCH_GUARD',undefined);vi.stubEnv('ZS_REAL_BATCH_ID',undefined);
    const db=openDatabase(':memory:'); const app=join(root,'data');mkdirSync(app);
    const raw=(method:string,params:unknown)=>dispatchDaemonCommand({db,appDataDir:app,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:randomUUID(),method,params}) as Promise<{ok:boolean;data?:unknown;error?:unknown}>;
    const cmd=async(method:string,params:unknown)=>{const r=await raw(method,params);expect(r.ok,JSON.stringify(r.error)).toBe(true);return r.data as Record<string,unknown>;};
    const entry=join(root,'entry.ts'); const output=join(root,'bundle.mjs');
    writeFileSync(entry,`export * as loader from ${JSON.stringify(resolve('src/ui/hifi/loader.ts').replaceAll('\\','/'))}; export * as store from ${JSON.stringify(resolve('src/ui/hifi/data/store.ts').replaceAll('\\','/'))};`);
    await build({entryPoints:[entry],bundle:true,platform:'browser',format:'esm',outfile:output});
    vi.stubGlobal('window',{zs:{command:(env:{method:string;params:unknown})=>raw(env.method,env.params)}});
    const {loader,store}=await import(pathToFileURL(output).href) as {loader:{openProjectByPath(path:string):Promise<unknown>;refreshRooms():Promise<void>;loadRoomPool(id:string):Promise<void>;loadThread(id:string,options:{markRead:boolean}):Promise<void>};store:{getState():{activeProjectId:string;projects:Array<{id:string;revision:number}>;tasks:Array<{id:string;ownerMemberId?:string;revision:number}>;threadTasks:Record<string,{activeRun:{id:string;status:string}|null}>;runs:unknown[];taskDeliveries:unknown[]}}};
    const adapter=new FakeRuntimeAdapter({turnScriptSequencer:()=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:TASK_COMPLETE_SCHEMA_VERSION,resultKey:randomUUID(),changeSummary:'完成',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[]})}}]});
    try{
      const projectDir=join(root,'project');mkdirSync(projectDir);await loader.openProjectByPath(projectDir);
      const pid=store.getState().activeProjectId;
      await cmd('project.reviewPolicy.set',{projectId:pid,expectedRevision:store.getState().projects.find(p=>p.id===pid)!.revision,taskReviewEnabled:false});
      const made=await cmd('room.create',{projectId:pid,name:'任务事实'});const room=(made.room as {id:string;conversationId:string});
      await loader.refreshRooms();const member=(await cmd('member.list',{projectId:pid})).items as Array<{id:string;principalType:string}>;const agent=member.find(m=>m.principalType==='agent')!.id;
      const sent=await cmd('message.submit',{target:{kind:'room_root',projectId:pid,conversationId:room.conversationId,roomId:room.id},body:'DIRECT 原始任务',intent:'default',mentions:[{kind:'member',memberId:agent}]});
      const taskId=sent.taskId as string;const threadId=(db.prepare('SELECT conversation_thread_id id FROM tasks WHERE id=?').get(taskId) as {id:string}).id;
      await loader.loadRoomPool(room.id);const task=store.getState().tasks.find(t=>t.id===taskId)!;
      expect(task).toMatchObject({mode:'DIRECT',reviewPolicy:'auto_deliver',objective:null});
      const row=db.prepare('SELECT owner_member_id owner, revision FROM tasks WHERE id=?').get(taskId) as {owner:string;revision:number};expect(task.ownerMemberId).toBe(row.owner);expect(task.revision).toBe(row.revision);
      await new DispatchWorker({db,adapter,leaseOwner:'r78-projection',appDataDir:app}).runOnce();
      await loader.loadThread(threadId,{markRead:false});const details=store.getState().threadTasks[threadId]!;expect(details.activeRun?.status).toBe('SUCCEEDED');
      expect(store.getState().runs).toEqual([]);expect(store.getState().taskDeliveries).toEqual([]);
      const actual=await cmd('task.details',{projectId:pid,taskId});expect((actual.runs as Array<{mode:string}>)[0]!.mode).toBe('DIRECT');
      // Separate regression fault fixture: row revision is mutable, not creation order.
      const oldId=details.activeRun!.id;db.prepare('UPDATE workflow_runs SET revision=999 WHERE id=?').run(oldId);
      db.prepare("INSERT INTO workflow_runs (id,task_id,conversation_id,mode,status,revision) VALUES ('new-r78',?,?,'DIRECT','FAILED',0)").run(taskId,room.conversationId);
      const latest=await cmd('task.get',{taskId});expect((latest.activeRun as {id:string}).id).toBe('new-r78');
      expect((await cmd('run.progress',{taskId})).runStatus).toBe('FAILED');
      expect((db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c).toBe(0);
    }finally{await adapter.closeAllSessions();db.close();}
  },30000);
});
