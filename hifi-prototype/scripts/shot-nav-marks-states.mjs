/**
 * 侧栏提示的**状态矩阵**证据截图（2026-09-25 用户确认方案）。
 *
 * 用途：用户要求至少看到"运行中且有未读""项目折叠汇总""静态等待状态"。
 * 其中"等待用户 / 受阻"两种状态**演示数据里没有**（原型也没有动作能造出来），
 * 所以这里和 verify-nav-marks.mjs 一样，走 dev server 按 URL 拿 store 模块、
 * **临时**注入内存状态后再截图 —— 演示数据一行没改，刷新即回种子。
 * 六张图都只截侧栏，便于逐格核对位置与颜色。
 *
 * 拍之前先程序核实"现在到底是什么状态、标志是哪个图标"，核实不过就不拍 ——
 * 第一版就是因为没核实，把"折叠/展开"两张拍成了与文件名相反的状态
 * （视觉复核当场抓出：i01 名为 collapsed 实为展开）。
 *
 * 宿主：本机 Chrome/Edge headless + dev server（5284）+ 独立端口 9341。
 * 输出：screenshots-desktop/nav-marks-injected/
 *
 * 用法：
 *   pnpm dev --port 5284
 *   node scripts/shot-nav-marks-states.mjs
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop', 'nav-marks-injected');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const BASE = process.argv[2] ?? 'http://localhost:5284';
const CDP = process.env.ZS_NAV_MARKS_SHOT_CDP_PORT ?? '9341';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!browser) throw new Error('找不到本机 Chrome/Edge');

const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run',
  '--window-size=1480,940',
  '--user-data-dir=' + (process.env.TEMP + '/zs-nav-marks-shot'), 'about:blank',
], { stdio: 'ignore' });
await sleep(2000);

let id = 0;
const pending = new Map();
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { pending.delete(i); res({}); }, 15000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

/* 动画偏好：本机系统开着 reduce，截图要拍到"在转"的位置需显式声明正常偏好；
   静态图仍然**不作为**动画证据（动画证据在 verify-sidebar / verify-nav-marks
   的 animation + transform 两次采样里）。 */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await ev(`location.href = ${JSON.stringify(`${BASE}/#/project/proj_zs_01/room/room_dev_hall?recovery=0`)}; 'ok'`);
await sleep(2800);
await ev(`(async () => { window.__m = await import('/src/data/store.ts'); return true; })()`);

/** 当前侧栏的项目行/房间行读到的提示 */
const readMarks = () => ev(`
  (() => {
    const pr = document.querySelector('.sidebar .side-project');
    const row = pr?.querySelector('.side-row');
    const room = [...(pr?.querySelectorAll('.side-item.sub') ?? [])].find((e) => (e.querySelector('.side-item-label')?.innerText ?? '').trim() === '开发大厅');
    const icon = (host) => host?.querySelector('.side-state svg')?.getAttribute('data-icon') ?? null;
    return {
      折叠: pr?.querySelector('.side-caret')?.getAttribute('title') === '展开房间列表',
      项目状态: icon(row),
      项目未读: row?.querySelector('.side-marks .side-unread-dot')?.getAttribute('title') ?? null,
      房间状态: icon(room),
      房间未读: room?.querySelector('.side-unread-dot')?.getAttribute('title') ?? null,
      房间数: pr?.querySelectorAll('.side-item.sub').length ?? null,
    };
  })()
`);

/** 展开/折叠到指定状态（读 caret 标题判断，不猜）。caret 标题是"点它会做什么"：
 *  `展开房间列表` = 当前折叠。 */
const caretTitle = () => ev(`document.querySelector('.sidebar .side-project .side-caret')?.getAttribute('title') ?? null`);
async function setExpanded(expanded) {
  for (let i = 0; i < 4; i++) {
    const before = await caretTitle();
    if (before === null) { await sleep(400); continue; }
    const isCollapsed = before === '展开房间列表';
    if (isCollapsed === expanded) {
      // 当前状态与目标相反 → 点一下
      await ev(`(() => { document.querySelector('.sidebar .side-project .side-caret')?.click(); return true; })()`);
      await sleep(600);
    }
    const after = await caretTitle();
    if (after !== null && (after === '展开房间列表') === !expanded) return true;
  }
  throw new Error('无法把项目切到期望的展开/折叠状态');
}

/** 把「开发大厅」的顶层任务状态整体替换成给定序列（内存注入，刷新即回种子） */
const setStatuses = (statuses) => ev(`
  (async () => {
    const m = window.__m;
    const statuses = ${JSON.stringify(statuses)};
    m.setState((s) => {
      const ids = s.tasks.filter((t) => t.roomId === 'room_dev_hall' && !t.parentTaskId).map((t) => t.id);
      return { ...s, tasks: s.tasks.map((t) => {
        const i = ids.indexOf(t.id);
        return i >= 0 && statuses[i] ? { ...t, status: statuses[i] } : t;
      }) };
    });
    await new Promise((r) => setTimeout(r, 80));
    return true;
  })()
`);

async function shot(name, expect) {
  const seen = await readMarks();
  const ok = expect(seen);
  if (!ok) throw new Error(`${name} 前置不成立：期望与实况不符 → ${JSON.stringify(seen)}`);
  const box = await ev(`(() => {
    const el = document.querySelector('.sidebar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), scale: 2 };
  })()`);
  if (!box) { console.log(`MISS ${name}`); return; }
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: box });
  if (!r.result?.data) { console.log(`MISS ${name}`); return; }
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  console.log(`OK   ${name}  实况=${JSON.stringify(seen)}`);
}

/* 1. 折叠 + 四类任务混合：项目行要显示聚合状态（受阻优先）与聚合未读 */
await setStatuses(['ACTIVE', 'WAITING_USER', 'BLOCKED', 'REVIEW']);
await setExpanded(false);
await shot('i01-mixed-priority-collapsed', (m) => m.折叠 === true && m.项目状态 === 'octagon' && Boolean(m.项目未读) && m.房间数 === 0);

/* 2. 同一份数据展开：项目行干净，房间行显示最高优先级那个状态 */
await setExpanded(true);
await shot('i02-mixed-priority-expanded', (m) => m.折叠 === false && m.项目状态 === null && m.项目未读 === null && m.房间状态 === 'octagon');

/* 3. 只有执行中 + 有未读：放射状标志在名称前、蓝点在行尾（房间行） */
await setStatuses(['ACTIVE', 'DONE', 'DONE', 'DONE']);
await sleep(400);
await shot('i03-running-with-unread', (m) => m.房间状态 === 'spinner-rays' && Boolean(m.房间未读) && m.项目状态 === null);

/* 4. 等待用户：静态手形，琥珀色，不转 */
await setStatuses(['WAITING_USER', 'DONE', 'DONE', 'DONE']);
await sleep(400);
await shot('i04-waiting-user-static', (m) => m.房间状态 === 'hand');

/* 5. 受阻：静态八角，琥珀色（不因 BLOCKED 就用红色） */
await setStatuses(['BLOCKED', 'DONE', 'DONE', 'DONE']);
await sleep(400);
await shot('i05-blocked-static', (m) => m.房间状态 === 'octagon');

/* 6. 待验收：静态眼睛，琥珀色 */
await setStatuses(['REVIEW', 'DONE', 'DONE', 'DONE']);
await sleep(400);
await shot('i06-review-static', (m) => m.房间状态 === 'clipboard-check');

console.log(`\n输出目录：${outDir}`);
ws.close();
proc.kill();
process.exit(0);
