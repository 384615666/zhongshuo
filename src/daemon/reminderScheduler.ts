/**
 * DEV-23 提醒调度器（第二十四轮二/三——正式合同版，重写首包实现）。
 *
 * 相对首包的核心修正（每条都有测试锚定）：
 * 1. **computeNextAt 任意分钟**：HH:mm 任意合法值（09:17/23:59）可达——不再 15 分钟步进。
 *    DST 规则明确化（不交给 ICU 隐式决定）：
 *    - 不存在的本地时刻（春季跳变被跳过）：当日跳过，取下一计划日同时刻；
 *    - 重复的本地时刻（秋季回拨出现两次）：取较早的一次（第一次出现）。
 *    两条规则由「naive-UTC 起步+分钟差归一化修正」算法推导（utcForCivilWall——gap 振荡
 *    即不存在；ambiguous 收敛较早实例），测试以真实转换日断言。
 * 2. **原子触发**：CAS 领取+计划推进（next_at/status）+last_fired_at+唯一 occurrence+派发意图
 *    （唤醒消息/正式任务/outbox 键）在**同一事务**。崩溃窗口闭合：
 *    - 领取后/occurrence 后/意图提交后：要么全提交要么全回滚——无「标 done 未执行」中间态；
 *    - 意图提交后、执行结算前：outbox 行持久，worker 既有恢复合同承接（drain/UNKNOWN/
 *      applyRecovery）——不丢触发、不盲目重发（dispatch_key 唯一）。
 * 3. **休眠错过推导**：missed = 计划在 (last_fired_at ?? created_at, now] 内的触发数-1——
 *    从实际计划推导（countScheduledBetween），不依赖预插 occurrence 行。
 * 4. **预算 fail-closed+正确作用域**：作用域=本提醒已派发 occurrence（每次派发恰一个任务=
 *    恰一次 startTurn 计数；与派发同事务落库=预占原子）；损坏 budget_json 拒绝派发
 *    （outcome=budget_corrupt+暂停取证——不冒充）。
 * 5. **停止入口**：close() 后 tick 早退——daemon.stop 第一步调用（先停扫描/派发再收拢）。
 * 6. 遗留 pending occurrence（首包崩溃窗口可能遗留）启动时收案为 merged——其派发最多插入过
 *    幂等 id 的消息、从未建立正式执行，不重发。
 */
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { dispatchReminderExecution, insertReminderWakeMessage, parseSchedule, reminderCallUsage, budgetLimitOf } from './reminderDispatch.ts';

export interface ReminderSchedule {
  kind: 'once' | 'daily' | 'weekly';
  /** once：绝对时刻（UTC ms）。 */
  at?: number;
  /** daily/weekly：本地时刻 HH:mm（24h，任意分钟）。 */
  time?: string;
  /** weekly：0-6（周日=0）。 */
  weekday?: number;
  /** IANA 时区名（计算下一次用；缺省=UTC）。 */
  tz?: string;
}

/** 计划校验（命令面与调度共用）：时分范围/weekday 范围/IANA 时区/once.at。 */
export function validateSchedule(schedule: ReminderSchedule): { ok: true } | { ok: false; error: string } {
  if (schedule.kind === 'once') {
    if (!Number.isInteger(schedule.at) || (schedule.at ?? 0) <= 0) return { ok: false, error: 'once.at 必须为正整数（UTC 毫秒）' };
    return { ok: true };
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(schedule.time ?? ''));
  if (m == null) return { ok: false, error: 'time 必须为 HH:mm（24h）' };
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: `时刻越界（${m[1]}:${m[2]}）——小时 0-23、分钟 0-59` };
  if (schedule.kind === 'weekly' && (!Number.isInteger(schedule.weekday) || (schedule.weekday ?? -1) < 0 || (schedule.weekday ?? 7) > 6)) {
    return { ok: false, error: 'weekday 必须为 0-6（周日=0）' };
  }
  if (schedule.tz != null && !isValidTimeZone(schedule.tz)) return { ok: false, error: `无效 IANA 时区：${schedule.tz}` };
  return { ok: true };
}

// ---------- 本地墙钟 ↔ UTC（DST 明确规则） ----------

interface CivilParts { y: number; m: number; d: number; hh: number; mm: number; }
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = FORMATTERS.get(tz);
  if (f == null) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    FORMATTERS.set(tz, f);
  }
  return f;
}
function isValidTimeZone(tz: string): boolean {
  try { formatterFor(tz); return true; } catch { return false; }
}
function civilOf(tz: string, t: number): CivilParts & { wd: number } {
  const parts = formatterFor(tz).formatToParts(new Date(t));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    hh: Number(get('hour')) % 24, mm: Number(get('minute')),
    wd: WEEKDAYS[get('weekday')] ?? -1,
  };
}
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 该本地日期的 HH:mm 对应的 UTC 时刻。
 * 算法：naive-UTC 起步，反复按「目标墙钟-实际墙钟」的归一化分钟差（[-12h,12h)）修正：
 * - 常规时区 1-2 轮收敛；重复时刻（秋季回拨）收敛到**较早**实例；跳变内时刻（春季 gap）
 *   在边界两侧振荡不收敛→4 轮后返回 null（=当日该时刻不存在→跳到下一计划日）。 */
function utcForCivilWall(civil: CivilParts, hh: number, mm: number, tz: string): number | null {
  const target = hh * 60 + mm;
  let t = Date.UTC(civil.y, civil.m - 1, civil.d, hh, mm);
  for (let i = 0; i < 4; i += 1) {
    const p = civilOf(tz, t);
    if (p.y === civil.y && p.m === civil.m && p.d === civil.d && p.hh === hh && p.mm === mm) return t;
    let delta = (((target - (p.hh * 60 + p.mm)) % 1440) + 1440) % 1440;
    if (delta > 720) delta -= 1440;
    if (delta === 0) {
      const dayShift = Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(civil.y, civil.m - 1, civil.d);
      if (dayShift === 0) return null; // 同日同墙钟却不匹配（防御——不可达）
      t += dayShift > 0 ? -86_400_000 : 86_400_000;
      continue;
    }
    t += delta * 60_000;
  }
  return null;
}

function civilAddDays(civil: CivilParts, days: number): CivilParts {
  const shifted = new Date(Date.UTC(civil.y, civil.m - 1, civil.d + days));
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(), hh: civil.hh, mm: civil.mm };
}
function civilWeekday(civil: CivilParts): number {
  return new Date(Date.UTC(civil.y, civil.m - 1, civil.d)).getUTCDay();
}

/** 服务端计算下一次触发（UTC ms；严格 > fromMs；once 已过=null）。任意分钟可达；
 * weekly 按**本地日历日**的星期判定（不从 UTC 瞬时星期反推）。上限 10 个候选日
 * （daily 1 轮内命中；weekly ≤8；gap 日跳过仍留余量）。 */
export function computeNextAt(schedule: ReminderSchedule, fromMs: number): number | null {
  if (schedule.kind === 'once') return schedule.at != null && schedule.at > fromMs ? schedule.at : null;
  const tz = schedule.tz ?? 'UTC';
  const [hhRaw, mmRaw] = String(schedule.time ?? '09:00').split(':').map((x) => Number(x));
  if (typeof hhRaw !== 'number' || typeof mmRaw !== 'number' || !Number.isInteger(hhRaw) || !Number.isInteger(mmRaw) || hhRaw < 0 || hhRaw > 23 || mmRaw < 0 || mmRaw > 59) return null;
  const hh = hhRaw;
  const mm = mmRaw;
  const start = civilOf(tz, fromMs);
  for (let offset = 0; offset <= 9; offset += 1) {
    const civil = civilAddDays(start, offset);
    if (schedule.kind === 'weekly' && civilWeekday(civil) !== schedule.weekday) continue;
    const t = utcForCivilWall(civil, hh, mm, tz);
    if (t == null) continue; // DST 规则①：该日此时刻不存在（春季跳变）→ 跳到下一计划日
    if (t > fromMs) return t;
  }
  return null;
}

/** 计划在 (fromMs, toMs] 内的触发数（休眠错过推导用——从实际计划数，不数 occurrence 行）。 */
export function countScheduledBetween(schedule: ReminderSchedule, fromMs: number, toMs: number): number {
  if (schedule.kind === 'once') return schedule.at != null && schedule.at > fromMs && schedule.at <= toMs ? 1 : 0;
  let n = 0;
  let t = fromMs;
  for (let guard = 0; guard < 10_000; guard += 1) {
    const next = computeNextAt(schedule, t);
    if (next == null || next > toMs) break;
    n += 1;
    t = next;
  }
  return n;
}

// ---------- 调度器 ----------

interface ReminderRow {
  id: string;
  conversation_id: string;
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
  paused_reason: string | null;
  budget_json: string | null;
  max_triggers: number | null;
  bound_stop_generation: number;
  auto_dispatch: number;
  last_fired_at: number | null;
  created_at: number | null;
}

export type ReminderAuthorityRow = Pick<ReminderRow, 'conversation_id' | 'thread_id' | 'task_id' | 'owner_member_id' | 'bound_stop_generation'>;

/** 触发时重查授权面（模块级——调度器与 reminder.confirm 共用同一判定）：会话归档/线程关闭/
 * 任务**新**停止（按绑定快照核对——历史 stop_generation 不永久禁止）/任务终态/owner 停用·
 * 移出·不在房间跟进范围/绑定任务冻结名单不含 owner/DM 非对端。 */
export function recheckReminderAuthority(db: ZhongshuoDatabase, reminder: ReminderAuthorityRow): { ok: true } | { ok: false; reason: string } {
  const conv = db.prepare('SELECT project_id, kind, room_id, archived_at FROM conversations WHERE id = ?').get(reminder.conversation_id) as
    | { project_id: string; kind: string; room_id: string | null; archived_at: number | null } | undefined;
  if (conv == null) return { ok: false, reason: 'conversation-missing' };
  if (conv.archived_at != null) return { ok: false, reason: 'conversation-archived' };
  if (reminder.thread_id != null) {
    const thread = db.prepare("SELECT status FROM conversation_threads WHERE id = ?").get(reminder.thread_id) as { status: string } | undefined;
    if (thread == null) return { ok: false, reason: 'thread-missing' };
    if (thread.status !== 'open') return { ok: false, reason: 'thread-closed' };
  }
  if (reminder.task_id != null) {
    const task = db.prepare('SELECT status, stop_generation, conversation_id FROM tasks WHERE id = ?').get(reminder.task_id) as { status: string; stop_generation: number; conversation_id: string } | undefined;
    if (task == null) return { ok: false, reason: 'task-missing' };
    if (['DONE', 'CANCELLED'].includes(task.status)) return { ok: false, reason: 'task-terminal' };
    // 停止代次按**保存的绑定事实**核对（第二十五轮三）：绑定后发生新停止才判停——
    // bound=绑定时快照；历史停止（bound 时已存在）不永久禁止新合法提醒。
    if (task.stop_generation > reminder.bound_stop_generation) return { ok: false, reason: 'task-stopped' };
    if (task.conversation_id !== reminder.conversation_id) return { ok: false, reason: 'task-scope-mismatch' };
    // 绑定任务的冻结参与者须含 owner（跟进范围——「成员启用且属于项目」不能代替）。
    const routeRow = db.prepare('SELECT route_json FROM tasks WHERE id = ?').get(reminder.task_id) as { route_json: string | null } | undefined;
    if (routeRow?.route_json != null) {
      try {
        const route = JSON.parse(routeRow.route_json) as { frozenMemberIds?: string[] };
        if (Array.isArray(route.frozenMemberIds) && route.frozenMemberIds.length > 0 && !route.frozenMemberIds.includes(reminder.owner_member_id)) {
          return { ok: false, reason: 'owner-not-in-frozen-scope' };
        }
      } catch { /* route 损坏不据此放行或拒绝——交由任务终态/停止事实判定 */ }
    }
  }
  const member = db.prepare('SELECT enabled, project_id FROM project_members WHERE id = ?').get(reminder.owner_member_id) as
    | { enabled: number; project_id: string } | undefined;
  if (member == null || member.enabled !== 1) return { ok: false, reason: 'owner-removed' };
  if (member.project_id !== conv.project_id) return { ok: false, reason: 'owner-not-in-project' };
  if (conv.kind === 'dm') {
    const peer = db.prepare("SELECT 1 AS ok FROM dm_participants WHERE conversation_id = ? AND principal_type = 'agent' AND principal_id = ?").get(reminder.conversation_id, reminder.owner_member_id);
    if (peer == null) return { ok: false, reason: 'owner-not-peer' };
  } else if (conv.room_id != null) {
    // 房间跟进范围（第二十五轮三）：owner 必须仍是目标房间成员。
    const inRoom = db.prepare('SELECT 1 AS ok FROM room_members WHERE room_id = ? AND member_id = ?').get(conv.room_id, reminder.owner_member_id);
    if (inRoom == null) return { ok: false, reason: 'owner-not-in-room' };
  }
  return { ok: true };
}

export type ReminderBudgetRow = Pick<ReminderRow, 'id' | 'budget_json'>;

/** 预算（fail-closed；模块级——调度器与 reminder.confirm 共用）：口径=**模型调用数**
 * （reminder_calls 台账非 released 行——修复/追加/重派全覆盖；触发上限另列 max_triggers）。
 * 损坏 budget_json 一律拒绝。 */
export function checkReminderBudget(db: ZhongshuoDatabase, reminder: ReminderBudgetRow): { ok: true } | { ok: false; reason: 'budget_exceeded' | 'budget_corrupt' } {
  const limit = budgetLimitOf(reminder.budget_json);
  if (limit === 'corrupt') return { ok: false, reason: 'budget_corrupt' };
  if (limit === null) return { ok: true };
  return reminderCallUsage(db, reminder.id) >= limit.sum ? { ok: false, reason: 'budget_exceeded' } : { ok: true };
}

export interface ReminderSchedulerOptions {
  db: ZhongshuoDatabase;
  /** 时钟注入（测试假时钟；生产=Date.now）。 */
  now?: () => number;
  /** 正式派发执行体（默认=reminderDispatch.dispatchReminderExecution；测试可注入故障/断言，但
   * 断言以 DB 事实为准——不能只断言回调被调用）。 */
  execDispatch?: (input: { reminder: ReminderRow; scheduledAt: number; missedCount: number; dispatchedCount: number; now: number }) => { taskId: string };
}

export interface TickOutcome {
  fired: Array<{ reminderId: string; scheduledAt: number; outcome: string; missedCount: number; taskId: string | null }>;
  suppressed: Array<{ reminderId: string; scheduledAt: number; reason: string }>;
  paused: Array<{ reminderId: string; reason: string }>;
  /** 并发写入者胜出（SQLITE_BUSY 让出）次数——下次 tick 重扫，不丢。 */
  busySkipped: number;
  closed: boolean;
}

export class ReminderScheduler {
  private readonly db: ZhongshuoDatabase;
  private readonly now: () => number;
  private readonly execDispatch: NonNullable<ReminderSchedulerOptions['execDispatch']>;
  private closed = false;

  constructor(options: ReminderSchedulerOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.execDispatch = options.execDispatch ?? ((input) => dispatchReminderExecution(this.db, input));
    this.sweepLegacyPending();
  }

  /** 停止入口（daemon.stop 第一步调用）：之后的 tick 全部早退——不再扫描/派发。 */
  close(): void { this.closed = true; }

  /** 首包遗留 pending occurrence 收案：其派发至多插入过幂等 id 的唤醒消息、从未建立正式执行；
   * 如实标记 merged（不重发、不冒充已执行）。 */
  private sweepLegacyPending(): void {
    try {
      this.db.prepare("UPDATE reminder_occurrences SET status = 'merged', outcome = COALESCE(outcome, '') || CASE WHEN outcome IS NULL OR outcome = '' THEN '' ELSE ';' END || 'legacy-pending-recovered' WHERE status = 'pending'").run();
    } catch { /* 首次 tick 前表结构异常时静默——migrations 保证列存在 */ }
  }

  /** 单次扫描。每个 due 提醒一个独立事务（CAS+occurrence+派发意图原子）；并发写者
   * SQLITE_BUSY 让出（busySkipped 计数，下次 tick 重扫——不丢触发）。 */
  tick(): TickOutcome {
    const outcome: TickOutcome = { fired: [], suppressed: [], paused: [], busySkipped: 0, closed: this.closed };
    if (this.closed) return outcome;
    const now = this.now();
    const due = this.db.prepare("SELECT * FROM reminders WHERE status = 'active' AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at").all(now) as unknown as ReminderRow[];
    for (const snapshot of due) {
      try {
        this.processOne(snapshot, now, outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('database is locked') || message.includes('SQLITE_BUSY')) { outcome.busySkipped += 1; continue; }
        throw error;
      }
    }
    return outcome;
  }

  private processOne(snapshot: ReminderRow, now: number, outcome: TickOutcome): void {
    const dueAt = snapshot.next_at;
    if (dueAt == null) return;
    type StepResult =
      | { kind: 'lost-race' }
      | { kind: 'paused'; reason: string }
      | { kind: 'already'; scheduledAt: number }
      | { kind: 'awaiting'; scheduledAt: number; missedCount: number; messageId: string }
      | { kind: 'dispatched'; scheduledAt: number; missedCount: number; taskId: string };
    const tx = this.db.transaction((): StepResult => {
      // 事务内重读新鲜行（并发写者已处理→此处 miss→让出）。
      const reminder = this.db.prepare('SELECT * FROM reminders WHERE id = ? AND status = \'active\' AND next_at = ?').get(snapshot.id, dueAt) as ReminderRow | undefined;
      if (reminder == null) return { kind: 'lost-race' };
      const schedule = parseSchedule(reminder.schedule_json);
      if (schedule == null || !validateSchedule(schedule).ok) {
        this.db.prepare("UPDATE reminders SET status = 'paused', paused_reason = 'schedule_corrupt', updated_at = ? WHERE id = ? AND status = 'active'").run(now, reminder.id);
        this.db.prepare('INSERT OR IGNORE INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome, missed_count, fired_at) VALUES (?, ?, ?, ?, 0, ?)')
          .run(reminder.id, dueAt, 'fired', 'schedule_corrupt', now);
        return { kind: 'paused', reason: 'schedule_corrupt' };
      }
      // 休眠错过推导（合同：合并为一个触发，不逐次补跑）：本批=上次处理点以来的计划数。
      const lastMark = reminder.last_fired_at ?? reminder.created_at ?? dueAt;
      const missedCount = Math.max(0, countScheduledBetween(schedule, lastMark, now) - 1);
      // 触发时重查授权面（合同）：会话归档/线程关闭/任务停止代次/owner 移出·停用·非对端。
      const recheck = recheckReminderAuthority(this.db, reminder);
      if (!recheck.ok) {
        this.db.prepare("UPDATE reminders SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(recheck.reason, now, reminder.id);
        this.db.prepare('INSERT OR IGNORE INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome, missed_count, fired_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(reminder.id, dueAt, 'fired', `paused:${recheck.reason}`, missedCount, now);
        return { kind: 'paused', reason: recheck.reason };
      }
      // 预算（fail-closed）：损坏=拒绝派发+暂停取证；超限=拒绝派发+暂停（口径=模型调用台账）。
      const budget = checkReminderBudget(this.db, reminder);
      if (!budget.ok) {
        this.db.prepare("UPDATE reminders SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(budget.reason, now, reminder.id);
        this.db.prepare('INSERT OR IGNORE INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome, missed_count, fired_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(reminder.id, dueAt, 'fired', budget.reason, missedCount, now);
        return { kind: 'paused', reason: budget.reason };
      }
      // 触发次数上限（第二十五轮一：与模型调用预算分列——occurrence 口径）。
      if (reminder.max_triggers != null) {
        const fired = (this.db.prepare("SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ? AND status = 'fired'").get(reminder.id) as { c: number }).c;
        if (fired >= reminder.max_triggers) {
          this.db.prepare("UPDATE reminders SET status = 'paused', paused_reason = 'trigger_limit', updated_at = ? WHERE id = ? AND status = 'active'").run(now, reminder.id);
          this.db.prepare('INSERT OR IGNORE INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome, missed_count, fired_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(reminder.id, dueAt, 'fired', 'trigger_limit', missedCount, now);
          return { kind: 'paused', reason: 'trigger_limit' };
        }
      }
      // 历史 occurrence 已覆盖该时刻（首包遗留/极端恢复路径）：只推进计划，不重发。
      const existing = this.db.prepare('SELECT status FROM reminder_occurrences WHERE reminder_id = ? AND scheduled_at = ?').get(reminder.id, dueAt) as { status: string } | undefined;
      if (existing != null) {
        const nextNext = computeNextAt(schedule, now);
        this.db.prepare("UPDATE reminders SET next_at = ?, status = ?, last_fired_at = ?, updated_at = ? WHERE id = ? AND next_at = ? AND status = 'active'")
          .run(nextNext, nextNext == null ? 'done' : 'active', dueAt, now, reminder.id, dueAt);
        return { kind: 'already', scheduledAt: dueAt };
      }
      // CAS 领取+计划推进+last_fired_at（> now——积压批剩余成员并入下次合并）。
      const nextNext = computeNextAt(schedule, now);
      const claimed = this.db.prepare("UPDATE reminders SET next_at = ?, status = ?, last_fired_at = ?, updated_at = ? WHERE id = ? AND next_at = ? AND status = 'active'")
        .run(nextNext, nextNext == null ? 'done' : 'active', dueAt, now, reminder.id, dueAt).changes;
      if (claimed !== 1) return { kind: 'lost-race' };
      // 派发意图（同事务）：获准=正式执行（任务+outbox+调用预占）；未获准=唤醒消息（system）+待确认。
      const callUsage = reminderCallUsage(this.db, reminder.id);
      if (reminder.auto_dispatch === 1) {
        const d = this.execDispatch({ reminder, scheduledAt: dueAt, missedCount, dispatchedCount: callUsage, now });
        this.db.prepare('INSERT INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome, missed_count, fired_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(reminder.id, dueAt, 'fired', 'dispatched', missedCount, now, d.taskId);
        return { kind: 'dispatched', scheduledAt: dueAt, missedCount, taskId: d.taskId };
      }
      const wake = insertReminderWakeMessage(this.db, { reminder, scheduledAt: dueAt, missedCount, dispatchedCount: callUsage, now });
      this.db.prepare('INSERT INTO reminder_occurrences (reminder_id, scheduled_at, status, outcome, missed_count, fired_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(reminder.id, dueAt, 'fired', 'awaiting_confirmation', missedCount, now);
      return { kind: 'awaiting', scheduledAt: dueAt, missedCount, messageId: wake.messageId };
    });
    const r = tx();
    switch (r.kind) {
      case 'paused':
        outcome.paused.push({ reminderId: snapshot.id, reason: r.reason });
        outcome.suppressed.push({ reminderId: snapshot.id, scheduledAt: dueAt, reason: r.reason });
        break;
      case 'awaiting':
        outcome.fired.push({ reminderId: snapshot.id, scheduledAt: r.scheduledAt, outcome: 'awaiting_confirmation', missedCount: r.missedCount, taskId: null });
        break;
      case 'dispatched':
        outcome.fired.push({ reminderId: snapshot.id, scheduledAt: r.scheduledAt, outcome: 'dispatched', missedCount: r.missedCount, taskId: r.taskId });
        break;
      default:
        break; // lost-race/already：并发让出或历史已覆盖——无重复动作
    }
  }
}

