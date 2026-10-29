import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { pendingAutomaticRecovery } from '../../src/daemon/automaticRecovery.ts';
import {
  ackTaskNotification,
  claimTaskNotification,
  pollTaskNotifications,
} from '../../src/daemon/taskNotifications.ts';

const VIEWER = 'u_local';
const scratch: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows delayed handles */ }
  }
});

function seedRoom(db: ZhongshuoDatabase, muted = false): void {
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1', '项目', 'D:\\p', 'D:\\p', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
     VALUES (?, 'p1', '我', 'human', 1), ('a1', 'p1', 'AI', 'agent', 1)`,
  ).run(VIEWER);
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, coordinator_member_id)
     VALUES ('r1', 'p1', '房间', 'a1')`,
  ).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1', ?), ('r1', 'a1')`).run(VIEWER);
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, room_id, title)
     VALUES ('c1', 'p1', 'room', 'r1', '房间会话')`,
  ).run();
  db.prepare(
    `INSERT INTO messages
       (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at)
     VALUES ('m_root', 'p1', 'c1', 1, 'r1', 'human', ?, '{"text":"任务"}', 'final', 0)`,
  ).run(VIEWER);
  db.prepare(
    `INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id, root_task_id)
     VALUES ('th1', 'p1', 'c1', 'r1', 'm_root', 'task1')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, project_id, conversation_id, kind, room_id, conversation_thread_id, root_message_id,
        room_task_number, owner_member_id, title, status, revision, review_policy)
     VALUES ('task1', 'p1', 'c1', 'room_task', 'r1', 'th1', 'm_root', 1, 'a1',
             '实现通知链路', 'ACTIVE', 0, 'user_review')`,
  ).run();
  db.prepare(
    `INSERT INTO thread_subscriptions (thread_id, viewer_id, followed, muted)
     VALUES ('th1', ?, 1, ?)`,
  ).run(VIEWER, muted ? 1 : 0);
}

function seedDm(db: ZhongshuoDatabase): void {
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1', '项目', 'D:\\p', 'D:\\p', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
     VALUES (?, 'p1', '我', 'human', 1), ('a1', 'p1', 'AI', 'agent', 1)`,
  ).run(VIEWER);
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, title)
     VALUES ('dm1', 'p1', 'dm', '与 AI 私信')`,
  ).run();
  db.prepare(
    `INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id)
     VALUES ('p1', 'dm1', 'human', ?), ('p1', 'dm1', 'agent', 'a1')`,
  ).run(VIEWER);
  db.prepare(
    `INSERT INTO tasks
       (id, project_id, conversation_id, kind, owner_member_id, title, status, revision, review_policy)
     VALUES ('dm_task1', 'p1', 'dm1', 'dm_turn', 'a1', '私信任务', 'ACTIVE', 0, 'auto_deliver')`,
  ).run();
}

function setTaskStatus(db: ZhongshuoDatabase, taskId: string, status: string, revision: number): void {
  db.prepare('UPDATE tasks SET status = ?, revision = ? WHERE id = ?').run(status, revision, taskId);
}

function appendStatus(
  db: ZhongshuoDatabase,
  input: {
    eventId: string;
    projectId?: string;
    conversationId?: string;
    threadId?: string | null;
    taskId: string;
    status: string;
    createdAt?: number;
  },
): number {
  const result = db.prepare(
    `INSERT INTO domain_events
       (event_id, schema_version, project_id, conversation_id, thread_id, task_id, kind, payload_json, created_at)
     VALUES (?, 1, ?, ?, ?, ?, 'task.statusChanged', ?, ?)`,
  ).run(
    input.eventId,
    input.projectId ?? 'p1',
    input.conversationId ?? 'c1',
    input.threadId === undefined ? 'th1' : input.threadId,
    input.taskId,
    JSON.stringify({ status: input.status, reason: input.status === 'BLOCKED' ? '需要补充有效授权配置' : undefined }),
    input.createdAt ?? 100,
  );
  return Number(result.lastInsertRowid);
}

function failureScript(
  message = '503 upstream temporarily unavailable',
  code = 'PROVIDER_ERROR',
): FakeTurnScript {
  return [{ kind: 'event', event: { kind: 'turn.failed', code, message, retryable: false } }];
}

function appendExecutionFailure(
  db: ZhongshuoDatabase,
  input: {
    eventId: string;
    projectId: string;
    taskId: string;
    runId: string;
    turnId: string;
    conversationId: string;
    threadId?: string | null;
    kind?: 'turn.statusChanged' | 'turn.outputInvalid';
    payload?: Record<string, unknown>;
    createdAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO domain_events
       (event_id, schema_version, project_id, conversation_id, thread_id, task_id,
        run_id, turn_id, kind, payload_json, created_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.eventId,
    input.projectId,
    input.conversationId,
    input.threadId ?? null,
    input.taskId,
    input.runId,
    input.turnId,
    input.kind ?? 'turn.statusChanged',
    JSON.stringify(input.payload ?? {
      status: 'FAILED',
      code: 'PROVIDER_ERROR',
      message: '同轮重复失败证据',
    }),
    input.createdAt ?? 2_000,
  );
}

async function workerFixture(options: {
  scripts: FakeTurnScript[];
  automaticRecovery?: boolean;
  structuredFinal?: boolean;
  dm?: boolean;
}): Promise<{
  db: ZhongshuoDatabase;
  worker: DispatchWorker;
  taskId: string;
  projectId: string;
  conversationId: string;
  roomId: string | null;
  command: <T>(method: string, params: unknown) => Promise<T>;
  close: () => Promise<void>;
}> {
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  vi.stubEnv('ZS_RUNTIME', 'fake');
  const dir = mkdtempSync(join(tmpdir(), 'zs-task-notification-worker-r108-'));
  scratch.push(dir);
  const projectDir = join(dir, 'project');
  mkdirSync(projectDir);
  const db = openDatabase(join(dir, 'state.sqlite'));
  const now = 100_000;
  let scriptIndex = 0;
  const adapter = new FakeRuntimeAdapter({
    structuredFinal: options.structuredFinal ?? true,
    turnScriptSequencer: () => options.scripts[Math.min(scriptIndex++, options.scripts.length - 1)]!,
  });
  const worker = new DispatchWorker({
    db,
    adapter,
    leaseOwner: 'r108-notification-worker',
    appDataDir: dir,
    automaticRecovery: options.automaticRecovery ?? false,
    clock: () => now,
    turnDeadlineMs: 0,
  });
  const command = async <T>(method: string, params: unknown): Promise<T> => {
    const result = await dispatchDaemonCommand(
      { db, localUserId: VIEWER, appDataDir: dir, interruptTurn: (id) => worker.interruptTurn(id) },
      { protocolVersion: 1, commandId: randomUUID(), method, params },
    ) as { ok: boolean; data: T; error: unknown };
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.data;
  };

  const projectId = (await command<{ project: { id: string } }>(
    'project.open',
    { path: projectDir },
  )).project.id;
  const room = (await command<{ items: Array<{ id: string; conversationId: string }> }>(
    'room.list',
    { projectId },
  )).items[0]!;
  const memberId = (await command<{ memberId: string }>(
    'member.create',
    { projectId, displayName: '执行成员' },
  )).memberId;
  await command('member.setRuntime', {
    memberId,
    kind: 'fake',
    permissionMode: 'bypassPermissions',
  });
  const roomRevision = (db.prepare('SELECT revision FROM rooms WHERE id = ?').get(room.id) as {
    revision: number;
  }).revision;
  await command('room.update', {
    roomId: room.id,
    expectedRevision: roomRevision,
    coordinatorMemberId: memberId,
  });

  let taskId: string;
  let conversationId: string;
  let roomId: string | null = room.id;
  if (options.dm === true) {
    conversationId = (await command<{ conversationId: string }>(
      'conversation.create',
      { projectId, peerMemberId: memberId },
    )).conversationId;
    roomId = null;
    taskId = (await command<{ taskId: string }>(
      'message.submit',
      {
        target: { kind: 'dm', projectId, conversationId },
        body: '请处理这条私信',
        intent: 'default',
        mentions: [],
      },
    )).taskId;
  } else {
    conversationId = room.conversationId;
    taskId = (await command<{ taskId: string }>(
      'message.submit',
      {
        target: {
          kind: 'room_root',
          projectId,
          roomId: room.id,
          conversationId,
        },
        body: '请处理这个根任务',
        intent: 'default',
        mentions: [{ kind: 'member', memberId }],
      },
    )).taskId;
  }

  // Establish the durable high-water mark before the worker records the run.
  pollTaskNotifications(db, VIEWER, { limit: 20 }, now);
  return {
    db,
    worker,
    taskId,
    projectId,
    conversationId,
    roomId,
    command,
    close: async () => {
      await adapter.closeAllSessions();
      db.close();
    },
  };
}

describe('R108 durable desktop task notifications', () => {
  it('starts at the current event high-water mark and never backfills old completions', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    appendStatus(db, { eventId: 'old-done', taskId: 'task1', status: 'DONE' });

    expect(pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000).items).toEqual([]);
    setTaskStatus(db, 'task1', 'REVIEW', 1);
    appendStatus(db, { eventId: 'new-review', taskId: 'task1', status: 'REVIEW', createdAt: 2_000 });

    const pending = pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_000);
    expect(pending.items).toHaveLength(1);
    const claimed = claimTaskNotification(db, VIEWER, pending.items[0], 2_000);
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) throw new Error('notification claim failed');
    expect(claimed.notification).toMatchObject({
      kind: 'task.needs_review',
      title: '众说 · 交付待验收',
      body: '「实现通知链路」已有交付，等待你验收。',
      locator: { taskId: 'task1', threadId: 'th1', hash: '#task=task1' },
    });
    expect(ackTaskNotification(db, VIEWER, {
      notificationId: claimed.notification.notificationId,
      stage: 'show_requested',
    }, 2_100).state).toBe('show_requested');
    expect(ackTaskNotification(db, VIEWER, {
      notificationId: claimed.notification.notificationId,
      stage: 'shown',
    }, 2_150).state).toBe('shown');
    expect(ackTaskNotification(db, VIEWER, {
      notificationId: claimed.notification.notificationId,
      stage: 'clicked',
    }, 2_175).attempt.clickedAt).toBe(2_175);
    expect(pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_200).items).toEqual([]);
    db.close();
  });

  it('persists native failure separately from shown and requested timestamps', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);
    setTaskStatus(db, 'task1', 'DONE', 1);
    appendStatus(db, { eventId: 'native-failed', taskId: 'task1', status: 'DONE', createdAt: 2_000 });
    const pending = pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_000);
    const claimed = claimTaskNotification(db, VIEWER, pending.items[0], 2_100);
    if (!claimed.claimed) throw new Error('claim failed');
    ackTaskNotification(db, VIEWER, {
      notificationId: claimed.notification.notificationId,
      stage: 'show_requested',
    }, 2_200);
    const failed = ackTaskNotification(db, VIEWER, {
      notificationId: claimed.notification.notificationId,
      stage: 'failed',
      error: 'native failure',
    }, 2_300);
    expect(failed.state).toBe('failed');
    expect(failed.attempt).toMatchObject({
      showRequestedAt: 2_200,
      shownAt: null,
      failedAt: 2_300,
      failureReason: 'native failure',
      clickedAt: null,
    });
    expect(pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_400).health).toMatchObject({
      attempted: 1,
      showRequested: 1,
      failed: 1,
      shown: 0,
      clicked: 0,
    });
    db.close();
  });

  it('derives a viewer-scoped notification ID so one source event can be delivered independently', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);
    pollTaskNotifications(db, 'u_second_viewer', { limit: 10 }, 1_000);
    setTaskStatus(db, 'task1', 'DONE', 1);
    appendStatus(db, { eventId: 'multi-viewer-done', taskId: 'task1', status: 'DONE', createdAt: 2_000 });

    const primary = pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_000);
    const secondary = pollTaskNotifications(db, 'u_second_viewer', { limit: 10 }, 2_000);
    expect(primary.items).toHaveLength(1);
    expect(secondary.items).toHaveLength(1);
    expect(primary.items[0]?.notificationId).not.toBe(secondary.items[0]?.notificationId);
    expect(claimTaskNotification(db, VIEWER, primary.items[0], 2_100).claimed).toBe(true);
    expect(claimTaskNotification(db, 'u_second_viewer', secondary.items[0], 2_100).claimed).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM task_notifications').get()).toEqual({ n: 2 });
    db.close();
  });

  it('advances the event cursor only across fully processed batches and resumes at the next poll', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);
    const insertNoise = db.prepare(
      `INSERT INTO domain_events
         (event_id, schema_version, project_id, conversation_id, thread_id, task_id, kind, payload_json, created_at)
       VALUES (?, 1, 'p1', 'c1', 'th1', 'task1', 'tool.started', '{"toolName":"Read"}', ?)`,
    );
    for (let index = 0; index < 499; index += 1) insertNoise.run(`noise-${index}`, 2_000 + index);
    setTaskStatus(db, 'task1', 'WAITING_USER', 1);
    appendStatus(db, { eventId: 'batch-input', taskId: 'task1', status: 'WAITING_USER', createdAt: 2_498 });
    setTaskStatus(db, 'task1', 'DONE', 2);
    appendStatus(db, { eventId: 'after-batch-done', taskId: 'task1', status: 'DONE', createdAt: 2_499 });

    const first = pollTaskNotifications(db, VIEWER, { limit: 10 }, 3_000);
    expect(first.items).toHaveLength(1);
    expect(first.scannedThroughSeq).toBe(500);
    const firstClaim = claimTaskNotification(db, VIEWER, first.items[0], 3_050);
    expect(firstClaim.claimed && firstClaim.notification.kind).toBe('task.needs_input');
    const second = pollTaskNotifications(db, VIEWER, { limit: 10 }, 3_100);
    expect(second.items).toHaveLength(1);
    expect(second.scannedThroughSeq).toBe(501);
    const secondClaim = claimTaskNotification(db, VIEWER, second.items[0], 3_200);
    expect(secondClaim.claimed && secondClaim.notification.kind).toBe('task.completed');
    db.close();
  });

  it('maps each real status transition while sustained progress stays quiet, including a later rework completion', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);

    const states = [
      ['DONE', 'task.completed'],
      ['BLOCKED', 'task.needs_attention'],
      ['WAITING_USER', 'task.needs_input'],
      ['REVIEW', 'task.needs_review'],
    ] as const;
    for (let index = 0; index < states.length; index += 1) {
      const [status] = states[index]!;
      setTaskStatus(db, 'task1', status, index + 1);
      appendStatus(db, { eventId: `state-${status}`, taskId: 'task1', status, createdAt: 2_000 + index });
    }
    db.prepare(
      `INSERT INTO domain_events
         (event_id, schema_version, project_id, conversation_id, thread_id, task_id, kind, payload_json, created_at)
       VALUES ('progress-only', 1, 'p1', 'c1', 'th1', 'task1', 'tool.started', '{"toolName":"Read"}', 2300)`,
    ).run();
    appendStatus(db, { eventId: 'review-sustained-repeat', taskId: 'task1', status: 'REVIEW', createdAt: 2_320 });
    setTaskStatus(db, 'task1', 'ACTIVE', 5);
    appendStatus(db, { eventId: 'rework-active', taskId: 'task1', status: 'ACTIVE', createdAt: 2_350 });
    setTaskStatus(db, 'task1', 'DONE', 6);
    appendStatus(db, { eventId: 'rework-done', taskId: 'task1', status: 'DONE', createdAt: 2_400 });

    const pending = pollTaskNotifications(db, VIEWER, { limit: 10 }, 3_000);
    expect(pending.items).toHaveLength(5);
    const kinds = pending.items.map((item) => {
      const claimed = claimTaskNotification(db, VIEWER, item, 3_100);
      if (!claimed.claimed) throw new Error(`claim failed: ${claimed.reason}`);
      return claimed.notification.kind;
    });
    expect(kinds).toEqual([...states.map(([, kind]) => kind), 'task.completed']);
    db.close();
  });

  it('allows the same terminal status in a later cycle even when the cycle spans polls', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);

    setTaskStatus(db, 'task1', 'DONE', 1);
    appendStatus(db, { eventId: 'cycle-one-done', taskId: 'task1', status: 'DONE', createdAt: 2_000 });
    const first = pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_000);
    expect(first.items).toHaveLength(1);
    const firstClaim = claimTaskNotification(db, VIEWER, first.items[0], 2_100);
    if (!firstClaim.claimed) throw new Error('first claim failed');
    ackTaskNotification(db, VIEWER, { notificationId: firstClaim.notification.notificationId, stage: 'shown' }, 2_200);

    setTaskStatus(db, 'task1', 'ACTIVE', 2);
    appendStatus(db, { eventId: 'cycle-two-active', taskId: 'task1', status: 'ACTIVE', createdAt: 3_000 });
    expect(pollTaskNotifications(db, VIEWER, { limit: 10 }, 3_000).items).toEqual([]);
    appendStatus(db, { eventId: 'cycle-two-active-repeat', taskId: 'task1', status: 'ACTIVE', createdAt: 3_050 });

    setTaskStatus(db, 'task1', 'DONE', 3);
    appendStatus(db, { eventId: 'cycle-two-done', taskId: 'task1', status: 'DONE', createdAt: 4_000 });
    const second = pollTaskNotifications(db, VIEWER, { limit: 10 }, 4_000);
    expect(second.items).toHaveLength(1);
    const secondClaim = claimTaskNotification(db, VIEWER, second.items[0], 4_100);
    if (!secondClaim.claimed) throw new Error('second claim failed');
    expect(secondClaim.notification.notificationId).not.toBe(firstClaim.notification.notificationId);
    expect(secondClaim.notification.kind).toBe('task.completed');
    db.close();
  });

  it('suppresses muted threads at claim time and never leaks a claimed notification', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);
    setTaskStatus(db, 'task1', 'WAITING_USER', 1);
    appendStatus(db, { eventId: 'waiting-input', taskId: 'task1', status: 'WAITING_USER', createdAt: 2_000 });

    const pending = pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_000);
    expect(pending.items).toHaveLength(1);
    db.prepare(
      'UPDATE thread_subscriptions SET muted = 1 WHERE thread_id = ? AND viewer_id = ?',
    ).run('th1', VIEWER);
    expect(claimTaskNotification(db, VIEWER, pending.items[0], 2_100)).toEqual({ claimed: false, reason: 'muted' });
    expect(pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_200).items).toEqual([]);
    db.close();
  });

  it('uses the DM deep link only for the local human participant', () => {
    const db = openDatabase(':memory:');
    seedDm(db);
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);
    setTaskStatus(db, 'dm_task1', 'DONE', 1);
    appendStatus(db, {
      eventId: 'dm-done',
      conversationId: 'dm1',
      threadId: null,
      taskId: 'dm_task1',
      status: 'DONE',
      createdAt: 2_000,
    });
    const pending = pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_000);
    expect(pending.items).toHaveLength(1);
    const claimed = claimTaskNotification(db, VIEWER, pending.items[0], 2_100);
    expect(claimed.claimed && claimed.notification.locator.hash).toBe('#dm=dm1');
    db.close();
  });

  it('does not turn coordination child-task completion into a user notification burst', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    db.prepare(
      `INSERT INTO tasks
         (id, project_id, conversation_id, kind, room_id, conversation_thread_id, parent_task_id,
          owner_member_id, title, status, revision, review_policy)
       VALUES ('child1', 'p1', 'c1', 'room_task', 'r1', 'th1', 'task1',
               'a1', '内部子任务', 'DONE', 1, 'auto_deliver')`,
    ).run();
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);
    appendStatus(db, { eventId: 'child-done', taskId: 'child1', status: 'DONE', createdAt: 2_000 });
    expect(pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_000)).toMatchObject({
      items: [],
      health: { attempted: 0 },
    });
    db.close();
  });

  it('never requeues a stale claim and records it as an attempted unknown instead', () => {
    const db = openDatabase(':memory:');
    seedRoom(db);
    pollTaskNotifications(db, VIEWER, { limit: 10 }, 1_000);
    setTaskStatus(db, 'task1', 'DONE', 1);
    appendStatus(db, { eventId: 'crash-window', taskId: 'task1', status: 'DONE', createdAt: 2_000 });
    const pending = pollTaskNotifications(db, VIEWER, { limit: 10 }, 2_000);
    const claimed = claimTaskNotification(db, VIEWER, pending.items[0], 2_100);
    if (!claimed.claimed) throw new Error('claim failed');
    ackTaskNotification(db, VIEWER, {
      notificationId: claimed.notification.notificationId,
      stage: 'show_requested',
    }, 2_200);

    const afterLease = pollTaskNotifications(db, VIEWER, { limit: 10 }, 100_000);
    expect(afterLease.items).toEqual([]);
    expect(afterLease.health).toMatchObject({ attempted: 1, showRequested: 1, unknown: 1, shown: 0, failed: 0 });
    expect(afterLease.recentAttempts[0]).toMatchObject({
      notificationId: claimed.notification.notificationId,
      state: 'unknown',
      claimRequestedAt: 2_100,
      showRequestedAt: 2_200,
      shownAt: null,
    });
    expect(claimTaskNotification(db, VIEWER, pending.items[0], 100_100)).toEqual({
      claimed: false,
      reason: 'not_pending',
    });
    db.close();
  });

  it('persists cursor and delivery state across reopen without replaying', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zs-task-notification-r108-'));
    scratch.push(dir);
    const file = join(dir, 'state.sqlite');
    const first = openDatabase(file);
    expect(first.pragma('user_version', { simple: true })).toBe(60);
    seedRoom(first);
    pollTaskNotifications(first, VIEWER, { limit: 10 }, 1_000);
    setTaskStatus(first, 'task1', 'DONE', 1);
    appendStatus(first, { eventId: 'persist-done', taskId: 'task1', status: 'DONE', createdAt: 2_000 });
    const pending = pollTaskNotifications(first, VIEWER, { limit: 10 }, 2_000);
    const claimed = claimTaskNotification(first, VIEWER, pending.items[0], 2_100);
    if (!claimed.claimed) throw new Error('claim failed');
    ackTaskNotification(first, VIEWER, { notificationId: claimed.notification.notificationId, stage: 'shown' }, 2_200);
    first.close();

    const reopened = openDatabase(file);
    expect(pollTaskNotifications(reopened, VIEWER, { limit: 10 }, 3_000).items).toEqual([]);
    expect(reopened.prepare('SELECT delivery_state FROM task_notifications').get()).toEqual({ delivery_state: 'shown' });
    reopened.close();
  });

  it('turns a real direct provider failure into one actionable root notification while the task stays ACTIVE', async () => {
    const fixture = await workerFixture({
      scripts: [failureScript('503 upstream temporarily unavailable')],
    });
    try {
      await fixture.worker.runOnce();
      const failed = fixture.db.prepare(
        `SELECT r.id AS run_id, r.status AS run_status, a.id AS turn_id, a.status AS turn_status,
                t.status AS task_status
         FROM tasks t
         JOIN workflow_runs r ON r.task_id = t.id
         JOIN agent_turns a ON a.run_id = r.id
         WHERE t.id = ? ORDER BY r.rowid DESC LIMIT 1`,
      ).get(fixture.taskId) as {
        run_id: string;
        run_status: string;
        turn_id: string;
        turn_status: string;
        task_status: string;
      };
      expect(failed).toMatchObject({
        run_status: 'FAILED',
        turn_status: 'FAILED',
        task_status: 'ACTIVE',
      });
      expect(fixture.db.prepare(
        `SELECT kind, run_id, turn_id, payload_json FROM domain_events
         WHERE task_id = ? AND kind = 'turn.statusChanged' ORDER BY seq DESC LIMIT 1`,
      ).get(fixture.taskId)).toMatchObject({
        kind: 'turn.statusChanged',
        run_id: failed.run_id,
        turn_id: failed.turn_id,
      });

      const pending = pollTaskNotifications(fixture.db, VIEWER, { limit: 10 }, 200_000);
      expect(pending.items).toHaveLength(1);
      const claimed = claimTaskNotification(fixture.db, VIEWER, pending.items[0], 200_100);
      if (!claimed.claimed) throw new Error(`claim failed: ${claimed.reason}`);
      expect(claimed.notification).toMatchObject({
        kind: 'task.needs_attention',
        title: '众说 · 任务需要处理',
        locator: {
          taskId: fixture.taskId,
          hash: `#task=${fixture.taskId}`,
        },
      });
      expect(claimed.notification.body).toContain('503 upstream temporarily unavailable');
    } finally {
      await fixture.close();
    }
  });

  it.each(['waiting', 'queued', 'running'] as const)(
    'stays quiet while a real provider failure has automatic recovery in %s state',
    async (state) => {
      const fixture = await workerFixture({
        scripts: [failureScript('503 upstream temporarily unavailable')],
        automaticRecovery: true,
      });
      try {
        await fixture.worker.runOnce();
        const job = pendingAutomaticRecovery(fixture.db, fixture.taskId);
        expect(job?.state).toBe('waiting');
        fixture.db.prepare(
          `UPDATE daemon_state SET value = json_set(value, '$.state', ?)
           WHERE key = ?`,
        ).run(state, `automatic-recovery:${job!.sourceTurnId}`);
        expect(pendingAutomaticRecovery(fixture.db, fixture.taskId)?.state).toBe(state);
        expect(fixture.db.prepare('SELECT status FROM tasks WHERE id = ?').get(fixture.taskId))
          .toEqual({ status: 'ACTIVE' });
        expect(pollTaskNotifications(fixture.db, VIEWER, { limit: 10 }, 200_000).items).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(['UNKNOWN', 'retained'] as const)(
    'keeps a failed run quiet while the existing %s recovery guard still applies',
    async (guard) => {
      const fixture = await workerFixture({
        scripts: [failureScript('permission denied', 'PERMISSION_DENIED')],
      });
      try {
        await fixture.worker.runOnce();
        const turnId = (fixture.db.prepare(
          'SELECT id FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?) ORDER BY rowid DESC LIMIT 1',
        ).get(fixture.taskId) as { id: string }).id;
        if (guard === 'UNKNOWN') {
          fixture.db.prepare(`UPDATE agent_turns SET status = 'UNKNOWN' WHERE id = ?`).run(turnId);
        } else {
          fixture.db.prepare(`UPDATE agent_turns SET protection_state = 'retained' WHERE id = ?`).run(turnId);
        }
        expect(pollTaskNotifications(fixture.db, VIEWER, { limit: 10 }, 200_000).items).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

  it('uses a real output-invalid run identity, dedupes additional evidence, and notifies a later failed rerun', async () => {
    const fixture = await workerFixture({
      scripts: [
        [{
          kind: 'event',
          event: { kind: 'turn.completed', finalText: '这是一段未按交付合同提交的普通散文。' },
        }],
        failureScript('second run provider failure'),
      ],
      structuredFinal: false,
    });
    try {
      await fixture.worker.runOnce();
      const firstRun = fixture.db.prepare(
        `SELECT r.id AS run_id, a.id AS turn_id, r.status AS run_status
         FROM workflow_runs r JOIN agent_turns a ON a.run_id = r.id
         WHERE r.task_id = ? ORDER BY r.rowid DESC LIMIT 1`,
      ).get(fixture.taskId) as { run_id: string; turn_id: string; run_status: string };
      expect(firstRun.run_status).toBe('FAILED');
      expect(fixture.db.prepare(
        `SELECT kind, run_id, turn_id FROM domain_events
         WHERE task_id = ? AND kind = 'turn.outputInvalid' ORDER BY seq DESC LIMIT 1`,
      ).get(fixture.taskId)).toEqual({
        kind: 'turn.outputInvalid',
        run_id: firstRun.run_id,
        turn_id: firstRun.turn_id,
      });
      appendExecutionFailure(fixture.db, {
        eventId: 'same-run-failure-same-batch',
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        runId: firstRun.run_id,
        turnId: firstRun.turn_id,
        conversationId: fixture.conversationId,
        createdAt: 199_990,
      });
      const firstPending = pollTaskNotifications(fixture.db, VIEWER, { limit: 10 }, 200_000);
      expect(firstPending.items).toHaveLength(1);
      const firstClaim = claimTaskNotification(fixture.db, VIEWER, firstPending.items[0], 200_100);
      if (!firstClaim.claimed) throw new Error(`first claim failed: ${firstClaim.reason}`);
      expect(firstClaim.notification.kind).toBe('task.needs_attention');

      appendExecutionFailure(fixture.db, {
        eventId: 'same-run-failure-later-batch',
        projectId: fixture.projectId,
        taskId: fixture.taskId,
        runId: firstRun.run_id,
        turnId: firstRun.turn_id,
        conversationId: fixture.conversationId,
        createdAt: 200_150,
      });
      expect(pollTaskNotifications(fixture.db, VIEWER, { limit: 10 }, 200_200).items).toEqual([]);

      const task = fixture.db.prepare(
        'SELECT revision, stop_generation FROM tasks WHERE id = ?',
      ).get(fixture.taskId) as { revision: number; stop_generation: number };
      await fixture.command('task.redispatch', {
        taskId: fixture.taskId,
        sourceRunId: firstRun.run_id,
        expectedTaskRevision: task.revision,
        expectedStopGeneration: task.stop_generation,
        expectedRunStatus: 'FAILED',
        reason: 'R108 回归：显式继续第二次执行',
      });
      await fixture.worker.runOnce();
      const secondRun = fixture.db.prepare(
        'SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1',
      ).get(fixture.taskId) as { id: string };
      expect(secondRun.id).not.toBe(firstRun.run_id);

      const secondPending = pollTaskNotifications(fixture.db, VIEWER, { limit: 10 }, 200_300);
      expect(secondPending.items).toHaveLength(1);
      const secondClaim = claimTaskNotification(fixture.db, VIEWER, secondPending.items[0], 200_400);
      if (!secondClaim.claimed) throw new Error(`second claim failed: ${secondClaim.reason}`);
      expect(secondClaim.notification.notificationId).not.toBe(firstClaim.notification.notificationId);
      expect(secondClaim.notification.body).toContain('second run provider failure');
    } finally {
      await fixture.close();
    }
  });

  it('notifies a real DM failure with the DM deep link', async () => {
    const fixture = await workerFixture({
      scripts: [failureScript('DM provider failed')],
      dm: true,
    });
    try {
      await fixture.worker.runOnce();
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id = ?').get(fixture.taskId))
        .toEqual({ status: 'ACTIVE' });
      const pending = pollTaskNotifications(fixture.db, VIEWER, { limit: 10 }, 200_000);
      expect(pending.items).toHaveLength(1);
      const claimed = claimTaskNotification(fixture.db, VIEWER, pending.items[0], 200_100);
      if (!claimed.claimed) throw new Error(`claim failed: ${claimed.reason}`);
      expect(claimed.notification).toMatchObject({
        kind: 'task.needs_attention',
        locator: {
          taskId: fixture.taskId,
          hash: `#dm=${fixture.conversationId}`,
        },
      });
      expect(claimed.notification.body).toContain('DM provider failed');
    } finally {
      await fixture.close();
    }
  });

  it('keeps execution-failure notifications quiet for coordination child tasks', async () => {
    const fixture = await workerFixture({
      scripts: [failureScript()],
    });
    try {
      const agentId = (fixture.db.prepare(
        "SELECT id FROM project_members WHERE principal_type = 'agent' ORDER BY rowid LIMIT 1",
      ).get() as { id: string }).id;
      fixture.db.prepare(
        `INSERT INTO tasks
           (id, project_id, conversation_id, kind, room_id, conversation_thread_id, parent_task_id,
            owner_member_id, title, status, revision, review_policy)
         VALUES ('child_failure', ?, ?, 'room_task', ?, NULL, ?,
                 ?, '内部子任务', 'ACTIVE', 0, 'auto_deliver')`,
      ).run(fixture.projectId, fixture.conversationId, fixture.roomId, fixture.taskId, agentId);
      fixture.db.prepare(
        `INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status)
         VALUES ('child_failure_run', 'child_failure', ?, 'DIRECT', 'FAILED')`,
      ).run(fixture.conversationId);
      fixture.db.prepare(
        `INSERT INTO agent_turns
           (id, run_id, conversation_id, member_id, stage_key, status)
         VALUES ('child_failure_turn', 'child_failure_run', ?, ?, 'direct.work', 'FAILED')`,
      ).run(fixture.conversationId, agentId);
      appendExecutionFailure(fixture.db, {
        eventId: 'child-failure-event',
        projectId: fixture.projectId,
        taskId: 'child_failure',
        runId: 'child_failure_run',
        turnId: 'child_failure_turn',
        conversationId: fixture.conversationId,
        createdAt: 200_000,
      });
      expect(pollTaskNotifications(fixture.db, VIEWER, { limit: 10 }, 200_100).items).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
