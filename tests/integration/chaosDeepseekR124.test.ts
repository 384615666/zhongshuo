import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';
import {collisionFixture} from '../helpers/collisionHarnessR122.ts';

const reached=new Set<string>();
afterEach(({task})=>{try{if(task.name.includes('OPEN BUG'))expect(reached.has(task.name),'a valid protocol/worker observation must precede the expected failed invariant').toBe(true);}finally{vi.unstubAllEnvs();}});
async function exercise(mode:string){
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
  const f=await collisionFixture('r124-deepseek-terminal-'+mode);
  const adapter=new CodexAppServerAdapter({mockEntry:{executable:resolve('tests/fixtures/chaosDeepseekR124.mjs'),args:[mode]},requestTimeoutMs:3000});
  const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'r124-deepseek-status-'+mode,appDataDir:f.dir,detachedTurnConsumption:true,automaticRecovery:false});
  try{
    const root=await f.send(0,0,[0],'TOKEN_DEEPSEEK_STATUS 检查运行端的完成状态');
    await worker.runOnce();
    const settled=await worker.awaitInFlightTurns(3000);
    expect(settled.remaining).toHaveLength(0);
    const turn=f.db.prepare('SELECT a.status FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').get(root.taskId) as {status:string};
    const facts={fixture:f.dir,origin:'newapi/deepseek-flash max / protocol-recovery S1',providerStatus:mode,taskStatus:f.taskStatus(root.taskId),turnStatus:turn.status,deliveries:f.count('SELECT count(*) n FROM task_deliveries WHERE task_id=?',root.taskId),realCalls:f.count('SELECT count(*) n FROM real_calls')};
    const out=resolve('dist/r124-chaos/deepseek-executed');mkdirSync(out,{recursive:true});writeFileSync(join(out,'status-'+mode+'.json'),JSON.stringify(facts,null,2));
    expect(facts.realCalls).toBe(0);
    return facts;
  }finally{await adapter.dispose();await worker.awaitInFlightTurns(3000);await f.close();}
}

for(const mode of ['cancelled','inProgress','null','missing','unrecognized']){
  it.fails(`OPEN BUG / DeepSeek S1: provider status ${mode} must not produce a successful task`,async({task})=>{
    const facts=await exercise(mode);
    reached.add(task.name);
    expect(facts.turnStatus,'only an explicit successful terminal is a success fact').not.toBe('SUCCEEDED');
    expect(facts.taskStatus).not.toBe('DONE');
    expect(facts.deliveries).toBe(0);
  });
}
it('DeepSeek S1 control: explicit completed produces one genuine success settlement',async()=>{
  expect(await exercise('completed')).toMatchObject({turnStatus:'SUCCEEDED',taskStatus:'DONE',realCalls:0});
});
it('DeepSeek S1 control: explicit failed never becomes successful',async()=>{
  const facts=await exercise('failed');expect(facts.turnStatus).toBe('FAILED');expect(facts.taskStatus).not.toBe('DONE');expect(facts.deliveries).toBe(0);
});
