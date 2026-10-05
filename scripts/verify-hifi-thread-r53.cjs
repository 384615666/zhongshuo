'use strict';
/**
 * 第五十三轮 H2 页面审计（review-r52 §2–§4/§6）：实际 React 页面 × 正式 daemon（esbuild 真源）
 * × fake 库。三个 P1 修复的页面级实证 + 预览断言收紧：
 *  B1 PPT 视觉宿主死锁修复：合法样本**真实渲染**——真舞台（data-zs-pptx-stage）有子节点、
 *     visual-state=done、页数=样本实际页数、翻页内容变化；渲染器模块确被请求。
 *  B2 阻断负对照（验证器自证）：服务端 503 掉 pptx-renderer 模块 → 同一判据必须落在
 *     failed+舞台零子节点——证明 B1 断言不能被降级提示/外层容器冒充。
 *  B3 上传中移除的幽灵引用（review §3 复现序列）：芯片消失之外——下一条真实信封不带、
 *     message_attachments 零链接；切走再回不复活（hydrate）。
 *  B4 等待期编辑+新增附件的清算（review §4）：按住 message.submit 回执期间改正文/传新附件
 *     → 放行后：正文保留（代次变）、已发 ref 剥离、新附件保留；下一条信封只带新资源；
 *     落库身份逐条核对（旧资源恰一次、不重带）。
 *  B5 未知重试成功的清算：冻结信封重发成功后其 refs 剥离；等待期新附件保留；下一条不重带。
 *  B6 收紧断言：PDF canvas 实际像素（非默认尺寸）、Word shadow 实内容（非仅 style 节点）、
 *     图片 naturalWidth/Height 逐项对账（data-zs-image-decode=ok）。
 *  截图：PPT 视觉真渲染后的预览面板 + 线程详情。
 * 运行：./node_modules/.bin/electron scripts/verify-hifi-thread-r53.cjs；产物 dist/desktop/review-r53/。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'dist/desktop/review-r53');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 48243;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
// 负对照开关：true 时对 pptx-renderer 模块返回 503（阻断渲染器装载——其余文件不受影响）。
let blockPptxRenderer = false;
const server = http.createServer((req, res) => {
  const rel = req.url.split('?')[0].replace(/^\/+/, '') || 'index.html';
  if (blockPptxRenderer && rel.includes('pptx-renderer')) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('blocked-by-negative-control'); return; }
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
  const command = (env: { commandId: string; method: string; params: unknown }) => dispatchDaemonCommand(deps as never, { protocolVersion: 1, commandId: env.commandId, method: env.method, params: env.params } as never);
  return { db, command, async pump() { await new DispatchWorker({ db, adapter, leaseOwner: 'w-r53', appDataDir } as never).runOnce(); }, async close() { await adapter.closeAllSessions().catch(() => {}); db.close(); } };
}
`, 'utf8');
  const bundle = path.join(OUT, 'real-daemon.cjs');
  await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, sourcemap: false, external: ['better-sqlite3'], loader: { '.ts': 'ts' } });
  const fsx = require('fs');
  const workerOut = path.join(OUT, 'parse-worker.cjs');
  await build({ entryPoints: [path.join(root, 'src/daemon/parseWorker.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: workerOut, sourcemap: false, logLevel: 'silent', loader: { '.ts': 'ts' } });
  const cmapsSrc = path.join(root, 'node_modules', 'pdfjs-dist', 'cmaps');
  if (fsx.existsSync(cmapsSrc) && !fsx.existsSync(path.join(OUT, 'cmaps'))) fsx.cpSync(cmapsSrc, path.join(OUT, 'cmaps'), { recursive: true });
  process.env.ZS_PARSE_WORKER = workerOut;
  return require(bundle).makeDaemon(OUT);
}

async function waitForJs(win, iife, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.race([
      win.webContents.executeJavaScript(iife, true).catch(() => null),
      sleep(6000).then(() => null),
    ]);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时：' + label);
    await sleep(200);
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
async function pickRecordIntent(win) {
  await clickBtn(win, `b.getAttribute('aria-label') === '本次运行设置'`, '本次运行设置');
  await sleep(350);
  await clickBtn(win, `b.textContent.includes('仅记录')`, '仅记录菜单项');
  await sleep(250);
}
async function sendCurrent(win, label) {
  await clickBtn(win, `/保存记录|发送/.test(b.textContent) && b.textContent.length <= 6`, label);
}
async function pagePickFile(win, name, mime, bytesExpr) {
  return await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#hifi-root input[type=file]');
    if (input == null) return 'NO_INPUT';
    const bytes = ${bytesExpr};
    const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
    const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'OK';
  })()`, true);
}
const chipExists = (win, name) => win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes(${JSON.stringify(name)}))`), true);
async function openPreviewOf(win, filename) {
  const clicked = await win.webContents.executeJavaScript(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes(${JSON.stringify(filename)})); if (chip == null) return false; const btn = [...chip.querySelectorAll('button')].find((b) => b.textContent.includes('预览')); if (btn == null) return false; btn.click(); return true; })()`), true);
  if (clicked !== true) throw new Error('预览按钮未找到：' + filename);
  await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]') != null`), 10_000, `预览面板 ${filename}`);
}

async function main() {
  const daemon = await buildDaemon();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  const projDir = path.join(OUT, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# r53 审计样本\n', 'utf8');
  await daemon.command({ commandId: 'cmd-set-remember-r53', method: 'app.settings.set', params: { key: 'ui.autoOpenProjectPath', value: projDir } });
  await daemon.command({ commandId: 'cmd-open-r53', method: 'project.open', params: { path: projDir } });
  const db = daemon.db;
  const projId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?, 'Guide A','agent',1)").run(projId);
  db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '默认房间', 'mA')").run(projId);
  db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA')").run();
  db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
  const mkcmd = () => 'cmd-' + Math.random().toString(36).slice(2, 10);

  const results = { scope: 'R53 页面审计：PPT死锁修复+移除幽灵引用+等待期/重试清算+收紧断言' };
  const { BrowserWindow, ipcMain } = require('electron');
  const sentLog = [];
  const holds = { 'attachment.uploadText': { enabled: false, queue: [] }, 'message.submit': { enabled: false, queue: [] } };
  const enableHold = (method) => { holds[method].enabled = true; };
  const releaseHeld = (method, n = 1) => { for (let i = 0; i < n; i += 1) { const r = holds[method].queue.shift(); if (r != null) r(); } };
  const disableHold = (method) => { holds[method].enabled = false; releaseHeld(method, holds[method].queue.length); };
  let rejectNextFlag = false;
  ipcMain.handle('zs-command', async (_e, env) => {
    sentLog.push({ method: env.method, params: env.params, commandId: env.commandId });
    if (rejectNextFlag && env.method === 'message.submit') { rejectNextFlag = false; throw new Error('TRANSPORT_DISCONNECTED(受控)'); }
    const h = holds[env.method];
    if (h != null && h.enabled) await new Promise((r) => h.queue.push(r));
    return daemon.command(env);
  });
  const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zs', {
  command: async (env) => ipcRenderer.invoke('zs-command', env),
  pickFolder: async () => null, openPath: async () => {}, onDisconnect: () => {}, onReconnected: () => {}, onDemoStatus: () => {},
});`;
  const preloadPath = path.join(OUT, 'real-preload.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });

  /** 消息的信封（按正文定位）与落库附件 id 集合。 */
  const envOf = (bodyLike) => [...sentLog].reverse().find((e) => e.method === 'message.submit' && JSON.stringify(e.params).includes(bodyLike));
  const linksOfMsg = (sqlLike, notLike) => {
    const row = notLike != null
      ? db.prepare('SELECT id FROM messages WHERE body_json LIKE ? AND body_json NOT LIKE ?').get(`%${sqlLike}%`, `%${notLike}%`)
      : db.prepare('SELECT id FROM messages WHERE body_json LIKE ?').get(`%${sqlLike}%`);
    if (row == null) return null;
    return db.prepare('SELECT a.id, a.source_name FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id = ?').all(row.id);
  };
  const artifactBy = (name) => db.prepare('SELECT id FROM artifacts WHERE source_name = ?').get(name);

  try {
    // 夹具线程（任务线程——audience 正常；发送一律走「仅记录」保持零派发）。
    const mkThread = async (body) => {
      const r = await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body, intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] } });
      if (r.ok !== true) throw new Error('夹具派发失败');
      await daemon.pump();
      const a = db.prepare('SELECT id FROM messages WHERE body_json LIKE ?').get('%' + body + '%');
      return db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(a.id);
    };
    const thA = await mkThread('r53 线程 A 根消息');

    await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    await waitForJs(win, `document.body.classList.contains('hifi-on') ? 'hifi' : null`, 15_000, 'hifi 壳挂载');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .side-item')].some((b) => b.textContent.includes('默认房间'))`), 15_000, '首启自动项目');
    await clickBtn(win, `b.textContent.includes('默认房间') && b.classList.contains('side-item')`, '默认房间');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('线程 A 根消息'))`), 20_000, '主池线程卡');
    await win.webContents.executeJavaScript(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('线程 A 根消息')); card?.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('#hifi-root textarea') != null`), 10_000, '线程输入区');

    // ── B3 上传中移除的幽灵引用：信封与落库双重负例（review §3 复现序列） ──
    enableHold('attachment.uploadText');
    await pagePickFile(win, 'remove-me.md', 'text/markdown', `new Uint8Array([0x52,0x45,0x4d,0x4f,0x56,0x45])`);
    await sleep(300);
    const removedClick = await win.webContents.executeJavaScript(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((c) => c.textContent.includes('remove-me')); if (chip == null) return 'NO_CHIP'; chip.querySelector('button')?.click(); return 'REMOVED'; })()`), true);
    await sleep(200);
    releaseHeld('attachment.uploadText', 1);
    disableHold('attachment.uploadText');
    await sleep(700);
    const chipGone = (await chipExists(win, 'remove-me')) === false;
    await typeInto(win, 'R53-REMOVE-SEND');
    await pickRecordIntent(win);
    await sendCurrent(win, 'B3 发送（移除后）');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('R53-REMOVE-SEND'))`), 20_000, 'B3 消息上屏');
    const b3Env = envOf('R53-REMOVE-SEND');
    const b3Refs = (b3Env?.params?.attachmentRefs ?? []);
    const rmArt = artifactBy('remove-me.md');
    const b3Links = linksOfMsg('R53-REMOVE-SEND');
    // 切走再回（hydrate 重建芯片）：已移除资源不得复活。
    await clickBtn(win, `b.textContent.includes('返回主池')`, 'B3 返回主池');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('线程 A 根消息'))`), 10_000, '主池（B3）');
    await win.webContents.executeJavaScript(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('线程 A 根消息')); card?.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('#hifi-root textarea') != null`), 10_000, '回线程（B3）');
    await sleep(600);
    const notRevived = (await chipExists(win, 'remove-me')) === false;
    results.B3_removeGhost = {
      removedClick, chipGone,
      envRefs: b3Refs,
      artifactUploaded: rmArt != null, // 上传确实发生（如实）——但绝不随消息落库
      msgLinks: b3Links,
      notRevivedAfterRemount: notRevived,
      pass: removedClick === 'REMOVED' && chipGone && b3Refs.length === 0 && rmArt != null && (b3Links ?? []).length === 0 && notRevived,
    };

    // ── B4 等待期编辑+新增附件的清算（review §4 路径一：确定成功） ──
    await pagePickFile(win, 'settle-1.md', 'text/markdown', `new Uint8Array([0x53,0x31])`);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('settle-1') && c.textContent.includes('v1'))`), 15_000, 'settle-1 ready');
    await typeInto(win, 'R53-SETTLE-ONE');
    enableHold('message.submit');
    await pickRecordIntent(win);
    await sendCurrent(win, 'B4 发送（回执按住）');
    await sleep(400); // 信封已冻结、回执扣住——等待期编辑正文+新增附件。
    await typeInto(win, 'R53-SETTLE-ONER53-APPEND');
    await pagePickFile(win, 'settle-2.md', 'text/markdown', `new Uint8Array([0x53,0x32])`);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('settle-2') && c.textContent.includes('v1'))`), 15_000, '等待期 settle-2 ready');
    releaseHeld('message.submit', 1);
    disableHold('message.submit');
    await waitForJs(win, probe(`(() => { const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')]; return chips.some((c) => c.textContent.includes('settle-2')) && !chips.some((c) => c.textContent.includes('settle-1')); })()`), 20_000, 'B4 清算：旧剥离/新保留');
    const b4BodyKept = await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); return ta != null && ta.value.includes('R53-APPEND'); })()`), true);
    const b4FirstLinks = linksOfMsg('R53-SETTLE-ONE', 'R53-APPEND'); // NOT LIKE 排除第二条（正文含前缀）
    const s1Art = artifactBy('settle-1.md');
    const s2Art = artifactBy('settle-2.md');
    // 第二条（仅记录）：应只带 settle-2。
    await pickRecordIntent(win);
    await sendCurrent(win, 'B4 第二条');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('R53-APPEND'))`), 20_000, 'B4 第二条上屏');
    const b4SecondEnv = envOf('R53-APPEND');
    const b4SecondRefs = b4SecondEnv?.params?.attachmentRefs ?? [];
    const b4SecondLinks = linksOfMsg('R53-APPEND');
    const s1Total = db.prepare('SELECT count(*) c FROM message_attachments WHERE artifact_id = ?').get(s1Art?.id ?? '_').c;
    results.B4_waitEditSettlement = {
      oldChipStripped_newKept: true, // waitForJs 已门控
      bodyKeptAfterEdit: b4BodyKept === true,
      firstMsgLinks: (b4FirstLinks ?? []).map((x) => x.source_name),
      secondEnvRefs: b4SecondRefs,
      secondMsgLinks: (b4SecondLinks ?? []).map((x) => x.source_name),
      settle1LinkedExactlyOnce: s1Art != null && s1Total === 1,
      pass: b4BodyKept === true && (b4FirstLinks ?? []).length === 1 && b4FirstLinks?.[0]?.source_name === 'settle-1.md'
        && b4SecondRefs.length === 1 && b4SecondRefs[0] === s2Art?.id && (b4SecondLinks ?? []).length === 1 && b4SecondLinks?.[0]?.source_name === 'settle-2.md'
        && s1Art != null && s1Total === 1,
    };

    // ── B5 未知重试成功的清算（review §4 路径二） ──
    await pagePickFile(win, 'retry-1.md', 'text/markdown', `new Uint8Array([0x52,0x31])`);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('retry-1') && c.textContent.includes('v1'))`), 15_000, 'retry-1 ready');
    await typeInto(win, 'R53-RETRY-BODY');
    rejectNextFlag = true;
    await pickRecordIntent(win);
    await sendCurrent(win, 'B5 发送（回执将丢）');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((e) => e.textContent.includes('结果未知'))`), 25_000, 'unknown banner');
    // 等待期新增附件（不在冻结信封里——重试成功后必须保留）。
    await pagePickFile(win, 'retry-2.md', 'text/markdown', `new Uint8Array([0x52,0x32])`);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('retry-2') && c.textContent.includes('v1'))`), 15_000, '等待期 retry-2 ready');
    const b5FrozenEnv = envOf('R53-RETRY-BODY');
    await clickBtn(win, `b.textContent.includes('重发原内容')`, '重发原内容');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('R53-RETRY-BODY'))`), 20_000, '重试后消息上屏');
    await waitForJs(win, probe(`(() => { const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')]; return chips.some((c) => c.textContent.includes('retry-2')) && !chips.some((c) => c.textContent.includes('retry-1')); })()`), 20_000, 'B5 清算：冻结 refs 剥离/新保留');
    const r1Art = artifactBy('retry-1.md');
    const r2Art = artifactBy('retry-2.md');
    // 下一条：应只带 retry-2。
    await typeInto(win, 'R53-RETRY-NEXT');
    await pickRecordIntent(win);
    await sendCurrent(win, 'B5 下一条');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('R53-RETRY-NEXT'))`), 20_000, 'B5 下一条上屏');
    const b5NextEnv = envOf('R53-RETRY-NEXT');
    const b5NextRefs = b5NextEnv?.params?.attachmentRefs ?? [];
    const retryMsgLinks = linksOfMsg('R53-RETRY-BODY');
    const nextLinks = linksOfMsg('R53-RETRY-NEXT');
    const r1Total = db.prepare('SELECT count(*) c FROM message_attachments WHERE artifact_id = ?').get(r1Art?.id ?? '_').c;
    results.B5_unknownRetrySettlement = {
      frozenRefs: b5FrozenEnv?.params?.attachmentRefs ?? null,
      retryMsgLinks: (retryMsgLinks ?? []).map((x) => x.source_name),
      nextEnvRefs: b5NextRefs,
      nextMsgLinks: (nextLinks ?? []).map((x) => x.source_name),
      retry1LinkedExactlyOnce: r1Art != null && r1Total === 1,
      pass: (b5FrozenEnv?.params?.attachmentRefs ?? []).length === 1 && (retryMsgLinks ?? []).length === 1 && retryMsgLinks?.[0]?.source_name === 'retry-1.md'
        && b5NextRefs.length === 1 && b5NextRefs[0] === r2Art?.id && (nextLinks ?? []).length === 1 && nextLinks?.[0]?.source_name === 'retry-2.md'
        && r1Art != null && r1Total === 1,
    };

    // ── B6 收紧断言：PDF 实像素 / Word shadow 实内容 / 图片逐项对账 ──
    const previewResults = {};
    const MINI_PDF = 'Uint8Array.from(' + JSON.stringify(Array.from(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n0\n%%EOF', 'latin1'))) + ')';
    await pagePickFile(win, 'r53.pdf', 'application/pdf', MINI_PDF);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('r53.pdf') && c.textContent.includes('v1'))`), 20_000, 'pdf ready');
    await openPreviewOf(win, 'r53.pdf');
    // 实像素：canvas 必须真画过（alpha>0 像素数>0）——默认尺寸不算数。
    const pdfPixels = await waitForJs(win, probe(`(() => { const c = document.querySelector('[data-zs-pdf-canvas=hifi]'); if (c == null || c.width === 0) return null; const ctx = c.getContext('2d'); const rows = Math.min(c.height, 60); const d = ctx.getImageData(0, 0, c.width, rows).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1; return n > 0 ? n : null; })()`), 20_000, 'pdf canvas 实像素');
    previewResults.pdfPaintedPixels = pdfPixels;
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, '关闭 pdf 预览');
    const docxBytes = 'Uint8Array.from(' + JSON.stringify(Array.from(fs.readFileSync(path.join(root, 'scripts', 'dev25-dual', 'samples', 'word-r7-sample.docx')))) + ')';
    await pagePickFile(win, 'r53.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docxBytes);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('r53.docx') && c.textContent.includes('v1'))`), 20_000, 'docx ready');
    await openPreviewOf(win, 'r53.docx');
    // shadow 实内容：docx-wrapper>section 且文本非空（仅 style 节点不算渲染成功）。
    const docxText = await waitForJs(win, probe(`(() => { const host = document.querySelector('[data-zs-docx-host=hifi]'); const sec = host != null ? host.shadowRoot?.querySelector('.docx-wrapper section.docx') : null; const t = sec != null ? (sec.textContent || '').trim() : ''; return t.length > 0 ? t.slice(0, 40) : null; })()`), 25_000, 'docx shadow 实内容');
    previewResults.docxShadowText = docxText;
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, '关闭 docx 预览');
    const MINI_PNG = 'Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,0x89,0x00,0x00,0x00,0x0a,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82])';
    await pagePickFile(win, 'r53.png', 'image/png', MINI_PNG);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('r53.png') && c.textContent.includes('v1'))`), 15_000, 'png ready');
    await openPreviewOf(win, 'r53.png');
    await waitForJs(win, probe(`(() => { const img = document.querySelector('[data-zs-image-preview=hifi]'); return img != null && img.complete && img.naturalWidth === 1 && img.naturalHeight === 1; })()`), 10_000, '图片像素逐项对账');
    // onLoad 事件派发与 img.complete 有竞态——对账结论按属性有界等待（不再即时读一次）。
    const imgDecode = await waitForJs(win, probe(`document.querySelector('[data-zs-image-decode=ok]') != null`), 8_000, '图片对账结论=ok');
    previewResults.imageDecodeOk = imgDecode === true;
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, '关闭图片预览');
    results.B6_tightened = previewResults;
    results.B6_tightened.pass = previewResults.pdfPaintedPixels > 0 && String(previewResults.docxShadowText).length > 0 && previewResults.imageDecodeOk === true;

    // ── B1 PPT 视觉真实渲染（死锁修复实证）：真舞台+页数+翻页变化+模块请求 ──
    const pptxBytes = 'Uint8Array.from(' + JSON.stringify(Array.from(fs.readFileSync(path.join(root, 'scripts', 'dev25-dual', '回归幻灯.pptx')))) + ')';
    await pagePickFile(win, 'r53.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pptxBytes);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('r53.pptx') && c.textContent.includes('v1'))`), 25_000, 'pptx ready');
    await openPreviewOf(win, 'r53.pptx');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-preview=hifi] .panel, [data-zs-preview=hifi] div')].some((d) => (d.textContent || '').includes('幻灯片 1'))`), 60_000, 'pptx 提取文本卡片');
    const stageReady = await waitForJs(win, probe(`(() => { const st = document.querySelector('[data-zs-pptx-stage=hifi]'); return st != null && st.childElementCount > 0; })()`), 60_000, 'pptx 真舞台渲染（子节点>0）');
    const visualDone = await waitForJs(win, probe(`(() => { const el = document.querySelector('[data-zs-visual-state=done]'); return el != null; })()`), 30_000, 'visual-state=done');
    const slideCount = await win.webContents.executeJavaScript(probe(`document.querySelector('[data-zs-slide-count]')?.getAttribute('data-zs-slide-count')`), true);
    const moduleRequested = await win.webContents.executeJavaScript(probe(`performance.getEntriesByType('resource').some((e) => String(e.name).includes('pptx-renderer'))`), true);
    const sig1 = await win.webContents.executeJavaScript(probe(`(() => { const st = document.querySelector('[data-zs-pptx-stage=hifi]'); const ch = st?.firstElementChild; return ch == null ? null : ch.outerHTML.length + ':' + ch.tagName; })()`), true);
    await clickBtn(win, `b.textContent.includes('下一页') && b.closest('[data-zs-slide-controls]') != null`, 'pptx 翻到第 2 页');
    await waitForJs(win, probe(`document.querySelector('[data-zs-slide-page="2"]') != null`), 15_000, '翻页标签=2');
    const sig2 = await win.webContents.executeJavaScript(probe(`(() => { const st = document.querySelector('[data-zs-pptx-stage=hifi]'); const ch = st?.firstElementChild; return ch == null ? null : ch.outerHTML.length + ':' + ch.tagName; })()`), true);
    await sleep(1800); // 翻页渲染完成后再取样（goToSlide 异步）。
    const sig2b = await win.webContents.executeJavaScript(probe(`(() => { const st = document.querySelector('[data-zs-pptx-stage=hifi]'); const ch = st?.firstElementChild; return ch == null ? null : ch.outerHTML.length + ':' + ch.tagName; })()`), true);
    await sleep(2500); // 渲染线程空闲后再截图（pptx 渲染期间 CDP 命令会排队超时）。
    await captureShot(win, 'thread-pptx-visual-r53.png'); // 视觉真渲染的当下留证
    results.B1_pptxVisual = {
      stageHasChildren: stageReady === true,
      visualStateDone: visualDone === true,
      slideCount, moduleRequested,
      page1Signature: sig1, page2SignatureImmediate: sig2, page2SignatureSettled: sig2b,
      pass: stageReady === true && visualDone === true && String(slideCount) === '3' && sig1 != null && sig2b != null && String(sig1) !== String(sig2b),
    };
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, '关闭 pptx 预览');

    // ── B2 阻断负对照：同一判据必须对「渲染器不可用」失败（不能被降级冒充） ──
    blockPptxRenderer = true;
    await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    await waitForJs(win, `document.body.classList.contains('hifi-on') ? 'hifi' : null`, 15_000, 'hifi 壳挂载（负对照）');
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .side-item')].some((b) => b.textContent.includes('默认房间'))`), 20_000, '侧栏房间项（负对照——reload 后先等装载）');
    await clickBtn(win, `b.textContent.includes('默认房间') && b.classList.contains('side-item')`, '默认房间（负对照）');
    await waitForJs(win, probe(`document.querySelector('#hifi-root textarea') != null`), 15_000, '主池输入区（负对照）');
    await pagePickFile(win, 'r53-block.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pptxBytes);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('r53-block') && c.textContent.includes('v1'))`), 25_000, '负对照 pptx ready');
    await openPreviewOf(win, 'r53-block');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-preview=hifi] .panel, [data-zs-preview=hifi] div')].some((d) => (d.textContent || '').includes('幻灯片 1'))`), 60_000, '负对照提取文本卡片（不受阻断影响）');
    const ncState = await waitForJs(win, probe(`document.querySelector('[data-zs-visual-state=failed]') != null`), 30_000, '负对照 visual-state=failed');
    const ncStage = await win.webContents.executeJavaScript(probe(`(() => { const st = document.querySelector('[data-zs-pptx-stage=hifi]'); return st != null ? st.childElementCount : -1; })()`), true);
    const ncPredicateWouldPass = ncStage != null && ncStage > 0 && ncState === true; // B1 判据在阻断下的取值
    blockPptxRenderer = false;
    await clickBtn(win, `b.textContent.includes('关闭') && b.closest('[data-zs-preview=hifi]') != null`, '关闭负对照预览');
    results.B2_blockedNegativeControl = {
      visualStateFailed: ncState === true,
      stageChildren: ncStage,
      b1PredicateHere: ncPredicateWouldPass === true,
      textCardsStillRendered: true, // waitForJs 已门控（视觉阻断不连坐文本通道——分列合同）
      pass: ncState === true && ncStage === 0 && ncPredicateWouldPass === false,
    };

    // 详情截图（收尾证据）。
    await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#/thread/' + thA.id + '?tab=task')}; true`, true);
    await sleep(900);
    await captureShot(win, 'thread-details-r53.png');

    // 正常链复核：本审计零派发（全部仅记录）——任务数只有夹具派发的 1 个；消息数≥6。
    results.normalChain = {
      taskCount: db.prepare('SELECT count(*) c FROM tasks').get().c,
      msgCount: db.prepare('SELECT count(*) c FROM messages').get().c,
    };
    results.normalChain.pass = results.normalChain.taskCount === 1 && results.normalChain.msgCount >= 6;

    results.pass = results.B3_removeGhost.pass === true && results.B4_waitEditSettlement.pass === true
      && results.B5_unknownRetrySettlement.pass === true && results.B6_tightened.pass === true
      && results.B1_pptxVisual.pass === true && results.B2_blockedNegativeControl.pass === true
      && results.normalChain.pass === true;
    fs.writeFileSync(path.join(OUT, 'thread-r53-result.json'), JSON.stringify(results, null, 2));
    console.log('[r53] pass=' + results.pass);
  } catch (e) {
    results.error = String(e.message ?? e);
    try { results.debugText = await win.webContents.executeJavaScript('document.body.innerText.slice(0, 500)', true); results.debugHash = await win.webContents.executeJavaScript('location.hash', true); } catch { /* 已关 */ }
    fs.writeFileSync(path.join(OUT, 'thread-r53-result.json'), JSON.stringify(results, null, 2));
    console.error('[r53] FAIL: ' + results.error);
  } finally {
    try { await win.destroy(); } catch { /* 已关 */ }
    await daemon.close().catch(() => {});
    server.close();
    app.exit(results.pass === true ? 0 : 3);
  }
}
async function captureShot(win, name) {
  // pptx 真渲染后隐藏窗合成器不再产出新帧（Page.captureScreenshot 挂起——R53 实测）：
  // 截图瞬间临时显示窗口（showInactive 不抢焦点）→ 等首帧 → CDP 截图；CDP 仍失败则退
  // capturePage（显示态下为当前帧，非隐藏窗首帧），随后复隐藏。
  try { win.showInactive(); } catch { /* 已显示 */ }
  await sleep(400);
  let shot = null;
  try {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    shot = await Promise.race([
      dbg.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }),
      sleep(12_000).then(() => null),
    ]);
    try { dbg.detach(); } catch { /* 已分离 */ }
  } catch { /* CDP 不可用→capturePage 兜底 */ }
  if (shot == null) {
    try { const img = await win.webContents.capturePage(); if (img != null && !img.isEmpty()) shot = { data: img.toPNG().toString('base64') }; } catch { /* 兜底也失败→留空 */ }
  }
  try { win.hide(); } catch { /* 已隐藏 */ }
  if (shot == null) { console.error('[r53] 截图超时：' + name); return; }
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
}
app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
