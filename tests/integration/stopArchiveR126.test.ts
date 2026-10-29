import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';

type Reply={ok:boolean;data?:unknown;error?:{code:string;message:string};replayed?:boolean};
type Root={taskId:string;threadId:string};
const cleanups:Array<()=>void>=[];
beforeEach(()=>{
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY','0');
});
afterEach(()=>{try{for(const close of cleanups.splice(0))close();}finally{vi.unstubAllEnvs();}});

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'zs-r126-stop-archive-'));
  const db=openDatabase(join(dir,'state.sqlite'));
  cleanups.push(()=>{
    try{expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n:0});}
    finally{db.close();rmSync(dir,{recursive:true,force:true});}
  });
  const interrupts:string[]=[];
  let failInterrupt=false;
  const raw=async(method:string,params:unknown,commandId:string=randomUUID()):Promise<Reply>=>
    await dispatchDaemonCommand({db,localUserId:'u_local',appDataDir:dir,interruptTurn:async id=>{
      interrupts.push(id);if(failInterrupt)throw Error('PRIVATE_ADAPTER_DIAGNOSTIC');
    }},{protocolVersion:1,commandId,method,params}) as Reply;
  const cmd=async<T>(method:string,params:unknown,commandId?:string):Promise<T>=>{
    const r=await raw(method,params,commandId);expect(r.ok,JSON.stringify(r)).toBe(true);return r.data as T;
  };
  await cmd('app.settings.set',{key:'callBudget.enabled',value:'false'});
  const path=join(dir,'project');mkdirSync(path);
  const {project}=await cmd<{project:{id:string}}>('project.open',{path,agentNames:[]});
  const members:string[]=[];
  for(let i=0;i<2;i++){
    const {memberId}=await cmd<{memberId:string}>('member.create',{projectId:project.id,displayName:`本地角色${i}`});
    await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'plan'});members.push(memberId);
  }
  const rooms:Array<{id:string;conversationId:string}>=[];
  for(let i=0;i<2;i++)rooms.push((await cmd<{room:{id:string;conversationId:string}}>('room.create',{projectId:project.id,name:`房间${i}`,memberIds:members})).room);
  const send=(mode:'DIRECT'|'DELIBERATE'='DIRECT',room=rooms[0]!)=>cmd<Root>('message.submit',{
    target:{kind:'room_root',projectId:project.id,conversationId:room.conversationId,roomId:room.id},
    body:'独立本地排队任务',intent:'default',mentions:(mode==='DIRECT'?members.slice(0,1):members).map(memberId=>({kind:'member',memberId})),
    ...(mode==='DELIBERATE'?{collaboration:'deliberate'}:{}),
  });
  const archive=(action:'room'|'archive'|'remove')=>action==='room'
    ?raw('room.archive',{roomId:rooms[0]!.id,expectedRevision:0,action:'archive'})
    :raw('project.lifecycle',{projectId:project.id,expectedRevision:0,action});
  // Synthetic run facts isolate stop identity/state decisions from scheduling;
  // every stop and receipt still uses the production command/SQLite transaction.
  const addRun=(root:Root,id:string,revision:number,status='RUNNING')=>{
    db.prepare(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,revision,status)
      VALUES(?,?,?,?,'DIRECT',?,?)`).run(id,root.taskId,rooms[0]!.conversationId,root.threadId,revision,status);
    db.prepare(`INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,dispatch_key)
      VALUES(?,?,?,?,?,'stage_work',?,?)`).run(`turn-${id}`,id,rooms[0]!.conversationId,root.threadId,members[0],status==='STOPPING'?'STOPPING':'RUNNING',`synthetic:${id}`);
  };
  const gen=(root:Root)=>(db.prepare('SELECT stop_generation n FROM tasks WHERE id=?').get(root.taskId) as {n:number}).n;
  const stop=(root:Root,targetRunId:string,expectedStopGeneration:number,id?:string)=>raw('task.stop',{taskId:root.taskId,targetRunId,expectedStopGeneration},id);
  return{db,raw,cmd,project,members,rooms,send,archive,addRun,gen,stop,interrupts,failInterrupt:()=>{failInterrupt=true;}};
}

describe('R126 queued archive and stop identity/error contracts; isolated SQLite, no models',()=>{
  it.each(['DIRECT','DELIBERATE'] as const)('%s OPEN roots block room archive and project archive/remove without mutating queues',async mode=>{
    const f=await fixture(),root=await f.send(mode);
    expect(f.db.prepare('SELECT status,route_json FROM tasks WHERE id=?').get(root.taskId)).toMatchObject({status:'OPEN',route_json:expect.stringContaining(`"mode":"${mode}"`)});
    const before=f.db.prepare('SELECT * FROM outbox').all();
    for(const action of ['room','archive','remove'] as const)expect(await f.archive(action)).toMatchObject({ok:false,error:{code:'WORKER_STILL_RUNNING'}});
    expect(f.db.prepare('SELECT status,revision FROM projects WHERE id=?').get(f.project.id)).toEqual({status:'active',revision:0});
    expect(f.db.prepare('SELECT archived_at,revision FROM rooms WHERE id=?').get(f.rooms[0]!.id)).toEqual({archived_at:null,revision:0});
    expect(f.db.prepare('SELECT * FROM outbox').all()).toEqual(before);
    expect(f.db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:0});
  });

  it('a queued DM blocks project archive/remove but does not block an unrelated room archive',async()=>{
    const f=await fixture();
    const {conversationId}=await f.cmd<{conversationId:string}>('conversation.create',{projectId:f.project.id,peerMemberId:f.members[0]});
    const root=await f.cmd<Root>('message.submit',{target:{kind:'dm',projectId:f.project.id,conversationId},body:'私信排队',intent:'default',mentions:[]});
    expect(f.db.prepare('SELECT kind,room_id,status FROM tasks WHERE id=?').get(root.taskId)).toEqual({kind:'dm_turn',room_id:null,status:'ACTIVE'});
    for(const action of ['archive','remove'] as const)expect(await f.archive(action)).toMatchObject({ok:false,error:{code:'WORKER_STILL_RUNNING'}});
    expect(await f.archive('room')).toMatchObject({ok:true});
    expect(f.db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({n:0});
  });

  it('another room OPEN root does not block the target room; finished tasks allow project lifecycle',async()=>{
    const f=await fixture(),root=await f.send('DIRECT',f.rooms[1]);
    expect(await f.archive('room')).toMatchObject({ok:true});
    // Explicit terminal facts: no worker or queued work is hidden by this control.
    f.db.prepare("UPDATE tasks SET status='DONE' WHERE id=?").run(root.taskId);
    f.db.prepare("UPDATE outbox SET status='done'").run();
    expect(await f.archive('archive')).toMatchObject({ok:true});
    await f.cmd('project.lifecycle',{projectId:f.project.id,expectedRevision:1,action:'unarchive'});
    expect(await f.raw('project.lifecycle',{projectId:f.project.id,expectedRevision:2,action:'remove'})).toMatchObject({ok:true});
  });

  it('fresh command IDs and refreshed STOPPING snapshots advance exactly once and preserve the target',async()=>{
    const f=await fixture(),root=await f.send();f.addRun(root,'first',0);
    for(const generation of [0,0,0,1,1])expect(await f.stop(root,'first',generation)).toMatchObject({ok:true,data:{outcome:'stopping',stopGeneration:1}});
    expect(f.gen(root)).toBe(1);
    expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE run_id='first' AND kind='run.statusChanged' AND json_extract(payload_json,'$.status')='STOPPING'").get()).toEqual({n:1});
    expect(f.interrupts).toEqual(Array(5).fill('turn-first'));
    expect(f.db.prepare('SELECT id,status FROM workflow_runs').all()).toEqual([{id:'first',status:'STOPPING'}]);
  });

  it('a stale run and its receipt replay cannot stop a successor; a new explicit stop advances the successor once',async()=>{
    const f=await fixture(),root=await f.send();f.addRun(root,'old',0);
    const id='r126-old-stop';await f.stop(root,'old',0,id);
    f.db.prepare("UPDATE agent_turns SET status='CANCELLED' WHERE run_id='old'").run();
    f.db.prepare("UPDATE workflow_runs SET status='CANCELLED' WHERE id='old'").run();
    f.addRun(root,'new',0); // Real worker runs can share revision=0; UUID order is not attempt order.
    expect(await f.stop(root,'old',0)).toMatchObject({ok:true,data:{outcome:'already_stopped',stopGeneration:1}});
    expect(await f.stop(root,'old',0,id)).toMatchObject({ok:true,data:{stopGeneration:1}});
    expect(f.interrupts).toEqual(['turn-old']);
    expect(f.db.prepare("SELECT status FROM workflow_runs WHERE id='new'").get()).toEqual({status:'RUNNING'});
    expect(await f.stop(root,'new',1)).toMatchObject({ok:true,data:{outcome:'stopping',stopGeneration:2}});
    expect(await f.stop(root,'new',1)).toMatchObject({ok:true,data:{stopGeneration:2}});
    expect(f.gen(root)).toBe(2);expect(f.interrupts).toEqual(['turn-old','turn-new','turn-new']);
  });

  it('an unfinished obsolete run cannot redirect stop to a later run sharing the same revision',async()=>{
    const f=await fixture(),root=await f.send();
    f.addRun(root,'z-old-live',0);f.addRun(root,'a-new-live',0);
    expect(await f.stop(root,'z-old-live',0)).toMatchObject({ok:true,data:{outcome:'target_obsolete',stopGeneration:0}});
    expect(f.gen(root)).toBe(0);expect(f.interrupts).toEqual([]);
    expect(await f.stop(root,'a-new-live',0)).toMatchObject({ok:true,data:{outcome:'stopping',stopGeneration:1}});
    expect(f.interrupts).toEqual(['turn-a-new-live']);
    expect(f.db.prepare("SELECT status FROM workflow_runs WHERE id='z-old-live'").get()).toEqual({status:'RUNNING'});
  });

  it('an old stop receipt replay cannot interrupt a successor child already STOPPING',async()=>{
    const f=await fixture(),root=await f.send();f.addRun(root,'old-parent',0);
    const id='r126-old-parent-stop';await f.stop(root,'old-parent',0,id);
    f.db.prepare("UPDATE agent_turns SET status='CANCELLED' WHERE run_id='old-parent'").run();
    f.db.prepare("UPDATE workflow_runs SET status='CANCELLED' WHERE id='old-parent'").run();
    f.addRun(root,'new-parent',0);
    const child=await f.send();f.db.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(root.taskId,child.taskId);
    f.addRun(child,'new-child',0,'STOPPING');
    expect(await f.stop(root,'old-parent',0,id)).toMatchObject({ok:true,data:{stopGeneration:1}});
    expect(f.interrupts).toEqual(['turn-old-parent']);
    expect(f.gen(root)).toBe(1);expect(f.gen(child)).toBe(0);
    expect(f.db.prepare("SELECT status FROM workflow_runs WHERE id='new-parent'").get()).toEqual({status:'RUNNING'});
  });

  it('future generations and expired stop receipts retain known business errors without side effects',async()=>{
    const f=await fixture(),root=await f.send();f.addRun(root,'live',0);
    expect(await f.stop(root,'live',9)).toMatchObject({ok:false,error:{code:'STALE_REVISION'}});
    expect(f.gen(root)).toBe(0);expect(f.interrupts).toEqual([]);
    const id='r126-expired';await f.stop(root,'live',0,id);
    f.db.prepare('UPDATE command_receipts SET result_json=NULL WHERE command_id=?').run(id);
    expect(await f.stop(root,'live',0,id)).toMatchObject({ok:false,error:{code:'RESULT_EXPIRED'}});
    expect(f.gen(root)).toBe(1);expect(f.interrupts).toEqual(['turn-live']);
  });

  it('real SQLite write failure returns STORAGE_UNAVAILABLE, hides diagnostics, and rolls back generation/run/receipt',async()=>{
    const f=await fixture(),root=await f.send();f.addRun(root,'db-failure',0);
    f.db.exec("CREATE TRIGGER r126_stop_failure BEFORE UPDATE OF stop_generation ON tasks BEGIN SELECT RAISE(ABORT,'PRIVATE_SQLITE_DIAGNOSTIC'); END");
    const id='r126-db-failure',result=await f.stop(root,'db-failure',0,id);
    expect(result).toMatchObject({ok:false,error:{code:'STORAGE_UNAVAILABLE'}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SQLITE_DIAGNOSTIC');
    expect(f.gen(root)).toBe(0);expect(f.interrupts).toEqual([]);
    expect(f.db.prepare('SELECT * FROM command_receipts WHERE command_id=?').get(id)).toBeUndefined();
    expect(f.db.prepare("SELECT status FROM workflow_runs WHERE id='db-failure'").get()).toEqual({status:'RUNNING'});
    f.db.exec('DROP TRIGGER r126_stop_failure');
    expect(await f.stop(root,'db-failure',0,id)).toMatchObject({ok:true,data:{stopGeneration:1}});
  });

  it('interrupt failure remains a failure after the durable stop and does not pretend protection was released',async()=>{
    const f=await fixture(),root=await f.send();f.addRun(root,'interrupt-failure',0);f.failInterrupt();
    const result=await f.stop(root,'interrupt-failure',0);
    expect(result).toMatchObject({ok:false,error:{code:'STORAGE_UNAVAILABLE'}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_ADAPTER_DIAGNOSTIC');
    expect(f.gen(root)).toBe(1);
    expect(f.db.prepare("SELECT status FROM agent_turns WHERE run_id='interrupt-failure'").get()).toEqual({status:'STOPPING'});
    expect(f.db.prepare("SELECT count(*) n FROM domain_events WHERE kind='recovery.protectionReleased'").get()).toEqual({n:0});
  });
});
