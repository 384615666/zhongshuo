/**
 * 四条修复的取证截图：
 *   A. 1440px 开发大厅主池（顶部已无写入横幅）
 *   B. 1440px 回复串 + 附件（回复串宽度不变、有过渡）
 *   C. 1280px 回复串 + 附件（此前线程绝对定位盖住预览 → "只显示半个"）
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-visual');
if (!existsSync(out)) mkdirSync(out, { recursive: true });
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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) { writeFileSync(join(out, name), Buffer.from(r.result.data, 'base64')); console.log('  → ' + name); }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
await ev(`localStorage.clear(); true`);

/* A. 1440 主池（无横幅） */
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(600);
console.log('A. 1440 主池（顶部无写入横幅）');
await shot('fix-A-1440-pool-no-banner.png');

/* B. 1440 回复串 + 附件 */
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await sleep(1600);
await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(500);
await ev(`(() => { const a = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明')); if (a) a.click(); return !!a; })()`);
await sleep(1800);
await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(600);
console.log('B. 1440 回复串 + 附件（回复串保持 620px）');
await shot('fix-B-1440-thread-preview.png');

/* C. 1280 回复串 + 附件（此前重叠） */
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await ev(`localStorage.clear(); true`);
await ev(`location.hash='/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0'; true`);
await send('Page.reload', { ignoreCache: true });
await sleep(3400);
await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(500);
await ev(`(() => { const a = [...document.querySelectorAll('.msg-attach')].find(x => x.textContent.includes('预览交互设计说明')); if (a) a.click(); return !!a; })()`);
await sleep(1800);
await ev(`window.dispatchEvent(new Event('resize')); true`); await sleep(600);
console.log('C. 1280 回复串 + 附件（不再重叠）');
await shot('fix-C-1280-thread-preview.png');

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
ws.close();
process.exit(0);
