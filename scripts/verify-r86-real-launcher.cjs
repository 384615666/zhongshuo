/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,process,WebSocket,fetch,console,Buffer,__dirname */
/** Real BAT, isolated complete root, formal commands. Never writes model output files.
 * --prepare configures the owned project only, with zero inference.
 * --observe waits for the native UI original send and records the actual collaboration.
 * No automatic replay/retry. Original failures and UNKNOWN remain intact. */
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const Database=require('better-sqlite3'),{Cdp,until}=require('./verify-r81-members-launcher.cjs');
const candidate=path.resolve(process.argv[2]??''),out=path.resolve(process.argv[3]??'');
const mode=process.argv.includes('--prepare')?'prepare':process.argv.includes('--observe')?'observe':'inspect';
const port=Number(process.argv.find(x=>x.startsWith('--port='))?.split('=')[1]??52786),q=JSON.stringify;
if(!path.basename(out).startsWith('review-r86-')||!out.startsWith(path.resolve(__dirname,'../dist')+path.sep))throw Error('owned R86 evidence root required');
if(!path.basename(candidate).startsWith('desktop-daily-win-v25'))throw Error('explicit v25 source candidate required');
const alternatePair=process.argv.includes('--pair=codex-sol');
const primary=alternatePair?{kind:'codex',model:'gpt-6.1-sol',name:'协调实现 Sol 6.1'}:{kind:'claude',model:'glm-5.3-flash',name:'协调实现 GLM'};
const secondary=alternatePair?{kind:'codex',model:'gpt-6-sol',name:'独立评审 Sol 6'}:{kind:'codex',model:'gpt-6.1-sol',name:'独立评审 Codex'};
const progressFile=path.join(out,'progress.json'),observationFile=path.join(out,'real-code-v1.json');
const must=(value,why)=>{if(!value)throw Error(why);};const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let c,db,progress,result;
async function connect(){
  const page=await until(async()=>{try{return(await fetch(`http://127.0.0.1:${progress.port}/json/list`).then(r=>r.json())).find(p=>p.type==='page'&&p.url.includes('index.html'));}catch{return null;}},Boolean,'owned BAT page',90000);
  const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  c=new Cdp(ws);await c.send('Runtime.enable');await until(()=>c.eval('document.body?.classList.contains("hifi-on")'),Boolean,'formal desktop ready');
  const identity=await command('app.identity',{});must(path.resolve(identity.appDataDir)===path.resolve(progress.dataRoot),'exact isolated data root');
}
async function command(method,params){const receipt=await c.eval(`window.zs.command(${q({protocolVersion:1,commandId:randomUUID(),method,params})})`);must(receipt.ok,method+': '+JSON.stringify(receipt.error));return receipt.data;}
async function screenshot(name){await c.send('Page.bringToFront');await c.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));}
function manifest(root){const base=path.join(root,'ZhongshuoDual'),raw=JSON.parse(fs.readFileSync(path.join(base,'MANIFEST-SHA256.json'),'utf8')),rows=Array.isArray(raw)?raw:raw.files;
  for(const row of rows){const bytes=fs.readFileSync(path.join(base,row.path));must(bytes.length===row.bytes&&hash(bytes)===row.sha256,'program manifest '+row.path);}return rows.length;}
function start(){const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('ZS_')||key==='ELECTRON_RUN_AS_NODE')delete env[key];env.ZS_DEV25_DEBUG_PORT=String(progress.port);
  const log=fs.openSync(path.join(out,'launcher.log'),'a');spawn('cmd',['/c','start-desktop.bat'],{cwd:progress.copy,env,windowsHide:true,stdio:['ignore',log,log]}).unref();fs.closeSync(log);}
function calls(taskId){return taskId?db.prepare(`SELECT id,runtime_kind,model,response_model,status,task_id,turn_id FROM real_calls
  WHERE task_id=? OR task_id IN(SELECT id FROM tasks WHERE parent_task_id=?) ORDER BY id`).all(taskId,taskId):db.prepare('SELECT id,runtime_kind,model,response_model,status,task_id,turn_id FROM real_calls ORDER BY id').all();}
function save(){if(result)fs.writeFileSync(observationFile,JSON.stringify(result,null,2));}
function facts(taskId){return{
  task:db.prepare('SELECT id,status,current_delivery_id,revision,stop_generation FROM tasks WHERE id=?').get(taskId),
  coordination:db.prepare('SELECT * FROM coordination_runs WHERE task_id=? ORDER BY created_at').all(taskId),
  steps:db.prepare(`SELECT s.*,t.owner_member_id,t.title,t.status,t.current_delivery_id FROM coordination_steps s JOIN tasks t ON t.id=s.child_task_id JOIN coordination_runs c ON c.run_id=s.run_id WHERE c.task_id=? ORDER BY s.rowid`).all(taskId),
  runs:db.prepare('SELECT id,task_id,mode,status,stage,budget_json FROM workflow_runs WHERE task_id=? OR task_id IN(SELECT id FROM tasks WHERE parent_task_id=?) ORDER BY rowid').all(taskId,taskId),
  turns:db.prepare('SELECT a.id,a.member_id,a.status,a.run_id,a.dispatch_key FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=? OR r.task_id IN(SELECT id FROM tasks WHERE parent_task_id=?) ORDER BY a.rowid').all(taskId,taskId),
  deliveries:db.prepare('SELECT id,task_id,run_id,revision,manifest_hash,review_status,artifact_refs_json,change_set_refs_json FROM task_deliveries WHERE task_id=? OR task_id IN(SELECT id FROM tasks WHERE parent_task_id=?) ORDER BY rowid').all(taskId,taskId),
  tools:db.prepare("SELECT e.kind,e.turn_id,e.payload_json FROM domain_events e JOIN tasks t ON t.id=e.task_id WHERE (t.id=? OR t.parent_task_id=?) AND e.kind IN ('tool.started','tool.completed','turn.outputInvalid','turn.startupFailed','turn.statusChanged') ORDER BY e.seq").all(taskId,taskId)
};}
async function prepare(){
  must(!fs.existsSync(progressFile)&&!fs.existsSync(path.join(out,'copy')),'new untouched engineering root only');
  must(!fs.existsSync(path.join(candidate,'server-data')),'source candidate must stay pristine');
  const build=JSON.parse(fs.readFileSync(path.join(candidate,'ZhongshuoDual','BUILD.json'),'utf8'));must(!build.dirty,'clean BUILD required');
  await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(resolve));});
  fs.mkdirSync(out,{recursive:true});const copy=path.join(out,'copy');fs.cpSync(candidate,copy,{recursive:true});
  progress={scope:'R86 isolated real multi-model preparation, not delivery',build,candidate,copy,dataRoot:path.join(copy,'server-data'),project:path.join(out,'R86 合成协作工程'),port,programFiles:manifest(candidate),copyProgramFiles:manifest(copy),steps:[],modelCalls:0};
  fs.mkdirSync(progress.project);
  const init=spawnSync('git',['-C',progress.project,'init','-q','-b','main'],{encoding:'utf8',windowsHide:true,timeout:10000});must(init.status===0,'independent synthetic Git root');
  const config=spawnSync('git',['-C',progress.project,'config','core.autocrlf','false'],{encoding:'utf8',windowsHide:true,timeout:10000});must(config.status===0,'local synthetic Git byte policy');
  fs.writeFileSync(progressFile,JSON.stringify(progress,null,2));start();await connect();
  const project=(await command('project.open',{path:progress.project,displayName:'R86 合成协作工程'})).project;
  await command('project.reviewPolicy.set',{projectId:project.id,expectedRevision:project.revision,taskReviewEnabled:true});
  const claude=(await command('member.create',{projectId:project.id,displayName:primary.name,description:'负责规划与实现，必要时整合评审反馈'})).memberId;
  const codex=(await command('member.create',{projectId:project.id,displayName:secondary.name,description:'独立读取上游实际文件并运行只读验证，指出缺陷'})).memberId;
  await command('member.setRuntime',{memberId:claude,kind:primary.kind,model:primary.model,permissionMode:'bypassPermissions',effort:'high'});
  await command('member.setRuntime',{memberId:codex,kind:secondary.kind,model:secondary.model,permissionMode:'bypassPermissions',effort:'high'});
  const room=(await command('room.list',{projectId:project.id})).items[0];await command('room.update',{roomId:room.id,expectedRevision:room.revision,coordinatorMemberId:claude});
  const list=await command('member.list',{projectId:project.id,roomId:room.id});for(const member of list.items){if(![claude,codex].includes(member.id))await command('room.members.set',{roomId:room.id,memberId:member.id,action:'remove'});}
  progress.expectedModels=[`${primary.kind}/${primary.model}`,`${secondary.kind}/${secondary.model}`];
  progress.ids={projectId:project.id,claude,codex,roomId:room.id,conversationId:room.conversationId};
  progress.prompt='请协调两位成员合作完成一个小功能：创建 greeting.mjs，导出 greet(name)，返回“你好，名字”；创建对应的 Node 测试并实际运行。先实现，再让另一位使用不同模型的成员独立读取实际文件并评审、运行测试，最后汇总真实结果交给我验收。只在当前合成工程目录工作，说明简短自然即可。';
  await c.send('Page.reload');await until(()=>c.eval('document.body?.classList.contains("hifi-on")'),Boolean,'fresh formal registry');
  await c.eval(`location.hash=${q(`/project/${project.id}/room/${room.id}`)};document.title=${q('R86 合成协作验收 '+port)};true`);
  await until(()=>c.eval('document.querySelector("textarea.composer-input")!=null'),Boolean,'normal room composer');
  await until(()=>c.eval('document.querySelector("[data-zs-m0-hint=AUTO]")!=null'),Boolean,'actual default AUTO UI without automatic mentions');
  db=new Database(path.join(progress.dataRoot,'state.sqlite'),{readonly:true});must(calls().length===0,'configuration/opening must make zero inference calls');
  progress.prepared=true;progress.steps.push('real BAT / exact root / formal project, members, configuration and coordinator / zero inference');fs.writeFileSync(progressFile,JSON.stringify(progress,null,2));await screenshot('prepared');
}
async function observe(){
  must(!fs.existsSync(observationFile),'original observation retained; inspect instead of automatic rerun');
  progress=JSON.parse(fs.readFileSync(progressFile,'utf8'));await connect();db=new Database(path.join(progress.dataRoot,'state.sqlite'),{readonly:true});
  result={pass:false,scope:'one original native UI real AUTO send, v1 only; no automatic rework/retry',build:progress.build,startedAt:Date.now(),calls:[]};save();
  const root=await until(()=>db.prepare('SELECT id,conversation_thread_id,title,root_message_id,route_json FROM tasks WHERE project_id=? AND parent_task_id IS NULL ORDER BY rowid LIMIT 1').get(progress.ids.projectId),Boolean,'native original send',900000);result.root=root;must(JSON.parse(root.route_json).mode==='AUTO','original UI intent must be actual AUTO');
  const original=db.prepare('SELECT body_json FROM messages WHERE id=?').get(root.root_message_id);must(JSON.parse(original.body_json).text===progress.prompt,'exact original natural UI intent');save();let last=0;
  const delivery=await until(()=>{const current=facts(root.id);if(Date.now()-last>5000){result.live=current;result.calls=calls(root.id);save();last=Date.now();}
    if(current.turns.some(t=>['UNKNOWN','FAILED','CANCELLED'].includes(t.status))||current.task.status==='BLOCKED'){result.failure=current;save();throw Error('original collaboration failed/unknown; not automatically repeated');}
    return current.deliveries.find(d=>d.task_id===root.id&&d.revision===1);},Boolean,'real multi-model parent v1',2700000);
  result.final=facts(root.id);result.calls=calls(root.id);result.delivery=delivery;result.otherTaskCalls=calls().filter(call=>!result.calls.some(own=>own.id===call.id)).length;
  const models=new Set(result.calls.filter(x=>x.status==='succeeded').map(x=>`${x.runtime_kind}/${x.model}`));
  must(new Set(progress.expectedModels).size===2&&progress.expectedModels.every(model=>models.has(model)),'two distinct configured actual model calls in one task family');
  must(result.calls.every(call=>call.status==='succeeded'),'all actual calls must succeed');must(result.final.steps.length>=2&&result.final.steps.every(step=>step.status==='DONE'),'all genuine child steps done');
  must(fs.existsSync(path.join(progress.project,'greeting.mjs')),'model output source file missing');
  result.files=fs.readdirSync(progress.project).filter(name=>fs.statSync(path.join(progress.project,name)).isFile()).map(name=>({name,sha256:hash(fs.readFileSync(path.join(progress.project,name)))}));
  const testFiles=result.files.filter(file=>/test/i.test(file.name));must(testFiles.length>0,'model test file missing');
  result.inputBundles=db.prepare(`SELECT a.id turn_id,a.member_id,b.hash,b.included_refs_json FROM context_bundles b JOIN agent_turns a ON a.id=b.turn_id JOIN workflow_runs r ON r.id=a.run_id JOIN tasks t ON t.id=r.task_id WHERE t.id=? OR t.parent_task_id=? ORDER BY a.rowid`).all(root.id,root.id).map(row=>({turnId:row.turn_id,memberId:row.member_id,hash:row.hash,actualText:JSON.parse(row.included_refs_json)}));
  await c.eval(`location.hash=${q(`/thread/${root.conversation_thread_id}?tab=task`)};true`);await until(()=>c.eval('document.querySelector("[data-zs-coordination]")!=null'),Boolean,'real collaboration details');await screenshot('real-v1-collaboration');
  result.pass=true;result.finishedAt=Date.now();save();
}
(async()=>{try{if(mode==='prepare')await prepare();else if(mode==='observe')await observe();else{progress=JSON.parse(fs.readFileSync(progressFile,'utf8'));await connect();db=new Database(path.join(progress.dataRoot,'state.sqlite'),{readonly:true});console.log(JSON.stringify({build:progress.build,calls:calls(),ids:progress.ids}));}}
  catch(error){if(result){result.error=error.stack;result.pass=false;save();}else if(progress){progress.preparationError=error.stack;fs.writeFileSync(progressFile,JSON.stringify(progress,null,2));}process.exitCode=1;console.error(error.stack);}
  finally{if(db)db.close();c?.ws.close();console.log(JSON.stringify({mode,prepared:progress?.prepared??false,pass:result?.pass??null,calls:result?.calls?.length??0}));}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
