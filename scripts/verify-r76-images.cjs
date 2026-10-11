#!/usr/bin/env node
/** R76 final launcher + published protocol, isolated copy/profile/DB, zero model calls.
 * v14 baseline uses identical cold pool and continuous >=3-cycle criteria.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, process, console, Buffer, WebSocket, fetch, AbortSignal, setTimeout */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const outDir = path.join(repo, 'dist', 'desktop', `r76-images-${Date.now()}`);
const copyDir = path.join(outDir, 'copy');
const PORT = 9726;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) { const t0 = Date.now(); for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error(`超时：${label}（${JSON.stringify(v)?.slice(0, 300)}）`); await sleep(300); } }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); if(d.error != null) reject(new Error(d.error.message)); else resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.errors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout')); } }, 60_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 300)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  async shot(p) { try { const png = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(p, Buffer.from(png.data, 'base64')); } catch { /* */ } }
}
async function connect(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); c.pageUrl=page.url; await c.send('Runtime.enable'); await c.send('Page.enable'); return c; }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
function killCopy() {
  const prefix = (copyDir + path.sep).replaceAll("'", "''");
  try { spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { encoding: 'utf8', timeout: 60000 }); } catch { /* */ }
}
async function modalOpenCurrentPick(cdp) {
  await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .side-item')].find((x) => x.textContent.includes('打开/切换项目')); b?.click(); return b != null; })()`));
  await until(() => cdp.tryEval(`document.querySelector('#hifi-root .modal input.input') != null`), (v) => v, 10000, '打开弹窗');
  await until(() => cdp.tryEval(probe(`(() => { const i = document.querySelector('#hifi-root .modal input.input'); return i != null && i.value.length > 3; })()`)), (v) => v, 20000, '目录选择回填（autoPick）');
  await cdp.eval(probe(`(() => { const m = [...document.querySelectorAll('#hifi-root .modal')].find((x) => x.textContent.includes('打开文件夹')); const b = [...(m?.querySelectorAll('button') ?? [])].find((x) => x.textContent.includes('打开这个目录')); b?.click(); return b != null; })()`));
  await until(() => cdp.tryEval(`document.querySelector('#hifi-root .modal') == null`), (v) => v, 45000, '弹窗关闭（打开完成）');
}

(async () => {
 const port=require('node:net').createServer();await new Promise((resolve,reject)=>{port.once('error',reject);port.listen(PORT,'127.0.0.1',resolve);});await new Promise(resolve=>port.close(resolve));
 const src = path.resolve(process.argv[2] || 'dist/desktop/desktop-daily-win-v14');
 fs.mkdirSync(copyDir, {recursive:true});
 const rc = spawnSync('robocopy', [src,copyDir,'/E','/XD','server-data','RESULTS','/NFL','/NDL','/NJH','/NJS','/NP'], {timeout:300000});
 if(rc.status > 7) throw new Error('copy failed');
 const project = path.join(outDir,'图片验证'); fs.mkdirSync(project,{recursive:true});
 const sample = 'C:/Users/user/Documents/文档测试/QQ20260711-003638.png';
 fs.copyFileSync(sample,path.join(project,'中文图片.png'));
 const pickFile=path.join(outDir,'pick.txt');fs.writeFileSync(pickFile,project);
 let cdp; const facts = { source:src, stages:[], realCalls:null }; const errs=[];
 const start = () => spawn('cmd',['/c','start-desktop.bat'],{cwd:copyDir,env:{...process.env,ZS_DEV25_DEBUG_PORT:String(PORT),ZS_PICK_FOLDER_FILE:pickFile,ZS_SAVEAS_AUTO_DIR:path.join(outDir,'saved')},windowsHide:true,stdio:'ignore'});
 const cmd = async (method,params) => cdp.eval(`window.zs.command(${JSON.stringify({protocolVersion:1,commandId:'r76-'+Math.random().toString(36).slice(2),method,params})})`);
 const click = async (selector,text) => cdp.eval(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.includes(${JSON.stringify(text)}));b?.click();return !!b})()`);
 try {
 start(); cdp=await connect('start'); facts.protocolUrl=cdp.pageUrl; if(!String(cdp.pageUrl).startsWith('zsres:'))errs.push('published protocol must be zsres');
 await until(()=>cdp.tryEval("document.body.classList.contains('hifi-on')"),v=>v,60000,'hifi');
 console.log('stage project'); const opened=await cmd('project.open',{path:project}); if(!opened.ok) throw new Error(JSON.stringify(opened));
 const made=await cmd('room.create',{projectId:opened.data.project.id,name:'默认房间'}); if(!made.ok) throw new Error(JSON.stringify(made));
 await modalOpenCurrentPick(cdp);
 console.log('stage room'); await click('#hifi-root button.side-item.sub','默认房间');
 await until(()=>cdp.tryEval("document.querySelector('textarea.composer-input') != null"),v=>v,20000,'composer');
 console.log('stage picker'); const dom=await cdp.send('DOM.getDocument');
 const inp=await cdp.send('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#hifi-root input[type=file]'});
 await cdp.send('DOM.setFileInputFiles',{nodeId:inp.nodeId,files:[path.join(project,'中文图片.png')]});
 await until(()=>cdp.tryEval("document.querySelector('[data-zs-att=ready], [data-zs-att-error]') != null"),v=>v,30000,'upload receipt');
 facts.upload=await cdp.eval("[...document.querySelectorAll('[data-zs-att],[data-zs-att-error]')].map(x=>({status:x.dataset.zsAtt,text:x.textContent}))");
 facts.stages.push('selection/upload');
 console.log('stage preview'); await click('[data-zs-att=ready] button','预览'); await sleep(3000);
 facts.preview=await cdp.eval("(()=>{const i=document.querySelector('[data-zs-image-preview]');const r=i?.getBoundingClientRect();return {error:document.querySelector('[data-zs-preview-error]')?.textContent,text:document.querySelector('.preview-pane')?.textContent,naturalWidth:i?.naturalWidth??0,naturalHeight:i?.naturalHeight??0,rect:r?{width:r.width,height:r.height}:null}})()");
 await cdp.shot(path.join(outDir,'draft-preview.png'));
 if(!(facts.preview.naturalWidth>0&&facts.preview.naturalHeight>0&&facts.preview.rect?.width>0)) errs.push('draft decode/visible failed');
 // Image-only record: actual Composer actions, no model dispatch.
 await cdp.eval("document.querySelector('#hifi-root button[aria-label=\"本次运行设置\"]')?.click();true");
 await sleep(150);
 await cdp.eval("[...document.querySelectorAll('#hifi-root button')].find(b=>b.title.startsWith('仅记录：这次只保存内容'))?.click();true");
 await sleep(150);
 await cdp.eval("document.querySelector('#hifi-root .composer button[title^=\"Enter 发送\"]')?.click();true");
 await until(()=>cdp.tryEval("document.querySelector('.msg-attach') != null || document.querySelector('[data-zs-send-error]') != null || document.querySelector('[data-zs-att=ready]') == null"),v=>v,20000,'record send');
 await sleep(1200);
 facts.afterSend=await cdp.eval("({text:document.body.innerText.slice(-2000),hash:location.hash})");
 const dbPath=path.join(copyDir,'server-data','state.sqlite'); const Database=require('better-sqlite3');const db=new Database(dbPath,{readonly:true});
 facts.links=db.prepare('SELECT message_id, artifact_id FROM message_attachments').all();
 const th=db.prepare('SELECT id,anchor_message_id FROM conversation_threads ORDER BY rowid DESC LIMIT 1').get();db.close();
 if(facts.links.length!==1) errs.push('record-only must persist one exact attachment');
 if(th){
 const chipsExpr="[...document.querySelectorAll('.root-card .msg-attach')].map(x=>({id:x.dataset.zsArtifactId,name:x.textContent}))";
 facts.cold=await cdp.eval(chipsExpr); if(facts.cold.length!==1||src.includes('v15')&&facts.cold[0]?.id!==facts.links[0]?.artifact_id) errs.push('cold pool attachment absent');
 await cdp.eval("document.querySelector('#hifi-root .root-replies-btn')?.click();true");
 await until(()=>cdp.tryEval("document.querySelector('#hifi-root .col-thread textarea.composer-input')!=null"),v=>v,20000,'expanded thread');
 facts.threadExpanded=true;
 await sleep(300);
 facts.samples=[];const end=Date.now()+16500;while(Date.now()<end){facts.samples.push({t:Date.now(),chips:await cdp.eval(chipsExpr)});await sleep(250);}
 if(facts.samples.some(s=>s.chips.length!==1||src.includes('v15')&&s.chips[0]?.id!==facts.links[0]?.artifact_id))errs.push('pool chips unstable over >=3 refresh cycles');
 await cdp.shot(path.join(outDir,'sent-stability.png'));
 }
 if(src.includes('v15')){
   const roomId=facts.afterSend.hash.match(/\/room\/([^?]+)/)[1];
   const restart=async(beforeStart)=>{if(cdp&&!cdp.closed){try{await Promise.race([cdp.send('Browser.close'),sleep(2000)]);}catch{ /* already exited */ }}await sleep(2500);killCopy();if(beforeStart)await beforeStart();start();cdp=await connect('restart');await until(()=>cdp.tryEval("document.body.classList.contains('hifi-on')"),v=>v,60000,'restart UI');await sleep(1000);return cdp;};
   const seedDelivery=async()=>{let delivery;const fresh=await restart(async()=>{const entry=path.join(outDir,'seed-delivery.cjs');require('esbuild').buildSync({entryPoints:[path.join(repo,'scripts/lib/r76-seed-delivery.ts')],bundle:true,platform:'node',format:'cjs',outfile:entry,external:['better-sqlite3','esbuild']});const result=spawnSync(process.execPath,[entry,path.join(copyDir,'server-data'),opened.data.project.id,roomId],{cwd:repo,encoding:'utf8',timeout:30000});if(result.status!==0)throw new Error(result.stderr.slice(-500));delivery=JSON.parse(result.stdout.trim());});return {cdp:fresh,delivery};};
   cdp=await require('./lib/r76-image-ui.cjs')({cdp,facts,errs,outDir,project,copyDir,cmd,until,restart,seedDelivery,pid:opened.data.project.id,threadId:th.id,roomId});
 }
 console.log(JSON.stringify({outDir,criteria: facts.extended,errs},null,2));
 } catch(e){errs.push(e.message);} finally {
 if(cdp&&!cdp.closed) {try{await Promise.race([cdp.send('Browser.close'),sleep(2000)]);}catch{ /* already exited */ }}
 await sleep(2500);killCopy();
 const dbp=path.join(copyDir,'server-data','state.sqlite');if(fs.existsSync(dbp)){const Database=require('better-sqlite3');const db=new Database(dbp,{readonly:true}); facts.realCalls=db.prepare('select count(*) c from real_calls').get().c;db.close();}
 if(facts.realCalls!==0) errs.push('realCalls must be zero');
 fs.writeFileSync(path.join(outDir,'result.json'),JSON.stringify({pass:errs.length===0,errs,facts},null,2));
 console.log(JSON.stringify({outDir,pass:errs.length===0,errs},null,2));
 }
 process.exit(errs.length?1:0);
})().catch(e=>{console.error(e);killCopy();process.exit(1)});
