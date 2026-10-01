/**
 * 提醒正式派发（第二十四轮四——REM-8）：
 * - 执行走**既有正式链**：DM 会话→createDmTurn（dm_turn 任务+outbox `dmtask:` 键）；房间会话→
 *   createRoomRootTask（room_task 任务+outbox `task:` 键）。worker 既有恢复合同承接执行
 *   （drain 领取/UNKNOWN/applyRecovery）——调度器不自建第二套执行。
 * - **不伪装人类发言**：唤醒消息与任务输入 author_type='system'，authorId=`reminder:{id}`。
 * - 只派发 owner（route=DIRECT 单成员——其他成员零调用 AT-07 语义）。
 * - 输入体由 DEV-21-M3 模板渲染（reminderTemplate.ts——消息与输入同源）。
 * 本模块被调度器（获准自动派发）与 reminder.confirm（用户确认入口）共用；调用方负责
 * 事务边界与预算/授权判定（本模块只做创建，不做判断）。
 */
import { randomUUID } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { createDmTurn } from '../persistence/stores/dm.ts';
import { createRoomRootTask } from '../persistence/stores/roomRootTask.ts';
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

/** 正式执行派发（必须处于调用方事务内）：返回创建的任务 id（DM=dm_turn；房间=room_task）。
 * 派发失败抛错→调用方整个事务回滚（不冒充成功；下次 tick / 下次确认重试）。 */
export function dispatchReminderExecution(db: ZhongshuoDatabase, input: ReminderDispatchInput): { taskId: string; messageId: string; conversationKind: 'dm' | 'room' } {
  const conv = db.prepare('SELECT project_id, kind, room_id FROM conversations WHERE id = ?').get(input.reminder.conversation_id) as
    | { project_id: string; kind: string; room_id: string | null }
    | undefined;
  if (conv == null) throw new Error(`dispatch-failed:conversation-missing(${input.reminder.conversation_id})`);
  const body = renderReminderWakeInput(wakeContextOf(input));
  const author = { authorType: 'system' as const, authorId: `reminder:${input.reminder.id}` };
  if (conv.kind === 'dm') {
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
    return { taskId: r.taskId, messageId: r.messageId, conversationKind: 'dm' };
  }
  if (conv.kind !== 'room' || conv.room_id == null) throw new Error(`dispatch-failed:conversation-kind(${conv.kind})`);
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
    sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: input.reminder.owner_member_id, frozenMemberIds: [input.reminder.owner_member_id], initialWakeMemberIds: [input.reminder.owner_member_id] },
    now: input.now,
  });
  if (!created.ok || created.value.taskId == null) throw new Error(`dispatch-failed:room-task(${created.ok ? 'no-task' : created.error.code})`);
  return { taskId: created.value.taskId, messageId: created.value.messageId, conversationKind: 'room' };
}

/** 预算口径（REM-7）：作用域=本提醒的已派发 occurrence 数（每次派发恰一个任务=恰一次
 * startTurn 计数；occurrence 与派发同事务落库=预占原子）。损坏 budget_json 由调用方 fail-closed。 */
export function dispatchedCountOf(db: ZhongshuoDatabase, reminderId: string): number {
  return (db.prepare("SELECT count(*) c FROM reminder_occurrences WHERE reminder_id = ? AND outcome = 'dispatched'").get(reminderId) as { c: number }).c;
}

/** 计划解析防御（损坏 schedule_json 的如实处理由调用方决定）。 */
export function parseSchedule(json: string): ReminderSchedule | null {
  try {
    const s = JSON.parse(json) as ReminderSchedule;
    if (s == null || typeof s !== 'object' || typeof s.kind !== 'string') return null;
    return s;
  } catch { return null; }
}
