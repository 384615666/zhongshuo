/**
 * 共享预览专项截图（UX-PREVIEW-01 / §17.9，施工说明 §8 要求）。
 *
 * 与 `shot.mjs` 的区别：那个只按 URL 出图，**拍不到点击后才出现的状态**
 * （预览面板要先点文件才有）。这里用 CDP 真实点击，再 captureScreenshot，
 * 因此能证明"点了这个入口 → 出现这个界面"。
 *
 * 用法（先起 dev server 与带 CDP 的浏览器）：
 *   pnpm dev --port 5284
 *   node scripts/shot-workspace-preview.mjs http://localhost:5284
 *
 * 端口约定（**务必与 Electron 的 9333 错开**）：
 *   · Electron `desktop:debug` = 9333
 *   · 本脚本（浏览器导出图）    = **9335**（ZS_SHOT_CDP_PORT 可覆盖）
 *
 * 本脚本会 `Page.reload` 并改视口；连到 Electron 窗口会把用户真实的
 * 桌面窗口导航走（README 记录过白屏事故）。桌面端出图请用
 * `shot-desktop-preview.mjs` / `shot-desktop-narrow.mjs`。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = process.env.ZS_SHOT_CDP_PORT ?? '9335';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-preview');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

/* ---------- CDP ---------- */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page' && t.url.startsWith(BASE)) ?? list.find((t) => t.type === 'page');
if (!target) { console.error('找不到页面 target（浏览器是否带 --remote-debugging-port 启动？）'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { pending.delete(i); res({}); }, 20000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

const manifest = [];

/** 设置窗口尺寸（CSS 像素），并返回实际布局结果 */
async function setSize(w, h = 872) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(900);
  return ev(`(() => {
    const ws = document.querySelector('.workspace');
    return {
      layout: ws?.dataset.layout ?? null,
      workspaceWidth: Math.round(ws?.getBoundingClientRect().width ?? 0),
      previewWidth: Math.round(document.querySelector('.preview-pane')?.getBoundingClientRect().width ?? 0),
      contextWidth: Math.round((document.querySelector('.col-main') || document.querySelector('.col-thread'))?.getBoundingClientRect().width ?? 0),
      singleSwitch: !!document.querySelector('.single-region-switch'),
    };
  })()`);
}

async function shoot(name, note) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const data = r?.result?.data;
  if (!data) { console.log(`FAIL ${name}：无截图数据`); return null; }
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  const info = await ev(`(() => {
    const ws = document.querySelector('.workspace');
    return {
      layout: ws?.dataset.layout ?? null,
      workspaceWidth: Math.round(ws?.getBoundingClientRect().width ?? 0),
      previewWidth: Math.round(document.querySelector('.preview-pane')?.getBoundingClientRect().width ?? 0),
      tabs: document.querySelectorAll('.preview-tab').length,
      viewport: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
    };
  })()`);
  manifest.push({ name, note, ...info });
  console.log(`OK   ${name.padEnd(34)} ${JSON.stringify(info)}`);
  return file;
}

/** 干净起点 */
async function reset(hash, wait = 1500) {
  await ev(`localStorage.clear(); true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3400);
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(wait);
}

const clickChip = (text) => ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => (x.textContent||'').includes(${JSON.stringify(text)}));
  if (!c) return false;
  c.click();
  return true;
})()`);

/* ============================================================
   1. 1372：L2（主池 + 回复串）与 L3/L4（含文件）
   ============================================================ */
await setSize(1372);
await reset('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await shoot('01-1372-L1-room-pool', '1372x872：L1 房间主池（无预览）');

// L2：打开线程
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await sleep(1400);
await shoot('02-1372-L2-pool-thread', '1372x872：L2 主池 + 回复串');

// L4：从线程打开成果
const okL4 = await clickChip('预览交互设计说明');
await sleep(1100);
await shoot('03-1372-L4-thread-file-md', `1372x872：L4 线程 + Markdown 成果（点击成功=${okL4}）`);

// 切源码视图（用例更新 2026-09-24：改走「阅读 ▾」菜单）
await ev(`(() => {
  const btn = document.querySelector('.preview-tools .preview-read');
  if (btn) btn.click(); return !!btn;
})()`);
await sleep(400);
await ev(`(() => {
  const menus = [...document.querySelectorAll('.menu')];
  const b = [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])]
    .find(x => x.textContent.includes('源码视图'));
  if (b) b.click(); return !!b;
})()`);
await sleep(800);
await shoot('04-1372-L4-source-view', '1372x872：同一文件的源码视图（行号）');

/* ============================================================
   2. L3：从主池打开（无任务归属的普通附件）
   ============================================================ */
await reset('/project/proj_zs_01/room/room_dev_hall?recovery=0');
const okL3 = await clickChip('架构评审要点');
await sleep(1100);
await shoot('05-1372-L3-pool-file-md', `1372x872：L3 主池 + 无任务附件（点击成功=${okL3}）`);

// 图片预览
await reset('/project/proj_zs_01/room/room_dev_hall?recovery=0');
await clickChip('预览布局草图');
await sleep(1100);
await shoot('06-1372-image-preview', '1372x872：真实 PNG 预览（320x180，含透明区棋盘底）');

// 不支持格式
await reset('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
await clickChip('外部评审意见');
await sleep(1100);
await shoot('07-unsupported-pdf', '1372x872：PDF 未接通 → 明确不支持状态（四种能力分列）');

/* ============================================================
   3. 1280：长内容可读性（§11.6 要求真实内容样本）
   ============================================================ */
await setSize(1280);
await reset('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
await clickChip('预览交互设计说明');
await sleep(1200);
await shoot('08-1280-L4-long-content', '1280x872：长 Markdown/表格/长行在候选宽度下的可读性');

/* ============================================================
   4. 1100 / 900：退化
   ============================================================ */
await setSize(1100);
await sleep(900);
await shoot('09-1100-degraded', '1100x872：按实际空间退化（两区或单区）');

await setSize(900);
await sleep(1000);
await shoot('10-900-single-region', '900x872：单区域切换器出现');

// 单区域切到"对话"侧
await ev(`(() => {
  const b = [...document.querySelectorAll('.single-region-switch .seg button')].find(x => x.textContent.includes('对话'));
  if (b) b.click(); return !!b;
})()`);
await sleep(900);
await shoot('11-900-single-context', '900x872：单区域切到对话侧（预览逻辑状态保留）');

await send('Emulation.clearDeviceMetricsOverride');
await sleep(600);

/* ============================================================
   5. 私信：文件 + 切群聊隔离
   ============================================================ */
await reset('/project/proj_zs_01/dm?recovery=0');
await clickChip('对账截图');
await sleep(1200);
await shoot('12-dm-file-preview', '1372x872：私信附件预览（来源标注为私信）');

await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await sleep(1400);
await shoot('13-dm-switch-to-room', '1372x872：切到群聊后受限标签暂藏（不泄露文件名）');

/* ============================================================
   6. 项目文件工作区（L5）
   ============================================================ */
await reset('/project/proj_zs_01/files?tab=files&recovery=0');
await ev(`(() => {
  const r = [...document.querySelectorAll('.file-row')].find(x => x.textContent.includes('events.ts'));
  if (r) r.click(); return !!r;
})()`);
await sleep(1200);
await shoot('14-L5-project-files', '1372x872：L5 项目文件树 + 共享预览（来源＝项目文件列表）');

/* ============================================================
   7. 深色主题抽检（施工说明 §8：浅色与深色各抽检一条主流程）
   ============================================================ */
await reset('/project/proj_zs_01/room/room_dev_hall?recovery=0&theme=dark');
await sleep(800);
await clickChip('架构评审要点');
await sleep(1200);
await shoot('15-dark-L3-preview', '1372x872 深色：主池 + 文件预览（主流程抽检）');

/* ---------- 写出 manifest ---------- */
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    base: BASE,
    note: '窗口尺寸为 CSS 像素；deviceScaleFactor=1；内容为原型内嵌 mock fixture（真实可渲染，但不读取磁盘）。',
    shots: manifest,
  }, null, 2),
  'utf8',
);

console.log(`\n完成 ${manifest.length} 张 → ${outDir}`);
ws.close();
