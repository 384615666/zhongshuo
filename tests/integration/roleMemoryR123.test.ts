import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { memoryUpdateSchema, roleMemorySnapshotSchema } from '../../src/contracts/roleMemory.ts';
import type { MergeRoleMemoryInput, RoleMemoryScope, RoleMemorySnapshot } from '../../src/contracts/roleMemory.ts';
import { migrate, openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/index.ts';
import { mergeRoleMemory, readRoleMemory } from '../../src/persistence/stores/roleMemory.ts';

const scope: RoleMemoryScope = { projectId: 'p1', memberId: 'm1', conversationId: 'room-c1' };
const databases: ZhongshuoDatabase[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'zhongshuo-role-memory-r123-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

function seed(db: ZhongshuoDatabase): void {
  db.exec(`
    INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
      VALUES ('p1','project 1','synthetic-p1','synthetic-p1','p1',1),
             ('p2','project 2','synthetic-p2','synthetic-p2','p2',1);
    INSERT INTO project_members (id, project_id, display_name, principal_type)
      VALUES ('m1','p1','role 1','agent'), ('m2','p1','role 2','agent'), ('m3','p2','role 3','agent');
    INSERT INTO rooms (id, project_id, name, coordinator_member_id)
      VALUES ('r1','p1','room 1','m1'), ('r2','p1','room 2','m1'), ('r3','p2','room 3','m3');
    INSERT INTO conversations (id, project_id, kind, room_id)
      VALUES ('room-c1','p1','room','r1'), ('room-c2','p1','room','r2'),
             ('room-c3','p2','room','r3'), ('dm-c1','p1','dm',NULL), ('dm-c2','p1','dm',NULL);
    INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id)
      VALUES ('p1','dm-c1','agent','m1'), ('p1','dm-c1','human','local'),
             ('p1','dm-c2','agent','m1'), ('p1','dm-c2','human','local');
  `);
}

function fixture(path = ':memory:'): ZhongshuoDatabase {
  const db = openDatabase(path);
  databases.push(db);
  seed(db);
  return db;
}

function prepareMerge(db: ZhongshuoDatabase, options: {
  scope?: RoleMemoryScope;
  snapshot?: RoleMemorySnapshot;
  status?: string;
  updates?: MergeRoleMemoryInput['updates'];
} = {}): MergeRoleMemoryInput {
  const target = options.scope ?? scope;
  const snapshot = options.snapshot ?? readRoleMemory(db, target);
  const conversation = db.prepare('SELECT kind, room_id FROM conversations WHERE id = ?')
    .get(target.conversationId) as { kind: string; room_id: string | null };
  const id = randomUUID();
  const threadId = conversation.kind === 'dm' ? null : `thread-${id}`;
  if (threadId != null) {
    db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id)
      VALUES (?, ?, ?, ?, ?)`).run(threadId, target.projectId, target.conversationId, conversation.room_id, `anchor-${id}`);
  }
  const taskId = `task-${id}`;
  db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id,
      owner_member_id, title, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'synthetic memory task', 'ACTIVE')`)
    .run(taskId, target.projectId, target.conversationId, conversation.kind === 'dm' ? 'dm_turn' : 'room_task',
      conversation.room_id, threadId, target.memberId);
  db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, status)
    VALUES (?, ?, ?, ?, 'DIRECT', 'RUNNING')`).run(`run-${id}`, taskId, target.conversationId, threadId);
  const turnId = `turn-${id}`;
  db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key,
      status, stop_generation_snapshot) VALUES (?, ?, ?, ?, ?, 'direct.work', ?, 0)`)
    .run(turnId, `run-${id}`, target.conversationId, threadId, target.memberId, options.status ?? 'SUCCEEDED');
  db.prepare(`INSERT INTO context_bundles (id, turn_id, thread_id, task_revision, included_refs_json, scope_grants_json, hash)
    VALUES (?, ?, ?, 0, ?, '[]', 'synthetic-input-hash')`)
    .run(`bundle-${id}`, turnId, threadId, JSON.stringify({ text: 'synthetic formal input', roleMemory: snapshot }));
  return { scope: target, turnId, taskId, baseRevision: snapshot.revision,
    updates: options.updates ?? [{ key: 'decision', text: 'keep every contribution' }] };
}

function memoryRows(db: ZhongshuoDatabase): unknown[] {
  return ['role_memory_scopes', 'role_memory_commits', 'role_memory_values'].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

/** Two actual Node workers use independent connections and the same frozen base. */
async function concurrentMerges(path: string, inputs: MergeRoleMemoryInput[]): Promise<RoleMemorySnapshot[]> {
  const workers: Worker[] = [];
  const ready: Promise<void>[] = [];
  const completed: Promise<RoleMemorySnapshot>[] = [];
  for (const input of inputs) {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { openDatabase } = await import(workerData.dbModule);
        const { mergeRoleMemory } = await import(workerData.storeModule);
        const db = openDatabase(workerData.path);
        parentPort.once('message', () => {
          try { parentPort.postMessage({ snapshot: mergeRoleMemory(db, workerData.input) }); }
          catch (error) { parentPort.postMessage({ error: String(error) }); }
          finally { db.close(); parentPort.close(); }
        });
        parentPort.postMessage({ ready: true });
      })().catch(error => { throw error; });
    `, { eval: true, workerData: { path, input,
      dbModule: new URL('../../src/persistence/db.ts', import.meta.url).href,
      storeModule: new URL('../../src/persistence/stores/roleMemory.ts', import.meta.url).href } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => {
      worker.on('message', (message: { ready?: boolean }) => { if (message.ready) resolve(); });
      worker.on('error', reject);
    }));
    completed.push(new Promise((resolve, reject) => {
      worker.on('message', (message: { snapshot?: RoleMemorySnapshot; error?: string }) => {
        if (message.error) reject(new Error(message.error));
        if (message.snapshot) resolve(message.snapshot);
      });
      worker.on('error', reject);
    }));
  }
  // Install all rejection handlers before either worker can fail during startup.
  const results = Promise.all(completed);
  void results.catch(() => undefined);
  try {
    await Promise.all(ready);
    for (const worker of workers) worker.postMessage('merge');
    return await results;
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

describe('R123 append-only versioned role memory', () => {
  it('starts empty without creating rows and exports a browser-safe, uncapped trimmed delta contract', () => {
    const db = fixture();
    expect(readRoleMemory(db, scope)).toEqual({ scope, revision: 0, entries: [] });
    expect(memoryRows(db)).toEqual([[], [], []]);
    expect(memoryUpdateSchema.parse({ key: ' key ', text: ' value ' })).toEqual({ key: 'key', text: 'value' });
    expect(memoryUpdateSchema.safeParse({ key: ' \n ', text: 'ok' }).success).toBe(false);
    expect(memoryUpdateSchema.safeParse({ key: 'ok', text: ' \t ' }).success).toBe(false);
    expect(memoryUpdateSchema.safeParse({ key: 'k', text: 'ok', replace: true }).success).toBe(false);
    const input = prepareMerge(db, { updates: Array.from({ length: 1100 }, (_, i) => ({ key: `k${i}`, text: 'x'.repeat(1025) })) });
    const snapshot = mergeRoleMemory(db, input);
    expect(snapshot.entries).toHaveLength(1100);
    expect(roleMemorySnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('merges two concurrent old-base submissions across room threads without losing either value', async () => {
    const path = tempDatabasePath();
    const db = fixture(path);
    const a = prepareMerge(db, { updates: [{ key: 'decision', text: 'A' }] });
    const b = prepareMerge(db, { updates: [{ key: 'decision', text: 'B' }] });
    expect([a.baseRevision, b.baseRevision]).toEqual([0, 0]);
    const snapshots = await concurrentMerges(path, [a, b]);
    expect(snapshots.map((snapshot) => snapshot.revision).sort()).toEqual([1, 2]);
    const snapshot = readRoleMemory(db, scope);
    expect(snapshot.revision).toBe(2);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]!.conflicted).toBe(true);
    expect(new Set(snapshot.entries[0]!.values.map((value) => value.text))).toEqual(new Set(['A', 'B']));
    expect(new Set(snapshot.entries[0]!.values.map((value) => value.sourceThreadId)).size).toBe(2);
    for (const input of [a, b]) {
      expect(snapshot.entries[0]!.values).toContainEqual(expect.objectContaining({
        sourceTaskId: input.taskId, sourceTurnId: input.turnId, createdAt: expect.any(Number),
      }));
    }
  });

  it('keeps different keys, all conflicts within a delta, and equal-text provenance across turns', () => {
    const db = fixture();
    const a = prepareMerge(db, { updates: [
      { key: ' key ', text: ' A ' }, { key: 'key', text: 'A' }, { key: 'key', text: 'B' }, { key: 'other', text: 'C' },
    ] });
    const first = mergeRoleMemory(db, a);
    expect(first.entries.map((entry) => [entry.key, entry.conflicted, entry.values.length]))
      .toEqual([['key', true, 2], ['other', false, 1]]);
    const b = prepareMerge(db, { updates: [{ key: 'other', text: 'C' }] });
    const second = mergeRoleMemory(db, b);
    const other = second.entries.find((entry) => entry.key === 'other')!;
    expect(other.conflicted).toBe(false);
    expect(other.values.map((value) => value.sourceTurnId)).toEqual([a.turnId, b.turnId]);
  });

  it('deduplicates simultaneous retries of one turn across independent connections', async () => {
    const path = tempDatabasePath();
    const db = fixture(path);
    const input = prepareMerge(db);
    const snapshots = await concurrentMerges(path, [input, input]);
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(readRoleMemory(db, scope).revision).toBe(1);
    expect(db.prepare('SELECT count(*) AS count FROM role_memory_commits').get()).toEqual({ count: 1 });
    expect(readRoleMemory(db, scope).entries[0]!.values).toHaveLength(1);
  });

  it('rejects whole-snapshot payloads and invalid mixed deltas before any write', () => {
    const db = fixture();
    const input = prepareMerge(db);
    const snapshot = mergeRoleMemory(db, input);
    const next = prepareMerge(db);
    const before = memoryRows(db);
    expect(() => mergeRoleMemory(db, { ...next, updates: [snapshot] } as unknown as MergeRoleMemoryInput)).toThrow();
    expect(() => mergeRoleMemory(db, {
      ...next, updates: [{ key: 'valid', text: 'value' }, { key: 'blank', text: ' \n ' }],
    })).toThrow();
    expect(memoryRows(db)).toEqual(before);
  });

  it('replays the same turn/payload without writes, even after later commits, and rejects changed payloads', () => {
    const db = fixture();
    const input = prepareMerge(db);
    const first = mergeRoleMemory(db, input);
    expect(mergeRoleMemory(db, input)).toEqual(first);
    mergeRoleMemory(db, prepareMerge(db, { updates: [{ key: 'next', text: 'next' }] }));
    const before = memoryRows(db);
    expect(mergeRoleMemory(db, input)).toEqual(readRoleMemory(db, scope));
    expect(memoryRows(db)).toEqual(before);
    for (const changed of [
      { ...input, updates: [{ key: 'decision', text: 'different' }] },
      { ...input, taskId: 'another-task' },
      { ...input, baseRevision: 1 },
      { ...input, scope: { ...scope, conversationId: 'room-c2' } },
    ]) expect(() => mergeRoleMemory(db, changed)).toThrow('ROLE_MEMORY_IDEMPOTENCY_CONFLICT');
    expect(memoryRows(db)).toEqual(before);
    const receipt = db.prepare('SELECT payload_hash FROM role_memory_commits WHERE source_turn_id = ?')
      .get(input.turnId) as { payload_hash: string };
    expect(receipt.payload_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('hashes normalized fields independently of object property insertion order', () => {
    const db = fixture();
    const input = prepareMerge(db, { updates: [{ key: ' k ', text: ' v ' }] });
    const snapshot = mergeRoleMemory(db, input);
    expect(mergeRoleMemory(db, {
      updates: [{ text: 'v', key: 'k' }], baseRevision: input.baseRevision, taskId: input.taskId,
      turnId: input.turnId, scope: { conversationId: scope.conversationId, memberId: scope.memberId, projectId: scope.projectId },
    })).toEqual(snapshot);
  });

  it('records empty submissions idempotently without advancing or clearing memory', () => {
    const db = fixture();
    mergeRoleMemory(db, prepareMerge(db));
    const empty = prepareMerge(db, { updates: [] });
    const before = readRoleMemory(db, scope);
    expect(mergeRoleMemory(db, empty)).toEqual(before);
    const rows = memoryRows(db);
    expect(mergeRoleMemory(db, empty)).toEqual(before);
    expect(memoryRows(db)).toEqual(rows);
    expect(() => mergeRoleMemory(db, { ...empty, updates: [{ key: 'new', text: 'new' }] }))
      .toThrow('ROLE_MEMORY_IDEMPOTENCY_CONFLICT');
  });

  it('rejects a forged future base even when the input bundle repeats that forged revision', () => {
    const db = fixture();
    const input = prepareMerge(db, { snapshot: { scope, revision: 42, entries: [] } });
    expect(() => mergeRoleMemory(db, input)).toThrow('ROLE_MEMORY_FUTURE_REVISION');
    expect(memoryRows(db)).toEqual([[], [], []]);
  });

  it('isolates members, projects, rooms, room versus DM, and two DMs for the same member', () => {
    const db = fixture();
    const targets: RoleMemoryScope[] = [scope,
      { ...scope, memberId: 'm2' }, { ...scope, conversationId: 'room-c2' },
      { projectId: 'p2', memberId: 'm3', conversationId: 'room-c3' },
      { ...scope, conversationId: 'dm-c1' }, { ...scope, conversationId: 'dm-c2' },
    ];
    for (const [index, target] of targets.entries()) {
      const input = prepareMerge(db, { scope: target, updates: [{ key: 'private', text: `scope-${index}` }] });
      const snapshot = mergeRoleMemory(db, input);
      expect(snapshot.revision).toBe(1);
      if (target.conversationId.startsWith('dm-')) expect(snapshot.entries[0]!.values[0]!.sourceThreadId).toBeNull();
    }
    for (const [index, target] of targets.entries()) {
      expect(readRoleMemory(db, target).entries[0]!.values.map((value) => value.text)).toEqual([`scope-${index}`]);
    }
    expect(() => readRoleMemory(db, { ...scope, projectId: 'p2' })).toThrow('ROLE_MEMORY_SCOPE_MISMATCH');
    expect(() => readRoleMemory(db, { ...scope, conversationId: 'dm-c1', memberId: 'm2' })).toThrow('ROLE_MEMORY_SCOPE_MISMATCH');
  });

  it.each([
    { ...scope, conversationId: 'room-c2' },
    { ...scope, memberId: 'm2' },
    { projectId: 'p2', memberId: 'm3', conversationId: 'room-c3' },
  ])('rejects a valid but different target scope %j despite a matching forged bundle', (target) => {
    const db = fixture();
    const input = prepareMerge(db, { snapshot: { scope: target, revision: 0, entries: [] } });
    expect(() => mergeRoleMemory(db, { ...input, scope: target })).toThrow('ROLE_MEMORY_TURN_SCOPE_MISMATCH');
    expect(memoryRows(db)).toEqual([[], [], []]);
  });

  it('rejects another task and inconsistent turn/run/task thread or conversation ownership', () => {
    const db = fixture();
    const a = prepareMerge(db);
    const b = prepareMerge(db);
    expect(() => mergeRoleMemory(db, { ...a, taskId: b.taskId })).toThrow('ROLE_MEMORY_TURN_SCOPE_MISMATCH');
    const otherThread = (db.prepare('SELECT thread_id FROM agent_turns WHERE id = ?').get(b.turnId) as { thread_id: string }).thread_id;
    db.prepare('UPDATE agent_turns SET thread_id = ? WHERE id = ?').run(otherThread, a.turnId);
    expect(() => mergeRoleMemory(db, a)).toThrow('ROLE_MEMORY_TURN_SCOPE_MISMATCH');
    db.prepare("UPDATE workflow_runs SET conversation_id = 'room-c2' WHERE task_id = ?").run(b.taskId);
    expect(() => mergeRoleMemory(db, b)).toThrow('ROLE_MEMORY_TURN_SCOPE_MISMATCH');
    expect(memoryRows(db)).toEqual([[], [], []]);
  });

  it.each(['PENDING', 'DISPATCHING', 'RUNNING', 'WAITING_APPROVAL', 'WAITING_INPUT', 'STOPPING', 'FAILED', 'CANCELLED', 'UNKNOWN'])(
    'rejects %s turns without touching memory', (status) => {
      const db = fixture();
      const input = prepareMerge(db, { status });
      expect(() => mergeRoleMemory(db, input)).toThrow('ROLE_MEMORY_TURN_NOT_SUCCEEDED');
      expect(memoryRows(db)).toEqual([[], [], []]);
    });

  it.each([
    "UPDATE tasks SET status = 'CANCELLED' WHERE id = ?",
    'UPDATE tasks SET stop_generation = 1 WHERE id = ?',
    "UPDATE workflow_runs SET status = 'STOPPING' WHERE task_id = ?",
    "UPDATE workflow_runs SET status = 'CANCELLED' WHERE task_id = ?",
    "UPDATE agent_turns SET protection_state = 'retained' WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)",
  ])('rejects cancellation/protection despite a SUCCEEDED turn: %s', (sql) => {
    const db = fixture();
    const input = prepareMerge(db);
    db.prepare(sql).run(input.taskId);
    expect(() => mergeRoleMemory(db, input)).toThrow('ROLE_MEMORY_TURN_CANCELLED_OR_PROTECTED');
    expect(memoryRows(db)).toEqual([[], [], []]);
  });

  it('accepts a new successful turn at the current stop generation, and guards legacy unknown stop snapshots', () => {
    const db = fixture();
    const input = prepareMerge(db);
    db.prepare('UPDATE tasks SET stop_generation = 2 WHERE id = ?').run(input.taskId);
    db.prepare('UPDATE agent_turns SET stop_generation_snapshot = 2 WHERE id = ?').run(input.turnId);
    expect(mergeRoleMemory(db, input).revision).toBe(1);
    const legacy = prepareMerge(db);
    db.prepare('UPDATE tasks SET stop_generation = 1 WHERE id = ?').run(legacy.taskId);
    db.prepare('UPDATE agent_turns SET stop_generation_snapshot = -1 WHERE id = ?').run(legacy.turnId);
    expect(() => mergeRoleMemory(db, legacy)).toThrow('ROLE_MEMORY_TURN_CANCELLED_OR_PROTECTED');
  });

  it.each(['missing', 'invalid-json', 'missing-memory', 'scope', 'revision', 'thread', 'duplicate', 'malformed-snapshot'])(
    'requires the exact formal input memory snapshot: %s', (variant) => {
      const db = fixture();
      const input = prepareMerge(db);
      if (variant === 'missing') db.prepare('DELETE FROM context_bundles WHERE turn_id = ?').run(input.turnId);
      else if (variant === 'thread') db.prepare('UPDATE context_bundles SET thread_id = NULL WHERE turn_id = ?').run(input.turnId);
      else if (variant === 'duplicate') db.prepare(`INSERT INTO context_bundles
        SELECT id || '-duplicate', turn_id, thread_id, task_revision, baseline_id, included_refs_json, scope_grants_json, hash
        FROM context_bundles WHERE turn_id = ?`).run(input.turnId);
      else {
        const memory = { scope: variant === 'scope' ? { ...scope, conversationId: 'room-c2' } : scope,
          revision: variant === 'revision' ? 1 : 0, entries: variant === 'malformed-snapshot' ? 'bad' : [] };
        const json = variant === 'invalid-json' ? '{' : JSON.stringify(variant === 'missing-memory' ? {} : { roleMemory: memory });
        db.prepare('UPDATE context_bundles SET included_refs_json = ? WHERE turn_id = ?').run(json, input.turnId);
      }
      expect(() => mergeRoleMemory(db, input)).toThrow('ROLE_MEMORY_INPUT_SNAPSHOT_MISMATCH');
      expect(memoryRows(db)).toEqual([[], [], []]);
    });

  it('rejects a changed base that is not the actual input revision, even if it is no longer in the future', () => {
    const db = fixture();
    const old = prepareMerge(db);
    mergeRoleMemory(db, prepareMerge(db));
    expect(() => mergeRoleMemory(db, { ...old, baseRevision: 1 })).toThrow('ROLE_MEMORY_INPUT_SNAPSHOT_MISMATCH');
    expect(mergeRoleMemory(db, old).revision).toBe(2);
  });

  it('rolls back receipts, revisions and partial values on SQL failure, allowing a clean retry', () => {
    const db = fixture();
    const input = prepareMerge(db, { updates: [{ key: 'first', text: 'valid' }, { key: 'second', text: 'explode' }] });
    db.exec(`CREATE TEMP TRIGGER abort_memory BEFORE INSERT ON role_memory_values
      WHEN NEW.text = 'explode' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`);
    expect(() => mergeRoleMemory(db, input)).toThrow('injected storage failure');
    expect(memoryRows(db)).toEqual([[], [], []]);
    db.exec('DROP TRIGGER abort_memory');
    expect(mergeRoleMemory(db, input).entries).toHaveLength(2);
  });

  it('composes with the caller terminal transaction and rolls both success and memory back together', () => {
    const db = fixture();
    const input = prepareMerge(db, { status: 'RUNNING' });
    const settle = db.transaction((abort: boolean) => {
      db.prepare("UPDATE agent_turns SET status = 'SUCCEEDED' WHERE id = ?").run(input.turnId);
      mergeRoleMemory(db, input);
      if (abort) throw new Error('terminal rollback');
    });
    expect(() => settle(true)).toThrow('terminal rollback');
    expect(memoryRows(db)).toEqual([[], [], []]);
    expect(db.prepare('SELECT status FROM agent_turns WHERE id = ?').get(input.turnId)).toEqual({ status: 'RUNNING' });
    settle(false);
    expect(readRoleMemory(db, scope).revision).toBe(1);
  });

  it('persists revisions, conflict sources and idempotency across closing and reopening', () => {
    const path = tempDatabasePath();
    const db = fixture(path);
    const a = prepareMerge(db, { updates: [{ key: 'choice', text: 'A' }] });
    const b = prepareMerge(db, { updates: [{ key: 'choice', text: 'B' }] });
    mergeRoleMemory(db, a);
    const expected = mergeRoleMemory(db, b);
    db.close();
    const reopened = openDatabase(path);
    databases.push(reopened);
    expect(readRoleMemory(reopened, scope)).toEqual(expected);
    const before = memoryRows(reopened);
    expect(mergeRoleMemory(reopened, a)).toEqual(expected);
    expect(memoryRows(reopened)).toEqual(before);
  });

  it('migrates a v59 database additively without changing any existing table records', () => {
    const path = tempDatabasePath();
    const legacy = new Database(path);
    databases.push(legacy);
    legacy.pragma('foreign_keys = ON');
    migrate(legacy, {}, MIGRATIONS.filter((migration) => migration.id < 60));
    seed(legacy);
    // Build a historical turn without using the not-yet-existing memory tables.
    prepareMerge(legacy, { snapshot: { scope, revision: 0, entries: [] }, status: 'FAILED' });
    const tables = legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name")
      .all() as Array<{ name: string }>;
    const oldRows = tables.map(({ name }) => legacy.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
    const oldAudit = legacy.prepare('SELECT * FROM schema_migrations ORDER BY id').all();
    legacy.close();
    const upgraded = openDatabase(path);
    databases.push(upgraded);
    expect(upgraded.pragma('user_version', { simple: true })).toBe(60);
    expect(tables.map(({ name }) => upgraded.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())).toEqual(oldRows);
    expect(upgraded.prepare('SELECT * FROM schema_migrations WHERE id < 60 ORDER BY id').all()).toEqual(oldAudit);
    expect(memoryRows(upgraded)).toEqual([[], [], []]);
    expect(readRoleMemory(upgraded, scope)).toEqual({ scope, revision: 0, entries: [] });
    expect(upgraded.pragma('foreign_key_check')).toEqual([]);
  });
});
