import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';

afterEach(() => vi.unstubAllEnvs());

const done = (payload: string): FakeTurnScript => [
  { kind: 'event', event: { kind: 'turn.completed', finalText: payload } },
];

const directDone = (answer: string): FakeTurnScript => done(JSON.stringify({
  schemaVersion: 'task-complete-v1',
  resultKey: 'fixture',
  responseKind: 'conversation',
  answer,
  changeSummary: answer,
  files: [],
  executedVerifications: [],
  unexecutedVerifications: [],
  remainingIssues: [],
}));

function deliberationSequencer(db: ReturnType<typeof openDatabase>, taskId: string) {
  return (input: { text: string }): FakeTurnScript => {
    const text = input.text;
    if (text.includes('"schemaVersion":"analysis-draft-v1"')) {
      return done(JSON.stringify({
        schemaVersion: 'analysis-draft-v1',
        summary: '本串独立分析',
        claims: [{
          claimId: 'c1',
          statement: '本轮回复串请求已被独立处理',
          kind: 'observed',
          evidenceIds: ['ev1'],
          uncertainty: '',
        }],
        recommendations: ['保持回复串历史不变'],
        openQuestions: [],
      }));
    }
    if (text.includes('"schemaVersion":"cross-review-v1"')) {
      const peer = /"artifactId"\s*:\s*"([^"]+)"[\s\S]*?"revision"\s*:\s*(\d+)[\s\S]*?"claimId"\s*:\s*"([^"]+)"/.exec(text);
      if (peer == null) throw new Error(`CR input missing frozen peer JSON: ${text.slice(0, 160)}`);
      return done(JSON.stringify({
        schemaVersion: 'cross-review-v1',
        reviews: [{
          targetArtifactId: peer[1],
          targetRevision: Number(peer[2]),
          targetClaimId: peer[3],
          stance: 'disagree',
          reason: '需要独立核对边界',
          evidenceIds: ['ev2'],
        }],
      }));
    }
    if (text.includes('"schemaVersion":"issue-position-v1"')) {
      const run = db.prepare(
        "SELECT id FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY rowid DESC LIMIT 1",
      ).get(taskId) as { id: string };
      const issue = db.prepare('SELECT id FROM issues WHERE run_id=? ORDER BY id LIMIT 1').get(run.id) as { id: string };
      return done(JSON.stringify({
        schemaVersion: 'issue-position-v1',
        positions: [{
          issueId: issue.id,
          stance: 'needs_evidence',
          reason: '保留分歧，交由整合如实记录',
          newEvidence: [],
        }],
      }));
    }
    if (text.includes('"schemaVersion":"checkpoint-verdict-v1"')) {
      return done(JSON.stringify({
        schemaVersion: 'checkpoint-verdict-v1',
        verdict: 'stop',
        reason: '没有新的可验证证据',
      }));
    }
    if (text.includes('"schemaVersion":"synthesis-v1"')) {
      return done(JSON.stringify({
        schemaVersion: 'synthesis-v1',
        summary: '线程独立研讨最终结论',
        claims: [{ statement: '线程请求已按独立研讨完成', sourceRefs: ['c1'] }],
        disputedClaims: [],
        recommendations: ['保留原线程根消息与锚点'],
      }));
    }
    if (text.includes('"schemaVersion":"ratify-v1"')) {
      const run = db.prepare(
        "SELECT id FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY rowid DESC LIMIT 1",
      ).get(taskId) as { id: string };
      const claims = db.prepare(
        'SELECT claim_id FROM synthesis_claims WHERE run_id=? ORDER BY claim_id',
      ).all(run.id) as Array<{ claim_id: string }>;
      return done(JSON.stringify({
        schemaVersion: 'ratify-v1',
        responses: claims.map((claim) => ({ claimId: claim.claim_id, stance: 'confirm' })),
      }));
    }
    throw new Error(`unexpected deliberation input: ${text.slice(0, 120)}`);
  };
}

async function fixture() {
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  vi.stubEnv('ZS_RUNTIME', 'fake');
  const dir = mkdtempSync(join(tmpdir(), 'zs-r90-thread-delib-'));
  const projectRoot = join(dir, 'project');
  mkdirSync(projectRoot);
  const db = openDatabase(join(dir, 'state.sqlite'));
  const deps = { db, localUserId: 'u_thread_delib', appDataDir: dir, interruptTurn: async () => {} };
  const raw = async <T>(method: string, params: unknown) => await dispatchDaemonCommand(deps, {
    protocolVersion: 1,
    commandId: randomUUID(),
    method,
    params,
  }) as { ok: boolean; data: T; error?: { code: string; message: string } };
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await raw<T>(method, params);
    expect(response.ok, response.error?.message).toBe(true);
    return response.data;
  };

  await cmd('app.settings.set', {key: 'callBudget.enabled', value: 'true'});
  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projectRoot })).project.id;
  const memberIds: string[] = [];
  for (const displayName of ['线程甲', '线程乙', '房间丙']) {
    memberIds.push((await cmd<{ memberId: string }>('member.create', { projectId, displayName })).memberId);
  }
  const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', { projectId })).items[0]!;
  for (const memberId of memberIds) await cmd('room.members.set', { roomId: room.id, memberId, action: 'add' });
  const root = await cmd<{ taskId: string; threadId: string; messageId: string }>('message.submit', {
    target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
    body: '线程原请求',
    intent: 'default',
    mentions: [{ kind: 'member', memberId: memberIds[0] }],
  });
  const rootWorker = new DispatchWorker({
    db,
    adapter: new FakeRuntimeAdapter({ turnScriptSequencer: () => directDone('线程原回复') }),
    leaseOwner: 'r90-thread-root',
    appDataDir: dir,
  });
  await rootWorker.runOnce();

  const beforeAdd = await cmd<{ members: { version: string } }>('thread.get', { threadId: root.threadId });
  await cmd('thread.members.change', {
    projectId,
    threadId: root.threadId,
    memberId: memberIds[1],
    action: 'add',
    expectedVersion: beforeAdd.members.version,
  });

  return { dir, db, raw, cmd, projectId, room, memberIds, root };
}

describe('R90 thread independent deliberation', () => {
  it('runs DELIBERATE on the existing thread, freezes each request budget, and publishes one final reply', async () => {
    const f = await fixture();
    try {
      // Simulate a root task that already carried a smaller room-root budget. The
      // thread request identity must stop 056 from overriding its own snapshot.
      f.db.prepare('UPDATE tasks SET deliberation_budget_json=? WHERE id=?')
        .run(JSON.stringify({ maxTurns: 3 }), f.root.taskId);

      const adapter = new FakeRuntimeAdapter({
        structuredFinal: false,
        turnScriptSequencer: deliberationSequencer(f.db, f.root.taskId),
      });
      const worker = new DispatchWorker({
        db: f.db,
        adapter,
        leaseOwner: 'r90-thread-delib',
        enableDeliberate: true,
        absenceToleranceMs: 60_000,
        appDataDir: f.dir,
      });
      const target = {
        kind: 'thread' as const,
        projectId: f.projectId,
        conversationId: f.room.conversationId,
        threadId: f.root.threadId,
      };
      const first = await f.cmd<{ messageId: string; taskId: string }>('message.submit', {
        target,
        body: '请在本串独立研讨',
        intent: 'default',
        mentions: [],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 10 },
      });
      const firstRequest = f.db.prepare(
        'SELECT route_json,deliberation_budget_json FROM thread_reply_requests WHERE message_id=?',
      ).get(first.messageId) as { route_json: string; deliberation_budget_json: string };
      expect(JSON.parse(firstRequest.route_json)).toMatchObject({
        kind: 'dispatch',
        mode: 'DELIBERATE',
        frozenMemberIds: [...f.memberIds.slice(0, 2)].sort(),
      });
      expect(JSON.parse(firstRequest.deliberation_budget_json)).toMatchObject({maxTurns: 10, callBudget: {enforcement: 'enabled', limit: 10}});
      expect(f.db.prepare(
        'SELECT deliberation_budget_json,dispatch_identity,result_message_id,status FROM thread_reply_requests WHERE message_id=?',
      ).get(first.messageId)).toMatchObject({
        deliberation_budget_json: firstRequest.deliberation_budget_json,
        dispatch_identity: expect.stringMatching(/^[a-f0-9]{64}$/),
        result_message_id: null,
        status: 'queued',
      });

      for (let i = 0; i < 30 && await worker.runOnce(); i += 1) { /* prepare + stages */ }
      const firstRun = f.db.prepare(
        "SELECT id,budget_json,status,stage FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE' ORDER BY rowid DESC LIMIT 1",
      ).get(f.root.taskId) as { id: string; budget_json: string; status: string; stage: string };
      expect((JSON.parse(firstRun.budget_json) as { runMaxTurns: number }).runMaxTurns).toBe(10);
      expect(firstRun).toMatchObject({ status: 'SUCCEEDED', stage: 'PUBLISH' });
      expect(adapter.startTurnLog.length).toBeGreaterThanOrEqual(7);
      expect(adapter.startTurnLog.every((turn) => turn.text.includes('请在本串独立研讨'))).toBe(true);

      const firstClosed = f.db.prepare(
        'SELECT run_id,status,result_message_id FROM thread_reply_requests WHERE message_id=?',
      ).get(first.messageId) as { run_id: string; status: string; result_message_id: string };
      expect(firstClosed).toMatchObject({ run_id: firstRun.id, status: 'succeeded' });
      expect(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(f.root.taskId)).toEqual({ status: 'DONE' });
      const history = await f.cmd<{ items: Array<{ id: string; authorId: string; body: { text: string } }> }>('thread.history', { threadId: f.root.threadId });
      const finalReply = history.items.find((item) => item.id === firstClosed.result_message_id)!;
      expect(finalReply.authorId).toBe(f.memberIds[0]!);
      expect(finalReply.body.text).toContain('线程独立研讨最终结论');
      expect(f.db.prepare(
        'SELECT anchor_message_id,root_task_id FROM conversation_threads WHERE id=?',
      ).get(f.root.threadId)).toEqual({
        anchor_message_id: f.root.messageId,
        root_task_id: f.root.taskId,
      });

      const second = await f.cmd<{ messageId: string }>('message.submit', {
        target,
        body: '@全体 第二轮研讨',
        intent: 'default',
        mentions: [{ kind: 'all' }],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 12 },
      });
      const secondRequest = f.db.prepare(
        'SELECT route_json,roster_json,deliberation_budget_json FROM thread_reply_requests WHERE message_id=?',
      ).get(second.messageId) as { route_json: string; roster_json: string; deliberation_budget_json: string };
      expect(JSON.parse(secondRequest.route_json)).toMatchObject({
        mode: 'DELIBERATE',
        rosterSource: 'all',
        frozenMemberIds: [...f.memberIds.slice(0, 2)].sort(),
      });
      expect(secondRequest.roster_json).not.toContain(f.memberIds[2]);
      expect(f.db.prepare('SELECT body_json FROM messages WHERE id=?').get(second.messageId)).toMatchObject({
        body_json: expect.stringContaining('@全体 第二轮研讨'),
      });

      for (let i = 0; i < 30 && await worker.runOnce(); i += 1) { /* second request */ }
      const runs = f.db.prepare(
        "SELECT id,budget_json,status FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE' ORDER BY rowid",
      ).all(f.root.taskId) as Array<{ id: string; budget_json: string; status: string }>;
      expect(runs).toHaveLength(2);
      expect(runs.map((run) => (JSON.parse(run.budget_json) as { runMaxTurns: number }).runMaxTurns)).toEqual([10, 12]);
      expect(new Set(runs.map((run) => run.id)).size).toBe(2);
      expect(runs.every((run) => run.status === 'SUCCEEDED')).toBe(true);
      expect(f.db.prepare(
        'SELECT status FROM thread_reply_requests ORDER BY rowid',
      ).all()).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
      expect(adapter.startTurnLog.every((turn) => !turn.text.includes(f.memberIds[2]!))).toBe(true);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects one/empty rosters and tail-insufficient budgets before writing a message or outbox row', async () => {
    const f = await fixture();
    try {
      const target = {
        kind: 'thread' as const,
        projectId: f.projectId,
        conversationId: f.room.conversationId,
        threadId: f.root.threadId,
      };
      const counts = () => ({
        messages: (f.db.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n,
        outbox: (f.db.prepare('SELECT count(*) n FROM outbox').get() as { n: number }).n,
        requests: (f.db.prepare('SELECT count(*) n FROM thread_reply_requests').get() as { n: number }).n,
      });
      const before = counts();
      const one = await f.raw('message.submit', {
        target,
        body: '单人不能独立研讨',
        intent: 'default',
        mentions: [{ kind: 'member', memberId: f.memberIds[0] }],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 10 },
      });
      expect(one.ok).toBe(false);
      expect(one.error?.message).toContain('至少需要两位');
      expect(counts()).toEqual(before);

      const lowBudget = await f.raw('message.submit', {
        target,
        body: '尾部预算不足',
        intent: 'default',
        mentions: [],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 2 },
      });
      expect(lowBudget.ok).toBe(false);
      expect(lowBudget.error?.message).toContain('至少需要 3 次');
      expect(counts()).toEqual(before);

      const record = await f.cmd<{ threadId: string; messageId: string }>('message.submit', {
        target: { kind: 'room_root', projectId: f.projectId, roomId: f.room.id, conversationId: f.room.conversationId },
        body: '只有记录的空串',
        intent: 'record_only',
        mentions: [],
      });
      const beforeEmpty = counts();
      const empty = await f.raw('message.submit', {
        target: {
          kind: 'thread',
          projectId: f.projectId,
          conversationId: f.room.conversationId,
          threadId: record.threadId,
        },
        body: '空名单不能研讨',
        intent: 'default',
        mentions: [],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 10 },
      });
      expect(empty.ok).toBe(false);
      expect(empty.error?.message).toMatch(/没有可用 AI|至少需要两位/);
      expect(counts()).toEqual(beforeEmpty);
    } finally {
      f.db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not replay a stale, failed, or UNKNOWN thread request', async () => {
    const stale = await fixture();
    try {
      const target = {
        kind: 'thread' as const,
        projectId: stale.projectId,
        conversationId: stale.room.conversationId,
        threadId: stale.root.threadId,
      };
      const submitted = await stale.cmd<{ messageId: string }>('message.submit', {
        target,
        body: '排队后成员被移除',
        intent: 'default',
        mentions: [],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 10 },
      });
      const members = await stale.cmd<{ members: { version: string } }>('thread.get', { threadId: stale.root.threadId });
      await stale.cmd('thread.members.change', {
        projectId: stale.projectId,
        threadId: stale.root.threadId,
        memberId: stale.memberIds[1],
        action: 'remove',
        expectedVersion: members.members.version,
      });
      const staleAdapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => directDone('不得执行') });
      const staleWorker = new DispatchWorker({
        db: stale.db,
        adapter: staleAdapter,
        leaseOwner: 'r90-stale-thread-delib',
        enableDeliberate: true,
        appDataDir: stale.dir,
      });
      await staleWorker.runOnce();
      expect(stale.db.prepare(
        'SELECT status,run_id FROM thread_reply_requests WHERE message_id=?',
      ).get(submitted.messageId)).toEqual({ status: 'blocked', run_id: null });
      expect(stale.db.prepare(
        "SELECT count(*) n FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE'",
      ).get(stale.root.taskId)).toEqual({ n: 0 });
      expect(staleAdapter.startTurnLog).toHaveLength(0);
    } finally {
      stale.db.close();
      rmSync(stale.dir, { recursive: true, force: true });
    }

    const failed = await fixture();
    try {
      const adapter = new FakeRuntimeAdapter({
        turnScriptSequencer: () => [{
          kind: 'event',
          event: { kind: 'turn.failed', code: 'PROVIDER_ERROR', message: 'known provider failure', retryable: false },
        }],
      });
      const worker = new DispatchWorker({
        db: failed.db,
        adapter,
        leaseOwner: 'r90-failed-thread-delib',
        enableDeliberate: true,
        appDataDir: failed.dir,
      });
      const submitted = await failed.cmd<{ messageId: string }>('message.submit', {
        target: {
          kind: 'thread',
          projectId: failed.projectId,
          conversationId: failed.room.conversationId,
          threadId: failed.root.threadId,
        },
        body: '失败不得自动重发',
        intent: 'default',
        mentions: [],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 10 },
      });
      await worker.runOnce(); // PREPARE
      await worker.runOnce(); // first IND fails
      await worker.runOnce(); // second IND fails -> independent barrier blocked
      for (let i = 0; i < 5; i += 1) await worker.runOnce();
      expect(adapter.startTurnLog).toHaveLength(2);
      expect(failed.db.prepare(
        'SELECT status FROM thread_reply_requests WHERE message_id=?',
      ).get(submitted.messageId)).toEqual({ status: 'failed' });
      expect(failed.db.prepare(
        "SELECT status FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE'",
      ).get(failed.root.taskId)).toEqual({ status: 'FAILED' });
    } finally {
      failed.db.close();
      rmSync(failed.dir, { recursive: true, force: true });
    }

    const unknown = await fixture();
    try {
      const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => [] });
      const worker = new DispatchWorker({
        db: unknown.db,
        adapter,
        leaseOwner: 'r90-unknown-thread-delib',
        enableDeliberate: true,
        turnDeadlineMs: 20,
        interruptGraceMs: 20,
        appDataDir: unknown.dir,
      });
      const submitted = await unknown.cmd<{ messageId: string }>('message.submit', {
        target: {
          kind: 'thread',
          projectId: unknown.projectId,
          conversationId: unknown.room.conversationId,
          threadId: unknown.root.threadId,
        },
        body: '结果未知不得重放',
        intent: 'default',
        mentions: [],
        collaboration: 'deliberate',
        deliberationBudget: { maxTurns: 10 },
      });
      await worker.runOnce(); // PREPARE
      await worker.runOnce(); // first IND -> UNKNOWN
      for (let i = 0; i < 5; i += 1) await worker.runOnce();
      expect(adapter.startTurnLog).toHaveLength(1);
      expect(unknown.db.prepare(
        'SELECT status FROM thread_reply_requests WHERE message_id=?',
      ).get(submitted.messageId)).toEqual({ status: 'unknown' });
      expect(unknown.db.prepare(
        "SELECT status FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE'",
      ).get(unknown.root.taskId)).toEqual({ status: 'INTERRUPTED' });
    } finally {
      unknown.db.close();
      rmSync(unknown.dir, { recursive: true, force: true });
    }
  }, 60_000);
});
