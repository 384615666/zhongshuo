#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
/** Hidden formal UI + real daemon + fresh SQLite. Does not build product code.
 * node scripts/verify-r129-room-navigation.cjs --baseline-v68
 * node scripts/verify-r129-room-navigation.cjs [--main <main.cjs>] [--daemon <daemon.cjs>] [--label <label>]
 * A failed baseline exits 1; observed defects never become expected passes.
 */
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const args=process.argv.slice(2);
const arg=name=>{const i=args.indexOf(name);if(i<0)return null;if(!args[i+1]||args[i+1].startsWith('--'))throw Error('Missing '+name);return args[i+1];};
const baseline=args.includes('--baseline-v68');
const packaged=path.join(root,'dist/desktop/desktop-daily-win-v68-r128-task-actions-20261030/ZhongshuoDual/resources/app');
const mainEntry=path.resolve(arg('--main')??(baseline?path.join(packaged,'dist/ui/main.cjs'):path.join(root,'dist/ui/main.cjs')));
const daemon=path.resolve(arg('--daemon')??(baseline?path.join(packaged,'daemon/daemon.cjs'):path.join(root,'dist/pack/daemon.cjs')));
const label=(arg('--label')??(baseline?'v68-baseline':'source-build')).replace(/[^a-zA-Z0-9_-]/g,'_');
const run=path.join(root,'dist/r129-room-navigation',label+'-'+randomUUID());
const data=path.join(run,'data');
const summaryPath=path.join(run,'summary.json');
fs.mkdirSync(run,{recursive:true});
const env={...process.env};
for(const key of Object.keys(env))if(key.startsWith('ZS_'))delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env,{ZS_APP_DATA:data,ZS_RUNTIME:'fake',ZS_ALLOW_FAKE:'1',ZS_REAL_DISPATCH_GUARD:'1',ZS_APP_MODE:'fake-sim',
  ZS_PIPE_NAME:'\\\\.\\pipe\\zs-r129-nav-'+randomUUID(),ZS_DAEMON_ENTRY:daemon,ZS_PACKAGED_UI:'1',ZS_NODE_BIN:process.execPath,
  ZS_COMMAND_LOG_FILE:path.join(run,'real-command-envelopes.jsonl')});

function electronProof(config){
  const {app,BrowserWindow,ipcMain}=require('electron');
  const fs=require('node:fs');
  const path=require('node:path');
  const {spawnSync}=require('node:child_process');
  const meta=JSON.parse(fs.readFileSync(path.join(config.data,'fixture.json'),'utf8'));
  const [A,B,C]=meta.projects;
  const result={ok:false,...config,startedAt:new Date().toISOString(),checks:[],cases:[],screenshots:[],bridgeCalls:[],daemonPid:null};
  const save=()=>fs.writeFileSync(config.summaryPath,JSON.stringify(result,null,2));
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(name,pass,evidence)=>{result.checks.push({name,pass:!!pass,...(evidence===undefined?{}:{evidence})});return !!pass;};
  // Test-only proxy preserves the real product handler, sender checks, actual
  // pipe command and daemon result. Only delivery timing/read failure changes.
  let policy={};
  const originalHandle=ipcMain.handle.bind(ipcMain);
  ipcMain.handle=(channel,handler)=>originalHandle(channel,channel!=='zs:command'?handler:async(event,envelope)=>{
    const rule=policy[envelope.params?.projectId]??policy.all;
    const applicable=rule&&(rule.methods??['room.list','member.list','conversation.list']).includes(envelope.method);
    const call={method:envelope.method,projectId:envelope.params?.projectId,commandId:envelope.commandId,at:Date.now(),delayMs:applicable?(rule.ms??0):0,fault:!!(applicable&&rule.fail)};
    result.bridgeCalls.push(call);
    const actual=await handler(event,envelope); // Must execute even for injected faults.
    call.realCompletedAt=Date.now();call.realOk=actual?.ok;
    if(applicable&&rule.ms)await delay(rule.ms);
    call.deliveredAt=Date.now();
    if(call.fault)return {ok:false,error:{code:'R129_TEST_READ_FAILURE',message:'R129 测试受控读取失败；真实命令已执行'}};
    return actual;
  });
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor','1');
  const closeWatch=setInterval(()=>{if(fs.existsSync(path.join(config.run,'close-request')))for(const w of BrowserWindow.getAllWindows())w.close();},250);
  const watchdog=setTimeout(()=>{result.error='R129 proof exceeded 180 seconds';save();for(const w of BrowserWindow.getAllWindows())w.close();},180000);
  app.once('will-quit',()=>{clearInterval(closeWatch);clearTimeout(watchdog);});
  let handled=false;
  app.on('browser-window-created',(_event,win)=>{
    win.show=()=>{};
    win.webContents.once('did-finish-load',async()=>{
      if(handled)return;handled=true;
      const js=code=>win.webContents.executeJavaScript(code,true);
      const until=async(label,predicate,timeout=12000)=>{
        const start=Date.now();let last;
        while(Date.now()-start<timeout){last=await predicate();if(last)return last;await delay(25);}
        throw Error('Timeout '+label+'; last='+JSON.stringify(last));
      };
      const shot=async name=>{
        const file=path.join(config.run,name+'.png');
        fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());result.screenshots.push(file);
      };
      const snapshot=()=>{
        const child=spawnSync(config.node,[config.seed,'snapshot',config.data],{cwd:config.root,env:process.env,encoding:'utf8',windowsHide:true,timeout:12000});
        if(child.status!==0)throw Error('SQLite snapshot: '+child.stderr);return JSON.parse(child.stdout);
      };
      const state=()=>js('window.__r129.read()');
      const clickRoom=(p,index)=>js(`(()=>{const e=Array.from(document.querySelectorAll('.side-item.sub')).find(e=>e.querySelector('.side-item-label')?.textContent===${JSON.stringify(p.rooms[index].name)});if(!e)throw Error('Missing room ${p.rooms[index].name}');const t=performance.now();window.__r129.lastClick={t,hash:${JSON.stringify('#/project/'+p.id+'/room/'+p.rooms[index].id)}};e.click();return {at:t,hash:location.hash};})()`);
      const roomHash=(p,index)=>'#/project/'+p.id+'/room/'+p.rooms[index].id;
      const titleClick=async p=>{
        await js(`(()=>{const b=document.querySelector('[data-zs-project-menu-btn]');if(!b)throw Error('Missing formal TitleBar');b.click();})()`);
        await until('project menu',()=>js(`!!document.querySelector('.menu-project-name')`));
        return js(`(()=>{const e=Array.from(document.querySelectorAll('.menu-project-name')).find(e=>e.title===${JSON.stringify(p.rootPath)});if(!e)throw Error('Missing project menu item');e.click();return {at:performance.now(),hash:location.hash};})()`);
      };
      const landed=async(p,index)=>{
        const expected=roomHash(p,index);
        await until('room '+p.rooms[index].name,async()=>{const s=await state();return s.hash===expected&&s.active===p.name&&s.editor!==null;});
      };
      const settleCheck=async(name,p,index)=>{
        const s=await state();
        check(name+' route and active match latest click',s.active===p.name&&(index==null?s.hash.startsWith('#/project/'+p.id):s.hash===roomHash(p,index)),s);
      };
      const ensureRoom=async(p,index=0)=>{
        policy={};await titleClick(p);
        await until('project focus '+p.name,async()=>{const s=await state();return s.active===p.name&&s.projects.find(x=>x.name===p.name)?.rooms.length===2;});
        await delay(250);await clickRoom(p,index);await landed(p,index);await delay(150);
      };
      const phase=async(name,fn)=>{
        console.log('R129_NAV_CASE '+name);const first=result.checks.length;
        await js(`window.__r129.phase=${JSON.stringify(name)}`);
        try{await fn();}catch(error){check(name+' completes',false,{error:error.stack??String(error),state:await state()});}
        const samples=await js(`window.__r129.samples.filter(s=>s.phase===${JSON.stringify(name)})`);
        const violations=samples.filter(s=>s.missing.length||s.empty.length);
        check(name+' keeps all six loaded sidebar rooms',violations.length===0,{samples:samples.length,violations:violations.length,first:violations[0]});
        result.cases.push({name,pass:result.checks.slice(first).every(c=>c.pass),samples:samples.length,violations:violations.length});
        await shot(name);save();
      };
      try{
        win.setSize(1360,940);
        await until('formal App and real daemon',()=>js(`!!window.zs?.command&&document.querySelectorAll('.side-item.sub').length===6`),30000);
        result.daemonPid=Number(fs.readFileSync(path.join(config.data,'daemon.pid'),'utf8'));
        check('independent real daemon',result.daemonPid>0&&result.daemonPid!==process.pid);
        result.identity=await js(`window.zs.command({protocolVersion:1,commandId:crypto.randomUUID(),method:'app.identity',params:{}})`);
        check('real daemon identity uses isolated data root',result.identity.ok&&path.resolve(result.identity.data.appDataDir)===path.resolve(config.data),result.identity);
        await js(`(()=>{const d=document.querySelector('[role="dialog"]');Array.from(d?.querySelectorAll('button')??[]).find(e=>e.textContent.trim()==='关闭')?.click();})()`);
        result.before=snapshot();
        await js(`(${installRecorder.toString()})(${JSON.stringify(meta.projects)})`);
        // Let the formal startup restore/redirect finish before user clicks.
        // Sidebar indexes can become ready before the initial room projection.
        await until('startup room route and editor stable',async()=>{
          const s=await state();return s.active===A.name&&s.hash.includes('/room/')&&s.editor!==null;
        },15000);
        await delay(600);
        await clickRoom(A,0);await landed(A,0);await delay(150);
        await js(`window.__r129.enabled=true;window.__r129.phase='ready'`);
        await shot('ready-six-rooms');
        const draft='R129 草稿保留：仅输入，绝不发送。';
        await js(`(()=>{const e=document.querySelector('.composer-editor');e.focus();e.textContent=${JSON.stringify(draft)};e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(draft)}}));})()`);
        await phase('01-same-project-and-draft',async()=>{
          await clickRoom(A,1);await landed(A,1);await clickRoom(A,0);await landed(A,0);
          check('room draft survives same project navigation',(await state()).editor===draft);
        });
        await phase('02-cross-project-normal',async()=>{
          for(const p of [B,C,A]){await clickRoom(p,0);await landed(p,0);await delay(200);await settleCheck('normal '+p.name,p,0);}
          check('room draft survives cross project navigation',(await state()).editor===draft);
        });
        await phase('03-members-project-switch-return',async()=>{
          await js(`(()=>{const e=Array.from(document.querySelectorAll('button.side-item')).find(e=>e.querySelector('.side-item-label')?.textContent==='成员管理');if(!e)throw Error('Missing members navigation');e.click();})()`);
          await until('members page',()=>js(`!!document.querySelector('[aria-label="成员所属项目"]')`));
          for(const p of [B,C]){
            // Route changes remount the page. Reacquire its actual combobox;
            // the listbox carries the same accessible label while open.
            await until('members project option '+p.name,()=>js(`(()=>{
              const option=document.querySelector('[data-zs-option="${p.id}"]');
              if(option){option.click();return true;}
              const button=document.querySelector('button[role="combobox"][aria-label="成员所属项目"]');
              if(button?.getAttribute('aria-expanded')==='false')button.click();
              return false;
            })()`));
            await until('members focus',async()=>{const s=await state();return s.active===p.name&&s.hash==='#/project/'+p.id+'/members';});await delay(300);
          }
          await clickRoom(C,1);await landed(C,1);await settleCheck('members return',C,1);
          await clickRoom(A,0);await landed(A,0);check('draft survives members project switches',(await state()).editor===draft);
        });
        for(const ms of [250,1000])await phase('04-same-project-'+ms+'ms',async()=>{
          await ensureRoom(A,0);
          policy={all:{ms}};
          const at=result.bridgeCalls.length;
          const clicked=await clickRoom(A,1);
          await until('same loaded room delayed reads',()=>js(`location.hash===${JSON.stringify(roomHash(A,1))}`));
          const timing=await js(`(()=>{const t=window.__r129.transitions.find(t=>t.t>=${clicked.at}&&t.hash===${JSON.stringify(roomHash(A,1))});return t?{latencyMs:t.t-${clicked.at}}:null;})()`);
          check('loaded same-project '+ms+'ms route is immediate',timing&&timing.latencyMs<150,timing);
          await delay(ms+180);
          const blockingLists=result.bridgeCalls.slice(at).filter(c=>c.method==='room.list'&&c.projectId===A.id);
          check('loaded same-project '+ms+'ms avoids room.list',blockingLists.length===0,blockingLists);
          await settleCheck('same delayed '+ms,A,1);
          await clickRoom(A,0);await landed(A,0);check('delayed '+ms+'ms preserves draft',(await state()).editor===draft);policy={};
        });
        await phase('05-titlebar-normal',async()=>{
          for(const p of [C,B,A]){await titleClick(p);await delay(700);await settleCheck('titlebar '+p.name,p);}
        });
        await phase('06-titlebar-late-first-latest-wins',async()=>{
          await ensureRoom(A,0);policy={[C.id]:{ms:1000},[B.id]:{ms:50}};
          await titleClick(C);await delay(60);await titleClick(B);await delay(2600);
          await settleCheck('latest titlebar B after late C',B);
          policy={};
        });
        await phase('07-rapid-room-latest-wins',async()=>{
          await ensureRoom(B,0);policy={[C.id]:{ms:1000},[A.id]:{ms:50}};
          await clickRoom(C,0);await delay(40);await clickRoom(A,1);await delay(2800);
          await settleCheck('latest room A2 after late C1',A,1);policy={};
        });
        await phase('08-read-fault-retains-cache',async()=>{
          await ensureRoom(A,0);policy={[B.id]:{ms:250,methods:['room.list'],fail:true}};
          const first=result.bridgeCalls.length;
          await clickRoom(B,1);await delay(700);
          check('injected fault followed real successful daemon read',result.bridgeCalls.slice(first).some(c=>c.fault&&c.realOk&&c.deliveredAt));
          await settleCheck('failed B navigation retains A',A,0);
          check('read failure retains draft',(await state()).editor===draft);policy={};
        });
        await phase('09-late-fault-cannot-erase-cache',async()=>{
          await ensureRoom(A,0);policy={[C.id]:{ms:1000,methods:['room.list'],fail:true},[B.id]:{ms:50}};
          const first=result.bridgeCalls.length;
          await clickRoom(C,0);await delay(40);await clickRoom(B,1);await delay(2400);
          await settleCheck('latest B2 after late C fault',B,1);
          check('late fault delivered after actual daemon execution',result.bridgeCalls.slice(first).some(c=>c.projectId===C.id&&c.fault&&c.realOk&&c.deliveredAt));policy={};
        });
        await phase('11-slow-members-titlebar-latest-wins',async()=>{
          await ensureRoom(A,0);
          policy={[C.id]:{ms:1000,methods:['member.list']},[B.id]:{ms:50,methods:['member.list']}};
          const first=result.bridgeCalls.length;
          await titleClick(C);await delay(80);await titleClick(B);await delay(2400);
          await settleCheck('latest titlebar B with C member reads still pending',B);
          check('slow real C member projection exercised',result.bridgeCalls.slice(first).some(c=>c.projectId===C.id&&c.method==='member.list'&&c.delayMs===1000&&c.realOk));policy={};
        });
        await phase('12-slow-members-room-latest-wins',async()=>{
          await ensureRoom(A,0);
          policy={[C.id]:{ms:1000,methods:['member.list']},[B.id]:{ms:50,methods:['member.list']}};
          const first=result.bridgeCalls.length;
          await clickRoom(C,0);
          await until('C focus committed before slow roster finishes',async()=>{const s=await state();return s.active===C.name;});
          await clickRoom(B,1);await delay(2500);
          await settleCheck('latest B2 while C room member projection pending',B,1);
          check('slow real C room member projection exercised',result.bridgeCalls.slice(first).some(c=>c.projectId===C.id&&c.method==='member.list'&&c.delayMs===1000&&c.realOk));policy={};
        });
        await phase('13-overlapping-refresh-late-fault',async()=>{
          await ensureRoom(C,0);
          // ProjectHome mounts perform actual refreshRooms. The members page
          // refresh button only refreshes members, despite its broader tooltip.
          const home=async()=>{
            await js(`document.querySelector('[data-zs-project-menu-btn]').click()`);
            await until('project home menu item',()=>js(`!!Array.from(document.querySelectorAll('.menu-item')).find(e=>e.textContent.includes('项目主页'))`));
            await js(`Array.from(document.querySelectorAll('.menu-item')).find(e=>e.textContent.includes('项目主页')).click()`);
            await until('project home route',()=>js(`location.hash===${JSON.stringify('#/project/'+C.id)}`));
          };
          policy={[C.id]:{ms:1000,methods:['room.list'],fail:true}};
          const first=result.bridgeCalls.length;
          await home();
          await until('first real refresh waiting',()=>result.bridgeCalls.slice(first).some(c=>c.method==='room.list'&&c.realOk&&c.fault));
          await js(`Array.from(document.querySelectorAll('button.side-item')).find(e=>e.querySelector('.side-item-label')?.textContent==='成员管理').click()`);
          await until('members route for remount',()=>js(`!!document.querySelector('[data-zs-members]')`));
          policy={[C.id]:{ms:50,methods:['room.list']}};
          await home();
          await delay(1500);
          check('new successful room index arrives before old fault',(()=>{
            const calls=result.bridgeCalls.slice(first).filter(c=>c.method==='room.list'&&c.projectId===C.id);
            const old=calls.find(c=>c.fault),newer=calls.find(c=>!c.fault&&c.realOk&&c.deliveredAt);
            return !!(old?.deliveredAt&&newer&&newer.deliveredAt<old.deliveredAt);
          })(),result.bridgeCalls.slice(first).filter(c=>c.method==='room.list'));
          await settleCheck('project C remains after stale failed refresh',C);policy={};
        });
        await phase('10-final-draft-and-durable-data',async()=>{
          await ensureRoom(A,0);check('final original room draft retained',(await state()).editor===draft);
          const after=snapshot();result.after=after;
          check('all original database rooms remain byte-for-byte',JSON.stringify(after.projects)===JSON.stringify(result.before.projects));
          check('no messages tasks runs turns or real model calls',after.realCalls===0&&after.tasks===0&&after.runs===0&&after.turns===0&&after.messages===result.before.messages,after);
          check('no model execution or send command',!result.bridgeCalls.some(c=>/^(message.submit|task.dispatch|task.redispatch|runtime.probe|runtime.modelProbe)$/.test(c.method)));
          const nav=after.navigation.find(n=>n.client_id==='desktop-hifi');
          check('durable navigation agrees with latest project',nav?.active_project_id===A.id,nav);
        });
        const recording=await js(`(()=>{const r=window.__r129;r.enabled=false;clearInterval(r.timer);r.observer.disconnect();return {samples:r.samples,transitions:r.transitions};})()`);
        fs.writeFileSync(path.join(config.run,'sidebar-samples.json'),JSON.stringify(recording,null,2));
        result.sampling={file:path.join(config.run,'sidebar-samples.json'),samples:recording.samples.length,violations:recording.samples.filter(s=>s.missing.length||s.empty.length).length,intervalMs:10,mutationObserver:true};
        check('continuous sidebar sampling never loses any loaded project rooms',result.sampling.violations===0,result.sampling);
        result.ok=result.checks.every(c=>c.pass);
      }catch(error){
        result.error=error.stack??String(error);
        try{result.failureDom=await js('document.body.innerText');await shot('fatal');result.failureDb=snapshot();}catch(e){result.captureError=String(e);}
      }finally{
        policy={};result.finishedAt=new Date().toISOString();save();clearTimeout(watchdog);win.close();
      }
    });
  });
  require(config.main);
}

function installRecorder(projects){
  const r={phase:'startup',enabled:false,samples:[],transitions:[],lastHash:null};
  r.read=()=>{
    const rows=Array.from(document.querySelectorAll('.side-project'));
    const active=rows.find(e=>e.querySelector('.side-row.context-active'))?.querySelector('.side-item-label-btn .side-item-label')?.textContent??null;
    const observed=projects.map(p=>{
      const row=rows.find(e=>e.querySelector('.side-item-label-btn .side-item-label')?.textContent===p.name);
      return {name:p.name,rooms:Array.from(row?.querySelectorAll('.side-item.sub .side-item-label')??[]).map(e=>e.textContent),empty:!!row?.innerText.includes('暂无房间'),expanded:row?.querySelector('.side-caret')?.getAttribute('aria-expanded')};
    });
    return {t:performance.now(),phase:r.phase,hash:location.hash,active,title:document.querySelector('[data-zs-project-menu-btn]')?.textContent,editor:document.querySelector('.composer-editor')?.textContent??null,projects:observed,
      empty:observed.filter(p=>p.empty).map(p=>p.name),missing:observed.flatMap((p,i)=>projects[i].rooms.filter(room=>!p.rooms.includes(room.name)).map(room=>({project:p.name,room:room.name})))};
  };
  const sample=()=>{
    const s=r.read();
    if(s.hash!==r.lastHash){r.transitions.push({t:s.t,hash:s.hash,active:s.active,phase:r.phase});r.lastHash=s.hash;}
    if(r.enabled)r.samples.push(s);
  };
  r.timer=setInterval(sample,10);r.observer=new MutationObserver(sample);r.observer.observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});
  window.addEventListener('hashchange',sample);window.__r129=r;sample();return true;
}

async function main(){
  for(const file of [mainEntry,daemon])if(!fs.existsSync(file))throw Error('Existing build required; missing '+file);
  const seed=path.join(run,'seed.cjs');
  await require('esbuild').build({entryPoints:[path.join(root,'scripts/lib/r129-room-navigation-fixture.ts')],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:seed,logLevel:'silent'});
  const seeded=spawnSync(process.execPath,[seed,'seed',data,path.join(run,'projects')],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:45000});
  fs.writeFileSync(path.join(run,'seed.log'),(seeded.stdout??'')+'\n'+(seeded.stderr??''));
  if(seeded.status!==0)throw Error('Synthetic seed failed: '+seeded.stderr);
  const entryFiles=[mainEntry,daemon,path.join(path.dirname(mainEntry),'renderer/hifi/app.mjs'),path.join(path.dirname(mainEntry),'renderer/hifi/app.css')];
  const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const config={root,run,data,seed,node:process.execPath,main:mainEntry,daemon,summaryPath,label,baseline,environment:Object.fromEntries(Object.entries(env).filter(([k])=>k.startsWith('ZS_'))),entryHashes:Object.fromEntries(entryFiles.map(file=>[file,hash(file)]))};
  const wrapper=path.join(run,'electron-main.cjs');
  fs.writeFileSync(wrapper,`const installRecorder=${installRecorder.toString()};\n(${electronProof.toString()})(${JSON.stringify(config)});`);
  const log=fs.openSync(path.join(run,'electron.log'),'w');
  const child=spawn(require('electron'),[wrapper],{cwd:root,env,windowsHide:true,stdio:['ignore',log,log]});
  let timedOut=false,observedDaemonPid=null;
  const remember=()=>{try{observedDaemonPid=Number(fs.readFileSync(path.join(data,'daemon.pid'),'utf8'));}catch{/* Not running. */}};
  const watcher=setInterval(remember,200);
  const close=()=>{timedOut=true;fs.writeFileSync(path.join(run,'close-request'),'close');};
  process.once('SIGINT',close);process.once('SIGTERM',close);
  const deadline=setTimeout(close,190000);
  const killer=setTimeout(()=>{timedOut=true;remember();if(child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});},205000);
  let code;
  try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}
  finally{clearTimeout(deadline);clearTimeout(killer);clearInterval(watcher);process.removeListener('SIGINT',close);process.removeListener('SIGTERM',close);fs.closeSync(log);}
  const result=fs.existsSync(summaryPath)?JSON.parse(fs.readFileSync(summaryPath,'utf8')):{ok:false,error:'No Electron summary'};
  result.daemonPid??=observedDaemonPid;
  const shutdown=path.join(data,'desktop-shutdown.json');
  result.cleanup={electronExitCode:code,timedOut,pidFileRemoved:!fs.existsSync(path.join(data,'daemon.pid')),shutdown:fs.existsSync(shutdown)?JSON.parse(fs.readFileSync(shutdown,'utf8')):null};
  if(result.daemonPid){try{process.kill(result.daemonPid,0);result.cleanup.daemonAlive=true;}catch{result.cleanup.daemonAlive=false;}}
  if(result.cleanup.daemonAlive){spawnSync('taskkill',['/PID',String(result.daemonPid),'/T','/F'],{windowsHide:true,timeout:10000});result.cleanup.forcedDaemonCleanup=true;}
  result.entryHashesUnchanged=Object.entries(config.entryHashes).every(([file,digest])=>hash(file)===digest);
  result.ok=!!result.ok&&code===0&&!timedOut&&result.cleanup.pidFileRemoved&&result.cleanup.daemonAlive===false&&result.cleanup.shutdown?.daemonStopResult?.complete===true&&result.entryHashesUnchanged;
  fs.writeFileSync(summaryPath,JSON.stringify(result,null,2));
  console.log(JSON.stringify({ok:result.ok,run,summary:summaryPath,checks:result.checks?.length,failed:result.checks?.filter(c=>!c.pass).map(c=>c.name),sampling:result.sampling,cleanup:result.cleanup,error:result.error},null,2));
  if(!result.ok)process.exitCode=1;
}
main().catch(error=>{fs.writeFileSync(summaryPath,JSON.stringify({ok:false,error:error.stack,run},null,2));console.error(error);process.exitCode=1;});
