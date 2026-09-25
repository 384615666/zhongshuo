/** 截可选任务验收相关界面。 */
const PORT = '9333';
import { writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; p.set(i, (m) => res(m)); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { ws, send, ev };
}

let c = await connect();
await c.ev(`window.zhongshuo?.window.show()`);
await c.send('Page.enable');
await c.send('Page.reload', { ignoreCache: true });
c.ws.close();
await sleep(3000);
c = await connect();
await c.ev(`(() => { const m=document.querySelector('.modal'); if(m){const b=[...m.querySelectorAll('.btn')].find(x=>/稍后处理/.test(x.textContent)); if(b) b.click();} return true; })()`);
await sleep(400);

async function shot(name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    writeFileSync(`D:/zhongshuo/hifi-prototype/screenshots-desktop/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('OK', name);
  } else console.log('MISS', name);
}

// 交付详情（验收主入口）
await c.ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t13&tab=delivery'; true`);
await sleep(2400);
await shot('25-delivery-pending');

// 要求修改后（返工态）
await c.ev(`
  (() => {
    const ta = document.querySelector('.thread-embed textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '请把「未执行验证」也写进交付说明，我需要看见没跑的那条');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(400);
await c.ev(`(() => { const b=[...document.querySelectorAll('.thread-embed .btn')].find(x=>x.textContent.includes('要求修改')); if(b) b.click(); return !!b; })()`);
await sleep(900);
await shot('26-delivery-changes-requested');

// 设置页开关
await c.ev(`location.hash='/settings'; true`);
await sleep(1600);
await c.ev(`(() => { const b=[...document.querySelectorAll('.page .btn')].find(x=>x.textContent.includes('并发与预算')); if(b) b.click(); return !!b; })()`);
await sleep(900);
await shot('27-settings-task-review');

// 待我处理（去重后的一条验收卡）
await c.ev(`location.hash='/activity'; true`);
await sleep(1800);
await shot('28-activity-review-dedup');

c.ws.close();
