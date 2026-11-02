/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
// Isolated renderer proof: production App/loader/components, simulated command
// responses, native Chromium clicks. No daemon, user database, or model calls.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const renderer = String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '../../../src/ui/hifi/App.tsx';
import * as store from '../../../src/ui/hifi/data/store.ts';
import {applyServerNavPrefs,refreshMembers,loadDmProjectIndex,loadDmHistory,loadSidebarRooms} from '../../../src/ui/hifi/loader.ts';
import {navigate} from '../../../src/ui/hifi/lib/router.ts';
import {configureReadingPositions} from '../../../src/ui/hifi/data/readingPositions.ts';
import {roomActivityState,summarizeRoomActivity} from '../../../src/contracts/roomActivity.ts';
import {defaultAiAvatarPreset} from '../../../src/ui/hifi/data/avatarPresets.ts';
const calls=[],receipts=new Map(),avatars={};let pins=[],failPin=false;let next=0,uncertain=false,held=false,releaseCreate=null;
let focused=true,visible=true,roomA=13,roomB=8;const histories={},reads={},forced={},roomPhases={};
Object.defineProperty(document,'hasFocus',{value:()=>focused,configurable:true});Object.defineProperty(document,'visibilityState',{get:()=>visible?'visible':'hidden',configurable:true});
const kinds=['claude','codex','deepseek-harness','pi'];
const projects=['A','B','hidden'].map(id=>({id,displayName:'项目 '+id,rootPath:'C:/synthetic/'+id,canonicalPath:'C:/synthetic/'+id,status:'ok',revision:0,isGit:false}));
const members=id=>kinds.map(kind=>({id:'m_default_'+kind+'_'+id,projectId:id,displayName:{claude:'Claude',codex:'Codex','deepseek-harness':'DeepSeek Harness',pi:'Pi'}[kind],principalType:'agent',enabled:true,revision:0}));
for(const id of ['A','B'])for(const m of members(id))avatars['member:'+m.id]=defaultAiAvatarPreset().dataUrl;
const day=(ago)=>{const value=new Date();value.setDate(value.getDate()-ago);value.setHours(13,14,0,0);return value.getTime();};
const dm=(id,projectId,at)=>({conversationId:id,projectId,peerMemberId:'m_default_claude_'+projectId,peerDisplayName:'Claude',title:id,revision:0,execState:'idle',lastMessagePreview:'最近一条回复',lastReplyAt:at,lastMessageAt:at});
const lists={A:[dm('a-old','A',new Date(2026,9,15).getTime()),dm('a-before','A',day(2)),dm('a-yesterday','A',day(1)),dm('a-today','A',day(0))],B:[dm('b-today','B',day(0)-3600000)],hidden:[dm('never-visible','hidden',day(0))]};
lists.A=Array.from({length:13},(_,i)=>dm('many-A-'+i,'A',day(0)-i*60000));
lists.B=Array.from({length:8},(_,i)=>dm('many-B-'+i,'B',day(0)-i*60000));
const history=id=>histories[id]??(histories[id]=[{id:id+'-self',conversationSeq:1,authorType:'human',authorId:'viewer',bodyJson:'{"text":"测试"}',createdAt:day(0)},{id:id+'-reply',conversationSeq:2,authorType:'agent',authorId:'m_default_claude_'+(id.includes('-B-')?'B':'A'),bodyJson:'{"text":"收到"}',createdAt:day(0)}]);
const ok=data=>({ok:true,data});
window.zs={command:async env=>{
 calls.push(structuredClone(env));const p=env.params,id=p.projectId??store.getState().activeProjectId;
 if(env.method==='app.appearance.get')return ok({showAvatars:true,avatars:{...avatars}});
 if(env.method==='app.appearance.set'){avatars[p.avatar.subject]=p.avatar.dataUrl;return ok({showAvatars:true,avatars:{...avatars}});}
 if(env.method==='app.settings.get')return ok({values:{}});
 if(env.method==='recovery.status')return ok({gateHeld:false,unknownTurns:[],pendingRelease:[],interruptedRuns:[],activeUndos:[]});
 if(env.method==='conversation.list')return ok({conversations:(lists[id]??[]).map(dm=>({...dm,lastMessageSeq:history(dm.conversationId).at(-1).conversationSeq,lastReadSeq:reads[dm.conversationId]??0,unread:forced[dm.conversationId]??history(dm.conversationId).filter(message=>message.authorType==='agent'&&message.conversationSeq>(reads[dm.conversationId]??0)).length,execState:dm.conversationId==='many-A-1'?'running':'idle'}))});
 if(env.method==='conversation.markRead'){reads[p.conversationId]=Math.max(reads[p.conversationId]??0,p.throughMessageSeq);return ok({advanced:true});}
 if(env.method==='conversation.history')return ok({messages:structuredClone(history(p.conversationId))});
 if(env.method==='conversation.failedTasks')return ok({conversationId:p.conversationId,items:[],truncated:false});
 if(env.method==='conversation.create'){
  if(receipts.has(env.commandId))return ok(receipts.get(env.commandId));
  if(held)await new Promise(resolve=>{releaseCreate=resolve;});else await new Promise(resolve=>setTimeout(resolve,180));
  const conversationId='new-'+(++next),peer=members(id).find(m=>m.id===p.peerMemberId);
  lists[id].unshift({...dm(conversationId,id,null),peerMemberId:p.peerMemberId,peerDisplayName:peer.displayName,lastMessageAt:0});
  const result={conversationId};receipts.set(env.commandId,result);
  if(uncertain){uncertain=false;throw Error('模拟回执丢失');}return ok(result);
 }
 if(env.method==='member.list')return ok({items:members(id)});
 if(env.method==='member.runtimes')return ok({projectId:id,items:members(id).map((member,index)=>({memberId:member.id,info:{binding:{installationId:'fixture',model:'fixture-model'},installation:{id:'fixture',kind:kinds[index]},effective:{source:'binding',kind:kinds[index],model:'fixture-model'}}}))});
 if(env.method==='memberTemplate.list')return ok({items:[],templates:[],nextCursor:null});
 if(env.method==='runtime.status')return ok({memberBindings:members(id).map((member,index)=>({memberId:member.id,kind:kinds[index],model:'fixture-model'}))});
 if(env.method==='room.list')return ok({items:Array.from({length:id==='A'?roomA:roomB},(_,i)=>({id:'room-'+id+'-'+i,projectId:id,name:'房间 '+id+' '+(i+1),conversationId:'room-conv-'+id+'-'+i,memberIds:members(id).map(m=>m.id),revision:0,activity:summarizeRoomActivity([roomActivityState({phase:roomPhases['room-'+id+'-'+i]??'COMPLETED',waitingForUser:null,evidence:{taskStatus:'DONE'}})])}))});
 if(env.method==='project.memberWorkload')return ok({projectId:id,items:members(id).map(member=>({memberId:member.id,unfinishedTasks:0,activeTurns:0,unknownTurns:0})),truncated:false});
 if(env.method==='board.view')return ok({groups:['A','B'].map(projectId=>({projectId,displayName:'项目 '+projectId,rooms:[{roomId:'room-'+projectId,name:'默认房间',cards:projectId==='A'?[{taskId:'one-task',title:'一张任务卡片',projectId,roomId:'room-A',roomTaskNumber:1,threadId:null,ownerMemberId:null,taskStatus:'DONE',runStatus:'SUCCEEDED',runId:'run',stopGeneration:0,column:'done',exitUnconfirmed:false,statusReason:null,pendingDelivery:null,locate:'#task=one-task'}]:[]}]}))});
 if(env.method==='navigation.get')return ok({prefs:null,pins:structuredClone(pins)});
 if(env.method==='navigation.pin'){
  const previous=pins.find(pin=>pin.kind===p.kind&&pin.itemId===p.itemId);
  const pin=p.pinned?{kind:p.kind,projectId:p.projectId,itemId:p.itemId,label:p.kind==='room'?'默认房间':p.itemId,pinnedAt:previous?.pinnedAt??Date.now()}:null;
  pins=[...(pin?[pin]:[]),...pins.filter(item=>item.kind!==p.kind||item.itemId!==p.itemId)];
  if(failPin){failPin=false;throw Error('模拟回执丢失');}
  return ok({pin});
 }
 if(env.method==='navigation.set')return ok({saved:true});
 return {ok:false,error:{code:'TEST_UNSUPPORTED',message:'测试未提供：'+env.method}};
},onDisconnect:()=>{},onReconnected:()=>{}};
store.setState(s=>({...s,boot:'ready',conn:'online',projects,activeProjectId:'A',visibleProjectIds:['A','B'],pinnedProjectIds:[],expandedProjectIds:['A'],members:[],rooms:[],dms:[],dmProjectIndexes:{},ui:{...s.ui,showAvatars:true,avatars:{...avatars}}}));
configureReadingPositions('r161-isolated');document.body.classList.add('hifi-on');location.hash='#/dm';
createRoot(document.getElementById('root')).render(<App/>);void refreshMembers('A');
window.proof={navigate,
 refreshHistory:()=>loadDmHistory('many-A-0',{markRead:true}),refreshAll:()=>Promise.all(['A','B'].flatMap(id=>[loadSidebarRooms(id),loadDmProjectIndex(id)])),
 addReply:(id,long=false)=>{const messages=history(id),seq=messages.at(-1).conversationSeq;messages.push({id:id+'-self-'+seq,conversationSeq:seq+1,authorType:'human',authorId:'viewer',bodyJson:'{"text":"新的问题"}',createdAt:day(0)},{id:id+'-reply-'+seq,conversationSeq:seq+2,authorType:'agent',authorId:'m_default_claude_A',bodyJson:JSON.stringify({text:long?'这是一段用于验证阅读位置的长回复。'.repeat(350):'新的回复'}),createdAt:day(0)});},
 focus:(value,isVisible=true)=>{focused=value;visible=isVisible;if(value&&isVisible){document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));}},
 force:(value)=>{forced['many-A-1']=value;return loadDmProjectIndex('A');},
 size:async(a,b)=>{roomA=a;roomB=b;lists.A=Array.from({length:a},(_,i)=>dm('many-A-'+i,'A',day(0)-i*60000));lists.B=Array.from({length:b},(_,i)=>dm('many-B-'+i,'B',day(0)-i*60000));await Promise.all(['A','B'].flatMap(id=>[loadSidebarRooms(id),loadDmProjectIndex(id)]));},
 roomPhase:(phase)=>{roomPhases['room-A-0']=phase;},roomRefresh:()=>loadSidebarRooms('A'),
reloadPins:async()=>{store.setState(s=>({...s,navigationPins:[]}));await applyServerNavPrefs();},failPin:()=>{failPin=true;},hideB:()=>store.setState(s=>({...s,visibleProjectIds:['A']})),showB:()=>store.setState(s=>({...s,visibleProjectIds:['A','B']})),uncertain:()=>{uncertain=true;},hold:()=>{held=true;},release:()=>{held=false;releaseCreate?.();releaseCreate=null;},
 snapshot:()=>({reads:structuredClone(reads),pins:structuredClone(pins),uiPins:store.getState().navigationPins,hash:location.hash,project:store.getState().activeProjectId,geometry:(()=>{const e=document.querySelector(".msg-list");return e?{top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight}:null;})(),calls:calls.filter(call=>!call.method.startsWith("app.appearance")).map(call=>({method:call.method,params:call.params})),creates:calls.filter(c=>c.method==='conversation.create'),logicalCreates:next,
  groups:[...document.querySelectorAll('[data-zs-dm-project]')].map(el=>el.dataset.zsDmProject),
  rows:[...document.querySelectorAll('[data-zs-dm-project="A"] [data-zs-dm-id]')].map(el=>({id:el.dataset.zsDmId,time:el.querySelector('time')?.textContent})),
  modal:!!document.querySelector('[data-zs-create-dm-member]'),text:document.body.innerText.slice(0,1200),
  avatars:kinds.map(kind=>store.getState().ui.avatars['member:m_default_'+kind+'_A']===defaultAiAvatarPreset(kind).dataUrl),
  held:!!releaseCreate,
  pickerAvatars:kinds.map(kind=>store.getState().ui.avatars['member:m_default_'+kind+'_B']===defaultAiAvatarPreset(kind).dataUrl),
 })};

`;

async function prove(out) {
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  app.setPath('userData', path.join(out, 'isolated-profile'));
  const checks = [], screenshots = [], errors = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const until = async (code, label) => {
    for (let i = 0; i < 400; i++) { if (await js(code)) return; await pause(20); }
    throw Error('Timeout ' + label + ': ' + JSON.stringify(await js('proof.snapshot()')));
  };
  const click = async (selector, index = 0, button = 'left') => {
    const rect = await js(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest',behavior:'instant'});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button, clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button, clickCount: 1 });
    await pause(60);
  };
  const capture = async name => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); screenshots.push(file);
  };
  try {
    await win.loadFile(path.join(out,'index.html'));
    await until('window.proof&&proof.snapshot().reads["many-A-0"]===2&&document.querySelectorAll("[data-zs-dm-project=A] [data-zs-dm-id]").length===5','initial read and global compact list');
    const count=(kind,id)=>js('document.querySelectorAll('+JSON.stringify('[data-zs-project-list="'+kind+':'+id+'"] '+(kind==='room'?'[data-zs-room-row]':'[data-zs-dm-id]'))+').length');
    check('global-21-across-projects-compacts-each-dm-group',(await count('dm','A'))===5&&(await count('dm','B'))===5);
    check('collapsed-projects-are-included-in-room-total',(await count('room','A'))===5);
    await click('.side-project .side-caret',1);check('global-21-compacts-each-room-group',(await count('room','A'))===5&&(await count('room','B'))===5);
    await js('proof.size(12,8)');check('global-exactly-20-shows-every-row',(await count('dm','A'))===12&&(await count('dm','B'))===8&&(await count('room','A'))===12&&(await count('room','B'))===8);
    await js('proof.size(13,8)');await until('document.querySelectorAll("[data-zs-dm-project=A] [data-zs-dm-id]").length===5','21 compacts again');
    for(const kind of ['room','dm']){await click('[data-zs-show-more="'+kind+':A"]');check(kind+'-show-more-is-independent',(await count(kind,'A'))===13&&(await count(kind,'B'))===5);}
    check('dm-rows-and-private-entry-use-no-blue-dots',await js('!document.querySelector(".dm-row .nav-dot")&&![...document.querySelectorAll(".sidebar-top .side-item")].find(el=>el.textContent.includes("私信"))?.querySelector(".side-unread-dot")'));
    for(const value of [1,12,105]){await js('proof.force('+value+')');const box=await js('(()=>{const e=document.querySelector("[data-zs-dm-id=many-A-1] .dm-unread-count"),r=e.getBoundingClientRect();return{w:r.width,h:r.height,text:e.textContent,label:e.getAttribute("aria-label")};})()');check('unread-'+value+'-is-circular-and-accessible',Math.abs(box.w-box.h)<0.5&&box.label.includes(String(value)),box);}
    await js('proof.force(1);proof.addReply("many-A-0",true);proof.refreshHistory()');await until('proof.snapshot().reads["many-A-0"]===4','new foreground reply marked');
    check('foreground-reply-is-read-without-page-switch',await js('!document.querySelector("[data-zs-dm-id=many-A-0] .dm-unread-count")'));
    win.setSize(1440,460);await pause(80);
    const wheel=async delta=>{await js('(()=>{const e=document.querySelector(".msg-list");e.dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:'+delta+'}));e.scrollTop='+(delta>0?'e.scrollHeight':'0')+';e.dispatchEvent(new Event("scroll",{bubbles:true}));})()');await pause(100);};
    await wheel(-100000);await until('document.querySelector(".msg-list").scrollHeight-document.querySelector(".msg-list").scrollTop-document.querySelector(".msg-list").clientHeight>80','scrolled into history');
    await js('proof.addReply("many-A-0");proof.refreshHistory()');await js('proof.refreshAll()');
    check('reading-older-history-does-not-ack-new-reply',(await js('proof.snapshot().reads["many-A-0"]'))===4);
    await wheel(100000);await until('proof.snapshot().reads["many-A-0"]===6','scroll to bottom marks rendered reply');
    await js('proof.focus(false);proof.addReply("many-A-0");proof.refreshHistory()');await js('proof.refreshAll()');
    check('unfocused-conversation-retains-unread',(await js('proof.snapshot().reads["many-A-0"]'))===6);
    await js('proof.focus(true)');await until('proof.snapshot().reads["many-A-0"]===8','focus returns');
    await js('proof.focus(true,false);proof.addReply("many-A-0");proof.refreshHistory()');await js('proof.refreshAll()');
    check('hidden-conversation-retains-unread',(await js('proof.snapshot().reads["many-A-0"]'))===8);
    await js('proof.focus(true,true)');await until('proof.snapshot().reads["many-A-0"]===10','visible again');
    await click('[data-zs-dm-id=many-B-0]');await until('proof.snapshot().project==="B"&&proof.snapshot().reads["many-B-0"]===2','B conversation');
    await js('proof.addReply("many-A-0");proof.refreshAll()');check('another-conversation-is-not-marked-read',(await js('proof.snapshot().reads["many-A-0"]'))===10);
    await js('proof.roomPhase("RUNNING")');await until('document.querySelector("[data-zs-room-row=room-A-0] [data-zs-nav-task-state=ACTIVE]")','sidebar polls while reading a private message');
    check('room-running-state-refreshes-independently-of-room-page',true);
    await js('proof.roomPhase("QUEUED");proof.roomRefresh()');await until('document.querySelector("[data-zs-room-row=room-A-0] [data-zs-nav-task-state=QUEUED]")','room queue');
    await js('proof.roomPhase("COMPLETED");proof.roomRefresh()');check('completed-room-removes-running-marker',await js('!document.querySelector("[data-zs-room-row=room-A-0] [data-zs-nav-task-state]")'));
    win.setSize(1440,900);await pause(100);await capture('01-unread-global-limits-room-status');
    win.setSize(900,760);await pause(80);await capture('02-narrow-unread-and-limits');check('narrow-window-does-not-overflow',await js('document.documentElement.scrollWidth<=innerWidth'));
    check('no-render-errors',errors.length===0,errors);
    const result = { ok: checks.every(c => c.ok), checks, screenshots, realModelCalls: 0, userDataOpened: false };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    win.destroy(); app.exit(result.ok ? 0 : 1);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'error.txt'), error.stack);
    await capture('failure'); win.destroy(); app.exit(2);
  }
}

async function run() {
  const out = path.join(root, 'dist/r163-unread-status', String(Date.now()));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'entry.tsx'), renderer);
  await require('esbuild').build({ entryPoints: [path.join(out, 'entry.tsx')], outfile: path.join(out, 'ui.mjs'),
    bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.png': 'dataurl' }, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
  fs.writeFileSync(path.join(out, 'app.css'), ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css', 'h1-overrides.css']
    .map(file => fs.readFileSync(path.join(root, 'src/ui/hifi/styles', file), 'utf8')).join('\n'));
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>#root{position:fixed;inset:38px 0 0;height:auto}</style><div id="zs-titlebar"></div><div id="root"></div><script type="module" src="ui.mjs"></script>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
  const child = spawnSync(require('electron'), [__filename, '--probe-out', out], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
  if (!fs.existsSync(path.join(out, 'result.json'))) throw Error(`UI proof exited ${child.status}: ${fs.existsSync(path.join(out, 'error.txt')) ? fs.readFileSync(path.join(out, 'error.txt'), 'utf8') : child.stderr}; ${out}`);
  const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
  console.log(JSON.stringify({ ...result, evidence: out }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
if (process.versions.electron) prove(process.argv[process.argv.indexOf('--probe-out') + 1]);
else run().catch(error => { console.error(error); process.exitCode = 1; });
