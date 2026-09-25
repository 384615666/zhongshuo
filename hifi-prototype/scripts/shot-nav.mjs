/**
 * 截第十五批导航相关界面（侧栏三段、顶栏项目菜单、文件树、项目分组看板、设置分层）。
 * 只截实际渲染出来的东西；每张图前都等布局落定，避免截到中间态。
 */
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

const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  if (r.result?.data) {
    writeFileSync(`D:/zhongshuo/hifi-prototype/screenshots-desktop/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('OK  ', name);
  } else console.log('MISS', name);
};
const full = () => send('Page.captureScreenshot', { format: 'png' });
/**
 * 导航到某个 hash，并带上 `recovery=0` 抑制启动恢复弹窗。
 * 不加的话第一张图上会盖着"启动恢复检查"模态，看不到页面本身
 * （第一次截图就是这样，图对但内容被挡住）。
 */
const go = async (h) => {
  const withRecovery = h.includes('?') ? `${h}&recovery=0` : `${h}?recovery=0`;
  await ev(`location.hash=${JSON.stringify(withRecovery)}; true`);
  await sleep(1900);
};
/** 关掉可能已经弹出的恢复模态 */
const dismissModal = async () => {
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
await dismissModal();

/* 1. 新侧栏（三段式）+ 顶栏 */
await go('/project/proj_zs_01/room/room_dev_hall');
await shot('30-nav-sidebar');

/* 2. 顶栏项目菜单（勾选框 + 当前标记 + 搜索） */
await ev(`document.querySelector('.side-project-picker').click(); true`);
await sleep(900);
{
  const r = await full();
  if (r.result?.data) {
    writeFileSync('D:/zhongshuo/hifi-prototype/screenshots-desktop/31-nav-project-menu.png', Buffer.from(r.result.data, 'base64'));
    console.log('OK   31-nav-project-menu');
  } else console.log('MISS 31-nav-project-menu');
}
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(600);

/* 3. 勾选第二个项目后的侧栏（多项目分组 + 各自房间与私信） */
await ev(`document.querySelector('.side-project-picker').click(); true`);
await sleep(900);
await ev(`
  (() => {
    const rows = [...document.querySelectorAll('.menu-project-row')];
    const t = rows.find(r => r.innerText.indexOf('data-backfill') >= 0);
    const chk = t.querySelector('.menu-check');
    if (!chk.classList.contains('on')) chk.click();
    return true;
  })()
`);
await sleep(900);
await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(400);
await ev(`document.querySelector('.side-project-picker').click(); true`);
await sleep(500);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(900);
await shot('32-nav-two-projects');

/* 4. 文件与 Git 合页：文件树 */
await go('/project/proj_zs_01/files?tab=files');
await sleep(900);
await ev(`
  (() => {
    // 展开 src 下的子目录并选中一个文件，让预览区有内容
    const rows = [...document.querySelectorAll('.file-row')];
    const target = rows.find(r => r.innerText.indexOf('events.ts') >= 0);
    if (target) target.click();
    return !!target;
  })()
`);
await sleep(900);
await shot('33-nav-files-tree');

/* 5. 合页：Git 标签（同一页面内） */
await go('/project/proj_zs_01/files?tab=git');
await shot('34-nav-files-git-tab');

/* 6. 任务看板：按项目分组 */
await go('/tasks?scope=all');
await shot('35-nav-board-by-project');

/* 7. 设置：应用设置（Runtime 收入） */
await go('/settings?section=runtime');
await shot('36-nav-settings-runtime');

/* 8. 设置：项目设置 */
await go('/settings?section=project');
await shot('37-nav-settings-project');

/* 9. 搜索与收藏合页（带范围控件 + 作者筛选） */
await go('/library?tab=search&scope=all');
// 输入一个必然命中的关键词，让结果区也出现在截图里
await ev(`
  (() => {
    const input = document.querySelector('.page-filters input.input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '任务');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`);
await sleep(900);
await shot('38-nav-library');

/* 10. 非 Git 项目的文件树（§9.4：非 Git 也能浏览文件与预览） */
await go('/project/proj_notgit_04/files?tab=files');
await sleep(800);
await ev(`
  (() => {
    const dir = [...document.querySelectorAll('.file-row')]
      .find(r => r.innerText.trim().split(String.fromCharCode(10))[0] === 'docs');
    if (dir) dir.click();
    return !!dir;
  })()
`);
await sleep(800);
await ev(`
  (() => {
    const f = [...document.querySelectorAll('.file-row')].find(r => r.innerText.indexOf('index.md') >= 0);
    if (f) f.click();
    return !!f;
  })()
`);
await sleep(900);
await shot('39-nav-nongit-files');

/* 11. 待我处理：跨项目汇总，卡片标来源，含隐藏项目 */
await go('/activity');
await shot('40-nav-activity-cross-project');

ws.close();
