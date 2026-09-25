/** 验证设计报告 §17.7 表格里的 URL 字面值都能真正打开对应页面。 */
const PORT = process.env.ZS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { p.delete(i); res({}); }, 10000);
  p.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 160) };
  return r.result?.result?.value;
};

await ev(`window.zhongshuo?.window.show()`);
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/welcome?recovery=0'; true`);
await sleep(400);
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3000);
await ev(`window.zhongshuo?.window.show()`);
await sleep(500);

// 按 §17.7 路由表的字面写法
const cases = [
  ['搜索与收藏(project)', '/library?tab=search&scope=project&projectId=proj_zs_01', '搜索与收藏'],
  ['搜索与收藏(saved)', '/library?tab=saved', '搜索与收藏'],
  ['文件与 Git(files)', '/project/proj_zs_01/files?tab=files', '文件与 Git'],
  ['文件与 Git(git)', '/project/proj_zs_01/files?tab=git', '文件与 Git'],
  ['看板(visible)', '/tasks?scope=visible', '任务看板'],
  ['看板(project)', '/tasks?scope=project&projectId=proj_zs_01', '任务看板'],
  ['成员', '/project/proj_zs_01/members', '成员管理'],
  ['私信', '/project/proj_zs_01/dm', '搜索与收藏'],
  ['设置(app)', '/settings?section=app', '设置'],
  ['设置(runtime)', '/settings?section=runtime', '设置'],
  // 第十六批 §17.8：项目设置已独立成页，旧链接规范化过去。
  // 它**不再**高亮底部「设置」（两个入口不同时是当前页），所以这里期望不高亮。
  ['项目设置(旧链接规范化)', '/settings?section=project&projectId=proj_zs_01', null],
  ['项目设置(独立路由)', '/project/proj_zs_01/settings', null],
];

let pass = 0;
for (const [name, hash, expectActive] of cases) {
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await sleep(1500);
  const r = await ev(`
    (() => {
      const on = [...document.querySelectorAll('.sidebar .side-item.active')]
        .map(e => e.querySelector('.side-item-label')?.innerText.trim());
      const title = document.querySelector('.page-title')?.innerText.trim() ?? null;
      const sub = document.querySelector('.page-sub')?.innerText.trim() ?? '';
      return { on, title, sub, hash: location.hash };
    })()
  `);
  /**
   * 侧栏高亮断言：
   *  - `expectActive === null` 表示"这条 URL 不应高亮任何底部/功能入口"
   *    （项目设置页就是这种：它有自己的入口，底部「设置」不该亮）。
   *  - 私信页高亮的是项目下的「私信」子项，不在 .side-item.active 的标签集合里，
   *    所以单独放行。
   */
  const okSidebar = expectActive === null
    ? (r?.on ?? []).length === 0
    : name.startsWith('私信')
      ? true
      : (r?.on ?? []).includes(expectActive);
  const bodyOk = (r?.title && r.title.length > 0) || (r?.on ?? []).length > 0;
  const ok = okSidebar && bodyOk;
  if (ok) pass++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  →  hash=${r?.hash}  标题=${r?.title}  高亮=${JSON.stringify(r?.on)}`);
}

console.log(`\n${pass}/${cases.length} 个文档 URL 可用`);
ws.close();
