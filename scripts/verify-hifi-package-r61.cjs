'use strict';
/**
 * R57 H4-v2 候选验证器（review-r54 §3/§5）——独立测试副本运行交付 bat：在 r53 全链上新增**自绘标题栏与 H3 页**：标题栏三键/拖动区/38px 偏移（真实 zs:window 窄 IPC）；关闭走标题栏关闭键→win.close()→既有优雅收口链（非直接 window.close）；看板页（board.view 真命令）核验。其余沿 r53：
 * 不动用户包（H1 v2/v6/hifi-h2-win-v1 原地稳定）。相对 r52 新增强制项：
 *  - PPT 视觉正常链（§2）：包内 pptx 样本 → 共享预览 → **真舞台子节点>0 + visual-state=done +
 *    页数=样本实际页数**（不再接受降级提示/外层容器冒充——http 探针宽松断言已废）。
 *  - 未知重试成功后的附件清算（§4）：带附件派发丢回执 → 原信封重发成功 → 附件芯片剥离；
 *    下一条消息只带新资源；已发附件恰落库一次、不重带。
 *  - 移除附件的真实引用（§3，就绪态确定性路径）：ready 芯片移除 → 下一条消息零 attachment
 *    链接（artifact 仍在=如实），芯片不复活。
 * 其余沿 r52：真实启动器/首启项目/主池卡/锚块/跟进不另建任务/文本预览真内容/图片门/深链/
 * window.close 停机 forced!=true/PID 归零/身份不变/real_calls=0；run2 重启历史。
 * 产物 dist/desktop/hifi-h4-verify-r61/。
 * 运行：node scripts/verify-hifi-package-r55.cjs [--src 包目录]（默认 dist/desktop/hifi-h2-win-v2）。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const repo = path.resolve(__dirname, '..');
const srcPkg = process.argv.includes('--src') ? path.resolve(process.argv[process.argv.indexOf('--src') + 1]) : path.join(repo, 'dist', 'desktop', 'hifi-h4-win-v5');
const copyRoot = path.join(repo, 'dist', 'desktop', 'hifi-h4-verify-r61-copy');
const copyDir = path.join(copyRoot, 'v5 副本 run');
const outDir = path.join(repo, 'dist', 'desktop', 'hifi-h4-verify-r61');
fs.mkdirSync(outDir, { recursive: true });
const runId = `r61-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function dbQuery(sql, ...args) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(copyDir, 'server-data', 'state.sqlite'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

/** 副本路径进程清单（真路径 -like；查询失败=未确认；纯文本行输出）。 */
function procsOfCopy() {
  const like = copyDir.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
  const run = () => spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
    ], { encoding: 'utf8', timeout: 30_000 });
  let r = run();
  if (r.status !== 0 || String(r.stderr ?? '').trim().length > 0) r = run();
  const stderr = String(r.stderr ?? '').trim();
  if (r.status !== 0 || stderr.length > 0) return { ok: false, procs: null, error: `status=${r.status} stderr=${stderr.slice(0, 120)}` };
  const procs = String(r.stdout ?? '').split(new RegExp('[' + String.fromCharCode(13) + String.fromCharCode(10) + ']+')).map((l) => l.trim()).filter((l) => l.length > 0)
    .map((l) => { const sp = l.indexOf(' '); return { pid: Number(l.slice(0, sp)), name: l.slice(sp + 1) }; }).filter((x) => Number.isFinite(x.pid));
  return { ok: true, procs, error: null };
}
function pidsGone(pids) {
  if (pids.length === 0) return { ok: true, gone: true, alive: [] };
  const run = () => spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { @(${pids.join(',')}) -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
    ], { encoding: 'utf8', timeout: 30_000 });
  let r = run();
  if (r.status !== 0 || String(r.stderr ?? '').trim().length > 0) r = run();
  const stderr = String(r.stderr ?? '').trim();
  if (r.status !== 0 || stderr.length > 0) return { ok: false, gone: false, alive: null, error: `status=${r.status}` };
  const alive = String(r.stdout ?? '').split(new RegExp('[' + String.fromCharCode(13) + String.fromCharCode(10) + ']+')).map((l) => l.trim()).filter((l) => l.length > 0)
    .map((l) => { const sp = l.indexOf(' '); return { pid: Number(l.slice(0, sp)), name: l.slice(sp + 1) }; });
  return { ok: true, gone: alive.length === 0, alive };
}
const procsOkZero = (q) => q != null && q.ok === true && (q.procs ?? []).length === 0;

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }); }
  async eval(expr) { const v = await Promise.race([this.send('Runtime.evaluate', { expression: expr, returnByValue: true }).catch((e) => { throw e; }), sleep(8000).then(() => { throw new Error('eval blocked'); })]); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 160)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
}
async function connectPage(port, label) {
  const deadline = Date.now() + 150_000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); return new Cdp(ws); }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(1000);
  }
}
async function waitFor(cdp, expr, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await cdp.tryEval(probe(expr)).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(900);
  }
}
async function typeInto(cdp, text) {
  await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  await sleep(180);
}
async function clickBtn(cdp, matcher, label) {
  const ok = await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((b) => ${matcher}); if (b == null) return false; b.click(); return true; })()`));
  if (ok !== true) throw new Error('按钮未找到：' + label);
}
async function pickRecordIntent(cdp) {
  await clickBtn(cdp, `b.getAttribute('aria-label') === '本次运行设置'`, '本次运行设置');
  await sleep(400);
  await clickBtn(cdp, `b.textContent.includes('仅记录')`, '仅记录菜单项');
  await sleep(300);
}
async function sendCurrent(cdp, label) {
  await clickBtn(cdp, `/保存记录|发送/.test(b.textContent) && b.textContent.length <= 6`, label);
}
async function pickFile(cdp, name, mime, bytes) {
  await cdp.eval(`(async () => { const input = document.querySelector('#hifi-root input[type=file]'); if (input == null) return 'NO_INPUT'; const file = new File([Uint8Array.from(${JSON.stringify(Array.from(bytes))})], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return 'OK'; })()`);
}
const chipText = (name) => `[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes(${JSON.stringify(name)}))`;
function manifestIdentity() {
  const m = path.join(copyDir, 'ZhongshuoDual', 'MANIFEST-SHA256.json');
  const b = path.join(copyDir, 'ZhongshuoDual', 'BUILD.json');
  return { buildId: JSON.parse(fs.readFileSync(b, 'utf8')).buildId, manifestSha: sha256File(m), buildSha: sha256File(b) };
}
const msgLinks = (bodyLike) => {
  const row = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%${bodyLike}%`)[0];
  return row == null ? null : dbQuery('SELECT a.id, a.source_name FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id = ?', row.id);
};
const artifactId = (name) => dbQuery('SELECT id FROM artifacts WHERE source_name = ?', name)[0]?.id ?? null;
const linkCount = (artId) => dbQuery('SELECT count(*) c FROM message_attachments WHERE artifact_id = ?', artId)[0]?.c ?? 0;

async function runOnce(n) {
  const port = 9494 + n;
  const identityBefore = manifestIdentity();
  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(port), ZS_H1_LOSE_SUBMIT_ONCE: '1' };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME;
  const child = spawn('cmd', ['/c', 'start-server.bat'], { cwd: copyDir, env });
  let out = '';
  const batExitPromise = new Promise((res) => { child.on('exit', (code) => res({ code })); });
  let pauseFed = 0;
  const pauseFeeder = setInterval(() => {
    if (out.includes('Seeded.') && pauseFed < 45) { pauseFed += 1; try { child.stdin.write(String.fromCharCode(10)); } catch { /* 已退出 */ } }
  }, 2000);
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const launcherPid = child.pid;
  let cdp = null;
  const f = { run: n, runId: `${runId}-run${n}`, port, identityBefore, launcherPid, launcherLifecycle: 'test-owned', seeded: false };
  try {
    cdp = await connectPage(port, `run${n}`);
    // ① 首启自动项目 + 主池线程卡
    await waitFor(cdp, `document.body.classList.contains('hifi-on') && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 110_000, '首启自动进入项目');
    f.autoProject = true;
    if (n > 1) {
      const priorMarker = `R57房间派发run${n - 1}`;
      const priorMsg = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%${priorMarker}%`)[0] ?? null;
      const priorTask = priorMsg != null ? dbQuery(`SELECT t.id task_id FROM conversation_threads th JOIN tasks t ON t.id = th.root_task_id WHERE th.anchor_message_id = ?`, priorMsg.id)[0] ?? null : null;
      await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
      const priorUi = priorMsg != null ? await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes(${JSON.stringify(priorMarker)}))`, 30_000, '重启历史：上一轮标记可见').catch(() => false) : false;
      f.priorRunHistory = { marker: priorMarker, messageId: priorMsg?.id ?? null, taskId: priorTask?.task_id ?? null, uiVisible: priorUi === true };
      f.priorRunHistoryOk = priorMsg != null && priorTask != null && priorUi === true;
    }
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].length > 0`, 150_000, '主池线程卡（种子宽窗）');
    f.poolCards = true;
    // ⓪ H3+标题栏：无边框窗口自绘标题栏（React 版+三键+38px 偏移）与看板页（board.view 真命令）。
    const tbPkg = await waitFor(cdp, `(() => { const bar = document.querySelector('.zs-titlebar[data-zs-titlebar-rendered=react]'); if (bar == null) return null; const btns = bar.querySelectorAll('.zs-winbtn').length; const top = getComputedStyle(document.getElementById('hifi-root')).top; return btns === 3 && top === '38px' && document.body.classList.contains('zs-frameless'); })()`, 20_000, '打包产物：自绘标题栏');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('任务看板'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-board=hifi]') != null`, 20_000, '看板页挂载');
    // 内容事实按页面真实结果取（空项目=没有任务；装载失败=如实失败——不等待固定列词）。
    await waitFor(cdp, `(() => { const p = document.querySelector('[data-zs-board=hifi]'); return p != null && !p.textContent.includes('正在装载'); })()`, 30_000, '看板内容落定');
    const boardText = await cdp.tryEval(probe(`document.querySelector('[data-zs-board=hifi]')?.innerText.slice(0, 400) ?? ''`));
    const boardLoadedOk = boardText != null && !String(boardText).includes('装载失败');
    if (!boardLoadedOk) console.log('[r61] 看板装载失败文本：' + String(boardText).slice(0, 160));
    // r55：种子房间任务卡（H3 短测前置——干净种子的看板必须有可点击房间任务卡；幂等，run2 复用）。
    const seededCardOk = String(boardText ?? '').includes('看板房间任务样本');
    if (!seededCardOk) console.log('[r61] 种子任务卡未见：' + String(boardText).slice(0, 200));
    f.h3Board = { titlebarOk: tbPkg === true, boardContentLoaded: boardLoadedOk, seededRoomTaskCard: seededCardOk, boardText: String(boardText ?? '').slice(0, 120) };
    // r55：搜索与收藏（真 app bundle——search.query 命中）与活动流（activity.list 条目）。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('搜索与收藏'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('[data-zs-library=hifi]') != null`, 15_000, '搜索与收藏页挂载');
    await cdp.eval(probe(`(() => { const input = [...document.querySelectorAll('[data-zs-library] input')].find((i) => (i.placeholder || '').includes('搜消息')); if (input == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '回归'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`));
    const libraryHit = await waitFor(cdp, `(() => { const p = document.querySelector('[data-zs-library]'); return p != null && p.querySelectorAll('.root-card').length > 0; })()`, 20_000, '搜索命中（种子回归样本）').catch(() => false);
    f.librarySearch = { hit: libraryHit === true };
    // r61 v5：收藏切换（按钮态×saved_refs）与文件引用重做（引用卡+正文零污染+摘录内容源）打包形态冒烟。
    // 收藏用**种子任务线程**（有 agent 回复——书签只在回复消息上；PPT 样本是记录串无回复）。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('看板房间任务样本'))`, 60_000, 'v5：种子任务卡');
    await cdp.eval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('看板房间任务样本')); card?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.querySelector('[data-zs-saved]') != null)`, 90_000, 'v5：回复消息书签按钮');
    const favBefore = await cdp.tryEval(probe(`document.querySelectorAll('#hifi-root .msg [data-zs-saved]').length`));
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .msg [data-zs-saved]')][0]; b?.click(); return true; })()`));
    const favSaved = await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg [data-zs-saved="1"]')].length > 0`, 15_000, 'v5：已收藏态').catch(() => false);
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .msg [data-zs-saved="1"]')][0]; b?.click(); return true; })()`));
    const favUnsaved = await waitFor(cdp, `document.querySelectorAll('#hifi-root .msg [data-zs-saved="1"]').length === 0`, 15_000, 'v5：再次点击取消').catch(() => false);
    f.v5favorites = { buttons: Number(favBefore ?? 0), saved: favSaved === true, unsavedBack: favUnsaved === true, dbRows: dbQuery('SELECT count(*) c FROM saved_refs').map((r) => r.c).join(',') };
    // 文件引用：回主池开 PPT 样本线程 → 成果与附件标签（无 Composer）→ 预览 → 引用文件两次 → 自动回回复、恰一张卡、正文零污染。
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => (x.title || '').includes('返回主池')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('PPT 预览样本'))`, 30_000, 'v5：回主池见 PPT 卡');
    await cdp.eval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('PPT 预览样本')); card?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('.msg-attach')].some((b) => b.textContent.includes('回归幻灯'))`, 30_000, 'v5：PPT 线程锚块芯片');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('成果与附件')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('[data-zs-thread-artifacts=hifi] .msg-attach')].some((b) => b.textContent.includes('回归幻灯'))`, 25_000, 'v5：成果页 PPT 芯片');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-thread-artifacts=hifi] .msg-attach')].find((x) => x.textContent.includes('回归幻灯')); b?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('[data-zs-preview=hifi]') != null`, 20_000, 'v5：预览打开');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-preview=hifi] button')].find((x) => x.textContent.trim() === '引用文件'); b?.click(); return true; })()`));
    await sleep(250);
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-preview=hifi] button')].find((x) => x.textContent.trim() === '引用文件'); b?.click(); return true; })()`));
    await sleep(500);
    const backAtReplies = await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15_000, 'v5：自动切回回复').catch(() => false);
    const quoteChips = await cdp.tryEval(probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].filter((c) => c.querySelector('svg[data-icon=paperclip]')).length`));
    const bodyAfterQuote = await cdp.tryEval(probe(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`));
    // 摘录：等文本卡片装载后点摘录 → 正文只含内容（PPT 文本层第一页）。
    const slideTextReady = await waitFor(cdp, `document.querySelector('[data-zs-preview=hifi]')?.textContent.includes('回归幻灯')`, 20_000, 'v5：PPT 提取文本').catch(() => false);
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-preview=hifi] button')].find((x) => x.textContent.trim() === '摘录'); b?.click(); return true; })()`));
    await sleep(700);
    const bodyAfterExcerpt = await cdp.tryEval(probe(`document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`));
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-preview=hifi] button')].find((x) => (x.title || '').includes('关闭预览')); b?.click(); return true; })()`));
    f.v5quote = { backAtReplies: backAtReplies === true, chips: Number(quoteChips ?? -1), bodyAfterQuoteClean: String(bodyAfterQuote ?? '').trim().length === 0, slideTextReady: slideTextReady === true, excerptHasMark: String(bodyAfterExcerpt ?? '').includes('> 摘录「回归幻灯.pptx」'), excerptNoUiNoise: !String(bodyAfterExcerpt ?? '').includes('模型输入') && !String(bodyAfterExcerpt ?? '').includes('原文 ') };
    f.v5favoritesOk = f.v5favorites.saved === true && f.v5favorites.unsavedBack === true;
    f.v5quoteOk = f.v5quote.backAtReplies === true && f.v5quote.chips === 1 && f.v5quote.bodyAfterQuoteClean === true && f.v5quote.excerptHasMark === true && f.v5quote.excerptNoUiNoise === true;
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('活动流'))?.click(), true`));
    const activityOk = await waitFor(cdp, `(() => { const p = document.querySelector('[data-zs-activity=hifi]'); return p != null && p.querySelectorAll('[data-zs-activity-item]').length > 0; })()`, 20_000, '活动流条目').catch(() => false);
    f.activityList = { items: activityOk === true };
    // r56 H4：标题栏派发防护标识（演练包=演练·模拟派发）+命令面板（Ctrl+K 开/真实项/Esc 关）+恢复检查入口。
    const guardBadge = await waitFor(cdp, `(() => { const b = document.querySelector('.zs-titlebar [data-zs-dispatch-guard]'); return b != null && b.getAttribute('data-zs-dispatch-guard') === 'fake' && b.textContent.includes('演练·模拟派发'); })()`, 15_000, '真包：防护标识').catch(() => false);
    await cdp.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`);
    const paletteOpen = await waitFor(cdp, `document.querySelector('[data-zs-palette=hifi]') != null`, 8_000, '真包：Ctrl+K 面板').catch(() => false);
    await cdp.eval(probe(`(() => { const input = document.querySelector('[data-zs-palette=hifi] input'); if (input == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '默认房间'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    const paletteItem = await waitFor(cdp, `document.querySelector('[data-zs-palette-item=房间]') != null`, 10_000, '真包：面板房间项').catch(() => false);
    await cdp.eval(probe(`(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`));
    const paletteClosed = await waitFor(cdp, `document.querySelector('[data-zs-palette=hifi]') == null`, 6_000, '真包：Esc 关闭面板').catch(() => false);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('恢复检查'))?.click(), true`));
    const recoveryOk = await waitFor(cdp, `(() => { const p = document.querySelector('[data-zs-recovery=hifi]'); return p != null && (p.textContent.includes('没有需要处理的恢复事项') || p.textContent.includes('UNKNOWN') || p.textContent.includes('门禁')); })()`, 12_000, '真包：恢复检查面板').catch(() => false);
    // r57：重启轮（n>1）上次关窗落在 fake 停滞窗内→UNKNOWN turn+门禁——**准入继承生效**（同成员
    // 新派发被正确扣住）。验证器按真实用户恢复流收口：逐 UNKNOWN 对账（executed→服务端
    // no-os-process 取证→释放占用）→ 确认继续派发（dispatch.resume）→ 后续派发按合同继续。
    let recoveryHealed = true;
    if (n > 1) {
      const unknownCount = await cdp.tryEval(probe(`(() => { const p = document.querySelector('[data-zs-recovery=hifi]'); return p == null ? 0 : [...p.querySelectorAll('button')].filter((b) => b.textContent === '对账…').length; })()`));
      for (let i = 0; i < Number(unknownCount ?? 0); i += 1) {
        await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-recovery=hifi] button')].find((x) => x.textContent === '对账…'); b?.click(); return true; })()`));
        await sleep(500);
        await cdp.eval(probe(`(() => { const sel = document.querySelector('[data-zs-recovery=hifi] select'); if (sel == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, 'executed'); sel.dispatchEvent(new Event('change', { bubbles: true })); const ta = document.querySelector('[data-zs-recovery=hifi] textarea'); if (ta == null) return false; const tset = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; tset.call(ta, 'R57 包验证：重启后按真实恢复流对账（executed/no-os-process）'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
        await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-recovery=hifi] button')].find((x) => x.textContent === '提交对账'); b?.click(); return true; })()`));
        await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('对账已提交'))`, 12_000, '包验证：重启对账').catch(() => { recoveryHealed = false; });
        await sleep(600);
      }
      const resumeBtn = await cdp.tryEval(probe(`[...document.querySelectorAll('[data-zs-recovery=hifi] button')].some((b) => b.textContent === '确认继续派发')`));
      if (resumeBtn === true) {
        await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-recovery=hifi] button')].find((x) => x.textContent === '确认继续派发'); b?.click(); return true; })()`));
        await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('已确认继续'))`, 12_000, '包验证：确认继续派发').catch(() => { recoveryHealed = false; });
      }
      await sleep(1500); // worker 周期 drain 领取恢复后的排队意图
    }
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('[data-zs-recovery=hifi] button')].find((x) => x.textContent === '关闭'); b?.click(); return true; })()`));
    f.h4shell = { guardBadge: guardBadge === true, palette: paletteOpen === true && paletteItem === true && paletteClosed === true, recovery: recoveryOk === true, restartRecoveryHeal: recoveryHealed };
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].length > 0`, 60_000, '回主池');
    // ② 带附件派发 @Guide A → 受控丢回执 → 原信封重发恰一次；成功后附件芯片剥离（§4 清算）
    // r55 前置复证（真 app bundle）：M0 发送前提示（空指派=AUTO 时可见）+ T2 触发位置消费
    //（用户实测反例「整理任务要点@」——中文紧邻；选中后正文 @ 消失、芯片保留）。
    for (let ci = 0; ci < 4; ci += 1) {
      const gone = await cdp.tryEval(probe(`(() => { const row = document.querySelector('#hifi-root .composer-mentions'); if (row == null) return true; const chips = [...row.querySelectorAll('.chip')].filter((c) => (c.textContent || '').includes('Guide')); if (chips.length === 0) return true; chips[0].querySelector('button')?.click(); return false; })()`));
      if (gone === true) break;
      await sleep(250);
    }
    await typeInto(cdp, '');
    const m0HintReal = await waitFor(cdp, `document.querySelector('[data-zs-m0-hint="AUTO"]') != null`, 12_000, '真包：M0 发送前提示（AUTO）').catch(() => false);
    await typeInto(cdp, '整理任务要点@');
    await waitFor(cdp, `document.querySelector('#hifi-root .mention-pop') != null`, 8_000, '真包：@ 候选框');
    await cdp.eval(probe(`(() => { const item = [...document.querySelectorAll('#hifi-root .mention-pop .menu-item')].find((b) => b.textContent.includes('Guide A')); item?.click(); return true; })()`));
    const t2BodyClean = await waitFor(cdp, `(() => { const ta = document.querySelector('#hifi-root textarea'); return ta != null && ta.value === '整理任务要点'; })()`, 8_000, '真包：T2 正文 @ 已消费').catch(() => false);
    const t2Chip = await cdp.tryEval(probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => (c.textContent || '').includes('Guide A'))`));
    const hintGoneDirect = await waitFor(cdp, `document.querySelector('[data-zs-m0-hint]') == null`, 8_000, '真包：DIRECT 后提示消失').catch(() => false);
    f.t2m0Real = { m0HintAuto: m0HintReal === true, bodyClean: t2BodyClean === true, chipKept: t2Chip === true, hintGoneDirect: hintGoneDirect === true };
    const marker = `R57房间派发run${n}`;
    const mdRetry = fs.readFileSync(path.join(copyDir, 'samples', 'preview-r52-样例.md'));
    await pickFile(cdp, 'retry-att.md', 'text/markdown', mdRetry);
    await waitFor(cdp, probe(chipText('retry-att') + ` && [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('retry-att')).textContent.includes('v1')`), 20_000, 'retry-att ready');
    await cdp.eval(probe(`(() => { const atBtn = [...document.querySelectorAll('#hifi-root button')].find((b) => (b.title || '').includes('提及成员')); atBtn?.click(); return true; })()`));
    await sleep(400);
    await cdp.eval(probe(`(() => { const item = [...document.querySelectorAll('#hifi-root .mention-pop .menu-item')].find((b) => b.textContent.includes('Guide A')); item?.click(); return true; })()`));
    await sleep(250);
    await typeInto(cdp, marker);
    await sendCurrent(cdp, '带附件派发（回执将丢）');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((e) => e.textContent.includes('结果未知'))`, 35_000, '受控丢回执→unknown banner');
    f.lostAckBanner = true;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .chip.record-chip button')].find((x) => x.textContent.includes('重发原内容')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes(${JSON.stringify(marker)}))`, 30_000, '重发后主池可见');
    await sleep(6000);
    // 重试成功清算：retry-att 芯片剥离（不再随下一条携带）。
    const retryChipGone = (await cdp.tryEval(probe(chipText('retry-att')))) === false;
    const roomMsgs = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%${marker}%`);
    const roomTask = roomMsgs[0] != null ? dbQuery(`SELECT t.id task_id, (SELECT count(*) FROM workflow_runs r WHERE r.task_id = t.id) runs FROM conversation_threads th JOIN tasks t ON t.id = th.root_task_id WHERE th.anchor_message_id = ?`, roomMsgs[0].id)[0] ?? null : null;
    const retryArt = artifactId('retry-att.md');
    f.roomDispatch = { messageId: roomMsgs[0]?.id ?? null, exactlyOnce: roomMsgs.length === 1, taskId: roomTask?.task_id ?? null, runs: roomTask?.runs ?? 0, retryAttachmentLinks: retryArt != null ? linkCount(retryArt) : 0 };
    f.roomDispatchOk = roomMsgs.length === 1 && roomTask != null && roomTask.runs >= 1 && retryArt != null && linkCount(retryArt) === 1;
    // ②b 下一条只带新资源：新附件 → 仅记录发送 → retry-att 不重带、新资源恰一次。
    await pickFile(cdp, 'new-att.md', 'text/markdown', mdRetry);
    await waitFor(cdp, probe(chipText('new-att') + ` && [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('new-att')).textContent.includes('v1')`), 20_000, 'new-att ready');
    await typeInto(cdp, `R57清算下一条run${n}`);
    await pickRecordIntent(cdp);
    await sendCurrent(cdp, '清算下一条（仅记录）');
    // 房间主池视图没有 .msg——记录消息以新线程卡（root-card）呈现。
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes(${JSON.stringify(`R57清算下一条run${n}`)}))`, 25_000, '清算下一条上屏');
    await sleep(1500);
    const nextLinks = msgLinks(`R57清算下一条run${n}`) ?? [];
    const newArt = artifactId('new-att.md');
    f.retrySettlement = { chipStrippedAfterRetry: retryChipGone, nextMsgLinks: nextLinks.map((x) => x.source_name), retryArtTotalLinks: retryArt != null ? linkCount(retryArt) : -1, newArtLinks: newArt != null ? linkCount(newArt) : 0 };
    f.retrySettlementOk = retryChipGone === true && nextLinks.length === 1 && nextLinks[0].source_name === 'new-att.md' && (retryArt != null ? linkCount(retryArt) : -1) === 1 && (newArt != null ? linkCount(newArt) : 0) === 1;
    // ③ 打开该线程卡 → 锚块+回复 → 发跟进（不另建根任务）
    const tasksBefore = dbQuery('SELECT count(*) c FROM tasks')[0].c;
    await cdp.eval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes(${JSON.stringify(marker)})); card?.click(); return true; })()`));
    await waitFor(cdp, `(() => { const els = [...document.querySelectorAll('#hifi-root .panel, #hifi-root div')]; return els.some((e) => (e.textContent || '').startsWith('原消息') && (e.textContent || '').includes(${JSON.stringify(marker)})); })()`, 15_000, '线程锚块');
    f.threadAnchor = true;
    await typeInto(cdp, `R57线程跟进run${n}`);
    await clickBtn(cdp, `/发送|保存记录/.test(b.textContent) && b.textContent.length <= 6`, '线程跟进发送');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(`R57线程跟进run${n}`)}))`, 25_000, '跟进上屏');
    await sleep(1500);
    const followRow = dbQuery(`SELECT thread_id FROM messages WHERE body_json LIKE ?`, `%R57线程跟进run${n}%`)[0] ?? null;
    const tasksAfter = dbQuery('SELECT count(*) c FROM tasks')[0].c;
    const thId = dbQuery(`SELECT id FROM conversation_threads WHERE anchor_message_id = ?`, roomMsgs[0].id)[0].id;
    f.threadFollowUp = { inThread: followRow?.thread_id === thId, tasksDelta: tasksAfter - tasksBefore };
    f.threadFollowUpOk = f.threadFollowUp.inThread === true && tasksAfter === tasksBefore;
    // ④ 附件+文本预览（真内容）
    const mdBytes = fs.readFileSync(path.join(copyDir, 'samples', 'preview-r52-样例.md'));
    await pickFile(cdp, 'preview-r52-样例.md', 'text/markdown', mdBytes);
    await waitFor(cdp, probe(chipText('preview-r52-样例.md') + ` && [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('preview-r52-样例.md')).textContent.includes('v1')`), 20_000, 'md ready');
    await typeInto(cdp, `R57附件消息run${n}`);
    await sendCurrent(cdp, '附件发送');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(`R57附件消息run${n}`)}))`, 25_000, '附件消息上屏');
    await sleep(1500);
    const attMsg = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%R57附件消息run${n}%`)[0];
    const attCount = attMsg != null ? dbQuery('SELECT count(*) c FROM message_attachments WHERE message_id = ?', attMsg.id)[0].c : 0;
    await cdp.eval(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .msg-attach')].find((b) => b.textContent.includes('preview-r52-样例.md')); chip?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('[data-zs-preview=hifi] pre')].some((p) => (p.textContent || '').includes('H2 预览样例'))`, 15_000, '共享预览真内容');
    f.previewText = true;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('关闭') && x.closest('[data-zs-preview=hifi]') != null); b?.click(); return true; })()`));
    f.attachmentSend = { messageAttachmentLinks: attCount };
    f.attachmentSendOk = attCount === 1 && f.previewText === true;
    // ⑤ PPT 视觉正常链（§2 强制）：包内 pptx 样本 → 预览 → 真舞台子节点>0 + done + 页数=3
    const pptxBytes = fs.readFileSync(path.join(copyDir, 'samples', 'preview-r52-样例.pptx'));
    await pickFile(cdp, 'preview-r52-样例.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pptxBytes);
    await waitFor(cdp, probe(chipText('preview-r52-样例.pptx') + ` && [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('preview-r52-样例.pptx')).textContent.includes('v1')`), 30_000, 'pptx ready');
    await cdp.eval(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('preview-r52-样例.pptx')); const btn = [...(chip?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('预览')); btn?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('[data-zs-preview=hifi] .panel, [data-zs-preview=hifi] div')].some((d) => (d.textContent || '').includes('幻灯片 1'))`, 60_000, 'pptx 提取文本卡片');
    const stageOk = await waitFor(cdp, `(() => { const st = document.querySelector('[data-zs-pptx-stage=hifi]'); return st != null && st.childElementCount > 0; })()`, 60_000, 'pptx 真舞台渲染');
    const doneOk = await waitFor(cdp, `document.querySelector('[data-zs-visual-state=done]') != null`, 30_000, 'pptx visual-state=done');
    const slideCount = await cdp.tryEval(probe(`document.querySelector('[data-zs-slide-count]')?.getAttribute('data-zs-slide-count')`));
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('关闭') && x.closest('[data-zs-preview=hifi]') != null); b?.click(); return true; })()`));
    f.pptxVisual = { stageChildren: stageOk === true, visualDone: doneOk === true, slideCount };
    f.pptxVisualOk = stageOk === true && doneOk === true && String(slideCount) === '3';
    // ⑥ 图片能力门（先正文）：门条 → 仅发送文字 → 成功
    const pngBytes = fs.readFileSync(path.join(copyDir, 'samples', 'preview-r52-样例.png'));
    await pickFile(cdp, 'preview-r52-样例.png', 'image/png', pngBytes);
    await waitFor(cdp, probe(chipText('preview-r52-样例.png') + ` && [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('preview-r52-样例.png')).textContent.includes('v1')`), 20_000, 'png ready');
    await typeInto(cdp, `R57图片门run${n}`);
    await sendCurrent(cdp, '图片发送');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((c) => c.textContent.includes('图片能力门'))`, 15_000, '图片能力门出现');
    f.imageGateShown = true;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .chip.record-chip button')].find((x) => x.textContent.includes('仅发送文字')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(`R57图片门run${n}`)}))`, 25_000, '图片消息上屏');
    await sleep(1500);
    const imgMsg = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%R57图片门run${n}%`)[0];
    const imgCount = imgMsg != null ? dbQuery("SELECT count(*) c FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id = ? AND a.kind = 'image_file'", imgMsg.id)[0].c : 0;
    f.imageGate = { messageImageLinks: imgCount };
    f.imageGateOk = imgCount === 1;
    // ⑦ 移除附件的真实引用（§3 就绪态路径）：ready 芯片移除 → 下一条零链接、artifact 仍在
    await clickBtn(cdp, `b.textContent.includes('返回主池')`, '返回主池');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].length > 0`, 15_000, '主池（移除场景）');
    await pickFile(cdp, 'remove-me.md', 'text/markdown', mdBytes);
    await waitFor(cdp, probe(chipText('remove-me') + ` && [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('remove-me')).textContent.includes('v1')`), 20_000, 'remove-me ready');
    // ready 芯片内首按钮是「预览」——移除 ✕ 是不含「预览」文字的那个按钮。
    await cdp.eval(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('remove-me')); const rm = [...(chip?.querySelectorAll('button') ?? [])].filter((b) => !b.textContent.includes('预览')).pop(); rm?.click(); return true; })()`));
    await sleep(600);
    const rmChipGone = (await cdp.tryEval(probe(chipText('remove-me')))) === false;
    await typeInto(cdp, `R57移除后发送run${n}`);
    await pickRecordIntent(cdp);
    await sendCurrent(cdp, '移除后发送（仅记录）');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes(${JSON.stringify(`R57移除后发送run${n}`)}))`, 25_000, '移除后消息上屏');
    await sleep(1500);
    const rmLinks = msgLinks(`R57移除后发送run${n}`) ?? [];
    const rmArt = artifactId('remove-me.md');
    f.removeGhost = { chipRemoved: rmChipGone, msgLinks: rmLinks.map((x) => x.source_name), artifactStillExists: rmArt != null, artifactLinks: rmArt != null ? linkCount(rmArt) : -1 };
    f.removeGhostOk = rmChipGone === true && rmLinks.length === 0 && rmArt != null && linkCount(rmArt) === 0;
    // ⑧ 深链：#task= → /thread/:id?tab=task + 详情实际选中
    await cdp.eval(`location.hash = ${JSON.stringify('#task=' + roomTask.task_id)}; true`);
    await waitFor(cdp, `location.hash.startsWith('#/thread/') && location.hash.includes('tab=task')`, 15_000, '深链路由').catch(async () => {
      const ctx = await cdp.tryEval(probe(`JSON.stringify({ hash: location.hash, toast: document.querySelector('.toast')?.textContent ?? null, text: document.body.innerText.slice(0, 200) })`)).catch(() => null);
      throw new Error('深链路由：' + String(ctx));
    });
    await waitFor(cdp, `(() => { const tabs = [...document.querySelectorAll('#hifi-root .thread-nav button[role=tab]')]; const d = tabs.find((b) => b.textContent.includes('详情')); return d != null && d.getAttribute('aria-selected') === 'true'; })()`, 15_000, '详情实际选中');
    f.deepLinkDetail = true;
    // ⑨ 正式停机：window.close → shutdown + PID 归零 + launcher 退出
    const beforeQ = procsOfCopy();
    f.procsBeforeCloseQuery = { ok: beforeQ.ok, count: (beforeQ.procs ?? []).length, error: beforeQ.error ?? null };
    const capturedPids = (beforeQ.procs ?? []).map((x) => x.pid);
    f.procsBeforeCloseConfirmed = beforeQ.ok === true && capturedPids.length >= 1;
    // 标题栏关闭键 → zs:window 窄 IPC → win.close() → 既有优雅收口链（非直接 window.close）。
    const closedViaTitlebar = await cdp.tryEval(probe(`(() => { const b = document.querySelector('.zs-titlebar .zs-winbtn.close'); if (b == null) return false; b.click(); return true; })()`));
    f.closedViaTitlebar = closedViaTitlebar === true;
    await cdp.eval('window.close(); true').catch(() => { /* 若已因标题栏关闭开始收口，此处静默 */ });
    let exited = false;
    let exitUnconfirmed = 0;
    for (let i = 0; i < 45; i += 1) {
      await sleep(1000);
      const q = procsOfCopy();
      if (!q.ok) { exitUnconfirmed += 1; continue; }
      if (q.procs.length === 0) { exited = true; break; }
    }
    f.gracefulExitByProcTree = exited;
    f.exitQueryUnconfirmed = exitUnconfirmed;
    const gone = pidsGone(capturedPids);
    f.capturedPidsGone = gone.ok === true && gone.gone === true ? true : { ok: gone.ok, alive: gone.alive ?? null };
    clearInterval(pauseFeeder);
    try { child.stdin.write(String.fromCharCode(10)); } catch { /* 已退出 */ }
    f.batExit = await Promise.race([batExitPromise, sleep(15_000).then(() => ({ code: 'still-running' }))]);
    await sleep(1500);
    let shutdown = null;
    try { shutdown = JSON.parse(fs.readFileSync(path.join(copyDir, 'server-data', 'desktop-shutdown.json'), 'utf8')); } catch { shutdown = null; }
    const lastShutdown = Array.isArray(shutdown) ? shutdown[shutdown.length - 1] : shutdown;
    f.shutdownRecord = lastShutdown;
    f.shutdownOk = lastShutdown != null && lastShutdown.forced !== true && (lastShutdown.reason != null || lastShutdown.requestDelivered != null || lastShutdown.exitCode != null);
    const residualQ = procsOfCopy();
    f.residualQuery = { ok: residualQ.ok, error: residualQ.error ?? null };
    f.residualProcs = residualQ.procs ?? null;
    f.residualZero = procsOkZero(residualQ);
    f.seeded = out.includes('Seeded.');
    f.identityAfter = manifestIdentity();
    f.identitySameApp = f.identityBefore.buildId === f.identityAfter.buildId && f.identityBefore.manifestSha === f.identityAfter.manifestSha && f.identityBefore.buildSha === f.identityAfter.buildSha;
    f.realCalls = (() => { try { return dbQuery('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } })();
    f.consoleTail = out.slice(-300);
    f.pass = f.autoProject === true && (n === 1 || f.priorRunHistoryOk === true) && f.poolCards === true
      && f.h4shell?.guardBadge === true && f.h4shell?.palette === true && f.h4shell?.recovery === true && f.h4shell?.restartRecoveryHeal === true
      && f.roomDispatchOk === true && f.lostAckBanner === true && f.retrySettlementOk === true
      && f.threadAnchor === true && f.threadFollowUpOk === true
      && f.attachmentSendOk === true && f.pptxVisualOk === true && f.imageGateShown === true && f.imageGateOk === true
      && f.removeGhostOk === true && f.deepLinkDetail === true
      && f.h3Board?.titlebarOk === true && f.h3Board?.boardContentLoaded === true && f.h3Board?.seededRoomTaskCard === true
      && f.librarySearch?.hit === true && f.activityList?.items === true && f.t2m0Real?.m0HintAuto === true
      && f.t2m0Real?.bodyClean === true && f.t2m0Real?.chipKept === true && f.t2m0Real?.hintGoneDirect === true
      && f.closedViaTitlebar === true
      && f.procsBeforeCloseConfirmed === true && f.capturedPidsGone === true && f.gracefulExitByProcTree === true
      && f.shutdownOk === true && f.residualZero === true && typeof f.batExit?.code === 'number'
      && f.identitySameApp === true && f.realCalls === 0;
    return f;
  } catch (e) {
    f.failedAt = e.message;
    f.error = String(e.message ?? e);
    f.consoleTail = out.slice(-500);
  } finally {
    clearInterval(pauseFeeder);
    try { if (cdp != null && !cdp.closed) await cdp.eval('window.close(); true').catch(() => {}); } catch { /* 已关 */ }
    for (let i = 0; i < 30 && !procsOkZero(procsOfCopy()); i += 1) await sleep(1000);
    const cleanupQ = procsOfCopy();
    f.cleanupProcsLeft = cleanupQ.ok ? (cleanupQ.procs ?? []).length : 'unconfirmed';
  }
  return f;
}

(async () => {
  if (!fs.existsSync(path.join(srcPkg, 'start-server.bat'))) { console.error('[r61] 源包缺失：' + srcPkg); process.exit(1); }
  // r58 P5：**包根材料单独核验**（独立于应用 591 清单——review-r57 §4：包内 README/模板
  // 与源码新文案不一致是既有反例）。核当前源包根：README-H4=v3 口径（含返工显式执行）、
  // H4-TEST-template=合并 G1–G10 清单（含「执行返工」「尚未执行」步骤）。
  const mat = { readmeH4: false, templateMerged: false, templateReworkStep: false };
  try {
    const rd = fs.readFileSync(path.join(srcPkg, 'README-H4.md'), 'utf8');
    mat.readmeH4 = rd.includes('H4 收尾候选 v5') && rd.includes('收藏可切换') && rd.includes('文件引用重做') && rd.includes('草稿与未知信封保持');
    const tp = fs.readFileSync(path.join(srcPkg, 'RESULTS', 'H4-TEST-template.md'), 'utf8');
    mat.templateMerged = tp.includes('R1 收藏切换') && tp.includes('R2 文件引用与 Esc') && tp.includes('H4-v5 补测清单') && tp.includes('引用文件');
    mat.templateReworkStep = tp.includes('摘录') && tp.includes('继承说明') && tp.includes('未自动粘贴') && tp.includes('关闭窗口放最后');
  } catch (e) { mat.error = String(e.message ?? e); }
  console.log('[r61] 包根材料核验：' + JSON.stringify(mat));
  if (!(mat.readmeH4 && mat.templateMerged && mat.templateReworkStep)) {
    console.error('[r61] 包根材料与当前源码文案不一致——拒绝三连（先修材料再打包）');
    process.exit(5);
  }
  const existing = procsOfCopy();
  if (!existing.ok) { console.error(`[r61] 副本进程查询未确认（${existing.error}）`); process.exit(1); }
  if ((existing.procs ?? []).length > 0) { console.error(`[r61] 副本路径仍有 ${existing.procs.length} 个进程`); process.exit(1); }
  fs.rmSync(copyRoot, { recursive: true, force: true });
  fs.mkdirSync(copyRoot, { recursive: true });
  console.log('[r61] 拷贝独立测试副本（交付包不动）…');
  fs.cpSync(srcPkg, copyDir, { recursive: true });
  fs.rmSync(path.join(copyDir, 'server-data'), { recursive: true, force: true });
  const runs = [];
  for (let n = 1; n <= (process.env.R59_RUNS ? Number(process.env.R59_RUNS) : 3); n += 1) {
    const f = await runOnce(n);
    fs.writeFileSync(path.join(outDir, `${f.runId}.json`), JSON.stringify(f, null, 2));
    console.log(`[r61] run${n} pass=${f.pass} ${f.failedAt ?? ''} realCalls=${f.realCalls} pptxVisual=${f.pptxVisualOk} retrySettle=${f.retrySettlementOk} removeGhost=${f.removeGhostOk} residual=${f.residualZero}`);
    runs.push(f);
    await sleep(2000);
  }
  const all = runs.every((r) => r.pass === true);
  fs.writeFileSync(path.join(outDir, `${runId}-summary.json`), JSON.stringify({ allPass: all, runId, srcPkg, copyDir, packageRootMaterials: mat, runs: runs.map((r) => ({ run: r.run, pass: r.pass, failedAt: r.failedAt ?? null, buildId: r.identityBefore?.buildId, realCalls: r.realCalls, batExitCode: r.batExit?.code ?? null, attachmentLinks: r.attachmentSend?.messageAttachmentLinks ?? null, imageLinks: r.imageGate?.messageImageLinks ?? null, pptxVisual: r.pptxVisual ?? null, retrySettlement: r.retrySettlement ?? null, removeGhost: r.removeGhost ?? null })) }, null, 2));
  console.log('[r61] allPass=' + all + ' runId=' + runId);
  process.exit(all ? 0 : 4);
})();
