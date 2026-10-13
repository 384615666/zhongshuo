/* global require, __dirname, process, WebSocket, setTimeout, clearTimeout, fetch, console, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS release fixture */
/* R81: actual daily BAT in an owned copy, formal commands, DOM interactions, database receipts. */
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const repo=path.resolve(__dirname,'..');
const src=path.resolve(process.argv[2]??path.join(repo,'dist/desktop/desktop-daily-win-v20'));
const before=process.argv.includes('--before');
const out=path.resolve(process.argv[3]??path.join(repo,'dist/desktop',`review-r81-${before?'before':'members'}-${Date.now()}`));
const copy=path.join(out,'copy');const port=9791;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const must=(ok,label)=>{if(!ok)throw Error(label);};
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
class Cdp{
  constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();this.errors=[];ws.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.id&&this.pending.has(d.id)){const p=this.pending.get(d.id);this.pending.delete(d.id);clearTimeout(p.timer);d.error?p.reject(Error(d.error.message)):p.resolve(d.result);}if(d.method==='Runtime.consoleAPICalled'&&d.params.type==='error')this.errors.push(d.params.args.map(a=>a.value??a.description??'').join(' '));if(d.method==='Runtime.exceptionThrown')this.errors.push(d.params.exceptionDetails.exception?.description??d.params.exceptionDetails.text);});}
  send(method,params={}){const id=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout '+method));},30000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;}
  async shot(name){const r=await this.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));}
}
async function until(fn,ok,label,ms=45000){const at=Date.now();for(;;){const v=await fn();if(ok(v))return v;if(Date.now()-at>ms)throw Error(`timeout ${label}: ${JSON.stringify(v)?.slice(0,180)}`);await sleep(250);}}
async function connect(){return until(async()=>{try{const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)}).then(r=>r.json());const t=rows.find(t=>t.type==='page'&&t.url.includes('index.html'));if(!t)return null;const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});const c=new Cdp(ws);await c.send('Runtime.enable');return c;}catch{return null;}},Boolean,'owned BAT window',90000);}
const q=s=>JSON.stringify(s);
let cdp=null,bat=null;const sessions=[];
function start(){const env={...process.env,ZS_DEV25_DEBUG_PORT:String(port)};for(const k of ['ELECTRON_RUN_AS_NODE','ZS_APP_DATA','ZS_RUNTIME','ZS_ALLOW_FAKE','ZS_REAL_DISPATCH_GUARD','ZS_DAEMON_ENTRY','ZS_R78_ENGINEERING_TOKEN'])delete env[k];bat=spawn('cmd',['/c','start-desktop.bat'],{cwd:copy,env,windowsHide:true,stdio:['ignore','pipe','pipe']});for(const stream of [bat.stdout,bat.stderr])stream.on('data',b=>fs.appendFileSync(path.join(out,'launcher.log'),b));}
async function stop(){if(cdp){sessions.push(cdp.errors);try{await Promise.race([cdp.eval('window.close();true'),sleep(2500)]);}catch{ /* Own window may already have closed. */ }cdp.ws.close();cdp=null;}await until(async()=>!fs.existsSync(path.join(copy,'server-data','daemon.pid')),Boolean,'own daemon closed',30000);}
async function raw(method,params,commandId=`r81-ui-${randomUUID()}`){return cdp.eval(`window.zs.command(${q({protocolVersion:1,commandId,method,params})})`);}
async function cmd(method,params){const r=await raw(method,params);must(r.ok,`${method}: ${JSON.stringify(r.error)}`);return r.data;}
async function route(hash,selector){await cdp.eval(`location.hash=${q(hash)};true`);await until(()=>cdp.eval(`document.querySelector(${q(selector)})!=null`),Boolean,hash);await sleep(500);}
async function click(selector){must(await cdp.eval(`(()=>{const b=document.querySelector(${q(selector)});if(!b||b.disabled)return false;b.click();return true})()`),'missing enabled button '+selector);}
async function setInput(selector,value){await cdp.eval(`(()=>{const e=document.querySelector(${q(selector)});if(!e)throw Error('input missing');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${q(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);}
async function closeModal(){await cdp.eval(`(()=>{const b=[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='取消');b?.click();return true})()`);await until(()=>cdp.eval(`document.querySelector('.modal')==null`),Boolean,'modal close');}
async function modalDone(){await until(()=>cdp.eval(`document.querySelector('.modal')==null`),Boolean,'successful formal write and readback');}
async function viewport(width,height,dpr){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:dpr,mobile:false});await cdp.eval(`document.documentElement.dataset.theme='light';true`);await sleep(300);}
function manifest(root){const base=path.join(root,'ZhongshuoDual');const m=JSON.parse(fs.readFileSync(path.join(base,'MANIFEST-SHA256.json'),'utf8'));const entries=Array.isArray(m)?m:m.files;let n=0;for(const row of entries){const file=path.join(base,row.path);must(fs.statSync(file).size===row.bytes&&sha(file)===row.sha256,'manifest '+row.path);n++;}return n;}
(async()=>{
  const probe=require('node:net').createServer();await new Promise((r,j)=>{probe.once('error',j);probe.listen(port,'127.0.0.1',r);});await new Promise(r=>probe.close(r));
  fs.mkdirSync(out,{recursive:true});fs.cpSync(src,copy,{recursive:true});
  const build=JSON.parse(fs.readFileSync(path.join(copy,'ZhongshuoDual','BUILD.json'),'utf8'));
  const facts={pass:false,before,build,source:src,copy,manifestSource:manifest(src),manifestCopy:manifest(copy),launcherSha:sha(path.join(copy,'start-desktop.bat')),steps:[],screenshots:[],realCalls:null};
  const project=path.join(out,'工程甲'),projectB=path.join(out,'工程乙');fs.mkdirSync(project);fs.mkdirSync(projectB);fs.writeFileSync(path.join(project,'工程原件.md'),'# 独立工程原件\n');
  try{
    start();cdp=await connect();await until(()=>cdp.eval(`document.body?.classList.contains('hifi-on')`),Boolean,'hifi boot');
    const identity=await cmd('app.identity',{});must(path.resolve(identity.appDataDir)===path.resolve(copy,'server-data'),'independent root identity');
    const p=(await cmd('project.open',{path:project,displayName:'工程甲'})).project.id;
    const b=(await cmd('project.open',{path:projectB,displayName:'工程乙'})).project.id;
    const member=(await cmd('member.create',{projectId:p,displayName:'实现者',description:'实现与重构'})).memberId;
    const executable=path.join(out,'未安装程序.exe');await cmd('member.setRuntime',{memberId:member,kind:'codex',model:'gpt-6-luna',executable,permissionMode:'plan'});
    const second=(await cmd('member.create',{projectId:p,displayName:'实现者',description:'同名独立成员'})).memberId;
    for(const n of ['审查者','研究者'])await cmd('member.create',{projectId:p,displayName:n,description:'独立工程成员'});
    await cdp.send('Page.reload');await until(()=>cdp.eval(`document.body?.classList.contains('hifi-on')`),Boolean,'reload hifi');
    await route(`/project/${p}/members`,'[data-zs-members]');
    const getMember=async()=>(await cmd('member.list',{projectId:p})).items.find(m=>m.id===member);
    if(before){await route(`/project/${p}/member/${member}`,'[data-zs-member-detail]');await until(()=>cdp.eval(`document.querySelector('[data-zs-member-detail] input')!=null`),Boolean,'baseline display name');facts.readonly=await cdp.eval(`document.querySelector('[data-zs-member-detail] input').disabled`);facts.metadata=(await raw('member.update',{projectId:p,memberId:member,expectedRevision:1,displayName:'基线缺口',description:''})).error;facts.templates=(await raw('memberTemplate.list',{})).error;must(facts.readonly&&facts.metadata.code==='VALIDATION_INVALID'&&facts.templates.code==='VALIDATION_INVALID','v19 missing contracts');await cdp.shot('before-member-readonly');facts.steps.push('v19 readonly metadata and unknown template command independently reproduced');}
    else{
      await until(()=>cdp.eval(`document.querySelector(${q(`[data-zs-member-edit="${member}"]`)})!=null`),Boolean,'member card loaded');
      await click(`[data-zs-member-edit="${member}"]`);await setInput('[data-zs-member-name]','改名实现者');await setInput('[data-zs-member-description]','中文说明 · 执行职责');
      await cdp.eval(`(()=>{const b=document.querySelector(${q(`[data-zs-member-edit-save="${member}"]`)});b.click();b.click();return true})()`);await modalDone();
      must((await getMember()).displayName==='改名实现者','rename readback');facts.steps.push('UI rename/description and double-click single formal CAS write');
      await setInput('[data-zs-member-search]','中文说明');must(await cdp.eval(`document.querySelectorAll('[data-zs-member-card]').length===1`),'description search identity');await setInput('[data-zs-member-search]','');
      const short=await cdp.eval(`document.querySelector(${q(`[data-zs-member-card="${member}"] .mono-sm`)})?.textContent.replace('#','').trim()`);await setInput('[data-zs-member-search]',short);must(await cdp.eval(`document.querySelectorAll('[data-zs-member-card]').length===1`),'short ID search');await setInput('[data-zs-member-search]','');
      await click(`[data-zs-member-template="${member}"]`);await setInput('[data-zs-template-name]','工程配置模板');await click('[data-zs-template-save]');await modalDone();
      const t=(await cmd('memberTemplate.list',{})).items.find(t=>t.name==='工程配置模板');must(t,'template saved');facts.templateId=t.id;
      await until(()=>cdp.eval(`document.querySelector(${q(`[data-zs-template="${t.id}"]`)})!=null`),Boolean,'template readback');
      await click(`[data-zs-template-create="${t.id}"]`);await setInput('[data-zs-template-member-name]','模板成员甲');
      await cdp.eval(`(()=>{const b=document.querySelector('[data-zs-template-create-save]');b.click();b.click();return true})()`);await modalDone();
      const made=(await cmd('member.list',{projectId:p})).items.filter(m=>m.displayName==='模板成员甲');must(made.length===1,'double create duplicated');facts.createdId=made[0].id;
      const original=await cmd('member.runtime',{memberId:member});const first=await cmd('member.runtime',{memberId:made[0].id});must(first.binding.permissionMode==='plan'&&first.executableStatus.status==='missing'&&first.imageInput.status==='unverified','missing executable/permission/cert truth');
      await click(`[data-zs-template-edit="${t.id}"]`);await cdp.eval(`(()=>{const e=document.querySelector('.modal input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'工程配置模板新版');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);await click('[data-zs-template-edit-save]');await modalDone();
      must(JSON.stringify((await cmd('member.runtime',{memberId:member})).binding)===JSON.stringify(original.binding),'template edit changed source member');must(JSON.stringify((await cmd('member.runtime',{memberId:made[0].id})).binding)===JSON.stringify(first.binding),'template edit changed existing member');facts.steps.push('template snapshot creates private member, unavailable program/unverified truth, editing template preserves existing bindings');
      await click(`[data-zs-member-edit="${member}"]`);await setInput('[data-zs-member-name]','待保存输入');const m=await getMember();await cmd('member.update',{projectId:p,memberId:member,expectedRevision:m.revision,displayName:m.displayName,description:'服务端较新说明'});await click(`[data-zs-member-edit-save="${member}"]`);
      await until(()=>cdp.eval(`document.querySelector('.modal')?.textContent.includes('STALE_REVISION')`),Boolean,'CAS visible error');must(await cdp.eval(`document.querySelector('[data-zs-member-name]').value==='待保存输入'`),'conflict lost input');await cdp.shot('cas-error-preserved-input');await closeModal();facts.steps.push('stale revision rejected locally visible; input retained and server newer facts remain');
      // Same page survives focus transitions: original modal cannot retarget or revive after ABA.
      await click(`[data-zs-template-create="${t.id}"]`);await route(`/project/${b}/members`,'[data-zs-members]');await until(()=>cdp.eval(`document.querySelector('.modal')?.textContent.includes('作废')`),Boolean,'A to B stale form');await route(`/project/${p}/members`,'[data-zs-members]');must(await cdp.eval(`document.querySelector('[data-zs-template-create-save]')?.disabled===true`),'ABA revived original form');await closeModal();
      await route(`/project/${b}/members`,'[data-zs-members]');await until(()=>cdp.eval(`document.querySelector(${q(`[data-zs-template-create="${t.id}"]`)})!=null`),Boolean,'cross project template');await click(`[data-zs-template-create="${t.id}"]`);await setInput('[data-zs-template-member-name]','模板成员乙');await click('[data-zs-template-create-save]');await modalDone();const cross=(await cmd('member.list',{projectId:b})).items.find(m=>m.displayName==='模板成员乙');must(cross&&cross.id!==made[0].id&&cross.id!==member,'cross-project independent identity');facts.crossId=cross.id;facts.steps.push('cross-project template reuse and A/B/ABA form invalidation');
      await route(`/project/${p}/members`,'[data-zs-members]');
      for(const v of [{name:'wide',width:1440,height:960,dpr:1},{name:'narrow',width:900,height:800,dpr:1},{name:'hidpi',width:1280,height:800,dpr:1.5}]){
        await viewport(v.width,v.height,v.dpr);await cdp.shot(`members-${v.name}`);await route(`/project/${p}/member/${member}`,'[data-zs-member-detail]');await until(()=>cdp.eval(`document.querySelector(${q(`[data-zs-member-edit="${member}"]`)})!=null`),Boolean,'detail loaded');await cdp.shot(`detail-${v.name}`);await click(`[data-zs-member-edit="${member}"]`);await cdp.shot(`edit-${v.name}`);await closeModal();await route(`/project/${p}/members`,'[data-zs-members]');await until(()=>cdp.eval(`document.querySelector(${q(`[data-zs-template-create="${t.id}"]`)})!=null`),Boolean,'template loaded');await click(`[data-zs-template-create="${t.id}"]`);await cdp.shot(`create-${v.name}`);await closeModal();facts.screenshots.push(v);
      }
      // Formal room and DM projections are identity-based after rename.
      const rooms=(await cmd('room.list',{projectId:p})).items;const room=rooms[0];const dm=await cmd('conversation.create',{projectId:p,peerMemberId:member,title:'工程私信'});
      must((await cmd('member.list',{projectId:p,roomId:room.id})).items.find(m=>m.id===member).displayName==='改名实现者','room identity display');must((await cmd('conversation.list',{projectId:p})).conversations.find(d=>d.conversationId===dm.conversationId).peerDisplayName==='改名实现者','DM identity display');
      await route(`/project/${p}/room/${room.id}`,'textarea.composer-input');await cdp.eval(`[...document.querySelectorAll('button')].find(b=>b.title.includes('打开 @ 候选'))?.click();true`);await until(()=>cdp.eval(`document.querySelector(${q(`[data-zs-mention-option="${member}"]`)})?.textContent.includes('改名实现者')`),Boolean,'live mention identity');must(await cdp.eval(`document.querySelector(${q(`[data-zs-mention-option="${member}"]`)})?.textContent.includes('服务端较新说明')`),'mention description');facts.steps.push('room/DM/@ current display uses stable member identity, same-name peer remains independent');
      await route(`/project/${p}/members`,'[data-zs-members]');await stop();start();cdp=await connect();await until(()=>cdp.eval(`document.body?.classList.contains('hifi-on')`),Boolean,'real BAT reopen');await route(`/project/${p}/members`,'[data-zs-members]');must((await getMember()).displayName==='改名实现者','rename reopen');must((await cmd('memberTemplate.list',{})).items.find(t=>t.id===facts.templateId).name==='工程配置模板新版','template reopen');must((await cmd('member.runtime',{memberId:facts.createdId})).binding.permissionMode==='plan','binding reopen');await cdp.shot('members-reopened');facts.steps.push('normal close and actual daily BAT reopen retains identities/templates/config snapshots');
      facts.memberId=member;facts.sameNameId=second;facts.projectId=p;facts.crossProjectId=b;
    }
    const Database=require(path.join(repo,'node_modules/better-sqlite3'));const db=new Database(path.join(copy,'server-data/state.sqlite'),{readonly:true});try{facts.realCalls=db.prepare('SELECT count(*) c FROM real_calls').get().c;facts.schemaVersion=db.pragma('user_version',{simple:true});facts.metadataReceipts=before?0:db.prepare("SELECT count(*) c FROM command_receipts WHERE result_json LIKE '%改名实现者%' AND result_json LIKE '%memberId%'").get().c;facts.profileDistinct=before?null:db.prepare('SELECT profile_id FROM project_members WHERE id IN (?,?,?)').all(member,facts.createdId,facts.crossId).map(r=>r.profile_id);}finally{db.close();}
    must(facts.realCalls===0,'unexpected real model calls');must(sessions.flat().length+cdp.errors.length===0,'renderer errors');facts.pass=true;
  }catch(e){facts.error=e.stack??String(e);if(cdp)await cdp.shot('failure');}
  finally{try{await stop();}catch(e){facts.teardownError=e.message;facts.pass=false;}facts.rendererErrors=sessions.flat();if(facts.rendererErrors.length)facts.pass=false;fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(facts,null,2));console.log(JSON.stringify({pass:facts.pass,out,error:facts.error,steps:facts.steps,buildId:build.buildId}));}
  process.exit(facts.pass?0:1);
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
