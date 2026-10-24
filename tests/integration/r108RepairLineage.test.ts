import type {MessageRepairLineage} from '../../src/contracts/repairLineage.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import {
  readMessageRepairLineage,
  readMessageRepairLineages,
} from '../../src/daemon/repairLineage.ts';
import { openDatabase } from '../../src/persistence/db.ts';

afterEach(() => vi.unstubAllEnvs());

interface HistoryItem {
  repairLineage?:MessageRepairLineage|null;
  id: string;
  authorType: string;
  body: { text?: string; runtimeControlResult?: string };
}

describe('R108 authoritative format-repair lineage', () => {
  it('binds the same source output and repair output through formal command -> worker -> history query', async () => {
    vi.stubEnv('ZS_ALLOW_FAKE', '1');
    vi.stubEnv('ZS_RUNTIME', 'fake');
    const root = mkdtempSync(join(tmpdir(), 'zs-r108-lineage-'));
    const projectPath = join(root, 'project');
    mkdirSync(projectPath);
    const db = openDatabase(':memory:');
    const originalText = `原始失败结论\n${'原答保留9970字。'.repeat(1000)}`;
    const repairedText = `补交有效结论\n${'补交8315字。'.repeat(1000)}`;
    let phase = 0;
    let capturedRepairInput = '';
    const adapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (input): FakeTurnScript => {
        phase += 1;
        const resultKey = input.text.match(/resultKey=([^；\n]+)/)?.[1]
          ?? input.text.match(/"resultKey":"(result_[^"]+)"/)?.[1]
          ?? 'result_unknown';
        if (phase === 1) {
          const invalid = JSON.stringify({
            schemaVersion: 'task-complete-v1',
            resultKey,
            responseKind: 'work',
            answer: originalText,
            changeSummary: originalText,
            files: [],
            executedVerifications: [],
            unexecutedVerifications: [],
            remainingIssues: [],
            conclusions: ['该附加字段令原始输出无效'],
          });
          return [
            { kind: 'event', event: { kind: 'message.completed', messageId: 'original_failed', text: invalid } },
            { kind: 'event', event: { kind: 'turn.completed', finalText: invalid } },
          ];
        }
        capturedRepairInput = input.text;
        const repaired = JSON.stringify({
          schemaVersion: 'task-complete-v1',
          resultKey,
          responseKind: 'work',
          answer: repairedText,
          changeSummary: repairedText,
          files: [],
          executedVerifications: [],
          unexecutedVerifications: [],
          remainingIssues: [],
        });
        return [
          { kind: 'event', event: { kind: 'message.completed', messageId: 'repair_succeeded', text: repaired } },
          { kind: 'event', event: { kind: 'turn.completed', finalText: repaired } },
        ];
      },
    });
    const worker = new DispatchWorker({
      db,
      adapter,
      leaseOwner: 'r108-worker',
      appDataDir: root,
    });
    const cmd = async <T>(method: string, params: unknown): Promise<T> => {
      const result = await dispatchDaemonCommand(
        {
          db,
          localUserId: 'r108-user',
          appDataDir: root,
          interruptTurn: (turnId) => worker.interruptTurn(turnId),
        },
        { protocolVersion: 1, commandId: randomUUID(), method, params },
      ) as { ok: boolean; data?: T; error?: unknown };
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data as T;
    };

    try {
      const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projectPath })).project.id;
      const room = (await cmd<{ items: Array<{ id: string; conversationId: string; revision: number }> }>(
        'room.list',
        { projectId },
      )).items[0]!;
      const memberId = (await cmd<{ memberId: string }>(
        'member.create',
        { projectId, displayName: '补交来源成员' },
      )).memberId;
      await cmd('member.setRuntime', {
        memberId,
        kind: 'fake',
        permissionMode: 'bypassPermissions',
      });
      await cmd('room.update', {
        roomId: room.id,
        expectedRevision: room.revision,
        coordinatorMemberId: memberId,
      });

      const submitted = await cmd<{ taskId: string; threadId: string }>('message.submit', {
        target: {
          kind: 'room_root',
          projectId,
          roomId: room.id,
          conversationId: room.conversationId,
        },
        body: '请形成可交付结论',
        intent: 'default',
        mentions: [{ kind: 'member', memberId }],
      });
      await worker.runOnce();
      expect(db.prepare('SELECT status FROM agent_turns ORDER BY rowid DESC LIMIT 1').get())
        .toEqual({ status: 'FAILED' });
      const firstHistory = await cmd<{ items: HistoryItem[] }>('thread.history', {
        threadId: submitted.threadId,
        limit: 20,
      });
      const original = firstHistory.items.find((item) => item.authorType === 'agent');
      expect(original).toBeDefined();
      expect(original!.body.runtimeControlResult?.length ?? original!.body.text?.length ?? 0).toBeGreaterThan(9000);

      await cmd('task.redispatch', {
        taskId: submitted.taskId,
        formatRepair: true,
        reason: 'R108 source-to-repair lineage regression',
      });
      await worker.runOnce();

      const workitem = db.prepare(
        `SELECT id, source_turn_id, consumed_turn_id, status, source_output_text
         FROM format_repair_workitems WHERE task_id=?`,
      ).get(submitted.taskId) as {
        id: string;
        source_turn_id: string;
        consumed_turn_id: string;
        status: string;
        source_output_text: string;
      };
      expect(workitem.status).toBe('consumed');
      expect(workitem.source_output_text.length).toBeGreaterThan(9000);
      expect(capturedRepairInput.length).toBeGreaterThan(9000);
      expect(capturedRepairInput).toContain('原答保留9970字。'.repeat(100));

      const finalHistory = await cmd<{ items: HistoryItem[] }>('thread.history', {
        threadId: submitted.threadId,
        limit: 20,
      });
      const replacement = finalHistory.items.find((item) => {
        if (item.id === original!.id || typeof item.body.runtimeControlResult !== 'string') return false;
        try {
          const control = JSON.parse(item.body.runtimeControlResult) as { resultKey?: unknown };
          return control.resultKey === `result_${workitem.source_turn_id}`;
        } catch {
          return false;
        }
      });
      expect(replacement).toBeDefined();
      expect((replacement!.body.text ?? '').length).toBeGreaterThan(8000);
      expect(finalHistory.items.filter((item) => item.authorType === 'agent')).toHaveLength(2);

      const sourceLineage = readMessageRepairLineage(db, original!.id);
      const replacementLineage = readMessageRepairLineage(db, replacement!.id);
      expect(sourceLineage).toMatchObject({
        state: 'repaired',
        messageRole: 'source',
        sourceMessageId: original!.id,
        replacementMessageId: replacement!.id,
        projectId,
        conversationId: room.conversationId,
        threadId: submitted.threadId,
        taskId: submitted.taskId,
        sourceTurnId: workitem.source_turn_id,
        repairTurnId: workitem.consumed_turn_id,
        memberId,
      });
      expect(finalHistory.items.find(item=>item.id===original!.id)?.repairLineage).toEqual(sourceLineage);
      expect(finalHistory.items.find(item=>item.id===replacement!.id)?.repairLineage).toEqual(replacementLineage);
      const page=await cmd<{items:HistoryItem[]}>('thread.history',{threadId:submitted.threadId,limit:1});
      expect(page.items[0]?.repairLineage?.state).toBe('repaired');
      expect(sourceLineage?.sourceRunId).not.toBe(sourceLineage?.repairRunId);
      expect(replacementLineage).toMatchObject({
        state: 'repaired',
        messageRole: 'replacement',
        sourceMessageId: original!.id,
        replacementMessageId: replacement!.id,
      });
      expect(readMessageRepairLineages(db, [original!.id, replacement!.id])).toEqual(new Map([
        [original!.id, sourceLineage],
        [replacement!.id, replacementLineage],
      ]));

      const intermediateId = `msg_${workitem.source_turn_id}_handoff_only`;
      db.prepare(
        `INSERT INTO messages
           (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
            thread_message_seq, author_type, author_id, body_json, status, created_at)
         SELECT ?, project_id, conversation_id,
                (SELECT COALESCE(MAX(conversation_seq),0)+1 FROM messages),
                room_id, thread_id, task_id,
                (SELECT COALESCE(MAX(thread_message_seq),0)+1 FROM messages WHERE thread_id=?),
                'agent', ?, ?, 'final', ?
         FROM messages WHERE id=?`,
      ).run(
        intermediateId,
        submitted.threadId,
        memberId,
        JSON.stringify({ text: '中间交接消息不能被当成原答或补交答' }),
        Date.now(),
        original!.id,
      );
      expect(readMessageRepairLineage(db, intermediateId)).toBeNull();

      const repairRunId = sourceLineage?.repairRunId;
      expect(repairRunId).toBeTruthy();
      const setTurnStatus = (status: string): void => {
        db.prepare('UPDATE agent_turns SET status=? WHERE id=?').run(status, workitem.consumed_turn_id);
      };
      const setRunStatus = (status: string): void => {
        db.prepare('UPDATE workflow_runs SET status=? WHERE id=?').run(status, repairRunId);
      };
      const batchFromFormalHistory = async (): Promise<Map<string, NonNullable<ReturnType<typeof readMessageRepairLineage>>>> => {
        const history = await cmd<{ items: HistoryItem[] }>('thread.history', {
          threadId: submitted.threadId,
          limit: 40,
        });
        return readMessageRepairLineages(db, history.items.map((item) => item.id));
      };

      db.prepare(
        `UPDATE format_repair_workitems
         SET status='pending', consumed_turn_id=NULL
         WHERE id=?`,
      ).run(workitem.id);
      const queued = await batchFromFormalHistory();
      expect(queued.get(original!.id)).toMatchObject({
        state: 'pending',
        repairTurnId: null,
        repairRunId: null,
        replacementMessageId: null,
      });
      expect(queued.has(replacement!.id)).toBe(false);
      db.prepare(
        `UPDATE format_repair_workitems
         SET status='consumed', consumed_turn_id=?
         WHERE id=?`,
      ).run(workitem.consumed_turn_id, workitem.id);

      for (const [turnStatus, runStatus] of [
        ['PENDING', 'QUEUED'],
        ['RUNNING', 'RUNNING'],
        ['RUNNING', 'WAITING'],
        ['WAITING_INPUT', 'RUNNING'],
        ['STOPPING', 'STOPPING'],
      ] as const) {
        setTurnStatus(turnStatus);
        setRunStatus(runStatus);
        const inFlight = await batchFromFormalHistory();
        expect(inFlight.get(original!.id)).toMatchObject({
          state: 'pending',
          repairTurnId: workitem.consumed_turn_id,
          repairRunId,
          replacementMessageId: null,
          messageRole: 'source',
        });
        expect(inFlight.has(replacement!.id)).toBe(false);
      }

      setTurnStatus('FAILED');
      setRunStatus('FAILED');
      const failedHistory = await batchFromFormalHistory();
      expect(failedHistory.get(original!.id)).toMatchObject({
        state: 'failed',
        repairTurnId: workitem.consumed_turn_id,
        repairRunId,
        replacementMessageId: null,
        messageRole: 'source',
      });
      expect(failedHistory.has(replacement!.id)).toBe(false);

      setTurnStatus('UNKNOWN');
      setRunStatus('INTERRUPTED');
      const unknownHistory = await batchFromFormalHistory();
      expect(unknownHistory.get(original!.id)).toMatchObject({
        state: 'unknown',
        repairTurnId: workitem.consumed_turn_id,
        repairRunId,
        replacementMessageId: null,
        messageRole: 'source',
      });
      expect(unknownHistory.has(replacement!.id)).toBe(false);

      setTurnStatus('SUCCEEDED');
      setRunStatus('SUCCEEDED');
      const succeededHistory = await batchFromFormalHistory();
      expect(succeededHistory.get(original!.id)).toMatchObject({
        state: 'repaired',
        messageRole: 'source',
        replacementMessageId: replacement!.id,
      });
      expect(succeededHistory.get(replacement!.id)).toMatchObject({
        state: 'repaired',
        messageRole: 'replacement',
        sourceMessageId: original!.id,
      });

      const otherMemberId = 'member_r108_other';
      db.prepare(
        `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
         VALUES (?, ?, '无关成员', 'agent', 1)`,
      ).run(otherMemberId, projectId);
      db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)').run(room.id, otherMemberId);
      db.prepare('UPDATE agent_turns SET member_id=? WHERE id=?').run(otherMemberId, workitem.consumed_turn_id);
      expect(readMessageRepairLineage(db, original!.id)).toMatchObject({
        state: 'unknown',
        replacementMessageId: null,
      });
      db.prepare('UPDATE agent_turns SET member_id=? WHERE id=?').run(memberId, workitem.consumed_turn_id);

      const replyEvent = db.prepare(
        `SELECT event_id FROM domain_events
         WHERE kind='thread.replyAdded' AND turn_id=?
         ORDER BY seq DESC LIMIT 1`,
      ).get(workitem.consumed_turn_id) as { event_id: string };
      db.prepare('UPDATE domain_events SET task_id=? WHERE event_id=?').run('task_wrong_scope', replyEvent.event_id);
      expect(readMessageRepairLineage(db, original!.id)).toMatchObject({
        state: 'unknown',
        replacementMessageId: null,
      });
    } finally {
      await adapter.closeAllSessions();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
