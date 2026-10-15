/* global require,process,fetch,WebSocket,console */
/* eslint-disable @typescript-eslint/no-require-imports -- closes only a verified owned engineering copy */
const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3'),{randomUUID}=require('node:crypto');
const{Cdp,until}=require('./verify-r81-members-launcher.cjs');const root=path.resolve(process.argv[2]??'');
if(!path.basename(root).startsWith('review-r84-'))throw Error('explicit owned R84 root required');
const main=JSON.parse(fs.readFileSync(path.join(root,'progress.json'))),file=path.join(root,'final-close.json');if(fs.existsSync(file))throw Error('original close receipt exists');
const result={pass:false,build:main.build,scope:'normal close of exact owned engineering copy after completed original calls; no new inference, replay, acceptance or reconciliation'};let c;
const must=(ok,s)=>{if(!ok)throw Error(s);};
function read(fn){const d=new Database(path.join(main.dataRoot,'state.sqlite'),{readonly:true});try{return fn(d);}finally{d.close();}}
(async()=>{
 const before=read(d=>({calls:d.prepare('SELECT count(*) n FROM real_calls').get().n,inflight:d.prepare("SELECT count(*) n FROM real_calls WHERE status='inflight'").get().n,activeTurns:d.prepare("SELECT count(*) n FROM agent_turns WHERE status IN ('RUNNING','QUEUED','STARTING')").get().n}));must(before.inflight===0&&before.activeTurns===0,'original call still active');
 const page=(await fetch(`http://127.0.0.1:${main.port}/json/list`).then(r=>r.json())).find(p=>p.type==='page'&&p.url.includes('index.html'));must(page,'owned window missing');const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});c=new Cdp(ws);
 const identity=await c.eval(`window.zs.command(${JSON.stringify({protocolVersion:1,commandId:randomUUID(),method:'app.identity',params:{}})})`);must(identity.ok&&path.resolve(identity.data.appDataDir)===path.resolve(main.dataRoot),'wrong data root');
 const pid=Number(fs.readFileSync(path.join(main.dataRoot,'daemon.pid'),'utf8').trim());must(Number.isSafeInteger(pid)&&pid>0,'invalid original daemon PID');result.closeAt=Date.now();result.originalDaemonPid=pid;result.callsBefore=before.calls;
 await c.eval('window.close();true').catch(()=>{});c.ws.close();c=null;await until(()=>!fs.existsSync(path.join(main.dataRoot,'daemon.pid')),Boolean,'final durable PID cleanup',45000);
 const after=read(d=>({calls:d.prepare('SELECT count(*) n FROM real_calls').get().n,stop:d.prepare("SELECT value FROM daemon_state WHERE key='daemon:stop:last'").get()}));const stop=JSON.parse(after.stop?.value??'null');must(stop?.pid===pid&&stop.at>=result.closeAt&&stop.phase==='closed','new durable stop record missing or mismatched');must(after.calls===before.calls,'closing created a model call');result.stop=stop;result.callsAfter=after.calls;result.pidMarkerRemoved=true;result.pass=true;
})().catch(e=>{result.error=e.stack;process.exitCode=1}).finally(()=>{c?.ws.close();fs.writeFileSync(file,JSON.stringify(result,null,2));console.log(JSON.stringify({pass:result.pass,error:result.error,originalDaemonPid:result.originalDaemonPid,callsBefore:result.callsBefore,callsAfter:result.callsAfter}));});
