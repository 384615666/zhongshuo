/*
 * R91 整体验证（模块3 · 整体夹具/脚本准备，不属于产品功能）。
 *
 * 流程：
 *   1) 只读候选包（官方 BAT 隔离包），复制到自己的临时目录；
 *   2) 用真实 daemon 命令面 + FakeRuntimeAdapter + DispatchWorker 准备合成夹具：
 *      两成员独立研讨的阶段产物 + 真实 xlsx/csv/txt 生成文件快照 + 一个待推进的实时研讨请求；
 *   3) 用官方 `start-desktop.bat`（R78 工程入口：token/daemon entry/debug port）在
 *      **次屏**（ZS_TEST_DISPLAY，绝不主屏）打开隔离副本；工程 daemon 只注入 Fake adapter，
 *      零真实模型调用；
 *   4) 隐藏 CDP 驱动验证：原串阶段消息（正确作者/标签/轮次/顺序）、文件卡位置与点击预览、
 *      另存原文件 sha256、实时阶段更新期间输入稳定性/IME/选区、线程↔DM 独立草稿、重开保持；
 *   5) 证据写入 dist/review-r91-package-20261019/。
 *
 * 用法：
 *   node scripts/verify-r91-package.cjs --package <candidate-dir> [--out <dir>] [--dry-run] [--r93-detail]
 *   node scripts/verify-r91-package.cjs --package <candidate-dir> --prepare-only
 *
 * 退出码：0=全部检查通过；1=有检查失败；2=宿主/夹具/环境前置失败（含无次屏）。
 * 注：真实全流程需要最终冻结 BUILD；本脚本当前可先跑 --dry-run / --prepare-only 静态检查，
 *     不打开可见窗口、不占主屏/鼠标键盘/剪贴板。
 */
/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { buildSync } = require('esbuild');
const { Cdp } = require('./verify-r81-members-launcher.cjs');

const repoRoot = path.resolve(__dirname, '..');
const q = JSON.stringify;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const shaFile = (file) => sha256(fs.readFileSync(file));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith('--')) throw new Error(`未知参数：${value}`);
    const key = value.slice(2);
    if (['dry-run', 'prepare-only', 'keep-copy', 'skip-manifest', 'r93-detail'].includes(key)) { flags.add(key); continue; }
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) throw new Error(`参数缺少值：${value}`);
    values.set(key, next);
    i += 1;
  }
  const packageArg = values.get('package') ?? process.env.R91_PACKAGE_ROOT ?? 'dist/desktop/desktop-daily-win-v26-r90-final6-20261018';
  const packageRoot = path.resolve(repoRoot, packageArg);
  const outDir = path.resolve(repoRoot, values.get('out') ?? 'dist/review-r91-package-20261019');
  return { packageRoot, outDir, dryRun: flags.has('dry-run'), prepareOnly: flags.has('prepare-only'), keepCopy: flags.has('keep-copy'), skipManifest: flags.has('skip-manifest'), r93Detail: flags.has('r93-detail') };
}

function must(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function timestampId() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${process.pid}`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function copytree(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (from) => {
      const relative = path.relative(source, from);
      return relative !== 'server-data' && !relative.startsWith('server-data' + path.sep);
    },
  });
  must(!fs.existsSync(path.join(destination, 'server-data')), '隔离副本不应复制候选包的 server-data（避免带入真实用户数据）');
}

function repoElectron() {
  const resolved = require('electron');
  if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  const pathFile = path.join(repoRoot, 'node_modules', 'electron', 'path.txt');
  const executable = fs.readFileSync(pathFile, 'utf8').trim();
  return path.join(repoRoot, 'node_modules', 'electron', 'dist', executable);
}

function manifestCheck(packageDir) {
  const manifestPath = path.join(packageDir, 'ZhongshuoDual', 'MANIFEST-SHA256.json');
  const buildPath = path.join(packageDir, 'ZhongshuoDual', 'BUILD.json');
  const build = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = Array.isArray(manifest) ? manifest : manifest.files;
  must(Array.isArray(entries) && entries.length > 0, '候选包 MANIFEST-SHA256.json 无文件清单');
  let checked = 0;
  const failures = [];
  for (const entry of entries) {
    const file = path.join(packageDir, 'ZhongshuoDual', String(entry.path).replaceAll('/', path.sep));
    try {
      const stat = fs.statSync(file);
      if (stat.size !== entry.bytes || shaFile(file) !== entry.sha256) failures.push(entry.path);
      checked += 1;
    } catch {
      failures.push(entry.path);
    }
  }
  return { build, checked, failures: failures.slice(0, 20), failureCount: failures.length, manifestPath, buildPath };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function probeDisplays(workDir) {
  const probeFile = path.join(workDir, 'display-probe.cjs');
  const output = path.join(workDir, 'display-probe.json');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(probeFile, [
    "'use strict';",
    "const { app, screen } = require('electron');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const profile = process.env.ZS_R91_PROBE_PROFILE;',
    "fs.mkdirSync(path.join(profile, 'user-data'), { recursive: true });",
    "fs.mkdirSync(path.join(profile, 'session-data'), { recursive: true });",
    "app.setPath('userData', path.join(profile, 'user-data'));",
    "app.setPath('sessionData', path.join(profile, 'session-data'));",
    'app.disableHardwareAcceleration();',
    'app.whenReady().then(() => {',
    "  const displays = screen.getAllDisplays().map((d) => ({ id: d.id, label: d.label, bounds: d.bounds, workArea: d.workArea }));",
    "  fs.writeFileSync(process.env.ZS_R91_PROBE_OUT, JSON.stringify({ displays, primaryId: screen.getPrimaryDisplay().id }, null, 2));",
    '  app.quit();',
    '});',
  ].join('\n'), 'utf8');
  const env = { ...process.env, ZS_R91_PROBE_PROFILE: path.join(workDir, 'profile'), ZS_R91_PROBE_OUT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(repoElectron(), [probeFile], { cwd: repoRoot, env, windowsHide: true, timeout: 60_000, stdio: 'ignore' });
  if (!fs.existsSync(output)) throw new Error(`次屏探测失败（electron exit=${child.status}）`);
  return readJson(output);
}

function chooseSecondaryDisplay(probe, requested) {
  const primaryId = probe.primaryId;
  const candidates = probe.displays.filter((display) => display.id !== primaryId);
  if (candidates.length === 0) throw new Error('未找到副屏：全 APP 可见验证拒绝使用主屏（请配置 ZS_TEST_DISPLAY 或接入次屏）');
  if (requested != null && requested.trim().length > 0) {
    const wanted = requested.trim();
    const hit = probe.displays.find((display) => String(display.id) === wanted
      || (display.label && display.label.toUpperCase().includes(wanted.toUpperCase())));
    must(hit, `ZS_TEST_DISPLAY=${wanted} 未匹配到显示器`);
    must(hit.id !== primaryId, 'ZS_TEST_DISPLAY 指向主屏：可见验证拒绝使用主屏');
    return hit;
  }
  return candidates[0];
}

function boundsWithin(display) {
  const work = display.workArea ?? display.bounds;
  const width = Math.max(900, Math.min(1280, work.width - 120));
  const height = Math.max(640, Math.min(860, work.height - 120));
  return {
    x: work.x + Math.round((work.width - width) / 2),
    y: work.y + Math.round((work.height - height) / 2),
    width,
    height,
  };
}

function engineeringEntrySource() {
  return String.raw`'use strict';
const { createRequire } = require('node:module');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FakeRuntimeAdapter } = require(__FAKE_ADAPTER__);

const appDataDir = process.env.ZS_APP_DATA;
if (appDataDir == null || appDataDir.length === 0) throw new Error('R91 engineering daemon requires ZS_APP_DATA');
const data = path.resolve(appDataDir);
const packageRoot = path.resolve(data, '..', 'ZhongshuoDual');
const packedEntry = path.join(packageRoot, 'resources', 'app', 'daemon', 'daemon.cjs');
const buildFile = path.join(packageRoot, 'BUILD.json');
const markerFile = path.join(data, 'engineering-r78.json');
const pidPath = path.join(data, 'daemon.pid');
const readyPath = path.join(data, 'engineering', 'ready.json');
for (const file of [packedEntry, buildFile, markerFile]) if (!fs.existsSync(file)) throw new Error('R91 engineering daemon missing ' + file);
const build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
const samePath = (a, b) => process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;
if (!samePath(marker.appDataDir, data) || !samePath(marker.daemonEntry, path.resolve(process.argv[1] || ''))) throw new Error('R91 engineering marker path mismatch');
if (marker.token == null || marker.token.length < 32 || process.env.ZS_R78_ENGINEERING_TOKEN !== marker.token) throw new Error('R91 engineering marker token mismatch');

const STALL_MS = 4000;
let daemon = null;
let shutdownStarted = false;
function db() { return daemon == null ? null : daemon.db; }
function latestRun() {
  const handle = db();
  if (handle == null) return null;
  const row = handle.prepare("SELECT id, task_id FROM workflow_runs WHERE mode='DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY rowid DESC LIMIT 1").get();
  return row == null ? null : { id: row.id, taskId: row.task_id };
}
function runningMember() {
  const handle = db();
  if (handle == null) return null;
  const row = handle.prepare("SELECT member_id FROM agent_turns WHERE status IN ('PENDING','DISPATCHING','RUNNING') ORDER BY rowid DESC LIMIT 1").get();
  return row == null ? null : row.member_id;
}
function done(payload) {
  return [
    { kind: 'stall', ms: STALL_MS },
    { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify(payload) } },
  ];
}
function failed(code, message) {
  return [{ kind: 'event', event: { kind: 'turn.failed', code: code, message: message, retryable: false } }];
}
function sequencer(input) {
  const text = input.text || '';
  if (text.indexOf('"schemaVersion":"analysis-draft-v1"') >= 0) {
    return done({
      schemaVersion: 'analysis-draft-v1',
      summary: 'R91 实时合成独立分析：方案 A 成本更低但交付期偏长（Fake adapter，非真实模型）。',
      claims: [
        { claimId: 'r91_live_c1', statement: '方案 A 合成成本更低', kind: 'observed', evidenceIds: ['r91_live_ev1'], uncertainty: '合成数据' },
        { claimId: 'r91_live_c2', statement: '方案 A 合成交付期更长', kind: 'inferred', evidenceIds: ['r91_live_ev2'] },
      ],
      recommendations: ['补充合成对照'],
      openQuestions: ['交付期差异是否可接受'],
    });
  }
  if (text.indexOf('"schemaVersion":"cross-review-v1"') >= 0) {
    const run = latestRun();
    if (run == null) return failed('R91_LIVE_NO_RUN', '实时合成研讨缺少运行');
    const handle = db();
    const drafts = handle.prepare("SELECT id, author_id, revision, blob_path FROM artifacts WHERE run_id=? AND kind='analysis_draft' ORDER BY rowid").all(run.id);
    const reviewer = runningMember();
    const target = drafts.find((draft) => reviewer == null || draft.author_id !== reviewer) || drafts[0];
    let claimId = 'r91_live_c1';
    if (target != null) {
      try {
        const parsed = JSON.parse(fs.readFileSync(target.blob_path, 'utf8'));
        claimId = (parsed.claims && parsed.claims[0] && parsed.claims[0].claimId) || claimId;
      } catch (e) { /* synthetic fixture claim id fallback */ }
    }
    return done({
      schemaVersion: 'cross-review-v1',
      reviews: [{
        targetArtifactId: target == null ? '' : target.id,
        targetRevision: target == null ? 1 : target.revision,
        targetClaimId: claimId,
        stance: 'disagree',
        reason: '实时合成互评：证据来自合成样本，需独立复核。',
        evidenceIds: ['r91_live_ev3'],
        suggestedVerification: '补一组合成对照',
      }],
    });
  }
  if (text.indexOf('"schemaVersion":"issue-position-v1"') >= 0) {
    const run = latestRun();
    const handle = db();
    const issue = run == null || handle == null ? null : handle.prepare('SELECT id FROM issues WHERE run_id=? ORDER BY id LIMIT 1').get(run.id);
    return done({
      schemaVersion: 'issue-position-v1',
      positions: [{
        issueId: issue == null ? 'r91_live_issue' : issue.id,
        stance: 'needs_evidence',
        reason: '实时合成争议讨论：保留分歧，整合稿如实记录。',
        newEvidence: [],
      }],
    });
  }
  if (text.indexOf('"schemaVersion":"checkpoint-verdict-v1"') >= 0) {
    return done({ schemaVersion: 'checkpoint-verdict-v1', verdict: 'stop', reason: '实时合成检查点：无新增证据。' });
  }
  if (text.indexOf('"schemaVersion":"synthesis-v1"') >= 0) {
    return done({
      schemaVersion: 'synthesis-v1',
      summary: 'R91 实时合成整合结论：方案 A 成本更低、方案 B 交付更快；分歧保留。',
      claims: [
        { statement: '方案 A 合成成本更低', sourceRefs: ['r91_live_c1'] },
        { statement: '方案 B 合成交付更快', sourceRefs: ['r91_live_c2'] },
      ],
      disputedClaims: [{ statement: '交付期差异是否可接受', disagreementSummary: '合成互评认为证据不足。', sourceRefs: ['r91_live_c2'] }],
      recommendations: ['补充合成对照后再决策'],
    });
  }
  if (text.indexOf('"schemaVersion":"ratify-v1"') >= 0) {
    const run = latestRun();
    const handle = db();
    const claims = run == null || handle == null ? [] : handle.prepare('SELECT claim_id FROM synthesis_claims WHERE run_id=? ORDER BY claim_id').all(run.id);
    const rows = claims.length > 0 ? claims : [{ claim_id: 'r91_live_c1' }, { claim_id: 'r91_live_c2' }];
    return done({
      schemaVersion: 'ratify-v1',
      responses: rows.map((claim, index) => ({
        claimId: claim.claim_id,
        stance: index === 1 ? 'conditional' : 'confirm',
        conditions: index === 1 ? ['补充合成对照'] : undefined,
        reason: '实时合成确认。',
      })),
    });
  }
  return failed('R91_LIVE_UNSCRIPTED', '实时合成 daemon 遇到未知输入：' + text.slice(0, 120));
}

async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  if (daemon == null) return;
  try {
    const realCalls = daemon.db.prepare('SELECT count(*) c FROM real_calls').get().c;
    let stop = await daemon.stop();
    if (!stop.complete) stop = await daemon.stop({ force: true });
    try { fs.rmSync(pidPath, { force: true }); } catch (e) { /* diagnostic only */ }
    try { fs.rmSync(readyPath, { force: true }); } catch (e) { /* diagnostic only */ }
    process.stderr.write('[zhongshuo-daemon] stop-result ' + JSON.stringify({ complete: stop.complete, phase: stop.phase, realCalls: realCalls, forced: stop.phase === 'forced-closed' }) + '\n');
    process.exit(stop.complete && realCalls === 0 ? 0 : 3);
  } catch (error) {
    process.stderr.write('[r91-engineering-daemon] stop failed: ' + (error && error.stack ? error.stack : String(error)) + '\n');
    process.exit(3);
  }
}
function requestShutdown() { setTimeout(() => { void shutdown(); }, 250); }
process.on('SIGINT', requestShutdown);
process.on('SIGTERM', requestShutdown);

void (async () => {
  // 必须使用注入的 Fake adapter 工厂：不设置 ZS_ALLOW_FAKE，避免 entry 用默认 fake 编排
  // 覆盖本工程的带停延脚本；不设真实派发防护（工厂仍是 Fake，绝无真实请求）。
  delete process.env.ZS_PACKED_ENTRY;
  delete process.env.ZS_ALLOW_FAKE;
  delete process.env.ZS_REAL_DISPATCH_GUARD;
  process.env.ZS_RUNTIME = 'fake';
  process.env.ZS_APP_MODE = 'fake-sim';
  const requirePacked = createRequire(packedEntry);
  const packed = requirePacked(packedEntry);
  if (typeof packed.startDaemon !== 'function') throw new Error('candidate packaged daemon does not export startDaemon');
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: sequencer });
  daemon = await packed.startDaemon({
    appDataDir: data,
    runtime: 'fake',
    pipeName: process.env.ZS_PIPE_NAME,
    tickMs: 700,
    testAdapter: adapter,
    testAdapterFactories: { fake: function () { return adapter; } },
    standaloneShutdown: requestShutdown,
  });
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  fs.mkdirSync(path.dirname(readyPath), { recursive: true });
  fs.writeFileSync(readyPath, JSON.stringify({
    buildId: build.buildId, packedEntry: packedEntry, appDataDir: data, pipeName: daemon.pipeName, pid: process.pid,
    fakeAdapterInjected: true, realDispatchGuard: false, purpose: 'R91 fake/synthetic live stage updates', at: Date.now(),
  }, null, 2), 'utf8');
  process.stderr.write('[r91-engineering-daemon] listening ' + daemon.pipeName + ' build=' + build.buildId + ' fake-synthetic\n');
})().catch((error) => {
  process.stderr.write('[r91-engineering-daemon] startup failed: ' + (error && error.stack ? error.stack : String(error)) + '\n');
  process.exit(1);
});
`;
}

function prepareEngineeringDaemon(copyDir, runDir) {
  const engineeringDir = path.join(copyDir, 'server-data', 'engineering');
  fs.mkdirSync(engineeringDir, { recursive: true });
  const entryPath = path.join(engineeringDir, 'r91-engineering-daemon.cjs');
  const sourcePath = path.join(runDir, 'engineering-entry.cjs');
  const fakeAdapterPath = path.resolve(repoRoot, 'src', 'adapter', 'fake', 'runtimeAdapter.ts').replaceAll('\\', '/');
  fs.writeFileSync(sourcePath, engineeringEntrySource().replace('__FAKE_ADAPTER__', JSON.stringify(fakeAdapterPath)), 'utf8');
  buildSync({
    entryPoints: [sourcePath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    absWorkingDir: repoRoot,
    nodePaths: [path.join(repoRoot, 'node_modules')],
    outfile: entryPath,
    sourcemap: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const token = crypto.randomBytes(32).toString('hex');
  const markerPath = path.join(copyDir, 'server-data', 'engineering-r78.json');
  fs.writeFileSync(markerPath, JSON.stringify({
    token, appDataDir: path.resolve(copyDir, 'server-data'), daemonEntry: entryPath,
    purpose: 'R91 verification only (Fake adapter, real_calls=0)', createdAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  return { engineeringDir, entryPath, token, markerPath };
}

function runFixturePreparation(copyDir, runDir, r93Detail = false) {
  const prepareScript = path.join(repoRoot, 'scripts', 'prepare-r91-visible-fixture.ts');
  must(fs.existsSync(prepareScript), `夹具脚本缺失：${prepareScript}`);
  const logFile = path.join(runDir, 'fixture-prep.log');
  const child = spawnSync(process.execPath, [
    '--experimental-strip-types', prepareScript,
    '--root', runDir,
    '--app-data', path.join(copyDir, 'server-data'),
    '--project', path.join(runDir, 'project'),
    '--report', path.join(runDir, 'fixture.json'),
    '--no-live',
    ...(r93Detail ? ['--r93-detail'] : []),
  ], { cwd: repoRoot, env: { ...process.env }, encoding: 'utf8', timeout: 180_000, windowsHide: true });
  fs.writeFileSync(logFile, `${child.stdout ?? ''}\n${child.stderr ?? ''}`, 'utf8');
  if (child.status !== 0) throw new Error(`夹具准备失败（exit=${child.status}）：${(child.stderr ?? '').slice(-800)}`);
  return readJson(path.join(runDir, 'fixture.json'));
}

async function waitFor(fn, good, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await fn(); } catch (error) { last = error instanceof Error ? error.message : String(error); }
    if (good(last)) return last;
    if (Date.now() > deadline) throw new Error(`${label} 超时：${JSON.stringify(last)?.slice(0, 200)}`);
    await sleep(250);
  }
}

async function fetchJsonList(port) {
  try {
    return await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) }).then((response) => response.json());
  } catch {
    return [];
  }
}

async function connectCdp(port, label) {
  return waitFor(async () => {
    try {
      const rows = await fetchJsonList(port);
      const page = rows.find((row) => row.type === 'page' && row.url.includes('index.html'));
      if (page == null) return null;
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      const client = new Cdp(ws);
      await client.send('Runtime.enable');
      await client.send('Page.enable');
      await client.send('DOM.enable');
      await waitFor(() => client.eval('document.body?.classList.contains("hifi-on")'), Boolean, `${label} hifi shell`, 45_000);
      return client;
    } catch {
      return null;
    }
  }, Boolean, `${label} CDP`, 120_000);
}

function processCountUnder(root) {
  const prefix = (root + path.sep).replaceAll("'", "''");
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}',[StringComparison]::OrdinalIgnoreCase) }).Count`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const value = Number((result.stdout ?? '').trim());
  return Number.isFinite(value) ? value : 0;
}

function killProcessesUnder(root) {
  const prefix = (root + path.sep).replaceAll("'", "''");
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${prefix}',[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function readRuntimeFacts(appDataDir) {
  const db = new Database(path.join(appDataDir, 'state.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const one = (sql, params = []) => db.prepare(sql).get(...params) ?? null;
    const all = (sql, params = []) => db.prepare(sql).all(...params);
    return {
      realCalls: one('SELECT count(*) n FROM real_calls').n,
      stageMessages: one("SELECT count(*) n FROM messages WHERE id LIKE 'msg_delib_%'").n,
      generatedAttachments: one("SELECT count(*) n FROM artifacts WHERE id LIKE 'art_gf_%'").n,
      messageAttachments: all("SELECT ma.message_id, a.id AS artifact_id, a.source_name, a.kind, a.hash, a.blob_path FROM message_attachments ma JOIN artifacts a ON a.id=ma.artifact_id WHERE a.id LIKE 'art_gf_%'"),
      tasks: all('SELECT id, status FROM tasks ORDER BY rowid'),
      runs: all('SELECT id, status, stage FROM workflow_runs ORDER BY rowid'),
    };
  } finally {
    db.close();
  }
}

function readLiveRequestFacts(appDataDir, messageId) {
  try {
    const db = new Database(path.join(appDataDir, 'state.sqlite'), { readonly: true, fileMustExist: true });
    try {
      const request = db.prepare('SELECT message_id, status, run_id, turn_id, error_message FROM thread_reply_requests WHERE message_id = ?').get(messageId) ?? null;
      const run = request?.run_id != null
        ? db.prepare('SELECT id, status, mode, stage, task_id FROM workflow_runs WHERE id = ?').get(request.run_id) ?? null
        : null;
      const stageMessages = (db.prepare("SELECT count(*) AS n FROM messages WHERE id LIKE 'msg_delib_%'").get() ?? { n: 0 }).n;
      const threadMessages = (db.prepare('SELECT count(*) AS n FROM messages WHERE thread_id IS NOT NULL').get() ?? { n: 0 }).n;
      return { request, run, stageMessages, threadMessages };
    } finally {
      db.close();
    }
  } catch (error) {
    return { error: String(error) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.outDir;
  const runId = timestampId();
  const runDir = path.join(outDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const saveAsDir = path.join(runDir, 'saveas');
  fs.mkdirSync(saveAsDir, { recursive: true });
  const result = {
    format: 'r91-package-verification-v1',
    ok: false,
    phase: 'start',
    synthetic: true,
    fakeRuntime: true,
    realModelCalls: 0,
    packageSource: args.packageRoot,
    outDir,
    runDir,
    checks: [],
    facts: {},
    screenshots: [],
    startedAt: new Date().toISOString(),
  };
  let cdp = null;
  let copyDir = null;
  let launcher = null;
  let launchEnv = null;
  const check = (name, ok, detail) => {
    result.checks.push({ name, ok: !!ok, detail: ok ? undefined : (detail == null ? null : String(detail)) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail == null ? '' : ` — ${String(detail).slice(0, 300)}`}`);
    return !!ok;
  };
  const screenshot = async (name) => {
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(runDir, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      result.screenshots.push({ name, file, bytes: fs.statSync(file).size });
      return file;
    } catch (error) {
      result.screenshots.push({ name, error: String(error) });
      return null;
    }
  };
  const save = () => {
    result.endedAt = new Date().toISOString();
    result.ok = result.error == null && result.checks.length > 0 && result.checks.every((entry) => entry.ok);
    writeJson(path.join(runDir, 'result.json'), result);
    try { fs.copyFileSync(path.join(runDir, 'result.json'), path.join(outDir, 'latest-result.json')); } catch { /* add-only evidence */ }
  };

  const appCommand = async (method, params = {}) => {
    const envelope = { protocolVersion: 1, commandId: `r91-pkg-${Date.now()}-${Math.random()}`, method, params };
    const response = await cdp.eval(`window.zs.command(${q(envelope)})`);
    must(response && response.ok, `${method}: ${JSON.stringify(response && response.error)}`);
    return response.data;
  };
  const navigate = async (hash, selector, label) => {
    await cdp.eval(`location.hash=${q(hash)};true`);
    await waitFor(() => cdp.eval(`document.querySelector(${q(selector)})!=null`), Boolean, label ?? hash, 60_000);
    await sleep(400);
  };
  const stageTagCount = () => cdp.eval(`(() => { const scope = ${threadScopeExpr}; return scope == null ? 0 : scope.querySelectorAll('.msg-stage-tag').length; })()`);
  const threadHash = (fixture) => `/project/${fixture.projectId}/room/${fixture.roomId}?thread=${encodeURIComponent(fixture.threadId)}`;

  const threadScopeExpr = `(() => document.querySelector('.col-thread .msg-list') || document.querySelector('.thread-nav .msg-list') || document.querySelector('.col-thread') || document.querySelector('.thread-nav') || null)()`;
  const collectMessages = () => cdp.eval(`(() => { const scope = ${threadScopeExpr}; if (scope == null) return []; return Array.from(scope.querySelectorAll('.msg')).map((el) => {
    const rawId = el.id || '';
    const stage = el.querySelector('.msg-stage-tag');
    const text = el.querySelector('.msg-text');
    const attachments = el.querySelector('.msg-inline-attachments');
    const footer = el.querySelector('.msg-attachment-footer');
    const fold = el.querySelector('.msg-fold');
    const textRect = text?.getBoundingClientRect() ?? null;
    const footerRect = footer?.getBoundingClientRect() ?? null;
    const foldRect = fold?.getBoundingClientRect() ?? null;
    const chips = Array.from(el.querySelectorAll('[data-zs-inline-attachments] [data-zs-artifact-id]')).map((chip) => ({
      artifactId: chip.getAttribute('data-zs-artifact-id'),
      text: (chip.textContent || '').trim(),
      detail: chip.classList.contains('is-detail'),
    }));
    return {
      id: rawId.startsWith('thread-msg-') ? rawId.slice('thread-msg-'.length) : rawId.startsWith('msg-') ? rawId.slice(4) : rawId,
      domId: rawId,
      author: (el.querySelector('.msg-author')?.textContent || '').trim(),
      stage: (stage?.textContent || '').trim(),
      stageTagCount: el.querySelectorAll('.msg-stage-tag').length,
      seq: (el.querySelector('.msg-seq')?.textContent || '').trim(),
      text: (text?.textContent || '').trim(),
      hasAttachments: attachments != null,
      bodyBeforeAttachments: !!(text && footer && (text.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING)
        && textRect && footerRect && footerRect.top >= textRect.bottom - 1),
      attachmentsInFooter: !!(attachments && footer && attachments.closest('.msg-attachment-footer') === footer),
      attachmentsAfterFold: !!(!fold || (footerRect && foldRect && footerRect.top >= foldRect.bottom - 1)),
      chips,
    };
  }); })()`);

  const brief = (value, limit = 12_000) => {
    let text;
    try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  const captureThreadDiagnostics = async (fixture, label) => {
    try {
      const dom = await cdp.eval(`(() => ({
        hash: location.hash,
        title: document.title,
        boot: document.querySelector('[data-zs-boot-phase]')?.getAttribute('data-zs-boot-phase') ?? null,
        conn: document.querySelector('[data-zs-connection-phase]')?.getAttribute('data-zs-connection-phase') ?? null,
        threadNav: !!document.querySelector('.thread-nav'),
        msgList: !!document.querySelector('.msg-list'),
        messages: document.querySelectorAll('.msg').length,
        stageTags: document.querySelectorAll('.msg-stage-tag').length,
        composer: !!document.querySelector('.composer-editor'),
        messageDomIds: [...document.querySelectorAll('.msg')].slice(0, 20).map((el) => el.id),
        panels: [...document.querySelectorAll('.panel.info, [role="alert"], .toast')].map((el) => (el.textContent || '').trim()).slice(0, 15),
        bodyText: (document.body.innerText || '').slice(0, 5_000),
      }))()`);
      const safeCommand = async (method, params) => { try { return { ok: true, data: await appCommand(method, params) }; } catch (error) { return { ok: false, error: String(error) }; } };
      const threadGet = await safeCommand('thread.get', { threadId: fixture.threadId });
      const threadHistory = await safeCommand('thread.history', { threadId: fixture.threadId, limit: 50 });
      const roomList = await safeCommand('room.list', { projectId: fixture.projectId });
      const projectList = await safeCommand('project.list', {});
      const taskGet = fixture.taskId != null ? await safeCommand('task.get', { taskId: fixture.taskId }) : null;
      result.facts.threadFailureDiagnostics = {
        label, at: new Date().toISOString(),
        dom,
        threadGet: brief(threadGet), threadHistory: brief(threadHistory),
        roomList: brief(roomList), projectList: brief(projectList), taskGet: brief(taskGet),
      };
      await screenshot(`02a-${label}-failure`);
    } catch (error) {
      result.facts.threadFailureDiagnostics = { label, error: String(error) };
    }
  };
  const openThreadPage = async (fixture, label) => {
    const hash = threadHash(fixture);
    const roomHash = `/project/${fixture.projectId}/room/${fixture.roomId}`;
    await cdp.eval(`location.hash=${q(roomHash)};true`);
    await waitFor(() => cdp.eval(`location.hash.includes(${q(fixture.roomId)})`), Boolean, `${label} room hash`, 20_000);
    await waitFor(() => cdp.eval(`document.querySelector('.root-card')!=null`), Boolean, `${label} room-pool cards`, 30_000);
    const marker = fixture.rootMessagePreview ?? 'R91 合成研讨请求';
    const clicked = await cdp.eval(`(() => { const cards = [...document.querySelectorAll('.root-card')]; const card = cards.find((el) => (el.textContent || '').includes(${q(marker)})); if (!card) return false; card.click(); return true; })()`);
    result.facts[`${label}OpenMethod`] = clicked ? 'room-pool-card-click' : 'direct-thread-hash-fallback';
    if (!clicked) await cdp.eval(`location.hash=${q(hash)};true`);
    await waitFor(() => cdp.eval(`location.hash.includes(${q(fixture.threadId)})`), Boolean, `${label} thread hash`, 20_000);
    await waitFor(() => cdp.eval(`document.querySelector('.col-thread, .thread-nav')!=null`), Boolean, `${label} ThreadRegion`, 30_000);
    await waitFor(() => cdp.eval(`(() => { const scoped = document.querySelector('.col-thread .composer-editor[contenteditable="true"]'); if (scoped != null) return true; return [...document.querySelectorAll('.composer-editor[contenteditable="true"]')].some((el) => (el.getAttribute('data-placeholder') || '').startsWith('跟进当前任务')); })()`), Boolean, `${label} thread-scoped composer`, 30_000);
    result.facts[`${label}Load`] = await cdp.eval(`(() => ({ hash: location.hash, threadRegion: !!document.querySelector('.col-thread, .thread-nav'), msgList: !!document.querySelector('.msg-list'), messages: document.querySelectorAll('.msg').length, stageTags: document.querySelectorAll('.msg-stage-tag').length }))()`);
  };

  try {
    // ---------- 静态前置检查 ----------
    result.phase = 'preflight';
    must(fs.existsSync(args.packageRoot), `候选包不存在：${args.packageRoot}`);
    const batPath = path.join(args.packageRoot, 'start-desktop.bat');
    must(fs.existsSync(batPath), `候选包缺少官方 BAT：${batPath}`);
    const buildPath = path.join(args.packageRoot, 'ZhongshuoDual', 'BUILD.json');
    must(fs.existsSync(buildPath), '候选包缺少 BUILD.json');
    const build = readJson(buildPath);
    const batSha256 = shaFile(batPath);
    result.facts.package = { source: args.packageRoot, batPath: 'start-desktop.bat', batSha256, build };
    if (args.dryRun) {
      result.phase = 'dry-run';
      const prepareScript = path.join(repoRoot, 'scripts', 'prepare-r91-visible-fixture.ts');
      check('candidate package + official BAT present', fs.existsSync(batPath));
      check('candidate BUILD.json readable', build.buildId != null);
      check('fixture preparation script present', fs.existsSync(prepareScript));
      check('verification evidence dir writable', (() => { try { fs.writeFileSync(path.join(runDir, '.write-test'), 'ok'); fs.rmSync(path.join(runDir, '.write-test')); return true; } catch { return false; } })());
      result.phase = 'dry-run-complete';
      save();
      console.log(JSON.stringify({ ok: result.ok, phase: result.phase, package: args.packageRoot, build, runDir }, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    result.phase = 'copy-package';
    copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-r91-package-copy-'));
    copytree(args.packageRoot, copyDir);
    result.facts.packageCopy = copyDir;
    check('isolated package copy created (server-data excluded)', fs.existsSync(copyDir) && !fs.existsSync(path.join(copyDir, 'server-data')));
    fs.mkdirSync(path.join(copyDir, 'server-data'), { recursive: true });
    if (!args.skipManifest) {
      const manifest = manifestCheck(copyDir);
      result.facts.manifest = { checked: manifest.checked, failureCount: manifest.failureCount, failures: manifest.failures };
      check('candidate manifest SHA256 verified in isolated copy', manifest.failureCount === 0, `${manifest.failureCount} mismatches`);
    }

    result.phase = 'prepare-fixture';
    const fixture = runFixturePreparation(copyDir, runDir, args.r93Detail);
    result.facts.fixture = fixture;
    check('fixture built by real daemon chain (synthetic/fake)', fixture.synthetic === true && fixture.dedicatedFakeRuntime === true);
    check('fixture zero real model calls', fixture.assertions && fixture.assertions.realCalls === 0);
    if (args.r93Detail) check('fixture has one actual hosted R93 detail Markdown', fixture.detailAttachment != null && fixture.detailAttachment.kind === 'text_file', q(fixture.detailAttachment));
    check('fixture has stage products (IND/CR/ISS/SYN/RAT)', ['INDEPENDENT', 'CROSS_REVIEW', 'ISSUE_DISCUSSION', 'SYNTHESIS', 'RATIFY'].every((stage) => (fixture.assertions?.stageSet ?? []).includes(stage)), q(fixture.assertions?.stageSet));
    check('fixture has 3 guarded xlsx/csv/txt snapshot attachments', fixture.generatedFiles.length === 3 && fixture.assertions.generatedFiles === 3);
    check('fixture prepared without startup recovery queue (--no-live)', fixture.liveMessageId == null && fixture.assertions?.liveRequestQueued === false);

    result.phase = 'prepare-engineering-daemon';
    const engineering = prepareEngineeringDaemon(copyDir, runDir);
    result.facts.engineering = { entryPath: engineering.entryPath, markerPath: engineering.markerPath, tokenSha256: sha256(engineering.token) };
    check('engineering r78 entry bundled for copied official package', fs.existsSync(engineering.entryPath));
    const engineeringSyntax = spawnSync(process.execPath, ['--check', engineering.entryPath], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    check('engineering r78 entry syntax valid in packaged-node runtime', engineeringSyntax.status === 0, (engineeringSyntax.stderr ?? '').slice(-500));
    const engineeringText = fs.readFileSync(engineering.entryPath, 'utf8');
    check('engineering r78 entry has Fake adapter bundled (no unresolved placeholder)', !engineeringText.includes('__FAKE_ADAPTER__') && engineeringText.includes('FakeRuntimeAdapter'));
    if (args.prepareOnly) {
      result.phase = 'prepare-only-complete';
      result.facts.prepareOnly = {
        copyDir: args.keepCopy ? copyDir : '<removed after validation>',
        fixtureReport: path.join(runDir, 'fixture.json'),
        fixtureProjectId: fixture.projectId,
        fixtureThreadId: fixture.threadId,
        stageMessages: fixture.stageMessages.length,
        generatedFiles: fixture.generatedFiles.length,
        generatedMustHash: fixture.generatedFiles.map((file) => ({ filename: file.filename, sha256: file.sha256, bytes: file.bytes })),
        engineeringEntry: args.keepCopy ? engineering.entryPath : '<removed with isolated copy>',
        launcherWouldUse: 'start-desktop.bat (R78 engineering token/entry/debug-port)',
      };
      save();
      console.log(JSON.stringify({ ok: result.ok, phase: result.phase, runDir, prepareOnly: result.facts.prepareOnly }, null, 2));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    const displays = await probeDisplays(path.join(runDir, 'display-probe'));
    result.facts.displays = displays;
    const display = chooseSecondaryDisplay(displays, process.env.ZS_TEST_DISPLAY);
    const bounds = boundsWithin(display);
    result.facts.placementPlan = { display: { id: display.id, label: display.label, bounds: display.bounds, workArea: display.workArea }, bounds };
    check('verification uses a non-primary display', display.id !== displays.primaryId, `display=${display.id} primary=${displays.primaryId}`);

    const port = await freePort();
    const placementFile = path.join(runDir, 'placement.json');
    const readyFile = path.join(copyDir, 'server-data', 'engineering', 'ready.json');
    const launcherLog = path.join(runDir, 'launcher.log');
    fs.writeFileSync(launcherLog, '');
    launchEnv = {
      ...process.env,
      ZS_R78_ENGINEERING_TOKEN: engineering.token,
      ZS_DAEMON_ENTRY: engineering.entryPath,
      ZS_DEV25_DEBUG_PORT: String(port),
      ZS_TEST_DISPLAY: String(display.id),
      ZS_TEST_WINDOW_BOUNDS: `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
      ZS_TEST_PLACEMENT_FILE: placementFile,
      ZS_SAVEAS_AUTO_DIR: saveAsDir,
    };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ZS_APP_DATA', 'ZS_RUNTIME', 'ZS_ALLOW_FAKE', 'ZS_REAL_DISPATCH_GUARD', 'ZS_PACKED_ENTRY']) delete launchEnv[key];
    const launch = () => {
      try { fs.rmSync(placementFile, { force: true }); } catch { /* new evidence */ }
      // 显式 .\ 路径：宿主可能设置 NoDefaultCurrentDirectoryInExePath=1（cmd 不搜索当前目录）。
      // 仍调用副本内官方 start-desktop.bat，不修改 BAT。
      const child = spawn('cmd.exe', ['/d', '/s', '/c', '.\\start-desktop.bat'], {
        cwd: copyDir, env: launchEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { try { fs.appendFileSync(launcherLog, chunk); } catch { /* evidence best effort */ } });
      return child;
    };
    const closeApp = async () => {
      if (cdp != null) {
        try { await cdp.eval(`(() => { const button = document.querySelector('button.zs-winbtn.close'); if (button) { button.click(); return true; } return false; })()`); } catch { /* window may already be closing */ }
        await sleep(500);
        try { cdp.ws.close(); } catch { /* closed */ }
        cdp = null;
      }
      await waitFor(() => processCountUnder(copyDir) === 0, Boolean, 'isolated application processes closed', 45_000).catch(() => undefined);
      await waitFor(() => !fs.existsSync(path.join(copyDir, 'server-data', 'daemon.pid')), Boolean, 'isolated daemon pid removed', 15_000).catch(() => undefined);
      killProcessesUnder(copyDir);
      await sleep(500);
    };

    result.phase = 'launch-first';
    launcher = launch();
    await waitFor(() => fs.existsSync(readyFile), Boolean, 'engineering daemon ready', 90_000);
    const ready = readJson(readyFile);
    result.facts.engineeringReady = ready;
    check('engineering daemon injected Fake adapter', ready.fakeAdapterInjected === true);
    check('engineering daemon buildId matches copied BUILD', ready.buildId === build.buildId, `${ready.buildId} != ${build.buildId}`);
    cdp = await connectCdp(port, 'first launch');
    check('first launch: CDP renderer connected', cdp != null);
    const placement = await waitFor(() => (fs.existsSync(placementFile) ? readJson(placementFile) : null), Boolean, 'placement evidence', 30_000);
    result.facts.placement = placement;
    const primaryRect = displays.displays.find((entry) => entry.id === placement.primaryId)?.bounds;
    const intersectsPrimary = primaryRect != null && !(bounds.x + bounds.width <= primaryRect.x || bounds.x >= primaryRect.x + primaryRect.width || bounds.y + bounds.height <= primaryRect.y || bounds.y >= primaryRect.y + primaryRect.height);
    check('window placement evidence: non-primary display', placement.display.id !== placement.primaryId);
    const boundsDelta = ['x', 'y', 'width', 'height'].every((key) => Math.abs(Number(placement.actual?.[key]) - Number(placement.requested?.[key])) <= 2);
    check('window placement actual bounds equal requested (≤2px frame tolerance)', boundsDelta, q({ requested: placement.requested, actual: placement.actual }));
    const actualWithinDisplay = placement.display != null
      && placement.actual != null
      && placement.actual.x >= placement.display.bounds.x - 2
      && placement.actual.y >= placement.display.bounds.y - 2
      && placement.actual.x + placement.actual.width <= placement.display.bounds.x + placement.display.bounds.width + 2
      && placement.actual.y + placement.actual.height <= placement.display.bounds.y + placement.display.bounds.height + 2;
    check('actual window bounds stay within the non-primary display', actualWithinDisplay, q({ display: placement.display, actual: placement.actual }));
    check('visible window does not sit on primary display', !intersectsPrimary);
    const identity = await appCommand('app.identity');
    result.facts.identity = { appDataDir: identity.appDataDir, dataRootId: identity.dataRootId ?? null };
    check('application data root is the isolated package copy', path.resolve(identity.appDataDir) === path.resolve(copyDir, 'server-data'), identity.appDataDir);
    check('renderer hifi shell + titlebar online', await cdp.eval(`document.querySelector('[data-zs-titlebar-rendered="react"]')!=null`));
    await screenshot('01-app-ready');

    // 启动恢复面板：fixture 故意留有一个“待推进的实时研讨请求”，应用启动会按产品合同
    // 显示“检查上次使用/继续处理已排队的消息”面板。这里走产品自身按钮恢复队列并关闭面板，
    // 不修改产品、不绕过恢复语义；实时阶段更新由工程 Fake daemon 正常推进。
    result.phase = 'startup-recovery';
    await waitFor(() => cdp.eval(`[...document.querySelectorAll('.modal')].some((el) => el.textContent.includes('检查上次使用'))`), Boolean, 'startup recovery panel (optional)', 3_000).catch(() => undefined);
    const recoveryState = await cdp.eval(`(() => {
      const panel = [...document.querySelectorAll('.modal')].find((el) => el.textContent.includes('检查上次使用'));
      if (!panel) return { present: false };
      const button = (label) => [...panel.querySelectorAll('button')].find((el) => (el.textContent || '').includes(label));
      return { present: true, hasResume: button('继续处理已排队的消息') != null, hasClose: button('关闭') != null };
    })()`);
    result.facts.startupRecovery = recoveryState;
    if (recoveryState.present) {
      if (recoveryState.hasResume) {
        const clicked = await cdp.eval(`(() => { const panel = [...document.querySelectorAll('.modal')].find((el) => el.textContent.includes('检查上次使用')); if (!panel) return false; const button = [...panel.querySelectorAll('button')].find((el) => (el.textContent || '').includes('继续处理已排队的消息')); if (!button) return false; button.click(); return true; })()`);
        check('startup recovery: product resume button available/clicked', clicked);
        await sleep(1500);
      }
      await cdp.eval(`(() => { const panel = [...document.querySelectorAll('.modal')].find((el) => el.textContent.includes('检查上次使用')); if (!panel) return false; const button = [...panel.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === '关闭'); if (!button) return false; button.click(); return true; })()`);
      await waitFor(() => cdp.eval(`![...document.querySelectorAll('.modal')].some((el) => el.textContent.includes('检查上次使用'))`), Boolean, 'startup recovery panel dismissed', 20_000);
    }
    check('startup recovery panel dismissed before reading thread', await cdp.eval(`![...document.querySelectorAll('.modal')].some((el) => el.textContent.includes('检查上次使用'))`));

    // ---------- 原串阶段消息 + 文件卡 ----------
    result.phase = 'thread-stages';
    try {
      await openThreadPage(fixture, 'thread');
    } catch (error) {
      await captureThreadDiagnostics(fixture, 'open-thread');
      throw error;
    }
    const initialRender = await collectMessages();
    result.facts.threadInitialRender = { count: initialRender.length, domIds: initialRender.slice(0, 20).map((message) => message.domId), ids: initialRender.slice(0, 20).map((message) => message.id) };
    const expectedIds = fixture.stageMessages.map((message) => message.id);
    let staticWait;
    try {
      staticWait = await waitFor(() => collectMessages(), (messages) => messages.length > 0 && expectedIds.every((id) => messages.some((message) => message.id === id)), 'fixture stage messages rendered', 30_000);
    } catch (error) {
      await captureThreadDiagnostics(fixture, 'stage-render');
      throw error;
    }
    result.facts.threadMessagesInitial = staticWait.map((message) => ({ id: message.id, domId: message.domId, author: message.author, stage: message.stage, seq: message.seq, chips: message.chips.length }));
    const stageLabels = { INDEPENDENT: '独立分析', CROSS_REVIEW: '互评', ISSUE_DISCUSSION: '分歧讨论', SYNTHESIS: '整合', RATIFY: '确认' };
    const byId = new Map(staticWait.map((message) => [message.id, message]));
    let stageCheckFailures = [];
    const normalizeText = (value) => String(value ?? '').replace(/\s+/g, '');
    const requiredBodyByStage = {
      INDEPENDENT: ['方案 A 的合成成本比方案 B 低约 6 万元'],
      CROSS_REVIEW: ['该结论的证据来自单一合成样本'],
      ISSUE_DISCUSSION: ['保留分歧，交由整合稿如实记录'],
      SYNTHESIS: ['方案 A 成本更低、方案 B 交付更快'],
      RATIFY: ['按合成材料确认'],
    };
    // 只禁止“首行阶段标题”重复（loader 已去重）；正文里的【观察到】/【推断】等
    // 语义标签是合法可读正文，必须保留（不全局剥中文括号）。
    const duplicatedStageHeading = /^【(独立分析|互评|争议讨论|分歧讨论|整合|确认|发布|准备)(\s*·[^】]*)?】/;
    for (const expected of fixture.stageMessages) {
      const rendered = byId.get(expected.id);
      if (rendered == null) { stageCheckFailures.push(`${expected.id} 未渲染`); continue; }
      const expectedTag = `${stageLabels[expected.stage] ?? expected.stage}${expected.roundNo > 0 ? ` · 第${expected.roundNo}轮` : ''}`;
      if (rendered.author !== expected.authorDisplayName) stageCheckFailures.push(`${expected.id} 作者 ${rendered.author} != ${expected.authorDisplayName}`);
      if (rendered.stage !== expectedTag) stageCheckFailures.push(`${expected.id} 标签 ${rendered.stage} != ${expectedTag}`);
      if (rendered.stageTagCount !== 1) stageCheckFailures.push(`${expected.id} header 阶段标签数量 ${rendered.stageTagCount} != 1`);
      if (rendered.seq !== `#${expected.seq}`) stageCheckFailures.push(`${expected.id} seq ${rendered.seq} != #${expected.seq}`);
      if (duplicatedStageHeading.test(rendered.text.trimStart())) stageCheckFailures.push(`${expected.id} 首行阶段标题重复`);
      if (rendered.text.includes('collaborationStage') || rendered.text.includes('turnId') || rendered.text.includes('runId')) stageCheckFailures.push(`${expected.id} 暴露内部 metadata`);
      const requiredBodies = expected.rawTextPreview?.includes('检查点')
        ? ['检查点结论']
        : (requiredBodyByStage[expected.stage] ?? []);
      if (requiredBodies.length > 0 && !requiredBodies.some((phrase) => normalizeText(rendered.text).includes(normalizeText(phrase)))) {
        stageCheckFailures.push(`${expected.id} 正文缺少有意义阶段正文标记 ${requiredBodies.join('/')}`);
      }
    }
    check('stage messages: correct authors / Chinese labels / rounds / seq / natural body', stageCheckFailures.length === 0, stageCheckFailures.slice(0, 8).join('; '));
    const stageAuthors = new Map(fixture.stageMessages.map((message) => [message.stage, new Set()]));
    for (const message of fixture.stageMessages) stageAuthors.get(message.stage).add(message.authorDisplayName);
    check('stage messages include real two-member authors for INDEPENDENT and CROSS_REVIEW', stageAuthors.get('INDEPENDENT').size === 2 && stageAuthors.get('CROSS_REVIEW').size === 2, q([...stageAuthors.entries()].map(([stage, names]) => [stage, [...names]])));
    const metadataProbe = await cdp.eval(`(() => {
      const scope = ${threadScopeExpr};
      const text = scope == null ? '' : (scope.textContent || '');
      const keys = ['collaborationStage', 'turnId', 'runId', 'INDEPENDENT', 'CROSS_REVIEW', 'SYNTHESIS'];
      const hits = keys.filter((key) => text.includes(key));
      return {
        scopeFound: scope != null,
        length: text.length,
        hits,
        contexts: hits.map((key) => { const at = text.indexOf(key); return text.slice(Math.max(0, at - 80), at + 140); }),
      };
    })()`);
    check('thread UI does not expose raw collaboration metadata (thread scope)', metadataProbe.scopeFound && metadataProbe.hits.length === 0, q(metadataProbe));
    check('no duplicate/nested message bubbles', (await cdp.eval(`document.querySelectorAll('.msg .msg').length`)) === 0);

    const generated = fixture.generatedFiles;
    const generatedMessage = staticWait.find((message) => message.id === fixture.generatedMessageId);
    check('generated file reply rendered with author', generatedMessage != null && generatedMessage.author === fixture.generatedMessageAuthor.displayName, generatedMessage && generatedMessage.author);
    const expectedAttachmentCount = 3 + (args.r93Detail ? 1 : 0);
    check(`generated file reply shows exactly ${expectedAttachmentCount} unique attachment chips`, generatedMessage != null && generatedMessage.chips.length === expectedAttachmentCount && new Set(generatedMessage.chips.map((chip) => chip.artifactId)).size === expectedAttachmentCount, generatedMessage && q(generatedMessage.chips));
    check('attachment footer is below body/fold and outside the fold',
      generatedMessage != null && generatedMessage.bodyBeforeAttachments && generatedMessage.attachmentsInFooter
        && generatedMessage.attachmentsAfterFold);
    const expectedFilenames = [...generated.map((file) => file.filename), ...(args.r93Detail ? [fixture.detailAttachment.filename] : [])].sort();
    const actualFilenames = (generatedMessage?.chips ?? []).map((chip) => expectedFilenames.find((name) => chip.text.includes(name))).filter(Boolean).sort();
    check('attachment chips show all guarded filenames/kinds', q(actualFilenames) === q(expectedFilenames), q({ expectedFilenames, actual: generatedMessage?.chips }));
    await screenshot('02-thread-stages-and-file-cards');

    result.phase = 'preview-saveas';
    const clickChip = async (artifactId) => {
      const clicked = await cdp.eval(`(() => { const chip = document.querySelector('[data-zs-artifact-id=${q(artifactId)}]'); if (chip == null) return false; chip.click(); return true; })()`);
      must(clicked, `附件卡不存在：${artifactId}`);
    };
    const waitPreview = async (filename, kind, expectedText = null) => {
      await waitFor(() => cdp.eval(`document.querySelector('.preview-tab.on')?.textContent || ''`), (text) => text.includes(filename), `preview tab ${filename}`, 45_000);
      await waitFor(() => cdp.eval(`document.querySelector('[data-zs-file-loading="1"]') == null`), Boolean, `preview loaded ${filename}`, 90_000);
      const error = await cdp.eval(`document.querySelector('[data-zs-preview-error]')?.getAttribute('data-zs-preview-error') || null`);
      check(`preview ${filename}: no preview error`, error == null, error);
      const text = await cdp.eval(`document.querySelector('.preview-body')?.textContent || ''`);
      if (kind === 'detail_markdown') {
        check(`preview R93 detail rendered (${filename})`, expectedText == null || text.includes(expectedText), text.slice(-240));
      } else if (kind === 'sheet_file') {
        const isXlsx = filename.endsWith('.xlsx');
        if (isXlsx) {
          const xlsxReady = await waitFor(() => cdp.eval(`(() => ({ engine: !!document.querySelector('[data-zs-xlsx-view]'), grid: !!document.querySelector('[data-zs-xlsx-grid]') }))()`), (state) => state.engine || state.grid, `xlsx render ${filename}`, 60_000);
          check(`preview xlsx rendered (${filename})`, xlsxReady.engine || xlsxReady.grid, q(xlsxReady));
        } else {
          check(`preview csv rendered (${filename})`, text.includes('成本差') || (await cdp.eval(`!!document.querySelector('.preview-csv-wrap')`)), text.slice(0, 120));
        }
      } else {
        check(`preview txt rendered (${filename})`, text.includes('R91 合成验收说明') || text.includes('验收说明'), text.slice(0, 120));
      }
      return text;
    };
    const saveAsAndVerify = async (file) => {
      await waitFor(() => cdp.eval(`(() => { const button = document.querySelector('button[aria-label="下载原文件"]'); return !!(button && !button.disabled); })()`), Boolean, `download button ${file.filename}`, 30_000);
      const clicked = await cdp.eval(`(() => { const button = document.querySelector('button[aria-label="下载原文件"]'); if (button == null || button.disabled) return false; button.click(); return true; })()`);
      must(clicked, `下载按钮不可用：${file.filename}`);
      const base = path.basename(file.filename, path.extname(file.filename));
      const saved = await waitFor(() => {
        if (!fs.existsSync(saveAsDir)) return null;
        for (const name of fs.readdirSync(saveAsDir)) {
          if (!name.startsWith(base)) continue;
          const full = path.join(saveAsDir, name);
          try {
            const bytes = fs.readFileSync(full);
            if (sha256(bytes) === file.sha256) return { path: full, bytes: bytes.length, sha256: sha256(bytes), name };
          } catch { /* file still being written */ }
        }
        return null;
      }, Boolean, `save-as bytes ${file.filename}`, 45_000);
      check(`save-as ${file.filename}: bytes/sha256 equal fixture`, saved.bytes === file.bytes && saved.sha256 === file.sha256, q({ saved, expected: { bytes: file.bytes, sha256: file.sha256 } }));
      result.facts.saveAs = result.facts.saveAs ?? [];
      result.facts.saveAs.push({ filename: file.filename, expectedSha256: file.sha256, saved });
    };
    for (const file of generated) {
      await clickChip(file.artifactId);
      await waitPreview(file.filename, file.kind);
      await saveAsAndVerify(file);
    }
    if (args.r93Detail) {
      const detail = fixture.detailAttachment;
      const detailChip = generatedMessage?.chips.find((chip) => chip.artifactId === detail.artifactId);
      check('R93 detail card is the final attachment card and marked detail', detailChip != null && detailChip.detail === true && generatedMessage.chips.at(-1)?.artifactId === detail.artifactId, q(generatedMessage?.chips));
      await clickChip(detail.artifactId);
      await waitPreview(detail.filename, 'detail_markdown', detail.marker);
      const detailText = await cdp.eval(`document.querySelector('.preview-body')?.textContent || ''`);
      check('R93 detail preview contains full-tail marker', detailText.includes(detail.marker), detailText.slice(-240));
      await saveAsAndVerify(detail);
    }
    await screenshot('03-preview-and-saveas');

    // ---------- 实时阶段更新期间的输入稳定性 + 独立草稿 ----------
    // 夹具使用 --no-live：不在关库前预排实时请求，因此不依赖启动恢复队列。
    // 静态阶段/文件卡检查完成后，**在同一个原线程**通过正式 message.submit 提交
    // collaboration:'deliberate' + @all，并立即开始 13s 输入检查；记录 messageId/
    // request/runId 与 thread.history 增量（不写假阶段消息、不新建 root）。
    result.phase = 'live-input';
    await openThreadPage(fixture, 'live-input');
    const threadEditorExpr = `(() => { const scoped = document.querySelector('.col-thread .composer-editor[contenteditable="true"]'); if (scoped) return scoped; return [...document.querySelectorAll('.composer-editor[contenteditable="true"]')].find((e) => (e.getAttribute('data-placeholder') || '').startsWith('跟进当前任务')) || null; })()`;
    const dmEditorExpr = `(() => { const scoped = [...document.querySelectorAll('.composer-editor[contenteditable="true"]')].find((e) => (e.getAttribute('data-placeholder') || '').startsWith('给 ')); return scoped || document.querySelector('.composer-editor[contenteditable="true"]'); })()`;
    const editorText = (expr = threadEditorExpr) => cdp.eval(`(() => { const editor = ${expr}; return editor ? (editor.textContent || '') : ''; })()`);
    const editorSnapshot = (expr = threadEditorExpr) => cdp.eval(`(() => { const editor = ${expr}; if (editor == null) return null; const selection = window.getSelection(); let offset = 0; if (selection && selection.rangeCount > 0) { const range = selection.getRangeAt(0); const before = range.cloneRange(); before.selectNodeContents(editor); before.setEnd(range.startContainer, range.startOffset); offset = before.toString().length; } return { text: editor.textContent || '', offset, scrollTop: editor.scrollTop, scrollHeight: editor.scrollHeight, clientHeight: editor.clientHeight }; })()`);
    const setCaretOffset = (offset, expr = threadEditorExpr) => cdp.eval(`(() => { const editor = ${expr}; if (editor == null) return false; const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let remaining = ${offset}; let node = null; while ((node = walker.nextNode())) { const length = (node.textContent || '').length; if (remaining <= length) { const range = document.createRange(); range.setStart(node, remaining); range.collapse(true); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); editor.focus(); return true; } remaining -= length; } return false; })()`);
    const selectText = (needle, expr = threadEditorExpr) => cdp.eval(`(() => { const editor = ${expr}; if (editor == null) return false; const text = editor.textContent || ''; const at = text.indexOf(${q(needle)}); if (at < 0) return false; const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let remaining = at; let node = null; while ((node = walker.nextNode())) { const length = (node.textContent || '').length; if (remaining <= length) { const range = document.createRange(); range.setStart(node, remaining); range.setEnd(node, Math.min(length, remaining + ${q(needle)}.length)); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); editor.focus(); return true; } remaining -= length; } return false; })()`);
    const beforeHistory = await appCommand('thread.history', { threadId: fixture.threadId, limit: 100 });
    const historyBeforeCount = Array.isArray(beforeHistory.items) ? beforeHistory.items.length : 0;
    const stageCountBefore = await stageTagCount();
    const hashBeforeInput = await cdp.eval('location.hash');
    const liveBody = `${fixture.liveMarker ?? 'R91_LIVE_STAGE_UPDATE'}：边打字边收到的同串实时合成研讨（FAKE/SYNTHETIC，工程 Fake adapter）。`;
    let liveSubmit;
    try {
      liveSubmit = await appCommand('message.submit', {
        target: { kind: 'thread', projectId: fixture.projectId, conversationId: fixture.conversationId, threadId: fixture.threadId },
        body: liveBody,
        intent: 'default', mentions: [{ kind: 'all' }],
        collaboration: 'deliberate', deliberationBudget: { maxTurns: 40 },
      });
    } catch (error) {
      result.facts.liveSubmitError = String(error);
      check('live deliberation submit accepted into the original thread', false, String(error));
      throw error;
    }
    result.facts.liveSubmit = liveSubmit;
    result.facts.liveSubmitAt = new Date().toISOString();
    check('live deliberation submit accepted into the original thread', liveSubmit != null && liveSubmit.messageId != null && liveSubmit.taskId != null, q(liveSubmit));
    const liveMessageId = liveSubmit.messageId;
    const inspectLiveRequest = () => readLiveRequestFacts(path.join(copyDir, 'server-data'), liveMessageId);

    const editorFocused = await cdp.eval(`(() => { const editor = ${threadEditorExpr}; if (editor == null) return false; editor.focus(); return true; })()`);
    check('thread-scoped composer focused (not left room composer)', editorFocused === true);
    const baseText = ['R91_CARET_BASE_LINE_01 合成输入稳定性', '02 行内容保持', '03 行内容保持', '04 行内容保持', '05 行内容保持', '06 行内容保持', '07 行内容保持', '08 行内容保持', '09 行内容保持', '10 行内容保持'].join('\n');
    await cdp.send('Input.insertText', { text: baseText });
    await waitFor(() => editorText(), (text) => text.includes('R91_CARET_BASE_LINE_01'), 'thread-scoped base draft text', 15_000);
    const middleIndex = await cdp.eval(`(() => { const editor = ${threadEditorExpr}; if (editor == null) return -1; return (editor.textContent || '').indexOf('05 行内容保持'); })()`);
    await setCaretOffset(middleIndex > 0 ? middleIndex : 1);
    await cdp.eval(`(() => { const editor = ${threadEditorExpr}; if (editor) editor.scrollTop = editor.scrollHeight; return true; })()`);
    const baseSnapshot = await editorSnapshot();
    result.facts.threadEditorBeforeLive = baseSnapshot;
    const updateDeadline = Date.now() + 13_000;
    while (Date.now() < updateDeadline) { await sleep(600); await stageTagCount(); }
    const midSnapshot = await editorSnapshot();
    const afterHistory = await appCommand('thread.history', { threadId: fixture.threadId, limit: 100 });
    const historyAfterCount = Array.isArray(afterHistory.items) ? afterHistory.items.length : 0;
    const liveRequestMid = inspectLiveRequest();
    const finalStageCount = await stageTagCount();
    result.facts.liveRequestAfter13s = liveRequestMid;
    result.facts.historyDeltaAfter13s = { before: historyBeforeCount, after: historyAfterCount, added: historyAfterCount - historyBeforeCount };
    check('live deliberation produced new stage tags in the same thread while typing (13s, >2 polls)', finalStageCount > stageCountBefore, `${stageCountBefore} -> ${finalStageCount}; request=${q(liveRequestMid)}`);
    check('live deliberation added real thread.history items in the same thread while typing', historyAfterCount > historyBeforeCount, `${historyBeforeCount} -> ${historyAfterCount}`);
    check('live request carries real requestId/runId (not fabricated stage rows)', liveRequestMid != null && liveRequestMid.request != null && liveRequestMid.request.message_id === liveMessageId && (liveRequestMid.request.run_id != null || liveRequestMid.request.status === 'queued'), q(liveRequestMid));
    check('typing during refresh does not jump text to head', midSnapshot != null && midSnapshot.text === baseSnapshot.text && midSnapshot.offset === baseSnapshot.offset && midSnapshot.text.startsWith('R91_CARET_BASE_LINE_01'), q({ base: baseSnapshot, mid: midSnapshot }));
    check('thread route is not force-switched by stage updates', (await cdp.eval('location.hash')) === hashBeforeInput);
    await setCaretOffset(middleIndex > 0 ? middleIndex : 1);
    const beforeIme = await editorSnapshot();
    result.facts.imeCaretBefore = { expectedMiddle: middleIndex, actual: beforeIme };
    check('thread-scoped IME caret positioned at requested middle before composition', beforeIme != null && Math.abs(beforeIme.offset - (middleIndex > 0 ? middleIndex : 1)) <= 2, q(beforeIme));
    let imeMethod = 'Input.imeSetComposition';
    try {
      // 不传 replacementStart/End：避免 CDP 语义上明确要求“替换头部”。
      await cdp.send('Input.imeSetComposition', { text: 'IME中间', selectionStart: 4, selectionEnd: 4 });
    } catch {
      imeMethod = 'Input.insertText (host does not expose imeSetComposition)';
    }
    await cdp.send('Input.insertText', { text: 'IME中间' });
    result.facts.imeMethod = imeMethod;
    await waitFor(() => editorText(), (text) => text.includes('IME中间'), 'IME middle insert', 15_000);
    const afterIme = await editorSnapshot();
    check('IME composition inserts at selected caret, not at head', afterIme.text.startsWith('R91_CARET_BASE_LINE_01') && afterIme.text.includes('IME中间') && !afterIme.text.startsWith('IME中间') && afterIme.offset > 0, q({ offset: afterIme.offset, text: afterIme.text.slice(0, 100) }));
    await sleep(6_500);
    const afterImeRefresh = await editorSnapshot();
    check('IME middle text stable across another 5s refresh', afterImeRefresh.text === afterIme.text && afterImeRefresh.offset === afterIme.offset, q({ before: afterIme, after: afterImeRefresh }));
    const endIndex = (await editorSnapshot()).text.length;
    await setCaretOffset(endIndex);
    await cdp.send('Input.insertText', { text: 'IME末尾' });
    await waitFor(() => editorText(), (text) => text.endsWith('IME末尾'), 'end insert', 15_000);
    await selectText('IME中间');
    await cdp.send('Input.insertText', { text: '选区替换' });
    const afterReplace = await editorSnapshot();
    check('selection replacement stays in place (no head jump)', afterReplace.text.includes('选区替换') && !afterReplace.text.includes('IME中间') && afterReplace.text.startsWith('R91_CARET_BASE_LINE_01'), q(afterReplace.text.slice(0, 140)));
    await navigate(`/dm/${encodeURIComponent(fixture.dmConversationId)}`, `.composer-editor[contenteditable="true"][data-placeholder^="给 "]`, 'DM page');
    await cdp.eval(`(() => { const editor = ${dmEditorExpr}; if (editor) editor.focus(); return true; })()`);
    await cdp.send('Input.insertText', { text: 'R91_DM_DRAFT_MARKER' });
    await waitFor(() => editorText(dmEditorExpr), (text) => text.includes('R91_DM_DRAFT_MARKER'), 'DM draft text', 15_000);
    await openThreadPage(fixture, 'back-thread');
    await waitFor(() => editorText(), (text) => text.includes('选区替换'), 'thread draft restored', 30_000);
    const restoredThread = await editorText();
    check('thread draft preserved independently after DM switch', restoredThread.includes('选区替换') && restoredThread.includes('IME末尾') && !restoredThread.includes('R91_DM_DRAFT_MARKER'), restoredThread.slice(0, 180));
    await navigate(`/dm/${encodeURIComponent(fixture.dmConversationId)}`, `.composer-editor[contenteditable="true"][data-placeholder^="给 "]`, 'back to DM');
    await waitFor(() => editorText(dmEditorExpr), (text) => text.includes('R91_DM_DRAFT_MARKER'), 'DM draft restored', 30_000);
    check('DM draft preserved independently after switch back', (await editorText(dmEditorExpr)).includes('R91_DM_DRAFT_MARKER'));
    await screenshot('04-live-input-and-drafts');
    const liveTerminal = await waitFor(() => inspectLiveRequest(), (facts) => facts != null && facts.request != null && (facts.request.status === 'succeeded' || facts.request.status === 'failed'), 'live deliberation request terminal', 120_000).catch(() => inspectLiveRequest());
    result.facts.liveRequestFinal = liveTerminal;
    check('live deliberation request reached a terminal state', liveTerminal != null && liveTerminal.request != null && (liveTerminal.request.status === 'succeeded' || liveTerminal.request.status === 'failed'), q(liveTerminal));
    if (liveTerminal?.request?.status === 'failed') {
      check('live deliberation request succeeded (real backend result)', false, q(liveTerminal.request));
    }

    // ---------- 关闭 + 重开同副本 ----------
    result.phase = 'reopen';
    await closeApp();
    const runtimeFacts = readRuntimeFacts(path.join(copyDir, 'server-data'));
    result.facts.runtimeAfterFirstPass = { realCalls: runtimeFacts.realCalls, stageMessages: runtimeFacts.stageMessages, generatedAttachments: runtimeFacts.generatedAttachments, tasks: runtimeFacts.tasks, runs: runtimeFacts.runs };
    check('zero real calls after UI pass', runtimeFacts.realCalls === 0);
    check('generated file artifacts persisted in isolated root', runtimeFacts.generatedAttachments === 3 && runtimeFacts.messageAttachments.length === 3);
    launcher = launch();
    await waitFor(() => fs.existsSync(readyFile), Boolean, 'engineering daemon ready on reopen', 90_000);
    cdp = await connectCdp(port, 'reopen');
    check('reopen same copy: CDP renderer connected', cdp != null);
    const reopenPlacement = readJson(placementFile);
    check('reopen same copy: non-primary placement retained', reopenPlacement.display.id !== reopenPlacement.primaryId);
    try {
      await openThreadPage(fixture, 'reopen');
    } catch (error) {
      await captureThreadDiagnostics(fixture, 'reopen');
      throw error;
    }
    const reopened = await waitFor(() => collectMessages(), (messages) => expectedIds.every((id) => messages.some((message) => message.id === id)), 'reopened fixture stage messages', 90_000);
    const reopenedById = new Map(reopened.map((message) => [message.id, message]));
    const reopenStageFailures = fixture.stageMessages.filter((expected) => {
      const rendered = reopenedById.get(expected.id);
      return rendered == null || rendered.author !== expected.authorDisplayName || !rendered.stage.startsWith(stageLabels[expected.stage] ?? expected.stage);
    });
    check('reopen same copy: stage messages/authors/labels retained', reopenStageFailures.length === 0, reopenStageFailures.map((entry) => entry.id).slice(0, 5).join(','));
    const reopenedGenerated = reopenedById.get(fixture.generatedMessageId);
    check(`reopen same copy: exactly ${expectedAttachmentCount} file cards retained (no duplicates)`, reopenedGenerated != null && reopenedGenerated.chips.length === expectedAttachmentCount && new Set(reopenedGenerated.chips.map((chip) => chip.artifactId)).size === expectedAttachmentCount, reopenedGenerated && q(reopenedGenerated.chips));
    await clickChip(fixture.generatedFiles[0].artifactId);
    await waitPreview(fixture.generatedFiles[0].filename, fixture.generatedFiles[0].kind);
    await saveAsAndVerify(fixture.generatedFiles[0]);
    check('reopen same copy: preview + save-as sha256 still equal fixture', true);
    if (args.r93Detail) {
      const detail = fixture.detailAttachment;
      await clickChip(detail.artifactId);
      await waitPreview(detail.filename, 'detail_markdown', detail.marker);
      await saveAsAndVerify(detail);
      check('reopen same copy: R93 detail preview + save-as sha256 still equal fixture', true);
    }
    await screenshot('05-reopen-persisted');

    result.phase = 'complete';
    const finalFacts = readRuntimeFacts(path.join(copyDir, 'server-data'));
    result.facts.runtimeAfterReopen = { realCalls: finalFacts.realCalls, stageMessages: finalFacts.stageMessages, generatedAttachments: finalFacts.generatedAttachments };
    check('final runtime still has zero real calls', finalFacts.realCalls === 0);
    check('final runtime has expected generated file attachments', finalFacts.generatedAttachments === 3);
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    result.phase = result.phase || 'failed';
    console.error(error);
  } finally {
    try { if (copyDir != null) await (async () => { if (cdp != null) { try { await cdp.eval(`(() => { const button = document.querySelector('button.zs-winbtn.close'); if (button) button.click(); return true; })()`); } catch { /* closing */ } } })(); } catch { /* best effort */ }
    if (copyDir != null) {
      await sleep(500);
      killProcessesUnder(copyDir);
      if (!args.keepCopy) {
        try { fs.rmSync(copyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch (error) { result.facts.copyCleanupError = String(error); }
      }
    }
    if (args.prepareOnly) {
      result.prepareOnlyFacts = {
        copyDir: args.keepCopy ? copyDir : '<removed after prepare-only validation>',
        fixture: result.facts.fixture ? { projectId: result.facts.fixture.projectId, threadId: result.facts.fixture.threadId, stageMessages: result.facts.fixture.stageMessages?.length, generatedFiles: result.facts.fixture.generatedFiles?.length, liveMessageId: result.facts.fixture.liveMessageId } : null,
        engineeringEntry: args.keepCopy ? result.facts.engineering?.entryPath ?? null : '<removed with isolated copy>',
        displayPlan: result.facts.placementPlan ?? null,
      };
      writeJson(path.join(runDir, 'prepare-only.json'), result);
    }
    save();
    if (launcher != null && typeof launcher.kill === 'function') { try { launcher.kill(); } catch { /* already exited */ } }
  }
  console.log(JSON.stringify({ ok: result.ok, phase: result.phase, checks: result.checks.length, failed: result.checks.filter((checkItem) => !checkItem.ok).map((checkItem) => checkItem.name), evidence: runDir, error: result.error ?? null }, null, 2));
  process.exitCode = result.ok ? 0 : (result.error == null ? 1 : 2);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 2;
  });
}
module.exports = { main };
