/**
 * 复现缺陷 2（修正版）：按用户的确切路径走一遍。
 *
 * 关键修正：`Emulation.setDeviceMetricsOverride` **不会**可靠触发 ResizeObserver，
 * 必须手动 dispatch `resize`，否则量到的是上一次的宽度（会得出假结论）。
 *
 * 路径：开发大厅 + 回复串 → 打开线程里的附件 → 切到方案讨论 → 切回开发大厅。
 */

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE)) ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  return r.result?.exceptionDetails ? ('ERR ' + String(r.result.exceptionDetails.exception?.description).slice(0, 140)) : r.result?.result?.value;
};

const PROBE = `(() => {
  const wsv = document.querySelector('.workspace');
  if (!wsv) return { noWorkspace: true };
  const r = wsv.getBoundingClientRect();
  const kids = [...wsv.children].map(c => {
    const q = c.getBoundingClientRect(); const cs = getComputedStyle(c);
    return { cls: String(c.className).split(' ').slice(0,2).join('.'),
             w: Math.round(q.width), flex: cs.flex, minW: cs.minWidth,
             over: Math.round(q.right - r.right) };
  });
  const pv = document.querySelector('.preview-pane');
  const pvr = pv ? pv.getBoundingClientRect() : null;
  return { hash: location.hash.slice(30, 90), layout: wsv.dataset.layout, wsW: Math.round(r.width),
           viewport: window.innerWidth, kids,
           previewW: pvr ? Math.round(pvr.width) : null,
           previewOver: pvr ? Math.round(pvr.right - r.right) : null };
})()`;

async function show(label) {
  const p = await ev(PROBE);
  console.log(`\n### ${label}`);
  console.log(`  viewport=${p?.viewport} layout=${p?.layout} wsW=${p?.wsW} 预览宽=${p?.previewW} 预览右侧超出=${p?.previewOver}`);
  for (const k of p?.kids ?? []) {
    console.log(`    ${k.cls.padEnd(18)} w=${String(k.w).padEnd(5)} flex=${String(k.flex).padEnd(13)} minW=${String(k.minW).padEnd(8)} over=${k.over}`);
  }
  return p;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1372, height: 872, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);
await ev(`window.dispatchEvent(new Event('resize')); true`);
await sleep(700);

/* 1) 开发大厅 + 回复串 */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await sleep(1800);
await ev(`window.dispatchEvent(new Event('resize')); true`);
await sleep(500);
await show('1) 开发大厅 + 回复串');

/* 2) 打开线程里的附件 */
await ev(`(() => {
  const a = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明'));
  if (a) { a.click(); return true; } return false;
})()`);
await sleep(1800);
await ev(`window.dispatchEvent(new Event('resize')); true`);
await sleep(500);
await show('2) 打开附件（L4：回复串 + 预览）');

/* 3) 切到方案讨论 */
await ev(`location.hash='/project/proj_zs_01/room/room_design?recovery=0'; true`);
await sleep(1800);
await ev(`window.dispatchEvent(new Event('resize')); true`);
await sleep(500);
await show('3) 切到方案讨论');

/* 4) 切回开发大厅 + 回复串 */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await sleep(1800);
await ev(`window.dispatchEvent(new Event('resize')); true`);
await sleep(500);
const back = await show('4) 切回开发大厅 + 回复串');

console.log('\n================ 判定 ================');
const pv = (back?.kids ?? []).find((k) => k.cls.includes('preview-pane'));
if (!pv) console.log('  切回后没有预览区（预览已关闭 → 与用户描述不符）');
else if (pv.over > 1) console.log(`  ❌ 复现：预览区右侧超出容器 ${pv.over}px —— 只显示半个`);
else console.log(`  ⚠ 未复现的一半：预览宽 ${pv.w}，右侧超出 ${pv.over}`);

await ws.close();
process.exit(0);
