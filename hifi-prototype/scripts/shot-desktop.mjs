/**
 * 桌面客户端截图：截取真实 Electron 窗口（不是浏览器页面）。
 *
 * 关键坑：`location.reload()` 会让 CDP 的 page session 失效（表现为所有
 * captureScreenshot 都拿不到数据）。因此每次导航后**重新获取** page target
 * 并重建 WebSocket，而不是复用最初那一条连接。
 *
 * 用法：先 pnpm run desktop:debug，再 node scripts/shot-desktop.mjs
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop');
const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

async function listPages() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return (await r.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

/** 每次连接都新建一个 WS，并在结束时关闭 —— 避免 reload 后会话失效 */
async function connect() {
  for (let i = 0; i < 40; i++) {
    const pages = await listPages();
    if (pages.length) {
      const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
      });
      let msgId = 0;
      const pending = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      };
      const send = (method, params = {}) =>
        new Promise((res) => {
          const id = ++msgId;
          const t = setTimeout(() => {
            pending.delete(id);
            res({});
          }, 12_000);
          pending.set(id, (m) => {
            clearTimeout(t);
            res(m);
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      return { ws, send, title: pages[0].title };
    }
    await sleep(300);
  }
  throw new Error(`连不上 Electron 调试端口 ${PORT}。请先运行 pnpm run desktop:debug`);
}

const first = await connect();
console.log('已连接窗口:', first.title);
first.ws.close();

async function shot(name) {
  // 每次截图都重新连：reload 之后旧 session 会失效
  const { ws, send } = await connect();
  try {
    // 关键：Chromium 不会为「隐藏/最小化」的窗口截图（captureScreenshot 会直接超时）。
    // 之前验证"关闭=缩托盘"把窗口藏进了托盘，所以这里先确保窗口可见。
    await send('Runtime.evaluate', {
      expression: 'window.zhongshuo ? window.zhongshuo.window.show() : null',
      awaitPromise: true,
    });
    await sleep(700);

    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const data = r.result?.data;
    if (!data) {
      // 再试一次：可能刚好在 show 的过渡帧上
      await sleep(900);
      const r2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      if (!r2.result?.data) {
        console.log(`MISS ${name}`);
        return false;
      }
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(r2.result.data, 'base64'));
      console.log(`OK   ${name}`);
      return true;
    }
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    console.log(`OK   ${name}`);
    return true;
  } finally {
    ws.close();
  }
}

async function gotoAndShot(name, route, after) {
  const { ws, send } = await connect();
  // 整页重载，确保 recovery=0 之类只在挂载时判定的逻辑生效
  await send('Runtime.evaluate', {
    expression: `location.hash = ${JSON.stringify(route)}; location.reload(); true`,
  });
  ws.close();

  await sleep(2600);

  if (after) {
    const c = await connect();
    await c.send('Runtime.evaluate', { expression: after });
    c.ws.close();
    await sleep(900);
  }

  await shot(name);
}

const TARGETS = [
  ['01-desktop-welcome', '/welcome?recovery=0'],
  ['02-desktop-room', '/project/proj_zs_01/room/room_dev_hall?recovery=0'],
  ['03-desktop-thread', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0'],
  // 详情全部在回复串 tab 内就地渲染（不再弹窗/独立页）
  ['04-desktop-tab-task', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&tab=task&recovery=0'],
  ['05-desktop-tab-deliberation', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&tab=deliberation&recovery=0'],
  ['06-desktop-tab-run', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&tab=run&recovery=0'],
  ['07-desktop-tab-members', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&tab=members&recovery=0'],
  ['08-desktop-tab-artifacts', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&tab=artifacts&recovery=0'],
  // 私信（决策 24，M3 批次）
  ['09-desktop-dm', '/dm?recovery=0'],
  ['10-desktop-changes', '/project/proj_zs_01/changes?recovery=0'],
  ['11-desktop-settings', '/settings?recovery=0'],
  ['12-desktop-dark-thread', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&theme=dark&recovery=0'],
  ['13-desktop-activity', '/activity?recovery=0'],
  [
    '14-desktop-open-folder',
    '/welcome?recovery=0',
    `(() => {
      const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('打开文件夹'));
      if (b) b.click();
      return true;
    })()`,
  ],
];

for (const [name, route, after] of TARGETS) {
  await gotoAndShot(name, route, after);
}

console.log(`\n输出目录：${outDir}`);
process.exit(0);
