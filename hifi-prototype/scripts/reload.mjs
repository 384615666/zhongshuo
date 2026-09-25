/** 重载页面以拾取新的 dist 构建产物（reload 会让 CDP 会话失效，故单独一步）。 */
const PORT = '9333';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ id: 1, method: 'Page.enable', params: {} }));
ws.send(JSON.stringify({ id: 2, method: 'Page.reload', params: { ignoreCache: true } }));
await new Promise((r) => setTimeout(r, 1500));
console.log('reloaded');
ws.close();
