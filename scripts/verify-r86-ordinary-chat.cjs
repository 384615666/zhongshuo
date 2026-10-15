/* eslint-disable @typescript-eslint/no-require-imports */
/* global require,process,WebSocket,fetch,console,__dirname */
// Read-only proof after two separately performed native UI sends. No dispatch.
const fs=require('node:fs'),path=require('node:path'),D=require('better-sqlite3');
const {Cdp}=require('./verify-r81-members-launcher.cjs'),{ownedEvidenceRoot}=require('./lib/r86-native-evidence.cjs');
const own=path.resolve(process.argv[2]??'');if(!ownedEvidenceRoot(own,path.resolve(__dirname,'../dist')))throw Error('owned engineering root required');
const label=process.argv.find(x=>x.startsWith('--label='))?.slice(8);
if(label&&!/^[-a-z0-9]+$/.test(label))throw Error('safe observation label required');
const file=path.join(own,label?`ordinary-chat-${label}.json`:'ordinary-chat.json');if(fs.existsSync(file))throw Error('original observation retained');
const p=JSON.parse(fs.readFileSync(path.join(own,'progress.json'))),d=new D(path.join(p.dataRoot,'state.sqlite'),{readonly:true}),r={pass:false,build:p.build,scope:'native default no-mention greeting then same-thread natural follow-up; read-only engineering observation'};let c;
const must=(v,m)=>{if(!v)throw Error(m);};
(async()=>{try{
 const roots=d.prepare("SELECT * FROM messages WHERE project_id=? AND author_type='human' AND thread_id IS NULL ORDER BY conversation_seq").all(p.ids.projectId).filter(m=>JSON.parse(m.body_json).text==='你好');must(roots.length===1,'exact one original greeting required');
 const root=roots[0],task=d.prepare('SELECT * FROM tasks WHERE root_message_id=?').get(root.id);must(task,'formal greeting task identity missing');
 const messages=d.prepare('SELECT id,author_type,author_id,body_json,thread_id FROM messages WHERE task_id=? ORDER BY conversation_seq').all(task.id);
 const follow=messages.filter(m=>m.author_type==='human'&&JSON.parse(m.body_json).text==='我刚才说了什么？');must(follow.length===1&&follow[0].thread_id===task.conversation_thread_id,'follow-up not in original thread');
 const replies=messages.filter(m=>m.author_type==='agent').map(m=>({id:m.id,authorId:m.author_id,...JSON.parse(m.body_json)}));must(replies.length===2,'exactly two actual natural replies required');
 must(replies.every(m=>m.text?.trim()&&!/"schemaVersion"\s*:\s*"task-complete-v1"/.test(m.text)),'control protocol leaked into ordinary replies');
 must(replies.every(m=>m.authorId===p.ids.claude)&&replies[1].text.includes('你好'),'same member / remembered greeting missing');
 r.childTasks=d.prepare('SELECT count(*) n FROM tasks WHERE parent_task_id=?').get(task.id).n;r.deliveries=d.prepare('SELECT count(*) n FROM task_deliveries WHERE task_id=?').get(task.id).n;must(r.childTasks===0&&r.deliveries===0,'ordinary chat became delegated work or delivery');
 r.turns=d.prepare('SELECT a.id,a.status,a.member_id,a.session_id,s.provider_session_id FROM agent_turns a JOIN workflow_runs w ON w.id=a.run_id LEFT JOIN runtime_sessions s ON s.id=a.session_id WHERE w.task_id=? ORDER BY a.rowid').all(task.id);must(r.turns.length===2&&r.turns.every(t=>t.status==='SUCCEEDED'&&t.member_id===p.ids.claude),'two successful original member turns required');
 const bundles=r.turns.map(t=>JSON.parse(d.prepare('SELECT included_refs_json FROM context_bundles WHERE turn_id=?').get(t.id).included_refs_json));
 // Room turns have isolated runtime sessions by existing contract. The first
 // AUTO planning turn is readonly; the follow-up uses the configured work
 // policy. Never require reuse across this real permission boundary.
 const digest=bundles[1].threadDigest;r.historyReplay=digest?.rootMessageId===root.id&&digest.rootText==='你好'&&digest.messages.some(m=>m.text==='我刚才说了什么？')&&digest.messages.some(m=>m.author===p.ids.claude);
 must(r.historyReplay,'actual follow-up input lost original thread history');
 r.runtimeSessionsReused=r.turns[0].session_id===r.turns[1].session_id;r.actualPolicies=bundles.map(b=>b.permission.policyId);
 r.sessionExplanation='Existing room contract opens isolated runtime sessions and replays bounded thread history; initial AUTO planning is readonly, follow-up follows the configured work permission. Same conversation does not mean reuse across a permission boundary.';
 const page=(await fetch(`http://127.0.0.1:${p.port}/json/list`).then(x=>x.json())).find(x=>x.type==='page'&&x.url.includes('index.html'));const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(a=>ws.addEventListener('open',a,{once:true}));c=new Cdp(ws);
 r.view=await c.eval('({hash:location.hash,text:document.querySelector(".col-thread")?.innerText??document.body.innerText})');must(r.view.hash.includes(task.conversation_thread_id)&&r.view.text.includes('你好')&&r.view.text.includes('我刚才说了什么')&&!/"schemaVersion"\s*:\s*"task-complete-v1"/.test(r.view.text),'actual original thread is incomplete or leaks control JSON');
 r.taskId=task.id;r.rootMessageId=root.id;r.threadId=task.conversation_thread_id;r.replies=replies.map(m=>({id:m.id,authorId:m.authorId,text:m.text}));r.originalRootPreserved=d.prepare('SELECT body_json FROM messages WHERE id=?').get(root.id).body_json===root.body_json;r.pass=r.originalRootPreserved;
 }catch(e){r.error=e.stack;process.exitCode=1;}finally{c?.ws.close();d.close();fs.writeFileSync(file,JSON.stringify(r,null,2));console.log(JSON.stringify({pass:r.pass,error:r.error}));}})();
