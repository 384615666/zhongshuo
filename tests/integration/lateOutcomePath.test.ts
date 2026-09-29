/**
 * 迟到成果正式接收路径（第八轮，零模型调用——可控 fake + 真实 DispatchWorker 生产路径）。
 *
 * 上轮专项用例手工插 UNKNOWN 再直调 worker.applyEvent——只验证了局部分支。本轮走完整
 * 生产链：实际派发 → 截止进入 UNKNOWN → runtime 在截止后产出合法迟到输出（fake
 * pushLateEvent=模拟真实通道，事件同时落持久化会话记录）→ recovery.pumpLateEvents 正式
 * 命令 → adapter.lateEvents 拉取 → applyEvent 合同校验 → 状态/交付/预算收口。
 *
 * 覆盖：同 daemon 与重启（新进程实例从持久化会话记录回放）两条路径；停止代次不复活；
 * refunded 后真实输出=事实冲突留痕（不自动改账）；同 eventKey 重复与不同 eventKey 重复
 * 完成只生效一次（交付/预算/状态幂等）；已有更新交付时旧 run 输出不覆盖新结果；
 * executed 已结算后完成到达不重复 U+1。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-late8-'));
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

function makeTask(db: ZhongshuoDatabase, n: number, reviewPolicy: 'auto_deliver' | 'user_review' = 'auto_deliver'): string {
  const ids = { messageId: `lm${n}`, threadId: `lth${n}`, taskId: `ltk${n}`, taskEventId: `le${n}`, threadEventId: `lh${n}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${n}`, body: `B${n}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy, sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: n,
  });
  return ids.taskId;
}

const validComplete = (resultKey: string) =>
  JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey, changeSummary: '迟到完成', files: ['notes.md'], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] });

interface PumpResult {
  status: string;
  turnStatus?: string;
  applied?: Array<{ eventKey: string; outcome: string }>;
  releasedLeases?: string[];
}

function depsWith(db: ZhongshuoDatabase, worker: DispatchWorker): { deps: DaemonCommandDeps; cmd: <T>(m: string, p: unknown) => Promise<T> } {
  const deps: DaemonCommandDeps = {
    db, localUserId: 'u_late', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app'),
    pumpLateEvents: (turnId: string) => worker.pumpLateEventsForTurn(turnId),
  };
  return {
    deps,
    cmd: async <T,>(m: string, p: unknown): Promise<T> => {
      const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `c-${randomUUID().slice(0, 8)}`, method: m, params: p }) as { ok: boolean; data?: T; error?: { message: string } };
      if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
      return r.data as T;
    },
  };
}

const turnRow = (db: ZhongshuoDatabase, turnId: string): { status: string; budget_mark: string | null; session_id: string | null } =>
  db.prepare('SELECT status, budget_mark, session_id FROM agent_turns WHERE id = ?').get(turnId) as { status: string; budget_mark: string | null; session_id: string | null };
const deliveries = (db: ZhongshuoDatabase, taskId: string): Array<{ id: string; revision: number; review_status: string; run_id: string | null }> =>
  db.prepare('SELECT id, revision, review_status, run_id FROM task_deliveries WHERE task_id = ? ORDER BY revision').all(taskId) as Array<{ id: string; revision: number; review_status: string; run_id: string | null }>;
const auditKinds = (db: ZhongshuoDatabase, turnId: string): string[] =>
  (db.prepare('SELECT kind FROM domain_events WHERE turn_id = ? ORDER BY seq').all(turnId) as Array<{ kind: string }>).map((r) => r.kind);
const runBudget = (db: ZhongshuoDatabase, runId: string): { usedTurns: number } =>
  JSON.parse((db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json) as { usedTurns: number };

describe('迟到成果正式接收路径（实际派发→截止 UNKNOWN→迟到输出→正式泵→收口）', () => {
  it('同 daemon：UNKNOWN→迟到合法完成→pump→SUCCEEDED+交付+结算一次+租约/准入收口；重复 pump 幂等', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 1);
    const storeDir = join(tmpRoot, 'store-same');
    // 截止极短：turn 启动后即超时 → UNKNOWN。
    const adapter = new FakeRuntimeAdapter({ sessionStoreDir: storeDir, turnScripts: [[{ kind: 'stall', ms: 3_000 }]] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-late8', appDataDir: join(tmpRoot, 'a'), turnDeadlineMs: 400, interruptGraceMs: 400 });
    await worker.runOnce();
    const turnId = (db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(`task:${taskId}:initial`) as { id: string }).id;
    const runId = (db.prepare('SELECT run_id FROM agent_turns WHERE id = ?').get(turnId) as { run_id: string }).run_id;
    expect(turnRow(db, turnId).status).toBe('UNKNOWN'); // 前置：截止收尾
    // 制造遗留租约（UNKNOWN 保留保护的载体）。
    db.prepare(`INSERT INTO workspace_leases (lock_domain, owner_turn_id, epoch, heartbeat_at, status) VALUES ('d:/late8/1', ?, 1, 0, 'active')`).run(turnId);
    // runtime 在截止后产出合法迟到输出（真实通道：内存流+持久化会话记录）。
    const sessionId = turnRow(db, turnId).session_id!;
    expect(sessionId).toBeTruthy(); // 前置：turn 启动时已写入会话绑定
    adapter.pushLateEvent(sessionId, turnId, { kind: 'message.completed', messageId: 'late_body', text: '迟到正文' });
    adapter.pushLateEvent(sessionId, turnId, { kind: 'turn.completed', finalText: validComplete(`result_${turnId}`) });
    const { cmd } = depsWith(db, worker);
    const r1 = await cmd<PumpResult>('recovery.pumpLateEvents', { turnId });
    expect(r1.status).toBe('pumped');
    expect(r1.applied?.filter((a) => a.outcome === 'applied').length).toBeGreaterThanOrEqual(1);
    expect(auditKinds(db, turnId)).toContain('turn.lateOutputResolvesUnknown');
    // 状态/交付/预算一次收口。
    expect(turnRow(db, turnId).status).toBe('SUCCEEDED');
    expect(deliveries(db, taskId)).toHaveLength(1);
    expect(runBudget(db, runId).usedTurns).toBe(1);
    expect((db.prepare(`SELECT status FROM workspace_leases WHERE lock_domain = 'd:/late8/1'`).get() as { status: string }).status).toBe('released');
    expect(auditKinds(db, turnId)).toContain('turn.lateEventsSettled');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    // 重复 pump（同批事件再拉）：全部 duplicate-receipt，无二次生效。
    const r2 = await cmd<PumpResult>('recovery.pumpLateEvents', { turnId });
    expect(r2.status).toBe('not-unknown'); // 已收口
    expect(deliveries(db, taskId)).toHaveLength(1);
    expect(runBudget(db, runId).usedTurns).toBe(1);
    db.close();
  }, 30_000);

  it('重启路径：新 daemon 进程从持久化会话记录回放迟到输出，同样正式收口', async () => {
    const dbFile = join(tmpRoot, 'restart.db');
    const storeDir = join(tmpRoot, 'store-restart');
    const taskId = makeTask(openStage(dbFile), 2);
    let turnId!: string;
    let runId!: string;
    {
      const db = openStage(dbFile);
      const adapter = new FakeRuntimeAdapter({ sessionStoreDir: storeDir, turnScripts: [[{ kind: 'stall', ms: 3_000 }]] });
      const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-late8a', appDataDir: join(tmpRoot, 'a'), turnDeadlineMs: 400, interruptGraceMs: 400 });
      await worker.runOnce();
      turnId = (db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(`task:${taskId}:initial`) as { id: string }).id;
      runId = (db.prepare('SELECT run_id FROM agent_turns WHERE id = ?').get(turnId) as { run_id: string }).run_id;
      expect(turnRow(db, turnId).status).toBe('UNKNOWN');
      // daemon A 崩溃前：迟到输出已到达 runtime 通道并落持久化会话记录。
      adapter.pushLateEvent(turnRow(db, turnId).session_id!, turnId, { kind: 'turn.completed', finalText: validComplete(`result_${turnId}`) });
      db.close();
    }
    {
      // daemon B：全新进程/全新 adapter 实例（同持久化会话目录）——不依赖内存状态。
      const db = openStage(dbFile);
      const adapter2 = new FakeRuntimeAdapter({ sessionStoreDir: storeDir });
      const worker2 = new DispatchWorker({ db, adapter: adapter2, leaseOwner: 'w-late8b', appDataDir: join(tmpRoot, 'a') });
      const { cmd } = depsWith(db, worker2);
      const r = await cmd<PumpResult>('recovery.pumpLateEvents', { turnId });
      expect(r.status).toBe('pumped');
      expect(turnRow(db, turnId).status).toBe('SUCCEEDED');
      expect(deliveries(db, taskId)).toHaveLength(1);
      expect(runBudget(db, runId).usedTurns).toBe(1);
      expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
      db.close();
    }
  }, 30_000);

  it('停止代次已推进：迟到完成按取消收尾——不复活任务、不交付；回执与审计齐备', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 3);
    const adapter = new FakeRuntimeAdapter({ sessionStoreDir: join(tmpRoot, 'store-stop'), turnScripts: [[{ kind: 'stall', ms: 3_000 }]] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-late8', appDataDir: join(tmpRoot, 'a'), turnDeadlineMs: 400, interruptGraceMs: 400 });
    await worker.runOnce();
    const turnId = (db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(`task:${taskId}:initial`) as { id: string }).id;
    expect(turnRow(db, turnId).status).toBe('UNKNOWN');
    // 用户停止已生效（stop_generation 由 task.stop 正式路径推进；此处为停止状态的事实准备）。
    db.prepare('UPDATE tasks SET stop_generation = 1 WHERE id = ?').run(taskId);
    adapter.pushLateEvent(turnRow(db, turnId).session_id!, turnId, { kind: 'turn.completed', finalText: validComplete(`result_${turnId}`) });
    const { cmd } = depsWith(db, worker);
    const r = await cmd<PumpResult>('recovery.pumpLateEvents', { turnId });
    expect(r.status).toBe('pumped');
    expect(turnRow(db, turnId).status).toBe('CANCELLED'); // 停止语义收尾，不复活
    expect(deliveries(db, taskId)).toHaveLength(0); // 不交付
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('CANCELLED');
    const late = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'turn.lateCompletion' AND turn_id = ? ORDER BY seq DESC LIMIT 1`).get(turnId) as { payload_json: string };
    expect(JSON.parse(late.payload_json).stopGeneration).toBe(1);
    db.close();
  }, 30_000);

  it('refunded 后真实输出到达：事实冲突留痕（不改账、不自动纠正）——correctToExecuted 是正式纠正入口', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 4);
    const adapter = new FakeRuntimeAdapter({ sessionStoreDir: join(tmpRoot, 'store-refund'), turnScripts: [[{ kind: 'stall', ms: 3_000 }]] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-late8', appDataDir: join(tmpRoot, 'a'), turnDeadlineMs: 400, interruptGraceMs: 400 });
    await worker.runOnce();
    const turnId = (db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(`task:${taskId}:initial`) as { id: string }).id;
    const runId = (db.prepare('SELECT run_id FROM agent_turns WHERE id = ?').get(turnId) as { run_id: string }).run_id;
    expect(turnRow(db, turnId).status).toBe('UNKNOWN');
    adapter.pushLateEvent(turnRow(db, turnId).session_id!, turnId, { kind: 'turn.completed', finalText: validComplete(`result_${turnId}`) });
    const { cmd } = depsWith(db, worker);
    // 人工声明未启动（退款+FAILED+保护保留）在迟到输出**之后**到达——先落输出再声明。
    const rec = await cmd<{ reason: string; turnFinalStatus: string }>('recovery.reconcile', { turnId, verdict: 'notStarted', manualRiskAck: true, note: '用户人工核对：无相关进程' });
    expect(rec.reason).toBe('manual-not-started-risk-ack');
    expect(turnRow(db, turnId).budget_mark).toBe('refunded');
    // 迟到输出泵：turn 已 FAILED——材料留痕（factConflictHint），不交付、不改 refunded。
    const r = await cmd<PumpResult>('recovery.pumpLateEvents', { turnId });
    expect(r.status).toBe('not-unknown');
    expect(turnRow(db, turnId).status).toBe('FAILED');
    expect(turnRow(db, turnId).budget_mark).toBe('refunded'); // 不自动改账
    expect(deliveries(db, taskId)).toHaveLength(0);
    const hint = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'turn.lateCompletion' AND turn_id = ? ORDER BY seq DESC LIMIT 1`).get(turnId) as { payload_json: string };
    expect(JSON.parse(hint.payload_json).factConflictHint).toContain('correctToExecuted');
    expect(runBudget(db, runId).usedTurns).toBe(0); // 退款账未被动
    db.close();
  }, 30_000);

  it('executed 已结算（对账收口 FAILED）后完成到达：不重复 U+1、不交付；不同 eventKey 重复完成只生效一次', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 5);
    const adapter = new FakeRuntimeAdapter({ sessionStoreDir: join(tmpRoot, 'store-exec'), turnScripts: [[{ kind: 'stall', ms: 3_000 }]] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-late8', appDataDir: join(tmpRoot, 'a'), turnDeadlineMs: 400, interruptGraceMs: 400 });
    await worker.runOnce();
    const turnId = (db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(`task:${taskId}:initial`) as { id: string }).id;
    const runId = (db.prepare('SELECT run_id FROM agent_turns WHERE id = ?').get(turnId) as { run_id: string }).run_id;
    expect(turnRow(db, turnId).status).toBe('UNKNOWN');
    const { cmd } = depsWith(db, worker);
    // 对账 executed（fake=none 模型 → no-os-process 程序事实）→ FAILED+settled+释放。
    const rec = await cmd<{ turnFinalStatus: string; reason: string }>('recovery.reconcile', { turnId, verdict: 'executed', note: '退出已程序确认（none 模型）' });
    expect(rec.turnFinalStatus).toBe('FAILED');
    expect(runBudget(db, runId).usedTurns).toBe(1); // 结算一次
    // 迟到完成到达（不同 eventKey）：不重复结算、不交付。
    adapter.pushLateEvent(turnRow(db, turnId).session_id!, turnId, { kind: 'turn.completed', finalText: validComplete(`result_${turnId}`) });
    const r = await cmd<PumpResult>('recovery.pumpLateEvents', { turnId });
    expect(r.status).toBe('not-unknown');
    expect(runBudget(db, runId).usedTurns).toBe(1); // 无重复 U+1
    expect(deliveries(db, taskId)).toHaveLength(0);
    db.close();
  }, 30_000);

  it('同 daemon 多事件泵内重复完成：第一个生效、第二个 skipped-terminal（交付/预算幂等由终态 CAS 承载）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 6);
    const adapter = new FakeRuntimeAdapter({ sessionStoreDir: join(tmpRoot, 'store-dup'), turnScripts: [[{ kind: 'stall', ms: 3_000 }]] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-late8', appDataDir: join(tmpRoot, 'a'), turnDeadlineMs: 400, interruptGraceMs: 400 });
    await worker.runOnce();
    const turnId = (db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(`task:${taskId}:initial`) as { id: string }).id;
    const runId = (db.prepare('SELECT run_id FROM agent_turns WHERE id = ?').get(turnId) as { run_id: string }).run_id;
    expect(turnRow(db, turnId).status).toBe('UNKNOWN');
    // 两个不同 eventKey 的完成（runtime 重复回执）。
    adapter.pushLateEvent(turnRow(db, turnId).session_id!, turnId, { kind: 'turn.completed', finalText: validComplete(`result_${turnId}`) });
    adapter.pushLateEvent(turnRow(db, turnId).session_id!, turnId, { kind: 'turn.completed', finalText: validComplete(`result_${turnId}`) });
    const { cmd } = depsWith(db, worker);
    const r = await cmd<PumpResult>('recovery.pumpLateEvents', { turnId });
    expect(r.status).toBe('pumped');
    const completed = r.applied!.filter((a) => a.outcome === 'applied');
    expect(completed).toHaveLength(1); // 只一个生效
    expect(r.applied!.some((a) => a.outcome === 'skipped-terminal')).toBe(true);
    expect(turnRow(db, turnId).status).toBe('SUCCEEDED');
    expect(deliveries(db, taskId)).toHaveLength(1);
    expect(runBudget(db, runId).usedTurns).toBe(1);
    db.close();
  }, 30_000);

  it('旧 run 迟到输出不覆盖新交付：turn 收口 SUCCEEDED 但不交付、不迁移任务状态（superseded 留痕）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 7);
    const adapter = new FakeRuntimeAdapter({ sessionStoreDir: join(tmpRoot, 'store-sup'), turnScripts: [[{ kind: 'stall', ms: 3_000 }]] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-late8', appDataDir: join(tmpRoot, 'a'), turnDeadlineMs: 400, interruptGraceMs: 400 });
    await worker.runOnce();
    const turnId = (db.prepare('SELECT id FROM agent_turns WHERE dispatch_key = ?').get(`task:${taskId}:initial`) as { id: string }).id;
    const runId = (db.prepare('SELECT run_id FROM agent_turns WHERE id = ?').get(turnId) as { run_id: string }).run_id;
    expect(turnRow(db, turnId).status).toBe('UNKNOWN');
    // 数据准备：任务已有其他 run 的交付（修复轮/redispatch 已交付新结果）。
    db.prepare(
      `INSERT INTO task_deliveries (id, task_id, run_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status)
       VALUES ('dlv_newer', ?, 'run_newer', 1, 'h1', '[]', '[]', '[]', 'not_required')`,
    ).run(taskId);
    db.prepare('UPDATE tasks SET status = ?, current_delivery_id = ? WHERE id = ?').run('DONE', 'dlv_newer', taskId);
    adapter.pushLateEvent(turnRow(db, turnId).session_id!, turnId, { kind: 'turn.completed', finalText: validComplete(`result_${turnId}`) });
    const { cmd } = depsWith(db, worker);
    const r = await cmd<PumpResult>('recovery.pumpLateEvents', { turnId });
    expect(r.status).toBe('pumped');
    expect(turnRow(db, turnId).status).toBe('SUCCEEDED'); // 事实收口（执行确实完成）
    expect(deliveries(db, taskId)).toHaveLength(1); // 无新交付（不覆盖 dlv_newer）
    expect((db.prepare('SELECT current_delivery_id FROM tasks WHERE id = ?').get(taskId) as { current_delivery_id: string }).current_delivery_id).toBe('dlv_newer');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE'); // 状态不被旧 run 拉走
    expect(auditKinds(db, turnId)).toContain('turn.lateCompletionSuperseded');
    expect(runBudget(db, runId).usedTurns).toBe(1); // 本 run 账照结算（执行实际发生）
    db.close();
  }, 30_000);
});

/** 打开（或复用）文件库：重启路径用；首开跑迁移+seed。 */
function openStage(dbFile: string): ZhongshuoDatabase {
  const db = openDatabase(dbFile);
  const memberCount = (db.prepare(`SELECT count(*) c FROM project_members WHERE project_id = 'p1'`).get() as { c: number }).c;
  if (memberCount === 0) seed(db);
  return db;
}
