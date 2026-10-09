#!/usr/bin/env node
/**
 * verify-daily-r74.cjs —— R74「两个交叉场景修复与日常使用收口」门（2026-10-09）
 *
 * 对应复核：review-r73-cross-context-and-inner-cancel-next-round-20261009.md
 *  - G1 混合标签自动收起矩阵（§P2）：room+files / thread+files / 显式恢复后再往返 /
 *    房间来源活动保护 / 跨项目 / DM / 在途读取不回弹——真实侧栏点击，核可见区域、
 *    恢复后的文件与阅读位置、草稿归属；判据=当前活动预览来源（不再要求历史全部一致）。
 *  - G2 项目打开内部取消（§P1）：B 活跃 → A 冷房间直链（project.open 在途，同刻双 hash
 *    转设置）→ 零提交（URL/当前项目/navigation.get/零旧错误）；装载刷新期取消（轮询捕
 *    获焦点翻转后跳走）→ 不写偏好+焦点还原；反序两条链接只落实最新意图；未取消正例。
 *    thread.get 阶段取消由 hifiNavCancelRound74 集成测试分列覆盖（受控保持），r73 门回归。
 *  - G3 上传重传口径（§三）：首次失败**逐项记录**（耗时/芯片错误原文/artifacts 是否已落
 *    库=saved-behind），分类明确拒绝 vs 传输/未知；通过不单独证明环境——事实进 result。
 *  - G4 PPT 逐页真实 render-ready walk（R73 保持）。
 *  - G5 R72 必要回归：文件树大 PPT/页码保持/另存原字节/XLSX 滚动/Git 中性→仓库。
 *
 * 约束：零真实模型调用；用户样本只读复制；不动用户数据根；迁移冻结。
 * ZS_R74_ONLY=g1|g2|g3|g4|g5 可单段运行（迭代/反例复现用）。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const os = require('node:os');

const repo = path.resolve(__dirname, '..');
const runId = `r74-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r74-${runId}`);
const ONLY = process.env.ZS_R74_ONLY || '';

const PORT = 9716;
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
const dbOf = (root) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(root, 'state.sqlite')); return { q: (sql, ...a) => db.prepare(sql).all(...a), get: (sql, ...a) => db.prepare(sql).get(...a), run: (sql, ...a) => db.prepare(sql).run(...a), close: () => db.close() }; };
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');
let __appOut = { v: '' };
let f = { g1: {}, g2: {}, g3: {}, g4: { pages: [] }, g5: {} };
const uploadDiag = [];

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
    expression: `window.zs.command({ protocolVersion: 1, commandId: ${JSON.stringify(commandId ?? `g74-${Math.random().toString(36).slice(2, 10)}`)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
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
/**
 * R74 §三：上传→等 ready；失败**先诊断后重传**——每次失败记录（耗时/芯片错误原文/
 * artifacts 落库=saved-behind），分类进入 uploadDiag；移除失败芯片重传（≤3）。重传通过
 * 不单独证明首次失败为环境——事实完整保留在 result.json。
 */
async function uploadDiagnosed(cdp, root, filePath, name, mime, ms = 120000) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const t0 = Date.now();
    await uploadViaPage(cdp, filePath, name, mime);
    try {
      await waitChip(cdp, name, 'ready', ms);
      uploadDiag.push({ name, attempt, ok: true, elapsedMs: Date.now() - t0 });
      return attempt;
    } catch (e) {
      const errTitle = await cdp.tryEval(`document.querySelector('#hifi-root .zs-att-error[data-zs-att-error=${JSON.stringify(name)}]')?.title ?? null`);
      let artifactsRows = null;
      try { artifactsRows = dbOf(root).q('SELECT id, revision, kind FROM artifacts WHERE source_name = ?', name).map((r) => ({ id: String(r.id).slice(0, 12), rev: r.revision, kind: r.kind })); } catch { /* 库未就绪 */ }
      uploadDiag.push({ name, attempt, ok: false, elapsedMs: Date.now() - t0, errTitle, artifactsRows, classify: errTitle == null ? 'no-error-chip' : /__TRANSPORT__/.test(errTitle) ? 'transport' : /服务未在时限内回执/.test(errTitle) ? 'unknown-window' : (/([A-Z][A-Z_]+):/.exec(errTitle)?.[1] ?? 'unclear') });
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
/** 真实侧栏房间点击（必要时先展开项目折叠箭头）。 */
async function sidebarRoomClick(cdp, roomName = '默认房间') {
  for (let i = 0; i < 6; i += 1) {
    const hit = await cdp.tryEval(probe(`(() => { const rooms = [...document.querySelectorAll('#hifi-root button.side-item.sub')]; const hit = rooms.find((x) => x.textContent.includes(${JSON.stringify(roomName)})); if (hit != null) { hit.click(); return true; } return null; })()`));
    if (hit === true) return true;
    await cdp.eval(probe(`(() => { const caret = document.querySelector('#hifi-root .side-caret[aria-expanded=false]'); caret?.click(); return true; })()`));
    await sleep(700);
  }
  const dbg = await cdp.tryEval(probe(`(() => ({ subs: [...document.querySelectorAll('#hifi-root button.side-item.sub')].map((x) => x.textContent.trim().slice(0, 20)), carets: [...document.querySelectorAll('#hifi-root .side-caret')].map((x) => x.getAttribute('aria-expanded')), body: document.body.textContent.replace(/\\s+/g, ' ').slice(0, 160) }))()`));
  throw new Error(`侧栏房间点击未命中：${roomName}；dbg=${JSON.stringify(dbg)}`);
}
const paneInvisible = (cdp) => cdp.tryEval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); return p == null || p.getBoundingClientRect().width === 0; })()`));
const paneVisible = (cdp) => cdp.tryEval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })()`));
/** 原生滚轮滚动预览正文（合成 scroll 事件不触发 React onScroll——必须走真实输入）。 */
async function wheelScrollPreview(cdp, dy) {
  const pos = await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root .preview-body'); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(120, Math.max(40, r.height / 2))) }; })()`));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pos.x, y: pos.y, deltaX: 0, deltaY: dy });
  await sleep(450);
}
const activeSideLabel = (cdp) => cdp.tryEval(probe(`(document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim()`));
async function closeAllTabs(cdp) {
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '菜单');
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
  await sleep(700);
}

(async () => {
  const errs = [];
  const realCallRoots = {};
  process.on('SIGINT', () => { cleanupOwn(); process.exit(130); });

  /* ================= G1 混合标签自动收起矩阵（§P2） ================= */
  if (ONLY === '' || ONLY === 'g1') {
    const root1 = path.join(outDir, 'root1');
    const projDir = path.join(outDir, 'proj1');
    const projX = path.join(outDir, 'projX');
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(projX, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'layout-file.md'), ['# 布局文件', '', 'LAYOUT-CONTENT 正文段落，供恢复核对。', ...Array.from({ length: 300 }, (_, i) => `第 ${i + 1} 行：占位正文，保证文件页与房间两种 pane 高度下都可滚动。`)].join('\n'), 'utf8');
    fs.writeFileSync(path.join(projDir, 'layout2.md'), '# 布局文件二\n\nLAYOUT2-CONTENT 正文段落。', 'utf8');
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G1\n', 'utf8');
    fs.writeFileSync(path.join(projX, 'README.md'), '# X\n', 'utf8');
    let { app, cdp } = await launchApp(root1, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    const projXInfo = (await pageOk(cdp, 'project.open', { path: projX })).project;
    // X 的默认房间改名（两项目同名房间会让侧栏点击歧义）
    dbOf(root1).run('UPDATE rooms SET name = ? WHERE project_id = ?', ['X房间', projXInfo.id]);
    cdp = await bootProject(cdp);
    const roomId = dbOf(root1).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id).id;

    /* ① room+files 混合：房间开 room-file.md 留标签 → 文件页开 layout-file.md → 回房间应收起 */
    await openRoomComposer(cdp, root1, proj.id);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'G1-房间草稿保留检查'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(400);
    const roomFile = path.join(outDir, 'room-file.md');
    fs.writeFileSync(roomFile, '# 房间文件\n\nROOM-FILE-CONTENT 房间来源正文。', 'utf8');
    await uploadDiagnosed(cdp, root1, roomFile, 'room-file.md', 'text/markdown', 60000);
    await clickChipPreview(cdp, 'room-file.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('ROOM-FILE-CONTENT')`, 45000, 'G1 房间来源预览');
    await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root .preview-body'); b.scrollTop = 30; b.dispatchEvent(new Event('scroll', { bubbles: true })); return true; })()`));
    await sleep(400);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 文件页');
    await clickTreeFile(cdp, 'layout-file.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT-CONTENT')`, 45000, 'G1 文件页预览');
    await sleep(1000); // 内容二次回填（applyWorktreeRead）稳定后再滚——防抖读回 0
    await wheelScrollPreview(cdp, 240); // 原生滚轮（阅读位置记忆走真实输入）
    f.g1.filesScrollAfterWheel = await cdp.tryEval(`Math.round(document.querySelector('#hifi-root .preview-body')?.scrollTop ?? -1)`);
    // **真实侧栏房间点击**（混合标签在房：可见两标签）
    await sidebarRoomClick(cdp);
    try {
      await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 60000, 'G1 ① 回房间');
    } catch (e) {
      const dump = await cdp.tryEval(probe(`(() => ({ hash: location.hash.slice(0, 60), body: document.body.textContent.replace(/\\s+/g, ' ').slice(0, 200), errs: ${'window.__zsLastErr' in {} ? 'null' : 'null'} }))()`));
      throw new Error(`G1 ① 回房间：${JSON.stringify(dump)}；console=${JSON.stringify((cdp.consoleErrors ?? []).slice(0, 3))}`);
    }
    await sleep(1400);
    f.g1.mixedRoom = await cdp.eval(probe(`(() => ({
      composer: document.querySelector('#hifi-root textarea.composer-input') != null,
      draft: (document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').includes('G1-房间草稿保留检查'),
      pool: document.querySelector('#hifi-root .col-main') != null,
      previewVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(),
      reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null,
    }))()`));
    await cdp.shot('g1-mixed-room');
    // 显式恢复：两标签都在、活动=文件页来源、内容与阅读位置保留、草稿仍在
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-reopen')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT-CONTENT')`, 30000, 'G1 ① 恢复');
    f.g1.mixedRestoreEarly = await cdp.eval(probe(`(() => ({ st: Math.round(document.querySelector('#hifi-root .preview-body')?.scrollTop ?? -1), target: document.querySelector('#hifi-root .preview-body')?.getAttribute('data-zs-scroll-target') ?? null, sh: document.querySelector('#hifi-root .preview-body')?.scrollHeight ?? -1 }))()`));
    await sleep(1200);
    f.g1.mixedRestore = await cdp.eval(probe(`(() => ({
      tabs: [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].map((x) => x.textContent.trim()),
      activeTab: (document.querySelector('#hifi-root .preview-tab.on .preview-tab-label')?.textContent ?? '').trim(),
      content: (document.querySelector('#hifi-root .preview-body')?.textContent ?? '').includes('LAYOUT-CONTENT'),
      scrollTop: Math.round(document.querySelector('#hifi-root .preview-body')?.scrollTop ?? -1),
      draft: (document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').includes('G1-房间草稿保留检查'),
    }))()`));

    /* ② thread+files：线程来源标签 + 文件页来源 → 回线程应收起 */
    const threadFile = path.join(outDir, 'thread-file.md');
    fs.writeFileSync(threadFile, '# 线程文件\n\nTHREAD-FILE-CONTENT 线程来源正文。', 'utf8');
    await uploadDiagnosed(cdp, root1, threadFile, 'thread-file.md', 'text/markdown', 60000);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'G1记录'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await cdp.eval(probe(`(() => { const btn = document.querySelector('#hifi-root button[title*="本次运行设置"]'); btn?.click(); return btn != null; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root .menu .menu-item')].some((x) => x.textContent.includes('仅记录，不请求回复'))`, 8000, 'G1 ⋯ 菜单');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('仅记录，不请求回复'))?.click(), true`));
    await sleep(300);
    await waitSendEnabled(cdp);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await until(() => { try { return dbOf(root1).get('SELECT count(*) c FROM messages WHERE body_json LIKE ?', '%G1记录%').c; } catch { return 0; } }, (c) => c >= 1, 30000, 'G1 记录落库');
    await sleep(1200);
    await until(async () => cdp.tryEval(probe(`(() => { if ([...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('附件') || x.textContent.includes('成果'))) return 'open'; const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('G1记录')); card?.click(); return card != null ? 'clicked' : null; })()`)).catch(() => null), (v) => v === 'open', 60000, 'G1 线程打开');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .thread-tab')].find((x) => x.textContent.includes('附件') || x.textContent.includes('成果')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button.msg-attach')].some((b) => b.textContent.includes('thread-file.md'))`, 45000, 'G1 线程附件按钮');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button.msg-attach')].find((x) => x.textContent.includes('thread-file.md')); b?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('THREAD-FILE-CONTENT')`, 45000, 'G1 线程来源预览');
    await sleep(600);
    f.g1.threadOpenVisible = await paneVisible(cdp);
    // 文件页开另一文件 → 回线程（卡片路径）
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 ② 文件页');
    await clickTreeFile(cdp, 'layout2.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT2-CONTENT')`, 45000, 'G1 ② 文件页预览');
    await sleep(400);
    await sidebarRoomClick(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root .col-main') != null`, 30000, 'G1 ② 回房间');
    await until(async () => cdp.tryEval(probe(`(() => { const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('G1记录')); if (card == null) return null; card.click(); return true; })()`)).catch(() => null), (v) => v === true, 30000, 'G1 ② 重开线程卡');
    await waitFor(cdp, `document.querySelector('#hifi-root .col-thread') != null`, 30000, 'G1 ② 线程面板');
    await sleep(1400);
    f.g1.threadMixed = await cdp.eval(probe(`(() => ({
      thread: document.querySelector('#hifi-root .col-thread') != null,
      previewVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(),
      reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null,
    }))()`));
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-reopen')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body') != null`, 30000, 'G1 ② 恢复');
    await sleep(600);
    f.g1.threadRestoreTabs = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].map((x) => x.textContent.trim())`);

    /* ③ 显式恢复 → 再去文件页开新文件 → 回房间再收起（显式不是永久豁免） */
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 ③ 文件页');
    await clickTreeFile(cdp, 'layout-file.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT-CONTENT')`, 45000, 'G1 ③ 文件页预览');
    await sleep(400);
    await sidebarRoomClick(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G1 ③ 回房间');
    await sleep(1400);
    f.g1.explicitReopenThenFiles = await paneInvisible(cdp);
    // ③b 恢复后仅访问文件页**不开新文件** → 回房间不收起（显式保护，不过度收起）
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-reopen')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT-CONTENT')`, 30000, 'G1 ③b 恢复2');
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 ③b 文件页');
    await sleep(900);
    await sidebarRoomClick(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G1 ③b 回房间');
    await sleep(1400);
    f.g1.explicitProtected = await paneVisible(cdp);

    /* ④ 跨项目：文件页活动预览 → 侧栏点 X 项目房间 → 收起 + X 房间正常 + 可恢复 */
    // 先再武装文件页活动（③b 的显式恢复保护了 preview——文件页重开才重新武装自动收起）
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 ④ 文件页');
    await clickTreeFile(cdp, 'layout-file.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT-CONTENT')`, 45000, 'G1 ④ 文件页预览');
    await sleep(500);
    // 再让 X 的房间进侧栏（raw project.open 不写 UI 注册表/不装房间——/project/:id 路由装载）
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${projXInfo.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('X房间')`, 45000, 'G1 ④ X 项目装载');
    await sleep(800);
    await sidebarRoomClick(cdp, 'X房间');
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 45000, 'G1 ④ X 房间');
    await sleep(1400);
    f.g1.crossProject = await cdp.eval(probe(`(() => ({
      composer: document.querySelector('#hifi-root textarea.composer-input') != null,
      previewVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(),
      reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null,
    }))()`));
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-reopen')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT-CONTENT')`, 30000, 'G1 ④ 跨项目恢复');
    f.g1.crossRestore = true;

    /* ⑤ 在途读取不回弹（混合标签 + 大文件装载中切房间） */
    // 跨项目回主项目：侧栏房间只列最后聚焦项目——先走项目页（真实用户路径）装载房间列表
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G1 ⑤ 主项目装载');
    await sleep(600);
    await sidebarRoomClick(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G1 ⑤ 回房间');
    await sleep(800);
    fs.copyFileSync(FIX.pptxBig, path.join(projDir, PPT_NAME));
    // 文件树挂载时扫描——离开再回来强制重扫（r73 同模式）
    await cdp.eval(`location.hash = '/settings'; true`);
    await sleep(500);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 ⑤ 文件页');
    await clickTreeFile(cdp, PPT_NAME);
    await sleep(250); // 装载在途
    await sidebarRoomClick(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G1 ⑤ 在途后进房间');
    await sleep(9000); // 覆盖 22.5MB readFull 装载窗
    f.g1.inFlightNoPop = await paneInvisible(cdp);

    /* ⑥ DM：文件页活动预览 → 侧栏「私信」→ 收起 + DM 恢复入口 */
    const member = dbOf(root1).get('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? LIMIT 1', proj.id, 'agent');
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: member.id });
    await sidebarRoomClick(cdp);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G1 ⑥ 回房间');
    await sleep(600);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 ⑥ 文件页');
    await clickTreeFile(cdp, 'layout2.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT2-CONTENT')`, 45000, 'G1 ⑥ 文件页预览');
    await sleep(400);
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .side-item')].find((x) => x.textContent.includes('私信')); b?.click(); return b != null; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-dm-list]') != null`, 45000, 'G1 ⑥ DM 列表');
    await sleep(1600);
    f.g1.dm = await cdp.eval(probe(`(() => ({
      dmList: document.querySelector('#hifi-root [data-zs-dm-list]') != null,
      dmComposer: document.querySelector('#hifi-root textarea.composer-input') != null,
      previewVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(),
      reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null,
    }))()`));
    await cdp.shot('g1-dm-collapsed');
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-reopen')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAYOUT2-CONTENT')`, 30000, 'G1 ⑥ DM 恢复');
    f.g1.dmRestore = true;
    f.g1.consoleErrors = (cdp.consoleErrors ?? []).filter((e) => !e.includes('React DevTools')).slice(0, 3);

    if (!(f.g1.mixedRoom.composer && f.g1.mixedRoom.pool && !f.g1.mixedRoom.previewVisible && f.g1.mixedRoom.reopenBtn)) errs.push(`G1①：混合标签收起（${JSON.stringify(f.g1.mixedRoom)}）`);
    if (f.g1.mixedRoom.draft !== true) errs.push('G1①：房间草稿丢失');
    if ((f.g1.mixedRestore.tabs ?? []).length !== 2 || !(f.g1.mixedRestore.tabs ?? []).some((t) => t.includes('room-file.md')) || !(f.g1.mixedRestore.tabs ?? []).some((t) => t.includes('layout-file'))) errs.push(`G1①：恢复标签（${JSON.stringify(f.g1.mixedRestore.tabs)}）`);
    if (!String(f.g1.mixedRestore.activeTab).includes('layout-file')) errs.push(`G1①：恢复活动标签（${f.g1.mixedRestore.activeTab}）`);
    if (f.g1.mixedRestore.content !== true) errs.push('G1①：恢复内容');
    if (!(f.g1.mixedRestore.scrollTop >= 100)) errs.push(`G1①：阅读位置（${f.g1.mixedRestore.scrollTop}）`);
    if (f.g1.mixedRestore.draft !== true) errs.push('G1①：恢复后草稿');
    if (f.g1.threadOpenVisible !== true) errs.push('G1②：线程来源预览未打开');
    if (!(f.g1.threadMixed.thread && !f.g1.threadMixed.previewVisible && f.g1.threadMixed.reopenBtn)) errs.push(`G1②：线程混合收起（${JSON.stringify(f.g1.threadMixed)}）`);
    if ((f.g1.threadRestoreTabs ?? []).length !== 4 || !(f.g1.threadRestoreTabs ?? []).some((t) => t.includes('thread-file.md'))) errs.push(`G1②：线程恢复标签（${JSON.stringify(f.g1.threadRestoreTabs)}）`);
    if (f.g1.explicitReopenThenFiles !== true) errs.push('G1③：显式恢复后再开文件未再收起');
    if (f.g1.explicitProtected !== true) errs.push('G1③b：显式恢复被过度收起');
    if (!(f.g1.crossProject.composer && !f.g1.crossProject.previewVisible && f.g1.crossProject.reopenBtn)) errs.push(`G1④：跨项目收起（${JSON.stringify(f.g1.crossProject)}）`);
    if (f.g1.crossRestore !== true) errs.push('G1④：跨项目恢复');
    if (f.g1.inFlightNoPop !== true) errs.push('G1⑤：在途读取回弹');
    if (!(f.g1.dm.dmList && f.g1.dm.dmComposer && !f.g1.dm.previewVisible && f.g1.dm.reopenBtn)) errs.push(`G1⑥：DM 收起（${JSON.stringify(f.g1.dm)}）`);
    if (f.g1.dmRestore !== true) errs.push('G1⑥：DM 恢复');
    if ((f.g1.consoleErrors ?? []).length > 0) errs.push(`G1：console（${JSON.stringify(f.g1.consoleErrors)}）`);
    realCallRoots.root1 = realCallsOf(root1);
    await closeApp(app, cdp);
  }

  /* ================= G2 项目打开内部取消（§P1） ================= */
  if (ONLY === '' || ONLY === 'g2') {
    const root2 = path.join(outDir, 'root2');
    const projA = path.join(outDir, 'projA2');
    const projB = path.join(outDir, 'projB2');
    const projC = path.join(outDir, 'projC2');
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    fs.mkdirSync(projC, { recursive: true });
    fs.writeFileSync(path.join(projA, 'a说明.md'), '# A\n', 'utf8');
    fs.writeFileSync(path.join(projB, 'B说明.md'), '# B\n', 'utf8');
    fs.writeFileSync(path.join(projC, 'C说明.md'), '# C\n', 'utf8');
    let { app, cdp } = await launchApp(root2, {});
    const a = (await pageOk(cdp, 'project.open', { path: projA })).project;
    const b = (await pageOk(cdp, 'project.open', { path: projB })).project;
    const c = (await pageOk(cdp, 'project.open', { path: projC })).project;
    // A 多房间（拉开装载刷新窗口——roster N+1 実 IPC）
    {
      const dbr = dbOf(root2);
      const roomA = dbr.get('SELECT id, coordinator_member_id FROM rooms WHERE project_id = ? LIMIT 1', a.id);
      for (let i = 1; i <= 12; i += 1) {
        const rid = `room_r74a_${i}`; const cid = `conv_r74a_${i}`;
        dbr.run('INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, ?, ?)', [rid, a.id, `A房间${i}`, roomA.coordinator_member_id]);
        dbr.run("INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)", [cid, a.id, rid]);
        if (roomA.coordinator_member_id != null) dbr.run('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)', [rid, roomA.coordinator_member_id]);
      }
    }
    const roomAMain = dbOf(root2).get('SELECT id FROM rooms WHERE project_id = ? AND name = ?', a.id, '默认房间').id;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G2 B 聚焦');
    await sleep(1200);
    f.g2.baselineActive = await activeSideLabel(cdp);

    /* ① project.open 在途取消（main.ts 工程观测钩子 ZS_UI_DELAY_METHOD_MS=project.open:3200
          ——**真实转发层**受控延迟首个 project.open，与复核 3.2s 同型；重启后首个 project.open
          即定位链的 A 打开）：回执到达时意图已取消 → 零提交（URL/当前项目/偏好/旧错误）。 */
    await closeApp(app, cdp);
    ({ app, cdp } = await launchApp(root2, { ZS_UI_DELAY_METHOD_MS: 'project.open:3200' }));
    await waitFor(cdp, `document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`, 60000, 'G2 ① 重启就绪（偏好恢复 B）');
    await sleep(1500);
    f.g2.restartActive = await activeSideLabel(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${a.id}/room/${roomAMain}`)}; true`);
    await sleep(900); // project.open 在途（3.2s 延迟中）
    await cdp.eval(`location.hash = '/settings'; true`);
    await waitFor(cdp, `location.hash.startsWith('#/settings')`, 15000, 'G2 ① 设置页');
    await sleep(4600); // 覆盖 project.open 回执 + 装载刷新窗
    f.g2.openCancel = await cdp.eval(probe(`(() => ({ hash: location.hash.slice(0, 30), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim(), toasts: [...document.querySelectorAll('.toast-host .toast')].map((t) => t.textContent.trim().slice(0, 40)) }))()`));
    const prefs1 = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
    f.g2.openCancelPrefs = prefs1.data?.prefs?.activeProjectId ?? null;
    f.g2.openCancelOk = f.g2.openCancel.hash.startsWith('#/settings') && f.g2.openCancel.active.includes('projB') && f.g2.openCancel.toasts.length === 0;

    /* ② 装载刷新期取消（重启换 member.list:2500 延迟——首个 member.list=装载刷新波，
          确定性 2.5s 窗口）：焦点已提交后取消 → 不写偏好 + 焦点还原 B */
    await closeApp(app, cdp);
    ({ app, cdp } = await launchApp(root2, { ZS_UI_DELAY_METHOD_MS: 'member.list:2500' }));
    await waitFor(cdp, `document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`, 60000, 'G2 ② 重启就绪（偏好恢复 B）');
    await sleep(1500);
    {
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${a.id}/room/${roomAMain}`)}; true`);
      let flipped = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const lab = await activeSideLabel(cdp);
        if (String(lab).includes('projA')) {
          await cdp.eval(`location.hash = '/settings'; true`);
          flipped = true;
          break;
        }
        await sleep(12);
      }
      if (!flipped) {
        errs.push('G2②：未捕获装载期翻转（member.list 延迟窗内焦点未提交——时序未成立）');
      } else {
        await sleep(4500); // member.list 2.5s 延迟释放 + 取消路径收尾
        const st = await cdp.eval(probe(`(() => ({ hash: location.hash.slice(0, 30), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim(), toasts: [...document.querySelectorAll('.toast-host .toast')].map((t) => t.textContent.trim().slice(0, 40)) }))()`));
        const prefs = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
        const rec = { flipped: true, caughtMs: Date.now() - t0, ...st, prefsActive: prefs.data?.prefs?.activeProjectId ?? null };
        f.g2.refreshCancel = rec;
        if (!(st.hash.startsWith('#/settings') && st.active.includes('projB') && st.toasts.length === 0 && rec.prefsActive !== a.id)) {
          errs.push(`G2②：装载期取消（${JSON.stringify(rec)}）`);
        }
      }
    }

    /* ③ 反序两条链接：A 房间直链在途 → 用户点 C 房间直链 → 只落实 C */
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G2 ③ 回 B');
    await sleep(900);
    const roomC = dbOf(root2).get('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', c.id).id;
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${a.id}/room/${roomAMain}`)}; true`);
    await sleep(140);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${c.id}/room/${roomC}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 60000, 'G2 ③ C 房间落位');
    await sleep(2500);
    f.g2.reverseOrder = await cdp.eval(probe(`(() => ({ hash: location.hash.slice(0, 40), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim() }))()`));
    const prefs3 = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
    f.g2.reversePrefs = prefs3.data?.prefs?.activeProjectId ?? null;

    /* ④ 未取消正例：同一 A 房间直链正常完成（对齐+房间+输入区） */
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${b.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G2 ④ 回 B');
    await sleep(900);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${a.id}/room/${roomAMain}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 60000, 'G2 ④ A 房间直链');
    f.g2.positiveActive = await activeSideLabel(cdp);

    if (f.g2.openCancelOk !== true) errs.push(`G2①：project.open 在途取消（${JSON.stringify(f.g2.openCancel)} prefs=${f.g2.openCancelPrefs}）`);
    if (f.g2.openCancelPrefs === a.id) errs.push('G2①：旧请求写了导航偏好');
    if (!(String(f.g2.reverseOrder.active).includes('projC') && f.g2.reversePrefs === c.id)) errs.push(`G2③：反序最新意图（${JSON.stringify(f.g2.reverseOrder)} prefs=${f.g2.reversePrefs}）`);
    if (!String(f.g2.positiveActive).includes('projA')) errs.push(`G2④：未取消正例（active=${f.g2.positiveActive}）`);
    realCallRoots.root2 = realCallsOf(root2);
    await cdp.shot('g2-end');
    await closeApp(app, cdp);
  }

  /* ================= G3 上传重传口径（§三——先诊断后重传，事实全记录） ================= */
  if (ONLY === '' || ONLY === 'g3') {
    const root3 = path.join(outDir, 'root3');
    const projDir = path.join(outDir, 'proj3');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G3\n', 'utf8');
    let { app, cdp } = await launchApp(root3, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root3, proj.id);
    await uploadDiagnosed(cdp, root3, FIX.xlsx, XLSX_NAME, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 120000);
    await clickChipPreview(cdp, XLSX_NAME);
    await waitFor(cdp, `(() => { const h = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); return h != null && h.querySelector('canvas') != null; })()`, 180000, 'G3 XLSX 引擎');
    await sleep(1500);
    f.g3.xlsxAria = Number(await cdp.tryEval(`document.querySelector('#hifi-root [role=grid]')?.getAttribute('aria-rowcount')`));
    f.g3.uploadDiag = uploadDiag.filter((x) => x.name === XLSX_NAME);
    f.g3.firstAttemptOk = f.g3.uploadDiag[0]?.ok === true;
    if (f.g3.xlsxAria == null || f.g3.xlsxAria < 69000) errs.push(`G3：XLSX（aria=${f.g3.xlsxAria}）`);
    realCallRoots.root3 = realCallsOf(root3);
    await closeApp(app, cdp);
  }

  /* ================= G4 PPT 逐页真实 render-ready walk（R73 保持） ================= */
  if (ONLY === '' || ONLY === 'g4') {
    const root4 = path.join(outDir, 'root4');
    const projDir = path.join(outDir, 'proj4');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G4\n', 'utf8');
    fs.copyFileSync(FIX.pptxBig, path.join(projDir, PPT_NAME));
    let { app, cdp } = await launchApp(root4, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G4 文件页');
    const t0 = Date.now();
    await clickTreeFile(cdp, PPT_NAME);
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) > 0; })()`, 180000, 'G4 树开 PPT');
    f.g4.pages_attr = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages')`));
    f.g4.firstViewMs = Date.now() - t0;
    const walkT0 = Date.now();
    const failures = [];
    for (let n = 1; n <= f.g4.pages_attr; n += 1) {
      await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[${n - 1}]?.click(), true`));
      let landed = true;
      try {
        await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '${n}'`, 20000, `G4 页 ${n} 落位`);
      } catch { landed = false; }
      let renderState = landed ? await cdp.tryEval(`document.querySelector('#hifi-root .pptx-main .pptx-slide-mount')?.getAttribute('data-zs-render')`) : 'not-landed';
      if (landed && renderState !== 'ready' && renderState !== 'error') {
        renderState = await until(() => cdp.tryEval(`document.querySelector('#hifi-root .pptx-main .pptx-slide-mount')?.getAttribute('data-zs-render')`).catch(() => null), (v) => v === 'ready' || v === 'error', 25000, `G4 页 ${n} render`).catch((e) => `timeout:${String(e.message).slice(0, 60)}`);
      }
      const imgs0 = await cdp.tryEval(probe(`(() => { const root = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); if (root == null) return null; const is = [...root.querySelectorAll('img')]; return { n: is.length, d: is.filter((i) => i.complete && i.naturalWidth > 0).length }; })()`));
      const imgs = (imgs0 != null && imgs0.n > 0 && imgs0.d < imgs0.n)
        ? await until(() => cdp.tryEval(probe(`(() => { const root = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); if (root == null) return null; const is = [...root.querySelectorAll('img')]; return { n: is.length, d: is.filter((i) => i.complete && i.naturalWidth > 0).length }; })()`)).catch(() => null), (v) => v == null || v.d >= v.n, 8000, `G4 页 ${n} 图片解码`).catch(() => imgs0)
        : imgs0;
      const entry = { p: n, landed, render: renderState, imgs };
      f.g4.pages.push(entry);
      if (!landed || renderState !== 'ready' || (imgs != null && imgs.n > 0 && imgs.d !== imgs.n)) failures.push(entry);
    }
    f.g4.total = f.g4.pages_attr;
    f.g4.walkMs = Date.now() - walkT0;
    f.g4.failCount = failures.length;
    f.g4.failures = failures.slice(0, 10);
    f.g4.readyCount = f.g4.pages.filter((x) => x.render === 'ready').length;
    if (f.g4.failCount > 0 || f.g4.readyCount !== f.g4.total) errs.push(`G4：逐页 render（ready=${f.g4.readyCount}/${f.g4.total} fail=${f.g4.failCount} ${JSON.stringify(f.g4.failures.slice(0, 3))}）`);
    realCallRoots.root4 = realCallsOf(root4);
    await cdp.shot('g4-walk-end');
    await closeApp(app, cdp);
  }

  /* ================= G5 R72 必要回归（容量/Git/滚动/另存/阅读位置） ================= */
  if (ONLY === '' || ONLY === 'g5') {
    const root5 = path.join(outDir, 'root5');
    const projDir = path.join(outDir, 'proj5');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G5\n', 'utf8');
    fs.copyFileSync(FIX.pptxBig, path.join(projDir, PPT_NAME));
    fs.copyFileSync(FIX.xlsx, path.join(projDir, XLSX_NAME));
    let { app, cdp } = await launchApp(root5, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G5 文件页');
    await clickTreeFile(cdp, PPT_NAME);
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) >= 80; })()`, 180000, 'G5 树开大 PPT');
    f.g5.treePages = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages')`));
    await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[39]?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '40'`, 90000, 'G5 跳页 40');
    await clickTreeFile(cdp, XLSX_NAME);
    await waitFor(cdp, `(() => { const h = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); return h != null && h.querySelector('canvas') != null; })()`, 180000, 'G5 XLSX 引擎');
    await sleep(1500);
    f.g5.xlsxAria = Number(await cdp.tryEval(`document.querySelector('#hifi-root [role=grid]')?.getAttribute('aria-rowcount')`));
    await cdp.eval(probe(`(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); let best = null; for (const el of host.querySelectorAll('*')) { if (el.scrollHeight > el.clientHeight + 200 && (best == null || el.scrollHeight > best.scrollHeight)) best = el; } if (best != null) { best.scrollTop = 500000; return true; } return false; })()`));
    await sleep(800);
    f.g5.xlsxBottom = await cdp.eval(probe(`(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); let best = null; for (const el of host.querySelectorAll('*')) { if (el.scrollHeight > el.clientHeight + 200 && (best == null || el.scrollHeight > best.scrollHeight)) best = el; } return Math.round(best.scrollTop); })()`));
    await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('内蒙古')); t?.click(); return true; })()`));
    await sleep(2000);
    f.g5.pageKept = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page')`);
    await openMoreMenu(cdp);
    const saved = await saveOriginal(cdp, '内蒙古');
    f.g5.saveIdentical = saved.sha256 === sha256Buf(fs.readFileSync(FIX.pptxBig));
    const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-r74-plain-'));
    fs.writeFileSync(path.join(plainDir, 'p说明.md'), '# plain\n', 'utf8');
    const proj2 = (await pageOk(cdp, 'project.open', { path: plainDir })).project;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj2.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G5 项目2文件页');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('p说明.md')`)).catch(() => null), (v) => v, 30000, 'G5 树列2');
    await sleep(2600);
    f.g5.neutralBefore = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-git-neutral]') != null`);
    execFileSync('git', ['-C', plainDir, 'init', '-b', 'main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', plainDir, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', plainDir, '-c', 'user.name=r74', '-c', 'user.email=r74@local', 'commit', '-m', 'c1'], { stdio: 'ignore' });
    await cdp.eval(`location.hash = '/settings'; true`);
    await sleep(600);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj2.id}/files`)}; true`);
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('p说明.md')`)).catch(() => null), (v) => v, 30000, 'G5 树列3');
    await sleep(2800);
    f.g5.gitAfterInit = await cdp.eval(probe(`(() => ({ neutral: document.querySelector('#hifi-root [data-zs-git-neutral]') != null, repo: document.querySelector('#hifi-root .fg-statusbar')?.textContent.includes('Git 仓库') ?? false }))()`));
    if (f.g5.treePages < 80) errs.push(`G5：树开大 PPT（${f.g5.treePages}）`);
    if (String(f.g5.pageKept) !== '40') errs.push(`G5：页码保持（${f.g5.pageKept}）`);
    if (f.g5.saveIdentical !== true) errs.push('G5：另存不一致');
    if (f.g5.xlsxAria == null || f.g5.xlsxAria < 69000 || f.g5.xlsxBottom == null || f.g5.xlsxBottom <= 0) errs.push(`G5：XLSX（aria=${f.g5.xlsxAria} bottom=${f.g5.xlsxBottom}）`);
    if (f.g5.neutralBefore !== true) errs.push('G5：中性态');
    if (f.g5.gitAfterInit.neutral === true || f.g5.gitAfterInit.repo !== true) errs.push(`G5：中性→Git（${JSON.stringify(f.g5.gitAfterInit)}）`);
    realCallRoots.root5 = realCallsOf(root5);
    await closeApp(app, cdp);
  }

  const result = { runId, ok: errs.length === 0, errs, checks: f, uploadDiag, realCallRoots, shotsDir };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: result.ok,
    errs,
    g1: { mixedRoom: f.g1.mixedRoom, restore: f.g1.mixedRestore, threadMixed: f.g1.threadMixed, threadTabs: f.g1.threadRestoreTabs, explicitReThenFiles: f.g1.explicitReopenThenFiles, explicitProtected: f.g1.explicitProtected, cross: f.g1.crossProject, inFlight: f.g1.inFlightNoPop, dm: f.g1.dm },
    g2: { openCancel: f.g2.openCancel, openCancelPrefs: f.g2.openCancelPrefs, refreshCancel: f.g2.refreshCancel, reverse: f.g2.reverseOrder, reversePrefs: f.g2.reversePrefs, positive: f.g2.positiveActive },
    g3: { aria: f.g3.xlsxAria, uploadDiag: f.g3.uploadDiag },
    g4: { total: f.g4.total, ready: f.g4.readyCount, fail: f.g4.failCount, walkMs: f.g4.walkMs, firstViewMs: f.g4.firstViewMs, failures: f.g4.failures },
    g5: { tree: f.g5.treePages, pageKept: f.g5.pageKept, save: f.g5.saveIdentical, xlsx: [f.g5.xlsxAria, f.g5.xlsxBottom], git: [f.g5.neutralBefore, f.g5.gitAfterInit] },
    realCallRoots,
  }, null, 2));
  cleanupOwn();
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('gate 崩溃：', e); try { fs.writeFileSync(path.join(outDir, 'crash.txt'), String(e?.stack ?? e)); } catch { /* */ } cleanupOwn(); process.exit(1); });
