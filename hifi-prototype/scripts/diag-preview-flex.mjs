/**
 * 诊断：`.preview-pane` 的 flex 变成 `0 1 0px`（宽度 1px）的原因。
 * 查 --preview-w 在 workspace / pane 上的解析值，以及 flex 的实际来源。
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
  return r.result?.exceptionDetails ? ('ERR ' + String(r.result.exceptionDetails.exception?.description).slice(0,160)) : r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(700);
await ev(`(() => { const a = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明')); if (a) a.click(); return !!a; })()`);
await sleep(1800);
await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(900);

console.log(JSON.stringify(await ev(`(() => {
  const wsv = document.querySelector('.workspace');
  const p = document.querySelector('.preview-pane');
  const cs = getComputedStyle(p);
  const wsCs = getComputedStyle(wsv);
  return {
    layout: wsv.dataset.layout,
    workspaceStyleAttr: wsv.getAttribute('style'),
    varOnWorkspace: wsCs.getPropertyValue('--preview-w'),
    varOnPane: cs.getPropertyValue('--preview-w'),
    paneFlex: cs.flex, paneFlexBasis: cs.flexBasis, paneWidth: Math.round(p.getBoundingClientRect().width),
    paneAnim: cs.animationName, paneMinW: cs.minWidth,
    contextVar: wsCs.getPropertyValue('--context-w'),
  };
})()`), null, 1));

ws.close();
process.exit(0);
