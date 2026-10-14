#!/usr/bin/env node
/** Final daily launcher × external engineering daemon × real desktop UI workflow. */
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, console, WebSocket, fetch, AbortSignal, setTimeout, clearTimeout, Buffer, __dirname */
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const repo = path.resolve(__dirname, '..');
const port = process.argv.includes('--port')?Number(process.argv[process.argv.indexOf('--port')+1]):9782;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const opt = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const srcArg = opt('--src');
if (!srcArg) throw new Error('usage: node scripts/verify-r78-workflow-launcher.cjs --src <final-v17-daily-package> [--out <fresh-evidence-dir>]');
const src = path.resolve(srcArg);
const out = path.resolve(opt('--out') ?? path.join(repo, 'dist', 'desktop', `review-r78-workflow-launcher-${Date.now()}`));
const copy = path.join(out, 'copy');
const data = path.join(copy, 'server-data');
const packed = path.join(copy, 'ZhongshuoDual');
const resultPath = path.join(out, 'result.json');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const must = (condition, message) => { if (!condition) throw new Error(message); };
const now = () => Date.now();
const until = async (read, good, label, timeoutMs = 45_000) => {
  const deadline = now() + timeoutMs;
  let last;
  while (now() < deadline) {
    last = await read();
    if (good(last)) return last;
    await sleep(180);
  }
  throw new Error(`${label} timeout; last=${JSON.stringify(last)?.slice(0, 380)}`);
};
const dbOpen = () => new (require(path.join(repo, 'node_modules', 'better-sqlite3')))(path.join(data, 'state.sqlite'), { readonly: true });
const queryOne = (sql, ...args) => { const d = dbOpen(); try { return d.prepare(sql).get(...args); } finally { d.close(); } };
const queryAll = (sql, ...args) => { const d = dbOpen(); try { return d.prepare(sql).all(...args); } finally { d.close(); } };
async function portIsFree() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve) => server.close(resolve));
    return true;
  } catch { try { server.close(); } catch { /* no listener */ } return false; }
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.next = 0; this.pending = new Map(); this.errors = [];
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id != null) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);

      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.errors.push({ type: 'console.error', text: String(msg.params.args?.map((x) => x.value ?? x.description ?? '').join(' ')).slice(0, 500) });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.errors.push({ type: 'uncaught', text: String(msg.params?.exceptionDetails?.exception?.description ?? msg.params?.exceptionDetails?.text ?? 'unknown').slice(0, 700) });
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} CDP timeout`)); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`UI eval: ${String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 380)}`);
    return r.result.value;
  }
  async shot(name) {
    await this.eval('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await sleep(120);
    const png = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name), Buffer.from(png.data, 'base64'));
  }
}
async function connectUi(label) {
  const page = await until(async () => {
    try {
      const rows = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      return rows.find((r) => r.type === 'page' && String(r.url).includes('index.html')) ?? null;
    } catch { return null; }
  }, (v) => v != null, `${label} CDP`, 70_000);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); setTimeout(() => reject(new Error('WebSocket timeout')), 6000); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await until(() => cdp.eval("document.body?.classList.contains('hifi-on') === true && typeof window.zs?.command === 'function'"), (v) => v === true, `${label} hifi bridge`, 70_000);
  return { cdp, page };
}
const js = (body) => `(() => { ${body} })()`;
const button = (scope, label) => js(`const base = document.querySelector(${JSON.stringify(scope)}); const b = [...(base?.querySelectorAll('button') ?? [])].find(x => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true;`);
async function inputText(cdp, selector, value) {
  const ok = await cdp.eval(js(`const ta=document.querySelector(${JSON.stringify(selector)});if(!ta)return false;const proto=ta instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(ta,${JSON.stringify(value)});ta.dispatchEvent(new Event('input',{bubbles:true}));return true;`));
  must(ok, `input missing: ${selector}`);
}
async function uiSend(cdp, text, mentionId) {
  await until(() => cdp.eval("document.querySelector('#hifi-root textarea.composer-input') != null"), (v) => v, 'composer');
  await inputText(cdp, '#hifi-root textarea.composer-input', text);
  if (mentionId != null) {
    must(await cdp.eval(js("const b=document.querySelector('#hifi-root button[title^=\"提及成员\"]');if(!b)return false;b.click();return true;")), 'mention picker missing');
    await until(() => cdp.eval(`document.querySelector(${JSON.stringify(`[data-zs-mention-option="${mentionId}"]`)}) != null`), (v) => v, 'member mention option');
    must(await cdp.eval(js(`const b=document.querySelector(${JSON.stringify(`[data-zs-mention-option="${mentionId}"]`)});if(!b)return false;b.click();return true;`)), 'member mention selection failed');
  }
  await until(() => cdp.eval("document.querySelector('#hifi-root button.composer-send:not([disabled])') != null"), (v) => v, 'send enabled');
  must(await cdp.eval(js("const b=document.querySelector('#hifi-root button.composer-send'); if(!b)return false;b.click();return true;")), 'send button missing');
}
async function command(cdp, method, params) {
  const envelope = { protocolVersion: 1, commandId: `r78-ui-${randomUUID()}`, method, params };
  const result = await cdp.eval(`window.zs.command(${JSON.stringify(envelope)})`);
  must(result?.ok === true, `${method}: ${JSON.stringify(result?.error)}`);
  return result.data;
}
async function rawCommand(cdp, method, params) {
  return cdp.eval(`window.zs.command(${JSON.stringify({ protocolVersion: 1, commandId: `r78-ui-${randomUUID()}`, method, params })})`);
}
async function navigate(cdp, route, expected) {
  await cdp.eval(`location.hash=${JSON.stringify(route)};true`);
  await until(() => cdp.eval(`location.hash.includes(${JSON.stringify(expected)})`), (v) => v, `route ${route}`);
}
async function closeUi(cdp) {
  if (cdp == null) return;
  await Promise.race([cdp.eval('window.close(); true').catch(() => {}), sleep(2500)]);
}
async function watchDelivery(cdp, taskId, revision, label, queueSeen = false) {
  const observed = { queuedLive: queueSeen, queuedViaOutbox: false, running: false, progressInUi: false };
  const delivery = await until(async () => {
    const outbox = queryOne('SELECT status FROM outbox WHERE dispatch_key LIKE ? ORDER BY rowid DESC LIMIT 1', `%task:${taskId}:%`);
    const run = queryOne('SELECT status FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1', taskId);
    if (outbox != null) observed.queuedViaOutbox = true;
    if (outbox?.status === 'pending' || outbox?.status === 'leased') observed.queuedLive = true;
    if (run?.status === 'RUNNING') observed.running = true;
    try { if (await cdp.eval("document.body.textContent.includes('正在生成成果文件')")) observed.progressInUi = true; } catch { /* navigation in flight */ }
    return queryOne('SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id=? AND revision=?', taskId, revision);
  }, (v) => v?.id != null, `${label} delivery`, 55_000);
  if (!observed.progressInUi) {
    observed.progressInUi = await until(() => cdp.eval("document.body.textContent.includes('正在生成成果文件')"), (v) => v === true, `${label} progress reply visible`, 12_000);
  }
  must(observed.queuedViaOutbox && observed.running && observed.progressInUi, `${label} queue/run/progress missing: ${JSON.stringify(observed)}`);
  return { delivery, observed };
}
function killOwnCopy() {
  // Only processes whose *resolved executable* belongs to this created copy are stopped.
  const prefix = (copy + path.sep).replaceAll("'", "''");
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { windowsHide: true, timeout: 30_000, stdio: 'ignore' });
}
function verifyManifest(packageRoot) {
  const build = JSON.parse(fs.readFileSync(path.join(packageRoot, 'BUILD.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'MANIFEST-SHA256.json'), 'utf8'));
  must(build.buildId === manifest.buildId, 'BUILD/manifest buildId mismatch');
  let checked = 0;
  for (const f of manifest.files) {
    const file = path.join(packageRoot, f.path);
    must(fs.existsSync(file), `manifest missing ${f.path}`);
    must(sha(file) === f.sha256, `manifest hash mismatch ${f.path}`);
    checked += 1;
  }
  return { build, checked };
}

(async () => {
  must(fs.existsSync(src) && fs.existsSync(path.join(src, 'start-desktop.bat')), `--src is not a daily package: ${src}`);
  must(!fs.existsSync(out), `evidence output already exists: ${out}`);
  must(!out.toLowerCase().startsWith((src + path.sep).toLowerCase()), 'evidence output cannot be inside source package');
  must(!fs.existsSync(path.join(src, 'server-data')), 'source package contains a data root; refusing to copy user data');
  const portProbe = net.createServer();
  await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve) => portProbe.close(resolve));
  const source = verifyManifest(path.join(src, 'ZhongshuoDual'));
  fs.mkdirSync(out, { recursive: true });
  const copied = spawnSync('robocopy', [src, copy, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000, encoding: 'utf8' });
  must(copied.status != null && copied.status < 8, `robocopy failed: ${copied.status} ${copied.stderr}`);
  const target = verifyManifest(packed);
  must(source.build.buildId === target.build.buildId, 'copied BUILD differs from --src');
  must(sha(path.join(src, 'start-desktop.bat')) === sha(path.join(copy, 'start-desktop.bat')), 'launcher BAT modified');
  fs.mkdirSync(path.join(data, 'engineering'), { recursive: true });
  const shortPipe = `zs-daily-${randomUUID()}`;
  fs.writeFileSync(path.join(data, 'pipe-name.txt'), `${shortPipe}\r\n`);
  const entry = path.join(data, 'engineering', 'daemon.cjs');
  require('esbuild').buildSync({ entryPoints: [path.join(repo, 'scripts', 'lib', 'r78-live-engineering-daemon.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node24', outfile: entry });
  const token = `${randomUUID()}-${randomUUID()}`;
  const marker = { token, appDataDir: data, daemonEntry: entry };
  fs.writeFileSync(path.join(data, 'engineering-r78.json'), JSON.stringify(marker, null, 2));
  const project = path.join(out, 'R78 UI 工程项目');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# R78 UI 工程项目\n');
  const facts = { pass: false, source: src, copy, buildId: source.build.buildId, sourceManifestChecked: source.checked, copyManifestChecked: target.checked, launcherSha256: sha(path.join(copy, 'start-desktop.bat')), port, project, steps: [], ui: { sessions: [] } };
  let bat = null; let cdp = null;
  const captureUi = (label) => { if (cdp != null) facts.ui.sessions.push({ label, errors: cdp.errors }); };
  const start = (overrides = {}) => {
    const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(port), ZS_R78_ENGINEERING_TOKEN: token, ZS_DAEMON_ENTRY: entry };
    for (const key of ['ZS_RUNTIME', 'ZS_ALLOW_FAKE', 'ZS_APP_DATA', 'ZS_PIPE_NAME', 'ZS_REAL_DISPATCH_GUARD', 'ZS_PACKED_ENTRY']) delete env[key];
    Object.assign(env, overrides);
    bat = spawn('cmd', ['/c', 'start-desktop.bat'], { cwd: copy, env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    bat.stdout.on('data', (chunk) => fs.appendFileSync(path.join(out, 'launcher.stdout.log'), chunk));
    bat.stderr.on('data', (chunk) => fs.appendFileSync(path.join(out, 'launcher.stderr.log'), chunk));
    return bat;
  };
  const expectRejectedLaunch = async (name, overrides) => {
    const child = start(overrides);
    const code = await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(12_000).then(() => 'timeout'),
    ]);
    must(code === 9, `${name} BAT did not reject with 9: ${code}`);
    must(!fs.existsSync(path.join(data, 'engineering', 'ready.json')), `${name} started helper`);
    must(!fs.existsSync(path.join(data, 'daemon.pid')), `${name} started daemon`);
    facts.steps.push(`${name}: BAT refused before spawning UI/daemon`);
  };
  try {
    // Negative gate: polluted parent flags and missing engineering token must still start the
    // ordinary claude-default daemon. The helper must not run, and no model call is made.
    start({ ZS_R78_ENGINEERING_TOKEN: '', ZS_DAEMON_ENTRY: entry, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1' });
    ({ cdp } = await connectUi('default-flag-negative'));
    const normal = await command(cdp, 'runtime.status', {});
    must(normal.dispatchGuard?.fakeAllowed === false && normal.dispatchGuard?.realDispatchGuard === false, 'BAT leaked fake/guard parent flags without token');
    must(!fs.existsSync(path.join(data, 'engineering', 'ready.json')), 'helper started without token');
    const ordinaryA = path.join(out, 'ordinary-project-A'); const ordinaryB = path.join(out, 'ordinary-project-B');
    fs.mkdirSync(ordinaryA); fs.mkdirSync(ordinaryB);
    const normalA = (await command(cdp, 'project.open', { path: ordinaryA, displayName: 'Ordinary A' })).project.id;
    const normalB = (await command(cdp, 'project.open', { path: ordinaryB, displayName: 'Ordinary B' })).project.id;
    await navigate(cdp, `/project/${normalA}/room/room_default_${normalA}`, normalA);
    await until(() => cdp.eval("document.querySelector('#hifi-root textarea.composer-input') != null"), (v) => v, 'ordinary A room');
    await navigate(cdp, `/project/${normalB}/room/room_default_${normalB}`, normalB);
    await until(() => cdp.eval("document.querySelector('#hifi-root textarea.composer-input') != null"), (v) => v, 'ordinary B room');
    must(queryOne('SELECT count(*) c FROM real_calls').c === 0, 'ordinary project switching called model');
    facts.steps.push('default gate clears fake/runtime/guard/entry overrides');
    captureUi('ordinary-first');
    await closeUi(cdp); cdp = null;
    await until(() => !fs.existsSync(path.join(data, 'daemon.pid')), (v) => v, 'default daemon graceful exit', 30_000);
    await until(portIsFree, (v) => v, 'ordinary CDP port released', 30_000);
    start({ ZS_R78_ENGINEERING_TOKEN: '', ZS_DAEMON_ENTRY: entry, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1' });
    ({ cdp } = await connectUi('ordinary-reopen'));
    const normalReopen = await command(cdp, 'runtime.status', {});
    must(normalReopen.dispatchGuard?.fakeAllowed === false && normalReopen.dispatchGuard?.realDispatchGuard === false, 'ordinary reopen enabled fake');
    await navigate(cdp, `/project/${normalA}/room/room_default_${normalA}`, normalA);
    await until(() => cdp.eval("document.querySelector('#hifi-root textarea.composer-input') != null"), (v) => v, 'ordinary reopen A');
    await navigate(cdp, `/project/${normalB}/room/room_default_${normalB}`, normalB);
    await until(() => cdp.eval("document.querySelector('#hifi-root textarea.composer-input') != null"), (v) => v, 'ordinary reopen B');
    must(!fs.existsSync(path.join(data, 'engineering', 'ready.json')) && queryOne('SELECT count(*) c FROM real_calls').c === 0, 'ordinary reopen helper/call leakage');
    facts.steps.push('ordinary no-helper launcher opens A/B, closes, reopens A/B with zero model calls');
    captureUi('ordinary-reopen');
    await closeUi(cdp); cdp = null;
    await until(() => !fs.existsSync(path.join(data, 'daemon.pid')), (v) => v, 'ordinary reopen daemon graceful exit', 30_000);
    await until(portIsFree, (v) => v, 'ordinary reopen CDP port released', 30_000);
    // Negative gates: a nonmatching token, absent debug port, or different canonical root must
    // refuse startup (exit 9), without silently falling back to the ordinary daemon.
    await expectRejectedLaunch('marker token mismatch', { ZS_R78_ENGINEERING_TOKEN: `${token}-wrong` });
    await expectRejectedLaunch('missing debug port', { ZS_DEV25_DEBUG_PORT: '' });
    fs.writeFileSync(path.join(data, 'engineering-r78.json'), JSON.stringify({ ...marker, appDataDir: path.join(out, 'other-root') }, null, 2));
    await expectRejectedLaunch('marker canonical data-root mismatch');
    fs.writeFileSync(path.join(data, 'engineering-r78.json'), JSON.stringify(marker, null, 2));

    start();
    await until(() => fs.existsSync(path.join(data, 'engineering', 'ready.json')), (v) => v, 'engineering daemon ready', 35_000);
    const ready = JSON.parse(fs.readFileSync(path.join(data, 'engineering', 'ready.json'), 'utf8'));
    must(ready.buildId === target.build.buildId && ready.packedEntry === path.join(packed, 'resources', 'app', 'daemon', 'daemon.cjs') && ready.fakeAdapterInjected === true, 'daemon ready source mismatch');
    facts.daemon = ready; facts.steps.push('packaged daemon startDaemon+fake adapter attached via unmodified BAT');
    ({ cdp } = await connectUi('initial'));
    const simulated = await command(cdp, 'runtime.status', {});
    must(simulated.dispatchGuard?.fakeAllowed === true && simulated.dispatchGuard?.realDispatchGuard === true, 'engineering daemon did not retain fake/real-dispatch guard');
    const opened = await command(cdp, 'project.open', { path: project, displayName: 'R78 UI 工程项目', agentNames: ['R78 UI 模拟员'] });
    const projectId = opened.project.id;
    const meta = queryOne('SELECT revision FROM projects WHERE id=?', projectId);
    await command(cdp, 'project.reviewPolicy.set', { projectId, taskReviewEnabled: true, expectedRevision: meta.revision });
    const members = await command(cdp, 'member.list', { projectId });
    const memberId = members.items.find((m) => m.principalType === 'agent')?.id;
    must(memberId != null, 'project bootstrap agent missing');
    const room = (await command(cdp, 'room.create', { projectId, name: 'R78 UI 流程房间', memberIds: [memberId] })).room;
    const dm = await command(cdp, 'conversation.create', { projectId, peerMemberId: memberId, title: 'R78 UI 流程私信' });
    facts.ids = { projectId, memberId, roomId: room.id, roomConversationId: room.conversationId, dmConversationId: dm.conversationId };

    if(process.argv.includes('--r80-unknown')){
      facts.unknown=await require('./verify-r80-unknown-extension.cjs')({cdp,projectId,room,memberId,project,data,out,command,navigate,inputText,until,queryOne,queryAll,must,sleep,button,facts,reopen:async()=>{
        await closeUi(cdp);cdp=null;await until(()=>!fs.existsSync(path.join(data,'daemon.pid')),Boolean,'unknown test daemon graceful close',30000);await until(portIsFree,Boolean,'unknown test old UI closed',30000);start();await until(()=>fs.existsSync(path.join(data,'engineering','ready.json')),Boolean,'unknown test reopen ready',35000);({cdp}=await connectUi('unknown-reopen'));return cdp;
      }});
      captureUi('unknown-envelope-final');facts.pass=facts.unknown.pass&&facts.ui.sessions.every(s=>s.errors.length===0);facts.steps.push(facts.unknown.retainedUnknown?'R84 legacy compatibility source: dropped committed receipt, original envelope retained across reopen; no replay performed':'R80 dropped committed submit receipt, ordinary reopen keeps original envelope and draft; explicit same-ID replay creates no duplicate');
    }else{
    await navigate(cdp, `/project/${projectId}/room/${room.id}`, `/room/${room.id}`);
    await uiSend(cdp, 'R78 UI ROOM：请生成工程交付并等待我验收', memberId);
    const roomTask = await until(() => queryOne('SELECT id, conversation_thread_id AS threadId FROM tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1', room.conversationId), (v) => v?.id != null, 'room UI task');
    facts.ids.roomTaskId = roomTask.id; facts.ids.roomThreadId = roomTask.threadId;
    const roomQueued = queryOne('SELECT status FROM outbox WHERE dispatch_key=?', `task:${roomTask.id}:initial`)?.status === 'pending';
    await navigate(cdp, `/thread/${roomTask.threadId}?tab=replies`, roomTask.threadId);
    const roomWatch = await watchDelivery(cdp, roomTask.id, 1, 'room v1', roomQueued);
    const roomD1 = roomWatch.delivery; facts.ui.roomV1 = roomWatch.observed;
    must(fs.existsSync(path.join(project, 'results', 'r78-ui-room-v1.md')), 'room v1 file missing');
    await navigate(cdp, `/thread/${roomTask.threadId}?tab=artifacts`, roomTask.threadId);
    await until(() => cdp.eval(`document.querySelector(${JSON.stringify(`[data-zs-delivery-row="${roomD1.id}"]`)}) != null`), (v) => v, 'room result row UI');
    must(await cdp.eval(button(`[data-zs-delivery-row="${roomD1.id}"]`, '打开文档')), 'room delivery preview button missing');
    await until(() => cdp.eval("document.querySelector('[data-zs-delivery-doc=\"1\"]') != null"), (v) => v, 'delivery document preview');
    must(await cdp.eval(js("const b=document.querySelector('[data-zs-delivery-file=\"results/r78-ui-room-v1.md\"]');if(!b)return false;b.click();return true;")), 'delivery source-file button missing');
    await until(() => cdp.eval("document.body.textContent.includes('由正式打包 worker 与显式工程 Fake adapter')"), (v) => v, 'real source file preview');
    facts.steps.push('room result tab opens delivery document and actual worktree file');
    await navigate(cdp, '/board', '/board');
    await until(() => cdp.eval("[...document.querySelectorAll('#hifi-root .card')].some(c=>c.textContent.includes('R78 UI ROOM') && c.textContent.includes('待验收'))"), (v) => v, 'board pending card');
    must(await cdp.eval(js("const c=[...document.querySelectorAll('#hifi-root .card')].find(c=>c.textContent.includes('R78 UI ROOM')&&c.textContent.includes('待验收'));if(!c)return false;c.click();return true;")), 'board locate failed');
    await until(() => cdp.eval(`location.hash.includes(${JSON.stringify(roomTask.threadId)})`), (v) => v, 'board task link');
    await navigate(cdp, '/pending', '/pending');
    const pendingNeedle = roomTask.id.slice(0, 12);
    await until(() => cdp.eval(`document.querySelector('[data-zs-pending=hifi]')?.textContent.includes(${JSON.stringify(pendingNeedle)}) === true || document.querySelector('[data-zs-pending=hifi]')?.textContent.includes('R78 UI ROOM') === true`), (v) => v, 'pending review item');
    must(await cdp.eval(js(`const c=[...document.querySelectorAll('[data-zs-pending=hifi] .row.tight')].find(c=>c.textContent.includes(${JSON.stringify(pendingNeedle)})||c.textContent.includes('R78 UI ROOM'));const b=[...(c?.querySelectorAll('button')??[])].find(b=>b.textContent.trim()==='定位');if(!b)return false;b.click();return true;`)), 'pending locate failed');
    await until(() => cdp.eval(`location.hash.includes(${JSON.stringify(roomTask.threadId)})`), (v) => v, 'pending task link');
    facts.steps.push('board/pending locate same room task while v1 awaits review');
    await navigate(cdp, `/thread/${roomTask.threadId}?tab=delivery`, roomTask.threadId);
    await until(() => cdp.eval("document.body.textContent.includes('交付与验收') && document.body.textContent.includes('待验收交付')"), (v) => v, 'room review UI');
    must(await cdp.eval(button('#hifi-root', '要求返工')), 'room UI rework button missing');
    await inputText(cdp, 'textarea[placeholder^="返工意见"]', 'R78 UI ROOM：第二版请补充完整结论');
    must(await cdp.eval(button('#hifi-root', '提交返工意见')), 'room submit review missing');
    await until(() => queryOne('SELECT review_status FROM task_deliveries WHERE id=?', roomD1.id)?.review_status, (v) => v === 'changes_requested', 'room review recorded');
    must(queryAll('SELECT id FROM workflow_runs WHERE task_id=?', roomTask.id).length === 1, 'room review auto-dispatched');
    await until(() => cdp.eval("document.body.textContent.includes('返工意见已记录、尚未执行')"), (v) => v, 'room rework pending UI');
    must(await cdp.eval(button('#hifi-root', '执行返工')), 'room execute rework missing');
    const roomD2 = await until(() => queryOne('SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id=? AND revision=2', roomTask.id), (v) => v?.id != null, 'room v2 delivery');
    must(fs.existsSync(path.join(project, 'results', 'r78-ui-room-v2.md')), 'room v2 file missing');
    for (const deliveryId of [roomD1.id, roomD2.id]) {
      const document = await command(cdp, 'delivery.document', { deliveryId });
      must(document.hashMatch === true && document.text?.includes('R78 UI ROOM'), `room delivery document hash mismatch: ${deliveryId}`);
    }
    const staleRoom = await rawCommand(cdp, 'task.review', { taskId: roomTask.id, deliveryId: roomD1.id, deliveryRevision: 1, manifestHash: roomD1.manifest_hash, decision: 'accept' });
    must(staleRoom.ok === false && staleRoom.error?.code === 'STALE_REVISION', `old room delivery accepted: ${JSON.stringify(staleRoom)}`);
    facts.steps.push('stale room v1 acceptance rejected while v2 awaits review');
    await until(() => cdp.eval("document.body.textContent.includes('待验收交付') && document.body.textContent.includes('v2')"), (v) => v, 'room v2 review UI');
    await until(() => cdp.eval("[...document.querySelectorAll('#hifi-root button')].some(b=>b.textContent.trim()==='验收通过'&&!b.disabled)"),Boolean,'room current review snapshot action ready');
    must(await cdp.eval(button('#hifi-root', '验收通过')), 'room accept missing');
    must(await cdp.eval(button('#hifi-root', '确认验收')), 'room confirm accept missing');
    await until(() => queryOne('SELECT status FROM tasks WHERE id=?', roomTask.id)?.status, (v) => v === 'DONE', 'room DONE');
    facts.steps.push('room UI send→natural v1/file→review note→explicit rework→natural v2/file→accept');
    await navigate(cdp, `/thread/${roomTask.threadId}?tab=replies`, roomTask.threadId);
    await until(() => cdp.eval("document.querySelector('#hifi-root button[data-zs-saved=\"0\"]') != null"), (v) => v, 'room bookmark button');
    // R83 now also shows the original root. This regression bookmarks a reply,
    // whose formal saved locator is a thread; root bookmarks return to the pool.
    must(await cdp.eval(js("const b=[...document.querySelectorAll('#hifi-root button[data-zs-saved=\"0\"]')].at(-1);if(!b)return false;b.click();return true;")), 'room reply bookmark click failed');
    await navigate(cdp, '/library', '/library');
    await until(() => cdp.eval("document.querySelector('[data-zs-library=hifi]') != null"), (v) => v, 'library UI');
    await inputText(cdp, '[data-zs-library=hifi] input[placeholder*="搜消息"]', 'R78 UI ROOM');
    await cdp.eval(js("const i=document.querySelector('[data-zs-library=hifi] input[placeholder*=\"搜消息\"]');i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;"));
    await until(() => cdp.eval("[...document.querySelectorAll('[data-zs-library=hifi] button.card')].some(b=>b.textContent.includes('R78 UI ROOM'))"), (v) => v, 'library search hit');
    must(await cdp.eval(js("const b=[...document.querySelectorAll('[data-zs-library=hifi] button.card')].find(b=>b.textContent.includes('R78 UI ROOM'));if(!b)return false;b.click();return true;")), 'library search locate failed');
    await until(() => cdp.eval(`location.hash.includes(${JSON.stringify(roomTask.threadId)})`), (v) => v, 'search task link');
    await navigate(cdp, '/library', '/library');
    must(await cdp.eval(js("const b=[...document.querySelectorAll('[data-zs-library=hifi] button[role=tab]')].find(b=>b.textContent.includes('收藏'));if(!b)return false;b.click();return true;")), 'library saved tab missing');
    await until(() => cdp.eval("document.querySelector('[data-zs-library=hifi] button[title^=\"定位：\"]') != null"), (v) => v, 'saved item');
    must(await cdp.eval(js("const b=document.querySelector('[data-zs-library=hifi] button[title^=\"定位：\"]');if(!b)return false;b.click();return true;")), 'saved locate failed');
    await until(() => cdp.eval(`location.hash.includes(${JSON.stringify(roomTask.threadId)})`), (v) => v, 'saved task link');
    await navigate(cdp, '/activity', '/activity');
    await until(() => cdp.eval("document.querySelector('[data-zs-activity-item=\"task.reviewRecorded\"] button') != null"), (v) => v, 'activity review event');
    must(await cdp.eval(js("const b=document.querySelector('[data-zs-activity-item=\"task.reviewRecorded\"] button');if(!b)return false;b.click();return true;")), 'activity locate failed');
    await until(() => cdp.eval(`location.hash.includes(${JSON.stringify(roomTask.threadId)})`), (v) => v, 'activity task link');
    facts.steps.push('search/saved/activity UI locate the same room task');

    await navigate(cdp, `/dm/${dm.conversationId}`, dm.conversationId);
    await uiSend(cdp, 'R78 UI DM：请生成工程交付并等待我验收');
    const dmTask = await until(() => queryOne('SELECT id FROM tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1', dm.conversationId), (v) => v?.id != null, 'DM UI task');
    facts.ids.dmTaskId = dmTask.id;
    const dmQueued = queryOne('SELECT status FROM outbox WHERE dispatch_key=?', `dmtask:${dmTask.id}:initial`)?.status === 'pending';
    const dmWatch = await watchDelivery(cdp, dmTask.id, 1, 'DM v1', dmQueued);
    const dmD1 = dmWatch.delivery; facts.ui.dmV1 = dmWatch.observed;
    must(fs.existsSync(path.join(project, 'results', 'r78-ui-dm-v1.md')), 'DM v1 file missing');
    await until(() => cdp.eval("document.querySelector('[data-zs-dm-review=hifi]') != null"), (v) => v, 'DM review UI');
    must(await cdp.eval(button('[data-zs-dm-review=hifi]', '要求返工')), 'DM rework missing');
    await inputText(cdp, '[data-zs-dm-review=hifi] textarea[placeholder^="返工意见"]', 'R78 UI DM：第二版请补充完整结论');
    must(await cdp.eval(button('[data-zs-dm-review=hifi]', '提交返工意见')), 'DM submit review missing');
    await until(() => queryOne('SELECT review_status FROM task_deliveries WHERE id=?', dmD1.id)?.review_status, (v) => v === 'changes_requested', 'DM review recorded');
    must(queryAll('SELECT id FROM workflow_runs WHERE task_id=?', dmTask.id).length === 1, 'DM review auto-dispatched');
    await until(() => cdp.eval("document.querySelector('[data-zs-dm-rework-state=recorded]') != null"), (v) => v, 'DM rework pending UI');
    await until(() => cdp.eval("document.querySelector('[data-zs-dm-rework-run]:not([disabled])') != null"), (v) => v, 'DM execute rework enabled');
    must(await cdp.eval(button('[data-zs-dm-rework=hifi]', '执行返工')), 'DM execute rework missing');
    const dmD2 = await until(() => queryOne('SELECT id, revision FROM task_deliveries WHERE task_id=? AND revision=2', dmTask.id), (v) => v?.id != null, 'DM v2 delivery');
    must(fs.existsSync(path.join(project, 'results', 'r78-ui-dm-v2.md')), 'DM v2 file missing');
    for (const deliveryId of [dmD1.id, dmD2.id]) {
      const document = await command(cdp, 'delivery.document', { deliveryId });
      must(document.hashMatch === true && document.text?.includes('R78 UI DM'), `DM delivery document hash mismatch: ${deliveryId}`);
    }
    await until(() => cdp.eval("document.querySelector('[data-zs-dm-review=hifi]')?.textContent.includes('v2') === true"), (v) => v, 'DM v2 UI');
    must(await cdp.eval(button('[data-zs-dm-review=hifi]', '验收通过')), 'DM accept missing');
    must(await cdp.eval(button('[data-zs-dm-review=hifi]', '确认验收')), 'DM confirm accept missing');
    await until(() => queryOne('SELECT status FROM tasks WHERE id=?', dmTask.id)?.status, (v) => v === 'DONE', 'DM DONE');
    facts.steps.push('DM UI send→natural v1/file→review note→explicit rework→natural v2/file→accept');
    if (process.argv.includes('--r79')) {
      must(await cdp.eval(js("document.querySelector('[data-zs-dm-ops=hifi]')?.click();return true;")), 'DM records operations');
      must(await cdp.eval(button('body', '任务记录…')), 'DM task records entry');
      await until(() => cdp.eval("document.querySelector('[data-zs-dm-task-records]')?.textContent.includes('R78 UI DM') === true"), Boolean, 'DM completed task details');
      must(await cdp.eval(button('[data-zs-dm-task-records]', '查看这次运行')), 'DM historical run entry');
      await until(() => cdp.eval("document.querySelector('[data-zs-dm-task-records]')?.textContent.includes('执行成功') === true"), Boolean, 'DM historical run facts');
      must(await cdp.eval(button('[data-zs-dm-task-records] .details-subnav', '交付历史')), 'DM delivery history tab');
      await until(() => cdp.eval("(()=>{const t=document.querySelector('[data-zs-dm-task-records]')?.textContent;return t?.includes('交付 v1')&&t.includes('交付 v2')})()"), Boolean, 'DM both delivery versions');
      await cdp.shot('r79-dm-task-records.png');
      await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
      await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
      await until(() => cdp.eval("document.querySelector('[data-zs-dm-task-records]') == null && document.querySelector('#hifi-root textarea.composer-input') != null"), Boolean, 'DM records closes to composer');
      facts.dmRecords={sameTask:dmTask.id,completed:true,historicalRun:true,versions:[1,2],closedToConversation:true};
      facts.steps.push('R79 DM completed-task records read historical run and both natural delivery versions, then close to the mounted conversation');
    }
    must(await cdp.eval(js("const b=document.querySelector('[data-zs-dm-ops=hifi]');if(!b)return false;b.click();return true;")), 'DM operations menu missing');
    must(await cdp.eval(button('body', '归档会话…')), 'DM archive menu item missing');
    await until(() => queryOne('SELECT archived_at FROM conversations WHERE id=?', dm.conversationId)?.archived_at, (v) => v != null, 'DM archived');
    await until(() => cdp.eval("document.body.textContent.includes('已归档 · 只读') && document.querySelector('#hifi-root textarea.composer-input') == null"), (v) => v, 'DM archived read-only UI');
    must(await cdp.eval(js("const b=document.querySelector('[data-zs-dm-ops=hifi]');if(!b)return false;b.click();return true;")), 'DM operations reopen missing');
    must(await cdp.eval(button('[role=menu]', '取消归档')), 'DM restore visible menu item missing');
    await until(() => queryOne('SELECT archived_at FROM conversations WHERE id=?', dm.conversationId)?.archived_at, (v) => v === null, 'DM restored');
    await until(() => cdp.eval("document.querySelector('#hifi-root textarea.composer-input') != null"), (v) => v, 'DM restored composer');
    must(queryAll('SELECT id FROM workflow_runs WHERE task_id=?', dmTask.id).length === 2, 'DM archive/restore auto-dispatched');
    facts.steps.push('DM archive read-only and explicit restore preserve task/versions without dispatch');

    // Separate failure branch: stop a genuinely running room turn through the visible Composer
    // button. This task is not counted as a delivery, and no unknown protection is relaxed.
    await navigate(cdp, `/project/${projectId}/room/${room.id}`, `/room/${room.id}`);
    await uiSend(cdp, 'R78 UI STOP：请保持运行，等待我点击停止任务', memberId);
    const stopped = await until(() => queryOne("SELECT id, conversation_thread_id AS threadId FROM tasks WHERE conversation_id=? AND title LIKE 'R78 UI STOP%' ORDER BY rowid DESC LIMIT 1", room.conversationId), (v) => v?.id != null, 'stop UI task');
    await navigate(cdp, `/thread/${stopped.threadId}?tab=replies`, stopped.threadId);
    await until(() => cdp.eval("[...document.querySelectorAll('#hifi-root button')].some(b=>b.textContent.trim()==='停止任务' && !b.disabled)"), (v) => v, 'visible stop button', 20_000);
    must(await cdp.eval(button('#hifi-root', '停止任务')), 'stop button click failed');
    await until(() => queryOne('SELECT status FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1', stopped.id)?.status, (v) => v === 'CANCELLED', 'stopped run cancelled', 20_000);
    facts.ids.stoppedTaskId = stopped.id;
    facts.steps.push('room UI stop during active Fake turn→run CANCELLED; no delivery');

    if (process.argv.includes('--r79')) {
      facts.r79 = await require('./verify-r79-live-extension.cjs')({ cdp, projectId, room, memberId, project, data, out, command, rawCommand, navigate, uiSend, until, queryOne, queryAll, must, sleep, button, facts });
    }

    facts.deliveries = { room: [roomD1.id, roomD2.id], dm: [dmD1.id, dmD2.id] };
    facts.realCallsBeforeReopen = queryOne('SELECT count(*) c FROM real_calls').c;
    if(process.argv.includes('--r80'))facts.r80=await require('./verify-r80-recovery-extension.cjs')({cdp,projectId,room,dm,memberId,project,data,out,command,rawCommand,navigate,uiSend,until,queryOne,queryAll,must,sleep,button,facts,durationMs:process.argv.includes('--r84-observe')?2*60*60_000:30*60_000});
    must(facts.realCallsBeforeReopen === 0, 'real_calls is nonzero');
    await cdp.shot('r78-dm-accepted.png');
    captureUi('engineering-full-flow');
    await closeUi(cdp);
    cdp = null;
    await until(() => !fs.existsSync(path.join(data, 'daemon.pid')), (v) => v, 'daemon graceful exit', 30_000);
    must(!fs.existsSync(path.join(data, 'engineering', 'ready.json')), 'engineering ready marker survived shutdown');
    await until(portIsFree, (v) => v, 'old CDP port released before reopen', 30_000);
    start();
    await until(() => fs.existsSync(path.join(data, 'engineering', 'ready.json')), (v) => v, 'reopen engineering daemon ready', 35_000);
    const reopenedReady = JSON.parse(fs.readFileSync(path.join(data, 'engineering', 'ready.json'), 'utf8'));
    must(reopenedReady.pid !== ready.pid && reopenedReady.buildId === ready.buildId, 'reopen did not start same BUILD with new daemon PID');
    ({ cdp } = await connectUi('reopen'));
    await navigate(cdp, `/thread/${roomTask.threadId}?tab=delivery`, roomTask.threadId);
    await until(() => cdp.eval("document.body.textContent.includes('房间') && document.body.textContent.includes('交付与验收')"), (v) => v, 'reopen room');
    await navigate(cdp, `/dm/${dm.conversationId}`, dm.conversationId);
    await until(() => cdp.eval("document.body.textContent.includes('R78 UI DM')"), (v) => v, 'reopen DM');
    facts.steps.push('final launcher reopen preserves room/DM identities and deliveries');
    if (facts.r79) {
      await navigate(cdp, `/thread/${facts.r79.live.threadId}?tab=run`, facts.r79.live.threadId);
      await until(() => cdp.eval("document.body.textContent.includes('R79_LIVE_PROGRESS_MARKER')"), Boolean, 'R79 live history after reopen');
      await navigate(cdp, `/thread/${facts.r79.scale.threadId}?tab=run`, facts.r79.scale.threadId);
      await until(() => cdp.eval("document.querySelector('[data-zs-history=runs]')?.textContent.includes('已到历史起点') || [...document.querySelectorAll('[data-zs-history=runs] button')].some(b=>b.textContent.trim()==='加载更早历史'&&!b.disabled)"), Boolean, 'R79 reopened history read ready');
      if(!await cdp.eval("document.querySelector('[data-zs-history=runs]')?.textContent.includes('已到历史起点')"))must(await cdp.eval(button('[data-zs-history=runs]', '加载更早历史')), 'R79 history after reopen control');
      await until(() => cdp.eval("document.querySelector('[data-zs-history=runs]')?.textContent.includes('已到历史起点')"), Boolean, 'R79 older runs after reopen');
      facts.r79.reopen = true;
      await cdp.shot('r79-history-reopened.png');
      facts.steps.push('R79 completed live facts and older history remain reachable after real launcher reopen');
    }
    facts.realCalls = queryOne('SELECT count(*) c FROM real_calls').c;
    must(facts.realCalls === 0, 'real_calls after reopen nonzero');
    captureUi('engineering-reopen');
    facts.pass = facts.ui.sessions.every((s) => s.errors.length === 0)&&(!facts.r80||facts.r80.pass===true);
    if (!facts.pass) facts.error = `renderer errors: ${JSON.stringify(facts.ui.sessions.filter((s) => s.errors.length > 0))}`;
    }
  } catch (error) {
    captureUi('failed-step');
    facts.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    await closeUi(cdp);
    await sleep(1800);
    killOwnCopy();
    facts.finalRealCalls = fs.existsSync(path.join(data, 'state.sqlite')) ? queryOne('SELECT count(*) c FROM real_calls').c : null;
    if (facts.finalRealCalls !== 0) facts.pass = false;
    fs.writeFileSync(resultPath, JSON.stringify(facts, null, 2));
    console.log(JSON.stringify({ pass: facts.pass, resultPath, error: facts.error, steps: facts.steps, buildId: facts.buildId, realCalls: facts.finalRealCalls }));
  }
  process.exit(facts.pass ? 0 : 1);
})().catch((error) => { console.error(error?.stack ?? error); killOwnCopy(); process.exit(1); });
