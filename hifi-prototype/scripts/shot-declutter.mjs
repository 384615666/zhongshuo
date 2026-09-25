/**
 * 界面信息减负施工截图（施工报告证据）。
 *
 * 两个宿主分开拍，并在文件名与报告里注明：
 *  · 桌面宿主 = 真实 Electron 窗口（`pnpm run desktop:debug`，调试端口 9333），原生 1480×940；
 *  · 浏览器宿主 = headless Chrome（端口 9337），用 device metrics 覆盖低宽档
 *    （桌面窗口 minWidth=1040，900/720 在桌面上不可达，按施工说明 §10.1 用浏览器宿主测）。
 *
 * 输出：screenshots-desktop/declutter/（独立子目录，不覆盖既有基线）
 *
 * 用法：
 *   node scripts/shot-declutter.mjs            # 两段都拍（需 Electron 已在 9333 运行）
 *   node scripts/shot-declutter.mjs desktop
 *   node scripts/shot-declutter.mjs browser http://localhost:5284
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop', 'declutter');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const mode = process.argv[2] ?? 'all';
const base = process.argv[3] ?? 'http://localhost:5284';
const DESKTOP_PORT = Number(process.env.ZS_CDP_PORT ?? 9333);
const BROWSER_PORT = Number(process.env.ZS_SHOT_CDP_PORT ?? 9337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listPages(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await r.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function connect(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const pages = await listPages(port);
      if (pages.length) {
        const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        let msgId = 0;
        const pending = new Map();
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        };
        const send = (method, params = {}) => new Promise((res) => {
          const id = ++msgId;
          const t = setTimeout(() => { pending.delete(id); res({}); }, 15_000);
          pending.set(id, (m) => { clearTimeout(t); res(m); });
          ws.send(JSON.stringify({ id, method, params }));
        });
        const ev = async (expression) => {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
          return r.result?.result?.value;
        };
        return { ws, send, ev };
      }
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`连不上调试端口 ${port}`);
}

async function shot(name, port) {
  const { ws, send } = await connect(port);
  try {
    await send('Runtime.evaluate', {
      expression: 'window.zhongshuo ? window.zhongshuo.window.show() : null',
      awaitPromise: true,
    });
    await sleep(500);
    let r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (!r.result?.data) {
      await sleep(900);
      r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    }
    if (!r.result?.data) { console.log(`MISS ${name}`); return false; }
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    console.log(`OK   ${name}`);
    return true;
  } finally {
    ws.close();
  }
}

/* ============================================================
   桌面宿主（Electron 9333）
   ============================================================ */
async function desktopShots(port) {
  const { ws, send } = await connect(port);
  const info = await send('Browser.getVersion');
  ws.close();
  console.log(`桌面宿主: ${info.result?.product ?? 'unknown'} @ ${port}`);

  /**
   * 先把 localStorage 里的导航偏好清掉再整页重载：
   * 之前的用例可能改过"侧栏显示哪些项目"，留着会让截图里的侧栏与种子状态不一致
   * （评审看截图时会以为是产品行为）。清掉后每张图都在同一个干净基线上。
   */
  {
    const c = await connect(port);
    await c.ev(`localStorage.clear(); location.hash='/welcome?recovery=0'; location.reload(); true`);
    c.ws.close();
    await sleep(2600);
  }

  async function nav(route) {
    const c = await connect(port);
    await c.ev(`location.hash = ${JSON.stringify(route)}; location.reload(); true`);
    c.ws.close();
    await sleep(2600);
  }
  async function act(js, wait = 900) {
    const c = await connect(port);
    await c.ev(js);
    c.ws.close();
    await sleep(wait);
  }

  const ROOM = '/project/proj_zs_01/room/room_dev_hall';
  const cases = [
    ['d01-pool-cards-and-room-info', `${ROOM}?recovery=0`, null],
    ['d02-L2-pool-plus-thread', `${ROOM}?thread=thread_t12&recovery=0`, null],
    ['d03-details-overview', `${ROOM}?thread=thread_t12&tab=task&recovery=0`, null],
    ['d04-details-activity', `${ROOM}?thread=thread_t12&tab=activity&recovery=0`, null],
    ['d05-details-delivery', `${ROOM}?thread=thread_t13&tab=delivery&recovery=0`, null],
    ['d06-discussion-attachments', `${ROOM}?thread=thread_d1&tab=artifacts&recovery=0`, null],
    ['d07-stop-entry-in-composer', `${ROOM}?thread=thread_t14&recovery=0`, null],
    ['d08-thread-more-menu', `${ROOM}?thread=thread_t12&recovery=0`,
      `document.querySelector('.col-thread .thread-nav button[aria-haspopup="menu"]')?.click(); 'ok'`],
    ['d09-card-more-menu', `${ROOM}?recovery=0`,
      `document.querySelector('.root-card .root-foot button[aria-haspopup="menu"]')?.click(); 'ok'`],
    ['d10-room-more-menu', `${ROOM}?recovery=0`,
      `document.querySelector('.pool-head button[aria-haspopup="menu"]')?.click(); 'ok'`],
    ['d11-preview-read-menu', `${ROOM}?recovery=0`, `(() => {
      const a = [...document.querySelectorAll('.root-card .msg-attach')].find(b => b.innerText.includes('架构评审要点'));
      a?.click();
      return 'ok';
    })()`, 1400, `document.querySelector('.preview-read')?.click(); 'ok'`],
    ['d12-preview-file-info', `${ROOM}?recovery=0`, `(() => {
      const a = [...document.querySelectorAll('.root-card .msg-attach')].find(b => b.innerText.includes('架构评审要点'));
      a?.click();
      return 'ok';
    })()`, 1400, `(() => {
      document.querySelector('.preview-tools button[aria-label="更多文件操作"]')?.click();
      return 'ok';
    })()`, 500, `(() => {
      const menus = [...document.querySelectorAll('.menu')];
      [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])].find(b => b.innerText.includes('文件信息'))?.click();
      return 'ok';
    })()`],
    ['d13-L4-thread-plus-file', `${ROOM}?thread=thread_t14&tab=artifacts&recovery=0`, `(() => {
      // 用线程 #14 里**有真实资源**的成果附件打开文件 → L4（回复串 + 文件）
      const a = [...document.querySelectorAll('.col-thread .msg-attach')]
        .find(x => x.innerText.includes('预览交互设计说明'));
      a?.click();
      return !!a;
    })()`],
    ['d14-archived-room-readonly', '/project/proj_zs_01/room/room_docs?recovery=0', null],
  ];

  let ok = 0;
  for (const c of cases) {
    const [name, route, ...steps] = c;
    await nav(route);
    for (const s of steps) {
      if (typeof s === 'string') await act(s, 900);
      else await sleep(s); // 数字 = 额外等待
    }
    if (await shot(name, port)) ok += 1;
  }
  console.log(`桌面截图 ${ok}/${cases.length}`);
  return ok;
}

/* ============================================================
   浏览器宿主（headless Chrome 9337）：低宽与缩放档
   ============================================================ */
async function browserShots(port) {
  const CHROME = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
  if (!CHROME) { console.error('找不到 Chrome/Edge'); return 0; }

  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
    '--user-data-dir=' + process.env.TEMP + '\\zs-shot-declutter',
    '--no-first-run', '--window-size=1680,1050', base,
  ]);
  proc.stderr.on('data', () => {});
  await sleep(3000);

  const ROOM = '/project/proj_zs_01/room/room_dev_hall';
  // 清掉导航偏好，保证每张图的侧栏/当前项目都来自种子状态
  {
    const c = await connect(port);
    await c.ev(`localStorage.clear(); location.hash='/welcome?recovery=0'; location.reload(); true`);
    c.ws.close();
    await sleep(2600);
  }
  // 显式带 tab=，避免同线程内上一次点击的视图状态延续到下一张截图
  const THREAD = `${ROOM}?thread=thread_t12&tab=replies&recovery=0`;

  /** [宽度, 名称, 路由, 附加动作] */
  const cases = [
    [1372, 'b01-1372-L2', THREAD, null],
    // L4 用线程 #14 的成果附件（有真实资源可预览；其他线程的部分成果是"未接入"状态）
    [1372, 'b02-1372-L4', `${ROOM}?thread=thread_t14&tab=artifacts&recovery=0`, `(() => {
      const a = [...document.querySelectorAll('.col-thread .msg-attach')]
        .find(x => x.innerText.includes('预览交互设计说明'));
      a?.click();
      return !!a;
    })()`],
    [1280, 'b03-1280-L2', THREAD, null],
    [1100, 'b04-1100-L4', `${ROOM}?thread=thread_t14&tab=artifacts&recovery=0`, `(() => {
      const a = [...document.querySelectorAll('.col-thread .msg-attach')]
        .find(x => x.innerText.includes('预览交互设计说明'));
      a?.click();
      return !!a;
    })()`],
    [900, 'b05-900-single-region', THREAD, null],
    [720, 'b06-720-single-region', THREAD, null],
    [900, 'b07-900-pool', `${ROOM}?recovery=0`, null],
    [720, 'b08-720-details', `${ROOM}?thread=thread_t12&tab=task&recovery=0`, null],
    // 单区域 + 文件：左端应是「对话」，且「收起预览」仍在文件 ⋯ 菜单里
    [900, 'b09-900-single-region-file', `${ROOM}?recovery=0`, `(() => {
      const a = [...document.querySelectorAll('.root-card .msg-attach')].find(b => b.innerText.includes('架构评审要点'));
      a?.click();
      // 从主池打开后，单区域默认仍停在对话；切到「文件」才是本场景要拍的画面
      setTimeout(() => {
        const btn = [...document.querySelectorAll('.single-region-switch button')]
          .find(b => b.innerText.includes('文件'));
        btn?.click();
      }, 400);
      return !!a;
    })()`],
  ];

  let ok = 0;
  for (const [width, name, route, after] of cases) {
    const c = await connect(port);
    await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.ev(`window.location.hash = ${JSON.stringify(route)}; true`);
    await sleep(900);
    // 启动恢复检查弹窗是挂载时判定的：hash 导航不会重载，所以显式关掉它再截图
    await c.ev(`(() => {
      const scrim = document.querySelector('.scrim');
      if (scrim) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.querySelector('.overlay-head .icon-btn[aria-label="关闭"]')?.click();
      }
      return !!scrim;
    })()`);
    await sleep(500);
    // 预览会话是内存态、跨 hash 导航保留：拍非 L4 场景前先收起预览，
    // 否则单区域降级会继续显示文件区域（截图内容与场景名不符）。
    // 收起入口在标签行左端（与回复串同一侧），单区域下是「对话」按钮。
    if (!route.includes('tab=artifacts')) {
      await c.ev(`(() => {
        document.querySelector('.preview-pane button[aria-label="收起预览区"]')?.click()
          ?? document.querySelector('.preview-pane button[aria-label="返回对话"]')?.click();
        return true;
      })()`);
      await sleep(500);
    }
    if (after) { await c.ev(after); await sleep(1200); }
    await c.send('Page.bringToFront');
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    c.ws.close();
    if (r.result?.data) {
      writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.result.data, 'base64'));
      console.log(`OK   ${name} (${width}px)`);
      ok += 1;
    } else {
      console.log(`MISS ${name} (${width}px)`);
    }
  }
  proc.kill();
  console.log(`浏览器截图 ${ok}/${cases.length}`);
  return ok;
}

if (mode === 'desktop' || mode === 'all') await desktopShots(DESKTOP_PORT);
if (mode === 'browser' || mode === 'all') await browserShots(BROWSER_PORT);
console.log(`\n输出目录：${outDir}`);
