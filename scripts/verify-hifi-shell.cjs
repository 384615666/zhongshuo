'use strict';
/**
 * 第四十七轮 H1 冒烟（升级为**合同校验型组件控制流/信封冒烟**——review-r46 §3：传输桩
 * 按正式 zod 合同严格校验参数，错误参数返回 VALIDATION_INVALID，不再无条件接受）：
 * HTTP 服务 dist/ui/renderer + 传输桩（window.zs）。真实后台闭环另见
 * tests/integration/hifiFirstPackage.test.ts（打包 UI→真实 dispatchDaemonCommand+worker）。
 * 断言：①侧栏/主池/私信=真实命令形状数据（含房间名单→@ 候选）②发送信封过正式合同
 * （room_root 带 roomId、mentions all→kind:all、intent default/record_only）③异步回执：
 * 成功清已发内容且**保留等待期编辑**、确定失败保留草稿+行内错误 ④定向接管定位
 * （任务看板→#board 可见；搜索→search-panel 打开）+样式隔离（hifi css disabled）+返回恢复。
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

const DATA = {
  project: { id: 'p1', displayName: 'Hifi 冒烟项目' },
  rooms: [
    { id: 'roomA', name: '默认房间', conversationId: 'convRoomA' },
    { id: 'roomB', name: 'Lab Room', conversationId: 'convRoomB' },
  ],
  projectMembers: [
    { id: 'mA', displayName: 'Guide A', principalType: 'agent', enabled: true },
    { id: 'mB', displayName: 'Guide B', principalType: 'agent', enabled: true },
    { id: 'u1', displayName: '我', principalType: 'human', enabled: true },
  ],
  pool: { items: [
    { threadId: 'th1', taskId: 'task_1', body: { text: 'Hifi 主池样本消息（真实 room.pool 形状）' }, createdAt: 1759500000000, replyCount: 2, unread: 0, taskStatus: 'ACTIVE' },
  ] },
  conversations: { conversations: [
    { conversationId: 'convDm1', peerDisplayName: 'Guide A', title: '冒烟私信', execState: 'idle', unread: 1, archivedAt: null, lastMessagePreview: '私信样本', projectId: 'p1' },
  ] },
  dmHistory: { messages: [
    { id: 'dm1', created_at: 1759500001000, author_type: 'human', author_id: 'u_local', body_json: JSON.stringify({ text: '发给成员的私信样本' }), conversation_seq: 1 },
    { id: 'dm2', created_at: 1759500002000, author_type: 'agent', author_id: 'mA', body_json: JSON.stringify({ text: '成员的回复样本' }), conversation_seq: 2 },
  ] },
};

/** 正式合同校验（messageSubmitParams/commands.ts:232 镜像子集——错误参数=VALIDATION_INVALID）。 */
function validateMessageSubmit(p) {
  if (p == null || typeof p !== 'object') return 'params 非对象';
  const t = p.target;
  if (t == null) return '缺 target';
  if (t.kind === 'room_root') {
    if (typeof t.projectId !== 'string' || !t.projectId || typeof t.conversationId !== 'string' || !t.conversationId || typeof t.roomId !== 'string' || !t.roomId) return 'room_root target 缺 projectId/conversationId/roomId';
  } else if (t.kind === 'dm') {
    if (typeof t.projectId !== 'string' || !t.projectId || typeof t.conversationId !== 'string' || !t.conversationId) return 'dm target 缺 projectId/conversationId';
  } else return `未知 target.kind=${t.kind}`;
  if (typeof p.body !== 'string' || p.body.length === 0) return '缺 body';
  if (p.intent !== 'default' && p.intent !== 'record_only') return `intent 非法：${p.intent}`;
  if (!Array.isArray(p.mentions)) return 'mentions 非数组';
  for (const m of p.mentions) {
    if (m == null || typeof m !== 'object') return 'mention 非对象';
    if (m.kind === 'member') { if (typeof m.memberId !== 'string' || !m.memberId) return 'member mention 缺 memberId'; }
    else if (m.kind === 'all') { if ('memberId' in m) return 'all mention 不应带 memberId'; }
    else return `mention kind 非法：${m.kind}`;
  }
  for (const k of Object.keys(p)) if (!['target', 'body', 'intent', 'mentions', 'attachmentRefs', 'imageAck', 'attachmentRanges'].includes(k)) return `未知字段 ${k}`;
  return null;
}

const PRELOAD = `
const { contextBridge } = require('electron');
const log = [];
const committed = {};
const DATA = ${JSON.stringify(DATA)};
const invalid = (msg) => ({ ok: false, error: { code: 'VALIDATION_INVALID', message: msg } });
const dispatch = (method, params, commandId) => {
  const D = DATA;
  switch (method) {
    case 'app.settings.get': {
      const keys = (params && params.keys) || [];
      if (!Array.isArray(keys)) return invalid('keys 非数组');
      const values = {};
      for (const k of keys) if (k === 'ui.autoOpenProjectPath' || k === 'repoStatus.visible') values[k] = k === 'ui.autoOpenProjectPath' ? 'D:\\\\zs-hifi-smoke\\\\proj' : '1';
      return { ok: true, data: { values } };
    }
    case 'project.open': {
      if (params == null || typeof params.path !== 'string' || params.path.length === 0) return invalid('project.open 要求 {path}（收到 ' + JSON.stringify(Object.keys(params || {})) + '）');
      return { ok: true, data: { project: D.project } };
    }
    case 'room.list': return { ok: true, data: { items: D.rooms } };
    case 'member.list': {
      if (params != null && params.roomId === 'roomB') return { ok: true, data: { items: D.projectMembers.filter((m) => m.id === 'mB') } };
      return { ok: true, data: { items: D.projectMembers } };
    }
    case 'room.pool': return { ok: true, data: D.pool };
    case 'conversation.list': return { ok: true, data: D.conversations };
    case 'conversation.history': return { ok: true, data: D.dmHistory };
    case 'conversation.markRead': return { ok: true, data: { advanced: true } };
    case 'message.submit': {
      const problem = (${validateMessageSubmit.toString()})(params);
      if (problem) return invalid('message.submit：' + problem);
      if (params.body.startsWith('FAILME')) return { ok: false, error: { code: 'CONTROLLED_FAILURE', message: '受控失败（合同冒烟）' } };
      if (params.body.startsWith('COMMITLOSE')) { committed[commandId] = JSON.parse(JSON.stringify(params)); return Promise.reject(new Error('TRANSPORT_LOST_AFTER_COMMIT')); }
      if (committed[commandId] != null) return { ok: true, data: { taskId: 'task_smoke', threadId: 'th_smoke', disposition: 'replayed' } };
      const delay = params.body.startsWith('共同前缀A') ? 1200 : 350;
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, data: { taskId: 'task_smoke', threadId: 'th_smoke', disposition: 'dispatched' } }), delay));
    }
    default: return { ok: true, data: {} };
  }
};
contextBridge.exposeInMainWorld('zs', {
  command: async (env) => { log.push({ method: env.method, params: env.params, commandId: env.commandId }); return dispatch(env.method, env.params, env.commandId); },
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
async function getSent(win) { return await win.webContents.executeJavaScript('window.zs.getSentLog()', true).catch(() => null) ?? []; }
async function typeAndSend(win, text, settleMs) {
  await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(text)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
  await sleep(150);
  await win.webContents.executeJavaScript(probe(`(() => { const send = [...document.querySelectorAll('#hifi-root button')].find((b) => /发送|保存记录/.test(b.textContent) && b.textContent.length <= 6); if (send == null) return false; send.click(); return true; })()`), true);
  if (settleMs) await sleep(settleMs);
}

async function main() {
  const preloadPath = path.join(OUT, 'stub-preload.cjs');
  fs.writeFileSync(preloadPath, PRELOAD, 'utf8');
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, useContentSize: true, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } });
  const results = { scope: '组件控制流+信封冒烟（传输桩按正式 zod 合同校验参数）——真实后台闭环见 hifiFirstPackage.test.ts' };
  try {
    await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
    await waitForJs(win, `window.__zsReady === true ? 'ready' : null`, 10_000, '__zsReady(legacy 绑定)');
    await waitForJs(win, `document.body.classList.contains('hifi-on') ? 'hifi' : null`, 10_000, 'hifi 壳挂载');

    // ---------- P1 侧栏/主池/房间名单（@ 候选来自 member.list({roomId})） ----------
    await win.webContents.executeJavaScript(probe(`(() => { const btn = [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间')); btn?.click(); return true; })()`), true);
    // 第五十一轮 H2：主池条目=线程卡（.root-card——H1 的 .msg 形态已由 ThreadCard 取代）。
    const p1 = await waitForJs(win, probe(`(() => {
      const cards = [...document.querySelectorAll('#hifi-root .msg-list .root-card')].map((m) => m.textContent);
      return cards.some((t) => t.includes('Hifi 主池样本消息')) ? JSON.stringify({ cards: cards.length, composer: document.querySelector('#hifi-root textarea') != null }) : null;
    })()`), 10_000, '房间主池（线程卡）+输入区');
    await win.webContents.executeJavaScript(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('Lab Room'))?.click(); return true; })()`), true);
    await sleep(300);
    await win.webContents.executeJavaScript(probe(`(() => { const atBtn = [...document.querySelectorAll('#hifi-root button')].find((b) => (b.title || '').includes('提及成员')); atBtn?.click(); return true; })()`), true);
    await sleep(250); // React 状态更新后一帧再读候选
    const roster = await win.webContents.executeJavaScript(probe(`(() => {
      const items = [...document.querySelectorAll('#hifi-root .mention-pop .menu-item')].map((b) => b.textContent);
      return JSON.stringify({ items });
    })()`), true);
    results.P1_shellRealData = {
      pool: p1 != null ? JSON.parse(p1) : null,
      roster: roster != null && roster.startsWith('{') ? JSON.parse(roster) : roster,
      pass: p1 != null && (() => { try { const r = JSON.parse(String(roster)); return Array.isArray(r.items) && r.items.length === 2 && r.items.some((t) => t.includes('Guide B')) && !r.items.join().includes('Guide A'); } catch { return false; } })(),
    };

    // ---------- P2 发送合同：Lab Room 发送（含 @全体）→ 信封过合同 + 成功清已发内容且保留等待期编辑 ----------
    await win.webContents.executeJavaScript(probe(`(() => { const atBtn = [...document.querySelectorAll('#hifi-root button')].find((b) => (b.title || '').includes('提及成员')); atBtn?.click(); const all = [...document.querySelectorAll('#hifi-root .mention-pop .menu-item')].find((b) => b.textContent.includes('全体')); all?.click(); return true; })()`), true);
    await typeAndSend(win, '合同冒烟：给全体发一条', 120); // 发送在途 350ms——立即补打「等待期编辑」
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '等待期追加的内容'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await sleep(900);
    const p2sent = (await getSent(win)).filter((e) => e.method === 'message.submit');
    const taAfter = await win.webContents.executeJavaScript(probe(`document.querySelector('#hifi-root textarea')?.value ?? null`), true);
    const p2envelope = p2sent.find((e) => e.params?.target?.roomId === 'roomB') ?? null;
    results.P2_sendContract = {
      envelope: p2envelope, textareaAfter: taAfter,
      pass: p2envelope != null && p2envelope.params.intent === 'default' && Array.isArray(p2envelope.params.mentions) && p2envelope.params.mentions.some((m) => m.kind === 'all') && taAfter === '等待期追加的内容',
    };

    // ---------- P3 仅记录：意图 record_only ----------
    await win.webContents.executeJavaScript(probe(`(() => { const more = [...document.querySelectorAll('#hifi-root button')].find((b) => b.getAttribute('aria-label') === '本次运行设置'); more?.click(); return true; })()`), true);
    await sleep(200);
    await win.webContents.executeJavaScript(probe(`(() => { const item = [...document.querySelectorAll('#hifi-root .menu-item')].find((b) => b.textContent.includes('仅记录')); item?.click(); return true; })()`), true);
    await sleep(150);
    await typeAndSend(win, '仅记录样本', 700);
    const p3envelope = (await getSent(win)).find((e) => e.method === 'message.submit' && e.params?.body === '仅记录样本') ?? null;
    results.P3_recordOnly = { envelope: p3envelope, pass: p3envelope != null && p3envelope.params.intent === 'record_only' };

    // ---------- P4 确定失败：草稿保留+行内错误（受控 CONTROLLED_FAILURE） ----------
    await typeAndSend(win, 'FAILME 这条会失败', 900);
    const taFailed = await win.webContents.executeJavaScript(probe(`document.querySelector('#hifi-root textarea')?.value ?? null`), true);
    const inlineErr = await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .composer-draft.failed')].some((e) => e.textContent.includes('发送失败'))`), true);
    const failedCalls = (await getSent(win)).filter((e) => e.method === 'message.submit' && String(e.params?.body ?? '').startsWith('FAILME'));
    results.P4_failureKeepsDraft = { textareaAfter: taFailed, inlineError: inlineErr, failedCalls: failedCalls.length,
      pass: taFailed === 'FAILME 这条会失败' && inlineErr === true && failedCalls.length === 1 };

    // ---------- P5 定向接管 + 样式隔离 + 返回恢复 ----------
    const cssBefore = await win.webContents.executeJavaScript(probe(`(() => { const l = document.querySelector('link[href="hifi/app.css"]'); return JSON.stringify({ disabled: l?.disabled ?? null, legacyOn: document.body.classList.contains('legacy-on'), board: getComputedStyle(document.getElementById('board')).display }); })()`), true);
    await win.webContents.executeJavaScript(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('任务看板'))?.click(); return true; })()`), true);
    const takeover = await waitForJs(win, probe(`(() => {
      const board = document.getElementById('board');
      const l = document.querySelector('link[href="hifi/app.css"]');
      const boardVisible = board != null && !board.classList.contains('hidden') && getComputedStyle(board).display !== 'none';
      const cssDisabled = l != null && l.disabled === true;
      const legacyStarted = window.__zsLegacyStarted === true;
      return (boardVisible && cssDisabled && legacyStarted) ? JSON.stringify({ legacyOn: document.body.classList.contains('legacy-on'), boardDisplay: getComputedStyle(board).display, boardVisible, cssDisabled, legacyStarted }) : null;
    })()`), 15_000, '定向接管定位（任务看板）');
    await win.webContents.executeJavaScript(probe(`(() => { document.querySelector('.zs-legacy-exit')?.click(); return true; })()`), true);
    await sleep(400);
    await win.webContents.executeJavaScript(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('搜索与收藏'))?.click(); return true; })()`), true);
    const searchLocated = await waitForJs(win, probe(`(() => { const d = document.getElementById('search-panel'); return (d != null && d.open === true && document.body.classList.contains('legacy-on')) ? JSON.stringify({ open: true, legacyOn: true }) : null; })()`), 15_000, '定向接管定位（搜索与收藏）');
    await win.webContents.executeJavaScript(probe(`(() => { document.querySelector('.zs-legacy-exit')?.click(); return true; })()`), true);
    await sleep(500);
    const backState = await win.webContents.executeJavaScript(probe(`(() => { const l = document.querySelector('link[href="hifi/app.css"]'); return JSON.stringify({ legacyOn: document.body.classList.contains('legacy-on'), cssReenabled: l != null && l.disabled === false, legacyPaused: window.__zsLegacyPaused === true, hifiVisible: getComputedStyle(document.getElementById('hifi-root')).display !== 'none' }); })()`), true);
    results.P5_targetedTakeover = {
      cssBefore: JSON.parse(cssBefore), takeover: takeover != null ? JSON.parse(takeover) : null,
      searchLocated: searchLocated != null ? JSON.parse(searchLocated) : null, back: JSON.parse(backState),
      pass: takeover != null && (() => { const t = JSON.parse(takeover); return t.legacyOn === true && t.boardVisible === true && t.cssDisabled === true && t.legacyStarted === true; })()
        && searchLocated != null && (() => { const b = JSON.parse(backState); return b.legacyOn === false && b.cssReenabled === true && b.legacyPaused === true && b.hifiVisible === true; })(),
    };

    // ---------- P6 私信：历史真实形状（snake_case 映射+作者）+ DM 发送合同 ----------
    await win.webContents.executeJavaScript(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.trim() === '私信')?.click(); return true; })()`), true);
    const dmView = await waitForJs(win, probe(`(() => {
      const msgs = [...document.querySelectorAll('#hifi-root .msg')].map((m) => m.textContent);
      return msgs.some((x) => x.includes('成员的回复样本')) && msgs.some((x) => x.includes('Guide A')) ? JSON.stringify({ msgs: msgs.length }) : null;
    })()`), 10_000, '私信历史');
    await typeAndSend(win, '私信合同冒烟', 700);
    const dmSent = (await getSent(win)).filter((e) => e.method === 'message.submit' && e.params?.body === '私信合同冒烟');
    results.P6_dmContract = { dmView: dmView != null ? JSON.parse(dmView) : null, envelope: dmSent[0] ?? null,
      pass: dmView != null && dmSent.length === 1 && dmSent[0].params.target.kind === 'dm' && dmSent[0].params.target.conversationId === 'convDm1' };
    // ---------- P7 结果未知：冻结原信封——新编辑=新信封；重发=原信封且服务重放幂等 ----------
    await win.webContents.executeJavaScript(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(); return true; })()`), true);
    await sleep(400);
    await typeAndSend(win, 'COMMITLOSE 原始内容', 800);
    const p7banner1 = await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((e) => e.textContent.includes('结果未知'))`), true);
    const p7ta1 = await win.webContents.executeJavaScript(probe(`document.querySelector('#hifi-root textarea')?.value ?? null`), true);
    await typeAndSend(win, 'COMMITLOSE 原始内容＋新编辑的新信封', 800);
    const p7sends = (await getSent(win)).filter((e) => e.method === 'message.submit');
    const p7orig = p7sends.find((e) => e.params?.body === 'COMMITLOSE 原始内容');
    const p7edited = p7sends.find((e) => e.params?.body === 'COMMITLOSE 原始内容＋新编辑的新信封');
    const retryClicked = await win.webContents.executeJavaScript(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .chip.record-chip button')].find((x) => x.textContent.includes('重发原内容')); if (b == null) return false; b.click(); return true; })()`), true);
    await sleep(700);
    const p7retry = (await getSent(win)).filter((e) => e.method === 'message.submit' && e.commandId === p7orig?.commandId);
    const p7bannerAfter = await win.webContents.executeJavaScript(probe(`[...document.querySelectorAll('#hifi-root .chip.record-chip')].some((e) => e.textContent.includes('结果未知'))`), true);
    // 去假阳性（review-r48 §3）：完整参数逐字段一致（不只正文）+ 重试后无失败行内错误（ok 才清 banner）。
    const paramsEqual = p7orig != null && p7retry.length >= 2 && p7retry.every((e) => JSON.stringify(e.params) === JSON.stringify(p7orig.params));
    const noFailureAfterRetry = await win.webContents.executeJavaScript(probe(`![...document.querySelectorAll('#hifi-root .composer-draft.failed')].some((e) => e.textContent.includes('重发失败') || e.textContent.includes('发送失败'))`), true);
    results.P7_unknownEnvelope = { diff: { orig: p7orig && JSON.stringify(p7orig.params), retry0: p7retry[0] && JSON.stringify(p7retry[0].params), retry1: p7retry[1] && JSON.stringify(p7retry[1].params) }, bannerAtUnknown: p7banner1, textareaKept: p7ta1, origId: p7orig?.commandId, editedId: p7edited?.commandId, retryCount: p7retry.length, retryBody: p7retry[p7retry.length - 1]?.params?.body, paramsEqual, noFailureAfterRetry, bannerAfterRetry: p7bannerAfter,
      pass: p7banner1 === true && p7ta1 === 'COMMITLOSE 原始内容' && p7orig != null && p7edited != null && p7orig.commandId !== p7edited.commandId && retryClicked === true && p7retry.length === 2 && p7retry[0].params.body === 'COMMITLOSE 原始内容' && paramsEqual === true && noFailureAfterRetry === true };

    // ---------- P8 迟到成功只清发起目标 ----------
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '共同前缀A'); ta.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('#hifi-root button')].find((b) => b.textContent.trim() === '发送')?.click(); return true; })()`), true);
    await win.webContents.executeJavaScript(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('Lab Room'))?.click(); return true; })()`), true);
    await sleep(300);
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, 'B 的独立草稿'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await sleep(1400);
    const p8b = await win.webContents.executeJavaScript(probe(`document.querySelector('#hifi-root textarea')?.value ?? null`), true);
    await win.webContents.executeJavaScript(probe(`(() => { [...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(); return true; })()`), true);
    await sleep(400);
    const p8a = await win.webContents.executeJavaScript(probe(`document.querySelector('#hifi-root textarea')?.value ?? null`), true);
    results.P8_crossTargetSettle = { bDraftAfterLateAck: p8b, aDraftAfterReturn: p8a,
      pass: p8b === 'B 的独立草稿' && (p8a === '' || p8a === null) };

    // ---------- P9 双击恰一次 + IME 组合态 Enter 不发送 ----------
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '双击与输入法样本'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), true);
    await sleep(150);
    const before9 = (await getSent(win)).filter((e) => e.method === 'message.submit').length;
    await win.webContents.executeJavaScript(probe(`(() => { const send = [...document.querySelectorAll('#hifi-root button')].find((b) => b.textContent.trim() === '发送'); send.click(); send.click(); return true; })()`), true);
    await win.webContents.executeJavaScript(probe(`(() => { const ta = document.querySelector('#hifi-root textarea'); const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '输入法组合中'); ta.dispatchEvent(new Event('input', { bubbles: true })); const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); Object.defineProperty(ev, 'isComposing', { value: true }); ta.dispatchEvent(ev); return true; })()`), true);
    await sleep(800);
    const after9 = (await getSent(win)).filter((e) => e.method === 'message.submit').length;
    const imeSent = (await getSent(win)).some((e) => e.method === 'message.submit' && e.params?.body === '输入法组合中');
    results.P9_doubleClickIme = { sendsByDoubleClicked: after9 - before9, imeSent,
      pass: after9 - before9 === 1 && imeSent === false };
  } catch (e) {
    results.error = String(e.message);
  }
  results.allPass = ['P1_shellRealData', 'P2_sendContract', 'P3_recordOnly', 'P4_failureKeepsDraft', 'P5_targetedTakeover', 'P6_dmContract', 'P7_unknownEnvelope', 'P8_crossTargetSettle', 'P9_doubleClickIme'].every((k) => results[k]?.pass === true);
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2));
  console.log('[hifi-shell] allPass=' + results.allPass + ' ' + JSON.stringify(Object.fromEntries(Object.entries(results).filter(([k]) => /^P\d/.test(k)).map(([k, v]) => [k, v && v.pass]))));
  if (results.error) console.log('[hifi-shell] error=' + results.error);
  server.close(); win.destroy(); app.exit(results.allPass ? 0 : 4);
}
app.whenReady().then(main).catch((e) => { console.error('[hifi-shell] FAILED', e); app.exit(1); });
