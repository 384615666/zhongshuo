#!/usr/bin/env node
/**
 * R69 视觉成对复核：五种参考类型（PPT/PDF/Word/Excel/MD）+ TXT/PNG——与用户提供的 ZCode
 * 参考图（2560×1380）**同视口**截取正式 UI，产出成对图（reference-*.png × ours-*.png），
 * 由视觉子代理逐对判定版面/内容/布局交互达标情况（不能以 DOM 存在替代）。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const runId = `r69-vis-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `visual-gate-r69-${runId}`);
fs.mkdirSync(outDir, { recursive: true });
const saveAsDir = path.join(outDir, 'saved');
const PORT = 9676;
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
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 60_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
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
const scenes = [
  { name: 'ppt', ref: path.join(REF_DIR, 'reference-ppt.png'), file: FIX.pptx, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', waitExpr: `document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages') === '55'`, extra: async (cdp) => { await sleep(2500); } },
  { name: 'pdf', ref: path.join(REF_DIR, 'reference-pdf.png'), file: FIX.pdf, mime: 'application/pdf', waitExpr: `(() => { const c = document.querySelector('#hifi-root canvas[data-zs-pdf-canvas]'); return c != null && c.width > 200; })()`, extra: async (cdp) => { await sleep(1500); } },
  { name: 'word', ref: path.join(REF_DIR, 'reference-word.png'), file: FIX.docx, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', waitExpr: `document.querySelector('#hifi-root [data-zs-docx-host]')?.shadowRoot?.querySelectorAll('section').length >= 2`, extra: async (cdp) => { await sleep(1200); await cdp.eval("(() => { const host = document.querySelector('#hifi-root [data-zs-docx-host]'); const t = host?.shadowRoot?.querySelector('table'); if (t != null) t.scrollIntoView({ block: 'center' }); return true; })()"); await sleep(900); } },
  { name: 'excel', ref: path.join(REF_DIR, 'reference-excel.png'), file: FIX.xlsx, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', waitExpr: `document.querySelector('#hifi-root [data-zs-xlsx-view="engine"]') != null`, extra: async (cdp) => { await sleep(3500); } },
  { name: 'md', ref: path.join(REF_DIR, 'reference-md.png'), file: FIX.md, mime: 'text/markdown', waitExpr: `document.querySelector('#hifi-root .preview-read-doc') != null`, extra: async (cdp) => { await sleep(900); } },
  { name: 'txt', ref: null, file: FIX.txt, mime: 'text/plain', waitExpr: `document.querySelector('#hifi-root .preview-source') != null`, extra: async (cdp) => { await sleep(600); } },
  { name: 'image', ref: null, file: FIX.png, mime: 'image/png', waitExpr: `(() => { const i = document.querySelector('#hifi-root img[data-zs-image-preview]'); return i != null && i.naturalWidth > 0; })()`, extra: async (cdp) => { await sleep(600); } },
];

(async () => {
  const errs = [];
  const root = path.join(outDir, 'root');
  const projDir = path.join(outDir, 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# 视觉复核项目\n', 'utf8');
  const app = spawn(path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--remote-debugging-port=${PORT}`, path.join(repo, 'dist', 'ui', 'main.cjs')], {
    cwd: repo, env: { ...process.env, ZS_APP_DATA: root, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_SAVEAS_AUTO_DIR: saveAsDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  own.add(app); app.once('exit', () => own.delete(app));
  app.stdout.on('data', (c) => { __appOut.v += c; }); app.stderr.on('data', (c) => { __appOut.v += c; });
  let cdp = await connectPage('启动');
  await waitFor(cdp, `document.body.classList.contains('hifi-on')`, 60000, 'hifi 挂载');
  // 同参考视口。
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const openr = await cdp.eval(`window.zs.command({ protocolVersion: 1, commandId: 'vis-open-1', method: 'project.open', params: { path: ${JSON.stringify(projDir)} } }).then((r) => JSON.stringify(r))`);
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
    await waitFor(cdp, sc.waitExpr, 120000, `${sc.name} 视图就绪`);
    await sc.extra(cdp);
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const oursPath = path.join(outDir, `ours-${sc.name}.png`);
    fs.writeFileSync(oursPath, Buffer.from(png.data, 'base64'));
    results.push({ scene: sc.name, ref: sc.ref, ours: oursPath });
    // 关闭全部标签再开下一个（同一起点）。
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .preview-pane .preview-tabs-actions button')].find((b) => (b.getAttribute('aria-label') || '').includes('更多'))?.click(), true`));
    await waitFor(cdp, `document.querySelector('#hifi-root .menu .menu-item') != null`, 8000, '菜单');
    await cdp.eval(probe(`[...document.querySelectorAll('#hifi-root .menu .menu-item')].find((x) => x.textContent.includes('关闭所有文件'))?.click(), true`));
    await sleep(700);
  }
  try { await cdp.send('Browser.close'); } catch { /* */ }
  await sleep(1500);
  cleanupOwn();
  fs.writeFileSync(path.join(outDir, 'pairs.json'), JSON.stringify({ runId, scenes: results, errs }, null, 2));
  console.log(JSON.stringify({ ok: errs.length === 0 && results.length === scenes.length, errs, scenes: results.map((r) => path.basename(r.ours)), outDir }));
  process.exit(errs.length === 0 ? 0 : 10);
})().catch((err) => {
  console.error(String(err && err.stack || err));
  console.error('[appOut]', __appOut.v.slice(-1500));
  cleanupOwn();
  process.exit(1);
});
