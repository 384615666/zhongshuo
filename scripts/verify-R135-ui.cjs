/* Isolated Electron regression of the production RecoveryPanel + Composer, following
 * the R134 Composer verifier. In-memory RPC fixtures only: no DB, daemon or model.
 * node scripts/verify-R135-ui.cjs
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist/R135-ui');

const renderer = String.raw`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {RecoveryPanel} from '../../src/ui/hifi/components/RecoveryPanel.tsx';
import {Composer} from '../../src/ui/hifi/components/Composer.tsx';
import * as store from '../../src/ui/hifi/data/store.ts';
import {buildRoomRootEnvelope} from '../../src/ui/hifi/loader.ts';
import {useHashRoute, navigate} from '../../src/ui/hifi/lib/router.ts';
import '../../src/ui/hifi/styles/tokens.css';
import '../../src/ui/hifi/styles/base.css';
import '../../src/ui/hifi/styles/components.css';
import '../../src/ui/hifi/styles/h1-overrides.css';
const checks=[], calls=[], sends=[], envelopes=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(test) {for(let i=0;i<400;i++){if(test())return;await pause(5);}throw Error('timeout: '+document.body.innerText.slice(-1600));}
function eq(name,actual,expected){checks.push({name,ok:JSON.stringify(actual)===JSON.stringify(expected),actual,expected});}
function clickText(text,scope=document){const el=[...scope.querySelectorAll('button')].find(b=>b.textContent.trim()===text||(b.getAttribute('role')==='menuitem'&&b.querySelector(':scope > span')?.textContent.trim()===text));if(!el)throw Error('Missing button '+text);el.click();}
const ids=['R135-member-a','R135-member-b','R135-member-c'];
const members=ids.map((id,i)=>({id,projectId:'R135-project',profileId:'',displayName:['分析员','复核员','实施员'][i],ordinal:i+1,principalType:'agent',enabled:true,workState:'idle',model:'fixture',effort:'low',internalSubagents:false,isCoordinatorDefault:i===0}));
const rooms=['a','b'].map(key=>({id:'R135-room-'+key,projectId:'R135-project',conversationId:'R135-conversation-'+key,name:'R135 合成房间 '+key,coordinatorMemberId:ids[0],memberIds:ids,revision:1,unread:0}));
const recovery={gateHeld:true,pendingDispatchCount:1,pendingDispatchKeys:['R135-queued'],interruptedRuns:[{id:'R135-run-interrupted',task_id:'R135-task-interrupted',status:'INTERRUPTED'}],unknownTurns:[{id:'R135-turn-unknown',runId:'R135-run-unknown',stageKey:'DIRECT',taskId:'R135-task-unknown',status:'UNKNOWN',protectionState:'retained'}],pendingRelease:[],stopRecord:null,activeUndos:[],heldLeases:[]};
let resolveMode='success', landingKind='thread', releaseResolve, closes=0;
function resolved(hash){return {kind:'task',projectId:'R135-project',conversationId:landingKind==='dm'?'R135-dm':'R135-conversation-a',...(landingKind==='thread'?{threadId:hash.includes('interrupted')?'R135-thread-interrupted':'R135-thread-unknown'}:{}),taskId:hash.slice(6)};}
window.zs={command:async env=>{
  calls.push(env);
  if(env.method==='recovery.status')return {ok:true,data:recovery};
  if(env.method==='task.get')return {ok:true,data:{task:{title:'R135 合成待确认任务',owner_member_id:ids[0]}}};
  if(env.method==='app.settings.get')return {ok:true,data:{values:{'callBudget.enabled':'true'}}};
  if(env.method==='deepLink.resolve'){
    if(resolveMode==='failure')return {ok:false,error:{code:'NOT_FOUND',message:'找不到原任务，请重新检查任务是否仍可访问'}};
    if(resolveMode==='no-route')return {ok:true,data:{kind:'task',projectId:'R135-project',conversationId:'R135-missing'}};
    if(resolveMode==='delay')await new Promise(r=>{releaseResolve=r;});
    return {ok:true,data:resolved(env.params.hash)};
  }
  throw Error('Unexpected RPC (no writes allowed): '+env.method);
},onDisconnect:()=>{},onReconnected:()=>{}};
store.initDraftPersistence('R135-isolated|synthetic-only');
store.setState(s=>({...s,boot:'ready',activeProjectId:'R135-project',projects:[{id:'R135-project',displayName:'R135 合成验证',rootPath:'R135-synthetic-only',revision:1}],rooms,members,dms:[{id:'R135-dm',projectId:'R135-project',memberIds:[ids[0]],unread:0}],threads:[],threadMemberships:{'R135-thread':{eligibleMemberIds:ids}},memberRuntimes:Object.fromEntries(ids.map(id=>[id,{status:'bound',kind:'codex',model:'fixture'}])),profiles:[],runtimeInstallations:[],drafts:{},pendingSends:{},outboundLedger:{},uploadItems:{},dispatchGuard:{fakeAllowed:true,realDispatchGuard:true}}));
const reactRoot=createRoot(document.getElementById('root'));
function RouteProof(){const route=useHashRoute();return createElement('div',{className:'panel info','data-R135-route':route},'实际正式路由：'+route);}
function frame(child){return createElement('div',null,createElement('h2',null,'R135 正式组件 · 隔离合成验证'),createElement('p',{className:'faint'},'仅合成状态与命令回包；不连接数据库或模型'),createElement(RouteProof),child);}
async function unmount(){reactRoot.render(null);await pause(25);}
async function mountRecovery(){await unmount();navigate('/room/R135-room-a');reactRoot.render(frame(createElement(RecoveryPanel,{origin:'startup',onClose:()=>{closes++;reactRoot.render(frame(null));}})));await until(()=>document.querySelector('[data-zs-recovery-summary]'));await pause(25);}
async function details(){clickText('查看详情');await until(()=>document.querySelector('details.settings-why'));document.querySelector('details.settings-why').open=true;await pause(20);}
function locateButton(index){if(index<2)return [...document.querySelectorAll('[data-zs-recovery-summary] button')].find(b=>b.textContent.trim()===(index===0?'查看待确认任务':'查看中断任务'));return [...document.querySelectorAll('details button')].filter(b=>b.textContent.trim()==='定位任务')[index-2];}
window.prepareRecovery=async()=>{resolveMode='success';await mountRecovery();};
window.runRecovery=async()=>{
  for(let i=0;i<4;i++){
    await mountRecovery();await details();const before=closes;const hashBefore=location.hash;
    resolveMode='failure';locateButton(i).click();await until(()=>document.querySelector('[role="alert"]'));
    eq('recovery_'+i+'_failure_keeps_dialog',!!document.querySelector('[data-zs-recovery]'),true);
    eq('recovery_'+i+'_failure_does_not_close',closes,before);
    eq('recovery_'+i+'_failure_keeps_route',location.hash,hashBefore);
    eq('recovery_'+i+'_readable_error',document.querySelector('[role="alert"]').textContent.includes('找不到原任务'),true);
    resolveMode='delay';landingKind=i===3?'dm':'thread';releaseResolve=undefined;locateButton(i).click();await until(()=>releaseResolve!=null);await pause(30);
    eq('recovery_'+i+'_pending_keeps_dialog',!!document.querySelector('[data-zs-recovery]'),true);
    eq('recovery_'+i+'_retry_clears_error',document.querySelector('[role="alert"]')==null,true);
    releaseResolve();await until(()=>!document.querySelector('[data-zs-recovery]'));
    eq('recovery_'+i+'_success_closes_once',closes,before+1);
    const expected=i===3?'#/dm/R135-dm':'#/thread/R135-thread-'+(i===1?'interrupted':'unknown')+'?tab=task';
    eq('recovery_'+i+'_formal_route',location.hash,expected);
    eq('recovery_'+i+'_exact_task',calls.filter(c=>c.method==='deepLink.resolve').at(-1).params.hash,'#task=R135-task-'+(i===1||i===3?'interrupted':'unknown'));
  }
  await mountRecovery();resolveMode='no-route';clickText('查看中断任务');await until(()=>document.querySelector('[role="alert"]'));
  eq('resolved_without_landing_keeps_dialog',!!document.querySelector('[data-zs-recovery]'),true);
  eq('resolved_without_landing_explained',document.querySelector('[role="alert"]').textContent.includes('定位失败'),true);
  resolveMode='failure';clickText('查看中断任务');await until(()=>document.querySelector('[role="alert"]').textContent.includes('找不到原任务'));
};
window.finishRecovery=async()=>{resolveMode='success';landingKind='thread';clickText('查看中断任务');await until(()=>!document.querySelector('[data-zs-recovery]'));};
let roomIndex=0, targetKind='room_root', readOnly=false;
function draftKey(){return targetKind==='room_root'?'room:'+rooms[roomIndex].id:targetKind==='thread'?'thread:R135-thread':'dm:R135-dm';}
function editor(){return document.querySelector('.composer-editor');}
function renderComposer(){const key=draftKey();reactRoot.render(frame(createElement(Composer,{draftKey:key,target:{kind:targetKind,roomId:rooms[roomIndex].id,...(targetKind==='thread'?{threadId:'R135-thread'}:{}),...(targetKind==='dm'?{dmId:'R135-dm'}:{})},inputDisabledReason:readOnly?'R135 只读验证':undefined,onSend:async payload=>{
  sends.push(payload);
  if(targetKind==='room_root')envelopes.push(buildRoomRootEnvelope(payload.commandId,rooms[roomIndex].id,payload.body,'default',payload.mentionIds,payload.attachments.map(a=>a.attachmentId),{...(payload.collaboration?{collaboration:payload.collaboration}:{}),...(payload.budgetMaxTurns!=null?{deliberationBudget:{maxTurns:payload.budgetMaxTurns}}:{})}));
  return {status:'failed',error:'R135 仅捕获发送参数，不执行任务'};
}})));}
async function mountComposer(saved={}){await unmount();store.setDraftFull(draftKey(),{body:'@分析员 请保留这份草稿',mentions:[ids[0]],attachments:[],access:'auto_edit',sendAs:'ai',collaboration:'deliberate',deliberateMemberIds:[ids[0],ids[1]],budgetMaxTurns:30,analysisOnly:true,...saved});renderComposer();await until(()=>editor());await pause(60);}
async function runMenu(){document.querySelector('[aria-label="本次运行设置"]').click();await until(()=>document.querySelector('.menu-label')?.textContent==='本次运行设置');await pause(25);}
async function membersMenu(){await runMenu();clickText('调整独立研讨成员');await until(()=>document.querySelector('.menu-label')?.textContent==='独立研讨成员');await pause(25);}
function draftFields(){const d=store.getDraftFull(draftKey());return {body:d.body,mentions:d.mentions,attachments:d.attachments,access:d.access,sendAs:d.sendAs,budgetMaxTurns:d.budgetMaxTurns,analysisOnly:d.analysisOnly,deliberateMemberIds:d.deliberateMemberIds};}
async function send(label,collaboration){const before=sends.length;document.querySelector('.composer-send').click();await until(()=>sends.length===before+1);await pause(30);const p=sends.at(-1);eq(label+'_collaboration',p.collaboration,collaboration);eq(label+'_access',p.access,'auto_edit');eq(label+'_legacy_single_mode_not_sent',p.analysisOnly,undefined);return p;}
let selectedFields;
window.runComposer=async()=>{
  roomIndex=0;targetKind='room_root';readOnly=false;await mountComposer();
  const initial=draftFields();await membersMenu();
  eq('member_menu_has_no_mode_exit',document.querySelector('.menu').textContent.includes('回到自然协作'),false);
  eq('member_menu_roster',document.querySelectorAll('.composer-mode-members button').length,3);
  document.querySelectorAll('.composer-mode-members button')[2].click();await pause(35);
  selectedFields=draftFields();eq('member_selection_saved',selectedFields.deliberateMemberIds,ids);
  eq('member_selection_preserves_other_fields',{...selectedFields,deliberateMemberIds:initial.deliberateMemberIds},initial);
  clickText('完成');await until(()=>!document.querySelector('.menu'));
  const deliberate=await send('deliberate_before_exit','deliberate');
  eq('deliberate_send_selected_members',deliberate.mentionIds,ids);eq('deliberate_budget',deliberate.budgetMaxTurns,30);
  eq('deliberate_envelope_mode',envelopes.at(-1).params.collaboration,'deliberate');
  eq('deliberate_envelope_budget',envelopes.at(-1).params.deliberationBudget,{maxTurns:30});
  await runMenu();const primary=document.querySelector('.menu');
  eq('primary_contains_parallel_actions',['调整独立研讨成员','回到自然协作'].every(text=>[...primary.querySelectorAll(':scope > button')].some(b=>b.textContent.trim().startsWith(text))),true);
  eq('opening_primary_keeps_draft',draftFields(),selectedFields);
  eq('chip_tooltip_only_member_action',document.querySelector('.composer-mode-chip').title,'独立研讨：先独立分析，再互评汇总；点击调整成员');
};
window.memberScreenshot=async()=>{clickText('调整独立研讨成员');await until(()=>document.querySelector('.composer-mode-members'));};
window.finishComposer=async()=>{
  clickText('完成');await runMenu();const beforeWrites=calls.length,beforeSends=sends.length;clickText('回到自然协作');await pause(40);
  eq('natural_exit_closes_menu',document.querySelector('.menu')==null,true);eq('natural_exit_removes_chip',document.querySelector('.composer-mode-chip')==null,true);
  eq('natural_exit_only_changes_collaboration',draftFields(),selectedFields);eq('natural_exit_draft_collaboration',store.getDraftFull(draftKey()).collaboration,undefined);
  eq('natural_exit_does_not_send',sends.length,beforeSends);eq('natural_exit_no_rpc',calls.length,beforeWrites);
  const natural=await send('natural_after_exit',undefined);eq('natural_send_body_mentions_only',natural.mentionIds,[ids[0]]);eq('natural_send_omits_deliberation_budget',natural.budgetMaxTurns,undefined);
  eq('natural_envelope_no_mode',envelopes.at(-1).params.collaboration,undefined);eq('natural_envelope_no_budget',envelopes.at(-1).params.deliberationBudget,undefined);
  const otherKey='room:'+rooms[1].id;store.setDraftFull(otherKey,{body:'另一个房间的草稿',mentions:[],attachments:[],access:'plan',sendAs:'ai'});const otherBefore=store.getDraftFull(otherKey);
  roomIndex=1;renderComposer();await pause(50);eq('other_room_no_mode_chip',document.querySelector('.composer-mode-chip')==null,true);
  roomIndex=0;renderComposer();await pause(50);eq('natural_mode_survives_room_roundtrip',document.querySelector('.composer-mode-chip')==null,true);
  eq('other_room_draft_fields_preserved',store.getDraftFull(otherKey).body,otherBefore.body);eq('other_room_access_preserved',store.getDraftFull(otherKey).access,'plan');
  await runMenu();eq('natural_menu_has_enable_only',document.querySelector('.menu').textContent.includes('回到自然协作'),false);clickText('独立研讨');await pause(40);
  eq('reenable_uses_existing_roster_rule',store.getDraftFull(draftKey()).deliberateMemberIds,ids);eq('reenable_keeps_body_and_access',editor().textContent===selectedFields.body&&store.getDraftFull(draftKey()).access==='auto_edit',true);
  document.querySelector('.composer-mode-chip').click();await until(()=>document.querySelector('.composer-mode-members'));
  eq('chip_opens_members_only',document.querySelector('.menu').textContent.includes('回到自然协作'),false);clickText('完成');
  // Thread and read-only/DM boundaries keep the same capability gates as before.
  targetKind='thread';await mountComposer({collaboration:undefined});await runMenu();clickText('独立研讨');await pause(30);await runMenu();
  eq('thread_primary_offers_natural_exit',document.querySelector('.menu').textContent.includes('回到自然协作'),true);clickText('回到自然协作');await pause(30);
  eq('thread_exit_keeps_permission',store.getDraftFull(draftKey()).access,'auto_edit');
  targetKind='dm';await mountComposer({collaboration:undefined});await runMenu();eq('dm_has_no_collaboration_actions',!document.querySelector('.menu').textContent.includes('回到自然协作')&&!document.querySelector('.menu').textContent.includes('调整独立研讨成员'),true);
  targetKind='room_root';readOnly=true;await mountComposer();await runMenu();eq('readonly_menu_has_no_mode_actions',!document.querySelector('.menu').textContent.includes('回到自然协作')&&!document.querySelector('.menu').textContent.includes('调整独立研讨成员'),true);
  readOnly=false;await mountComposer();await runMenu();clickText('回到自然协作');await pause(40);
};
window.report=()=>{
  const allowed=['recovery.status','task.get','deepLink.resolve','app.settings.get'];
  eq('only_read_rpcs_no_dispatch_or_resume',calls.filter(c=>!allowed.includes(c.method)).map(c=>c.method),[]);
  return {ok:checks.every(c=>c.ok),syntheticOnly:true,databaseOpened:false,realBusinessCalls:0,checks,calls,sends,envelopes};
};
`;

async function runVerifier() {
  fs.mkdirSync(out, { recursive: true });
  for (const file of ['ui-error-R135.txt', 'result-R135.json']) fs.rmSync(path.join(out, file), { force: true });
  fs.writeFileSync(path.join(out, 'harness-R135.tsx'), renderer);
  await require('esbuild').build({ entryPoints: [path.join(out, 'harness-R135.tsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, outfile: path.join(out, 'harness-R135.js'), logLevel: 'silent' });
  fs.writeFileSync(path.join(out, 'index-R135.html'), '<!doctype html><meta charset="utf-8"><title>R135 UI regression</title><link rel="stylesheet" href="harness-R135.css"><style>body{padding:48px;background:#f5f8fc}#root{max-width:1120px;margin:120px auto 0}.composer{position:relative;margin-top:100px}</style><div class="app-body"><div id="root"></div></div><script src="harness-R135.js"></script>');
  fs.writeFileSync(path.join(out, 'main-R135.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile-R135'));
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{backgroundThrottling:false,offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:false}});
async function run(code){return win.webContents.executeJavaScript(code);}
async function shot(name){win.webContents.invalidate();await new Promise(r=>setTimeout(r,180));fs.writeFileSync(path.join(__dirname,name+'-R135.png'),(await win.webContents.capturePage()).toPNG());}
try{
 await win.loadFile(path.join(__dirname,'index-R135.html'));
 await run('window.prepareRecovery()');await shot('recovery-before');
 await run('window.runRecovery()');await shot('recovery-failure');
 await run('window.finishRecovery()');await shot('recovery-located');
 await run('window.runComposer()');await shot('composer-primary');
 await run('window.memberScreenshot()');await shot('composer-members');
 await run('window.finishComposer()');await shot('composer-natural');
 const result=await run('window.report()');fs.writeFileSync(path.join(__dirname,'result-R135.json'),JSON.stringify(result,null,2));app.exit(result.ok?0:1);
}catch(e){fs.writeFileSync(path.join(__dirname,'ui-error-R135.txt'),String(e.stack));app.exit(2);}
});setTimeout(()=>app.exit(3),45000);
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(require('electron'), [path.join(out, 'main-R135.cjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 50000 });
  fs.writeFileSync(path.join(out, 'process-R135.json'), JSON.stringify({ exitCode: run.status, error: run.error?.message, stderr: run.stderr }, null, 2));
  if (!fs.existsSync(path.join(out, 'result-R135.json'))) throw Error('R135 Electron failed: ' + (fs.existsSync(path.join(out, 'ui-error-R135.txt')) ? fs.readFileSync(path.join(out, 'ui-error-R135.txt'), 'utf8') : JSON.stringify(run)));
  const report = JSON.parse(fs.readFileSync(path.join(out, 'result-R135.json'), 'utf8'));
  report.sourceRoot = root;
  report.sourceHashes = Object.fromEntries([
    'src/ui/hifi/components/RecoveryPanel.tsx', 'src/ui/hifi/components/Composer.tsx',
    'scripts/verify-R135-ui.cjs', 'tests/browser/uiR135.test.ts',
  ].map(file => [file, require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  report.screenshots = ['recovery-before', 'recovery-failure', 'recovery-located', 'composer-primary', 'composer-members', 'composer-natural'].map(name => path.join(out, name + '-R135.png'));
  report.ok = report.ok && run.status === 0;
  fs.writeFileSync(path.join(out, 'result-R135.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, 'report-R135.md'), [
    '# R135 UI 定向回归', '',
    '仅修改 RecoveryPanel.tsx、Composer.tsx，新增 verify-R135-ui.cjs 与 uiR135.test.ts。未提交。', '',
    '恢复面板四个定位入口共用成功关闭回调；失败保留弹窗，在弹窗内及 toast 显示可读错误，重试清理旧错误。导航仍经正式只读深链，不调用任务执行命令。', '',
    '“回到自然协作”移到“本次运行设置”一级，与“调整独立研讨成员”并列。成员菜单仅选择成员与完成；底部 chip tooltip 仅提示调整成员。未更改成员初始化/草稿保存/权限/单次发送规则。', '',
    '验证：正式 React 组件、CSS、命令桥、loader 深链和路由，在独立 Electron 内执行 DOM 点击；RPC 用内存合成回包。未启动 daemon、未打开数据库、未连接真实模型。路由落点用合成页面展示，未验证整套 Room/ThreadPanel 或后端执行。', '',
    '命令：node node_modules/vitest/vitest.mjs run tests/browser/uiR135.test.ts（该测试调用 node scripts/verify-R135-ui.cjs 的同一个 verifier）。', '',
    `Electron 退出码 ${run.status}；${report.checks.length} 个检查，${report.checks.filter(c => !c.ok).length} 失败。真实业务调用 0。`, '',
    '覆盖：四种定位按钮失败/延迟/成功关闭与线程、DM 落点；无界面落点错误；一级菜单并列；二级成员选择；正文/@、选中成员、权限、预算、旧单次标记保留；自然协作发送只取正文提及、不带研讨预算；线程、DM、只读边界；无 dispatch.resume/task.redispatch 等写命令。', '',
    '实际截图：', ...report.screenshots.map(file => '- ' + path.basename(file)), '',
    '首次回归曾因测试选择器未排除“已开启”提示文本而找不到菜单项；已修正选择器并保持原断言。', '',
    '逐项检查、实际读取命令与捕获的发送参数/正式信封见 result-R135.json；Electron 退出记录见 process-R135.json。源码 SHA256 记录于 result-R135.json。', '',
  ].join('\n'));
  console.log(JSON.stringify({ ok: report.ok, checks: report.checks.length, realBusinessCalls: 0, failures: report.checks.filter(c => !c.ok), screenshots: report.screenshots }, null, 2));
  return report;
}
module.exports = { runVerifier };
if (require.main === module) runVerifier().then(report => { process.exitCode = report.ok ? 0 : 1; }).catch(error => { console.error(error); process.exitCode = 2; });
