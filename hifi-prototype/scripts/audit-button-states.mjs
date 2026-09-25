/**
 * 主按钮「启用态 vs 禁用态」对照。
 *
 * 背景：用户反馈"新建群聊、发送、保存、引用等按钮的颜色你还没改"。
 * 实测四个按钮**都带 `--grad`**，但其中「创建」（未选成员）与「发送」
 * （输入为空）默认处于 `disabled`，而 `.btn:disabled { opacity: .5 }`
 * 会把渐变压成一片灰蓝 —— 观感上就像"没上色"。
 *
 * 本脚本把同一按钮的两种状态并排拍下来，判定问题出在渐变本身还是禁用态。
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

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

/* ---------- 新建私聊：禁用（未选成员） ---------- */
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/dm?recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('新建私聊')); if(b)b.click(); return !!b; })()`);
await sleep(1200);
console.log('创建(未选成员):', JSON.stringify(await ev(`(() => {
  const b = document.querySelector('.modal .btn.primary');
  const cs = getComputedStyle(b);
  return { disabled: b.disabled, opacity: cs.opacity, color: cs.color, img: cs.backgroundImage.replace(/\\s+/g,' ').slice(0,58) };
})()`)));
let shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  writeFileSync(join(out, 'state-full.png'), Buffer.from(shot.result.data, 'base64'));
  const r = await ev(`(() => { const b=document.querySelector('.modal .btn.primary'); const q=b.getBoundingClientRect(); return {x:q.x,y:q.y,w:q.width,h:q.height}; })()`);
  if (r) crop(join(out, 'state-full.png'), join(out, 'state-create-disabled.png'), r.x*2-4, r.y*2-4, r.w*2+8, r.h*2+8, 8);
}

/* ---------- 新建私聊：启用（选一个成员） ---------- */
await ev(`(() => {
  const boxes = [...document.querySelectorAll('.modal input[type="checkbox"]')];
  if (boxes[0]) { boxes[0].click(); return true; }
  return false;
})()`);
await sleep(900);
console.log('创建(已选成员):', JSON.stringify(await ev(`(() => {
  const b = document.querySelector('.modal .btn.primary');
  const cs = getComputedStyle(b);
  return { disabled: b.disabled, opacity: cs.opacity, color: cs.color, img: cs.backgroundImage.replace(/\\s+/g,' ').slice(0,58) };
})()`)));
shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  writeFileSync(join(out, 'state-full.png'), Buffer.from(shot.result.data, 'base64'));
  const r = await ev(`(() => { const b=document.querySelector('.modal .btn.primary'); const q=b.getBoundingClientRect(); return {x:q.x,y:q.y,w:q.width,h:q.height}; })()`);
  if (r) crop(join(out, 'state-full.png'), join(out, 'state-create-enabled.png'), r.x*2-4, r.y*2-4, r.w*2+8, r.h*2+8, 8);
}

/* ---------- 发送：禁用 vs 启用 ---------- */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
console.log('发送(空输入):', JSON.stringify(await ev(`(() => {
  const b = document.querySelector('.col-thread .composer-toolbar .btn.primary');
  const cs = getComputedStyle(b);
  return { disabled: b.disabled, opacity: cs.opacity };
})()`)));
shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  writeFileSync(join(out, 'state-full.png'), Buffer.from(shot.result.data, 'base64'));
  const r = await ev(`(() => { const b=document.querySelector('.col-thread .composer-toolbar .btn.primary'); const q=b.getBoundingClientRect(); return {x:q.x,y:q.y,w:q.width,h:q.height}; })()`);
  if (r) crop(join(out, 'state-full.png'), join(out, 'state-send-disabled.png'), r.x*2-4, r.y*2-4, r.w*2+8, r.h*2+8, 8);
}

await ev(`(() => { const ta=document.querySelector('.col-thread .composer-input');
  const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  s.call(ta,'测试'); ta.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(900);
console.log('发送(有输入):', JSON.stringify(await ev(`(() => {
  const b = document.querySelector('.col-thread .composer-toolbar .btn.primary');
  const cs = getComputedStyle(b);
  return { disabled: b.disabled, opacity: cs.opacity };
})()`)));
shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  writeFileSync(join(out, 'state-full.png'), Buffer.from(shot.result.data, 'base64'));
  const r = await ev(`(() => { const b=document.querySelector('.col-thread .composer-toolbar .btn.primary'); const q=b.getBoundingClientRect(); return {x:q.x,y:q.y,w:q.width,h:q.height}; })()`);
  if (r) crop(join(out, 'state-full.png'), join(out, 'state-send-enabled.png'), r.x*2-4, r.y*2-4, r.w*2+8, r.h*2+8, 8);
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
