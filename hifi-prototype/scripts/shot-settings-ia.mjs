/**
 * 应用设置七分区截图 + 六档窗口宽度实测（任务书 §2.1/§6 验收第 1 条）。
 *
 * 两件事分开做：
 *  1. **逐档测宽**：1920 / 1600 / 1440 / 1280 / 1100 / 900 六档逐档设置 Emulation、
 *     逐档确认生效后再读正文宽度 —— Emulation 是**会话级**的，连设置不确认等于没设。
 *  2. **逐分区截图**：七个一级分类各截一张（在窗口自身宽度下），供人工复核版式。
 *
 * 同时检查三件会被用户直接看到的事（§2.1/§2.2）：
 *  · 正文是否**水平溢出**（卡片/表格把正文撑破）；
 *  · 设置行里**标签与控件是否重叠**（窄窗最容易出的问题）；
 *  · 窄窗下控件是否换行而不是把标签挤成一条缝。
 *
 * 需要带调试端口的桌面客户端：`pnpm run desktop:debug`（默认 9333，与浏览器用例端口错开）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = process.env.ZS_CDP_PORT ?? '9333';
const OUT = 'D:/zhongshuo/hifi-prototype/screenshots-desktop/settings-ia';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { p.delete(i); res({}); }, 20000);
  p.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 240) };
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('OK  ', name);
  } else console.log('MISS', name);
};

await ev(`window.zhongshuo?.window.show()`);
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/welcome?recovery=0'; true`);
await sleep(400);
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
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
await sleep(400);

const go = async (h, wait = 1500) => { await ev(`location.hash=${JSON.stringify(h + (h.includes('?') ? '&' : '?') + 'recovery=0')}; true`); await sleep(wait); };

/* ============================================================
   一、六档窗口宽度：逐档设置、逐档确认、逐档量正文
   ============================================================ */

/** 量一次当前视口下设置正文的实际宽度与被挤压情况 */
const measure = () => ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    const nav = document.querySelector('.settings-nav');
    if (!body) return { 无正文: true };
    const b = body.getBoundingClientRect();
    const main = document.querySelector('.main')?.getBoundingClientRect();
    /* 水平溢出：正文里有没有元素右缘越过正文右缘（1px 容差） */
    let overflow = 0;
    for (const el of body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > b.right + 1) overflow = Math.max(overflow, Math.round(r.right - b.right));
    }
    /* 设置行：标签列与控件列是否重叠（窄窗最容易出的事） */
    let overlap = 0;
    for (const row of body.querySelectorAll('.pset-row')) {
      const label = row.querySelector('.pset-row-label')?.getBoundingClientRect();
      const ctrl = row.querySelector('.pset-row-control')?.getBoundingClientRect();
      if (!label || !ctrl) continue;
      if (label.right > ctrl.left + 1) overlap = Math.max(overlap, Math.round(label.right - ctrl.left));
    }
    return {
      视口: window.innerWidth,
      正文宽: Math.round(b.width),
      正文左缘: Math.round(b.left),
      导航宽: Math.round(nav?.getBoundingClientRect().width ?? 0),
      主区宽: Math.round(main?.width ?? 0),
      正文在主区内居中偏移: Math.round(b.left - (main?.left ?? 0)),
      水平溢出px: overflow,
      标签控件重叠px: overlap,
      正文滚动宽: body.scrollWidth,
      正文可视宽: body.clientWidth,
    };
  })()
`);

const WIDTHS = [1920, 1600, 1440, 1280, 1100, 900];
await go('/settings?section=general');
console.log('== 六档宽度实测（通用分区） ==');
const widthRows = [];
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  // 逐档确认生效：视口宽度真的变成目标值才算数
  const m = await measure();
  console.log(`${w}:`, JSON.stringify(m));
  widthRows.push({ 目标宽: w, ...m });
  await shot(`w-general-${w}`);
}
await send('Emulation.clearDeviceMetricsOverride');
await sleep(500);

/* 窄窗下逐分区再确认一次（900 档最容易破版）：只量不截图 */
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(600);
console.log('== 900 宽逐分区 ==');
const narrowRows = [];
for (const sec of ['appearance', 'notifications', 'runtime', 'connections', 'data', 'help']) {
  await go(`/settings?section=${sec}`);
  const m = await measure();
  console.log(`${sec}:`, JSON.stringify(m));
  narrowRows.push({ 分区: sec, ...m });
}
await send('Emulation.clearDeviceMetricsOverride');
await sleep(500);

/* 宽屏取证：正文随窗口变宽后，长行（路径 + 按钮）与长表在 1920 下要看一眼 */
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1400, deviceScaleFactor: 1, mobile: false });
await sleep(700);
for (const [name, sec] of [['w1920-general', 'general'], ['w1920-data', 'data'], ['w1920-help', 'help']]) {
  await go(`/settings?section=${sec}`);
  await shot(name);
}
await send('Emulation.clearDeviceMetricsOverride');
await sleep(500);

/* ============================================================
   二、七个分区各截一张（高视口，一次看完整节）
   ============================================================ */

console.log('== 分区截图 ==');
/* 分区截图用 1440 × 2400：视口够高才能在一次截图里看完整节，
   否则只能看到首屏，版式问题（例如空态、折叠位置）会被裁掉。 */
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 2400, deviceScaleFactor: 1, mobile: false });
await sleep(700);
const SHOTS = [
  ['10-general', 'general'],
  ['11-appearance', 'appearance'],
  ['12-notifications', 'notifications'],
  ['13-runtime', 'runtime'],
  ['14-connections', 'connections'],
  ['15-data', 'data'],
  ['16-help', 'help'],
];
for (const [name, sec] of SHOTS) {
  await go(`/settings?section=${sec}`);
  await shot(`settings-ia-${name}`);
}
await send('Emulation.clearDeviceMetricsOverride');
await sleep(500);

/* 归档管理嵌入模式：滚动到归档那一段再截一张（验证只有一个标题） */
await go('/settings?section=data');
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.settings-body .section-title')].find(e => e.innerText.includes('归档管理'));
    if (t) t.scrollIntoView({ block: 'start' });
    return !!t;
  })()
`);
await sleep(700);
await shot('settings-ia-17-data-archive');
const archiveCheck = await ev(`
  (() => {
    const body = document.querySelector('.settings-body');
    return {
      页头数量: body ? body.querySelectorAll('.page-head').length : -1,
      大标题数量: body ? body.querySelectorAll('.page-title').length : -1,
      归档可见: (body?.innerText ?? '').includes('归档不是删除') || (body?.innerText ?? '').includes('已归档项目'),
      筛选在正文内: !!body?.querySelector('.archive-filters'),
    };
  })()
`);
console.log('归档嵌入检查:', JSON.stringify(archiveCheck));

/* 独立 /archive 路由的页头没回归 */
await go('/archive');
const standalone = await ev(`
  (() => ({
    /* 用例更新（2026-09-26）：用户要求去掉页面顶部头部，/archive 也不再有标题与说明 */
    有大标题: !!document.querySelector('.page .page-head .page-title'),
    有筛选行: !!document.querySelector('.page-filters'),
    有返回全部: document.body.innerText.includes('返回全部归档'),
  }))()
`);
console.log('独立 /archive:', JSON.stringify(standalone));
await shot('settings-ia-18-archive-standalone');

/* ============================================================
   三、结果落盘（供施工报告引用真实数字）
   ============================================================ */
writeFileSync(`${OUT}/width-measurements.json`, JSON.stringify({ 六档: widthRows, 窄窗逐分区: narrowRows }, null, 2));
console.log('\n测量结果已写入', `${OUT}/width-measurements.json`);
