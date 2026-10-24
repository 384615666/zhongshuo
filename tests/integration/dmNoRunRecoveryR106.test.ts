import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_BATCH_ID;

const root = mkdtempSync(join(tmpdir(), 'zs-r106-dm-no-run-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface DmListRow {
  conversationId: string;
  execState: string;
  queuedCount: number;
  interruptedTasks: Array<{
    taskId: string;
    title: string;
    lastRunId: string | null;
    lastRunStatus: string | null;
    recoverable: boolean;
    blockReason: string | null;
    lastFailureReason: string | null;
  }>;
}

describe('R106 DM pre-dispatch failure recovery', () => {
  it('lists only persisted 0-run BLOCKED failures, preserves fresh queue counts, and redispatch uses the current message', async () => {
    const db = openDatabase(':memory:');
    try {
      db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
        VALUES ('p1','项目甲',?,?, '{}', 0)`).run(root, root);
      db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
        VALUES ('mA','p1','Codex','agent',1)`).run();
      const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: join(root, 'app') };
      const newCommandId = (): string => `r106-dm-${randomUUID()}`;
      const raw = <T,>(method: string, params: unknown, commandId = newCommandId()): Promise<{
        ok: boolean;
        data?: T;
        error?: { code: string; message: string };
        replayed?: boolean;
      }> =>
        dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method, params }) as Promise<{
          ok: boolean;
          data?: T;
          error?: { code: string; message: string };
          replayed?: boolean;
        }>;
      const cmd = async <T,>(method: string, params: unknown, commandId?: string): Promise<T> => {
        const result = await raw<T>(method, params, commandId);
        if (!result.ok) throw new Error(`${result.error?.code ?? ''}: ${result.error?.message ?? 'failed'}`);
        return result.data as T;
      };

      const conversation = await cmd<{ conversationId: string }>('conversation.create', {
        projectId: 'p1', peerMemberId: 'mA', title: 'R106 未派发恢复',
      });
      const send = async (body: string): Promise<string> => {
        const result = await cmd<{ taskId: string }>('message.submit', {
          target: { kind: 'dm', projectId: 'p1', conversationId: conversation.conversationId },
          body,
          intent: 'default',
          mentions: [],
        });
        return result.taskId;
      };
      const failBeforeDispatch = (taskId: string, reason: string): void => {
        db.prepare('UPDATE outbox SET status = ? WHERE dispatch_key = ?').run('failed', `dmtask:${taskId}:initial`);
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('BLOCKED', taskId);
        db.prepare(`INSERT INTO domain_events
          (event_id, schema_version, project_id, conversation_id, task_id, kind, payload_json, created_at)
          VALUES (?, 1, 'p1', ?, ?, 'task.contextAssemblyFailed', ?, ?)`).run(
          `evt_ctx_${randomUUID()}`, conversation.conversationId, taskId,
          JSON.stringify({ reason, message: reason }), Date.now(),
        );
      };

      const contextFailed = await send('Codex 当前消息');
      failBeforeDispatch(contextFailed, 'write-authorization-changed');
      const deliberationFailed = await send('另一条派发前失败');
      db.prepare('UPDATE outbox SET status = ? WHERE dispatch_key = ?').run('failed', `dmtask:${deliberationFailed}:initial`);
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('BLOCKED', deliberationFailed);
      db.prepare(`INSERT INTO domain_events
        (event_id, schema_version, project_id, conversation_id, task_id, kind, payload_json, created_at)
        VALUES (?, 1, 'p1', ?, ?, 'task.deliberationPrepareFailed', ?, ?)`).run(
        `evt_delib_${randomUUID()}`, conversation.conversationId, deliberationFailed,
        JSON.stringify({ reason: 'coordinator-configuration-missing' }), Date.now(),
      );
      const freshQueued = await send('尚未派发的新排队消息');
      expect(db.prepare('SELECT count(*) c FROM outbox WHERE dispatch_key = ? AND status = ?')
        .get(`dmtask:${freshQueued}:initial`, 'pending')).toEqual({ c: 1 });

      const genericConversation = await cmd<{ conversationId: string }>('conversation.create', {
        projectId: 'p1', peerMemberId: 'mA', title: '普通 BLOCKED',
      });
      const genericBlocked = await cmd<{ taskId: string }>('message.submit', {
        target: { kind: 'dm', projectId: 'p1', conversationId: genericConversation.conversationId },
        body: '普通阻塞不应被当成失败',
        intent: 'default',
        mentions: [],
      });
      db.prepare('UPDATE outbox SET status = ? WHERE dispatch_key = ?').run('done', `dmtask:${genericBlocked.taskId}:initial`);
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('BLOCKED', genericBlocked.taskId);
      db.prepare(`INSERT INTO domain_events
        (event_id, schema_version, project_id, conversation_id, task_id, kind, payload_json, created_at)
        VALUES (?, 1, 'p1', ?, ?, 'task.statusChanged', ?, ?)`).run(
        `evt_generic_${randomUUID()}`, genericConversation.conversationId, genericBlocked.taskId,
        JSON.stringify({ status: 'BLOCKED', reason: 'manual-or-unrelated-block' }), Date.now(),
      );

      const listed = await cmd<{ conversations: DmListRow[] }>('conversation.list', { projectId: 'p1' });
      const summary = listed.conversations.find((item) => item.conversationId === conversation.conversationId)!;
      expect(summary.execState).toBe('queued');
      expect(summary.queuedCount).toBe(1);
      expect(summary.interruptedTasks).toHaveLength(2);
      expect(summary.interruptedTasks.map((item) => item.taskId)).toEqual([contextFailed, deliberationFailed]);
      expect(summary.interruptedTasks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: contextFailed,
          lastRunId: null,
          lastRunStatus: null,
          recoverable: true,
          lastFailureReason: 'write-authorization-changed',
        }),
        expect.objectContaining({
          taskId: deliberationFailed,
          lastRunId: null,
          lastRunStatus: null,
          recoverable: true,
          lastFailureReason: 'coordinator-configuration-missing',
        }),
      ]));
      const genericSummary = listed.conversations.find((item) => item.conversationId === genericConversation.conversationId)!;
      expect(genericSummary.interruptedTasks).toEqual([]);
      expect(genericSummary.queuedCount).toBe(0);

      const taskBefore = db.prepare(`SELECT root_message_id, input_through_seq, project_id, conversation_id,
        room_id, conversation_thread_id, route_json FROM tasks WHERE id = ?`).get(contextFailed);
      const messageBefore = db.prepare('SELECT id, body_json FROM messages WHERE id = (SELECT root_message_id FROM tasks WHERE id = ?)').get(contextFailed);
      const messageCountBefore = db.prepare('SELECT count(*) c FROM messages WHERE conversation_id = ?').get(conversation.conversationId) as { c: number };
      const memberBefore = db.prepare('SELECT * FROM project_members WHERE id = ?').get('mA');
      const projectBefore = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1');
      const firstCommandId = newCommandId();
      const firstRecovery = await raw<{ enqueued: boolean; dispatchKey: string; sourceRunId: string | null }>('task.redispatch', {
        taskId: contextFailed,
        reason: '私信中断恢复（新界面显式发起）',
      }, firstCommandId);
      expect(firstRecovery.ok).toBe(true);
      expect(firstRecovery.data).toMatchObject({
        enqueued: true,
        sourceRunId: null,
      });
      const firstKey = firstRecovery.data!.dispatchKey;
      expect(firstKey).toMatch(new RegExp(`^task:${contextFailed}:redispatch:unstarted_[0-9a-f-]{36}$`));
      const recoveredIntent = db.prepare('SELECT id FROM outbox WHERE dispatch_key = ?').get(firstKey) as { id: number };
      expect(db.prepare('SELECT status FROM outbox WHERE id = ?').get(recoveredIntent.id)).toEqual({ status: 'pending' });

      const firstReplay = await raw<{ enqueued: boolean; dispatchKey: string; sourceRunId: string | null }>('task.redispatch', {
        taskId: contextFailed,
        reason: '私信中断恢复（新界面显式发起）',
      }, firstCommandId);
      expect(firstReplay.ok).toBe(true);
      expect(firstReplay.replayed).toBe(true);
      expect(firstReplay.data).toEqual(firstRecovery.data);

      const pendingDuringFirst = await raw('task.redispatch', {
        taskId: contextFailed,
        reason: '另一个新 id 不得并行恢复',
      });
      expect(pendingDuringFirst.ok).toBe(false);
      expect(pendingDuringFirst.error?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(db.prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key GLOB ?`)
        .get(`task:${contextFailed}:redispatch:*`)).toEqual({ c: 1 });

      // Simulate the worker consuming the first intent, then failing context
      // assembly again before any run/turn/call is created.
      db.prepare('UPDATE outbox SET status = ? WHERE dispatch_key = ?').run('done', firstKey);
      db.prepare(`INSERT INTO domain_events
        (event_id, schema_version, project_id, conversation_id, task_id, kind, payload_json, created_at)
        VALUES (?, 1, 'p1', ?, ?, 'task.contextAssemblyFailed', ?, ?)`).run(
        `evt_ctx_again_${randomUUID()}`, conversation.conversationId, contextFailed,
        JSON.stringify({ reason: 'write-authorization-changed', message: 'second pre-dispatch failure' }), Date.now(),
      );
      expect(db.prepare('SELECT status FROM outbox WHERE dispatch_key = ?').get(firstKey)).toEqual({ status: 'done' });
      expect(db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get(contextFailed)).toEqual({ c: 0 });
      expect(db.prepare('SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE r.task_id = ?').get(contextFailed)).toEqual({ c: 0 });

      const secondRecovery = await raw<{ enqueued: boolean; dispatchKey: string; sourceRunId: string | null }>('task.redispatch', {
        taskId: contextFailed,
        reason: '第二次私信中断恢复',
      });
      expect(secondRecovery.ok).toBe(true);
      expect(secondRecovery.data).toMatchObject({ enqueued: true, sourceRunId: null });
      const secondKey = secondRecovery.data!.dispatchKey;
      expect(secondKey).toMatch(new RegExp(`^task:${contextFailed}:redispatch:unstarted_[0-9a-f-]{36}$`));
      expect(secondKey).not.toBe(firstKey);

      const pendingDuringSecond = await raw('task.redispatch', {
        taskId: contextFailed,
        reason: '第三次不得与第二次并行',
      });
      expect(pendingDuringSecond.ok).toBe(false);
      expect(pendingDuringSecond.error?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(db.prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key GLOB ?`)
        .get(`task:${contextFailed}:redispatch:*`)).toEqual({ c: 2 });

      expect(db.prepare(`SELECT root_message_id, input_through_seq, project_id, conversation_id,
        room_id, conversation_thread_id, route_json FROM tasks WHERE id = ?`).get(contextFailed)).toEqual(taskBefore);
      expect(db.prepare('SELECT id, body_json FROM messages WHERE id = (SELECT root_message_id FROM tasks WHERE id = ?)').get(contextFailed)).toEqual(messageBefore);
      expect(db.prepare('SELECT count(*) c FROM messages WHERE conversation_id = ?').get(conversation.conversationId)).toEqual(messageCountBefore);
      expect(db.prepare('SELECT * FROM project_members WHERE id = ?').get('mA')).toEqual(memberBefore);
      expect(db.prepare('SELECT * FROM projects WHERE id = ?').get('p1')).toEqual(projectBefore);

      // A real source run keeps the existing source-qualified recovery key.
      const sourceConversation = await cmd<{ conversationId: string }>('conversation.create', {
        projectId: 'p1', peerMemberId: 'mA', title: 'source-run 键回归',
      });
      const sourceTask = await cmd<{ taskId: string }>('message.submit', {
        target: { kind: 'dm', projectId: 'p1', conversationId: sourceConversation.conversationId },
        body: '有来源 run 的恢复',
        intent: 'default',
        mentions: [],
      });
      db.prepare('UPDATE outbox SET status = ? WHERE dispatch_key = ?').run('done', `dmtask:${sourceTask.taskId}:initial`);
      const sourceRunId = `run_${randomUUID()}`;
      db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status)
        VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(sourceRunId, sourceTask.taskId, sourceConversation.conversationId);
      const sourceRecovery = await cmd<{ dispatchKey: string; sourceRunId: string | null }>('task.redispatch', {
        taskId: sourceTask.taskId,
        sourceRunId,
        reason: '有来源 run 的恢复',
      });
      expect(sourceRecovery.dispatchKey).toBe(`task:${sourceTask.taskId}:redispatch:${sourceRunId}`);
      expect(sourceRecovery.sourceRunId).toBe(sourceRunId);

      // UNKNOWN remains non-recoverable: no redispatch intent is created.
      const unknownConversation = await cmd<{ conversationId: string }>('conversation.create', {
        projectId: 'p1', peerMemberId: 'mA', title: 'UNKNOWN 守卫',
      });
      const unknownTask = await cmd<{ taskId: string }>('message.submit', {
        target: { kind: 'dm', projectId: 'p1', conversationId: unknownConversation.conversationId },
        body: 'UNKNOWN 不得恢复',
        intent: 'default',
        mentions: [],
      });
      db.prepare('UPDATE outbox SET status = ? WHERE dispatch_key = ?').run('done', `dmtask:${unknownTask.taskId}:initial`);
      const unknownRunId = `run_${randomUUID()}`;
      const unknownTurnId = `turn_${randomUUID()}`;
      db.transaction(() => {
        db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, task_revision, status)
          VALUES (?, ?, ?, 'DIRECT', 0, 'INTERRUPTED')`).run(unknownRunId, unknownTask.taskId, unknownConversation.conversationId);
        db.prepare(`INSERT INTO agent_turns
          (id, run_id, conversation_id, member_id, stage_key, status, dispatch_key, attempt, epoch)
          VALUES (?, ?, ?, 'mA', 'direct.work', 'UNKNOWN', ?, 1, 1)`).run(
          unknownTurnId, unknownRunId, unknownConversation.conversationId, `dmtask:${unknownTask.taskId}:initial`,
        );
      })();
      const unknownRejected = await raw('task.redispatch', {
        taskId: unknownTask.taskId,
        reason: 'UNKNOWN 显式恢复仍须先对账',
      });
      expect(unknownRejected.ok).toBe(false);
      expect(unknownRejected.error?.code).toBe('RECONCILE_REQUIRED');
      expect(db.prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key GLOB ?`)
        .get(`task:${unknownTask.taskId}:redispatch*`)).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });
});
