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
import {refreshMembers,loadDmProjectIndex} from '../../../src/ui/hifi/loader.ts';
import {navigate} from '../../../src/ui/hifi/lib/router.ts';
import {configureReadingPositions} from '../../../src/ui/hifi/data/readingPositions.ts';
import {defaultAiAvatarPreset} from '../../../src/ui/hifi/data/avatarPresets.ts';
const calls=[],receipts=new Map(),avatars={};let next=0,uncertain=false,held=false,releaseCreate=null;
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
 if(env.method==='navigation.set')return ok({saved:true});
 return {ok:false,error:{code:'TEST_UNSUPPORTED',message:'测试未提供：'+env.method}};
},onDisconnect:()=>{},onReconnected:()=>{}};
store.setState(s=>({...s,boot:'ready',conn:'online',projects,activeProjectId:'A',visibleProjectIds:['A','B'],pinnedProjectIds:[],expandedProjectIds:['A'],members:[],rooms:[],dms:[],dmProjectIndexes:{},ui:{...s.ui,showAvatars:true,avatars:{...avatars}}}));
configureReadingPositions('r159-isolated');document.body.classList.add('hifi-on');location.hash='#/dm';
createRoot(document.getElementById('root')).render(<App/>);void refreshMembers('A');
window.proof={navigate,uncertain:()=>{uncertain=true;},hold:()=>{held=true;},release:()=>{held=false;releaseCreate?.();releaseCreate=null;},
 snapshot:()=>({hash:location.hash,project:store.getState().activeProjectId,calls,creates:calls.filter(c=>c.method==='conversation.create'),logicalCreates:next,
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
  const click = async (selector, index = 0) => {
    const rect = await js(`(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)throw Error('Missing click target');const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
    await pause(60);
  };
  const capture = async name => {
    const file = path.join(out, name + '.png');
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); screenshots.push(file);
  };
  try {
    await win.loadFile(path.join(out,'index.html'));
    await until('window.proof&&proof.snapshot().groups.length===2&&proof.snapshot().rows.length===4&&proof.snapshot().avatars.every(Boolean)','grouped lists and avatars');
    let state=await js('proof.snapshot()');
    check('only-sidebar-visible-projects-are-read-and-grouped',state.groups.join(',')==='A,B'&&!state.calls.some(c=>c.method==='conversation.list'&&c.params.projectId==='hidden'),state.groups);
    check('each-project-has-its-own-add-button',await js('document.querySelectorAll(".dm-project-head button[aria-label]").length===2&&!document.querySelector(".pool-head button[aria-label=新建私信]")'));
    check('reply-order-and-four-date-formats',state.rows.map(row=>row.id).join(',')==='a-today,a-yesterday,a-before,a-old'&&state.rows.map(row=>row.time).join(',')==='13:14,昨天,前天,2026-10-15',state.rows);
    check('four-channel-defaults-correct-old-identical-images',state.avatars.every(Boolean),state.avatars);
    await capture('01-grouped-private-messages');
    await click('[data-zs-dm-project="B"] .dm-project-head button[aria-label]');
    await until('document.querySelector("[data-zs-create-dm-member=m_default_codex_B]")','B member picker');
    await until('proof.snapshot().pickerAvatars.every(Boolean)','inactive-project member defaults');
    check('inactive-project-picker-has-channel-default-avatars',(await js('proof.snapshot()')).pickerAvatars.every(Boolean));
    check('member-picker-has-no-second-confirm-button',await js('![...document.querySelectorAll(".modal footer button,.modal .modal-foot button")].some(button=>button.textContent.trim()==="创建")'));
    const choose='[data-zs-create-dm-member="m_default_codex_B"]';
    const rect=await js('(()=>{const r=document.querySelector('+JSON.stringify(choose)+').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    for(let i=0;i<2;i++){win.webContents.sendInputEvent({type:'mouseDown',...rect,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...rect,button:'left',clickCount:1});}
    await until('proof.snapshot().hash==="#/dm/new-1"&&!proof.snapshot().modal','one-click creation');state=await js('proof.snapshot()');
    check('double-click-creates-once-in-group-B-while-starting-in-A',state.creates.length===1&&state.creates[0].params.projectId==='B'&&state.creates[0].params.peerMemberId==='m_default_codex_B'&&state.project==='B',state.creates);
    check('switching-conversation-retains-both-project-groups',state.groups.join(',')==='A,B',state.groups);
    await js('proof.uncertain()');await click('[data-zs-dm-project="B"] .dm-project-head button[aria-label]');
    await until('document.querySelector("[data-zs-create-dm-member=m_default_pi_B]")','uncertain picker');await click('[data-zs-create-dm-member="m_default_pi_B"]');
    await until('proof.snapshot().text.includes("创建请求尚未收到回执")','lost receipt');await click('[data-zs-create-dm-member="m_default_pi_B"]');
    await until('proof.snapshot().hash==="#/dm/new-2"&&!proof.snapshot().modal','same request retry');state=await js('proof.snapshot()');
    check('uncertain-create-retries-the-same-command-without-duplicating',state.logicalCreates===2&&state.creates[1].commandId===state.creates[2].commandId,state.creates.map(call=>call.commandId));
    await js('proof.hold()');await click('[data-zs-dm-project="A"] .dm-project-head button[aria-label]');
    await until('document.querySelector("[data-zs-create-dm-member=m_default_claude_A]")','held picker');await click('[data-zs-create-dm-member="m_default_claude_A"]');await until('proof.snapshot().held','held request');
    await click('.modal button[aria-label="关闭"]');await js('proof.release()');
    await until('proof.snapshot().logicalCreates===3','late create settled');await pause(100);state=await js('proof.snapshot()');
    check('closing-picker-prevents-late-navigation',state.hash==='#/dm/new-2'&&!state.modal,state.hash);
    win.setSize(3440,1440);await js('proof.navigate("/project/A/members")');
    await until('document.querySelectorAll("[data-zs-member-card]").length===4','wide member cards');await pause(150);
    const memberLayout=await js('(()=>{const card=document.querySelector("[data-zs-member-card]").getBoundingClientRect(),head=document.querySelector(".members-page .page-filters").getBoundingClientRect();return{left:card.left,head:head.left,width:card.width};})()');
    check('ultrawide-member-cards-align-left',Math.abs(memberLayout.left-memberLayout.head)<2&&memberLayout.width<500,memberLayout);
    await capture('02-ultrawide-members');
    await js('proof.navigate("/board")');await until('document.querySelector("[data-zs-task-id=one-task]")','wide task card');
    const boardLayout=await js('(()=>{const card=document.querySelector("[data-zs-task-id=one-task]").getBoundingClientRect(),head=document.querySelector(".tasks-board-page .section-title").getBoundingClientRect();return{left:card.left,head:head.left,width:card.width};})()');
    check('ultrawide-task-cards-align-with-project-title',Math.abs(boardLayout.left-boardLayout.head)<2&&boardLayout.width<500,boardLayout);
    await capture('03-ultrawide-task-board');
    win.setSize(900,760);await js('proof.navigate("/dm")');await until('document.querySelectorAll("[data-zs-dm-project]").length===2','narrow groups');await pause(80);await capture('04-narrow-grouped-dm');
    check('narrow-layout-has-no-document-overflow',await js('document.documentElement.scrollWidth<=innerWidth'));
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
  const out = path.join(root, 'dist/r159-dm-project', String(Date.now()));
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
