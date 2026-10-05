'use strict';
/**
 * 第五十四轮 H3 页面+无边框标题栏探针（review-r54 §3/§4）：真实 React 页面 × 正式 daemon ×
 * fake 库。覆盖：
 *  T1 自绘标题栏：React 版渲染（portal #zs-titlebar）/三键/拖动区/常驻样式/body.zs-frameless
 *     偏移（hifi-root top=38）；zsWindow 窄桥接线（探针 stub 记录动作——minimize/toggle/close）。
 *  T2 窗口缩放（900×620）：标题栏按钮不出视口、内容不横向溢出；恢复 1440×900。
 *  T3 成员管理：项目/房间分列、协调者标识、停用↔启用（真实 member.setEnabled+回读）、
 *     协调者停用被正式链拒绝（错误如实上屏）。
 *  T4 待我处理：REVIEW 任务（有 pending 交付→定位→线程详情；无交付→定位禁用+如实说明）、
 *     待确认提醒「确认执行」（reminder.confirm 正式链→occurrence dispatched→刷新后消失）。
 *  T5 设置：启动时打开的项目保存**回读核对**；显示仓库状态切换落库。
 *  T6 文件与 Git：项目文本文件 project.file.read 只读快照；非白名单无预览按钮；Git 标签
 *     真实分支/未跟踪/diff 事实（change/stat/truncated 分列）+「在原界面执行 Git 操作」直达按钮。
 *  T7 看板范围：全部可访问项目（board.view scope=all 实发）。
 *  T8 预览面板不遮挡标题栏（preview-pane top=38）。
 *  T9 legacy 接管对照：搜索与收藏→原界面；标题栏仍可见可控；「⌂ 返回新界面」可回。
 *  P  原型同窗对照截图（hifi-prototype/dist 经本机 http——布局/阅读空间对照，非像素等价）。
 * 产物 dist/desktop/review-r54/（h3r54-result.json + 截图）。
 * 运行：./node_modules/.bin/electron scripts/verify-hifi-h3-r54.cjs。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'dist/desktop/review-r54');
fs.mkdirSync(OUT, { recursive: true });
const PORT_HIFI = 48245;
const PORT_PROTO = 48246;
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
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

async function buildDaemon() {
  const entry = path.join(OUT, 'daemon-entry-r54.ts');
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
  const command = (env: { commandId: string; method: string; params: unknown }) => dispatchDaemonCommand(deps as never, { protocolVersion: 1, commandId: env.commandId, method: env.method, params: env.params } as never);
  return { db, command, async pump() { await new DispatchWorker({ db, adapter, leaseOwner: 'w-r54', appDataDir } as never).runOnce(); }, async close() { await adapter.closeAllSessions().catch(() => {}); db.close(); } };
}
`, 'utf8');
  const bundle = path.join(OUT, 'real-daemon-r54.cjs');
  await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, sourcemap: false, external: ['better-sqlite3'], loader: { '.ts': 'ts' } });
  const workerOut = path.join(OUT, 'parse-worker-r54.cjs');
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
  if (shot == null) { console.error('[r54] 截图超时：' + name); return; }
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
}

async function main() {
  console.error('[r54] step: buildDaemon...');
  const daemon = await buildDaemon();
  console.error('[r54] step: daemon ready');
  console.error('[r54] step: listen...');
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT_HIFI, '127.0.0.1', () => { server.off('error', rej); res(); }); });
  console.error('[r54] step: hifi server up');
  if (protoServer != null) await new Promise((res, rej) => { protoServer.once('error', rej); protoServer.listen(PORT_PROTO, '127.0.0.1', () => { protoServer.off('error', rej); res(); }); });

  const projDir = path.join(OUT, 'proj-r54');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# r54 H3 样本\n', 'utf8');
  const git = (args) => spawnSync('git', ['-C', projDir, ...args], { encoding: 'utf8', timeout: 30_000 });
  git(['init', '-q']);
  git(['-c', 'user.email=probe@zs.local', '-c', 'user.name=zs-probe', 'add', 'README.md']);
  git(['-c', 'user.email=probe@zs.local', '-c', 'user.name=zs-probe', 'commit', '-q', '-m', 'r54-init']);
  fs.appendFileSync(path.join(projDir, 'README.md'), 'r54 追加行（制造未暂存差异）' + String.fromCharCode(10), 'utf8'); // 提交后追加→未暂存差异
  fs.writeFileSync(path.join(projDir, 'notes-r54.md'), '# 项目笔记\nr54 只读快照样本\n', 'utf8');
  fs.writeFileSync(path.join(projDir, 'logo-r54.png'), Buffer.from('89504e470d0a1a0a', 'hex'), 'utf8'); // 二进制占位（白名单外）

  await daemon.command({ commandId: 'cmd-r54-set', method: 'app.settings.set', params: { key: 'ui.autoOpenProjectPath', value: projDir } });
  await daemon.command({ commandId: 'cmd-r54-open', method: 'project.open', params: { path: projDir } });
  const db = daemon.db;
  const projId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?, 'Guide A','agent',1)").run(projId);
  db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mB',?, 'Guide B','agent',1)").run(projId);
  db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '默认房间', 'mA')").run(projId);
  db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA'),('roomA','mB')").run();
  db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
  const mkcmd = () => 'cmd-r54-' + Math.random().toString(36).slice(2, 10);
  // 夹具：任务线程（完成后转 REVIEW+pending 交付）+ 无交付 REVIEW 任务 + 待确认提醒。
  const r0 = await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r54 待验收任务', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] } });
  if (r0.ok !== true) throw new Error('夹具派发失败');
  await daemon.pump();
  const anchor = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r54 待验收任务%'").get();
  const th = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor.id);
  db.prepare("UPDATE tasks SET status='REVIEW' WHERE id = ?").run(th.root_task_id);
  db.prepare("INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES ('dlv_r54_1', ?, 2, ?, '[]', '[]', '[]', 'pending')").run(th.root_task_id, 'b'.repeat(64)); // auto_deliver v1(not_required) 已占——待验收=v2
  const r1 = await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r54 无交付 REVIEW 任务', intent: 'default', mentions: [{ kind: 'member', memberId: 'mB' }] } });
  await daemon.pump();
  const anchor2 = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r54 无交付 REVIEW 任务%'").get();
  const th2 = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor2.id);
  db.prepare("UPDATE tasks SET status='REVIEW' WHERE id = ?").run(th2.root_task_id);
  const now = Date.now();
  db.prepare("INSERT INTO reminders (id, owner_member_id, conversation_id, thread_id, task_id, timezone, schedule_json, status, title, owner_user, created_at, updated_at) VALUES ('rem_r54_1', 'mA', 'convA', NULL, NULL, 'Asia/Shanghai', ?, 'active', 'r54 每日跟进', 'u_local', ?, ?)").run(JSON.stringify({ kind: 'daily', at: '09:00' }), now, now);
  db.prepare("INSERT INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome, missed_count, fired_at) VALUES ('rem_r54_1', ?, 'fired', 'awaiting_confirmation', 0, ?)").run(now, now);

  const results = { scope: 'R54 H3：标题栏+成员+待办+设置+Files/Git+看板范围（真实命令链）' };
  const sentLog = [];
  ipcMain.handle('zs-command', async (_e, env) => { sentLog.push({ method: env.method, params: env.params }); return daemon.command(env); });
  // zsWindow 探针 stub（记录动作——探针不真关窗；真实主窗窄 IPC 在打包产物验证器里走真链）。
  const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
const acts = [];
contextBridge.exposeInMainWorld('zs', {
  command: async (env) => ipcRenderer.invoke('zs-command', env),
  pickFolder: async () => null, openPath: async () => {}, onDisconnect: () => {}, onReconnected: () => {}, onDemoStatus: () => {},
});
contextBridge.exposeInMainWorld('zsWindow', {
  minimize: async () => { acts.push('minimize'); return { ok: true }; },
  toggleMaximize: async () => { acts.push('toggleMaximize'); return { ok: true, maximized: true }; },
  close: async () => { acts.push('close'); return { ok: true }; },
  getState: async () => { acts.push('getState'); return { ok: true, state: { maximized: false, fullScreen: false, focused: true } }; },
  onStateChange: (cb) => { acts.push('subscribe'); return () => {}; },
  __recorded: () => acts,
});`;
  const preloadPath = path.join(OUT, 'real-preload-r54.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });

  try {
    console.error('[r54] step: loadURL hifi...');
    await win.loadURL(`http://127.0.0.1:${PORT_HIFI}/index.html`);
    console.error('[r54] step: hifi loaded');
    console.error('[r54] step: wait hifi-on...');
    await waitForJs(win, `document.body.classList.contains('hifi-on') ? 'hifi' : null`, 15_000, 'hifi 壳挂载');
    console.error('[r54] step: hifi-on ok');

    // ── T1 标题栏 ──
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

    // ── T2 窗口缩放（小窗布局） ──
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

    // ── T3 成员管理 ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('成员管理'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-members=hifi]') != null && document.querySelector('[data-zs-members=hifi]').textContent.includes('Guide B')`), 15_000, '成员列表');
    const memInfo0 = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-members=hifi]'); return JSON.stringify({ coord: p.textContent.includes('协调者'), roomList: p.textContent.includes('默认房间'), runtimeCol: p.textContent.includes('runtime') }); })()`), true);
    // 停用 Guide B → 回读（按钮变「启用」）；再启用回去。
    await clickBtn(win, `b.textContent === '停用' && b.closest('[data-zs-members]') != null && b.closest('div[style]').textContent.includes('Guide B')`, '停用 Guide B');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-members=hifi]'); return p != null && [...p.querySelectorAll('button')].some((b) => b.textContent === '启用' && b.closest('div[style]').textContent.includes('Guide B')); })()`), 15_000, 'Guide B 已停用（回读）');
    const bEnabled = db.prepare('SELECT enabled FROM project_members WHERE id = ?').get('mB').enabled;
    await clickBtn(win, `b.textContent === '启用' && b.closest('div[style]').textContent.includes('Guide B')`, '启用 Guide B');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-members=hifi]'); return p != null && [...p.querySelectorAll('button')].some((b) => b.textContent === '停用' && b.closest('div[style]').textContent.includes('Guide B')); })()`), 15_000, 'Guide B 已启用（回读）');
    // 协调者停用 → 正式链拒绝（错误 toast 如实）。
    await clickBtn(win, `b.textContent === '停用' && b.closest('div[style]').textContent.includes('Guide A')`, '停用协调者（应被拒）');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('协调者'))`), 12_000, '协调者拒绝 toast');
    const aEnabled = db.prepare('SELECT enabled FROM project_members WHERE id = ?').get('mA').enabled;
    await captureShot(win, 'h3r54-members.png');
    results.T3_members = { listInfo: JSON.parse(memInfo0), guideBDisabled: bEnabled === 0, coordinatorStillEnabled: aEnabled === 1, coordinatorRefused: true };
    results.T3_members.pass = JSON.parse(memInfo0).coord === true && JSON.parse(memInfo0).roomList === true && bEnabled === 0 && aEnabled === 1;

    // ── T4 待我处理 ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('待我处理'))?.click(), true`), true);
    // mine.pending 的 reviewTasks 不含任务标题（DTO 事实）——按列型断言。
    await waitForJs(win, probe(`document.querySelector('[data-zs-pending=hifi]') != null && document.querySelector('[data-zs-pending=hifi]').textContent.includes('待验收任务 task_')`), 15_000, '待办：待验收任务');
    const pd = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-pending=hifi]'); const rows = [...p.querySelectorAll('button')]; const noDeliveryDisabled = rows.find((b) => b.textContent === '定位' && b.disabled); const confirmBtn = rows.find((b) => b.textContent === '确认执行'); return JSON.stringify({ hasNoDelivery: p.textContent.includes('无可批准交付'), noDeliveryDisabled: noDeliveryDisabled != null, hasConfirm: confirmBtn != null, reminderTitle: p.textContent.includes('r54 每日跟进') }); })()`), true);
    // 定位（有交付的 REVIEW 任务）→ 线程详情。
    await clickBtn(win, `b.textContent === '定位' && !b.disabled && b.closest('[data-zs-pending]') != null && b.closest('div[style]').textContent.includes('交付 v2')`, '待办定位（有交付）');
    await waitForJs(win, probe(`location.hash.startsWith('#/thread/') && location.hash.includes('tab=task')`), 12_000, '待办定位→线程详情');
    results.T4_pendingLocate = { toDetail: true };
    // 回待办 → 确认执行（reminder.confirm 正式链）→ 刷新后该待确认消失。
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('待我处理'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-pending=hifi]') != null && document.querySelector('[data-zs-pending=hifi]').textContent.includes('r54 每日跟进')`), 12_000, '回待办（提醒行渲染完成）');
    await clickBtn(win, `b.textContent === '确认执行'`, '确认执行提醒');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('已确认'))`), 15_000, '确认执行 toast');
    const occOutcome = db.prepare("SELECT outcome FROM reminder_occurrences WHERE reminder_id = 'rem_r54_1'").get().outcome;
    await sleep(800);
    const reminderGone = (await win.webContents.executeJavaScript(probe(`!document.querySelector('[data-zs-pending=hifi]').textContent.includes('r54 每日跟进')`), true)) === true;
    await captureShot(win, 'h3r54-pending.png');
    results.T4_pending = { info: JSON.parse(pd), confirmDispatched: occOutcome === 'dispatched', reminderGoneAfterReload: reminderGone };
    results.T4_pending.pass = JSON.parse(pd).noDeliveryDisabled === true && JSON.parse(pd).hasConfirm === true && occOutcome === 'dispatched' && reminderGone === true;

    // ── T5 设置（保存回读核对） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('设置与帮助'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-settings=hifi]') != null && document.querySelector('[data-zs-settings=hifi]').textContent.includes('启动时打开的项目')`), 12_000, '设置页（应用分区）');
    const savedPath = projDir.replace(/\\/g, '\\\\');
    await win.webContents.executeJavaScript(probe(`(() => { const input = [...document.querySelectorAll('[data-zs-settings=hifi] input')].find((i) => (i.placeholder || '').includes('重启生效')); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(savedPath)} + '-changed'); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await clickBtn(win, `b.textContent === '保存' && b.closest('.panel') != null && b.closest('.panel').textContent.includes('启动时打开的项目')`, '保存启动目录');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .toast')].some((t) => (t.textContent || '').includes('回读一致'))`), 12_000, '保存回读一致 toast');
    const readBack = db.prepare("SELECT value FROM daemon_state WHERE key = 'app:setting:ui.autoOpenProjectPath'").get().value;
    await clickBtn(win, `b.textContent === '隐藏' && b.closest('.panel').textContent.includes('仓库状态')`, '隐藏仓库状态');
    await sleep(700);
    const repoVisible = db.prepare("SELECT value FROM daemon_state WHERE key = 'app:setting:repoStatus.visible'").get()?.value ?? null;
    await captureShot(win, 'h3r54-settings.png');
    results.T5_settings = { savedValue: readBack, repoVisible, saveRoundTripOk: readBack === savedPath + '-changed' && repoVisible === 'false' };
    results.T5_settings.pass = results.T5_settings.saveRoundTripOk;

    // ── T6 文件与 Git ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('文件与 Git'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-files=hifi]') != null && document.querySelector('[data-zs-files=hifi]').textContent.includes('notes-r54.md')`), 15_000, 'Files 项目文件');
    // 文本快照：notes-r54.md 预览 → project.file.read 内容上屏；png 无预览按钮。
    await clickBtn(win, `b.textContent === '预览' && b.closest('.chip') != null && b.closest('.chip').textContent.includes('notes-r54.md')`, '项目文件快照预览');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return p != null && p.textContent.includes('r54 只读快照样本'); })()`), 12_000, '快照内容上屏');
    const pngNoPreview = await win.webContents.executeJavaScript(probe(`(() => { const chip = [...document.querySelectorAll('[data-zs-files=hifi] .chip')].find((c) => c.textContent.includes('logo-r54.png')); return chip != null && ![...chip.querySelectorAll('button')].some((b) => b.textContent === '预览'); })()`), true);
    const readFileCmds = sentLog.filter((e) => e.method === 'project.file.read').length;
    // Git 标签：真实分支/未跟踪/diff 事实 + 原界面直达按钮。
    await clickBtn(win, `b.textContent === 'Git 诊断'`, 'Git 标签');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return p != null && /分支\\s*(main|master)/.test(p.textContent) && p.textContent.includes('未跟踪'); })()`), 20_000, 'Git 真实状态');
    await clickBtn(win, `b.textContent === '未暂存 diff'`, '未暂存 diff');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return p != null && p.textContent.includes('+1'); })()`), 15_000, 'diff 统计上屏');
    const gitFacts = await win.webContents.executeJavaScript(probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return JSON.stringify({ added: p.textContent.includes('added') || p.textContent.includes('未跟踪内容'), legacyEntry: [...p.querySelectorAll('button')].some((b) => b.textContent.includes('在原界面执行 Git 操作')), patchPath: p.textContent.includes('README.md') }); })()`), true);
    await captureShot(win, 'h3r54-files-git.png');
    results.T6_files = { snapshotRendered: true, readFileCommands: readFileCmds, pngNoPreview: pngNoPreview === true, git: JSON.parse(gitFacts) };
    results.T6_files.pass = readFileCmds >= 1 && pngNoPreview === true && JSON.parse(gitFacts).legacyEntry === true && JSON.parse(gitFacts).patchPath === true;

    // ── T7 看板范围（scope=all 实发） ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('任务看板'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-board=hifi]') != null`), 10_000, '看板挂载');
    await win.webContents.executeJavaScript(probe(`(() => { const sel = document.querySelector('[data-zs-board=hifi] select'); if (sel == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set; setter.call(sel, 'all'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`), true);
    await sleep(900);
    const allCmd = [...sentLog].reverse().find((e) => e.method === 'board.view');
    await captureShot(win, 'h3r54-titlebar-board.png');
    results.T7_boardScope = { lastBoardCmd: allCmd?.params ?? null, pass: allCmd != null && allCmd.params.scope === 'all' };

    // ── T8 预览面板不遮挡标题栏（先回房间主池——看板页没有输入区文件框）──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`), true);
    await waitForJs(win, probe(`document.querySelector('#hifi-root textarea') != null`), 10_000, 'T8 回房间');
    const r8 = await daemon.command({ commandId: mkcmd(), method: 'attachment.uploadText', params: { conversationId: 'convA', filename: 'r54-preview.md', content: 'R54 预览遮挡核对' } });
    await win.webContents.executeJavaScript(`(async () => { const input = document.querySelector('#hifi-root input[type=file]'); const file = new File([Uint8Array.from(Array.from('R54-PREVIEW-TOP-CHECK').map((c) => c.charCodeAt(0)))], 'r54-preview.md', { type: 'text/markdown' }); const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return 'OK'; })()`, true);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('r54-preview') && c.textContent.includes('v1'))`), 15_000, 'T8 附件 ready');
    await win.webContents.executeJavaScript(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('r54-preview')); const btn = [...(chip?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('预览')); btn?.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]') != null`), 10_000, '预览面板打开');
    const paneTop = await win.webContents.executeJavaScript(probe(`(() => { const pane = document.querySelector('.preview-pane'); return pane != null ? getComputedStyle(pane).top : null; })()`), true);
    results.T8_previewTop = { top: paneTop, pass: paneTop === '38px' };
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, '关闭预览');

    // ── T9 legacy 接管对照：标题栏仍可见可控；可返回 ──
    await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('搜索与收藏'))?.click(), true`), true);
    await waitForJs(win, probe(`document.body.classList.contains('legacy-on')`), 15_000, 'legacy 接管');
    await sleep(1500);
    const tbDuringLegacy = await win.webContents.executeJavaScript(probe(`(() => { const bar = document.querySelector('.zs-titlebar'); const btns = bar != null ? bar.querySelectorAll('.zs-winbtn').length : 0; const visible = bar != null && bar.getBoundingClientRect().height > 0; const legacyTop = getComputedStyle(document.getElementById('app')).height; return JSON.stringify({ visible, btns, legacyHeight: legacyTop }); })()`), true);
    await captureShot(win, 'h3r54-legacy-titlebar.png');
    await win.webContents.executeJavaScript(probe(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('⌂ 返回新界面')); if (b == null) return false; b.click(); return true; })()`), true); // 该按钮挂 body（不在 #hifi-root）
    await waitForJs(win, probe(`!document.body.classList.contains('legacy-on') && document.body.classList.contains('hifi-on')`), 15_000, '返回新界面');
    results.T9_legacy = { during: JSON.parse(tbDuringLegacy), returned: true };
    results.T9_legacy.pass = JSON.parse(tbDuringLegacy).visible === true && JSON.parse(tbDuringLegacy).btns === 3;

    // ── P 原型同窗对照截图（布局/阅读空间——非像素等价） ──
    const protoShots = {};
    if (protoServer != null) {
      const pwin = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { contextIsolation: true } });
      try {
        for (const [name, hash] of [['proto-tasks.png', '#/tasks?scope=project&projectId=p1'], ['proto-members.png', '#/members'], ['proto-settings.png', '#/settings?projectId=p1']]) {
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

    results.pass = results.T1_titlebar.pass === true && results.T2_resize.pass === true && results.T3_members.pass === true
      && results.T4_pending.pass === true && results.T5_settings.pass === true && results.T6_files.pass === true
      && results.T7_boardScope.pass === true && results.T8_previewTop.pass === true && results.T9_legacy.pass === true;
    fs.writeFileSync(path.join(OUT, 'h3r54-result.json'), JSON.stringify(results, null, 2));
    console.log('[r54] pass=' + results.pass);
  } catch (e) {
    results.error = String(e.message ?? e);
    try { results.debugText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 400)', true); results.debugHash = await win.webContents.executeJavaScript('location.hash', true); } catch { /* 已关 */ }
    fs.writeFileSync(path.join(OUT, 'h3r54-result.json'), JSON.stringify(results, null, 2));
    console.error('[r54] FAIL: ' + results.error);
  } finally {
    try { await win.destroy(); } catch { /* 已关 */ }
    await daemon.close().catch(() => {});
    // http keep-alive 连接会让 close() 无限等待（R54 实测挂起）——先断连接再关，并有界退出。
    for (const sv of [server, protoServer]) { if (sv == null) continue; try { sv.closeAllConnections?.(); } catch { /* 旧 Node */ } sv.close(); }
    setTimeout(() => app.exit(results.pass === true ? 0 : 3), 1500).unref?.();
    app.exit(results.pass === true ? 0 : 3);
  }
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
