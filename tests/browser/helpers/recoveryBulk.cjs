/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const renderer=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../../src/ui/hifi/App.tsx';
import {requestRecoveryOpen,notifyRecoveryChanged} from '../../../src/ui/hifi/lib/recovery.ts';
import * as store from '../../../src/ui/hifi/data/store.ts';
const calls=[],items=new Map(),outcomes=new Map();let gate=false,pending=0,undo=null,undoOutcome='succeeded',finish=null,readError=false;
const ok=data=>({ok:true,data}),fail=message=>({ok:false,error:{code:'SYNTHETIC_REJECTED',message}});
function setup(name){
 items.clear();outcomes.clear();gate=false;pending=0;undo=null;readError=false;
 const add=(id,kind='interrupted')=>items.set(id,{id,kind,revision:11,continued:false});
 if(['batch','partial','unknown','undo','mixed','close'].includes(name)){add('a');add('b','retained');gate=true;pending=3;}
 if(name==='partial')outcomes.set('b','error');
 if(name==='unknown')outcomes.set('a','unknown');
 if(name==='pending')pending=5;
 if(name==='queue'){gate=true;pending=2;}
 if(name==='undo'){undo={id:'undo',changeSetId:'cs',status:'failed'};undoOutcome='conflict';}
 if(name==='mixed'){add('live','RUNNING');add('finished','DONE');add('cancelled','CANCELLED');}
 if(name==='close'||name==='batch')outcomes.set('a','delay');
 if(name==='read-error'){add('a');readError=true;}
 notifyRecoveryChanged();
}
function status(){
 const unknownTurns=[],interruptedRuns=[],pendingRelease=[];
 for(const item of items.values()){
  if(item.kind==='retained'){if(!item.continued)pendingRelease.push({turnId:'turn-'+item.id,taskId:item.id});continue;}
  for(const child of item.id==='a'?['a-child1','a-child2']:[item.id]){
   unknownTurns.push({id:'turn-'+child,taskId:child,protectionReleased:item.continued});
   if(!item.continued)interruptedRuns.push({id:'run-'+child,task_id:child,status:'INTERRUPTED'});
  }
 }
 return {gateHeld:gate,pendingDispatchCount:pending,unknownTurns,pendingRelease,interruptedRuns,heldLeases:[],activeUndos:undo?[undo]:[]};
}
window.zs={command:async env=>{
 calls.push(structuredClone(env));
 if(env.method==='app.appearance.get')return ok({showAvatars:true,avatars:{}});
 if(env.method==='recovery.status')return ok(status());
 if(env.method==='task.get'){
  if(readError)return fail('原任务读取失败');
  const id=env.params.taskId,parent=id.startsWith('a-child')?'a':null,item=items.get(parent??id);
  if(!item)return fail('任务不存在');
  const terminal=['DONE','CANCELLED'].includes(item.kind),phase=item.continued?'QUEUED':item.kind==='RUNNING'?'RUNNING':terminal?item.kind:'UNKNOWN';
  return ok({task:{id,title:parent?'协作子任务':'任务 '+id,status:terminal?item.kind:'BLOCKED',project_id:'p',parent_task_id:parent,revision:item.revision,stop_generation:0},
   executionStatus:{phase,actions:!terminal&&phase==='UNKNOWN'?[{kind:'continue'}]:[]}});
 }
 if(env.method==='task.continue'){
  const id=env.params.taskId,item=items.get(id),outcome=outcomes.get(id);
  if(outcome==='delay')await new Promise(resolve=>{finish=resolve;});
  if(outcome==='error')return fail('成员配置需要更新');
  if(outcome==='unknown')throw Error('连接中断');
  if(!item||env.params.expectedTaskRevision!==item.revision)return fail('任务版本已变化');
  item.continued=true;item.revision++;return ok({enqueued:true,dispatchKey:'continue:'+id});
 }
 if(env.method==='dispatch.resume'){gate=false;return ok({gate:'open'});}
 if(env.method==='changeset.undo'){
  if(undoOutcome==='succeeded'){undo=null;return ok({status:'succeeded',manualPaths:[]});}
  return ok({status:'conflict',manualPaths:['report.md']});
 }
 if(env.method==='conversation.list')return ok({conversations:[]});
 if(env.method==='room.list')return ok({items:[]});
 return fail('测试未提供命令：'+env.method);
},onDisconnect:()=>{},onReconnected:()=>{}};
store.setState(s=>({...s,boot:'ready',conn:'online',ui:{...s.ui,theme:'light'},projects:[],rooms:[],dms:[],members:[],expandedProjectIds:[],visibleProjectIds:[]}));
document.body.classList.add('hifi-on');location.hash='#/welcome';
createRoot(document.getElementById('root')).render(<App/>);
window.bulk={setup,open:()=>requestRecoveryOpen(),release:()=>{outcomes.set('a','ok');finish?.();finish=null;},outcome:(id,value)=>outcomes.set(id,value),undoSuccess:()=>{undoOutcome='succeeded';},
 snapshot:()=>({text:document.body.innerText,calls,modal:!!document.querySelector('[data-zs-recovery]'),attention:!!document.querySelector('[data-zs-recovery-attention]'),
  tasks:[...document.querySelectorAll('[data-zs-recovery-task]')].map(el=>el.dataset.zsRecoveryTask),pending:!!finish})};
`;
async function runVerifier(){
 const out=path.join(root,'dist/recovery-bulk-ui',`${Date.now()}-${process.pid}`);fs.mkdirSync(out,{recursive:true});
 fs.mkdirSync(path.join(out,'assets'));fs.copyFileSync(path.join(root,'logo.png'),path.join(out,'assets/logo.png'));
 fs.writeFileSync(path.join(out,'entry.tsx'),renderer);
 await require('esbuild').build({entryPoints:[path.join(out,'entry.tsx')],outfile:path.join(out,'ui.mjs'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',loader:{'.png':'dataurl'},logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
 fs.writeFileSync(path.join(out,'app.css'),['tokens.css','base.css','components.css','preview.css','titlebar.css','h1-overrides.css'].map(file=>fs.readFileSync(path.join(root,'src/ui/hifi/styles',file),'utf8')).join('\n'));
 fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div class="app" id="root"></div><script type="module" src="ui.mjs"></script>');
 fs.writeFileSync(path.join(out,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),checks=[],screenshots=[];
const check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const js=code=>win.webContents.executeJavaScript(code),snap=()=>js('bulk.snapshot()');
 const until=async(code,label)=>{for(let i=0;i<180;i++){if(await js(code))return;await pause(20);}throw Error('timeout '+label+' '+JSON.stringify(await snap()));};
 const open=async()=>{await js('bulk.open()');await until('document.querySelector("[data-zs-recovery-summary]")&&!document.body.innerText.includes("正在读取任务…")','loaded');};
 const batch=()=>js('document.querySelector("[data-zs-recovery-process-all]").click()');
 const close=async()=>{await js('[...document.querySelectorAll("[data-zs-recovery] button")].find(b=>b.textContent==="关闭").click()');await until('!bulk.snapshot().modal','closed');};
 const setup=async name=>{await js('bulk.setup('+JSON.stringify(name)+')');await pause(50);};
 const writes=s=>s.calls.filter(c=>['task.continue','dispatch.resume','changeset.undo'].includes(c.method));
 const capture=async name=>{await pause(90);const file=path.join(__dirname,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());screenshots.push(file);};
 try{
  await win.loadFile(path.join(__dirname,'index.html'));await until('window.bulk&&bulk.snapshot().calls.some(c=>c.method==="recovery.status")','startup');await pause(50);let s=await snap();
  check('idle-sidebar-hides-recovery-without-startup-popup',!s.attention&&!s.modal&&writes(s).length===0,s);
  await capture('01-idle-sidebar');await setup('pending');s=await snap();check('ordinary-queued-messages-do-not-show-recovery',!s.attention&&!s.modal,s);
  await setup('batch');await until('bulk.snapshot().attention','new interruption');s=await snap();check('new-interruptions-show-menu-without-popup',s.attention&&!s.modal,s);
  await open();s=await snap();check('siblings-resolve-to-one-root-and-retained-failure-has-task',s.tasks.join(',')==='a,b',s.tasks);
  check('primary-is-one-click-continue-and-does-not-clear-history',s.text.includes('一键继续')&&!s.text.includes('一键清空')&&writes(s).length===0,s.text);await capture('02-one-click-continue');
  await js('const b=document.querySelector("[data-zs-recovery-process-all]");b.click();b.click();document.querySelector("[data-zs-continue-task=b]").click()');await until('bulk.snapshot().pending','bulk pending');s=await snap();
  check('double-click-submits-root-only-once',s.calls.filter(c=>c.method==='task.continue').length===1,s.calls);
  check('all-write-actions-disabled-during-batch',await js('[...document.querySelectorAll("[data-zs-recovery-process-all],[data-zs-continue-task]")].every(b=>b.disabled)'),s.text);
  await js('bulk.release()');await until('!bulk.snapshot().modal&&!bulk.snapshot().attention','auto close and hide');s=await snap();
  check('success-continues-both-roots-and-queue-once',writes(s).map(c=>c.method==='task.continue'?c.params.taskId:c.method).join(',')==='a,b,dispatch.resume',writes(s));
  check('batch-preserves-revision-generation-and-queue-confirmation',s.calls.filter(c=>c.method==='task.continue').every(c=>c.params.expectedTaskRevision===11&&c.params.expectedStopGeneration===0)&&s.calls.find(c=>c.method==='dispatch.resume').params.confirm===true,s.calls);
  check('success-notice-says-background-work',s.text.includes('任务会在后台继续')&&!s.text.includes('任务已完成'),s.text);await capture('03-success-sidebar');
  await setup('partial');await open();const before=(await snap()).calls.length;await batch();await until('document.querySelector("[data-zs-recovery-batch-result]")&&!document.querySelector("[data-zs-recovery-process-all]").disabled','partial result');s=await snap();
  check('partial-failure-keeps-only-failed-task-and-concrete-reason',s.modal&&s.attention&&s.tasks.join(',')==='b'&&s.text.includes('成员配置需要更新')&&s.text.includes('已处理 2 项'),s);await capture('04-partial-failure');
  await js('bulk.outcome("b","ok")');await batch();await until('!bulk.snapshot().modal&&!bulk.snapshot().attention','partial retry');s=await snap();
  check('retry-does-not-resubmit-accepted-tasks-or-queue',s.calls.slice(before).filter(c=>c.method==='task.continue').map(c=>c.params.taskId).join(',')==='a,b,b'&&s.calls.slice(before).filter(c=>c.method==='dispatch.resume').length===1,s.calls.slice(before));
  await setup('unknown');await open();const uncertainBefore=(await snap()).calls.length;await batch();await until('document.body.innerText.includes("继续请求尚未收到回执")&&!document.querySelector("[data-zs-recovery-process-all]").disabled','uncertain result');s=await snap();
  check('uncertain-transport-is-not-success-and-remains-retryable',s.modal&&s.attention&&s.tasks.join(',')==='a',s);
  await js('bulk.outcome("a","ok")');await batch();await until('!bulk.snapshot().modal&&!bulk.snapshot().attention','uncertain retry');s=await snap();
  const uncertain=s.calls.slice(uncertainBefore).filter(c=>c.method==='task.continue'&&c.params.taskId==='a');check('uncertain-retry-reuses-command-identity',uncertain.length===2&&uncertain[0].commandId===uncertain[1].commandId,uncertain);
  await setup('queue');await open();await batch();await until('!bulk.snapshot().modal&&!bulk.snapshot().attention','queue only');check('queue-only-batch-hides-on-success',!(await snap()).attention);
  await setup('undo');await open();const undoBefore=(await snap()).calls.length;s=await snap();check('unfinished-undo-keeps-one-click-continue-with-clear-description',s.text.includes('一键继续')&&s.text.includes('完成未结束的撤销'),s.text);
  await batch();await until('document.querySelector("[data-zs-recovery-batch-result]")&&!document.querySelector("[data-zs-recovery-process-all]").disabled','undo conflict');s=await snap();
  check('undo-conflict-leaves-message-and-does-not-start-tasks',s.text.includes('report.md')&&s.modal&&s.attention&&writes({calls:s.calls.slice(undoBefore)}).every(c=>c.method==='changeset.undo'),s);
  await js('bulk.undoSuccess()');await batch();await until('!bulk.snapshot().modal&&!bulk.snapshot().attention','undo success');s=await snap();
  check('undo-finishes-before-task-continuations',writes({calls:s.calls.slice(undoBefore)}).map(c=>c.method).join(',')==='changeset.undo,changeset.undo,task.continue,task.continue,dispatch.resume',s.calls.slice(undoBefore));
  await setup('mixed');await open();s=await snap();check('running-done-and-cancelled-tasks-have-no-continue-button',!await js('document.querySelector("[data-zs-continue-task=live],[data-zs-continue-task=finished],[data-zs-continue-task=cancelled]")')&&s.text.includes('任务已取消'),s.text);await close();
  await setup('close');await open();await batch();await until('bulk.snapshot().pending','background pending');await close();await open();await js('bulk.release()');await until('!bulk.snapshot().attention','background accepted');await pause(100);s=await snap();
  check('closing-does-not-stop-submission-or-close-a-new-panel',s.modal&&!s.attention,s);await close();
  await setup('read-error');await open();s=await snap();check('read-error-never-pretends-to-be-empty-or-offers-guessed-batch',s.text.includes('原任务读取失败')&&!s.text.includes('没有需要恢复的任务')&&!await js('document.querySelector("[data-zs-recovery-process-all]")'),s.text);await close();
  s=await snap();check('all-scenarios-use-formal-commands-without-history-deletion-or-model-calls',!s.calls.some(c=>/delete|dismiss|reconcile|probeProcess|releaseProtection|turn.start|message.submit/.test(c.method)),s.calls.map(c=>c.method));
  const report={ok:checks.every(c=>c.ok),checks,screenshots,realModelCalls:0,userDataOpened:false};fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
 }catch(error){fs.writeFileSync(path.join(__dirname,'error.txt'),error.stack);fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(2);}
});setTimeout(()=>app.exit(3),28000);
`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];
 const proc=spawnSync(require('electron'),[path.join(out,'main.cjs')],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:32000});
 if(!fs.existsSync(path.join(out,'result.json')))throw Error(`Recovery bulk UI exited ${proc.status}: ${fs.existsSync(path.join(out,'error.txt'))?fs.readFileSync(path.join(out,'error.txt'),'utf8'):proc.stderr}; evidence ${out}`);
 return {...JSON.parse(fs.readFileSync(path.join(out,'result.json'),'utf8')),evidence:out};
}
module.exports={runVerifier};
