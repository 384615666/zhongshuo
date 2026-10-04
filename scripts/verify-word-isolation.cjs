'use strict';
/**
 * 第四十二轮·review-r41 §4：Word 预览隔离与外部资源——确定性测试（负对照补强版）。
 * 产品同款：随包 vendor（dist/ui/renderer/assets/vendor）+ 产品同款 renderAsync 调用形态
 * （Shadow DOM 承载 + renderAltChunks:false——与 src/ui/renderer/app.js docx 分支一致）+
 * 产品 main.ts 会话级拦截镜像（独立 partition 会话，与无拦截对照窗口分离）。
 * 场景：
 *  W1 样式边界：哨兵=复核样本的实际泄漏目标 `#host-sentinel > span`（review §4.1——旧支架
 *     放 id=sentinel 裸按钮读自身颜色，旧非隔离实现也不会命中=假覆盖）：
 *     - 负对照：同组件、第四十轮旧实现（光 DOM 直渲染）渲染同一样本 → 哨兵**必须变红**——
 *       证明哨兵与样本选择器匹配、检查有效；
 *     - 正对照：当前产品 Shadow 路径 → 哨兵保持原色；
 *     - 内部样式实测（review §4.2）：**合法**样式样本（styleId=zsred，无注入字符）在 shadow
 *       内以 getComputedStyle 实测变红——不以 CSS 字符串包含/style 节点数替代。
 *  W2 嵌入 HTML（review §4.3）：真实 altChunk 样本（aFChunk 关系 + 包内 HTML 部件）：
 *     - 开启对照 renderAltChunks:true → iframe 出现且 srcdoc 含载荷（证明样本被组件消费——
 *       非未消费 fixture 的假零）；
 *     - 产品 renderAltChunks:false → 全文档（含全部 shadowRoot）零 iframe；
 *     - 产品源码如实标注（app.js 同时含 renderAltChunks:false 与「嵌入 HTML（altChunks）
 *       首版不支持」用户可见说明）。
 *  W3 外部资源（review §4.4）：完整 wp:inline/pic:pic 图形结构（组件实际识别路径——
 *     parseDrawing→graphicData→pic→blipFill→blip@r:embed）：
 *     - 内嵌正对照：同结构 + 包内媒体 → 实际渲染 <img> 且 naturalWidth>0（结构被消费的证明）；
 *     - 外链样本（关系 TargetMode=External → 可达计数器）在**无拦截对照窗口**实测组件行为并
 *       如实记录（组件把关系目标按包内路径解析，是否形成网络 URL 以实测为准）；
 *     - 产品镜像窗口（会话拦截）→ 计数器命中 0。
 *  W4 正常正例（word-rich.docx，review §4.5）：3 节分页/表格/图片（naturalWidth 实测非零）/
 *     页眉（渲染文本实测含样本页眉标记）——断言与所得事实一致。
 * 运行：./node_modules/.bin/electron scripts/verify-word-isolation.cjs
 * 产物：dist/desktop/word-isolation/metrics.json（含各对照实测值）；exit 0=全过。
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

const counters = { pixel: 0, other: 0 };
let blocked = 0;
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

/** 页面侧：产品 docx 分支同型调用（Shadow DOM+renderAltChunks:false）+ 第四十轮旧实现镜像
 * （光 DOM 直渲染、无 altChunks 显式关闭）——同组件双路径 = W1 负对照。 */
const PAGE_HTML = `<!doctype html><meta charset="utf-8">
<style>
body{margin:0;padding:12px;background:#f7f8fa;font-family:inherit}
#host-sentinel{display:inline-block;border:1px solid #888;padding:4px 10px;background:#fff}
#host-sentinel span{color:#0037da}
#stage{margin-top:10px}
</style>
<div id="host-sentinel"><span id="sentinel-span">宿主哨兵 HOST-SENTINEL</span></div>
<div id="stage"></div>
<script src="/vendor/jszip.min.js"></script>
<script src="/vendor/docx-preview.min.js"></script>
<script>
window.__measure = (rootEl) => {
  const q = (sel) => rootEl.querySelectorAll(sel);
  const imgs = [];
  q('img').forEach((im) => {
    const a = im.getAttribute('src');
    imgs.push({ attr: a === null ? null : String(a).slice(0, 24), prop: String(im.src).slice(0, 40), naturalWidth: im.naturalWidth });
  });
  const headers = [];
  q('header').forEach((h) => headers.push((h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)));
  // 文本取 section/页眉页脚（排除组件注入的 <style> 文本——textContent 会把样式表算进去）。
  const textParts = [];
  q('section.docx').forEach((s) => textParts.push(s.textContent || ''));
  q('header, footer').forEach((h) => textParts.push(h.textContent || ''));
  return {
    sections: q('section.docx').length, tables: q('table').length, images: imgs.length,
    headers, imgs, text: textParts.join(' ').replace(/\\s+/g, ' ').slice(0, 1500),
  };
};
window.__sentinelColor = () => getComputedStyle(document.getElementById('sentinel-span')).color;
window.__zsRenderProduct = async (url, overrides) => {
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
  await window.docx.renderAsync(buf, shadow, shadow, Object.assign({ inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, breakPages: true, useBase64URL: true, experimental: true, renderAltChunks: false }, overrides || {}));
  stage.append(dvBox);
  return window.__measure(shadow);
};
window.__zsRenderOld = async (url) => {
  const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
  const stage = document.getElementById('stage');
  stage.replaceChildren();
  const dvBox = document.createElement('div');
  dvBox.className = 'docx-visual-box';
  stage.append(dvBox);
  await window.docx.renderAsync(buf, dvBox, dvBox, { inWrapper: true, ignoreWidth: false, ignoreHeight: false, ignoreFonts: false, breakPages: true, useBase64URL: true, experimental: true });
  return window.__measure(dvBox);
};
window.__countIframesEverywhere = () => {
  let n = document.querySelectorAll('iframe').length;
  for (const h of document.querySelectorAll('.docx-visual-shadow-host')) n += h.shadowRoot ? h.shadowRoot.querySelectorAll('iframe').length : 0;
  return n;
};
window.__shadowHost = () => { const h = document.querySelector('.docx-visual-shadow-host'); return h && h.shadowRoot ? h.shadowRoot : null; };
window.__validStyleColorInShadow = () => {
  const sh = window.__shadowHost();
  if (!sh) return null;
  for (const s of sh.querySelectorAll('p span')) {
    if ((s.textContent || '').includes('VALID-STYLE-RED')) return getComputedStyle(s).color;
  }
  return null;
};
window.__allImagesLoadedNatural = () => {
  const sh = window.__shadowHost();
  if (!sh) return false;
  const ims = sh.querySelectorAll('img');
  return ims.length > 0 && Array.from(ims).every((i) => i.naturalWidth > 0);
};
</script>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (name) => `http://127.0.0.1:${PORT}/samples/${name}`;

async function waitForJs(win, iifeExpr, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await win.webContents.executeJavaScript(iifeExpr, true).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) { console.warn('[word-isolation] 等待超时：' + label); return null; }
    await sleep(150);
  }
}

const W_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
/** 组件实际识别的完整图形结构（parseDrawing→inline→graphic→pic→blipFill→blip@r:embed）。 */
function drawingParagraph(rid) {
  return `<w:p><w:r><w:drawing ${W_NS}><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1828800" cy="1219200"/><wp:docPr id="901" name="ZS 核对图片"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="901" name="ZS 核对图片"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1219200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

async function buildSamples() {
  const req = createRequire(path.join(__dirname, 'package.json'));
  let JSZip;
  try { JSZip = req('jszip'); } catch (e) { JSZip = req('docx-preview/node_modules/jszip'); }
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const notes = {};

  // 1) W1 注入样本：复核原件优先（权威对抗样本）；缺失则按 review §4.1 描述构造同形。
  const reviewBoundary = path.join(REVIEW, 'style-boundary.docx');
  const skeletonBuf = fs.existsSync(reviewBoundary)
    ? fs.readFileSync(reviewBoundary)
    : null;
  if (skeletonBuf != null) {
    fs.copyFileSync(reviewBoundary, path.join(OUT, 'style-inject.docx'));
    notes.styleInjectSource = 'review-r40/style-boundary.docx（复核原件）';
  } else {
    const z = new JSZip();
    z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`);
    z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    z.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    z.file('word/styles.xml', `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="probe,#host-sentinel"><w:name w:val="Probe"/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style></w:styles>`);
    z.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="probe,#host-sentinel"/></w:pPr><w:r><w:t>Harmless preview style boundary probe</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    fs.writeFileSync(path.join(OUT, 'style-inject.docx'), await z.generateAsync({ type: 'nodebuffer' }));
    notes.styleInjectSource = 'constructed（复核原件缺失——按 review §4.1 描述构造同形 styleId=probe,#host-sentinel）';
  }

  // 2) W1 内部样式正对照：合法样式（styleId=zsred）——shadow 内实测生效。
  {
    const z = await JSZip.loadAsync(fs.readFileSync(path.join(OUT, 'style-inject.docx')));
    z.file('word/styles.xml', `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="zsred"><w:name w:val="ZsRed"/><w:rPr><w:color w:val="FF0000"/></w:rPr></w:style></w:styles>`);
    z.file('word/document.xml', `<w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:pPr><w:pStyle w:val="zsred"/></w:pPr><w:r><w:t>VALID-STYLE-RED 文档内合法样式红字</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    fs.writeFileSync(path.join(OUT, 'style-valid.docx'), await z.generateAsync({ type: 'nodebuffer' }));
  }

  // 3) W2 真实 altChunk：包内 HTML 部件 + aFChunk 关系 + w:altChunk 体元素。
  {
    const z = await JSZip.loadAsync(fs.readFileSync(path.join(OUT, 'style-inject.docx')));
    let docXml = await z.file('word/document.xml').async('string');
    const rels = await z.file('word/_rels/document.xml.rels').async('string');
    const insert = `<w:p><w:r><w:t>ALTCHUNK-CARRIER 正文标记</w:t></w:r></w:p><w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdZsAlt"/>`;
    docXml = docXml.includes('<w:sectPr') ? docXml.replace('<w:sectPr', insert + '<w:sectPr') : docXml.replace('</w:body>', insert + '</w:body>');
    z.file('word/document.xml', docXml);
    z.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', `<Relationship Id="rIdZsAlt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="alt.html"/></Relationships>`));
    z.file('word/alt.html', `<html><body><p><b>ALTCHUNK-PROBE-PAYLOAD</b> 嵌入 HTML 载荷（无害）</p></body></html>`);
    fs.writeFileSync(path.join(OUT, 'altchunk.docx'), await z.generateAsync({ type: 'nodebuffer' }));
  }

  // 4) W3 内嵌正对照 + 外链样本：基于 word-rich（同一结构，仅关系目标不同）。
  const richBuf = fs.readFileSync(path.join(SAMPLES, 'word-rich.docx'));
  fs.writeFileSync(path.join(OUT, 'word-rich.docx'), richBuf);
  {
    const z = await JSZip.loadAsync(richBuf);
    const img1 = await z.file('word/media/image1.png').async('nodebuffer');
    let docXml = await z.file('word/document.xml').async('string');
    const rels = await z.file('word/_rels/document.xml.rels').async('string');
    const inject = (dz, paragraph) => (dz.includes('<w:sectPr') ? dz.replace('<w:sectPr', paragraph + '<w:sectPr') : dz.replace('</w:body>', paragraph + '</w:body>'));
    // 内嵌对照：同结构 + 包内媒体 → 必须 <img> 且 naturalWidth>0（结构被消费的证明）。
    z.file('word/media/zs-control.png', img1);
    z.file('word/document.xml', inject(docXml, drawingParagraph('rIdZsEmb')));
    z.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', `<Relationship Id="rIdZsEmb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/zs-control.png"/></Relationships>`));
    fs.writeFileSync(path.join(OUT, 'word-embedded-control.docx'), await z.generateAsync({ type: 'nodebuffer' }));
    // 外链样本：TargetMode=External → 可达计数器。
    const z2 = await JSZip.loadAsync(richBuf);
    z2.file('word/document.xml', inject(docXml, drawingParagraph('rIdZsExt')));
    z2.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', `<Relationship Id="rIdZsExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://127.0.0.1:${PORT}/pixel.png" TargetMode="External"/></Relationships>`));
    fs.writeFileSync(path.join(OUT, 'word-external.docx'), await z2.generateAsync({ type: 'nodebuffer' }));
  }
  return notes;
}

async function main() {
  const sampleNotes = await buildSamples();
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const { BrowserWindow, session } = require('electron');
  const winOpts = { show: false, width: 1100, height: 950, useContentSize: true, webPreferences: { backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false } };
  // 产品镜像窗口：独立 partition 会话 + main.ts 会话级拦截同型（本支架资源放行、外联与 pixel 拒绝）。
  const prodSession = session.fromPartition('zs-word-product-mirror');
  await prodSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    const u = details.url;
    if (u.startsWith(`http://127.0.0.1:${PORT}/`) && !u.includes('/pixel.png')) { cb({}); return; }
    blocked += 1;
    cb({ cancel: true });
  });
  const productWin = new BrowserWindow({ ...winOpts, webPreferences: { ...winOpts.webPreferences, session: prodSession } });
  const openWin = new BrowserWindow(winOpts); // 无拦截对照窗口（默认会话）——外链行为实测
  await Promise.all([productWin.loadURL(`http://127.0.0.1:${PORT}/page`), openWin.loadURL(`http://127.0.0.1:${PORT}/page`)]);
  const exP = (code) => productWin.webContents.executeJavaScript(code, true);
  const exO = (code) => openWin.webContents.executeJavaScript(code, true);
  await exP('1');
  const results = { sampleNotes };

  // W1 样式边界：负对照（旧实现必须变红）+ 正对照（产品路径不变色）+ 合法样式内部实测。
  {
    const before = await exP('window.__sentinelColor()');
    const injProduct = await exP(`window.__zsRenderProduct(${JSON.stringify(S('style-inject.docx'))})`);
    const afterProduct = await exP('window.__sentinelColor()');
    const hasShadow = await exP(`(() => { const sh = window.__shadowHost(); return sh != null; })()`);
    // 合法样式（review §4.2）：shadow 内 getComputedStyle 实测。
    await exP(`window.__zsRenderProduct(${JSON.stringify(S('style-valid.docx'))})`);
    const validColor = await exP('window.__validStyleColorInShadow()');
    // 负对照：第四十轮旧实现（光 DOM 直渲染）同一样本 → 哨兵必须变红。
    await exP(`window.__zsRenderOld(${JSON.stringify(S('style-inject.docx'))})`);
    const afterOld = await exP('window.__sentinelColor()');
    await exP(`window.__zsRenderProduct(${JSON.stringify(S('style-inject.docx'))})`); // 复位舞台为产品形态
    results.W1_styleBoundary = {
      sentinelBase: before, sentinelAfterProduct: afterProduct, sentinelAfterOldImpl: afterOld,
      internalValidStyleComputedColor: validColor, hasShadow,
      pass: before === 'rgb(0, 55, 218)' && afterProduct === before
        && afterOld === 'rgb(255, 0, 0)' // 负对照必须命中——否则哨兵/样本不匹配（旧支架缺陷）
        && validColor === 'rgb(255, 0, 0)' && hasShadow === true,
    };
  }

  // W2 嵌入 HTML：真实 altChunk——开启对照产生 iframe（消费证明）；产品关闭零 iframe；源码如实标注。
  {
    await exP(`window.__zsRenderProduct(${JSON.stringify(S('altchunk.docx'))}, { renderAltChunks: true })`);
    const srcdoc = await waitForJs(productWin, `(() => { const sh = window.__shadowHost(); const f = sh ? sh.querySelector('iframe') : null; return f && f.srcdoc && f.srcdoc.includes('ALTCHUNK-PROBE-PAYLOAD') ? f.srcdoc.replace(/\\s+/g, ' ').slice(0, 90) : null; })()`, 6000, 'altChunk srcdoc');
    await exP(`window.__zsRenderProduct(${JSON.stringify(S('altchunk.docx'))})`);
    const iframes = await exP('window.__countIframesEverywhere()');
    const appJs = fs.readFileSync(path.join(root, 'src/ui/renderer/app.js'), 'utf8');
    results.W2_altChunk = {
      enabledContrastSrcdoc: srcdoc, productIframes: iframes,
      productSource: {
        renderAltChunksFalse: appJs.includes('renderAltChunks: false'),
        userVisibleNote: appJs.includes('嵌入 HTML（altChunks）首版不支持'),
      },
      pass: srcdoc != null && iframes === 0
        && appJs.includes('renderAltChunks: false') && appJs.includes('嵌入 HTML（altChunks）首版不支持'),
    };
  }

  // W3 外部资源：内嵌正对照（结构消费证明）→ 外链无拦截实测 → 产品镜像零命中。
  {
    const base = await exP(`window.__zsRenderProduct(${JSON.stringify(S('word-rich.docx'))})`);
    await waitForJs(productWin, 'window.__allImagesLoadedNatural()', 8000, 'word-rich 图片加载');
    const ctrl = await exP(`window.__zsRenderProduct(${JSON.stringify(S('word-embedded-control.docx'))})`);
    await waitForJs(productWin, 'window.__allImagesLoadedNatural()', 8000, '内嵌对照图片加载');
    const embeddedControlOk = ctrl.images === base.images + 1 && ctrl.imgs.every((i) => i.naturalWidth > 0);
    // 无拦截对照窗口：组件对外链关系的真实行为（是否形成网络 URL）。
    counters.pixel = 0; counters.other = 0;
    const extOpen = await exO(`window.__zsRenderProduct(${JSON.stringify(S('word-external.docx'))})`);
    await sleep(1500);
    const permissiveHits = counters.pixel;
    // 产品镜像窗口：会话拦截下的最终行为。
    counters.pixel = 0; counters.other = 0; blocked = 0;
    const extProd = await exP(`window.__zsRenderProduct(${JSON.stringify(S('word-external.docx'))})`);
    await sleep(1500);
    results.W3_externalResources = {
      embeddedControl: { baseImages: base.images, controlImages: ctrl.images, allLoadedNatural: ctrl.imgs.every((i) => i.naturalWidth > 0) },
      externalPermissiveNoFilter: { serverHits: permissiveHits, otherRequests: counters.other, imgs: extOpen.imgs },
      externalProductMirror: { serverHits: counters.pixel, otherRequests: counters.other, blockedBySessionFilter: blocked, imgs: extProd.imgs },
      pass: embeddedControlOk && counters.pixel === 0 && (permissiveHits === 0 || blocked >= 1),
    };
  }

  // W4 正常正例：3 节分页/表格/图片（naturalWidth 实测）/页眉（文本实测）。
  {
    await exP(`window.__zsRenderProduct(${JSON.stringify(S('word-rich.docx'))})`);
    await waitForJs(productWin, 'window.__allImagesLoadedNatural()', 8000, 'W4 图片加载');
    const m = await exP(`window.__measure(window.__shadowHost())`);
    results.W4_normalDoc = {
      sections: m.sections, tables: m.tables, images: m.images,
      imagesAllLoadedNatural: m.imgs.every((i) => i.naturalWidth > 0),
      headers: m.headers,
      headerTextOk: m.headers.some((t) => t.includes('众说预览选型核对')),
      texts: { hasTitle: m.text.includes('Word 富样本'), hasPage2: m.text.includes('第二页'), hasEnd: m.text.includes('结尾页') },
      textSample: m.text.slice(0, 300),
      pass: m.sections === 3 && m.tables >= 1 && m.images >= 1 && m.imgs.every((i) => i.naturalWidth > 0)
        && m.headers.length >= 1 && m.headers.some((t) => t.includes('众说预览选型核对'))
        && m.text.includes('Word 富样本') && m.text.includes('第二页') && m.text.includes('结尾页'),
    };
  }

  results.allPass = ['W1_styleBoundary', 'W2_altChunk', 'W3_externalResources', 'W4_normalDoc'].every((k) => results[k].pass === true);
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 2));
  console.log('[word-isolation] allPass=' + results.allPass + ' ' + JSON.stringify(Object.fromEntries(Object.entries(results).filter(([k]) => k !== 'sampleNotes').map(([k, v]) => [k, v.pass]))));
  server.close();
  productWin.destroy();
  openWin.destroy();
  app.exit(results.allPass ? 0 : 4);
}
app.whenReady().then(main).catch((e) => { console.error('[word-isolation] FAILED', e); app.exit(1); });
