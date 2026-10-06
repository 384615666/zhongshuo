'use strict';
/**
 * R61 主探针（review-r60 §2/§3/§5/§6）：用户手测反馈修复的页面级验证——
 *  - TG6 收藏可切换：按钮已收藏态（aria-pressed/data-zs-saved）×DB saved_refs 双断言；
 *    再次点击取消；重进/刷新状态保持；收藏页取消→消息行同步；注入失败负例（状态不变）；
 *    快速连点（第二击在途忽略，回执定局）。
 *  - TG7 文件引用重做：成果标签（无 Composer）连点两次→切回复=恰一张引用卡（正文零污染）；
 *    第三次点击同文件同版本去重；同名不同文件两卡不串；移除即消；发送带真实 refs 落库；
 *    未知回执→原信封重发→业务恰一次且只清本次已发引用；摘录只来自内容（不含界面说明文案）。
 *  - TDRAFT 草稿持久化（源码形态）：正文+仅记录意图 reload 保持；无「未持久化」提示。
 *  - TG9 待办正例（正式 fake worker 真实新回复）：关注→离开→水位不动→真新回复→待我处理
 *    出现→进入线程阅读→消失；静音线程排除。
 * 环境：真实 v61 UI 产物（dist/ui/renderer）× 当前正式 daemon（esbuild 打包，FakeRuntimeAdapter）
 * × 独立临时数据根；零真实模型调用。产物 dist/desktop/review-r61/hifi-r61-result.json。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, 'dist/desktop/review-r61');
const PORT = 48291;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
function serveAt(port, dir) {
  return http.createServer((req, res) => {
    const p = path.join(dir, decodeURIComponent(String(req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html');
    fs.readFile(p, (e, buf) => {
      if (e != null) { res.statusCode = 404; res.end('nf'); return; }
      res.setHeader('content-type', MIME[path.extname(p)] ?? 'application/octet-stream');
      res.end(buf);
    });
  });
}
const server = serveAt(PORT, path.join(root, 'dist/ui/renderer'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function untilTaskSettled(db, taskId, ms = 12000) {
  const t0 = Date.now();
  for (;;) {
    const st = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId)?.status;
    const turn = db.prepare('SELECT t.status ts FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? ORDER BY t.rowid DESC LIMIT 1').get(taskId)?.ts;
    if ((['DONE', 'REVIEW', 'FAILED', 'CANCELLED'].includes(st ?? '')) && (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(turn ?? ''))) return;
    if (Date.now() - t0 > ms) throw new Error('等待任务终态超时：' + taskId);
    await sleep(120);
  }
}
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

async function buildDaemon() {
  const entry = path.join(OUT, 'daemon-entry-r61.ts');
  const q = JSON.stringify;
  fs.writeFileSync(entry, `import { openDatabase } from ${q(path.join(root, 'src/persistence/db.ts'))};
import { dispatchDaemonCommand } from ${q(path.join(root, 'src/daemon/commands.ts'))};
import { DispatchWorker } from ${q(path.join(root, 'src/daemon/dispatchWorker.ts'))};
import { FakeRuntimeAdapter } from ${q(path.join(root, 'src/adapter/fake/runtimeAdapter.ts'))};
import type { FakeTurnScript } from ${q(path.join(root, 'src/adapter/fake/script.ts'))};
import { TASK_COMPLETE_SCHEMA_VERSION } from ${q(path.join(root, 'src/contracts/prompts.ts'))};
import { randomUUID } from 'node:crypto';
const validDone = (label: string): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: 'm_' + randomUUID().slice(0, 8), text: 'agent 回复：' + label } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];
let seq = 0;
export function makeDaemon(appDataDir: string) {
  const db = openDatabase(':memory:');
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => validDone('第' + (++seq) + '轮') });
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir };
  const command = (env: { commandId: string; method: string; params: unknown }) => dispatchDaemonCommand(deps as never, { protocolVersion: 1, commandId: env.commandId, method: env.method, params: env.params } as never);
  return { db, command, async pump() { await new DispatchWorker({ db, adapter, leaseOwner: 'w-r61', appDataDir } as never).runOnce(); }, async close() { await adapter.closeAllSessions().catch(() => {}); db.close(); } };
}
`, 'utf8');
  const bundle = path.join(OUT, 'real-daemon-r61.cjs');
  await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, sourcemap: false, external: ['better-sqlite3'], loader: { '.ts': 'ts' } });
  const workerOut = path.join(OUT, 'parse-worker-r61.cjs');
  await build({ entryPoints: [path.join(root, 'src/daemon/parseWorker.ts')], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: workerOut, sourcemap: false, logLevel: 'silent', loader: { '.ts': 'ts' } });
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
async function evalJs(win, expr) {
  return await win.webContents.executeJavaScript(probe(expr), true);
}
async function toastText(win) {
  return await evalJs(win, `document.querySelector('#hifi-root .toast')?.textContent ?? ''`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.error('[r61] buildDaemon...');
  const daemon = await buildDaemon();
  const db = daemon.db;
  await new Promise((res, rej) => { server.once('error', rej); server.listen(PORT, '127.0.0.1', () => { server.off('error', rej); res(); }); });

  const projDir = path.join(OUT, 'proj-r61');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# r61\n', 'utf8');
  await daemon.command({ commandId: 'cmd-r61-open', method: 'project.open', params: { path: projDir } });
  const projId = db.prepare('SELECT id FROM projects LIMIT 1').get().id;
  db.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?, 'Guide A','agent',1)").run(projId);
  db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '默认房间', 'mA')").run(projId);
  db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA')").run();
  db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
  const mkcmd = () => 'cmd-r61-' + Math.random().toString(36).slice(2, 10);
  const r0 = await daemon.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: 'r61 主任务', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] } });
  if (r0.ok !== true) throw new Error('夹具派发失败');
  await daemon.pump();
  const anchor = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r61 主任务%'").get();
  const th = db.prepare('SELECT id, root_task_id FROM conversation_threads WHERE anchor_message_id = ?').get(anchor.id);
  await untilTaskSettled(db, th.root_task_id);
  // 附件：主文件 + 同名不同内容两份（同名不同文件反例）。
  const up = async (name, content) => (await daemon.command({ commandId: mkcmd(), method: 'attachment.uploadText', params: { conversationId: 'convA', filename: name, content } })).data;
  const att1 = await up('audit-file-reference.md', 'AUDIT-CONTENT-引用审计正文第一行');
  const att2a = await up('dup-name.md', 'DUP-CONTENT-A');
  const att2b = await up('dup-name.md', 'DUP-CONTENT-B-different-bytes');
  await daemon.command({ commandId: 'cmd-r61-set', method: 'app.settings.set', params: { key: 'ui.autoOpenProjectPath', value: projDir } });

  const results = { scope: 'R61：G6 收藏切换 / G7 文件引用重做 / 草稿持久化 / G9 待办正例' };
  const sentLog = [];
  /** 注入钩子：failOnce={method} 服务拒绝一次；unknownOnce={method,n} 第 n 笔该命令传输失败一次。 */
  const hooks = { failOnce: null, unknownOnce: null };
  ipcMain.handle('zs-command', async (_e, env) => {
    sentLog.push({ method: env.method, params: env.params });
    if (hooks.failOnce != null && env.method === hooks.failOnce.method) { hooks.failOnce = null; return { ok: false, error: { code: 'AUDIT_INJECTED', message: '审计注入的服务端失败' } }; }
    if (hooks.unknownOnce != null && env.method === hooks.unknownOnce.method) {
      hooks.unknownOnce.n -= 1;
      if (hooks.unknownOnce.n <= 0) { hooks.unknownOnce = null; throw new Error('审计注入的传输失败'); }
    }
    return daemon.command(env);
  });
  const PRELOAD = `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('zs', {
  command: async (env) => ipcRenderer.invoke('zs-command', env),
  pickFolder: async () => null, openPath: async () => {},
  onDisconnect: () => {}, onReconnected: () => {}, onDemoStatus: () => {},
});
contextBridge.exposeInMainWorld('zsWindow', { minimize: async () => ({ ok: true }), toggleMaximize: async () => ({ ok: true }), close: async () => ({ ok: true }), getState: async () => ({ ok: true }), onStateChange: () => {} });`;
  const preloadPath = path.join(OUT, 'preload-r61.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });

  const savedCount = (ref) => db.prepare('SELECT count(*) c FROM saved_refs WHERE viewer_id = ? AND kind = ? AND ref = ?').get('u_local', 'message', ref).c;
  const threadRoute = `#/thread/${th.id}`;
  const goto = async (hash) => { await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}; true`, true); };
  const openThread = async () => {
    await goto(threadRoute);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .msg')].some((m) => m.textContent.includes('agent 回复'))`), 15_000, '线程回复可见');
    await sleep(600);
  };
  const chipsOf = () => evalJs(win, `(() => { const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].filter((c) => c.querySelector('svg[data-icon=paperclip]')); return JSON.stringify(chips.map((c) => ({ text: c.textContent, title: c.title ?? '' }))); })()`);
  const bodyVal = () => evalJs(win, `document.querySelector('#hifi-root textarea.composer-input')?.value ?? ''`);

  try {
    await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    await waitForJs(win, probe(`document.body.classList.contains('hifi-on') && [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`), 20_000, '首启进入项目');

    /* ────────── TG6 收藏可切换 ────────── */
    await openThread();
    const firstAgentMsgId = db.prepare("SELECT id FROM messages WHERE thread_id = ? AND author_type = 'agent' ORDER BY thread_message_seq LIMIT 1").get(th.id).id;
    await waitForJs(win, probe(`document.querySelector('#msg-${firstAgentMsgId} [data-zs-saved]') != null`), 8000, '书签按钮存在');
    const savedAttr = () => evalJs(win, `document.querySelector('#msg-${firstAgentMsgId} [data-zs-saved]')?.getAttribute('data-zs-saved')`);
    const pressAttr = () => evalJs(win, `document.querySelector('#msg-${firstAgentMsgId} [data-zs-saved]')?.getAttribute('aria-pressed')`);
    // ① 收藏：按钮态+DB 双断言
    await clickBtn(win, `b.closest('#msg-${firstAgentMsgId}')?.querySelector('[data-zs-saved]') === b`, 'TG6 收藏点击');
    await waitForJs(win, probe(`document.querySelector('#msg-${firstAgentMsgId} [data-zs-saved]')?.getAttribute('data-zs-saved') === '1'`), 8000, '已收藏态');
    const add = { attr: await savedAttr(), pressed: await pressAttr(), db: savedCount(firstAgentMsgId) };
    // ② 再次点击=取消（原消息不动）
    await clickBtn(win, `b.closest('#msg-${firstAgentMsgId}')?.querySelector('[data-zs-saved]') === b`, 'TG6 取消点击');
    await waitForJs(win, probe(`document.querySelector('#msg-${firstAgentMsgId} [data-zs-saved]')?.getAttribute('data-zs-saved') === '0'`), 8000, '取消后未收藏态');
    const rem = { attr: await savedAttr(), db: savedCount(firstAgentMsgId), msgAlive: db.prepare('SELECT count(*) c FROM messages WHERE id = ?').get(firstAgentMsgId).c };
    // ③ 重进/刷新状态保持（服务端事实）
    await clickBtn(win, `b.closest('#msg-${firstAgentMsgId}')?.querySelector('[data-zs-saved]') === b`, 'TG6 重收藏');
    await waitForJs(win, probe(`document.querySelector('#msg-${firstAgentMsgId} [data-zs-saved]')?.getAttribute('data-zs-saved') === '1'`), 8000, '重收藏');
    await win.webContents.executeJavaScript(`location.reload(); true`, true);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`), 20_000, '刷新回到项目');
    await openThread();
    const afterReload = { attr: await savedAttr(), db: savedCount(firstAgentMsgId) };
    // ④ 收藏页取消 → 消息行同步
    await goto('#/library');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-library=hifi] button')].some((b) => b.textContent.includes('收藏'))`), 8000, '搜索与收藏页');
    await clickBtn(win, `b.textContent.trim() === '收藏' || (b.classList.contains('thread-tab') && b.textContent.includes('收藏'))`, '收藏标签');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-library=hifi] .chip, [data-zs-library=hifi] button, [data-zs-library=hifi] .row')].some((x) => x.textContent.includes('audit') || (x.textContent.includes('agent 回复') && x.querySelector('button'))) || document.querySelector('[data-zs-library=hifi]')?.textContent.includes('条')`), 8000, '收藏列表内容');
    const libRows = await evalJs(win, `document.querySelector('[data-zs-library=hifi]')?.textContent.includes('agent 回复')`);
    await clickBtn(win, `b.title.includes('取消收藏')`, '收藏页取消收藏');
    await sleep(900);
    const libRemoved = { db: savedCount(firstAgentMsgId), libHad: libRows === true };
    await openThread();
    await waitForJs(win, probe(`document.querySelector('#msg-${firstAgentMsgId} [data-zs-saved]')?.getAttribute('data-zs-saved') === '0'`), 8000, '收藏页取消后消息行同步');
    const afterLibRemove = { attr: await savedAttr() };
    // ⑤ 注入失败负例：状态不变、如实提示
    hooks.failOnce = { method: 'saved.add' };
    await clickBtn(win, `b.closest('#msg-${firstAgentMsgId}')?.querySelector('[data-zs-saved]') === b`, 'TG6 失败注入点击');
    await sleep(700);
    const failCase = { attr: await savedAttr(), db: savedCount(firstAgentMsgId), toast: await toastText(win) };
    // ⑥ 快速连点：两击间隔 < 回执——第二击忽略，回执定局
    await win.webContents.executeJavaScript(probe(`(() => { const b = document.querySelector('#msg-${firstAgentMsgId} [data-zs-saved]'); b.click(); b.click(); return true; })()`), true);
    await sleep(1000);
    const rapid = { attr: await savedAttr(), db: savedCount(firstAgentMsgId) };
    results.TG6_favoriteToggle = { add, rem, afterReload, libRemoved, afterLibRemove, failCase, rapid };
    results.TG6_favoriteToggle.pass = add.attr === '1' && add.pressed === 'true' && add.db === 1
      && rem.attr === '0' && rem.db === 0 && rem.msgAlive === 1
      && afterReload.attr === '1' && afterReload.db === 1
      && libRemoved.db === 0 && afterLibRemove.attr === '0'
      && failCase.attr === '0' && failCase.db === 0 && (failCase.toast ?? '').includes('失败')
      && rapid.attr === '1' && rapid.db === 1;
    // 清场：取消收藏，回到未收藏
    await clickBtn(win, `b.closest('#msg-${firstAgentMsgId}')?.querySelector('[data-zs-saved="1"]') === b`, 'TG6 清场取消');
    await sleep(500);

    /* ────────── TG7 文件引用重做 ────────── */
    // ① 成果标签（无 Composer）连点两次 → 切回复恰一张卡、正文零污染（旧反例形态）
    await openThread();
    await clickBtn(win, `b.textContent.includes('成果与附件')`, '切成果标签');
    await waitForJs(win, probe(`[...document.querySelectorAll('[data-zs-thread-artifacts=hifi] .msg-attach')].some((b) => b.textContent.includes('audit-file-reference.md'))`), 10_000, '成果页附件芯片');
    await clickBtn(win, `b.classList.contains('msg-attach') && b.textContent.includes('audit-file-reference.md')`, '打开主文件预览');
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]') != null && document.querySelector('[data-zs-preview=hifi]')?.textContent.includes('AUDIT-CONTENT')`), 10_000, '预览内容装载');
    await clickBtn(win, `b.textContent.trim() === '引用文件'`, '引用文件（第1击·成果页）');
    await sleep(250);
    await clickBtn(win, `b.textContent.trim() === '引用文件'`, '引用文件（第2击·成果页）');
    await sleep(400);
    const dblClickToast = await toastText(win);
    // 切回回复：恰一张卡 + 正文保持用户文字（此时还没输入——空）
    await clickBtn(win, `b.textContent.includes('回复') && b.querySelector('svg')`, '切回回复标签');
    await waitForJs(win, probe(`document.querySelectorAll('#hifi-root .composer-mentions .chip').length >= 0`), 6000, '回复输入区');
    await sleep(700);
    const afterSwitchChips = JSON.parse(await chipsOf());
    const bodyAfterQuote = await bodyVal();
    // ② 第三击（已可见）同文件同版本去重
    await clickBtn(win, `b.textContent.trim() === '引用文件'`, '引用文件（第3击·已可见）');
    await sleep(500);
    const afterThird = JSON.parse(await chipsOf());
    // ③ 同名不同文件：第二文件 → 两卡不串（attachmentId 不同）
    await clickBtn(win, `b.title.includes('关闭预览')`, '关闭预览');
    await sleep(300);
    await clickBtn(win, `b.textContent.includes('成果与附件')`, '再切成果');
    await sleep(600);
    const dupChips = await evalJs(win, `(() => { const bs = [...document.querySelectorAll('[data-zs-thread-artifacts=hifi] .msg-attach')].filter((b) => b.textContent.includes('dup-name.md')); bs[0]?.click(); return bs.length; })()`);
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]')?.textContent.includes('DUP-CONTENT')`), 10_000, '同名文件预览装载');
    await clickBtn(win, `b.textContent.trim() === '引用文件'`, '引用同名文件A');
    await sleep(300);
    await clickBtn(win, `b.textContent.includes('回复') && b.querySelector('svg')`, '切回回复（同名卡可见）');
    await sleep(700);
    const chipsAfterDup = JSON.parse(await chipsOf());
    const dupNamesOk = chipsAfterDup.filter((c) => c.text.includes('dup-name.md')).length;
    const distinctIds = new Set(chipsAfterDup.map((c) => (c.title.match(/([0-9a-f]{8})/g) ?? []).join(''))).size;
    // ④ 移除引用卡：即消、草稿零残留
    const removedChip = await evalJs(win, `(() => { const chips = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].filter((c) => c.textContent.includes('dup-name.md')); if (chips.length === 0) return 'NO_CHIP'; chips[0].querySelector('button[title*="移除"]')?.click(); return 'OK'; })()`);
    await sleep(500);
    const chipsAfterRemove = JSON.parse(await chipsOf());
    // ⑤ 发送带真实 refs：正文+dupA 卡（如仍在）→ 落库恰一条链接
    const dupLeft = chipsAfterRemove.filter((c) => c.text.includes('dup-name.md'));
    void dupLeft;
    const setArea = async (v) => { await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(v)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true); };
    await setArea('r61 引用发送审计正文');
    await clickBtn(win, `/^发送$/.test(b.textContent.trim())`, '发送（带引用）');
    await sleep(1200);
    const sentMsg = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r61 引用发送审计正文%' ORDER BY rowid DESC").get();
    const sentLinks = sentMsg != null ? db.prepare('SELECT a.id, a.source_name FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE ma.message_id = ?').all(sentMsg.id) : [];
    const chipsAfterSend = JSON.parse(await chipsOf());
    const bodyAfterSend = await bodyVal();
    // ⑥ 未知回执→原信封重发→恰一次；成功只清本次已发引用
    await clickBtn(win, `b.title.includes('关闭预览')`, '关闭预览2');
    await sleep(200);
    await clickBtn(win, `b.textContent.includes('成果与附件')`, '再切成果2');
    await sleep(500);
    await evalJs(win, `[...document.querySelectorAll('[data-zs-thread-artifacts=hifi] .msg-attach')].find((b) => b.textContent.includes('audit-file-reference.md'))?.click(), true`);
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]')?.textContent.includes('AUDIT-CONTENT')`), 8000, '预览再装载');
    await clickBtn(win, `b.textContent.trim() === '引用文件'`, '再引用主文件');
    await clickBtn(win, `b.textContent.includes('回复') && b.querySelector('svg')`, '切回回复2');
    await sleep(600);
    await setArea('r61 未知回执重发审计');
    hooks.unknownOnce = { method: 'message.submit', n: 1 };
    await clickBtn(win, `/^发送$/.test(b.textContent.trim())`, '发送（将丢回执）');
    let bannerUp = false;
    try {
      await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`), 10_000, '未知信封横幅');
      bannerUp = true;
    } catch (e) {
      const diag = {
        chips: JSON.parse((await chipsOf()) || '[]'),
        allChips: await evalJs(win, `[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].map((c) => c.textContent.slice(0, 40)).join(' || ')`),
        body: (await bodyVal()).slice(0, 60),
        submits: sentLog.filter((x) => x.method === 'message.submit').map((x) => String(JSON.stringify(x.params).slice(0, 80))).slice(-4),
        dbMsg: db.prepare("SELECT count(*) c FROM messages WHERE body_json LIKE '%r61 未知回执重发审计%'").get().c,
      };
      console.error('[r61] 未知横幅诊断：', JSON.stringify(diag));
      throw e;
    }
    void bannerUp;
    const unknownChips = JSON.parse(await chipsOf());
    await clickBtn(win, `b.title.includes('严格重发原信封')`, '重发原内容');
    await sleep(1500);
    const replayMsgs = db.prepare("SELECT id FROM messages WHERE body_json LIKE '%r61 未知回执重发审计%'").all();
    const replayLinks = replayMsgs.length === 1 ? db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(replayMsgs[0].id).c : -1;
    const replayEnvCmds = sentLog.filter((x) => x.method === 'message.submit' && JSON.stringify(x.params).includes('r61 未知回执重发审计')).map((x) => x.params.attachmentRefs ?? null);
    const bannerAfterRetry = await evalJs(win, `[...document.querySelectorAll('#hifi-root .composer-mentions .chip')].some((c) => c.textContent.includes('结果未知'))`);
    const chipsAfterRetry = JSON.parse(await chipsOf());
    results.TG7_fileQuote = {
      dblClickToast, afterSwitchChips: afterSwitchChips.length, bodyAfterQuoteEmpty: bodyAfterQuote.trim().length === 0,
      afterThird: afterThird.length, dupNames: dupChips, chipsAfterDup: chipsAfterDup.length, dupNamesOk, distinctIds,
      removedChip, chipsAfterRemove: chipsAfterRemove.length, sentLinks, chipsAfterSend: chipsAfterSend.length, bodyAfterSend,
      unknownChips: unknownChips.length, replayMsgs: replayMsgs.length, replayLinks, replayEnvCmds, bannerAfterRetry, chipsAfterRetry: chipsAfterRetry.length,
    };
    results.TG7_fileQuote.pass = results.TG7_fileQuote.afterSwitchChips === 1 && results.TG7_fileQuote.bodyAfterQuoteEmpty
      && results.TG7_fileQuote.afterThird === 1
      && dupNamesOk === 1 && results.TG7_fileQuote.chipsAfterDup === 2 && distinctIds === 2
      && removedChip === 'OK' && results.TG7_fileQuote.chipsAfterRemove === 1
      && sentMsg != null && sentLinks.length === 1 && results.TG7_fileQuote.chipsAfterSend === 0 && bodyAfterSend.trim().length === 0
      && results.TG7_fileQuote.unknownChips >= 1
      && replayMsgs.length === 1 && replayLinks === 1 && bannerAfterRetry === false && results.TG7_fileQuote.chipsAfterRetry === 0;
    // ⑦ 摘录：内容真源（不含界面说明文案——r60 审计的「原文 20B·模型输入…」污染负例）
    await clickBtn(win, `b.title.includes('关闭预览')`, '关闭预览3').catch(() => null);
    await sleep(200);
    await clickBtn(win, `b.textContent.includes('成果与附件')`, '切成果3').catch(() => null);
    await sleep(500);
    await evalJs(win, `[...document.querySelectorAll('[data-zs-thread-artifacts=hifi] .msg-attach')].find((b) => b.textContent.includes('audit-file-reference.md'))?.click(), true`);
    await waitForJs(win, probe(`document.querySelector('[data-zs-preview=hifi]')?.textContent.includes('AUDIT-CONTENT')`), 8000, '摘录前预览装载');
    await clickBtn(win, `b.textContent.trim() === '摘录'`, '摘录');
    await sleep(600);
    const excerptBody = await bodyVal();
    results.TG7_excerpt = { excerptBody: excerptBody.slice(0, 200) };
    results.TG7_excerpt.pass = excerptBody.includes('> 摘录「audit-file-reference.md」') && excerptBody.includes('AUDIT-CONTENT-引用审计正文第一行') && !excerptBody.includes('模型输入') && !excerptBody.includes('原文 ');
    await setArea(''); // 清正文
    await sleep(300);
    await clickBtn(win, `b.title.includes('关闭预览')`, '关闭预览4').catch(() => null);

    /* ────────── TDRAFT 草稿持久化（源码形态 reload） ────────── */
    await openThread();
    await setArea('r61 草稿保持审计正文');
    // 仅记录意图（一次性）——重载后不得变 AI 派发
    await clickBtn(win, `b.getAttribute('aria-label') === '本次运行设置'`, '本次运行设置');
    await sleep(400);
    await clickBtn(win, `b.textContent.includes('仅记录') && !b.textContent.includes('取消')`, '仅记录菜单项');
    await sleep(300);
    const persistKey = await evalJs(win, `Object.keys(localStorage).filter((k) => k.startsWith('zs.hifi.persist.')).join(',')`);
    const persistBodyHit = await evalJs(win, `Object.keys(localStorage).filter((k) => k.startsWith('zs.hifi.persist.')).some((k) => (localStorage.getItem(k) ?? '').includes('r61 草稿保持审计正文'))`);
    const draftChipBefore = await evalJs(win, `document.querySelector('#hifi-root .composer-mentions .chip.record-chip') != null`);
    await win.webContents.executeJavaScript(`location.reload(); true`, true);
    await waitForJs(win, probe(`[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`), 20_000, '草稿重载回项目');
    await openThread();
    await sleep(800);
    const draftAfterReload = await bodyVal();
    const recordAfterReload = await evalJs(win, `document.querySelector('#hifi-root .composer-mentions .chip.record-chip') != null`);
    const persistFailChip = await evalJs(win, `[...document.querySelectorAll('#hifi-root .composer-draft')].some((c) => c.textContent.includes('未持久化'))`);
    results.TDRAFT_persist = { persistKey, persistBodyHit, draftChipBefore, draftAfterReload, recordAfterReload, persistFailChip };
    results.TDRAFT_persist.pass = persistBodyHit === true && draftAfterReload.includes('r61 草稿保持审计正文') && recordAfterReload === true && persistFailChip === false;
    await setArea('');

    /* ────────── TG9 待办正例（fake worker 真实新回复——经正式返工执行链派发） ────────── */
    // M0 合同：任务串人类跟进只记录不派发（followUpRecorded）——真实 agent 新回复经
    // task.review(changes_requested)+task.executeRework 正式链产生（r58/r59 已证链路）。
    let dlvSeq = 0;
    const reworkRound = async () => {
      dlvSeq += 1;
      db.prepare('UPDATE projects SET task_review_enabled = 1 WHERE id = ?').run(projId);
      db.prepare("UPDATE tasks SET review_policy = 'user_review' WHERE id = ?").run(th.root_task_id);
      const dlvId = `dlv_r61_${dlvSeq}`;
      db.prepare("UPDATE tasks SET status='REVIEW' WHERE id = ?").run(th.root_task_id);
      const srcRun = db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(th.root_task_id).id;
      db.prepare("UPDATE task_deliveries SET review_status = 'superseded' WHERE task_id = ? AND review_status = 'pending'").run(th.root_task_id); // 每任务仅一条 pending（部分唯一索引）——真实 run 的交付让位
      const rev = (db.prepare('SELECT max(revision) m FROM task_deliveries WHERE task_id = ?').get(th.root_task_id).m ?? 0) + 1;
      db.prepare("INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status, run_id) VALUES (?, ?, ?, ?, '[]', '[]', '[]', 'pending', ?)")
        .run(dlvId, th.root_task_id, rev, 'a'.repeat(64), srcRun);
      const rv = await daemon.command({ commandId: mkcmd(), method: 'task.review', params: { taskId: th.root_task_id, deliveryId: dlvId, deliveryRevision: rev, manifestHash: 'a'.repeat(64), decision: 'changes_requested', note: `r61 待办正例第${dlvSeq}轮` } });
      if (rv.ok !== true) throw new Error('task.review 失败：' + JSON.stringify(rv).slice(0, 200));
      const tg = await daemon.command({ commandId: mkcmd(), method: 'task.get', params: { taskId: th.root_task_id } });
      const rp = tg.data?.task?.reworkPending ?? tg.data?.reworkPending;
      if (rp == null) throw new Error('reworkPending 缺失：' + JSON.stringify(tg.data).slice(0, 200));
      const ex = await daemon.command({ commandId: mkcmd(), method: 'task.executeRework', params: { taskId: th.root_task_id, deliveryId: rp.deliveryId, deliveryRevision: rp.deliveryRevision, manifestHash: rp.manifestHash, sourceRunId: rp.sourceRunId, reason: 'r61 待办正例' } });
      if (ex.ok !== true) throw new Error('executeRework 失败：' + JSON.stringify(ex).slice(0, 200));
      await daemon.pump();
      await untilTaskSettled(db, th.root_task_id);
      return db.prepare("SELECT max(thread_message_seq) s FROM messages WHERE thread_id = ? AND author_type = 'agent'").get(th.id).s;
    };
    // 前置：水位推到当前末尾（前台+贴底——打开线程即触发 loadThread markRead）
    await openThread();
    await sleep(1200);
    const wm0 = db.prepare('SELECT last_read_message_seq s FROM thread_read_states WHERE thread_id = ? AND viewer_id = ?').get(th.id, 'u_local')?.s ?? 0;
    // ① 关注 → 离开（回主池）
    await clickBtn(win, `b.getAttribute('data-zs-thread-follow') === '0'`, '关注线程');
    await waitForJs(win, probe(`document.querySelector('[data-zs-thread-follow="1"]') != null`), 8000, '已关注态');
    await goto('#/room/roomA');
    await sleep(700);
    // ② 真实新 agent 回复（离开后产生——水位不得自动推进）
    const newReplySeq = await reworkRound();
    const wmWhileAway = db.prepare('SELECT last_read_message_seq s FROM thread_read_states WHERE thread_id = ? AND viewer_id = ?').get(th.id, 'u_local')?.s ?? 0;
    // ③ 待我处理出现
    await goto('#/pending');
    await waitForJs(win, probe(`document.querySelector('[data-zs-pending=hifi]') != null`), 10_000, '待我处理页');
    const pendShown = await waitForJs(win, probe(`document.querySelector('[data-zs-pending=hifi]')?.textContent.includes('关注的线程有新回复')`), 10_000, '待办出现关注线程条目').catch(() => false);
    await sleep(300);
    const pendText = await evalJs(win, `document.querySelector('[data-zs-pending=hifi]')?.textContent.slice(0, 500) ?? ''`);
    // ④ 进入线程阅读（新回复可见）→ 水位推进 → 待办消失
    await openThread();
    await sleep(1800);
    const wmAfterRead = db.prepare('SELECT last_read_message_seq s FROM thread_read_states WHERE thread_id = ? AND viewer_id = ?').get(th.id, 'u_local')?.s ?? 0;
    await goto('#/pending');
    await sleep(1000);
    const pendTextAfter = await evalJs(win, `document.querySelector('[data-zs-pending=hifi]')?.textContent.slice(0, 300) ?? ''`);
    const pendGone = !pendTextAfter.includes('关注的线程有新回复') && !pendTextAfter.includes('线程有新回复');
    // ⑤ 静音排除：静音 → 离开 → 再一轮真实回复 → 待办不含
    await openThread();
    await clickBtn(win, `b.getAttribute('data-zs-thread-mute') === '0'`, '静音线程');
    await waitForJs(win, probe(`document.querySelector('[data-zs-thread-mute="1"]') != null`), 8000, '已静音态');
    await goto('#/room/roomA');
    await sleep(600);
    const reply3Seq = await reworkRound();
    await goto('#/pending');
    await sleep(1000);
    const mutedPendText = await evalJs(win, `document.querySelector('[data-zs-pending=hifi]')?.textContent.slice(0, 500) ?? ''`);
    const mutedPendingRaw = await daemon.command({ commandId: mkcmd(), method: 'mine.pending', params: {} });
    const mutedRows = (mutedPendingRaw.data?.projects ?? []).flatMap((p) => [...(p.threadUnread ?? []), ...(p.followedThreads ?? [])]).filter((x) => x.thread_id === th.id);
    const mutedExcluded = !mutedPendText.includes('关注的线程有新回复') && !mutedPendText.includes('线程有新回复') && mutedRows.length === 0;
    results.TG9_pending = { wmBeforeLeave: wm0, wmWhileAway, newReplySeq, pendShown, wmAfterRead, pendGone, reply3Seq, mutedExcluded, pendText: pendText.slice(0, 200), pendTextAfter: pendTextAfter.slice(0, 120), mutedPendHead: mutedPendText.slice(0, 120) };
    results.TG9_pending.pass = newReplySeq > wm0
      && wmWhileAway === wm0 // 离开期水位不动（后台旧视图不推进）
      && pendShown === true
      && wmAfterRead >= newReplySeq
      && pendGone === true
      && reply3Seq > wmAfterRead
      && mutedExcluded === true;

    results.pass = Object.entries(results).filter(([k, v]) => k !== 'scope' && k !== 'pass' && v != null && typeof v === 'object' && 'pass' in v).every(([, v]) => v.pass === true);
  } finally {
    try { win.destroy(); } catch { /* 已销毁 */ }
    server.close();
    await daemon.close().catch(() => {});
  }
  const file = path.join(OUT, 'hifi-r61-result.json');
  fs.writeFileSync(file, JSON.stringify(results, null, 2), 'utf8');
  console.log(JSON.stringify({ file, pass: results.pass, segs: Object.fromEntries(Object.entries(results).filter(([k, v]) => k !== 'scope' && k !== 'pass' && v != null && typeof v === 'object' && 'pass' in v).map(([k, v]) => [k, v.pass])) }, null, 2));
  app.exit(results.pass === true ? 0 : 3);
}
void main().catch((e) => { console.error('[r61] 失败：', e); try { app.exit(1); } catch { process.exit(1); } });
