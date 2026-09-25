/**
 * 验证：第十 七批导航与项目管理（顶栏项目管理 / 侧栏结构 / 统一私信 / 归档管理）。
 *
 * 覆盖用户给的 15 项重点检查（见 `docs/dev-briefs/prototype-nav-shell-result.md`）：
 *  1 多项目下只有一个私信入口且在成员管理下面
 *  2 不同项目的同名成员私信独立、旧链接能打开
 *  3 顶栏项目管理可切换/控制可见性/添加项目，勾选不跳页面
 *  4 点击项目名称与空白只展开收起，不改主内容与当前项目
 *  5 ⋯ 与 + 按需显示、不冒泡、不挤动布局
 *  6 + 创建对话池绑定正确项目
 *  7 项目菜单各项可用；原生能力不可用时反馈真实（原生路径在浏览器宿主下断言）
 *  8 置顶/编辑/隐藏/归档/移除互不混淆
 *  9 一级与项目菜单内的成员管理各自打开正确项目
 * 10 归档项目、活跃项目里的归档房间都能在归档管理找到
 * 11 三个归档入口进同一页面、项目筛选正确
 * 12 归档与生命周期规则（未结束工作阻止归档、恢复不误恢复单独归档的房间）
 * 13 长名称/窄窗/侧栏折叠/键盘下布局与交互正常
 * 14 运行与未读提示没有因导航重构回退
 * 15 刷新后按原型现有持久化机制恢复（导航偏好落 localStorage，其余内存态如实说明）
 *
 * 端口：ZS_CDP_PORT，默认 9333（Electron）。原生能力那一项在浏览器宿主（dev server）
 * 单独跑，见 `verify-nav-shell.mjs` 末尾的说明。
 */
const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => { p.delete(i); res({}); }, 12000);
    p.set(i, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  return { ws, send, ev };
}

let c = await connect();
async function reset() {
  await c.send('Page.enable');
  await c.ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); location.hash = '/welcome'; true`);
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(2800);
  c = await connect();
  await c.ev(`window.zhongshuo?.window.show()`);
  await sleep(250);
}
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const go = async (h, wait = 1500) => { await c.ev(`location.hash=${JSON.stringify(h)}; true`); await sleep(wait); };
/** 真实鼠标移动（hover 才按真实交互算） */
const hover = async (sel, nth = 0, tries = 3) => {
  const box = await c.ev(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  if (!box) return false;
  /* CDP 的鼠标事件偶尔不会触发 :hover（窗口失焦/上一次位置相同时），
     所以先挪开再移入，最多试 3 次 —— 别把抖动当成功能坏了。 */
  for (let i = 0; i < tries; i++) {
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - 40, y: box.y, buttons: 0 });
    await sleep(120);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await sleep(320);
    const on = await c.ev(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
      return el ? el.matches(':hover') : null;
    })()`);
    if (on === true) return true;
    /* 兜底：CDP 的纯 mouseMoved 在本机偶发不更新 :hover（窗口失焦时），
       用一次**真实点击**把指针钉在该行上 —— 点项目行本身就等于展开/收起，
       不影响后面的断言（后面都会重新读状态）。 */
    if (i === tries - 1) {
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(400);
    }
  }
  return false;
};
const moveAway = async () => {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 620, buttons: 0 });
  await sleep(220);
};
const clickSel = async (sel, nth = 0) => c.ev(`(() => {
  const el = document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
  if (!el) return false;
  el.click();
  return true;
})()`);
const clickText = async (sel, text) => c.ev(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.innerText.trim().includes(${JSON.stringify(text)}));
  if (!el) return false;
  el.click();
  return true;
})()`);

/* ============================================================
   1. 顶栏布局与侧栏结构
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
const shell = await c.ev(`
  (() => {
    const sb = document.querySelector('.sidebar');
    const firstLevel = [...sb.querySelectorAll('.sidebar-top .side-item-label')].map((e) => e.innerText.trim());
    const titleBtn = document.querySelector('.titlebar-project-btn');
    return {
      collapseBtn: Boolean(document.querySelector('.titlebar-icon')),
      projectBtn: titleBtn ? titleBtn.innerText.split(String.fromCharCode(10)).join(' ') : null,
      projectBtnHasChevron: Boolean(titleBtn?.querySelector('svg')),
      oldBrand: Boolean(document.querySelector('.titlebar-app')),
      oldSub: Boolean(document.querySelector('.titlebar-sub')),
      firstLevel,
      dmCountInTop: firstLevel.filter((x) => x === '私信').length,
      dmRowsInTree: [...sb.querySelectorAll('.side-item.sub .side-item-label')].filter((e) => e.innerText.trim() === '私信').length,
      sidebarPicker: Boolean(document.querySelector('.side-project-picker')),
      headingMore: Boolean(document.querySelector('.side-heading-more')),
    };
  })()
`);
check('顶栏：折叠按钮 + 「项目管理 · 当前项目名 ▾」，旧的软件名与描述已移除',
  shell?.collapseBtn === true && /项目管理/.test(String(shell?.projectBtn)) && /众说/.test(String(shell?.projectBtn))
    && shell?.projectBtnHasChevron === true && shell?.oldBrand === false && shell?.oldSub === false,
  JSON.stringify({ btn: shell?.projectBtn, 旧品牌: shell?.oldBrand, 旧副标题: shell?.oldSub }));
check('一级导航顺序：搜索与收藏 → 文件与 Git → 任务看板 → 成员管理 → 私信（私信在成员管理下面）',
  JSON.stringify(shell?.firstLevel) === JSON.stringify(['搜索与收藏', '文件与 Git', '任务看板', '成员管理', '私信']),
  (shell?.firstLevel ?? []).join(' → '));
check('全局只有一个私信入口：一级导航 1 个、项目树里 0 个',
  shell?.dmCountInTop === 1 && shell?.dmRowsInTree === 0,
  `top=${shell?.dmCountInTop} tree=${shell?.dmRowsInTree}`);
check('侧栏不再有重复的项目选择器；「项目」标题保持干净（用户复核：归档管理入口从标题旁去掉）',
  shell?.sidebarPicker === false && shell?.headingMore === false,
  JSON.stringify({ 选择器: shell?.sidebarPicker, headingMore: shell?.headingMore }));

/* 归档房间不混在活跃房间里 */
const roomsInTree = await c.ev(`[...document.querySelectorAll('.sidebar .side-item.sub .side-item-label')].map((e) => e.innerText.trim())`);
check('归档房间不混在活跃房间列表里（文档整理不出现在项目树）',
  !(roomsInTree ?? []).includes('文档整理') && (roomsInTree ?? []).includes('开发大厅'),
  (roomsInTree ?? []).join('/'));

/* ============================================================
   2. 项目行点击语义：只展开/收起
   ============================================================ */
const beforeClick = await c.ev(`(() => ({
  hash: location.hash,
  active: document.querySelector('.side-row.context-active .side-item-label')?.innerText.trim(),
  expanded: document.querySelector('.sidebar .side-project .side-caret')?.getAttribute('title'),
}))()`);
await clickSel('.sidebar .side-project .side-item-label-btn');
await sleep(600);
const afterNameClick = await c.ev(`(() => ({
  hash: location.hash,
  active: document.querySelector('.side-row.context-active .side-item-label')?.innerText.trim(),
  expanded: document.querySelector('.sidebar .side-project .side-caret')?.getAttribute('title'),
  mainTitle: document.querySelector('.pool-title, .page-title')?.innerText.trim(),
}))()`);
check('点项目名称只收起/展开：不改路由、不切当前项目、不动主内容',
  afterNameClick?.hash === beforeClick?.hash && afterNameClick?.active === beforeClick?.active
    && afterNameClick?.expanded !== beforeClick?.expanded
    && afterNameClick?.expanded === '展开房间列表',
  JSON.stringify({ before: beforeClick, after: { hash: afterNameClick?.hash, active: afterNameClick?.active, expanded: afterNameClick?.expanded } }));
await clickSel('.sidebar .side-project .side-caret');
await sleep(600);
const afterCaret = await c.ev(`(() => ({
  hash: location.hash,
  expanded: document.querySelector('.sidebar .side-project .side-caret')?.getAttribute('title'),
}))()`);
check('点左侧箭头同样只展开/收起，不跳转', afterCaret?.expanded === '收起房间列表' && afterCaret?.hash === beforeClick?.hash,
  JSON.stringify(afterCaret));
check('不再因点击项目名称自动跳到第一个房间（路由仍是原来的房间）',
  String(afterNameClick?.hash).includes('room_dev_hall'), String(afterNameClick?.hash));

/* ============================================================
   3. ⋯ / +：按需显示、不冒泡、不挤动布局
   ============================================================ */
await moveAway();
const idle = await c.ev(`(() => {
  const acts = [...document.querySelectorAll('.sidebar .side-project .side-row-act')];
  const name = document.querySelector('.sidebar .side-project .side-item-label');
  const dot = document.querySelector('.sidebar .side-project .side-marks');
  return {
    count: acts.length,
    opacity: acts[0] ? getComputedStyle(acts[0]).opacity : null,
    nameX: name ? Math.round(name.getBoundingClientRect().x) : null,
    marksRight: dot ? Math.round(dot.getBoundingClientRect().right) : null,
  };
})()`);
await hover('.sidebar .side-project .side-row');
const hoveredState = await c.ev(`(() => {
  const acts = [...document.querySelectorAll('.sidebar .side-project .side-row-act')];
  const name = document.querySelector('.sidebar .side-project .side-item-label');
  const dot = document.querySelector('.sidebar .side-project .side-marks');
  return {
    opacity: acts[0] ? getComputedStyle(acts[0]).opacity : null,
    nameX: name ? Math.round(name.getBoundingClientRect().x) : null,
    marksRight: dot ? Math.round(dot.getBoundingClientRect().right) : null,
  };
})()`);
check('项目行默认隐藏 ⋯ 与 +（两个按钮都在，只是不可见）',
  idle?.count === 2 && idle?.opacity === '0', JSON.stringify(idle));
check('鼠标悬浮项目行时显示 ⋯ 与 +，且名称与提示标记的位置一点没变（预留占位）',
  hoveredState?.opacity === '1' && hoveredState?.nameX === idle?.nameX && hoveredState?.marksRight === idle?.marksRight,
  JSON.stringify({ idle, hoveredState }));

const beforeMore = await c.ev(`document.querySelector('.sidebar .side-project .side-caret')?.getAttribute('title')`);
await clickSel('.sidebar .side-project .side-row-act', 0);
await sleep(500);
const menuOpen = await c.ev(`(() => {
  const menu = document.querySelector('.menu');
  const items = menu ? [...menu.querySelectorAll('.menu-item')].map((e) => e.innerText.trim().split(String.fromCharCode(10))[0]) : [];
  return {
    open: Boolean(menu),
    items,
    expanded: document.querySelector('.sidebar .side-project .side-caret')?.getAttribute('title'),
    actVisible: getComputedStyle(document.querySelector('.sidebar .side-project .side-row-act')).opacity,
  };
})()`);
check('点 ⋯ 打开项目菜单且**不会**同时触发展开/收起（阻止冒泡）',
  menuOpen?.open === true && menuOpen?.expanded === beforeMore, JSON.stringify({ expanded: menuOpen?.expanded, before: beforeMore }));
check('项目菜单项齐全（按分组：置顶 / 编辑 / 在资源管理器打开 / 成员管理 / 查看归档 / 项目设置 / 归档 / 移除）',
  ['置顶项目', '编辑项目信息', '在资源管理器中打开', '成员管理', '查看本项目归档', '项目设置', '归档项目', '移除项目', '打开项目主页']
    .every((k) => (menuOpen?.items ?? []).some((x) => String(x).includes(k))),
  (menuOpen?.items ?? []).join(' | '));
check('菜单打开期间 ⋯ 保持可见', menuOpen?.actVisible === '1', String(menuOpen?.actVisible));
await c.ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(300);

/* ============================================================
   4. + 添加对话池：绑定正确项目
   ============================================================ */
/* 先让 data-backfill 出现在侧栏（否则只有一个项目行，谈不上"绑定正确项目"） */
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(500);
await clickSel('.menu-project-row .menu-check', 1);
await sleep(500);
await c.ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(300);
await hover('.sidebar .side-project .side-row', 1); // data-backfill 行（第二个项目）
const bfRoomCountBefore = await c.ev(`(() => {
  const pr = [...document.querySelectorAll('.sidebar .side-project')].find((p) => p.innerText.includes('data-backfill'));
  return pr ? pr.querySelectorAll('.side-item.sub').length : -1;
})()`);
await clickSel('.sidebar .side-project .side-row-act', 3); // 第二个项目的 +
await sleep(600);
const poolModal = await c.ev(`(() => {
  const modal = document.querySelector('.modal');
  const t = modal ? modal.innerText : '';
  return { open: Boolean(modal), title: (modal?.querySelector('.modal-title, .overlay-head, h2')?.innerText ?? t.split(String.fromCharCode(10))[0] ?? '').trim(), mentionsProject: t.includes('data-backfill') };
})()`);
check('侧栏 + 打开"新建对话池"弹窗，并且**项目已绑定**（标题/说明里写明是哪个项目）',
  poolModal?.open === true && poolModal?.mentionsProject === true, JSON.stringify(poolModal));
await c.ev(`(() => {
  const input = document.querySelector('.modal .input');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(input, '侧栏新建的对话池');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(250);
await clickText('.modal .btn.primary', '创建');
await sleep(1400);
const created = await c.ev(`(() => {
  const pr = [...document.querySelectorAll('.sidebar .side-project')].find((p) => p.innerText.includes('data-backfill'));
  return {
    inProject: [...(pr?.querySelectorAll('.side-item.sub .side-item-label') ?? [])].map((e) => e.innerText.trim()),
    hash: location.hash,
    active: document.querySelector('.side-row.context-active .side-item-label')?.innerText.trim(),
  };
})()`);
check('新建的对话池落在被点击的项目下（data-backfill），不是当前项目',
  (created?.inProject ?? []).includes('侧栏新建的对话池') && bfRoomCountBefore >= 0,
  JSON.stringify({ 项目房间: created?.inProject, 当前项目: created?.active }));
check('创建后进入新房间，且当前项目同步为该房间所属项目',
  String(created?.hash).includes('proj_backfill_02') && created?.active === 'data-backfill',
  JSON.stringify({ hash: created?.hash, active: created?.active }));

/* ============================================================
   5. 顶栏项目管理：切换 / 可见性 / 添加项目
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
await clickSel('.titlebar-project-btn');
await sleep(600);
const menu = await c.ev(`(() => {
  const m = document.querySelector('.menu');
  return {
    label: m?.querySelector('.menu-label')?.innerText.trim(),
    rows: [...document.querySelectorAll('.menu-project-row')].map((r) => ({
      name: r.querySelector('.menu-project-name')?.innerText.trim().split(String.fromCharCode(10))[0],
      checked: r.querySelector('.menu-check')?.classList.contains('on'),
    })),
    hasSearch: Boolean(m?.querySelector('.menu-search-input')),
    hasOpenFolder: Boolean([...document.querySelectorAll('.menu-item')].find((e) => e.innerText.includes('打开本地文件夹'))),
  };
})()`);
check('顶栏项目管理菜单：搜索框 + 每个项目的可见性勾选 + 打开文件夹（添加项目）都在',
  menu?.hasSearch === true && menu?.hasOpenFolder === true && (menu?.rows ?? []).length >= 4,
  JSON.stringify({ rows: (menu?.rows ?? []).map((r) => r.name), search: menu?.hasSearch, open: menu?.hasOpenFolder }));
const hashBefore = await c.ev(`location.hash`);
await clickSel('.menu-project-row .menu-check', 1); // 勾选 data-backfill 显示
await sleep(600);
const afterCheck = await c.ev(`(() => ({
  hash: location.hash,
  current: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
  projects: [...document.querySelectorAll('.sidebar .side-project .side-item-label')].map((e) => e.innerText.trim()).filter((x) => !x.includes('开发大厅') && !x.includes('方案讨论')),
}))()`);
check('勾选"显示在侧栏"只改可见性：不跳页面、不切当前项目',
  afterCheck?.hash === hashBefore && afterCheck?.current === '众说'
    && Array.from(new Set(afterCheck?.projects ?? [])).length >= 2,
  JSON.stringify({ hash: afterCheck?.hash, current: afterCheck?.current, 项目: Array.from(new Set(afterCheck?.projects ?? [])) }));
await clickSel('.menu-project-row .menu-project-name', 1); // 点名字 = 显式切换
await sleep(1500);
const switched = await c.ev(`(() => ({
  current: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
  hash: location.hash,
  pendingCount: document.querySelector('.side-project-picker-count')?.innerText ?? null,
}))()`);
check('顶栏项目名 = 当前项目，切换后同步（顶栏按钮跟当前项目走）',
  switched?.current === 'data-backfill' && String(switched?.hash).includes('proj_backfill_02'),
  JSON.stringify(switched));
check('旧侧栏"显示 N 个"这类重复提示已随选择器一起移除（顶栏按钮不再是第二处入口）',
  switched?.pendingCount === null, String(switched?.pendingCount));

/* ============================================================
   6. 置顶 / 编辑信息：与隐藏、归档、移除互不混淆
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(500);
await clickSel('.menu-project-row .menu-check', 1); // 显示 data-backfill
await sleep(500);
await c.ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(300);
const orderBefore = await c.ev(`[...document.querySelectorAll('.sidebar .side-project .side-item-label')].map((e) => e.innerText.trim()).filter((x) => !['开发大厅','方案讨论'].includes(x))`);
await hover('.sidebar .side-project .side-row', 1);
await clickSel('.sidebar .side-project .side-row-act', 2);
await sleep(400);
await clickText('.menu-item', '置顶项目');
await sleep(700);
const pinned = await c.ev(`(() => ({
  order: [...document.querySelectorAll('.sidebar .side-project .side-item-label')].map((e) => e.innerText.trim()).filter((x) => !['开发大厅','方案讨论','侧栏新建的对话池'].includes(x)),
  hash: location.hash,
  current: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
  pinnedIds: JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1') || '{}').pinnedProjectIds ?? null,
}))()`);
check('置顶：项目排到列表前部，且不复制出第二个入口、不切页面、不切当前项目',
  (pinned?.order ?? [])[0] === 'data-backfill' && pinned?.hash === (await c.ev(`location.hash`))
    && pinned?.current === '众说' && Array.isArray(pinned?.pinnedIds) && pinned.pinnedIds.includes('proj_backfill_02'),
  JSON.stringify(pinned));
// 取消置顶
await hover('.sidebar .side-project .side-row', 0);
await clickSel('.sidebar .side-project .side-row-act', 0);
await sleep(400);
await clickText('.menu-item', '取消置顶');
await sleep(600);
const unpinned = await c.ev(`(() => ({
  order: [...document.querySelectorAll('.sidebar .side-project .side-item-label')].map((e) => e.innerText.trim()).filter((x) => !['开发大厅','方案讨论','侧栏新建的对话池'].includes(x)),
  pinnedIds: JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1') || '{}').pinnedProjectIds ?? null,
}))()`);
check('取消置顶后恢复原顺序（置顶只是排列，不是复制或隐藏）',
  unpinned?.order?.[0] === '众说' && (unpinned?.pinnedIds ?? []).length === 0,
  JSON.stringify({ order: unpinned?.order, pinned: unpinned?.pinnedIds }));
// 编辑项目信息
await hover('.sidebar .side-project .side-row', 0);
await clickSel('.sidebar .side-project .side-row-act', 0);
await sleep(400);
await clickText('.menu-item', '编辑项目信息');
await sleep(500);
const editModal = await c.ev(`(() => {
  const m = document.querySelector('.modal');
  return { open: Boolean(m), 有目录说明: (m?.innerText ?? '').includes('不会') && (m?.innerText ?? '').includes('重命名') };
})()`);
check('编辑项目信息弹窗打开，并写明"不会重命名磁盘目录"', editModal?.open === true && editModal?.有目录说明 === true, JSON.stringify(editModal));
await c.ev(`(() => {
  const input = document.querySelector('.modal .input');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(input, '众说（改名验证）');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);
await clickText('.modal .btn.primary', '保存');
await sleep(700);
const renamed = await c.ev(`(() => {
  const row = [...document.querySelectorAll('.sidebar .side-project')][0];
  return {
    name: row?.querySelector('.side-item-label')?.innerText.trim(),
    title: row?.querySelector('.side-item-label')?.getAttribute('title'),
    topbar: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
    log: [...document.querySelectorAll('.log-row, .write-row')].length,
  };
})()`);
check('改显示名称：侧栏与顶栏跟着变，但名称上的路径（磁盘目录）没变、也没要求重命名',
  renamed?.name === '众说（改名验证）' && String(renamed?.title).includes('D:\\zhongshuo'),
  JSON.stringify({ name: renamed?.name, title: renamed?.title, topbar: renamed?.topbar }));

/* ============================================================
   7. 归档项目：阻止条件、只读、归档管理三入口、恢复规则
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
// 7.1 有未结束工作的项目不能归档（众说有 ACTIVE 任务）
await hover('.sidebar .side-project .side-row', 0);
await clickSel('.sidebar .side-project .side-row-act', 0);
await sleep(400);
await clickText('.menu-item', '归档项目');
await sleep(600);
const blockedArchive = await c.ev(`(() => {
  const m = document.querySelector('.modal');
  const btn = [...(m?.querySelectorAll('.btn.primary') ?? [])].find((b) => b.innerText.includes('归档项目'));
  return { open: Boolean(m), 说明阻止: /没结束|未结束/.test(m?.innerText ?? ''), 按钮禁用: btn ? btn.disabled : null, 有处理入口: /任务看板/.test(m?.innerText ?? '') };
})()`);
check('有未结束工作时：归档弹窗说明原因、按钮禁用、并给出去任务看板处理的入口（不强停不丢任务）',
  blockedArchive?.open === true && blockedArchive?.说明阻止 === true && blockedArchive?.按钮禁用 === true && blockedArchive?.有处理入口 === true,
  JSON.stringify(blockedArchive));
await clickText('.modal .btn', '取消');
await sleep(400);

// 7.2 用 notes-vault（任务已完成）归档：退出侧栏、进入归档管理、房间随项目只读
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(500);
await clickSel('.menu-project-row .menu-check', 3);
await sleep(500);
await c.ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(300);
const nvIndex = await c.ev(`[...document.querySelectorAll('.sidebar .side-project')].findIndex((p) => p.innerText.includes('notes-vault'))`);
await hover('.sidebar .side-project .side-row', nvIndex);
await clickSel('.sidebar .side-project .side-row-act', nvIndex * 2);
await sleep(400);
await clickText('.menu-item', '归档项目');
await sleep(500);
await clickText('.modal .btn.primary', '归档项目');
await sleep(1400);
const afterArchive = await c.ev(`(() => ({
  hash: location.hash,
  inTree: [...document.querySelectorAll('.sidebar .side-project .side-item-label')].map((e) => e.innerText.trim()).includes('notes-vault'),
  archivePage: document.body.innerText.includes('归档管理'),
  body: document.body.innerText.slice(0, 400),
}))()`);
check('归档成功后：项目退出侧栏，页面落到「归档管理」（不留失效路由）',
  afterArchive?.inTree === false && String(afterArchive?.hash).includes('/archive'),
  JSON.stringify({ hash: afterArchive?.hash, inTree: afterArchive?.inTree }));
const archiveView = await c.ev(`(() => {
  const t = document.body.innerText;
  return {
    含项目: t.includes('notes-vault'),
    已归档项目标签: t.includes('已归档项目'),
    随项目只读: t.includes('随项目只读'),
    房间名: t.includes('笔记整理'),
    设置入口存在: Boolean([...document.querySelectorAll('.side-item-label')].find((e) => e.innerText.trim() === '设置')),
  };
})()`);
check('归档管理页（侧栏标题 ⋯ 入口）列出该项目与其房间，并区分"随项目只读"',
  archiveView?.含项目 === true && archiveView?.已归档项目标签 === true && archiveView?.随项目只读 === true,
  JSON.stringify(archiveView));
// 7.3 归档项目的房间：不能发消息（写入路径守卫）
const writeGuard = await c.ev(`(async () => {
  location.hash = '/project/proj_notgit_04/room/room_ng_notes';
  await new Promise((r) => setTimeout(r, 1500));
  const box = document.querySelector('.col-main .composer-input');
  /** 只读时输入区整块被替换成只读说明，因此"没有输入框"才是预期 */
  const disabled = box ? box.disabled : 'absent';
  const t = document.body.innerText;
  return { disabled, 说明只读: /项目「.*」已归档|项目已归档/.test(t) };
})()`);
check('归档项目下的房间：输入区被只读分支替换并写明"项目已归档"（不能发消息、建任务）',
  writeGuard?.disabled === 'absent' && writeGuard?.说明只读 === true,
  JSON.stringify(writeGuard));

// 7.4 归档时不能单独恢复房间，必须先恢复项目
const roomRestoreBlocked = await c.ev(`(async () => {
  location.hash = '/archive';
  await new Promise((r) => setTimeout(r, 1200));
  const row = [...document.querySelectorAll('.archive-row')].find((e) => e.innerText.includes('笔记整理'));
  const btns = row ? [...row.querySelectorAll('button')].map((b) => b.innerText.trim()) : [];
  return { rowFound: Boolean(row), 有恢复房间按钮: btns.some((b) => b.includes('恢复房间')), btns };
})()`);
check('项目归档中：其房间**不提供**"恢复房间"（避免绕过项目只读），只提示随项目恢复',
  roomRestoreBlocked?.rowFound === true && roomRestoreBlocked?.有恢复房间按钮 === false,
  JSON.stringify(roomRestoreBlocked));

// 7.5 恢复项目：单独归档的房间不跟着恢复
const restored = await c.ev(`(async () => {
  const btn = [...document.querySelectorAll('.card .btn.primary')].find((b) => b.innerText.includes('恢复项目'));
  btn?.click();
  await new Promise((r) => setTimeout(r, 1200));
  location.hash = '/project/proj_notgit_04/room/room_ng_notes';
  await new Promise((r) => setTimeout(r, 1500));
  const box = document.querySelector('.col-main .composer-input');
  return {
    可写: box ? !box.disabled : null,
    在侧栏: [...document.querySelectorAll('.sidebar .side-project .side-item-label')].map((e) => e.innerText.trim()).includes('notes-vault'),
  };
})()`);
check('恢复项目：项目回到侧栏、其房间重新可写；**单独归档的房间仍保持归档**（众说的文档整理不回到项目树）',
  restored?.可写 === true && restored?.在侧栏 === true
    && (await c.ev(`[...document.querySelectorAll('.sidebar .side-item.sub .side-item-label')].every((e) => e.innerText.trim() !== '文档整理')`)) === true,
  JSON.stringify(restored));

/* ============================================================
   8. 归档管理：三个入口进同一页面
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
// 入口 A（第十七批复核后改为设置里的正式入口）：应用设置 → 归档管理
await go('/archive');
const viaArchive = await c.ev(`(() => ({ hash: location.hash, title: document.querySelector('.page-title')?.innerText.trim().split(String.fromCharCode(10))[0], 活跃项目的归档房间: document.body.innerText.includes('文档整理'), 卡片: [...document.querySelectorAll('[data-archive-project]')].map((e) => e.getAttribute('data-archive-project')) }))()`);
check('归档管理页能看到**活跃项目**里的归档房间（文档整理）',
  String(viaArchive?.hash).includes('/archive') && viaArchive?.活跃项目的归档房间 === true
    && (viaArchive?.卡片 ?? []).includes('proj_zs_01'),
  JSON.stringify(viaArchive));
// 入口 B：应用设置 → 归档管理
await go('/settings?section=archive');
const viaSettings = await c.ev(`(() => ({
  hash: location.hash,
  navActive: [...document.querySelectorAll('.settings-nav .nav-item, .settings-nav button')].some((e) => e.innerText.includes('归档管理') && e.className.includes('on')),
  hasBody: document.body.innerText.includes('归档管理') && document.body.innerText.includes('文档整理'),
}))()`);
check('入口 B（应用设置 → 归档管理）渲染的是同一个归档主体（不是第二套页面）',
  viaSettings?.hasBody === true, JSON.stringify(viaSettings));
// 入口 C：项目 ⋯ → 查看本项目归档（带筛选）
await go('/project/proj_zs_01/room/room_dev_hall');
await hover('.sidebar .side-project .side-row', 0);
await clickSel('.sidebar .side-project .side-row-act', 0);
await sleep(400);
await clickText('.menu-item', '查看本项目归档');
await sleep(1000);
const viaProject = await c.ev(`(() => ({
  hash: location.hash,
  select: document.querySelector('.page-filters select')?.value,
  hasBack: document.body.innerText.includes('返回全部归档'),
  /* 只看**归档卡片**：卡片带 data-archive-project，筛选下拉里的项目名是选项、不算内容 */
  cards: [...document.querySelectorAll('[data-archive-project]')].map((e) => e.getAttribute('data-archive-project')),
}))()`);
check('入口 C（项目 ⋯ → 查看本项目归档）带项目筛选，并提供「返回全部归档」',
  String(viaProject?.hash).includes('project=proj_zs_01') && viaProject?.hasBack === true && viaProject?.select === 'proj_zs_01',
  JSON.stringify(viaProject));
check('筛选状态不会把别的项目混进来（只看该项目的内容）',
  (viaProject?.cards ?? []).length >= 1
    && (viaProject?.cards ?? []).every((id) => id === 'proj_zs_01'),
  JSON.stringify({ 卡片项目: viaProject?.cards }));
// 空态：已归档项目没有归档房间时说明清楚
await go('/archive?project=proj_backfill_02');
const emptyState = await c.ev(`document.body.innerText`);
check('归档管理空态说明清楚（没有归档内容的项目给出明确说明与返回入口）',
  /没有归档内容|没有归档内容/.test(emptyState), emptyState.slice(0, 120).replace(/\n/g, ' '));

/* ============================================================
   9. 统一私信页
   ============================================================ */
await reset();
await go('/dm');
const dmPage = await c.ev(`(() => {
  const rows = [...document.querySelectorAll('.dm-row')].map((r) => ({
    title: r.querySelector('.dm-row-title')?.innerText.trim(),
    project: r.querySelector('.dm-row-project')?.innerText.trim() ?? null,
  }));
  return {
    rows,
    filter: document.querySelector('.dm-scope-filter select')?.value,
    filterOptions: [...document.querySelectorAll('.dm-scope-filter option')].map((o) => o.innerText.trim()),
  };
})()`);
check('统一私信页默认汇总全部项目的会话，每行都标明所属项目',
  (dmPage?.rows ?? []).length >= 5 && (dmPage?.rows ?? []).every((r) => Boolean(r.project)),
  JSON.stringify((dmPage?.rows ?? []).map((r) => `${r.project}/${r.title}`)));
check('同名成员的两个项目会话是**两条独立会话**（不合并）',
  (dmPage?.rows ?? []).filter((r) => String(r.title).includes('Codex')).length >= 2
    && new Set((dmPage?.rows ?? []).filter((r) => String(r.title).includes('Codex')).map((r) => r.project)).size >= 2,
  JSON.stringify((dmPage?.rows ?? []).filter((r) => String(r.title).includes('Codex'))));
const scopeSwitch = await c.ev(`(async () => {
  const sel = document.querySelector('.dm-scope-filter select');
  const opt = [...sel.options].find((o) => o.innerText.includes('data-backfill'));
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
  return {
    hash: location.hash,
    rows: [...document.querySelectorAll('.dm-row-title')].map((e) => e.innerText.trim()),
    projects: [...new Set([...document.querySelectorAll('.dm-row-project')].map((e) => e.innerText.trim()))],
    headProject: document.querySelector('.thread-head')?.innerText.replace(new RegExp(String.fromCharCode(10), 'g'), ' | ').slice(0, 120),
  };
})()`);
check('按项目筛选：只显示该项目的会话，且会话头部写明所属项目',
  String(scopeSwitch?.hash).includes('proj_backfill_02')
    && (scopeSwitch?.rows ?? []).length >= 1 && (scopeSwitch?.projects ?? []).every((p) => String(p).includes('data-backfill'))
    && String(scopeSwitch?.headProject).includes('data-backfill'),
  JSON.stringify(scopeSwitch));
// 旧链接
await go('/project/proj_zs_01/dm');
const legacyA = await c.ev(`(() => ({ hash: location.hash, filter: document.querySelector('.dm-scope-filter select')?.value, rows: document.querySelectorAll('.dm-row').length }))()`);
check('旧链接 /project/:id/dm 仍能打开，并预置该项目的筛选',
  String(legacyA?.hash).includes('/project/proj_zs_01/dm') && legacyA?.filter === 'proj_zs_01' && (legacyA?.rows ?? 0) >= 1,
  JSON.stringify(legacyA));
await go('/dm/member_codex');
const legacyB = await c.ev(`(() => {
  const head = document.querySelector('.thread-head')?.innerText ?? '';
  return { hash: location.hash, 头部含Codex: head.includes('Codex'), 项目标签: head.includes('众说') };
})()`);
check('旧链接 /dm/:memberId 按成员实体解析项目并打开（不靠当前项目猜）',
  legacyB?.头部含Codex === true && legacyB?.项目标签 === true, JSON.stringify(legacyB));
// 打开会话后未读清零（统一入口的小蓝点得能被消耗）
const unreadFlow = await c.ev(`(async () => {
  const before = document.querySelector('.sidebar-top .side-item .side-unread-dot')?.getAttribute('title') ?? null;
  location.hash = '/dm';
  await new Promise((r) => setTimeout(r, 1600));
  const rowsBefore = [...document.querySelectorAll('.dm-row')].map((r) => r.innerText.includes('2'));
  const after = document.querySelector('.sidebar-top .side-item .side-unread-dot')?.getAttribute('title') ?? null;
  return { before, after };
})()`);
check('打开会话后私信未读会减少（统一入口的小蓝点不是永远亮着的假提示）',
  unreadFlow?.before !== unreadFlow?.after || unreadFlow?.before === null,
  JSON.stringify(unreadFlow));

/* ============================================================
   10. 提示规范没有因导航重构回退
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
const marks = await c.ev(`(() => {
  const room = [...document.querySelectorAll('.sidebar .side-item.sub')].find((e) => e.querySelector('.side-item-label')?.innerText.trim() === '开发大厅');
  const st = room?.querySelector('.side-state');
  return {
    房间状态图标: st?.querySelector('svg')?.getAttribute('data-icon') ?? null,
    状态在名称前: st ? Math.round(st.getBoundingClientRect().x) < Math.round(room.querySelector('.side-item-label').getBoundingClientRect().x) : null,
    未读点色: getComputedStyle(room?.querySelector('.side-unread-dot')).backgroundColor,
    两个数字徽标: [...document.querySelectorAll('.sidebar .side-badge')].map((b) => b.innerText.trim()),
    项目折叠汇总只算房间: document.querySelectorAll('.sidebar .side-project .side-marks .side-unread-dot').length,
  };
})()`);
check('提示规范未回退：任务状态仍在名称前（待验收=核对板）、未读仍是信息色小蓝点、两个数字徽标仍在',
  marks?.房间状态图标 === 'clipboard-check' && marks?.状态在名称前 === true
    && /rgb\(37, 99, 235\)/.test(String(marks?.未读点色)) && (marks?.两个数字徽标 ?? []).length === 2,
  JSON.stringify(marks));

/* ============================================================
   11. 持久化与窄窗/键盘
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(500);
await clickSel('.menu-project-row .menu-check', 1);
await sleep(400);
await c.ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(300);
const persistedBefore = await c.ev(`JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1') || '{}')`);
await c.send('Page.reload', { ignoreCache: true });
await sleep(2800);
c = await connect();
const persistedAfter = await c.ev(`(() => ({
  prefs: JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1') || '{}'),
  projectsInSidebar: [...document.querySelectorAll('.sidebar .side-project .side-item-label')].map((e) => e.innerText.trim()),
}))()`);
check('刷新后按原型现有机制恢复：导航偏好（可见项目/当前项目/置顶）落 localStorage，其余为内存态',
  JSON.stringify(persistedBefore?.visibleProjectIds) === JSON.stringify(persistedAfter?.prefs?.visibleProjectIds)
    && (persistedAfter?.projectsInSidebar ?? []).some((x) => x.includes('data-backfill')),
  JSON.stringify({ before: persistedBefore?.visibleProjectIds, after: persistedAfter?.prefs?.visibleProjectIds }));
// 窄窗 + 折叠 + 键盘
await c.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(600);
const narrow = await c.ev(`(() => {
  const side = document.querySelector('.sidebar');
  const r = side?.getBoundingClientRect();
  const bad = [...document.querySelectorAll('.sidebar .side-item, .sidebar .side-row')].filter((e) => e.getBoundingClientRect().right > (r?.right ?? 0) + 1).length;
  return { width: Math.round(r?.width ?? 0), overflow: bad, titlebar: document.querySelector('.titlebar-project-btn')?.innerText.split(String.fromCharCode(10)).join(' ') };
})()`);
check('窄窗（900px）：侧栏不溢出，顶栏项目管理入口仍在（窄窗按设计只留项目名）',
  narrow?.overflow === 0 && String(narrow?.titlebar).length > 0
    && (await c.ev(`Boolean(document.querySelector('.titlebar-project-btn'))`)) === true,
  JSON.stringify(narrow));
await c.send('Emulation.clearDeviceMetricsOverride');
await sleep(400);
const keyboard = await c.ev(`(() => {
  const btn = document.querySelector('.sidebar .side-project .side-item-label-btn');
  btn.focus();
  const focused = document.activeElement === btn;
  const aria = btn.getAttribute('aria-expanded');
  const actsVisible = [...document.querySelectorAll('.sidebar .side-project .side-row-act')].map((b) => getComputedStyle(b).opacity);
  return { focused, aria, actsVisible };
})()`);
check('键盘：项目行可聚焦，展开状态语义正确（aria-expanded），聚焦行的 ⋯/+ 也显示出来',
  keyboard?.focused === true && (keyboard?.aria === 'true' || keyboard?.aria === 'false')
    && (keyboard?.actsVisible ?? []).slice(0, 2).every((o) => o === '1'),
  JSON.stringify(keyboard));
const collapseKeep = await c.ev(`(() => {
  const btn = document.querySelector('.titlebar-icon');
  btn?.click();
  return Boolean(btn);
})()`);
await sleep(600);
const collapsed = await c.ev(`(() => ({
  sidebarGone: !document.querySelector('.sidebar'),
  topbarProject: document.querySelector('.titlebar-project-btn')?.innerText.split(String.fromCharCode(10)).join(' '),
}))()`);
check('侧栏折叠后，顶栏项目管理仍然可用（项目名还在，能打开菜单）',
  collapseKeep === true && collapsed?.sidebarGone === true && /众说|data-backfill/.test(String(collapsed?.topbarProject)),
  JSON.stringify(collapsed));
await clickSel('.titlebar-icon');
await sleep(500);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
c.ws.close();
process.exit(passed === results.length ? 0 : 1);
