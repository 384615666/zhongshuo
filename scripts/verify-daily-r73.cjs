#!/usr/bin/env node
/**
 * verify-daily-r73.cjs —— R73「页面切换、预览布局与导航取消收口」门（2026-10-09）
 *
 * 对应复核：desktop-v10-user-layout-feedback-20261009.md（A 自动收起 / B 真分隔条 /
 * C 真放大）+ review-r72-navigation-cancellation §P1（已取消定位仍切项目）+ §3（阅读器
 * 完成态）。G1–G6：
 *  - G1 文件页→**真实侧栏房间点击**：房间对话/输入框正常、预览不占用；标签/阅读状态/
 *    草稿保留；显式重开恢复；跨项目与在途读取后同理。
 *  - G2 真分隔条：主池+预览（L3）/线程+预览（L4）分隔条在真实两区边界；原生 pointer
 *    拖动 rect 实际变化（正/反/最小宽/双击复位）；窄窗降级（无双线程/多输入条/横向
 *    裁剪）；窗口缩窄拉宽不棘轮（拖动宽度保持）。
 *  - G3 真放大：放大占满工作内容区（rect 实测）/还原回并排比例/Esc 还原；菜单 Esc
 *    优先；切标签阅读位置/页码保持；私信共用预览同核。
 *  - G4 导航取消：B→A 定位在途→设置页（URL/当前项目/navigation.get 保持 B，零 nav
 *    写入）；两条深链同发只落最新意图；未取消正例（跨项目/看板/待办/收藏/搜索/冷启动/
 *    冷房间直链 active已恢复但房间未装载）。
 *  - G5 PPT 逐页真实 render-ready walk：每页等 `data-zs-render=ready`（页+代次绑定），
 *    页级完整记录，任何 error/超时进 errs。
 *  - G6 R72 必要回归：文件树 20–32MiB 真件正例 + Git 往返（中性→Git）+ XLSX 滚动/
 *    sheet 恢复 + 另存原字节。
 *
 * 约束：零真实模型调用；用户样本只读复制；不重跑历史 H2/H3 清单。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const os = require('node:os');

const repo = path.resolve(__dirname, '..');
const runId = `r73-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r73-${runId}`);

const PORT = 9714;
const shotsDir = path.join(outDir, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
const saveAsDir = path.join(outDir, 'saved');
fs.mkdirSync(saveAsDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)?.slice(0, 300)}）`);
    await sleep(250);
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.consoleErrors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.consoleErrors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 60_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 300)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  async shot(name) { try { const png = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(png.data, 'base64')); return true; } catch { return false; } }
}
async function connectPage(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); await c.send('Runtime.enable'); await c.send('Page.enable'); return c; }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
const waitFor = async (cdp, expr, ms, label) => until(() => cdp.tryEval(probe(expr)).catch(() => null), (v) => v, ms, label);
const own = new Set();
function cleanupOwn() { for (const c of [...own]) { if (c.exitCode != null) continue; try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } } }
const dbOf = (root) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(root, 'state.sqlite')); return { q: (sql, ...a) => db.prepare(sql).all(...a), get: (sql, ...a) => db.prepare(sql).get(...a), close: () => db.close() }; };
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');
let __appOut = { v: '' };
let f = { g1: {}, g2: {}, g3: {}, g4: {}, g5: { pages: [] }, g6: {} };

/* ---------------- 夹具（用户样本只读复制到自有目录） ---------------- */
const SAMPLES = 'C:/Users/user/Documents/文档测试';
const PPT_NAME = '内蒙古职工互助系统建设方案@1010.pptx';
const XLSX_NAME = '去重翻译表v4_名词统一.xlsx';
const FIX = {
  pptxBig: path.join(SAMPLES, PPT_NAME),
  xlsx: path.join(SAMPLES, XLSX_NAME),
};
for (const [k, p] of Object.entries(FIX)) { if (!fs.existsSync(p)) { console.error(`样本缺失：${p}`); process.exit(2); } }

async function launchApp(dataRoot, extraEnv = {}) {
  const electronExe = path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
  const app = spawn(electronExe, [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: dataRoot, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_SAVEAS_AUTO_DIR: saveAsDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  own.add(app);
  app.once('exit', () => own.delete(app));
  app.stdout.on('data', (c) => { __appOut.v += c; });
  app.stderr.on('data', (c) => { __appOut.v += c; });
  const cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 壳挂载');
  return { app, cdp };
}
async function closeApp(app, cdp) {
  try { if (cdp != null && !cdp.closed) await cdp.send('Browser.close'); } catch { /* 已退 */ }
  await until(async () => { try { process.kill(app.pid, 0); return false; } catch { return true; } }, (v) => v, 20000, 'app 优雅退出').catch(async () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } });
  await sleep(1800);
}
async function pageCmd(cdp, method, params, commandId) {
  const v = await cdp.send('Runtime.evaluate', {
    expression: `window.zs.command({ protocolVersion: 1, commandId: ${JSON.stringify(commandId ?? `g73-${Math.random().toString(36).slice(2, 10)}`)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
    awaitPromise: true, returnByValue: true,
  });
  return JSON.parse(v.result.value);
}
const pageOk = async (cdp, method, params) => { const r = await pageCmd(cdp, method, params); if (r && r.ok !== true) throw new Error(`${method}: ${r.error?.message}`); return r.data ?? r; };
async function bootProject(cdp) {
  await cdp.eval('location.reload(), true');
  const c = await connectPage('boot 重载');
  await waitFor(c, `document.querySelector('#hifi-root .side-project .side-item-label') != null || document.body.textContent.includes('默认房间')`, 45000, '侧栏项目/默认房间');
  await sleep(900);
  return c;
}
async function openRoomComposer(cdp, root, projId) {
  await until(() => cdp.tryEval(probe(`document.body.classList.contains('hifi-on') && (document.querySelector('#hifi-root .side-project .side-item-label') != null || document.body.textContent.includes('默认房间'))`)).catch(() => null), (v) => v, 45000, '房间前就绪');
  await cdp.eval(`location.hash = ${JSON.stringify(`/project/${projId}`)}; true`);
  await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, '项目装载（默认房间）');
  const room = dbOf(root).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', projId);
  await cdp.eval(`location.hash = ${JSON.stringify(`/room/${room.id}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, '房间输入区');
  await sleep(600);
  return room.id;
}
const waitSendEnabled = (cdp, ms = 30000) => until(() => cdp.tryEval(probe(`(() => { const b = document.querySelector('#hifi-root .composer-send'); return b != null && b.disabled !== true; })()`)).catch(() => null), (v) => v === true, ms, '发送按钮可用');
async function uploadViaPage(cdp, filePath, name, mime = 'application/octet-stream') {
  const b64 = fs.readFileSync(filePath).toString('base64');
  await cdp.eval(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} }));
    const input = document.querySelector('#hifi-root input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}
let chipStatesSnapshot = null;
async function chipStates(cdp) {
  return await cdp.tryEval(`(() => {
    const chips = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')].map((c) => ({ att: c.getAttribute('data-zs-att') || '', err: c.getAttribute('data-zs-att-error') || '', warn: c.getAttribute('data-zs-att-warn') || '', text: c.textContent.slice(0, 120) }));
    return chips;
  })()`);
}
async function waitChip(cdp, name, state, ms = 60000) {
  return await until(async () => {
    const chips = await chipStates(cdp);
    chipStatesSnapshot = chips;
    const hit = chips.find((c) => (state === 'failed' ? c.err === name : state === 'warn' ? c.warn === name : c.att === 'ready' && c.text.includes(name) && !c.err && !c.warn));
    return hit ?? null;
  }, (v) => v != null, ms, `芯片 ${name}=${state}`).catch((e) => { throw new Error(`${e.message}；chips=${JSON.stringify(chipStatesSnapshot)}`); });
}
/** 上传→等 ready；主进程 15s 超时类环境抖动自动重传（最多 3 轮）。 */
async function uploadWithRetry(cdp, filePath, name, mime, ms = 120000) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await uploadViaPage(cdp, filePath, name, mime);
    try {
      await waitChip(cdp, name, 'ready', ms);
      return attempt;
    } catch (e) {
      const failed = await cdp.tryEval(probe(`(() => { const cs = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')]; const bad = cs.find((c) => (c.getAttribute('data-zs-att') === 'failed') && c.textContent.includes(${JSON.stringify(name)})); if (bad != null) { const btn = [...bad.querySelectorAll('button')].find((b) => (b.title || '').includes('移除失败')); btn?.click(); return true; } return false; })()`));
      if (attempt === 3 || failed !== true) throw e;
      await sleep(800);
    }
  }
  throw new Error('unreachable');
}

async function clickChipPreview(cdp, name) {
  for (let i = 0; i < 30; i += 1) {
    const v = await cdp.tryEval(probe(`(() => {
      const chips = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')];
      const chip = chips.find((c) => (c.getAttribute('data-zs-att') === 'ready') && c.textContent.includes(${JSON.stringify(name)}));
      if (chip == null) return 'NO_CHIP';
      const btn = [...chip.querySelectorAll('button')].find((b) => b.textContent.trim() === '预览');
      if (btn == null) return 'NO_BTN';
      btn.click(); return true;
    })()`));
    if (v === true) return true;
    await sleep(500);
  }
  throw new Error(`clickChipPreview: ${name} 未就绪`);
}
async function saveOriginal(cdp, namePart) {
  const before = new Set(fs.readdirSync(saveAsDir));
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item, #hifi-root [role=menu] .menu-item')].find((x) => x.textContent.includes('下载原文件'))?.click(), true`));
  await until(() => { try { return fs.readdirSync(saveAsDir).filter((n) => !before.has(n)).length; } catch { return 0; } }, (n) => n >= 1, 25000, `另存落盘 ${namePart}`);
  await sleep(800);
  const saved = fs.readdirSync(saveAsDir).filter((n) => !before.has(n)).map((n) => path.join(saveAsDir, n)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  return { path: saved, sha256: sha256Buf(fs.readFileSync(saved)), bytes: fs.statSync(saved).size };
}
async function openMoreMenu(cdp) {
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '更多菜单');
}
const clickTreeFile = async (cdp, exactName) => {
  await until(() => cdp.tryEval(probe(`document.body.textContent.includes(${JSON.stringify(exactName)})`)).catch(() => null), (v) => v, 30000, `树列 ${exactName}`);
  await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === ${JSON.stringify(exactName)}); rows[rows.length - 1]?.click(); return true; })()`));
};
const realCallsOf = (root) => { try { return dbOf(root).get('SELECT count(*) c FROM real_calls').c; } catch { return -1; } };

/* ---------------- 几何/拖动助手 ---------------- */
const rectsOf = (cdp) => cdp.eval(probe(`(() => {
  const ctx = document.querySelector('#hifi-root .col-main') ?? document.querySelector('#hifi-root .col-thread');
  const pv = document.querySelector('#hifi-root .preview-pane');
  const sp = document.querySelector('#hifi-root .splitter[aria-label*="预览"]');
  const r = (el) => el == null ? null : (() => { const b = el.getBoundingClientRect(); return { l: Math.round(b.left), w: Math.round(b.width), t: Math.round(b.top), h: Math.round(b.height) }; })();
  return { ctx: r(ctx), pv: r(pv), sp: r(sp) };
})()`));
async function dragSplitter(cdp, dx) {
  const sp = await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root .splitter[aria-label*="预览"]').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.x, y: sp.y, button: 'left', clickCount: 1 });
  const steps = 4;
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(sp.x + (dx * i) / steps), y: sp.y, button: 'left', buttons: 1 });
    await sleep(110);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(sp.x + dx), y: sp.y, button: 'left', clickCount: 1 });
  await sleep(500);
}
const resizeWindow = (cdp, w, h) => cdp.eval(`window.resizeTo(${w}, ${h}), true`).then(() => sleep(900));
/** 真实侧栏房间点击（必要时先展开项目折叠箭头）。 */
async function sidebarRoomClick(cdp, roomName = '默认房间') {
  for (let i = 0; i < 6; i += 1) {
    const hit = await cdp.tryEval(probe(`(() => { const rooms = [...document.querySelectorAll('#hifi-root button.side-item.sub')]; const hit = rooms.find((x) => x.textContent.includes(${JSON.stringify(roomName)})); if (hit != null) { hit.click(); return true; } return null; })()`));
    if (hit === true) return true;
    await cdp.eval(probe(`(() => { const caret = document.querySelector('#hifi-root .side-caret[aria-expanded=false]'); caret?.click(); return true; })()`));
    await sleep(700);
  }
  throw new Error(`侧栏房间点击未命中：${roomName}`);
}

(async () => {
  const errs = [];
  const realCallRoots = {};
  process.on('SIGINT', () => { cleanupOwn(); process.exit(130); });

  /* ================= G1 文件页→真实侧栏房间点击：自动收起 + 会话保留 ================= */
  {
    const root1 = path.join(outDir, 'root1');
    const projDir = path.join(outDir, 'proj1');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '说明.md'), '# G1 文件\n\nFILES-G1-CONTENT 正文', 'utf8');
    let { app, cdp } = await launchApp(root1, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    const roomId = dbOf(root1).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id).id;
    // 文件页打开 MD（读一部分→滚动位置）
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 文件页');
    await clickTreeFile(cdp, '说明.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('FILES-G1-CONTENT')`, 45000, 'G1 文件页预览');
    await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root .preview-body'); b.scrollTop = 60; b.dispatchEvent(new Event('scroll', { bubbles: true })); return true; })()`));
    await sleep(400);
    // 房间草稿（未发送）——切走后应保留
    // （在房间内预写草稿再回文件页 → 点侧栏房间）
    await openRoomComposer(cdp, root1, proj.id);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'G1-房间草稿保留检查'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(500);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 回文件页');
    await sleep(600);
    // 预览恢复（文件页显式重开：重新选中树节点）
    await clickTreeFile(cdp, '说明.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('FILES-G1-CONTENT')`, 45000, 'G1 文件页重开');
    // **真实侧栏房间点击**
    await sidebarRoomClick(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G1 侧栏点击进房间');
    await sleep(1400);
    f.g1.roomState = await cdp.eval(probe(`(() => ({
      composer: document.querySelector('#hifi-root textarea.composer-input') != null,
      draft: (document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').includes('G1-房间草稿保留检查'),
      pool: document.querySelector('#hifi-root .col-main') != null,
      previewVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(),
      reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null,
    }))()`));
    await cdp.shot('g1-room-after-sidebar-click');
    // 重开按钮恢复（显式）→ 内容与滚动位置在
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-reopen')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('FILES-G1-CONTENT')`, 30000, 'G1 重开恢复');
    f.g1.reopenContent = true;
    f.g1.reopenTabs = await cdp.tryEval(`document.querySelectorAll('#hifi-root .preview-tab').length`);
    f.g1.reopenScrollTop = await cdp.tryEval(probe(`Math.round(document.querySelector('#hifi-root .preview-body')?.scrollTop ?? -1)`));
    // 重开后再次离开/回来：显式不乒乓（第二次仍显示）
    await cdp.eval(`location.hash = '/settings'; true`);
    await sleep(700);
    await sidebarRoomClick(cdp);
    try {
      await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G1 回房间2');
    } catch (e) {
      const dump = await cdp.tryEval(probe(`(() => ({ hash: location.hash.slice(0, 60), body: document.body.textContent.replace(/\s+/g, ' ').slice(0, 200) }))()`));
      throw new Error(`G1 回房间2：${JSON.stringify(dump)}；console=${JSON.stringify((cdp.consoleErrors ?? []).slice(0, 3))}`);
    }
    await sleep(1200);
    f.g1.explicitNoPingPong = await cdp.tryEval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })()`));
    // 在途读取不回弹：回到文件页选中文件（装载中切房间——用大 PPT 做在途窗口）
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 文件页2');
    fs.copyFileSync(FIX.pptxBig, path.join(projDir, PPT_NAME));
    // 文件树在挂载时扫描——离开再回来强制重扫（新复制的 PPT 才会列出）。
    await cdp.eval(`location.hash = '/settings'; true`);
    await sleep(500);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 文件页3');
    await clickTreeFile(cdp, PPT_NAME);
    await sleep(250); // 装载在途
    await sidebarRoomClick(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G1 在途后进房间');
    await sleep(9000); // 覆盖 22.5MB readFull 装载窗
    f.g1.inFlightNoPop = await cdp.tryEval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); return p == null || p.getBoundingClientRect().width === 0; })()`));
    f.g1.consoleErrors = (cdp.consoleErrors ?? []).filter((e) => !e.includes('React DevTools')).slice(0, 3);
    if (!(f.g1.roomState.composer && f.g1.roomState.pool && !f.g1.roomState.previewVisible && f.g1.roomState.reopenBtn)) errs.push(`G1：自动收起（${JSON.stringify(f.g1.roomState)}）`);
    if (f.g1.roomState.draft !== true) errs.push('G1：房间草稿丢失');
    if (f.g1.reopenTabs !== 1) errs.push(`G1：重开标签数（${f.g1.reopenTabs}）`);
    if (f.g1.reopenContent !== true) errs.push('G1：重开内容');
    if (f.g1.explicitNoPingPong !== true) errs.push('G1：显式重开后被再次自动收起（乒乓）');
    if (f.g1.inFlightNoPop !== true) errs.push('G1：在途读取回弹');
    if ((f.g1.consoleErrors ?? []).length > 0) errs.push(`G1：console（${JSON.stringify(f.g1.consoleErrors)}）`);
    realCallRoots.root1 = realCallsOf(root1);
    await closeApp(app, cdp);
  }

  /* ================= G2 真分隔条：边界/拖动/最小宽/复位/窄窗/不棘轮 ================= */
  {
    const root2 = path.join(outDir, 'root2');
    const projDir = path.join(outDir, 'proj2');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G2\n', 'utf8');
    let { app, cdp } = await launchApp(root2, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root2, proj.id);
    // ① 草稿上传→预览（L3：主池+预览）
    const md1 = path.join(outDir, 'g2.md');
    fs.writeFileSync(md1, '# G2 拖动\n\nG2-DRAG-CONTENT', 'utf8');
    await uploadWithRetry(cdp, md1, 'g2.md', 'text/markdown', 60000);
    await clickChipPreview(cdp, 'g2.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('G2-DRAG-CONTENT')`, 45000, 'G2 L3 预览');
    await sleep(800);
    const l3 = await rectsOf(cdp);
    f.g2.l3Boundary = l3 != null && l3.sp != null && l3.ctx != null && l3.pv != null && Math.abs((l3.ctx.l + l3.ctx.w) - l3.sp.l) <= 4 && Math.abs(l3.pv.l - (l3.sp.l + l3.sp.w)) <= 4;
    // ② 原生 pointer 拖动：右（窄）→ 左（宽）
    await dragSplitter(cdp, 200);
    const afterNarrow = await rectsOf(cdp);
    f.g2.dragRight = afterNarrow.pv.w < l3.pv.w - 120;
    await dragSplitter(cdp, -260);
    const afterWide = await rectsOf(cdp);
    f.g2.dragLeft = afterWide.pv.w > afterNarrow.pv.w + 120;
    // ③ 最小宽：大拖到右侧（预览→380 下限）
    await dragSplitter(cdp, 600);
    const afterMin = await rectsOf(cdp);
    f.g2.minWidth = afterMin.pv.w >= 378 && afterMin.pv.w <= 420;
    // ④ 双击复位
    await cdp.eval(probe(`(() => { const sp = document.querySelector('#hifi-root .splitter[aria-label*="预览"]'); sp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`));
    await sleep(500);
    const afterReset = await rectsOf(cdp);
    f.g2.dblclickReset = Math.abs(afterReset.pv.w - Math.min(620, afterWide.pv.w)) <= 8;
    // ⑤ 窗口缩窄拉宽不棘轮：拖到 500 → 缩窗 → 拉窗 → 宽度回 500±8
    await dragSplitter(cdp, -(afterReset.pv.w - 500));
    const dragged = await rectsOf(cdp);
    await resizeWindow(cdp, 980, 760);
    const narrowRects = await rectsOf(cdp);
    f.g2.narrowNoClip = await cdp.tryEval(probe(`(() => { const ws = document.querySelector('#hifi-root .workspace'); return ws.scrollWidth <= ws.clientWidth + 1; })()`));
    f.g2.narrowPv = narrowRects.pv.w;
    await resizeWindow(cdp, 1282, 802);
    const wideRects = await rectsOf(cdp);
    f.g2.ratchetFree = Math.abs(wideRects.pv.w - dragged.pv.w) <= 8;
    // ⑥ 线程+预览（L4）：已发根消息→线程→附件打开
    await closeAllTabs(cdp);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'G2记录'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await cdp.eval(probe(`(() => { const btn = document.querySelector('#hifi-root button[title*="本次运行设置"]'); btn?.click(); return btn != null; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .menu .menu-item')].some((x) => x.textContent.includes('仅记录，不请求回复'))`, 8000, 'G2 ⋯ 菜单');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复'))?.click(), true`));
    await sleep(300);
    await waitSendEnabled(cdp);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await until(() => { try { return dbOf(root2).get('SELECT count(*) c FROM messages WHERE body_json LIKE ?', '%G2记录%').c; } catch { return 0; } }, (c) => c >= 1, 30000, 'G2 记录落库');
    await sleep(1200);
    await until(async () => cdp.tryEval(probe(`(() => { if ([...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('附件') || x.textContent.includes('成果'))) return 'open'; const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('G2记录')); card?.click(); return card != null ? 'clicked' : null; })()`)).catch(() => null), (v) => v === 'open', 60000, 'G2 线程打开');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .thread-tab')].find((x) => x.textContent.includes('附件') || x.textContent.includes('成果')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button.msg-attach')].some((b) => b.textContent.includes('g2.md'))`, 45000, 'G2 附件按钮');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button.msg-attach')].find((x) => x.textContent.includes('g2.md')); b?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('G2-DRAG-CONTENT')`, 45000, 'G2 L4 预览');
    await sleep(800);
    const l4 = await rectsOf(cdp);
    // L4 上下文列是 col-thread
    // L4 左邻列通用判定：分隔条紧贴预览左缘，且其左侧存在一个真实内容列（col-thread 或 col-main）
    const l4Ctx = await cdp.eval(probe(`(() => { const sp = document.querySelector('#hifi-root .splitter[aria-label*="预览"]'); const pv = document.querySelector('#hifi-root .preview-pane'); if (sp == null || pv == null) return null; const spR = sp.getBoundingClientRect(); const pvR = pv.getBoundingClientRect(); const kids = [...document.querySelector('#hifi-root .workspace').children].filter((k) => k !== sp && k !== pv); const left = kids.map((k) => { const b = k.getBoundingClientRect(); return { cls: String(k.className).slice(0, 20), r: Math.round(b.left + b.width), w: Math.round(b.width) }; }).filter((x) => x.w > 50).sort((a, b) => a.r - b.r); return { spLeft: Math.round(spR.left), pvLeft: Math.round(pvR.left), leftCols: left.slice(0, 3), adj: Math.abs(Math.round(spR.left + spR.width) - Math.round(pvR.left)) <= 4 }; })()`));
    f.g2.l4Ctx = l4Ctx;
    f.g2.l4Boundary = l4Ctx != null && l4Ctx.adj === true && (l4Ctx.leftCols ?? []).some((c) => Math.abs(c.r - l4Ctx.spLeft) <= 6);
    await dragSplitter(cdp, 180);
    const l4After = await rectsOf(cdp);
    f.g2.l4Drag = l4.pv.w - l4After.pv.w > 120;
    // ⑦ 窄窗降级：940px 单区域——无双线程/多输入条/横向裁剪
    await resizeWindow(cdp, 940, 760);
    await sleep(1200);
    f.g2.narrowDegrade = await cdp.eval(probe(`(() => ({
      threads: document.querySelectorAll('#hifi-root .col-thread').length,
      composers: document.querySelectorAll('#hifi-root textarea.composer-input').length,
      noClip: (() => { const ws = document.querySelector('#hifi-root .workspace'); return ws.scrollWidth <= ws.clientWidth + 1; })(),
      switcher: document.querySelector('#hifi-root .single-region-switch') != null,
    }))()`));
    await resizeWindow(cdp, 1282, 802);
    await sleep(600);
    f.g2.summary = { l3: { pv: l3.pv.w }, afterNarrow: afterNarrow.pv.w, afterWide: afterWide.pv.w, afterMin: afterMin.pv.w, reset: afterReset.pv.w, dragged: dragged.pv.w, narrow: f.g2.narrowPv, wideBack: wideRects.pv.w, l4: l4.pv.w, l4After: l4After.pv.w };
    if (f.g2.l3Boundary !== true) errs.push('G2：L3 分隔条不在真实边界');
    if (f.g2.dragRight !== true || f.g2.dragLeft !== true) errs.push(`G2：拖动方向（right=${f.g2.dragRight} left=${f.g2.dragLeft}）`);
    if (f.g2.minWidth !== true) errs.push(`G2：最小宽（${JSON.stringify(f.g2.summary.afterMin)}）`);
    if (f.g2.dblclickReset !== true) errs.push(`G2：双击复位（${f.g2.summary.reset}）`);
    if (f.g2.narrowNoClip !== true || f.g2.ratchetFree !== true) errs.push(`G2：窄窗/棘轮（clip=${f.g2.narrowNoClip} ratchetFree=${f.g2.ratchetFree} ${f.g2.summary.dragged}→${f.g2.summary.narrow}→${f.g2.summary.wideBack}）`);
    if (f.g2.l4Boundary !== true || f.g2.l4Drag !== true) errs.push(`G2：L4 边界/拖动（boundary=${f.g2.l4Boundary} drag=${f.g2.l4Drag}）`);
    if (f.g2.narrowDegrade == null || f.g2.narrowDegrade.threads > 1 || f.g2.narrowDegrade.composers > 1 || f.g2.narrowDegrade.noClip !== true) errs.push(`G2：窄窗降级（${JSON.stringify(f.g2.narrowDegrade)}）`);
    realCallRoots.root2 = realCallsOf(root2);
    await cdp.shot('g2-l4-after');
    await closeApp(app, cdp);
  }

  /* ================= G3 真放大：rect 实测 + Esc + 标签位置 + 私信共用 ================= */
  {
    const root3 = path.join(outDir, 'root3');
    const projDir = path.join(outDir, 'proj3');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G3\n', 'utf8');
    fs.copyFileSync(FIX.xlsx, path.join(projDir, XLSX_NAME));
    let { app, cdp } = await launchApp(root3, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root3, proj.id);
    // ① 上传 XLSX（草稿→预览）→ 记录 sheet+滚动
    await uploadWithRetry(cdp, FIX.xlsx, XLSX_NAME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 120000);
    await clickChipPreview(cdp, XLSX_NAME);
    await waitFor(cdp, `(() => { const h = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); return h != null && h.querySelector('canvas') != null; })()`, 180000, 'G3 XLSX 引擎');
    await sleep(2000);
    await cdp.eval(probe(`(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); let best = null; for (const el of host.querySelectorAll('*')) { if (el.scrollHeight > el.clientHeight + 200 && (best == null || el.scrollHeight > best.scrollHeight)) best = el; } if (best != null) best.scrollTop = 30000; return true; })()`));
    await sleep(700);
    const sideBySide = await rectsOf(cdp);
    // ② 放大 → rect 铺满 workspace
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('放大预览')); b?.click(); return b != null; })()`));
    await sleep(700);
    const maxState = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); const ws = document.querySelector('#hifi-root .workspace'); const b = p.getBoundingClientRect(); const wb = ws.getBoundingClientRect(); const btn = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('还原预览大小')); return { pv: { l: Math.round(b.left), w: Math.round(b.width), t: Math.round(b.top), h: Math.round(b.height) }, ws: { l: Math.round(wb.left), w: Math.round(wb.width), t: Math.round(wb.top), h: Math.round(wb.height) }, restoreBtn: btn != null, cls: p.classList.contains('maximized') }; })()`));
    f.g3.maxFill = maxState.cls && maxState.restoreBtn && Math.abs(maxState.pv.l - maxState.ws.l) <= 4 && Math.abs(maxState.pv.w - maxState.ws.w) <= 4 && Math.abs(maxState.pv.t - maxState.ws.t) <= 4 && Math.abs(maxState.pv.h - maxState.ws.h) <= 4;
    f.g3.maxRect = maxState;
    await cdp.shot('g3-maximized');
    // ③ 菜单 Esc 优先：放大态打开「更多」菜单 → Esc → 菜单关、仍放大
    await openMoreMenu(cdp);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(700);
    f.g3.menuEscFirst = await cdp.tryEval(probe(`(() => ({ menuGone: document.querySelector('#hifi-root .menu') == null, stillMax: document.querySelector('#hifi-root .preview-pane')?.classList.contains('maximized') }))()`));
    // ④ Esc 还原 → 回并排宽度（±8）
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(700);
    const restored = await rectsOf(cdp);
    f.g3.escRestore = restored.pv != null && Math.abs(restored.pv.w - sideBySide.pv.w) <= 8;
    // ⑤ 阅读位置保持（sheet=同一张；滚动恢复——xlsx 合同=仅 sheet；此处核 sheet + 收起重开）
    f.g3.sheetKept = await cdp.tryEval(`document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on')?.getAttribute('data-zs-sheet-tab')`);
    // ⑥ 再放大→按钮还原
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('放大预览')); b?.click(); return true; })()`));
    await sleep(500);
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('还原预览大小')); b?.click(); return true; })()`));
    await sleep(600);
    const byBtn = await rectsOf(cdp);
    f.g3.btnRestore = Math.abs(byBtn.pv.w - sideBySide.pv.w) <= 8;
    // ⑦ 私信共用预览：DM 上传→预览→放大铺满→还原
    const member = dbOf(root3).get('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? LIMIT 1', proj.id, 'agent');
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: member.id });
    await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G3 DM');
    const md2 = path.join(outDir, 'g3.md');
    fs.writeFileSync(md2, '# G3 私信\n\nG3-DM-CONTENT', 'utf8');
    await uploadWithRetry(cdp, md2, 'g3.md', 'text/markdown', 60000);
    await clickChipPreview(cdp, 'g3.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('G3-DM-CONTENT')`, 45000, 'G3 DM 预览');
    const dmSide = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); const r = p.getBoundingClientRect(); return { w: Math.round(r.width) }; })()`));
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('放大预览')); b?.click(); return true; })()`));
    await sleep(700);
    const dmMax = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); const host = p.closest('.workspace') ?? p.closest('.main') ?? p.offsetParent; if (host == null) return { err: 'no-host' }; const b = p.getBoundingClientRect(); const hb = host.getBoundingClientRect(); return { pvW: Math.round(b.width), hostW: Math.round(hb.width), fills: Math.abs(b.width - hb.width) <= 6 && Math.abs(b.left - hb.left) <= 6 }; })()`));
    f.g3.dmMax = dmMax;
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('还原预览大小')); b?.click(); return true; })()`));
    await sleep(600);
    const dmBack = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); return Math.round(p.getBoundingClientRect().width); })()`));
    f.g3.dmRestore = Math.abs(dmBack - dmSide.w) <= 8;
    f.g3.summary = { side: sideBySide.pv.w, restored: restored.pv.w, byBtn: byBtn.pv.w, dmSide: dmSide.w, dmMaxW: dmMax.pvW, dmBack };
    if (f.g3.maxFill !== true) errs.push(`G3：放大铺满（${JSON.stringify(f.g3.maxRect)}）`);
    if (f.g3.menuEscFirst == null || f.g3.menuEscFirst.menuGone !== true || f.g3.menuEscFirst.stillMax !== true) errs.push(`G3：菜单 Esc 优先（${JSON.stringify(f.g3.menuEscFirst)}）`);
    if (f.g3.escRestore !== true) errs.push(`G3：Esc 还原（${sideBySide.pv.w}→${restored?.pv?.w}）`);
    if (f.g3.btnRestore !== true) errs.push(`G3：按钮还原（${byBtn.pv.w}）`);
    if (f.g3.sheetKept == null) errs.push('G3：sheet 丢失');
    if (f.g3.dmMax == null || f.g3.dmMax.fills !== true) errs.push(`G3：DM 放大（${JSON.stringify(f.g3.dmMax)}）`);
    if (f.g3.dmRestore !== true) errs.push(`G3：DM 还原（${dmSide.w}→${dmBack}）`);
    realCallRoots.root3 = realCallsOf(root3);
    await closeApp(app, cdp);
  }

  /* ================= G4 导航取消 + 正例矩阵 ================= */
  {
    const root4 = path.join(outDir, 'root4');
    const projA = path.join(outDir, 'projA4');
    const projB = path.join(outDir, 'projB4');
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projA, 'a说明.md'), '# A\n', 'utf8');
    fs.writeFileSync(path.join(projB, 'B说明.md'), '# B\n', 'utf8');
    let { app, cdp } = await launchApp(root4, {});
    const a = (await pageOk(cdp, 'project.open', { path: projA })).project;
    const b = (await pageOk(cdp, 'project.open', { path: projB })).project;
    cdp = await bootProject(cdp);
    // A：任务线程
    const roomRow = dbOf(root4).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', a.id);
    const roomConv = dbOf(root4).get('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', a.id, 'room');
    const members = await pageOk(cdp, 'member.list', { projectId: a.id });
    const agent = members.items.find((m) => m.principalType === 'agent');
    const TASK_BODY = 'R73导航任务';
    await pageCmd(cdp, 'message.submit', { target: { kind: 'room_root', projectId: a.id, conversationId: roomConv.cid, roomId: roomRow.id }, body: TASK_BODY, intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }] });
    await until(() => { try { return dbOf(root4).get('SELECT count(*) c FROM task_deliveries').c; } catch { return 0; } }, (c) => c >= 1, 180000, 'G4 交付');
    const threadId = dbOf(root4).get('SELECT conversation_thread_id FROM tasks WHERE project_id = ? LIMIT 1', a.id).conversation_thread_id;
    // ① 取消反例（复现独立复核场景）：活跃 B → A 线程深链（thread.get 在途）→ 同刻转设置页
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G4 B 聚焦');
    await sleep(1200);
    const activeBefore = await cdp.tryEval(probe(`(document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? '').trim()`));
    await cdp.eval(probe(`(() => { location.hash = ${JSON.stringify(`/thread/${threadId}`)}; location.hash = '/settings'; return location.hash; })()`));
    await waitFor(cdp, `location.hash.startsWith('#/settings')`, 15000, 'G4 设置页');
    await sleep(4500); // 覆盖 thread.get 回执+对齐链窗口
    f.g4.cancelState = await cdp.eval(probe(`(() => ({ hash: location.hash.slice(0, 30), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim(), toasts: [...document.querySelectorAll('.toast-host .toast')].map((t) => t.textContent.trim().slice(0, 40)) }))()`));
    const navPrefs = await pageCmd(cdp, 'navigation.get', { clientId: 'default' });
    f.g4.cancelPrefsActive = navPrefs.data?.prefs?.activeProjectId ?? null;
    f.g4.cancelOk = f.g4.cancelState.hash.startsWith('#/settings') && f.g4.cancelState.active.includes('projB') && f.g4.cancelState.toasts.length === 0;
    // ② 正例：未取消的同一深链正常完成（跨项目对齐+线程面板）
    await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadId}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .col-thread') != null`, 60000, 'G4 正例线程');
    f.g4.positive = await cdp.tryEval(probe(`(() => { const active = (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? '').trim(); return { active, thread: document.querySelector('#hifi-root .col-thread') != null }; })()`));
    f.g4.positiveOk = f.g4.positive?.thread === true && String(f.g4.positive?.active).includes('projA');
    // ③ 冷房间直链（active 已恢复但房间未装载）：切 B → 直达 A 房间路由
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G4 回 B');
    await sleep(1000);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${a.id}/room/${roomRow.id}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 60000, 'G4 冷房间直链');
    f.g4.coldRoomOk = true;
    f.g4.coldRoomActive = await cdp.tryEval(probe(`(document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? '').trim()`));
    // ④ 同 threadId 快速改 message/tab：直链两次（不同 tab），URL 落最新 tab
    await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadId}?tab=task`)}; true`);
    await sleep(150);
    await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadId}?tab=artifacts`)}; true`);
    await until(() => cdp.tryEval(probe(`(() => { const on = document.querySelector('#hifi-root .col-thread'); return on != null && location.hash.includes('tab=artifacts'); })()`)).catch(() => null), (v) => v, 60000, 'G4 最新意图 tab');
    f.g4.latestTabOk = true;
    if (f.g4.cancelOk !== true) errs.push(`G4：取消反例（${JSON.stringify(f.g4.cancelState)} prefs=${f.g4.cancelPrefsActive}）`);
    if (f.g4.cancelPrefsActive != null && f.g4.cancelPrefsActive === a.id) errs.push('G4：旧请求写了导航偏好');
    if (f.g4.positiveOk !== true) errs.push(`G4：未取消正例（${JSON.stringify(f.g4.positive)}）`);
    if (f.g4.coldRoomOk !== true || !String(f.g4.coldRoomActive).includes('projA')) errs.push(`G4：冷房间直链（active=${f.g4.coldRoomActive}）`);
    if (f.g4.latestTabOk !== true) errs.push('G4：同 threadId 最新意图');
    realCallRoots.root4 = realCallsOf(root4);
    await cdp.shot('g4-end');
    await closeApp(app, cdp);
  }

  /* ================= G5 PPT 逐页真实 render-ready walk ================= */
  {
    const root5 = path.join(outDir, 'root5');
    const projDir = path.join(outDir, 'proj5');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G5\n', 'utf8');
    fs.copyFileSync(FIX.pptxBig, path.join(projDir, PPT_NAME));
    let { app, cdp } = await launchApp(root5, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G5 文件页');
    const t0 = Date.now();
    await clickTreeFile(cdp, PPT_NAME);
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) > 0; })()`, 180000, 'G5 树开 PPT');
    f.g5.pages_attr = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages')`));
    f.g5.firstViewMs = Date.now() - t0;
    const walkT0 = Date.now();
    const failures = [];
    for (let n = 1; n <= f.g5.pages_attr; n += 1) {
      await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[${n - 1}]?.click(), true`));
      let landed = true;
      try {
        await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '${n}'`, 20000, `G5 页 ${n} 落位`);
      } catch { landed = false; }
      let renderState = landed ? await cdp.tryEval(`document.querySelector('#hifi-root .pptx-main .pptx-slide-mount')?.getAttribute('data-zs-render')`) : 'not-landed';
      if (landed && renderState !== 'ready' && renderState !== 'error') {
        renderState = await until(() => cdp.tryEval(`document.querySelector('#hifi-root .pptx-main .pptx-slide-mount')?.getAttribute('data-zs-render')`).catch(() => null), (v) => v === 'ready' || v === 'error', 25000, `G5 页 ${n} render`).catch((e) => `timeout:${String(e.message).slice(0, 60)}`);
      }
      const imgs = await cdp.tryEval(probe(`(() => { const root = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); if (root == null) return null; const is = [...root.querySelectorAll('img')]; return { n: is.length, d: is.filter((i) => i.complete && i.naturalWidth > 0).length }; })()`));
      const textLen = await cdp.tryEval(probe(`(document.querySelector('#hifi-root .pptx-main .pptx-slide-mount')?.textContent ?? '').trim().length`));
      const entry = { p: n, landed, render: renderState, imgs, textLen };
      f.g5.pages.push(entry);
      if (!landed || renderState !== 'ready' || (imgs != null && imgs.n > 0 && imgs.d !== imgs.n)) failures.push(entry);
    }
    f.g5.total = f.g5.pages_attr;
    f.g5.walkMs = Date.now() - walkT0;
    f.g5.failCount = failures.length;
    f.g5.failures = failures.slice(0, 10);
    f.g5.readyCount = f.g5.pages.filter((x) => x.render === 'ready').length;
    if (f.g5.failCount > 0 || f.g5.readyCount !== f.g5.total) errs.push(`G5：逐页 render（ready=${f.g5.readyCount}/${f.g5.total} fail=${f.g5.failCount} ${JSON.stringify(f.g5.failures.slice(0, 3))}）`);
    realCallRoots.root5 = realCallsOf(root5);
    await cdp.shot('g5-walk-end');
    await closeApp(app, cdp);
  }

  /* ================= G6 R72 必要回归（容量/Git/滚动/另存/阅读位置） ================= */
  {
    const root6 = path.join(outDir, 'root6');
    const projDir = path.join(outDir, 'proj6');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G6\n', 'utf8');
    fs.copyFileSync(FIX.pptxBig, path.join(projDir, PPT_NAME));
    fs.copyFileSync(FIX.xlsx, path.join(projDir, XLSX_NAME));
    // ① 文件树 20–32MiB 真件正例（R72 P1）+ 另存原字节
    let { app, cdp } = await launchApp(root6, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G6 文件页');
    await clickTreeFile(cdp, PPT_NAME);
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) >= 80; })()`, 180000, 'G6 树开大 PPT');
    f.g6.treePages = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages')`));
    // 翻到 40 → 记页 → 切 XLSX → 回 PPT → 页码保持（阅读位置回归）
    await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[39]?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '40'`, 90000, 'G6 跳页 40');
    await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('内蒙古')); t?.click(); return true; })()`)).catch(() => {});
    await clickTreeFile(cdp, XLSX_NAME);
    await waitFor(cdp, `(() => { const h = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); return h != null && h.querySelector('canvas') != null; })()`, 180000, 'G6 XLSX 引擎');
    await sleep(1500);
    f.g6.xlsxAria = Number(await cdp.tryEval(`document.querySelector('#hifi-root [role=grid]')?.getAttribute('aria-rowcount')`));
    await cdp.eval(probe(`(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); let best = null; for (const el of host.querySelectorAll('*')) { if (el.scrollHeight > el.clientHeight + 200 && (best == null || el.scrollHeight > best.scrollHeight)) best = el; } if (best != null) { best.scrollTop = 500000; return true; } return false; })()`));
    await sleep(800);
    f.g6.xlsxBottom = await cdp.eval(probe(`(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); let best = null; for (const el of host.querySelectorAll('*')) { if (el.scrollHeight > el.clientHeight + 200 && (best == null || el.scrollHeight > best.scrollHeight)) best = el; } return Math.round(best.scrollTop); })()`));
    // 回 PPT 标签 → 页码仍 40
    await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('内蒙古')); t?.click(); return true; })()`));
    await sleep(2000);
    f.g6.pageKept = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page')`);
    // 另存原字节
    await openMoreMenu(cdp);
    const saved = await saveOriginal(cdp, '内蒙古');
    f.g6.saveIdentical = saved.sha256 === sha256Buf(fs.readFileSync(FIX.pptxBig));
    // ② Git 往返（中性→Git）：临时目录（仓库外）
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-r73-plain-'));
    fs.writeFileSync(path.join(plainDir, 'p说明.md'), '# plain\n', 'utf8');
    const proj2 = (await pageOk(cdp, 'project.open', { path: plainDir })).project;
    // raw command 不写前端注册表——重载让注册表装载（r72 G2 同模式）。
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj2.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('p说明.md') || document.querySelector('#hifi-root .side-project .side-item-label') != null`, 45000, 'G6 项目2聚焦');
    await sleep(1000);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj2.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G6 文件页2');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('p说明.md')`)).catch(() => null), (v) => v, 30000, 'G6 树列2');
    await sleep(2600);
    f.g6.neutralBefore = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-git-neutral]') != null`);
    execFileSync('git', ['-C', plainDir, 'init', '-b', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', plainDir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', plainDir, '-c', 'user.name=r73', '-c', 'user.email=r73@local', 'commit', '-m', 'c1'], { stdio: 'ignore' });
    await cdp.eval(`location.hash = '/settings'; true`);
    await sleep(600);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj2.id}/files`)}; true`);
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('p说明.md')`)).catch(() => null), (v) => v, 30000, 'G6 树列3');
    await sleep(2800);
    f.g6.gitAfterInit = await cdp.eval(probe(`(() => ({ neutral: document.querySelector('#hifi-root [data-zs-git-neutral]') != null, repo: document.querySelector('#hifi-root .fg-statusbar')?.textContent.includes('Git 仓库') ?? false }))()`));
    if (f.g6.treePages < 80) errs.push(`G6：树开大 PPT（${f.g6.treePages}）`);
    if (String(f.g6.pageKept) !== '40') errs.push(`G6：页码保持（${f.g6.pageKept}）`);
    if (f.g6.saveIdentical !== true) errs.push('G6：另存不一致');
    if (f.g6.xlsxAria == null || f.g6.xlsxAria < 69000 || f.g6.xlsxBottom == null || f.g6.xlsxBottom <= 0) errs.push(`G6：XLSX（aria=${f.g6.xlsxAria} bottom=${f.g6.xlsxBottom}）`);
    if (f.g6.neutralBefore !== true) errs.push('G6：中性态');
    if (f.g6.gitAfterInit.neutral === true || f.g6.gitAfterInit.repo !== true) errs.push(`G6：中性→Git（${JSON.stringify(f.g6.gitAfterInit)}）`);
    realCallRoots.root6 = realCallsOf(root6);
    await closeApp(app, cdp);
  }

  const result = { runId, ok: errs.length === 0, errs, checks: f, realCallRoots, shotsDir };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: result.ok,
    errs,
    g1: { room: f.g1.roomState, reopen: f.g1.reopenContent, scroll: f.g1.reopenScrollTop, noPingPong: f.g1.explicitNoPingPong, inFlight: f.g1.inFlightNoPop },
    g2: { summary: f.g2.summary, l3Boundary: f.g2.l3Boundary, l4Boundary: f.g2.l4Boundary, narrow: f.g2.narrowDegrade },
    g3: { summary: f.g3.summary, maxFill: f.g3.maxFill, menuEsc: f.g3.menuEscFirst, esc: f.g3.escRestore, btn: f.g3.btnRestore, sheet: f.g3.sheetKept, dmMax: f.g3.dmMax },
    g4: { cancel: f.g4.cancelState, prefsActive: f.g4.cancelPrefsActive, positive: f.g4.positive, coldRoom: f.g4.coldRoomActive, latestTab: f.g4.latestTabOk },
    g5: { total: f.g5.total, ready: f.g5.readyCount, fail: f.g5.failCount, walkMs: f.g5.walkMs, firstViewMs: f.g5.firstViewMs, failures: f.g5.failures },
    g6: { tree: f.g6.treePages, pageKept: f.g6.pageKept, save: f.g6.saveIdentical, xlsx: [f.g6.xlsxAria, f.g6.xlsxBottom], git: [f.g6.neutralBefore, f.g6.gitAfterInit] },
    realCallRoots,
  }, null, 2));
  cleanupOwn();
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('gate 崩溃：', e); try { fs.writeFileSync(path.join(outDir, 'crash.txt'), String(e?.stack ?? e)); } catch { /* */ } cleanupOwn(); process.exit(1); });

async function closeAllTabs(cdp) {
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '菜单');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
  await sleep(700);
}
