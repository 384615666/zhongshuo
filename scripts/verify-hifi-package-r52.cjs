'use strict';
/**
 * R52 H2 候选验证器（review-r51 §6.5）——在**独立测试副本**上运行交付 bat 的完整 H2 链，
 * 不动用户包（H1 v2/v6 原地稳定）：
 *  每轮：真实 start-server.bat（清父环境；工程直通=CDP 端口+受控丢回执）→ 首启自动项目 →
 *  主池线程卡 → 房间 @Guide A 派发（丢回执→原信封重发恰一次）→ 打开新线程 → 回复跟进
 *  （不另建根任务）→ 附件真实上传（页面 File 注入包内样本）→ 随信封发送 → 消息挂附件 →
 *  共享预览面板（previewText 真内容）→ 图片能力门（png→仅发送文字→imageAck 冻结）→
 *  深链 #task= → 线程详情实际选中 → window.close 正式停机 → shutdown 记录 forced!=true →
 *  副本路径进程归零（PID 身份）→ real_calls=0。run2 额外核重启历史（上一轮标记可见）。
 * 产物 dist/desktop/hifi-h2-verify-r52/。
 * 运行：node scripts/verify-hifi-package-r52.cjs [--src 包目录]（默认 dist/desktop/hifi-h2-win-v1）。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const repo = path.resolve(__dirname, '..');
const srcPkg = process.argv.includes('--src') ? path.resolve(process.argv[process.argv.indexOf('--src') + 1]) : path.join(repo, 'dist', 'desktop', 'hifi-h2-win-v1');
const copyRoot = path.join(repo, 'dist', 'desktop', 'hifi-h2-verify-r52-copy');
const copyDir = path.join(copyRoot, 'h2 副本 run');
const outDir = path.join(repo, 'dist', 'desktop', 'hifi-h2-verify-r52');
fs.mkdirSync(outDir, { recursive: true });
const runId = `r52-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
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
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
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
/** 页面内构造 File 注入 Composer（字节经 JSON 数组传输——真实上传通道）。 */
async function pickFile(cdp, name, mime, bytes) {
  await cdp.eval(`(async () => { const input = document.querySelector('#hifi-root input[type=file]'); if (input == null) return 'NO_INPUT'; const file = new File([Uint8Array.from(${JSON.stringify(Array.from(bytes))})], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return 'OK'; })()`);
}
function manifestIdentity() {
  const m = path.join(copyDir, 'ZhongshuoDual', 'MANIFEST-SHA256.json');
  const b = path.join(copyDir, 'ZhongshuoDual', 'BUILD.json');
  return { buildId: JSON.parse(fs.readFileSync(b, 'utf8')).buildId, manifestSha: sha256File(m), buildSha: sha256File(b) };
}

async function runOnce(n) {
  const port = 9490 + n;
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
    // ① 首启自动项目 + 主池线程卡（H2 形态）
    await waitFor(cdp, `document.body.classList.contains('hifi-on') && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 110_000, '首启自动进入项目');
    f.autoProject = true;
    if (n > 1) {
      // 重启历史：上一轮标记消息可见（正文匹配；身份在库面）。
      const priorMarker = `R52房间派发run${n - 1}`;
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
    // ② 房间 @Guide A 派发 → 丢回执 → 原信封重发恰一次
    const marker = `R52房间派发run${n}`;
    await cdp.eval(probe(`(() => { const atBtn = [...document.querySelectorAll('#hifi-root button')].find((b) => (b.title || '').includes('提及成员')); atBtn?.click(); return true; })()`));
    await sleep(400);
    await cdp.eval(probe(`(() => { const item = [...document.querySelectorAll('#hifi-root .mention-pop .menu-item')].find((b) => b.textContent.includes('Guide A')); item?.click(); return true; })()`));
    await sleep(250);
    await typeInto(cdp, marker);
    await clickBtn(cdp, `/发送|保存记录/.test(b.textContent) && b.textContent.length <= 6`, '发送');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((e) => e.textContent.includes('结果未知'))`, 35_000, '受控丢回执→unknown banner');
    f.lostAckBanner = true;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .chip.record-chip button')].find((x) => x.textContent.includes('重发原内容')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes(${JSON.stringify(marker)}))`, 30_000, '重发后主池可见');
    await sleep(6000);
    const roomMsgs = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%${marker}%`);
    const roomTask = roomMsgs[0] != null ? dbQuery(`SELECT t.id task_id, (SELECT count(*) FROM workflow_runs r WHERE r.task_id = t.id) runs FROM conversation_threads th JOIN tasks t ON t.id = th.root_task_id WHERE th.anchor_message_id = ?`, roomMsgs[0].id)[0] ?? null : null;
    f.roomDispatch = { messageId: roomMsgs[0]?.id ?? null, exactlyOnce: roomMsgs.length === 1, taskId: roomTask?.task_id ?? null, runs: roomTask?.runs ?? 0 };
    f.roomDispatchOk = roomMsgs.length === 1 && roomTask != null && roomTask.runs >= 1;
    // ③ 打开该线程卡 → 锚块+回复 → 发跟进（不另建根任务）
    const tasksBefore = dbQuery('SELECT count(*) c FROM tasks')[0].c;
    await cdp.eval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes(${JSON.stringify(marker)})); card?.click(); return true; })()`));
    await waitFor(cdp, `(() => { const els = [...document.querySelectorAll('#hifi-root .panel, #hifi-root div')]; return els.some((e) => (e.textContent || '').startsWith('原消息') && (e.textContent || '').includes(${JSON.stringify(marker)})); })()`, 15_000, '线程锚块');
    f.threadAnchor = true;
    await typeInto(cdp, `R52线程跟进run${n}`);
    await clickBtn(cdp, `/发送|保存记录/.test(b.textContent) && b.textContent.length <= 6`, '线程跟进发送');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(`R52线程跟进run${n}`)}))`, 25_000, '跟进上屏');
    await sleep(1500);
    const followRow = dbQuery(`SELECT thread_id FROM messages WHERE body_json LIKE ?`, `%R52线程跟进run${n}%`)[0] ?? null;
    const tasksAfter = dbQuery('SELECT count(*) c FROM tasks')[0].c;
    f.threadFollowUp = { inThread: followRow?.thread_id === roomTask?.task_id ? false : followRow != null, sameThreadAsRoot: true, tasksDelta: tasksAfter - tasksBefore };
    // 跟进落在该线程（thread_id = 派发线程 id）：
    const thId = dbQuery(`SELECT id FROM conversation_threads WHERE anchor_message_id = ?`, roomMsgs[0].id)[0].id;
    f.threadFollowUp.inThread = followRow?.thread_id === thId;
    f.threadFollowUpOk = f.threadFollowUp.inThread === true && tasksAfter === tasksBefore;
    // ④ 附件：包内 md 样本 → ready → 随信封发送 → 消息挂附件 → 预览面板真内容
    const mdBytes = fs.readFileSync(path.join(copyDir, 'samples', 'preview-r52-样例.md'));
    await pickFile(cdp, 'preview-r52-样例.md', 'text/markdown', mdBytes);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('preview-r52-样例.md') && c.textContent.includes('v1'))`, 20_000, 'md ready');
    await typeInto(cdp, `R52附件消息run${n}`);
    await clickBtn(cdp, `/发送|保存记录/.test(b.textContent) && b.textContent.length <= 6`, '附件发送');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(`R52附件消息run${n}`)}))`, 25_000, '附件消息上屏');
    await sleep(1500);
    const attMsg = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%R52附件消息run${n}%`)[0];
    const attCount = attMsg != null ? dbQuery('SELECT count(*) c FROM message_attachments WHERE message_id = ?', attMsg.id)[0].c : 0;
    f.attachmentSend = { messageAttachmentLinks: attCount };
    // 预览：点该消息的附件芯片 → 面板 + 真文本（“H2 预览样例”）→ 关闭
    await cdp.eval(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .msg-attach')].find((b) => b.textContent.includes('preview-r52-样例.md')); chip?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('[data-zs-preview=hifi] pre')].some((p) => (p.textContent || '').includes('H2 预览样例'))`, 15_000, '共享预览真内容');
    f.previewText = true;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('关闭') && x.closest('[data-zs-preview=hifi]') != null); b?.click(); return true; })()`));
    f.attachmentSendOk = attCount === 1 && f.previewText === true;
    // ⑤ 图片能力门：包内 png → 发送 → 门条 → 仅发送文字 → 成功（imageAck 冻结进信封）
    const pngBytes = fs.readFileSync(path.join(copyDir, 'samples', 'preview-r52-样例.png'));
    await pickFile(cdp, 'preview-r52-样例.png', 'image/png', pngBytes);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('preview-r52-样例.png') && c.textContent.includes('v1'))`, 20_000, 'png ready');
    await typeInto(cdp, `R52图片门run${n}`);
    await clickBtn(cdp, `/发送|保存记录/.test(b.textContent) && b.textContent.length <= 6`, '图片发送');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((c) => c.textContent.includes('图片能力门'))`, 15_000, '图片能力门出现');
    f.imageGateShown = true;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .chip.record-chip button')].find((x) => x.textContent.includes('仅发送文字')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(`R52图片门run${n}`)}))`, 25_000, '图片消息上屏');
    await sleep(1500);
    const imgMsg = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%R52图片门run${n}%`)[0];
    const imgCount = imgMsg != null ? dbQuery("SELECT count(*) c FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id = ? AND a.kind = 'image_file'", imgMsg.id)[0].c : 0;
    f.imageGate = { messageImageLinks: imgCount };
    f.imageGateOk = imgCount === 1;
    // ⑥ 深链：#task= → /thread/:id?tab=task + 详情实际选中
    await cdp.eval(`location.hash = ${JSON.stringify('#task=' + roomTask.task_id)}; true`);
    const dlRoute = await waitFor(cdp, `location.hash.startsWith('#/thread/') && location.hash.includes('tab=task')`, 15_000, '深链路由').catch(async () => {
      const ctx = await cdp.tryEval(probe(`JSON.stringify({ hash: location.hash, toast: document.querySelector('.toast')?.textContent ?? null, text: document.body.innerText.slice(0, 200) })`)).catch(() => null);
      throw new Error('深链路由：' + String(ctx));
    });
    await waitFor(cdp, `(() => { const tabs = [...document.querySelectorAll('#hifi-root .thread-nav button[role=tab]')]; const d = tabs.find((b) => b.textContent.includes('详情')); return d != null && d.getAttribute('aria-selected') === 'true'; })()`, 15_000, '详情实际选中');
    f.deepLinkDetail = true;
    // ⑦ 正式停机：window.close → shutdown + PID 归零 + launcher 退出
    const beforeQ = procsOfCopy();
    f.procsBeforeCloseQuery = { ok: beforeQ.ok, count: (beforeQ.procs ?? []).length, error: beforeQ.error ?? null };
    const capturedPids = (beforeQ.procs ?? []).map((x) => x.pid);
    f.procsBeforeCloseConfirmed = beforeQ.ok === true && capturedPids.length >= 1;
    await cdp.eval('window.close(); true');
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
      && f.roomDispatchOk === true && f.lostAckBanner === true && f.threadAnchor === true && f.threadFollowUpOk === true
      && f.attachmentSendOk === true && f.imageGateShown === true && f.imageGateOk === true && f.deepLinkDetail === true
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
  if (!fs.existsSync(path.join(srcPkg, 'start-server.bat'))) { console.error('[r52] 源包缺失'); process.exit(1); }
  const existing = procsOfCopy();
  if (!existing.ok) { console.error(`[r52] 副本进程查询未确认（${existing.error}）`); process.exit(1); }
  if ((existing.procs ?? []).length > 0) { console.error(`[r52] 副本路径仍有 ${existing.procs.length} 个进程`); process.exit(1); }
  fs.rmSync(copyRoot, { recursive: true, force: true });
  fs.mkdirSync(copyRoot, { recursive: true });
  console.log('[r52] 拷贝独立测试副本（交付包不动）…');
  fs.cpSync(srcPkg, copyDir, { recursive: true });
  fs.rmSync(path.join(copyDir, 'server-data'), { recursive: true, force: true });
  const runs = [];
  for (let n = 1; n <= (process.env.R52_RUNS ? Number(process.env.R52_RUNS) : 2); n += 1) {
    const f = await runOnce(n);
    fs.writeFileSync(path.join(outDir, `${f.runId}.json`), JSON.stringify(f, null, 2));
    console.log(`[r52] run${n} pass=${f.pass} ${f.failedAt ?? ''} realCalls=${f.realCalls} shutdown=${f.shutdownOk} residual=${f.residualZero}`);
    runs.push(f);
    await sleep(2000);
  }
  const all = runs.every((r) => r.pass === true);
  fs.writeFileSync(path.join(outDir, `${runId}-summary.json`), JSON.stringify({ allPass: all, runId, srcPkg, copyDir, runs: runs.map((r) => ({ run: r.run, pass: r.pass, failedAt: r.failedAt ?? null, buildId: r.identityBefore?.buildId, realCalls: r.realCalls, batExitCode: r.batExit?.code ?? null, attachmentLinks: r.attachmentSend?.messageAttachmentLinks ?? null, imageLinks: r.imageGate?.messageImageLinks ?? null })) }, null, 2));
  console.log('[r52] allPass=' + all + ' runId=' + runId);
  process.exit(all ? 0 : 4);
})();
