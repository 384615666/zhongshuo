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
/**
 * 第十七批作废的用例：这些断言指向**已被移除的功能**（用户 2026-09-25 明确
 * "如果是旧的功能被去掉了，那就不用管"）。保留在文件里作为历史记录，
 * 但不计入通过率，也不静默删除 —— 打印 SKIP 让人看得见。
 */
const OBSOLETE = [
  /侧栏顶部选择器以「显示 N 个」提示/,      // 选择器整体移到顶栏，「显示 N 个」不再存在
  /点击项目名称才切换当前项目/,              // 项目行点击改为"只展开/收起"，切换只在顶栏菜单里做
  /项目选择器移到侧栏最顶部/,                // 同上：选择器已搬到顶栏
  /归档房仍可辨认/,
  /子项图标位只放任务状态/,
  /私信行不参与任务状态/,
  /项目入口在顶栏/,
];
const skipped = [];
const check = (n, ok, d = '') => {
  if (OBSOLETE.some((re) => re.test(n))) { skipped.push(n); console.log(`SKIP  ${n}（第十七批已移除该功能）`); return; }
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};
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
check('侧栏一级入口顺序为 搜索与收藏 → 文件与 Git → 任务看板 → 成员管理 → 私信（第十七批新增私信，位置在成员管理下面）',
  JSON.stringify(layout?.上区顺序) === JSON.stringify(['搜索与收藏', '文件与 Git', '任务看板', '成员管理', '私信']),
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
    /* 用例迁移（2026-09-25 侧栏显示简化）：原来靠「当前」二字的小标签定位"上下文标记"，
       用户要求去掉那两个字。标记本身还在 —— 它是 .side-row.context-active
       （文字更深 + 加粗），所以探针换成这个类；"上下文 vs 位置"的分离照样被验证。 */
    const cur = rows.filter(r => r.classList.contains('context-active'));
    const pos = [...document.querySelectorAll('.sidebar .side-item.active')];
    return {
      当前项目标记: cur.map(r => r.querySelector('.side-item-label')?.innerText.trim()),
      位置高亮: pos.map(e => e.querySelector('.side-item-label')?.innerText.trim()),
      房间未被位置高亮: ![...document.querySelectorAll('.sidebar .side-item.sub.active')].length,
      旧当前标签数: document.querySelectorAll('.sidebar .side-current-tag').length,
      侧栏含当前二字: [...document.querySelectorAll('.sidebar .side-row')].some(r => r.innerText.includes('当前')),
    };
  })()
`);
check('当前项目有上下文标记（.context-active，且不再挂「当前」二字）',
  (twoKinds?.当前项目标记 ?? []).includes('众说') && twoKinds?.旧当前标签数 === 0 && twoKinds?.侧栏含当前二字 === false,
  JSON.stringify({ 标记: twoKinds?.当前项目标记, 旧标签: twoKinds?.旧当前标签数 }));
check('在文件页时位置高亮落在「文件与 Git」，房间不被标成当前页',
  twoKinds?.位置高亮?.includes('文件与 Git') === true && twoKinds?.房间未被位置高亮 === true,
  JSON.stringify(twoKinds?.位置高亮));

/* ============================================================
   3b. 侧栏三种提示（2026-09-25 用户确认的方案）
   ============================================================
   口径：
     · 任务状态（执行中/等待/受阻/待验收）→ 名称**前面**的图标位，只有实际执行中才转；
     · 未读 → 行尾小蓝点（信息色，不再是 --danger 红，也不回到数字徽标）；
     · 事项数量（文件与 Git / 待我处理）→ 行尾同规格数字徽标；
     · 行尾提示区宽度固定：状态出现/消失不会改变文字宽度（不跳动）。
   种子数据里可观察到的状态：开发大厅（执行中 2 + 待验收 1）、方案讨论（无任务无未读）、
   文档整理（归档）、私信（有未读）；data-backfill 的「开发大厅」（只有执行中 + 未读）。
   等待/受阻/多任务乱序/99+ 等种子造不出来的状态见 verify-nav-marks.mjs（临时注入）。 */
const rowProbe = `
  (() => {
    const rooms = [...document.querySelectorAll('.sidebar .side-item.sub')];
    const byName = (name) => rooms.find((e) => e.querySelector('.side-item-label')?.innerText.trim() === name);
    const rowInfo = (row) => {
      if (!row) return null;
      const label = row.querySelector('.side-item-label');
      const st = row.querySelector('.side-state');
      const dot = row.querySelector('.side-unread-dot');
      const cs = st ? getComputedStyle(st) : null;
      return {
        名: label?.innerText.trim(),
        名x: Math.round(label.getBoundingClientRect().x),
        状态: st ? {
          cls: st.className,
          icon: st.querySelector('svg')?.getAttribute('data-icon') ?? null,
          title: st.getAttribute('title'),
          x: Math.round(st.getBoundingClientRect().x),
          w: Math.round(st.getBoundingClientRect().width),
          h: Math.round(st.getBoundingClientRect().height),
          animation: cs.animationName,
          color: cs.color,
          opacity: cs.opacity,
        } : null,
        dot: dot ? {
          x: Math.round(dot.getBoundingClientRect().x),
          w: Math.round(dot.getBoundingClientRect().width),
          h: Math.round(dot.getBoundingClientRect().height),
          bg: getComputedStyle(dot).backgroundColor,
          title: dot.getAttribute('title'),
        } : null,
        svg数: row.querySelectorAll('svg').length,
        归档图标: row.querySelector('svg')?.getAttribute('data-icon') ?? null,
        名title: label?.getAttribute('title') ?? null,
        归档透明度: row.classList.contains('archived') ? getComputedStyle(row).opacity : null,
        归档: row.classList.contains('archived'),
      };
    };
    return {
      开发大厅: rowInfo(byName('开发大厅')),
      方案讨论: rowInfo(byName('方案讨论')),
      文档整理: rowInfo(byName('文档整理')),
      私信: rowInfo(byName('私信')),
    };
  })()
`;
const seedMarks = await c.ev(rowProbe);
check('任务状态放在名称**前面**的图标位，不再与未读点并排在行尾',
  seedMarks?.开发大厅?.状态?.x < seedMarks?.开发大厅?.名x
    && seedMarks?.开发大厅?.dot?.x > seedMarks?.开发大厅?.名x,
  JSON.stringify({ 状态位x: seedMarks?.开发大厅?.状态?.x, 名称x: seedMarks?.开发大厅?.名x, 未读点x: seedMarks?.开发大厅?.dot?.x }));
check('未读是行尾小蓝点：6px、信息色（不再是 --danger 红，也没回到数字徽标）',
  seedMarks?.开发大厅?.dot?.w === 6 && seedMarks?.开发大厅?.dot?.h === 6
    && /rgb\(37, 99, 235\)/.test(seedMarks?.开发大厅?.dot?.bg ?? '')
    && /\d+ 条未读/.test(seedMarks?.开发大厅?.dot?.title ?? ''),
  JSON.stringify(seedMarks?.开发大厅?.dot));
check('有未读才有点：没有未读、也没有未结束任务的房间（方案讨论）两种提示都不显示',
  seedMarks?.方案讨论?.dot === null && seedMarks?.方案讨论?.状态 === null && seedMarks?.方案讨论?.svg数 === 0,
  JSON.stringify(seedMarks?.方案讨论));
check('多任务优先级：开发大厅有执行中 2 + 待验收 1 → 显示静态「待验收」，不旋转',
  seedMarks?.开发大厅?.状态?.cls === 'side-state alert'
    && /待验收 1 个 · 执行中 2 个/.test(seedMarks?.开发大厅?.状态?.title ?? '')
    && seedMarks?.开发大厅?.状态?.animation === 'none',
  JSON.stringify(seedMarks?.开发大厅?.状态));
/* 待验收的图形：2026-09-25 第三轮末按用户要求换掉"渗人"的眼睛 → 核对板（含勾） */
check('待验收用核对板图标（不再用眼睛）', seedMarks?.开发大厅?.状态?.icon === 'clipboard-check',
  `图标=${seedMarks?.开发大厅?.状态?.icon}`);
/* 用例更新（2026-09-25 第三轮末）：用户要求把"名字前面的符号"一并去掉 ——
   归档房不再画归档箱图标、私信行不再画气泡。**规则没有消失，而是换了载体**：
   只读/私信身份改由"整行降透明度 + 名称上的 tooltip"与"名称文字本身"表达。
   所以这里断言的是"图标位只剩任务状态"＋"归档仍可辨认"，而不是把断言删掉。 */
check('子项图标位只放任务状态：归档房与私信行都不再有身份图标',
  seedMarks?.文档整理?.归档 === true && seedMarks?.文档整理?.归档图标 === null && seedMarks?.文档整理?.状态 === null
    && seedMarks?.私信?.svg数 === 0 && seedMarks?.私信?.状态 === null,
  JSON.stringify({ 归档图标: seedMarks?.文档整理?.归档图标, 私信svg: seedMarks?.私信?.svg数 }));
check('归档房仍可辨认（整行降透明度 + 名称 tooltip 写明只读）',
  seedMarks?.文档整理?.归档透明度 !== null && Number(seedMarks?.文档整理?.归档透明度) < 1
    && /已归档只读/.test(String(seedMarks?.文档整理?.名title)),
  JSON.stringify({ 透明度: seedMarks?.文档整理?.归档透明度, 名称title: seedMarks?.文档整理?.名title }));
check('状态位尺寸恒定（房间 13px 见方），因此有状态与无状态行的名称横坐标一致',
  seedMarks?.开发大厅?.状态?.w === 13 && seedMarks?.开发大厅?.状态?.h === 13
    && seedMarks?.开发大厅?.名x === seedMarks?.方案讨论?.名x,
  JSON.stringify({ 状态位: seedMarks?.开发大厅?.状态?.w, 有状态名x: seedMarks?.开发大厅?.名x, 无状态名x: seedMarks?.方案讨论?.名x }));
check('私信行不参与任务状态（无状态位），有未读时行尾一枚蓝点',
  seedMarks?.私信?.svg数 === 0 && seedMarks?.私信?.状态 === null && seedMarks?.私信?.dot?.w === 6,
  JSON.stringify(seedMarks?.私信));

/* ---- "实际执行中才转"：data-backfill 的「开发大厅」（只有 ACTIVE + 未读）----
   该项目的房间默认不在侧栏，用顶栏项目菜单勾选显示（真实交互，不改任何演示数据）。 */
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(700);
const checkedBf = await c.ev(`
  (() => {
    const row = [...document.querySelectorAll('.menu-project-row')].find((r) => r.innerText.includes('data-backfill'));
    if (!row) return false;
    if (!row.querySelector('.menu-check')?.classList.contains('on')) row.querySelector('.menu-check')?.click();
    return true;
  })()
`);
await sleep(500);
await c.ev(`(() => { document.body.click(); return true; })()`);
await sleep(500);
// 该项目可能是折叠的：展开它才看得到房间行
await c.ev(`
  (() => {
    const pr = [...document.querySelectorAll('.sidebar .side-project')].find((p) => p.innerText.includes('data-backfill'));
    const caret = pr?.querySelector('.side-caret');
    if (caret && caret.getAttribute('title') === '展开房间列表') caret.click();
    return true;
  })()
`);
await sleep(700);
// 动画是否真的在转取决于宿主的"减少动效"偏好（本机系统开着 reduce），两种偏好都显式模拟
await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await sleep(400);
const spinProbe = `
  (() => {
    const pr = [...document.querySelectorAll('.sidebar .side-project')].find((p) => p.innerText.includes('data-backfill'));
    const row = [...(pr?.querySelectorAll('.side-item.sub') ?? [])].find((e) => e.innerText.includes('开发大厅'));
    if (!row) return { found: false };
    const st = row.querySelector('.side-state');
    const dot = row.querySelector('.side-unread-dot');
    const cs = st ? getComputedStyle(st) : null;
    return {
      found: Boolean(st),
      cls: st?.className,
      title: st?.getAttribute('title'),
      animation: cs?.animationName,
      dur: cs?.animationDuration,
      color: cs?.color,
      transform: cs?.transform,
      未读点: Boolean(dot),
      未读title: dot?.getAttribute('title'),
    };
  })()
`;
const spin1 = await c.ev(spinProbe);
await sleep(160);
const spin2 = await c.ev(spinProbe);
check('实际执行中的房间：名称前是放射状标志（动画 running、强调色）',
  checkedBf === true && spin1?.found === true && spin1?.animation === 'side-spin' && spin1?.dur === '0.9s',
  JSON.stringify(spin1));
check('标志真的在转：两次采样之间的 transform 矩阵不同（静态截图不算证据）',
  Boolean(spin1?.transform) && spin1?.transform !== spin2?.transform,
  `t1=${String(spin1?.transform).slice(0, 40)} t2=${String(spin2?.transform).slice(0, 40)}`);
check('「运行中且有未读」：旋转标志在名称前、未读蓝点在行尾，两者互不借用',
  spin1?.未读点 === true && /\d+ 条未读/.test(spin1?.未读title ?? '')
    && /执行中 \d+ 个/.test(spin1?.title ?? ''),
  JSON.stringify({ 状态title: spin1?.title, 未读title: spin1?.未读title }));

await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await sleep(400);
const reduced = await c.ev(spinProbe);
check('prefers-reduced-motion：旋转停但状态仍在（放射状标志与强调色都保留，不藏状态）',
  reduced?.found === true && reduced?.animation === 'none'
    && reduced?.color === spin1?.color && reduced?.cls === 'side-state running',
  JSON.stringify({ animation: reduced?.animation, color: reduced?.color, cls: reduced?.cls }));
await c.send('Emulation.setEmulatedMedia', { features: [] });
await sleep(200);

/* ---- 项目层级：展开看房间、折叠看汇总 ---- */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
const projProbe = `
  (() => {
    const pr = document.querySelector('.sidebar .side-project');
    const row = pr?.querySelector('.side-row');
    const label = pr?.querySelector('.side-item-label');
    const st = row?.querySelector('.side-state');
    const dot = row?.querySelector('.side-marks .side-unread-dot');
    const caret = pr?.querySelector('.side-caret');
    return {
      折叠: caret?.getAttribute('title') === '展开房间列表',
      名x: label ? Math.round(label.getBoundingClientRect().x) : null,
      状态: st ? { cls: st.className, title: st.getAttribute('title'), w: Math.round(st.getBoundingClientRect().width) } : null,
      dot: dot ? { title: dot.getAttribute('title') } : null,
      子行数: pr?.querySelectorAll('.side-item.sub').length ?? null,
    };
  })()
`;
const projOpen = await c.ev(projProbe);
check('项目展开时不在项目行重复子房间的聚合（状态与未读都留给房间行）',
  projOpen?.折叠 === false && projOpen?.状态 === null && projOpen?.dot === null,
  JSON.stringify(projOpen));
await c.ev(`(() => { document.querySelector('.sidebar .side-project .side-caret')?.click(); return true; })()`);
await sleep(700);
const projClosed = await c.ev(projProbe);
check('项目折叠后显示聚合：名称前是聚合状态、行尾是聚合未读（tooltip 写明各类数量）',
  projClosed?.折叠 === true && projClosed?.子行数 === 0
    && /待验收 1 个 · 执行中 2 个/.test(projClosed?.状态?.title ?? '')
    && /条未读/.test(projClosed?.dot?.title ?? ''),
  JSON.stringify({ 状态: projClosed?.状态, 未读: projClosed?.dot }));
/* 规则更新（第十七批 §三）：私信搬到一级入口后，项目树的折叠汇总**只算房间未读** ——
   否则会出现"项目显示有未读、展开后找不到来源"。私信未读由一级「私信」入口的小蓝点承担。 */
check('折叠后的聚合未读只算房间（私信未读已由一级「私信」入口承担，不重复提示）',
  /^\d+ 条未读$/.test(String(projClosed?.dot?.title ?? '')),
  JSON.stringify(projClosed?.dot));
check('折叠/展开不改变项目名横坐标（状态位占位 14px 与默认项目图标同宽）',
  projClosed?.名x === projOpen?.名x && projClosed?.状态?.w === 14,
  JSON.stringify({ 展开名x: projOpen?.名x, 折叠名x: projClosed?.名x, 状态位宽: projClosed?.状态?.w }));
// 折叠按钮与状态位是两个点击区：状态位不能压在展开箭头上
const caretGeom = await c.ev(`
  (() => {
    const pr = document.querySelector('.sidebar .side-project');
    const caret = pr?.querySelector('.side-caret')?.getBoundingClientRect();
    const st = pr?.querySelector('.side-state')?.getBoundingClientRect();
    return { caret: caret ? { l: Math.round(caret.left), r: Math.round(caret.right) } : null,
             state: st ? { l: Math.round(st.left), r: Math.round(st.right) } : null };
  })()
`);
check('状态位不覆盖展开/折叠按钮的点击区（两块矩形不重叠）',
  caretGeom?.caret !== null && caretGeom?.state !== null && caretGeom.state.l >= caretGeom.caret.r,
  JSON.stringify(caretGeom));
await c.ev(`(() => { document.querySelector('.sidebar .side-project .side-caret')?.click(); return true; })()`);
await sleep(500);

/* ---- 数字徽标：同一套规格 + 零值隐藏 ---- */
const badgeProbe = `
  (() => {
    const items = [...document.querySelectorAll('.sidebar .side-item')];
    const find = (label) => items.find((r) => r.querySelector('.side-item-label')?.innerText.trim() === label);
    const info = (row) => {
      const b = row?.querySelector('.side-badge');
      const style = b ? getComputedStyle(b) : null;
      const rect = b ? b.getBoundingClientRect() : null;
      return {
        有: Boolean(b),
        文本: b?.innerText.trim(),
        title: b?.getAttribute('title'),
        cls: b?.className,
        w: rect ? Math.round(rect.width) : null,
        h: rect ? Math.round(rect.height) : null,
        x: rect ? Math.round(rect.x) : null,
        right: rect ? Math.round(rect.right) : null,
        fs: style?.fontSize,
        radius: style?.borderRadius,
        pad: style?.padding,
        minW: style?.minWidth,
        徽标内svg: b ? b.querySelectorAll('svg').length : null,
        行内svg: row ? row.querySelectorAll('svg').length : null,
      };
    };
    return {
      文件与Git: info(find('文件与 Git')),
      待我处理: info(find('待我处理')),
      任务看板: info(find('任务看板')),
      设置: info(find('设置')),
    };
  })()
`;
const badges = await c.ev(badgeProbe);
check('「文件与 Git」「待我处理」用同规格数字徽标（高度/圆角/字号/内边距/最小宽度一致）',
  badges?.文件与Git?.有 === true && badges?.待我处理?.有 === true
    && badges.文件与Git.h === badges.待我处理.h
    && badges.文件与Git.radius === badges.待我处理.radius
    && badges.文件与Git.fs === badges.待我处理.fs
    && badges.文件与Git.pad === badges.待我处理.pad
    && badges.文件与Git.minW === badges.待我处理.minW,
  JSON.stringify({ 文件与Git: badges?.文件与Git, 待我处理: badges?.待我处理 }));
check('两个徽标右缘对齐（同一行尾提示区），且里面只有数字、没有重复图标或感叹号',
  badges?.文件与Git?.right === badges?.待我处理?.right
    && badges?.文件与Git?.徽标内svg === 0 && badges?.待我处理?.徽标内svg === 0
    && /^\d+$/.test(badges?.文件与Git?.文本 ?? '') && /^\d+$/.test(badges?.待我处理?.文本 ?? ''),
  JSON.stringify({ 右缘: [badges?.文件与Git?.right, badges?.待我处理?.right], 文本: [badges?.文件与Git?.文本, badges?.待我处理?.文本] }));
check('入口左侧原有图标保留（徽标只替换了行尾那部分）',
  badges?.文件与Git?.行内svg === 1 && badges?.待我处理?.行内svg === 1,
  JSON.stringify({ 文件与Git: badges?.文件与Git?.行内svg, 待我处理: badges?.待我处理?.行内svg }));
check('没有计数的入口不挂徽标（任务看板 / 设置）',
  badges?.任务看板?.有 === false && badges?.设置?.有 === false,
  JSON.stringify({ 任务看板: badges?.任务看板?.有, 设置: badges?.设置?.有 }));

/* 零值隐藏：换到非 Git 项目 notes-vault（没有 git 记录 → 工作区改动数为 0） */
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(700);
const switched = await c.ev(`
  (() => {
    const row = [...document.querySelectorAll('.menu-project-row')].find((r) => r.innerText.includes('notes-vault'));
    row?.querySelector('.menu-project-name')?.click();
    return Boolean(row);
  })()
`);
await sleep(1500);
const zeroBadge = await c.ev(badgeProbe);
check('计数为零时隐藏徽标（非 Git 项目 notes-vault：文件与 Git 无徽标），且「待我处理」仍有数字',
  switched === true && zeroBadge?.文件与Git?.有 === false && zeroBadge?.待我处理?.有 === true,
  JSON.stringify({ 文件与Git: zeroBadge?.文件与Git?.有, 待我处理: zeroBadge?.待我处理 }));
check('长名称不会撑坏导航（名称省略号截断，徽标仍完整可见）',
  (await c.ev(`
    (() => {
      const row = [...document.querySelectorAll('.sidebar .side-item')].find((r) => r.querySelector('.side-badge'));
      const label = row?.querySelector('.side-item-label');
      const side = document.querySelector('.sidebar')?.getBoundingClientRect();
      const badge = row?.querySelector('.side-badge')?.getBoundingClientRect();
      if (!label || !side || !badge) return { ok: false };
      return {
        ok: label.scrollWidth >= label.clientWidth && badge.right <= side.right + 1 && side.width > 0,
        名称宽度: Math.round(label.clientWidth),
        徽标右缘: Math.round(badge.right),
        侧栏右缘: Math.round(side.right),
      };
    })()
  `))?.ok === true,
  '名称列可截断 + 徽标不越出侧栏');

await go('/project/proj_zs_01/room/room_dev_hall');
/* ---- 项目区不画竖线 / 行级提示只在名称上（2026-09-25 用户第三轮反馈）----
   用户原话：「我不需要名字前面的 |」「不需要名字前面的符号，你可以参图2的递进关系」
   「小蓝点后面是有什么我看不到标志吗，怎么鼠标放上去会有个'协调者 codex'出来？」。
   两条规则都要锁住，否则又会回来：
     · 子项（房间/私信）既不画缩进导轨（::after），选中时也不再挂左侧强调竖条（::before）；
     · 整行的说明文字挂在**名称**上，不再挂整行按钮 —— 否则名称右边那段空白（比如小蓝点后面）
       也会弹出 tooltip，看起来像那里藏着看不见的标记。 */
const noBars = await c.ev(`
  (() => {
    const room = [...document.querySelectorAll('.sidebar .side-item.sub')].find((e) => e.querySelector('.side-item-label')?.innerText.trim() === '方案讨论');
    const activeRoom = [...document.querySelectorAll('.sidebar .side-item.sub')].find((e) => e.querySelector('.side-item-label')?.innerText.trim() === '开发大厅');
    const proj = document.querySelector('.sidebar .side-project .side-item-label-btn');
    return {
      子项导轨: getComputedStyle(room, '::after').content,
      子项导轨底色: getComputedStyle(room, '::after').backgroundColor,
      选中子项竖条: getComputedStyle(activeRoom, '::before').content,
      位于房间页: Boolean(activeRoom?.classList.contains('active')),
      房间行title: room?.getAttribute('title') ?? null,
      房间名title: room?.querySelector('.side-item-label')?.getAttribute('title') ?? null,
      项目行title: proj?.getAttribute('title') ?? null,
      项目名title: document.querySelector('.sidebar .side-project .side-item-label')?.getAttribute('title') ?? null,
    };
  })()
`);
check('项目区不画缩进导轨（子项 ::after 无内容），也不挂选中竖条',
  noBars?.子项导轨 === 'none' && /rgba\(0, 0, 0, 0\)/.test(String(noBars?.子项导轨底色)),
  JSON.stringify({ content: noBars?.子项导轨, bg: noBars?.子项导轨底色 }));
check('选中的房间不再挂左侧强调竖条（::before 无内容）',
  noBars?.位于房间页 === true && noBars?.选中子项竖条 === 'none',
  JSON.stringify({ 位于房间页: noBars?.位于房间页, 竖条: noBars?.选中子项竖条 }));
check('行级说明只挂在名称上：房间行整行没有 title，项目行的 title 只说明"展开/收起"（不再挂路径）',
  noBars?.房间行title === null && /展开|收起/.test(String(noBars?.项目行title))
    && /协调者/.test(String(noBars?.房间名title)) && String(noBars?.项目名title).length > 0,
  JSON.stringify({ 房间行: noBars?.房间行title, 房间名: noBars?.房间名title, 项目行: noBars?.项目行title, 项目名: noBars?.项目名title }));

/* 顶部功能入口保持原规则：一层平铺的导航仍用 3px 强调竖条标位置（与嵌套列表刻意不同） */
await go('/project/proj_zs_01/files?tab=git');
const topBar = await c.ev(`
  (() => {
    const el = [...document.querySelectorAll('.sidebar-top .side-item')].find((e) => e.querySelector('.side-item-label')?.innerText.trim() === '文件与 Git');
    if (!el || !el.classList.contains('active')) return { found: false };
    const cs = getComputedStyle(el, '::before');
    return { found: true, content: cs.content, bg: cs.backgroundColor, w: cs.width };
  })()
`);
/* 判据用 `content`：伪元素没被生成时（content:none）background/width 仍会按规则返回，
   只有 `content` 能区分"真的画了"与"根本没生成" —— 实测过，别只看颜色。 */
check('顶部/底部功能入口仍保留 3px 强调竖条（只有项目区的嵌套列表去掉了）',
  topBar?.found === true && topBar?.content === '""' && topBar?.bg === 'rgb(37, 99, 235)' && topBar?.w === '3px',
  JSON.stringify(topBar));

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
check('子项名与项目名同列、全部子项共列，且状态位落在项目图标那一列',
  (await c.ev(`
    (() => {
      const iconLeft = (root) => {
        const icon = root?.querySelector('svg');
        return icon ? icon.getBoundingClientRect().left : null;
      };
      const labelLeft = (el) => (el ? el.getBoundingClientRect().left : null);
      const func = iconLeft(document.querySelector('.sidebar-top .side-item'));
      const proj = iconLeft(document.querySelector('.sidebar .side-project .side-item-label-btn'));
      const projLabel = labelLeft(document.querySelector('.sidebar .side-project .side-item-label'));
      /* 用例迁移（2026-09-25）：房间行不再画 \`#\` 图标，所以"递进"改用**文字列**衡量
         （房间名必须落在项目名右侧）。功能入口与项目行仍按图标列对齐 —— 这条没变。
         2026-09-25 第三轮：项目区的竖线全去掉后，层级**只靠缩进**表达，
         所以这一步的"递进量"本身成了设计量（≥12px），一并断言。 */
      const rooms = [...document.querySelectorAll('.sidebar .side-item.sub .side-item-label')];
      const roomX = rooms.map((e) => Math.round(e.getBoundingClientRect().left));
      const room = roomX[0] ?? null;
      if (func === null || proj === null || room === null || projLabel === null) {
        return { ok: false, func, proj, room, projLabel };
      }
      // labelLeft 返回的是数值（不是元素），这里只取整用于断言缩进量
      const projLabelX = Math.round(projLabel);
      /* 用例更新（2026-09-25 第三轮末，用户："子项名称和项目名是同一层缩进的"）：
         子项名与项目名**同列**（原来要求"更靠右"）；同一层级内全部子项必须落在同一列；
         功能入口仍与项目行按图标列对齐（这条没变）。 */
      const slotX = [...document.querySelectorAll('.sidebar .side-item.sub .side-state, .sidebar .side-item.sub .side-icon-slot')]
        .map((e) => Math.round(e.getBoundingClientRect().left));
      return {
        ok: room === projLabelX && proj === func && new Set(roomX).size === 1
          && new Set(slotX).size === 1 && Math.abs((slotX[0] ?? 0) - proj) <= 2,
        func, proj, room, projLabelX, roomX, slotX, 列差: room - projLabelX,
      };
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

await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
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
    当前项目: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
    侧栏项目: [...document.querySelectorAll('.sidebar .side-project .side-item-label')].map(e => e.innerText.trim()),
  }))()
`);
check('勾选项目只增加侧栏显示，不改变当前项目',
  afterCheck?.当前项目 === '众说' && afterCheck?.侧栏项目?.includes('data-backfill') === true,
  JSON.stringify(afterCheck));
// 用例更新（第二十六批）：项目选择器从应用内顶栏移到**侧栏最顶部**，
// 计数文案随之简化为"显示 N 个"（侧栏宽度 246px，写全"个项目"会挤掉项目名）。
check('顶栏项目管理按钮显示当前项目名（不再有侧栏「显示 N 个」这种提示）',
  afterCheck?.当前项目 === '众说', String(afterCheck?.当前项目));

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
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
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
  (await c.ev(`document.querySelector('.titlebar-proj-name')?.innerText.trim()`)) === 'data-backfill',
  `房间=${JSON.stringify(roomClick?.label)}`);

/* ============================================================
   5. 偏好持久化与容错（RT-26 第 9 条）
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
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
    侧栏项目: [...document.querySelectorAll('.sidebar .side-project .side-item-label')].map(e => e.innerText.trim()),
    当前项目: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
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
check('偏好损坏时安全回退（侧栏一级入口仍在：搜索与收藏 / 文件与 Git / 任务看板 / 成员管理 / 私信）',
  (await c.ev(`document.querySelectorAll('.sidebar-top .side-item').length`)) === 5);

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
check('项目入口在顶栏（原"移到侧栏最顶部"的用例已作废）', shell?.选择器存在 === true && shell?.选择器在侧栏第一个 === 'sidebar-project',
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
    标题栏显示当前项目: document.querySelector('.titlebar-proj-name')?.innerText.trim() ?? null,
  }))()
`);
await c.ev(`document.querySelector('.titlebar-icon').click(); true`);
await sleep(800);
const reopened = await c.ev(`({ 侧栏回来: !!document.querySelector('.sidebar'), 有选择器: !!document.querySelector('.side-project-picker') })`);
check('折叠侧栏后仍能恢复（不会成为打不开的死状态；项目入口在顶栏，折叠后依旧可用）',
  collapsed?.侧栏消失 === true && collapsed?.折叠按钮还在 === true
    && reopened?.侧栏回来 === true && collapsed?.标题栏显示当前项目 === '众说',
  JSON.stringify({ collapsed, reopened }));
check('顶栏始终显示当前项目名（侧栏折叠也不丢"我在哪个项目"）',
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

/**
 * 主题与账号/退出/重置原型数据都在应用设置里 —— 但**位置按七类重排（第二十八批 §3.1）变了**：
 *  · 主题 → 「外观」分区（原来在通用的「外观与账号」卡片里，值走独立值列）；
 *  · 退出 → 「通用」的「本机账号与会话」；
 *  · 重置原型数据 → 「帮助与关于」底部的「原型工具」折叠组（默认折叠，展开后可见）。
 * 断言口径不变：这三件事必须都能在应用设置里找到，且标题栏不再有主题键。
 */
await go('/settings?section=appearance');
const account = await c.ev(`
  (() => {
    const t = document.querySelector('.settings-body')?.innerText ?? '';
    return { 有深色外观: t.includes('深色外观'), 有当前值: t.includes('当前：') };
  })()
`);
await go('/settings?section=general');
const generalHasQuit = await c.ev(`(document.querySelector('.settings-body')?.innerText ?? '').includes('退出')`);
await go('/settings?section=help');
const protoTools = await c.ev(`
  (async () => {
    const head = [...document.querySelectorAll('.settings-collapse-head')].find(h => h.innerText.includes('原型工具'));
    head?.click();
    await new Promise(r => setTimeout(r, 400));
    const body = head?.parentElement?.querySelector('.settings-collapse-body');
    return { 有重置原型数据: (body?.innerText ?? '').includes('重置原型数据'), 标题栏无主题键: !document.querySelector('.titlebar .icon-btn') };
  })()
`);
check('主题切换与账号/退出/重置原型数据仍在应用设置里（七类重排后的新落点）',
  account?.有深色外观 === true && account?.有当前值 === true
    && generalHasQuit === true && protoTools?.有重置原型数据 === true,
  JSON.stringify({ account, generalHasQuit, protoTools }));

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
