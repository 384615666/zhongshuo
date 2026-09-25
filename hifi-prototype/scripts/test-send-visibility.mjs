/**
 * 发送按钮是否会被工具条挤出行外 / 挤出容器？
 *
 * 用户截图里发送按钮"消失"了。规范 §9.3 要求"发送按钮必须始终在尾端且完整可见"。
 * 本脚本在多个宽度、两种输入区（主池 / 回复串）下测量：
 *   - 工具条是否换行（高度 > 单行高）
 *   - 发送按钮是否落在 composer-box 之内、是否在视口内
 *   - 发送按钮与"草稿已保存"勾的相对位置
 */

const BASE = process.argv[2] ?? 'http://localhost:5284';
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

const PROBE = `(() => {
  const out = [];
  for (const [name, root] of [['主池', '.col-main'], ['回复串', '.col-thread']]) {
    const box = document.querySelector(root + ' .composer-box');
    if (!box) { out.push({ name, missing: true }); continue; }
    const tb = box.querySelector('.composer-toolbar');
    const sb = box.querySelector('.composer-send');
    const br = box.getBoundingClientRect(), tr = tb.getBoundingClientRect();
    const sr = sb ? sb.getBoundingClientRect() : null;
    const cs = sb ? getComputedStyle(sb) : null;
    out.push({
      name,
      boxW: Math.round(br.width), boxH: Math.round(br.height),
      toolbarH: Math.round(tr.height),
      toolbarRows: tr.height > 40 ? '>1 行(换行)' : '单行',
      sendFound: !!sb,
      sendText: sb ? sb.textContent.trim() : null,
      sendInsideBox: sr ? (sr.right <= br.right + 1 && sr.bottom <= br.bottom + 1 && sr.left >= br.left - 1) : null,
      sendInViewport: sr ? (sr.top >= 0 && sr.bottom <= window.innerHeight + 1 && sr.right <= window.innerWidth + 1) : null,
      sendRect: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null,
      sendBg: cs ? (cs.backgroundImage === 'none' ? '(无渐变) ' + cs.backgroundColor : 'gradient') : null,
      sendOpacity: cs ? cs.opacity : null,
      sendColor: cs ? cs.color : null,
    });
  }
  return { vw: window.innerWidth, children: out };
})()`;

await send('Runtime.enable');
await send('Page.enable');
await ev(`localStorage.clear(); true`);

for (const w of [1440, 1372, 1280, 1100, 900]) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  await ev(`localStorage.clear(); true`);
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3400);
  await ev(`window.dispatchEvent(new Event('resize')); true`);
  await sleep(900);
  const res = await ev(PROBE);
  console.log(`\n=== 视口 ${res?.vw} ===`);
  for (const c of res?.children ?? []) {
    if (c.missing) { console.log(`  ${c.name}: 无输入区`); continue; }
    console.log(`  ${c.name}: box=${c.boxW}x${c.boxH} 工具条=${c.toolbarH}px ${c.toolbarRows}`);
    console.log(`     发送: ${c.sendFound ? `"${c.sendText}" ${JSON.stringify(c.sendRect)} 在容器内=${c.sendInsideBox} 在视口内=${c.sendInViewport} op=${c.sendOpacity} bg=${c.sendBg}` : '**找不到**'}`);
  }
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
