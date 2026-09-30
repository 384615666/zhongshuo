/**
 * 便携产物 renderer 真实用户链路验收（CDP）。任务提交与验收全部经页面按钮；文件选择器
 * ZS_PICK_FOLDER 显式可审计钩子；测试数据=合成 fixture。
 *
 * 第二十二轮重写要点：
 * - 失败留档：每轮独立 runId 目录（stderr 落盘/元数据/超时现场截图+进程清单），历史不覆盖；
 * - 冻结产物：ZS_VDR_FROZEN=1——首次构建后冻结到 dist/desktop/vdr-frozen，后续运行逐文件
 *   核对 SHA256 后复用同一产物（验收期间被重建/覆盖=中止），支持"同一产物三次验证"；
 * - 每会话独立 ZS_PIPE_NAME（C 间歇根因修复：默认管道按用户固定，前实例未退净时两 daemon
 *   同名共存、UI 可能连错实例——token 不同→认证失败→间歇挂起）；
 * - 验证器助手全截止（fetch/WS 握手/Runtime.enable/每条 CDP 请求）、close/error 清理 pending、
 *   exitWithGuard 识别已退出 child、finally 复用 v2 进程查询协议核对收拢、停机核对统一排除
 *   宿主强杀与 daemon forced；
 * - D1 同步点=真正 listen 之前（entry.ts）；D2=daemon 侧响应延迟（命令已处理、响应未返回）+
 *   按实发 commandId 核对回执；D3=受控退出延迟（ZS_UI_SHUTDOWN_DELAY_MS）+新旧实例共存证明；
 * - HARNESS 会话=零真实调用专项自检（fake runtime+派发硬隔离），先证明助手与同步点有效，
 *   再跑完整序列。
 */
/* global fetch, WebSocket -- node>=21 原生（eslint 环境未声明） */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repo = resolve(import.meta.dirname, '..');

// ---------- 冻结产物入口（第二十二轮一）：只构建一次，后续核对复用 ----------
function verifyFrozenDir(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST-SHA256.json'), 'utf8'));
  const bad = [];
  for (const f of manifest.files) {
    const p = join(dir, f.path);
    try {
      const h = createHash('sha256').update(readFileSync(p)).digest('hex');
      if (h !== f.sha256) bad.push(`${f.path}: hash 不一致`);
    } catch { bad.push(`${f.path}: 缺失/不可读`); }
  }
  return { buildId: manifest.buildId, fileCount: manifest.files.length, bad };
}

const FROZEN = process.env.ZS_VDR_FROZEN === '1';
const frozenDir = join(repo, 'dist', 'desktop', 'vdr-frozen');
let staging;
let frozenInfo = { enabled: false };
if (FROZEN && existsSync(join(frozenDir, 'MANIFEST-SHA256.json'))) {
  const v = verifyFrozenDir(frozenDir);
  if (v.bad.length > 0) {
    console.error(`[vdr] 冻结产物核对失败（验收期间被重建/覆盖？）：\n  ${v.bad.slice(0, 5).join('\n  ')}`);
    process.exit(2);
  }
  staging = frozenDir;
  frozenInfo = { enabled: true, mode: 'reused', buildId: v.buildId, fileCount: v.fileCount };
  console.log(`[vdr] 冻结产物复用：buildId=${v.buildId} 文件=${v.fileCount}（SHA256 核对通过）`);
} else {
  for (const script of ['build-ui.mjs', 'pack-daemon.mjs', 'pack-desktop.mjs']) {
    const r = spawnSync(process.execPath, [join(repo, 'scripts', script)], { cwd: repo, encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) { console.error(`前置构建失败（${script}）`); process.exit(1); }
  }
  staging = join(repo, 'dist', 'desktop', '众说-便携-win-x64');
  if (FROZEN) {
    rmSync(frozenDir, { recursive: true, force: true });
    cpSync(staging, frozenDir, { recursive: true, dereference: true });
    const v = verifyFrozenDir(frozenDir);
    if (v.bad.length > 0) { console.error(`[vdr] 冻结副本核对失败：\n  ${v.bad.slice(0, 5).join('\n  ')}`); process.exit(2); }
    frozenInfo = { enabled: true, mode: 'created', buildId: v.buildId, fileCount: v.fileCount };
    console.log(`[vdr] 产物已冻结：${frozenDir} buildId=${v.buildId}（后续 ZS_VDR_FROZEN=1 运行核对复用）`);
  }
}
let stagingBuildId = frozenInfo.buildId ?? null;
if (stagingBuildId == null) {
  try { stagingBuildId = JSON.parse(readFileSync(join(staging, 'BUILD.json'), 'utf8')).buildId ?? null; } catch { /* 如实 null */ }
}

const installRoot = mkdtempSync(join(tmpdir(), '桌面 验收-'));
const appHome = join(installRoot, '众说 桌面版');
cpSync(staging, appHome, { recursive: true, dereference: true });
const appData = join(installRoot, '应用 数据', '唯一实例');
const fixtureProj = join(installRoot, '演示 项目');
mkdirSync(fixtureProj, { recursive: true });
writeFileSync(join(fixtureProj, 'notes.md'), '# 演示\n\n暗号：R15-RENDERER-7749\n', 'utf8');

// ---------- 运行留档（第二十二轮一）：独立 runId 目录，历史不覆盖 ----------
const runId = `v${new Date().toISOString().replace(/[:T.-]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
const runDir = join(repo, 'dist', 'desktop', 'vdr-runs', runId);
mkdirSync(join(runDir, 'sessions'), { recursive: true });
const sessionFacts = {}; // 每会话：pid/port/pipe/appData/startedAt/endedAt/stderr 阶段时间线
let currentStep = 'init'; // 异常现场归属步骤
let currentRun = null; // { tag, child, page } 供失败时保存现场

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `：${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程残留查询（v2 统一协议，第十八轮一）：双形态匹配+排除验证器自身/父壳/查询辅助。 */
const psQuery = join(installRoot, 'proc-query.ps1');
const PROC_QUERY_PS = `$ErrorActionPreference = "Stop"
$Pattern = $env:ZS_PROC_PATTERN
$Alt = $env:ZS_PROC_PATTERN_ALT
$Exclude = @($env:ZS_PROC_EXCLUDE -split ',' | Where-Object { $_ -ne '' })
try {
  $p = Get-CimInstance Win32_Process -Filter "CommandLine != NULL" | Where-Object { (($_.CommandLine -like $Pattern) -or ($Alt -ne "" -and $_.CommandLine -like $Alt)) -and $_.ProcessId -ne $PID -and $Exclude -notcontains [string]$_.ProcessId }
  $p | ForEach-Object { "$($_.ProcessId)" + [char]9 + "$($_.Name)" }
  "QUERY-OK"
} catch { "ERR" + [char]9 + $_.Exception.Message }
`;
writeFileSync(psQuery, PROC_QUERY_PS, 'utf8');
function listInstallProcesses() {
  const pattern = `*${installRoot}*`;
  const alt = pattern.replaceAll('\\', '/');
  const exclude = [process.pid, process.ppid].filter((x) => x != null).join(',');
  const ask = () => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psQuery], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ZS_PROC_PATTERN: pattern, ZS_PROC_PATTERN_ALT: alt !== pattern ? alt : '', ZS_PROC_EXCLUDE: exclude } });
  let r = ask();
  if (r.error != null || r.status !== 0) r = ask();
  const out = (r.stdout ?? '').trim();
  if (r.status !== 0 || r.error != null || !out.includes('QUERY-OK') || out.includes('ERR\t')) {
    return { ok: false, raw: out.slice(0, 120) || r.stderr?.slice(0, 120) || 'empty' };
  }
  const rows = out.split('\n').map((l) => l.trim()).filter((l) => /^\d+\t/.test(l)).map((l) => { const [pid, name] = l.split('\t'); return { pid: Number(pid), name: name ?? '?' }; });
  return { ok: true, rows };
}
function leftoverCount() {
  const q = listInstallProcesses();
  return q.ok ? q.rows.length : `ERR:${q.raw}`;
}
/** 进程存活核对（D3 共存证明）：按 PID+安装路径命令行双核对，不复用他进程 PID。 */
function pidAliveInInstall(pid) {
  const q = listInstallProcesses();
  return q.ok ? q.rows.some((r) => r.pid === pid) : `ERR:${q.raw}`;
}

/** 启动产物（独立管道按会话唯一——C 间歇根因修复）并等待页面就绪；stderr 带接收时间戳落盘。 */
async function launchApp(tag, port, extraEnv, appDataDirOverride) {
  // 管道名必须是完整 \\.\pipe\ 路径（与 daemonPipeNameFor 同形态）：daemon listen 会给裸名
  // 自动补前缀，而客户端 connect 不会——裸名=UI 永远连不上（H-D1 实测教训）。
  const pipeName = `\\\\.\\pipe\\zs-vdr-${tag}`;
  const child = spawn(join(appHome, 'electron.exe'), [`--remote-debugging-port=${port}`], {
    cwd: installRoot,
    env: {
      ...process.env,
      ZS_APP_DATA: appDataDirOverride ?? appData,
      ZS_RUNTIME: 'fake',
      ZS_ALLOW_FAKE: '1',
      ZS_REAL_DISPATCH_GUARD: '1', // 验收环境硬隔离——真实 runtime 派发在 spawn 前拒绝
      ZS_PICK_FOLDER: fixtureProj,
      ZS_PIPE_NAME: pipeName, // 会话级独立管道：前实例未退净也不连错实例
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderrLog = join(runDir, 'sessions', `${tag}-stderr.log`);
  const lines = []; // { line, at } 带时间戳（时间线证据：阶段先后与点击/完成因果）
  child.stderr.setEncoding('utf8');
  child.stdout.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    for (const l of String(c).split('\n')) {
      if (l.length === 0) continue;
      const at = Date.now();
      lines.push({ line: l, at });
      appendFileSync(stderrLog, `[${new Date(at).toISOString()}] ${l}\n`, 'utf8');
    }
  });
  child.stdout.on('data', () => {});
  const startedAt = Date.now();
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json()).catch(() => null);
      if (Array.isArray(list) && list.some((t) => String(t.url).includes('index.html'))) {
        sessionFacts[tag] = { pid: child.pid, port, pipe: pipeName, appData: appDataDirOverride ?? appData, startedAt, stderrFile: stderrLog };
        return { child, tag, lines: () => lines, stderrText: () => lines.map((x) => x.line).join('\n'), pipe: pipeName };
      }
    } catch { /* 尚未就绪 */ }
    await sleep(300);
  }
  sessionFacts[tag] = { pid: child.pid, port, pipe: pipeName, appData: appDataDirOverride ?? appData, startedAt, stderrFile: stderrLog, noPage: true };
  return { child, tag, lines: () => lines, stderrText: () => lines.map((x) => x.line).join('\n'), pipe: pipeName, noPage: true };
}

/** 极简 CDP 客户端：全截止（fetch/WS 握手/每条请求）；close/error 清理 pending 与 timer。 */
async function connectPage(port, evalDeadlineMs = 20_000) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json());
  const target = list.find((t) => String(t.url).includes('index.html'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map(); // id → { resolve, timer }
  const pageErrors = [];
  let wsClosed = false;
  const failAllPending = (why) => {
    wsClosed = true;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(why)); }
    pending.clear();
  };
  await Promise.race([
    new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', (e) => rej(new Error(`CDP WS 握手失败：${String(e.type)}`))); }),
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('CDP WS 握手截止（10s）')), 10_000); t.unref?.(); }),
  ]);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer); p.resolve(msg); return; }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') pageErrors.push(String(msg.params.args?.[0]?.value ?? '').slice(0, 200));
  });
  ws.addEventListener('close', () => failAllPending('CDP WS 已关闭——在途请求全部收束'));
  ws.addEventListener('error', () => failAllPending('CDP WS 错误——在途请求全部收束'));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (wsClosed) { reject(new Error('CDP WS 已关闭——请求未发出')); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 请求截止（${method}）`)); }, evalDeadlineMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.error != null) return { error: r.error.message };
    const v = r.result?.result;
    if (v?.subtype === 'error') return { error: v.description?.slice(0, 200) ?? String(v.value) };
    return { value: v?.value };
  };
  const waitInteractive = async (timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await evalJs('window.__zsReady === true');
      if (r.value === true) return true;
      if (Date.now() > deadline) throw new Error('页面可操作等待超时（__zsReady——onclick 绑定完成的标志）');
      await sleep(150);
    }
  };
  return {
    evalJs, waitInteractive, pageErrors: () => pageErrors,
    screenshot: async (outPath) => {
      try {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        if (r.result?.data != null) { writeFileSync(outPath, Buffer.from(r.result.data, 'base64')); return true; }
      } catch { /* 尽力——截图失败不掩盖原始失败 */ }
      return false;
    },
    close: () => { failAllPending('验证器主动关闭'); ws.close(); },
  };
}

/** 退出等待：CloseMainWindow 后 60s 硬限；已退出的 child 立即返回事实（不等一个不会再来的事件）；
 * taskkill 兜底后再宽限 10s，仍无事件=EXIT-UNCONFIRMED（失败语义，不冒充退出）。 */
async function exitWithGuard(child, gracefulMs = 60_000) {
  if (child.exitCode != null || child.signalCode != null) {
    return { code: child.exitCode, signal: child.signalCode, alreadyExited: true };
  }
  const outcome = await new Promise((res) => {
    let done = false;
    const settle = (r) => { if (!done) { done = true; clearTimeout(t); res(r); } };
    child.once('exit', (c, s) => settle({ code: c, signal: s }));
    spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${child.pid}).CloseMainWindow()`], { timeout: 15_000 });
    const t = setTimeout(() => {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* 尽力 */ }
      setTimeout(() => settle({ code: null, signal: 'EXIT-UNCONFIRMED' }), 10_000).unref?.();
    }, gracefulMs);
    t.unref?.();
  });
  await new Promise((r) => setTimeout(r, 800));
  return outcome;
}

/** 停机核对统一口径（第二十二轮二）：宿主强杀（KILLED/EXIT-UNCONFIRMED 信号）与 daemon 自身
 * forced/超时一律不算优雅——不能只凭 exit0+complete 判通过。 */
function gracefulShutdownOk(exit, facts) {
  return {
    ok: exit.code === 0 && exit.signal == null && exit.alreadyExited !== undefined
      ? exit.code === 0 && exit.signal == null && (facts?.daemonStopResult?.complete === true)
      : exit.code === 0 && exit.signal == null
        && facts?.requestDelivered === true && facts?.exitCode === 0
        && facts?.forceKilled === false && facts?.timedOut === false
        && facts?.daemonStopResult?.complete === true && facts?.daemonStopResult?.forced !== true,
    detail: `exit=${exit.code}${exit.signal != null ? ` signal=${exit.signal}` : ''} del=${facts?.requestDelivered} forced=${facts?.forceKilled ?? facts?.daemonStopResult?.forced} timedOut=${facts?.timedOut} stop=${facts?.daemonStopResult?.complete} phase=${facts?.daemonStopResult?.phase}`,
  };
}

/** 回执核对（D2）：按明确 commandId 直查 command_receipts（主键=scope+command_id），不按
 * result_json 形状猜方法。返回 { ok, data } 或错误串。 */
import { createRequire } from 'node:module';
function receiptByCommandId(dbFile, commandId) {
  try {
    const req = createRequire(join(repo, 'package.json'));
    const Database = req('better-sqlite3');
    const db = new Database(dbFile, { readonly: true });
    const row = db.prepare('SELECT command_id, result_json FROM command_receipts WHERE command_id = ?').get(commandId);
    db.close();
    if (row == null) return { ok: false, reason: '无回执' };
    try {
      const data = JSON.parse(row.result_json ?? 'null');
      return { ok: true, data };
    } catch { return { ok: false, reason: 'result_json 非法 JSON' }; }
  } catch (error) {
    return { ok: false, reason: `ERR:${String(error instanceof Error ? error.message : error).slice(0, 60)}` };
  }
}

const waitFor = async (fn, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`等待步骤截止：${what}`)), 20_000); t.unref?.(); }),
    ]);
    if (r === true) return true;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(400);
  }
};

// 会话选择：ZS_VDR_SESSIONS=A,B1,B2,C,D,HARNESS（缺省 A,B1,B2,C,D）。
const SESSIONS = (process.env.ZS_VDR_SESSIONS ?? 'A,B1,B2,C,D').split(',').map((x) => x.trim()).filter(Boolean);
const shouldRun = (name) => SESSIONS.includes(name);

/** 失败现场保存（第二十二轮一）：先留证据再清理——页面截图+页面错误+stderr 全文+进程清单。 */
async function saveFailureScene(error) {
  const dir = join(runDir, 'failure');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'error.txt'), `${currentStep}\n${error instanceof Error ? error.stack : String(error)}\n`, 'utf8');
  try {
    if (currentRun?.page != null) {
      await currentRun.page.screenshot(join(dir, `${currentRun.tag ?? 'page'}.png`));
      writeFileSync(join(dir, `${currentRun.tag ?? 'page'}-errors.txt`), currentRun.page.pageErrors().join('\n'), 'utf8');
    }
  } catch { /* 尽力 */ }
  try {
    if (currentRun?.stderrText != null) writeFileSync(join(dir, `${currentRun.tag ?? 'app'}-stderr-full.txt`), currentRun.stderrText(), 'utf8');
  } catch { /* 尽力 */ }
  try {
    const q = listInstallProcesses();
    writeFileSync(join(dir, 'processes.txt'), JSON.stringify(q, null, 2), 'utf8');
  } catch { /* 尽力 */ }
}

let failed = false;
let exitCFacts = null; // C 写/D 读（受控退出延迟的事实载体）
let cChildPid = null; // C 的 electron PID（D3 共存证明）
try {
  // ---------- 控制组：decoy 进程先证检测有效 ----------
  if (shouldRun('A') || shouldRun('B1') || shouldRun('B2') || shouldRun('C') || shouldRun('D')) {
    const decoy = spawn(join(appHome, 'resources', 'app', 'daemon', 'node', 'node.exe'), ['-e', `setInterval(()=>{},1000) /* ${installRoot.replaceAll('\\', '/')} decoy */`], { stdio: 'ignore' });
    await sleep(1200);
    const seen = leftoverCount();
    record('控制组：安装路径 decoy 进程被检出（检测有效性——匹配不到≠无残留）', seen === 1 || (typeof seen === 'number' && seen >= 1), `count=${JSON.stringify(seen)}`);
    spawnSync('taskkill', ['/PID', String(decoy.pid), '/T', '/F']);
    await sleep(1500);
    const after = leftoverCount();
    record('控制组：decoy 结束后归零', after === 0, `count=${JSON.stringify(after)}`);
  }

  // ---------- HARNESS：零真实调用专项自检（先证明助手与同步点有效，再跑完整序列） ----------
  if (shouldRun('HARNESS')) {
    // H1：fetch 截止与拒绝路径——不存在的端口立即失败（非悬挂）。
    {
      const t0 = Date.now();
      let fetchErr = null;
      try { await fetch('http://127.0.0.1:59999/json/list', { signal: AbortSignal.timeout(2_000) }).then((r) => r.json()); } catch (e) { fetchErr = e; }
      const elapsed = Date.now() - t0;
      record('HARNESS·fetch 拒绝路径有截止（连不上的端口≤2s 失败，不悬挂）', fetchErr != null && elapsed < 4_000, `err=${String(fetchErr?.message ?? fetchErr).slice(0, 40)} elapsed=${elapsed}ms`);
    }
    // H2：WS 握手失败立即结束（不开 WS 的端口）。
    {
      const t0 = Date.now();
      let wsErr = null;
      try {
        const ws = new WebSocket('ws://127.0.0.1:59999/devtools/page/none');
        await Promise.race([
          new Promise((_, rej) => { ws.addEventListener('error', () => rej(new Error('ws error'))); }),
          new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('ws open 截止')), 5_000); t.unref?.(); }),
        ]);
      } catch (e) { wsErr = e; }
      const elapsed = Date.now() - t0;
      record('HARNESS·WS 握手失败有截止（错误/截止路径结束，不悬挂）', wsErr != null && elapsed < 6_000, `err=${String(wsErr?.message ?? wsErr).slice(0, 40)} elapsed=${elapsed}ms`);
    }
    // H3：evalJs 单步截止——页面主线程死循环脚本在 CDP 请求截止内被拒绝（页面挂死不拖垮验证器）。
    {
      currentStep = 'HARNESS·H3';
      const app = await launchApp('h-h3', 9345, {}, join(installRoot, '应用 数据', 'H-H3'));
      if (app.noPage) throw new Error('HARNESS H3：页面未就绪');
      const page = await connectPage(9345, 4_000); // 单步截止 4s
      currentRun = { tag: 'h-h3', child: app.child, page, stderrText: app.stderrText };
      const t0 = Date.now();
      let evalErr = null;
      try { await page.evalJs('while (true) {}'); } catch (e) { evalErr = e; }
      const elapsed = Date.now() - t0;
      record('HARNESS·evalJs 死循环在单步截止内拒绝（挂死页面不悬挂验证器）', evalErr != null && elapsed < 15_000, `err=${String(evalErr?.message ?? evalErr).slice(0, 50)} elapsed=${elapsed}ms`);
      await page.close();
      currentRun = null;
      // 页面主线程仍卡在死循环——CloseMainWindow 不会响应：短等 6s+taskkill 兜底（强杀属预期）。
      const exitH3 = await exitWithGuard(app.child, 6_000);
      record('HARNESS·H3 挂死页面收尾（短等+taskkill 兜底——EXIT 事实如实，不断言优雅）', exitH3.code != null || exitH3.signal != null, `exit=${JSON.stringify(exitH3)}`);
      await sleep(800);
    }
    // H4：exitWithGuard 已退出 child——立即返回事实不悬挂。
    {
      const quick = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
      await new Promise((res) => { if (quick.exitCode != null) res(); else quick.once('exit', res); });
      const t0 = Date.now();
      const outcome = await exitWithGuard(quick);
      const elapsed = Date.now() - t0;
      record('HARNESS·exitWithGuard 识别已退出 child（立即返回事实 code=7，不悬挂）', outcome.code === 7 && outcome.alreadyExited === true && elapsed < 3_000, `code=${outcome.code} elapsed=${elapsed}ms`);
    }
    // H5：D1 同步点（真正 listen 之前）——daemon 延迟 5s：点击发生在 listening 之前、
    // 完成在 listening 之后（时间线因果），页面全程可操作。
    {
      currentStep = 'HARNESS·D1';
      const app = await launchApp('h-d1', 9341, { ZS_DAEMON_LISTEN_DELAY_MS: '5000' }, join(installRoot, '应用 数据', 'H-D1'));
      if (app.noPage) throw new Error('HARNESS D1：页面未就绪');
      const page = await connectPage(9341, 5_000);
  await page.waitInteractive();
      currentRun = { tag: 'h-d1', child: app.child, page, stderrText: app.stderrText };
      const clickAt = Date.now();
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 60_000, 'H-D1 项目打开（daemon 未就绪窗口内有界等待）');
      const doneAt = Date.now();
      const lines = app.lines();
      const delayLine = lines.find((x) => x.line.includes('listen 受控延迟'));
      const listenLine = lines.find((x) => x.line.includes('] listening '));
      const authLine = lines.find((x) => x.line.includes('ready: auth.ok'));
      const delayBeforeListen = delayLine != null && listenLine != null && delayLine.at < listenLine.at;
      const clickBeforeListen = listenLine != null && clickAt < listenLine.at;
      const authAfterListen = authLine != null && listenLine != null && listenLine.at <= authLine.at;
      const connErr = await page.evalJs(`document.getElementById('conn-state').classList.contains('err')`);
      record('HARNESS·D1 时间线因果（点击<listening<auth.ok<完成；延迟行先于 listening；页面无错误残留）',
        delayBeforeListen && clickBeforeListen && authAfterListen && doneAt - clickAt > 5000 && connErr.value !== true,
        `click→listen=${listenLine != null ? listenLine.at - clickAt : '?'}ms 总=${doneAt - clickAt}ms`);
      await page.close();
      const exitH = await exitWithGuard(app.child);
      const factsH = JSON.parse(readFileSync(join(installRoot, '应用 数据', 'H-D1', 'desktop-shutdown.json'), 'utf8'));
      const g = gracefulShutdownOk(exitH, factsH);
      record('HARNESS·D1 停机事实（统一口径：非 forced+complete）', g.ok, g.detail);
      currentRun = null;
      await sleep(800);
    }
    // H6：D2 同步点（daemon 侧响应延迟=命令已处理、响应未返回）——response-delay 日志在
    // 点击与完成之间；实发 commandId 恰一次、回执恰一条成功。
    {
      currentStep = 'HARNESS·D2';
      const app = await launchApp('h-d2', 9342, { ZS_DAEMON_RESPONSE_DELAY_METHOD_MS: 'project.open:2500', ZS_DAEMON_LOG_COMMANDS: '1' }, join(installRoot, '应用 数据', 'H-D2'));
      if (app.noPage) throw new Error('HARNESS D2：页面未就绪');
      const page = await connectPage(9342, 5_000);
  await page.waitInteractive();
      currentRun = { tag: 'h-d2', child: app.child, page, stderrText: app.stderrText };
      const clickAt = Date.now();
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 60_000, 'H-D2 项目打开（响应延迟窗口后）');
      const doneAt = Date.now();
      // 实发 commandId 从 daemon 命令日志取（contextBridge 只读——页面 patch 不可行）。
      const sentIds = app.lines().filter((x) => x.line.includes('] command project.open ')).map((x) => (/ id=(\S+)/.exec(x.line)?.[1] ?? '').trim()).filter(Boolean);
      const lines = app.lines();
      const respDelay = lines.find((x) => x.line.includes('response-delay project.open'));
      const delayInWindow = respDelay != null && respDelay.at > clickAt && respDelay.at < doneAt;
      const receipt = sentIds.length === 1 ? receiptByCommandId(join(installRoot, '应用 数据', 'H-D2', 'state.sqlite'), sentIds[0]) : { ok: false, reason: `daemon 实收 project.open=${sentIds.length} 次` };
      record('HARNESS·D2 响应延迟窗口（response-delay 日志∈(点击,完成)；实发恰 1；按 commandId 回执恰 1 成功）',
        sentIds.length === 1 && delayInWindow && doneAt - clickAt > 2500 && receipt.ok === true && receipt.data?.project != null,
        `sent=${sentIds.length} delayInWindow=${delayInWindow} 总=${doneAt - clickAt}ms receipt=${receipt.ok ? 'ok(project)' : receipt.reason}`);
      await page.close();
      const exitH = await exitWithGuard(app.child);
      const factsH = JSON.parse(readFileSync(join(installRoot, '应用 数据', 'H-D2', 'desktop-shutdown.json'), 'utf8'));
      const g = gracefulShutdownOk(exitH, factsH);
      record('HARNESS·D2 停机事实（统一口径）', g.ok, g.detail);
      currentRun = null;
      await sleep(800);
    }
    // H7：D3 同步点（受控退出延迟）——旧实例窗口已关、进程仍在（≥4s）；新实例（独立管道）在
    // 共存窗口内正常启动工作；旧实例随后退出且停机事实完整非 forced。
    {
      currentStep = 'HARNESS·D3';
      const app1 = await launchApp('h-d3a', 9343, { ZS_UI_SHUTDOWN_DELAY_MS: '4000' }, join(installRoot, '应用 数据', 'H-D3A'));
      if (app1.noPage) throw new Error('HARNESS D3：旧实例页面未就绪');
      const page1 = await connectPage(9343, 5_000);
  await page1.waitInteractive();
      await page1.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page1.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 60_000, 'H-D3 旧实例项目打开');
      await page1.close();
      const closeAt = Date.now();
      const exit1Promise = exitWithGuard(app1.child); // CloseMainWindow 发出——开始受控延迟
      await sleep(500);
      // 新实例在旧实例延迟窗口内启动（独立管道=不连错实例）。
      const app2 = await launchApp('h-d3b', 9344, {}, join(installRoot, '应用 数据', 'H-D3B'));
      if (app2.noPage) throw new Error('HARNESS D3：新实例页面未就绪（共存窗口内）');
      const page2 = await connectPage(9344, 5_000);
  await page2.waitInteractive();
      currentRun = { tag: 'h-d3b', child: app2.child, page: page2, stderrText: app2.stderrText };
      const aliveDuring = pidAliveInInstall(app1.child.pid);
      await page2.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page2.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 60_000, 'H-D3 新实例项目打开（共存窗口内）');
      const exit1 = await exit1Promise;
      const facts1 = JSON.parse(readFileSync(join(installRoot, '应用 数据', 'H-D3A', 'desktop-shutdown.json'), 'utf8'));
      const g1 = gracefulShutdownOk(exit1, facts1);
      record('HARNESS·D3 共存窗口（旧实例关窗后进程存活≥4s；新实例同窗口正常工作；旧实例随后完整退出非 forced）',
        aliveDuring === true && Date.now() - closeAt > 4000 && g1.ok,
        `旧实例存活=${aliveDuring === true} 总=${Date.now() - closeAt}ms 停机=${g1.detail}`);
      await page2.close();
      const exit2 = await exitWithGuard(app2.child);
      const facts2 = JSON.parse(readFileSync(join(installRoot, '应用 数据', 'H-D3B', 'desktop-shutdown.json'), 'utf8'));
      const g2 = gracefulShutdownOk(exit2, facts2);
      record('HARNESS·D3 新实例停机事实（独立管道共存后正常退出）', g2.ok, g2.detail);
      currentRun = null;
      await sleep(800);
      record('HARNESS·无残留（自检会话全部收拢）', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
    }
  }

  // ---------- 会话 A：正常链+设置+REVIEW→返工→新版本+优雅停机事实 ----------
  if (shouldRun('A')) {
    currentStep = 'A';
    const app = await launchApp('a', 9331, {}, );
    if (app.noPage) throw new Error('会话 A：页面未就绪');
    const page = await connectPage(9331);
  await page.waitInteractive();
    currentRun = { tag: 'a', child: app.child, page, stderrText: app.stderrText };
    const pre = await page.evalJs('typeof window.zs');
    record('renderer+preload 加载（window.zs 命令面存在）', pre.value === 'object', `zs=${JSON.stringify(pre.value)}`);
    await page.evalJs(`document.getElementById('open-folder').click()`);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, '项目打开');
    record('页面操作打开项目（open-folder→preload pickFolder→project.open）', true);
    await page.evalJs(`document.getElementById('task-review-toggle').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('task-review-toggle').textContent.includes('开')`)).value === true, 10_000, '验收开关');
    await page.evalJs(`(() => { document.getElementById('composer-input').value = '请读取 notes.md 报出暗号'; document.getElementById('send').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length > 0`)).value === true, 20_000, '主池出现任务卡片');
    await page.evalJs(`(() => { document.querySelector('#pool .pool-card').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('review-reject-btn').classList.contains('hidden') === false`)).value === true, 90_000, 'REVIEW 待验收（验收按钮出现）');
    const reply = await page.evalJs(`document.getElementById('thread-messages').textContent`);
    record('正常发送闭环（按钮提交→worker→线程回复→待验收）', String(reply.value ?? '').length > 0 && !String(reply.value ?? '').includes('错误'), `回复长度=${String(reply.value ?? '').length}`);
    await page.evalJs(`document.getElementById('review-reject-btn').click()`);
    await page.evalJs(`(() => { document.getElementById('rework-note-input').value = '请补充风险一节'; document.getElementById('rework-note-confirm').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('redispatch-btn').classList.contains('hidden') === false`)).value === true, 30_000, '返工后追加执行可用（ACTIVE+无在途）');
    await page.evalJs(`document.getElementById('redispatch-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('review-accept-btn').classList.contains('hidden') === false && document.getElementById('review-reject-btn').classList.contains('hidden') === false`)).value === true, 120_000, '返工后新版本待验收（验收按钮复现）');
    await page.evalJs(`document.getElementById('review-accept-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('thread-status').textContent.includes('验收已记录')`)).value === true, 60_000, '验收通过后 验收已记录');
    record('REVIEW 闭环（要求修改→返工注入→新版本(revision≥2)→验收通过→DONE）', true);
    await page.evalJs(`document.getElementById('project-settings').open = true`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('未绑定')`)).value === true, 20_000, '成员绑定区渲染');
    await page.evalJs(`[...document.querySelectorAll('#member-runtime-list button.chip')].find((b) => b.textContent === '绑定…').click()`);
    await page.evalJs(`(() => { const sel = document.querySelector('.member-runtime-edit select'); sel.value = 'claude'; sel.dispatchEvent(new Event('change')); document.querySelector('.member-runtime-edit input').value = ''; })()`);
    await page.evalJs(`[...document.querySelectorAll('.member-runtime-edit button.chip')].find((b) => b.textContent === '保存').click()`);
    await sleep(600);
    const negErr = await page.evalJs(`document.querySelector('.member-runtime-edit span.meta')?.textContent ?? ''`);
    record('成员绑定校验失败提示（claude 空模型——客户端预检+服务端校验同口径）', String(negErr.value).includes('校验失败'), `msg=${String(negErr.value).slice(0, 50)}`);
    await page.evalJs(`document.querySelector('.member-runtime-edit input').value = 'deepseek-flash'`);
    await page.evalJs(`[...document.querySelectorAll('.member-runtime-edit button.chip')].find((b) => b.textContent === '保存').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('claude · deepseek-flash')`)).value === true, 20_000, '绑定保存回显');
    record('成员 runtime 绑定保存+回显（member.setRuntime→member.runtime 重读；含能力分列）', true);

    const errs = page.pageErrors();
    record('renderer 无未捕获异常/console 错误（会话 A 全程）', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 160));
    page.close();
    currentRun = null;
    const exitA = await exitWithGuard(app.child);
    const facts = JSON.parse(readFileSync(join(appData, 'desktop-shutdown.json'), 'utf8'));
    const g = gracefulShutdownOk(exitA, facts);
    record('优雅停机事实（desktop-shutdown.json：送达+退出 0+complete+非 forced+未超时）', g.ok, g.detail);
    await sleep(1000);
    record('会话 A 无残留', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
  }

  // ---------- 会话 B1：同 appData 顺序重开（设置保持——不发送任务） ----------
  if (shouldRun('B1')) {
    currentStep = 'B1';
    const app = await launchApp('b1', 9332, {}, );
    if (app.noPage) throw new Error('会话 B1：页面未就绪');
    const page = await connectPage(9332);
  await page.waitInteractive();
    currentRun = { tag: 'b1', child: app.child, page, stderrText: app.stderrText };
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, '重开自动恢复项目');
    await page.evalJs(`document.getElementById('project-settings').open = true`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('member-runtime-list').textContent.includes('claude · deepseek-flash')`)).value === true, 20_000, '绑定保持');
    const reviewKept = await page.evalJs(`document.getElementById('task-review-toggle').textContent`);
    record('同 appData 顺序重开：绑定与验收开关保持（设置持久化；锁随首启干净退出释放）', String(reviewKept.value).includes('开'), `开关=${String(reviewKept.value).slice(0, 12)} 绑定=保持`);
    page.close();
    currentRun = null;
    const exitB = await exitWithGuard(app.child);
    const factsB = JSON.parse(readFileSync(join(appData, 'desktop-shutdown.json'), 'utf8'));
    const g = gracefulShutdownOk(exitB, factsB);
    record('重开停机事实（同 appData 第二次优雅关闭：退出 0+complete+非 forced）', g.ok, g.detail);
    await sleep(1000);
  }

  // ---------- 会话 B2：独立 appData 停止闭环 ----------
  if (shouldRun('B2')) {
    currentStep = 'B2';
    const appDataStop = join(installRoot, '应用 数据', '停止场景');
    const app = await launchApp('b2', 9333, { ZS_FAKE_STALL_MS: '15000' }, appDataStop);
    if (app.noPage) throw new Error('会话 B2：页面未就绪');
    const page = await connectPage(9333);
  await page.waitInteractive();
    currentRun = { tag: 'b2', child: app.child, page, stderrText: app.stderrText };
    await page.evalJs(`document.getElementById('open-folder').click()`);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, 'B2 项目打开');
    await page.evalJs(`(() => { document.getElementById('composer-input').value = '长驻任务（将被停止）'; document.getElementById('send').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length > 0`)).value === true, 20_000, '主池出现任务卡片');
    await page.evalJs(`(() => { document.querySelector('#pool .pool-card').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('stop-btn').classList.contains('hidden') === false`)).value === true, 20_000, '停止按钮出现（任务在途）');
    await page.evalJs(`document.getElementById('stop-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('thread-messages').textContent.includes('已停止') || document.getElementById('thread-status').textContent.includes('已停止')`)).value === true, 60_000, '任务 CANCELLED');
    record('停止闭环（在途→stop-btn→CANCELLED）', true);
    page.close();
    currentRun = null;
    const exitB2 = await exitWithGuard(app.child);
    const factsB2 = JSON.parse(readFileSync(join(appDataStop, 'desktop-shutdown.json'), 'utf8'));
    const g = gracefulShutdownOk(exitB2, factsB2);
    record('停止场景停机事实（受管 job 随优雅关闭收拢：退出 0+complete+非 forced）', g.ok, g.detail);
    await sleep(1000);
    record('会话 B2 无残留（含 stop 场景进程收拢）', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
  }

  // ---------- 会话 C：私信全链（带受控退出延迟——D3 的真同步点） ----------
  if (shouldRun('C')) {
    currentStep = 'C';
    const appDataDm = join(installRoot, '应用 数据', '私信场景');
    const app = await launchApp('c', 9334, { ZS_FAKE_STALL_MS: '12000', ZS_UI_SHUTDOWN_DELAY_MS: '8000' }, appDataDm);
    if (app.noPage) throw new Error('会话 C：页面未就绪');
    const page = await connectPage(9334);
  await page.waitInteractive();
    currentRun = { tag: 'c', child: app.child, page, stderrText: app.stderrText };
    await page.evalJs(`document.getElementById('open-folder').click()`);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 90_000, 'C 项目打开');
    await page.evalJs(`document.getElementById('task-review-toggle').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('task-review-toggle').textContent.includes('开')`)).value === true, 10_000, 'C 验收开关');
    await page.evalJs(`document.getElementById('dm-create').click()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, '成员选择器出现');
    await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
    await waitFor(async () => (await page.evalJs(`!document.getElementById('dm').classList.contains('hidden')`)).value === true, 10_000, '私信视图打开');
    const hashA = await page.evalJs('location.hash');
    record('DM 新建+打开（DOM 选择器→独立会话；深链 hash 落址）', String(hashA.value ?? '').startsWith('#dm=dm_'), `hash=${hashA.value}`);
    await page.evalJs(`(() => { document.getElementById('dm-input').value = '私信第一条（长任务）'; document.getElementById('dm-send').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-state').textContent.includes('运行中')`)).value === true, 20_000, 'DM 运行中状态');
    await page.evalJs(`(() => { document.getElementById('dm-input').value = '私信第二条（排队）'; document.getElementById('dm-send').click(); })()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-state').textContent.includes('排队')`)).value === true, 20_000, 'DM 排队状态');
    await page.evalJs(`document.getElementById('dm-stop-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-state').textContent.includes('暂停')`)).value === true, 60_000, 'DM 停止后队列暂停');
    await page.evalJs(`document.getElementById('dm-resume-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-review-row').classList.contains('hidden') === false`)).value === true, 120_000, 'DM 待验收（第二排队消息完成后）');
    await page.evalJs(`document.getElementById('dm-review-accept').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-review-row').classList.contains('hidden')`)).value === true, 60_000, 'DM 验收通过后行收起');
    record('DM 串行+停止继续+版本验收（排队→暂停→resume→REVIEW→accept 绑定版本）', true);
    await page.evalJs(`document.getElementById('dm-archive-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-input').disabled === true && document.getElementById('dm-state').textContent.includes('已归档')`)).value === true, 20_000, 'DM 归档只读');
    await page.evalJs(`document.getElementById('dm-restore-btn').click()`);
    await waitFor(async () => (await page.evalJs(`document.getElementById('dm-input').disabled === false`)).value === true, 20_000, 'DM 取消归档恢复可发');
    record('DM 归档/恢复（只读→恢复不自动续跑）', true);
    await page.evalJs(`document.getElementById('dm-create').click()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, '成员选择器再现');
    await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
    await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-list button').length >= 2`)).value === true, 20_000, '侧栏两会话');
    await page.evalJs(`(() => { document.getElementById('dm-input').value = 'B 会话消息'; document.getElementById('dm-send').click(); })()`);
    let replyB = '';
    for (let i = 0; i < 60; i += 1) {
      const t = await page.evalJs(`document.getElementById('dm-messages').textContent`);
      replyB = String(t.value ?? '');
      if (replyB.includes('分析完成')) break;
      await sleep(500);
    }
    record('DM 同成员双会话（新建分离：侧栏两条；B 会话独立收发）', replyB.includes('分析完成'), `B 回复=${replyB.slice(0, 40)}`);
    const errsC = page.pageErrors();
    record('renderer 无未捕获异常（会话 C 全程）', errsC.length === 0, errsC.slice(0, 2).join(' | ').slice(0, 160));
    page.close();
    currentRun = null;
    // 受控退出延迟（第二十二轮二）：CloseMainWindow 后 ZS_UI_SHUTDOWN_DELAY_MS=8s——进程仍在，
    // D 在共存窗口内启动（独立管道）；C 停机事实延后核对（同一运行进程树，不误杀他人）。
    const closeAt = Date.now();
    const exitCPromise = exitWithGuard(app.child).then(async (exitC) => {
      exitCFacts = { exit: exitC, closedAt: closeAt, exitedAt: Date.now() };
      try {
        exitCFacts.facts = JSON.parse(readFileSync(join(appDataDm, 'desktop-shutdown.json'), 'utf8'));
      } catch { /* 事实文件读取失败如实留空 */ }
      return exitC;
    });
    cChildPid = app.child.pid;
    await sleep(300);
    void exitCPromise;
    if (!shouldRun('D')) {
      const exitC = await exitCPromise;
      const g = gracefulShutdownOk(exitC, exitCFacts?.facts);
      record('私信场景停机事实（受控退出延迟后仍完整：退出 0+complete+非 forced）', g.ok, g.detail);
      await sleep(1000);
      record('会话 C 无残留', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
    }
  }

  // ---------- 会话 D：受控同步点（第二十二轮二：真实窗口覆盖） ----------
  if (shouldRun('D')) {
    // D1：daemon 真正 listen 之前延迟 8s + 页面出现立即点击——点击时管道不存在（UI 有界重试），
    // listening 后完成。时间线因果证明（点击<listening<完成），非固定 sleep。
    {
      currentStep = 'D1';
      const appDataD = join(installRoot, '应用 数据', '同步点D1');
      const t0 = Date.now();
      const app = await launchApp('d1', 9335, { ZS_DAEMON_LISTEN_DELAY_MS: '8000' }, appDataD);
      if (app.noPage) throw new Error('会话 D1：页面未就绪');
      // D3 证据（时机=页面刚出现）：C（受控退出延迟 8s 中）此刻必须仍存活——新旧实例真实
      // 共存。不能等 D1 项目打开后再查（8s 延迟已过=C 已退——首次冻结运行实测教训）。
      const cAliveAtD1Start = cChildPid != null ? pidAliveInInstall(cChildPid) : null;
      const page = await connectPage(9335);
  await page.waitInteractive();
      currentRun = { tag: 'd1', child: app.child, page, stderrText: app.stderrText };
      const clickAt = Date.now();
      await page.evalJs(`document.getElementById('open-folder').click()`); // 页面刚显示即点击
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 60_000, 'D1 daemon 未就绪窗口下项目最终打开');
      const doneAt = Date.now();
      const lines = app.lines();
      const delayLine = lines.find((x) => x.line.includes('listen 受控延迟'));
      const listenLine = lines.find((x) => x.line.includes('] listening '));
      const clickBeforeListen = listenLine != null && clickAt < listenLine.at;
      const delayBeforeListen = delayLine != null && listenLine != null && delayLine.at < listenLine.at;
      const connErr = await page.evalJs(`document.getElementById('conn-state').classList.contains('err')`);
      record('同步点·daemon 未就绪（真正 listen 前延 8s+立即点击）：点击先于 listening、完成>8s、无错误残留',
        connErr.value !== true && clickBeforeListen && delayBeforeListen && doneAt - t0 > 8000,
        `点击→listening=${listenLine != null ? listenLine.at - clickAt : '?'}ms 总=${doneAt - t0}ms connErr=${connErr.value}`);
      if (cChildPid != null) {
        record('同步点·上一实例退出延迟（C 关窗后 D 立即启动）：C 进程在 D1 页面出现时仍存活（受控共存窗口）', cAliveAtD1Start === true, `cPid=${cChildPid} aliveAtD1Start=${JSON.stringify(cAliveAtD1Start)}`);
      }
      page.close();
      currentRun = null;
      const exitD1 = await exitWithGuard(app.child);
      const factsD1 = JSON.parse(readFileSync(join(appDataD, 'desktop-shutdown.json'), 'utf8'));
      const g1 = gracefulShutdownOk(exitD1, factsD1);
      record('D1 停机事实（统一口径）', g1.ok, g1.detail);
      await sleep(800);
    }
    // D2：daemon 侧响应延迟 3s（命令已处理、响应未返回）——response-delay 日志时间戳∈(点击,完成)；
    // 实发 project.open 恰 1 次（daemon 命令日志）；按实发 commandId 核对回执恰 1 条成功。
    {
      currentStep = 'D2';
      const appDataD = join(installRoot, '应用 数据', '同步点D2');
      const app = await launchApp('d2', 9336, { ZS_DAEMON_RESPONSE_DELAY_METHOD_MS: 'project.open:3000', ZS_DAEMON_LOG_COMMANDS: '1' }, appDataD);
      if (app.noPage) throw new Error('会话 D2：页面未就绪');
      const page = await connectPage(9336);
  await page.waitInteractive();
      currentRun = { tag: 'd2', child: app.child, page, stderrText: app.stderrText };
      const clickAt = Date.now();
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 60_000, 'D2 响应延迟窗口下项目仍打开');
      const doneAt = Date.now();
      // 实发 commandId 从 daemon 命令日志取（contextBridge 只读——页面 patch 不可行）。
      const sentIds = app.lines().filter((x) => x.line.includes('] command project.open ')).map((x) => (/ id=(\S+)/.exec(x.line)?.[1] ?? '').trim()).filter(Boolean);
      const lines = app.lines();
      const respDelay = lines.find((x) => x.line.includes('response-delay project.open'));
      const delayInWindow = respDelay != null && respDelay.at > clickAt && respDelay.at < doneAt;
      const receipt = sentIds.length === 1 ? receiptByCommandId(join(appDataD, 'state.sqlite'), sentIds[0]) : { ok: false, reason: `daemon 实收 project.open=${sentIds.length} 次` };
      record('同步点·project.open 响应延迟（命令已处理响应延 3s 写回）：delay 日志∈(点击,完成)；实发恰 1；commandId 回执恰 1 成功',
        sentIds.length === 1 && delayInWindow && doneAt - clickAt > 3000 && receipt.ok === true && receipt.data?.project != null,
        `sent=${sentIds.length} delayInWindow=${delayInWindow} 总=${doneAt - clickAt}ms receipt=${receipt.ok ? 'ok(project)' : receipt.reason}`);
      page.close();
      currentRun = null;
      const exitD2 = await exitWithGuard(app.child);
      const factsD2 = JSON.parse(readFileSync(join(appDataD, 'desktop-shutdown.json'), 'utf8'));
      const g2 = gracefulShutdownOk(exitD2, factsD2);
      record('D2 停机事实（统一口径）', g2.ok, g2.detail);
      await sleep(800);
    }
    // D3：受控退出延迟核对——C（ZS_UI_SHUTDOWN_DELAY_MS=8s）关窗后 D 立即启动；C 停机事实
    // 在共存窗口结束后核对（完整+非 forced+时长≥8s）。
    {
      currentStep = 'D3';
      for (let i = 0; i < 120; i += 1) { if (exitCFacts != null) break; await sleep(500); }
      const cElapsed = exitCFacts != null ? exitCFacts.exitedAt - exitCFacts.closedAt : null;
      record('同步点·上一实例退出延迟（受控注入 8s）：C 停机事实完整（退出 0+complete+非 forced）且关窗→退出≥8s',
        exitCFacts?.exit?.code === 0 && exitCFacts?.facts?.daemonStopResult?.complete === true && exitCFacts?.facts?.daemonStopResult?.forced !== true && cElapsed != null && cElapsed >= 8000,
        `exit=${exitCFacts?.exit?.code} stop=${exitCFacts?.facts?.daemonStopResult?.complete} forced=${exitCFacts?.facts?.daemonStopResult?.forced} closed→exited=${cElapsed}ms`);
      await sleep(1000);
      record('会话 D 无残留（含受控延迟退出的 C 进程树收口）', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
    }
  }

} catch (error) {
  failed = true;
  console.error(`中止（${currentStep}）：${error instanceof Error ? error.stack : String(error)}`);
  await saveFailureScene(error);
} finally {
  // 本轮启动实例的兜底收拢：复用 v2 进程查询协议（排除自身/父壳），核对本轮进程身份；
  // 杀掉的 PID 记入 meta（收拢≠成功，残留计数只报告不冒充）。诊断目录保留策略不变。
  const killedPids = [];
  try {
    const q = listInstallProcesses();
    if (q.ok) {
      for (const row of q.rows) {
        try { spawnSync('taskkill', ['/PID', String(row.pid), '/T', '/F']); killedPids.push(row.pid); } catch { /* 尽力 */ }
      }
    } else {
      console.error(`[vdr] finally 进程查询失败：${q.raw}`);
    }
  } catch { /* 尽力 */ }
  if (killedPids.length > 0) console.error(`[vdr] finally 兜底收拢（非优雅，仅现场收束）：${killedPids.join(', ')}`);
  sessionFacts.__finallyKilled = killedPids;
}

// ---------- 报告：runId 目录永久留档（不覆盖历史）+指针文件 ----------
const allPassed = results.length > 0 && results.every((r) => r.ok) && !failed;
const commit = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const report = {
  runId, builtAt: new Date().toISOString(), installRoot, results, allPassed,
  layer: '便携产物 renderer 用户链路（CDP 真实页面操作）',
  frozen: frozenInfo, buildId: stagingBuildId, commit, sessions: SESSIONS,
  failedStep: failed ? currentStep : null,
  sessionFacts,
};
writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
// 指针文件（最新摘要+运行历史追加；历史 run 目录即完整记录，不被覆盖）。
const reportPath = join(repo, 'dist', 'desktop', 'verify-desktop-renderer-report.json');
let index = { runs: [] };
try {
  const prev = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (Array.isArray(prev?.runs)) index = prev;
} catch { /* 首次 */ }
index.latest = runId;
index.summary = { runId, at: report.builtAt, allPassed, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, frozen: frozenInfo, buildId: stagingBuildId, commit, failedStep: report.failedStep };
index.runs.push({ runId, at: report.builtAt, allPassed, runDir });
writeFileSync(reportPath, JSON.stringify(index, null, 2), 'utf8');
console.log(`[verify-desktop-renderer] runId=${runId} ${allPassed ? '全部通过' : '存在失败'}；报告=${join(runDir, 'report.json')}；历史=dist/desktop/vdr-runs/`);
if (!allPassed) console.log(`保留诊断目录：${installRoot}`);
else rmSync(installRoot, { recursive: true, force: true });
process.exit(allPassed ? 0 : 1);
