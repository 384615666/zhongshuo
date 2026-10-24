import {
  messageRepairLineageSchema,
  type MessageRepairLineage,
  type MessageRepairLineageState,
} from '../contracts/repairLineage.ts';
import type { ZhongshuoDatabase } from '../persistence/db.ts';

interface MessageRow {
  id: string;
  project_id: string;
  conversation_id: string;
  room_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  author_type: string;
  author_id: string;
  body_json: string;
  status: string;
}

interface TaskScope {
  id: string;
  kind: 'room_task' | 'dm_turn';
  project_id: string;
  conversation_id: string;
  room_id: string | null;
  thread_id: string | null;
}

interface TurnScope {
  id: string;
  run_id: string;
  run_status: string;
  conversation_id: string;
  thread_id: string | null;
  member_id: string;
  turn_purpose: string;
  status: string;
}

interface RepairWorkitemRow {
  id: string;
  task_id: string;
  source_turn_id: string;
  source_result_key: string;
  logical_output_id: string;
  source_output_text: string;
  status: string;
  consumed_turn_id: string | null;
}

interface ReplyEventRow {
  payload_json: string;
  project_id: string | null;
  conversation_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  run_id: string | null;
}

const EMPTY_MESSAGE_IDS: readonly string[] = [];

/**
 * Reads the presentation lineage for one message without mutating repair,
 * message, turn, run, or event history.
 */
export function readMessageRepairLineage(
  db: ZhongshuoDatabase,
  messageId: string,
): MessageRepairLineage | null {
  return readMessageRepairLineages(db, messageId.length === 0 ? EMPTY_MESSAGE_IDS : [messageId]).get(messageId) ?? null;
}

/**
 * Batches the lookup for history/projection callers. Only the exact source and
 * replacement messages are keyed; intermediate, handoff, progress and system
 * messages from the same turns deliberately remain outside the map.
 */
export function readMessageRepairLineages(
  db: ZhongshuoDatabase,
  messageIds: readonly string[],
): Map<string, MessageRepairLineage> {
  const ids = [...new Set(messageIds.filter((id) => id.length > 0))];
  const found = new Map<string, MessageRepairLineage>();
  if (ids.length === 0) return found;

  const targets = db.prepare(
    `SELECT id, task_id FROM messages WHERE id IN (${placeholders(ids.length)})`,
  ).all(...ids) as Array<{ id: string; task_id: string | null }>;
  const taskIds = [...new Set(targets.flatMap((message) => message.task_id == null ? [] : [message.task_id]))];
  if (taskIds.length === 0) return found;

  const workitems = db.prepare(
    `SELECT id, task_id, source_turn_id, source_result_key, logical_output_id,
            source_output_text, status, consumed_turn_id
     FROM format_repair_workitems
     WHERE task_id IN (${placeholders(taskIds.length)})
     ORDER BY created_at, id`,
  ).all(...taskIds) as RepairWorkitemRow[];

  const candidates = new Map<string, MessageRepairLineage[]>();
  for (const workitem of workitems) {
    const lineage = resolveWorkitem(db, workitem);
    if (lineage == null) continue;
    const messageIdsForLineage = lineage.replacementMessageId == null
      ? [lineage.sourceMessageId]
      : [lineage.sourceMessageId, lineage.replacementMessageId];
    for (const messageId of messageIdsForLineage) {
      const values = candidates.get(messageId) ?? [];
      values.push(lineage);
      candidates.set(messageId, values);
    }
  }

  for (const messageId of ids) {
    const values = candidates.get(messageId);
    if (values?.length !== 1) continue;
    const lineage = values[0]!;
    found.set(messageId, {
      ...lineage,
      messageRole: messageId === lineage.sourceMessageId ? 'source' : 'replacement',
    });
  }
  return found;
}

function resolveWorkitem(db: ZhongshuoDatabase, workitem: RepairWorkitemRow): MessageRepairLineage | null {
  const task = readTaskScope(db, workitem.task_id);
  if (task == null) return null;

  const sourceTurn = readTurnScope(db, workitem.source_turn_id, task);
  if (sourceTurn == null) return null;
  const sourceMessage = findSourceMessage(db, task, sourceTurn, workitem.source_output_text);
  if (sourceMessage == null) return null;

  let state: MessageRepairLineageState = sourceTurn.status === 'FAILED' ? 'pending' : 'unknown';
  let repairTurn: TurnScope | null = null;
  let replacementMessage: MessageRow | null = null;

  if (workitem.consumed_turn_id != null) {
    const candidateTurn = readTurnScope(db, workitem.consumed_turn_id, task);
    if (candidateTurn != null
      && candidateTurn.turn_purpose === 'format_repair'
      && candidateTurn.member_id === sourceTurn.member_id) {
      repairTurn = candidateTurn;
      if (candidateTurn.status === 'UNKNOWN'
        || candidateTurn.run_status === 'INTERRUPTED') {
        state = 'unknown';
      } else if (candidateTurn.status === 'FAILED'
        || candidateTurn.status === 'CANCELLED'
        || candidateTurn.run_status === 'FAILED'
        || candidateTurn.run_status === 'CANCELLED') {
        state = 'failed';
      } else if (candidateTurn.status === 'SUCCEEDED' && candidateTurn.run_status === 'SUCCEEDED') {
        replacementMessage = findReplacementMessage(db, task, candidateTurn, workitem.source_result_key);
        state = workitem.status === 'consumed'
          && sourceTurn.status === 'FAILED'
          && sourceTurn.turn_purpose !== 'format_repair'
          && replacementMessage != null
          ? 'repaired'
          : 'unknown';
      } else if (isActiveTurnStatus(candidateTurn.status) && isActiveRunStatus(candidateTurn.run_status)) {
        state = 'pending';
      } else {
        state = 'unknown';
      }
    } else {
      state = 'unknown';
    }
  } else if (workitem.status !== 'pending') {
    state = 'failed';
  }

  if (state === 'repaired' && replacementMessage == null) state = 'unknown';
  if (state !== 'repaired') replacementMessage = null;

  const parsed = messageRepairLineageSchema.safeParse({
    state,
    messageRole: 'source',
    sourceMessageId: sourceMessage.id,
    replacementMessageId: state === 'repaired' ? replacementMessage!.id : null,
    workitemId: workitem.id,
    logicalOutputId: workitem.logical_output_id,
    sourceResultKey: workitem.source_result_key,
    sourceTurnId: sourceTurn.id,
    repairTurnId: repairTurn?.id ?? null,
    sourceRunId: sourceTurn.run_id,
    repairRunId: repairTurn?.run_id ?? null,
    projectId: task.project_id,
    conversationId: task.conversation_id,
    threadId: task.thread_id,
    taskId: task.id,
    memberId: sourceTurn.member_id,
  });
  return parsed.success ? parsed.data : null;
}

function readTaskScope(db: ZhongshuoDatabase, taskId: string): TaskScope | null {
  const row = db.prepare(
    `SELECT t.id, t.kind, t.project_id, t.conversation_id, t.room_id,
            t.conversation_thread_id AS thread_id, c.kind AS conversation_kind,
            c.project_id AS conversation_project_id, c.room_id AS conversation_room_id
     FROM tasks t
     JOIN conversations c ON c.id=t.conversation_id
     JOIN projects p ON p.id=t.project_id
     WHERE t.id=?`,
  ).get(taskId) as (TaskScope & {
    conversation_kind: string;
    conversation_project_id: string;
    conversation_room_id: string | null;
  }) | undefined;
  if (row == null
    || row.conversation_project_id !== row.project_id
    || (row.kind === 'dm_turn'
      ? row.conversation_kind !== 'dm' || row.room_id != null || row.thread_id != null || row.conversation_room_id != null
      : row.kind !== 'room_task'
        || row.conversation_kind !== 'room'
        || row.room_id == null
        || row.thread_id == null
        || row.conversation_room_id !== row.room_id)) {
    return null;
  }

  if (row.thread_id != null) {
    const thread = db.prepare(
      `SELECT project_id, conversation_id, room_id
       FROM conversation_threads WHERE id=?`,
    ).get(row.thread_id) as { project_id: string; conversation_id: string; room_id: string } | undefined;
    if (thread == null
      || thread.project_id !== row.project_id
      || thread.conversation_id !== row.conversation_id
      || thread.room_id !== row.room_id) return null;
  }
  return {
    id: row.id,
    kind: row.kind,
    project_id: row.project_id,
    conversation_id: row.conversation_id,
    room_id: row.room_id,
    thread_id: row.thread_id,
  };
}

function readTurnScope(db: ZhongshuoDatabase, turnId: string, task: TaskScope): TurnScope | null {
  const row = db.prepare(
    `SELECT a.id, a.run_id, r.status AS run_status, a.conversation_id, a.thread_id, a.member_id,
            a.turn_purpose, a.status, r.task_id, r.conversation_id AS run_conversation_id,
            r.thread_id AS run_thread_id, pm.project_id AS member_project_id,
            pm.principal_type AS member_type
     FROM agent_turns a
     JOIN workflow_runs r ON r.id=a.run_id
     JOIN project_members pm ON pm.id=a.member_id
     WHERE a.id=?`,
  ).get(turnId) as (TurnScope & {
    task_id: string;
    run_conversation_id: string;
    run_thread_id: string | null;
    member_project_id: string;
    member_type: string;
  }) | undefined;
  if (row == null
    || row.task_id !== task.id
    || row.conversation_id !== task.conversation_id
    || row.run_conversation_id !== task.conversation_id
    || row.thread_id !== task.thread_id
    || row.run_thread_id !== task.thread_id
    || row.member_project_id !== task.project_id
    || row.member_type !== 'agent') return null;

  const membership = db.prepare(
    `SELECT 1 AS ok FROM run_participants
     WHERE run_id=? AND member_id=?`,
  ).get(row.run_id, row.member_id);
  if (membership == null) return null;

  return {
    id: row.id,
    run_id: row.run_id,
    run_status: row.run_status,
    conversation_id: row.conversation_id,
    thread_id: row.thread_id,
    member_id: row.member_id,
    turn_purpose: row.turn_purpose,
    status: row.status,
  };
}

function findSourceMessage(
  db: ZhongshuoDatabase,
  task: TaskScope,
  turn: TurnScope,
  sourceOutputText: string,
): MessageRow | null {
  return findReplyMessage(
    db,
    task,
    turn,
    (message) => outputOfMessage(message) === sourceOutputText,
    task.kind === 'dm_turn',
  );
}

function findReplacementMessage(
  db: ZhongshuoDatabase,
  task: TaskScope,
  turn: TurnScope,
  sourceResultKey: string,
): MessageRow | null {
  return findReplyMessage(
    db,
    task,
    turn,
    (message) => {
      const body = parseBody(message.body_json);
      if (typeof body?.runtimeControlResult !== 'string') return false;
      const control = parseJsonObject(body.runtimeControlResult);
      return control?.schemaVersion === 'task-complete-v1'
        && control.resultKey === sourceResultKey;
    },
    task.kind === 'dm_turn',
  );
}

function findReplyMessage(
  db: ZhongshuoDatabase,
  task: TaskScope,
  turn: TurnScope,
  predicate: (message: MessageRow) => boolean,
  allowDmTurnNamespaceFallback: boolean,
): MessageRow | null {
  const events = db.prepare(
    `SELECT payload_json, project_id, conversation_id, thread_id, task_id, run_id
     FROM domain_events
     WHERE kind='thread.replyAdded' AND turn_id=?
     ORDER BY seq DESC`,
  ).all(turn.id) as ReplyEventRow[];
  for (const event of events) {
    if (event.project_id !== task.project_id
      || event.conversation_id !== task.conversation_id
      || event.thread_id !== task.thread_id
      || event.task_id !== task.id
      || (event.run_id != null && event.run_id !== turn.run_id)) continue;
    const payload = parseJsonObject(event.payload_json);
    if (typeof payload?.messageId !== 'string' || typeof payload.system === 'string') continue;
    const message = readMessage(db, payload.messageId);
    if (message != null && messageBelongsToTurn(message, task, turn) && predicate(message)) {
      return message;
    }
  }

  if (!allowDmTurnNamespaceFallback) return null;
  const prefix = `msg_${turn.id}_`;
  const rows = db.prepare(
    `SELECT id, project_id, conversation_id, room_id, thread_id, task_id,
            author_type, author_id, body_json, status
     FROM messages
     WHERE task_id=? AND project_id=? AND conversation_id=? AND thread_id IS NULL
       AND author_type='agent' AND author_id=? AND substr(id,1,?)=?
     ORDER BY created_at DESC, rowid DESC`,
  ).all(task.id, task.project_id, task.conversation_id, turn.member_id, prefix.length, prefix) as MessageRow[];
  const matches = rows.filter((message) => messageBelongsToTurn(message, task, turn) && predicate(message));
  return matches.length === 1 ? matches[0]! : null;
}

function readMessage(db: ZhongshuoDatabase, messageId: string): MessageRow | null {
  return db.prepare(
    `SELECT id, project_id, conversation_id, room_id, thread_id, task_id,
            author_type, author_id, body_json, status
     FROM messages WHERE id=?`,
  ).get(messageId) as MessageRow | undefined ?? null;
}

function messageBelongsToTurn(message: MessageRow, task: TaskScope, turn: TurnScope): boolean {
  return message.project_id === task.project_id
    && message.conversation_id === task.conversation_id
    && message.room_id === task.room_id
    && message.thread_id === task.thread_id
    && message.task_id === task.id
    && message.author_type === 'agent'
    && message.author_id === turn.member_id
    && (message.status === 'final' || message.status === 'saved');
}

function outputOfMessage(message: MessageRow): string | null {
  const body = parseBody(message.body_json);
  if (typeof body?.runtimeControlResult === 'string') return body.runtimeControlResult;
  return typeof body?.text === 'string' ? body.text : null;
}

function parseBody(raw: string): { text?: unknown; runtimeControlResult?: unknown } | null {
  return parseJsonObject(raw) as { text?: unknown; runtimeControlResult?: unknown } | null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value != null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function isActiveTurnStatus(status: string): boolean {
  return new Set([
    'PENDING',
    'DISPATCHING',
    'RUNNING',
    'WAITING',
    'WAITING_APPROVAL',
    'WAITING_INPUT',
    'STOPPING',
  ]).has(status);
}

function isActiveRunStatus(status: string): boolean {
  return new Set(['QUEUED', 'RUNNING', 'WAITING', 'STOPPING']).has(status);
}
