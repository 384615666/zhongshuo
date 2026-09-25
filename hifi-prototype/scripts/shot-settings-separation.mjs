/** 截第十六批设置分离相关界面。 */
const PORT = process.env.ZS_CDP_PORT ?? '9333';
import { writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { p.delete(i); res({}); }, 15000);
  p.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    writeFileSync(`D:/zhongshuo/hifi-prototype/screenshots-desktop/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('OK  ', name);
  } else console.log('MISS', name);
};
const go = async (h) => { await ev(`location.hash=${JSON.stringify(h + (h.includes('?') ? '&' : '?') + 'recovery=0')}; true`); await sleep(1900); };

await ev(`window.zhongshuo?.window.show()`);
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/welcome?recovery=0'; true`);
await sleep(400);
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3200);
await ev(`window.zhongshuo?.window.show()`);
await sleep(600);
await ev(`
  (() => {
    const m = document.querySelector('.modal');
    if (!m) return false;
    const b = [...m.querySelectorAll('.btn')].find(x => /暂不处理|关闭|取消/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(500);

/* 1. 项目设置单页（三节都在一页） */
await go('/project/proj_zs_01/settings');
await shot('45-project-settings');

/* 2. 侧栏项目行的 ⋯ 菜单展开 */
await go('/project/proj_zs_01/room/room_dev_hall');
await ev(`
  (() => {
    const b = document.querySelector('.side-project-more');
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(900);
await shot('46-sidebar-project-menu');
// 关掉菜单，避免污染后续截图（上一版就带着这个浮层拍进了 47）
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(600);

/* 3. 应用设置（只有应用分区） */
await go('/settings?section=general');
await shot('47-app-settings');

/* 4. 无效项目不回退 */
await go('/project/proj_nope/settings');
await shot('48-invalid-project-settings');

ws.close();
