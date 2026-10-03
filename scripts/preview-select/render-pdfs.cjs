/**
 * 预览选型验证（2026-10-03）：把路线B（kit）与全量 LO 产出的 PDF 渲染为逐页 PNG。
 * 用产品同款 PDF.js 链（仓库根 pdfjs-dist legacy），720p 高度等比。用法：
 *   electron render-pdfs.cjs <pdfPath>|<outDir> <pdfPath>|<outDir> ...
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const pairs = [];
for (let i = 2; i < process.argv.length; i += 2) {
  pairs.push({ pdf: path.resolve(process.argv[i]), dir: path.resolve(process.argv[i + 1]) });
}

async function main() {
  const { BrowserWindow } = require('electron');
  const pdfjsUrl = pathToFileURL(path.resolve(__dirname, '../../node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href;
  const workerUrl = pdfjsUrl.replace(/pdf\.mjs$/, 'pdf.worker.min.mjs');
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const summary = [];
  const PAGE_SNIPPET = (pdfUrl, pageNo) => `(async () => {
    const pdfjs = await import(${JSON.stringify(pdfjsUrl)});
    pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(workerUrl)};
    if (!window.__zsDoc) window.__zsDoc = await pdfjs.getDocument({ url: ${JSON.stringify(pdfUrl)}, isEvalSupported: false }).promise;
    const t0 = performance.now();
    const page = await window.__zsDoc.getPage(${pageNo});
    const canvas = document.getElementById('c');
    const v1 = page.getViewport({ scale: 1 });
    const v2 = page.getViewport({ scale: 720 / v1.height });
    canvas.width = Math.round(v2.width); canvas.height = Math.round(v2.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: v2 }).promise;
    return { png: canvas.toDataURL('image/png'), ms: Math.round(performance.now() - t0), w: canvas.width, h: canvas.height };
  })()`;
  for (const { pdf, dir } of pairs) {
    fs.mkdirSync(dir, { recursive: true });
    const html = `<!doctype html><meta charset="utf-8"><canvas id="c"></canvas>`;
    const tmp = path.join(dir, '_page.html');
    fs.writeFileSync(tmp, html);
    await win.loadURL(pathToFileURL(tmp).href);
    const pdfUrl = pathToFileURL(pdf).href;
    // probe page count
    const countJs = `(async () => { const pdfjs = await import(${JSON.stringify(pdfjsUrl)}); pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(workerUrl)}; if (!window.__zsDoc) window.__zsDoc = await pdfjs.getDocument({ url: ${JSON.stringify(pdfUrl)}, isEvalSupported: false }).promise; return window.__zsDoc.numPages; })()`;
    let pages = 0;
    try { pages = await win.webContents.executeJavaScript(countJs, true); } catch (e) { summary.push({ pdf, error: String(e && e.message || e) }); continue; }
    const times = [];
    for (let i = 1; i <= pages; i++) {
      const r = await win.webContents.executeJavaScript(PAGE_SNIPPET(pdfUrl, i), true);
      const b64 = String(r.png).split(',')[1];
      fs.writeFileSync(path.join(dir, 'slide-' + String(i).padStart(2, '0') + '.png'), Buffer.from(b64, 'base64'));
      times.push(r.ms);
    }
    fs.rmSync(tmp);
    summary.push({ pdf: path.basename(pdf), pages, times, size: [1280, 720] });
  }
  fs.writeFileSync(path.resolve(__dirname, '../../dist/desktop/preview-select/route-b/pdf-render-summary.json'), JSON.stringify(summary, null, 2));
  console.log('[render-pdfs] ' + JSON.stringify(summary.map((s) => ({ pdf: s.pdf, pages: s.pages, error: s.error }))));
  win.destroy();
  app.exit(0);
}
app.whenReady().then(main).catch((e) => { console.error('[render-pdfs] FAILED', e); app.exit(1); });
