/**
 * 验证：侧栏任务状态标记的**状态矩阵**（2026-09-25 用户确认方案）。
 *
 * 为什么单独一个脚本、而且跑在 dev server 上：
 *   用户要求验证"等待用户 / 受阻 / 待验收都不旋转""多任务混合时状态选择稳定"
 *   "99+ 封顶""计数为零隐藏徽标"等。但原型里**没有任何动作**能把任务改成
 *   WAITING_USER / BLOCKED（现状：只有交付动作会写 REVIEW / DONE / ACTIVE），
 *   种子数据也没有这两种状态，更造不出 150 条改动。
 *   用户的原话是"必要的验证数据应通过已有开发机制或临时方式提供，
 *   **不要为了截图永久改动无关的演示数据**" —— 所以这里走 dev server
 *   （vite 会把 src 下的 TS 按 URL 直接当模块提供）：页面里 `import('/src/data/store.ts')`
 *   拿到的就是 App 自己那个 store 实例，注入只存在于内存，刷新即回种子，
 *   演示数据一行没改。
 *
 * 端口约定：9340（与 Electron 9333 / smoke 9334 / visual 9335 / declutter 9336 /
 * zoom 9337 / dm 9338 / default-ai-input 9339 全部错开）。
 *
 * 用法：
 *   pnpm dev --port 5284       （另开一个终端）
 *   node scripts/verify-nav-marks.mjs
 */
const BASE = process.argv[2] ?? 'http://localhost:5284';
const CDP = process.env.ZS_NAV_MARKS_CDP_PORT ?? '9340';
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');

const browser = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!browser) throw new Error('找不到本机 Chrome/Edge');

const proc = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${CDP}`, '--no-first-run',
  '--user-data-dir=' + (process.env.TEMP + '/zs-nav-marks'), 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1800);

let id = 0;
const pending = new Map();
const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { pending.delete(i); res({}); }, 15000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
}
const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

await ev(`location.href = ${JSON.stringify(`${BASE}/#/project/proj_zs_01/room/room_dev_hall`)}; 'ok'`);
await sleep(2600);

/* ---------- 页面侧的小工具：与 App 共用同一个 store 实例 ---------- */
const probe = `
  (() => {
    const m = window.__zsNavMarks;
    return m ? m.getState().tasks.length : -1;
  })()
`;
await ev(`
  (async () => {
    window.__zsNavMarks = await import('/src/data/store.ts');
    return window.__zsNavMarks.getState().tasks.length;
  })()
`);
const bootTasks = await ev(probe);
check('注入通道可用：页面里能拿到 App 自己的 store 模块（dev server 按 URL 提供）',
  typeof bootTasks === 'number' && bootTasks > 0, `tasks=${bootTasks}`);

/** 读某个房间行（按名字）的两种提示 */
const readRow = (name, project = '众说') => ev(`
  (() => {
    const pr = [...document.querySelectorAll('.sidebar .side-project')]
      .find((p) => p.querySelector('.side-item-label')?.innerText.trim() === ${JSON.stringify(project)});
    const row = [...(pr?.querySelectorAll('.side-item.sub') ?? [])]
      .find((e) => e.querySelector('.side-item-label')?.innerText.trim() === ${JSON.stringify(name)});
    if (!row) return null;
    const label = row.querySelector('.side-item-label');
    const st = row.querySelector('.side-state');
    const svg = st?.querySelector('svg');
    const dot = row.querySelector('.side-unread-dot');
    const cs = st ? getComputedStyle(st) : null;
    return {
      名: label.innerText.trim(),
      名x: Math.round(label.getBoundingClientRect().x),
      状态: st ? {
        cls: st.className,
        icon: svg?.getAttribute('data-icon') ?? null,
        title: st.getAttribute('title'),
        x: Math.round(st.getBoundingClientRect().x),
        animation: cs.animationName,
        color: cs.color,
      } : null,
      图标: row.querySelector('svg')?.getAttribute('data-icon') ?? null,
      归档: row.classList.contains('archived'),
      dot: dot ? {
        x: Math.round(dot.getBoundingClientRect().x),
        bg: getComputedStyle(dot).backgroundColor,
        title: dot.getAttribute('title'),
      } : null,
    };
  })()
`);

/**
 * 把 room_dev_hall 的顶层任务按给定数组改状态（不够的位置保持原样）。
 * 只改内存状态，刷新即回种子。
 */
const setRoomStatuses = (statuses, { shuffleSeed = 0 } = {}) => ev(`
  (async () => {
    const m = window.__zsNavMarks;
    const statuses = ${JSON.stringify(statuses)};
    const seed = ${shuffleSeed};
    m.setState((s) => {
      const ids = s.tasks.filter((t) => t.roomId === 'room_dev_hall' && !t.parentTaskId).map((t) => t.id);
      let order = ids.slice();
      // 确定性的"打乱"：不依赖随机数，但每次调用给不同顺序，用来证明结果与数组顺序无关
      for (let k = 0; k < seed; k++) order = [order[order.length - 1], ...order.slice(0, -1)];
      const byId = new Map(ids.map((tid, i) => [tid, statuses[i]]));
      const all = [...s.tasks];
      for (let i = 0; i < order.length; i++) {
        const tid = order[i];
        const st = byId.get(tid);
        const idx = all.findIndex((t) => t.id === tid);
        if (idx >= 0 && st) all[idx] = { ...all[idx], status: st };
      }
      // seed>0 时把任务数组本身也倒过来放：顺序变了，侧栏结果不许变
      return { ...s, tasks: seed > 0 ? all.slice().reverse() : all };
    });
    await new Promise((r) => setTimeout(r, 60));
    return m.getState().tasks.filter((t) => t.roomId === 'room_dev_hall' && !t.parentTaskId).map((t) => t.status);
  })()
`);

const settled = async (name) => { await sleep(450); return readRow(name); };

/* 宿主/系统的"减少动效"偏好会决定 animation 是否为 none（本机系统开着 reduce），
   所以先显式模拟"正常偏好"，再断言"只有执行中在转"；reduce 下的表现见
   verify-sidebar.mjs（真实界面里断言，避免两处各测一半）。 */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await sleep(300);

/* ============================================================
   1. 四种状态各自的样子（执行中才转）
   ============================================================ */
const only = (st) => [st, 'DONE', 'DONE', 'DONE'];
const cases = [
  ['ACTIVE', '执行中', 'spinner-rays', true],
  ['WAITING_USER', '等你处理', 'hand', false],
  ['BLOCKED', '受阻', 'octagon', false],
  ['REVIEW', '待验收', 'clipboard-check', false],
];
for (const [status, label, icon, spinning] of cases) {
  await setRoomStatuses(only(status));
  const r = await settled('开发大厅');
  check(`${label}：名称前是 ${icon} 图标，${spinning ? '**在转**' : '不转（静态）'}，说明含数量`,
    r?.状态?.icon === icon
      && String(r?.状态?.title).startsWith(label)
      && /1 个/.test(String(r?.状态?.title))
      && (spinning ? r?.状态?.animation === 'side-spin' : r?.状态?.animation === 'none'),
    JSON.stringify({ icon: r?.状态?.icon, title: r?.状态?.title, animation: r?.状态?.animation }));
}

/* ============================================================
   2. 多任务混合：优先级稳定、与数组顺序无关、数量不被隐藏
   ============================================================ */
const mixed = ['ACTIVE', 'REVIEW', 'BLOCKED', 'WAITING_USER'];
await setRoomStatuses(mixed);
const mixA = await settled('开发大厅');
await setRoomStatuses(mixed, { shuffleSeed: 1 });
const mixB = await settled('开发大厅');
await setRoomStatuses(mixed, { shuffleSeed: 2 });
const mixC = await settled('开发大厅');
check('四类混合 → 显示优先级最高的「受阻」（受阻 → 等待 → 待验收 → 执行中）',
  mixA?.状态?.icon === 'octagon' && String(mixA?.状态?.title).startsWith('受阻'),
  JSON.stringify(mixA?.状态?.title));
check('状态选择与任务数组顺序无关（正序 / 倒序 / 再打乱三次结果完全一致）',
  Boolean(mixA?.状态?.title) && mixA?.状态?.title === mixB?.状态?.title && mixB?.状态?.title === mixC?.状态?.title
    && mixA?.状态?.icon === mixB?.状态?.icon && mixB?.状态?.icon === mixC?.状态?.icon,
  JSON.stringify({ 正序: mixA?.状态?.title, 倒序: mixB?.状态?.title, 再打乱: mixC?.状态?.title }));
check('悬浮说明列出实际存在的每一类数量（并行执行中的数量不被优先级藏掉）',
  /受阻 1 个 · 等你处理 1 个 · 待验收 1 个 · 执行中 1 个/.test(String(mixA?.状态?.title)),
  String(mixA?.状态?.title));

/* 子任务不重复计数：把同一个根任务的子任务也设成 ACTIVE，数量不应变化 */
const withChild = await ev(`
  (async () => {
    const m = window.__zsNavMarks;
    m.setState((s) => {
      const parent = s.tasks.find((t) => t.roomId === 'room_dev_hall' && !t.parentTaskId && t.id === 'task_12');
      return { ...s, tasks: s.tasks.map((t) => (t.parentTaskId === parent?.id ? { ...t, status: 'ACTIVE' } : t)) };
    });
    await new Promise((r) => setTimeout(r, 60));
    return true;
  })()
`);
const afterChild = await settled('开发大厅');
check('只算顶层任务：子任务也执行中时数量不变（父子不重复计）',
  withChild === true && afterChild?.状态?.title === mixA?.状态?.title,
  JSON.stringify({ 注入前: mixA?.状态?.title, 注入后: afterChild?.状态?.title }));

/* ============================================================
   3. 提示互不借用：未读点独立于任务状态
   ============================================================ */
const unreadWithRun = await settled('开发大厅');
check('任务执行中时未读点不变灰、也不贴到运行图标上（点仍在行尾，颜色仍是信息色）',
  unreadWithRun?.dot?.bg === 'rgb(37, 99, 235)'
    && Number(unreadWithRun?.dot?.x) > Number(unreadWithRun?.名x)
    && Number(unreadWithRun?.状态?.x) < Number(unreadWithRun?.名x),
  JSON.stringify({ 点: unreadWithRun?.dot, 状态位x: unreadWithRun?.状态?.x, 名称x: unreadWithRun?.名x }));

/* ============================================================
   4. 归档房间里真有未结束任务 / 没有未读也没有任务
   ============================================================ */
await ev(`
  (async () => {
    const m = window.__zsNavMarks;
    m.setState((s) => {
      // 把 文档整理（归档房）里塞一个执行中的顶层任务：状态位必须让给任务状态
      const donor = s.tasks.find((t) => t.id === 'task_12');
      const clone = { ...donor, id: 'tmp_archived_task', roomId: 'room_docs', status: 'ACTIVE', roomTaskNumber: 99 };
      return { ...s, tasks: [...s.tasks, clone] };
    });
    await new Promise((r) => setTimeout(r, 60));
    return true;
  })()
`);
const archivedRow = await settled('文档整理');
check('归档房间里有未结束任务时：图标位让给任务状态（可操作信息优先），行仍标为归档',
  archivedRow?.归档 === true && archivedRow?.状态?.icon === 'spinner-rays',
  JSON.stringify({ 归档: archivedRow?.归档, icon: archivedRow?.状态?.icon, title: archivedRow?.状态?.title }));

await setRoomStatuses(['DONE', 'DONE', 'DONE', 'DONE']);
const onlyUnread = await settled('开发大厅');
check('只有未读（未结束任务都没有）：只出现行尾蓝点，名称前不显示任何任务状态',
  onlyUnread?.状态 === null && Boolean(onlyUnread?.dot),
  JSON.stringify({ 状态: onlyUnread?.状态, dot: onlyUnread?.dot }));

// 顺带把该房间的未读水位推到很高 = "全部已读"，才能验证"什么都没有时两种提示都消失"
await ev(`
  (async () => {
    const m = window.__zsNavMarks;
    m.setState((s) => {
      const read = { ...s.readStates };
      for (const t of s.threads.filter((x) => x.roomId === 'room_dev_hall')) read[t.id] = Number.MAX_SAFE_INTEGER;
      return { ...s, readStates: read };
    });
    await new Promise((r) => setTimeout(r, 60));
    return true;
  })()
`);
const cleared = await settled('开发大厅');
check('没有未结束任务、也没有未读时，两种提示都不显示（回到默认占位）',
  cleared?.状态 === null && cleared?.dot === null && cleared?.名x === mixA?.名x,
  JSON.stringify({ 状态: cleared?.状态, dot: cleared?.dot, 名x: cleared?.名x }));

/* 只有执行中、没有未读：只出现名称前的旋转标志，行尾不该有点 */
await setRoomStatuses(['ACTIVE', 'DONE', 'DONE', 'DONE']);
const onlyRunning = await settled('开发大厅');
check('只有执行中（没有未读）：只出现名称前的放射状标志，行尾没有蓝点',
  onlyRunning?.状态?.icon === 'spinner-rays' && onlyRunning?.dot === null,
  JSON.stringify({ 状态: onlyRunning?.状态?.icon, dot: onlyRunning?.dot }));

/* ============================================================
   5. 数字徽标：位数变化不错位、99+ 封顶、零值隐藏、长名称
   ============================================================ */
const badge = (label) => ev(`
  (() => {
    const row = [...document.querySelectorAll('.sidebar .side-item')]
      .find((r) => r.querySelector('.side-item-label')?.innerText.trim() === ${JSON.stringify(label)});
    const b = row?.querySelector('.side-badge');
    const side = document.querySelector('.sidebar')?.getBoundingClientRect();
    return b ? {
      有: true,
      文本: b.innerText.trim(),
      title: b.getAttribute('title'),
      right: Math.round(b.getBoundingClientRect().right),
      侧栏右缘: side ? Math.round(side.right) : null,
    } : { 有: false, 侧栏右缘: side ? Math.round(side.right) : null };
  })()
`);
const setGitCount = (n) => ev(`
  (async () => {
    const m = window.__zsNavMarks;
    m.setState((s) => {
      const g = s.git[s.activeProjectId];
      return { ...s, git: { ...s.git, [s.activeProjectId]: { ...g, status: Array.from({ length: ${n} }, (_, i) => g.status[i % g.status.length]) } } };
    });
    await new Promise((r) => setTimeout(r, 60));
    return true;
  })()
`);
const oneDigit = await badge('文件与 Git');   // 种子值（一位数）
await setGitCount(12);
const twoDigit = await badge('文件与 Git');
await setGitCount(150);
const bigBadge = await badge('文件与 Git');
check('位数变化不错位：1 位 / 2 位 / 99+ 的徽标右缘一致，且都不越出侧栏',
  oneDigit?.有 === true && twoDigit?.文本 === '12' && bigBadge?.文本 === '99+'
    && oneDigit.right === twoDigit.right && twoDigit.right === bigBadge.right
    && bigBadge.right <= bigBadge.侧栏右缘 + 1,
  JSON.stringify({ 一位数: oneDigit, 两位数: twoDigit, 封顶: bigBadge }));
check('多位数封顶为 99+，真实数量留在 tooltip（不撑坏导航）',
  bigBadge?.有 === true && bigBadge?.文本 === '99+' && /150/.test(String(bigBadge?.title)),
  JSON.stringify(bigBadge));

await ev(`
  (async () => {
    const m = window.__zsNavMarks;
    m.setState((s) => ({ ...s, attention: [] }));
    await new Promise((r) => setTimeout(r, 60));
    return true;
  })()
`);
const zeroPending = await badge('待我处理');
check('待处理事项为零时隐藏徽标（不留"0"占位）', zeroPending?.有 === false, JSON.stringify(zeroPending));

/* 长名称：只改内存里的显示名，不动种子 */
await ev(`
  (async () => {
    const m = window.__zsNavMarks;
    m.setState((s) => ({
      ...s,
      rooms: s.rooms.map((r) => (r.id === 'room_design' ? { ...r, name: '一个特别特别长的房间名字用来验证省略号与不撑坏导航的行为是否正确' } : r)),
    }));
    await new Promise((r) => setTimeout(r, 60));
    return true;
  })()
`);
await sleep(400);
const longName = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.sidebar .side-item.sub')];
    const row = rows.find((e) => (e.querySelector('.side-item-label')?.innerText ?? '').startsWith('一个特别特别长'));
    const label = row?.querySelector('.side-item-label');
    const side = document.querySelector('.sidebar')?.getBoundingClientRect();
    return label ? {
      找到: true,
      截断: label.scrollWidth > label.clientWidth,
      名x: Math.round(label.getBoundingClientRect().x),
      名称右缘: Math.round(label.getBoundingClientRect().right),
      侧栏右缘: side ? Math.round(side.right) : null,
    } : { 找到: false };
  })()
`);
check('超长房间名：名称列省略号截断、不越出侧栏，且名称仍从同一列开始（缩进不变）',
  longName?.找到 === true && longName?.截断 === true && longName.名称右缘 <= longName.侧栏右缘 + 1
    && longName?.名x === mixA?.名x,
  JSON.stringify({ ...longName, 对照名x: mixA?.名x }));

/* ============================================================
   6. 注入只活在内存：刷新即回种子（演示数据没被改）
   ============================================================ */
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(2800);
const afterReload = await readRow('方案讨论');
const reloadRow = await readRow('开发大厅');
check('刷新后回到种子状态（注入不落盘、演示数据未改）：开发大厅恢复"待验收 + 执行中"聚合、方案讨论仍无提示',
  reloadRow?.状态?.icon === 'clipboard-check' && /待验收 1 个 · 执行中 2 个/.test(String(reloadRow?.状态?.title))
    && afterReload?.状态 === null && afterReload?.dot === null,
  JSON.stringify({ 开发大厅: reloadRow?.状态?.title, 方案讨论: afterReload?.状态 }));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
proc.kill();
process.exit(passed === results.length ? 0 : 1);
