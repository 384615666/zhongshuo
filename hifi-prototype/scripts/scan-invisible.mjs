/**
 * 全站「白底白字」扫描 —— 直接定位"选中后全白什么都看不见"。
 *
 * 用户反馈："没选中和选中的时候，颜色和我给你的截图完全不一样，
 * 选中后直接全白什么都看不见了"。
 *
 * 思路：不再逐个猜控件，而是**遍历所有可见元素**，算
 *   contrast(文字色, 实际背景色)
 * 把对比度低于阈值的元素全部报出来。白底白字必然被抓到。
 *
 * 背景色要向上回溯：元素自身背景透明时，取最近的有色祖先。
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

const SCAN = `(() => {
  const parse = (c) => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); return m ? m[1].split(',').map(Number).slice(0,4) : null; };
  const lum = (p) => { const f = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
    return 0.2126*f(p[0])+0.7152*f(p[1])+0.0722*f(p[2]); };
  const over = (fg, bg) => {           // fg(可能带 alpha) 叠在 bg 上
    const a = fg.length > 3 ? fg[3] : 1;
    return [0,1,2].map(i => Math.round(fg[i]*a + bg[i]*(1-a)));
  };
  const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
  const effBg = (el) => {              // 向上找第一个不透明背景
    let cur = el, acc = null;
    while (cur && cur !== document.documentElement) {
      const p = parse(getComputedStyle(cur).backgroundColor);
      if (p && (p.length < 4 || p[3] > 0.92)) return p.slice(0,3);
      cur = cur.parentElement;
    }
    const p = parse(getComputedStyle(document.body).backgroundColor);
    return p ? p.slice(0,3) : [255,255,255];
  };
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    // 只看"直接含文字"的元素
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent.trim()).join(' ');
    if (!own) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.15) continue;
    const fgp = parse(cs.color); if (!fgp) continue;
    const bg = effBg(el);
    const fg = over(fgp, bg);
    const c = contrast(fg, bg);
    if (c < 2.0) {
      out.push({
        text: own.slice(0, 22),
        cls: String(el.className).slice(0, 34),
        tag: el.tagName.toLowerCase(),
        fg: 'rgb(' + fg.join(',') + ')',
        bg: 'rgb(' + bg.join(',') + ')',
        contrast: Math.round(c * 100) / 100,
        y: Math.round(r.y),
      });
    }
  }
  // 同一元素去重
  const seen = new Set();
  return out.filter(o => {
    const k = o.text + '|' + o.cls + '|' + o.fg;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).sort((a,b) => a.contrast - b.contrast);
})()`;

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.clear(); true`);

const SCENES = [
  ['房间-主池（默认）', '/project/proj_zs_01/room/room_dev_hall?recovery=0', null],
  ['房间-点「讨论」', '/project/proj_zs_01/room/room_dev_hall?recovery=0',
    `[...document.querySelectorAll('.composer-toolbar .seg button')].find(b=>b.textContent.includes('讨论'))?.click()`],
  ['房间-L4-点「源码」', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0',
    `[...document.querySelectorAll('.seg button')].find(b=>b.textContent.includes('源码'))?.click()`],
  ['成员-添加成员弹窗', '/project/proj_zs_01/members?recovery=0',
    `[...document.querySelectorAll('button')].find(x=>x.textContent.includes('添加成员'))?.click()`],
  ['私信-新建私聊弹窗', '/project/proj_zs_01/dm?recovery=0',
    `[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('新建私聊'))?.click()`],
];

let total = 0;
for (const [name, hash, click] of SCENES) {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3200);
  if (click) { await ev(`(() => { ${click}; return true; })()`); await sleep(1100); }
  const rows = (await ev(SCAN)) ?? [];
  console.log(`\n### ${name} — 低对比元素 ${rows.length} 个`);
  for (const r of rows.slice(0, 14)) {
    console.log(`  contrast=${String(r.contrast).padEnd(6)} <${r.tag} class="${r.cls}"> "${r.text}"  fg=${r.fg} bg=${r.bg}  y=${r.y}`);
  }
  total += rows.length;
}
console.log(`\n合计低对比（<2.0）元素：${total}`);
ws.close();
process.exit(0);
