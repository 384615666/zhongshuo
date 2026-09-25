/**
 * build-index.mjs —— 生成对比台 index.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '_src', 'index.css'), 'utf8');

/** 顺序即默认展示顺序；可自由拖动改判，此处按题面顺序排列 */
const SIDES = [
  { rank: 'A', name: 'Mimo', via: 'zhongshuo-frontend-design-spec-zcode.md', file: 'mimo.html', note: '静默的仪器 · 灰阶带蓝调' },
  { rank: 'B', name: 'Kimi K3', via: 'zhongshuo-visual-design-spec-v1.md', file: 'kimi.html', note: '面差分层 · 一屏一焦点' },
  { rank: 'C', name: 'hy4', via: 'design-spec/DESIGN.md v3.0', file: 'hy4-fixed.html', note: '连续外壳 · 浅白底 · 蓝→淡绿渐变主色' },
];

const cells = SIDES.map((s) => `
      <section class="cell" data-side="${s.rank}">
        <div class="cell-head">
          <span class="rank">${s.rank}</span>
          <span class="name">${s.name}</span>
          <span class="via">${s.via}</span>
          <span class="grow"></span>
          <span class="ratio">1372×872</span>
          <a class="open" href="${s.file}" target="_blank" rel="noopener">单独打开 ↗</a>
        </div>
        <div class="frame"><div class="scaler"><iframe data-file="${s.file}" title="${s.name}" loading="eager"></iframe></div></div>
      </section>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>众说 · 回复串界面 · 三套视觉规范对比台</title>
<style>
${css}
</style>
</head>
<body>

<header>
  <span class="brand">众说 · 打开回复串界面<span>三套视觉规范对照 · 同一 DOM，只有样式不同</span></span>
  <span class="spacer"></span>

  <div class="seg" id="side-filter" title="只显示某一套">
    <button data-side="all" class="on">三套并排</button>
    ${SIDES.map((s) => `<button data-side="${s.rank}">${s.rank} ${s.name}</button>`).join('\n    ')}
  </div>

  <div class="seg" id="theme-switch" title="浅色 / 深色">
    <button data-theme="light" class="on">浅色</button>
    <button data-theme="dark">深色</button>
  </div>

  <div class="layout" id="layout-switch" title="并排 / 单栏 1:1">
    <button data-layout="side" class="on">并排</button>
    <button data-layout="single">1:1</button>
  </div>

  <span class="tip">按 <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 单看 · 按 <kbd>D</kbd> 切深浅</span>
</header>

<div class="stage" id="stage" data-layout="side">
${cells}
</div>

<div class="notice" id="notice"></div>

<script>
  var NATIVE_W = 1372, NATIVE_H = 872;
  var stage = document.getElementById('stage');
  var theme = 'light';

  function layout() {
    var single = document.querySelector('#layout-switch .on').dataset.layout === 'single';

    document.querySelectorAll('.cell').forEach(function (cell) {
      if (cell.style.display === 'none') return;
      var f = cell.querySelector('.frame');
      var availW = f.clientWidth - 24, availH = f.clientHeight - 24;
      var k = single ? 1 : Math.min(availW / NATIVE_W, availH / NATIVE_H);
      cell.querySelector('.scaler').style.setProperty('--k', Math.max(k, .1).toFixed(4));
    });
  }

  function measure() {}

  function load(refresh) {
    var side = document.querySelector('#side-filter .on').dataset.side;
    var layoutName = document.querySelector('#layout-switch .on').dataset.layout;
    stage.dataset.layout = layoutName;

    document.querySelectorAll('.cell').forEach(function (cell) {
      var show = side === 'all' || cell.dataset.side === side;
      cell.style.display = show ? '' : 'none';
      if (!show && !refresh) return;
      if (!show) return;
      var frame = cell.querySelector('iframe');
      var want = frame.dataset.file + (theme === 'dark' ? '?theme=dark' : '');
      if (frame.dataset.loaded !== want) {
        frame.dataset.loaded = want;
        frame.src = want;
      }
    });
    requestAnimationFrame(layout);
  }

  document.querySelectorAll('iframe').forEach(function (f) {
    f.addEventListener('load', function () { requestAnimationFrame(layout); });
  });

  function wire(id, after) {
    document.getElementById(id).addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
      load(true);
      after && after();
    });
  }

  wire('side-filter');
  wire('theme-switch', function () {
    theme = document.querySelector('#theme-switch .on').dataset.theme;
  });
  wire('layout-switch');

  var notice = document.getElementById('notice');
  function flash(msg) {
    notice.textContent = msg;
    notice.classList.add('show');
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { notice.classList.remove('show'); }, 1400);
  }

  addEventListener('resize', layout);

  var ORDER = ['all', ${SIDES.map((s) => `'${s.rank}'`).join(', ')}];
  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, textarea')) return;
    if (e.key >= '1' && e.key <= String(ORDER.length - 1)) {
      var b = document.querySelector('#side-filter button[data-side="' + ORDER[+e.key] + '"]');
      if (b) { b.click(); flash('只看 ' + b.textContent.trim()); }
    } else if (e.key === '0') {
      document.querySelector('#side-filter button[data-side="all"]').click();
      flash('三套并排');
    } else if (e.key === 'd' || e.key === 'D') {
      var t = document.querySelector('#theme-switch button' + (theme === 'light' ? '[data-theme="dark"]' : '[data-theme="light"]'));
      t.click(); flash(theme === 'light' ? '切换为深色' : '切换为浅色');
    }
  });

  load();
</script>
</body>
</html>
`;

writeFileSync(join(here, 'index.html'), html, 'utf8');
console.log('built index.html');
