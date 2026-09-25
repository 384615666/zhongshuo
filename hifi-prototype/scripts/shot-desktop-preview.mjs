/**
 * 共享预览的**桌面窗口**截图（UX-PREVIEW-01）。
 *
 * 为什么单独写一份，而不复用 `shot-workspace-preview.mjs`：
 *  1. 那个脚本用 `Emulation.setDeviceMetricsOverride` 改视口 —— 在 Electron 窗口上
 *     改的是**渲染视口**，与真实窗口尺寸不是一回事，尺寸证据会失真；
 *     桌面端的宽度必须靠**真的调整窗口**来产生。
 *  2. Electron 的 CDP page session 在导航/reload 后会失效，
 *     必须每次重连（`shot-desktop.mjs` 已记录这个坑）。
 *
 * 用法：
 *   pnpm run build && pnpm run desktop:debug     # 终端 1
 *   node scripts/shot-desktop-preview.mjs        # 终端 2
 *
 * 输出：screenshots-desktop-preview/（独立子目录，不覆盖既有基线）
 * 每条记录真实窗口内尺寸、缩放、布局结果与操作。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-desktop-preview');
const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

async function listPages() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return (await r.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

/** 每次连接新建 WS（reload 后旧 session 失效） */
async function connect() {
  for (let i = 0; i < 40; i++) {
    const pages = await listPages();
    if (pages.length) {
      const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let msgId = 0;
      const pending = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      };
      const send = (method, params = {}) =>
        new Promise((res) => {
          const id = ++msgId;
          const t = setTimeout(() => { pending.delete(id); res({}); }, 15_000);
          pending.set(id, (m) => { clearTimeout(t); res(m); });
          ws.send(JSON.stringify({ id, method, params }));
        });
      const ev = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
      };
      return { ws, send, ev };
    }
    await sleep(300);
  }
  throw new Error(`连不上 Electron 调试端口 ${PORT}。请先运行 pnpm run desktop:debug`);
}

const manifest = [];

/** 等到选择器出现（避免固定 sleep 造成的假失败） */
async function waitFor(ev, expr, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await ev(expr)) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

async function reset(hash) {
  const c = await connect();
  await c.ev(`window.zhongshuo?.window.show()`);
  await c.ev(`location.hash = ${JSON.stringify(hash)}; location.reload(); true`);
  c.ws.close();
  await sleep(3000);
}

async function shoot(name, note) {
  const c = await connect();
  try {
    await c.ev(`window.zhongshuo ? window.zhongshuo.window.show() : null`);
    await sleep(600);
    const info = await c.ev(`(() => {
      const ws = document.querySelector('.workspace');
      return {
        // 桌面端记录**真实窗口内尺寸**（不是 Emulation 覆盖值）
        inner: [window.innerWidth, window.innerHeight],
        dpr: window.devicePixelRatio,
        layout: ws?.dataset.layout ?? null,
        previewWidth: Math.round(document.querySelector('.preview-pane')?.getBoundingClientRect().width ?? 0),
        contextWidth: Math.round((document.querySelector('.col-main') || document.querySelector('.col-thread'))?.getBoundingClientRect().width ?? 0),
        tabs: document.querySelectorAll('.preview-tab').length,
        navVisible: !!document.querySelector('.sidebar'),
      };
    })()`);
    const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const data = r.result?.data;
    if (!data) { console.log(`MISS ${name}`); return; }
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
    manifest.push({ name, note, ...info });
    console.log(`OK   ${name.padEnd(32)} ${JSON.stringify(info)}`);
  } finally {
    c.ws.close();
  }
}

const click = (text) => `(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => (x.textContent||'').includes(${JSON.stringify(text)}));
  if (c) c.click();
  return !!c;
})()`;

/* ---------- 1. 主池：无任务附件（L1 → L3） ---------- */
await reset('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await shoot('d01-room-pool-plain-messages', '桌面窗口：L1 主池，两条「普通消息 · 无任务」带附件');

{
  const c = await connect();
  await c.ev(click('架构评审要点'));
  c.ws.close();
  await sleep(1200);
  await shoot('d02-L3-pool-file', '桌面窗口：L3 主池 + 无任务附件（Markdown 渲染）');
}

/* ---------- 2. 线程成果 → L4 ---------- */
await reset('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
await sleep(800);
await shoot('d03-thread-artifacts-tab', '桌面窗口：线程成果 tab（列表未被正文替换）');
{
  const c = await connect();
  await c.ev(click('预览交互设计说明'));
  c.ws.close();
  await sleep(1300);
  await shoot('d04-L4-thread-file', '桌面窗口：L4 回复串 + 文件（来源/版本/引用目标）');
}
{
  const c = await connect();
  // 用例更新（2026-09-24 减负）：预览的视图切换改为「阅读 ▾」菜单
  await c.ev(`(() => {
    const btn = document.querySelector('.preview-tools .preview-read');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(400);
  await c.ev(`(() => {
    const menus = [...document.querySelectorAll('.menu')];
    const b = [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])]
      .find(x => x.textContent.includes('源码视图'));
    if (b) b.click();
    return !!b;
  })()`);
  c.ws.close();
  await sleep(900);
  await shoot('d05-source-view', '桌面窗口：同一文件源码视图（行号）');
}

/* ---------- 3. 图片与不支持格式 ---------- */
await reset('/project/proj_zs_01/room/room_dev_hall?recovery=0');
{
  const c = await connect();
  await c.ev(click('预览布局草图'));
  c.ws.close();
  await sleep(1300);
  await shoot('d06-image-preview', '桌面窗口：真实 PNG（含透明区棋盘底）');
}

await reset('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
{
  const c = await connect();
  await c.ev(click('外部评审意见'));
  c.ws.close();
  await sleep(1300);
  await shoot('d07-unsupported-pdf', '桌面窗口：PDF 明确不支持（四种能力分列）');
}

/* ---------- 4. 私信隔离 ---------- */
await reset('/project/proj_zs_01/dm?recovery=0');
{
  const c = await connect();
  await c.ev(click('对账截图'));
  c.ws.close();
  await sleep(1400);
  await shoot('d08-dm-file-preview', '桌面窗口：私信附件预览（来源＝私信）');
}
await reset('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await shoot('d09-dm-hidden-in-room', '桌面窗口：切群聊后受限标签暂藏（不泄露文件名）');

/* ---------- 5. 项目文件工作区（L5） ---------- */
await reset('/project/proj_zs_01/files?tab=files&recovery=0');
{
  const c = await connect();
  await c.ev(`(() => {
    const r = [...document.querySelectorAll('.file-row')].find(x => x.textContent.includes('events.ts'));
    if (r) r.click();
    return !!r;
  })()`);
  c.ws.close();
  await sleep(1300);
  await shoot('d10-L5-project-files', '桌面窗口：L5 文件树 + 共享预览（来源＝项目文件列表）');
}

/* ---------- 6. 深色抽检 ---------- */
await reset('/project/proj_zs_01/room/room_dev_hall?theme=dark&recovery=0');
{
  const c = await connect();
  await c.ev(click('架构评审要点'));
  c.ws.close();
  await sleep(1300);
  await shoot('d11-dark-L3-preview', '桌面窗口 深色：主池 + 文件预览');
}

writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    host: 'Electron 桌面窗口（file:///…/dist/index.html）',
    note: 'inner 为真实窗口内尺寸（未使用 Emulation 覆盖）；dpr 为实际缩放；内容为原型内嵌 mock fixture。',
    shots: manifest,
  }, null, 2),
  'utf8',
);

console.log(`\n完成 ${manifest.length} 张 → ${outDir}`);
process.exit(0);
