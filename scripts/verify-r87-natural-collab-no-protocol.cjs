/* Minimal R87 natural collaboration proof with no protocol text in user input.
 * Uses an owned package copy, a synthetic report fixture, and exact mixed models. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-empty */
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const pkg=path.resolve(process.argv[2]??'');
const fixtureRoot=path.resolve(process.argv[3]??'');
const out=path.resolve(process.argv[4]??'');
const requestedPort=Number(process.argv[5]??0);
const project=path.join(fixtureRoot,'project');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const q=JSON.stringify;
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const must=(value,label)=>{if(!value)throw Error(label);};
const terminalStatuses=new Set(['succeeded','failed','unknown','cancelled']);
const protocolWordPattern=/(TaskComplete|schema|JSON|Markdown|代码围栏|answer字段)/i;
let cdp=null,bat=null,db=null;

function appPorts(){
  const ports=new Set();
  if(requestedPort>0)ports.add(requestedPort);
  try{
    const value=Number(fs.readFileSync(path.join(pkg,'server-data','electron-user-data','DevToolsActivePort'),'utf8').split(/\r?\n/)[0]);
    if(Number.isInteger(value)&&value>0)ports.add(value);
  }catch{}
  return [...ports];
}
async function connect(){
  return until(async()=>{
    for(const port of appPorts()){
      try{
        const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(response=>response.json());
        const target=rows.find(row=>row.type==='page'&&row.url.includes('index.html'));
        if(target==null)continue;
        const ws=new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve,reject)=>{
          ws.addEventListener('open',resolve,{once:true});
          ws.addEventListener('error',reject,{once:true});
        });
        const value=new Cdp(ws);
        await value.send('Runtime.enable');
        await until(()=>value.eval('document.body?.classList.contains("hifi-on")'),Boolean,'hifi window',30000);
        return value;
      }catch{}
    }
    return null;
  },Boolean,'owned app window',120000);
}
async function cmd(method,params={}){
  const envelope={protocolVersion:1,commandId:`r87-natural-${randomUUID()}`,method,params};
  const result=await cdp.eval(`window.zs.command(${q(envelope)})`);
  must(result.ok,`${method}: ${JSON.stringify(result.error)}`);
  return result.data;
}
async function route(hash,selector,timeout=30000){
  await cdp.eval(`location.hash=${q(hash)};true`);
  await until(()=>cdp.eval(`document.querySelector(${q(selector)})!=null`),Boolean,hash,timeout);
  await sleep(350);
}
async function setInput(selector,value){
  return cdp.eval(`(()=>{const input=document.querySelector(${q(selector)});if(!input)return false;const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${q(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
}
async function clickText(text,scope='body'){
  return cdp.eval(`(()=>{const root=document.querySelector(${q(scope)})??document;const button=[...root.querySelectorAll('button,a')].find(item=>item.textContent.trim()===${q(text)});if(!button||button.disabled)return false;button.click();return true})()`);
}
async function clickTextStarts(text,scope='body'){
  return cdp.eval(`(()=>{const root=document.querySelector(${q(scope)})??document;const button=[...root.querySelectorAll('button,a')].find(item=>item.textContent.trim().startsWith(${q(text)}));if(!button||button.disabled)return false;button.click();return true})()`);
}
async function clickSelector(selector){
  return cdp.eval(`(()=>{const button=document.querySelector(${q(selector)});if(!button||button.disabled)return false;button.click();return true})()`);
}
async function shot(name){
  await cdp.send('Page.bringToFront');
  await cdp.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const result=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(result.data,'base64'));
}
function dbOpen(){
  if(db==null)db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  return db;
}
function rows(sql,...params){return dbOpen().prepare(sql).all(...params);}
function row(sql,...params){return dbOpen().prepare(sql).get(...params)??null;}
function calls(){return rows('SELECT rowid AS seq,id,runtime_kind,model,member_id,task_id,turn_id,run_id,status,response_model,detail,created_at,settled_at FROM real_calls ORDER BY rowid');}
function safeJson(raw){try{return JSON.parse(raw);}catch{return null;}}
function agentMessages(threadId){
  return rows("SELECT id,task_id,author_id,status,body_json,created_at FROM messages WHERE thread_id=? AND author_type='agent' ORDER BY conversation_seq",threadId)
    .map(message=>({id:message.id,taskId:message.task_id,authorId:message.author_id,status:message.status,raw:message.body_json,body:safeJson(message.body_json),at:message.created_at}));
}
function findingFor(raw){
  if(/FontDescriptor|FontFile|ZS-Custom|Identity-H/.test(raw)&&/(未嵌入|字体程序未嵌入|FontFile.{0,30}(缺失|不存在|没有)|(缺失|不存在|没有).{0,30}FontFile)/.test(raw)&&/PDF|pdf/.test(raw))
    return{key:'font',text:'PDF 字体未嵌入，需在发布前嵌入并实际渲染确认'};
  if(/DOCX|docx/.test(raw)&&/(4\s*行|4\s*[×xX*]\s*3|四行)/.test(raw)&&/PDF|pdf/.test(raw)
    &&/(无表格|没有表格|缺表|无该表|没有该表|未出现.{0,20}表格|不含.{0,20}表格)/.test(raw))
    return{key:'table',text:'DOCX 与 PDF 的进度表/内容不一致，需统一唯一发布版本'};
  if(/(docProps|\/Metadata|XMP|元数据)/.test(raw)&&/(DOCX|docx|PDF|pdf|两份)/.test(raw))
    return{key:'metadata',text:'两份文档缺少可追溯元数据，需补齐版本与作者信息'};
  return null;
}
async function addClaude(member){
  await clickText('添加 AI');
  await until(()=>cdp.eval('document.querySelector(".modal")!=null'),Boolean,'add Claude modal');
  must(await setInput('input[placeholder*="审查者"]',member.name),'Claude name');
  must(await setInput('input[placeholder*="实现与重构"]',member.description),'Claude description');
  must(await setInput('input[aria-label="手动模型 ID"]','deepseek-flash'),'Claude model');
  must(await clickSelector('[data-zs-member-addsave]'),'Claude save');
  await until(()=>cdp.eval('document.querySelector(".modal")==null'),Boolean,'Claude saved',30000);
}
async function addCodex(member){
  await clickText('添加 AI');
  await until(()=>cdp.eval('document.querySelector(".modal")!=null'),Boolean,'add Codex modal');
  must(await setInput('input[placeholder*="审查者"]',member.name),'Codex name');
  must(await setInput('input[placeholder*="实现与重构"]',member.description),'Codex description');
  must(await clickSelector('button[role="combobox"][aria-label="运行渠道"]'),'Codex channel');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=codex]")!=null'),Boolean,'Codex option');
  must(await clickSelector('[data-zs-option="codex"]'),'Codex select');
  await until(()=>cdp.eval('document.querySelector("button[role=combobox][aria-label=\\"模型\\"]:not([disabled])")!=null'),Boolean,'Codex model ready',30000);
  must(await clickSelector('button[role="combobox"][aria-label="模型"]'),'Codex model dropdown');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=\\"ccs-new/glm-5.3-flash\\"]")!=null'),Boolean,'GLM option');
  must(await clickSelector('[data-zs-option="ccs-new/glm-5.3-flash"]'),'GLM select');
  await until(()=>cdp.eval('document.querySelector("button[role=combobox][aria-label=\\"思考等级\\"]:not([disabled])")!=null'),Boolean,'effort ready',30000);
  must(await clickSelector('button[role="combobox"][aria-label="思考等级"]'),'effort dropdown');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=\\"high\\"]")!=null'),Boolean,'high option');
  must(await clickSelector('[data-zs-option="high"]'),'high select');
  must(await clickSelector('[data-zs-member-addsave]'),'Codex save');
  await until(()=>cdp.eval('document.querySelector(".modal")==null'),Boolean,'Codex saved',30000);
}
async function mention(idOrAll,scope){
  const opened=await cdp.eval(`(()=>{const button=[...document.querySelectorAll(${q(`${scope} button`)})].find(item=>(item.title??'').includes('提及成员'));if(!button||button.disabled)return false;button.click();return true})()`);
  must(opened,'mention button');
  await until(()=>cdp.eval(`document.querySelector(${q(`${scope} .mention-pop`)})!=null`),Boolean,'mention menu');
  if(idOrAll==='all')must(await cdp.eval(`(()=>{const button=[...document.querySelectorAll(${q(`${scope} .mention-pop .menu-item`)})][0];if(!button)return false;button.click();return true})()`),'all mention');
  else must(await clickSelector(`${scope} [data-zs-mention-option="${idOrAll}"]`),'member mention');
  await sleep(150);
}
async function send(text,mentioned=null,scope='body'){
  if(mentioned!=null)await mention(mentioned,scope);
  const area=`${scope} .composer-input`;
  must(await setInput(area,text),'composer input');
  await sleep(150);
  must(await clickSelector(`${scope} .composer-send`),'composer send');
  await until(()=>cdp.eval(`(()=>{const input=document.querySelector(${q(area)});return input!=null&&input.value.trim().length===0})()`),Boolean,'send accepted',30000);
}
function start(){
  fs.mkdirSync(out,{recursive:true});
  const pickFile=path.join(out,'open-folder.txt');
  fs.writeFileSync(pickFile,project+'\r\n');
  const env={...process.env,ZS_DEV25_DEBUG_PORT:String(requestedPort||0),ZS_PICK_FOLDER_FILE:pickFile};
  for(const key of ['ZS_APP_DATA','ZS_RUNTIME','ZS_ALLOW_FAKE','ZS_REAL_DISPATCH_GUARD','ZS_DAEMON_ENTRY','ZS_R78_ENGINEERING_TOKEN'])delete env[key];
  bat=spawn('cmd',['/c','start-desktop.bat'],{cwd:pkg,env,windowsHide:true,stdio:'ignore'});
  bat.unref();
}
async function stop(){
  if(cdp!=null){
    try{await cdp.eval('window.zsWindow.close();true');}catch{}
    try{cdp.ws.close();}catch{}
    cdp=null;
  }
  await sleep(1500);
}

(async()=>{
  must(fs.existsSync(path.join(pkg,'ZhongshuoDual','BUILD.json')),'package BUILD.json');
  must(fs.existsSync(path.join(project,'R87交付报告.docx'))&&fs.existsSync(path.join(project,'R87交付报告.pdf')),'synthetic report fixture');
  fs.mkdirSync(out,{recursive:true});
  start();
  cdp=await connect();
  const facts={
    format:'zhongshuo-r87-natural-collab-no-protocol-v1',
    ok:false,
    package:pkg,
    project,
    out,
    build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),
    steps:[],
    calls:[],
    modelCalls:0,
    at:new Date().toISOString(),
  };
  const saveFacts=()=>fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(facts,null,2));
  try{
    const identity=await cmd('app.identity');
    must(path.resolve(identity.appDataDir)===path.resolve(pkg,'server-data'),'owned data root');
    facts.steps.push('opened native welcome on isolated default data root');
    if(await cdp.eval('Boolean([...document.querySelectorAll("button")].find(item=>item.textContent.trim()==="打开文件夹"))'))await clickText('打开文件夹');
    await until(()=>cdp.eval('location.hash.includes("/room/")'),Boolean,'project room',90000);
    const projectRow=rows('SELECT id,revision,task_review_enabled FROM projects ORDER BY rowid DESC LIMIT 1')[0];
    must(projectRow!=null,'synthetic project');
    await cmd('project.reviewPolicy.set',{projectId:projectRow.id,expectedRevision:projectRow.revision,taskReviewEnabled:true});
    const reviewRow=rows('SELECT revision FROM projects WHERE id=?',projectRow.id)[0];
    await cmd('project.collab.set',{projectId:projectRow.id,expectedRevision:reviewRow.revision,turnDeadlineMs:900000});
    facts.steps.push('opened folder through UI and set a 15-minute collaboration deadline');

    await clickText('成员管理');
    await until(()=>cdp.eval('document.querySelector("[data-zs-members]")!=null'),Boolean,'members page');
    await addClaude({
      name:'DeepSeek 审查',
      description:'读取同一份报告，核对金额、日期、附件、验收人与发布风险，并汇总其他成员的具体发现。',
    });
    await addCodex({
      name:'Codex GLM 复核',
      description:'读取同一份报告，核对跨格式一致性、表格、字体、元数据和发布风险，并把具体发现交给汇总成员。',
    });
    const memberRows=rows(`SELECT pm.id,pm.display_name AS displayName,pm.description,ri.kind,ap.settings_json AS settingsJson
      FROM project_members pm JOIN agent_profiles ap ON ap.id=pm.profile_id JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id
      WHERE pm.project_id=? ORDER BY pm.rowid`,projectRow.id);
    const deepseek=memberRows.find(member=>member.displayName==='DeepSeek 审查');
    const codex=memberRows.find(member=>member.displayName==='Codex GLM 复核');
    must(deepseek&&codex,'two members created');
    deepseek.settings=JSON.parse(deepseek.settingsJson);
    codex.settings=JSON.parse(codex.settingsJson);
    must(deepseek.kind==='claude'&&deepseek.settings.model==='deepseek-flash','exact DeepSeek binding');
    must(codex.kind==='codex'&&codex.settings.model==='ccs-new/glm-5.3-flash'&&codex.settings.effort==='high','exact GLM binding');
    must(!protocolWordPattern.test(deepseek.description??'')&&!protocolWordPattern.test(codex.description??''),'member descriptions contain no protocol words');
    facts.ids={projectId:projectRow.id,deepseekId:deepseek.id,codexId:codex.id};
    facts.steps.push('created both AIs through visible UI with exact mixed-model bindings');

    const room=rows('SELECT id FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1',projectRow.id)[0];
    must(room!=null,'default room');
    facts.ids.roomId=room.id;
    await route(`/project/${projectRow.id}/room/${room.id}`,'.composer-input');
    const beforeTasks=rows('SELECT count(*) n FROM tasks WHERE project_id=?',projectRow.id)[0].n;
    await send('你好',deepseek.id);
    await until(()=>rows('SELECT count(*) n FROM tasks WHERE project_id=?',projectRow.id)[0].n>beforeTasks,Boolean,'greeting task',60000);
    const task=rows('SELECT id,conversation_thread_id FROM tasks WHERE project_id=? ORDER BY rowid DESC LIMIT 1',projectRow.id)[0];
    must(task?.conversation_thread_id,'new thread');
    facts.ids.taskId=task.id;
    facts.ids.threadId=task.conversation_thread_id;
    await until(()=>agentMessages(task.conversation_thread_id).some(message=>message.authorId===deepseek.id),Boolean,'greeting answer',300000);
    facts.steps.push('started one ordinary thread through the visible composer');

    await route(`/project/${projectRow.id}/room/${room.id}?thread=${task.conversation_thread_id}`,'.col-thread .composer-input');
    await clickText('详情','.col-thread');
    await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("参与成员")'),Boolean,'thread details');
    await clickTextStarts('参与成员','.col-thread');
    await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("本串成员")'),Boolean,'thread members');
    const added=await cdp.eval(`(()=>{const rows=[...document.querySelectorAll('.row')];const row=rows.find(item=>(item.textContent??'').includes('Codex GLM 复核'));const button=[...row?.querySelectorAll('button')??[]].find(item=>item.textContent.trim()==='添加到本串');if(!button||button.disabled)return false;button.click();return true})()`);
    must(added,'add Codex to thread');
    await until(async()=>{
      const snapshot=await cmd('thread.get',{threadId:task.conversation_thread_id});
      return snapshot.members?.memberIds?.includes(codex.id)===true;
    },Boolean,'Codex thread member',30000);
    facts.steps.push('added Codex to the existing thread through visible UI');

    await route(`/project/${projectRow.id}/room/${room.id}?thread=${task.conversation_thread_id}`,'.col-thread .composer-input');
    const prompt='请两位协作复核同一份报告：DeepSeek 把当前发现和文件路径交给 Codex；Codex 必须实际读取同一 DOCX/PDF，独立核对两种格式的表格、字体、元数据和跨版本一致性，至少给出一个可以合并进复核结论的具体发现；最后由 DeepSeek 汇总更新 报告复核-v1.md。不要修改原报告，完成后告诉我实际文件和结论。';
    must(!protocolWordPattern.test(prompt),'natural prompt contains no protocol words');
    const seqBefore=Math.max(0,...calls().map(call=>call.seq));
    await send(prompt,'all','.col-thread');
    await until(()=>rows("SELECT id,body_json FROM messages WHERE thread_id=? AND author_type='human' ORDER BY conversation_seq",task.conversation_thread_id)
      .some(message=>message.body_json.includes('请两位协作复核同一份报告')),Boolean,'natural human message persisted',30000);
    const humanMessages=rows("SELECT id,body_json,created_at FROM messages WHERE thread_id=? AND author_type='human' ORDER BY conversation_seq",task.conversation_thread_id);
    const naturalMessage=humanMessages.find(message=>message.body_json.includes('请两位协作复核同一份报告'));
    must(naturalMessage?.body_json.includes('请两位协作复核同一份报告'),'natural request message');
    facts.prompt={id:naturalMessage.id,rawBodySha256:createHash('sha256').update(Buffer.from(naturalMessage.body_json,'utf8')).digest('hex'),text:prompt};
    facts.steps.push('sent the collaboration request with no protocol text in any human message');
    await shot('natural-collaboration-sent');

    await until(()=>{
      const recent=calls().filter(call=>call.seq>seqBefore);
      return recent.some(call=>call.runtime_kind==='codex'&&call.member_id===codex.id)
        &&recent.every(call=>terminalStatuses.has(call.status));
    },Boolean,'natural collaboration calls terminal',1200000);
    const collaborationCallsSoFar=calls().filter(call=>call.seq>seqBefore);
    const codexCall=collaborationCallsSoFar.find(call=>call.runtime_kind==='codex'&&call.member_id===codex.id&&call.model==='ccs-new/glm-5.3-flash');
    must(codexCall,'exact Codex call');
    must(codexCall.status==='succeeded',`Codex natural call did not succeed: ${codexCall.status} ${codexCall.detail??''}`);
    const codexFinalMessages=agentMessages(task.conversation_thread_id).filter(message=>message.taskId===codexCall.task_id&&message.authorId===codex.id&&message.status==='final');
    const codexFinal=codexFinalMessages.find(message=>findingFor(JSON.stringify(message.body))!=null);
    must(codexFinal,'Codex useful final message');
    const finding=findingFor(JSON.stringify(codexFinal.body));
    must(finding,'classified Codex finding');
    facts.codex={call:codexCall,messageId:codexFinal.id,finding,messageRawBodySha256:createHash('sha256').update(Buffer.from(codexFinal.raw,'utf8')).digest('hex')};

    const reportFile=path.join(project,'报告复核-v1.md');
    const findingPattern={
      font:value=>/字体|嵌入/.test(value),
      table:value=>/表格|不一致/.test(value),
      metadata:value=>/元数据|作者|版本/.test(value),
    };
    await until(()=>{
      if(!fs.existsSync(reportFile))return false;
      const value=fs.readFileSync(reportFile,'utf8');
      return value.includes('36,500')&&value.includes('预算明细.xlsx')&&value.includes('2026-10-18')&&value.includes('李晨')&&value.includes('张岚')
        &&findingPattern[finding.key](value)&&/Codex/i.test(value);
    },Boolean,'DeepSeek integrated Codex finding',900000);

    const coordination=await until(()=>{
      const codexTask=row('SELECT id,status,revision,current_delivery_id FROM tasks WHERE id=?',codexCall.task_id);
      const childDelivery=codexTask?.current_delivery_id==null?null:row('SELECT id,task_id,run_id,revision,manifest_hash,review_status FROM task_deliveries WHERE id=?',codexTask.current_delivery_id);
      const firstStep=row('SELECT run_id,step_key,child_task_id,role,handoff_json FROM coordination_steps WHERE child_task_id=?',codexCall.task_id);
      if(codexTask==null||childDelivery==null||firstStep==null)return null;
      const downstream=rows('SELECT run_id,step_key,child_task_id,role,handoff_json FROM coordination_steps WHERE run_id=? AND child_task_id!=? ORDER BY rowid',firstStep.run_id,firstStep.child_task_id)
        .find(step=>{
          const parsed=safeJson(step.handoff_json);
          return (parsed?.upstream??[]).some(upstream=>upstream.id===childDelivery.id
            &&upstream.run_id===childDelivery.run_id&&upstream.manifest_hash===childDelivery.manifest_hash
            &&upstream.owner_member_id===codex.id);
        });
      if(downstream==null)return null;
      const targetCall=calls().find(call=>call.task_id===downstream.child_task_id
        &&call.runtime_kind==='claude'&&call.member_id===deepseek.id&&call.status==='succeeded');
      if(targetCall==null)return null;
      return{codexTask,childDelivery,firstStep,downstream,targetCall,coordinationMessageCount:rows('SELECT count(*) n FROM coordination_messages')[0].n};
    },Boolean,'coordination upstream and DeepSeek summary',900000);
    await until(()=>{
      const coordinationRun=row('SELECT state,integration_run_id,error_message FROM coordination_runs WHERE run_id=?',coordination.firstStep.run_id);
      if(coordinationRun?.state!=='completed'||coordinationRun.integration_run_id==null)return false;
      const allCalls=calls();
      if(!allCalls.every(call=>terminalStatuses.has(call.status)))return false;
      const rootTask=row('SELECT status,current_delivery_id FROM tasks WHERE id=?',task.id);
      return rootTask!=null&&['REVIEW','DONE'].includes(rootTask.status)&&rootTask.current_delivery_id!=null;
    },Boolean,'full coordination integration completed',900000);
    const coordinationRun=row('SELECT run_id,state,integration_run_id,error_message FROM coordination_runs WHERE run_id=?',coordination.firstStep.run_id);
    const rootTask=row('SELECT id,status,current_delivery_id FROM tasks WHERE id=?',task.id);
    const integrationCall=calls().find(call=>call.run_id===coordinationRun?.integration_run_id)??null;
    const integrationDelivery=rootTask?.current_delivery_id==null?null:row('SELECT id,task_id,run_id,revision,manifest_hash,review_status FROM task_deliveries WHERE id=?',rootTask.current_delivery_id);
    const collaborationCalls=calls().filter(call=>call.seq>seqBefore);
    const coordinationSteps=rows('SELECT step_key,child_task_id FROM coordination_steps WHERE run_id=? ORDER BY rowid',coordination.firstStep.run_id);
    const plannedChildIds=new Set(coordinationSteps.map(step=>step.child_task_id));
    const childTasks=rows('SELECT id,status,title FROM tasks WHERE parent_task_id=? ORDER BY rowid',task.id);
    const unexpectedChildTasks=childTasks.filter(child=>!plannedChildIds.has(child.id));
    const coordinationMessageCount=rows('SELECT count(*) n FROM coordination_messages')[0].n;
    const ignoredRedundantHandoffs=rows("SELECT count(*) n FROM domain_events WHERE kind='member.messageIgnoredRedundantPlan'")[0].n;
    facts.coordination={...coordination,coordinationRun,rootTask,integrationCall,integrationDelivery,coordinationSteps,childTasks,coordinationMessageCount,ignoredRedundantHandoffs};
    facts.steps.push('verified the Codex child delivery is the downstream step upstream and the final coordination integration reached a ready state');

    const finalReport=fs.readFileSync(reportFile,'utf8');
    const humanMessagesFinal=rows("SELECT id,body_json FROM messages WHERE thread_id=? AND author_type='human' ORDER BY conversation_seq",task.conversation_thread_id);
    const modelSettings=rows(`SELECT pm.display_name AS displayName,pm.description,ap.settings_json AS settingsJson
      FROM project_members pm JOIN agent_profiles ap ON ap.id=pm.profile_id WHERE pm.project_id=? ORDER BY pm.rowid`,projectRow.id);
    const checks={
      exactModels:codexCall.member_id===codex.id&&codexCall.model==='ccs-new/glm-5.3-flash'
        &&collaborationCalls.some(call=>call.runtime_kind==='claude'&&call.member_id===deepseek.id&&call.model==='deepseek-flash'&&call.status==='succeeded'),
      noProtocolWordsInHumanMessages:humanMessagesFinal.every(message=>!protocolWordPattern.test(message.body_json)),
      noProtocolWordsInMemberDescriptions:modelSettings.every(member=>!protocolWordPattern.test(member.description??'')&&!protocolWordPattern.test(member.settingsJson??'')),
      codexUsefulResult:finding!=null,
      coordinationUpstream:coordination.firstStep.run_id===coordination.downstream.run_id
        &&coordination.targetCall.task_id===coordination.downstream.child_task_id,
      integrationCallSucceeded:coordinationRun?.state==='completed'&&integrationCall?.runtime_kind==='claude'
        &&integrationCall.member_id===deepseek.id&&integrationCall.model==='deepseek-flash'&&integrationCall.status==='succeeded',
      rootDeliveryReady:rootTask!=null&&['REVIEW','DONE'].includes(rootTask.status)&&integrationDelivery!=null
        &&integrationDelivery.run_id===integrationCall?.run_id,
      deepseekIntegrated:findingPattern[finding.key](finalReport)&&/Codex/i.test(finalReport),
      reportFacts:finalReport.includes('36,500')&&finalReport.includes('预算明细.xlsx')&&finalReport.includes('2026-10-18')&&finalReport.includes('李晨')&&finalReport.includes('张岚'),
      allCollaborationCallsTerminal:collaborationCalls.length>0&&collaborationCalls.every(call=>terminalStatuses.has(call.status)),
      allModelCallsSucceeded:calls().length>0&&calls().every(call=>call.status==='succeeded'),
      noUnexpectedChildTasks:unexpectedChildTasks.length===0&&childTasks.length===coordinationSteps.length&&childTasks.every(child=>child.status==='DONE'),
    };
    facts.humanMessages=humanMessagesFinal.map(message=>({id:message.id,rawBodySha256:createHash('sha256').update(Buffer.from(message.body_json,'utf8')).digest('hex')}));
    facts.collaborationCalls=collaborationCalls;
    facts.modelCalls=calls().length;
    facts.calls=calls();
    facts.report={name:'报告复核-v1.md',bytes:fs.statSync(reportFile).size,sha256:sha(reportFile)};
    facts.checks=checks;
    facts.ok=Object.values(checks).every(Boolean);
    saveFacts();
    console.log(JSON.stringify({ok:facts.ok,evidence:path.join(out,'result.json'),checks,codex:finding,coordination:{runId:coordination.firstStep.run_id,summaryTaskId:coordination.targetCall.task_id,integrationCallId:integrationCall?.id,rootTaskId:rootTask?.id,deliveryId:integrationDelivery?.id}},null,2));
    if(!facts.ok)process.exitCode=1;
  }catch(error){
    facts.error=error.stack??String(error);
    facts.calls=calls();
    facts.modelCalls=facts.calls.length;
    saveFacts();
    throw error;
  }finally{
    if(db!=null){db.close();db=null;}
    await stop();
  }
})().catch(error=>{
  console.error(error.stack??error);
  process.exitCode=1;
});
