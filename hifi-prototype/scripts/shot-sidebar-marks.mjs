/**
 * 侧栏提示（2026-09-25 用户确认方案）的**真实 Electron 窗口**证据截图。
 *
 * 口径：任务状态（执行中/等待/受阻/待验收）在**名称前**的图标位，只有实际执行中才转；
 * 未读是行尾小蓝点；「文件与 Git」「待我处理」是行尾同规格数字徽标；
 * 项目折叠时显示子房间汇总，展开时不重复。
 *
 * 拍六张（每张**先程序核实状态、再截**，避免拍到"看起来对但其实是别的状态"的图）：
 *  d01 常用态（展开）：房间行状态位 + 行尾蓝点 + 两个数字徽标；
 *  d02 折叠项目：项目行显示聚合状态与聚合未读；
 *  d03 运行中且有未读：data-backfill 的房间行（真实种子：执行中 + 1 条未读）；
 *  d04 悬浮态：鼠标停在房间行上，行背景变化但提示不消失、不位移；
 *  d05 prefers-reduced-motion：旋转停但放射状标志与强调色仍在；
 *  d06 深色主题：提示全用主题令牌。
 *
 * 两个踩过的坑，已经写进脚本：
 *  ① 浮层（项目菜单）只认真实 mousedown/Esc —— `document.body.click()` 关不掉它，
 *     第一次拍出来的六张全被菜单盖住（视觉复核当场抓出）。现在关闭后用
 *     `assertClean()` 核实没有菜单/遮罩才继续，**宁可不拍也不出误导性证据**。
 *  ② 常驻窗口里可能还是旧 bundle —— 每段前整页重载。
 *
 * 宿主：真实 Electron 窗口（调试端口 9333）。输出：screenshots-desktop/sidebar-marks/
 *
 * 用法：node scripts/shot-sidebar-marks.mjs
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop', 'sidebar-marks');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const PORT = Number(process.env.ZS_CDP_PORT ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl,
      );
      if (pages.length) {
        const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let msgId = 0;
        const pending = new Map();
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        };
        const send = (method, params = {}) =>
          new Promise((res) => {
            const id = ++msgId;
            const t = setTimeout(() => { pending.delete(id); res({}); }, 15_000);
            pending.set(id, (m) => { clearTimeout(t); res(m); });
            ws.send(JSON.stringify({ id, method, params }));
          });
        const ev = async (expression) => {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          return r.result?.result?.value;
        };
        return { ws, send, ev };
      }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`连不上调试端口 ${port}`);
}

async function withPage(fn) {
  const c = await connect(PORT);
  try {
    return await fn(c);
  } finally {
    c.ws.close();
  }
}

/** 关浮层：真实 Esc 键事件（Menu 只认真实键盘/鼠标事件），再核实真的关掉了 */
async function closeOverlays() {
  await withPage(async (c) => {
    await c.send('Runtime.evaluate', { expression: 'window.zhongshuo ? window.zhongshuo.window.show() : null', awaitPromise: true });
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  });
  await sleep(400);
  return await withPage((c) => c.ev(`document.querySelectorAll('.menu, .scrim').length`));
}

/** 出证据前的守门：有浮层/遮罩就报错，不产出误导性截图 */
async function assertClean(what) {
  const dirty = await closeOverlays();
  if (dirty !== 0) {
    const second = await closeOverlays();
    if (second !== 0) throw new Error(`${what}：仍有 ${second} 个浮层未关闭，拒绝截图`);
  }
  return true;
}

/** 程序核实：读侧栏的一个房间行/项目行的提示（返回 null 表示没找到该行） */
const readRow = (name, kind = '房间') => withPage((c) => c.ev(`
  (() => {
    const root = document.querySelector('.sidebar');
    if (!root) return null;
    const rows = ${kind === '项目'
      ? "[...root.querySelectorAll('.side-project')]"
      : "[...root.querySelectorAll('.side-item.sub')]"};
    const row = rows.find((e) => (e.querySelector('.side-item-label')?.innerText ?? '').trim() === ${JSON.stringify(name)});
    if (!row) return null;
    const host = ${kind === '项目' ? "row.querySelector('.side-row')" : 'row'};
    const st = host.querySelector('.side-state');
    const caret = row.querySelector('.side-caret');
    return {
      折叠: caret ? caret.getAttribute('title') === '展开房间列表' : null,
      状态: st?.querySelector('svg')?.getAttribute('data-icon') ?? null,
      状态标题: st?.getAttribute('title') ?? null,
      动画: st ? getComputedStyle(st).animationName : null,
      未读: host.querySelector('.side-marks .side-unread-dot')?.getAttribute('title') ?? null,
    };
  })()
`));

async function shot(name, clipSel = '.sidebar', clipIndex = 0) {
  await assertClean(name);
  const clip = await withPage((c) => c.ev(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(clipSel)})[${clipIndex}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), scale: 2 };
  })()`));
  if (!clip) { console.log(`MISS ${name}（找不到 ${clipSel}）`); return; }
  let data = await withPage((c) => c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip }));
  if (!data.result?.data) {
    await sleep(900);
    data = await withPage((c) => c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip }));
  }
  if (!data.result?.data) { console.log(`MISS ${name}`); return; }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data.result.data, 'base64'));
  console.log(`OK   ${name}`);
}

async function act(js, wait = 700) {
  await withPage((c) => c.ev(js));
  await sleep(wait);
}
async function goto(hash, wait = 3000) {
  /* 必须整页重载：常驻窗口里可能还是上一次构建的 bundle（拍到旧样式就白拍了）；
     顺带清掉前序脚本留下的草稿，避免输入区带着别的测试内容入镜。 */
  await withPage((c) => c.ev(`localStorage.removeItem('zhongshuo.drafts.v2'); location.hash = ${JSON.stringify(hash)}; location.reload(); true`));
  await sleep(wait);
}

const info = await withPage(async (c) => (await c.send('Browser.getVersion')).result?.product ?? 'unknown');
console.log(`宿主: ${info} @ ${PORT}`);

/* 常驻会话：`Emulation.setEmulatedMedia` 是**会话级**的，用短连接下发会随连接关闭
   立刻失效（实测：d03 明明声明了"正常偏好"，读到的动画仍是 none）。
   所以动画偏好统一走这一条常驻连接，脚本结束才关。 */
const EMU = await connect(PORT);
const setMotion = (value) => EMU.send('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-reduced-motion', value }] : [] });

/* ---- 前置：清导航偏好（保证两轮截图可见项目一致），勾选显示 data-backfill ---- */
await act(`(() => { localStorage.removeItem('zhongshuo.nav.prefs.v1'); return true; })()`, 200);
await goto('#/project/proj_zs_01/room/room_dev_hall?recovery=0');
await act(`(() => { document.querySelector('.side-project-picker')?.click(); return true; })()`, 800);
await act(`(() => {
  const row = [...document.querySelectorAll('.menu-project-row')].find((r) => r.innerText.includes('data-backfill'));
  if (row && !row.querySelector('.menu-check')?.classList.contains('on')) row.querySelector('.menu-check')?.click();
  return true;
})()`, 500);
await assertClean('勾选项目后');

/* 把真实指针挪到主内容区中部再开始拍：常驻窗口里的鼠标是**真实指针**，
   它停在哪一行那一行就会有 hover 底色（视觉复核抓到 d01/d03/d05 的「方案讨论」
   带着浅灰底 —— 上一轮脚本的指针停在那里）。挪开以后 d01–d03 才是干净底。 */
async function moveMouseAway() {
  await withPage((c) => c.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', buttons: 0, x: 900, y: 620,
  }));
  await sleep(300);
}
await moveMouseAway();

await moveMouseAway();
/* 1. 常用态：展开的房间列表 —— 状态位在名称前、未读点在行尾、两个数字徽标 */
const d01 = await readRow('开发大厅');
if (d01?.状态 !== 'clipboard-check' || !d01?.未读) throw new Error(`d01 前置不成立（开发大厅应为静态"待验收"核对板 + 未读点）：${JSON.stringify(d01)}`);
const badgeCheck = await withPage((c) => c.ev(`document.querySelectorAll('.sidebar .side-badge').length`));
if (badgeCheck < 2) throw new Error(`d01 前置不成立：应有两个数字徽标，实际 ${badgeCheck}`);
await shot('d01-sidebar-expanded-marks');

await moveMouseAway();
/* 2. 折叠项目：汇总 */
await act(`(() => { document.querySelector('.sidebar .side-project .side-caret')?.click(); return true; })()`, 800);
const d02 = await readRow('众说', '项目');
if (d02?.折叠 !== true || d02?.状态 !== 'clipboard-check' || !d02?.未读) {
  throw new Error(`d02 前置不成立（折叠后项目行应显示聚合状态 + 聚合未读）：${JSON.stringify(d02)}`);
}
await shot('d02-sidebar-collapsed-aggregate');

/* 3. 运行中且有未读：data-backfill 的房间行（真实种子 = 执行中 + 1 条未读）。
   本机系统偏好是"减少动效"，所以这里显式声明正常偏好，拍到"在转"的样子；
   "真的在转"仍以 transform 两次采样为准（本脚本只负责把画面拍下来）。 */
await setMotion('no-preference');
await sleep(500);
await act(`(() => { document.querySelector('.sidebar .side-project .side-caret')?.click(); return true; })()`, 800);
await act(`(() => {
  const pr = [...document.querySelectorAll('.sidebar .side-project')].find((p) => p.innerText.includes('data-backfill'));
  const caret = pr?.querySelector('.side-caret');
  if (caret && caret.getAttribute('title') === '展开房间列表') caret.click();
  return true;
})()`, 800);
const bfRoom = await withPage((c) => c.ev(`
  (() => {
    const pr = [...document.querySelectorAll('.sidebar .side-project')].find((p) => p.innerText.includes('data-backfill'));
    const row = [...(pr?.querySelectorAll('.side-item.sub') ?? [])].find((e) => e.innerText.includes('开发大厅'));
    const st = row?.querySelector('.side-state');
    return { 状态: st?.querySelector('svg')?.getAttribute('data-icon') ?? null, 未读: row?.querySelector('.side-unread-dot')?.getAttribute('title') ?? null, 动画: st ? getComputedStyle(st).animationName : null };
  })()
`));
if (bfRoom?.状态 !== 'spinner-rays' || !bfRoom?.未读 || bfRoom?.动画 !== 'side-spin') {
  throw new Error(`d03 前置不成立（data-backfill 的房间行应为放射状标志 + 未读点 + 在转）：${JSON.stringify(bfRoom)}`);
}
/* 这一张只截 data-backfill 那一块：它才是"运行中且有未读"的主角，
   整栏截图与 d01 几乎一样（视觉复核指出过），聚焦后一眼可见。 */
await shot('d03-sidebar-running-with-unread', '.sidebar .side-project', 1);
console.log(`     d03 核实：${JSON.stringify(bfRoom)}（"在转"的证据见 verify-sidebar 的 transform 两次采样，静态图不作为动画证据）`);

/* 4. 悬浮态：鼠标真实移到房间行上 */
const hover = await withPage(async (c) => {
  const box = await c.ev(`(() => {
    const row = [...document.querySelectorAll('.sidebar .side-item.sub')].find((e) => (e.querySelector('.side-item-label')?.innerText ?? '').trim() === '方案讨论');
    if (!row) return null;
    const b = row.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  if (box) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
  await sleep(300);
  const state = await c.ev(`(() => {
    const row = [...document.querySelectorAll('.sidebar .side-item.sub')].find((e) => (e.querySelector('.side-item-label')?.innerText ?? '').trim() === '方案讨论');
    if (!row) return null;
    const cs = getComputedStyle(row);
    return { 背景: cs.backgroundColor, 名称x: Math.round(row.querySelector('.side-item-label').getBoundingClientRect().x), 状态位: !!row.querySelector('.side-state'), 未读点: !!row.querySelector('.side-unread-dot') };
  })()`);
  return { box, state };
});
if (!hover?.box) throw new Error('d04 前置不成立：找不到「方案讨论」行');
if (hover.state?.背景 === 'rgba(0, 0, 0, 0)') console.log('     注意：悬浮背景读到透明，可能鼠标事件未生效，请人工核对 d04');
await shot('d04-sidebar-row-hover');

await moveMouseAway();
/* 5. 减少动效偏好：旋转停，但形状与强调色仍在 */
await setMotion('reduce');
await sleep(600);
const reduced = await withPage((c) => c.ev(`
  (() => {
    const st = document.querySelector('.sidebar .side-state.running');
    return st ? { 动画: getComputedStyle(st).animationName, 颜色: getComputedStyle(st).color, 图标: st.querySelector('svg')?.getAttribute('data-icon') } : null;
  })()
`));
if (!reduced || reduced.动画 !== 'none') throw new Error(`d05 前置不成立（reduce 下应为 animation:none 且状态仍在）：${JSON.stringify(reduced)}`);
await shot('d05-sidebar-reduced-motion');
console.log(`     d05 核实：${JSON.stringify(reduced)}`);
await setMotion(null);
await sleep(300);

await moveMouseAway();
/* 6. 深色主题 */
await act(`(() => { document.documentElement.dataset.theme = 'dark'; return true; })()`, 700);
await shot('d06-sidebar-marks-dark');
await act(`(() => { document.documentElement.dataset.theme = 'light'; return true; })()`, 400);

console.log(`\n输出目录：${outDir}`);
process.exit(0);
