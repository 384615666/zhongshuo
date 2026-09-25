/**
 * 主按钮颜色像素级核对。
 *
 * 用户反馈"新建群聊、发送、保存、引用等按钮的颜色你还没改"。
 * 需要判定：是**渐变没生效**，还是**生效了但被 disabled 的 opacity 冲淡**。
 *
 * 做法：把每个主操作按钮在**启用态**与**禁用态**各取一次实际渲染像素，
 * 与参考图发送按钮的实测值并排对照。
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);

/** 取按钮在页面上的物理像素包围盒（dpr=2） */
const rectOf = (sel) => ev(`(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return { x: r.x, y: r.y, w: r.width, h: r.height, disabled: e.disabled === true, opacity: cs.opacity,
           img: cs.backgroundImage.replace(/\\s+/g,' ').slice(0, 90) };
})()`);

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

/* ---------- 1. 发送按钮：禁用态（空输入） ---------- */
const disabledRect = await rectOf('.col-thread .composer-toolbar .btn.primary');
console.log('发送(禁用态):', JSON.stringify(disabledRect));
let hi = await send('Page.captureScreenshot', { format: 'png' });
if (hi.result?.data) writeFileSync(join(out, 'cmp-hidpi-full.png'), Buffer.from(hi.result.data, 'base64'));
if (disabledRect) {
  crop(join(out, 'cmp-hidpi-full.png'), join(out, 'btn-send-disabled.png'),
    disabledRect.x * 2 - 4, disabledRect.y * 2 - 4, disabledRect.w * 2 + 8, disabledRect.h * 2 + 8, 8);
  console.log('OK  btn-send-disabled');
}

/* ---------- 2. 发送按钮：启用态（有输入） ---------- */
await ev(`(() => {
  const ta = document.querySelector('.col-thread .composer-input');
  const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  s.call(ta, '测试'); ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(900);
const enabledRect = await rectOf('.col-thread .composer-toolbar .btn.primary');
console.log('发送(启用态):', JSON.stringify(enabledRect));
hi = await send('Page.captureScreenshot', { format: 'png' });
if (hi.result?.data) writeFileSync(join(out, 'cmp-hidpi-full.png'), Buffer.from(hi.result.data, 'base64'));
if (enabledRect) {
  crop(join(out, 'cmp-hidpi-full.png'), join(out, 'btn-send-enabled.png'),
    enabledRect.x * 2 - 4, enabledRect.y * 2 - 4, enabledRect.w * 2 + 8, enabledRect.h * 2 + 8, 8);
  console.log('OK  btn-send-enabled');
}

/* ---------- 3. 引用按钮 ---------- */
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);
await ev(`(() => { const c=[...document.querySelectorAll('.msg-attach')].find(x=>x.textContent.includes('预览交互设计说明')); if(c)c.click(); return !!c; })()`);
await sleep(1400);
const quoteRect = await rectOf('.preview-tools .btn.primary');
console.log('引用:', JSON.stringify(quoteRect));
hi = await send('Page.captureScreenshot', { format: 'png' });
if (hi.result?.data) writeFileSync(join(out, 'cmp-hidpi-full.png'), Buffer.from(hi.result.data, 'base64'));
if (quoteRect) {
  crop(join(out, 'cmp-hidpi-full.png'), join(out, 'btn-quote.png'),
    quoteRect.x * 2 - 4, quoteRect.y * 2 - 4, quoteRect.w * 2 + 8, quoteRect.h * 2 + 8, 8);
  console.log('OK  btn-quote');
}

/* ---------- 4. 保存按钮（房间设置，启用态） ---------- */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await sleep(1600);
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('房间设置')); if(b)b.click(); return !!b; })()`);
await sleep(1100);
const saveRect = await rectOf('.modal .btn.primary');
console.log('保存:', JSON.stringify(saveRect));
hi = await send('Page.captureScreenshot', { format: 'png' });
if (hi.result?.data) writeFileSync(join(out, 'cmp-hidpi-full.png'), Buffer.from(hi.result.data, 'base64'));
if (saveRect) {
  crop(join(out, 'cmp-hidpi-full.png'), join(out, 'btn-save.png'),
    saveRect.x * 2 - 4, saveRect.y * 2 - 4, saveRect.w * 2 + 8, saveRect.h * 2 + 8, 8);
  console.log('OK  btn-save');
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
