/**
 * 引用目标行为核验（交互规格 §7.2 引用目标 + §17.9 L4 保留线程）。
 *
 * 覆盖：
 *   1. 从线程成果打开文件（L4：线程 + 文件并排，线程不丢）；
 *   2. 「引用到」目标正确推导为任务（#n），不是"最后聚焦的输入框"；
 *   3. 点击引用后：内容进**线程草稿**（不直接发送）、焦点移到线程输入框、
 *      消息数不变、主池草稿不受影响。
 *
 * 用法：node scripts/verify-quote.mjs http://localhost:5284
 * 端口：ZS_VIS_CDP_PORT，默认 9335。
 */

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`OK   ${name}`); }
  else { fail++; failures.push({ name, detail }); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE)) ?? list.find((t) => t.type === 'page');
if (!page) { console.error('找不到页面 target'); process.exit(1); }
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
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
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
  return r.result?.result?.value;
};
const nav = async (hash) => {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(1200);
};

/* 1. 线程成果页打开文件（L4）
   用例更新（2026-09-24）：本脚本与视觉用例共用 9335 浏览器，页面里可能残留
   上一次用例打开的**主池来源预览**（内存态，跨 hash 导航保留）；那样布局会
   按"主池 + 文件"渲染，线程面板根本不挂载，断言会误判成"线程丢了"。
   因此先整页重载一次，回到干净的内存态再开始。 */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; location.reload(); true`);
await sleep(2600);
await nav('/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0');
const opened = await ev(`(() => {
  const c = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明'));
  if (!c) return { found: false };
  c.click();
  return { found: true };
})()`);
await sleep(1200);
check('L4：从线程成果打开文件', opened?.found === true, JSON.stringify(opened));
const l4 = await ev(`(() => ({
  threadVisible: !!document.querySelector('.col-thread'),
  previewVisible: !!document.querySelector('.preview-tab, .preview-tools'),
}))()`);
check('L4：线程保留 + 预览并排（主池不丢线程）',
  l4?.threadVisible === true && l4?.previewVisible === true, JSON.stringify(l4));

/* 2. 引用目标推导 */
const target = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('引用到'));
  if (!b) return { found: false };
  const ta = document.querySelector('.col-thread .composer-input');
  return { found: true, label: b.textContent.trim(), disabled: b.disabled, threadDraftBefore: ta?.value ?? null };
})()`);
check('§7.2 引用目标正确推导为任务（引用到 任务 #n）',
  target?.found === true && /任务 #\d+/.test(target?.label ?? ''), JSON.stringify(target));

/* 3. 点击引用：进线程草稿、聚焦、不发送 */
const before = await ev(`(() => ({
  msgs: document.querySelectorAll('.col-thread .msg-text').length,
  poolDraft: document.querySelector('.col-main .composer-input')?.value ?? null,
}))()`);
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('引用到')); if (b) b.click(); return true; })()`);
await sleep(800);
const after = await ev(`(() => {
  const ta = document.querySelector('.col-thread .composer-input');
  return {
    msgs: document.querySelectorAll('.col-thread .msg-text').length,
    threadDraft: ta?.value ?? null,
    focused: document.activeElement === ta,
    poolDraft: document.querySelector('.col-main .composer-input')?.value ?? null,
  };
})()`);
check('引用进入线程草稿（内容插入，非空）',
  typeof after?.threadDraft === 'string' && after.threadDraft.length > 0
  && after.threadDraft !== target?.threadDraftBefore, JSON.stringify({ before: target?.threadDraftBefore, after: after?.threadDraft }));
check('§7.2 引用后焦点移到线程输入框', after?.focused === true);
check('引用不直接发送（消息数不变）', after?.msgs === before?.msgs, `${before?.msgs} → ${after?.msgs}`);
check('主池草稿不受引用影响', after?.poolDraft === before?.poolDraft,
  JSON.stringify({ before: before?.poolDraft, after: after?.poolDraft }));

check('引用核验期间无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

console.log(`\n=== 引用目标核验：${pass} 通过 / ${fail} 失败 ===`);
if (fail) { for (const f of failures) console.log(`  · ${f.name}`); process.exit(1); }
process.exit(0);
