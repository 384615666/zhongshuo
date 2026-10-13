/** Zero calls: inspect the actual compiled factory's input, never probe/open a session/start a turn. */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dispatchDaemonCommand } from '../src/daemon/commands.ts';
import type { RunningDaemon } from '../src/daemon/entry.ts';

const packageRoot=resolve(process.argv[2]!);
const out=resolve(process.argv[3]!);mkdirSync(out,{recursive:true});
const require=createRequire(import.meta.url);delete process.env.ZS_PACKED_ENTRY;
process.env.ZS_ALLOW_FAKE='1';delete process.env.ZS_REAL_DISPATCH_GUARD;
const packed=require(join(packageRoot,'resources/app/daemon/daemon.cjs')) as {startDaemon:(o:unknown)=>Promise<RunningDaemon>};
const runtime=await packed.startDaemon({appDataDir:join(out,'data'),runtime:'fake',localUserId:'u_local',pipeName:String.raw`\\.\pipe\r81-ref-${randomUUID()}`,tickMs:10000});
const cmd=async(method:string,params:unknown)=>{const r=await dispatchDaemonCommand({db:runtime.db,localUserId:'u_local',interruptTurn:async()=>{}},{protocolVersion:1,commandId:`r81-ref-${randomUUID()}`,method,params}) as {ok:boolean;data?:{project?:{id:string};memberId?:string};error?:{message:string}};if(!r.ok)throw Error(r.error?.message);return r.data!;};
let facts:Record<string,unknown>={pass:false,scope:'actual compiled factory metadata only; zero CLI process/probe/session/turn'};
try{
  const cwd=join(out,'project');mkdirSync(cwd);const p=(await cmd('project.open',{path:cwd})).project!.id;
  const memberId=(await cmd('member.create',{projectId:p,displayName:'程序引用反例'})).memberId!;const executable=join(out,'missing-codex.exe');
  await cmd('member.setRuntime',{memberId,kind:'codex',model:'gpt-6-luna',executable,permissionMode:'plan'});
  const actual=runtime.memberRuntime.adapterFor(memberId) as unknown as {options:{executable?:string;codexCmdPath?:string;model?:string;sandboxMode?:string}};
  const passed=actual.options.executable??actual.options.codexCmdPath??null;
  const calls=(runtime.db.prepare('SELECT count(*) c FROM real_calls').get() as {c:number}).c;
  facts={...facts,memberId,modelId:actual.options.model,boundExecutable:executable,factoryExecutable:passed,ignoredReference:passed!==executable,sandbox:actual.options.sandboxMode,realCalls:calls,pass:passed===executable&&calls===0};
}finally{facts.stop=await runtime.stop();writeFileSync(join(out,'result.json'),JSON.stringify(facts,null,2));console.log(JSON.stringify(facts));}
