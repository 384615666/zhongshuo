#!/usr/bin/env node
/**
 * R73 最终副本复证：真实启动器（start-desktop.bat）+ 发布形态下核三项用户反馈修复——
 * ①文件页打开→侧栏房间点击=自动收起（房间对话/输入框正常）；②房间预览真分隔条拖动
 * （rect 实际变化）；③放大/还原（rect 铺满工作区/回并排）。零真实模型调用。
 */
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const outDir = path.join(repo, 'dist', 'desktop', `r73-launcher-check-${Date.now()}`);
const copyDir = path.join(outDir, 'copy');
const PORT = 9716;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) { const t0 = Date.now(); for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error(`超时：${label}（${JSON.stringify(v)?.slice(0, 300)}）`); await sleep(300); } }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; } if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.errors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
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
    } catch { /* */ }
    if (Date.now() > deadline) throw new Error(`${label}: CDP 连接超时`);
    await sleep(700);
  }
}
function killCopy() {
  try { spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${copyDir.replace(/\\/g, '\\\\')}*' -and $_.Name -notin @('powershell.exe','WmiPrvSE.exe','conhost.exe','bash.exe','cmd.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { encoding: 'utf8', timeout: 60000 }); } catch { /* */ }
}
(async () => {
  const srcPkg = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v11');
  if (!fs.existsSync(srcPkg)) throw new Error('v11 包不存在');
  fs.mkdirSync(copyDir, { recursive: true });
  spawnSync('robocopy', [srcPkg, copyDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  const build = JSON.parse(fs.readFileSync(path.join(copyDir, 'ZhongshuoDual', 'BUILD.json'), 'utf8'));
  const projDir = path.join(outDir, '我的项目');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, '说明.md'), '# 项目\n\nLAUNCHER-FILE-CONTENT', 'utf8');
  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(PORT) };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME; delete env.ZS_REAL_DISPATCH_GUARD;
  const child = spawn('cmd', ['/c', 'start-desktop.bat'], { cwd: copyDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  const facts = { buildId: build.buildId, commit: build.commit };
  const errs = [];
  try {
    let cdp = await connect('启动器');
    await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 90000, 'hifi');
    await sleep(2500);
    const v0 = await cdp.eval(`window.zs.command({ protocolVersion: 1, commandId: 'r73-lc-' + Math.random().toString(36).slice(2, 10), method: 'project.open', params: ${JSON.stringify({ path: projDir })} }).then((r) => JSON.stringify(r))`);
    const opened = JSON.parse(v0);
    if (opened?.ok !== true) throw new Error('project.open: ' + JSON.stringify(opened?.error).slice(0, 200));
    const proj = opened.data.project;
    // 重载=注册后重开（raw 命令不写前端注册表）
    await cdp.eval('location.reload(), true');
    cdp = await connect('重载');
    await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 90000, 'hifi 重载');
    await sleep(2500);
    // ① 文件页打开 → 侧栏房间点击 → 自动收起
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${proj.id}`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('默认房间')`)), (v) => v, 45000, '项目');
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${proj.id}/files`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('说明.md')`)), (v) => v, 45000, '文件页');
    await cdp.eval(probe(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '说明.md'); rows[rows.length - 1]?.click(); return true; })()`));
    await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .preview-body')?.textContent.includes('LAUNCHER-FILE-CONTENT')`)), (v) => v, 45000, '文件页预览');
    for (let i = 0; i < 6; i += 1) {
      const hit = await cdp.tryEval(probe(`(() => { const rooms = [...document.querySelectorAll('#hifi-root button.side-item.sub')]; const hit = rooms.find((x) => x.textContent.includes('默认房间')); if (hit != null) { hit.click(); return true; } return null; })()`));
      if (hit === true) break;
      await cdp.eval(probe(`(() => { const caret = document.querySelector('#hifi-root .side-caret[aria-expanded=false]'); caret?.click(); return true; })()`));
      await sleep(700);
    }
    await until(() => cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`), (v) => v, 30000, '侧栏进房间');
    await sleep(1300);
    facts.autoCollapse = await cdp.eval(probe(`(() => ({ composer: document.querySelector('#hifi-root textarea.composer-input') != null, pool: document.querySelector('#hifi-root .col-main') != null, pvVisible: (() => { const p = document.querySelector('#hifi-root .preview-pane'); return p != null && p.getBoundingClientRect().width > 0; })(), reopenBtn: document.querySelector('#hifi-root .preview-reopen') != null }))()`));
    if (!(facts.autoCollapse.composer && facts.autoCollapse.pool && !facts.autoCollapse.pvVisible && facts.autoCollapse.reopenBtn)) errs.push(`①自动收起=${JSON.stringify(facts.autoCollapse)}`);
    // ② 重开预览（显式）→ 分隔条拖动 rect 变化
    await cdp.eval(probe(`document.querySelector('#hifi-root .preview-reopen')?.click(), true`));
    await until(() => cdp.tryEval(probe(`(() => { const b = document.querySelector('#hifi-root .preview-body'); return b != null && b.textContent.includes('LAUNCHER-FILE-CONTENT'); })()`)), (v) => v, 30000, '显式重开');
    await sleep(700);
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
    // ③ 放大铺满 → Esc 还原
    await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .preview-icon-btn')].find((x) => (x.title || '').includes('放大预览')); b?.click(); return true; })()`));
    await sleep(700);
    facts.max = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); const ws = document.querySelector('#hifi-root .workspace'); const b = p.getBoundingClientRect(); const wb = ws.getBoundingClientRect(); return { pvW: Math.round(b.width), wsW: Math.round(wb.width), top: Math.round(b.top), wsTop: Math.round(wb.top), fills: Math.abs(b.width - wb.width) <= 6 && Math.abs(b.left - wb.left) <= 6 && Math.abs(b.top - wb.top) <= 6 }; })()`));
    if (!(facts.max && facts.max.fills)) errs.push(`③放大=${JSON.stringify(facts.max)}`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(700);
    facts.escBack = await cdp.eval(probe(`(() => { const p = document.querySelector('#hifi-root .preview-pane'); const b = p.getBoundingClientRect(); return { w: Math.round(b.width), cls: p.classList.contains('maximized') }; })()`));
    if (facts.escBack.cls || Math.abs(facts.escBack.w - facts.drag.after) > 8) errs.push(`③Esc还原=${JSON.stringify(facts.escBack)}`);
    facts.consoleErrors = (cdp.errors ?? []).filter((e) => !e.includes('React DevTools')).slice(0, 3);
    if (facts.consoleErrors.length > 0) errs.push(`console=${JSON.stringify(facts.consoleErrors)}`);
    const dbPath = path.join(copyDir, 'server-data', 'state.sqlite');
    if (fs.existsSync(dbPath)) {
      const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
      const db = new Database(dbPath);
      facts.realCalls = db.prepare('SELECT count(*) c FROM real_calls').get().c;
      db.close();
    }
    if (facts.realCalls !== 0) errs.push(`realCalls=${facts.realCalls}`);
    await cdp.shot(path.join(outDir, 'launcher-r73.png'));
  } finally {
    killCopy();
    await sleep(1500);
  }
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: errs.length === 0, errs, facts }, null, 2));
  console.log(JSON.stringify({ ok: errs.length === 0, errs, facts }, null, 2));
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('launcher check 崩溃：', e.message); killCopy(); process.exit(1); });
