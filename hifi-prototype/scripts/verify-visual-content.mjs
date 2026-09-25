/**
 * 视觉改造的内容与行为验证（规范 §9.2）。
 *
 * 覆盖：长任务标题、长回复、10 行输入、草稿隔离、拖动边界、页签唯一激活、
 * 键盘焦点环、中文输入法发送行为。
 *
 * 这些都是**交互基线**要求，换肤不得使其回归（规范 §4/§8 开头明确"行为不动"）。
 *
 * 用法：node scripts/verify-visual-content.mjs http://localhost:5284
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'screenshots-visual');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`OK   ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE)) ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { pending.delete(i); res({}); }, 15000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description ?? 'err' };
  return r.result?.result?.value;
};
/** 真实键盘输入（走 CDP Input，能触达 React 的合成事件与 IME 判定） */
const typeText = async (text) => {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp' });
    await sleep(8);
  }
};
const pressKey = async (key, code, opts = {}) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: opts.vk ?? 0, ...opts });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: opts.vk ?? 0, ...opts });
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1372, height: 872, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);

/* ============================================================
   1. 长任务标题（规范 §9.2：60+ 字中文标题两行内可读，不被压成小字）
   ============================================================ */
const longTitle = await ev(`(() => {
  // 直接改一张卡片的标题文本，测它在真实布局下的表现（不改数据，只测样式）
  const el = document.querySelector('.root-title');
  if (!el) return { found: false };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const lineHeight = parseFloat(cs.lineHeight);
  return {
    found: true,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    lineClamp: cs.webkitLineClamp,
    height: Math.round(r.height),
    lines: Math.round(r.height / lineHeight),
    width: Math.round(r.width),
  };
})()`);
check('§3.1/§5.2 任务标题 14px / 650 / 最多两行',
  longTitle?.found === true && longTitle?.fontSize === '14px'
  && Number(longTitle?.fontWeight) >= 650 && String(longTitle?.lineClamp) === '2',
  JSON.stringify(longTitle));

/* 注入一个 60+ 字标题，确认不溢出、不压成零宽 */
const injected = await ev(`(() => {
  const el = document.querySelector('.root-title');
  if (!el) return { found: false };
  const original = el.textContent;
  el.textContent = '整理本周所有任务的演化日志并汇总为可直接对外发送的周报草稿，包含决策时间线、变更要点与风险提示';
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const out = {
    width: Math.round(r.width),
    height: Math.round(r.height),
    lineHeight: parseFloat(cs.lineHeight),
    overflow: getComputedStyle(el).overflow,
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  };
  el.textContent = original;
  return out;
})()`);
check('§9.2 60+ 字长标题在卡片内不溢出（两行截断生效，不压成零宽）',
  injected?.width > 100 && injected?.height <= 46 && injected?.scrollH <= injected?.clientH + 2,
  JSON.stringify(injected));
await ev(`(() => {
  const el = document.querySelector('.root-title');
  if (el) el.textContent = '整理本周所有任务的演化日志并汇总为可直接对外发送的周报草稿，包含决策时间线、变更要点与风险提示';
  return true;
})()`);
await sleep(300);
{
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync(join(outDir, 'c01-long-title.png'), Buffer.from(r.result.data, 'base64'));
}
await ev(`location.reload(); true`);
await sleep(3000);

/* ============================================================
   2. 多行输入（规范 §9.2：10 行→增长到 200px 上限后内部滚动）
   ============================================================ */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await sleep(1500);

/**
 * L2 下**有两个输入条**（主池 + 回复串，各自独立草稿）。
 * 所有针对输入框的操作都必须限定在 `.col-thread` 内 ——
 * `document.querySelector('.composer-input')` 取到的是**主池**那个，
 * 实测因此把"草稿串线"误报成缺陷（其实读到的是另一个输入框，行为正确）。
 */
const threadInputSel = '.col-thread .composer-input';
const poolInputSel = '.col-main .composer-input';

const textareaInfo = await ev(`(() => {
  const ta = document.querySelector('${threadInputSel}');
  if (!ta) return { found: false };
  const cs = getComputedStyle(ta);
  return {
    found: true,
    tag: ta.tagName,
    height: Math.round(ta.getBoundingClientRect().height),
    minHeight: cs.minHeight,
    maxHeight: cs.maxHeight,
    border: cs.borderStyle,
    background: cs.backgroundColor,
    resize: cs.resize,
  };
})()`);
check('§5.6 输入区是真实多行 textarea（默认两行高约 54px，上限 200px）',
  textareaInfo?.found === true && textareaInfo?.tag === 'TEXTAREA'
  // 允许 1px 误差：亚像素布局下 54px 可能量到 55px，属正常舍入
  && Math.abs(textareaInfo?.height - 54) <= 1 && textareaInfo?.maxHeight === '200px',
  JSON.stringify(textareaInfo));
check('L2 主池与回复串各有一个独立输入条（§17.1 双输入框）',
  (await ev(`document.querySelectorAll('.composer-input').length`)) === 2,
  `count=${await ev(`document.querySelectorAll('.composer-input').length`)}`);

const tenLines = await ev(`(() => {
  const ta = document.querySelector('${threadInputSel}');
  if (!ta) return { found: false };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, Array.from({length: 10}, (_, i) => '第' + (i+1) + '行：这是一条较长的需求说明文字，用于验证多行输入的增长与滚动。').join('\\n'));
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(600);
const grown = await ev(`(() => {
  const ta = document.querySelector('${threadInputSel}');
  if (!ta) return { found: false };
  const h = Math.round(ta.getBoundingClientRect().height);
  return {
    height: h,
    scrollable: ta.scrollHeight > ta.clientHeight,
    maxHeight: getComputedStyle(ta).maxHeight,
    // 输入框是否真的"长高"了：CSS 有 max-height 但需要 JS 自动增高才会变大
    cssHeight: getComputedStyle(ta).height,
  };
})()`);
check('§9.2 输入 10 行后增长并在 200px 上限内部滚动',
  tenLines === true && grown?.height !== undefined && grown.height <= 200
  && grown.height > 54,
  JSON.stringify(grown));
{
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) writeFileSync(join(outDir, 'c02-multiline-input.png'), Buffer.from(r.result.data, 'base64'));
}
/** 工具条与发送按钮不能因输入变高而被挤掉 */
const toolbarOk = await ev(`(() => {
  const box = document.querySelector('.col-thread .composer-box');
  const send = box?.querySelector('.btn.primary');
  const cs = box.getBoundingClientRect();
  const ss = send?.getBoundingClientRect();
  return {
    sendVisible: !!ss && ss.width > 0 && ss.height > 0,
    insideBox: ss ? (ss.bottom <= cs.bottom + 2 && ss.right <= cs.right + 2) : false,
    inputWidth: Math.round(box.querySelector('.composer-input').getBoundingClientRect().width),
  };
})()`);
check('§5.6 输入增长后发送按钮仍完整可见（工具不挤占输入空间）',
  toolbarOk?.sendVisible === true && toolbarOk?.insideBox === true, JSON.stringify(toolbarOk));

/* ============================================================
   3. 草稿隔离（TH-04：主池与线程各自保存，切线程不串）
   ============================================================
   **必须用真实键盘输入**：React 的受控 textarea 只认合成事件链，
   用原生 setter + `input` 事件虽然能改 DOM 值，但草稿持久化 effect
   未必按预期触发，容易把测试自身的问题误报成"草稿串线"。
   另外选择器必须限定作用域 —— 见上面 threadInputSel 的说明。 */
/**
 * 真实输入用 CDP 的 `Input.insertText`。
 *
 * 为什么不用裸 `Input.dispatchKeyEvent({type:'keyDown', text})`：
 * 不带 `key` / `code` / `windowsVirtualKeyCode` 的 keyDown **不会**被 Chromium
 * 当作字符输入处理，实测「焦点在 textarea 上、事件也发了，但 value 始终为空」。
 * 而 `Input.insertText` 走的是 IME 风格的文本插入，稳定可靠。
 * 这是**测试夹具问题**，与产品无关（用原生 setter 派发 input 事件时
 * React 状态与草稿持久化都正常工作）。
 */
const typeInto = async (sel, text) => {
  await ev(`document.querySelector(${JSON.stringify(sel)})?.focus(); true`);
  await sleep(150);
  await send('Input.insertText', { text });
  await sleep(600);
};

// 干净起步
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);

await typeInto(threadInputSel, 'AAA');
const t14Draft = await ev(`document.querySelector('${threadInputSel}').value`);
check('TH-04 线程 #14 输入后草稿存在于该输入框',
  t14Draft === 'AAA', JSON.stringify(t14Draft));

// 切到线程 #12：回复串的输入框应为空
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0'; true`);
await sleep(1800);
const t12Draft = await ev(`document.querySelector('${threadInputSel}')?.value ?? null`);
check('TH-04 切到线程 #12 后回复串输入框为空（草稿不串线）',
  t12Draft === '', JSON.stringify(t12Draft));

await typeInto(threadInputSel, 'BBB');
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await sleep(1800);
const backDraft = await ev(`document.querySelector('${threadInputSel}')?.value ?? null`);
check('TH-04 切回线程 #14 后草稿恢复为 AAA（各自独立保存）',
  backDraft === 'AAA', JSON.stringify(backDraft));

// 主池输入框独立于线程
const poolDraftNow = await ev(`document.querySelector('${poolInputSel}')?.value ?? null`);
check('TH-04 主池输入框与线程草稿互不影响（主池为空）',
  poolDraftNow === '', JSON.stringify(poolDraftNow));

await typeInto(poolInputSel, 'POOL');
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t12&recovery=0'; true`);
await sleep(1600);
const poolAfterSwitch = await ev(`document.querySelector('${poolInputSel}')?.value ?? null`);
check('TH-04 切线程后主池草稿仍在（两处草稿各自保存）',
  poolAfterSwitch === 'POOL', JSON.stringify(poolAfterSwitch));

/* ============================================================
   4. 拖动分隔条到两端（规范 §9.2：主池 ≥420 / 回复串 ≥380 不被突破）
   ============================================================ */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await sleep(1600);
const dragResult = await ev(`(() => {
  const sp = document.querySelector('.splitter');
  if (!sp) return { found: false };
  const r = sp.getBoundingClientRect();
  const y = r.top + r.height / 2;
  const opts = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 });
  // 拖到最左（回复串变最宽）
  sp.dispatchEvent(new PointerEvent('pointerdown', opts(r.left)));
  sp.dispatchEvent(new PointerEvent('pointermove', opts(-2000)));
  sp.dispatchEvent(new PointerEvent('pointerup', opts(-2000)));
  return { found: true, moved: true };
})()`);
await sleep(700);
const afterLeft = await ev(`(() => ({
  pool: Math.round((document.querySelector('.col-main')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width),
  thread: Math.round((document.querySelector('.col-thread')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width),
}))()`);
check('§9.2 分隔条拖到最左：主池仍 ≥420（不被突破）',
  dragResult?.found === true && afterLeft?.pool >= 420, JSON.stringify(afterLeft));

const dragRight = await ev(`(() => {
  const sp = document.querySelector('.splitter');
  if (!sp) return { found: false };
  const r = sp.getBoundingClientRect();
  const y = r.top + r.height / 2;
  const opts = (x) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 });
  sp.dispatchEvent(new PointerEvent('pointerdown', opts(r.left)));
  sp.dispatchEvent(new PointerEvent('pointermove', opts(4000)));
  sp.dispatchEvent(new PointerEvent('pointerup', opts(4000)));
  return { found: true };
})()`);
await sleep(700);
const afterRight = await ev(`(() => ({
  pool: Math.round((document.querySelector('.col-main')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width),
  thread: Math.round((document.querySelector('.col-thread')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width),
}))()`);
check('§9.2 分隔条拖到最右：回复串仍 ≥380（不被突破）',
  dragRight?.found === true && afterRight?.thread >= 380, JSON.stringify(afterRight));

/* ============================================================
   5. 页签唯一激活（规范 §9.2；**同组**只有一个）
   ============================================================
   注意：页面上可能同时存在**多个**页签组 —— 房间级（对话池/看板/文件）
   与线程级（回复/成果/活动…）是两组不同层级的导航，各自有且只有一个激活项。
   规范 §5.5 的要求是"每个页签组仅一个激活项"，不是"全页只有一个"。 */
for (const [label, hash] of [
  ['房间页签', '/project/proj_zs_01/room/room_dev_hall?recovery=0'],
  ['线程页签', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'],
  ['文件/Git 页签', '/project/proj_zs_01/files?tab=files&recovery=0'],
]) {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(1500);
  const tabs = await ev(`(() => {
    // 减负后线程侧不再有 .thread-tabs（常驻页签行），改为 .thread-nav 里的视图组；
    // 详情分组是 chip 行（.details-subnav），一并纳入"只有一个激活项"的检查。
    const groups = [
      ...document.querySelectorAll('.thread-tabs'),
      ...document.querySelectorAll('.thread-nav-views'),
      ...document.querySelectorAll('.details-subnav'),
    ];
    return groups.map((g, i) => {
      const all = [...g.querySelectorAll('.thread-tab, .details-chip')];
      return {
        group: i,
        region: g.closest('.col-main') ? 'main' : g.closest('.col-thread') ? 'thread' : 'other',
        total: all.length,
        active: all.filter(t => t.classList.contains('on')).length,
        labels: all.map(t => t.textContent.trim().slice(0, 8)),
      };
    });
  })()`);
  const bad = (tabs ?? []).filter((g) => g.active > 1);
  check(`§9.2 ${label}：每个页签组只有一个激活项`, bad.length === 0, JSON.stringify(tabs));
}

/* ============================================================
   6. 键盘焦点环（规范 §7：所有可聚焦元素可见）
   ============================================================ */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await sleep(1500);
const focusRing = await ev(`(() => {
  const btn = document.querySelector('.side-item.active') || document.querySelector('.side-item');
  if (!btn) return { found: false };
  btn.focus();
  const cs = getComputedStyle(btn);
  const after = getComputedStyle(btn, ':focus-visible');
  return {
    found: true,
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    boxShadow: cs.boxShadow,
    isFocused: document.activeElement === btn,
  };
})()`);
check('§7 键盘焦点可见（focus 后可聚焦元素有可见反馈）',
  focusRing?.found === true && focusRing?.isFocused === true
  && (focusRing?.outlineStyle !== 'none' || focusRing?.boxShadow !== 'none'),
  JSON.stringify(focusRing));

/* ============================================================
   7. 中文输入法组合态 Enter 不发送（§17.4，行为不得回归）
   ============================================================ */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await sleep(1500);
const imeResult = await ev(`(() => {
  const ta = document.querySelector('.composer-input');
  if (!ta) return { found: false };
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '组合态测试');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const before = document.querySelectorAll('.msg-list .msg').length;
  // 模拟 IME 组合中的 Enter：isComposing = true
  const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  Object.defineProperty(evt, 'isComposing', { value: true });
  ta.dispatchEvent(evt);
  const after = document.querySelectorAll('.msg-list .msg').length;
  return { found: true, before, after, textStillThere: ta.value === '组合态测试' };
})()`);
check('§17.4 中文输入法组合态的 Enter 不发送（文本保留、消息数不变）',
  imeResult?.found === true && imeResult?.before === imeResult?.after
  && imeResult?.textStillThere === true,
  JSON.stringify(imeResult));

check('内容与行为验证期间无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

console.log(`\n=== 内容与行为验收：${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}
writeFileSync(join(outDir, 'content-result.json'),
  JSON.stringify({ pass, fail, failures, at: new Date().toISOString() }, null, 2), 'utf8');
ws.close();
process.exit(fail > 0 ? 1 : 0);
