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

describe('R114 Composer call-budget display', () => {
  it('hides disabled copy, keeps enabled editing, and preserves read errors without blocking sends', async () => {
    const fixture = mkdtempSync(join(root, '.r114-composer-budget-'));
    temporaryDirectories.push(fixture);

    const harness = String.raw`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Composer} from '__ROOT__/src/ui/hifi/components/Composer.tsx';
import * as store from '__ROOT__/src/ui/hifi/data/store.ts';
import {CALL_BUDGET_ENABLED_SETTING_KEY} from '__ROOT__/src/contracts/callBudget.ts';

const checks=[];
const root=createRoot(document.getElementById('root'));
const payloads=[];
let settingMode='false';
let settingsReads=0;
let revision=0;
let settingReadsBeforeMount=0;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test){
  for(let n=0;n<200;n++){
    if(test()) return;
    await sleep(10);
  }
  throw new Error('UI wait timed out: '+document.body.innerText);
}
function check(name,ok){ checks.push({name,ok:Boolean(ok)}); }
function member(id,name){
  return {
    id,projectId:'p1',profileId:'',displayName:name,principalType:'agent',enabled:true,
    workState:'idle',model:'fake',effort:'low',internalSubagents:false,isCoordinatorDefault:id==='m1'
  };
}
function targetOf(kind){
  if(kind==='dm') return {kind:'dm',roomId:'dm:c1',dmId:'c1'};
  if(kind==='thread') return {kind:'thread',roomId:'r1',threadId:'t1'};
  return {kind:'room_root',roomId:'r1'};
}
function draftKeyOf(kind){ return kind==='dm'?'dm:c1':kind==='thread'?'thread:t1':'room:r1'; }
function buttonByText(text){
  return [...document.querySelectorAll('button')].find(button=>button.textContent?.trim().includes(text));
}
function openRunSettings(){
  const button=document.querySelector('button[aria-label="本次运行设置"]');
  if(!(button instanceof HTMLButtonElement)) throw new Error('run settings button missing');
  button.click();
}
async function editBody(text){
  const editor=document.querySelector('.composer-editor');
  if(editor==null) throw new Error('composer editor missing');
  editor.textContent=text;
  editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
  await until(()=>document.querySelector('.composer-send')?.disabled===false);
}
async function mount(kind){
  const draftKey=draftKeyOf(kind);
  store.setState(state=>({
    ...state,activeProjectId:'p1',boot:'ready',drafts:{},pendingSends:{},outboundLedger:{},
    lastSendReferences:{},uploadItems:{},
    rooms:[{id:'r1',projectId:'p1',conversationId:'c1',name:'Test room',coordinatorMemberId:'m1',memberIds:['m1','m2'],revision:1,unread:0}],
    dms:[{id:'c1',projectId:'p1',title:'Test DM',memberIds:['m1'],threadId:'dm-t1',createdAt:1,lastMessageAt:1,unread:0}],
    threadMemberships:{t1:{eligibleMemberIds:['m1','m2']}},
    members:[member('m1','Alpha'),member('m2','Beta')],
    memberRuntimes:{
      m1:{status:'bound',kind:'fake',model:'fake'},
      m2:{status:'bound',kind:'fake',model:'fake'}
    },
    profiles:[],runtimeInstallations:[],
    dispatchGuard:{fakeAllowed:true,realDispatchGuard:true}
  }));
  store.initDraftPersistence('r114-composer|viewer');
  store.setDraftFull(draftKey,{body:'',mentions:[],attachments:[],access:'default',sendAs:'ai'});
  settingReadsBeforeMount=settingsReads;
  root.render(createElement(Composer,{
    key:String(++revision),
    draftKey,
    target:targetOf(kind),
    onSend:async payload=>{payloads.push(payload);return{status:'ok'};}
  }));
  await until(()=>document.querySelector('.composer-editor')!=null&&settingsReads>settingReadsBeforeMount);
  await sleep(30);
}

window.zs={
  command:async envelope=>{
    if(envelope.method==='app.settings.get'){
      settingsReads++;
      if(settingMode==='error'){
        return{ok:false,error:{code:'SETTINGS_UNAVAILABLE',message:'settings read failed'}};
      }
      return{ok:true,data:{values:{[CALL_BUDGET_ENABLED_SETTING_KEY]:settingMode}}};
    }
    return{ok:true,data:{}};
  },
  onDisconnect:()=>{},onReconnected:()=>{},pickFolder:async()=>null
};

window.run=async()=>{
  for(const kind of ['room_root','thread','dm']){
    settingMode='false';
    await mount(kind);
    check('disabled_'+kind+'_toolbar_hidden',document.querySelector('[data-zs-call-budget]')==null);
    check('disabled_'+kind+'_copy_hidden',!document.body.innerText.includes('调用预算未启用'));
    openRunSettings();
    await until(()=>document.querySelector('.menu')!=null);
    check('disabled_'+kind+'_menu_section_hidden',document.querySelector('[data-zs-call-budget-menu]')==null);
  }

  for(const kind of ['room_root','thread','dm']){
    settingMode='true';
    await mount(kind);
    const budget=document.querySelector('[data-zs-call-budget="enabled"]');
    check('enabled_'+kind+'_toolbar_visible',budget?.textContent?.includes('最多')===true);
    openRunSettings();
    await until(()=>document.querySelector('.menu')!=null);
    check('enabled_'+kind+'_menu_visible',document.querySelector('[data-zs-call-budget-menu="enabled"]')!=null);
  }

  settingMode='true';
  await mount('room_root');
  openRunSettings();
  await until(()=>buttonByText('独立研讨')!=null);
  buttonByText('独立研讨').click();
  await until(()=>document.querySelector('[data-zs-call-budget="enabled"]')?.tagName==='BUTTON');
  const budgetButton=document.querySelector('[data-zs-call-budget="enabled"]');
  budgetButton.click();
  await until(()=>document.querySelector('.composer-budget-editor input')!=null);
  const input=document.querySelector('.composer-budget-editor input');
  const valueSetter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  valueSetter.call(input,'19');
  input.dispatchEvent(new Event('input',{bubbles:true}));
  buttonByText('保存').click();
  await until(()=>document.querySelector('[data-zs-call-budget="enabled"]')?.textContent?.includes('19')===true);
  check('deliberate_budget_remains_editable',store.getDraftFull('room:r1').budgetMaxTurns===19);
  await editBody('deliberate budget send');
  document.querySelector('.composer-send').click();
  await until(()=>payloads.length===1);
  check('enabled_deliberate_send_keeps_budget',payloads[0]?.collaboration==='deliberate'&&payloads[0]?.budgetMaxTurns===19);

  settingMode='error';
  payloads.length=0;
  await mount('room_root');
  check('read_error_toolbar_quiet',document.querySelector('[data-zs-call-budget]')==null);
  openRunSettings();
  await until(()=>document.querySelector('[data-zs-call-budget-read-error="1"]')!=null);
  check('read_error_kept_useful',document.querySelector('[data-zs-call-budget-read-error="1"]').textContent.includes('settings read failed'));
  await editBody('send despite unreadable setting');
  document.querySelector('.composer-send').click();
  await until(()=>payloads.length===1);
  check('read_error_send_not_blocked',payloads[0]?.body==='send despite unreadable setting'&&payloads[0]?.budgetMaxTurns==null);

  return{ok:checks.every(item=>item.ok),checks,settingsReads};
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
    console.log('R114_RESULT '+JSON.stringify(result));
    app.exit(result.ok?0:1);
  }catch(error){
    console.log('R114_RESULT '+JSON.stringify({ok:false,error:String(error)}));
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
    const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('R114_RESULT '));
    const report = resultLine == null
      ? { ok: false, error: output.slice(-4000) }
      : JSON.parse(resultLine.slice('R114_RESULT '.length)) as {
          ok: boolean;
          checks?: Array<{ name: string; ok: boolean }>;
          error?: string;
        };

    expect(report, JSON.stringify(report)).toMatchObject({ ok: true });
    expect(report.checks).toHaveLength(20);
  }, 45000);
});
