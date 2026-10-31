import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import WebSocket from 'ws';

const repo=resolve(import.meta.dirname,'..');
const daily=resolve(process.argv[2]??'');
const installed=process.argv.includes('--installed');
if(!process.argv[2]||!existsSync(join(daily,'ZhongshuoDual','BUILD.json')))throw Error('Pass a built daily package directory');
const app=join(daily,'ZhongshuoDual');
const run=join(repo,'dist','r136-package',randomUUID());mkdirSync(run,{recursive:true});
const manifest=JSON.parse(readFileSync(join(app,'MANIFEST-SHA256.json'),'utf8'));
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
for(const file of manifest.files)if(digest(join(app,file.path))!==file.sha256)throw Error(`Package hash mismatch: ${file.path}`);
const tools=join(app,'runtime-tools','deepseek-harness');
const connector=JSON.parse(readFileSync(join(tools,'manifest.json'),'utf8'));
if(connector.profile!=='zhongshuo'||connector.dshVersion!=='0.2.1-rc.5'||digest(join(tools,connector.tarball))!==connector.sha256)throw Error('Connector archive mismatch');
if(!existsSync(join(tools,'setup.cmd')))throw Error('Connector setup entry missing');
const help=readFileSync(join(daily,'众说操作手册.html'),'utf8');
if(!help.includes('DeepSeek Harness')||!help.includes('Pi'))throw Error('Packaged manual missing channels');
const data=join(run,'data'),project=join(run,'project'),config=join(run,'config');
for(const dir of [data,project,config])mkdirSync(dir);
const scenario=String.raw`(async()=>{
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));const checks=[];
 const check=(name,ok)=>{checks.push({name,ok});if(!ok)throw Error(name);};
 const command=async(method,params)=>{const r=await window.zs.command({protocolVersion:1,commandId:crypto.randomUUID(),method,params});if(!r.ok)throw Error(method+': '+JSON.stringify(r.error));return r.data;};
 const runtime=await command('runtime.status',{});
 check('packaged daemon declares Harness',Boolean(runtime.capabilities['deepseek-harness']));
 check('packaged daemon declares Pi',Boolean(runtime.capabilities.pi));
 const opened=await command('project.open',{path:__PROJECT__});const projectId=opened.project.id;
 for(const kind of ['deepseek-harness','pi']){
  const result=await command('member.runtimeCatalog',{projectId,kind,executable:__MISSING__});
  check(kind+' schema accepted in packaged daemon',result.kind===kind&&result.program.status==='missing'&&result.models.length===0);
 }
 const installedCatalogs=[];
 if(__INSTALLED__)for(const [kind,executable] of [['deepseek-harness','dsh'],['pi','pi']]){
  const catalog=await command('member.runtimeCatalog',{projectId,kind,executable});
  check(kind+' installed CLI found by packaged daemon',catalog.program.status==='found');
  check(kind+' installed model catalog readable',catalog.models.length>0);
  installedCatalogs.push({kind,models:catalog.models.map(model=>model.id)});
 }
 location.hash='/project/'+projectId+'/members';
 let add;for(let i=0;i<120;i++){add=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='添加 AI');if(add)break;await wait(50);}
 check('packaged member page renders',Boolean(add));add.click();await wait(150);
 const select=document.querySelector('[role="dialog"] [role="combobox"][aria-label="运行渠道"]');check('channel picker renders',Boolean(select));select.click();await wait(100);
 const labels=Array.from(document.querySelectorAll('[role="option"]')).map(el=>el.textContent.trim());
 for(const label of ['Claude CLI','Codex CLI','DeepSeek Harness','Pi'])check('picker contains '+label,labels.includes(label));
 return {checks,channels:labels,installedCatalogs,realModelCalls:0};
})()`;
const code=scenario.replace('__PROJECT__',JSON.stringify(project)).replace('__MISSING__',JSON.stringify(join(run,'missing-runtime.cjs'))).replace('__INSTALLED__',JSON.stringify(installed));
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env,{ZS_APP_DATA:data,ZS_RUNTIME:'fake',ZS_ALLOW_FAKE:'1',ZS_REAL_DISPATCH_GUARD:'1',ZS_PACKAGED_UI:'1',
  ZS_PIPE_NAME:String.fromCharCode(92,92,46,92)+'pipe'+String.fromCharCode(92)+'zs-r136-package-'+randomUUID(),ZS_DAEMON_ENTRY:join(app,'resources','app','daemon','daemon.cjs'),
  ZS_NODE_BIN:join(app,'resources','app','daemon','node','node.exe'),CLAUDE_CONFIG_DIR:config,CODEX_HOME:config,DSH_HOME:join(config,'dsh'),PI_CODING_AGENT_DIR:join(config,'pi')});
if(installed)for(const key of ['DSH_HOME','DSH_AGENTS_HOME','PI_CODING_AGENT_DIR']){
  if(process.env[key]!=null)env[key]=process.env[key];else delete env[key];
}
// Packaged Electron loads its bundled application, not a positional main script.
// Drive that actual application through its debugging port on a non-primary display.
const screenQuery=join(run,'screens.cjs');
writeFileSync(screenQuery,"const {app,screen}=require('electron');app.whenReady().then(()=>{console.log('R136_SCREENS '+JSON.stringify({primary:screen.getPrimaryDisplay().id,displays:screen.getAllDisplays().map(d=>({id:d.id,label:d.label}))}));app.quit();});");
const screenResult=spawnSync(join(repo,'node_modules','electron','dist','electron.exe'),[screenQuery],{env,encoding:'utf8',windowsHide:true,timeout:15000});
const screenLine=screenResult.stdout?.split(/\r?\n/).find(line=>line.startsWith('R136_SCREENS '));
if(!screenLine)throw Error('Cannot inspect isolated test display');
const screens=JSON.parse(screenLine.slice('R136_SCREENS '.length));
const display=screens.displays.find(item=>item.id!==screens.primary);if(!display)throw Error('Packaged visual verification needs a non-primary display');
env.ZS_TEST_DISPLAY=String(display.id);
const port=await new Promise(resolvePort=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolvePort(value));});});
const child=spawn(join(app,'electron.exe'),[`--remote-debugging-port=${port}`],{cwd:dirname(daily),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='',exitCode=null;child.stdout.on('data',chunk=>{log+=chunk;});child.stderr.on('data',chunk=>{log+=chunk;});
const closed=new Promise(resolveClose=>child.on('close',code=>{exitCode=code;resolveClose();}));
const wait=ms=>new Promise(resolveWait=>setTimeout(resolveWait,ms));
let socket,result,requestId=0;
const pending=new Map();
const send=(method,params={})=>new Promise((resolveResponse,reject)=>{
  const id=++requestId;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP deadline: '+method));},25000);
  pending.set(id,{resolve:resolveResponse,reject,timer});socket.send(JSON.stringify({id,method,params}));
});
try{
  let target;
  for(let attempt=0;attempt<150;attempt++){
    try{const targets=await(await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)).json();target=targets.find(item=>item.type==='page'&&item.webSocketDebuggerUrl);if(target)break;}catch{/* startup */}
    await wait(100);
  }
  if(!target)throw Error('Packaged page did not start');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((ready,reject)=>{socket.once('open',ready);socket.once('error',reject);});
  socket.on('message',bytes=>{const frame=JSON.parse(bytes.toString());const waiter=pending.get(frame.id);if(waiter){pending.delete(frame.id);clearTimeout(waiter.timer);if(frame.error)waiter.reject(Error(JSON.stringify(frame.error)));else waiter.resolve(frame.result);}});
  for(let attempt=0;attempt<100;attempt++){
    const state=await send('Runtime.evaluate',{expression:"typeof window.zs?.command==='function'&&document.body.classList.contains('hifi-on')",returnByValue:true});
    if(state.result?.value===true)break;await wait(100);
  }
  const response=await send('Runtime.evaluate',{expression:code,awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails)throw Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text);
  result={ok:true,...response.result.value};
}catch(error){result={ok:false,error:String(error)};}
finally{
  if(socket?.readyState===WebSocket.OPEN){
    try{
      const stopped=await send('Runtime.evaluate',{expression:"window.zs.command({protocolVersion:1,commandId:crypto.randomUUID(),method:'daemon.shutdown',params:{}})",awaitPromise:true,returnByValue:true});
      result.shutdownReceipt=stopped.result?.value?.ok===true;
    }catch(error){result.shutdownError=String(error);}
    try{await send('Page.close');}catch{/* target closes with application */}
  }
  await Promise.race([closed,wait(15000)]);
  if(exitCode===null){child.kill();await Promise.race([closed,wait(2000)]);}
  socket?.close();for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(Error('CDP closed'));}pending.clear();
}
writeFileSync(join(run,'process.log'),log);writeFileSync(join(run,'ui-result.json'),JSON.stringify(result,null,2));
for(let attempt=0;attempt<30&&existsSync(join(data,'daemon.pid'));attempt++)await wait(100);
const report={...result,run,exitCode,display,hashes:manifest.files.length,build:JSON.parse(readFileSync(join(app,'BUILD.json'),'utf8')),
  connector:{profile:connector.profile,dshVersion:connector.dshVersion,sha256:connector.sha256},daemonStopped:!existsSync(join(data,'daemon.pid'))};
writeFileSync(join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
if(!report.ok||report.exitCode!==0||!report.daemonStopped)process.exitCode=1;
