/**
 * 第十七批导航与项目管理：证据截图（真实 Electron 窗口）。
 *
 * 四张必需证据（用户要求）：
 *  e01 顶栏项目管理（展开菜单：搜索 / 勾选显示 / 切换当前项目 / 打开文件夹）
 *  e02 侧栏项目行：⋯ 与 + 悬浮显示 + 项目 ⋯ 菜单全展开
 *  e03 统一私信页（跨项目会话 + 项目筛选 + 每行项目归属）
 *  e04 归档管理页（已归档项目 + 活跃项目里的归档房间两种来源）
 *
 * 拍前先程序核实状态（照既有纪律：宁可不出图，也不出误导性证据）。
 * 用法：node scripts/shot-nav-shell.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop', 'nav-shell');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const PORT = Number(process.env.ZS_CDP_PORT ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
      if (pages.length) {
        const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let id = 0;
        const pending = new Map();
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
        const send = (method, params = {}) => new Promise((res) => {
          const i = ++id;
          const t = setTimeout(() => { pending.delete(i); res({}); }, 15000);
          pending.set(i, (m) => { clearTimeout(t); res(m); });
          ws.send(JSON.stringify({ id: i, method, params }));
        });
        const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
        return { ws, send, ev };
      }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`连不上 ${PORT}`);
}
const page = async (js, wait = 500) => { const c = await connect(); await c.ev(js); c.ws.close(); await sleep(wait); };
const shot = async (name, clipSel = null) => {
  const c = await connect();
  try {
    await c.ev(`window.zhongshuo ? window.zhongshuo.window.show() : null`);
    await sleep(350);
    const clip = clipSel
      ? await c.ev(`(() => { const el = document.querySelector(${JSON.stringify(clipSel)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height), scale: 2 }; })()`)
      : null;
    let r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip } : {}) });
    if (!r.result?.data) { await sleep(800); r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip } : {}) }); }
    if (!r.result?.data) { console.log(`MISS ${name}`); return; }
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`OK   ${name}`);
  } finally { c.ws.close(); }
};
const verify = async (label, expr, expect = true) => {
  const c = await connect();
  const v = await c.ev(expr);
  c.ws.close();
  if (v !== expect) throw new Error(`${label} 前置不成立：${JSON.stringify(v)}`);
  console.log(`     核实 ${label} ✓`);
};

const info = await (async () => { const c = await connect(); const v = await c.send('Browser.getVersion'); c.ws.close(); return v.result?.product ?? '?'; })();
console.log(`宿主: ${info} @ ${PORT}`);

/* 干净起点 */
await page(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); localStorage.removeItem('zhongshuo.drafts.v2'); location.hash = '/project/proj_zs_01/room/room_dev_hall'; location.reload(); true`, 3000);
/* 让第二个项目也显示在侧栏：截"多项目"的图才有意义 */
await page(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`, 600);
await page(`(() => { const rows = [...document.querySelectorAll('.menu-project-row')]; const r = rows.find((x) => x.innerText.includes('data-backfill')); if (r && !r.querySelector('.menu-check')?.classList.contains('on')) r.querySelector('.menu-check')?.click(); document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`, 700);
await verify('data-backfill 已在侧栏显示', `[...document.querySelectorAll('.sidebar .side-project .side-item-label')].some((e) => e.innerText.includes('data-backfill'))`);

/* e01 顶栏项目管理菜单 */
await page(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`, 700);
await verify('项目管理菜单已打开', `document.querySelectorAll('.menu-project-row').length >= 3`);
await shot('e01-topbar-project-management');
await page(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`, 400);

/* e02 项目 ⋯ 菜单 + 悬浮显示 ⋯/+ */
await page(`(() => {
  const row = document.querySelectorAll('.sidebar .side-project .side-row')[0];
  const b = row.getBoundingClientRect();
  window.__pt = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  return true;
})()`, 200);
const c = await connect();
const pt = await c.ev(`window.__pt`);
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x - 40, y: pt.y, buttons: 0 });
await sleep(150);
await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
await sleep(350);
const hovered = await c.ev(`getComputedStyle(document.querySelector('.sidebar .side-project .side-row-act')).opacity`);
c.ws.close();
if (hovered !== '1') {
  const c2 = await connect();
  await c2.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await c2.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  c2.ws.close();
  await sleep(400);
}
await verify('项目行的 ⋯ 已显示', `getComputedStyle(document.querySelector('.sidebar .side-project .side-row-act')).opacity === '1'`);
/* 展开 ⋯ 菜单（用真实点击，不用合成 click，保证菜单与 hover 同时成立） */
const c3 = await connect();
const morePt = await c3.ev(`(() => { const b = document.querySelector('.sidebar .side-project .side-row-act').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
await c3.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: morePt.x, y: morePt.y, buttons: 0 });
await sleep(200);
await c3.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: morePt.x, y: morePt.y, button: 'left', clickCount: 1 });
await c3.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: morePt.x, y: morePt.y, button: 'left', clickCount: 1 });
c3.ws.close();
await sleep(600);
await verify('项目 ⋯ 菜单已打开', `Boolean(document.querySelector('.menu'))`);
await shot('e02-project-row-actions-menu');
await page(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`, 400);

/* e03 统一私信页 */
await page(`location.hash = '/dm'; true`, 1800);
await verify('统一私信页：跨项目会话 + 每行项目归属', `document.querySelectorAll('.dm-row').length >= 5 && document.querySelectorAll('.dm-row-project').length >= 5`);
await verify('私信页有项目筛选', `Boolean(document.querySelector('.dm-scope-filter select'))`);
await shot('e03-unified-dm');

/* e04 归档管理：先归档 notes-vault（无未结束工作），页面上同时出现"已归档项目"与"活跃项目的归档房间" */
await page(`location.hash = '/project/proj_zs_01/room/room_dev_hall'; true`, 1500);
/* 先让 notes-vault 出现在侧栏（默认只显示当前项目 + 我上面勾的 data-backfill） */
await page(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`, 600);
await page(`(() => {
  const rows = [...document.querySelectorAll('.menu-project-row')];
  const r = rows.find((x) => x.innerText.includes('notes-vault'));
  if (r && !r.querySelector('.menu-check')?.classList.contains('on')) r.querySelector('.menu-check')?.click();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  return true;
})()`, 800);

/* 与 verify-nav-shell 同一套做法（合成 click 在菜单/按钮上都成立，且不受 hover 抖动影响）：
   找到 notes-vault 那一行 → 打开它的 ⋯ → 点「归档项目…」→ 在确认弹窗里点主按钮（无未结束工作时可点）。 */
await page(`(() => {
  const rows = [...document.querySelectorAll('.sidebar .side-project')];
  const i = rows.findIndex((r) => r.innerText.includes('notes-vault'));
  if (i < 0) return false;
  rows[i].querySelectorAll('.side-row-act')[0]?.click();
  return true;
})()`, 700);
await page(`(() => {
  const it = [...document.querySelectorAll('.menu-item')].find((e) => e.innerText.includes('归档项目'));
  if (!it) return false;
  it.click();
  return true;
})()`, 800);
await page(`(() => {
  const b = [...document.querySelectorAll('.modal .btn.primary')].find((x) => x.innerText.includes('归档项目'));
  if (!b || b.disabled) return false;
  b.click();
  return true;
})()`, 1800);
await page(`location.hash = '/archive'; true`, 1600);
await verify('归档管理页：notes-vault 已归档项目 + 众说的归档房间同时在列',
  `document.body.innerText.includes('已归档项目') && document.body.innerText.includes('文档整理') && document.body.innerText.includes('随项目只读')`);
await shot('e04-archive-management');

console.log(`\n输出目录：${outDir}`);
process.exit(0);
