/**
 * 修复预算统一授权账目（第七轮，worker 正式路径，零额度）：
 * 旧缺陷：priorUsed=SUM(各 DIRECT run 的 budget_json.usedTurns)——修复 run 的快照含播种
 * 历史值，多轮修复后 SUM 重复计算历史消耗。新口径：**逐 turn 处置事实**为单一真源——
 * 非退款 turn 计数（正常终态/对账 settled/UNKNOWN 未收口）；唯一豁免=refunded（确认未启动
 * 退款）。budget_run_id 参与授权链校验（断裂=损坏阻塞）。
 *
 * 两份独立逻辑输出及其修复，逐次断言：实际启动计数（agent_turns 行数）、每次派发的
 * usedTurns 快照、carryover（=非退款 turn 计数，非 SUM）、授权归属（budget_run_id）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { registerTurnProcess } from '../../src/daemon/processRegistry.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-budget-grant-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行成员','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1','mA')`).run();
}

function makeTask(db: ZhongshuoDatabase, n: number): string {
  const ids = { messageId: `gm${n}`, threadId: `gth${n}`, taskId: `gtk${n}`, taskEventId: `ge${n}`, threadEventId: `gh${n}` };
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
    { db, localUserId: 'u_test', interruptTurn: async () => {} },
    { protocolVersion: 1, commandId: `cmd-bg-${randomUUID().slice(0, 8)}`, method, params },
  ) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}

const validComplete = (resultKey: string) =>
  JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey, changeSummary: '完成', files: ['notes.md'], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] });

interface Snap {
  turnRows: number;
  latestRunBudget: { usedTurns: number; inFlightReservedTurns: number };
  latestRunId: string;
  carryoverOfLatestRepair: number | null;
}

function snap(db: ZhongshuoDatabase, taskId: string): Snap {
  const turnRows = (db.prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?`).get(taskId) as { c: number }).c;
  const latestRun = db.prepare('SELECT id, budget_json FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId) as { id: string; budget_json: string };
  const carryRow = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'task.repairConsumed' ORDER BY seq DESC LIMIT 1`).get() as { payload_json: string; run_id: string } | undefined;
  return {
    turnRows,
    latestRunBudget: JSON.parse(latestRun.budget_json) as Snap['latestRunBudget'],
    latestRunId: latestRun.id,
    carryoverOfLatestRepair: carryRow != null ? (JSON.parse(carryRow.payload_json) as { budgetCarryoverUsed: number }).budgetCarryoverUsed : null,
  };
}

describe('修复预算统一授权账目（两份独立逻辑输出及其修复）', () => {
  it('逐次断言：carryover=非退款 turn 计数（非 SUM 累加）；独立输出不互相挤占；预算沿任务授权链', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 1);
    let turnCount = 0;
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        // turn1 失败（附加键）→ turn2 修复#1 通过 → turn3 普通重派失败（独立输出）→ turn4 修复#2 通过。
        if (turnCount === 2 || turnCount === 4) {
          return [
            { kind: 'event', event: { kind: 'message.completed', messageId: `g_ok_${turnCount}`, text: 'ok' } },
            { kind: 'event', event: { kind: 'turn.completed', finalText: validComplete(key) } },
          ];
        }
        const out = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: key, changeSummary: `第${turnCount}轮`, files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], extra: [`第${turnCount}轮失败`] });
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: `g_${turnCount}`, text: out } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: out } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-bg', appDataDir: join(tmpRoot, 'a') });

    // turn1：首派失败。
    await worker.runOnce();
    let s = snap(db, taskId);
    expect(s.turnRows).toBe(1); // 实际启动计数
    expect(s.latestRunBudget.usedTurns).toBe(1); // 正常结算（0 播种 + 1）
    expect(s.latestRunBudget.inFlightReservedTurns).toBe(0);

    // 修复#1（源=turn1，逻辑输出=turn1）：carryover=非退款 turn 计数=1。
    await cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: '修复#1' });
    await worker.runOnce(); // turn2 修复通过 → DONE
    s = snap(db, taskId);
    expect(s.turnRows).toBe(2);
    expect(s.carryoverOfLatestRepair).toBe(1); // 修复轮播种=1（turn1 已计）
    expect(s.latestRunBudget.usedTurns).toBe(2); // 1 播种 + 自身结算 1
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');

    // 正式独立输出（普通 redispatch——DONE 任务已终态，换任务 2 验证两份独立授权互不混入）。
    const taskId2 = makeTask(db, 2);
    // 同一 worker 继续跑（成员/项目相同——授权归属按任务区分）。
    await worker.runOnce(); // taskId2 的 turn3（普通首派，失败）
    s = snap(db, taskId2);
    expect(s.turnRows).toBe(1);
    expect(s.latestRunBudget.usedTurns).toBe(1); // 任务 2 的授权链从 0 起（不携带任务 1 的历史——不混入其他授权）
    // 任务 2 修复#1：carryover=任务 2 自身计数=1。
    await cmd(db, 'task.redispatch', { taskId: taskId2, formatRepair: true, reason: '任务2 修复' });
    await worker.runOnce(); // turn4 通过
    s = snap(db, taskId2);
    expect(s.carryoverOfLatestRepair).toBe(1);
    expect(s.turnRows).toBe(2);
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as { status: string }).status).toBe('DONE');

    // 授权归属：每个工作项 budget_run_id=创建时任务最近 run（属于同一任务）。
    const w1 = db.prepare(`SELECT task_id, budget_run_id FROM format_repair_workitems WHERE task_id = ?`).get(taskId) as { task_id: string; budget_run_id: string };
    const w1Run = db.prepare(`SELECT task_id FROM workflow_runs WHERE id = ?`).get(w1.budget_run_id) as { task_id: string };
    expect(w1Run.task_id).toBe(taskId);

    // 旧缺陷反例锁定：SUM(各 run.usedTurns)=1+2=3 ≠ 真实已消耗 2——新口径按 turn 计数不重复。
    const sumOld = (db.prepare(`SELECT budget_json FROM workflow_runs WHERE task_id = ?`).all(taskId) as Array<{ budget_json: string }>)
      .reduce((acc, r) => acc + (JSON.parse(r.budget_json).usedTurns ?? 0), 0);
    const turnCountNonRefunded = (db.prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? AND (t.budget_mark IS NULL OR t.budget_mark != 'refunded')`).get(taskId) as { c: number }).c;
    expect(sumOld).toBe(3); // 旧算法确实会得到 3（快照含播种值——重复计）
    expect(turnCountNonRefunded).toBe(2); // 真实消耗=2；carryover 用它，不用 SUM
    db.close();
  }, 30_000);

  it('确认未启动退款豁免额度：refunded turn 不计入后续修复 carryover', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 3);
    let turnCount = 0;
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        turnCount += 1;
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        if (turnCount === 1) {
          const out = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: key, changeSummary: 'x', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], extra: ['失败'] });
          return [
            { kind: 'event', event: { kind: 'message.completed', messageId: 'bg3_1', text: out } },
            { kind: 'event', event: { kind: 'turn.completed', finalText: out } },
          ];
        }
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'bg3_ok', text: 'ok' } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: validComplete(key) } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-bg2', appDataDir: join(tmpRoot, 'b') });
    await worker.runOnce(); // turn1 失败
    // 造一个 UNKNOWN turn（崩溃现场）→ 对账确认未启动（人工声明退款）→ 它不占额度。
    const runId = (db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId) as { id: string }).id;
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES ('turn_bg_refund', ?, 'c1', 'gth3', 'mA', 'direct.work', 'UNKNOWN', 'task:gtk3:crash', 2, 2)`).run(runId);
    await cmd(db, 'recovery.reconcile', { turnId: 'turn_bg_refund', verdict: 'notStarted', manualRiskAck: true, note: '退款豁免验证（测试注入）' });
    expect((db.prepare('SELECT budget_mark FROM agent_turns WHERE id = ?').get('turn_bg_refund') as { budget_mark: string }).budget_mark).toBe('refunded');
    // 第四十一轮：对账后保护=独立持久事实（无租约也拦）——先以程序证据解除（none 模型登记=
    // 诚实事实）再修复；解除前后保护状态断言。
    expect((db.prepare('SELECT protection_state FROM agent_turns WHERE id = ?').get('turn_bg_refund') as { protection_state: string | null }).protection_state).toBe('retained');
    registerTurnProcess(db, { turnId: 'turn_bg_refund', runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
    await cmd(db, 'recovery.releaseProtection', { turnId: 'turn_bg_refund', note: '退款豁免验证：程序证据解除（测试）' });
    expect((db.prepare('SELECT protection_state FROM agent_turns WHERE id = ?').get('turn_bg_refund') as { protection_state: string | null }).protection_state).toBe('released');
    // 修复#1：carryover=非退款计数（turn1=1；refunded turn 豁免）。
    await cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: '修复' });
    await worker.runOnce(); // 修复通过 → DONE
    const carry = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'task.repairConsumed' ORDER BY seq DESC LIMIT 1`).get() as { payload_json: string };
    expect((JSON.parse(carry.payload_json) as { budgetCarryoverUsed: number }).budgetCarryoverUsed).toBe(1);
    db.close();
  }, 30_000);

  it('授权链断裂（budget_run_id 指向不存在 run）→ 损坏阻塞：不花调用、任务 BLOCKED', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const taskId = makeTask(db, 4);
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input) => {
        const m = input.text.match(/resultKey=([^；\n]+)/) ?? input.text.match(/"resultKey":"(result_[^"]+)"/);
        const key = m?.[1] ?? 'result_unknown';
        const out = JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: key, changeSummary: 'x', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [], extra: ['失败'] });
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'bg4_1', text: out } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: out } },
        ];
      },
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-bg3', appDataDir: join(tmpRoot, 'c') });
    await worker.runOnce(); // 失败
    await cmd(db, 'task.redispatch', { taskId, formatRepair: true, reason: 'r' });
    // 注入授权链断裂：budget_run_id 指向不存在的 run。
    db.prepare(`UPDATE format_repair_workitems SET budget_run_id = 'run_ghost' WHERE task_id = ?`).run(taskId);
    await worker.runOnce();
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('BLOCKED');
    const wi = db.prepare(`SELECT status, note FROM format_repair_workitems WHERE task_id = ?`).get(taskId) as { status: string; note: string | null };
    expect(wi.status).toBe('blocked');
    expect(wi.note).toContain('budgetRunMatch=false');
    // 未花调用：turn 计数不变。
    expect((db.prepare(`SELECT count(*) c FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%'`).get(taskId) as { c: number }).c).toBe(1);
    db.close();
  }, 30_000);
});
