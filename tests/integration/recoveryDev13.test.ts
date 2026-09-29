/**
 * DEV-13 恢复与故障测试（2026-09-28 第六轮实装，零额度——本地进程/临时库/故障注入）：
 * - 崩溃现场（incomplete stop 挂起 turn→UNKNOWN）→ 重启恢复读取：applyRecovery 快照携带
 *   stopRecord/unknownTurnRows/activeUndos；门禁落下（不自动重放可能已产生副作用的请求）。
 * - recovery.status：UNKNOWN 明细+stop 记录+未收口撤销+租约（进程身份如实——不可判活不假装）。
 * - recovery.reconcile 三事实：
 *   · notStarted=确认未执行：预算**退款**（I-1 不加 U）+租约释放+turn FAILED 留证；
 *   · executed=确认已执行：结算（U+1）+租约释放+turn FAILED 留证；
 *   · keepUnknown=维持不确定：状态不动（不清空占位后放行）；
 *   · 非 UNKNOWN turn 拒绝对账；evidence 必填。
 * - 对账后不重放：outbox 不因 reconcile 重新派发（重复领取不重复扣减——既有 RT-03 守卫回归）。
 * - DEV-12 未记账场景接入：activeUndos 在恢复面可见，changeset.undo 续跑三向判定（联动断言）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { applyRecovery } from '../../src/daemon/stopFlow.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-dev13-'));
afterAll(() => {
  for (let i = 0; i < 3; i += 1) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ }
  }
});

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
}

function makeTask(db: ZhongshuoDatabase, n: number): string {
  const ids = { messageId: `vm${n}`, threadId: `vth${n}`, taskId: `vtk${n}`, taskEventId: `ve${n}`, threadEventId: `vh${n}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: n,
  });
  return ids.taskId;
}

async function cmd<T>(db: ZhongshuoDatabase, method: string, params: unknown): Promise<T> {
  const r = await dispatchDaemonCommand(
    { db, localUserId: 'u_dev13', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'appU') },
    { protocolVersion: 1, commandId: `cmd-rc-${randomUUID().slice(0, 8)}`, method, params },
  ) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}

describe('DEV-13：崩溃恢复面与 recovery.reconcile', () => {
  it('UNKNOWN 现场：恢复快照完整；reconcile notStarted=退款+租约释放+FAILED；executed=结算；keepUnknown 不动；非 UNKNOWN 拒绝', async () => {
    const dbFile = join(tmpRoot, 'dev13.sqlite');
    const db = openDatabase(dbFile);
    seed(db);
    const taskId = makeTask(db, 1);
    // 造 UNKNOWN 现场：正常派发一轮后手工置 UNKNOWN + 在途预算预留 + 持有租约（模拟崩溃）。
    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w13', appDataDir: join(tmpRoot, 'app') });
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    const runId = (db.prepare('SELECT id FROM workflow_runs WHERE task_id = ?').get(taskId) as { id: string }).id;
    const seedTurnId = 'turn_dev13_unknown_1';
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth1', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk1:crashprobe', 2, 2)`).run(seedTurnId, runId);
    db.prepare(`UPDATE workflow_runs SET budget_json = ?, status = 'INTERRUPTED' WHERE id = ?`)
      .run(JSON.stringify({ runMaxTurns: 6, usedTurns: 2, inFlightReservedTurns: 1, tailReservationByStage: {} }), runId);
    db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES ('d:/x', ?, 1, 0, 'active')`).run(seedTurnId);
    // 模拟 stop 未收口记录（daemon:stop:last）。
    db.prepare(`INSERT INTO daemon_state (key, value, updated_at) VALUES ('daemon:stop:last', ?, 1)`)
      .run(JSON.stringify({ at: 1, phase: 'incomplete', reason: '消费器未收敛(1)', drainPending: true }));
    db.close();

    // 「重启」：新连接读取恢复面。
    const db2 = openDatabase(dbFile);
    const snap = applyRecovery(db2, Date.now());
    expect(snap.unknownTurnRows.map((t) => t.turnId)).toContain(seedTurnId);
    expect(snap.stopRecord?.phase).toBe('incomplete');
    // recovery.status：UNKNOWN 明细+stop 记录+租约（进程身份如实注记）。
    const st = await cmd<{ unknownTurns: Array<{ id: string }>; stopRecord: { phase: string } | null; heldLeases: Array<{ owner_turn_id: string }>; leaseNote: string }>(db2, 'recovery.status', {});
    expect(st.unknownTurns.some((t) => t.id === seedTurnId)).toBe(true);
    expect(st.stopRecord?.phase).toBe('incomplete');
    expect(st.heldLeases.some((l) => l.owner_turn_id === seedTurnId)).toBe(true);
    expect(st.leaseNote).toContain('不证明');

    // 反例：非 UNKNOWN turn 拒绝对账；evidence 必填。
    const okTurn = (db2.prepare('SELECT id FROM agent_turns WHERE status = ? LIMIT 1').get('SUCCEEDED') as { id: string }).id;
    await expect(cmd(db2, 'recovery.reconcile', { turnId: okTurn, verdict: 'notStarted', evidence: { source: 'x', at: 1 } })).rejects.toThrow(/仅 UNKNOWN/);
    await expect(cmd(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'notStarted', evidence: { source: '', at: 1 } })).rejects.toThrow();

    // notStarted：退款（I-1 不加 U）+租约释放+turn FAILED 留证。
    const r1 = await cmd<{ verdict: string; stateChanged: boolean; releasedLeases: string[] }>(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'notStarted', evidence: { source: '进程取证：该请求从未到达 runtime（测试注入）', at: Date.now() } });
    expect(r1.stateChanged).toBe(true);
    expect(r1.releasedLeases).toEqual(['d:/x']);
    const budgetAfter = JSON.parse((db2.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(budgetAfter.usedTurns).toBe(2); // 未执行：不计数
    expect(budgetAfter.inFlightReservedTurns).toBe(0); // 预留退款
    expect((db2.prepare('SELECT status, budget_mark FROM agent_turns WHERE id = ?').get(seedTurnId) as { status: string; budget_mark: string })).toMatchObject({ status: 'FAILED', budget_mark: 'refunded' });
    expect((db2.prepare(`SELECT status FROM workspace_leases WHERE owner_turn_id = ?`).get(seedTurnId) as { status: string }).status).toBe('released');
    // 已 FAILED 的 turn 再对账=拒绝（幂等防双算）。
    await expect(cmd(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'executed', evidence: { source: '再算一次', at: Date.now() } })).rejects.toThrow(/仅 UNKNOWN/);

    // executed：另一个 UNKNOWN turn（结算语义）。
    const seedTurn2 = 'turn_dev13_unknown_2';
    db2.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth1', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk1:crashprobe2', 3, 3)`).run(seedTurn2, runId);
    db2.prepare(`UPDATE workflow_runs SET budget_json = ? WHERE id = ?`).run(JSON.stringify({ runMaxTurns: 6, usedTurns: 2, inFlightReservedTurns: 1, tailReservationByStage: {} }), runId);
    await cmd(db2, 'recovery.reconcile', { turnId: seedTurn2, verdict: 'executed', evidence: { source: '渠道账单：该请求已计费（测试注入）', at: Date.now() }, exitFact: 'exited', exitEvidence: { kind: 'osProcessCheck', pid: 4242, observedAt: Date.now(), alive: false } });
    const budget2 = JSON.parse((db2.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(budget2.usedTurns).toBe(3); // 已执行：计数
    expect(budget2.inFlightReservedTurns).toBe(0);

    // keepUnknown：状态不动。
    const seedTurn3 = 'turn_dev13_unknown_3';
    db2.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth1', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk1:crashprobe3', 4, 4)`).run(seedTurn3, runId);
    await cmd(db2, 'recovery.reconcile', { turnId: seedTurn3, verdict: 'keepUnknown', evidence: { source: '证据不足，保持观察', at: Date.now() } });
    expect((db2.prepare('SELECT status FROM agent_turns WHERE id = ?').get(seedTurn3) as { status: string }).status).toBe('UNKNOWN');
    // 对账后不重放：outbox 无 pending 派发残留、审计有 recovery.reconciled×3。
    const pending = (db2.prepare(`SELECT count(*) c FROM outbox WHERE status = 'pending'`).get() as { c: number }).c;
    expect(pending).toBe(0);
    const reconciled = (db2.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'recovery.reconciled'`).get() as { c: number }).c;
    expect(reconciled).toBe(3);
    db2.close();
  }, 30_000);

  it('DEV-12 未记账场景接入：activeUndos 在恢复面可见；changeset.undo 续跑三向判定（崩溃窗口样本）', async () => {
    const dir = join(tmpRoot, 'undo-recovery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f.txt'), 'one', 'utf8');
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('pU','u',?,?, '{}', 0)`).run(dir, dir);
    db.close();
    // 域函数路径（撤销恢复语义与连接无关——新句柄等价「重启后读取」）：
    const db2 = openDatabase(':memory:');
    db2.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('pU','u',?,?, '{}', 0)`).run(dir, dir);
    const { captureBaseline, finalizeChangeset, undoChangeset } = await import('../../src/daemon/changeset.ts');
    const appData = join(tmpRoot, 'appU');
    const b = captureBaseline(db2, { projectId: 'pU', paths: ['f.txt'], appDataDir: appData });
    if (!b.ok) throw new Error(b.error.message);
    writeFileSync(join(dir, 'f.txt'), 'TWO', 'utf8');
    finalizeChangeset(db2, { changeSetId: b.value.changeSetId, appDataDir: appData });
    // 崩溃窗口：rename 已成功、记账缺失（undo 记录停留 in_progress）。
    const crashed = undoChangeset(db2, { changeSetId: b.value.changeSetId, appDataDir: appData, crashAfterStepActions: 1 });
    expect(crashed.ok).toBe(true);
    // 恢复面：activeUndos 可见（统一恢复检查入口）。
    const st = await cmd<{ activeUndos: Array<{ undoId: string; status: string }>; undoNote: string }>(db2, 'recovery.status', {});
    expect(st.activeUndos.length).toBeGreaterThanOrEqual(1);
    expect(st.undoNote).toContain('三向判定');
    // 续跑（新连接语义=直接新 db 句柄亦可）：补记不重执行、不误判冲突。
    const resumed = await cmd<{ status: string }>(db2, 'changeset.undo', { changeSetId: b.value.changeSetId });
    expect(resumed.status).toBe('succeeded');
    const { readFileSync: rd } = await import('node:fs');
    expect(rd(join(dir, 'f.txt'), 'utf8')).toBe('one');
    db2.close();
  }, 30_000);
});

describe('DEV-13·下：恢复事实分离（执行/退出/成果）+同 daemon 准入联动', () => {
  it('executed+退出未知/存活：结算预算但保留租约与占位（不提前放行）；exited 须 OS 证据（userManual 拒绝）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 22);
    const adapter = new FakeRuntimeAdapter();
    await new DispatchWorker({ db, adapter, leaseOwner: 'w13b', appDataDir: join(tmpRoot, 'app-b') }).runOnce();
    const runId = (db.prepare('SELECT id FROM workflow_runs WHERE task_id = ?').get(taskId) as { id: string }).id;
    const t1 = 'turn_dev13b_1';
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth22', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk22:p1', 2, 2)`).run(t1, runId);
    db.prepare(`UPDATE workflow_runs SET budget_json = ?, status = 'INTERRUPTED' WHERE id = ?`).run(JSON.stringify({ runMaxTurns: 6, usedTurns: 2, inFlightReservedTurns: 1, tailReservationByStage: {} }), runId);
    db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES ('d:/y', ?, 1, 0, 'active')`).run(t1);

    // exited 但只有 userManual 证据 → 参数层拒绝。
    await expect(cmd(db, 'recovery.reconcile', { turnId: t1, verdict: 'executed', evidence: { source: 'test', at: Date.now() }, exitFact: 'exited', exitEvidence: { kind: 'userManual', observedAt: Date.now(), alive: false } })).rejects.toThrow(/osProcessCheck/);
    // executed+exitFact 缺省（=未知）：结算预算；租约保留；turn 保持 UNKNOWN。
    const r1 = await cmd<{ verdict: string; turnFinalStatus: string; releasedLeases: string[] }>(db, 'recovery.reconcile', { turnId: t1, verdict: 'executed', evidence: { source: '渠道账单', at: Date.now(), ref: 'bill#1' } });
    expect(r1.turnFinalStatus).toBe('UNKNOWN'); // 不提前收口
    expect(r1.releasedLeases).toEqual([]); // 写入保护保留
    const b1 = JSON.parse((db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(b1.usedTurns).toBe(3); // 已结算
    expect((db.prepare('SELECT status, budget_mark FROM agent_turns WHERE id = ?').get(t1) as { status: string; budget_mark: string })).toMatchObject({ status: 'UNKNOWN', budget_mark: 'settled' });
    expect((db.prepare(`SELECT status FROM workspace_leases WHERE owner_turn_id = ?`).get(t1) as { status: string }).status).toBe('active');
    // executed 二次调用=补交退出证据（合法、不重算预算——返回保护仍保留）；
    // 事实矛盾方向被拒：settled 后不得再 notStarted。
    const followUp = await cmd<{ turnFinalStatus: string }>(db, 'recovery.reconcile', { turnId: t1, verdict: 'executed', evidence: { source: 'again-no-exit-facts', at: Date.now() } });
    expect(followUp.turnFinalStatus).toBe('UNKNOWN');
    expect(b1.usedTurns).toBe(3); // 未重复扣账
    await expect(cmd(db, 'recovery.reconcile', { turnId: t1, verdict: 'notStarted', evidence: { source: '矛盾', at: Date.now() } })).rejects.toThrow(/事实矛盾/);
    // alive：同样保留保护（另一种退出未知形态）。
    const t2 = 'turn_dev13b_2';
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth22', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk22:p2', 3, 3)`).run(t2, runId);
    const r2 = await cmd<{ turnFinalStatus: string; reason: string }>(db, 'recovery.reconcile', { turnId: t2, verdict: 'executed', evidence: { source: 'ps 查询', at: Date.now() }, exitFact: 'alive', exitEvidence: { kind: 'osProcessCheck', pid: 1234, observedAt: Date.now(), alive: true } });
    expect(r2.turnFinalStatus).toBe('UNKNOWN');
    expect(r2.reason).toContain('protection-retained');
    // exited + 合法 OS 证据（alive=false）：释放+FAILED 留证。
    const r3 = await cmd<{ turnFinalStatus: string; releasedLeases: string[]; reason: string }>(db, 'recovery.reconcile', { turnId: t2, verdict: 'executed', evidence: { source: 'OS 进程取证', at: Date.now() }, exitFact: 'exited', exitEvidence: { kind: 'osProcessCheck', pid: 1234, observedAt: Date.now(), alive: false } });
    expect(r3.turnFinalStatus).toBe('FAILED');
    expect(r3.releasedLeases).toEqual([]);
    expect(r3.reason).toBe('executed-exited-no-recorded-outcome');
    // keepUnknown 对非 UNKNOWN（已 FAILED 的 t2）→ 拒绝（守卫一致，不产生误导记录）。
    await expect(cmd(db, 'recovery.reconcile', { turnId: t2, verdict: 'keepUnknown', evidence: { source: 'x', at: 1 } })).rejects.toThrow(/仅 UNKNOWN/);
    db.close();
  }, 30_000);

  it('同 daemon 全链：UNKNOWN 保留准入占位→reconcile notStarted→占位解除→排队任务可派发；executed+存活不放行', async () => {
    const db = openDatabase(':memory:');
    seed2Members(db);
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => [{ kind: 'event', event: { kind: 'turn.completed', finalText: '完成' } }] });
    const admission = new (await import('../../src/daemon/admission.ts')).DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 2, perProviderMaxInFlight: 2 });
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'w13c', detachedTurnConsumption: true, admission,
      turnDeadlineMs: 200, interruptGraceMs: 50, appDataDir: join(tmpRoot, 'app-c'),
    });
    const deps = { db, localUserId: 'u', interruptTurn: async () => {}, releaseAdmission: (t: string) => worker.reconcileRelease(t) };
    const send = async (method: string, params: unknown) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${Math.random().toString(36).slice(2)}`, method, params });

    // 成员 mA 的任务 1 造 UNKNOWN（短截止+不可中断脚本），占位保留（admission 1/1）。
    const taskA = makeTaskWith(db, 31, 'mA');
    const adapterStall = new FakeRuntimeAdapter({ turnScriptSequencer: () => [{ kind: 'unresponsiveToInterrupt' }, { kind: 'stall', ms: 30_000 }] });
    const workerStall = new DispatchWorker({ db, adapter: adapterStall, leaseOwner: 'w13c2', detachedTurnConsumption: true, admission, turnDeadlineMs: 200, interruptGraceMs: 80, appDataDir: join(tmpRoot, 'app-c2') });
    await workerStall.runOnce();
    await new Promise((r) => setTimeout(r, 600));
    const unkTurn = db.prepare(`SELECT t.id FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? AND t.status = 'UNKNOWN'`).get(taskA) as { id: string } | undefined;
    expect(unkTurn).toBeDefined();
    expect(admission.has(unkTurn!.id)).toBe(true); // UNKNOWN 保留占位

    // mA 的任务 2 被成员槽挡住（deferred）。
    const taskB = makeTaskWith(db, 32, 'mA');
    await worker.runOnce();
    expect((db.prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?`).get(taskB) as { c: number }).c).toBe(0);

    // 正式对账（经命令面+内存钩子）：notStarted → 占位解除。
    const rec = await send('recovery.reconcile', { turnId: unkTurn!.id, verdict: 'notStarted', evidence: { source: '进程取证：请求未达 runtime', at: Date.now() } }) as { ok: boolean; data?: { turnFinalStatus: string }; error?: { message: string } };
    expect(rec.ok).toBe(true);
    expect(admission.has(unkTurn!.id)).toBe(false); // 内存占位已解除（同 daemon 联动）
    // 排队任务可派发。
    for (let i = 0; i < 3; i += 1) await worker.runOnce();
    await new Promise((r) => setTimeout(r, 300));
    expect((db.prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?`).get(taskB) as { c: number }).c).toBe(1);

    // 反例：另一 UNKNOWN，executed+alive → 占位不解除，同成员新任务仍被挡。
    const taskC = makeTaskWith(db, 33, 'mA');
    await workerStall.runOnce();
    await new Promise((r) => setTimeout(r, 600));
    const unk2 = db.prepare(`SELECT t.id FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? AND t.status = 'UNKNOWN'`).get(taskC) as { id: string };
    expect(admission.has(unk2.id)).toBe(true);
    const rec2 = await send('recovery.reconcile', { turnId: unk2.id, verdict: 'executed', evidence: { source: '账单', at: Date.now() }, exitFact: 'alive', exitEvidence: { kind: 'osProcessCheck', pid: process.pid, observedAt: Date.now(), alive: true } }) as { ok: boolean };
    expect(rec2.ok).toBe(true);
    expect(admission.has(unk2.id)).toBe(true); // 不提前放行
    const taskD = makeTaskWith(db, 34, 'mA');
    await worker.runOnce();
    expect((db.prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?`).get(taskD) as { c: number }).c).toBe(0);
    await worker.awaitInFlightTurns(3_000).catch(() => {});
    await Promise.all([adapter.closeAllSessions(), adapterStall.closeAllSessions()]);
    db.close();
  }, 60_000);
});

describe('OS 进程身份取证（真实本地进程）', () => {
  it('真实子进程：存活→退出可观测；PID 复用检测按启动时间判定', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    const { checkProcessLiveness, sameProcessIdentity, buildExitEvidence } = await import('../../src/daemon/processCheck.ts');
    const alive = checkProcessLiveness(child.pid!);
    expect(alive.state).toBe('alive');
    if (alive.state === 'alive' && alive.identity.startedAt != null) {
      // 复用检测：同一身份=同进程；不同启动时间=不同进程。
      expect(sameProcessIdentity(alive.identity, alive.identity)).toBe('same');
      expect(sameProcessIdentity(alive.identity, { pid: alive.identity.pid, startedAt: alive.identity.startedAt - 60_000 })).toBe('different');
      expect(sameProcessIdentity({ pid: 1, startedAt: null }, { pid: 1, startedAt: 123 })).toBe('unknown'); // 缺启动时间=不可判
    }
    // exitEvidence：存活时 alive=true（不得用于 exited）。
    const ev = buildExitEvidence(child.pid!, alive.state === 'alive' ? alive.identity : undefined);
    expect('kind' in ev && ev.kind === 'osProcessCheck' && ev.alive).toBe(true);
    child.kill();
    await new Promise((r) => setTimeout(r, 800));
    const dead = checkProcessLiveness(child.pid!);
    expect(dead.state).toBe('exited'); // OS 层确认退出（不是推断）
    // 历史身份+已退出：buildExitEvidence 给 alive=false（PID 已无进程——复用无从谈起）。
    const ev2 = buildExitEvidence(child.pid!, alive.state === 'alive' ? alive.identity : undefined);
    expect('kind' in ev2 && ev2.kind === 'osProcessCheck' && ev2.alive === false).toBe(true);
  }, 30_000);
});

/** 双成员种子（联动用例需要 mA/mB）。 */
function seed2Members(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','甲','agent',1),('mB','p1','乙','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA'),('r1','mB')`).run();
}

function makeTaskWith(db: ZhongshuoDatabase, n: number, memberId: string): string {
  const ids = { messageId: `wm${n}`, threadId: `wth${n}`, taskId: `wtk${n}`, taskEventId: `we${n}`, threadEventId: `wh${n}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] },
    now: n,
  });
  return ids.taskId;
}
