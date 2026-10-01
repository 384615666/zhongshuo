/**
 * DEV-26（第二十六轮一）：提醒派发与预算的**准确归属**反例。
 * 一个 task 可绑多个提醒（threadId/taskId 跟进）——预算/预占/turn/修复沿**准确来源**计数，
 * 不消耗另一提醒的预占；派发键为完整身份键（同任务同刻两提醒不撞）；调用格挂钩与 run/turn
 * 创建原子收敛（组装失败/创建前崩溃不留指向不存在 turn 的 inflight）。
 * 断言：底层 startTurn 次数 + **每条 reminder_calls 的 reminder_id 归属**（不只看总数）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { ReminderScheduler } from '../../src/daemon/reminderScheduler.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-remown-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const validDone = (text = '完成'): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: text, files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];
const invalidDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '散文' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: '不是 JSON 的散文' } },
];

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run('r0', 'mA');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `own-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const clock = { now: Date.now() };
  const scheduler = new ReminderScheduler({ db, now: () => clock.now });
  /** 正式链建一个房间根任务（带线程；REVIEW 策略保持非终态）。 */
  const makeTask = async (): Promise<{ taskId: string; threadId: string }> => {
    db.prepare('UPDATE projects SET task_review_enabled = 1').run();
    const s = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: `任务 ${randomUUID().slice(0, 6)}`, intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
    const threadId = (db.prepare('SELECT conversation_thread_id FROM tasks WHERE id = ?').get(s.taskId) as { conversation_thread_id: string }).conversation_thread_id;
    return { taskId: s.taskId!, threadId };
  };
  const makeWorker = (workerDb: ZhongshuoDatabase, scripts: FakeTurnScript[], structuredFinal = true): { worker: DispatchWorker; adapter: FakeRuntimeAdapter } => {
    const adapter = new FakeRuntimeAdapter({ structuredFinal, turnScriptSequencer: () => scripts.shift() ?? validDone() });
    return { worker: new DispatchWorker({ db: workerDb, adapter, leaseOwner: `w-${randomUUID().slice(0, 4)}`, appDataDir: join(tmpRoot, 'app') }), adapter };
  };
  const callsOf = () => db.prepare('SELECT reminder_id, task_id, turn_id, dispatch_key, status FROM reminder_calls ORDER BY rowid').all() as Array<{ reminder_id: string; task_id: string; turn_id: string | null; dispatch_key: string | null; status: string }>;
  return { db, cmd, clock, scheduler, makeTask, makeWorker, callsOf };
}

describe('第二十六轮·一：准确归属（同任务多提醒）', () => {
  it('同任务两个不同提醒：A 无上限、B sum=1——B 的格式修复沿源归 B（拒绝二次调用）；A 的派发独立计数', async () => {
    const { db, cmd, clock, scheduler, makeTask, makeWorker, callsOf } = makeEnv();
    const { taskId, threadId } = await makeTask();
    const { worker, adapter } = makeWorker(db, [validDone('基线轮')]);
    await worker.runOnce(); // 基线普通轮（用户派发——无提醒归属）
    const baseTurns = adapter.startTurnLog.length;
    // 提醒 A（无上限）+ 提醒 B（sum=1）绑定同任务同刻。
    const at = clock.now + 60_000;
    const a = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId, ownerMemberId: 'mA', title: 'A 无上限', schedule: { kind: 'once', at }, autoDispatch: true });
    const b = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId, ownerMemberId: 'mA', title: 'B sum=1', schedule: { kind: 'once', at }, budgetLimit: { sum: 1 }, autoDispatch: true });
    clock.now = at + 1;
    const out = scheduler.tick();
    expect(out.fired.length).toBe(2); // 同任务同刻两提醒——身份键不撞，各自派发
    expect((db.prepare('SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ?').get(`%reminder:%`) as { c: number }).c).toBe(2);
    // 两个跟进 turn（A 无限额；B 首格）。B 的轮故意无效格式→FAILED+outputInvalid。
    const { worker: w2, adapter: a2 } = makeWorker(db, [validDone('A 跟进'), invalidDone()], false);
    await w2.runOnce();
    await w2.runOnce();
    expect(a2.startTurnLog.length).toBe(2); // 恰两 turn
    const callsAfter = callsOf();
    expect(callsAfter.length).toBe(2);
    // 归属断言（逐条）：A 一行、B 一行——不互相消耗。
    const aCalls = callsAfter.filter((c) => c.reminder_id === a.reminderId);
    const bCalls = callsAfter.filter((c) => c.reminder_id === b.reminderId);
    expect(aCalls).toHaveLength(1);
    expect(bCalls).toHaveLength(1);
    expect(bCalls[0]!.status).toBe('failed'); // B 的无效格式轮=已花（保守计数）
    // B 的格式修复：沿源 turn 归属 B（sum=1 已耗）→ 拒绝，不消耗 A 的额度。
    await cmd('task.redispatch', { taskId, formatRepair: true, reason: '修复尝试' });
    const { worker: w3, adapter: a3 } = makeWorker(db, [], false);
    await w3.runOnce();
    expect(a3.startTurnLog.length).toBe(0); // 无第三次调用
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('BLOCKED');
    expect((db.prepare('SELECT paused_reason FROM reminders WHERE id = ?').get(b.reminderId) as { paused_reason: string }).paused_reason).toBe('budget_exceeded'); // 拒在 B——不是 A
    expect((db.prepare('SELECT status FROM reminders WHERE id = ?').get(a.reminderId) as { status: string }).status).toBe('done'); // A 不受牵连
    expect(callsOf().length).toBe(2); // 台账仍两行（修复被拒未入账）
    void baseTurns; void worker;
    db.close();
  }, 60_000);

  it('绑定前普通任务派发与提醒派发交错：普通轮零台账；随后提醒跟进正常预占', async () => {
    const { db, cmd, clock, scheduler, makeTask, makeWorker, callsOf } = makeEnv();
    const { taskId, threadId } = await makeTask();
    const { worker, adapter } = makeWorker(db, [validDone('普通轮 1'), validDone('普通轮 2')]);
    await worker.runOnce();
    await cmd('task.redispatch', { taskId, reason: '用户追加' });
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(2);
    expect(callsOf().length).toBe(0); // 普通任务轮零台账（绑定前）
    // 绑定后提醒跟进（无预算上限——不预占行；acquire 时按键归属入账）。
    const at = clock.now + 60_000;
    await cmd('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId, ownerMemberId: 'mA', title: '跟进提醒', schedule: { kind: 'once', at }, autoDispatch: true });
    clock.now = at + 1;
    const out = scheduler.tick();
    expect(out.fired[0]!.outcome).toBe('dispatched');
    const { worker: w2, adapter: a2 } = makeWorker(db, [validDone('提醒跟进')]);
    await w2.runOnce();
    expect(a2.startTurnLog.length).toBe(1);
    const calls = callsOf();
    expect(calls).toHaveLength(1); // 无预算→不预占；acquire 按完整身份键入账一行
    expect(calls[0]!.dispatch_key).toContain(':reminder:');
    db.close();
  }, 60_000);

  it('重启后归属及额度保持：新 worker/scheduler 实例下追加仍按准确归属拒绝', async () => {
    const { db, cmd, clock, scheduler, makeTask, makeWorker, callsOf } = makeEnv();
    const { taskId, threadId } = await makeTask();
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId, ownerMemberId: 'mA', title: '重启额度', schedule: { kind: 'once', at: clock.now + 60_000 }, budgetLimit: { sum: 1 }, autoDispatch: true });
    clock.now += 61_000;
    scheduler.tick();
    const { worker, adapter } = makeWorker(db, [validDone('首格')]);
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    // 重启等价：全新 scheduler+worker 实例（同库）。
    const scheduler2 = new ReminderScheduler({ db, now: () => clock.now });
    void scheduler2;
    await cmd('task.redispatch', { taskId, reason: '重启后追加' });
    const { worker: worker2, adapter: adapter2 } = makeWorker(db, []);
    await worker2.runOnce();
    expect(adapter2.startTurnLog.length).toBe(0); // sum=1 已花——重启不清零
    const calls = callsOf();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reminder_id).toBe(reminderId); // 归属保持
    db.close();
  }, 60_000);

  it('原子收敛：组装失败不占格（无 inflight/无 run）；hold 不留指向不存在 turn 的行', async () => {
    const { db, cmd, clock, scheduler, makeTask, makeWorker, callsOf } = makeEnv();
    const { taskId, threadId } = await makeTask();
    const at = clock.now + 60_000;
    await cmd('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId, ownerMemberId: 'mA', title: '原子', schedule: { kind: 'once', at }, budgetLimit: { sum: 2 }, autoDispatch: true });
    clock.now = at + 1;
    scheduler.tick();
    // 组装失败：任务根消息被破坏（thread 历史锚缺失 → assemble 失败路径）——用线程删除锚模拟。
    // 更直接的组装失败：把任务 conversation_thread_id 置 NULL（房间任务缺线程→missing-thread）。
    db.prepare('UPDATE tasks SET conversation_thread_id = NULL WHERE id = ?').run(taskId);
    const { worker, adapter } = makeWorker(db, []);
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(0); // 未派发
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('BLOCKED'); // 组装失败留证
    // 预占行保持 reserved（未挂钩不存在的 turn）——可被后续（修复线程后 redispatch）挂钩或释放。
    const calls = callsOf();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.turn_id).toBeNull(); // 无指向不存在 turn 的 inflight
    expect(calls[0]!.status).toBe('reserved');
    db.close();
  }, 60_000);
});
