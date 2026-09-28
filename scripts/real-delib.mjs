/**
 * 真实研讨/直接执行 提交-观察分离 harness（M1 价值对比批次版，2026-09-28 第五轮）：
 * - submit：一次提交（renderer 真实操作链），成员经正式 member.setRuntime 绑定 runtime/模型，
 *   保存全字段 manifest（runtime/请求模型/成员绑定/代码提交/模板版本/权限参数/fixture hash/
 *   预算/task+run 身份），退出后 electron+daemon 继续运行。
 * - observe：只读观察（run.progress/report.get/任务态），不重新提交、不派发；退出≠后台失败。
 * - stop：整体截止/用户停止——正式 task.stop 绑定 runId/停止代次，观察至可解释终态。
 * - ledger：从本侧数据库统计已耗调用/终态（台账：成功/失败/修复/不可排除尝试全部计入）。
 * - verify：分组核验（runtime/模型请求、产物归属、预算对账、跨侧隔离抽查）。
 *
 * 批次布局：%TEMP%/zhongshuo-value/<GROUP>/<side>/{appdata,proj,manifest.json}；
 * 固定资料与标准答案分离存放：%TEMP%/zhongshuo-value/fixtures/<GROUP>/materials（入 proj 副本）
 * 与 %TEMP%/zhongshuo-value/fixtures/<GROUP>/key.json（永不进入模型工作目录）。
 *
 * 本批（已授权，上限 33）：每组 DIRECT≤2 / DELIBERATE≤9，Claude Code + 显式
 * --model deepseek-flash（ZS_RUNTIME=claude；成员绑定为准，未绑定即失败——不回落 codex）。
 *
 * 用法：
 *   node scripts/real-delib.mjs submit --group A --side delib --task-file <path> [--rehearse]
 *   node scripts/real-delib.mjs observe|stop|status|ledger|verify --group A --side delib
 * 旧用法（无分组）保持兼容：submit/observe/stop/status 落在 legacy 目录。
 */
/* global fetch, WebSocket, AbortSignal */
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BATCH_ROOT = join(tmpdir(), 'zhongshuo-value');
const LEGACY_ROOT = join(tmpdir(), 'zhongshuo-m1-real');
const CDP_PORT = 9781;

const DEFAULT_TASK = '请两位分别独立分析 notes.md 的内容要点与可疑之处（每人不超过6条结论），随后互评并形成整合结论';

// ---------- CLI 解析 ----------

function parseArgs(argv) {
  const out = { action: argv[0], flags: {} };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--group' || a === '--side' || a === '--task-file' || a === '--task' || a === '--runtime' || a === '--model' || a === '--fixture-dir') {
      out.flags[a.slice(2)] = argv[i + 1];
      i += 1;
    } else if (a === '--rehearse') out.flags.rehearse = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const GROUP = args.flags.group; // 缺省=legacy 模式
const SIDE = args.flags.side ?? 'delib';
const IS_BATCH = GROUP != null;
const ROOT = IS_BATCH ? join(BATCH_ROOT, GROUP, SIDE) : LEGACY_ROOT;
const APPDATA = join(ROOT, 'appdata');
const PROJ = join(ROOT, 'proj');
const MANIFEST = join(ROOT, 'manifest.json');
const RUNTIME = args.flags.runtime ?? (IS_BATCH ? 'claude' : 'codex');
const MODEL = args.flags.model ?? (RUNTIME === 'claude' ? 'deepseek-flash' : 'gpt-6-luna');
const REHEARSE = args.flags.rehearse === true;

if (IS_BATCH && !['direct', 'delib'].includes(SIDE)) { console.error('--side 须为 direct|delib'); process.exit(64); }
if (IS_BATCH && !['A', 'B', 'C'].includes(GROUP)) { console.error('--group 须为 A|B|C'); process.exit(64); }
// 批次纪律：真实批只走 claude+deepseek-flash；rehearse 允许 fake（零调用彩排）。
if (IS_BATCH && !REHEARSE && RUNTIME !== 'claude') { console.error('本批真实调用只允许 --runtime claude（deepseek-flash）；彩排用 --rehearse'); process.exit(64); }
if (IS_BATCH && !REHEARSE && MODEL !== 'deepseek-flash') { console.error('本批真实调用模型固定 deepseek-flash（不静默回退/切换）'); process.exit(64); }

const SIDE_CAP = SIDE === 'direct' ? 2 : 9; // 每侧新增上限（正常+修复共享；DELIB 争议分支亦在 9 内竞争）
const AGENTS = SIDE === 'delib' ? '分析师甲,分析师乙' : '执行成员';

// ---------- 通用 ----------

function sha256File(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

function hashDir(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const rel2 = rel.length === 0 ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(d, e.name), rel2);
      else files.push({ path: rel2.replaceAll('\\', '/'), sha256: sha256File(join(d, e.name)) });
    }
  };
  walk(dir, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(join(src, e.name), join(dst, e.name));
    else writeFileSync(join(dst, e.name), readFileSync(join(src, e.name)));
  }
}

function gitCommit() {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(); } catch { return null; }
}

function standingPromptVersion() {
  try {
    const m = readFileSync(join('src', 'contracts', 'prompts.ts'), 'utf8').match(/STANDING_PROMPT_VERSION = '([^']+)'/);
    return m ? m[1] : null;
  } catch { return null; }
}

function adapterVersion() {
  try {
    const m = readFileSync(join('src', 'adapter', 'claude', 'cliAdapter.ts'), 'utf8').match(/CLAUDE_ADAPTER_VERSION = '([^']+)'/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function cdpCall(method, params) {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (page == null) throw new Error('CDP 页面目标不可达');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const id = 1;
  const p = new Promise((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === id) {
        if (m.error != null) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    });
  });
  ws.send(JSON.stringify({ id, method, params }));
  const r = await p;
  ws.close();
  return r;
}

async function evalPage(expr) {
  const r = await cdpCall('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
}

const cmd = (m, p) => `window.zs.command({protocolVersion:1,commandId:'harness-${Math.random().toString(36).slice(2)}',method:'${m}',params:${JSON.stringify(p)}})`;

async function cmdJson(method, params) {
  const raw = await evalPage(`(async()=>{ try { return JSON.stringify(await ${cmd(method, params)}); } catch(e){ return JSON.stringify({ok:false,error:{message:e.message}}); } })()`);
  return JSON.parse(String(raw));
}

async function waitForEval(exprTrue, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evalPage(exprTrue)) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 直接只读打开本侧 SQLite（plain node 无 strip-types；不改库——仅 SELECT）。 */
const nodeRequire = createRequire(import.meta.url);
function openSqlite() {
  const Database = nodeRequire('better-sqlite3');
  return new Database(join(APPDATA, 'state.sqlite'), { readonly: false, fileMustExist: true });
}

function loadManifest() {
  if (!existsSync(MANIFEST)) { console.error(`无 manifest（${MANIFEST}）：先 submit`); process.exit(6); }
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

async function snapshot() {
  const m = loadManifest();
  const snap = { manifest: { taskId: m.taskId, runId: m.runId ?? null, group: m.batch?.group ?? null, side: m.batch?.side ?? null, submittedAt: m.submittedAt }, elapsedMs: Date.now() - m.submittedAt };
  try {
    const progress = await cmdJson('run.progress', { taskId: m.taskId });
    snap.progress = progress?.data ?? progress;
    const report = await cmdJson('report.get', { taskId: m.taskId });
    snap.report = report?.data ?? report;
    const task = await cmdJson('task.get', { taskId: m.taskId });
    snap.task = { status: task?.data?.task?.status ?? task?.task?.status ?? null, stopGeneration: task?.data?.task?.stopGeneration ?? task?.task?.stopGeneration ?? null };
  } catch (e) {
    snap.observeError = String(e.message ?? e);
  }
  snap.appAlive = alive(m.electronPid);
  snap.overallDeadlineExceeded = m.config?.runMaxMs != null && snap.elapsedMs > m.config.runMaxMs;
  return snap;
}

// ---------- submit ----------

async function doSubmit() {
  mkdirSync(APPDATA, { recursive: true });
  mkdirSync(PROJ, { recursive: true });
  // fixture：批次=固定资料目录副本（两侧各自独立副本+hash）；legacy=内置 notes.md。
  let fixtureFiles;
  if (IS_BATCH) {
    const fixtureDir = args.flags['fixture-dir'] ?? join(BATCH_ROOT, 'fixtures', GROUP, 'materials');
    if (!existsSync(fixtureDir)) throw new Error(`固定资料目录不存在：${fixtureDir}（先固化 fixture）`);
    copyDir(fixtureDir, PROJ);
    fixtureFiles = hashDir(PROJ);
  } else {
    writeFileSync(join(PROJ, 'notes.md'), '# 服务器迁移备忘\n\n- 旧机器：10.0.0.11（已下线）\n- 新机器：10.0.0.22，SSH 端口 2222\n- 数据库备份：/backup/db-20260920.sql.gz（未校验）\n- 证书续期脚本：每月 1 号，上次执行 9 月 1 日成功\n- 已知问题：夜间 2 点有约 5 分钟的日志空窗，原因不明\n', 'utf8');
    fixtureFiles = hashDir(PROJ);
  }
  if (existsSync(MANIFEST)) {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    if (alive(m.electronPid)) {
      console.error(`已有实例在运行（pid=${m.electronPid}，taskId=${m.taskId ?? '未知'}）——先 observe 只读核对，勿重复提交。`);
      process.exit(5);
    }
    console.error('旧 manifest 存在但进程已死：记录于 manifest.bak 后重新提交。');
    try { renameSync(MANIFEST, `${MANIFEST}.bak-${Date.now()}`); } catch { /* ignore */ }
  }
  // CDP 端口占用守卫：另一实例在跑（端口可达）即拒绝——避免新提交落到旧实例页面。
  try {
    await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
    console.error(`CDP 端口 ${CDP_PORT} 已被占用（另一实例在运行）——先关闭旧实例再提交。`);
    process.exit(5);
  } catch { /* 端口空闲：继续 */ }
  const taskText = IS_BATCH && args.flags['task-file'] != null
    ? readFileSync(args.flags['task-file'], 'utf8').trim()
    : (args.flags.task ?? DEFAULT_TASK);
  const config = {
    model: MODEL,
    runtime: RUNTIME,
    turnDeadlineMs: Number(process.env.ZS_TURN_DEADLINE_MS ?? 420_000),
    maxTurns: Number(process.env.ZS_DELIB_MAX_TURNS ?? (SIDE === 'delib' ? 9 : 6)),
    runMaxMs: Number(process.env.ZS_RUN_MAX_MS ?? 45 * 60_000),
    absenceMs: 20 * 60_000,
    sideCap: SIDE_CAP,
  };
  if (IS_BATCH) {
    console.log('本侧调用预算（预先声明）：', JSON.stringify({
      group: GROUP, side: SIDE, 上限: SIDE_CAP,
      正常路径: SIDE === 'delib' ? '无争议=IND2+CR2+SYN1+RAT2=7；有争议=讨论/格式修复/SYN-RAT 尾部全部在 9 内按合同竞争（不另增、不跳过争议维持 7）' : '正常 1 + 格式修复最多 1（每份逻辑输出一次）',
      尾部预留: SIDE === 'delib' ? 'S=1+Q=2 含在 9 内' : null,
      单轮截止: config.turnDeadlineMs, 整体窗: config.runMaxMs,
      说明: '达上限即停增调用，按合同收尾（带异议报告或如实阻塞）；不自动追加预算',
    }));
  }
  // 彩排=零调用（fake 显式开发模式）；真实批=claude。成员绑定一律走正式命令。
  const effRuntime = REHEARSE ? 'fake' : RUNTIME;
  const electronBin = join('node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electronBin, [`--remote-debugging-port=${CDP_PORT}`, 'dist/ui/main.cjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ZS_APP_DATA: APPDATA, ZS_RUNTIME: effRuntime, ZS_ALLOW_FAKE: REHEARSE ? '1' : process.env.ZS_ALLOW_FAKE,
      ZS_CLAUDE_MODEL: RUNTIME === 'claude' ? MODEL : undefined,
      ZS_PICK_FOLDER: PROJ, ZS_PIPE_NAME: `\\\\.\\pipe\\zhongshuo-value-${GROUP ?? 'g0'}-${SIDE}-${Date.now() % 100000}`,
      ZS_BOOTSTRAP_AGENTS: AGENTS, ZS_DELIB_MAX_TURNS: String(config.maxTurns),
      ZS_TURN_DEADLINE_MS: String(config.turnDeadlineMs), ZS_ABSENCE_MS: String(config.absenceMs),
      ZS_ENABLE_DELIBERATE: SIDE === 'delib' ? '1' : process.env.ZS_ENABLE_DELIBERATE,
      ZS_FAKE_DELIB: REHEARSE && SIDE === 'delib' ? '1' : undefined,
      ZS_DETACHED_TURNS: '1',
    },
    detached: true, stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.unref();
  for (let i = 0; i < 100; i += 1) {
    try {
      if (await evalPage(`typeof document.getElementById('open-folder').onclick === 'function'`)) break;
    } catch { /* app 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  await evalPage(`document.getElementById('open-folder').click(), true`);
  await waitForEval(`document.getElementById('project-name').textContent.includes('proj')`, 30_000, '项目加载');
  // 成员绑定（正式命令链）：真实批=claude+deepseek-flash+plan 只读档；彩排=fake。
  // 不允许未绑定回落：逐一核对 member.runtime 绑定结果，任何失败即中止（不留半绑定实例）。
  const memberBindings = [];
  const ml = await cmdJson('member.list', { projectId: (await cmdJson('project.open', { path: PROJ.replaceAll('\\', '/') }))?.data?.project?.id });
  const projectId = (await cmdJson('project.open', { path: PROJ.replaceAll('\\', '/') }))?.data?.project?.id;
  void ml;
  const members = (await cmdJson('member.list', { projectId }))?.data?.items ?? [];
  const agents = members.filter((mm) => mm.principalType === 'agent');
  if (agents.length === 0) throw new Error('无 agent 成员（bootstrap 失败）');
  for (const ag of agents) {
    const bind = REHEARSE
      ? { memberId: ag.id, kind: 'fake' }
      : { memberId: ag.id, kind: 'claude', model: MODEL, permissionMode: 'plan' };
    const r = await cmdJson('member.setRuntime', bind);
    if (r.ok !== true) throw new Error(`member.setRuntime 失败（${ag.displayName}）：${JSON.stringify(r.error)}`);
    const v = (await cmdJson('member.runtime', { memberId: ag.id }))?.data ?? {};
    const bound = v.binding ?? v;
    if (REHEARSE) {
      if (!(bound.kind === 'fake' || v.kind === 'fake')) throw new Error(`彩排绑定核对失败（${ag.displayName}）：${JSON.stringify(v)}`);
    } else if (bound.kind !== 'claude' || (bound.model ?? '') !== MODEL) {
      throw new Error(`绑定核对失败（${ag.displayName}）：期望 claude/${MODEL}，实际 ${JSON.stringify(bound)}`);
    }
    memberBindings.push({ memberId: ag.id, displayName: ag.displayName, kind: REHEARSE ? 'fake' : 'claude', model: REHEARSE ? null : MODEL, permissionMode: REHEARSE ? null : 'plan', capabilitiesRecorded: true });
  }
  // 提交（renderer 真实操作链）：delib=@全体研讨；direct=mention 单成员。
  if (SIDE === 'delib') {
    await evalPage(`document.getElementById('deliberate-toggle').click(), true`);
  } else {
    await evalPage(`(function(){const e=document.getElementById('mention-pick'); e.value=${JSON.stringify(agents[0].displayName)}; e.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
  }
  await evalPage(`(function(){const e=document.getElementById('composer-input'); e.value=${JSON.stringify(taskText)}; e.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
  await evalPage(`document.getElementById('send').click(), true`);
  await waitForEval(`!!document.querySelector('#pool .pool-card')`, 60_000, '任务卡出现');
  const roomId = (await cmdJson('room.list', { projectId }))?.data?.items[0]?.id;
  const poolItem = (await cmdJson('room.pool', { roomId }))?.data?.items[0];
  const taskId = poolItem?.taskId;
  if (taskId == null) throw new Error(`taskId 获取失败：${JSON.stringify(poolItem)}`);
  const runInfo = (await cmdJson('task.get', { taskId }))?.data ?? {};
  const manifest = {
    batch: IS_BATCH ? { id: 'value-abc-20260928', group: GROUP, side: SIDE, authorizedCapTotal: 33, sideCap: SIDE_CAP } : null,
    rehearse: REHEARSE,
    runtime: { kind: REHEARSE ? 'fake(rehearsal)' : 'claude', requestedModel: REHEARSE ? null : MODEL, adapterVersion: adapterVersion(), fallbackRuntimeEnv: effRuntime, channelNote: 'Claude Code CLI 渠道（用户 settings.json env）；响应模型以 result.model/assistant.message.model 双源取证' },
    memberBindings,
    codeCommit: gitCommit(),
    standingPromptVersion: standingPromptVersion(),
    permissionParams: REHEARSE ? null : { permissionMode: 'plan', allowedTools: 'Read,Glob,Grep', disallowed: 'Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,Skill,TodoWrite,mcp__*', extras: ['--permission-prompts none', '--strict-mcp-config', '--bare', '--disable-slash-commands'] },
    fixture: { materialsDir: IS_BATCH ? join(BATCH_ROOT, 'fixtures', GROUP, 'materials') : null, keyFile: IS_BATCH ? join(BATCH_ROOT, 'fixtures', GROUP, 'key.json') : null, files: fixtureFiles },
    taskText,
    budget: { maxTurns: config.maxTurns, normalPath: SIDE === 'delib' ? 'IND2+CR2+SYN1+RAT2=7（无争议）' : '1', repairMargin: SIDE === 'delib' ? SIDE_CAP - 7 : 1, disputeNote: SIDE === 'delib' ? '争议/修复/尾部在 9 内竞争，不另增调用' : null },
    taskId,
    runId: runInfo.activeRun?.id ?? null,
    electronPid: child.pid, cdpPort: CDP_PORT, appData: APPDATA, proj: PROJ,
    submittedAt: Date.now(), config,
  };
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, taskId, runId: manifest.runId, pid: child.pid, manifest: MANIFEST, members: memberBindings.length, fixtureFiles: fixtureFiles.length }, null, 2));
}

// ---------- observe / stop ----------

async function doObserve() {
  const snap = await snapshot();
  const st = snap.progress?.runStatus ?? snap.progress?.data?.runStatus;
  const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(st);
  console.log(JSON.stringify(snap, null, 2));
  if (!snap.appAlive) process.exit(4);
  if (terminal) process.exit(0);
  process.exit(1);
}

async function doStop() {
  const m = loadManifest();
  const stopRequestedAt = Date.now();
  let stopAck;
  try {
    const parsed = (await cmdJson('task.get', { taskId: m.taskId }))?.data ?? {};
    const t = parsed.task;
    const run = parsed.activeRun;
    if (t == null || run == null) throw new Error(`task.get 现场缺失：${JSON.stringify(parsed).slice(0, 200)}`);
    const ack = await cmdJson('task.stop', { taskId: m.taskId, targetRunId: run.id, expectedStopGeneration: t.stopGeneration ?? 0 });
    stopAck = { targetRunId: run.id, expectedStopGeneration: t.stopGeneration ?? 0, ack: JSON.stringify(ack).slice(0, 300) };
  } catch (e) {
    console.log(JSON.stringify({ stopped: false, reason: 'stop-request-unreachable', error: String(e).slice(0, 200), note: '观察退出不自动重试/不开新任务；恢复见 continuation' }, null, 2));
    return;
  }
  const TERMINAL = ['CANCELLED', 'FAILED', 'BLOCKED', 'DONE', 'REVIEW'];
  let final = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const st = (await cmdJson('task.get', { taskId: m.taskId }))?.data?.task?.status ?? null;
      final = { taskStatus: st };
      if (st != null && TERMINAL.includes(st)) break;
    } catch { final = { taskStatus: null, note: '观察不可用' }; }
  }
  let crashInjected = null;
  if (process.env.ZS_CRASH_INJECT === '1' && m.electronPid != null && alive(m.electronPid)) {
    try { execSync(`taskkill /PID ${m.electronPid} /T /F`); crashInjected = { pid: m.electronPid, method: 'taskkill-tree' }; } catch { crashInjected = { pid: m.electronPid, method: 'taskkill-failed' }; }
  }
  const explained = final?.taskStatus != null && TERMINAL.includes(final.taskStatus);
  console.log(JSON.stringify({ stopped: explained === true, stopRequestedAt, stopAck, final, crashInjected, residualProcess: m.electronPid != null ? alive(m.electronPid) : null, note: explained === true ? '可解释终态已观察' : '超时未确认：不假装已停止；证据保留在 manifest/DB，恢复走崩溃恢复语义' }, null, 2));
}

// ---------- ledger：本侧台账（从数据库统计——成功/失败/修复/不可排除尝试全部计入） ----------

async function doLedger() {
  const m = loadManifest();
  const db = openSqlite();
  const taskId = m.taskId;
  const turns = db.prepare(
    `SELECT t.id, t.status, t.stage_key FROM agent_turns t WHERE t.dispatch_key LIKE 'task:' || ? || ':%' ORDER BY t.rowid`,
  ).all(taskId) ?? [];
  const usage = db.prepare(
    `SELECT u.turn_id, u.normalized_json FROM usage_records u WHERE u.turn_id IN (SELECT id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%')`,
  ).all(taskId) ?? [];
  const task = db.prepare('SELECT status, stop_generation FROM tasks WHERE id = ?').get(taskId);
  const runs = db.prepare(`SELECT id, status, budget_json FROM workflow_runs WHERE task_id = ? ORDER BY rowid`).all(taskId);
  const repairs = turns.filter((t) => t.stage_key?.startsWith('delib.repair') || (t.stage_key === 'direct.work' && turns.indexOf(t) > 0)).length;
  const ledger = {
    group: m.batch?.group ?? null, side: m.batch?.side ?? null, taskId,
    calls: turns.length, // 调用台账=全部 turn（成功/失败/修复/不可排除尝试）——不因无 usage 报告算零
    turns: turns.map((t) => ({ id: t.id, status: t.status, stage: t.stage_key })),
    repairs,
    usageReported: usage.map((u) => {
      const p = JSON.parse(u.normalized_json);
      return { turnId: u.turn_id, model: p.model ?? null, inputTokens: p.inputTokens ?? null, outputTokens: p.outputTokens ?? null, costQuality: p.costQuality ?? null, estimatedCostUsd: p.estimatedCostUsd ?? p.costUsd ?? null };
    }),
    taskStatus: task?.status ?? null, stopGeneration: task?.stop_generation ?? null,
    runs: runs.map((r) => ({ id: r.id, status: r.status, budget: JSON.parse(r.budget_json ?? 'null') })),
    cap: m.batch?.sideCap ?? null, withinCap: m.batch?.sideCap != null ? turns.length <= m.batch.sideCap : null,
    requestedModel: m.runtime?.requestedModel ?? null,
    reportedModels: [...new Set(usage.map((u) => JSON.parse(u.normalized_json).model).filter(Boolean))],
    note: 'CLI 费用=estimated（渠道账单为准）；请求模型=成员绑定 --model；响应模型=result/assistant 双源',
  };
  db.close();
  console.log(JSON.stringify(ledger, null, 2));
}

// ---------- verify：分组核验 ----------

async function doVerify() {
  const m = loadManifest();
  const db = openSqlite();
  const problems = [];
  const checks = [];
  const add = (name, ok, detail) => { checks.push({ name, ok, detail: detail ?? null }); if (ok === false) problems.push(`${name}: ${detail ?? ''}`); }; // null=不可判定（如早停无 usage）——如实记录不计为缺陷
  // 1) runtime/模型请求：runtime_sessions 能力记录+成员绑定回读+usage 响应模型。
  const expectKind = m.rehearse === true ? 'fake' : 'claude';
  for (const b of m.memberBindings ?? []) {
    const sess = db.prepare('SELECT capabilities_json FROM runtime_sessions WHERE member_id = ? ORDER BY rowid DESC LIMIT 1').get(b.memberId);
    const okBind = b.kind === expectKind && (m.rehearse === true || b.model === m.runtime.requestedModel);
    add(`成员绑定(${b.displayName})=${expectKind}${m.rehearse === true ? '' : `/${m.runtime.requestedModel}`}`, okBind, sess ? 'session 存在' : '无 session 记录');
  }
  const turns = db.prepare(`SELECT id, stage_key, status FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%' ORDER BY rowid`).all(m.taskId) ?? [];
  const usage = db.prepare(`SELECT normalized_json FROM usage_records WHERE turn_id IN (SELECT id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%')`).all(m.taskId) ?? [];
  const reportedModels = [...new Set(usage.map((u) => { try { return JSON.parse(u.normalized_json).model; } catch { return null; } }).filter(Boolean))];
  add('响应模型可核实', reportedModels.length > 0 ? reportedModels.every((mm) => mm === m.runtime.requestedModel) : null, reportedModels.length > 0 ? reportedModels.join(',') : '无响应模型报告（早停/无 usage——如实记录，不算失败）');
  // 2) ContextBundle 归属：本任务 turn 的 bundle 线程=任务线程。
  const task = db.prepare('SELECT conversation_thread_id, status FROM tasks WHERE id = ?').get(m.taskId);
  const bundles = db.prepare(`SELECT b.id, b.thread_id FROM context_bundles b WHERE b.turn_id IN (SELECT id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%')`).all(m.taskId) ?? [];
  add('ContextBundle 线程归属', bundles.every((b) => b.thread_id === task.conversation_thread_id), `${bundles.length} 个 bundle`);
  // 3) 预算对账：runs 预算 usedTurns 与 turn 数一致；不超侧上限。
  const runs = db.prepare(`SELECT id, status, budget_json FROM workflow_runs WHERE task_id = ? ORDER BY rowid`).all(m.taskId);
  if (m.batch?.side === 'delib' && runs.length > 0) {
    const b = JSON.parse(runs[runs.length - 1].budget_json ?? 'null');
    add('预算对账（usedTurns≤runMaxTurns）', b == null ? null : b.usedTurns <= b.runMaxTurns, JSON.stringify(b));
  }
  add('调用数≤侧上限', (m.batch?.sideCap ?? Infinity) >= turns.length, `${turns.length}/${m.batch?.sideCap ?? '∞'}`);
  // 4) 阶段产物归属（delib）：产物 run=本任务 run。
  if (m.batch?.side === 'delib') {
    const arts = db.prepare('SELECT run_id, kind FROM artifacts WHERE task_id = ?').all(m.taskId) ?? [];
    add('产物 run 归属', arts.every((a) => runs.some((r) => r.id === a.run_id)), `${arts.length} 个产物`);
    const rep = db.prepare('SELECT blob_path FROM artifacts WHERE task_id = ? AND kind = ? ORDER BY rowid DESC LIMIT 1').get(m.taskId, 'final_report');
    add('最终报告存在', rep != null, rep?.blob_path ?? null);
  } else {
    const msg = db.prepare(`SELECT count(*) c FROM messages WHERE task_id = ? AND author_type = 'agent'`).get(m.taskId);
    add('DIRECT 最终回复存在', (msg?.c ?? 0) > 0, `agent 消息 ${msg?.c ?? 0} 条`);
    const ok = db.prepare(`SELECT count(*) c FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%' AND status = 'SUCCEEDED'`).get(m.taskId);
    add('TaskComplete 正式校验通过', (ok?.c ?? 0) > 0, `SUCCEEDED turn ${ok?.c ?? 0} 个`);
  }
  // 5) 跨侧隔离抽查：本侧数据库不含其他组/侧的任务。
  const foreign = db.prepare(`SELECT count(*) c FROM tasks WHERE id != ?`).get(m.taskId);
  add('单任务隔离（本侧库仅本任务）', (foreign?.c ?? 0) === 0, `其他任务 ${foreign?.c ?? 0} 个`);
  // 6) fixture 完整性：manifest hash 与磁盘一致（未被模型写入污染资料文件——只读档下）。
  let fixtureOk = true; const fixtureDetail = [];
  for (const f of m.fixture?.files ?? []) {
    const ok = (() => { try { return sha256File(join(PROJ, f.path)) === f.sha256; } catch { return false; } })();
    if (!ok) { fixtureOk = false; fixtureDetail.push(f.path); }
  }
  add('fixture 未被改动', fixtureOk, fixtureDetail.length > 0 ? `已变: ${fixtureDetail.join(',')}` : `${(m.fixture?.files ?? []).length} 文件 hash 一致`);
  db.close();
  console.log(JSON.stringify({ group: m.batch?.group, side: m.batch?.side, ok: problems.length === 0, checks, problems }, null, 2));
  process.exit(problems.length === 0 ? 0 : 3);
}

// ---------- export：导出本侧用户可见交付（DIRECT=最终回复；DELIB=最终报告） ----------

async function doExport() {
  const m = loadManifest();
  const db = openSqlite();
  let text = null;
  let meta = {};
  if ((m.batch?.side ?? 'delib') === 'direct') {
    const rows = db.prepare(`SELECT body_json, created_at FROM messages WHERE task_id = ? AND author_type = 'agent' ORDER BY rowid`).all(m.taskId) ?? [];
    const last = rows[rows.length - 1];
    if (last != null) {
      const body = JSON.parse(last.body_json);
      text = body.text ?? '';
      // TaskComplete JSON 则提取人可读摘要字段（结构化输出照原样保留在 DB——导出给用户看正文）。
      try {
        const tc = JSON.parse(text);
        if (tc.schemaVersion === 'task-complete-v1') {
          text = [tc.changeSummary, '', ...(tc.files ?? []).map((f) => `- ${typeof f === 'string' ? f : JSON.stringify(f)}`)].join('\n');
          meta.parsedTaskComplete = true;
        }
      } catch { /* 纯文本 */ }
    }
    meta.messages = rows.length;
  } else {
    const rep = db.prepare(`SELECT blob_path, hash FROM artifacts WHERE task_id = ? AND kind = 'final_report' ORDER BY rowid DESC LIMIT 1`).get(m.taskId);
    if (rep != null) {
      const payload = JSON.parse(readFileSync(rep.blob_path, 'utf8'));
      meta.artifactHash = rep.hash;
      const lines = [`最终报告（整体共识：${payload.overallConsensus ?? '-'}）`, ''];
      for (const c of payload.claimResults ?? []) {
        lines.push(`- [${c.consensus}] ${c.statement ?? c.claimId}${c.missing > 0 ? `（${c.missing} 人未确认）` : ''}${c.objects > 0 ? `（${c.objects} 人反对）` : ''}`);
      }
      for (const d of payload.disputedClaims ?? []) lines.push(`- 分歧：${d.statement}——${d.disagreementSummary}`);
      text = lines.join('\n');
    }
  }
  db.close();
  if (text == null) { console.error('无可导出交付（任务未完成或无报告）'); process.exit(7); }
  const out = join(ROOT, 'deliverable.txt');
  writeFileSync(out, text, 'utf8');
  console.log(JSON.stringify({ ok: true, out, chars: text.length, ...meta }, null, 2));
}

// ---------- dispatch ----------

const action = args.action;
if (action === 'submit') await doSubmit();
else if (action === 'observe') await doObserve();
else if (action === 'stop') await doStop();
else if (action === 'status') { if (existsSync(MANIFEST)) console.log(readFileSync(MANIFEST, 'utf8')); else console.log('no manifest'); }
else if (action === 'ledger') await doLedger();
else if (action === 'verify') await doVerify();
else if (action === 'export') await doExport();
else { console.error('用法：node scripts/real-delib.mjs submit|observe|stop|status|ledger|verify|export [--group A|B|C] [--side direct|delib] [--task-file <path>] [--runtime claude] [--model deepseek-flash] [--rehearse]'); process.exit(64); }
