/* Complete the mixed-model v2 modification and exact acceptance when the
 * primary natural harness stops after Codex's detailed result. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef, no-empty */
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');

const pkg=path.resolve(process.argv[2]);
const project=path.resolve(process.argv[3]);
const port=Number(process.argv[4]);
const out=path.resolve(process.argv[5]);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const q=JSON.stringify;
const must=(value,label)=>{if(!value)throw Error(label);};
let cdp;

async function connect(){
  return until(async()=>{try{
    const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(response=>response.json());
    const page=rows.find(row=>row.type==='page'&&row.url.includes('index.html'));if(page==null)return null;
    const ws=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    const value=new Cdp(ws);await value.send('Runtime.enable');
    await until(()=>value.eval('document.body?.classList.contains("hifi-on")'),Boolean,'app ready',30000);
    return value;
  }catch{return null;}},Boolean,'owned app',30000);
}
function rows(sql,...args){
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  try{return db.prepare(sql).all(...args);}finally{db.close();}
}
function row(sql,...args){
  const db=new Database(path.join(pkg,'server-data','state.sqlite'),{readonly:true,fileMustExist:true});
  try{return db.prepare(sql).get(...args)??null;}finally{db.close();}
}
async function setInput(selector,value){
  return cdp.eval(`(()=>{const input=document.querySelector(${q(selector)});if(!input)return false;const proto=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(input,${q(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
}
function findingFor(raw){
  if(/FontDescriptor|FontFile|ZS-Custom|Identity-H/.test(raw)&&/(未嵌入|字体程序未嵌入|FontFile.{0,30}(缺失|不存在|没有))/.test(raw)&&/PDF|pdf/.test(raw))
    return{key:'font',text:'PDF 字体未嵌入，需在发布前嵌入并实际渲染确认'};
  if(/DOCX|docx/.test(raw)&&/(4\s*行|4\s*[×xX*]\s*3|四行)/.test(raw)&&/PDF|pdf/.test(raw)
    &&/(无表格|没有表格|缺表|无该表|没有该表|未出现.{0,20}表格|不含.{0,20}表格)/.test(raw))
    return{key:'table',text:'DOCX 与 PDF 的进度表/内容不一致，需统一唯一发布版本'};
  if(/(docProps|\/Metadata|XMP|元数据)/.test(raw)&&/(DOCX|docx|PDF|pdf|两份)/.test(raw))
    return{key:'metadata',text:'两份文档缺少可追溯元数据，需补齐版本与作者信息'};
  return null;
}

(async()=>{
  fs.mkdirSync(out,{recursive:true});
  cdp=await connect();
  const projectRow=row('SELECT id FROM projects ORDER BY rowid LIMIT 1');
  const members=rows('SELECT id,display_name FROM project_members WHERE project_id=?',projectRow.id);
  const deepseek=members.find(member=>member.display_name==='DeepSeek 审查');
  const codex=members.find(member=>member.display_name==='Codex GLM 复核');
  must(projectRow&&deepseek&&codex,'project members');
  const task=row("SELECT id,conversation_thread_id,status,current_delivery_id FROM tasks WHERE project_id=? AND parent_task_id IS NULL ORDER BY rowid LIMIT 1",projectRow.id);
  must(task?.conversation_thread_id,'root task');

  await until(()=>{
    const calls=rows('SELECT runtime_kind,model,member_id,status,task_id,turn_id FROM real_calls');
    return calls.some(call=>call.runtime_kind==='codex'&&call.member_id===codex.id&&call.model==='ccs-new/glm-5.3-flash'&&call.status==='succeeded')
      &&!calls.some(call=>call.status==='inflight');
  },Boolean,'Codex and coordination calls terminal',900000);

  const codexTask=row("SELECT id FROM tasks WHERE owner_member_id=? AND conversation_thread_id=? ORDER BY rowid DESC LIMIT 1",codex.id,task.conversation_thread_id);
  must(codexTask,'Codex child task');
  const codexFinal=row("SELECT id,body_json,created_at FROM messages WHERE task_id=? AND author_id=? AND status='final' ORDER BY rowid DESC LIMIT 1",codexTask.id,codex.id);
  must(codexFinal,'Codex final message');
  const finding=findingFor(codexFinal.body_json);
  must(finding,'exact Codex finding');

  const existing=path.join(project,'报告复核-v2.md');
  const oldHash=fs.existsSync(existing)?sha(existing):null;
  let requestMessage=null,v2;
  if(!fs.existsSync(existing)||!fs.readFileSync(existing,'utf8').includes('36,500')||!/Codex/i.test(fs.readFileSync(existing,'utf8'))){
    const room=row('SELECT id FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1',projectRow.id);
    await cdp.eval(`location.hash='#/project/${projectRow.id}/room/${room.id}?thread=${task.conversation_thread_id}';true`);
    await until(()=>cdp.eval('document.querySelector(".col-thread .composer-input")!=null'),Boolean,'thread composer',30000);
    const prompt=`请根据刚才确认的问题，把复核结论修改为最终版：创建 报告复核-v2.md，必须写明 100,000 - 63,500 = 36,500，说明附件 预算明细.xlsx 缺失，指出 2026-10-17 与 2026-10-18 日期冲突，建议先统一李晨/张岚的验收人再发布，并纳入 Codex 独立发现：${finding.text}。完成后告诉我文件已生成。`;
    const humanBefore=rows('SELECT id FROM messages WHERE thread_id=? AND author_type=?',task.conversation_thread_id,'human').length;
    must(await setInput('.col-thread .composer-input',prompt),'v2 prompt');
    await sleep(200);
    must(await cdp.eval(`(()=>{const button=document.querySelector('.col-thread .composer-send');if(!button||button.disabled)return false;button.click();return true})()`),'v2 send');
    await until(()=>cdp.eval('document.querySelector(".col-thread .composer-input")?.value.trim().length===0'),Boolean,'v2 accepted into queue',30000);
    await until(()=>rows('SELECT id FROM messages WHERE thread_id=? AND author_type=?',task.conversation_thread_id,'human').length>humanBefore,Boolean,'v2 human message persisted',30000);
    requestMessage=rows("SELECT id,body_json FROM messages WHERE thread_id=? AND author_type='human' ORDER BY rowid DESC LIMIT 1",task.conversation_thread_id)[0]??null;
    must(requestMessage?.body_json.includes(finding.text),'v2 request contains selected finding');
    await until(()=>fs.existsSync(existing)&&sha(existing)!==oldHash,Boolean,'v2 changed',900000);
    v2=fs.readFileSync(existing,'utf8');
    must(v2.includes('36,500')&&v2.includes('预算明细.xlsx')&&v2.includes('2026-10-18')&&v2.includes('李晨')&&v2.includes('张岚')&&/Codex/i.test(v2),'v2 facts');
  }
  v2=fs.readFileSync(existing,'utf8');
  const findingPattern={
    font:/字体|嵌入/.test(v2)&&/(未嵌入|缺失|FontFile)/.test(v2),
    table:/(DOCX|docx)/.test(v2)&&/(PDF|pdf)/.test(v2)&&/(进度表|表格)/.test(v2)&&/(不一致|缺失|没有|无)/.test(v2),
    metadata:/元数据|docProps|Metadata|XMP|版本/.test(v2),
  };
  must(findingPattern[finding.key],'v2 includes selected Codex finding');

  const pending=row("SELECT id,task_id,run_id,revision,manifest_hash,review_status FROM task_deliveries WHERE task_id=? AND review_status='pending' ORDER BY revision DESC LIMIT 1",task.id);
  if(pending!=null){
    await cdp.eval(`location.hash='#/project/${projectRow.id}/room/${row('SELECT id FROM rooms WHERE project_id=? ORDER BY rowid LIMIT 1',projectRow.id).id}?thread=${task.conversation_thread_id}&tab=delivery';true`);
    await until(()=>cdp.eval('document.querySelector(".col-thread")?.innerText.includes("交付与验收")'),Boolean,'delivery detail',30000);
    await cdp.eval(`(()=>{const button=[...document.querySelectorAll('.col-thread button')].find(item=>item.textContent.trim()==='交付与验收');if(button)button.click();return true})()`);
    await until(()=>cdp.eval('document.querySelector(".col-thread")?.innerText.includes("确认完成")'),Boolean,'pending delivery UI',60000);
    must(await cdp.eval(`(()=>{const button=[...document.querySelectorAll('.col-thread button')].find(item=>item.textContent.trim()==='确认完成'&&!item.disabled&&item.getBoundingClientRect().width>0);if(!button)return false;button.click();return true})()`),'accept pending');
    await until(()=>cdp.eval(`(()=>{const buttons=[...document.querySelectorAll('.col-thread button')].filter(item=>(item.textContent.trim()==='确认完成'||item.textContent.trim()==='验收通过')&&!item.disabled&&item.getBoundingClientRect().width>0);return buttons.length>=1})()`),Boolean,'accept confirmation',10000);
    must(await cdp.eval(`(()=>{const buttons=[...document.querySelectorAll('.col-thread button')].filter(item=>(item.textContent.trim()==='确认完成'||item.textContent.trim()==='验收通过')&&!item.disabled&&item.getBoundingClientRect().width>0);const button=buttons[buttons.length-1];if(!button)return false;button.click();return true})()`),'confirm pending');
    await until(()=>row('SELECT review_status FROM task_deliveries WHERE id=?',pending.id)?.review_status==='accepted',Boolean,'exact delivery accepted',120000);
  }

  const accepted=row("SELECT id,task_id,run_id,revision,manifest_hash,review_status FROM task_deliveries WHERE task_id=? AND review_status='accepted' ORDER BY revision DESC LIMIT 1",task.id);
  must(accepted?.review_status==='accepted','final accepted delivery');
  const requestMessageFinal=requestMessage??row("SELECT id,body_json FROM messages WHERE thread_id=? AND author_type='human' AND body_json LIKE ? ORDER BY rowid DESC LIMIT 1",task.conversation_thread_id,'%报告复核-v2.md%');
  const request=requestMessageFinal==null?null:row('SELECT message_id,status,run_id,turn_id,member_id,thread_id FROM thread_reply_requests WHERE message_id=?',requestMessageFinal.id);
  const result={
    format:'zhongshuo-r87-mixed-v2-accept-v1',
    ok:true,
    package:pkg,
    build:JSON.parse(fs.readFileSync(path.join(pkg,'ZhongshuoDual','BUILD.json'),'utf8')),
    project,
    ids:{projectId:projectRow.id,taskId:task.id,threadId:task.conversation_thread_id,deepseekId:deepseek.id,codexId:codex.id},
    codex:{taskId:codexTask.id,messageId:codexFinal.id,finding},
    request,
    delivery:accepted,
    file:{name:'报告复核-v2.md',bytes:fs.statSync(existing).size,sha256:sha(existing)},
    previousHash:oldHash,
    checks:{
      exactModels:rows("SELECT runtime_kind,model,member_id,status FROM real_calls WHERE status='succeeded'").some(call=>call.runtime_kind==='codex'&&call.member_id===codex.id&&call.model==='ccs-new/glm-5.3-flash')
        &&rows("SELECT runtime_kind,model,member_id,status FROM real_calls WHERE status='succeeded'").some(call=>call.runtime_kind==='claude'&&call.member_id===deepseek.id&&call.model==='deepseek-flash'),
      acceptedLatest:accepted.task_id===task.id&&request?.status==='succeeded'&&request.run_id===accepted.run_id&&request.member_id===deepseek.id,
      v2Binding:findingPattern[finding.key]&&/Codex/i.test(v2),
    },
    at:new Date().toISOString(),
  };
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),'utf8');
  console.log(JSON.stringify({ok:result.ok,evidence:path.join(out,'result.json'),checks:result.checks,delivery:accepted},null,2));
  if(!result.ok)process.exitCode=1;
})().catch(error=>{
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({format:'zhongshuo-r87-mixed-v2-accept-v1',ok:false,error:error.stack??String(error),at:new Date().toISOString()},null,2),'utf8');
  console.error(error.stack??error);
  process.exitCode=1;
}).finally(()=>{try{cdp?.ws.close();}catch{}});
