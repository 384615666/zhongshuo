/**
 * 按钮/选中态放大对照（诊断用）。
 *
 * 把"我渲染的"与"参考图里的"同类控件裁到同一尺寸放大并排看。
 * 用户报告"按钮没有按截图的背景色来做"，需要肉眼可判的证据，
 * 而不是只报 computed 值。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-visual');
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function crop(src, dst, x, y, w, h, scale) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=[System.Drawing.Bitmap]::FromFile('${src}')`,
    `$rect=New-Object System.Drawing.Rectangle -ArgumentList @(${x},${y},${w},${h})`,
    '$crop=$src.Clone($rect,$src.PixelFormat)',
    `$out=New-Object System.Drawing.Bitmap -ArgumentList @([int](${w}*${scale}),[int](${h}*${scale}))`,
    '$g=[System.Drawing.Graphics]::FromImage($out)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
    '$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half',
    '$g.DrawImage($crop,0,0,$out.Width,$out.Height)',
    `$out.Save('${dst}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$out.Dispose();$crop.Dispose();$src.Dispose()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
}

/* ---------- 参考图：发送按钮 ---------- */
// 从 ref-pool-area 观察：发送按钮在中列右下，绝对坐标约 x=690..752, y=812..836
crop(REF, join(out, 'ref-send-btn.png'), 686, 808, 66, 30, 8);
console.log('OK  ref-send-btn');

/* ---------- 我的渲染：抓 dpr=2 整图再裁 ---------- */
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; const t = setTimeout(() => { pending.delete(i); res({}); }, 20000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);
// 临时放宽 .workspace 以便看清底部按钮（诊断用，不写回）
await ev(`document.querySelector('.workspace').style.flexWrap='nowrap'; true`);
await sleep(900);

const rects = await ev(`(() => {
  const g = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  return {
    sendBtn: g('.composer-toolbar .btn.primary'),
    poolSend: g('.col-main .composer-toolbar .btn.primary'),
    threadTabOn: g('.thread-tab.on'),
    segOn: g('.seg button.on'),
  };
})()`);
console.log('my rects:', JSON.stringify(rects));

await send('Emulation.setDeviceMetricsOverride', { width: 1372, height: 872, deviceScaleFactor: 2, mobile: false });
await ev(`window.dispatchEvent(new Event('resize')); true`);
await sleep(900);
const r = await send('Page.captureScreenshot', { format: 'png' });
const hi = join(out, 'cmp-hidpi-full.png');
if (r.result?.data) writeFileSync(hi, Buffer.from(r.result.data, 'base64'));
await send('Emulation.setDeviceMetricsOverride', { width: 1372, height: 872, deviceScaleFactor: 1, mobile: false });

const S = 2, pad = 4;
if (rects?.sendBtn && r.result?.data) {
  crop(hi, join(out, 'my-send-btn.png'),
    Math.max(0, (rects.sendBtn.x - pad) * S), Math.max(0, (rects.sendBtn.y - pad) * S),
    (rects.sendBtn.w + pad * 2) * S, (rects.sendBtn.h + pad * 2) * S, 8);
  console.log('OK  my-send-btn');
}
if (rects?.segOn && r.result?.data) {
  crop(hi, join(out, 'my-seg-on.png'),
    Math.max(0, (rects.segOn.x - pad) * S), Math.max(0, (rects.segOn.y - pad) * S),
    (rects.segOn.w + pad * 2) * S, (rects.segOn.h + pad * 2) * S, 8);
  console.log('OK  my-seg-on');
}
ws.close();
process.exit(0);
