/**
 * 环境探针：这个 CDP 页面里 **CSS 动画/过渡到底会不会推进**？
 *
 * 因为前两次入场动画都"卡在起始帧"（flex-basis 卡在 0、translateX 卡在 22px），
 * 需要先确认是环境（页面被判为 hidden → 动画不推进）还是我的写法有问题。
 * 做法：注入一个 0→100 的测试动画，等 400ms 后读计算值。
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
  return r.result?.exceptionDetails ? ('ERR ' + String(r.result.exceptionDetails.exception?.description).slice(0,160)) : r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');

console.log('visibilityState :', await ev(`document.visibilityState`));
console.log('hasFocus        :', await ev(`document.hasFocus()`));
console.log('reduced-motion  :', await ev(`window.matchMedia('(prefers-reduced-motion: reduce)').matches`));

/* 注入一个 0 → 100px 的宽度动画，400ms 后看推进到哪 */
await ev(`(() => {
  const d = document.createElement('div');
  d.id = 'zs-anim-probe';
  d.style.cssText = 'position:fixed;left:-9999px;top:0;height:10px;width:0;background:red';
  document.body.appendChild(d);
  const st = document.createElement('style');
  st.textContent = '@keyframes zsProbe { from { width: 0 } to { width: 100px } }' +
                   '#zs-anim-probe { animation: zsProbe 0.4s linear forwards; }';
  document.head.appendChild(st);
  return true;
})()`);
await sleep(120);
const early = await ev(`getComputedStyle(document.getElementById('zs-anim-probe')).width`);
await sleep(600);
const late = await ev(`getComputedStyle(document.getElementById('zs-anim-probe')).width`);
console.log(`动画推进          : 120ms 时 width=${early} → 720ms 时 width=${late}`);
console.log(late === '100px' ? '  ✅ 动画会正常推进（环境没问题）' : '  ❌ 动画不推进（环境问题，不能用动画做入场）');

/* 再测过渡 */
await ev(`(() => {
  const d = document.createElement('div');
  d.id = 'zs-trans-probe';
  d.style.cssText = 'position:fixed;left:-9999px;top:0;height:10px;width:0;background:blue;transition:width .4s linear';
  document.body.appendChild(d);
  return true;
})()`);
await sleep(60);
await ev(`document.getElementById('zs-trans-probe').style.width = '100px'`);
await sleep(700);
const tw = await ev(`getComputedStyle(document.getElementById('zs-trans-probe')).width`);
console.log(`过渡推进          : 700ms 后 width=${tw}`);
console.log(tw === '100px' ? '  ✅ 过渡会正常推进' : '  ❌ 过渡不推进');

await ev(`document.getElementById('zs-anim-probe')?.remove(); document.getElementById('zs-trans-probe')?.remove(); true`);
ws.close();
process.exit(0);
