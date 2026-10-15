/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,process,WebSocket,fetch,console,Buffer,__dirname */
// Observe the separately native-requested rework; never queues or replays work.
const fs=require('node:fs'),path=require('node:path'),D=require('better-sqlite3'),{randomUUID}=require('node:crypto');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs'),{ownedEvidenceRoot}=require('./lib/r86-native-evidence.cjs');
const own=path.resolve(process.argv[2]??'');if(!ownedEvidenceRoot(own,path.resolve(__dirname,'../dist')))throw Error('owned root required');
const file=path.join(own,'rework-running-window.json');if(fs.existsSync(file))throw Error('original observation retained');
const p=JSON.parse(fs.readFileSync(path.join(own,'progress.json'))),life=JSON.parse(fs.readFileSync(path.join(own,'code-lifecycle.json'))),d=new D(path.join(p.dataRoot,'state.sqlite'),{readonly:true});
let c;const r={pass:false,build:p.build,taskId:life.taskId,sourceDeliveryId:life.v1.id,scope:'native delivery panel during consumed AUTO planning intent and unfinished genuine child tasks; formal readonly task.get'};
(async()=>{try{
 const task=d.prepare('SELECT project_id,conversation_thread_id FROM tasks WHERE id=?').get(life.taskId);if(task?.project_id!==p.ids.projectId)throw Error('wrong project');
 const page=(await fetch(`http://127.0.0.1:${p.port}/json/list`).then(x=>x.json())).find(x=>x.type==='page'&&x.url.includes('index.html'));const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(a=>ws.addEventListener('open',a,{once:true}));c=new Cdp(ws);
 await until(async()=>{
  const plan=d.prepare('SELECT c.run_id,c.state,w.status FROM coordination_runs c JOIN workflow_runs w ON w.id=c.run_id WHERE c.task_id=? ORDER BY c.rowid DESC LIMIT 1').get(life.taskId);
  if(plan?.state!=='running'||plan.status!=='WAITING')return false;
  const intent=d.prepare('SELECT status FROM outbox WHERE dispatch_key=? ORDER BY id DESC LIMIT 1').get(life.reworkRequest.dispatchKey);if(intent?.status!=='done')return false;
  const steps=d.prepare('SELECT s.child_task_id,t.status FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id WHERE s.run_id=?').all(plan.run_id);if(!steps.some(s=>s.status!=='DONE'))return false;
  const view=await c.eval('({hash:location.hash,text:document.querySelector(".thread-details")?.innerText??"",buttons:[...document.querySelectorAll(".thread-details button")].map(b=>b.textContent.trim())})');
  if(!view.hash.includes(task.conversation_thread_id)||!view.text.includes('返工执行中'))return false;
  const receipt=await c.eval(`window.zs.command(${JSON.stringify({protocolVersion:1,commandId:randomUUID(),method:'task.get',params:{taskId:life.taskId}})})`);
  if(!receipt.ok)throw Error('formal task.get failed');const fact=receipt.data.reworkPending;
  r.formalQueued=fact?.queued===true&&fact.deliveryId===life.v1.id;r.outboxConsumed=true;r.unfinishedSteps=steps.some(s=>s.status!=='DONE');r.matchingTarget=true;r.view=view;r.coordinationRunId=plan.run_id;r.steps=steps;
  r.pass=r.formalQueued&&r.outboxConsumed&&r.unfinishedSteps&&!view.text.includes('返工意见已记录、尚未执行')&&!view.buttons.includes('执行返工');
  if(!r.pass)throw Error('actual in-flight rework still presented as unexecuted');
  const png=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(own,'rework-running-window.png'),Buffer.from(png.data,'base64'));return true;
 },Boolean,'consumed planning intent while visible rework remains running',900000);
 }catch(e){r.pass=false;r.error=e.stack;process.exitCode=1;}finally{c?.ws.close();d.close();fs.writeFileSync(file,JSON.stringify(r,null,2));console.log(JSON.stringify({pass:r.pass,error:r.error}));}})();
