/** 截一张权限下拉展开的图，作为「变更前确认」被禁用的证据 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.ZS_CDP_PORT || '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const p = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && p.has(m.id)) {
    p.get(m.id)(m);
    p.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => {
      p.delete(i);
      res({});
    }, 12000);
    p.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (e) =>
  (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await ev(`window.zhongshuo?.window.show()`);
await sleep(600);
const onRoom = await ev(`location.hash.includes('/room/')`);
if (!onRoom) {
  await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0'; true`);
  await sleep(2200);
}

async function realClick(sel) {
  const r = await ev(`
    (() => {
      const b = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect();
      return b ? { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } : null;
    })()
  `);
  if (!r) return false;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  return true;
}

for (let i = 0; i < 4; i++) {
  if (await ev(`!!document.querySelector('.access-menu')`)) break;
  await realClick('.access-trigger');
  await sleep(600);
}
await sleep(500);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  writeFileSync(join(outDir, '15-desktop-permission-modes.png'), Buffer.from(shot.result.data, 'base64'));
  console.log('OK 15-desktop-permission-modes');
}
ws.close();
process.exit(0);
