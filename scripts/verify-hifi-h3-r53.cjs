'use strict';
/**
 * 第五十三轮 H3 第一批页面探针：BoardPage/FilesPage/SettingsPage（真实 React 页面 × 正式
 * daemon × fake 库）——三个新换装页接**正式命令**的事实核验：
 *  H1 看板：board.view 聚合上屏（列位/卡片）；点卡 → #task= 定位 → 线程详情路由。
 *  H2 文件与 Git：files.view 四类分列（项目文件/托管附件/草稿/交付）——附件芯片可开共享预览；
 *     Git 标签=真实仓库状态（fixture 先 git init+commit：分支/未跟踪分列；diff 按钮）。
 *  H3 设置：app.settings.get/set 真实往返（保存 toast）；remote.config.get 实际事实；
 *     **打开定位**：粘贴 #task=<实体ID> → 正式 deepLink.resolve → 线程详情（T6 粘贴入口闭环）。
 *  截图 ×3（board/files/settings）。产物 dist/desktop/review-r53/（h3-*.png / h3-result.json）。
 * 运行：./node_modules/.bin/electron scripts/verify-hifi-h3-r53.cjs。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'dist/desktop/review-r53');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 48244;
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

async function buildDaemon() {
  const entry = path.join(OUT, 'daemon-entry-h3.ts');
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
  return { db, command, async pump() { await new DispatchWorker({ db, adapter, leaseOwner: 'w-r53h3', appDataDir } as never).runOnce(); }, async close() { await adapter.closeAllSessions().catch(() => {}); db.close(); } };
}
`, 'utf8');
  const bundle = path.join(OUT, 'real-daemon-h3.cjs');
  await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, sourcemap: false, external: ['better-sqlite3'], loader: { '.ts': 'ts' } });
  const workerOut = path.join(OUT, 'parse-worker-h3.cjs');
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
  const ok = await win.webContents.executeJavaScript(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((b) => ${matcher}); if (b == null) return false; b.click(); return true; })()`), true);
  if (ok !== true) throw new Error('按钮未找到：' + label);
}
async function typeInput(win, text) {
  await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
  await sleep(160);
}

async function main() {
  const daemon = await buildDaemon();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const projDir = path.join(OUT, 'proj-h3');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# r53 H3 样本\n', 'utf8');
  // 真实 git 仓库（Git 标签真实状态 + 未跟踪分列）：init + 首次提交 + 一个未跟踪文件。
  const git = (args) => spawnSync('git', ['-C', projDir, ...args], { encoding: 'utf8', timeout: 30_000 });
  git(['init', '-q']);
  git(['-c', 'user.email=probe@zs.local', '-c', 'user.name=zs-probe', 'add', 'README.md']);
  git(['-c', 'user.email=probe@zs.local', '-c', 'user.name=zs-probe', 'commit', '-q', '-m', 'r53-h3-init']);
  fs.writeFileSync(path.join(projDir, 'untracked-note.txt'), 'untracked\n', 'utf8');

  await daemon.command({ commandId: 'cmd-h3-set', method: 'app.settings.set', params: { key: 'ui.autoOpenProjectPath', value: projDir } });
  await daemon.command({ commandId: 'cmd-h3-open', method: 'project.open', params: { path: projDir } });
  const db = daemon.db;
  const projId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?, 'Guide A','agent',1)").run(projId);
  db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '默认房间', 'mA')").run(projId);
  db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA')").run();
  db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
  const mkcmd = () => 'cmd-h3-' + Math.random().toString(36).slice(2, 10);
  // 夹具：任务线程（看板卡）+ 带附件的记录消息（Files 托管附件）。
  const r0 = await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r53 H3 任务根', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] } });
  if (r0.ok !== true) throw new Error('夹具派发失败');
  await daemon.pump();
  const anchor = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r53 H3 任务根%'").get();
  const th = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor.id);
  const up = await daemon.command({ commandId: mkcmd(), method: 'attachment.uploadText', params: { conversationId: 'convA', filename: 'h3-附件.md', content: 'H3 Files 样本' } });
  await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'thread', projectId: projId, conversationId: 'convA', threadId: th.id }, body: 'r53 H3 附件消息', intent: 'record_only', mentions: [], attachmentRefs: [up.data.attachmentId] } });

  const results = { scope: 'R53 H3 第一批：看板/文件Git/设置 真实命令链' };
  const { BrowserWindow, ipcMain } = require('electron');
  const sentLog = [];
  ipcMain.handle('zs-command', async (_e, env) => { sentLog.push({ method: env.method, params: env.params }); return daemon.command(env); });
  const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zs', {
  command: async (env) => ipcRenderer.invoke('zs-command', env),
  pickFolder: async () => null, openPath: async () => {}, onDisconnect: () => {}, onReconnected: () => {}, onDemoStatus: () => {},
});`;
  const preloadPath = path.join(OUT, 'real-preload-h3.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });

  try {
    await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    await waitForJs(win, `document.body.classList.contains('hifi-on') ? 'hifi' : null`, 15_000, 'hifi 壳挂载');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .side-item')].some((b) => b.textContent.includes('任务看板'))`), 15_000, '侧栏（自动项目）');

    // ── 看板：board.view 上屏 + 卡片定位 ──
    await clickBtn(win, `b.textContent.includes('任务看板') && b.classList.contains('side-item')`, '任务看板侧栏项');
    await waitForJs(win, probe(`document.querySelector('[data-zs-board=hifi]') != null`), 10_000, '看板页挂载');
    await waitForJs(win, probe(`(() => { const board = document.querySelector('[data-zs-board=hifi]'); return board != null && board.textContent.includes('r53 H3 任务根'); })()`), 20_000, '看板卡上屏（board.view）');
    const boardColumn = await win.webContents.executeJavaScript(probe(`document.querySelector('[data-zs-board-column]')?.getAttribute('data-zs-board-column')`), true);
    const boardCmdCount = sentLog.filter((e) => e.method === 'board.view').length;
    await captureShot(win, 'h3-board.png');
    await win.webContents.executeJavaScript(probe(`(() => { const card = [...document.querySelectorAll('[data-zs-board=hifi] .root-card')].find((c) => c.textContent.includes('r53 H3 任务根')); card?.click(); return true; })()`), true);
    await waitForJs(win, probe(`location.hash.startsWith('#/thread/') && location.hash.includes('tab=task')`), 12_000, '看板卡→线程详情');
    // 定位成功由上方 waitForJs 门控（失败即抛出）——此处记录事实即可。
    results.H3_board = { cardVisible: true, column: boardColumn, boardViewCommands: boardCmdCount, locateToDetail: true };
    results.H3_board.pass = boardCmdCount >= 1 && boardColumn != null;

    // ── 文件与 Git：files.view 四类 + 附件预览 + Git 状态 ──
    await clickBtn(win, `b.textContent.includes('文件与 Git') && b.classList.contains('side-item')`, '文件与 Git 侧栏项');
    await waitForJs(win, probe(`document.querySelector('[data-zs-files=hifi]') != null`), 10_000, 'Files 页挂载');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return p != null && p.textContent.includes('h3-附件.md') && p.textContent.includes('untracked-note.txt') && p.textContent.includes('项目文件'); })()`), 20_000, 'Files 四类分列（files.view）');
    const filesCmdCount = sentLog.filter((e) => e.method === 'files.view').length;
    await captureShot(win, 'h3-files.png');
    // 附件芯片 → 共享预览（真内容）。
    await win.webContents.executeJavaScript(probe(`(() => { const chip = [...document.querySelectorAll('[data-zs-files=hifi] .chip')].find((c) => c.textContent.includes('h3-附件.md')); const btn = [...(chip?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('预览')); btn?.click(); return true; })()`), true);
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-preview=hifi] pre')].some((p) => (p.textContent || '').includes('H3 Files 样本'))`), 15_000, 'Files→共享预览真内容');
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, '关闭预览');
    // Git 标签：真实仓库（分支 + 未跟踪分列）。
    await clickBtn(win, `b.textContent === 'Git 诊断'`, 'Git 诊断标签');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-files=hifi]'); return p != null && /分支\\s*(main|master)/.test(p.textContent) && p.textContent.includes('未跟踪'); })()`), 20_000, 'Git 真实状态（分支+未跟踪）');
    const gitStatusCount = sentLog.filter((e) => e.method === 'git.status').length;
    results.H3_files = { filesViewCommands: filesCmdCount, previewFromFiles: true, gitStatusCommands: gitStatusCount, pass: filesCmdCount >= 1 && gitStatusCount >= 1 };

    // ── 设置：get/set 往返 + 打开定位（#task= 粘贴闭环）──
    await clickBtn(win, `b.textContent.includes('设置与帮助') && b.classList.contains('side-item')`, '设置侧栏项');
    await waitForJs(win, probe(`document.querySelector('[data-zs-settings=hifi]') != null`), 10_000, '设置页挂载');
    await waitForJs(win, probe(`(() => { const p = document.querySelector('[data-zs-settings=hifi]'); return p != null && p.textContent.includes('远程访问') && (p.textContent.includes('仅本机') || p.textContent.includes('局域网')); })()`), 15_000, 'remote.config 实际事实上屏');
    const settingsGetCount = sentLog.filter((e) => e.method === 'app.settings.get').length;
    const remoteGetCount = sentLog.filter((e) => e.method === 'remote.config.get').length;
    // 打开定位：粘贴 #task=<实体ID> → 线程详情。
    await win.webContents.executeJavaScript(probe(`(() => { const input = [...document.querySelectorAll('[data-zs-settings=hifi] input')].find((i) => (i.placeholder || '').includes('#task=')); if (input == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify('#task=' + th.root_task_id)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await clickBtn(win, `b.textContent === '打开定位'`, '打开定位按钮');
    await waitForJs(win, probe(`location.hash.startsWith('#/thread/') && location.hash.includes('tab=task')`), 12_000, '设置→打开定位→线程详情');
    const resolveCount = sentLog.filter((e) => e.method === 'deepLink.resolve').length;
    await captureShot(win, 'h3-settings-deeplink.png');
    results.H3_settings = { settingsGetCommands: settingsGetCount, remoteGetCommands: remoteGetCount, pasteDeepLinkToDetail: true, deepLinkResolveCommands: resolveCount, pass: settingsGetCount >= 1 && remoteGetCount >= 1 && resolveCount >= 1 };

    results.pass = results.H3_board.pass === true && results.H3_files.pass === true && results.H3_settings.pass === true;
    fs.writeFileSync(path.join(OUT, 'h3-result.json'), JSON.stringify(results, null, 2));
    console.log('[r53-h3] pass=' + results.pass);
  } catch (e) {
    results.error = String(e.message ?? e);
    try { results.debugText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 400)', true); results.debugHash = await win.webContents.executeJavaScript('location.hash', true); } catch { /* 已关 */ }
    fs.writeFileSync(path.join(OUT, 'h3-result.json'), JSON.stringify(results, null, 2));
    console.error('[r53-h3] FAIL: ' + results.error);
  } finally {
    try { await win.destroy(); } catch { /* 已关 */ }
    await daemon.close().catch(() => {});
    server.close();
    app.exit(results.pass === true ? 0 : 3);
  }
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
  if (shot == null) { console.error('[r53-h3] 截图超时：' + name); return; }
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
