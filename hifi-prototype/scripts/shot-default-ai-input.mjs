/**
 * 「默认交给 AI / 仅记录」三场景截图（施工报告 `dev-briefs/prototype-default-ai-input-result.md` 的证据）。
 *
 * 三个核心场景（任务书 §11 要求）：
 *  1. 普通发送 —— 主池默认与 AI 交流：输入区无常驻切换、发送按钮就是「发送」；
 *  2. 选择「仅记录，不请求回复」—— ⋯ 菜单入口、可取消的标记、主按钮变「保存记录」、
 *     隐藏与本次无关的模型执行配置；
 *  3. 历史记录串 —— 在里面回复默认仍是「保存记录」（兼容例外，不被静默唤醒）。
 *
 * 宿主：真实 Electron 窗口（调试端口 9333，原生 1480×940 @125%）。
 * 输出：screenshots-desktop/default-ai-input/
 *
 * 用法：
 *   pnpm run build
 *   node_modules\.bin\electron.CMD . --remote-debugging-port=9333
 *   node scripts/shot-default-ai-input.mjs
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop', 'default-ai-input');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const PORT = Number(process.env.ZS_CDP_PORT ?? 9333);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl,
      );
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
            }, 15_000);
            pending.set(id, (m) => {
              clearTimeout(t);
              res(m);
            });
            ws.send(JSON.stringify({ id, method, params }));
          });
        const ev = async (expression) => {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          return r.result?.result?.value;
        };
        return { ws, send, ev };
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`连不上调试端口 ${port}`);
}

async function shot(name) {
  const { ws, send } = await connect(PORT);
  try {
    await send('Runtime.evaluate', { expression: 'window.zhongshuo ? window.zhongshuo.window.show() : null', awaitPromise: true });
    await sleep(400);
    let r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (!r.result?.data) {
      await sleep(900);
      r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    }
    if (!r.result?.data) {
      console.log(`MISS ${name}`);
      return;
    }
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`OK   ${name}`);
  } finally {
    ws.close();
  }
}

async function act(js, wait = 900) {
  const c = await connect(PORT);
  await c.ev(js);
  c.ws.close();
  await sleep(wait);
}
async function goto(hash, wait = 2600) {
  const c = await connect(PORT);
  await c.ev(`localStorage.removeItem('zhongshuo.drafts.v2'); location.hash = ${JSON.stringify(hash)}; location.reload(); true`);
  c.ws.close();
  await sleep(wait);
}

const info = await (async () => {
  const { ws, send } = await connect(PORT);
  const v = await send('Browser.getVersion');
  ws.close();
  return v.result?.product ?? 'unknown';
})();
console.log(`宿主: ${info} @ ${PORT}`);

const ROOM = '/project/proj_zs_01/room/room_dev_hall';

/* 1. 普通发送（默认交给 AI）：清掉本地草稿，保证是干净默认态 */
await goto(`${ROOM}?recovery=0`);
await act(`(() => {
  const ta = document.querySelector('.composer-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '帮我看一下 docs/ 里的接口草稿，指出还缺哪些错误处理');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`, 500);
await shot('d01-default-ai-send');

/* 2. 选择「仅记录，不请求回复」 */
await act(`(() => {
  const b = [...document.querySelectorAll('.composer button')].find((x) => (x.getAttribute('aria-label') || '') === '本次运行设置');
  b?.click();
  return !!b;
})()`, 600);
await shot('d02-record-menu-entry');
await act(`(() => {
  const item = [...document.querySelectorAll('.menu .menu-item')].find((x) => x.innerText.includes('仅记录'));
  item?.click();
  return !!item;
})()`, 600);
/* 进入"仅记录"后写入内容：应出现可取消的标记、主按钮变「保存记录」、模型配置隐藏 */
await act(`(() => {
  const ta = document.querySelector('.composer-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '先记一条：下周再决定导出格式，这轮不动');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`, 500);
await shot('d03-record-pending');

/* 3. 历史记录串：默认仍是「保存记录」 */
await goto(`${ROOM}?thread=thread_d1&recovery=0`);
await shot('d04-record-thread-default');

console.log(`\n输出目录：${outDir}`);
process.exit(0);
