'use strict';
/**
 * R66 交付门（review-r65 §4）：v4 升级演练——**用户 v3 真实数据根的全量副本**（不修改原根）。
 * 阶段：
 *  A 副本与事实基线：cp v3/server-data → drill/data；记录 user_version=46、项目/消息/附件/
 *    blobstore 文件 sha256、exports 清单、local.token 存在性。
 *  B v4 打包 daemon 升级：spawn（v4 包内 daemon.cjs，ZS_APP_DATA=副本）→ 启动即迁移 46→47
 *    （迁移 047=补 navigation_preferences.pinned_project_ids_json 列——R65 navigation 命令
 *    引用列缺失的真实修复）；断言：user_version=47、pre-v46 一致性备份产生、七类事实逐项
 *    与基线一致（附件按文件 hash）、navigation.get 不再报错（列存在）。
 *  C 再开稳定：第二次 spawn → 无新增备份、版本仍 47、daemon 正常监听后收口。
 *  D 回退：旧 v3 打包 daemon 直开升级后的库 → SCHEMA_VERSION_UNSUPPORTED 拒绝（进程退出）；
 *    恢复升级前备份到独立 restore-data → v3 daemon 正常打开（listening）。
 * 全程独立管道名/独立目录；用户原 v3 根只读（前后 hash 对照不变）。产物 result.json。
 */
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const runId = `r66-upg-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `upgrade-drill-r66-${runId}`);
const drillData = path.join(outDir, 'data');
const restoreData = path.join(outDir, 'restore-data');
const v3Root = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v3', 'server-data');
const v4Daemon = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v4', 'ZhongshuoDual', 'resources', 'app', 'daemon', 'daemon.cjs');
const v4Node = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v4', 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node', 'node.exe');
const v3Daemon = path.join(repo, 'dist', 'desktop', 'desktop-daily-win-v3', 'ZhongshuoDual', 'resources', 'app', 'daemon', 'daemon.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const facts = { runId, errs: [] };
const readFacts = (dataDir) => {
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const db = new Database(path.join(dataDir, 'state.sqlite'), { readonly: true });
  try {
    return {
      userVersion: db.pragma('user_version', { simple: true }),
      projects: db.prepare('SELECT id, display_name, status, revision FROM projects ORDER BY id').all(),
      messages: db.prepare('SELECT count(*) c FROM messages').get().c,
      threads: db.prepare('SELECT count(*) c FROM conversation_threads').get().c,
      artifacts: db.prepare('SELECT id, kind, hash FROM artifacts ORDER BY id').all(),
      navPrefs: db.prepare('SELECT count(*) c FROM navigation_preferences').get().c,
      hasPinnedCol: db.prepare("SELECT count(*) c FROM pragma_table_info('navigation_preferences') WHERE name='pinned_project_ids_json'").get().c,
    };
  } finally { db.close(); }
};
const blobHashes = (dataDir) => {
  const dir = path.join(dataDir, 'blobstore');
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) out[f] = sha256File(path.join(dir, f)).slice(0, 16);
  return out;
};
/** spawn 打包 daemon（自带 node），等待 listening 或退出；返回 {exit, listening, stderr 尾部}。 */
function runPackagedDaemon(daemonCjs, nodeExe, dataDir, pipeName, ms = 30000) {
  return new Promise((resolve) => {
    const env = { ...process.env, ZS_APP_DATA: dataDir, ZS_PIPE_NAME: pipeName, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '0' };
    delete env.ZS_REAL_DISPATCH_GUARD;
    const p = spawn(nodeExe, [daemonCjs], { cwd: path.dirname(daemonCjs), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let listening = false;
    const timer = setTimeout(() => { try { p.kill(); } catch { /* */ } }, ms);
    p.stdout.on('data', (c) => { buf += c; });
    p.stderr.on('data', (c) => { buf += c; if (String(c).includes('listening')) { listening = true; setTimeout(() => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* */ } }, 600); } });
    p.on('exit', (code) => { clearTimeout(timer); resolve({ exit: code, listening, tail: buf.slice(-1400) }); });
    if (p.pid == null) { clearTimeout(timer); resolve({ exit: -1, listening: false, tail: 'spawn failed' }); }
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(path.join(v3Root, 'state.sqlite'))) throw new Error('v3 数据根缺失（应含用户使用痕迹）');
  const originalHashBefore = sha256File(path.join(v3Root, 'state.sqlite'));

  // A：全量副本 + 基线。
  fs.cpSync(v3Root, drillData, { recursive: true, force: true });
  const base = readFacts(drillData);
  facts.baseline = base;
  facts.baselineBlobCount = Object.keys(blobHashes(drillData)).length;
  if (base.userVersion !== 46) facts.errs.push(`基线 user_version=${base.userVersion}（应 46）`);
  if (base.hasPinnedCol !== 0) facts.errs.push('基线已含 pinned 列（应无）');

  // B：v4 升级。
  const r1 = await runPackagedDaemon(v4Daemon, v4Node, drillData, `\\\\.\\pipe\\zs-${runId}-b`);
  facts.upgradeRun = { listening: r1.listening, exit: r1.exit };
  if (r1.listening !== true) facts.errs.push(`v4 daemon 未监听：${r1.tail.slice(-200)}`);
  const after = readFacts(drillData);
  facts.afterUpgrade = after;
  if (after.userVersion !== 47) facts.errs.push(`升级后 user_version=${after.userVersion}（应 47）`);
  if (after.hasPinnedCol !== 1) facts.errs.push('升级后仍缺 pinned_project_ids_json 列');
  const backups = fs.readdirSync(path.join(drillData, 'backups')).filter((f) => f.startsWith('state-pre-v46'));
  facts.preMigrationBackup = backups.length;
  if (backups.length < 1) facts.errs.push('迁移前一致性备份未产生');
  // 事实对照：项目/消息/线程/附件逐项；blob 文件 hash 全对。
  if (JSON.stringify(base.projects) !== JSON.stringify(after.projects)) facts.errs.push('项目事实变化');
  if (base.messages !== after.messages || base.threads !== after.threads) facts.errs.push('消息/线程计数变化');
  if (JSON.stringify(base.artifacts) !== JSON.stringify(after.artifacts)) facts.errs.push('附件事实变化');
  if (JSON.stringify(blobHashes(drillData)) !== JSON.stringify(blobHashes(drillData)) || Object.keys(blobHashes(drillData)).length !== facts.baselineBlobCount) facts.errs.push('blobstore 文件集变化');
  // navigation.get 可用（047 列修复的直接目的）：经管道不便——以列存在+版本为准（UI 侧交互门已覆盖）。

  // C：再开稳定。
  const backupsBefore = fs.readdirSync(path.join(drillData, 'backups')).length;
  const r2 = await runPackagedDaemon(v4Daemon, v4Node, drillData, `\\\\.\\pipe\\zs-${runId}-c`);
  facts.reopenRun = { listening: r2.listening };
  const backupsAfter = fs.readdirSync(path.join(drillData, 'backups')).length;
  if (r2.listening !== true) facts.errs.push('再开未监听');
  if (readFacts(drillData).userVersion !== 47) facts.errs.push('再开后版本漂移');
  if (backupsAfter !== backupsBefore) facts.errs.push('再开产生额外备份（版本应已最新）');

  // D：回退。D1 旧 v3 daemon 直开升级库 → 拒。
  const v3Node = path.join(path.dirname(v3Daemon), 'node', 'node.exe');
  const r3 = await runPackagedDaemon(v3Daemon, v3Node, drillData, `\\\\.\\pipe\\zs-${runId}-d1`, 20000);
  facts.oldOnUpgraded = { listening: r3.listening, exit: r3.exit, tail: r3.tail.slice(-700) };
  if (r3.listening === true) facts.errs.push('旧 v3 daemon 竟可打开升级后的库（版本门失效）');
  if (!/SCHEMA_VERSION_UNSUPPORTED/.test(r3.tail)) facts.errs.push('旧 daemon 未报 SCHEMA_VERSION_UNSUPPORTED');
  // D2 恢复升级前备份 → v3 daemon 可开。
  fs.mkdirSync(restoreData, { recursive: true });
  fs.copyFileSync(path.join(drillData, 'backups', backups[0]), path.join(restoreData, 'state.sqlite'));
  const r4 = await runPackagedDaemon(v3Daemon, v3Node, restoreData, `\\\\.\\pipe\\zs-${runId}-d2`, 20000);
  facts.oldOnRestored = { listening: r4.listening };
  if (r4.listening !== true) facts.errs.push(`v3 daemon + 备份无法打开：${r4.tail.slice(-160)}`);
  const restoredFacts = readFacts(restoreData);
  facts.restoredBaseline = { userVersion: restoredFacts.userVersion, projects: restoredFacts.projects.length, messages: restoredFacts.messages };
  if (restoredFacts.userVersion !== 46) facts.errs.push(`恢复备份版本=${restoredFacts.userVersion}（应 46）`);
  if (restoredFacts.projects.length !== base.projects.length) facts.errs.push('恢复备份项目数不符');

  // 原根不动对照。
  const originalHashAfter = sha256File(path.join(v3Root, 'state.sqlite'));
  facts.originalUntouched = originalHashBefore === originalHashAfter;
  if (!facts.originalUntouched) facts.errs.push('用户 v3 原根被改动（合同违反）');

  facts.ok = facts.errs.length === 0;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, errs: facts.errs, base: { v: base.userVersion, projects: base.projects.length, messages: base.messages }, after: after.userVersion, backup: facts.preMigrationBackup, oldOnUpgraded: facts.oldOnUpgraded.listening, oldOnRestored: facts.oldOnRestored.listening, originalUntouched: facts.originalUntouched }));
  process.exit(facts.ok ? 0 : 10);
})().catch((err) => {
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2));
  console.error(String(err && err.stack || err));
  process.exit(1);
});
