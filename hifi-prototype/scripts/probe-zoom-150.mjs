/**
 * 诊断探针（不是发布门槛）：**150% 显示缩放等效几何**检查。
 *
 * 为什么需要：
 *  - 施工报告《prototype-ui-declutter-result.md》§4.4/§7 如实标注"未跑 150% 缩放"；
 *  - 桌面窗口 CSS 尺寸 1480×940、宿主显示缩放 125%（物理 1850×1175）已覆盖；
 *    换算到 150%：同一物理窗口 ≈ **1233×783 CSS**，其中 **783 的高度档此前从未测过**
 *    （既有宽度档都在 900 高度下跑），短视口才是高风险维度（垂直裁切、发送/停止被挤出）。
 *
 * 本脚本只**读取矩形与溢出**，不做断言门禁、不放宽任何既有用例：
 * 结果按"是否与既有宽度档结论一致"如实打印，发现问题就报出来，不在这里改界面。
 * 每个场景先校验"场景真的达成了"（例如 L2 必须是主池＋回复串同屏），否则判定无效 ——
 * 避免出现"没进到目标布局却报无异常"的空判定。
 *
 * 用法：先起 dev server，再
 *   node scripts/probe-zoom-150.mjs http://localhost:5284
 * 端口：ZS_ZOOM_CDP_PORT，默认 9337（与 Electron 9333 / smoke 9334 / 视觉预览 9335 / declutter 9336 错开）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = Number(process.env.ZS_ZOOM_CDP_PORT ?? 9337);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome/Edge');
  process.exit(1);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\zs-zoom150-profile`,
    '--no-first-run',
    '--window-size=1850,1175',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
await sleep(2000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('找不到页面 target');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
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
    const i = ++id;
    const t = setTimeout(() => {
      pending.delete(i);
      res({});
    }, 15000);
    pending.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
  return { value: r.result?.result?.value };
};

/* 150% 缩放等效：物理 1850×1175（= 桌面窗口 1480×940 @125%）/ 1.5 ≈ 1233×783 */
const W = 1233;
const H = 783;
await send('Emulation.setDeviceMetricsOverride', {
  width: W,
  height: H,
  deviceScaleFactor: 1.5,
  mobile: false,
});

const probe = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             bottom: Math.round(r.bottom), right: Math.round(r.right) }; };
  const inView = (el) => { const r = rect(el);
    return r && r.h > 0 ? (r.y >= -1 && r.bottom <= vh + 1 && r.x >= -1 && r.right <= vw + 1) : null; };
  const colMain = document.querySelector('.col-main');
  const colThread = document.querySelector('.col-thread');
  const pane = document.querySelector('.preview-pane');
  const composer = colThread?.querySelector('.composer') ?? colMain?.querySelector('.composer') ?? null;
  const sendBtn = composer?.querySelector('.btn.primary') ?? null;
  const stopBtn = [...(composer?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === '停止任务') ?? null;
  const navRow = colThread?.querySelector('.thread-nav') ?? null;
  const tools = pane?.querySelector('.preview-tools') ?? null;
  const tabs = pane?.querySelector('.preview-tabs') ?? null;
  return {
    vw, vh,
    达成: { 主池: !!colMain, 回复串: !!colThread, 预览: !!pane && !!tabs },
    主池卡片数: document.querySelectorAll('.root-card').length,
    预览标签数: document.querySelectorAll('.preview-tab').length,
    横向滚动: document.documentElement.scrollWidth > vw + 1,
    纵向滚动: document.documentElement.scrollHeight > vh + 1,
    输入区: rect(composer), 输入区在视口内: inView(composer),
    发送: rect(sendBtn), 发送在视口内: inView(sendBtn),
    停止: rect(stopBtn), 停止在视口内: inView(stopBtn),
    发送停止同排: (() => { if (!sendBtn || !stopBtn) return null;
      return Math.abs(sendBtn.getBoundingClientRect().top - stopBtn.getBoundingClientRect().top) <= 2; })(),
    导航行: rect(navRow), 导航行在视口内: inView(navRow),
    预览工具行: rect(tools), 预览工具行在视口内: inView(tools),
    标签行在视口内: inView(tabs),
  };
})()`;

async function goto(hash, wait = 3200) {
  // 注意：单区域/窄宽度下 React 布局解析比宽屏慢，等待不足会读到"还没渲染完"的空页面
  // （实测 900×900 在 2.6s 时仍可能是过渡态；整页刷新 + 3s 后正常）。因此这里的等待偏保守。
  await ev(`location.replace(${JSON.stringify(BASE)} + ${JSON.stringify(hash)}); true`);
  await sleep(wait);
}

/** 种子状态里预览是打开的；真 L2 需要先收起预览，否则量到的是 L3/L4 */
async function collapsePreview() {
  const clicked = await ev(`(() => {
    const b = document.querySelector('.preview-nav-back');
    if (b && b.innerText.includes('收起预览')) { b.click(); return true; }
    return false;
  })()`);
  await sleep(700);
  return clicked.value === true;
}

function report(name, expect, v, opts = {}) {
  const issues = [];
  if (!v) {
    console.log(`== ${name}\n   读取失败\n`);
    return;
  }
  const missed = Object.entries(expect).filter(([k, val]) => v.达成?.[k] !== val).map(([k, val]) => `${k}应${val ? '存在' : '不存在'}`);
  if (missed.length) issues.push(`场景未达成（${missed.join('、')}）→ 本场景判定无效，不计入结论`);
  if (opts.requireComposer && !v.输入区) issues.push('未找到输入区 → 本场景判定无效，不计入结论');
  if (v.横向滚动) issues.push('横向溢出（页面出现横向滚动）');
  if (v.输入区在视口内 === false) issues.push('输入区被裁出视口');
  if (v.发送在视口内 === false) issues.push('发送按钮被裁出视口');
  if (v.停止在视口内 === false) issues.push('停止按钮被裁出视口');
  if (v.发送停止同排 === false) issues.push('发送与停止不在同一排');
  if (v.导航行在视口内 === false) issues.push('线程导航行被裁出视口');
  if (v.预览工具行在视口内 === false) issues.push('预览工具行被裁出视口');
  if (v.标签行在视口内 === false) issues.push('预览标签行被裁出视口');
  console.log(`== ${name}`);
  console.log(`   ${JSON.stringify(v)}`);
  console.log(`   判定：${issues.length === 0 ? '无异常（与既有宽度档结论一致）' : issues.join('；')}\n`);
}

console.log(`视口 ${W}×${H} @DPR1.5（= 桌面 1480×940 窗口在 150% 缩放下的等效几何）\n`);

/* 1. 真 L2：主池＋回复串（先收起种子预览） */
await goto('#/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0');
await collapsePreview();
report('L2 主池＋回复串', { 主池: true, 回复串: true, 预览: false }, (await ev(probe)).value);

/* 2. 真 L4：回复串＋文件（从线程打开一份真实资源） */
await goto('#/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
await ev(`(() => {
  const a = [...document.querySelectorAll('.col-thread .msg-attach')].find(x => x.innerText.includes('预览交互设计说明'));
  if (a) a.click();
  return !!a;
})()`);
await sleep(1400);
report('L4 回复串＋文件', { 回复串: true, 预览: true }, (await ev(probe)).value);

/* 3. 详情：交付与验收 */
await goto('#/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&tab=delivery&recovery=0');
report('详情 → 交付与验收', { 回复串: true }, (await ev(probe)).value);

/* 4. 私信（私信页同样使用 .col-main / .col-thread 容器，故不校验三区域成立，只校验几何） */
await goto('#/dm/dm_01?recovery=0');
report('私信', {}, (await ev(probe)).value, { requireComposer: true });

ws.close();
chrome.kill();
process.exit(0);
