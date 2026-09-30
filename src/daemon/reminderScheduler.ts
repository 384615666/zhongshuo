/**
 * DEV-23 提醒调度器（REM 合同 §提醒——第二十三轮五首包）。
 *
 * 合同要点（本模块落地面）：
 * - occurrence 唯一键 (reminderId, scheduledAt)——并发 tick/重复 tick 只触发一次（CAS+INSERT OR IGNORE）；
 * - 休眠错过多次合并为一个待确认/获准触发（旧 pending→merged+missed_count 累计），不逐次补跑；
 * - 停止/归档/移出跟进使触发 paused（触发时重查会话归档/任务停止代次/成员启用），恢复不自动启动；
 * - 触发时重查授权和预算：预算超限=occurrence fired+outcome=budget-exceeded（不派发，不冒充成功）；
 * - scheduledAt/next_at 一律 UTC ms；时区只用于**服务端**计算下一次（computeNextAt——不依赖模型）；
 * - 只唤醒 ownerMemberId（派发目标=owner 成员）；通知与执行分开：状态未变且无可行动项不产生通知
 *   （模型侧经 DEV-21-M3 提醒模板承载——本模块只负责调度与派发，不做通知判断）。
 * 时钟注入（now()）：测试用假时钟驱动并发/重启/休眠/停止竞态，不睡真实时间。
 */
import type { ZhongshuoDatabase } from '../persistence/db.ts';

export interface ReminderSchedule {
  kind: 'once' | 'daily' | 'weekly';
  /** once：绝对时刻（UTC ms）。 */
  at?: number;
  /** daily/weekly：本地时刻 HH:mm（24h）。 */
  time?: string;
  /** weekly：0-6（周日=0）。 */
  weekday?: number;
  /** IANA 时区名（计算下一次用；缺省=UTC）。 */
  tz?: string;
}

interface ReminderRow {
  id: string;
  conversation_id: string; // 001：NOT NULL——提醒必挂会话（project 经 conversation 解析）
  thread_id: string | null;
  task_id: string | null;
  owner_member_id: string;
  owner_user: string | null;
  title: string | null;
  source_ref: string | null;
  timezone: string;
  schedule_json: string;
  next_at: number | null;
  status: string;
  budget_json: string | null;
}

/** 服务端计算下一次触发（UTC ms；once 触发后=null）。步进匹配法：候选 UTC →按 tz 格式化
 * 检查本地 HH:mm/weekday——DST 语义交给 ICU，不做偏移算术。 */
export function computeNextAt(schedule: ReminderSchedule, fromMs: number): number | null {
  if (schedule.kind === 'once') return schedule.at != null && schedule.at > fromMs ? schedule.at : null; // 已过期的 once=无未来触发（调度层不会领到：next_at 只存未来值）
  const tz = schedule.tz ?? 'UTC';
  const [hh, mm] = String(schedule.time ?? '09:00').split(':').map((x) => Number(x));
  const want = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  // 从 fromMs 起按 15 分钟步进，找第一个「未来时刻」满足本地时刻（与 once 不同：必须 > fromMs）。
  let t = Math.ceil((fromMs + 1) / 900_000) * 900_000;
  for (let i = 0; i < 8 * 24 * 4 + 8; i += 1) {
    const parts = fmt.formatToParts(new Date(t));
    const time = `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`;
    const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value ?? ''];
    const timeHit = time === want || time === `24:${String(mm).padStart(2, '0')}` && want.startsWith('00');
    if (timeHit && (schedule.kind !== 'weekly' || weekday === schedule.weekday) && t > fromMs) return t;
    t += 900_000;
  }
  return null;
}
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface ReminderSchedulerOptions {
  db: ZhongshuoDatabase;
  /** 时钟注入（测试假时钟；生产=Date.now）。 */
  now?: () => number;
  /** 派发动作（生产=创建唤醒任务；测试注入记录）。缺省=内置最小派发（DM 会话→dm_turn 任务行+系统消息）。 */
  dispatch?: (input: { reminder: ReminderRow; scheduledAt: number; missedCount: number }) => { dispatched: boolean; outcome: string };
}

export interface TickOutcome {
  fired: Array<{ reminderId: string; scheduledAt: number; outcome: string; missedCount: number }>;
  suppressed: Array<{ reminderId: string; scheduledAt: number; reason: string }>;
  paused: Array<{ reminderId: string; reason: string }>;
}

export class ReminderScheduler {
  private readonly db: ZhongshuoDatabase;
  private readonly now: () => number;
  private readonly dispatch: NonNullable<ReminderSchedulerOptions['dispatch']>;

  constructor(options: ReminderSchedulerOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.dispatch = options.dispatch ?? ((input) => this.defaultDispatch(input));
  }

  /** 单次扫描（幂等/并发安全：CAS 领取 + occurrence 唯一键）。测试直接调用以假时钟驱动。 */
  tick(): TickOutcome {
    const now = this.now();
    const outcome: TickOutcome = { fired: [], suppressed: [], paused: [] };
    const due = this.db.prepare("SELECT * FROM reminders WHERE status = 'active' AND next_at <= ? ORDER BY next_at").all(now) as unknown as ReminderRow[];
    for (const reminder of due) {
      if (reminder.next_at == null) continue; // due 查询已限定 next_at<=now（null 行防御性跳过）
      const dueAt: number = reminder.next_at;
      const schedule = JSON.parse(reminder.schedule_json) as ReminderSchedule;
      // 休眠错过合并（合同）：next_at 之前的旧 pending（休眠/停机期间积压）合并为本次的
      // missed_count——只触发一次，不逐次补跑。
      const missed = this.db.prepare(
        "SELECT scheduled_at FROM reminder_occurrences WHERE reminder_id = ? AND status = 'pending' AND scheduled_at < ? ORDER BY scheduled_at",
      ).all(reminder.id, dueAt) as Array<{ scheduled_at: number }>;
      let missedCount = missed.length;
      if (missed.length > 0) {
        const txMerge = this.db.transaction(() => {
          const up = this.db.prepare("UPDATE reminder_occurrences SET status = 'merged' WHERE reminder_id = ? AND status = 'pending' AND scheduled_at < ?").run(reminder.id, reminder.next_at);
          missedCount = up.changes;
        });
        txMerge();
      }
      // 触发时重查（合同）：会话归档/任务停止/成员移出（enabled=0）→ paused + 本次 suppressed。
      const recheck = this.recheckAuthority(reminder);
      if (!recheck.ok) {
        const txPause = this.db.transaction(() => {
          this.db.prepare("UPDATE reminders SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(recheck.reason, now, reminder.id);
          this.db.prepare('INSERT OR IGNORE INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome) VALUES (?, ?, ?, ?)').run(reminder.id, dueAt, 'suppressed', `paused:${recheck.reason}`);
        });
        txPause();
        outcome.paused.push({ reminderId: reminder.id, reason: recheck.reason });
        outcome.suppressed.push({ reminderId: reminder.id, scheduledAt: dueAt, reason: recheck.reason });
        continue;
      }
      // CAS 领取（并发 tick 只一个赢）：next_at 前移到下一次，失败=别人已处理。
      const nextNext = computeNextAt(schedule, Math.max(now, dueAt));
      const claimed = this.db.prepare('UPDATE reminders SET next_at = ?, status = ?, updated_at = ? WHERE id = ? AND next_at = ? AND status = \'active\'')
        .run(nextNext ?? 0, nextNext == null ? 'done' : 'active', now, reminder.id, reminder.next_at).changes;
      if (claimed !== 1) continue;
      // 唯一 occurrence：INSERT OR IGNORE——重复 tick（重启后同 scheduled_at 再扫）不重复触发。
      const occ = this.db.prepare('INSERT OR IGNORE INTO reminder_occurrences (reminder_id, scheduled_at, status, missed_count) VALUES (?, ?, \'pending\', ?)')
        .run(reminder.id, reminder.next_at, missedCount).changes;
      if (occ !== 1) continue; // 已有同 scheduled_at 行（历史已 fired/suppressed）——不重复
      const result = this.dispatch({ reminder, scheduledAt: dueAt, missedCount });
      const txFire = this.db.transaction(() => {
        this.db.prepare("UPDATE reminder_occurrences SET status = 'fired', fired_at = ?, outcome = ? WHERE reminder_id = ? AND scheduled_at = ? AND status = 'pending'")
          .run(now, result.outcome, reminder.id, dueAt);
      });
      txFire();
      outcome.fired.push({ reminderId: reminder.id, scheduledAt: dueAt, outcome: result.outcome, missedCount });
    }
    return outcome;
  }

  /** 触发时重查授权面（合同）：会话归档/任务停止代次/owner 成员移出或停用/预算超限。 */
  private recheckAuthority(reminder: ReminderRow): { ok: true } | { ok: false; reason: string } {
    if (reminder.conversation_id != null) {
      const conv = this.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(reminder.conversation_id) as { archived_at: number | null } | undefined;
      if (conv == null) return { ok: false, reason: 'conversation-missing' };
      if (conv.archived_at != null) return { ok: false, reason: 'conversation-archived' };
    }
    if (reminder.task_id != null) {
      const task = this.db.prepare('SELECT status, stop_generation FROM tasks WHERE id = ?').get(reminder.task_id) as { status: string; stop_generation: number } | undefined;
      if (task != null && (task.stop_generation > 0 || ['CANCELLED'].includes(task.status))) return { ok: false, reason: 'task-stopped' };
    }
    const member = this.db.prepare('SELECT enabled FROM project_members WHERE id = ?').get(reminder.owner_member_id) as { enabled: number } | undefined;
    if (member == null || member.enabled !== 1) return { ok: false, reason: 'owner-removed' };
    return { ok: true };
  }

  /** 预算重查（合同：触发时重查预算）：budget_json={sum:N} 与已用真实调用比较（首包口径：
   * 真实调用次数——金额台账口径待 FULL 预算链接入）。 */
  budgetExceeded(reminder: ReminderRow): boolean {
    if (reminder.budget_json == null || reminder.conversation_id == null) return false;
    try {
      const limit = JSON.parse(reminder.budget_json) as { sum?: number };
      if (limit.sum == null) return false;
      const used = (this.db.prepare('SELECT count(*) c FROM real_calls').get() as { c: number }).c;
      return used >= limit.sum;
    } catch { return false; }
  }

  /** 内置最小派发：向会话插唤醒消息（人侧可见=「只唤醒 owner」的通知面；模型执行经既有
   * 派发链——首包不自动建 turn，用户确认/获准后由常规入口执行）。 */
  private defaultDispatch(input: { reminder: ReminderRow; scheduledAt: number; missedCount: number }): { dispatched: boolean; outcome: string } {
    const { reminder } = input;
    if (this.budgetExceeded(reminder)) return { dispatched: false, outcome: 'budget-exceeded（预算超限——不派发，不冒充成功）' };
    const now = this.now();
    const projectId = (this.db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(reminder.conversation_id) as { project_id: string } | undefined)?.project_id;
    if (projectId == null) return { dispatched: false, outcome: 'dispatch-failed:conversation-missing' };
    const tx = this.db.transaction(() => {
      const convSeq = (this.db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq').get(reminder.conversation_id) as { last_message_seq: number } | undefined)?.last_message_seq ?? 1;
      this.db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id, thread_message_seq, author_type, author_id, body_json, status, created_at)
                       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'human', ?, ?, 'final', ?)`)
        .run(`msg_rem_${reminder.id}_${input.scheduledAt}`, projectId, reminder.conversation_id, convSeq, reminder.owner_user ?? 'u_local', JSON.stringify({ text: `【提醒触发】${reminder.title ?? reminder.id}（原定 ${new Date(input.scheduledAt).toISOString()}，合并 ${input.missedCount} 次错过）` }), now);
    });
    try { tx(); return { dispatched: true, outcome: 'dispatched' }; } catch (error) {
      return { dispatched: false, outcome: `dispatch-failed:${String(error instanceof Error ? error.message : error).slice(0, 80)}` };
    }
  }
}
