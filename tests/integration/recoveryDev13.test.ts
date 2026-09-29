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
    await expect(cmd(db2, 'recovery.reconcile', { turnId: okTurn, verdict: 'notStarted', evidence: 'x' })).rejects.toThrow(/仅 UNKNOWN/);
    await expect(cmd(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'notStarted', evidence: '' })).rejects.toThrow();

    // notStarted：退款（I-1 不加 U）+租约释放+turn FAILED 留证。
    const r1 = await cmd<{ verdict: string; stateChanged: boolean; releasedLeases: string[] }>(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'notStarted', evidence: '进程取证：该请求从未到达 runtime（测试注入）' });
    expect(r1.stateChanged).toBe(true);
    expect(r1.releasedLeases).toEqual(['d:/x']);
    const budgetAfter = JSON.parse((db2.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(budgetAfter.usedTurns).toBe(2); // 未执行：不计数
    expect(budgetAfter.inFlightReservedTurns).toBe(0); // 预留退款
    expect((db2.prepare('SELECT status FROM agent_turns WHERE id = ?').get(seedTurnId) as { status: string }).status).toBe('FAILED');
    expect((db2.prepare(`SELECT status FROM workspace_leases WHERE owner_turn_id = ?`).get(seedTurnId) as { status: string }).status).toBe('released');
    // 已 FAILED 的 turn 再对账=拒绝（幂等防双算）。
    await expect(cmd(db2, 'recovery.reconcile', { turnId: seedTurnId, verdict: 'executed', evidence: '再算一次' })).rejects.toThrow(/仅 UNKNOWN/);

    // executed：另一个 UNKNOWN turn（结算语义）。
    const seedTurn2 = 'turn_dev13_unknown_2';
    db2.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth1', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk1:crashprobe2', 3, 3)`).run(seedTurn2, runId);
    db2.prepare(`UPDATE workflow_runs SET budget_json = ? WHERE id = ?`).run(JSON.stringify({ runMaxTurns: 6, usedTurns: 2, inFlightReservedTurns: 1, tailReservationByStage: {} }), runId);
    await cmd(db2, 'recovery.reconcile', { turnId: seedTurn2, verdict: 'executed', evidence: '渠道账单：该请求已计费（测试注入）' });
    const budget2 = JSON.parse((db2.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json);
    expect(budget2.usedTurns).toBe(3); // 已执行：计数
    expect(budget2.inFlightReservedTurns).toBe(0);

    // keepUnknown：状态不动。
    const seedTurn3 = 'turn_dev13_unknown_3';
    db2.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', 'vth1', 'mA', 'direct.work', 'UNKNOWN', 'task:vtk1:crashprobe3', 4, 4)`).run(seedTurn3, runId);
    await cmd(db2, 'recovery.reconcile', { turnId: seedTurn3, verdict: 'keepUnknown', evidence: '证据不足，保持观察' });
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
