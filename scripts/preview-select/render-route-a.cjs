/**
 * 预览选型验证（2026-10-03）：路线A 采集支架。
 * @aiden0z/pptx-renderer（browser ESM 产物，同源 http 加载）在 Electron 隐藏窗口渲染
 * 同一批样本：首开/重开/逐页翻页/缩放时延、逐页 PNG、renderer 峰值内存、
 * 边界（损坏/超限/宏容器）与 AbortSignal 取消后存活核验。
 * 产物：dist/desktop/preview-select/route-a/<sample>/slide-XX.png + metrics.json
 * 运行：node ../../scripts/preview-select/render-route-a.cjs（从仓库根：electron 支持）
 */
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../dist/desktop/preview-select');
const VENDOR = path.resolve(__dirname, 'route-a/node_modules');
const OUT = path.join(ROOT, 'route-a');
const PORT = 48191;

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptm': 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', '.png': 'image/png', '.html': 'text/html' };

function serve(req, res) {
  let p = null;
  if (req.url === '/page') p = { file: null };
  else if (req.url.startsWith('/samples/')) p = { file: path.join(ROOT, 'samples', req.url.slice('/samples/'.length)) };
  else if (req.url === '/vendor/pptx-renderer.es.js') p = { file: path.join(VENDOR, '@aiden0z/pptx-renderer/dist/aiden0z-pptx-renderer.browser.es.js') };
  else if (req.url === '/vendor/pdf.min.mjs') p = { file: path.join(VENDOR, 'pdfjs-dist/build/pdf.min.mjs') };
  else if (req.url === '/vendor/pdf.worker.min.mjs') p = { file: path.join(VENDOR, 'pdfjs-dist/build/pdf.worker.min.mjs') };
  if (p == null) { res.writeHead(404); res.end(); return; }
  if (p.file == null) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(PAGE_HTML); return; }
  fs.readFile(p.file, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p.file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const PAGE_HTML = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#404040}#stage{width:1280px;height:720px;background:#fff}</style>
<div id="stage"></div>
<script>
window.__zsErr = null;
window.__zsViewer = null;
window.addEventListener('error', (e) => { window.__zsErr = String(e.message); });
window.__zsOpen = async (url, opts) => {
  opts = opts || {};
  const t = {};
  const t0 = performance.now();
  if (!window.__zsMod) window.__zsMod = await import('/vendor/pptx-renderer.es.js');
  t.moduleImportMs = (window.__zsModImported ? 0 : Math.round(performance.now() - t0));
  window.__zsModImported = true;
  const t1 = performance.now();
  const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
  t.fetchMs = Math.round(performance.now() - t1);
  if (window.__zsViewer) { try { window.__zsViewer.dispose(); } catch (e) {} window.__zsViewer = null; }
  const ctl = new AbortController();
  if (opts.abortAfterMs != null) setTimeout(() => ctl.abort(), opts.abortAfterMs);
  const o0 = performance.now();
  try {
    const v = await window.__zsMod.PptxViewer.open(buf, document.getElementById('stage'), {
      renderMode: 'slide',
      zipLimits: window.__zsMod.RECOMMENDED_ZIP_LIMITS,
      pdfjs: { moduleUrl: '/vendor/pdf.min.mjs', workerUrl: '/vendor/pdf.worker.min.mjs' },
      signal: ctl.signal,
    });
    window.__zsViewer = v;
    t.openMs = Math.round(performance.now() - o0);
    t.slideCount = v.slideCount;
    t.ok = true;
  } catch (e) {
    t.openMs = Math.round(performance.now() - o0);
    t.ok = false;
    t.errorName = e && e.name; t.errorMessage = String(e && e.message || e);
  }
  return t;
};
window.__zsGo = async (i) => {
  const v = window.__zsViewer;
  if (!v) return { ok: false, error: 'no-viewer' };
  const t0 = performance.now();
  const evd = new Promise((resolve) => {
    let settled = false;
    const h = (e) => {
      if (!settled && e.detail && e.detail.index === i) { settled = true; v.removeEventListener('sliderendered', h); resolve(true); }
    };
    v.addEventListener('sliderendered', h);
    setTimeout(() => { if (!settled) { settled = true; v.removeEventListener('sliderendered', h); resolve(false); } }, 5000);
  });
  await v.goToSlide(i);
  const goMs = Math.round(performance.now() - t0);
  const rendered = await evd;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 40));
  return { ok: true, goMs, rendered, current: v.currentSlideIndex };
};
window.__zsZoom = async (p) => {
  const v = window.__zsViewer;
  const t0 = performance.now();
  await v.setZoom(p);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { ok: true, ms: Math.round(performance.now() - t0), now: v.zoomPercent };
};
window.__zsDispose = () => { if (window.__zsViewer) { try { window.__zsViewer.dispose(); } catch (e) {} window.__zsViewer = null; } return true; };
</script>`;

async function shot(win, outPng) {
  const img = await win.webContents.capturePage();
  if (img == null || img.isEmpty()) throw new Error('empty capture ' + outPng);
  fs.writeFileSync(outPng, img.toPNG());
  return img.getSize().height;
}

async function main() {
  const server = http.createServer(serve).listen(PORT, '127.0.0.1');
  const { BrowserWindow } = require('electron');
  fs.mkdirSync(OUT, { recursive: true });
  const metrics = { electron: process.versions.electron, chromium: process.versions.chrome, samples: {}, boundary: {}, cancel: {}, memory: {}, windowCrashed: false };
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true, webPreferences: { backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('render-process-gone', (_e, d) => { metrics.windowCrashed = true; metrics.goneDetail = d.reason; });
  win.webContents.on('crashed', () => { metrics.windowCrashed = true; });
  await win.loadURL('http://127.0.0.1:' + PORT + '/page');
  await win.webContents.executeJavaScript('Promise.resolve(1)');
  const ex = (code) => win.webContents.executeJavaScript(code).catch((e) => ({ __execError: String(e && e.message || e) }));

  // memory sampler
  let peakKb = 0; let baseKb = 0; let sampling = true;
  const sampler = setInterval(() => {
    for (const m of app.getAppMetrics()) {
      if (m.type === 'Tab') {
        const kb = m.memory.workingSetSize; // Electron 44: KB
        if (Number.isFinite(kb) && kb > peakKb) peakKb = kb;
      }
    }
  }, 200);
  const base = () => { for (const m of app.getAppMetrics()) if (m.type === 'Tab') { const kb = m.memory.workingSetSize; if (Number.isFinite(kb)) baseKb = kb; } };
  base();

  // --- main samples: first open (cold, pays module import), reopen (warm), slides, zoom
  for (const sample of ['office-deck.pptx', 'dense-deck.pptx', 'rich-deck.pptx']) {
    const url = 'http://127.0.0.1:' + PORT + '/samples/' + encodeURIComponent(sample);
    const rec = {};
    rec.first = await ex(`window.__zsOpen(${JSON.stringify(url)})`);
    if (!rec.first || rec.first.ok !== true) {
      rec.error = rec.first && (rec.first.errorName + ': ' + rec.first.errorMessage);
      metrics.samples[sample] = rec; continue;
    }
    const dir = path.join(OUT, sample.replace(/\.pptx$/, ''));
    fs.mkdirSync(dir, { recursive: true });
    rec.slides = [];
    const n = rec.first.slideCount;
    for (let i = 0; i < n; i++) {
      const r = await ex(`window.__zsGo(${i})`);
      await shot(win, path.join(dir, 'slide-' + String(i + 1).padStart(2, '0') + '.png'));
      rec.slides.push(r);
    }
    rec.zoom180 = await ex('window.__zsZoom(180)');
    await shot(win, path.join(dir, 'zoom180-slide03.png'));
    rec.zoomBack = await ex('window.__zsZoom(100)');
    rec.reopen = await ex(`window.__zsOpen(${JSON.stringify(url)})`);
    if (rec.reopen && rec.reopen.ok === true) {
      await ex('window.__zsGo(0)');
      await shot(win, path.join(dir, 'reopen-slide01.png'));
    }
    metrics.samples[sample] = rec;
  }
  metrics.memory.peakRendererKb = peakKb; metrics.memory.afterSamplesBaseKb = baseKb;

  // --- boundary inputs (must reject or degrade, never kill the window)
  for (const [key, file] of [['corrupt', 'bad/corrupt.pptx'], ['huge', 'bad/huge.pptx'], ['macro', 'bad/macro-container.pptm']]) {
    const url = 'http://127.0.0.1:' + PORT + '/samples/' + file.split('/').map(encodeURIComponent).join('/');
    const t0 = Date.now();
    metrics.boundary[key] = await ex(`window.__zsOpen(${JSON.stringify(url)})`);
    metrics.boundary[key].wallMs = Date.now() - t0;
    metrics.boundary[key].pageErr = await ex('window.__zsErr');
  }
  // window still usable after boundary inputs?
  metrics.boundary.postMortemOfficeDeck = await ex(`window.__zsOpen(${JSON.stringify('http://127.0.0.1:' + PORT + '/samples/office-deck.pptx')})`);

  // --- cancel: abort mid-open of the huge file, then verify viewer still usable
  metrics.cancel.hugeAbort100ms = await ex(`window.__zsOpen(${JSON.stringify('http://127.0.0.1:' + PORT + '/samples/' + 'bad/huge.pptx')}, { abortAfterMs: 100 })`);
  metrics.cancel.afterAbortOfficeDeck = await ex(`window.__zsOpen(${JSON.stringify('http://127.0.0.1:' + PORT + '/samples/office-deck.pptx')})`);

  await ex('window.__zsDispose()');
  metrics.memory.finalPeakRendererKb = peakKb;
  clearInterval(sampler); sampling = false;
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
  server.close();
  win.destroy();
  app.exit(metrics.windowCrashed ? 3 : 0);
}
app.whenReady().then(main).catch((e) => { console.error('[route-a] FAILED', e); app.exit(1); });
