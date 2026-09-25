/**
 * 决定性对照：把「我们渲染的发送按钮」与「参考图的发送按钮」
 * 在同一尺度上逐像素比饱和度，判定差异是否来自 disabled(opacity .5)。
 *
 * 三步：
 *  1. 截我们的页面 → 取按钮包围盒 → 算平均饱和度
 *  2. 同样算参考图按钮的平均饱和度
 *  3. 分别在有输入 / 无输入两种状态下重复 1，看哪一种与参考图吻合
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

/** 用 System.Drawing 算某个矩形内的平均饱和度 */
function satOf(file, x, y, w, h) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$b=[System.Drawing.Bitmap]::FromFile('${file}')
$sum=0;$n=0;$mx=0
for($yy=${Math.round(y)}; $yy -lt ${Math.round(y + h)}; $yy++){
  for($xx=${Math.round(x)}; $xx -lt ${Math.round(x + w)}; $xx++){
    if($xx -lt 0 -or $yy -lt 0 -or $xx -ge $b.Width -or $yy -ge $b.Height){ continue }
    $c=$b.GetPixel($xx,$yy)
    $s=[Math]::Max($c.R,[Math]::Max($c.G,$c.B))-[Math]::Min($c.R,[Math]::Min($c.G,$c.B))
    $sum+=$s;$n++; if($s -gt $mx){$mx=$s}
  }
}
Write-Output ("{0} {1}" -f [int]($sum/$n), $mx)
$b.Dispose()`;
  return execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
}

/* ---------- 参考图 ---------- */
const REF = 'D:\\zhongshuo\\docs\\design-assets\\visual-implementation-v1\\kimi-clean-layout-reference.png';
console.log('参考图发送按钮 (704,821)-(797,846):', satOf(REF, 706, 823, 90, 21), '  ← 平均/最大饱和度');

/* ---------- 我们的渲染 ---------- */
await send('Runtime.enable');
await send('Page.enable');
const DPR = 2;
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: DPR, mobile: false });
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);

const rectOf = () => ev(`(() => {
  const b = document.querySelector('.col-thread .composer-toolbar .btn.primary');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, disabled: b.disabled, op: getComputedStyle(b).opacity };
})()`);

/** 取按钮内部中央区域（避开圆角与文字，只量底色）*/
async function measure(label) {
  const r = await rectOf();
  if (!r) { console.log(`${label}: 找不到按钮`); return; }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(out, 'sat-probe.png');
  writeFileSync(f, Buffer.from(shot.result.data, 'base64'));
  // 取上边缘内 3px 的一条带（文字在上方留白处，纯渐变）
  const x = (r.x + 8) * DPR, y = (r.y + 3) * DPR;
  const w = (r.w - 16) * DPR, h = 5 * DPR;
  console.log(`${label}: disabled=${r.disabled} opacity=${r.op}  饱和度=${satOf(f, x, y, w, h)}`);
}

await measure('我们-空输入(禁用)');
await ev(`(() => { const ta=document.querySelector('.col-thread .composer-input');
  const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  s.call(ta,'测试'); ta.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(900);
await measure('我们-有输入(启用)');

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
