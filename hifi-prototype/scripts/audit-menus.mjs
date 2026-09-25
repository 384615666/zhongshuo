/**
 * 菜单项与次级操作的颜色审计。
 *
 * 背景：`新建群聊 / 发送 / 保存 / 引用` 四个主按钮已实测带 `--grad`（见
 * `shot-desktop-buttons.mjs` 的输出与截图），但用户仍反馈"颜色没改"。
 * 需要排查**用户实际看到的是不是另一组控件** —— 菜单项、次级按钮、
 * 以及被禁用（opacity .5）时的观感。
 *
 * 本脚本把"同一功能的多种呈现"都拍下来，避免继续对着错误的控件下结论。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'screenshots-visual');
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const PORT = process.env.ZS_VIS_CDP_PORT ?? '9335';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = l.find((t) => t.type === 'page');
const ws = new WebSocket(pg.webSocketDebuggerUrl);
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

/** 列出**当前可见**的所有"可点击控件"，按出现顺序 */
const VISIBLE_CONTROLS = `(() => {
  const out = [];
  const seen = new Set();
  const nodes = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="menuitemradio"], a.btn')];
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    // 是否被遮挡（简单判断：中心点上不是它或它的子元素）
    const cx = r.x + r.width/2, cy = r.y + r.height/2;
    const top = document.elementFromPoint(cx, cy);
    const covered = top && !el.contains(top) && top !== el;
    if (covered) continue;
    const text = (el.textContent || '').trim().replace(/\\s+/g,' ').slice(0, 16);
    const key = text + '|' + el.className + '|' + Math.round(r.y);
    if (seen.has(key)) continue; seen.add(key);
    const img = cs.backgroundImage;
    out.push({
      text: text || '(' + (el.getAttribute('aria-label') || el.title || '').slice(0,16) + ')',
      cls: String(el.className).slice(0, 34),
      y: Math.round(r.y),
      x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
      kind: img.includes('gradient') ? (img.includes('37, 99, 235') ? 'grad-soft' : 'grad') : (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? 'solid:' + cs.backgroundColor : 'flat'),
      disabled: el.disabled === true,
      opacity: cs.opacity,
    });
  }
  return out;
})()`;

const SCENES = [
  ['主池-消息菜单', '/project/proj_zs_01/room/room_dev_hall?recovery=0',
    `(() => { const b = document.querySelector('.msg-actions button[title*="更多"], .msg-actions .icon-btn:last-child'); if(b) b.click(); return !!b; })()`],
  ['线程-更多菜单', '/project/proj_zs_01/room/room_dev_hall?thread=thread_t14&recovery=0',
    // 用例更新（2026-09-24 减负）：线程顶部图标组已删除，⋯ 在单行导航最右侧
    `(() => { const b = document.querySelector('.col-thread .thread-nav button[aria-haspopup="menu"]'); if(b) b.click(); return !!b; })()`],
  ['成果页-导出弹窗', '/artifact/artifact_12_team_report?recovery=0', null],
  ['私信-顶栏加号', '/project/proj_zs_01/dm?recovery=0',
    `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('新建私聊')); if(b) b.click(); return !!b; })()`],
  ['设置-保存/重置', '/settings?section=general&recovery=0', null],
];

for (const [name, hash, click] of SCENES) {
  await ev(`localStorage.clear(); true`);
  await ev(`location.hash=${JSON.stringify(hash)}; true`);
  await send('Page.reload', { ignoreCache: true });
  await sleep(3400);
  if (click) { await ev(click); await sleep(1100); }
  const rows = await ev(VISIBLE_CONTROLS);
  console.log(`\n### ${name}  (${Array.isArray(rows) ? rows.length : 0} 个可见控件)`);
  for (const r of (rows ?? [])) {
    const mark = r.kind === 'grad' ? '[GRAD]' : r.kind === 'grad-soft' ? '[SOFT]' : r.kind.startsWith('solid') ? '[SOLID]' : '[flat]';
    const d = r.disabled ? ' DISABLED(op=' + r.opacity + ')' : '';
    console.log(`  ${mark.padEnd(8)} ${r.text.padEnd(18)} ${r.cls.padEnd(36)} y=${String(r.y).padEnd(4)} ${r.kind.padEnd(26)}${d}`);
  }
  // 出图（场景名里的 `/` 不能直接当文件名：会变成子目录并 ENOENT，实测崩溃）
  const safeName = name.replace(/[\\/:*?"<>|]/g, '-');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(join(out, `menu-${safeName}.png`), Buffer.from(shot.result.data, 'base64'));
  }
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
  await sleep(400);
}

ws.close();
process.exit(0);
