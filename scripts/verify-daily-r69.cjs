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

const repo = path.resolve(__dirname, '..');
const runId = `r69-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r69-${runId}`);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 9671;
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
let f = { g1: {}, g2: {}, g3: {}, g4: {}, g5: {}, g6: {}, g7: {} };

/* ---------------- 夹具（只读复制用户样本到自有目录；敏感正文不写入报告） ---------------- */
const fx = path.join(outDir, 'fixtures');
fs.mkdirSync(fx, { recursive: true });
const USER_PPT = 'C:/Users/user/Downloads/江西系统建设方案@0605.pptx';
const USER_PNG = 'D:/zhongshuo/dist/desktop/review-r68-preview-audit-20261007/r69-user-image.png';
const FIX = {
  pptx: path.join(fx, '江西系统建设方案@0605.pptx'),
  png: path.join(fx, 'canvas-image.png'),
  txt: path.join(fx, 'r69-普通文本.txt'),
  empty: path.join(fx, 'r69-空文件.txt'),
  bom: path.join(fx, 'r69-BOM文本.txt'),
  utf16: path.join(fx, 'r69-UTF16文本.txt'),
  exe: path.join(fx, 'r69-程序.exe'),
  pdf: path.join(repo, 'dist/desktop/r69-fixtures/r69-多页报告.pdf'),
  docx: path.join(repo, 'dist/desktop/r69-fixtures/r69-验收合同.docx'),
  xlsx: path.join(repo, 'dist/desktop/r69-fixtures/r69-补助信息.xlsx'),
  md: path.join(repo, 'dist/desktop/r69-fixtures/r69-说明.md'),
  html: path.join(repo, 'dist/desktop/r69-fixtures/r69-页面.html'),
};
fs.copyFileSync(USER_PPT, FIX.pptx);
fs.copyFileSync(USER_PNG, FIX.png);
fs.writeFileSync(FIX.txt, 'R69 普通文本验收：预览应显示本行与行号。\n第二行内容。', 'utf8');
fs.writeFileSync(FIX.empty, '', 'utf8');
fs.writeFileSync(FIX.bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('R69 BOM 文本：BOM 应保留在原件、阅读解码剥离。\n', 'utf8')]));
fs.writeFileSync(FIX.utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('R69 UTF-16 文本：正常 Windows 编码不应被称损坏，阅读应正确解码。\n', 'utf16le')]));
fs.writeFileSync(FIX.exe, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]), 'binary');
// 宏主 part（.pptm 形态）与损坏 Office（软解析失败）夹具。
{
  const fflate = require(path.join(repo, 'node_modules', 'fflate'));
  const zipSync = (files) => Buffer.from(fflate.zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]))));
  const CT_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const rels = `${CT_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  const pres = `${CT_HEAD}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></p:sldIdLst></p:presentation>`;
  const presRels = `${CT_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`;
  const slide = `${CT_HEAD}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>宏样本</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const ctMacro = `${CT_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`;
  FIX.pptm = path.join(fx, 'r69-宏主文档.pptm');
  fs.writeFileSync(FIX.pptm, zipSync({ '[Content_Types].xml': ctMacro, '_rels/.rels': rels, 'ppt/presentation.xml': pres, 'ppt/_rels/presentation.xml.rels': presRels, 'ppt/slides/slide1.xml': slide }));
  // 损坏 Office：主 part 类型合法（普通 docx）但 word/document.xml 非良构（mammoth 解析真失败→软失败分列）。
  const ctDocxOk = `${CT_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const relsDocx = `${CT_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  FIX.brokenDocx = path.join(fx, 'r69-损坏文档.docx');
  fs.writeFileSync(FIX.brokenDocx, zipSync({ '[Content_Types].xml': ctDocxOk, '_rels/.rels': relsDocx, 'word/document.xml': '<w:document broken-xml' }));
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
    expression: `window.zs.command({ protocolVersion: 1, commandId: ${JSON.stringify(commandId ?? `g69-${Math.random().toString(36).slice(2, 10)}`)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
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
  /* ================= G1 文本族 + 房间草稿首开死锁（P1-A/P1-C） ================= */
  {
    const root1 = path.join(outDir, 'root1');
    const projDir = path.join(outDir, 'proj1');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G1 项目\n', 'utf8');
    let { app, cdp } = await launchApp(root1, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root1, proj.id);

    // ① 普通 UTF-8：上传→就绪→**草稿首开预览**（用户 TXT 反例——死锁修复证明）。
    await uploadViaPage(cdp, FIX.txt, 'r69-普通文本.txt', 'text/plain');
    await waitChip(cdp, 'r69-普通文本.txt', 'ready');
    const click1 = await clickChipPreview(cdp, 'r69-普通文本.txt');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-pane .preview-body') != null`, 20000, 'G1 首开面板挂载');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-source')?.textContent.includes('R69 普通文本验收')`, 20000, 'G1 首开文本内容可见');
    f.g1.firstOpenText = true; f.g1.click1 = click1;
    await cdp.shot('g1-text-first-open');
    // readFull 命令确实发生（死锁时为 0 次）——由内容可见性证明（内容只有 readFull 才能出现）。

    // ② 0B 空文件：上传成功（不再「失败」）→ 预览=0B 空态 → 另存 0 字节。
    await uploadViaPage(cdp, FIX.empty, 'r69-空文件.txt', 'text/plain');
    await waitChip(cdp, 'r69-空文件.txt', 'ready');
    await clickChipPreview(cdp, 'r69-空文件.txt');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-empty-file]') != null`, 20000, 'G1 0B 空态');
    f.g1.emptyState = true;
    await openMoreMenu(cdp);
    const savedEmpty = await saveOriginal(cdp, '空文件');
    f.g1.emptySavedBytes = savedEmpty.bytes;
    f.g1.emptySavedHash = savedEmpty.sha256 === sha256Buf(fs.readFileSync(FIX.empty));

    // ③ BOM：上传就绪 → 预览首行无 BOM 字符且内容正确 → 另存逐字节一致（含 BOM）。
    await uploadViaPage(cdp, FIX.bom, 'r69-BOM文本.txt', 'text/plain');
    await waitChip(cdp, 'r69-BOM文本.txt', 'ready');
    await clickChipPreview(cdp, 'r69-BOM文本.txt');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-source')?.textContent.includes('BOM 应保留在原件')`, 20000, 'G1 BOM 阅读解码');
    f.g1.bomReadStripped = await cdp.tryEval(`(() => { const t = document.querySelector('#hifi-root .preview-source .preview-source-text'); return t != null ? !t.textContent.startsWith('\\uFEFF') : null; })()`);
    await openMoreMenu(cdp);
    const savedBom = await saveOriginal(cdp, 'BOM');
    f.g1.bomSavedIdentical = savedBom.sha256 === sha256Buf(fs.readFileSync(FIX.bom));

    // ④ UTF-16：上传不再被称「损坏字节」→ 预览正确解码。
    await uploadViaPage(cdp, FIX.utf16, 'r69-UTF16文本.txt', 'text/plain');
    await waitChip(cdp, 'r69-UTF16文本.txt', 'ready');
    await clickChipPreview(cdp, 'r69-UTF16文本.txt');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-source')?.textContent.includes('UTF-16 文本')`, 20000, 'G1 UTF-16 解码');
    f.g1.utf16Decoded = true;
    await openMoreMenu(cdp);
    const savedU16 = await saveOriginal(cdp, 'UTF16');
    f.g1.utf16SavedIdentical = savedU16.sha256 === sha256Buf(fs.readFileSync(FIX.utf16));

    // ⑤ 关闭全部 → 面板退场 → 再首开（同一文件）仍可打开。
    await openMoreMenu(cdp);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
    await waitFor(cdp, `document.querySelectorAll('#hifi-root .preview-pane .preview-tab').length === 0`, 10000, 'G1 关闭全部');
    await clickChipPreview(cdp, 'r69-普通文本.txt');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-source')?.textContent.includes('R69 普通文本验收')`, 20000, 'G1 关全部后再首开');
    f.g1.reopenAfterCloseAll = true;

    // ⑥ 负例：.exe 就地失败原因（不只 title）+ 重选文件按钮。
    await uploadViaPage(cdp, FIX.exe, 'r69-程序.exe', 'application/octet-stream');
    await until(async () => { chipStatesSnapshot = await chipStates(cdp); return chipStatesSnapshot.some((c) => c.err === 'r69-程序.exe'); }, (v) => v, 20000, 'G1 exe 失败芯片');
    f.g1.exeInlineReason = (() => { const c = chipStatesSnapshot.find((x) => x.err === 'r69-程序.exe'); return c != null && (c.text.includes('未接入的附件类型') || c.text.includes('不支持的附件类型')); })();
    f.g1.exeRetryBtn = await cdp.tryEval(probe(`(() => { const chip = [...document.querySelectorAll('#hifi-root [data-zs-att-error="r69-程序.exe"]')][0]; return chip != null && [...chip.querySelectorAll('button')].some((b) => b.textContent.includes('重选文件')); })()`));

    if (!f.g1.firstOpenText || !f.g1.emptyState || f.g1.emptySavedBytes !== 0 || !f.g1.emptySavedHash) errs.push(`G1：文本族断裂（first=${f.g1.firstOpenText} empty=${f.g1.emptyState} emptyBytes=${f.g1.emptySavedBytes}）`);
    if (f.g1.bomReadStripped !== true || f.g1.bomSavedIdentical !== true || f.g1.utf16SavedIdentical !== true || !f.g1.utf16Decoded) errs.push(`G1：原字节/编码断裂（bomRead=${f.g1.bomReadStripped} bomSave=${f.g1.bomSavedIdentical} u16=${f.g1.utf16Decoded}/${f.g1.utf16SavedIdentical}）`);
    if (!f.g1.reopenAfterCloseAll) errs.push('G1：关闭全部后再首开失败');
    if (f.g1.exeInlineReason !== true || f.g1.exeRetryBtn !== true) errs.push(`G1：失败原因就地可见断裂（inline=${f.g1.exeInlineReason} retry=${f.g1.exeRetryBtn}）`);
    await closeApp(app, cdp);
  }

  /* ================= G2 用户 PNG（上传成功≠模型已读） ================= */
  {
    const root2 = path.join(outDir, 'root2');
    const projDir = path.join(outDir, 'proj2');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G2 项目\n', 'utf8');
    let { app, cdp } = await launchApp(root2, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root2, proj.id);
    await uploadViaPage(cdp, FIX.png, 'canvas-image.png', 'image/png');
    await waitChip(cdp, 'canvas-image.png', 'ready');
    f.g2.chipReady = true;
    await clickChipPreview(cdp, 'canvas-image.png');
    await waitFor(cdp, `document.querySelector('#hifi-root img[data-zs-image-preview]') != null`, 25000, 'G2 图片元素');
    await waitFor(cdp, `(() => { const i = document.querySelector('#hifi-root img[data-zs-image-preview]'); return i != null && i.naturalWidth > 0; })()`, 25000, 'G2 像素解码');
    f.g2.natural = await cdp.tryEval(`(() => { const i = document.querySelector('#hifi-root img[data-zs-image-preview]'); return i == null ? null : i.naturalWidth + 'x' + i.naturalHeight; })()`);
    await cdp.shot('g2-image');
    // 图片能力门与上传分列：能力门行（若显示）不把上传说成失败；芯片仍 ready。
    f.g2.gateNotUploadFailure = await cdp.tryEval(probe(`(() => { const gate = [...document.querySelectorAll('#hifi-root .composer-mentions .chip')].find((x) => x.textContent.includes('图片能力门')); if (gate == null) return 'absent'; return gate.textContent.includes('仅发送文字') && !gate.textContent.includes('上传失败'); })()`));
    await openMoreMenu(cdp);
    const savedPng = await saveOriginal(cdp, 'canvas');
    f.g2.savedIdentical = savedPng.sha256 === sha256Buf(fs.readFileSync(FIX.png));
    if (!f.g2.chipReady || f.g2.natural == null || String(f.g2.natural) === 'null') errs.push(`G2：图片预览断裂（natural=${f.g2.natural}）`);
    if (f.g2.savedIdentical !== true) errs.push('G2：PNG 另存 hash 不一致');
    if (f.g2.gateNotUploadFailure === false) errs.push('G2：能力门把上传说成失败');
    await closeApp(app, cdp);
  }

  /* ================= G3 用户真实 PPT（11.7MB/55 页）================= */
  {
    const root3 = path.join(outDir, 'root3');
    const projDir = path.join(outDir, 'proj3');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G3 项目\n', 'utf8');
    let { app, cdp } = await launchApp(root3, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root3, proj.id);
    await uploadViaPage(cdp, FIX.pptx, '江西系统建设方案@0605.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await waitChip(cdp, '江西系统建设方案@0605.pptx', 'ready', 120000); // P1-B：主 part 定类修复后不再「失败」
    f.g3.uploadOk = true;
    await clickChipPreview(cdp, '江西系统建设方案@0605.pptx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]') != null`, 90000, 'G3 pptx 视图挂载');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages') === '55'`, 120000, 'G3 55 页');
    f.g3.pages = 55;
    await waitFor(cdp, `document.querySelectorAll('#hifi-root .pptx-thumbs .pptx-thumb').length === 55`, 30000, 'G3 缩略图 55 枚');
    await waitFor(cdp, `document.querySelectorAll('#hifi-root .pptx-thumbs .pptx-thumb .pptx-slide-mount > *').length >= 3`, 120000, 'G3 缩略图渲染（首屏懒渲染）');
    f.g3.thumbsRendered = await cdp.tryEval(`document.querySelectorAll('#hifi-root .pptx-thumbs .pptx-thumb .pptx-slide-mount > *').length`);
    await waitFor(cdp, `document.querySelector('#hifi-root .pptx-main .pptx-slide-mount > *') != null`, 120000, 'G3 主舞台首页渲染');
    await sleep(700);
    await cdp.shot('g3-ppt-home');
    // 跳页：页码输入 27（装载 effect 会复位页码——循环重设直到输入框稳定为 27）。
    await until(async () => {
      const v = await cdp.tryEval(probe(`(() => { const i = document.querySelector('#hifi-root .pptx-page-input'); if (i == null) return null; if (i.value === '27') return 'ok'; i.value = '27'; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return 'set'; })()`)).catch(() => null);
      return v;
    }, (v) => v === 'ok', 45000, 'G3 跳页 27');
    f.g3.jumpPage = true;
    await sleep(900);
    await cdp.shot('g3-ppt-page27');
    // 缩放 +。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root [data-zs-pptx-bar] button')].find((b) => (b.getAttribute('aria-label') || '') === '放大')?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .pptx-zoom-label')?.textContent === '125%'`, 8000, 'G3 缩放 125%');
    f.g3.zoom = true;
    // 末页。
    await cdp.eval(probe(`(() => { const i = document.querySelector('#hifi-root .pptx-page-input'); i.value = '55'; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return true; })()`));
    await sleep(900);
    await cdp.shot('g3-ppt-page55');
    await openMoreMenu(cdp);
    const savedPpt = await saveOriginal(cdp, '江西');
    f.g3.savedIdentical = savedPpt.sha256 === sha256Buf(fs.readFileSync(FIX.pptx));
    f.g3.savedBytes = savedPpt.bytes;
    if (!f.g3.uploadOk || f.g3.pages !== 55 || !(f.g3.thumbsRendered >= 3) || !f.g3.jumpPage || !f.g3.zoom) errs.push(`G3：PPT 链断裂（pages=${f.g3.pages} thumbs=${f.g3.thumbsRendered} jump=${f.g3.jumpPage} zoom=${f.g3.zoom}）`);
    if (f.g3.savedIdentical !== true) errs.push(`G3：PPT 另存 hash 不一致（${f.g3.savedBytes}B）`);
    await closeApp(app, cdp);
  }

  /* ================= G4 PDF/Word/Excel/MD/HTML 夹具 ================= */
  {
    const root4 = path.join(outDir, 'root4');
    const projDir = path.join(outDir, 'proj4');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G4 项目\n', 'utf8');
    let { app, cdp } = await launchApp(root4, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root4, proj.id);

    // --- PDF：5 页真实面板适应+页码+翻页 ---
    await uploadViaPage(cdp, FIX.pdf, 'r69-多页报告.pdf', 'application/pdf');
    await waitChip(cdp, 'r69-多页报告.pdf', 'ready');
    await clickChipPreview(cdp, 'r69-多页报告.pdf');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pdf-view]')?.getAttribute('data-zs-pdf-pages') === '5'`, 60000, 'G4 PDF 5 页');
    await waitFor(cdp, `(() => { const c = document.querySelector('#hifi-root canvas[data-zs-pdf-canvas]'); return c != null && c.width > 200 && c.height > 200; })()`, 30000, 'G4 PDF canvas 绘制');
    f.g4.pdfCanvas = true;
    // 适应=contain（画布完整在舞台内且由面板驱动，而非旧实现固定 480px 常量）。
    f.g4.pdfFit = await cdp.tryEval(probe(`(() => { const c = document.querySelector('#hifi-root canvas[data-zs-pdf-canvas]'); const stage = document.querySelector('#hifi-root .pdf-stage'); if (c == null || stage == null) return null; const r = c.getBoundingClientRect(); return r.width <= stage.clientWidth - 8 && r.height <= stage.clientHeight - 8 && r.width > 200 && Math.abs(r.width - 480) > 2; })()`));
    await cdp.eval(probe(`(() => { const i = document.querySelector('#hifi-root .pdf-view .pptx-page-input'); i.value = '3'; i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return true; })()`));
    await waitFor(cdp, `document.querySelector('#hifi-root .pdf-view .pptx-page-input')?.value === '3'`, 20000, 'G4 PDF 跳页 3');
    f.g4.pdfJump = true;
    await cdp.shot('g4-pdf-page3');

    // --- Word：分页纸张、不再铺第二份净化提取副本 ---
    await uploadViaPage(cdp, FIX.docx, 'r69-验收合同.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await waitChip(cdp, 'r69-验收合同.docx', 'ready');
    await clickChipPreview(cdp, 'r69-验收合同.docx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-docx-view]')?.getAttribute('data-zs-docx-state') === 'ready'`, 60000, 'G4 Word ready');
    await waitFor(cdp, `(() => { const host = document.querySelector('#hifi-root [data-zs-docx-host]'); if (host == null || host.shadowRoot == null) return false; const secs = host.shadowRoot.querySelectorAll('section'); return secs.length >= 2 || (host.shadowRoot.textContent.includes('附则') && host.shadowRoot.textContent.includes('附表')); })()`, 60000, 'G4 Word 分页纸张（≥2 页）');
    f.g4.docxPages = await cdp.tryEval(`(() => { const host = document.querySelector('#hifi-root [data-zs-docx-view]'); return document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot?.querySelectorAll('section').length; })()`);
    f.g4.docxNoSecondCopy = await cdp.tryEval(`document.querySelector('#hifi-root .office-docx-html') == null`);
    f.g4.docxTable = await cdp.tryEval(`(() => { const host = document.querySelector('#hifi-root [data-zs-docx-view]'); return document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot?.querySelectorAll('table').length > 0; })()`);
    await cdp.shot('g4-docx');

    // --- Excel：WASM 引擎 + 3 sheet 页签 + 切表 ---
    await uploadViaPage(cdp, FIX.xlsx, 'r69-补助信息.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await waitChip(cdp, 'r69-补助信息.xlsx', 'ready');
    await clickChipPreview(cdp, 'r69-补助信息.xlsx');
    await until(async () => {
      const v = await cdp.tryEval(probe(`(() => { const e = document.querySelector('#hifi-root [data-zs-xlsx-view]'); return e == null ? null : e.getAttribute('data-zs-xlsx-view'); })()`));
      return v ?? null;
    }, (v) => v != null, 60000, 'G4 Excel 视图（引擎或回退）');
    await sleep(2500); // 引擎装载/回退切换窗口
    f.g4.xlsxMode = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-xlsx-view]')?.getAttribute('data-zs-xlsx-view')`);
    f.g4.xlsxTabs = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab')].map((b) => b.textContent.trim())`);
    if (Array.isArray(f.g4.xlsxTabs) && f.g4.xlsxTabs.length > 1) {
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab')].find((x) => x.textContent.includes('数据录入')); b?.click(); return true; })()`));
      await sleep(1200);
      f.g4.xlsxTabSwitch = await cdp.tryEval(probe(`(() => { const on = document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on'); return on != null && on.textContent.includes('数据录入'); })()`));
    }
    await cdp.shot('g4-xlsx');
    f.g4.xlsxEngineVisible = f.g4.xlsxMode === 'engine' ? await cdp.tryEval(probe(`(() => { const host = document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]'); return host != null && (host.textContent.includes('补助模块') || host.querySelectorAll('canvas').length > 0 || host.querySelector('.xlsx-sheet-tabs') != null); })()`)) : false;

    // --- MD：表格渲染 ---
    await uploadViaPage(cdp, FIX.md, 'r69-说明.md', 'text/markdown');
    await waitChip(cdp, 'r69-说明.md', 'ready');
    await clickChipPreview(cdp, 'r69-说明.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .md-table') != null || document.querySelector('#hifi-root .preview-read-doc table') != null`, 30000, 'G4 MD 表格');
    f.g4.mdTable = true;
    await cdp.shot('g4-md');

    // --- HTML：隔离 iframe ---
    await uploadViaPage(cdp, FIX.html, 'r69-页面.html', 'text/html');
    await waitChip(cdp, 'r69-页面.html', 'ready');
    await clickChipPreview(cdp, 'r69-页面.html');
    await waitFor(cdp, `document.querySelector('#hifi-root iframe[data-zs-html-frame]') != null`, 30000, 'G4 HTML iframe');
    f.g4.htmlFrame = true;

    if (f.g4.pdfCanvas !== true || f.g4.pdfFit !== true || !f.g4.pdfJump) errs.push(`G4：PDF 断裂（canvas=${f.g4.pdfCanvas} fit=${f.g4.pdfFit} jump=${f.g4.pdfJump}）`);
    if (!(f.g4.docxPages >= 2) || f.g4.docxNoSecondCopy !== true || f.g4.docxTable !== true) errs.push(`G4：Word 断裂（pages=${f.g4.docxPages} noSecond=${f.g4.docxNoSecondCopy} table=${f.g4.docxTable}）`);
    if (f.g4.xlsxMode !== 'engine') errs.push(`G4：Excel 引擎未生效（mode=${f.g4.xlsxMode}——如为 fallback 属实记录，但交付门要求引擎）`);
    if (!f.g4.mdTable || !f.g4.htmlFrame) errs.push('G4：MD/HTML 断裂');
    await closeApp(app, cdp);
  }

  /* ================= G5 文件树入口（worktree 二进制=同一阅读器） ================= */
  {
    const root5 = path.join(outDir, 'root5');
    const projDir = path.join(outDir, 'proj5');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G5 项目\n', 'utf8');
    fs.copyFileSync(FIX.pptx, path.join(projDir, '江西系统建设方案@0605.pptx'));
    fs.copyFileSync(FIX.png, path.join(projDir, 'canvas-image.png'));
    fs.copyFileSync(FIX.pdf, path.join(projDir, 'r69-多页报告.pdf'));
    fs.copyFileSync(FIX.docx, path.join(projDir, 'r69-验收合同.docx'));
    fs.copyFileSync(FIX.xlsx, path.join(projDir, 'r69-补助信息.xlsx'));
    fs.copyFileSync(FIX.md, path.join(projDir, 'r69-说明.md'));
    let { app, cdp } = await launchApp(root5, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G5 文件树');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('江西系统建设方案')`)).catch(() => null), (v) => v, 30000, 'G5 树列用户 PPT');
    const openTreeFile = async (name) => {
      await cdp.eval(probe(`(() => { const row = [...document.querySelectorAll('#hifi-root .file-tree .tree-row, #hifi-root .file-tree [role=treeitem], #hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === ${JSON.stringify(name)}); if (row.length === 0) return 'NO_ROW'; row[row.length - 1].click(); return true; })()`));
      return true;
    };
    // 用户 PPT 从文件树：同一 pptx 阅读器（worktree readFull 二进制）。
    await openTreeFile('江西系统建设方案@0605.pptx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages') === '55'`, 120000, 'G5 树开 PPT 55 页');
    f.g5.treePpt = true;
    await cdp.shot('g5-tree-ppt');
    // PNG 从文件树。
    await openTreeFile('canvas-image.png');
    await waitFor(cdp, `document.querySelector('#hifi-root img[data-zs-image-preview]') != null`, 30000, 'G5 树开 PNG');
    f.g5.treePng = true;
    // MD 从文件树（阅读排版）。
    await openTreeFile('r69-说明.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-read-doc') != null`, 30000, 'G5 树开 MD');
    f.g5.treeMd = true;
    // Excel 从文件树。
    await openTreeFile('r69-补助信息.xlsx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-xlsx-view]') != null`, 60000, 'G5 树开 Excel');
    f.g5.treeXlsx = true;
    // 树开 PPT 另存原字节一致（worktree originalFile 二进制通道）。
    await openTreeFile('江西系统建设方案@0605.pptx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]') != null`, 120000, 'G5 树再开 PPT');
    await openMoreMenu(cdp);
    const savedTree = await saveOriginal(cdp, '江西');
    f.g5.treeSavedIdentical = savedTree.sha256 === sha256Buf(fs.readFileSync(FIX.pptx));
    if (!f.g5.treePpt || !f.g5.treePng || !f.g5.treeMd || !f.g5.treeXlsx) errs.push(`G5：文件树入口断裂（ppt=${f.g5.treePpt} png=${f.g5.treePng} md=${f.g5.treeMd} xlsx=${f.g5.treeXlsx}）`);
    if (f.g5.treeSavedIdentical !== true) errs.push('G5：树开 PPT 另存 hash 不一致');
    await closeApp(app, cdp);
  }

  /* ================= G6 DM 入口 + 已发消息入口 + 关全部再首开 ================= */
  {
    const root6 = path.join(outDir, 'root6');
    const projDir = path.join(outDir, 'proj6');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G6 项目\n', 'utf8');
    let { app, cdp } = await launchApp(root6, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    // DM：成员存在（project.open 引导成员）——开私信会话。
    const member = dbOf(root6).q('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? LIMIT 1', proj.id, 'agent')[0];
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: member.id });
    await until(() => cdp.tryEval(probe(`document.body.classList.contains('hifi-on') && (document.querySelector('#hifi-root .side-project .side-item-label') != null || document.body.textContent.includes('默认房间'))`)).catch(() => null), (v) => v, 45000, 'G6 就绪');
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, 'G6 项目装载');
    await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G6 DM 输入区');
    await uploadViaPage(cdp, FIX.md, 'r69-说明.md', 'text/markdown');
    await waitChip(cdp, 'r69-说明.md', 'ready');
    await clickChipPreview(cdp, 'r69-说明.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-read-doc') != null`, 30000, 'G6 DM 草稿首开');
    f.g6.dmDraftOpen = true;
    // 关全部。
    await openMoreMenu(cdp);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
    await waitFor(cdp, `document.querySelectorAll('#hifi-root .preview-pane .preview-tab').length === 0`, 10000, 'G6 关闭全部');
    // 发送仅记录消息携带附件 → 已发消息入口再开。
    const ta = 'document.querySelector(\'#hifi-root textarea.composer-input\')';
    await cdp.eval(probe(`(() => { const ta = ${ta}; const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'G6 附件随记录'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await waitSendEnabled(cdp);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await waitFor(cdp, `document.body.textContent.includes('G6 附件随记录')`, 30000, 'G6 消息已发');
    f.g6.sentMessage = true;
    // 已发消息的附件芯片/引用入口（消息附件区出现「预览」）——点击可能落在重渲染间隙的
    // 分离节点上，循环重试直到面板真正出现（收敛而不是一次性点击）。
    await until(async () => cdp.tryEval(probe(`(() => { if (document.querySelector('#hifi-root .preview-read-doc') != null) return 'open'; const b = [...document.querySelectorAll('#hifi-root button')].filter((x) => x.textContent.trim() === '预览')[0]; if (b == null) return null; b.click(); return 'clicked'; })()`)).catch(() => null), (v) => v === 'open', 45000, 'G6 已发消息入口首开');
    f.g6.sentReopen = true;
    if (!f.g6.dmDraftOpen || !f.g6.sentMessage || !f.g6.sentReopen) errs.push(`G6：入口断裂（dm=${f.g6.dmDraftOpen} sent=${f.g6.sentMessage} reopen=${f.g6.sentReopen}）`);
    await closeApp(app, cdp);
  }

  /* ================= G7 负例（宏主 part / 损坏 Office 分列） ================= */
  {
    const root7 = path.join(outDir, 'root7');
    const projDir = path.join(outDir, 'proj7');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G7 项目\n', 'utf8');
    let { app, cdp } = await launchApp(root7, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root7, proj.id);
    // ① .pptm：明确拒绝（宏主 part）——就地原因含「宏」。
    await uploadViaPage(cdp, FIX.pptm, 'r69-宏主文档.pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.slideshow');
    await until(async () => { chipStatesSnapshot = await chipStates(cdp); return chipStatesSnapshot.some((c) => c.err === 'r69-宏主文档.pptm'); }, (v) => v, 30000, 'G7 pptm 失败芯片');
    f.g7.pptmReason = chipStatesSnapshot.find((c) => c.err === 'r69-宏主文档.pptm')?.text.includes('宏');
    // 服务端同样事实：直发 uploadOffice 应被拒。
    const direct = await pageCmd(cdp, 'attachment.uploadOffice', { conversationId: dbOf(root7).q('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', proj.id, 'room')[0].cid, filename: '宏.pptm', contentBase64: fs.readFileSync(FIX.pptm).toString('base64') });
    f.g7.pptmServerReject = direct.ok !== true && String(direct.error?.message).includes('宏');
    // ② 损坏 DOCX（主 part 合法、document.xml 非良构）：上传成功+提取失败警示（分列不吞）+本地视图如实。
    await uploadViaPage(cdp, FIX.brokenDocx, 'r69-损坏文档.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await waitChip(cdp, 'r69-损坏文档.docx', 'ready', 60000).then(() => { f.g7.brokenUploaded = true; }).catch(() => { f.g7.brokenUploaded = false; });
    await until(async () => { chipStatesSnapshot = await chipStates(cdp); return chipStatesSnapshot.some((c) => c.warn === 'r69-损坏文档.docx'); }, (v) => v, 30000, 'G7 提取失败警示芯片').then(() => { f.g7.brokenWarn = true; }).catch(() => { f.g7.brokenWarn = false; });
    if (f.g7.brokenUploaded) {
      await clickChipPreview(cdp, 'r69-损坏文档.docx');
      f.g7.brokenViewHonest = await until(() => cdp.tryEval(probe(`(() => { const e = document.querySelector('#hifi-root [data-zs-docx-error], #hifi-root [data-zs-preview-error], #hifi-root [data-zs-bytes-unavailable]'); if (e != null) return 'explicit-fail'; const v = document.querySelector('#hifi-root [data-zs-docx-view]'); if (v != null && v.getAttribute('data-zs-docx-state') === 'ready') return 'rendered'; return null; })()`)).catch(() => null), (v) => v != null, 60000, 'G7 损坏件视图终态').catch(() => null);
    }
    if (f.g7.pptmReason !== true || f.g7.pptmServerReject !== true) errs.push(`G7：宏拒绝断裂（chip=${f.g7.pptmReason} server=${f.g7.pptmServerReject}）`);
    if (f.g7.brokenUploaded !== true || f.g7.brokenWarn !== true || f.g7.brokenViewHonest == null) errs.push(`G7：损坏分列断裂（uploaded=${f.g7.brokenUploaded} warn=${f.g7.brokenWarn} view=${f.g7.brokenViewHonest}）`);
    await closeApp(app, cdp);
  }

  const realCalls = (() => { try { return dbOf(path.join(outDir, 'root1')).q('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } })();
  if (realCalls !== 0) errs.push('real_calls != 0');
  const result = { runId, ok: errs.length === 0, errs, checks: f, realCalls, shotsDir };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    ok: result.ok, errs: result.errs,
    g1: { firstOpen: f.g1.firstOpenText, empty: f.g1.emptyState && f.g1.emptySavedBytes === 0 && f.g1.emptySavedHash, bom: f.g1.bomReadStripped && f.g1.bomSavedIdentical, utf16: f.g1.utf16Decoded && f.g1.utf16SavedIdentical, reopen: f.g1.reopenAfterCloseAll, errInline: f.g1.exeInlineReason && f.g1.exeRetryBtn },
    g2: { natural: f.g2.natural, saved: f.g2.savedIdentical, gateSeparated: f.g2.gateNotUploadFailure !== false },
    g3: { pages: f.g3.pages, thumbs: f.g3.thumbsRendered, jump: f.g3.jumpPage, zoom: f.g3.zoom, savedIdentical: f.g3.savedIdentical },
    g4: { pdf: f.g4.pdfCanvas && f.g4.pdfFit && f.g4.pdfJump, docxPages: f.g4.docxPages, docxNoSecond: f.g4.docxNoSecondCopy, xlsxMode: f.g4.xlsxMode, xlsxTabs: f.g4.xlsxTabs, md: f.g4.mdTable, html: f.g4.htmlFrame },
    g5: { ppt: f.g5.treePpt, png: f.g5.treePng, md: f.g5.treeMd, xlsx: f.g5.treeXlsx, saved: f.g5.treeSavedIdentical },
    g6: { dm: f.g6.dmDraftOpen, sent: f.g6.sentMessage, reopen: f.g6.sentReopen },
    g7: { pptm: f.g7.pptmReason && f.g7.pptmServerReject, brokenUploaded: f.g7.brokenUploaded, brokenWarn: f.g7.brokenWarn, brokenView: f.g7.brokenViewHonest },
    realCalls,
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
