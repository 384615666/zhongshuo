/**
 * 地面真相：直接检查**渲染后的 DOM** 里是否出现字面 ** 标记。
 * 静态扫描容易把多行 JSX 注释误判，所以以浏览器实际渲染为准。
 */
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
  const t = setTimeout(() => { p.delete(i); res({}); }, 12000);
  p.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: JSON.stringify(r.result.exceptionDetails).slice(0, 200) };
  return r.result?.result?.value;
};
const go = async (h) => { await ev(`location.hash=${JSON.stringify(h)}; true`); await sleep(1500); };

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

const routes = [
  ['成员页', '/project/proj_zs_01/members'],
  ['项目设置·任务交付', '/project/proj_zs_01/settings?anchor=delivery'],
  ['项目设置·协作限制', '/project/proj_zs_01/settings?anchor=collab'],
  ['项目设置·文件修改', '/project/proj_zs_01/settings?anchor=write'],
  /* 路由更新（第二十八批）：五分区 → 七类；旧 key（lan / diagnostics）仍可用，
     但地面真相应查**新分区**，否则新增文案没人看。 */
  ['应用设置·通用', '/settings?section=general'],
  ['应用设置·外观', '/settings?section=appearance'],
  ['应用设置·通知', '/settings?section=notifications'],
  ['应用设置·AI 工具', '/settings?section=runtime'],
  ['应用设置·连接与设备', '/settings?section=connections'],
  ['应用设置·数据与存储', '/settings?section=data'],
  ['应用设置·帮助与关于', '/settings?section=help'],
  ['待我处理', '/activity'],
  ['任务看板', '/tasks?scope=all'],
  ['房间', '/project/proj_zs_01/room/room_dev_hall'],
];

let bad = 0;
for (const [name, h] of routes) {
  await go(h);
  /**
   * 只统计**恰好两个**连续的星号 —— 那才是误写的 markdown 加粗。
   * 三个及以上是合法的"掩码"显示（如令牌前缀 `zs_tok_9f3c***`），不能算缺陷。
   * 早先按"任意两个连续星号"统计，把 LAN 页 3 处掩码令牌误报成缺陷。
   */
  const n = await ev(`
    (() => {
      const t = document.body.innerText;
      let c = 0;
      for (let i = 0; i < t.length; i++) {
        if (t[i] !== String.fromCharCode(42)) continue;
        let j = i;
        while (j < t.length && t[j] === String.fromCharCode(42)) j++;
        if (j - i === 2) c++;
        i = j - 1;
      }
      return c;
    })()
  `);
  const ok = n === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: 字面 ** 对 = ${n}`);
}

// 成员对话框也要查
await go('/project/proj_zs_01/members');
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.btn')].find(x => x.innerText.includes('添加成员'));
    if (b) b.click();
    return !!b;
  })()
`);
await sleep(900);
const dlg = await ev(`
  (() => {
    const t = document.querySelector('.modal')?.innerText ?? '';
    let c = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== String.fromCharCode(42)) continue;
      let j = i;
      while (j < t.length && t[j] === String.fromCharCode(42)) j++;
      if (j - i === 2) c++;
      i = j - 1;
    }
    return c;
  })()
`);
console.log(`${dlg === 0 ? 'OK  ' : 'FAIL'} 添加成员对话框: 字面 ** 对 = ${dlg}`);
if (dlg !== 0) bad++;

console.log(bad === 0 ? '\n所有页面渲染文本均无字面 ** 加粗标记（三连星号属掩码，不计）' : `\n${bad} 处残留`);
ws.close();
process.exit(bad === 0 ? 0 : 1);
