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
  // 严格读取（第二十四轮一）：表达式错误/异常≠空 DOM——读取失败必须作为失败暴露，
  // 不允许把 evalJs 的 {error} 读成 undefined 再登记成「渲染瞬空」。
  const readStrict = async (expression) => {
    const r = await evalJs(expression);
    if (r.error != null) throw new Error(`CDP 读取失败（表达式错误，非空 DOM）：${r.error}——表达式=${expression.slice(0, 120)}`);
    return r.value;
  };
  return {
    evalJs, readStrict, waitInteractive, pageErrors: () => pageErrors,
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
function countTable(dbFile, table) {
  try {
    const req = createRequire(join(repo, 'package.json'));
    const Database = req('better-sqlite3');
    const db = new Database(dbFile, { readonly: true });
    const c = (db.prepare(`SELECT count(*) c FROM ${table}`).get() ?? { c: -1 }).c;
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
      // ⑤ 管理面板显示 dispatched 历史（面板 30s 低频刷新——waitFor 覆盖；不能匹配 'done'——
      // 该词在触发时刻即出现，须等确认后的 dispatched 历史行）。
      await waitFor(async () => (await page.evalJs(`(() => { const t = document.querySelector('#reminder-list')?.textContent ?? ''; return t.includes('dispatched') })()`)).value === true, 90_000, 'REM 管理面板历史显示');
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

  // ---------- 会话 FS：DEV-18 第二包页面闭环（第二十五轮四：搜索/收藏/关注·静音）----------
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
