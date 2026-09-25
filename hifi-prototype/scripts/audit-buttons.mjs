/**
 * 全站按钮颜色审计。
 *
 * 用户反馈"新建群聊、发送、保存、引用等按钮的颜色你还没改"。
 * 这里把每个页面上**所有按钮**的实际渲染色打出来，
 * 按"是否用了 --grad / --grad-soft / 纯令牌"分类，找出漏改的。
 *
 * 用法：node scripts/audit-buttons.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://localhost:5284';
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE)) ?? list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
const errs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(1);
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

const AUDIT = `(() => {
  const parseRGB = (c) => { const m = String(c).match(/rgba?\\(([^)]+)\\)/); return m ? m[1].split(',').map(Number).slice(0,3) : null; };
  const sat = (c) => { const p = parseRGB(c); if (!p) return 0; return Math.max(...p) - Math.min(...p); };
  const lum = (c) => { const p = parseRGB(c); if (!p) return 0; const f = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(p[0])+0.7152*f(p[1])+0.0722*f(p[2]); };
  const out = [];
  const seen = new Set();
  // 所有可能是"按钮"的元素
  const els = [...document.querySelectorAll('button, [role="button"], .btn, .icon-btn, .tag-btn, .access-trigger, .method-chip, .side-icon-btn')];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;            // 不可见/极小
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 18);
    const key = text + '|' + el.className;
    if (seen.has(key)) continue;
    seen.add(key);
    const img = cs.backgroundImage;
    const bg = cs.backgroundColor;
    out.push({
      text: text || '(' + (el.getAttribute('aria-label') || el.title || 'icon') + ')',
      cls: String(el.className).slice(0, 42),
      img: img === 'none' ? '' : (img.includes('gradient') ? (img.includes('37, 99, 235') ? 'grad-soft' : 'grad') : 'other-grad'),
      bg,
      bgSat: sat(bg),
      disabled: el.disabled === true,
      opacity: cs.opacity,
      color: cs.color,
      // 按钮"有实色底"= 饱和度高或深色底
      solid: sat(bg) > 25 || (lum(bg) < 0.55 && bg !== 'rgba(0, 0, 0, 0)'),
    });
  }
  return out;
})()`;

const PAGES = [
  ['房间主池', '/project/proj_zs_01/room/room_dev_hall?recovery=0'],
  ['线程回复串', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'],
  ['私信（含新建群聊）', '/project/proj_zs_01/dm?recovery=0'],
  ['任务看板', '/tasks?scope=all&recovery=0'],
  ['成员管理', '/project/proj_zs_01/members?recovery=0'],
  ['应用设置', '/settings?section=general&recovery=0'],
  ['项目设置', '/project/proj_zs_01/settings?recovery=0'],
  ['文件与Git', '/project/proj_zs_01/files?tab=files&recovery=0'],
  ['成果页', '/artifact/artifact_12_team_report?recovery=0'],
  ['待我处理', '/activity?recovery=0'],
];

const problems = [];
for (const [name, hash] of PAGES) {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(1500);
  const rows = await ev(AUDIT);
  if (!Array.isArray(rows)) { console.log(`-- ${name}: 取不到`); continue; }
  console.log(`\n### ${name}  (${rows.length} 个按钮)`);
  for (const r of rows) {
    const mark = r.img === 'grad' ? '[GRAD]' : r.img === 'grad-soft' ? '[SOFT]' : r.solid ? '[SOLID]' : '[flat]';
    console.log(`  ${mark.padEnd(8)} ${r.text.padEnd(20)} ${r.cls.padEnd(44)} bg=${r.bg.padEnd(22)} img=${r.img}`);
    // 疑似漏改：主操作按钮（新建/发送/保存/引用/添加/导出/确定）却是 flat 或 accent 实色
    if (/新建|发送|保存|引用|添加|创建|确定|提交|写入|导出|打开文件夹|开始|继续/.test(r.text)
      && r.img !== 'grad' && !r.disabled) {
      problems.push({ page: name, ...r });
    }
  }
}

console.log('\n=== 疑似"主操作按钮但未用 --grad" ===');
if (problems.length === 0) console.log('  （无）');
for (const p of problems) {
  console.log(`  ${p.page} / ${p.text}  cls="${p.cls}"  bg=${p.bg}  img=${p.img || 'none'}`);
}
console.log(`\n控制台错误计数：${errs.length}`);
ws.close();
process.exit(0);
