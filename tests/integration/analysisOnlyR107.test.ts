import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import type { FakeRuntimeAdapter as FakeRuntimeAdapterType } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { dispatchDaemonCommand as dispatchDaemonCommandType } from '../../src/daemon/commands.ts';
import type { DispatchWorker as DispatchWorkerType } from '../../src/daemon/dispatchWorker.ts';
import type { resolveMemberRuntime as resolveMemberRuntimeType } from '../../src/daemon/memberRuntime.ts';
import type { OpenSessionInput } from '../../src/contracts/runtime.ts';
import type { openDatabase as openDatabaseType, ZhongshuoDatabase } from '../../src/persistence/db.ts';

type RawResult<T = unknown> = {
  ok: boolean;
  replayed?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

type Fixture = {
  base: string;
  projectRoot: string;
  projectId: string;
  room: { id: string; conversationId: string };
  memberId: string;
  peerMemberId: string | null;
  db: ZhongshuoDatabase;
  adapter: InstanceType<typeof FakeRuntimeAdapterType>;
  worker: InstanceType<typeof DispatchWorkerType>;
  openedSessions: OpenSessionInput[];
  raw: <T = unknown>(method: string, params: unknown, commandId?: string) => Promise<RawResult<T>>;
  cmd: <T>(method: string, params: unknown, commandId?: string) => Promise<T>;
  run: (script?: FakeTurnScript) => Promise<boolean>;
  cleanup: () => Promise<void>;
};

let fixtureBase = '';
let largeProjectRoot = '';
let openDatabase: typeof openDatabaseType;
let dispatchDaemonCommand: typeof dispatchDaemonCommandType;
let DispatchWorker: typeof DispatchWorkerType;
let FakeRuntimeAdapter: typeof FakeRuntimeAdapterType;
let resolveMemberRuntime: typeof resolveMemberRuntimeType;

beforeAll(async () => {
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  vi.stubEnv('ZS_RUNTIME', 'fake');
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD', '1');
  // Freeze the production default explicitly. The fixture itself contains more
  // than 5,000 ignored files; no test-only filter or larger scan is allowed.
  vi.stubEnv('ZS_PREIMAGE_MAX_FILES', '5000');
  vi.resetModules();
  ({ openDatabase } = await import('../../src/persistence/db.ts'));
  ({ dispatchDaemonCommand } = await import('../../src/daemon/commands.ts'));
  ({ DispatchWorker } = await import('../../src/daemon/dispatchWorker.ts'));
  ({ FakeRuntimeAdapter } = await import('../../src/adapter/fake/runtimeAdapter.ts'));
  ({ resolveMemberRuntime } = await import('../../src/daemon/memberRuntime.ts'));

  fixtureBase = mkdtempSync(join(tmpdir(), 'zs-r107-analysis-only-'));
  largeProjectRoot = join(fixtureBase, 'large-project');
  const generated = join(largeProjectRoot, 'dist', 'generated');
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(largeProjectRoot, '.gitignore'), '/dist/\n', 'utf8');
  for (let index = 0; index <= 5_000; index += 1) {
    writeFileSync(join(generated, `${String(index).padStart(5, '0')}.txt`), 'x', 'utf8');
  }
  // Count quotas are gone; retain a real boundary failure for read-only recovery.
  const outside=join(fixtureBase,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'outside');
  symlinkSync(outside,join(largeProjectRoot,'outside-link'),'junction');
}, 120_000);

afterAll(() => {
  vi.unstubAllEnvs();
  if (fixtureBase !== '') rmSync(fixtureBase, { recursive: true, force: true });
});

function completion(input: {
  answer: string;
  responseKind?: 'conversation' | 'work';
  coordinationPlan?: unknown;
  handoffs?: unknown[];
}): FakeTurnScript {
  return [{
    kind: 'event',
    event: {
      kind: 'turn.completed',
      finalText: JSON.stringify({
        schemaVersion: 'task-complete-v1',
        resultKey: 'fixture',
        responseKind: input.responseKind ?? 'conversation',
        replyDisposition: 'reply',
        answer: input.answer,
        changeSummary: input.answer,
        document: null,
        files: [],
        executedVerifications: [],
        unexecutedVerifications: [],
        remainingIssues: [],
        handoffs: input.handoffs ?? [],
        coordinationPlan: input.coordinationPlan ?? null,
      }),
    },
  }];
}

function providerFailure(message = 'R107 fixture failure'): FakeTurnScript {
  return [{
    kind: 'event',
    event: {
      kind: 'turn.failed',
      code: 'PROVIDER_ERROR',
      message,
      retryable: false,
    },
  }];
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scopePolicy(raw: string | Record<string, unknown>) {
  const scope = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw;
  const runtime = record(scope.runtime);
  const candidates = [
    record(scope.writeAccess),
    record(runtime?.writeAccess),
    scope,
  ].filter((value): value is Record<string, unknown> => value != null);
  const firstDefined = (key: string): unknown => candidates.find((value) => key in value)?.[key];
  return {
    scope,
    runtime,
    executionMode: scope.executionMode,
    analysisOnly: firstDefined('analysisOnly'),
    fullAccess: firstDefined('fullAccess'),
    writable: firstDefined('writable'),
    modificationAuthorized: firstDefined('modificationAuthorized'),
  };
}

function runtimeFacts(raw: string | Record<string, unknown>): Record<string, unknown> | null {
  const scope = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw;
  const runtime = record(scope.runtime);
  if (runtime == null) return null;
  const copy = { ...runtime };
  // Execution-policy metadata may sit beside the frozen member runtime, but it
  // must not alter the exact runtime facts used for configuration consistency.
  delete copy.analysisOnly;
  delete copy.writeAccess;
  return copy;
}

function expectAnalysisOnlyScope(raw: string | Record<string, unknown>): void {
  const policy = scopePolicy(raw);
  expect(policy.executionMode, JSON.stringify(policy.scope)).toBe('readonly');
  expect(policy.analysisOnly, JSON.stringify(policy.scope)).toBe(true);
  expect(policy.fullAccess, JSON.stringify(policy.scope)).not.toBe(true);
  expect(policy.modificationAuthorized, JSON.stringify(policy.scope)).not.toBe(true);
  if (policy.writable !== undefined) expect(policy.writable).toBe(false);
  expect(policy.scope.authorized).not.toBe(true);
}

function expectFullScope(raw: string | Record<string, unknown>): void {
  const policy = scopePolicy(raw);
  expect(policy.executionMode, JSON.stringify(policy.scope)).toBe('full');
  expect(policy.analysisOnly, JSON.stringify(policy.scope)).not.toBe(true);
  expect(policy.fullAccess, JSON.stringify(policy.scope)).not.toBe(false);
  expect(policy.modificationAuthorized, JSON.stringify(policy.scope)).not.toBe(false);
}

function findAnalysisOnly(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(findAnalysisOnly);
  const object = record(value);
  if (object == null) return false;
  if (object.analysisOnly === true) return true;
  return Object.values(object).some(findAnalysisOnly);
}

function latestRedispatchExecution(
  db: ZhongshuoDatabase,
  taskId: string,
): { writeScope?: string; roster?: Array<{ writeScope: string | null }> } {
  const row = db.prepare(`
    SELECT payload_json FROM domain_events
    WHERE task_id=? AND kind='task.redispatchEnqueued'
    ORDER BY seq DESC LIMIT 1
  `).get(taskId) as { payload_json: string } | undefined;
  if (row == null) throw new Error('missing task.redispatchEnqueued');
  const payload = JSON.parse(row.payload_json) as {
    execution?: { writeScope?: string; roster?: Array<{ writeScope: string | null }> };
  };
  if (payload.execution == null) throw new Error('missing frozen redispatch execution');
  return payload.execution;
}

function count(db: ZhongshuoDatabase, table: string, where = ''): number {
  return (db.prepare(`SELECT count(*) n FROM ${table} ${where}`).get() as { n: number }).n;
}

function taskCount(db: ZhongshuoDatabase, table: string, taskId: string): number {
  return (db.prepare(`SELECT count(*) n FROM ${table} WHERE task_id=?`).get(taskId) as { n: number }).n;
}

async function createFixture(options: { large?: boolean; userReview?: boolean; peer?: boolean } = {}): Promise<Fixture> {
  const base = mkdtempSync(join(fixtureBase, 'case-'));
  const projectRoot = options.large ? largeProjectRoot : join(base, 'project');
  if (!options.large) mkdirSync(projectRoot, { recursive: true });
  const db = openDatabase(join(base, 'state.sqlite'));
  let script: FakeTurnScript = [];
  const adapter = new FakeRuntimeAdapter({
    structuredFinal: true,
    turnScriptSequencer: () => script,
  });
  const openedSessions: OpenSessionInput[] = [];
  const openSession = adapter.openSession.bind(adapter);
  adapter.openSession = async (input: OpenSessionInput) => {
    openedSessions.push(input);
    return openSession(input);
  };
  const worker = new DispatchWorker({
    db,
    adapter,
    leaseOwner: 'r107-analysis-only',
    appDataDir: base,
  });
  const deps = {
    db,
    localUserId: 'u_r107_analysis_only',
    appDataDir: base,
    interruptTurn: (turnId: string) => worker.interruptTurn(turnId),
  };
  const raw = <T = unknown>(method: string, params: unknown, commandId: string = randomUUID()) =>
    dispatchDaemonCommand(deps, {
      protocolVersion: 1,
      commandId,
      method,
      params,
    }) as Promise<RawResult<T>>;
  const cmd = async <T>(method: string, params: unknown, commandId?: string): Promise<T> => {
    const result = await raw<T>(method, params, commandId);
    if (!result.ok) throw new Error(`${result.error?.code ?? ''}: ${result.error?.message ?? 'command failed'}`);
    return result.data as T;
  };
  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: projectRoot })).project.id;
  const memberId = (await cmd<{ memberId: string }>('member.create', {
    projectId,
    displayName: 'R107 full-permission Claude-shaped member',
  })).memberId;
  await cmd('member.setRuntime', {
    memberId,
    kind: 'fake',
    permissionMode: 'bypassPermissions',
  });
  const peerMemberId = options.peer
    ? (await cmd<{ memberId: string }>('member.create', {
      projectId,
      displayName: 'R107 read-only peer',
    })).memberId
    : null;
  if (peerMemberId != null) {
    await cmd('member.setRuntime', {
      memberId: peerMemberId,
      kind: 'fake',
      permissionMode: 'bypassPermissions',
    });
  }
  const room = (await cmd<{ room: { id: string; conversationId: string } }>('room.create', {
    projectId,
    name: 'R107 analysisOnly fixture',
    memberIds: peerMemberId == null ? [memberId] : [memberId, peerMemberId],
  })).room;
  const roomRevision = (db.prepare('SELECT revision FROM rooms WHERE id=?').get(room.id) as { revision: number }).revision;
  await cmd('room.update', {
    roomId: room.id,
    expectedRevision: roomRevision,
    coordinatorMemberId: memberId,
  });
  if (options.userReview) {
    const projectRevision = (db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId) as { revision: number }).revision;
    await cmd('project.reviewPolicy.set', {
      projectId,
      taskReviewEnabled: true,
      expectedRevision: projectRevision,
    });
  }
  const cleanup = async () => {
    await adapter.closeAllSessions();
    db.close();
    rmSync(base, { recursive: true, force: true });
  };
  return {
    base,
    projectRoot,
    projectId,
    room,
    memberId,
    peerMemberId,
    db,
    adapter,
    worker,
    openedSessions,
    raw,
    cmd,
    run: async (next) => {
      if (next != null) script = next;
      return worker.runOnce();
    },
    cleanup,
  };
}

function submit(
  fixture: Fixture,
  body: string,
  options: { analysisOnly?: boolean } = {},
) {
  return fixture.cmd<{ taskId: string; threadId: string; disposition: string }>('message.submit', {
    target: {
      kind: 'room_root',
      projectId: fixture.projectId,
      roomId: fixture.room.id,
      conversationId: fixture.room.conversationId,
    },
    body,
    intent: 'default',
    mentions: [],
    ...(options.analysisOnly === true ? { analysisOnly: true } : {}),
  });
}

describe('R107 analysisOnly formal command and worker scope', () => {
  it('keeps the default full AUTO request fail-closed above 5,000 ignored files, then recovers the same zero-run task through an explicit analysisOnly redispatch', async () => {
    const fixture = await createFixture({ large: true });
    try {
      expect(readdirSync(join(fixture.projectRoot, 'dist', 'generated'))).toHaveLength(5_001);
      const root = await submit(fixture, 'Compare the current repository without changing files');
      const route = JSON.parse((fixture.db.prepare('SELECT route_json FROM tasks WHERE id=?').get(root.taskId) as { route_json: string }).route_json) as { mode: string };
      expect(route.mode).toBe('AUTO');

      const originalTaskScope = (fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json;
      const originalRoster = (fixture.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId) as { roster_json: string }).roster_json;
      expectFullScope(originalTaskScope);
      for (const member of JSON.parse(originalRoster) as Array<{ writeScope: string | null }>) {
        expect(member.writeScope, JSON.stringify(member)).not.toBeNull();
        expectFullScope(member.writeScope!);
      }

      await fixture.worker.runOnce();
      const baseline = fixture.db.prepare(`
        SELECT payload_json FROM domain_events
        WHERE task_id=? AND kind='changeset.baselineCaptured'
        ORDER BY seq DESC LIMIT 1
      `).get(root.taskId) as { payload_json: string } | undefined;
      expect(baseline).toBeDefined();
      const baselinePayload = JSON.parse(baseline!.payload_json) as { fileCount: number; truncated: boolean };
      expect(baselinePayload.fileCount).toBeGreaterThanOrEqual(5_000);
      expect(baselinePayload.truncated).toBe(false);
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({ status: 'BLOCKED' });
      expect(fixture.db.prepare(`
        SELECT payload_json FROM domain_events
        WHERE task_id=? AND kind='task.contextAssemblyFailed'
        ORDER BY seq DESC LIMIT 1
      `).get(root.taskId)).toMatchObject({ payload_json: expect.stringContaining('write-baseline-incomplete') });
      expect(taskCount(fixture.db, 'workflow_runs', root.taskId)).toBe(0);
      expect(count(fixture.db, 'agent_turns')).toBe(0);
      expect(count(fixture.db, 'runtime_sessions')).toBe(0);
      expect(count(fixture.db, 'real_calls')).toBe(0);
      expect(fixture.openedSessions).toHaveLength(0);
      expect(fixture.adapter.startTurnLog).toHaveLength(0);
      expect((fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json).toBe(originalTaskScope);
      expect((fixture.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId) as { roster_json: string }).roster_json).toBe(originalRoster);

      const task = fixture.db.prepare('SELECT revision,stop_generation FROM tasks WHERE id=?').get(root.taskId) as { revision: number; stop_generation: number };
      const redispatch = await fixture.raw<{ enqueued: boolean; dispatchKey: string }>('task.redispatch', {
        taskId: root.taskId,
        analysisOnly: true,
        expectedTaskRevision: task.revision,
        expectedStopGeneration: task.stop_generation,
        reason: 'R107 analysis-only recovery',
      });
      expect(redispatch.ok, JSON.stringify(redispatch.error)).toBe(true);
      expect(redispatch.data).toMatchObject({ enqueued: true });
      const redispatchEvent = fixture.db.prepare(`
        SELECT payload_json FROM domain_events
        WHERE task_id=? AND kind='task.redispatchEnqueued'
        ORDER BY seq DESC LIMIT 1
      `).get(root.taskId) as { payload_json: string };
      expect(findAnalysisOnly(JSON.parse(redispatchEvent.payload_json))).toBe(true);
      expect((fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json).toBe(originalTaskScope);
      expect((fixture.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId) as { roster_json: string }).roster_json).toBe(originalRoster);

      await fixture.run(completion({ answer: 'Read-only comparison completed.' }));
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({ status: 'DONE' });
      expect(fixture.openedSessions).toHaveLength(1);
      expect(fixture.adapter.startTurnLog).toHaveLength(1);
      const recoveredAccess = scopePolicy(JSON.stringify(fixture.openedSessions[0]!.writeAccess));
      expect(recoveredAccess.analysisOnly).toBe(true);
      expect(recoveredAccess.fullAccess).toBe(false);
      expect(recoveredAccess.modificationAuthorized).toBe(false);
      expect(taskCount(fixture.db, 'workflow_runs', root.taskId)).toBe(1);
      expect(taskCount(fixture.db, 'change_sets', root.taskId)).toBe(1);
      expect(taskCount(fixture.db, 'real_calls', root.taskId)).toBe(0);
      expect(count(fixture.db, 'workspace_leases', "WHERE status!='released'")).toBe(0);
      expect((fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json).toBe(originalTaskScope);
      expect((fixture.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId) as { roster_json: string }).roster_json).toBe(originalRoster);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('keeps the most recent analysisOnly execution scope across a failed retry, an unflagged redispatch, and AUTO steps/handoffs', async () => {
    const fixture = await createFixture({ large: true, peer: true });
    try {
      expect(fixture.peerMemberId).not.toBeNull();
      const root = await submit(fixture, 'Compare without writing, even after retry');
      const originalTaskScope = (fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json;
      const originalRoster = (fixture.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId) as { roster_json: string }).roster_json;
      expectFullScope(originalTaskScope);
      for (const member of JSON.parse(originalRoster) as Array<{ writeScope: string | null }>) {
        expect(member.writeScope).not.toBeNull();
        expectFullScope(member.writeScope!);
      }

      // The original full request still fails before model start.
      await fixture.worker.runOnce();
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({ status: 'BLOCKED' });
      const blocked = fixture.db.prepare('SELECT revision,stop_generation FROM tasks WHERE id=?').get(root.taskId) as { revision: number; stop_generation: number };

      // First explicit recovery freezes only this execution as analysisOnly.
      const firstRecovery = await fixture.raw('task.redispatch', {
        taskId: root.taskId,
        analysisOnly: true,
        expectedTaskRevision: blocked.revision,
        expectedStopGeneration: blocked.stop_generation,
        reason: 'R107 first analysis-only recovery',
      });
      expect(firstRecovery.ok, JSON.stringify(firstRecovery.error)).toBe(true);
      const firstExecution = latestRedispatchExecution(fixture.db, root.taskId);
      expect(firstExecution.writeScope).toBeDefined();
      expectAnalysisOnlyScope(firstExecution.writeScope!);
      expect(firstExecution.roster?.length).toBe(2);
      for (const member of firstExecution.roster ?? []) {
        expect(member.writeScope, JSON.stringify(member)).not.toBeNull();
        expectAnalysisOnlyScope(member.writeScope!);
      }

      // A provider failure does not grant permission to fall back to the
      // member's bypass default on the next explicit continuation.
      await fixture.run(providerFailure());
      expect(fixture.adapter.startTurnLog).toHaveLength(1);
      const failedTask = fixture.db.prepare('SELECT status,revision,stop_generation FROM tasks WHERE id=?').get(root.taskId) as { status: string; revision: number; stop_generation: number };
      expect(['ACTIVE', 'BLOCKED']).toContain(failedTask.status);

      const ordinaryRetry = await fixture.raw('task.redispatch', {
        taskId: root.taskId,
        expectedTaskRevision: failedTask.revision,
        expectedStopGeneration: failedTask.stop_generation,
        reason: 'R107 ordinary retry after analysis-only failure',
      });
      expect(ordinaryRetry.ok, JSON.stringify(ordinaryRetry.error)).toBe(true);
      const inheritedExecution = latestRedispatchExecution(fixture.db, root.taskId);
      expect(inheritedExecution.writeScope).toBeDefined();
      expectAnalysisOnlyScope(inheritedExecution.writeScope!);
      expect(inheritedExecution.roster?.length).toBe(2);
      for (const member of inheritedExecution.roster ?? []) {
        expect(member.writeScope, JSON.stringify(member)).not.toBeNull();
        expectAnalysisOnlyScope(member.writeScope!);
      }

      const plan = {
        summary: 'Read-only AUTO comparison with one child and one handoff',
        steps: [{
          key: 'read-only-child',
          memberId: fixture.peerMemberId,
          title: 'Read-only child',
          objective: 'Read and compare without writing.',
          role: 'analysis',
          dependsOn: [],
        }],
      };
      await fixture.run(completion({
        answer: 'Read-only planning completed.',
        responseKind: 'work',
        coordinationPlan: plan,
      }));
      expect(fixture.openedSessions).toHaveLength(2);
      for (const opened of fixture.openedSessions) {
        expect(opened.writeAccess).toMatchObject({
          analysisOnly: true,
          fullAccess: false,
          modificationAuthorized: false,
        });
      }

      const currentRun = fixture.db.prepare(`
        SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1
      `).get(root.taskId) as { id: string };
      const frozenRoster = fixture.db.prepare(`
        SELECT roster_json FROM coordination_run_rosters WHERE run_id=?
      `).get(currentRun.id) as { roster_json: string } | undefined;
      expect(frozenRoster).toBeDefined();
      for (const member of JSON.parse(frozenRoster!.roster_json) as Array<{ writeScope: string | null }>) {
        expect(member.writeScope, JSON.stringify(member)).not.toBeNull();
        expectAnalysisOnlyScope(member.writeScope!);
      }

      const childScopes = fixture.db.prepare(`
        SELECT DISTINCT t.id,t.write_scope_json
        FROM coordination_steps s
        JOIN tasks t ON t.id=s.child_task_id
        WHERE s.run_id=?
      `).all(currentRun.id) as Array<{ id: string; write_scope_json: string }>;
      const childDiagnostic = {
        task: fixture.db.prepare('SELECT status,response_kind FROM tasks WHERE id=?').get(root.taskId),
        runs: fixture.db.prepare('SELECT id,mode,status,stage FROM workflow_runs WHERE task_id=? ORDER BY rowid').all(root.taskId),
        coordinations: fixture.db.prepare('SELECT run_id,state,plan_json,error_message FROM coordination_runs WHERE task_id=?').all(root.taskId),
        steps: fixture.db.prepare('SELECT * FROM coordination_steps').all(),
        handoffs: fixture.db.prepare('SELECT * FROM coordination_messages').all(),
        recentEvents: fixture.db.prepare(`
          SELECT kind,payload_json FROM domain_events WHERE task_id=? ORDER BY seq DESC LIMIT 12
        `).all(root.taskId),
      };
      expect(childScopes.length, JSON.stringify(childDiagnostic)).toBeGreaterThan(0);
      for (const child of childScopes) {
        expectAnalysisOnlyScope(child.write_scope_json);
        expect((fixture.openedSessions[1]!.writeAccess as unknown as Record<string, unknown>).identityKey).toBeTruthy();
      }

      // Explicit execution snapshots never rewrite the historical full task or
      // its original coordination roster.
      expect((fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json).toBe(originalTaskScope);
      expect((fixture.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId) as { roster_json: string }).roster_json).toBe(originalRoster);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('keeps an AUTO handoff child read-only when its source request is analysisOnly', async () => {
    const fixture = await createFixture({ peer: true });
    try {
      expect(fixture.peerMemberId).not.toBeNull();
      const root = await submit(fixture, 'Read-only handoff fixture', { analysisOnly: true });
      const taskScopeBefore = (fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json;
      await fixture.run(completion({
        answer: 'Read-only handoff prepared.',
        responseKind: 'work',
        handoffs: [{
          toMemberId: fixture.peerMemberId,
          purpose: 'review',
          message: 'Review the comparison without changing files.',
        }],
      }));
      expect(fixture.openedSessions).toHaveLength(1);
      expect(fixture.openedSessions[0]!.writeAccess).toMatchObject({
        analysisOnly: true,
        fullAccess: false,
        modificationAuthorized: false,
      });
      const handoffScopes = fixture.db.prepare(`
        SELECT DISTINCT t.id,t.write_scope_json
        FROM coordination_messages m
        JOIN tasks t ON t.id=m.child_task_id
        WHERE m.coordination_run_id IN (
          SELECT run_id FROM coordination_runs WHERE task_id=?
        )
      `).all(root.taskId) as Array<{ id: string; write_scope_json: string }>;
      expect(handoffScopes.length).toBeGreaterThan(0);
      for (const child of handoffScopes) {
        expectAnalysisOnlyScope(child.write_scope_json);
      }
      expect((fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json).toBe(taskScopeBefore);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('freezes analysisOnly on a new AUTO root and every roster member without changing the bound full runtime or creating a writable baseline', async () => {
    const fixture = await createFixture({ large: true });
    try {
      const runtimeBefore = JSON.stringify(resolveMemberRuntime(fixture.db, fixture.memberId, 'fake'));
      const profileBefore = fixture.db.prepare(`
        SELECT p.settings_json
        FROM project_members m JOIN agent_profiles p ON p.id=m.profile_id
        WHERE m.id=?
      `).get(fixture.memberId);
      const installationBefore = fixture.db.prepare(`
        SELECT i.id,i.kind,i.executable,i.version,i.adapter_version,i.capabilities_json
        FROM project_members m
        JOIN agent_profiles p ON p.id=m.profile_id
        JOIN runtime_installations i ON i.id=p.runtime_installation_id
        WHERE m.id=?
      `).get(fixture.memberId);
      const authorizationBefore = fixture.db.prepare('SELECT * FROM project_write_authorizations WHERE project_id=?').get(fixture.projectId) ?? null;

      const root = await submit(fixture, 'Read and compare the repository only', { analysisOnly: true });
      const taskScope = (fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json;
      const rosterJson = (fixture.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId) as { roster_json: string }).roster_json;
      expectAnalysisOnlyScope(taskScope);
      expect(runtimeFacts(taskScope)).toEqual(JSON.parse(runtimeBefore));
      const roster = JSON.parse(rosterJson) as Array<{ writeScope: string | null }>;
      expect(roster.length).toBeGreaterThan(0);
      for (const member of roster) {
        expect(member.writeScope, JSON.stringify(member)).not.toBeNull();
        expectAnalysisOnlyScope(member.writeScope!);
        expect(runtimeFacts(member.writeScope!)).toEqual(JSON.parse(runtimeBefore));
      }

      await fixture.run(completion({ answer: 'Analysis completed without writes.' }));
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({ status: 'DONE' });
      expect(fixture.openedSessions).toHaveLength(1);
      expect(fixture.adapter.startTurnLog).toHaveLength(1);
      expect((fixture.openedSessions[0]!.writeAccess as unknown as Record<string, unknown>).analysisOnly).toBe(true);
      expect(fixture.openedSessions[0]!.writeAccess).toMatchObject({
        analysisOnly: true,
        fullAccess: false,
        modificationAuthorized: false,
      });
      expect(taskCount(fixture.db, 'change_sets', root.taskId)).toBe(0);
      expect(count(fixture.db, 'domain_events', "WHERE kind='changeset.baselineCaptured'")).toBe(0);
      expect(count(fixture.db, 'workspace_leases', "WHERE status!='released'")).toBe(0);
      expect(count(fixture.db, 'real_calls')).toBe(0);
      expect(fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId)).toEqual({ write_scope_json: taskScope });
      expect(fixture.db.prepare('SELECT roster_json FROM coordination_scopes WHERE task_id=?').get(root.taskId)).toEqual({ roster_json: rosterJson });

      expect(fixture.db.prepare(`
        SELECT p.settings_json
        FROM project_members m JOIN agent_profiles p ON p.id=m.profile_id
        WHERE m.id=?
      `).get(fixture.memberId)).toEqual(profileBefore);
      expect(fixture.db.prepare(`
        SELECT i.id,i.kind,i.executable,i.version,i.adapter_version,i.capabilities_json
        FROM project_members m
        JOIN agent_profiles p ON p.id=m.profile_id
        JOIN runtime_installations i ON i.id=p.runtime_installation_id
        WHERE m.id=?
      `).get(fixture.memberId)).toEqual(installationBefore);
      expect(fixture.db.prepare('SELECT * FROM project_write_authorizations WHERE project_id=?').get(fixture.projectId) ?? null).toEqual(authorizationBefore);

      const followup = await fixture.cmd<{ messageId: string }>('message.submit', {
        target: {
          kind: 'thread',
          projectId: fixture.projectId,
          conversationId: fixture.room.conversationId,
          threadId: root.threadId,
        },
        body: 'Continue the same read-only comparison.',
        intent: 'default',
        mentions: [],
      });
      const queuedFollowup = fixture.db.prepare(`
        SELECT write_scope_json,roster_json
        FROM thread_reply_requests
        WHERE message_id=?
      `).get(followup.messageId) as { write_scope_json: string; roster_json: string };
      expectAnalysisOnlyScope(queuedFollowup.write_scope_json);
      for (const member of JSON.parse(queuedFollowup.roster_json) as Array<{ writeScope: string | null }>) {
        expect(member.writeScope, JSON.stringify(member)).not.toBeNull();
        expectAnalysisOnlyScope(member.writeScope!);
      }
      expect((fixture.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json).toBe(taskScope);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('does not reuse a writable session identity for an analysisOnly turn', async () => {
    const fixture = await createFixture();
    try {
      const writable = await submit(fixture, 'Create the writable session fixture.');
      await fixture.run(completion({
        answer: 'Writable fixture completed.',
        responseKind: 'conversation',
      }));
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(writable.taskId)).toEqual({ status: 'DONE' });

      const analysis = await submit(fixture, 'Use the same room for read-only analysis only.', { analysisOnly: true });
      await fixture.run(completion({
        answer: 'Analysis-only fixture completed.',
        responseKind: 'conversation',
      }));
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(analysis.taskId)).toEqual({ status: 'DONE' });
      expect(fixture.openedSessions).toHaveLength(2);
      expect(fixture.openedSessions[0]!.writeAccess).toMatchObject({
        fullAccess: true,
        modificationAuthorized: true,
      });
      expect(fixture.openedSessions[1]!.writeAccess).toMatchObject({
        analysisOnly: true,
        fullAccess: false,
        modificationAuthorized: false,
      });
      expect(fixture.openedSessions[1]!.resume).toBeUndefined();
      expect(fixture.openedSessions[1]!.writeAccess!.identityKey).not.toBe(fixture.openedSessions[0]!.writeAccess!.identityKey);

      const sessions = fixture.db.prepare(`
        SELECT task_id,provider_session_id,capabilities_json
        FROM runtime_sessions
        WHERE task_id IN (?,?)
        ORDER BY rowid
      `).all(writable.taskId, analysis.taskId) as Array<{
        task_id: string;
        provider_session_id: string | null;
        capabilities_json: string | null;
      }>;
      expect(sessions).toHaveLength(2);
      const writableCaps = JSON.parse(sessions[0]!.capabilities_json!) as {
        writeIdentity: string;
        writeAccessMode: { fullAccess?: boolean; modificationAuthorized: boolean };
      };
      const analysisCaps = JSON.parse(sessions[1]!.capabilities_json!) as {
        writeIdentity: string;
        writeAccessMode: { fullAccess?: boolean; modificationAuthorized: boolean };
      };
      expect(writableCaps.writeAccessMode).toMatchObject({ fullAccess: true, modificationAuthorized: true });
      expect(analysisCaps.writeAccessMode).toMatchObject({ fullAccess: false, modificationAuthorized: false });
      expect(analysisCaps.writeIdentity).not.toBe(writableCaps.writeIdentity);
      expect(sessions[1]!.provider_session_id).not.toBe(sessions[0]!.provider_session_id);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it('does not let analysisOnly bypass runtime drift, stop generation, or an unclosed UNKNOWN turn', async () => {
    const drift = await createFixture();
    try {
      const root = await submit(drift, 'Analyze only', { analysisOnly: true });
      const scopeBefore = (drift.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId) as { write_scope_json: string }).write_scope_json;
      await drift.cmd('member.setRuntime', {
        memberId: drift.memberId,
        kind: 'fake',
        permissionMode: 'bypassPermissions',
        effort: 'high',
      });
      await drift.worker.runOnce();
      expect(drift.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({ status: 'BLOCKED' });
      expect(drift.openedSessions).toHaveLength(0);
      expect(drift.adapter.startTurnLog).toHaveLength(0);
      expect(taskCount(drift.db, 'change_sets', root.taskId)).toBe(0);
      expect(drift.db.prepare(`
        SELECT payload_json FROM domain_events
        WHERE task_id=? AND kind='task.contextAssemblyFailed'
        ORDER BY seq DESC LIMIT 1
      `).get(root.taskId)).toMatchObject({ payload_json: expect.stringContaining('执行配置已变化') });
      expect(drift.db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(root.taskId)).toEqual({ write_scope_json: scopeBefore });
    } finally {
      await drift.cleanup();
    }

    const stopped = await createFixture();
    try {
      const root = await submit(stopped, 'Analyze only', { analysisOnly: true });
      const task = stopped.db.prepare('SELECT revision,stop_generation FROM tasks WHERE id=?').get(root.taskId) as { revision: number; stop_generation: number };
      stopped.db.prepare('UPDATE tasks SET stop_generation=stop_generation+1 WHERE id=?').run(root.taskId);
      const result = await stopped.raw('task.redispatch', {
        taskId: root.taskId,
        analysisOnly: true,
        expectedTaskRevision: task.revision,
        expectedStopGeneration: task.stop_generation,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('STALE_REVISION');
      expect(count(stopped.db, 'outbox', "WHERE dispatch_key GLOB 'task:*:redispatch*'")).toBe(0);
      expect(stopped.adapter.startTurnLog).toHaveLength(0);
    } finally {
      await stopped.cleanup();
    }

    const unknown = await createFixture();
    try {
      const root = await submit(unknown, 'Analyze only', { analysisOnly: true });
      const task = unknown.db.prepare(`
        SELECT revision,stop_generation,conversation_id,conversation_thread_id
        FROM tasks WHERE id=?
      `).get(root.taskId) as { revision: number; stop_generation: number; conversation_id: string; conversation_thread_id: string };
      const runId = `run_${randomUUID()}`;
      const turnId = `turn_${randomUUID()}`;
      unknown.db.transaction(() => {
        unknown.db.prepare(`
          INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,task_revision,status)
          VALUES(?,?,?,?, 'AUTO', ?, 'FAILED')
        `).run(runId, root.taskId, task.conversation_id, task.conversation_thread_id, task.revision);
        unknown.db.prepare(`
          INSERT INTO agent_turns(
            id,run_id,conversation_id,thread_id,member_id,stage_key,turn_purpose,status,dispatch_key,attempt,epoch,stop_generation_snapshot
          ) VALUES(?,?,?,?,?, 'direct.work','stage_work','UNKNOWN',?,1,1,?)
        `).run(turnId, runId, task.conversation_id, task.conversation_thread_id, unknown.memberId, `r107-unknown-${turnId}`, task.stop_generation);
      })();
      const result = await unknown.raw('task.redispatch', {
        taskId: root.taskId,
        expectedTaskRevision: task.revision,
        expectedStopGeneration: task.stop_generation,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('RECONCILE_REQUIRED');
      expect(count(unknown.db, 'outbox', "WHERE dispatch_key GLOB 'task:*:redispatch*'")).toBe(0);
      expect(unknown.adapter.startTurnLog).toHaveLength(0);
    } finally {
      await unknown.cleanup();
    }
  }, 60_000);

  it('keeps default full AUTO planning writable and leaves an actual write pending formal review', async () => {
    const fixture = await createFixture({ userReview: true });
    try {
      const root = await submit(fixture, 'Create the requested review artifact');
      const script: FakeTurnScript = [
        { kind: 'writeFile', path: 'default-full.txt', content: 'default full remains writable' },
        ...completion({ answer: 'Created default-full.txt.', responseKind: 'work' }),
      ];
      await fixture.run(script);
      expect(fixture.openedSessions).toHaveLength(1);
      expect(fixture.openedSessions[0]!.writeAccess).toMatchObject({
        fullAccess: true,
        modificationAuthorized: true,
      });
      expect((fixture.openedSessions[0]!.writeAccess as unknown as Record<string, unknown>).analysisOnly).not.toBe(true);
      expect(readFileSync(join(fixture.projectRoot, 'default-full.txt'), 'utf8')).toBe('default full remains writable');
      expect(fixture.db.prepare('SELECT status FROM tasks WHERE id=?').get(root.taskId)).toEqual({ status: 'REVIEW' });
      expect(fixture.db.prepare(`
        SELECT review_status FROM task_deliveries WHERE task_id=? ORDER BY revision DESC LIMIT 1
      `).get(root.taskId)).toEqual({ review_status: 'pending' });
      expect(fixture.adapter.startTurnLog[0]!.text).toContain('coordinationPlan');
      expect(taskCount(fixture.db, 'change_sets', root.taskId)).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
