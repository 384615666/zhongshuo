/**
 * 探针：验证"快速双击会不会创建两个任务"（§17.4 不变量）。
 * 分两种情形：
 *   A. 同一 tick 内同步派发两次 click（程序化，最坏情况）
 *   B. 两次独立 click，中间让 React flush（真实用户双击）
 */

const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const p = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && p.has(m.id)) {
    p.get(m.id)(m);
    p.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => {
      p.delete(i);
      res({});
    }, 12000);
    p.set(i, (m) => {
      clearTimeout(t);
      res(m);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description };
  return { value: r.result?.result?.value };
};

const goto = async (hash) => {
  await ev(`location.hash=${JSON.stringify(hash)}; location.reload(); true`);
  await sleep(2800);
};

const countTasks = () => ev(`document.querySelectorAll('.root-card').length`);

/* ---------- A：同一 tick 同步两次 click ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
const beforeA = await countTasks();

await ev(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '双击测试 A：同一 tick 两次点击');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(400);

const aResult = await ev(`
  (() => {
    const btn = [...document.querySelectorAll('.composer-toolbar .btn.primary')].find(x => x.textContent.includes('发送'));
    if (!btn) return 'NO_BTN';
    // 同一个同步块里点两次：两次回调看到的是同一份 body/sending
    btn.click();
    btn.click();
    return 'clicked-twice';
  })()
`);
await sleep(1000);
const afterA = await countTasks();
console.log(`A 同一 tick 双击: ${aResult.value} | 任务 ${beforeA.value} → ${afterA.value} | 新增 ${afterA.value - beforeA.value}`);

/* ---------- B：两次独立 click，中间等 React flush ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
const beforeB = await countTasks();

await ev(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '双击测试 B：两次独立点击');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(400);

const clickSend = `
  (() => {
    const btn = [...document.querySelectorAll('.composer-toolbar .btn.primary')].find(x => x.textContent.includes('发送'));
    if (!btn) return 'NO_BTN';
    btn.click();
    return 'ok';
  })()
`;
await ev(clickSend);
await sleep(50); // 让 React flush（真实双击间隔通常 50—200ms）
await ev(clickSend);
await sleep(1200);
const afterB = await countTasks();
console.log(`B 间隔 50ms 双击: 任务 ${beforeB.value} → ${afterB.value} | 新增 ${afterB.value - beforeB.value}`);

/* ---------- C：Enter 与 click 混合（键盘+鼠标同时） ---------- */
await goto('/project/proj_zs_01/room/room_dev_hall?recovery=0');
const beforeC = await countTasks();
await ev(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '双击测试 C：Enter 与点击同时');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(400);
await ev(`
  (() => {
    const ta = document.querySelector('.composer-input');
    const btn = [...document.querySelectorAll('.composer-toolbar .btn.primary')].find(x => x.textContent.includes('发送'));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    btn.click();
    return true;
  })()
`);
await sleep(1200);
const afterC = await countTasks();
console.log(`C Enter+点击同 tick: 任务 ${beforeC.value} → ${afterC.value} | 新增 ${afterC.value - beforeC.value}`);

ws.close();
process.exit(0);
