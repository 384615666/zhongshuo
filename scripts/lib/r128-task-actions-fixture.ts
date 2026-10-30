/** Synthetic SQLite setup only; UI actions are exercised by the Electron driver. */
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {openDatabase} from '../../src/persistence/db.ts';
import {dispatchDaemonCommand} from '../../src/daemon/commands.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {FakeRuntimeAdapter} from '../../src/adapter/fake/runtimeAdapter.ts';
import {localUserId} from '../../src/contracts/daemonIpc.ts';

const [mode,dirArg,projectArg]=process.argv.slice(2);
if(!dirArg)throw Error('Expected seed/snapshot and isolated data directory');
const dir=resolve(dirArg);
if(resolve(process.env.ZS_APP_DATA??'')!==dir||process.env.ZS_ALLOW_FAKE!=='1'||process.env.ZS_REAL_DISPATCH_GUARD!=='1'||process.env.ZS_RUNTIME!=='fake')throw Error('Isolated fake environment required');

function snapshot(){
  const meta=JSON.parse(readFileSync(join(dir,'fixture.json'),'utf8'));
  const db=new Database(join(dir,'state.sqlite'),{readonly:true,fileMustExist:true});
  try{
    return {realCalls:(db.prepare('SELECT count(*) n FROM real_calls').get() as {n:number}).n,
      unfinishedTasks:(db.prepare("SELECT count(*) n FROM tasks WHERE project_id=? AND status NOT IN ('DONE','CANCELLED')").get(meta.projectId) as {n:number}).n,
      cases:meta.cases.map((item:{taskId:string;messageId:string;name:string})=>({...item,
        task:db.prepare('SELECT * FROM tasks WHERE id=?').get(item.taskId),
        runs:db.prepare('SELECT * FROM workflow_runs WHERE task_id=? ORDER BY rowid').all(item.taskId),
        turns:db.prepare('SELECT a.* FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? ORDER BY a.rowid').all(item.taskId),
        originalMessage:db.prepare('SELECT * FROM messages WHERE id=?').get(item.messageId),
        events:db.prepare('SELECT seq,kind,payload_json FROM domain_events WHERE task_id=? ORDER BY seq').all(item.taskId),
      }))};
  }finally{db.close();}
}

async function seed(){
  if(!projectArg)throw Error('Expected synthetic project directory');
  mkdirSync(dir,{recursive:true});mkdirSync(projectArg,{recursive:true});
  writeFileSync(join(projectArg,'README.md'),'# R128 synthetic UI action proof\nNo user data or real models.\n');
  const db=openDatabase(join(dir,'state.sqlite'));
  const adapter=new FakeRuntimeAdapter({turnScripts:[[{kind:'event',event:{kind:'turn.failed',code:'PROVIDER_ERROR',message:'R128 隔离历史执行失败',retryable:false}}]]});
  const worker=new DispatchWorker({db,adapter,leaseOwner:'r128-ui-seed',appDataDir:dir,automaticRecovery:false});
  const cmd=async<T>(method:string,params:unknown):Promise<T>=>{
    const result=await dispatchDaemonCommand({db,appDataDir:dir,localUserId:localUserId(),interruptTurn:id=>worker.interruptTurn(id)},
      {protocolVersion:1,commandId:randomUUID(),method,params}) as {ok:boolean;data:T;error?:unknown};
    if(!result.ok)throw Error(`${method}: ${JSON.stringify(result.error)}`);return result.data;
  };
  try{
    await cmd('app.settings.set',{key:'callBudget.enabled',value:'false'});
    const {project}=await cmd<{project:{id:string}}>('project.open',{path:projectArg});
    db.prepare("UPDATE project_members SET enabled=0 WHERE project_id=? AND principal_type='agent'").run(project.id);
    const {memberId}=await cmd<{memberId:string}>('member.create',{projectId:project.id,displayName:'R128 本地模拟成员'});
    await cmd('member.setRuntime',{memberId,kind:'fake',permissionMode:'bypassPermissions'});
    const cases=[];
    for(const status of ['NO_RUN','FAILED','PARTIAL','INTERRUPTED']){
      const name=status==='NO_RUN'?'结束准备失败任务':`继续 ${status} 历史任务`;
      const {room}=await cmd<{room:{id:string;conversationId:string}}>('room.create',{projectId:project.id,name,memberIds:[memberId]});
      const sent=await cmd<{taskId:string;threadId:string;messageId:string}>('message.submit',{
        target:{kind:'room_root',projectId:project.id,roomId:room.id,conversationId:room.conversationId},
        body:`R128 ${name}：请保留这条原始请求和历史。`,intent:'default',mentions:[{kind:'member',memberId}],
      });
      if(status==='NO_RUN')db.prepare("UPDATE tasks SET write_scope_json=json_set(write_scope_json,'$.launchFingerprintVersion',99) WHERE id=?").run(sent.taskId);
      await worker.drain();
      const runs=db.prepare('SELECT id,status FROM workflow_runs WHERE task_id=?').all(sent.taskId) as Array<{id:string;status:string}>;
      if(status==='NO_RUN'){
        if(runs.length)throw Error('Preparation failure unexpectedly started a run');
      }else{
        if(runs.length!==1||runs[0]!.status!=='FAILED')throw Error('Formal worker did not produce FAILED');
        // Historical states only: execution evidence stays as produced by worker.
        db.prepare('UPDATE workflow_runs SET status=? WHERE id=?').run(status,runs[0]!.id);
        db.prepare("UPDATE tasks SET status='BLOCKED' WHERE id=?").run(sent.taskId);
      }
      const task=db.prepare('SELECT status FROM tasks WHERE id=?').get(sent.taskId) as {status:string};
      if(task.status!=='BLOCKED')throw Error('Expected idle BLOCKED fixture');
      cases.push({...sent,name,status,roomId:room.id,sourceRunId:runs[0]?.id??null});
    }
    writeFileSync(join(dir,'fixture.json'),JSON.stringify({projectId:project.id,memberId,cases},null,2));
  }finally{await adapter.closeAllSessions();await worker.awaitInFlightTurns(3000);db.close();}
  writeFileSync(join(dir,'baseline.json'),JSON.stringify(snapshot(),null,2));
  console.log(JSON.stringify({ok:true,data:dir}));
}

if(mode==='snapshot')console.log(JSON.stringify(snapshot()));
else if(mode==='seed')void seed().catch(error=>{console.error(error);process.exitCode=1;});
else throw Error('Expected seed or snapshot');
