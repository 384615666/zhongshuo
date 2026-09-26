/**
 * 截图：「文件与 Git」合页改造后的五个形态。
 *
 * 前置：先 `npm run build`，再开一个带调试端口的桌面端
 *   `npx electron . --remote-debugging-port=9333`
 * 然后 `node scripts/shot-files-git.mjs`。
 *
 * 产物落在 screenshots-desktop/，名字带序号便于和既有截图排序对照。
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = '9333';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots-desktop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let id = 0;
let p = new Map();

async function connect() {
  try { ws?.close(); } catch { /* 已关闭 */ }
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page');
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  id = 0; p = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  };
}
await connect();

const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    const t = setTimeout(() => { p.delete(i); res({}); }, 15000);
    p.set(i, (m) => { clearTimeout(t); res(m); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const b64 = r.result?.data;
  if (!b64) throw new Error('截图失败：没有拿到 data');
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('saved', file);
}

await send('Page.enable');
await ev(`localStorage.removeItem('zhongshuo.nav.prefs.v1'); true`);
await ev(`window.zhongshuo?.window.show()`);
await send('Page.reload', { ignoreCache: true });
await sleep(2500);

/* 1. Git 标签 · 工作区（左清单 / 右详情） */
await ev(`location.hash='/project/proj_zs_01/files?tab=git'; true`);
await sleep(1800);
await shot('60-files-git-worktree');

/* 2026-09-26：工作区选中即显示 diff，不再需要"点开才有"这一步 */
await ev(`
  (() => {
    const r = [...document.querySelectorAll('.git-list-row')].find(x => x.innerText.includes('build-report.mjs'));
    if (r) r.click();
    const b = [...document.querySelectorAll('.git-detail .btn')].find(x => x.textContent.includes('展开 diff'));
    if (b) b.click();
    return true;
  })()
`);
await sleep(700);
await shot('61-files-git-worktree-diff-open');

/* 2. Git 标签 · 历史 */
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('历史')); t&&t.click(); return true; })()`);
await sleep(800);
await shot('62-files-git-history');

/* 3. Git 标签 · 分支与远端 */
await ev(`(() => { const t=[...document.querySelectorAll('.seg button')].find(e=>e.innerText.includes('分支')); t&&t.click(); return true; })()`);
await sleep(800);
await shot('63-files-git-branches');

/* 4. 文件标签 · 目录树 + 共享预览 */
await ev(`location.hash='/project/proj_zs_01/files?tab=files'; true`);
await sleep(1500);
await ev(`
  (() => {
    const r = [...document.querySelectorAll('.file-row')].find(x => x.innerText.includes('.ts'));
    if (r) r.click();
    return true;
  })()
`);
await sleep(900);
await shot('64-files-tree-preview');

/* 5. 文件标签 · 改动集（左栏切到改动集，右栏只显示一个详情） */
await ev(`
  (() => {
    const b = [...document.querySelectorAll('.fg-pane-list .seg button')].find(x => x.innerText.includes('改动集'));
    if (b) b.click();
    return true;
  })()
`);
await sleep(900);
await shot('65-files-changes-detail');

ws.close();
process.exit(0);
