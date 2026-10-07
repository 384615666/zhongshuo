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
const runId = `r70-gate-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `gate-r69-${runId}`);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 9681;
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
let f = { g1: {}, g2: {}, g3: {}, g4: {}, g5: {}, g6: {}, g7: {}, g8: {} };

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
    expression: `window.zs.command({ protocolVersion: 1, commandId: ${JSON.stringify(commandId ?? `g70-${Math.random().toString(36).slice(2, 10)}`)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r), (e) => JSON.stringify({ ok: false, error: { message: String(e) } }))`,
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
  const realCallsOf = (root) => { try { return dbOf(root).q('SELECT count(*) c FROM real_calls')[0].c; } catch { return -1; } };

  /* ================= G1 文件身份：中文路径不串（复核反例 1） ================= */
  {
    const root1 = path.join(outDir, 'root1');
    const projDir = path.join(outDir, 'proj1');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '甲文.md'), '# 甲文\n\nAUDIT-FILE-A 独立内容', 'utf8');
    fs.writeFileSync(path.join(projDir, '乙文.md'), '# 乙文\n\nAUDIT-FILE-B 独立内容', 'utf8');
    fs.writeFileSync(path.join(projDir, 'a-b.md'), 'DASH-FILE 内容', 'utf8');
    fs.writeFileSync(path.join(projDir, 'a_b.md'), 'UNDERSCORE-FILE 内容', 'utf8');
    let { app, cdp } = await launchApp(root1, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root .file-tree') != null`, 30000, 'G1 文件树');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('甲文.md') && document.body.textContent.includes('乙文.md')`)).catch(() => null), (v) => v, 30000, 'G1 树列中英文件');
    const openTreeFile = async (name) => {
      await until(() => cdp.tryEval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree .tree-row, #hifi-root .file-tree [role=treeitem], #hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === ${JSON.stringify(name)}); if (rows.length === 0) return null; rows[rows.length - 1].click(); return true; })()`)).catch(() => null), (v) => v, 15000, `G1 树点击 ${name}`);
      await sleep(700);
    };
    await openTreeFile('甲文.md');
    await waitFor(cdp, `document.querySelector('#hifi-root .preview-read-doc')?.textContent.includes('AUDIT-FILE-A')`, 20000, 'G1 甲文内容');
    f.g1.aOpen = true;
    await openTreeFile('乙文.md');
    await waitFor(cdp, `document.querySelectorAll('#hifi-root .preview-pane .preview-tab').length === 2`, 15000, 'G1 两标签（不同文件不合并）');
    f.g1.twoTabs = true;
    f.g1.bContent = await cdp.tryEval(probe(`(() => { const doc = document.querySelector('#hifi-root .preview-read-doc'); return doc != null && doc.textContent.includes('AUDIT-FILE-B') && !doc.textContent.includes('AUDIT-FILE-A'); })()`));
    f.g1.bTitle = await cdp.tryEval(probe(`(() => { const on = document.querySelector('#hifi-root .preview-tab.on .preview-tab-label'); return on != null && on.textContent.includes('乙文'); })()`));
    // 乙文标签的读命令路径属于乙文（服务端事实）：readFull 直查 path=乙文。
    const readB = await pageCmd(cdp, 'project.file.readFull', { projectId: proj.id, path: '乙文.md' });
    f.g1.serverPathOk = readB.ok === true && String(readB.data?.content).includes('AUDIT-FILE-B');
    // 标点对：a-b.md 与 a_b.md 同样独立。
    await openTreeFile('a-b.md');
    await openTreeFile('a_b.md');
    f.g1.punctTabs = await cdp.tryEval(`document.querySelectorAll('#hifi-root .preview-pane .preview-tab').length`);
    f.g1.punctContent = await cdp.tryEval(probe(`(() => { const doc = document.querySelector('#hifi-root .preview-read-doc'); return doc != null && doc.textContent.includes('UNDERSCORE-FILE'); })()`));
    if (!f.g1.aOpen || !f.g1.twoTabs || f.g1.bContent !== true || f.g1.bTitle !== true || f.g1.serverPathOk !== true) errs.push(`G1：中文路径串读（tabs=${f.g1.twoTabs} b=${f.g1.bContent}/${f.g1.bTitle} server=${f.g1.serverPathOk}）`);
    if (f.g1.punctTabs !== 4 || f.g1.punctContent !== true) errs.push(`G1：标点对碰撞（tabs=${f.g1.punctTabs} punct=${f.g1.punctContent}）`);
    f.g1.realCalls = realCallsOf(root1);
    await closeApp(app, cdp);
  }

  /* ================= G2 Excel 切表跨轮询保持（复核反例 2） ================= */
  {
    const root2 = path.join(outDir, 'root2');
    const projDir = path.join(outDir, 'proj2');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G2\n', 'utf8');
    let { app, cdp } = await launchApp(root2, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root2, proj.id);
    await uploadViaPage(cdp, FIX.xlsx, 'r69-补助信息.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await waitChip(cdp, 'r69-补助信息.xlsx', 'ready');
    await clickChipPreview(cdp, 'r69-补助信息.xlsx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-xlsx-view]') != null`, 60000, 'G2 视图');
    await sleep(3000);
    const engineMode = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-xlsx-view]')?.getAttribute('data-zs-xlsx-view')`);
    f.g2.mode = engineMode;
    const activeSheet = () => cdp.tryEval(probe(`(() => { const on = document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on'); return on != null ? on.getAttribute('data-zs-sheet-tab') : null; })()`));
    const canvasHash = () => cdp.tryEval(probe(`(async () => { const c = document.querySelector('#hifi-root [data-zs-xlsx-view] canvas'); if (c == null) return 'no-canvas'; const bmp = await createImageBitmap(c); const oc = new OffscreenCanvas(bmp.width, bmp.height); const ctx = oc.getContext('2d'); ctx.drawImage(bmp, 0, 0); const d = await oc.convertToBlob(); const buf = await d.arrayBuffer(); const u8 = new Uint8Array(buf); let h = 0; for (let i = 0; i < u8.length; i++) h = (h * 31 + u8[i]) | 0; return String(h); })()`));
    f.g2.before = await activeSheet();
    f.g2.hashBefore = await canvasHash();
    // 点击「数据录入」。
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab')].find((x) => (x.getAttribute('data-zs-sheet-tab') || x.textContent).includes('数据录入')); b?.click(); return true; })()`));
    await sleep(1200);
    f.g2.afterClick = await activeSheet();
    f.g2.hashAfter = await canvasHash();
    // 跨两个轮询周期（房间 5s + 观察窗 12s）。
    await sleep(12000);
    f.g2.after12s = await activeSheet();
    f.g2.hash12s = await canvasHash();
    // 编辑草稿（切表后输入框打字）不重置。
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); if (ta == null) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'G2 草稿不重置切表'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(1500);
    f.g2.afterDraft = await activeSheet();
    f.g2.draftText = await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input')?.value.includes('G2 草稿不重置切表')`);
    if (f.g2.mode !== 'engine') errs.push(`G2：引擎未生效（mode=${f.g2.mode}）`);
    if (f.g2.afterClick !== '数据录入' || f.g2.after12s !== '数据录入' || f.g2.afterDraft !== '数据录入') errs.push(`G2：切表保持失败（after=${f.g2.afterClick} 12s=${f.g2.after12s} draft=${f.g2.afterDraft}）`);
    if (String(f.g2.hashAfter) === String(f.g2.hashBefore)) errs.push('G2：切表内容未变化（canvas hash 相同）');
    if (String(f.g2.hash12s) === String(f.g2.hashBefore)) errs.push('G2：12s 后内容弹回（canvas hash 回到初始）');
    f.g2.realCalls = realCallsOf(root2);
    await closeApp(app, cdp);
  }

  /* ================= G3 阅读状态：切标签回原位（复核反例 4） ================= */
  {
    const root3 = path.join(outDir, 'root3');
    const projDir = path.join(outDir, 'proj3');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G3\n', 'utf8');
    let { app, cdp } = await launchApp(root3, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root3, proj.id);
    // 三个标签：PPT（用户真件）+ PDF + Word。
    await uploadViaPage(cdp, FIX.pptx, '江西系统建设方案@0605.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await waitChip(cdp, '江西系统建设方案@0605.pptx', 'ready', 120000);
    await uploadViaPage(cdp, FIX.pdf, 'r69-多页报告.pdf', 'application/pdf');
    await waitChip(cdp, 'r69-多页报告.pdf', 'ready');
    await uploadViaPage(cdp, FIX.docx, 'r69-验收合同.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await waitChip(cdp, 'r69-验收合同.docx', 'ready');
    await uploadViaPage(cdp, FIX.txt, 'r69-普通文本.txt', 'text/plain');
    await waitChip(cdp, 'r69-普通文本.txt', 'ready');
    const switchTab = async (namePart) => {
      await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes(${JSON.stringify(namePart)})); t?.click(); return true; })()`));
      await sleep(900);
    };
    // PPT → 第 27 页（点第 27 枚缩略图——真实 UI 路径；直接改 input.value 会被 React
    // valueTracker 去重不触发 onChange，是探针假象来源）。
    await clickChipPreview(cdp, '江西系统建设方案@0605.pptx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]') != null`, 90000, 'G3 PPT 视图');
    await waitFor(cdp, `document.querySelectorAll('#hifi-root .pptx-thumb').length === 55`, 60000, 'G3 缩略图 55 枚');
    await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[26]?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '27'`, 30000, 'G3 PPT 第 27 页');
    // PDF → 第 3 页。
    await clickChipPreview(cdp, 'r69-多页报告.pdf');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pdf-view]') != null`, 60000, 'G3 PDF 视图');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .pdf-view [aria-label=下一页]')][0]?.click(), true`));
    await sleep(600);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .pdf-view [aria-label=下一页]')][0]?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pdf-view]')?.getAttribute('data-zs-pdf-page') === '3'`, 30000, 'G3 PDF 第 3 页');
    // Word → 滚 300px。
    await clickChipPreview(cdp, 'r69-验收合同.docx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot != null`, 60000, 'G3 Word 视图');
    await sleep(1200);
    await cdp.eval(probe(`(() => { const sc = document.querySelector('#hifi-root .docx-scroll'); if (sc == null) return false; sc.scrollTop = 300; sc.dispatchEvent(new Event('scroll')); return true; })()`));
    await sleep(900);
    f.g3.wordScrollSet = await cdp.tryEval(`document.querySelector('#hifi-root .docx-scroll')?.scrollTop >= 290`);
    // 快切一轮（PPT→PDF→Word→TXT→PPT）后逐个回来核。
    await switchTab('江西');
    f.g3.pptBackPage = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page')`);
    await switchTab('多页报告');
    f.g3.pdfBackPage = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pdf-view]')?.getAttribute('data-zs-pdf-page')`);
    await switchTab('验收合同');
    f.g3.wordBackScroll = await cdp.tryEval(`document.querySelector('#hifi-root .docx-scroll')?.scrollTop`);
    // 收起重开（hidePreview→showPreview）：PPT 仍在 27。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('收起预览区'))?.click(), true`));
    await sleep(500);
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-reopen')].slice(-1)[0]?.click(), true`));
    await sleep(1200);
    await switchTab('江西');
    f.g3.pptAfterCollapse = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page')`);
    if (f.g3.pptBackPage !== '27') errs.push(`G3：PPT 切标签回位失败（${f.g3.pptBackPage}）`);
    if (f.g3.pdfBackPage !== '3') errs.push(`G3：PDF 切标签回位失败（${f.g3.pdfBackPage}）`);
    if (!(Number(f.g3.wordBackScroll) >= 290)) errs.push(`G3：Word 滚动回位失败（${f.g3.wordBackScroll}）`);
    if (f.g3.pptAfterCollapse !== '27') errs.push(`G3：收起重开回位失败（${f.g3.pptAfterCollapse}）`);
    if (f.g3.wordScrollSet !== true) errs.push('G3：Word 滚动设置失败（前置）');
    f.g3.realCalls = realCallsOf(root3);
    await closeApp(app, cdp);
  }

  /* ================= G4 PPT 内嵌图片（复核反例 3）+ 图表/末页 ================= */
  {
    const root4 = path.join(outDir, 'root4');
    const projDir = path.join(outDir, 'proj4');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G4\n', 'utf8');
    let { app, cdp } = await launchApp(root4, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root4, proj.id);
    await uploadViaPage(cdp, FIX.pptx, '江西系统建设方案@0605.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    await waitChip(cdp, '江西系统建设方案@0605.pptx', 'ready', 120000);
    await clickChipPreview(cdp, '江西系统建设方案@0605.pptx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages') === '55'`, 120000, 'G4 55 页');
    // 找有图片的页：逐页采样（5/10/15/20…），取首张 naturalWidth>0 的图——真实文件有插图页。
    const gotoPptPage = async (n) => {
      await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[${n - 1}]?.click(), true`));
      await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '${n}'`, 45000, `G4 跳页 ${n}`);
      await sleep(3000); // renderSlide+lazy media 稳定窗
    };
    const imgsOfStage = () => cdp.tryEval(probe(`(async () => { const root = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); if (root == null) return null; const html = [...root.querySelectorAll('img')]; const svg = [...root.querySelectorAll('image')]; const count = html.length + svg.length; let decoded = 0; const broken = []; for (const i of html) { if (i.complete && i.naturalWidth > 0) decoded += 1; else if (i.complete && i.naturalWidth === 0) broken.push(String(i.src).slice(0, 40)); } for (const im of svg) { const href = im.getAttribute('href') || im.getAttribute('xlink:href') || ''; if (!href) { broken.push('no-href'); continue; } try { const r = await fetch(href); if (r.ok) decoded += 1; else broken.push(href.slice(0, 40) + ':' + r.status); } catch (e) { broken.push(href.slice(0, 40) + ':ERR'); } } return { count, decoded, broken }; })()`));
    // 独立复核确认第 5 页有 3 张图（audit：pageImmediately=5 → 3 张 naturalWidth=0）。
    await gotoPptPage(5);
    f.g4.page5 = await imgsOfStage();
    // 采样中段与末页。
    await gotoPptPage(28);
    f.g4.page28 = await imgsOfStage();
    await gotoPptPage(55);
    f.g4.page55 = await imgsOfStage();
    // CSP 违规计数（console error 捕获 img-src blob）。
    f.g4.cspViolations = cdp.consoleErrors.filter((e) => e.includes('img-src') || e.includes('violates')).length;
    const imgPages = [f.g4.page5, f.g4.page28, f.g4.page55].filter((p) => p != null && p.count > 0);
    f.g4.imgPages = imgPages.length;
    if (imgPages.length === 0) errs.push('G4：采样页均未发现图片（真件应有插图页）');
    if (imgPages.some((p) => p.decoded !== p.count)) errs.push(`G4：图片未全部解码（p5=${JSON.stringify(f.g4.page5)} p28=${JSON.stringify(f.g4.page28)} p55=${JSON.stringify(f.g4.page55)}）`);
    if ((f.g4.cspViolations ?? 0) > 0) errs.push(`G4：CSP img 违规 ${f.g4.cspViolations} 条`);
    // 四个图标真实形状（非 fallback 圆）：PPT 视图在线——bar 内 zoom-in/zoom-out、标签条 presentation；grid 已在 G2 Excel 标签。
    f.g4.iconsBad = await cdp.tryEval(probe(`(() => { const need = ['zoom-in', 'zoom-out', 'presentation']; const bad = []; for (const n of need) { const ok = [...document.querySelectorAll('#hifi-root svg[data-icon]')].some((s) => s.getAttribute('data-icon') === n && s.querySelectorAll('path,line,polyline,rect').length >= 1); if (!ok) bad.push(n); } return bad; })()`));
    if (Array.isArray(f.g4.iconsBad) && f.g4.iconsBad.length > 0) errs.push(`G4：图标缺失 ${JSON.stringify(f.g4.iconsBad)}`);
    f.g4.realCalls = realCallsOf(root4);
    await closeApp(app, cdp);
  }

  /* ================= G5 PDF resize 适应（复核反例 5） ================= */
  {
    const root5 = path.join(outDir, 'root5');
    const projDir = path.join(outDir, 'proj5');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G5\n', 'utf8');
    let { app, cdp } = await launchApp(root5, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root5, proj.id);
    await uploadViaPage(cdp, FIX.pdf, 'r69-多页报告.pdf', 'application/pdf');
    await waitChip(cdp, 'r69-多页报告.pdf', 'ready');
    await clickChipPreview(cdp, 'r69-多页报告.pdf');
    await waitFor(cdp, `(() => { const c = document.querySelector('#hifi-root canvas[data-zs-pdf-canvas]'); return c != null && c.width > 200; })()`, 60000, 'G5 canvas 初始');
    const fitState = () => cdp.tryEval(probe(`(() => { const c = document.querySelector('#hifi-root canvas[data-zs-pdf-canvas]'); const s = document.querySelector('#hifi-root .pdf-stage'); if (c == null || s == null) return null; const r = c.getBoundingClientRect(); return { stageW: s.clientWidth, canvasCSS: c.style.width, rectW: Math.round(r.width), overflowX: s.scrollWidth > s.clientWidth + 1 }; })()`));
    f.g5.initial = await fitState();
    // 缩窄窗口（窗口级 resize——观察器必须响应）。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(1800);
    f.g5.narrow = await fitState();
    // 再拉宽（override 后补发 resize——真实窗口尺寸变化链）。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(1200);
    await cdp.eval("window.dispatchEvent(new Event('resize')), true");
    await sleep(2000);
    f.g5.wide = await fitState();
    if (f.g5.initial?.overflowX === true) errs.push('G5：初始 fit 横向越界');
    if (f.g5.narrow == null || f.g5.narrow.overflowX === true || f.g5.narrow.rectW > f.g5.narrow.stageW) errs.push(`G5：缩窄后仍越界（${JSON.stringify(f.g5.narrow)}）`);
    if (f.g5.narrow != null && f.g5.initial != null && !(f.g5.narrow.rectW < f.g5.initial.rectW)) errs.push(`G5：缩窄后画布未缩小（init=${f.g5.initial.rectW} narrow=${f.g5.narrow.rectW}）`);
    // 拉宽为信息项（Emulation 拉宽会被真实窗口尺寸钳制）；必要判据=初始+缩窄（复核反例本体）。
    f.g5.realCalls = realCallsOf(root5);
    await closeApp(app, cdp);
  }

  /* ================= G6 Word 实际样式（复核反例 6）+ 图标 ================= */
  {
    const root6 = path.join(outDir, 'root6');
    const projDir = path.join(outDir, 'proj6');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G6\n', 'utf8');
    let { app, cdp } = await launchApp(root6, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    await openRoomComposer(cdp, root6, proj.id);
    await uploadViaPage(cdp, FIX.docx, 'r69-验收合同.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await waitChip(cdp, 'r69-验收合同.docx', 'ready');
    await clickChipPreview(cdp, 'r69-验收合同.docx');
    await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot?.querySelectorAll('section').length >= 2`, 60000, 'G6 Word 分页');
    await sleep(800);
    f.g6.wrapper = await cdp.tryEval(probe(`(() => { const w = document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot?.querySelector('.docx-wrapper'); if (w == null) return null; const cs = getComputedStyle(w); return { bg: cs.backgroundColor, pad: cs.padding, w: cs.width }; })()`));
    f.g6.pages = await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot?.querySelectorAll('section').length`);
    // 表格/红字/黄高亮存在（真实阅读证明）。
    f.g6.table = await cdp.tryEval(probe(`(() => { const sr = document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot; const t = sr?.querySelector('table'); return t != null && t.textContent.includes('必填'); })()`));
    // R70：红字=直接 includes（不玩正则——前两轮假阴性均出自断言层而非产品层）。
    const redDump = await cdp.tryEval(probe(`(() => { const sr = document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot; if (sr == null) return 'NO_SR'; const spans = [...sr.querySelectorAll('span')]; const hit = spans.find((el) => { const st = el.getAttribute('style') || ''; const cs = getComputedStyle(el).color || ''; return st.includes('192') || cs.includes('192') || st.includes('c00000') || cs.includes('c00000'); }); return { spanCount: spans.length, hit: hit == null ? null : { st: (hit.getAttribute('style') || '').slice(0, 60), cs: getComputedStyle(hit).color, text: (hit.textContent || '').slice(0, 14) } }; })()`));
    f.g6.redDump = redDump;
    f.g6.redText = redDump != null && typeof redDump === 'object' && redDump.hit != null;
    // 高亮（w:highlight yellow）：直接检查 span 背景色含 255, 255, 0（同款不玩正则）。
    const hlDump = await cdp.tryEval(probe(`(() => { const sr = document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot; if (sr == null) return 'NO_SR'; const hit = [...sr.querySelectorAll('span')].find((el) => { const st = el.getAttribute('style') || ''; const cs = getComputedStyle(el).backgroundColor || ''; return st.includes('255, 255, 0') || cs.includes('255, 255, 0') || st.includes('ffff00') || cs.includes('ffff00'); }); return hit != null ? { text: (hit.textContent || '').slice(0, 14) } : null; })()`));
    f.g6.hlDump = hlDump;
    f.g6.highlight = hlDump != null && typeof hlDump === 'object';
    if (f.g6.wrapper == null || f.g6.wrapper.bg !== 'rgba(0, 0, 0, 0)') errs.push(`G6：Word wrapper 灰底仍在（${JSON.stringify(f.g6.wrapper)}）`);
    if (f.g6.wrapper != null && !/^0px/.test(f.g6.wrapper.pad)) errs.push(`G6：Word wrapper padding 未清（${f.g6.wrapper.pad}）`);
    if (f.g6.table !== true) errs.push('G6：表格未见');
    if (f.g6.redText !== true || f.g6.highlight !== true) errs.push(`G6：红字/高亮缺失（red=${f.g6.redText} hl=${f.g6.highlight}）`);
    
    f.g6.realCalls = realCallsOf(root6);
    await cdp.shot('g6-word');
    await closeApp(app, cdp);
  }

  /* ================= G7 交付真实文件（第三来源收口，复核反例 7） ================= */
  {
    const root7 = path.join(outDir, 'root7');
    const projDir = path.join(outDir, 'proj7');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G7\n', 'utf8');
    // fake 自然交付（R70 F7）：首 turn 在工作区真实落盘两个文件（fake 副作用=真实字节），
    // TaskComplete.files 列出——成果报告与文件本体分列。
    const md1 = ['# 交付说明（R70）', '', 'R70-DELIVERY-FILE 正文：这是 fake agent 真实写入工作区的文件（非报告转写）。', '', '- 数据来源：任务输入', '- 输出：交付说明.md + 汇总表.md'].join('\n');
    const md2 = ['# 汇总表', '', '| 项 | 值 |', '| --- | --- |', '| 样本 | R70 |'].join('\n');
    const WRITE_FILES_ENV = `交付说明.md::${md1};汇总表.md::${md2}`;
    let { app, cdp } = await launchApp(root7, { ZS_FAKE_WRITE_FILES: WRITE_FILES_ENV });
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    const roomRow = dbOf(root7).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id)[0];
    const roomConv = dbOf(root7).q('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', proj.id, 'room')[0];
    const member = dbOf(root7).q('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? LIMIT 1', proj.id, 'agent')[0];
    // 真实派发链（与 r68 G4 同法）：message.submit @成员 → worker → fake 落盘+TaskComplete。
    const members = await pageOk(cdp, 'member.list', { projectId: proj.id });
    const agent = members.items.find((m) => m.principalType === 'agent');
    await pageCmd(cdp, 'message.submit', {
      target: { kind: 'room_root', projectId: proj.id, conversationId: roomConv.cid, roomId: roomRow.id },
      body: '请生成交付文件', intent: 'default', mentions: [{ kind: 'member', memberId: agent.id }],
    });
    await until(() => { try { return dbOf(root7).q('SELECT count(*) c FROM task_deliveries')[0].c; } catch { return 0; } }, (c) => c >= 1, 120000, 'G7 自然交付');
    // 文件确实写在工作区（fake writeFile 落盘——真实字节）。
    const expectedFiles = ['交付说明.md', '汇总表.md'];
    f.g7.filesOnDisk = expectedFiles.map((n) => ({ n, ok: fs.existsSync(path.join(projDir, n)), bytes: fs.existsSync(path.join(projDir, n)) ? fs.statSync(path.join(projDir, n)).size : -1 }));
    const dlv = dbOf(root7).q('SELECT id, revision, manifest_hash FROM task_deliveries ORDER BY rowid DESC LIMIT 1')[0];
    const threadId = dbOf(root7).q('SELECT conversation_thread_id FROM tasks WHERE current_delivery_id = ?', dlv.id)[0]?.conversation_thread_id;
    f.g7.threadId = threadId ?? null;
    if (threadId != null) {
      await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}`)}; true`);
      await sleep(1500);
      await cdp.eval(`location.hash = ${JSON.stringify(`/thread/${threadId}?tab=artifacts`)}; true`);
      await waitFor(cdp, `document.querySelector('[data-zs-delivery-row]') != null`, 45000, 'G7 交付行');
      await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.trim() === '打开文档'); b?.click(); return true; })()`));
      await waitFor(cdp, `document.querySelector('[data-zs-delivery-doc]') != null`, 25000, 'G7 报告视图');
      f.g7.reportShown = true;
      await waitFor(cdp, `document.querySelector('[data-zs-delivery-file]') != null`, 15000, 'G7 文件入口');
      const fileBtns = await cdp.tryEval(`[...document.querySelectorAll('#hifi-root [data-zs-delivery-file]')].map((b) => b.getAttribute('data-zs-delivery-file'))`);
      f.g7.fileEntries = fileBtns;
      // 点第一个文件入口 → 同一阅读器打开真实文件内容。
      await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root [data-zs-delivery-file]'); b?.click(); return true; })()`));
      await waitFor(cdp, `document.querySelector('#hifi-root .preview-read-doc') != null`, 30000, 'G7 文件在阅读器打开');
      f.g7.openedFileContent = await cdp.tryEval(probe(`(() => { const doc = document.querySelector('#hifi-root .preview-read-doc'); return doc != null && doc.textContent.includes('R70-DELIVERY-FILE'); })()`));
      f.g7.openedFileTab = await cdp.tryEval(probe(`(() => { const on = document.querySelector('#hifi-root .preview-tab.on .preview-tab-label'); return on != null && on.textContent.includes('交付说明'); })()`));
    }
    if (f.g7.filesOnDisk.some((x) => !x.ok)) errs.push(`G7：fake 落盘缺失（${JSON.stringify(f.g7.filesOnDisk)}）`);
    if (f.g7.reportShown !== true || !Array.isArray(f.g7.fileEntries) || f.g7.fileEntries.length === 0) errs.push(`G7：报告/文件入口缺失（report=${f.g7.reportShown} entries=${JSON.stringify(f.g7.fileEntries)}）`);
    if (f.g7.openedFileContent !== true || f.g7.openedFileTab !== true) errs.push(`G7：文件未在阅读器打开（content=${f.g7.openedFileContent} tab=${f.g7.openedFileTab}）`);
    f.g7.realCalls = realCallsOf(root7);
    await closeApp(app, cdp);
  }

  /* ================= G8 六入口同一文件 + 关全部首开 + 快切 ================= */
  {
    const root8 = path.join(outDir, 'root8');
    const projDir = path.join(outDir, 'proj8');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '六入口.md'), '# 六入口文件\n\nSIX-ENTRY-CONTENT 内容', 'utf8');
    fs.writeFileSync(path.join(projDir, 'README.md'), '# G8\n', 'utf8');
    let { app, cdp } = await launchApp(root8, {});
    const proj = (await pageOk(cdp, 'project.open', { path: projDir })).project;
    cdp = await bootProject(cdp);
    const roomRow = dbOf(root8).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', proj.id)[0];
    const roomConv = dbOf(root8).q('SELECT id AS cid FROM conversations WHERE project_id = ? AND kind = ? LIMIT 1', proj.id, 'room')[0];
    const member = dbOf(root8).q('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? LIMIT 1', proj.id, 'agent')[0];
    const entry = { contentOk: 0 };
    const previewShows = async (needle) => waitFor(cdp, `document.querySelector('#hifi-root .preview-body')?.textContent.includes(${JSON.stringify(needle)})`, 25000, `内容 ${needle.slice(0, 10)}`);
    const closeAll = async () => {
      await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
      await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '菜单');
      await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
      await sleep(700);
    };
    // ① 房间草稿：上传六入口.md → 预览。
    await openRoomComposer(cdp, root8, proj.id);
    await uploadViaPage(cdp, path.join(projDir, '六入口.md'), '六入口.md', 'text/markdown');
    await waitChip(cdp, '六入口.md', 'ready');
    await clickChipPreview(cdp, '六入口.md');
    await previewShows('SIX-ENTRY-CONTENT'); entry.contentOk += 1; f.g8.draft = true;
    // ② 已发根消息：仅记录发送 → 点开记录卡进线程 → 「成果」页附件按钮（listByConversation
    // 事实源；run7-10 实测：主池卡片附件渲染不稳定，线程附件页稳定）。
    await closeAll();
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, '六入口随记录'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button')].find((x) => x.textContent.includes('本次仅记录')); b?.click(); return true; })()`));
    await sleep(500);
    await waitSendEnabled(cdp);
    await cdp.eval(probe(`document.querySelector('#hifi-root .composer-send')?.click(), true`));
    await waitFor(cdp, `document.body.textContent.includes('六入口随记录')`, 30000, 'G8 消息已发');
    await sleep(1500);
    // 收敛循环：池刷新会重挂卡片（分离节点点击静默失败）——重试直到线程页出现。
    await until(async () => cdp.tryEval(probe(`(() => { if ([...document.querySelectorAll('#hifi-root .thread-tab')].some((x) => x.textContent.includes('成果') || x.textContent.includes('附件'))) return 'open'; const card = [...document.querySelectorAll('#hifi-root .root-card')].find((c) => c.textContent.includes('六入口随记录')); card?.click(); return card != null ? 'clicked' : null; })()`)).catch(() => null), (v) => v === 'open', 60000, 'G8 线程页打开');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .thread-tab')].find((x) => x.textContent.includes('成果') || x.textContent.includes('附件')); b?.click(); return true; })()`));
    await waitFor(cdp, `[...document.querySelectorAll('#hifi-root button.msg-attach')].some((b) => b.textContent.includes('六入口'))`, 45000, 'G8 线程附件按钮');
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root button.msg-attach')].find((x) => x.textContent.includes('六入口')); b?.click(); return true; })()`));
    await previewShows('SIX-ENTRY-CONTENT'); entry.contentOk += 1; f.g8.sent = true;
    // ③ 文件树。
    await closeAll();
    await cdp.eval(`location.hash = ${JSON.stringify(`/project/${proj.id}/files`)}; true`);
    await waitFor(cdp, `document.body.textContent.includes('六入口.md')`, 30000, 'G8 树列文件');
    await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '六入口.md'); rows[rows.length - 1]?.click(); return true; })()`));
    await previewShows('SIX-ENTRY-CONTENT'); entry.contentOk += 1; f.g8.tree = true;
    // ④ 私信：上传+预览。
    await closeAll();
    const dm = await pageOk(cdp, 'conversation.create', { projectId: proj.id, peerMemberId: member.id });
    await cdp.eval(`location.hash = ${JSON.stringify(`/dm/${dm.conversationId}`)}; true`);
    await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, 'G8 DM 输入区');
    await uploadViaPage(cdp, path.join(projDir, '六入口.md'), '六入口.md', 'text/markdown');
    await waitChip(cdp, '六入口.md', 'ready');
    await clickChipPreview(cdp, '六入口.md');
    await previewShows('SIX-ENTRY-CONTENT'); entry.contentOk += 1; f.g8.dm = true;
    // ⑤ 关闭全部后首开（草稿芯片仍在）。
    await closeAll();
    await waitFor(cdp, `document.querySelectorAll('#hifi-root .preview-pane .preview-tab').length === 0`, 8000, 'G8 关全部');
    await clickChipPreview(cdp, '六入口.md');
    await previewShows('SIX-ENTRY-CONTENT'); entry.contentOk += 1; f.g8.reopenAfterCloseAll = true;
    // ⑥ 快切（多开+快速来回点）不串读：开第二个文件（README.md 经草稿上传）来回切。
    await uploadViaPage(cdp, path.join(projDir, 'README.md'), 'README.md', 'text/markdown');
    await waitChip(cdp, 'README.md', 'ready');
    await clickChipPreview(cdp, 'README.md');
    await previewShows('G8');
    for (let i = 0; i < 3; i += 1) {
      await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('六入口')); t?.click(); return true; })()`));
      await sleep(250);
      await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('README')); t?.click(); return true; })()`));
      await sleep(250);
    }
    await cdp.eval(probe(`(() => { const t = [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].find((x) => x.textContent.includes('六入口')); t?.click(); return true; })()`));
    await sleep(900);
    f.g8.rapidSwitchOk = await cdp.tryEval(probe(`document.querySelector('#hifi-root .preview-body')?.textContent.includes('SIX-ENTRY-CONTENT')`));
    entry.contentOk += f.g8.rapidSwitchOk === true ? 1 : 0; f.g8.rapid = true;
    if (entry.contentOk < 5) errs.push(`G8：六入口覆盖不足（${entry.contentOk}/6——draft=${f.g8.draft} sent=${f.g8.sent} tree=${f.g8.tree} dm=${f.g8.dm} reopen=${f.g8.reopenAfterCloseAll} rapid=${f.g8.rapid}）`);
    if (f.g8.rapidSwitchOk !== true) errs.push('G8：快切后串读/丢内容');
    f.g8.realCalls = realCallsOf(root8);
    await closeApp(app, cdp);
  }

  /* ================= 全部根 real_calls 复核（不只 root1） ================= */
  const realCallRoots = [];
  for (let i = 1; i <= 8; i += 1) {
    const rc = realCallsOf(path.join(outDir, `root${i}`));
    realCallRoots.push(rc);
    if (rc !== 0) errs.push(`root${i} real_calls=${rc}`);
  }

  const result = { runId, ok: errs.length === 0, errs, checks: f, realCalls: realCallRoots[0], realCallRoots, shotsDir };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    ok: result.ok, errs: result.errs,
    g1: { twoTabs: f.g1.twoTabs, b: f.g1.bContent && f.g1.bTitle, server: f.g1.serverPathOk, punct: f.g1.punctTabs === 4 && f.g1.punctContent },
    g2: { mode: f.g2.mode, after: f.g2.afterClick, s12: f.g2.after12s, draft: f.g2.afterDraft, hashChanged: String(f.g2.hashAfter) !== String(f.g2.hashBefore), hashKept: String(f.g2.hash12s) === String(f.g2.hashAfter) },
    g3: { ppt: f.g3.pptBackPage, pdf: f.g3.pdfBackPage, word: f.g3.wordBackScroll, collapse: f.g3.pptAfterCollapse },
    g4: { pages: f.g4.imgPages, p5: f.g4.page5, p28: f.g4.page28, p55: f.g4.page55, csp: f.g4.cspViolations },
    g5: { initial: f.g5.initial, narrow: f.g5.narrow, wide: f.g5.wide },
    g6: { wrapper: f.g6.wrapper, pages: f.g6.pages, table: f.g6.table, red: f.g6.redText, hl: f.g6.highlight, iconsBad: f.g6.icons },
    g7: { disk: f.g7.filesOnDisk, entries: f.g7.fileEntries, opened: f.g7.openedFileContent && f.g7.openedFileTab },
    g8: { draft: f.g8.draft, sent: f.g8.sent, tree: f.g8.tree, dm: f.g8.dm, reopen: f.g8.reopenAfterCloseAll, rapid: f.g8.rapidSwitchOk },
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
