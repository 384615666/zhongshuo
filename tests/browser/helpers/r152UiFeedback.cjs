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
let capability = 'supported', readCount = 0;
window.zsWindow = {
  minimize: async () => { controls.push('minimize'); return {ok:true}; },
  toggleMaximize: async () => { controls.push('maximize'); return {ok:true}; },
  close: async () => { controls.push('close'); return {ok:true}; },
  getState: async () => ({ok:true,state:{maximized:false,fullScreen:false,focused:true}}),
  onStateChange: () => () => {},
};
window.zs = { command: async env => {
  calls.push(env.method);
  if (env.method === 'message.imageCapability') {
    readCount++;
    if (capability === 'error') return {ok:false,error:{code:'READ_FAILED',message:'图片能力暂时不可用'}};
    return {ok:true,data:{supported:capability==='supported',willDispatch:capability!=='record',members:[{kind:'codex',model:'fixture',channel:'fixture',configuration:'fixture',protocol:'fixture',status:capability,reason:'合成图片能力'}]}};
  }
  if (env.method === 'app.settings.get') return {ok:true,data:{values:{'callBudget.enabled':'false'}}};
  if (env.method === 'app.appearance.get') return {ok:true,data:{showAvatars:true,avatars:{}}};
  if (env.method === 'app.identity') return {ok:true,data:{localUserId:'synthetic',appDataDir:'合成测试目录'}};
  if (env.method === 'attachment.listByConversation') return {ok:true,data:{items:[]}};
  // Unrelated settings reads fail explicitly; this harness has no daemon or DB.
  return {ok:false,error:{code:'SYNTHETIC_ONLY',message:'合成界面没有连接后台服务'}};
}, onDisconnect:()=>{},onReconnected:()=>{} };
store.initDraftPersistence('r152-synthetic');
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
  ready:()=>!!document.querySelector('[data-zs-titlebar-rendered]')&&!!document.querySelector('.settings-nav'),
  theme:theme=>store.setTheme(theme),
  section:key=>{const labels={general:'通用',appearance:'外观',notifications:'通知',runtime:'AI 设置',connections:'连接与设备',data:'数据与存储',guide:'操作手册',help:'帮助与关于'};[...document.querySelectorAll('.settings-nav-item')].find(el=>el.textContent===labels[key]).click();},
  sectionReady:key=>location.hash.endsWith('section='+key)&&!!document.querySelector('.settings-nav-item[aria-current="page"]'),
  snapshot:()=>({nav:rect(document.querySelector('.settings-nav')),body:rect(document.querySelector('.settings-body')),layout:rect(document.querySelector('.settings-layout')),page:rect(document.querySelector('.page')),
    navItems:[...document.querySelectorAll('.settings-nav-item')].map(rect),overflow:document.querySelector('.page').scrollWidth-document.querySelector('.page').clientWidth,
    overflowNodes:[...document.querySelectorAll('.settings-body *')].filter(el=>rect(el).right>rect(document.querySelector('.settings-body')).right+1).slice(0,12).map(el=>({tag:el.tagName,cls:el.className,text:el.textContent.slice(0,100),rect:rect(el)})),
    frame:document.querySelector('iframe')?rect(document.querySelector('iframe')):null,
    guideTheme:document.querySelector('iframe')?.contentDocument?.documentElement.dataset.theme,
    guideLoaded:!!document.querySelector('iframe')?.contentDocument?.querySelector('main h1'),
    guideScroll:document.querySelector('iframe')?.contentDocument?.scrollingElement?.scrollHeight,
    pageScroll:document.querySelector('.page').scrollTop}),
  title:()=>({theme:document.documentElement.dataset.theme,root:getComputedStyle(document.getElementById('zs-titlebar')).backgroundColor,
    content:getComputedStyle(document.querySelector('[data-zs-titlebar-rendered]')).backgroundColor,
    text:getComputedStyle(document.querySelector('.zs-tb-project-name')).color,
    window:getComputedStyle(document.getElementById('hifi-root')).backgroundColor,
    controls:[...document.querySelectorAll('.zs-winbtn')].map(el=>({color:getComputedStyle(el).color,rect:rect(el),drag:getComputedStyle(el).webkitAppRegion})),controlsCalled:controls.slice(),
    drag:getComputedStyle(document.querySelector('[data-zs-titlebar-rendered] .zs-tb-drag')).webkitAppRegion}),
  composer:async mode=>{
    capability=mode;
    const route='/composer-'+mode, key=route.slice(1);
    store.setDraftFull(key,{body:'请看这张图片',mentions:['m'],attachments:[{name:'示例.png',size:128,attachmentId:'image-'+mode,kind:'image_file',revision:1}],access:'plan',sendAs:'ai'});
    navigate(route);
  },
  composerState:()=>({readCount,sends:sends.length,text:document.body.innerText,status:document.querySelector('[data-zs-image-status]')?.textContent,
    editor:!!document.querySelector('.composer-editor'),draft:store.getDraftFull(location.hash.slice(2)),
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
  await require('esbuild').build({ entryPoints:[entry],outfile:path.join(out,'ui.mjs'),bundle:true,platform:'browser',format:'esm',jsx:'automatic',logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'} });
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
   const sections=['appearance','general','notifications','runtime','connections','data','help','guide'];
   for(const size of [{width:3440,height:1440},{width:1920,height:1000},{width:1440,height:900},{width:1280,height:800},{width:1100,height:800},{width:900,height:760},{width:640,height:700}]) {
    win.setContentSize(size.width,size.height);await pause(60);let base;
    for(const section of sections) {
     await js('r152.section('+JSON.stringify(section)+')');await until('r152.sectionReady('+JSON.stringify(section)+')','section '+section);await pause(70);
     if(section==='guide')await until('r152.snapshot().guideLoaded','packaged guide');
     const s=await js('r152.snapshot()');samples.push({size,section,snapshot:s});base??=s;
     const name=size.width+'/'+section;
     check(name+'/same-nav-and-content-boundary',Math.abs(s.nav.x-base.nav.x)<.6&&Math.abs(s.body.x-base.body.x)<.6&&Math.abs(s.body.width-base.body.width)<.6&&Math.abs(s.nav.y-base.nav.y)<.6,{base,s});
     check(name+'/contained-navigation-and-content',s.overflow<1&&s.navItems.every(r=>r.x>=s.page.x&&r.right<=s.page.right+.6)&&s.body.right<=s.page.right+.6,s);
     if(section==='general'&&(size.width===3440||size.width===1280))await capture('settings-general-'+size.width);
     if(s.overflow>=1)await capture('overflow-'+size.width+'-'+section);
     if(section==='guide') {
      check(name+'/manual-uses-content-column',Math.abs(s.frame.x-s.body.x)<.6&&Math.abs(s.frame.width-s.body.width)<.6&&s.frame.width>=Math.min(300,s.body.width)&&s.frame.height>=250&&s.frame.bottom<=size.height+1,s);
      check(name+'/manual-theme-and-independent-scroll',s.guideTheme==='dark'&&s.guideScroll>s.frame.height&&s.pageScroll===0,s);
      await capture('settings-guide-'+size.width);
     }
     if(section==='appearance'&&(size.width===1920||size.width===640))await capture('settings-appearance-'+size.width);
    }
   }
   win.setContentSize(1100,760);await pause(50);
   for(const mode of ['supported','record','unsupported','error']) {
    const before=await js('r152.composerState().readCount');
    await js('r152.composer('+JSON.stringify(mode)+')');await until('r152.composerState().editor&&r152.composerState().readCount>'+before,'image capability '+mode);await pause(70);
    const state=await js('r152.composerState()');samples.push({mode,composer:state});
    check('composer/'+mode+'/ordinary-status-absent',!state.text.includes('图片会随消息发送')&&!state.text.includes('图片会保存到本机'),state);
    check('composer/'+mode+'/draft-and-image-preserved',state.draft.body.includes('请看这张图片')&&state.draft.attachments.length===1&&state.draft.attachments[0].attachmentId==='image-'+mode,state.draft);
    check('composer/'+mode+'/actionable-status',mode==='unsupported'?state.status?.includes('换成员或移除图片'):mode==='error'?state.status?.includes('读取失败'):state.status==null,state.status);
    if(mode==='supported'||mode==='record')await capture('composer-'+mode);
    if(mode==='supported'||mode==='unsupported'||mode==='error') {
     const sent=state.sends;await js("document.querySelector('.composer-send').click()");await pause(180);
     const after=await js('r152.composerState()');
     check('composer/'+mode+'/dispatch-gate',mode==='supported'?after.sends===sent+1:after.sends===sent&&((mode==='unsupported'&&after.text.includes('仅发送文字'))||(mode==='error'&&after.text.includes('图片发送能力读取失败'))),after);
    }
    if(mode==='unsupported'||mode==='error')await capture('composer-'+mode);
   }
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
