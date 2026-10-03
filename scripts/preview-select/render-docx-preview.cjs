/**
 * 预览选型验证（2026-10-03）：Word 路线A烟测——docx-preview 渲染真 Word 样本。
 * 产物：dist/desktop/preview-select/route-a/word-sample/page-XX.png + docx-preview-metrics.json
 */
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../dist/desktop/preview-select');
const VENDOR = path.resolve(__dirname, 'route-a/node_modules');
const OUT = path.join(ROOT, 'route-a/word-sample');
const PORT = 48197;
fs.mkdirSync(OUT, { recursive: true });

// argv[2] 可覆盖 docx 样本（块D：word-rich）——拷进 samples/ 统一路由。
const DOCX_NAME = process.argv[2] != null ? path.basename(process.argv[2]) : 'word-sample.docx';
console.log('[argv]', JSON.stringify(process.argv), 'cwd=', process.cwd());
if (process.argv[2] != null) fs.copyFileSync(path.resolve(process.cwd(), process.argv[2]), path.join(ROOT, 'samples', DOCX_NAME));
const MIME = { '.js': 'text/javascript', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const server = http.createServer((req, res) => {
  let file = null;
  if (req.url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE_HTML); return; }
  if (req.url === '/samples/word-sample.docx') file = path.join(ROOT, 'samples', DOCX_NAME);
  else if (req.url === '/vendor/docx-preview.min.js') file = path.join(VENDOR, 'docx-preview/dist/docx-preview.min.js');
  else if (req.url === '/vendor/jszip.min.js') file = path.join(VENDOR, 'jszip/dist/jszip.min.js');
  else { res.writeHead(404); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const PAGE_HTML = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;background:#888}#stage{width:794px;margin:0 auto;background:#fff}</style>
<div id="stage"></div>
<script src="/vendor/jszip.min.js"></script>
<script src="/vendor/docx-preview.min.js"></script>
<script>
window.__zsRun = async () => {
  const t = {};
  const t0 = performance.now();
  const buf = await (await fetch('/samples/word-sample.docx', { cache: 'no-store' })).arrayBuffer();
  t.fetchMs = Math.round(performance.now() - t0);
  const r0 = performance.now();
  await window.docx.renderAsync(buf, document.getElementById('stage'), null, { inWrapper: true, ignoreWidth: false, ignoreHeight: false });
  t.renderMs = Math.round(performance.now() - r0);
  const pages = document.querySelectorAll('.docx-wrapper section.docx').length;
  t.pages = pages;
  return t;
};
</script>`;

async function main() {
  const { BrowserWindow } = require('electron');
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('http://127.0.0.1:' + PORT + '/page');
  const t = await win.webContents.executeJavaScript('window.__zsRun()', true).catch((e) => ({ error: String(e && e.message || e) }));
  const metrics = { ...t };
  if (t && !t.error) {
    const pages = t.pages || 1;
    for (let i = 0; i < pages; i += 1) {
      // 滚动到第 i 页再截图（docx-preview 为连续滚动页）
      await win.webContents.executeJavaScript(`document.querySelectorAll('.docx-wrapper section.docx')[${i}].scrollIntoView(); window.scrollTo(0, window.scrollY); true`, true);
      await new Promise((r) => setTimeout(r, 150));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, 'slide-' + String(i + 1).padStart(2, '0') + '.png'), img.toPNG());
    }
    // 连续流兜底（块D 实测：显式分页符下 section 可能未分页——按内容总高截整图，如实留档）
    if (pages <= 1) {
      const contentH = await win.webContents.executeJavaScript('Math.ceil(document.body.scrollHeight)', true);
      metrics.continuousFallback = { contentHeight: contentH };
      const capped = Math.min(Math.max(contentH, 600), 4200);
      win.setContentSize(900, capped);
      await new Promise((r) => setTimeout(r, 200));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, 'full-capture.png'), img.toPNG());
    }
  }
  fs.writeFileSync(path.join(OUT, 'docx-preview-metrics.json'), JSON.stringify(metrics, null, 2));
  console.log('[docx-preview] ' + JSON.stringify(metrics));
  server.close();
  win.destroy();
  app.exit(0);
}
app.whenReady().then(main).catch((e) => { console.error('[docx-preview] FAILED', e); app.exit(1); });
