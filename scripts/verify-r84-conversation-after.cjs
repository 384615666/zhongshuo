/* global require,process,WebSocket,fetch,console,setTimeout,Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- owned launcher, normal UI, synthetic inputs */
const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');
const out=path.resolve(process.argv[2]),progress=path.join(out,'progress.json'),main=JSON.parse(fs.readFileSync(progress,'utf8'));
const file=path.join(out,'ordinary-followup-after.json');
if(fs.existsSync(file))throw Error('Original purposes already recorded; inspect identities, never automatically resubmit');
const task=main.natural['plain-你好'],q=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const result={pass:false,build:main.build,taskId:task.id,threadId:task.conversation_thread_id,steps:[]};
let c,db;const save=()=>fs.writeFileSync(file,JSON.stringify(result,null,2));save();
const must=(v,why)=>{if(!v)throw Error(why);};
async function input(text){await c.eval(`(()=>{const e=document.querySelector('textarea.composer-input');if(!e)throw Error('composer unavailable');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${q(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);}
async function click(sel){must(await c.eval(`(()=>{const e=document.querySelector(${q(sel)});if(!e||e.disabled)return false;e.click();return true})()`),'enabled '+sel);}
(async()=>{try{
  const page=(await fetch(`http://127.0.0.1:${main.port}/json/list`).then(r=>r.json())).find(p=>p.type==='page'&&p.url.includes('index.html'));
  const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));c=new Cdp(ws);db=new Database(path.join(main.dataRoot,'state.sqlite'),{readonly:true});
  must(db.prepare("SELECT count(*) n FROM real_calls WHERE status='inflight'").get().n===0,'No competing original request');
  await c.eval(`location.hash=${q('/thread/'+task.conversation_thread_id)};true`);await until(()=>c.eval('document.querySelector("textarea.composer-input")!=null'),Boolean,'original thread composer');
  const initialRuns=db.prepare('SELECT count(*) n FROM workflow_runs WHERE task_id=?').get(task.id).n;
  for(const text of ['你刚才怎么回答我的问候的？','这是我们这段对话的第几次提问？请结合前面两次，简短回答。']){
    const before=db.prepare('SELECT max(rowid) n FROM messages').get().n;
    result.pending={text,before,at:new Date().toISOString()};save();
    await input(text);await until(()=>c.eval('document.querySelector("button.composer-send:not([disabled])")!=null'),Boolean,'ordinary send enabled');await click('button.composer-send');
    const message=await until(()=>db.prepare("SELECT id,task_id,thread_id FROM messages WHERE rowid>? AND author_type='human' ORDER BY rowid LIMIT 1").get(before),Boolean,'original human receipt');
    result.pending.message=message;save();must(message.task_id===task.id&&message.thread_id===task.conversation_thread_id,'same entity');
    const request=await until(()=>db.prepare('SELECT * FROM conversation_reply_requests WHERE message_id=?').get(message.id),Boolean,'durable original intent');
    result.pending.request={messageId:request.message_id,dispatchKey:request.dispatch_key,memberId:request.member_id};save();
    await until(()=>{const row=db.prepare('SELECT status,error_message FROM conversation_reply_requests WHERE message_id=?').get(message.id);if(['unknown','failed','blocked','cancelled'].includes(row.status))throw Error(JSON.stringify(row));return row.status;},v=>v==='succeeded','ordinary AI answer',360000);
    const finished=db.prepare('SELECT * FROM conversation_reply_requests WHERE message_id=?').get(message.id);
    const bundle=JSON.parse(db.prepare('SELECT included_refs_json FROM context_bundles WHERE turn_id=?').get(finished.turn_id).included_refs_json);
    must(bundle.task.objective===text&&bundle.threadDigest.rootText==='你好','natural fixed context');
    const answer=JSON.parse(db.prepare("SELECT body_json FROM messages WHERE task_id=? AND author_type='agent' ORDER BY rowid DESC LIMIT 1").get(task.id).body_json).text;
    must(answer.trim()&&!answer.includes('"schemaVersion"'),'readable answer');
    result.steps.push({text,messageId:message.id,runId:finished.run_id,turnId:finished.turn_id,memberId:finished.member_id,answer,context:bundle.threadDigest});delete result.pending;save();
  }
  must(db.prepare('SELECT count(*) n FROM workflow_runs WHERE task_id=?').get(task.id).n===initialRuns+2,'exactly two new turns');
  must(db.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(task.id).n===0,'No fake chat delivery');
  const beforeCalls=db.prepare('SELECT count(*) n FROM real_calls').get().n,beforeRuns=db.prepare('SELECT count(*) n FROM workflow_runs').get().n;
  await input('这条仅作本地记录，不请求回答。');await click('button[title="本次运行设置：本次执行方式、预算推导与说明"]');
  must(await c.eval("(()=>{const e=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('仅记录，不请求回复'));e?.click();return !!e})()"),'explicit local record action');
  await click('button.composer-send');await sleep(6000);
  must(db.prepare('SELECT count(*) n FROM real_calls').get().n===beforeCalls&&db.prepare('SELECT count(*) n FROM workflow_runs').get().n===beforeRuns,'record-only zero dispatch');
  result.recordOnly=true;result.messages=db.prepare('SELECT id,author_type,body_json,thread_message_seq FROM messages WHERE thread_id=? ORDER BY thread_message_seq').all(task.conversation_thread_id);
  must(result.steps.every(s=>s.memberId===main.ids.memberId),'original member');
  const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'ordinary-followup-after.png'),Buffer.from(shot.data,'base64'));result.pass=true;
}catch(e){result.error=e.stack;process.exitCode=1;}finally{
  if(db){main.calls=db.prepare('SELECT id,runtime_kind,model,response_model,status,turn_id,task_id FROM real_calls ORDER BY id').all();fs.writeFileSync(progress,JSON.stringify(main,null,2));db.close();}save();c?.ws.close();console.log(JSON.stringify({pass:result.pass,steps:result.steps.length,recordOnly:result.recordOnly,error:result.error}));
}})();
