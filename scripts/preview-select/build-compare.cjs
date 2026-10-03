/**
 * 预览选型验证（2026-10-03）：把参考列与被测列拼成对比图。
 * office-deck：4 列（REF=PowerPoint 导出 | A=pptx-renderer | B=kit→PDF | LO=全量 LibreOffice）
 * dense/rich：3 列（REF=全量 LO | A | B）。产物：compare/<deck>/page-XX.png
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '../../dist/desktop/preview-select');
const CMP = path.join(ROOT, 'compare');

const decks = [
  {
    name: 'office-deck', pages: 8,
    cols: [
      { label: 'REF PowerPoint', dir: 'ref/office' },
      { label: 'A pptx-renderer', dir: 'route-a/office-deck' },
      { label: 'B kit→PDF', dir: 'route-b/office-deck' },
      { label: 'LO full 26.8', dir: 'lo-full/office-deck' },
    ],
  },
  {
    name: 'dense-deck', pages: 6,
    cols: [
      { label: 'REF LibreOffice-full', dir: 'lo-full/dense-deck' },
      { label: 'A pptx-renderer', dir: 'route-a/dense-deck' },
      { label: 'B kit→PDF', dir: 'route-b/dense-deck' },
    ],
  },
  {
    name: 'rich-deck', pages: 8,
    cols: [
      { label: 'REF LibreOffice-full', dir: 'lo-full/rich-deck' },
      { label: 'A pptx-renderer', dir: 'route-a/rich-deck' },
      { label: 'B kit→PDF', dir: 'route-b/rich-deck' },
    ],
  },
  {
    name: 'word-sample', pages: 1,
    cols: [
      { label: 'REF Word', dir: 'ref/word-pages' },
      { label: 'A docx-preview', dir: 'route-a/word-sample' },
      { label: 'B kit→PDF', dir: 'route-b/word-sample' },
    ],
  },
  {
    name: 'excel-sample', pages: 2,
    cols: [
      { label: 'REF Excel', dir: 'ref/excel-pages' },
      { label: 'B kit→PDF', dir: 'route-b/excel-sample' },
    ],
  },
  {
    name: 'pptxgenjs-tables', pages: 4,
    cols: [
      { label: 'REF PowerPoint', dir: 'ref/pptxgenjs-tables' },
      { label: 'A pptx-renderer', dir: 'route-a/pptxgenjs-tables' },
    ],
  },
];

async function main() {
  const { BrowserWindow } = require('electron');
  const CELL_W = 640, CELL_H = 360, LABEL_H = 34, PAD = 8;
  fs.mkdirSync(CMP, { recursive: true });
  const missing = [];
  const win = new BrowserWindow({ show: false, width: 1400, height: 480, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  for (const deck of decks) {
    for (let p = 1; p <= deck.pages; p++) {
      const file = 'slide-' + String(p).padStart(2, '0') + '.png';
      const cells = deck.cols.map((c) => {
        const fp = path.join(ROOT, c.dir, file);
        if (!fs.existsSync(fp)) { missing.push(c.dir + '/' + file); return null; }
        return { label: c.label, url: pathToFileURL(fp).href };
      });
      if (cells.some((c) => c == null)) continue;
      const width = deck.cols.length * (CELL_W + PAD) + PAD;
      const height = CELL_H + LABEL_H + PAD * 2;
      win.setContentSize(width, height);
      const html = `<!doctype html><meta charset="utf-8"><style>
        body{margin:0;background:#202020;display:flex;padding:${PAD}px;gap:${PAD}px;font-family:Consolas,monospace}
        .cell{width:${CELL_W}px}
        .lbl{height:${LABEL_H - 8}px;color:#fff;font-size:15px;display:flex;align-items:center;justify-content:center}
        img{width:${CELL_W}px;height:${CELL_H}px;object-fit:contain;background:#fff;display:block}
      </style>` + cells.map((c) => `<div class="cell"><div class="lbl">${c.label}</div><img src="${c.url}"></div>`).join('');
      const tmp = path.join(CMP, `_tmp-${deck.name}-${String(p).padStart(2, '0')}.html`);
      fs.writeFileSync(tmp, html);
      await win.loadURL(pathToFileURL(tmp).href);
      await new Promise((r) => setTimeout(r, 250));
      const img = await win.webContents.capturePage();
      const outDir = path.join(CMP, deck.name);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'page-' + String(p).padStart(2, '0') + '.png'), img.toPNG());
      fs.rmSync(tmp, { force: true });
    }
  }
  win.destroy();
  fs.rmSync(path.join(CMP, '_tmp.html'), { force: true });
  for (const f of fs.readdirSync(CMP)) if (f.startsWith('_tmp-')) fs.rmSync(path.join(CMP, f), { force: true });
  console.log('[compare] missing:', JSON.stringify(missing));
  console.log('[compare] done');
  app.exit(0);
}
app.whenReady().then(main).catch((e) => { console.error('[compare] FAILED', e); app.exit(1); });
