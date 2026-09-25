/**
 * 验证：侧栏与多项目导航（第十五批 §17.1 / §17.7，对应 RT-26）。
 *
 * 这一版**取代**第十三批的侧栏用例。设计已按用户确认改版：
 *  旧：分组 项目 → 项目成员 → 工作 → 功能；项目全列；独立 Git / Runtime / 文件与改动入口
 *  新：上四固定入口（搜索与收藏 / 文件与 Git / 任务看板 / 成员管理）
 *      → 项目区（只显示勾选项目，可滚动）
 *      → 下两固定入口（待我处理 / 设置）
 *
 * 旧断言（"侧栏有独立 Git 项""有项目成员分组""管理链接直达 /members"等）
 * 在新设计下**不再成立**，按交接文档 §8「不要让测试继续断言旧侧栏入口必须存在」
 * 重写为断言新结构。第十三批修的两个真 bug 仍然锁在这里：
 *  ① 每个功能页都能从侧栏确认自己在哪；② 窄视口底部入口不被推走。
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
    const t = setTimeout(() => { p.delete(i); res({}); }, 10000);
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
await c.ev(`window.zhongshuo?.window.show()`);

/**
 * 回到种子。
 * 第十五批注意：导航显示偏好持久化在独立 localStorage key，
 * **reload 清不掉** —— 不显式移除就会带着上一轮的当前项目进入下一段断言。
 */
async function reset() {
  await c.send('Page.enable');
  await c.ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); true`);
  await c.send('Page.reload', { ignoreCache: true });
  await sleep(2600);
  c = await connect();
  await c.ev(`window.zhongshuo?.window.show()`);
  await sleep(300);
}

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const go = async (h) => { await c.ev(`location.hash=${JSON.stringify(h)}; true`); await sleep(1400); };
const labels = (sel) => c.ev(`
  (() => [...document.querySelectorAll(${JSON.stringify(sel)})]
    .map(e => e.innerText.trim().split('\\n')[0]).filter(Boolean))()
`);

await reset();

/* ============================================================
   1. 三段式布局：上四入口顺序 / 中项目区滚动 / 下两入口固定
   ============================================================ */
await go('/project/proj_zs_01/room/room_dev_hall');
const layout = await c.ev(`
  (() => {
    const top = document.querySelector('.sidebar-top');
    const scroll = document.querySelector('.sidebar-scroll');
    const foot = document.querySelector('.sidebar-foot');
    const rect = (el) => el ? el.getBoundingClientRect() : null;
    return {
      上区顺序: top ? [...top.querySelectorAll('.side-item-label')].map(e => e.innerText.trim()) : [],
      下区顺序: foot ? [...foot.querySelectorAll('.side-item-label')].map(e => e.innerText.trim()) : [],
      中区滚动: scroll ? getComputedStyle(scroll).overflowY : null,
      上区不滚动: top ? getComputedStyle(top).overflowY : null,
      上在滚动区上方: rect(top) && rect(scroll) ? rect(top).bottom <= rect(scroll).top + 1 : null,
      下在滚动区下方: rect(scroll) && rect(foot) ? rect(foot).top >= rect(scroll).bottom - 1 : null,
    };
  })()
`);
check('侧栏上四入口顺序为 搜索与收藏 → 文件与 Git → 任务看板 → 成员管理',
  JSON.stringify(layout?.上区顺序) === JSON.stringify(['搜索与收藏', '文件与 Git', '任务看板', '成员管理']),
  (layout?.上区顺序 ?? []).join(' → '));
check('底部固定为 待我处理 → 设置',
  // 用例更新（第二十六批第二轮）：用户担心误触，「项目全停」已从侧栏底部
  // 移入「项目设置 → 高级操作」（那里还有确认弹窗二次确认）。
  JSON.stringify(layout?.下区顺序) === JSON.stringify(['待我处理', '设置']),
  (layout?.下区顺序 ?? []).join(' → '));
check('只有中间项目区可滚动（上区不滚动）',
  layout?.中区滚动 === 'auto' && layout?.上区不滚动 === 'visible',
  `中=${layout?.中区滚动} 上=${layout?.上区不滚动}`);
check('上区在滚动区之上、下区在其之下（固定区不会被推走）',
  layout?.上在滚动区上方 === true && layout?.下在滚动区下方 === true);

const removed = await c.ev(`
  (() => {
    const items = [...document.querySelectorAll('.sidebar .side-item-label')].map(e => e.innerText.trim());
    const headings = [...document.querySelectorAll('.sidebar .side-heading')].map(e => e.innerText.trim());
    return {
      无独立Git: !items.includes('Git'),
      无独立Runtime: !items.includes('Runtime'),
      无文件与改动: !items.includes('文件与改动'),
      无收藏与搜索: !items.includes('收藏与搜索'),
      无项目成员分组: !headings.some(h => h.includes('项目成员')),
      无工作分组: !headings.includes('工作'),
      无功能分组: !headings.includes('功能'),
    };
  })()
`);
check('不再有独立「Git」「Runtime」「文件与改动」「收藏与搜索」侧栏入口',
  removed?.无独立Git && removed?.无独立Runtime && removed?.无文件与改动 && removed?.无收藏与搜索);
check('不再有「项目成员 / 工作 / 功能」旧分组标题',
  removed?.无项目成员分组 && removed?.无工作分组 && removed?.无功能分组);

/* ============================================================
   2. bug 修复仍成立：每个功能页都能从侧栏确认自己在哪
   ============================================================ */
const activeCases = [
  ['搜索与收藏', '/library?tab=search', '搜索与收藏'],
  ['文件与 Git', '/project/proj_zs_01/files', '文件与 Git'],
  ['任务看板', '/tasks?scope=visible', '任务看板'],
  ['成员管理', '/project/proj_zs_01/members', '成员管理'],
  ['待我处理', '/activity', '待我处理'],
  ['设置', '/settings?section=app', '设置'],
];
for (const [name, hash, expect] of activeCases) {
  await go(hash);
  const on = await c.ev(`
    (() => [...document.querySelectorAll('.sidebar .side-item.active')]
      .map(e => e.querySelector('.side-item-label')?.innerText.trim()).filter(Boolean))()
  `);
  check(`「${name}」页在侧栏高亮自己`, (on ?? []).includes(expect), (on ?? []).join('+') || '(无高亮)');
}

/* ============================================================
   3. 当前项目标记 与 位置高亮 分离
   ============================================================ */
await go('/project/proj_zs_01/files?tab=git');
const twoKinds = await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.sidebar .side-row')];
    const cur = rows.filter(r => r.querySelector('.side-current-tag'));
    const pos = [...document.querySelectorAll('.sidebar .side-item.active')];
    return {
      当前项目标记: cur.map(r => r.querySelector('.side-item-label')?.innerText.trim()),
      位置高亮: pos.map(e => e.querySelector('.side-item-label')?.innerText.trim()),
      房间未被位置高亮: ![...document.querySelectorAll('.sidebar .side-item.sub.active')].length,
    };
  })()
`);
check('当前项目有「当前」上下文标记', (twoKinds?.当前项目标记 ?? []).includes('众说'), JSON.stringify(twoKinds?.当前项目标记));
check('在文件页时位置高亮落在「文件与 Git」，房间不被标成当前页',
  twoKinds?.位置高亮?.includes('文件与 Git') === true && twoKinds?.房间未被位置高亮 === true,
  JSON.stringify(twoKinds?.位置高亮));

await go('/project/proj_zs_01/room/room_dev_hall');
const roomActive = await c.ev(`
  (() => {
    const on = [...document.querySelectorAll('.sidebar .side-item.active')];
    return {
      标签: on.map(e => e.querySelector('.side-item-label')?.innerText.trim()),
      是子项: on.map(e => e.classList.contains('sub')),
    };
  })()
`);
check('房间页高亮具体房间（而非只高亮功能页）',
  roomActive?.标签?.includes('开发大厅') === true, (roomActive?.标签 ?? []).join('+'));
check('高亮的房间项带缩进样式（sub）', roomActive?.是子项?.includes(true) === true);
// 缩进要看**内容**的横坐标：项目行含展开箭头，拿整行盒子比会得出相反结论
// （实测：项目行图标 x=32；房间图标 x=42 —— 内容确实是递进的）。
// 用例更新（第二十六批）：功能入口的图标列也统一到 x=32（与项目行齐平）——
// 「全局搜索」并入「搜索与收藏」同一行后，若不统一会出现 16/46/16/16 的错层级，
// 使「搜索与收藏」看起来像项目的子项。所以断言改为「功能与项目同列、房间再缩进」。
check('房间项缩进在所属项目下（内容横坐标递进）',
  (await c.ev(`
    (() => {
      const iconLeft = (root) => {
        const icon = root?.querySelector('svg');
        return icon ? icon.getBoundingClientRect().left : null;
      };
      const func = iconLeft(document.querySelector('.sidebar-top .side-item'));
      const proj = iconLeft(document.querySelector('.sidebar .side-project .side-item-label-btn'));
      const room = iconLeft(document.querySelector('.sidebar .side-item.sub'));
      if (func === null || proj === null || room === null) return { ok: false, func, proj, room };
      // 功能入口与项目行同一图标列（x 相等），房间再缩进一级
        return { ok: room > proj && proj === func, func, proj, room };
    })()
  `)).ok === true);

/* ============================================================
   4. 显示与焦点分离（RT-26 第 2 条）
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
const firstList = await labels('.sidebar-scroll .side-item-label');
check('首次只显示当前项目（含其房间与私信）',
  firstList?.[0] === '众说' && firstList?.includes('开发大厅') && !firstList?.includes('data-backfill'),
  (firstList ?? []).join('/'));

await c.ev(`(() => { document.querySelector('.side-project-picker')?.click(); return true; })()`);
await sleep(700);
const menuRows = await c.ev(`
  (() => [...document.querySelectorAll('.menu-project-row')].map(r => ({
    名称: r.querySelector('.menu-project-name')?.innerText.trim().split('\\n')[0],
    勾选: r.querySelector('.menu-check')?.classList.contains('on'),
    锁定: r.querySelector('.menu-check')?.classList.contains('locked'),
  })))()
`);
check('顶栏菜单为每个项目提供勾选框',
  (menuRows ?? []).length >= 3 && menuRows.every((r) => typeof r.勾选 === 'boolean'),
  JSON.stringify(menuRows));
check('当前项目的勾选框被锁定（不可隐藏）',
  menuRows?.find((r) => r.名称 === '众说')?.锁定 === true);

// 勾选 data-backfill：只增加显示，不切焦点
await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.menu-project-row')];
    rows.find(r => r.innerText.includes('data-backfill'))?.querySelector('.menu-check')?.click();
    return true;
  })()
`);
await sleep(800);
const afterCheck = await c.ev(`
  (() => ({
    当前项目: document.querySelector('.side-project-picker-name')?.innerText.trim(),
    顶栏显示数: document.querySelector('.side-project-picker-count')?.innerText.trim() ?? null,
    侧栏项目: [...document.querySelectorAll('.sidebar-scroll .side-item-label')].map(e => e.innerText.trim()),
  }))()
`);
check('勾选项目只增加侧栏显示，不改变当前项目',
  afterCheck?.当前项目 === '众说' && afterCheck?.侧栏项目?.includes('data-backfill') === true,
  JSON.stringify(afterCheck));
// 用例更新（第二十六批）：项目选择器从应用内顶栏移到**侧栏最顶部**，
// 计数文案随之简化为"显示 N 个"（侧栏宽度 246px，写全"个项目"会挤掉项目名）。
check('侧栏顶部选择器以「显示 N 个」提示，不横排所有项目名',
  /显示 \d+ 个/.test(String(afterCheck?.顶栏显示数)), String(afterCheck?.顶栏显示数));

// 点项目名才切焦点
await c.ev(`
  (() => {
    const btn = [...document.querySelectorAll('.menu-project-name')].find(e => e.innerText.includes('data-backfill'));
    if (btn) btn.click();
    return !!btn;
  })()
`);
await sleep(1500);
check('点击项目名称才切换当前项目',
  (await c.ev(`document.querySelector('.side-project-picker-name')?.innerText.trim()`)) === 'data-backfill');

// 当前项目不可隐藏
await c.ev(`(() => { document.querySelector('.side-project-picker')?.click(); return true; })()`);
await sleep(700);
await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.menu-project-row')];
    rows.find(r => r.innerText.includes('data-backfill'))?.querySelector('.menu-check')?.click();
    return true;
  })()
`);
await sleep(700);
check('尝试隐藏当前项目被拒绝（仍显示在侧栏）',
  (await c.ev(`
    (() => [...document.querySelectorAll('.sidebar-scroll .side-item-label')]
      .map(e => e.innerText.trim()).includes('data-backfill'))()
  `)) === true);
await c.ev(`(() => { document.body.click(); return true; })()`);
await sleep(400);

/* 房间点击也应聚焦所属项目。
   这一段**自建前置条件**，不依赖前一段留下的菜单/勾选状态（之前就是这样踩的坑：
   前一段的勾选动作把当前项目改成 data-backfill 后又取消了勾选，
   导致这里侧栏根本没有该项目，断言只因"找不到房间"失败）。
   做法：先把当前项目切到 data-backfill，这样它必然可见且展开。 */
await reset();
await go('/project/proj_backfill_02/room/room_bf_dev_hall');
await sleep(1200);
// 再回到众说的房间（此时 data-backfill 仍在可见集合里，因为切焦点不会移除可见项）
await go('/project/proj_zs_01/room/room_dev_hall');
await sleep(1400);
const roomClick = await c.ev(`
  (() => {
    const rooms = [...document.querySelectorAll('.sidebar .side-item.sub')];
    const target = rooms.find(function (e) {
      const proj = e.closest('.side-project');
      return proj && proj.innerText.indexOf('data-backfill') >= 0 && e.innerText.indexOf('开发大厅') >= 0;
    });
    if (!target) {
      return { clicked: false, rooms: rooms.map(function (e) {
        const proj = e.closest('.side-project');
        return (proj ? proj.innerText.split(String.fromCharCode(10))[0] : '?') + '/' + e.innerText.split(String.fromCharCode(10))[0];
      }) };
    }
    target.click();
    return { clicked: true, label: target.innerText.trim() };
  })()
`);
check('点另一个项目的房间会聚焦该项目', roomClick?.clicked === true, JSON.stringify(roomClick));
await sleep(1600);
check('房间点击后当前项目已切换为 data-backfill',
  (await c.ev(`document.querySelector('.side-project-picker-name')?.innerText.trim()`)) === 'data-backfill',
  `房间=${JSON.stringify(roomClick?.label)}`);

/* ============================================================
   5. 偏好持久化与容错（RT-26 第 9 条）
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
await c.ev(`(() => { document.querySelector('.side-project-picker')?.click(); return true; })()`);
await sleep(900);
/**
 * 用**真实鼠标事件**点勾选框，而不是 element.click()。
 * 踩过的坑：菜单刚打开时布局仍在落定，`.click()` 有时不生效
 * （实测勾选态不变、偏好也不写），而按坐标派发 mousePressed/Released 稳定生效。
 *
 * 另一个坑：这是**切换**而不是"设为显示"。若该项目已经是显示的，
 * 再点一次会把它关掉。所以先读当前勾选态，只在需要时才点。
 */
const setVisibleViaMenu = async (projectKeyword, want) => {
  const box = await c.ev(`
    (() => {
      const rows = [...document.querySelectorAll('.menu-project-row')];
      const t = rows.find(r => r.innerText.indexOf(${JSON.stringify(projectKeyword)}) >= 0);
      if (!t) return null;
      const chk = t.querySelector('.menu-check');
      const b = chk.getBoundingClientRect();
      return {
        x: Math.round(b.x + b.width / 2),
        y: Math.round(b.y + b.height / 2),
        isOn: chk.classList.contains('on'),
      };
    })()
  `);
  if (!box) return { ok: false, reason: 'no-row' };
  if (box.isOn === want) return { ok: true, alreadyCorrect: true };
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(900);
  return { ok: true, alreadyCorrect: false };
};
const applied = await setVisibleViaMenu('data-backfill', true);
check('勾选动作已作用到菜单（前置条件）', applied?.ok === true, JSON.stringify(applied));
const checkedNow = await c.ev(`
  (() => ({
    偏好: JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1') ?? '{}').visibleProjectIds,
  }))()
`);
check('勾选后偏好里记录了该项目（前置条件）',
  (checkedNow?.偏好 ?? []).includes('proj_backfill_02'), JSON.stringify(checkedNow));
/**
 * 不要用 `document.body.click()` 关菜单：Menu 的遮罩覆盖整屏，
 * 这一下会命中侧栏并**把刚勾选的项目又取消掉**（实测复发过两次）。
 * 菜单本身在导航后会自动关闭；这里只需要读状态，不需要主动关。
 */
await c.ev(`location.reload(); true`);
await sleep(2800);
c = await connect();
await c.ev(`window.zhongshuo?.window.show()`);
await sleep(400);
const persisted = await c.ev(`
  (() => ({
    侧栏项目: [...document.querySelectorAll('.sidebar-scroll .side-item-label')].map(e => e.innerText.trim()),
    当前项目: document.querySelector('.side-project-picker-name')?.innerText.trim(),
    偏好: JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1') ?? '{}'),
  }))()
`);
check('刷新后恢复显示偏好',
  persisted?.侧栏项目?.includes('data-backfill') === true && persisted?.当前项目 === '众说',
  JSON.stringify(persisted?.偏好));
// 展开态也要恢复，否则刷新后房间列表消失（实现时踩过：默认值覆盖了种子）
check('刷新后项目展开态恢复（房间仍可见）',
  persisted?.侧栏项目?.includes('开发大厅') === true,
  (persisted?.侧栏项目 ?? []).join('/'));
check('偏好里 visibleProjectIds 有序且以当前项目开头',
  Array.isArray(persisted?.偏好?.visibleProjectIds) && persisted.偏好.visibleProjectIds[0] === 'proj_zs_01',
  JSON.stringify(persisted?.偏好?.visibleProjectIds));

/* 失效 ID 必须被清理 */
await c.ev(`
  (() => {
    const p = JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1'));
    p.visibleProjectIds.push('proj_does_not_exist');
    localStorage.setItem('zhongshuo.nav.prefs.v1', JSON.stringify(p));
    return true;
  })()
`);
await c.ev(`location.reload(); true`);
await sleep(2800);
c = await connect();
await c.ev(`window.zhongshuo?.window.show()`);
await sleep(400);
check('失效项目 ID 被清理（不显示不存在的项目）',
  (await c.ev(`
    (() => ![...document.querySelectorAll('.sidebar-scroll .side-item-label')]
      .some(e => e.innerText.includes('does_not_exist')))()
  `)) === true);

/* 损坏的偏好不能影响启动 */
await c.ev(`localStorage.setItem('zhongshuo.nav.prefs.v1', '{ this is not json'); true`);
await c.ev(`location.reload(); true`);
await sleep(2800);
c = await connect();
await c.ev(`window.zhongshuo?.window.show()`);
await sleep(400);
check('偏好损坏时安全回退（侧栏四个功能入口仍在）',
  (await c.ev(`document.querySelectorAll('.sidebar-top .side-item').length`)) === 4);

/* ============================================================
   6. 去重：待我处理 / 设置 只保留侧栏底部这一个主入口
   ============================================================
   用例更新（第二十六批）：应用内那条顶栏（.topbar）已整条删除，
   原来的 `.topbar .icon-btn` 选择器不复存在。这项检查的**意图**不变 ——
   保证导航类入口不重复、且不散落在窗口外壳上。新的规则是：
   标题栏只承载**运行状态**（后台任务 / 恢复检查），导航与配置入口全在侧栏与设置里。 */
await reset();
const dup = await c.ev(`
  (() => {
    const tbar = [...document.querySelectorAll('.titlebar .titlebar-stat')].map(e => e.innerText.replace(/\\n/g, ' ').trim());
    const side = [...document.querySelectorAll('.sidebar .side-item-label')].map(e => e.innerText.trim());
    return {
      标题栏项: tbar,
      标题栏有待我处理: tbar.some(t => t.includes('待我处理')),
      标题栏有设置: tbar.some(t => t.includes('设置')),
      侧栏有待我处理: side.includes('待我处理'),
      侧栏有设置: side.includes('设置'),
      侧栏有项目全停: side.includes('项目全停'),
      有旧顶栏: !!document.querySelector('.topbar'),
    };
  })()
`);
check('「待我处理」只在侧栏底部，标题栏不重复一个',
  dup?.标题栏有待我处理 === false && dup?.侧栏有待我处理 === true,
  `标题栏=${(dup?.标题栏项 ?? []).join('|')}`);
check('「设置」主入口只在侧栏底部，标题栏不重复一个（§17.1）',
  dup?.标题栏有设置 === false && dup?.侧栏有设置 === true);
check('应用内顶部工具栏已整条移除（第二十六批）', dup?.有旧顶栏 === false);

/* ============================================================
   6b. 第二十六批：顶栏删除后各项的新落点
   ============================================================
   用户要求"这条顶部栏不要了"：项目选择栏 → 侧栏最顶部；
   搜索 → 「搜索与收藏」左边的小按钮；其他 → 设置。
   这里逐条锁住新位置，并特别验证**折叠侧栏后还能恢复** ——
   折叠按钮原本只存在于被删掉的那条顶栏里，一起搬进侧栏就会造成
   "折起来再也打不开"的死状态。 */
await reset();

const shell = await c.ev(`
  (() => {
    const tb = document.querySelector('.titlebar');
    const side = document.querySelector('.sidebar');
    const picker = document.querySelector('.side-project-picker');
    const iconBtn = document.querySelector('.side-row-flat .side-icon-btn');
    const libraryItem = document.querySelector('.side-row-flat .side-item');
    const foot = [...document.querySelectorAll('.sidebar-foot .side-item-label')].map(e => e.innerText.trim());
    const ib = iconBtn?.getBoundingClientRect(), lb = libraryItem?.getBoundingClientRect();
    return {
      有旧顶栏: !!document.querySelector('.topbar'),
      折叠按钮在标题栏: !!tb?.querySelector('.titlebar-icon'),
      标题栏有原型标注: !!tb?.querySelector('.proto-flag'),
      标题栏有状态: !!tb?.querySelector('.titlebar-stat'),
      选择器在侧栏第一个: side?.firstElementChild?.className,
      选择器存在: !!picker,
      // 第二十六批第二轮：用户要求搜索按钮放在「搜索与收藏」**右边**、贴近右边框
      搜索在收藏右边: ib && lb ? ib.left > lb.left : null,
      距右边缘px: iconBtn && side ? Math.round(side.getBoundingClientRect().right - iconBtn.getBoundingClientRect().right) : null,
      搜索是图标按钮: iconBtn?.className,
      底部项: foot,
    };
  })()
`);
check('应用内顶栏已删除，且折叠侧栏按钮移到标题栏（唯一不会自己消失的位置）',
  shell?.有旧顶栏 === false && shell?.折叠按钮在标题栏 === true,
  JSON.stringify({ 旧顶栏: shell?.有旧顶栏, 折叠按钮: shell?.折叠按钮在标题栏 }));
check('原型标注仍在窗口外壳上常驻可见（RT-26⑫ 不能被收进设置）',
  shell?.标题栏有原型标注 === true);
check('运行状态移到标题栏', shell?.标题栏有状态 === true);
check('项目选择器移到侧栏最顶部', shell?.选择器存在 === true && shell?.选择器在侧栏第一个 === 'sidebar-project',
  String(shell?.选择器在侧栏第一个));
check('全局搜索在「搜索与收藏」右边且贴近侧栏右边缘',
  shell?.搜索在收藏右边 === true && shell?.搜索是图标按钮 === 'side-icon-btn'
    && (shell?.距右边缘px ?? 999) <= 14,
  `距右边缘 ${shell?.距右边缘px}px`);
check('「项目全停」已移出侧栏（防止误触）',
  (shell?.底部项 ?? []).includes('项目全停') === false, (shell?.底部项 ?? []).join(' → '));

// 关键回归：折叠 → 恢复（防止死状态）
await c.ev(`document.querySelector('.titlebar-icon').click(); true`);
await sleep(800);
const collapsed = await c.ev(`
  (() => ({
    侧栏消失: !document.querySelector('.sidebar'),
    折叠按钮还在: !!document.querySelector('.titlebar-icon'),
    标题栏显示当前项目: document.querySelector('.titlebar-project')?.innerText.trim() ?? null,
  }))()
`);
await c.ev(`document.querySelector('.titlebar-icon').click(); true`);
await sleep(800);
const reopened = await c.ev(`({ 侧栏回来: !!document.querySelector('.sidebar'), 有选择器: !!document.querySelector('.side-project-picker') })`);
check('折叠侧栏后仍能恢复（不会成为打不开的死状态）',
  collapsed?.侧栏消失 === true && collapsed?.折叠按钮还在 === true
    && reopened?.侧栏回来 === true && reopened?.有选择器 === true,
  JSON.stringify({ collapsed, reopened }));
check('折叠时标题栏显示当前项目（否则看不到"我在哪个项目"）',
  String(collapsed?.标题栏显示当前项目).includes('众说'),
  String(collapsed?.标题栏显示当前项目));

/* 4 个功能入口必须在同一条图标基线上（x 相等）——
   实测过：搜索按钮并入「搜索与收藏」那一行后若不统一，
   会出现 16/46/16/16，让「搜索与收藏」看起来是项目的子项。 */
const align = await c.ev(`
  (() => {
    const xs = [...document.querySelectorAll('.sidebar-top .side-item')].map(el => {
      const svg = el.querySelector('svg');
      return svg ? Math.round(svg.getBoundingClientRect().left) : null;
    });
    return { xs, 全同列: xs.length > 0 && xs.every(x => x === xs[0]) };
  })()
`);
check('四个功能入口的图标在同一列（不出现被挤成子项的错层级）',
  align?.全同列 === true, JSON.stringify(align?.xs));

// 主题与账号已收进应用设置
await go('/settings?section=general');
const account = await c.ev(`
  (() => {
    const t = document.querySelector('.settings-body')?.innerText ?? '';
    return {
      有外观与账号: t.includes('外观与账号'),
      有深色外观: t.includes('深色外观'),
      有重置原型数据: t.includes('重置原型数据'),
      有退出: t.includes('退出'),
      标题栏无主题键: !document.querySelector('.titlebar .icon-btn'),
    };
  })()
`);
check('主题切换与账号/退出/重置原型数据收进应用设置',
  account?.有外观与账号 === true && account?.有深色外观 === true
    && account?.有重置原型数据 === true && account?.有退出 === true,
  JSON.stringify(account));

/* ============================================================
   7. bug 修复仍成立：窄视口下底部固定入口可达
   改进前：视口 ≤936px 就需滚动，最后一项被推出可视区。
   极矮视口允许中间滚动，但**底部固定区的入口必须始终可见**。
   ============================================================ */
for (const h of [1020, 880, 800]) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const r = await c.ev(`
    (() => {
      const scroll = document.querySelector('.sidebar-scroll');
      return {
        需要滚动: (scroll?.scrollHeight ?? 0) > (scroll?.clientHeight ?? 0) + 2,
        内容高: Math.round(scroll?.scrollHeight ?? 0),
        可视高: Math.round(scroll?.clientHeight ?? 0),
      };
    })()
  `);
  check(`视口 ${h}px：项目区放得下，无需滚动`,
    r?.需要滚动 === false,
    `内容 ${r?.内容高} / 可视 ${r?.可视高}`);
}

// 极矮视口：中间可滚，但底部入口不受影响
for (const h of [700, 620]) {
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const r = await c.ev(`
    (() => {
      const footItems = [...document.querySelectorAll('.sidebar-foot .side-item')];
      const last = footItems[footItems.length - 1];
      const box = last?.getBoundingClientRect();
      const topFirst = document.querySelector('.sidebar-top .side-item')?.getBoundingClientRect();
      return {
        底部最后一项可见: box ? box.bottom <= window.innerHeight + 1 && box.height > 0 : false,
        顶部第一项可见: topFirst ? topFirst.top >= 0 : false,
        底部项文本: last?.innerText.trim().split('\\n')[0] ?? null,
      };
    })()
  `);
  check(`视口 ${h}px：底部「${r?.底部项文本 ?? '?'}」始终可见（不随滚动被推走）`,
    r?.底部最后一项可见 === true && r?.顶部第一项可见 === true,
    JSON.stringify(r));
}
await c.send('Emulation.clearDeviceMetricsOverride');
await sleep(400);

await reset();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
c.ws.close();
process.exit(passed === results.length ? 0 : 1);
