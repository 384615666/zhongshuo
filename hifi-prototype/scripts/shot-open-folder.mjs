/**
 * 「打开本地文件夹」相关的两张证据图（2026-09-26 用户反馈修复）。
 *
 *  · 01-welcome：欢迎页 —— 「进入当前项目」按钮已删除
 *  · 02-project-menu：顶栏项目菜单展开（「打开本地文件夹…」就在最后一项）
 *  · 03-open-folder-modal：点菜单项后的就地弹窗（**不跳欢迎页**）
 *
 * 为什么没有"系统目录对话框"的截图：那是操作系统级窗口，不在渲染层，
 * `Page.captureScreenshot` 拍不到。它的证据是程序化的 ——
 * `verify-open-folder.mjs` 从操作系统层面探测 electron 的 #32770 并关闭。
 *
 * 需要 `pnpm run desktop:debug`（9333）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PORT = process.env.ZS_CDP_PORT ?? '9333';
const OUT = 'D:/zhongshuo/hifi-prototype/screenshots-desktop/open-folder';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0;
const p = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  const t = setTimeout(() => { p.delete(i); res({}); }, 20000);
  p.set(i, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('OK  ', name);
  } else console.log('MISS', name);
};
const go = async (h) => { await ev(`location.hash=${JSON.stringify(h + (h.includes('?') ? '&' : '?') + 'recovery=0')}; true`); await sleep(1500); };

await ev(`window.zhongshuo?.window.show()`);
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/welcome?recovery=0'; true`);
await sleep(400);
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
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

/* 1. 欢迎页：只剩「打开文件夹」 */
await go('/welcome');
await shot('01-welcome');

/* 2. 顶栏项目菜单（「打开本地文件夹…」在最后一项） */
await go('/project/proj_zs_01/room/room_dev_hall');
await ev(`(() => { document.querySelector('.titlebar-project-btn')?.click(); return true; })()`);
await sleep(900);
await shot('02-project-menu');

/* 3. 点菜单项 → 就地弹窗（不跳欢迎页；系统对话框由 verify-open-folder 证明） */
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.menu-item')].find(x => x.innerText.includes('打开本地文件夹'));
    b?.click();
    return !!b;
  })()
`);
await sleep(1400);
await shot('03-open-folder-modal');
console.log('hash =', await ev(`location.hash`), '（应仍停在房间页，不是 /welcome）');

/* 点菜单项时系统目录对话框已经被调起（autoPick）。尽力关掉它 —— 但本机实测
   （Windows 11 + Electron 33）现代目录选择器**不接受程序化关闭**：ESC 需要焦点、
   WM_CLOSE 被忽略，所以关不掉时请手工按 Esc 或重启桌面宿主（重启会一并销毁）。
   本脚本因此只调起一次对话框（就这一步）。 */
if (process.platform === 'win32') {
  const r = spawnSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/dialog-probe.ps1', '-Mode', 'close',
      '-Owner', 'electron', '-WaitSeconds', '10'],
    { encoding: 'utf8' },
  );
  console.log(r.status === 0
    ? `${String(r.stdout ?? '').trim()}（若它仍停在屏幕上，按 Esc 或重启桌面宿主）`
    : `未发现系统目录对话框（${String(r.stdout ?? '').trim().slice(0, 60)}）`);
}
ws.close();
