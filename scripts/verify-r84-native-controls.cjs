/* global require,process,console */
/* eslint-disable @typescript-eslint/no-require-imports -- isolated native control windows, no input injection */
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const out=path.resolve(process.argv[2]);if(fs.existsSync(out))throw Error('fresh evidence root required');fs.mkdirSync(out,{recursive:true});
const entry=path.join(out,'host.cjs'),electron=path.resolve(process.argv[3]?.startsWith('--')?require('electron'):process.argv[3]??require('electron'));
const code=`const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));let rows=[];app.whenReady().then(()=>{for(const frame of [true,false]){const w=new BrowserWindow({width:700,height:400,frame,title:frame?'R84 Framed Control':'R84 Minimal Drag',webPreferences:{contextIsolation:true,nodeIntegration:false}});const sample=kind=>{if(w.isDestroyed())return;rows.push({at:Date.now(),kind,title:w.getTitle(),id:w.id,bounds:w.getBounds(),contentBounds:w.getContentBounds(),maximized:w.isMaximized()});if(rows.length>200)rows.shift();fs.writeFileSync(path.join(__dirname,'rectangles.json'),JSON.stringify(rows,null,2));};for(const e of ['ready-to-show','move','moved','resize','maximize','unmaximize','focus','blur'])w.on(e,()=>sample(e));w.loadURL('data:text/html,'+encodeURIComponent('<meta charset="utf-8"><title>'+(frame?'R84 Framed Control':'R84 Minimal Drag')+'</title><style>body{margin:0;background:#f7fafc}header{height:60px;background:#cfe6fc;-webkit-app-region:drag;app-region:drag;user-select:none}</style><header>R84 own native drag control</header><p>Engineering control only. No user data or model calls.</p>'));w.on('closed',()=>{if(!BrowserWindow.getAllWindows().length)app.quit();});}});`;
// Keep both native wrappers strongly referenced. Periodic observations are reads,
// not generated move events; the bounded file records a fresh rectangle after input.
const measuredCode=code.replace('let rows=[];', 'let rows=[],windows=[];')
  .replace('for(const frame of [true,false])', process.argv.includes('--framed')?'for(const frame of [true])':'for(const frame of [true,false])')
  .replace('const sample=kind=>', 'windows.push(w);const sample=kind=>')
  .replace('maximized:w.isMaximized()', 'maximized:w.isMaximized(),visible:w.isVisible(),minimized:w.isMinimized()')
  .replace("w.loadURL(", "w.once('ready-to-show',()=>w.show());w.loadURL(")
  .replace("w.on('closed',()=>", "const tick=setInterval(()=>sample('sample'),500);w.on('closed',()=>{clearInterval(tick);});w.on('closed',()=>");
// This is an explicitly visible interactive GUI control, not a background helper.
// SW_HIDE from process startup hides its first native framed window on Windows.
fs.writeFileSync(entry,measuredCode);const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const log=fs.openSync(path.join(out,'host.log'),'a');const child=spawn(electron,[entry],{windowsHide:false,env,stdio:['ignore',log,log]});fs.closeSync(log);fs.writeFileSync(path.join(out,'identity.json'),JSON.stringify({pid:child.pid,electron,entry,role:'two read-only measured native window controls; inputs only supported sky API',modelCalls:0},null,2));console.log(JSON.stringify({out,pid:child.pid}));child.on('exit',code=>console.log(JSON.stringify({exit:code})));
