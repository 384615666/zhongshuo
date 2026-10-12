#!/usr/bin/env node
/** Real titlebar React component, controlled project summary replies, isolated Electron. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, __dirname, WebSocket, fetch, AbortSignal, setTimeout, clearTimeout */
const { spawn, spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { buildSync } = require('esbuild');
const repo = resolve(__dirname, '..');
const out = resolve(process.argv[2] ?? join(repo, 'dist', `r78-titlebar-summary-${Date.now()}`));
if (existsSync(out)) throw new Error(`output exists: ${out}`);
mkdirSync(out, { recursive: true });
const port = 9789;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (read, predicate, label, ms = 12000) => { const end = Date.now() + ms; let value; while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await sleep(60); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{TitleBarStatButton}from'${join(repo, 'src/ui/hifi/components/TitleBar.tsx').replaceAll('\\', '/')}';import{setState}from'${join(repo, 'src/ui/hifi/data/store.ts').replaceAll('\\', '/')}';
const requests=[];window.zs={command:(env)=>new Promise(resolve=>requests.push({env,resolve}))};setState(s=>({...s,activeProjectId:'pA',projects:[{id:'pA',displayName:'项目A'},{id:'pB',displayName:'项目B'}],tasks:[],turns:[]}));const root=createRoot(document.getElementById('root'));root.render(<TitleBarStatButton/>);window.r78={calls:()=>requests.map((r,i)=>({i,method:r.env.method,params:r.env.params})),reply:(i,data)=>requests[i].resolve({ok:true,data}),fail:(i)=>requests[i].resolve({ok:false,error:{code:'READ_FAIL',message:'CONTROLLED_FAIL'}}),focus:(id)=>setState(s=>({...s,activeProjectId:id})),view:()=>({text:document.getElementById('root').textContent,title:document.querySelector('button')?.title,tasks:document.querySelector('button')?.dataset.zsRunningTasks,turns:document.querySelector('button')?.dataset.zsRunningTurns}),unmount:()=>root.unmount()};`;
writeFileSync(join(out, 'entry.tsx'), entry);
buildSync({ entryPoints: [join(out, 'entry.tsx')], outfile: join(out, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
writeFileSync(join(out, 'index.html'), '<!doctype html><div id="root"></div><script>window.addEventListener("error",e=>document.body.dataset.error=e.message+" "+e.filename+":"+e.lineno)</script><script src="bundle.js"></script>');
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'r78-titlebar-summary', version: '0.0.0', main: 'main.cjs' }));
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
    await until(()=>cdp.eval('typeof window.r78 === "object" ? true : document.body.dataset.error || false'),Boolean,'harness');
    const boot=await cdp.eval('document.body.dataset.error || null');if(boot)throw new Error(boot);
    const calls=()=>cdp.eval('window.r78.calls()');const view=()=>cdp.eval('window.r78.view()');const act=(expr)=>cdp.eval(`window.r78.${expr};true`);
    const first=await until(calls,x=>x.some(c=>c.method==='project.taskSummary'),'first read');
    result.assertions.unknownNotZero=(await view()).tasks===undefined&&(await view()).text.includes('—');
    await act("focus('pB')");const second=await until(calls,x=>x.some(c=>c.params.projectId==='pB'),'scope B');
    result.assertions.oldScopeHidden=(await view()).tasks===undefined;
    await act(`reply(${first[0].i},{projectId:'pA',unfinishedTasks:99,activeTurns:99})`);
    await sleep(100);result.assertions.lateOldScopeIgnored=(await view()).tasks===undefined;
    const b=second.find(c=>c.params.projectId==='pB');await sleep(5300);
    result.assertions.inFlightPollMerged=(await calls()).filter(c=>c.params.projectId==='pB').length===1;
    await act(`reply(${b.i},{projectId:'pB',unfinishedTasks:4,activeTurns:2})`);
    await until(view,x=>x.tasks==='4'&&x.turns==='2','B facts');
    const poll=await until(calls,x=>x.some(c=>c.i>b.i&&c.params.projectId==='pB'),'visible poll',8000);const p=poll.find(c=>c.i>b.i);
    await act(`fail(${p.i})`);await until(view,x=>x.text.includes('读取失败'),'read failure');
    result.assertions.failureKeepsFacts=(await view()).tasks==='4';
    const recovery=await until(calls,x=>x.some(c=>c.i>p.i&&c.params.projectId==='pB'),'recovery poll',8000);const r=recovery.find(c=>c.i>p.i);
    await act(`reply(${r.i},{projectId:'pB',unfinishedTasks:3,activeTurns:1})`);await until(view,x=>x.tasks==='3'&&!x.text.includes('读取失败'),'recovery');
    result.assertions.successClearsFailure=(await view()).turns==='1';
    await act('unmount()');result.pass=Object.values(result.assertions).every(Boolean);
  }catch(e){result.errors.push(e instanceof Error?e.stack??e.message:String(e));}
  finally{if(cdp)await Promise.race([cdp.eval('window.close();true').catch(()=>{}),sleep(2000)]);killOwn();child.kill();}
  writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output:out,...result}));if(!result.pass)process.exitCode=1;
}
void main();
