#!/usr/bin/env node
/**
 * R75 最终副本复证：真实启动器（start-desktop.bat）+ 发布形态下核**普通项目打开路线**
 * （review-r74 §P1 反例本体：从 A 房间经真实弹窗打开已注册 B——无任何延迟钩子）：
 *  ① A 房间 → 侧栏「打开/切换项目」→ 弹窗（autoPick 经 pickFolder 桥，ZS_PICK_FOLDER_FILE
 *     按序供目录——发布 bat 显式工程直通）→「打开这个目录」→ URL/当前项目/输入区/zs.lastProjectPath
 *     全部落 B 的房间；A 保留在侧栏；零 toast。
 *  ② 再开新目录 C（第二次弹窗）→ 最新意图落位 C。
 *  ③ 重启（无钩子）→ 仍进入 C（最后用户意图）。
 *  ④ 基本面：房间输入区/文件页可达、console 0、realCalls=0。
 */
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const outDir = path.join(repo, 'dist', 'desktop', `r75-launcher-check-${Date.now()}`);
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
  const prefix = (copyDir + path.sep).replaceAll("'", "''");
  try { spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { encoding: 'utf8', timeout: 60000 }); } catch { /* */ }
}
const activeLabel = (cdp) => cdp.tryEval(probe(`(document.querySelector('#hifi-root .side-row.context-active .side-item-label')?.textContent ?? 'none').trim()`));
const lastPathOf = (cdp) => cdp.tryEval(`localStorage.getItem('zs.lastProjectPath')`);
const toastsOf = (cdp) => cdp.tryEval(probe(`[...document.querySelectorAll('.toast-host .toast')].map((t) => t.textContent.trim().slice(0, 50))`));
async function modalOpenCurrentPick(cdp) {
  await cdp.eval(probe(`(() => { const b = [...document.querySelectorAll('#hifi-root .side-item')].find((x) => x.textContent.includes('打开/切换项目')); b?.click(); return b != null; })()`));
  await until(() => cdp.tryEval(`document.querySelector('#hifi-root .modal input.input') != null`), (v) => v, 10000, '打开弹窗');
  await until(() => cdp.tryEval(probe(`(() => { const i = document.querySelector('#hifi-root .modal input.input'); return i != null && i.value.length > 3; })()`)), (v) => v, 20000, '目录选择回填（autoPick）');
  await cdp.eval(probe(`(() => { const m = [...document.querySelectorAll('#hifi-root .modal')].find((x) => x.textContent.includes('打开文件夹')); const b = [...(m?.querySelectorAll('button') ?? [])].find((x) => x.textContent.includes('打开这个目录')); b?.click(); return b != null; })()`));
  await until(() => cdp.tryEval(`document.querySelector('#hifi-root .modal') == null`), (v) => v, 45000, '弹窗关闭（打开完成）');
}

(async () => {
  // 拒绝接入其它验证实例的调试端口；只控制本脚本创建的独立副本。
  const portProbe = require('node:net').createServer();
  await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(PORT, '127.0.0.1', resolve); });
  await new Promise((resolve) => portProbe.close(resolve));
  const srcArg = process.argv.indexOf('--src');
  const srcPkg = srcArg < 0 ? path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v13') : path.resolve(process.argv[srcArg + 1]);
  if (!fs.existsSync(srcPkg)) throw new Error(`候选包不存在：${srcPkg}`);
  fs.mkdirSync(copyDir, { recursive: true });
  spawnSync('robocopy', [srcPkg, copyDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { timeout: 300_000 });
  const build = JSON.parse(fs.readFileSync(path.join(copyDir, 'ZhongshuoDual', 'BUILD.json'), 'utf8'));
  const projA = path.join(outDir, '项目A');
  const projB = path.join(outDir, '项目B');
  const projC = path.join(outDir, '项目C');
  for (const [d, n] of [[projA, '项目A'], [projB, '项目B'], [projC, '项目C']]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `${n}.md`), `# ${n}\n`, 'utf8'); }
  const pickFile = path.join(outDir, 'pick.txt');
  fs.writeFileSync(pickFile, [projB, projC].join('\r\n'), 'utf8'); // 两次弹窗按序取 B、C
  const facts = { buildId: build.buildId, commit: build.commit };
  const errs = [];
  let child = null;
  let currentCdp = null;
  const startBat = () => {
    const env = { ...process.env, ZS_DEV25_DEBUG_PORT: String(PORT), ZS_PICK_FOLDER_FILE: pickFile,
      // eslint-disable-next-line no-undef
      ...(process.argv.includes('--r79-read') ? { ZS_SAVEAS_AUTO_DIR: path.join(outDir,'saved-originals') } : {}) };
    delete env.ZS_RUNTIME; delete env.ZS_ALLOW_FAKE; delete env.ZS_APP_DATA; delete env.ZS_PIPE_NAME; delete env.ZS_REAL_DISPATCH_GUARD; delete env.ZS_UI_DELAY_METHOD_MS;
    child = spawn('cmd', ['/c', 'start-desktop.bat'], { cwd: copyDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  };
  const stopBat = async () => {
    try { if (currentCdp != null && !currentCdp.closed) await Promise.race([currentCdp.send('Browser.close'), sleep(2000)]); } catch { /* 已退出 */ }
    await sleep(2500);
    killCopy();
  };
  try {
    /* ① A 房间 → 真实弹窗开已注册 B（反例本体） */
    startBat();
    let cdp = await connect('启动器');
    currentCdp = cdp;
    await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 90000, 'hifi');
    await sleep(2500);
    const openRaw = (p) => cdp.eval(`window.zs.command({ protocolVersion: 1, commandId: 'r75lc-${Math.random().toString(36).slice(2, 10)}', method: 'project.open', params: ${JSON.stringify({ path: p })} }).then((r) => JSON.stringify(r))`).then((s) => JSON.parse(s));
    const oa = await openRaw(projA);
    await openRaw(projB); // B 也预注册（「已注册 B」路径）
    if (oa?.ok !== true) throw new Error('project.open A: ' + JSON.stringify(oa?.error));
    const projAId = oa.data.project.id;
    await cdp.eval('location.reload(), true');
    cdp = await connect('重载');
    currentCdp = cdp;
    await until(() => cdp.tryEval(`document.body.classList.contains('hifi-on')`), (v) => v, 90000, 'hifi 重载');
    await sleep(2500);
    // 进入 A 房间（发布形态正常路由）
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${projAId}`) + '; true');
    await until(() => cdp.tryEval(probe(`document.body.textContent.includes('默认房间')`)), (v) => v, 45000, '项目A 装载');
    const roomBtn = await cdp.eval(probe(`(() => { const rooms = [...document.querySelectorAll('#hifi-root button.side-item.sub')]; const hit = rooms.find((x) => x.textContent.includes('默认房间')); if (hit != null) { hit.click(); return true; } return null; })()`));
    if (roomBtn !== true) throw new Error('未进入 A 房间');
    await until(() => cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`), (v) => v, 45000, 'A 房间输入区');
    await sleep(800);
    facts.origin = { hash: await cdp.tryEval(`location.hash.slice(0, 46)`), active: await activeLabel(cdp) };
    // 真实弹窗开 B
    await modalOpenCurrentPick(cdp);
    await sleep(1800);
    facts.openB = {
      hash: await cdp.tryEval(`location.hash`),
      active: await activeLabel(cdp),
      composer: await cdp.tryEval(`document.querySelector('#hifi-root textarea.composer-input') != null`),
      lastPath: await lastPathOf(cdp),
      projAKept: await cdp.tryEval(probe(`[...document.querySelectorAll('#hifi-root .side-item-label')].some((x) => x.textContent.includes('项目A'))`)),
      toasts: await toastsOf(cdp),
    };
    if (!(String(facts.openB.hash).includes('/room/') && String(facts.openB.active).includes('项目B') && facts.openB.composer === true && facts.openB.lastPath === projB && facts.openB.projAKept === true && (facts.openB.toasts ?? []).length === 0)) {
      errs.push(`①房间开B=${JSON.stringify(facts.openB)}`);
    }
    await cdp.shot(path.join(outDir, 'launcher-openB.png'));

    /* ② 再开新目录 C（第二次弹窗）→ 最新意图 */
    await modalOpenCurrentPick(cdp);
    await sleep(1800);
    facts.openC = { hash: await cdp.tryEval(`location.hash`), active: await activeLabel(cdp), lastPath: await lastPathOf(cdp), toasts: await toastsOf(cdp) };
    if (!(String(facts.openC.hash).includes('/room/') && String(facts.openC.active).includes('项目C') && facts.openC.lastPath === projC)) errs.push(`②再开C=${JSON.stringify(facts.openC)}`);

    /* ③ 重启（清钩子）→ 仍进入 C（最后用户意图） */
    await stopBat();
    startBat();
    cdp = await connect('重启');
    currentCdp = cdp;
    await until(() => cdp.tryEval(`document.querySelector('#hifi-root .side-row.context-active .side-item-label') != null`), (v) => v, 90000, '重启就绪');
    await sleep(2000);
    facts.restart = { active: await activeLabel(cdp), lastPath: await lastPathOf(cdp) };
    if (!String(facts.restart.active).includes('项目C')) errs.push(`③重启=${JSON.stringify(facts.restart)}`);
    // 基本面：文件页可达 + console + realCalls
    const pidC = facts.openC.hash.match(/\/project\/([^/]+)\//)?.[1] ?? '';
    await cdp.eval('location.hash = ' + JSON.stringify(`/project/${pidC}/files`) + '; true');
    await until(() => cdp.tryEval(`document.querySelector('#hifi-root .file-tree') != null`), (v) => v, 45000, '文件页');
    facts.filesOk = true;
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
    if (process.argv.includes('--r79-read')) facts.readRegression = await require('./verify-r79-read-extension.cjs')({ cdp, projectId:pidC, project:projC, copy:copyDir, out:outDir, until, sleep });
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
    await cdp.shot(path.join(outDir, 'launcher-end.png'));
  } finally {
    await stopBat();
    killCopy();
    await sleep(1500);
  }
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: errs.length === 0, errs, facts }, null, 2));
  console.log(JSON.stringify({ ok: errs.length === 0, errs, facts }, null, 2));
  process.exit(errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('launcher check 崩溃：', e.message); killCopy(); process.exit(1); });
