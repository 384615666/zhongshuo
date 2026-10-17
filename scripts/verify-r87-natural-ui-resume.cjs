/** Continue the same R87 owned run after the initial same-thread v1 report.
 * This script only drives the visible UI and reads the owned run database. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const pkg=path.resolve(process.argv[2]);
const project=path.resolve(process.argv[3]);
const port=Number(process.argv[4]);
const out=path.resolve(process.argv[5]);
const saveAsDir=path.join(out,'saved');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const must=(v,m)=>{if(!v)throw Error(m);};
const q=JSON.stringify;
let cdp,db;
async function connect(){
  return until(async()=>{try{
    const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json());
    const p=rows.find(x=>x.type==='page'&&x.url.includes('index.html'));if(!p)return null;
    const ws=new WebSocket(p.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
    const c=new Cdp(ws);await c.send('Runtime.enable');await until(()=>c.eval('document.body?.classList.contains("hifi-on")'),Boolean,'hifi',30000);return c;
  }catch{return null;}},Boolean,'owned UI',30000);
}
async function cmd(method,params={}){const r=await cdp.eval(`window.zs.command(${q({protocolVersion:1,commandId:`r87-resume-${randomUUID()}`,method,params})})`);must(r.ok,`${method}: ${JSON.stringify(r.error)}`);return r.data;}
function row(sql,...a){return db.prepare(sql).get(...a);}
function rows(sql,...a){return db.prepare(sql).all(...a);}
async function setInput(selector,value){return cdp.eval(`(()=>{const e=document.querySelector(${q(selector)});if(!e)return false;const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);}
async function clickText(text,scope='body',starts=false){const match=starts?`x.textContent.trim().startsWith(${q(text)})`:`x.textContent.trim()===${q(text)}`;return cdp.eval(`(()=>{const root=document.querySelector(${q(scope)})??document;const b=[...root.querySelectorAll('button,a')].find(x=>${match});if(!b||b.disabled)return false;b.click();return true})()`);}
async function clickSelector(selector){return cdp.eval(`(()=>{const b=document.querySelector(${q(selector)});if(!b||b.disabled)return false;b.click();return true})()`);}
async function mention(kind,scope){
  must(await cdp.eval(`(()=>{const b=[...document.querySelectorAll(${q(scope+' button')})].find(x=>(x.title??'').includes('提及成员'));if(!b||b.disabled)return false;b.click();return true})()`),'mention button');
  await until(()=>cdp.eval(`document.querySelector(${q(scope+' .mention-pop')})!=null`),Boolean,'mention menu');
  if(kind==='all')must(await cdp.eval(`(()=>{const b=[...document.querySelectorAll(${q(scope+' .mention-pop .menu-item')})][0];if(!b)return false;b.click();return true})()`),'all mention');
  else must(await clickSelector(`${scope} [data-zs-mention-option="${kind}"]`),'member mention');
}
async function send(text,kind=null,scope='.col-thread'){
  if(kind!=null)await mention(kind,scope);
  must(await setInput(`${scope} .composer-input`,text),'composer');
  await sleep(150);must(await clickSelector(`${scope} .composer-send`),'send');
  await until(()=>cdp.eval(`document.querySelector(${q(scope+' .composer-input')})?.value.trim().length===0`),Boolean,'accepted send',30000);
}
async function waitFile(name,ms=900000){return until(()=>fs.existsSync(path.join(project,name)),Boolean,`file ${name}`,ms);}
async function shot(name){const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`${name}.png`),Buffer.from(s.data,'base64'));}
(async()=>{
  fs.mkdirSync(out,{recursive:true});fs.mkdirSync(saveAsDir,{recursive:true});
  cdp=await connect();db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true});
  const facts={format:'zhongshuo-r87-natural-ui-resume-v1',ok:false,pkg,project,out,steps:[],calls:[],at:new Date().toISOString()};
  const save=()=>fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(facts,null,2));
  try{
    const projectRow=row('SELECT id FROM projects ORDER BY rowid DESC LIMIT 1');const projectId=projectRow.id;
    const members=rows('SELECT id,display_name FROM project_members WHERE project_id=?',projectId);const deepseek=members.find(x=>x.display_name==='DeepSeek 审查');const codex=members.find(x=>x.display_name==='Codex 复核');must(deepseek&&codex,'members');
    const task=row('SELECT conversation_thread_id FROM tasks WHERE project_id=? ORDER BY rowid LIMIT 1',projectId);const threadId=task.conversation_thread_id;must(threadId,'thread');facts.ids={projectId,threadId,deepseekId:deepseek.id,codexId:codex.id};
    must(fs.existsSync(path.join(project,'报告复核-v1.md')),'v1 file');
    await clickText('详情','.col-thread');await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("参与成员")'),Boolean,'detail');
    must(await clickText('参与成员','.col-thread',true),'members group');await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("本串成员")'),Boolean,'members content');
    const added=await cdp.eval(`(()=>{const r=[...document.querySelectorAll('.col-thread .row')].find(x=>(x.textContent??'').includes('Codex 复核'));const b=[...r?.querySelectorAll('button')??[]].find(x=>x.textContent.trim()==='添加到本串');if(!b||b.disabled)return false;b.click();return true})()`);must(added,'add Codex');
    await until(async()=>{const t=await cmd('thread.get',{threadId});return t.members?.memberIds?.includes(codex.id)===true;},Boolean,'Codex in thread',30000);
    facts.steps.push('Codex added to same thread through UI');
    must(await clickText('回复','.col-thread',true),'reply tab');await until(()=>cdp.eval('document.querySelector(".col-thread .composer-input")!=null'),Boolean,'thread composer');
    await send('现在请两位协作复核同一份报告：DeepSeek 把当前发现和文件路径交给 Codex；Codex 必须实际读取同一 DOCX/PDF，独立补充或纠正问题；最后由 DeepSeek 汇总更新 报告复核-v1.md。不要修改原报告，不要只给计划，完成后告诉我实际文件和结论。','all','.col-thread');
    await until(()=>rows('SELECT id FROM real_calls').length>0,Boolean,'calls');
    await until(()=>{const c=rows('SELECT runtime_kind,status FROM real_calls');return c.some(x=>x.runtime_kind==='claude')&&c.some(x=>x.runtime_kind==='codex');},Boolean,'two distinct models',1200000);
    await until(()=>fs.existsSync(path.join(project,'报告复核-v1.md'))&&fs.readFileSync(path.join(project,'报告复核-v1.md'),'utf8').includes('36,500'),Boolean,'collaborative v1',1200000);
    facts.steps.push('@本串全体 produced actual Claude/deepseek-flash + Codex/gpt-6-luna calls');await shot('two-model-collaboration');
    await send('请用一句话解释：为什么剩余预算应该是 36,500 元？',null,'.col-thread');
    await until(()=>{const b=rows('SELECT body_json FROM messages WHERE thread_id=? ORDER BY conversation_seq',threadId);return b.slice(-6).some(x=>(x.body_json??'').includes('36,500')||(x.body_json??'').includes('36500'));},Boolean,'ordinary follow-up',600000);
    facts.steps.push('ordinary follow-up answered');
    await send('请根据刚才确认的问题，把复核结论修改为最终版：创建 报告复核-v2.md，必须写明 100,000 - 63,500 = 36,500，说明附件 预算明细.xlsx 缺失，指出 2026-10-17 与 2026-10-18 日期冲突，并建议先统一李晨/张岚的验收人再发布。完成后告诉我文件已生成。',deepseek.id,'.col-thread');
    await waitFile('报告复核-v2.md',900000);const v2=fs.readFileSync(path.join(project,'报告复核-v2.md'),'utf8');
    must(v2.includes('36,500')&&v2.includes('预算明细.xlsx')&&v2.includes('2026-10-18')&&v2.includes('李晨')&&v2.includes('张岚'),'v2 facts');facts.steps.push('explicit v2 modification with required facts');await shot('v2-file');
    await clickText('详情','.col-thread');await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("交付与验收")'),Boolean,'delivery');
    must(await clickText('交付与验收','.col-thread',true),'delivery group');
    await until(()=>cdp.eval('document.querySelector(".col-thread").innerText.includes("确认完成")||document.querySelector(".col-thread").innerText.includes("验收通过")'),Boolean,'pending v2',120000);
    const accept=await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.col-thread button')].find(x=>x.textContent.trim()==='确认完成'||x.textContent.trim()==='验收通过');if(!b||b.disabled)return false;b.click();return true})()`);must(accept,'accept click');
    await until(()=>cdp.eval(`(()=>{const bs=[...document.querySelectorAll('.col-thread button')].filter(x=>x.textContent.trim()==='确认完成'||x.textContent.trim()==='验收通过');return bs.length>=2})()`),Boolean,'accept confirmation',10000);
    const confirm=await cdp.eval(`(()=>{const bs=[...document.querySelectorAll('.col-thread button')].filter(x=>x.textContent.trim()==='确认完成'||x.textContent.trim()==='验收通过');const b=bs[bs.length-1];if(!b||b.disabled)return false;b.click();return true})()`);must(confirm,'confirm click');
    await until(()=>{const d=row('SELECT review_status FROM task_deliveries ORDER BY rowid DESC LIMIT 1');return d?.review_status==='accepted';},Boolean,'v2 accepted',120000);
    facts.steps.push('v2 accepted through pending delivery UI');await shot('v2-accepted');
    facts.calls=rows('SELECT runtime_kind,model,status,response_model FROM real_calls ORDER BY rowid');facts.ok=true;save();
    console.log(JSON.stringify({ok:true,out,calls:facts.calls,steps:facts.steps},null,2));
  }catch(error){facts.error=error.stack??String(error);facts.calls=rows('SELECT runtime_kind,model,status,response_model FROM real_calls ORDER BY rowid');save();throw error;}
  finally{db.close();cdp?.ws.close();}
})().catch(e=>{console.error(e.stack??e);process.exitCode=1;});
