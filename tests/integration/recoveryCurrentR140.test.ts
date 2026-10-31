import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { holdDispatchGate } from '../../src/persistence/daemonState.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';

type TaskStatus = 'ACTIVE' | 'BLOCKED' | 'DONE' | 'CANCELLED';
type RunStatus = 'INTERRUPTED' | 'SUCCEEDED' | 'RUNNING' | 'FAILED';

interface RecoveryStatus {
  gateHeld: boolean;
  pendingDispatchCount: number;
  pendingDispatchKeys: string[];
  interruptedRuns: Array<{ id: string; task_id: string; status: string }>;
  unknownTurns: Array<{ id: string; runId: string; taskId: string; status: string; protectionReleased: boolean }>;
  pendingRelease: Array<{ turnId: string; budgetMark: string | null; turnStatus: string; protectionState: string; leaseCount: number }>;
  activeUndos: Array<{ id: string; changeSetId: string; status: string }>;
  heldLeases: Array<{ lock_domain: string; owner_turn_id: string; status: string }>;
  stopRecord: { phase: string; drainPending: boolean } | null;
}

const fixtures: Array<{ close: () => void; root: string }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try { fixture.close(); }
    finally { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  }
});

/** Migrated, isolated SQLite fixtures. Only recovery.status crosses the formal
 * daemon command boundary; no worker, runtime or real application data is used. */
function fixture(onDisk = false) {
  const root = mkdtempSync(join(tmpdir(), 'zs-r140-recovery-'));
  const file = join(root, 'state.sqlite');
  let db = openDatabase(onDisk ? file : ':memory:');
  fixtures.push({ root, close: () => { if (db.open) db.close(); } });
  db.prepare(`INSERT INTO projects(id, display_name, root_path, canonical_path, directory_identity, created_at)
    VALUES('p', 'R140 fixture', ?, ?, '{}', 0)`).run(root, root);
  db.exec(`INSERT INTO project_members(id, project_id, display_name, principal_type)
      VALUES('m', 'p', 'Fixture member', 'agent');
    INSERT INTO rooms(id, project_id, name, coordinator_member_id) VALUES('room', 'p', 'Fixture room', 'm');
    INSERT INTO conversations(id, project_id, kind, room_id) VALUES('conv', 'p', 'room', 'room');
    INSERT INTO room_members(room_id, member_id) VALUES('room', 'm');`);
  let taskSeq = 0;
  let runSeq = 0;
  let turnSeq = 0;
  const task = (status: TaskStatus) => {
    const id = `task-${++taskSeq}`;
    const threadId = `thread-${id}`;
    createRoomRootTask(db, {
      ids: { taskId: id, threadId, messageId: `message-${id}`, taskEventId: `event-${id}`, threadEventId: `event-${threadId}` },
      projectId: 'p', conversationId: 'conv', roomId: 'room', intent: 'default',
      title: id, body: 'Isolated R140 recovery fixture', mentions: [{ kind: 'member', memberId: 'm' }],
      author: { authorType: 'human', authorId: 'u' }, reviewPolicy: 'auto_deliver', sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'm', frozenMemberIds: ['m'], initialWakeMemberIds: ['m'] },
      now: 100,
    });
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
    return id;
  };
  const run = (taskId: string, status: RunStatus, id = `run-${++runSeq}`) => {
    // Equal revision/stage clocks deliberately require latest-by-rowid selection.
    db.prepare(`INSERT INTO workflow_runs(id, task_id, conversation_id, thread_id, mode, status,
      task_revision, revision, stage_started_at, budget_json)
      VALUES(?, ?, 'conv', ?, 'DIRECT', ?, 0, 0, 100, ?)`)
      .run(id, taskId, `thread-${taskId}`, status, JSON.stringify({ runMaxTurns: 6, usedTurns: 1, inFlightReservedTurns: 0 }));
    return id;
  };
  const turn = (taskId: string, runId: string, status: 'UNKNOWN' | 'FAILED', protection: 'retained' | null = null) => {
    const id = `turn-${runId}-${status}`;
    db.prepare(`INSERT INTO agent_turns(id, run_id, conversation_id, thread_id, member_id, stage_key,
      status, dispatch_key, budget_mark, protection_state, attempt)
      VALUES(?, ?, 'conv', ?, 'm', 'direct.work', ?, ?, ?, ?, ?)`)
      .run(id, runId, `thread-${taskId}`, status, `dispatch-${id}`, status === 'FAILED' ? 'refunded' : null, protection, ++turnSeq);
    return id;
  };
  const undo = (taskId: string, status: 'in_progress' | 'failed' | 'succeeded' | 'conflict') => {
    const id = `undo-${taskId}-${status}`;
    const changeSetId = `changeset-${id}`;
    db.prepare(`INSERT INTO change_sets(id, project_id, task_id, before_ref, after_ref, application_status)
      VALUES(?, 'p', ?, '{}', '{}', 'applied')`).run(changeSetId, taskId);
    db.prepare(`INSERT INTO change_set_undos(id, change_set_id, status, steps_json, created_at, updated_at)
      VALUES(?, ?, ?, '[]', 100, 100)`).run(id, changeSetId, status);
    return { id, changeSetId, status };
  };
  const interruptTurn = vi.fn(async () => {});
  const releaseAdmission = vi.fn();
  const processQuery = vi.fn(() => { throw new Error('recovery.status must not probe a process'); });
  const status = async (commandId = randomUUID()): Promise<RecoveryStatus> => {
    const result = await dispatchDaemonCommand(
      { db, localUserId: 'u', appDataDir: root, interruptTurn, releaseAdmission, processQuery },
      { protocolVersion: 1, commandId, method: 'recovery.status', params: {} },
    ) as { ok: boolean; commandId: string; data: RecoveryStatus; error?: unknown };
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    expect(result.commandId).toBe(commandId);
    return result.data;
  };
  return {
    get db() { return db; }, root, file, task, run, turn, undo, status,
    interruptTurn, releaseAdmission, processQuery,
    reopenReadonly() {
      db.close();
      db = new Database(file, { readonly: true, fileMustExist: true });
    },
  };
}

function snapshot(db: ZhongshuoDatabase) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  return Object.fromEntries(tables.map(({ name }) => [name,
    db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all(),
  ]));
}

describe('R140 recovery.status reports the current interrupted run of unfinished tasks', () => {
  it.each(['ACTIVE', 'BLOCKED'] as const)('keeps the latest INTERRUPTED run of an %s task', async taskStatus => {
    const f = fixture();
    const taskId = f.task(taskStatus);
    f.run(taskId, 'FAILED');
    const id = f.run(taskId, 'INTERRUPTED');
    expect((await f.status()).interruptedRuns).toEqual([{ id, task_id: taskId, status: 'INTERRUPTED' }]);
  });

  it.each(['ACTIVE', 'BLOCKED', 'DONE'] as const)('hides an old interruption after a newer SUCCEEDED run when task status is %s', async taskStatus => {
    const f = fixture();
    const taskId = f.task(taskStatus);
    f.run(taskId, 'INTERRUPTED', 'z-old-interrupted');
    f.run(taskId, 'SUCCEEDED', 'a-new-succeeded');
    expect((await f.status()).interruptedRuns).toEqual([]);
  });

  it.each(['DONE', 'CANCELLED'] as const)('hides even the latest INTERRUPTED run of a %s task', async taskStatus => {
    const f = fixture();
    const taskId = f.task(taskStatus);
    f.run(taskId, 'INTERRUPTED');
    expect((await f.status()).interruptedRuns).toEqual([]);
  });

  it.each(['RUNNING', 'FAILED'] as const)('does not resurrect a historical interruption after the latest run becomes %s', async runStatus => {
    const f = fixture();
    const taskId = f.task('ACTIVE');
    f.run(taskId, 'INTERRUPTED');
    f.run(taskId, runStatus);
    expect((await f.status()).interruptedRuns).toEqual([]);
  });

  it('selects one latest rowid per task with tied clocks/revisions, interleaved tasks and reverse lexical IDs', async () => {
    const f = fixture();
    const firstTask = f.task('ACTIVE');
    const secondTask = f.task('BLOCKED');
    const hiddenTask = f.task('ACTIVE');
    f.run(firstTask, 'INTERRUPTED', 'z-old-first');
    f.run(secondTask, 'INTERRUPTED', 'z-old-second');
    f.run(hiddenTask, 'INTERRUPTED', 'z-old-hidden');
    f.run(firstTask, 'INTERRUPTED', 'm-middle-first');
    f.run(secondTask, 'INTERRUPTED', 'a-current-second');
    f.run(hiddenTask, 'SUCCEEDED', 'a-current-hidden');
    f.run(firstTask, 'INTERRUPTED', 'a-current-first');
    const expected = [
      { id: 'a-current-first', task_id: firstTask, status: 'INTERRUPTED' },
      { id: 'a-current-second', task_id: secondTask, status: 'INTERRUPTED' },
    ];
    const current = () => f.status().then(result => result.interruptedRuns.sort((a, b) => a.task_id.localeCompare(b.task_id)));
    expect(await current()).toEqual(expected);
    // Touching a historical row must not make it the current run.
    f.db.prepare("UPDATE workflow_runs SET revision = 99, stage_started_at = 999 WHERE id = 'z-old-first'").run();
    expect(await current()).toEqual(expected);
  });

  it('refreshes the current task/run state on repeated reads, including the same command ID', async () => {
    const f = fixture();
    const taskId = f.task('ACTIVE');
    const interrupted = f.run(taskId, 'INTERRUPTED');
    const commandId = randomUUID();
    expect((await f.status(commandId)).interruptedRuns).toEqual([{ id: interrupted, task_id: taskId, status: 'INTERRUPTED' }]);
    f.run(taskId, 'SUCCEEDED');
    expect((await f.status(commandId)).interruptedRuns).toEqual([]);
    const latest = f.run(taskId, 'INTERRUPTED');
    expect((await f.status(commandId)).interruptedRuns).toEqual([{ id: latest, task_id: taskId, status: 'INTERRUPTED' }]);
    f.db.prepare("UPDATE tasks SET status = 'DONE' WHERE id = ?").run(taskId);
    expect((await f.status(commandId)).interruptedRuns).toEqual([]);
    expect(f.db.prepare('SELECT count(*) n FROM command_receipts').get()).toEqual({ n: 0 });
  });
});

describe('R140 interruption filtering leaves independent recovery facts visible', () => {
  it.each(['DONE', 'CANCELLED'] as const)('retains UNKNOWN, leases and lease-free retained protection on a %s task after a newer success', async taskStatus => {
    const f = fixture();
    const taskId = f.task(taskStatus);
    const oldRun = f.run(taskId, 'INTERRUPTED');
    const unknown = f.turn(taskId, oldRun, 'UNKNOWN');
    const retained = f.turn(taskId, oldRun, 'FAILED', 'retained');
    f.run(taskId, 'SUCCEEDED');
    f.db.prepare(`INSERT INTO workspace_leases(lock_domain, owner_turn_id, epoch, heartbeat_at, status)
      VALUES(?, ?, 1, 100, 'expired')`).run(f.root, unknown);
    const before = snapshot(f.db);
    const result = await f.status();
    expect(result.unknownTurns).toEqual([{ id: unknown, runId: oldRun, taskId, stageKey: 'direct.work', status: 'UNKNOWN', protectionReleased: false }]);
    expect(result.pendingRelease).toEqual([{ turnId: retained, budgetMark: 'refunded', turnStatus: 'FAILED', protectionState: 'retained', leaseCount: 0, lastProbeResult: null }]);
    expect(result.heldLeases).toEqual([{ lock_domain: f.root, owner_turn_id: unknown, status: 'expired', heartbeat_at: 100 }]);
    expect(snapshot(f.db)).toEqual(before);
    expect(result.interruptedRuns).toEqual([]);
  });

  it.each(['DONE', 'CANCELLED'] as const)('keeps active/failed undo, the held gate, pending dispatch and stop facts with only a %s task', async taskStatus => {
    const f = fixture();
    const taskId = f.task(taskStatus);
    f.run(taskId, 'INTERRUPTED');
    const active = f.undo(taskId, 'in_progress');
    const failed = f.undo(taskId, 'failed');
    f.undo(taskId, 'succeeded');
    f.undo(taskId, 'conflict');
    holdDispatchGate(f.db, 100);
    const stopRecord = { at: 100, phase: 'incomplete', drainPending: true, reason: 'isolated fixture' };
    f.db.prepare("INSERT INTO daemon_state(key, value, updated_at) VALUES('daemon:stop:last', ?, 100)").run(JSON.stringify(stopRecord));
    const pending = f.db.prepare("SELECT dispatch_key FROM outbox WHERE status = 'pending' ORDER BY dispatch_key").all() as Array<{ dispatch_key: string }>;
    expect(pending.length).toBeGreaterThan(0);
    const before = snapshot(f.db);
    const result = await f.status();
    expect(result.unknownTurns).toEqual([]);
    expect(result.pendingRelease).toEqual([]);
    expect(result.activeUndos).toHaveLength(2);
    expect(result.activeUndos).toEqual(expect.arrayContaining([active, failed]));
    expect(result.gateHeld).toBe(true);
    expect(result.pendingDispatchCount).toBe(pending.length);
    expect(result.pendingDispatchKeys.sort()).toEqual(pending.map(row => row.dispatch_key));
    expect(result.stopRecord).toEqual(stopRecord);
    expect(snapshot(f.db)).toEqual(before);
    expect(result.interruptedRuns).toEqual([]);
  });

  it('reopens a fixture database read-only and reports current interruptions and completed-task protections without mutation', async () => {
    const f = fixture(true);
    const active = f.task('BLOCKED');
    const activeRun = f.run(active, 'INTERRUPTED');
    const done = f.task('DONE');
    const oldRun = f.run(done, 'INTERRUPTED');
    const unknown = f.turn(done, oldRun, 'UNKNOWN');
    const retained = f.turn(done, oldRun, 'FAILED', 'retained');
    f.run(done, 'SUCCEEDED');
    const activeUndo = f.undo(done, 'in_progress');
    holdDispatchGate(f.db, 100);
    const before = snapshot(f.db);
    f.reopenReadonly();
    expect(f.db.readonly).toBe(true);
    const hash = () => createHash('sha256').update(readFileSync(f.file)).digest('hex');
    const beforeHash = hash();
    const changes = f.db.prepare('SELECT total_changes() n').get();
    const first = await f.status();
    expect(await f.status()).toEqual(first);
    expect(snapshot(f.db)).toEqual(before);
    expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(changes);
    expect(hash()).toBe(beforeHash);
    expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({ n: 0 });
    expect(f.interruptTurn).not.toHaveBeenCalled();
    expect(f.releaseAdmission).not.toHaveBeenCalled();
    expect(f.processQuery).not.toHaveBeenCalled();
    expect(first.unknownTurns).toEqual([expect.objectContaining({ id: unknown, taskId: done, protectionReleased: false })]);
    expect(first.pendingRelease).toEqual([expect.objectContaining({ turnId: retained, leaseCount: 0 })]);
    expect(first.activeUndos).toEqual([activeUndo]);
    expect(first.gateHeld).toBe(true);
    expect(first.interruptedRuns).toEqual([{ id: activeRun, task_id: active, status: 'INTERRUPTED' }]);
  });
});
