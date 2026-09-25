/**
 * 分段控件（任务/讨论、预览/源码）在**真实桌面窗口 1:1** 下的可辨度。
 *
 * 用户反馈："没选中和选中的时候，颜色和我给你的截图完全不一样，
 * 选中后直接全白什么都看不见了"。
 *
 * 关键怀疑：激活块是 `--bg-surface`（纯白），槽是 `--bg-surface-3`（#eef4f7），
 * 两者对比度极低 —— 白块压在近白槽上，视觉上等于没有。本脚本量出这个对比度，
 * 并给出 1:1 与放大两种截图供肉眼确认。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-desktop-preview');
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const PORT = '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function conn() {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = l.find((t) => t.type === 'page');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; const t = setTimeout(() => { pending.delete(i); res({}); }, 25000);
    pending.set(i, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
  };
  return { ws, send, ev };
}

function crop(src, dst, x, y, w, h, scale) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=[System.Drawing.Bitmap]::FromFile('${src}')`,
    `$rect=New-Object System.Drawing.Rectangle -ArgumentList @(${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)})`,
    '$crop=$src.Clone($rect,$src.PixelFormat)',
    `$out=New-Object System.Drawing.Bitmap -ArgumentList @([int](${Math.round(w)}*${scale}),[int](${Math.round(h)}*${scale}))`,
    '$g=[System.Drawing.Graphics]::FromImage($out)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
    '$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half',
    '$g.DrawImage($crop,0,0,$out.Width,$out.Height)',
    `$out.Save('${dst}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$out.Dispose();$crop.Dispose();$src.Dispose()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

/** 采样 PNG 上若干点，返回颜色 */
function samplePoints(file, pts) {
  const list = pts.map((p) => `@(${Math.round(p[0])},${Math.round(p[1])},'${p[2]}')`).join(',');
  const ps = `
Add-Type -AssemblyName System.Drawing
function Hex($c){ '#{0:x2}{1:x2}{2:x2}' -f $c.R,$c.G,$c.B }
$b=[System.Drawing.Bitmap]::FromFile('${file}')
foreach($p in @(${list})){
  $x=[int]$p[0]; $y=[int]$p[1]
  if($x -lt 0){$x=0}; if($y -lt 0){$y=0}
  if($x -ge $b.Width){$x=$b.Width-1}; if($y -ge $b.Height){$y=$b.Height-1}
  $c=$b.GetPixel($x,$y)
  Write-Output ("{0,-22} ({1,5},{2,5}) {3}" -f $p[2],$x,$y,(Hex $c))
}
$b.Dispose()`;
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
}

const c = await conn();
await c.ev(`window.zhongshuo?.window.show()`);
await c.ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; location.reload(); true`);
c.ws.close();
await sleep(3800);

const c2 = await conn();
const DPR = (await c2.ev('window.devicePixelRatio')) || 1;

const info = await c2.ev(`(() => {
  const seg = document.querySelector('.composer-toolbar .seg');
  if (!seg) return { found: false };
  const r = seg.getBoundingClientRect();
  const cs = getComputedStyle(seg);
  const btns = [...seg.querySelectorAll('button')].map(b => {
    const q = b.getBoundingClientRect();
    const bs = getComputedStyle(b);
    return { text: b.textContent.trim(), on: b.classList.contains('on'),
             bx: q.x, by: q.y, bw: q.width, bh: q.height,
             bg: bs.backgroundColor, color: bs.color, weight: bs.fontWeight,
             shadow: bs.boxShadow };
  });
  return { found: true, x: r.x, y: r.y, w: r.width, h: r.height,
           segBg: cs.backgroundColor, segBorder: cs.borderColor,
           padding: cs.padding, gap: cs.gap, btns,
           composerBox: (() => { const cb = document.querySelector('.composer-box');
             const cbs = getComputedStyle(cb);
             return { border: cbs.borderColor, radius: cbs.borderRadius, shadow: cbs.boxShadow.slice(0,60), bg: cbs.backgroundColor }; })() };
})()`);
console.log('DPR =', DPR);
console.log(JSON.stringify(info, null, 1));

const shot = await c2.send('Page.captureScreenshot', { format: 'png' });
const full = join(out, 'seg-desktop-full.png');
writeFileSync(full, Buffer.from(shot.result.data, 'base64'));

if (info?.found) {
  // 1:1（乘以 dpr 后不再放大）
  crop(full, join(out, 'seg-desktop-1to1.png'),
    info.x * DPR, info.y * DPR, info.w * DPR, info.h * DPR, 1);
  // 6x 放大
  crop(full, join(out, 'seg-desktop-6x.png'),
    (info.x - 3) * DPR, (info.y - 3) * DPR, (info.w + 6) * DPR, (info.h + 6) * DPR, 6);

  /* 采样：槽（seg 左边距内）与激活块（按钮上缘内侧，避开文字） */
  const first = info.btns[0];
  const pts = [
    [info.x * DPR + 1, (info.y + info.h / 2) * DPR, '槽(seg 左内边距)'],
    [(info.x + info.w - 1) * DPR, (info.y + info.h / 2) * DPR, '槽(seg 右内边距)'],
    [(first.bx + first.bw / 2) * DPR, (first.by + 3) * DPR, '激活块(任务上缘)'],
    [(first.bx + first.bw / 2) * DPR, (first.by + first.bh - 3) * DPR, '激活块(任务下缘)'],
    [(info.x + info.w / 2) * DPR, (info.y + info.h / 2) * DPR, '两段之间(槽)'],
  ];
  console.log('\n=== 像素采样（1:1 实际渲染）===');
  console.log(samplePoints(full, pts));
}
c2.ws.close();
process.exit(0);
