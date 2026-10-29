import { createHash } from 'node:crypto';
import {
  mergeRoleMemoryInputSchema,
  roleMemoryScopeSchema,
  roleMemorySnapshotSchema,
} from '../../contracts/roleMemory.ts';
import type {
  MergeRoleMemoryInput,
  RoleMemoryEntry,
  RoleMemoryScope,
  RoleMemorySnapshot,
  RoleMemoryValue,
} from '../../contracts/roleMemory.ts';
import type { ZhongshuoDatabase } from '../db.ts';

export class RoleMemoryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'RoleMemoryError';
  }
}

function sameScope(a: RoleMemoryScope, b: RoleMemoryScope): boolean {
  return a.projectId === b.projectId && a.memberId === b.memberId && a.conversationId === b.conversationId;
}

function assertScope(db: ZhongshuoDatabase, scope: RoleMemoryScope): void {
  const valid = db.prepare(`SELECT 1 FROM conversations c
    JOIN project_members m ON m.project_id = c.project_id
    WHERE c.project_id = ? AND c.id = ? AND m.id = ? AND m.principal_type = 'agent'
      AND (c.kind = 'room' OR EXISTS (
        SELECT 1 FROM dm_participants p WHERE p.project_id = c.project_id
          AND p.conversation_id = c.id AND p.principal_type = 'agent' AND p.principal_id = m.id
      ))`).get(scope.projectId, scope.conversationId, scope.memberId);
  if (valid == null) throw new RoleMemoryError('ROLE_MEMORY_SCOPE_MISMATCH');
}

function revisionOf(db: ZhongshuoDatabase, scope: RoleMemoryScope): number {
  const row = db.prepare(`SELECT revision FROM role_memory_scopes
    WHERE project_id = ? AND member_id = ? AND conversation_id = ?`)
    .get(scope.projectId, scope.memberId, scope.conversationId) as { revision: number } | undefined;
  return row?.revision ?? 0;
}

function snapshotOf(db: ZhongshuoDatabase, scope: RoleMemoryScope): RoleMemorySnapshot {
  const revision = revisionOf(db, scope);
  const rows = db.prepare(`SELECT v.key, v.text, c.source_task_id AS sourceTaskId,
      c.source_thread_id AS sourceThreadId, c.source_turn_id AS sourceTurnId, c.created_at AS createdAt
    FROM role_memory_commits c JOIN role_memory_values v ON v.source_turn_id = c.source_turn_id
    WHERE c.project_id = ? AND c.member_id = ? AND c.conversation_id = ?
    ORDER BY v.key, c.revision, c.source_turn_id, v.text`)
    .all(scope.projectId, scope.memberId, scope.conversationId) as Array<RoleMemoryValue & { key: string }>;
  const entries = new Map<string, RoleMemoryEntry>();
  const texts = new Map<string, Set<string>>();
  for (const { key, ...value } of rows) {
    let entry = entries.get(key);
    if (entry == null) {
      entry = { key, conflicted: false, values: [] };
      entries.set(key, entry);
      texts.set(key, new Set());
    }
    entry.values.push(value);
    const distinct = texts.get(key)!;
    distinct.add(value.text);
    entry.conflicted = distinct.size > 1;
  }
  return { scope, revision, entries: [...entries.values()] };
}

/** A consistent read transaction prevents a revision/entries mixture across writers. */
export function readRoleMemory(db: ZhongshuoDatabase, scope: RoleMemoryScope): RoleMemorySnapshot {
  const parsed = roleMemoryScopeSchema.parse(scope);
  return db.transaction(() => {
    assertScope(db, parsed);
    return snapshotOf(db, parsed);
  })();
}

interface TurnSource {
  status: string;
  threadId: string | null;
  taskStatus: string;
  runStatus: string;
  stopGeneration: number;
  stopSnapshot: number;
  protectionState: string | null;
}

function assertTurn(db: ZhongshuoDatabase, input: MergeRoleMemoryInput): TurnSource {
  const { scope } = input;
  // Verify the entire redundant ownership chain, including thread project/conversation.
  const source = db.prepare(`SELECT a.status, a.thread_id AS threadId, t.status AS taskStatus,
      r.status AS runStatus, t.stop_generation AS stopGeneration,
      a.stop_generation_snapshot AS stopSnapshot, a.protection_state AS protectionState
    FROM agent_turns a JOIN workflow_runs r ON r.id = a.run_id
    JOIN tasks t ON t.id = r.task_id
    JOIN conversations c ON c.id = t.conversation_id AND c.project_id = t.project_id
    LEFT JOIN conversation_threads h ON h.id = a.thread_id
    WHERE a.id = ? AND t.id = ? AND t.project_id = ? AND a.member_id = ?
      AND t.conversation_id = ? AND a.conversation_id = t.conversation_id
      AND r.conversation_id = t.conversation_id
      AND a.thread_id IS r.thread_id AND a.thread_id IS t.conversation_thread_id
      AND ((c.kind = 'dm' AND t.kind = 'dm_turn' AND a.thread_id IS NULL)
        OR (c.kind = 'room' AND t.kind = 'room_task' AND h.project_id = t.project_id
          AND h.conversation_id = t.conversation_id AND h.room_id = c.room_id AND t.room_id = c.room_id))`)
    .get(input.turnId, input.taskId, scope.projectId, scope.memberId, scope.conversationId) as TurnSource | undefined;
  if (source == null) throw new RoleMemoryError('ROLE_MEMORY_TURN_SCOPE_MISMATCH');
  if (source.status !== 'SUCCEEDED') throw new RoleMemoryError('ROLE_MEMORY_TURN_NOT_SUCCEEDED');
  const stopped = source.stopSnapshot < 0
    ? source.stopGeneration > 0
    : source.stopGeneration > source.stopSnapshot;
  if (stopped || source.taskStatus === 'CANCELLED' || ['STOPPING', 'CANCELLED'].includes(source.runStatus)
    || source.protectionState === 'retained') {
    throw new RoleMemoryError('ROLE_MEMORY_TURN_CANCELLED_OR_PROTECTED');
  }
  return source;
}

function assertInputSnapshot(db: ZhongshuoDatabase, input: MergeRoleMemoryInput, threadId: string | null): void {
  // There must be one unambiguous formal input. Never pick a convenient older bundle.
  const bundles = db.prepare('SELECT thread_id, included_refs_json FROM context_bundles WHERE turn_id = ?')
    .all(input.turnId) as Array<{ thread_id: string | null; included_refs_json: string }>;
  if (bundles.length !== 1 || bundles[0]!.thread_id !== threadId) {
    throw new RoleMemoryError('ROLE_MEMORY_INPUT_SNAPSHOT_MISMATCH');
  }
  let snapshot: RoleMemorySnapshot;
  try {
    const envelope: unknown = JSON.parse(bundles[0]!.included_refs_json);
    const memory = envelope != null && typeof envelope === 'object' && !Array.isArray(envelope)
      ? (envelope as Record<string, unknown>).roleMemory : undefined;
    snapshot = roleMemorySnapshotSchema.parse(memory);
  } catch {
    throw new RoleMemoryError('ROLE_MEMORY_INPUT_SNAPSHOT_MISMATCH');
  }
  if (!sameScope(snapshot.scope, input.scope) || snapshot.revision !== input.baseRevision) {
    throw new RoleMemoryError('ROLE_MEMORY_INPUT_SNAPSHOT_MISMATCH');
  }
}

/**
 * Append only, in an IMMEDIATE transaction (or a savepoint in the caller's terminal
 * transaction). Old bases merge; future bases fail. Each nonempty delta advances
 * the revision once. Empty deltas record a receipt without advancing the revision.
 * The SHA-256 covers the normalized full input, including scope/task/base and order.
 * A retry returns the latest snapshot and never adds a second receipt or source.
 * Validation failures throw RoleMemoryError; malformed input throws a ZodError.
 */
export function mergeRoleMemory(db: ZhongshuoDatabase, input: MergeRoleMemoryInput): RoleMemorySnapshot {
  const parsed = mergeRoleMemoryInputSchema.parse(input);
  const payloadHash = createHash('sha256').update(JSON.stringify(parsed), 'utf8').digest('hex');
  return db.transaction(() => {
    const receipt = db.prepare('SELECT payload_hash FROM role_memory_commits WHERE source_turn_id = ?')
      .get(parsed.turnId) as { payload_hash: string } | undefined;
    if (receipt != null && receipt.payload_hash !== payloadHash) {
      throw new RoleMemoryError('ROLE_MEMORY_IDEMPOTENCY_CONFLICT');
    }
    assertScope(db, parsed.scope);
    const source = assertTurn(db, parsed);
    assertInputSnapshot(db, parsed, source.threadId);
    const currentRevision = revisionOf(db, parsed.scope);
    if (parsed.baseRevision > currentRevision) throw new RoleMemoryError('ROLE_MEMORY_FUTURE_REVISION');
    if (receipt != null) return snapshotOf(db, parsed.scope);

    const { projectId, memberId, conversationId } = parsed.scope;
    const revision = currentRevision + (parsed.updates.length === 0 ? 0 : 1);
    db.prepare(`INSERT INTO role_memory_scopes (project_id, member_id, conversation_id, revision)
      VALUES (?, ?, ?, ?) ON CONFLICT (project_id, member_id, conversation_id)
      DO UPDATE SET revision = excluded.revision`).run(projectId, memberId, conversationId, revision);
    db.prepare(`INSERT INTO role_memory_commits (source_turn_id, project_id, member_id, conversation_id,
        source_task_id, source_thread_id, payload_hash, base_revision, revision, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.turnId, projectId, memberId, conversationId,
      parsed.taskId, source.threadId, payloadHash, parsed.baseRevision, revision, Date.now());
    const insert = db.prepare(`INSERT INTO role_memory_values (source_turn_id, key, text) VALUES (?, ?, ?)
      ON CONFLICT (source_turn_id, key, text) DO NOTHING`);
    for (const update of parsed.updates) insert.run(parsed.turnId, update.key, update.text);
    return snapshotOf(db, parsed.scope);
  }).immediate();
}
