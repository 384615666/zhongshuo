import {expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CodexAppServerAdapter} from '../../src/adapter/codex/appServerAdapter.ts';
import type {NormalizedRuntimeEvent,SessionRef} from '../../src/contracts/runtime.ts';
import {collisionFixture,pause} from '../helpers/collisionHarnessR122.ts';
import {DispatchWorker} from '../../src/daemon/dispatchWorker.ts';

async function readTurn(adapter:CodexAppServerAdapter,session:SessionRef):Promise<NormalizedRuntimeEvent[]>{
  const events:NormalizedRuntimeEvent[]=[];
  for await(const event of adapter.events(session)){
    events.push(event);
    if(event.kind==='turn.completed'&&event.turnId!=null)return events;
  }
  return events;
}
const makeAdapter=()=>new CodexAppServerAdapter({mockEntry:{executable:resolve('tests/fixtures/collisionAppServerR122.mjs')},requestTimeoutMs:3000});
const open=(adapter:CodexAppServerAdapter,n:number)=>adapter.openSession({projectId:'fixture',memberId:'shared-role',taskId:`task-${n}`,threadId:`chat-${n}`,sessionGeneration:n,cwd:process.cwd(),policyId:'plan'});
const request=(n:number,text=`SESSION_SECRET_${n}`)=>({turnId:`internal-${n}`,dispatchKey:`dispatch-${n}`,inputBundleId:`bundle-${n}`,text,policyId:'plan',taskRevision:0});

it('24 actual protocol sessions of the same role tolerate interleaved notifications before responses and reused provider item IDs',async()=>{
  const adapter=makeAdapter();
  try{
    const sessions:SessionRef[]=[];for(let n=0;n<24;n++)sessions.push(await open(adapter,n));
    const reading=sessions.map(s=>readTurn(adapter,s));
    await Promise.all(sessions.map((s,n)=>adapter.startTurn(s,request(n))));
    const received=await Promise.all(reading);
    for(let n=0;n<received.length;n++){
      const terminal=received[n]!.find(e=>e.kind==='turn.completed');expect(terminal).toMatchObject({turnId:`internal-${n}`,finalText:`SESSION_SECRET_${n}`});
      for(const event of received[n]!){expect(event.sessionId).toBe(sessions[n]!.id);if(event.turnId)expect(event.turnId).toBe(`internal-${n}`);}
    }
    const dir=resolve('dist/r122-collisions');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'codex-protocol-parallel.json'),JSON.stringify({ok:true,sessions:24,realModelCalls:0,subprocess:'local protocol fixture',crossedEvents:0}));
  }finally{await adapter.dispose();}
},10000);

it('checks whether an unattributed completed message can reach the wrong conversation through the production worker',async()=>{
  vi.stubEnv('ZS_ALLOW_FAKE','1');vi.stubEnv('ZS_RUNTIME','fake');vi.stubEnv('ZS_REAL_DISPATCH_GUARD','1');
  const f=await collisionFixture('unattributed-worker-message'),adapter=makeAdapter();
  const worker=new DispatchWorker({db:f.db,adapter,leaseOwner:'collision-protocol-worker',appDataDir:f.dir,detachedTurnConsumption:true});
  try{
    const victim=await f.send(0,0,[0],'TOKEN_VICTIM 本串没有错误消息');
    const source=await f.send(0,1,[1],'TOKEN_BAD_SOURCE 这个执行端发出畸形消息');
    await worker.runOnce();await worker.runOnce();
    for(let i=0;i<200;i++){await worker.drain();if([victim,source].every(r=>f.taskStatus(r.taskId)==='DONE'))break;await pause(10);}
    const replies=f.db.prepare("SELECT body_json FROM messages WHERE thread_id=? AND author_type='agent'").all(victim.threadId) as Array<{body_json:string}>;
    const visibleLeak=replies.some(r=>r.body_json.includes('UNATTRIBUTED_VISIBLE_POISON'));
    f.save({knownDefectReproduced:visibleLeak,workerCrossThreadDeliveryProven:visibleLeak,missingIdentity:'threadId and turnId',tasks:[f.taskStatus(victim.taskId),f.taskStatus(source.taskId)]});
    expect(visibleLeak).toBe(true);
  }finally{await adapter.dispose();await worker.awaitInFlightTurns(3000);await f.close();vi.unstubAllEnvs();}
},10000);

it('a shared adapter subprocess crash is visible to every live session rather than one isolated task',async()=>{
  const adapter=makeAdapter();
  try{
    const a=await open(adapter,1),b=await open(adapter,2);
    const readExit=async(session:SessionRef)=>{for await(const event of adapter.events(session)){if(event.kind==='process.exited')return event;}throw Error('missing exit');};
    const exits=[readExit(a),readExit(b)];
    await adapter.startTurn(a,request(1));await adapter.startTurn(b,request(2,'crash-process'));
    const results=await Promise.all(exits);
    expect(results.every(e=>e.kind==='process.exited'&&e.exitCode===7)).toBe(true);
    writeFileSync(resolve('dist/r122-collisions/codex-shared-crash.json'),JSON.stringify({ok:true,sharedProcessFailureAffectedSessions:2,separateSessionsDoNotIsolateProcessFailure:true,realModelCalls:0}));
  }finally{await adapter.dispose();}
},10000);

it('records whether a malformed notification without thread identity is incorrectly attached to the first session',async()=>{
  const adapter=makeAdapter();
  try{
    const a=await open(adapter,1),b=await open(adapter,2),eventsA=readTurn(adapter,a),eventsB=readTurn(adapter,b);
    await Promise.all([adapter.startTurn(a,request(1)),adapter.startTurn(b,request(2,'inject-unattributed'))]);
    const [aEvents,bEvents]=await Promise.all([eventsA,eventsB]);
    const contaminated=aEvents.some(e=>e.kind==='turn.completed'&&e.finalText==='UNATTRIBUTED_POISON');
    // Characterize the current adapter flaw, without treating it as a product pass.
    expect(contaminated).toBe(true);
    expect(bEvents.find(e=>e.kind==='turn.completed'&&e.turnId!=null)).toMatchObject({turnId:'internal-2'});
    writeFileSync(resolve('dist/r122-collisions/codex-unattributed.json'),JSON.stringify({knownDefectReproduced:contaminated,rawSessionContamination:true,workerCrossThreadDeliveryProven:false,realModelCalls:0}));
  }finally{await adapter.dispose();}
},10000);
