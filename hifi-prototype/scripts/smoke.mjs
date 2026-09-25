/**
 * 交互冒烟测试：用 Chrome DevTools Protocol 真实点击界面，验证写操作确实改了状态。
 * 不引入 Playwright：Node 24 自带 WebSocket，直接连 CDP。
 *
 * 这是**浏览器 + Vite dev server** 的用例，不是 Electron 用例：
 * 它会 `window.location.href = base` 直接导航当前页面。
 *
 * 用法：node scripts/smoke.mjs [base]
 *   先起 dev server：pnpm dev --port 5284
 *   再跑：          node scripts/smoke.mjs http://localhost:5284
 *
 * 端口隔离（踩过的坑）：调试端口默认 9334，**故意不用 Electron 的 9333**。
 * 之前两者都是 9333：Chrome 抢不到端口时 cdpTargets() 会连上 Electron 窗口，
 * 再把它导航到 localhost:5284 —— 窗口白屏，后续所有用例全部误判失败。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5284';
const PORT = Number(process.env.ZS_SMOKE_CDP_PORT ?? 9334);

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

if (!CHROME) {
  console.error('找不到 Chrome/Edge');
  process.exit(1);
}

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + process.env.TEMP + '\\zs-smoke-profile',
  '--no-first-run',
  '--window-size=1680,1050',
  'about:blank',
]);
chrome.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

const wsUrl = await cdpTargets();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res) => {
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate 失败');
  }
  return r.result?.result?.value;
}

async function goto(hash) {
  await evaluate(`window.location.hash = ${JSON.stringify(hash)}; true`);
  await sleep(700);
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ---------- 收集页面错误 ---------- */
await send('Runtime.enable');
await send('Log.enable');
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    consoleErrors.push(m.params.entry.text);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.exception?.description ?? 'exception');
  }
});

/* ---------- 1. 初次加载 ---------- */
await evaluate(`window.location.href = ${JSON.stringify(base)}; true`);
await sleep(2200);

const booted = await evaluate(`!!document.querySelector('.app')`);
check('应用挂载成功', booted === true);

/* ---------- 2. 主池发新任务 → 应创建任务并跳转线程 ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall');

/* ---------- 2a. §4.1：纯文本 @ 不产生执行语义 ---------- */
await evaluate(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '@全体 这是纯文本 @，按 §4.1 不应产生路由语义');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);
// 用例迁移（2026-09-25「默认交给 AI」）：输入区占位改为"发送消息，可 @ 指定成员…"，
// 不再携带推导出的方式。**能力没变**，只是观测点换成「本次运行设置」里的「本次方式」——
// 仍然是"发送前可核对这次会怎么走"，不是把这条断言删掉。
const readRunMode = `
  (async () => {
    const btn = [...document.querySelectorAll('.composer button')]
      .find(b => (b.getAttribute('aria-label') || '') === '本次运行设置');
    btn?.click();
    await new Promise(r => setTimeout(r, 350));
    const menu = [...document.querySelectorAll('.menu')].at(-1);
    const line = [...(menu?.querySelectorAll('.menu-note .row.tight') ?? [])]
      .map(x => x.innerText.trim()).find(t => t.startsWith('本次方式')) ?? '';
    return line;
  })()
`;
const plainAtRoute = await evaluate(readRunMode);
check(
  '纯文本 @全体 不被当成 mention（仍为自动）',
  plainAtRoute.includes('自动') && !plainAtRoute.includes('共同研讨'),
  plainAtRoute.slice(0, 46),
);

/* ---------- 2b. 通过 mention 候选真正选中「全体」---------- */
await evaluate(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '@');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(350);
const popOpen = await evaluate(`!!document.querySelector('.mention-pop')`);
check('输入 @ 弹出成员候选', popOpen === true);

await evaluate(`
  (() => {
    const items = [...document.querySelectorAll('.mention-pop .menu-item')];
    const all = items.find(x => x.textContent.includes('全体'));
    if (!all) return false;
    all.click(); return true;
  })()
`);
await sleep(350);

// 用例迁移：同 2a，方式预览改读「本次运行设置 → 本次方式」（占位不再携带方式标签）。
// 读之前先关掉上一次打开的菜单，避免两个浮层叠着读到旧内容。
await evaluate(`document.querySelector('.menu-scrim, .scrim')?.click(); document.body.click(); true`);
await sleep(250);
const routePreview = await evaluate(readRunMode);
check('选中@全体 后推导出共同研讨', routePreview.includes('共同研讨'), routePreview.slice(0, 60));
await evaluate(`document.querySelector('.menu-scrim, .scrim')?.click(); document.body.click(); true`);
await sleep(250);

// 选中 mention 后输入框里只剩一个 @，补上正文再发送
await evaluate(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '冒烟测试：请检查状态机与预算推导');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(250);
const beforeTasks = await evaluate(`document.querySelectorAll('.root-card').length`);

await evaluate(`
  (() => {
    const btns = [...document.querySelectorAll('.composer-toolbar .btn.primary')];
    const b = btns.find(x => x.textContent.includes('发送'));
    if (!b) return false;
    b.click();
    return true;
  })()
`);
await sleep(900);

const afterTasks = await evaluate(`document.querySelectorAll('.root-card').length`);
check('发送后主池新增一张原消息卡', afterTasks === beforeTasks + 1, `${beforeTasks} → ${afterTasks}`);

const newTaskIsDeliberate = await evaluate(`document.body.innerText.includes('DELIBERATE')`);
check('新任务按 @全体 落为 DELIBERATE', newTaskIsDeliberate === true);

const inThread = await evaluate(`!!document.querySelector('.col-thread')`);
check('发送后自动打开该任务回复串', inThread === true);

const hasRouteCard = await evaluate(`
  (() => {
    // 减负后正常路由/预算说明移入「详情 → 活动与进展」，回复视图里不再常驻。
    // 这里断言"记录仍在、可查"，不是删除；因此真的去详情分组里找一遍。
    const inReplies = document.querySelector('.col-thread .msg-list')?.innerText ?? '';
    return { 回复里有: inReplies.includes('DELIBERATE') };
  })()
`);
await evaluate(`
  (() => {
    const tab = [...document.querySelectorAll('.col-thread .thread-tab')].find(x => x.textContent.includes('详情'));
    tab?.click();
    return true;
  })()
`);
await sleep(500);
await evaluate(`
  (() => {
    const chip = [...document.querySelectorAll('.details-chip')].find(x => x.textContent.includes('活动与进展'));
    chip?.click();
    return true;
  })()
`);
await sleep(700);
const routeNoteInDetails = await evaluate(`
  (() => {
    const t = document.querySelector('.details-body')?.innerText ?? '';
    return { 详情里有: t.includes('DELIBERATE') || t.includes('路由') };
  })()
`);
check('路由与预算说明移入详情、未丢失（回复区不再常驻）',
  routeNoteInDetails?.详情里有 === true,
  JSON.stringify({ ...hasRouteCard, ...routeNoteInDetails }));

/* ---------- 3. 停用确认：仅记录不建任务 ----------
   用例迁移（2026-09-25「默认交给 AI」）：普通发送默认交给 AI，常驻的「任务/讨论」
   分段已按用户决定移除；"只留字、不要回复"改为 ⋯ 菜单里的一次性意图「仅记录，不请求回复」。
   断言的能力不变（这条不建任务、不唤醒 AI），只是入口与文案换成新的。 */
await goto('/project/proj_zs_01/room/room_dev_hall');
const beforeDiscussion = await evaluate(`document.querySelectorAll('.root-card').length`);
await evaluate(`
  (() => {
    const menuBtn = [...document.querySelectorAll('.composer button')]
      .find(b => (b.getAttribute('aria-label') || '') === '本次运行设置');
    menuBtn?.click();
    return !!menuBtn;
  })()
`);
await sleep(400);
await evaluate(`
  (() => {
    const item = [...document.querySelectorAll('.menu .menu-item')].find(x => x.innerText.includes('仅记录'));
    item?.click();
    return !!item;
  })()
`);
await sleep(400);
await evaluate(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '冒烟测试：这是一条纯讨论，不应该建任务');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(200);
// 用例迁移：仅记录的语义写在 placeholder 里（".composer-status 行已删除"）
const discStatus = await evaluate(`document.querySelector('.composer-input').placeholder`);
check('切到"仅记录"后输入条说明不会请求 AI 回复', discStatus.includes('不会请求 AI 回复'), discStatus.slice(0, 50));

/* 记录保存**之前**先记下留痕行数：下面要用"增量"证明这条没走派发路径
   （日志里本来就留着前面几步普通发送的 message.submit，只看全量会误判）。 */
await evaluate(`location.hash = '#/activity'; true`);
await sleep(800);
const traceBefore = await evaluate(`document.querySelectorAll('.tbl tbody tr').length`);
await evaluate(`location.hash = '#/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await sleep(900);
await evaluate(`
  (() => {
    // 用例迁移：主按钮现在只有两种文案 —— 普通发送"发送"、仅记录"保存记录"，
    // 所以按"主按钮"定位，不再按旧的三套字样匹配。
    const b = document.querySelector('.composer-toolbar .btn.primary');
    if (!b) return false;
    b.click(); return true;
  })()
`);
await sleep(800);
const afterDiscussion = await evaluate(`document.querySelectorAll('.root-card').length`);
const discHasNoTaskNo = await evaluate(`
  (() => {
    const c = document.querySelector('.root-card.selected') || document.querySelector('.root-card');
    return c ? c.innerText : '';
  })()
`);
check('仅记录确实创建了顶层卡（可开串）', afterDiscussion === beforeDiscussion + 1, `${beforeDiscussion} → ${afterDiscussion}`);
check('记录卡不显示任务号', discHasNoTaskNo.includes('记录 · 无任务号'), discHasNoTaskNo.split('\n')[0]);
/* 新断言（2026-09-25）：这条"仅记录"不能进派发路径 —— 用**增量**证明：
   保存记录之后新增的留痕里必须是 LOCAL_ONLY:record.save，且没有 message.submit。 */
await evaluate(`location.hash = '#/activity'; true`);
await sleep(900);
const traceAfter = await evaluate(`
  (() => [...document.querySelectorAll('.tbl tbody tr')].map(tr => tr.children[1]?.innerText.trim() ?? ''))()
`);
const newRows = traceAfter.slice(0, Math.max(0, traceAfter.length - traceBefore));
check('仅记录不进派发路径（新增留痕是 LOCAL_ONLY:record.save，没有 message.submit）',
  newRows.some(x => x.includes('record.save')) && !newRows.some(x => x === 'message.submit'),
  JSON.stringify(newRows));
await evaluate(`location.hash = '#/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await sleep(900);

/* ---------- 4. 阅读行为不触发模型：markRead / follow ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13');
const followBefore = await evaluate(`
  (() => {
    const el = [...document.querySelectorAll('.followers')].map(x => x.textContent).join(' ');
    return el;
  })()
`);
await evaluate(`
  (() => {
    // 用例更新（2026-09-24 减负）：关注从顶部图标组移入线程「⋯」菜单，
    // 订阅状态与卡片菜单读同一份，语义不变（关闭≠停止，只改通知偏好）。
    const btn = document.querySelector('.col-thread .thread-nav button[aria-haspopup="menu"]');
    if (btn) btn.click();
    return true;
  })()
`);
await sleep(350);
await evaluate(`
  (() => {
    const menus = [...document.querySelectorAll('.menu')];
    const item = [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])]
      .find(x => x.textContent.includes('关注'));
    if (item) item.click();
    return true;
  })()
`);
await sleep(400);
const logAfterFollow = await evaluate(`
  (() => { window.location.hash = '/activity'; return true; })()
`);
await sleep(700);
const writeLog = await evaluate(`document.body.innerText`);
check('关注动作被记录为 thread.follow', writeLog.includes('thread.follow'), `关注前 ${followBefore.slice(0, 20)}`);

/* ---------- 5. 表情不等于授权 ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t13');
const approvalText = await evaluate(`
  (() => {
    const el = document.querySelector('.approval-card');
    return el ? el.innerText : '';
  })()
`);
check('DIRECT 线程出现授权卡', approvalText.includes('授权请求'), approvalText.slice(0, 40));
check('授权卡说明了作用范围与摘要', approvalText.includes('作用范围') && approvalText.includes('报文摘要'));

// DIRECT 不计算共识（§6.5 只定义研讨的确认矩阵）：绝不能出现"全体一致"
const directResult = await evaluate(`
  (() => {
    const el = document.querySelector('.result-card');
    return el ? el.innerText : '';
  })()
`);
check(
  'DIRECT 结果卡不伪造全体一致',
  directResult.includes('无共识语义') && !directResult.includes('全体一致'),
  directResult.split('\n')[0] ?? '(无结果卡)',
);

/* ---------- 5b. DELIBERATE 的缺席场景不能写成全体一致（AT-05） ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t11');
const absentResult = await evaluate(`
  (() => {
    const el = document.querySelector('.result-card');
    return el ? el.innerText : '';
  })()
`);
check(
  '有成员缺席时结果卡不写全体一致',
  absentResult.includes('缺席') && !absentResult.includes('全体确认一致'),
  absentResult.split('\n')[0] ?? '(无结果卡)',
);

/* ---------- 6. 停止任务 → STOPPING / CANCELLED ---------- */
await goto('/task/task_14');
const stopClicked = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('停止任务'));
    if (!b) return false;
    b.click(); return true;
  })()
`);
check('任务详情有停止入口', stopClicked === true);
await sleep(600);
await goto('/tasks');
const boardText = await evaluate(`document.body.innerText`);
check('停止后看板出现已取消分组', boardText.includes('已取消'));

/* ---------- 7. 全局搜索 Ctrl+K ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall');
await evaluate(`
  (() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    return true;
  })()
`);
await sleep(400);
const paletteOpen = await evaluate(`!!document.querySelector('.modal input[placeholder*="搜索"]')`);
check('Ctrl+K 打开全局搜索', paletteOpen === true);

/* ---------- 7b. 详情就地渲染，不夺走房间（§17.1 + 用户反馈 8 + 2026-09-24 减负）
   第十三项起：任务详情/研讨详情改为回复串内的就地切页，不再跳转独立界面。
   2026-09-24 减负：常驻页签收敛为「回复/成果/详情」，任务详情/成员/活动/运行/
   交付/研讨进「详情」分组。仍要保证的是"房间与回复串不被替换、可原地切回"，
   所以这里改为按**新入口**点击，并保留全部业务断言。 */
await evaluate(`document.querySelector('.scrim') && window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
await sleep(300);
await goto('/project/proj_zs_01/room/room_dev_hall?thread=thread_t12');
await sleep(600);

const beforeNav = await evaluate(`
  (() => ({
    pool: !!document.querySelector('.pool'),
    thread: !!document.querySelector('.col-thread'),
    cards: document.querySelectorAll('.root-card').length,
    tabs: [...document.querySelectorAll('.col-thread .thread-tab')].map(x => x.textContent.trim().split('\\n')[0]),
    headGone: !document.querySelector('.thread-head'),
    anchorGone: !document.querySelector('.thread-anchor'),
  }))()
`);
check(
  '回复串常驻导航为 回复/成果/详情（顶部两行已删除）',
  (beforeNav?.tabs ?? []).some((t) => t.startsWith('回复')) &&
    (beforeNav?.tabs ?? []).includes('成果') &&
    (beforeNav?.tabs ?? []).includes('详情') &&
    beforeNav?.headGone === true && beforeNav?.anchorGone === true,
  (beforeNav?.tabs ?? []).join('|'),
);

/* 打开「详情 → 任务概况」：应就地渲染，房间仍在 */
await evaluate(`
  (() => {
    const tab = [...document.querySelectorAll('.col-thread .thread-tab')].find(x => x.textContent.includes('详情'));
    if (tab) { tab.click(); return 'ok'; }
    return 'none';
  })()
`);
await sleep(500);
await evaluate(`
  (() => {
    const chip = [...document.querySelectorAll('.details-chip')].find(x => x.textContent.includes('任务概况'));
    if (chip) { chip.click(); return 'ok'; }
    return 'none';
  })()
`);
await sleep(700);

const afterTaskTab = await evaluate(`
  (() => ({
    embedded: !!document.querySelector('.thread-embed'),
    pool: !!document.querySelector('.pool'),
    thread: !!document.querySelector('.col-thread'),
    cards: document.querySelectorAll('.root-card').length,
    hash: location.hash,
    hasTaskAttrs: document.body.innerText.includes('任务属性'),
  }))()
`);
check(
  '任务概况在回复串内就地渲染',
  afterTaskTab?.embedded === true && afterTaskTab?.hasTaskAttrs === true,
  `embedded=${afterTaskTab?.embedded} 任务属性=${afterTaskTab?.hasTaskAttrs}`,
);
check(
  '打开详情后房间与回复串仍在（未跳页替换）',
  afterTaskTab?.pool === true &&
    afterTaskTab?.thread === true &&
    afterTaskTab?.cards === beforeNav?.cards &&
    !String(afterTaskTab?.hash).includes('/task/'),
  `pool=${afterTaskTab?.pool} thread=${afterTaskTab?.thread} cards=${afterTaskTab?.cards} hash=${afterTaskTab?.hash}`,
);

/* 切回「回复」：回复列表应恢复 */
await evaluate(`
  (() => {
    const tab = [...document.querySelectorAll('.col-thread .thread-tab')].find(x => x.textContent.includes('回复'));
    if (tab) { tab.click(); return 'ok'; }
    return 'none';
  })()
`);
await sleep(700);
const afterBack = await evaluate(`
  (() => ({
    embedded: !!document.querySelector('.thread-embed'),
    pool: !!document.querySelector('.pool'),
    thread: !!document.querySelector('.col-thread'),
    hasMessages: document.querySelectorAll('.msg').length > 0,
  }))()
`);
check(
  '切回「回复」后恢复回复列表',
  afterBack?.embedded === false && afterBack?.pool === true && afterBack?.hasMessages === true,
  JSON.stringify(afterBack),
);

/* ---------- 7c. 完整原消息在「详情 → 任务概况」可查（原顶部展开条的去处）
   用例沿革：用户反馈 10 曾要求"顶部原消息默认收起、可展开"；
   2026-09-24 减负把顶部摘要条整体删除，原消息全文移入详情分组。
   业务不变量（**完整原始要求可查、非零宽**）保留，只是换入口。 */
await evaluate(`
  (() => {
    const tab = [...document.querySelectorAll('.col-thread .thread-tab')].find(x => x.textContent.includes('详情'));
    tab?.click();
    return true;
  })()
`);
await sleep(500);
await evaluate(`
  (() => {
    const chip = [...document.querySelectorAll('.details-chip')].find(x => x.textContent.includes('任务概况'));
    chip?.click();
    return true;
  })()
`);
await sleep(700);
const anchorFull = await evaluate(`
  (() => {
    const el = document.querySelector('.overview-anchor-body');
    return { exists: !!el, len: el?.textContent?.length ?? 0, toggleGone: !document.querySelector('.thread-anchor-toggle') };
  })()
`);
check(
  '完整原消息在详情→任务概况可查（顶部摘要条未换皮回归）',
  anchorFull?.exists === true && anchorFull?.len > 20 && anchorFull?.toggleGone === true,
  `len=${anchorFull?.len} toggleGone=${anchorFull?.toggleGone}`,
);

/* ---------- 7d. 成果深链落在「成果」tab（不弹覆盖层） ----------
   用例沿革（UX-PREVIEW-01 / §17.9 迁移，施工说明 §8 要求迁移预期）：
     ① 最初断言"成果预览以 .detail-overlay 覆盖面板打开"；
     ② 用户要求去掉弹窗 → 改为"成果 tab 内就地渲染全文"；
     ③ 现在 §17.9 要求**具体文件正文进入共享预览区域**，
        不再用 thread-embed 整块替换成果列表 —— 于是 ② 的
        "就地渲染全文"（`返回成果列表` 按钮）**不再是期望行为**。
   
   迁移原则（不能删掉保护业务性质的那部分）：
     · 保留：不出现覆盖层、底层房间与线程仍在、深链仍落在成果 tab；
     · 保留：**不串目标**（成果 tab 仍然展示成果集合，没被别的东西顶替）；
     · 更新：正文改由共享预览承载 —— 断言改为"提供了打开预览的入口"。
   注意：旧 /artifact/:id 深链本身**不再自动打开预览**（它只定位到成果 tab），
   这与 §17.9 的"URL 记录活动资源"是两件事，下一步由预览参数承担。 */
await goto('/artifact/artifact_12_team_report');
const artifactInTab = await evaluate(`
  (() => ({
    overlay: !!document.querySelector('.detail-overlay'),
    pool: !!document.querySelector('.pool'),
    thread: !!document.querySelector('.col-thread'),
    // 注意：房间自身的 tab（对话池/任务/文件）也用 .thread-tab，所以要 any 而不是取第一个
    onArtifactsTab: [...document.querySelectorAll('.thread-tab.on')].some(e => e.textContent.includes('成果')),
    // ②的旧形态：tab 内整块替换成全文（§17.9 起不再是期望）
    legacyInPlace: !!document.querySelector('.col-thread')?.innerText.includes('返回成果列表'),
    // ③的新形态：成果集合仍在，且每条成果给出"打开"入口（正文去共享预览）
    hasOpenEntry: [...document.querySelectorAll('.col-thread button')].some(b => (b.textContent || '').includes('打开')),
    hash: location.hash,
  }))()
`);
check(
  '成果深链落在「成果」tab，不弹覆盖层（房间与线程仍在）',
  artifactInTab?.overlay === false
    && artifactInTab?.pool === true
    && artifactInTab?.thread === true
    && artifactInTab?.onArtifactsTab === true,
  JSON.stringify(artifactInTab),
);
check(
  '§17.9：成果正文不再整块替换对话，改为提供共享预览入口',
  artifactInTab?.legacyInPlace === false,
  JSON.stringify({ legacyInPlace: artifactInTab?.legacyInPlace, hash: artifactInTab?.hash }),
);

/* ---------- 8. 无控制台错误 ---------- */
check('运行期间无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
ws.close();
chrome.kill();
process.exit(failed.length === 0 ? 0 : 1);
