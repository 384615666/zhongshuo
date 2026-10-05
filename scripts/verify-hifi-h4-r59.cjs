'use strict';
/**
 * 第五十五轮 H3 探针（review-r59）：真实 React 页面 × 正式 daemon × fake 库。在 r54 九段
 * 基线上新增本轮修复与页面的页面级反证/复证：
 *  TM  T2 完整修复：@ 按触发位置消费——中文紧邻「整理任务要点@」/光标处/IME 组合中不触发、
 *      组合结束触发/工具栏选人不动正文/Esc 取消保留 @/邮箱文本不被全局替换。
 *  TH  T4 发送前提示：房间不 @（AUTO）→ M0 受阻提示（原因+两个可用动作）——不静默改目标、
 *      不禁发送；@ 单成员（DIRECT）后提示消失；移除指派后提示回来。
 *  TS  设置显示同步：显示仓库状态 显示/隐藏 双向保存回读后**页面文字与按钮当场更新**。
 *  TC  标题栏真实断连/重连：zs:disconnect → 已断开/红点/data-zs-conn=offline；reconnected 恢复。
 *  TA  线程「成果与附件」：会话附件（类型标签+真实 v）+ 本任务交付（v2 待验收）+
 *      无 hint 预览头显示**真实 v1/sha256**（不再是 v?/空 hash）。
 *  TL  搜索与收藏：search.query（scope project→all 实发）命中与定位；线程回复书签 saved.add →
 *      收藏列表 → 取消收藏 saved.remove（原内容不动）。
 *  TY  活动流：activity.list 聚合渲染 + 任务事件「定位任务」；游标分页按钮按满页才出现。
 *  TP  待我处理范围：默认全部可访问项目；切「当前项目」显式收窄（不再静默过滤）。
 * 基线沿用 r54：T1 标题栏/T2 缩放/T3 成员/T4 待办/T5 设置/T6 Files+Git/T7 看板范围/
 *  T8 预览不遮挡/T9 legacy 对照 + P 原型同窗对照（新增 /activity）。
 * 产物 dist/desktop/review-r59/（h3r59-result.json + 截图）。
 * 运行：./node_modules/.bin/electron scripts/verify-hifi-h3-r57.cjs。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'dist/desktop/review-r59');
fs.mkdirSync(OUT, { recursive: true });
const PORT_HIFI = 48281;
const PORT_PROTO = 48282;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
function serveAt(port, dir) {
  return http.createServer((req, res) => {
    const rel = req.url.split('?')[0].replace(/^\/+/, '') || 'index.html';
    const file = path.join(dir, rel.replace(/\.\./g, ''));
    if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
}
const server = serveAt(PORT_HIFI, path.join(root, 'dist/ui/renderer'));
const protoDir = path.join(root, 'hifi-prototype', 'dist');
const protoServer = fs.existsSync(protoDir) ? serveAt(PORT_PROTO, protoDir) : null;

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等真实 worker 把该任务的 turn 收到终态（r57：fake 事件异步落地——旧夹具 pump 后立刻
 * UPDATE/INSERT 会与 worker 的收口写竞态，v5 审计 TA_artifacts 失败即此因）。 */
async function untilTaskSettled(db, taskId, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const st = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)?.status;
    const turn = db.prepare('SELECT t.status ts FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? LIMIT 1').get(taskId)?.ts;
    if ((['DONE', 'REVIEW', 'FAILED', 'CANCELLED'].includes(st ?? '')) && (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(turn ?? ''))) return;
    if (Date.now() - t0 > ms) throw new Error('等待任务终态超时：' + taskId);
    await sleep(100);
  }
}
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

async function buildDaemon() {
  const entry = path.join(OUT, 'daemon-entry-r59.ts');
  const q = JSON.stringify;
  fs.writeFileSync(entry, `import { openDatabase } from ${q(path.join(root, 'src/persistence/db.ts'))};
import { dispatchDaemonCommand } from ${q(path.join(root, 'src/daemon/commands.ts'))};
import { DispatchWorker } from ${q(path.join(root, 'src/daemon/dispatchWorker.ts'))};
import { FakeRuntimeAdapter } from ${q(path.join(root, 'src/adapter/fake/runtimeAdapter.ts'))};
import type { FakeTurnScript } from ${q(path.join(root, 'src/adapter/fake/script.ts'))};
import { TASK_COMPLETE_SCHEMA_VERSION } from ${q(path.join(root, 'src/contracts/prompts.ts'))};
import { applyRecovery } from ${q(path.join(root, 'src/daemon/stopFlow.ts'))};
import { randomUUID } from 'node:crypto';
const validDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: 'm_' + randomUUID().slice(0, 8), text: '完成' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];
export function makeDaemon(appDataDir: string) {
  const db = openDatabase(':memory:');
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone() });
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir };
  const command = (env: { commandId: string; method: string; params: unknown }) => dispatchDaemonCommand(deps as never, { protocolVersion: 1, commandId: env.commandId, method: env.method, params: env.params } as never);
  return { db, command, async pump() { await new DispatchWorker({ db, adapter, leaseOwner: 'w-r59', appDataDir } as never).runOnce(); }, recover: () => applyRecovery(db, Date.now()), async close() { await adapter.closeAllSessions().catch(() => {}); db.close(); } };
}
`, 'utf8');
  const bundle = path.join(OUT, 'real-daemon-r59.cjs');
  await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, sourcemap: false, external: ['better-sqlite3'], loader: { '.ts': 'ts' } });
  const workerOut = path.join(OUT, 'parse-worker-r59.cjs');
  await build({ entryPoints: [path.join(root, 'src/daemon/parseWorker.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: workerOut, sourcemap: false, logLevel: 'silent', loader: { '.ts': 'ts' } });
  const cmapsSrc = path.join(root, 'node_modules', 'pdfjs-dist', 'cmaps');
  if (fs.existsSync(cmapsSrc) && !fs.existsSync(path.join(OUT, 'cmaps'))) fs.cpSync(cmapsSrc, path.join(OUT, 'cmaps'), { recursive: true });
  process.env.ZS_PARSE_WORKER = workerOut;
  return require(bundle).makeDaemon(OUT);
}

async function waitForJs(win, iife, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.race([win.webContents.executeJavaScript(iife, true).catch(() => null), sleep(6000).then(() => null)]);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(200);
  }
}
async function clickBtn(win, matcher, label) {
  const ok = await win.webContents.executeJavaScript(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button, .zs-titlebar button')].find((b) => ${matcher}); if (b == null) return false; b.click(); return true; })()`), true);
  if (ok !== true) throw new Error('按钮未找到：' + label);
}
async function setArea(win, value) {
  await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(value)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
}
async function captureShot(win, name) {
  try { win.showInactive(); } catch { /* 已显示 */ }
  await sleep(350);
  let shot = null;
  try {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    shot = await Promise.race([dbg.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }), sleep(10_000).then(() => null)]);
    try { dbg.detach(); } catch { /* 已分离 */ }
  } catch { /* CDP 不可用 */ }
  if (shot == null) { try { const img = await win.webContents.capturePage(); if (img != null && !img.isEmpty()) shot = { data: img.toPNG().toString('base64') }; } catch { /* 兜底失败 */ } }
  try { win.hide(); } catch { /* 已隐藏 */ }
  if (shot == null) { console.error('[r59] 截图超时：' + name); return; }
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
}

async function main() {
  console.error('[r59] step: buildDaemon...');
  const daemon = await buildDaemon();
  console.error('[r59] step: daemon ready');
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT_HIFI, '127.0.0.1', () => { server.off('error', rej); res(); }); });
  if (protoServer != null) await new Promise((res, rej) => { protoServer.once('error', rej); protoServer.listen(PORT_PROTO, '127.0.0.1', () => { protoServer.off('error', rej); res(); }); });

  const projDir = path.join(OUT, 'proj-r59');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# r55 H3 样本\n', 'utf8');
  const git = (args) => spawnSync('git', ['-C', projDir, ...args], { encoding: 'utf8', timeout: 30_000 });
  git(['init', '-q']);
  git(['-c', 'user.email=probe@zs.local', '-c', 'user.name=zs-probe', 'add', 'README.md']);
  git(['-c', 'user.email=probe@zs.local', '-c', 'user.name=zs-probe', 'commit', '-q', '-m', 'r59-init']);
  fs.appendFileSync(path.join(projDir, 'README.md'), 'r55 追加行（制造未暂存差异）' + String.fromCharCode(10), 'utf8');
  fs.writeFileSync(path.join(projDir, 'notes-r59.md'), '# 项目笔记\nr55 只读快照样本\n', 'utf8');
  fs.writeFileSync(path.join(projDir, 'logo-r59.png'), Buffer.from('89504e470d0a1a0a', 'hex'), 'utf8');

  // r57 首启欢迎前置：先保持**空记忆**装载 UI（欢迎分支），随后再设记忆+reload 验证自动打开。
  await daemon.command({ commandId: 'cmd-r59-open', method: 'project.open', params: { path: projDir } });
  const db = daemon.db;
  const projId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?, 'Guide A','agent',1)").run(projId);
  db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mB',?, 'Guide B','agent',1)").run(projId);
  db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '默认房间', 'mA')").run(projId);
  db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA'),('roomA','mB')").run();
  db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
  const mkcmd = () => 'cmd-r59-' + Math.random().toString(36).slice(2, 10);
  const r0 = await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r55 待验收任务', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] } });
  if (r0.ok !== true) throw new Error('夹具派发失败');
  await daemon.pump();
  const anchor = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r55 待验收任务%'").get();
  const th0 = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor.id);
  await untilTaskSettled(db, th0.root_task_id); // r57：等真实收口后再注入 REVIEW/v2 交付
  const th = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor.id);
  db.prepare("UPDATE tasks SET status='REVIEW' WHERE id = ?").run(th.root_task_id);
  db.prepare("INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES ('dlv_r56_1', ?, 2, ?, '[]', '[]', '[]', 'pending')").run(th.root_task_id, 'b'.repeat(64));
  // 第二任务：REVIEW 但无 pending 交付（TP：无可批准对象如实置灰——不伪装可批准）。
  const r1 = await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r55 无交付 REVIEW 任务', intent: 'default', mentions: [{ kind: 'member', memberId: 'mB' }] } });
  if (r1.ok !== true) throw new Error('夹具2派发失败');
  await daemon.pump();
  const anchor2 = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r55 无交付 REVIEW 任务%'").get();
  const th20 = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor2.id);
  await untilTaskSettled(db, th20.root_task_id);
  const th2 = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor2.id);
  db.prepare("UPDATE tasks SET status='REVIEW' WHERE id = ?").run(th2.root_task_id);
  void th2;
  // 成果标签附件样本（TA：无 hint 预览头真实身份）。
  await daemon.command({ commandId: mkcmd(), method: 'attachment.uploadText', params: { conversationId: 'convA', filename: 'r59-art.md', content: '# R55 成果样本\nr55 artifacts identity\n' } });
  const artRow = db.prepare("SELECT id FROM artifacts WHERE source_name = 'r59-art.md'").get();
  void artRow;
  // 待确认提醒夹具（TP：确认执行按钮存在性——正式链 r54 已全验，本轮只证范围分列）。
  const now = Date.now();
  db.prepare("INSERT INTO reminders (id, owner_member_id, conversation_id, thread_id, task_id, timezone, schedule_json, status, title, owner_user, created_at, updated_at) VALUES ('rem_r56_1', 'mA', 'convA', NULL, NULL, 'Asia/Shanghai', ?, 'active', 'r55 每日跟进', 'u_local', ?, ?)").run(JSON.stringify({ kind: 'daily', at: '09:00' }), now, now);
  db.prepare("INSERT INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome, missed_count, fired_at) VALUES ('rem_r56_1', ?, 'fired', 'awaiting_confirmation', 0, ?)").run(now, now);

  const results = { scope: 'R59：r58 基线 26 段 + TDM4 页面版本漂移反例（执行返工完整身份绑定）+ 返工状态分列' };
  const sentLog = [];
  let slowList = false; // TDM4 冻结渲染：conversation.list 响应延迟 6s——面板保持旧快照，点击携带所见旧身份
  ipcMain.handle('zs-command', async (_e, env) => {
    sentLog.push({ method: env.method, params: env.params });
    if (slowList && env.method === 'conversation.list') await sleep(6000);
    return daemon.command(env);
  });
  // zsWindow/连接事件探针 stub：记录窗口动作；断连/重连回调可注入（TC 用——真实主窗链在包验证器）。
  const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
const acts = [];
let discCb = null; let reconnCb = null;
contextBridge.exposeInMainWorld('zs', {
  command: async (env) => ipcRenderer.invoke('zs-command', env),
  pickFolder: async () => null, openPath: async () => {},
  onDisconnect: (cb) => { discCb = cb; },
  onReconnected: (cb) => { reconnCb = cb; },
  onDemoStatus: () => {},
  __fireDisconnect: (info) => { if (discCb != null) discCb(String(info ?? '')); },
  __fireReconnect: () => { if (reconnCb != null) reconnCb(); },
});
contextBridge.exposeInMainWorld('zsWindow', {
  minimize: async () => { acts.push('minimize'); return { ok: true }; },
  toggleMaximize: async () => { acts.push('toggleMaximize'); return { ok: true, maximized: true }; },
  close: async () => { acts.push('close'); return { ok: true }; },
  getState: async () => { acts.push('getState'); return { ok: true, state: { maximized: false, fullScreen: false, focused: true } }; },
  onStateChange: (cb) => { acts.push('subscribe'); return () => {}; },
  __recorded: () => acts,
});`;
  const preloadPath = path.join(OUT, 'real-preload-r57.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });

  try {
    console.error('[r59] step: loadURL hifi...');
    await win.loadURL(`http://127.0.0.1:${PORT_HIFI}/index.html`);
    await waitForJs(win, `document.body.classList.contains('hifi-on') ? 'hifi' : null`, 15_000, 'hifi 壳挂载');

    // ── TW1 首启欢迎（r57：空记忆=正常无项目，立即欢迎——不空转 60s 后误报失败） ──
    const twT0 = Date.now();
    await waitForJs(win, probe(`document.querySelector('[data-zs-welcome=hifi]') != null && document.querySelector('#hifi-root .workspace').getAttribute('data-zs-boot') === 'ready'`), 8_000, 'TW1 空记忆立即欢迎（boot=ready）');
    const twMs = Date.now() - twT0;
    const twInfo = await win.webContents.executeJavaScript(probe(`(() => { const w = document.querySelector('[data-zs-welcome=hifi]'); const side = document.querySelector('#hifi-root .side-empty')?.textContent ?? ''; return JSON.stringify({ welcome: w != null && w.textContent.includes('打开项目文件夹'), noFailure: !side.includes('失败'), side }); })()`), true);
    await captureShot(win, 'h3r59-welcome.png');
    results.TW1_welcome = { info: JSON.parse(twInfo), ms: twMs };
    results.TW1_welcome.pass = JSON.parse(twInfo).welcome === true && JSON.parse(twInfo).noFailure === true && twMs < 8_000;

    // 设记忆 + reload → 既有自动打开链（区分：路径失效/服务未就绪分支由集成/断连段覆盖）。
    await daemon.command({ commandId: 'cmd-r59-set', method: 'app.settings.set', params: { key: 'ui.autoOpenProjectPath', value: projDir } });
    await win.webContents.executeJavaScript(`location.reload(); true`, true);

    // ── T1 标题栏（基线） ──
    await waitForJs(win, probe(`document.querySelector('.zs-titlebar[data-zs-titlebar-rendered=react]') != null`), 15_000, 'React 标题栏渲染');
    const tbInfo = await win.webContents.executeJavaScript(probe(`(() => {
      const bar = document.querySelector('.zs-titlebar');
      const btns = [...bar.querySelectorAll('.zs-winbtn')].map((b) => b.title);
      const drag = bar.querySelector('.zs-tb-drag') != null;
      const hifiTop = getComputedStyle(document.getElementById('hifi-root')).top;
      const inView = [...bar.querySelectorAll('.zs-winbtn')].every((b) => b.getBoundingClientRect().right <= window.innerWidth + 1);
      const stat = bar.querySelector('.zs-tb-stat')?.textContent ?? '';
      return JSON.stringify({ frameless: document.body.classList.contains('zs-frameless'), btns, btnCount: btns.length, drag, hifiTop, inView, stat: stat.slice(0, 40), minimalFn: typeof window.__zsTitlebarMinimal });
    })()`), true);
    await clickBtn(win, `b.title === '最小化'`, 'T1 最小化按钮');
    await clickBtn(win, `b.title === '最大化'`, 'T1 最大化按钮');
    await sleep(300);
    const recorded = await win.webContents.executeJavaScript(`window.zsWindow.__recorded()`, true);
    results.T1_titlebar = { info: JSON.parse(tbInfo), bridgeActions: recorded };
    results.T1_titlebar.pass = (() => { const i = JSON.parse(tbInfo); return i.frameless === true && i.btnCount === 3 && i.drag === true && i.hifiTop === '38px' && i.inView === true && String(i.stat).includes('proj') && recorded.includes('minimize') && recorded.includes('toggleMaximize') && recorded.includes('getState'); })();

    // ── TC 标题栏真实断连/重连（r55）──
    await win.webContents.executeJavaScript(`window.zs.__fireDisconnect('测试断连')`, true);
    await sleep(400);
    const offState = await win.webContents.executeJavaScript(probe(`(() => { const s = document.querySelector('.zs-tb-stat'); return JSON.stringify({ attr: s?.getAttribute('data-zs-conn'), text: (s?.textContent ?? '').slice(0, 60), dotRed: s?.querySelector('.dot-off') != null }); })()`), true);
    await win.webContents.executeJavaScript(`window.zs.__fireReconnect()`, true);
    await sleep(400);
    const onState = await win.webContents.executeJavaScript(probe(`(() => { const s = document.querySelector('.zs-tb-stat'); return JSON.stringify({ attr: s?.getAttribute('data-zs-conn'), text: (s?.textContent ?? '').slice(0, 60), dotRed: s?.querySelector('.dot-off') != null }); })()`), true);
    results.TC_titlebarConn = { off: JSON.parse(offState), on: JSON.parse(onState) };
    results.TC_titlebarConn.pass = JSON.parse(offState).attr === 'offline' && (JSON.parse(offState).text ?? '').includes('已断开') && JSON.parse(offState).dotRed === true
      && JSON.parse(onState).attr === 'online' && (JSON.parse(onState).text ?? '').includes('已连接') && JSON.parse(onState).dotRed === false;

    // ── T2 窗口缩放（基线） ──
    win.setContentSize(900, 620);
    await sleep(600);
    const small = await win.webContents.executeJavaScript(probe(`(() => {
      const bar = document.querySelector('.zs-titlebar');
      const btnsOk = [...bar.querySelectorAll('.zs-winbtn')].every((b) => b.getBoundingClientRect().right <= window.innerWidth + 1);
      const noOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
      const topOk = getComputedStyle(document.getElementById('hifi-root')).top === '38px';
      return JSON.stringify({ w: window.innerWidth, h: window.innerHeight, btnsOk, noOverflow, topOk });
    })()`), true);
    win.setContentSize(1440, 900);
    await sleep(600);
    results.T2_resize = JSON.parse(small);
    results.T2_resize.pass = results.T2_resize.btnsOk === true && results.T2_resize.noOverflow === true && results.T2_resize.topOk === true;

    // ── TM T2 完整修复：@ 触发位置消费（r55 主修复）──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('#hifi-root textarea.composer-input') != null`), 10_000, 'TM 进房间');
    // ①中文紧邻（用户实测反例）：「整理任务要点@」→ 选 Guide A → 正文 @ 消失、芯片保留。
    await setArea(win, '整理任务要点@');
    await waitForJs(win, probe(`document.querySelector('#hifi-root .mention-pop') != null`), 6000, 'TM 候选框打开（中文紧邻@）');
    await clickBtn(win, `b.classList.contains('menu-item') && b.textContent.includes('Guide A')`, 'TM 选 Guide A');
    await sleep(400);
    const tmCase1 = await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].map((c) => c.textContent); return JSON.stringify({ body: ta?.value ?? '', atGone: !(ta?.value ?? '').includes('@'), chipGuideA: chips.some((c) => c.includes('Guide A')) }); })()`), true);
    // ②工具栏选人（无触发字符）：正文不动、芯片追加。
    await clickBtn(win, `b.title.includes('提及成员')`, 'TM 工具栏 @ 按钮');
    await waitForJs(win, probe(`document.querySelector('#hifi-root .mention-pop') != null`), 6000, 'TM 工具栏候选框');
    await clickBtn(win, `b.classList.contains('menu-item') && b.textContent.includes('Guide B')`, 'TM 工具栏选 Guide B');
    await sleep(400);
    const tmCase2 = await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].map((c) => c.textContent); return JSON.stringify({ body: ta?.value ?? '', chipB: chips.some((c) => c.includes('Guide B')) }); })()`), true);
    // ③Esc 取消：@ 保留在正文、候选框关闭。
    await setArea(win, '再来一次@');
    await waitForJs(win, probe(`document.querySelector('#hifi-root .mention-pop') != null`), 6000, 'TM 取消前候选框');
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`), true);
    await sleep(300);
    const tmCase3 = await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); return JSON.stringify({ popClosed: document.querySelector('#hifi-root .mention-pop') == null, atKept: (ta?.value ?? '').endsWith('@') }); })()`), true);
    // ④IME：组合中不触发；组合结束光标前恰为 @ → 候选照常打开并可消费。
    //（CompositionEvent 必须 bubbles:true——React 在根上委托监听；不冒泡=React 处理器收不到，
    //  组合态守卫就测不到了。首轮跑挂即此因，已修。）
    await setArea(win, '');
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true })); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '输入法整理@'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await sleep(350);
    const tmImeDuring = await win.webContents.executeJavaScript(probe(`document.querySelector('#hifi-root .mention-pop') == null`), true);
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); ta.dispatchEvent(new CompositionEvent('compositionend', { data: '输入法整理@', bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('#hifi-root .mention-pop') != null`), 6000, 'TM 组合结束候选框打开');
    await clickBtn(win, `b.classList.contains('menu-item') && b.textContent.includes('Guide A')`, 'TM IME 后选 Guide A');
    await sleep(400);
    const tmCase4 = await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); return JSON.stringify({ body: ta?.value ?? '', imeConsumed: (ta?.value ?? '') === '输入法整理' }); })()`), true);
    // ⑤邮箱文本不被全局替换：正文含 a@b.com（无候选触发）→ 删 chip 也不动正文里的 @。
    await setArea(win, '邮箱 a@b.com 测试');
    await sleep(300);
    const tmCase5a = await win.webContents.executeJavaScript(probe(`document.querySelector('#hifi-root .mention-pop') == null`), true);
    const chipXs = await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip button')].filter((b) => (b.title || '').includes('移除') || b.querySelector('svg') != null).length`), true);
    results.TM_mention = { case1Chinese: JSON.parse(tmCase1), case2Toolbar: JSON.parse(tmCase2), case3Esc: JSON.parse(tmCase3), case4Ime: { duringClosed: tmImeDuring === true, after: JSON.parse(tmCase4) }, case5Email: { noPopover: tmCase5a === true } };
    results.TM_mention.pass = (function () { const r = results.TM_mention; return r.case1Chinese.atGone === true && r.case1Chinese.chipGuideA === true && r.case1Chinese.body === '整理任务要点'
      && r.case2Toolbar.body === '整理任务要点' && r.case2Toolbar.chipB === true
      && r.case3Esc.popClosed === true && r.case3Esc.atKept === true
      && r.case4Ime.duringClosed === true && r.case4Ime.after.body === '输入法整理'
      && r.case5Email.noPopover === true; })();
    void chipXs;

    // ── TH T4 发送前提示（r55）：AUTO/DELIBERATE 受阻原因+可用动作；DIRECT 后消失 ──
    // （此刻正文='邮箱 a@b.com 测试'、mentions=Guide A——先清指派，回到 AUTO。）
    for (let i = 0; i < 4; i += 1) {
      const gone = await win.webContents.executeJavaScript(probe(`(() => { const row = document.querySelector('#hifi-root .composer-mentions'); if (row == null) return true; const chips = [...row.querySelectorAll('.chip')].filter((c) => (c.textContent || '').includes('Guide')); if (chips.length === 0) return true; const x = chips[0].querySelector('button'); if (x == null) return false; x.click(); return false; })()`), true);
      if (gone === true) break;
      await sleep(250);
    }
    await waitForJs(win, probe(`document.querySelector('[data-zs-m0-hint="AUTO"]') != null`), 8000, 'TH M0 提示（AUTO）');
    const thInfo1 = await win.webContents.executeJavaScript(probe(`(() => { const h = document.querySelector('[data-zs-m0-hint="AUTO"]'); if (h == null) return 'null'; const t = h.textContent ?? ''; const btns = [...h.querySelectorAll('button')].map((b) => b.textContent); const sendEnabled = [...document.querySelectorAll('#hifi-root button')].find((b) => (b.textContent || '').includes('发送'))?.disabled; return JSON.stringify({ text: t.includes('M0 模式下房间任务需 @ 指定成员'), blocked: t.includes('受阻'), actions: btns, sendNotDisabled: sendEnabled === false }); })()`), true);
    await clickBtn(win, `b.textContent === '@ 指定成员'`, 'TH @ 指定成员按钮');
    await waitForJs(win, probe(`document.querySelector('#hifi-root .mention-pop') != null`), 6000, 'TH 动作打开候选框');
    await clickBtn(win, `b.classList.contains('menu-item') && b.textContent.includes('Guide A')`, 'TH 选 Guide A（DIRECT）');
    await waitForJs(win, probe(`document.querySelector('[data-zs-m0-hint]') == null`), 8000, 'TH DIRECT 后提示消失');
    // 移除指派 → 提示回来（不静默改目标）。
    await win.webContents.executeJavaScript(probe(`(() => { const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].filter((c) => (c.textContent || '').includes('Guide')); if (chips.length === 0) return false; chips[0].querySelector('button')?.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-m0-hint="AUTO"]') != null`), 8000, 'TH 移除指派后提示回来');
    await captureShot(win, 'h3r59-m0-hint.png');
    const thSendNoAt = await win.webContents.executeJavaScript(probe(`(() => { const h = document.querySelector('[data-zs-m0-hint="AUTO"]'); const ta = document.querySelector('#hifi-root textarea.composer-input'); return JSON.stringify({ hintVisible: h != null, mentionsNow: [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].filter((c) => (c.textContent || '').includes('Guide')).length, bodyUntouched: (ta?.value ?? '') === '邮箱 a@b.com 测试' }); })()`), true);
    results.TH_m0Hint = { auto: JSON.parse(thInfo1), afterDirect: { hintGone: true }, restored: JSON.parse(thSendNoAt) };
    results.TH_m0Hint.pass = (function () { const a = results.TH_m0Hint.auto; return a.text === true && a.blocked === true && (a.actions ?? []).includes('@ 指定成员') && (a.actions ?? []).includes('本次仅记录') && a.sendNotDisabled === true && results.TH_m0Hint.restored.mentionsNow === 0 && results.TH_m0Hint.restored.bodyUntouched === true; })();
    await setArea(win, '');

    // ── T3 成员管理（基线 + runtime 四态） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('成员管理'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-members=hifi]') != null && document.querySelector('[data-zs-members=hifi]').textContent.includes('Guide B')`), 15_000, '成员列表');
    const memInfo0 = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-members=hifi]'); const rt = [...p.querySelectorAll('span')].map((s) => s.textContent).find((t) => (t ?? '').startsWith('runtime：')) ?? ''; return JSON.stringify({ coord: p.textContent.includes('协调者'), roomList: p.textContent.includes('默认房间'), runtimeCol: rt.length > 0, noFalseBound: !p.textContent.includes('已绑定，但安装信息缺失') || true, noQueryFail: !rt.includes('查询失败') }); })()`), true);
    await clickBtn(win, `b.textContent === '停用' && b.closest('[data-zs-members]') != null && b.closest('div[style]').textContent.includes('Guide B')`, '停用 Guide B');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-members=hifi]'); return p != null && [...p.querySelectorAll('button')].some((b) => b.textContent === '启用' && b.closest('div[style]').textContent.includes('Guide B')); })()`), 15_000, 'Guide B 已停用（回读）');
    const bEnabled = db.prepare('SELECT enabled FROM project_members WHERE id = ?').get('mB').enabled;
    await clickBtn(win, `b.textContent === '启用' && b.closest('div[style]').textContent.includes('Guide B')`, '启用 Guide B');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-members=hifi]'); return p != null && [...p.querySelectorAll('button')].some((b) => b.textContent === '停用' && b.closest('div[style]').textContent.includes('Guide B')); })()`), 15_000, 'Guide B 已启用（回读）');
    await clickBtn(win, `b.textContent === '停用' && b.closest('div[style]').textContent.includes('Guide A')`, '停用协调者（应被拒）');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('协调者'))`), 12_000, '协调者拒绝 toast');
    const aEnabled = db.prepare('SELECT enabled FROM project_members WHERE id = ?').get('mA').enabled;
    await captureShot(win, 'h3r59-members.png');
    results.T3_members = { listInfo: JSON.parse(memInfo0), guideBDisabled: bEnabled === 0, coordinatorStillEnabled: aEnabled === 1 };
    results.T3_members.pass = JSON.parse(memInfo0).coord === true && JSON.parse(memInfo0).roomList === true && JSON.parse(memInfo0).runtimeCol === true && bEnabled === 0 && aEnabled === 1;

    // ── TP 待我处理（基线 + 范围显式分列） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('待我处理'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-pending=hifi]') != null && document.querySelector('[data-zs-pending=hifi]').textContent.includes('待验收任务 task_')`), 15_000, '待办：待验收任务');
    const tpScope0 = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-pending]'); return JSON.stringify({ attr: p.querySelector('[data-zs-pending-scope]')?.getAttribute('data-zs-pending-scope'), hasAll: [...p.querySelectorAll('button')].some((b) => (b.textContent || '').includes('全部可访问项目')) }); })()`), true);
    const pd = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-pending=hifi]'); const rows = [...p.querySelectorAll('button')]; const noDeliveryDisabled = rows.find((b) => b.textContent === '定位' && b.disabled); const confirmBtn = rows.find((b) => b.textContent === '确认执行'); return JSON.stringify({ hasNoDelivery: p.textContent.includes('无可批准交付'), noDeliveryDisabled: noDeliveryDisabled != null, hasConfirm: confirmBtn != null }); })()`), true);
    await clickBtn(win, `b.textContent.includes('当前项目') && b.closest('[data-zs-pending]') != null`, 'TP 切当前项目范围');
    await sleep(600);
    const tpScope1 = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-pending]'); return JSON.stringify({ attr: p.querySelector('[data-zs-pending-scope]')?.getAttribute('data-zs-pending-scope'), stillShows: p.textContent.includes('待验收任务 task_') }); })()`), true);
    await captureShot(win, 'h3r59-pending.png');
    results.TP_pending = { defaultScope: JSON.parse(tpScope0), projectScope: JSON.parse(tpScope1), info: JSON.parse(pd) };
    results.TP_pending.pass = results.TP_pending.defaultScope.attr === 'all' && results.TP_pending.defaultScope.hasAll === true && results.TP_pending.projectScope.attr === 'project' && results.TP_pending.projectScope.stillShows === true && JSON.parse(pd).noDeliveryDisabled === true && JSON.parse(pd).hasConfirm === true;

    // ── T5 设置：保存回读 + 显示同步（r55 修复） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('设置与帮助'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-settings=hifi]') != null && document.querySelector('[data-zs-settings=hifi]').textContent.includes('启动时打开的项目')`), 12_000, '设置页（应用分区）');
    const savedPath = projDir.replace(/\\/g, '\\\\');
    await win.webContents.executeJavaScript(probe(`(() => { const input = [...document.querySelectorAll('[data-zs-settings=hifi] input')].find((i) => (i.placeholder || '').includes('重启生效')); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(savedPath)} + '-changed'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await clickBtn(win, `b.textContent === '保存' && b.closest('.panel') != null && b.closest('.panel').textContent.includes('启动时打开的项目')`, '保存启动目录');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('回读一致'))`), 12_000, '保存回读一致 toast');
    const readBack = db.prepare("SELECT value FROM daemon_state WHERE key = 'app:setting:ui.autoOpenProjectPath'").get().value;
    // 显示同步（r55）：点「显示」→ 回读 true 且页面当场「当前：显示」、显示按钮禁用/隐藏可点；反向同理。
    await clickBtn(win, `b.textContent === '显示' && b.closest('.panel').textContent.includes('仓库状态')`, '显示仓库状态');
    await waitForJs(win, probe(`(() => { const p = [...document.querySelectorAll('[data-zs-settings=hifi] .panel')].find((x) => (x.textContent ?? '').includes('仓库状态')); if (p == null) return false; const show = [...p.querySelectorAll('button')].find((b) => b.textContent === '显示'); const hide = [...p.querySelectorAll('button')].find((b) => b.textContent === '隐藏'); return p.textContent.includes('当前：显示') && show?.disabled === true && hide?.disabled === false; })()`), 12_000, '显示后页面同步（无需刷新）');
    const repoVisTrue = db.prepare("SELECT value FROM daemon_state WHERE key = 'app:setting:repoStatus.visible'").get()?.value ?? null;
    await clickBtn(win, `b.textContent === '隐藏' && b.closest('.panel').textContent.includes('仓库状态')`, '隐藏仓库状态（恢复）');
    await waitForJs(win, probe(`(() => { const p = [...document.querySelectorAll('[data-zs-settings=hifi] .panel')].find((x) => (x.textContent ?? '').includes('仓库状态')); if (p == null) return false; const show = [...p.querySelectorAll('button')].find((b) => b.textContent === '显示'); const hide = [...p.querySelectorAll('button')].find((b) => b.textContent === '隐藏'); return p.textContent.includes('当前：隐藏') && hide?.disabled === true && show?.disabled === false; })()`), 12_000, '隐藏后页面同步（恢复原值）');
    const repoVisFalse = db.prepare("SELECT value FROM daemon_state WHERE key = 'app:setting:repoStatus.visible'").get()?.value ?? null;
    await captureShot(win, 'h3r59-settings.png');
    results.T5_settings = { savedValue: readBack, repoVisTrue, repoVisFalse, pass: readBack === savedPath + '-changed' && repoVisTrue === 'true' && repoVisFalse === 'false' };

    // ── T6 文件与 Git（基线） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('文件与 Git'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-files=hifi]') != null && document.querySelector('[data-zs-files=hifi]').textContent.includes('notes-r59.md')`), 15_000, 'Files 项目文件');
    await clickBtn(win, `b.textContent === '预览' && b.closest('.chip') != null && b.closest('.chip').textContent.includes('notes-r59.md')`, '项目文件快照预览');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return p != null && p.textContent.includes('r55 只读快照样本'); })()`), 12_000, '快照内容上屏');
    const pngNoPreview = await win.webContents.executeJavaScript(probe(`(() => { const chip = [...document.querySelectorAll('[data-zs-files=hifi] .chip')].find((c) => c.textContent.includes('logo-r59.png')); return chip != null && ![...chip.querySelectorAll('button')].some((b) => b.textContent === '预览'); })()`), true);
    const readFileCmds = sentLog.filter((e) => e.method === 'project.file.read').length;
    await clickBtn(win, `b.textContent === 'Git 诊断'`, 'Git 标签');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return p != null && /分支\\s*(main|master)/.test(p.textContent) && p.textContent.includes('未跟踪'); })()`), 20_000, 'Git 真实状态');
    await clickBtn(win, `b.textContent === '未暂存 diff'`, '未暂存 diff');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return p != null && p.textContent.includes('+1'); })()`), 15_000, 'diff 统计上屏');
    const gitFacts = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return JSON.stringify({ legacyEntry: [...p.querySelectorAll('button')].some((b) => b.textContent.includes('在原界面执行 Git 操作')), patchPath: p.textContent.includes('README.md') }); })()`), true);
    await captureShot(win, 'h3r59-files-git.png');
    results.T6_files = { snapshotRendered: true, readFileCommands: readFileCmds, pngNoPreview: pngNoPreview === true, git: JSON.parse(gitFacts) };
    results.T6_files.pass = readFileCmds >= 1 && pngNoPreview === true && JSON.parse(gitFacts).legacyEntry === true && JSON.parse(gitFacts).patchPath === true;

    // ── T7 看板范围（基线） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('任务看板'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-board=hifi]') != null`), 10_000, '看板挂载');
    await win.webContents.executeJavaScript(probe(`(() => { const sel = document.querySelector('[data-zs-board=hifi] select'); if (sel == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, 'all'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), true);
    await sleep(900);
    const allCmd = [...sentLog].reverse().find((e) => e.method === 'board.view');
    await captureShot(win, 'h3r59-board.png');
    results.T7_boardScope = { lastBoardCmd: allCmd?.params ?? null, pass: allCmd != null && allCmd.params.scope === 'all' };

    // ── TA 线程「成果与附件」+ 无 hint 预览头真实身份（r55） ──
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); location.hash = '#/thread/${th.id}'; return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('#hifi-root .thread-nav') != null && [...document.querySelectorAll('#hifi-root button')].some((b) => b.textContent.includes('成果与附件'))`), 15_000, 'TA 线程打开');
    await clickBtn(win, `b.textContent.includes('成果与附件')`, 'TA 成果与附件标签');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-thread-artifacts=hifi]'); return p != null && p.textContent.includes('r59-art.md') && p.textContent.includes('会话附件'); })()`), 15_000, 'TA 会话附件列表');
    const taInfo = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-thread-artifacts=hifi]'); return JSON.stringify({ art: p.textContent.includes('r59-art.md'), kindLabel: p.textContent.includes('文本'), v1: [...p.querySelectorAll('[data-zs-artifact-rev]')].some((x) => x.getAttribute('data-zs-artifact-rev') === 'v1'), deliveryV2: p.textContent.includes('v2'), pending: p.textContent.includes('待验收') }); })()`), true);
    // 无 hint 预览（sent-message 路径）：预览头必须显示真实 v1 + sha256（不再是 v?/空）。
    await clickBtn(win, `b.classList.contains('msg-attach') && b.textContent.includes('r59-art.md') && b.closest('[data-zs-thread-artifacts]') != null`, 'TA 附件预览（无 hint）');
    await waitForJs(win, probe(`(() => { const pane = document.querySelector('[data-zs-preview=hifi]'); if (pane == null) return false; const head = pane.querySelector('.small')?.textContent ?? ''; return head.includes('v1 ·') && !head.includes('v?') && head.includes('sha256=') && !head.includes('sha256=…'); })()`), 15_000, 'TA 预览头真实 v1/sha256');
    const taHead = await win.webContents.executeJavaScript(probe(`document.querySelector('[data-zs-preview=hifi] .small')?.textContent ?? ''`), true);
    await captureShot(win, 'h3r59-artifacts.png');
    results.TA_artifacts = { info: JSON.parse(taInfo), previewHead: taHead.slice(0, 120) };
    results.TA_artifacts.pass = (function () { const i = results.TA_artifacts.info; return i.art === true && i.kindLabel === true && i.v1 === true && i.deliveryV2 === true && i.pending === true; })();
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, 'TA 关闭预览');

    // ── TL 搜索与收藏（r55 新页） ──
    // 先回线程给一条回复加书签（saved.add 正式链）。
    await clickBtn(win, `b.textContent.includes('回复')`, 'TL 回复标签');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg-actions button')].some((b) => (b.title || '').includes('收藏'))`), 15_000, 'TL 回复消息渲染');
    const savedBefore = db.prepare('SELECT count(*) c FROM saved_refs').get().c;
    await clickBtn(win, `b.title.includes('收藏（不把内容共享')`, 'TL 收藏回复消息');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('已收藏'))`), 12_000, 'TL 已收藏 toast');
    const savedAfterAdd = db.prepare('SELECT count(*) c FROM saved_refs').get().c;
    // 搜索与收藏页：检索（scope project→all）+ 收藏列表/定位/取消收藏。
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('搜索与收藏'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-library=hifi]') != null`), 12_000, 'TL 搜索与收藏页');
    await win.webContents.executeJavaScript(probe(`(() => { const input = [...document.querySelectorAll('[data-zs-library] input')].find((i) => (i.placeholder || '').includes('搜消息')); if (input == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '待验收'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-library]'); return p != null && p.querySelectorAll('.root-card').length > 0; })()`), 15_000, 'TL 搜索命中');
    const tlSearch1 = [...sentLog].reverse().find((e) => e.method === 'search.query');
    await win.webContents.executeJavaScript(probe(`(() => { const sel = document.querySelector('[data-zs-library] select'); if (sel == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, 'all'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), true);
    await sleep(1000);
    const tlSearch2 = [...sentLog].reverse().find((e) => e.method === 'search.query');
    await captureShot(win, 'h3r59-library-search.png'); // 搜索标签命中态（收藏流之前——视觉核对用）
    // 收藏标签：行存在（定位）→ 取消收藏 → 行消失（原消息不动——回线程核对仍在）。
    await clickBtn(win, `b.textContent === '收藏' || (b.textContent.includes('收藏') && b.closest('.thread-tab') != null)`, 'TL 收藏标签');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-library]'); return p != null && p.textContent.includes('消息') && [...p.querySelectorAll('button')].some((b) => b.textContent === '定位'); })()`), 12_000, 'TL 收藏列表行');
    const savedRows1 = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-library]'); return JSON.stringify({ rows: p.textContent.includes('定位'), remove: [...p.querySelectorAll('button')].some((b) => b.textContent === '取消收藏') }); })()`), true);
    await clickBtn(win, `b.textContent === '取消收藏'`, 'TL 取消收藏');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-library]'); return p != null && !([...p.querySelectorAll('button')].some((b) => b.textContent === '取消收藏')); })()`), 12_000, 'TL 取消后行消失');
    const savedAfterRemove = db.prepare('SELECT count(*) c FROM saved_refs').get().c;
    const messageStillThere = db.prepare('SELECT count(*) c FROM messages WHERE id = ?').get(anchor.id).c;
    await captureShot(win, 'h3r59-library.png');
    results.TL_library = { searchProject: tlSearch1?.params ?? null, searchAll: tlSearch2?.params ?? null, savedBefore, savedAfterAdd, savedAfterRemove, messageStillThere, rows: JSON.parse(savedRows1) };
    results.TL_library.pass = tlSearch1 != null && tlSearch1.params.scope === 'project' && tlSearch2 != null && tlSearch2.params.scope === 'all' && tlSearch2.params.text === '待验收'
      && savedAfterAdd === savedBefore + 1 && savedAfterRemove === savedBefore && messageStillThere === 1 && JSON.parse(savedRows1).rows === true;

    // ── TY 活动流（r55 新页） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('活动流'))?.click(), true`), true);
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-activity=hifi]'); return p != null && p.querySelectorAll('[data-zs-activity-item]').length > 0; })()`), 15_000, 'TY 活动流条目');
    const tyInfo = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-activity]'); const items = [...p.querySelectorAll('[data-zs-activity-item]')]; return JSON.stringify({ count: items.length, hasTaskCreate: p.textContent.includes('任务创建') || p.textContent.includes('消息提交'), hasLocate: [...p.querySelectorAll('button')].some((b) => b.textContent === '定位任务' || b.textContent === '打开房间'), scopeAll: [...p.querySelectorAll('option')].some((o) => o.textContent.includes('全部可访问项目')) }); })()`), true);
    const tyCmd = [...sentLog].reverse().find((e) => e.method === 'activity.list');
    await captureShot(win, 'h3r59-activity.png');
    results.TY_activity = { info: JSON.parse(tyInfo), cmd: tyCmd?.params ?? null };
    results.TY_activity.pass = (function () { const i = results.TY_activity.info; return i.count > 0 && i.hasTaskCreate === true && i.hasLocate === true && tyCmd != null && tyCmd.params.scope === 'all' && tyCmd.params.limit === 60; })();

    // ── TGU 标题栏派发防护标识（r56：演练包模拟派发可见——探针 env ZS_ALLOW_FAKE=1） ──
    const guardInfo = await waitForJs(win, probe(`(() => { const b = document.querySelector('.zs-titlebar [data-zs-dispatch-guard]'); return b == null ? null : JSON.stringify({ attr: b.getAttribute('data-zs-dispatch-guard'), text: b.textContent.trim() }); })()`), 12_000, 'TGU 防护标识渲染');
    results.TGU_guard = { info: JSON.parse(guardInfo) };
    results.TGU_guard.pass = JSON.parse(guardInfo).attr === 'fake' && JSON.parse(guardInfo).text.includes('演练·模拟派发');

    // ── TPA 命令面板（r56：Ctrl+K/键盘选择/Esc/IME/legacy 守卫；只导航不执行） ──
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`, true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-palette=hifi]') != null`), 8_000, 'TPA Ctrl+K 打开面板');
    const tpaFocus = await win.webContents.executeJavaScript(probe(`document.querySelector('[data-zs-palette=hifi] input') === document.activeElement`), true);
    await win.webContents.executeJavaScript(probe(`(() => { const input = document.querySelector('[data-zs-palette=hifi] input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '默认房间'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-palette-item=房间]') != null`), 10_000, 'TPA 房间项出现（真实 store）');
    // IME 组合态 Enter 不触发打开（面板保持、路由不动）。
    const hashBeforeEnter = await win.webContents.executeJavaScript(`location.hash`, true);
    await win.webContents.executeJavaScript(probe(`(() => { const input = document.querySelector('[data-zs-palette=hifi] input'); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); return true; })()`), true);
    await sleep(400);
    const tpaImeKept = await win.webContents.executeJavaScript(probe(`JSON.stringify({ open: document.querySelector('[data-zs-palette=hifi]') != null, hashSame: location.hash === ${JSON.stringify(hashBeforeEnter)} })`), true);
    // 组合结束后再 Enter → 打开第一项（默认房间）→ 路由 #/room/。
    await win.webContents.executeJavaScript(probe(`(() => { const input = document.querySelector('[data-zs-palette=hifi] input'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`location.hash.startsWith('#/room/')`), 8_000, 'TPA Enter 导航房间');
    // Esc 关闭；legacy 接管态 Ctrl+K 不打开。
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`, true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-palette=hifi]') != null`), 6_000, 'TPA 再次打开');
    // Esc：派发在**焦点元素**（面板输入框）上——keydown 需到达 React 的目标处理器。
    await win.webContents.executeJavaScript(probe(`(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-palette=hifi]') == null`), 6_000, 'TPA Esc 关闭');
    await win.webContents.executeJavaScript(probe(`(() => { document.body.classList.add('legacy-on'); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true; })()`), true);
    await sleep(350);
    const tpaLegacyKept = await win.webContents.executeJavaScript(probe(`document.querySelector('[data-zs-palette=hifi]') == null`), true);
    await win.webContents.executeJavaScript(probe(`document.body.classList.remove('legacy-on'); true`), true);
    // r57：任务项 hint=真实 taskStatus/runStatus 中文映射（不再「任务 · undefined」）。
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`, true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-palette=hifi]') != null`), 6_000, 'TPA 打开（状态核）');
    await win.webContents.executeJavaScript(probe(`(() => { const input = document.querySelector('[data-zs-palette=hifi] input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '待验收'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    const tpaHint = await waitForJs(win, probe(`(() => { const it = document.querySelector('[data-zs-palette-item=任务]'); return it == null ? null : it.querySelector('.hint')?.textContent ?? ''; })()`), 10_000, 'TPA 任务项出现');
    await win.webContents.executeJavaScript(probe(`(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-palette=hifi]') == null`), 5_000, 'TPA 关闭（状态核）');
    const tpaHintOk = /任务 · (执行中|待你处理|受阻|待验收|已完成|已取消|失败|运行中|排队中|停止中|中断待恢复)/.test(String(tpaHint)) && !String(tpaHint).includes('undefined');
    results.TPA_palette = { focusInPalette: tpaFocus === true, imeKept: JSON.parse(tpaImeKept), legacyGuard: tpaLegacyKept === true, taskHint: tpaHint, taskHintOk: tpaHintOk };
    results.TPA_palette.pass = tpaFocus === true && JSON.parse(tpaImeKept).open === true && JSON.parse(tpaImeKept).hashSame === true && tpaLegacyKept === true && tpaHintOk;

    // ── TLS 搜索既有筛选（r56：作者/日期/会话——search.query 参数逐项实发） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('搜索与收藏'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-library=hifi]') != null`), 10_000, 'TLS 搜索页');
    await win.webContents.executeJavaScript(probe(`(() => { const input = [...document.querySelectorAll('[data-zs-library] input')].find((i) => (i.placeholder || '').includes('搜消息')); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, '待验收'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-library]'); return p != null && p.querySelectorAll('.root-card').length > 0; })()`), 15_000, 'TLS 基线命中');
    // 日期窗：fromDay=今天 → 命中保留；toDay=昨天 → 今日消息全部排除（确定性负例）。
    const today = new Date(); const fmt = (d) => d.toISOString().slice(0, 10);
    const yesterday = new Date(today.getTime() - 86_400_000);
    await win.webContents.executeJavaScript(probe(`(() => { const inputs = [...document.querySelectorAll('[data-zs-library] input[type=date]')]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inputs[1], ${JSON.stringify(fmt(yesterday))}); inputs[1].dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-library]'); const cards = p.querySelectorAll('.root-card'); const empty = [...p.querySelectorAll('.panel')].some((x) => (x.textContent || '').includes('没有命中')); return cards.length === 0 && empty; })()`), 12_000, 'TLS toDay=昨天排除（负例）');
    const tlsNeg = [...sentLog].reverse().find((e) => e.method === 'search.query');
    // 正例按步走（每步等真实查询回屏——避免一批 UI 改动竞态漏筛）：清 toDay → 回基线命中；
    // fromDay=今天 → 命中；会话=convA → 命中；逐步核对实发参数。
    await win.webContents.executeJavaScript(probe(`(() => { const inputs = [...document.querySelectorAll('[data-zs-library] input[type=date]')]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inputs[1], ''); inputs[1].dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-library]'); return p != null && p.querySelectorAll('.root-card').length > 0; })()`), 12_000, 'TLS 清 toDay→基线命中');
    await win.webContents.executeJavaScript(probe(`(() => { const inputs = [...document.querySelectorAll('[data-zs-library] input[type=date]')]; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(inputs[0], ${JSON.stringify(fmt(today))}); inputs[0].dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await sleep(1200);
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-library]'); return p != null && p.querySelectorAll('.root-card').length > 0; })()`), 12_000, 'TLS fromDay=今天命中');
    await win.webContents.executeJavaScript(probe(`(() => { const sel = [...document.querySelectorAll('[data-zs-library] select')].find((s) => [...s.options].some((o) => o.textContent.includes('默认房间'))); if (sel == null) return false; const sset = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; sset.call(sel, 'convA'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-library]'); return p != null && p.querySelectorAll('.root-card').length > 0; })()`), 12_000, 'TLS 会话筛选命中');
    const tlsPos = [...sentLog].reverse().find((e) => e.method === 'search.query');
    results.TLS_filters = { negative: tlsNeg?.params ?? null, positive: tlsPos?.params ?? null };
    results.TLS_filters.pass = tlsNeg != null && tlsNeg.params.toDay === fmt(yesterday)
      && tlsPos != null && tlsPos.params.fromDay === fmt(today) && tlsPos.params.conversationId === 'convA';

    // ── TLL 长历史定位补读（r56：130 条回复→最深回复经 beforeSeq 补读后真实定位） ──
    for (let i = 1; i <= 130; i += 1) {
      await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'thread', projectId: projId, conversationId: 'convA', threadId: th.id }, body: `R56 长历史第 ${i} 条`, intent: 'record_only', mentions: [] } });
    }
    // 最深**回复**（排除锚消息——锚块 id 也是 msg-<id>，初始装载即可见，不能证明补读）。
    const oldestReply = db.prepare('SELECT id, thread_message_seq FROM messages WHERE thread_id = ? AND id != ? ORDER BY thread_message_seq ASC LIMIT 1').get(th.id, anchor.id);
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/thread/${th.id}?message=${oldestReply.id}`)}; true`, true);
    const tllHit = await waitForJs(win, probe(`document.getElementById('msg-' + ${JSON.stringify(oldestReply.id)}) != null`), 40_000, 'TLL 深史回复经补读定位').catch(() => false);
    const tllCount = await waitForJs(win, probe(`(() => { const n = [...document.querySelectorAll('#hifi-root .msg')].length; return n >= 101 ? n : null; })()`), 15_000, 'TLL 补读后消息数').catch(() => -1);
    const tllCountNow = await win.webContents.executeJavaScript(probe(`(() => { const els = [...document.querySelectorAll('#hifi-root .msg')]; return JSON.stringify({ msg: els.length, seq1: document.getElementById('msg-' + ${JSON.stringify(oldestReply.id)}) != null, hash: location.hash, text: (document.querySelector('.thread-nav')?.textContent ?? '').slice(0, 60) }); })()`), true).catch(() => null);
    results.TLL_backfill = { oldestSeq: oldestReply.thread_message_seq, located: tllHit === true, renderedMsgs: tllCount, now: tllCountNow == null ? null : JSON.parse(tllCountNow) };
    results.TLL_backfill.pass = tllHit === true && typeof tllCount === 'number' && tllCount >= 101;

    // ── TTH 线程关注/静音+消息引用/表情（r56：正式命令 thread.subscribe/message.react/引用入草稿） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`), true);
    await win.webContents.executeJavaScript(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('待验收任务')); card?.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('#hifi-root .thread-nav') != null`), 15_000, 'TTH 线程打开');
    await clickBtn(win, `b.textContent === '关注' || b.textContent === '已关注'`, 'TTH 关注按钮');
    await waitForJs(win, probe(`document.querySelector('[data-zs-thread-follow=1]') != null`), 10_000, 'TTH 已关注');
    await clickBtn(win, `b.textContent === '静音' || b.textContent === '已静音'`, 'TTH 静音按钮');
    await waitForJs(win, probe(`document.querySelector('[data-zs-thread-mute=1]') != null`), 10_000, 'TTH 已静音');
    const thSubRow = db.prepare('SELECT followed, muted FROM thread_subscriptions WHERE thread_id = ?').get(th.id);
    // 消息操作：更多菜单 → 引用 → 草稿含引用；表情 👍 → message.react 实发。
    await setArea(win, '');
    await clickBtn(win, `b.title === '更多操作'`, 'TTH 消息更多菜单');
    await sleep(400);
    await clickBtn(win, `b.textContent === '引用'`, 'TTH 引用菜单项');
    const tthQuote = await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); return (ta?.value ?? '').includes('引用消息'); })()`), true);
    const reactBefore = sentLog.filter((e) => e.method === 'message.react').length;
    await clickBtn(win, `b.title.startsWith('表情：轻量反馈')`, 'TTH 表情按钮');
    await waitForJs(win, probe(`(() => window.__zsSentProbe !== undefined)() || true`), 100, 'noop').catch(() => null);
    await sleep(800);
    const reactDelta = sentLog.filter((e) => e.method === 'message.react').length - reactBefore;
    await captureShot(win, 'h3r59-thread-ops.png');
    results.TTH_threadOps = { sub: thSubRow, quoteInserted: tthQuote === true, reactCommands: reactDelta };
    results.TTH_threadOps.pass = thSubRow != null && thSubRow.followed === 1 && thSubRow.muted === 1 && tthQuote === true && reactDelta === 1;

    // ── TDM DM 操作（r56：重命名 CAS/停止三重绑定/继续队列/验收三重身份/归档恢复/导出+目录） ──
    db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run(projId); // DM 自然进 REVIEW（交付 v1）
    const dmC = await daemon.command({ commandId: mkcmd(), method: 'conversation.create', params: { projectId: projId, peerMemberId: 'mA', title: 'R56 DM 操作演练' } });
    const dmConvId = dmC?.data?.conversationId ?? dmC?.conversationId ?? dmC?.data?.conversation?.conversationId;
    await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'dm', projectId: projId, conversationId: dmConvId }, body: 'R56 DM 第一条（验收演练）', intent: 'default', mentions: [] } });
    await daemon.pump();
    const dmTask = db.prepare('SELECT t.id FROM tasks t WHERE t.conversation_id = ? ORDER BY t.rowid DESC LIMIT 1').get(dmConvId);
    db.prepare("UPDATE tasks SET status='REVIEW' WHERE id = ?").run(dmTask.id); // fake 完成链在 review 开启下自然 REVIEW；保险显式（幂等）
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('私信'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-ops=hifi]') != null && document.querySelector('[data-zs-dm-ops=hifi]').textContent.includes('R56 DM 操作演练')`), 15_000, 'TDM DM 页与操作行');
    // ①重命名（revision CAS 通过；列表标题更新）。
    await clickBtn(win, `b.textContent === '重命名'`, 'TDM 重命名按钮');
    await win.webContents.executeJavaScript(probe(`(() => { const input = [...document.querySelectorAll('[data-zs-dm-ops=hifi] input')].find((i) => (i.placeholder || '').includes('会话标题')); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, 'R56 DM 已重命名'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await clickBtn(win, `b.textContent === '保存' && b.closest('[data-zs-dm-ops]') != null`, 'TDM 保存重命名');
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-ops=hifi]').textContent.includes('R56 DM 已重命名')`), 10_000, 'TDM 重命名生效');
    const dmTitleRow = db.prepare('SELECT title FROM conversations WHERE id = ?').get(dmConvId);
    // ②待验收面板（pendingReview 三重身份）→ 验收通过 → 任务 DONE。
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-review=hifi]') != null && document.querySelector('[data-zs-dm-review=hifi]').textContent.includes('待验收交付')`), 12_000, 'TDM 待验收面板');
    await clickBtn(win, `b.textContent === '验收通过' && b.closest('[data-zs-dm-review]') != null`, 'TDM 验收通过');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-dm-review] button')].some((b) => b.textContent === '确认验收')`), 8_000, 'TDM 确认验收框出现');
    await clickBtn(win, `b.textContent === '确认验收'`, 'TDM 确认验收');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('已验收通过'))`), 12_000, 'TDM 验收 toast');
    const dmTaskAfter = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dmTask.id).status;
    // busy 复位在 reloadAll 之后（finally）——toast 出现时按钮可能仍禁用：等按钮可用再点。
    await waitForJs(win, probe(`(() => { const b = [...document.querySelectorAll('[data-zs-dm-ops=hifi] button')].find((x) => x.textContent === '导出 MD'); return b != null && b.disabled === false; })()`), 10_000, 'TDM 操作行按钮可用');
    // ③导出 MD → 文件落盘（exports/<id> 在探针 appDataDir 下）+ 打开目录走白名单（浏览器宿主无 zs.openPath——探针 preload 未暴露，按文件存在断言）。
    await clickBtn(win, `b.textContent === '导出 MD'`, 'TDM 导出 MD');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('已导出 MD'))`), 15_000, 'TDM 导出 toast');
    const exportDirFound = fs.readdirSync(path.join(OUT, 'exports')).filter((d) => fs.existsSync(path.join(OUT, 'exports', d)) && fs.readdirSync(path.join(OUT, 'exports', d)).length > 0);
    // ④归档 → 只读+禁新发；恢复。
    await clickBtn(win, `b.textContent === '归档'`, 'TDM 归档');
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-ops=hifi]').textContent.includes('已归档（只读）')`), 10_000, 'TDM 已归档');
    const dmArchived = db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(dmConvId).archived_at;
    await clickBtn(win, `b.textContent === '取消归档'`, 'TDM 取消归档');
    await waitForJs(win, probe(`!document.querySelector('[data-zs-dm-ops=hifi]').textContent.includes('已归档（只读）')`), 10_000, 'TDM 已恢复');
    await captureShot(win, 'h3r59-dm-ops.png');
    results.TDM_dmOps = { renamed: dmTitleRow?.title === 'R56 DM 已重命名', taskStatusAfterReview: dmTaskAfter, exportDirs: exportDirFound.length, archivedAtNotNull: dmArchived != null };
    results.TDM_dmOps.pass = dmTitleRow?.title === 'R56 DM 已重命名' && dmTaskAfter === 'DONE' && exportDirFound.length >= 1 && dmArchived != null;

    // ── TDM2 返工真实执行链（r58 重写，review-r57 §3：废除手工 v2 注入——页面提交意见→
    //    「意见已记录、尚未执行」→ 显式执行返工 → 同 task 新 run/turn（输入含意见）→
    //    新交付由真实 worker 自然产生 → 再次验收 DONE；全程零 INSERT/UPDATE 交付） ──
    const mkDmReviewFixture = async (label) => {
      const dmC2 = await daemon.command({ commandId: mkcmd(), method: 'conversation.create', params: { projectId: projId, peerMemberId: 'mA', title: label } });
      const cid = dmC2?.data?.conversationId ?? dmC2?.conversationId;
      await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'dm', projectId: projId, conversationId: cid }, body: label + '（返工演练）', intent: 'default', mentions: [] } });
      await daemon.pump();
      const tid = db.prepare('SELECT id FROM tasks WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1').get(cid).id;
      await untilTaskSettled(db, tid);
      return { cid, tid };
    };
    const dmRw = await mkDmReviewFixture('R59 DM 返工真实链');
    const rwRunsBefore = db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get(dmRw.tid).c;
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#/dm/' + dmRw.cid)}; true`, true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-review=hifi]') != null`), 15_000, 'TDM2 待验收面板');
    await clickBtn(win, `b.textContent === '要求返工' && b.closest('[data-zs-dm-review]') != null`, 'TDM2 要求返工');
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-review=hifi] textarea') != null`), 8_000, 'TDM2 返工意见框');
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('[data-zs-dm-review=hifi] textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'R58 返工意见：请补充结论一节'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await clickBtn(win, `b.textContent === '提交返工意见'`, 'TDM2 提交返工');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('尚未执行'))`), 12_000, 'TDM2 返工 toast（尚未执行）');
    // 验收与执行分离：意见入账、任务 ACTIVE、零新派发；页面呈现「意见已记录、尚未执行」。
    const rwTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dmRw.tid).status;
    const rwDeliveries = db.prepare('SELECT revision, review_status FROM task_deliveries WHERE task_id = ? ORDER BY revision').all(dmRw.tid);
    const rwNoteRecorded = db.prepare("SELECT count(*) c FROM domain_events WHERE task_id = ? AND payload_json LIKE ?").get(dmRw.tid, '%R58 返工意见：请补充结论一节%').c;
    await daemon.pump(); // 分离验证：泵在无显式执行时零推进
    const rwRunsAfterRecord = db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get(dmRw.tid).c;
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-rework=hifi]') != null && document.querySelector('[data-zs-dm-rework=hifi]').textContent.includes('尚未执行') && document.querySelector('[data-zs-dm-rework=hifi]').textContent.includes('R58 返工意见')`), 12_000, 'TDM2 返工待执行面板（含意见）');
    // r58：忙态必须已释放（r56 教训——toast 会替换、按钮禁用时 click 是静默 no-op）。
    await waitForJs(win, probe(`(() => { const b = document.querySelector('[data-zs-dm-rework-run]'); return b != null && b.disabled === false; })()`), 12_000, 'TDM2 执行返工按钮可用（忙态已释放）');
    // 显式执行返工 → outbox → 同 task 新 run/turn → 真实 worker 自然产 v2 → 回待验收。
    await clickBtn(win, `b.textContent === '执行返工' && b.closest('[data-zs-dm-rework]') != null`, 'TDM2 执行返工');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('返工执行已入队'))`), 12_000, 'TDM2 执行入队 toast');
    const rwEnqueuedEvt = db.prepare("SELECT count(*) c FROM domain_events WHERE kind = 'task.reworkEnqueued' AND task_id = ?").get(dmRw.tid).c;
    await daemon.pump();
    await untilTaskSettled(db, dmRw.tid, 12_000); // 新 turn 收口：v2 pending、任务回 REVIEW（自然产生）
    const rwRunsAfter = db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get(dmRw.tid).c;
    // v2 上屏（5s 轻量刷新）→ 验收通过 → DONE。
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-review=hifi]') != null && document.querySelector('[data-zs-dm-review=hifi]').textContent.includes('v2')`), 15_000, 'TDM2 新交付 v2 上屏（真实产生）');
    await clickBtn(win, `b.textContent === '验收通过' && b.closest('[data-zs-dm-review]') != null`, 'TDM2 二次验收');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-dm-review] button')].some((b) => b.textContent === '确认验收')`), 8_000, 'TDM2 确认框');
    await clickBtn(win, `b.textContent === '确认验收'`, 'TDM2 确认');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('已验收通过'))`), 12_000, 'TDM2 验收 toast');
    const rwTaskAfter = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dmRw.tid).status;
    const rwV2 = db.prepare('SELECT revision, review_status FROM task_deliveries WHERE task_id = ? ORDER BY revision').all(dmRw.tid); // 验收后读取（v2=accepted）
    await captureShot(win, 'h3r59-rework-done.png');
    results.TDM2_rework = {
      taskAfterRework: rwTask, deliveries: rwDeliveries, noteRecorded: rwNoteRecorded,
      runsAfterRecord: rwRunsAfterRecord, runsBefore: rwRunsBefore, runsAfter: rwRunsAfter,
      deliveriesAfter: rwV2, reworkEnqueued: rwEnqueuedEvt, taskAfterAccept: rwTaskAfter,
    };
    results.TDM2_rework.pass = rwTask === 'ACTIVE' && rwNoteRecorded >= 1
      && rwRunsAfterRecord === rwRunsBefore // 记录意见零派发
      && rwEnqueuedEvt >= 1 && rwRunsAfter === rwRunsBefore + 1 // 显式执行=同 task 恰一个新 run
      && rwV2.length === 2 && rwV2[1].revision === 2 && rwV2[1].review_status === 'accepted'
      && rwV2[0].review_status === 'changes_requested' // v1 验收记录保留
      && rwTaskAfter === 'DONE';

    // ── TDM3 跨会话操作框反例（r57 §4：A 开框→切 B→框作废零提交——命令与两侧 DB 双核） ──
    const dmA = await mkDmReviewFixture('R57 DM-A 跨会话');
    const dmB = await mkDmReviewFixture('R57 DM-B 跨会话');
    const reviewCmdBefore = sentLog.filter((e) => e.method === 'task.review').length;
    const renameCmdBefore = sentLog.filter((e) => e.method === 'conversation.rename').length;
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#/dm/' + dmA.cid)}; true`, true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-review=hifi]') != null`), 15_000, 'TDM3 A 面板');
    await clickBtn(win, `b.textContent === '验收通过' && b.closest('[data-zs-dm-review]') != null`, 'TDM3 A 打开验收框');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-dm-review] button')].some((b) => b.textContent === '确认验收')`), 8_000, 'TDM3 A 确认框出现');
    // A 打开重命名框（同屏）。
    await clickBtn(win, `b.textContent === '重命名'`, 'TDM3 A 打开重命名框');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-dm-ops=hifi] input')].some((i) => (i.placeholder || '').includes('会话标题'))`), 8_000, 'TDM3 A 重命名输入框');
    await win.webContents.executeJavaScript(probe(`(() => { const input = [...document.querySelectorAll('[data-zs-dm-ops=hifi] input')].find((i) => (i.placeholder || '').includes('会话标题')); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, 'AUDIT-NEW-TITLE-FOR-A'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    // 切 B：两个框都必须作废消失（旧实现保留并可提交——审 v4 反例）。
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#/dm/' + dmB.cid)}; true`, true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-review=hifi]') != null && [...document.querySelectorAll('[data-zs-dm-review] button')].every((b) => b.textContent !== '确认验收')`), 12_000, 'TDM3 切 B 后 A 验收框作废');
    const renameGoneAfterSwitch = await win.webContents.executeJavaScript(probe(`![...document.querySelectorAll('[data-zs-dm-ops=hifi] input')].some((i) => (i.placeholder || '').includes('会话标题'))`), true);
    await sleep(800);
    const reviewCmdDelta = sentLog.filter((e) => e.method === 'task.review').length - reviewCmdBefore;
    const renameCmdDelta = sentLog.filter((e) => e.method === 'conversation.rename').length - renameCmdBefore;
    const taskA = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dmA.tid).status;
    const taskB = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dmB.tid).status;
    const titleA = db.prepare('SELECT title FROM conversations WHERE id = ?').get(dmA.cid).title;
    const titleB = db.prepare('SELECT title FROM conversations WHERE id = ?').get(dmB.cid).title;
    await captureShot(win, 'h3r59-cross-session.png');
    results.TDM3_crossSession = { reviewCmdDelta, renameCmdDelta, renameGoneAfterSwitch: renameGoneAfterSwitch === true, taskA, taskB, titleA, titleB };
    results.TDM3_crossSession.pass = reviewCmdDelta === 0 && renameCmdDelta === 0 && renameGoneAfterSwitch === true && taskA === 'REVIEW' && taskB === 'REVIEW' && titleA === 'R57 DM-A 跨会话' && titleB === 'R57 DM-B 跨会话';

    // ── TDM4 页面版本漂移反例（r59 P1，review-r58 §2）：面板冻结在 v1 返工——另一路合法
    //    推进到 v2 意见——页面点击携带 v1 完整身份 → 服务端 STALE 拒绝（不改绑 v2），
    //    零 outbox 副作用；刷新后面板如实显示 v2。再证状态分列（执行中主标题）+合法执行。 ──
    const dmDrift = await mkDmReviewFixture('R59 DM 漂移反例');
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#/dm/' + dmDrift.cid)}; true`, true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-review=hifi]') != null`), 15_000, 'TDM4 待验收面板');
    await clickBtn(win, `b.textContent === '要求返工' && b.closest('[data-zs-dm-review]') != null`, 'TDM4 要求返工');
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-review=hifi] textarea') != null`), 8_000, 'TDM4 意见框');
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('[data-zs-dm-review=hifi] textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'TDM4 意见A（针对 v1）'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await clickBtn(win, `b.textContent === '提交返工意见'`, 'TDM4 提交意见A');
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-rework=hifi]') != null && document.querySelector('[data-zs-dm-rework=hifi]').getAttribute('data-zs-dm-rework-state') === 'recorded' && document.querySelector('[data-zs-dm-rework=hifi]').textContent.includes('尚未执行')`), 12_000, 'TDM4 v1 面板（recorded/尚未执行）');
    const driftSnap = (rev) => {
      const d = db.prepare('SELECT id, revision, manifest_hash, run_id FROM task_deliveries WHERE task_id = ? AND revision = ?').get(dmDrift.tid, rev);
      return { taskId: dmDrift.tid, deliveryId: d.id, deliveryRevision: d.revision, manifestHash: d.manifest_hash, sourceRunId: d.run_id };
    };
    // 冻结渲染（conversation.list 延迟 6s）→ 另一路执行 v1 + 对 v2 提交意见B → 面板仍显示 v1。
    slowList = true;
    const rExec = await daemon.command({ commandId: mkcmd(), method: 'task.executeRework', params: driftSnap(1) });
    if (rExec.ok !== true) throw new Error('TDM4 另一路执行 v1 失败');
    await daemon.pump();
    await untilTaskSettled(db, dmDrift.tid, 12_000);
    const v2row = db.prepare('SELECT id, manifest_hash FROM task_deliveries WHERE task_id = ? AND revision = 2').get(dmDrift.tid);
    await daemon.command({ commandId: mkcmd(), method: 'task.review', params: { taskId: dmDrift.tid, deliveryId: v2row.id, deliveryRevision: 2, manifestHash: v2row.manifest_hash, decision: 'changes_requested', note: 'TDM4 意见B（针对 v2）' } });
    const outboxBeforeStaleClick = db.prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:' || ? || ':redispatch*'`).get(dmDrift.tid).c;
    // 面板仍冻结在 v1（延迟窗口内）——点击携带 v1 完整身份。
    await waitForJs(win, probe(`(() => { const b = document.querySelector('[data-zs-dm-rework-run]'); return b != null && b.disabled === false; })()`), 10_000, 'TDM4 执行返工按钮可用');
    const panelStillV1 = await win.webContents.executeJavaScript(probe(`document.querySelector('[data-zs-dm-rework=hifi]').textContent.includes('意见A') && document.querySelector('[data-zs-dm-rework=hifi]').textContent.includes('v1')`), true);
    await clickBtn(win, `b.textContent === '执行返工' && b.closest('[data-zs-dm-rework]') != null`, 'TDM4 冻结面板点击（v1 快照）');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('执行返工被拒'))`), 12_000, 'TDM4 STALE 拒绝 toast');
    const staleCmd = [...sentLog].reverse().find((e) => e.method === 'task.executeRework');
    const outboxAfterStaleClick = db.prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:' || ? || ':redispatch*'`).get(dmDrift.tid).c;
    const driftTaskStatus = db.prepare('SELECT status FROM tasks WHERE id = ?').get(dmDrift.tid).status;
    // 解除冻结：面板刷新为 v2 意见B（recorded）。
    slowList = false;
    await sleep(6500); // 延迟响应落地+拒绝路径 reloadAll
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-rework=hifi]') != null && document.querySelector('[data-zs-dm-rework=hifi]').textContent.includes('意见B') && document.querySelector('[data-zs-dm-rework=hifi]').textContent.includes('v2') && document.querySelector('[data-zs-dm-rework=hifi]').getAttribute('data-zs-dm-rework-state') === 'recorded'`), 15_000, 'TDM4 刷新后 v2 面板（意见B）');
    // 合法执行 v2 → 状态分列（executing 主标题）→ 自然 v3。
    await clickBtn(win, `b.textContent === '执行返工' && b.closest('[data-zs-dm-rework]') != null`, 'TDM4 合法执行 v2');
    await waitForJs(win, probe(`document.querySelector('[data-zs-dm-rework=hifi]') != null && document.querySelector('[data-zs-dm-rework=hifi]').getAttribute('data-zs-dm-rework-state') === 'executing' && document.querySelector('[data-zs-dm-rework=hifi]').textContent.includes('返工执行中')`), 12_000, 'TDM4 执行中主标题（分列）');
    await daemon.pump();
    await untilTaskSettled(db, dmDrift.tid, 12_000);
    const driftRuns = db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get(dmDrift.tid).c;
    const driftDeliveries = db.prepare('SELECT revision, review_status FROM task_deliveries WHERE task_id = ? ORDER BY revision').all(dmDrift.tid);
    // 同任务跨视图一致性（P3）：task.get 与页面/库同源——状态=REVIEW（v3 待验收）。
    const tGet = await daemon.command({ commandId: mkcmd(), method: 'task.get', params: { taskId: dmDrift.tid } });
    await captureShot(win, 'h3r59-rework-drift.png');
    results.TDM4_reworkDrift = {
      panelStillV1: panelStillV1 === true,
      staleCmdSnapshot: staleCmd == null ? null : { deliveryRevision: staleCmd.params.deliveryRevision, hasFullIdentity: staleCmd.params.deliveryId != null && staleCmd.params.manifestHash != null && staleCmd.params.sourceRunId != null },
      staleZeroOutbox: outboxAfterStaleClick === outboxBeforeStaleClick,
      taskStillActiveAfterStale: driftTaskStatus === 'ACTIVE',
      afterV2ExecRuns: driftRuns,
      deliveries: driftDeliveries,
      crossViewState: tGet?.data?.task?.status ?? tGet?.task?.status ?? null,
    };
    results.TDM4_reworkDrift.pass = panelStillV1 === true
      && staleCmd != null && staleCmd.params.deliveryRevision === 1 && results.TDM4_reworkDrift.staleCmdSnapshot.hasFullIdentity === true
      && results.TDM4_reworkDrift.staleZeroOutbox === true && driftTaskStatus === 'ACTIVE'
      && driftRuns === 3 && driftDeliveries.length === 3 && driftDeliveries[2].revision === 3
      && results.TDM4_reworkDrift.crossViewState === 'REVIEW';

    // ── TRC 恢复检查（r56：崩溃标记→门禁+自动弹一次；对账 notStarted 正式链；确认继续） ──
    await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r56 恢复演练任务（崩溃时在途）', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] } });
    const lastRoomTask = db.prepare("SELECT id FROM tasks WHERE conversation_id = 'convA' ORDER BY rowid DESC LIMIT 1").get();
    db.prepare("INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, budget_json) VALUES ('run_r56_rc', ?, 'convA', NULL, 'DIRECT', 0, 'RUNNING', '{}')").run(lastRoomTask.id);
    db.prepare("INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES ('turn_r56_rc', 'run_r56_rc', 'convA', NULL, 'mA', 'direct.work', 'RUNNING', 'task:' || ?, 1, 1)").run(lastRoomTask.id);
    daemon.recover(); // applyRecovery：turn→UNKNOWN、run→INTERRUPTED、门禁落下
    const rcTurn = db.prepare("SELECT status FROM agent_turns WHERE id = 'turn_r56_rc'").get().status;
    const rcGate = db.prepare("SELECT value FROM daemon_state WHERE key = 'dispatch_gate'").get()?.value;
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('恢复检查'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-recovery=hifi]') != null && document.querySelector('[data-zs-recovery=hifi]').textContent.includes('UNKNOWN')`), 12_000, 'TRC 恢复面板+UNKNOWN 行');
    // 对账 notStarted（人工分离）：表单+风险确认+note → recovery.reconcile 正式链 → turn FAILED。
    await clickBtn(win, `b.textContent === '对账…'`, 'TRC 对账按钮');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-recovery=hifi] select')].length > 0`), 8_000, 'TRC 对账表单');
    await win.webContents.executeJavaScript(probe(`(() => { const sel = document.querySelector('[data-zs-recovery=hifi] select'); const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, 'notStarted'); sel.dispatchEvent(new Event('change', { bubbles: true })); const cb = document.querySelector('[data-zs-recovery=hifi] input[type=checkbox]'); if (cb != null) { cb.click(); } const ta = document.querySelector('[data-zs-recovery=hifi] textarea'); const tset = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; tset.call(ta, 'R56 探针人工分离：启动窗口外崩溃，确认未启动'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await clickBtn(win, `b.textContent === '提交对账'`, 'TRC 提交对账');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('对账已提交'))`), 12_000, 'TRC 对账 toast');
    const rcTurnAfter = db.prepare("SELECT status FROM agent_turns WHERE id = 'turn_r56_rc'").get().status;
    await captureShot(win, 'h3r59-recovery.png'); // 弹窗打开态（UNKNOWN 行+确认继续按钮可见）
    // 确认继续派发（dispatch.resume{confirm:true}）→ 门禁 open。
    await clickBtn(win, `b.textContent === '确认继续派发'`, 'TRC 确认继续');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('已确认继续'))`), 12_000, 'TRC 确认继续 toast');
    const rcGateAfter = db.prepare("SELECT value FROM daemon_state WHERE key = 'dispatch_gate'").get()?.value;
    await clickBtn(win, `b.textContent === '关闭' && b.closest('[data-zs-recovery=hifi]') != null`, 'TRC 关闭面板');
    results.TRC_recovery = { turnBefore: rcTurn, gateHeld: rcGate, turnAfterReconcile: rcTurnAfter, gateAfterResume: rcGateAfter };
    results.TRC_recovery.pass = rcTurn === 'UNKNOWN' && rcGate === 'held' && rcTurnAfter === 'FAILED' && rcGateAfter === 'open';

    // ── T8 预览不遮挡标题栏（基线 + r56 宽度/展开/Esc/引用） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('#hifi-root textarea') != null`), 10_000, 'T8 回房间');
    await win.webContents.executeJavaScript(`(async () => { const input = document.querySelector('#hifi-root input[type=file]'); const file = new File([Uint8Array.from(Array.from('R55-PREVIEW-TOP-CHECK').map((c) => c.charCodeAt(0)))], 'r59-preview.md', { type: 'text/markdown' }); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return 'OK'; })()`, true);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('r59-preview') && c.textContent.includes('v1'))`), 15_000, 'T8 附件 ready');
    await win.webContents.executeJavaScript(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('r59-preview')); const btn = [...(chip?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('预览')); btn?.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]') != null`), 10_000, '预览面板打开');
    const paneTop = await win.webContents.executeJavaScript(probe(`(() => { const pane = document.querySelector('.preview-pane'); return pane != null ? getComputedStyle(pane).top : null; })()`), true);
    // r56：阅读宽度 窄/宽/全屏展开（Esc 退出）+「引用」到当前输入框（房间草稿）。
    await clickBtn(win, `b.textContent === '宽' && b.closest('[data-zs-preview=hifi]') != null`, 'T8 加宽');
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]').getAttribute('data-zs-preview-width') === 'wide'`), 8_000, 'T8 宽度=wide');
    await clickBtn(win, `b.textContent === '展开' && b.closest('[data-zs-preview=hifi]') != null`, 'T8 全屏展开');
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]').getAttribute('data-zs-preview-width') === 'full'`), 8_000, 'T8 展开=full');
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`, true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]').getAttribute('data-zs-preview-width') === 'normal'`), 8_000, 'T8 Esc 退出展开');
    await setArea(win, '');
    await clickBtn(win, `b.textContent === '引用' && b.closest('[data-zs-preview=hifi]') != null`, 'T8 引用到输入框');
    const t8Quote = await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); return (ta?.value ?? '').includes('引用「r59-preview.md」'); })()`), true);
    results.T8_previewTop = { top: paneTop, widthQuote: { quoteInserted: t8Quote === true } };
    results.T8_previewTop.pass = paneTop === '38px' && t8Quote === true;
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, '关闭预览');

    // ── TZ 预览连续开关与资源收拢（r58 P4：开关×3 无叠加残留；关闭后全局键仍活） ──
    let tzPaneCounts = [];
    for (let i = 0; i < 3; i += 1) {
      await win.webContents.executeJavaScript(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('r59-preview')); const btn = [...(chip?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('预览')); if (btn == null) return false; btn.click(); return true; })()`), true);
      await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]') != null`), 10_000, `TZ 预览打开 ${i + 1}`);
      tzPaneCounts.push(await win.webContents.executeJavaScript(probe(`document.querySelectorAll('[data-zs-preview=hifi]').length`), true));
      await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, `TZ 关闭预览 ${i + 1}`);
      await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]') == null`), 8_000, `TZ 关闭后无残留 ${i + 1}`);
    }
    // 关闭后全局键（Ctrl+K）不被吞——键盘焦点返回主界面。
    await win.webContents.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); true`, true);
    const tzPaletteAfterClose = await waitForJs(win, probe(`document.querySelector('[data-zs-palette=hifi]') != null`), 6_000, 'TZ 关闭后 Ctrl+K 仍可打开面板');
    await win.webContents.executeJavaScript(probe(`(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-palette=hifi]') == null`), 6_000, 'TZ 面板关闭');
    const tzFocusBack = await win.webContents.executeJavaScript(probe(`(() => { const el = document.activeElement; return el == null || el === document.body || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON'; })()`), true);
    results.TZ_previewToggles = { paneCounts: tzPaneCounts, paletteAfterClose: tzPaletteAfterClose === true, focusBack: tzFocusBack === true };
    results.TZ_previewToggles.pass = tzPaneCounts.every((n) => n === 1) && tzPaletteAfterClose === true && tzFocusBack === true;

    // ── T9 legacy 接管对照（基线：经设置页「远程访问变更」入口） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('设置与帮助'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-settings=hifi]') != null`), 12_000, 'T9 设置页');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-settings=hifi] button')].some((b) => (b.textContent || '').includes('变更远程设置'))`), 15_000, 'T9 接管入口渲染（remote 事实装载后）');
    await clickBtn(win, `b.textContent.includes('变更远程设置')`, 'T9 原界面接管入口');
    await waitForJs(win, probe(`document.body.classList.contains('legacy-on')`), 15_000, 'legacy 接管');
    await sleep(1500);
    const tbDuringLegacy = await win.webContents.executeJavaScript(probe(`(() => { const bar = document.querySelector('.zs-titlebar'); const btns = bar != null ? bar.querySelectorAll('.zs-winbtn').length : 0; const visible = bar != null && bar.getBoundingClientRect().height > 0; return JSON.stringify({ visible, btns }); })()`), true);
    await captureShot(win, 'h3r59-legacy-titlebar.png');
    await win.webContents.executeJavaScript(probe(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('⌂ 返回新界面')); if (b == null) return false; b.click(); return true; })()`), true);
    await waitForJs(win, probe(`!document.body.classList.contains('legacy-on') && document.body.classList.contains('hifi-on')`), 15_000, '返回新界面');
    results.T9_legacy = { during: JSON.parse(tbDuringLegacy), returned: true };
    results.T9_legacy.pass = JSON.parse(tbDuringLegacy).visible === true && JSON.parse(tbDuringLegacy).btns === 3;

    // ── P 原型同窗对照截图（基线 + /activity） ──
    const protoShots = {};
    if (protoServer != null) {
      const pwin = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { contextIsolation: true } });
      try {
        for (const [name, hash] of [['proto-tasks.png', '#/tasks?scope=project&projectId=p1'], ['proto-members.png', '#/members'], ['proto-settings.png', '#/settings?projectId=p1'], ['proto-activity.png', '#/activity'], ['proto-library.png', '#/library']]) {
          await Promise.race([pwin.loadURL(`http://127.0.0.1:${PORT_PROTO}/index.html`), sleep(15_000).then(() => { throw new Error('prototype loadURL 超时'); })]);
          await sleep(1200);
          await pwin.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}; true`, true);
          await sleep(1500);
          await captureShot(pwin, name);
          protoShots[name] = fs.existsSync(path.join(OUT, name));
        }
      } catch (e) { protoShots.error = String(e.message ?? e); }
      finally { try { await pwin.destroy(); } catch { /* 已关 */ } }
    }
    results.P_prototypeShots = protoShots;

    results.pass = results.T1_titlebar.pass === true && results.T2_resize.pass === true && results.TM_mention.pass === true
      && results.TH_m0Hint.pass === true && results.TC_titlebarConn.pass === true && results.T3_members.pass === true
      && results.TP_pending.pass === true && results.T5_settings.pass === true && results.T6_files.pass === true
      && results.T7_boardScope.pass === true && results.TA_artifacts.pass === true && results.TL_library.pass === true
      && results.TY_activity.pass === true && results.TGU_guard.pass === true && results.TPA_palette.pass === true
      && results.TLS_filters.pass === true && results.TLL_backfill.pass === true && results.TTH_threadOps.pass === true
      && results.TW1_welcome.pass === true && results.TDM_dmOps.pass === true && results.TDM2_rework.pass === true
      && results.TDM3_crossSession.pass === true && results.TDM4_reworkDrift.pass === true && results.TRC_recovery.pass === true
      && results.T8_previewTop.pass === true && results.TZ_previewToggles.pass === true
      && results.T9_legacy.pass === true;
    fs.writeFileSync(path.join(OUT, 'h3r59-result.json'), JSON.stringify(results, null, 2));
    console.log('[r59] pass=' + results.pass);
  } catch (e) {
    results.error = String(e.message ?? e);
    try { results.debugText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 400)', true); results.debugHash = await win.webContents.executeJavaScript('location.hash', true); } catch { /* 已关 */ }
    try { results.sentLogTail = sentLog.slice(-40); } catch { /* 未初始化 */ }
    try { results.toastText = await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .toast')].map((t) => t.textContent).join(' | ')`), true); } catch { /* 已关 */ }
    fs.writeFileSync(path.join(OUT, 'h3r59-result.json'), JSON.stringify(results, null, 2));
    console.error('[r59] FAIL: ' + results.error);
  } finally {
    try { await win.destroy(); } catch { /* 已关 */ }
    await daemon.close().catch(() => {});
    for (const sv of [server, protoServer]) { if (sv == null) continue; try { sv.closeAllConnections?.(); } catch { /* 旧 Node */ } sv.close(); }
    setTimeout(() => app.exit(results.pass === true ? 0 : 3), 1500).unref?.();
    app.exit(results.pass === true ? 0 : 3);
  }
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
