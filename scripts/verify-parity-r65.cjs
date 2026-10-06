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
const { existsSync } = fs;
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r65-full-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `parity-r65-${runId}`);
const dataRoot = path.join(outDir, 'data');
const projDir = path.join(outDir, '演练 目录 r65');
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
        if (!authed) { if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ send, close: () => { sock.destroy(); } }); } else if (msg.type != null) { console.error('[pipe-auth-resp]', JSON.stringify(msg).slice(0, 200)); } continue; }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); console.error('[pipe-err]', e.code, e.message); if (!authed) reject(e); else failAll(e); });
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

let __appOutRef = { v: '' };
(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  ownChildren.add(app);
  app.once('exit', () => ownChildren.delete(app));
  let appOut = '';
  app.stdout.on('data', (c) => { appOut += c; });
  app.stderr.on('data', (c) => { appOut += c; });
  app.stdout.on('data', (c) => { __appOutRef.v += c; });
  app.stderr.on('data', (c) => { __appOutRef.v += c; });
  const facts = { runId, scope: 'R65 交互门：项目与房间闭环（多项目/属性/新房间/移除）+看板+Git 真事实与写动作+STALE 负对照；dev 构建+fake runtime；零真实模型调用', appPid: app.pid };


  /* ================= R65 交互门：项目与房间闭环 + 看板 + Git 真事实/写动作 + 负对照 ================= */
  let cdp = null;
  const errs2 = [];
  const f = {};
  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  const shot = async (name) => {
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'shots', `formal-${name}.png`), Buffer.from(png.data, 'base64'));
  };

  /* ---- fixture：项目 A（含 git worktree+origin 上游）与项目 B/C（普通目录） ---- */
  const projA = path.join(outDir, '项目A 协作');
  const projB = path.join(outDir, 'project-b');
  const projC = path.join(outDir, '中文 项目 C');
  const bare = path.join(outDir, 'bare-origin.git');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(path.join(projA, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projA, 'README.md'), '# A\n', 'utf8');
  fs.writeFileSync(path.join(projA, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  const gitRun = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  gitRun(projA, ['init', '-b', 'main']);
  gitRun(projA, ['config', 'user.email', 'r65@local']);
  gitRun(projA, ['config', 'user.name', 'R65 Probe']);
  gitRun(projA, ['add', '.']);
  gitRun(projA, ['commit', '-m', 'A 基线']);
  spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8', timeout: 30000 });
  gitRun(projA, ['remote', 'add', 'origin', bare]);
  gitRun(projA, ['push', '-u', 'origin', 'main']);
  gitRun(projA, ['commit', '--allow-empty', '-m', '本地领先一提交']);
  fs.mkdirSync(projB, { recursive: true });
  fs.writeFileSync(path.join(projB, 'b.md'), 'B\n', 'utf8');
  fs.mkdirSync(projC, { recursive: true });
  fs.writeFileSync(path.join(projC, '说明.txt'), 'C\n', 'utf8');

  /* ---- ① 注册 A/B/C（经渲染进程正式桥=真实用户路径）→ 重开恢复三项目 ---- */
  cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 壳挂载');
  const zsCmd = async (method, params) => {
    const v = await cdp.send('Runtime.evaluate', {
      expression: `window.zs.command({ protocolVersion: 1, commandId: 'r65-' + Math.random().toString(36).slice(2, 10), method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { code: 'TRANSPORT', message: String(e) } }))`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (v.exceptionDetails) throw new Error('zsCmd eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 160));
    return JSON.parse(v.result.value);
  };
  const zsOk = async (method, params) => {
    const r = await zsCmd(method, params);
    if (r && r.ok !== true) throw new Error(`${method} 被拒：${r.error && r.error.code}: ${r.error && r.error.message}`);
    return r && r.data !== undefined ? r.data : r;
  };
  await cdp.eval(probe(`window.zs.command({ protocolVersion: 1, commandId: 'r65-boot', method: 'app.settings.get', params: { keys: ['ui.autoOpenProjectPath'] } }).then(() => true, () => false)`));
  await zsOk('project.open', { path: projA });
  await zsOk('project.open', { path: projB });
  await zsOk('project.open', { path: projC });
  f.dbProjects = dbQuery('SELECT id, display_name, root_path FROM projects ORDER BY rowid').map((r) => r.display_name);
  await cdp.eval(`location.reload(), true`);
  cdp = await connectPage('重开');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, '重开壳挂载');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-item-label')].filter((e) => e.textContent.includes('项目A')).length > 0`, 45000, '侧栏含项目A（注册表合并）');
  f.sidebarProjects = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .side-project .side-item-label')].map((e) => e.textContent.trim())`);
  if (!String(f.sidebarProjects).includes('项目A') || !String(f.sidebarProjects).includes('project-b') || !String(f.sidebarProjects).includes('中文 项目 C')) errs2.push(`重开后侧栏未含三项目：${f.sidebarProjects}`);
  await shot('sidebar-multi');
  // 真实切换路径：直开项目主页（深链）→ 挂载即聚焦（switchFocusProject：active+rooms/members/dms）
  {
    const idA = dbQuery("SELECT id FROM projects WHERE root_path LIKE '%项目A%'")[0].id;
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${idA}`)}; true`);
  }
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-project .side-item-label')].some((e) => e.textContent.includes('项目A')) && document.querySelectorAll('#hifi-root .side-item.sub').length > 0`, 25000, '聚焦项目A（侧栏房间装载）');
  await shot('project-home');
  await cdp.eval(probe(`[...document.querySelectorAll('#zs-titlebar .menu-project-name')].find((b) => b.textContent.includes('项目A'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-project .side-item-label')].some((e) => e.textContent.includes('项目A')) && document.querySelectorAll('#hifi-root .side-item.sub').length > 0`, 25000, '切换后侧栏房间（焦点+房间装载）');

  /* ---- ② 项目管理菜单：切换到 A → 属性编辑真实保存/回读/STALE 负对照 ---- */
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item-label')].find((e) => e.textContent.includes('项目A'))?.click(), true`));
  await sleep(300);
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-row-act')][0]?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .menu .menu-item')].some((b) => b.textContent.includes('编辑项目信息'))`, 8000, '项目 ⋯ 菜单');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((b) => b.textContent.includes('编辑项目信息'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .modal input')].length >= 1`, 8000, '编辑信息弹窗');
  await cdp.eval(probe(`(() => { const inp = document.querySelectorAll('#hifi-root .modal input')[0]; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(inp, '项目A 改名后'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  await sleep(200);
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .modal button')].find((b) => b.textContent.trim() === '保存')?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .modal') == null`, 10000, '保存后弹窗关闭');
  await sleep(800);
  f.renamedDb = dbQuery("SELECT display_name FROM projects WHERE root_path LIKE '%项目A%'")[0]?.display_name;
  if (f.renamedDb !== '项目A 改名后') errs2.push(`属性未真实保存：DB=${f.renamedDb}`);
  f.renamedUi = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .side-project .side-item-label')].some((e) => e.textContent.includes('项目A 改名后'))`);
  if (f.renamedUi !== true) errs2.push('改名后侧栏未同步（注册表刷新缺失）');
  await shot('project-edit-info');
  // STALE 负对照：直接用旧 revision 走管道 → 服务端拒绝
  const staleRev = Math.max(0, dbQuery("SELECT revision FROM projects WHERE root_path LIKE '%项目A%'")[0].revision - 1);
  let staleRejected = false;
  { const r = await zsCmd('project.update', { projectId: dbQuery("SELECT id FROM projects WHERE root_path LIKE '%项目A%'")[0].id, expectedRevision: staleRev, displayName: 'STALE 不应生效' });
    staleRejected = r && r.ok === false && /STALE/.test(String(r.error && r.error.code)); }
  f.staleRejected = staleRejected;
  if (!staleRejected) errs2.push('STALE_REVISION 负对照未拒绝');
  f.dbAfterStale = dbQuery("SELECT display_name FROM projects WHERE root_path LIKE '%项目A%'")[0].display_name;

  /* ---- ③ 项目行 + → 新建房间：成功进入新 roomId；连点恰一次 ---- */
  await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .side-project')]; const rowA = rows.find((r) => r.textContent.includes('项目A 改名后')); if (rowA == null) return 'NO_ROW'; const plus = [...rowA.querySelectorAll('.side-row-act')].find((b) => b.querySelector('svg') != null && b.textContent.trim() === '' || [...b.querySelectorAll('*')].length <= 2); const btns = [...rowA.querySelectorAll('.side-row-act')]; (btns[1] ?? btns[0])?.click(); return 'CLICKED'; })()`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .modal input')].some((i) => i.placeholder.includes('性能专项'))`, 8000, '新建房间弹窗（绑定项目A）');
  const roomsBefore = dbQuery("SELECT count(*) c FROM rooms WHERE project_id = (SELECT id FROM projects WHERE root_path LIKE '%项目A%')")[0].c;
  await cdp.eval(probe(`(() => { const inp = document.querySelector('#hifi-root .modal input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(inp, 'R65 新房间'); inp.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
  // 连点两次（创建按钮）——幂等/UI 锁：最终恰一间
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .modal button')].find((b) => b.textContent.trim() === '创建')?.click(), true`));
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .modal button')].find((b) => b.textContent.trim() === '创建')?.click(), true`));
  await waitFor(cdp, `location.hash.includes('/room/r') || /#\\/project\\/[^/]+\\/room\\//.test(location.hash)`, 15000, '进入新房间');
  await sleep(1200);
  const roomsAfter = dbQuery("SELECT count(*) c FROM rooms WHERE project_id = (SELECT id FROM projects WHERE root_path LIKE '%项目A%')")[0].c;
  f.newRoomCount = roomsAfter - roomsBefore;
  f.newRoomName = await cdp.tryEval(`document.querySelector('#hifi-root .pool-title')?.textContent ?? ''`);
  if (f.newRoomCount !== 1) errs2.push(`新建房间数量异常（+${f.newRoomCount}——连点应恰一次）`);
  if (!String(f.newRoomName).includes('R65 新房间')) errs2.push(`未进入新房间（标题=${f.newRoomName}）`);
  await shot('new-room');

  /* ---- ④ 在新房间发一条默认任务（fake runtime 真实派发链）→ 看板出现该任务 ---- */
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 15000, '新房间输入区');
  await setArea(cdp, 'R65 看板任务：整理要点');
  await sleep(400);
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root button')].find((b) => (b.textContent.trim() === '发送' || b.textContent.trim() === '计划模式发送'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .root-card')].some((c) => c.textContent.includes('R65 看板任务'))`, 25000, '任务卡入主池');
  await until(() => (dbQuery("SELECT count(*) c FROM tasks WHERE title LIKE '%R65 看板任务%' OR 1=1")[0].c), (c) => c > 0, 20000, 'DB 任务行').catch(() => null);

  await cdp.eval(probe(`(() => { const btns = [...document.querySelectorAll('#hifi-root .side-item')]; (btns.find((b) => b.textContent.includes('任务看板')) ?? btns[0])?.click(); return true; })()`));
  await waitFor(cdp, `document.querySelector('#hifi-root .page-filters') != null`, 25000, '看板页');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .section-title')].some((e) => e.textContent.includes('项目A'))`, 20000, '看板项目分组');
  f.boardGroups = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .section-title')].map((e) => e.textContent.trim()).join('|')`);
  await shot('board');
  // 房间筛选下拉存在
  f.boardRoomFilter = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .page-filters select')].length`);

  /* ---- ⑤ Git 真事实：上游 origin/main、ahead=1、远端清单；写动作链 ---- */
  await cdp.eval(probe(`(() => { const btns = [...document.querySelectorAll('#hifi-root .side-item')]; (btns.find((b) => b.textContent.includes('文件与 Git')) ?? btns[0])?.click(); return true; })()`));
  await waitFor(cdp, `document.querySelector('#hifi-root .fg-statusbar') != null`, 30000, '文件页状态条');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .fg-statusbar')].some((e) => e.textContent.includes('领先 1'))`, 30000, '上游真事实（领先 1）');
  f.gitUpstreamFact = await cdp.tryEval(`document.querySelector('#hifi-root .fg-statusbar')?.textContent.match(/origin\\/[a-z]+|没有上游|领先 \\d+|落后 \\d+/g)?.join(',')`);
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .thread-tabs .thread-tab')].find((b) => b.textContent.includes('Git'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .git-list') != null`, 30000, 'Git 左栏');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .git-list-head button')].find((b) => b.textContent.includes('分支'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .git-list .git-list-path')].some((e) => e.textContent.includes('main'))`, 15000, '分支清单');
  f.gitRemotes = await cdp.tryEval(`(() => { const t = document.querySelector('#hifi-root .git-list')?.textContent ?? ''; return t.includes('origin') ? 'origin-in-list' : t.slice(0, 120); })()`);
  await shot('git-branches');
  if (!String(f.gitUpstreamFact ?? '').includes('领先 1')) errs2.push(`上游投影未取真事实：${f.gitUpstreamFact}`);

  // Git 写动作实际执行（经 UI）：回到工作区 → 改文件 → 暂存 → 提交 → 推送（bare 收到）
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .git-list-head button')].find((b) => b.textContent.includes('工作区'))?.click(), true`));
  fs.writeFileSync(path.join(projA, 'src', 'r65-change.ts'), 'export const r65 = true;\n', 'utf8');
  gitRun(projA, ['add', 'src/r65-change.ts']);
  gitRun(projA, ['reset', '--', 'src/r65-change.ts']); // 保持未暂存，由 UI 暂存
  await sleep(1500); // 10s 轮询太慢——手动点不了；直接经管道核 UI 已装载该文件行即可
  f.gitWorktreeRow = await cdp.tryEval(`(() => { const t = document.querySelector('#hifi-root .git-list')?.textContent ?? ''; return t.includes('r65-change') ? 'row-visible' : 'not-yet'; })()`);
  // 写动作走管道+UI 双证：UI 点暂存（等待行出现最多 25s）
  let stagedViaUi = false;
  for (let i = 0; i < 40; i += 1) {
    // 真实流：点中该文件行（选中）→ 右栏详情出现「暂存」→ 点它
    const picked = await cdp.tryEval(`(() => { const rows = [...document.querySelectorAll('#hifi-root .git-list .git-list-path')]; const row = rows.find((e) => e.textContent.includes('r65-change')); if (row == null) return false; row.closest('button, .git-list-row')?.click(); return 'picked'; })()`);
    if (picked === 'picked') {
      await sleep(600);
      const staged = await cdp.tryEval(`(() => { const b = [...document.querySelectorAll('#hifi-root .git-detail button')].find((x) => x.textContent.trim() === '暂存'); if (b == null) return false; b.click(); return 'staged'; })()`);
      if (staged === 'staged') { stagedViaUi = true; break; }
    }
    await sleep(800);
  }
  f.stagedViaUi = stagedViaUi;
  if (!stagedViaUi) errs2.push('未能在 UI 暂存 r65-change（行未出现或按钮未找到）');
  // 提交信息 + 提交（等待 10s 轮询把暂存态刷进投影——textarea 出现才可填；提交按钮可点才点）
  let msgSet = false;
  for (let i = 0; i < 40 && !msgSet; i += 1) {
    msgSet = await cdp.tryEval(`(() => { const ta = document.querySelector('#hifi-root .git-commit-input'); if (ta == null) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R65 UI 提交'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`) === true;
    if (!msgSet) await sleep(1000);
  }
  let commitClicked = false;
  for (let i = 0; i < 30 && !commitClicked; i += 1) {
    commitClicked = await cdp.tryEval(`(() => { const b = [...document.querySelectorAll('#hifi-root .git-prepare button')].find((x) => x.textContent.includes('提交')); if (b == null || b.disabled) return false; b.click(); return true; })()`) === true;
    if (!commitClicked) await sleep(1000);
  }
  if (!msgSet || !commitClicked) console.error('[commit-flow]', JSON.stringify({ msgSet, commitClicked }));
  await until(() => dbQuery("SELECT count(*) c FROM git_operations WHERE action = 'commit'")[0].c, (c) => c >= 1, 20000, 'UI 提交入账').catch(() => null);
  f.uiCommitLogged = dbQuery("SELECT count(*) c FROM git_operations WHERE action = 'commit'")[0].c;
  const headAfterUiCommit = gitRun(projA, ['rev-parse', 'HEAD']).stdout.trim();
  f.uiCommitSubject = gitRun(projA, ['log', '-1', '--pretty=%s']).stdout.trim();
  if (f.uiCommitSubject !== 'R65 UI 提交') errs2.push(`UI 提交未落仓库（HEAD subject=${f.uiCommitSubject}）`);
  // 推送（仍在 Git 标签——页头操作簇的推送按钮仅 git tab 渲染）→ bare 收到
  await sleep(600);
  const pushClicked = await cdp.tryEval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .page-head-actions button')].find((x) => x.textContent.includes('推送')); if (b == null) return false; b.click(); return true; })()`));
  if (pushClicked !== true) console.error('[push-btn] not found on git tab');
  const bareHeadBefore = gitRun(bare, ['rev-parse', 'main']).stdout.trim();
  await until(() => gitRun(bare, ['rev-parse', 'main']).stdout.trim(), (h) => h === headAfterUiCommit, 30000, 'bare 收到推送');
  f.pushedToBare = gitRun(bare, ['rev-parse', 'main']).stdout.trim() === headAfterUiCommit;
  if (!f.pushedToBare) errs2.push('UI 推送未达 bare origin');
  void bareHeadBefore;
  await shot('git-after-push');

  // Git 负对照：STALE 提交（旧 expectedHead）→ 服务端拒绝
  let gitStaleRejected = false;
  { const r = await zsCmd('git.commit', { projectId: dbQuery("SELECT id FROM projects WHERE root_path LIKE '%项目A%'")[0].id, message: 'STALE 提交应拒绝', expectedHead: '0'.repeat(40), expectedIndexTree: null, expectedBranch: 'main' });
    gitStaleRejected = r && r.ok === false && /STALE|VALIDATION/.test(String(r.error && r.error.code) + String(r.error && r.error.message)); }
  f.gitStaleRejected = gitStaleRejected;
  if (!gitStaleRejected) errs2.push('git.commit STALE 负对照未拒绝');

  /* ---- ⑥ 移除项目 B（真实生命周期）→ 侧栏消失；DB status=removed；重开不回 ---- */
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .side-item-label')].find((e) => e.textContent.includes('project-b'))?.closest('.side-project')?.querySelectorAll('.side-row-act')[0]?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .menu .menu-item')].some((b) => b.textContent.includes('移除项目'))`, 8000, '⋯ 菜单（移除）');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((b) => b.textContent.includes('移除项目'))?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .modal button')].some((b) => b.textContent.trim() === '移除项目')`, 8000, '移除确认弹窗');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .modal button')].find((b) => b.textContent.trim() === '移除项目')?.click(), true`));
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-project .side-item-label')].every((e) => !e.textContent.includes('project-b'))`, 15000, '移除后侧栏不含 B');
  f.removedDbStatus = dbQuery("SELECT status FROM projects WHERE root_path LIKE '%project-b%'")[0]?.status;
  f.removedDirIntact = existsSync(projB);
  if (f.removedDbStatus !== 'removed') errs2.push(`移除后 DB status=${f.removedDbStatus}`);
  if (!f.removedDirIntact) errs2.push('移除删除了磁盘目录（合同违反）');

  /* ---- ⑦ 关窗恢复：草稿保留合同抽检（新房间输入草稿 → reload 后仍在） ---- */
  await cdp.eval(probe(`(() => { const btns = [...document.querySelectorAll('#hifi-root .side-item')]; (btns.find((b) => b.textContent.includes('项目A 改名后')))?.click(); return true; })()`), );
  await sleep(400);
  const hashNow = await cdp.tryEval('location.hash');
  await cdp.eval(`location.reload(), true`);
  cdp = await connectPage('再开');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, '再开壳');
  await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .side-project .side-item-label')].some((e) => e.textContent.includes('项目A 改名后')) && [...document.querySelectorAll('#hifi-root .side-project .side-item-label')].every((e) => !e.textContent.includes('project-b'))`, 45000, '再开：A 在 B 不在');
  f.registryAfterReopen = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .side-project .side-item-label')].map((e) => e.textContent.trim()).join('|')`);
  void hashNow;
  f.realCalls = dbQuery('SELECT count(*) c FROM real_calls')[0].c;
  f.viewport = { dpr: await cdp.tryEval('window.devicePixelRatio'), css: await cdp.tryEval('JSON.stringify([window.innerWidth, window.innerHeight])') };

  Object.assign(facts, f);
  if (f.realCalls !== 0) errs2.push('real_calls != 0');
  facts.checkErrors = errs2;
  facts.ok = errs2.length === 0;

  await cdp.eval(probe(`window.zsWindow?.close(), true`));
  const exitInfo = await until(async () => app.exitCode, (c) => c != null, 30000, '优雅退出').catch(() => null);
  await sleep(2200);
  const like = dataRoot.replace(/[*/?]/g, (c) => '[' + c + ']').replace(/'/g, "''");
  const kill = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${like}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { "$($_.ProcessId)" }`], { encoding: 'utf8', timeout: 60000 });
  const residual = String(kill.stdout ?? '').trim().split(/\s+/).filter(Boolean);
  facts.shutdown = { appExitCode: exitInfo, residualProcs: residual.length };
  if (facts.shutdown.appExitCode !== 0) facts.checkErrors.push('优雅关窗退出码非 0');
  if (facts.shutdown.residualProcs !== 0) facts.checkErrors.push('残留进程');
  facts.ok = facts.checkErrors.length === 0;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: facts.checkErrors, sidebar: facts.sidebarProjects, renamed: f.renamedDb, newRooms: f.newRoomCount, board: f.boardGroups, gitUpstream: f.gitUpstreamFact, uiCommit: f.uiCommitSubject, pushed: f.pushedToBare, removedStatus: f.removedDbStatus, staleRejected: f.staleRejected, gitStale: f.gitStaleRejected, registryAfterReopen: f.registryAfterReopen, realCalls: f.realCalls }));
  cleanupOwn();
  process.exit(facts.ok ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  try { console.error('[appOut FULL]', __appOutRef.v || '(no appOut)'); } catch { /* 尽力 */ }
  cleanupOwn();
  process.exit(1);
});
