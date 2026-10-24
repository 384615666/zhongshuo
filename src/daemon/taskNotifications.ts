import { createHash } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { pendingAutomaticRecovery } from './automaticRecovery.ts';
import {
  taskNotificationAckParamsSchema,
  taskNotificationClaimParamsSchema,
  taskNotificationDeliverySchema,
  taskNotificationPollParamsSchema,
  type TaskNotificationAckResult,
  type TaskNotificationAttemptView,
  type TaskNotificationClaimResult,
  type TaskNotificationDelivery,
  type TaskNotificationKind,
  type TaskNotificationLocator,
  type TaskNotificationPollResult,
} from '../contracts/taskNotifications.ts';

const INGEST_BATCH = 500;
const CLAIM_LEASE_MS = 90_000;

export class TaskNotificationError extends Error {
  readonly code: 'TASK_NOTIFICATION_NOT_FOUND' | 'TASK_NOTIFICATION_NOT_PENDING' | 'TASK_NOTIFICATION_CORRUPT';

  constructor(
    code: TaskNotificationError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'TaskNotificationError';
    this.code = code;
  }
}

interface EventRow {
  seq: number;
  event_id: string;
  project_id: string;
  conversation_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  run_id: string | null;
  turn_id: string | null;
  kind: string;
  payload_json: string;
  created_at: number;
}

interface TaskContextRow {
  id: string;
  title: string;
  revision: number;
  status: string;
  room_id: string | null;
  conversation_thread_id: string | null;
  parent_task_id: string | null;
  conversation_kind: 'room' | 'dm';
  conversation_room_id: string | null;
  archived_at: number | null;
}

interface NotificationRow {
  notification_id: string;
  kind: TaskNotificationKind;
  title: string;
  body: string;
  created_at: number;
  project_id: string;
  conversation_id: string;
  room_id: string | null;
  thread_id: string | null;
  task_id: string;
  locator_hash: string;
  delivery_state: 'pending' | 'claimed' | 'show_requested' | 'shown' | 'failed' | 'unknown' | 'suppressed';
  claimed_at: number | null;
}

interface AttemptRow {
  notification_id: string;
  title: string;
  delivery_state: NotificationRow['delivery_state'];
  claim_requested_at: number;
  show_requested_at: number | null;
  shown_at: number | null;
  failed_at: number | null;
  failure_reason: string | null;
  clicked_at: number | null;
  closed_at: number | null;
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function payloadObject(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return value != null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function statusNotification(status: string): {
  kind: TaskNotificationKind;
  title: string;
  body: (taskTitle: string, reason: string) => string;
} | null {
  if (status === 'DONE') {
    return {
      kind: 'task.completed',
      title: '众说 · 任务完成',
      body: (taskTitle) => `「${taskTitle}」已完成。`,
    };
  }
  if (status === 'BLOCKED' || status === 'FAILED') {
    return {
      kind: 'task.needs_attention',
      title: '众说 · 任务需要处理',
      body: (taskTitle, reason) => `「${taskTitle}」需要处理${reason.length > 0 ? `：${reason}` : '。'}`,
    };
  }
  if (status === 'WAITING_USER') {
    return {
      kind: 'task.needs_input',
      title: '众说 · 需要你的输入',
      body: (taskTitle) => `「${taskTitle}」正在等待你的补充或决定。`,
    };
  }
  if (status === 'REVIEW') {
    return {
      kind: 'task.needs_review',
      title: '众说 · 交付待验收',
      body: (taskTitle) => `「${taskTitle}」已有交付，等待你验收。`,
    };
  }
  return null;
}

function notificationIdFor(viewerId: string, eventId: string, kind: TaskNotificationKind): string {
  return `ntf_${createHash('sha256').update(`${viewerId}\0${eventId}\0${kind}`).digest('hex').slice(0, 32)}`;
}

function threadMuted(db: ZhongshuoDatabase, viewerId: string, threadId: string | null): boolean {
  if (threadId == null) return false;
  return db.prepare(
    'SELECT 1 FROM thread_subscriptions WHERE thread_id = ? AND viewer_id = ? AND muted = 1',
  ).get(threadId, viewerId) != null;
}

function dmAudience(
  db: ZhongshuoDatabase,
  viewerId: string,
  projectId: string,
  conversationId: string,
): boolean {
  return db.prepare(
    `SELECT 1 FROM dm_participants
     WHERE project_id = ? AND conversation_id = ? AND principal_type = 'human' AND principal_id = ?`,
  ).get(projectId, conversationId, viewerId) != null;
}

interface FailureEventIdentity {
  runId: string;
  turnId: string | null;
}

function failureEventIdentity(
  db: ZhongshuoDatabase,
  event: EventRow,
): FailureEventIdentity | null {
  const payload = payloadObject(event.payload_json);
  const payloadStatus = cleanText(payload['status'], 40).toUpperCase();
  const isFailure = event.kind === 'turn.outputInvalid'
    || event.kind === 'turn.failed'
    || event.kind === 'run.failed'
    || (event.kind === 'turn.statusChanged' && payloadStatus === 'FAILED')
    || (event.kind === 'run.statusChanged' && payloadStatus === 'FAILED');
  if (!isFailure) return null;

  let runId = event.run_id;
  if (runId == null && event.turn_id != null) {
    runId = (db.prepare('SELECT run_id FROM agent_turns WHERE id = ?').get(event.turn_id) as {
      run_id: string;
    } | undefined)?.run_id ?? null;
  }
  if (runId == null) return null;

  const turnId = event.turn_id ?? (db.prepare(
    'SELECT id FROM agent_turns WHERE run_id = ? ORDER BY rowid DESC LIMIT 1',
  ).get(runId) as { id: string } | undefined)?.id ?? null;
  return { runId, turnId };
}

function failureNeedsAttention(
  db: ZhongshuoDatabase,
  task: TaskContextRow,
  failure: FailureEventIdentity,
): boolean {
  const latestRun = db.prepare(
    `SELECT id, status FROM workflow_runs
     WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`,
  ).get(task.id) as { id: string; status: string } | undefined;
  if (latestRun?.id !== failure.runId || latestRun.status !== 'FAILED') return false;

  if (failure.turnId != null && db.prepare(
    `SELECT 1 FROM agent_turns a
     JOIN workflow_runs r ON r.id = a.run_id
     WHERE a.id = ? AND a.run_id = ? AND r.task_id = ? LIMIT 1`,
  ).get(failure.turnId, failure.runId, task.id) == null) return false;

  // A durable automatic retry means the task is still progressing. The existing
  // recovery gate also owns UNKNOWN/protection-retained reconciliation.
  if (pendingAutomaticRecovery(db, task.id) != null) return false;
  if (db.prepare(
    `SELECT 1 FROM agent_turns a
     JOIN workflow_runs r ON r.id = a.run_id
     WHERE r.task_id = ? AND (
       (a.status = 'UNKNOWN' AND NOT EXISTS (
         SELECT 1 FROM domain_events e
         WHERE e.turn_id = a.id
           AND e.kind = 'recovery.protectionReleased'
           AND json_extract(e.payload_json, '$.released') = 1
       ))
       OR a.protection_state = 'retained'
     )
     LIMIT 1`,
  ).get(task.id) != null) return false;

  return task.status === 'ACTIVE';
}

function candidateForEvent(
  db: ZhongshuoDatabase,
  viewerId: string,
  event: EventRow,
): {
  notificationId: string;
  dedupeKey: string;
  kind: TaskNotificationKind;
  title: string;
  body: string;
  projectId: string;
  conversationId: string;
  roomId: string | null;
  threadId: string | null;
  taskId: string;
  locatorHash: string;
} | null {
  if (event.task_id == null || event.conversation_id == null) return null;
  const payload = payloadObject(event.payload_json);
  const status = cleanText(payload['status'], 40).toUpperCase();
  const statusFailure = event.kind === 'task.statusChanged' ? statusNotification(status) : null;
  const failure = failureEventIdentity(db, event);
  if (statusFailure == null && failure == null) return null;
  if (event.kind === 'task.statusChanged') {
    const previous = db.prepare(
      `SELECT CASE WHEN json_valid(payload_json)
                    THEN upper(COALESCE(json_extract(payload_json, '$.status'), ''))
                    ELSE '' END AS status
       FROM domain_events
       WHERE task_id = ? AND kind = 'task.statusChanged' AND seq < ?
       ORDER BY seq DESC LIMIT 1`,
    ).get(event.task_id, event.seq) as { status: string } | undefined;
    // Repeated audit rows for a sustained state are quiet. A transition away and
    // later back (for example DONE→ACTIVE→DONE after rework) is a new cycle.
    if (previous?.status === status) return null;
  }

  const task = db.prepare(
    `SELECT t.id, t.title, t.revision, t.status, t.room_id, t.conversation_thread_id, t.parent_task_id,
            c.kind AS conversation_kind, c.room_id AS conversation_room_id, c.archived_at
     FROM tasks t
     JOIN conversations c ON c.id = t.conversation_id AND c.project_id = t.project_id
     WHERE t.id = ? AND t.project_id = ? AND t.conversation_id = ?`,
  ).get(event.task_id, event.project_id, event.conversation_id) as TaskContextRow | undefined;
  if (task == null || task.parent_task_id != null || task.archived_at != null) return null;
  if (failure != null && !failureNeedsAttention(db, task, failure)) return null;

  const threadId = task.conversation_thread_id ?? event.thread_id;
  if (threadMuted(db, viewerId, threadId)) return null;

  let hash: string;
  if (task.conversation_kind === 'dm') {
    if (!dmAudience(db, viewerId, event.project_id, event.conversation_id)) return null;
    hash = `#dm=${event.conversation_id}`;
  } else {
    hash = `#task=${task.id}`;
  }

  const locator: TaskNotificationLocator = {
    projectId: event.project_id,
    conversationId: event.conversation_id,
    roomId: task.room_id ?? task.conversation_room_id,
    threadId,
    taskId: task.id,
    hash,
  };
  if (!taskNotificationDeliverySchema.shape.locator.safeParse(locator).success) return null;

  const title = cleanText(task.title, 80) || `任务 ${task.id.slice(0, 8)}`;
  const reason = cleanText(payload['reason'], 140)
    || cleanText(payload['message'], 140)
    || (Array.isArray(payload['issues']) ? cleanText(payload['issues'][0], 140) : '')
    || cleanText(payload['code'], 140);
  const mapped = statusFailure ?? statusNotification('BLOCKED');
  if (mapped == null) return null;
  return {
    notificationId: notificationIdFor(viewerId, event.event_id, mapped.kind),
    // Status transitions use the immutable transition audit. Execution failures
    // use the real run identity so multiple terminal evidence rows for one run
    // collapse, while a later rework run can notify independently.
    dedupeKey: failure == null
      ? `task:${task.id}:status:${status}:event:${event.seq}`
      : `task:${task.id}:failure:run:${failure.runId}`,
    kind: mapped.kind,
    title: mapped.title,
    body: mapped.body(title, reason),
    projectId: event.project_id,
    conversationId: event.conversation_id,
    roomId: locator.roomId,
    threadId: locator.threadId,
    taskId: task.id,
    locatorHash: hash,
  };
}

function ensureCursor(db: ZhongshuoDatabase, viewerId: string, now: number): number {
  const existing = db.prepare(
    'SELECT last_event_seq FROM task_notification_cursors WHERE viewer_id = ?',
  ).get(viewerId) as { last_event_seq: number } | undefined;
  if (existing != null) return existing.last_event_seq;

  const highWater = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM domain_events').get() as { seq: number }).seq;
  db.prepare(
    `INSERT INTO task_notification_cursors (viewer_id, last_event_seq, updated_at)
     VALUES (?, ?, ?)`,
  ).run(viewerId, highWater, now);
  return highWater;
}

function ingestDomainEvents(db: ZhongshuoDatabase, viewerId: string, now: number): number {
  const ingest = db.transaction((): number => {
    let cursor = ensureCursor(db, viewerId, now);
    const rows = db.prepare(
      `SELECT seq, event_id, project_id, conversation_id, thread_id, task_id, run_id, turn_id,
              kind, payload_json, created_at
       FROM domain_events WHERE seq > ? ORDER BY seq LIMIT ?`,
    ).all(cursor, INGEST_BATCH) as EventRow[];
    for (const event of rows) {
      const candidate = candidateForEvent(db, viewerId, event);
      if (candidate != null) {
        db.prepare(
          `INSERT OR IGNORE INTO task_notifications
             (notification_id, viewer_id, source_event_seq, source_event_id, dedupe_key, kind,
              project_id, conversation_id, room_id, thread_id, task_id, title, body, locator_hash,
              delivery_state, attempts, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
        ).run(
          candidate.notificationId, viewerId, event.seq, event.event_id, candidate.dedupeKey, candidate.kind,
          candidate.projectId, candidate.conversationId, candidate.roomId, candidate.threadId, candidate.taskId,
          candidate.title, candidate.body, candidate.locatorHash, event.created_at,
        );
      }
      cursor = event.seq;
    }
    db.prepare(
      'UPDATE task_notification_cursors SET last_event_seq = ?, updated_at = ? WHERE viewer_id = ?',
    ).run(cursor, now, viewerId);
    return cursor;
  });
  return ingest.immediate();
}

function suppressMuted(db: ZhongshuoDatabase, viewerId: string): void {
  db.prepare(
    `UPDATE task_notifications
     SET delivery_state = 'suppressed', claimed_at = NULL, last_error = '线程已静音'
     WHERE viewer_id = ? AND delivery_state = 'pending' AND thread_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM thread_subscriptions s
         WHERE s.thread_id = task_notifications.thread_id AND s.viewer_id = ? AND s.muted = 1
       )`,
  ).run(viewerId, viewerId);
}

function classifyUnconfirmedAttempts(db: ZhongshuoDatabase, now: number): void {
  db.prepare(
    `UPDATE task_notifications
     SET delivery_state = 'unknown',
         last_error = '已请求桌面通知，但宿主在收到显示/失败确认前退出或失去回执；不会自动重弹'
     WHERE delivery_state IN ('claimed','show_requested')
       AND claimed_at IS NOT NULL AND claimed_at < ?`,
  ).run(now - CLAIM_LEASE_MS);
}

function attemptView(row: AttemptRow): TaskNotificationAttemptView {
  return {
    notificationId: row.notification_id,
    title: row.title,
    state: row.delivery_state,
    claimRequestedAt: row.claim_requested_at,
    showRequestedAt: row.show_requested_at,
    shownAt: row.shown_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    clickedAt: row.clicked_at,
    closedAt: row.closed_at,
  };
}

export function pollTaskNotifications(
  db: ZhongshuoDatabase,
  viewerId: string,
  input: unknown,
  now = Date.now(),
): TaskNotificationPollResult {
  const params = taskNotificationPollParamsSchema.parse(input);
  const scannedThroughSeq = ingestDomainEvents(db, viewerId, now);
  classifyUnconfirmedAttempts(db, now);
  suppressMuted(db, viewerId);
  const rows = db.prepare(
    `SELECT notification_id FROM task_notifications
     WHERE viewer_id = ? AND delivery_state = 'pending'
     ORDER BY source_event_seq LIMIT ?`,
  ).all(viewerId, params.limit + 1) as Array<{ notification_id: string }>;
  const items = rows.slice(0, params.limit).map((row) => ({ notificationId: row.notification_id }));
  const healthRows = db.prepare(
    `SELECT
       count(*) AS attempted,
       sum(CASE WHEN a.show_requested_at IS NOT NULL THEN 1 ELSE 0 END) AS show_requested,
       sum(CASE WHEN a.shown_at IS NOT NULL THEN 1 ELSE 0 END) AS shown,
       sum(CASE WHEN n.delivery_state = 'unknown' THEN 1 ELSE 0 END) AS unknown,
       sum(CASE WHEN a.failed_at IS NOT NULL THEN 1 ELSE 0 END) AS failed,
       sum(CASE WHEN a.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
     FROM task_notification_attempts a
     JOIN task_notifications n ON n.notification_id = a.notification_id
     WHERE a.viewer_id = ?`,
  ).get(viewerId) as {
    attempted: number;
    show_requested: number | null;
    shown: number | null;
    unknown: number | null;
    failed: number | null;
    clicked: number | null;
  };
  const recentAttempts = db.prepare(
    `SELECT a.notification_id, n.title, n.delivery_state, a.claim_requested_at, a.show_requested_at,
            a.shown_at, a.failed_at, a.failure_reason, a.clicked_at, a.closed_at
     FROM task_notification_attempts a
     JOIN task_notifications n ON n.notification_id = a.notification_id
     WHERE a.viewer_id = ?
     ORDER BY a.claim_requested_at DESC LIMIT 5`,
  ).all(viewerId) as AttemptRow[];
  return {
    items,
    scannedThroughSeq,
    hasMore: rows.length > params.limit,
    health: {
      attempted: healthRows.attempted,
      showRequested: healthRows.show_requested ?? 0,
      shown: healthRows.shown ?? 0,
      unknown: healthRows.unknown ?? 0,
      failed: healthRows.failed ?? 0,
      clicked: healthRows.clicked ?? 0,
    },
    recentAttempts: recentAttempts.map(attemptView),
  };
}

function deliveryFromRow(row: NotificationRow): TaskNotificationDelivery {
  return taskNotificationDeliverySchema.parse({
    notificationId: row.notification_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    locator: {
      projectId: row.project_id,
      conversationId: row.conversation_id,
      roomId: row.room_id,
      threadId: row.thread_id,
      taskId: row.task_id,
      hash: row.locator_hash,
    },
  });
}

export function claimTaskNotification(
  db: ZhongshuoDatabase,
  viewerId: string,
  input: unknown,
  now = Date.now(),
): TaskNotificationClaimResult {
  const { notificationId } = taskNotificationClaimParamsSchema.parse(input);
  classifyUnconfirmedAttempts(db, now);
  suppressMuted(db, viewerId);
  const claim = db.transaction((): TaskNotificationClaimResult => {
    const row = db.prepare(
      `SELECT notification_id, kind, title, body, created_at, project_id, conversation_id,
              room_id, thread_id, task_id, locator_hash, delivery_state, claimed_at
       FROM task_notifications WHERE notification_id = ? AND viewer_id = ?`,
    ).get(notificationId, viewerId) as NotificationRow | undefined;
    if (row == null) return { claimed: false, reason: 'not_found' };
    if (row.delivery_state === 'suppressed') return { claimed: false, reason: 'muted' };
    if (row.delivery_state === 'claimed') return { claimed: false, reason: 'in_flight' };
    if (row.delivery_state !== 'pending') return { claimed: false, reason: 'not_pending' };
    if (threadMuted(db, viewerId, row.thread_id)) {
      db.prepare(
        `UPDATE task_notifications
         SET delivery_state = 'suppressed', claimed_at = NULL, last_error = '线程已静音'
         WHERE notification_id = ? AND viewer_id = ?`,
      ).run(notificationId, viewerId);
      return { claimed: false, reason: 'muted' };
    }
    const attemptId = `nta_${createHash('sha256').update(notificationId).digest('hex').slice(0, 32)}`;
    db.prepare(
      `INSERT INTO task_notification_attempts
         (attempt_id, notification_id, viewer_id, claim_requested_at)
       VALUES (?, ?, ?, ?)`,
    ).run(attemptId, notificationId, viewerId, now);
    db.prepare(
      `UPDATE task_notifications
       SET delivery_state = 'claimed', claimed_at = ?, attempts = attempts + 1, last_error = NULL
       WHERE notification_id = ? AND viewer_id = ?`,
    ).run(now, notificationId, viewerId);
    return { claimed: true, notification: deliveryFromRow(row) };
  });
  return claim.immediate();
}

function attemptFor(
  db: ZhongshuoDatabase,
  viewerId: string,
  notificationId: string,
): AttemptRow | undefined {
  return db.prepare(
    `SELECT a.notification_id, n.title, n.delivery_state, a.claim_requested_at, a.show_requested_at,
            a.shown_at, a.failed_at, a.failure_reason, a.clicked_at, a.closed_at
     FROM task_notification_attempts a
     JOIN task_notifications n ON n.notification_id = a.notification_id
     WHERE a.notification_id = ? AND a.viewer_id = ?`,
  ).get(notificationId, viewerId) as AttemptRow | undefined;
}

export function ackTaskNotification(
  db: ZhongshuoDatabase,
  viewerId: string,
  input: unknown,
  now = Date.now(),
): TaskNotificationAckResult {
  const params = taskNotificationAckParamsSchema.parse(input);
  const ack = db.transaction((): TaskNotificationAckResult => {
    const row = db.prepare(
      'SELECT delivery_state, thread_id FROM task_notifications WHERE notification_id = ? AND viewer_id = ?',
    ).get(params.notificationId, viewerId) as { delivery_state: AttemptRow['delivery_state']; thread_id: string | null } | undefined;
    if (row == null) {
      throw new TaskNotificationError('TASK_NOTIFICATION_NOT_FOUND', '任务通知不存在或不属于当前用户');
    }
    const attempt = attemptFor(db, viewerId, params.notificationId);
    if (attempt == null) {
      throw new TaskNotificationError('TASK_NOTIFICATION_NOT_PENDING', '任务通知没有持久化投递尝试');
    }

    if (params.stage === 'show_requested') {
      if (threadMuted(db, viewerId, row.thread_id)) {
        db.prepare(
          `UPDATE task_notifications
           SET delivery_state = 'suppressed', last_error = '线程已静音'
           WHERE notification_id = ? AND viewer_id = ?`,
        ).run(params.notificationId, viewerId);
        db.prepare(
          `UPDATE task_notification_attempts
           SET failure_reason = '线程已静音'
           WHERE notification_id = ? AND viewer_id = ?`,
        ).run(params.notificationId, viewerId);
      } else if (row.delivery_state === 'claimed') {
        db.prepare(
          `UPDATE task_notification_attempts
           SET show_requested_at = COALESCE(show_requested_at, ?)
           WHERE notification_id = ? AND viewer_id = ?`,
        ).run(now, params.notificationId, viewerId);
        db.prepare(
          `UPDATE task_notifications
           SET delivery_state = 'show_requested', last_error = NULL
           WHERE notification_id = ? AND viewer_id = ?`,
        ).run(params.notificationId, viewerId);
      } else if (!['show_requested', 'shown'].includes(row.delivery_state) || attempt.show_requested_at == null) {
        throw new TaskNotificationError('TASK_NOTIFICATION_NOT_PENDING', `通知状态 ${row.delivery_state} 不能请求显示`);
      }
    } else if (params.stage === 'shown') {
      if (!['claimed', 'show_requested', 'shown', 'unknown'].includes(row.delivery_state)) {
        throw new TaskNotificationError('TASK_NOTIFICATION_NOT_PENDING', `通知状态 ${row.delivery_state} 不能标记已显示`);
      }
      db.prepare(
        `UPDATE task_notification_attempts
         SET show_requested_at = COALESCE(show_requested_at, ?), shown_at = COALESCE(shown_at, ?)
         WHERE notification_id = ? AND viewer_id = ?`,
      ).run(now, now, params.notificationId, viewerId);
      db.prepare(
        `UPDATE task_notifications
         SET delivery_state = 'shown', shown_at = COALESCE(shown_at, ?), claimed_at = NULL, last_error = NULL
         WHERE notification_id = ? AND viewer_id = ?`,
      ).run(now, params.notificationId, viewerId);
    } else if (params.stage === 'failed') {
      if (!['claimed', 'show_requested', 'unknown', 'failed'].includes(row.delivery_state) || attempt.shown_at != null) {
        throw new TaskNotificationError('TASK_NOTIFICATION_NOT_PENDING', `通知状态 ${row.delivery_state} 不能标记失败`);
      }
      const reason = params.error ?? '桌面通知显示失败';
      db.prepare(
        `UPDATE task_notification_attempts
         SET failed_at = COALESCE(failed_at, ?), failure_reason = ?
         WHERE notification_id = ? AND viewer_id = ?`,
      ).run(now, reason, params.notificationId, viewerId);
      db.prepare(
        `UPDATE task_notifications
         SET delivery_state = 'failed', claimed_at = NULL, last_error = ?
         WHERE notification_id = ? AND viewer_id = ?`,
      ).run(reason, params.notificationId, viewerId);
    } else if (params.stage === 'clicked') {
      if (!['claimed', 'show_requested', 'shown', 'unknown'].includes(row.delivery_state)) {
        throw new TaskNotificationError('TASK_NOTIFICATION_NOT_PENDING', `通知状态 ${row.delivery_state} 不能记录点击`);
      }
      db.prepare(
        `UPDATE task_notification_attempts
         SET show_requested_at = COALESCE(show_requested_at, ?), shown_at = COALESCE(shown_at, ?),
             clicked_at = COALESCE(clicked_at, ?)
         WHERE notification_id = ? AND viewer_id = ?`,
      ).run(now, now, now, params.notificationId, viewerId);
      db.prepare(
        `UPDATE task_notifications
         SET delivery_state = 'shown', shown_at = COALESCE(shown_at, ?), claimed_at = NULL, last_error = NULL
         WHERE notification_id = ? AND viewer_id = ?`,
      ).run(now, params.notificationId, viewerId);
    } else {
      db.prepare(
        `UPDATE task_notification_attempts
         SET closed_at = COALESCE(closed_at, ?)
         WHERE notification_id = ? AND viewer_id = ?`,
      ).run(now, params.notificationId, viewerId);
    }

    const settled = attemptFor(db, viewerId, params.notificationId);
    if (settled == null) {
      throw new TaskNotificationError('TASK_NOTIFICATION_CORRUPT', '任务通知投递记录消失');
    }
    return {
      notificationId: params.notificationId,
      state: settled.delivery_state === 'pending' ? 'claimed' : settled.delivery_state,
      attempt: attemptView(settled),
    };
  });
  return ack.immediate();
}
