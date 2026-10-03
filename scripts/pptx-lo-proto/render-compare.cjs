/**
 * 第三十九轮 §4.1：双路线页面渲染比对（Electron 无头截图）。
 * - 路线 A：LibreOffice 产物 PDF 经 pdfjs（node_modules pdfjs-dist legacy）渲染到 canvas → PNG；
 * - 路线 B：自写 SVG（现行产品 buildPptxPages 输出）直接挂载 → PNG。
 * 页面尺寸统一按自写路线画布（pxW×pxH）；PDF 按首页尺寸等比缩放到同高。
 * 产物：out/<case>/compare/page-<n>-lo.png / page-<n>-own.png + compare-index.json。
 * 用法：npx electron scripts/pptx-lo-proto/render-compare.cjs
 */
const { app, BrowserWindow } = require('electron');
// 原型 harness 允许 file→file worker（产品内走 zsres:// 特权协议——不适用此放宽）。
app.commandLine.appendSwitch('allow-file-access-from-files');
const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../../dist/desktop/pptx-lo-proto');
const outRoot = join(root, 'out');

const PAGE_HTML = (modUrl, pdfHref, svgSrc, w, h) => {
  const modLit = JSON.stringify(String(modUrl));
  const pdfLit = pdfHref == null ? 'null' : JSON.stringify(String(pdfHref));
  const svgLit = svgSrc == null ? 'null' : JSON.stringify(String(svgSrc));
  const hasPdf = pdfHref != null ? 'true' : 'false';
  const hasSvg = svgSrc != null ? 'true' : 'false';
  return [
    '<!doctype html><meta charset="utf-8">',
    '<style>body{margin:0;background:#fff}</style>',
    `<canvas id="c" width="${w}" height="${h}"></canvas>`,
    `<div id="s" style="width:${w}px;height:${h}px;background:#fff"></div>`,
    '<script type="module">',
    '  const canvas = document.getElementById(\'c\');',
    '  const box = document.getElementById(\'s\');',
    '  window.__renderDone = (async () => {',
    '    try {',
    `      if (${hasPdf}) {`,
    `        const pdfjs = await import(${modLit});`,
    `        const wUrl = ${modLit}.replace(/pdf\\.mjs$/, 'pdf.worker.min.mjs');`,
    '        const wSrc = await (await fetch(wUrl)).text();',
    '        const wBlob = new Blob([wSrc], { type: \'text/javascript\' });',
    '        pdfjs.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(wBlob), { type: \'module\' });',
    `        const doc = await pdfjs.getDocument({ url: ${pdfLit}, isEvalSupported: false }).promise;`,
    '        window.__pdfPageCount = doc.numPages;',
    '        const page = await doc.getPage(Number(new URLSearchParams(location.search).get(\'p\') || \'1\'));',
    '        const v1 = page.getViewport({ scale: 1 });',
    `        const scale = ${h} / v1.height;`,
    '        const v2 = page.getViewport({ scale });',
    '        canvas.width = Math.round(v2.width); canvas.height = Math.round(v2.height);',
    '        await page.render({ canvasContext: canvas.getContext(\'2d\'), viewport: v2 }).promise;',
    '      }',
    `      if (${hasSvg}) box.innerHTML = ${svgLit};`,
    '      return \'ok\';',
    '    } catch (e) { return \'ERR \' + (e && e.message); }',
    '  })();',
    '</scr' + 'ipt>',
  ].join('\n');
};

async function shot(win, url, outPng, extraQuery = '') {
  const capture = async () => {
    await new Promise((rr) => setTimeout(rr, 400)); // 合成稳定（首页空白竞态——视觉复核第一轮实证）
    const buf = await win.webContents.capturePage();
    writeFileSync(outPng, buf.toPNG());
    return buf.toPNG().length;
  };
  await win.loadURL('file://' + url.replace(/\\/g, '/') + extraQuery);
  const r = await win.webContents.executeJavaScript('window.__renderDone');
  if (r !== 'ok') throw new Error('render ' + r);
  const size = await capture();
  if (size < 11000) { // 与已知纯白截图同量级——重采一次（首渲染合成竞态）
    await new Promise((rr) => setTimeout(rr, 600));
    await capture();
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1400, height: 1560, useContentSize: true, webPreferences: { sandbox: false } });
  const pdfjsModUrl = new URL('file:///' + resolve(__dirname, '../../node_modules/pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/')).href;
  const index = [];
  for (const caseName of readdirSync(outRoot)) {
    const caseDir = join(outRoot, caseName);
    const pdfPath = join(caseDir, `${caseName}.pdf`);
    const ownDir = join(caseDir, 'own-slides');
    if (!existsSync(pdfPath) || !existsSync(ownDir)) continue;
    const cmpDir = join(caseDir, 'compare');
    mkdirSync(cmpDir, { recursive: true });
    const meta = JSON.parse(readFileSync(join(ownDir, 'meta.json'), 'utf8'));
    const svgs = readdirSync(ownDir).filter((f) => f.endsWith('.svg')).sort();
    // PDF 页数（首开探测）
    const countHtml = PAGE_HTML(pdfjsModUrl, 'file:///' + pdfPath.replace(/\\/g, '/'), null, 320, 180);
    const probePath = join(cmpDir, '_probe.html');
    writeFileSync(probePath, countHtml);
    await win.loadURL('file:///' + probePath.replace(/\\/g, '/'));
    const pdfPages = await win.webContents.executeJavaScript('window.__renderDone.then(() => window.__pdfPageCount).catch((e) => "ERR" + e.message)');
    const n = Math.min(Number(pdfPages) || svgs.length, svgs.length, 12); // 比对前 N 页（材料完整归档在 out/）
    for (let i = 0; i < n; i += 1) {
      const svg = readFileSync(join(ownDir, svgs[i]), 'utf8');
      const w = meta.pxW, h = meta.pxH;
      const loHtml = PAGE_HTML(pdfjsModUrl, 'file:///' + pdfPath.replace(/\\/g, '/'), null, w, h);
      console.log('[dbg] pdfjsModUrl=', String(pdfjsModUrl).slice(0, 70));
      const ownHtml = PAGE_HTML(pdfjsModUrl, null, svg, w, h);
      writeFileSync(join(cmpDir, '_lo.html'), loHtml);
      writeFileSync(join(cmpDir, '_own.html'), ownHtml);
      await shot(win, join(cmpDir, '_lo.html'), join(cmpDir, `page-${String(i + 1).padStart(2, '0')}-lo.png`), `?p=${i + 1}`);
      await shot(win, join(cmpDir, '_own.html'), join(cmpDir, `page-${String(i + 1).padStart(2, '0')}-own.png`));
      index.push({ case: caseName, page: i + 1, lo: `page-${String(i + 1).padStart(2, '0')}-lo.png`, own: `page-${String(i + 1).padStart(2, '0')}-own.png` });
      console.log(`[compare] ${caseName} 第 ${i + 1}/${n} 页`);
    }
    writeFileSync(join(cmpDir, 'compare-index.json'), JSON.stringify({ pdfPages: Number(pdfPages) || null, ownSlides: svgs.length, compared: n, pages: index.filter((x) => x.case === caseName) }, null, 2));
    index.length = 0;
  }
  app.exit(0);
}).catch((e) => { console.error('FAIL', e); app.exit(1); });
