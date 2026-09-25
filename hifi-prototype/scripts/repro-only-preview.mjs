/**
 * 复现②的新症状：切回开发大厅后**只剩附件占满整页**、对话区消失。
 *
 * 用户截图特征：只有 .preview-pane，且占满整宽（看不到回复串，也看不到主池）。
 * 这对应 layout='single' + singleRegion='preview'。
 * 本脚本在多个宽度下走一遍用户路径，报告：
 *   layout / 存在的区域 / 单区域切换器是否存在 / navPinned / app-body 实测宽度
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
  const body = document.querySelector('.app-body');
  const pick = (s) => { const e = document.querySelector(s); if (!e) return null;
    const q = e.getBoundingClientRect(); return { w: Math.round(q.width), x: Math.round(q.x) }; };
  return {
    vw: window.innerWidth,
    appBodyW: body ? Math.round(body.getBoundingClientRect().width) : null,
    layout: w ? w.dataset.layout : null,
    hasSwitch: !!document.querySelector('.single-region-switch'),
    children: w ? [...w.children].map(c => String(c.className).split(' ').slice(0,2).join('.')) : [],
    main: pick('.col-main'), thread: pick('.col-thread'), preview: pick('.preview-pane'),
    sidebarW: pick('.sidebar') ? pick('.sidebar').w : null,
  };
})()`;

await send('Runtime.enable');
await send('Page.enable');

for (const vw of [2560, 2048, 1920, 1600, 1440]) {
  await send('Emulation.setDeviceMetricsOverride', { width: vw, height: 1000, deviceScaleFactor: 1, mobile: false });
  await ev(`localStorage.clear(); true`);
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3400);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(700);
  const s1 = await ev(SNAP);

  await ev(`(() => { const a = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明')); if (a) a.click(); return !!a; })()`);
  await sleep(1600);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(500);
  const s2 = await ev(SNAP);

  await ev(`location.hash='/project/proj_zs_01/room/room_design?recovery=0'; true`);
  await sleep(1500);
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
  await sleep(1800);
  await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(600);
  const s3 = await ev(SNAP);

  const fmt = (s) => `layout=${String(s.layout).padEnd(16)} appBody=${String(s.appBodyW).padEnd(5)} 切换器=${s.hasSwitch ? 'Y' : 'N'} 区=${(s.children||[]).join('+')} | 主=${s.main ? s.main.w : '-'} 串=${s.thread ? s.thread.w : '-'} 预览=${s.preview ? s.preview.w : '-'}`;
  console.log(`\n=== 视口 ${vw} ===`);
  console.log(`  打开附件前 : ${fmt(s1)}`);
  console.log(`  打开附件后 : ${fmt(s2)}`);
  console.log(`  切走再切回 : ${fmt(s3)}`);
  const only = s3 && !s3.thread && !s3.main && s3.preview;
  if (only) console.log(`  ❌ 复现：切回后只剩附件占满（预览宽 ${s3.preview.w}）`);
  else console.log('  ✅ 切回后对话区仍在');
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
