/** 截左侧栏（改进后 + 成员展开 + 暗色）。 */
const PORT = '9333';
import { writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; p.set(i, (m) => res(m)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { ws, send, ev };
}

/** 只截左侧栏区域，便于看清排布 */
async function shotSidebar(send, name) {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 40, width: 250, height: 1000, scale: 1 } });
  if (r.result?.data) {
    writeFileSync(`D:/zhongshuo/hifi-prototype/screenshots-desktop/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('OK', name);
  } else console.log('MISS', name);
}

const c = await connect();
await c.ev(`window.zhongshuo?.window.show()`);
await c.ev(`location.hash='/project/proj_zs_01/room/room_dev_hall'; true`);
await sleep(2400);
await shotSidebar(c.send, '20-sidebar');

// 成员展开
await c.ev(`(() => { document.querySelector('.sidebar .side-heading-toggle')?.click(); return true; })()`);
await sleep(600);
await shotSidebar(c.send, '21-sidebar-members-open');
await c.ev(`(() => { document.querySelector('.sidebar .side-heading-toggle')?.click(); return true; })()`);
await sleep(400);

// 在 Git 页（验证高亮切到了 Git）
await c.ev(`location.hash='/project/proj_zs_01/git'; true`);
await sleep(1500);
await shotSidebar(c.send, '22-sidebar-git-active');

// 暗色
await c.ev(`location.hash='/welcome?theme=dark'; true`);
await sleep(800);
await c.send('Page.enable');
await c.send('Page.reload', { ignoreCache: true });
c.ws.close();
await sleep(3200);
const c2 = await connect();
await c2.ev(`location.hash='/project/proj_zs_01/room/room_dev_hall'; true`);
await sleep(2000);
const theme = await c2.ev(`document.documentElement.dataset.theme`);
await shotSidebar(c2.send, '23-sidebar-dark');
console.log('theme =', theme);
c2.ws.close();
