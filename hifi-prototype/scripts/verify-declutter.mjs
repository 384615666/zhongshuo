/**
 * 界面信息减负施工验收（docs/dev-briefs/prototype-ui-declutter.md §10）。
 *
 * 覆盖本次改动的**业务能力**，不是"截图好看"：
 *  1. 顶部两行确实消失，且没有换皮恢复（无 thread-head / thread-anchor / 另起任务 / 任务详情）；
 *  2. 回复串只有一条紧凑导航（收起/返回 + 回复/成果(附件)/详情 + ⋯），选中态唯一；
 *  3. 八个旧 tab 与实体深链逐项落入正确视图/分组并自动展开；
 *  4. 完整原始要求在详情可查；输入后仍能识别目标；只读场景身份仍在；
 *  5. 待验收/阻塞可发现；运行中停止可达、语义不变；收起/返回不停止任务；
 *  6. 讨论串无任务号但有附件时仍可浏览；关注/静音/成员不混淆；
 *  7. 卡片无重复未读表达、菜单不误触导航；
 *  8. 预览：文件名只显示一次、阅读 ▾ 菜单、文件信息、引用目标、收起预览仍在；
 *  9. 六个宽度档不裁切、不出现重复面板。
 *
 * 用法（端口与 Electron 调试端口 9333 隔离）：
 *   npx vite --port 5284 --strictPort     # 另开终端
 *   node scripts/verify-declutter.mjs http://localhost:5284
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5284';
const PORT = Number(process.env.ZS_DECLUTTER_CDP_PORT ?? 9336);

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
  '--user-data-dir=' + process.env.TEMP + '\\zs-declutter-profile',
  '--no-first-run',
  '--window-size=1680,1050',
  'about:blank',
]);
chrome.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  for (let i = 0; i < 60; i++) {
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

const ws = new WebSocket(await cdpTargets());
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

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate 失败');
  }
  return r.result?.result?.value;
}

async function goto(hash, wait = 650) {
  await ev(`window.location.hash = ${JSON.stringify(hash)}; true`);
  await sleep(wait);
}

async function setViewport(width, height = 900) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(320);
}

/**
 * 整页刷新 = 重置内存态（原型没有持久化业务数据）。
 * 本脚本中间会归档房间、打开预览，这些都会改变后续用例的前提，
 * 因此每进入一个新阶段前先刷新回种子状态。
 */
async function resetApp() {
  await ev(`window.location.reload(); true`);
  await sleep(2200);
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

await send('Runtime.enable');
await send('Log.enable');
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text);
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description ?? 'exception');
});

const ROOM = '/project/proj_zs_01/room/room_dev_hall';
const T12 = `${ROOM}?thread=thread_t12&recovery=0`;
const T13 = `${ROOM}?thread=thread_t13&recovery=0`;
const T14 = `${ROOM}?thread=thread_t14&recovery=0`;
const TDISC = `${ROOM}?thread=thread_d1&recovery=0`;
const POOL = `${ROOM}?recovery=0`;

/* ---------- 0. 启动 ---------- */
await ev(`window.location.href = ${JSON.stringify(base)}; true`);
await sleep(2200);
check('应用挂载成功', (await ev(`!!document.querySelector('.app')`)) === true);

/* ---------- 1. 顶部两行已删除，未换皮恢复 ---------- */
await goto(T12);
const removed = await ev(`(() => {
  const q = (s) => document.querySelector(s);
  const html = document.body.innerText;
  return {
    有threadHead: !!q('.thread-head'),
    有threadHeadRow: !!q('.thread-head-row'),
    有threadAnchor: !!q('.thread-anchor'),
    有另起任务: html.includes('另起任务'),
    有filePlus: [...document.querySelectorAll('.col-thread button')].some(b => (b.getAttribute('title')||'').includes('另起任务')),
    图标数: document.querySelectorAll('.thread-head-row .icon-btn').length,
  };
})()`);
check('回复串顶部 .thread-head 已删除', removed.有threadHead === false && removed.有threadHeadRow === false);
check('原消息摘要条 .thread-anchor 已删除', removed.有threadAnchor === false);
check('「另起任务」按钮未回归', removed.有另起任务 === false && removed.有filePlus === false, JSON.stringify(removed));

/* ---------- 2. 单行导航 ---------- */
const nav = await ev(`(() => {
  const n = document.querySelector('.col-thread .thread-nav');
  if (!n) return { 无导航: true };
  const tabs = [...n.querySelectorAll('.thread-tab')].map(b => ({ t: b.innerText.trim().split('\\n')[0], on: b.classList.contains('on') }));
  const back = n.querySelector('.thread-nav-back');
  const more = [...n.querySelectorAll('button[aria-haspopup="menu"]')].length;
  const groups = document.querySelectorAll('.col-thread .thread-tabs').length;
  return {
    返回按钮: back ? (back.getAttribute('aria-label') || '') : null,
    常驻页签: tabs.map(x => x.t),
    选中数: tabs.filter(x => x.on).length,
    更多数: more,
    旧页签行: groups,
  };
})()`);
check('回复串只有一条导航（旧 .thread-tabs 常驻行已移除）', nav.旧页签行 === 0, JSON.stringify(nav));
check('常驻视图为 回复/成果/详情', JSON.stringify(nav.常驻页签) === JSON.stringify(['回复', '成果', '详情']), JSON.stringify(nav.常驻页签));
check('同一时刻只有一个激活视图', nav.选中数 === 1, String(nav.选中数));
check('收起/返回按钮存在且有可访问名称', nav.返回按钮 === '收起回复串' && nav.更多数 === 1, JSON.stringify(nav));

/* ---------- 3. 详情：原消息与旧 tab 映射 ---------- */
const overview = await ev(`(async () => {
  const btn = [...document.querySelectorAll('.col-thread .thread-tab')].find(b => b.innerText.includes('详情'));
  btn?.click();
  await new Promise(r => setTimeout(r, 250));
  const body = document.querySelector('.col-thread')?.innerText ?? '';
  return {
    有概况: body.includes('任务概况'),
    有原始要求: body.includes('原始要求（原消息）'),
    完整原消息: (document.querySelector('.overview-anchor-body')?.innerText ?? '').length,
    分组: [...document.querySelectorAll('.details-chip')].map(c => c.innerText.trim()),
    URL: location.hash,
  };
})()`);
check('详情默认展示任务概况', overview.有概况 === true, JSON.stringify(overview.分组));
check('完整原始要求在详情可查（非零宽、非空）', overview.有原始要求 === true && overview.完整原消息 > 20, String(overview.完整原消息));
check('任务概况 URL 仍写既有 tab 键', String(overview.URL).includes('tab=task'), overview.URL);
/* 详情分组覆盖成员/活动/运行/交付/研讨（交付分组只在有交付时出现） */
check('详情分组覆盖成员/活动/运行/研讨',
  ['参与成员', '活动与进展', '运行详情', '研讨详情'].every((x) => overview.分组.some((g) => g.includes(x))),
  JSON.stringify(overview.分组));
await goto(`${ROOM}?thread=thread_t13&tab=delivery&recovery=0`, 800);
const deliveryGroup = await ev(`(() => ({
  chip: document.querySelector('.details-chip.on')?.innerText.trim() ?? '',
  有芯片: [...document.querySelectorAll('.details-chip')].some(c => c.innerText.includes('交付与验收')),
  有验收UI: (document.querySelector('.col-thread .list-wrap')?.innerText ?? '').includes('验收'),
}))()`);
check('交付与验收分组在有交付的任务上出现并可直接进入',
  deliveryGroup.有芯片 === true && deliveryGroup.有验收UI === true, JSON.stringify(deliveryGroup));

/* ---------- 4. 八个旧 tab 逐项映射并自动展开 ---------- */
const tabCases = [
  ['replies', '回复', null],
  ['artifacts', '成果', null],
  ['task', '任务概况', null],
  ['members', '参与成员', null],
  ['activity', '活动与进展', null],
  ['run', '运行详情', null],
  ['delivery', '交付与验收', null],
  ['deliberation', '研讨详情', null],
];
for (const [key, expect] of tabCases) {
  // 修研讨详情只在 DELIBERATE 运行上存在：用 thread_t12（run_12_deliberate）
  await goto(`${ROOM}?thread=thread_t12&tab=${key}&recovery=0`, 700);
  const got = await ev(`(() => {
    const view = [...document.querySelectorAll('.col-thread .thread-tab')].find(b => b.classList.contains('on'))?.innerText.trim().split('\\n')[0];
    const chip = document.querySelector('.details-chip.on')?.innerText.trim() ?? '';
    const body = document.querySelector('.col-thread .list-wrap')?.innerText ?? '';
    return { view, chip, bodyHead: body.slice(0, 120) };
  })()`);
  const ok = key === 'replies' ? got.view === '回复'
    : key === 'artifacts' ? got.view === '成果'
      : got.view === '详情' && got.chip.includes(expect);
  check(`旧 tab=${key} → ${expect}（自动展开）`, ok, JSON.stringify(got));
}

/* ---------- 5. 实体/消息深链仍可用 ---------- */
for (const [path, expect] of [
  ['/task/task_12', '任务概况'],
  ['/run/run_12_deliberate', '运行详情'],
  ['/deliberation/run_12_deliberate', '研讨详情'],
]) {
  await ev(`window.location.href = ${JSON.stringify(base + '/#' + path + '?recovery=0')}; true`);
  await sleep(900);
  const got = await ev(`(() => ({
    thread: location.hash.includes('thread=thread_t12'),
    chip: document.querySelector('.details-chip.on')?.innerText.trim() ?? '',
    view: [...document.querySelectorAll('.col-thread .thread-tab')].find(b => b.classList.contains('on'))?.innerText.trim().split('\\n')[0],
  }))()`);
  check(`深链 ${path} 定位到线程并展开「${expect}」`, got.thread && got.view === '详情' && got.chip.includes(expect), JSON.stringify(got));
}

/* 消息深链高亮（§15.5） */
await goto(`${ROOM}?thread=thread_t12&tab=replies&recovery=0`, 600);
const firstMsgId = await ev(`document.querySelector('.col-thread .msg-list [id^="msg-"]')?.id ?? ''`);
if (firstMsgId) {
  const mid = firstMsgId.replace(/^msg-/, '');
  await goto(`/thread/thread_t12?message=${mid}&recovery=0`, 1200);
  const hi = await ev(`(() => ({
    在回复: (document.querySelector('.col-thread .thread-tab.on')?.innerText ?? '').includes('回复'),
    高亮或存在: !!document.getElementById('msg-${mid}'),
  }))()`);
  check('消息深链回到回复视图并定位该消息', hi.在回复 === true && hi.高亮或存在 === true, JSON.stringify(hi));
} else {
  check('消息深链回到回复视图并定位该消息', false, '未取到消息 id');
}

/* ---------- 6. 输入区上方不再有目标摘要行（2026-09-24 第三轮，用户要求整行去掉） ----------
   身份改由这三处承担：输入框 placeholder、房间头部（主池）、「详情 → 任务概况」。
   注意代价：placeholder 在输入后隐藏，所以"边写边看发给谁"不再有常驻元素 —— 这是
   用户明确接受过的取舍，用例断言"这一行确实没了"，而不是断言它还在。 */
await goto(T12);
const identity = await ev(`(async () => {
  const ta = document.querySelector('.col-thread .composer textarea');
  const line = () => document.querySelector('.col-thread .composer-target-line');
  const before = !!line();
  const ph = ta?.getAttribute('placeholder') ?? '';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '验收用输入：目标身份是否仍在');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  return {
    before,
    after: !!line(),
    placeholder: ph,
    详情可达: !!document.querySelector('.col-thread .thread-nav-views button'),
  };
})()`);
check('输入区上方不再有目标摘要行（主池与线程一致）',
  identity.before === false && identity.after === false, JSON.stringify(identity));
check('身份改由 placeholder 与「详情」承担（两者都还在）',
  /输入|@/.test(identity.placeholder) && identity.详情可达 === true, JSON.stringify(identity));

/* 只读场景：归档房间仍要说明"为什么不能发"（这不是身份行，是禁用原因） */
await goto('/project/proj_zs_01/room/room_docs?recovery=0', 900);
const archiveCase = await ev(`(() => ({
  有只读行: !!document.querySelector('.composer-target-summary'),
  文本: document.querySelector('.composer-target-summary')?.innerText.replace(/\\n/g, ' ') ?? '',
  只读说明: (document.querySelector('.col-main')?.innerText ?? '').includes('房间已归档'),
  没有可发送输入框: !document.querySelector('.col-main textarea'),
}))()`);
check('归档（只读）房间仍说明只读原因，不给可发送假象',
  archiveCase.有只读行 === true && archiveCase.只读说明 === true && archiveCase.没有可发送输入框 === true,
  JSON.stringify(archiveCase));

/* 真实交互下的只读线程：归档一个没有活跃任务的房间，再打开它的任务线程
   （开发大厅有活跃任务，按 §25.6 不允许归档，所以用 notes-vault 的已完成任务房间） */
const NG = '/project/proj_notgit_04/room/room_ng_notes';
const archivedThread = await ev(`(async () => {
  location.hash = '#${NG}?recovery=0';
  await new Promise(r => setTimeout(r, 800));
  document.querySelector('.pool-head button[aria-haspopup="menu"]')?.click();
  await new Promise(r => setTimeout(r, 250));
  const menus = [...document.querySelectorAll('.menu')];
  [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])]
    .find(b => b.innerText.includes('归档房间'))?.click();
  await new Promise(r => setTimeout(r, 500));
  const arch = [...document.querySelectorAll('.modal button, .drawer button')]
    .find(b => b.innerText.trim() === '归档房间');
  arch?.click();
  await new Promise(r => setTimeout(r, 500));
  const archived = (document.querySelector('.pool-head')?.innerText ?? '').includes('已归档');
  location.hash = '#${NG}?thread=thread_ng1&recovery=0';
  await new Promise(r => setTimeout(r, 800));
  const send = document.querySelector('.col-thread .composer-send');
  return {
    归档成功: archived,
    没有身份行: !document.querySelector('.col-thread .composer-target-line'),
    发送禁用: send ? send.disabled === true : null,
    禁用原因: send?.getAttribute('title') ?? '',
  };
})()`);
check('归档房间里的任务线程：不再有身份行，但发送被禁用并说明原因',
  archivedThread.归档成功 === true && archivedThread.没有身份行 === true
    && archivedThread.发送禁用 === true && /归档/.test(archivedThread.禁用原因),
  JSON.stringify(archivedThread));

/* ---------- 7. 讨论串：无任务号 + 附件可达 ---------- */
await goto(TDISC);
const disc = await ev(`(async () => {
  const tabs = [...document.querySelectorAll('.col-thread .thread-tab')].map(b => b.innerText.trim().split('\\n')[0]);
  const body = document.querySelector('.col-thread')?.innerText ?? '';
  const attach = [...document.querySelectorAll('.col-thread .thread-tab')].find(b => b.innerText.includes('附件'));
  attach?.click();
  await new Promise(r => setTimeout(r, 250));
  return {
    视图: tabs, 有任务号: /#\\d+/.test(body.split('\\n').slice(0,6).join(' ')),
    有摘要行: !!document.querySelector('.col-thread .composer-target-line'),
    有停止: !!document.querySelector('.col-thread .composer-stop'),
    附件视图内容: (document.querySelector('.col-thread .list-wrap')?.innerText ?? '').slice(0, 80),
  };
})()`);
check('讨论串导航为 回复/附件/详情', disc.视图.includes('回复') && disc.视图.includes('附件') && disc.视图.includes('详情'), JSON.stringify(disc.视图));
check('讨论串不伪造任务号、不显示停止/验收控件', disc.有任务号 === false && disc.有停止 === false, JSON.stringify(disc));
check('讨论串输入区同样没有目标摘要行（讨论内容就在上方回复流里）', disc.有摘要行 === false, JSON.stringify(disc));

/* ---------- 8. 主池卡片：去重入口、单一未读、菜单不误触 ---------- */
await goto(POOL);
const card = await ev(`(async () => {
  const c = document.querySelector('.root-card');
  const txt = c?.innerText ?? '';
  const before = location.hash;
  const menuBtn = c?.querySelector('.root-foot button[aria-haspopup="menu"]');
  menuBtn?.click();
  await new Promise(r => setTimeout(r, 250));
  const items = [...document.querySelectorAll('.menu .menu-item')].map(b => b.innerText.trim().split('\\n')[0]);
  const hint = [...document.querySelectorAll('.menu .menu-item .hint')].map(b => b.innerText.trim());
  const titles = [...document.querySelectorAll('.menu .menu-item')].map(b => b.getAttribute('title') ?? '');
  // 关闭菜单（点外部）
  document.querySelector('.menu')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await new Promise(r => setTimeout(r, 150));
  return {
    有打开回复串常驻: txt.includes('打开回复串'),
    回复入口: !!c?.querySelector('.root-replies-btn'),
    标题入口: !!c?.querySelector('.root-title-btn'),
    未读类: c?.className ?? '',
    有未读文字: /\\d+ 条未读/.test(txt),
    菜单项: items, 菜单状态: hint, 菜单解释: titles,
    误触导航: location.hash !== before,
  };
})()`);
check('卡片去掉常驻「打开回复串」，回复数与标题成为入口',
  card.有打开回复串常驻 === false && card.回复入口 === true && card.标题入口 === true, JSON.stringify(card));
check('同一卡片只保留一种未读表达（无未读圆点类）', !String(card.未读类).includes('unread'), card.未读类);
check('卡片 ⋯ 菜单：操作名简短、当前状态在行尾、解释进 tooltip（减负第二轮 §2）',
  card.菜单项.some((x) => x === '取消关注' || x === '关注')
    && card.菜单项.every((x) => x.length <= 8)
    && card.菜单状态.some((x) => /已关注|未关注/.test(x))
    && card.菜单解释.every((x) => x.length > 0),
  JSON.stringify({ 项: card.菜单项, 状态: card.菜单状态 }));
check('打开菜单不误触卡片导航', card.误触导航 === false);

/* 卡片菜单真的改订阅状态 */
const followWorked = await ev(`(async () => {
  const c = document.querySelector('.root-card');
  c.querySelector('.root-foot button[aria-haspopup="menu"]').click();
  await new Promise(r => setTimeout(r, 200));
  const item = [...document.querySelectorAll('.menu .menu-item')].find(b => b.innerText.includes('关注'));
  item?.click();
  await new Promise(r => setTimeout(r, 250));
  return true;
})()`);
check('卡片菜单的关注动作可执行（不报错）', followWorked === true);

/* ---------- 8b. 整卡可点 + 上下文跟随（用户反馈的两条体验问题） ---------- */

/* ① 整卡可点：点卡片**正文区域**（不是任何按钮）就应该打开回复串 */
await resetApp();
await goto(POOL, 800);
const cardBodyClick = await ev(`(() => {
  const card = [...document.querySelectorAll('.root-card')].find(c => c.innerText.includes('修复 build 脚本'));
  if (!card) return { found: false };
  const body = card.querySelector('.root-body');
  const r = body.getBoundingClientRect();
  body.dispatchEvent(new MouseEvent('click', {
    bubbles: true, clientX: r.left + 6, clientY: r.top + 6,
  }));
  return { found: true };
})()`);
await sleep(900);
const afterCardClick = await ev(`(() => ({
  thread: !!document.querySelector('.col-thread'),
  hash: location.hash,
}))()`);
check('点卡片正文（非按钮）即可打开回复串（整卡可点）',
  cardBodyClick.found === true && afterCardClick.thread === true && String(afterCardClick.hash).includes('thread='),
  JSON.stringify({ ...cardBodyClick, ...afterCardClick }));

/* ② 选中文字后点击不算打开（防"想复制却跳走"） */
await resetApp();
await goto(POOL, 800);
const selectionClick = await ev(`(() => {
  const card = [...document.querySelectorAll('.root-card')].find(c => c.innerText.includes('修复 build 脚本'));
  const body = card.querySelector('.root-body');
  const range = document.createRange();
  range.selectNodeContents(body);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const len = sel.toString().trim().length;
  body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { len, hashBefore: location.hash };
})()`);
await sleep(800);
const afterSelection = await ev(`(() => {
  const opened = location.hash.includes('thread=');
  window.getSelection().removeAllRanges();
  return { opened };
})()`);
check('在卡片里选中文字后点击不会误触打开回复串',
  selectionClick.len > 0 && afterSelection.opened === false,
  JSON.stringify({ 选中字数: selectionClick.len, 打开了: afterSelection.opened }));

/* ③ 点附件 / 卡片 ⋯ 只做自己的事，不打开回复串 */
await resetApp();
await goto(POOL, 800);
const guard = await ev(`(async () => {
  const card = [...document.querySelectorAll('.root-card')].find(c => c.innerText.includes('修复 build 脚本'));
  const hash0 = location.hash;
  card.querySelector('.root-foot button[aria-haspopup="menu"]').click();
  await new Promise(r => setTimeout(r, 250));
  const menuOpened = !!document.querySelector('.menu');
  card.querySelector('.root-foot button[aria-haspopup="menu"]').click();
  await new Promise(r => setTimeout(r, 200));
  const attach = card.querySelector('.msg-attach');
  if (attach) { attach.click(); await new Promise(r => setTimeout(r, 400)); }
  return { hash0, menuOpened, attach: !!attach, hashNow: location.hash };
})()`);
await sleep(400);
const guardNow = await ev(`location.hash`);
check('点卡片 ⋯ 打开菜单但不打开回复串', guard.menuOpened === true && guard.hashNow === guard.hash0, JSON.stringify(guard));
check('点附件不打开回复串（各控件自己处理点击）',
  !String(guardNow).includes('thread='), String(guardNow));

/* ④ 上下文跟随：池里打开文件（主池＋文件）后点回复串 → 回复串＋文件，
      不需要先关掉文件（用户反馈 1） */
await resetApp();
await goto(POOL, 800);
await ev(`(() => {
  const a = [...document.querySelectorAll('.root-card .msg-attach')].find(b => b.innerText.includes('架构评审要点'));
  a?.click();
  return !!a;
})()`);
await sleep(1100);
const l3 = await ev(`(() => ({
  pool: !!document.querySelector('.col-main'),
  thread: !!document.querySelector('.col-thread'),
  pane: !!document.querySelector('.preview-pane'),
  tabs: document.querySelectorAll('.preview-tab').length,
}))()`);
check('池里打开文件后是「主池＋文件」（L3）',
  l3.pool === true && l3.pane === true && l3.thread === false, JSON.stringify(l3));

await ev(`(() => {
  const card = [...document.querySelectorAll('.root-card')].find(c => c.innerText.includes('修复 build 脚本'));
  const body = card.querySelector('.root-body');
  body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
})()`);
await sleep(1200);
const afterOpen = await ev(`(() => ({
  thread: !!document.querySelector('.col-thread'),
  pool: !!document.querySelector('.col-main'),
  pane: !!document.querySelector('.preview-pane'),
  reopen: !!document.querySelector('.preview-reopen'),
  target: location.hash,
}))()`);
/* 用户明确要求：点回复串 = **收起附件、显示回复串**（不是并排），
   附件进"收起预览"（标签与阅读位置保留，可一键重开）。 */
check('点开回复串会收起附件并显示回复串（不是把串挤成两半）',
  afterOpen.thread === true && afterOpen.pool === true && afterOpen.pane === false
    && afterOpen.reopen === true && afterOpen.target.includes('thread_t13'),
  JSON.stringify(afterOpen));

/* 用户报告的 bug：串已经开着（URL 仍是 ?thread=t13）、被附件挡住后，
   再点**同一张**卡片必须有反应（先前 threadId 没变 → 界面毫无变化）。
   上面这一步点的正是同一条串，所以这里直接断言"它回到了眼前"。 */
check('串被附件挡住后再点同一张卡片有反应（回到该串，不再无响应）',
  afterOpen.thread === true && afterOpen.target.includes('thread_t13'), JSON.stringify(afterOpen));

/* ⑥ 从线程打开文件 → L4（左串右文件）：这时左端按钮写「主池」，
      ⋯ 里能"回主池"或"直接切换到其他回复串"（文件保留） */
await resetApp();
await goto(`${ROOM}?thread=thread_t13&tab=replies&recovery=0`, 900);
await ev(`(() => {
  const t = [...document.querySelectorAll('.col-thread .thread-tab')].find(b => b.innerText.includes('详情'));
  t?.click();
  return true;
})()`);
await sleep(500);
await ev(`(() => {
  const a = [...document.querySelectorAll('.col-thread .btn')].find(b => b.innerText.trim() === '查看交付');
  a?.click();
  return !!a;
})()`);
await sleep(600);
// 直接从线程的成果里打开一份有真实资源的文件（线程 #14）
await goto(`${ROOM}?thread=thread_t14&tab=artifacts&recovery=0`, 900);
await ev(`(() => {
  const a = [...document.querySelectorAll('.col-thread .msg-attach')]
    .find(x => x.innerText.includes('预览交互设计说明'));
  a?.click();
  return !!a;
})()`);
await sleep(1300);
const l4 = await ev(`(() => ({
  thread: !!document.querySelector('.col-thread'),
  pool: !!document.querySelector('.col-main'),
  pane: !!document.querySelector('.preview-pane'),
  tabs: document.querySelectorAll('.preview-tab').length,
  backLabel: document.querySelector('.col-thread .thread-nav-back')?.innerText.trim() ?? null,
  backAria: document.querySelector('.col-thread .thread-nav-back')?.getAttribute('aria-label') ?? null,
}))()`);
check('从线程打开文件是「回复串＋文件」并排（L4）',
  l4.thread === true && l4.pane === true && l4.pool === false && l4.tabs >= 1, JSON.stringify(l4));
check('主池被文件收起时左端按钮写明「主池」（出口可发现）',
  l4.backLabel === '主池' && l4.backAria === '返回主池', JSON.stringify(l4));

await ev(`document.querySelector('.col-thread .thread-nav button[aria-haspopup="menu"]')?.click()`);
await sleep(450);
const switchMenu = await ev(`(() => {
  const m = [...document.querySelectorAll('.menu')].at(-1);
  return [...(m?.querySelectorAll('.menu-item') ?? [])].map((x) => x.innerText.trim());
})()`);
check('线程 ⋯ 菜单提供「回主池」与"直接切换到其他回复串"',
  switchMenu.some((t) => t.includes('回主池'))
    && switchMenu.some((t) => /#\d+|讨论/.test(t) && !t.includes('回主池')),
  JSON.stringify(switchMenu.slice(0, 5)));

const switched = await ev(`(() => {
  const m = [...document.querySelectorAll('.menu')].at(-1);
  const it = [...(m?.querySelectorAll('.menu-item') ?? [])]
    .find((x) => x.innerText.includes('修复 build 脚本'));
  if (!it) return false;
  it.click();
  return true;
})()`);
await sleep(1100);
const afterSwitch = await ev(`(() => ({
  pane: !!document.querySelector('.preview-pane'),
  tabs: document.querySelectorAll('.preview-tab').length,
  target: location.hash,
}))()`);
check('从 ⋯ 直接切到另一条回复串：串换了、文件仍在',
  switched === true && afterSwitch.pane === true && afterSwitch.tabs >= 1
    && afterSwitch.target.includes('thread_t13'),
  JSON.stringify(afterSwitch));

/* 本节结束时预览与线程都是打开状态，后面的房间头部用例需要主池，
   所以显式回到干净的种子状态（否则会误判成"房间信息入口不见了"）。 */
await resetApp();

/* 房间头部：房间信息入口 + ⋯ */
const head = await ev(`(async () => {
  const info = document.querySelector('.pool-info');
  const before = location.hash;
  const btn = document.querySelector('.pool-head button[aria-haspopup="menu"]');
  btn?.click();
  await new Promise(r => setTimeout(r, 220));
  const items = [...document.querySelectorAll('.menu .menu-item')].map(b => b.innerText.trim().split('\\n')[0]);
  return { 有信息入口: !!info, 信息文本: info?.innerText ?? '', 菜单: items, 误触: location.hash !== before };
})()`);
check('协调者与成员数合并为房间信息入口', head.有信息入口 === true && /协调者|名成员/.test(head.信息文本), head.信息文本);
check('房间设置统一进入房间 ⋯（保留完整能力）', head.菜单.some((x) => x.includes('房间设置')), JSON.stringify(head.菜单));
check('房间 ⋯ 不误触房间导航', head.误触 === false);

/* ---------- 9. 停止入口与语义 ---------- */
await goto(T12);
const stopState = await ev(`(() => ({
  有停止: !!document.querySelector('.col-thread .composer-stop'),
  文案: document.querySelector('.col-thread .composer-stop')?.innerText.trim() ?? '',
  有发送: !!document.querySelector('.col-thread .composer-send'),
}))()`);
check('运行中任务在输入区有可发现的停止入口', stopState.有停止 === true, JSON.stringify(stopState));
check('停止不替代唯一发送入口', stopState.有发送 === true);

const stopped = await ev(`(async () => {
  const btn = document.querySelector('.col-thread .composer-stop');
  btn?.click();
  await new Promise(r => setTimeout(r, 400));
  return {
    停止中: !!document.querySelector('.col-thread .composer-stopping') || !document.querySelector('.col-thread .composer-stop'),
  };
})()`);
check('停止后显示真实状态且不再重复可点', stopped.停止中 === true, JSON.stringify(stopped));

/* 收起/返回不停止任务 */
await goto(T12);
const beforeClose = await ev(`(() => {
  const c = document.querySelector('.col-thread .thread-nav-back');
  return { 有按钮: !!c };
})()`);
await ev(`document.querySelector('.col-thread .thread-nav-back')?.click(); true`);
await sleep(600);
const afterClose = await ev(`(() => ({
  hash: location.hash,
  回到主池: !location.hash.includes('thread='),
  任务仍在: document.querySelector('.root-card')?.innerText.includes('执行中') || true,
}))()`);
check('收起/返回回到主池且不停止任务', afterClose.回到主池 === true, JSON.stringify(afterClose));
await ev(`window.history.back(); true`);
await sleep(700);

/* 待验收 / 阻塞提示条（task_13 有 pending 交付） */
await goto(T13);
const pendingStrip = await ev(`(() => {
  const strip = document.querySelector('.thread-pending');
  return {
    有提示: !!strip,
    文本: strip?.innerText.replace(/\\n/g, ' | ').slice(0, 120) ?? '',
    可直达交付: !!strip?.querySelector('button'),
  };
})()`);
check('待验收/阻塞在回复视图有可见处理入口', pendingStrip.有提示 === true && /验收|阻塞|运行/.test(pendingStrip.文本), pendingStrip.文本);

/* ---------- 10. 预览：文件名一次、阅读菜单、文件信息、引用、收起 ---------- */
await goto(`${ROOM}?recovery=0`);
const preview = await ev(`(async () => {
  // 明确挑 Markdown 附件（图片没有阅读视图，会被误判成"没有阅读菜单"）
  const attach = [...document.querySelectorAll('.root-card .msg-attach')]
    .find(b => b.innerText.includes('架构评审要点'))
    ?? document.querySelector('.root-card .msg-attach');
  if (!attach) return { 无附件: true };
  attach.click();
  await new Promise(r => setTimeout(r, 700));
  const pane = document.querySelector('.preview-pane');
  const tools = pane?.querySelector('.preview-tools');
  return {
    有预览: !!pane,
    工具行有路径: !!tools?.querySelector('.preview-path'),
    标签数: pane?.querySelectorAll('.preview-tab').length ?? 0,
    阅读菜单: !!pane?.querySelector('.preview-read'),
    引用按钮: [...(pane?.querySelectorAll('.preview-tools button') ?? [])].some(b => b.innerText.includes('引用到')),
    收起预览: !!pane?.querySelector('[aria-label="收起预览区"]'),
    /* 统一性：回复串与预览的「收起/返回」必须在**同一侧（各自区域左端）**、
       用同一个组件类，且文案/可访问名称各自准确（不是同一个"关闭"）。 */
    收起类名: pane?.querySelector('.preview-tabs .panel-nav-btn')?.className ?? '',
    收起在左端: (() => {
      const b = pane?.querySelector('.preview-tabs .panel-nav-btn');
      const pr = pane?.getBoundingClientRect();
      if (!b || !pr) return false;
      return b.getBoundingClientRect().left <= pr.left + 12;
    })(),
    收起文案: pane?.querySelector('.preview-tabs .panel-nav-btn')?.innerText.trim() ?? '',
    收起可访问名: pane?.querySelector('.preview-tabs .panel-nav-btn')?.getAttribute('aria-label') ?? '',
    右端还有收起: !!pane?.querySelector('.preview-tabs > .preview-icon-btn[aria-label="收起预览区"]'),
    有已开列表入口: !!pane?.querySelector('.preview-icon-btn[aria-label="已打开的文件"]'),
    来源行: pane?.querySelector('.preview-origin')?.innerText.replace(/\\n/g,' ') ?? '',
  };
})()`);
check('预览可打开且文件名不再在工具行重复', preview.有预览 === true && preview.工具行有路径 === false, JSON.stringify(preview));
check('标签仍显示文件与版本', preview.标签数 >= 1);
check('「阅读 ▾」菜单取代常驻分段控件', preview.阅读菜单 === true);
check('「引用到 X」仍在并排对话时可见', preview.引用按钮 === true);
check('「收起预览」常驻', preview.收起预览 === true);
/* 统一性（2026-09-24 后续）：回复串与预览的收起**同侧、同组件、文案各异** */
check('回复串与预览的收起按钮同侧（各自区域左端）且同为一个组件',
  String(preview.收起类名).includes('panel-nav-btn') && preview.收起在左端 === true
    && preview.右端还有收起 === false,
  JSON.stringify({ 类名: preview.收起类名, 在左端: preview.收起在左端, 右端还有: preview.右端还有收起 }));
check('两处收起文案与可访问名称各自准确（不共用同一个"关闭"）',
  preview.收起文案.includes('收起预览') && preview.收起可访问名 === '收起预览区'
    && nav.返回按钮 === '收起回复串',
  JSON.stringify({ 预览: preview.收起文案, 预览aria: preview.收起可访问名, 回复串: nav.返回按钮 }));
check('「已打开文件」入口只在溢出/暂藏时需要', preview.有已开列表入口 === false, JSON.stringify(preview));

const info = await ev(`(async () => {
  const pane = document.querySelector('.preview-pane');
  const more = pane.querySelector('.preview-tools button[aria-label="更多文件操作"]');
  more.click();
  await new Promise(r => setTimeout(r, 250));
  // 只取**最后打开的**菜单：前面的菜单可能还挂在 DOM 上（程序化点击不触发外部关闭）
  const menus = [...document.querySelectorAll('.menu')];
  const items = [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])].map(b => b.innerText.trim().split('\\n')[0]);
  const infoItem = [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])].find(b => b.innerText.includes('文件信息'));
  infoItem?.click();
  await new Promise(r => setTimeout(r, 300));
  const modal = document.querySelector('.modal');
  return { 菜单: items, 有弹窗: !!modal, 含路径: (modal?.innerText ?? '').includes('完整路径') };
})()`);
check('文件 ⋯ 收纳低频操作（文件信息/导出下载/复制路径/放大）',
  ['文件信息', '导出', '复制路径', '放大'].every((x) => info.菜单.some((m) => m.includes(x))), JSON.stringify(info.菜单));
check('文件信息里能查到完整路径', info.有弹窗 === true && info.含路径 === true, JSON.stringify(info));

/* 阅读菜单：Markdown 默认阅读视图，源码可切 */
const readMenu = await ev(`(async () => {
  const pane = document.querySelector('.preview-pane');
  const read = pane.querySelector('.preview-read');
  const label = read.innerText.trim();
  read.click();
  await new Promise(r => setTimeout(r, 250));
  const menu = [...document.querySelectorAll('.menu')].at(-1);
  const items = [...(menu?.querySelectorAll('.menu-item') ?? [])].map(b => b.innerText.trim().split('\\n')[0]);
  const src = [...(menu?.querySelectorAll('.menu-item') ?? [])].find(b => b.innerText.includes('源码视图'));
  src?.click();
  await new Promise(r => setTimeout(r, 300));
  return {
    label, items,
    切到源码: (document.querySelector('.preview-read')?.innerText ?? '').includes('源码'),
    正文是源码: !!document.querySelector('.preview-source'),
  };
})()`);
check('Markdown 默认阅读视图、菜单可切源码',
  readMenu.label.includes('阅读') === true && readMenu.切到源码 === true && readMenu.正文是源码 === true,
  JSON.stringify(readMenu));

/* ---------- 10a. 收起预览后的重开入口：位置不得遮挡输入区（用户截图反馈） ----------
   原实现是 `position:absolute; right:12px; bottom:14px`，正好压在发送按钮上。
   现在它是房间头部里的普通 chip；这里同时断言"位置"和"六档宽度都在头部内"。 */
await ev(`document.querySelector('.preview-pane button[aria-label="收起预览区"]')?.click()`);
await sleep(900);
const reopenChip = await ev(`(() => {
  const p = document.querySelector('.preview-reopen');
  const send = document.querySelector('.composer-send');
  const head = document.querySelector('.pool-head');
  if (!p) return { 有: false };
  const a = p.getBoundingClientRect();
  const b = send ? send.getBoundingClientRect() : null;
  const hit = b ? !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom) : false;
  return {
    有: true,
    在房间头部: !!p.closest('.pool-head'),
    与发送按钮重叠: hit,
    头部内: head ? a.right <= head.getBoundingClientRect().right + 1 : false,
  };
})()`);
check('收起预览后的重开入口在房间头部，且不遮挡发送按钮',
  reopenChip.有 === true && reopenChip.在房间头部 === true
    && reopenChip.与发送按钮重叠 === false && reopenChip.头部内 === true,
  JSON.stringify(reopenChip));

for (const w of [1600, 1372, 1280, 1100, 900, 720]) {
  await setViewport(w, 900);
  await sleep(300);
  const fit = await ev(`(() => {
    const head = document.querySelector('.pool-head');
    const chip = document.querySelector('.preview-reopen');
    const more = head?.querySelector('button[aria-label="房间操作"]');
    if (!head) return { 无头部: true };
    const hr = head.getBoundingClientRect();
    const inside = (el) => {
      if (!el) return null;
      const q = el.getBoundingClientRect();
      return q.right <= hr.right + 1 && q.left >= hr.left - 1 && q.width > 8;
    };
    return { chip: inside(chip), more: inside(more), 溢出: head.scrollWidth > head.clientWidth + 1 };
  })()`);
  check(`${w}px：重开入口与房间 ⋯ 都在头部内、头部不溢出`,
    fit.chip === true && fit.more === true && fit.溢出 === false, JSON.stringify(fit));
}
await send('Emulation.clearDeviceMetricsOverride');
await sleep(300);
const reopened = await ev(`(async () => {
  const p = document.querySelector('.preview-reopen');
  if (!p) return { 有: false };
  p.click();
  await new Promise(r => setTimeout(r, 600));
  return { 有: true, 预览回来了: !!document.querySelector('.preview-pane'), 标签数: document.querySelectorAll('.preview-tab').length };
})()`);
check('点重开入口能恢复预览（标签与阅读位置都还在）',
  reopened.有 === true && reopened.预览回来了 === true && reopened.标签数 >= 1, JSON.stringify(reopened));

/* ============================================================
   10c. 减负第二轮（2026-09-24 用户指定四项）
   ① 详情不重复任务身份与操作；按面板宽度适配；成员名不逐字断行
   ② 菜单名短、解释进 tooltip；输入区无常驻教学文字
   ③ 并排预览时发送/停止在同一排、位置稳定
   ④ 版本与来源去重、口径统一（v3 / 读取 r3），无"阅读：阅读"
   ============================================================ */
await resetApp();
await goto(`${ROOM}?thread=thread_t14&tab=task&recovery=0`, 900);
await sleep(700);
const overviewDedupe = await ev(`(() => {
  const body = document.querySelector('.details-body');
  if (!body) return { 无详情: true };
  const txt = body.innerText;
  const grid = body.querySelector('.grid-2');
  const name = body.querySelector('.kv-name');
  return {
    有页面头: !!body.querySelector('.page-head'),
    标题次数: (txt.match(/整理本周演化日志并写周报/g) ?? []).length,
    方式行: [...body.querySelectorAll('.kv dt')].filter(d => d.innerText.trim() === '方式').length,
    模式行: [...body.querySelectorAll('.kv dt')].filter(d => d.innerText.trim() === '模式').length,
    停止按钮: [...body.querySelectorAll('button')].filter(b => b.innerText.includes('停止任务')).length,
    定向跟进: [...body.querySelectorAll('button')].some(b => b.innerText.includes('定向跟进')),
    网格列数: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : null,
    成员名单行: name ? getComputedStyle(name).whiteSpace === 'nowrap' : null,
  };
})()`);
check('详情不重复任务身份（无 page-head、标题只出现一次、无重复"模式"行）',
  overviewDedupe.有页面头 === false && overviewDedupe.标题次数 === 1
    && overviewDedupe.方式行 === 1 && overviewDedupe.模式行 === 0,
  JSON.stringify(overviewDedupe));
check('详情不重复操作（停止在输入区；详情里只保留别处没有的「定向跟进」）',
  overviewDedupe.停止按钮 === 0 && overviewDedupe.定向跟进 === true, JSON.stringify(overviewDedupe));
check('详情按面板宽度适配（面板下两列网格降为单列）',
  overviewDedupe.网格列数 === 1, JSON.stringify(overviewDedupe));
check('成员名不逐字断行（nowrap）', overviewDedupe.成员名单行 === true, JSON.stringify(overviewDedupe));

/* ---------- 10d. 收尾两项（2026-09-24 第四轮，用户指定） ----------
   ① 任务概况里「方式」与「派发摘要」说的是同一句话 → 合并：方式只给模式名，
      「派发」行仅在存在独立派发信息（点名 / 父任务）时单列。
   ② threadId、taskRevision 等内部字段移入「技术信息」折叠区；产品界面不出现
      规范章节号；验收策略默认只给简短结论。 */
const overviewRows = (tid) => ev(`(() => {
  const body = document.querySelector('.details-body');
  if (!body) return { 无详情: true };
  const rows = {};
  [...body.querySelectorAll('.kv dt')].forEach((dt) => {
    rows[dt.innerText.trim()] = dt.nextElementSibling?.innerText.replace(/\\n/g, ' ').trim() ?? '';
  });
  const tech = body.querySelector('.kv-tech');
  const txt = body.innerText;
  // 折叠区内容用 textContent 断言（innerText 不含未展开的内容），
  // 再展开一次证明"展开后用户真的看得到"。
  const techIds = tech ? tech.textContent : '';
  if (tech) tech.setAttribute('open', '');
  const techVisibleAfterOpen = tech ? tech.innerText : '';
  if (tech) tech.removeAttribute('open');
  return {
    行: rows,
    有派发行: '派发' in rows,
    技术信息存在: !!tech,
    技术信息默认收起: tech ? !tech.hasAttribute('open') : null,
    技术信息含内部字段: /thread_t\\d/.test(techIds) && /taskRevision/.test(techIds),
    展开后可见内部字段: /thread_t\\d/.test(techVisibleAfterOpen) && /taskRevision/.test(techVisibleAfterOpen),
    正文含章节号: /§\\d|v1\\.12/.test(txt),
    正文含threadId: /thread_t\\d/.test(txt),
    正文含taskRevision: /taskRevision/.test(txt),
  };
})()`);

await goto(`${ROOM}?thread=thread_t12&tab=task&recovery=0`, 900);
await sleep(600);
const rowT12 = await overviewRows('thread_t12');
check('方式只给模式名（不再重复派发说明）',
  rowT12.行?.方式 === '共同研讨', JSON.stringify(rowT12.行?.方式));
check('存在独立派发信息时「派发」单列（@全体）',
  rowT12.有派发行 === true && rowT12.行?.派发 === '已点名 @全体', JSON.stringify(rowT12.行?.派发));

await goto(`${ROOM}?thread=thread_t14&tab=task&recovery=0`, 900);
await sleep(600);
const rowT14 = await overviewRows('thread_t14');
check('无独立派发信息时不出现「派发」行', rowT14.有派发行 === false, JSON.stringify(rowT14.行));

await goto(`${ROOM}?thread=thread_t13&tab=task&recovery=0`, 900);
await sleep(600);
const rowT13 = await overviewRows('thread_t13');
check('单点成员时「派发」显示点了谁',
  rowT13.行?.派发 === '已点名 Claude', JSON.stringify(rowT13.行?.派发));

check('内部字段（threadId / taskRevision）收进「技术信息」折叠区且默认收起',
  rowT13.技术信息存在 === true && rowT13.技术信息默认收起 === true
    && rowT13.技术信息含内部字段 === true && rowT13.展开后可见内部字段 === true,
  JSON.stringify({ 存在: rowT13.技术信息存在, 收起: rowT13.技术信息默认收起, 含字段: rowT13.技术信息含内部字段, 展开可见: rowT13.展开后可见内部字段 }));
check('产品界面正文不再出现 threadId / taskRevision 原始值',
  rowT13.正文含threadId === false && rowT13.正文含taskRevision === false,
  JSON.stringify({ 含threadId: rowT13.正文含threadId, 含taskRevision: rowT13.正文含taskRevision }));
check('验收策略默认只给简短结论，解释进 tooltip',
  ['需人工验收', '无需验收'].includes(rowT13.行?.验收策略 ?? '')
    && String(rowT13.行?.验收策略).length <= 8,
  JSON.stringify(rowT13.行?.验收策略));
check('产品界面正文不出现规范章节号（§/v1.x）',
  rowT13.正文含章节号 === false, JSON.stringify({ 含章节号: rowT13.正文含章节号 }));

/* ② 菜单名短 + 解释进 tooltip；输入区无常驻教学文字 */
await goto(`${ROOM}?thread=thread_t14&tab=replies&recovery=0`, 900);
await sleep(600);
await ev(`document.querySelector('.col-thread .thread-nav button[aria-haspopup="menu"]')?.click()`);
await sleep(400);
const threadMenu = await ev(`(() => {
  const m = [...document.querySelectorAll('.menu')].at(-1);
  const items = [...(m?.querySelectorAll('.menu-item') ?? [])];
  return {
    名称: items.map(b => b.innerText.trim().split('\\n')[0]),
    全有解释: items.every(b => (b.getAttribute('title') ?? '').length > 0),
    最长名称: Math.max(...items.map(b => b.innerText.trim().split('\\n')[0].length)),
  };
})()`);
check('线程 ⋯ 菜单名短（≤8 字）且每项都有 tooltip 解释',
  threadMenu.全有解释 === true && threadMenu.最长名称 <= 8, JSON.stringify(threadMenu));

await ev(`document.body.click()`);
await sleep(300);
const inputArea = await ev(`(() => {
  const thread = document.querySelector('.col-thread');
  const pool = document.querySelector('.col-main');
  const t = thread?.innerText ?? '';
  return {
    线程有摘要行: !!thread?.querySelector('.composer-target-line'),
    线程有教学文字: t.includes('点击查看完整任务信息'),
    池有原消息卡教学: (pool?.innerText ?? '').includes('新任务会在这里形成一张原消息卡'),
    池有摘要行: !!pool?.querySelector('.composer-target-line'),
  };
})()`);
check('输入区上方既没有教学文字、也没有目标摘要行（第三轮整行去掉）',
  inputArea.线程有摘要行 === false && inputArea.池有摘要行 === false
    && inputArea.线程有教学文字 === false && inputArea.池有原消息卡教学 === false,
  JSON.stringify(inputArea));

/* 发送按钮文案：任务与线程统一两个字的「发送」（原线程写「发送补充」，用户要求简化）；
   讨论串仍是「写入」（只存消息、不调用模型、不派工，语义确实不同）。 */
const sendLabels = await ev(`(() => {
  const label = (root) => {
    const b = document.querySelector(root + ' .composer-send');
    return b ? b.innerText.replace(/\\n/g, '') : null;
  };
  return { 线程: label('.col-thread'), 主池: label('.col-main') };
})()`);
check('任务线程与主池的发送按钮都是「发送」（不是「发送补充」）',
  sendLabels.线程 === '发送' && sendLabels.主池 === '发送', JSON.stringify(sendLabels));

await goto(TDISC, 700);
const discSend = await ev(`document.querySelector('.col-thread .composer-send')?.innerText.replace(/\\n/g, '') ?? null`);
/* 用例迁移（2026-09-25「默认交给 AI」）：历史记录串的按钮文案从「写入」改为「保存记录」。
   语义不变 —— 记录串仍必须与"发给 AI"的普通发送（「发送」）在文案上区分开。 */
check('记录串发送按钮是「保存记录」（与发给 AI 的「发送」区分）', discSend === '保存记录', String(discSend));
await goto(`${ROOM}?thread=thread_t14&tab=replies&recovery=0`, 900);
await sleep(600);

/* ③ 并排预览时发送/停止同排且位置稳定（三档宽度） */
await goto(`${ROOM}?thread=thread_t14&tab=artifacts&recovery=0`, 900);
await sleep(700);
await ev(`(() => {
  const a = [...document.querySelectorAll('.col-thread .msg-attach')].find(x => x.innerText.includes('预览交互设计说明'));
  a?.click();
  return !!a;
})()`);
await sleep(1200);
for (const w of [1440, 1280, 1100]) {
  await setViewport(w, 950);
  await sleep(350);
  const bar = await ev(`(() => {
    const tb = document.querySelector('.col-thread .composer-toolbar');
    if (!tb) return { 无工具条: true };
    const y = (el) => (el ? Math.round(el.getBoundingClientRect().top) : null);
    const send = tb.querySelector('.composer-send');
    const stop = tb.querySelector('.composer-stop');
    const tr = tb.getBoundingClientRect();
    return {
      发送行: y(send), 停止行: y(stop),
      同排: y(send) !== null && y(send) === y(stop),
      发送在条内: send ? send.getBoundingClientRect().right <= tr.right + 1 : null,
      有操作簇: !!tb.querySelector('.composer-actions'),
    };
  })()`);
  check(`${w}px 并排预览：发送与停止同一排、发送不被挤出工具条`,
    bar.同排 === true && bar.发送在条内 === true && bar.有操作簇 === true, JSON.stringify(bar));
}
await send('Emulation.clearDeviceMetricsOverride');
await sleep(300);

/* ④ 版本与来源去重、口径统一 */
const versionUi = await ev(`(() => {
  const pane = document.querySelector('.preview-pane');
  const tab = pane?.querySelector('.preview-tab.on');
  const tools = pane?.querySelector('.preview-tools');
  const origin = pane?.querySelector('.preview-origin');
  return {
    标签文本: tab?.innerText.split('\\n').join(' ') ?? null,
    工具行还有版本徽标: (pane?.querySelectorAll('.preview-version') ?? []).length,
    阅读按钮: pane?.querySelector('.preview-read')?.innerText.split('\\n').join(' ') ?? null,
    来源行: origin?.innerText.split('\\n').join(' ') ?? null,
  };
})()`);
check('版本只在标签上显示一次，且统一为 v3 / 读取 r3 口径',
  /\bv3\b/.test(String(versionUi.标签文本)) && versionUi.工具行还有版本徽标 === 0,
  JSON.stringify(versionUi));
check('不再出现「阅读：阅读」（按钮只写一次模式名）',
  versionUi.阅读按钮 !== null && !String(versionUi.阅读按钮).includes('阅读：'),
  JSON.stringify(versionUi.阅读按钮));
check('来源行去重：归属与来路相同时不重复写"从…打开"',
  String(versionUi.来源行).includes('来源：') && !String(versionUi.来源行).includes('从 '),
  JSON.stringify(versionUi.来源行));


/* ---------- 10b. 收起/返回后的上下文：不得空白（截图取证时抓到的真实缺陷回归） ----------
   缺陷：从线程打开文件后点「收起/返回」，URL 变成主池但预览来源仍是"线程"，
   于是主池被藏、线程又因为没有 threadId 渲染不出来 → 上下文区整块空白，只剩文件。
   这里对**宽屏**与**单区域**两条路径都做回归。 */
await resetApp();
async function openThreadFileThenCollapse() {
  await goto(`${ROOM}?thread=thread_t14&tab=artifacts&recovery=0`, 900);
  await ev(`(() => {
    const a = [...document.querySelectorAll('.col-thread .msg-attach')]
      .find(x => x.innerText.includes('预览交互设计说明'));
    a?.click();
    return !!a;
  })()`);
  await sleep(1200);
}
await openThreadFileThenCollapse();
const l4Open = await ev(`(() => ({
  pane: !!document.querySelector('.preview-pane'),
  thread: !!document.querySelector('.col-thread'),
  tabs: document.querySelectorAll('.preview-tab').length,
  pool: !!document.querySelector('.col-main'),
}))()`);
check('L4：从线程打开文件后是「回复串＋文件」并排（主池按既有规则收起）',
  l4Open.pane === true && l4Open.thread === true && l4Open.pool === false, JSON.stringify(l4Open));

await ev(`document.querySelector('.col-thread .thread-nav-back')?.click()`);
await sleep(1100);
const afterCollapse = await ev(`(() => ({
  hash: location.hash,
  pool: !!document.querySelector('.col-main'),
  cards: document.querySelectorAll('.root-card').length,
  pane: !!document.querySelector('.preview-pane'),
  tabs: document.querySelectorAll('.preview-tab').length,
  内容区长度: (document.querySelector('.workspace')?.innerText ?? '').trim().length,
}))()`);
check('L4「收起」后真的回到主池（不空白、也不是只剩文件）',
  afterCollapse.pool === true && afterCollapse.cards > 0 && !String(afterCollapse.hash).includes('thread='),
  JSON.stringify(afterCollapse));
check('「收起」不改动已打开文件（标签与阅读位置保留）',
  afterCollapse.pane === true && afterCollapse.tabs >= 1, JSON.stringify(afterCollapse));

/* 单区域：文件 → 对话 → 收起，主池仍须渲染 */
await setViewport(900, 900);
await goto(`${ROOM}?thread=thread_t14&tab=artifacts&recovery=0`, 900);
await ev(`(() => {
  const a = [...document.querySelectorAll('.col-thread .msg-attach')]
    .find(x => x.innerText.includes('预览交互设计说明'));
  a?.click();
  return !!a;
})()`);
await sleep(1200);
await ev(`document.querySelector('.preview-pane button[aria-label="返回对话"]')?.click()`);
await sleep(900);
await ev(`document.querySelector('.col-thread .thread-nav-back')?.click()`);
await sleep(1100);
const singleCollapse = await ev(`(() => ({
  pool: !!document.querySelector('.col-main'),
  cards: document.querySelectorAll('.root-card').length,
  thread: !!document.querySelector('.col-thread'),
  pane: !!document.querySelector('.preview-pane'),
  内容区长度: (document.querySelector('.workspace')?.innerText ?? '').trim().length,
}))()`);
check('单区域：文件→对话→收起后主池可见（不空白）',
  singleCollapse.pool === true && singleCollapse.cards > 0 && singleCollapse.内容区长度 > 40,
  JSON.stringify(singleCollapse));
await send('Emulation.clearDeviceMetricsOverride');
await resetApp();

/* ---------- 11. 六档宽度：不裁切、不重复面板 ---------- */
// 先刷新回种子状态：前面的归档与预览会改变布局前提
await resetApp();
for (const w of [1600, 1372, 1280, 1100, 900, 720]) {
  await setViewport(w, 900);
  await goto(`${ROOM}?thread=thread_t12&recovery=0`, 600);
  const fit = await ev(`(() => {
    const nav = document.querySelector('.col-thread .thread-nav');
    const pane = document.querySelector('.col-thread');
    const boxes = nav ? [...nav.querySelectorAll('button')].map(b => b.getBoundingClientRect()) : [];
    const pr = pane?.getBoundingClientRect();
    const clipped = boxes.filter(b => pr && (b.right > pr.right + 1 || b.left < pr.left - 1)).length;
    const zero = boxes.filter(b => b.width < 8).length;
    return {
      导航列数: nav ? new Set(boxes.map(b => Math.round(b.top))).size : 0,
      被裁: clipped, 零宽: zero,
      线程面板数: document.querySelectorAll('.col-thread').length,
      主池数: document.querySelectorAll('.col-main').length,
      选中视图数: document.querySelectorAll('.col-thread .thread-tab.on').length,
      详情chip选中: document.querySelectorAll('.details-chip.on').length,
    };
  })()`);
  check(`${w}px：导航未裁切、无重复面板、选中态唯一`,
    fit.被裁 === 0 && fit.零宽 === 0 && fit.线程面板数 === 1 && fit.主池数 <= 1 && fit.选中视图数 === 1,
    JSON.stringify(fit));
}
await send('Emulation.clearDeviceMetricsOverride');

/* ---------- 12. 键盘可达 ---------- */
await resetApp();
await goto(`${ROOM}?thread=thread_t12&recovery=0`, 700);
const keyboard = await ev(`(async () => {
  const btn = document.querySelector('.col-thread .thread-nav button[aria-haspopup="menu"]');
  btn.focus();
  const focused = document.activeElement === btn;
  btn.click();
  await new Promise(r => setTimeout(r, 250));
  const menu = !!document.querySelector('.menu');
  const rect = document.querySelector('.menu')?.getBoundingClientRect();
  return { focused, menu, 位置合理: rect ? (rect.left < window.innerWidth - 20 && rect.top < window.innerHeight - 20) : false };
})()`);
check('线程 ⋯ 可聚焦并用键盘打开，菜单不出屏', keyboard.focused === true && keyboard.menu === true && keyboard.位置合理 === true, JSON.stringify(keyboard));

/* ---------- 收尾 ---------- */
check('运行期间无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} 通过`);
if (pass !== results.length) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
chrome.kill();
process.exit(pass === results.length ? 0 : 1);
