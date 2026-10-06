'use strict';
/**
 * R61 P5（review-r60 §6 重判据）：草稿与未知信封跨 renderer 崩溃恢复 + 「服务已提交、
 * 回执丢失→崩溃→同号同参重试，业务恰一次」。
 *
 * 与 R60 判据的差别（原报告保留不改）：R60 把「崩溃后草稿为空」当合同；批准原型明确
 * 「版本化草稿、localStorage、刷新保持」。r61 起草稿/完整未知信封经命名空间持久化——
 * 本脚本在真实 Electron（dev 形态 main=dist/ui/main.cjs + 源码 daemon 子进程）上核：
 *  1) 发送前：未发送草稿（房间池 B）与线程草稿（A+仅记录意图）已落 localStorage 命名空间键；
 *  2) ZS_H1_LOSE_SUBMIT_ONCE=1：首个 UI message.submit 服务端已提交、回执被丢——渲染层
 *     按结果未知冻结**完整原信封**（含 commandId）→ banner + 持久化；DB 中该消息恰 1 条；
 *  3) CDP Page.crash 注入真实 renderer 崩溃 → 主进程自动重载（r60 修复）；
 *  4) 重载后：线程草稿 A+仅记录意图恢复、房间草稿 B 恢复、未知信封 banner 恢复（同 commandId）；
 *  5) 点「重发原内容」=同号同参原信封重放 → 服务幂等回执 ok → banner 消失；DB 消息仍恰 1 条
 *     （业务恰一次）；成功清算只剥本次已发正文（草稿清空）；record_only 零新 run；
 *  6) 优雅关窗退出码 0、real_calls=0、副本进程归零、崩溃恢复日志行存在。
 * 产物 dist/desktop/draft-recovery-r61-<ts>/result.json。
 */
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r61-draft-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `draft-recovery-r61-${runId}`);
const dataRoot = path.join(outDir, 'data');
const projDir = path.join(outDir, '演练 目录 r61');
const dbFile = path.join(dataRoot, 'state.sqlite');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const token = randomBytes(32).toString('hex');
const PORT = 9586;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(250);
  }
}
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
      const commandId = `dr-${randomUUID().slice(0, 8)}`;
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
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
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
const setArea = (cdp, v) => cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(v)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
const clickBtn = async (cdp, matcher, label) => {
  const ok = await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((b) => ${matcher}); if (b == null) return false; b.click(); return true; })()`));
  if (ok !== true) throw new Error('按钮未找到：' + label);
};

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'local.token'), token, 'utf8');
  const facts = { runId, scope: '草稿/未知信封跨 renderer 崩溃恢复 + 回执丢失同号重试恰一次（dev 形态真实 Electron；ZS_H1_LOSE_SUBMIT_ONCE；Page.crash；零模型调用）' };

  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName, ZS_H1_LOSE_SUBMIT_ONCE: '1' },
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
  let client = null;
  await until(async () => { try { client = await pipeConnect(); return true; } catch { return false; } }, (v) => v === true, 30000, 'daemon 管道就绪');
  await cmd(client, 'project.open', { path: projDir });
  await cmd(client, 'app.settings.set', { key: 'ui.autoOpenProjectPath', value: projDir });
  const roomRow = dbQuery('SELECT id, project_id FROM rooms LIMIT 1')[0];
  const convRow = dbQuery('SELECT id FROM conversations LIMIT 1')[0];
  const memberRow = dbQuery('SELECT id FROM project_members LIMIT 1')[0];
  const t = await cmd(client, 'message.submit', { target: { kind: 'room_root', projectId: roomRow.project_id, conversationId: convRow.id, roomId: roomRow.id }, body: 'r61 崩溃演练任务', intent: 'default', mentions: [{ kind: 'member', memberId: memberRow.id }] });
  void t;
  const markerMsg = dbQuery("SELECT id FROM messages WHERE body_json LIKE '%r61 崩溃演练任务%'")[0];
  const thRow = dbQuery('SELECT id, root_task_id r FROM conversation_threads WHERE anchor_message_id = ?', markerMsg.id)[0];
  await until(() => (dbQuery('SELECT status FROM tasks WHERE id = ?', thRow.r)[0] ?? {}).status, (s) => s === 'DONE' || s === 'REVIEW', 15000, '任务终态');

  // ① 房间池草稿 B（未发送）——持久化预备。
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 30000, '项目恢复');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '房间输入区');
  await setArea(cdp, 'r61 房间池未发送草稿B');
  await sleep(600);
  // ② 线程草稿 A + 仅记录意图 → 发送（首个 UI message.submit 回执被丢）。
  await cdp.eval(`location.hash = ${JSON.stringify(`#/thread/${thRow.id}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null && [...document.querySelectorAll('#hifi-root .msg')].length >= 0`, 15000, '线程输入区');
  await setArea(cdp, 'r61 恰一次审计消息A');
  await clickBtn(cdp, `b.getAttribute('aria-label') === '本次运行设置'`, '本次运行设置');
  await sleep(400);
  await clickBtn(cdp, `b.textContent.includes('仅记录') && !b.textContent.includes('取消')`, '仅记录菜单项');
  await sleep(300);
  const persistKeysBefore = await cdp.tryEval(`Object.keys(localStorage).filter((k) => k.startsWith('zs.hifi.persist.')).join(',')`);
  const persistHasA = await cdp.tryEval(`Object.keys(localStorage).filter((k) => k.startsWith('zs.hifi.persist.')).some((k) => (localStorage.getItem(k) ?? '').includes('r61 恰一次审计消息A'))`);
  const persistHasB = await cdp.tryEval(`Object.keys(localStorage).filter((k) => k.startsWith('zs.hifi.persist.')).some((k) => (localStorage.getItem(k) ?? '').includes('r61 房间池未发送草稿B'))`);
  await clickBtn(cdp, `/保存记录/.test(b.textContent.trim()) && b.textContent.trim().length <= 6`, '保存记录（将丢回执）');
  // 服务端已提交 + 回执被丢 → 渲染层 20s 超时判 unknown → 冻结原信封。
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`, 30000, '未知信封横幅（回执已丢）');
  const dbCountAfterLoss = dbQuery("SELECT count(*) c FROM messages WHERE body_json LIKE '%r61 恰一次审计消息A%'")[0].c;
  const envelopeCmd = await cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((k) => k.startsWith('zs.hifi.persist.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const env = Object.values(d.pendingSends ?? {})[0]; return env == null ? null : env.commandId; })()`);
  const runsBefore = dbQuery('SELECT count(*) c FROM workflow_runs')[0].c;
  facts.beforeCrash = { persistKeysBefore, persistHasA, persistHasB, dbCountAfterLoss, envelopeCmd, runsBefore };

  // ③ 真实 renderer 崩溃（CDP Page.crash）→ r60 修复自动重载。
  const crashErr = await cdp.send('Page.crash').then(() => null, (e) => String(e.message));
  if (crashErr != null && !crashErr.includes('Target crashed')) throw new Error('Page.crash 注入失败：' + crashErr);
  await sleep(2500);
  cdp = await connectPage('崩溃后重载');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 30000, '崩溃后自动重载');

  // ④ 恢复断言：线程草稿 A+仅记录意图；未知信封 banner（同 commandId）；房间草稿 B。
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 30000, '项目恢复（自动打开）');
  await cdp.eval(`location.hash = ${JSON.stringify(`#/thread/${thRow.id}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '重载后线程输入区');
  await sleep(900);
  const draftAfterCrash = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
  const recordChipAfterCrash = await cdp.tryEval(`document.querySelector('#hifi-root .composer-mentions .chip.record-chip') != null`);
  const bannerAfterCrash = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`);
  const envelopeCmdAfterCrash = await cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((k) => k.startsWith('zs.hifi.persist.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const env = Object.values(d.pendingSends ?? {})[0]; return env == null ? null : env.commandId; })()`);
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '重载后房间输入区');
  await sleep(700);
  const roomDraftAfterCrash = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
  facts.afterCrash = { draftAfterCrash, recordChipAfterCrash, bannerAfterCrash, envelopeCmdAfterCrash, roomDraftAfterCrash };

  // ⑤ 重发原内容（同号同参）→ 恰一次 + 清算只剥本次已发正文。
  await cdp.eval(`location.hash = ${JSON.stringify(`#/thread/${thRow.id}`)}; true`);
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`, 15000, '回到线程见横幅');
  await clickBtn(cdp, `b.title.includes('严格重发原信封')`, '重发原内容');
  await until(async () => await cdp.tryEval(`![...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`), (v) => v === true, 20000, '重发后横幅消失');
  const dbCountAfterRetry = dbQuery("SELECT count(*) c FROM messages WHERE body_json LIKE '%r61 恰一次审计消息A%'")[0].c;
  const runsAfter = dbQuery('SELECT count(*) c FROM workflow_runs')[0].c;
  const bodyAfterRetry = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
  await sleep(1500);
  const bodyAfterRetryLate = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
  const persistBodyAfterRetry = await cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((k) => k.startsWith('zs.hifi.persist.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const dr = (d.drafts ?? {})[${JSON.stringify('thread:' + thRow.id)}]; return dr == null ? null : dr.body; })()`);
  facts.afterRetry = { dbCountAfterRetry, runsAfter, bodyAfterRetry, bodyAfterRetryLate, persistBodyAfterRetry, exactlyOnce: dbCountAfterRetry === 1 };

  // 优雅关窗。
  await cdp.eval(probe(`window.zsWindow?.close(), true`));
  const exitInfo = await until(async () => app.exitCode, (c) => c != null, 30000, '优雅退出').catch(() => null);
  await sleep(2500);
  const procsEnd = procsOf(dataRoot);
  client.close();
  facts.shutdown = { appExitCode: exitInfo, residualProcs: (procsEnd ?? []).length };
  facts.rendererCrashLine = /renderer 进程异常退出/.test(appOut);
  facts.realCalls = dbQuery('SELECT count(*) c FROM real_calls')[0].c;

  const errs = [];
  if (facts.beforeCrash.persistHasA !== true || facts.beforeCrash.persistHasB !== true) errs.push('崩溃前草稿未持久化（A/B）');
  if (facts.beforeCrash.dbCountAfterLoss !== 1) errs.push('回执丢失时服务端未恰一次提交');
  if (facts.beforeCrash.envelopeCmd == null) errs.push('未知信封未持久化（commandId 缺失）');
  if (facts.afterCrash.draftAfterCrash !== 'r61 恰一次审计消息A') errs.push('线程草稿未恢复：' + JSON.stringify(facts.afterCrash.draftAfterCrash));
  if (facts.afterCrash.recordChipAfterCrash !== true) errs.push('仅记录意图未恢复（不得变 AI 派发）');
  if (facts.afterCrash.bannerAfterCrash !== true) errs.push('未知信封横幅未恢复');
  if (facts.afterCrash.envelopeCmdAfterCrash !== facts.beforeCrash.envelopeCmd) errs.push('恢复的信封 commandId 变化（必须同号）');
  if (facts.afterCrash.roomDraftAfterCrash !== 'r61 房间池未发送草稿B') errs.push('房间草稿未恢复：' + JSON.stringify(facts.afterCrash.roomDraftAfterCrash));
  if (facts.afterRetry.dbCountAfterRetry !== 1) errs.push('重发后消息数≠1（业务非恰一次）');
  if (facts.afterRetry.runsAfter !== facts.beforeCrash.runsBefore) errs.push('record_only 重发产生了新 run');
  if (String(facts.afterRetry.bodyAfterRetryLate).includes('恰一次审计消息A') || String(facts.afterRetry.persistBodyAfterRetry).includes('恰一次审计消息A')) errs.push('成功清算未剥离已发正文');
  if (facts.realCalls !== 0) errs.push('real_calls != 0');
  if (facts.shutdown.appExitCode !== 0) errs.push('优雅关窗退出码非 0');
  if (facts.shutdown.residualProcs !== 0) errs.push('残留进程');
  if (facts.rendererCrashLine !== true) errs.push('未见 renderer 崩溃恢复日志行');
  facts.ok = errs.length === 0;
  facts.checkErrors = errs;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: errs, envelopeCmd: facts.beforeCrash.envelopeCmd, dbCount: [facts.beforeCrash.dbCountAfterLoss, facts.afterRetry.dbCountAfterRetry] }));
  cleanupOwn();
  process.exit(facts.ok ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  cleanupOwn();
  process.exit(1);
});

function procsOf(rootLike) {
  const like = rootLike.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: 'utf8', timeout: 30000 });
  return String(r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0).map((l) => { const sp = l.indexOf(' '); return { pid: Number(l.slice(0, sp)), name: l.slice(sp + 1) }; }).filter((x) => Number.isFinite(x.pid));
}
