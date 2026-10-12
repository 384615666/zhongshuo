#!/usr/bin/env node
/** Real titlebar React component, controlled project summary replies, isolated Electron. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, __dirname, WebSocket, fetch, AbortSignal, setTimeout, clearTimeout */
const { spawn, spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { buildSync } = require('esbuild');
const repo = resolve(__dirname, '..');
const out = resolve(process.argv[2] ?? join(repo, 'dist', `r79-member-workload-${Date.now()}`));
if (existsSync(out)) throw new Error(`output exists: ${out}`);
mkdirSync(out, { recursive: true });
const port = 9792;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (read, predicate, label, ms = 12000) => { const end = Date.now() + ms; let value; while (Date.now() < end) { value = await read(); if (predicate(value)) return value; await sleep(60); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{MembersPage}from'${join(repo,'src/ui/hifi/MembersPage.tsx').replaceAll('\\','/')}';import{setState}from'${join(repo,'src/ui/hifi/data/store.ts').replaceAll('\\','/')}';let count=1;let fail=false;const calls=[];window.zs={command:async(env)=>{calls.push(env);if(env.method==='member.list')return{ok:true,data:{items:[{id:'mA',displayName:'执行甲',principalType:'agent',enabled:true}]}};if(env.method==='member.runtimes')return{ok:true,data:{projectId:'pA',items:[{memberId:'mA',info:{}}]}};if(env.method==='project.memberWorkload')return fail?{ok:false,error:{code:'READ_FAIL',message:'CONTROLLED_FAIL'}}:{ok:true,data:{projectId:'pA',items:[{memberId:'mA',unfinishedTasks:count,activeTurns:count,unknownTurns:0}],truncated:false}};return{ok:true,data:{}}}};setState(s=>({...s,activeProjectId:'pA',projects:[{id:'pA',displayName:'项目A'}],rooms:[],tasks:[],turns:[]}));createRoot(document.getElementById('root')).render(<MembersPage/>);window.r78={view:()=>({text:document.getElementById('root').textContent,calls:calls.filter(x=>x.method==='project.memberWorkload').length}),update:(n,error)=>{count=n;fail=error}};`;
writeFileSync(join(out, 'entry.tsx'), entry);
buildSync({ entryPoints: [join(out, 'entry.tsx')], outfile: join(out, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic' });
writeFileSync(join(out, 'index.html'), '<!doctype html><div id="root"></div><script>window.addEventListener("error",e=>document.body.dataset.error=e.message+" "+e.filename+":"+e.lineno)</script><script src="bundle.js"></script>');
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'r79-member-workload', version: '0.0.0', main: 'main.cjs' }));
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
    const boot=await cdp.eval('document.body.dataset.error || null');if(boot)throw new Error(boot);
    const view=()=>cdp.eval('window.r78.view()');await until(view,x=>x.text.includes('执行甲'),'member loaded');
    result.scope='controlled authority reports 1 owner task and 1 active turn; local task/turn store deliberately empty';
    result.initial=await view();result.assertions.coldAuthorityUsed=result.initial.text.includes('负责未结束任务 1')&&!result.initial.text.includes('当前没有负责');
    if(result.assertions.coldAuthorityUsed){await cdp.eval('window.r78.update(2,false)');await until(view,x=>x.text.includes('负责未结束任务 2'),'live member facts',7500);result.assertions.liveUpdates=true;await cdp.eval('window.r78.update(0,true)');await until(view,x=>x.text.includes('CONTROLLED_FAIL'),'member failure',7500);result.assertions.failureKeepsFacts=(await view()).text.includes('负责未结束任务 2');await cdp.eval('window.r78.update(0,false)');await until(view,x=>x.text.includes('负责未结束任务 0')&&!x.text.includes('CONTROLLED_FAIL'),'authoritative empty',7500);result.assertions.authoritativeZero=true;}
    result.final=await view();result.pass=Object.values(result.assertions).every(Boolean);
  }catch(e){result.errors.push(e instanceof Error?e.stack??e.message:String(e));}
  finally{if(cdp)await Promise.race([cdp.eval('window.close();true').catch(()=>{}),sleep(2000)]);killOwn();child.kill();}
  writeFileSync(join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({output:out,...result}));if(!result.pass)process.exitCode=1;
}
void main();
