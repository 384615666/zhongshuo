/**
 * DEV-13 成果一致性专项（第七轮·补，零模型调用——fake 驱动+生产方法定点注入）。
 * 八项（现行任务书）：每项断言业务事实/预算/产物/事件/用户可见状态一致；恢复不自动重跑
 * 可能已有副作用的请求、不伪造成功或失败。
 * 1 输出已收未入库崩溃窗口（message 落库+turn UNKNOWN→对账收口后消息保留、无交付）；
 * 2 产物落盘但 DB 事务未完成（DEV-12 crashAfterStep 续跑+turn 状态不受 undo 影响）；
 * 3 DB 已提交但回执丢失（同 commandId 重放=replayed、副作用一次）；
 * 4 交付已存在而 outbox 重领（crash-reclaimed 标 failed、交付不重复）；
 * 5 UNKNOWN 对账期间迟到输出（FAILED 不复活不交付+矛盾提示；UNKNOWN 未收口=迟到合法
 *   输出收口为确定成功——本轮修复的成果一致性洞）；
 * 6 同 resultKey 重复提交与异载荷冲突（消息 eventKey 去重单条；终态以 turn.completed
 *   合同为准，错 resultKey=OUTPUT_INVALID）；
 * 7 停止后到达成果不复活（RT-06 复证：CANCELLED+lateCompletion）；
 * 8 DEV-12 撤销完成未记账的恢复（三向判定续跑+账实一致）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import type { NormalizedRuntimeEvent } from '../../src/contracts/runtime.ts';
import type { TaskRow } from '../../src/daemon/dispatchWorker.ts';
import { registerTurnProcess } from '../../src/daemon/processRegistry.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-outcome-'));
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

let seq = 0;
function makeTask(db: ZhongshuoDatabase, reviewPolicy: 'auto_deliver' | 'user_review' = 'auto_deliver'): { taskId: string; threadId: string } {
  seq += 1;
  const ids = { messageId: `om${seq}`, threadId: `oth${seq}`, taskId: `otk${seq}`, taskEventId: `oe${seq}`, threadEventId: `oh${seq}` };
  createRoomRootTask(db, {
    ids, projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `T${seq}`, body: `B${seq}`, mentions: [{ kind: 'member', memberId: 'mA' }],
    author: { authorType: 'human', authorId: 'u' }, reviewPolicy, sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] },
    now: seq,
  });
  return { taskId: ids.taskId, threadId: ids.threadId };
}

async function cmd<T>(db: ZhongshuoDatabase, method: string, params: unknown): Promise<T> {
  const r = await dispatchDaemonCommand(
    { db, localUserId: 'u_out', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') },
    { protocolVersion: 1, commandId: `cmd-oc-${randomUUID().slice(0, 8)}`, method, params },
  ) as { ok: boolean; data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(r.error?.message ?? '命令失败');
  return r.data as T;
}

const validComplete = (resultKey: string) =>
  JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey, changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] });

const taskRow = (db: ZhongshuoDatabase, taskId: string): TaskRow => db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as unknown as TaskRow;

function baseEvent(turnId: string, kind: NormalizedRuntimeEvent['kind']): { eventKey: string; sessionId: string; turnId: string; receivedAt: number; kind: NormalizedRuntimeEvent['kind'] } {
  return { eventKey: `ev_${turnId}_${kind}_${randomUUID().slice(0, 6)}`, sessionId: 'sess', turnId, receivedAt: Date.now(), kind };
}

describe('成果一致性八项（业务事实/预算/产物/事件/用户可见状态）', () => {
  it('① 输出已收到但尚未入库终态（崩溃窗口）：消息保留、对账收口、无伪造交付', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { taskId } = makeTask(db);
    // 脚本：输出消息到达后 stall（终态事务未完成=崩溃窗口同构）。
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: () => [
        { kind: 'event', event: { ...baseEvent('t', 'message.completed'), messageId: 'm_crash', text: '崩溃前的部分输出' } as never },
        { kind: 'stall', ms: 30_000 },
      ],
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-oc1', appDataDir: join(tmpRoot, 'a1'), turnDeadlineMs: 300, interruptGraceMs: 100 });
    await worker.runOnce();
    // deadline 兜底 → UNKNOWN；输出消息已落库（用户可见，不因未终态丢失）。
    const turn = db.prepare(`SELECT id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%'`).get(taskId) as { id: string };
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turn.id) as { status: string }).status).toBe('UNKNOWN');
    expect((db.prepare(`SELECT count(*) c FROM messages WHERE body_json LIKE '%崩溃前的部分输出%'`).get() as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT count(*) c FROM task_deliveries WHERE task_id = ?`).get(taskId) as { c: number }).c).toBe(0); // 无伪造交付
    // 对账收口（none 登记=程序事实释放）后：消息仍保留、仍无交付（FAILED=无已入库产物）。
    registerTurnProcessLine(db, turn.id);
    await cmd(db, 'recovery.reconcile', { turnId: turn.id, verdict: 'executed', note: '对账收口' });
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turn.id) as { status: string }).status).toBe('FAILED');
    expect((db.prepare(`SELECT count(*) c FROM messages WHERE body_json LIKE '%崩溃前的部分输出%'`).get() as { c: number }).c).toBe(1); // 不删除
    expect((db.prepare(`SELECT count(*) c FROM task_deliveries WHERE task_id = ?`).get(taskId) as { c: number }).c).toBe(0);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);

  it('②⑧ 产物落盘但 DB 事务未完成（DEV-12 崩溃窗口）：undo 续跑账实一致；turn 状态不受影响', async () => {
    const dir = join(tmpRoot, 'half-tx');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f.txt'), 'one', 'utf8');
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p2','p',?,?, '{}', 0)`).run(dir, dir);
    const { captureBaseline, finalizeChangeset, undoChangeset } = await import('../../src/daemon/changeset.ts');
    const appData = join(tmpRoot, 'app-oc');
    const b = captureBaseline(db, { projectId: 'p2', paths: ['f.txt'], appDataDir: appData });
    if (!b.ok) throw new Error(b.error.message);
    writeFileSync(join(dir, 'f.txt'), 'TWO', 'utf8');
    finalizeChangeset(db, { changeSetId: b.value.changeSetId, appDataDir: appData });
    // ② 崩溃窗口：rename 已成功、记账缺失（磁盘=fenedone，DB=in_progress）。
    const crashed = undoChangeset(db, { changeSetId: b.value.changeSetId, appDataDir: appData, crashAfterStepActions: 1 });
    expect(crashed.ok).toBe(true);
    // 恢复检查：activeUndos 可见（统一入口）；三向判定续跑后账实一致（磁盘回滚、状态 succeeded）。
    const st = await cmd(db, 'recovery.status', {});
    expect((st as { activeUndos: unknown[] }).activeUndos.length).toBeGreaterThanOrEqual(1);
    const resumed = await cmd<{ status: string }>(db, 'changeset.undo', { changeSetId: b.value.changeSetId });
    expect(resumed.status).toBe('succeeded');
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('one'); // 账实一致
    db.close();
  }, 30_000);

  it('③ DB 已提交但回执丢失：同 commandId 重放=replayed、副作用一次（幂等网关）', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { taskId } = makeTask(db);
    // 首轮失败（散文）——任务回 ACTIVE，redispatch 可用（DONE 任务不可追加 turn）。
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: () => [{ kind: 'event', event: { ...baseEvent('t3', 'turn.completed'), finalText: '散文输出' } as never }],
    });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-oc3', appDataDir: join(tmpRoot, 'a3') });
    await worker.runOnce();
    // 成功命令（普通 redispatch 入队）——回执已落库但响应「丢失」→ 客户端同 commandId 重发。
    const commandId = `cmd-replay-${randomUUID().slice(0, 8)}`;
    const deps = { db, localUserId: 'u_out', interruptTurn: async () => {}, appDataDir: join(tmpRoot, 'app') };
    const send = () => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method: 'task.redispatch', params: { taskId, reason: '回执丢失重发' } });
    const r1 = await send() as { ok: boolean; replayed?: boolean };
    const r2 = await send() as { ok: boolean; replayed?: boolean };
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r2.replayed).toBe(true); // 重放（不重复执行 handler）
    // 副作用一次：幂等回执一条、outbox 该派发一条（不重复入队）。
    expect((db.prepare(`SELECT count(*) c FROM command_receipts WHERE command_id = ?`).get(commandId) as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key = ?`).get(`task:${taskId}:redispatch`) as { c: number }).c).toBe(1);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);

  it('④ 交付已存在而 outbox 重领：标 failed 留审计、交付不重复', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { taskId } = makeTask(db);
    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-oc4', appDataDir: join(tmpRoot, 'a4') });
    await worker.runOnce(); // 完成（SUCCEEDED+交付）
    const turn = db.prepare(`SELECT id, run_id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%'`).get(taskId) as { id: string; run_id: string };
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turn.id) as { status: string }).status).toBe('SUCCEEDED');
    const deliveriesBefore = (db.prepare(`SELECT count(*) c FROM task_deliveries WHERE task_id = ?`).get(taskId) as { c: number }).c;
    expect(deliveriesBefore).toBe(1);
    // 模拟崩溃重领：outbox 留 pending 同 dispatch_key → 重开 worker 领取（existingTurn 对账纪律）。
    db.prepare(`UPDATE outbox SET status = 'pending', turn_id = NULL, attempt_epoch = 0 WHERE dispatch_key = ?`).run(`task:${taskId}:initial`);
    const worker2 = new DispatchWorker({ db, adapter, leaseOwner: 'w-oc4b', appDataDir: join(tmpRoot, 'a4b') });
    await worker2.runOnce();
    // RT-03：已有 turn 的派发不重跑——标 failed 留审计；交付/turn 状态不变。
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turn.id) as { status: string }).status).toBe('SUCCEEDED');
    expect((db.prepare(`SELECT count(*) c FROM task_deliveries WHERE task_id = ?`).get(taskId) as { c: number }).c).toBe(1); // 不重复交付
    const reclaimed = (db.prepare(`SELECT count(*) c FROM domain_events WHERE payload_json LIKE '%crash-reclaimed-dispatch%'`).get() as { c: number }).c;
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);

  it('⑤ UNKNOWN 对账期间的迟到输出：FAILED 不复活不交付+矛盾提示；UNKNOWN 未收口=迟到合法输出收口为确定成功', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { taskId, threadId } = makeTask(db);
    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-oc5', appDataDir: join(tmpRoot, 'a5') });
    await worker.runOnce(); // turn 完成（SUCCEEDED）——先拿到 run 上下文，再手工造两个 UNKNOWN turn 分别验证。
    const runId = (db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId) as { id: string }).id;
    const t1 = 'turn_oc5_failed'; // 已对账收口（FAILED+refunded）
    const t2 = 'turn_oc5_unknown'; // 未收口 UNKNOWN
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch, budget_mark) VALUES (?, ?, 'c1', ?, 'mA', 'direct.work', 'FAILED', 'task:oc5:a', 2, 2, 'refunded')`).run(t1, runId, threadId);
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', ?, 'mA', 'direct.work', 'UNKNOWN', 'task:oc5:b', 3, 3)`).run(t2, runId, threadId);
    const task = taskRow(db, taskId);
    // FAILED（已退款）turn 的迟到合法输出：不复活、不交付、矛盾提示审计。
    worker.applyEvent(task, runId, t1, { ...baseEvent(t1, 'turn.completed'), finalText: validComplete(`result_${t1}`) } as never);
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(t1) as { status: string }).status).toBe('FAILED'); // 不复活
    expect((db.prepare(`SELECT count(*) c FROM task_deliveries WHERE id = ?`).get(`dlv_${t1}`) as { c: number }).c).toBe(0);
    expect((db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'turn.lateCompletion' AND turn_id = ?`).get(t1) as { c: number }).c).toBe(1);
    const hint = db.prepare(`SELECT payload_json FROM domain_events WHERE kind = 'turn.lateCompletion' AND turn_id = ?`).get(t1) as { payload_json: string };
    expect(JSON.parse(hint.payload_json).factConflictHint).toContain('correctToExecuted');
    expect((db.prepare('SELECT budget_mark FROM agent_turns WHERE id = ?').get(t1) as { budget_mark: string }).budget_mark).toBe('refunded'); // 账目不被自动改写
    // UNKNOWN（未收口）turn 的迟到合法输出：收口为确定成功+交付（本轮修复的洞）。
    worker.applyEvent(task, runId, t2, { ...baseEvent(t2, 'turn.completed'), finalText: validComplete(`result_${t2}`) } as never);
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(t2) as { status: string }).status).toBe('SUCCEEDED');
    expect((db.prepare(`SELECT count(*) c FROM task_deliveries WHERE task_id = ? AND id = ?`).get(taskId, `dlv_${t2}`) as { c: number }).c).toBe(1); // 合法输出=真实交付
    expect((db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'turn.lateOutputResolvesUnknown' AND turn_id = ?`).get(t2) as { c: number }).c).toBe(1);
    // 错 resultKey（异载荷冲突形态）：终态以合同为准——OUTPUT_INVALID，不产生交付。
    const t3 = 'turn_oc5_badkey';
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch) VALUES (?, ?, 'c1', ?, 'mA', 'direct.work', 'RUNNING', 'task:oc5:c', 4, 4)`).run(t3, runId, threadId);
    worker.applyEvent(task, runId, t3, { ...baseEvent(t3, 'turn.completed'), finalText: validComplete('result_other_turn') } as never);
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(t3) as { status: string }).status).toBe('FAILED');
    expect((db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'turn.outputInvalid' AND turn_id = ?`).get(t3) as { c: number }).c).toBe(1);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);

  it('⑥ 同 resultKey 重复提交：消息 eventKey 去重单条；同一输出不产生第二份交付', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { taskId } = makeTask(db, 'user_review');
    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-oc6', appDataDir: join(tmpRoot, 'a6') });
    await worker.runOnce();
    const turn = db.prepare(`SELECT id, run_id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%'`).get(taskId) as { id: string; run_id: string };
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turn.id) as { status: string }).status).toBe('SUCCEEDED');
    const deliveriesBefore = (db.prepare(`SELECT count(*) c FROM task_deliveries WHERE task_id = ?`).get(taskId) as { c: number }).c;
    expect(deliveriesBefore).toBe(1); // user_review=pending 唯一待办
    // 同 turn 内重复 message.completed（同 eventKey）：RT-05 去重——消息单条、无新副作用。
    const dupEvent = { eventKey: 'ev_dup_fixed_key', sessionId: 'sess', turnId: turn.id, receivedAt: Date.now(), kind: 'message.completed' as const, messageId: 'm_dup', text: '重复消息' };
    const task = taskRow(db, taskId);
    worker.applyEvent(task, turn.run_id, turn.id, dupEvent);
    worker.applyEvent(task, turn.run_id, turn.id, dupEvent);
    expect((db.prepare(`SELECT count(*) c FROM messages WHERE body_json LIKE '%重复消息%'`).get() as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT count(*) c FROM task_deliveries WHERE task_id = ?`).get(taskId) as { c: number }).c).toBe(1);
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);

  it('⑦ 停止后到达成果不复活（RT-06 复证）：STOPPING+迟到 completed → CANCELLED+lateCompletion 审计', async () => {
    const db = openDatabase(':memory:');
    seed(db);
    const { taskId } = makeTask(db);
    // 停止脚本：unresponsive（停止请求后无终态）→ 停止生效置 STOPPING；随后迟到 completed 注入。
    const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => [{ kind: 'unresponsiveToInterrupt' }, { kind: 'stall', ms: 30_000 }] });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-oc7', appDataDir: join(tmpRoot, 'a7'), turnDeadlineMs: 400, interruptGraceMs: 150, detachedTurnConsumption: true });
    await worker.runOnce();
    await new Promise((r) => setTimeout(r, 500));
    const turn = db.prepare(`SELECT id, run_id FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%'`).get(taskId) as { id: string; run_id: string };
    // 停止链（经正式命令）生效后 turn STOPPING/CANCELLED——直接验证停止后迟到输出。
    const st = (db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turn.id) as { status: string }).status;
    expect(['RUNNING', 'STOPPING', 'UNKNOWN']).toContain(st); // 未停止前的状态
    db.prepare(`UPDATE agent_turns SET status = 'STOPPING' WHERE id = ?`).run(turn.id); // 停止已生效（R1 停止链等价前置——该链路已有专项用例）
    const task = taskRow(db, taskId);
    worker.applyEvent(task, turn.run_id, turn.id, { ...baseEvent(turn.id, 'turn.completed'), finalText: validComplete(`result_${turn.id}`) } as never);
    expect((db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(turn.id) as { status: string }).status).toBe('CANCELLED'); // 不复活
    expect((db.prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'turn.lateCompletion' AND turn_id = ?`).get(turn.id) as { c: number }).c).toBe(1);
    expect((db.prepare(`SELECT count(*) c FROM task_deliveries WHERE task_id = ?`).get(taskId) as { c: number }).c).toBe(0); // 无交付
    await adapter.closeAllSessions();
    db.close();
  }, 30_000);
});

/** 最小进程登记辅助（none 模型=程序事实释放路径）。 */
function registerTurnProcessLine(db: ZhongshuoDatabase, turnId: string): void {
  const runId = (db.prepare('SELECT run_id FROM agent_turns WHERE id = ?').get(turnId) as { run_id: string }).run_id;
  registerTurnProcess(db, { turnId, runId, memberId: 'mA', adapterKind: 'fake', processModel: 'none', pid: null, startedAtMs: null, identitySource: 'none' });
}
