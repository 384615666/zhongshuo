#!/usr/bin/env node
/** Real Pending/Activity/Library React pages with controlled read replies in isolated Electron. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, __dirname, WebSocket, fetch, AbortSignal, setTimeout, clearTimeout */
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { build } = require('esbuild');
const repo = resolve(__dirname, '..');
const output = resolve(process.argv[2] ?? join(repo, 'dist', `r78-read-surfaces-${Date.now()}`));
if (existsSync(output)) throw new Error(`output already exists: ${output}`);
mkdirSync(output, { recursive: true });
const port = 9788;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (read, ok, label, ms = 12_000) => { const deadline = Date.now() + ms; let last; while (Date.now() < deadline) { last = await read(); if (ok(last)) return last; await sleep(70); } throw new Error(`${label} timeout: ${JSON.stringify(last)}`); };
const pending = (title) => ({ projects: [{ projectId: 'pA', displayName: '项目A', reviewTasks: [{ task_id: `task_${title}`, title, conversation_id: 'cA', status: 'REVIEW', delivery_id: 'dA', revision: 1, manifest_hash: 'a'.repeat(64), actionable: true }], dmUnread: [], threadUnread: [], followedThreads: [], blockedTasks: [], reminderAwaits: [] }], generatedAt: Date.now() });
const activity = (label, projectId = 'pA') => ({ items: [{ eventId: `evt_${label}`, seq: 1, kind: 'task.created', kindLabel: '任务创建', at: Date.now(), summary: label, projectId, projectName: projectId, conversationId: null, threadId: null, taskId: null, locate: null }] });
const activityBurst = () => ({ items: Array.from({ length: 60 }, (_, i) => ({ eventId: `evt_BURST_${i}`, seq: i + 100, kind: 'task.created', kindLabel: '任务创建', at: Date.now() + i, summary: `BURST_${i}`, projectId: 'pB', projectName: 'pB', conversationId: null, threadId: null, taskId: null, locate: null })) });
const search = (label, projectId = 'pA') => ({ page: 1, pageSize: 20, scope: 'project', messages: [], threads: [], tasks: [{ kind: 'task', taskId: `task_${label}`, title: label, status: 'REVIEW', projectId, projectName: projectId, conversationId: `c_${projectId}`, createdAt: Date.now(), locate: `#task=task_${label}` }], attachmentNote: '只检索文件名' });
class Cdp {
  constructor(ws) { this.ws = ws; this.next = 0; this.pending = new Map(); ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }); }
  send(method, params = {}) { return new Promise((resolveSend, reject) => { const id = ++this.next; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout`)); }, 15_000); this.pending.set(id, { resolve: resolveSend, reject, timer }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)); return r.result.value; }
}
async function connect() {
  const page = await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json())).find((x) => x.type === 'page' && x.url.includes('index.html')); } catch { return null; } }, (x) => x != null, 'CDP', 25_000);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  return new Cdp(ws);
}
async function buildHarness(kind, sources) {
  const dir = join(output, kind); mkdirSync(dir, { recursive: true });
  const store = join(repo, 'src', 'ui', 'hifi', 'data', 'store.ts').replaceAll('\\', '/');
  const source = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{PendingPage}from'@pending';import{ActivityPage}from'@activity';import{LibraryPage}from'@library';import{setState}from'${store}';
const requests=[];window.zs={command:(env)=>new Promise((resolve)=>{requests.push({env,resolve});})};
setState(s=>({...s,activeProjectId:'pA',visibleProjectIds:['pA'],pinnedProjectIds:['pB'],projects:[{id:'pA',displayName:'项目A',status:'active'},{id:'pB',displayName:'项目B',status:'active'}],rooms:[]}));
let setPage;function App(){const[p,setP]=useState('pending');setPage=setP;return p==='pending'?<PendingPage/>:p==='activity'?<ActivityPage/>:<LibraryPage/>;}const root=createRoot(document.getElementById('root'));root.render(<App/>);
window.r78={calls:()=>requests.map((r,i)=>({i,method:r.env.method,params:r.env.params})),resolve:(i,data)=>requests[i]?.resolve({ok:true,data}),reject:(i,message)=>requests[i]?.resolve({ok:false,error:{code:'R78_READ_FAIL',message}}),page:(p)=>setPage(p),focus:(id)=>setState(s=>({...s,activeProjectId:id})),click:(s)=>{const e=document.querySelector(s);if(!e)throw new Error('missing '+s);e.click();},input:(s,v)=>{const e=document.querySelector(s);if(!e)throw new Error('missing '+s);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}));},select:(s,v)=>{const e=document.querySelector(s);if(!e)throw new Error('missing '+s);e.value=v;e.dispatchEvent(new Event('change',{bubbles:true}));},unmount:()=>root.unmount(),text:()=>document.getElementById('root')?.textContent??''};`;
  const entry = join(dir, 'harness.tsx'); writeFileSync(entry, source, 'utf8');
  const aliases = { '@pending': 'PendingPage.tsx', '@activity': 'ActivityPage.tsx', '@library': 'LibraryPage.tsx' };
  await build({ entryPoints: [entry], outfile: join(dir, 'bundle.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.tsx': 'tsx', '.ts': 'ts' }, plugins: [{ name: 'r78-real-read-surfaces', setup(builder) {
    builder.onResolve({ filter: /^@(pending|activity|library)$/ }, (args) => ({ path: args.path, namespace: 'r78-pages' }));
    builder.onLoad({ filter: /.*/, namespace: 'r78-pages' }, (args) => ({ contents: sources[aliases[args.path]], loader: 'tsx', resolveDir: join(repo, 'src', 'ui', 'hifi') }));
  } }] });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="bundle.js"></script></body></html>', 'utf8');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `r78-read-${kind}`, version: '0.0.0', main: 'main.cjs' }));
  writeFileSync(join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(__dirname,'user-data'));app.whenReady().then(()=>{const w=new BrowserWindow({width:1250,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true}});w.loadFile(path.join(__dirname,'index.html'));});app.on('window-all-closed',()=>app.quit());`);
  return dir;
}
function killOwn(dir) { const marker = dir.replaceAll("'", "''"); spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') -and $_.Name -eq 'electron.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true, stdio: 'ignore' }); }
async function runCase(kind, sources) {
  const dir = await buildHarness(kind, sources);
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
    const call = async (method, after = -1) => (await until(calls, (x) => x.find((c) => c.method === method && c.i > after), `call ${method}`)).find((c) => c.method === method && c.i > after);
    const resolveCall = (i, data) => cdp.eval(`window.r78.resolve(${i},${JSON.stringify(data)});true`);
    const failCall = (i, message) => cdp.eval(`window.r78.reject(${i},${JSON.stringify(message)});true`);
    const act = (expr) => cdp.eval(`window.r78.${expr};true`);
    // Pending: no active project must not show all projects as the current-project result.
    let p = await call('mine.pending'); await resolveCall(p.i, pending('PENDING_A'));
    await until(text, (x) => x.includes('PENDING_A'), 'pending first');
    await act("focus('')"); await act("click('[data-zs-pending-scope] button:nth-child(2)')");
    await sleep(120);
    result.assertions.pendingNoProject = !(await text()).includes('PENDING_A') && (await text()).includes('尚未打开项目');
    await act("focus('pA')"); await until(text, (x) => x.includes('PENDING_A'), 'pending project');
    const before = (await calls()).length;
    await act("click('[data-zs-pending] .page-filters .btn')");
    p = await call('mine.pending', before - 1);
    await act("click('[data-zs-pending] .page-filters .btn')"); await sleep(100);
    result.assertions.pendingInFlightMerged = (await calls()).filter((x) => x.method === 'mine.pending').length === 2;
    const pendingLatest = (await calls()).filter((x) => x.method === 'mine.pending').at(-1);
    await failCall(pendingLatest.i, 'CONTROLLED_PENDING_FAIL');
    await until(text, (x) => x.includes('CONTROLLED_PENDING_FAIL'), 'pending failure');
    result.assertions.pendingFailureKeepsFacts = (await text()).includes('PENDING_A');
    if (kind === 'current') {
      p = await call('mine.pending', pendingLatest.i); // visible 5s poll
      await resolveCall(p.i, pending('PENDING_NEW'));
      await until(text, (x) => x.includes('PENDING_NEW'), 'pending poll');
      result.assertions.pendingPoll = !(await text()).includes('CONTROLLED_PENDING_FAIL');
    } else { await sleep(5300); result.assertions.pendingPoll = (await calls()).some((x) => x.method === 'mine.pending' && x.i > pendingLatest.i); }
    // Activity: selected scope and reverse replies, then same-scope failure and visible poll.
    await act("page('activity')"); let a = await call('activity.list'); await resolveCall(a.i, activity('ALL_OLD'));
    await until(text, (x) => x.includes('ALL_OLD'), 'activity first');
    await act("select('[data-zs-activity] select.select','project')");
    a = await call('activity.list', a.i); // project A held
    await act("focus('pB')"); const b = await call('activity.list', a.i);
    await resolveCall(b.i, activity('B_CURRENT', 'pB'));
    await until(text, (x) => x.includes('B_CURRENT'), 'activity B');
    await resolveCall(a.i, activity('A_LATE'));
    await sleep(120);
    result.assertions.activityReverseScope = (await text()).includes('B_CURRENT') && !(await text()).includes('A_LATE');
    await act("click('[data-zs-activity] .page-filters .btn')");
    const fail = await call('activity.list', b.i); await failCall(fail.i, 'CONTROLLED_ACTIVITY_FAIL');
    await until(text, (x) => x.includes('CONTROLLED_ACTIVITY_FAIL'), 'activity failure');
    result.assertions.activityFailureKeepsFacts = (await text()).includes('B_CURRENT');
    await act("click('[data-zs-activity] .page-filters .btn')");
    await call('activity.list', fail.i);
    await act("click('[data-zs-activity] .page-filters .btn')"); await sleep(100);
    const afterRefreshClicks = (await calls()).filter((x) => x.method === 'activity.list' && x.i > fail.i);
    result.assertions.activityRefreshMerged = afterRefreshClicks.length === 1;
    const refreshLatest = afterRefreshClicks.at(-1);
    await resolveCall(refreshLatest.i, activity('B_CURRENT', 'pB'));
    await until(text, (x) => !x.includes('CONTROLLED_ACTIVITY_FAIL'), 'activity failure cleared');
    result.assertions.activityFailureCleared = true;
    if (kind === 'current') {
      const poll = await call('activity.list', refreshLatest.i); await resolveCall(poll.i, activity('B_NEW', 'pB'));
      await until(text, (x) => x.includes('B_NEW'), 'activity poll');
      result.assertions.activityPollKeepsCursor = (await text()).includes('B_CURRENT');
      const burst = await call('activity.list', poll.i); await resolveCall(burst.i, activityBurst());
      await until(text, (x) => x.includes('刷新期间新增活动超过首页窗口'), 'activity gap notice');
      result.assertions.activityGapHonest = !(await text()).includes('B_NEW') && (await text()).includes('加载更早');
    } else { await sleep(5300); result.assertions.activityPollKeepsCursor = (await calls()).some((x) => x.method === 'activity.list' && x.i > refreshLatest.i); }
    // Library: old result must disappear as soon as query scope changes, before new reply.
    await act("page('library')"); await act("focus('pA')");
    await act("input('[data-zs-library] input[placeholder*=搜]','alpha')");
    let s = await call('search.query'); await resolveCall(s.i, search('SEARCH_A'));
    await until(text, (x) => x.includes('SEARCH_A'), 'search A');
    await act("focus('pB')"); s = await call('search.query', s.i);
    result.assertions.libraryOldScopeHidden = !(await text()).includes('SEARCH_A');
    await resolveCall(s.i, search('SEARCH_B', 'pB'));
    await until(text, (x) => x.includes('SEARCH_B'), 'search B');
    await act("click('[data-zs-library] .page-filters .btn')");
    const sf = await call('search.query', s.i); await failCall(sf.i, 'CONTROLLED_SEARCH_FAIL');
    await until(text, (x) => x.includes('CONTROLLED_SEARCH_FAIL'), 'search failure');
    result.assertions.libraryFailureKeepsFacts = (await text()).includes('SEARCH_B');
    await act("click('[data-zs-library] button[role=tab]:nth-child(2)')");
    const saved = await call('saved.list');
    await resolveCall(saved.i, { items: [{ kind: 'task', ref: 'task_A', title: 'SAVED_A', projectId: 'pA', createdAt: 1, status: 'ok', locate: '#task=task_A' }, { kind: 'task', ref: 'task_B', title: 'SAVED_B', projectId: 'pB', createdAt: 1, status: 'ok', locate: '#task=task_B' }, { kind: 'link', ref: 'https://example.invalid', title: 'SAVED_LINK', projectId: null, createdAt: 1, status: 'ok', locate: null }] });
    await until(text, (x) => x.includes('SAVED_B'), 'saved B');
    result.assertions.libraryProjectFilter = !(await text()).includes('SAVED_A') && !(await text()).includes('SAVED_LINK');
    await act("click('[data-zs-library] [aria-label=\"搜索范围\"]')");
    await until(text, (x) => x.includes('侧栏可见项目'), 'saved scope options');
    await act("click('[data-zs-library] [data-zs-option=\"visible\"]')");
    await sleep(120);
    result.assertions.libraryVisiblePinned = (await text()).includes('SAVED_A') && (await text()).includes('SAVED_B') && !(await text()).includes('SAVED_LINK');
    // Unmount while a saved.list request is pending; its late response cannot repopulate the page.
    await act("click('[data-zs-library] button[role=tab]:nth-child(1)')");
    await act("click('[data-zs-library] button[role=tab]:nth-child(2)')");
    const late = await call('saved.list', saved.i);
    await act('unmount()'); await resolveCall(late.i, { items: [{ kind: 'task', ref: 'late', title: 'AFTER_UNMOUNT', projectId: 'pA', createdAt: 2, status: 'ok', locate: '#task=late' }] });
    result.assertions.unmountNoLateRender = (await text()) === '';
    result.pass = Object.values(result.assertions).every(Boolean);
  } catch (error) { result.errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); }
  finally { if (cdp) await Promise.race([cdp.eval('window.close();true').catch(() => {}), sleep(2000)]); killOwn(dir); child.kill(); }
  return result;
}
(async () => {
  const names = ['PendingPage.tsx', 'ActivityPage.tsx', 'LibraryPage.tsx'];
  const current = Object.fromEntries(names.map((n) => [n, readFileSync(join(repo, 'src', 'ui', 'hifi', n), 'utf8')]));
  const old = Object.fromEntries(names.map((n) => [n, execFileSync('git', ['-C', repo, 'show', `d87f699:src/ui/hifi/${n}`], { encoding: 'utf8' })]));
  const baseline = await runCase('baseline-d87f699', old);
  const repaired = await runCase('current', current);
  const report = { baseline, current: repaired, pass: repaired.pass && !baseline.pass };
  writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, baselinePass: baseline.pass, currentPass: repaired.pass, pass: report.pass, currentErrors: repaired.errors }));
  process.exit(report.pass ? 0 : 1);
})().catch((error) => { console.error(error?.stack ?? error); process.exit(1); });
