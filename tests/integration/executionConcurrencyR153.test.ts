import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { DispatchAdmission } from '../../src/daemon/admission.ts';
import { readExecutionConcurrency } from '../../src/daemon/executionConcurrency.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { collisionFixture, finish, ObservedAdapter, pause } from '../helpers/collisionHarnessR122.ts';

beforeEach(() => {
  vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake'); vi.stubEnv('ZS_REAL_DISPATCH_GUARD', '1');
  for (const key of ['ZS_MAX_INFLIGHT_GLOBAL', 'ZS_MAX_INFLIGHT_PROJECT', 'ZS_MAX_INFLIGHT_PROVIDER']) vi.stubEnv(key, '');
});
afterEach(() => vi.unstubAllEnvs());
const limits = (n: number) => ({ globalMaxInFlight: n, perProjectMaxInFlight: n, perProviderMaxInFlight: n });

describe('R153 actual execution concurrency settings', () => {
  it('defaults allow four different members in one project and channel, but retain a finite global bound', () => {
    const admission = new DispatchAdmission();
    for (let i = 0; i < 4; i++) expect(admission.tryAcquire(`t${i}`, { memberId: `m${i}`, projectId: 'p', providerKey: 'same', writeRootKey: null }).granted).toBe(true);
    expect(admission.tryAcquire('fifth', { memberId: 'm5', projectId: 'other', providerKey: 'different', writeRootKey: null })).toEqual({ granted: false, reason: 'global' });
  });

  it('persists validated limits atomically, replays receipts, rejects stale panes and remote mutation', async () => {
    const f = await collisionFixture('r153-concurrency-api', { members: 1 });
    try {
      expect(await f.cmd('app.executionConcurrency.get', {})).toEqual({ revision: 0, limits: limits(4), source: 'default' });
      const params = { expectedRevision: 0, limits: limits(6) };
      const first = await f.raw('app.executionConcurrency.set', params, 'one-save');
      expect(first.ok).toBe(true);
      expect(await f.raw('app.executionConcurrency.set', params, 'one-save')).toMatchObject({ data: first.data, replayed: true });
      expect((await f.raw('app.executionConcurrency.set', { ...params, limits: limits(8) }, 'one-save')).error?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await f.raw('app.executionConcurrency.set', { ...params, limits: limits(2) })).error?.code).toBe('STALE_REVISION');
      for (const n of [0, -1, 1.5, 33]) expect((await f.raw('app.executionConcurrency.set', { expectedRevision: 1, limits: limits(n) })).ok).toBe(false);
      const remote = await dispatchDaemonCommand({ db: f.db, localUserId: 'u_local', interruptTurn: async () => {}, remoteAudit: { deviceId: 'synthetic', authEpoch: 1 } },
        { protocolVersion: 1, commandId: randomUUID(), method: 'app.executionConcurrency.set', params: { expectedRevision: 1, limits: limits(10) } }) as { ok: boolean };
      expect(remote.ok).toBe(false);
      expect(readExecutionConcurrency(f.db)).toEqual({ revision: 1, limits: limits(6), source: 'saved' });
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    } finally { await f.close(); }
  });

  it('formal worker starts four writable members in one thread and wakes queued work after a limit increase without replacing holders', async () => {
    let first = true;
    let members: string[] = [];
    const adapter = new ObservedAdapter({ turnScriptSequencer: () => {
      if (!first) return finish('完成', 1600);
      first = false;
      return finish(JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: 'fixture', answer: '已先提交四份分工', responseKind: 'work', changeSummary: '四人分工',
        files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
        coordinationPlan: { summary: '四人各自实施', steps: members.map((memberId, i) => ({ key: `part${i}`, memberId, title: `成员${i}`, objective: `分别完成工作${i}`, role: 'implementation', dependsOn: [] })) },
      }), 5);
    } });
    const f = await collisionFixture('r153-four-writers', { members: 4, writable: true, adapter });
    members = f.projects[0]!.members;
    const worker = new DispatchWorker({ db: f.db, adapter, leaseOwner: randomUUID(), appDataDir: f.dir, detachedTurnConsumption: true });
    try {
      const projectId = f.projects[0]!.id;
      const policy = await f.cmd<{ revision: number }>('project.writeConcurrency.get', { projectId });
      await f.cmd('project.writeConcurrency.set', { projectId, expectedRevision: policy.revision, override: 'parallel_writers' });
      await f.cmd('app.executionConcurrency.set', { expectedRevision: 0, limits: limits(2) });
      const sent = await f.send(0, 0, [0, 1, 2, 3], '每位成员分别回复收到');
      await worker.drain();
      const readyDeadline = Date.now() + 3000;
      while (adapter.active.size !== 2 && Date.now() < readyDeadline) { await pause(10); await worker.drain(); }
      expect(adapter.active.size).toBe(2);
      const before = [...adapter.active.keys()];
      await f.cmd('app.executionConcurrency.set', { expectedRevision: 1, limits: limits(4) });
      await worker.drain();
      expect(adapter.active.size).toBe(4);
      expect(before.every(id => adapter.active.has(id))).toBe(true);
      expect(new Set([...adapter.active.values()].map(s => s.memberId)).size).toBe(4);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status='active'")).toBe(4);
      // Lowering the limit does not cancel or free already running turns.
      await f.cmd('app.executionConcurrency.set', { expectedRevision: 2, limits: limits(1) });
      await worker.drain();
      expect(adapter.active.size).toBe(4);
      const deadline = Date.now() + 8000;
      while (f.taskStatus(sent.taskId) !== 'DONE' && Date.now() < deadline) { await pause(25); await worker.drain(); }
      expect(f.taskStatus(sent.taskId)).toBe('DONE');
      expect(adapter.peak).toBe(4);
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    } finally { await adapter.closeAllSessions(); await worker.awaitInFlightTurns(3000); await f.close(); }
  }, 15_000);

  it('retains UNKNOWN occupancy across changing limits and still blocks the same execution scope', () => {
    let activeLimits = limits(1);
    const admission = new DispatchAdmission(undefined, () => activeLimits);
    const original = { memberId: 'm1', executionScopeKey: 'scope1', projectId: 'p', providerKey: 'pi', writeRootKey: 'root' };
    admission.restore('unknown-turn', original);
    activeLimits = limits(8);
    expect(admission.tryAcquire('same', original)).toEqual({ granted: false, reason: 'member' });
    expect(admission.tryAcquire('overlap', { ...original, memberId: 'm2', executionScopeKey: 'scope2' })).toEqual({ granted: false, reason: 'write-root' });
    expect(admission.has('unknown-turn')).toBe(true);
  });
});
