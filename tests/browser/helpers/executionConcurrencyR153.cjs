/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const renderer = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SettingsPage} from '../../../src/ui/hifi/pages/SettingsPage.tsx';
import {navigate,useHashRoute,parseQuery} from '../../../src/ui/hifi/lib/router.ts';
import {initDraftPersistence} from '../../../src/ui/hifi/data/store.ts';
const clone=v=>JSON.parse(JSON.stringify(v));
const serverKey='r153-synthetic-concurrency-server';
let server=JSON.parse(localStorage.getItem(serverKey)||'null')||{facts:{revision:0,limits:{globalMaxInFlight:4,perProjectMaxInFlight:4,perProviderMaxInFlight:4},source:'default'},calls:[],receipts:{},changes:0};
let mode='normal',holdRead=false,readError=false,releaseSet=null,releaseRead=null;
const persist=()=>localStorage.setItem(serverKey,JSON.stringify(server));
window.zs={command:async e=>{
 server.calls.push(clone(e));persist();
 if(e.method==='app.executionConcurrency.get'){
  if(readError){readError=false;return {ok:false,error:{code:'READ_FAILED',message:'合成读取失败'}};}
  const value=clone(server.facts);
  if(holdRead){holdRead=false;await new Promise(r=>{releaseRead=r;});releaseRead=null;}
  return {ok:true,data:value};
 }
 if(e.method==='app.executionConcurrency.set'){
  if(server.receipts[e.commandId])return clone(server.receipts[e.commandId]);
  if(mode==='forbidden'){mode='normal';return{ok:false,error:{code:'FORBIDDEN',message:'执行并发设置仅限本机修改'}};}
  if(mode==='stale'||mode==='stale-read-error'){readError=mode==='stale-read-error';mode='normal';server.facts={revision:server.facts.revision+1,limits:{globalMaxInFlight:7,perProjectMaxInFlight:7,perProviderMaxInFlight:7},source:'saved'};persist();return{ok:false,error:{code:'STALE_REVISION',message:'执行并发设置已变化，请重新读取后保存'}};}
  if(e.params.expectedRevision!==server.facts.revision)return{ok:false,error:{code:'STALE_REVISION',message:'版本已变化'}};
  server.facts={revision:server.facts.revision+1,limits:clone(e.params.limits),source:'saved'};server.changes++;
  const reply={ok:true,data:clone(server.facts)};server.receipts[e.commandId]=reply;persist();
  if(mode==='unknown'){mode='normal';throw Error('合成连接中断');}
  if(mode==='hold'){mode='normal';await new Promise(r=>{releaseSet=r;});releaseSet=null;}
  if(mode==='readback-hold'){mode='normal';holdRead=true;}
  if(mode==='readback-error'){mode='normal';readError=true;}
  return reply;
 }
 if(e.method==='app.settings.get')return{ok:true,data:{values:{'callBudget.enabled':'false'}}};
 if(e.method==='app.appearance.get')return{ok:true,data:{showAvatars:true,avatars:{}}};
 return{ok:false,error:{code:'SYNTHETIC_ONLY',message:'没有连接真实服务'}};
},onDisconnect(){},onReconnected(){}};
function Harness(){const route=useHashRoute();return <div className="hifi-root"><SettingsPage query={parseQuery(route)}/></div>;}
if(!location.hash)location.hash='/settings?section=runtime';
createRoot(document.getElementById('root')).render(<Harness/>);
window.fixture={
 boot:()=>initDraftPersistence('r153-execution-concurrency-synthetic'),
 server:()=>clone(server),mode:value=>{mode=value;},readError:()=>{readError=true;},holdRead:()=>{holdRead=true;},releaseSet:()=>releaseSet?.(),releaseRead:()=>releaseRead?.(),held:()=>({set:!!releaseSet,read:!!releaseRead}),
 navigate:section=>navigate('/settings?section='+section),environment:()=>{server.facts={revision:0,limits:{globalMaxInFlight:9,perProjectMaxInFlight:8,perProviderMaxInFlight:7},source:'environment'};persist();},
 input:(name,value)=>{const e=document.querySelector('input[name="'+name+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));},
 save:()=>document.querySelector('[data-settings-row="execution-concurrency"] form').requestSubmit(),
 button:text=>[...document.querySelectorAll('[data-settings-row="execution-concurrency"] button')].find(b=>b.textContent.includes(text))?.click(),
 search:value=>{const e=document.querySelector('[aria-label="搜索设置项"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));},
};
`;

async function runVerifier() {
  const out = path.join(root, 'dist/r153-concurrency-ui', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'entry.tsx'), renderer);
  await require('esbuild').build({ entryPoints: [path.join(out, 'entry.tsx')], outfile: path.join(out, 'ui.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.png': 'dataurl' }, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
  fs.writeFileSync(path.join(out, 'app.css'), ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css', 'h1-overrides.css'].map(file => fs.readFileSync(path.join(root, 'src/ui/hifi/styles', file), 'utf8')).join('\n'));
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div id="root"></div><script type="module" src="ui.js"></script>');
  fs.writeFileSync(path.join(out, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
const checks=[],pause=ms=>new Promise(r=>setTimeout(r,ms)),check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});if(!ok)throw Error(name);};
app.whenReady().then(async()=>{
 let win;
 try{
  win=new BrowserWindow({show:false,width:1440,height:1080,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const js=code=>win.webContents.executeJavaScript(code);
  const reload=async()=>{await new Promise(done=>{win.webContents.once('did-finish-load',done);win.webContents.reload();});await js('fixture.boot()');};
  const until=async code=>{for(let i=0;i<200;i++){if(await js(code))return;await pause(20);}throw Error('timeout '+code);};
  const panel='[data-settings-row="execution-concurrency"]';
  const values=()=>js('Object.fromEntries([...document.querySelectorAll('+JSON.stringify(panel+' input[name]')+')].map(e=>[e.name,e.value]))');
  const inputs=async(g,p,c)=>{await js('fixture.input("globalMaxInFlight",'+JSON.stringify(String(g))+')');await js('fixture.input("perProjectMaxInFlight",'+JSON.stringify(String(p))+')');await js('fixture.input("perProviderMaxInFlight",'+JSON.stringify(String(c))+')');};
  const idle='!!document.querySelector("input[name=globalMaxInFlight]")&&!document.querySelector("input[name=globalMaxInFlight]").disabled';
  const setCount=()=>js('fixture.server().calls.filter(e=>e.method==="app.executionConcurrency.set").length');
  await win.loadFile(path.join(__dirname,'index.html'));
  await until('!!document.querySelector("[data-settings-row=execution-concurrency]")');
  check('restored settings route mounts before root identity without inventing defaults',await js('!fixture.server().calls.some(e=>e.method==="app.executionConcurrency.get")'));
  await js('fixture.boot()');await until(idle);
  check('late root identity automatically loads settings without a manual refresh',await js('document.querySelector("input[name=globalMaxInFlight]").value==="4"'));
  check('actual default 4/4/4',JSON.stringify(await values())===JSON.stringify({globalMaxInFlight:'4',perProjectMaxInFlight:'4',perProviderMaxInFlight:'4'}));
  // R157 单页设置：切分区只滚动、不再卸载面板；改用面板自己的「重新读取」验证读取来源。
  await js('fixture.environment()');await js('fixture.button("重新读取")');await until(idle+'&&document.querySelector("input[name=globalMaxInFlight]").value==="9"');
  check('environment values are read rather than replaced by defaults',(await values()).globalMaxInFlight==='9');
  for(const invalid of ['',0,33,1.5]){await inputs(invalid,2,2);await js('fixture.save()');await until('document.querySelector("[role=alert]")?.textContent.includes("1–32")');}
  check('invalid whole-form edits never submit',await setCount()===0);
  await inputs(6,5,4);check('no loose field writes',await setCount()===0);
  await js('fixture.mode("readback-hold");fixture.save();fixture.save()');await until('fixture.held().read');
  check('single atomic request includes all three limits',await js('(()=>{const a=fixture.server().calls.filter(e=>e.method==="app.executionConcurrency.set");return a.length===1&&a[0].params.expectedRevision===0&&JSON.stringify(a[0].params.limits)===JSON.stringify({globalMaxInFlight:6,perProjectMaxInFlight:5,perProviderMaxInFlight:4})})()'));
  check('all inputs stay locked through readback',await js('[...document.querySelectorAll("input[name]")].every(e=>e.disabled)&&document.body.textContent.includes("正在保存并核对")'));
  await js('fixture.releaseRead()');await until(idle+'&&document.querySelector("[role=status]")?.textContent==="已保存"');
  check('save followed by fresh read',await js('(()=>{const a=fixture.server().calls.filter(e=>e.method.startsWith("app.executionConcurrency."));const n=a.findIndex(e=>e.method.endsWith(".set"));return n>=0&&a[n+1].method.endsWith(".get")})()'));
  await reload();await until(idle+'&&document.querySelector("input[name=globalMaxInFlight]").value==="6"');
  check('reopened renderer reads saved settings',(await values()).perProviderMaxInFlight==='4');
  await inputs(8,6,3);await js('fixture.mode("unknown");fixture.save()');await until('document.body.textContent.includes("使用原请求重试")');
  const unknown=await js('fixture.server().calls.filter(e=>e.method==="app.executionConcurrency.set").at(-1)');
  await reload();await until('document.body.textContent.includes("使用原请求重试")');
  check('unknown request survives reopening with inputs blocked',await js('document.querySelector("input[name=globalMaxInFlight]").disabled'));
  await js('fixture.button("使用原请求重试")');await until(idle+'&&document.querySelector("[role=status]")?.textContent==="已保存"');
  const retried=await js('fixture.server().calls.filter(e=>e.method==="app.executionConcurrency.set").at(-1)');
  check('unknown retries original command id and exact payload',unknown.commandId===retried.commandId&&JSON.stringify(unknown.params)===JSON.stringify(retried.params));
  check('unknown replay does not apply twice',await js('fixture.server().changes===2'));
  await inputs(10,9,8);await js('fixture.mode("stale");fixture.save()');await until(idle+'&&document.querySelector("[role=alert]")?.textContent.includes("其他窗口")');
  check('CAS reads current values and retains attempted draft',(await values()).globalMaxInFlight==='10'&&await js('fixture.server().facts.limits.globalMaxInFlight===7'));
  check('CAS never silently resubmits',await js('fixture.server().changes===2'));
  await js('fixture.mode("stale-read-error");fixture.save()');await until('document.querySelector("[role=alert]")?.textContent.includes("读取最新上限失败")');
  check('CAS refresh failure stays blocked and does not claim successful readback',await js('document.querySelector("input[name=globalMaxInFlight]").disabled&&!document.querySelector("[role=alert]").textContent.includes("已读取最新上限")'));
  await js('fixture.button("重新读取")');await until(idle+'&&document.querySelector("input[name=globalMaxInFlight]").value==="7"');
  await inputs(11,10,9);await js('fixture.mode("hold");fixture.save()');await until('fixture.held().set');
  const beforeNavigate=await setCount();
  // R157 单页：切分区不再卸载面板——同一节点保留，在途写仍锁定，也不能重复提交。
  await js('document.querySelector("[data-settings-row=execution-concurrency]").dataset.r157="kept";fixture.navigate("appearance")');await pause(160);
  check('route change keeps the same mounted settings panel',await js('document.querySelector("[data-settings-row=execution-concurrency]").dataset.r157==="kept"'));
  check('active write stays locked across a route change',await js('document.querySelector("input[name=globalMaxInFlight]").disabled&&document.body.textContent.includes("正在保存并核对")'));
  await js('fixture.save()');check('active original request cannot duplicate on a route change',await setCount()===beforeNavigate);
  await js('fixture.releaseSet()');await until(idle+'&&document.querySelector("input[name=globalMaxInFlight]").value==="11"');
  check('late receipt prompts fresh current-page read',await js('fixture.server().changes===3'));
  await inputs(12,11,10);await js('fixture.mode("readback-error");fixture.save()');await until('document.querySelector("[role=alert]")?.textContent.includes("已收到保存回执")');
  check('failed readback offers read recovery instead of another write',await js('!document.body.textContent.includes("使用原请求重试")&&document.querySelector("input[name=globalMaxInFlight]").disabled'));
  const beforeRead=await setCount();await js('fixture.button("重新读取")');await until(idle+'&&document.querySelector("input[name=globalMaxInFlight]").value==="12"');
  check('readback recovery sends no write',await setCount()===beforeRead);
  // R157 单页：切分区不再重新挂载或重新读取，迟到的旧读取无从产生。
  const readsBefore=await js('fixture.server().calls.filter(e=>e.method==="app.executionConcurrency.get").length');
  await js('fixture.navigate("appearance")');await pause(140);await js('fixture.navigate("runtime")');await pause(140);
  check('route changes neither re-read nor rebuild the panel',await js('fixture.server().calls.filter(e=>e.method==="app.executionConcurrency.get").length==='+readsBefore+'&&!!document.querySelector("[data-settings-row=execution-concurrency]")'));
  await inputs(13,12,11);await js('fixture.save()');await until(idle+'&&document.querySelector("input[name=globalMaxInFlight]").value==="13"');
  check('saved values survive route changes',(await values()).globalMaxInFlight==='13');
  // R206/R207：设置页去掉小字说明与状态文字；并发面板只保留表单、错误与保存状态。
  check('concurrency panel keeps editable controls without explanatory copy',await js('!document.body.textContent.includes("允许成员并行")&&!document.body.textContent.includes("同一成员在同一对话串中")&&!document.body.textContent.includes("前后依赖或未解除保护")&&!!document.querySelector("input[name=globalMaxInFlight]")'));
  await js('document.querySelector("[data-settings-row=execution-concurrency]").scrollIntoView({block:"center"})');await pause(80);win.webContents.invalidate();
  fs.writeFileSync(path.join(__dirname,'execution-concurrency.png'),(await win.webContents.capturePage()).toPNG());
  await js('fixture.search("并发")');await until('document.querySelector(".settings-search-hit")?.textContent.includes("同时运行的 AI")');
  await js('document.querySelector(".settings-search-hit").click()');await until('document.querySelector("[data-settings-row=execution-concurrency]")?.classList.contains("settings-jump-flash")');
  check('settings search actually locates concurrency panel',true);
  await inputs(14,13,12);await js('fixture.mode("forbidden");fixture.save()');await until('document.body.textContent.includes("仅可在本机修改")');
  check('remote rejection leaves a readable but non-editable form',await js('document.querySelector("input[name=globalMaxInFlight]").disabled&&fixture.server().facts.limits.globalMaxInFlight===13'));
  fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:true,checks,realModelCalls:0,userApplicationTouched:false},null,2));
 }catch(e){checks.push({name:'exception',ok:false,detail:String(e.stack||e)});fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:false,checks},null,2));}
 finally{if(win&&!win.isDestroyed())win.destroy();app.quit();}
});
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawnSync(require('electron'), [path.join(out, 'main.cjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 35000 });
  const file = path.join(out, 'result.json');
  if (!fs.existsSync(file)) throw Error(`Execution concurrency UI verifier failed ${proc.status}: ${proc.stderr}`);
  return { ...JSON.parse(fs.readFileSync(file, 'utf8')), evidence: file };
}
module.exports = { runVerifier };
