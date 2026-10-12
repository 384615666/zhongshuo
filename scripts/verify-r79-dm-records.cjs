#!/usr/bin/env node
/** Real titlebar React component, controlled project summary replies, isolated Electron. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, __dirname, WebSocket, fetch, AbortSignal, setTimeout, clearTimeout */
const { spawn, spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { buildSync } = require('esbuild');
const repo = resolve(__dirname, '..');
const out = resolve(process.argv[2] ?? join(repo, 'dist', `r79-dm-records-${Date.now()}`));
if (existsSync(out)) throw new Error(`output exists: ${out}`);
mkdirSync(out, { recursive: true });
const port = 9793;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (read, predicate, label, ms = 12000) => { const end = Date.now() + ms; let value; while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await sleep(60); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{DmTaskRecords}from'${join(repo,'src/ui/hifi/components/DmTaskRecords.tsx').replaceAll('\\','/')}';
const requests=[];let focus;let close;const timers=new Set();const origSet=window.setInterval.bind(window),origClear=window.clearInterval.bind(window);window.setInterval=(fn,ms)=>{const id=origSet(fn,ms);timers.add(id);return id};window.clearInterval=id=>{timers.delete(id);return origClear(id)};window.zs={command:env=>new Promise(resolve=>requests.push({env,resolve}))};
function App(){const [c,setC]=React.useState('A'),[open,setOpen]=React.useState(true);focus=setC;close=()=>setOpen(false);return open?<DmTaskRecords projectId='p' conversationId={c} onClose={close}/>:null};const root=createRoot(document.getElementById('root'));root.render(<App/>);
window.r78={calls:()=>requests.map((r,i)=>({i,method:r.env.method,params:r.env.params})),reply:(i,older=false)=>{const e=requests[i].env,q=e.params;if(e.method==='conversation.tasks'){requests[i].resolve({ok:true,data:{conversationId:q.conversationId,items:[{id:older?'older-'+q.conversationId:'t'+q.conversationId,title:older?'更早任务'+q.conversationId:'任务'+q.conversationId,status:'ACTIVE',revision:1,latestRun:{id:'run-'+q.conversationId,status:'RUNNING'}}],nextCursor:older?null:'cursor-'+q.conversationId}});return;}requests[i].resolve({ok:true,data:{task:{id:q.taskId,projectId:'p',conversationId:q.conversationId,title:'已读取详情'+q.conversationId,status:'ACTIVE'},failedRetry:{},latestRunId:'run-'+q.conversationId,selectedRunId:q.runId||'run-'+q.conversationId,runs:[{id:q.runId||'run-'+q.conversationId,status:'RUNNING',mode:'DIRECT',budget:null,turns:[],events:[]}],children:[],events:[],deliveries:[],artifacts:[],changeSets:[],truncated:{}}})},fail:i=>requests[i].resolve({ok:false,error:{code:'READ_FAIL',message:'CONTROLLED_FAIL'}}),focus:c=>focus(c),click:text=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===text&&!x.disabled);if(b)b.click();return Boolean(b)},view:()=>({text:document.body.innerText,timers:timers.size}),close:()=>close(),unmount:()=>root.unmount()};`;
writeFileSync(join(out, 'entry.tsx'), entry);
buildSync({ entryPoints: [join(out, 'entry.tsx')], outfile: join(out, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
writeFileSync(join(out, 'index.html'), '<!doctype html><div id="root"></div><script>window.addEventListener("error",e=>document.body.dataset.error=e.message+" "+e.filename+":"+e.lineno)</script><script src="bundle.js"></script>');
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'r79-dm-records', version: '0.0.0', main: 'main.cjs' }));
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
    const calls=()=>cdp.eval('window.r78.calls()'),view=()=>cdp.eval('window.r78.view()'),act=expr=>cdp.eval(`window.r78.${expr};true`);
    await until(calls,x=>x.length===1,'DM head');await sleep(5300);result.assertions.slowListSingleFlight=(await calls()).filter(x=>x.method==='conversation.tasks').length===1;
    await act('reply(0)');let rows=await until(calls,x=>x.some(c=>c.method==='task.details'),'detail');let d=rows.find(c=>c.method==='task.details');await act(`reply(${d.i})`);await until(view,x=>x.text.includes('已读取详情A'),'DM details');result.assertions.detailClaimsConversation=d.params.conversationId==='A';
    await act("click('加载更早任务')");rows=await until(calls,x=>x.some(c=>c.params.beforeTaskId==='cursor-A'),'older task page');const older=rows.find(c=>c.params.beforeTaskId==='cursor-A');await act(`reply(${older.i},true)`);await until(view,x=>x.text.includes('返回最近任务'),'older task controls');result.assertions.selectionPreserved=(await view()).text.includes('已读取详情A');
    const count=(await calls()).length;await act("click('返回最近任务')");rows=await until(calls,x=>x.length>count&&x.some(c=>c.i>=count&&c.method==='conversation.tasks'),'return latest');const head=rows.find(c=>c.i>=count&&c.method==='conversation.tasks');result.assertions.returnLatestHasNoCursor=head.params.beforeTaskId===undefined;
    await act("focus('B')");rows=await until(calls,x=>x.some(c=>c.method==='conversation.tasks'&&c.params.conversationId==='B'),'B head');const b=rows.find(c=>c.method==='conversation.tasks'&&c.params.conversationId==='B');result.assertions.oldDetailsHidden=!(await view()).text.includes('已读取详情A');await act(`reply(${head.i})`);await act(`reply(${b.i})`);
    rows=await until(calls,x=>x.some(c=>c.method==='task.details'&&c.params.conversationId==='B'),'B detail');const bd=rows.find(c=>c.method==='task.details'&&c.params.conversationId==='B');await act(`reply(${bd.i})`);await until(view,x=>x.text.includes('已读取详情B'),'B detail ready');result.assertions.lateAIsIgnored=!(await view()).text.includes('已读取详情A');
    const n=(await calls()).length;await act("click('刷新任务列表')");rows=await until(calls,x=>x.length>n&&x.some(c=>c.i>=n&&c.method==='conversation.tasks'),'B manual');const failed=rows.find(c=>c.i>=n&&c.method==='conversation.tasks');await act(`fail(${failed.i})`);await until(view,x=>x.text.includes('CONTROLLED_FAIL'),'B list fail');result.assertions.failureRetainsTask=(await view()).text.includes('已读取详情B');
    await act('close()');const afterClose=(await calls()).length;await sleep(5400);result.assertions.closePauses=(await calls()).length===afterClose&&(await view()).timers===0;
    result.pass=Object.values(result.assertions).every(Boolean);
  }catch(e){result.errors.push(e instanceof Error?e.stack??e.message:String(e));}
  finally{if(cdp)await Promise.race([cdp.eval('window.close();true').catch(()=>{}),sleep(2000)]);killOwn();child.kill();}
  writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output:out,...result}));if(!result.pass)process.exitCode=1;
}
void main();


