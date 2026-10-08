#!/usr/bin/env node
/**
 * R72 最终副本复证：真实启动器（start-desktop.bat）+ 发布形态（zsres://app + CSP）下
 * 的**原始文件树路径**——复制 v10 包到独立目录，项目夹含真实 22.54MiB 内蒙古 PPT，
 * 文件树点击 → 82 页 → 图文页图片解码。零真实模型调用（发布形态无 fake 环境）。
 */
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const outDir = path.join(repo, 'dist', 'desktop', `r72-launcher-check-${Date.now()}`);
const copyDir = path.join(outDir, 'copy');
const PORT = 9712;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const probe = (expr) => `(() => { try { return ${expr}; } catch (e) { return 'ERR:' + e.message; } })()`;
async function until(fn, ok, ms, label) { const t0 = Date.now(); for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error(`超时：${label}（${JSON.stringify(v)?.slice(0, 300)}）`); await sleep(300); } }
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = []; this.closed = false;
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id != null && this.pending.has(d.id)) { const { resolve, reject } = this.pending.get(d.id); this.pending.delete(d.id); d.error != null ? reject(new Error(d.error.message)) : resolve(d.result); return; } if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') this.errors.push(String(d.params.args?.map((a) => a.value ?? a.description ?? '').join(' ')).slice(0, 200)); });
    ws.addEventListener('close', () => { this.closed = true; }); }
  async send(method, params = {}) { if (this.closed) throw new Error('cdp closed'); const id = ++this.seq; return await new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 60_000); }).catch((e) => { throw new Error(`${method}: ${e.message}`); }); }
  async eval(expr) { const v = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (v.exceptionDetails) throw new Error('eval: ' + String(v.exceptionDetails.exception?.description ?? v.exceptionDetails.text).slice(0, 300)); return v.result.value; }
  async tryEval(expr) { try { return await this.eval(expr); } catch { return null; } }
  async shot(p) { try { const png = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(p, Buffer.from(png.data, 'base64')); } catch { /* */ } }
}
async function connectPage(label) {
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
  const srcPkg = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v10');
  if (!fs.existsSync(srcPkg)) throw new Error('v10 包不存在');
  fs.mkdirSync(copyDir, { recursive: true });
  spawnSync('robocopy', [srcPkg, copyDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  const build = JSON.parse(fs.readFileSync(path.join(copyDir, 'ZhongshuoDual', 'BUILD.json'), 'utf8'));
  // 用户项目夹具：真实 22.54MiB PPT（只读复制到夹具目录）。
  const projDir = path.join(outDir, '我的文档项目');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, '说明.md'), '# 项目\n', 'utf8');
  fs.copyFileSync('C:/Users/user/Documents/文档测试/内蒙古职工互助系统建设方案@1010.pptx', path.join(projDir, '内蒙古职工互助系统建设方案@1010.pptx'));
  const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(PORT) };
  delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME; delete env.ZS_REAL_DISPATCH_GUARD;
  const child = spawn('cmd', ['/c', 'start-desktop.bat'], { cwd: copyDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const facts = { buildId: build.buildId, commit: build.commit };
  let cdp;
  try {
    cdp = await connectPage('启动器首启');
    await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 90000, 'hifi 壳');
    await sleep(2500);
    // 发布形态命令层：注册项目（与「打开文件夹」同一命令面）。
    const v0 = await cdp.eval(`window.zs.command({ protocolVersion: 1, commandId: 'r72-lc-' + Math.random().toString(36).slice(2, 10), method: 'project.open', params: ${JSON.stringify({ path: projDir })} }).then((r) => JSON.stringify(r))`);
    const opened = JSON.parse(v0);
    if (opened?.ok !== true) throw new Error('project.open: ' + JSON.stringify(opened?.error).slice(0, 200));
    const proj = opened.data.project;
    facts.dtoRootPath = typeof proj.rootPath === 'string';
    // raw command 不写前端注册表（真实「打开文件夹」链由 openProjectByPath 即时 upsert）。
    // 重载一次=「注册后重开」路径：bootRemembered 装载注册表→侧栏列出→项目主页聚焦生效。
    await cdp.eval('location.reload(), true');
    cdp = await connectPage('重载');
    await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 90000, 'hifi 壳（重载）');
    await sleep(2500);
    // 用户实际路径=打开文件夹后即聚焦该项目（UI 打开链会置 active）——raw command 不会，
    // 先经项目主页聚焦（switchFocusProject 装载），再进文件页。
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${proj.id}`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('默认房间') || document.querySelector('#hifi-root .side-project .side-row.context-active') != null`)), (v) => v, 45000, '项目聚焦');
    await sleep(1200);
    // 文件树 → 点击真实 PPT（用户原始路径）。
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${proj.id}/files`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('内蒙古职工互助系统建设方案@1010.pptx')`)), (v) => v, 45000, '树列大 PPT');
    const t0 = Date.now();
    await cdp.eval(`(() => { const rows = [...document.querySelectorAll('#hifi-root .file-tree *')].filter((x) => x.childElementCount <= 2 && x.textContent.trim() === '内蒙古职工互助系统建设方案@1010.pptx'); rows[rows.length - 1]?.click(); return true; })()`);
    await until(() => cdp.tryEval(probe(`(() => { const v = document.querySelector('#hifi-root [data-zs-pptx-view]'); return v != null && Number(v.getAttribute('data-zs-pptx-pages')) > 0; })()`)), (v) => v, 180000, '发布形态树开 PPT（82 页）');
    facts.treePages = Number(await cdp.tryEval(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-pages')`));
    facts.treeMs = Date.now() - t0;
    await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root .pptx-main .pptx-slide-mount > *') != null`)), (v) => v, 120000, '主舞台首页');
    // 图文页 p40 图片解码（发布形态 CSP：img-src blob: 放行链）。
    await cdp.eval(probe(`document.querySelectorAll('#hifi-root .pptx-thumb')[39]?.click(), true`));
    await until(() => cdp.tryEval(probe(`document.querySelector('#hifi-root [data-zs-pptx-view]')?.getAttribute('data-zs-pptx-page') === '40'`)), (v) => v, 90000, '跳页 40');
    await sleep(2600);
    facts.p40Imgs = await cdp.tryEval(probe(`(() => { const root = document.querySelector('#hifi-root .pptx-main .pptx-slide-mount'); if (root == null) return null; const is = [...root.querySelectorAll('img')]; return { imgs: is.length, decoded: is.filter((i) => i.complete && i.naturalWidth > 0).length }; })()`));
    facts.consoleErrors = (cdp.errors ?? []).filter((e) => !e.includes('React DevTools')).slice(0, 3);
    await cdp.shot(path.join(outDir, 'launcher-tree-ppt.png'));
    const dbPath = path.join(copyDir, 'server-data', 'state.sqlite');
    if (fs.existsSync(dbPath)) {
      const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
      const db = new Database(dbPath);
      facts.realCalls = db.prepare('SELECT count(*) c FROM real_calls').get().c;
      db.close();
    }
  } finally {
    killCopy();
    await sleep(1500);
  }
  const errs = [];
  if (facts.treePages == null || facts.treePages < 80) errs.push(`发布形态树开页数=${facts.treePages}`);
  if (facts.p40Imgs == null || (facts.p40Imgs.imgs > 0 && facts.p40Imgs.decoded !== facts.p40Imgs.imgs)) errs.push(`p40 图片=${JSON.stringify(facts.p40Imgs)}`);
  if ((facts.consoleErrors ?? []).length > 0) errs.push(`console=${JSON.stringify(facts.consoleErrors)}`);
  if (facts.realCalls == null || facts.realCalls !== 0) errs.push(`realCalls=${facts.realCalls}`);
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: errs.length === 0, errs, facts }, null, 2));
  console.log(JSON.stringify({ ok: errs.length === 0, errs, facts }, null, 2));
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('launcher check 崩溃：', e.message); killCopy(); process.exit(1); });
