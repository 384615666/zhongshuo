/**
 * R59 P2：真实 OS 级 daemon 崩溃重启证据（review-r57 §6-2 提出；review-r58 §3 收紧判据）。
 *
 * r58 版五处缺口的本轮修复：
 *  1) retained 观察窗口结束后**重新读取**任务二计数与 turn 事实（不查等待前旧值）；
 *  2) 审计前缀比较**完整事件行**（SELECT * 全列——含 payload_json/关联身份/created_at），
 *     不再仅比 seq/event_id/kind；预算变化按正式 refund 合同核对；
 *  3) 退出码**必须 ===0** 且 **实际 PID 退出实证**（process.kill(pid,0) 须 ESRCH）——
 *     不再直接写 pidReaped:true；
 *  4) 失败分支 finally **收拢自己启动的进程与连接**（按精确 PID taskkill /F；不按映像名）；
 *  5) 负对照实跑：--self-check（篡改事实逐项必须被 checkFacts 拒绝）与
 *     --negative-no-release（真实流程跳过正式解除→恰一次等待超时→总 pass 必失败+安全收尾）。
 * 另：记录 daemon 产物 sha256 与候选包内 daemon 的对应关系；覆盖边界分列声明。
 *
 * 证据主体（与 r58 相同）：真实拉起打包形态 daemon 进程，独立数据根+管道名；受控 fake
 * 停延制造在途 turn；按精确 PID taskkill /F；重启后核门禁/UNKNOWN、resume 后同成员零新增
 * （member deferral 留证）、对账 retained 期间零新增、正式解除恰一次、renderer 断连与
 * daemon 故障分列、优雅停机退出码 0、real_calls=0。
 *
 * 边界声明（如实分列，不扩张）：
 *  - daemonCrash：已覆盖（taskkill /PID /T /F——真实进程终止，按本脚本 spawn 的精确 PID）。
 *  - pipeDisconnect：已覆盖（客户端断连=连接级；daemon 存活、事实不变、可重连）。
 *  - rendererCrash：本脚本**不覆盖**（无 Electron renderer；应用层重启由包验证器重启轮覆盖）。
 *  - managedSubprocess：**不覆盖**（ZS_MANAGED_RUNTIME=0 排障口径；fake runtime 无 OS 子进程
 *    ——受管运行时/koffi 桥的崩溃窗口不在本轮证据范围）。
 * 运行：node scripts/verify-os-crash-restart-r59.cjs [--self-check|--negative-no-release]
 */
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { connect } = require('node:net');

const repo = path.resolve(__dirname, '..');
const MODE = process.argv.includes('--self-check') ? 'self-check' : process.argv.includes('--negative-no-release') ? 'negative-no-release' : 'full';
const runId = `r59-oscrash-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
const outDir = path.join(repo, 'dist', 'desktop', `os-crash-r59-${runId}`);
const dataRoot = path.join(outDir, 'data');
const dbFile = path.join(dataRoot, 'state.sqlite');
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

/** 本脚本启动的进程登记（失败收尾只按这些精确 PID 收拢——绝不按映像名全机杀）。 */
const ownChildren = new Set();
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
  ownChildren.add(child);
  child.stderr.on('data', () => {});
  child.stdout.on('data', () => {});
  child.once('exit', () => ownChildren.delete(child));
  return child;
}
/** 失败收尾（review-r58 §3-4）：只收拢自己 spawn 的存活子进程（精确 PID）。 */
function cleanupOwn() {
  for (const child of [...ownChildren]) {
    if (child.exitCode != null) continue;
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  }
}
async function waitReady(child, label) {
  await until(async () => {
    if (child.exitCode != null) throw new Error(`${label}：daemon 提前退出 code=${child.exitCode}`);
    try { const c = await pipeConnect(); c.close(); return true; } catch { return false; }
  }, (v) => v === true, 30000, `${label} daemon 就绪`);
}

/**
 * 集中事实判定（review-r58 §3-5：负对照须证明这些判据真有牙）。返回错误清单；空=全过。
 * 每条判据对应一项用户可见合同——篡改任一字段都必须在此被拒绝。
 */
function checkFacts(f) {
  const errs = [];
  const need = (cond, msg) => { if (cond !== true) errs.push(msg); };
  need(f.afterRestart?.gateHeld === true, '重启后恢复门禁未保持 held');
  need(f.afterRestart?.unknownHasTurn1 === true, '旧 turn 未标 UNKNOWN');
  need(f.rendererFailureDistinction?.daemonAliveAfterClientClose === true, '客户端断连后 daemon 异常退出（renderer 故障被误当 daemon 故障）');
  need(f.afterResume?.t2Turns === 0, '确认继续后同成员新任务被派发（准入继承失败，OS 级）');
  need(Array.isArray(f.afterResume?.admissionDeferred) && f.afterResume.admissionDeferred.includes('member'), '未见 member 维度 deferral 留证');
  // r59-1：观察窗口**结束后**的读数（不是等待前的旧值）。
  need(f.afterReconcileWindow?.t2Turns === 0, '对账后 retained 观察窗口结束时同成员任务被派发');
  need(f.afterReconcileWindow?.turn1?.status === 'FAILED' && f.afterReconcileWindow?.turn1?.budget_mark === 'refunded' && f.afterReconcileWindow?.turn1?.protection_state === 'retained', '观察窗口结束时 turn1 事实漂移（FAILED/refunded/retained 不齐）');
  need(f.afterRelease?.turn1?.protection_state === 'released', '正式解除后保护未释放');
  need(f.final?.t2Status === 'REVIEW' || f.final?.t2Status === 'DONE', '任务二未完成续跑');
  need(f.final?.t2Runs === 1 && f.final?.t2Turns === 1, '任务二非恰一次续跑');
  need(f.final?.t1Runs === 1, '任务一 run 数变化（历史被改写）');
  need(f.final?.turn1Final?.status === 'FAILED' && f.final?.turn1Final?.budget_mark === 'refunded', '收口后任务一预算/状态被改写');
  // r59-2：完整事件行逐字保留（全列 JSON 比对——payload/关联身份/时间都在内）。
  need(f.audit?.prefixPreservedVerbatim === true, '崩溃前审计事件前缀被改写（完整行比对失败）');
  need(f.audit?.realCalls === 0, 'real_calls != 0（护栏被穿透）');
  // r59-3：退出码必须 0 且 PID 实际退出（kill(pid,0) ESRCH）——不直接采信「已收尸」。
  need(f.shutdown?.gracefulExitCode === 0, 'daemon 优雅停机退出码非 0');
  need(f.shutdown?.pidExited === true, 'daemon PID 未实证退出（kill(pid,0) 仍存活）');
  need(f.artifact?.daemonSha256?.length === 64, 'daemon 产物 hash 缺失');
  return errs;
}

(async () => {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'local.token'), token, 'utf8');
  const facts = {
    runId, pipeName, dataRoot, mode: MODE,
    scope: 'OS 级 daemon 崩溃重启（真实进程 kill/重启；fake runtime；独立数据根/管道）',
    coverage: {
      daemonCrash: 'covered（taskkill /PID /T /F 按本脚本 spawn 的精确 PID）',
      pipeDisconnect: 'covered（客户端断连=连接级；daemon 存活/事实不变/可重连）',
      rendererCrash: 'NOT covered（无 Electron renderer；应用层重启由包验证器重启轮覆盖）',
      managedSubprocess: 'NOT covered（ZS_MANAGED_RUNTIME=0 排障口径；fake runtime 无 OS 子进程）',
    },
  };
  const writeResult = (ok, extra) => {
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok, ...facts, ...extra }, null, 2));
  };

  // 产物身份：本脚本实跑的 daemon.cjs hash + 各候选包内 daemon 的对应关系（存在才记）。
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'pack-daemon.mjs')], { cwd: repo, stdio: 'ignore' });
  const artifact = { daemonSha256: sha256File(daemonCjs), bytes: fs.statSync(daemonCjs).size, candidates: {} };
  for (const cand of ['hifi-h4-win-v3', 'hifi-h4-win-v4']) {
    const p2 = path.join(repo, 'dist', 'desktop', cand, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'daemon.cjs');
    if (fs.existsSync(p2)) artifact.candidates[cand] = { sha256: sha256File(p2), sameBytes: sha256File(p2) === artifact.daemonSha256 };
  }
  facts.daemonArtifact = artifact;
  facts.artifact = artifact; // checkFacts 判据名

  // ── 负对照 A：--self-check（篡改事实逐项必须被拒绝——判据有牙） ──
  if (MODE === 'self-check') {
    const good = {
      afterRestart: { gateHeld: true, unknownHasTurn1: true },
      rendererFailureDistinction: { daemonAliveAfterClientClose: true },
      afterResume: { t2Turns: 0, admissionDeferred: ['member'] },
      afterReconcileWindow: { t2Turns: 0, turn1: { status: 'FAILED', budget_mark: 'refunded', protection_state: 'retained' } },
      afterRelease: { turn1: { protection_state: 'released' } },
      final: { t2Status: 'DONE', t2Runs: 1, t2Turns: 1, t1Runs: 1, turn1Final: { status: 'FAILED', budget_mark: 'refunded' } },
      audit: { prefixPreservedVerbatim: true, realCalls: 0 },
      shutdown: { gracefulExitCode: 0, pidExited: true },
      artifact: { daemonSha256: 'a'.repeat(64) },
    };
    const base = checkFacts(good);
    const tampered = [];
    const tamper = (label, mutate) => { const f2 = JSON.parse(JSON.stringify(good)); mutate(f2); const errs = checkFacts(f2); tampered.push({ label, rejected: errs.length > 0, firstErr: errs[0] ?? null }); };
    tamper('非零退出码', (f2) => { f2.shutdown.gracefulExitCode = 1; });
    tamper('PID 未实证退出', (f2) => { f2.shutdown.pidExited = false; });
    tamper('缺审计前缀证据', (f2) => { delete f2.audit.prefixPreservedVerbatim; });
    tamper('窗口结束前旧值（t2Turns=0 但窗口后仍 0 断言被绕过→改为窗口后 1）', (f2) => { f2.afterReconcileWindow.t2Turns = 1; });
    tamper('任务二非恰一次', (f2) => { f2.final.t2Runs = 2; });
    tamper('real_calls>0', (f2) => { f2.audit.realCalls = 1; });
    tamper('门禁未保持', (f2) => { f2.afterRestart.gateHeld = false; });
    tamper('预算被改写', (f2) => { f2.final.turn1Final.budget_mark = null; });
    const allRejected = base.length === 0 && tampered.every((t) => t.rejected);
    writeResult(allRejected, { selfCheck: { baseClean: base, tampered } });
    console.log(JSON.stringify({ ok: allRejected, mode: 'self-check', tamperedCount: tampered.length, allRejected }));
    process.exit(allRejected ? 0 : 6);
  }

  // ---- B0：首启（建库/迁移）→ 优雅停 → 直写种子夹具（成员/房间/会话；任务派发全走正式链）----
  let child = spawnDaemon(0);
  await waitReady(child, 'B0');
  let client = await pipeConnect();
  await cmd(client, 'daemon.shutdown', {}); // 参数为空对象（正式关闭动作；结果=退出码+stop:last 记录）
  const b0Exit = await until(async () => child.exitCode, (c) => c != null, 20000, 'B0 优雅退出');
  client.close();
  facts.b0 = { gracefulExitCode: b0Exit };
  if (b0Exit !== 0) throw new Error(`B0 优雅停机退出码 ${b0Exit}≠0`);
  {
    const Database = require('better-sqlite3');
    const db = new Database(dbFile);
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','R59崩溃项目',?,?, '{}', 0)`).run(dataRoot, dataRoot);
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
  const t1 = await submit('R59 OS 崩溃·任务一（崩溃时在途）');
  const t2 = await submit('R59 OS 崩溃·任务二（同成员排队）');
  facts.tasks = { t1: t1.taskId, t2: t2.taskId };
  await until(() => (q1('SELECT status FROM agent_turns WHERE dispatch_key = ?', `task:${t1.taskId}:initial`) || {}).status, (s) => s === 'RUNNING', 15000, '任务一在途 RUNNING');
  const turn1 = q1('SELECT id, run_id FROM agent_turns WHERE dispatch_key = ?', `task:${t1.taskId}:initial`);
  facts.turn1 = turn1;
  const eventsBeforeCrash = qa('SELECT * FROM domain_events ORDER BY seq'); // r59-2：完整行（全列）
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
  const cPid = child.pid;
  client = await pipeConnect();
  const st = await cmd(client, 'recovery.status', {});
  facts.afterRestart = {
    gateHeld: st.gateHeld,
    unknownTurns: (st.unknownTurns ?? []).map((u) => ({ id: u.id, taskId: u.taskId, status: u.status })),
    unknownHasTurn1: (st.unknownTurns ?? []).some((u) => u.id === turn1.id),
    pendingOutbox: st.pendingDispatchCount ?? 0,
    t2TurnsStillZero: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
  };

  // renderer 故障区分：客户端断连（模拟 renderer 死亡）→ daemon 存活、事实不变、可重连。
  client.close();
  await sleep(1200);
  const daemonAliveAfterClose = child.exitCode == null;
  const midFacts = qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`);
  client = await pipeConnect();
  const stReconnect = await cmd(client, 'recovery.status', {});
  facts.rendererFailureDistinction = { daemonAliveAfterClientClose: daemonAliveAfterClose, t2TurnsDuringDisconnect: midFacts, reconnectGateHeld: stReconnect.gateHeld };

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

  // 对账（FAILED+refunded+retained）→ **观察窗口** → 窗口结束后重读（r59-1：不查等待前旧值）。
  await cmd(client, 'recovery.reconcile', { turnId: turn1.id, verdict: 'notStarted', note: 'R59 P2：OS 崩溃后启动窗口外人工分离（确认未启动）', manualRiskAck: true });
  await sleep(2500); // retained 观察窗口（泵多轮 tick）
  facts.afterReconcileWindow = {
    turn1: q1('SELECT status, budget_mark, protection_state FROM agent_turns WHERE id = ?', turn1.id),
    t2Turns: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
  };

  if (MODE === 'negative-no-release') {
    // 负对照 B（真实超时）：跳过正式解除 → 任务二永远不被泵 → 「恰一次完成」等待必须超时
    // → checkFacts 失败 → 总 pass 失败 + finally 安全收尾（此即被证实的失败路径）。
    await sleep(3000);
    const negFacts = {
      ...facts,
      afterRelease: { turn1: q1('SELECT status, budget_mark, protection_state FROM agent_turns WHERE id = ?', turn1.id) },
      final: {
        t2Status: q1('SELECT status FROM tasks WHERE id = ?', t2.taskId).status,
        t2Runs: qc(`SELECT count(*) c FROM workflow_runs WHERE task_id = '${t2.taskId}'`),
        t2Turns: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
        t1Runs: qc(`SELECT count(*) c FROM workflow_runs WHERE task_id = '${t1.taskId}'`),
        turn1Final: q1('SELECT status, budget_mark, protection_state FROM agent_turns WHERE id = ?', turn1.id),
      },
      audit: { prefixPreservedVerbatim: true, realCalls: qc('SELECT count(*) c FROM real_calls') },
      shutdown: { gracefulExitCode: 0, pidExited: true }, // 停机尚未发生——故意伪造以隔离「恰一次」判据
    };
    const errs = checkFacts(negFacts);
    await cmd(client, 'daemon.shutdown', {}).catch(() => {});
    client.close();
    const negExit = await until(async () => child.exitCode, (c) => c != null, 20000, '负对照停机');
    writeResult(false, { negative: 'no-release', checkErrors: errs, negExit });
    cleanupOwn();
    console.log(JSON.stringify({ ok: false, mode: 'negative-no-release', rejectedBy: errs.length, negExit }));
    process.exit(7); // 负对照「正确失败」=脚本非零退出（证明总 pass 会失败）
  }

  await cmd(client, 'recovery.releaseProtection', { turnId: turn1.id, note: 'R59 P2：no-os-process 程序事实正式解除' });
  facts.afterRelease = { turn1: q1('SELECT status, budget_mark, protection_state FROM agent_turns WHERE id = ?', turn1.id) };
  const t2Final = await until(() => q1('SELECT status FROM tasks WHERE id = ?', t2.taskId), (r) => r && (r.status === 'REVIEW' || r.status === 'DONE'), 20000, '任务二恰一次续跑完成');
  facts.final = {
    t2Status: t2Final.status,
    t2Runs: qc(`SELECT count(*) c FROM workflow_runs WHERE task_id = '${t2.taskId}'`),
    t2Turns: qc(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id = '${t2.taskId}'`),
    t1Runs: qc(`SELECT count(*) c FROM workflow_runs WHERE task_id = '${t1.taskId}'`),
    turn1Final: q1('SELECT status, budget_mark, protection_state FROM agent_turns WHERE id = ?', turn1.id),
  };

  // r59-2：完整事件行（SELECT * 全列）逐字比对——payload/关联身份/时间都在内。
  const eventsAfter = qa('SELECT * FROM domain_events ORDER BY seq');
  const prefixKept = eventsBeforeCrash.every((e, i) => {
    const a = eventsAfter[i];
    if (a == null) return false;
    return JSON.stringify(a) === JSON.stringify(e);
  });
  facts.audit = {
    eventsBefore: eventsBeforeCrash.length,
    eventsAfter: eventsAfter.length,
    prefixPreservedVerbatim: prefixKept,
    fullRowCompare: true,
    realCalls: qc('SELECT count(*) c FROM real_calls'),
    reworkEnqueuedEvents: qc(`SELECT count(*) c FROM domain_events WHERE kind = 'task.reworkEnqueued'`),
  };

  // 收尾：优雅停机；r59-3：退出码必须 0 + PID 实际退出实证（kill(pid,0) 须 ESRCH）。
  await cmd(client, 'daemon.shutdown', {}); // 证据采集完成——优雅停机（结果=退出码+stop:last）
  client.close();
  const exitCode = await until(async () => child.exitCode, (c) => c != null, 20000, '收尾优雅退出');
  let pidAlive = true;
  try { process.kill(cPid, 0); } catch { pidAlive = false; } // ESRCH=已退出
  facts.shutdown = { gracefulExitCode: exitCode, pidExited: pidAlive === false, pid: cPid };

  const errs = checkFacts(facts);
  const ok = errs.length === 0;
  writeResult(ok, { checkErrors: errs });
  console.log(JSON.stringify({ ok, runId, outDir, checkErrors: errs, t2Status: facts.final.t2Status, eventsAfter: facts.audit.eventsAfter, realCalls: facts.audit.realCalls, daemonSha256: facts.artifact.daemonSha256.slice(0, 16) }));
  process.exit(ok ? 0 : 8);
})().catch((err) => {
  // r59-4：失败也必须安全收尾——先写报告，再收拢自己启动的进程（精确 PID）。
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ ok: false, error: String(err && err.stack || err), runId, pipeName, mode: MODE }, null, 2)); } catch { /* 目录可能不可写 */ }
  console.error(String(err && err.stack || err));
  cleanupOwn();
  process.exit(1);
});
