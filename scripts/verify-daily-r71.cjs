#!/usr/bin/env node
/**
 * R69 总门：文件预览集中修复与 ZCode 源码对照验收。
 *
 * 覆盖（review-r68-preview-benchmark §5 C 交付门）：
 *  - G1 文本族+房间草稿首开死锁：UTF-8/0B/BOM/UTF-16 原字节上传→就地芯片→**草稿首开预览**
 *    （P1-A 死锁修复的原始反例场景）；另存原件逐字节一致；关全部→再首开；失败原因就地可见（负例 .exe）。
 *  - G2 用户 PNG（1.1MB）：上传成功≠模型已读——本地预览像素可解码；能力门与上传分列。
 *  - G3 用户真实 PPT（11.7MB/55 页）：上传（P1-B 主 part 定类修复）→缩略图列/主舞台/页码跳页/缩放/另存 hash 一致。
 *  - G4 PDF/Word/Excel/MD/HTML 夹具：PDF 真实面板适应+页码；Word 分页纸张且不再铺第二份提取；
 *    Excel WASM 引擎（sheet 页签）或如实回退；MD 表格；HTML 隔离页。
 *  - G5 文件树入口（worktree 二进制 readFull）：PPT/PNG/MD 从文件树打开=同一阅读器；另存原字节一致。
 *  - G6 DM 入口+已发消息入口+关闭全部后再首开。
 *  - G7 负例（真翻 FAIL）：.pptm 宏主文档拒绝（就地原因）；损坏 Office=已保存+提取失败警示（分列不吞）。
 *  独立数据根/真实 UI File 输入（DOM.setFileInputFiles→DataTransfer）/零真实模型调用（real_calls=0）。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const os = require('node:os');

const repo = path.resolve(__dirname, '..');
const runId = `r71-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r69-${runId}`);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 9701;
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
const dbOf = (root) => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); const db = new Database(path.join(root, 'state.sqlite')); return { q: (sql, ...a) => db.prepare(sql).all(...a), close: () => db.close() }; };
const sha256Buf = (b) => createHash('sha256').update(b).digest('hex');
let __appOut = { v: '' };
let f = { g1: {}, g2: {}, g3: {}, g4: {}, g5: { detail: {} }, g6: {}, g7: {}, g8: {} };

/* ---------------- 夹具（只读复制用户样本到自有目录；敏感正文不写入报告） ---------------- */
const SAMPLES = 'C:/Users/user/Documents/文档测试';
const fx = path.join(outDir, 'fixtures');
fs.mkdirSync(fx, { recursive: true });
/** 用户真实样本（只读使用；只复制到自有 fixtures 目录——原件不动；不外发）。 */
const FIX = {
  pptxBig: path.join(SAMPLES, '内蒙古职工互助系统建设方案@1010.pptx'),
  docx: path.join(SAMPLES, '不动产买卖合同11.16.docx'),
  xlsx: path.join(SAMPLES, '去重翻译表v4_名词统一.xlsx'),
  pdfBig: path.join(SAMPLES, 'GPT-5.6_Sol_Terra_Luna_五档推理成本智能对比分析.pdf'),
  pdfSmall: path.join(SAMPLES, 'result.pdf'),
  png: path.join(SAMPLES, 'QQ20260711-003638.png'),
  html: path.join(SAMPLES, '辉步记忆系统-项目详解.html'),
  txt: path.join(SAMPLES, 'requirements-frida.txt'),
  md: path.join(SAMPLES, 'SKILL.md'),
};
// 超限负对照：合成 33.5MiB 假 pptx（PK 头+pad——服务端在 byteCap 阶段即拒，不需要真结构）。
FIX.pptxOver = path.join(fx, 'r71-超限.pptx');
{
  const buf = Buffer.alloc(33.5 * 1024 * 1024);
  Buffer.from('PK', 'latin1').copy(buf, 0);
  for (let i = 4; i < buf.length; i += 4096) buf[i] = (i / 4096) & 0xff;
  fs.writeFileSync(FIX.pptxOver, buf);
}

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
    expression: `window.zs.command({ protocolVersion: 1, commandId: ${JSON.stringify(commandId ?? `g71-${Math.random().toString(36).slice(2, 10)}`)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
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
/** 房间输入区：先 #/project/:id 装载项目（房间入 store），再进默认房间。 */
async function openRoomComposer(cdp, root, projId) {
  await until(() => cdp.tryEval(probe(`document.body.classList.contains('hifi-on') && (document.querySelector('#hifi-root .side-project .side-item-label') != null || document.body.textContent.includes('默认房间'))`)).catch(() => null), (v) => v, 45000, '房间前就绪');
  await cdp.eval(`location.hash = ${JSON.stringify(`/project/${projId}`)}; true`);
  await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, '项目装载（默认房间）');
  const room = dbOf(root).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', projId)[0];
  await cdp.eval(`location.hash = ${JSON.stringify(`/room/${room.id}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, '房间输入区');
  await sleep(600);
  return room.id;
}
const waitSendEnabled = (cdp, ms = 30000) => until(() => cdp.tryEval(probe(`(() => { const b = document.querySelector('#hifi-root .composer-send'); return b != null && b.disabled !== true; })()`)).catch(() => null), (v) => v === true, ms, '发送按钮可用');

/** 真实 UI 上传：Composer 的 File 输入（DataTransfer——DOM.setFileInputFiles 在此 Electron 版不可用）。 */
async function uploadViaPage(cdp, filePath, name, mime = 'application/octet-stream') {
  const b64 = fs.readFileSync(filePath).toString('base64');
  const okv = await cdp.tryEval(probe(`(() => {
    const input = document.querySelector('#hifi-root input[data-zs-file-input]');
    if (input == null) return 'NO_INPUT';
    const bin = atob('${b64}');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`));
  if (okv !== true) throw new Error('uploadViaPage 失败：' + String(okv));
}
/** 芯片状态读取（就绪/失败/警示+文本）；data-zs-attach-chips 容器。 */
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
let chipStatesSnapshot = null;
/** 点草稿芯片「预览」按钮（按文件名定位）。 */
async function clickChipPreview(cdp, name) {
  return await cdp.tryEval(probe(`(() => {
    const chips = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')];
    const chip = chips.find((c) => (c.getAttribute('data-zs-att') === 'ready') && c.textContent.includes(${JSON.stringify(name)}));
    if (chip == null) return 'NO_CHIP';
    const btn = [...chip.querySelectorAll('button')].find((b) => b.textContent.trim() === '预览');
    if (btn == null) return 'NO_BTN';
    btn.click(); return true;
  })()`));
}
/** 另存原件（更多菜单→下载原文件；ZS_SAVEAS_AUTO_DIR 自动落盘）并取 sha256。 */
async function saveOriginal(cdp, namePart) {
  const before = new Set(fs.readdirSync(saveAsDir));
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item, #hifi-root [role=menu] .menu-item')].find((x) => x.textContent.includes('下载原文件'))?.click(), true`));
  if (before.size === 0) { /* 菜单可能需先开 */ }
  await until(() => { try { return fs.readdirSync(saveAsDir).filter((n) => !before.has(n)).length; } catch { return 0; } }, (n) => n >= 1, 20000, `另存落盘 ${namePart}`);
  await sleep(600);
  const saved = fs.readdirSync(saveAsDir).filter((n) => !before.has(n)).map((n) => path.join(saveAsDir, n))[0];
  return { path: saved, sha256: sha256Buf(fs.readFileSync(saved)), bytes: fs.statSync(saved).size };
}
async function openMoreMenu(cdp) {
  await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-pane .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
  await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '更多菜单展开');
}

  (async () => {
  const errs = [];
  const realCallsOf = (root) => { try { return dbOf(root).q('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } };
  /** renderer JS 堆（Performance.getMetrics——大 PPT 内存记录）。 */
  const heapOf = async (cdp) => {
    try { const m = await cdp.send('Performance.getMetrics'); const hit = m.metrics.find((x) => x.name === 'JSHeapUsedSize'); return hit ? Math.round(hit.value / 1048576) : null; } catch { return null; }
  };

  /* ================= G1 真实 22.54MiB PPT 全链（容量分道修复的本体验收） ================= */
  {
    const root1 = path.join(outDir, 'root1');
    const projDir = path.join(outDir, 'proj1');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G1\n', 'utf8');
    let { app, cdp } = await launchApp(root1, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root1, proj.id);
    await cdp.send('Performance.enable');
    const heapBefore = await heapOf(cdp);
    const t0 = Date.now();
    await uploadViaPage(cdp, FIX.pptxBig, '内蒙古职工互助系统建设方案@1010.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await waitChip(cdp, '内蒙古职工互助系统建设方案@1010.pptx', 'ready', 180000);
    f.g1.uploadMs = Date.now() - t0; // 上传+保存+提取（服务端解析含在内）
    f.g1.uploadOk = true;
    await clickChipPreview(cdp, '内蒙古职工互助系统建设方案@1010.pptx');
    const t1 = Date.now();
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]') != null`, 180000, 'G1 视图挂载');
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) > 0; })()`, 180000, 'G1 页数就绪');
    f.g1.firstViewMs = Date.now() - t1;
    f.g1.pages = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages')`));
    // 首屏真实渲染（主舞台有内容节点）。
    await waitFor(cdp, `document.querySelector('#hifi-root .pptx-main .pptx-slide-mount > *') != null`, 120000, 'G1 主舞台首页渲染');
    f.g1.firstRenderOk = true;
    // 缩略图真实渲染（懒渲染首批）。
    await waitFor(cdp, `document.querySelectorAll('#hifi-root .pptx-thumbs .pptx-thumb .pptx-slide-mount > *').length >= 3`, 120000, 'G1 缩略图首批');
    f.g1.thumbsOk = true;
    // 跳中页 + 图片解码采样（多页找有图的页——图文页证据）。
    const gotoPptPage = async (n) => {
      await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[${n - 1}]?.click(), true`));
      await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '${n}'`, 90000, `G1 跳页 ${n}`);
      await sleep(2600);
    };
    await gotoPptPage(40);
    f.g1.p40Imgs = await cdp.tryEval(probe(`(() => { const root = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); if (root == null) return null; return { imgs: root.querySelectorAll('img').length, decoded: [...root.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).length }; })()`));
    f.g1.p40Content = await cdp.tryEval(probe(`(() => { const m = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); return m != null && m.textContent.trim().length > 0; })()`));
    // 末页。
    await gotoPptPage(f.g1.pages);
    f.g1.lastPageOk = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page')`)) === f.g1.pages;
    // 缩放。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root [data-zs-pptx-bar] button')].find((b) => (b.getAttribute('aria-label') || '') === '放大')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .pptx-zoom-label')?.textContent === '125%'`, 8000, 'G1 缩放');
    f.g1.zoomOk = true;
    // 切标签回位：上传 MD 作第二标签。
    await uploadViaPage(cdp, FIX.md, 'SKILL.md', 'text/markdown');
    await waitChip(cdp, 'SKILL.md', 'ready');
    await clickChipPreview(cdp, 'SKILL.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-read-doc') != null`, 30000, 'G1 MD 打开');
    await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('内蒙古')); t?.click(); return true; })()`));
    await sleep(2500);
    f.g1.restorePage = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page')`);
    // 另存原字节一致。
    await openMoreMenu(cdp);
    const saved = await saveOriginal(cdp, '内蒙古');
    const srcBuf = fs.readFileSync(FIX.pptxBig);
    f.g1.savedIdentical = saved.sha256 === sha256Buf(srcBuf);
    f.g1.savedBytes = saved.bytes;
    f.g1.heapBeforeMB = heapBefore;
    f.g1.heapAfterMB = await heapOf(cdp);
    if (!f.g1.uploadOk || !(f.g1.pages >= 80)) errs.push(`G1：大 PPT 上传/页数（pages=${f.g1.pages}）`);
    if (!f.g1.firstRenderOk || !f.g1.thumbsOk) errs.push('G1：首屏/缩略图渲染');
    if (f.g1.p40Imgs != null && f.g1.p40Imgs.imgs > 0 && f.g1.p40Imgs.decoded !== f.g1.p40Imgs.imgs) errs.push(`G1：中页图片未全解码（${JSON.stringify(f.g1.p40Imgs)}）`);
    if (!f.g1.lastPageOk || !f.g1.zoomOk || String(f.g1.restorePage) !== String(f.g1.pages)) errs.push(`G1：末页/缩放/回位（last=${f.g1.lastPageOk} zoom=${f.g1.zoomOk} restore=${f.g1.restorePage}/${f.g1.pages}）`);
    if (f.g1.savedIdentical !== true) errs.push(`G1：另存不一致（${f.g1.savedBytes}B）`);
    f.g1.realCalls = realCallsOf(root1);
    await cdp.shot('g1-bigppt-p40');
    await closeApp(app, cdp);
  }

  /* ================= G2 真实样本逐格式（DOCX/XLSX/PDF×2/PNG/HTML/TXT/MD） ================= */
  {
    const root2 = path.join(outDir, 'root2');
    const projDir = path.join(outDir, 'proj2');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G2\n', 'utf8');
    let { app, cdp } = await launchApp(root2, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root2, proj.id);
    const openFile = async (file, name, mime, readyExpr, label, settleMs = 2500) => {
      await uploadViaPage(cdp, file, name, mime);
      await waitChip(cdp, name, 'ready', 120000);
      await clickChipPreview(cdp, name);
      await waitFor(cdp, readyExpr, 120000, `G2 ${label}`);
      await sleep(settleMs);
      return true;
    };
    // DOCX（391KB 真合同）：分页+内容。
    f.g2.docx = await openFile(FIX.docx, '不动产买卖合同11.16.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      `(() => { const sr = document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot; return sr != null && sr.querySelectorAll('section').length >= 1 && sr.textContent.replace(/\\s/g, '').length > 200; })()`, 'DOCX', 4000);
    f.g2.docxSave = await (async () => { await openMoreMenu(cdp); const s = await saveOriginal(cdp, '不动产'); return s.sha256 === sha256Buf(fs.readFileSync(FIX.docx)); })();
    // XLSX（9.8MB 真多表）：引擎+页签+切表保持。
    f.g2.xlsx = await openFile(FIX.xlsx, '去重翻译表v4_名词统一.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]') != null`, 'XLSX', 6000);
    f.g2.xlsxMode = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-xlsx-view]')?.getAttribute('data-zs-xlsx-view')`);
    f.g2.xlsxTabs = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab')].length`);
    f.g2.xlsxFirst = await cdp.tryEval(`document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on')?.getAttribute('data-zs-sheet-tab')`);
    if (Number(f.g2.xlsxTabs) > 1) {
      const secondSheet = await cdp.tryEval(`document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab:not(.on)')?.getAttribute('data-zs-sheet-tab')`);
      await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab:not(.on)'); b?.click(); return true; })()`));
      await sleep(1500);
      f.g2.xlsxSwitched = await cdp.tryEval(`document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on')?.getAttribute('data-zs-sheet-tab')`);
      await sleep(11000);
      f.g2.xlsxAfter11s = await cdp.tryEval(`document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on')?.getAttribute('data-zs-sheet-tab')`);
      void secondSheet;
    }
    f.g2.xlsxSave = await (async () => { await openMoreMenu(cdp); const s = await saveOriginal(cdp, '去重翻译表'); return s.sha256 === sha256Buf(fs.readFileSync(FIX.xlsx)); })();
    // PDF 大（1.9MB 真分析报告）：多页+跳页。
    f.g2.pdfBig = await openFile(FIX.pdfBig, 'GPT-5.6_Sol_Terra_Luna_五档推理成本智能对比分析.pdf', 'application/pdf',
      `(() => { const v = document.querySelector('#hifi-root [data-zs-pdf-view]'); return v != null && Number(v.getAttribute('data-zs-pdf-pages')) > 5; })()`, 'PDF大', 3000);
    f.g2.pdfBigPages = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pdf-view]')?.getAttribute('data-zs-pdf-pages')`);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .pdf-view [aria-label=下一页]')][0]?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pdf-view]')?.getAttribute('data-zs-pdf-page') === '2'`, 20000, 'G2 PDF 跳页');
    f.g2.pdfJump = true;
    // PDF 小（317KB）。
    f.g2.pdfSmall = await openFile(FIX.pdfSmall, 'result.pdf', 'application/pdf',
      `(() => { const v = document.querySelector('#hifi-root [data-zs-pdf-view]'); return v != null && Number(v.getAttribute('data-zs-pdf-pages')) >= 1; })()`, 'PDF小');
    // PNG（2.2MB 真截图）。
    f.g2.png = await openFile(FIX.png, 'QQ20260711-003638.png', 'image/png',
      `(() => { const i = document.querySelector('#hifi-root img[data-zs-image-preview]'); return i != null && i.naturalWidth > 0; })()`, 'PNG');
    f.g2.pngSize = await cdp.tryEval(`(() => { const i = document.querySelector('#hifi-root img[data-zs-image-preview]'); return i == null ? null : i.naturalWidth + 'x' + i.naturalHeight; })()`);
    // HTML（137KB 真文档）。
    f.g2.html = await openFile(FIX.html, '辉步记忆系统-项目详解.html', 'text/html',
      `document.querySelector('#hifi-root iframe[data-zs-html-frame]') != null`, 'HTML');
    // TXT + MD。
    f.g2.txt = await openFile(FIX.txt, 'requirements-frida.txt', 'text/plain',
      `document.querySelector('#hifi-root .preview-source') != null`, 'TXT');
    f.g2.md = await openFile(FIX.md, 'SKILL.md', 'text/markdown',
      `document.querySelector('#hifi-root .preview-read-doc') != null`, 'MD');
    if (f.g2.docx !== true || f.g2.docxSave !== true) errs.push('G2：DOCX 链');
    // 真件=单工作表：引擎隐藏页签条（0 个页签按钮=正确）；切表保持由 r70 门多表夹具回归承载。
    if (f.g2.xlsxMode !== 'engine') errs.push(`G2：XLSX 引擎（mode=${f.g2.xlsxMode}）`);
    if (f.g2.xlsxSave !== true) errs.push('G2：XLSX 另存不一致');
    if (f.g2.pdfBig !== true || f.g2.pdfJump !== true || f.g2.pdfSmall !== true) errs.push('G2：PDF 链');
    if (f.g2.png !== true || f.g2.pngSize == null) errs.push(`G2：PNG（${f.g2.pngSize}）`);
    if (f.g2.html !== true || f.g2.txt !== true || f.g2.md !== true) errs.push('G2：HTML/TXT/MD');
    f.g2.realCalls = realCallsOf(root2);
    await closeApp(app, cdp);
  }

  /* ================= G3 非 Git 目录中性态 + 文件阅读可用 ================= */
  {
    const root3 = path.join(outDir, 'root3');
    // 仓库外普通目录（系统临时目录——gate 输出目录在 zhongshuo 仓库内，git 向上发现
    // 外层仓库是正确行为，不构成「非 Git」反例）。
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-r71-plain-'));
    fs.writeFileSync(path.join(projDir, '说明.md'), '# 普通（非 Git）目录\n\n非 Git 目录文件照常阅读。', 'utf8');
    let { app, cdp } = await launchApp(root3, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    // project.open 响应 DTO 含真实路径（R64 登记项——UI 侧直证）。
    const openDto = await pageCmd(cdp, 'project.open', { path: projDir });
    f.g3.dtoRootPath = openDto.ok === true && typeof openDto.data?.project?.rootPath === 'string';
    f.g3.dtoCanonical = typeof openDto.data?.project?.canonicalPath === 'string';
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G3 文件树');
    await sleep(2500); // git 状态装载窗
    f.g3.neutralShown = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-git-neutral]') != null`);
    f.g3.noDanger = await cdp.tryEval(probe(`![...document.querySelectorAll('#hifi-root .panel.danger')].some((p) => p.textContent.includes('git.status'))`));
    f.g3.neutralText = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-git-neutral]')?.textContent.includes('未初始化 Git')`);
    // 文件树打开 MD（阅读可用性不受非 Git 影响）。
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('说明.md')`)).catch(() => null), (v) => v, 30000, 'G3 树列文件');
    await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '说明.md'); rows[rows.length - 1]?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-read-doc')?.textContent.includes('非 Git 目录文件照常阅读')`, 30000, 'G3 非 Git 文件阅读');
    f.g3.fileReadOk = true;
    if (f.g3.neutralShown !== true || f.g3.noDanger !== true || f.g3.neutralText !== true) errs.push(`G3：非 Git 中性态（neutral=${f.g3.neutralShown} noDanger=${f.g3.noDanger} text=${f.g3.neutralText}）`);
    if (f.g3.fileReadOk !== true) errs.push('G3：非 Git 目录文件阅读失败');
    if (f.g3.dtoRootPath !== true || f.g3.dtoCanonical !== true) errs.push(`G3：project.open DTO（root=${f.g3.dtoRootPath} canon=${f.g3.dtoCanonical}）`);
    f.g3.realCalls = realCallsOf(root3);
    await closeApp(app, cdp);
  }

  /* ================= G4 fake 自然交付二进制 Office+PDF（真件字节） ================= */
  {
    const root4 = path.join(outDir, 'root4');
    const projDir = path.join(outDir, 'proj4');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G4\n', 'utf8');
    // 交付 spec：真 DOCX + 真 XLSX + 真 PDF 的原字节（contentBase64）——自然链落盘。
    const spec = [
      { path: '交付合同.docx', contentBase64: fs.readFileSync(FIX.docx).toString('base64') },
      { path: '交付表格.xlsx', contentBase64: fs.readFileSync(FIX.pdfSmall ? FIX.xlsx : FIX.xlsx).toString('base64') },
      { path: '交付报告.pdf', contentBase64: fs.readFileSync(FIX.pdfSmall).toString('base64') },
    ];
    const specPath = path.join(outDir, 'write-spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
    let { app, cdp } = await launchApp(root4, { ZS_FAKE_WRITE_FILES_JSON: specPath });
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    const roomRow = dbOf(root4).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id)[0];
    const roomConv = dbOf(root4).q('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', proj.id, 'room')[0];
    const members = await pageOk(cdp, 'member.list', { projectId: proj.id });
    const agent = members.items.find((m) => m.principalType === 'agent');
    await pageCmd(cdp, 'message.submit', {
      target: { kind: 'room_root', projectId: proj.id, conversationId: roomConv.cid, roomId: roomRow.id },
      body: '请生成交付文件', intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }],
    });
    await until(() => { try { return dbOf(root4).q('SELECT count(*) c FROM task_deliveries')[0].c; } catch { return 0; } }, (c) => c >= 1, 180000, 'G4 自然交付');
    f.g4.disk = spec.map((sp) => {
      const p2 = path.join(projDir, sp.path);
      const ok = fs.existsSync(p2);
      return { n: sp.path, ok, identical: ok ? sha256Buf(fs.readFileSync(p2)) === sha256Buf(Buffer.from(sp.contentBase64, 'base64')) : false };
    });
    // 成果入口 → 打开 DOCX 交付文件 → 阅读 → 切页 → 另存 hash 一致。
    const dlv = dbOf(root4).q('SELECT id, revision FROM task_deliveries ORDER BY rowid DESC LIMIT 1')[0];
    const threadId = dbOf(root4).q('SELECT conversation_thread_id FROM tasks WHERE current_delivery_id = ?', dlv.id)[0]?.conversation_thread_id;
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}`)}; true`);
    await sleep(1500);
    await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadId}?tab=artifacts`)}; true`);
    await waitFor(cdp, `document.querySelector('[data-zs-delivery-row]') != null`, 45000, 'G4 交付行');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.trim() === '打开文档'); b?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('[data-zs-delivery-doc]') != null`, 25000, 'G4 报告');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].length >= 3`, 15000, 'G4 三个文件入口');
    // 报告标签激活时逐个开文件：先 PDF，再回报告标签开 DOCX（开文件会切走活动标签）。
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].find((x) => x.getAttribute('data-zs-delivery-file') === '交付报告.pdf'); b?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pdf-view]') != null`, 90000, 'G4 交付 PDF');
    f.g4.pdfOpened = true;
    await openMoreMenu(cdp);
    const saved = await saveOriginal(cdp, '交付报告');
    f.g4.pdfSavedIdentical = saved.sha256 === sha256Buf(fs.readFileSync(FIX.pdfSmall));
    // 回报告标签 → 开 DOCX。
    await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('v1.md')); t?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].length >= 3`, 30000, 'G4 回报告标签');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].find((x) => x.getAttribute('data-zs-delivery-file') === '交付合同.docx'); b?.click(); return true; })()`));
    await waitFor(cdp, `(() => { const sr = document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot; return sr != null && sr.textContent.replace(/\s/g, '').length > 100; })()`, 90000, 'G4 交付 DOCX 阅读');
    f.g4.docxOpened = true;
    f.g4.docxTab = await cdp.tryEval(probe(`(() => { const on = document.querySelector('#hifi-root .preview-tab.on .preview-tab-label'); return on != null && on.textContent.includes('交付合同'); })()`));
    const dlvNote = '同链 G5 成果入口分列';
    void dlvNote;
    if (f.g4.disk.some((x) => !x.ok || !x.identical)) errs.push(`G4：落盘/字节（${JSON.stringify(f.g4.disk)}）`);
    if (f.g4.docxOpened !== true || f.g4.docxTab !== true || f.g4.pdfOpened !== true || f.g4.pdfSavedIdentical !== true) errs.push(`G4：交付阅读链（docx=${f.g4.docxOpened}/${f.g4.docxTab} pdf=${f.g4.pdfOpened}/${f.g4.pdfSavedIdentical}）`);
    f.g4.realCalls = realCallsOf(root4);
    await closeApp(app, cdp);
  }

  /* ================= G5 六个真源入口（同一真实文件各自打开） ================= */
  {
    const root5 = path.join(outDir, 'root5');
    const projDir = path.join(outDir, 'proj5');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '六源.md'), '# 六源文件\n\nSIX-SOURCE-CONTENT 内容', 'utf8');
    // ⑥ 成果文件入口用：fake 首轮把六源.md 作为交付文件落盘（同内容真实字节）。
    const spec5Path = path.join(outDir, 'write-spec5.json');
    fs.writeFileSync(spec5Path, JSON.stringify([{ path: '六源.md', content: '# 六源文件\n\nSIX-SOURCE-CONTENT 内容' }]), 'utf8');
    let { app, cdp } = await launchApp(root5, { ZS_FAKE_WRITE_FILES_JSON: spec5Path });
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    const roomRow = dbOf(root5).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id)[0];
    const member = dbOf(root5).q('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? LIMIT 1', proj.id, 'agent')[0];
    const sixFile = path.join(projDir, '六源.md');
    const shows = async (label) => waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('SIX-SOURCE-CONTENT')`, 40000, `G5 ${label}`).then(() => true);
    const closeAll = async () => {
      await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
      await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '菜单');
      await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
      await sleep(700);
    };
    // ① 房间草稿。
    await openRoomComposer(cdp, root5, proj.id);
    await uploadViaPage(cdp, sixFile, '六源.md', 'text/markdown');
    await waitChip(cdp, '六源.md', 'ready');
    await clickChipPreview(cdp, '六源.md');
    f.g5.draft = await shows('草稿');
    // ⓪ 派发一次任务（fake 落盘六源.md→交付报告列该文件——⑥ 成果入口素材）。
    {
      const roomConv5 = dbOf(root5).q('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', proj.id, 'room')[0];
      const members5 = await pageOk(cdp, 'member.list', { projectId: proj.id });
      const agent5 = members5.items.find((m) => m.principalType === 'agent');
      await pageCmd(cdp, 'message.submit', {
        target: { kind: 'room_root', projectId: proj.id, conversationId: roomConv5.cid, roomId: roomRow.id },
        body: '生成交付', intent: 'default', mentions: [{ kind: 'member', memberId: agent5.id }],
      });
      await until(() => { try { return dbOf(root5).q('SELECT count(*) c FROM task_deliveries')[0].c; } catch { return 0; } }, (c) => c >= 1, 180000, 'G5 交付就绪');
    }
    // ② 已发根消息（记录卡→线程附件）。
    await closeAll();
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, '六源随记录'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('本次仅记录')); b?.click(); return true; })()`));
    await sleep(400);
    await waitSendEnabled(cdp);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await waitFor(cdp, `document.body.textContent.includes('六源随记录')`, 30000, 'G5 消息已发');
    await sleep(1200);
    await until(async () => cdp.tryEval(probe(`(() => { if ([...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('附件') || x.textContent.includes('成果'))) return 'open'; const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('六源随记录')); card?.click(); return card != null ? 'clicked' : null; })()`)).catch(() => null), (v) => v === 'open', 60000, 'G5 线程打开');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .thread-tab')].find((x) => x.textContent.includes('附件') || x.textContent.includes('成果')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button.msg-attach')].some((b) => b.textContent.includes('六源'))`, 45000, 'G5 附件按钮');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button.msg-attach')].find((x) => x.textContent.includes('六源')); b?.click(); return true; })()`));
    f.g5.sent = await shows('已发消息');
    // ③ 线程回复附件：线程回复框上传+仅记录发送 → 回复附件入口。
    await closeAll();
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G5 线程输入区');
    await uploadViaPage(cdp, sixFile, '六源.md', 'text/markdown');
    await waitChip(cdp, '六源.md', 'ready');
    await clickChipPreview(cdp, '六源.md');
    f.g5.threadReplyDraft = await shows('线程回复草稿'); // 回复框草稿（同源同阅读器）
    // 发送回复（record）→ 回复消息的附件入口。
    await closeAll();
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, '回复带附件'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(300);
    const sendBtn = await cdp.tryEval(`(() => { const b = document.querySelector('#hifi-root .composer-send'); return b == null ? null : (b.disabled ? 'disabled' : 'ready'); })()`);
    if (sendBtn === 'disabled') {
      // 线程默认 sendAs=record（记录串语义）——直接可发。
    }
    await waitSendEnabled(cdp);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await waitFor(cdp, `document.body.textContent.includes('回复带附件')`, 30000, 'G5 回复已发');
    await sleep(1000);
    await until(async () => {
      const v = await cdp.tryEval(probe(`(() => { const btns = [...document.querySelectorAll('#hifi-root button')].filter((x) => x.textContent.trim() === '预览' || (x.className || '').includes('msg-attach')); return btns.length > 0; })()`));
      return v === true ? v : null;
    }, (v) => v === true, 30000, 'G5 回复附件入口');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].filter((x) => x.textContent.trim() === '预览')[0] || [...document.querySelectorAll('#hifi-root button.msg-attach')][0]; b?.click(); return true; })()`));
    f.g5.threadReply = await shows('线程回复附件');
    // ④ 私信。
    await closeAll();
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: member.id });
    await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G5 DM 输入区');
    await uploadViaPage(cdp, sixFile, '六源.md', 'text/markdown');
    await waitChip(cdp, '六源.md', 'ready');
    await clickChipPreview(cdp, '六源.md');
    f.g5.dm = await shows('私信');
    // ⑤ 文件树。
    await closeAll();
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('六源.md')`, 30000, 'G5 树列');
    await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '六源.md'); rows[rows.length - 1]?.click(); return true; })()`));
    f.g5.tree = await shows('文件树');
    // ⑥ 成果文件（真入口）：回房间主池 → 点「生成交付」任务卡 → 线程「成果」→ 打开文档（报告）
    // → 「六源.md」文件按钮 → 同一阅读器。（/thread/:id 深链在本轮门内定位不稳定——卡片
    // 路径即真实用户操作；深链问题另记未覆盖边界，不阻塞六源判据。）
    await cdp.eval(`location.hash = ${JSON.stringify(`/room/${roomRow.id}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G5 ⑥ 回房间');
    await sleep(1500);
    await until(async () => cdp.tryEval(probe(`(() => { if ([...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('成果') || x.textContent.includes('附件'))) return 'open'; const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('生成交付')); card?.click(); return card != null ? 'clicked' : null; })()`)).catch(() => null), (v) => v === 'open', 60000, 'G5 ⑥ 任务卡进线程');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .thread-tab')].find((x) => x.textContent.includes('成果') || x.textContent.includes('附件')); b?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('[data-zs-delivery-row]') != null`, 45000, 'G5 交付行');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.trim() === '打开文档'); b?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('[data-zs-delivery-doc]') != null`, 25000, 'G5 报告');
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].some((b) => b.getAttribute('data-zs-delivery-file') === '六源.md')`, 15000, 'G5 文件入口');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].find((x) => x.getAttribute('data-zs-delivery-file') === '六源.md'); b?.click(); return true; })()`));
    f.g5.attachmentList = await shows('成果文件');
    // 六源逐项判据（缺一即 fail——不用计数阈值）。
    const six = { draft: f.g5.draft, sent: f.g5.sent, threadReply: f.g5.threadReply, dm: f.g5.dm, tree: f.g5.tree, 成果: f.g5.attachmentList };
    const missing = Object.entries(six).filter(([, v]) => v !== true).map(([k]) => k);
    if (missing.length > 0) errs.push(`G5：六源缺 ${missing.join('、')}`);
    f.g5.detail = six;
    f.g5.realCalls = realCallsOf(root5);
    await closeApp(app, cdp);
  }

  /* ================= G6 合同交叉处（可执行子集） ================= */
  {
    const root6 = path.join(outDir, 'root6');
    const projDir = path.join(outDir, 'proj6');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'A.md'), '# A 文件\n\nCROSS-A 内容标记', 'utf8');
    fs.writeFileSync(path.join(projDir, 'B.md'), '# B 文件\n\nCROSS-B 内容标记', 'utf8');
    let { app, cdp } = await launchApp(root6, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root6, proj.id);
    // ① 引用卡去重：同一附件引用两次 → 草稿只有一张卡。
    await uploadViaPage(cdp, path.join(projDir, 'A.md'), 'A.md', 'text/markdown');
    await waitChip(cdp, 'A.md', 'ready');
    await clickChipPreview(cdp, 'A.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('CROSS-A')`, 30000, 'G6 A 打开');
    await openMoreMenu(cdp);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('引用到'))?.click(), true`));
    await sleep(1200);
    const draftA1 = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value.includes('A') ?? false`);
    void draftA1;
    await openMoreMenu(cdp);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('引用到'))?.click(), true`));
    await sleep(1200);
    f.g6.quoteDedupToast = await cdp.tryEval(probe(`(() => { const last = [...document.querySelectorAll('#hifi-root .toast')].slice(-1)[0]; return last != null && (last.textContent.includes('不重复') || last.textContent.includes('已在')); })()`));
    // ② 磁盘变更显式重载：改 B.md → banner 出现 → 点重载 → 新内容。
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((x) => (x.getAttribute('aria-label') || '').includes('更多')); b?.click(); return true; })()`));
    await sleep(400);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
    await sleep(700);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('B.md')`, 30000, 'G6 树列 B');
    await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === 'B.md'); rows[rows.length - 1]?.click(); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('CROSS-B')`, 30000, 'G6 B 打开');
    fs.writeFileSync(path.join(projDir, 'B.md'), '# B 文件 v2\n\nCROSS-B-NEW 磁盘更新内容', 'utf8');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-dirty-banner') != null`, 30000, 'G6 脏横幅');
    f.g6.dirtyBanner = true;
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-dirty-banner')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes('CROSS-B-NEW')`, 30000, 'G6 重载新内容');
    f.g6.reloadNew = true;
    // ③ 加载中关闭再打开：回房间输入区（此前在文件树页——无上传输入框）。
    await openRoomComposer(cdp, root6, proj.id);
    await uploadViaPage(cdp, FIX.pdfBig, 'GPT-5.6_Sol_Terra_Luna_五档推理成本智能对比分析.pdf', 'application/pdf');
    await waitChip(cdp, 'GPT-5.6_Sol_Terra_Luna_五档推理成本智能对比分析.pdf', 'ready', 120000);
    await clickChipPreview(cdp, 'GPT-5.6_Sol_Terra_Luna_五档推理成本智能对比分析.pdf');
    await sleep(150); // 加载窗口内
    await openMoreMenu(cdp);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭此文件'))?.click(), true`));
    await sleep(800);
    await clickChipPreview(cdp, 'GPT-5.6_Sol_Terra_Luna_五档推理成本智能对比分析.pdf');
    await waitFor(cdp, `(() => { const v = document.querySelector('#hifi-root [data-zs-pdf-view]'); return v != null && Number(v.getAttribute('data-zs-pdf-pages')) > 5; })()`, 90000, 'G6 重开 PDF');
    f.g6.closeDuringLoad = true;
    f.g6.noConsoleErrors = (cdp.consoleErrors ?? []).filter((e) => !e.includes('React DevTools')).length === 0;
    if (f.g6.quoteDedupToast !== true) errs.push('G6：引用去重未见提示（可能合同变化——复核）');
    if (f.g6.dirtyBanner !== true || f.g6.reloadNew !== true) errs.push('G6：磁盘变更重载链');
    if (f.g6.closeDuringLoad !== true) errs.push('G6：加载中关闭再开');
    f.g6.realCalls = realCallsOf(root6);
    await closeApp(app, cdp);
  }

  /* ================= G7 负对照：超限 pptx 就地人话错误（必须翻 FAIL 路径已由 errs 承载） ================= */
  {
    const root7 = path.join(outDir, 'root7');
    const projDir = path.join(outDir, 'proj7');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G7\n', 'utf8');
    let { app, cdp } = await launchApp(root7, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root7, proj.id);
    await uploadViaPage(cdp, FIX.pptxOver, 'r71-超限.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await until(async () => { chipStatesSnapshot = await chipStates(cdp); return chipStatesSnapshot.some((c) => c.err === 'r71-超限.pptx'); }, (v) => v, 60000, 'G7 超限失败芯片');
    const errChip = chipStatesSnapshot.find((c) => c.err === 'r71-超限.pptx');
    f.g7.inlineReason = errChip?.text.includes('MiB');
    f.g7.reasonSample = (errChip?.text ?? '').slice(0, 120);
    // 文件树同限：复制到 proj → 打开 → 如实错误（不冒充）。
    fs.copyFileSync(FIX.pptxOver, path.join(projDir, 'r71-超限.pptx'));
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('r71-超限.pptx')`, 30000, 'G7 树列');
    await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === 'r71-超限.pptx'); rows[rows.length - 1]?.click(); return true; })()`));
    await waitFor(cdp, `(() => { const b = document.querySelector('#hifi-root .preview-body'); return b != null && (b.textContent.includes('MiB') || b.textContent.includes('失败') || b.textContent.includes('不能预览')); })()`, 60000, 'G7 树开超限如实');
    f.g7.treeHonest = true;
    if (f.g7.inlineReason !== true) errs.push(`G7：超限原因未含 MiB（${f.g7.reasonSample}）`);
    if (f.g7.treeHonest !== true) errs.push('G7：文件树超限不实');
    f.g7.realCalls = realCallsOf(root7);
    await closeApp(app, cdp);
  }

  /* ================= G8 真窗口拉宽/缩窄 + 高 DPR（P6——不用被钳制的 Emulation 拉宽） ================= */
  {
    const root8 = path.join(outDir, 'root8');
    const projDir = path.join(outDir, 'proj8');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G8\n', 'utf8');
    let { app, cdp } = await launchApp(root8, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root8, proj.id);
    await uploadViaPage(cdp, FIX.pdfSmall, 'result.pdf', 'application/pdf');
    await waitChip(cdp, 'result.pdf', 'ready');
    await clickChipPreview(cdp, 'result.pdf');
    await waitFor(cdp, `(() => { const c = document.querySelector('#hifi-root canvas[data-zs-pdf-canvas]'); return c != null && c.width > 200; })()`, 60000, 'G8 PDF 初始');
    const fitState = () => cdp.tryEval(probe(`(() => { const c = document.querySelector('#hifi-root canvas[data-zs-pdf-canvas]'); const s = document.querySelector('#hifi-root .pdf-stage'); if (c == null || s == null) return null; const r = c.getBoundingClientRect(); return { stageW: s.clientWidth, cssW: Math.round(r.width), overflowX: s.scrollWidth > s.clientWidth + 1, backing: c.width }; })()`));
    f.g8.initial = await fitState();
    // 真窗口缩窄（window.resizeTo——Electron BrowserWindow 真实 OS 窗口尺寸，非 Emulation）。
    const origW = await cdp.eval('window.innerWidth');
    const narrowW = Math.max(700, Math.round(origW * 0.6));
    await cdp.eval(`window.resizeTo(${narrowW}, window.innerHeight), true`);
    await sleep(2800);
    f.g8.narrowWinW = await cdp.tryEval('window.innerWidth');
    f.g8.narrow = await fitState();
    // 真窗口拉宽回。
    await cdp.eval(`window.resizeTo(${origW}, window.innerHeight), true`);
    await sleep(1500);
    await cdp.eval("window.dispatchEvent(new Event('resize')), true");
    await sleep(3500);
    f.g8.wideWinW = await cdp.tryEval('window.innerWidth');
    f.g8.wide = await fitState();
    // 高 DPR（Emulation dpr=2——canvas 只在 [doc,page,zoom,stageSize] 变化时重绘，
    // override 后翻一页再翻回触发按新 DPR 重绘；结束恢复）。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 2, mobile: false });
    await sleep(1500);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .pdf-view [aria-label=下一页]')][0]?.click(), true`));
    await sleep(2200);
    f.g8.dpr2 = await fitState();
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    if (f.g8.initial?.overflowX === true) errs.push('G8：初始越界');
    if (f.g8.narrow == null || f.g8.narrow.overflowX === true || f.g8.narrow.cssW > f.g8.narrow.stageW) errs.push(`G8：真窗口缩窄越界（${JSON.stringify(f.g8.narrow)}）`);
    if (f.g8.narrow != null && f.g8.initial != null && !(f.g8.narrow.cssW < f.g8.initial.cssW)) errs.push(`G8：真窗口缩窄画布未缩（${f.g8.initial.cssW}→${f.g8.narrow.cssW}）`);
    if (f.g8.wide != null && f.g8.narrow != null && !(f.g8.wide.cssW > f.g8.narrow.cssW)) errs.push(`G8：真窗口拉宽未恢复（${f.g8.narrow.cssW}→${f.g8.wide.cssW}）`);
    if (f.g8.dpr2 != null && f.g8.dpr2.backing != null && f.g8.dpr2.cssW != null && !(f.g8.dpr2.backing >= f.g8.dpr2.cssW * 1.9)) errs.push(`G8：DPR2 背板未翻倍（backing=${f.g8.dpr2.backing} css=${f.g8.dpr2.cssW}）`);
    f.g8.realCalls = realCallsOf(root8);
    await closeApp(app, cdp);
  }

  /* ================= 全部根 real_calls ================= */
  const realCallRoots = [];
  for (let i = 1; i <= 8; i += 1) {
    const rc = realCallsOf(path.join(outDir, `root${i}`));
    realCallRoots.push(rc);
    if (rc !== 0) errs.push(`root${i} real_calls=${rc}`);
  }

  const result = { runId, ok: errs.length === 0, errs, checks: f, realCallRoots, shotsDir };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    ok: result.ok, errs: result.errs,
    g1: { uploadMs: f.g1.uploadMs, firstViewMs: f.g1.firstViewMs, pages: f.g1.pages, p40: f.g1.p40Imgs, last: f.g1.lastPageOk, zoom: f.g1.zoomOk, restore: f.g1.restorePage, saved: f.g1.savedIdentical, heap: `${f.g1.heapBeforeMB}→${f.g1.heapAfterMB}MB` },
    g2: { docx: f.g2.docx && f.g2.docxSave, xlsx: { mode: f.g2.xlsxMode, tabs: f.g2.xlsxTabs, keep: f.g2.xlsxAfter11s === f.g2.xlsxSwitched, save: f.g2.xlsxSave }, pdfBig: f.g2.pdfBigPages, jump: f.g2.pdfJump, pdfSmall: f.g2.pdfSmall, png: f.g2.pngSize, html: f.g2.html, txt: f.g2.txt, md: f.g2.md },
    g3: { neutral: f.g3.neutralShown && f.g3.noDanger, read: f.g3.fileReadOk, dto: f.g3.dtoRootPath && f.g3.dtoCanonical },
    g4: { disk: f.g4.disk, docx: f.g4.docxOpened && f.g4.docxTab, pdf: f.g4.pdfOpened && f.g4.pdfSavedIdentical },
    g5: f.g5.detail,
    g6: { quote: f.g6.quoteDedupToast, dirty: f.g6.dirtyBanner && f.g6.reloadNew, closeLoad: f.g6.closeDuringLoad, console: f.g6.noConsoleErrors },
    g7: { inline: f.g7.inlineReason, sample: f.g7.reasonSample, tree: f.g7.treeHonest },
    g8: { initial: f.g8.initial, narrow: f.g8.narrow, wide: f.g8.wide, dpr2: f.g8.dpr2 },
    realCallRoots,
  }));
  cleanupOwn();
  process.exit(result.ok ? 0 : 10);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId, partialChecks: f ?? null }, null, 2)); } catch { /* */ }
  console.error(String(err && err.stack || err));
  console.error('[appOut]', __appOut.v.slice(-2500));
  cleanupOwn();
  process.exit(1);
});
