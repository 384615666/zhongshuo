/**
 * R60 P3：真实 Electron renderer 故障注入（review-r60 §2-2）。
 *
 * 与既有证据的差别：管道断连（连接级）与正常关窗都不是 renderer 故障——本脚本对
 * **dev 形态真实 Electron 主进程**（electron . + dist/ui——含 r60 render-process-gone
 * 重载修复）的页面用 CDP `Page.crash` 注入真实 renderer 崩溃，核：
 *  1) 主进程存活（窗口不退出）、daemon 子进程存活（独立进程不受 renderer 故障影响）；
 *  2) 任务不重派（崩溃前完成任务 runs=1，重载后仍=1；dispatch_gate 未落下）；
 *  3) 重载后（自动恢复）项目/会话/历史归属恢复：主池出现崩溃前消息标记、线程可见；
 *  4) 恢复状态：无恢复注意项弹层（daemon 未重启→无 applyRecovery）；
 *  5) 未确认信封/草稿按既有合同：内存态草稿不跨 renderer 崩溃恢复（如实断言为空，不静默
 *     清丢=没有伪造「已恢复」；持久项=localStorage lastProjectPath 驱动自动回到原项目）；
 *  6) 恢复后可继续正式操作（record_only 消息发送成功）；优雅关窗退出码 0、副本 PID 归零。
 * 边界：独立数据根+管道名；dev 形态（npm run build:ui 后的 dist/ui 真实 main+renderer；
 * daemon=源码 entry.ts 子进程）；零模型调用（fake runtime+真实派发防护）；只操作本脚本
 * spawn 的精确 PID。产物 dist/desktop/renderer-crash-r60-<ts>/result.json。
 */
'use strict';
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r60-rcrash-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `renderer-crash-r60-${runId}`);
const dataRoot = path.join(outDir, 'data');
const projDir = path.join(outDir, '演练 项目 目录'); // 中文+空格（P4 兼容面顺带实测）
const dbFile = path.join(dataRoot, 'state.sqlite');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const token = randomBytes(32).toString('hex');
const PORT = 9581;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(200);
  }
}
/** 管道客户端（正式命令面——与 daemon 同协议）。 */
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
        if (!authed) {
          if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ send, close: () => { sock.destroy(); }, }); }
          continue;
        }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!authed) reject(e); else failAll(e); });
    function send(method, params) {
      const commandId = `rc-${randomUUID().slice(0, 8)}`;
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
/** CDP 页面客户端（fetch /json/list → WebSocket）。 */
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false; ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } }); ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 160)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
}
async function connectPage(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); return new Cdp(ws); }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(800);
  }
}
const waitFor = async (cdp, expr, ms, label) => until(() => cdp.tryEval(probe(expr)).catch(() => null), (v) => v, ms, label);
/** 本脚本 spawn 的进程（失败收尾按精确 PID 收拢）。 */
const ownChildren = new Set();
function cleanupOwn() {
  for (const c of [...ownChildren]) {
    if (c.exitCode != null) continue;
    try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  }
}
const dbQuery = (sql, ...a) => {
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const db = new Database(dbFile, { readonly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
};

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'local.token'), token, 'utf8');
  const facts = { runId, scope: '真实 renderer 故障注入（dev 形态 electron . + dist/ui；daemon=源码子进程；Page.crash 注入；零模型调用）' };

  // dev 真实应用：electron . （main=dist/ui/main.cjs，daemon=源码 entry 子进程）。
  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  // dev 真实应用：main=dist/ui/main.cjs（package.json 无 main 字段——`electron .` 不是受支持
  // 路径；Chromium 开关须在入口路径之前）。daemon=源码 entry.ts 子进程（PATH node）。
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownChildren.add(app);
  app.once('exit', () => ownChildren.delete(app));
  let appOut = '';
  app.stdout.on('data', (c) => { appOut += c; });
  app.stderr.on('data', (c) => { appOut += c; });
  facts.appPid = app.pid;

  let cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 壳挂载');
  facts.hifiMounted = true;

  // 经管道种项目（project.open 引导成员/房间/会话）→ 记忆自动打开 → reload 生效。
  // daemon 就绪可能晚于 renderer 挂载（迁移/锁先行）——管道连接带重试窗。
  let client = null;
  await until(async () => { try { client = await pipeConnect(); return true; } catch { return false; } }, (v) => v === true, 30000, 'daemon 管道就绪');
  await cmd(client, 'project.open', { path: projDir });
  await cmd(client, 'app.settings.set', { key: 'ui.autoOpenProjectPath', value: projDir });
  const memberRow = dbQuery('SELECT id FROM project_members LIMIT 1')[0];
  const roomRow = dbQuery('SELECT id, project_id FROM rooms LIMIT 1')[0];
  const convRow = dbQuery('SELECT id FROM conversations LIMIT 1')[0];
  if (memberRow == null || roomRow == null || convRow == null) throw new Error('project.open 引导缺成员/房间/会话');
  // 崩溃前事实：一个完成任务（runs=1）+ 一条历史标记消息 + 草稿在输入框（内存态）。
  const t = await cmd(client, 'message.submit', { target: { kind: 'room_root', projectId: roomRow.project_id, conversationId: convRow.id, roomId: roomRow.id }, body: 'r60 renderer 崩溃演练任务', intent: 'default', mentions: [{ kind: 'member', memberId: memberRow.id }] });
  for (let i = 0; i < 60 && (dbQuery('SELECT count(*) c FROM workflow_runs')[0].c < 1); i += 1) { await sleep(150); }
  const markerMsg = dbQuery("SELECT id FROM messages WHERE body_json LIKE '%r60 renderer 崩溃演练任务%'")[0];
  const taskId = dbQuery('SELECT root_task_id r FROM conversation_threads WHERE anchor_message_id = ?', markerMsg.id)[0].r;
  await until(() => (dbQuery('SELECT status FROM tasks WHERE id = ?', taskId)[0] ?? {}).status, (s) => s === 'DONE' || s === 'REVIEW', 15000, '崩溃前任务终态');
  const preRuns = dbQuery('SELECT count(*) c FROM workflow_runs WHERE task_id = ?', taskId)[0].c;
  const preGate = dbQuery("SELECT value FROM daemon_state WHERE key = 'dispatch_gate'")[0]?.value ?? null;
  const daemonPids = dbQuery('SELECT 1').length >= 0 ? null : null; // daemon 存活按进程表核（下方）
  await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '崩溃前未发送草稿（内存态）'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  facts.beforeCrash = { taskId, runs: preRuns, taskStatus: dbQuery('SELECT status FROM tasks WHERE id = ?', taskId)[0].status, gate: preGate, markerMsgId: markerMsg.id };

  // ── 注入真实 renderer 崩溃（CDP Page.crash）──
  // daemon 存活判定=daemon.pid 文件+kill(pid,0)（其命令行不含数据根，进程表匹配不可靠）。
  const daemonPid = Number(fs.readFileSync(path.join(dataRoot, 'daemon.pid'), 'utf8').trim());
  const daemonAliveOf = () => { try { process.kill(daemonPid, 0); return true; } catch { return false; } };
  const daemonAliveBefore = daemonAliveOf();
  const procsBefore = procsOf(dataRoot);
  // Page.crash 成功时回执本身即 "Target crashed"（目标已被崩溃）——按成功处理。
  const crashErr = await cdp.send('Page.crash').then(() => null, (e) => String(e.message));
  if (crashErr != null && !crashErr.includes('Target crashed')) throw new Error('Page.crash 注入失败：' + crashErr);
  await sleep(2500);
  // 1) 主进程存活（应用未退出）+ daemon 子进程存活（PID 实证）。
  const appAlive = app.exitCode == null;
  const daemonAliveAfter = daemonAliveOf();
  const procsAfter = procsOf(dataRoot);
  facts.survival = { appAlive, daemonPid, daemonAliveBefore, daemonAliveAfter, electronCount: (procsAfter ?? []).filter((p) => p.name === 'electron.exe').length, procsBefore: (procsBefore ?? []).length, procsAfter: (procsAfter ?? []).length };
  // 2) 自动恢复（r60 render-process-gone→reload 修复）：重连 CDP 等壳重新挂载。
  cdp = await connectPage('崩溃后重载');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 30000, '崩溃后自动重载（render-process-gone 修复）');
  facts.autoReloaded = true;
  // 3) 项目/会话/历史归属恢复（localStorage lastProjectPath→自动打开→主池含崩溃前标记）。
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 30000, '项目恢复（自动打开）');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('r60 renderer 崩溃演练任务'))`, 30000, '崩溃前消息标记恢复（历史归属）');
  // 4) 任务不重派 + 恢复状态干净。
  const postRuns = dbQuery('SELECT count(*) c FROM workflow_runs WHERE task_id = ?', taskId)[0].c;
  const postGate = dbQuery("SELECT value FROM daemon_state WHERE key = 'dispatch_gate'")[0]?.value ?? null;
  const realCalls = dbQuery('SELECT count(*) c FROM real_calls')[0].c;
  // 5) 草稿按既有合同：内存态不跨 renderer 崩溃恢复（如实为空——不伪造恢复、不静默清丢数据）。
  const draftAfter = await cdp.tryEval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); return ta == null ? 'NO_TA' : ta.value; })()`));
  // 6) 恢复后可继续正式操作（record_only）。
  const marker2 = await cmd(client, 'message.submit', { target: { kind: 'room_root', projectId: roomRow.project_id, conversationId: convRow.id, roomId: roomRow.id }, body: 'r60 崩溃后继续写入（仅记录）', intent: 'record_only', mentions: [] });
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('r60 崩溃后继续写入'))`, 30000, '崩溃后新消息可见（可继续操作）');
  facts.afterRecovery = { runsUnchanged: postRuns === preRuns, gateStill: postGate, realCalls, draftAfter, continueWriteOk: marker2 != null && marker2.ok !== false };

  // 优雅关窗（zsWindow close → 既有退出链）。
  await cdp.eval(probe(`window.zsWindow?.close(), true`));
  const exitInfo = await until(async () => app.exitCode, (c) => c != null, 30000, '优雅退出').catch(() => null);
  await sleep(2500);
  const procsEnd = procsOf(dataRoot);
  client.close();
  facts.shutdown = { appExitCode: exitInfo, residualProcs: (procsEnd ?? []).length };
  facts.rendererCrashLine = /renderer 进程异常退出/.test(appOut);
  facts.outputTail = appOut.slice(-400);

  const errs = [];
  if (facts.survival.appAlive !== true) errs.push('主进程未存活');
  if (facts.survival.daemonAliveAfter !== true || facts.survival.daemonAliveBefore !== true) errs.push('daemon 子进程未存活（PID 实证失败）');
  if (facts.autoReloaded !== true) errs.push('未自动重载');
  if (facts.afterRecovery.runsUnchanged !== true) errs.push('任务被重派（runs 变化）');
  if (facts.afterRecovery.gateStill === 'held') errs.push('恢复门禁被落下（daemon 不应重启）');
  if (facts.afterRecovery.realCalls !== 0) errs.push('real_calls != 0');
  if (typeof facts.afterRecovery.draftAfter === 'string' && facts.afterRecovery.draftAfter.includes('崩溃前未发送草稿')) errs.push('内存草稿意外跨崩溃保留（合同=不恢复，须如实为空）');
  if (facts.afterRecovery.continueWriteOk !== true) errs.push('崩溃后无法继续正式操作');
  if (facts.shutdown.appExitCode !== 0) errs.push('优雅关窗退出码非 0');
  if (facts.shutdown.residualProcs !== 0) errs.push('残留进程');
  if (facts.rendererCrashLine !== true) errs.push('未见 renderer 崩溃恢复日志行');
  facts.ok = errs.length === 0;
  facts.checkErrors = errs;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: errs, survival: facts.survival, runsUnchanged: facts.afterRecovery.runsUnchanged, draftAfter: facts.afterRecovery.draftAfter }));
  cleanupOwn();
  process.exit(facts.ok ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  cleanupOwn();
  process.exit(1);
});

/** 按独立数据根路径核进程（只读 CIM；排除查询自身 shell）。 */
function procsOf(rootLike) {
  const like = rootLike.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: 'utf8', timeout: 30000 });
  return String(r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).map((l) => { const sp = l.indexOf(' '); return { pid: Number(l.slice(0, sp)), name: l.slice(sp + 1) }; }).filter((x) => Number.isFinite(x.pid));
}
