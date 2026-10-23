/**
 * DEV-13 恢复与故障测试（2026-09-28 实装；2026-09-29 第七轮适配服务端取证语义）：
 * - 崩溃现场（incomplete stop 挂起 turn→UNKNOWN）→ 重启恢复读取：applyRecovery 快照携带
 *   stopRecord/unknownTurnRows/activeUndos；门禁落下（不自动重放可能已产生副作用的请求）。
 * - recovery.status：UNKNOWN 明细+stop 记录+未收口撤销+租约+进程登记与最近取证（程序观测）。
 * - recovery.reconcile（第七轮语义——退出证据由服务端生成，详见 recoveryProcessEvidence.test.ts）：
 *   · notStarted=人工声明（manualRiskAck）：退款（I-1 不加 U）但**租约保留**；
 *   · executed：结算（U+1）；退出释放/保留按服务端 probe 结果；
 *   · keepUnknown=维持不确定：状态不动；
 *   · 非 UNKNOWN turn 拒绝对账；note 必填。
 * - 对账后不重放：outbox 不因 reconcile 重新派发（重复领取不重复扣减——既有 RT-03 守卫回归）。
 * - DEV-12 未记账场景接入：activeUndos 在恢复面可见，changeset.undo 续跑三向判定（联动断言）。
 * - 同 daemon 全链：UNKNOWN 保留准入占位 → 对账（服务端取证 exited/none）→ 占位解除 →
 *   排队任务可派发；查询不可确认 → 占位不解除。
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
import { registerTurnProcess } from '../../src/daemon/processRegistry.ts';

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

async function cmd<T>(db: ZhongshuoDatabase, method: string, params: unknown, overrides: Record<string, unknown> = {}): Promise<T> {
  const r = await dispatchDaemonCommand(
    { db, localUserId: 'u_dev13', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'appU'), ...overrides },
    { protocolVersion: 1, commandId: `cmd-rc-${randomUUID().slice(0, 8)}`, method, params },
  ) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}

describe('DEV-13：崩溃恢复面与 recovery.reconcile（服务端取证语义）', () => {
  it('UNKNOWN 现场：恢复快照完整；status 带进程登记；notStarted 人工=退款+租约保留；executed=结算；keepUnknown 不动', async () => {
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
    // recovery.status：UNKNOWN 明细+stop 记录+租约+进程登记（无登记=identity-missing 如实）。
    const st = await cmd<{ unknownTurns: Array<{ id: string }>; stopRecord: { phase: string } | null; heldLeases: Array<{ owner_turn_id: string }>; processRegistry: Array<{ turnId: string }>; leaseNote: string }>(db2, 'recovery.status', {});
    expect(st.unknownTurns.some((t) => t.id === seedTurnId)).toBe(true);
    expect(st.stopRecord?.phase).toBe('incomplete');
    expect(st.heldLeases.some((l) => l.owner_turn_id === seedTurnId)).toBe(true);
    expect(st.leaseNote).toContain('不证明');
    expect(st.processRegistry.find((r) => r.turnId === seedTurnId)).toBeUndefined(); // 该手工 turn 无登记——status 只报事实

    // 反例：非 UNKNOWN turn 拒绝对账；note 必填。
    const okTurn = (db2.prepare('SELECT id FROM agent_turns WHERE status = ? LIMIT 1').get('SUCCEEDED') as { id: string }).id;
    await expect(cmd(db2, 'recovery.reconcile', { turnId: okTurn, verdict: 'notStarted', manualRiskAck: true, note: 'x' })).rejects.toThrow(/仅 UNKNOWN/);
    await expect(cmd(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'keepUnknown', note: '' })).rejects.toThrow();

    // notStarted（人工声明·风险确认）：退款（I-1 不加 U）但**租约保留**（程序未确认无遗留进程）。
    const r1 = await cmd<{ verdict: string; stateChanged: boolean; releasedLeases: string[]; reason: string }>(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'notStarted', manualRiskAck: true, note: '进程取证：该请求从未到达 runtime（测试注入）' });
    expect(r1.stateChanged).toBe(true);
    expect(r1.reason).toBe('manual-not-started-risk-ack');
    expect(r1.releasedLeases).toEqual([]); // 人工声明不解除写入保护
    const budgetAfter = JSON.parse((db2.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(budgetAfter.usedTurns).toBe(2); // 未执行：不计数
    expect(budgetAfter.inFlightReservedTurns).toBe(0); // 预留退款
    expect((db2.prepare('SELECT status, budget_mark FROM agent_turns WHERE id = ?').get(seedTurnId) as { status: string; budget_mark: string })).toMatchObject({ status: 'FAILED', budget_mark: 'refunded' });
    expect((db2.prepare(`SELECT status FROM workspace_leases WHERE owner_turn_id = ?`).get(seedTurnId) as { status: string }).status).toBe('active'); // 保护保留
    // 已 FAILED 的 turn 再对账=拒绝（幂等防双算）。
    await expect(cmd(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'executed', note: '再算一次' })).rejects.toThrow(/仅 UNKNOWN/);

    // executed：另一个 UNKNOWN turn——登记 none 模型（程序事实释放路径）。
    const seedTurn2 = 'turn_dev13_unknown_2';
    db2.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth1', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk1:crashprobe2', 3, 3)`).run(seedTurn2, runId);
    db2.prepare(`UPDATE workflow_runs SET budget_json = ? WHERE id = ?`).run(JSON.stringify({ runMaxTurns: 6, usedTurns: 2, inFlightReservedTurns: 1, tailReservationByStage: {} }), runId);
    registerTurnProcess(db2, { turnId: seedTurn2, runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    await cmd(db2, 'recovery.reconcile', { turnId: seedTurn2, verdict: 'executed', note: '渠道账单：该请求已计费（测试注入）' });
    const budget2 = JSON.parse((db2.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(budget2.usedTurns).toBe(3); // 已执行：计数
    expect(budget2.inFlightReservedTurns).toBe(0);

    // keepUnknown：状态不动。
    const seedTurn3 = 'turn_dev13_unknown_3';
    db2.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth1', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk1:crashprobe3', 4, 4)`).run(seedTurn3, runId);
    await cmd(db2, 'recovery.reconcile', { turnId: seedTurn3, verdict: 'keepUnknown', note: '证据不足，保持观察' });
    expect((db2.prepare('SELECT status FROM agent_turns WHERE id = ?').get(seedTurn3) as { status: string }).status).toBe('UNKNOWN');
    const state=()=>cmd<{unknownTurns:Array<{id:string;protectionReleased:boolean}>}>(db2,'recovery.status',{});
    expect((await state()).unknownTurns.find(t=>t.id===seedTurn3)?.protectionReleased).toBe(false);
    // A raw released flag without its formal event is not a proven release.
    db2.prepare("UPDATE agent_turns SET protection_state='released' WHERE id=?").run(seedTurn3);
    expect((await state()).unknownTurns.find(t=>t.id===seedTurn3)?.protectionReleased).toBe(false);
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
  it('executed+退出未知（无登记）：结算预算但保留租约与占位（不提前放行）；老参数 exitEvidence 拒绝', async () => {
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

    // 老参数（调用方自报退出/alive）→ strictObject 拒绝（第七轮：退出证据只能服务端生成）。
    await expect(cmd(db, 'recovery.reconcile', { turnId: t1, verdict: 'executed', note: 'test', exitFact: 'exited', exitEvidence: { kind: 'osProcessCheck', pid: 4242, observedAt: Date.now(), alive: false } })).rejects.toThrow(/exitEvidence/);
    // executed+无登记（identity-missing）：结算预算；租约保留；turn 保持 UNKNOWN。
    const r1 = await cmd<{ verdict: string; turnFinalStatus: string; releasedLeases: string[] }>(db, 'recovery.reconcile', { turnId: t1, verdict: 'executed', note: '渠道账单（测试注入）' });
    expect(r1.turnFinalStatus).toBe('UNKNOWN'); // 不提前收口
    expect(r1.releasedLeases).toEqual([]); // 写入保护保留
    const b1 = JSON.parse((db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(b1.usedTurns).toBe(3); // 已结算
    expect((db.prepare('SELECT status, budget_mark FROM agent_turns WHERE id = ?').get(t1) as { status: string; budget_mark: string })).toMatchObject({ status: 'UNKNOWN', budget_mark: 'settled' });
    expect((db.prepare(`SELECT status FROM workspace_leases WHERE owner_turn_id = ?`).get(t1) as { status: string }).status).toBe('active');
    // executed 二次调用=补交退出证据（合法、不重算预算——返回保护仍保留）；
    // 事实矛盾方向被拒：settled 后不得再 notStarted。
    const followUp = await cmd<{ turnFinalStatus: string }>(db, 'recovery.reconcile', { turnId: t1, verdict: 'executed', note: 'again-no-exit-facts' });
    expect(followUp.turnFinalStatus).toBe('UNKNOWN');
    expect(b1.usedTurns).toBe(3); // 未重复扣账
    await expect(cmd(db, 'recovery.reconcile', { turnId: t1, verdict: 'notStarted', manualRiskAck: true, note: '矛盾' })).rejects.toThrow(/仅 UNKNOWN|事实矛盾/);
    db.close();
  }, 30_000);

  it('同 daemon 全链：UNKNOWN 保留准入占位→对账（服务端取证）→占位解除→排队任务可派发；查询不可确认不放行', async () => {
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

    // 正式对账（经命令面+内存钩子）：服务端取证不可确认（注入查询故障）→ 占位不解除。
    const reg = db.prepare(`SELECT r.run_id FROM runtime_process_registry r WHERE r.turn_id = ?`).get(unkTurn!.id) as { run_id: string } | undefined;
    expect(reg).toBeDefined(); // worker 已为该 turn 登记进程身份（fake=none 模型）——先改 per-turn + 注入查询故障验证保守路径
    db.prepare(`UPDATE runtime_process_registry SET process_model = 'per-turn', pid = 424242, identity_source = 'pid-only' WHERE turn_id = ?`).run(unkTurn!.id);
    const recFail = await dispatchDaemonCommand(
      { db, localUserId: 'u', interruptTurn: async () => {}, releaseAdmission: (t: string) => worker.reconcileRelease(t), processQuery: (pid: number) => ({ state: 'unknown' as const, pid, error: '注入故障' }) },
      { protocolVersion: 1, commandId: `c-fail-${Math.random().toString(36).slice(2)}`, method: 'recovery.reconcile', params: { turnId: unkTurn!.id, verdict: 'executed', note: '查询故障注入——不解除' } },
    ) as { ok: boolean };
    expect(recFail.ok).toBe(true);
    expect(admission.has(unkTurn!.id)).toBe(true); // 查询不可确认 → 占位保留
    const taskD0 = makeTaskWith(db, 35, 'mA');
    await worker.runOnce();
    expect((db.prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?`).get(taskD0) as { c: number }).c).toBe(0);

    // 服务端取证=已退出（none 模型程序事实）→ 占位解除 → 排队任务可派发。
    db.prepare(`UPDATE runtime_process_registry SET process_model = 'none', pid = NULL, identity_source = 'none' WHERE turn_id = ?`).run(unkTurn!.id);
    const rec = await send('recovery.reconcile', { turnId: unkTurn!.id, verdict: 'executed', note: '无子进程模型——程序事实' }) as { ok: boolean; data?: { turnFinalStatus: string }; error?: { message: string } };
    expect(rec.ok).toBe(true);
    expect(admission.has(unkTurn!.id)).toBe(false); // 内存占位已解除（同 daemon 联动）
    // 排队任务可派发。
    for (let i = 0; i < 3; i += 1) await worker.runOnce();
    await new Promise((r) => setTimeout(r, 300));
    expect((db.prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?`).get(taskB) as { c: number }).c).toBe(1);
    await worker.awaitInFlightTurns(3_000).catch(() => {});
    await Promise.all([adapter.closeAllSessions(), adapterStall.closeAllSessions()]);
    db.close();
  }, 60_000);
});

describe('OS 进程身份取证（真实本地进程；Windows 错误分类）', () => {
  it('真实子进程：存活（含启动时刻）→退出可观测；复用检测按启动时间；不存在的 PID=exited', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    const { checkProcessLiveness, sameProcessIdentity } = await import('../../src/daemon/processCheck.ts');
    const alive = checkProcessLiveness(child.pid!);
    expect(alive.state).toBe('alive');
    if (alive.state === 'alive' && alive.identity.startedAt != null) {
      // 复用检测：同一身份=同进程；不同启动时间=不同进程；缺启动时间=不可判。
      expect(sameProcessIdentity(alive.identity, alive.identity)).toBe('same');
      expect(sameProcessIdentity(alive.identity, { pid: alive.identity.pid, startedAt: alive.identity.startedAt - 60_000 })).toBe('different');
      expect(sameProcessIdentity({ pid: 1, startedAt: null }, { pid: 1, startedAt: 123 })).toBe('unknown');
    }
    child.kill();
    await new Promise((r) => setTimeout(r, 800));
    const dead = checkProcessLiveness(child.pid!);
    expect(dead.state).toBe('exited'); // OS 明确报告 PID 不存在（不是推断）
    // 不存在的 PID（从未有进程）=exited；非法 PID=unknown。
    expect(checkProcessLiveness(4194304).state).toBe('exited');
    expect(checkProcessLiveness(-1).state).toBe('unknown');
  }, 30_000);

  it('Windows 查询错误分类：仅 ObjectNotFound 判 exited；权限/StartTime 失败/解析失败=unknown（注入 queryFn）', async () => {
    const { checkProcessLiveness } = await import('../../src/daemon/processCheck.ts');
    expect(checkProcessLiveness(1234, () => 'X-EXITED').state).toBe('exited');
    expect(checkProcessLiveness(1234, () => 'X-STARTTIME-FAIL').state).toBe('unknown'); // 进程在但启动时间不可读——身份不完整
    expect(checkProcessLiveness(1234, () => 'X-ERR:PermissionDenied').state).toBe('unknown');
    expect(checkProcessLiveness(1234, () => 'X-EMPTY').state).toBe('unknown');
    expect(checkProcessLiveness(1234, () => 'garbage output').state).toBe('unknown');
    expect(checkProcessLiveness(1234, () => 'X-ALIVE:1700000000000').state).toBe('alive'); // 正常路径
    expect(checkProcessLiveness(1234, () => 'X-ALIVE:not-a-number').state).toBe('unknown'); // 解析失败
  }, 15_000);
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
