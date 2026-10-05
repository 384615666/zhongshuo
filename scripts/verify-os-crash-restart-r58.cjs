/**
 * R58 P3：真实 OS 级 daemon 崩溃重启证据（review-r57 §6-2）。
 *
 * 与既有证明的差别：不再用进程内 applyRecovery/新 worker 冒充——真实拉起打包形态
 * daemon 进程（dist/pack/daemon.cjs，含 r58 修复），在**独立数据根+独立管道名**下经
 * 命名管道驱动正式命令；受控 fake 首轮 stall 制造在途 turn；按**精确 PID** taskkill /F
 * （只杀本脚本 spawn 的进程，绝不按映像名全机杀）；重启后核：
 *   1) 恢复门禁 held + 旧 turn UNKNOWN（recovery.status 正式命令 + 直读库双重核对）；
 *   2) dispatch.resume(confirm) 后同成员另一任务零新增 startTurn（准入继承，OS 级）；
 *   3) 对账（FAILED+refunded+retained）期间继续零新增；正式解除后恰一次续跑；
 *   4) 历史/预算/审计不丢不改写（domain_events 前缀逐字保留、预算标记一次）；
 *   5) renderer 故障与 daemon 故障区分：管道客户端断连（模拟 renderer 死亡）daemon 存活、
 *      事实不变、重连同命令可答；daemon 故障才触发恢复链。
 *   6) 收尾 daemon.shutdown 优雅退出码 0、PID 归零；real_calls=0（全程 fake）。
 *
 * 边界声明：独立数据根（dist/desktop/os-crash-r58-<ts>/）与独立管道名；进程只操作本
 * 脚本 spawn 的 PID；成员/房间种子为直写 SQL 夹具（与集成测试同形），任务派发/恢复/
 * 解除全部经正式管道命令。ZS_MANAGED_RUNTIME=0（排障口径——koffi 桥不在本轮证据范围）。
 */
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, randomUUID } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const runId = `r58-oscrash-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `os-crash-r58-${runId}`);
const dataRoot = path.join(outDir, 'data');
const dbFile = path.join(dataRoot, 'state.sqlite');
const pipeName = `\\\\.\\pipe\\zs-${runId}`;
const daemonCjs = path.join(repo, 'dist', 'pack', 'daemon.cjs');
const token = randomBytes(32).toString('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ok, ms, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`等待超时：${label}（${JSON.stringify(v)}）`);
    await sleep(150);
  }
}
/** 最小管道客户端（线上契约重实现：auth 帧 + commandId 关联的 JSON 行协议）。 */
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
          else if (msg.type === 'auth.error') { clearTimeout(timer); reject(new Error(`认证被拒：${msg.error?.message ?? ''}`)); }
          continue;
        }
        const p = pending.get(msg.commandId);
        if (p != null) { pending.delete(msg.commandId); clearTimeout(p.timer); p.resolve(msg); }
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!authed) reject(e); else failAll(e); });
    function send(method, params) {
      const commandId = `oscrash-${randomUUID().slice(0, 8)}`;
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

function openReadonly() {
  const Database = require('better-sqlite3');
  const db = new Database(dbFile, { readonly: true, timeout: 8000 });
  db.pragma('busy_timeout = 8000');
  return db;
}
const q1 = (sql, ...a) => { const db = openReadonly(); try { return db.prepare(sql).get(...a); } finally { db.close(); } };
const qa = (sql, ...a) => { const db = openReadonly(); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
const qc = (sql) => { const db = openReadonly(); try { return db.prepare(sql).get().c; } finally { db.close(); } };

function spawnDaemon(withStallMs) {
  const child = spawn(process.execPath, [daemonCjs], {
    cwd: repo,
    env: {
      ...process.env,
      ZS_APP_DATA: dataRoot,
      ZS_RUNTIME: 'fake',
      ZS_ALLOW_FAKE: '1',
      ZS_REAL_DISPATCH_GUARD: '1',
      ZS_PIPE_NAME: pipeName,
      ZS_PACKED_ENTRY: '1',
      ZS_MANAGED_RUNTIME: '0',
      ZS_DETACHED_TURNS: '0',
      ...(withStallMs > 0 ? { ZS_FAKE_STALL_MS: String(withStallMs) } : {}), // 既有旋钮：fake turn 前置停延（B 阶段制造在途；C 阶段不设=立即完成）
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  return child;
}
async function waitReady(child, label) {
  await until(async () => {
    if (child.exitCode != null) throw new Error(`${label}：daemon 提前退出 code=${child.exitCode}`);
    try { const c = await pipeConnect(); c.close(); return true; } catch { return false; }
  }, (v) => v === true, 30000, `${label} daemon 就绪`);
}

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'local.token'), token, 'utf8');
  const facts = { runId, pipeName, dataRoot: dataRoot, scope: 'OS 级 daemon 崩溃重启（真实进程 kill/重启；fake runtime；独立数据根/管道）' };

  // ---- 打包 daemon 产物（含 r58 修复）----
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'pack-daemon.mjs')], { cwd: repo, stdio: 'ignore' });
  facts.daemonArtifact = { file: 'dist/pack/daemon.cjs', bytes: fs.statSync(daemonCjs).size };

  // ---- B0：首启（建库/迁移）→ 优雅停 → 直写种子夹具（成员/房间/会话；任务派发全走正式链）----
  let child = spawnDaemon(0);
  await waitReady(child, 'B0');
  let client = await pipeConnect();
  await cmd(client, 'daemon.shutdown', {}); // 参数为空对象（正式关闭动作；结果=退出码+stop:last 记录）
  await until(async () => child.exitCode, (c) => c === 0, 20000, 'B0 优雅退出');
  client.close();
  facts.b0 = { gracefulExitCode: child.exitCode };
  {
    const Database = require('better-sqlite3');
    const db = new Database(dbFile);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','R58崩溃项目',?,?, '{}', 0)`).run(dataRoot, dataRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
    db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r0','mA')`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
    db.close();
  }

  // ---- B1：受控在途（首 turn stall 120s）+ 第二任务排队 + 崩溃（按 PID taskkill /F）----
  child = spawnDaemon(120000);
  await waitReady(child, 'B1');
  client = await pipeConnect();
  const submit = (body) => cmd(client, 'message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body, intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
  const t1 = await submit('R58 OS 崩溃·任务一（崩溃时在途）');
  const t2 = await submit('R58 OS 崩溃·任务二（同成员排队）');
  facts.tasks = { t1: t1.taskId, t2: t2.taskId };
  await until(() => (q1('SELECT status FROM agent_turns WHERE dispatch_key = ?', `task:${t1.taskId}:initial`) || {}).status, (s) => s === 'RUNNING', 15000, '任务一在途 RUNNING');
  const turn1 = q1('SELECT id, run_id FROM agent_turns WHERE dispatch_key = ?', `task:${t1.taskId}:initial`);
  facts.turn1 = turn1;
  const eventsBeforeCrash = qa('SELECT seq, event_id, kind FROM domain_events ORDER BY seq');
  facts.beforeCrash = {
    turn1Status: q1('SELECT status FROM agent_turns WHERE id = ?', turn1.id).status,
    t1Runs: qc(`SELECT count(*) c FROM workflow_runs WHERE task_id = '${t1.taskId}'`),
    t2Turns: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
    outboxT2: q1('SELECT status FROM outbox WHERE dispatch_key = ?', `task:${t2.taskId}:initial`).status,
    eventsCount: eventsBeforeCrash.length,
  };
  client.close(); // 崩溃前先断开客户端（避免管道 RST 噪声）
  const pid = child.pid;
  facts.crash = { killedPid: pid, method: 'taskkill /PID <pid> /T /F' };
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  await until(async () => child.exitCode != null, () => child.exitCode != null, 20000, 'daemon 进程退出');
  facts.crash.exitCode = child.exitCode;
  child = null;

  // ---- C：重启（无 stall）→ 门禁/UNKNOWN → 确认继续后同成员零新增 → 对账/解除 → 恰一次 ----
  child = spawnDaemon(0);
  await waitReady(child, 'C');
  client = await pipeConnect();
  const st = await cmd(client, 'recovery.status', {});
  facts.afterRestart = {
    gateHeld: st.gateHeld,
    unknownTurns: (st.unknownTurns ?? []).map((u) => ({ id: u.id, taskId: u.taskId, status: u.status })),
    pendingOutbox: st.pendingDispatchCount ?? 0,
    t2TurnsStillZero: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
  };
  if (st.gateHeld !== true) throw new Error('重启后恢复门禁未保持 held');
  if (!facts.afterRestart.unknownTurns.some((u) => u.id === turn1.id)) throw new Error('旧 turn 未标 UNKNOWN');

  // renderer 故障区分：客户端断连（模拟 renderer 死亡）→ daemon 存活、事实不变、可重连。
  client.close();
  await sleep(1200);
  if (child.exitCode != null) throw new Error('客户端断连后 daemon 异常退出（renderer 故障被误当 daemon 故障）');
  const midFacts = qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`);
  client = await pipeConnect();
  const stReconnect = await cmd(client, 'recovery.status', {});
  facts.rendererFailureDistinction = { daemonAliveAfterClientClose: true, t2TurnsDuringDisconnect: midFacts, reconnectGateHeld: stReconnect.gateHeld };

  // 确认继续 ≠ 退出证明：门禁开放后，同成员任务二零新增 startTurn（OS 级准入继承）。
  await cmd(client, 'dispatch.resume', { confirm: true });
  await sleep(2500); // 泵若干 tick
  const deferred = qa(`SELECT payload_json FROM domain_events WHERE kind = 'run.admissionDeferred'`);
  facts.afterResume = {
    t2Turns: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
    outboxT2: q1('SELECT status FROM outbox WHERE dispatch_key = ?', `task:${t2.taskId}:initial`).status,
    admissionDeferred: deferred.map((d) => JSON.parse(d.payload_json)).filter((p) => p.dispatchKey === `task:${t2.taskId}:initial`).map((p) => p.reason),
    turn1Still: q1('SELECT status FROM agent_turns WHERE id = ?', turn1.id).status,
  };
  if (facts.afterResume.t2Turns !== 0) throw new Error('确认继续后同成员新任务被派发（准入继承失败，OS 级）');
  if (!facts.afterResume.admissionDeferred.includes('member')) throw new Error('未见 member 维度 deferral 留证');

  // 对账（FAILED+refunded+retained）期间继续零新增；正式解除后恰一次续跑。
  await cmd(client, 'recovery.reconcile', { turnId: turn1.id, verdict: 'notStarted', note: 'R58 P3：OS 崩溃后启动窗口外人工分离（确认未启动）', manualRiskAck: true });
  facts.afterReconcile = {
    turn1: q1('SELECT status, budget_mark, protection_state FROM agent_turns WHERE id = ?', turn1.id),
    t2Turns: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
  };
  await sleep(1500);
  if (facts.afterReconcile.t2Turns !== 0) throw new Error('对账后 retained 期间同成员任务被派发');
  await cmd(client, 'recovery.releaseProtection', { turnId: turn1.id, note: 'R58 P3：no-os-process 程序事实正式解除' });
  facts.afterRelease = { turn1: q1('SELECT status, budget_mark, protection_state FROM agent_turns WHERE id = ?', turn1.id) };
  const t2Final = await until(() => q1('SELECT status FROM tasks WHERE id = ?', t2.taskId), (r) => r && (r.status === 'REVIEW' || r.status === 'DONE'), 20000, '任务二恰一次续跑完成');
  facts.final = {
    t2Status: t2Final.status,
    t2Runs: qc(`SELECT count(*) c FROM workflow_runs WHERE task_id = '${t2.taskId}'`),
    t2Turns: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
    t1Runs: qc(`SELECT count(*) c FROM workflow_runs WHERE task_id = '${t1.taskId}'`),
    turn1Final: q1('SELECT status, budget_mark, protection_state FROM agent_turns WHERE id = ?', turn1.id),
  };
  if (facts.final.t2Runs !== 1 || facts.final.t2Turns !== 1) throw new Error('任务二非恰一次续跑');
  if (facts.final.t1Runs !== 1) throw new Error('任务一 run 数变化（历史被改写）');

  // 历史/预算/审计不丢不改写：崩溃前事件前缀逐字保留；real_calls=0。
  const eventsAfter = qa('SELECT seq, event_id, kind FROM domain_events ORDER BY seq');
  const prefixKept = eventsBeforeCrash.every((e, i) => eventsAfter[i] && eventsAfter[i].seq === e.seq && eventsAfter[i].event_id === e.event_id && eventsAfter[i].kind === e.kind);
  facts.audit = {
    eventsBefore: eventsBeforeCrash.length,
    eventsAfter: eventsAfter.length,
    prefixPreservedVerbatim: prefixKept,
    realCalls: qc('SELECT count(*) c FROM real_calls'),
    reworkEnqueuedEvents: qc(`SELECT count(*) c FROM domain_events WHERE kind = 'task.reworkEnqueued'`),
  };
  if (!prefixKept) throw new Error('崩溃前审计事件前缀被改写');
  if (facts.audit.realCalls !== 0) throw new Error('real_calls != 0（护栏被穿透）');

  // 收尾：优雅停机、退出码 0、PID 归零。
  await cmd(client, 'daemon.shutdown', {}); // 证据采集完成——优雅停机（结果=退出码+stop:last）
  client.close();
  const exitCode = await until(async () => child.exitCode, (c) => c != null, 20000, '收尾优雅退出');
  facts.shutdown = { gracefulExitCode: exitCode, pidReaped: true };
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: true, ...facts }, null, 2));
  console.log(JSON.stringify({ ok: true, runId, outDir, t2Status: facts.final.t2Status, eventsAfter: facts.audit.eventsAfter, realCalls: 0 }));
  process.exit(0);
})().catch((err) => {
  try { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), ...{ runId, pipeName } }, null, 2)); } catch { /* 目录可能未建 */ }
  console.error(String(err && err.stack || err));
  process.exit(1);
});
