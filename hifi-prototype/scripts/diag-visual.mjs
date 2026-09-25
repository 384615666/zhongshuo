/**
 * 视觉问题诊断：列出所有"看起来该用渐变"的控件，报告它们**实际渲染**的背景，
 * 并与 approved-selected-gradient.png 的取样值对照。
 *
 * 用途：用户报告"按钮根本没按截图的背景色来做"。不靠猜，把每个候选控件的
 * computed background 打出来，逐条比对。
 */

const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; const t = setTimeout(() => { pending.delete(i); res({}); }, 15000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? { err: String(r.result.exceptionDetails.exception?.description).slice(0, 120) } : r.result?.result?.value;
};
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1372, height: 872, deviceScaleFactor: 1, mobile: false });

await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);

const report = await ev(`(() => {
  const GRAD = 'linear-gradient(135deg, rgba(37, 99, 235, 0.1) 0%, rgba(52, 211, 153, 0.1) 100%)';
  const rows = [];
  const scan = (sel, label) => {
    const els = [...document.querySelectorAll(sel)];
    if (els.length === 0) { rows.push({ label, sel, count: 0 }); return; }
    const e = els[0];
    const cs = getComputedStyle(e);
    const img = cs.backgroundImage.replace(/\\s+/g, ' ').replace(/, none$/, '');
    rows.push({
      label, sel, count: els.length,
      hasGrad: img.includes('gradient'),
      isGradSoft: img.includes('rgba(37, 99, 235, 0.1)'),
      bg: cs.backgroundColor,
      img: img.slice(0, 78),
      radius: cs.borderRadius,
      color: cs.color,
    });
  };
  // 所有"选中态"候选
  scan('.side-item.active', '侧栏当前项(位置)');
  scan('.side-row.context-active', '侧栏当前项目(上下文)');
  scan('.thread-tab.on', '内容页签-激活');
  scan('.preview-tab.on', '文件标签-激活');
  scan('.dm-row.on', '私信行-选中');
  scan('.file-row.on', '文件树行-选中');
  scan('.settings-nav-item.on', '设置导航-选中');
  scan('.icon-btn.active', '图标按钮-激活');
  scan('.seg button.on', '分段控件-激活块');
  // 按钮
  scan('.btn.primary', '主按钮(发送)');
  scan('.btn', '次按钮');
  scan('.btn.ghost', '幽灵按钮');
  scan('.new-msg-pill', '有新回复 pill');
  scan('.brand-mark', '品牌标识');
  // 消息层级相关
  scan('.msg-card', '卡内容器(分工卡)');
  scan('.root-card', '主池任务卡');
  scan('.subtask-clickable', '子任务行');
  return rows;
})()`);

console.log('=== 选中态 / 按钮的**实际渲染**背景 ===');
for (const r of report ?? []) {
  if (r.count === 0) { console.log(`--   ${r.label.padEnd(22)} (页面上没有)`); continue; }
  const mark = r.isGradSoft ? '✅ 浅渐变' : r.hasGrad ? '🟦 深渐变' : '❌ 无渐变';
  console.log(`${mark} ${r.label.padEnd(22)} r=${String(r.radius).padEnd(10)} color=${String(r.color).padEnd(20)} ${r.img}`);
}

/* 布局诊断 */
const layout = await ev(`(() => {
  const wsv = document.querySelector('.workspace');
  const ct = document.querySelector('.col-thread');
  const cm = document.querySelector('.col-main');
  const cb = document.querySelector('.col-thread .composer-box');
  return {
    workspaceFlexWrap: getComputedStyle(wsv).flexWrap,
    workspaceFlexDir: getComputedStyle(wsv).flexDirection,
    workspaceHeight: Math.round(wsv.getBoundingClientRect().height),
    childrenHeights: [...wsv.children].map(c => c.className.split(' ')[0] + '=' + Math.round(c.getBoundingClientRect().height)),
    colThreadBg: ct ? getComputedStyle(ct).backgroundColor : null,
    colMainBg: cm ? getComputedStyle(cm).backgroundColor : null,
    threadComposerTop: cb ? Math.round(cb.getBoundingClientRect().top) : null,
    viewportH: window.innerHeight,
    composerBelowFold: cb ? cb.getBoundingClientRect().top > window.innerHeight : null,
  };
})()`);
console.log('\n=== 布局诊断 ===');
console.log(JSON.stringify(layout, null, 1));

ws.close();
process.exit(0);
