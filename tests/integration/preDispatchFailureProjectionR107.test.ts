import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendDomainEvent } from '../../src/persistence/events.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import type { TaskDetailsResult } from '../../src/contracts/taskDetails.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';

process.env.ZS_ALLOW_FAKE = '1';
process.env.ZS_RUNTIME = 'fake';
delete process.env.ZS_REAL_BATCH_ID;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const failureMessage = '写入基线不完整：目录扫描失败、路径被拒绝或文件清单超出安全范围，未启动模型';

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs-r107-pre-dispatch-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  const db = openDatabase(join(root, 'state.sqlite'));
  const deps = {
    db,
    appDataDir: root,
    localUserId: 'u_local',
    interruptTurn: async () => {},
  };
  const raw = (method: string, params: unknown) => dispatchDaemonCommand(deps, {
    protocolVersion: 1,
    commandId: `r107-${randomUUID()}`,
    method,
    params,
  }) as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const result = await raw(method, params);
    if (!result.ok) throw new Error(`${result.error?.code ?? ''}: ${result.error?.message ?? 'failed'}`);
    return result.data as T;
  };
  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projectRoot })).project.id;
  const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', { projectId })).items[0]!;
  const memberId = (await cmd<{ memberId: string }>('member.create', {
    projectId,
    displayName: 'R107 执行成员',
  })).memberId;
  await cmd('member.setRuntime', {
    memberId,
    kind: 'fake',
    permissionMode: 'bypassPermissions',
  });
  const submitted = await cmd<{ taskId: string; threadId: string }>('message.submit', {
    target: {
      kind: 'room_root',
      projectId,
      roomId: room.id,
      conversationId: room.conversationId,
    },
    body: '检查项目差异',
    intent: 'default',
    mentions: [{ kind: 'member', memberId }],
  });
  const sent = { ...submitted, conversationId: room.conversationId };
  return { root, projectRoot, db, projectId, room, memberId, sent, cmd };
}

function recordConfirmedPreDispatchFailure(
  fx: Awaited<ReturnType<typeof fixture>>,
  reason = 'write-baseline-incomplete',
  message = failureMessage,
): number {
  fx.db.transaction(() => {
    fx.db.prepare('UPDATE outbox SET status = ? WHERE dispatch_key = ?')
      .run('done', `task:${fx.sent.taskId}:initial`);
    fx.db.prepare('UPDATE tasks SET status = ?, revision = revision + 1 WHERE id = ?')
      .run('BLOCKED', fx.sent.taskId);
    appendDomainEvent(fx.db, {
      schemaVersion: 1,
      eventId: `evt_r107_baseline_${randomUUID()}`,
      projectId: fx.projectId,
      conversationId: fx.sent.conversationId,
      threadId: fx.sent.threadId,
      taskId: fx.sent.taskId,
      runId: `run_not_persisted_${randomUUID()}`,
      kind: 'changeset.baselineCaptured',
      payload: { changeSetId: `cs_r107_${randomUUID()}`, truncated: true },
      createdAt: 99,
    });
    appendDomainEvent(fx.db, {
      schemaVersion: 1,
      eventId: `evt_r107_blocked_${randomUUID()}`,
      projectId: fx.projectId,
      conversationId: fx.sent.conversationId,
      threadId: fx.sent.threadId,
      taskId: fx.sent.taskId,
      kind: 'task.statusChanged',
      payload: { status: 'BLOCKED' },
      createdAt: 100,
    });
    appendDomainEvent(fx.db, {
      schemaVersion: 1,
      eventId: `evt_r107_context_${randomUUID()}`,
      projectId: fx.projectId,
      conversationId: fx.sent.conversationId,
      threadId: fx.sent.threadId,
      taskId: fx.sent.taskId,
      kind: 'task.contextAssemblyFailed',
      payload: { reason, message },
      createdAt: 101,
    });
  })();
  return (fx.db.prepare(`
    SELECT seq FROM domain_events
    WHERE task_id = ? AND kind = 'task.contextAssemblyFailed'
    ORDER BY seq DESC LIMIT 1
  `).get(fx.sent.taskId) as { seq: number }).seq;
}

describe('R107 shared pre-dispatch failure projection', () => {
  it('projects the failure written by the real worker before startTurn', async () => {
    const fx = await fixture();
    const outside = join(fx.root, 'outside');
    mkdirSync(outside);
    try {
      symlinkSync(outside, join(fx.projectRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      fx.db.close();
      throw new Error(`R107 worker fixture requires a directory link: ${String(error)}`, { cause: error });
    }
    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({
      db: fx.db,
      adapter,
      leaseOwner: 'r107-real-worker',
      appDataDir: fx.root,
    });
    try {
      await worker.runOnce();
      const task = fx.db.prepare('SELECT status FROM tasks WHERE id = ?').get(fx.sent.taskId);
      expect(task).toEqual({ status: 'BLOCKED' });
      expect(fx.db.prepare('SELECT count(*) n FROM workflow_runs WHERE task_id = ?').get(fx.sent.taskId)).toEqual({ n: 1 });
      expect(fx.db.prepare(`
        SELECT count(*) n FROM agent_turns a
        JOIN workflow_runs r ON r.id = a.run_id
        WHERE r.task_id = ?
      `).get(fx.sent.taskId)).toEqual({ n: 1 });
      expect(adapter.startTurnLog).toHaveLength(0);

      const failure = fx.db.prepare(`
        SELECT seq, payload_json FROM domain_events
        WHERE task_id = ? AND kind = 'task.contextAssemblyFailed'
        ORDER BY seq DESC LIMIT 1
      `).get(fx.sent.taskId) as { seq: number; payload_json: string };
      const actualFailureMessage=JSON.parse(failure.payload_json).message as string;
      expect(actualFailureMessage).toMatch(/写入基线不完整：escape：.*越界/);
      expect(JSON.parse(failure.payload_json)).toMatchObject({
        reason: 'write-baseline-incomplete',
        message: actualFailureMessage,
      });
      const detail = await fx.cmd<TaskDetailsResult>('task.details', {
        projectId: fx.projectId,
        taskId: fx.sent.taskId,
        conversationId: fx.sent.conversationId,
      });
      expect(detail.preDispatchFailure).toMatchObject({
        state: 'NOT_STARTED',
        event: {
          seq: failure.seq,
          reason: 'write-baseline-incomplete',
          message: actualFailureMessage,
        },
        runCount: 1,
        turnCount: 1,
        callCount: 0,
        outbox: { status: 'done' },
        recoveryBinding: {
          method: 'task.redispatch',
          taskId: fx.sent.taskId,
          expectedStopGeneration: 0,
          sourceRunId: null,
        },
      });
      expect(detail.preDispatchFailure?.action.instruction).toBe(
        '仅需分析可选择仅分析继续，原消息与成员不变；可写执行仍需完整基线。',
      );
    } finally {
      await adapter.closeAllSessions();
      fx.db.close();
    }
  }, 30_000);

  it('emits a recovery binding only while baseline recovery scope and readiness are current', async () => {
    const fx = await fixture();
    try {
      recordConfirmedPreDispatchFailure(
        fx,
        'write-baseline-failed',
        '写入基线失败，未启动模型',
      );
      const detail = () => fx.cmd<TaskDetailsResult>('task.details', {
        projectId: fx.projectId,
        taskId: fx.sent.taskId,
        conversationId: fx.sent.conversationId,
      });
      const currentRevision = (fx.db.prepare('SELECT revision FROM tasks WHERE id = ?')
        .get(fx.sent.taskId) as { revision: number }).revision;
      const expectedBinding = {
        method: 'task.redispatch',
        taskId: fx.sent.taskId,
        expectedTaskRevision: currentRevision,
        expectedStopGeneration: 0,
        sourceRunId: null,
      };

      expect((await detail()).preDispatchFailure?.recoveryBinding).toEqual(expectedBinding);
      expect((await detail()).preDispatchFailure?.action.instruction).toBe(
        '仅需分析可选择仅分析继续，原消息与成员不变；可写执行仍需完整基线。',
      );

      fx.db.prepare('UPDATE tasks SET stop_generation = 1 WHERE id = ?').run(fx.sent.taskId);
      expect((await detail()).preDispatchFailure?.recoveryBinding).toBeUndefined();
      fx.db.prepare('UPDATE tasks SET stop_generation = 0 WHERE id = ?').run(fx.sent.taskId);

      fx.db.prepare('UPDATE project_members SET enabled = 0 WHERE id = ?').run(fx.memberId);
      expect((await detail()).preDispatchFailure?.recoveryBinding).toBeUndefined();
      fx.db.prepare('UPDATE project_members SET enabled = 1 WHERE id = ?').run(fx.memberId);

      fx.db.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(fx.projectId);
      expect((await detail()).preDispatchFailure?.recoveryBinding).toBeUndefined();
      fx.db.prepare("UPDATE projects SET status = 'active' WHERE id = ?").run(fx.projectId);

      fx.db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?')
        .run(Date.now(), fx.sent.conversationId);
      expect((await detail()).preDispatchFailure?.recoveryBinding).toBeUndefined();
      fx.db.prepare('UPDATE conversations SET archived_at = NULL WHERE id = ?')
        .run(fx.sent.conversationId);

      fx.db.prepare('UPDATE rooms SET archived_at = ? WHERE id = ?')
        .run(Date.now(), fx.room.id);
      expect((await detail()).preDispatchFailure?.recoveryBinding).toBeUndefined();
      fx.db.prepare('UPDATE rooms SET archived_at = NULL WHERE id = ?').run(fx.room.id);

      const childTaskId = `task_${randomUUID()}`;
      const childRunId = `run_${randomUUID()}`;
      fx.db.transaction(() => {
        fx.db.prepare(`
          INSERT INTO tasks
            (id, project_id, conversation_id, kind, room_id, conversation_thread_id,
             root_message_id, room_task_number, owner_member_id, parent_task_id, title,
             status, revision, review_policy)
          VALUES (?, ?, ?, 'room_task', ?, ?, NULL, NULL, ?, ?, 'R107 child',
                  'ACTIVE', 0, 'auto_deliver')
        `).run(
          childTaskId,
          fx.projectId,
          fx.sent.conversationId,
          fx.room.id,
          fx.sent.threadId,
          fx.memberId,
          fx.sent.taskId,
        );
        fx.db.prepare(`
          INSERT INTO workflow_runs
            (id, task_id, conversation_id, thread_id, mode, task_revision, status)
          VALUES (?, ?, ?, ?, 'AUTO', 0, 'RUNNING')
        `).run(childRunId, childTaskId, fx.sent.conversationId, fx.sent.threadId);
      })();
      expect((await detail()).preDispatchFailure?.recoveryBinding).toBeUndefined();
      fx.db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(childRunId);
      fx.db.prepare('DELETE FROM tasks WHERE id = ?').run(childTaskId);

      appendDomainEvent(fx.db, {
        schemaVersion: 1,
        eventId: `evt_r107_nonbaseline_${randomUUID()}`,
        projectId: fx.projectId,
        conversationId: fx.sent.conversationId,
        threadId: fx.sent.threadId,
        taskId: fx.sent.taskId,
        kind: 'task.contextAssemblyFailed',
        payload: { reason: 'assembly-failed', message: '其他预派发失败' },
        createdAt: 400,
      });
      expect((await detail()).preDispatchFailure?.recoveryBinding).toBeUndefined();
    } finally {
      fx.db.close();
    }
  });

  it('projects the exact zero-run cause even when the 120-event page omits it', async () => {
    const fx = await fixture();
    try {
      const failureSeq = recordConfirmedPreDispatchFailure(fx);
      for (let index = 0; index < 125; index += 1) {
        appendDomainEvent(fx.db, {
          schemaVersion: 1,
          eventId: `evt_r107_noise_${index}_${randomUUID()}`,
          projectId: fx.projectId,
          conversationId: fx.sent.conversationId,
          threadId: fx.sent.threadId,
          taskId: fx.sent.taskId,
          kind: 'tool.completed',
          payload: { toolName: 'read' },
          createdAt: 200 + index,
        });
      }

      const detail = await fx.cmd<TaskDetailsResult>('task.details', {
        projectId: fx.projectId,
        taskId: fx.sent.taskId,
        conversationId: fx.sent.conversationId,
      });
      expect(detail.runs).toEqual([]);
      expect(detail.latestRunId).toBeNull();
      expect(detail.events).toHaveLength(120);
      expect(detail.events.some((event) => event.seq === failureSeq)).toBe(false);
      expect(detail.preDispatchFailure).toMatchObject({
        state: 'NOT_STARTED',
        taskId: fx.sent.taskId,
        conversationId: fx.sent.conversationId,
        threadId: fx.sent.threadId,
        memberId: fx.memberId,
        memberName: 'R107 执行成员',
        memberEnabled: true,
        event: {
          seq: failureSeq,
          kind: 'task.contextAssemblyFailed',
          reason: 'write-baseline-incomplete',
          message: failureMessage,
        },
        runCount: 0,
        turnCount: 0,
        callCount: 0,
        callStarted: false,
        outbox: {
          dispatchKey: `task:${fx.sent.taskId}:initial`,
          status: 'done',
        },
        action: { kind: 'resubmit-original-message' },
      });
      expect(detail.preDispatchFailure?.action.instruction).toBe(
        '仅需分析可选择仅分析继续，原消息与成员不变；可写执行仍需完整基线。',
      );
      expect(detail.preDispatchFailure?.recoveryBinding).toEqual({
        method: 'task.redispatch',
        taskId: fx.sent.taskId,
        expectedTaskRevision: detail.task.revision,
        expectedStopGeneration: 0,
        sourceRunId: null,
      });
    } finally {
      fx.db.close();
    }
  });

  it('never relabels pending, called, later-state, UNKNOWN, or running work as NOT_STARTED', async () => {
    const fx = await fixture();
    try {
      recordConfirmedPreDispatchFailure(fx);
      const details = () => fx.cmd<TaskDetailsResult>('task.details', {
        projectId: fx.projectId,
        taskId: fx.sent.taskId,
        conversationId: fx.sent.conversationId,
      });

      fx.db.prepare(`
        INSERT INTO outbox (dispatch_key, turn_id, status, lease_owner, lease_until, attempt_epoch)
        VALUES (?, NULL, 'leased', 'r107-test', ?, 1)
      `).run(`task:${fx.sent.taskId}:redispatch:probe`, Date.now() + 60_000);
      expect((await details()).preDispatchFailure).toBeNull();
      fx.db.prepare('DELETE FROM outbox WHERE dispatch_key = ?')
        .run(`task:${fx.sent.taskId}:redispatch:probe`);

      fx.db.prepare(`
        INSERT INTO real_calls (batch_id, runtime_kind, model, member_id, task_id, turn_id, status, created_at)
        VALUES ('r107-call', 'fake', 'fake-model', ?, ?, NULL, 'failed', ?)
      `).run(fx.memberId, fx.sent.taskId, Date.now());
      expect((await details()).preDispatchFailure).toBeNull();
      fx.db.prepare("DELETE FROM real_calls WHERE batch_id = 'r107-call'").run();

      const runId = `run_${randomUUID()}`;
      const turnId = `turn_${randomUUID()}`;
      fx.db.transaction(() => {
        fx.db.prepare(`
          INSERT INTO workflow_runs
            (id, task_id, conversation_id, thread_id, mode, task_revision, status)
          VALUES (?, ?, ?, ?, 'AUTO', 1, 'RUNNING')
        `).run(runId, fx.sent.taskId, fx.sent.conversationId, fx.sent.threadId);
        fx.db.prepare(`
          INSERT INTO agent_turns
            (id, run_id, conversation_id, thread_id, member_id, stage_key, status, dispatch_key, attempt, epoch)
          VALUES (?, ?, ?, ?, ?, 'direct.work', 'UNKNOWN', ?, 1, 1)
        `).run(turnId, runId, fx.sent.conversationId, fx.sent.threadId, fx.memberId, `r107:${turnId}`);
      })();
      const unknown = await details();
      expect(unknown.preDispatchFailure).toBeNull();
      expect(unknown.runs[0]).toMatchObject({ id: runId, status: 'RUNNING' });
      expect(unknown.runs[0]?.turns[0]).toMatchObject({ id: turnId, status: 'UNKNOWN' });

      fx.db.prepare("UPDATE agent_turns SET status = 'RUNNING' WHERE id = ?").run(turnId);
      expect((await details()).preDispatchFailure).toBeNull();

      fx.db.prepare('DELETE FROM agent_turns WHERE id = ?').run(turnId);
      fx.db.prepare('DELETE FROM workflow_runs WHERE id = ?').run(runId);
      appendDomainEvent(fx.db, {
        schemaVersion: 1,
        eventId: `evt_r107_later_status_${randomUUID()}`,
        projectId: fx.projectId,
        conversationId: fx.sent.conversationId,
        threadId: fx.sent.threadId,
        taskId: fx.sent.taskId,
        kind: 'task.statusChanged',
        payload: { status: 'BLOCKED', reason: 'new-current-block' },
        createdAt: 300,
      });
      expect((await details()).preDispatchFailure).toBeNull();
    } finally {
      fx.db.close();
    }
  });
});
