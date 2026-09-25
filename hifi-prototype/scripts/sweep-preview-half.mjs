/**
 * 缺陷 2 宽度扫描：在每个宽度上走一遍
 *   开发大厅+回复串 → 打开附件 → 切方案讨论 → 切回开发大厅
 * 报告每一步的区域宽度与"是否被右边缘裁掉"。
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
  const wsv = document.querySelector('.workspace');
  if (!wsv) return { noWs: true };
  const r = wsv.getBoundingClientRect();
  const pick = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const q = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { w: Math.round(q.width), over: Math.round(q.right - r.right), flex: cs.flex };
  };
  return { vw: window.innerWidth, layout: wsv.dataset.layout, wsW: Math.round(r.width),
           main: pick('.col-main'), thread: pick('.col-thread'), preview: pick('.preview-pane'),
           reopen: !!document.querySelector('.preview-reopen, .preview-reopen-btn') };
})()`;

await send('Runtime.enable');
await send('Page.enable');
await ev(`localStorage.clear(); true`);

const WIDTHS = [2048, 1920, 1600, 1440, 1372, 1280, 1100];
const problems = [];

for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3200);
  await ev(`window.dispatchEvent(new Event('resize')); true`);
  await sleep(600);

  // 1) 开发大厅 + 回复串
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
  await sleep(1500);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(400);
  const s1 = await ev(SNAP);

  // 2) 打开附件
  await ev(`(() => { const a = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明')); if (a) a.click(); return !!a; })()`);
  await sleep(1600);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(400);
  const s2 = await ev(SNAP);

  // 3) 切方案讨论
  await ev(`location.hash='/project/proj_zs_01/room/room_design?recovery=0'; true`);
  await sleep(1500);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(400);
  const s3 = await ev(SNAP);

  // 4) 切回开发大厅
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
  await sleep(1600);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(400);
  const s4 = await ev(SNAP);

  const fmt = (s) => s?.noWs ? 'n/a'
    : `L=${String(s.layout).padEnd(16)} ws=${String(s.wsW).padEnd(5)} 主=${s.main ? s.main.w : '-'}(${s.main ? s.main.over : ''}) 串=${s.thread ? s.thread.w : '-'}(${s.thread ? s.thread.over : ''}) 预览=${s.preview ? s.preview.w : '-'}(${s.preview ? s.preview.over : ''})`;

  console.log(`\n=== 视口 ${w} ===`);
  console.log(`  1 开发大厅+串 : ${fmt(s1)}`);
  console.log(`  2 打开附件    : ${fmt(s2)}`);
  console.log(`  3 方案讨论    : ${fmt(s3)}`);
  console.log(`  4 切回开发大厅: ${fmt(s4)}`);

  const bad = [];
  if (s2?.preview && s2.preview.over > 1) bad.push(`步骤2 预览超出 ${s2.preview.over}px`);
  if (s4?.preview && s4.preview.over > 1) bad.push(`步骤4 预览超出 ${s4.preview.over}px`);
  if (s4 && !s4.preview && s2?.preview) bad.push('步骤4 预览消失');
  if (s4?.preview && s4.preview.w < 400) bad.push(`步骤4 预览过窄 ${s4.preview.w}px`);
  if (bad.length) { console.log(`  ❌ ${bad.join('；')}`); problems.push({ w, bad }); }
  else console.log('  ✅ 正常');
}

console.log('\n================ 汇总 ================');
if (!problems.length) console.log('  所有宽度均正常，未复现');
else for (const p of problems) console.log(`  视口 ${p.w}: ${p.bad.join('；')}`);

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
