/**
 * DEV-25（第二十五轮一/二/三）：提醒预算**接到实际调用边界**+命令事务修复+跟进目标链。
 * - 调用台账（reminder_calls）：预算=模型调用数——修复/追加/重派在 worker 建 turn 前统一
 *   检查+持久入账（不能通过新 run 绕开）；断言**底层 startTurn 次数**（不只数 task/occurrence）；
 * - 命令事务：confirm 状态/授权/预算在事务内重读核对（两 occurrence 争最后一格恰一条获准）；
 *   同 commandId 重放返回首次持久结果（首次成功后的状态变化不阻塞重试）；
 * - cancel：once 到点后（done）待确认触发仍可取消→结算→确认拒绝→零 turn；
 * - 跟进：绑定 threadId 的房间提醒=跟进既有任务（线程消息+`task:{id}:reminder:` 键），
 *   不建新根任务；结果回到原线程。
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

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-remb-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r0', 'mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `remb-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { code: string; message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const cmdRaw = async (method: string, params: unknown, commandId?: string) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `remb-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const clock = { now: Date.now() };
  const scheduler = new ReminderScheduler({ db, now: () => clock.now });
  return { db, cmd, cmdRaw, clock, scheduler };
}
const validDone = (text = '完成'): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: text, files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];
const invalidDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `m_${randomUUID().slice(0, 8)}`, text: '散文输出' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: '仍然不是 JSON 的散文输出' } },
];
function makeWorker(db: ZhongshuoDatabase, scripts: FakeTurnScript[], structuredFinal = true): { worker: DispatchWorker; adapter: FakeRuntimeAdapter } {
  const adapter = new FakeRuntimeAdapter({ structuredFinal, turnScriptSequencer: () => scripts.shift() ?? validDone() });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-remb', appDataDir: join(tmpRoot, 'app') });
  return { worker, adapter };
}

describe('第二十五轮·一：调用预算接到实际 startTurn 边界（断言底层调用次数）', () => {
  it('修复不绕额度：sum=1 首轮无效格式→修复派发被拒（不发出第二次调用）', async () => {
    const { db, cmd, clock, scheduler } = makeEnv();
    // 房间提醒（修复链的源 turn 查询按 task: 前缀——dm 任务为 dmtask: 前缀，另行登记）。
    const at = clock.now + 60_000;
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '修复预算', schedule: { kind: 'once', at }, budgetLimit: { sum: 1 }, autoDispatch: true });
    clock.now = at + 1;
    const out = scheduler.tick();
    expect(out.fired[0]!.outcome).toBe('dispatched');
    const taskId = out.fired[0]!.taskId!;
    // 首轮：无效格式 → FAILED + outputInvalid（修复资格形成）。
    const { worker, adapter } = makeWorker(db, [invalidDone()], false);
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    const firstTurnStatus = (db.prepare("SELECT t.status FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ? ORDER BY t.rowid DESC LIMIT 1").get(taskId) as { status: string } | undefined)?.status;
    expect(firstTurnStatus).toBe('FAILED');
    // 修复入队成功（命令面不挡——边界在 startTurn）→ worker 领取→gate 拒：无第二次调用。
    await cmd('task.redispatch', { taskId, formatRepair: true, reason: '修复尝试' });
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1); // **底层调用次数**：修复未发出第二次调用
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('BLOCKED');
    expect((db.prepare('SELECT paused_reason FROM reminders WHERE id = ?').get(reminderId) as { paused_reason: string }).paused_reason).toBe('budget_exceeded');
    const calls = db.prepare('SELECT status FROM reminder_calls WHERE reminder_id = ?').all(reminderId) as Array<{ status: string }>;
    expect(calls).toHaveLength(1); // 台账恰一行（首次调用——failed 计数）
    expect(calls[0]!.status).toBe('failed');
    db.close();
  }, 60_000);

  it('追加执行不绕额度：sum=1 首轮成功→redispatch 被 gate 拒（无第二次调用）；重启不清零', async () => {
    const { db, cmd, clock, scheduler } = makeEnv();
    db.prepare('UPDATE projects SET task_review_enabled = 1').run(); // 任务保持 REVIEW（非终态——redispatch 前置可用）
    const at = clock.now + 60_000;
    await cmd('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '追加预算', schedule: { kind: 'once', at }, budgetLimit: { sum: 1 }, autoDispatch: true });
    clock.now = at + 1;
    const out = scheduler.tick();
    const taskId = out.fired[0]!.taskId!;
    const { worker, adapter } = makeWorker(db, [validDone()]);
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    await cmd('task.redispatch', { taskId, reason: '追加一轮' });
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1); // 恰一次调用
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('BLOCKED');
    // 重启等价：新 worker 实例再领（如有残留）——额度不清零。
    const { worker: worker2, adapter: adapter2 } = makeWorker(db, []);
    await worker2.runOnce();
    expect(adapter2.startTurnLog.length).toBe(0);
    db.close();
  }, 60_000);

  it('两条待确认 occurrence 争最后一格（sum=1）：恰一条获准；另一条确认拒绝', async () => {
    const { db, cmd, cmdRaw, clock, scheduler } = makeEnv();
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: conv.conversationId, ownerMemberId: 'mA', title: '争格', schedule: { kind: 'daily', time: '08:00' }, budgetLimit: { sum: 1 } });
    const due1 = (db.prepare('SELECT next_at FROM reminders WHERE id = ?').get(reminderId) as { next_at: number }).next_at;
    clock.now = due1 + 1;
    scheduler.tick(); // awaiting #1
    clock.now = due1 + 86_400_000 + 1;
    scheduler.tick(); // awaiting #2
    const occs = db.prepare("SELECT scheduled_at FROM reminder_occurrences WHERE reminder_id = ? AND outcome = 'awaiting_confirmation' ORDER BY scheduled_at").all(reminderId) as Array<{ scheduled_at: number }>;
    expect(occs).toHaveLength(2);
    const first = await cmd<{ taskId: string }>('reminder.confirm', { reminderId, scheduledAt: occs[0]!.scheduled_at });
    expect(first.taskId).toBeTruthy(); // 第一条获准（预占已入账）
    const second = await cmdRaw('reminder.confirm', { reminderId, scheduledAt: occs[1]!.scheduled_at });
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('BUDGET_EXCEEDED'); // 第二条：额度已被预占
    const { worker, adapter } = makeWorker(db, [validDone()]);
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1); // 恰一次底层调用
    db.close();
  }, 60_000);

  it('maxTriggers 与调用预算分列：maxTriggers=1 的 daily 第二天触发被拒（不涉及预算）', async () => {
    const { db, cmd, clock, scheduler } = makeEnv();
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: conv.conversationId, ownerMemberId: 'mA', title: '触发上限', schedule: { kind: 'daily', time: '08:00' }, maxTriggers: 1 });
    const due1 = (db.prepare('SELECT next_at FROM reminders WHERE id = ?').get(reminderId) as { next_at: number }).next_at;
    clock.now = due1 + 1;
    const o1 = scheduler.tick();
    expect(o1.fired[0]!.outcome).toBe('awaiting_confirmation'); // 第一次正常
    clock.now = due1 + 86_400_000 + 1;
    const o2 = scheduler.tick();
    expect(o2.paused.some((x) => x.reason === 'trigger_limit')).toBe(true); // 触发上限（occurrence 口径）
    db.close();
  });
});

describe('第二十五轮·二：命令重放/取消/确认事务', () => {
  it('confirm 同 commandId 重试返回首次持久结果（状态已 dispatched 不阻塞重放）', async () => {
    const { db, cmd, cmdRaw, clock, scheduler } = makeEnv();
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const at = clock.now + 60_000;
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: conv.conversationId, ownerMemberId: 'mA', title: '重放', schedule: { kind: 'once', at } });
    clock.now = at + 1;
    scheduler.tick();
    const commandId = `confirm-replay-${randomUUID().slice(0, 8)}`;
    const first = await cmdRaw('reminder.confirm', { reminderId, scheduledAt: at }, commandId);
    expect(first.ok).toBe(true);
    const replay = await cmdRaw('reminder.confirm', { reminderId, scheduledAt: at }, commandId);
    expect(replay.ok).toBe(true); // 重放成功——不因「已 dispatched」失败
    expect((replay.data as { taskId: string }).taskId).toBe((first.data as { taskId: string }).taskId); // 原 taskId
    const conflict = await cmdRaw('reminder.confirm', { reminderId, scheduledAt: at + 1 }, commandId);
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT'); // 同号异参
    db.close();
  });

  it('once 到点→待确认→取消（done 仍可取消）→确认拒绝→零 turn；待我处理同步结算', async () => {
    const { db, cmd, cmdRaw, clock, scheduler } = makeEnv();
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const at = clock.now + 60_000;
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: conv.conversationId, ownerMemberId: 'mA', title: '取消链', schedule: { kind: 'once', at } });
    clock.now = at + 1;
    scheduler.tick();
    expect((db.prepare('SELECT status FROM reminders WHERE id = ?').get(reminderId) as { status: string }).status).toBe('done'); // once 到点后无下一计划
    const pending = await cmd<{ projects: Array<{ reminderAwaits: unknown[] }> }>('mine.pending', {});
    expect(pending.projects.some((p) => p.reminderAwaits.length > 0)).toBe(true); // 待确认在待我处理
    const cancelled = await cmd<{ cancelled: boolean; settledAwaiting: number }>('reminder.cancel', { reminderId });
    expect(cancelled.cancelled).toBe(true); // done+awaiting 可取消
    expect(cancelled.settledAwaiting).toBe(1);
    const occ = db.prepare('SELECT outcome FROM reminder_occurrences WHERE reminder_id = ?').get(reminderId) as { outcome: string };
    expect(occ.outcome).toBe('cancelled_by_user');
    const rejected = await cmdRaw('reminder.confirm', { reminderId, scheduledAt: at });
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message).toContain('已取消');
    const { worker, adapter } = makeWorker(db, []);
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(0); // 零 turn
    const after = await cmd<{ projects: Array<{ reminderAwaits: unknown[] }> }>('mine.pending', {});
    expect(after.projects.some((p) => p.reminderAwaits.length > 0)).toBe(false); // 已结算
    db.close();
  }, 60_000);
});

describe('第二十五轮·三：目标与授权链（跟进既有任务，不建无来源新根）', () => {
  it('绑定 threadId 的房间提醒：线程跟进消息+task:{id}:reminder: 键派发既有任务；输入含模板体；无新根任务', async () => {
    const { db, cmd, clock, scheduler } = makeEnv();
    db.prepare('UPDATE projects SET task_review_enabled = 1').run(); // 任务保持 REVIEW（跟进目标非终态）
    // 正式链建一个房间根任务（带线程；单 mention=DIRECT——UI 在单 agent 项目会预填）。
    const submitted = await cmd<{ taskId: string }>('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '原始任务：整理清单', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
    const taskId = submitted.taskId!;
    const { worker, adapter } = makeWorker(db, [validDone('首轮完成')]);
    await worker.runOnce(); // 首轮 DONE？——REVIEW 策略（默认 auto_deliver→DONE）
    const startTurnBefore = adapter.startTurnLog.length;
    const threadId = (db.prepare('SELECT conversation_thread_id FROM tasks WHERE id = ?').get(taskId) as { conversation_thread_id: string }).conversation_thread_id;
    const taskCountBefore = (db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c;
    // 绑定线程的提醒（获准）。
    const at = clock.now + 60_000;
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId, ownerMemberId: 'mA', title: '跟进提醒', schedule: { kind: 'once', at }, budgetLimit: { sum: 1 }, autoDispatch: true });
    clock.now = at + 1;
    const out = scheduler.tick();
    expect(out.fired[0]!.outcome).toBe('dispatched');
    expect(out.fired[0]!.taskId).toBe(taskId); // 跟进既有任务——不是新任务
    expect((db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c).toBe(taskCountBefore); // 无新根任务
    // 线程跟进消息（system 来源+模板体）。
    const followUp = db.prepare("SELECT author_type, author_id, body_json FROM messages WHERE thread_id = ? AND author_type = 'system'").get(threadId) as { author_type: string; author_id: string; body_json: string };
    expect(followUp).toBeTruthy();
    expect(followUp.author_id).toBe(`reminder:${reminderId}`);
    expect(JSON.parse(followUp.body_json).text).toContain('【提醒触发】跟进提醒');
    const followDispatchKey = `task:${taskId}:reminder:${reminderId}:${at}`;
    expect((db.prepare('SELECT dispatch_key FROM outbox WHERE dispatch_key = ?').get(followDispatchKey) as { dispatch_key: string }).dispatch_key).toBe(followDispatchKey);
    // worker 消费跟进派发 → 输入含提醒模板体；调用台账+1。
    const { worker: worker2, adapter: adapter2 } = makeWorker(db, [validDone('跟进完成')]);
    await worker2.runOnce();
    expect(adapter2.startTurnLog.length).toBe(1);
    expect(adapter2.startTurnLog[0]!.text).toContain('【提醒触发】跟进提醒'); // 结果回到原线程（输入含跟进）
    void startTurnBefore;
    db.close();
  }, 60_000);

  it('owner 被移出房间成员→触发重查拒绝（owner-not-in-room）；停止代次按绑定快照（历史停止不永久禁止）', async () => {
    const { db, cmd, clock, scheduler } = makeEnv();
    const at = clock.now + 60_000;
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '房间范围', schedule: { kind: 'once', at }, autoDispatch: true });
    db.prepare("DELETE FROM room_members WHERE room_id = 'r0' AND member_id = 'mA'").run();
    clock.now = at + 1;
    const out = scheduler.tick();
    expect(out.paused.some((x) => x.reason === 'owner-not-in-room')).toBe(true);
    expect((db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c).toBe(0);
    // 恢复成员+历史停止任务：绑定时代次快照=1 → 不因历史停止永久禁止。
    db.prepare("INSERT INTO room_members (room_id, member_id) VALUES ('r0', 'mA')").run();
    db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES ('m_hist','p1','conv_room',1,'r0','human','u_local','{}','final',0)`).run();
    db.prepare(`UPDATE conversations SET last_message_seq = 1 WHERE id = 'conv_room'`).run();
    db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id) VALUES ('th_hist','p1','conv_room','r0','m_hist')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, title, status, stop_generation, route_json) VALUES ('t_hist','p1','conv_room','room_task','r0','th_hist','历史停止','ACTIVE',1,?)`)
      .run(JSON.stringify({ kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'mA', frozenMemberIds: ['mA'], initialWakeMemberIds: ['mA'] }));
    db.prepare(`UPDATE conversation_threads SET root_task_id = 't_hist' WHERE id = 'th_hist'`).run();
    const at2 = clock.now + 60_000;
    await cmd('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', threadId: 'th_hist', ownerMemberId: 'mA', title: '历史停止不禁止', schedule: { kind: 'once', at: at2 }, autoDispatch: true });
    clock.now = at2 + 1;
    const out2 = scheduler.tick();
    expect(out2.fired.some((x) => x.outcome === 'dispatched')).toBe(true); // 历史停止（绑定时已存在）→ 合法触发
    db.close();
  });
});
