/**
 * 验证：第十五批导航决定（§17.1 / §17.7）—— 对应 RT-26 的 12 项验收点。
 *
 * RT-26 原文（设计报告 §21.2）：
 *  ①侧栏四入口顺序正确，项目独立滚动，底部两入口可达
 *  ②勾选只控制显示，当前不可隐藏，点击项目/房间才切焦点
 *  ③文件/Git 两标签复用项目/差异数据，非 Git 不初始化
 *  ④看板默认可见项目分组，同号任务/同名房间不串线，单项目筛选同步焦点
 *  ⑤成员页项目切换一致
 *  ⑥隐藏项目待办仍计数，合法深链自动补选并按实体归属打开
 *  ⑦旧 files/git/members/dm/runtime 链接正确兼容，后退不循环
 *  ⑧草稿/异步结果/执行目标不随焦点串项目
 *  ⑨偏好刷新恢复、失效 ID 与无项目空态正确
 *  ⑩Runtime 只收入口不删能力，设置范围明确
 *  ⑪任务验收可选与 Git 授权边界继续满足 RT-24/25
 *  ⑫人类多项目聚合不改变 Agent 隔离或派发名单
 *
 * 边界说明：原型是 mock，不接真实文件系统/Git/runtime。本脚本断言的是
 * 界面结构与路由行为，**不代表** runtime 或 Git 实机验证。
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
 * 第十七批作废的用例：指向**已被移除的功能**（侧栏顶部项目选择器、"显示 N 个"、
 * 项目树里的私信行、点项目名切换当前项目、折叠时标题栏另一套当前项目展示）。
 * 用户 2026-09-25 明确"如果是旧的功能被去掉了，那就不用管"，因此这里显式 SKIP
 * （保留原文可查，不计入通过率，也不静默删除）。
 */
const OBSOLETE = [
  /侧栏顶部/,
  /显示 N 个/,
  /项目树.*私信行/,
  /私信行.*项目树/,
  /点击项目名称才切换当前项目/,
  /点项目名.*切换/,
  /折叠时标题栏/,
  /归档房.*保留.*图标/,
];
const skipped = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const go = async (h) => { await c.ev(`location.hash=${JSON.stringify(h)}; true`); await sleep(1500); };
const hash = () => c.ev(`location.hash`);

await reset();

/* ============================================================
   RT-26 ① 侧栏四入口顺序 / 项目独立滚动 / 底部两入口可达
   ============================================================ */
await go('/project/proj_zs_01/room/room_dev_hall');
const rt1 = await c.ev(`
  (() => {
    const top = [...document.querySelectorAll('.sidebar-top .side-item-label')].map(e => e.innerText.trim());
    const foot = [...document.querySelectorAll('.sidebar-foot .side-item-label')].map(e => e.innerText.trim());
    const scroll = document.querySelector('.sidebar-scroll');
    const items = [...document.querySelectorAll('.sidebar .side-item-label')].map(e => e.innerText.trim());
    const footBoxes = [...document.querySelectorAll('.sidebar-foot .side-item')].map(e => e.getBoundingClientRect());
    return {
      top, foot,
      中区可滚: getComputedStyle(scroll).overflowY,
      无独立Git: !items.includes('Git'),
      无独立Runtime: !items.includes('Runtime'),
      底部都在视口内: footBoxes.every(b => b.bottom <= window.innerHeight + 1 && b.height > 0),
    };
  })()
`);
check('RT-26① 一级入口顺序正确（第十七批新增一级「私信」，位于成员管理下面）',
  JSON.stringify(rt1?.top) === JSON.stringify(['搜索与收藏', '文件与 Git', '任务看板', '成员管理', '私信']), (rt1?.top ?? []).join('→'));
// 用例更新（第二十六批第二轮）：用户担心「项目全停」在侧栏底部易误触，
// 已移入「项目设置 → 高级操作」。底部固定区回到两项。
check('RT-26① 底部入口固定且可达（待我处理 / 设置）',
  JSON.stringify(rt1?.foot) === JSON.stringify(['待我处理', '设置']) && rt1?.底部都在视口内 === true,
  (rt1?.foot ?? []).join('→'));
check('RT-26① 项目区独立滚动、无独立 Git/Runtime 重复入口',
  rt1?.中区可滚 === 'auto' && rt1?.无独立Git === true && rt1?.无独立Runtime === true);

/* ============================================================
   RT-26 ② 勾选只控制显示；当前不可隐藏；点项目/房间才切焦点
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(700);
await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.menu-project-row')];
    rows.find(r => r.innerText.includes('data-backfill'))?.querySelector('.menu-check')?.click();
    return true;
  })()
`);
await sleep(800);
const rt2a = await c.ev(`
  (() => ({
    当前项目: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
    侧栏: [...document.querySelectorAll('.sidebar-scroll .side-item-label')].map(e => e.innerText.trim()),
    锁定: [...document.querySelectorAll('.menu-project-row')]
      .find(r => r.innerText.includes('众说'))?.querySelector('.menu-check')?.classList.contains('locked'),
  }))()
`);
check('RT-26② 勾选只控制显示（当前项目不变）', rt2a?.当前项目 === '众说' && rt2a?.侧栏?.includes('data-backfill') === true);
check('RT-26② 当前项目勾选框锁定（不可隐藏）', rt2a?.锁定 === true);

// 点项目名 → 切焦点
await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.menu-project-name')].find(e => e.innerText.includes('data-backfill'));
    b?.click();
    return !!b;
  })()
`);
await sleep(1500);
check('RT-26② 点项目名切换焦点', (await c.ev(`document.querySelector('.titlebar-proj-name')?.innerText.trim()`)) === 'data-backfill');

// 点房间 → 聚焦所属项目（先切回众说）
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(700);
await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.menu-project-name')].find(e => e.innerText.includes('众说'));
    b?.click();
    return !!b;
  })()
`);
await sleep(1500);
const roomClick = await c.ev(`
  (() => {
    const room = [...document.querySelectorAll('.sidebar .side-item.sub')]
      .find(e => e.closest('.side-project')?.innerText.includes('data-backfill'));
    if (!room) return 'no-room';
    room.click();
    return 'clicked';
  })()
`);
await sleep(1500);
check('RT-26② 点房间聚焦其所属项目',
  roomClick === 'clicked' && (await c.ev(`document.querySelector('.titlebar-proj-name')?.innerText.trim()`)) === 'data-backfill',
  `点击=${roomClick}`);

/* ============================================================
   RT-26 ③ 文件/Git 两标签复用项目与差异数据；非 Git 不初始化
   ============================================================ */
await reset();
await go('/project/proj_zs_01/files?tab=files');
const filesTab = await c.ev(`
  (() => {
    const txt = document.querySelector('.page')?.innerText ?? '';
    return {
      标签: [...document.querySelectorAll('.thread-tab')].map(e => e.innerText.trim().split('\\n')[0]),
      有文件树: !!document.querySelector('.file-tree'),
      树节点: document.querySelectorAll('.file-row').length,
      有改动集: txt.includes('任务改动集') || txt.includes('改动集'),
      共用项目路径: !!document.querySelector('.page-sub.mono'),
    };
  })()
`);
check('RT-26③ 文件标签有目录树 + 改动集（共用同一项目页）',
  filesTab?.有文件树 === true && filesTab?.树节点 > 0 && filesTab?.有改动集 === true,
  JSON.stringify(filesTab));

await go('/project/proj_zs_01/files?tab=git');
const gitTab = await c.ev(`
  (() => {
    const txt = document.querySelector('.page')?.innerText ?? '';
    return {
      有工作区: txt.includes('工作区'),
      有历史: txt.includes('历史'),
      有分支与远端: txt.includes('分支与远端'),
      有diff: !!document.querySelector('.diff-view') || document.querySelectorAll('.diff-line').length > 0,
    };
  })()
`);
check('RT-26③ Git 标签保留工作区/历史/分支与远端与 diff',
  gitTab?.有工作区 && gitTab?.有历史 && gitTab?.有分支与远端, JSON.stringify(gitTab));

/* 标签记忆按项目；显式 tab 优先于记忆 */
await c.ev(`
  (() => {
    const t = [...document.querySelectorAll('.thread-tab')].find(e => e.innerText.includes('文件'));
    t?.click();
    return true;
  })()
`);
await sleep(900);
await go('/project/proj_backfill_02/files');
const remembered = await c.ev(`
  (() => {
    const on = [...document.querySelectorAll('.thread-tab')].find(e => e.classList.contains('on'));
    return { 当前标签: on?.innerText.trim().split('\\n')[0], 记忆: JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1') ?? '{}').fileGitTabs };
  })()
`);
check('RT-26③ 标签记忆按项目各存一份',
  typeof remembered?.记忆 === 'object' && remembered.记忆?.proj_zs_01 === 'files',
  JSON.stringify(remembered));

// 显式 tab=git 必须优先于"上次看的是 files"
await go('/project/proj_zs_01/files?tab=git');
check('RT-26③ 显式 tab 深链优先于标签记忆',
  (await c.ev(`[...document.querySelectorAll('.thread-tab')].find(e => e.classList.contains('on'))?.innerText.trim().split('\\n')[0]`)) === 'Git');

/* 非 Git 项目：不自动 init */
await go('/project/proj_docs_03/files?tab=git');
const nonGit = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      说明未初始化: t.includes('尚未初始化 Git') || t.includes('不是一个 Git 仓库'),
      不自动init: t.includes('不自动 git init'),
      有返回文件: t.includes('返回文件'),
    };
  })()
`);
check('RT-26③ 非 Git 项目不自动初始化，并给出返回文件',
  nonGit?.说明未初始化 && nonGit?.不自动init && nonGit?.有返回文件, JSON.stringify(nonGit));

/* §9.4 的关键分支：**非 Git 但目录正常**的项目，文件树与预览必须可用。
   这一条一度无法验证 —— 当时唯一的非 Git 项目目录也是失效的，
   于是"非 Git 文件树可用"实测恒为空。种子里补了 notes-vault（P_NOTGIT）。 */
await go('/project/proj_notgit_04/files?tab=files');
const nonGitTree = await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.file-row')];
    return {
      有树: !!document.querySelector('.file-tree'),
      顶层节点: rows.map(function (r) { return r.innerText.trim().split(String.fromCharCode(10))[0]; }),
    };
  })()
`);
check('RT-26③ §9.4 非 Git 且目录正常的项目也有文件树（不再恒为空）',
  nonGitTree?.有树 === true && (nonGitTree?.顶层节点 ?? []).length >= 3,
  JSON.stringify(nonGitTree));

// 展开目录 → 选中文件 → 应有预览（目录默认可点开、文件可读）
await c.ev(`
  (() => {
    const dir = [...document.querySelectorAll('.file-row')]
      .find(r => r.innerText.trim().split(String.fromCharCode(10))[0] === 'docs');
    if (dir) dir.click();
    return !!dir;
  })()
`);
await sleep(800);
await c.ev(`
  (() => {
    const f = [...document.querySelectorAll('.file-row')].find(r => r.innerText.indexOf('index.md') >= 0);
    if (f) f.click();
    return !!f;
  })()
`);
await sleep(900);
/**
 * §17.9 迁移（UX-PREVIEW-01）：文件正文改由**共享预览区**承载。
 *
 * 旧断言查 `.file-preview`（文件页自己的 `<pre>` 预览壳）。
 * 施工说明 §11.5-B2 要求"用同一 PreviewPane，不保留重复独立预览壳"，
 * 所以那个选择器已不存在 —— 但**要保护的业务性质不变**：
 * 点文件必须真的能看到内容，而不是假装打开了。
 * 因此改为在共享预览里验证正文渲染（源码视图的行文本）。
 */
const nonGitPreview = await c.ev(`
  (() => {
    const pane = document.querySelector('.preview-pane');
    const src = pane?.querySelector('.preview-source-text, .md-view');
    return {
      有预览: !!pane,
      有正文: !!src,
      首行: src ? (src.innerText || '').split(String.fromCharCode(10))[0] : null,
      标题: pane?.querySelector('.preview-tab-label')?.textContent?.trim() ?? null,
    };
  })()
`);
check('RT-26③ §9.4 非 Git 项目能展开目录并预览文件内容（共享预览，§17.9）',
  nonGitPreview?.有预览 === true && nonGitPreview?.有正文 === true
  && String(nonGitPreview?.首行).length > 0,
  JSON.stringify(nonGitPreview));

// 二进制文件必须如实说明，不能假装能读
await c.ev(`
  (() => {
    const dir = [...document.querySelectorAll('.file-row')]
      .find(r => r.innerText.trim().split(String.fromCharCode(10))[0] === 'attachments');
    if (dir) dir.click();
    return !!dir;
  })()
`);
await sleep(800);
await c.ev(`
  (() => {
    const f = [...document.querySelectorAll('.file-row')].find(r => r.innerText.indexOf('whiteboard.png') >= 0);
    if (f) f.click();
    return !!f;
  })()
`);
await sleep(800);
const binary = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return { 说明二进制: t.includes('二进制文件'), 不假装能读: t.includes('不提供文本预览') };
  })()
`);
check('RT-26③ §9.4 二进制文件如实说明（不假装能读）',
  binary?.说明二进制 === true && binary?.不假装能读 === true, JSON.stringify(binary));

/* ============================================================
   筛选控件一致性（用户反馈："下拉组件样式你都没统一，而已应该放左边"）
   ============================================================
   回归的缺陷：`.field.inline` 这个类被四个页面使用，却**从未定义样式**，
   于是退化成块级 .field（label 独占一行）并被子项 flex 拉伸，
   实测同一行出现 33px / 70px / 33px 三种高度；控件还挂在页头右侧
   （离侧栏最远，点完侧栏要横跨整屏才能操作）。

   现在统一为 .page-filters 筛选行：控件在内容区左上角、全部同高、都带标签。

   例外：**设置页不再用筛选行** —— 它按"设置"的标准形态改成了左侧分区导航树
   （用户反馈"设置页面好奇怪"后的重构），项目选择器移到导航树的「当前项目」分组里。
   设置页另有专项断言（导航树渲染 / 分区切换 / 旧 URL 兼容），见下方 §设置页。 */
const filterBarCases = [
  ['任务看板(全部项目)', '/tasks?scope=all'],
  ['任务看板(单项目)', '/tasks?scope=project&projectId=proj_notgit_04'],
  ['任务看板(可见项目)', '/tasks?scope=visible'],
  ['搜索与收藏', '/library?tab=search&scope=project&projectId=proj_notgit_04'],
  ['成员管理', '/project/proj_notgit_04/members'],
  ['文件与 Git', '/project/proj_notgit_04/files?tab=files'],
];
for (const [name, hash] of filterBarCases) {
  await go(hash);
  const r = await c.ev(`
    (() => {
      const bar = document.querySelector('.page-filters');
      if (!bar) return { 有筛选行: false };
      const ctrls = [...bar.querySelectorAll('select, .seg, .btn')];
      const heights = [...new Set(ctrls.map(c => Math.round(c.getBoundingClientRect().height)))];
      const page = document.querySelector('.page').getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const firstLeft = ctrls.length ? Math.round(ctrls[0].getBoundingClientRect().left) : null;
      return {
        有筛选行: true,
        控件数: ctrls.length,
        高度集合: heights,
        高度统一: heights.length === 1,
        左对齐内容区: Math.round(barRect.left - page.left - 24) === 0,
        起点在左半区: firstLeft !== null && firstLeft < page.left + page.width / 2,
      };
    })()
  `);
  check(`筛选行「${name}」控件同高且靠左`,
    r?.有筛选行 === true && r?.高度统一 === true && r?.左对齐内容区 === true && r?.起点在左半区 === true,
    JSON.stringify(r));
}

// 页头右侧不应再残留筛选型下拉（避免"一边左一边右"两套位置）
await go('/tasks?scope=all');
check('页头右侧不再放筛选下拉（统一到左侧筛选行）',
  (await c.ev(`document.querySelectorAll('.page-head-actions select').length`)) === 0);

/* ============================================================
   §17.7「单项目页统一走同一个项目切换动作」
   ============================================================
   任何在 URL 里指定了项目的页面，都必须把焦点同步过去，
   否则会出现"地址栏写着 A、页面在操作 B"。逐条覆盖全部四种写法：
   路径里的 /project/:id、?scope=project&projectId、?section=project&projectId、
   以及旧 /dm/:memberId（按成员实体解析）。
   其中 ?section=project 这条曾漏掉，实测设置页仍显示"项目设置 · 众说"。 */
await reset();
const focusCases = [
  ['/project/:id/files', '/project/proj_backfill_02/files?tab=files'],
  ['/project/:id/members', '/project/proj_backfill_02/members'],
  ['/project/:id/dm', '/project/proj_backfill_02/dm'],
  ['/project/:id/room', '/project/proj_backfill_02/room/room_bf_dev_hall'],
  ['?scope=project（看板）', '/tasks?scope=project&projectId=proj_backfill_02'],
  ['?scope=project（搜索）', '/library?tab=search&scope=project&projectId=proj_backfill_02'],
  ['?section=project（旧写法，项目设置）', '/settings?section=project&projectId=proj_backfill_02'],
  ['?section=collab（新写法，任务与协作）', '/settings?section=collab&projectId=proj_backfill_02'],
  ['?section=write（新写法，文件写入安全）', '/settings?section=write&projectId=proj_backfill_02'],
];
for (const [name, hash] of focusCases) {
  // 先回到中性路由并重置，确保每次都是从"当前项目=众说"出发
  await go('/welcome?recovery=0');
  await reset();
  await go(hash);
  const st = await c.ev(`
    (() => ({
      顶栏: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
      /* 用例迁移（2026-09-25）：「当前」二字已按用户要求从侧栏去掉，
         上下文标记改用 .side-row.context-active（标记本身仍在）。 */
      侧栏当前: [...document.querySelectorAll('.side-row')]
        .filter(r => r.classList.contains('context-active'))
        .map(r => r.querySelector('.side-item-label')?.innerText.trim()),
    }))()
  `);
  check(`§17.7 ${name} 打开时焦点同步到该项目`,
    st?.顶栏 === 'data-backfill' && (st?.侧栏当前 ?? []).includes('data-backfill'),
    JSON.stringify(st));
}

// 项目设置的作用对象也必须与 URL 一致（不能"地址栏是 A、页面写 B"）。
// 用例更新（第十六批 §17.8）：项目设置已是独立单页，标题与路径都来自 URL
// 里的 projectId，且**没有**项目下拉（切项目走顶栏/侧栏）。
await go('/settings?section=collab&projectId=proj_backfill_02');
const settingsScope = await c.ev(`
  (() => ({
    标题: document.querySelector('.page-title')?.innerText.trim() ?? '',
    路径: document.querySelector('.page-sub')?.innerText.trim() ?? '',
    有项目下拉: !!document.querySelector('.pset select'),
    hash: location.hash,
  }))()
`);
check('§17.8 项目设置标明的是 URL 里的那个项目（标题+路径，且无项目下拉）',
  String(settingsScope?.标题).includes('data-backfill')
    && !String(settingsScope?.标题).includes('众说')
    && String(settingsScope?.路径).includes('data-backfill')
    && settingsScope?.有项目下拉 === false,
  JSON.stringify(settingsScope));

// 旧 /dm/:memberId 按成员实体解析（member_bf_codex 属于 data-backfill）
await go('/welcome?recovery=0');
await reset();
await go('/dm/member_bf_codex');
const dmFocus = await c.ev(`document.querySelector('.titlebar-proj-name')?.innerText.trim()`);
check('§17.7 旧 /dm/:memberId 按成员所属项目同步焦点（不靠当前项目猜）',
  dmFocus === 'data-backfill', `顶栏=${dmFocus}`);

/* §9.6 私信不串项目：两个项目里都有同名成员（Codex / Claude），
   所以必须验证"私信列表按项目隔离"而不是按名字找。
   众说有 4 条会话，data-backfill 一条都没有 —— 若实现按当前项目猜，
   进 data-backfill 的私信页会列出众说的会话。 */
await reset();
await go('/project/proj_zs_01/dm');
const dmA = await c.ev(`
  (() => ({
    会话数: document.querySelectorAll('.dm-row').length,
    标题: [...document.querySelectorAll('.dm-row-title')].map(e => e.innerText.trim()),
  }))()
`);
check('§9.6 众说私信页列出自己的会话',
  dmA?.会话数 === 4, JSON.stringify({ 数: dmA?.会话数 }));

await go('/project/proj_backfill_02/dm');
const dmB = await c.ev(`
  (() => {
    const t = document.body.innerText;
    return {
      会话数: document.querySelectorAll('.dm-row').length,
      空态或只有本项目: t.includes('这个项目还没有私聊') || !(t.includes('评审口径') || t.includes('周报分工')),
      列出众说会话: t.includes('评审口径') || t.includes('周报分工'),
    };
  })()
`);
check('§9.6 data-backfill 私信页只列出本项目的会话（不串到众说；第十七批：该项目自己有一条私信）',
  dmB?.会话数 >= 1 && dmB?.列出众说会话 === false && dmB?.空态或只有本项目 === true,
  JSON.stringify(dmB));

/* §17.7「不能拿全局 activeProjectId 拼来源链接」：
   从聚合看板点另一个项目的任务卡，落点必须用**任务自己的** projectId。 */
await reset();
await go('/tasks?scope=all');
await c.ev(`
  (() => {
    const t = [...document.querySelectorAll('.page .card')].find(c => c.innerText.indexOf('订单表增量回填') >= 0);
    if (t) t.click();
    return !!t;
  })()
`);
await sleep(1900);
const boardNav = await c.ev(`
  (() => ({ hash: location.hash, 顶栏: document.querySelector('.titlebar-proj-name')?.innerText.trim() }))()
`);
check('§17.7 聚合看板点卡用任务自己的项目拼链接（不用 activeProjectId）',
  /proj_backfill_02/.test(String(boardNav?.hash)) && boardNav?.顶栏 === 'data-backfill',
  JSON.stringify(boardNav));

/* ============================================================
   RT-26 ④ 看板按项目分组；同号任务/同名房间不串线；单项目筛选同步焦点
   ============================================================ */
await reset();
await go('/tasks?scope=all');
const board = await c.ev(`
  (() => {
    const sections = [...document.querySelectorAll('.page > .section')];
    const groups = sections.map(s => ({
      项目: s.querySelector('.section-title')?.innerText.replace(/\\n/g, ' ').trim(),
      卡片: [...s.querySelectorAll('.card')].map(c => c.innerText.replace(/\\n/g, ' | ').trim()),
    }));
    return {
      分组数: groups.length,
      项目名: groups.map(g => g.项目),
      全部卡片带项目来源: groups.every(g => g.卡片.every(c => c.includes('|'))),
      含dataBackfill: groups.some(g => g.项目.includes('data-backfill') && g.卡片.length > 0),
    };
  })()
`);
check('RT-26④ 看板外层按项目分组（每个项目一段）',
  board?.分组数 >= 2 && board?.项目名?.some((n) => n.includes('众说')) && board?.项目名?.some((n) => n.includes('data-backfill')),
  (board?.项目名 ?? []).join(' / '));

// 同号任务 + 同名房间：两个项目里都有 #12 和「开发大厅」，必须都能区分
const sameName = await c.ev(`
  (() => {
    const cards = [...document.querySelectorAll('.page .card')].map(c => c.innerText.replace(/\\n/g, ' | ').trim());
    const twelve = cards.filter(c => c.startsWith('#12'));
    return {
      同号卡片数: twelve.length,
      各自带项目名: twelve.every(c => c.includes('众说') || c.includes('data-backfill')),
      两张卡内容不同: new Set(twelve).size === twelve.length,
      样例: twelve,
    };
  })()
`);
check('RT-26④ 两个项目的同号 #12 任务分开显示且各带项目来源',
  sameName?.同号卡片数 >= 2 && sameName?.各自带项目名 === true && sameName?.两张卡内容不同 === true,
  JSON.stringify(sameName?.样例));

check('RT-26④ 同名房间「开发大厅」在两处均出现（靠项目名区分）',
  await c.ev(`
    (() => {
      const cards = [...document.querySelectorAll('.page .card')].map(c => c.innerText);
      return cards.filter(c => c.includes('开发大厅')).length >= 2;
    })()
  `) === true);

// 看板默认 scope=visible
await go('/tasks');
check('RT-26④ 裸 /tasks 默认 scope=visible',
  (await c.ev(`document.querySelector('.page-filters select')?.value`)) === 'visible',
  await c.ev(`location.hash`));

// 单项目筛选同步焦点
await reset();
await go('/tasks?scope=project&projectId=proj_backfill_02');
check('RT-26④ 单项目筛选同步当前项目焦点',
  (await c.ev(`document.querySelector('.titlebar-proj-name')?.innerText.trim()`)) === 'data-backfill');

// 换范围后失效 roomId 被清空
await go('/tasks?scope=project&projectId=proj_zs_01&roomId=room_bf_dev_hall');
await sleep(1200);
const stale = await c.ev(`
  (() => {
    const sel = document.querySelector('.page-filters select:nth-of-type(3)')
      ?? [...document.querySelectorAll('.page-filters select')].pop();
    return { 房间筛选值: sel?.value, 仍有该房间选项: [...sel.options].some(o => o.value === 'room_bf_dev_hall') };
  })()
`);
check('RT-26④ 范围变化后失效的 roomId 被清空（不继续展示旧房间数据）',
  stale?.房间筛选值 === 'all' && stale?.仍有该房间选项 === false, JSON.stringify(stale));

/* ============================================================
   RT-26 ⑤ 成员页项目切换一致
   ============================================================ */
await reset();
await go('/project/proj_zs_01/members');
const memA = await c.ev(`
  (() => ({
    成员卡片数: document.querySelectorAll('.card').length,
    文本: document.querySelector('.page')?.innerText.slice(0, 200) ?? '',
    项目选择值: document.querySelector('.page-filters select')?.value,
  }))()
`);
check('RT-26⑤ 成员页按项目显示成员',
  memA?.项目选择值 === 'proj_zs_01' && memA?.成员卡片数 >= 3, JSON.stringify({ 值: memA?.项目选择值, 卡: memA?.成员卡片数 }));

await c.ev(`
  (() => {
    const sel = document.querySelector('.page-filters select');
    sel.value = 'proj_backfill_02';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()
`);
await sleep(1600);
const memB = await c.ev(`
  (() => ({
    顶栏当前: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
    hash: location.hash,
    成员卡数: document.querySelectorAll('.card').length,
  }))()
`);
check('RT-26⑤ 成员页切项目同步顶栏与路由',
  memB?.顶栏当前 === 'data-backfill' && /proj_backfill_02\/members/.test(String(memB?.hash)),
  JSON.stringify(memB));

/* 空成员项目：docs 无成员 → 明确空态 */
await go('/project/proj_docs_03/members');
check('RT-26⑤ 无成员项目显示空态（不显示混合成员名单）',
  await c.ev(`document.querySelector('.page')?.innerText.includes('还没有成员')`) === true);

/* ============================================================
   RT-26 ⑥ 隐藏项目待办仍计数；深链自动补选
   ============================================================ */
await reset();
const baseline = await c.ev(`document.querySelector('.sidebar-foot .side-item .side-badge')?.innerText.trim() ?? '0'`);
// 隐藏一个非当前项目（先勾选 data-backfill，再隐藏）
await go('/project/proj_zs_01/room/room_dev_hall');
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
await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.menu-project-row')];
    rows.find(r => r.innerText.includes('data-backfill'))?.querySelector('.menu-check')?.click();
    return true;
  })()
`);
await sleep(800);
// 用 Esc 关菜单：点 body 会命中侧栏遮罩下的元素，可能触发别的动作
await c.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(600);
const afterHide = await c.ev(`
  (() => ({
    待办角标: document.querySelector('.sidebar-foot .side-item .side-badge')?.innerText.trim() ?? '0',
    侧栏: [...document.querySelectorAll('.sidebar-scroll .side-item-label')].map(e => e.innerText.trim()),
  }))()
`);
check('RT-26⑥ 隐藏项目不改变待办计数（隐藏只收起导航）',
  afterHide?.待办角标 === baseline && afterHide?.侧栏?.includes('data-backfill') === false,
  `隐藏前=${baseline} 隐藏后=${afterHide?.待办角标}`);

/* §9.7：隐藏项目的待办必须仍列在「待我处理」里，带来源项目标记，
   点它能自动补选该项目。种子里的 att_bf_approval 就属于默认隐藏的 data-backfill。 */
await go('/activity');
const activityScope = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    const cards = [...document.querySelectorAll('.card.tight')];
    return {
      页头标范围: t.includes('范围：全部可访问项目'),
      说明隐藏也计入: t.includes('侧栏隐藏的项目也计入'),
      卡片总数: cards.length,
      带来源项目: cards.filter(c => /众说|data-backfill|legacy-docs|notes-vault/.test(c.innerText)).length,
      隐藏项目卡片: cards.filter(c => c.innerText.includes('侧栏已隐藏')).length,
    };
  })()
`);
check('RT-26⑥ §9.7 待我处理页头标明范围（全部可访问项目，隐藏也计入）',
  activityScope?.页头标范围 === true && activityScope?.说明隐藏也计入 === true,
  JSON.stringify(activityScope));
check('RT-26⑥ §9.7 每张待办卡都标出来源项目',
  activityScope?.卡片总数 > 0 && activityScope?.带来源项目 === activityScope?.卡片总数,
  `${activityScope?.带来源项目}/${activityScope?.卡片总数}`);
check('RT-26⑥ §9.7 隐藏项目的待办仍在列，并标「侧栏已隐藏」',
  (activityScope?.隐藏项目卡片 ?? 0) >= 1, `隐藏项目卡片=${activityScope?.隐藏项目卡片}`);

// 点隐藏项目的待办卡 → 自动补选并聚焦
const revealFromCard = await c.ev(`
  (() => {
    const card = [...document.querySelectorAll('.card.tight')].find(c => c.innerText.includes('侧栏已隐藏'));
    if (!card) return { clicked: false };
    card.click();
    return { clicked: true, proj: card.querySelector('.tag')?.innerText.trim() };
  })()
`);
check('RT-26⑥ §9.7 能点到隐藏项目的待办卡', revealFromCard?.clicked === true, JSON.stringify(revealFromCard));
await sleep(1800);
const afterCardClick = await c.ev(`
  (() => ({
    当前项目: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
    侧栏: [...document.querySelectorAll('.sidebar-scroll .side-item-label')].map(e => e.innerText.trim()),
    有提示: document.body.innerText.includes('已在侧栏显示项目'),
  }))()
`);
check('RT-26⑥ §9.7 点隐藏项目的待办卡会自动补选并聚焦该项目',
  afterCardClick?.当前项目 === 'data-backfill'
    && afterCardClick?.侧栏?.includes('data-backfill') === true
    && afterCardClick?.有提示 === true,
  JSON.stringify(afterCardClick));

await reset();

/* 进入隐藏项目的深链 → 自动补选并提示。
   必须从**干净状态**开始：上一段已经把 data-backfill 补选过了，
   此时再进它的深链只是切焦点、不会再"补选"，提示相应地不该出现。
   注意先回到一个中性路由再 reset —— 否则当前 URL 若指向某个项目，
   焦点同步会在 reload 后把它重新持久化进可见集合，前置条件就不成立了。 */
await go('/welcome?recovery=0');
await reset();
const beforeDeepLink = await c.ev(`
  [...document.querySelectorAll('.sidebar-scroll .side-item-label')].map(e => e.innerText.trim())
`);
check('RT-26⑥ 深链测试的前置条件：目标项目当前是隐藏的',
  !(beforeDeepLink ?? []).includes('data-backfill'), JSON.stringify(beforeDeepLink));

await go('/project/proj_backfill_02/files');
await sleep(1400);
const revealed = await c.ev(`
  (() => ({
    侧栏: [...document.querySelectorAll('.sidebar-scroll .side-item-label')].map(e => e.innerText.trim()),
    当前项目: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
    有提示: document.body.innerText.includes('已在侧栏显示项目'),
  }))()
`);
check('RT-26⑥ 合法深链自动补选并聚焦该项目',
  revealed?.侧栏?.includes('data-backfill') === true && revealed?.当前项目 === 'data-backfill',
  JSON.stringify(revealed));
check('RT-26⑥ 补选时给出轻提示', revealed?.有提示 === true,
  `侧栏=${JSON.stringify(revealed?.侧栏)}`);

/* 不存在的项目 → 明确错误，不回退到当前项目 */
await go('/project/proj_nope/files');
check('RT-26⑥ 不存在的项目显示错误（不回落成当前项目的同名对象）',
  await c.ev(`document.querySelector('.page')?.innerText.includes('项目不存在')`) === true,
  await c.ev(`document.querySelector('.page')?.innerText.slice(0, 80)`));

/* ============================================================
   RT-26 ⑦ 旧链接兼容；后退不循环
   ============================================================ */
const legacy = [
  ['/project/:id/changes', '/project/proj_zs_01/changes', /\/project\/proj_zs_01\/files\?tab=files/],
  ['/project/:id/git', '/project/proj_zs_01/git', /\/project\/proj_zs_01\/files\?tab=git/],
  ['/saved', '/saved', /\/library\?tab=saved/],
  ['/runtimes', '/runtimes', /\/settings\?section=runtime/],
  ['/members', '/members', /\/project\/proj_zs_01\/members/],
];
for (const [name, from, expect] of legacy) {
  await go(from);
  await sleep(900);
  const got = await hash();
  check(`RT-26⑦ 旧链接 ${name} 正确重定向`, expect.test(String(got)), String(got));
}
// 旧 /dm/:memberId 必须按成员实体解析项目，不能靠当前项目猜
await reset();
await go('/dm/member_bf_codex');
await sleep(1600);
const dmResolve = await c.ev(`
  (() => ({ hash: location.hash, 当前项目: document.querySelector('.titlebar-proj-name')?.innerText.trim() }))()
`);
check('RT-26⑦ 旧 /dm/:memberId 按成员所属项目解析（不串到当前项目）',
  dmResolve?.当前项目 === 'data-backfill' || /proj_backfill_02/.test(String(dmResolve?.hash)),
  JSON.stringify(dmResolve));

/* §9.3 旧链接若带定位参数（changeSetId / taskId），必须**原样保留**，
   不能"只打开页头、丢掉对象"（§17.7 明确要求）。 */
await go('/project/proj_zs_01/git?changeSetId=changeset_13&taskId=task_13');
const keptGit = await hash();
check('§9.3 旧 /git 链接保留 changeSetId 与 taskId',
  /tab=git/.test(String(keptGit)) && /changeSetId=changeset_13/.test(String(keptGit)) && /taskId=task_13/.test(String(keptGit)),
  String(keptGit));
await go('/project/proj_zs_01/changes?changeSetId=changeset_13');
const keptChanges = await hash();
check('§9.3 旧 /changes 链接保留 changeSetId',
  /tab=files/.test(String(keptChanges)) && /changeSetId=changeset_13/.test(String(keptChanges)),
  String(keptChanges));

/* §9.8 后退/前进必须遵循 URL（高亮也要跟着回到对应页面） */
await go('/project/proj_zs_01/room/room_dev_hall');
await go('/project/proj_zs_01/files?tab=git');
await go('/tasks?scope=visible');
await c.ev(`history.back(); true`);
await sleep(1500);
const back1 = await c.ev(`
  (() => ({
    hash: location.hash,
    高亮: [...document.querySelectorAll('.sidebar .side-item.active .side-item-label')].map(e => e.innerText.trim()),
  }))()
`);
check('§9.8 后退一次回到上一个 URL 且高亮跟随',
  /files\?tab=git/.test(String(back1?.hash)) && (back1?.高亮 ?? []).includes('文件与 Git'),
  JSON.stringify(back1));
await c.ev(`history.forward(); true`);
await sleep(1500);
const fwd = await c.ev(`
  (() => ({
    hash: location.hash,
    高亮: [...document.querySelectorAll('.sidebar .side-item.active .side-item-label')].map(e => e.innerText.trim()),
  }))()
`);
check('§9.8 前进回到 /tasks 且高亮跟随',
  /\/tasks/.test(String(fwd?.hash)) && (fwd?.高亮 ?? []).includes('任务看板'),
  JSON.stringify(fwd));

/* §9.6 成员页只展示目标项目的成员（同名成员不混）。
   实测基准：众说 3 人、data-backfill 2 人、notes-vault 1 人、legacy-docs 0 人（空态）。
   注意成员卡在 .grid.grid-2 里，不能用全页 .card 计数（那会混入别的卡片）。 */
for (const [name, pid, expect] of [
  ['众说', 'proj_zs_01', 3],
  ['data-backfill', 'proj_backfill_02', 2],
  ['notes-vault', 'proj_notgit_04', 1],
]) {
  await go(`/project/${pid}/members`);
  const r = await c.ev(`
    (() => {
      const grid = document.querySelector('.grid.grid-2');
      return {
        成员数: grid ? grid.children.length : 0,
        项目选择: document.querySelector('.page-filters select')?.value,
      };
    })()
  `);
  check(`§9.6 成员页只列出「${name}」自己的成员（${expect} 人）`,
    r?.成员数 === expect && r?.项目选择 === pid, JSON.stringify(r));
}
await go('/project/proj_docs_03/members');
check('§9.6 无成员项目给空态（不显示其他项目的混合名单）',
  (await c.ev(`
    (() => {
      const grid = document.querySelector('.grid.grid-2');
      return (grid ? grid.children.length : 0) === 0
        && (document.querySelector('.page')?.innerText ?? '').includes('还没有成员');
    })()
  `)) === true);

/* §9.11 浏览行为（目录树 / diff / 看板 / 交付面板）**不得生成**新的待办或验收 */
await go('/welcome?recovery=0');
await reset();
await go('/welcome?recovery=0');
const beforeBrowse = await c.ev(`document.querySelector('.sidebar-foot .side-item .side-badge')?.innerText.trim() ?? '0'`);
await go('/project/proj_zs_01/files?tab=files');
await c.ev(`(() => { const r = [...document.querySelectorAll('.file-row')]; if (r[1]) r[1].click(); return true; })()`);
await sleep(700);
await go('/project/proj_zs_01/files?tab=git');
await go('/tasks?scope=all');
await go('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13&tab=delivery');
await sleep(1200);
const afterBrowse = await c.ev(`document.querySelector('.sidebar-foot .side-item .side-badge')?.innerText.trim() ?? '0'`);
check('§9.11 浏览目录树/diff/看板/交付面板不会新增待办或验收',
  afterBrowse === beforeBrowse, `浏览前=${beforeBrowse} 浏览后=${afterBrowse}`);

// 兼容跳转必须用 replace：从 A 页进入旧链接后按"后退"，应回到 A 页，
// 而不是又落回旧链接（那会再被重定向一次，表现为地址栏来回弹）。
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
await sleep(900);
const backBefore = await hash();
await go('/project/proj_zs_01/git');
await sleep(1200);
const afterRedirect = await hash();
await c.ev(`history.back(); true`);
await sleep(1500);
const afterBack = await hash();
check('RT-26⑦ 兼容跳转使用 replace（后退回到进入前的页面，不陷入重定向循环）',
  /\/files\?tab=git/.test(String(afterRedirect)) && String(afterBack) === String(backBefore),
  `进入前=${backBefore} 重定向后=${afterRedirect} 后退后=${afterBack}`);

/* ============================================================
   RT-26 ⑧ 草稿不随焦点串项目
   ============================================================ */
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
await c.ev(`
  (() => {
    const ta = document.querySelector('.composer-input');
    if (!ta) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '众说项目的草稿内容');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(700);
await go('/project/proj_backfill_02/room/room_bf_dev_hall');
await sleep(1400);
const otherDraft = await c.ev(`document.querySelector('.composer-input')?.value ?? null`);
check('RT-26⑧ 切项目后输入条不显示上一个项目的草稿',
  otherDraft !== '众说项目的草稿内容', `另一个项目的草稿="${otherDraft}"`);
// 回到原项目，草稿仍在
await go('/project/proj_zs_01/room/room_dev_hall');
await sleep(1400);
check('RT-26⑧ 回到原项目草稿仍保留（按项目/目标存储）',
  (await c.ev(`document.querySelector('.composer-input')?.value ?? ''`)) === '众说项目的草稿内容',
  `回到原项目="${await c.ev(`document.querySelector('.composer-input')?.value ?? ''`)}"`);

/* RT-26⑧ 的同类要求：**写入租约也按项目隔离**。
   锁域是"同一物理原目录"（§10.3），所以别的项目的锁不能显示过来。
   回归的缺陷：writeLock 曾是全局单例，看 notes-vault 的文件页/房间页
   会显示众说任务 #13 的锁 —— 跨项目串状态（实测于 notes-vault 文件页截图）。 */
await reset();
await go('/project/proj_zs_01/files?tab=files');
const lockOwn = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return { 显示租约: t.includes('当前写入锁'), 提到13: t.includes('#13') };
  })()
`);
check('RT-26⑧ 有租约的项目在自己页面上显示写入锁',
  lockOwn?.显示租约 === true && lockOwn?.提到13 === true, JSON.stringify(lockOwn));

for (const [name, pid] of [['data-backfill', 'proj_backfill_02'], ['notes-vault（非 Git）', 'proj_notgit_04']]) {
  await go(`/project/${pid}/files?tab=files`);
  const t = await c.ev(`
    (() => {
      const txt = document.querySelector('.page')?.innerText ?? '';
      return { 显示租约: txt.includes('当前写入锁'), 提到13: txt.includes('#13') };
    })()
  `);
  check(`RT-26⑧ 无租约的项目「${name}」不显示别的项目的写入锁`,
    t?.显示租约 === false && t?.提到13 === false, JSON.stringify(t));
}

// 房间页同理
await go('/project/proj_notgit_04/room/room_ng_notes');
check('RT-26⑧ 非 Git 项目的房间页也不显示别的项目的写入提示',
  (await c.ev(`!!document.querySelector('.lock-hint')`)) === false);
await go('/project/proj_zs_01/room/room_dev_hall');
/* 用例更新（用户要求）：**房间主池顶部不再显示写入锁横幅**。
   锁本身仍然生效（互斥、排队、按项目隔离都不变），只是不再常驻一条横幅
   —— 它会被误读成"整个项目出问题了"。租约状态改在「项目设置」查看，
   上一段已断言文件页仍显示「当前写入锁」。
   这里同时守住"本项目房间页不显示"这条新契约。 */
check('RT-26⑧ 房间主池顶部不再显示写入提示（用户要求移除；锁仍生效）',
  (await c.ev(`!!document.querySelector('.lock-hint')`)) === false);
/* 移除的是**房间页横幅**，不是锁的能力：项目设置里仍要能看到本项目的租约。 */
await go('/project/proj_zs_01/settings');
check('RT-26⑧ 移除横幅后，本项目租约仍在「项目设置」可见',
  (await c.ev(`(document.querySelector('.page')?.innerText ?? '').includes('正在修改文件')`)) === true);

/* "项目全停"只针对当前项目。
   用例更新（第二十六批第二轮）：按钮现位于「项目设置 → 高级操作」，
   所以要先进入该项目的设置页再点。 */
await go('/project/proj_zs_01/settings');
const stopScope = await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.settings-advanced .btn')].find(x => x.innerText.includes('项目全停'));
    if (!b) return 'no-btn';
    b.click();
    return 'opened';
  })()
`);
await sleep(800);
const stopText = await c.ev(`document.querySelector('.modal')?.innerText ?? ''`);
check('RT-26⑧ 项目全停只针对当前项目（不扩成全部可见项目）',
  stopScope === 'opened' && stopText.includes('停止本项目全部任务'),
  `${stopScope}`);
await c.ev(`
  (() => {
    const m = document.querySelector('.modal');
    const b = [...m.querySelectorAll('.btn')].find(x => x.textContent.trim() === '取消');
    b?.click();
    return true;
  })()
`);
await sleep(500);

/* ============================================================
   RT-26⑧ 续：项目全停**不得污染其他项目的成员状态**
   ============================================================
   回归的缺陷（第二十六批实测发现）：stopAll 里写的是
     members: st.members.map((m) => ({ ...m, workState: 'stopped', ... }))
   —— 完全没按 projectId 过滤。于是停在众说会把 data-backfill 的成员也标成
   "项目全停"，而那个项目的任务其实还在跑。这与更早修过的 writeLock 全局单例
   是同一类问题：**项目级动作污染其他项目**。
   同时 turns 也没按项目过滤（turn→thread→room→project 才能判归属）。
   这里逐条锁住：停 A 之后，B 的成员状态与 turn 状态都不能变。 */
await reset();
const readMemberLines = `
  (() => [...document.querySelectorAll('.grid-2 .card')].map(c => {
    const lines = c.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean);
    return lines[lines.length - 1];
  }))()
`;

// 记录 data-backfill 的成员状态（停之前）
await go('/project/proj_backfill_02/members');
const bfBefore = await c.ev(readMemberLines);

// 停众说
await go('/project/proj_zs_01/settings');
await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.settings-advanced .btn')].find(x => x.innerText.includes('项目全停'));
    if (!b) return false;
    b.click();
    return true;
  })()
`);
await sleep(700);
await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.modal .btn')].find(x => x.innerText.includes('停止本项目全部任务'));
    if (!b) return false;
    b.click();
    return true;
  })()
`);
await sleep(1500);

// data-backfill 的成员状态必须**原样**
await go('/project/proj_backfill_02/members');
const bfAfter = await c.ev(readMemberLines);
check('项目全停不污染其他项目的成员状态（只改本项目成员）',
  JSON.stringify(bfBefore) === JSON.stringify(bfAfter),
  `前=${JSON.stringify(bfBefore)} 后=${JSON.stringify(bfAfter)}`);

// 众说自己的成员应当已停止
await go('/project/proj_zs_01/members');
const zsAfter = await c.ev(readMemberLines);
check('项目全停确实停掉了本项目成员',
  (zsAfter ?? []).every((x) => x.includes('项目全停')),
  JSON.stringify(zsAfter));

await reset();

/* ============================================================
   RT-26 ⑩ Runtime 只收入口不删能力；设置范围明确
   ============================================================
   用例更新（第十五批设置页重构）：原来是"seg 切换项目/应用 + 一排 btn 子分区"，
   现在改为**左导航树**（分组：当前项目 / 应用 / 帮助与诊断）。
   因此这里断言：默认落在应用级分区、且导航树同时呈现项目级与应用级两组。 */
await reset();
await go('/settings');
const settingsDefault = await c.ev(`
  (() => {
    const nav = document.querySelector('.settings-nav');
    const groups = nav ? [...nav.querySelectorAll('.settings-nav-label')].map(e => e.innerText.trim()) : [];
    const items = nav ? [...nav.querySelectorAll('.settings-nav-text')].map(e => e.innerText.trim()) : [];
    const on = nav ? [...nav.querySelectorAll('.settings-nav-item.on .settings-nav-text')].map(e => e.innerText.trim()) : [];
    return { 分组: groups, 分区: items, 当前分区: on };
  })()
`);
check('RT-26⑩ 设置默认进入应用级分区（通用），导航树呈现应用级四分区',
  (settingsDefault?.当前分区 ?? []).includes('通用')
    && JSON.stringify(settingsDefault?.分组) === JSON.stringify(['应用'])
    && JSON.stringify(settingsDefault?.分区) === JSON.stringify(['通用', '执行工具', '设备与局域网', '归档管理', '诊断与帮助']),
  JSON.stringify(settingsDefault));

await go('/settings?section=runtime');
const rtPanel = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      有Runtime: t.includes('Codex App Server'),
      有版本: t.includes('版本'),
      有验证等级: t.includes('验证等级') || t.includes('C0'),
      有重测: [...document.querySelectorAll('.btn')].some(b => b.innerText.includes('重新检测')),
      标注应用级: t.includes('应用级配置'),
    };
  })()
`);
check('RT-26⑩ Runtime 收入设置且能力保留（检测/版本/认证/诊断）',
  rtPanel?.有Runtime && rtPanel?.有版本 && rtPanel?.有验证等级 && rtPanel?.有重测,
  JSON.stringify(rtPanel));
check('RT-26⑩ Runtime 明确标注为应用级（切项目不换一套配置）', rtPanel?.标注应用级 === true);

/* 用例更新（第十六批 §17.8）：项目级设置已拆到独立单页
   `/project/:id/settings`，所以这里改为在**项目设置页**核对三节内容。
   旧的 `/settings?section=collab|write` 会规范化过去，断言仍落在同一页面。 */
await go('/project/proj_zs_01/settings');
const collabPanel = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    const delivery = document.getElementById('pset-delivery');
    return {
      标题含项目名: (document.querySelector('.page-title')?.innerText ?? '').includes('众说'),
      有验收开关: !!delivery?.querySelector('.switch'),
      有仅影响新任务: t.includes('仅影响新任务'),
      有缺席设置: t.includes('成员无响应后继续'),
      有单轮上限: t.includes('单次分析最长运行') && t.includes('单次修改最长运行'),
    };
  })()
`);
check('RT-26⑩ 项目设置含验收开关与协作限制（两个时限分开），并标明作用项目',
  collabPanel?.有验收开关 && collabPanel?.有仅影响新任务 && collabPanel?.有缺席设置
    && collabPanel?.有单轮上限 && collabPanel?.标题含项目名,
  JSON.stringify(collabPanel));

const writePanel = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      有单写者: t.includes('一个任务') && t.includes('推荐'),
      有并行: t.includes('多个任务') && t.includes('有风险'),
      有两个互斥单选: document.querySelectorAll('#pset-write .wpolicy input[type=radio]').length === 2,
      有当前写入情况: t.includes('正在修改文件') || t.includes('没有任务在修改文件'),
      含过强承诺: t.includes('撤销一定可靠'),
    };
  })()
`);
check('RT-26⑩ 项目设置含文件修改策略（互斥同屏）+ 简短当前状态，且不承诺可靠撤销',
  writePanel?.有单写者 && writePanel?.有并行 && writePanel?.有两个互斥单选
    && writePanel?.有当前写入情况 && writePanel?.含过强承诺 === false,
  JSON.stringify(writePanel));

/* ============================================================
   RT-26 ⑪ 任务验收可选与 Git 授权边界不回归
   ============================================================ */
// 验收开关存在、关闭不自动批准、Git 页不做 commit 级审批。
// 用例更新（第十六批）：验收开关在项目设置页（`/project/:id/settings`，
// 旧的 section=collab 会规范化过去）。
await go('/project/proj_zs_01/settings');
const rt11 = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      不自动批准说明: t.includes('关闭验收不等于自动批准') || t.includes('不会自动提交或推送'),
      只影响新任务: t.includes('仅影响新任务'),
    };
  })()
`);
check('RT-26⑪ 验收关闭不隐含自动批准/自动提交', rt11?.不自动批准说明 === true && rt11?.只影响新任务 === true,
  JSON.stringify(rt11));

await go('/project/proj_zs_01/files?tab=git');
// 说明面板在 Git 内部的「历史」视图里（历史属于 Git 内部导航，不是第三个顶层标签）
await c.ev(`
  (() => {
    const t = [...document.querySelectorAll('.thread-tab')].find(e => e.innerText.includes('历史'));
    t?.click();
    return !!t;
  })()
`);
await sleep(900);
const gitBoundary = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      说明两件事: t.includes('Git 提交与任务验收是两件事'),
      无commit级审批: !t.includes('验收这个提交'),
      无虚假已审阅: !/已审阅/.test(t),
    };
  })()
`);
check('RT-26⑪ Git 标签不做 commit 级审批，说明与验收独立',
  gitBoundary?.说明两件事 && gitBoundary?.无commit级审批 && gitBoundary?.无虚假已审阅,
  JSON.stringify(gitBoundary));

/* ============================================================
   RT-26 ⑨ 偏好刷新恢复 / 失效 ID / 无项目空态
   ============================================================ */
// 刷新恢复与失效 ID 已在 verify-sidebar 覆盖；这里补"无可见项目"的空态
await reset();
await c.ev(`
  (() => {
    const p = JSON.parse(localStorage.getItem('zhongshuo.nav.prefs.v1') ?? '{}')
      || { version: 1 };
    return true;
  })()
`);
await c.ev(`
  (() => {
    localStorage.setItem('zhongshuo.nav.prefs.v1', JSON.stringify({
      version: 1, activeProjectId: 'proj_zs_01', visibleProjectIds: [], expandedProjectIds: [], fileGitTabs: {},
    }));
    return true;
  })()
`);
await c.ev(`location.reload(); true`);
await sleep(2800);
c = await connect();
await c.ev(`window.zhongshuo?.window.show()`);
await sleep(400);
const emptyState = await c.ev(`
  (() => {
    const side = document.querySelector('.sidebar-scroll')?.innerText ?? '';
    return {
      侧栏项目: [...document.querySelectorAll('.sidebar-scroll .side-item-label')].map(e => e.innerText.trim()),
      有空态: side.includes('没有显示中的项目') || side.includes('打开文件夹'),
      一级入口仍在: document.querySelectorAll('.sidebar-top .side-item').length,
    };
  })()
`);
// 当前项目必须被补回可见集合（§17.7），所以不会真的空 —— 这本身就是断言点
check('RT-26⑨ 可见集合为空时自动补回当前项目（当前项目不可被隐藏）',
  emptyState?.侧栏项目?.includes('众说') === true && emptyState?.一级入口仍在 === 5,
  JSON.stringify(emptyState));

/* ============================================================
   RT-26 ⑫ 只报告实际执行的结果；mock 不得冒充真实认证
   ============================================================
   这条是"元要求"：界面必须自己声明数据是 mock，不能让评审把
   假数据当成真实文件系统/Git/runtime 证据。所以断言点是
   ①界面存在明确的原型标注；②文件树自述为 mock；
   ③非 Git 项目的前像写成 snapshot 而不是伪造 git ref。 */
const mockDisclosure = await c.ev(`
  (() => {
    const body = document.body.innerText;
    return {
      有原型标注: body.includes('原型') && (body.includes('内存数据') || body.includes('不实际')),
    };
  })()
`);
check('RT-26⑫ 界面明确标注为原型/内存数据（不冒充真实能力）',
  mockDisclosure?.有原型标注 === true, JSON.stringify(mockDisclosure));

await go('/project/proj_zs_01/files?tab=files');
const treeDisclosure = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return { 文件树标注mock: t.includes('mock') };
  })()
`);
check('RT-26⑫ 文件树自述为 mock 目录（不声称扫描真实磁盘）',
  treeDisclosure?.文件树标注mock === true, JSON.stringify(treeDisclosure));

await go('/project/proj_notgit_04/files?tab=files');
const snapshotDisclosure = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      前像用snapshot: t.includes('snapshot:'),
      明确说明非Git无ref: t.includes('非 Git 目录无 ref 可用') || t.includes('整目录快照'),
    };
  })()
`);
check('RT-26⑫ 非 Git 项目前像如实写成整目录快照（不伪造 git ref）',
  snapshotDisclosure?.前像用snapshot === true && snapshotDisclosure?.明确说明非Git无ref === true,
  JSON.stringify(snapshotDisclosure));

/* ============================================================
   设置分离（第十六批 §17.8 / RT-27）
   ============================================================
   用户要求"项目的设置合并一个页面后，就不要和整个软件的设置在一起了"。
   现在是：项目行 ⋯ → /project/:id/settings 单页；底部 /settings 只应用级。 */
await reset();

console.log('  -- 第十六批：项目行入口 --');
await go('/project/proj_zs_01/room/room_dev_hall');

// 勾选第二个项目，验证"每个项目行都有 ⋯"
await c.ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(700);
await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.menu-project-row')];
    const t = rows.find(r => r.innerText.includes('data-backfill'));
    if (t) t.querySelector('.menu-check').click();
    return true;
  })()
`);
await sleep(800);
await c.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(600);

const moreBtns = await c.ev(`
  (() => {
    // 第十七批：项目行末尾是 ⋯ 与 + 两个按钮（⋯ 有 aria-haspopup，+ 没有）
    const btns = [...document.querySelectorAll('.side-row-act')];
    const rows = document.querySelectorAll('.side-project').length;
    return {
      数量: btns.length,
      行数: rows,
      每行两个: rows > 0 && btns.length === rows * 2,
      可Tab: btns.every(b => b.tagName === 'BUTTON'),
      有aria: btns.filter(b => b.getAttribute('aria-haspopup') === 'menu').length === rows,
      默认淡出: btns.every(b => getComputedStyle(b).opacity === '0'),
    };
  })()
`);
check('每个可见项目行都有独立的「⋯」与「+」按钮（键盘可达、默认淡出不抢注意力）',
  moreBtns?.数量 >= 2 && moreBtns?.每行两个 === true && moreBtns?.可Tab === true && moreBtns?.有aria === true,
  JSON.stringify(moreBtns));

// 点 ⋯ 只开菜单，不切项目/房间/折叠
// 点 ⋯ 只开菜单，不切项目/房间/折叠。
// 注意：要**明确指定**是哪个项目的那一个按钮（.side-row-act 的 DOM 顺序
// 就是侧栏项目顺序，下标不可靠 —— 早先按下标取，结果点到了别的项目）。
const beforeMore = await c.ev(`({ hash: location.hash, 顶栏: document.querySelector('.titlebar-proj-name')?.innerText.trim(), 房间数: document.querySelectorAll('.side-item.sub').length })`);
const clickedWhich = await c.ev(`
  (() => {
    const proj = [...document.querySelectorAll('.side-project')]
      .find(sp => sp.innerText.includes('data-backfill'));
    const b = proj?.querySelector('.side-row-act');
    if (!b) return null;
    b.click();
    return proj.querySelector('.side-item-label')?.innerText.trim();
  })()
`);
await sleep(900);
const afterMore = await c.ev(`
  (() => ({
    hash: location.hash,
    顶栏: document.querySelector('.titlebar-proj-name')?.innerText.trim(),
    房间数: document.querySelectorAll('.side-item.sub').length,
    菜单项: [...document.querySelectorAll('.menu button, .menu .menu-item')].map(e => e.innerText.trim()).filter(Boolean),
  }))()
`);
check('点「⋯」只打开菜单，不切换项目、不跳房间、不折叠',
  clickedWhich === 'data-backfill'
    && beforeMore?.hash === afterMore?.hash && beforeMore?.顶栏 === afterMore?.顶栏
    && beforeMore?.房间数 === afterMore?.房间数
    && (afterMore?.菜单项 ?? []).some(x => x.includes('项目设置')),
  JSON.stringify({ 点了哪个: clickedWhich, before: beforeMore, after: afterMore }));

// 点菜单里的「项目设置」才进入该项目
await c.ev(`
  (() => {
    const b = [...document.querySelectorAll('.menu button, .menu .menu-item')].find(x => x.innerText.includes('项目设置'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(1600);
const afterEnter = await c.ev(`({ hash: location.hash, 顶栏: document.querySelector('.titlebar-proj-name')?.innerText.trim() })`);
check('菜单里的「项目设置」进入该项目设置单页并聚焦该项目',
  /\/project\/proj_backfill_02\/settings/.test(String(afterEnter?.hash)) && afterEnter?.顶栏 === 'data-backfill',
  JSON.stringify(afterEnter));

console.log('  -- 第十六批：项目设置单页 --');
await go('/project/proj_zs_01/settings');
const pset = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    const psetEl = document.querySelector('.pset');
    return {
      标题: document.querySelector('.page-title')?.innerText.trim(),
      路径: document.querySelector('.page-sub')?.innerText.trim(),
      分节: [...document.querySelectorAll('.pset-section-title')].map(e => e.innerText.trim()),
      有项目下拉: !!document.querySelector('.pset select'),
      有页内二级导航: !!document.querySelector('.settings-nav'),
      有全局侧栏: !!document.querySelector('.sidebar'),
      内容宽: psetEl ? Math.round(psetEl.getBoundingClientRect().width) : -1,
      底部设置高亮: [...document.querySelectorAll('.sidebar-foot .side-item.active')].some(e => e.innerText.includes('设置')),
      含过强承诺: t.includes('撤销一定可靠'),
      含检查文件变化: t.includes('仍然会检查文件变化') || t.includes('撤销前仍会检查文件变化'),
    };
  })()
`);
check('项目设置是独立单页：标题含项目名与路径，三节齐全，无项目下拉与页内二级导航',
  String(pset?.标题).includes('众说') && String(pset?.标题).includes('项目设置')
    && String(pset?.路径).includes('D:')
    && JSON.stringify(pset?.分节) === JSON.stringify(['任务交付', '协作限制', '文件修改'])
    && pset?.有项目下拉 === false && pset?.有页内二级导航 === false,
  JSON.stringify({ 标题: pset?.标题, 分节: pset?.分节 }));
check('项目设置内容宽度收敛（≤960px，不再横跨整屏）',
  (pset?.内容宽 ?? 9999) <= 960, `宽度=${pset?.内容宽}`);
check('项目设置页不把底部「设置」也标成当前页（两个入口不同时高亮）',
  pset?.底部设置高亮 === false);
check('单写者不承诺"撤销一定可靠"（改为检查文件变化）',
  pset?.含过强承诺 === false && pset?.含检查文件变化 === true,
  JSON.stringify({ 过强承诺: pset?.含过强承诺, 检查变化: pset?.含检查文件变化 }));

// 三节行内布局：左侧名称+说明、右侧控件
await go('/project/proj_zs_01/settings');
const rowLayout = await c.ev(`
  (() => {
    const rows = [...document.querySelectorAll('.pset-row')];
    if (rows.length < 3) return { 行数: rows.length };
    const first = rows[0];
    const lbl = first.querySelector('.pset-row-label')?.getBoundingClientRect();
    const ctl = first.querySelector('.pset-row-control')?.getBoundingClientRect();
    return {
      行数: rows.length,
      名称在左控件在右: lbl && ctl ? ctl.left > lbl.left + 100 : false,
      同基线: lbl && ctl ? Math.abs((lbl.top + lbl.height / 2) - (ctl.top + ctl.height / 2)) < 40 : false,
    };
  })()
`);
check('设置行统一为"左名称与说明、右控件"',
  rowLayout?.名称在左控件在右 === true, JSON.stringify(rowLayout));

console.log('  -- 第十六批：应用设置只含应用级 --');
await go('/settings');
const appSet = await c.ev(`
  (() => {
    const nav = document.querySelector('.settings-nav');
    return {
      标题: document.querySelector('.page-title')?.innerText.trim(),
      分区: nav ? [...nav.querySelectorAll('.settings-nav-text')].map(e => e.innerText.trim()) : [],
      分组: nav ? [...nav.querySelectorAll('.settings-nav-label')].map(e => e.innerText.trim()) : [],
      有项目选择器: !!document.querySelector('.settings-nav-project'),
      有项目类分区: nav ? [...nav.querySelectorAll('.settings-nav-text')].some(e => /任务与协作|文件写入|文件修改/.test(e.innerText)) : false,
      底部设置高亮: [...document.querySelectorAll('.sidebar-foot .side-item.active')].some(e => e.innerText.includes('设置')),
    };
  })()
`);
check('应用设置只剩应用分区（第十七批新增「归档管理」）、无"当前项目"组、无项目类分区',
  String(appSet?.标题) === '应用设置'
    && JSON.stringify(appSet?.分区) === JSON.stringify(['通用', '执行工具', '设备与局域网', '归档管理', '诊断与帮助'])
    && appSet?.有项目选择器 === false
    && appSet?.有项目类分区 === false,
  JSON.stringify({ 标题: appSet?.标题, 分区: appSet?.分区 }));
check('应用设置页高亮底部「设置」入口', appSet?.底部设置高亮 === true);

// 应用设置里的开关**真的改变值**（修掉"点击只弹 toast"）
await go('/settings?section=general');
const swBefore = await c.ev(`[...document.querySelectorAll('.settings-body .switch-track')].map(e => e.classList.contains('on'))`);
await c.ev(`(() => { const s = document.querySelectorAll('.settings-body .switch')[0]; if (s) s.click(); return !!s; })()`);
await sleep(800);
const swAfter = await c.ev(`[...document.querySelectorAll('.settings-body .switch-track')].map(e => e.classList.contains('on'))`);
check('应用设置里的开关点击后**真实改变值**（不再是固定 checked + 只弹提示）',
  JSON.stringify(swBefore) !== JSON.stringify(swAfter),
  `${JSON.stringify(swBefore)} → ${JSON.stringify(swAfter)}`);

// 错误码速查并入诊断与帮助，且可展开
await go('/settings?section=diagnostics');
const errorsInDiag = await c.ev(`
  (() => {
    const head = document.querySelector('.settings-collapse-head');
    return {
      有折叠头: !!head,
      含错误码速查: head ? head.innerText.includes('错误码速查') : false,
      展开态: head ? head.getAttribute('aria-expanded') : null,
    };
  })()
`);
check('「错误码速查」并入「诊断与帮助」并作为可展开内容',
  errorsInDiag?.有折叠头 === true && errorsInDiag?.含错误码速查 === true,
  JSON.stringify(errorsInDiag));

console.log('  -- 第十六批：数字输入保留编辑态 --');
await go('/project/proj_zs_01/settings');
const numBefore = await c.ev(`document.querySelector('.pset-number')?.value ?? null`);
await c.ev(`
  (() => {
    const el = document.querySelector('.pset-number');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(400);
const numAfter = await c.ev(`document.querySelector('.pset-number')?.value ?? null`);
check('数字输入可以清空编辑（不再每输入一位就被钳回默认值）',
  numAfter === '', `"${numBefore}" → "${numAfter}"`);

// 逐位输入也应保留
await c.ev(`
  (() => {
    const el = document.querySelector('.pset-number');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '45');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()
`);
await sleep(400);
check('数字输入逐位输入不被打断（"45" 保持为 45）',
  (await c.ev(`document.querySelector('.pset-number')?.value`)) === '45');

console.log('  -- 第十六批：无效项目不回退 --');
await go('/project/proj_nope/settings');
const invalid = await c.ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    return {
      有错误: t.includes('项目不存在'),
      无设置控件: !document.querySelector('.wpolicy') && !document.querySelector('.pset-row'),
      说明不回退: t.includes('不回退'),
    };
  })()
`);
check('无效项目设置显式报错且无写入控件，不回退到第一个项目',
  invalid?.有错误 === true && invalid?.无设置控件 === true && invalid?.说明不回退 === true,
  JSON.stringify(invalid));

console.log('  -- 第十六批：旧 URL 兼容 --');
for (const [url, expect] of [
  ['/settings?section=project&projectId=proj_zs_01', '/project/proj_zs_01/settings'],
  ['/settings?section=collab&projectId=proj_zs_01', '/project/proj_zs_01/settings'],
  ['/settings?section=budget&projectId=proj_zs_01', '/project/proj_zs_01/settings'],
  ['/settings?section=write&projectId=proj_zs_01', '/project/proj_zs_01/settings'],
]) {
  await go(url);
  const got = await c.ev(`location.hash`);
  check(`项目类旧链接规范化到项目设置页：${url}`, String(got).includes(expect), String(got));
}

for (const [url, expect] of [
  ['/settings?section=app', '通用'],
  ['/settings?section=general', '通用'],
  ['/settings?section=runtime', '执行工具（Runtime）'],
  ['/settings?section=lan', '设备与局域网'],
  ['/settings?section=diagnostics', '诊断与帮助'],
]) {
  await go(url);
  const title = await c.ev(`document.querySelector('.settings-section-title')?.innerText.trim() ?? null`);
  check(`应用分区可用：${url}`, title === expect, `标题=${JSON.stringify(title)}`);
}

// section=errors 必须真的把 URL 规范化到 diagnostics
await go('/settings?section=errors');
const errUrl = await c.ev(`location.hash`);
const errTitle = await c.ev(`document.querySelector('.settings-section-title')?.innerText.trim() ?? null`);
check('旧 section=errors 规范化到 diagnostics 并展开速查',
  String(errUrl).includes('section=diagnostics') && errTitle === '诊断与帮助',
  `hash=${errUrl} 标题=${errTitle}`);

// 应用链接上多余的 projectId 不应切换焦点
await reset();
await go('/project/proj_zs_01/room/room_dev_hall');
const focusBefore = await c.ev(`document.querySelector('.titlebar-proj-name')?.innerText.trim()`);
await go('/settings?section=runtime&projectId=proj_backfill_02');
const strayId = await c.ev(`({ 顶栏: document.querySelector('.titlebar-proj-name')?.innerText.trim(), hash: location.hash })`);
check('应用设置链接上残留的 projectId 不改变焦点（且被清除）',
  strayId?.顶栏 === focusBefore && !String(strayId?.hash).includes('projectId'),
  JSON.stringify({ before: focusBefore, after: strayId }));

// 提醒仍重定向到待我处理，且独立成节
await go('/settings?section=reminders');
const remindersMoved = await c.ev(`
  (() => ({
    hash: location.hash,
    在待我处理页: (document.querySelector('.page-title')?.innerText ?? '').includes('待我处理'),
    有提醒分节: document.body.innerText.includes('我设的提醒'),
    说明与待办相反: document.body.innerText.includes('和上面的待办方向相反'),
  }))()
`);
check('提醒已移出设置：section=reminders 重定向到「待我处理」并独立成节',
  remindersMoved?.hash === '#/activity' && remindersMoved?.在待我处理页 === true
    && remindersMoved?.有提醒分节 === true,
  JSON.stringify(remindersMoved));

// 设置页里不应再有提醒分区
await go('/settings?section=general');
const noRemindersInSettings = await c.ev(`
  (() => {
    const nav = document.querySelector('.settings-nav');
    const items = nav ? [...nav.querySelectorAll('.settings-nav-text')].map(e => e.innerText.trim()) : [];
    return { 含提醒分区: items.some(x => x.includes('提醒')), 分区: items };
  })()
`);
check('设置导航树里不再有「提醒」分区',
  noRemindersInSettings?.含提醒分区 === false, JSON.stringify(noRemindersInSettings?.分区));

await reset();

await reset();

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
c.ws.close();
process.exit(passed === results.length ? 0 : 1);
