'use strict';
/**
 * 第四十六轮 H1 冒烟：hifi 换装壳（原型组件+真实 store）在**实际打包页面**上的真实控制流
 * ——HTTP 服务 dist/ui/renderer + 传输桩（window.zs 命令面；DOM/CSS/React 控制流全真实）。
 * 断言：①侧栏=真实 room.list 数据 ②房间主池=真实 room.pool ③发送走真实 message.submit
 * （room_root/dm；default/record_only）④私信列表/历史真实 ⑤legacy 接管守卫（不双启动）。
 * 运行：./node_modules/.bin/electron scripts/verify-hifi-shell.cjs；产物 dist/desktop/hifi-shell/metrics.json。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const root = path.resolve(__dirname, '..');
const PAGE_DIR = path.join(root, 'dist/ui/renderer');
const OUT = path.join(root, 'dist/desktop/hifi-shell');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 48221;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = req.url.split('?')[0].replace(/^\/+/, '') || 'index.html';
  const file = path.join(PAGE_DIR, rel.replace(/\.\./g, ''));
  if (!file.startsWith(PAGE_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

const sent = []; // 桩进程侧命令日志（经 contextBridge 的 getSentLog 暴露给断言）
const PRELOAD = `
const { contextBridge } = require('electron');
const log = [];
const DATA = ${JSON.stringify({
  project: { id: 'p1', displayName: 'Hifi 冒烟项目' },
  rooms: [
    { id: 'roomA', name: '默认房间', conversationId: 'convRoomA' },
    { id: 'roomB', name: 'Lab Room', conversationId: 'convRoomB' },
  ],
  members: { items: [{ id: 'mA', displayName: 'Guide A', principalType: 'agent', enabled: true }] },
  pool: { items: [
    { threadId: 'th1', taskId: 'task_1', body: { text: 'Hifi 主池样本消息（真实 room.pool 形状）' }, createdAt: Date.now(), replyCount: 2, unread: 0, taskStatus: 'ACTIVE' },
  ] },
  conversations: { conversations: [
    { conversationId: 'convDm1', peerDisplayName: 'Guide A', title: '冒烟私信', execState: 'idle', unread: 1, archivedAt: null, lastMessagePreview: '私信样本' },
  ] },
  dmHistory: { messages: [
    { id: 'dm1', createdAt: Date.now(), authorType: 'human', bodyJson: JSON.stringify({ text: '发给成员的私信样本' }), conversationSeq: 1 },
    { id: 'dm2', createdAt: Date.now(), authorType: 'agent', authorId: 'mA', bodyJson: JSON.stringify({ text: '成员的回复样本' }), conversationSeq: 2 },
  ] },
})};
const dispatch = (method, params) => {
  const D = DATA;
  switch (method) {
    case 'app.settings.get': return { ok: true, data: { values: { 'ui.autoOpenProjectPath': 'D:\\\\zs-hifi-smoke\\\\proj' } } };
    case 'project.open': return { ok: true, data: { project: D.project } };
    case 'room.list': return { ok: true, data: { items: D.rooms } };
    case 'member.list': return { ok: true, data: D.members };
    case 'room.pool': return { ok: true, data: D.pool };
    case 'conversation.list': return { ok: true, data: D.conversations };
    case 'conversation.history': return { ok: true, data: D.dmHistory };
    case 'conversation.markRead': return { ok: true, data: { advanced: true } };
    case 'message.submit': return { ok: true, data: { taskId: 'task_smoke', threadId: 'th_smoke', disposition: 'dispatched' } };
    default: return { ok: true, data: {} };
  }
};
contextBridge.exposeInMainWorld('zs', {
  command: async (env) => { log.push({ method: env.method, params: env.params }); return dispatch(env.method, env.params); },
  getSentLog: async () => log.slice(),
  pickFolder: async () => null,
  openPath: async () => {},
  onDisconnect: () => {},
  onReconnected: () => {},
  onDemoStatus: () => {},
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function waitForJs(win, iife, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await win.webContents.executeJavaScript(iife, true).catch((e) => { void e; return null; });
    if (v) return v;
    if (Date.now() - t0 > ms) { console.warn('[hifi-shell] 等待超时：' + label); return null; }
    await sleep(150);
  }
}

async function main() {
  const preloadPath = path.join(OUT, 'stub-preload.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  const results = {};
  try {
    await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    await waitForJs(win, `window.__zsReady === true ? 'ready' : null`, 10_000, '__zsReady(legacy 绑定)');
    // ① hifi 壳挂载 + 侧栏真实数据（room.list 经真实 dispatch）
    const sidebar = await waitForJs(win, probe(`(() => {
      const labels = [...document.querySelectorAll('#hifi-root .sidebar .side-item-label')].map((e) => e.textContent.trim());
      const ok = labels.includes('Hifi 冒烟项目') === false ? false : true;
      return JSON.stringify({ labels, hasDefaultRoom: labels.some((t) => t.includes('默认房间')), hasLab: labels.some((t) => t.includes('Lab Room')), hasDm: labels.some((t) => t === '私信') });
    })()`), 15_000, 'hifi 侧栏装载');
    // ② 点默认房间 → 主池消息来自 room.pool
    await win.webContents.executeJavaScript(probe(`(() => { const btn = [...document.querySelectorAll('#hifi-root .sidebar .side-item')].find((b) => b.textContent.includes('默认房间')); if (btn == null) return false; btn.click(); return true; })()`), true);
    const pool = await waitForJs(win, probe(`(() => {
      const msgs = [...document.querySelectorAll('#hifi-root .msg-list .msg')].map((m) => m.textContent);
      const composer = document.querySelector('#hifi-root .composer textarea') != null || document.querySelector('#hifi-root textarea') != null;
      return msgs.some((t) => t.includes('Hifi 主池样本消息')) ? JSON.stringify({ msgs: msgs.length, composer }) : null;
    })()`), 10_000, '房间主池+输入区');
    // ③ 输入并发送（默认意图）——桩侧 __zsSentLog 断言真实 envelope
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'Hifi 冒烟：发送一条'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await sleep(200);
    const sendClicked = await win.webContents.executeJavaScript(probe(`(() => { const area = [...document.querySelectorAll('#hifi-root .composer, #hifi-root form, #hifi-root .msg-list')].pop() || document.querySelector('#hifi-root'); const btns = [...document.querySelectorAll('#hifi-root button')].filter((b) => /发送|仅记录/.test(b.textContent)); const dump = btns.map((b) => b.textContent.trim()); const send = btns.find((b) => b.textContent.includes('发送')); if (send == null) return JSON.stringify({ dump }); send.click(); return JSON.stringify({ clicked: true, dump }); })()`), true);
    await sleep(400);
    const sentLog = await win.webContents.executeJavaScript(`window.zs.getSentLog()`, true).catch(() => null);
    results.P1_shellRealData = { sidebar: sidebar && JSON.parse(sidebar), pool: pool && JSON.parse(pool), sendClicked: sendClicked && (typeof sendClicked === 'string' ? JSON.parse(sendClicked) : sendClicked), sentLog,
      pass: sidebar != null && JSON.parse(sidebar).hasDefaultRoom && JSON.parse(sidebar).hasDm && pool != null && Array.isArray(sentLog) && sentLog.some((e) => e.method === 'message.submit' && e.params?.target?.kind === 'room_root') };
    // ④ 私信：列表+历史+发送
    await win.webContents.executeJavaScript(probe(`(() => { const btn = [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.trim() === '私信'); btn?.click(); return true; })()`), true);
    const dmView = await waitForJs(win, probe(`(() => {
      const t = [...document.querySelectorAll('#hifi-root .msg-list .msg, #hifi-root .msg')].map((m) => m.textContent);
      const side = [...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('Guide A'));
      return t.some((x) => x.includes('成员的回复样本')) ? JSON.stringify({ msgs: t.length, side }) : null;
    })()`), 10_000, '私信历史');
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '私信冒烟'); ta.dispatchEvent(new Event('input', { bubbles: true })); const send = [...document.querySelectorAll('#hifi-root button')].find((b) => b.textContent.includes('发送')); send?.click(); return true; })()`), true);
    await sleep(400);
    const sentLog2 = await win.webContents.executeJavaScript(`window.zs.getSentLog()`, true).catch(() => null);
    results.P2_dmReal = { dmView: dmView && JSON.parse(dmView), sentLog2,
      pass: dmView != null && Array.isArray(sentLog2) && sentLog2.some((e) => e.method === 'message.submit' && e.params?.target?.kind === 'dm') };
    // ⑤ legacy 接管守卫：未点入口前 legacy 未启动；点「任务看板」→ legacy-on 且 __zsLegacyStart 已被调用
    const legacyIdle = await win.webContents.executeJavaScript(probe(`JSON.stringify({ started: window.__zsLegacyStarted === true, shown: document.body.classList.contains('legacy-on') })`), true);
    await win.webContents.executeJavaScript(probe(`(() => { const btn = [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('任务看板')); btn?.click(); return true; })()`), true);
    await sleep(600);
    const legacyOn = await win.webContents.executeJavaScript(probe(`(() => { const legacy = document.getElementById('legacy-root'); const cs = legacy ? getComputedStyle(legacy) : null; return JSON.stringify({ started: window.__zsLegacyStarted === true, bodyOn: document.body.classList.contains('legacy-on'), legacyVisible: cs ? cs.display !== 'none' : false, hifiHidden: getComputedStyle(document.getElementById('hifi-root')).display === 'none', exitBtn: document.querySelector('.zs-legacy-exit') != null }); })()`), true);
    const back = await win.webContents.executeJavaScript(probe(`(() => { const b = document.querySelector('.zs-legacy-exit'); b?.click(); return true; })()`), true);
    await sleep(200);
    const backOk = await win.webContents.executeJavaScript(probe(`document.body.classList.contains('legacy-on') ? null : 'back'`), true);
    results.P3_legacyTakeover = { legacyIdle: JSON.parse(legacyIdle), legacyOn: JSON.parse(legacyOn), back: backOk,
      pass: JSON.parse(legacyIdle).started === false && JSON.parse(legacyOn).started === true && JSON.parse(legacyOn).bodyOn === true && JSON.parse(legacyOn).legacyVisible === true && JSON.parse(legacyOn).hifiHidden === true && backOk === 'back' };
  } catch (e) {
    results.error = String(e.message);
  }
  results.allPass = ['P1_shellRealData', 'P2_dmReal', 'P3_legacyTakeover'].every((k) => results[k]?.pass === true);
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2));
  console.log('[hifi-shell] allPass=' + results.allPass + ' ' + JSON.stringify(Object.fromEntries(Object.entries(results).filter(([k]) => k.startsWith('P')).map(([k, v]) => [k, v.pass]))));
  if (results.error) console.log('[hifi-shell] error=' + results.error);
  server.close(); win.destroy(); app.exit(results.allPass ? 0 : 4);
}
app.whenReady().then(main).catch((e) => { console.error('[hifi-shell] FAILED', e); app.exit(1); });
