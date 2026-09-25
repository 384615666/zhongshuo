/**
 * 未读点对齐 + ⋯/+ 居中：证据截图（放大截侧栏项目区，鼠标停在一个项目行上）。
 * 用法：node scripts/shot-nav-marks-align.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop', 'nav-shell');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const PORT = Number(process.env.ZS_CDP_PORT ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; p.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { ws, send, ev };
}
const c = await connect();
await c.ev(`window.zhongshuo ? window.zhongshuo.window.show() : null`);
await c.ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); location.hash='/project/proj_zs_01/room/room_dev_hall'; location.reload(); true`);
await sleep(3000);
c.ws.close();
const c2 = await connect();
await c2.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(600);
await c2.ev(`(() => { const r = [...document.querySelectorAll('.menu-project-row')].find((x) => x.innerText.includes('data-backfill')); if (r && !r.querySelector('.menu-check')?.classList.contains('on')) r.querySelector('.menu-check')?.click(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
await sleep(800);

/* 未悬浮：未读点应停在同一竖线上 */
const box = await c2.ev(`(() => { const el = document.querySelector('.sidebar-scroll'); const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height), scale: 3 }; })()`);
let r = await c2.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: box });
writeFileSync(join(outDir, 'f01-sidebar-dots-aligned.png'), Buffer.from(r.result.data, 'base64'));
console.log('OK   f01-sidebar-dots-aligned');

/* 悬浮第一个项目行：⋯/+ 出现，允许盖住未读点 */
const pt = await c2.ev(`(() => { const el = document.querySelectorAll('.sidebar .side-project .side-row')[0]; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
await c2.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x - 40, y: pt.y, buttons: 0 });
await sleep(150);
await c2.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
await sleep(350);
const hovered = await c2.ev(`document.querySelectorAll('.sidebar .side-project .side-row')[0].matches(':hover')`);
if (!hovered) {
  await c2.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await c2.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(400);
}
r = await c2.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: box });
writeFileSync(join(outDir, 'f02-sidebar-hover-actions.png'), Buffer.from(r.result.data, 'base64'));
console.log('OK   f02-sidebar-hover-actions');
c2.ws.close();
process.exit(0);
