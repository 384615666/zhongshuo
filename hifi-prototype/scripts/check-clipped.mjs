/**
 * 用「是否被裁」这个硬指标找缺陷 2：
 *   workspace.scrollWidth > clientWidth  → 内容超出容器被裁 → "只显示半个"
 * 并把每个子项的 x / 宽度 / 右边缘列出来，看清谁压在谁上面。
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
  return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
};

const SNAP = `(() => {
  const w = document.querySelector('.workspace');
  if (!w) return { noWs: true };
  const cs = getComputedStyle(w);
  const kids = [...w.children].map(c => {
    const q = c.getBoundingClientRect();
    return { cls: String(c.className).split(' ').slice(0,2).join('.'),
             x: Math.round(q.x), w: Math.round(q.width), right: Math.round(q.right),
             pos: getComputedStyle(c).position, flex: getComputedStyle(c).flex };
  });
  return {
    vw: window.innerWidth, layout: w.dataset.layout,
    clientW: w.clientWidth, scrollW: w.scrollWidth,
    overflowX: cs.overflowX,
    clipped: w.scrollWidth - w.clientWidth,
    kids,
  };
})()`;

await send('Runtime.enable');
await send('Page.enable');

for (const vw of [2048, 1440, 1280, 1180, 1100]) {
  await send('Emulation.setDeviceMetricsOverride', { width: vw, height: 900, deviceScaleFactor: 1, mobile: false });
  await ev(`localStorage.clear(); true`);
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3200);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(600);

  // 打开线程附件
  await ev(`(() => { const a = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明')); if (a) a.click(); return !!a; })()`);
  await sleep(1600);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(500);

  const a = await ev(SNAP);
  // 切走再切回
  await ev(`location.hash='/project/proj_zs_01/room/room_design?recovery=0'; true`);
  await sleep(1500);
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
  await sleep(1700);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(500);
  const b = await ev(SNAP);

  const dump = (s, tag) => {
    console.log(`  ${tag}: layout=${s.layout} client=${s.clientW} scroll=${s.scrollW} overflowX=${s.overflowX} **被裁=${s.clipped}**`);
    for (const k of s.kids) console.log(`      ${k.cls.padEnd(16)} x=${String(k.x).padEnd(5)} w=${String(k.w).padEnd(5)} right=${String(k.right).padEnd(5)} pos=${k.pos.padEnd(8)} flex=${k.flex}`);
  };
  console.log(`\n=== 视口 ${vw} ===`);
  dump(a, '打开附件   ');
  dump(b, '切走再切回 ');
  if (b.clipped > 1 || a.clipped > 1) console.log(`  ❌ 有内容被裁（打开=${a.clipped}px，切回=${b.clipped}px）`);
  else console.log('  ✅ 无裁切');
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
