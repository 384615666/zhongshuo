import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve('.');
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
  }
});

describe('R115 ordinary sends and frozen read-only recovery', () => {
  it('ignores legacy draft flags while preserving the exact UNKNOWN request and revision settlement', async () => {
    const fixture = mkdtempSync(join(root, '.r115-composer-scope-'));
    temporaryDirectories.push(fixture);

    const harness = String.raw`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Composer} from '__ROOT__/src/ui/hifi/components/Composer.tsx';
import * as store from '__ROOT__/src/ui/hifi/data/store.ts';
const checks=[],payloads=[],retries=[];
let mounted=null,retrySucceeds=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test){for(let n=0;n<200;n++){if(test())return;await sleep(10);}throw Error('UI wait timed out: '+document.body.innerText);}
const check=(name,ok)=>checks.push({name,ok:Boolean(ok)});
window.zs={command:async env=>env.method==='app.settings.get'?{ok:true,data:{values:{'callBudget.enabled':'false'}}}:{ok:true,data:{}},onDisconnect:()=>{},onReconnected:()=>{}};
const key='room:r1';
const target={kind:'room_root',roomId:'r1'};
const baseDraft={body:'旧草稿内容',mentions:[],attachments:[],access:'default',sendAs:'ai',analysisOnly:true,deliberateMemberIds:[]};
function render(){
 mounted=createRoot(document.getElementById('root'));
 mounted.render(createElement(Composer,{draftKey:key,target,onSend:async payload=>{payloads.push(payload);return{status:'failed',error:'fixture rejection'};},onRetrySend:async env=>{retries.push(JSON.parse(JSON.stringify(env)));return retrySucceeds?{status:'ok'}:{status:'unknown',error:'fixture unknown'};}}));
}
async function mount(){
 if(mounted)mounted.unmount();
 store.setState(s=>({...s,activeProjectId:'p1',boot:'ready',drafts:{},pendingSends:{},outboundLedger:{},lastSendReferences:{},uploadItems:{},members:[],rooms:[{id:'r1',projectId:'p1',conversationId:'c1',name:'测试房间',memberIds:[]}],memberRuntimes:{},dispatchGuard:{fakeAllowed:true,realDispatchGuard:true}}));
 store.initDraftPersistence('r115-isolated|viewer');
 store.setDraftFull(key,baseDraft);render();
 await until(()=>document.querySelector('.composer-editor')?.innerText==='旧草稿内容');await sleep(40);
}
const send=()=>document.querySelector('.composer-send').click();
const retry=()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='重发原内容').click();
async function edit(text){const e=document.querySelector('.composer-editor');e.textContent=text;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));await until(()=>store.getDraftFull(key).body===text);await sleep(20);}
window.run=async()=>{
 await mount();
 check('removed_control_absent',!document.querySelector('[data-zs-analysis-only]')&&!document.body.innerText.includes('本次仅分析'));
 send();await until(()=>payloads.length===1&&document.body.innerText.includes('fixture rejection'));
 check('legacy_true_not_sent',!Object.hasOwn(payloads[0],'analysisOnly'));
 check('member_access_preserved',payloads[0].access==='default'&&!payloads[0].method.planFirst);
 await edit('普通新消息');send();await until(()=>payloads.length===2);
 check('next_message_not_analysis_only',payloads[1].body==='普通新消息'&&!Object.hasOwn(payloads[1],'analysisOnly'));
 await mount();
 const original={commandId:'cmd_original_readonly',method:'message.submit',params:{target:{kind:'room_root',projectId:'p1',conversationId:'c1',roomId:'r1'},body:'旧草稿内容',intent:'default',mentions:[],analysisOnly:true},targetLabel:'room:r1',at:1,revAtSend:store.getDraftFull(key).rev};
 store.stageOutbound(key,original);store.confirmOutboundUnknown(key,original);
 // Remount the actual Composer against persisted frozen state, without normalizing the draft revision.
 mounted.unmount();const before=store.getDraftFull(key).rev;render();
 await until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='重发原内容'));await sleep(40);
 check('mount_keeps_pending_draft_revision',store.getDraftFull(key).rev===before);
 const count=payloads.length;send();await until(()=>document.body.innerText.includes('内容未改'));
 check('same_content_cannot_resubmit_with_broader_scope',payloads.length===count);
 retry();await until(()=>retries.length===1&&document.body.innerText.includes('重发仍未知'));
 check('retry_exact_command_and_params',JSON.stringify(retries[0])===JSON.stringify(original));
 check('unknown_preserves_frozen_scope',store.getState().pendingSends[key].params.analysisOnly===true);
 await edit('未确认期间的新输入');send();await until(()=>payloads.length===count+1);await sleep(40);
 check('edited_input_uses_normal_scope',payloads.at(-1).body==='未确认期间的新输入'&&!Object.hasOwn(payloads.at(-1),'analysisOnly'));
 retrySucceeds=true;retry();await until(()=>retries.length===2&&store.getState().pendingSends[key]==null);
 check('successful_retry_still_exact',JSON.stringify(retries[1])===JSON.stringify(original));
 check('later_draft_survives_old_acceptance',store.getDraftFull(key).body==='未确认期间的新输入');
 await mount();const env={...original,revAtSend:store.getDraftFull(key).rev};store.stageOutbound(key,env);store.confirmOutboundUnknown(key,env);await until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='重发原内容'));retry();await until(()=>store.getState().pendingSends[key]==null);
 check('unchanged_draft_settles_after_retry',store.getDraftFull(key).body==='');
 return{ok:checks.every(c=>c.ok),checks};
};
`.replaceAll('__ROOT__', root.replaceAll('\\', '/'));

    writeFileSync(join(fixture, 'harness.tsx'), harness);
    writeFileSync(join(fixture, 'index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>');
    writeFileSync(join(fixture, 'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:false}});
  try{
    await win.loadFile(path.join(__dirname,'index.html'));
    const result=await win.webContents.executeJavaScript('window.run()');
    console.log('R115_RESULT '+JSON.stringify(result));
    app.exit(result.ok?0:1);
  }catch(error){
    console.log('R115_RESULT '+JSON.stringify({ok:false,error:String(error)}));
    app.exit(2);
  }
});
setTimeout(()=>app.exit(3),30000);
`);

    await build({
      entryPoints: [join(fixture, 'harness.tsx')],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      outfile: join(fixture, 'harness.js'),
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const processResult = spawnSync(resolve('node_modules/electron/dist/electron.exe'), [join(fixture, 'main.cjs')], {
      cwd: root,
      env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 35000,
    });
    const output = `${processResult.stdout ?? ''}\n${processResult.stderr ?? ''}`;
    const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('R115_RESULT '));
    const report = resultLine == null
      ? { ok: false, error: output.slice(-4000) }
      : JSON.parse(resultLine.slice('R115_RESULT '.length)) as {
          ok: boolean;
          checks?: Array<{ name: string; ok: boolean }>;
          error?: string;
        };

    expect(report, JSON.stringify(report)).toMatchObject({ ok: true });
    expect(report.checks).toHaveLength(12);
  }, 45000);
});
