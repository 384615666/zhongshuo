/**
 * 工具条（"按钮"最集中的地方）并排对照。
 *
 * 用户反馈"按钮根本没有按我截图的背景色来做"。工具条里有
 * 任务/讨论（分段控件）、方式芯片、权限档位、发送按钮 —— 逐个对照。
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

/* 参考图：中列底部整条输入区（含工具条） */
crop(REF, join(out, 'ref-composer-strip.png'), 250, 770, 508, 74, 3);
console.log('OK  ref-composer-strip');

/* ---------- 我的渲染 ---------- */
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

// 输入文字让按钮处于启用态（否则 opacity .5 会干扰颜色判断）
await ev(`(() => {
  for (const sel of ['.col-main .composer-input', '.col-thread .composer-input']) {
    const ta = document.querySelector(sel); if (!ta) continue;
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, '测试内容'); ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
})()`);
await sleep(800);

const rect = await ev(`(() => {
  const b = document.querySelector('.col-main .composer');
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`);
console.log('my composer rect:', JSON.stringify(rect));

await send('Emulation.setDeviceMetricsOverride', { width: 1372, height: 872, deviceScaleFactor: 2, mobile: false });
await ev(`window.dispatchEvent(new Event('resize')); true`);
await sleep(900);
const r = await send('Page.captureScreenshot', { format: 'png' });
const hi = join(out, 'cmp-hidpi-full.png');
if (r.result?.data) writeFileSync(hi, Buffer.from(r.result.data, 'base64'));
await send('Emulation.setDeviceMetricsOverride', { width: 1372, height: 872, deviceScaleFactor: 1, mobile: false });

if (rect && r.result?.data) {
  const S = 2;
  crop(hi, join(out, 'my-composer-strip.png'), rect.x * S, rect.y * S, rect.w * S, rect.h * S, 3);
  console.log('OK  my-composer-strip');
}

/* 逐个按钮报告实际底色 */
const btnColors = await ev(`(() => {
  const pick = (sel, label) => {
    const e = document.querySelector(sel);
    if (!e) return { label, missing: true };
    const cs = getComputedStyle(e);
    return {
      label,
      bg: cs.backgroundColor,
      img: cs.backgroundImage.replace(/\\s+/g, ' ').slice(0, 64),
      opacity: cs.opacity,
      color: cs.color,
      radius: cs.borderRadius,
      border: cs.borderColor,
    };
  };
  return [
    pick('.col-main .composer-toolbar .seg', '分段控件-槽'),
    pick('.col-main .composer-toolbar .seg button.on', '分段控件-激活(任务)'),
    pick('.col-main .composer-toolbar .seg button:not(.on)', '分段控件-未激活(讨论)'),
    pick('.col-main .method-chip', '方式芯片'),
    pick('.col-main .access-trigger', '权限档位'),
    pick('.col-main .composer-toolbar .btn.primary', '发送按钮'),
    pick('.col-main .icon-btn', '图标按钮'),
  ];
})()`);
console.log('\n=== 工具条内各控件的实际底色 ===');
for (const b of btnColors ?? []) {
  if (b.missing) { console.log(`--   ${b.label}`); continue; }
  console.log(`${b.label.padEnd(22)} op=${b.opacity} r=${b.radius.padEnd(8)} bg=${b.bg.padEnd(24)} img=${b.img}`);
}
ws.close();
process.exit(0);
