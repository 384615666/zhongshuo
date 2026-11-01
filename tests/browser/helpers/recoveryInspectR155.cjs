/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const renderer=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../../src/ui/hifi/App.tsx';
import {TaskExecutionStatusView} from '../../../src/ui/hifi/components/TaskExecutionStatusView.tsx';
import {OPEN_RECOVERY_EVENT,requestRecoveryOpen} from '../../../src/ui/hifi/lib/recovery.ts';
import * as store from '../../../src/ui/hifi/data/store.ts';
const config=__CONFIG__,calls=[],events=[];
let mode='restart',empty=false,releaseError=false;
window.addEventListener(OPEN_RECOVERY_EVENT,event=>events.push(event.detail));
const success=data=>({ok:true,data});
const failure=message=>({ok:false,error:{code:'SYNTHETIC_ONLY',message}});
function inspection(){
 const value=structuredClone(config.inspection);
 value.exitCheck={state:mode==='released'?'released':mode==='ready'?'ready':'blocked',action:mode==='released'?'none':mode==='ready'?'release':mode==='restart'?'restart-windows':'retry',checkedAt:Date.now(),
  message:mode==='released'?'旧执行的占用已解除。原结果和记录保留，可以回原任务继续。':mode==='ready'?'程序已确认旧执行结束。可以解除占用；这不代表原任务已完成，也不会重发旧请求。':mode==='restart'?'缺少上次退出记录，尚未确认较新的 Windows 启动代次。请重启 Windows 后再检查；不会重发原请求。':'尚不能确认旧执行已经结束，请保留原状态后重新检查。'};
 if(mode==='ready')value.result={complete:false,answer:'已保存部分整理记录，完整结果尚未收到。',files:[{artifactId:'saved-file',filename:'测试说明.md',kind:'text'}]};
 if(mode==='mismatch')value.taskId='wrong-child';
 return value;
}
window.zs={command:async env=>{
 calls.push(structuredClone(env));
 if(env.method==='recovery.status')return success({gateHeld:false,pendingDispatchCount:0,pendingDispatchKeys:[],interruptedRuns:[],unknownTurns:empty?[]:[{id:'held-turn',runId:'child-run',taskId:'child',stageKey:'coordination.child',status:'UNKNOWN',protectionReleased:mode==='released'}],pendingRelease:empty||mode==='released'?[]:[{turnId:'held-turn',protectionState:'retained',budgetMark:'settled',turnStatus:'UNKNOWN',leaseCount:0}],heldLeases:[],activeUndos:[],stopRecord:null});
 if(env.method==='recovery.inspect'){
  if(env.params.turnId!=='held-turn')return failure('指定执行不存在');
  if(mode==='error')return failure('程序检查暂时不可用，请重新检查');
  return success(inspection());
 }
 if(env.method==='recovery.releaseProtection'){
  await new Promise(resolve=>setTimeout(resolve,50));
  if(releaseError)return failure('旧执行退出证据已变化，占用仍保留');
  if(mode!=='ready')return failure('程序尚未确认退出，不可解除');
  mode='released';return success({stateChanged:true,releasedLeases:[]});
 }
 if(env.method==='deepLink.resolve')return success({kind:'task',projectId:'p',conversationId:'conv',threadId:'thread',taskId:env.params.hash==='#task=child'?'child':'parent',parentTaskId:env.params.hash==='#task=child'?'parent':null});
 if(env.method==='app.appearance.get')return success({showAvatars:true,avatars:{}});
 if(env.method==='conversation.list')return success({conversations:[]});
 if(env.method==='room.list')return success({items:[]});
 return failure('隔离测试没有后台服务：'+env.method);
},onDisconnect:()=>{},onReconnected:()=>{}};
store.setState(s=>({...s,boot:'pending',conn:'online',ui:{...s.ui,theme:'dark'},activeProjectId:'p',projects:[{id:'p',displayName:'隔离项目',rootPath:'合成目录',status:'active',revision:1}],members:[{id:'reviewer',projectId:'p',displayName:'Pi',principalType:'agent',enabled:true,ordinal:1}],dms:[],rooms:[],visibleProjectIds:[],expandedProjectIds:[]}));
document.body.classList.add('hifi-on');location.hash='#/welcome';
createRoot(document.getElementById('root')).render(<><div style={{position:'fixed',top:40,left:260,right:20,zIndex:30}}><TaskExecutionStatusView status={config.status}/></div><App/></>);
window.r155={
 events,calls,open:target=>requestRecoveryOpen(target),
 scenario:(next,options={})=>{mode=next;empty=!!options.empty;releaseError=!!options.releaseError;},
 boot:value=>store.setState(s=>({...s,boot:value})),
 snapshot:()=>({hash:location.hash,text:document.body.innerText,events:events.slice(),calls:calls.map(c=>({method:c.method,params:c.params})),focused:document.querySelector('[data-zs-recovery-focused="1"]')?.getAttribute('data-zs-previous-reply'),attention:document.querySelector('[data-zs-recovery-attention]')?.getAttribute('data-zs-recovery-attention'),inspectionCount:document.querySelectorAll('[data-zs-previous-reply]').length})
};
`;
async function runVerifier(config){
 if(!config?.status||!config?.inspection)throw Error('The verifier requires a status constructed by the backend fixture.');
 const out=path.join(root,'dist/r155-recovery-ui',`${Date.now()}-${process.pid}`);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'entry.tsx'),renderer.replace('__CONFIG__',JSON.stringify(config)));
 fs.mkdirSync(path.join(out,'assets'));fs.copyFileSync(path.join(root,'logo.png'),path.join(out,'assets/logo.png'));
 await require('esbuild').build({entryPoints:[path.join(out,'entry.tsx')],outfile:path.join(out,'ui.mjs'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
 fs.writeFileSync(path.join(out,'app.css'),['tokens.css','base.css','components.css','preview.css','titlebar.css','h1-overrides.css'].map(f=>fs.readFileSync(path.join(root,'src/ui/hifi/styles',f),'utf8')).join('\n'));
 fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div id="zs-titlebar"></div><div class="app" id="root"></div><script type="module" src="ui.mjs"></script>');
 fs.writeFileSync(path.join(out,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],screenshots=[];const check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
const mutating=call=>/reconcile|releaseProtection|redispatch|task.close|dispatch.resume/.test(call.method);
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const js=async code=>{try{return await win.webContents.executeJavaScript(code);}catch(error){throw Error(code+'\n'+error.message);}},snap=()=>js('r155.snapshot()');
 const until=async(code,label)=>{for(let i=0;i<170;i++){if(await js(code))return;await pause(20);}throw Error('timeout '+label+' '+JSON.stringify(await snap()));};
 const click=async text=>{const clicked=await js('(()=>{const b=[...document.querySelectorAll("[data-zs-recovery] button")].find(b=>b.textContent==='+JSON.stringify(text)+');if(!b||b.disabled)return false;b.click();return true;})()');if(!clicked)throw Error('Button unavailable: '+text);};
 const capture=async name=>{await pause(200);const size=name.endsWith('3440')?{width:3440,height:1440}:{width:1280,height:900};const file=path.join(__dirname,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage({x:0,y:0,...size})).toPNG());screenshots.push(file);};
 const close=async()=>{await click('关闭');await until('!document.querySelector("[data-zs-recovery]")','closed');};
 const open=async()=>{await js('r155.open({turnId:"held-turn",taskId:"child",requestTaskId:"parent"})');await until('!!document.querySelector("[data-zs-recovery-focused]")','open');};
 const reload=async()=>{const n=(await snap()).calls.filter(c=>c.method==='recovery.inspect').length;await click('重新检查状态');await until('r155.snapshot().calls.filter(c=>c.method==="recovery.inspect").length>'+n,'inspect refresh');await pause(40);};
 try{
  await win.loadFile(path.join(__dirname,'index.html'));await until('window.r155&&document.querySelector("[data-zs-execution-action=recover]")','parent action');let s=await snap();
  check('render-is-read-only',!s.calls.some(mutating),s.calls);
  check('action-describes-interruption',await js('document.querySelector("[data-zs-execution-action=recover]").textContent==="检查中断"'));
  await js('document.querySelector("[data-zs-execution-action=recover]").click()');await until('document.querySelector("[data-zs-exit-check=blocked]")','focused child inspection');s=await snap();
  check('backend-parent-action-preserves-exact-child',s.events.at(-1).target.turnId==='held-turn'&&s.events.at(-1).target.taskId==='child'&&s.events.at(-1).target.runId==='child-run'&&s.events.at(-1).target.requestTaskId==='parent',s.events);
  check('App-delivers-target-without-same-page-navigation',s.hash==='#/welcome'&&s.focused==='held-turn',s.hash);
  check('specific-child-member-last-tool-missing-result-visible',s.text.includes('Pi · Pi 生成六件套测试文件')&&s.text.includes('python -')&&s.text.includes('本轮未收到完整结果，不能视为任务完成')&&!s.text.includes('已保存回复：'),s.text);
  check('restart-guidance-and-no-release-button',s.text.includes('请保存其他工作并重启一次 Windows')&&!s.text.includes('解除占用\n'),s.text);
  check('opening-inspects-only-the-actual-turn',s.calls.some(c=>c.method==='recovery.inspect'&&c.params.turnId==='held-turn')&&!s.calls.some(mutating),s.calls);
  await capture('01-parent-to-child-restart-windows-1280');
  await reload();s=await snap();check('restart-recheck-is-readonly',!s.calls.some(mutating),s.calls);
  await js('r155.scenario("ready")');await reload();await until('document.querySelector("[data-zs-exit-check=ready]")','ready');s=await snap();
  check('ready-shows-saved-answer-and-file-without-completion-claim',s.text.includes('已保存部分整理记录')&&s.text.includes('测试说明.md')&&s.text.includes('本轮未收到完整结果'),s.text);
  check('ready-does-not-write-before-explicit-click',!s.calls.some(mutating),s.calls);
  await capture('02-ready-explicit-release-1280');
  await js('r155.scenario("restart")');await click('解除占用');await until('document.querySelector("[data-zs-exit-check=blocked]")','ready proof changed');s=await snap();
  check('stale-ready-rechecks-and-does-not-release',!s.calls.some(mutating),s.calls);
  await js('r155.scenario("ready",{releaseError:true})');await reload();await until('document.querySelector("[data-zs-exit-check=ready]")','ready failed release');
  await click('解除占用');await until('document.body.innerText.includes("旧执行退出证据已变化")','honest release error');s=await snap();
  check('release-failure-keeps-protection-and-shows-reason',!!(await js('document.querySelector("[data-zs-exit-check=ready]")'))&&!s.text.includes('此项仅保留为历史记录')&&s.text.includes('旧执行退出证据已变化'),s.text);
  const prior=s.calls.filter(c=>c.method==='recovery.releaseProtection').length;
  await js('r155.scenario("ready")');await reload();await js('const b=[...document.querySelectorAll("[data-zs-recovery] button")].find(b=>b.textContent==="解除占用");b.click();b.click()');
  await until('document.querySelector("[data-zs-exit-check=released]")','released');s=await snap();
  const releases=s.calls.filter(c=>c.method==='recovery.releaseProtection');
  check('explicit-release-exactly-once-for-settled-child',releases.length===prior+1&&releases.at(-1).params.turnId==='held-turn'&&releases.at(-1).params.endPreviousExecution===true&&!s.calls.some(c=>c.method==='recovery.reconcile'),releases);
  check('released-UNKNOWN-is-readable-history-with-no-attention',s.text.includes('此项仅保留为历史记录，不再阻挡新消息')&&s.text.includes('本轮未收到完整结果')&&!s.text.includes('上次处理尚有待检查事项'),s.text);
  check('release-never-resumes-closes-or-replays',!s.calls.some(c=>/redispatch|task.close|dispatch.resume/.test(c.method)),s.calls);
  await capture('03-released-unknown-history-1280');
  await click('回原任务继续');await until('location.hash.includes("task=child")&&!document.querySelector("[data-zs-recovery]")','formal child task route');s=await snap();
  check('child-record-link-resolves-real-child-details',s.hash==='#/thread/thread?tab=task&task=child'&&s.calls.some(c=>c.method==='deepLink.resolve'&&c.params.hash==='#task=child'),s.hash);
  await js('location.hash="#/welcome"');await open();await until('document.querySelector("[data-zs-exit-check=released]")','reopen released');await click('回父任务继续或结束');await until('location.hash==="#/thread/thread?tab=task"&&!document.querySelector("[data-zs-recovery]")','formal parent task route');
  s=await snap();check('parent-link-opens-parent-context-without-execution',s.calls.some(c=>c.method==='deepLink.resolve'&&c.params.hash==='#task=parent')&&!s.calls.some(c=>/redispatch|task.close|dispatch.resume/.test(c.method)),s.hash);
  await js('location.hash="#/welcome";r155.scenario("released");r155.boot("ready")');await until('r155.snapshot().attention==="0"','released no sidebar attention');
  await js('r155.open()');await until('document.body.innerText.includes("没有需要处理的事项")','general panel excludes released');s=await snap();
  check('general-entry-omits-released-history',s.inspectionCount===0&&s.attention==='0',s);
  const beforeRefresh=s.calls.filter(c=>c.method==='recovery.inspect').length;await click('重新检查状态');await pause(80);s=await snap();
  check('released-cache-refresh-does-not-reinspect-or-restore-attention',s.inspectionCount===0&&s.attention==='0'&&s.calls.filter(c=>c.method==='recovery.inspect').length===beforeRefresh,s);
  await close();await js('r155.boot("pending");r155.scenario("restart",{empty:true})');await open();await until('document.querySelector("[data-zs-exit-check=blocked]")','explicit target without aggregate rows');s=await snap();
  check('explicit-turn-inspected-even-with-empty-global-lists',s.focused==='held-turn'&&s.text.includes('Pi · Pi 生成六件套测试文件')&&!s.text.includes('没有需要处理的事项'),s.text);
  win.setSize(3440,1440);await capture('04-parent-to-child-restart-windows-3440');win.setSize(1280,900);
  await js('r155.scenario("error",{empty:true})');await reload();await until('document.body.innerText.includes("检查失败：程序检查暂时不可用")','inspection error');s=await snap();
  check('inspection-error-visible-without-release-action',s.text.includes('检查失败：程序检查暂时不可用')&&!s.text.includes('解除占用\n'),s.text);
  await js('r155.scenario("mismatch",{empty:true})');await reload();await until('document.body.innerText.includes("中断任务归属与打开时不一致")','mismatch refuses');s=await snap();
  check('changed-task-binding-refused-with-no-unsafe-action',s.text.includes('中断任务归属与打开时不一致')&&!s.text.includes('解除占用\n'),s.text);
  check('never-opens-legacy-or-calls-a-model',!(await js('document.body.classList.contains("legacy-on")'))&&!s.calls.some(c=>/message.submit|turn.start|dm.resume/.test(c.method)),s.calls);
  const report={ok:checks.every(c=>c.ok),realBusinessCalls:0,userDatabaseOpened:false,checks,screenshots};fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
 }catch(e){fs.writeFileSync(path.join(__dirname,'error.txt'),e.stack);fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(2);}
});setTimeout(()=>app.exit(3),28000);
`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];
 const proc=spawnSync(require('electron'),[path.join(out,'main.cjs')],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:32000});
 if(!fs.existsSync(path.join(out,'result.json')))throw Error(`R155 exited ${proc.status}: ${fs.existsSync(path.join(out,'error.txt'))?fs.readFileSync(path.join(out,'error.txt'),'utf8'):proc.stderr}; evidence ${out}`);
 return {...JSON.parse(fs.readFileSync(path.join(out,'result.json'),'utf8')),evidence:out};
}
module.exports={runVerifier};
