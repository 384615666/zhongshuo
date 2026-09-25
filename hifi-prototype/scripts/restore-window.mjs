/**
 * 把 Electron 窗口导航回打包产物（修复被 smoke.mjs 劫持到 localhost:5284 的窗口）。
 * smoke.mjs 是给浏览器 + Vite dev server 用的，它会把当前 CDP page 导航到 base URL；
 * 当它和 Electron 共用 9333 端口时，会把 Electron 窗口导航到死地址。
 */
const PORT = '9333';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const p = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((res) => { const i = ++id; p.set(i, (m) => res(m)); ws.send(JSON.stringify({ id: i, method, params })); });

const target = 'file:///D:/zhongshuo/hifi-prototype/dist/index.html';
await send('Page.enable');
await send('Page.navigate', { url: target });
await new Promise((r) => setTimeout(r, 2500));
const r = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
console.log('now at:', r.result?.result?.value);
ws.close();
