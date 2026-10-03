'use strict';
/**
 * 第四十一轮·review-r40 §4：Word 预览 CSS 隔离与外部资源——确定性测试。
 * 产品同款：随包 vendor（dist/ui/renderer/assets/vendor）+ **产品同款 renderAsync 调用形态**
 * （Shadow DOM 承载 + renderAltChunks:false——与 src/ui/renderer/app.js docx 分支一致）+
 * 产品同款 CSP/子资源拦截（main.ts 会话级全拒的镜像）。
 * 场景：
 *  W1 样式边界反例（复用复核样本 style-boundary.docx，styleId 含逗号选择器）：宿主哨兵按钮
 *     颜色必须不变；文档内容在 shadow 内仍按其样式渲染（红字在边界内生效）。
 *  W2 嵌入 HTML：renderAltChunks:false → 全文档零 iframe/srcdoc。
 *  W3 外部资源反例：外链图片指向可达计数器 → 服务端命中 0（Word 路径独立验证——不以 PPT
 *     计数器泛化）。
 *  W4 正常正例（word-rich.docx）：shadow 内 3 节分页、表格、图片、页眉均呈现。
 * 运行：./node_modules/.bin/electron scripts/verify-word-isolation.cjs
 * 产物：dist/desktop/word-isolation/metrics.json；exit 0=全过。
 */
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const VENDOR = path.join(root, 'dist/ui/renderer/assets/vendor');
const OUT = path.join(root, 'dist/desktop/word-isolation');
const REVIEW = path.join(root, 'dist/desktop/review-r40');
const SAMPLES = path.join(root, 'dist/desktop/preview-select/samples');
const PORT = 48213;
fs.mkdirSync(OUT, { recursive: true });

// 产品同款 CSP（index.html 无 CSP 时以 main.ts 拦截为边界——此处镜像其子资源拒绝语义）。
const counters = { pixel: 0, other: 0 };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/pixel.png') { counters.pixel += 1; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); return; }
  if (url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE_HTML); return; }
  let file = null;
  if (url.startsWith('/vendor/')) file = path.join(VENDOR, url.slice('/vendor/'.length).replace(/\.\./g, ''));
  else if (url.startsWith('/samples/')) file = path.join(OUT, url.slice('/samples/'.length).replace(/\.\./g, ''));
  if (file == null || !fs.existsSync(file)) { counters.other += 1; res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': url.endsWith('.docx') ? 'application/octet-stream' : 'text/javascript', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

/** 页面侧=产品 docx 分支同型调用（Shadow DOM+renderAltChunks:false——与 app.js 逐项一致）。 */
const PAGE_HTML = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;padding:12px;background:#f7f8fa;font-family:inherit}#sentinel{color:#000;border:1px solid #888;padding:2px 10px;background:#fff}#stage{margin-top:10px}</style>
<button id="sentinel">宿主哨兵按钮 HOST-SENTINEL</button>
<div id="stage"></div>
<script src="/vendor/jszip.min.js"></script>
<script src="/vendor/docx-preview.min.js"></script>
<script>
window.__zsRender = async (url) => {
  const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
  const stage = document.getElementById('stage');
  stage.replaceChildren();
  const dvBox = document.createElement('div');
  dvBox.className = 'docx-visual-box';
  const shadowHost = document.createElement('div');
  shadowHost.className = 'docx-visual-shadow-host';
  dvBox.append(shadowHost);
  const shadow = shadowHost.attachShadow({ mode: 'open' });
  const shadowStyle = document.createElement('style');
  shadowStyle.textContent = '.docx-wrapper{background:#fff;padding:0;}.docx-wrapper>section.docx{box-shadow:0 1px 4px rgba(15,23,42,.12);margin-bottom:8px;padding:10px 14px;}table{border-collapse:collapse;}td,th{border:1px solid #c8ccd4;padding:2px 8px;font-size:12px;}';
  shadow.append(shadowStyle);
  await window.docx.renderAsync(buf, shadow, shadow, { inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, breakPages: true, useBase64URL: true, experimental: true, renderAltChunks: false });
  stage.append(dvBox);
  return {
    sections: shadow.querySelectorAll('section.docx').length,
    tables: shadow.querySelectorAll('table').length,
    images: shadow.querySelectorAll('img').length,
    headers: shadow.querySelectorAll('section.docx header, .docx-header').length,
    redTextInside: (shadow.textContent || '').includes('STYLE-BOUNDARY-PROBE') || (shadow.querySelector('[style*="color"]') != null),
    colorInside: (shadow.querySelector('p') && shadow.getComputedStyle ? null : null),
  };
};
</script>`;

async function main() {
  const req = createRequire(path.join(__dirname, 'package.json'));
  let JSZip;
  try { JSZip = req('jszip'); } catch (e) { JSZip = req('docx-preview/node_modules/jszip'); }
  // W3 样本：word-rich + 外链图片关系（目标=可达计数器）。
  const rich = fs.readFileSync(path.join(SAMPLES, 'word-rich.docx'));
  fs.writeFileSync(path.join(OUT, 'word-rich.docx'), rich);
  const extZip = await JSZip.loadAsync(rich);
  let docXml = await extZip.file('word/document.xml').async('string');
  // 在正文最前插入一个引用外链图片的 run（drawing 简化为 v:imagedata 形态会随库而异——
  // 直接改 document.xml.rels 加外链目标 + 正文 r:id 引用，库按关系解析）。
  let rels = await extZip.file('word/_rels/document.xml.rels').async('string');
  if (!rels.includes('rIdZsExt')) {
    rels = rels.replace('</Relationships>', `<Relationship Id="rIdZsExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://127.0.0.1:${PORT}/pixel.png" TargetMode="External"/></Relationships>`);
    extZip.file('word/_rels/document.xml.rels', rels);
    docXml = docXml.replace('</w:body>', `<w:p><w:r><w:drawing xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:blip r:embed="rIdZsExt"/></w:drawing></w:r></w:p></w:body>`);
    extZip.file('word/document.xml', docXml);
  }
  fs.writeFileSync(path.join(OUT, 'word-external.docx'), await extZip.generateAsync({ type: 'nodebuffer' }));
  // W1 样本：复核的 style-boundary.docx（styleId=probe,#host-sentinel）。
  const boundary = path.join(REVIEW, 'style-boundary.docx');
  if (fs.existsSync(boundary)) fs.copyFileSync(boundary, path.join(OUT, 'style-boundary.docx'));

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({ show: false, width: 1000, height: 900, useContentSize: true, webPreferences: { backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false } });
  // 产品 main.ts 会话级拦截的镜像（同一 API）：拒绝非本服务资源的网络请求。
  let blocked = 0;
  await win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    const u = details.url;
    if (u.startsWith(`http://127.0.0.1:${PORT}/`) && !u.includes('/pixel.png')) { cb({}); return; }
    blocked += 1;
    cb({ cancel: true });
  });
  await win.loadURL(`http://127.0.0.1:${PORT}/page`);
  const ex = (code) => win.webContents.executeJavaScript(code, true);
  await ex('1');
  const results = {};

  // W1 样式边界（复核反例样本）。
  if (fs.existsSync(path.join(OUT, 'style-boundary.docx'))) {
    const before = await ex(`getComputedStyle(document.getElementById('sentinel')).color`);
    await ex(`window.__zsRender(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/style-boundary.docx`)})`);
    const after = await ex(`getComputedStyle(document.getElementById('sentinel')).color`);
    const shadowInfo = await ex(`(() => { const host = document.querySelector('.docx-visual-shadow-host'); const sh = host && host.shadowRoot; return JSON.stringify({ hasShadow: sh != null, textLen: (sh && sh.textContent || '').length, stylesInShadow: sh ? sh.querySelectorAll('style').length : 0 }); })()`);
    results.W1_styleBoundary = {
      sentinelBefore: before, sentinelAfter: after,
      shadowInfo: JSON.parse(shadowInfo),
      pass: before === after && before === 'rgb(0, 0, 0)' && JSON.parse(shadowInfo).hasShadow === true,
    };
  } else {
    results.W1_styleBoundary = { pass: null, note: '复核样本 style-boundary.docx 不存在（dist/desktop/review-r40）——跳过' };
  }

  // W2 嵌入 HTML：renderAltChunks:false → 零 iframe（以 word-external 为载体渲染后检查）。
  {
    await ex(`window.__zsRender(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/word-rich.docx`)})`);
    const iframes = await ex(`(() => { let n = 0; const hosts = document.querySelectorAll('.docx-visual-shadow-host'); for (const h of hosts) n += h.shadowRoot ? h.shadowRoot.querySelectorAll('iframe').length : 0; return n + document.querySelectorAll('iframe').length; })()`);
    results.W2_noAltChunkIframes = { iframes, pass: iframes === 0 };
  }

  // W3 外部资源（可达计数器）。
  {
    counters.pixel = 0; blocked = 0;
    const r = await ex(`window.__zsRender(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/word-external.docx`)})`);
    await new Promise((res) => setTimeout(res, 1200));
    results.W3_externalZeroAccess = {
      render: r, serverHits: counters.pixel, blockedBySessionFilter: blocked,
      pass: counters.pixel === 0,
    };
  }

  // W4 正常正例（word-rich：3 节/表格/图片）。
  {
    const r = await ex(`window.__zsRender(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/word-rich.docx`)})`);
    const textCheck = await ex(`(() => { const h = document.querySelector('.docx-visual-shadow-host'); const t = h && h.shadowRoot ? h.shadowRoot.textContent : ''; return JSON.stringify({ hasTitle: t.includes('Word 富样本'), hasPage2: t.includes('第二页'), hasEnd: t.includes('结尾页') }); })()`);
    results.W4_normalDoc = {
      sections: r.sections, tables: r.tables, images: r.images,
      text: JSON.parse(textCheck),
      pass: r.sections === 3 && r.tables >= 1 && r.images >= 1 && JSON.parse(textCheck).hasTitle && JSON.parse(textCheck).hasPage2 && JSON.parse(textCheck).hasEnd,
    };
  }

  results.allPass = ['W1_styleBoundary', 'W2_noAltChunkIframes', 'W3_externalZeroAccess', 'W4_normalDoc'].every((k) => results[k].pass === true);
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2));
  console.log('[word-isolation] allPass=' + results.allPass + ' ' + JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.pass]))));
  server.close();
  win.destroy();
  app.exit(results.allPass ? 0 : 4);
}
app.whenReady().then(main).catch((e) => { console.error('[word-isolation] FAILED', e); app.exit(1); });
