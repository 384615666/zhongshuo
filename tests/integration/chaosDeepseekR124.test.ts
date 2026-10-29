import {afterEach,expect,it,vi} from 'vitest';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import type {NormalizedRuntimeEvent} from '../../src/contracts/runtime.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {collisionFixture} from '../helpers/collisionHarnessR122.ts';

afterEach(()=>{vi.unstubAllEnvs();});
async function exercise(mode:string){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
  const f=await collisionFixture('r124-deepseek-terminal-'+mode);
  const evidenceRoot=resolve('dist/r126-protocol/deepseek-executed');mkdirSync(evidenceRoot,{recursive:true});
  const out=mkdtempSync(join(evidenceRoot,mode+'-'));
  const entry=resolve('tests/fixtures/codexRepairR126Terminal.mjs');
  const wirePath=join(out,'wire.jsonl');writeFileSync(wirePath,'');
  const children:ChildProcessWithoutNullStreams[]=[],closed:Promise<void>[]=[];
  const adapter=new CodexAppServerAdapter({mockEntry:{executable:entry,args:[mode,wirePath]},requestTimeoutMs:3000,spawnFn:(command,args)=>{
    if(command!==process.execPath||args[0]!==entry)throw Error('Local-only terminal fixture guard');
    const child=spawn(command,args,{cwd:f.dir,env:{SystemRoot:process.env['SystemRoot'],WINDIR:process.env['WINDIR'],TEMP:f.dir,TMP:f.dir},windowsHide:true,stdio:['pipe','pipe','pipe']});
    children.push(child);closed.push(new Promise<void>(done=>child.once('close',()=>done())));
    writeFileSync(join(out,'launches.json'),JSON.stringify({command,args,pid:child.pid,realBusinessModelCalls:0},null,2));return child;
  }});
  const observed:NormalizedRuntimeEvent[]=[];
  const events=adapter.events.bind(adapter);
  vi.spyOn(adapter,'events').mockImplementation(session=>({async *[Symbol.asyncIterator](){for await(const event of events(session)){observed.push(event);yield event;}}}));
  const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r124-deepseek-status-'+mode,appDataDir:f.dir,detachedTurnConsumption:true,automaticRecovery:false});
  try{
    const root=await f.send(0,0,[0],'TOKEN_DEEPSEEK_STATUS 检查运行端的完成状态');
    await worker.runOnce();
    const settled=await worker.awaitInFlightTurns(3000);
    expect(settled.remaining).toHaveLength(0);
    const turn=f.db.prepare('SELECT a.status,r.status workflowStatus FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(root.taskId) as {status:string;workflowStatus:string};
    const facts={fixture:f.dir,origin:'newapi/deepseek-flash max / protocol-recovery S1',providerStatus:mode,taskStatus:f.taskStatus(root.taskId),turnStatus:turn.status,workflowStatus:turn.workflowStatus,remainingConsumers:settled.remaining,terminalEvents:observed.filter(event=>event.kind==='turn.completed'||event.kind==='turn.failed'),deliveries:f.count('SELECT count(*) n FROM task_deliveries WHERE task_id=?',root.taskId),replies:f.count("SELECT count(*) n FROM messages WHERE thread_id=? AND author_type='agent'",root.threadId),realCalls:f.count('SELECT count(*) n FROM real_calls')};
    const databaseBeforeCleanup={tasks:f.db.prepare('SELECT id,status FROM tasks').all(),turns:f.db.prepare('SELECT id,status,session_id FROM agent_turns').all(),messages:f.db.prepare('SELECT id,author_type,body_json FROM messages').all(),events:f.db.prepare('SELECT seq,kind,payload_json FROM domain_events').all(),outbox:f.db.prepare('SELECT id,status,attempt_epoch FROM outbox').all()};
    const result={...facts,dir:out,databaseBeforeCleanup};
    writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));writeFileSync(join(evidenceRoot,mode+'-latest.json'),JSON.stringify(result,null,2));
    expect(facts.realCalls).toBe(0);
    return facts;
  }finally{
    await adapter.dispose();await Promise.all(closed);const remaining=await worker.awaitInFlightTurns(3000);await f.close();
    writeFileSync(join(out,'cleanup.json'),JSON.stringify({allOwnedChildrenClosed:children.every(child=>child.exitCode!=null||child.signalCode!=null),remainingConsumers:remaining.remaining,databaseClosed:!f.db.open,children:children.map(child=>({pid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode}))},null,2));
  }
}

for(const mode of ['cancelled','inProgress','null','missing','unrecognized']){
  it(`DeepSeek S1 repaired: provider status ${mode} settles UNKNOWN without a successful task or delivery`,async()=>{
    const facts=await exercise(mode);
    expect(facts.turnStatus,'an invalid terminal has not proved execution stopped; retain UNKNOWN protection without hanging a consumer').toBe('UNKNOWN');
    expect(facts.remainingConsumers).toEqual([]);
    expect(facts.terminalEvents).toMatchObject([{kind:'turn.failed',code:'CODEX_INVALID_TERMINAL_STATUS',retryable:false}]);
    expect(facts.taskStatus).not.toBe('DONE');
    expect(facts.deliveries).toBe(0);
    expect(facts.replies).toBe(0);
  });
}
it('DeepSeek S1 control: explicit completed produces one genuine success settlement',async()=>{
  expect(await exercise('completed')).toMatchObject({turnStatus:'SUCCEEDED',taskStatus:'DONE',terminalEvents:[{kind:'turn.completed'}],replies:1,realCalls:0});
});
it('DeepSeek S1 control: explicit failed never becomes successful',async()=>{
  const facts=await exercise('failed');expect(facts.turnStatus).toBe('FAILED');expect(facts.terminalEvents).toMatchObject([{kind:'turn.failed',code:'TEST_FAILURE'}]);expect(facts.taskStatus).not.toBe('DONE');expect(facts.deliveries).toBe(0);expect(facts.replies).toBe(0);
});
