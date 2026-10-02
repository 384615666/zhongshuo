/**
 * 领域事件追加（§15.1/§12.2 domain_events）。与业务状态变更同事务写入。
 */
import type { ZhongshuoDatabase } from './db.ts';
import type { DomainEvent } from '../contracts/commands.ts';

export function appendDomainEvent(db: ZhongshuoDatabase, event: Omit<DomainEvent, 'seq'>): void {
  db.prepare(
    `INSERT INTO domain_events
       (event_id, schema_version, project_id, conversation_id, thread_id, task_id, run_id, turn_id, kind, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.eventId,
    event.schemaVersion,
    event.projectId,
    event.conversationId ?? null,
    event.threadId ?? null,
    event.taskId ?? null,
    event.runId ?? null,
    event.turnId ?? null,
    event.kind,
    JSON.stringify(event.payload ?? null),
    event.createdAt,
  );
}

export function listEvents(
  db: ZhongshuoDatabase,
  projectId: string,
  afterSeq = 0,
  limit = 100,
): Array<{ seq: number; event_id: string; kind: string; payload_json: string; conversation_id: string | null; thread_id: string | null; task_id: string | null }> {
  // conversation_id/thread_id/task_id（第三十二轮一）：命令层 audience 过滤需要真实归属列。
  return db
    .prepare(
      'SELECT seq, event_id, kind, payload_json, conversation_id, thread_id, task_id FROM domain_events WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    )
    .all(projectId, afterSeq, limit) as Array<{
    seq: number;
    event_id: string;
    kind: string;
    payload_json: string;
    conversation_id: string | null;
    thread_id: string | null;
    task_id: string | null;
  }>;
}
