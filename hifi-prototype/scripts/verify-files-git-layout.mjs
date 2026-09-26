/**
 * 验证：文件与 Git 合页的**交互收尾**（2026-09-26）
 *
 * 这一轮要证明的不是"CSS 写对了"，而是**真实操作后的行为**：
 *   1. 左右两栏各自滚动，滚一侧不动另一侧，也不拖动外层页面
 *   2. 列表滚到底后，选中底部条目 → 详情在当前可视区域里立刻可见
 *   3. 顶部标签 / 状态条 / 准备提交三者不互相遮挡
 *   4. Git 工作区选中即显示 diff
 *   5. 批量暂存后可以逐个复核、取消暂存是独立操作
 *   6. 改动集的"左侧高亮"与"右侧详情"是同一个对象；切项目不串线
 *   7. 1480×940 / 1280×800 / 窄窗口（分步显示）三档都可用
 *
 * 取证方式：读 scrollTop / scrollHeight / getBoundingClientRect 的前后变化，
 * 并落盘截图。不做"看一眼 CSS 就下结论"的静态断言。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const PORT = '9333';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = path.join(HERE, '..', 'screenshots-desktop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let id = 0;
let p = new Map();

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
    const t = setTimeout(() => { p.delete(i); res({}); }, 15000);
    p.set(i, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r.result?.data) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'));
}

/** 临时测试条件：改视口只是为了"让列表真的需要滚动"，不改任何种子数据 */
async function viewport(w, h) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
}
async function viewportOff() {
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
}

async function goto(hash, ms = 1800) {
  await ev(`location.hash = ${JSON.stringify(hash)}; true`);
  await sleep(ms);
}

async function resetToSeed() {
  await send('Page.enable');
  await ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(2600);
  await connect();
  await ev(`window.zhongshuo?.window.show()`);
  await ev(`(() => { const m=document.querySelector('.modal'); if(m){const b=[...m.querySelectorAll('.btn')].find(x=>/稍后处理/.test(x.textContent)); if(b) b.click();} return true; })()`);
  await sleep(400);
}

/** 两栏滚动探针：左 / 右 / 外层 .page 的位置与可滚动量 */
const PROBE = `(() => {
  const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
  const right = document.querySelector('.fg-pane-detail .fg-pane-scroll')
    || document.querySelector('.fg-pane-detail .preview-body');
  const page = document.querySelector('.page');
  const r = (el) => el ? { top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight } : null;
  return { 左: r(left), 右: r(right), 页: r(page), 有左: !!left, 有右: !!right };
})()`;

await resetToSeed();

/* ============================================================
   1. 文件页：目录树 / 预览 两栏各自滚动（1480×940）
   ============================================================ */
await viewport(1480, 940);
await goto('/project/proj_zs_01/files?tab=files');
const f0 = await ev(PROBE);
check('文件页：左右两栏各自有滚动容器', f0?.有左 === true && f0?.有右 === true);
check('文件页：外层 .page 不提供滚动（内容没被撑出页面）',
  f0?.页 && f0.页.h - f0.页.c <= 2, `page scrollHeight-clientHeight=${(f0?.页?.h ?? 0) - (f0?.页?.c ?? 0)}`);
check('文件页：左栏目录树真的需要滚动', (f0?.左?.h ?? 0) > (f0?.左?.c ?? 0) + 20,
  `${f0?.左?.h} / ${f0?.左?.c}`);

// 滚左栏：右栏与页面都不动
const f1 = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    const right = document.querySelector('.fg-pane-detail .fg-pane-scroll') || document.querySelector('.fg-pane-detail .preview-body');
    const page = document.querySelector('.page');
    const before = { r: right?.scrollTop, p: page?.scrollTop };
    left.scrollTop = 260;
    return { before, l: left.scrollTop, r: right?.scrollTop, p: page?.scrollTop };
  })()
`);
check('文件页：滚动左栏不动右栏、不动页面',
  f1?.l > 0 && f1?.r === f1?.before?.r && f1?.p === f1?.before?.p,
  `左 ${f1?.before?.r ?? '-'}→${f1?.l}；右 ${f1?.before?.r}→${f1?.r}；页 ${f1?.p}`);

// 左栏滚到底后，视图切换（目录树 / 改动集）仍然可见、没被滚走
const headVisible = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    left.scrollTop = left.scrollHeight;
    const head = document.querySelector('.fg-pane-list .fg-pane-head');
    const seg = document.querySelector('.fg-pane-list .seg');
    const r = head?.getBoundingClientRect();
    return {
      lTop: left.scrollTop,
      headTop: r?.top, headBottom: r?.bottom,
      在视口内: !!r && r.top >= 0 && r.bottom <= window.innerHeight,
      有视图切换: !!seg && seg.getBoundingClientRect().top >= 0,
    };
  })()
`);
check('文件页：左栏滚到底后视图切换仍在原位可见（没被滚走）',
  headVisible?.在视口内 === true && headVisible?.有视图切换 === true,
  `headTop=${Math.round(headVisible?.headTop ?? -1)}`);
await shot('70-files-tree-left-scrolled.png');

/* ---------- 1b. 选中文件 → 共享预览是右栏唯一滚动容器 ---------- */
await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.file-row')];
    /* 只点**文件**行：目录行没有 .file-row-size，点它只会展开目录、不产生预览。
       用 title（= 节点完整路径）判定扩展名，不靠行内可见文字。 */
    const r = rows.find(x => /\\.(md|ts|tsx|mjs|json)$/.test((x.getAttribute('title') || '').trim()));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(700);
const pv = await ev(`
  (() => {
    const right = document.querySelector('.fg-pane-detail .preview-body');
    const nested = document.querySelectorAll('.fg-pane-detail .fg-pane-scroll').length;
    return {
      有预览: !!right,
      右栏嵌套滚动容器数: nested,
      h: right?.scrollHeight, c: right?.clientHeight,
    };
  })()
`);
check('文件页：预览打开后右栏只有一条滚动容器（不再嵌套一层）',
  pv?.有预览 === true && pv?.右栏嵌套滚动容器数 === 0,
  `嵌套数=${pv?.右栏嵌套滚动容器数}`);

const pvScroll = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    const right = document.querySelector('.fg-pane-detail .preview-body');
    const page = document.querySelector('.page');
    const lb = left.scrollTop, pb = page.scrollTop;
    right.scrollTop = 200;
    return { lb, pb, r: right.scrollTop, l: left.scrollTop, p: page.scrollTop, 可滚: right.scrollHeight > right.clientHeight };
  })()
`);
check('文件页：滚动右栏预览不动左栏、不动页面',
  pvScroll?.l === pvScroll?.lb && pvScroll?.p === pvScroll?.pb,
  `右→${pvScroll?.r}；左 ${pvScroll?.lb}→${pvScroll?.l}；页 ${pvScroll?.p}`);

/* ---------- 1c. 共享预览：关闭 / 重开 / 引用入口仍可用 ---------- */
const previewOps = await ev(`
  (() => {
    const close = document.querySelector('.fg-pane-detail .preview-tab-close');
    if (close) close.click();
    return !!close;
  })()
`);
await sleep(500);
const afterClose = await ev(`
  (() => {
    const d = document.querySelector('.fg-pane-detail');
    return {
      无标签: !d?.querySelector('.preview-tab'),
      右栏还在: !!d && d.getBoundingClientRect().height > 0,
      有空态: /还没有打开文件/.test(d?.innerText ?? ''),
    };
  })()
`);
/* 回归：这里曾触发 React #300 —— 共享预览在"没有标签"时会 return null，
   而那个 return 在它自己的 hooks 之前，文件页关掉最后一个标签就把整页打崩。 */
check('共享预览：关闭最后一个标签后右栏回到空态（不崩页、不留半截预览）',
  previewOps === true && afterClose?.无标签 === true && afterClose?.右栏还在 === true && afterClose?.有空态 === true,
  `空态=${afterClose?.有空态}`);
await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.file-row')];
    /* 只点**文件**行：目录行没有 .file-row-size，点它只会展开目录、不产生预览。
       用 title（= 节点完整路径）判定扩展名，不靠行内可见文字。 */
    const r = rows.find(x => /\\.(md|ts|tsx|mjs|json)$/.test((x.getAttribute('title') || '').trim()));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(700);
const quoteOk = await ev(`
  (() => {
    const d = document.querySelector('.fg-pane-detail');
    const b = [...(d?.querySelectorAll('.btn') ?? [])].find(x => /引用到/.test(x.textContent));
    return { 有标签: !!d?.querySelector('.preview-tab'), 有引用入口: !!b, 文案: b?.textContent.trim() ?? null };
  })()
`);
check('共享预览：重新打开后文件标签与「引用到…」入口都仍然可用',
  quoteOk?.有标签 === true && quoteOk?.有引用入口 === true, quoteOk?.文案 ?? '');
await shot('71-files-preview-reopened.png');

/* ============================================================
   2. 文件页：改动集列表 / 详情 —— 两栏各自滚动 + 选中一致
   ============================================================ */
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.fg-pane-list .seg button')].find(x => /改动集/.test(x.innerText));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(600);
const csConsistent = await ev(`
  (() => {
    const cards = [...document.querySelectorAll('.fg-pane-list .card.tight')];
    const on = cards.filter(c => c.classList.contains('selected'));
    const title = (on[0]?.innerText ?? '').split('\\n')[0].trim();
    const detailTitle = document.querySelector('.fg-pane-detail .card .strong')?.innerText?.trim();
    return { 高亮数: on.length, 左: title, 右: detailTitle, 一致: title !== '' && title === detailTitle };
  })()
`);
check('改动集：右侧默认展示第一项时左侧同时高亮同一项（同一有效选中）',
  csConsistent?.高亮数 === 1 && csConsistent?.一致 === true,
  `左=${csConsistent?.左} / 右=${csConsistent?.右}`);

await ev(`
  (() => {
    const b = [...document.querySelectorAll('.fg-pane-detail .btn')].find(x => /全部展开/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(600);
const csScroll = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    const right = document.querySelector('.fg-pane-detail .fg-pane-scroll');
    const page = document.querySelector('.page');
    const rb = right.scrollTop, lb = left.scrollTop, pb = page.scrollTop;
    right.scrollTop = 300;
    const after = { r: right.scrollTop, l: left.scrollTop, p: page.scrollTop };
    const 左可滚 = left.scrollHeight > left.clientHeight + 2;
    left.scrollTop = 60;
    return { rb, lb, pb, after, l2: left.scrollTop, r2: right.scrollTop, 左可滚 };
  })()
`);
check('改动集：右栏详情滚动不动左栏、不动页面',
  csScroll?.after?.l === csScroll?.lb && csScroll?.after?.p === csScroll?.pb && csScroll?.after?.r > 0,
  `右→${csScroll?.after?.r}；左 ${csScroll?.lb}→${csScroll?.after?.l}`);
check('改动集：滚右到底后再滚左，右栏保持原位（双向互不干扰）',
  csScroll?.r2 === csScroll?.after?.r
    && (csScroll?.左可滚 ? csScroll?.l2 === 60 : csScroll?.l2 === csScroll?.lb),
  `左 ${csScroll?.lb}→${csScroll?.l2}（左栏可滚=${csScroll?.左可滚}）；右=${csScroll?.r2}`);
await shot('72-files-changeset-scrolled.png');

/* ---------- 2b. 切项目不串线 ---------- */
await goto('/project/proj_docs_03/files?tab=files');
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.fg-pane-list .seg button')].find(x => /改动集/.test(x.innerText));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(600);
const switched = await ev(`
  (() => {
    const cards = [...document.querySelectorAll('.fg-pane-list .card.tight')];
    const on = cards.filter(c => c.classList.contains('selected'));
    const detail = document.querySelector('.fg-pane-detail')?.innerText ?? '';
    const left = (on[0]?.innerText ?? '').split('\\n')[0].trim();
    return {
      高亮数: on.length,
      左: left,
      在详情里: left === '' ? null : detail.includes(left),
      详情提到别的项目改动集: /cs_13|任务 #13/.test(detail),
    };
  })()
`);
check('切项目后不残留上一个项目的选中（左侧高亮与右侧详情同属当前项目）',
  switched?.在详情里 !== false && switched?.详情提到别的项目改动集 === false,
  `左=${switched?.左 ?? '（无改动集）'}；高亮数=${switched?.高亮数}`);

/* ============================================================
   3. Git 工作区：左清单 / 右 diff 各自滚动
   ============================================================ */
await viewport(1480, 940);
await goto('/project/proj_zs_01/files?tab=git');
const g0 = await ev(PROBE);
check('Git 页：左右两栏各自有滚动容器', g0?.有左 === true && g0?.有右 === true);
check('Git 页：外层 .page 不提供滚动',
  g0?.页 && g0.页.h - g0.页.c <= 2, `${(g0?.页?.h ?? 0) - (g0?.页?.c ?? 0)}`);
check('Git 页：左清单真的需要滚动', (g0?.左?.h ?? 0) > (g0?.左?.c ?? 0) + 20, `${g0?.左?.h} / ${g0?.左?.c}`);

const g1 = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    const right = document.querySelector('.fg-pane-detail .fg-pane-scroll');
    const page = document.querySelector('.page');
    const rb = right.scrollTop, pb = page.scrollTop;
    left.scrollTop = left.scrollHeight;               // 左栏滚到底
    return { rb, pb, l: left.scrollTop, r: right.scrollTop, p: page.scrollTop };
  })()
`);
check('Git 页：左清单滚到底不动右栏、不拖动页面',
  g1?.l > 0 && g1?.r === g1?.rb && g1?.p === g1?.pb,
  `左→${g1?.l}；右 ${g1?.rb}→${g1?.r}；页 ${g1?.p}`);

/* ---------- 3b. 选中即出 diff，切换选中后详情回到起点 ---------- */
const picked1 = await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.git-list-row')];
    const r = rows.find(x => x.innerText.includes('build-report.mjs'));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(600);
const diffNow = await ev(`
  (() => {
    const d = document.querySelector('.fg-pane-detail .fg-pane-scroll');
    return {
      有diff: !!document.querySelector('.fg-pane-detail .diff-view'),
      行数: document.querySelectorAll('.fg-pane-detail .diff-line').length,
      详情滚动位置: d?.scrollTop,
    };
  })()
`);
check('Git 工作区：选中文件后 diff 直接可见（无需点击展开）',
  picked1 === true && diffNow?.有diff === true && diffNow?.行数 > 0, `${diffNow?.行数} 行`);

const switchSel = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    const before = left.scrollTop;
    // 把详情滚到中间，再换一个文件：详情应从顶部开始，左栏位置不动
    const detail = document.querySelector('.fg-pane-detail .fg-pane-scroll');
    detail.scrollTop = 120;
    const rows = [...document.querySelectorAll('.git-list-row')];
    const r = rows.find(x => x.innerText.includes('paths.mjs'));
    if (r) r.click();
    return { before, detailBefore: 120 };
  })()
`);
await sleep(600);
const switchAfter = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    const detail = document.querySelector('.fg-pane-detail .fg-pane-scroll');
    return {
      左: left.scrollTop,
      详情: detail.scrollTop,
      显示新文件: (document.querySelector('.fg-pane-detail')?.innerText ?? '').includes('paths.mjs'),
    };
  })()
`);
check('Git 工作区：切换选中后详情从顶部开始、左栏保持自身位置',
  switchAfter?.详情 === 0 && switchAfter?.左 === switchSel?.before && switchAfter?.显示新文件 === true,
  `左 ${switchSel?.before}→${switchAfter?.左}；详情 ${switchSel?.detailBefore}→${switchAfter?.详情}`);
await shot('73-git-worktree-diff-selected.png');

/* ---------- 3c. 右栏长 diff 滚到底不拖动外层 ----------
   制造"长 diff"的方式：**挑出 diff 行数最多的那个文件**，再临时压低视口高度
   直到右栏真的需要滚动。全是临时测试条件，不往种子数据里塞任何东西。 */
const rowPaths = (await ev(`
  (() => [...document.querySelectorAll('.fg-pane-list .git-list-row')]
    .map(r => (r.innerText || '').split('\\n')[0].trim())
    .filter(Boolean))()
`)) ?? [];
let bestPath = null;
let bestN = -1;
for (const t of rowPaths) {
  await ev(`
    (() => {
      const rows = [...document.querySelectorAll('.fg-pane-list .git-list-row')];
      const r = rows.find(x => (x.innerText || '').split('\\n')[0].trim() === ${JSON.stringify(t)});
      if (r) r.click();
      return !!r;
    })()
  `);
  await sleep(140);
  const n = await ev(`document.querySelectorAll('.fg-pane-detail .diff-line').length`);
  if (n > bestN) { bestN = n; bestPath = t; }
}
await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.fg-pane-list .git-list-row')];
    const r = rows.find(x => (x.innerText || '').split('\\n')[0].trim() === ${JSON.stringify(bestPath ?? '')});
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(400);

let g2 = null;
let usedH = null;
for (const h of [620, 520, 460]) {
  await viewport(1480, h);
  const probe = await ev(`
    (() => {
      const right = document.querySelector('.fg-pane-detail .fg-pane-scroll');
      return { 右可滚: right ? right.scrollHeight > right.clientHeight + 4 : false, h: right?.scrollHeight, c: right?.clientHeight };
    })()
  `);
  if (probe?.右可滚) { usedH = h; break; }
}
g2 = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    const right = document.querySelector('.fg-pane-detail .fg-pane-scroll');
    const page = document.querySelector('.page');
    const lb = left.scrollTop, pb = page.scrollTop;
    right.scrollTop = right.scrollHeight;
    return {
      lb, pb, r: right.scrollTop, l: left.scrollTop, p: page.scrollTop,
      右可滚: right.scrollHeight > right.clientHeight + 4,
      行数: document.querySelectorAll('.fg-pane-detail .diff-line').length,
    };
  })()
`);
check('Git 页：右栏长 diff 滚到底不动左栏、不拖动页面',
  g2?.右可滚 === true && g2?.r > 0 && g2?.l === g2?.lb && g2?.p === g2?.pb,
  `${bestPath}（${g2?.行数} 行，视口高 ${usedH}）右→${g2?.r}；左 ${g2?.lb}→${g2?.l}；页 ${g2?.p}`);
await shot('73b-git-long-diff-scrolled.png');
await viewport(1480, 940);
await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.fg-pane-list .git-list-row')];
    const r = rows.find(x => x.innerText.includes('build-report.mjs'));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(400);

/* ============================================================
   4. 暂存区位置 / 逐个复核 / 取消暂存是独立操作
   ============================================================ */
const order = await ev(`
  (() => {
    const secs = [...document.querySelectorAll('.fg-pane-list .git-list-sec')];
    return secs.map(s => (s.querySelector('.section-title')?.innerText ?? '').split('\\n')[0].trim());
  })()
`);
const iStaged = order.findIndex((t) => t.includes('已暂存'));
const iTask = order.findIndex((t) => t.includes('待提交'));
check('已暂存排在冲突之后、未暂存任务分组之前（提交前复核容易到达）',
  iStaged >= 0 && iTask >= 0 && iStaged < iTask, order.join(' → '));

// 冲突必须先解决才能提交：先解决掉种子里那一个
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('查看三方内容'));
    if (!b) return false;
    b.click();
    return true;
  })()
`);
await sleep(600);
await ev(`
  (() => {
    const m = document.querySelector('.modal');
    const b = [...(m?.querySelectorAll('.btn') ?? [])].find(x => x.textContent.includes('用这个'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(300);
await ev(`(() => { const b=[...document.querySelectorAll('.btn')].find(x=>x.textContent.includes('用编辑后的内容解决')); if(b) b.click(); return !!b; })()`);
await sleep(700);

// 批量暂存（§14.2：跳过用户自己的改动）
await ev(`(() => { const b=[...document.querySelectorAll('.btn')].find(x=>x.textContent.includes('暂存本任务改动')); if(b) b.click(); return !!b; })()`);
await sleep(700);
const stagedRows = await ev(`
  (() => {
    const sec = [...document.querySelectorAll('.fg-pane-list .git-list-sec')].find(s => s.innerText.includes('已暂存'));
    const rows = [...(sec?.querySelectorAll('.git-list-row') ?? [])];
    return {
      条数: rows.length,
      路径: rows.map(r => (r.innerText || '').split('\\n')[0].trim()),
      有取消按钮: rows.every(r => [...r.querySelectorAll('.btn')].some(b => b.textContent.includes('取消暂存'))),
    };
  })()
`);
check('批量暂存后已暂存区列出文件，且每行都有独立的「取消暂存」',
  stagedRows?.条数 > 0 && stagedRows?.有取消按钮 === true, `${stagedRows?.条数} 个：${(stagedRows?.路径 ?? []).slice(0, 3).join('、')}`);

// 逐个复核：不需要先取消暂存
const review = await ev(`
  (() => {
    const sec = [...document.querySelectorAll('.fg-pane-list .git-list-sec')].find(s => s.innerText.includes('已暂存'));
    const rows = [...(sec?.querySelectorAll('.git-list-row') ?? [])];
    const first = rows[0];
    const path = (first.innerText || '').split('\\n')[0].trim();
    first.click();
    return { path, 条数: rows.length };
  })()
`);
await sleep(600);
const reviewDetail = await ev(`
  (() => {
    const t = document.querySelector('.fg-pane-detail')?.innerText ?? '';
    return { 显示该文件: t.includes(%PATH%), 标已暂存: t.includes('已暂存'), 有暂存快照说明: t.includes('工作区当前内容') };
  })()
`.replace('%PATH%', JSON.stringify(review?.path ?? '')));
check('已暂存文件可直接选中复核（不必先取消暂存）',
  reviewDetail?.显示该文件 === true && reviewDetail?.标已暂存 === true,
  review?.path);
check('如实说明"暂存快照缺失"这一能力边界（不把工作区 diff 冒充暂存 diff）',
  reviewDetail?.有暂存快照说明 === true);

// 取消暂存是独立操作：点第二行的取消，不应改变当前选中
const unstageIndependent = await ev(`
  (() => {
    const sec = [...document.querySelectorAll('.fg-pane-list .git-list-sec')].find(s => s.innerText.includes('已暂存'));
    const rows = [...(sec?.querySelectorAll('.git-list-row') ?? [])];
    if (rows.length < 2) return { skipped: true, 当前选中: document.querySelector('.fg-pane-detail')?.innerText?.includes(%PATH%) };
    const second = rows[1];
    const secondPath = (second.innerText || '').split('\\n')[0].trim();
    const btn = [...second.querySelectorAll('.btn')].find(b => b.textContent.includes('取消暂存'));
    btn.click();
    return { secondPath, 当前仍是第一个: null };
  })()
`.replace('%PATH%', JSON.stringify(review?.path ?? '')));
await sleep(600);
const afterUnstage = await ev(`
  (() => {
    const t = document.querySelector('.fg-pane-detail')?.innerText ?? '';
    return {
      详情仍是原文件: t.includes(%PATH%),
      已暂存条数: (() => {
        const sec = [...document.querySelectorAll('.fg-pane-list .git-list-sec')].find(s => s.innerText.includes('已暂存'));
        return [...(sec?.querySelectorAll('.git-list-row') ?? [])].length;
      })(),
    };
  })()
`.replace('%PATH%', JSON.stringify(review?.path ?? '')));
if (unstageIndependent?.skipped) {
  check('取消暂存是独立操作（不影响正在查看的文件）', afterUnstage?.详情仍是原文件 === true, '暂存区只有 1 条，跳过逐步验证');
} else {
  check('取消暂存是独立操作：取消第二个文件后仍停留在第一个文件的复核',
    afterUnstage?.详情仍是原文件 === true,
    `已取消 ${unstageIndependent?.secondPath}；已暂存剩 ${afterUnstage?.已暂存条数}`);
}
await shot('74-git-staged-review.png');

/* ============================================================
   5. 顶部标签 / 状态条 / 准备提交 不互相遮挡
   ============================================================ */
const occl = await ev(`
  (() => {
    const pick = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { sel, top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const items = ['.thread-tabs', '.fg-statusbar', '.git-prepare'].map(pick).filter(Boolean);
    const overlaps = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const vo = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const ho = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (vo > 2 && ho > 2) overlaps.push(a.sel + ' × ' + b.sel);
      }
    }
    const prep = items.find(x => x.sel === '.git-prepare');
    const sc = document.querySelector('.fg-pane-detail .fg-pane-scroll');
    const sr = sc?.getBoundingClientRect();
    return {
      找到: items.map(x => x.sel),
      overlaps,
      提交区不压正文: prep && sr ? prep.bottom <= sr.top + 2 : null,
    };
  })()
`);
check('顶部标签 / 状态条 / 准备提交三者互不遮挡',
  occl?.overlaps?.length === 0, (occl?.overlaps ?? []).join('，') || occl?.找到?.join(' + '));
check('准备提交不覆盖正文（在正文之上，不在正文之上压着）', occl?.提交区不压正文 === true);

/* ============================================================
   6. 历史：列表滚到底选最后一条 → 详情立刻可见
   ============================================================ */
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('历史')); t&&t.click(); return true; })()`);
await sleep(700);
const lastPick = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    left.scrollTop = left.scrollHeight;
    const rows = [...document.querySelectorAll('.fg-pane-list .git-list-row')];
    const last = rows[rows.length - 1];
    const subject = (last.innerText || '').split('\\n')[0].trim();
    last.click();
    return { subject, 总条数: rows.length, 左滚动: left.scrollTop };
  })()
`);
await sleep(700);
const lastVisible = await ev(`
  (() => {
    const pane = document.querySelector('.fg-pane-detail');
    const r = pane?.getBoundingClientRect();
    const t = pane?.innerText ?? '';
    const page = document.querySelector('.page');
    return {
      在视口内: !!r && r.top >= 0 && r.top < window.innerHeight,
      top: r?.top,
      显示了该提交: t.includes(%S%),
      页面没被滚动: page?.scrollTop === 0,
      详情从顶部开始: document.querySelector('.fg-pane-detail .fg-pane-scroll')?.scrollTop === 0,
    };
  })()
`.replace('%S%', JSON.stringify(lastPick?.subject ?? '')));
check('历史：选中列表最后一条后详情在当前可视区域立刻可见',
  lastVisible?.在视口内 === true && lastVisible?.显示了该提交 === true && lastVisible?.页面没被滚动 === true,
  `${lastPick?.总条数} 条中的最后一条「${lastPick?.subject}」，详情 top=${Math.round(lastVisible?.top ?? -1)}`);
check('历史：选中底部条目后详情从顶部开始（不用先滚到顶部才看到内容）',
  lastVisible?.详情从顶部开始 === true);
await shot('75-git-history-bottom-selected.png');

/* ---------- 6b. 分支 / 远端：底部选中同样立刻可见 ---------- */
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('分支')); t&&t.click(); return true; })()`);
await sleep(700);
const brPick = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    left.scrollTop = left.scrollHeight;
    const rows = [...document.querySelectorAll('.fg-pane-list .git-list-row')];
    const last = rows[rows.length - 1];
    const name = (last.innerText || '').split('\\n')[0].trim();
    last.click();
    return { name };
  })()
`);
await sleep(700);
const brVisible = await ev(`
  (() => {
    const pane = document.querySelector('.fg-pane-detail');
    const r = pane?.getBoundingClientRect();
    return {
      在视口内: !!r && r.top >= 0 && r.top < window.innerHeight,
      显示了该项: (pane?.innerText ?? '').includes(%N%),
      页面没被滚动: document.querySelector('.page')?.scrollTop === 0,
    };
  })()
`.replace('%N%', JSON.stringify(brPick?.name ?? '')));
check('分支与远端：选中列表最后一项后详情立刻可见',
  brVisible?.在视口内 === true && brVisible?.显示了该项 === true && brVisible?.页面没被滚动 === true,
  brPick?.name);
await shot('76-git-branches-bottom-selected.png');

/* ============================================================
   7. 三档尺寸：1480×940 / 1280×800 / 窄窗口分步
   ============================================================ */
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('工作区')); t&&t.click(); return true; })()`);
await sleep(600);

const size1480 = await ev(`
  (() => {
    const l = document.querySelector('.fg-pane-list')?.getBoundingClientRect();
    const r = document.querySelector('.fg-pane-detail')?.getBoundingClientRect();
    return { 两栏并排: !!l && !!r && r.left >= l.right - 1, 左宽: Math.round(l?.width ?? 0), 右宽: Math.round(r?.width ?? 0) };
  })()
`);
check('1480×940：仍是可用两栏（详情在右侧，不在列表下方）',
  size1480?.两栏并排 === true && size1480?.右宽 > 400, `左 ${size1480?.左宽} / 右 ${size1480?.右宽}`);
await shot('77-size-1480x940.png');

await viewport(1280, 800);
await sleep(400);
const size1280 = await ev(`
  (() => {
    const l = document.querySelector('.fg-pane-list')?.getBoundingClientRect();
    const r = document.querySelector('.fg-pane-detail')?.getBoundingClientRect();
    return { 两栏并排: !!l && !!r && r.left >= l.right - 1, 左宽: Math.round(l?.width ?? 0), 右宽: Math.round(r?.width ?? 0) };
  })()
`);
check('1280×800：两栏仍然并排可用（不被挤成上下堆叠）',
  size1280?.两栏并排 === true && size1280?.右宽 > 300, `左 ${size1280?.左宽} / 右 ${size1280?.右宽}`);
await shot('78-size-1280x800.png');

// 窄窗口：分步显示（列表 → 详情 → 返回列表），保留选中与列表位置
await viewport(1000, 760);
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('历史')); t&&t.click(); return true; })()`);
await sleep(700);
const narrow0 = await ev(`
  (() => {
    const body = document.querySelector('.fg-body.narrow, .git-layout.narrow');
    const list = document.querySelector('.fg-pane-list');
    const detail = document.querySelector('.fg-pane-detail');
    const hidden = (el) => !el || el.getBoundingClientRect().height === 0;
    return {
      触发窄模式: !!body,
      pane: body?.getAttribute('data-pane'),
      列表可见: !hidden(list),
      详情隐藏: hidden(detail),
    };
  })()
`);
check('窄窗口：进入分步模式，先显示列表（不把长列表堆在详情上方）',
  narrow0?.触发窄模式 === true && narrow0?.pane === 'list' && narrow0?.列表可见 === true && narrow0?.详情隐藏 === true,
  `data-pane=${narrow0?.pane}`);

const narrowPick = await ev(`
  (() => {
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    left.scrollTop = 300;
    const rows = [...document.querySelectorAll('.fg-pane-list .git-list-row')];
    const r = rows.find(x => x.innerText.trim().length > 0);
    const subject = (r.innerText || '').split('\\n')[0].trim();
    r.click();
    return { subject, 滚动位置: left.scrollTop };
  })()
`);
await sleep(700);
const narrow1 = await ev(`
  (() => {
    const body = document.querySelector('.fg-body.narrow, .git-layout.narrow');
    const list = document.querySelector('.fg-pane-list');
    const detail = document.querySelector('.fg-pane-detail');
    const hidden = (el) => !el || el.getBoundingClientRect().height === 0;
    return {
      pane: body?.getAttribute('data-pane'),
      列表隐藏: hidden(list),
      详情可见: !hidden(detail),
      有返回列表: [...document.querySelectorAll('.btn')].some(b => b.textContent.includes('返回列表')),
      显示了该项: (detail?.innerText ?? '').includes(%S%),
    };
  })()
`.replace('%S%', JSON.stringify(narrowPick?.subject ?? '')));
check('窄窗口：选中后进入详情，且保留原选中项',
  narrow1?.pane === 'detail' && narrow1?.详情可见 === true && narrow1?.显示了该项 === true,
  narrowPick?.subject);
check('窄窗口：详情里有明确的「返回列表」入口', narrow1?.有返回列表 === true);
await shot('79-narrow-detail.png');

const narrowBack = await ev(`
  (() => {
    const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('返回列表'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(700);
const narrow2 = await ev(`
  (() => {
    const body = document.querySelector('.fg-body.narrow, .git-layout.narrow');
    const left = document.querySelector('.fg-pane-list .fg-pane-scroll');
    return { pane: body?.getAttribute('data-pane'), 滚动位置: left?.scrollTop };
  })()
`);
check('窄窗口：返回列表后列表滚动位置被还原',
  narrowBack === true && narrow2?.pane === 'list' && Math.abs((narrow2?.滚动位置 ?? 0) - 300) <= 4,
  `回到 ${narrow2?.滚动位置}（进入前 300）`);
await shot('80-narrow-back-to-list.png');

await viewportOff();
await send('Browser.setWindowBounds', { windowId: 1, bounds: {} }).catch(() => {});

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
