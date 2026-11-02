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
import {applyServerNavPrefs,refreshMembers,loadDmProjectIndex} from '../../../src/ui/hifi/loader.ts';
import {navigate} from '../../../src/ui/hifi/lib/router.ts';
import {configureReadingPositions} from '../../../src/ui/hifi/data/readingPositions.ts';
import {defaultAiAvatarPreset} from '../../../src/ui/hifi/data/avatarPresets.ts';
const calls=[],receipts=new Map(),avatars={};let pins=[],failPin=false;let next=0,uncertain=false,held=false,releaseCreate=null;
const kinds=['claude','codex','deepseek-harness','pi'];
const projects=['A','B','hidden'].map(id=>({id,displayName:'项目 '+id,rootPath:'C:/synthetic/'+id,canonicalPath:'C:/synthetic/'+id,status:'ok',revision:0,isGit:false}));
const members=id=>kinds.map(kind=>({id:'m_default_'+kind+'_'+id,projectId:id,displayName:{claude:'Claude',codex:'Codex','deepseek-harness':'DeepSeek Harness',pi:'Pi'}[kind],principalType:'agent',enabled:true,revision:0}));
for(const id of ['A','B'])for(const m of members(id))avatars['member:'+m.id]=defaultAiAvatarPreset().dataUrl;
const day=(ago)=>{const value=new Date();value.setDate(value.getDate()-ago);value.setHours(13,14,0,0);return value.getTime();};
const dm=(id,projectId,at)=>({conversationId:id,projectId,peerMemberId:'m_default_claude_'+projectId,peerDisplayName:'Claude',title:id,revision:0,execState:'idle',lastMessagePreview:'最近一条回复',lastReplyAt:at,lastMessageAt:at});
const lists={A:[dm('a-old','A',new Date(2026,9,15).getTime()),dm('a-before','A',day(2)),dm('a-yesterday','A',day(1)),dm('a-today','A',day(0))],B:[dm('b-today','B',day(0)-3600000)],hidden:[dm('never-visible','hidden',day(0))]};
const ok=data=>({ok:true,data});
window.zs={command:async env=>{
 calls.push(structuredClone(env));const p=env.params,id=p.projectId??store.getState().activeProjectId;
 if(env.method==='app.appearance.get')return ok({showAvatars:true,avatars:{...avatars}});
 if(env.method==='app.appearance.set'){avatars[p.avatar.subject]=p.avatar.dataUrl;return ok({showAvatars:true,avatars:{...avatars}});}
 if(env.method==='app.settings.get')return ok({values:{}});
 if(env.method==='recovery.status')return ok({gateHeld:false,unknownTurns:[],pendingRelease:[],interruptedRuns:[],activeUndos:[]});
 if(env.method==='conversation.list')return ok({conversations:lists[id]??[]});
 if(env.method==='conversation.history')return ok({messages:[{id:'reply-'+p.conversationId,authorType:'agent',authorId:'m_default_claude_'+id,bodyJson:JSON.stringify({text:'你好！有什么可以帮你的吗？'}),createdAt:day(0)}]});
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
 if(env.method==='room.list')return ok({items:[{id:'room-'+id,projectId:id,name:'默认房间',conversationId:'room-conv-'+id,memberIds:members(id).map(m=>m.id),revision:0}]});
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
configureReadingPositions('r160-isolated');document.body.classList.add('hifi-on');location.hash='#/dm';
createRoot(document.getElementById('root')).render(<App/>);void refreshMembers('A');
window.proof={navigate,reloadPins:async()=>{store.setState(s=>({...s,navigationPins:[]}));await applyServerNavPrefs();},failPin:()=>{failPin=true;},hideB:()=>store.setState(s=>({...s,visibleProjectIds:['A']})),showB:()=>store.setState(s=>({...s,visibleProjectIds:['A','B']})),uncertain:()=>{uncertain=true;},hold:()=>{held=true;},release:()=>{held=false;releaseCreate?.();releaseCreate=null;},
 snapshot:()=>({pins:structuredClone(pins),uiPins:store.getState().navigationPins,hash:location.hash,project:store.getState().activeProjectId,calls,creates:calls.filter(c=>c.method==='conversation.create'),logicalCreates:next,
  groups:[...document.querySelectorAll('[data-zs-dm-project]')].map(el=>el.dataset.zsDmProject),
  rows:[...document.querySelectorAll('[data-zs-dm-project="A"] [data-zs-dm-id]')].map(el=>({id:el.dataset.zsDmId,time:el.querySelector('time')?.textContent})),
  modal:!!document.querySelector('[data-zs-create-dm-member]'),text:document.body.innerText,
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
    for (let i = 0; i < 200; i++) { if (await js(code)) return; await pause(20); }
    throw Error('Timeout ' + label + ': ' + JSON.stringify(await js('proof.snapshot()')));
  };
  const click = async (selector, index = 0, button = 'left') => {
    const rect = await js(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)throw Error('Missing click target');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
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
    await until('window.proof&&proof.snapshot().groups.length===2&&proof.snapshot().rows.length===4&&proof.snapshot().avatars.every(Boolean)','grouped lists and avatars');
    await click('[data-zs-pin-menu="room:room-A"]');await until('document.querySelector(".menu")','room pin menu');
    await click('.menu .menu-item');await until('document.querySelector("[data-zs-pinned-rooms] [data-zs-room-row=room-A]")','pinned room');
    check('room-leaves-project-and-appears-once-above-projects',await js('document.querySelectorAll("[data-zs-room-row=room-A]").length===1&&!document.querySelector(".side-project [data-zs-room-row=room-A]")&&document.querySelector("[data-zs-pinned-rooms]").innerText.includes("项目 A")'));
    await click('.side-project .side-caret',0);await pause(30);
    check('room-pin-remains-with-project-collapsed',await js('!!document.querySelector("[data-zs-pinned-rooms] [data-zs-room-row=room-A]")'));
    await click('[data-zs-pin-menu="dm:a-today"]');await until('document.querySelector(".menu")','dm pin menu');await click('.menu .menu-item');
    await until('document.querySelector("[data-zs-pinned-dms] [data-zs-dm-id=a-today]")','pinned dm');
    check('dm-leaves-group-and-keeps-time-project-and-avatar',await js('document.querySelectorAll("[data-zs-dm-id=a-today]").length===1&&!document.querySelector("[data-zs-dm-project=A] [data-zs-dm-id=a-today]")&&document.querySelector("[data-zs-pinned-dms]").innerText.includes("项目 A")&&document.querySelector("[data-zs-pinned-dms] time").textContent==="13:14"&&!!document.querySelector("[data-zs-pinned-dms] .avatar")'));
    await click('[data-zs-dm-project=A] .dm-project-toggle');
    check('dm-pin-remains-with-project-group-collapsed',await js('!!document.querySelector("[data-zs-pinned-dms] [data-zs-dm-id=a-today]")'));
    await click('[data-zs-dm-id=b-today]',0,'right');await until('document.querySelector(".menu")','right click private menu');await click('.menu .menu-item');
    await until('document.querySelector("[data-zs-pinned-dms] [data-zs-dm-id=b-today]")','second project dm pin');
    await js('proof.hideB()');await until('!document.querySelector("[data-zs-dm-project=B]")','B project hidden');
    check('pinned-private-message-survives-hidden-project-group',await js('!!document.querySelector("[data-zs-pinned-dms] [data-zs-dm-id=b-today]")'));
    await click('[data-zs-pinned-dms] [data-zs-dm-id=b-today]');await until('proof.snapshot().hash==="#/dm/b-today"&&proof.snapshot().project==="B"','cross project pin opens B');
    check('pinned-dm-opens-exact-conversation-and-owning-project',await js('proof.snapshot().hash==="#/dm/b-today"&&proof.snapshot().project==="B"'));
    await js('proof.showB();proof.reloadPins()');await until('document.querySelector("[data-zs-pinned-rooms] [data-zs-room-row=room-A]")&&document.querySelectorAll("[data-zs-pinned-dms] [data-zs-dm-id]").length===2','server restored pins');
    check('server-pins-restore-after-clearing-local-state',await js('proof.snapshot().uiPins.length===3'));
    await capture('01-room-and-dm-pins');
    await click('[data-zs-pinned-rooms] [data-zs-room-row=room-A]',0,'right');await until('document.querySelector(".menu")','room unpin context menu');
    check('right-click-pinned-room-offers-unpin',await js('document.querySelector(".menu").innerText.includes("取消置顶")'));
    await click('.menu .menu-item');await until('!document.querySelector("[data-zs-pinned-rooms]")','room unpinned');
    await click('.side-project .side-caret',0);await until('document.querySelector(".side-project [data-zs-room-row=room-A]")','room restored in project');
    check('unpin-restores-room-to-original-project',await js('document.querySelectorAll("[data-zs-room-row=room-A]").length===1'));
    await click('[data-zs-pin-menu="dm:a-today"]');await until('document.querySelector(".menu")','dm unpin menu');await click('.menu .menu-item');
    await until('!document.querySelector("[data-zs-pinned-dms] [data-zs-dm-id=a-today]")','dm unpinned');
    await click('[data-zs-dm-project=A] .dm-project-toggle');await until('document.querySelector("[data-zs-dm-project=A] [data-zs-dm-id=a-today]")','dm restored');
    check('unpin-restores-private-message-to-original-group',await js('document.querySelectorAll("[data-zs-dm-id=a-today]").length===1'));
    await js('proof.failPin()');await click('[data-zs-pin-menu="dm:a-today"]');await until('document.querySelector(".menu")','uncertain pin menu');await click('.menu .menu-item');
    await until('proof.snapshot().text.includes("置顶操作未确认")','lost pin response');
    await click('[data-zs-pin-menu="dm:a-today"]');await until('document.querySelector(".menu")','pin retry menu');await click('.menu .menu-item');
    await until('document.querySelector("[data-zs-pinned-dms] [data-zs-dm-id=a-today]")','idempotent retry');
    check('uncertain-response-retry-does-not-duplicate-pin',await js('proof.snapshot().pins.filter(pin=>pin.kind==="dm"&&pin.itemId==="a-today").length===1&&document.querySelectorAll("[data-zs-dm-id=a-today]").length===1'));
    await click('[data-zs-dm-ops]');await until('document.querySelector(".menu")','header pin action');
    check('active-conversation-header-also-offers-unpin',await js('document.querySelector(".menu").innerText.includes("取消置顶")'));
    await click('.menu .menu-item');await until('!document.querySelector("[data-zs-pinned-dms] [data-zs-dm-id=b-today]")','header unpins B');
    check('header-unpin-targets-the-active-conversation',await js('!!document.querySelector("[data-zs-pinned-dms] [data-zs-dm-id=a-today]")&&!!document.querySelector("[data-zs-dm-project=B] [data-zs-dm-id=b-today]")'));
    await click('[data-zs-pin-menu="room:room-A"]');await until('document.querySelector(".menu")','room repin');await click('.menu .menu-item');
    await until('document.querySelector("[data-zs-pinned-rooms] [data-zs-room-row=room-A]")','repinned room');
    await click('[data-zs-pinned-rooms] [data-zs-room-row=room-A] .side-item');await until('proof.snapshot().hash==="#/project/A/room/room-A"&&proof.snapshot().project==="A"','pinned room opens own project');
    check('pinned-room-opens-exact-cross-project-room',true);
    await js('proof.navigate("/dm")');await until('document.querySelector("[data-zs-pinned-dms]")','return to private messages');
    win.setSize(900,760);await pause(100);await capture('02-narrow-pinned-lists');
    check('pins-and-controls-do-not-overflow-narrow-window',await js('document.documentElement.scrollWidth<=innerWidth'));
    check('pinning-does-not-create-tasks-or-send-messages',await js('!proof.snapshot().calls.some(call=>["conversation.create","dm.send","task.create","room.message.send"].includes(call.method))'));
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
  const out = path.join(root, 'dist/r160-conversation-pins', String(Date.now()));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'entry.tsx'), renderer);
  await require('esbuild').build({ entryPoints: [path.join(out, 'entry.tsx')], outfile: path.join(out, 'ui.mjs'),
    bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.png': 'dataurl' }, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } });
  fs.writeFileSync(path.join(out, 'app.css'), ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css', 'h1-overrides.css']
    .map(file => fs.readFileSync(path.join(root, 'src/ui/hifi/styles', file), 'utf8')).join('\n'));
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>#root{position:fixed;inset:38px 0 0;height:auto}</style><div id="zs-titlebar"></div><div id="root"></div><script type="module" src="ui.mjs"></script>');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('ZS_')) delete env[key];
  const child = spawnSync(require('electron'), [__filename, '--probe-out', out], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (!fs.existsSync(path.join(out, 'result.json'))) throw Error(`UI proof exited ${child.status}: ${fs.existsSync(path.join(out, 'error.txt')) ? fs.readFileSync(path.join(out, 'error.txt'), 'utf8') : child.stderr}; ${out}`);
  const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'));
  console.log(JSON.stringify({ ...result, evidence: out }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
if (process.versions.electron) prove(process.argv[process.argv.indexOf('--probe-out') + 1]);
else run().catch(error => { console.error(error); process.exitCode = 1; });
