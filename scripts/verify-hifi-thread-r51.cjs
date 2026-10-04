'use strict';
/**
 * 第五十一轮 H2 回复串真实页面链证据（review-r50 §4）：**实际 dist/ui React 页面 × 正式
 * daemon 命令面（esbuild 打包真源）× 内存 fake 库/worker**——不是传输桩，也不是盘点文档。
 *
 * 覆盖（页面→正式链全程 UI 驱动）：
 *  T1 主池线程卡（H2 卡片形态：任务号/状态/回复数；记录串「记录 · 无任务号」）。
 *  T2 卡片→/thread/:id → thread.get 锚块+回复可见 → UI 发送线程跟进 → 回复上屏+落库；
 *     root_task_id 不变（不另建根任务）。
 *  T3 记录串默认「仅记录」chip → 发送零任务/零 run。
 *  T4 详情 tab：任务概况+待验收交付（三重身份）→ 验收通过 → 任务 DONE。
 *  T5 线程独立水位门：贴底时 thread.markRead 发出（DB 水位推进）。
 *  T6 附件真实上传（页面 File 注入 → attachment.uploadText → ready 芯片 → 随信封发送 →
 *     消息挂附件芯片可见）。
 *  T7 深链规范化：#task=<id> → deepLink.resolve（真实命令）→ /thread/:id?tab=task。
 *  截图：回复视图+详情视图（同窗证据，存 dist/desktop/review-r51/）。
 * 运行：./node_modules/.bin/electron scripts/verify-hifi-thread-r51.cjs
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'dist/desktop/review-r51');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 48231;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = req.url.split('?')[0].replace(/^\/+/, '') || 'index.html';
  const file = path.join(root, 'dist/ui/renderer', rel.replace(/\.\./g, ''));
  if (!file.startsWith(path.join(root, 'dist/ui/renderer')) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

/** 正式 daemon 面（esbuild 真源打包：openDatabase+dispatchDaemonCommand+DispatchWorker+fake）。
 * 入口同时暴露夹具 SQL（成员/房间/交付），供预置派发后状态——不绕过命令面发消息。 */
async function buildDaemon() {
  const entry = path.join(OUT, 'daemon-entry.ts');
  const q = JSON.stringify;
  fs.writeFileSync(entry, `import { openDatabase } from ${q(path.join(root, 'src/persistence/db.ts'))};
import { dispatchDaemonCommand } from ${q(path.join(root, 'src/daemon/commands.ts'))};
import { DispatchWorker } from ${q(path.join(root, 'src/daemon/dispatchWorker.ts'))};
import { FakeRuntimeAdapter } from ${q(path.join(root, 'src/adapter/fake/runtimeAdapter.ts'))};
import type { FakeTurnScript } from ${q(path.join(root, 'src/adapter/fake/script.ts'))};
import { TASK_COMPLETE_SCHEMA_VERSION } from ${q(path.join(root, 'src/contracts/prompts.ts'))};
import { randomUUID } from 'node:crypto';
const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: 'm_' + randomUUID().slice(0, 8), text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];
export function makeDaemon(appDataDir: string) {
  const db = openDatabase(':memory:');
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir };
  const command = (env: { commandId: string; method: string; params: unknown }) => dispatchDaemonCommand(deps as never, { protocolVersion: 1, commandId: env.commandId, method: env.params === undefined ? env.method : env.method, params: env.params } as never);
  return { db, command, async pump() { await new DispatchWorker({ db, adapter, leaseOwner: 'w-r51', appDataDir } as never).runOnce(); }, async close() { await adapter.closeAllSessions().catch(() => {}); db.close(); } };
}
`, 'utf8');
  const bundle = path.join(OUT, 'real-daemon.cjs');
  await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, sourcemap: false, external: ['better-sqlite3'], loader: { '.ts': 'ts' } });
  const m = require(bundle);
  return m.makeDaemon(OUT);
}

async function waitForJs(win, iife, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await win.webContents.executeJavaScript(iife, true).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) { throw new Error('等待超时：' + label); }
    await sleep(180);
  }
}
async function typeInto(win, text) {
  await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
  await sleep(160);
}
async function clickBtn(win, matcher, label) {
  const ok = await win.webContents.executeJavaScript(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((b) => ${matcher}); if (b == null) return false; b.click(); return true; })()`), true);
  if (ok !== true) throw new Error('按钮未找到：' + label);
}

/** 隐藏窗口的 capturePage 返回**首帧**（从未显示的窗口合成器不重绘——实测 DM 空态首屏）。
 * 改走 CDP Page.captureScreenshot：抓当前提交帧，不要求窗口可见。 */
async function captureShot(win, name) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  const r = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  try { dbg.detach(); } catch { /* 已分离 */ }
}

async function main() {
  const daemon = await buildDaemon();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  // ── 夹具：项目/成员/房间/会话（正式 schema 造数——镜像 hifiFirstPackage/hifiThreadRound51） ──
  const projDir = path.join(OUT, 'proj');
  fs.mkdirSync(path.join(projDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# R51 线程页面链样本\n', 'utf8');
  // 先记忆项目路径（真实首启路径：bootRemembered 读 app.settings.get ui.autoOpenProjectPath）。
  await daemon.command({ commandId: 'cmd-set-remember', method: 'app.settings.set', params: { key: 'ui.autoOpenProjectPath', value: projDir } });
  await daemon.command({ commandId: 'cmd-open-r51', method: 'project.open', params: { path: projDir } });
  const db = daemon.db;
  const projId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?, 'Guide A','agent',1), ('mB',?, 'Guide B','agent',1)").run(projId, projId);
  db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '默认房间', 'mA')").run(projId);
  db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA'), ('roomA','mB')").run();
  db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
  const mkcmd = () => 'c-' + Math.random().toString(36).slice(2, 10);

  const results = { scope: 'H2 回复串真实页面链（实际 React 页面 × 正式 daemon × fake worker）' };
  const { BrowserWindow, ipcMain } = require('electron');
  const sentLog = [];
  ipcMain.handle('zs-command', async (_e, env) => {
    sentLog.push({ method: env.method, params: env.params, commandId: env.commandId });
    return daemon.command(env);
  });
  const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zs', {
  command: async (env) => ipcRenderer.invoke('zs-command', env),
  pickFolder: async () => null,
  openPath: async () => {},
  onDisconnect: () => {}, onReconnected: () => {}, onDemoStatus: () => {},
});`;
  const preloadPath = path.join(OUT, 'real-preload.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });

  try {
    // 房间根消息派发（@Guide A）→ pump → 线程出现（正式链造夹具，UI 从 room.pool 读）。
    const r1 = await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'R51 页面链根消息：请整理一份要点', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] } });
    if (r1.ok !== true) throw new Error('夹具派发失败：' + JSON.stringify(r1.error));
    await daemon.pump();
    const anchor = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%页面链根消息%'").get();
    const th = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor.id);
    results.fixture = { threadId: th.id, taskId: th.root_task_id };
    // 记录串夹具（record_only 根消息→无任务线程）。
    await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'R51 记录串根消息（无任务）', intent: 'record_only', mentions: [] } });
    const recAnchor = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%记录串根消息%'").get();
    const recTh = db.prepare('SELECT id FROM conversation_threads WHERE anchor_message_id = ?').get(recAnchor.id);

    await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    await waitForJs(win, `document.body.classList.contains('hifi-on') ? 'hifi' : null`, 15_000, 'hifi 壳挂载');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .side-item')].some((b) => b.textContent.includes('默认房间'))`), 15_000, '首启自动项目');

    // ── T1 主池线程卡（H2 卡片形态） ──
    await clickBtn(win, `b.textContent.includes('默认房间') && b.classList.contains('side-item')`, '默认房间');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('页面链根消息'))`), 15_000, '主池线程卡');
    const t1cards = await win.webContents.executeJavaScript(probe(`JSON.stringify([...document.querySelectorAll('#hifi-root .root-card')].map((c) => c.textContent.slice(0, 80)))`), true);
    results.T1_threadCards = { cards: JSON.parse(t1cards), hasTaskNo: JSON.parse(t1cards).some((t) => t.includes('#')), hasRecordTag: JSON.parse(t1cards).some((t) => t.includes('记录 · 无任务号')) };

    // ── T2 卡片→线程视图→UI 发送跟进→回复上屏+不另建根任务 ──
    await clickBtn(win, `b.textContent.includes('条回复') && b.closest('.root-card') != null && b.closest('.root-card').textContent.includes('页面链根消息')`, '打开任务线程卡（按卡正文定位）');
    await waitForJs(win, probe(`document.querySelector('#hifi-root') != null && [...document.querySelectorAll('#hifi-root .panel, #hifi-root div')].some((e) => (e.textContent || '').includes('R51 页面链根消息'))`), 15_000, '线程视图锚块');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].length >= 1`), 15_000, '线程回复（worker 已回）');
    await typeInto(win, 'R51 页面跟进：补充边界条件');
    await clickBtn(win, `/发送|保存记录/.test(b.textContent) && b.textContent.length <= 6`, '发送跟进');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('页面跟进：补充边界条件'))`), 20_000, '跟进消息上屏');
    const thAfter = db.prepare('SELECT root_task_id FROM conversation_threads WHERE id = ?').get(th.id);
    const taskCount = db.prepare('SELECT count(*) c FROM tasks').get().c;
    const replyRow = db.prepare("SELECT id, thread_id FROM messages WHERE body_json LIKE '%补充边界条件%'").get();
    results.T2_threadFollowUp = { replyInThread: replyRow?.thread_id === th.id, rootTaskUnchanged: thAfter.root_task_id === th.root_task_id, taskCount, tasksSnapshot: 1 }; // 仅派发根任务 1 条：线程跟进不另建、记录串零任务
    results.T2_domAtCapture = await win.webContents.executeJavaScript(probe(`(() => { const first = document.querySelector('#hifi-root .msg-list .panel'); return first ? first.textContent.slice(0, 60) : null; })()`), true);
    await captureShot(win, 'thread-replies.png');

    // ── T3 记录串：默认「仅记录」chip + 发送零任务 ──
    const runsBeforeRec = db.prepare('SELECT count(*) c FROM workflow_runs').get().c;
    await clickBtn(win, `b.textContent.includes('返回主池')`, '返回主池');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('记录串根消息'))`), 10_000, '主池记录串卡');
    await win.webContents.executeJavaScript(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('记录串根消息')); card?.click(); return true; })()`), true);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .chip')].some((c) => c.textContent.includes('仅记录'))`), 10_000, '记录串默认仅记录 chip');
    const recordDefault = true;
    await typeInto(win, 'R51 记录串里的追加（不唤醒）');
    await clickBtn(win, `/保存记录|发送/.test(b.textContent) && b.textContent.length <= 6`, '记录串发送');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('记录串里的追加'))`), 20_000, '记录串追加上屏');
    const recThAfter = db.prepare('SELECT root_task_id FROM conversation_threads WHERE id = ?').get(recTh.id);
    const runsAfterRec = db.prepare('SELECT count(*) c FROM workflow_runs').get().c;
    results.T3_recordThread = { recordDefaultChip: recordDefault, rootTaskStillNull: recThAfter.root_task_id == null, runsDelta: runsAfterRec - runsBeforeRec };

    // ── T4 详情：验收三重身份（先造 pending 交付）——回主池再开**任务**线程 ──
    await clickBtn(win, `b.textContent.includes('返回主池')`, 'T4 返回主池');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('页面链根消息'))`), 10_000, '主池线程卡（T4）');
    await win.webContents.executeJavaScript(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('页面链根消息')); card?.click(); return true; })()`), true);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('补充边界条件'))`), 10_000, '任务线程回复视图（T4）');
    db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run(projId);
    db.prepare("UPDATE tasks SET status = 'REVIEW', review_policy = 'user_review' WHERE id = ?").run(th.root_task_id);
    const dlvId = 'dlv_r51_1';
    db.prepare("INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES (?, ?, 2, ?, '[]', '[]', '[]', 'pending')").run(dlvId, th.root_task_id, 'f'.repeat(64));
    await clickBtn(win, `b.textContent.includes('详情') && b.closest('.thread-nav') != null`, '详情 tab');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .panel')].some((p) => p.textContent.includes('待验收交付') && p.textContent.includes('v2'))`), 10_000, '详情待验收交付');
    await clickBtn(win, `b.textContent.includes('验收通过')`, '验收通过');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .panel')].some((p) => p.textContent.includes('将验收通过 v2'))`), 8_000, '验收确认框（冻结快照）');
    await clickBtn(win, `b.textContent.trim() === '确认验收'`, '确认验收');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .panel')].some((p) => p.textContent.includes('已完成'))`), 15_000, '任务 DONE 呈现');
    const taskStatus = db.prepare('SELECT status FROM tasks WHERE id = ?').get(th.root_task_id).status;
    const dlvStatus = db.prepare('SELECT review_status FROM task_deliveries WHERE id = ?').get(dlvId).review_status;
    results.T4_review = { taskStatus, dlvStatus, reviewCmd: sentLog.filter((e) => e.method === 'task.review').map((e) => e.params) };
    results.T4_domAtCapture = await win.webContents.executeJavaScript(probe(`(() => { const panels = [...document.querySelectorAll('#hifi-root .panel')]; return panels.length ? panels[0].textContent.slice(0, 60) : null; })()`), true);
    await captureShot(win, 'thread-details.png');

    // ── T5 线程独立水位门（贴底时 markRead 发出+水位推进） ──
    const wm = db.prepare('SELECT last_read_message_seq FROM thread_read_states WHERE thread_id = ?').get(th.id);
    results.T5_threadReadGate = { watermarkRow: wm ?? null, markReadSent: sentLog.some((e) => e.method === 'thread.markRead' && e.params.threadId === th.id) };

    // ── T6 附件真实上传（页面内构造 File 注入 input→上传→ready 芯片→随信封） ──
    await clickBtn(win, `b.textContent.includes('回复') && b.closest('.thread-nav') != null`, '回回复 tab');
    await waitForJs(win, probe(`document.querySelector('#hifi-root textarea') != null`), 8_000, '回复输入区');
    const attUploaded = await win.webContents.executeJavaScript(probe(`(async () => {
      const input = document.querySelector('#hifi-root input[type=file]');
      if (input == null) return 'NO_INPUT';
      const file = new File(['R51 附件样本：页面链上传内容'], 'r51-样本.md', { type: 'text/markdown' });
      const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1500));
      const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].map((c) => c.textContent);
      return JSON.stringify(chips);
    })()`), true);
    await typeInto(win, 'R51 带附件的跟进');
    await clickBtn(win, `/发送|保存记录/.test(b.textContent) && b.textContent.length <= 6`, '发送带附件跟进');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('带附件的跟进'))`), 20_000, '附件跟进上屏');
    const attMsg = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%带附件的跟进%'").get();
    const attLink = db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(attMsg.id).c;
    const attChips = JSON.parse(String(attUploaded).startsWith('[') ? attUploaded : '[]');
    results.T6_attachment = { chipStates: attChips, readyChip: attChips.some((t) => t.includes('v1')), messageAttachmentLinks: attLink, uploadCmd: sentLog.filter((e) => e.method === 'attachment.uploadText').length };

    // ── T7 深链规范化：#task= → /thread/:id?tab=task（真实 deepLink.resolve） ──
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#task=' + th.root_task_id)}; true`, true);
    await waitForJs(win, probe(`location.hash.startsWith('#/thread/') && location.hash.includes('tab=task')`), 10_000, '深链规范化路由');
    const deepResolved = sentLog.filter((e) => e.method === 'deepLink.resolve').map((e) => e.params);
    results.T7_deepLink = { hash: await win.webContents.executeJavaScript('location.hash', true), resolveCmds: deepResolved };

    results.pass = results.T1_threadCards.hasTaskNo === true && results.T1_threadCards.hasRecordTag === true
      && results.T2_threadFollowUp.replyInThread === true && results.T2_threadFollowUp.rootTaskUnchanged === true && results.T2_threadFollowUp.taskCount === 1
      && results.T3_recordThread.recordDefaultChip === true && results.T3_recordThread.rootTaskStillNull === true && results.T3_recordThread.runsDelta === 0
      && results.T4_review.taskStatus === 'DONE' && results.T4_review.dlvStatus === 'accepted'
      && results.T5_threadReadGate.markReadSent === true
      && results.T6_attachment.readyChip === true && results.T6_attachment.messageAttachmentLinks === 1 && results.T6_attachment.uploadCmd === 1
      && results.T7_deepLink.resolveCmds.length >= 1;
    fs.writeFileSync(path.join(OUT, 'thread-r51-result.json'), JSON.stringify(results, null, 2));
    console.log('[r51] pass=' + results.pass);
  } catch (e) {
    results.error = String(e.message ?? e);
    try { results.debugText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 600)', true); results.debugHash = await win.webContents.executeJavaScript('location.hash', true); } catch { /* 窗口已关 */ }
    fs.writeFileSync(path.join(OUT, 'thread-r51-result.json'), JSON.stringify(results, null, 2));
    console.error('[r51] FAIL: ' + results.error);
  } finally {
    try { await win.destroy(); } catch { /* 已关 */ }
    await daemon.close().catch(() => {});
    server.close();
    app.exit(results.pass === true ? 0 : 3);
  }
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
