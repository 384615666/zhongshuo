'use strict';
/**
 * R62 P1（review-r61 §2 独立反例 early-crash-result.json 的闭拢演练）：
 * 「服务已提交→回执被扣→**20s 超时前** renderer 真实崩溃」——修复后必须：
 *  1) 点击发送后 ≤1s（远早于 20s unknown 判定）localStorage 出站账本已有完整信封
 *     （commandId 逐字）——交给 bridge 之前耐久落账；
 *  2) Page.crash → 自动重载后**未确认横幅恢复**（同 commandId，recovered 语义）+正文恢复
 *     （不自动发送、不静默退回普通草稿）；
 *  3) 未改正文再点发送=被守卫拦截（提示走同号重发/放弃），DB 消息数不增；
 *  4) 「重发原内容」同号同参 → DB 该消息恰 1 条（业务恰一次）+横幅消失+已发正文剥离；
 *  5) 房间未发送草稿跨崩溃恢复；real_calls=0；优雅关窗退出码 0；零残留。
 * 形态：dev Electron（dist/ui/main.cjs）+源码 daemon 子进程；ZS_H1_LOSE_SUBMIT_ONCE=1。
 * 产物 dist/desktop/early-crash-r62-<ts>/result.json。
 */
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r62-early-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `early-crash-r62-${runId}`);
const dataRoot = path.join(outDir, 'data');
const projDir = path.join(outDir, '演练 目录 r62');
const dbFile = path.join(dataRoot, 'state.sqlite');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const token = randomBytes(32).toString('hex');
const PORT = 9592;
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
      const commandId = `ec-${randomUUID().slice(0, 8)}`;
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
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); return new Cdp(ws); }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
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
const ledgerProbe = (cdp) => cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('zs.hifi.persist.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const ls = Object.values(d.outboundLedger ?? {}).flat(); return JSON.stringify(ls.map((x) => ({ commandId: x.commandId, stage: x.stage, body: x.params?.body }))); })()`);
const pendProbe = (cdp) => cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('zs.hifi.persist.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const ps = Object.values(d.pendingSends ?? {}); return JSON.stringify(ps.map((x) => ({ commandId: x.commandId, recovered: x.recovered === true, queued: (x.queued ?? []).length }))); })()`);

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'local.token'), token, 'utf8');
  const facts = { runId, scope: '早崩窗口（20s unknown 判定前 renderer 真实崩溃）→预 bridge 账本恢复+同号恰一次；ZS_H1_LOSE_SUBMIT_ONCE；零模型调用' };

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
  await cmd(client, 'message.submit', { target: { kind: 'room_root', projectId: roomRow.project_id, conversationId: convRow.id, roomId: roomRow.id }, body: 'r62 早崩演练任务', intent: 'default', mentions: [{ kind: 'member', memberId: memberRow.id }] });
  const markerMsg = dbQuery("SELECT id FROM messages WHERE body_json LIKE '%r62 早崩演练任务%'")[0];
  const thRow = dbQuery('SELECT id, root_task_id r FROM conversation_threads WHERE anchor_message_id = ?', markerMsg.id)[0];
  await until(() => (dbQuery('SELECT status FROM tasks WHERE id = ?', thRow.r)[0] ?? {}).status, (s) => s === 'DONE' || s === 'REVIEW', 15000, '任务终态');

  // 房间未发送草稿（跨崩溃恢复对照）。
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 30000, '项目恢复');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '房间输入区');
  await setArea(cdp, 'r62 房间草稿B');
  await sleep(500);
  // 线程：正文+仅记录 → 发送（回执被扣；在 20s 窗口内崩溃）。
  await cdp.eval(`location.hash = ${JSON.stringify(`#/thread/${thRow.id}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '线程输入区');
  await setArea(cdp, 'R62-EARLY-CRASH-ONCE');
  await clickBtn(cdp, `b.getAttribute('aria-label') === '本次运行设置'`, '本次运行设置');
  await sleep(400);
  await clickBtn(cdp, `b.textContent.includes('仅记录') && !b.textContent.includes('取消')`, '仅记录菜单项');
  await sleep(300);
  const tSend = Date.now();
  await clickBtn(cdp, `/保存记录/.test(b.textContent.trim()) && b.textContent.trim().length <= 6`, '保存记录（回执将扣）');
  // ① 交给 bridge 之前/之后极早期：账本已耐久落盘（≤1.2s 检查——远早于 20s unknown 判定）。
  const ledgerEarly = await until(async () => { const v = await ledgerProbe(cdp); return v; }, (v) => { try { const a = JSON.parse(String(v)); return a.length === 1 && a[0].body === 'R62-EARLY-CRASH-ONCE'; } catch { return false; } }, 4000, '早窗账本落盘');
  const stagedMs = Date.now() - tSend;
  const stagedCmd = JSON.parse(ledgerEarly)[0].commandId;
  const dbCountBeforeCrash = dbQuery("SELECT count(*) c FROM messages WHERE body_json LIKE '%R62-EARLY-CRASH-ONCE%'")[0].c;
  const bannerBeforeCrash = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`);
  facts.beforeCrash = { stagedMs, stagedCmd, dbCount: dbCountBeforeCrash, bannerShown: bannerBeforeCrash === true, ledger: JSON.parse(ledgerEarly) };

  // ② 20s 窗口内真实崩溃 + 自动重载。
  const crashErr = await cdp.send('Page.crash').then(() => null, (e) => String(e.message));
  if (crashErr != null && !crashErr.includes('Target crashed')) throw new Error('Page.crash 注入失败：' + crashErr);
  await sleep(2200);
  cdp = await connectPage('崩溃后重载');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 30000, '自动重载');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 30000, '项目恢复');
  await cdp.eval(`location.hash = ${JSON.stringify(`#/thread/${thRow.id}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '重载后线程输入区');
  await sleep(900);
  const bodyAfter = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
  const bannerAfter = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`);
  const pendAfter = await pendProbe(cdp);
  const bannerCmd = (() => { try { const a = JSON.parse(String(pendAfter)); return a.length === 1 ? a[0].commandId : null; } catch { return null; } })();
  const recoveredFlag = (() => { try { return JSON.parse(String(pendAfter))[0]?.recovered === true; } catch { return false; } })();
  const dbCountAfterCrash = dbQuery("SELECT count(*) c FROM messages WHERE body_json LIKE '%R62-EARLY-CRASH-ONCE%'")[0].c;
  // ③ 守卫：未改正文再点「保存记录」→ 拦截（不换新号发送），DB 不增。
  await clickBtn(cdp, `/保存记录|发送/.test(b.textContent.trim()) && b.textContent.trim().length <= 4`, '未改正文再发送（应被拦截）');
  await sleep(700);
  const guardText = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .composer-draft.failed')].map((x) => x.textContent).join(' | ')`);
  const dbCountAfterGuard = dbQuery("SELECT count(*) c FROM messages WHERE body_json LIKE '%R62-EARLY-CRASH-ONCE%'")[0].c;
  facts.afterCrash = { bodyAfter, bannerAfter: bannerAfter === true, bannerCmd, recoveredFlag, dbCountAfterCrash, guardText, dbCountAfterGuard, guardBlocked: dbCountAfterGuard === 1 && String(guardText ?? '').includes('重发原内容') };

  // ④ 同号重发 → 恰一次 + 横幅消失 + 正文剥离。
  await clickBtn(cdp, `b.title.includes('严格重发原信封')`, '重发原内容（同号）');
  await until(async () => await cdp.tryEval(`![...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`), (v) => v === true, 20000, '同号重发后横幅消失');
  await sleep(1200);
  const dbCountAfterRetry = dbQuery("SELECT count(*) c FROM messages WHERE body_json LIKE '%R62-EARLY-CRASH-ONCE%'")[0].c;
  const bodyAfterRetry = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
  // 房间草稿 B 跨崩溃恢复。
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '重载后房间输入区');
  await sleep(700);
  const roomDraftAfter = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
  const ledgerAfterAll = await ledgerProbe(cdp);
  facts.afterRetry = { dbCountAfterRetry, bodyAfterRetry, roomDraftAfter, ledgerEmpty: (() => { try { return JSON.parse(String(ledgerAfterAll)).length === 0; } catch { return false; } })() };

  // 收尾。
  await cdp.eval(probe(`window.zsWindow?.close(), true`));
  const exitInfo = await until(async () => app.exitCode, (c) => c != null, 30000, '优雅退出').catch(() => null);
  await sleep(2200);
  const like = dataRoot.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
  const kill = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { "$($_.ProcessId)" }`], { encoding: 'utf8', timeout: 60000 });
  const residual = String(kill.stdout ?? '').trim().split(/\s+/).filter(Boolean);
  client.close();
  facts.shutdown = { appExitCode: exitInfo, residualProcs: residual.length };
  facts.rendererCrashLine = /renderer 进程异常退出/.test(appOut);
  facts.realCalls = dbQuery('SELECT count(*) c FROM real_calls')[0].c;

  const errs = [];
  if (facts.beforeCrash.stagedCmd == null || facts.beforeCrash.stagedMs > 1500) errs.push('账本未在早窗耐久落盘');
  if (facts.beforeCrash.dbCount !== 1) errs.push('服务端未恰一次提交');
  if (facts.beforeCrash.bannerShown === true) errs.push('20s 前不应已显示 unknown 横幅（时序异常）');
  if (facts.afterCrash.bannerAfter !== true || facts.afterCrash.bannerCmd !== facts.beforeCrash.stagedCmd) errs.push('重载后横幅未按同 commandId 恢复');
  if (facts.afterCrash.recoveredFlag !== true) errs.push('恢复项缺 recovered 标记');
  if (facts.afterCrash.bodyAfter !== 'R62-EARLY-CRASH-ONCE') errs.push('重载后正文未恢复');
  if (facts.afterCrash.guardBlocked !== true) errs.push('未改正文再发送未被守卫拦截或 DB 增长');
  if (facts.afterRetry.dbCountAfterRetry !== 1) errs.push('同号重发后消息≠1');
  if (String(facts.afterRetry.bodyAfterRetry).includes('R62-EARLY-CRASH-ONCE')) errs.push('重发成功后正文未剥离');
  if (facts.afterRetry.roomDraftAfter !== 'r62 房间草稿B') errs.push('房间草稿未跨崩溃恢复');
  if (facts.afterRetry.ledgerEmpty !== true) errs.push('账本未清空');
  if (facts.realCalls !== 0) errs.push('real_calls != 0');
  if (facts.shutdown.appExitCode !== 0) errs.push('优雅关窗退出码非 0');
  if (facts.shutdown.residualProcs !== 0) errs.push('残留进程');
  if (facts.rendererCrashLine !== true) errs.push('未见 renderer 崩溃恢复日志行');
  facts.ok = errs.length === 0;
  facts.checkErrors = errs;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: errs, stagedMs: facts.beforeCrash.stagedMs, cmd: facts.beforeCrash.stagedCmd, dbCounts: [facts.beforeCrash.dbCount, facts.afterCrash.dbCountAfterCrash, facts.afterCrash.dbCountAfterGuard, facts.afterRetry.dbCountAfterRetry] }));
  cleanupOwn();
  process.exit(facts.ok ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  cleanupOwn();
  process.exit(1);
});
