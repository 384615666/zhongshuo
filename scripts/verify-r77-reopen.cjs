/** Additional final-copy visual check: close read-only overlay, keep dispatch protection, zero calls. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, WebSocket, fetch, AbortSignal, setTimeout, clearTimeout, Buffer */
const fs=require('node:fs'),path=require('node:path'),{spawn,spawnSync}=require('node:child_process');
const receipt=path.resolve(process.argv[2]);const prior=JSON.parse(fs.readFileSync(receipt,'utf8'));
const copy=path.join(path.dirname(receipt),'copy');const out=path.resolve(`dist/desktop/r77-final-reopen-${Date.now()}`);fs.mkdirSync(out,{recursive:true});
const port=9727,sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Cdp {
 constructor(ws){this.ws=ws;this.seq=0;this.pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);if(m.error)p.reject(new Error(m.error.message));else p.resolve(m.result);}});}
 send(method,params={}){return new Promise((resolve,reject)=>{const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+' timeout'));},15000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}));});}
 async eval(expression){const r=await this.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description?.slice(0,300)??r.exceptionDetails.text);return r.result.value;}
}
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(200);}throw new Error(label+' timeout');}
(async()=>{
 const probe=require('node:net').createServer();await new Promise((res,rej)=>{probe.once('error',rej);probe.listen(port,'127.0.0.1',res);});await new Promise(res=>probe.close(res));
 if(!prior.pass||!copy.includes(path.join('dist','desktop','r76-images-')))throw new Error('requires own successful engineering receipt');
 spawn('cmd',['/c','start-desktop.bat'],{cwd:copy,env:{...process.env,ZS_DEV25_DEBUG_PORT:String(port)},windowsHide:true,stdio:'ignore'});
 const facts={pass:false,sourceReceipt:receipt,build:JSON.parse(fs.readFileSync(path.join(copy,'ZhongshuoDual/BUILD.json'),'utf8'))};let cdp;
 try{
  const page=await until(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)}).then(r=>r.json())).find(t=>t.type==='page'&&t.url.includes('index.html'));}catch{return null;}},'startup');
  const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej);});cdp=new Cdp(ws);
  await until(()=>cdp.eval("document.body?.classList.contains('hifi-on')"),'UI');
  await until(()=>cdp.eval("typeof window.zs?.command==='function'"),'published command bridge');
  const cmd=method=>cdp.eval(`window.zs.command(${JSON.stringify({protocolVersion:1,commandId:'r77-read-'+Math.random().toString(36).slice(2),method,params:{}})})`);
  facts.before=await cmd('recovery.status');
  await until(()=>cdp.eval("[...document.querySelectorAll('#hifi-root .modal')].some(m=>m.textContent.includes('恢复检查'))"),'read-only recovery popup');
  await cdp.eval("(()=>{const m=[...document.querySelectorAll('#hifi-root .modal')].find(x=>x.textContent.includes('恢复检查'));[...m.querySelectorAll('button')].find(b=>b.textContent.trim()==='关闭').click()})();true");
  await until(()=>cdp.eval("document.querySelector('#hifi-root .modal,#hifi-root .scrim')==null"),'no overlay');
  await cdp.eval(`location.hash=${JSON.stringify(prior.facts.afterSend.hash.replace(/^#/,''))};true`);
  await until(()=>cdp.eval("[...document.querySelectorAll('#hifi-root .root-card .msg-attach')].some(x=>x.textContent.includes('中文图片.png'))"),'persisted record');
  await cdp.eval("[...document.querySelectorAll('#hifi-root .root-card .msg-attach')].find(x=>x.textContent.includes('中文图片.png')).click();true");
  facts.image=await until(()=>cdp.eval("(()=>{const i=document.querySelector('[data-zs-image-preview]');if(!i||i.naturalWidth<=0||i.naturalHeight<=0)return null;const r=i.getBoundingClientRect(),v=i.parentElement.getBoundingClientRect();if(r.width<=0||r.height<=0||Math.min(r.right,v.right)<=Math.max(r.left,v.left)||Math.min(r.bottom,v.bottom)<=Math.max(r.top,v.top))return null;return {width:i.naturalWidth,height:i.naturalHeight,drawWidth:r.width,drawHeight:r.height,noOverlay:document.querySelector('#hifi-root .modal,#hifi-root .scrim')==null}})()"),'visible actual decoding');
  facts.after=await cmd('recovery.status');const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'reopen-unobscured.png'),Buffer.from(shot.data,'base64'));
  facts.protocol=page.url;facts.pass=facts.before.data.gateHeld&&facts.after.data.gateHeld&&facts.after.data.pendingDispatchCount===0&&facts.image.noOverlay&&page.url.startsWith('zsres:');
 }catch(e){facts.error=e.message;}
 finally{
  if(cdp){try{await Promise.race([cdp.send('Browser.close'),sleep(2000)]);}catch{/* already closed */}}
  await sleep(2000);const prefix=(copy+path.sep).replaceAll("'","''");spawnSync('powershell',['-NoProfile','-Command',`Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],{windowsHide:true,stdio:'ignore'});
  const db=new(require('better-sqlite3'))(path.join(copy,'server-data/state.sqlite'),{readonly:true});facts.realCalls=db.prepare('SELECT count(*) c FROM real_calls').get().c;db.close();facts.pass=facts.pass&&facts.realCalls===0;
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(facts,null,2));console.log(JSON.stringify(facts));
 }process.exit(facts.pass?0:1);
})().catch(e=>{console.error(e);process.exit(1)});
