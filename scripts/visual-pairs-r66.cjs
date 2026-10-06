'use strict';
/**
 * R66 视觉门（review-r65 §3）：**同场景原型×正式成对截图**——同一 CSS 视口（1280×800）/
 * DPR=1/浅色主题/尽量对齐的数据状态；记录每对的场景、实际状态与**用户批准差异**（文件-only
 * 发送、HTML 隔离页、有效 runtime 来源等 R66 新能力为正式侧独有——明确标注，不冒充同源）。
 * 场景：顶栏项目菜单 / 成员 / 搜索收藏 / DM+MD 阅读 / DM+HTML 隔离页 / 文件与 Git /
 * 应用设置 / 任务看板 / 归档管理 / DM 窄窗单区（原型 320/440/480 规则）。
 * 原型=hifi-prototype vite dev（内存种子）；正式=dist/ui dev 壳+自有数据根夹具
 * （项目+DM+MD/HTML 附件，管道真实命令——与交互门同链）。产物 dist/desktop/visual-gate-r66/。
 * real_calls=0。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const outDir = path.join(repo, 'dist', 'desktop', 'visual-gate-r66');
const dataRoot = path.join(outDir, 'data');
const projDir = path.join(outDir, '项目 甲');
const dbFile = path.join(dataRoot, 'state.sqlite');
const pipeName = `\\\\.\\pipe\\zs-vis-${randomBytes(4).toString('hex')}`;
const PROTO_PORT = 5311;
const PROTO_CDP = 5312;
const FORM_CDP = 5313;
const VW = 1280;
const VH = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(250);
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.consoleErrors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.consoleErrors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 200)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
}
async function connectPage(port, label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); await c.send('Runtime.enable'); await c.send('Page.enable'); return c; }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
const own = new Set();
function cleanupOwn() { for (const c of [...own]) { if (c.exitCode != null) continue; try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } }
const dbQuery = (sql, ...a) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(dbFile, { readonly: true }); try { return db.prepare(sql).all(...a); } finally { db.close(); } };

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# 视觉门项目\n', 'utf8');
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');

  // 原型 vite dev server。
  const vite = spawn(process.execPath, [path.join(repo, 'hifi-prototype', 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PROTO_PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: path.join(repo, 'hifi-prototype'), stdio: ['ignore', 'ignore', 'ignore'] });
  own.add(vite);
  await until(async () => { try { await fetch(`http://127.0.0.1:${PROTO_PORT}/`, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; } }, (v) => v, 60000, 'vite dev server');

  // 原型宿主：极简 electron 主进程（加载 vite URL；无产品桥——原型按浏览器宿主自处）。
  const protoAppDir = path.join(outDir, 'proto-host');
  fs.mkdirSync(protoAppDir, { recursive: true });
  fs.writeFileSync(path.join(protoAppDir, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: ${VW}, height: ${VH}, useContentSize: true, webPreferences: { contextIsolation: true } });
  win.loadURL(process.env.ZS_PROTO_URL);
});`, 'utf8');
  const protoApp = spawn(electronExe, [`--remote-debugging-port=${PROTO_CDP}`, path.join(protoAppDir, 'main.cjs')], { cwd: repo, env: { ...process.env, ZS_PROTO_URL: `http://127.0.0.1:${PROTO_PORT}/` }, stdio: ['ignore', 'ignore', 'ignore'] });
  own.add(protoApp);

  // 正式壳（dev 构建 + 自有数据根）。
  const formApp = spawn(electronExe, [`--remote-debugging-port=${FORM_CDP}`, path.join(repo, 'dist', 'ui', 'main.cjs')], { cwd: repo, env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName }, stdio: ['ignore', 'ignore', 'ignore'] });
  own.add(formApp);

  const proto = await connectPage(PROTO_CDP, '原型页');
  const form = await connectPage(FORM_CDP, '正式页');
  await proto.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await form.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await until(() => proto.tryEval('document.querySelector(".sidebar, .app") != null'), (v) => v, 60000, '原型挂载');
  // 原型种子自带 startupRecovery 注意项（首帧自动开恢复弹窗）——关闭后再拍，避免遮挡被测页面主体。
  await sleep(1500);
  await proto.tryEval(probe(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('暂不处理')); b?.click(); return true; })()`));
  await sleep(600);
  await proto.tryEval(probe(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('知道了') || x.textContent.trim() === '关闭'); b?.click(); return true; })()`));
  await until(() => form.tryEval(probe(`document.body.classList.contains('hifi-on')`)), (v) => v, 60000, '正式挂载');

  // 正式侧夹具：注册项目→重载→DM→上传 MD/HTML→仅记录发送（与交互门同链）。
  const zsCmd = async (method, params) => {
    const v = await form.send('Runtime.evaluate', {
      expression: `window.zs.command({ protocolVersion: 1, commandId: 'vis-' + Math.random().toString(36).slice(2, 10), method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
      awaitPromise: true, returnByValue: true,
    });
    return JSON.parse(v.result.value);
  };
  const zsOk = async (method, params) => { const r = await zsCmd(method, params); if (r && r.ok !== true) throw new Error(`${method}: ${r.error?.message}`); return r.data ?? r; };
  await zsOk('project.open', { path: projDir });
  await form.eval('location.reload(), true');
  const form2 = await connectPage(FORM_CDP, '正式重开');
  await form2.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await until(() => form2.tryEval(probe(`document.body.classList.contains('hifi-on')`)), (v) => v, 60000, '正式重开挂载');
  await until(() => form2.tryEval(probe(`document.querySelector('#hifi-root .side-project .side-item-label') != null`)), (v) => v, 45000, '正式侧栏项目');
  const proj = dbQuery('SELECT id FROM projects')[0];
  const members = await zsOk('member.list', { projectId: proj.id });
  const agent = members.items.find((m) => m.principalType === 'agent');
  const dm = await zsOk('conversation.create', { projectId: proj.id, peerMemberId: agent.id });
  const md = `# 视觉门 MD 标题\n\n**加粗** 与表格：\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n\n- 列表项一\n- 列表项二\n`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>h1{color:navy}</style></head><body><h1>视觉门 HTML 标题</h1><p>页面段落内容。</p></body></html>`;
  const upMd = await zsOk('attachment.uploadText', { conversationId: dm.conversationId, filename: '视觉门 文档.md', content: md });
  const upHtml = await zsOk('attachment.uploadText', { conversationId: dm.conversationId, filename: '视觉门 页面.html', content: html });
  await zsOk('message.submit', { target: { kind: 'dm', projectId: proj.id, conversationId: dm.conversationId }, body: '', intent: 'record_only', mentions: [], attachmentRefs: [upMd.attachmentId] });
  await zsOk('message.submit', { target: { kind: 'dm', projectId: proj.id, conversationId: dm.conversationId }, body: '', intent: 'record_only', mentions: [], attachmentRefs: [upHtml.attachmentId] });

  const clickText = async (cdp, selector, text, label) => {
    const okv = await cdp.tryEval(probe(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = els.find((e) => e.textContent.includes(${JSON.stringify(text)})); if (el == null) return false; el.click(); return true; })()`));
    if (okv !== true) throw new Error('未找到：' + label);
  };
  const shot = async (side, name) => {
    const c = side === 'proto' ? proto : form2;
    const png = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'shots', `${side}-${name}.png`), Buffer.from(png.data, 'base64'));
  };
  const manifest = { viewport: { w: VW, h: VH, dpr: 1, theme: 'light' }, scenes: [] };
  const scene = (name, notes) => manifest.scenes.push({ name, ...notes });

  /* —— s1 顶栏项目菜单（打开态） —— */
  await proto.tryEval(probe(`document.querySelector('.titlebar-project-btn')?.click(), true`));
  await sleep(700);
  await shot('proto', 's1-project-menu');
  await proto.tryEval(probe(`(() => { const m = document.querySelector('.menu'); if (m) m.click?.(); document.body.click?.(); return true; })()`));
  await sleep(500);
  await proto.tryEval(probe(`(() => { const again = document.querySelector('.menu'); if (again != null) { const b = [...document.querySelectorAll('.titlebar-project-btn')].find((x) => x); b?.click?.(); } return true; })()`)); // 仍展开则再点按钮收起
  await sleep(300);
  await form2.eval(probe(`document.querySelector('#zs-titlebar [data-zs-project-menu-btn]')?.click(), true`));
  await sleep(700);
  await shot('formal', 's1-project-menu');
  await form2.eval(probe(`(() => { const ov = [...document.querySelectorAll('#zs-titlebar div')].find((d) => d.style?.position === 'fixed' && d.style?.inset === '0px'); ov?.click(); return true; })()`));
  scene('s1-project-menu', { protoState: '种子三项目+搜索框', formalState: '单注册项目（视觉门夹具）', approvedDiffs: '正式侧数据=真实注册表（单项目）；原型=内存种子' });

  /* —— s2 成员 —— */
  await proto.eval(probe(`(() => { const b = [...document.querySelectorAll('.side-item')].find((x) => x.textContent.includes('成员管理')); b?.click(); return true; })()`));
  await sleep(900);
  await shot('proto', 's2-members');
  await form2.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}`)}; true`);
  await sleep(1800); // 项目主页挂载即聚焦（switchFocusProject）；房间装载由成员页等待兜底核验。
  await form2.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/members`)}; true`);
  await until(() => form2.tryEval(probe(`document.querySelector('[data-zs-members] .card') != null`)), (v) => v, 30000, '正式成员卡').catch(async (e) => {
    const h = await form2.tryEval('location.hash');
    const body = await form2.tryEval('document.querySelector("#hifi-root")?.textContent.slice(0, 200)');
    const ping = await form2.tryEval(`Promise.race([window.zs.command({protocolVersion:1,commandId:'visping999',method:'app.identity',params:{}}).then(()=>'pong').catch((e)=>'rej:'+String(e).slice(0,80)), new Promise((r)=>setTimeout(()=>'TIMEOUT-bridge',4000))])`, true);
    throw new Error(`${e.message}；hash=${h}；bridge=${ping}；body=${body}`);
  });
  await shot('formal', 's2-members');
  scene('s2-members', { protoState: '种子成员卡（含模板区）', formalState: '真实 member.list 单成员+runtime 有效来源（fake 全局默认）', approvedDiffs: '正式侧无「添加成员」按钮（member.create 属 DEV-10 后续——不放假成功入口）；卡片显示有效派发来源' });

  /* —— s3 搜索收藏 —— */
  await proto.eval(probe(`(() => { const b = [...document.querySelectorAll('.side-item')].find((x) => x.textContent.includes('搜索与收藏')); b?.click(); return true; })()`));
  await sleep(800);
  await shot('proto', 's3-library');
  await form2.eval(`location.hash = '#/library'; true`);
  await until(() => form2.tryEval(probe(`document.querySelector('[data-zs-library] .page-filters') != null`)), (v) => v, 25000, '正式搜索筛选行');
  await shot('formal', 's3-library');
  scene('s3-library', { protoState: '搜索/收藏标签+范围筛选行（内存）', formalState: '同布局+search.query 真实命令（含类型/作者/日期/会话筛选）', approvedDiffs: '正式侧范围=当前项目/全部可访问项目（服务端无“侧栏可见”检索范围——不虚构）' });

  /* —— s4/s5 DM+MD / DM+HTML —— */
  await proto.eval(probe(`(() => { const b = [...document.querySelectorAll('.side-item')].find((x) => x.textContent.includes('私信')); b?.click(); return true; })()`));
  await sleep(900);
  const protoAttach = await proto.tryEval(probe(`(() => { const a = document.querySelector('.msg-attach'); if (a != null) { a.click(); return 'opened'; } return 'none'; })()`));
  await sleep(900);
  await shot('proto', 's4-dm-md');
  await form2.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
  await until(() => form2.tryEval(probe(`document.querySelector('#hifi-root .msg-attach') != null`)), (v) => v, 25000, '正式 DM 附件芯片');
  await form2.eval(probe(`[...document.querySelectorAll('#hifi-root .msg-attach')].find((c) => c.textContent.includes('视觉门 文档'))?.click(), true`));
  await until(() => form2.tryEval(probe(`document.querySelector('.preview-read-doc .md-h1') != null`)), (v) => v, 25000, '正式 MD 排版阅读');
  await shot('formal', 's4-dm-md');
  scene('s4-dm-md', { protoState: protoAttach === 'opened' ? '种子 DM 附件预览' : '种子 DM（无附件可开——预览空态）', formalState: '文件-only 消息+MD 排版阅读（readFull 全文）', approvedDiffs: '正式侧为 R66 用户批准能力：无正文仅文件消息 + 完整文件阅读器' });

  await proto.tryEval(probe(`(() => { const t = [...document.querySelectorAll('.thread-tab, .preview-tools button')].find((x) => x.textContent.includes('源码')); t?.click(); return true; })()`));
  await form2.eval(probe(`[...document.querySelectorAll('#hifi-root .msg-attach')].find((c) => c.textContent.includes('视觉门 页面'))?.click(), true`));
  await until(() => form2.tryEval(probe(`document.querySelector('.preview-pane iframe[data-zs-html-frame]') != null`)), (v) => v, 25000, '正式 HTML 隔离页');
  await shot('formal', 's5-dm-html');
  scene('s5-dm-html', { protoState: '（原型无 HTML 页面预览通道——DM 会话态，见 s4）', formalState: 'HTML 隔离页面预览（sandbox iframe+CSP，脚本禁用）', approvedDiffs: 'R66 用户批准新增：HTML 文件按页面呈现（原型仅文本附件）' });

  /* —— s6 文件与 Git —— */
  await proto.eval(probe(`(() => { const b = [...document.querySelectorAll('.side-item')].find((x) => x.textContent.includes('文件与')); b?.click(); return true; })()`));
  await sleep(1200);
  await shot('proto', 's6-files-git');
  await form2.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
  await until(() => form2.tryEval(probe(`document.querySelector('#hifi-root .fg-statusbar') != null || document.querySelector('#hifi-root .fg-pane') != null`)), (v) => v, 30000, '正式文件页');
  await shot('formal', 's6-files-git');
  scene('s6-files-git', { protoState: 'mock 目录树+Git 演示', formalState: '真实目录树（project.files.list）+Git 真事实', approvedDiffs: '正式侧为真实仓库事实（无远端时显示未知，不以 0/空冒充）' });

  /* —— s7 应用设置 —— */
  await proto.eval(probe(`(() => { const b = [...document.querySelectorAll('.side-item')].find((x) => x.textContent.includes('设置')); b?.click(); return true; })()`));
  await sleep(900);
  await shot('proto', 's7-settings');
  await form2.eval(`location.hash = '#/settings?section=general'; true`);
  await until(() => form2.tryEval(probe(`document.querySelector('#hifi-root .settings-section-head, #hifi-root .settings-nav') != null || document.querySelector('#hifi-root .settings') != null`)), (v) => v, 25000, '正式设置页');
  await shot('formal', 's7-settings');
  scene('s7-settings', { protoState: '七分区导航', formalState: '七分区+真实绑定（数据与存储内嵌归档管理）', approvedDiffs: '正式侧各分区显示真实服务事实（本机身份/远程监听/草稿健康）' });

  /* —— s8 任务看板 —— */
  await proto.eval(probe(`(() => { const b = [...document.querySelectorAll('.side-item')].find((x) => x.textContent.includes('任务看板')); b?.click(); return true; })()`));
  await sleep(900);
  await shot('proto', 's8-board');
  await form2.eval(`location.hash = '#/board'; true`);
  await until(() => form2.tryEval(probe(`document.querySelector('#hifi-root .page-filters') != null`)), (v) => v, 25000, '正式看板筛选行');
  await shot('formal', 's8-board');
  scene('s8-board', { protoState: '种子任务分组', formalState: 'board.view 权威状态（夹具无任务=空态）', approvedDiffs: '正式侧数据密度低（视觉门夹具未造任务）——布局同构' });

  /* —— s9 归档管理 —— */
  await proto.eval(`location.hash = '#/archive'; true`);
  await sleep(900);
  await shot('proto', 's9-archive');
  await form2.eval(`location.hash = '#/archive'; true`);
  await until(() => form2.tryEval(probe(`document.querySelector('[data-archive-project]') != null || document.querySelector('#hifi-root .empty, #hifi-root .EmptyState') != null || document.body.textContent.includes('没有归档内容')`)), (v) => v, 20000, '正式归档页');
  await shot('formal', 's9-archive');
  scene('s9-archive', { protoState: '种子归档', formalState: '真实归档（夹具无归档=空态）', approvedDiffs: '正式侧空态=真无归档内容' });

  /* —— s10 DM 窄窗（900×700）单区/收列表 —— */
  await proto.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await form2.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await proto.eval(`location.hash = '#/dm'; true`);
  await sleep(900);
  await shot('proto', 's10-dm-narrow');
  await form2.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
  await sleep(1200);
  await shot('formal', 's10-dm-narrow');
  scene('s10-dm-narrow', { protoState: '900px DM（原型降级规则）', formalState: '900px DM（R66 移植同规则：列表收起/单区切换）', approvedDiffs: '无（同规则）' });

  manifest.formalConsoleErrors = form2.consoleErrors.slice(0, 5);
  manifest.protoConsoleErrors = proto.consoleErrors.slice(0, 5);
  let realCalls = -1;
  try { realCalls = dbQuery('SELECT count(*) c FROM real_calls')[0].c; } catch { /* */ }
  manifest.realCalls = realCalls;
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: manifest.formalConsoleErrors.length === 0, scenes: manifest.scenes.length, realCalls, formalErrors: manifest.formalConsoleErrors }));
  cleanupOwn();
  process.exit(0);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err) }, null, 2)); } catch { /* */ }
  console.error(String(err && err.stack || err));
  cleanupOwn();
  process.exit(1);
});
