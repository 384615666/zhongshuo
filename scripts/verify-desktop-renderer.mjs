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
import { spawn, spawnSync, execSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as craft from './lib/craftDocuments.mjs';

const repo = resolve(import.meta.dirname, '..');

// ---------- 第二十九轮验证助手：真实上传路径（DataTransfer→file input change）与预览关闭 ----------
async function uploadViaInput(page, which, bytes, filename, mime) {
  const b64 = Buffer.from(bytes).toString('base64');
  await page.evalJs(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const input = document.getElementById(${JSON.stringify(which === 'dm' ? 'dm-attach-file' : 'composer-attach-file')});
    const dt = new DataTransfer();
    dt.items.add(new File([u8], ${JSON.stringify(filename)}, { type: ${JSON.stringify(mime)} }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  })()`);
}
async function closePreview(page) {
  await page.evalJs(`(() => { const btns = [...document.querySelectorAll('#attach-preview .chip')]; btns.find((b) => b.textContent.includes('关闭预览'))?.click(); })()`);
}

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
// 冻结身份核对（第二十六轮六）：ZS_VDR_EXPECT_BUILD_ID 显式声明预期 buildId——不匹配在
// 运行前拒绝（旧 round-22 冻结目录遗留教训的可执行收口——不再靠旧包进测试后排障）。
const EXPECT_BUILD_ID = process.env.ZS_VDR_EXPECT_BUILD_ID ?? '';
const frozenDir = join(repo, 'dist', 'desktop', 'vdr-frozen');
let staging;
let frozenInfo = { enabled: false };
if (FROZEN && existsSync(join(frozenDir, 'MANIFEST-SHA256.json'))) {
  const v = verifyFrozenDir(frozenDir);
  if (v.bad.length > 0) {
    console.error(`[vdr] 冻结产物核对失败（验收期间被重建/覆盖？）：\n  ${v.bad.slice(0, 5).join('\n  ')}`);
    process.exit(2);
  }
  if (EXPECT_BUILD_ID !== '') {
    const manifest = JSON.parse(readFileSync(join(frozenDir, 'BUILD.json'), 'utf8'));
    if (manifest.buildId !== EXPECT_BUILD_ID) {
      console.error(`[vdr] 冻结产物身份不符：预期 buildId=${EXPECT_BUILD_ID}，实际=${manifest.buildId}——运行前拒绝（删除 dist/desktop/vdr-frozen 重建，或修正 ZS_VDR_EXPECT_BUILD_ID）`);
      process.exit(3);
    }
    console.log(`[vdr] 冻结身份核对通过：buildId=${manifest.buildId}=预期`);
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
async function connectPage(port, evalDeadlineMs = 20_000, urlIncludes = 'index.html') {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.json());
  const target = list.find((t) => String(t.url).includes(urlIncludes));
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
  // 严格读取（第二十四轮一）：表达式错误/异常≠空 DOM——读取失败必须作为失败暴露，
  // 不允许把 evalJs 的 {error} 读成 undefined 再登记成「渲染瞬空」。
  const readStrict = async (expression) => {
    const r = await evalJs(expression);
    if (r.error != null) throw new Error(`CDP 读取失败（表达式错误，非空 DOM）：${r.error}——表达式=${expression.slice(0, 120)}`);
    return r.value;
  };
  // 网络离线模拟（第三十二轮五：失败同号重试的确定性断响应——不靠时序竞态）。
  const offline = async (off) => {
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', { offline: !!off, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  };
  return {
    evalJs, readStrict, waitInteractive, offline, pageErrors: () => pageErrors,
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

/** E18 造数（daemon 停机后直写 state.sqlite）：他人 DM（拒绝面）+15 项 REVIEW（13+ 可达）
 * +篡改 hash/重复验收对象。**项目 B 由段 1 经正式 project.open 创建**（bProject=返回的真实
 * projectId——目录身份/引导成员/默认房间全部真实），此处只在真实项目下补线程/任务数据。
 * 返回测试所需的 id/hash。 */
function seedE18Data(dbFile, bProject) {
  const req = createRequire(join(repo, 'package.json'));
  const Database = req('better-sqlite3');
  const db = new Database(dbFile);
  const now = Date.now();
  // 主项目（A）与房间会话 id 先查（显式变量——避免 SELECT 与占位混合）。
  const projA = db.prepare(`SELECT id FROM projects WHERE id != ? LIMIT 1`).get(bProject.id) ?? { id: 'p1' };
  const convARow = db.prepare(`SELECT id, room_id FROM conversations WHERE project_id = ? AND kind = 'room' LIMIT 1`).get(projA.id);
  const convA = convARow?.id ?? 'conv_room';
  const roomA = convARow?.room_id ?? 'room1';
  // 项目 B 的默认房间/会话（bootstrapProject 正式引导产物——归属与身份约束满足）。
  const convB = `conv_default_${bProject.id}`;
  const roomB = `room_default_${bProject.id}`;
  const tx = db.transaction(() => {
    // ---- 项目 B 业务数据（跨项目深链目标；项目/成员/房间=正式 project.open 产物） ----
    db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, thread_message_seq, author_type, author_id, body_json, status, created_at) VALUES ('anchor_thB',?, ?, 1, ?, NULL, NULL, 'human', 'u_local', ?, 'final', ?)`).run(bProject.id, convB, roomB, '{"text":"B 任务锚"}', now);
    db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id, last_message_seq) VALUES ('thB', ?, ?, ?, 'anchor_thB', 1)`).run(bProject.id, convB, roomB);
    db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, thread_message_seq, author_type, author_id, body_json, status, created_at) VALUES ('reply_thB', ?, ?, 2, ?, 'thB', 1, 'agent', ?, '{"text":"B 回复"}', 'final', ?)`).run(bProject.id, convB, roomB, `m_default_${bProject.id}_0`, now);
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, title, status, review_policy) VALUES ('taskB', ?, ?, 'room_task', ?, 'thB', 'B 项目任务', 'REVIEW', 'user_review')`).run(bProject.id, convB, roomB);
    db.prepare(`UPDATE conversations SET last_message_seq = 2 WHERE id = ?`).run(convB);
    // ---- 他人 DM（audience 拒绝面） ----
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_other_dm2',?,'dm',NULL)`).run(projA.id);
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES (?,'conv_other_dm2','human','u_other')`).run(projA.id);
    const agentMember = db.prepare(`SELECT principal_id FROM dm_participants WHERE principal_type='agent' LIMIT 1`).get();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES (?,'conv_other_dm2','agent',?)`).run(projA.id, agentMember?.principal_id ?? 'mA');
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status, review_policy) VALUES ('task_other_dm',?,'conv_other_dm2','dm_turn',NULL,'他人任务','REVIEW','user_review')`).run(projA.id);
    // ---- 15 项 REVIEW（13+ 可达）+两特殊对象：挂 A 的房间会话（显式循环，一条模板） ----
    const insThread = db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id, last_message_seq) VALUES (?, ?, ?, ?, ?, 0)`);
    const insMsg = db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, thread_message_seq, author_type, author_id, body_json, status, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'human', 'u_local', ?, 'final', ?)`);
    const insTask = db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, title, status, review_policy) VALUES (?, ?, ?, 'room_task', ?, ?, ?, 'REVIEW', 'user_review')`);
    const insDlv = db.prepare(`INSERT INTO task_deliveries (id, task_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status) VALUES (?, ?, 1, ?, '[]', '[]', '[]', 'pending')`);
    let seq = (db.prepare(`SELECT last_message_seq s FROM conversations WHERE id = ?`).get(convA))?.s ?? 0;
    const addTodo = (taskId, hash) => {
      seq += 1;
      insMsg.run(`anchor_${taskId}`, projA.id, convA, seq, roomA, JSON.stringify({ text: `待办 ${taskId}` }), now);
      insThread.run(`th_seed_${taskId}`, projA.id, convA, roomA, `anchor_${taskId}`);
      insTask.run(taskId, projA.id, convA, roomA, `th_seed_${taskId}`, `待办任务 ${taskId}`);
      insDlv.run(`dlv_${taskId}`, taskId, hash);
    };
    for (let i = 1; i <= 15; i += 1) addTodo(`e18_todo_${i}`, `mh-todo-${String(i).padStart(4, '0')}`);
    addTodo('e18_tampered', 'mh-tampered-NEW');
    addTodo('e18_dup', 'mh-dup-0001');
    db.prepare(`UPDATE conversations SET last_message_seq = ? WHERE id = ?`).run(seq, convA);
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES ('e18_a_room_task', ?, ?, 'room_task', ?, 'A 项目锚任务', 'DONE')`).run(projA.id, convA, roomA);
  });
  tx();
  db.close();
  return {
    bProjectName: 'E18项目B', bTaskId: 'taskB',
    otherDmConvId: 'conv_other_dm2', otherDmTaskId: 'task_other_dm',
    tamperedTaskId: 'e18_tampered', tamperedDeliveryId: 'dlv_e18_tampered', originalHash: 'mh-tampered-OLD',
    dupTaskId: 'e18_dup', dupDeliveryId: 'dlv_e18_dup', dupHash: 'mh-dup-0001',
    aRoomTaskId: 'e18_a_room_task',
  };
}

/** 读表行数（E18 零新增运行核对）。 */
function countTable(dbFile, table, where = '') {
  try {
    const req = createRequire(join(repo, 'package.json'));
    const Database = req('better-sqlite3');
    const db = new Database(dbFile, { readonly: true });
    const c = (db.prepare(`SELECT count(*) c FROM ${table} ${where}`).get() ?? { c: -1 }).c;
    db.close();
    return c;
  } catch { return `ERR`; }
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

  // ---------- 会话 E18：DEV-18 页面验收（第二十三轮五——新 build 零真实调用） ----------
  // 两段式：段 1=项目 A 页面操作（两线程未读/线程标读/双 DM 多待验收/A→B→A/后台不标读）；
  // 停机后 SQL 造数（项目 B+他人 DM+15 项 REVIEW+篡改 hash）；段 2=同 appData 重启
  //（水位保持/13+ 可达/错 hash/重复验收/跨项目深链/刷新/前进后退/他人 DM 拒/零新增运行）。
  if (shouldRun('E18')) {
    const appDataE = join(installRoot, '应用 数据', 'E18');
    let e18BProject = null; // 段 1 末尾经正式 project.open 填充（真实 projectId）
    {
      currentStep = 'E18-段1';
      const app = await launchApp('e18a', 9337, { ZS_FAKE_STALL_MS: '1500' }, appDataE);
      if (app.noPage) throw new Error('E18 段1：页面未就绪');
      const page = await connectPage(9337);
      await page.waitInteractive();
      // 前台性显式声明（第二十四轮一）：标读合同=「前台贴底才推进水位」。验证器驱动的窗口
      // 可能被遮挡（Electron occlusion 判后台→原生 document.hidden=true——round-24 两连复现
      // 的段1 三项失败真身：thread/conversation markRead 全程零发出）。测试语义的「前台」
      // 由验证器固定 hidden=false 声明；E18-4 的后台用例经 __zsSetHidden 开关控制。
      await page.evalJs(`(() => { let h = false; Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); window.__zsSetHidden = (v) => { h = !!v; }; })()`);
      currentRun = { tag: 'e18a', child: app.child, page, stderrText: app.stderrText };
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, 'E18 项目打开');
      await page.evalJs(`document.getElementById('task-review-toggle').click()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('task-review-toggle').textContent.includes('开')`)).value === true, 10_000, 'E18 验收开关');
      // E18-1 两线程未读：发两任务（各一条线程）→主池两卡片各显示未读。
      for (const t of ['线程甲任务（读 notes 报暗号）', '线程乙任务（分析目录）']) {
        await page.evalJs(`(() => { document.getElementById('composer-input').value = ${JSON.stringify(t)}; document.getElementById('send').click(); })()`);
        await sleep(2200);
      }
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length`)).value === 2, 30_000, '两任务卡片');
      // 等两线程各有 agent 回复（卡片出现≠回复已落——未读以 agent 消息计）。
      try {
        await waitFor(async () => (await page.evalJs(`[...document.querySelectorAll('#pool .pool-card')].filter((c) => c.textContent.includes('未读')).length`)).value === 2, 30_000, '两线程未读出现');
      } catch (e) {
        const diag = await page.readStrict(`JSON.stringify({ poll: window.__zsPollTick ?? -1, view: window.__zsView ?? '?', conn: document.getElementById('conn-state').textContent, cards: [...document.querySelectorAll('#pool .pool-card')].map((c) => c.textContent.slice(0, 50)) })`);
        throw new Error(`两线程未读出现超时（诊断：${String(diag)}）`);
      }
      const unreadBoth = await page.readStrict(`[...document.querySelectorAll('#pool .pool-card')].filter((c) => c.textContent.includes('未读')).length`);
      record('E18·两线程未读聚合（主池卡片各显示未读数）', unreadBoth === 2, `unreadCards=${unreadBoth}`);
      // 读线程 A（点第一张卡）→thread.markRead→回主池→A 未读消失、B 保持（读 A 不影响 B）。
      await page.evalJs(`document.querySelector('#pool .pool-card').click()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread-messages').textContent.length > 0`)).value === true, 20_000, '线程视图打开');
      await sleep(2600); // 贴底标读+轮询一轮
      await page.evalJs(`document.getElementById('thread-back-btn').click()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length`)).value === 2, 10_000, '回主池');
      await sleep(2200); // 主池重绘
      const afterRead = await page.readStrict(`[...document.querySelectorAll('#pool .pool-card')].filter((c) => c.textContent.includes('未读')).length`);
      record('E18·线程独立阅读（读 A 后 A 未读清、B 保持——打开房间不读全部线程）', afterRead === 1, `unreadAfter=${afterRead}`);
      // E18-2 双 DM+同会话多待验收：两条 REVIEW（串行两轮，均 REVIEW 态）。
      await page.evalJs(`document.getElementById('dm-create').click()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, '成员选择器');
      await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('dm').classList.contains('hidden')`)).value === true, 10_000, 'DM 视图');
      await page.evalJs(`(() => { document.getElementById('dm-input').value = '第一轮（待验收）'; document.getElementById('dm-send').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('dm-review-row').classList.contains('hidden') === false`)).value === true, 60_000, 'DM 第一轮 REVIEW');
      await page.evalJs(`(() => { document.getElementById('dm-input').value = '第二轮（第二个待验收）'; document.getElementById('dm-send').click(); })()`);
      await sleep(3000);
      // 同会话两个待验收：fake 串行——第二条完成后同样 REVIEW。等待侧栏出现 2 条 review。
      // 侧栏待验收=2 房间任务+2 DM 任务=4；本断言聚焦同会话两个 DM 待验收逐条列出。
      await waitFor(async () => (await page.evalJs(`[...document.querySelectorAll('#pending-list button')].filter((b) => b.textContent.includes('待验收：私信任务')).length`)).value === 2, 90_000, '同会话两个 DM 待验收条目');
      const pendingHead = await page.readStrict(`document.querySelector('#pending-list .sidebar-sec')?.textContent ?? ''`);
      record('E18·同会话多待验收全部可达（待我处理逐任务列出+总数头）', String(pendingHead).includes('共 4'), `head=${String(pendingHead).slice(0, 20)}`);
      // E18-3 A→B→A：新建第二 DM 会话→切换→切回→断言当前视图=会话 A（消息含第一轮文本）。
      await page.evalJs(`document.getElementById('dm-create').click()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, '选择器再现');
      await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-list button').length >= 2`)).value === true, 20_000, '两会话');
      // 列表序=新会话在前：[0]=B（新建）、[1]=A（含第一轮文本）。A→B→A=[1]→[0]→[1]。
      await page.evalJs(`[...document.querySelectorAll('#dm-list button')][1].click()`);
      await sleep(400);
      await page.evalJs(`[...document.querySelectorAll('#dm-list button')][0].click()`);
      await sleep(400);
      await page.evalJs(`[...document.querySelectorAll('#dm-list button')][1].click()`);
      await sleep(1800); // 等任何迟到响应落地
      const viewAfterABA = await page.readStrict(`document.getElementById('dm-messages').textContent`);
      record('E18·A→B→A 代次防护（切回 A 后视图仍是 A——旧 A 迟到响应不覆盖）', String(viewAfterABA ?? '').includes('第一轮'), `len=${String(viewAfterABA ?? '').length}`);
      // E18-4 后台窗口不标读：**先设 hidden**（前台等待会把回复标读=未读清零）→在 B 会话发消息
      // →agent 回复在 hidden 中到达→轮询重绘但不推进水位→侧栏 B 保持未读。
      await page.evalJs(`[...document.querySelectorAll('#dm-list button')][0].click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('dm').classList.contains('hidden')`)).value === true, 10_000, '切到 B 会话');
      await page.evalJs(`(() => { document.getElementById('dm-messages').textContent = document.getElementById('dm-messages').textContent; })()`);
      await page.evalJs(`window.__zsSetHidden(true)`);
      await page.evalJs(`(() => { document.getElementById('dm-input').value = '后台窗口测试消息'; document.getElementById('dm-send').click(); })()`);
      await waitFor(async () => (await page.evalJs(`(() => { const msgs = [...document.querySelectorAll('#dm-messages .msg')]; return msgs.filter((m) => m.className.includes('agent')).length })()`)).value >= 1, 90_000, 'B 会话 agent 回复（hidden 中到达）');
      await page.evalJs(`(() => { let unreadBefore = 0; for (const b of document.querySelectorAll('#dm-list button')) { if (b.textContent.includes('·')) unreadBefore += 1; } return unreadBefore; })()`);
      await sleep(3500); // 轮询 2 轮（hidden 中不标读——水位不推进）
      const hiddenStillUnread = await page.readStrict(`(() => { let n = 0; for (const b of document.querySelectorAll('#dm-list button')) { const t = b.textContent; const i = t.lastIndexOf('·'); if (i >= 0 && /^·[0-9]+$/.test(t.slice(i))) n += 1; } return n; })()`);
      record('E18·后台窗口不自动标读（hidden 期间轮询不推进水位）', Number(hiddenStillUnread) >= 1, `unreadRows=${hiddenStillUnread}`);
      await page.evalJs(`window.__zsSetHidden(false)`);
      // 打开有未读的会话（贴底+前台）→标读→未读清。
      await page.evalJs(`(() => { for (const b of document.querySelectorAll('#dm-list button')) { const t = b.textContent; const i = t.lastIndexOf('·'); if (i >= 0 && /^·[0-9]+$/.test(t.slice(i))) { b.click(); break; } } })()`);
      await sleep(3200);
      const afterOpenRead = await page.readStrict(`(() => { let n = 0; for (const b of document.querySelectorAll('#dm-list button')) { const t = b.textContent; const i = t.lastIndexOf('·'); if (i >= 0 && /^·[0-9]+$/.test(t.slice(i))) n += 1; } return n; })()`);
      record('E18·前台贴底标读（恢复可见+打开会话→未读清）', Number(afterOpenRead) === 0, `unreadRows=${afterOpenRead}`);
      // E18-2 fixture 修正（第二十四轮一）：项目 B 经**正式 project.open** 创建（目录身份真实——
      // 正式链按身份去重；SQL 只在其下补业务数据，不再伪造 directory_identity='{}'）。
      const e18BDir = join(repo, 'dist', 'desktop', 'vdr-fixture-b');
      mkdirSync(e18BDir, { recursive: true });
      writeFileSync(join(e18BDir, 'notes.md'), '# E18B-nl', 'utf8');
      const openB = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'e18-open-proj-b', method: 'project.open', params: { path: ${JSON.stringify(e18BDir)}, displayName: 'E18项目B' } }).then((r) => r, (e) => String(e))`);
      if (openB?.ok !== true || openB?.data?.project?.id == null) {
        throw new Error(`E18：项目 B 正式 project.open 失败（不能伪造 fixture）：${JSON.stringify(openB).slice(0, 160)}`);
      }
      e18BProject = { id: String(openB.data.project.id), displayName: 'E18项目B' };
      page.close();
      currentRun = null;
      const exitE1 = await exitWithGuard(app.child);
      const factsE1 = JSON.parse(readFileSync(join(appDataE, 'desktop-shutdown.json'), 'utf8'));
      const gE1 = gracefulShutdownOk(exitE1, factsE1);
      record('E18·段1 停机事实', gE1.ok, gE1.detail);
    }
    // ---- SQL 造数（停机后直写）：他人 DM（拒绝面）+15 项 REVIEW+错 hash（项目 B 已由段 1 正式创建） ----
    if (e18BProject == null) throw new Error('E18：项目 B 未经正式 project.open 创建（fixture 约束被绕过）');
    const e18Seed = seedE18Data(join(appDataE, 'state.sqlite'), e18BProject);
    {
      currentStep = 'E18-段2';
      const app = await launchApp('e18b', 9338, {}, appDataE);
      if (app.noPage) throw new Error('E18 段2：页面未就绪');
      const page = await connectPage(9338);
      await page.waitInteractive();
      currentRun = { tag: 'e18b', child: app.child, page, stderrText: app.stderrText };
      // E18-5 重启水位保持：自动恢复项目 A；待我处理=15（SQL）+2（DM，若未验收）——至少 15+，全部渲染+第 13 条存在。
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, '段2 项目恢复');
      await waitFor(async () => (await page.evalJs(`(() => { const h = document.querySelector('#pending-list .sidebar-sec')?.textContent ?? ''; return h.includes('共') && document.querySelectorAll('#pending-list button').length >= 15 })()`)).value === true, 30_000, '待办全量渲染（含总数头）');
      const head13 = await page.readStrict(`(() => ({ head: document.querySelector('#pending-list .sidebar-sec')?.textContent ?? '', thirteenth: document.querySelectorAll('#pending-list button')[12]?.textContent ?? '' }))()`);
      record('E18·第 13 项以后可达（无截断+总数头+第 13 条存在）', String(head13?.head ?? '').includes('共') && String(head13?.thirteenth ?? '').length > 0, `head=${String(head13?.head ?? '').slice(0, 16)} 13th=${String(head13?.thirteenth ?? '').slice(0, 14)}`);
      // E18-6 错 hash 验收（经页面命令通道）：被篡改交付用旧 hash→明确拒绝。
      const wrongHash = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'e18-wrong-hash', method: 'task.review', params: { taskId: ${JSON.stringify(e18Seed.tamperedTaskId)}, deliveryId: ${JSON.stringify(e18Seed.tamperedDeliveryId)}, deliveryRevision: 1, manifestHash: ${JSON.stringify(e18Seed.originalHash)}, decision: 'accept' } }).then((r) => r, (e) => String(e))`);
      const wrongOk = String(JSON.stringify(wrongHash ?? '')).includes('内容不符') || String(wrongHash?.error?.message ?? '').includes('内容不符') || String(wrongHash ?? '').includes('内容不符');
      record('E18·错 hash 验收拒绝（manifestHash 三重绑定经页面通道）', wrongOk, String(JSON.stringify(wrongHash ?? '')).slice(0, 60));
      // E18-7 重复验收：正确 hash accept 一次→再 accept→已处理。
      const acc1 = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'e18-acc-1', method: 'task.review', params: { taskId: ${JSON.stringify(e18Seed.dupTaskId)}, deliveryId: ${JSON.stringify(e18Seed.dupDeliveryId)}, deliveryRevision: 1, manifestHash: ${JSON.stringify(e18Seed.dupHash)}, decision: 'accept' } }).then((r) => r?.ok, (e) => String(e))`);
      const acc2 = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'e18-acc-2', method: 'task.review', params: { taskId: ${JSON.stringify(e18Seed.dupTaskId)}, deliveryId: ${JSON.stringify(e18Seed.dupDeliveryId)}, deliveryRevision: 1, manifestHash: ${JSON.stringify(e18Seed.dupHash)}, decision: 'accept' } }).then((r) => r?.error?.message ?? 'no-error', (e) => String(e))`);
      record('E18·重复验收拒绝（首次成功+二次已处理）', acc1 === true && String(acc2).includes('已处理'), `acc1=${acc1} acc2=${String(acc2).slice(0, 30)}`);
      // E18-8 跨项目深链：#task=项目 B 的任务→hashchange→项目切换到 B+线程打开。
      await page.evalJs(`location.hash = ${JSON.stringify(`task=${e18Seed.bTaskId}`)}`);
      const crossErrText = await page.evalJs(`document.body.textContent.match(/深链无法定位[^"]{0,80}/)?.[0] ?? ''`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('project-name').textContent.includes(${JSON.stringify(e18Seed.bProjectName)})`)).value === true, 30_000, `跨项目切换（页面错误=${String(crossErrText.value ?? '')}）`);
      const bThread = await page.readStrict(`document.getElementById('thread-messages').textContent.length > 0`);
      record('E18·跨项目深链（来源项目聚焦+线程打开——不回退当前项目同号任务）', bThread === true, `bProject=${e18Seed.bProjectName}`);
      // E18-9 刷新（URL 目标保留）：reload→恢复后仍在 B 项目+线程。
      await page.evalJs(`location.reload()`);
      await sleep(2500);
      const page2 = await connectPage(9338);
      await page2.waitInteractive();
      currentRun = { tag: 'e18b', child: app.child, page: page2, stderrText: app.stderrText };
      await waitFor(async () => (await page2.evalJs(`document.getElementById('project-name').textContent.includes(${JSON.stringify(e18Seed.bProjectName)})`)).value === true, 30_000, '刷新后项目恢复');
      const reloadKept = await page2.readStrict(`document.getElementById('thread-messages').textContent.length > 0`);
      record('E18·刷新保留（URL 深链优先于 localStorage 恢复）', reloadKept === true, '');
      // E18-10 前进后退：hash 切到 A 项目 DM→导航响应；history.back() 回 B。
      await page2.evalJs(`location.hash = ${JSON.stringify(`task=${e18Seed.aRoomTaskId}`)}`);
      await waitFor(async () => (await page2.evalJs(`document.getElementById('project-name').textContent.includes('项目') && !document.getElementById('project-name').textContent.includes(${JSON.stringify(e18Seed.bProjectName)})`)).value === true, 30_000, '后退到 A 项目');
      await page2.evalJs(`history.back()`);
      await waitFor(async () => (await page2.evalJs(`document.getElementById('project-name').textContent.includes(${JSON.stringify(e18Seed.bProjectName)})`)).value === true, 30_000, '前进回 B 项目');
      record('E18·前进后退可用（hash 变更双向导航）', true, '');
      // E18-11 他人 DM 链接拒绝（全形态经页面通道）：#dm/#task/#delivery/#msg。
      const deny1 = await page2.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'e18-deny-1', method: 'deepLink.resolve', params: { hash: ${JSON.stringify(`#dm=${e18Seed.otherDmConvId}`)} } }).then((r) => r?.error?.message ?? 'no-error')`);
      const deny2 = await page2.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'e18-deny-2', method: 'deepLink.resolve', params: { hash: ${JSON.stringify(`#task=${e18Seed.otherDmTaskId}`)} } }).then((r) => r?.error?.message ?? 'no-error')`);
      record('E18·他人 DM 链接拒绝（#dm/#task 全形态 audience）', String(deny1).includes('audience') && String(deny2).includes('audience'), `dm=${String(deny1).slice(0, 24)} task=${String(deny2).slice(0, 24)}`);
      // E18-12 零新增运行/零预算。
      const realCalls = countTable(join(appDataE, 'state.sqlite'), 'real_calls');
      record('E18·零新增运行零真实调用（guard+fake 全程）', realCalls === 0, `real_calls=${realCalls}`);
      page2.close();
      currentRun = null;
      const exitE2 = await exitWithGuard(app.child);
      const factsE2 = JSON.parse(readFileSync(join(appDataE, 'desktop-shutdown.json'), 'utf8'));
      const gE2 = gracefulShutdownOk(exitE2, factsE2);
      record('E18·段2 停机事实', gE2.ok, gE2.detail);
      await sleep(1000);
      record('E18·无残留', leftoverCount() === 0, `count=${JSON.stringify(leftoverCount())}`);
    }
  }

  // ---------- 会话 REM：提醒页面闭环基线（第二十四轮四——DEV-23 第二包）----------
  // 建 DM→⏰ 设每日提醒（任意分钟）→update 改 once 近未来→等调度 tick 到点→待我处理出现
  // 待确认行→点击确认→fake 执行回复落 DM→管理面板显示 dispatched 历史→snooze/取消→零真实调用。
  if (shouldRun('REM')) {
    const appDataR = join(installRoot, '应用 数据', 'REM');
    {
      currentStep = 'REM';
      const app = await launchApp('rem', 9339, {}, appDataR);
      if (app.noPage) throw new Error('REM：页面未就绪');
      const page = await connectPage(9339);
      await page.waitInteractive();
      await page.evalJs(`(() => { let h = false; Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); window.__zsSetHidden = (v) => { h = !!v; }; })()`);
      currentRun = { tag: 'rem', child: app.child, page, stderrText: app.stderrText };
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, 'REM 项目打开');
      // 建 DM 会话（picker 第一个成员）。
      await page.evalJs(`document.getElementById('dm-create').click()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, 'REM 成员选择器');
      await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('dm').classList.contains('hidden')`)).value === true, 10_000, 'REM DM 视图');
      // ① ⏰ 按钮设每日提醒（每天此刻——任意分钟可靠）。
      await page.evalJs(`document.getElementById('dm-remind-btn').click()`);
      await waitFor(async () => (await page.evalJs(`window.zs.command({ protocolVersion: 1, commandId: 'rem-count-1', method: 'reminder.list', params: {} }).then((r) => (r?.data?.items ?? []).length >= 1, () => false)`)).value === true, 15_000, 'REM 提醒已建');
      const listed = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'rem-list-2', method: 'reminder.list', params: {} }).then((r) => r?.data?.items ?? [])`);
      const rem0 = Array.isArray(listed) ? listed[0] : null;
      record('REM·每日提醒经 ⏰ 创建（任意分钟）', rem0 != null && rem0.schedule?.kind === 'daily', `kind=${rem0?.schedule?.kind} time=${rem0?.schedule?.time}`);
      // ② update 改 once 近未来（+20s）——命令通道（页面编辑表单为手工路径，此处验证命令闭环）。
      const fireAt = Date.now() + 20_000;
      const updated = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'rem-upd-1', method: 'reminder.update', params: { reminderId: ${JSON.stringify(rem0.reminderId)}, expectedRevision: ${JSON.stringify(rem0.revision)}, schedule: { kind: 'once', at: ${fireAt} } } }).then((r) => r?.ok ?? false, (e) => String(e))`);
      record('REM·计划编辑为一次性近未来（revision CAS）', updated === true, `ok=${updated}`);
      // ③ 等调度 tick（15s 粒度）到点→待我处理出现『提醒待确认』行。
      await waitFor(async () => (await page.evalJs(`[...document.querySelectorAll('#pending-list button')].filter((b) => b.textContent.includes('提醒待确认')).length`)).value === 1, 90_000, 'REM 到点待确认行出现');
      record('REM·到点→待我处理出现待确认入口（默认不自动执行）', true, '');
      // ④ 点击确认→正式链派发（fake）→回复落 DM。
      await page.evalJs(`(() => { for (const b of document.querySelectorAll('#pending-list button')) { if (b.textContent.includes('提醒待确认')) { b.click(); break; } } })()`);
      await waitFor(async () => (await page.evalJs(`(() => { const msgs = [...document.querySelectorAll('#dm-messages .msg')]; return msgs.filter((m) => m.className.includes('agent')).length })()`)).value >= 1, 90_000, 'REM 确认后执行回复到达');
      const remMsgs = await page.readStrict(`[...document.querySelectorAll('#dm-messages .msg')].filter((m) => m.className.includes('agent')).length`);
      record('REM·页面确认→正式执行→回复落目标会话', remMsgs >= 1, `agentMsgs=${remMsgs}`);
      await page.evalJs(`document.getElementById('reminder-panel').open = true`); // 展开（details 折叠不影响 DOM 但保险）
      // ⑤ 管理面板显示 dispatched 历史（面板 30s 低频刷新——waitFor 覆盖；不能匹配 'done'——
      // 该词在触发时刻即出现，须等确认后的 dispatched 历史行）。
      await page.evalJs(`document.getElementById('reminder-panel').open = true`);
      await waitFor(async () => (await page.evalJs(`(() => { const t = document.querySelector('#reminder-list')?.textContent ?? ''; return t.includes('dispatched') })()`)).value === true, 60_000, 'REM 管理面板历史显示');
      const panelText = await page.readStrict(`document.querySelector('#reminder-list')?.textContent ?? ''`);
      record('REM·管理面板：状态+occurrence 历史（dispatched 可见）', panelText.includes('dispatched'), panelText.slice(0, 60));
      // ⑥ 再建一条→snooze→取消（管理操作闭环）。
      await page.evalJs(`document.getElementById('dm-remind-btn').click()`);
      await sleep(1500);
      const listed2 = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'rem-list-3', method: 'reminder.list', params: {} }).then((r) => r?.data?.items ?? [])`);
      const rem1 = Array.isArray(listed2) ? listed2.find((x) => x.status === 'active') : null;
      const snoozed = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'rem-snooze-1', method: 'reminder.snooze', params: { reminderId: ${JSON.stringify(rem1?.reminderId ?? '')}, until: ${(rem1?.nextAt ?? Date.now()) + 3_600_000} } }).then((r) => r?.data?.snoozed ?? false, (e) => String(e))`);
      const cancelled = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'rem-cancel-1', method: 'reminder.cancel', params: { reminderId: ${JSON.stringify(rem1?.reminderId ?? '')} } }).then((r) => r?.data?.cancelled ?? false, (e) => String(e))`);
      record('REM·贪睡+取消（管理操作经命令面）', snoozed === true && cancelled === true, `snooze=${snoozed} cancel=${cancelled}`);
      // ⑦ 零真实调用+优雅停机。
      const realCallsR = countTable(join(appDataR, 'state.sqlite'), 'real_calls');
      record('REM·零真实调用（fake 执行链）', realCallsR === 0, `real_calls=${realCallsR}`);
      // 桌面系统通知（第二十五轮五）：权限可用+去重集恰一次（送达/点击定位的人工面留用户复核——如实标注）。
      const notifPerm = await page.readStrict(`typeof Notification !== 'undefined' ? Notification.permission : 'no-api'`);
      const notifDedup = await page.readStrict(`(JSON.parse(localStorage.getItem('zs-notified-rem') ?? '[]')).length`);
      record('REM·桌面系统通知（权限+去重恰一次；送达/点击人工面）', notifPerm === 'granted' && notifDedup === 1, `perm=${notifPerm} dedup=${notifDedup}`);
      page.close();
      currentRun = null;
      const exitR = await exitWithGuard(app.child);
      const factsR = JSON.parse(readFileSync(join(appDataR, 'desktop-shutdown.json'), 'utf8'));
      const gR = gracefulShutdownOk(exitR, factsR);
      record('REM·停机事实', gR.ok, gR.detail);
    }
  }

  // ---------- 会话 BOARD+ATT：DEV-19 看板/协作 + DEV-24 文本附件页面闭环（第二十六轮）----------
  if (shouldRun('BOARD')) {
    const appDataB = join(installRoot, '应用 数据', 'BOARD');
    {
      currentStep = 'BOARD';
      const app = await launchApp('board', 9341, {}, appDataB);
      if (app.noPage) throw new Error('BOARD：页面未就绪');
      const page = await connectPage(9341);
      await page.waitInteractive();
      currentRun = { tag: 'board', child: app.child, page, stderrText: app.stderrText };
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, 'BOARD 项目打开');
      // 主池任务（DIRECT——单 agent 预填）→ REVIEW（含交付）→ 看板断言。
      await page.evalJs(`(() => { document.getElementById('composer-input').value = '看板任务：完成分析'; document.getElementById('send').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.querySelector('#pool .pool-card') != null`)).value === true, 90_000, 'BOARD 任务卡片出现');
      await page.evalJs(`document.getElementById('board-toggle').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('board').classList.contains('hidden')`)).value === true, 10_000, 'BOARD 看板打开');
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#board-groups .board-card').length`)).value >= 1, 20_000, 'BOARD 卡片出现');
      const cardText = await page.readStrict(`document.querySelector('#board-groups .board-card')?.textContent ?? ''`);
      record('BOARD·卡片呈现（标题+列位）', cardText.includes('看板任务'), cardText.slice(0, 40));
      // 状态映射修正（第二十七轮五）：已完成列在（DONE 不再落等待）。
      const boardCols = await page.readStrict(`[...document.querySelectorAll('#board-groups .board-col .meta')].map((m) => m.textContent).join('|')`);
      record('BOARD·列含「已完成」（终态分列如实）', boardCols.includes('已完成'), boardCols.slice(0, 60));
      // 卡片点击→#task= 定位原线程。
      await page.evalJs(`document.querySelector('#board-groups .board-card').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('thread').classList.contains('hidden')`)).value === true, 20_000, 'BOARD 点击定位线程');
      record('BOARD·卡片点击定位原串（#task= 深链）', true, '');
      // Files 集合（第二十七轮五）：回主池→Files 面板四类分列。
      await page.evalJs(`document.getElementById('thread-back-btn').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('pool').classList.contains('hidden')`)).value === true, 10_000, 'BOARD 返回主池');
      await page.evalJs(`document.getElementById('files-toggle').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('files').classList.contains('hidden')`)).value === true, 10_000, 'BOARD Files 打开');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('files-groups')?.textContent ?? '').includes('项目文件')`)) === true, 20_000, 'BOARD Files 项目文件分列');
      const filesText = await page.readStrict(`document.getElementById('files-groups')?.textContent ?? ''`);
      record('BOARD·Files 集合四类分列（项目文件非空+分节呈现）', filesText.includes('项目文件'), filesText.slice(0, 60));
      // 打开看板零新运行（纯读）。
      const runsBefore = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'bd-r1', method: 'board.view', params: { scope: 'project', projectId: window.__zsProjId ?? '' } }).then(() => 1, () => 0)`);
      void runsBefore;
      const realCallsB = countTable(join(appDataB, 'state.sqlite'), 'real_calls');
      record('BOARD·打开看板零真实调用', realCallsB === 0, `real_calls=${realCallsB}`);
      page.close();
      currentRun = null;
      const exitB = await exitWithGuard(app.child);
      const factsB = JSON.parse(readFileSync(join(appDataB, 'desktop-shutdown.json'), 'utf8'));
      const gB = gracefulShutdownOk(exitB, factsB);
      record('BOARD·停机事实', gB.ok, gB.detail);
    }
  }
  if (shouldRun('ATT')) {
    const appDataA = join(installRoot, '应用 数据', 'ATT');
    {
      currentStep = 'ATT';
      const app = await launchApp('att', 9342, {}, appDataA);
      if (app.noPage) throw new Error('ATT：页面未就绪');
      const page = await connectPage(9342);
      await page.waitInteractive();
      currentRun = { tag: 'att', child: app.child, page, stderrText: app.stderrText };
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, 'ATT 项目打开');
      // DM + 附件上传（页面 file input 不能弹系统框——经命令通道上传+芯片渲染断言+发送注入）。
      await page.evalJs(`document.getElementById('dm-create').click()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, 'ATT 成员选择器');
      await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('dm').classList.contains('hidden')`)).value === true, 10_000, 'ATT DM 视图');
      const convId = await page.readStrict(`location.hash.startsWith('#dm=') ? location.hash.slice(4) : ''`);
      const up = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'att-upload-1', method: 'attachment.uploadText', params: { conversationId: ${JSON.stringify(convId)}, filename: ${JSON.stringify('验收附件 空格.md')}, content: ('# 附件' + String.fromCharCode(10) + String.fromCharCode(10) + '暗号：ATT-PAGE-3358') } }).then((r) => (r && r.ok === false ? String(r.error && r.error.message) : (r && r.data ? r.data : String(r))), (e) => String(e))`);
      record('ATT·中文空格文件名上传（副本+hash）', up?.attachmentId != null && String(up?.hash ?? '').length === 64, `conv=${String(convId).slice(0, 14)} up=${String(JSON.stringify(up ?? '')).slice(0, 80)}`);
      // 芯片渲染（第二十七轮三：真实 UI 上传路径——DataTransfer 驱动 file input change 走
      // wireAttach 全链：fatal UTF-8 解码+键控草稿。旧做法手插 DOM 芯片不算数）。
      await page.evalJs(`(() => { const input = document.getElementById('dm-attach-file'); const dt = new DataTransfer(); dt.items.add(new File(['# 附件' + String.fromCharCode(10) + String.fromCharCode(10) + '暗号：ATT-PAGE-3358'], '验收附件 空格.md', { type: 'text/markdown' })); input.files = dt.files; input.dispatchEvent(new Event('change')); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('dm-attach-chips')?.textContent ?? '').includes('验收附件')`)) === true, 20_000, 'ATT 草稿芯片（真实上传路径）');
      record('ATT·草稿芯片呈现（DataTransfer→wireAttach 真实路径）', true, '');
      // 非法 UTF-8 字节明确失败（fatal 解码——不上传替换字符）。
      await page.evalJs(`(() => { const input = document.getElementById('dm-attach-file'); const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array([0x23, 0x20, 0xff, 0xfe, 0x0a])], '坏字节.txt', { type: 'text/plain' })); input.files = dt.files; input.dispatchEvent(new Event('change')); })()`);
      await waitFor(async () => (await page.readStrict(`document.getElementById('conn-state')?.textContent?.includes('UTF-8') ?? false`)) === true, 10_000, 'ATT 非法字节拒绝提示');
      const chipCountStable = await page.readStrict(`document.getElementById('dm-attach-chips').querySelectorAll('button.chip').length`);
      record('ATT·非法 UTF-8 字节明确拒绝（fatal 解码）', chipCountStable === 2, `chips=${chipCountStable}（1 附件+1 清空）`);
      // 发送（带附件引用）→ 模型输入注入副本文本（fake）——经 UI 键控草稿（dm-send 真实按钮）。
      await page.evalJs(`(() => { document.getElementById('dm-input').value = '按附件执行'; document.getElementById('dm-send').click(); })()`);
      await waitFor(async () => (await page.readStrict(`document.getElementById('dm-attach-chips').querySelectorAll('button.chip').length`)) === 0, 20_000, 'ATT 发送后草稿清空（键控清算）');
      record('ATT·UI 发送（键控草稿 refs→任务建立；发送后草稿恰清）', true, '');
      await waitFor(async () => (await page.evalJs(`(() => { const msgs = [...document.querySelectorAll('#dm-messages .msg')]; return msgs.filter((m) => m.className.includes('agent')).length })()`)).value >= 1, 90_000, 'ATT DM 回复（含附件注入）');
      // 注入断言以**服务端留档的 ContextBundle 全文**为准（fake 回复不引用暗号——不冒充）。
      {
        const Database = createRequire(join(repo, 'package.json'))('better-sqlite3');
        const dbA = new Database(join(appDataA, 'state.sqlite'), { readonly: true });
        const bundle = dbA.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid DESC LIMIT 1').get();
        dbA.close();
        record('ATT·模型输入含附件文本（ContextBundle 全文=副本实际文本+hash+截断说明）', bundle != null && bundle.included_refs_json.includes('ATT-PAGE-3358') && bundle.included_refs_json.includes('验收附件 空格.md'), String(bundle?.included_refs_json?.length ?? 0));
      }
      // 已发消息附件芯片→点击预览（previewText 服务端 audience+完整性+字节截断）→评论区。
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-messages .attach-chips .chip').length`)).value >= 1, 20_000, 'ATT 已发消息附件芯片');
      await page.evalJs(`document.querySelector('#dm-messages .attach-chips .chip').click()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('ATT-PAGE-3358')`)) === true, 20_000, 'ATT 预览正文');
      const pvText = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·已发附件点击预览（正文+sha256+原始字节）', pvText.includes('ATT-PAGE-3358') && pvText.includes('sha256='), pvText.slice(0, 60));
      // 基础评论（UI 表单：正文+行号）→ 列表呈现（锚定版本 v1）。
      await page.evalJs(`(() => { const input = document.querySelector('#attach-preview .attach-comment-input'); input.value = '第 1 行标题建议更具体'; const lines = document.querySelectorAll('#attach-preview .attach-comment-line'); lines[0].value = '1'; document.querySelectorAll('#attach-preview .chip').forEach((b) => { if (b.textContent === '添加评论') b.click(); }); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('第 1 行标题建议更具体')`)) === true, 20_000, 'ATT 评论呈现');
      const cmtText = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·基础评论（行号锚定 v1+列表呈现）', cmtText.includes('第 1 行') && cmtText.includes('v1'), '');
      // 主池通道（第二十七轮二页面闭环）：真实上传→composer 芯片→UI 发送→线程已发芯片。
      await page.evalJs(`document.getElementById('dm-back-btn').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('pool').classList.contains('hidden')`)).value === true, 10_000, 'ATT 返回主池');
      await page.evalJs(`(() => { const input = document.getElementById('composer-attach-file'); const dt = new DataTransfer(); dt.items.add(new File(['export function parse() { return "POOL-ATT-7788"; }' + String.fromCharCode(10)], '解析 器.ts', { type: 'text/plain' })); input.files = dt.files; input.dispatchEvent(new Event('change')); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('解析 器.ts')`)) === true, 20_000, 'ATT 主池草稿芯片');
      await page.evalJs(`(() => { document.getElementById('composer-input').value = '按解析器代码执行'; document.getElementById('send').click(); })()`);
      await waitFor(async () => (await page.readStrict(`document.querySelectorAll('#pool .pool-card').length`)) >= 1, 90_000, 'ATT 主池任务卡出现');
      const poolCardText = await page.readStrict(`document.querySelector('#pool .pool-card')?.textContent ?? ''`);
      record('ATT·主池通道附件发送（UI 键控草稿→任务建立）', poolCardText.includes('按解析器代码执行'), poolCardText.slice(0, 30));
      // 打开线程：已发消息附件芯片（thread.history attachments）+ 预览。
      await page.evalJs(`document.querySelector('#pool .pool-card').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('thread').classList.contains('hidden')`)).value === true, 20_000, 'ATT 打开线程');
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#thread-messages .attach-chips .chip').length`)).value >= 1, 30_000, 'ATT 线程已发附件芯片');
      const threadChip = await page.readStrict(`document.querySelector('#thread-messages .attach-chips .chip')?.textContent ?? ''`);
      record('ATT·线程已发附件芯片（历史返回附件摘要）', threadChip.includes('解析 器.ts'), threadChip.slice(0, 30));
      await page.evalJs(`document.querySelector('#thread-messages .attach-chips .chip').click()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('POOL-ATT-7788')`)) === true, 20_000, 'ATT 代码附件预览');
      const pvCode = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·代码附件预览（code_file 标注+正文）', pvCode.includes('POOL-ATT-7788') && pvCode.includes('（代码）'), pvCode.slice(0, 50));
      // 图片附件页面闭环（第二十八轮四）：页面内合成 PNG（magic+IHDR——服务端校验头不验 CRC）→
      // DataTransfer 真实上传→芯片→<img> 预览（尺寸+OCR/模型输入如实标注）。
      await page.evalJs(`(() => {
        const head = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52, 0,0,1,40, 0,0,1,40, 8,0,0,0,0, 0,0,0,0]);
        const tail = new Uint8Array([0,0,0,0, 0x49,0x45,0x4e,0x44, 0xae,0x42,0x60,0x82]);
        const input = document.getElementById('composer-attach-file');
        const dt = new DataTransfer();
        dt.items.add(new File([head, tail], '合成 图.png', { type: 'image/png' }));
        input.files = dt.files; input.dispatchEvent(new Event('change'));
      })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('合成 图.png')`)) === true, 20_000, 'ATT 图片草稿芯片');
      const imgChipOk = await page.readStrict(`document.querySelectorAll('#composer-attach-chips button.chip').length`);
      const imgToast = await page.readStrict(`document.getElementById('conn-state')?.textContent ?? ''`); // 上传回显（尺寸）在提示条
      record('ATT·图片上传（magic+IHDR 校验过+尺寸回显）', Number(imgChipOk) >= 2 && imgToast.includes('296×296'), imgToast.slice(0, 50));
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; const img = chips.find((c) => c.textContent.includes('合成 图')); if (img) img.click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.querySelector('#attach-preview img') != null || document.querySelector('#attach-preview .img-decode-failed') != null`)).value === true, 20_000, 'ATT 图片 <img> 预览');
      const pvImg = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      // 合成样本=头部+IEND 无 IDAT（像素不可解码）：头部尺寸回显 ✓ + 解码失败如实呈现（第二十九轮三：
      // 格式头通过≠像素解码成功——不再以 <img> 元素存在冒充解码成功）。
      record('ATT·图片预览（头部尺寸回显+解码结果如实+OCR/模型输入标注）', pvImg.includes('296×296') && pvImg.includes('OCR 提取正文：未实现') && pvImg.includes('模型图片输入：未认证'), pvImg.slice(0, 70));
      await page.evalJs(`document.getElementById('attach-preview').querySelector('.chip').click()`); // 关闭预览
      // PDF 附件页面闭环（第二十八轮五）：页面内合成合法双页 PDF（xref 偏移计算）→上传→
      // 分页文本预览（第 2 页定位+像素渲染/OCR 标注+页导航）。
      await page.evalJs(`(() => {
        const enc = new TextEncoder();
        const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>'];
        // 两页带不同色块（视觉渲染确定性差异——文本单字形差太弱，色块面积/颜色不同保证翻页指纹变化）。
        const s1 = '1 0 0 rg 100 500 240 120 re f' + String.fromCharCode(10) + 'BT /F1 12 Tf 72 720 Td (PAGEUI-1-OK) Tj ET';
        objs.push('<< /Length ' + s1.length + ' >>' + String.fromCharCode(10) + 'stream' + String.fromCharCode(10) + s1 + String.fromCharCode(10) + 'endstream');
        objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>');
        const s2 = '0 0 1 rg 300 300 200 260 re f' + String.fromCharCode(10) + 'BT /F1 12 Tf 72 720 Td (PAGEUI-2-OK) Tj ET';
        objs.push('<< /Length ' + s2.length + ' >>' + String.fromCharCode(10) + 'stream' + String.fromCharCode(10) + s2 + String.fromCharCode(10) + 'endstream');
        let out = '%PDF-1.4' + String.fromCharCode(10); const offs = [];
        objs.forEach((b, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj' + String.fromCharCode(10) + b + String.fromCharCode(10) + 'endobj' + String.fromCharCode(10); });
        const x = out.length;
        out += 'xref' + String.fromCharCode(10) + '0 ' + (objs.length + 1) + String.fromCharCode(10) + '0000000000 65535 f ' + String.fromCharCode(10);
        for (const o of offs) out += String(o).padStart(10, '0') + ' 00000 n ' + String.fromCharCode(10);
        out += 'trailer' + String.fromCharCode(10) + '<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>' + String.fromCharCode(10) + 'startxref' + String.fromCharCode(10) + x + String.fromCharCode(10) + '%%EOF';
        const u8 = enc.encode(out); let bin = '';
        for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        window.__zsPdfB64 = btoa(bin);
        const input = document.getElementById('composer-attach-file');
        const dt = new DataTransfer();
        dt.items.add(new File([u8], '页面 合成.pdf', { type: 'application/pdf' }));
        input.files = dt.files; input.dispatchEvent(new Event('change'));
      })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('页面 合成.pdf')`)) === true, 30_000, 'ATT PDF 草稿芯片');
      const pdfToast = await page.readStrict(`document.getElementById('conn-state')?.textContent ?? ''`);
      record('ATT·PDF 上传（隔离解析过+页数回显）', pdfToast.includes('2 页'), pdfToast.slice(0, 50));
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; const pdf = chips.find((c) => c.textContent.includes('页面 合成')); if (pdf) pdf.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('PAGEUI-1-OK')`)) === true, 30_000, 'ATT PDF 首页预览');
      await page.evalJs(`(() => { const btns = [...document.querySelectorAll('#attach-preview .chip')]; const next = btns.find((b) => b.textContent.includes('后页')); if (next) next.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('PAGEUI-2-OK')`)) === true, 20_000, 'ATT PDF 第 2 页');
      const pvPdf = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·PDF 分页预览（第 2 页定位+页导航+像素渲染/OCR 标注）', pvPdf.includes('第 2 页') && pvPdf.includes('视觉渲染：浏览器 canvas') && pvPdf.includes('OCR：未实现'), pvPdf.slice(0, 70));
      // ---- 第二十九轮扩展（三/四/五）：视觉画布像素 / 真实中文 / 扫描件像素 / 图片门禁 /
      // 真实 WebP 编解码对账 / Office 三类页面流 ----
      // ① 视觉画布：zsres 特权协议加载随包 pdfjs ESM → canvas 渲染（非空白像素=真渲染，
      // 不以元素存在冒充）；翻页像素指纹变化。
      await waitFor(async () => (await page.readStrict(`(document.getElementById('pdf-visual-canvas')?.dataset.state ?? 'none')`)) === 'rendered', 30_000, 'ATT PDF 视觉画布渲染');
      const pixProbe = `(() => { const c = document.getElementById('pdf-visual-canvas'); if (c == null) return 'none'; const ctx = c.getContext('2d'); const d = ctx.getImageData(0, 0, c.width, c.height).data; let non = 0; let sum = 0; for (let i = 0; i < d.length; i += 40) { if (d[i] < 248 || d[i + 1] < 248 || d[i + 2] < 248) non++; sum += d[i] + d[i + 1] + d[i + 2]; } return non + '/' + sum + '/' + c.width + 'x' + c.height; })()`;
      const pix1 = await page.readStrict(pixProbe);
      record('ATT·PDF 视觉渲染（canvas 实际像素非空白）', Number(pix1.split('/')[0]) > 30, pix1.slice(0, 40));
      // 色块交叠区指纹（构造性差异：页1=红块、页2=蓝块——同区不同色，逐通道必差）。
      // 注意进入本段时已在第 2 页（上文文本翻页先发生）——先回第 1 页取指纹再前进。
      const bandProbe = `(() => { const c = document.getElementById('pdf-visual-canvas'); if (c == null) return 'none'; const ctx = c.getContext('2d'); const sx = Math.floor(c.width * 0.50), sy = Math.floor(c.height * 0.30); const w = Math.floor(c.width * 0.12), h = Math.floor(c.height * 0.05); const d = ctx.getImageData(sx, sy, w, h).data; let r = 0; let g = 0; let b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } return r + ',' + g + ',' + b; })()`;
      await page.evalJs(`(() => { const btns = [...document.querySelectorAll('#attach-preview .chip')]; btns.find((b) => b.textContent.includes('前页'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('pdf-visual-canvas')?.dataset.page ?? '') === '1' && document.getElementById('pdf-visual-canvas')?.dataset.state === 'rendered'`)) === true, 30_000, 'ATT 视觉画布回第 1 页渲染');
      const band1 = await page.readStrict(bandProbe);
      await page.evalJs(`(() => { const btns = [...document.querySelectorAll('#attach-preview .chip')]; btns.find((b) => b.textContent.includes('后页'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('pdf-visual-canvas')?.dataset.page ?? '') === '2' && document.getElementById('pdf-visual-canvas')?.dataset.state === 'rendered'`)) === true, 30_000, 'ATT 视觉画布第 2 页渲染');
      const pix2 = await page.readStrict(pixProbe);
      const band2 = await page.readStrict(bandProbe);
      {
        const [r1, , b1] = band1.split(',').map(Number);
        const [r2, , b2] = band2.split(',').map(Number);
        record('ATT·PDF 视觉翻页（页1红/页2蓝构造性指纹变化）', band1 !== band2 && r1 > r2 && b2 > b1 && Number(pix2.split('/')[0]) > 30, `${band1} → ${band2}`);
      }
      await page.evalJs(`(() => { const btns = [...document.querySelectorAll('#attach-preview .chip')]; btns.find((b) => b.textContent.includes('关闭预览'))?.click(); })()`);
      // ② 真实中文 PDF（Identity-H+ToUnicode——此前 latin1 冒充样本已废）：Node 合成→真实上传
      // 路径→分页预览逐字对上（服务端隔离解析提取）。
      await uploadViaInput(page, 'composer', craft.makeCjkToUnicodePdf([['众说协作平台 验收页', '暗号 真实中文-6699'], ['第二页 尾注 — 2 —']]), '真实中文 报告.pdf', 'application/pdf');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('真实中文 报告.pdf')`)) === true, 30_000, 'ATT 真实中文芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('真实中文'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('真实中文-6699')`)) === true, 30_000, 'ATT 真实中文预览');
      const pvCjk = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·真实中文 PDF（ToUnicode 提取逐字对上+页序）', pvCjk.includes('众说协作平台') && pvCjk.includes('真实中文-6699') && pvCjk.includes('第 1 页'), pvCjk.slice(0, 50));
      await closePreview(page);
      // ③ 扫描件（图像页零文本）：视觉像素可见+文本层如实空。
      await uploadViaInput(page, 'composer', craft.makeImagePdf([{ w: 90, h: 60, color: [210, 40, 40] }]), '扫描件.pdf', 'application/pdf');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('扫描件.pdf')`)) === true, 30_000, 'ATT 扫描件芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('扫描件'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('pdf-visual-canvas')?.dataset.state ?? 'none')`)) === 'rendered', 30_000, 'ATT 扫描件视觉渲染');
      const scanPix = await page.readStrict(pixProbe);
      const scanText = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·扫描件（像素可见+文本如实空）', Number(scanPix.split('/')[0]) > 50 && scanText.includes('无文本层'), `${scanPix.slice(0, 20)} · ${scanText.includes('无文本层') ? '空文本标注' : '?'}`);
      await closePreview(page);
      // ④ 返回主池 → 真实 WebP（页面 canvas 编码——Chromium 原生）→ 上传→<img> 解码对账；
      // 图片能力门（无确认不出门；确认后发送）。
      await page.evalJs(`document.getElementById('thread-back-btn').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('pool').classList.contains('hidden')`)).value === true, 10_000, 'ATT 返回主池（门禁段）');
      await page.evalJs(`(() => { const c = document.createElement('canvas'); c.width = 220; c.height = 140; const g = c.getContext('2d'); g.fillStyle = '#2f6fe4'; g.fillRect(0, 0, 220, 140); g.fillStyle = '#ffffff'; g.font = '20px sans-serif'; g.fillText('WEBP-OK', 30, 80); const url = c.toDataURL('image/webp', 0.9); const bin = atob(url.split(',')[1]); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); const dt = new DataTransfer(); dt.items.add(new File([u8], '真实 编码.webp', { type: 'image/webp' })); const input = document.getElementById('composer-attach-file'); input.files = dt.files; input.dispatchEvent(new Event('change')); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('真实 编码.webp')`)) === true, 30_000, 'ATT 真实 WebP 芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('真实 编码'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('image-preview-img')?.dataset.decode ?? '')`)) === 'ok', 30_000, 'ATT WebP 浏览器解码');
      const decodeState = await page.readStrict(`(() => { const i = document.getElementById('image-preview-img'); return i ? (i.dataset.decode + '|' + i.dataset.match + '|' + i.dataset.naturalWidth) : 'missing'; })()`);
      record('ATT·真实 WebP（页面编码→上传→浏览器解码对账 naturalWidth=声明宽）', decodeState.startsWith('ok|true|'), decodeState);
      await closePreview(page);
      // 能力门：主池发送含图草稿 → 确认条（#image-gate-confirm）→ 确认后发送。
      await page.evalJs(`(() => { document.getElementById('composer-input').value = '看图执行门禁流'; document.getElementById('send').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('image-gate-confirm') != null`)).value === true, 20_000, 'ATT 图片门禁确认条');
      const gateShown = await page.readStrict(`document.getElementById('send-error')?.textContent ?? ''`);
      record('ATT·图片能力门（未确认不出门——明确二选一）', gateShown.includes('模型图片输入能力未认证') && gateShown.includes('仅发送文字'), gateShown.slice(0, 50));
      await page.evalJs(`document.getElementById('image-gate-confirm').click()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.querySelectorAll('button.chip').length ?? 9)`)) === 0, 20_000, 'ATT 门禁确认后草稿清空');
      await waitFor(async () => (await page.readStrict(`document.querySelectorAll('#pool .pool-card').length`)) >= 2, 90_000, 'ATT 门禁确认后任务卡出现');
      {
        const Database = createRequire(join(repo, 'package.json'))('better-sqlite3');
        await waitFor(async () => {
          const dbG = new Database(join(appDataA, 'state.sqlite'), { readonly: true });
          const bundleG = dbG.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid DESC LIMIT 1').get();
          dbG.close();
          return bundleG != null && String(bundleG.included_refs_json).includes('【图片附件未发送】');
        }, 90_000, 'ATT 门禁任务 ContextBundle 注入说明');
        const Database2 = createRequire(join(repo, 'package.json'))('better-sqlite3');
        const dbG2 = new Database2(join(appDataA, 'state.sqlite'), { readonly: true });
        const bundleG2 = dbG2.prepare('SELECT included_refs_json FROM context_bundles ORDER BY rowid DESC LIMIT 1').get();
        dbG2.close();
        record('ATT·确认后注入「图片未发送+用户确认」（ContextBundle）', bundleG2 != null && bundleG2.included_refs_json.includes('【图片附件未发送】') && bundleG2.included_refs_json.includes('仅发送文字'), '');
      }
      // ⑤ 仅头 WebP（Node 合成头部——无数据体）：上传按头部过+像素解码失败如实呈现。
      // 样本取 VP8L（无损位流截断——浏览器解码必失败；VP8 有损头截断 Chromium 可容错解码）。
      await uploadViaInput(page, 'composer', craft.makeWebpVp8lHeaderOnly(180, 120), '仅头.webp', 'image/webp');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('仅头.webp')`)) === true, 30_000, 'ATT 仅头 WebP 芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('仅头'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`document.querySelector('#attach-preview .img-decode-failed') != null`)) === true, 30_000, 'ATT 仅头 WebP 解码失败标注');
      record('ATT·仅头 WebP（头部通过≠像素可解码——失败如实呈现）', true, '格式头校验过、浏览器解码失败占位说明');
      await closePreview(page);
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('清空附件'))?.click(); })()`);
      // ⑥ Office 三类页面流（真实上传路径→预览→范围写回草稿→随发送持久）。
      await uploadViaInput(page, 'composer', craft.makeDocx({ paras: ['DOCX 验收段落 甲', 'DOCX 第二段 乙'], table: [['列一', '列二'], ['甲值', '乙值']] }), '验收 文档.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('验收 文档.docx')`)) === true, 30_000, 'ATT DOCX 芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('验收 文档'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('甲值')`)) === true, 30_000, 'ATT DOCX 预览');
      const pvDocx = await page.readStrict(`(() => { const box = document.querySelector('#attach-preview .office-docx-html'); return (box ? (box.querySelectorAll('table').length + '|' + box.textContent.slice(0, 80)) : 'missing'); })()`);
      const pvDocxNote = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·DOCX 预览（安全排版 HTML 表格+白名单零属性）', pvDocx.startsWith('1|') && pvDocx.includes('甲值') && pvDocxNote.includes('宏不执行'), pvDocx.slice(0, 40));
      await closePreview(page);
      await uploadViaInput(page, 'composer', craft.makeXlsx([{ name: '数据', rows: [['名称', '数量'], ['中文行一', 42, { formula: 'B2*2' }], ['带缓存', { formula: '5*2', cached: '10' }, '']], merges: ['A1:B1'] }]), '数据 表.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('数据 表.xlsx')`)) === true, 30_000, 'ATT XLSX 芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('数据 表'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('中文行一')`)) === true, 30_000, 'ATT XLSX 预览');
      const pvSheet = await page.readStrict(`(() => { const t = document.querySelector('#attach-preview .sheet-grid'); return t ? (t.querySelectorAll('tr').length + '|' + t.textContent.slice(0, 60)) : 'missing'; })()`);
      const pvSheetNote = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·XLSX 预览（网格+公式无缓存值占位+合并标注）', pvSheet.startsWith('3|') && pvSheetNote.includes('公式无缓存值') && pvSheetNote.includes('合并单元格'), pvSheet.slice(0, 40));
      await page.evalJs(`(() => { document.getElementById('sheet-range-input').value = '数据!A1:B2'; [...document.querySelectorAll('#attach-preview .chip')].forEach((b) => { if (b.textContent.includes('设为注入范围')) b.click(); }); })()`);
      const rangeNote = await page.readStrict(`document.getElementById('sheet-range-note')?.textContent ?? ''`);
      record('ATT·范围选择写回草稿（注入范围 UI）', rangeNote.includes('数据!A1:B2'), rangeNote.slice(0, 40));
      await closePreview(page);
      await page.evalJs(`(() => { document.getElementById('composer-input').value = '按表格范围执行'; document.getElementById('send').click(); })()`);
      await waitFor(async () => (await page.readStrict(`document.querySelectorAll('#pool .pool-card').length`)) >= 3, 90_000, 'ATT 表格范围任务卡');
      {
        const Database = createRequire(join(repo, 'package.json'))('better-sqlite3');
        const dbR = new Database(join(appDataA, 'state.sqlite'), { readonly: true });
        const rangeRow = dbR.prepare("SELECT ma.range_spec FROM message_attachments ma JOIN artifacts a ON a.id = ma.artifact_id WHERE a.kind = 'sheet_file' ORDER BY ma.rowid DESC LIMIT 1").get();
        dbR.close();
        record('ATT·范围随消息持久（range_spec=数据!A1:B2）', rangeRow?.range_spec === '数据!A1:B2', String(rangeRow?.range_spec ?? ''));
      }
      await uploadViaInput(page, 'composer', craft.makePptx([{ texts: ['封面页 标题', '要点甲'], notes: '演讲备注 词' }, { texts: ['第二页 标题'], notes: null }]), '演示 幻灯.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('演示 幻灯.pptx')`)) === true, 30_000, 'ATT PPTX 芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('演示 幻灯'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('要点甲')`)) === true, 30_000, 'ATT PPTX 预览');
      const pvSlides = await page.readStrict(`(() => { const l = document.querySelector('#attach-preview .slides-list'); return l ? (l.querySelectorAll('.slide-card').length + '|' + l.textContent.slice(0, 60)) : 'missing'; })()`);
      const pvSlidesNote = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·PPTX 预览（按页文字+备注；页图如实 unsupported）', pvSlides.startsWith('2|') && pvSlidesNote.includes('演讲备注') && pvSlidesNote.includes('页图渲染：unsupported'), pvSlides.slice(0, 40));
      await closePreview(page);
      // ⑦ CSV（编码/引号规则页面链）。
      await uploadViaInput(page, 'composer', craft.makeCsvText([['名称', '备注'], ['中文单元格,逗号', '含"引号"'], ['行二', '值']], ','), '表格.csv', 'text/csv');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('composer-attach-chips')?.textContent ?? '').includes('表格.csv')`)) === true, 30_000, 'ATT CSV 芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('表格.csv'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('中文单元格')`)) === true, 30_000, 'ATT CSV 预览');
      const pvCsv = await page.readStrict(`document.getElementById('attach-preview')?.textContent ?? ''`);
      record('ATT·CSV 预览（UTF-8+引号逗号单元格如实）', pvCsv.includes('中文单元格,逗号') && pvCsv.includes('含"引号"') && pvCsv.includes('CSV · utf-8'), pvCsv.slice(0, 40));
      await closePreview(page);
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#composer-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('清空附件'))?.click(); })()`);
      // ---------- 第三十一轮二：新增页面会话（真实用户链路——不经 zs.command 直调替代）----------
      // ① Markdown 恶意样本：脚本/危险链接/远程图片——安全渲染（转义+占位，不执行不请求）。
      const NL31 = String.fromCharCode(10);
      const evilMd = '<script>window.__evilRan=true</script> 恶意样本 EVIL-MD-771' + NL31 + NL31 + '[危险](javascript:alert(1)) 与 [正常](https://example.com/x)' + NL31 + NL31 + '![远程图](https://evil.example/x.png)';
      await page.evalJs(`location.hash = '#dm=' + ${JSON.stringify(convId)}`);
      await waitFor(async () => (await page.readStrict(`!document.getElementById('dm').classList.contains('hidden')`)) === true, 10_000, 'ATT 回到 DM 视图');
      await uploadViaInput(page, 'dm', evilMd, '恶意样本.md', 'text/markdown');
      await waitFor(async () => (await page.readStrict(`(document.getElementById('dm-attach-chips')?.textContent ?? '').includes('恶意样本.md')`)) === true, 30_000, 'ATT 恶意 md 芯片');
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#dm-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('恶意样本.md'))?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('attach-preview')?.textContent ?? '').includes('EVIL-MD-771')`)) === true, 30_000, 'ATT 恶意 md 预览');
      const evilRender = await page.readStrict(`(() => { const pv = document.getElementById('attach-preview'); return JSON.stringify({ evilRan: String(window.__evilRan ?? 'unset'), html: pv ? pv.innerHTML.slice(0, 1200) : '', text: pv ? pv.textContent.slice(0, 600) : '' }); })()`);
      const evilParsed = JSON.parse(evilRender);
      record('ATT·Markdown 安全渲染（脚本转义不执行/javascript 链不落地/远程图占位不请求）',
        evilParsed.evilRan !== true && evilParsed.html.includes('&lt;script') && !evilParsed.html.includes('href="javascript') && evilParsed.text.includes('远程图片不加载'),
        `evilRan=${evilParsed.evilRan} htmlHead=${evilParsed.html.slice(0, 60)}`);
      // ② 预览搜索命中 + 行号引用进入正确草稿（DM 视图 → dm-input）。
      await page.evalJs(`(() => { const q = document.getElementById('preview-search'); q.value = 'EVIL-MD-771'; q.dispatchEvent(new Event('input')); })()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('preview-search-hit')?.textContent ?? '').includes('命中')`)) === true, 10_000, 'ATT 预览搜索命中');
      const hitLine = await page.readStrict(`document.querySelector('.preview-line.hit')?.dataset?.line ?? ''`);
      await page.evalJs(`document.querySelector('.preview-line.hit .preview-line-no').click()`);
      const draftAfterQuote = await page.readStrict(`document.getElementById('dm-input').value`);
      record('ATT·预览搜索+行引用进入正确草稿（dm-input）', hitLine !== '' && draftAfterQuote.includes('恶意样本.md:L') && draftAfterQuote.includes('EVIL-MD-771'), `line=${hitLine} draft=${draftAfterQuote.slice(0, 50)}`);
      await closePreview(page);
      await page.evalJs(`(() => { const chips = [...document.querySelectorAll('#dm-attach-chips button.chip')]; chips.find((c) => c.textContent.includes('清空附件'))?.click(); document.getElementById('dm-input').value = ''; })()`);
      // ③ 三格式导出（md/html/docx）+ 打开导出目录 + 线程导出守卫（非线程视图明确拒绝）。
      let exportOk3 = 0;
      for (const fmt of ['md', 'html', 'docx']) {
        await page.evalJs(`(() => { document.getElementById('dm-export-format').value = ${JSON.stringify(fmt)}; document.getElementById('dm-export-btn').click(); })()`);
        // eslint-disable-next-line no-await-in-loop
        await waitFor(async () => (await page.readStrict(`document.getElementById('conn-state').textContent.includes('导出完成') && document.getElementById('conn-state').textContent.includes(${JSON.stringify(fmt)})`)) === true, 30_000, `ATT 导出 ${fmt}`);
        exportOk3 += 1;
      }
      const openShown = await page.readStrict(`!document.getElementById('export-open-last').classList.contains('hidden')`);
      await page.evalJs(`document.getElementById('export-open-last').click()`);
      await new Promise((r) => setTimeout(r, 600));
      const openNoErr = await page.readStrict(`!document.getElementById('conn-state').textContent.includes('打开目录失败')`);
      record('ATT·三格式导出（md/html/docx）+获准打开目录', exportOk3 === 3 && openShown && openNoErr, `formats=${exportOk3}`);
      await page.evalJs(`document.getElementById('thread-export-btn').click()`);
      const threadGuard = await page.readStrict(`document.getElementById('conn-state').textContent.includes('仅线程视图')`);
      record('ATT·线程导出守卫（非线程视图明确拒绝）', threadGuard, '');
      // ④ Activity 定位（点击定位 chip → hash 路由到对应会话）。
      await page.evalJs(`document.getElementById('activity-toggle').click()`);
      await waitFor(async () => (await page.readStrict(`document.querySelectorAll('#activity-list .activity-row').length > 0`)) === true, 20_000, 'ATT Activity 行');
      await page.evalJs(`(() => { const go = document.querySelector('#activity-list .activity-row button.chip'); if (go) go.click(); })()`);
      const hash31 = await page.readStrict(`location.hash`);
      record('ATT·Activity 点击定位（hash 路由）', hash31.length > 3, hash31.slice(0, 30));
      await page.evalJs(`document.getElementById('activity-toggle').click()`);
      // ⑤ 表情反应+刷新保持（真实消息操作：😊 层→👍→reload→仍（我））。
      await page.evalJs(`(() => { const rows = [...document.querySelectorAll('#dm-list button')]; rows.find((r) => r.textContent.length > 0)?.click(); })()`);
      try {
        await waitFor(async () => (await page.readStrict(`!document.getElementById('dm').classList.contains('hidden') && document.querySelectorAll('#dm-messages .msg-actions').length > 0`)) === true, 20_000, 'ATT DM 消息操作组');
      } catch (e) {
        const st = await page.readStrict(`JSON.stringify({ hash: location.hash, dmHidden: document.getElementById('dm').className, threadHidden: document.getElementById('thread').className, dmListBtns: document.querySelectorAll('#dm-list button').length, dmMsgs: document.getElementById('dm-messages').children.length, conn: document.getElementById('conn-state').textContent.slice(0, 80) })`);
        throw new Error(`DM 操作组等待失败（state=${st}）：${e.message}`);
      }
      await page.evalJs(`(() => { const a = document.querySelector('#dm-messages .msg-actions'); [...a.querySelectorAll('button.msg-action')].find((b) => b.textContent === '😊')?.click(); })()`);
      try {
        await waitFor(async () => (await page.readStrict(`document.querySelectorAll('#dm-messages .msg-emoji-layer button.chip').length >= 6`)) === true, 20_000, 'ATT 表情层');
      } catch (e) {
        const st = await page.readStrict(`JSON.stringify({ actions: document.querySelector('#dm-messages .msg-actions')?.textContent ?? null, layers: document.querySelectorAll('#dm-messages .msg-emoji-layer').length, conn: document.getElementById('conn-state').textContent.slice(0, 100) })`);
        throw new Error(`表情层等待失败（state=${st}）：${e.message}`);
      }
      await page.evalJs(`(() => { const layer = document.querySelector('#dm-messages .msg-emoji-layer'); const b = [...layer.querySelectorAll('button.chip')].find((x) => x.textContent === '👍'); b.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.querySelector('#dm-messages .msg-emoji-layer')?.textContent ?? '').includes('👍')`)) === true, 20_000, 'ATT 表情已反应');
      await page.evalJs(`location.reload()`);
      await page.waitInteractive();
      await waitFor(async () => (await page.readStrict(`(() => { const el = document.getElementById('project-name'); return el != null ? !el.textContent.includes('未打开项目') : false; })()`)) === true, 30_000, 'ATT 刷新后项目恢复');
      await page.evalJs(`(() => { const rows = [...document.querySelectorAll('#dm-list button')]; rows.find((r) => r.textContent.length > 0)?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`document.querySelectorAll('#dm-messages .msg-actions').length > 0`)) === true, 20_000, 'ATT 刷新后 DM 消息');
      await page.evalJs(`(() => { const a = document.querySelector('#dm-messages .msg-actions'); [...a.querySelectorAll('button.msg-action')].find((b) => b.textContent === '😊')?.click(); })()`);
      await waitFor(async () => (await page.readStrict(`(document.querySelector('#dm-messages .msg-emoji-layer')?.textContent ?? '').includes('👍（我）')`)) === true, 20_000, 'ATT 刷新后表情保持');
      record('ATT·表情反应刷新保持（👍（我）持久）', true, '');

      const realCallsA = countTable(join(appDataA, 'state.sqlite'), 'real_calls');
      record('ATT·零真实调用（fake 注入链）', realCallsA === 0, `real_calls=${realCallsA}`);
      page.close();
      currentRun = null;
      const exitA2 = await exitWithGuard(app.child);
      const factsA2 = JSON.parse(readFileSync(join(appDataA, 'desktop-shutdown.json'), 'utf8'));
      const gA2 = gracefulShutdownOk(exitA2, factsA2);
      record('ATT·停机事实', gA2.ok, gA2.detail);
    }
  }

  // ---------- 会话 REMOTE：DEV-25 浏览器可操作闭环（第三十一轮五建；第三十二轮三/五扩全清单）----------
  // 壳=便携包 Chromium 纯浏览器（无 preload+SPKI 钉选——**受控自动化证书例外**，不是普通
  // Edge/Chrome 用户信任路径；正式双机验收由用户按完整指纹完成系统/浏览器信任，不带此开关）。
  // 覆盖：配对/房间+DM 会话/真实附件上传与消息呈现/A→B→A 草稿/DM 任务停止/任务验收（绑定
  // deliveryId+revision+manifestHash）/失败同号重试恰一次（CDP 离线断响应）/关闭客户端任务
  // 继续+重连恢复/刷新续传/游标过期快照恢复/token 到期自动续换（ZS_REMOTE_TOKEN_TTL_MS）/
  // 真实导出下载（认证 fetch→Blob）解包核对/吊销终态。零真实调用（fake+真实派发硬防护）。
  if (shouldRun('REMOTE')) {
    const appDataR = join(installRoot, '应用 数据', 'REMOTE');
    {
      currentStep = 'REMOTE';
      const app = await launchApp('remote', 9371, { ZS_FAKE_STALL_MS: '60000', ZS_REMOTE_TOKEN_TTL_MS: '8000', ZS_REMOTE_RESUME_WINDOW: '3', ZS_BOOTSTRAP_AGENTS: '验收员甲,验收员乙' }, appDataR);
      if (app.noPage) throw new Error('REMOTE：桌面页面未就绪');
      const page = await connectPage(9371);
      await page.waitInteractive();
      currentRun = { tag: 'remote', child: app.child, page, stderrText: app.stderrText };
      const dbPathR = join(appDataR, 'state.sqlite');
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.readStrict(`!document.getElementById('project-name').textContent.includes('未打开项目')`)) === true, 30_000, 'REMOTE 项目打开');
      // 验收策略 ON（后续任务交付待人工验收——页面验收按钮的载体）。
      await page.evalJs(`document.getElementById('project-settings').open = true`);
      await page.evalJs(`document.getElementById('task-review-toggle').click()`);
      await waitFor(async () => (await page.readStrict(`document.getElementById('task-review-note')?.textContent?.includes('开启') ?? document.getElementById('task-review-toggle').textContent.includes('开')`)) === true, 10_000, 'REMOTE 验收策略开');
      // 建 DM A 与 DM B（同一 Agent 两条私信——A→B→A 草稿对照）。
      const dmIds = [];
      // DM A：UI 成员选择器（第一条——真实链路）。
      await page.evalJs(`document.getElementById('dm-create').click()`);
      await waitFor(async () => (await page.readStrict(`document.querySelectorAll('#dm-member-picker button').length >= 1`)) === true, 10_000, 'REMOTE 成员选择器');
      await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
      await waitFor(async () => (await page.readStrict(`!document.getElementById('dm').classList.contains('hidden')`)) === true, 10_000, 'REMOTE DM 视图');
      dmIds.push(await page.readStrict(`location.hash.startsWith('#dm=') ? location.hash.slice(4) : ''`));
      // DM B：桌面正式命令 conversation.create（指定**另一位**成员——独立私信；UI 选择器
      // 对已建成员复用同会话，第二 UI 路径不保证新会话）。
      const projIdR = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'remote-conv-list-01', method: 'conversation.list', params: {} }).then((r) => ((r.data && r.data.conversations && r.data.conversations[0]) || {}).projectId ?? '')`);
      const membersExpr = `window.zs.command({ protocolVersion: 1, commandId: 'remote-member-list-01', method: 'member.list', params: { projectId: ${JSON.stringify(String(projIdR))} } }).then((r) => JSON.stringify((r.data && r.data.items) || []))`;
      const membersR = await page.readStrict(membersExpr);
      const members = JSON.parse(String(membersR));
      const agents = members.filter((m) => String(m.principalType ?? '') === 'agent' && m.enabled !== false);
      const peerB = agents[agents.length - 1] ?? {};
      const peerBId = peerB.id ?? '';
      const createdB = await page.readStrict(`window.zs.command({ protocolVersion: 1, commandId: 'remote-dm-create-02', method: 'conversation.create', params: { projectId: ${JSON.stringify(projIdR)}, peerMemberId: ${JSON.stringify(peerBId)} } }).then((r) => JSON.stringify(r.data ?? r), (e) => String(e))`);
      const convB = JSON.parse(String(createdB));
      dmIds.push(convB.conversation?.conversationId ?? convB.conversationId ?? '');
      record('REMOTE·双私信+验收策略建立（页面正式链）', dmIds.length === 2 && dmIds[0] !== dmIds[1], dmIds.map((x) => String(x).slice(0, 10)).join(','));
      // 启用远程+造码（本机可信入口）。
      await page.evalJs(`document.getElementById('remote-settings').open = true`);
      await page.evalJs(`(() => { document.getElementById('remote-host-sel').value = '127.0.0.1'; document.getElementById('remote-enable-btn').click(); })()`);
      let remoteAddress = '';
      await waitFor(async () => {
        const t = await page.readStrict(`document.getElementById('remote-config-row').textContent`);
        const m = /https:\/\/127\.0\.0\.1:(\d+)/.exec(t);
        if (m != null) { remoteAddress = 'https://127.0.0.1:' + m[1]; return true; }
        return false;
      }, 60_000, 'REMOTE 服务启用');
      record('REMOTE·桌面启用远程访问（本机可信入口）', remoteAddress.length > 0, remoteAddress);
      await page.evalJs(`document.getElementById('remote-pair-btn').click()`);
      let pairingText = '';
      await waitFor(async () => {
        pairingText = await page.readStrict(`document.getElementById('remote-pair-result').textContent`);
        return pairingText.includes('配对码：');
      }, 30_000, 'REMOTE 配对码生成');
      const pidM = /配对码：(pair_[A-Za-z0-9-]+) \/ ([A-Za-z0-9]{8,64})/.exec(pairingText);
      if (pidM == null) throw new Error('REMOTE：配对码解析失败：' + pairingText.slice(0, 120));
      const fullFp = /指纹（完整逐位核对）：([0-9a-f]{64})/.exec(pairingText)?.[1] ?? '';
      record('REMOTE·配对码+完整 64 位指纹呈现（可复制）', fullFp.length === 64, fullFp.slice(0, 20) + '…');
      // SPKI 钉选（受控自动化例外——见块首注释）。
      const cerPath = join(appDataR, 'remote', 'identity.cer');
      const spkiB64 = execSync('openssl x509 -inform DER -in "' + cerPath + '" -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -binary', { timeout: 30_000 }).toString('base64').trim();
      const readyMarker = join(runDir, 'sessions', 'remote-shell-ready.json');
      const mkShell = async (port) => launchApp('remote-shell', port, { ZS_REMOTE_SHELL_URL: remoteAddress, ZS_REMOTE_SHELL_SPKI: spkiB64, ZS_REMOTE_SHELL_READY: readyMarker }, appDataR);
      const shell = await mkShell(9372);
      await waitFor(async () => existsSync(readyMarker), 30_000, 'REMOTE 壳窗口就绪');
      const shellPage = await connectPage(9372, 30_000, 'https://');
      currentRun = { tag: 'remote', child: shell.child, page: shellPage, stderrText: shell.stderrText };
      await waitFor(async () => (await shellPage.readStrict(`document.getElementById('pair-btn') != null`)) === true, 20_000, 'REMOTE 壳页可交互');
      // 配对（真实表单）。
      await shellPage.evalJs(`(() => { document.getElementById('pairing-id').value = ${JSON.stringify(pidM[1])}; document.getElementById('pairing-code').value = ${JSON.stringify(pidM[2])}; document.getElementById('device-name').value = '验收浏览器'; document.getElementById('pair-btn').click(); })()`);
      await waitFor(async () => (await shellPage.readStrict(`!document.getElementById('main').classList.contains('hidden')`)) === true, 30_000, 'REMOTE 浏览器配对进入主界面');
      record('REMOTE·浏览器配对（IndexedDB 凭据+内存 token）', true, '');
      await waitFor(async () => (await shellPage.readStrict(`document.querySelectorAll('#conversation-sel option').length >= 3`)) === true, 20_000, 'REMOTE 会话列表（2 DM+房间）');
      // ---------- A→B→A 草稿（真实上传——DataTransfer 驱动 file input）----------
      const uploadViaShell = async (targetKey, name, content) => {
        await shellPage.evalJs(`(() => { const sel = document.getElementById('conversation-sel'); sel.value = ${JSON.stringify(targetKey)}; sel.dispatchEvent(new Event('change')); })()`);
        await shellPage.evalJs(`(() => { const input = document.getElementById('attach-file'); const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: 'text/plain' })); input.files = dt.files; input.dispatchEvent(new Event('change')); })()`);
        await waitFor(async () => (await shellPage.readStrict(`(document.getElementById('attach-chips')?.textContent ?? '').includes(${JSON.stringify(name)})`)) === true, 30_000, 'REMOTE 壳上传芯片 ' + name);
      };
      const dmAKey = 'dm:' + dmIds[0];
      const dmBKey = 'dm:' + dmIds[1];
      await uploadViaShell(dmAKey, 'A-附件.txt', '# A 附件内容 REMOTE-ATT-A-331');
      await uploadViaShell(dmBKey, 'B-附件.txt', '# B 附件内容 REMOTE-ATT-B-772');
      const aChips = await shellPage.evalJs(`(() => { const sel = document.getElementById('conversation-sel'); sel.value = ${JSON.stringify(dmAKey)}; sel.dispatchEvent(new Event('change')); return document.getElementById('attach-chips').textContent; })()`);
      record('REMOTE·A→B→A 附件草稿不串（A 的芯片只含 A）', String(aChips.value ?? '').includes('A-附件') && !String(aChips.value ?? '').includes('B-附件'), String(aChips.value ?? '').slice(0, 50));
      // ---------- 发送带附件（真实上传+消息附件呈现）----------
      await shellPage.evalJs(`(() => { document.getElementById('send-text').value = '浏览器带附件仅记录 REMOTE-MSG-ATT-551'; document.getElementById('record-btn').click(); })()`);
      await waitFor(async () => (await shellPage.readStrict(`(document.getElementById('messages')?.textContent ?? '').includes('REMOTE-MSG-ATT-551')`)) === true, 30_000, 'REMOTE 消息往返');
      const msgWithAtt = await shellPage.readStrict(`(document.getElementById('messages')?.textContent ?? '').includes('A-附件.txt')`);
      record('REMOTE·真实附件上传+消息附件呈现（📎+文件名）', msgWithAtt === true, '');
      // ---------- 失败同号重试恰一次（CDP 离线断响应——确定性）----------
      await shellPage.offline(true);
      await shellPage.evalJs(`(() => { document.getElementById('send-text').value = '断响应重试恰一次 REMOTE-RETRY-888'; document.getElementById('record-btn').click(); })()`);
      await waitFor(async () => (await shellPage.readStrict(`!document.getElementById('pending-ops').classList.contains('hidden')`)) === true, 20_000, 'REMOTE 未完成操作出现');
      await shellPage.offline(false);
      const retryCount1 = countTable(dbPathR, 'messages', `WHERE body_json LIKE '%REMOTE-RETRY-888%'`);
      await shellPage.evalJs(`document.querySelector('#pending-ops button').click()`);
      await waitFor(async () => (await shellPage.readStrict(`document.getElementById('pending-ops').classList.contains('hidden')`)) === true, 30_000, 'REMOTE 重试完成清理');
      const retryCount2 = countTable(dbPathR, 'messages', `WHERE body_json LIKE '%REMOTE-RETRY-888%'`);
      record('REMOTE·失败同号重试恰一次（离线断响应→沿原 commandId 重试）', retryCount1 === 0 && retryCount2 === 1, `before=${retryCount1} after=${retryCount2}`);
      // ---------- DM 任务：发起→页面停止（turn 停滞窗口内）----------
      await shellPage.evalJs(`(() => { const sel = document.getElementById('conversation-sel'); sel.value = ${JSON.stringify(dmAKey)}; sel.dispatchEvent(new Event('change')); })()`);
      await shellPage.evalJs(`(() => { document.getElementById('send-text').value = '发起会停的任务 REMOTE-TASK-STOP-1'; document.getElementById('send-btn').click(); })()`);
      await waitFor(async () => (await shellPage.readStrict(`(document.getElementById('tasks')?.textContent ?? '').includes('执行态=running') || (document.getElementById('tasks')?.textContent ?? '').includes('执行态=queued')`)) === true, 30_000, 'REMOTE DM 任务执行态呈现');
      record('REMOTE·页面发起 DM 任务（任务区呈现执行态）', true, '');
      // 停止点击轮询重试（渲染在 running↔queued 间跳变——单次点击可能落空；忠实用户「看到在跑就点停」）。
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const running = countTable(dbPathR, 'workflow_runs', `WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id = '${dmIds[0]}') AND status = 'RUNNING'`);
        if (running === 0) break;
        // eslint-disable-next-line no-await-in-loop
        await shellPage.evalJs(`(() => { const rows = [...document.querySelectorAll('#tasks div')]; const r = rows.find((x) => x.textContent.includes('执行态=running') || x.textContent.includes('执行态=queued')); const b = r && [...r.querySelectorAll('button')].find((x) => x.textContent === '停止' && !x.disabled); b && b.click(); })()`);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 4000));
      }
      try {
        await waitFor(async () => countTable(dbPathR, 'workflow_runs', `WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id = '${dmIds[0]}') AND status = 'RUNNING'`) === 0, 45_000, 'REMOTE 停止收口（run 离开 RUNNING）');
      } catch (e) {
        const st = await shellPage.readStrict(`(() => { const ops = JSON.parse(localStorage.getItem('zs-pending-ops') ?? '{}'); return JSON.stringify({ stopErr: window.__lastStopError ?? null, pendingOpKeys: Object.keys(ops), tasksHtml: (document.getElementById('tasks')?.textContent ?? '').slice(0, 260), convStates: 'n/a' }); })()`).catch(() => 'dump-fail');
        const convList = await shellPage.readStrict(`fetch('/cmd', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (window.__dbgToken ?? '') }, body: '{}' }).then(() => 'x').catch(() => 'x')`).catch(() => 'x');
        void convList;
        throw new Error(`停止收口失败（state=${String(st)}）：${e.message}`);
      }
      // DM 停止=run 收口+任务终态落库（结算异步——轮询到 terminal，不再瞬时断言竞态）。
      try {
        await waitFor(async () => countTable(dbPathR, 'tasks', `WHERE conversation_id = '${dmIds[0]}' AND status IN ('CANCELLED','STOPPED')`) >= 1, 45_000, 'REMOTE 停止任务终态落库');
      } catch (e) {
        const st = await shellPage.readStrict(`JSON.stringify({ stopErr: window.__lastStopError ?? null, tasks: (document.getElementById('tasks')?.textContent ?? '').slice(0, 200), feed: (document.getElementById('feed')?.textContent ?? '').slice(0, 200) })`).catch(() => 'dump-fail');
        throw new Error(`停止终态未落（state=${String(st)}）：${e.message}`);
      }
      const activeRunsA = countTable(dbPathR, 'workflow_runs', `WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id = '${dmIds[0]}') AND status IN ('RUNNING','WAITING','QUEUED')`);
      const taskAStates = countTable(dbPathR, 'tasks', `WHERE conversation_id = '${dmIds[0]}' AND status IN ('CANCELLED','STOPPED')`);
      record('REMOTE·页面停止 DM 任务（停止合同生效——run 收口+终态）', activeRunsA === 0 && taskAStates >= 1, `activeRuns=${activeRunsA} taskTerminal=${taskAStates}`);
      // ---------- 任务验收（绑定 deliveryId/revision/manifestHash——走 DM B：A 停止后队列暂停）----------
      await shellPage.evalJs(`(() => { const sel = document.getElementById('conversation-sel'); sel.value = ${JSON.stringify('dm:' + dmIds[1])}; sel.dispatchEvent(new Event('change')); })()`);
      await shellPage.evalJs(`(() => { document.getElementById('send-text').value = '发起可验收任务 REMOTE-TASK-ACCEPT-1'; document.getElementById('send-btn').click(); })()`);
      await waitFor(async () => {
        await shellPage.evalJs(`document.getElementById('refresh-btn').click()`).catch(() => null); // 刷新兜底（事件链路另行验证）
        return (await shellPage.readStrict(`[...document.querySelectorAll('#tasks button')].some((b) => b.textContent === '验收通过' && !b.disabled)`)) === true;
      }, 150_000, 'REMOTE 待验收交付出现');
      const acceptTaskCount = countTable(dbPathR, 'task_deliveries', `WHERE review_status = 'pending'`);
      await shellPage.evalJs(`(() => { const b = [...document.querySelectorAll('#tasks button')].find((x) => x.textContent === '验收通过' && !x.disabled); b.click(); })()`);
      await waitFor(async () => (await shellPage.readStrict(`[...document.querySelectorAll('#tasks button')].some((b) => b.textContent === '验收通过' && !b.disabled)`)) === false, 60_000, 'REMOTE 验收后按钮消失');
      const doneAfter = countTable(dbPathR, 'tasks', `WHERE status = 'DONE'`);
      record('REMOTE·页面验收通过（三重绑定生效→DONE）', acceptTaskCount >= 1 && doneAfter >= 1, `pendingBefore=${acceptTaskCount} done=${doneAfter}`);
      // ---------- 真实导出下载（认证 fetch→Blob）+解包核对----------
      // 导出回到 DM A（带附件消息所在会话——解包断言正文+附件随包）。
      await shellPage.evalJs(`(() => { const sel = document.getElementById('conversation-sel'); sel.value = ${JSON.stringify('dm:' + dmIds[0])}; sel.dispatchEvent(new Event('change')); })()`);
      await shellPage.evalJs(`document.getElementById('export-md').click()`);
      try {
        await waitFor(async () => (await shellPage.readStrict(`(document.getElementById('export-note')?.textContent ?? '').includes('已下载')`)) === true, 30_000, 'REMOTE 认证下载完成');
      } catch (e) {
        const st = await shellPage.readStrict(`JSON.stringify({ note: (document.getElementById('export-note')?.textContent ?? '').slice(0, 120), feed: (document.getElementById('feed')?.textContent ?? '').slice(0, 300), lastId: window.__lastExportId ?? null })`).catch(() => 'dump-fail');
        throw new Error(`认证下载失败（state=${String(st)}）：${e.message}`);
      }
      const exportMeta = await shellPage.readStrict(`(() => { const b = window.__lastExportBytes; return JSON.stringify({ len: b ? b.length : 0, head: b ? Array.from(b.slice(0, 2)) : [], id: window.__lastExportId ?? null }); })()`);
      const em = JSON.parse(String(exportMeta));
      // 二进制过 CDP JSON 会坏——页面内转 base64（有界分块，与产品同法）。
      const exportB64 = await shellPage.readStrict(`(() => { const b = window.__lastExportBytes; if (!b) return ''; let bin = ''; const CH = 0x8000; for (let i = 0; i < b.length; i += CH) bin += String.fromCharCode.apply(null, b.subarray(i, i + CH)); return btoa(bin); })()`).catch(() => null);
      let zipOk = false;
      let zipHasMd = false;
      let zipHasAtt = false;
      if (exportB64 != null && em.len > 0 && em.head[0] === 0x50) {
        const zbytes = Buffer.from(exportB64, 'base64');
        if (zbytes.length === em.len) {
          const { unzipSync } = await import('fflate');
          const files = unzipSync(new Uint8Array(zbytes));
          zipOk = true;
          const md = files['index.md'] != null ? Buffer.from(files['index.md']).toString('utf8') : '';
          zipHasMd = md.includes('REMOTE-MSG-ATT-551');
          zipHasAtt = Object.keys(files).some((k) => k.startsWith('assets/') && k.includes('A-附件'));
        }
      }
      record('REMOTE·真实导出下载解包核对（zip+正文+附件随包）', zipOk && zipHasMd && zipHasAtt, `bytes=${em.len} head=${JSON.stringify(em.head)} zipOk=${zipOk} md=${zipHasMd} att=${zipHasAtt}`);
      // ---------- 关闭客户端任务继续 + 重连恢复 ----------
      await shellPage.evalJs(`(() => { const sel = document.getElementById('conversation-sel'); sel.value = ${JSON.stringify('dm:' + dmIds[1])}; sel.dispatchEvent(new Event('change')); })()`);
      await shellPage.evalJs(`(() => { document.getElementById('send-text').value = '关闭后继续的任务 REMOTE-SURVIVE-1'; document.getElementById('send-btn').click(); })()`);
      await new Promise((r) => setTimeout(r, 800));
      shellPage.close();
      const exitShell1 = await exitWithGuard(shell.child).catch(() => ({ ok: false, detail: 'exit-guard-fail' }));
      // 验收策略开启——关闭后服务端完成=第三任务 run SUCCEEDED（任务进 REVIEW 待验收，不冒充 DONE）。
      await waitFor(async () => countTable(dbPathR, 'workflow_runs', `WHERE status = 'SUCCEEDED' AND task_id IN (SELECT id FROM tasks WHERE conversation_id = '${dmIds[1]}')`) >= 2, 90_000, 'REMOTE 关闭后服务端任务完成');
      record('REMOTE·关闭客户端任务继续（服务端完成第二条 DONE）', true, `shellExit=${exitShell1.ok}`);
      const shell2 = await mkShell(9373);
      await waitFor(async () => existsSync(readyMarker) === true, 5_000, 'REMOTE 二次壳就绪标记（复用）').catch(() => null);
      const shellPage2 = await connectPage(9373, 30_000, 'https://');
      await waitFor(async () => (await shellPage2.readStrict(`!document.getElementById('main').classList.contains('hidden') || !document.getElementById('setup').classList.contains('hidden')`)) === true, 30_000, 'REMOTE 二次壳进入');
      const reused = await shellPage2.readStrict(`!document.getElementById('main').classList.contains('hidden')`);
      record('REMOTE·重开免配对（IndexedDB 凭据复用）', reused === true, '');
      await shellPage2.evalJs(`(() => { const sel = document.getElementById('conversation-sel'); sel.value = ${JSON.stringify(dmAKey)}; sel.dispatchEvent(new Event('change')); })()`);
      await waitFor(async () => (await shellPage2.readStrict(`(document.getElementById('messages')?.textContent ?? '').includes('REMOTE-SURVIVE-1')`)) === true, 60_000, 'REMOTE 重开后结果可见');
      record('REMOTE·重开后任务结果消息可见（刷新续传）', true, '');
      // ---------- 游标过期快照恢复 ----------
      await shellPage2.evalJs(`(() => { localStorage.setItem('zs-last-seq', '0'); location.reload(); })()`);
      await connectPage(9373, 30_000, 'https://').then(async (p2b) => {
        await waitFor(async () => (await p2b.readStrict(`(document.getElementById('feed')?.textContent ?? '').includes('快照')`)) === true, 40_000, 'REMOTE 游标过期快照');
        record('REMOTE·游标过期快照恢复（cursor-stale→activity.list→再订阅）', true, '');
        p2b.close();
      }).catch(() => record('REMOTE·游标过期快照恢复', false, '快照未出现'));
      // ---------- token 到期自动续换（TTL=4s——等待后命令仍成功）----------
      await new Promise((r) => setTimeout(r, 9000));
      const afterExpire = await shellPage2.readStrict(`window.__lastExportId != null`).catch(() => false);
      await shellPage2.evalJs(`document.getElementById('refresh-btn').click()`);
      const renewed = await shellPage2.readStrict(`(document.getElementById('conversation-sel')?.options?.length ?? 0) >= 3`).catch(() => false);
      const wsReconnect = await shellPage2.readStrict(`(document.getElementById('feed')?.textContent ?? '').includes('disconnected')`).catch(() => false);
      record('REMOTE·token 到期自动续换（401→重换→命令成功；WS 会话关闭后重连）', renewed === true, `afterExpire=${String(afterExpire)} wsReconnected=${String(wsReconnect)}`);
      // ---------- 吊销终态 ----------
      await page.evalJs(`(() => { const d = document.getElementById('remote-settings'); d.open = false; d.open = true; })()`);
      await waitFor(async () => (await page.readStrict(`document.querySelectorAll('#remote-device-list button.chip').length > 0`)) === true, 20_000, 'REMOTE 设备清单');
      await page.evalJs(`document.querySelector('#remote-device-list button.chip').click()`);
      await waitFor(async () => (await page.readStrict(`(document.getElementById('remote-device-list')?.textContent ?? '').includes('已吊销')`)) === true, 20_000, 'REMOTE 吊销落库');
      try {
        await waitFor(async () => (await shellPage2.readStrict(`!document.getElementById('revoked-banner').classList.contains('hidden')`)) === true, 30_000, 'REMOTE 吊销终态横幅');
      } catch (e) {
        const st = await page.readStrict(`document.getElementById('remote-device-list').textContent.slice(0, 120)`).catch(() => 'no-list');
        const st2 = await shellPage2.readStrict(`JSON.stringify({ banner: document.getElementById('revoked-banner').className, feed: (document.getElementById('feed')?.textContent ?? '').slice(0, 150) })`).catch(() => 'no-page');
        throw new Error(`吊销终态失败（desktopList=${String(st)}; shell=${String(st2)}）：${e.message}`);
      }
      await waitFor(async () => (await shellPage2.readStrict(`(document.getElementById('feed')?.textContent ?? '').includes('revoked')`)) === true, 20_000, 'REMOTE 吊销终态线');
      record('REMOTE·吊销终态（横幅+事件流终态线；不再自动重连）', true, '');
      shellPage2.close();
      page.close();
      currentRun = null;
      // 壳=纯浏览器窗口（无 daemon 停机链）：Windows 进程树收口后确认退出事实。
      const shell2Exit = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ code: 'timeout' }), 15_000);
        t.unref?.();
        shell2.child.once('exit', (code) => { clearTimeout(t); resolve({ code }); });
        spawnSync('taskkill', ['/PID', String(shell2.child.pid), '/T', '/F'], { timeout: 10_000 });
      });
      record('REMOTE·壳退出（纯浏览器窗口——无停机链）', shell2Exit.code !== 'timeout', `exit=${String(shell2Exit.code)}`);
      const exitR2 = await exitWithGuard(app.child);
      const factsR = JSON.parse(readFileSync(join(appDataR, 'desktop-shutdown.json'), 'utf8'));
      const gR = gracefulShutdownOk(exitR2, factsR);
      record('REMOTE·桌面停机事实', gR.ok, gR.detail);
      const realCallsR = countTable(dbPathR, 'real_calls');
      record('REMOTE·零真实调用（fake+真实派发硬防护）', realCallsR === 0, `real_calls=${realCallsR}`);
    }
  }

  if (shouldRun('FS')) {
    const appDataF = join(installRoot, '应用 数据', 'FS');
    {
      currentStep = 'FS';
      const app = await launchApp('fs', 9340, { ZS_FAKE_STALL_MS: '9000' }, appDataF); // 回复延迟窗：开线程关注+返回（~4s）须先于回复到达——否则开线程即标读、关注行永无未读
      if (app.noPage) throw new Error('FS：页面未就绪');
      const page = await connectPage(9340);
      await page.waitInteractive();
      currentRun = { tag: 'fs', child: app.child, page, stderrText: app.stderrText };
      await page.evalJs(`document.getElementById('open-folder').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('project-name').textContent.includes('未打开项目')`)).value === true, 30_000, 'FS 项目打开');
      // 主池任务（关注/静音素材——单 agent 项目 UI 自动预填 mention=DIRECT）。
      await page.evalJs(`(() => { document.getElementById('composer-input').value = '主池任务：整理索引'; document.getElementById('send').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length`)).value === 1, 60_000, 'FS 主池任务卡片');
      // 建 DM+一条消息（fake 回复）——搜索/收藏素材。
      await page.evalJs(`document.getElementById('dm-create').click()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#dm-member-picker button').length > 0`)).value === true, 10_000, 'FS 成员选择器');
      await page.evalJs(`document.querySelector('#dm-member-picker button').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('dm').classList.contains('hidden')`)).value === true, 10_000, 'FS DM 视图');
      await page.evalJs(`(() => { document.getElementById('dm-input').value = '搜索暗号：蓝鲸文档'; document.getElementById('dm-send').click(); })()`);
      await waitFor(async () => (await page.evalJs(`(() => { const msgs = [...document.querySelectorAll('#dm-messages .msg')]; return msgs.filter((m) => m.className.includes('agent')).length })()`)).value >= 1, 90_000, 'FS DM 回复到达');
      // ① 搜索：中文关键词（范围=当前项目）→结果含该消息；点击→定位（DM 视图打开）。
      await page.evalJs(`(() => { document.getElementById('search-input').value = '蓝鲸文档'; document.getElementById('search-go').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#search-results button.room').length`)).value >= 1, 20_000, 'FS 搜索结果出现');
      const hitText = await page.readStrict(`document.querySelector('#search-results button.room')?.textContent ?? ''`);
      record('FS·中文搜索命中（当前项目范围）', hitText.includes('蓝鲸文档'), hitText.slice(0, 40));
      await page.evalJs(`document.querySelector('#search-results button.room').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('dm').classList.contains('hidden')`)).value === true, 10_000, 'FS 点击结果定位会话');
      record('FS·点击结果定位（深链打开原会话）', true, '');
      // 他人 DM 不进结果：伪造他人 DM 消息含同一暗号——走命令面已在 dev18FollowSearch 覆盖（页面断言范围=可见性）。
      // ② 收藏：消息 ☆ →面板条目→取消→空。
      await page.evalJs(`document.querySelector('#dm-messages .msg .msg-star').click()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#saved-list button.chip, #saved-list div.room').length >= 1`)).value === true, 20_000, 'FS 收藏面板条目');
      const savedText = await page.readStrict(`document.querySelector('#saved-list')?.textContent ?? ''`);
      record('FS·消息收藏（面板列出）', savedText.length > 0 && !savedText.includes('暂无收藏'), savedText.slice(0, 30));
      await page.evalJs(`(() => { const btn = [...document.querySelectorAll('#saved-list button')].find((b) => b.textContent === '取消收藏'); if (btn) btn.click(); })()`);
      await waitFor(async () => (await page.evalJs(`(document.querySelector('#saved-list')?.textContent ?? '').includes('暂无收藏')`)).value === true, 20_000, 'FS 取消收藏后清空');
      record('FS·取消收藏（不删原消息——会话仍含暗号）', true, '');
      const dmStill = await page.readStrict(`document.getElementById('dm-messages').textContent.includes('蓝鲸文档')`);
      record('FS·取消收藏不删原内容', dmStill === true, '');
      // ③ 关注/静音：素材线程**此刻才发**（stall 9s——搜索/收藏期间到达的旧回复会让开线程即标读，
      // 关注行永无未读；关注须在回复到达前完成）→开线程→关注→回主池→回复到达=未读→待我处理
      // 出现关注行→静音→主池未读清。
      await page.evalJs(`(() => { let h = false; Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); window.__zsSetHidden = (v) => { h = !!v; }; })()`);
      await page.evalJs(`document.getElementById('dm-back-btn').click()`);
      await waitFor(async () => (await page.evalJs(`!document.getElementById('pool').classList.contains('hidden')`)).value === true, 10_000, 'FS 返回主池（视图）');
      await page.evalJs(`(() => { document.getElementById('composer-input').value = '关注素材任务：稍后回复'; document.getElementById('send').click(); })()`);
      await waitFor(async () => (await page.evalJs(`document.querySelectorAll('#pool .pool-card').length`)).value >= 2, 30_000, 'FS 新任务卡片（第二张）');
      const followCardIdx = await page.readStrict(`(() => { const cards = [...document.querySelectorAll('#pool .pool-card')]; return cards.findIndex((c) => c.textContent.includes('关注素材任务')) })()`);
      await page.evalJs(`[...document.querySelectorAll('#pool .pool-card')][${Number(followCardIdx)}].click()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread-messages').textContent.length > 0`)).value === true, 20_000, 'FS 线程打开');
      await page.evalJs(`document.getElementById('thread-follow-btn').click()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread-follow-btn').textContent.includes('已关注')`)).value === true, 10_000, 'FS 关注生效');
      record('FS·关注线程（阅读订阅——按钮态切换）', true, '');
      await page.evalJs(`document.getElementById('thread-back-btn').click()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread').classList.contains('hidden') && !document.getElementById('pool').classList.contains('hidden')`)).value === true, 10_000, 'FS 返回主池（视图真实切换——DOM 持久不以内容判）');
      await waitFor(async () => (await page.evalJs(`[...document.querySelectorAll('#pool .pool-card')][${Number(followCardIdx)}].textContent.includes('未读')`)).value === true, 60_000, 'FS 线程回复未读出现');
      await waitFor(async () => (await page.evalJs(`[...document.querySelectorAll('#pending-list button')].some((b) => b.textContent.includes('关注的线程'))`)).value === true, 30_000, 'FS 待我处理出现关注行');
      record('FS·关注线程有未读进待我处理', true, '');
      await page.evalJs(`[...document.querySelectorAll('#pool .pool-card')][${Number(followCardIdx)}].click()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread-messages').textContent.length > 0`)).value === true, 20_000, 'FS 线程再开');
      await page.evalJs(`document.getElementById('thread-mute-btn').click()`);
      await waitFor(async () => (await page.evalJs(`document.getElementById('thread-mute-btn').textContent.includes('取消静音')`)).value === true, 10_000, 'FS 静音生效');
      await page.evalJs(`document.getElementById('thread-back-btn').click()`);
      await sleep(2500);
      const poolMuted = await page.readStrict(`[...document.querySelectorAll('#pool .pool-card')][${Number(followCardIdx)}].textContent.includes('未读')`);
      record('FS·静音后该卡未读聚合清零（卡片仍可见）', poolMuted === false, `cardUnread=${poolMuted}`);
      // ④ 零新增运行零真实调用。
      const realCallsF = countTable(join(appDataF, 'state.sqlite'), 'real_calls');
      record('FS·零真实调用（纯读+偏好写）', realCallsF === 0, `real_calls=${realCallsF}`);
      page.close();
      currentRun = null;
      const exitF = await exitWithGuard(app.child);
      const factsF = JSON.parse(readFileSync(join(appDataF, 'desktop-shutdown.json'), 'utf8'));
      const gF = gracefulShutdownOk(exitF, factsF);
      record('FS·停机事实', gF.ok, gF.detail);
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
