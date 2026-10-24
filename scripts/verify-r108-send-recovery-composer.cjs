/* Isolated hidden Chromium mount of the actual Composer. No desktop input or daemon. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const fixture=path.join(root,'dist','r108-send-recovery-composer');
const harness=String.raw`
import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Composer} from '__ROOT__/src/ui/hifi/components/Composer.tsx';
import * as store from '__ROOT__/src/ui/hifi/data/store.ts';
const checks=[];let mounted=null,submitted=0,pendingLookup=null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test){for(let n=0;n<150;n++){if(test())return;await sleep(10);}throw Error('UI wait timed out: '+document.body.innerText);}
const check=(name,ok)=>checks.push({name,ok:Boolean(ok)});
window.zs={command:async env=>{
 if(env.method==='message.lookupSubmission')return await new Promise(resolve=>{pendingLookup=()=>resolve({ok:true,data:{status:'found',commandId:env.params.request.commandId,payloadHash:env.params.payloadHash,acceptedAt:1,location:{projectId:'p1',conversationId:'c1',roomId:'r1',threadId:'th1',taskId:'task1',messageId:'msg1'}}});});
 if(env.method==='app.settings.get')return{ok:true,data:{values:{'callBudget.enabled':'false'}}};
 return{ok:true,data:{}};
},onDisconnect:()=>{},onReconnected:()=>{},pickFolder:async()=>null};
function envelope(payload){return{commandId:payload.commandId,method:'message.submit',params:{target:{kind:'room_root',projectId:'p1',conversationId:'c1',roomId:'r1'},body:payload.body,intent:'default',mentions:[]},targetLabel:'room:r1',at:Date.now(),revAtSend:store.getDraftFull('room:r1').rev};}
async function mount(){
 if(mounted)mounted.unmount();submitted=0;pendingLookup=null;
 store.setState(s=>({...s,activeProjectId:'p1',boot:'ready',drafts:{},pendingSends:{},outboundLedger:{},lastSendReferences:{},uploadItems:{},members:[],rooms:[{id:'r1',projectId:'p1',conversationId:'c1',name:'测试房间',memberIds:[]}],memberRuntimes:{},dispatchGuard:{fakeAllowed:true,realDispatchGuard:true}}));
 store.initDraftPersistence('r108-composer|viewer');
 store.setDraftFull('room:r1',{body:'第一条原请求',mentions:[],attachments:[],access:'plan',sendAs:'ai'});
 mounted=createRoot(document.getElementById('root'));
 mounted.render(createElement(Composer,{draftKey:'room:r1',target:{kind:'room_root',roomId:'r1'},onSend:async payload=>{submitted++;const env=envelope(payload);store.stageOutbound('room:r1',env);if(submitted===1){store.confirmOutboundUnknown('room:r1',env);return{status:'unknown',error:'第一条回执丢失'};}store.dropOutbound('room:r1',env);return{status:'failed',error:'第二条明确拒绝'};}}));
 await until(()=>document.querySelector('.composer-editor')?.innerText.includes('第一条'));
}
const send=()=>document.querySelector('.composer-send').click();
const query=()=>document.querySelector('[data-zs-send-recovery] button').click();
function edit(text){const editor=document.querySelector('.composer-editor');editor.textContent=text;editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));}
window.run=async()=>{
 await mount();send();await until(()=>document.body.innerText.includes('发送结果未知'));
 check('unknown_error_visible_before_lookup',document.body.innerText.includes('第一条回执丢失'));
 query();await until(()=>pendingLookup!==null);pendingLookup();await until(()=>document.body.innerText.includes('已找到原消息'));
 check('same_request_unknown_error_cleared',!document.body.innerText.includes('发送结果未知'));
 check('lookup_does_not_send_again',submitted===1);
 check('accepted_draft_settled',store.getDraftFull('room:r1').body==='');
 await mount();send();await until(()=>document.body.innerText.includes('发送结果未知'));
 query();await until(()=>pendingLookup!==null);edit('后续修改的新草稿');await sleep(25);send();await until(()=>document.body.innerText.includes('第二条明确拒绝'));
 pendingLookup();await until(()=>store.getState().pendingSends['room:r1']==null);
 check('new_request_error_survives_old_lookup',document.body.innerText.includes('第二条明确拒绝'));
 check('later_draft_survives_old_lookup',document.querySelector('.composer-editor').innerText.includes('后续修改的新草稿'));
 check('only_explicit_sends_occurred',submitted===2);
 return{ok:checks.every(c=>c.ok),checks};
};
`;
const main=String.raw`
const {app,BrowserWindow}=require('electron');const path=require('node:path');
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:false}});try{await w.loadFile(path.join(__dirname,'index.html'));const result=await w.webContents.executeJavaScript('window.run()');console.log('R108_RESULT '+JSON.stringify(result));app.exit(result.ok?0:1);}catch(e){console.log('R108_RESULT '+JSON.stringify({ok:false,error:String(e)}));app.exit(2);}});
setTimeout(()=>app.exit(3),15000);
`;
async function runVerifier(){
 fs.mkdirSync(fixture,{recursive:true});
 fs.writeFileSync(path.join(fixture,'harness.tsx'),harness.replaceAll('__ROOT__',root.replaceAll('\\','/')));
 fs.writeFileSync(path.join(fixture,'index.html'),'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="harness.js"></script>');
 fs.writeFileSync(path.join(fixture,'main.cjs'),main);
 await require('esbuild').build({entryPoints:[path.join(fixture,'harness.tsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:path.join(fixture,'harness.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const result=spawnSync(require('electron'),[path.join(fixture,'main.cjs')],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:20000});
 const line=(result.stdout||'').split('\n').find(s=>s.startsWith('R108_RESULT '));
 const report=line?JSON.parse(line.slice(12)):{ok:false,error:(result.stderr||result.stdout||'No result').slice(-2000)};
 fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify(report,null,2));return report;
}
module.exports={runVerifier};
if(require.main===module)runVerifier().then(result=>{console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;});
