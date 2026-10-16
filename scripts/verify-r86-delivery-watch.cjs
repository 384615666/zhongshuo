/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,process,WebSocket,fetch,console,Buffer,__dirname */
// Observe an explicitly UI-requested delivery, never dispatch or replay a write.
const fs=require('node:fs'),path=require('node:path'),D=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');const{ownedEvidenceRoot}=require('./lib/r86-native-evidence.cjs');
const out=path.resolve(process.argv[2]??''),label=process.argv.find(x=>x.startsWith('--label='))?.slice(8),taskId=process.argv.find(x=>x.startsWith('--task='))?.slice(7),revision=Number(process.argv.find(x=>x.startsWith('--revision='))?.slice(11)??2);
if(!ownedEvidenceRoot(out,path.resolve(__dirname,'../dist'))||!/^[-a-z0-9]+$/.test(label??'')||!taskId||!Number.isSafeInteger(revision)||revision<1)throw Error('explicit owned target/label/revision required');
const file=path.join(out,`delivery-${label}.json`);if(fs.existsSync(file))throw Error('original observation preserved');const p=JSON.parse(fs.readFileSync(path.join(out,'progress.json'),'utf8')),db=new D(path.join(p.dataRoot,'state.sqlite'),{readonly:true});
const result={pass:false,scope:'read-only observation of explicit UI delivery request',build:p.build,taskId,revision,startedAt:Date.now()};let c;
const save=()=>fs.writeFileSync(file,JSON.stringify(result,null,2));save();
(async()=>{try{
 const task=db.prepare('SELECT project_id,conversation_thread_id FROM tasks WHERE id=?').get(taskId);if(task?.project_id!==p.ids.projectId)throw Error('task outside exact own project');
 const page=(await fetch(`http://127.0.0.1:${p.port}/json/list`).then(r=>r.json())).find(x=>x.type==='page'&&x.url.includes('index.html'));const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));c=new Cdp(ws);
 const delivery=await until(()=>{const plan=db.prepare('SELECT run_id,state,error_message FROM coordination_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId);result.plan=plan;
 result.task=db.prepare('SELECT id,status,current_delivery_id,revision,stop_generation FROM tasks WHERE id=?').get(taskId);result.calls=db.prepare('SELECT id,task_id,turn_id,runtime_kind,model,response_model,status FROM real_calls WHERE task_id=? OR task_id IN(SELECT id FROM tasks WHERE parent_task_id=?) ORDER BY id').all(taskId,taskId);
 result.steps=plan?db.prepare('SELECT s.step_key,s.child_task_id,s.role,s.handoff_json,t.status FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id WHERE s.run_id=?').all(plan.run_id):[];save();
 if(plan?.state==='blocked'||db.prepare("SELECT 1 FROM agent_turns a JOIN workflow_runs w ON w.id=a.run_id WHERE (w.id=? OR w.task_id IN(SELECT child_task_id FROM coordination_steps WHERE run_id=?)) AND a.status='UNKNOWN'").get(plan?.run_id??'',plan?.run_id??''))throw Error('explicit requested execution blocked/UNKNOWN; no replay');
 const delivery=db.prepare('SELECT id,run_id,revision,manifest_hash,review_status,artifact_refs_json,change_set_refs_json FROM task_deliveries WHERE task_id=? AND revision=?').get(taskId,revision);result.run=db.prepare('SELECT id,mode,status,stage FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId);save();if(!delivery&&['FAILED','INTERRUPTED','CANCELLED'].includes(result.run?.status))throw Error('requested run ended without delivery: '+result.run.status+'; no replay');return delivery;
 },Boolean,'explicit requested parent delivery',2700000);result.delivery=delivery;result.pass=true;result.finishedAt=Date.now();
 const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`${label}-delivery.png`),Buffer.from(shot.data,'base64'));
 }catch(e){result.error=e.stack;process.exitCode=1;}finally{save();db.close();c?.ws.close();console.log(JSON.stringify({pass:result.pass,error:result.error}));}})();
