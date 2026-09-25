/** 截 Git 页三个 tab，用于视觉检查。 */
const PORT = '9333';
import { writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; p.set(i, (m) => res(m)); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ws, send };
}

const { ws, send } = await connect();
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

await ev(`window.zhongshuo?.window.show()`);
// 先切到别的路由再回来，强制 GitPage 重新挂载（同一 hash 不会重挂，tab 状态会残留）
await ev(`location.hash='/project/proj_zs_01/changes'; true`);
await sleep(1200);
await ev(`location.hash='/project/proj_zs_01/git'; true`);
await sleep(2400);

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    writeFileSync(`D:/zhongshuo/hifi-prototype/screenshots-desktop/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('OK', name);
  } else console.log('MISS', name);
}

const clickTab = (label) =>
  ev(`(() => { const t=[...document.querySelectorAll('.thread-tab')].find(e=>e.innerText.includes(${JSON.stringify(label)})); t&&t.click(); return !!t; })()`);

await clickTab('工作区');
await sleep(700);
await shot('16-git-worktree');

await clickTab('历史');
await sleep(900);
await shot('17-git-history');

await clickTab('分支');
await sleep(900);
await shot('18-git-branches');

ws.close();

/* 暗色主题：theme 只在 App 首次挂载时从 URL 读取（App.tsx 空依赖 useEffect），
   所以必须整页 reload，仅改 hash 不会生效。 */
const sleepLong = (ms) => new Promise((r) => setTimeout(r, ms));
const c = await connect();
await c.send('Page.enable');
await c.send('Runtime.evaluate', { expression: `location.hash='/project/proj_zs_01/git?theme=dark'; true` });
await sleepLong(400);
await c.send('Page.reload', { ignoreCache: true });
c.ws.close();
await sleepLong(3200);

const c2 = await connect();
const theme = (await c2.send('Runtime.evaluate', { expression: `document.documentElement.dataset.theme`, returnByValue: true }))
  .result?.result?.value;
const r = await c2.send('Page.captureScreenshot', { format: 'png' });
if (r.result?.data) {
  writeFileSync('D:/zhongshuo/hifi-prototype/screenshots-desktop/19-git-dark.png', Buffer.from(r.result.data, 'base64'));
  console.log(`OK 19-git-dark (theme=${theme})`);
} else {
  console.log('MISS 19-git-dark');
}
c2.ws.close();
