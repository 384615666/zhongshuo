/**
 * 弹窗内按钮颜色审计。
 *
 * 用户反馈"新建群聊、发送、保存、引用等按钮的颜色你还没改"。
 * 页面上这些主操作大多在**弹窗/菜单里**（新建私聊对话框、导出对话框、
 * 确认归档、成员添加…），只有打开它们才看得见 —— 常规页面审计会漏掉。
 *
 * 本脚本逐个打开弹窗/菜单，报告其中每个按钮的实际渲染色。
 *
 * 用法：node scripts/audit-dialogs.mjs [baseUrl]
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
  const i = ++id; const t = setTimeout(() => { pending.delete(i); res({}); }, 20000);
  pending.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? undefined : r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.clear(); true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);

/** 报告"当前可见的浮层"里所有按钮 */
const AUDIT_OVERLAY = `(() => {
  // 找所有可见浮层：modal / menu / popover
  const overlays = [...document.querySelectorAll('.modal, .menu, .overlay, [role="dialog"], .access-menu, .mention-pop, .modal-card')]
    .filter(o => { const r = o.getBoundingClientRect(); const cs = getComputedStyle(o);
      return r.width > 40 && r.height > 30 && cs.display !== 'none' && cs.visibility !== 'hidden'; });
  if (overlays.length === 0) return null;
  const out = [];
  const seen = new Set();
  for (const ov of overlays) {
    const btns = [...ov.querySelectorAll('button, .btn, [role="menuitem"], [role="menuitemradio"]')];
    for (const el of btns) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const text = (el.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 20);
      const key = text + '|' + el.className;
      if (seen.has(key)) continue; seen.add(key);
      const img = cs.backgroundImage;
      out.push({
        text: text || '(' + (el.getAttribute('aria-label') || el.title || 'icon') + ')',
        cls: String(el.className).slice(0, 40),
        img: img === 'none' ? '' : img.includes('gradient') ? (img.includes('37, 99, 235') ? 'grad-soft' : 'grad') : 'other',
        bg: cs.backgroundColor,
        color: cs.color,
        disabled: el.disabled === true,
        opacity: cs.opacity,
      });
    }
  }
  return { overlayCount: overlays.length, buttons: out };
})()`;

const SCENARIOS = [
  ['新建私聊对话框', '/project/proj_zs_01/dm?recovery=0', `(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('新建私聊'));
    if (b) b.click(); return !!b; })()`],
  ['成员管理-添加成员', '/project/proj_zs_01/members?recovery=0', `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('添加成员'));
    if (b) b.click(); return !!b; })()`],
  ['成果-导出对话框', '/artifact/artifact_12_team_report?recovery=0', `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '导出');
    if (b) b.click(); return !!b; })()`],
  ['房间-房间设置', '/project/proj_zs_01/room/room_dev_hall?recovery=0', `(() => {
    // 用例更新（2026-09-24 减负）：房间设置不再常驻成按钮，统一进房间「⋯」
    const m = document.querySelector('.pool-head button[aria-haspopup="menu"]');
    if (!m) return false;
    m.click();
    const menus = [...document.querySelectorAll('.menu')];
    const b = [...(menus.at(-1)?.querySelectorAll('.menu-item') ?? [])]
      .find(x => x.textContent.includes('房间设置'));
    if (b) b.click();
    return !!b; })()`],
  ['任务详情-停止/操作', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=task&recovery=0', `(() => {
    // 用例更新（2026-09-24 减负）：任务详情在「详情 → 任务概况」分组内（?tab=task 即落位）
    const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('停止') || x.textContent.includes('停止'));
    if (b) b.click(); return !!b; })()`],
  ['待我处理-新建提醒', '/activity?recovery=0', `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新建提醒'));
    if (b) b.click(); return !!b; })()`],
  ['私信-会话设置菜单', '/project/proj_zs_01/dm?recovery=0', `(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('会话设置'));
    if (b) b.click(); return !!b; })()`],
  ['文件与Git-改动操作', '/project/proj_zs_01/files?tab=files&recovery=0', `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('暂存到 Git'));
    if (b) b.click(); return !!b; })()`],
];

for (const [name, hash, click] of SCENARIOS) {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(1700);
  const clicked = await ev(click);
  await sleep(1100);
  const res = await ev(AUDIT_OVERLAY);
  console.log(`\n### ${name}  (点击=${clicked}, 浮层数=${res?.overlayCount ?? 0})`);
  if (!res || !res.buttons?.length) { console.log('  （没有可见浮层或其中无按钮）'); continue; }
  for (const b of res.buttons) {
    const mark = b.img === 'grad' ? '[GRAD]' : b.img === 'grad-soft' ? '[SOFT]' : '[flat]';
    console.log(`  ${mark.padEnd(8)} ${b.text.padEnd(22)} ${b.cls.padEnd(42)} bg=${b.bg.padEnd(22)} img=${b.img}`);
  }
  // 关掉浮层，避免影响下一个场景
  await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true; })()`);
  await sleep(500);
}

ws.close();
process.exit(0);
