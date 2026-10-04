'use strict';
/**
 * 第四十三轮（review-r42 §3 / v5 现场 UI-01/02/03/04）：隐藏契约·阅读空间·预览展开·监听同步
 * ——**实际打包页面**（dist/ui/renderer，真实 style.css/index.html/app.js 产物）级验证。
 * 第四十四轮 §3 增 U6：私信视图下显式打开看板/Files/动态必须可见（统一视图状态——
 * 布尔守卫/hidden 类/data-view 三者不再互相矛盾），关闭返回原视图且草稿保留。
 * 只有传输层（window.zs 命令面）为确定性桩——DOM/CSS/布局/产品控制流全真实：
 * 启动→记忆轮询装载项目→侧栏点击切房/切私信/开线程→点附件芯片开预览→关/展开。
 * 全部断言用 **computedStyle + getBoundingClientRect 实际尺寸**（review：禁止以
 * classList.contains('hidden') 或 DOM 存在替代可见性判定）；常规窗口（1280×800）与
 * 用户宽屏（1920×1080）双档复核。运行：
 *   ./node_modules/.bin/electron scripts/verify-ui-hidden-layout.cjs
 * 产物：dist/desktop/ui-hidden-layout/metrics.json；exit 0=全过。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const PAGE = path.join(root, 'dist/ui/renderer/index.html');
const OUT = path.join(root, 'dist/desktop/ui-hidden-layout');
fs.mkdirSync(OUT, { recursive: true });

const docxB64 = fs.readFileSync(path.join(root, 'scripts/dev25-dual/samples/word-r7-sample.docx')).toString('base64');
const pptxB64 = fs.readFileSync(path.join(root, 'dist/desktop/preview-select/samples/rich-deck.pptx')).toString('base64');

/** 传输桩：确定性数据（真实命令响应形状）；未知方法回空 data（只读渲染路径容忍）。 */
const PRELOAD = `
const { contextBridge, ipcRenderer } = require('electron');
const DATA = ${JSON.stringify({
  rememberedPath: 'D:\\\\zs-layout-drill\\\\proj',
  project: { id: 'p1', displayName: '布局演练项目', revision: 0, taskReviewEnabled: false },
  rooms: [
    { id: 'roomA', name: '默认房间', conversationId: 'convRoomA' },
    { id: 'roomB', name: 'Lab Room', conversationId: 'convRoomB' },
  ],
  members: { items: [
    { id: 'mA', displayName: 'Guide A', principalType: 'agent', enabled: true },
    { id: 'mB', displayName: 'Guide B', principalType: 'agent', enabled: true },
  ] },
  pool: { items: [
    { threadId: 'th1', taskId: 'task_1', createdAt: Date.now(), unread: 0, body: { text: '主池样本任务（点卡片打开回复串）' }, replyCount: 2, taskStatus: 'ACTIVE' },
  ] },
  conversations: { conversations: [
    { conversationId: 'convDm', peerDisplayName: 'Guide A', title: '布局演练私信', execState: 'idle', unread: 0, archivedAt: null, interruptedTasks: [], lastMessagePreview: '私信样本消息' },
  ] },
  dmHistory: { messages: [
    { id: 'dm1', createdAt: Date.now(), authorType: 'human', body: { text: '私信样本消息（附件芯片可点预览——阅读区不应被挤成细条）' }, attachments: [] },
  ] },
  threadHistory: { items: [
    { id: 'tm1', createdAt: Date.now(), authorType: 'human', body: { text: '线程根下样本回复' }, attachments: [
      { artifactId: 'attTxt', filename: 'note.txt', hash: 'aabbccdd11223344', revision: 1, kind: 'text_file' },
      { artifactId: 'attDoc', filename: 'word-r7-sample.docx', hash: 'ccdd1122aabb3344', revision: 1, kind: 'docx_file' },
      { artifactId: 'attPpt', filename: 'rich-deck.pptx', hash: 'eeff1122aabb5566', revision: 1, kind: 'slides_file' },
    ] },
  ], rootAttachments: [] },
  previewText: { kind: 'text_file', filename: 'note.txt', hash: 'aabbccdd11223344556677889900aabb', revision: 1, originalBytes: 640, truncated: false, excerptBytes: 640, text: '布局演练样本文本。\\n' + '第四十三轮隐藏契约与阅读空间验证——预览打开时工具行应收起，关闭后面板不占空间。\\n'.repeat(12) },
  previewOffice: {
    attDoc: { kind: 'docx_file', filename: 'word-r7-sample.docx', hash: 'ccdd1122aabb3344556677889900ccdd', revision: 1, parser: 'mammoth', sourceFormat: 'docx', html: '<p>提取文本样本（模型输入真源——与视觉分列）</p>', paragraphCount: 2, visualBytesAvailable: true, bytesBase64: '__DOCX__' },
    attPpt: { kind: 'slides_file', filename: 'rich-deck.pptx', hash: 'eeff1122aabb5566778899001122eeff', revision: 1, parser: 'server-side-text', sourceFormat: 'pptx', slides: [
      { slide: 1, text: '第一页样本文本（标题页）', notes: '', truncated: false },
      { slide: 2, text: '第二页样本文本（要点列表）', notes: '演讲备注样本', truncated: false },
      { slide: 3, text: '第三页样本文本（图表页——视觉通道渲染）', notes: '', truncated: false },
    ], visualBytesAvailable: true, bytesBase64: '__PPTX__' },
  },
  remoteConfig: { running: true, address: 'https://192.168.1.100:52892', fingerprint: 'AB'.repeat(32), caFingerprint: 'CD'.repeat(32), certSubject: 'CN=zhongshuo', certIssuer: 'CN=zhongshuo-ca', certNotAfter: Date.now() + 90 * 86400_000, listenHost: '0.0.0.0', port: 52892, allowLan: true, lanAddressDetails: [], lanAddresses: ['192.168.1.100'] },
  devices: { devices: [] },
  boardView: { groups: [{ projectId: 'p1', displayName: '布局演练项目', rooms: [{ roomId: 'roomA', name: '默认房间', cards: [
    { taskId: 'task_1', title: '看板样本任务', column: 'running', taskStatus: 'ACTIVE', runStatus: 'RUNNING', runId: 'run_stub_1', stopGeneration: 0, exitUnconfirmed: false, pendingDelivery: null, locate: '#task=task_1' },
  ] }] }], note: 'U6 桩' },
  filesView: { groups: [{ projectId: 'p1', displayName: '布局演练项目', projectFilesNote: 'U6 桩数据根（工具入口可见性验证）', attachments: [], drafts: [], deliveries: [] }] },
  activityList: { items: [
    { at: Date.now(), seq: 2, kindLabel: '消息', projectName: '布局演练项目', summary: 'U6 动态样本行二', locate: null },
    { at: Date.now(), seq: 1, kindLabel: '任务创建', projectName: '布局演练项目', summary: 'U6 动态样本行', locate: '#task=task_1' },
  ] },
})};
const dispatch = (method, params) => {
  const D = DATA;
  switch (method) {
    case 'app.settings.get': {
      const keys = (params && params.keys) || [];
      const values = {};
      for (const k of keys) if (k === 'ui.autoOpenProjectPath') values[k] = D.rememberedPath;
      return { ok: true, data: { values } };
    }
    case 'app.settings.set': return { ok: true, data: {} };
    case 'project.open': return { ok: true, data: { project: D.project } };
    case 'room.list': return { ok: true, data: { items: D.rooms } };
    case 'member.list': return { ok: true, data: D.members };
    case 'room.pool': return { ok: true, data: D.pool };
    case 'conversation.list': return { ok: true, data: D.conversations };
    case 'conversation.history': return { ok: true, data: D.dmHistory };
    case 'thread.history': return { ok: true, data: D.threadHistory };
    case 'attachment.previewText': return { ok: true, data: D.previewText };
    case 'attachment.previewOffice': return { ok: true, data: D.previewOffice[(params && params.attachmentId)] || { ok: false } };
    case 'remote.config.get': return { ok: true, data: D.remoteConfig };
    case 'remote.devices.list': return { ok: true, data: D.devices };
    case 'board.view': return { ok: true, data: D.boardView };
    case 'files.view': return { ok: true, data: D.filesView };
    case 'activity.list': return { ok: true, data: D.activityList };
    default: return { ok: true, data: {} };
  }
};
contextBridge.exposeInMainWorld('zs', {
  command: async (envelope) => dispatch(envelope.method, envelope.params),
  pickFolder: async () => null,
  openPath: async () => {},
  onDisconnect: () => {},
  onReconnected: () => {},
  onDemoStatus: () => {},
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面经本地 HTTP 提供（产品=zsres:// 特权协议；file:// 会被 ESM 模块 CORS 拦截——
 * 渲染器侧加载 vendor 模块的正式路径需要非 file 起源。静态映射 dist/ui/renderer）。 */
const http = require('http');
const RENDERER_DIR = path.join(root, 'dist/ui/renderer');
const PORT = 48217;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.mjs': 'text/javascript' };
const server = http.createServer((req, res) => {
  const rel = req.url.split('?')[0].replace(/^\/+/, '') || 'index.html';
  const file = path.join(RENDERER_DIR, rel.replace(/\.\./g, ''));
  if (!file.startsWith(RENDERER_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

async function waitForJs(win, iife, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await win.webContents.executeJavaScript(iife, true).catch((e) => { void e; return null; });
    if (v) return v;
    if (Date.now() - t0 > ms) { console.warn('[ui-hidden-layout] 等待超时：' + label); return null; }
    await sleep(150);
  }
}

const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
const vis = (sel) => probe(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e == null) return null; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return JSON.stringify({ display: cs.display, maxHeight: cs.maxHeight, resize: cs.resize, w: Math.round(r.width), h: Math.round(r.height) }); })()`);

async function main() {
  const preloadPath = path.join(OUT, 'stub-preload.cjs');
  fs.writeFileSync(preloadPath, PRELOAD.replace('__DOCX__', docxB64).replace('__PPTX__', pptxB64), 'utf8');
  const { BrowserWindow } = require('electron');
  const results = {};
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800, useContentSize: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  await win.loadURL(`http://127.0.0.1:${PORT}/index.html`);
  await waitForJs(win, `window.__zsReady === true ? 'ready' : null`, 10_000, '__zsReady');
  // 首启记忆轮询装载（P0：不靠 reload/手动打开——记忆出现即自动可见）。
  const loaded = await waitForJs(win, probe(`document.querySelectorAll('#room-list .room-item').length >= 2 && document.querySelector('#project-name').textContent.includes('布局演练项目') ? document.querySelector('#project-name').textContent : null`), 20_000, '首启自动装载');
  results.P0_firstAutoLoad = { projectLine: loaded, pass: loaded != null };

  // ---------- U1 隐藏契约 + 私信阅读空间（常规窗口 1280×800） ----------
  {
    const poolBefore = JSON.parse(await win.webContents.executeJavaScript(vis('#pool'), true));
    const composerBefore = JSON.parse(await win.webContents.executeJavaScript(vis('footer.composer'), true));
    const repoBefore = JSON.parse(await win.webContents.executeJavaScript(vis('#repo-status'), true));
    // 切私信（真实控制流：侧栏按钮点击）。
    await win.webContents.executeJavaScript(probe(`(() => { const b = document.querySelector('#dm-list button'); if (b == null) return false; b.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('main.main')?.getAttribute('data-view') === 'dm' && getComputedStyle(document.getElementById('dm')).display !== 'none' ? 'dm' : null`), 5000, 'DM 视图');
    const poolDm = JSON.parse(await win.webContents.executeJavaScript(vis('#pool'), true));
    const composerDm = JSON.parse(await win.webContents.executeJavaScript(vis('footer.composer'), true));
    const repoDm = JSON.parse(await win.webContents.executeJavaScript(vis('#repo-status'), true));
    const dmMsgs = JSON.parse(await win.webContents.executeJavaScript(vis('#dm-messages'), true));
    const dmComposer = JSON.parse(await win.webContents.executeJavaScript(vis('#dm .composer-row'), true));
    const mainH = await win.webContents.executeJavaScript(probe(`document.querySelector('main.main').getBoundingClientRect().height`), true);
    // 回主池：恢复（偏好开关不动）。
    await win.webContents.executeJavaScript(probe(`(() => { const b = document.querySelector('#room-list .room-item'); b.click(); return true; })()`), true);
    await waitForJs(win, probe(`getComputedStyle(document.getElementById('pool')).display !== 'none' ? 'pool' : null`), 5000, '回主池');
    const poolBack = JSON.parse(await win.webContents.executeJavaScript(vis('#pool'), true));
    const repoBack = JSON.parse(await win.webContents.executeJavaScript(vis('#repo-status'), true));
    results.U1_hiddenContract = {
      poolBefore, composerBefore, repoBefore, poolInDm: poolDm, composerInDm: composerDm, repoInDm: repoDm,
      dmMessages: dmMsgs, dmOwnComposer: dmComposer, mainHeight: mainH, poolBack, repoBack,
      pass: poolBefore.display !== 'none' && composerBefore.display !== 'none' && repoBefore.display !== 'none'
        && poolDm.display === 'none' && poolDm.h === 0 // 主池真正收起（不占布局）
        && composerDm.display === 'none' && composerDm.h === 0 // 主池输入区收起
        && repoDm.display === 'none'
        && dmMsgs.display !== 'none' && dmMsgs.h >= 0.55 * mainH // 阅读区过半（不再细条）
        && dmComposer.display !== 'none'
        && poolBack.display !== 'none' && repoBack.display !== 'none', // 返回恢复
    };
  }

  // ---------- U2 关闭预览真正消失（R6 现场反例）+ 工具行让位/恢复 ----------
  {
    await win.webContents.executeJavaScript(probe(`(() => { const c = document.querySelector('#pool .pool-card'); c.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelectorAll('#thread-messages .msg').length >= 1 ? 'thread' : null`), 5000, '线程视图');
    const repoThread = JSON.parse(await win.webContents.executeJavaScript(vis('#repo-status'), true));
    await win.webContents.executeJavaScript(probe(`(() => { const chips = [...document.querySelectorAll('#thread-messages .attach-chips .chip')]; const t = chips.find((c) => c.textContent.includes('note.txt')); if (t == null) return false; t.click(); return true; })()`), true);
    const panelOpen = await waitForJs(win, probe(`(() => { const e = document.getElementById('attach-preview'); const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return !e.classList.contains('hidden') && cs.display !== 'none' && r.height > 100 ? JSON.stringify({ display: cs.display, h: Math.round(r.height), barVisible: getComputedStyle(document.getElementById('attach-preview-bar')).display !== 'none' }) : null; })()`), 8000, '文本预览打开');
    const repoWhilePreview = JSON.parse(await win.webContents.executeJavaScript(vis('#repo-status'), true));
    // 关闭（R6 现场：「关闭预览」无反应——现必须真正消失且不占空间）。
    await win.webContents.executeJavaScript(probe(`(() => { const b = [...document.querySelectorAll('#attach-preview button')].find((x) => x.textContent.includes('关闭')); if (b == null) return false; b.click(); return true; })()`), true);
    const panelClosed = await waitForJs(win, probe(`(() => { const e = document.getElementById('attach-preview'); const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return cs.display === 'none' && r.height === 0 && getComputedStyle(document.getElementById('attach-preview-bar')).display === 'none' ? JSON.stringify({ display: cs.display, h: Math.round(r.height) }) : null; })()`), 5000, '关闭预览');
    const repoAfterClose = JSON.parse(await win.webContents.executeJavaScript(vis('#repo-status'), true));
    results.U2_closePreview = {
      repoInThread: repoThread, panelOpen: panelOpen && JSON.parse(panelOpen), repoWhilePreview, panelClosed: panelClosed && JSON.parse(panelClosed), repoAfterClose,
      pass: repoThread.display !== 'none' && panelOpen != null
        && repoWhilePreview.display === 'none' // 预览打开→工具行让位
        && panelClosed != null
        && repoAfterClose.display !== 'none', // 关闭→恢复
    };
  }

  // ---------- U3 Word/PPT 预览区足够+可展开（视觉与提取文本分列保留） ----------
  {
    const docxInfo = await openOfficeAndMeasure(win, 'word-r7-sample.docx', '.docx-visual-box');
    const expand1 = await win.webContents.executeJavaScript(probe(`(() => { const b = document.getElementById('attach-preview-expand'); if (b == null) return false; b.click(); return true; })()`), true);
    await sleep(300);
    const docxExpanded = JSON.parse(await win.webContents.executeJavaScript(vis('.docx-visual-box'), true));
    const panelExpanded = JSON.parse(await win.webContents.executeJavaScript(vis('#attach-preview'), true));
    // 展开下重开 PPT（真实 R6 载荷）。
    const pptInfo = await openOfficeAndMeasure(win, 'rich-deck.pptx', '.pptx-visual-stage');
    const resizeProp = await win.webContents.executeJavaScript(probe(`getComputedStyle(document.getElementById('attach-preview')).resize`), true);
    // 收尾：关闭。
    await win.webContents.executeJavaScript(probe(`document.getElementById('attach-preview-collapse').click(); true`), true);
    const closedAfterAll = await waitForJs(win, probe(`getComputedStyle(document.getElementById('attach-preview')).display === 'none' ? 'closed' : null`), 5000, '收尾关闭');
    results.U3_previewArea = {
      docx: docxInfo, docxExpanded, panelExpanded, ppt: pptInfo, resizeProp, closedAfterAll,
      pass: docxInfo != null && docxInfo.box.h >= 300 && docxInfo.extractedVisible
        && expand1 === true && docxExpanded.maxHeight !== 'none' && parseFloat(docxExpanded.maxHeight) > parseFloat(docxInfo.box.maxHeight)
        && pptInfo != null && pptInfo.box.h >= 300
        && resizeProp === 'vertical' && closedAfterAll != null,
    };
  }

  // ---------- U4 监听选择框与运行事实同步（UI-04） ----------
  {
    const selState1 = await win.webContents.executeJavaScript(probe(`(() => { const s = document.getElementById('remote-host-sel'); const row = document.getElementById('remote-config-row'); return JSON.stringify({ value: s.value, applied: row.textContent.includes('已应用配置'), lan: row.textContent.includes('局域网') }); })()`), true);
    // 用户编辑（dirty）后刷新不覆盖。
    await win.webContents.executeJavaScript(probe(`(() => { const s = document.getElementById('remote-host-sel'); s.value = '127.0.0.1'; s.dispatchEvent(new Event('change')); const d = document.getElementById('remote-settings'); d.open = true; d.dispatchEvent(new Event('toggle')); return true; })()`), true);
    await sleep(300);
    const selState2 = await win.webContents.executeJavaScript(probe(`(() => { const s = document.getElementById('remote-host-sel'); const row = document.getElementById('remote-config-row'); return JSON.stringify({ value: s.value, dirtyNote: row.textContent.includes('未应用的编辑') }); })()`), true);
    results.U4_remoteSync = {
      synced: JSON.parse(selState1), afterEditRefresh: JSON.parse(selState2),
      pass: JSON.parse(selState1).value === '0.0.0.0' && JSON.parse(selState1).applied && JSON.parse(selState1).lan
        && JSON.parse(selState2).value === '127.0.0.1' && JSON.parse(selState2).dirtyNote, // 运行事实同步+编辑不被覆盖
    };
  }

  // ---------- U5 宽屏复核（1920×1080）：阅读区/预览尺寸仍成立 ----------
  {
    win.setContentSize(1920, 1080);
    await sleep(400);
    await win.webContents.executeJavaScript(probe(`(() => { const b = document.querySelector('#dm-list button'); b.click(); return true; })()`), true);
    await waitForJs(win, probe(`document.querySelector('main.main')?.getAttribute('data-view') === 'dm' ? 'dm' : null`), 5000, '宽屏 DM');
    const dmWide = JSON.parse(await win.webContents.executeJavaScript(vis('#dm-messages'), true));
    const poolWide = JSON.parse(await win.webContents.executeJavaScript(vis('#pool'), true));
    const mainW = await win.webContents.executeJavaScript(probe(`document.querySelector('main.main').getBoundingClientRect().width`), true);
    results.U5_widescreen = {
      dmMessages: dmWide, poolInDm: poolWide, mainWidth: mainW,
      pass: poolWide.display === 'none' && poolWide.w === 0 && dmWide.display !== 'none' && dmWide.w >= 0.6 * mainW && dmWide.h >= 0.55 * 1080,
    };
  }

  // ---------- U6 显式工具入口（第四十四轮 §3 / review-r43 §5 反例：DM 中点看板/Files/动态必须可见） ----------
  {
    // U5 结束态：宽屏 DM 视图。先在 DM 输入框留草稿（暂离工具返回后必须保留）。
    await win.webContents.executeJavaScript(probe(`(() => { document.getElementById('dm-input').value = 'draft-U6'; return true; })()`), true);
    await win.webContents.executeJavaScript(probe(`document.getElementById('board-toggle').click(); true`), true);
    const openBoard = await waitForJs(win, probe(`(() => { const b = document.getElementById('board'); const dm = document.getElementById('dm'); const v = document.querySelector('main.main')?.getAttribute('data-view'); const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); const cards = document.querySelectorAll('#board-groups .board-card').length; return v === 'pool' && cs.display !== 'none' && r.height > 80 && r.width > 200 && cards >= 1 && getComputedStyle(dm).display === 'none' ? JSON.stringify({ dataView: v, display: cs.display, w: Math.round(r.width), h: Math.round(r.height), cards, dmYields: true }) : null; })()`), 5000, 'DM→看板显式打开');
    // 工具间直接切换（看板→Files→动态）：面板互斥、均有可见响应。
    await win.webContents.executeJavaScript(probe(`document.getElementById('files-toggle').click(); true`), true);
    const filesOpen = await waitForJs(win, probe(`(() => { const f = document.getElementById('files'); const b = document.getElementById('board'); const cs = getComputedStyle(f); const r = f.getBoundingClientRect(); const heads = [...document.querySelectorAll('#files-groups .sidebar-sec')].some((x) => x.textContent.includes('布局演练项目')); return cs.display !== 'none' && r.height > 80 && getComputedStyle(b).display === 'none' && heads ? JSON.stringify({ display: cs.display, w: Math.round(r.width), h: Math.round(r.height), groupRendered: true }) : null; })()`), 5000, '看板→Files 切换');
    await win.webContents.executeJavaScript(probe(`document.getElementById('activity-toggle').click(); true`), true);
    const activityOpen = await waitForJs(win, probe(`(() => { const a = document.getElementById('activity'); const f = document.getElementById('files'); const cs = getComputedStyle(a); const r = a.getBoundingClientRect(); const rows = document.querySelectorAll('#activity-list .activity-row').length; return cs.display !== 'none' && r.height > 80 && rows >= 2 && getComputedStyle(f).display === 'none' ? JSON.stringify({ display: cs.display, w: Math.round(r.width), h: Math.round(r.height), rows }) : null; })()`), 5000, 'Files→动态切换');
    // 关闭工具→返回 DM：视图身份恢复、工具真正收起、草稿保留。
    await win.webContents.executeJavaScript(probe(`document.getElementById('activity-toggle').click(); true`), true);
    const backDm = await waitForJs(win, probe(`(() => { const dm = document.getElementById('dm'); const a = document.getElementById('activity'); const v = document.querySelector('main.main')?.getAttribute('data-view'); const cs = getComputedStyle(dm); const r = dm.getBoundingClientRect(); const draft = document.getElementById('dm-input').value; return v === 'dm' && cs.display !== 'none' && r.height > 100 && getComputedStyle(a).display === 'none' && draft === 'draft-U6' ? JSON.stringify({ dataView: v, dmDisplay: cs.display, dmH: Math.round(r.height), draft }) : null; })()`), 5000, '关闭工具返回 DM');
    // 侧栏切房（视图入口归零）：工具不残留、主池恢复。
    await win.webContents.executeJavaScript(probe(`(() => { const b = document.querySelector('#room-list .room-item'); b.click(); return true; })()`), true);
    const backPool = await waitForJs(win, probe(`(() => { const p = document.getElementById('pool'); const a = document.getElementById('activity'); const v = document.querySelector('main.main')?.getAttribute('data-view'); return v === 'pool' && getComputedStyle(p).display !== 'none' && getComputedStyle(a).display === 'none' ? JSON.stringify({ dataView: v, poolDisplay: getComputedStyle(p).display }) : null; })()`), 5000, '回主池（工具归零）');
    results.U6_explicitTools = {
      boardFromDm: openBoard && JSON.parse(openBoard), filesSwitch: filesOpen && JSON.parse(filesOpen), activitySwitch: activityOpen && JSON.parse(activityOpen),
      backToDm: backDm && JSON.parse(backDm), backToPool: backPool && JSON.parse(backPool),
      pass: openBoard != null && filesOpen != null && activityOpen != null && backDm != null && backPool != null,
    };
  }

  results.allPass = ['P0_firstAutoLoad', 'U1_hiddenContract', 'U2_closePreview', 'U3_previewArea', 'U4_remoteSync', 'U5_widescreen', 'U6_explicitTools'].every((k) => results[k].pass === true);
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2));
  console.log('[ui-hidden-layout] allPass=' + results.allPass + ' ' + JSON.stringify(Object.fromEntries(Object.entries(results).filter(([k]) => k !== 'allPass').map(([k, v]) => [k, v.pass]))));
  server.close();
  win.destroy();
  app.exit(results.allPass ? 0 : 4);
}

/** 打开 Office 预览并测视觉盒（sel 定位视觉容器）+提取文本卡片可见性。 */
async function openOfficeAndMeasure(win, filename, boxSel) {
  await win.webContents.executeJavaScript(probe(`(() => { const chips = [...document.querySelectorAll('#thread-messages .attach-chips .chip')]; const t = chips.find((c) => c.textContent.includes(${JSON.stringify(filename)})); if (t == null) return false; t.click(); return true; })()`), true);
  const box = await waitForJs(win, vis(boxSel), 15_000, `视觉容器 ${boxSel}`);
  if (box == null) return null;
  const extracted = await win.webContents.executeJavaScript(probe(`(() => { const e = document.querySelector('#attach-preview .office-docx-html'); if (e == null) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && e.getBoundingClientRect().height > 10; })()`), true);
  const panel = JSON.parse(await win.webContents.executeJavaScript(vis('#attach-preview'), true));
  return { box: JSON.parse(box), extractedVisible: extracted === true, panel };
}

app.whenReady().then(main).catch((e) => { console.error('[ui-hidden-layout] FAILED', e); app.exit(1); });
