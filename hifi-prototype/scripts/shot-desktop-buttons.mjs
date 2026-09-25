/**
 * 桌面窗口：用户点名的按钮实拍（新建群聊 / 发送 / 保存 / 引用）。
 *
 * 用户反馈"这些按钮的颜色你还没改"。浏览器审计显示它们都带 `--grad`，
 * 因此必须在**用户实际使用的 Electron 窗口**里逐个拍下来，
 * 看清到底是"渐变没生效"还是别的观感问题（例如禁用态 opacity 冲淡）。
 *
 * 用法：node scripts/shot-desktop-buttons.mjs
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

async function connect() {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = l.find((t) => t.type === 'page');
  if (!pg) throw new Error('找不到 Electron 窗口');
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

/** 报告一个按钮的状态 + 页面坐标 */
const probe = (sel, label) => `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return { label: ${JSON.stringify(label)}, missing: true };
  const r = e.getBoundingClientRect();
  const cs = getComputedStyle(e);
  return {
    label: ${JSON.stringify(label)},
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    text: (e.textContent || '').trim().slice(0, 14),
    disabled: e.disabled === true,
    opacity: cs.opacity,
    color: cs.color,
    img: cs.backgroundImage === 'none' ? '' : (cs.backgroundImage.includes('gradient') ? (cs.backgroundImage.includes('37, 99, 235') ? 'grad-soft' : 'grad') : 'other'),
    imgRaw: cs.backgroundImage.replace(/\\s+/g, ' ').slice(0, 62),
  };
})()`;

const report = [];
async function step(name, hash, action, sels) {
  const c = await connect();
  await c.ev(`window.zhongshuo?.window.show()`);
  await c.ev(`location.hash = ${JSON.stringify(hash)}; location.reload(); true`);
  c.ws.close();
  await sleep(3400);
  if (action) {
    const c2 = await connect();
    await c2.ev(action);
    c2.ws.close();
    await sleep(1300);
  }
  const c3 = await connect();
  const rows = [];
  for (const [sel, label] of sels) {
    const r = await c3.ev(probe(sel, label));
    if (r && !r.missing) rows.push(r);
  }
  const shot = await c3.send('Page.captureScreenshot', { format: 'png' });
  c3.ws.close();

  if (shot.result?.data) {
    const full = join(out, `btn-${name}-full.png`);
    writeFileSync(full, Buffer.from(shot.result.data, 'base64'));
    /**
     * 裁剪倍率必须用**窗口实际 dpr**，不能写死 1。
     * 本机 Electron 窗口 dpr=1.25，截图物理像素 = CSS 像素 × 1.25；
     * 早先按 1 换算，裁出来的是别的区域（实测裁到了正文的 "PDF" 字样）。
     */
    const dpr = await (async () => {
      const c = await connect();
      const d = await c.ev('window.devicePixelRatio');
      c.ws.close();
      return typeof d === 'number' && d > 0 ? d : 1;
    })();
    for (const r of rows) {
      crop(full, join(out, `btn-${name}-${r.label}.png`),
        r.x * dpr - 4, r.y * dpr - 4, r.w * dpr + 8, r.h * dpr + 8, 6);
    }
    console.log(`  (dpr=${dpr}, screenshot=${shot.result.data.length ? 'ok' : 'empty'})`);
  }
  console.log(`\n### ${name}`);
  for (const r of rows) {
    const mark = r.img === 'grad' ? '[GRAD]' : r.img === 'grad-soft' ? '[SOFT]' : '[flat]';
    console.log(`  ${mark.padEnd(8)} ${r.label.padEnd(14)} "${r.text}" op=${r.opacity} disabled=${r.disabled}  ${r.imgRaw}`);
  }
  report.push({ name, rows });
}

await step('newdm', '/project/proj_zs_01/dm?recovery=0',
  `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('新建私聊')); if(b)b.click(); return !!b; })()`,
  [['.modal .btn.primary', '新建群聊-创建'], ['.modal .btn:not(.primary)', '新建群聊-取消']]);

await step('send', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0',
  `(() => { const ta=document.querySelector('.col-thread .composer-input');
     const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
     s.call(ta,'测试'); ta.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`,
  [['.col-thread .composer-toolbar .btn.primary', '发送-启用'], ['.col-main .composer-toolbar .btn.primary', '发送-主池']]);

await step('save', '/project/proj_zs_01/room/room_dev_hall?recovery=0',
  `(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('房间设置')); if(b)b.click(); return !!b; })()`,
  [['.modal .btn.primary', '保存']]);

await step('quote', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0',
  `(() => { const c=[...document.querySelectorAll('.msg-attach')].find(x=>x.textContent.includes('预览交互设计说明')); if(c)c.click(); return !!c; })()`,
  [['.preview-tools .btn.primary', '引用']]);

writeFileSync(join(out, 'button-audit.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`\n→ ${out}`);
process.exit(0);
