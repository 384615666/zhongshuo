/** Fresh synthetic DB only. Formal command/worker failures for native UI checks. */
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {appendDomainEvent} from '../../src/persistence/events.ts';
import {localUserId} from '../../src/contracts/daemonIpc.ts';
import type {FakeTurnScript} from '../../src/adapter/fake/script.ts';

const [mode,dirArg,projectArg]=process.argv.slice(2),dir=resolve(dirArg??'');
if(!dirArg||resolve(process.env.ZS_APP_DATA??'')!==dir||process.env.ZS_RUNTIME!=='fake'||process.env.ZS_REAL_DISPATCH_GUARD!=='1')throw Error('Isolated Fake environment required');
function snapshot(){const db=new Database(join(dir,'state.sqlite'),{readonly:true,fileMustExist:true});try{return{
  realCalls:(db.prepare('SELECT count(*) n FROM real_calls').get() as {n:number}).n,
  tasks:db.prepare('SELECT id,status,current_delivery_id FROM tasks ORDER BY rowid').all(),
  runs:db.prepare('SELECT id,task_id,status,mode FROM workflow_runs ORDER BY rowid').all(),
  turns:db.prepare('SELECT id,run_id,member_id,status,exec_started_at FROM agent_turns ORDER BY rowid').all(),
  pendingOutbox:db.prepare("SELECT id FROM outbox WHERE status IN ('pending','leased')").all(),
};}finally{db.close();}}
async function seed(){
  if(!projectArg||existsSync(join(dir,'state.sqlite')))throw Error('Fresh data required');
  const project=resolve(projectArg);if(resolve(project,'..')!==resolve(dir,'..'))throw Error('Project must be a synthetic sibling');
  mkdirSync(dir,{recursive:true});mkdirSync(project,{recursive:true});
  const db=openDatabase(join(dir,'state.sqlite'));let script:FakeTurnScript=[];
  const options={structuredFinal:false,turnScriptSequencer:()=>script};
  const adapter=new FakeRuntimeAdapter(options),worker=new DispatchWorker({db,adapter,leaseOwner:'r135-ui-seed',appDataDir:dir,enableDeliberate:true});
  const cmd=async<T>(method:string,params:unknown)=>{const r=await dispatchDaemonCommand({db,localUserId:localUserId(),appDataDir:dir,interruptTurn:id=>worker.interruptTurn(id)},{protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error?:unknown};if(!r.ok)throw Error(method+JSON.stringify(r.error));return r.data;};
  try{
    const projectId=(await cmd<{project:{id:string}}>('project.open',{path:project})).project.id;
    db.prepare("UPDATE project_members SET enabled=0 WHERE project_id=? AND principal_type='agent'").run(projectId);
    const members:string[]=[];for(const name of ['R135 甲','R135 乙']){const {memberId}=await cmd<{memberId:string}>('member.create',{projectId,displayName:name});members.push(memberId);await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});}
    const {room}=await cmd<{room:{id:string;conversationId:string;revision:number}}>('room.create',{projectId,name:'R135 状态验证',memberIds:members});
    const roomRevision=(db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as {revision:number}).revision;
    await cmd('room.update',{roomId:room.id,expectedRevision:roomRevision,coordinatorMemberId:members[0]});
    type Sent={taskId:string;threadId:string;messageId:string};
    const send=(body:string,deliberate=false)=>cmd<Sent>('message.submit',{target:{kind:'room_root',projectId,roomId:room.id,conversationId:room.conversationId},body,intent:'default',mentions:members.slice(0,deliberate?2:1).map(memberId=>({kind:'member',memberId})),...(deliberate?{collaboration:'deliberate'}:{})});
    script=[{kind:'event',event:{kind:'turn.failed',code:'SYNTHETIC_FAILURE',message:'合成执行端暂时不可用，请稍后继续',retryable:false}}];
    const failed=await send('R135 失败后继续',true);await worker.drain();await worker.drain();
    const cancelled=await send('R135 尚未开始');await worker.drain();await worker.drain();
    // Model historical confirmed-not-started evidence; no live process or user data.
    const turn=db.prepare('SELECT a.id,a.run_id FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(cancelled.taskId) as {id:string;run_id:string};
    db.prepare("UPDATE agent_turns SET status='CANCELLED',exec_started_at=NULL,budget_mark='refunded' WHERE id=?").run(turn.id);
    db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id=?").run(cancelled.taskId);
    appendDomainEvent(db,{schemaVersion:1,eventId:randomUUID(),projectId,conversationId:room.conversationId,threadId:cancelled.threadId,taskId:cancelled.taskId,runId:turn.run_id,turnId:turn.id,kind:'turn.startupCancelled',createdAt:Date.now(),payload:{reason:'研讨已中断或同轮结果未知；未请求startTurn',classification:'confirmed-not-started',sessionClose:'closed',budgetRefunded:true}});
    options.structuredFinal=true;
    const finish=(extra:Record<string,unknown>)=>{script=[{kind:'event',event:{kind:'turn.completed',finalText:JSON.stringify({schemaVersion:'task-complete-v1',resultKey:'fixture',responseKind:'conversation',answer:'合成回复，原成果保留',changeSummary:'',files:[],executedVerifications:[],unexecutedVerifications:[],remainingIssues:[],...extra})}}];};
    finish({userQuestion:'请确认仅饮用水还是加茶点？'});const waiting=await send('R135 等待确认');await worker.drain();
    const revision=(db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId) as {revision:number}).revision;
    await cmd('project.reviewPolicy.set',{projectId,taskReviewEnabled:true,expectedRevision:revision});
    finish({responseKind:'work',answer:'合成成果已完成，请验收',changeSummary:'合成成果已完成'});const review=await send('R135 等待验收');await worker.drain();
    await cmd('navigation.set',{clientId:'desktop-hifi',activeProjectId:projectId,visibleProjectIds:[projectId],expandedProjectIds:[projectId],pinnedProjectIds:[],fileGitTabs:{}});
    writeFileSync(join(dir,'fixture.json'),JSON.stringify({projectId,roomId:room.id,members,failed,cancelled,waiting,review},null,2));
  }finally{await adapter.closeAllSessions();db.close();}
  writeFileSync(join(dir,'baseline.json'),JSON.stringify(snapshot(),null,2));
}
if(mode==='seed')void seed().catch(error=>{console.error(error);process.exitCode=1;});
else if(mode==='snapshot'){readFileSync(join(dir,'fixture.json'));console.log(JSON.stringify(snapshot()));}
else throw Error('Expected seed or snapshot');
