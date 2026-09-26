/**
 * 验证：Git 页（用户要求新增）。
 *
 * 覆盖三件必须成立的事：
 *  1. 页面与导航真的存在，且能显示真实的 commit/branch/diff
 *  2. §14.2 底线：用户自己的未提交改动不会被批量暂存顺手提交
 *  3. §14.5 底线：撤销提交是软回退，不删文件；冲突不给一键覆盖
 */
const PORT = '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let id = 0;
let p = new Map();

/** 连接（或重连）CDP。reload 会让旧会话失效，必须重连。 */
async function connect() {
  try { ws?.close(); } catch { /* 已关闭 */ }
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  id = 0;
  p = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  };
}
await connect();

const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => {
      p.delete(i);
      res({});
    }, 10000);
    p.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};

/**
 * 回到种子状态。
 * 原型是内存 store，前面的脚本（尤其 verify-git-ops）会真实改状态；
 * 不重置的话暂存区/冲突区内容会随执行顺序变化，造成假失败。
 */
async function resetToSeed() {
  await send('Page.enable');
  // 第十五批：导航偏好持久化在 localStorage，reload 不会清；
  // 不清就会带着上一轮的当前项目/可见项目进入下一轮断言。
  await ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(2600);
  await connect();
  await ev(`window.zhongshuo?.window.show()`);
  await ev(`(() => { const m=document.querySelector('.modal'); if(m){const b=[...m.querySelectorAll('.btn')].find(x=>/稍后处理/.test(x.textContent)); if(b) b.click();} return true; })()`);
  await sleep(400);
}

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

await resetToSeed();

/* ---------- 1. 侧栏入口（第十五批：Git 并入「文件与 Git」合页） ----------
 * 用例更新（第十五批 §17.7）：原断言侧栏有独立「Git」项。
 * 合页后侧栏只有「文件与 Git」，Git 变成页内标签 ——
 * 所以改为断言合页入口存在、独立 Git 入口不存在，且 Git 标签可达。
 */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall'; true`);
await sleep(2000);
const nav = await ev(`
  (() => [...document.querySelectorAll('.side-item-label')].map(e => e.innerText.trim()))()
`);
check('侧栏有「文件与 Git」合页入口', Array.isArray(nav) && nav.includes('文件与 Git'), (nav ?? []).join('/'));
check('不再有独立「Git」侧栏入口', Array.isArray(nav) && !nav.includes('Git'));

/* ---------- 2. 进入 Git 标签并检查结构 ---------- */
await ev(`location.hash='/project/proj_zs_01/files?tab=git'; true`);
await sleep(2200);
const page = await ev(`
  (() => {
    const root = document.querySelector('.page');
    const txt = root?.innerText ?? '';
    return {
      title: root?.querySelector('.page-title')?.innerText,
      // 内层三个视图从 thread-tabs 降级为分段控件（本轮改造：不再有第二层大页签）
      有工作区tab: [...root.querySelectorAll('.seg button')].some(e => e.innerText.includes('工作区')),
      有历史tab: [...root.querySelectorAll('.seg button')].some(e => e.innerText.includes('历史')),
      有分支tab: [...root.querySelectorAll('.seg button')].some(e => e.innerText.includes('分支')),
      有暂存区: txt.includes('已暂存'),
      有按任务分组: txt.includes('待提交 · 按任务'),
      有用户改动分组: txt.includes('你自己的改动'),
      有冲突区: txt.includes('冲突未解决'),
      显示分支: txt.includes('main'),
    };
  })()
`);
// 合页后页标题是「文件与 Git」，不再是单独的「Git」
check('合页页标题为「文件与 Git」', page?.title === '文件与 Git', page?.title);
check('三个分区 tab 都在（工作区/历史/分支）',
  page?.有工作区tab && page?.有历史tab && page?.有分支tab);
check('显示暂存区', page?.有暂存区 === true);
check('待提交改动按任务归属分组', page?.有按任务分组 === true);
check("用户自己的改动单独分组（§14.2）", page?.有用户改动分组 === true);
check('冲突单独提示', page?.有冲突区 === true);
/*
 * 2026-09-26 交互收尾：工作区一次只显示一个选中文件，
 * 所以**选中后直接显示 diff**，不再要求先点「展开 diff」。
 * 断言语义没变（能渲染真实 diff 行），但不再有"展开"这个动作；
 * 也不允许再出现一个点了没反应的展开按钮。
 */
const picked = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.git-list-row')];
    const r = rows.find(x => x.innerText.includes('build-report.mjs'));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(600);
const diffInfo = await ev(`
  (() => {
    const root = document.querySelector('.page');
    return {
      有diff: !!root.querySelector('.diff-view'),
      diff行数: root.querySelectorAll('.diff-line').length,
      有展开按钮: [...root.querySelectorAll('.git-detail .btn')].some(x => x.textContent.includes('展开 diff')),
    };
  })()
`);
check('工作区选中文件后直接显示 diff（无需再点展开）',
  picked === true && diffInfo?.有diff === true && (diffInfo?.diff行数 ?? 0) > 0,
  `${diffInfo?.diff行数} 行`);
check('不再出现「展开 diff」按钮（避免点了没反应的入口）', diffInfo?.有展开按钮 === false);

/* 无文本 diff 的文件要如实说明，而不是给一个空展开按钮 */
await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.git-list-row')];
    const r = rows.find(x => x.innerText.includes('large-corpus.bin'));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(500);
const noDiff = await ev(`
  (() => {
    const root = document.querySelector('.page');
    const t = root.querySelector('.git-detail')?.innerText ?? '';
    return {
      说明无diff: t.includes('没有可展示的文本 diff'),
      没有空diff视图: !root.querySelector('.diff-view'),
    };
  })()
`);
check('无文本 diff 的文件如实说明（不假装能展开）',
  noDiff?.说明无diff === true && noDiff?.没有空diff视图 === true);

/* ---------- 3. §14.2：批量暂存只暂存任务改动，跳过用户改动 ---------- */
const stage = await ev(`
  (() => {
    const btns = [...document.querySelectorAll('.btn')];
    const b = btns.find(x => x.textContent.includes('暂存本任务改动'));
    if (!b) return { clicked: false };
    b.click();
    return { clicked: true };
  })()
`);
await sleep(600);
const afterStage = await ev(`
  (() => {
    const root = document.querySelector('.page');
    const txt = root?.innerText ?? '';
    // 暂存区里出现的路径（按分区定位，不再依赖整页文本切分）
    const stagedSec = [...root.querySelectorAll('.git-list-sec')].find(s => s.innerText.includes('已暂存'));
    const stagedBlock = stagedSec?.innerText ?? '';
    return {
      stagedHasBuild: stagedBlock.includes('build-report.mjs'),
      stagedHasReadme: stagedBlock.includes('docs/README.md'),
      用户改动仍在未暂存区: txt.includes('你自己的改动') && txt.includes('默认跳过批量暂存'),
      toast: document.querySelector('.toast')?.innerText ?? '',
    };
  })()
`);
check('能按任务批量暂存', stage?.clicked === true);
check('任务改动进入暂存区', afterStage?.stagedHasBuild === true);
check('§14.2 用户自己的改动没有被顺手暂存',
  afterStage?.stagedHasReadme === false,
  afterStage?.stagedHasReadme ? 'README 被错误暂存了' : 'docs/README.md 仍留在工作区');
check('用户改动分组仍然保留', afterStage?.用户改动仍在未暂存区 === true);

/* ---------- 4. 历史 tab：真实提交 + 关联任务 ---------- */
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.seg button')].find(e => e.innerText.includes('历史'));
    if (t) t.click();
    return true;
  })()
`);
await sleep(700);
const history = await ev(`
  (() => {
    const root = document.querySelector('.page');
    const txt = root?.innerText ?? '';
    return {
      有提交: txt.includes('收敛 Windows 中文路径解析') || txt.includes('初始化仓库'),
      有短哈希: /[0-9a-f]{7}/.test(txt),
      有关联任务按钮: txt.includes('来自任务'),
      有agent提交标记: txt.includes('agent 提交'),
      // v1.12 §10.5：不再有 commit 级「待审阅」标签与审批队列
      无提交级待审阅: !txt.includes('有 agent 产出的提交等你审阅'),
      说明提交与验收独立: txt.includes('验收只在任务交付里做'),
      // §10.5 第 8 条：不能只凭 taskId 就给整个 commit 打「已审阅」勾。
      // 种子里的提交属于任务 #12，而 #12 没有交付版本 → 不应出现任何交付结论标签。
      无虚假已审阅: !/已审阅/.test(txt),
      有reflog: txt.includes('reflog'),
      有软回退说明: txt.includes('软回退'),
    };
  })()
`);
check('历史显示真实提交', history?.有提交 === true);
check('显示短哈希', history?.有短哈希 === true);
check('提交能回溯到任务（本页核心价值）', history?.有关联任务按钮 === true);
/* agent 提交标注：改造后列表行用 cpu 图标 + 行说明标识（右栏详情给完整 Tag），
   所以断言查行上的说明文字，而不是整页 innerText。 */
const agentMark = await ev(`
  (() => [...document.querySelectorAll('.git-list-row')]
    .some(r => (r.getAttribute('title') || '').includes('agent 提交')))()
`);
check('agent 提交明确标注', agentMark === true);
// 用例更新（v1.12 §10.5）：原来断言 commit 带「待审阅」。
// 该机制已被移除 —— 验收只属于任务交付，Git 页不再做 commit 级审批。
check('不再有 commit 级「待审阅」审批队列', history?.无提交级待审阅 === true);
check('明确说明提交与任务验收是两件事', history?.说明提交与验收独立 === true);
// 无交付版本的任务，其提交不得被打上任何验收结论（不能"只凭 taskId 就整体打勾"）
check('无交付的提交不被误标为已审阅', history?.无虚假已审阅 === true);
check('有 reflog 面板', history?.有reflog === true);
check('§14.5 撤销提交说明是软回退', history?.有软回退说明 === true);

/* ---------- 5. 分支 tab ---------- */
await ev(`
  (() => {
    const t = [...document.querySelectorAll('.seg button')].find(e => e.innerText.includes('分支'));
    if (t) t.click();
    return true;
  })()
`);
await sleep(700);
const branches = await ev(`
  (() => {
    const root = document.querySelector('.page');
    const txt = root?.innerText ?? '';
    return {
      有main: txt.includes('main'),
      有隔离分支: txt.includes('zs/task-12-module-boundaries'),
      有远端: txt.includes('origin'),
      凭据状态可见: txt.includes('缺少凭据') || txt.includes('凭据可用'),
      有切换按钮: [...root.querySelectorAll('.btn')].some(b => b.textContent.includes('切换')),
    };
  })()
`);
check('分支列表显示当前分支', branches?.有main === true);
check('显示众说创建的隔离分支', branches?.有隔离分支 === true);
check('显示远端', branches?.有远端 === true);

/* 改造后列表用状态点 + tooltip 表示凭据，完整状态文字在选中该远端后的详情里 ——
   断言也跟着"先选中再断言"，语义不变：缺失就不假装能推。 */
await ev(`
  (() => {
    const r = [...document.querySelectorAll('.git-list-row')].find(x => x.innerText.includes('origin'));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(450);
const remotePicked = await ev(`
  (() => {
    const txt = document.querySelector('.page')?.innerText ?? '';
    return txt.includes('缺少凭据') || txt.includes('凭据可用') || txt.includes('凭据已过期');
  })()
`);
check('远端凭据状态如实显示（缺失不假装能推）', remotePicked === true);

// 「切换」只对非当前分支出现，先选中隔离分支再断言
await ev(`
  (() => {
    const r = [...document.querySelectorAll('.git-list-row')].find(x => x.innerText.includes('zs/task-12-module-boundaries'));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(450);
const canSwitch = await ev(`
  (() => [...document.querySelectorAll('.git-detail .btn')].some(b => b.textContent.includes('切换')))()
`);
check('非当前分支有切换入口', canSwitch === true);

/* ---------- 6. 非 Git 目录：如实说明而不是假装 ---------- */
// 合页后从项目页进入，并显式指定 tab=git（§17.7：非 Git 项目的 Git 标签给说明）
await ev(`location.hash='/project/proj_docs_03/files?tab=git'; true`);
await sleep(2000);
const nonGit = await ev(`
  (() => {
    const txt = document.querySelector('.page')?.innerText ?? '';
    return {
      说明未初始化: txt.includes('尚未初始化 Git') || txt.includes('不是一个 Git 仓库'),
      不自动init说明: txt.includes('不自动 git init'),
      提到改动集仍可用: txt.includes('改动集'),
      有返回文件: txt.includes('返回文件'),
    };
  })()
`);
check('非 Git 目录如实说明（尚未初始化，不假装已连接）', nonGit?.说明未初始化 === true);
check('明确不自动 git init', nonGit?.不自动init说明 === true);
check('说明改动集功能不因此缺失', nonGit?.提到改动集仍可用 === true);
// §17.7 第 4 条：Git 标签显示"尚未初始化 Git"及"返回文件"
check('非 Git 时给出「返回文件」', nonGit?.有返回文件 === true);

/* ---------- 7. 侧栏「文件与 Git」角标：只能是工作区改动数 ----------
 * 回归：v1.12 移除 commit 级审批后，角标曾仍按
 *   status.length + commits.filter(c => c.pendingReview).length
 * 计数，于是显示 6（工作区 5 + 已废除的 commit 审批 1）。
 * 这等于把已取消的"commit 审批队列"重新显示给用户，且与 Git 页对不上。
 * 角标语义：工作区未提交改动数 —— 不含任何审批语义。
 * 第十五批：角标挂在「文件与 Git」合页入口上（不再有独立 Git 项）。
 * 2026-09-26：种子数据加厚（提交 14 条、工作区 13 条）后不再写死数字，
 *   改为**与页面自报的工作区数对齐**并排除"提交数也算进去"这条旧 bug：
 *   提交数已经远大于工作区数，只要角标等于工作区数，就反证了它没把
 *   commit 计入（写死 5 反而会在每次补种子时误报）。
 */
await ev(`window.zhongshuo?.window.show()`);
await ev(`location.hash='/project/proj_zs_01/files?tab=git'; true`);
await sleep(1400);
const badge = await ev(`
  (() => {
    const row = [...document.querySelectorAll('.sidebar .side-item')]
      .find(e => e.querySelector('.side-item-label')?.innerText.trim() === '文件与 Git');
    /* 用例迁移（2026-09-25 侧栏提示统一）：行尾角标从 Tag（图标 + 数字）改成
       同规格数字徽标 .side-badge（只有数字）。这里断言的**语义**没变：
       角标 = 工作区未提交改动数，且不含任何审批语义。 */
    const txt = row?.querySelector('.side-badge')?.innerText.trim() ?? null;
    return { 找到入口: !!row, 角标: txt === null ? null : Number(txt) };
  })()
`);
const worktreeCount = await ev(`
  (() => {
    const t = [...document.querySelectorAll('.seg button')].find(e => e.innerText.includes('工作区'));
    if (t) t.click();
    // 页面自报的两个数：工作区改动数、提交数（后者绝不能进入角标）
    const segs = [...document.querySelectorAll('.seg button')].map((e) => e.innerText.trim());
    const num = (s) => { const m = s.match(/(\\d+)/); return m ? Number(m[1]) : null; };
    return {
      工作区: num(segs.find((s) => s.includes('工作区')) ?? ''),
      历史: num(segs.find((s) => s.includes('历史')) ?? ''),
      状态条: (document.querySelector('.fg-statusbar')?.innerText ?? '').match(/^(\\d+) 个未提交改动/m)?.[1],
    };
  })()
`);
await sleep(600);
const worktreeShown = worktreeCount?.工作区 ?? Number(worktreeCount?.状态条 ?? NaN);
check('「文件与 Git」入口角标 = 工作区改动数，不叠加已废除的 commit 审批数',
  badge?.找到入口 === true && Number.isFinite(worktreeShown) && badge?.角标 === worktreeShown
    && worktreeCount?.历史 !== worktreeShown,
  `角标=${badge?.角标}，页面自报工作区=${worktreeShown}、历史=${worktreeCount?.历史}`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
