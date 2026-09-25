/**
 * 证明修复有效：**故意让 --grad / --grad-soft 失效**，看按钮是否还会变成隐形。
 *
 * 这是对用户"选中后直接全白什么都看不见了"的直接回归验证：
 *   修复前：background: var(--grad) 简写被整条丢弃 → 白底白字 → 隐形
 *   修复后：background-color: var(--accent) 兜底 → 仍是实色按钮 → 可见
 */

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE)) ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; const t = setTimeout(() => { pending.delete(i); res({}); }, 25000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3600);

const probe = `(() => {
  const b = document.querySelector('.col-thread .composer-toolbar .btn.primary');
  const cs = getComputedStyle(b);
  const parse = (c) => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); return m ? m[1].split(',').map(Number).slice(0,3) : null; };
  const lum = (p) => { const f = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
    return 0.2126*f(p[0])+0.7152*f(p[1])+0.0722*f(p[2]); };
  const bg = parse(cs.backgroundColor), fg = parse(cs.color);
  const contrast = bg && fg ? (Math.max(lum(bg),lum(fg))+0.05)/(Math.min(lum(bg),lum(fg))+0.05) : null;
  return { bg: cs.backgroundColor, img: cs.backgroundImage === 'none' ? '(none)' : 'has-gradient',
           color: cs.color, contrast: contrast ? Math.round(contrast*100)/100 : null };
})()`;

console.log('--- 正常情况 ---');
console.log(JSON.stringify(await ev(probe), null, 1));

console.log('\n--- 故意让 --grad 失效（模拟用户遇到的情形）---');
await ev(`document.documentElement.style.setProperty('--grad', ''); true`);
await sleep(400);
const broken = await ev(probe);
console.log(JSON.stringify(broken, null, 1));
console.log(broken?.contrast >= 3
  ? `\n✅ 通过：渐变失效后按钮仍是实色，白字对比度 ${broken.contrast}:1 —— 不会隐形`
  : `\n❌ 失败：按钮对比度 ${broken?.contrast} —— 仍可能隐形`);

console.log('\n--- 再让 --grad-soft 失效，检查选中态是否还有底色 ---');
await ev(`document.documentElement.style.setProperty('--grad-soft', ''); true`);
await sleep(400);
console.log(JSON.stringify(await ev(`(() => {
  const on = document.querySelector('.side-item.active') || document.querySelector('.thread-tab.on');
  const cs = getComputedStyle(on);
  return { cls: String(on.className), bg: cs.backgroundColor, img: cs.backgroundImage === 'none' ? '(none)' : 'has-gradient',
           color: cs.color };
})()`), null, 1));

ws.close();
process.exit(0);
