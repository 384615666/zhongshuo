/**
 * 「任务 / 讨论」分段控件：参考图 vs 我们实现，同尺度并排。
 *
 * 用户反馈该控件"没选中和选中的时候颜色完全不一样，选中后直接全白看不见"。
 * 先各自裁出同尺寸特写，再逐像素比结构（有没有灰槽、激活块是什么色）。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-visual');
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';

function crop(src, dst, x, y, w, h, s) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=[System.Drawing.Bitmap]::FromFile('${src}')`,
    `$rect=New-Object System.Drawing.Rectangle -ArgumentList @(${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)})`,
    '$crop=$src.Clone($rect,$src.PixelFormat)',
    `$out=New-Object System.Drawing.Bitmap -ArgumentList @([int](${Math.round(w)}*${s}),[int](${Math.round(h)}*${s}))`,
    '$g=[System.Drawing.Graphics]::FromImage($out)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
    '$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half',
    '$g.DrawImage($crop,0,0,$out.Width,$out.Height)',
    `$out.Save('${dst}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$out.Dispose();$crop.Dispose();$src.Dispose()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

/* ---------- 参考图：整条工具条（宽一点，看到容器边界） ---------- */
crop(REF, join(out, 'seg-ref-wide.png'), 250, 796, 200, 64, 8);
console.log('OK  seg-ref-wide  (参考图 250,796 起 200x64 @8x)');

/* ---------- 我们的渲染 ---------- */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
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

await send('Runtime.enable');
await send('Page.enable');
const DPR = 2;
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: DPR, mobile: false });
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);

/* 报告该控件的完整计算样式 */
const info = await ev(`(() => {
  const seg = document.querySelector('.composer-toolbar .seg');
  if (!seg) return { found: false };
  const r = seg.getBoundingClientRect();
  const cs = getComputedStyle(seg);
  const btns = [...seg.querySelectorAll('button')].map(b => {
    const bs = getComputedStyle(b);
    return { text: b.textContent.trim(), on: b.classList.contains('on'),
             color: bs.color, bg: bs.backgroundColor, shadow: bs.boxShadow.slice(0, 40), weight: bs.fontWeight };
  });
  return { found: true, x: r.x, y: r.y, w: r.width, h: r.height,
           segBg: cs.backgroundColor, segBorder: cs.borderColor, segRadius: cs.borderRadius, btns };
})()`);
console.log('\n我们的分段控件：', JSON.stringify(info, null, 1));

if (info?.found) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const full = join(out, 'seg-full.png');
  writeFileSync(full, Buffer.from(shot.result.data, 'base64'));
  crop(full, join(out, 'seg-mine-wide.png'),
    (info.x - 6) * DPR, (info.y - 10) * DPR, (info.w + 12) * DPR, (info.h + 20) * DPR, 4);
  console.log('OK  seg-mine-wide');
}

/* 点「讨论」，看选中态切换后的样子 */
await ev(`[...document.querySelectorAll('.composer-toolbar .seg button')].find(b=>b.textContent.includes('讨论'))?.click()`);
await sleep(800);
const info2 = await ev(`(() => {
  const seg = document.querySelector('.composer-toolbar .seg');
  if (!seg) return { found: false };
  const r = seg.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height,
    btns: [...seg.querySelectorAll('button')].map(b => ({ text: b.textContent.trim(),
      on: b.classList.contains('on'), bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color })) };
})()`);
console.log('\n点「讨论」后：', JSON.stringify(info2, null, 1));
if (info2?.found) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const full = join(out, 'seg-full2.png');
  writeFileSync(full, Buffer.from(shot.result.data, 'base64'));
  crop(full, join(out, 'seg-mine-discussion.png'),
    (info2.x - 6) * DPR, (info2.y - 10) * DPR, (info2.w + 12) * DPR, (info2.h + 20) * DPR, 4);
  console.log('OK  seg-mine-discussion');
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
