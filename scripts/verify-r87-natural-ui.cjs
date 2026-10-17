/* R87 natural UI route on an owned package. No user project, no user profile
 * writes. The script uses only the synthetic report fixture in dist/. */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars, no-undef, no-empty */
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const repo=path.resolve(__dirname,'..');
const pkg=path.resolve(process.argv[2]??path.join(repo,'dist/desktop/desktop-daily-win-r87-e2e-2'));
const fixtureRoot=path.resolve(process.argv[3]??path.join(repo,'dist/review-r87-final/synthetic-report-2026-10-17T14-56-27-322Z'));
const project=path.join(fixtureRoot,'project');
const out=path.resolve(process.argv[4]??path.join(repo,'dist/review-r87-final',`natural-ui-${Date.now()}`));
const requestedPort=Number(process.argv.find(x=>x.startsWith('--port='))?.split('=')[1]??0);
const attach=process.argv.includes('--attach');
const saveAsDir=path.join(out,'saved');
const pickFile=path.join(out,'open-folder.txt');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const must=(value,label)=>{if(!value)throw Error(label);};
const q=JSON.stringify;
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let cdp=null,bat=null,db=null;

function appPorts(){
  const ports=new Set();
  if(requestedPort>0)ports.add(requestedPort);
  const add=file=>{try{const p=Number(fs.readFileSync(file,'utf8').split(/\r?\n/)[0]);if(Number.isInteger(p)&&p>0)ports.add(p);}catch{}};
  add(path.join(pkg,'server-data','electron-user-data','DevToolsActivePort'));
  try{for(const e of fs.readdirSync(out,{withFileTypes:true}))if(e.isDirectory())add(path.join(out,e.name,'server-data','electron-user-data','DevToolsActivePort'));}catch{}
  return [...ports];
}
async function connect(timeout=120000){
  return until(async()=>{
    for(const port of appPorts())try{
      const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json());
      const target=rows.find(t=>t.type==='page'&&t.url.includes('index.html'));
      if(!target)continue;
      const ws=new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
      const c=new Cdp(ws);await c.send('Runtime.enable');
      await until(()=>c.eval('document.body?.classList.contains("hifi-on")'),Boolean,'hifi window',30000);
      return c;
    }catch{}
    return null;
  },Boolean,'owned app window',timeout);
}
async function cmd(method,params={}){
  const envelope={protocolVersion:1,commandId:`r87-ui-${randomUUID()}`,method,params};
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
  return cdp.eval(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return false;const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
}
async function clickText(text,scope='body'){
  return cdp.eval(`(()=>{const root=document.querySelector(${q(scope)})??document;const b=[...root.querySelectorAll('button,a')].find(x=>x.textContent.trim()===${q(text)});if(!b||b.disabled)return false;b.click();return true})()`);
}
async function clickTextStarts(text,scope='body'){
  return cdp.eval(`(()=>{const root=document.querySelector(${q(scope)})??document;const b=[...root.querySelectorAll('button,a')].find(x=>x.textContent.trim().startsWith(${q(text)}));if(!b||b.disabled)return false;b.click();return true})()`);
}
async function clickSelector(selector){
  return cdp.eval(`(()=>{const b=document.querySelector(${q(selector)});if(!b||b.disabled)return false;b.click();return true})()`);
}
async function shot(name){
  await cdp.send('Page.bringToFront');
  await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const result=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(result.data,'base64'));
}
function dbOpen(){
  if(db==null)db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  return db;
}
function rows(sql,...params){return dbOpen().prepare(sql).all(...params);}
function row(sql,...params){return dbOpen().prepare(sql).get(...params);}
function latestTasks(projectId,limit=5){return rows('SELECT id,conversation_thread_id,root_message_id,status,revision,review_policy,response_kind,title FROM tasks WHERE project_id=? ORDER BY rowid DESC LIMIT ?',projectId,limit);}
function calls(){return rows('SELECT id,runtime_kind,model,member_id,task_id,status,response_model,detail FROM real_calls ORDER BY rowid');}
function agentBodies(threadId){return rows("SELECT body_json,created_at FROM messages WHERE thread_id=? AND author_type='agent' ORDER BY conversation_seq",threadId).map(x=>({at:x.created_at,body:JSON.parse(x.body_json)}));}

async function addClaude(projectId,member){
  await clickText('添加 AI');
  await until(()=>cdp.eval('document.querySelector(".modal")!=null'),Boolean,'add AI modal');
  must(await setInput('input[placeholder*="审查者"]',member.name),'Claude name input');
  must(await setInput('input[placeholder*="实现与重构"]',member.description),'Claude description input');
  must(await setInput('input[aria-label="手动模型 ID"]','deepseek-flash'),'Claude model input');
  must(await clickSelector('[data-zs-member-addsave]'),'Claude save');
  await until(()=>cdp.eval('document.querySelector(".modal")==null'),Boolean,'Claude member saved',30000);
}
async function addCodex(projectId,member){
  await clickText('添加 AI');
  await until(()=>cdp.eval('document.querySelector(".modal")!=null'),Boolean,'add AI modal');
  must(await setInput('input[placeholder*="审查者"]',member.name),'Codex name input');
  must(await setInput('input[placeholder*="实现与重构"]',member.description),'Codex description input');
  must(await clickSelector('button[role="combobox"][aria-label="运行渠道"]'),'Codex channel');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=codex]")!=null'),Boolean,'Codex channel option');
  must(await clickSelector('[data-zs-option="codex"]'),'select Codex');
  await until(()=>cdp.eval('document.querySelector("button[role=combobox][aria-label=\\"模型\\"]:not([disabled])")!=null'),Boolean,'Codex model ready',30000);
  must(await clickSelector('button[role="combobox"][aria-label="模型"]'),'Codex model dropdown');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=\\"gpt-6-luna\\"]")!=null'),Boolean,'gpt-6-luna dropdown');
  must(await clickSelector('[data-zs-option="gpt-6-luna"]'),'select gpt-6-luna');
  await until(()=>cdp.eval('document.querySelector("button[role=combobox][aria-label=\\"思考等级\\"]:not([disabled])")!=null'),Boolean,'effort ready',30000);
  must(await clickSelector('button[role="combobox"][aria-label="思考等级"]'),'effort dropdown');
  await until(()=>cdp.eval('document.querySelector("[data-zs-option=\\"medium\\"]")!=null'),Boolean,'medium effort option',30000);
  must(await clickSelector('[data-zs-option="medium"]'),'select medium');
  must(await clickSelector('[data-zs-member-addsave]'),'Codex save');
  await until(()=>cdp.eval('document.querySelector(".modal")==null'),Boolean,'Codex member saved',30000);
}
async function mention(idOrAll,scope='body'){
  const opened=await cdp.eval(`(()=>{const b=[...document.querySelectorAll(${q(scope+' button')})].find(x=>(x.title??'').includes('提及成员'));if(!b||b.disabled)return false;b.click();return true})()`);
  must(opened,'mention button');
  await until(()=>cdp.eval(`document.querySelector(${q(scope+' .mention-pop')})!=null`),Boolean,'mention menu');
  if(idOrAll==='all')must(await cdp.eval(`(()=>{const b=[...document.querySelectorAll(${q(scope+' .mention-pop .menu-item')})][0];if(!b)return false;b.click();return true})()`),'all mention');
  else must(await clickSelector(`${scope} [data-zs-mention-option="${idOrAll}"]`),'member mention');
  await sleep(150);
}
async function send(text,mentioned=null,scope='body'){
  if(mentioned!=null)await mention(mentioned,scope);
  const area=`${scope} .composer-input`;
  must(await setInput(area,text),'composer input');
  await sleep(150);
  must(await clickSelector(`${scope} .composer-send`),'composer send');
  await until(()=>cdp.eval(`(()=>{const e=document.querySelector(${q(area)});return e&&e.value.trim().length===0})()`),Boolean,'send accepted',30000);
}
function waitFile(name,timeout=900000){return until(()=>fs.existsSync(path.join(project,name)),Boolean,`file ${name}`,timeout);}
function start(){
  fs.mkdirSync(out,{recursive:true});fs.writeFileSync(pickFile,project+'\r\n');fs.mkdirSync(saveAsDir,{recursive:true});
  const env={...process.env,ZS_DEV25_DEBUG_PORT:String(requestedPort||0),ZS_PICK_FOLDER_FILE:pickFile,ZS_SAVEAS_AUTO_DIR:saveAsDir};
  for(const key of ['ZS_APP_DATA','ZS_RUNTIME','ZS_ALLOW_FAKE','ZS_REAL_DISPATCH_GUARD','ZS_DAEMON_ENTRY','ZS_R78_ENGINEERING_TOKEN'])delete env[key];
  bat=spawn('cmd',['/c','start-desktop.bat'],{cwd:pkg,env,windowsHide:true,stdio:'ignore'});bat.unref();
}
async function stop(){
  if(cdp){try{await cdp.eval('window.zsWindow.close();true');}catch{}cdp.ws.close();cdp=null;}
  await sleep(1500);
}

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  if(!attach)start();
  cdp=await connect();
  const facts={format:'zhongshuo-r87-natural-ui-v1',ok:false,package:pkg,project,out,build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),steps:[],calls:[],modelCalls:0,at:new Date().toISOString()};
  const saveFacts=()=>fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(facts,null,2));
  try{
    const identity=await cmd('app.identity');must(path.resolve(identity.appDataDir)===path.resolve(pkg,'server-data'),'owned default data root');facts.steps.push('native welcome / isolated default data root');
    if(await cdp.eval('Boolean([...document.querySelectorAll("button")].find(x=>x.textContent.trim()==="打开文件夹"))'))await clickText('打开文件夹');
    await until(()=>cdp.eval('location.hash.includes("/room/")'),Boolean,'room opened',90000);
    const projects=rows('SELECT id,revision,task_review_enabled FROM projects ORDER BY rowid DESC LIMIT 1');must(projects.length===1,'one synthetic project');const projectId=projects[0].id;
    await cmd('project.reviewPolicy.set',{projectId,expectedRevision:projects[0].revision,taskReviewEnabled:true});facts.steps.push('open folder via welcome UI; project review policy enabled');
    await clickText('成员管理');await until(()=>cdp.eval('document.querySelector("[data-zs-members]")!=null'),Boolean,'members UI');await shot('members-before-add');
    await addClaude(projectId,{name:'DeepSeek 审查',description:'读取合成 DOCX/PDF，核对金额、日期、附件、验收人与发布风险'});
    await addCodex(projectId,{name:'Codex 复核',description:'独立读取同一报告，复核并补充问题'});
    const members=rows('SELECT id,display_name FROM project_members WHERE project_id=?',projectId);const deepseek=members.find(m=>m.display_name==='DeepSeek 审查');const codex=members.find(m=>m.display_name==='Codex 复核');
    must(deepseek&&codex,'two UI-created AI members');facts.ids={projectId,deepseekId:deepseek.id,codexId:codex.id};
    const room=rows('SELECT id FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1',projectId)[0];must(room,'default room');facts.ids.roomId=room.id;
    await route(`/project/${projectId}/room/${room.id}`,'.composer-input');
    const beforeTasks=rows('SELECT count(*) n FROM tasks WHERE project_id=?',projectId)[0].n;
    await send('你好',deepseek.id);
    await until(()=>rows('SELECT count(*) n FROM tasks WHERE project_id=?',projectId)[0].n>beforeTasks,Boolean,'greeting task',60000);
    const task=rows('SELECT id,conversation_thread_id FROM tasks WHERE project_id=? ORDER BY rowid DESC LIMIT 1',projectId)[0];must(task.conversation_thread_id,'greeting thread');facts.ids.threadId=task.conversation_thread_id;
    await until(()=>agentBodies(task.conversation_thread_id).length>0,Boolean,'greeting answer',300000);facts.steps.push('hello sent in UI and answered in same thread');
    await shot('hello-answer');

    await route(`/project/${projectId}/room/${room.id}?thread=${task.conversation_thread_id}`,'.col-thread .composer-input');
    await send('请在同一工作目录读取 R87交付报告.docx 和 R87交付报告.pdf。逐项核对金额、日期、附件、验收人与发布风险，把发现写入 报告复核-v1.md。不要修改原报告；完成后说明文件路径和关键问题。',deepseek.id,'.col-thread');
    await waitFile('报告复核-v1.md',900000);facts.steps.push('same-thread DOCX/PDF review task produced 报告复核-v1.md');
    await until(()=>agentBodies(task.conversation_thread_id).length>=2,Boolean,'task answer',900000);
    await shot('deepseek-v1');

    await clickText('详情','.col-thread');await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("参与成员")'),Boolean,'details');
    await clickTextStarts('参与成员','.col-thread');await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("本串成员")'),Boolean,'thread members');
    const added=await cdp.eval(`(()=>{const rows=[...document.querySelectorAll('.row')];const r=rows.find(x=>(x.textContent??'').includes('Codex 复核'));const b=[...r?.querySelectorAll('button')??[]].find(x=>x.textContent.trim()==='添加到本串');if(!b||b.disabled)return false;b.click();return true})()`);must(added,'add Codex to thread');
    await until(async()=>{const snap=await cmd('thread.get',{threadId:task.conversation_thread_id});return snap.members?.memberIds?.includes(codex.id)===true;},Boolean,'Codex thread member',30000);
    facts.steps.push('Codex added to the existing thread through UI');

    await clickText('回复','.col-thread');await until(()=>cdp.eval('document.querySelector(".col-thread .composer-input")!=null'),Boolean,'thread composer');
    await send('现在请两位协作复核同一份报告：DeepSeek 把当前发现和文件路径交给 Codex；Codex 必须实际读取同一 DOCX/PDF，独立补充或纠正问题；最后由 DeepSeek 汇总更新 报告复核-v1.md。不要修改原报告，不要只给计划，完成后告诉我实际文件和结论。','all','.col-thread');
    await until(()=>{const c=calls();return c.some(x=>x.runtime_kind==='claude')&&c.some(x=>x.runtime_kind==='codex');},Boolean,'two distinct actual model calls',1200000);
    await until(()=>fs.existsSync(path.join(project,'报告复核-v1.md'))&&fs.readFileSync(path.join(project,'报告复核-v1.md'),'utf8').includes('36,500'),Boolean,'collaborative review content',1200000);
    facts.steps.push('@本串全体 with actual Claude/deepseek-flash and Codex/gpt-6-luna calls');await shot('two-model-collaboration');

    await send('请用一句话解释：为什么剩余预算应该是 36,500 元？',null,'.col-thread');
    await until(()=>{const b=agentBodies(task.conversation_thread_id);return b.some(x=>JSON.stringify(x.body).includes('36,500')||JSON.stringify(x.body).includes('36500'));},Boolean,'ordinary follow-up answer',600000);
    facts.steps.push('ordinary follow-up answered');

    await send('请根据刚才确认的问题，把复核结论修改为最终版：创建 报告复核-v2.md，必须写明 100,000 - 63,500 = 36,500，说明附件 预算明细.xlsx 缺失，指出 2026-10-17 与 2026-10-18 日期冲突，并建议先统一李晨/张岚的验收人再发布。完成后告诉我文件已生成。',deepseek.id,'.col-thread');
    await waitFile('报告复核-v2.md',900000);
    const v2=fs.readFileSync(path.join(project,'报告复核-v2.md'),'utf8');must(v2.includes('36,500')&&v2.includes('预算明细.xlsx')&&v2.includes('2026-10-18')&&v2.includes('李晨')&&v2.includes('张岚'),'v2 required facts');
    facts.steps.push('explicit v2 modification with exact required facts');await shot('v2-file');

    await clickText('详情','.col-thread');await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("交付与验收")'),Boolean,'delivery detail');
    await clickText('交付与验收','.col-thread');await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("确认完成")'),Boolean,'pending delivery UI',120000);
    must(await clickText('确认完成','.col-thread'),'accept v2');await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("确认完成")'),Boolean,'accept dialog');must(await clickText('确认完成','.col-thread'),'confirm v2 accept');
    await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("已验收")||document.querySelector(".col-thread").innerText.includes("已完成")'),Boolean,'v2 accepted',120000);
    facts.steps.push('v2 accepted through exact pending delivery UI');await shot('v2-accepted');

    facts.calls=calls();facts.modelCalls=facts.calls.length;facts.ok=true;saveFacts();
    console.log(JSON.stringify({ok:true,out,calls:facts.calls.map(c=>({runtime:c.runtime_kind,model:c.model,status:c.status})),steps:facts.steps},null,2));
  }catch(error){facts.error=error.stack??String(error);facts.calls=calls();facts.modelCalls=facts.calls.length;saveFacts();throw error;}
  finally{if(db){db.close();db=null;}cdp?.ws.close();}
})().catch(error=>{console.error(error.stack??error);process.exitCode=1;});
