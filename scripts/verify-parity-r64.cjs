'use strict';
/**
 * R62 P1（review-r61 §2 独立反例 early-crash-result.json 的闭拢演练）：
 * 「服务已提交→回执被扣→**20s 超时前** renderer 真实崩溃」——修复后必须：
 *  1) 点击发送后 ≤1s（远早于 20s unknown 判定）localStorage 出站账本已有完整信封
 *     （commandId 逐字）——交给 bridge 之前耐久落账；
 *  2) Page.crash → 自动重载后**未确认横幅恢复**（同 commandId，recovered 语义）+正文恢复
 *     （不自动发送、不静默退回普通草稿）；
 *  3) 未改正文再点发送=被守卫拦截（提示走同号重发/放弃），DB 消息数不增；
 *  4) 「重发原内容」同号同参 → DB 该消息恰 1 条（业务恰一次）+横幅消失+已发正文剥离；
 *  5) 房间未发送草稿跨崩溃恢复；real_calls=0；优雅关窗退出码 0；零残留。
 * 形态：dev Electron（dist/ui/main.cjs）+源码 daemon 子进程；ZS_H1_LOSE_SUBMIT_ONCE=1。
 * 产物 dist/desktop/early-crash-r62-<ts>/result.json。
 */
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r64-parity-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `parity-r64-${runId}`);
const dataRoot = path.join(outDir, 'data');
const projDir = path.join(outDir, '演练 目录 r64');
const dbFile = path.join(dataRoot, 'state.sqlite');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const token = randomBytes(32).toString('hex');
const PORT = 9592;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;

async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(200);
  }
}
function pipeConnect() {
  return new Promise((resolve, reject) => {
    const sock = connect(pipeName);
    sock.setEncoding('utf8');
    let buf = '';
    const pending = new Map();
    let authed = false;
    const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); sock.destroy(); };
    const timer = setTimeout(() => { if (!authed) { failAll(new Error('管道握手超时')); reject(new Error('管道握手超时')); } }, 15000);
    sock.on('connect', () => sock.write(`${JSON.stringify({ type: 'auth', token })}\n`));
    sock.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (!authed) { if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ send, close: () => { sock.destroy(); } }); } continue; }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!authed) reject(e); else failAll(e); });
    function send(method, params) {
      const commandId = `ec-${randomUUID().slice(0, 8)}`;
      return new Promise((resolve2, reject2) => {
        const p = { resolve: resolve2, reject: reject2, timer: null };
        p.timer = setTimeout(() => { pending.delete(commandId); reject2(new Error(`命令超时：${method}`)); }, 20000);
        pending.set(commandId, p);
        sock.write(`${JSON.stringify({ protocolVersion: 1, commandId, method, params })}\n`);
      });
    }
  });
}
const cmd = async (client, method, params) => {
  const r = await client.send(method, params);
  if (r && r.ok === false) throw new Error(`${method} 被拒：${r.error?.code}: ${r.error?.message}`);
  return r && r.data !== undefined ? r.data : r;
};
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false; ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); } }); ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 45_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 160)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
}
async function connectPage(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); return new Cdp(ws); }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
const waitFor = async (cdp, expr, ms, label) => until(() => cdp.tryEval(probe(expr)).catch(() => null), (v) => v, ms, label);
const ownChildren = new Set();
function cleanupOwn() {
  for (const c of [...ownChildren]) {
    if (c.exitCode != null) continue;
    try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  }
}
const dbQuery = (sql, ...a) => {
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const db = new Database(dbFile, { readonly: true });
  try { return db.prepare(sql).all(...a); } finally { db.close(); }
};
const setArea = (cdp, v) => cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); if (ta == null) return false; const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, ${JSON.stringify(v)}); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
const clickBtn = async (cdp, matcher, label) => {
  const ok = await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((b) => ${matcher}); if (b == null) return false; b.click(); return true; })()`));
  if (ok !== true) throw new Error('按钮未找到：' + label);
};
const ledgerProbe = (cdp) => cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('zs.hifi.persist.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const ls = Object.values(d.outboundLedger ?? {}).flat(); return JSON.stringify(ls.map((x) => ({ commandId: x.commandId, stage: x.stage, body: x.params?.body }))); })()`);
const pendProbe = (cdp) => cdp.tryEval(`(() => { const k = Object.keys(localStorage).find((x) => x.startsWith('zs.hifi.persist.')); if (k == null) return null; const d = JSON.parse(localStorage.getItem(k)); const ps = Object.values(d.pendingSends ?? {}); return JSON.stringify(ps.map((x) => ({ commandId: x.commandId, recovered: x.recovered === true, queued: (x.queued ?? []).length }))); })()`);

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  // R64 fixture：真实文件 + git 仓库（目录树/Git 历史的真实数据源）。
  fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(projDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# R64 演练项目 — 原型还原交互门 fixture。', 'utf8');
  fs.writeFileSync(path.join(projDir, 'src', 'main.ts'), 'export function main(): string { return String.fromCharCode(114,54,52); }\n', 'utf8');
  fs.writeFileSync(path.join(projDir, 'docs', 'note.md'), '# 备忘 — L2 并列 / Git 全真', 'utf8');
  try {
    const git = (args) => spawnSync('git', args, { cwd: projDir, encoding: 'utf8', timeout: 30000 });
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'probe@r64.local']);
    git(['config', 'user.name', 'R64 Probe']);
    git(['add', '.']);
    git(['commit', '-m', 'R64 fixture 基线提交']);
  } catch { /* git 缺失时目录树仍可验证——Git 段会如实失败 */ }
  fs.writeFileSync(path.join(dataRoot, 'local.token'), token, 'utf8');
  const facts = { runId, scope: 'R64 交互门：原型还原三场景（房间/回复串 L2、文件与Git 真实树+全真 git、设置七导航）+正式侧截图；dev 构建+fake runtime；零真实模型调用' };

  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName, ZS_H1_LOSE_SUBMIT_ONCE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownChildren.add(app);
  app.once('exit', () => ownChildren.delete(app));
  let appOut = '';
  app.stdout.on('data', (c) => { appOut += c; });
  app.stderr.on('data', (c) => { appOut += c; });
  facts.appPid = app.pid;

  let cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 壳挂载');
  let client = null;
  await until(async () => { try { client = await pipeConnect(); return true; } catch { return false; } }, (v) => v === true, 30000, 'daemon 管道就绪');
  await cmd(client, 'project.open', { path: projDir });
  await cmd(client, 'app.settings.set', { key: 'ui.autoOpenProjectPath', value: projDir });
  /* ================= R64 交互门：原型还原三场景（房间/回复串、文件与Git、设置） ================= */
  const shots = {};
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  const shot = async (name) => {
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'shots', `formal-${name}.png`), Buffer.from(png.data, 'base64'));
    shots[name] = `shots/formal-${name}.png`;
  };
  const capNote = { cssViewport: null, dpr: null, theme: 'light' };
  capNote.dpr = await cdp.tryEval('window.devicePixelRatio');
  capNote.cssViewport = await cdp.tryEval('JSON.stringify([window.innerWidth, window.innerHeight])');

  const errs = [];
  const facts2 = {};

  /* ---- A. 房间：页签 + 主池卡片 + 宽窗线程并列（L2）+ 收起 ---- */
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].some((e) => e.textContent.includes('默认房间'))`, 45000, '侧栏项目树（房间行）');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('默认房间'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .thread-tabs .thread-tab') != null && [...document.querySelectorAll('#hifi-root .thread-tabs .thread-tab')].some((b) => b.textContent.includes('对话池'))`, 20000, '房间页签（对话池/任务看板/文件）');
  facts2.roomTabs = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .thread-tabs .thread-tab')].map((b) => b.textContent.trim()).join('|')`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '主池输入区');

  // 仅记录发一条 → 主池出现 root-card（真实 message.submit + room.pool 水合）。
  await setArea(cdp, 'R64 交互门·主池卡片');
  await clickBtn(cdp, `b.getAttribute('aria-label') === '本次运行设置'`, '本次运行设置');
  await sleep(400);
  await clickBtn(cdp, `b.textContent.includes('仅记录') && !b.textContent.includes('取消')`, '仅记录菜单项');
  await sleep(300);
  await clickBtn(cdp, `/保存记录/.test(b.textContent.trim()) && b.textContent.trim().length <= 6`, '保存记录');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('R64 交互门·主池卡片'))`, 20000, '主池卡片出现（room.pool 水合）');
  facts2.poolCard = true;
  await shot('room-pool');

  // 点卡片 → L2：col-main 与 col-thread 并列（宽窗不整页跳转）。
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('R64 交互门·主池卡片'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .col-thread') != null`, 20000, '线程面板（col-thread）');
  facts2.l2SideBySide = await cdp.tryEval(`document.querySelector('#hifi-root .col-main') != null && document.querySelector('#hifi-root .col-thread') != null`);
  facts2.l2Hash = await cdp.tryEval('location.hash');
  facts2.l2TwoComposers = await cdp.tryEval(`document.querySelectorAll('#hifi-root textarea.composer-input').length`);
  await shot('room-thread-L2');
  if (facts2.l2SideBySide !== true) errs.push('宽窗未并列（col-main/col-thread 缺一）');
  if (facts2.l2TwoComposers !== 2) errs.push(`输入区数量异常（${facts2.l2TwoComposers}≠2——主池/线程草稿未隔离）`);

  // 线程三视图 + 详情分组。
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .thread-nav .thread-tab')].some((b) => b.textContent.includes('详情'))`, 15000, '线程视图键（回复/详情）');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .thread-nav .thread-tab')].find((b) => b.textContent.includes('详情'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .details-subnav .details-chip') != null`, 15000, '详情分组 chips');
  facts2.detailChips = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .details-subnav .details-chip')].map((c) => c.textContent.trim()).join('|')`);
  await shot('thread-details');
  // 线程 ⋯ 菜单（关注/静音=真实 thread.subscribe）。
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .col-thread button')].find((b) => b.getAttribute('aria-label') === '更多线程操作')?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .menu .menu-item, #hifi-root [class*=menu] button')].some((b) => b.textContent.includes('关注'))`, 8000, '线程 ⋯ 菜单（关注/静音）');
  facts2.threadMenu = true;
  await cdp.eval(probe(`document.querySelector('#hifi-root .menu button, #hifi-root [class*=menu] button')?.click(), true`));
  await sleep(200);

  // 收起回主池：col-thread 消失、主池仍在。
  await cdp.eval(probe(`document.querySelector('#hifi-root .thread-nav-back')?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .col-thread') == null && document.querySelector('#hifi-root .col-main') != null`, 15000, '收起回主池');
  facts2.collapseOk = true;

  /* ---- B. 文件与 Git：真实目录树 + 共享预览（工作区只读） + Git 全真 ---- */
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.includes('文件与 Git'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .fg-pane-list') != null`, 25000, '文件页左栏（fg-pane-list）');
  await waitFor(cdp, `document.querySelectorAll('#hifi-root .file-tree button').length > 0`, 25000, '真实目录树条目（project.files.list）');
  facts2.treeEntries = await cdp.tryEval(`document.querySelectorAll('#hifi-root .file-tree button').length`);
  // 选中一个文件 → 共享预览标签 + 工作区只读来源行。
  await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree button')]; const file = rows.find((r) => r.querySelector('.file-row-size') != null) ?? rows[0]; file?.click(); return true; })()`));
  await waitFor(cdp, `document.querySelector('#hifi-root .preview-pane') != null && document.querySelector('#hifi-root .preview-tab') != null`, 25000, '共享预览（工作区文件）');
  facts2.previewTag = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .preview-origin')].map((e) => e.textContent).join('')`);
  await waitFor(cdp, `(() => { const b = document.querySelector('#hifi-root .preview-body'); return b != null && !b.textContent.includes('正在读取') && !b.textContent.includes('正在装载'); })()`, 20000, '工作区内容装载（project.file.read）');
  await shot('files-tree-preview');
  // 窄窗返回列表形态（CSS 断点由媒体查询/容器宽度决定——这里核 data-pane 结构与左栏滚动容器存在）。
  facts2.fgPanes = await cdp.tryEval(`document.querySelectorAll('#hifi-root .fg-pane').length`);

  // Git 标签：真实历史 + 状态。
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .thread-tabs .thread-tab')].find((b) => b.textContent.includes('Git'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .git-list') != null`, 30000, 'Git 页左栏');
  await waitFor(cdp, `document.querySelector('#hifi-root .git-list') != null`, 30000, 'Git 页左栏');
  // 默认工作区视图——先切「历史」再核真实提交行。
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .git-list-head button')].find((b) => b.textContent.includes('历史'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .git-list .git-list-path')].length > 0`, 30000, 'Git 历史/分支条目（真实 git.history）');
  facts2.gitRows = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .git-list .git-list-path')].slice(0, 5).map((e) => e.textContent.trim()).join('|')`);
  await shot('git-history');
  // 工作区 diff 选中即装载（有未提交改动时）——不强求（fixture 可能 clean），核布局即可。
  facts2.gitPrepare = await cdp.tryEval(`document.querySelector('#hifi-root .git-prepare') != null`);

  /* ---- C. 设置：七项导航 + 真实行 ---- */
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item')].find((b) => b.textContent.trim() === '设置')?.click(), true`));
  await waitFor(cdp, `document.querySelectorAll('#hifi-root .settings-nav-item').length >= 7`, 20000, '设置七项导航');
  facts2.settingsNav = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .settings-nav-item .settings-nav-text')].map((e) => e.textContent.trim()).join('|')`);
  await shot('settings-nav');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .settings-nav-item')].find((b) => b.textContent.includes('AI 工具'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .settings-body')].some((e) => e.textContent.includes('派发防护'))`, 15000, 'AI 工具分区（派发防护真实行）');
  facts2.runtimeSection = true;
  await shot('settings-runtime');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .settings-nav-item')].find((b) => b.textContent.includes('数据与存储'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .settings-body')].some((e) => e.textContent.includes('草稿快照健康'))`, 15000, '数据与存储（草稿快照）');

  facts2.viewport = capNote;
  facts2.realCallsBefore = dbQuery('SELECT count(*) c FROM real_calls')[0].c;

  // 断言汇总。
  if (!String(facts2.roomTabs ?? '').includes('任务看板')) errs.push('房间页签缺任务看板/文件');
  if (facts2.poolCard !== true) errs.push('主池卡片未出现');
  if (facts2.collapseOk !== true) errs.push('收起未回主池');
  if (!String(facts2.detailChips ?? '').includes('任务概况') && !String(facts2.detailChips ?? '').includes('记录信息')) errs.push('详情分组缺任务概况/记录信息');
  if (facts2.threadMenu !== true) errs.push('线程次级菜单缺失');
  if ((facts2.treeEntries ?? 0) < 1) errs.push('目录树为空（未接真实目录）');
  if (!String(facts2.previewTag ?? '').includes('工作区只读')) errs.push('预览来源行未标工作区只读');
  if ((facts2.gitRows ?? '') === '') errs.push('Git 历史为空');
  if ((facts2.settingsNav ?? '').split('|').length) { const navList = String(facts2.settingsNav).split('|'); if (!navList.includes('通用') || !navList.includes('外观') || !navList.includes('通知') || !navList.includes('AI 工具') || !navList.includes('连接与设备') || !navList.includes('数据与存储') || !navList.includes('帮助与关于')) errs.push('设置导航非七项：' + facts2.settingsNav); }
  facts2.ok = errs.length === 0;
  facts2.checkErrors = errs;
  Object.assign(facts, facts2);

  // 截图清单写入（实际 PNG 由 CDP 截图——这里用 Page.captureScreenshot 逐场景补拍）。

  // ---- 收尾：优雅关窗 + 残留收拢 + real_calls + result.json ----
  await cdp.eval(probe(`window.zsWindow?.close(), true`));
  const exitInfo = await until(async () => app.exitCode, (c) => c != null, 30000, '优雅退出').catch(() => null);
  await sleep(2200);
  const like = dataRoot.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
  const kill = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { "$($_.ProcessId)" }`], { encoding: 'utf8', timeout: 60000 });
  const residual = String(kill.stdout ?? '').trim().split(/\s+/).filter(Boolean);
  client.close();
  facts.shutdown = { appExitCode: exitInfo, residualProcs: residual.length };
  facts.shots = shots;
  facts.realCalls = dbQuery('SELECT count(*) c FROM real_calls')[0].c;
  if (facts.realCalls !== 0) facts.checkErrors.push('real_calls != 0');
  if (facts.shutdown.appExitCode !== 0) facts.checkErrors.push('优雅关窗退出码非 0');
  if (facts.shutdown.residualProcs !== 0) facts.checkErrors.push('残留进程');
  facts.ok = facts.checkErrors.length === 0;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: facts.checkErrors, roomTabs: facts.roomTabs, detailChips: facts.detailChips, treeEntries: facts.treeEntries, gitRows: facts.gitRows, settingsNav: facts.settingsNav, l2: facts.l2SideBySide, shots }));
  cleanupOwn();
  process.exit(facts.ok ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  cleanupOwn();
  process.exit(1);
});
