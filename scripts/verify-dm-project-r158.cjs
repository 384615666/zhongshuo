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
import {refreshDms,refreshMembers} from '../../../src/ui/hifi/loader.ts';
import {navigate} from '../../../src/ui/hifi/lib/router.ts';
import {defaultAiAvatarPreset} from '../../../src/ui/hifi/data/avatarPresets.ts';
const calls=[],preset=defaultAiAvatarPreset().dataUrl;
const projects=['A','B'].map(id=>({id,displayName:'项目 '+id,rootPath:'C:/synthetic/'+id,canonicalPath:'C:/synthetic/'+id,status:'ok',revision:0,isGit:false}));
const member=id=>({id:'member-'+id,projectId:id,displayName:'Claude 配置',principalType:'agent',enabled:true,revision:0});
let phase='RUNNING';
const execution=id=>({schemaVersion:'task-execution-status-v1',taskId:'task-'+id,phase,
 scope:{projectId:id,conversationId:'dm-'+id,roomId:null,threadId:null,taskKind:'dm_turn',surfaces:['dm']},
 actualPerformingMembers:[],waitingMembers:[],waitingForUser:phase==='WAITING_FOR_USER'?{kind:'review',message:'等待你验收'}:null,
 reason:{code:'MEMBER_PERFORMING',message:'正在处理任务',source:'turn'},
 existingResults:{hasResults:false,deliveries:[],artifacts:[],changeSets:[],currentDelivery:null},
 evidence:{taskStatus:phase==='WAITING_FOR_USER'?'REVIEW':phase==='COMPLETED'?'DONE':'ACTIVE',taskRevision:0,stopGeneration:0,heartbeatUsedAsActivity:false},
 actions:[{id:'navigate-dm:'+id,kind:'navigate',label:'打开私信',target:{kind:'dm',id:'dm-'+id}}]});
window.zs={command:async env=>{
 calls.push(structuredClone(env));const p=env.params,id=p.projectId??store.getState().activeProjectId;
 const ok=data=>({ok:true,data});
 if(env.method==='app.appearance.get')return ok({showAvatars:true,avatars:{'member:member-A':preset,'member:member-B':preset}});
 if(env.method==='app.settings.get')return ok({values:{}});
 if(env.method==='recovery.status')return ok({gateHeld:false,unknownTurns:[],pendingRelease:[],interruptedRuns:[],activeUndos:[]});
 if(env.method==='conversation.list')return ok({conversations:[{conversationId:'dm-'+id,projectId:id,peerMemberId:'member-'+id,peerDisplayName:'Claude 配置',title:'',revision:0,execState:phase==='RUNNING'?'running':'idle',lastMessagePreview:'你好！有什么可以帮你的吗？',executionStatus:execution(id)}]});
 if(env.method==='conversation.history')return ok({messages:[{id:'reply-'+p.conversationId,authorType:'agent',authorId:'member-'+p.conversationId.slice(3),bodyJson:JSON.stringify({text:'你好！有什么可以帮你的吗？'}),createdAt:1793599200000}]});
 if(env.method==='conversation.failedTasks')return ok({conversationId:p.conversationId,items:[],truncated:false});
 if(env.method==='member.list')return ok({items:[member(id)]});
 if(env.method==='member.runtimes')return ok({projectId:id,items:[]});
 if(env.method==='runtime.status')return ok({memberBindings:[]});
 if(env.method==='room.list')return ok({items:[]});
 if(env.method==='project.memberWorkload')return ok({projectId:id,items:[]});
 if(env.method==='navigation.set')return ok({saved:true});
 return {ok:false,error:{code:'TEST_UNSUPPORTED',message:'测试未提供：'+env.method}};
},onDisconnect:()=>{},onReconnected:()=>{}};
store.setState(s=>({...s,boot:'ready',conn:'online',projects,activeProjectId:'A',visibleProjectIds:['A','B'],expandedProjectIds:['A'],members:[],rooms:[],dms:[],ui:{...s.ui,showAvatars:true,avatars:{'member:member-A':preset,'member:member-B':preset}}}));
document.body.classList.add('hifi-on');location.hash='#/dm';
createRoot(document.getElementById('root')).render(<App/>);
window.proof={phase:async value=>{phase=value;await refreshDms();},members:()=>refreshMembers(),navigate,
 snapshot:()=>({hash:location.hash,project:store.getState().activeProjectId,expanded:store.getState().expandedProjectIds,
  dms:store.getState().dms.map(dm=>({id:dm.id,memberIds:dm.memberIds})),text:document.body.innerText,
  avatar:document.querySelector('.dm-row .avatar img')?.getAttribute('src')===preset,
  phase:document.querySelector('[data-zs-execution-phase]')?.getAttribute('data-zs-execution-phase'),
  writes:calls.filter(c=>/submit|continue|stop|delete|archive/.test(c.method)).map(c=>c.method)})};
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
    await win.loadFile(path.join(out, 'index.html'));
    await until('window.proof&&proof.snapshot().avatar&&proof.snapshot().phase===\'RUNNING\'', 'DM loaded without roster');
    let s = await js('proof.snapshot()');
    check('avatar-resolves-from-peer-id-before-roster-load', s.avatar && s.dms[0].memberIds[0] === 'member-A', s);
    check('running-dm-has-no-link-to-itself', !s.text.includes('打开私信') && s.phase === 'RUNNING', s.phase);
    await js('proof.members()');
    await capture('01-running-dm');
    await js('proof.phase("COMPLETED")');
    await until('!proof.snapshot().phase', 'completion hidden');
    check('completed-dm-banner-is-hidden', !(await js('proof.snapshot()')).phase);
    await capture('02-completed-dm');
    await js('proof.phase("WAITING_FOR_USER")');
    await until('proof.snapshot().text.includes("待你验收")', 'review remains visible');
    check('review-stays-visible', (await js('proof.snapshot()')).phase === 'WAITING_FOR_USER');
    await js('proof.phase("COMPLETED")');
    await click('.side-project .side-item-label-btn', 1);
    await until('proof.snapshot().project===\'B\'&&proof.snapshot().dms[0]?.id===\'dm-B\'&&proof.snapshot().avatar', 'switch to B private messages');
    s = await js('proof.snapshot()');
    check('project-name-switches-private-messages-and-preserves-expansion', s.hash === '#/dm' && s.expanded.join(',') === 'A', s);
    await click('.side-project .side-caret', 1);
    s = await js('proof.snapshot()');
    check('caret-expands-without-changing-project-or-page', s.project === 'B' && s.hash === '#/dm' && s.expanded.includes('B'), s.expanded);
    await click('.sidebar-top .side-item[title="管理成员与 AI 配置"]');
    await until('location.hash===\'#/project/B/members\'', 'member management');
    await click('.side-project .side-item-label-btn', 0);
    await until('location.hash===\'#/project/A/members\'&&proof.snapshot().project===\'A\'', 'switch member project');
    check('project-name-keeps-member-management', (await js('proof.snapshot()')).hash === '#/project/A/members');
    await capture('03-member-project-switch');
    await js('proof.navigate("/dm")');
    await until('proof.snapshot().avatar', 'return private messages');
    win.setSize(900, 760); await pause(100); await capture('04-dm-narrow');
    check('narrow-layout-has-no-document-overflow', await js('document.documentElement.scrollWidth<=innerWidth'));
    check('navigation-never-submits-or-changes-tasks', (await js('proof.snapshot()')).writes.length === 0);
    check('no-render-errors', errors.length === 0, errors);
    const result = { ok: checks.every(c => c.ok), checks, screenshots, realModelCalls: 0, userDataOpened: false };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    win.destroy(); app.exit(result.ok ? 0 : 1);
  } catch (error) {
    fs.writeFileSync(path.join(out, 'error.txt'), error.stack);
    await capture('failure'); win.destroy(); app.exit(2);
  }
}

async function run() {
  const out = path.join(root, 'dist/r158-dm-project', String(Date.now()));
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
