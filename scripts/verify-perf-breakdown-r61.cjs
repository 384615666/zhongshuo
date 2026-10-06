'use strict';
/**
 * R61 P6c（review-r60 §7 末段）：性能分项——daemon 就绪 / 数据库查询 / 桌面 UI 可交互
 * 三层分开测量，不把单项耗时扩张为另一层（230ms 是 daemon 管道就绪，1–2ms 是 DB 查询，
 * 桌面可操作=窗口→hifi 壳挂载→项目自动打开另有其数）。
 * 环境：独立数据根+管道；打包形态 daemon（dist/pack/daemon.cjs）+ dev 形态 UI（dist/ui）。
 * 零模型调用（record_only 写入）；产物 dist/desktop/perf-breakdown-r61-<ts>/result.json。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r61-perf-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `perf-breakdown-r61-${runId}`);
const dataRoot = path.join(outDir, 'data');
const projDir = path.join(outDir, 'perf 项目');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const token = randomBytes(32).toString('hex');
const PORT = 9589;
const daemonCjs = path.join(repo, 'dist', 'pack', 'daemon.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pipeConnect() {
  return new Promise((resolve, reject) => {
    const sock = connect(pipeName);
    sock.setEncoding('utf8');
    let buf = '';
    const pending = new Map();
    let authed = false;
    const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); sock.destroy(); };
    const timer = setTimeout(() => { if (!authed) { failAll(new Error('管道握手超时')); reject(new Error('管道握手超时')); } }, 15000);
    sock.on('connect', () => sock.write(`${JSON.stringify({ type: 'auth', token })}\n`));
    sock.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (!authed) { if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ send, close: () => { sock.destroy(); } }); } continue; }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!authed) reject(e); else failAll(e); });
    function send(method, params) {
      const commandId = `pf-${randomUUID().slice(0, 8)}`;
      return new Promise((resolve2, reject2) => {
        const p = { resolve: resolve2, reject: reject2, timer: null };
        p.timer = setTimeout(() => { pending.delete(commandId); reject2(new Error(`命令超时：${method}`)); }, 20000);
        pending.set(commandId, p);
        sock.write(`${JSON.stringify({ protocolVersion: 1, commandId, method, params })}\n`);
      });
    }
  });
}
const cmd = async (client, method, params) => {
  const r = await client.send(method, params);
  if (r && r.ok === false) throw new Error(`${method} 被拒：${r.error?.code}: ${r.error?.message}`);
  return r && r.data !== undefined ? r.data : r;
};
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false; ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } }); ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout')); } }, 45_000); }); }
  async tryEval(expr) { try { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); return v.result.value; } catch { return null; } }
}
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(150);
  }
}

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'local.token'), token, 'utf8');
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'pack-daemon.mjs')], { cwd: repo, stdio: 'ignore' });
  const facts = { runId, scope: '性能分项：daemon 就绪 / DB 查询 / 桌面 UI 可交互（独立根；打包 daemon + dev UI；零模型调用）', env: { node: process.version, cwd: repo } };

  // ① daemon 就绪（spawn → 首条管道命令 ok——不是桌面可用时间）。
  const t1 = Date.now();
  const daemon = spawn(process.execPath, [daemonCjs], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let client = null;
  await until(async () => { try { client = await pipeConnect(); return true; } catch { return false; } }, (v) => v === true, 30000, 'daemon 就绪');
  await cmd(client, 'recovery.status', {});
  facts.daemonReadyMs = Date.now() - t1;

  // ② DB 查询：正式链种项目+会话+300 条 record_only，conversation.history ×3。
  await cmd(client, 'project.open', { path: projDir });
  const dbF = path.join(dataRoot, 'state.sqlite');
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const identity = await cmd(client, 'app.identity', {});
  {
    const db = new Database(dbF);
    const projId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
    db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?, '成员甲','agent',1)").run(projId);
    db.prepare("INSERT INTO conversations (id, project_id, kind) VALUES ('convP', ?, 'dm')").run(projId);
    db.prepare("INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES (?, 'convP','agent','mA')").run(projId);
    db.prepare("INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES (?, 'convP','human',?)").run(projId, identity.localUserId);
    const ins = db.prepare("INSERT INTO messages (id, project_id, conversation_id, conversation_seq, author_type, author_id, body_json, created_at) VALUES (?, ?, 'convP', ?, 'agent', 'mA', ?, ?)");
    for (let i = 1; i <= 300; i += 1) ins.run(`msg_p${i}`, projId, i, JSON.stringify({ text: `perf 消息 ${i}——历史查询样本` }), Date.now() - (300 - i) * 1000);
    db.close();
  }
  const hist = [];
  for (let i = 0; i < 3; i += 1) { const t = Date.now(); const r = await cmd(client, 'conversation.history', { conversationId: 'convP', limit: 100 }); hist.push(Date.now() - t); if ((r.messages ?? []).length < 100) throw new Error('历史样本不足'); }
  facts.dbQueryMs = { samples: hist, note: 'conversation.history limit=100（300 条样本）——服务端往返+查询，不含 UI 渲染' };

  // ③ 桌面 UI 可交互（spawn dev electron → hifi 壳挂载 → 项目自动打开完成）。
  await cmd(client, 'app.settings.set', { key: 'ui.autoOpenProjectPath', value: projDir });
  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const t3 = Date.now();
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  let cdp = null;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((x) => x.type === 'page' && String(x.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws')), 4000); }); cdp = new Cdp(ws); break; }
    } catch { /* 重试 */ }
    if (Date.now() - t3 > 60000) throw new Error('UI 启动超时');
    await sleep(400);
  }
  const uiMountedMs = Date.now() - t3;
  await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v === true, 30000, 'hifi 壳挂载');
  const hifiOnMs = Date.now() - t3;
  await until(() => cdp.tryEval(`[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`), (v) => v === true, 40000, '项目自动打开（UI 可操作）');
  const operableMs = Date.now() - t3;
  // 输入框可用性（可交互的硬判据：composer 挂载）。
  const composerUp = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`);
  facts.desktopUiMs = { toDebuggerPage: uiMountedMs, toHifiMounted: hifiOnMs, toProjectOperable: operableMs, composerMountedAfterRoomClick: composerUp, note: 'spawn dev electron 起——含 Electron 冷启动/CDP 轮询粒度（400ms）；daemon 已就绪（①），不含 daemon 启动' };

  // 收尾。
  await cdp.tryEval(`window.zsWindow?.close(), true`);
  await until(async () => app.exitCode, (c) => c != null, 20000, 'UI 退出').catch(() => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } });
  await cmd(client, 'daemon.shutdown', {}).catch(() => {});
  client.close();
  await sleep(1200);
  const realCalls = (() => { const db = new Database(dbF, { readonly: true }); try { return db.prepare('SELECT count(*) c FROM real_calls').get().c; } finally { db.close(); } })();
  facts.realCalls = realCalls;
  facts.ok = facts.daemonReadyMs > 0 && facts.dbQueryMs.samples.every((x) => x > 0) && facts.desktopUiMs.toProjectOperable > 0 && realCalls === 0;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, daemonReadyMs: facts.daemonReadyMs, dbQueryMs: facts.dbQueryMs.samples, desktopUiMs: { toHifiMounted: facts.desktopUiMs.toHifiMounted, toProjectOperable: facts.desktopUiMs.toProjectOperable } }));
  process.exit(facts.ok ? 0 : 3);
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
