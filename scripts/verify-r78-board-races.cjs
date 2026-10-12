#!/usr/bin/env node
/** Real TasksBoard + real store in an isolated Electron renderer with controlled board.view replies. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, __dirname, WebSocket, fetch, AbortSignal, setTimeout, clearTimeout */
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { build } = require('esbuild');
const repo = resolve(__dirname, '..');
const output = resolve(process.argv[2] ?? join(repo, 'dist', `r78-board-races-${Date.now()}`));
if (existsSync(output)) throw new Error(`output already exists: ${output}`);
mkdirSync(output, { recursive: true });
const port = 9794;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const card = (id, title, roomId) => ({ taskId: id, title, roomTaskNumber: 1, threadId: `thread_${id}`, projectId: 'pA', roomId, ownerMemberId: null, taskStatus: 'REVIEW', runStatus: 'SUCCEEDED', runId: `run_${id}`, stopGeneration: 0, column: 'review', exitUnconfirmed: false, statusReason: null, pendingDelivery: { deliveryId: `dlv_${id}`, revision: 1, manifestHash: 'a'.repeat(64) }, locate: `#task=${id}` });
const data = (name, roomId = 'rA', projectId = 'pA') => ({ groups: [{ projectId, displayName: projectId === 'pA' ? '项目A' : '项目B', rooms: [{ roomId, name: roomId, cards: [{ ...card(`task_${name}`, name, roomId), projectId }] }] }] });
const until = async (read, ok, label, ms = 10_000) => { const deadline = Date.now() + ms; let last; while (Date.now() < deadline) { last = await read(); if (ok(last)) return last; await sleep(80); } throw new Error(`${label} timeout: ${JSON.stringify(last)}`); };

class Cdp {
  constructor(ws) { this.ws = ws; this.next = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }); }
  send(method, params = {}) { return new Promise((resolveSend, reject) => { const id = ++this.next; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, 12_000); this.pending.set(id, { resolve: resolveSend, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return r.result.value; }
}
async function connect() {
  const page = await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json())).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch { return null; } }, (x) => x != null, 'CDP', 25_000);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  return new Cdp(ws);
}
async function buildHarness(kind, boardSource) {
  const dir = join(output, kind); mkdirSync(dir, { recursive: true });
  const storeFile = join(repo, 'src', 'ui', 'hifi', 'data', 'store.ts').replaceAll('\\', '/');
  const source = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{TasksBoardPage}from'@r78-board';import{setState,getState}from'${storeFile}';
const requests=[];window.zs={command:(env)=>new Promise((resolve,reject)=>{requests.push({env,resolve,reject,at:Date.now()});})};
setState(s=>({...s,activeProjectId:'pA',projects:[{id:'pA',displayName:'项目A',status:'active',removedAt:null},{id:'pB',displayName:'项目B',status:'active',removedAt:null}]}));
let setRoute;function App(){const[q,setQ]=useState({scope:'project',projectId:'pA',roomId:'rA'});setRoute=setQ;return <TasksBoardPage query={q}/>;}const root=createRoot(document.getElementById('root'));root.render(<App/>);
window.r78={calls:()=>requests.map((r,i)=>({i,method:r.env.method,params:r.env.params,at:r.at})),resolve:(i,data)=>requests[i]?.resolve({ok:true,data}),reject:(i,message)=>requests[i]?.resolve({ok:false,error:{code:'R78_READ_FAIL',message}}),route:(q)=>setRoute(q),unmount:()=>root.unmount(),state:()=>getState(),text:()=>document.getElementById('root')?.textContent??''};`;
  const entry = join(dir, 'harness.tsx'); writeFileSync(entry, source, 'utf8');
  await build({ entryPoints: [entry], outfile: join(dir, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.tsx': 'tsx', '.ts': 'ts' }, plugins: [{ name: 'r78-real-board-source', setup(builder) {
    builder.onResolve({ filter: /^@r78-board$/ }, () => ({ path: 'board', namespace: 'r78-board' }));
    builder.onLoad({ filter: /.*/, namespace: 'r78-board' }, () => ({ contents: boardSource, loader: 'tsx', resolveDir: join(repo, 'src', 'ui', 'hifi', 'pages') }));
  } }] });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="bundle.js"></script></body></html>', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `r78-board-${kind}`, version: '0.0.0', main: 'main.cjs' }));
  writeFileSync(join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'user-data'));app.whenReady().then(()=>{const w=new BrowserWindow({width:1250,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true}});w.loadFile(path.join(__dirname,'index.html'));});app.on('window-all-closed',()=>app.quit());`);
  return dir;
}
function killOwn(dir) { const marker = dir.replaceAll("'", "''"); spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') -and $_.Name -eq 'electron.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore' }); }
async function runCase(kind, boardSource) {
  const dir = await buildHarness(kind, boardSource);
  const electron = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [dir, `--remote-debugging-port=${port}`], { cwd: dir, env, windowsHide: true, stdio: 'ignore' });
  const result = { kind, pass: false, assertions: {}, errors: [] };
  let cdp;
  try {
    cdp = await connect();
    await until(() => cdp.eval('typeof window.r78 === "object"'), (v) => v, 'harness');
    const calls = () => cdp.eval('window.r78.calls()');
    const text = () => cdp.eval('window.r78.text()');
    const resolveCall = (i, payload) => cdp.eval(`window.r78.resolve(${i},${JSON.stringify(payload)});true`);
    const failCall = (i, msg) => cdp.eval(`window.r78.reject(${i},${JSON.stringify(msg)});true`);
    await until(calls, (x) => x.length >= 1, 'initial A');
    // First load with roomId=rA must retain that filter even before room options arrive.
    await resolveCall(0, { groups: [{ projectId: 'pA', displayName: '项目A', rooms: [{ roomId: 'rA', name: 'A', cards: [card('a', 'A_SELECTED', 'rA')] }, { roomId: 'rB', name: 'B', cards: [card('b', 'B_HIDDEN', 'rB')] }] }] });
    await until(text, (x) => x.includes('A_SELECTED'), 'first room');
    result.assertions.firstRoomFilter = !(await text()).includes('B_HIDDEN');
    // A request held; changing scope to B succeeds; old A reply comes last.
    await cdp.eval("window.r78.route({scope:'all',projectId:'pA',roomId:'all'});true");
    await until(calls, (x) => x.length >= 2, 'delayed A');
    await cdp.eval("window.r78.route({scope:'project',projectId:'pB',roomId:'all'});true");
    await until(calls, (x) => x.length >= 3, 'new B');
    await resolveCall(2, data('B_CONFIRMED', 'rB', 'pB'));
    await until(text, (x) => x.includes('B_CONFIRMED'), 'B confirm');
    await resolveCall(1, data('A_LATE'));
    await sleep(300);
    result.assertions.lateARejected = (await text()).includes('B_CONFIRMED') && !(await text()).includes('A_LATE');
    // Refresh failure must keep B card and show the error. The real button is the user action;
    // baseline lacks it, which is a separately recorded failure rather than a harness timeout.
    const refresh = await cdp.eval("[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='刷新')?.outerHTML ?? null");
    if (refresh != null) {
      const n = (await calls()).length;
      await cdp.eval("[...document.querySelectorAll('#root button')].find(b=>b.textContent.trim()==='刷新').click();true");
      await until(calls, (x) => x.length > n, 'B refresh');
      await failCall(n, 'R78 controlled read failure');
      await sleep(300);
      result.assertions.failurePreservesCard = (await text()).includes('B_CONFIRMED') && (await text()).includes('R78 controlled read failure');
    } else result.assertions.failurePreservesCard = false;
    // Hold one automatic refresh across >3 five-second cycles: no overlapping requests. After
    // completing it, the next cycle must issue exactly one fresh read.
    const prePoll = (await calls()).length;
    let pollStarted = false;
    try { await until(calls, (x) => x.length > prePoll, 'first timer read', 6_500); pollStarted = true; } catch { /* baseline has no timer */ }
    if (!pollStarted) result.assertions.threePollsSingleFlight = false;
    else {
      const heldCount = (await calls()).length;
      await sleep(15_800);
      const noOverlap = (await calls()).length === heldCount;
      await resolveCall(prePoll, data('B_POLL_DONE', 'rB', 'pB'));
      await until(calls, (x) => x.length > heldCount, 'next timer read', 6_500);
      const exactlyOne = (await calls()).length === heldCount + 1;
      await resolveCall(heldCount, data('B_NEXT', 'rB', 'pB'));
      result.assertions.threePollsSingleFlight = noOverlap && exactlyOne;
    }
    // Unmount before a delayed reply: no board content may reappear.
    const beforeUnmount = (await calls()).length;
    await cdp.eval("window.r78.route({scope:'all',projectId:'pA',roomId:'all'});true");
    await until(calls, (x) => x.length > beforeUnmount, 'unmount pending');
    await cdp.eval('window.r78.unmount();true');
    await resolveCall(beforeUnmount, data('AFTER_UNMOUNT'));
    result.assertions.unmountSafe = (await text()) === '';
    result.pass = Object.values(result.assertions).every(Boolean);
  } catch (error) { result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); }
  finally { if (cdp) await Promise.race([cdp.eval('window.close();true').catch(() => {}), sleep(2000)]); killOwn(dir); child.kill(); }
  return result;
}

(async () => {
  const current = readFileSync(join(repo, 'src', 'ui', 'hifi', 'pages', 'TasksBoard.tsx'), 'utf8');
  const old = execFileSync('git', ['-C', repo, 'show', 'd87f699:src/ui/hifi/pages/TasksBoard.tsx'], { encoding: 'utf8' });
  const older = await runCase('baseline-d87f699', old);
  const repaired = await runCase('current', current);
  const report = { baseline: older, current: repaired, pass: !older.pass && repaired.pass };
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, baselinePass: older.pass, currentPass: repaired.pass, pass: report.pass, currentErrors: repaired.errors }));
  process.exit(report.pass ? 0 : 1);
})().catch((error) => { console.error(error?.stack ?? error); process.exit(1); });
