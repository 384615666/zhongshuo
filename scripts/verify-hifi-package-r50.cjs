'use strict';
/**
 * R50 H1 严格三连验证器（review-r49 §2–§4）——在**独立测试副本**上运行，不动用户交付包。
 *
 * 与 r49 版差异：
 * - 独立副本（copyDir）+独立数据根；**禁全机 taskkill、禁清交付包 server-data**——只按
 *   副本路径身份（CommandLine 含 copyDir）收拢进程。
 * - 每轮记录实际 launchDir（junction 成败如实留档+realpath 解析）+ BUILD buildId + 清单
 *   文件 SHA-256（运行前后各一次，须一致——同产物声明落到事实）。
 * - 假阳性清除：bannerAfterRetry 恒真删除；重试成功=（库中该批消息恰 1 条）+（无失败行内
 *   错误）+（banner 消失或排队顶上）；房间**指定成员**派发核 task/run/turn 身份；DM **新建
 *   空闲会话**核本轮 commandId→message→task→run→turn→agent 回复（UI+只读库双面核对）；
 *   仅记录核该消息 task_id NULL+本轮零新增 run/outbox。
 * - 停机：window.close()（用户同型）→ 副本 server-data/desktop-shutdown.json 存在且
 *   forced=false → 副本路径进程树归零（CIM 按路径匹配）→ bat 退出码留档。
 * - 负对照（--negative 或首轮自动）：注入必败断言证明验收可真失败。
 * 运行：node scripts/verify-hifi-package-r50.cjs [--src 交付包目录]；产物 dist/desktop/hifi-h1-verify-r50/。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const repo = path.resolve(__dirname, '..');
const srcPkg = process.argv.includes('--src') ? path.resolve(process.argv[process.argv.indexOf('--src') + 1]) : path.join(repo, 'dist', 'desktop', 'hifi-h1-win-v2');
const copyRoot = path.join(repo, 'dist', 'desktop', 'hifi-h1-verify-r50-copy');
const copyDir = path.join(copyRoot, 'h1 副本 run');
const outDir = path.join(repo, 'dist', 'desktop', 'hifi-h1-verify-r50');
fs.mkdirSync(outDir, { recursive: true });
const runId = `r50-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 只读库查询（better-sqlite3 readonly——不动业务数据）。 */
function dbQuery(sql, ...args) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(copyDir, 'server-data', 'state.sqlite'), { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

/** 副本路径身份的进程清单（CIM CommandLine LIKE——不按映像名全机杀）。 */
/**
 * 副本路径身份的进程清单（review-r50 §2 修1）：
 * - PowerShell -like 的反斜杠不是转义符——旧实现把路径反斜杠加倍导致匹配不到。现在按真实
 *   路径原样匹配（仅转义通配符，中文/空格无碍）。
 * - 查询失败（非零退出/带 stderr/JSON 解析失败）= 未确认 {ok:false}，不冒充空列表。
 */
function procsOfCopy() {
  const like = copyDir.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
  // 纯文本行输出（pid name）——不复用 ConvertTo-Json（预检曾在后台环境触发其位置参数绑定
  // 错误）；单次失败重试一次，仍败=未确认（不冒充空列表）。
  const run = () => spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe') } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
    ], { encoding: 'utf8', timeout: 30_000 });
  let r = run();
  if (r.status !== 0 || String(r.stderr ?? '').trim().length > 0) r = run();
  const stderr = String(r.stderr ?? '').trim();
  if (r.status !== 0 || stderr.length > 0) {
    return { ok: false, procs: null, error: `status=${r.status} stderr=${stderr.slice(0, 120)}` };
  }
  const procs = String(r.stdout ?? '').split(new RegExp('[' + String.fromCharCode(13) + String.fromCharCode(10) + ']+')).map((l) => l.trim()).filter((l) => l.length > 0)
    .map((l) => { const sp = l.indexOf(' '); return { pid: Number(l.slice(0, sp)), name: l.slice(sp + 1) }; })
    .filter((x) => Number.isFinite(x.pid));
  return { ok: true, procs, error: null };
}

/** 已捕获 PID 是否全部退出（查询失败=未确认）。 */
function pidsGone(pids) {
  if (pids.length === 0) return { ok: true, gone: true, alive: [] };
  const run = () => spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { @(${pids.join(',')}) -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`,
    ], { encoding: 'utf8', timeout: 30_000 });
  let r = run();
  if (r.status !== 0 || String(r.stderr ?? '').trim().length > 0) r = run();
  const stderr = String(r.stderr ?? '').trim();
  if (r.status !== 0 || stderr.length > 0) return { ok: false, gone: false, alive: null, error: `status=${r.status} stderr=${stderr.slice(0, 120)}` };
  const alive = String(r.stdout ?? '').split(new RegExp('[' + String.fromCharCode(13) + String.fromCharCode(10) + ']+')).map((l) => l.trim()).filter((l) => l.length > 0)
    .map((l) => { const sp = l.indexOf(' '); return { pid: Number(l.slice(0, sp)), name: l.slice(sp + 1) }; });
  return { ok: true, gone: alive.length === 0, alive };
}
const procsOkZero = (q) => q != null && q.ok === true && (q.procs ?? []).length === 0;

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 160)); return r.result.value; }
}
async function connectPage(port, label) {
  const deadline = Date.now() + 120_000;
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
    const v = await cdp.eval(probe(expr)).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(900);
  }
}
async function typeInto(cdp, text) {
  await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  await sleep(180);
}
async function clickSend(cdp) {
  await cdp.eval(probe(`(() => { const send = [...document.querySelectorAll('#hifi-root button')].find((b) => /发送|保存记录/.test(b.textContent) && b.textContent.length <= 6); send?.click(); return true; })()`));
}
function manifestIdentity() {
  const m = path.join(copyDir, 'ZhongshuoDual', 'MANIFEST-SHA256.json');
  const b = path.join(copyDir, 'ZhongshuoDual', 'BUILD.json');
  return { buildId: JSON.parse(fs.readFileSync(b, 'utf8')).buildId, manifestSha: sha256File(m), buildSha: sha256File(b) };
}

/** junction（中文+空格路径）——成败如实返回。 */
function makeJunction() {
  const j = path.join(copyRoot, 'H1 验证 副本');
  try { fs.rmSync(j, { recursive: true, force: true }); } catch { /* 不存在 */ }
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', j, copyDir], { encoding: 'utf8' });
  if (r.status === 0 && fs.existsSync(j)) return { ok: true, dir: j, error: null, resolved: fs.realpathSync(j) };
  return { ok: false, dir: copyDir, error: `${r.status}: ${String(r.stderr).trim()} ${String(r.stdout).trim()}`.slice(0, 200), resolved: copyDir };
}

async function runOnce(n) {
  const port = 9480 + n;
  const junction = n === 1 ? makeJunction() : { ok: false, dir: copyDir, error: 'not-attempted (run1 only)', resolved: copyDir };
  const launchDir = junction.dir;
  const identityBefore = manifestIdentity();
  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(port), ZS_H1_LOSE_SUBMIT_ONCE: '1' };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME;
  const child = spawn('cmd', ['/c', 'start-server.bat'], { cwd: launchDir, env });
  let out = '';
  // review-r50 §2 修2：launcher 退出从启动时订阅（此前只在关窗后等 8s——三连均 still-running）。
  // pause 输入妥善给：种子输出后周期补 newline（种子子进程可能吃掉首个）；launcher 属本轮
  // 测试生命周期，退出以实际 exitCode 记录，不再把 still-running 混进通过口径。
  const batExitPromise = new Promise((res) => { child.on('exit', (code) => res({ code })); });
  const pauseFeeder = setInterval(() => {
    if (out.includes('Seeded.')) { try { child.stdin.write(String.fromCharCode(10)); } catch { /* 已退出 */ } }
  }, 2000);
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const launcherPid = child.pid;
  let cdp = null;
  const f = { run: n, runId: `${runId}-run${n}`, launchDir, junctionAttempted: n === 1, junctionOk: junction.ok, junctionError: junction.error, launchResolved: junction.resolved, port, identityBefore, seeded: false, launcherPid, launcherLifecycle: 'test-owned' };
  try {
    cdp = await connectPage(port, `run${n}`);
    // ① 首启自动项目+侧栏（run2/3：重启历史可见）
    await waitFor(cdp, `document.body.classList.contains('hifi-on') && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 110_000, '首启自动进入项目');
    f.autoProject = true;
    if (n === 1) {
      // 负对照实测（修3）：同一 waitFor 对不可能条件（2s 预算）——必须抛超时；记录轮次/时长。
      const negT0 = Date.now();
      let negPolls = 0;
      let negErr = null;
      try {
        for (;;) {
          negPolls += 1;
          const v = await cdp.eval(probe(`document.title === ${JSON.stringify('never-' + runId)}`)).catch(() => null);
          if (v) break;
          if (Date.now() - negT0 > 2000) throw new Error('等待超时：负对照（不可能条件）');
          await sleep(400);
        }
      } catch (e) { negErr = String(e.message ?? e); }
      f.negativeControl = { executed: true, instrument: 'waitFor(same-channel)', budgetMs: 2000, polls: negPolls, waitedMs: Date.now() - negT0, timedOut: negErr != null && negErr.includes('等待超时'), observed: negErr != null ? 'fail' : 'unexpected-pass', error: negErr };
    }
    if (n > 1) {
      // review-r50 §2 修4：重启历史不白给——上一轮唯一标记消息按持久身份（messageId+taskId
      // 沿 conversation_threads）核对，且该消息在房间主池 UI 可见（元素 id=msg-<id>）。
      const priorMarker = `R50房间派发run${n - 1}`;
      const priorMsg = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%${priorMarker}%`)[0] ?? null;
      const priorTask = priorMsg != null ? dbQuery(`SELECT t.id task_id FROM conversation_threads th JOIN tasks t ON t.id = th.root_task_id WHERE th.anchor_message_id = ?`, priorMsg.id)[0] ?? null : null;
      await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
      // 主池 DOM 身份说明：H1/H2 主池条目按线程卡渲染（id=root-<threadId> 或卡容器），不落
      // 真实 messageId——UI 可见性按标记正文核对；持久身份（messageId+taskId）以库面为准。
      const priorUi = priorMsg != null ? await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg, #hifi-root .root-card')].some((m) => m.textContent.includes(${JSON.stringify(priorMarker)}))`, 30_000, `重启历史：上一轮标记上屏`).catch(() => false) : false;
      f.priorRunHistory = { priorRun: n - 1, marker: priorMarker, messageId: priorMsg?.id ?? null, taskId: priorTask?.task_id ?? null, uiVisible: priorUi === true };
      f.priorRunHistoryOk = priorMsg != null && priorTask != null && priorUi === true;
    }
    // ② 房间指定成员派发（@ Guide A）——本轮唯一标记
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('PPT 预览样本'))`, 150_000, '房间主池样本（种子宽窗）');
    f.poolSample = true;
    const marker = `R50房间派发run${n}`;
    await cdp.eval(probe(`(() => { const atBtn = [...document.querySelectorAll('#hifi-root button')].find((b) => (b.title || '').includes('提及成员')); atBtn?.click(); return true; })()`));
    await sleep(400);
    await cdp.eval(probe(`(() => { const item = [...document.querySelectorAll('#hifi-root .mention-pop .menu-item')].find((b) => b.textContent.includes('Guide A')); item?.click(); return true; })()`));
    await sleep(250);
    await typeInto(cdp, marker);
    await clickSend(cdp);
    // lose-once：首次回执被丢→unknown banner（同键锁保持到回执/20s 超时）——先完成重发闭环再继续。
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((e) => e.textContent.includes('结果未知'))`, 35_000, '房间派发：受控丢回执→unknown banner');
    f.roomLostAckBanner = true;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .chip.record-chip button')].find((x) => x.textContent.includes('重发原内容')); b?.click(); return true; })()`));
    await sleep(2500);
    f.roomRetryNoFailure = await cdp.eval(probe(`![...document.querySelectorAll('#hifi-root .composer-draft.failed')].some((e) => e.textContent.includes('重发失败') || e.textContent.includes('发送失败'))`)) === true;
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(marker)}))`, 30_000, '房间派发消息上屏（重发后）');
    // 库面（只读）：消息恰 1 条；任务经 conversation_threads（anchor→root_task_id——房间根消息
    // messages.task_id 不落任务号）；该任务本轮 run/turn；mentions 按存在性核。
    await sleep(6000);
    const roomMsgs = dbQuery(`SELECT id FROM messages WHERE body_json LIKE ?`, `%${marker}%`);
    const roomMsg = roomMsgs[0] ?? null;
    const roomTask = roomMsg != null ? dbQuery(`SELECT t.id task_id, (SELECT count(*) FROM workflow_runs r WHERE r.task_id = t.id) runs, (SELECT count(*) FROM agent_turns a WHERE a.run_id IN (SELECT id FROM workflow_runs WHERE task_id = t.id)) turns FROM conversation_threads th JOIN tasks t ON t.id = th.root_task_id WHERE th.anchor_message_id = ?`, roomMsg.id)[0] ?? null : null;
    const roomMentions = roomMsg != null ? dbQuery(`SELECT json_extract(body_json, '$.mentions') mentions FROM messages WHERE id = ?`, roomMsg.id)[0] ?? null : null;
    f.roomDispatch = { messageId: roomMsg?.id ?? null, exactlyOnce: roomMsgs.length === 1, taskId: roomTask?.task_id ?? null, runs: roomTask?.runs ?? 0, turns: roomTask?.turns ?? 0, mentions: roomMentions?.mentions ?? null };
    f.roomDispatchOk = roomMsgs.length === 1 && roomTask != null && (f.roomDispatch.mentions ?? '').includes('memberId') && roomTask.runs >= 1;
    // ③ 仅记录：该消息零任务/零新 run
    const runsBefore = dbQuery('SELECT count(*) c FROM workflow_runs')[0].c;
    const outboxBefore = dbQuery('SELECT count(*) c FROM outbox')[0].c;
    const recMarker = `R50仅记录run${n}`;
    await cdp.eval(probe(`(() => { const more = [...document.querySelectorAll('#hifi-root button')].find((b) => b.getAttribute('aria-label') === '本次运行设置'); more?.click(); return true; })()`));
    await sleep(350);
    await cdp.eval(probe(`(() => { const item = [...document.querySelectorAll('#hifi-root .menu-item')].find((b) => b.textContent.includes('仅记录')); item?.click(); return true; })()`));
    await sleep(250);
    await typeInto(cdp, recMarker);
    await clickSend(cdp);
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(recMarker)}))`, 20_000, '仅记录消息上屏');
    await sleep(800);
    const recMsg = dbQuery(`SELECT id, task_id FROM messages WHERE body_json LIKE ?`, `%${recMarker}%`)[0];
    // review-r50 §2 修5：零任务按 conversation_threads.root_task_id（房间根消息 task_id 本就可
    // NULL）；零 run 不足以排除待执行——outbox 前后差一并核。
    const recThread = recMsg != null ? dbQuery(`SELECT id thread_id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?`, recMsg.id)[0] ?? null : null;
    const runsAfter = dbQuery('SELECT count(*) c FROM workflow_runs')[0].c;
    const outboxAfter = dbQuery('SELECT count(*) c FROM outbox')[0].c;
    f.recordOnly = { messageId: recMsg?.id, taskId: recMsg?.task_id ?? null, threadId: recThread?.thread_id ?? null, threadRootTaskId: recThread == null ? 'no-thread' : recThread.root_task_id, runsDelta: runsAfter - runsBefore, outboxDelta: outboxAfter - outboxBefore };
    f.recordOnlyOk = recMsg != null && recThread != null && recThread.root_task_id == null && runsAfter === runsBefore && outboxAfter === outboxBefore;
    // ④ DM：新建空闲会话（+ Guide B）→ 受控丢回执→重发原信封→恰一条→本轮回复（任务/回合身份）
    await cdp.eval(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.trim() === '私信')?.click(); return true; })()`));
    await sleep(600);
    const newDmLabel = await cdp.eval(probe(`(() => { const btn = [...document.querySelectorAll('#hifi-root .btn')].find((b) => b.textContent.includes('+ Guide B')); btn?.click(); return true; })()`));
    await waitFor(cdp, `location.hash.startsWith('#/dm/dm_')`, 15_000, '新建空闲 DM 会话');
    const dmConvId = (await cdp.eval(probe(`location.hash`))).replace('#/dm/', '');
    f.dmNewConversation = dmConvId;
    const dmMarker = `R50私信链路run${n}`;
    await typeInto(cdp, dmMarker);
    await clickSend(cdp);
    // lose-once 已由房间步消费——DM 为正常发送：等消息可见+无失败行内+库中恰 1 条。
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes(${JSON.stringify(dmMarker)}))`, 25_000, '私信消息上屏');
    f.dmSentVisible = true;
    await sleep(1500);
    f.retryNoFailureInline = await cdp.eval(probe(`![...document.querySelectorAll('#hifi-root .composer-draft.failed')].some((e) => e.textContent.includes('重发失败') || e.textContent.includes('发送失败'))`)) === true;
    const dmRows = dbQuery(`SELECT id, task_id, conversation_id FROM messages WHERE conversation_id = ? AND body_json LIKE ?`, dmConvId, `%${dmMarker}%`);
    f.retryExactlyOnce = dmRows.length === 1;
    f.dmSentMessage = dmRows[0]?.id ?? null;
    f.lostAckBanner = f.roomLostAckBanner === true; // 丢回执→重试闭环在房间步验证
    // 本轮成员回复：该任务本轮 run/turn 产生的 agent 消息（不匹配任何旧「完成」文本）
    let reply = null;
    for (let i = 0; i < 40 && reply == null; i += 1) {
      await sleep(2000);
      reply = dbQuery(`SELECT m.id msg_id, m.task_id, r.id run_id, t.id turn_id, m.created_at FROM messages m JOIN workflow_runs r ON r.task_id = m.task_id JOIN agent_turns t ON t.run_id = r.id WHERE m.conversation_id = ? AND m.author_type = 'agent' AND m.created_at > (SELECT created_at FROM messages WHERE id = ?) LIMIT 1`, dmConvId, f.dmSentMessage)[0] ?? null;
    }
    f.dmReply = reply != null ? { messageId: reply.msg_id, taskId: reply.task_id, runId: reply.run_id, turnId: reply.turn_id } : null;
    // review-r50 §2 修5：按 reply.messageId 精确核 UI 可见（MessageView DOM id=msg-<id>），不只数 DOM。
    f.dmReplyOnUi = false;
    if (reply != null) {
      f.dmReplyOnUi = await waitFor(cdp, `document.getElementById('msg-' + ${JSON.stringify(reply.msg_id)}) != null`, 30_000, `DM 视图含本轮回复 ${reply.msg_id}`).catch(() => false);
    }
    // ⑤ 定向接管（按会话 ID）+返回
    await cdp.eval(probe(`(() => { [...document.querySelectorAll('#hifi-root button')].find((b) => (b.title || '').includes('原界面打开'))?.click(); return true; })()`));
    await waitFor(cdp, `document.body.classList.contains('legacy-on') && window.__zsLegacyStarted === true`, 25_000, '接管切换');
    await waitFor(cdp, `(location.hash || '').startsWith('#dm=')`, 25_000, 'legacy 定位会话');
    const legacyHash = await cdp.eval(probe(`location.hash`));
    f.takeoverById = legacyHash.replace('#dm=', '') === dmConvId;
    await cdp.eval(probe(`document.querySelector('.zs-legacy-exit')?.click(), true`));
    await waitFor(cdp, `!document.body.classList.contains('legacy-on') && getComputedStyle(document.getElementById('hifi-root')).display !== 'none'`, 15_000, '返回新界面');
    f.takeoverReturn = true;
    // ⑥ 正式关窗（用户同型 window.close）→ shutdown 记录 + 副本进程树归零
    // review-r50 §2 修1：关窗前必须**实际查到**副本进程（含本轮 exe/daemon/parse 子树）并按
    // PID 身份捕获——此前活窗口时 procsBeforeClose=0（加倍反斜杠查不到）使"归零"无从谈起。
    const beforeQ = procsOfCopy();
    f.procsBeforeCloseQuery = { ok: beforeQ.ok, count: (beforeQ.procs ?? []).length, error: beforeQ.error ?? null, procs: beforeQ.procs };
    const capturedPids = (beforeQ.procs ?? []).map((x) => x.pid);
    f.procsBeforeCloseConfirmed = beforeQ.ok === true && capturedPids.length >= 1; // 活实例对照必须先查到
    await cdp.eval('window.close(); true');
    let exited = false;
    let exitUnconfirmed = 0;
    for (let i = 0; i < 45; i += 1) {
      await sleep(1000);
      const q = procsOfCopy();
      if (!q.ok) { exitUnconfirmed += 1; continue; } // 查询失败=未确认，不当 0
      if (q.procs.length === 0) { exited = true; break; }
    }
    f.gracefulExitByProcTree = exited;
    f.exitQueryUnconfirmed = exitUnconfirmed;
    // 已捕获 PID 逐一核对退出（PID 身份——副本残留的最小集合证明）。
    const gone = pidsGone(capturedPids);
    f.capturedPidsGone = gone.ok === true && gone.gone === true ? true : { ok: gone.ok, alive: gone.alive ?? null, error: gone.error ?? null };
    await sleep(1500);
    const shutdownPath = path.join(copyDir, 'server-data', 'desktop-shutdown.json');
    let shutdown = null;
    try { shutdown = JSON.parse(fs.readFileSync(shutdownPath, 'utf8')); } catch { shutdown = null; }
    // 取本轮最后一次记录（文件可为多条 append？——按数组/对象两态兼容，取最后一项）
    const lastShutdown = Array.isArray(shutdown) ? shutdown[shutdown.length - 1] : shutdown;
    f.shutdownRecord = lastShutdown;
    f.shutdownOk = lastShutdown != null && lastShutdown.forced !== true && (lastShutdown.reason != null || lastShutdown.requestDelivered != null || lastShutdown.exitCode != null);
    const residualQ = procsOfCopy();
    f.residualQuery = { ok: residualQ.ok, error: residualQ.error ?? null };
    f.residualProcs = residualQ.procs ?? null;
    f.residualZero = procsOkZero(residualQ); // 确认为零才算（未确认≠零）
    clearInterval(pauseFeeder);
    try { child.stdin.write(String.fromCharCode(10)); } catch { /* 已退出 */ }
    f.batExit = await Promise.race([batExitPromise, sleep(15_000).then(() => ({ code: 'still-running' }))]);
    f.seeded = out.includes('Seeded.');
    f.identityAfter = manifestIdentity();
    f.identitySameApp = f.identityBefore.buildId === f.identityAfter.buildId && f.identityBefore.manifestSha === f.identityAfter.manifestSha && f.identityBefore.buildSha === f.identityAfter.buildSha;
    f.realCalls = (() => { try { return dbQuery('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } })();
    f.consoleTail = out.slice(-300);
    f.pass = f.autoProject === true && f.poolSample === true && f.roomDispatchOk === true && f.recordOnlyOk === true
      && f.roomLostAckBanner === true && f.roomRetryNoFailure === true
      && f.lostAckBanner === true && f.retryNoFailureInline === true && f.retryExactlyOnce === true
      && f.dmReply != null && f.dmReplyOnUi === true && f.takeoverById === true && f.takeoverReturn === true
      && (n === 1 || f.priorRunHistoryOk === true) // run2/3：重启历史按上一轮身份核对（修4）
      && f.procsBeforeCloseConfirmed === true && f.capturedPidsGone === true // 修1：先查到再归零
      && f.gracefulExitByProcTree === true && f.shutdownOk === true && f.residualZero === true
      && typeof f.batExit?.code === 'number' // 修2：launcher 属测试生命周期，须实际退出
      && f.identitySameApp === true && f.realCalls === 0;
    return f;
  } catch (e) {
    f.failedAt = e.message;
    f.error = String(e.message ?? e);
    f.consoleTail = out.slice(-500);
  } finally {
    // 失败路径也收拢副本进程（用户同型关窗优先；有界等待；仅副本路径身份——不杀全机）。
    try { if (cdp != null && !cdp.closed) await cdp.eval('window.close(); true').catch(() => {}); } catch { /* 已关 */ }
    clearInterval(pauseFeeder);
    for (let i = 0; i < 30 && !procsOkZero(procsOfCopy()); i += 1) await sleep(1000);
    const cleanupQ = procsOfCopy();
    f.cleanupProcsLeft = cleanupQ.ok ? (cleanupQ.procs ?? []).length : 'unconfirmed';
    f.cleanupQuery = { ok: cleanupQ.ok, error: cleanupQ.error ?? null };
  }
  return f;
}

(async () => {
  if (!fs.existsSync(path.join(srcPkg, 'start-server.bat'))) { console.error('[r50] 源包缺失'); process.exit(1); }
  // 独立副本（一次性；run1 清副本内 server-data=真首启；不动交付包）
  const existing = procsOfCopy();
  if (!existing.ok) { console.error(`[r50] 副本进程查询未确认（${existing.error}）——先解决查询再跑`); process.exit(1); }
  if ((existing.procs ?? []).length > 0) { console.error(`[r50] 副本路径仍有 ${existing.procs.length} 个进程——先人工收拢`); process.exit(1); }
  fs.rmSync(copyRoot, { recursive: true, force: true });
  fs.mkdirSync(copyRoot, { recursive: true });
  console.log('[r50] 拷贝独立测试副本（交付包不动）…');
  fs.cpSync(srcPkg, copyDir, { recursive: true });
  fs.rmSync(path.join(copyDir, 'server-data'), { recursive: true, force: true });
  const runs = [];
  for (let n = 1; n <= 3; n += 1) {
    if (n === 1) { /* 副本已清=run1 真首启 */ } else { /* run2/3 保留副本数据=重启历史 */ }
    const f = await runOnce(n);
    fs.writeFileSync(path.join(outDir, `${f.runId}.json`), JSON.stringify(f, null, 2));
    console.log(`[r50] run${n} pass=${f.pass} ${f.failedAt ?? ''} realCalls=${f.realCalls} shutdown=${f.shutdownOk} residual=${f.residualZero}`);
    runs.push(f);
    await sleep(2000);
  }
  // 负对照（review-r50 §2 修3）：**实际跑**同一 waitFor 断言函数于不可能条件——捕获预期
  // 超时与时长/次数，不以结构等价推断冒充实跑（run1 已在页面内执行，结果随 f.negativeControl）。
  const neg = runs[0]?.negativeControl ?? null;
  fs.writeFileSync(path.join(outDir, `${runId}-negative-control.json`), JSON.stringify(neg != null ? neg : { executed: false, expected: 'fail', note: 'run1 未取得负对照（失败）——本文件如实记录' }, null, 2));
  if (neg == null || neg.timedOut !== true) { console.error('[r50] 负对照未按预期失败——验证器敏感性存疑'); process.exit(5); }
  const all = runs.every((r) => r.pass === true);
  fs.writeFileSync(path.join(outDir, `${runId}-summary.json`), JSON.stringify({ allPass: all, runId, srcPkg, copyDir, runs: runs.map((r) => ({ run: r.run, pass: r.pass, failedAt: r.failedAt ?? null, junctionOk: r.junctionOk, buildId: r.identityBefore?.buildId, realCalls: r.realCalls, batExitCode: r.batExit?.code ?? null, procsBeforeCloseConfirmed: r.procsBeforeCloseConfirmed ?? null, priorRunHistoryOk: r.priorRunHistoryOk ?? null })) }, null, 2));
  console.log('[r50] allPass=' + all + ' runId=' + runId);
  process.exit(all ? 0 : 4);
})();
