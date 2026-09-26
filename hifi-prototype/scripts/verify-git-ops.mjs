/**
 * 验证：Git 页的写操作真的改变了状态（不只是渲染）。
 * 用 CDP 真实点击，覆盖：提交、冲突解决、撤销提交、切换分支、agent 提交审阅。
 */
const PORT = '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let id = 0;
let p = new Map();

async function reconnect() {
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

await reconnect();

const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => { p.delete(i); res({}); }, 10000);
    p.set(i, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

await ev(`window.zhongshuo?.window.show()`);

/**
 * 每次操作前回到干净状态。
 * store 是内存态，**整页 reload 即回到种子**（原型设计如此），
 * 比去点"重置原型数据"菜单可靠：那个入口在头像菜单里，且要处理两层浮层。
 */
async function freshGit() {
  await send('Page.enable');
  // 第十五批：导航偏好持久化在 localStorage，reload 清不掉，必须显式移除，
  // 否则上一轮切过的当前项目会带到下一轮（表现为断言读到另一个项目的 Git 状态）。
  await ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); true`);
  await send('Page.reload', { ignoreCache: true });
  // reload 让当前 CDP 会话失效，重连
  await reconnect();
  await ev(`window.zhongshuo?.window.show()`);
  await sleep(2200);
  // 第十五批：Git 并入「文件与 Git」合页，用显式 tab 进入（不是靠旧路由重定向，
  // 避免"重定向还没落定"导致断言读到上一个页面）
  await ev(`window.location.hash='/project/proj_zs_01/files?tab=git'; true`);
  await sleep(1800);
  // 关掉可能弹出的启动恢复模态
  await ev(`
    (() => {
      const m = document.querySelector('.modal');
      if (!m) return false;
      const b = [...m.querySelectorAll('.btn')].find(x => /稍后处理|关闭|取消/.test(x.textContent));
      if (b) b.click();
      return !!b;
    })()
  `);
  await sleep(400);
}

const clickBtn = (text) =>
  ev(`(() => { const b=[...document.querySelectorAll('.btn')].find(x=>x.textContent.includes(${JSON.stringify(text)})); if(b){b.click(); return true;} return false; })()`);

await freshGit();

/* ---------- 0. 冲突必须先解决：未解决时不允许提交（与真实 git 一致） ---------- */
const blockedCommit = await ev(`
  (() => {
    const b = [...document.querySelectorAll('.page .btn')].find(x => x.textContent.trim() === '提交');
    return { disabled: b?.disabled, title: b?.title };
  })()
`);
check('有未解决冲突时提交被禁用',
  blockedCommit?.disabled === true,
  `title=${blockedCommit?.title}`);

/* ---------- 1. 解决冲突（必须逐个，不给一键覆盖） ---------- */
const conflictModal = await ev(`
  (() => {
    const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('查看三方内容'));
    if (b) { b.click(); return true; }
    return false;
  })()
`);
await sleep(600);
const conflictUI = await ev(`
  (() => {
    const m = document.querySelector('.modal');
    if (!m) return { open: false };
    const t = m.innerText;
    // 断言用"按钮"而不是全文：正文里有一句"这里不提供「全部保留我的」按钮"的说明，
    // 用全文正则会误命中这句免责声明本身。
    const btns = [...m.querySelectorAll('.btn')].map(b => b.textContent.trim());
    return {
      open: true,
      有base: t.includes('共同祖先'),
      有ours: t.includes('我的版本'),
      有theirs: t.includes('对方版本'),
      按钮列表: btns,
      无整文件覆盖按钮: !btns.some(b => /全部保留我的|全部采用对方|一键/.test(b)),
    };
  })()
`);
check('冲突弹窗打开', conflictModal === true && conflictUI?.open === true);
check('冲突三方内容都展示（base/ours/theirs）',
  conflictUI?.有base && conflictUI?.有ours && conflictUI?.有theirs);
check('§14.2 不提供整文件「一键覆盖」按钮',
  conflictUI?.无整文件覆盖按钮 === true,
  (conflictUI?.按钮列表 ?? []).join(' / '));

// 用"我的版本"填充后解决
await ev(`
  (() => {
    const m = document.querySelector('.modal');
    const b = [...m.querySelectorAll('.btn')].find(x => x.textContent.includes('用这个'));
    if (b) b.click();
    return true;
  })()
`);
await sleep(300);
await clickBtn('用编辑后的内容解决');
await sleep(700);
const afterResolve = await ev(`
  (() => {
    const t = document.querySelector('.page').innerText;
    return { 冲突消失: !t.includes('冲突未解决'), 进入暂存: t.includes('已暂存') };
  })()
`);
check('冲突解决后从冲突区消失', afterResolve?.冲突消失 === true);
check('解决后的内容进入暂存区', afterResolve?.进入暂存 === true);

/* ---------- 2. 暂存 + 提交 ---------- */
await clickBtn('暂存本任务改动');
await sleep(600);
const staged = await ev(`(() => { const t=document.querySelector('.page').innerText; return { has: t.includes('将提交'), } })()`);
check('批量暂存后可以提交', staged?.has === true);

// 输入提交信息
await ev(`
  (() => {
    const ta = document.querySelector('.git-commit-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'fix(scripts): 收敛中文路径解析');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(300);
const beforeCommits = await ev(`document.querySelectorAll('.page .card').length`);
await clickBtn('提交');
await sleep(700);
const afterCommit = await ev(`
  (() => {
    const t = document.querySelector('.page').innerText;
    return {
      暂存区空了: t.includes('暂存区是空的'),
      /* 2026-09-26：暂存区为空时「准备提交」收成一行短提示，
         不再留一个大 textarea 占着右栏阅读区 —— 所以此刻不该有输入框。 */
      表单已收起: !document.querySelector('.git-commit-input'),
      有提交入口: [...document.querySelectorAll('.git-prepare .btn')].some(b => b.textContent.trim() === '提交'),
    };
  })()
`);
check('提交后暂存区清空', afterCommit?.暂存区空了 === true);
check('暂存区为空时准备提交收成短提示（不留大 textarea）', afterCommit?.表单已收起 === true);
check('准备提交收起后提交入口仍然可达', afterCommit?.有提交入口 === true);

/*
 * 「提交信息被清空」这条断言**不能删**（它验证的是提交后草稿不残留）。
 * 但表单此时是收起的，读不到 textarea —— 所以重新暂存一个文件把表单展开回来，
 * 再读它的 value：为空才说明草稿真的被清掉了。
 */
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.git-detail .btn')].find(x => x.textContent.trim() === '暂存');
    if (b) { b.click(); return true; }
    return false;
  })()
`);
await sleep(600);
const draftCleared = await ev(`
  (() => {
    const ta = document.querySelector('.git-commit-input');
    return { 表单回来了: !!ta, 提交信息清空: ta?.value === '' };
  })()
`);
check('提交后提交信息被清空（草稿不残留）',
  draftCleared?.表单回来了 === true && draftCleared?.提交信息清空 === true,
  `value=${JSON.stringify(draftCleared?.提交信息清空)}`);

// 历史里应出现新提交
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('历史')); t&&t.click(); return true; })()`);
await sleep(700);
const newCommit = await ev(`document.querySelector('.page').innerText.includes('收敛中文路径解析')`);
check('新提交出现在历史里', newCommit === true);

/* ---------- 2. §14.5 撤销提交是软回退（内容回工作区） ---------- */
await clickBtn('撤销最近一次提交');
await sleep(700);
const afterUndo = await ev(`
  (() => {
    const t = document.querySelector('.page').innerText;
    return {
      软回退提示: t.includes('软回退') || t.includes('内容保留在工作区'),
      reflog出现reset: t.includes('reset(soft)'),
    };
  })()
`);
check('撤销提交后 reflog 记录软回退', afterUndo?.reflog出现reset === true);
// 回到工作区，内容应该还在
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('工作区')); t&&t.click(); return true; })()`);
await sleep(700);
const worktreeAfterUndo = await ev(`
  (() => {
    const t = document.querySelector('.page').innerText;
    return { 文件还在: t.includes('scripts/build-report.mjs'), 有暂存: t.includes('已暂存') };
  })()
`);
check('§14.5 撤销后文件回到工作区，没有删除', worktreeAfterUndo?.文件还在 === true);

/* ---------- 4. 切换分支 ---------- */
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('分支')); t&&t.click(); return true; })()`);
await sleep(700);
// 改造后「切换」只在选中非当前分支后的详情里出现（当前分支没有可切换的目标）
await ev(`
  (() => {
    const r = [...document.querySelectorAll('.git-list-row')].find(x => x.innerText.includes('zs/task-12-module-boundaries'));
    if (r) r.click();
    return !!r;
  })()
`);
await sleep(450);
await clickBtn('切换');
await sleep(700);
const afterCheckout = await ev(`
  (() => { const t=document.querySelector('.page').innerText; return { 切走了: t.includes('zs/task-12-module-boundaries') }; })()
`);
check('能切换到其它分支', afterCheckout?.切走了 === true);

/* ---------- 5. 推送：ahead 归零 ---------- */
await freshGit();
// 第十五批：合页模式下 Git 的操作按钮在页内状态条里，不再位于 .page-head-actions
// （页头由合页壳提供）。这里在整页文本里找"推送 (N)"。
const beforePush = await ev(`
  (() => {
    const t = document.querySelector('.page')?.innerText ?? '';
    const m = t.match(/推送\\s*\\((\\d+)\\)/);
    return m ? Number(m[1]) : 0;
  })()
`);
check('推送按钮显示领先提交数', beforePush > 0, `ahead=${beforePush}`);
await clickBtn('推送');
await sleep(800);
const afterPush = await ev(`
  (() => {
    const t = document.querySelector('.page').innerText;
    return {
      已推送提示: t.includes('已推送'),
      先头标签: /与远端一致/.test(t),
    };
  })()
`);
check('推送后提示已推送', afterPush?.已推送提示 === true);
check('推送后与远端一致', afterPush?.先头标签 === true);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} 通过`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
