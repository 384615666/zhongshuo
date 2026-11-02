/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const renderer = String.raw`
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ProjectWriteConcurrencyPanel} from '../../../src/ui/hifi/pages/ProjectSettingsPage.tsx';
const facts = {a:{projectId:'a',revision:0,override:null,effectivePolicy:'session_scope'},b:{projectId:'b',revision:0,override:'single_writer',effectivePolicy:'single_writer'}};
const receipts = new Map(), calls=[];
let behavior='normal', switchProject;
window.zs={command:async e=>{
 calls.push(JSON.parse(JSON.stringify(e)));
 if(e.method==='project.writeConcurrency.get')return {ok:true,data:{...facts[e.params.projectId]}};
 if(e.method==='project.list')return {ok:true,data:{items:[]}};
 if(e.method==='project.writeConcurrency.set'){
  if(receipts.has(e.commandId))return receipts.get(e.commandId);
  const current=facts[e.params.projectId];
  if(behavior==='stale'){behavior='normal';current.revision++;return {ok:false,error:{code:'STALE_REVISION',message:'设置已变化，请重新读取'}};}
  if(e.params.expectedRevision!==current.revision)return {ok:false,error:{code:'STALE_REVISION',message:'设置已变化'}};
  Object.assign(current,{revision:current.revision+1,override:e.params.override,effectivePolicy:e.params.override??'session_scope'});
  const reply={ok:true,data:{...current}};receipts.set(e.commandId,reply);
  if(behavior==='unknown'){behavior='normal';throw Error('合成连接中断');}
  if(behavior==='slow'){behavior='normal';await new Promise(r=>setTimeout(r,300));}
  return reply;
 }
 return {ok:false,error:{code:'SYNTHETIC_ONLY',message:'没有连接真实后台'}};
},onDisconnect(){},onReconnected(){}};
function Harness(){const [id,setId]=useState('a');switchProject=setId;return <div className="hifi-root" style={{padding:32}}><div className="card" style={{maxWidth:1100}}><h2>文件修改 · {id}</h2><ProjectWriteConcurrencyPanel key={id} projectId={id}/></div></div>;}
createRoot(document.getElementById('root')).render(<Harness/>);
window.fixture={calls,receipts,facts,behavior:value=>{behavior=value;},switchProject:id=>switchProject(id),select:value=>{const e=document.querySelector('select');e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));},button:text=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text))?.click()};
`;

async function runVerifier() {
  const out=path.join(root,'dist/r152-write-ui',`${Date.now()}-${process.pid}`);
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'entry.tsx'),renderer);
  await require('esbuild').build({entryPoints:[path.join(out,'entry.tsx')],outfile:path.join(out,'ui.js'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',loader:{'.png':'dataurl'},logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
  fs.writeFileSync(path.join(out,'app.css'),['tokens.css','base.css','components.css','h1-overrides.css'].map(f=>fs.readFileSync(path.join(root,'src/ui/hifi/styles',f),'utf8')).join('\n'));
  fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div id="root"></div><script type="module" src="ui.js"></script>');
  fs.writeFileSync(path.join(out,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
const checks=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
app.whenReady().then(async()=>{
 let win;
 try {
  win=new BrowserWindow({show:false,width:1280,height:520,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await pause(20);}throw Error('timeout '+code);};
  await win.loadFile(path.join(__dirname,'index.html'));
  await until('document.querySelector("select")?.value==="default"');
  check('reads actual default',await js('document.body.textContent.includes("跨对话串同时修改")'));
  check('all three choices',await js('document.querySelector("select").options.length===3'));
  await js('fixture.select("parallel_writers")');await until('!document.querySelector("select").disabled && document.querySelector("select").value==="parallel_writers"');
  check('parallel real command/CAS',await js('fixture.calls.some(e=>e.method==="project.writeConcurrency.set"&&e.params.override==="parallel_writers"&&e.params.expectedRevision===0)'));
  check('same thread permission explained',await js('document.body.textContent.includes("同一对话串中同时修改")'));
  await until('!document.querySelector("select").disabled && document.querySelector("select").value==="parallel_writers" && document.body.textContent.includes("同一对话串中同时修改")');
  await pause(80);win.webContents.invalidate();
  fs.writeFileSync(path.join(__dirname,'parallel.png'),(await win.webContents.capturePage()).toPNG());
  await js('fixture.behavior("unknown");fixture.select("single_writer")');await until('document.body.textContent.includes("重试保存")');
  check('unknown prevents a new request',await js('document.querySelector("select").disabled'));
  await js('fixture.button("重试保存")');await until('!document.querySelector("select").disabled && document.querySelector("select").value==="single_writer"');
  check('unknown retried exact command',await js('(()=>{const e=fixture.calls.filter(e=>e.method==="project.writeConcurrency.set");return e.length===3&&e[1].commandId===e[2].commandId&&JSON.stringify(e[1].params)===JSON.stringify(e[2].params)})()'));
  await js('fixture.behavior("stale");fixture.select("default")');await until('document.body.textContent.includes("设置已变化")');
  check('CAS refusal preserves readback',await js('document.querySelector("select").value==="single_writer"'));
  await js('fixture.behavior("slow");fixture.select("parallel_writers");fixture.switchProject("b")');
  await until('document.querySelector("h2")?.textContent.includes("b")&&document.querySelector("select")?.value==="single_writer"');await pause(400);
  check('late receipt cannot overwrite another project',await js('document.querySelector("select").value==="single_writer" && fixture.facts.b.revision===0'));
  fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:checks.every(c=>c.ok),checks,realBusinessCalls:0},null,2));
 }catch(e){checks.push({name:'exception',ok:false,detail:String(e.stack||e)});fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:false,checks},null,2));}
 finally{if(win&&!win.isDestroyed())win.destroy();app.quit();}
});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const proc=spawnSync(require('electron'),[path.join(out,'main.cjs')],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:25000});
  const file=path.join(out,'result.json');
  if(!fs.existsSync(file))throw Error(`UI verifier failed ${proc.status}: ${proc.stderr}`);
  return {...JSON.parse(fs.readFileSync(file,'utf8')),evidence:file};
}
module.exports={runVerifier};
