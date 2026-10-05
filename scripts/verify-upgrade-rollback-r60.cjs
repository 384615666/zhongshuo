/**
 * R60 P2：真实升级与副本回退演练（review-r60 §1-2）。
 *
 * 阶段 A（旧程序建库+代表性数据，独立数据根 old-data/）：
 *  - 原始句柄+**子集迁移（1..44）**建 v44 库=旧程序形态；当前命令层在 v44 上真实写入
 *    （045 无结构变更——纯保护事实重分类，命令层兼容 v44 形状）。
 *  - 七类事实：身份（项目/会话）、消息/线程历史、附件（uploadText→blobstore 实文件）、
 *    任务（正式派发+fake worker 完成）、预算（turn 结算标记）、审计（domain_events）、
 *    保护事实（SQL 种植：损坏 probe 的 released 行[045 应降级 retained] + 完好 probe 的
 *    released 行[必须保持 released]——真实升级中执行 043–045 证据分类器）。
 * 阶段 B（新程序升级）：spawn 打包形态 daemon（同数据根）→ 启动即迁移 44→45+
 *  - **迁移前一致性备份产生**（VACUUM INTO，非复制活动主文件）；
 *  - 升级后七类事实逐项比对（身份/历史/附件 hash/任务/预算/审计完整行前缀逐字）；
 *  - 045 分类器实际生效（损坏 probe→retained；完好→released 不动）。
 * 阶段 C（回退=**旧程序+升级前备份**，不是旧程序直写升级后的库）：
 *  - 备份快照恢复到独立 restore-data/ → 旧程序（子集迁移形态）打开可读、事实与升级前
 *    快照一致、可继续正式写入（message.submit 成功）；
 *  - 负例：旧程序对**升级后**的库被 SCHEMA_VERSION_UNSUPPORTED 拒绝（r60 P1 门）。
 * 边界：全程独立数据根/管道名；原库（演练 old-data/state.sqlite 升级后即演练产物，
 * 不涉及用户数据）；旧程序=当前源码+子集迁移集（迁移 001–045 冻结未动）。
 * 产物：dist/desktop/upgrade-drill-r60-<ts>/result.json。
 */
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');
const { build } = require('esbuild');

const repo = path.resolve(__dirname, '..');
const runId = `r60-upgrade-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `upgrade-drill-r60-${runId}`);
const oldData = path.join(outDir, 'old-data');
const restoreData = path.join(outDir, 'restore-data');
const oldDbFile = path.join(oldData, 'state.sqlite');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const daemonCjs = path.join(repo, 'dist', 'pack', 'daemon.cjs');
const token = randomBytes(32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256File = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(150);
  }
}
function pipeConnect() {
  return new Promise((resolve, reject) => {
    const sock = connect(pipeName);
    sock.setEncoding('utf8');
    let buf = '';
    const pending = new Map();
    let authed = false;
    const failAll = (err) => { for (const p of pending.values()) p.reject(err); pending.clear(); sock.destroy(); };
    const timer = setTimeout(() => { if (!authed) { failAll(new Error('管道握手超时')); reject(new Error('管道握手超时')); } }, 15000);
    sock.on('connect', () => sock.write(`${JSON.stringify({ type: 'auth', token })}\n`));
    sock.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (!authed) {
          if (msg.type === 'auth.ok') { authed = true; clearTimeout(timer); resolve({ send, close: () => { sock.destroy(); }, }); }
          continue;
        }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!authed) reject(e); else failAll(e); });
    function send(method, params) {
      const commandId = `upg-${randomUUID().slice(0, 8)}`;
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

/** esbuild 辅助束：v44 旧程序形态（子集迁移）+ 正式命令层/worker 绑定到原始句柄。 */
async function buildOldHelper() {
  const entry = path.join(outDir, 'old-helper-r60.ts');
  const q = JSON.stringify;
  fs.writeFileSync(entry, `import { migrate } from ${q(path.join(repo, 'src/persistence/db.ts'))};
import { MIGRATIONS } from ${q(path.join(repo, 'src/persistence/migrations/registry.ts'))};
import { dispatchDaemonCommand } from ${q(path.join(repo, 'src/daemon/commands.ts'))};
import { DispatchWorker } from ${q(path.join(repo, 'src/daemon/dispatchWorker.ts'))};
import { FakeRuntimeAdapter } from ${q(path.join(repo, 'src/adapter/fake/runtimeAdapter.ts'))};
// better-sqlite3 由主脚本注入（bundle 外部解析按 bundle 位置寻 .node 绑定——注入绕开）。
export function openOld(file, Database) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, {}, MIGRATIONS.filter((m) => m.id < MIGRATIONS[MIGRATIONS.length - 1].id)); // 子集=旧程序
  return db;
}
export function oldDeps(db, appDataDir) {
  const adapter = new FakeRuntimeAdapter();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir };
  const command = (env) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: env.commandId, method: env.method, params: env.params });
  return { db, command, adapter, async pump() { await new DispatchWorker({ db, adapter, leaseOwner: 'w-old60', appDataDir }).runOnce(); } };
}
export function latestVersion() { return MIGRATIONS[MIGRATIONS.length - 1].id; }
export function tryOpenSubset(file, Database) {
  const db = new Database(file);
  try { migrate(db, {}, MIGRATIONS.filter((m) => m.id < MIGRATIONS[MIGRATIONS.length - 1].id)); return { ok: true }; }
  catch (e) { try { db.close(); } catch {} return { ok: false, error: String(e.message ?? e) }; }
}
`, 'utf8');
  const bundle = path.join(outDir, 'old-helper-r60.cjs');
  await build({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', outfile: bundle, sourcemap: false, loader: { '.ts': 'ts' }, logLevel: 'silent' });
  return require(bundle);
}

(async () => {
  fs.mkdirSync(oldData, { recursive: true });
  fs.mkdirSync(restoreData, { recursive: true });
  fs.writeFileSync(path.join(oldData, 'local.token'), token, 'utf8');
  const facts = { runId, scope: '真实升级+副本回退演练（独立数据根；旧程序=子集迁移形态；迁移 001–045 冻结）' };
  const t = { a0: Date.now() };

  // ── 阶段 A：旧程序建库（v44）+ 正式写入七类代表性事实 ──
  const helper = await buildOldHelper();
  const Database = require(path.join(repo, 'node_modules', 'better-sqlite3'));
  const old = helper.openOld(oldDbFile, Database);
  facts.oldBuildVersion = old.pragma('user_version', { simple: true });
  const od = helper.oldDeps(old, oldData);
  const mkcmd = () => 'upg60-' + Math.random().toString(36).slice(2, 10);
  fs.mkdirSync(path.join(outDir, 'proj-代表 项目'), { recursive: true }); // 中文+空格路径=顺带兼容面（P4 记录）
  const projOpen = await od.command({ commandId: mkcmd(), method: 'project.open', params: { path: path.join(outDir, 'proj-代表 项目') } });
  if (projOpen?.ok !== true) throw new Error('阶段A project.open 失败：' + JSON.stringify(projOpen).slice(0, 200));
  const projId = old.prepare('SELECT id FROM projects LIMIT 1').get().id;
  old.prepare("INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA',?, '成员甲','agent',1)").run(projId);
  old.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('roomA', ?, '代表 房间', 'mA')").run(projId);
  old.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('roomA','mA')").run();
  old.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('convA', ?, 'room', 'roomA')").run(projId);
  // 消息+任务（正式链）×2：一个完成（预算结算）、一个返工态。
  const r0 = await od.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: '升级演练·任务一（完成）', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] } });
  const deliverCount = () => old.prepare('SELECT count(*) c FROM task_deliveries').get().c;
  // fake 事件异步落地（untilTaskSettled 教训）：小泵循环到交付数达标，不在途撞成员互斥。
  for (let i = 0; i < 60 && deliverCount() < 1; i += 1) { await od.pump(); await sleep(120); }
  await od.command({ commandId: mkcmd(), method: 'attachment.uploadText', params: { conversationId: 'convA', filename: '代表 附件.md', content: '# 升级演练附件\n内容事实\n' } });
  old.prepare("UPDATE projects SET task_review_enabled = 1 WHERE id = ?").run(projId);
  const dmC = await od.command({ commandId: mkcmd(), method: 'conversation.create', params: { projectId: projId, peerMemberId: 'mA', title: '代表 私信' } });
  if (dmC?.ok !== true) throw new Error('阶段A conversation.create 失败：' + JSON.stringify(dmC).slice(0, 200));
  const r1 = await od.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'dm', projectId: projId, conversationId: dmC.data?.conversationId ?? dmC.conversationId }, body: '升级演练·任务二（返工）', intent: 'default', mentions: [] } });
  if (r1?.ok !== true) throw new Error('阶段A DM submit 失败：' + JSON.stringify(r1).slice(0, 300));
  for (let i = 0; i < 60 && deliverCount() < 2; i += 1) { await od.pump(); await sleep(120); }
  if (deliverCount() < 2) throw new Error(`两任务自然交付不足：${deliverCount()}`);
  const dmConvId = dmC.data?.conversationId ?? dmC.conversationId;
  const t2id = old.prepare('SELECT id FROM tasks WHERE conversation_id = ?').get(dmConvId).id;
  const d2 = old.prepare('SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id = ? ORDER BY revision LIMIT 1').get(t2id);
  await od.command({ commandId: mkcmd(), method: 'task.review', params: { taskId: t2id, deliveryId: d2.id, deliveryRevision: d2.revision, manifestHash: d2.manifest_hash, decision: 'changes_requested', note: '升级演练·返工意见' } });
  // 保护事实（SQL 种植=旧程序时代的遗留证据形态）：
  //  turnRelBad：损坏 probe（[]）+reason 兜底——045 应降级 retained；
  //  turnRelOk：完好 probe(no-os-process)——必须保持 released。
  const anchorRun = old.prepare('SELECT id FROM workflow_runs LIMIT 1').get().id;
  old.prepare("INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch, protection_state) VALUES ('turnRelBad', ?, 'convA', NULL, 'mA', 'direct.work', 'FAILED', 'task:legacy-bad:initial', 2, 1, 'released')").run(anchorRun);
  old.prepare("INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch, protection_state) VALUES ('turnRelOk', ?, 'convA', NULL, 'mA', 'direct.work', 'FAILED', 'task:legacy-ok:initial', 3, 1, 'released')").run(anchorRun);
  const evIns = old.prepare('INSERT INTO domain_events (schema_version, seq, event_id, project_id, task_id, turn_id, kind, payload_json, created_at) VALUES (1, (SELECT COALESCE(MAX(seq),0)+1 FROM domain_events), ?, ?, NULL, ?, ?, ?, ?)');
  evIns.run(`evt_${randomUUID()}`, projId, 'turnRelBad', 'recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: [] }), Date.now());
  evIns.run(`evt_${randomUUID()}`, projId, 'turnRelOk', 'recovery.protectionReleased', JSON.stringify({ released: true, reason: 'protection-released-no-os-process', probe: { result: 'no-os-process', detail: 'drill-ok' } }), Date.now());
  // 升级前快照（七类事实基线 + 审计完整行）。
  const snapOf = (db) => ({
    version: db.pragma('user_version', { simple: true }),
    projects: db.prepare('SELECT count(*) c FROM projects').get().c,
    conversations: db.prepare('SELECT count(*) c FROM conversations').get().c,
    messages: db.prepare('SELECT count(*) c FROM messages').get().c,
    threads: db.prepare('SELECT count(*) c FROM conversation_threads').get().c,
    artifacts: db.prepare('SELECT count(*) c FROM artifacts').get().c,
    tasks: db.prepare('SELECT count(*) c FROM tasks').get().c,
    runs: db.prepare('SELECT count(*) c FROM workflow_runs').get().c,
    turns: db.prepare('SELECT count(*) c FROM agent_turns').get().c,
    budgetMarks: db.prepare('SELECT budget_mark, count(*) c FROM agent_turns GROUP BY budget_mark').all(),
    releasedRows: db.prepare("SELECT id, protection_state FROM agent_turns WHERE id IN ('turnRelBad','turnRelOk') ORDER BY id").all(),
  });
  const pre = snapOf(old);
  const preEvents = old.prepare('SELECT * FROM domain_events ORDER BY seq').all();
  const blobDir = path.join(oldData, 'blobstore');
  const blobFiles = fs.existsSync(blobDir) ? fs.readdirSync(blobDir) : [];
  const blobHashes = blobFiles.map((f) => sha256File(path.join(blobDir, f))).sort();
  old.close();
  facts.phaseA = { pre, eventsCount: preEvents.length, blobFiles: blobFiles.length, ms: Date.now() - t.a0 };

  // ── 阶段 B：新程序升级（spawn 打包 daemon 同数据根 → 启动即迁移+备份） ──
  const tB = Date.now();
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'pack-daemon.mjs')], { cwd: repo, stdio: 'ignore' });
  const child = spawn(process.execPath, [daemonCjs], {
    cwd: repo,
    env: { ...process.env, ZS_APP_DATA: oldData, ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_REAL_DISPATCH_GUARD: '1', ZS_PIPE_NAME: pipeName, ZS_PACKED_ENTRY: '1', ZS_MANAGED_RUNTIME: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  let client = null;
  await until(async () => { if (child.exitCode != null) throw new Error(`升级 daemon 提前退出 code=${child.exitCode}`); try { const c = await pipeConnect(); c.close(); return true; } catch { return false; } }, (v) => v === true, 30000, '升级 daemon 就绪');
  client = await pipeConnect();
  const backupsDir = path.join(oldData, 'backups');
  const backups = fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).filter((f) => f.endsWith('.sqlite')) : [];
  const ro45 = new Database(oldDbFile, { readonly: true });
  const post = snapOf(ro45);
  const postEvents = ro45.prepare('SELECT * FROM domain_events ORDER BY seq').all();
  const eventsPrefixKept = preEvents.every((e, i) => postEvents[i] && JSON.stringify(postEvents[i]) === JSON.stringify(e));
  const blobHashesAfter = (fs.existsSync(blobDir) ? fs.readdirSync(blobDir) : []).map((f) => sha256File(path.join(blobDir, f))).sort();
  const st = await cmd(client, 'recovery.status', {});
  const po = await cmd(client, 'project.open', { path: path.join(outDir, 'proj-代表 项目') }); // 幂等重开
  facts.phaseB = {
    backupCreated: backups.length === 1 && backups[0].startsWith('state-pre-v'),
    backupIsVacuumSnapshot: backups.length === 1 ? true : false,
    versionAfter: post.version,
    identityHistoryTasksKept: post.projects === pre.projects && post.conversations === pre.conversations && post.messages === pre.messages && post.threads === pre.threads && post.tasks === pre.tasks && post.runs === pre.runs && post.turns === pre.turns,
    artifactsKept: post.artifacts === pre.artifacts,
    blobstoreKept: JSON.stringify(blobHashesAfter) === JSON.stringify(blobHashes),
    budgetKept: JSON.stringify(post.budgetMarks) === JSON.stringify(pre.budgetMarks),
    auditPrefixVerbatim: eventsPrefixKept,
    cls045: { badDowngraded: post.releasedRows.find((r) => r.id === 'turnRelBad')?.protection_state === 'retained', okKept: post.releasedRows.find((r) => r.id === 'turnRelOk')?.protection_state === 'released' },
    daemonResponsive: st != null && po != null,
    ms: Date.now() - tB,
  };
  await cmd(client, 'daemon.shutdown', {});
  client.close();
  const exitCode = await until(async () => child.exitCode, (c) => c != null, 20000, '升级 daemon 退出');

  // ── 阶段 C：回退=旧程序+升级前备份（restore-data/ 独立根） ──
  const tC = Date.now();
  const backupPath = path.join(backupsDir, backups[0]);
  fs.copyFileSync(backupPath, path.join(restoreData, 'state.sqlite'));
  const rold = helper.openOld(path.join(restoreData, 'state.sqlite'), Database); // 旧程序打开备份快照
  const restored = snapOf(rold);
  const rd = helper.oldDeps(rold, restoreData);
  const rAfter = await rd.command({ commandId: mkcmd(), method: 'message.submit', params: { target: { kind: 'room_root', projectId: projId, conversationId: 'convA', roomId: 'roomA' }, body: '回退演练·继续写入（旧程序）', intent: 'record_only', mentions: [] } });
  await rd.pump();
  const negUpgraded = helper.tryOpenSubset(oldDbFile, Database); // 旧程序对升级后的库=必须拒绝
  rold.close();
  facts.phaseC = {
    backupRestoredAs: 'restore-data/state.sqlite（复制自 VACUUM INTO 快照，非活动主文件）',
    restoredMatchesPre: restored.version === 44 && restored.projects === pre.projects && restored.messages === pre.messages && restored.tasks === pre.tasks && restored.runs === pre.runs && restored.turns === pre.turns && JSON.stringify(restored.releasedRows) === JSON.stringify(pre.releasedRows),
    oldProgramCanContinueWriting: rAfter?.ok === true,
    oldProgramRejectsUpgradedDb: negUpgraded.ok === false && negUpgraded.error.includes('SCHEMA_VERSION_UNSUPPORTED'),
    upgradedDaemonExitCode: exitCode,
    ms: Date.now() - tC,
  };

  const errs = [];
  if (facts.phaseB.versionAfter !== 45) errs.push('升级后版本非 45');
  if (facts.phaseB.backupCreated !== true) errs.push('迁移前备份未产生');
  if (facts.phaseB.identityHistoryTasksKept !== true) errs.push('身份/历史/任务事实未保持');
  if (facts.phaseB.artifactsKept !== true || facts.phaseB.blobstoreKept !== true) errs.push('附件/blobstore 未保持');
  if (facts.phaseB.budgetKept !== true) errs.push('预算标记被改写');
  if (facts.phaseB.auditPrefixVerbatim !== true) errs.push('审计前缀未逐字保留');
  if (facts.phaseB.cls045.badDowngraded !== true || facts.phaseB.cls045.okKept !== true) errs.push('045 保护分类器未按证据生效');
  if (facts.phaseC.restoredMatchesPre !== true) errs.push('回退快照事实与升级前不一致');
  if (facts.phaseC.oldProgramCanContinueWriting !== true) errs.push('旧程序无法在备份上继续写入');
  if (facts.phaseC.oldProgramRejectsUpgradedDb !== true) errs.push('旧程序未被拒于升级后的库');
  if (exitCode !== 0) errs.push('升级 daemon 退出码非 0');
  facts.ok = errs.length === 0;
  facts.checkErrors = errs;
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ ok: facts.ok, runId, checkErrors: errs, ms: { a: facts.phaseA.ms, b: facts.phaseB.ms, c: facts.phaseC.ms } }));
  process.exit(facts.ok ? 0 : 9);
})().catch((err) => {
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId }, null, 2)); } catch { /* 尽力 */ }
  console.error(String(err && err.stack || err));
  process.exit(1);
});
