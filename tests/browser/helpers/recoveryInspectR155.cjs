/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const renderer=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../../src/ui/hifi/App.tsx';
import {TaskExecutionStatusView} from '../../../src/ui/hifi/components/TaskExecutionStatusView.tsx';
import {requestRecoveryOpen,OPEN_RECOVERY_EVENT} from '../../../src/ui/hifi/lib/recovery.ts';
import * as store from '../../../src/ui/hifi/data/store.ts';
const config=__CONFIG__,calls=[],events=[];
let revision=config.status.evidence.taskRevision,view='interrupted',outcome='delay',finish,continued=false,history=false,empty=false,gate=false,taskError=false;
const success=data=>({ok:true,data}),failure=message=>({ok:false,error:{code:'SYNTHETIC_REJECTED',message}});
window.addEventListener(OPEN_RECOVERY_EVENT,event=>events.push(event.detail));
function status(){
 if(view==='ongoing')return config.ongoing;
 const value=structuredClone(config.status);value.evidence.taskRevision=revision;
 value.actions=value.actions.map(action=>action.kind==='continue'?{...action,binding:{...action.binding,expectedTaskRevision:revision}}:action);
 if(continued){value.phase='QUEUED';value.actions=value.actions.filter(action=>action.kind!=='continue');}
 return value;
}
window.zs={command:async env=>{
 calls.push(structuredClone(env));
 if(env.method==='app.appearance.get')return success({showAvatars:true,avatars:{}});
 if(env.method==='recovery.status')return success({gateHeld:gate,pendingDispatchCount:gate?2:0,pendingDispatchKeys:[],unknownTurns:empty?[]:[{id:'held-turn',taskId:'child',protectionReleased:history},{id:'other-turn',taskId:'old-child',protectionReleased:history}],pendingRelease:empty||history?[]:[{turnId:'held-turn',taskId:'child'}],interruptedRuns:empty||history?[]:[{id:'child-run',task_id:'child',status:'INTERRUPTED'}],heldLeases:[],activeUndos:[],stopRecord:null});
 if(env.method==='task.get'){
  if(taskError)return failure('原任务暂时无法读取，请刷新重试');
  const id=env.params.taskId;
  if(!['parent','child','old-child'].includes(id))return failure('任务不存在');
  return success({task:{id,title:id==='parent'?'原父任务：完成测试文件':'Pi 子任务',status:'BLOCKED',project_id:'p',parent_task_id:id==='parent'?null:'parent',revision,stop_generation:config.status.evidence.stopGeneration},executionStatus:id==='parent'?status():undefined});
 }
 if(env.method==='task.continue'){
  if(outcome==='error')return failure('任务仍在执行，请稍后继续');
  if(outcome==='unknown')throw Error('连接已中断');
  if(outcome==='delay')await new Promise(resolve=>{finish=resolve;});
  continued=true;render();return success({enqueued:true,dispatchKey:'task:'+env.params.taskId+':continue'});
 }
 if(env.method==='dispatch.resume'){gate=false;return success({});}
 if(env.method==='conversation.list')return success({conversations:[]});
 if(env.method==='room.list')return success({items:[]});
 if(env.method==='room.pool')return success({items:[]});
 if(env.method==='deepLink.resolve')return success({kind:'task',projectId:'p',conversationId:'conv',threadId:'thread',taskId:env.params.hash.slice(6)});
 return failure('测试未提供命令：'+env.method);
},onDisconnect:()=>{},onReconnected:()=>{}};
store.setState(s=>({...s,boot:'pending',conn:'online',ui:{...s.ui,theme:'dark'},activeProjectId:'p',projects:[{id:'p',displayName:'隔离验证项目',rootPath:'合成目录',status:'active',revision:1}],members:[],dms:[],rooms:[{id:'room',projectId:'p',conversationId:'conv',name:'合成房间',coordinatorMemberId:'owner',memberIds:[],revision:1,unread:0}],visibleProjectIds:[],expandedProjectIds:[]}));
document.body.classList.add('hifi-on');location.hash='#/welcome';
const app=createRoot(document.getElementById('root'));
function render(){app.render(<><div style={{position:'fixed',top:48,left:260,right:20,zIndex:30}}><TaskExecutionStatusView status={status()}/></div><App/></>);}
render();
window.r156={calls,events,open:target=>requestRecoveryOpen(target),finish:()=>{finish?.();finish=undefined;},outcome:value=>{outcome=value;},
 scenario:value=>{view=value;continued=false;revision++;history=value==='history';empty=value==='empty'||value==='queue';gate=value==='queue';taskError=value==='task-error';render();},
 boot:value=>store.setState(s=>({...s,boot:value})),
 snapshot:()=>({text:document.body.innerText,hash:location.hash,calls:calls.map(c=>({commandId:c.commandId,method:c.method,params:c.params})),events:events.slice(),pending:!!finish,modal:!!document.querySelector('[data-zs-recovery]'),tasks:[...document.querySelectorAll('[data-zs-recovery-task]')].map(card=>card.dataset.zsRecoveryTask),attention:document.querySelector('[data-zs-recovery-attention]')?.dataset.zsRecoveryAttention,forms:document.querySelectorAll('[data-zs-recovery] textarea,[data-zs-recovery] input,[data-zs-recovery] select').length})};
`;
async function runVerifier(config){
 const out=path.join(root,'dist/r156-direct-continue-ui',`${Date.now()}-${process.pid}`);fs.mkdirSync(out,{recursive:true});
 fs.mkdirSync(path.join(out,'assets'));fs.copyFileSync(path.join(root,'logo.png'),path.join(out,'assets/logo.png'));
 fs.writeFileSync(path.join(out,'entry.tsx'),renderer.replace('__CONFIG__',JSON.stringify(config)));
 await require('esbuild').build({entryPoints:[path.join(out,'entry.tsx')],outfile:path.join(out,'ui.mjs'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
 fs.writeFileSync(path.join(out,'app.css'),['tokens.css','base.css','components.css','preview.css','titlebar.css','h1-overrides.css'].map(file=>fs.readFileSync(path.join(root,'src/ui/hifi/styles',file),'utf8')).join('\n'));
 fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div class="app" id="root"></div><script type="module" src="ui.mjs"></script>');
 fs.writeFileSync(path.join(out,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),checks=[],screenshots=[];
function check(name,ok,detail){checks.push({name,ok:!!ok,detail});}
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
const js=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error(code+'\n'+error.message);}},snap=()=>js('r156.snapshot()');
const until=async(code,label)=>{for(let i=0;i<180;i++){if(await js(code))return;await pause(20);}throw Error('timeout '+label+' '+JSON.stringify(await snap()));};
const click=async text=>{const ok=await js('(()=>{const b=[...document.querySelectorAll("[data-zs-recovery] button")].find(b=>b.textContent==='+JSON.stringify(text)+');if(!b||b.disabled)return false;b.click();return true;})()');if(!ok)throw Error('Missing button '+text);};
const capture=async(name,wide=false)=>{await pause(180);const file=path.join(__dirname,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage({x:0,y:0,width:wide?3440:1280,height:wide?1440:900})).toPNG());screenshots.push(file);};
const close=async()=>{await click('关闭');await until('!r156.snapshot().modal','closed');};
const open=async()=>{await js('r156.open()');await until('document.querySelector("[data-zs-recovery-summary]")&&!document.body.innerText.includes("正在读取任务…")','loaded recovery');};
const writes=s=>s.calls.filter(c=>['task.continue','task.redispatch','dispatch.resume','changeset.undo'].includes(c.method));
try{
 await win.loadFile(path.join(__dirname,'index.html'));await until('window.r156&&document.querySelector("[data-zs-execution-action=continue]")','real backend parent action');let s=await snap();
 check('render-does-not-continue',writes(s).length===0,s.calls);
 await js('r156.boot("ready")');await until('r156.snapshot().calls.some(c=>c.method==="recovery.status")','startup sidebar status');await pause(40);s=await snap();
 check('startup-interruption-only-marks-sidebar-without-modal',s.attention==='1'&&!s.modal,s);await js('r156.boot("pending")');
 check('header-and-sidebar-use-direct-task-copy',s.text.includes('继续任务')&&s.text.includes('恢复任务')&&!/检查中断|恢复检查/.test(s.text),s.text);
 await capture('01-parent-direct-continue-1280');
 await js('const b=document.querySelector("[data-zs-execution-action=continue]");b.click();b.click()');await until('r156.snapshot().pending','one parent request');s=await snap();
 const first=s.calls.filter(c=>c.method==='task.continue');
 check('one-click-uses-real-backend-parent-binding',first.length===1&&first[0].params.taskId==='parent'&&typeof first[0].params.expectedTaskRevision==='number'&&typeof first[0].params.expectedStopGeneration==='number',first);
 check('continuation-disables-button-without-opening-a-modal',!s.modal&&await js('document.querySelector("[data-zs-execution-action=continue]").disabled')&&s.events.length===0,s);
 check('no-inspection-note-or-reboot-workflow',!s.calls.some(c=>/recovery\.(inspect|reconcile|releaseProtection|probeProcess)/.test(c.method))&&!/重启|解除占用|填写.*依据/.test(s.text),s.calls);
 await js('r156.finish()');await until('document.querySelector("[data-zs-execution-phase=QUEUED]")','continued queue');s=await snap();
 check('accepted-parent-refreshes-current-views-without-claiming-completion',s.calls.some(c=>c.method==='room.pool'||c.method==='room.list')&&s.text.includes('排队')&&!s.text.includes('任务已完成'),s.text);
 await js('r156.scenario("interrupted");r156.outcome("error")');await until('document.querySelector("[data-zs-execution-action=continue]")','retry scenario');await js('document.querySelector("[data-zs-execution-action=continue]").click()');await until('document.body.innerText.includes("任务仍在执行，请稍后继续")','rejected visible');s=await snap();
 check('definite-rejection-displays-real-reason-and-no-modal',s.text.includes('任务仍在执行，请稍后继续')&&!s.modal,s.text);
 await js('r156.scenario("interrupted");r156.outcome("unknown")');await pause(40);await js('document.querySelector("[data-zs-execution-action=continue]").click()');await until('document.body.innerText.includes("继续请求尚未收到回执")','unknown visible');s=await snap();const unknown=s.calls.filter(c=>c.method==='task.continue').at(-1);
 await js('r156.outcome("accepted");document.querySelector("[data-zs-execution-action=continue]").click()');await until('document.querySelector("[data-zs-execution-phase=QUEUED]")','unknown same identity retry');s=await snap();
 check('uncertain-retry-reuses-command-id',unknown.commandId===s.calls.filter(c=>c.method==='task.continue').at(-1).commandId,s.calls.filter(c=>c.method==='task.continue'));
 await js('r156.scenario("interrupted")');await open();s=await snap();
 check('recovery-groups-sibling-turns-into-the-real-root',JSON.stringify(s.tasks)==='["parent"]'&&s.calls.some(c=>c.method==='task.get'&&c.params.taskId==='child')&&s.calls.some(c=>c.method==='task.get'&&c.params.taskId==='parent'),s);
 check('recovery-has-one-parent-action-and-no-forms',await js('document.querySelectorAll("[data-zs-recovery] [data-zs-continue-task=parent]").length===1')&&s.forms===0&&!/检查中断|重启|对账|解除保护|填写.*依据/.test(s.text),s.text);
 await capture('02-recovery-root-task-1280');
 const count=s.calls.filter(c=>c.method==='task.continue').length;await js('(()=>{r156.outcome("delay");const b=document.querySelector("[data-zs-recovery] [data-zs-continue-task=parent]");b.click();b.click();})()');await until('r156.snapshot().pending','panel continuation');s=await snap();
 check('panel-direct-single-click-continues-root-once',s.calls.filter(c=>c.method==='task.continue').length===count+1&&s.calls.filter(c=>c.method==='task.continue').at(-1).params.taskId==='parent',s.calls);
 await js('r156.finish()');await until('document.querySelector("[data-zs-recovery]").innerText.includes("任务已在处理中")','panel refresh');await capture('03-continued-task-1280');
 await click('查看任务');await until('location.hash==="#/thread/thread?tab=task"&&!r156.snapshot().modal','root formal route');s=await snap();
 check('view-task-uses-formal-root-route',s.calls.some(c=>c.method==='deepLink.resolve'&&c.params.hash==='#task=parent'),s.hash);
 await js('location.hash="#/welcome";r156.scenario("ongoing")');await pause(40);s=await snap();const before=writes(s).length;
 check('true-running-task-has-no-continue-action',!!await js('document.querySelector("[data-zs-execution-phase=RUNNING]")')&&!await js('document.querySelector("[data-zs-execution-action=continue]")'),s.text);
 await js('r156.open({taskId:"parent"})');await until('document.querySelector("[data-zs-recovery-task=parent]")','running root');s=await snap();
 check('recovery-preserves-active-task-with-only-view',s.text.includes('任务已在处理中')&&!await js('document.querySelector("[data-zs-recovery] [data-zs-continue-task]")')&&writes(s).length===before,s.text);
 win.setSize(3440,1440);await capture('04-active-task-preserved-3440',true);win.setSize(1280,900);await close();
 await js('r156.scenario("history");r156.boot("ready")');await open();s=await snap();
 check('released-unknown-history-does-not-reappear-as-attention',s.tasks.length===0&&s.attention==='0'&&s.text.includes('没有需要恢复的任务'),s);
 await close();await js('r156.boot("pending");r156.scenario("queue")');await open();s=await snap();const queueBefore=s.calls.filter(c=>c.method==='dispatch.resume').length;
 check('queue-is-not-resumed-on-open',queueBefore===0,s.calls);await click('继续处理排队消息');await until('r156.snapshot().calls.some(c=>c.method==="dispatch.resume")','queue continue');s=await snap();
 check('explicit-queue-continue-retains-confirmation-contract',s.calls.filter(c=>c.method==='dispatch.resume').length===1&&s.calls.find(c=>c.method==='dispatch.resume').params.confirm===true,s.calls);
 await close();await js('r156.scenario("task-error")');await open();s=await snap();
 check('unreadable-task-is-an-honest-error-without-guessed-continue',s.text.includes('原任务暂时无法读取')&&!await js('document.querySelector("[data-zs-recovery] [data-zs-continue-task]")'),s.text);
 check('all-scenarios-avoid-old-check-commands-and-models',!s.calls.some(c=>/recovery\.(inspect|reconcile|releaseProtection|probeProcess)|message.submit|turn.start/.test(c.method)),s.calls);
 const report={ok:checks.every(c=>c.ok),checks,screenshots,realBusinessCalls:0,userDatabaseOpened:false};fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
}catch(error){fs.writeFileSync(path.join(__dirname,'error.txt'),error.stack);fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(2);}
});setTimeout(()=>app.exit(3),28000);
`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];
 const proc=spawnSync(require('electron'),[path.join(out,'main.cjs')],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:32000});
 if(!fs.existsSync(path.join(out,'result.json')))throw Error(`R156 UI exited ${proc.status}: ${fs.existsSync(path.join(out,'error.txt'))?fs.readFileSync(path.join(out,'error.txt'),'utf8'):proc.stderr}; evidence ${out}`);
 return {...JSON.parse(fs.readFileSync(path.join(out,'result.json'),'utf8')),evidence:out};
}
module.exports={runVerifier};
