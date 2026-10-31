/* Actual Composer in isolated Electron; replay its exact production envelopes through
 * DispatchWorker with a synthetic DB + fake adapter. No original DB/UI or business models.
 * node scripts/verify-r134-composer-mentions.cjs
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist/r134-composer-mentions');

const renderer = String.raw`
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../../src/ui/hifi/components/Composer.tsx';
import * as store from '../../src/ui/hifi/data/store.ts';
import { buildRoomRootEnvelope, sendEnvelope } from '../../src/ui/hifi/loader.ts';
import '../../src/ui/hifi/styles/tokens.css';
import '../../src/ui/hifi/styles/base.css';
import '../../src/ui/hifi/styles/components.css';
import '../../src/ui/hifi/styles/h1-overrides.css';
const config = __CONFIG__;
const ids = config.memberIds;
const checks = [], sends = [], envelopes = [];
let lastDraft, pendingSnapshot;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(test) { for (let i=0;i<400;i++) { if(test()) return; await pause(5); } throw Error('timeout: '+document.body.innerText.slice(-1500)); }
function eq(name, actual, expected) { checks.push({name,ok:JSON.stringify(actual)===JSON.stringify(expected),actual,expected}); }
window.zs = {command:async env => {
  if (env.method==='message.submit') { envelopes.push(env); return {ok:true,data:{messageId:'synthetic',threadId:'synthetic'}}; }
  if (env.method==='app.settings.get') return {ok:true,data:{values:{'callBudget.enabled':'false'}}};
  return {ok:true,data:{items:[],entries:[]}};
}, onDisconnect:()=>{}, onReconnected:()=>{}};
const members = ids.map((id,i)=>({id,projectId:config.projectId,profileId:'',displayName:'同名',ordinal:i+1,principalType:'agent',enabled:true,workState:'idle',model:'fixture',effort:'low',internalSubagents:false,isCoordinatorDefault:i===0}));
const rooms = ['a','b'].map((key,i)=>({id:config.rooms[i].id,projectId:config.projectId,conversationId:config.rooms[i].conversationId,name:'R134 合成房间 '+key,coordinatorMemberId:ids[0],memberIds:ids,revision:1,unread:0}));
store.initDraftPersistence('r134-isolated|synthetic');
store.setState(s=>({...s,activeProjectId:config.projectId,boot:'ready',projects:[{id:config.projectId,displayName:'R134 合成验证',rootPath:config.projectPath,revision:1}],rooms,members,
  memberRuntimes:Object.fromEntries(ids.map(id=>[id,{status:'bound',kind:'codex',model:'fixture'}])),profiles:[],runtimeInstallations:[],dms:[],threads:[],drafts:{},pendingSends:{},outboundLedger:{},uploadItems:{},dispatchGuard:{fakeAllowed:true,realDispatchGuard:true}}));
const reactRoot = createRoot(document.getElementById('root'));
let roomIndex=0;
function key() { return 'room:'+rooms[roomIndex].id; }
function editor() { return document.querySelector('.composer-editor'); }
function render() { reactRoot.render(createElement(Composer,{draftKey:key(),target:{kind:'room_root',roomId:rooms[roomIndex].id},onSend:async payload=>{
  lastDraft=store.getDraftFull(key()); sends.push(payload);
  const env=buildRoomRootEnvelope(payload.commandId,rooms[roomIndex].id,payload.body,'default',payload.mentionIds);
  env.revAtSend=payload.draftRev;
  const staged=store.stageOutbound(key(),env); if(!staged.ok) throw Error(staged.error);
  pendingSnapshot=store.getState().outboundLedger[key()].at(-1);
  const outcome=await sendEnvelope(env);
  if(outcome.status==='ok') store.settleOutbound(key(),env);
  return {status:outcome.status};
}})); }
async function mount(body='', mentions=[], mentionBindings=undefined) { reactRoot.render(null); await pause(20); store.setDraftFull(key(),{body,mentions,mentionBindings,attachments:[],access:'plan',sendAs:'ai'}); render(); await until(()=>editor()!=null); await pause(35); }
async function input(text) { editor().focus(); editor().textContent=text; const range=document.createRange();range.selectNodeContents(editor());range.collapse(false);getSelection().removeAllRanges();getSelection().addRange(range);editor().dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text})); await pause(35); }
async function pick(id,typed=false) { if(typed) await input('@同'); else document.querySelector('button[title^="提及成员"]').click(); await until(()=>document.querySelector('[data-zs-mention-option="'+id+'"]')); document.querySelector('[data-zs-mention-option="'+id+'"]').click(); await pause(45); }
async function send(name, expected) { const before=sends.length;document.querySelector('.composer-send').click();await until(()=>sends.length===before+1);await pause(30);
  eq(name+'_body_no_internal_id',ids.every(id=>!sends.at(-1).body.includes(id)),true);
  eq(name+'_draft',lastDraft.mentions,expected);eq(name+'_payload',sends.at(-1).mentionIds,expected);eq(name+'_envelope',envelopes.at(-1).params.mentions.map(m=>m.memberId),expected);eq(name+'_durable_pending',pendingSnapshot.params.mentions.map(m=>m.memberId),expected);
}
window.run=async()=>{
  for(let i=0;i<3;i++){await mount();await pick(ids[i],i===2);await send('candidate_'+(i+1),[ids[i]]);}
  store.setState(s=>({...s,rooms:s.rooms.map(r=>({...r,memberIds:ids.slice(0,2)}))}));await pause(25);
  await mount(); await pick(ids[0]); const stable=editor().textContent; const stableBindings=store.getDraftFull(key()).mentionBindings;
  store.setState(s=>({...s,rooms}));await pause(25);eq('third_duplicate_arrives_keeps_id',store.getDraftFull(key()).mentions,[ids[0]]);
  // Same component, same draft: live member name/runtime/order changes must not retarget/rebuild it.
  const textNode=editor().firstChild;
  store.setState(s=>({...s,members:[...s.members].reverse().map(m=>m.id===ids[0]?{...m,displayName:'已改名'}:m),memberRuntimes:{...s.memberRuntimes,[ids[0]]:{status:'bound',kind:'claude',model:'changed'}}}));await pause(45);
  eq('rename_keeps_editor_node',editor().firstChild===textNode,true);eq('rename_keeps_body',editor().textContent,stable);eq('rename_keeps_draft_id',store.getDraftFull(key()).mentions,[ids[0]]);
  roomIndex=1; render(); await pause(45); await input('房间B 原草稿');roomIndex=0;render();await pause(45);
  eq('room_switch_restores_body',editor().textContent,stable);eq('room_switch_restores_id',store.getDraftFull(key()).mentions,[ids[0]]);await send('rename_model_switch',[ids[0]]);
  roomIndex=1;render();await pause(45);eq('other_room_draft_preserved',editor().textContent,'房间B 原草稿');roomIndex=0;render();await pause(30);
  // Deletion follows body, not old metadata.
  await mount();await pick(ids[0]);await pick(ids[2]);eq('toolbar_multi',store.getDraftFull(key()).mentions,[ids[0],ids[2]]);
  const token3='@'+Object.entries(store.getDraftFull(key()).mentionBindings.tokens).find(([,id])=>id===ids[2])[0];await input(token3+' 仅第三位');await send('delete_first',[ids[2]]);
  // Reintroduce equal names/runtime, including an already wrong old saved mention ID.
  store.setState(s=>({...s,members,memberRuntimes:Object.fromEntries(ids.map(id=>[id,{status:'bound',kind:'codex',model:'fixture'}]))}));await pause(30);
  for(const legacy of ['@同名 请回复','@同名（codex·fixture） 请回复']) {
    await mount(legacy,[ids[1]]);const before=sends.length;document.querySelector('.composer-send').click();await pause(60);
    eq('ambiguous_old_not_sent_'+legacy,sends.length,before);eq('ambiguous_old_body_preserved_'+legacy,editor().textContent,legacy);eq('ambiguous_old_explained_'+legacy,document.body.innerText.includes('无法唯一确定成员'),true);
  }
  store.setState(s=>({...s,members:s.members.map((m,i)=>i===0?{...m,displayName:'唯一'}:m)}));await pause(30);
  await mount('@唯一 兼容旧草稿');await send('legacy_unique',[ids[0]]);
  await mount();await pick(ids[0]);eq('unique_selection_plain_name',editor().textContent,'@唯一 ');await send('unique_pick',[ids[0]]);
  // Stable ID from a removed member is rejected, even if its old name remains present.
  await mount(stable,[],stableBindings);store.setState(s=>({...s,rooms:s.rooms.map(r=>({...r,memberIds:r.memberIds.filter(id=>id!==ids[0])}))}));await pause(30);
  const beforeRemoved=sends.length;document.querySelector('.composer-send').click();await pause(50);eq('removed_member_no_fallback',sends.length,beforeRemoved);eq('removed_member_body_preserved',editor().textContent,stable);
  store.setState(s=>({...s,rooms,members}));await pause(30);
  const protectedText='> @同名（codex·fixture） 引用\n\n~~~ts\n'+stable+'\n~~~\n\n\x60'+stable+'\x60\n这是解释';
  await mount(protectedText);eq('code_quote_no_mentions',store.getDraftFull(key()).mentions,[]);
  // Screenshot shows the real picker and three short readable tokens, without internal IDs.
  await mount();await pick(ids[0]);document.querySelector('button[title^="提及成员"]').click();await pause(40);
  eq('three_equal_candidates',document.querySelectorAll('[data-zs-mention-option]').length>=4,true);
  eq('duplicate_selection_short',editor().textContent.length<55,true);
  eq('duplicate_selection_no_uuid',ids.every(id=>!editor().textContent.includes(id)),true);
  return {ok:checks.every(c=>c.ok),sourceRoot:config.sourceRoot,syntheticOnly:true,realBusinessCalls:0,checks,envelopes};
};
window.prepareReloadProof=async()=>{
  store.setState(s=>({...s,members:[{...members[0],displayName:'唯一'}],rooms:s.rooms.map(r=>({...r,memberIds:[ids[0]]}))}));await pause(30);
  await mount();await pick(ids[0]);
  return {body:editor().textContent,mentions:store.getDraftFull(key()).mentions};
};
window.resumeReloadProof=async expected=>{
  store.setState(s=>({...s,members:members.map((m,i)=>({...m,displayName:i===0?'已重命名':'唯一'}))}));
  render();await until(()=>editor()!=null);await pause(60);
  eq('cold_reload_plain_body_preserved',editor().textContent,expected.body);
  eq('cold_reload_metadata_member_preserved',store.getDraftFull(key()).mentions,[ids[0]]);
  eq('cold_reload_plain_name_not_retargeted',store.getDraftFull(key()).mentionBindings.tokens['唯一'],ids[0]);
  await send('cold_reload_rename_duplicate',[ids[0]]);
  // Leave a normal unique selection visible for screenshot QA.
  store.setState(s=>({...s,members:members.map((m,i)=>({...m,displayName:i===0?'唯一':'另一个'+i}))}));await pause(30);
  await mount();await pick(ids[0]);eq('final_unique_plain_name',editor().textContent,'@唯一 ');
  return {ok:checks.every(c=>c.ok),checks,envelopes};
};
`;

async function runVerifier() {
  fs.mkdirSync(out, { recursive: true });
  for (const file of ['ui-error.txt', 'ui-result.json']) fs.rmSync(path.join(out,file), {force:true});
  const { build } = require('esbuild');
  // Bundle only local TS; use Node's native SQLite binding, never Electron's ABI or original data.
  await build({ stdin: { contents: "export { collisionFixture } from '../../tests/helpers/collisionHarnessR122.ts';", resolveDir: out, sourcefile: 'worker.ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: path.join(out, 'worker.mjs'), logLevel: 'silent' });
  process.env.ZS_ALLOW_FAKE = '1'; process.env.ZS_RUNTIME = 'fake'; process.env.ZS_REAL_DISPATCH_GUARD = '1';
  const { collisionFixture } = await import(pathToFileURL(path.join(out, 'worker.mjs')).href);
  const fixture = await collisionFixture('r134-mentions', { members: 3, rooms: 2 });
  try {
    const p = fixture.projects[0];
    const config = { sourceRoot: root, projectId: p.id, projectPath: p.path, memberIds: p.members, rooms: p.rooms };
    fs.writeFileSync(path.join(out, 'harness.tsx'), renderer.replace('__CONFIG__', JSON.stringify(config)));
    await build({ entryPoints: [path.join(out, 'harness.tsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, outfile: path.join(out, 'harness.js'), logLevel: 'silent' });
    fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>R134 Composer 同名成员验证</title><link rel="stylesheet" href="harness.css"><style>body{padding:48px;background:#f5f8fc}#root{max-width:1120px;margin:360px auto 0}.composer{position:relative}</style><div class="app-body"><div id="root"></div></div><script src="harness.js"></script>');
    fs.writeFileSync(path.join(out, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{backgroundThrottling:false,offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:false}});
try {await win.loadFile(path.join(__dirname,'index.html'));const result=await win.webContents.executeJavaScript('window.run()');win.webContents.invalidate();await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(__dirname,'composer-mentions.png'),(await win.webContents.capturePage()).toPNG());const expected=await win.webContents.executeJavaScript('window.prepareReloadProof()');win.webContents.reload();await new Promise(r=>win.webContents.once('did-finish-load',r));const resumed=await win.webContents.executeJavaScript('window.resumeReloadProof('+JSON.stringify(expected)+')');result.checks.push(...resumed.checks);result.envelopes.push(...resumed.envelopes);result.ok=result.ok&&resumed.ok;win.webContents.invalidate();await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(__dirname,'composer-unique-name.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(__dirname,'ui-result.json'),JSON.stringify(result,null,2));app.exit(result.ok?0:1);}catch(e){fs.writeFileSync(path.join(__dirname,'ui-error.txt'),String(e.stack));app.exit(2);}});setTimeout(()=>app.exit(3),45000);
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(require('electron'), [path.join(out, 'main.cjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 50000 });
    fs.writeFileSync(path.join(out, 'process.json'), JSON.stringify({ exitCode: run.status, error: run.error?.message, stderr: run.stderr }, null, 2));
    if (run.status !== 0) throw Error('Electron verifier failed: '+(fs.existsSync(path.join(out,'ui-error.txt'))?fs.readFileSync(path.join(out,'ui-error.txt'),'utf8'):fs.readFileSync(path.join(out,'ui-result.json'),'utf8')));
    const report = JSON.parse(fs.readFileSync(path.join(out, 'ui-result.json'), 'utf8'));
    report.workerChecks = [];
    // Exact captured production envelopes are replayed without rebuilding target or mentions.
    for (const envelope of report.envelopes) {
      const before = fixture.adapter.turns.length;
      const submitted = await fixture.cmd(envelope.method, envelope.params, envelope.commandId);
      await fixture.pumpUntil(() => fixture.taskStatus(submitted.taskId) === 'DONE');
      const actual = fixture.adapter.turns.slice(before).map(t => t.memberId);
      const expected = envelope.params.mentions.map(m => m.memberId);
      report.workerChecks.push({ name: 'exact_envelope_worker_recipient', ok: JSON.stringify(actual) === JSON.stringify(expected), commandId: envelope.commandId, expected, actual, taskId: submitted.taskId });
    }
    report.realBusinessCalls = fixture.count('SELECT count(*) n FROM real_calls');
    report.ok = report.ok && report.workerChecks.every(c => c.ok) && report.realBusinessCalls === 0;
    report.screenshot = path.join(out, 'composer-mentions.png');
    report.fixtureDir = fixture.dir;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, uiChecks: report.checks.length, workerChecks: report.workerChecks.length, realBusinessCalls: report.realBusinessCalls, failures: [...report.checks, ...report.workerChecks].filter(c => !c.ok), screenshot: report.screenshot }, null, 2));
    return report;
  } finally { await fixture.close(); }
}
module.exports = { runVerifier };
if (require.main === module) runVerifier().then(result => { process.exitCode = result.ok ? 0 : 1; }).catch(error => { console.error(error); process.exitCode = 2; });
