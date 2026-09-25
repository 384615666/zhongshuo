/**
 * 复现用户截图 2 的状态：输入区聚焦、有草稿（出现绿色"已保存"勾），
 * 看**发送按钮**是否变成白底白字而"消失"。
 *
 * 用户："选中后直接全白什么都看不见了"
 *
 * 关键假设：`.btn.primary` 的 `background: var(--grad)` 若在某个状态下解析失败，
 * 声明会被丢弃 → 回落到 `.btn` 的 `background: var(--bg-surface)`（白），
 * 而 `color:#fff` 仍是白 → **白底白字，整颗按钮看不见**。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-desktop-preview');
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
  return r.result?.exceptionDetails ? ('ERR ' + String(r.result.exceptionDetails.exception?.description).slice(0, 120)) : r.result?.result?.value;
};

const PROBE = `(() => {
  const b = document.querySelector('.col-main .composer-toolbar .btn.primary');
  if (!b) return { found: false };
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  return {
    found: true,
    text: b.textContent.trim(),
    disabled: b.disabled,
    display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
    color: cs.color,
    backgroundImage: cs.backgroundImage === 'none' ? '(none)' : cs.backgroundImage.slice(0, 62),
    backgroundColor: cs.backgroundColor,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    gradVar: getComputedStyle(document.documentElement).getPropertyValue('--grad').trim().slice(0, 50),
  };
})()`;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);

console.log('--- 状态1：空输入、未聚焦 ---');
console.log(JSON.stringify(await ev(PROBE), null, 1));

console.log('\n--- 状态2：空输入、聚焦 ---');
await ev(`document.querySelector('.col-main .composer-input').focus(); true`);
await sleep(600);
console.log(JSON.stringify(await ev(PROBE), null, 1));

console.log('\n--- 状态3：有草稿（出现"草稿已保存"勾）、聚焦 ---');
await ev(`(() => {
  const ta = document.querySelector('.col-main .composer-input');
  const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  s.call(ta, '测试草稿内容'); ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(900);
console.log(JSON.stringify(await ev(PROBE), null, 1));

console.log('\n--- 草稿已保存指示器 ---');
console.log(JSON.stringify(await ev(`(() => {
  const el = document.querySelector('.composer-draft-saved, .composer-status .draft-saved, .composer-toolbar svg[data-icon]');
  const cands = [...document.querySelectorAll('.composer-toolbar *, .composer-status *')]
    .filter(e => /已保存|保存/.test(e.textContent || '') || e.getAttribute('aria-label')?.includes('保存'))
    .slice(0, 3)
    .map(e => ({ cls: String(e.className).slice(0,30), txt: (e.textContent||'').trim().slice(0,20), tag: e.tagName }));
  return cands;
})()`), null, 1));

/* 截图：整个输入区 */
const shot = await send('Page.captureScreenshot', { format: 'png' });
const full = join(out, 'repro-composer.png');
writeFileSync(full, Buffer.from(shot.result.data, 'base64'));
const box = await ev(`(() => { const e = document.querySelector('.col-main .composer-box'); const r = e.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
if (box) {
  const ps = [
    'Add-Type -AssemblyName System.Drawing',
    `$src=[System.Drawing.Bitmap]::FromFile('${full}')`,
    `$rect=New-Object System.Drawing.Rectangle -ArgumentList @(${Math.round(box.x * 2)},${Math.round(box.y * 2)},${Math.round(box.w * 2)},${Math.round(box.h * 2)})`,
    '$crop=$src.Clone($rect,$src.PixelFormat)',
    `$out=New-Object System.Drawing.Bitmap -ArgumentList @([int](${Math.round(box.w * 2)}*2),[int](${Math.round(box.h * 2)}*2))`,
    '$g=[System.Drawing.Graphics]::FromImage($out)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
    '$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half',
    '$g.DrawImage($crop,0,0,$out.Width,$out.Height)',
    `$out.Save('${join(out, 'repro-composer-zoom.png')}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose();$out.Dispose();$crop.Dispose();$src.Dispose()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
  console.log('\nOK  repro-composer-zoom.png');
}
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
