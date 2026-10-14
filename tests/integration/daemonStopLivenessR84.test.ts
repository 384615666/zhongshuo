import {describe,it,expect} from 'vitest';
import {buildSync} from 'esbuild';
import {mkdtempSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';

/** A process boundary is essential: a Vitest parent keeps unref timers alive and
 * cannot expose the old exit-before-persistence defect. No model/process adapter
 * is invoked; the delay is an explicitly injected disposal failure fixture. */
describe('R84 daemon shutdown retains process liveness until durable completion',()=>{
  it.each([false,true])('unref disposal, forced=%s, persists an honest outcome before process exit',forced=>{
    const out=mkdtempSync(resolve('dist','r84-stop-liveness-')),helper=join(out,'child.ts'),entry=join(out,'child.cjs'),data=join(out,'data');
    const source=resolve('src').replaceAll('\\','/');
    writeFileSync(helper,`import {startDaemon} from '${source}/daemon/entry.ts';
import {FakeRuntimeAdapter} from '${source}/adapter/fake/runtimeAdapter.ts';
import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
(async()=>{process.env.ZS_ALLOW_FAKE='1';process.env.ZS_REAL_DISPATCH_GUARD='1';
class Delayed extends FakeRuntimeAdapter{async dispose(){await new Promise<void>(r=>{const timer=setTimeout(r,${forced?10000:180});timer.unref();});}}
const daemon=await startDaemon({appDataDir:${JSON.stringify(data)},runtime:'fake',testAdapter:new Delayed(),pipeName:'\\\\\\\\.\\\\pipe\\\\r84-liveness-'+randomUUID(),localUserId:'u_local',tickMs:10000,drainSettleTimeoutMs:${forced?30:2000}});
const first=await daemon.stop();const result=${forced?'await daemon.stop({force:true})':'first'};
writeFileSync(${JSON.stringify(join(out,'result.json'))},JSON.stringify({first,result}));console.log('DURABLE_STOP_RETURNED');})().catch(e=>{console.error(e);process.exitCode=1});`);
    buildSync({entryPoints:[helper],bundle:true,packages:'external',platform:'node',format:'cjs',outfile:entry,logLevel:'silent'});
    const env={...process.env};for(const key of Object.keys(env))if(key==='ELECTRON_RUN_AS_NODE'||key.startsWith('ZS_'))delete env[key];
    const child=spawnSync(process.execPath,[entry],{env,encoding:'utf8',timeout:10000});
    expect(child.status,child.stderr).toBe(0);expect(child.stdout).toContain('DURABLE_STOP_RETURNED');
    const fact=JSON.parse(readFileSync(join(out,'result.json'),'utf8')) as {result:{complete:boolean;phase:string;reason?:string}};
    const db=new Database(join(data,'state.sqlite'),{readonly:true});
    try{
      const stop=JSON.parse((db.prepare("SELECT value FROM daemon_state WHERE key='daemon:stop:last'").get() as {value:string}).value) as {phase:string};
      expect(fact.result.complete).toBe(!forced);expect(stop.phase).toBe(forced?'forced-incomplete':'closed');
      expect(existsSync(join(data,'locks','daemon.lock.d'))).toBe(forced);
      expect((db.prepare('SELECT count(*) n FROM real_calls').get() as {n:number}).n).toBe(0);
    }finally{db.close();}
  });
});
