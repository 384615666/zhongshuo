/* Screenshot existing R89 real-model evidence without sending or retrying. */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs=require('node:fs');
const path=require('node:path');
const {Cdp,until}=require('./verify-r81-members-launcher.cjs');
const port=Number(process.argv[2]);
const fixtureRoot=path.resolve(process.argv[3]??'');
const fixture=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'fixture.json'),'utf8'));
const result=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'evidence','result.json'),'utf8'));
const out=path.join(fixtureRoot,'evidence');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connect(){return until(async()=>{try{const rows=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1500)}).then(r=>r.json());const t=rows.find(r=>r.type==='page'&&r.url.includes('index.html'));if(!t)return null;const ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});const c=new Cdp(ws);await c.send('Runtime.enable');await c.send('Page.enable');await until(()=>c.eval('document.body?.classList.contains("hifi-on")'),Boolean,'hifi',30000);return c}catch{return null}},Boolean,'owned R89 real evidence window',30000)}
async function shot(cdp,name){await cdp.send('Page.bringToFront');await cdp.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const img=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(img.data,'base64'))}
(async()=>{
 const cdp=await connect();
 try{
  const greeting=result.stages.find(s=>s.stage==='coordinator-greeting');
  const single=result.stages.find(s=>s.stage==='explicit-single-non-coordinator');
  const all=result.stages.find(s=>s.stage==='room-all');
  const multi=result.stages.find(s=>s.stage==='explicit-multi-document');
  await cdp.eval(`location.hash=${JSON.stringify(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${greeting.threadId}`)};true`);
  await until(()=>cdp.eval('document.querySelector(`.col-thread .msg`)!=null'),Boolean,'coordinator thread',30000);await sleep(500);await shot(cdp,'01-real-coordinator-greeting');
  await cdp.eval(`location.hash=${JSON.stringify(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${single.threadId}`)};true`);
  await until(()=>cdp.eval('document.querySelector(`.col-thread .msg`)!=null'),Boolean,'single thread',30000);await sleep(500);await shot(cdp,'02-real-single-non-coordinator');
  await cdp.eval(`location.hash=${JSON.stringify(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${all.threadId}`)};true`);
  await until(()=>cdp.eval('document.querySelector(`.col-thread .msg`)!=null'),Boolean,'all thread',30000);await sleep(500);await shot(cdp,'03-real-room-all');
  await cdp.eval(`location.hash=${JSON.stringify(`/project/${fixture.projectId}/room/${fixture.roomId}?thread=${multi.threadId}`)};true`);
  await until(()=>cdp.eval('document.querySelector(`.col-thread .msg`)!=null'),Boolean,'multi thread',30000);await sleep(500);await shot(cdp,'04-real-toolbar-multi-document');
  const text=await cdp.eval("document.querySelector('.col-thread')?.textContent??''");
  const visible={
    coordinator:greeting.text,
    single:single.agents.map(item=>item.text),
    roomAll:all.agents.map(item=>item.text),
    multi:multi.agents.map(item=>item.text),
    currentThreadText:text,
  };
  fs.writeFileSync(path.join(out,'visible-summary.json'),JSON.stringify({ok:Object.values(visible).flat().every(value=>!/(task-complete-v1|schemaVersion|resultKey)/.test(String(value)))&&String(text).includes('R89_REAL_DOC_7531'),visible}),'utf8');
  cdp.ws.close();
 }catch(e){cdp.ws.close();throw e}
})().catch(e=>{console.error(e.stack??e);process.exitCode=1});
