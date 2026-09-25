/**
 * 把我们实现的「页签行 / 分段控件」在真实窗口里裁出来放大，
 * 与参考图同尺度并排，逐一看清差异。
 *
 * 覆盖：
 *   1. 线程子视图页签（回复/成果/活动/成员/任务详情/运行详情）  ← 参考图是"灰槽+白胶囊"
 *   2. 房间内容页签（对话池/任务看板/文件）
 *   3. 分段控件「任务/讨论」
 *   4. （已废止）分段控件「预览/源码」—— 2026-09-24 减负后改为「阅读 ▾」按钮 + 菜单
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

const c = await conn();
await c.ev(`window.zhongshuo?.window.show()`);
await c.ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=replies&recovery=0'; location.reload(); true`);
c.ws.close();
await sleep(4000);

const c2 = await conn();
const DPR = (await c2.ev('window.devicePixelRatio')) || 1;

const targets = [
  // 用例更新（2026-09-24 减负）：线程侧不再有常驻 .thread-tabs（8 页签行），
  // 改为一条 .thread-nav（收起/返回 + 回复/成果/详情 + ⋯）；详情内是 .details-subnav chip 行。
  ['thread-nav', '.col-thread .thread-nav'],
  ['details-subnav', '.col-thread .details-subnav'],
  ['content-tabs', '.col-main .thread-tabs'],
  ['seg-task', '.col-main .composer-toolbar .seg'],
];

const shot = await c2.send('Page.captureScreenshot', { format: 'png' });
const full = join(out, 'tabs-full.png');
writeFileSync(full, Buffer.from(shot.result.data, 'base64'));

for (const [name, sel] of targets) {
  const r = await c2.ev(`(() => {
    const e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null;
    const q = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const kids = [...e.querySelectorAll('button, .thread-tab, .details-chip')].slice(0, 8).map(b => {
      const bs = getComputedStyle(b);
      return { t: b.textContent.trim().slice(0,8), on: b.classList.contains('on'),
               bg: bs.backgroundColor, img: bs.backgroundImage.includes('gradient') ? 'grad' : '',
               color: bs.color, shadow: bs.boxShadow !== 'none' };
    });
    return { x:q.x, y:q.y, w:q.width, h:q.height, bg: cs.backgroundColor, border: cs.borderColor,
             padding: cs.padding, radius: cs.borderRadius, kids };
  })()`);
  if (!r) { console.log(`${name}: 未找到 ${sel}`); continue; }
  console.log(`\n### ${name}  [${sel}]`);
  console.log(`  容器 bg=${r.bg} border=${r.border} padding=${r.padding} radius=${r.radius}  (${Math.round(r.w)}x${Math.round(r.h)})`);
  for (const k of r.kids) {
    console.log(`    ${k.on ? '●' : '○'} "${k.t}" bg=${k.bg} ${k.img} color=${k.color} shadow=${k.shadow}`);
  }
  crop(full, join(out, `${name}-zoom.png`),
    (r.x - 3) * DPR, (r.y - 3) * DPR, (r.w + 6) * DPR, (r.h + 6) * DPR, 6);
}

/* 预览页的「预览/源码」*/
await c2.ev(`(() => { const c=[...document.querySelectorAll('.msg-attach')].find(x=>x.textContent.includes('预览交互设计说明')); if(c)c.click(); return !!c; })()`);
await sleep(1600);
const r4 = await c2.ev(`(() => {
  const e = document.querySelector('.preview-tabs .seg, .preview-head .seg, .seg');
  if (!e) return null;
  const q = e.getBoundingClientRect();
  return { x:q.x, y:q.y, w:q.width, h:q.height, bg: getComputedStyle(e).backgroundColor,
    kids: [...e.querySelectorAll('button')].map(b => ({ t:b.textContent.trim(), on:b.classList.contains('on'),
      bg:getComputedStyle(b).backgroundColor, img:getComputedStyle(b).backgroundImage.includes('gradient')?'grad':'',
      color:getComputedStyle(b).color })) };
})()`);
if (r4) {
  // 用例更新（2026-09-24 减负）：预览的视图切换已改为「阅读 ▾」按钮 + 菜单，
  // 这里剩下的分段控件只有输入条的「任务/讨论」。
  console.log('\n### 输入条分段控件「任务/讨论」（预览的阅读切换已改为按钮 + 菜单）');
  console.log(`  容器 bg=${r4.bg}  (${Math.round(r4.w)}x${Math.round(r4.h)})`);
  for (const k of r4.kids) console.log(`    ${k.on?'●':'○'} "${k.t}" bg=${k.bg} ${k.img} color=${k.color}`);
  const shot2 = await c2.send('Page.captureScreenshot', { format: 'png' });
  const full2 = join(out, 'tabs-full2.png');
  writeFileSync(full2, Buffer.from(shot2.result.data, 'base64'));
  crop(full2, join(out, 'seg-preview-zoom.png'),
    (r4.x - 3) * DPR, (r4.y - 3) * DPR, (r4.w + 6) * DPR, (r4.h + 6) * DPR, 6);
}
c2.ws.close();
process.exit(0);
