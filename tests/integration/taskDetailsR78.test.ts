import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../../src/contracts/prompts.ts';
import type { TaskDetailsResult } from '../../src/contracts/taskDetails.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_REAL_DISPATCH_GUARD;
delete process.env.ZS_REAL_BATCH_ID;
const root = mkdtempSync(join(tmpdir(), 'zs-r78-details-'));
mkdirSync(join(root, 'app'), { recursive: true });
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(root, { recursive: true, force: true }); break; } catch { /* Windows handle delay */ } } });

function fixture(scripts?: FakeTurnScript[]) {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?, '{}', 0)`).run(root, root);
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','执行甲','agent',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r0','p1','大厅','mA')`).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r0','mA')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_room','p1','room','r0')`).run();
  db.prepare(`UPDATE projects SET task_review_enabled = 1 WHERE id = 'p1'`).run();
  const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: join(root, 'app') };
  const raw = (method: string, params: unknown, commandId = `r78-${randomUUID().slice(0, 8)}`) => dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method, params }) as Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  const script: FakeTurnScript = [
    { kind: 'event', event: { kind: 'tool.started', toolCallId: 'read_1', toolName: 'Read', argumentsSummary: '' } },
    { kind: 'event', event: { kind: 'tool.completed', toolCallId: 'read_1', outcome: 'success' } },
    { kind: 'event', event: { kind: 'usage.updated', accounting: 'cumulative', inputTokens: 7, cachedTokens: 0, outputTokens: 3, costQuality: 'unknown' } },
    { kind: 'event', event: { kind: 'message.completed', messageId: 'm-r78', text: '完成' } },
    { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'r78', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
  ];
  const queue = [...(scripts ?? [])];
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => queue.shift() ?? script });
  return { db, raw, worker: () => new DispatchWorker({ db, adapter, leaseOwner: 'r78-worker', appDataDir: join(root, 'app') }), close: () => { void adapter.closeAllSessions().catch(() => {}); db.close(); } };
}

describe('R78 task.details formal read projection', () => {
  it('exposes a persisted latest-run hint in room.pool and counts only audience-visible unfinished project work', async () => {
    const env = fixture([[{ kind: 'event', event: { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: '夹具失败', retryable: true } }]]);
    try {
      const sent = await env.raw('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '运行失败', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
      const taskId = (sent.data as { taskId: string }).taskId;
      await env.worker().runOnce();
      const latest = env.db.prepare('SELECT id, status FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId);
      const pool = (await env.raw('room.pool', { roomId: 'r0' })).data as { items: Array<{ taskId: string; taskStatus: string; latestRun: unknown }> };
      expect(pool.items.find((item) => item.taskId === taskId)).toMatchObject({ taskStatus: 'ACTIVE', latestRun: latest });
      expect(pool.items.find((item) => item.taskId === taskId)?.latestRun).toEqual(latest);
      expect((await env.raw('project.taskSummary', { projectId: 'p1' })).data).toEqual({ projectId: 'p1', unfinishedTasks: 1, activeTurns: 0 });
      env.db.prepare('UPDATE workflow_runs SET revision = 99 WHERE task_id = ?').run(taskId);
      env.db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('new_queued_run', ?, 'conv_room', 'DIRECT', 'QUEUED')`).run(taskId);
      const updatedPool = (await env.raw('room.pool', { roomId: 'r0' })).data as { items: Array<{ taskId: string; latestRun: unknown }> };
      expect(updatedPool.items.find((item) => item.taskId === taskId)?.latestRun).toEqual({ id: 'new_queued_run', status: 'QUEUED' });

      env.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('foreign_dm','p1','dm',NULL)`).run();
      env.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','foreign_dm','human','u_local'),('p1','foreign_dm','agent','mA')`).run();
      env.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, title, status) VALUES ('dm_task','p1','foreign_dm','dm_turn','私信任务','ACTIVE')`).run();
      env.db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, mode, status) VALUES ('dm_run','dm_task','foreign_dm','DIRECT','RUNNING')`).run();
      env.db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, member_id, stage_key, status) VALUES ('dm_turn','dm_run','foreign_dm','mA','direct.work','RUNNING')`).run();
      expect((await env.raw('project.taskSummary', { projectId: 'p1' })).data).toEqual({ projectId: 'p1', unfinishedTasks: 2, activeTurns: 1 });
      env.db.prepare(`UPDATE dm_participants SET principal_id = 'u_other' WHERE conversation_id = 'foreign_dm' AND principal_type = 'human'`).run();
      expect((await env.raw('project.taskSummary', { projectId: 'p1' })).data).toEqual({ projectId: 'p1', unfinishedTasks: 1, activeTurns: 0 });
    } finally { env.close(); }
  });

  it('shows the worker-created run, real turn, activity, usage and delivery with its persisted budget', async () => {
    const env = fixture();
    try {
      const sent = await env.raw('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '执行并交付', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
      expect(sent.ok).toBe(true);
      const taskId = (sent.data as { taskId: string }).taskId;
      await env.worker().runOnce();
      const counts = () => ({ runs: (env.db.prepare('SELECT count(*) c FROM workflow_runs').get() as { c: number }).c, turns: (env.db.prepare('SELECT count(*) c FROM agent_turns').get() as { c: number }).c });
      const before = counts();
      const result = await env.raw('task.details', { projectId: 'p1', taskId });
      expect(result.ok).toBe(true);
      const d = result.data as TaskDetailsResult;
      expect(d.task).toMatchObject({ id: taskId, projectId: 'p1', reviewPolicy: 'user_review', status: 'REVIEW' });
      expect(d.runs[0]).toMatchObject({ mode: 'DIRECT', status: 'SUCCEEDED' });
      const budgetRow = env.db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(d.runs[0]!.id) as { budget_json: string | null };
      expect(d.runs[0]!.budget).toEqual(budgetRow.budget_json == null ? null : JSON.parse(budgetRow.budget_json));
      expect(d.runs[0]!.turns).toEqual(expect.arrayContaining([expect.objectContaining({ memberId: 'mA', displayName: '执行甲', status: 'SUCCEEDED' })]));
      expect(d.runs[0]!.turns[0]!.usage.length).toBeGreaterThan(0);
      expect(d.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['tool.started', 'tool.completed']));
      expect(d.events.filter((e) => e.kind.startsWith('tool.')).map((e) => e.toolCallId)).toEqual(['read_1', 'read_1']);
      expect(d.deliveries[0]).toMatchObject({ reviewStatus: 'pending', revision: 1, locate: expect.stringMatching(/^#delivery=/) });
      const mine = (await env.raw('mine.pending', {})).data as { projects: Array<{ reviewTasks: Array<{ task_id: string; title: string; actionable: boolean }> }> };
      expect(mine.projects.flatMap((p) => p.reviewTasks)).toEqual(expect.arrayContaining([expect.objectContaining({ task_id: taskId, title: '执行并交付', actionable: true })]));
      expect(d.truncated).toEqual({ children: false, runs: false, events: false, deliveries: false, changeSets: false, artifacts: false });
      expect(counts()).toEqual(before);
      expect((await env.raw('task.details', { projectId: 'wrong', taskId })).error?.code).toBe('RESOURCE_NOT_FOUND');
      expect((await env.raw('task.details', { projectId: 'p1', taskId, runId: 'other-run' })).error?.code).toBe('RESOURCE_NOT_FOUND');
      const reviewed = await env.raw('task.review', { taskId, deliveryId: d.deliveries[0]!.id, deliveryRevision: d.deliveries[0]!.revision, manifestHash: d.deliveries[0]!.manifestHash, decision: 'accept' });
      expect(reviewed.ok).toBe(true);
      const afterReview = (await env.raw('task.details', { projectId: 'p1', taskId, runId: d.runs[0]!.id })).data as TaskDetailsResult;
      expect(afterReview.task.status).toBe('DONE');
      expect(afterReview.deliveries[0]).toMatchObject({ id: d.deliveries[0]!.id, reviewStatus: 'accepted' });
      expect(afterReview.runs[0]!.status).toBe('SUCCEEDED');
      expect(counts()).toEqual(before);
    } finally { env.close(); }
  });

  it('rechecks DM audience on each read and denies a known task after participation is revoked', async () => {
    const env = fixture();
    try {
      env.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('foreign_dm','p1','dm',NULL)`).run();
      env.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','foreign_dm','human','u_local'),('p1','foreign_dm','agent','mA')`).run();
      env.db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, title, status, review_policy) VALUES ('foreign_task','p1','foreign_dm','dm_turn','私信内容','OPEN','auto_deliver')`).run();
      expect((await env.raw('task.details', { projectId: 'p1', taskId: 'foreign_task' })).ok).toBe(true);
      env.db.prepare(`UPDATE dm_participants SET principal_id = 'u_other' WHERE conversation_id = 'foreign_dm' AND principal_type = 'human'`).run();
      const result = await env.raw('task.details', { projectId: 'p1', taskId: 'foreign_task' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('FORBIDDEN');
    } finally { env.close(); }
  });

  it('selects an older failed run and reads its own tools after a later event burst fills the task window', async () => {
    const failed: FakeTurnScript = [
      { kind: 'event', event: { kind: 'tool.started', toolCallId: 'first_read', toolName: 'Read', argumentsSummary: '' } },
      { kind: 'event', event: { kind: 'tool.completed', toolCallId: 'first_read', outcome: 'failure' } },
      { kind: 'event', event: { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: '夹具失败', retryable: true } },
    ];
    const burst: FakeTurnScript = [
      ...Array.from({ length: 125 }, (_, i) => [
        { kind: 'event' as const, event: { kind: 'tool.started' as const, toolCallId: `next_${i}`, toolName: 'Read', argumentsSummary: '' } },
        { kind: 'event' as const, event: { kind: 'tool.completed' as const, toolCallId: `next_${i}`, outcome: 'success' as const } },
      ]).flat(),
      { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({ schemaVersion: TASK_COMPLETE_SCHEMA_VERSION, resultKey: 'r78-next', changeSummary: '完成', files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [] }) } },
    ];
    const env = fixture([failed, burst]);
    try {
      const sent = await env.raw('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '先失败再继续', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
      expect(sent.ok).toBe(true);
      const taskId = (sent.data as { taskId: string }).taskId;
      await env.worker().runOnce();
      const first = (await env.raw('task.details', { projectId: 'p1', taskId })).data as TaskDetailsResult;
      expect(first.task.status).toBe('ACTIVE');
      expect(first.currentRunId).toBeNull();
      expect(first.latestRunId).toBe(first.runs[0]!.id);
      expect(first.runs[0]!.status).toBe('FAILED');
      const retry = await env.raw('task.redispatch', { taskId, sourceRunId: first.latestRunId, reason: '检查诊断后明确继续' });
      expect(retry.ok).toBe(true);
      await env.worker().runOnce();
      const selected = (await env.raw('task.details', { projectId: 'p1', taskId, runId: first.latestRunId })).data as TaskDetailsResult;
      expect(selected.latestRunId).not.toBe(first.latestRunId);
      expect(selected.selectedRunId).toBe(first.latestRunId);
      expect(selected.currentRunId).toBeNull();
      expect(selected.runs.map((r) => r.id)).toEqual([selected.latestRunId, first.latestRunId]);
      expect(selected.truncated.events).toBe(true);
      expect(selected.events.some((e) => e.toolCallId === 'first_read')).toBe(false);
      expect(selected.runs.find((r) => r.id === first.latestRunId)?.events.map((e) => e.toolCallId)).toContain('first_read');
      // R79 unselected summaries are unread, not authoritative empty details.
      expect(selected.runs.find((r) => r.id === selected.latestRunId)?.detailLoaded).toBe(false);
      const latestDetails = (await env.raw('task.details', { projectId: 'p1', taskId })).data as TaskDetailsResult;
      expect(latestDetails.runs.find((r) => r.id === selected.latestRunId)?.eventsTruncated).toBe(true);
      expect(selected.runs.find((r) => r.id === first.latestRunId)?.eventsTruncated).toBe(false);
    } finally { env.close(); }
  });

  it('uses creation order for a rework run even when an older run has a higher entity revision', async () => {
    const env = fixture();
    try {
      const sent = await env.raw('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '交付后返工', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
      expect(sent.ok).toBe(true);
      const taskId = (sent.data as { taskId: string }).taskId;
      await env.worker().runOnce();
      const first = (await env.raw('task.details', { projectId: 'p1', taskId })).data as TaskDetailsResult;
      const source = first.runs[0]!;
      const delivery = first.deliveries[0]!;
      const review = await env.raw('task.review', { taskId, deliveryId: delivery.id, deliveryRevision: delivery.revision,
        manifestHash: delivery.manifestHash, decision: 'changes_requested', note: '请补充说明' });
      expect(review.ok).toBe(true);
      const rework = await env.raw('task.executeRework', { taskId, deliveryId: delivery.id, deliveryRevision: delivery.revision,
        manifestHash: delivery.manifestHash, sourceRunId: source.id, reason: '明确执行返工' });
      expect(rework.ok).toBe(true);
      // Revision is per run, not task-wide chronology. Raise only this metadata to emulate a
      // multi-stage old run; both deliveries and run outcomes still come from the formal worker.
      env.db.prepare('UPDATE workflow_runs SET revision = 99 WHERE id = ?').run(source.id);
      await env.worker().runOnce();
      const detail = (await env.raw('task.details', { projectId: 'p1', taskId, runId: source.id })).data as TaskDetailsResult;
      expect(detail.deliveries.map((d) => d.revision)).toEqual([2, 1]);
      expect(detail.runs[0]!.id).not.toBe(source.id);
      expect(detail.runs[0]!.revision).toBeLessThan(99);
      expect(detail.runs[1]).toMatchObject({ id: source.id, revision: 99 });
      expect(detail.latestRunId).toBe(detail.runs[0]!.id);
      expect(detail.selectedRunId).toBe(source.id);
    } finally { env.close(); }
  });

  it('keeps an explicitly selected old run visible beyond the bounded 20-run window', async () => {
    const fail: FakeTurnScript = [{ kind: 'event', event: { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: '夹具失败', retryable: true } }];
    const env = fixture(Array.from({ length: 21 }, () => fail));
    try {
      const sent = await env.raw('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '多次失败的历史窗口', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
      expect(sent.ok).toBe(true);
      const taskId = (sent.data as { taskId: string }).taskId;
      let oldest: string | null = null;
      for (let i = 0; i < 21; i += 1) {
        await env.worker().runOnce();
        const latest = (await env.raw('task.details', { projectId: 'p1', taskId })).data as TaskDetailsResult;
        expect(latest.task.status).toBe('ACTIVE');
        if (i === 0) oldest = latest.latestRunId;
        if (i < 20) expect((await env.raw('task.redispatch', { taskId, sourceRunId: latest.latestRunId, reason: `第 ${i + 1} 次明确继续` })).ok).toBe(true);
      }
      const selected = (await env.raw('task.details', { projectId: 'p1', taskId, runId: oldest })).data as TaskDetailsResult;
      expect(selected.truncated.runs).toBe(true);
      expect(selected.runs).toHaveLength(21); // newest 20 plus the requested old run
      expect(selected.runs[0]!.id).toBe(selected.latestRunId);
      expect(selected.runs.at(-1)!.id).toBe(oldest);
      expect(selected.selectedRunId).toBe(oldest);
    } finally { env.close(); }
  });

  it('retries a FAILED task only from an explicit frozen snapshot and rejects stale run/task/stop identities', async () => {
    const fail: FakeTurnScript = [{ kind: 'event', event: { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: '夹具失败', retryable: true } }];
    const env = fixture([fail]);
    try {
      const sent = await env.raw('message.submit', { target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room', roomId: 'r0' }, body: '失败后显式继续', intent: 'default', mentions: [{ kind: 'member', memberId: 'mA' }] });
      expect(sent.ok).toBe(true);
      const taskId = (sent.data as { taskId: string }).taskId;
      await env.worker().runOnce();
      const before = (await env.raw('task.details', { projectId: 'p1', taskId })).data as TaskDetailsResult;
      expect(before.task.status).toBe('ACTIVE');
      expect(before.runs[0]!.status).toBe('FAILED');
      expect(before.failedRetry).toEqual({ available: true, pending: false, blockReason: null });
      const snap = { taskId, sourceRunId: before.latestRunId, expectedTaskRevision: before.task.revision,
        expectedStopGeneration: before.task.stopGeneration, expectedRunStatus: 'FAILED', reason: '用户明确继续' };
      expect((await env.raw('task.redispatch', { ...snap, expectedStopGeneration: 1 })).error?.code).toBe('STALE_REVISION');
      expect((await env.raw('task.redispatch', { ...snap, expectedTaskRevision: before.task.revision + 1 })).error?.code).toBe('STALE_REVISION');
      expect((env.db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key GLOB 'task:*:redispatch*'").get() as { c: number }).c).toBe(0);
      expect((await env.raw('task.redispatch', snap)).ok).toBe(true);
      const pending = (await env.raw('task.details', { projectId: 'p1', taskId })).data as TaskDetailsResult;
      expect(pending.failedRetry).toEqual({ available: false, pending: true, blockReason: null });
      expect((await env.raw('task.redispatch', snap)).ok).toBe(false);
      await env.worker().runOnce();
      const after = (await env.raw('task.details', { projectId: 'p1', taskId })).data as TaskDetailsResult;
      expect(after.latestRunId).not.toBe(before.latestRunId);
      expect(after.runs[0]!.status).toBe('SUCCEEDED');
      const runCount = (env.db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get(taskId) as { c: number }).c;
      expect((await env.raw('task.redispatch', snap)).error?.code).toBe('STALE_REVISION');
      expect((env.db.prepare('SELECT count(*) c FROM workflow_runs WHERE task_id = ?').get(taskId) as { c: number }).c).toBe(runCount);
    } finally { env.close(); }
  });

  it('lists only the viewer DM failed task with retry identity; foreign DM cannot query or redispatch it', async () => {
    const fail: FakeTurnScript = [{ kind: 'event', event: { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: '私信失败', retryable: true } }];
    const env = fixture([fail]);
    try {
      env.db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_retry','p1','dm',NULL)`).run();
      env.db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_retry','human','u_local'),('p1','dm_retry','agent','mA')`).run();
      const sent = await env.raw('message.submit', { target: { kind: 'dm', projectId: 'p1', conversationId: 'dm_retry' }, body: '私信失败后继续', intent: 'default', mentions: [] });
      expect(sent.ok).toBe(true);
      const taskId = (sent.data as { taskId: string }).taskId;
      await env.worker().runOnce();
      const listed = await env.raw('conversation.failedTasks', { projectId: 'p1', conversationId: 'dm_retry' });
      expect(listed.ok).toBe(true);
      const items = (listed.data as { items: Array<{ taskId: string; latestRunId: string; available: boolean; taskRevision: number; stopGeneration: number }> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ taskId, available: true, stopGeneration: 0 });
      const snapshot = { taskId, sourceRunId: items[0]!.latestRunId, expectedTaskRevision: items[0]!.taskRevision,
        expectedStopGeneration: items[0]!.stopGeneration, expectedRunStatus: 'FAILED', reason: '私信中明确继续' };
      const retryCommandId = `r78-dm-retry-${randomUUID().slice(0, 8)}`;
      expect((await env.raw('task.redispatch', snapshot, retryCommandId)).ok).toBe(true);
      const queued = await env.raw('conversation.failedTasks', { projectId: 'p1', conversationId: 'dm_retry' });
      expect((queued.data as { items: Array<{ pending: boolean; available: boolean }> }).items[0]).toMatchObject({ pending: true, available: false });
      env.db.prepare(`UPDATE dm_participants SET principal_id = 'u_other' WHERE conversation_id = 'dm_retry' AND principal_type = 'human'`).run();
      expect((await env.raw('conversation.failedTasks', { projectId: 'p1', conversationId: 'dm_retry' })).error?.code).toBe('FORBIDDEN');
      expect((await env.raw('task.redispatch', snapshot)).error?.code).toBe('FORBIDDEN');
      expect((await env.raw('task.redispatch', snapshot, retryCommandId)).error?.code).toBe('FORBIDDEN');
    } finally { env.close(); }
  });
});
