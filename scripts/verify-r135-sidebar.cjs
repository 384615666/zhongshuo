/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const out = path.join(root, 'dist/r135-sidebar', baseline ? 'baseline' : 'fixed');

async function run() {
  fs.mkdirSync(out, { recursive: true });
  await require('esbuild').build({ entryPoints: [path.join(root, 'scripts/r135-sidebar-ui.tsx')], bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', outfile: path.join(out, 'ui.mjs'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  fs.writeFileSync(path.join(out, 'app.css'), ['tokens.css', 'base.css', 'components.css', 'preview.css', 'titlebar.css', 'h1-overrides.css'].map(f => {
    if (baseline && f === 'h1-overrides.css') {
      const original = spawnSync('git', ['show', 'HEAD:src/ui/hifi/styles/h1-overrides.css'], { cwd: root, encoding: 'utf8' });
      if (original.status !== 0) throw Error(original.stderr);
      return original.stdout;
    }
    return fs.readFileSync(path.join(root, 'src/ui/hifi/styles', f), 'utf8');
  }).join('\n'));
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><div id="root"></div><script type="module" src="ui.mjs"></script>');
  fs.writeFileSync(path.join(out, 'main.cjs'), `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'isolated-profile'));
const checks=[],samples=[],screenshots=[];
const check=(name,ok,detail)=>checks.push({name,ok:!!ok,...(detail?{detail}:{})});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const js=code=>win.webContents.executeJavaScript(code);
 win.webContents.debugger.attach('1.3');
 const input=(method,params)=>win.webContents.debugger.sendCommand('Input.'+method,params);
 const snap=()=>js('r135.snapshot()');
 const move=async p=>{await input('dispatchMouseEvent',{type:'mouseMoved',...p});await pause(160);};
 const key=async name=>{const vk={Enter:13,Escape:27,Tab:9}[name];const base={key:name,code:name,windowsVirtualKeyCode:vk,nativeVirtualKeyCode:vk};await input('dispatchKeyEvent',{type:'rawKeyDown',...base});if(name==='Enter')await input('dispatchKeyEvent',{type:'char',...base,text:String.fromCharCode(13),unmodifiedText:String.fromCharCode(13)});await input('dispatchKeyEvent',{type:'keyUp',...base});await pause(70);};
 const click=async p=>{await move(p);await input('dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await input('dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await pause(100);};
 const capture=async name=>{win.webContents.invalidate();await pause(180);const s=await snap();const file=name+'.png';fs.writeFileSync(path.join(__dirname,file),(await win.webContents.capturePage({x:0,y:0,width:Math.ceil(s.sidebar.width*win.webContents.getZoomFactor())+12,height:Math.min(950,win.getContentBounds().height)})).toPNG());screenshots.push(file);};
 const stable=(a,b)=>Math.abs(a.x-b.x)<.2&&Math.abs(a.width-b.width)<.2&&Math.abs(a.y-b.y)<.2&&Math.abs(a.height-b.height)<.2;
 const validate=(name,s,base,projectIndex)=>{
   samples.push({name,snapshot:s});
   check(name+'/sidebar-no-overflow',s.projects.every(p=>p.row.right<=s.sidebar.right+.5)&&s.rooms.every(r=>r.row.right<=s.sidebar.right+.5));
   s.projects.forEach((p,i)=>{
     check(name+'/project-'+i+'/name-before-actions',p.label.right<=p.actions.x+.5,{labelRight:p.label.right,actionsLeft:p.actions.x});
     check(name+'/project-'+i+'/stable',stable(p.row,base.projects[i].row)&&stable(p.label,base.projects[i].label));
     check(name+'/project-'+i+'/ellipsis',p.ellipsis==='ellipsis'&&p.overflow==='hidden');
     check(name+'/project-'+i+'/actions-contained',p.buttons.every(b=>b.rect.right<=p.row.right+.5&&b.rect.width>=20));
   });
   check(name+'/short-project-readable',s.projects[2].scrollWidth<=s.projects[2].label.width+1);
   check(name+'/long-project-truncated',s.projects[1].scrollWidth>s.projects[1].label.width+1);
   s.rooms.forEach((r,i)=>{
     check(name+'/room-'+i+'/no-overlap',r.label.right<=r.marks.x+.5&&r.label.width>0);
     check(name+'/room-'+i+'/stable',stable(r.row,base.rooms[i].row)&&stable(r.label,base.rooms[i].label));
     check(name+'/room-'+i+'/ellipsis',r.ellipsis==='ellipsis'&&r.overflow==='hidden');
     check(name+'/room-'+i+'/length',i%2===0?r.scrollWidth>r.label.width+1:r.scrollWidth<=r.label.width+1);
   });
   if(projectIndex!=null)check(name+'/actions-visible-and-hittable',s.projects[projectIndex].buttons.every(b=>b.visible&&b.hit));
 };
 try {
  await win.loadFile(path.join(__dirname,'index.html'));
  for(let n=0;n<150&&!(await js('window.r135?.ready()'));n++)await pause(20);
  check('actual-app-mounted',await js('r135.ready()'));
  for(const config of [{name:'1440-default',width:1440,sidebar:null,zoom:1},{name:'1000-default',width:1000,sidebar:null,zoom:1},{name:'1000-narrow180',width:1000,sidebar:180,zoom:1},{name:'1440-125pct',width:1440,sidebar:null,zoom:1.25}]) {
   win.setContentSize(config.width,1000);win.webContents.setZoomFactor(config.zoom);
   await js('r135.setSidebar('+JSON.stringify(config.sidebar)+')');await move({x:700,y:80});await js('r135.blur()');await pause(100);
   const base=await snap();validate(config.name+'/idle',base,base);
   check(config.name+'/state-and-unread-fixture',base.rooms[0].stateMark&&base.rooms[0].unread);
   await capture(config.name+'-idle');
   for(let i=0;i<3;i++) {
    await move(await js('r135.point('+i+',".side-item-label-btn")'));
    validate(config.name+'/hover-'+i,await snap(),base,i);
    if(i===0)await capture(config.name+'-hover');
    await move({x:700,y:80});await js('r135.focus('+i+')');
    validate(config.name+'/focus-name-'+i,await snap(),base,i);
    await key('Tab');const more=await snap();check(config.name+'/tab-to-more-'+i,more.activeAction===i*2);validate(config.name+'/focus-more-'+i,more,base,i);
    if(i===0)await capture(config.name+'-focus');
    await key('Enter');check(config.name+'/keyboard-menu-'+i,(await snap()).menu);
    await js('r135.blur()');await move({x:700,y:80});
    const menu=await snap();check(config.name+'/menu-keeps-both-actions-'+i,menu.projects[i].buttons.every(b=>b.visible));
    await key('Escape');await js('r135.focus('+i+')');await key('Tab');await key('Tab');
    const plus=await snap();check(config.name+'/tab-to-plus-'+i,plus.activeAction===i*2+1);validate(config.name+'/focus-plus-'+i,plus,base,i);
    await key('Enter');check(config.name+'/keyboard-create-'+i,(await snap()).dialog.includes('新建对话池'));await key('Escape');
    await click(await js('r135.point('+i+',".side-row-act")'));check(config.name+'/mouse-menu-'+i,(await snap()).menu);await key('Escape');
    await click(await js('r135.point('+i+',".side-row-act:last-child")'));check(config.name+'/mouse-create-'+i,(await snap()).dialog.includes('新建对话池'));await key('Escape');await js('r135.blur()');
   }
   for(let i=0;i<2;i++){
    await move(await js('r135.roomPoint('+i+')'));validate(config.name+'/room-hover-'+i,await snap(),base);
    await move({x:700,y:80});await js('r135.roomFocus('+i+')');validate(config.name+'/room-focus-'+i,await snap(),base);
   }
   await capture(config.name+'-room-focus');
  }
  const final=await snap();check('no-unexpected-bridge-commands',final.unexpected.length===0,final.unexpected);
  const report={ok:checks.every(c=>c.ok),syntheticOnly:true,databaseOpened:false,daemonStarted:false,realBusinessCalls:0,checks,samples,screenshots,bridgeCalls:final.calls};
  fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:report.ok,checks:checks.length,failures:checks.filter(c=>!c.ok).length,screenshots:screenshots.length}));app.exit(report.ok?0:1);
 }catch(e){fs.writeFileSync(path.join(__dirname,'error.txt'),String(e.stack));fs.writeFileSync(path.join(__dirname,'failure.png'),(await win.webContents.capturePage()).toPNG());app.exit(2);}
});setTimeout(()=>app.exit(3),90000);
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(out, 'main.cjs')], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 95000 });
  fs.writeFileSync(path.join(out, 'process.json'), JSON.stringify({ status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }, null, 2));
  console.log(result.stdout);
  if (fs.existsSync(path.join(out, 'error.txt'))) console.error(fs.readFileSync(path.join(out, 'error.txt'), 'utf8'));
  console.log('Evidence: ' + out);
  process.exitCode = result.status ?? 4;
}
run().catch(e => { console.error(e); process.exitCode = 2; });
