/**
 * 视觉细节放大对比（诊断用）。
 *
 * 用途：把"我渲染的样子"与"参考图里的样子"裁到同一区域放大，
 * 逐像素对照。规范明确要求"实现选中态时对照 approved-selected-gradient.png 验收"，
 * 肉眼看缩略图容易被骗（110×40 的取样图放大后差别才看得出来）。
 *
 * 用法：node scripts/crop-compare.mjs
 * 输出：screenshots-visual/cmp-*.png
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-visual');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { pending.delete(i); res({}); }, 20000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');

/** 用 dpr=2 整页出图，再用 .NET 裁剪 → 得到清晰的局部放大 */
async function captureHiDpi(name) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1372, height: 872, deviceScaleFactor: 2, mobile: false,
  });
  await ev(`window.dispatchEvent(new Event('resize')); true`);
  await sleep(900);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r.result?.data) { console.log(`MISS ${name}`); return null; }
  const p = join(outDir, `${name}.png`);
  writeFileSync(p, Buffer.from(r.result.data, 'base64'));
  return p;
}

/** 用 PowerShell + System.Drawing 裁剪并放大（2x 再放大 3x = 6x 观感） */
function crop(src, dst, x, y, w, h, scale) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Bitmap]::FromFile('${src.replace(/'/g, "''")}')
$rect=New-Object System.Drawing.Rectangle -ArgumentList @(${x},${y},${w},${h})
$crop=$src.Clone($rect,$src.PixelFormat)
$out=New-Object System.Drawing.Bitmap -ArgumentList @([int](${w}*${scale}),[int](${h}*${scale}))
$g=[System.Drawing.Graphics]::FromImage($out)
$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half
$g.DrawImage($crop,0,0,$out.Width,$out.Height)
$out.Save('${dst.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$out.Dispose();$crop.Dispose();$src.Dispose()
`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

/* ---------- 场景：房间 + 回复串（L2） ---------- */
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);
await ev(`window.dispatchEvent(new Event('resize')); true`);
await sleep(800);

/* 活跃页签的实际位置（CSS 像素 × dpr2 = 物理像素） */
const rects = await ev(`(() => {
  const g = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return {
    threadTabOn: g('.thread-tab.on'),
    threadTabs: g('.thread-tabs'),
    roomTabOn: g('.col-main .thread-tab.on'),
    sideActive: g('.side-item.active'),
    poolComposer: g('.col-main .composer-box'),
    threadComposer: g('.col-thread .composer-box'),
    msgText: g('.col-thread .msg-text'),
    msg: g('.col-thread .msg'),
    colThread: g('.col-thread'),
    colMain: g('.col-main'),
  };
})()`);
console.log('rects:', JSON.stringify(rects, null, 1));

const hi = await captureHiDpi('cmp-hidpi-full');
if (hi && rects) {
  const S = 2; // dpr
  const pad = 6;
  const mk = (name, r, scale = 4) => {
    if (!r) { console.log(`skip ${name} (not found)`); return; }
    crop(hi, join(outDir, `${name}.png`),
      Math.max(0, (r.x - pad) * S), Math.max(0, (r.y - pad) * S),
      (r.w + pad * 2) * S, (r.h + pad * 2) * S, scale);
    console.log(`OK   ${name}  (${r.w}x${r.h} css)`);
  };
  mk('cmp-active-thread-tab', rects.threadTabOn, 5);
  mk('cmp-active-room-tab', rects.roomTabOn, 5);
  mk('cmp-side-active', rects.sideActive, 4);
  mk('cmp-thread-composer', rects.threadComposer, 2);
  mk('cmp-pool-composer', rects.poolComposer, 2);
  mk('cmp-thread-msg', rects.msg, 3);
}

await send('Emulation.setDeviceMetricsOverride', {
  width: 1372, height: 872, deviceScaleFactor: 1, mobile: false,
});
console.log(`\n输出 → ${outDir}`);
ws.close();
process.exit(0);

