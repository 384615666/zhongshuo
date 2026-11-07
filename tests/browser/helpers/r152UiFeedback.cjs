/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
// Actual production components/CSS in isolated Electron, with a synthetic bridge.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');

const renderer = String.raw`
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { TitleBar } from '../../../src/ui/hifi/components/TitleBar.tsx';
import { SettingsPage } from '../../../src/ui/hifi/pages/SettingsPage.tsx';
import { Composer } from '../../../src/ui/hifi/components/Composer.tsx';
import * as store from '../../../src/ui/hifi/data/store.ts';
import { navigate, useHashRoute, parseQuery } from '../../../src/ui/hifi/lib/router.ts';
const calls = [], sends = [], controls = [];
window.zsWindow = {
  minimize: async () => { controls.push('minimize'); return {ok:true}; },
  toggleMaximize: async () => { controls.push('maximize'); return {ok:true}; },
  close: async () => { controls.push('close'); return {ok:true}; },
  getState: async () => ({ok:true,state:{maximized:false,fullScreen:false,focused:true}}),
  onStateChange: () => () => {},
};
window.zs = { command: async env => {
  calls.push(env.method);
  if (env.method === 'app.settings.get') return {ok:true,data:{values:{'callBudget.enabled':'false'}}};
  if (env.method === 'app.appearance.get') return {ok:true,data:{showAvatars:true,avatars:{}}};
  if (env.method === 'app.identity') return {ok:true,data:{localUserId:'synthetic',appDataDir:'合成测试目录'}};
  if (env.method === 'attachment.listByConversation') return {ok:true,data:{items:[]}};
  // Unrelated settings reads fail explicitly; this harness has no daemon or DB.
  return {ok:false,error:{code:'SYNTHETIC_ONLY',message:'合成界面没有连接后台服务'}};
}, onDisconnect:()=>{},onReconnected:()=>{} };
store.initDraftPersistence('r152-synthetic');
const linkOpens = [];
window.zsAppLinks = { open: async (target) => { linkOpens.push(target); return { ok: true }; } };
store.setState(s=>({...s,boot:'ready',conn:'online',activeProjectId:'p',
  projects:[{id:'p',displayName:'界面验证项目',rootPath:'合成目录',revision:1}],
  members:[{id:'m',projectId:'p',displayName:'图片成员',ordinal:1,principalType:'agent',enabled:true,workState:'idle',model:'fixture',effort:'low',internalSubagents:false,isCoordinatorDefault:true}],
  rooms:[{id:'r',projectId:'p',conversationId:'c',name:'合成房间',coordinatorMemberId:'m',memberIds:['m'],revision:1,unread:0}],
  memberRuntimes:{m:{status:'bound',kind:'codex',model:'fixture'}},
  drafts:{},uploadItems:{},pendingSends:{},outboundLedger:{},
}));
function Harness() {
  const route = useHashRoute(), theme = store.useStore(s=>s.ui.theme);
  useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
  return <><TitleBar/><div className="app"><div className="app-body">
    <aside className="sidebar"><div className="brand">众说</div><div className="small">界面验证项目</div></aside>
    {route.startsWith('/composer') ? <div className="main" style={{justifyContent:'flex-end'}}>
      <Composer key={route} draftKey={route.slice(1)} target={{kind:'room_root',roomId:'r'}} attachmentUpload={{conversationId:'c'}}
        onSend={async payload=>{sends.push(payload);return {status:'failed',error:'合成测试不提交消息'};}}/>
    </div> : <SettingsPage query={parseQuery(route)}/>}
  </div></div></>;
}
document.body.classList.add('hifi-on');
navigate('/settings?section=appearance');
createRoot(document.getElementById('hifi-root')).render(<Harness/>);
const rect = el => {const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
window.r152 = {
  ready:()=>!!document.querySelector('[data-zs-titlebar-rendered]')&&!!document.querySelector('.settings-single'),
  theme:theme=>store.setTheme(theme),
  // R157 单页设置：不再有左侧分区菜单；?section= 只负责滚动到对应段落。
  section:key=>{const el=document.getElementById('settings-section-'+key);if(el)el.scrollIntoView({block:'start'});},
  sectionReady:key=>!!document.getElementById('settings-section-'+key),
  clickManual:()=>{const b=document.querySelector('[data-zs-open-link="manual"]');if(b)b.click();},
  linkOpens:()=>linkOpens.slice(),
  snapshot:()=>({single:rect(document.querySelector('.settings-single')),body:rect(document.querySelector('.settings-single')),page:rect(document.querySelector('.page')),
    nav:!!document.querySelector('.settings-nav'),
    sections:[...document.querySelectorAll('[data-settings-section]')].map(el=>({key:el.dataset.settingsSection,rect:rect(el)})),
    sectionTitles:[...document.querySelectorAll('.settings-section-title')].map(el=>el.textContent),
    overflow:document.querySelector('.page').scrollWidth-document.querySelector('.page').clientWidth,
    overflowNodes:[...document.querySelectorAll('.settings-single *')].filter(el=>rect(el).right>rect(document.querySelector('.settings-single')).right+1).slice(0,12).map(el=>({tag:el.tagName,cls:el.className,text:el.textContent.slice(0,100),rect:rect(el)})),
    manualRow:!!document.querySelector('[data-zs-open-link="manual"]'),
    githubRow:!!document.querySelector('[data-zs-open-link="github"]'),
    homepageRow:!!document.querySelector('[data-zs-open-link="homepage"]'),
    legacyRows:['连接与设备','打开一个定位链接','本机运行状态'].filter(text=>document.body.innerText.includes(text)),
    firstRowLabelWidth:(()=>{const el=document.querySelector('.settings-sections .pset-row-label');return el?rect(el).width:0;})(),
    pageScroll:document.querySelector('.page').scrollTop}),
  title:()=>({theme:document.documentElement.dataset.theme,root:getComputedStyle(document.getElementById('zs-titlebar')).backgroundColor,
    content:getComputedStyle(document.querySelector('[data-zs-titlebar-rendered]')).backgroundColor,
    text:getComputedStyle(document.querySelector('.zs-tb-project-name')).color,
    window:getComputedStyle(document.getElementById('hifi-root')).backgroundColor,
    controls:[...document.querySelectorAll('.zs-winbtn')].map(el=>({color:getComputedStyle(el).color,rect:rect(el),drag:getComputedStyle(el).webkitAppRegion})),controlsCalled:controls.slice(),
    drag:getComputedStyle(document.querySelector('[data-zs-titlebar-rendered] .zs-tb-drag')).webkitAppRegion}),
  composer:async ()=>{
    const route='/composer-image', key=route.slice(1);
    store.setDraftFull(key,{body:'请看这张图片',mentions:['m'],attachments:[{name:'示例.png',size:128,attachmentId:'image-synthetic',kind:'image_file',revision:1}],access:'plan',sendAs:'ai'});
    navigate(route);
  },
  composerState:()=>({sends:sends.length,text:document.body.innerText,
    editor:!!document.querySelector('.composer-editor'),draft:store.getDraftFull(location.hash.slice(2)),
    statusElement:!!document.querySelector('[data-zs-image-status]'),
    gate:!!document.querySelector('.composer-info-chip button[title*="文字"]')}),
  calls:()=>calls,
};
`;

async function runVerifier() {
  const out = path.join(root, 'dist/r152-ui-feedback', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(out, { recursive: true });
  // Three levels below root, matching imports above.
  const entry = path.join(out, 'entry.tsx');
  fs.writeFileSync(entry, renderer);
  await require('esbuild').build({ entryPoints:[entry],outfile:path.join(out,'ui.mjs'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',loader:{'.png':'dataurl'},logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'} });
  fs.writeFileSync(path.join(out,'app.css'),['tokens.css','base.css','components.css','preview.css','titlebar.css','h1-overrides.css'].map(f=>fs.readFileSync(path.join(root,'src/ui/hifi/styles',f),'utf8')).join('\n'));
  fs.copyFileSync(path.join(root,'src/ui/renderer/style.css'),path.join(out,'legacy.css'));
  fs.copyFileSync(path.join(root,'src/ui/renderer/hifi-flag.js'),path.join(out,'hifi-flag.js'));
  const guide = await import(pathToFileURL(path.join(root,'scripts/package-user-guide.mjs')).href);
  guide.packageUserGuideAssets(path.join(out,'user-guide'));
  fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="legacy.css"><div id="zs-titlebar"></div><div id="hifi-root"></div><script src="hifi-flag.js"></script><link rel="stylesheet" href="app.css"><script type="module" src="ui.mjs"></script>');
  fs.writeFileSync(path.join(out,'main.cjs'), String.raw`
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
app.on('window-all-closed',()=>{});
const checks=[],samples=[],screenshots=[],errors=[];
const check=(name,ok,detail)=>checks.push({name,ok:!!ok,detail});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const rgb=s=>(s.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
const luminance=s=>rgb(s).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((v,n,i)=>v+n*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
app.whenReady().then(async()=>{
 let win;
 try {
  for(const nativeFrame of [false,true]) {
   win=new BrowserWindow({show:false,frame:nativeFrame,backgroundColor:'#ffffff',width:1440,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
   const js=code=>win.webContents.executeJavaScript(code);
   const until=async(code,label)=>{for(let i=0;i<150;i++){if(await js(code))return;await pause(20);}throw Error('timeout '+label);};
   const capture=async name=>{await pause(60);win.webContents.invalidate();const file=name+'.png';fs.writeFileSync(path.join(__dirname,file),(await win.webContents.capturePage()).toPNG());screenshots.push(file);};
   win.webContents.on('console-message',(_event,_level,message)=>{if(message?.includes('Error'))errors.push(message);});
   await win.loadFile(path.join(__dirname,'index.html'));await until('window.r152?.ready()','mounted');
   for(const theme of ['dark','light','dark']) {
    await js('r152.theme('+JSON.stringify(theme)+')');await pause(60);
    const t=await js('r152.title()');samples.push({nativeFrame,theme,title:t});
    const prefix=(nativeFrame?'native':'frameless')+'/'+theme;
    const painted=await win.webContents.capturePage(),bitmap=painted.toBitmap(),imageSize=painted.getSize();
    const at=(Math.floor(imageSize.width/2)+18*imageSize.width)*4;
    const paintedTitle=[bitmap[at+2],bitmap[at+1],bitmap[at]];
    check(prefix+'/native-white-undercoat-covered',paintedTitle.every((value,i)=>Math.abs(value-rgb(t.content)[i])<=1),{nativeBackground:win.getBackgroundColor(),paintedTitle,css:t.content});
    check(prefix+'/both-titlebar-layers-themed',t.root===t.content&&((luminance(t.content)<.1)===(theme==='dark')),t);
    check(prefix+'/readable-project-and-controls',contrast(t.content,t.text)>=4.5&&t.controls.every(c=>contrast(t.content,c.color)>=4.5),t);
    check(prefix+'/window-surface-themed',(luminance(t.window)<.1)===(theme==='dark'),t.window);
    check(prefix+'/drag-and-controls',t.drag==='drag'&&t.controls.every(c=>c.drag==='no-drag'&&c.rect.height>=30&&c.rect.width>=30));
    if(!nativeFrame&&theme==='light')await capture('frameless-renderer-light');
   }
   if(nativeFrame) {await capture('native-renderer-dark');win.destroy();continue;}
   await capture('frameless-renderer-dark');
   await js("document.querySelector('.zs-winbtn').click();document.querySelector('.zs-winbtn.close').click()");
   check('frameless/window-buttons-bridge',(await js('r152.title().controlsCalled')).join(',')==='minimize,close');
   // R157：设置改成单页（无左侧分区菜单），所有分区自上而下排在一页里。
   const sections=['appearance','notifications','runtime','data','help'];
   for(const size of [{width:3440,height:1440},{width:1920,height:1000},{width:1440,height:900},{width:1280,height:800},{width:1100,height:800},{width:900,height:760},{width:640,height:700}]) {
    win.setContentSize(size.width,size.height);await pause(80);
    await js("document.querySelector('.page').scrollTop=0;true");await pause(40);
    const s=await js('r152.snapshot()');samples.push({size,snapshot:s});
    const name=size.width+'';
    check(name+'/single-column-no-side-menu',s.nav===false&&s.sections.length===sections.length&&s.sections.map(x=>x.key).join(',')===sections.join(','),{nav:s.nav,keys:s.sections.map(x=>x.key)});
    check(name+'/content-width-capped',s.single.width<=901,{width:s.single.width});
    check(name+'/content-inside-page',s.single.x>=s.page.x+16&&s.single.right<=s.page.right-16,{single:s.single,page:s.page});
    check(name+'/no-horizontal-overflow',s.overflow<1,s);
    check(name+'/sections-stacked-in-order',s.sections.every((sec,i)=>i===0||sec.rect.y>s.sections[i-1].rect.y),s.sections.map(x=>({key:x.key,y:x.rect.y})));
    check(name+'/legacy-sections-removed',s.legacyRows.length===0,s.legacyRows);
    // 窄窗：设置行改成上下排，名称不能被挤成一列竖排文字。
    check(name+'/row-label-keeps-reading-width',s.firstRowLabelWidth>=150,{width:s.firstRowLabelWidth});
    if(size.width===1440||size.width===640)await capture('settings-single-'+size.width);
   }
   // 深链：?section=help 只负责滚动到帮助段，不再切换分区菜单。
   win.setContentSize(1280,800);await pause(60);
   await js("location.hash='#/settings?section=help';true");await pause(400);
   const helpState=await js('r152.snapshot()');
   check('deep-link-scrolls-to-help',helpState.pageScroll>0,{pageScroll:helpState.pageScroll});
   check('help-external-links-present',helpState.manualRow&&helpState.githubRow&&helpState.homepageRow,{manual:helpState.manualRow,github:helpState.githubRow,homepage:helpState.homepageRow});
   await js('r152.clickManual()');await pause(150);
   const opened=await js('r152.linkOpens()');
   check('manual-opens-via-main-bridge',opened.join(',')==='manual',opened);
   await capture('settings-help-1280');
   win.setContentSize(1100,760);await pause(50);
   // R194：图片随消息直接发送——输入条不再显示图片能力提示条/二选一弹层，也不再预检 message.imageCapability。
   await js('r152.composer()');
   await until('r152.composerState().editor','composer editor');await pause(200);
   const state=await js('r152.composerState()');samples.push({composer:state});
   check('composer/image/no-image-status-prompt',state.statusElement===false&&!state.text.includes('图片会随消息发送')&&!state.text.includes('图片会保存到本机'),state);
   check('composer/image/draft-and-image-preserved',state.draft.body.includes('请看这张图片')&&state.draft.attachments.length===1&&state.draft.attachments[0].attachmentId==='image-synthetic',state.draft);
   check('composer/image/no-two-way-gate',state.gate===false,state.gate);
   {
    const sent=state.sends;await js("document.querySelector('.composer-send').click()");await pause(180);
    const after=await js('r152.composerState()');
    check('composer/image/sends-without-extra-confirmation',after.sends===sent+1,after);
   }
   check('composer/image/no-image-capability-precheck',!(await js('r152.calls()')).includes('message.imageCapability'),await js('r152.calls()'));
   await capture('composer-image');
   check('no-business-command-issued',!(await js('r152.calls()')).includes('message.submit'));
   win.destroy();
  }
  const report={ok:checks.every(c=>c.ok),realBusinessCalls:0,databaseOpened:false,daemonStarted:false,checks,samples,screenshots,errors};
  fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(report,null,2));app.exit(report.ok?0:1);
 } catch(e) {fs.writeFileSync(path.join(__dirname,'error.txt'),e.stack);if(win&&!win.isDestroyed())fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(2);}
});setTimeout(()=>app.exit(3),55000);
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];
  const proc=spawnSync(require('electron'),[path.join(out,'main.cjs')],{cwd:root,env,windowsHide:true,encoding:'utf8',timeout:60000});
  const resultFile=path.join(out,'result.json');
  if(!fs.existsSync(resultFile))throw Error(`R152 verifier exited ${proc.status}: ${fs.existsSync(path.join(out,'error.txt'))?fs.readFileSync(path.join(out,'error.txt'),'utf8'):proc.stderr}; evidence ${out}`);
  const report=JSON.parse(fs.readFileSync(resultFile,'utf8'));report.evidence=out;
  return report;
}
module.exports={runVerifier};
if(require.main===module)runVerifier().then(r=>{console.log(JSON.stringify({ok:r.ok,checks:r.checks.length,failed:r.checks.filter(c=>!c.ok),evidence:r.evidence},null,2));process.exitCode=r.ok?0:1;}).catch(e=>{console.error(e);process.exitCode=2;});
