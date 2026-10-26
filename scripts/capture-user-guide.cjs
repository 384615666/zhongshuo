/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** Photograph the real UI using a new synthetic project; never opens user data. */
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',')??[];
const run=path.join(root,'dist/user-guide-capture','run-'+randomUUID().slice(0,8));
const data=path.join(run,'data'),project=path.join(run,'读书会筹备');fs.mkdirSync(run,{recursive:true});
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env,{ZS_APP_DATA:data,ZS_RUNTIME:'fake',ZS_ALLOW_FAKE:'1',ZS_REAL_DISPATCH_GUARD:'1',ZS_PIPE_NAME:'\\\\.\\pipe\\zs-guide-'+randomUUID(),ZS_DAEMON_ENTRY:path.join(root,'dist/pack/daemon.cjs'),ZS_PACKAGED_UI:'1',ZS_NODE_BIN:process.execPath});
const main=String.raw`
const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('browser-window-created',(_event,win)=>{
 win.show=()=>{};
 win.webContents.once('did-finish-load',async()=>{
  const results=[];
  try{
   win.setSize(1360,920);
   await win.webContents.executeJavaScript('window.guideMeta='+fs.readFileSync(path.join(process.env.ZS_APP_DATA,'guide-fixture.json'),'utf8'));
   await win.webContents.executeJavaScript(fs.readFileSync(__SCENES__,'utf8'));
   const count=await win.webContents.executeJavaScript('window.guideScenes.length');
   const names=await win.webContents.executeJavaScript('window.guideScenes.map(scene=>scene.name)');
   for(let i=0;i<count;i++){
    if(__ONLY__.length&&!__ONLY__.includes(names[i]))continue;
    const step=await win.webContents.executeJavaScript('window.guideStep('+i+')');
    // Hidden Chromium windows need a resize to composite newly painted child surfaces.
    win.setSize(1361,920);await new Promise(r=>setTimeout(r,40));win.setSize(1360,920);
    await new Promise(r=>setTimeout(r,150));
    const image=await win.webContents.capturePage(step.rect);
    fs.writeFileSync(path.join(__OUT__,step.name+'.png'),image.toPNG());
    results.push(step);console.log('GUIDE_SHOT '+step.name);
   }
   fs.writeFileSync(path.join(__dirname,'capture-result.json'),JSON.stringify({ok:true,results},null,2));
  }catch(error){console.error(error);await win.webContents.capturePage().then(image=>fs.writeFileSync(path.join(__dirname,'error.png'),image.toPNG()));fs.writeFileSync(path.join(__dirname,'capture-result.json'),JSON.stringify({ok:false,error:String(error),results},null,2));}
  win.close();
 });
});
require(__MAIN__);
setTimeout(()=>{for(const win of require('electron').BrowserWindow.getAllWindows())win.close();},120000);
`;
(async()=>{
 await require('esbuild').build({entryPoints:[path.join(root,'scripts/lib/user-guide-fixture.ts')],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:path.join(run,'seed.cjs'),logLevel:'silent'});
 const seeded=spawnSync(process.execPath,[path.join(run,'seed.cjs'),data,project],{cwd:root,env,encoding:'utf8',windowsHide:true});
 if(seeded.status!==0)throw Error(seeded.stderr||seeded.stdout);
 const output=path.join(root,'docs/user-guide/images');fs.mkdirSync(output,{recursive:true});
 const wrapper=path.join(run,'main.cjs');
 fs.writeFileSync(wrapper,main.replace('__MAIN__',JSON.stringify(path.join(root,'dist/ui/main.cjs'))).replace('__SCENES__',JSON.stringify(path.join(root,'scripts/lib/user-guide-scenes.js'))).replaceAll('__OUT__',JSON.stringify(output)).replaceAll('__ONLY__',JSON.stringify(only)));
 const processResult=spawnSync(require('electron'),[wrapper],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:140000});
 fs.writeFileSync(path.join(run,'process.log'),(processResult.stdout||'')+'\n'+(processResult.stderr||''));
 const resultPath=path.join(run,'capture-result.json');const result=fs.existsSync(resultPath)?JSON.parse(fs.readFileSync(resultPath,'utf8')):{ok:false,error:'No capture result'};
   console.log(JSON.stringify({run,code:processResult.status,...result}));if(!result.ok||processResult.status!==0)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
