/**
 * 诊断：`.preview-pane` 为什么拿不到 `.entered` 类。
 * 观察 2 秒内所有预览面板的 className 变化，并确认源码里确有该逻辑。
 */

const BASE = 'http://localhost:5284';
const PORT = '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find((t) => t.type === 'page' && t.url.startsWith(BASE)) ?? l.find((t) => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (m, pr = {}) => new Promise((res) => { const i = ++id; const t = setTimeout(() => { p.delete(i); res({}); }, 15000); p.set(i, (x) => { clearTimeout(t); res(x); }); ws.send(JSON.stringify({ id: i, method: m, params: pr })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.exceptionDetails ? undefined : r.result?.result?.value; };

await send('Runtime.enable');
await send('Page.enable');
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
await ev(`(() => { const a = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明')); if (a) a.click(); return !!a; })()`);

for (const t of [200, 600, 1200, 2500]) {
  await sleep(t === 200 ? 200 : t - 200);
  const info = await ev(`(() => {
    const all = [...document.querySelectorAll('.preview-pane')];
    return all.map(e => ({ cls: e.className, opacity: getComputedStyle(e).opacity }));
  })()`);
  console.log(`  t=${t}ms  .preview-pane 数量=${info?.length}  ${JSON.stringify(info)}`);
}

/* 源码里是否有 entered 逻辑（dev server 直接服务源码模块） */
const src = await ev(`fetch('http://localhost:5284/src/components/PreviewPane.tsx').then(r=>r.text()).then(t=>({
  hasEntered: t.includes('setEntered'), hasPaneCls: t.includes('paneCls'), len: t.length
}))`);
console.log('  源码模块检查:', JSON.stringify(src));

ws.close();
process.exit(0);
