import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { prepareDeliberation } from '../../src/daemon/deliberationRunner.ts';
import type { TopLevelRouteOutcome } from '../../src/contracts/routing.ts';
import { budgetAccounting, deriveDeliberateMaxTurns } from '../../src/contracts/deliberation.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r90-deliberation-budget-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('R90 task-frozen deliberation budget', () => {
  it('persists less/equal/greater/default caps, drives each run, and isolates runs', async () => {
    const file = join(root, 'state.sqlite');
    const db = openDatabase(file);
    const appDataDir = join(root, 'app');
    const projectRoot = join(root, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const blobDir = join(appDataDir, 'artifacts');
    const deps = { db, localUserId: 'u_budget', appDataDir, interruptTurn: async () => {} };
    let commandSequence = 0;
    const raw = async <T>(method: string, params: unknown) => await dispatchDaemonCommand(deps, {
      protocolVersion: 1,
      commandId: `r90-budget-${++commandSequence}-${randomUUID()}`,
      method,
      params,
    }) as { ok: boolean; data: T; error?: { code: string; message: string } };
    const cmd = async <T>(method: string, params: unknown): Promise<T> => {
      const response = await raw<T>(method, params);
      expect(response.ok, response.error?.message).toBe(true);
      return response.data;
    };

    let reopened: ReturnType<typeof openDatabase> | null = null;
    try {
      await cmd('app.settings.set', {key: 'callBudget.enabled', value: 'true'});
      const project = await cmd<{ project: { id: string } }>('project.open', { path: projectRoot });
      const firstMember = await cmd<{ memberId: string }>('member.create', {
        projectId: project.project.id,
        displayName: 'Synthetic A',
      });
      const secondMember = await cmd<{ memberId: string }>('member.create', {
        projectId: project.project.id,
        displayName: 'Synthetic B',
      });
      const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', {
        projectId: project.project.id,
      })).items[0]!;
      for (const memberId of [firstMember.memberId, secondMember.memberId]) {
        await cmd('room.members.set', { roomId: room.id, memberId, action: 'add' });
      }
      expect(deriveDeliberateMaxTurns(2, { expectsCheckpointRound3: true }).withRevision).toBe(17);

      const target = {
        kind: 'room_root' as const,
        projectId: project.project.id,
        conversationId: room.conversationId,
        roomId: room.id,
      };
      const mentions = [
        { kind: 'member' as const, memberId: firstMember.memberId },
        { kind: 'member' as const, memberId: secondMember.memberId },
      ];
      const submit = async (maxTurns?: number) => {
        const response = await raw<{
          taskId: string;
          threadId: string;
          conversationId: string;
          deliberationBudget?: { maxTurns: number };
        }>('message.submit', {
          target,
          body: `Synthetic deliberation ${maxTurns ?? 'default'}`,
          intent: 'default',
          mentions,
          collaboration: 'deliberate',
          ...(maxTurns == null ? {} : { deliberationBudget: { maxTurns } }),
        });
        expect(response.ok, response.error?.message).toBe(true);
        return response.data;
      };

      const cases = [
        { expected: 10, sent: await submit(10) },
        { expected: 14, sent: await submit(14) },
        { expected: 20, sent: await submit(20) },
        { expected: 17, sent: await submit() },
      ];
      const runIds: string[] = [];
      const frozenJsonByTask = new Map<string, string>();
      for (const item of cases) {
        expect(item.sent.deliberationBudget).toEqual({ maxTurns: item.expected });
        const taskRow = db.prepare(
          'SELECT route_json, deliberation_budget_json FROM tasks WHERE id=?',
        ).get(item.sent.taskId) as { route_json: string; deliberation_budget_json: string };
        expect(JSON.parse(taskRow.deliberation_budget_json)).toMatchObject({ maxTurns: item.expected, callBudget: {enforcement: 'enabled', limit: item.expected} });
        frozenJsonByTask.set(item.sent.taskId, taskRow.deliberation_budget_json);
        const route = JSON.parse(taskRow.route_json) as Extract<TopLevelRouteOutcome, { kind: 'dispatch'; mode: 'DELIBERATE' }>;
        expect(route.frozenMemberIds).toHaveLength(2);
        const prepared = prepareDeliberation(db, {
          id: item.sent.taskId,
          conversationId: item.sent.conversationId,
          threadId: item.sent.threadId,
        }, route, {
          absenceToleranceMs: 60_000,
          runMaxTurns: 499, // must be overridden by the task snapshot at INSERT
          blobDir,
        });
        expect(prepared.ok, prepared.ok ? '' : prepared.error.message).toBe(true);
        if (!prepared.ok) throw new Error(prepared.error.message);
        runIds.push(prepared.value.runId);
        const run = db.prepare(
          "SELECT budget_json FROM workflow_runs WHERE id=? AND task_id=? AND mode='DELIBERATE'",
        ).get(prepared.value.runId, item.sent.taskId) as { budget_json: string };
        const budget = JSON.parse(run.budget_json) as {
          runMaxTurns: number;
          usedTurns: number;
          inFlightReservedTurns: number;
          tailReservationByStage: { SYNTHESIS: number; RATIFY: number };
        };
        expect(budget).toMatchObject({
          runMaxTurns: item.expected,
          usedTurns: 0,
          inFlightReservedTurns: 0,
          tailReservationByStage: { SYNTHESIS: 1, RATIFY: 2 },
        });
        const front = budgetAccounting(budget, 'front');
        expect(front.tailReserved).toBe(3);
        expect(front.stageAvailableTurns).toBe(item.expected - 3);
        const taskGet = await cmd<{ task: { deliberationBudget: { maxTurns: number } | null } }>('task.get', {
          taskId: item.sent.taskId,
        });
        expect(taskGet.task.deliberationBudget).toEqual({ maxTurns: item.expected });
      }
      expect(new Set(runIds).size).toBe(4);
      expect(db.prepare(
        'SELECT count(DISTINCT budget_json) n FROM workflow_runs WHERE mode=?',
      ).get('DELIBERATE')).toEqual({ n: 4 });
      const firstRun = db.prepare(
        "SELECT budget_json FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE'",
      ).get(cases[0]!.sent.taskId) as { budget_json: string };
      expect((JSON.parse(firstRun.budget_json) as { runMaxTurns: number }).runMaxTurns).toBe(10);

      db.close();
      reopened = openDatabase(file);
      for (const item of cases) {
        expect(reopened.prepare(
          'SELECT deliberation_budget_json FROM tasks WHERE id=?',
        ).get(item.sent.taskId)).toEqual({ deliberation_budget_json: frozenJsonByTask.get(item.sent.taskId) });
      }
    } finally {
      try { db.close(); } catch { /* already closed for reopen */ }
      reopened?.close();
    }
  }, 60_000);

  it('rejects tail-insufficient and non-room budgets with actionable Chinese errors', async () => {
    const db = openDatabase(':memory:');
    const appDataDir = join(root, 'invalid-app');
    const deps = { db, localUserId: 'u_invalid_budget', appDataDir, interruptTurn: async () => {} };
    const raw = async <T>(method: string, params: unknown) => await dispatchDaemonCommand(deps, {
      protocolVersion: 1,
      commandId: `r90-invalid-${randomUUID()}`,
      method,
      params,
    }) as { ok: boolean; data: T; error?: { code: string; message: string } };
    const cmd = async <T>(method: string, params: unknown): Promise<T> => {
      const response = await raw<T>(method, params);
      expect(response.ok, response.error?.message).toBe(true);
      return response.data;
    };

    try {
      const invalidProjectRoot = join(root, 'invalid-project');
      mkdirSync(invalidProjectRoot, { recursive: true });
      const project = await cmd<{ project: { id: string } }>('project.open', { path: invalidProjectRoot });
      const firstMember = await cmd<{ memberId: string }>('member.create', { projectId: project.project.id, displayName: 'Synthetic A' });
      const secondMember = await cmd<{ memberId: string }>('member.create', { projectId: project.project.id, displayName: 'Synthetic B' });
      const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', { projectId: project.project.id })).items[0]!;
      await cmd('room.members.set', { roomId: room.id, memberId: firstMember.memberId, action: 'add' });
      await cmd('room.members.set', { roomId: room.id, memberId: secondMember.memberId, action: 'add' });
      const target = { kind: 'room_root' as const, projectId: project.project.id, conversationId: room.conversationId, roomId: room.id };
      const mentions = [
        { kind: 'member' as const, memberId: firstMember.memberId },
        { kind: 'member' as const, memberId: secondMember.memberId },
      ];
      const before = db.prepare('SELECT count(*) n FROM messages').get();
      const low = await raw('message.submit', {
        target,
        body: 'Synthetic too small',
        intent: 'default',
        mentions,
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 2 },
      });
      expect(low.ok).toBe(false);
      expect(low.error?.code).toBe('VALIDATION_INVALID');
      expect(low.error?.message).toContain('至少需要 3 次');
      expect(db.prepare('SELECT count(*) n FROM messages').get()).toEqual(before);
      const tooLarge = await raw('message.submit', {
        target,
        body: 'Synthetic too large',
        intent: 'default',
        mentions,
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 501 },
      });
      expect(tooLarge.ok).toBe(false);
      expect(tooLarge.error?.code).toBe('VALIDATION_INVALID');
      expect(tooLarge.error?.message).toContain('2 到 500');

      const dm = await cmd<{ conversationId: string }>('conversation.create', {
        projectId: project.project.id,
        peerMemberId: firstMember.memberId,
      });
      const dmRejected = await raw('message.submit', {
        target: { kind: 'dm', projectId: project.project.id, conversationId: dm.conversationId },
        body: 'Synthetic DM budget',
        intent: 'default',
        mentions: [],
        deliberationBudget: { maxTurns: 10 },
      });
      expect(dmRejected.ok).toBe(false);
      expect(dmRejected.error?.code).toBe('VALIDATION_INVALID');
      expect(dmRejected.error?.message).toContain('只适用于房间独立研讨');
    } finally {
      db.close();
    }
  }, 30_000);
});
