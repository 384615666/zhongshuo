/**
 * DEV-23 首包（第二十三轮五）：提醒调度器——假时钟驱动（不睡真实时间），零真实调用。
 * 覆盖（REM 合同）：once 到点触发一次即 done；daily 连续两次；occurrence 唯一键（并发双
 * tick 只触发一次）；重启（新实例）不重复触发；休眠错过合并为一个触发（merged+missedCount，
 * 不逐次补跑）；停止竞态（会话归档→suppressed+paused，恢复不自动启动）；owner 移出→paused；
 * 预算拒绝（budget-exceeded 不派发不冒充成功）；时区计算（Asia/Shanghai daily 的 UTC 化）；
 * snooze/update/cancel 命令面。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { ReminderScheduler, computeNextAt } from '../../src/daemon/reminderScheduler.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-rem-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

interface Harness {
  db: ZhongshuoDatabase;
  cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T>;
  scheduler: ReminderScheduler;
  fired: Array<{ reminderId: string; scheduledAt: number; outcome: string; missedCount: number }>;
  clock: { now: number };
}
function makeHarness(dispatchOverride?: Harness['scheduler'] extends never ? never : NonNullable<ConstructorParameters<typeof ReminderScheduler>[0]['dispatch']>): Harness {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `rem-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: T; error?: { message: string } };
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const clock = { now: Date.now() }; // 与命令侧校验同域（真实纪元）——假钟只驱动调度 tick
  const fired: Harness['fired'] = [];
  const scheduler = new ReminderScheduler({
    db,
    now: () => clock.now,
    dispatch: dispatchOverride ?? ((input) => {
      fired.push({ reminderId: input.reminder.id, scheduledAt: input.scheduledAt, outcome: 'dispatched-test', missedCount: input.missedCount });
      return { dispatched: true, outcome: 'dispatched-test' };
    }),
  });
  return { db, cmd, scheduler, fired, clock };
}
const scheduleOnce = (h: Harness, at: number, extra: Record<string, unknown> = {}) =>
  h.cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '一次性提醒', schedule: { kind: 'once', at }, ...extra });
const scheduleDaily = (h: Harness, time: string, tz?: string) =>
  h.cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '每日提醒', schedule: { kind: 'daily', time, ...(tz != null ? { tz } : {}) } });

describe('DEV-23 首包：提醒调度器（假时钟，零真实调用）', () => {
  it('once：到点触发恰一次→done；未到点不触发', async () => {
    const h = makeHarness();
    const at = h.clock.now + 3_600_000;
    const { reminderId } = await scheduleOnce(h, at);
    h.scheduler.tick();
    expect(h.fired).toHaveLength(0); // 未到点
    h.clock.now = at + 1;
    const out = h.scheduler.tick();
    expect(out.fired).toHaveLength(1);
    expect(h.fired[0]!.scheduledAt).toBe(at);
    h.clock.now = at + 7200_000;
    h.scheduler.tick();
    expect(h.fired).toHaveLength(1); // once 只触发一次
    const status = (h.db.prepare('SELECT status FROM reminders WHERE id = ?').get(reminderId) as { status: string }).status;
    expect(status).toBe('done');
    h.db.close();
  });

  it('daily 连续两次触发（假时钟步进 25h×2）；时区计算=Asia/Shanghai 09:00 的 UTC 化', async () => {
    const h = makeHarness();
    // 上海 09:00=UTC 01:00：从 UTC 02:00 起，下一次=次日 UTC 01:00。
    const base = Date.now() + 24 * 3600_000; // 未来基准（命令校验域）——具体时区语义由 computeNextAt 单元用例锁定
    h.clock.now = base;
    await scheduleDaily(h, '09:00', 'Asia/Shanghai');
    const out1 = h.scheduler.tick();
    expect(out1.fired).toHaveLength(1);
    const d = new Date(out1.fired[0]!.scheduledAt);
    expect(d.getUTCHours()).toBe(1); // 上海 09:00=UTC 01:00（UTC 化正确）
    expect(d.getUTCMinutes()).toBe(0);
    h.clock.now = out1.fired[0]!.scheduledAt + 25 * 3600_000;
    const out2 = h.scheduler.tick();
    expect(out2.fired).toHaveLength(1);
    expect(out2.fired[0]!.scheduledAt - out1.fired[0]!.scheduledAt).toBe(24 * 3600_000); // 次日同一时刻
    h.db.close();
  });

  it('occurrence 唯一键：同一到点并发/重复 tick 只触发一次；重启（新实例）不重复', async () => {
    const h = makeHarness();
    const at = h.clock.now + 60_000;
    await scheduleOnce(h, at);
    h.clock.now = at + 1;
    const a = h.scheduler.tick();
    const b = h.scheduler.tick(); // 重复 tick（同 scheduled_at 已 fired）
    expect(a.fired).toHaveLength(1);
    expect(b.fired).toHaveLength(0);
    // 重启等价：新调度器实例（同 db）再扫。
    const scheduler2 = new ReminderScheduler({ db: h.db, now: () => h.clock.now, dispatch: (input) => { h.fired.push({ reminderId: input.reminder.id, scheduledAt: input.scheduledAt, outcome: 'restart-test', missedCount: 0 }); return { dispatched: true, outcome: 'restart-test' }; } });
    scheduler2.tick();
    expect(h.fired.length).toBe(1);
    h.db.close();
  });

  it('休眠错过合并：paused 期间积压多次→恢复后合并为一个触发（missedCount≥2，不逐次补跑）', async () => {
    const h = makeHarness();
    // paused 的 daily：三个到点过去后 resume（直接置回 active——合同：恢复不自动启动触发链，
    // 下一次到点时的合并语义=积压 pending 合并）。
    const { reminderId } = await scheduleDaily(h, '00:00', 'UTC');
    h.db.prepare("UPDATE reminders SET status = 'paused', paused_reason = 'conversation-archived', next_at = ? WHERE id = ?").run(h.clock.now, reminderId);
    // 构造积压：三个过去时刻的 pending occurrence（模拟休眠期间错过的计划）。
    for (let i = 1; i <= 3; i += 1) {
      h.db.prepare("INSERT INTO reminder_occurrences (reminder_id, scheduled_at, status) VALUES (?, ?, 'pending')").run(reminderId, h.clock.now - i * 3600_000);
    }
    h.db.prepare("UPDATE reminders SET status = 'active' WHERE id = ?").run(reminderId);
    h.clock.now += 60_000;
    const out = h.scheduler.tick();
    expect(out.fired).toHaveLength(1); // 只触发一次
    expect(out.fired[0]!.missedCount).toBe(3); // 三次错过合并计入
    const merged = h.db.prepare("SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ? AND status = 'merged'").get(reminderId) as { c: number };
    expect(merged.c).toBe(3); // 旧的逐条标记 merged——不逐次补跑
    h.db.close();
  });

  it('停止竞态：会话归档后到点→suppressed+提醒 paused（恢复不自动触发）；owner 移出同理', async () => {
    const h = makeHarness();
    const at = h.clock.now + 60_000;
    await scheduleOnce(h, at, { conversationId: 'conv_room' });
    h.db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(h.clock.now, 'conv_room');
    h.clock.now = at + 1;
    const out = h.scheduler.tick();
    expect(out.paused).toHaveLength(1);
    expect(out.paused[0]!.reason).toBe('conversation-archived');
    expect(out.fired).toHaveLength(0); // 不派发
    // 恢复会话+提醒：恢复不自动启动（下次到点才重查——once 的 next_at 已被领走→done？不：
    // paused 分支不改 next_at——恢复后手动置 active，同 scheduled_at 已 suppressed 不重触）。
    h.db.prepare('UPDATE conversations SET archived_at = NULL WHERE id = ?').run('conv_room');
    h.db.prepare("UPDATE reminders SET status = 'active' WHERE paused_reason = 'conversation-archived'").run();
    const out2 = h.scheduler.tick();
    expect(out2.fired).toHaveLength(0); // 恢复不自动补触发（occurrence 已 suppressed）
    // owner 移出（enabled=0）→下一提醒 paused。
    const at2 = h.clock.now + 60_000;
    await scheduleOnce(h, at2);
    h.db.prepare('UPDATE conversations SET archived_at = NULL WHERE id IS NOT NULL AND id = ?').run('conv_room');
    h.db.prepare("UPDATE project_members SET enabled = 0 WHERE id = 'mA'").run();
    h.clock.now = at2 + 1;
    const out3 = h.scheduler.tick();
    expect(out3.paused.some((x) => x.reason === 'owner-removed')).toBe(true);
    h.db.close();
  });

  it('预算拒绝：budgetLimit 超限→occurrence fired+outcome=budget-exceeded（不派发、不冒充成功）', async () => {
    const h = makeHarness();
    // 内置派发的预算路径：不注入 override——用默认 dispatch（budgetExceeded 检查 real_calls）。
    h.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_dm1','p1','dm',NULL)`).run();
    h.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm1','human','u_local'),('p1','conv_dm1','agent','mA')`).run();
    h.db.prepare(`INSERT INTO real_calls (turn_id, batch_id, runtime_kind, model, status, created_at) VALUES ('t_seed','b','claude','deepseek-flash','succeeded', 0)`).run();
    const at = h.clock.now + 60_000;
    const { reminderId } = await scheduleOnce(h, at, { conversationId: 'conv_dm1', budgetLimit: { sum: 1 } }); // 已用 1≥1=超限
    const clock = { now: h.clock.now };
    const scheduler2 = new ReminderScheduler({ db: h.db, now: () => clock.now });
    clock.now = at + 1;
    const out = scheduler2.tick();
    expect(out.fired).toHaveLength(1);
    expect(out.fired[0]!.outcome).toContain('budget-exceeded'); // 如实：不冒充成功
    const msgs = h.db.prepare("SELECT count(*) c FROM messages WHERE conversation_id = 'conv_dm1' AND body_json LIKE '%提醒触发%'").get() as { c: number };
    expect(msgs.c).toBe(0); // 未派发（无唤醒消息）
    void reminderId;
    h.db.close();
  });

  it('命令面：snooze 推迟（晚于当前）；update 换计划（revision CAS）；cancel；list 返回计划与 pending', async () => {
    const h = makeHarness();
    const at = h.clock.now + 3600_000;
    const { reminderId } = await scheduleOnce(h, at);
    await expect(h.cmd('reminder.snooze', { reminderId, until: at - 1 })).rejects.toThrow(/晚于/); // 早于当前=拒绝
    const snoozed = await h.cmd<{ snoozed: boolean }>('reminder.snooze', { reminderId, until: at + 3600_000 });
    expect(snoozed.snoozed).toBe(true);
    await expect(h.cmd('reminder.update', { reminderId, expectedRevision: 99, title: 'x' })).rejects.toThrow(/revision/); // CAS
    const updated = await h.cmd<{ revision: number }>('reminder.update', { reminderId, expectedRevision: 0, title: '新标题' });
    expect(updated.revision).toBe(1);
    const list = await h.cmd<{ items: Array<{ reminderId: string; title: string; status: string; nextAt: number }> }>('reminder.list', { projectId: 'p1' });
    expect(list.items[0]!.title).toBe('新标题');
    const cancelled = await h.cmd<{ cancelled: boolean }>('reminder.cancel', { reminderId });
    expect(cancelled.cancelled).toBe(true);
    h.db.close();
  });

  it('computeNextAt 单元：once 过去=null；daily UTC 无 tz；weekly 指定星期', () => {
    const base = Date.UTC(2026, 5, 10, 12, 0, 0);
    expect(computeNextAt({ kind: 'once', at: base - 1 }, base)).toBeNull();
    expect(computeNextAt({ kind: 'once', at: base + 1 }, base)).toBe(base + 1);
    const daily = computeNextAt({ kind: 'daily', time: '23:45' }, base);
    expect(daily).toBe(Date.UTC(2026, 5, 10, 23, 45, 0));
    const weekly = computeNextAt({ kind: 'weekly', weekday: 1, time: '08:00' }, base); // 2026-06-10=周三→下周一
    expect(new Date(weekly!).getUTCDay()).toBe(1);
    expect(weekly! > base).toBe(true);
  });
});

