/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
// Render the actual shell and pages. Every command stays inside this synthetic bridge.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const renderer=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../../src/ui/hifi/App.tsx';
import {RoomPage} from '../../../src/ui/hifi/RoomPage.tsx';
import {ThreadPage} from '../../../src/ui/hifi/ThreadPage.tsx';
import {RecoveryPanel} from '../../../src/ui/hifi/components/RecoveryPanel.tsx';
import * as store from '../../../src/ui/hifi/data/store.ts';
import {navigate} from '../../../src/ui/hifi/lib/router.ts';
const calls=[],opened=[],legacy=[];
let undoMode='succeeded',undoRows=[];
const member={id:'m',projectId:'p',profileId:'',displayName:'测试成员',ordinal:1,principalType:'agent',enabled:true,workState:'idle',model:'fixture',effort:'low',internalSubagents:false,isCoordinatorDefault:true};
const room={id:'r',projectId:'p',conversationId:'rc',name:'测试房间',coordinatorMemberId:'m',memberIds:['m'],revision:1,unread:0};
const thread={id:'t',projectId:'p',roomId:'r',conversationId:'rc',anchorMessageId:'root',rootTaskId:'rt',status:'open',lastMessageSeq:0,revision:1};
const anchor={id:'root',authorType:'human',authorId:'u',body:{text:'请核对这项任务'},createdAt:1};
const task={id:'rt',projectId:'p',roomId:'r',conversationId:'rc',conversationThreadId:'t',rootMessageId:'root',title:'房间任务',objective:'核对任务',status:'DONE',revision:1,stopGeneration:0,roomTaskNumber:1,ownerMemberId:'m',mode:'DIRECT',reviewPolicy:'auto_deliver',activeRun:{id:'rr',status:'SUCCEEDED',mode:'DIRECT'},latestRun:{id:'rr',status:'SUCCEEDED',mode:'DIRECT'}};
let conversations=[{conversationId:'c',projectId:'p',peerDisplayName:'测试成员',title:'测试私信',unread:0,revision:2,execState:'idle',archivedAt:null,interruptedTasks:[]},{conversationId:'c2',projectId:'p',peerDisplayName:'测试成员',title:'另一条私信',unread:0,revision:1,execState:'idle',archivedAt:null,interruptedTasks:[]}];
const dmRows=()=>conversations.map(c=>({...c,id:c.conversationId,memberIds:['m'],threadId:'dm-thread',createdAt:1,lastMessageAt:1}));
const success=data=>({ok:true,data});
const details=(id,conversationId)=>({task:{...task,id,conversationId:conversationId??'rc',title:id==='dt'?'已保存的私信任务':'房间任务',roomId:id==='dt'?null:'r'},failedRetry:{available:false,reason:'不可重试'},latestRunId:'rr',selectedRunId:'rr',
  runs:[{id:'rr',status:'SUCCEEDED',mode:'DIRECT',budget:null,stage:null,participants:[],turns:[],events:[],createdAt:1}],children:[],events:[],deliveries:[],artifacts:[],changeSets:[],truncated:{},history:{}});
window.__zsLegacyStart=()=>legacy.push('start');window.__zsLegacySetVisible=visible=>legacy.push(visible);
window.zs={command:async env=>{
 calls.push(JSON.parse(JSON.stringify(env)));const p=env.params;
 switch(env.method){
  case 'conversation.list':return success({conversations});
  case 'conversation.history':return success({messages:[],progress:[]});
  case 'conversation.failedTasks':return success({conversationId:p.conversationId,items:[],truncated:false});
  case 'conversation.rename':{const c=conversations.find(c=>c.conversationId===p.conversationId);if(c.revision!==p.expectedRevision)throw Error('CAS mismatch');c.title=p.title;c.revision++;return success({});}
  case 'conversation.archive':{const c=conversations.find(c=>c.conversationId===p.conversationId);if(c.revision!==p.expectedRevision)throw Error('CAS mismatch');c.archivedAt=123;c.revision++;return success({archived:true,already:false,stopPending:false});}
  case 'conversation.restore':{const c=conversations.find(c=>c.conversationId===p.conversationId);c.archivedAt=null;c.revision++;return success({});}
  case 'export.create':return success({exportId:'export-'+p.format,dir:'synthetic-exports/'+p.format,files:['record.'+p.format],stats:{messages:0,attachments:0,missing:0}});
  case 'conversation.tasks':return success({conversationId:p.conversationId,items:[{id:'dt',title:'已保存的私信任务',status:'DONE',revision:1,latestRun:{id:'rr',status:'SUCCEEDED'}}],nextCursor:null});
  case 'task.details':return success(details(p.taskId,p.conversationId));
  case 'task.redispatch':return success({enqueued:true});
  case 'app.appearance.get':return success({showAvatars:true,avatars:{}});
  case 'app.settings.get':return success({values:{'callBudget.enabled':'false'}});
  case 'recovery.status':return success({gateHeld:false,unknownTurns:[],pendingRelease:[],activeUndos:undoRows,interruptedRuns:[],pendingDispatchCount:0,pendingDispatchKeys:[],heldLeases:[],stopRecord:null});
  case 'changeset.undo':await new Promise(resolve=>setTimeout(resolve,100));if(undoMode==='error')return {ok:false,error:{code:'WORKSPACE_BUSY',message:'该项目仍有文件修改正在进行'}};if(undoMode!=='failed')undoRows=[];return success({status:undoMode,manualPaths:undoMode==='succeeded'?[]:['result.txt'],steps:[]});
  case 'navigation.preferences.update':return success({});
  case 'thread.get':return p.threadId==='t'?success({thread,anchor,readSeq:0}):{ok:false,error:{code:'RESOURCE_NOT_FOUND',message:'找不到该对话串'}};
  case 'thread.history':return success({items:[],nextCursor:null,rootAttachments:[]});
  case 'thread.subscriptions':return success({items:[]});
  case 'thread.membership':return success({projectId:'p',threadId:'t',roomId:'r',version:'v1',memberIds:['m'],eligibleMemberIds:['m'],runningMemberIds:[]});
  case 'task.get':return success({task});
  case 'room.pool':return success({items:[],nextCursor:null});
  case 'room.list':return success({items:[room]});
  case 'room.members':return success({memberIds:['m'],members:[member]});
  case 'run.progress':return success({items:[]});
  case 'thread.toolCalls':return success({items:[]});
  case 'attachment.listByConversation':return success({items:[]});
  case 'files.view':return success({groups:[]});
  default:return {ok:false,error:{code:'SYNTHETIC_ONLY',message:'隔离测试未连接后台：'+env.method}};
 }
},openPath:async dir=>{opened.push(dir);return '';},onDisconnect:()=>{},onReconnected:()=>{}};
store.initDraftPersistence('r153-navigation-synthetic');
store.setState(s=>({...s,boot:'ready',conn:'online',activeProjectId:'p',projects:[{id:'p',displayName:'隔离项目',rootPath:'合成目录',status:'active',revision:1}],visibleProjectIds:['p'],expandedProjectIds:['p'],rooms:[room],members:[member],memberRuntimes:{m:{status:'bound',kind:'fake',model:'fixture'}},sidebarRoomIndexes:{p:{status:'ready',rooms:[room]}},dms:dmRows(),dmHistory:{c:[],c2:[]},threadEntities:{t:thread},threadAnchors:{t:{...anchor,projectId:'p',roomId:'r',body:'请核对这项任务'}},threadMessages:{t:[]},threadTasks:{t:task},threads:[thread],tasks:[task],messages:[{...anchor,projectId:'p',roomId:'r',body:'请核对这项任务',kind:'text'}]}));
document.body.classList.add('hifi-on');
const reactRoot=createRoot(document.getElementById('hifi-root'));
const mount=mode=>{reactRoot.render(null);setTimeout(()=>reactRoot.render(mode==='compat-room'?<RoomPage roomId="r"/>:mode==='compat-thread'?<ThreadPage threadId="t" initialTab="task"/>:mode==='undo'?<RecoveryPanel onClose={()=>mount('app')}/>:<App/>),0);};
navigate('/dm/c');mount('app');
window.r153={calls,opened,legacy,mount,navigate,
 undo:mode=>{undoMode=mode;undoRows=[{id:'undo-'+mode,changeSetId:'changeset-'+mode,status:'failed'}];mount('undo');},
 menu:()=>{document.querySelector('[data-zs-dm-ops]').click();},
 click:text=>{const el=[...document.querySelectorAll('button,[role="menuitem"]')].find(el=>(el.textContent.trim()===text||el.querySelector('span')?.textContent.trim()===text)&&!el.disabled);if(!el)throw Error('Missing button '+text+'; '+document.body.innerText);el.click();},
 rename:text=>{const el=[...document.querySelectorAll('input')].find(el=>el.value===conversations[0].title);if(!el)throw Error('rename input missing');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));},
 recover:()=>{conversations[0].interruptedTasks=[{taskId:'recover-dt',title:'保留的中断任务',lastRunId:'failed-run',lastRunStatus:'FAILED',recoverable:true,blockReason:null}];store.setState(s=>({...s,dms:dmRows()}));},
 snapshot:()=>({text:document.body.innerText,hash:location.hash,menu:document.querySelector('[role="menu"]')?.textContent,
  titles:[...document.querySelectorAll('[title]')].map(el=>el.title).join('\n'),legacyOn:document.body.classList.contains('legacy-on'),legacy:legacy.slice(),
  selected:[...document.querySelectorAll('[aria-selected="true"]')].map(el=>el.textContent),formalDetails:!!document.querySelector('.thread-details .details-subnav[aria-label="详情分组"]'),dmTitles:store.getState().dms.map(c=>c.title),records:!!document.querySelector('[data-zs-dm-task-records]'),
  archived:conversations[0].archivedAt!=null,calls:calls.slice(),opened:opened.slice()})};
`;

async function runVerifier(){
 const out=path.join(root,'dist/r153-product-navigation',`${Date.now()}-${process.pid}`);fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,'entry.tsx'),renderer);
 await require('esbuild').build({entryPoints:[path.join(out,'entry.tsx')],outfile:path.join(out,'ui.mjs'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',loader:{'.png':'dataurl'},logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
 fs.writeFileSync(path.join(out,'app.css'),['tokens.css','base.css','components.css','preview.css','titlebar.css','h1-overrides.css'].map(f=>fs.readFileSync(path.join(root,'src/ui/hifi/styles',f),'utf8')).join('\n'));
 fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div id="zs-titlebar"></div><div id="hifi-root"></div><script type="module" src="ui.mjs"></script>');
 fs.writeFileSync(path.join(out,'main.cjs'),String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),checks=[],screenshots=[];
const check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1440,height:950,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const js=code=>win.webContents.executeJavaScript(code);
 const until=async(code,label)=>{for(let i=0;i<160;i++){if(await js(code))return;await pause(20);}throw Error('timeout '+label+' '+JSON.stringify(await js('r153.snapshot()')));};
 const click=async text=>{await js('r153.click('+JSON.stringify(text)+')');await pause(75);};
 const snap=()=>js('r153.snapshot()');
 const capture=async name=>{await pause(60);fs.writeFileSync(path.join(__dirname,name+'.png'),(await win.webContents.capturePage()).toPNG());screenshots.push(name+'.png');};
 const menu=async()=>{await js('r153.menu()');await until('!!r153.snapshot().menu','menu');};
 try{
  await win.loadFile(path.join(__dirname,'index.html'));await until('window.r153&&!!document.querySelector("[data-zs-dm-ops]")','DM shell');
  await menu();let s=await snap();
  check('dm-menu-no-transition-entry',!/(原界面|旧界面|legacy|未换装)/i.test(s.menu+s.titles),s.menu);
  check('dm-menu-keeps-real-actions',['重命名','归档会话','Markdown','HTML','DOCX','任务记录'].every(text=>s.menu.includes(text)),s.menu);
  await capture('dm-menu');
  await click('重命名…');await js('r153.rename("更名后的私信")');await pause(30);await click('保存');await until('r153.snapshot().dmTitles.includes("更名后的私信")','rename');
  s=await snap();check('rename-uses-conversation-and-cas',s.calls.some(c=>c.method==='conversation.rename'&&c.params.conversationId==='c'&&c.params.expectedRevision===2&&c.params.title==='更名后的私信'));
  for(const [format,label]of [['md','Markdown'],['html','HTML'],['docx','DOCX']]){
   await menu();await click('导出 '+label+' 记录…');await pause(60);s=await snap();
   check('export-'+format+'-real-target',s.calls.some(c=>c.method==='export.create'&&c.params.format===format&&c.params.target.kind==='conversation'&&c.params.target.conversationId==='c'&&c.params.target.projectId==='p'));
   check('export-'+format+'-opens-receipt-directory',s.opened.includes('synthetic-exports/'+format));
  }
  await menu();await click('任务记录…');await until('r153.snapshot().records&&r153.snapshot().text.includes("已保存的私信任务")','records');await pause(80);s=await snap();
  check('task-records-use-scoped-reader',s.calls.some(c=>c.method==='conversation.tasks'&&c.params.projectId==='p'&&c.params.conversationId==='c')&&s.calls.some(c=>c.method==='task.details'&&c.params.taskId==='dt'&&c.params.conversationId==='c'));
  check('task-records-show-real-run',s.text.includes('运行详情')&&s.text.includes('工具与诊断活动'),s.text);
  check('records-do-not-start-work',!s.calls.some(c=>['message.submit','task.redispatch','task.retryFailed'].includes(c.method)));
  await capture('dm-task-records');await js('document.querySelector("[aria-label=关闭弹窗]")?.click()');
  if((await snap()).records){await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await pause(50);}
  await until('!r153.snapshot().records','close records');
  await menu();await click('归档会话…');
  s=await snap();check('archive-requires-confirmation',!s.archived&&!s.calls.some(c=>c.method==='conversation.archive'));
  await click('确认归档');await until('r153.snapshot().archived','archive');await menu();s=await snap();
  check('archive-retains-history-and-restore',s.menu.includes('取消归档')&&s.calls.some(c=>c.method==='conversation.archive'&&c.params.conversationId==='c'&&c.params.expectedRevision===3),s.menu);
  await click('取消归档');await until('!r153.snapshot().archived','restore');
  await js('r153.recover()');await until('r153.snapshot().text.includes("继续这次请求")','recovery action');await click('继续这次请求');
  s=await snap();check('explicit-recovery-keeps-source-run',s.calls.some(c=>c.method==='task.redispatch'&&c.params.taskId==='recover-dt'&&c.params.sourceRunId==='failed-run'));
  check('dm-operations-never-open-fallback',!s.legacyOn&&s.legacy.length===0,s.legacy);
  await js('r153.mount("compat-room")');await until('r153.snapshot().text.includes("打开房间")','compat room');await click('打开房间');s=await snap();
  check('compat-room-links-to-current-room',s.hash==='#/project/p/room/r'&&!s.legacyOn,s.hash);
  await js('r153.mount("app")');await until('!!document.querySelector(".room-page")||r153.snapshot().text.includes("测试房间")','current room');
  check('current-room-route-keeps-current-ui',!(await snap()).legacyOn);
  for(const [tab,label]of [['activity','活动与进展'],['members','参与成员'],['run','运行详情'],['deliberation','研讨详情']]){
   await js('r153.mount("compat-thread")');await until('r153.snapshot().text.includes("更多任务信息")','compat details');
   await js('document.querySelector("details.panel.info:last-of-type").open=true');await click(label);s=await snap();
   check('compat-'+tab+'-links-to-current-thread',s.hash==='#/thread/t?tab='+tab&&!s.legacyOn,s.hash);
   await js('r153.mount("app")');await until('!!document.querySelector(".details-subnav")','current thread details');await pause(100);s=await snap();
   check('current-'+tab+'-route-shows-details',!s.legacyOn&&s.formalDetails&&!s.text.includes('更多任务信息')&&s.selected.some(text=>text.includes(tab==='deliberation'?'任务概况':label)),{selected:s.selected,formalDetails:s.formalDetails,text:s.text});
  }
  await js('r153.navigate("/dm/c2")');await until('!!document.querySelector("[data-zs-dm-ops]")','second DM');await menu();s=await snap();
  check('switch-DM-does-not-restore-transition-entry',!s.menu.includes('原界面')&&!s.legacyOn,s.menu);
  await js('r153.navigate("/thread/missing")');await until('r153.snapshot().text.includes("找不到该对话串")','missing thread error');s=await snap();
  check('missing-thread-is-honest-error-without-legacy',!s.legacyOn&&s.legacy.length===0,s.text);
  for(const mode of ['succeeded','conflict','failed','error']){
   const before=s.calls.filter(c=>c.method==='changeset.undo').length;
   await js('r153.undo('+JSON.stringify(mode)+')');await until('!!document.querySelector("[data-zs-recovery-summary]")','undo status');await pause(40);s=await snap();
   check('undo-'+mode+'-read-is-not-execution',s.calls.filter(c=>c.method==='changeset.undo').length===before&&!s.text.includes('原界面'),s.text);
   await until('!!document.querySelector("[data-zs-continue-undo]")','continue undo');
   await js('document.querySelector("[data-zs-continue-undo]").click();document.querySelector("[data-zs-continue-undo]").click()');
   check('undo-'+mode+'-busy-disables-action',await js('document.querySelector("[data-zs-continue-undo]").disabled'));
   await until('!!document.querySelector("[data-zs-undo-result]")','undo outcome');await pause(40);s=await snap();
   const submitted=s.calls.filter(c=>c.method==='changeset.undo');
   check('undo-'+mode+'-exact-target-once',submitted.length===before+1&&submitted.at(-1).params.changeSetId==='changeset-'+mode,submitted);
   check('undo-'+mode+'-honest-outcome',mode==='succeeded'?s.text.includes('撤销已完成'):mode==='conflict'?s.text.includes('冲突文件未被覆盖')&&s.text.includes('result.txt'):mode==='failed'?s.text.includes('撤销尚未完成')&&s.text.includes('result.txt'):s.text.includes('文件修改正在进行'),s.text);
   check('undo-'+mode+'-no-legacy-navigation',!s.legacyOn&&s.legacy.length===0&&!s.text.includes('原界面'),s.text);
   if(mode==='conflict')await capture('recovery-undo-conflict');
  }
  check('no-real-message-or-model-command',!s.calls.some(c=>['message.submit','dm.resume'].includes(c.method)));
  check('no-legacy-entry-triggered',s.legacy.length===0,s.legacy);
  const report={ok:checks.every(c=>c.ok),realBusinessCalls:0,databaseOpened:false,checks,screenshots,calls:s.calls};fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
 }catch(e){fs.writeFileSync(path.join(__dirname,'error.txt'),e.stack);fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(2);}
});setTimeout(()=>app.exit(3),55000);
`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];
 const proc=spawnSync(require('electron'),[path.join(out,'main.cjs')],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:60000});
 if(!fs.existsSync(path.join(out,'result.json')))throw Error(`R153 exited ${proc.status}: ${fs.existsSync(path.join(out,'error.txt'))?fs.readFileSync(path.join(out,'error.txt'),'utf8'):proc.stderr}; evidence ${out}`);
 return {...JSON.parse(fs.readFileSync(path.join(out,'result.json'),'utf8')),evidence:out};
}
module.exports={runVerifier};
if(require.main===module)runVerifier().then(r=>{console.log(JSON.stringify({ok:r.ok,checks:r.checks.length,failed:r.checks.filter(c=>!c.ok),evidence:r.evidence},null,2));process.exitCode=r.ok?0:1;}).catch(e=>{console.error(e);process.exitCode=2;});
