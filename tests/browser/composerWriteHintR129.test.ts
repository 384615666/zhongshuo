import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('R129 keeps advisory failures in the existing menu and refreshes without cancelling valid reads', async () => {
  const root = resolve('.');
  const fixture = mkdtempSync(join(root, '.r129-write-hint-'));
  try {
    writeFileSync(join(fixture, 'harness.tsx'), String.raw`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Composer} from '__ROOT__/src/ui/hifi/components/Composer.tsx';
import * as store from '__ROOT__/src/ui/hifi/data/store.ts';
import {bridgeErrorFacts} from '__ROOT__/src/ui/hifi/bridge.ts';
const checks=[],reads=[],sends=[],timers=new Map();
const root=createRoot(document.getElementById('root'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test){for(let n=0;n<200;n++){if(test())return;await sleep(10);}throw Error('wait timed out: '+document.body.innerText);}
const check=(name,ok)=>checks.push({name,ok:Boolean(ok)});
let visible=true,nextTimer=0;
Object.defineProperty(document,'visibilityState',{get:()=>visible?'visible':'hidden'});
const realInterval=window.setInterval.bind(window),realClear=window.clearInterval.bind(window);
window.setInterval=(fn,ms)=>ms===5000?(timers.set(--nextTimer,fn),nextTimer):realInterval(fn,ms);
window.clearInterval=id=>id<0?timers.delete(id):realClear(id);
const tick=()=>{for(const fn of timers.values())fn();};
window.zs={command:env=>{
 if(env.method==='app.settings.get')return Promise.resolve({ok:true,data:{values:{'callBudget.enabled':'false'}}});
 if(env.method==='message.writeCapability')return new Promise(resolve=>reads.push({env,resolve}));
 throw Error('unexpected command: '+env.method);
},onDisconnect:()=>{},onReconnected:()=>{}};
const key='thread:t1';
let target={kind:'thread',roomId:'r1',threadId:'t1'};
let conversationId,disabled;
function render(){root.render(createElement(Composer,{target,draftKey:key,formalLimits:{access:'由正式权限决定'},attachmentUpload:conversationId?{conversationId}:undefined,sendDisabledReason:disabled,onSend:async payload=>{sends.push(payload);return {status:'failed',error:'发送授权复查拒绝'};}}));}
function resolveRead(index,reason='CLI 完整权限'){reads[index].resolve({ok:true,data:{modificationAuthorized:true,fullAccess:true,willDispatch:true,reason}});}
function failRead(index){reads[index].resolve({ok:false,error:{code:'QUERY_UNAVAILABLE',message:'权限查询现场测试错误'}});}
const settings=()=>document.querySelector('[aria-label="本次运行设置"]').click();
const revision=n=>store.setState(s=>({...s,threadTasks:{t1:{...s.threadTasks.t1,revision:n}}}));
window.run=async()=>{
 store.setState(s=>({...s,activeProjectId:'p1',boot:'ready',drafts:{},pendingSends:{},outboundLedger:{},lastSendReferences:{},uploadItems:{},rooms:[{id:'r1',projectId:'p1',conversationId:'c1',name:'独立测试',memberIds:['m1'],coordinatorMemberId:'m1',revision:0,unread:0}],members:[{id:'m1',projectId:'p1',profileId:'',displayName:'Alpha',principalType:'agent',enabled:true,workState:'idle',internalSubagents:false}],threadMemberships:{t1:{eligibleMemberIds:['m1']}},threadTasks:{t1:{revision:1}},memberRuntimes:{m1:{status:'bound',kind:'fake'}},dispatchGuard:{fakeAllowed:true,realDispatchGuard:true}}));
 store.initDraftPersistence('r129-isolated|viewer');
 store.setDraftFull(key,{body:'普通输入',mentions:[],attachments:[],access:'default',sendAs:'ai'});
 render();await until(()=>document.querySelector('.composer-editor'));await sleep(30);
 check('loading_without_conversation_does_not_send_invalid_query',reads.length===0);
 conversationId='c1';render();await until(()=>reads.length===1);
 check('canonical_query_scope',JSON.stringify(reads[0].env.params)==='{"target":{"kind":"thread","projectId":"p1","conversationId":"c1","threadId":"t1"},"mentions":[]}');
 failRead(0);await until(()=>bridgeErrorFacts().some(f=>f.method==='message.writeCapability'));
 await sleep(30);
 check('failed_read_has_no_resident_warning',!document.querySelector('[data-zs-write-hint-error]')&&!document.body.innerText.includes('权限暂未刷新'));
 check('actual_failure_keeps_diagnostic_code',bridgeErrorFacts().some(f=>f.code==='QUERY_UNAVAILABLE'));
 settings();await until(()=>document.body.innerText.includes('权限查询现场测试错误'));
 check('existing_menu_displays_actual_failure',document.body.innerText.includes('权限查询现场测试错误'));
 settings();await sleep(20);
 tick();await until(()=>reads.length===2);resolveRead(1);await sleep(30);
 settings();await until(()=>document.body.innerText.includes('CLI 完整权限'));
 check('successful_poll_recovers_without_stale_error',!document.body.innerText.includes('权限查询现场测试错误'));
 settings();await sleep(20);
 tick();await until(()=>reads.length===3);
 target={...target,subtask:{taskId:'subtask',number:1,title:'仅展示标签'}};render();await sleep(30);
 check('subtask_display_does_not_restart_query',reads.length===3);
 revision(2);await sleep(20);revision(3);await sleep(20);
 check('revision_refresh_does_not_overlap_inflight_query',reads.length===3);
 resolveRead(2,'刷新前实际回执');await until(()=>reads.length===4);
 settings();await until(()=>document.body.innerText.includes('刷新前实际回执'));
 check('revision_refresh_keeps_inflight_response',document.body.innerText.includes('刷新前实际回执'));
 settings();resolveRead(3,'刷新后权限');await sleep(30);
 check('multiple_revisions_coalesce_one_followup',reads.length===4);
 tick();await until(()=>reads.length===5);
 target={kind:'thread',roomId:'r1',threadId:'t2'};render();await until(()=>reads.length===6);
 resolveRead(5,'新目标只读权限');await sleep(30);failRead(4);await sleep(30);
 settings();await until(()=>document.body.innerText.includes('新目标只读权限'));
 check('old_target_failure_cannot_overwrite_new_scope',!document.body.innerText.includes('权限查询现场测试错误'));
 settings();await sleep(20);
 visible=false;tick();await sleep(20);check('hidden_document_skips_poll',reads.length===6);
 visible=true;document.dispatchEvent(new Event('visibilitychange'));await until(()=>reads.length===7);
 failRead(6);await sleep(30);
 document.querySelector('.composer-send').click();await until(()=>sends.length===1&&document.body.innerText.includes('发送授权复查拒绝'));
 check('advisory_failure_does_not_replace_send_authorization',sends.length===1&&sends[0].access==='default'&&!Object.hasOwn(sends[0],'analysisOnly'));
 check('real_send_rejection_remains_visible',document.body.innerText.includes('发送授权复查拒绝'));
 disabled='不可发送';render();await sleep(30);tick();await sleep(20);
 check('disabled_input_stops_advisory_poll',reads.length===7&&timers.size===0);
 root.unmount();
 return {ok:checks.every(c=>c.ok),checks};
};
`.replaceAll('__ROOT__', root.replaceAll('\\', '/')));
    writeFileSync(join(fixture, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>');
    writeFileSync(join(fixture, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
app.disableHardwareAcceleration();
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:false}});
 try{await win.loadFile(path.join(__dirname,'index.html'));const result=await win.webContents.executeJavaScript('window.run()');console.log('R129_RESULT '+JSON.stringify(result));app.exit(result.ok?0:1);}
 catch(error){console.log('R129_RESULT '+JSON.stringify({ok:false,error:String(error)}));app.exit(2);}
});
setTimeout(()=>app.exit(3),30000);
`);
    await build({ entryPoints: [join(fixture, 'harness.tsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(fixture, 'harness.js'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(resolve('node_modules/electron/dist/electron.exe'), [join(fixture, 'main.cjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 35000 });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const line = output.split(/\r?\n/).find(line => line.startsWith('R129_RESULT '));
    const report = line ? JSON.parse(line.slice('R129_RESULT '.length)) as {ok: boolean; checks: Array<{name: string; ok: boolean}>} : {ok: false, output};
    expect(report, JSON.stringify(report)).toMatchObject({ok: true});
    if ('checks' in report) expect(report.checks).toHaveLength(15);
  } finally {
    rmSync(fixture, {recursive: true, force: true, maxRetries: 4, retryDelay: 100});
  }
}, 45000);
