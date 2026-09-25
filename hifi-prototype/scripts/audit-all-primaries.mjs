/**
 * 全站主按钮渐变审计（决定性证据）。
 *
 * 用户反馈"新建群聊、发送、保存、引用等按钮的颜色你还没改"。
 * 逐个点名去查容易漏 —— 这里改为**遍历所有路由 + 打开所有弹窗**，
 * 把每一个 `.btn.primary` 的实际渲染色打出来，看是否真有缺漏。
 *
 * 判定：`background-image` 必须含 `linear-gradient`；
 * 若为 `none` 或纯色，说明 --grad 没生效。
 *
 * ⚠ 必须**每条路由真重载**：早先只用 `location.hash=...` 切换，
 * 多条路由报回了**完全相同的按钮集合**（都只有 "继续选中的 2 项" 一个 primary），
 * 说明 SPA 根本没重新渲染 —— 那份审计是无效的，不能作为结论。
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.clear(); true`);

/** 收集页面上所有可见按钮的渲染色 */
const PROBE = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('button, a.btn')) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const cx = r.x + r.width/2, cy = r.y + r.height/2;
    const top = document.elementFromPoint(cx, cy);
    if (top && !el.contains(top) && top !== el) continue;   // 被遮挡
    const img = cs.backgroundImage;
    out.push({
      cls: String(el.className),
      text: (el.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 16)
            || '(' + (el.getAttribute('aria-label') || el.title || 'icon').slice(0, 16) + ')',
      isPrimary: el.classList.contains('primary'),
      hasGrad: img.includes('linear-gradient'),
      isNewGrad: img.includes('42, 134, 221'),
      img: img === 'none' ? '' : img.replace(/\\s+/g,' ').slice(0, 46),
      bg: cs.backgroundColor,
      color: cs.color,
      disabled: el.disabled === true,
      opacity: cs.opacity,
    });
  }
  return out;
})()`;

const ROUTES = [
  ['欢迎页', '/welcome'],
  ['项目首页', '/project/proj_zs_01'],
  ['房间-主池', '/project/proj_zs_01/room/room_dev_hall?recovery=0'],
  ['房间-L2线程', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'],
  ['房间-L4预览', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&tab=artifacts&recovery=0'],
  ['私信列表', '/project/proj_zs_01/dm?recovery=0'],
  ['成员管理', '/project/proj_zs_01/members?recovery=0'],
  ['任务看板', '/tasks?scope=all&recovery=0'],
  ['文件与Git', '/project/proj_zs_01/files?tab=files&recovery=0'],
  ['Git页', '/project/proj_zs_01/files?tab=git&recovery=0'],
  ['应用设置', '/settings?section=general&recovery=0'],
  ['项目设置', '/project/proj_zs_01/settings?recovery=0'],
  ['Runtime页', '/runtimes?recovery=0'],
  ['待我处理', '/activity?recovery=0'],
  ['成果页', '/artifact/artifact_12_team_report?recovery=0'],
];

const MODALS = [
  ['弹窗:新建私聊', '/project/proj_zs_01/dm?recovery=0',
    `[...document.querySelectorAll('button')].find(x=>(x.title||'').includes('新建私聊'))?.click()`],
  ['弹窗:房间设置', '/project/proj_zs_01/room/room_dev_hall?recovery=0',
    `[...document.querySelectorAll('button')].find(x=>x.textContent.includes('房间设置'))?.click()`],
  ['弹窗:添加成员', '/project/proj_zs_01/members?recovery=0',
    `[...document.querySelectorAll('button')].find(x=>x.textContent.includes('添加成员'))?.click()`],
  ['弹窗:导出', '/artifact/artifact_12_team_report?recovery=0',
    `[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='导出')?.click()`],
  ['弹窗:新建房间', '/project/proj_zs_01?recovery=0',
    `[...document.querySelectorAll('button')].find(x=>x.textContent.includes('新建房间'))?.click()`],
  ['弹窗:新建分支', '/project/proj_zs_01/files?tab=git&recovery=0',
    `[...document.querySelectorAll('button')].find(x=>x.textContent.includes('新建分支'))?.click()`],
];

const broken = [];
const allPrimary = new Map();

function report(title, rows) {
  const prim = rows.filter((r) => r.isPrimary);
  console.log(`\n### ${title}  (按钮 ${rows.length}，其中 primary ${prim.length})`);
  for (const r of prim) {
    const flag = r.hasGrad ? (r.isNewGrad ? 'OK-NEW' : 'OK-OLD?') : 'NO-GRAD';
    if (!r.hasGrad) broken.push({ title, ...r });
    const key = r.text + '|' + r.cls;
    if (!allPrimary.has(key)) allPrimary.set(key, { title, ...r });
    console.log(`  [${flag.padEnd(7)}] "${r.text}"  cls="${r.cls}"  op=${r.opacity}${r.disabled ? ' DISABLED' : ''}  ${r.img || '(no gradient)'}`);
  }
  if (!prim.length) console.log('  （本页无 primary 按钮）');
}

for (const [name, hash] of ROUTES) {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  // 真重载 + 等渲染，确保拿到的是该路由自己的 DOM
  await send('Page.reload', { ignoreCache: true });
  await sleep(3200);
  const here = await ev(`location.hash`);
  report(`${name}  [${here}]`, (await ev(PROBE)) ?? []);
}

for (const [name, hash, click] of MODALS) {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3200);
  await ev(`(() => { ${click}; return true; })()`);
  await sleep(1100);
  report(name, (await ev(PROBE)) ?? []);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
  await sleep(400);
}

console.log('\n================ 汇总 ================');
console.log(`主按钮去重后共 ${allPrimary.size} 种：`);
for (const [, v] of allPrimary) {
  console.log(`  ${v.hasGrad ? '渐变' : '**无渐变**'}  "${v.text}"  ${v.cls}  @${v.title}`);
}
console.log(`\n缺渐变的 primary 按钮：${broken.length} 个`);
for (const b of broken) console.log(`  ! ${b.title} / "${b.text}" / ${b.cls} / img="${b.img}"`);

ws.close();
process.exit(broken.length ? 1 : 0);
