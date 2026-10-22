import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { readExecutionBlocker } from '../../src/daemon/taskDetails.ts';
import { DispatchAdmission } from '../../src/daemon/admission.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r99-blocker-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function seedProject(db: ZhongshuoDatabase, projectId: string, roomId: string, conversationId: string, memberIds: string[], canonicalPath: string): void {
  db.prepare(`INSERT INTO projects (id,display_name,root_path,canonical_path,directory_identity,created_at)
    VALUES(?,?,?,?, '{}',0)`).run(projectId, projectId, canonicalPath, canonicalPath);
  for (const memberId of memberIds) {
    db.prepare(`INSERT INTO project_members (id,project_id,display_name,principal_type,enabled)
      VALUES(?,?,?,'agent',1)`).run(memberId, projectId, memberId);
  }
  db.prepare('INSERT INTO rooms (id,project_id,name,coordinator_member_id) VALUES(?,?,?,?)').run(roomId, projectId, roomId, memberIds[0]!);
  db.prepare("INSERT INTO conversations (id,project_id,kind,room_id) VALUES(?,?,'room',?)").run(conversationId, projectId, roomId);
}

function makeTask(db: ZhongshuoDatabase, projectId: string, roomId: string, conversationId: string, memberId: string, n: number): string {
  const taskId = `task_${n}`;
  const created = createRoomRootTask(db, {
    ids: { messageId: `msg_${n}`, threadId: `thread_${n}`, taskId, taskEventId: `evt_task_${n}`, threadEventId: `evt_thread_${n}` },
    projectId, conversationId, roomId, intent: 'default', title: `任务 ${n}`, body: `任务 ${n}`,
    mentions: [{ kind: 'member', memberId }], author: { authorType: 'human', authorId: 'u_local' },
    reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] },
    now: n,
  });
  if (!created.ok) throw new Error(created.error.message);
  return taskId;
}

function insertOccupyingTurn(db: ZhongshuoDatabase, input: {
  runId: string; turnId: string; taskId: string; conversationId: string; threadId: string;
  memberId: string; status: 'UNKNOWN' | 'RUNNING'; protectionState: 'retained' | 'released' | null;
  lockDomain?: string; leaseStatus?: 'active' | 'expired';
}): void {
  db.prepare(`INSERT INTO workflow_runs (id,task_id,conversation_id,thread_id,mode,task_revision,status)
    VALUES(?,?,?,?, 'DIRECT',0,?)`).run(
    input.runId, input.taskId, input.conversationId, input.threadId, input.status === 'UNKNOWN' ? 'INTERRUPTED' : 'RUNNING',
  );
  db.prepare(`INSERT INTO agent_turns
    (id,run_id,conversation_id,thread_id,member_id,stage_key,turn_purpose,status,dispatch_key,attempt,epoch,collab_absence_ms,collab_turn_deadline_ms,collab_config_revision,stop_generation_snapshot,protection_state)
    VALUES(?,?,?,?,?, 'direct.work','stage_work',?,?,1,1,1200000,0,0,0,?)`).run(
    input.turnId, input.runId, input.conversationId, input.threadId, input.memberId,
    input.status, `${input.runId}:dispatch`, input.protectionState,
  );
  if (input.lockDomain != null) {
    db.prepare(`INSERT INTO workspace_leases (lock_domain,owner_turn_id,epoch,heartbeat_at,status)
      VALUES(?,?,1,?,?)`).run(input.lockDomain, input.turnId, Date.now(), input.leaseStatus ?? 'active');
  }
}

describe('R99 execution blocker truth projection', () => {
  it('released UNKNOWN and unrelated read-only UNKNOWN do not block pending work', () => {
    const db = openDatabase(':memory:');
    const shared = join(root, 'same');
    mkdirSync(shared, { recursive: true });
    seedProject(db, 'p1', 'r1', 'c1', ['m1', 'm2'], shared);
    const holder = makeTask(db, 'p1', 'r1', 'c1', 'm1', 1);
    const waiter = makeTask(db, 'p1', 'r1', 'c1', 'm1', 2);
    insertOccupyingTurn(db, {
      runId: 'run_released', turnId: 'turn_released', taskId: holder,
      conversationId: 'c1', threadId: 'thread_1', memberId: 'm1',
      status: 'UNKNOWN', protectionState: 'released',
    });
    expect(readExecutionBlocker(db, waiter)).toMatchObject({ reason: 'queued' });

    db.prepare(`UPDATE tasks SET owner_member_id='m2' WHERE id=?`).run(waiter);
    db.prepare(`UPDATE outbox SET dispatch_key=? WHERE dispatch_key LIKE 'task:' || ? || ':%'`).run(`task:${waiter}:initial`, waiter);
    insertOccupyingTurn(db, {
      runId: 'run_unrelated', turnId: 'turn_unrelated', taskId: holder,
      conversationId: 'c1', threadId: 'thread_1', memberId: 'm1',
      status: 'UNKNOWN', protectionState: null,
    });
    expect(readExecutionBlocker(db, waiter)).toMatchObject({ reason: 'queued' });
    db.close();
  });

  it('same-member protected UNKNOWN reports the exact holder and turn', () => {
    const db = openDatabase(':memory:');
    const shared = join(root, 'member');
    mkdirSync(shared, { recursive: true });
    seedProject(db, 'p1', 'r1', 'c1', ['m1', 'm2'], shared);
    const holder = makeTask(db, 'p1', 'r1', 'c1', 'm1', 3);
    const waiter = makeTask(db, 'p1', 'r1', 'c1', 'm1', 4);
    insertOccupyingTurn(db, {
      runId: 'run_unknown', turnId: 'turn_unknown', taskId: holder,
      conversationId: 'c1', threadId: 'thread_3', memberId: 'm1',
      status: 'UNKNOWN', protectionState: 'retained',
    });
    expect(readExecutionBlocker(db, waiter)).toMatchObject({
      reason: 'unknown-turn', blockingTaskId: holder, blockingTurnId: 'turn_unknown',
      blockingMemberId: 'm1', protectionState: 'retained',
    });
    db.close();
  });

  it('cross-project overlapping write occupancy is identified; unrelated UNKNOWN still never over-claims', () => {
    const db = openDatabase(':memory:');
    const shared = join(root, 'physical-shared');
    const other = join(root, 'other');
    mkdirSync(shared, { recursive: true });
    mkdirSync(other, { recursive: true });
    seedProject(db, 'p1', 'r1', 'c1', ['m1'], shared);
    seedProject(db, 'p2', 'r2', 'c2', ['m2'], shared);
    const waiter = makeTask(db, 'p1', 'r1', 'c1', 'm1', 5);
    db.prepare(`UPDATE tasks SET write_scope_json=? WHERE id=?`).run(JSON.stringify({ executionMode: 'full' }), waiter);
    const holder = makeTask(db, 'p2', 'r2', 'c2', 'm2', 6);
    insertOccupyingTurn(db, {
      runId: 'run_cross_unknown', turnId: 'turn_cross_unknown', taskId: holder,
      conversationId: 'c2', threadId: 'thread_6', memberId: 'm2',
      status: 'UNKNOWN', protectionState: 'retained', lockDomain: shared,
    });
    expect(readExecutionBlocker(db, waiter)).toMatchObject({
      reason: 'unknown-turn', blockingTaskId: holder, blockingMemberId: 'm2', writeRootKey: shared,
    });

    db.prepare("UPDATE agent_turns SET status='RUNNING',protection_state=NULL WHERE id='turn_cross_unknown'").run();
    db.prepare("UPDATE workflow_runs SET status='RUNNING' WHERE id='run_cross_unknown'").run();
    expect(readExecutionBlocker(db, waiter)).toMatchObject({
      reason: 'write-root-occupied', blockingTaskId: holder, blockingTurnId: 'turn_cross_unknown',
    });
    db.close();
  });

  it('mixed Codex/Claude work in one directory is admitted by one write-root slot and becomes eligible after release', () => {
    const admission = new DispatchAdmission({ globalMaxInFlight: 4, perProjectMaxInFlight: 4, perProviderMaxInFlight: 4 });
    const rootKey = join(root, 'mixed-runtime-shared');
    expect(admission.tryAcquire('turn_codex_long', {
      memberId: 'm_codex', projectId: 'p_mixed', providerKey: 'codex', writeRootKey: rootKey,
    })).toEqual({ granted: true });
    expect(admission.tryAcquire('turn_claude_cross_review', {
      memberId: 'm_claude', projectId: 'p_mixed', providerKey: 'claude', writeRootKey: rootKey,
    })).toEqual({ granted: false, reason: 'write-root' });
    admission.release('turn_codex_long');
    expect(admission.tryAcquire('turn_claude_cross_review', {
      memberId: 'm_claude', projectId: 'p_mixed', providerKey: 'claude', writeRootKey: rootKey,
    })).toEqual({ granted: true });
  });

  it('worker restart restores retained UNKNOWN occupancy but not released UNKNOWN', () => {
    const db = openDatabase(':memory:');
    const shared = join(root, 'restore');
    mkdirSync(shared, { recursive: true });
    seedProject(db, 'p1', 'r1', 'c1', ['m1'], shared);
    const holder = makeTask(db, 'p1', 'r1', 'c1', 'm1', 7);
    insertOccupyingTurn(db, {
      runId: 'run_restore', turnId: 'turn_restore', taskId: holder,
      conversationId: 'c1', threadId: 'thread_7', memberId: 'm1',
      status: 'UNKNOWN', protectionState: 'released',
    });
    const releasedAdmission = new DispatchAdmission();
    new DispatchWorker({
      db, adapter: new FakeRuntimeAdapter(), admission: releasedAdmission,
      leaseOwner: 'w-restore-released', appDataDir: join(root, 'restore-app-a'),
    });
    expect(releasedAdmission.has('turn_restore')).toBe(false);

    db.prepare("UPDATE agent_turns SET protection_state='retained' WHERE id='turn_restore'").run();
    const retainedAdmission = new DispatchAdmission();
    new DispatchWorker({
      db, adapter: new FakeRuntimeAdapter(), admission: retainedAdmission,
      leaseOwner: 'w-restore-retained', appDataDir: join(root, 'restore-app-b'),
    });
    expect(retainedAdmission.has('turn_restore')).toBe(true);
    db.close();
  });

  it('non-close cleanup errors preserve admission instead of pretending the slot is free', () => {
    const db = openDatabase(':memory:');
    const shared = join(root, 'cleanup-failure');
    mkdirSync(shared, { recursive: true });
    seedProject(db, 'p1', 'r1', 'c1', ['m1'], shared);
    const holder = makeTask(db, 'p1', 'r1', 'c1', 'm1', 8);
    insertOccupyingTurn(db, {
      runId: 'run_cleanup', turnId: 'turn_cleanup', taskId: holder,
      conversationId: 'c1', threadId: 'thread_8', memberId: 'm1',
      status: 'RUNNING', protectionState: null,
    });
    const admission = new DispatchAdmission();
    admission.tryAcquire('turn_cleanup', { memberId: 'm1', projectId: 'p1', providerKey: 'fake', writeRootKey: shared });
    const worker = new DispatchWorker({
      db, adapter: new FakeRuntimeAdapter(), admission, leaseOwner: 'w-cleanup-failure',
      appDataDir: join(root, 'cleanup-app'),
    });
    const internals = worker as unknown as {
      kvGet: (key: string) => string | null;
      releaseAdmission: (turnId: string) => void;
    };
    const original = internals.kvGet.bind(worker);
    internals.kvGet = (key: string) => {
      if (key.startsWith('write-changeset:')) throw new Error('synthetic cleanup failure');
      return original(key);
    };
    expect(() => internals.releaseAdmission('turn_cleanup')).toThrow(/synthetic cleanup failure/);
    expect(admission.has('turn_cleanup')).toBe(true);
    internals.kvGet = original;
    internals.releaseAdmission('turn_cleanup');
    expect(admission.has('turn_cleanup')).toBe(false);
    db.close();
  });
});
