/* global require, __dirname, process, WebSocket, console, Buffer, fetch, setTimeout */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS engineering screenshots */
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');
const repo=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]??'dist/desktop/review-r81-prototype-20261013');
const port=9792;
fs.mkdirSync(out,{recursive:true});
const entry=path.join(out,'entry.tsx'),html=path.join(out,'index.html'),host=path.join(out,'host.cjs');
// Density adjustment lives solely in the approved prototype's owned engineering host.
// No mock object or module is imported into the formal product or stored as a real template.
fs.writeFileSync(entry,`import ${JSON.stringify(path.join(repo,'hifi-prototype/src/main.tsx').replaceAll('\\','/'))};
import {getState,setState} from ${JSON.stringify(path.join(repo,'hifi-prototype/src/data/store.ts').replaceAll('\\','/'))};
setState(s=>({...s,ui:{...s.ui,theme:'light'},startupRecovery:{...s.startupRecovery,needsAttention:false},members:[...s.members,...Array.from({length:3},(_,n)=>({...s.members.find(m=>m.projectId==='proj_zs_01')!,id:'r81-prototype-density-'+n,displayName:'工程成员'+n,ordinal:undefined,workState:'idle',workStateReason:'仅原型密度夹具',isCoordinatorDefault:false,internalSubagents:false,effort:'medium'}))]}));
window.r81PrototypeDensity=()=>getState().members.filter(m=>m.projectId==='proj_zs_01').length;`);
require('esbuild').buildSync({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',jsx:'automatic',outfile:path.join(out,'app.mjs'),loader:{'.svg':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
fs.writeFileSync(html,'<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="app.mjs"></script></body></html>');
fs.writeFileSync(host,`const{app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(path.join(out,'profile'))});app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:960,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(path.join(repo,'hifi-prototype/electron/preload.cjs'))}}});ipcMain.handle('zs:window-state',()=>({maximized:false,focused:true,fullScreen:false}));ipcMain.handle('zs:report-runtime',()=>({ok:true}));ipcMain.handle('zs:app-data-dir',()=>${JSON.stringify(path.join(out,'profile'))});ipcMain.handle('zs:window-show',()=>{w.show();return{ok:true};});w.on('closed',()=>app.quit());w.loadFile(${JSON.stringify(html)},{hash:'/project/proj_zs_01/members?recovery=0'});});`);
(async()=>{
  const probe=require('node:net').createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(port,'127.0.0.1',r);});await new Promise(r=>probe.close(r));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const proc=spawn(path.join(repo,'node_modules/electron/dist/electron.exe'),[host,`--remote-debugging-port=${port}`],{env,windowsHide:true,stdio:'ignore'});
  let c=null;const facts={pass:false,prototype:'hifi-prototype/src/pages/pages-misc.tsx',density:'six members; three extra copies only in prototype engineering memory',viewports:[]};
  try{
    c=await until(async()=>{try{const rows=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());const t=rows.find(t=>t.type==='page');if(!t)return null;const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));return new Cdp(ws);}catch{return null;}},Boolean,'owned prototype window',30000);
    await c.send('Runtime.enable');await until(()=>c.eval(`document.querySelector('.page-filters')!=null`),Boolean,'prototype ready');
    const shot=async name=>{await new Promise(r=>setTimeout(r,400));const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
    for(const v of [{name:'wide',width:1440,height:960,dpr:1},{name:'narrow',width:900,height:800,dpr:1},{name:'hidpi',width:1280,height:800,dpr:1.5}]){
      await c.send('Emulation.setDeviceMetricsOverride',{width:v.width,height:v.height,deviceScaleFactor:v.dpr,mobile:false});
      await c.eval(`location.hash='/project/proj_zs_01/members?recovery=0';true`);await until(()=>c.eval(`document.querySelector('.page-filters')!=null`),Boolean,'prototype member list');await shot(`members-${v.name}`);
      await c.eval(`location.hash='/member/member_codex?recovery=0';true`);await until(()=>c.eval(`document.querySelector('.page-title')?.textContent.includes('Codex')`),Boolean,'prototype member detail');await shot(`detail-${v.name}`);
      await c.eval(`location.hash='/project/proj_zs_01/members?recovery=0';true`);await until(()=>c.eval(`document.querySelector('.page-filters')!=null`),Boolean,'prototype create entry');await c.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('添加成员'))?.click();true`);await until(()=>c.eval(`document.querySelector('.modal')!=null`),Boolean,'prototype create');await shot(`create-${v.name}`);await c.eval(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='取消')?.click();true`);
      facts.viewports.push(v);
    }
    facts.count=await c.eval(`window.r81PrototypeDensity()`);facts.errors=c.errors;facts.pass=facts.count===6&&facts.errors.length===0;
  }catch(e){facts.error=e.stack;}
  finally{if(c){await c.eval('window.close();true').catch(()=>{});c.ws.close();}await until(async()=>proc.exitCode!=null,Boolean,'owned prototype close',15000);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(facts,null,2));console.log(JSON.stringify(facts));}
  process.exitCode=facts.pass?0:1;
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
