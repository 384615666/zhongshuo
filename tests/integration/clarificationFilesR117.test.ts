import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker,type DispatchWorkerOptions} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';
import {pendingClarificationChangeSets,changeSetFilesForDelivery} from '../../src/daemon/clarificationWork.ts';
import {captureBaseline,finalizeChangeset} from '../../src/daemon/changeset.ts';
import {verifyHandoffFiles} from '../../src/daemon/coordination.ts';
afterEach(()=>vi.unstubAllEnvs());
const output=(answer:string,coordinationPlan?:unknown,extra:Record<string,unknown>={}):FakeTurnScript=>[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',answer,responseKind:'work',changeSummary:answer,files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...(coordinationPlan?{coordinationPlan}:{}),...extra})}}];
async function fixture(enableDeliberate=false,options:Partial<Pick<DispatchWorkerOptions,'turnDeadlineMs'|'interruptGraceMs'|'coordinationMaxCalls'|'detachedTurnConsumption'>>={}) {
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');
  const dir=mkdtempSync(join(tmpdir(),'zs-r86-coordination-')),project=join(dir,'project');mkdirSync(project);
  let db=openDatabase(join(dir,'state.sqlite'));
  let script:FakeTurnScript=output('你好');
  const adapter=new FakeRuntimeAdapter({structuredFinal:!enableDeliberate,turnScriptSequencer:()=>script});
  let worker=new DispatchWorker({db,adapter,leaseOwner:'r86',appDataDir:dir,enableDeliberate,coordinationMaxCalls:6,...options});
  const deps={db,localUserId:'u_local',appDataDir:dir,interruptTurn:(id:string)=>worker.interruptTurn(id)};
  async function raw(method:string,params:unknown,commandId:string=randomUUID()) {return await dispatchDaemonCommand(deps,{protocolVersion:1,commandId,method,params}) as {ok:boolean;data?:unknown;error?:unknown};}
  async function cmd<T>(method:string,params:unknown,commandId?:string):Promise<T> {const r=await raw(method,params,commandId);expect(r.ok,JSON.stringify(r)).toBe(true);return (r as {data:unknown}).data as T;}
  const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
  const room=(await cmd<{items:{id:string;conversationId:string}[]}>('room.list',{projectId})).items[0]!;
  const a=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'同名成员'})).memberId;
  const b=(await cmd<{memberId:string}>('member.create',{projectId,displayName:'同名成员'})).memberId;
  for(const memberId of [a,b]) await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
  const revision=(db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision:number}).revision;
  await cmd('room.update',{roomId:room.id,expectedRevision:revision,coordinatorMemberId:a});
  const send=(mentions:string[]=[])=>cmd<{taskId:string;threadId:string}>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body:'请两位成员协作分析再复核',intent:'default',...(enableDeliberate?{collaboration:'deliberate'}:{}),mentions:mentions.map(memberId=>({kind:'member',memberId}))});
  const plan={summary:'独立分析后复核',steps:[{key:'analysis',memberId:a,title:'分析',objective:'提出实现方案',role:'analysis',dependsOn:[]},{key:'review',memberId:b,title:'复核',objective:'读取并复核上游方案',role:'review',dependsOn:['analysis']}]};
  const run=async(s:FakeTurnScript)=>{script=s;return worker.runOnce();};
  return {get db(){return db;},dir,get worker(){return worker;},adapter,cmd,raw,send,run,plan,a,b,room,projectId,
    restart(){db.close();db=openDatabase(join(dir,'state.sqlite'));deps.db=db;worker=new DispatchWorker({db,adapter,leaseOwner:'r117-reopen',appDataDir:dir,coordinationMaxCalls:20});}
  };
}


describe('R117 partial work through user confirmation',()=>{
 it('keeps ordered deletion and recreation versions, and rejects a broken intermediate version',async()=>{
  const f=await fixture();
  try{
   const root=await f.send();
   const project=(f.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(f.projectId) as {canonical_path:string}).canonical_path;
   const capture=()=>{
    const baseline=captureBaseline(f.db,{projectId:f.projectId,taskId:root.taskId,appDataDir:f.dir});
    if(!baseline.ok)throw Error(baseline.error.message);
    return baseline.value.changeSetId;
   };
   const first=capture();writeFileSync(join(project,'version.md'),'第一版');
   expect(finalizeChangeset(f.db,{changeSetId:first,appDataDir:f.dir}).ok).toBe(true);
   const second=capture();unlinkSync(join(project,'version.md'));
   expect(finalizeChangeset(f.db,{changeSetId:second,appDataDir:f.dir}).ok).toBe(true);
   const removed=changeSetFilesForDelivery(f.db,root.taskId,[first,second]);
   expect(removed).toEqual([{path:'version.md',state:'absent',sha256:null}]);
   expect(()=>verifyHandoffFiles({files:removed},project)).not.toThrow();
   const third=capture();writeFileSync(join(project,'version.md'),'重新创建后的最终版');
   expect(finalizeChangeset(f.db,{changeSetId:third,appDataDir:f.dir}).ok).toBe(true);
   const final=changeSetFilesForDelivery(f.db,root.taskId,[first,second,third]);
   expect(final).toHaveLength(1);expect(()=>verifyHandoffFiles({files:final},project)).not.toThrow();
   writeFileSync(join(project,'version.md'),'外部改动');
   expect(()=>verifyHandoffFiles({files:final},project)).toThrow('文件字节已变化');
   const fourth=capture();writeFileSync(join(project,'version.md'),'最终文件看似合法的新版本');
   expect(finalizeChangeset(f.db,{changeSetId:fourth,appDataDir:f.dir}).ok).toBe(true);
   expect(()=>changeSetFilesForDelivery(f.db,root.taskId,[first,second,third,fourth])).toThrow('文件版本已变化');
  }finally{await f.adapter.closeAllSessions();f.db.close();}
 });
 it.each(['unchanged','edit','additional','repeat','restart','legacy','legacy-repair'] as const)('preserves the complete ordered file chain: %s',async variant=>{
  const f=await fixture(false,{coordinationMaxCalls:20});
  try{
   const root=await f.send();await f.run(output('先实施再复核',f.plan));
   const child=(f.db.prepare("SELECT child_task_id id FROM coordination_steps WHERE step_key='analysis'").get() as {id:string}).id;
   const project=(f.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(f.projectId) as {canonical_path:string}).canonical_path;
   await f.run([{kind:'writeFile',path:'prepared.md',content:'已完成的第一部分'},...output('已保存第一部分',undefined,{
    files:['prepared.md'],userQuestion:'请选择方案甲或乙',...(variant==='legacy-repair'?{invalidExtra:'触发一次只修格式的补交'}:{}),
   })]);
   if(variant==='legacy-repair'){
    const source=f.db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(child) as {id:string};
    const task=f.db.prepare('SELECT revision,stop_generation FROM tasks WHERE id=?').get(child) as {revision:number;stop_generation:number};
    await f.cmd('task.redispatch',{taskId:child,formatRepair:true,reason:'补交原输出格式',sourceRunId:source.id,
      expectedRunStatus:'FAILED',expectedTaskRevision:task.revision,expectedStopGeneration:task.stop_generation});
    expect(await f.run(output('已保留原文件，请确认',undefined,{files:['prepared.md'],userQuestion:'请选择方案甲或乙'}))).toBe(true);
    f.db.prepare("UPDATE domain_events SET payload_json=json_remove(payload_json,'$.changeSetRefs') WHERE task_id=? AND kind='turn.workClarification'").run(child);
    f.db.prepare("DELETE FROM daemon_state WHERE key LIKE 'repair-source-changeset:%'").run();
   }
   const firstRefs=pendingClarificationChangeSets(f.db,child,0);expect(firstRefs.length).toBeGreaterThan(0);
   await f.worker.runOnce();
   if(variant==='legacy')f.db.prepare("UPDATE domain_events SET payload_json=json_remove(payload_json,'$.changeSetRefs') WHERE task_id=? AND kind='turn.workClarification'").run(child);
   if(variant==='restart')f.restart();
   const target={kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId};
   await f.cmd('message.submit',{target,body:'选择方案甲，继续原步骤',intent:'default',mentions:[]});
   if(variant==='repeat'){
    await f.run([{kind:'writeFile',path:'prepared.md',content:'第一部分及确认后的修订'},...output('已经修改，请确认下一项',undefined,{files:['prepared.md'],userQuestion:'第二项是否继续'})]);
    await f.worker.runOnce();
    await f.cmd('message.submit',{target,body:'第二项继续',intent:'default',mentions:[]});
   }
   const script:Array<FakeTurnScript[number]>=[];
   if(variant==='edit')script.push({kind:'writeFile',path:'prepared.md',content:'最终修改版'});
   if(variant==='additional')script.push({kind:'writeFile',path:'followup.md',content:'后续部分'});
   script.push(...output('按答复完成原步骤',undefined,{files:['prepared.md']}));
   expect(await f.run(script)).toBe(true);
   expect(pendingClarificationChangeSets(f.db,child,0)).toEqual([]);
   const delivery=f.db.prepare('SELECT change_set_refs_json FROM task_deliveries WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(child) as {change_set_refs_json:string};
   expect(JSON.parse(delivery.change_set_refs_json)).toEqual(expect.arrayContaining(firstRefs));
   expect(await f.run(output('逐一复核完整文件版本'))).toBe(true);
   const saved=f.db.prepare("SELECT handoff_json FROM coordination_steps WHERE step_key='analysis'").get() as {handoff_json:string};
   const files=JSON.parse(saved.handoff_json).output.files as Array<{path:string;state:string;sha256:string}>;
   expect(files.filter(file=>file.path==='prepared.md')).toHaveLength(1);
   expect(files.find(file=>file.path==='prepared.md')?.sha256).toBe(createHash('sha256').update(readFileSync(join(project,'prepared.md'))).digest('hex'));
   if(variant==='additional')expect(files.some(file=>file.path==='followup.md')).toBe(true);
   expect(await f.run(output('整合所有已完成成果'))).toBe(true);
   expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({status:'DONE'});
  }finally{await f.adapter.closeAllSessions();f.db.close();}
 });
 it.each(['during-wait','after-answer'] as const)('refuses changed partial results %s without calling the next model',async when=>{
  const f=await fixture(false,{coordinationMaxCalls:20});
  try{
   const root=await f.send();await f.run(output('实施后核对',f.plan));
   const project=(f.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(f.projectId) as {canonical_path:string}).canonical_path;
   await f.run([{kind:'writeFile',path:'prepared.md',content:'被冻结的成果'},...output('请确认',undefined,{files:['prepared.md'],userQuestion:'采用甲还是乙'})]);
   await f.worker.runOnce();
   if(when==='during-wait')writeFileSync(join(project,'prepared.md'),'外部改动');
   await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId},body:'采用甲',intent:'default',mentions:[]});
   if(when==='after-answer'){
    expect(await f.run(output('已确认完成，原文件保留',undefined,{files:['prepared.md']}))).toBe(true);
    writeFileSync(join(project,'prepared.md'),'外部改动');
   }
   const calls=f.adapter.startTurnLog.length;
   await f.worker.runOnce();
   expect(f.adapter.startTurnLog).toHaveLength(calls);
   expect(readFileSync(join(project,'prepared.md'),'utf8')).toBe('外部改动');
   expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).not.toEqual({status:'DONE'});
  }finally{await f.adapter.closeAllSessions();f.db.close();}
 });
 it('rechecks the retained file after an asynchronous session open',async()=>{
  const f=await fixture(false,{coordinationMaxCalls:20});
  try{
   const root=await f.send();await f.run(output('实施后核对',f.plan));
   const project=(f.db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(f.projectId) as {canonical_path:string}).canonical_path;
   await f.run([{kind:'writeFile',path:'prepared.md',content:'提问前成果'},...output('请确认',undefined,{files:['prepared.md'],userQuestion:'是否采用甲'})]);
   await f.worker.runOnce();
   await f.cmd('message.submit',{target:{kind:'thread',projectId:f.projectId,conversationId:f.room.conversationId,threadId:root.threadId},body:'采用甲',intent:'default',mentions:[]});
   const open=f.adapter.openSession.bind(f.adapter),calls=f.adapter.startTurnLog.length;
   const spy=vi.spyOn(f.adapter,'openSession').mockImplementationOnce(async options=>{
    const session=await open(options);writeFileSync(join(project,'prepared.md'),'连接期间被外部修改');return session;
   });
   try{await f.run(output('不应实际执行'));}catch(error){expect(String(error)).toContain('文件字节已变化');}finally{spy.mockRestore();}
   expect(f.adapter.startTurnLog).toHaveLength(calls);
   expect(readFileSync(join(project,'prepared.md'),'utf8')).toBe('连接期间被外部修改');
  }finally{await f.adapter.closeAllSessions();f.db.close();}
 });
});
