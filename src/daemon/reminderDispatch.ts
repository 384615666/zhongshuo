/**
 * 提醒正式派发与**调用台账**（第二十四轮四+第二十五轮一/三）：
 * - 执行走既有正式链：DM→createDmTurn（dm_turn+outbox `dmtask:`）；房间新根→createRoomRootTask
 *   （`task:`）；**绑定 threadId/taskId 的房间提醒=跟进既有任务**（线程跟进消息+`task:{id}:reminder:
 *   {occurrence}` 派发键——不把原串跟进默默变成另一个无来源根任务）；结果回到准确目标。
 * - **不伪装人类发言**：消息/输入 author_type='system'，authorId=`reminder:{id}`。
 * - **调用台账（reminder_calls）**：预算=模型调用次数（非任务数、非 occurrence 数——修复/
 *   追加/重派都产生 turn）。派发/确认创建时**持久预占**（reserved）；worker 建 turn 时挂钩
 *   （acquireReminderTurnSlot——统一检查+入账，不能通过新 run 绕开）；终态保守记账
 *   （settled/failed/unknown 均计数，重启不清零）；仅 turn 前取消/成员停用等未花调用走
 *   released。触发次数上限（max_triggers）与此分列。
 */
import { randomUUID } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { createDmTurn } from '../persistence/stores/dm.ts';
import { createRoomRootTask } from '../persistence/stores/roomRootTask.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import { renderReminderWakeInput, renderReminderWakeMessage, type ReminderWakeContext } from './reminderTemplate.ts';
import type { ReminderSchedule } from './reminderScheduler.ts';

export interface ReminderDispatchInput {
  reminder: {
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
    budget_json: string | null;
    auto_dispatch: number;
  };
  scheduledAt: number;
  missedCount: number;
  dispatchedCount: number;
  now: number;
}

function reviewPolicyOf(db: ZhongshuoDatabase, projectId: string): 'auto_deliver' | 'user_review' {
  const row = db.prepare('SELECT task_review_enabled FROM projects WHERE id = ?').get(projectId) as { task_review_enabled: number } | undefined;
  return row?.task_review_enabled === 1 ? 'user_review' : 'auto_deliver';
}

function wakeContextOf(input: ReminderDispatchInput): ReminderWakeContext {
  let budget: { sum: number } | null = null;
  if (input.reminder.budget_json != null) budget = JSON.parse(input.reminder.budget_json) as { sum: number };
  return {
    reminderId: input.reminder.id,
    title: input.reminder.title ?? input.reminder.id,
    scheduledAt: input.scheduledAt,
    timezone: input.reminder.timezone,
    missedCount: input.missedCount,
    sourceRef: input.reminder.source_ref,
    budget,
    autoDispatch: input.reminder.auto_dispatch === 1,
    dispatchedCount: input.dispatchedCount,
  };
}

/** 唤醒消息（通知面——author_type='system'；确定性 id 幂等：同 occurrence 重放不重复插入）。 */
export function insertReminderWakeMessage(db: ZhongshuoDatabase, input: ReminderDispatchInput): { messageId: string; existed: boolean } {
  const messageId = `msg_rem_${input.reminder.id}_${input.scheduledAt}`;
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(messageId) as { id: string } | undefined;
  if (existing != null) return { messageId, existed: true };
  const conv = db.prepare('SELECT project_id FROM conversations WHERE id = ?').get(input.reminder.conversation_id) as { project_id: string } | undefined;
  if (conv == null) throw new Error(`dispatch-failed:conversation-missing(${input.reminder.conversation_id})`);
  const seq = (db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq').get(input.reminder.conversation_id) as { last_message_seq: number } | undefined)?.last_message_seq ?? 1;
  db.prepare(
    `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id, thread_message_seq, author_type, author_id, body_json, status, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'system', ?, ?, 'final', ?)`,
  ).run(messageId, conv.project_id, input.reminder.conversation_id, seq, `reminder:${input.reminder.id}`, JSON.stringify({ text: renderReminderWakeMessage(wakeContextOf(input)) }), input.now);
  return { messageId, existed: false };
}

/** 派发占用一格调用额度（持久预占——与派发创建同事务；tag 唯一锚=occurrence/派发键）。 */
export function reserveReminderCall(db: ZhongshuoDatabase, input: { reminderId: string; taskId: string; tag: string; now: number }): void {
  db.prepare('INSERT INTO reminder_calls (reminder_id, task_id, dispatch_tag, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.reminderId, input.taskId, input.tag, 'reserved', input.now, input.now);
}

/** 调用额度占用数（保守口径：released 之外全部计入——含在途/未知/失败；重启不清零）。 */
export function reminderCallUsage(db: ZhongshuoDatabase, reminderId: string): number {
  return (db.prepare("SELECT count(*) c FROM reminder_calls WHERE reminder_id = ? AND status != 'released'").get(reminderId) as { c: number }).c;
}

/** 任务→提醒归属（occurrence.task_id 锚——派发与确认创建的任务都登记）。 */
export function reminderLinkageForTask(db: ZhongshuoDatabase, taskId: string): string | null {
  return (db.prepare('SELECT reminder_id FROM reminder_occurrences WHERE task_id = ? LIMIT 1').get(taskId) as { reminder_id: string } | undefined)?.reminder_id ?? null;
}

/** worker 建 turn 前统一领取调用格（在 createRun 同事务调用）：
 * - 已有本任务的未挂钩预占（派发/确认时落）→ 挂钩本 turn（不重复计数）；
 * - 无预占（修复/追加/重派等新增 turn）→ 检查额度，允许则入账 inflight，拒绝则 fail。
 * 崩溃安全：与 run/turn 创建同事务（要么都落要么都不落）。 */
export function acquireReminderTurnSlot(db: ZhongshuoDatabase, taskId: string, turnId: string, dispatchKey: string): { ok: true } | { ok: false; reason: 'budget_exceeded' | 'budget_corrupt'; reminderId: string } {
  const reminderId = reminderLinkageForTask(db, taskId);
  if (reminderId == null) return { ok: true }; // 非提醒派生任务——产品预算链自理
  const budgetRow = db.prepare('SELECT budget_json FROM reminders WHERE id = ?').get(reminderId) as { budget_json: string | null } | undefined;
  if (budgetRow == null) return { ok: true };
  if (budgetRow.budget_json == null) return { ok: true };
  let parsed: unknown;
  try { parsed = JSON.parse(budgetRow.budget_json); } catch { return { ok: false, reason: 'budget_corrupt', reminderId }; }
  const limit = parsed as { sum?: unknown };
  if (limit == null || typeof limit !== 'object' || !Number.isInteger(limit.sum) || (limit.sum as number) < 0) return { ok: false, reason: 'budget_corrupt', reminderId };
  const pending = db.prepare("SELECT id FROM reminder_calls WHERE reminder_id = ? AND task_id = ? AND turn_id IS NULL AND status = 'reserved' LIMIT 1").get(reminderId, taskId) as { id: number } | undefined;
  const now = Date.now();
  if (pending != null) {
    db.prepare('UPDATE reminder_calls SET turn_id = ?, status = ?, updated_at = ? WHERE id = ?').run(turnId, 'inflight', now, pending.id);
    return { ok: true };
  }
  if (reminderCallUsage(db, reminderId) >= (limit.sum as number)) return { ok: false, reason: 'budget_exceeded', reminderId };
  db.prepare('INSERT INTO reminder_calls (reminder_id, task_id, turn_id, dispatch_tag, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(reminderId, taskId, turnId, dispatchKey, 'inflight', now, now);
  return { ok: true };
}

/** turn 前取消/成员停用等未花调用的预占归还（保守方向：只有确定未花才 released）。 */
export function releaseUnlinkedReminderReservations(db: ZhongshuoDatabase, taskId: string): void {
  db.prepare("UPDATE reminder_calls SET status = 'released', updated_at = ? WHERE task_id = ? AND turn_id IS NULL AND status = 'reserved'").run(Date.now(), taskId);
}

/** turn 终态跟随（casTurn 统一收口点调用——尽力而为，不影响业务事务）。 */
export function settleReminderCallForTurn(db: ZhongshuoDatabase, turnId: string, turnStatus: string): void {
  const mapped = turnStatus === 'SUCCEEDED' ? 'settled' : turnStatus === 'FAILED' ? 'failed' : 'unknown'; // CANCELLED/UNKNOWN=unknown（保守计数——无法证明未花）
  db.prepare("UPDATE reminder_calls SET status = ?, updated_at = ? WHERE turn_id = ? AND status = 'inflight'").run(mapped, Date.now(), turnId);
}

/** 正式执行派发（必须处于调用方事务内）：返回创建/跟进的任务 id。派发失败抛错→整体回滚。 */
export function dispatchReminderExecution(db: ZhongshuoDatabase, input: ReminderDispatchInput): { taskId: string; messageId: string; conversationKind: 'dm' | 'room'; followUp: boolean } {
  const conv = db.prepare('SELECT project_id, kind, room_id FROM conversations WHERE id = ?').get(input.reminder.conversation_id) as
    | { project_id: string; kind: string; room_id: string | null }
    | undefined;
  if (conv == null) throw new Error(`dispatch-failed:conversation-missing(${input.reminder.conversation_id})`);
  const body = renderReminderWakeInput(wakeContextOf(input));
  const author = { authorType: 'system' as const, authorId: `reminder:${input.reminder.id}` };
  if (conv.kind === 'dm') {
    // DM：结果回到会话（每触发一轮 dm_turn——会话即准确目标）。
    const r = createDmTurn(db, {
      conversationId: input.reminder.conversation_id,
      projectId: conv.project_id,
      peerMemberId: input.reminder.owner_member_id, // DM 只能唤醒对端（schedule 校验保证 owner=对端）
      localUserId: input.reminder.owner_user ?? 'u_local',
      body,
      intent: 'default',
      reviewPolicy: reviewPolicyOf(db, conv.project_id),
      author,
    });
    if (r.taskId == null) throw new Error(`dispatch-failed:dm-task-not-created(${r.note ?? 'unknown'})`);
    if (input.reminder.budget_json != null) reserveReminderCall(db, { reminderId: input.reminder.id, taskId: r.taskId, tag: `occ:${input.scheduledAt}`, now: input.now });
    return { taskId: r.taskId, messageId: r.messageId, conversationKind: 'dm', followUp: false };
  }
  if (conv.kind !== 'room' || conv.room_id == null) throw new Error(`dispatch-failed:conversation-kind(${conv.kind})`);
  // 房间：绑定 threadId/taskId → **跟进既有任务**（不建新根任务——保留可信来源与原串上下文）。
  const boundTaskId = input.reminder.task_id
    ?? (input.reminder.thread_id != null
      ? (db.prepare('SELECT root_task_id FROM conversation_threads WHERE id = ?').get(input.reminder.thread_id) as { root_task_id: string | null } | undefined)?.root_task_id ?? null
      : null);
  if (boundTaskId != null) {
    const task = db.prepare('SELECT id, conversation_id, conversation_thread_id, status FROM tasks WHERE id = ?').get(boundTaskId) as
      | { id: string; conversation_id: string; conversation_thread_id: string | null; status: string } | undefined;
    if (task == null || task.conversation_id !== input.reminder.conversation_id) throw new Error(`dispatch-failed:bound-task-scope(${boundTaskId})`);
    if (['DONE', 'CANCELLED'].includes(task.status)) throw new Error(`dispatch-failed:bound-task-terminal(${task.status})`);
    const threadId = task.conversation_thread_id ?? input.reminder.thread_id;
    if (threadId == null) throw new Error('dispatch-failed:bound-task-no-thread');
    // 线程跟进消息（system 来源+模板体；任务归属=目标根任务——进入下一轮输入）。
    const threadRow = db.prepare('SELECT last_message_seq FROM conversation_threads WHERE id = ?').get(threadId) as { last_message_seq: number } | undefined;
    if (threadRow == null) throw new Error(`dispatch-failed:thread-missing(${threadId})`);
    const seq = (db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq').get(input.reminder.conversation_id) as { last_message_seq: number }).last_message_seq;
    const messageId = `msg_rem_${input.reminder.id}_${input.scheduledAt}`;
    db.prepare(
      `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id, thread_message_seq, author_type, author_id, body_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', ?, ?, 'saved', ?)`,
    ).run(messageId, conv.project_id, input.reminder.conversation_id, seq, conv.room_id, threadId, task.id, threadRow.last_message_seq + 1, `reminder:${input.reminder.id}`, JSON.stringify({ text: body }), input.now);
    db.prepare('UPDATE conversation_threads SET last_message_seq = ?, revision = revision + 1 WHERE id = ?').run(threadRow.last_message_seq + 1, threadId);
    appendDomainEvent(db, {
      schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: conv.project_id,
      conversationId: input.reminder.conversation_id, threadId, taskId: task.id,
      kind: 'thread.replyAdded', createdAt: input.now, payload: { messageId, reminderFollowUp: input.reminder.id },
    });
    // 跟进派发键（occurrence 维度唯一——与手工 redispatch 键不撞）。
    db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(`task:${task.id}:reminder:${input.scheduledAt}`);
    if (input.reminder.budget_json != null) reserveReminderCall(db, { reminderId: input.reminder.id, taskId: task.id, tag: `occ:${input.scheduledAt}`, now: input.now });
    return { taskId: task.id, messageId, conversationKind: 'room', followUp: true };
  }
  const ids = { messageId: `msg_${randomUUID()}`, threadId: `thread_${randomUUID()}`, taskId: `task_${randomUUID()}`, taskEventId: `evt_${randomUUID()}`, threadEventId: `evt_${randomUUID()}` };
  const created = createRoomRootTask(db, {
    ids,
    projectId: conv.project_id,
    conversationId: input.reminder.conversation_id,
    roomId: conv.room_id,
    intent: 'default',
    title: `【提醒】${input.reminder.title ?? input.reminder.id}`.slice(0, 60),
    body,
    mentions: [],
    author,
    reviewPolicy: reviewPolicyOf(db, conv.project_id),
    sourceConnectionId: null, // 本机提醒=本机来源（如实 null——非外部连接）
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: input.reminder.owner_member_id, frozenMemberIds: [input.reminder.owner_member_id], initialWakeMemberIds: [input.reminder.owner_member_id] },
    now: input.now,
  });
  if (!created.ok || created.value.taskId == null) throw new Error(`dispatch-failed:room-task(${created.ok ? 'no-task' : created.error.code})`);
  if (input.reminder.budget_json != null) reserveReminderCall(db, { reminderId: input.reminder.id, taskId: created.value.taskId, tag: `occ:${input.scheduledAt}`, now: input.now });
  return { taskId: created.value.taskId, messageId: created.value.messageId, conversationKind: 'room', followUp: false };
}

/** 预算口径（第二十五轮一）：**模型调用数**=台账非 released 行（触发上限另列 max_triggers）。
 * 损坏 budget_json 由调用方 fail-closed。 */
export function budgetLimitOf(budgetJson: string | null): { sum: number } | null | 'corrupt' {
  if (budgetJson == null) return null;
  try {
    const parsed = JSON.parse(budgetJson) as { sum?: unknown };
    if (parsed == null || typeof parsed !== 'object' || !Number.isInteger(parsed.sum) || (parsed.sum as number) < 0) return 'corrupt';
    return { sum: parsed.sum as number };
  } catch { return 'corrupt'; }
}

/** 计划解析防御（损坏 schedule_json 的如实处理由调用方决定）。 */
export function parseSchedule(json: string): ReminderSchedule | null {
  try {
    const s = JSON.parse(json) as ReminderSchedule;
    if (s == null || typeof s !== 'object' || typeof s.kind !== 'string') return null;
    return s;
  } catch { return null; }
}
