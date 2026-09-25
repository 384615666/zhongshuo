/** 截新增成员对话框。 */
const PORT = process.env.ZS_CDP_PORT ?? '9333';
import { writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { p.delete(i); res({}); }, 15000);
  p.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    writeFileSync(`D:/zhongshuo/hifi-prototype/screenshots-desktop/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('OK  ', name);
  } else console.log('MISS', name);
};

await ev(`window.zhongshuo?.window.show()`);
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/welcome?recovery=0'; true`);
await sleep(400);
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3200);
await ev(`window.zhongshuo?.window.show()`);
await sleep(600);
await ev(`
  (() => {
    const m = document.querySelector('.modal');
    if (!m) return false;
    const b = [...m.querySelectorAll('.btn')].find(x => /暂不处理|关闭|取消/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(500);

// 1. 成员页（含添加按钮）
await ev(`location.hash='/project/proj_zs_01/members?recovery=0'; true`);
await sleep(1900);
await shot('49-members-page');

// 2. 添加成员对话框（填入同名以展示序号消歧）
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.btn')].find(x => x.innerText.includes('添加成员'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(900);
await ev(`
  (() => {
    const el = document.querySelector('.modal input.input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'Codex');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(800);
await shot('50-add-member-dialog');

ws.close();
