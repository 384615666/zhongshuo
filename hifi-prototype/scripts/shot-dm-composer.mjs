/**
 * 私信输入区施工截图（施工报告 `dev-briefs/prototype-dm-composer-result.md` 的证据）。
 *
 * 拍的是**收敛后的形态**（2026-09-25 用户要求做减法：去小群、去任务/讨论、去 @、
 * 去「独立可见范围」「只唤醒 X」这类说明），以及 2026-09-24 就修好的附件落地。
 *
 * 宿主：真实 Electron 窗口（调试端口 9333，原生 1480×940 @125%）。
 * 输出：screenshots-desktop/dm-composer/（独立子目录，不覆盖既有基线）
 *
 * 用法：
 *   pnpm run build
 *   node_modules\.bin\electron.CMD . --remote-debugging-port=9333
 *   node scripts/shot-dm-composer.mjs
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop', 'dm-composer');
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

async function goto(hash, reload = true) {
  const c = await connect(PORT);
  await c.ev(`location.hash = ${JSON.stringify(hash)}; ${reload ? 'location.reload();' : ''} true`);
  c.ws.close();
  await sleep(reload ? 2800 : 1200);
}
async function act(js, wait = 900) {
  const c = await connect(PORT);
  await c.ev(js);
  c.ws.close();
  await sleep(wait);
}
/** 真实 Esc：浮层（Menu）只监听真实按键 */
async function realKeyEscape(wait = 500) {
  const c = await connect(PORT);
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  c.ws.close();
  await sleep(wait);
}
/** 真实鼠标点击（Menu 的"点外面就关"挂在 mousedown 上，合成 click 不触发） */
async function realClick(selector, wait = 700) {
  const c = await connect(PORT);
  const box = await c.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!box) {
    console.log(`SKIP realClick ${selector}（找不到元素）`);
    c.ws.close();
    return;
  }
  for (const type of ['mousePressed', 'mouseReleased']) {
    await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(120);
  }
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

/* 干净基线：清偏好后整页重载 */
await act(`localStorage.clear(); location.hash='/welcome?recovery=0'; location.reload(); true`, 2800);

const DM = '/project/proj_zs_01/dm?recovery=0';

/* 1. 收敛后的私信输入区：只有附件 / 权限档位 / 运行设置 / 发送（没有任务讨论、@、说明文字） */
await goto(DM);
await shot('d01-dm-composer-controls');

/* 2. 本次运行设置：方式 / 预算 / 权限三节，私信口径（R4 未接通如实写明） */
await act(`(() => {
  const b = [...document.querySelectorAll('.composer button')].find((x) => (x.getAttribute('aria-label') || '') === '本次运行设置');
  b?.click();
  return !!b;
})()`, 700);
await shot('d02-dm-run-settings-menu');

/* 3. 权限档位下拉：四档，其中「变更前确认」带「待验证」不可选
      （先真实 Esc 关掉运行设置浮层，避免两个菜单叠在一起） */
await realKeyEscape();
await realClick('.access-trigger', 700);
await shot('d03-dm-permission-picker');
/* 权限下拉只认它自己的遮罩：按遮罩关掉，别让它留到下一张图里
   （第一版 d04 就是这个下拉还开着，视觉核对会误判成"输入区不干净"）。 */
await realClick('.access-scrim', 500);
await realKeyEscape(400);

/* 4. 待发附件芯片 */
await act(`(() => {
  const b = [...document.querySelectorAll('.composer-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').includes('添加附件'));
  b?.click();
  return !!b;
})()`, 400);
await act(`(() => {
  const ta = document.querySelector('.composer textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '截图证据：这条私信带一个附件');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`, 400);
await shot('d04-dm-pending-attachment');

/* 5. 发送后消息上的真实附件（"发给该成员"的提示） */
await act(`document.querySelector('.composer-send')?.click(); true`, 1100);
await shot('d05-dm-message-with-attachment');

/* 6. 归档私信：输入框禁用 + 只读提示 + 取消归档 */
await goto(DM);
await act(`(() => {
  const toggle = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('已归档'));
  toggle?.click();
  return !!toggle;
})()`, 900);
await act(`(() => {
  const row = [...document.querySelectorAll('.dm-row')].find((r) => r.className.includes('archived'));
  row?.click();
  return !!row;
})()`, 1000);
await shot('d06-dm-archived-readonly');

/* 7. 新建私聊：1 对 1 单选（没有"多选组小群"） */
await goto(DM);
await act(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('title') || '') === '新建私聊');
  b?.click();
  return !!b;
})()`, 900);
await shot('d07-dm-create-single-select');

console.log(`\n输出目录：${outDir}`);
process.exit(0);
