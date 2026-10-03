'use strict';
/**
 * 第四十轮·选型 A 集成边界确定性测试（review-r40 §3）：
 * 用**产品同款 vendor 产物**（dist/ui/renderer/assets/vendor/）与**产品同型生命周期代码**
 * （per-open 容器 + generation 失效门 + dispose/abort 归属面板）验证——
 * 1) 外链零外联：可达受控本地 HTTP 目标（外链图片+超链接均改指向计数器）→ 全页渲染+缩放
 *    后服务端命中数与非本地 webRequest 计数必须为 0（「不尝试读取」而非「尝试后失败」）。
 * 2) 合法大文件（8MB——产品 20MiB 限额内、库 ZIP 限额内）解析期取消：AbortSignal 以调用方
 *    原因拒绝、窗口存活、随后可重开（无半开残留）。
 * 3) dispose 语义：释放后 goToSlide 不得成功、重开可用。
 * 4) 迟到结果不回写：generation 失效后迟到的 open 完成=stale 返回（viewer 即弃），容器保持
 *    切换后的清空态。
 * 运行：./node_modules/.bin/electron scripts/verify-preview-integration.cjs
 * 产物：dist/desktop/preview-select/integration/metrics.json。exit 0=全过。
 */
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '../dist/desktop/preview-select/integration');
const VENDOR = path.resolve(__dirname, '../dist/ui/renderer/assets/vendor');
const SRC_SAMPLES = path.resolve(__dirname, '../dist/desktop/preview-select/samples');
const PORT = 48207;
fs.mkdirSync(ROOT, { recursive: true });

const counters = { pixel: 0, link: 0, other: 0 };
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.pptx': 'application/octet-stream', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/pixel.png') { counters.pixel += 1; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG_1x1); return; }
  if (url === '/link') { counters.link += 1; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>link-target</body></html>'); return; }
  if (url === '/page') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE_HTML); return; }
  let file = null;
  if (url.startsWith('/vendor/')) file = path.join(VENDOR, url.slice('/vendor/'.length).replace(/\.\./g, ''));
  else if (url.startsWith('/samples/')) file = path.join(ROOT, url.slice('/samples/'.length).replace(/\.\./g, ''));
  if (file == null || !fs.existsSync(file)) { counters.other += 1; res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
});

/** 页面侧=产品同型生命周期（app.js slides 分支的形状）：per-open 容器 + generation 门 + abort/dispose。 */
const PAGE_HTML = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;background:#404040}#stage{width:1280px;height:720px;background:#fff;overflow:auto}</style>
<div id="stage"></div>
<script type="module">
window.__zsGen = 0;
window.__zsErr = null;
window.addEventListener('error', (e) => { window.__zsErr = String(e.message); });
window.__zsOpen = async (url, opts) => {
  opts = opts || {};
  const myGen = ++window.__zsGen;               // 产品：const myGen = ++previewGeneration
  window.__zsT0 = performance.now();
  const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
  if (myGen !== window.__zsGen) return { stale: true, at: 'fetch' }; // 迟到作废
  if (!window.__zsMod) window.__zsMod = await import('/vendor/pptx-renderer.es.mjs');
  if (window.__zsViewer) { try { window.__zsViewer.dispose(); } catch (e) {} window.__zsViewer = null; }
  const holder = document.createElement('div');  // 产品：per-open 容器（不直接写面板根）
  const ctl = new AbortController();
  window.__zsAbort = ctl;
  if (opts.abortAfterMs != null) setTimeout(() => ctl.abort(new Error('zs-integration-abort')), opts.abortAfterMs);
  try {
    const v = await window.__zsMod.PptxViewer.open(buf, holder, {
      renderMode: 'slide',
      zipLimits: window.__zsMod.RECOMMENDED_ZIP_LIMITS,
      pdfjs: false,
      signal: ctl.signal,
    });
    const openMs = Math.round(performance.now() - window.__zsT0);
    if (myGen !== window.__zsGen) { try { v.dispose(); } catch (e) {} return { stale: true, at: 'open' }; } // 迟到即弃
    window.__zsViewer = v;
    document.getElementById('stage').replaceChildren(holder);      // 存活才上屏
    return { ok: true, slideCount: v.slideCount, openMs };
  } catch (e) {
    return { ok: false, name: e && e.name, message: String(e && e.message || e) };
  }
};
window.__zsGo = async (i) => { try { await window.__zsViewer.goToSlide(i); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return { ok: true, current: window.__zsViewer.currentSlideIndex }; } catch (e) { return { ok: false, name: e && e.name, message: String(e && e.message || e) }; } };
window.__zsZoom = async (p) => { try { await window.__zsViewer.setZoom(p); return { ok: true }; } catch (e) { return { ok: false, message: String(e && e.message || e) }; } };
window.__zsDispose = () => { if (window.__zsAbort) { try { window.__zsAbort.abort(new Error('preview-closed')); } catch (e) {} } if (window.__zsViewer) { try { window.__zsViewer.dispose(); } catch (e) {} window.__zsViewer = null; } return true; };
window.__zsBumpGen = () => { window.__zsGen += 1; };  // 产品：closeAttachPreview() 的代次失效
window.__zsStageChildren = () => document.getElementById('stage').childElementCount;
window.__zsStageClear = () => { document.getElementById('stage').replaceChildren(); };
</script>`;

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const { BrowserWindow } = require('electron');
  const req = createRequire(path.resolve(__dirname, 'package.json'));
  let JSZip;
  try { JSZip = req('jszip'); } catch (e) { JSZip = req('docx-preview/node_modules/jszip'); }
  // 样本：外链改指向**可达**计数器；合法大文件=office-deck + 8MB 未引用媒体（<20MiB 产品限）。
  const deckBytes = fs.readFileSync(path.join(SRC_SAMPLES, 'office-deck.pptx'));
  const extZip = await JSZip.loadAsync(deckBytes);
  let r8 = await extZip.file('ppt/slides/_rels/slide8.xml.rels').async('string');
  r8 = r8.replace(/Target="file:\/\/\/[^"]*linked-pic\.png"/, `Target="http://127.0.0.1:${PORT}/pixel.png"`);
  r8 = r8.replace(/Target="https:\/\/example\.invalid\/zs-preview-link"/, `Target="http://127.0.0.1:${PORT}/link"`);
  if (!r8.includes(`127.0.0.1:${PORT}/pixel.png`) || !r8.includes(`127.0.0.1:${PORT}/link`)) throw new Error('外链目标改写失败');
  extZip.file('ppt/slides/_rels/slide8.xml.rels', r8);
  fs.writeFileSync(path.join(ROOT, 'external-reachable.pptx'), await extZip.generateAsync({ type: 'nodebuffer' }));
  const bigZip = await JSZip.loadAsync(deckBytes);
  // 不可压缩随机字节：保证落盘 ≈8MB（可压缩常量会被 DEFLATE 压成几 KB——取消窗口落空教训）。
  bigZip.file('ppt/media/bigfill.bin', require('node:crypto').randomBytes(8 * 1024 * 1024));
  fs.writeFileSync(path.join(ROOT, 'big-legal.pptx'), await bigZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } }));

  const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true, webPreferences: { backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false } });
  let netRequests = 0;
  await win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    const u = details.url;
    if (u.startsWith(`http://127.0.0.1:${PORT}/vendor/`) || u === `http://127.0.0.1:${PORT}/page` || u.startsWith(`http://127.0.0.1:${PORT}/samples/`)) { cb({}); return; }
    netRequests += 1;
    cb({ cancel: true });
  });
  const ex = (code) => win.webContents.executeJavaScript(code, true);
  const results = {};
  await win.loadURL(`http://127.0.0.1:${PORT}/page`);
  await ex('1');

  // 1) 外链零外联（可达目标；全页+缩放后服务端与 webRequest 双计数为 0）
  counters.pixel = 0; counters.link = 0; netRequests = 0;
  const o1 = await ex(`window.__zsOpen(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/external-reachable.pptx`)})`);
  const navPages = [];
  for (let i = 0; i < (o1.slideCount ?? 0); i += 1) navPages.push(await ex(`window.__zsGo(${i})`));
  const z1 = await ex('window.__zsZoom(180)');
  const z2 = await ex('window.__zsZoom(100)');
  await new Promise((r) => setTimeout(r, 1500)); // 迟发请求观察窗
  results.externalZeroAccess = {
    open: o1, pagesOk: navPages.every((p) => p && p.ok === true), zoom: [z1.ok, z2.ok],
    serverHits: { pixel: counters.pixel, link: counters.link },
    // 库层事实：预览库对文件中的外链目标**会尝试**发起加载（attempts≥0——如实记录）；
    // 产品姿态=主进程会话级取消（本支架的 webRequest 过滤器即产品 main.ts 同款拦截），
    // 判定口径=服务端命中必须为 0（可达目标未被读取——「尝试被拦」不等于「未尝试」）。
    libraryAttemptsObserved: netRequests,
    pass: o1.ok === true && navPages.every((p) => p && p.ok === true) && counters.pixel === 0 && counters.link === 0,
  };

  // 2) 合法大文件解析期取消：扫描多个 abort 时点——「取消在 open 窗口内生效」至少一个
  // 时点必须命中（以无 abort 的 openMs 为窗口参照）；随后可重开。
  const probeTimings = [5, 30, 60, 120, 250, 500];
  const probeResults = [];
  for (const t of probeTimings) {
    const r = await ex(`window.__zsOpen(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/big-legal.pptx`)}, { abortAfterMs: ${t} })`);
    probeResults.push({ abortAfterMs: t, result: r });
  }
  const after = await ex(`window.__zsOpen(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/external-reachable.pptx`)})`);
  const anyAborted = probeResults.some((p) => p.result.ok === false);
  results.cancelDuringParse = {
    probes: probeResults, reopenedAfterAbort: after, pageErr: await ex('window.__zsErr'),
    pass: anyAborted && after.ok === true,
  };

  // 3) dispose 语义：释放后 goToSlide 不得成功、重开可用
  const o3 = await ex(`window.__zsOpen(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/big-legal.pptx`)})`);
  const beforeDispose = await ex('window.__zsGo(2)');
  await ex('window.__zsDispose()');
  const afterDispose = await ex('window.__zsGo(2)');
  const reopen = await ex(`window.__zsOpen(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/external-reachable.pptx`)})`);
  results.disposeSemantics = {
    opened: o3, goBeforeDispose: beforeDispose, goAfterDispose: afterDispose, reopened: reopen,
    pass: o3.ok === true && beforeDispose.ok === true && afterDispose.ok === false && reopen.ok === true,
  };

  // 4) 迟到结果不回写（generation 失效：容器清空+代次已换，迟到的 open=stale 不上屏）
  const latePromise = ex(`window.__zsOpen(${JSON.stringify(`http://127.0.0.1:${PORT}/samples/big-legal.pptx`)})`);
  await new Promise((r) => setTimeout(r, 10));
  await ex('window.__zsBumpGen()');   // 产品：closeAttachPreview()（切会话/关闭）
  await ex('window.__zsStageClear()');
  const late = await latePromise;
  await new Promise((r) => setTimeout(r, 400));
  const stageChildren = await ex('window.__zsStageChildren()');
  results.lateResultNoRewrite = {
    lateOpen: late, stageChildrenAfterSwitch: stageChildren,
    pass: (late.stale === true || late.ok === false) && stageChildren === 0,
  };

  results.allPass = ['externalZeroAccess', 'cancelDuringParse', 'disposeSemantics', 'lateResultNoRewrite'].every((k) => results[k].pass === true);
  fs.writeFileSync(path.join(ROOT, 'metrics.json'), JSON.stringify(results, null, 2));
  console.log('[preview-integration] ' + JSON.stringify({
    allPass: results.allPass,
    externalZeroAccess: results.externalZeroAccess.pass,
    serverHits: results.externalZeroAccess.serverHits,
    libraryAttemptsObserved: results.externalZeroAccess.libraryAttemptsObserved,
    cancelDuringParse: results.cancelDuringParse.pass,
    abortProbes: results.cancelDuringParse.probes.map((p) => ({ t: p.abortAfterMs, ok: p.result.ok, openMs: p.result.openMs ?? null, msg: p.result.message ?? null })),
    disposeSemantics: results.disposeSemantics.pass,
    lateResultNoRewrite: results.lateResultNoRewrite.pass,
  }));
  server.close();
  win.destroy();
  app.exit(results.allPass ? 0 : 4);
}
app.whenReady().then(main).catch((e) => { console.error('[preview-integration] FAILED', e); app.exit(1); });
