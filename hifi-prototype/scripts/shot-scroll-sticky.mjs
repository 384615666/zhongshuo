/**
 * 滚动证据（第十七批复核第二轮）：在"文件与 Git"页按不同滚动位置连拍，
 * 并把**悬浮项目行**时的未读点/按钮状态也拍一张。
 *
 * 用户要求："你自己滚动一下 git 和文件的滚动多看几张图"。
 * 用法：node scripts/shot-scroll-sticky.mjs
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
const shot = async (name) => {
  const c = await connect();
  await c.ev(`window.zhongshuo ? window.zhongshuo.window.show() : null`);
  await sleep(250);
  const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  c.ws.close();
  if (!r.result?.data) { console.log(`MISS ${name}`); return; }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  console.log(`OK   ${name}`);
};

/* 起点：文件与 Git 的工作区标签（内容最长，最能看出吸顶） */
const c0 = await connect();
await c0.ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); location.hash='/project/proj_zs_01/files?tab=files&recovery=0'; location.reload(); true`);
await sleep(3200);
c0.ws.close();

for (const [i, top] of [[0, 0], [1, 240], [2, 520], [3, 900]]) {
  const c = await connect();
  const info = await c.ev(`(async () => {
    const page = document.querySelector('.page');
    page.scrollTop = ${top};
    await new Promise((r) => setTimeout(r, 350));
    const rel = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), h: Math.round(b.height) }; };
    return {
      scrollTop: Math.round(page.scrollTop),
      页头: rel('.page > .page-head'),
      页签: rel('.page > .thread-tabs'),
      筛选: rel('.page > .page-filters'),
      首个内容块: rel('.page > *:nth-child(3)'),
    };
  })()`);
  c.ws.close();
  console.log(`  scroll=${info?.scrollTop} 页头=${JSON.stringify(info?.页头)} 页签=${JSON.stringify(info?.页签)} 筛选=${JSON.stringify(info?.筛选)}`);
  await shot(`f1${i}-files-scroll-${top}`);
}

/* 悬浮项目行：未读点应隐藏、按钮出现 */
const c2 = await connect();
await c2.ev(`location.hash='/project/proj_zs_01/room/room_dev_hall'; true`);
await sleep(1600);
/* 让 data-backfill 显示，方便看带未读点的项目行 */
await c2.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(600);
await c2.ev(`(() => { const r = [...document.querySelectorAll('.menu-project-row')].find((x) => x.innerText.includes('data-backfill')); if (r && !r.querySelector('.menu-check')?.classList.contains('on')) r.querySelector('.menu-check')?.click(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
await sleep(800);
const pt = await c2.ev(`(() => { const el = document.querySelectorAll('.sidebar .side-project .side-row')[1]; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
await c2.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x - 40, y: pt.y, buttons: 0 });
await sleep(150);
await c2.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
await sleep(400);
const state = await c2.ev(`(() => {
  const row = document.querySelectorAll('.sidebar .side-project .side-row')[1];
  if (!row.matches(':hover')) return { hover: false };
  const marks = row.querySelector('.side-marks');
  const acts = [...row.querySelectorAll('.side-row-act')];
  return {
    hover: true,
    点可见: marks ? getComputedStyle(marks).visibility : null,
    按钮不透明度: acts.map((a) => getComputedStyle(a).opacity),
    按钮矩形: acts.map((a) => { const b = a.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; }),
    点矩形: marks ? (() => { const b = marks.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right) }; })() : null,
  };
})()`);
const clip = await c2.ev(`(() => { const el = document.querySelector('.sidebar-scroll'); const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height), scale: 3 }; })()`);
const r = await c2.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip });
writeFileSync(join(outDir, 'f20-sidebar-hover-no-dot.png'), Buffer.from(r.result.data, 'base64'));
c2.ws.close();
console.log('  悬浮态:', JSON.stringify(state));
console.log('OK   f20-sidebar-hover-no-dot');
console.log(`\n输出目录：${outDir}`);
process.exit(0);
