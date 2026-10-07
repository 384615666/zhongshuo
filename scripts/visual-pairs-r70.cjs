#!/usr/bin/env node
/**
 * R70 视觉成对复核：五种参考类型（PPT/PDF/Word/Excel/MD）+ TXT/PNG——与参考图**同视口同页**
 * 截取，并记录**实际预览区域 rect + DPR + 文件/页码**（整窗尺寸≠预览区尺寸——R70 复核要求
 * 两者分列）。产物 pairs.json + ours-*.png + meta（供视觉子代理逐对判定）。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const runId = `r70-vis-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `visual-gate-r70-${runId}`);
fs.mkdirSync(outDir, { recursive: true });
const PORT = 9691;
const W = 2560, H = 1380; // 与参考图同视口
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)?.slice(0, 200)}）`);
    await sleep(250);
  }
}
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; } });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 90_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 200)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
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
let __appOut = { v: '' };

const fx = path.join(outDir, 'fixtures');
fs.mkdirSync(fx, { recursive: true });
const USER_PPT = 'C:/Users/user/Downloads/江西系统建设方案@0605.pptx';
const USER_PNG = 'D:/zhongshuo/dist/desktop/review-r68-preview-audit-20261007/r69-user-image.png';
const FIX = {
  pptx: path.join(fx, '江西系统建设方案@0605.pptx'),
  png: path.join(fx, 'canvas-image.png'),
  txt: path.join(fx, 'r69-普通文本.txt'),
  pdf: path.join(repo, 'dist/desktop/r69-fixtures/r69-多页报告.pdf'),
  docx: path.join(repo, 'dist/desktop/r69-fixtures/r69-验收合同.docx'),
  xlsx: path.join(repo, 'dist/desktop/r69-fixtures/r69-补助信息.xlsx'),
  md: path.join(repo, 'dist/desktop/r69-fixtures/r69-说明.md'),
};
fs.copyFileSync(USER_PPT, FIX.pptx);
fs.copyFileSync(USER_PNG, FIX.png);
fs.writeFileSync(FIX.txt, 'R69 普通文本验收：第一行内容。\n第二行内容。\n第三行：视觉成对复核用。', 'utf8');

const REF_DIR = 'D:/zhongshuo/dist/desktop/review-r68-preview-audit-20261007';
/** 每场景：同页/同表状态 + 视图就绪 + 页内稳定等待。 */
const scenes = [
  { name: 'ppt', ref: path.join(REF_DIR, 'reference-ppt.png'), file: FIX.pptx, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ready: `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages') === '55'`,
    // 参考图=第 1 页主舞台；同页对照。图文页单独帧（页 5）作为内容完整性证据。
    settle: async (cdp) => { await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[0]?.click(), true`)); await sleep(2800); },
    extraShots: [{ name: 'ppt-media-p5', page: 5 }] },
  { name: 'pdf', ref: path.join(REF_DIR, 'reference-pdf.png'), file: FIX.pdf, mime: 'application/pdf',
    ready: `(() => { const c = document.querySelector('#hifi-root canvas[data-zs-pdf-canvas]'); return c != null && c.width > 200; })()`,
    settle: async (cdp) => { await sleep(1600); }, extraShots: [] },
  { name: 'word', ref: path.join(REF_DIR, 'reference-word.png'), file: FIX.docx, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ready: `document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot?.querySelectorAll('section').length >= 2`,
    settle: async (cdp) => { await sleep(1400); const t = await cdp.tryEval(probe(`(() => { const sr = document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot; const tb = sr?.querySelector('table'); if (tb != null) { tb.scrollIntoView({ block: 'center' }); return 'table'; } return 'no-table'; })()`)); void t; await sleep(1000); }, extraShots: [] },
  { name: 'excel', ref: path.join(REF_DIR, 'reference-excel.png'), file: FIX.xlsx, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ready: `document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]') != null`,
    settle: async (cdp) => { await sleep(3800); }, extraShots: [] },
  { name: 'md', ref: path.join(REF_DIR, 'reference-md.png'), file: FIX.md, mime: 'text/markdown',
    ready: `document.querySelector('#hifi-root .preview-read-doc') != null`,
    settle: async (cdp) => { await sleep(1000); }, extraShots: [] },
  { name: 'txt', ref: null, file: FIX.txt, mime: 'text/plain',
    ready: `document.querySelector('#hifi-root .preview-source') != null`,
    settle: async (cdp) => { await sleep(700); }, extraShots: [] },
  { name: 'image', ref: null, file: FIX.png, mime: 'image/png',
    ready: `(() => { const i = document.querySelector('#hifi-root img[data-zs-image-preview]'); return i != null && i.naturalWidth > 0; })()`,
    settle: async (cdp) => { await sleep(700); }, extraShots: [] },
];

(async () => {
  const errs = [];
  const root = path.join(outDir, 'root');
  const projDir = path.join(outDir, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# 视觉复核项目\n', 'utf8');
  const app = spawn(path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo, env: { ...process.env, ZS_APP_DATA: root, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  own.add(app); app.once('exit', () => own.delete(app));
  app.stdout.on('data', (c) => { __appOut.v += c; }); app.stderr.on('data', (c) => { __appOut.v += c; });
  let cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 挂载');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const openr = await cdp.eval(`window.zs.command({ protocolVersion: 1, commandId: 'vis70-open-1', method: 'project.open', params: { path: ${JSON.stringify(projDir)} } }).then((r) => JSON.stringify(r))`);
  const projId = JSON.parse(openr).data.project.id;
  await cdp.eval('location.reload(), true');
  cdp = await connectPage('reload');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await waitFor(cdp, `document.querySelector('#hifi-root .side-project .side-item-label') != null`, 45000, '侧栏项目');
  await cdp.eval(`location.hash = ${JSON.stringify(`/project/${projId}`)}; true`);
  await waitFor(cdp, `document.body.textContent.includes('默认房间')`, 45000, '项目装载');
  const room = dbOf(root).q('SELECT id FROM rooms WHERE project_id = ? LIMIT 1', projId)[0];
  await cdp.eval(`location.hash = ${JSON.stringify(`/room/${room.id}`)}; true`);
  await waitFor(cdp, `document.querySelector('#hifi-root textarea.composer-input') != null`, 30000, '房间输入区');
  await sleep(800);

  /** 元信息：整窗 + 实际预览 rect + DPR + 当前阅读状态（文件/页/表）。 */
  const metaOf = (cdp) => cdp.tryEval(probe(`(() => {
    const pane = document.querySelector('#hifi-root .preview-pane');
    const body = document.querySelector('#hifi-root .preview-body');
    const r = pane != null ? pane.getBoundingClientRect() : null;
    const b = body != null ? body.getBoundingClientRect() : null;
    const pptx = document.querySelector('#hifi-root [data-zs-pptx-view]');
    const pdf = document.querySelector('#hifi-root [data-zs-pdf-view]');
    const xlsxOn = document.querySelector('#hifi-root .xlsx-sheet-tabs .xlsx-sheet-tab.on');
    return {
      window: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      paneRect: r != null ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      bodyRect: b != null ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null,
      reader: {
        pptxPage: pptx?.getAttribute('data-zs-pptx-page') ?? null,
        pdfPage: pdf?.getAttribute('data-zs-pdf-page') ?? null, pdfZoom: pdf?.getAttribute('data-zs-pdf-zoom') ?? null,
        xlsxSheet: xlsxOn?.getAttribute('data-zs-sheet-tab') ?? null,
      },
      activeTab: document.querySelector('#hifi-root .preview-tab.on .preview-tab-label')?.textContent.trim() ?? null,
    };
  })()`));

  const results = [];
  for (const sc of scenes) {
    const name = path.basename(sc.file);
    const b64 = fs.readFileSync(sc.file).toString('base64');
    const dispatch = await cdp.tryEval(probe(`(() => {
      const input = document.querySelector('#hifi-root input[data-zs-file-input]');
      if (input == null) return 'NO_INPUT';
      const bin = atob('${b64}');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(sc.mime)} });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`));
    if (dispatch !== true) { errs.push(`${sc.name}: 上传派发失败 ${dispatch}`); continue; }
    await until(() => cdp.tryEval(probe(`(() => { const chips = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')]; return chips.some((c) => (c.getAttribute('data-zs-att') === 'ready') && c.textContent.includes(${JSON.stringify(name)})); })()`)).catch(() => null), (v) => v, sc.name === 'ppt' ? 120000 : 60000, `${sc.name} 就绪芯片`);
    await cdp.eval(probe(`(() => { const chips = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')]; const chip = chips.find((c) => (c.getAttribute('data-zs-att') === 'ready') && c.textContent.includes(${JSON.stringify(name)})); const btn = [...chip.querySelectorAll('button')].find((b) => b.textContent.trim() === '预览'); btn.click(); return true; })()`));
    await waitFor(cdp, sc.ready, 120000, `${sc.name} 视图就绪`);
    await sc.settle(cdp);
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const oursPath = path.join(outDir, `ours-${sc.name}.png`);
    fs.writeFileSync(oursPath, Buffer.from(png.data, 'base64'));
    results.push({ scene: sc.name, ref: sc.ref, ours: oursPath, meta: await metaOf(cdp) });
    // 附加帧（PPT 图文页）。
    for (const ex of sc.extraShots) {
      await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[${ex.page - 1}]?.click(), true`));
      await waitFor(cdp, `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '${ex.page}'`, 45000, `${ex.name} 跳页`);
      await sleep(3000);
      const p2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const p2path = path.join(outDir, `ours-${ex.name}.png`);
      fs.writeFileSync(p2path, Buffer.from(p2.data, 'base64'));
      results.push({ scene: ex.name, ref: null, ours: p2path, meta: await metaOf(cdp) });
    }
    // 关闭全部标签再开下一个（同一起点）。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '菜单');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
    await sleep(700);
  }
  try { await cdp.send('Browser.close'); } catch { /* */ }
  await sleep(1500);
  cleanupOwn();
  fs.writeFileSync(path.join(outDir, 'pairs.json'), JSON.stringify({ runId, viewport: { w: W, h: H }, errs, scenes: results }, null, 2));
  console.log(JSON.stringify({ ok: errs.length === 0 && results.length >= scenes.length, errs, scenes: results.map((r) => ({ name: r.scene, meta: r.meta })), outDir }));
  process.exit(errs.length === 0 ? 0 : 10);
})().catch((err) => {
  console.error(String(err && err.stack || err));
  console.error('[appOut]', __appOut.v.slice(-1500));
  cleanupOwn();
  process.exit(1);
});
