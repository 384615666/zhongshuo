#!/usr/bin/env node
/**
 * R74 最终副本复证：真实启动器（start-desktop.bat）+ 发布形态下核两个交叉场景与基本布局——
 * ①混合标签：房间开 room-file.md 留标签 → 文件页开 layout.md → 侧栏房间点击=自动收起
 *   （显式恢复后两标签俱在、活动=文件页来源、草稿保留）；
 * ②项目打开在途取消：B 活跃 → A 房间直链（同刻双 hash 转设置——取消先于任何异步回执）→
 *   零提交（URL/当前项目/navigation.get 保持 B、零旧错误）；随后未取消正例正常落位；
 * ③基本布局：真分隔条拖动（rect 实际变化）+ 放大铺满 + Esc 还原。
 * 启动器清洗父环境 ZS_*（仅 ZS_DEV25_DEBUG_PORT 透传）——取消场景用双 hash 时序（无钩子）。
 * 零真实模型调用（real_calls 核对）。
 */
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const outDir = path.join(repo, 'dist', 'desktop', `r74-launcher-check-${Date.now()}`);
const copyDir = path.join(outDir, 'copy');
const PORT = 9716;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) { const t0 = Date.now(); for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error(`超时：${label}（${JSON.stringify(v)?.slice(0, 300)}）`); await sleep(300); } }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data);
      if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; }
      if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.errors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout')); } }, 60_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 300)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  async shot(p) { try { const png = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(p, Buffer.from(png.data, 'base64')); } catch { /* */ } }
}
async function connect(label) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) }).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && String(t.url).includes('index.html'));
      if (page) { const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); setTimeout(() => rej(new Error('ws timeout')), 5000); }); const c = new Cdp(ws); await c.send('Runtime.enable'); await c.send('Page.enable'); return c; }
    } catch { /* 重试 */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
function killCopy() {
  try { spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${copyDir.replace(/\\/g, '\\\\')}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { encoding: 'utf8', timeout: 60000 }); } catch { /* */ }
}
const pageCmd = (cdp, method, params) => cdp.eval(`window.zs.command({ protocolVersion: 1, commandId: 'r74lc-${Math.random().toString(36).slice(2, 10)}', method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }).then((r) => JSON.stringify(r))`).then((s) => JSON.parse(s));
let chipSnap = null;
async function chipStates(cdp) {
  return await cdp.tryEval(`(() => [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')].map((c) => ({ att: c.getAttribute('data-zs-att') || '', err: c.getAttribute('data-zs-att-error') || '', text: c.textContent.slice(0, 100) })))()`);
}
async function waitChip(cdp, name, ms = 60000) {
  return await until(async () => { chipSnap = await chipStates(cdp); return chipSnap.find((c) => c.att === 'ready' && c.text.includes(name) && !c.err) ?? null; }, (v) => v != null, ms, `芯片 ${name}`).catch((e) => { throw new Error(`${e.message}；chips=${JSON.stringify(chipSnap)}`); });
}

(async () => {
  const srcPkg = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v12');
  if (!fs.existsSync(srcPkg)) throw new Error('v12 包不存在');
  fs.mkdirSync(copyDir, { recursive: true });
  spawnSync('robocopy', [srcPkg, copyDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  const build = JSON.parse(fs.readFileSync(path.join(copyDir, 'ZhongshuoDual', 'BUILD.json'), 'utf8'));
  const projDirA = path.join(outDir, '项目A');
  const projDirB = path.join(outDir, '项目B');
  fs.mkdirSync(projDirA, { recursive: true });
  fs.mkdirSync(projDirB, { recursive: true });
  fs.writeFileSync(path.join(projDirA, '布局文件.md'), ['# 布局文件', '', 'LAUNCHER-LAYOUT-CONTENT 正文。', ...Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行占位。`)].join('\n'), 'utf8');
  fs.writeFileSync(path.join(projDirB, 'B说明.md'), '# B\n', 'utf8');
  const roomFile = path.join(outDir, 'room-file.md');
  fs.writeFileSync(roomFile, '# 房间文件\n\nLAUNCHER-ROOM-FILE-CONTENT', 'utf8');
  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(PORT) };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME; delete env.ZS_REAL_DISPATCH_GUARD;
  const child = spawn('cmd', ['/c', 'start-desktop.bat'], { cwd: copyDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const facts = { buildId: build.buildId, commit: build.commit };
  const errs = [];
  const dbOf = () => { const Database = require(path.join(repo, 'node_modules', 'better-sqlite3')); return new Database(path.join(copyDir, 'server-data', 'state.sqlite')); };
  try {
    let cdp = await connect('启动器');
    await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 90000, 'hifi');
    await sleep(2500);
    const openedA = await pageCmd(cdp, 'project.open', { path: projDirA });
    const openedB = await pageCmd(cdp, 'project.open', { path: projDirB });
    if (openedA?.ok !== true || openedB?.ok !== true) throw new Error('project.open: ' + JSON.stringify([openedA?.error, openedB?.error]));
    const projA = openedA.data.project; const projB = openedB.data.project;
    await cdp.eval('location.reload(), true');
    cdp = await connect('重载');
    await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 90000, 'hifi 重载');
    await sleep(2500);
    const roomA = dbOf().prepare('SELECT id FROM rooms WHERE project_id = ? LIMIT 1').get(projA.id).id;

    /* ① 混合标签：房间开 room-file.md 留标签 → 文件页开 布局文件.md → 侧栏房间=自动收起 */
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${projA.id}`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('默认房间')`)), (v) => v, 45000, '项目A');
    await cdp.eval('location.hash = ' + JSON.stringify(`/room/${roomA}`) + '; true');
    await until(() => cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`), (v) => v, 30000, '房间输入区');
    await sleep(600);
    await cdp.eval(probe(`(() => { const ta = document.querySelector('#hifi-root textarea.composer-input'); const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'R74启动器草稿'); ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`));
    await sleep(400);
    const b64 = fs.readFileSync(roomFile).toString('base64');
    await cdp.eval(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bytes], 'room-file.md', { type: 'text/markdown' })); const input = document.querySelector('#hifi-root input[type=file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitChip(cdp, 'room-file.md');
    await cdp.eval(probe(`(() => { const chips = [...document.querySelectorAll('#hifi-root [data-zs-attach-chips] .chip')]; const chip = chips.find((c) => (c.getAttribute('data-zs-att') === 'ready') && c.textContent.includes('room-file.md')); const btn = [...(chip?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === '预览'); btn?.click(); return btn != null; })()`));
    await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAUNCHER-ROOM-FILE-CONTENT')`)), (v) => v, 45000, '房间来源预览');
    await sleep(500);
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${projA.id}/files`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('布局文件.md')`)), (v) => v, 45000, '文件页');
    await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '布局文件.md'); rows[rows.length - 1]?.click(); return true; })()`));
    await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAUNCHER-LAYOUT-CONTENT')`)), (v) => v, 45000, '文件页预览');
    await sleep(500);
    for (let i = 0; i < 6; i += 1) {
      const hit = await cdp.tryEval(probe(`(() => { const rooms = [...document.querySelectorAll('#hifi-root button.side-item.sub')]; const hit = rooms.find((x) => x.textContent.includes('默认房间')); if (hit != null) { hit.click(); return true; } return null; })()`));
      if (hit === true) break;
      await cdp.eval(probe(`(() => { const caret = document.querySelector('#hifi-root .side-caret[aria-expanded=false]'); caret?.click(); return true; })()`));
      await sleep(700);
    }
    await until(() => cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`), (v) => v, 30000, '侧栏进房间');
    await sleep(1400);
    facts.mixedCollapse = await cdp.eval(probe(`(() => ({ composer: document.querySelector('#hifi-root textarea.composer-input') != null, draft: (document.querySelector('#hifi-root textarea.composer-input')?.value ?? '').includes('R74启动器草稿'), pvVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(), reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null }))()`));
    if (!(facts.mixedCollapse.composer && !facts.mixedCollapse.pvVisible && facts.mixedCollapse.reopenBtn)) errs.push(`①混合收起=${JSON.stringify(facts.mixedCollapse)}`);
    if (facts.mixedCollapse.draft !== true) errs.push('①草稿丢失');
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-reopen')?.click(), true`));
    await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAUNCHER-LAYOUT-CONTENT')`)), (v) => v, 30000, '显式重开');
    await sleep(700);
    facts.mixedRestore = await cdp.eval(probe(`(() => ({ tabs: [...document.querySelectorAll('#hifi-root .preview-tab .preview-tab-label')].map((x) => x.textContent.trim()), active: (document.querySelector('#hifi-root .preview-tab.on .preview-tab-label')?.textContent ?? '').trim() }))()`));
    if ((facts.mixedRestore.tabs ?? []).length !== 2 || !String(facts.mixedRestore.active).includes('布局文件')) errs.push(`①恢复标签=${JSON.stringify(facts.mixedRestore)}`);

    /* ② 基本布局：分隔条拖动 + 放大铺满 + Esc 还原 */
    const rectOf = () => cdp.eval(probe(`(() => { const pv = document.querySelector('#hifi-root .preview-pane'); const sp = document.querySelector('#hifi-root .splitter[aria-label*="预览"]'); const b = pv.getBoundingClientRect(); return { pvW: Math.round(b.width), sp: sp == null ? null : Math.round(sp.getBoundingClientRect().left) }; })()`));
    const before = await rectOf();
    if (before.sp == null) errs.push('②无分隔条');
    else {
      const spC = await cdp.eval(probe(`(() => { const b = document.querySelector('#hifi-root .splitter[aria-label*="预览"]').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spC.x, y: spC.y, button: 'left', clickCount: 1 });
      for (const dx of [40, 100, 160]) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spC.x + dx, y: spC.y, button: 'left', buttons: 1 }); await sleep(110); }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spC.x + 200, y: spC.y, button: 'left', clickCount: 1 });
      await sleep(600);
      const after = await rectOf();
      facts.drag = { before: before.pvW, after: after.pvW };
      if (!(after.pvW < before.pvW - 100)) errs.push(`②拖动=${JSON.stringify(facts.drag)}`);
    }
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('放大预览')); b?.click(); return true; })()`));
    await sleep(700);
    facts.max = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); const ws = document.querySelector('#hifi-root .workspace'); const b = p.getBoundingClientRect(); const wb = ws.getBoundingClientRect(); return { fills: Math.abs(b.width - wb.width) <= 6 && Math.abs(b.left - wb.left) <= 6 && Math.abs(b.top - wb.top) <= 6 }; })()`));
    if (!(facts.max && facts.max.fills)) errs.push(`②放大=${JSON.stringify(facts.max)}`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(700);
    facts.escBack = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); return { w: Math.round(p.getBoundingClientRect().width), cls: p.classList.contains('maximized') }; })()`));
    if (facts.escBack.cls || Math.abs(facts.escBack.w - facts.drag.after) > 8) errs.push(`②Esc还原=${JSON.stringify(facts.escBack)}`);

    /* ③ 项目打开在途取消（双 hash——取消先于任何异步回执）+ 未取消正例 */
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${projB.id}`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('默认房间')`)), (v) => v, 45000, '项目B 聚焦');
    await sleep(1200);
    facts.baseline = await cdp.tryEval(probe(`(document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim()`));
    await cdp.eval(probe(`(() => { location.hash = ${JSON.stringify(`/project/${projA.id}/room/${roomA}`)}; location.hash = '/settings'; return location.hash; })()`));
    await until(() => cdp.tryEval(`location.hash.startsWith('#/settings')`), (v) => v, 15000, '设置页');
    await sleep(4500);
    facts.openCancel = await cdp.eval(probe(`(() => ({ hash: location.hash.slice(0, 30), active: (document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim(), toasts: [...document.querySelectorAll('.toast-host .toast')].map((t) => t.textContent.trim().slice(0, 40)) }))()`));
    const prefs = await pageCmd(cdp, 'navigation.get', { clientId: 'desktop-hifi' });
    facts.openCancelPrefs = prefs?.data?.prefs?.activeProjectId ?? null;
    if (!(facts.openCancel.hash.startsWith('#/settings') && String(facts.openCancel.active).includes('项目B') && facts.openCancel.toasts.length === 0)) errs.push(`③取消=${JSON.stringify(facts.openCancel)}`);
    if (facts.openCancelPrefs === projA.id) errs.push('③取消后写了导航偏好(A)');
    // 未取消正例：A 房间直链正常落位
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${projB.id}`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('默认房间')`)), (v) => v, 45000, '回 B');
    await sleep(900);
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${projA.id}/room/${roomA}`) + '; true');
    await until(() => cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`), (v) => v, 60000, '③正例 A 房间');
    facts.positiveActive = await cdp.tryEval(probe(`(document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim()`));
    if (!String(facts.positiveActive).includes('项目A')) errs.push(`③正例=${facts.positiveActive}`);

    facts.consoleErrors = (cdp.errors ?? []).filter((e) => !e.includes('React DevTools')).slice(0, 3);
    if (facts.consoleErrors.length > 0) errs.push(`console=${JSON.stringify(facts.consoleErrors)}`);
    const db = dbOf();
    facts.realCalls = db.prepare('SELECT count(*) c FROM real_calls').get().c;
    db.close();
    if (facts.realCalls !== 0) errs.push(`realCalls=${facts.realCalls}`);
    await cdp.shot(path.join(outDir, 'launcher-r74.png'));
  } finally {
    killCopy();
    await sleep(1500);
  }
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: errs.length === 0, errs, facts }, null, 2));
  console.log(JSON.stringify({ ok: errs.length === 0, errs, facts }, null, 2));
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('launcher check 崩溃：', e.message); killCopy(); process.exit(1); });
