/**
 * 私信输入区专项验收（浏览器宿主）。
 *
 * 两个来源：
 *  1. 2026-09-24 用户反馈"私信的输入栏缺少附件、权限等组件" → 私信输入区与房间同源；
 *  2. **2026-09-25 用户要求给私聊做减法**："去掉小群功能，也不需要区分什么任务/讨论，
 *     @ 也去掉，像『只唤醒 Claude；其他成员零调用』『独立可见范围』这种描述也去掉"。
 *
 * 所以本套件断言的是**收敛后的形态**（而不是把旧断言删掉）：
 *  1. 私信输入区**只有**：附件、权限档位、本次运行设置、发送（+ 归档态的取消归档）；
 *  2. **没有**：任务/讨论切换、@ 提及、独立可见范围声明、只唤醒 X 说明行；
 *  3. 私聊是 1 对 1：新建弹窗是单选、列表里不存在小群/多成员会话；
 *  4. 附件仍然真的落地（DM-02）、仍按该会话 audience 隔离（切到群聊暂藏）；
 *  5. 任务/讨论不分了，但**任务号仍不伪造**（R4 未接通写在「本次运行设置」里）；
 *  6. 归档私信只读、草稿按会话隔离、房间侧未被改坏、运行期无控制台错误。
 *
 * 用法：
 *   npx vite --port 5284 --strictPort          # 另开终端
 *   node scripts/verify-dm-composer.mjs http://localhost:5284
 *
 * 端口约定：ZS_DMC_CDP_PORT，默认 **9338**
 * （与 Electron 9333 / smoke 9334 / 视觉预览 9335 / declutter 9336 / 150% 探针 9337 错开）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = Number(process.env.ZS_DMC_CDP_PORT ?? 9338);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) {
  console.error('找不到 Chrome/Edge');
  process.exit(1);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + process.env.TEMP + '\\zs-dm-composer',
    '--no-first-run',
    '--window-size=1680,1050',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
await sleep(2000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('找不到页面 target');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleErrors.push(m.params.entry.text);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => {
      pending.delete(i);
      res({});
    }, 15000);
    pending.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate 失败');
  return r.result?.result?.value;
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function reset(hash, wait = 3200) {
  await ev(`location.href = ${JSON.stringify(BASE)} + ${JSON.stringify(hash)}; true`);
  await sleep(900);
  await ev('location.reload(); true');
  await sleep(wait);
}
async function setTextarea(text) {
  await ev(`(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
}
const composerState = `(() => {
  const box = document.querySelector('.composer');
  const txt = (el) => (el ? (el.innerText || '').replace(/\\n/g, ' ').trim() : null);
  return {
    有条: !!box,
    整条文字: txt(box),
    分段: [...(box?.querySelectorAll('.composer-toolbar .seg button') ?? [])].map((b) => b.innerText.trim()),
    附件按钮: !![...(box?.querySelectorAll('.composer-toolbar .icon-btn') ?? [])].find((b) => (b.getAttribute('title') || '').includes('添加附件')),
    提及按钮: !![...(box?.querySelectorAll('.composer-toolbar .icon-btn') ?? [])].find((b) => /提及成员|@/.test(b.getAttribute('title') || '')),
    运行设置按钮: !![...(box?.querySelectorAll('button') ?? [])].find((b) => (b.getAttribute('aria-label') || '') === '本次运行设置'),
    权限档位: txt(box?.querySelector('.access-trigger')),
    预算chip: txt(box?.querySelector('.composer-budget')),
    方式芯片: txt(box?.querySelector('.method-chip')),
    范围chip: txt(box?.querySelector('.intent-tag')),
    状态行: txt(box?.querySelector('.composer-status')),
    发送文案: txt(box?.querySelector('.composer-send')),
    发送禁用: Boolean(box?.querySelector('.composer-send')?.disabled),
    禁用提示: txt(box?.querySelector('.composer-budget')),
    占位: box?.querySelector('textarea')?.getAttribute('placeholder') ?? null,
    附件芯片: [...(box?.querySelectorAll('.composer-mentions .chip') ?? [])]
      .map((x) => (x.innerText || '').replace(/\\n/g, ' ').trim())
      .filter((t) => t.includes('.png') || t.includes('附件')),
  };
})()`;

/* ============================================================
   1. 私信输入区：只剩该有的（附件 / 权限 / 运行设置 / 发送）
   ============================================================ */
await reset('#/project/proj_zs_01/dm?recovery=0');
const dm = await ev(composerState);
check(
  '私信输入区保留：附件、权限档位、本次运行设置、发送',
  dm?.有条 === true && dm.附件按钮 === true && dm.运行设置按钮 === true && dm.权限档位 === '计划模式'
    && dm.发送文案 === '发送',
  JSON.stringify({ 附件: dm?.附件按钮, 权限: dm?.权限档位, 运行设置: dm?.运行设置按钮, 发送: dm?.发送文案 }),
);
check(
  '私信输入区已去掉：任务/讨论切换与 @ 提及',
  (dm?.分段 || []).length === 0 && dm?.提及按钮 === false,
  JSON.stringify({ 分段: dm?.分段, 提及按钮: dm?.提及按钮 }),
);
check(
  '私信输入区已去掉说明性文字：「独立可见范围」与「只唤醒 X；其他成员零调用」',
  dm?.范围chip === null && dm?.状态行 === null && !String(dm?.整条文字 ?? '').includes('只唤醒')
    && !String(dm?.整条文字 ?? '').includes('独立可见范围'),
  JSON.stringify({ 范围chip: dm?.范围chip, 状态行: dm?.状态行, 整条: dm?.整条文字 }),
);
check(
  '私信会话头部也不再挂「独立可见范围」面板',
  (await ev(`!document.querySelector('.thread-head')?.innerText.includes('独立可见范围')
    && !document.querySelector('.thread-head')?.innerText.includes('只有这些参与者能看到')`)) === true,
  '头部文字已核对',
);
check('私信占位是简单的一句"给 X 发消息…"',
  typeof dm?.占位 === 'string' && dm.占位.startsWith('给 ') && dm.占位.includes('发消息'), dm?.占位);

/* 输入 @ 不应弹提及候选（@ 已去掉） */
await setTextarea('@');
const mentionPop = await ev(`document.querySelectorAll('.mention-pop').length`);
check('输入 @ 不再弹提及候选（@ 已从私信移除）', mentionPop === 0, `mention-pop=${mentionPop}`);
await ev(`(() => {
  const ta = document.querySelector('.composer textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(200);

/* ============================================================
   2. 本次运行设置：三段仍在，且私信口径诚实（R4 未接通）
   ============================================================ */
await ev(`(() => {
  const b = [...document.querySelectorAll('.composer button')].find((x) => (x.getAttribute('aria-label') || '') === '本次运行设置');
  b?.click();
  return !!b;
})()`);
await sleep(450);
const menu = await ev(`(() => {
  const m = [...document.querySelectorAll('.menu')].at(-1);
  return {
    段: [...(m?.querySelectorAll('.menu-note .row.tight') ?? [])].map((r) => r.innerText.trim()),
    文字: (m?.innerText || '').replace(/\\n/g, ' | '),
  };
})()`);
check('本次运行设置仍是方式/预算/权限三节', (menu.段 || []).length === 3, JSON.stringify(menu.段));
check(
  '私信里"预算"一节如实说明暂不创建任务（且**不出现内部条目引用** —— 产品界面不写「R4」「§x.y」）',
  String(menu.文字).includes('暂不创建任务') && String(menu.文字).includes('不占用任务预算')
    && !String(menu.文字).includes('R4') && !/§\d/.test(String(menu.文字)),
  String(menu.文字).slice(0, 170),
);
check(
  '「权限档位」一节不再重复下拉里的那段原型说明（同一句话只出现一次）',
  (String(menu.文字).match(/尚未连接实际执行服务/g) || []).length === 0
    && (String(menu.文字).match(/权限限制与确认通道尚未验证/g) || []).length === 0,
  '菜单内未出现那段说明',
);
/* 真实操作路径：菜单开着时它盖住权限档位按钮，先 Esc 关掉再真实点击 */
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await sleep(400);
const afterEsc = await ev(`document.querySelectorAll('.menu').length`);
const triggerBox = await ev(`(() => {
  const b = document.querySelector('.access-trigger');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`);
for (const type of ['mousePressed', 'mouseReleased']) {
  await send('Input.dispatchMouseEvent', { type, x: triggerBox.x, y: triggerBox.y, button: 'left', clickCount: 1 });
  await sleep(120);
}
await sleep(400);
const overlays = await ev(`(() => ({
  运行设置浮层: document.querySelectorAll('.menu').length,
  权限下拉: document.querySelectorAll('.access-menu').length,
}))()`);
check(
  '浮层不会叠着开：Esc 关掉运行设置后，真实点击才打开权限档位（此刻只有一个浮层）',
  afterEsc === 0 && overlays.运行设置浮层 === 0 && overlays.权限下拉 === 1,
  JSON.stringify({ Esc后菜单数: afterEsc, ...overlays }),
);
const access = await ev(`(() => {
  const items = [...document.querySelectorAll('.access-menu .access-item')];
  return {
    档位数: items.length,
    不可用: items.filter((b) => b.classList.contains('unavailable')).map((b) => b.innerText.replace(/\\n/g, ' ').trim().slice(0, 20)),
  };
})()`);
check(
  '四档权限里未验证档位在私信同样不可选（含"待验证"标记）',
  access.档位数 === 4 && (access.不可用 || []).length === 1 && (access.不可用 || [])[0].includes('变更前确认'),
  JSON.stringify(access),
);
await ev(`document.querySelector('.access-scrim')?.click(); true`);
await sleep(300);

/* ============================================================
   3. 发送：只是"发给该成员"，不伪造任务号
   ============================================================ */
await setTextarea('私信收敛验证：这条只是发给这个成员');
await ev(`document.querySelector('.composer-send')?.click(); true`);
await sleep(900);
const sent = await ev(`(() => {
  const msgs = [...document.querySelectorAll('.msg')];
  const last = msgs[msgs.length - 1];
  const toasts = [...document.querySelectorAll('.toast')].map((t) => t.innerText.trim());
  return {
    末条文字: last?.querySelector('.msg-text')?.innerText.trim() ?? null,
    任务卡数: document.querySelectorAll('.root-card, .task-card, .delivery-card').length,
    末条有任务号徽标: Boolean(last?.querySelector('.task-no, .root-no, [data-task-number]')),
    末条是普通消息: Boolean(last?.querySelector('.msg-text')) && !last?.querySelector('.task-card'),
    toasts,
  };
})()`);
check(
  '发送就是发给该成员：消息进入会话、提示不再提"任务/讨论"',
  sent.末条文字 === '私信收敛验证：这条只是发给这个成员'
    && (sent.toasts || []).some((t) => t.includes('已发给'))
    && !(sent.toasts || []).some((t) => t.includes('未调用模型')),
  JSON.stringify(sent.toasts),
);
check(
  '私信不伪造任务号：无任务卡、无任务号徽标，消息就是普通消息',
  sent.任务卡数 === 0 && sent.末条有任务号徽标 === false && sent.末条是普通消息 === true,
  JSON.stringify({ 任务卡数: sent.任务卡数, 徽标: sent.末条有任务号徽标 }),
);

/* ============================================================
   4. 附件仍然真的落地 + audience 隔离
   ============================================================ */
await ev(`(() => {
  const b = [...document.querySelectorAll('.composer-toolbar .icon-btn')].find((x) => (x.getAttribute('title') || '').includes('添加附件'));
  b?.click();
  return !!b;
})()`);
await sleep(300);
const withAtt = await ev(composerState);
check('点附件后输入区出现待发附件芯片', (withAtt?.附件芯片 || []).length === 1, JSON.stringify(withAtt?.附件芯片));
await setTextarea('私信附件落地验证');
await ev(`document.querySelector('.composer-send')?.click(); true`);
await sleep(900);
const afterSend = await ev(`(() => {
  const msgs = [...document.querySelectorAll('.msg')];
  const last = msgs[msgs.length - 1];
  return { 末条附件: [...(last?.querySelectorAll('.msg-attach') ?? [])].map((x) => x.innerText.replace(/\\n/g, ' ').trim()) };
})()`);
check(
  '附件不再是空芯片：发送后消息上出现真实附件',
  (afterSend.末条附件 || []).some((a) => a.includes('附件-1.png')),
  JSON.stringify(afterSend.末条附件),
);

await ev(`(() => { const a = [...document.querySelectorAll('.msg-attach')].at(-1); a?.click(); return !!a; })()`);
await sleep(1300);
const opened = await ev(`(() => {
  const pane = document.querySelector('.preview-pane');
  return {
    pane: !!pane,
    tabs: [...document.querySelectorAll('.preview-tab-label')].map((t) => t.innerText.trim()),
    origin: pane?.querySelector('.preview-origin')?.innerText.replace(/\\n/g, ' ').trim() ?? '',
    img: !!pane?.querySelector('.preview-image'),
  };
})()`);
check(
  '新附件能从私信打开共享预览（来源标注为"私信"、标签带版本）',
  opened?.pane === true && (opened.tabs || []).some((t) => t.includes('附件-1.png') && t.includes('v1'))
    && opened.origin.includes('私信') && opened.img === true,
  JSON.stringify(opened),
);

await ev(`location.hash = '/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await sleep(1600);
const leaked = await ev(`(() => {
  const text = [...document.querySelectorAll('.preview-pane')].map((p) => p.innerText).join('\\n');
  return { 泄露文件名: text.includes('附件-1.png'), 标签: [...document.querySelectorAll('.preview-tab-label')].map((t) => t.innerText.trim()) };
})()`);
check('切到群聊后私信附件标签暂藏且不泄露文件名（§17.9 第 7 条）', leaked?.泄露文件名 === false, JSON.stringify(leaked));

/* ============================================================
   5. 私聊是 1 对 1：没有小群
   ============================================================ */
await reset('#/project/proj_zs_01/dm?recovery=0');
const listState = await ev(`(() => {
  const rows = [...document.querySelectorAll('.dm-row')];
  return {
    行数: rows.length,
    含小群字样: rows.filter((r) => r.innerText.includes('小群')).length,
    多人会话: rows.filter((r) => (r.querySelectorAll('.dm-row-avatars > *').length ?? 0) > 1).length,
  };
})()`);
check(
  '私信列表里没有小群/多成员会话（种子已改为 1 对 1）',
  listState.含小群字样 === 0 && listState.多人会话 === 0,
  JSON.stringify(listState),
);
/* 新建弹窗：单选 */
await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /新建私聊/.test(x.getAttribute('title') || '')); b?.click(); return !!b; })()`);
await sleep(700);
const modal = await ev(`(() => {
  const m = document.querySelector('.modal');
  const inputs = [...(m?.querySelectorAll('.wpolicy input') ?? [])];
  return {
    有弹窗: !!m,
    输入类型: [...new Set(inputs.map((i) => i.type))],
    复选框数: inputs.filter((i) => i.type === 'checkbox').length,
    单选数: inputs.filter((i) => i.type === 'radio').length,
    文案: (m?.innerText || '').replace(/\\n/g, ' | ').slice(0, 160),
  };
})()`);
check(
  '新建私聊弹窗是单选（1 对 1），不再有"可多选组小群"',
  modal.有弹窗 === true && modal.复选框数 === 0 && modal.单选数 >= 2
    && !String(modal.文案).includes('小群') && !String(modal.文案).includes('多选'),
  JSON.stringify(modal),
);
/* 用例迁移（第十七批）：React 的受控单选框在 click 后是**异步**重渲染的，
   同步读 checked 会读到 0（新加的"项目"下拉多了一次渲染，把原本踩线的时序暴露出来）。
   这里改成点击后等一拍再读，断言语义不变（连点两位成员只能留下一位）。 */
const pickedTwo = await ev(`(async () => {
  const rows = [...document.querySelectorAll('.modal .wpolicy input')];
  rows[0]?.click();
  rows[1]?.click();
  await new Promise((r) => setTimeout(r, 250));
  return [...document.querySelectorAll('.modal .wpolicy input')].filter((i) => i.checked).length;
})()`);
check('连点两位成员只会保留一位（单选语义）', pickedTwo === 1, `checked=${pickedTwo}`);
await ev(`(() => { const b = [...document.querySelectorAll('.modal .btn')].find((x) => x.innerText.includes('取消')); b?.click(); return !!b; })()`);
await sleep(400);

/* ============================================================
   6. 归档私信：只读（输入框禁用 + 只读视觉）
   ============================================================ */
await reset('#/project/proj_zs_01/dm?recovery=0');
await ev(`(() => {
  const toggle = [...document.querySelectorAll('button')].find((x) => x.innerText.includes('已归档'));
  toggle?.click();
  return !!toggle;
})()`);
await sleep(900);
await ev(`(() => {
  const row = [...document.querySelectorAll('.dm-row')].find((r) => r.className.includes('archived'));
  row?.click();
  return !!row;
})()`);
await sleep(1000);
const arch = await ev(composerState);
const archInput = await ev(`(() => {
  const ta = document.querySelector('.composer-input');
  const cs = ta ? getComputedStyle(ta) : null;
  const writable = document.createElement('textarea');
  writable.className = 'composer-input';
  document.body.appendChild(writable);
  const normal = getComputedStyle(writable).color;
  writable.remove();
  return {
    disabled: ta?.disabled === true,
    placeholder: ta?.placeholder ?? '',
    color: cs?.color ?? null,
    cursor: cs?.cursor ?? null,
    可写态颜色: normal,
  };
})()`);
check(
  '归档私信只读：输入框禁用 + 发送禁用 + 说明写"只读"（不退化成"能写但发不出去"）',
  archInput.disabled === true && archInput.placeholder.includes('已归档')
    && arch?.发送禁用 === true && (arch.禁用提示 || '').includes('只读'),
  JSON.stringify({ 输入框: archInput, 禁用: arch?.发送禁用, 提示: arch?.禁用提示 }),
);
check(
  '只读态的输入框在视觉上也与可写态可区分（不是只靠文字说明）',
  archInput.disabled === true && archInput.color !== archInput.可写态颜色 && archInput.cursor === 'not-allowed',
  JSON.stringify({ 只读色: archInput.color, 可写色: archInput.可写态颜色, 光标: archInput.cursor }),
);
check('归档私信提供「取消归档」入口（不再是提示指路却找不到按钮）',
  (await ev(`[...document.querySelectorAll('.composer button')].some((b) => b.innerText.includes('取消归档'))`)) === true,
  'composer 操作簇内',
);
const archControls = await ev(`(() => {
  const btn = (txt) => [...document.querySelectorAll('.composer button')].find((b) => (b.getAttribute('title') || '').includes(txt));
  const clip = btn('添加附件');
  const acc = document.querySelector('.access-trigger');
  return {
    附件禁用: clip?.disabled === true,
    权限禁用: acc?.disabled === true,
    /* 视觉上也要看得出来（第一版只有 disabled 属性、看起来和可写态一样，
       视觉核对对比 d01/d06 时抓出来的） */
    附件透明度: clip ? getComputedStyle(clip).opacity : null,
    权限透明度: acc ? getComputedStyle(acc).opacity : null,
    权限光标: acc ? getComputedStyle(acc).cursor : null,
  };
})()`);
check(
  '只读态下附件与权限档位一并禁用（输入框都写不了，还能改档位/塞附件是自相矛盾的）',
  archControls.附件禁用 === true && archControls.权限禁用 === true,
  JSON.stringify(archControls),
);
check(
  '只读态的附件/权限控件在视觉上也被压暗（与可写态可区分，不是只加 disabled 属性）',
  Number(archControls.附件透明度) < 1 && Number(archControls.权限透明度) < 1
    && archControls.权限光标 === 'not-allowed',
  JSON.stringify({ 附件透明度: archControls.附件透明度, 权限透明度: archControls.权限透明度, 光标: archControls.权限光标 }),
);

/* ============================================================
   7. 草稿按会话隔离
   ============================================================ */
await reset('#/project/proj_zs_01/dm?recovery=0');
await setTextarea('会话 A 的未发送草稿');
await ev(`(() => {
  const rows = [...document.querySelectorAll('.dm-row')];
  const other = rows.find((r) => !r.className.includes('on') && !r.innerText.includes('已归档'));
  other?.click();
  return !!other;
})()`);
await sleep(900);
const otherDraft = await ev(`document.querySelector('.composer textarea')?.value ?? null`);
await ev(`(() => {
  const rows = [...document.querySelectorAll('.dm-row')];
  const first = rows.find((r) => r.className.includes('on'));
  const back = rows[0] !== first ? rows[0] : rows[1];
  back?.click();
  return true;
})()`);
await sleep(900);
const backDraft = await ev(`document.querySelector('.composer textarea')?.value ?? null`);
check(
  '草稿按会话隔离：换个私信不串草稿，切回来还在',
  otherDraft === '' && backDraft === '会话 A 的未发送草稿',
  JSON.stringify({ 另一会话: otherDraft, 切回: backDraft }),
);

/* ============================================================
   8. 房间侧未被改坏：协作控件仍在，附件同样落地
   ============================================================ */
await reset('#/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&tab=replies&recovery=0');
const roomBox = await ev(`(() => {
  const box = document.querySelector('.col-thread .composer');
  const txt = (el) => (el ? (el.innerText || '').replace(/\\n/g, ' ').trim() : null);
  return {
    分段: [...(box?.querySelectorAll('.composer-toolbar .seg button') ?? [])].map((b) => b.innerText.trim()),
    附件按钮: !![...(box?.querySelectorAll('.composer-toolbar .icon-btn') ?? [])].find((b) => (b.getAttribute('title') || '').includes('添加附件')),
    提及按钮: !![...(box?.querySelectorAll('.composer-toolbar .icon-btn') ?? [])].find((b) => (b.getAttribute('title') || '').includes('提及成员')),
    权限档位: txt(box?.querySelector('.access-trigger')),
    状态行: txt(box?.querySelector('.composer-status')),
  };
})()`);
check(
  '房间/线程输入区未被改坏：已无常驻「任务/讨论」分段，附件、@提及、权限档位都在，且没有私信状态行',
  roomBox?.分段?.length === 0 && roomBox.附件按钮 === true && roomBox.提及按钮 === true
    && roomBox.权限档位 === '计划模式' && roomBox.状态行 === null,
  JSON.stringify(roomBox),
);

await ev(`(() => {
  const b = [...document.querySelectorAll('.col-thread .composer-toolbar button')]
    .find((x) => (x.getAttribute('title') || '').includes('添加附件'));
  b?.click();
  return !!b;
})()`);
await sleep(300);
await ev(`(() => {
  const ta = document.querySelector('.col-thread .composer textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '房间附件落地验证');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(300);
await ev(`document.querySelector('.col-thread .composer-send')?.click(); true`);
await sleep(1000);
const roomAtt = await ev(`(() => {
  const msgs = [...document.querySelectorAll('.col-thread .msg')];
  const last = msgs[msgs.length - 1];
  return [...(last?.querySelectorAll('.msg-attach') ?? [])].map((x) => x.innerText.replace(/\\n/g, ' ').trim());
})()`);
check('房间消息的附件同样真的落地（不是空芯片）', (roomAtt || []).some((a) => a.includes('附件-1.png')), JSON.stringify(roomAtt));

/* ============================================================
   9. 运行期无控制台错误
   ============================================================ */
check('运行期无控制台错误', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
if (passed !== results.length) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  · ${r.name} ${r.detail ?? ''}`);
}
ws.close();
/**
 * 收尾：Windows 上 `chrome.kill()` 只结束启动器进程，GPU/渲染等子进程会留下来
 * （实测连跑几次后残留 7 个 headless chrome）。这里按 PID 结束整棵进程树。
 */
if (process.platform === 'win32') {
  spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
} else {
  chrome.kill();
}
process.exit(passed === results.length ? 0 : 1);
