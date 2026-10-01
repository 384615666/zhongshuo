/**
 * DEV-23（第二十四轮二/三）：提醒调度器——正式合同版（假时钟，零真实调用）。
 * 覆盖：
 * - computeNextAt 任意分钟（09:17/23:59）+ weekly + 跨日 + 时区；DST 两条明确规则
 *   （春跳变不存在→跳到下一计划日；秋回拨重复→取较早实例）；validateSchedule 范围校验；
 * - 原子触发：CAS+occurrence+派发意图同事务——派发中途抛错=整体回滚（不丢不重）；
 * - 正式派发链：房间→room_task+outbox `task:`；DM→dm_turn+outbox `dmtask:`；author=system
 *   （不伪装人类）；待确认路径=唤醒消息+awaiting_confirmation+reminder.confirm 正式确认；
 * - 休眠错过从**实际计划**推导（无预插 occurrence）；预算=本提醒 dispatched 作用域+损坏
 *   fail-closed；授权重查（归档/线程关闭/任务停止/owner 停用/DM 非对端）；close() 停止入口；
 * - 并发：独立连接写锁争用让出（busySkipped）+预领取让出（lost-race）——恰一次派发；
 * - 命令面：schedule 网关幂等（重放返原 ID；同号异参拒绝）；audience/owner/DM 对端；
 *   snooze revision；update timezone 列同步+cancelled 不复活；list 不泄露；mine.pending 待确认。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { ReminderScheduler, computeNextAt, countScheduledBetween, validateSchedule } from '../../src/daemon/reminderScheduler.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-rem24-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* Windows 句柄延迟 */ } } });

interface Harness {
  db: ZhongshuoDatabase;
  cmd: <T>(m: string, p: unknown, commandId?: string) => Promise<T>;
  cmdRaw: (m: string, p: unknown, commandId?: string) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  scheduler: ReminderScheduler;
  clock: { now: number };
  makeScheduler: (execDispatch?: ConstructorParameters<typeof ReminderScheduler>[0]['execDispatch']) => ReminderScheduler;
}
function seedBase(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(tmpRoot, tmpRoot);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mB','p1','Agent乙','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  // 房间成员关系（第二十五轮三：owner 须在目标房间跟进范围——seed 对齐 bootstrapProject）。
  db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?), (?, ?)').run('r0', 'mA', 'r0', 'mB');
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_dm1','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_dm1','human','u_local'),('p1','conv_dm1','agent','mA')`).run();
  // 他人 DM（audience 拒绝面）：human=u_other。
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_other_dm','p1','dm',NULL)`).run();
  db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','conv_other_dm','human','u_other'),('p1','conv_other_dm','agent','mA')`).run();
}
function makeHarness(): Harness {
  const db = openDatabase(':memory:');
  seedBase(db);
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const cmdRaw = async (method: string, params: unknown, commandId?: string) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: commandId ?? `rem-${randomUUID().slice(0, 8)}`, method, params }) as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const r = await cmdRaw(method, params, commandId);
    if (!r.ok) throw new Error(r.error?.message);
    return r.data as T;
  };
  const clock = { now: Date.now() }; // 与命令侧校验同域（真实纪元）——假钟只驱动调度 tick
  const makeScheduler = (execDispatch?: ConstructorParameters<typeof ReminderScheduler>[0]['execDispatch']) =>
    new ReminderScheduler({ db, now: () => clock.now, ...(execDispatch != null ? { execDispatch } : {}) });
  return { db, cmd, cmdRaw, scheduler: makeScheduler(), clock, makeScheduler };
}
const scheduleOnce = (h: Harness, at: number, extra: Record<string, unknown> = {}) =>
  h.cmd<{ reminderId: string; nextAt: number }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '一次性提醒', schedule: { kind: 'once', at }, ...extra });
const scheduleDaily = (h: Harness, time: string, extra: Record<string, unknown> = {}) =>
  h.cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '每日提醒', schedule: { kind: 'daily', time }, ...extra });

describe('DEV-23 正式合同：computeNextAt 任意分钟/DST 明确规则/校验（第二十四轮二）', () => {
  it('任意分钟：daily 09:17 Asia/Shanghai（UTC 化=次日/当日 01:17Z）；23:59 跨日', () => {
    // 2026-10-01T00:00Z 起算：上海当日 09:17=01:17Z 已过（00:00Z<01:17Z？00:00<01:17 未过）→ 当日 01:17Z。
    const base = Date.UTC(2026, 9, 1, 0, 0, 0);
    expect(computeNextAt({ kind: 'daily', time: '09:17', tz: 'Asia/Shanghai' }, base)).toBe(Date.UTC(2026, 9, 1, 1, 17, 0));
    // 23:59（UTC）：当日未过→当日 23:59Z；过了→次日。
    expect(computeNextAt({ kind: 'daily', time: '23:59' }, base)).toBe(Date.UTC(2026, 9, 1, 23, 59, 0));
    expect(computeNextAt({ kind: 'daily', time: '23:59' }, Date.UTC(2026, 9, 1, 23, 59, 30))).toBe(Date.UTC(2026, 9, 2, 23, 59, 0));
  });
  it('weekly：本地日历日星期判定（周一 07:03 的下一次）', () => {
    // 2026-10-05=周一。从周三 10-07 12:00Z 起，weekday=1（周一）07:03 UTC→10-12。
    const base = Date.UTC(2026, 9, 7, 12, 0, 0);
    expect(computeNextAt({ kind: 'weekly', weekday: 1, time: '07:03' }, base)).toBe(Date.UTC(2026, 9, 12, 7, 3, 0));
  });
  it('DST 规则①（春跳变不存在→跳到下一计划日）：America/New_York 2026-03-08 无 02:30', () => {
    // 03-07 12:00Z（当地 07:00 EST——03-07 的 02:30=07:30Z 已过）→ 03-08 被 02:00→03:00 跳过 → 03-09 02:30 EDT=06:30Z。
    expect(computeNextAt({ kind: 'daily', time: '02:30', tz: 'America/New_York' }, Date.UTC(2026, 2, 7, 12, 0, 0))).toBe(Date.UTC(2026, 2, 9, 6, 30, 0));
  });
  it('DST 规则②（秋回拨重复→取较早实例）：America/New_York 2026-11-01 01:30=05:30Z（EDT 第一次）', () => {
    expect(computeNextAt({ kind: 'daily', time: '01:30', tz: 'America/New_York' }, Date.UTC(2026, 9, 31, 12, 0, 0))).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
  });
  it('validateSchedule：时分越界/非法时区/weekday 越界拒绝；合法值通过', () => {
    expect(validateSchedule({ kind: 'daily', time: '25:00' }).ok).toBe(false);
    expect(validateSchedule({ kind: 'daily', time: '09:60' }).ok).toBe(false);
    expect(validateSchedule({ kind: 'daily', time: '09:17', tz: 'Mars/Olympus' }).ok).toBe(false);
    expect(validateSchedule({ kind: 'weekly', weekday: 7, time: '09:00' }).ok).toBe(false);
    expect(validateSchedule({ kind: 'once', at: Date.now() + 1000 }).ok).toBe(true);
    expect(validateSchedule({ kind: 'daily', time: '23:59', tz: 'Asia/Shanghai' }).ok).toBe(true);
  });
  it('countScheduledBetween：跨 3 天停机的 daily=3 个计划；once 窗口外=0', () => {
    const base = Date.UTC(2026, 9, 1, 0, 0, 0);
    expect(countScheduledBetween({ kind: 'daily', time: '08:00' }, base, base + 3 * 86_400_000)).toBe(3);
    expect(countScheduledBetween({ kind: 'daily', time: '08:00' }, base, base + 2 * 86_400_000 + 3_600_000)).toBe(2); // Oct3 01:00<Oct3 08:00——端点不含未到计划
    expect(countScheduledBetween({ kind: 'daily', time: '08:00' }, base + 3_600_000, base + 3 * 86_400_000 + 12 * 3_600_000)).toBe(4); // (Oct1 01:00, Oct4 12:00]：Oct1/2/3/4 各 08:00 全在内
    expect(countScheduledBetween({ kind: 'once', at: base + 1000 }, base + 2000, base + 3000)).toBe(0);
  });
});

describe('DEV-23 正式合同：原子触发+正式派发链（第二十四轮三/四）', () => {
  it('获准（autoDispatch）房间触发：system 消息+room_task+outbox task: 键+occurrence dispatched——同事务', async () => {
    const h = makeHarness();
    const at = h.clock.now + 60_000;
    const { reminderId } = await scheduleOnce(h, at, { autoDispatch: true });
    h.clock.now = at + 1;
    const out = h.scheduler.tick();
    expect(out.fired).toHaveLength(1);
    expect(out.fired[0]!.outcome).toBe('dispatched');
    const taskId = out.fired[0]!.taskId!;
    expect(taskId).toMatch(/^task_/);
    // 正式链事实（DB 断言——不是只查回调）：
    const task = h.db.prepare('SELECT kind, owner_member_id, conversation_id FROM tasks WHERE id = ?').get(taskId) as { kind: string; owner_member_id: string; conversation_id: string };
    expect(task.kind).toBe('room_task');
    expect(task.owner_member_id).toBe('mA'); // 只派发 owner
    expect(task.conversation_id).toBe('conv_room');
    expect((h.db.prepare('SELECT dispatch_key FROM outbox WHERE dispatch_key = ?').get(`task:${taskId}:initial`) as { dispatch_key: string }).dispatch_key).toBe(`task:${taskId}:initial`);
    const msg = h.db.prepare('SELECT author_type, author_id FROM messages WHERE conversation_id = ? AND author_type = ?').get('conv_room', 'system') as { author_type: string; author_id: string };
    expect(msg.author_id).toBe(`reminder:${reminderId}`); // 不伪装人类
    const occ = h.db.prepare('SELECT status, outcome, task_id, missed_count FROM reminder_occurrences WHERE reminder_id = ?').get(reminderId) as { status: string; outcome: string; task_id: string; missed_count: number };
    expect(occ).toMatchObject({ status: 'fired', outcome: 'dispatched', task_id: taskId, missed_count: 0 });
    const rem = h.db.prepare('SELECT status, next_at, last_fired_at FROM reminders WHERE id = ?').get(reminderId) as { status: string; next_at: number | null; last_fired_at: number };
    expect(rem.status).toBe('done');
    expect(rem.next_at).toBeNull();
    expect(rem.last_fired_at).toBe(at); // 计划推进+last_fired_at 同事务
    h.scheduler.tick();
    expect((h.db.prepare('SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ?').get(reminderId) as { c: number }).c).toBe(1); // 重启/重复 tick 不重复
    h.db.close();
  });
  it('DM 获准触发：dm_turn+outbox dmtask: 键+消息 system+输入水位=消息 seq；输入体带模板字段', async () => {
    const h = makeHarness();
    const at = h.clock.now + 60_000;
    const { reminderId } = await h.cmd<{ reminderId: string }>('reminder.schedule', {
      projectId: 'p1', conversationId: 'conv_dm1', ownerMemberId: 'mA', title: '私信日报', sourceRef: 'task_x:12',
      schedule: { kind: 'once', at }, budgetLimit: { sum: 5 }, autoDispatch: true,
    });
    h.clock.now = at + 1;
    const out = h.scheduler.tick();
    expect(out.fired[0]!.outcome).toBe('dispatched');
    const taskId = out.fired[0]!.taskId!;
    const task = h.db.prepare('SELECT kind, owner_member_id, input_through_seq FROM tasks WHERE id = ?').get(taskId) as { kind: string; owner_member_id: string; input_through_seq: number };
    expect(task.kind).toBe('dm_turn');
    expect(task.owner_member_id).toBe('mA');
    const input = h.db.prepare('SELECT body_json, conversation_seq, author_type FROM messages WHERE task_id = ?').get(taskId) as { body_json: string; conversation_seq: number; author_type: string };
    expect(input.author_type).toBe('system');
    expect(task.input_through_seq).toBe(input.conversation_seq); // 输入水位=唤醒消息 seq
    const text = JSON.parse(input.body_json).text as string;
    expect(text).toContain(`occurrence：${reminderId}@`); // DEV-21-M3 模板字段
    expect(text).toContain('时区 UTC');
    expect(text).toContain('来源：task_x:12');
    expect(text).toContain('已用 0/5 次执行');
    expect((h.db.prepare('SELECT dispatch_key FROM outbox WHERE dispatch_key = ?').get(`dmtask:${taskId}:initial`) as { dispatch_key: string }).dispatch_key).toBe(`dmtask:${taskId}:initial`);
    h.db.close();
  });
  it('待确认路径：未获准→唤醒消息（system）+awaiting_confirmation；mine.pending 列出；reminder.confirm→正式派发；重复确认拒绝', async () => {
    const h = makeHarness();
    const at = h.clock.now + 60_000;
    const { reminderId, nextAt } = await scheduleOnce(h, at, { conversationId: 'conv_dm1', autoDispatch: false });
    h.clock.now = at + 1;
    const out = h.scheduler.tick();
    expect(out.fired[0]!.outcome).toBe('awaiting_confirmation');
    expect((h.db.prepare('SELECT count(*) c FROM tasks WHERE conversation_id = ?').get('conv_dm1') as { c: number }).c).toBe(0); // 未建任务=未执行
    const wake = h.db.prepare('SELECT author_type, body_json FROM messages WHERE id = ?').get(`msg_rem_${reminderId}_${at}`) as { author_type: string; body_json: string };
    expect(wake.author_type).toBe('system');
    expect(JSON.parse(wake.body_json).text).toContain('待我处理'); // 确认入口指路
    // mine.pending：待确认触发=可行动项。
    const pending = await h.cmd<{ projects: Array<{ reminderAwaits: Array<{ reminder_id: string; scheduled_at: number; title: string | null }> }> }>('mine.pending', {});
    const entry = pending.projects.flatMap((p) => p.reminderAwaits).find((x) => x.reminder_id === reminderId);
    expect(entry?.scheduled_at).toBe(at);
    expect(entry?.title).toBe('一次性提醒');
    // 正式确认→dispatched+任务。
    const confirmed = await h.cmd<{ taskId: string }>('reminder.confirm', { reminderId, scheduledAt: at });
    const task = h.db.prepare('SELECT kind, owner_member_id FROM tasks WHERE id = ?').get(confirmed.taskId) as { kind: string; owner_member_id: string };
    expect(task).toMatchObject({ kind: 'dm_turn', owner_member_id: 'mA' });
    const occ = h.db.prepare('SELECT outcome, task_id, confirmed_at FROM reminder_occurrences WHERE reminder_id = ?').get(reminderId) as { outcome: string; task_id: string; confirmed_at: number };
    expect(occ.outcome).toBe('dispatched');
    expect(occ.task_id).toBe(confirmed.taskId);
    expect(occ.confirmed_at).toBeGreaterThan(0);
    await expect(h.cmd('reminder.confirm', { reminderId, scheduledAt: at })).rejects.toThrow(/不可确认/); // 重复确认拒绝
    const after = await h.cmd<{ projects: Array<{ reminderAwaits: unknown[] }> }>('mine.pending', {});
    expect(after.projects.some((p) => p.reminderAwaits.length > 0)).toBe(false); // 确认后不再待办
    void nextAt;
    h.db.close();
  });
  it('原子性（崩溃窗口）：派发中途抛错→整体回滚（无 occurrence/无任务/next_at 不动）→重试恰一次', async () => {
    const h = makeHarness();
    const at = h.clock.now + 60_000;
    const { reminderId } = await scheduleOnce(h, at, { autoDispatch: true });
    h.clock.now = at + 1;
    let failOnce = true;
    const scheduler2 = h.makeScheduler(() => {
      if (failOnce) { failOnce = false; throw new Error('注入：派发中途崩溃'); }
      return { taskId: `task_${randomUUID()}` };
    });
    expect(() => scheduler2.tick()).toThrow(/注入/);
    // 回滚事实：occurrence/task/消息全部未落，计划未推进（next_at 仍=at——重扫不丢触发）。
    expect((h.db.prepare('SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ?').get(reminderId) as { c: number }).c).toBe(0);
    expect((h.db.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c).toBe(0);
    expect((h.db.prepare('SELECT next_at, status FROM reminders WHERE id = ?').get(reminderId) as { next_at: number; status: string })).toMatchObject({ next_at: at, status: 'active' });
    const out = scheduler2.tick(); // 恢复后重试
    expect(out.fired).toHaveLength(1);
    expect((h.db.prepare('SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ?').get(reminderId) as { c: number }).c).toBe(1);
    h.db.close();
  });
  it('休眠错过从实际计划推导（无预插 occurrence）：3 天停机→一次触发 missed=3-1=2+occurrence 恰 2 行', async () => {
    const h = makeHarness();
    const { reminderId } = await scheduleDaily(h, '08:00'); // UTC
    // 第一天到点：正常触发（无错过）。
    const firstDue = (h.db.prepare('SELECT next_at FROM reminders WHERE id = ?').get(reminderId) as { next_at: number }).next_at;
    h.clock.now = firstDue + 1;
    h.scheduler.tick();
    const occ1 = h.db.prepare('SELECT missed_count FROM reminder_occurrences WHERE reminder_id = ? AND scheduled_at = ?').get(reminderId, firstDue) as { missed_count: number };
    expect(occ1.missed_count).toBe(0);
    // 停机 3.5 天（计划 day2/3/4 落在 (last_fired_at, now]）→ 合并为一次触发 missed=2，只补一行。
    h.clock.now = firstDue + 3 * 86_400_000 + 12 * 3_600_000;
    const out2 = h.scheduler.tick();
    expect(out2.fired).toHaveLength(1);
    expect(out2.fired[0]!.missedCount).toBe(2); // day2/day3/day4 共 3 个计划——首个为触发点，其余 2 合并
    expect(out2.fired[0]!.scheduledAt).toBe(firstDue + 86_400_000); // 触发点=最早的未处理计划
    const rows = h.db.prepare('SELECT scheduled_at, status FROM reminder_occurrences WHERE reminder_id = ? ORDER BY scheduled_at').all(reminderId) as Array<{ scheduled_at: number; status: string }>;
    expect(rows).toHaveLength(2); // 不逐次补跑——只有两次触发各一行
    const rem = h.db.prepare('SELECT next_at FROM reminders WHERE id = ?').get(reminderId) as { next_at: number };
    expect(rem.next_at).toBeGreaterThan(h.clock.now); // 推进到 now 之后（积压批剩余不再逐个补）
    h.db.close();
  });
  it('授权重查：会话归档/线程关闭/任务停止/owner 停用/DM 非对端→suppressed+paused（不派发）', async () => {
    const h = makeHarness();
    // 线程关闭（thread_id 挂靠——须为任务串：讨论串在 schedule 就被拒）。
    h.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES ('m_anchor','p1','conv_room',1,'r0','human','u_local','{}','final',0)`).run();
    h.db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id) VALUES ('th1','p1','conv_room','r0','m_anchor')`).run();
    h.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, title, status) VALUES ('t_th1','p1','conv_room','room_task','r0','th1','线程任务','ACTIVE')`).run();
    h.db.prepare(`UPDATE conversation_threads SET root_task_id = 't_th1' WHERE id = 'th1'`).run();
    const at1 = h.clock.now + 60_000;
    const { reminderId: rid1 } = await scheduleOnce(h, at1, { threadId: 'th1' });
    h.db.prepare("UPDATE conversation_threads SET status = 'closed' WHERE id = 'th1'").run();
    h.clock.now = at1 + 1;
    const out1 = h.scheduler.tick();
    expect(out1.paused[0]!.reason).toBe('thread-closed');
    expect((h.db.prepare('SELECT status FROM reminders WHERE id = ?').get(rid1) as { status: string }).status).toBe('paused');
    // 任务停止代次：绑定后**新**停止才判停（快照核对）；绑定时已停止=历史事实不永久禁止。
    h.clock.now = Date.now();
    const at2 = h.clock.now + 60_000;
    h.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status, stop_generation) VALUES ('t_stop','p1','conv_room','room_task','r0','已停一次','ACTIVE',1)`).run();
    const { reminderId: rid2 } = await scheduleOnce(h, at2, { taskId: 't_stop' });
    expect((h.db.prepare('SELECT bound_stop_generation FROM reminders WHERE id = ?').get(rid2) as { bound_stop_generation: number }).bound_stop_generation).toBe(1); // 绑定快照=历史停止
    h.db.prepare("UPDATE tasks SET stop_generation = 2 WHERE id = 't_stop'").run(); // 绑定后又停（新代次）
    h.clock.now = at2 + 1;
    expect(h.scheduler.tick().paused.some((x) => x.reason === 'task-stopped')).toBe(true); // 2>1 → 判停
    // 任务终态（CANCELLED）→ task-terminal。
    h.clock.now = Date.now();
    h.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, title, status) VALUES ('t_stop2','p1','conv_room','room_task','r0','终态','CANCELLED')`).run();
    const at2c = h.clock.now + 60_000;
    const { reminderId: rid2c } = await scheduleOnce(h, at2c, { taskId: 't_stop2' });
    h.clock.now = at2c + 1;
    expect(h.scheduler.tick().paused.some((x) => x.reason === 'task-terminal')).toBe(true);
    // owner 停用。
    h.clock.now = Date.now();
    const at3 = h.clock.now + 60_000;
    const { reminderId: rid3 } = await scheduleOnce(h, at3);
    h.db.prepare("UPDATE project_members SET enabled = 0 WHERE id = 'mA'").run();
    h.clock.now = at3 + 1;
    expect(h.scheduler.tick().paused[0]!.reason).toBe('owner-removed');
    h.db.prepare("UPDATE project_members SET enabled = 1 WHERE id = 'mA'").run();
    // DM 非对端（owner=不在该 DM 参与者里的成员 mB——seedBase 已建）。
    const at4 = Date.now() + 60_000;
    h.clock.now = Date.now();
    const { reminderId: rid4 } = await h.cmd<{ reminderId: string }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_dm1', ownerMemberId: 'mB', title: '非对端', schedule: { kind: 'once', at: at4 } })
      .catch(() => ({ reminderId: '' })); // 命令面会拒（对端校验）——绕过命令直插行测调度重查
    void rid4;
    h.db.prepare(`INSERT INTO reminders (id, conversation_id, thread_id, task_id, owner_member_id, owner_user, title, timezone, schedule_json, next_at, status, auto_dispatch, created_at) VALUES ('rem_direct','conv_dm1',NULL,NULL,'mB','u_local','直插','UTC',?,?,'active',1,0)`)
      .run(JSON.stringify({ kind: 'once', at: at4 }), at4);
    h.clock.now = at4 + 1;
    expect(h.scheduler.tick().paused.some((x) => x.reason === 'owner-not-peer')).toBe(true);
    // 会话归档。
    h.clock.now = Date.now();
    const at5 = h.clock.now + 60_000;
    const { reminderId: rid5 } = await scheduleOnce(h, at5, { conversationId: 'conv_dm1', ownerMemberId: 'mA' });
    h.db.prepare('UPDATE conversations SET archived_at = 1 WHERE id = ?').run('conv_dm1');
    h.clock.now = at5 + 1;
    expect(h.scheduler.tick().paused.some((x) => x.reason === 'conversation-archived')).toBe(true);
    h.db.close();
  });
  it('预算：作用域=本提醒 dispatched；超限拒绝+暂停；损坏 JSON fail-closed（不派发不冒充）', async () => {
    const h = makeHarness();
    // 本提醒 sum=1：第一次获准派发，第二次到点→budget_exceeded+paused。
    h.clock.now = Date.now();
    const at1 = h.clock.now + 60_000;
    const { reminderId } = await scheduleDaily(h, '08:00', { conversationId: 'conv_dm1', budgetLimit: { sum: 1 }, autoDispatch: true });
    const due1 = (h.db.prepare('SELECT next_at FROM reminders WHERE id = ?').get(reminderId) as { next_at: number }).next_at;
    h.clock.now = due1 + 1;
    const o1 = h.scheduler.tick();
    expect(o1.fired[0]!.outcome).toBe('dispatched');
    h.clock.now = due1 + 86_400_000 + 1;
    const o2 = h.scheduler.tick();
    expect(o2.paused.some((x) => x.reason === 'budget_exceeded')).toBe(true); // 超限=拒绝派发+暂停（paused 分支——不在 fired）
    const occ2 = h.db.prepare("SELECT outcome FROM reminder_occurrences WHERE reminder_id = ? ORDER BY scheduled_at DESC LIMIT 1").get(reminderId) as { outcome: string };
    expect(occ2.outcome).toBe('budget_exceeded');
    expect((h.db.prepare('SELECT status, paused_reason FROM reminders WHERE id = ?').get(reminderId) as { status: string; paused_reason: string })).toMatchObject({ status: 'paused', paused_reason: 'budget_exceeded' });
    expect((h.db.prepare('SELECT count(*) c FROM tasks WHERE conversation_id = ?').get('conv_dm1') as { c: number }).c).toBe(1); // 只有一次执行——不超发
    // 其他项目的调用不消耗本提醒额度（作用域=本提醒 occurrence）：另一提醒 sum=1 正常派发。
    const { reminderId: ridOther } = await scheduleDaily(h, '09:00', { conversationId: 'conv_dm1', autoDispatch: true, budgetLimit: { sum: 1 } });
    const dueOther = (h.db.prepare('SELECT next_at FROM reminders WHERE id = ?').get(ridOther) as { next_at: number }).next_at;
    h.clock.now = dueOther + 1;
    const o3 = h.scheduler.tick();
    expect(o3.fired.filter((x) => x.reminderId === ridOther)[0]!.outcome).toBe('dispatched');
    // 损坏 budget_json → fail-closed。
    const atBad = Date.now() + 120_000;
    h.clock.now = Date.now();
    const { reminderId: ridBad } = await scheduleOnce(h, atBad, { autoDispatch: true });
    h.db.prepare(`UPDATE reminders SET budget_json = '{bad json' WHERE id = ?`).run(ridBad);
    h.clock.now = atBad + 1;
    const o4 = h.scheduler.tick();
    expect(o4.paused.some((x) => x.reason === 'budget_corrupt')).toBe(true); // 损坏 fail-closed=拒绝派发+暂停取证（paused 分支）
    const occBad = h.db.prepare('SELECT outcome FROM reminder_occurrences WHERE reminder_id = ?').get(ridBad) as { outcome: string };
    expect(occBad.outcome).toBe('budget_corrupt');
    expect((h.db.prepare('SELECT paused_reason FROM reminders WHERE id = ?').get(ridBad) as { paused_reason: string }).paused_reason).toBe('budget_corrupt');
    expect((h.db.prepare('SELECT count(*) c FROM messages WHERE conversation_id = ?').get('conv_room') as { c: number }).c).toBe(0); // 损坏路径无唤醒消息（未到消息步骤）
    h.db.close();
  });
  it('close() 停止入口：关闭后 tick 全部早退（不扫描不派发）；遗留 pending occurrence 构造时收案', async () => {
    const h = makeHarness();
    const at = h.clock.now + 60_000;
    const { reminderId } = await scheduleOnce(h, at, { autoDispatch: true });
    h.clock.now = at + 1;
    h.scheduler.close();
    const out = h.scheduler.tick();
    expect(out.closed).toBe(true);
    expect(out.fired).toHaveLength(0);
    expect((h.db.prepare('SELECT count(*) c FROM reminder_occurrences').get() as { c: number }).c).toBe(0); // 未触发
    // 首包遗留 pending 收案：手工插一行 pending（模拟旧版崩溃窗口）→ 新实例构造即 merged。
    h.db.prepare("INSERT INTO reminder_occurrences (reminder_id, scheduled_at, status) VALUES (?, ?, 'pending')").run(reminderId, at - 30_000);
    const scheduler2 = h.makeScheduler();
    const swept = h.db.prepare('SELECT status, outcome FROM reminder_occurrences WHERE reminder_id = ? AND scheduled_at = ?').get(reminderId, at - 30_000) as { status: string; outcome: string };
    expect(swept.status).toBe('merged');
    expect(swept.outcome).toContain('legacy-pending-recovered');
    void scheduler2;
    h.db.close();
  });
});

describe('DEV-23 正式合同：并发（独立连接+受控同步点，第二十四轮三）', () => {
  it('写锁争用：他连接持写锁→本方 tick 让出（busySkipped/无派发）；释放后恰一次', async () => {
    const dbFile = join(tmpRoot, `conc-${randomUUID().slice(0, 8)}.sqlite`);
    const dbA = openDatabase(dbFile);
    const dbB = openDatabase(dbFile);
    seedBase(dbA); // 迁移在 A 上跑过；B 打开同库
    const deps = { db: dbB, localUserId: 'u_local', interruptTurn: async () => {} };
    const at = Date.now() + 90_000;
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `sched-${randomUUID().slice(0, 8)}`, method: 'reminder.schedule', params: { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '并发', schedule: { kind: 'once', at }, autoDispatch: true } }) as { ok: boolean };
    dbB.pragma('busy_timeout = 60'); // 测试内收紧——争用立即显现（生产 5000ms）
    const clock = { now: at + 1 };
    const schedulerB = new ReminderScheduler({ db: dbB, now: () => clock.now });
    // 受控同步点：A 持写锁（BEGIN IMMEDIATE+一条写，不提交）。
    dbA.prepare('BEGIN IMMEDIATE').run();
    dbA.prepare("UPDATE daemon_state SET value = 'held', updated_at = 1 WHERE key = 'noop'").run();
    const out = schedulerB.tick();
    const locked = out.busySkipped > 0 || out.fired.length === 0;
    expect(locked).toBe(true); // 让出或空转——不派发
    expect((dbB.prepare('SELECT count(*) c FROM reminder_occurrences').get() as { c: number }).c).toBe(0);
    dbA.prepare('COMMIT').run();
    const out2 = schedulerB.tick();
    expect(out2.fired).toHaveLength(1); // 释放后恰一次
    expect((dbB.prepare('SELECT count(*) c FROM reminder_occurrences').get() as { c: number }).c).toBe(1);
    dbA.close();
    dbB.close();
  });
  it('预领取让出（lost-race）：他连接已推进 next_at→本方 tick 不重复派发', async () => {
    const dbFile = join(tmpRoot, `conc-${randomUUID().slice(0, 8)}.sqlite`);
    const dbA = openDatabase(dbFile);
    const dbB = openDatabase(dbFile);
    seedBase(dbA);
    const deps = { db: dbB, localUserId: 'u_local', interruptTurn: async () => {} };
    const at = Date.now() + 90_000;
    const sched = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `sched-${randomUUID().slice(0, 8)}`, method: 'reminder.schedule', params: { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '竞态', schedule: { kind: 'once', at }, autoDispatch: true } }) as { ok: boolean; data: { reminderId: string } };
    const reminderId = sched.data!.reminderId;
    // 模拟并发调度者已完整处理（领取+done）——A 连接推进。
    dbA.prepare("UPDATE reminders SET next_at = NULL, status = 'done', last_fired_at = ? WHERE id = ?").run(at, reminderId);
    const clock = { now: at + 1 };
    const schedulerB = new ReminderScheduler({ db: dbB, now: () => clock.now });
    const out = schedulerB.tick();
    expect(out.fired).toHaveLength(0); // 本方让出——不重复派发
    expect((dbB.prepare('SELECT count(*) c FROM tasks').get() as { c: number }).c).toBe(0);
    dbA.close();
    dbB.close();
  });
});

describe('DEV-23 正式合同：命令面（幂等/audience/交错——第二十四轮三）', () => {
  it('schedule 网关幂等：同 commandId 重放返回原 reminderId；同号异参拒绝', async () => {
    const h = makeHarness();
    const commandId = `idem-${randomUUID().slice(0, 8)}`;
    const at = h.clock.now + 3_600_000;
    const first = await h.cmd<{ reminderId: string; nextAt: number }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '幂等', schedule: { kind: 'once', at } }, commandId);
    const replay = await h.cmd<{ reminderId: string; nextAt: number }>('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '幂等', schedule: { kind: 'once', at } }, commandId);
    expect(replay.reminderId).toBe(first.reminderId); // 重放=原 ID（不是新未持久化 ID）
    expect((h.db.prepare('SELECT count(*) c FROM reminders').get() as { c: number }).c).toBe(1);
    const conflict = await h.cmdRaw('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '异参', schedule: { kind: 'once', at } }, commandId);
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    h.db.close();
  });
  it('audience/owner 范围：他人 DM 拒绝建提醒；owner 非项目成员/非 DM 对端拒绝；任务/线程归属不符拒绝；非法计划拒绝', async () => {
    const h = makeHarness();
    const at = h.clock.now + 3_600_000;
    const r1 = await h.cmdRaw('reminder.schedule', { projectId: 'p1', conversationId: 'conv_other_dm', ownerMemberId: 'mA', title: '他人DM', schedule: { kind: 'once', at } });
    expect(r1.ok).toBe(false);
    expect(r1.error?.code).toBe('FORBIDDEN'); // 正式错误码（不只匹配文案）
    expect((h.db.prepare('SELECT count(*) c FROM reminders WHERE title = ?').get('他人DM') as { c: number }).c).toBe(0); // 状态未变（零写入）
    const r2 = await h.cmdRaw('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'm_not_exist', title: '幽灵成员', schedule: { kind: 'once', at } });
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe('SCOPE_MISMATCH');
    const r3 = await h.cmdRaw('reminder.schedule', { projectId: 'p1', conversationId: 'conv_dm1', ownerMemberId: 'mB', title: '非对端', schedule: { kind: 'once', at } });
    expect(r3.ok).toBe(false);
    expect(r3.error?.code).toBe('SCOPE_MISMATCH');
    const r4 = await h.cmdRaw('reminder.schedule', { projectId: 'p2', conversationId: 'conv_room', ownerMemberId: 'mA', title: '跨项目', schedule: { kind: 'once', at } });
    expect(r4.ok).toBe(false);
    expect(r4.error?.code).toBe('CONVERSATION_SCOPE_MISMATCH');
    const r5 = await h.cmdRaw('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '越界时刻', schedule: { kind: 'daily', time: '25:99' } });
    expect(r5.ok).toBe(false);
    expect(r5.error?.code).toBe('VALIDATION_INVALID');
    expect(r5.error?.message).toContain('越界');
    const r6 = await h.cmdRaw('reminder.schedule', { projectId: 'p1', conversationId: 'conv_room', ownerMemberId: 'mA', title: '坏时区', schedule: { kind: 'daily', time: '09:00', tz: 'Nowhere/Zone' } });
    expect(r6.ok).toBe(false);
    expect(r6.error?.code).toBe('VALIDATION_INVALID');
    expect(r6.error?.message).toContain('时区');
    h.db.close();
  });
  it('list/snooze/update/cancel 的 audience：他人 DM 提醒不泄露不可操作；timezone 列同步；cancelled 不复活；snooze bump revision', async () => {
    const h = makeHarness();
    // 他人 DM 下的提醒（直插——命令面拒绝创建，调度数据面仍可能出现）。
    h.db.prepare(`INSERT INTO reminders (id, conversation_id, owner_member_id, owner_user, title, timezone, schedule_json, next_at, status, auto_dispatch, created_at) VALUES ('rem_other','conv_other_dm','mA','u_other','他人提醒','UTC',?,?, 'active',0,0)`)
      .run(JSON.stringify({ kind: 'daily', time: '08:00' }), h.clock.now + 3_600_000);
    const list = await h.cmd<{ items: Array<{ reminderId: string }> }>('reminder.list', {});
    expect(list.items.some((x) => x.reminderId === 'rem_other')).toBe(false); // 不泄露
    for (const [method, params, wantCode] of [
      ['reminder.snooze', { reminderId: 'rem_other', until: h.clock.now + 7_200_000 }, 'FORBIDDEN'],
      ['reminder.update', { reminderId: 'rem_other', expectedRevision: 0, title: '偷改' }, 'FORBIDDEN'],
      ['reminder.cancel', { reminderId: 'rem_other' }, 'FORBIDDEN'],
      ['reminder.confirm', { reminderId: 'rem_other', scheduledAt: h.clock.now }, 'FORBIDDEN'],
    ] as const) {
      const r = await h.cmdRaw(method, params as unknown as Record<string, unknown>);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe(wantCode); // 正式错误码：audience 违反=FORBIDDEN
    }
    expect((h.db.prepare('SELECT status, revision, next_at FROM reminders WHERE id = ?').get('rem_other') as { status: string; revision: number; next_at: number })).toMatchObject({ status: 'active', revision: 0 }); // 状态未变
    // 正常链：snooze→revision+1；update 同步 timezone 列；cancel→done 不复活。
    const at = h.clock.now + 3_600_000;
    const { reminderId } = await scheduleOnce(h, at);
    const snoozed = await h.cmd<{ snoozed: boolean }>('reminder.snooze', { reminderId, until: at + 3_600_000 });
    expect(snoozed.snoozed).toBe(true);
    expect((h.db.prepare('SELECT revision FROM reminders WHERE id = ?').get(reminderId) as { revision: number }).revision).toBe(1);
    const updated = await h.cmd<{ revision: number }>('reminder.update', { reminderId, expectedRevision: 1, schedule: { kind: 'daily', time: '09:17', tz: 'Asia/Shanghai' } });
    expect(updated.revision).toBe(2);
    const row = h.db.prepare('SELECT timezone, schedule_json FROM reminders WHERE id = ?').get(reminderId) as { timezone: string; schedule_json: string };
    expect(row.timezone).toBe('Asia/Shanghai'); // 列与计划一致（修复：旧实现不同步）
    expect(JSON.parse(row.schedule_json).time).toBe('09:17');
    await expect(h.cmd('reminder.update', { reminderId, expectedRevision: 99, title: '旧版本' })).rejects.toThrow(/revision/); // 交错：旧 expectedRevision 拒绝
    await h.cmd('reminder.cancel', { reminderId });
    const revived = await h.cmdRaw('reminder.update', { reminderId, expectedRevision: 3, title: '复活' });
    expect(revived.ok).toBe(false); // 取消后不复活
    expect((h.db.prepare('SELECT status FROM reminders WHERE id = ?').get(reminderId) as { status: string }).status).toBe('cancelled');
    h.db.close();
  });
  it('snooze 与调度交错：贪睡后未到点不触发；到贪睡时刻触发（scheduledAt=贪睡值）', async () => {
    const h = makeHarness();
    const at = h.clock.now + 60_000;
    const { reminderId } = await scheduleOnce(h, at);
    const until = at + 3_600_000;
    await h.cmd('reminder.snooze', { reminderId, until });
    h.clock.now = at + 1;
    expect(h.scheduler.tick().fired).toHaveLength(0); // 原时刻已贪睡——不触发
    h.clock.now = until + 1;
    const out = h.scheduler.tick();
    expect(out.fired).toHaveLength(1);
    expect(out.fired[0]!.scheduledAt).toBe(until);
    h.db.close();
  });
});
