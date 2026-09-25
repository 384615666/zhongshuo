/**
 * 导航探针：复现"点开任务详情跳转其他页面"的问题。
 * 连到真实 Electron 窗口，模拟点击并报告导航前后的状态。
 *
 * 用法：先 pnpm run desktop:debug，再 node scripts/probe-nav.mjs
 */

const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('找不到 Electron 窗口');

const ws = new WebSocket(page.webSocketDebuggerUrl);
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
    }, 10_000);
    pending.set(id, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
  return { value: r.result?.result?.value };
}

async function snapshot(label) {
  const s = await ev(`
    (() => ({
      hash: location.hash,
      pageTitle: document.querySelector('.page-title')?.textContent?.trim() ?? null,
      hasRoomPool: !!document.querySelector('.pool'),
      hasThreadPanel: !!document.querySelector('.col-thread'),
      hasOverlay: !!document.querySelector('.detail-overlay'),
      overlayTitle: document.querySelector('.detail-panel-title')?.textContent?.trim() ?? null,
      hasTaskDetail: document.body.innerText.includes('任务属性'),
      rootCards: document.querySelectorAll('.root-card').length,
      poolScroll: document.querySelector('.pool')?.scrollTop ?? null,
    }))()
  `);
  console.log(`${label}:`, JSON.stringify(s.value, null, 0));
  return s.value;
}

/* 打开房间（recovery=0 避免弹窗遮挡），整页重载确保状态干净 */
await ev(`
  (() => {
    if (location.hash !== '#/project/proj_zs_01/room/room_dev_hall?recovery=0') {
      location.hash = '/project/proj_zs_01/room/room_dev_hall?recovery=0';
    }
    location.reload();
    return true;
  })()
`);
await sleep(3000);
await snapshot('① 进入房间');

/* 用例更新（2026-09-24 减负）：卡片上的「任务详情」按钮早已删除，
   现在卡片入口是「标题 / 回复数 / ⋯ → 打开回复串」，详情在线程「详情」分组内就地渲染。
   这套探针要验证的性质不变：**点开不接管工作区、返回能回到房间**。 */
const clicked = await ev(`
  (() => {
    const btn = document.querySelector('.root-card .root-replies-btn')
      || document.querySelector('.root-card .root-title-btn');
    if (!btn) return 'NO_ENTRY';
    btn.click();
    return 'clicked';
  })()
`);
console.log('点击结果:', clicked.value);
await sleep(1400);
const afterClick = await snapshot('② 点击卡片入口后');

if (afterClick.hasRoomPool && afterClick.hasThreadPanel) {
  console.log('  → 回复串与房间主池同时保留（正确：就地打开，不接管工作区）');
} else if (!afterClick.hasRoomPool) {
  console.log('  → 房间被替换掉了（错误：打开线程不应夺走主池）');
}

/* 收起/返回应回到只有主池的房间视图 */
const backClicked = await ev(`
  (() => {
    const b = document.querySelector('.col-thread .thread-nav-back');
    if (!b) return 'NO_BACK';
    b.click();
    return 'ok';
  })()
`);
console.log('返回按钮:', backClicked.value);
await sleep(1200);
const afterBack = await snapshot('③ 点「收起/返回」后');
if (afterBack.hasRoomPool && !afterBack.hasThreadPanel) {
  console.log('  → 已回到房间主池（正确：收起回复串不停止任务）');
} else {
  console.log('  → 未正确回到主池（错误）');
}

/* 重新打开，供后续观察 */
const reopen = await ev(`
  (() => {
    const btn = document.querySelector('.root-card .root-replies-btn')
      || document.querySelector('.root-card .root-title-btn');
    if (!btn) return 'NO_ENTRY';
    btn.click();
    return 'ok';
  })()
`);
await sleep(1200);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(900);
const afterEsc = await snapshot('④ 再次打开后按 Esc');
/* 用例更新（2026-09-24 减负）：Esc 不再关闭回复串（没有"覆盖面板"这个对象了），
   它现在的正确行为是**什么都不做**：回复串仍在，任务不受影响。 */
console.log(afterEsc.hasThreadPanel ? '  → Esc 不关闭回复串（符合减负后的行为：只有收起/返回会回主池）'
  : '  → 回复串被 Esc 关掉了（与减负后的交互不符）');
console.log('重开按钮:', reopen.value);

ws.close();
process.exit(0);
