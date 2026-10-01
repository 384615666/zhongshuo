/**
 * DEV-23 正式执行链（第二十四轮四——REM-9）：创建提醒→到点→获准/确认→**恰一次执行**
 * （fake adapter 消费 outbox 跑真 turn）→结果回到正确目标→停止/重启可解释。
 * 断言以 DB 事实为准（task/run/turn/预算/输入归属），不只查注入回调。
 * 零真实调用（ZS_ALLOW_FAKE+fake adapter）。
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
import { successTurn } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-remf-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEnv() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `remf-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  return { db, cmd };
}
function makeWorker(db: ZhongshuoDatabase): { worker: DispatchWorker; adapter: FakeRuntimeAdapter } {
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => dmReplyDone() });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-rem', appDataDir: join(tmpRoot, 'app') });
  return { worker, adapter };
}
const dmReplyDone = (): FakeTurnScript => [
  { kind: 'event', event: { kind: 'message.completed', messageId: `rem_reply_${randomUUID().slice(0, 8)}`, text: '提醒执行回复' } },
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'rk', changeSummary: '提醒执行', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
];

describe('DEV-23 正式执行链：创建→到点→获准→恰一次执行→结果回正确目标（fake，零真实调用）', () => {
  it('获准链：reminder.schedule→tick→task/outbox→worker runOnce→run SUCCEEDED+agent 回复落 DM+输入=模板体', async () => {
    const { db, cmd } = makeEnv();
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const clock = { now: Date.now() };
    const at = clock.now + 60_000;
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', {
      projectId: 'p1', conversationId: conv.conversationId, ownerMemberId: 'mA', title: '每晚汇总', sourceRef: 'task_seed:3',
      schedule: { kind: 'once', at }, budgetLimit: { sum: 2 }, autoDispatch: true,
    });
    const scheduler = new ReminderScheduler({ db, now: () => clock.now });
    clock.now = at + 1;
    const out = scheduler.tick();
    expect(out.fired[0]!.outcome).toBe('dispatched');
    const taskId = out.fired[0]!.taskId!;
    // worker 正式消费（fake 执行）。
    const { worker, adapter } = makeWorker(db);
    await worker.runOnce();
    const run = db.prepare('SELECT status, task_id FROM workflow_runs WHERE task_id = ?').get(taskId) as { status: string; task_id: string };
    expect(run.status).toBe('SUCCEEDED');
    const session = db.prepare('SELECT scope_kind, conversation_id FROM runtime_sessions WHERE conversation_id = ?').get(conv.conversationId) as { scope_kind: string; conversation_id: string };
    expect(session.scope_kind).toBe('dm');
    // 输入归属：turn 输入=DEV-21-M3 模板体（occurrence/来源字段）。
    expect(adapter.startTurnLog.length).toBe(1);
    expect(adapter.startTurnLog[0]!.text).toContain('【提醒触发】每晚汇总');
    expect(adapter.startTurnLog[0]!.text).toContain(`occurrence：${reminderId}@`);
    expect(adapter.startTurnLog[0]!.text).toContain('来源：task_seed:3');
    expect(adapter.startTurnLog[0]!.text).toContain('不要自行安排后续循环');
    // 结果回正确目标：agent 回复落在该 DM 会话（无线程）。
    const reply = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND author_type = 'agent'").get(conv.conversationId) as Record<string, unknown>;
    expect(reply).toBeTruthy();
    expect(reply.thread_id).toBeNull();
    // 重启可解释：新调度器+新 worker 同库再扫——不重复执行。
    const scheduler2 = new ReminderScheduler({ db, now: () => clock.now });
    scheduler2.tick();
    expect((db.prepare('SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ?').get(reminderId) as { c: number }).c).toBe(1);
    const { worker: worker2, adapter: adapter2 } = makeWorker(db);
    await worker2.runOnce(); // 无可领取派发——不动
    expect(adapter2.startTurnLog.length).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get(taskId) as { c: number }).c).toBe(1);
    db.close();
  }, 60_000);

  it('确认链：到点→awaiting→mine.pending→reminder.confirm→恰一次执行；确认前取消→拒绝执行', async () => {
    const { db, cmd } = makeEnv();
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const clock = { now: Date.now() };
    const at = clock.now + 60_000;
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: conv.conversationId, ownerMemberId: 'mA', title: '待确认提醒', schedule: { kind: 'once', at } });
    const scheduler = new ReminderScheduler({ db, now: () => clock.now });
    clock.now = at + 1;
    scheduler.tick();
    expect((db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c).toBe(0); // 确认前零执行
    // 确认前取消→确认拒绝（不执行）。取消链需要「触发后仍 active」的提醒（daily——once 触发
    // 后即 done 不可取消是既定合同）；due 由测试直插控制（被测物=cancel/confirm 命令面）。
    const ridCancel = `rem_cancel_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO reminders (id, conversation_id, owner_member_id, owner_user, title, timezone, schedule_json, next_at, status, auto_dispatch, created_at) VALUES (?,?,'mA','u_local','取消链','UTC',?,?, 'active',0,?)`)
      .run(ridCancel, conv.conversationId, JSON.stringify({ kind: 'daily', time: '07:00' }), at + 120_000, at - 60_000);
    clock.now = at + 121_000;
    scheduler.tick();
    await cmd('reminder.cancel', { reminderId: ridCancel });
    const occCancel = db.prepare('SELECT scheduled_at FROM reminder_occurrences WHERE reminder_id = ?').get(ridCancel) as { scheduled_at: number };
    await expect(cmd('reminder.confirm', { reminderId: ridCancel, scheduledAt: occCancel.scheduled_at })).rejects.toThrow(/已取消/);
    // 正常确认→恰一次执行。
    const confirmed = await cmd<{ taskId: string }>('reminder.confirm', { reminderId, scheduledAt: at });
    const { worker, adapter } = makeWorker(db);
    await worker.runOnce();
    const run = db.prepare('SELECT status FROM workflow_runs WHERE task_id = ?').get(confirmed.taskId) as { status: string };
    expect(run.status).toBe('SUCCEEDED');
    expect(adapter.startTurnLog.length).toBe(1); // 恰一次（取消链的确认被拒——无第二 turn）
    db.close();
  }, 60_000);

  it('预算沿执行次数：sum=1 的获准提醒恰一次执行；第二次到点拒绝（无第二次 turn）', async () => {
    const { db, cmd } = makeEnv();
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const clock = { now: Date.now() };
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: conv.conversationId, ownerMemberId: 'mA', title: '预算一次', schedule: { kind: 'daily', time: '08:00' }, budgetLimit: { sum: 1 }, autoDispatch: true });
    const scheduler = new ReminderScheduler({ db, now: () => clock.now });
    const due1 = (db.prepare('SELECT next_at FROM reminders WHERE id = ?').get(reminderId) as { next_at: number }).next_at;
    clock.now = due1 + 1;
    const o1 = scheduler.tick();
    expect(o1.fired[0]!.outcome).toBe('dispatched');
    const { worker, adapter } = makeWorker(db);
    await worker.runOnce();
    expect(adapter.startTurnLog.length).toBe(1);
    expect((db.prepare("SELECT count(*) c FROM real_calls").get() as { c: number }).c).toBe(0); // fake 执行零真实调用
    clock.now = due1 + 86_400_000 + 1;
    const o2 = scheduler.tick();
    expect(o2.paused.some((x) => x.reason === 'budget_exceeded')).toBe(true);
    await worker.runOnce(); // 无新派发可领
    expect(adapter.startTurnLog.length).toBe(1); // 恰一次——预算拒绝后无第二次执行
    db.close();
  }, 60_000);

  it('停止可解释：会话归档后到点=paused（零任务零 turn）；显式 update 继续=只触发未来计划（不补跑）', async () => {
    const { db, cmd } = makeEnv();
    const conv = await cmd<{ conversationId: string }>('conversation.create', { projectId: 'p1', peerMemberId: 'mA' });
    const clock = { now: Date.now() };
    const { reminderId } = await cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: conv.conversationId, ownerMemberId: 'mA', title: '停止链', schedule: { kind: 'daily', time: '07:00' }, autoDispatch: true });
    const scheduler = new ReminderScheduler({ db, now: () => clock.now });
    // 归档后到点。
    db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(clock.now, conv.conversationId);
    const due1 = (db.prepare('SELECT next_at FROM reminders WHERE id = ?').get(reminderId) as { next_at: number }).next_at;
    clock.now = due1 + 1;
    const o1 = scheduler.tick();
    expect(o1.paused[0]!.reason).toBe('conversation-archived');
    expect((db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c).toBe(0); // 零任务
    // 恢复会话+显式继续（update）——错过的批不补跑（dispatched 保持 0）；未来计划正常触发。
    db.prepare('UPDATE conversations SET archived_at = NULL WHERE id = ?').run(conv.conversationId);
    clock.now = due1 + 2 * 86_400_000; // 又错过 2 天（假钟域）
    await cmd('reminder.update', { reminderId, expectedRevision: 0, schedule: { kind: 'daily', time: '07:00' } });
    const row = db.prepare('SELECT status FROM reminders WHERE id = ?').get(reminderId) as { status: string };
    expect(row.status).toBe('active');
    expect((db.prepare('SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ? AND outcome = ?').get(reminderId, 'dispatched') as { c: number }).c).toBe(0); // 无补跑
    // 受控推进到未来一个新触发点（update 以真实时钟重算 next_at——测试直插可控值）：新 occurrence 派发一次。
    db.prepare('UPDATE reminders SET next_at = ? WHERE id = ?').run(clock.now + 60_000, reminderId);
    clock.now += 61_000;
    const o3 = scheduler.tick();
    expect(o3.fired[0]!.outcome).toBe('dispatched'); // 恢复后未来计划正常触发
    expect((db.prepare('SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ? AND outcome = ?').get(reminderId, 'dispatched') as { c: number }).c).toBe(1);
    await sleep(50);
    db.close();
  }, 60_000);
});
