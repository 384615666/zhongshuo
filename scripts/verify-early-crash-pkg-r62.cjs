'use strict';
/**
 * R62 P1 交付形态专项（review-r61 §2 末段：最终候选至少证明「提交已成功、20 秒前 renderer
 * 崩溃→同号重发恰一次」）：v6 交付包独立副本 × 真实启动器（start-server.bat）×
 * ZS_H1_LOSE_SUBMIT_ONCE=1（首个 UI message.submit 服务端提交、回执被扣）。
 * 流程：种子完成 → 打开种子任务线程（有 agent 回复）→ 输入仅记录消息 → 保存（回执被扣）
 * → ≤1.5s（远早于 20s）读取 localStorage 出站账本（commandId 逐字）→ CDP Page.crash 真实
 * renderer 崩溃 → 候选 main 自动重载 → 同号横幅恢复+正文恢复 → 未改正文再发被守卫拦截
 * （DB 不增）→「重发原内容」同号 → DB 该消息恰 1 条+横幅消失+正文剥离。
 * 另：DB 参数逐字断言（body/intent/target 与首笔一致）。产物
 * dist/desktop/early-crash-pkg-r62-<ts>/result.json。零真实模型调用。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const srcPkg = process.argv.includes('--src') ? path.resolve(process.argv[process.argv.indexOf('--src') + 1]) : path.join(repo, 'dist', 'desktop', 'hifi-h4-win-v6');
const runId = `r62-epkg-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `early-crash-pkg-r62-${runId}`);
const copyRoot = path.join(outDir, 'copy');
const copyDir = path.join(copyRoot, 'pkg 副本');
const PORT = 9597;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false; ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } }); ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 160)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
}
async function connectPage(label) {
  const deadline = Date.now() + 150_000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); return new Cdp(ws); }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(1000);
  }
}
const waitFor = async (cdp, expr, ms, label) => { const t0 = Date.now(); for (;;) { const v = await cdp.tryEval(probe(expr)).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error('等待超时：' + label); await sleep(900); } };
const dbQuery = (sql, ...a) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(copyDir, 'server-data', 'state.sqlite'), { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };

(async () => {
  if (!fs.existsSync(srcPkg)) throw new Error('交付包不存在：' + srcPkg);
  fs.mkdirSync(copyDir, { recursive: true });
  spawnSync('robocopy', [srcPkg, copyDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  const identity = { buildId: JSON.parse(fs.readFileSync(path.join(copyDir, 'ZhongshuoDual', 'BUILD.json'), 'utf8')).buildId };
  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(PORT), ZS_H1_LOSE_SUBMIT_ONCE: '1' };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME;
  const child = spawn('cmd', ['/c', 'start-server.bat'], { cwd: copyDir, env });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  let pauseFed = 0;
  const pauseFeeder = setInterval(() => { if (out.includes('Seeded.') && pauseFed < 45) { pauseFed += 1; try { child.stdin.write(String.fromCharCode(10)); } catch { /* 已退出 */ } } }, 2000);
  const facts = { runId, scope: '交付形态早崩专项：v6 包副本×真实启动器×丢回执×20s 前 Page.crash×同号恰一次；零模型调用', identity };
  let cdp = null;
  try {
    cdp = await connectPage('启动');
    await waitFor(cdp, `document.body.classList.contains('hifi-on') && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 110_000, '首启进入项目');
    // 打开种子任务线程（有 agent 回复——书签/输入区在线程页）。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].length > 0`, 150_000, '主池线程卡');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('看板房间任务样本'))`, 60_000, '种子任务卡');
    await cdp.eval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('看板房间任务样本')); card?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 20_000, '线程输入区');
    const marker = 'R62-PKG-EARLY-CRASH-ONCE';
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(marker)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.getAttribute('aria-label') === '本次运行设置'); b?.click(); return true; })()`));
    await sleep(400);
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('仅记录') && !x.textContent.includes('取消')); b?.click(); return true; })()`));
    await sleep(300);
    const tSend = Date.now();
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => /保存记录/.test(x.textContent.trim()) && x.textContent.trim().length <= 6); b?.click(); return true; })()`));
    // ① 早窗（≤1.5s）：出站账本已耐久落盘（commandId 逐字）。
    const ledgerEarly = await waitFor(cdp, `(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('zs.hifi.persist.')); if (k == null) return null; try { const d = JSON.parse(localStorage.getItem(k)); const ls = Object.values(d.outboundLedger ?? {}).flat(); return ls.length === 1 && ls[0].params?.body === ${JSON.stringify(marker)} ? ls[0].commandId : null; } catch { return null; } })()`, 4000, '早窗账本落盘');
    const stagedMs = Date.now() - tSend;
    const dbCount1 = dbQuery('SELECT count(*) c FROM messages WHERE body_json LIKE ?', `%${marker}%`)[0].c;
    const bannerBefore = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`);
    facts.beforeCrash = { stagedMs, commandId: ledgerEarly, dbCount: dbCount1, bannerShown: bannerBefore === true };
    // ② 20s 前真实 renderer 崩溃 → 候选 main 自动重载。
    await cdp.eval(`window.__r62pre = 1; true`);
    const crashErr = await cdp.send('Page.crash').then(() => null, (e) => String(e.message));
    if (crashErr != null && !crashErr.includes('Target crashed')) throw new Error('Page.crash 注入失败：' + crashErr);
    await sleep(3000);
    cdp = await connectPage('崩溃后重载');
    await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 30000, '候选 main 自动重载');
    const reloadFresh = await cdp.tryEval(`window.__r62pre === undefined`); // 新文档=真实重载（非断连复用）
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 40000, '项目恢复');
    await cdp.eval(`location.hash = '#/thread/' + (() => { const th = [...document.querySelectorAll('#hifi-root .root-card')]; return ''; })() || location.hash; true`); // 占位（下方按卡重进）
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('看板房间任务样本'))`, 60000, '重载后种子任务卡');
    await cdp.eval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('看板房间任务样本')); card?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 20000, '重载后线程输入区');
    await sleep(1000);
    const bodyAfter = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
    const bannerAfter = await cdp.tryEval(`(() => { const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')]; const hit = chips.find((c) => c.textContent.includes('结果未知')); return hit == null ? null : hit.textContent.slice(0, 60); })()`);
    const pendCmd = await cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('zs.hifi.persist.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const ps = Object.values(d.pendingSends ?? {}); return ps.length === 1 ? ps[0].commandId : null; })()`);
    // ③ 守卫：未改正文再点保存记录 → 拦截，DB 不增。
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => /保存记录|发送/.test(x.textContent.trim()) && x.textContent.trim().length <= 4); b?.click(); return true; })()`));
    await sleep(800);
    const guardText = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .composer-draft.failed')].map((x) => x.textContent).join(' | ')`);
    const dbCountAfterGuard = dbQuery('SELECT count(*) c FROM messages WHERE body_json LIKE ?', `%${marker}%`)[0].c;
    facts.afterCrash = { bodyAfter, bannerHead: bannerAfter, pendCmd, guardText, dbCountAfterGuard, guardBlocked: dbCountAfterGuard === 1 && String(guardText ?? '').includes('重发原内容') };
    // ④ 同号重发 → 恰一次+横幅消失+正文剥离；参数逐字核对。
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .chip button')].find((x) => x.title.includes('严格重发原信封')); b?.click(); return true; })()`));
    await waitFor(cdp, `![...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`, 20000, '同号重发后横幅消失');
    await sleep(1200);
    const rows = dbQuery("SELECT body_json, status FROM messages WHERE body_json LIKE ?", `%${marker}%`);
    const first = rows[0] != null ? { body: JSON.parse(rows[0].body_json ?? '{}').text ?? '', status: rows[0].status } : null;
    const bodyAfterRetry = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);
    facts.afterRetry = { dbCount: rows.length, first, bodyAfterRetry: String(bodyAfterRetry).slice(0, 60), paramsVerbatim: first != null && first.body === marker && first.status === 'saved' }; // record_only 落库形态=status saved
    facts.realCalls = dbQuery('SELECT count(*) c FROM real_calls')[0].c;
    facts.reloadFresh = reloadFresh === true; // bat 管道不透传 electron stderr——日志行以文档新鲜度替代证明（崩溃+自动重载事实同证）

    const errs = [];
    if (facts.beforeCrash.commandId == null || facts.beforeCrash.stagedMs > 2000) errs.push('早窗账本未落盘');
    if (facts.beforeCrash.dbCount !== 1) errs.push('服务端未恰一次提交');
    if (facts.beforeCrash.bannerShown) errs.push('20s 前出现横幅（时序异常）');
    if (facts.afterCrash.pendCmd !== facts.beforeCrash.commandId) errs.push('重载后横幅信封号不一致');
    if (facts.afterCrash.bodyAfter !== marker) errs.push('重载后正文未恢复');
    if (facts.afterCrash.guardBlocked !== true) errs.push('未改正文再发未被拦截或 DB 增长');
    if (facts.afterRetry.dbCount !== 1) errs.push('同号重发后消息≠1');
    if (facts.afterRetry.paramsVerbatim !== true) errs.push('参数不逐字一致');
    if (String(facts.afterRetry.bodyAfterRetry).includes(marker)) errs.push('重发成功后正文未剥离');
    if (facts.realCalls !== 0) errs.push('real_calls != 0');
    if (facts.reloadFresh !== true) errs.push('崩溃后未见新文档（自动重载未证）');
    facts.ok = errs.length === 0;
    facts.checkErrors = errs;
  } finally {
    clearInterval(pauseFeeder);
    try { await cdp?.eval(probe(`window.zsWindow?.close(), true`)); } catch { /* 尽力 */ }
    await sleep(2500);
    const like = copyDir.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
    const kill = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "$($_.ProcessId)" }`], { encoding: 'utf8', timeout: 60000 });
    facts.residualProcsKilled = String(kill.stdout ?? '').trim().split(/\s+/).filter(Boolean);
    try { child.kill(); } catch { /* 已退出 */ }
  }
  const file = path.join(outDir, 'result.json');
  fs.writeFileSync(file, JSON.stringify(facts, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: facts.checkErrors ?? [], stagedMs: facts.beforeCrash?.stagedMs, cmd: facts.beforeCrash?.commandId, dbCounts: [facts.beforeCrash?.dbCount, facts.afterCrash?.dbCountAfterGuard, facts.afterRetry?.dbCount] }));
  process.exit(facts.ok === true ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  process.exit(1);
});
