#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** Real built UI + real daemon + synthetic SQLite; never builds or calls a real model. */
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID,createHash} = require('node:crypto');
const {spawn,spawnSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const run = path.join(root,'dist/r128-feedback','task-ui-proof-'+randomUUID());
const data = path.join(run,'data');
const summaryPath = path.join(run,'summary.json');
fs.mkdirSync(run,{recursive:true});
const env = {...process.env};
for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env,{ZS_APP_DATA:data,ZS_RUNTIME:'fake',ZS_ALLOW_FAKE:'1',ZS_REAL_DISPATCH_GUARD:'1',ZS_APP_MODE:'fake-sim',
  ZS_PIPE_NAME:'\\\\.\\pipe\\zs-r128-task-ui-'+randomUUID(),ZS_DAEMON_ENTRY:path.join(root,'dist/pack/daemon.cjs'),
  ZS_PACKAGED_UI:'1',ZS_NODE_BIN:process.execPath});

// This function is serialized into an Electron main wrapper. Product bridge and
// stores stay intact; only navigation, DOM clicks and read-only observations run.
function electronProof(config){
  const {app,BrowserWindow}=require('electron');
  const fs=require('node:fs');
  const path=require('node:path');
  const assert=require('node:assert/strict');
  const {spawnSync}=require('node:child_process');
  const meta=JSON.parse(fs.readFileSync(path.join(config.data,'fixture.json'),'utf8'));
  const baseline=JSON.parse(fs.readFileSync(path.join(config.data,'baseline.json'),'utf8'));
  const result={ok:false,startedAt:new Date().toISOString(),...config,daemonPid:null,checks:[],screenshots:[],cases:[]};
  const save=()=>fs.writeFileSync(config.summaryPath,JSON.stringify(result,null,2));
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let handled=false;
  const closeRequested=setInterval(()=>{
    if(fs.existsSync(path.join(config.run,'close-request'))){for(const win of BrowserWindow.getAllWindows())win.close();}
  },250);
  app.once('will-quit',()=>clearInterval(closeRequested));
  const check=(name,value)=>{assert.ok(value,name);result.checks.push(name);};
  const snapshot=()=>{
    const child=spawnSync(config.node,[config.seed,'snapshot',config.data],{cwd:config.root,env:process.env,encoding:'utf8',windowsHide:true,timeout:12000});
    if(child.status!==0)throw Error('Snapshot failed: '+child.stderr);return JSON.parse(child.stdout);
  };
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor','1');
  const watchdog=setTimeout(()=>{
    result.error='Electron proof exceeded 180 seconds';save();
    for(const win of BrowserWindow.getAllWindows())win.close();
  },180000);
  app.on('browser-window-created',(_event,win)=>{
    win.show=()=>{};
    win.webContents.once('did-finish-load',async()=>{
      if(handled)return;handled=true;
      const js=code=>win.webContents.executeJavaScript(code,true);
      const until=async(label,predicate,timeout=30000)=>{
        const start=Date.now();let last;
        while(Date.now()-start<timeout){last=await predicate();if(last)return last;await delay(125);}
        throw Error('Timeout: '+label+'; last='+JSON.stringify(last));
      };
      const shot=async name=>{
        win.setSize(1361,920);await delay(60);win.setSize(1360,920);await delay(180);
        const file=path.join(config.run,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());result.screenshots.push(file);
      };
      const ui=async item=>js(`(()=>{
        const row=Array.from(document.querySelectorAll('.side-item.sub')).find(el=>el.querySelector('.side-item-label')?.textContent===${JSON.stringify(item.name)});
        const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
        const action=kind=>Array.from(document.querySelectorAll('[data-zs-execution-action="'+kind+'"]')).filter(el=>el.getBoundingClientRect().width>0).map(el=>{
          const button=rect(el),panel=rect(el.closest('[data-zs-execution-status]'));
          const inside=(a,b)=>a.left>=b.left-0.5&&a.top>=b.top-0.5&&a.right<=b.right+0.5&&a.bottom<=b.bottom+0.5;
          const hit=document.elementFromPoint((button.left+button.right)/2,(button.top+button.bottom)/2);
          return {text:el.textContent.trim(),disabled:el.disabled,button,panel,density:el.closest('[data-zs-execution-status]').dataset.zsExecutionDensity,
            insidePanel:inside(button,panel),insideViewport:inside(button,{left:0,top:0,right:innerWidth,bottom:innerHeight}),centerClickable:hit===el||el.contains(hit)};
        });
        return {hash:location.hash,text:document.body.innerText,mark:row?.querySelector('[data-zs-nav-task-state]')?.getAttribute('data-zs-nav-task-state')??null,rowFound:!!row,close:action('close'),retry:action('retry'),phases:Array.from(document.querySelectorAll('[data-zs-execution-phase]')).map(el=>el.getAttribute('data-zs-execution-phase'))};
      })()`);
      try{
        win.setSize(1360,920);
        await until('formal app and daemon readiness',async()=>await js(`!!window.zs?.command && !!document.querySelector('.side-item.sub')`));
        result.daemonPid=Number(fs.readFileSync(path.join(config.data,'daemon.pid'),'utf8'));
        check('real daemon PID differs from Electron',result.daemonPid>0&&result.daemonPid!==process.pid);
        result.before=snapshot();
        await js(`(()=>{const dialog=document.querySelector('[role="dialog"]');const close=dialog&&Array.from(dialog.querySelectorAll('button')).find(el=>el.textContent.trim()==='关闭');close?.click();})()`);
        for(const item of meta.cases){
          console.log('R128_UI_CASE '+item.status);
          const baseRoute=`/project/${meta.projectId}/room/${item.roomId}`;
          await js(`location.hash=${JSON.stringify(baseRoute)}`);
          await until(item.name+' room pool hydrated',async()=>await js(`!!Array.from(document.querySelectorAll('.root-card')).find(el=>el.innerText.includes(${JSON.stringify('R128 '+item.name)}))`));
          // Project activation can invalidate a simultaneous thread read. Match
          // the manual capture flow: load the room before opening its thread.
          await delay(350);
          const route=baseRoute+`?thread=${item.threadId}`;
          await js(`location.hash=${JSON.stringify(route)}`);
          const kind=item.status==='NO_RUN'?'close':'retry';
          await until(item.name+' actionable compact status',async()=>{
            const state=await ui(item);return state.rowFound&&state.mark==='BLOCKED'&&state[kind].some(b=>!b.disabled);
          });
          const before=await ui(item);
          check(item.status+' visible action label',before[kind].some(b=>b.text===(kind==='close'?'结束任务':'继续任务')));
          for(const actionKind of ['close','retry'])for(const button of before[actionKind]){
            check(item.status+' '+actionKind+' compact button fully inside panel/viewport and clickable',button.density==='compact'&&button.insidePanel&&button.insideViewport&&button.centerClickable);
            check(item.status+' '+actionKind+' narrow panel at most 446px',button.panel.width<=446.5);
          }
          await shot(item.status.toLowerCase()+'-before');
          const action=await js(`(()=>{
            const button=Array.from(document.querySelectorAll('[data-zs-execution-action="${kind}"]')).find(el=>!el.disabled&&el.getBoundingClientRect().width>0);
            if(!button)throw Error('Visible enabled action missing');
            const proof={text:button.textContent.trim(),action:button.dataset.zsExecutionAction,id:button.dataset.zsActionId,method:'HTMLElement.click',at:Date.now()};
            button.click();return proof;
          })()`);
          const expected=kind==='close'?'CANCELLED':'DONE';
          let afterDb;
          await until(item.status+' durable '+expected,()=>{
            afterDb=snapshot();return afterDb.cases.find(row=>row.taskId===item.taskId).task.status===expected;
          },45000);
          const old=baseline.cases.find(row=>row.taskId===item.taskId);
          const after=afterDb.cases.find(row=>row.taskId===item.taskId);
          assert.deepEqual(after.originalMessage,old.originalMessage,'original request must remain byte-for-byte unchanged');
          for(const row of old.runs)assert.deepEqual(after.runs.find(r=>r.id===row.id),row,'original terminal run must not change');
          for(const row of old.turns)assert.deepEqual(after.turns.find(r=>r.id===row.id),row,'original terminal turn must not change');
          check(item.status+' original message/run/turn history unchanged',true);
          if(kind==='retry'){
            check(item.status+' exactly one new successful run',after.runs.length===old.runs.length+1&&after.runs.at(-1).status==='SUCCEEDED');
            check(item.status+' exactly one new successful turn',after.turns.length===old.turns.length+1&&after.turns.at(-1).status==='SUCCEEDED');
            check(item.status+' formal redispatch event',after.events.some(event=>event.kind==='task.redispatchEnqueued'));
          }else check('close starts no execution',after.runs.length===0&&after.turns.length===0);
          await until(item.status+' UI clears unfinished indicator and actions',async()=>{
            const state=await ui(item);return state.rowFound&&state.mark===null&&state.close.length===0&&state.retry.length===0;
          },30000);
          const afterUi=await ui(item);
          check(item.status+' original request still rendered',afterUi.text.includes('R128 '+item.name));
          check(item.status+' live sidebar unfinished indicator removed',afterUi.rowFound&&afterUi.mark===null);
          await shot(item.status.toLowerCase()+'-after');
          result.cases.push({name:item.name,status:item.status,action,beforeUi:before,afterUi,after});save();
        }
        result.after=snapshot();
        check('all synthetic tasks finished',result.after.unfinishedTasks===0);
        check('zero real business model calls',result.after.realCalls===0);
        result.formalTaskSummary=await js(`window.zs.command({protocolVersion:1,commandId:crypto.randomUUID(),method:'project.taskSummary',params:{projectId:${JSON.stringify(meta.projectId)}}})`);
        check('formal project summary has zero unfinished tasks',result.formalTaskSummary.ok&&result.formalTaskSummary.data.unfinishedTasks===0);
        result.ok=true;
      }catch(error){
        result.error=error.stack??String(error);
        try{
          result.failureDom=await js('document.body.innerText');
          result.failureTaskReads=await js(`Promise.all(${JSON.stringify(meta.cases.map(item=>item.taskId))}.map(taskId=>window.zs.command({protocolVersion:1,commandId:crypto.randomUUID(),method:'task.get',params:{taskId}})))`);
          await shot('failure');result.failureDb=snapshot();
        }catch(captureError){result.captureError=String(captureError);}
        console.error(error);
      }finally{
        result.finishedAt=new Date().toISOString();save();clearTimeout(watchdog);win.close();
      }
    });
  });
  require(config.main);
}

async function main(){
  const mainEntry=path.join(root,'dist/ui/main.cjs');
  for(const file of [mainEntry,env.ZS_DAEMON_ENTRY])if(!fs.existsSync(file))throw Error('Build entry missing: '+file);
  const seed=path.join(run,'seed.cjs');
  await require('esbuild').build({entryPoints:[path.join(root,'scripts/lib/r128-task-actions-fixture.ts')],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:seed,logLevel:'silent'});
  const seeded=spawnSync(process.execPath,[seed,'seed',data,path.join(run,'synthetic-project')],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:45000});
  fs.writeFileSync(path.join(run,'seed.log'),(seeded.stdout??'')+'\n'+(seeded.stderr??''));
  if(seeded.status!==0)throw Error('Seed failed: '+seeded.stderr);
  const config={root,run,data,seed,node:process.execPath,main:mainEntry,summaryPath,
    entryHashes:Object.fromEntries([mainEntry,env.ZS_DAEMON_ENTRY,path.join(root,'dist/ui/renderer/hifi/app.mjs'),path.join(root,'dist/ui/renderer/hifi/app.css')].map(file=>[file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')]))};
  const wrapper=path.join(run,'electron-main.cjs');
  fs.writeFileSync(wrapper,`(${electronProof.toString()})(${JSON.stringify(config)});`);
  const log=fs.openSync(path.join(run,'electron.log'),'w');
  const child=spawn(require('electron'),[wrapper],{cwd:root,env,windowsHide:true,stdio:['ignore',log,log]});
  let timedOut=false;
  let observedDaemonPid=null;
  const rememberDaemon=()=>{try{observedDaemonPid=Number(fs.readFileSync(path.join(data,'daemon.pid'),'utf8'));}catch{/* not yet started or already stopped */}};
  const daemonWatch=setInterval(rememberDaemon,200);
  const requestClose=()=>{fs.writeFileSync(path.join(run,'close-request'),'close');};
  const onSignal=()=>{timedOut=true;requestClose();};
  process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  const gracefulDeadline=setTimeout(()=>{timedOut=true;requestClose();},190000);
  const killer=setTimeout(()=>{timedOut=true;rememberDaemon();if(child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});},205000);
  let code;
  try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}
  finally{clearTimeout(killer);clearTimeout(gracefulDeadline);clearInterval(daemonWatch);process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);fs.closeSync(log);}
  const result=fs.existsSync(summaryPath)?JSON.parse(fs.readFileSync(summaryPath,'utf8')):{ok:false,error:'No Electron summary'};
  result.daemonPid??=observedDaemonPid;
  const shutdown=path.join(data,'desktop-shutdown.json');
  result.cleanup={electronExitCode:code,timedOut,pidFileRemoved:!fs.existsSync(path.join(data,'daemon.pid')),shutdown:fs.existsSync(shutdown)?JSON.parse(fs.readFileSync(shutdown,'utf8')):null};
  if(result.daemonPid){try{process.kill(result.daemonPid,0);result.cleanup.daemonAlive=true;}catch{result.cleanup.daemonAlive=false;}}
  if(result.cleanup.daemonAlive){
    spawnSync('taskkill',['/PID',String(result.daemonPid),'/T','/F'],{windowsHide:true,timeout:10000});
    result.cleanup.forcedDaemonCleanup=true;
  }
  result.entryHashesUnchanged=Object.entries(config.entryHashes).every(([file,hash])=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')===hash);
  result.ok=!!result.ok&&code===0&&!timedOut&&result.cleanup.pidFileRemoved&&result.cleanup.daemonAlive===false
    &&result.cleanup.shutdown?.daemonStopResult?.complete===true&&result.entryHashesUnchanged;
  fs.writeFileSync(summaryPath,JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:result.ok,run,summary:summaryPath,checks:result.checks?.length,cases:result.cases?.length,cleanup:result.cleanup,error:result.error},null,2));
  if(!result.ok)process.exitCode=1;
}
main().catch(error=>{fs.writeFileSync(summaryPath,JSON.stringify({ok:false,error:error.stack,run},null,2));console.error(error);process.exitCode=1;});
