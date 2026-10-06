'use strict';
/**
 * R67 P3 升级门（review-r66 §3 重写——R66 验证器的判据无效/覆盖不足全部修正）：
 *  - **基线先存后比**：升级前保存完整事实基线（全树文件 sha256 清单 + SQLite 逻辑事实：
 *    项目全列/消息正文逐字/线程/任务/附件 hash/成员绑定/导航偏好/凭据文件 hash/profile
 *    文件集）——升级后逐项对照；**内容变更但数量不变必须失败**（R66 blob 自比较反例修正）。
 *  - **负对照实跑**：在基线副本上分别做 单 blob 字节变更/消息正文变更（计数不变）/
 *    local.token 变更/账本（outbox）漂移——验证器逐个必须拒绝（总门负对照真的让门失败）。
 *  - **回退=完整数据根**：升级前根**整目录快照**恢复到 restore-data（不只 SQLite）→
 *    旧程序（v4 包 daemon）打开监听 + 全树 hash 与快照一致（附件/凭据/profile/账本全在）。
 *  - **真实调用拦截**：所有 daemon 运行均 ZS_REAL_DISPATCH_GUARD=1 + fake 渠道绑定；
 *    real_calls 表前后计数=0（不因启动副本放开真实派发）。
 *  - 老根不动：fixture 根为演练私有（v4 包创建）；v4/v5 用户包目录零写入。
 * 旧程序=desktop-daily-win-v4 打包 daemon（支持 ≤47）；新程序=当前源码构建 daemon（48）。
 * 产物 dist/desktop/upgrade-drill-r67-<ts>/result.json。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r67-upg-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `upgrade-drill-r67-${runId}`);
const fixtureRoot = path.join(outDir, 'fixture-root');   // v4 旧程序创建（=升级前状态）
const drillData = path.join(outDir, 'data');              // 升级目标（fixture 全量副本）
const restoreData = path.join(outDir, 'restore-data');    // 回退目标（升级前整目录快照副本）
const v4Daemon = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v4', 'ZhongshuoDual', 'resources', 'app', 'daemon');
const v4Node = path.join(v4Daemon, 'node', 'node.exe');
const v5DaemonCjs = path.join(repo, 'dist', 'pack', 'daemon.cjs'); // 当前源码构建（make 前由本脚本 esbuild 重建）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(200);
  }
}
function pipeConnect(pipeName, token) {
  return new Promise((resolve, reject) => {
    const sock = connect(pipeName);
    sock.setEncoding('utf8');
    let buf = '';
    const pending = new Map();
    let authed = false;
    const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); sock.destroy(); };
    let connected = false;
    const timer = setTimeout(() => { if (!authed) { failAll(new Error('管道握手超时' + (connected ? '（已连接未获 auth.ok——token 不符？）' : '（未连接）'))); reject(new Error('管道握手超时' + (connected ? '（已连接未获 auth.ok——token 不符？）' : '（未连接）'))); } }, 15000);
sock.on('connect', () => { connected = true; sock.write(`${JSON.stringify({ type: 'auth', token })}\n`); });
    sock.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (!authed) { if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ send, close: () => sock.destroy() }); } continue; }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!authed) reject(e); else failAll(e); });
    function send(method, params) {
      const commandId = `up-${randomUUID().slice(0, 8)}`;
      return new Promise((resolve2, reject2) => {
        const p = { resolve: resolve2, reject: reject2, timer: null };
        p.timer = setTimeout(() => { pending.delete(commandId); reject2(new Error(`命令超时：${method}`)); }, 20000);
        pending.set(commandId, p);
        sock.write(`${JSON.stringify({ protocolVersion: 1, commandId, method, params })}\n`);
      });
    }
  });
}
const cmd = async (client, method, params) => {
  const r = await client.send(method, params);
  if (r && r.ok === false) throw new Error(`${method} 被拒：${r.error?.code}: ${r.error?.message}`);
  return r && r.data !== undefined ? r.data : r;
};
/** 启动 daemon（持久实例——命令期间存活，调用方 kill() 收口）。 */
function startDaemon(nodeExe, daemonCjs, cwd, dataDir, pipeName, ms = 40000) {
  return new Promise((resolve) => {
    const env = { ...process.env, ZS_APP_DATA: dataDir, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '0' };
    const p = spawn(nodeExe, [daemonCjs], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (c) => { buf += c; });
    p.stderr.on('data', (c) => { buf += c; });
    const timer = setTimeout(() => resolve({ ok: false, tail: buf.slice(-4000) }), ms);
    p.stderr.on('data', (c) => { if (String(c).includes('listening')) { clearTimeout(timer); resolve({ ok: true, kill: () => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } }, tail: () => buf.slice(-4000) }); } });
    p.on('exit', (code) => { clearTimeout(timer); resolve({ ok: false, exited: code, tail: buf.slice(-4000) }); });
  });
}
/** 短生命周期运行（只验启动/监听/退出形态，不发命令）。 */
async function runDaemonOnce(nodeExe, daemonCjs, cwd, dataDir, pipeName, ms = 30000) {
  const d = await startDaemon(nodeExe, daemonCjs, cwd, dataDir, pipeName, ms);
  if (d.ok === true) { await sleep(400); d.kill(); await sleep(800); return { listening: true, tail: d.tail() }; }
  return { listening: false, tail: d.tail };
}

// ---- 事实采集（验证器核心：基线先存，后比逐项） ----
function snapshotFacts(dataDir) {
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(dataDir, 'state.sqlite'), { readonly: true });
  try {
    return {
      userVersion: db.pragma('user_version', { simple: true }),
      projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
      messages: db.prepare('SELECT id, conversation_id, body_json, created_at FROM messages ORDER BY id').all(),
      threads: db.prepare('SELECT id, conversation_id, project_id, root_task_id FROM conversation_threads ORDER BY id').all(),
      tasks: db.prepare('SELECT id, title, status, conversation_id FROM tasks ORDER BY id').all(),
      artifacts: db.prepare('SELECT id, kind, hash, source_name FROM artifacts ORDER BY id').all(),
      bindings: db.prepare('SELECT id, name, runtime_installation_id, settings_json FROM agent_profiles ORDER BY id').all(),
      navPrefs: db.prepare('SELECT viewer_id, client_id, visible_project_ids_json FROM navigation_preferences ORDER BY viewer_id, client_id').all(),
      outbox: db.prepare('SELECT dispatch_key, status FROM outbox ORDER BY dispatch_key').all(),
      realCalls: db.prepare('SELECT count(*) c FROM real_calls').get().c,
      realCallRows: db.prepare('SELECT runtime_kind, status FROM real_calls ORDER BY rowid').all(),
    };
  } finally { db.close(); }
}
/** 全树文件清单（跳过运行期易变项：locks/pipe-name/shutdown/wal/shm；新增白名单另判）。 */
function treeManifest(dataDir, { skip = [] } = {}) {
  const skipSet = new Set(skip);
  const out = {};
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (skipSet.has(relPath) || skipSet.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, relPath);
      else out[relPath] = sha256File(full);
    }
  };
  walk(dataDir, '');
  return out;
}
const VOLATILE = ['locks', 'pipe-name.txt', 'desktop-shutdown.json', 'state.sqlite-wal', 'state.sqlite-shm', 'backups', 'root-identity.json', 'daemon.pid'];
/** 比对两份（子）清单：返回差异描述数组（空=一致）。allowNew=允许仅新增的键集合。 */
function diffManifests(a, b, { allowNew = new Set(), labelA = '基线', labelB = '当前' } = {}) {
  const diffs = [];
  for (const k of Object.keys(a)) {
    if (!(k in b)) diffs.push(`缺失:${k}（${labelA}有→${labelB}无）`);
    else if (a[k] !== b[k]) diffs.push(`内容变更:${k}`);
  }
  for (const k of Object.keys(b)) {
    if (!(k in a) && !allowNew.has(k)) diffs.push(`新增:${k}（${labelB}出现）`);
  }
  return diffs;
}
function diffFacts(a, b) {
  const diffs = [];
  for (const key of Object.keys(a)) {
    if (key === 'userVersion') continue; // 版本提升是升级目标本身
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) diffs.push(`事实漂移:${key}`);
  }
  return diffs;
}

(async () => {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const errs = [];
  const f = {};

  // 0) 当前源码 daemon 构建（保证「新程序=当前源码」——不拿旧产物）。
  {
    const { build } = require(path.join(repo, 'node_modules', 'esbuild'));
    await build({ entryPoints: [path.join(repo, 'src', 'daemon', 'entry.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: v5DaemonCjs, sourcemap: false, external: ['better-sqlite3'], loader: { '.ts': 'ts' } });
  }

  // 1) 旧程序（v4 包 daemon）建 fixture 根：项目/附件/消息/绑定/导航偏好/账本（排队）。
  fs.writeFileSync(path.join(fixtureRoot, 'local.token'), token, 'utf8');
  const pipeOld = `\\\\.\\pipe\\zs-${runId}-old`;
  const oldDaemon = await startDaemon(v4Node, path.join(v4Daemon, 'daemon.cjs'), v4Daemon, fixtureRoot, pipeOld);
  if (oldDaemon.ok !== true) throw new Error(`v4 旧程序未监听：${String(oldDaemon.tail).slice(-300)}`);
  const projDir = path.join(outDir, '项目甲');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'README.md'), '# 升级演练项目\n', 'utf8');
  let client = await pipeConnect(pipeOld, token);
  const openR = await cmd(client, 'project.open', { path: projDir });
  const projId = openR.project.id;
  // 房间根会话 id=引导约定 conv_default_<projectId>（bootstrapProject）。
  const convRoot = 'conv_default_' + projId;
  const up = await cmd(client, 'attachment.uploadText', { conversationId: convRoot, filename: '升级 演变.md', content: '# 升级\n\n附件正文基线 R67-BASE' });
  await cmd(client, 'message.submit', { target: { kind: 'room_root', projectId: projId, conversationId: convRoot, roomId: `room_default_${projId}` }, body: '升级前消息基线', intent: 'record_only', mentions: [] });
  await cmd(client, 'member.setRuntime', { memberId: `m_default_${projId}_0`, kind: 'fake' }); // ZS_ALLOW_FAKE=1 环境允许（防真实渠道）
  await cmd(client, 'navigation.set', { clientId: 'desktop-hifi', activeProjectId: projId, visibleProjectIds: [projId], expandedProjectIds: [projId], pinnedProjectIds: [], fileGitTabs: {} });
  client.close();
  oldDaemon.kill();
  await sleep(1500);
  // profile 副本（electron-user-data）：直接造一个持久痕迹文件（v4 程序实际 profile 由 UI 写——
  // 演练以文件存在性+hash 连续性为凭）。
  fs.mkdirSync(path.join(fixtureRoot, 'electron-user-data', 'Default'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'electron-user-data', 'Default', 'r67-profile-marker.txt'), 'profile-baseline-r67\n', 'utf8');
  // 等退出收口。
  await sleep(1500);

  // 2) 基线（升级前）+ 全量副本 + 升级前整目录快照（回退源）。
  const baselineFacts = snapshotFacts(fixtureRoot);
  const baselineTree = treeManifest(fixtureRoot, { skip: VOLATILE });
  f.baseline = { userVersion: baselineFacts.userVersion, files: Object.keys(baselineTree).length, messages: baselineFacts.messages.length, realCalls: baselineFacts.realCalls };
  if (baselineFacts.userVersion !== 47) errs.push(`基线应为 v4 的 47（实际 ${baselineFacts.userVersion}）`);
  if (baselineFacts.realCalls !== 0) errs.push('基线 real_calls != 0');
  fs.cpSync(fixtureRoot, drillData, { recursive: true, force: true });
  fs.cpSync(fixtureRoot, restoreData, { recursive: true, force: true });

  // 3) 升级（v5=当前源码；guard=1 全程）。
  const pipeNew = `\\\\.\\pipe\\zs-${runId}-new`;
  {
    const r = await runDaemonOnce(process.execPath, v5DaemonCjs, path.dirname(v5DaemonCjs), drillData, pipeNew);
    if (r.listening !== true) errs.push(`v5 升级未监听：${r.tail.slice(-300)}`);
  }
  const afterFacts = snapshotFacts(drillData);
  const afterTree = treeManifest(drillData, { skip: VOLATILE });
  f.upgrade = { userVersion: afterFacts.userVersion };
  if (afterFacts.userVersion !== 48) errs.push(`升级后 user_version=${afterFacts.userVersion}（应 48）`);
  const factDiffs = diffFacts(baselineFacts, afterFacts);
  if (factDiffs.length > 0) errs.push(`逻辑事实漂移：${factDiffs.join('；')}`);
  const treeDiffs = diffManifests(baselineTree, afterTree, { allowNew: new Set() });
  if (treeDiffs.length > 0) errs.push(`升级改动既有文件：${treeDiffs.slice(0, 5).join('；')}`); // VOLATILE 已跳过+root-identity 在白名单外——升级不应碰任何基线文件
  const backups = fs.existsSync(path.join(drillData, 'backups')) ? fs.readdirSync(path.join(drillData, 'backups')) : [];
  f.preMigrationBackup = backups.filter((b) => b.startsWith('state-pre-v47')).length;
  if (f.preMigrationBackup < 1) errs.push('迁移前一致性备份未产生（state-pre-v47）');
  if (afterFacts.realCalls !== 0) errs.push('升级后 real_calls != 0');

  // 4) 负对照（验证器判据自证——每个都必须让门失败；在独立副本上做，不污染主演练）。
  const negatives = [];
  const runValidatorOn = (dir) => {
    const facts = snapshotFacts(dir);
    return [...diffFacts(baselineFacts, facts), ...diffManifests(baselineTree, treeManifest(dir, { skip: VOLATILE }))];
  };
  {
    // 4a blob 内容变更（数量不变）
    const d = path.join(outDir, 'neg-blob'); fs.cpSync(fixtureRoot, d, { recursive: true });
    const blobFile = fs.readdirSync(path.join(d, 'blobstore'))[0];
    fs.writeFileSync(path.join(d, 'blobstore', blobFile), Buffer.from('mutated-content-r67'));
    const diffs = runValidatorOn(d);
    f.negBlobRejected = diffs.some((x) => x.includes('内容变更') || x.includes('blobstore'));
    if (!f.negBlobRejected) errs.push('负对照未拒绝：blob 内容变更');
    negatives.push({ kind: 'blob-content', diffs: diffs.length });
  }
  {
    // 4b 消息正文变更（计数不变）
    const d = path.join(outDir, 'neg-msg'); fs.cpSync(fixtureRoot, d, { recursive: true });
    const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
    const db = new Database(path.join(d, 'state.sqlite'));
    db.prepare("UPDATE messages SET body_json = json_set(body_json, '$.text', '篡改正文 r67') WHERE id = (SELECT id FROM messages ORDER BY rowid LIMIT 1)").run();
    db.close();
    const diffs = runValidatorOn(d);
    f.negMessageRejected = diffs.some((x) => x.includes('messages'));
    if (!f.negMessageRejected) errs.push('负对照未拒绝：消息正文变更（计数不变）');
    negatives.push({ kind: 'message-body', diffs: diffs.length });
  }
  {
    // 4c 凭据文件变更
    const d = path.join(outDir, 'neg-token'); fs.cpSync(fixtureRoot, d, { recursive: true });
    fs.writeFileSync(path.join(d, 'local.token'), 'tampered-token-r67', 'utf8');
    const diffs = runValidatorOn(d);
    f.negTokenRejected = diffs.some((x) => x.includes('local.token'));
    if (!f.negTokenRejected) errs.push('负对照未拒绝：凭据文件变更');
    negatives.push({ kind: 'credential', diffs: diffs.length });
  }
  {
    // 4d 账本漂移（outbox 新增行）
    const d = path.join(outDir, 'neg-outbox'); fs.cpSync(fixtureRoot, d, { recursive: true });
    const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
    const db = new Database(path.join(d, 'state.sqlite'));
    db.prepare("INSERT INTO outbox (dispatch_key, status) VALUES ('task:r67-neg:initial', 'pending')").run();
    db.close();
    const diffs = runValidatorOn(d);
    f.negOutboxRejected = diffs.some((x) => x.includes('outbox'));
    if (!f.negOutboxRejected) errs.push('负对照未拒绝：账本漂移');
    negatives.push({ kind: 'outbox-drift', diffs: diffs.length });
  }
  f.negatives = negatives;

  // 5) 再开稳定（v5 二次，无额外备份、版本不动）。
  const backupsBefore = fs.readdirSync(path.join(drillData, 'backups')).length;
  {
    const r = await runDaemonOnce(process.execPath, v5DaemonCjs, path.dirname(v5DaemonCjs), drillData, `\\\\.\\pipe\\zs-${runId}-re`);
    if (r.listening !== true) errs.push('v5 再开未监听');
  }
  if (snapshotFacts(drillData).userVersion !== 48) errs.push('再开版本漂移');
  if (fs.readdirSync(path.join(drillData, 'backups')).length !== backupsBefore) errs.push('再开产生额外备份');
  if (snapshotFacts(drillData).realCalls !== 0) errs.push('再开 real_calls != 0');

  // 6) 旧程序直开升级库 → 版本门拒；回退=升级前**整目录快照** → v4 可开+全树一致。
  {
    const r = await runDaemonOnce(v4Node, path.join(v4Daemon, 'daemon.cjs'), v4Daemon, drillData, `\\\\.\\pipe\\zs-${runId}-rej`, 20000);
    f.oldOnUpgraded = { listening: r.listening, gateRejected: /SCHEMA_VERSION_UNSUPPORTED|版本|UNSUPPORTED/i.test(r.tail) };
    f.oldOnUpgradedTail = r.tail.slice(-3000);
    if (r.listening === true || !f.oldOnUpgraded.gateRejected) errs.push('旧程序未按版本门拒绝升级库');
  }
  {
    const r = await runDaemonOnce(v4Node, path.join(v4Daemon, 'daemon.cjs'), v4Daemon, restoreData, `\\\\.\\pipe\\zs-${runId}-rst`);
    f.oldOnRestored = { listening: r.listening };
    if (r.listening !== true) errs.push(`v4+快照回退无法打开：${r.tail.slice(-200)}`);
    const restoredFacts = snapshotFacts(restoreData);
    const restoredDiffs = diffFacts(baselineFacts, restoredFacts);
    // 回退侧 state.sqlite 会被旧程序自身写 wal/lock（VOLATILE 已跳过）；逻辑事实必须与基线一致。
    if (restoredDiffs.length > 0) errs.push(`回退事实漂移：${restoredDiffs.join('；')}`);
    const restoredTreeDiffs = diffManifests(baselineTree, treeManifest(restoreData, { skip: VOLATILE }));
    if (restoredTreeDiffs.length > 0) errs.push(`回退全树不一致：${restoredTreeDiffs.slice(0, 5).join('；')}`);
    f.restoreFiles = Object.keys(treeManifest(restoreData, { skip: VOLATILE })).length;
  }

  // 7) fixture 原根不动对照。
  f.fixtureUntouched = diffManifests(baselineTree, treeManifest(fixtureRoot, { skip: VOLATILE })).length === 0;
  if (!f.fixtureUntouched) errs.push('演练 fixture 原根被改动');

  const result = { runId, ok: errs.length === 0, errs, facts: f, baselineSummary: f.baseline };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, errs: result.errs, baseline: f.baseline, upgrade: f.upgrade, backup: f.preMigrationBackup, negatives: { blob: f.negBlobRejected, msg: f.negMessageRejected, token: f.negTokenRejected, outbox: f.negOutboxRejected }, oldOnUpgraded: f.oldOnUpgraded, oldOnRestored: f.oldOnRestored }));
  process.exit(result.ok ? 0 : 10);
})().catch((err) => {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2));
  console.error(String(err && err.stack || err));
  process.exit(1);
});
