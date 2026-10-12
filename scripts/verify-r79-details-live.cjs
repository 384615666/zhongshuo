#!/usr/bin/env node
/** Real titlebar React component, controlled project summary replies, isolated Electron. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, __dirname, WebSocket, fetch, AbortSignal, setTimeout, clearTimeout */
const { spawn, spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { buildSync } = require('esbuild');
const repo = resolve(__dirname, '..');
const out = resolve(process.argv[2] ?? join(repo, 'dist', `r79-details-live-${Date.now()}`));
if (existsSync(out)) throw new Error(`output exists: ${out}`);
mkdirSync(out, { recursive: true });
const port = 9791;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (read, predicate, label, ms = 12000) => { const end = Date.now() + ms; let value; while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await sleep(60); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{useTaskDetails,RunExtraFacts,DetailReadState}from'${join(repo, 'src/ui/hifi/components/TaskDetailsFacts.tsx').replaceAll('\\', '/')}';
const requests=[];const timers=new Set();const originalSet=window.setInterval.bind(window),originalClear=window.clearInterval.bind(window);window.setInterval=(fn,ms)=>{const id=originalSet(fn,ms);timers.add(id);return id;};window.clearInterval=(id)=>{timers.delete(id);return originalClear(id);};window.zs={command:(env)=>new Promise(resolve=>requests.push({env,resolve}))};let change;let visible='visible';Object.defineProperty(document,'visibilityState',{get:()=>visible,configurable:true});
function App(){const [scope,setScope]=React.useState({project:'pA',task:'tA',run:'rA'});change=setScope;const d=useTaskDetails(scope.project,scope.task,1,scope.run,'RUNNING');window.current=d;return <><DetailReadState {...d}/>{d.data?<RunExtraFacts detail={d.data} onSelectRun={d.selectRun}/>:null}</>};const root=createRoot(document.getElementById('root'));root.render(<App/>);
window.r78={calls:()=>requests.map((r,i)=>({i,method:r.env.method,params:r.env.params})),reply:(i,count=0)=>{const q=requests[i].env.params;if(requests[i].env.method==='task.history'){requests[i].resolve({ok:true,data:{kind:q.kind,items:[{id:'rHistory',mode:'DIRECT',status:'FAILED',events:[],turns:[]}],nextCursor:null}});return;}const id=q.runId||'rNew';requests[i].resolve({ok:true,data:{task:{id:q.taskId,projectId:q.projectId,status:'ACTIVE'},failedRetry:{},latestRunId:'rNew',selectedRunId:id,runs:[{id,status:'RUNNING',mode:'DIRECT',turns:count?[{id:'turn',displayName:'成员',usage:[{normalized:{accounting:'cumulative',inputTokens:321},quality:'unknown'}]}]:[],events:count?[{seq:1,kind:'tool.started',summary:'LIVE_PROGRESS_MARKER'}]:[]}],truncated:{},nextCursors:{runs:'runs-cursor'}}})},fail:(i)=>requests[i].resolve({ok:false,error:{code:'READ_FAIL',message:'CONTROLLED_FAIL'}}),focus:(project,task,run)=>change({project,task,run}),hide:()=>{visible='hidden';document.dispatchEvent(new Event('visibilitychange'))},show:()=>{visible='visible';document.dispatchEvent(new Event('visibilitychange'))},view:()=>({text:document.getElementById('root').textContent,updatedAt:window.current.updatedAt,selected:window.current.data?.selectedRunId,timers:timers.size}),select:(id)=>window.current.selectRun(id),refresh:()=>window.current.refresh(),history:()=>document.querySelector('[data-zs-history=runs] button')?.click(),legacy:(on)=>document.body.classList.toggle('legacy-on',on),unmount:()=>root.unmount()};`;
writeFileSync(join(out, 'entry.tsx'), entry);
buildSync({ entryPoints: [join(out, 'entry.tsx')], outfile: join(out, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
writeFileSync(join(out, 'index.html'), '<!doctype html><div id="root"></div><script>window.addEventListener("error",e=>document.body.dataset.error=e.message+" "+e.filename+":"+e.lineno)</script><script src="bundle.js"></script>');
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'r79-details-live', version: '0.0.0', main: 'main.cjs' }));
writeFileSync(join(out, 'main.cjs'), `const{app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'user-data'));app.whenReady().then(()=>{const w=new BrowserWindow({width:900,height:500,webPreferences:{nodeIntegration:false,contextIsolation:true}});w.loadFile(path.join(__dirname,'index.html'));});app.on('window-all-closed',()=>app.quit());`);
class Cdp { constructor(ws) { this.ws=ws;this.id=0;this.waits=new Map();ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);const p=this.waits.get(m.id);if(!p)return;this.waits.delete(m.id);clearTimeout(p.t);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}); } send(method,params={}) { return new Promise((resolveSend,reject)=>{const id=++this.id;const t=setTimeout(()=>reject(new Error(method+' timeout')),15000);this.waits.set(id,{resolve:resolveSend,reject,t});this.ws.send(JSON.stringify({id,method,params}));}); } async eval(expression) { const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value; } }
function killOwn() { const marker=out.replaceAll("'","''");spawnSync('powershell',['-NoProfile','-Command',`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') -and $_.Name -eq 'electron.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],{windowsHide:true,stdio:'ignore'}); }
async function main() {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(join(repo,'node_modules/electron/dist/electron.exe'),[out,`--remote-debugging-port=${port}`],{cwd:out,env,windowsHide:true,stdio:'ignore'});
  const result={pass:false,assertions:{},errors:[]};let cdp;
  try {
    const page=await until(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json())).find(x=>x.type==='page'&&x.url.includes('index.html'));}catch{return null;}},Boolean,'CDP',25000);
    const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true});});cdp=new Cdp(ws);
    await until(()=>cdp.eval('typeof window.r78 === "object" ? true : document.body?.dataset.error || false'),Boolean,'harness');
    result.heapBefore=await cdp.send('Runtime.getHeapUsage');const boot=await cdp.eval('document.body.dataset.error || null');if(boot)throw new Error(boot);
    const calls=()=>cdp.eval('window.r78.calls()');const view=()=>cdp.eval('window.r78.view()');const act=(expr)=>cdp.eval(`window.r78.${expr};true`);
    let rows=await until(calls,x=>x.length===1,'initial');await act('reply(0,0)');await until(view,x=>x.text.includes('没有工具'),'initial empty');
    let last=0;
    for(let cycle=0;cycle<3;cycle++){rows=await until(calls,x=>x.length>last+1,'unchanged RUNNING refresh',7500);last=rows.at(-1).i;await act(`reply(${last},1)`);await until(view,x=>x.text.includes('LIVE_PROGRESS_MARKER')&&x.text.includes('输入 321'),'automatic tool and usage');if(cycle===0)await cdp.eval("document.querySelector('details').open=true");else result.assertions.expansionPreserved=await cdp.eval("document.querySelector('details').open===true");}
    result.assertions.threeUnchangedRunningCycles=(await calls()).length===4;
    await act('refresh()');rows=await until(calls,x=>x.length===5,'slow read');await act('refresh();window.r78.refresh()');await sleep(5300);result.assertions.slowReadSingleFlight=(await calls()).length===5;
    await act('fail(4)');rows=await until(calls,x=>x.length===6,'coalesced manual');result.assertions.failureKeepsSnapshot=(await view()).text.includes('LIVE_PROGRESS_MARKER')&&(await view()).text.includes('CONTROLLED_FAIL');await act('reply(5,1)');await until(view,x=>!x.text.includes('CONTROLLED_FAIL'),'recovery');result.assertions.updatedTime=Boolean((await view()).updatedAt);
    await act("select('rOld')");rows=await until(calls,x=>x.length===7,'history select');await act('reply(6,1)');await act("focus('pA','tA','rNewer')");await sleep(100);result.assertions.newRunDoesNotChangeSelection=(await view()).selected==='rOld'&&(await calls()).length===7;
    await act('hide()');await sleep(5500);result.assertions.hiddenPauses=(await calls()).length===7;await act('show()');rows=await until(calls,x=>x.length===8,'visible catchup');
    await act("focus('pB','tB','rB')");rows=await until(calls,x=>x.length===9,'target B');await act('reply(8,0)');await act('reply(7,1)');await sleep(100);result.assertions.lateAIsIgnored=!(await view()).text.includes('LIVE_PROGRESS_MARKER')&&(await view()).selected==='rB';
    await act('refresh()');await until(calls,x=>x.length===10,'B pending before ABA');await act("focus('pA','tA','rOld')");await until(calls,x=>x.length===11,'A pending');await act("focus('pB','tB','rB')");await sleep(100);result.assertions.abaJoinsPendingTransport=(await calls()).length===11;await act('reply(10,1)');await act('reply(9,0)');await until(view,x=>x.selected==='rB','ABA B convergence');
    await act('history()');await until(calls,x=>x.length===12,'history real control');await act('reply(11)');await until(view,x=>x.text.includes('已到历史起点'),'history page');result.assertions.historyPageReachable=(await calls()).at(-1).method==='task.history';
    await act('legacy(true)');await sleep(5500);result.assertions.takeoverPauses=(await calls()).length===12;await act('legacy(false)');await until(calls,x=>x.length===13,'takeover return');await act('unmount()');await act('reply(12,1)');await sleep(5400);result.assertions.unmountedPauses=(await calls()).length===13&&(await view()).text==='';
    result.heapAfter=await cdp.send('Runtime.getHeapUsage');result.assertions.noTimerAfterUnmount=(await view()).timers===0;result.pass=Object.values(result.assertions).every(Boolean);
  }catch(e){result.errors.push(e instanceof Error?e.stack??e.message:String(e));}
  finally{if(cdp)await Promise.race([cdp.eval('window.close();true').catch(()=>{}),sleep(2000)]);killOwn();child.kill();}
  writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output:out,...result}));if(!result.pass)process.exitCode=1;
}
void main();

