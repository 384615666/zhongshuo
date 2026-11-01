import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { migrate, openDatabase } from '../../src/persistence/db.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/registry.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { DispatchAdmission, type AdmissionDimensions } from '../../src/daemon/admission.ts';
import { acquireLease, recordedWriteConcurrency } from '../../src/daemon/workspaceLocks.ts';
import { comparisonKey } from '../../src/daemon/directoryIdentity.ts';
import { projectWriteConcurrency, resolveWriteConcurrency } from '../../src/daemon/writeConcurrency.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import type { ProjectWriteConcurrency, WriteConcurrencyOverride } from '../../src/contracts/writeConcurrency.ts';
import { collisionFixture, finish, ObservedAdapter } from '../helpers/collisionHarnessR122.ts';

beforeEach(() => {
  vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake'); vi.stubEnv('ZS_REAL_DISPATCH_GUARD', '1');
});
afterEach(() => vi.unstubAllEnvs());

async function setPolicy(f: Awaited<ReturnType<typeof collisionFixture>>, override: WriteConcurrencyOverride, id?: string) {
  const projectId = f.projects[0]!.id;
  const current = await f.cmd<ProjectWriteConcurrency>('project.writeConcurrency.get', { projectId });
  return f.cmd<ProjectWriteConcurrency>('project.writeConcurrency.set', { projectId, expectedRevision: current.revision, override }, id);
}

describe('R152 explicit file write concurrency: formal commands and worker, zero model calls', () => {
  it('migrates legacy settings without turning either legacy policy into an explicit override', () => {
    const db = new Database(':memory:');
    try {
      migrate(db, {}, MIGRATIONS.filter(m => m.id <= 60));
      for (const policy of ['single_writer', 'parallel_writers']) db.prepare(`INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at,write_concurrency_policy)
        VALUES(?,?,?,?,?,?,?)`).run(policy, policy, 'D:/fixture', 'D:/fixture', '{}', 1, policy);
      migrate(db);
      expect(db.pragma('user_version', { simple: true })).toBe(61);
      for (const policy of ['single_writer', 'parallel_writers']) {
        expect(projectWriteConcurrency(db, policy)).toMatchObject({ override: null, effectivePolicy: 'session_scope', revision: 0 });
        expect(db.prepare('SELECT write_concurrency_policy FROM projects WHERE id=?').get(policy)).toEqual({ write_concurrency_policy: policy });
      }
      expect(() => db.prepare('UPDATE projects SET write_concurrency_override=?').run('session_scope')).toThrow(/CHECK/);
    } finally { db.close(); }
  });

  it('audits atomic CAS changes, replays one receipt, rejects payload reuse and remote writes', async () => {
    const f = await collisionFixture('r152-write-api', { members: 1, writable: true });
    try {
      const projectId = f.projects[0]!.id;
      const original = await f.cmd<ProjectWriteConcurrency>('project.writeConcurrency.get', { projectId });
      const params = { projectId, expectedRevision: original.revision, override: 'parallel_writers' };
      const first = await f.raw('project.writeConcurrency.set', params, 'r152-policy-receipt');
      expect(first.ok).toBe(true);
      const replay = await f.raw('project.writeConcurrency.set', params, 'r152-policy-receipt') as typeof first & { replayed?: boolean };
      expect(replay.replayed).toBe(true); expect(replay.data).toEqual(first.data);
      expect((await f.raw('project.writeConcurrency.set', { ...params, override: 'single_writer' }, 'r152-policy-receipt')).error?.code).toBe('IDEMPOTENCY_CONFLICT');
      expect((await f.raw('project.writeConcurrency.set', { ...params, override: null })).error?.code).toBe('STALE_REVISION');
      expect(f.count("SELECT count(*) n FROM domain_events WHERE kind='project.writeConcurrencyChanged'")).toBe(1);
      expect((await setPolicy(f, 'single_writer')).effectivePolicy).toBe('single_writer');
      expect((await setPolicy(f, null)).effectivePolicy).toBe('session_scope');
      expect(f.db.prepare('SELECT write_concurrency_policy FROM projects WHERE id=?').get(projectId)).toEqual({ write_concurrency_policy: 'single_writer' });
      const remote = await dispatchDaemonCommand({ db: f.db, localUserId: 'u_local', appDataDir: f.dir, interruptTurn: async () => {}, remoteAudit: { deviceId: 'synthetic', authEpoch: 1 } },
        { protocolVersion: 1, commandId: randomUUID(), method: 'project.writeConcurrency.set', params: { projectId, expectedRevision: 0, override: 'parallel_writers' } }) as {ok:boolean};
      expect(remote.ok).toBe(false);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    } finally { await f.close(); }
  });

  it.each([null, 'single_writer', 'parallel_writers'] as const)('formal DIRECT root sharing respects override=%s', async override => {
    const adapter = new ObservedAdapter({ turnScriptSequencer: () => finish('完成', 350) });
    const f = await collisionFixture('r152-direct-' + (override ?? 'default'), { members: 2, writable: true, adapter });
    try {
      if (override) await setPolicy(f, override);
      const a = await f.send(0, 0, [0], 'TOKEN_FIRST');
      const b = await f.send(0, 1, [1], 'TOKEN_SECOND');
      await f.worker.drain();
      expect(adapter.active.size).toBe(override === 'single_writer' ? 1 : 2);
      expect(adapter.turns.every(t => adapter.sessionsSeen.get(t.sessionId)?.writeAccess?.fullAccess === true)).toBe(true);
      await f.pumpUntil(() => [a, b].every(t => f.taskStatus(t.taskId) === 'DONE'));
      expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status!='released'")).toBe(0);
    } finally { await f.close(); }
  }, 10_000);

  it.each([null, 'parallel_writers'] as const)('formal DELIB same-thread different members overlap only with explicit parallel override=%s', async override => {
    const adapter = new ObservedAdapter({ structuredFinal: false, turnScriptSequencer: () => finish(JSON.stringify({ schemaVersion: 'analysis-draft-v1', summary: '独立分析', claims: [{ claimId: 'a', statement: '方案', kind: 'proposal', evidenceIds: [] }], recommendations: [], openQuestions: [] }), 600) });
    const f = await collisionFixture('r152-delib-' + (override ?? 'default'), { members: 2, writable: true, adapter });
    const decisions: unknown[] = [];
    class ObservedAdmission extends DispatchAdmission {
      override tryAcquire(id: string, dims: AdmissionDimensions) { const result = super.tryAcquire(id, dims); decisions.push({dims,result}); return result; }
    }
    const worker = new DispatchWorker({ db: f.db, adapter, admission: new ObservedAdmission(), leaseOwner: randomUUID(), appDataDir: f.dir, enableDeliberate: true, detachedTurnConsumption: true, automaticRecovery: false });
    try {
      if (override) await setPolicy(f, override);
      const project = f.projects[0]!, room = project.rooms[0]!;
      await f.cmd('message.submit', { target: { kind: 'room_root', projectId: project.id, roomId: room.id, conversationId: room.conversationId }, body: '两位成员独立分析方案', intent: 'default', collaboration: 'deliberate', mentions: project.members.map(memberId => ({ kind: 'member', memberId })) });
      await worker.runOnce(); await worker.drain();
      expect(adapter.active.size, JSON.stringify(decisions)).toBe(override ? 2 : 1);
      expect(new Set([...adapter.active.values()].map(s => s.threadId)).size).toBe(1);
      expect(new Set([...adapter.active.values()].map(s => s.memberId)).size).toBe(override ? 2 : 1);
      expect([...adapter.active.values()].every(s => s.writeAccess?.fullAccess === true)).toBe(true);
      if (override) {
        expect(f.count("SELECT count(*) n FROM workspace_leases WHERE status='active'")).toBe(2);
        expect(f.count("SELECT count(*) n FROM daemon_state WHERE key LIKE 'write-overlap:%' AND value='true'")).toBe(2);
        expect(f.count("SELECT count(*) n FROM change_sets WHERE json_extract(manifest_json,'$.concurrentWriteObservation')=1")).toBeGreaterThan(0);
      }
    } finally { await worker.awaitInFlightTurns(2000); await adapter.closeAllSessions(); await f.close(); }
  }, 10_000);

  it.each(['same-member', 'restricted'] as const)('formal explicit parallel setting still serializes %s writers', async mode => {
    const adapter = new ObservedAdapter({ turnScriptSequencer: () => finish('完成', 200) });
    const f = await collisionFixture('r152-exclusive-' + mode, { members: 2, writable: true, adapter });
    try {
      await setPolicy(f, 'parallel_writers');
      if (mode === 'restricted') {
        for (const memberId of f.projects[0]!.members) await f.cmd('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'acceptEdits' });
        await f.cmd('project.writeAccess.set', { projectId: f.projects[0]!.id, authorized: true, expectedRevision: 0 });
      }
      const a = await f.send(0, 0, [0], 'TOKEN_FIRST');
      const b = await f.send(0, 1, [mode === 'same-member' ? 0 : 1], 'TOKEN_SECOND');
      await f.worker.drain(); expect(adapter.active.size).toBe(1);
      await f.pumpUntil(() => [a, b].every(t => f.taskStatus(t.taskId) === 'DONE'));
      expect(adapter.peakWritableRoot).toBe(1);
    } finally { await f.close(); }
  }, 10_000);

  it('parallel keeps same-member exclusion, restricted writes, foreign projects and parent roots exclusive', () => {
    const admission = new DispatchAdmission({ globalMaxInFlight: 20, perProjectMaxInFlight: 20, perProviderMaxInFlight: 20 });
    const dims = { projectId: 'p', memberId: 'a', providerKey: 'fake', executionScopeKey: 'one', writeRootKey: 'D:/fixture/root', writePolicy: 'parallel_writers' as const, writeFullAccess: true, writeSessionScopeKey: 'thread' };
    expect(admission.tryAcquire('a', dims)).toEqual({ granted: true });
    for (const change of [{ executionScopeKey: 'other' }, { memberId: 'b', writeFullAccess: false }, { memberId: 'b', projectId: 'other' }, { memberId: 'b', writeRootKey: 'D:/fixture/root/child' }, { memberId: 'b', writePolicy: 'single_writer' as const }]) {
      expect(admission.tryAcquire(randomUUID(), { ...dims, ...change }).granted).toBe(false);
    }
    expect(admission.tryAcquire('b', { ...dims, memberId: 'b', executionScopeKey: 'two' })).toEqual({ granted: true });
  });

  it.each(['UNKNOWN', 'retained', 'expired', 'missing-lease'] as const)('restart and setting changes retain protection for %s', async protection => {
    const adapter = new ObservedAdapter({ turnScriptSequencer: () => finish('完成', 1000) });
    const f = await collisionFixture('r152-protection-' + protection, { members: 2, writable: true, adapter });
    try {
      await setPolicy(f, 'parallel_writers');
      await f.send(0, 0, [0], 'TOKEN_HOLDER'); await f.worker.runOnce();
      const turn = adapter.turns[0]!, root = comparisonKey(f.projects[0]!.path);
      expect(recordedWriteConcurrency(f.db, turn.turnId, root).writePolicy).toBe('parallel_writers');
      if (protection === 'UNKNOWN' || protection === 'missing-lease') f.db.prepare("UPDATE agent_turns SET status='UNKNOWN' WHERE id=?").run(turn.turnId);
      if (protection === 'retained') f.db.prepare("UPDATE agent_turns SET protection_state='retained' WHERE id=?").run(turn.turnId);
      if (protection === 'expired') f.db.prepare("UPDATE workspace_leases SET status='expired' WHERE owner_turn_id=?").run(turn.turnId);
      if (protection === 'missing-lease') f.db.prepare('DELETE FROM workspace_leases WHERE owner_turn_id=?').run(turn.turnId);
      expect(recordedWriteConcurrency(f.db, turn.turnId, root).writePolicy).toBe('single_writer');
      const setting = projectWriteConcurrency(f.db, f.projects[0]!.id)!;
      expect((await f.raw('project.writeConcurrency.set', { projectId: setting.projectId, expectedRevision: setting.revision, override: null })).error?.code).toBe('WORKER_STILL_RUNNING');
      const admission = new DispatchAdmission();
      new DispatchWorker({ db: f.db, adapter: new ObservedAdapter(), admission, leaseOwner: randomUUID(), appDataDir: f.dir, automaticRecovery: false });
      expect(admission.snapshot().global).toBe(1);
      const next = await f.send(0, 1, [1], 'TOKEN_BLOCKED');
      await f.worker.drain(); expect(adapter.turns).toHaveLength(1);
      expect(f.count("SELECT count(*) n FROM domain_events WHERE task_id=? AND kind='changeset.baselineCaptured'", next.taskId)).toBe(0);
      expect(f.count('SELECT count(*) n FROM real_calls')).toBe(0);
    } finally { await f.close(); }
  }, 10_000);

  it('stored parallel facts survive reopen and a later setting never converts an existing lease', async () => {
    const adapter = new ObservedAdapter({ turnScriptSequencer: () => finish('完成', 600) });
    const f = await collisionFixture('r152-frozen-policy', { members: 2, writable: true, adapter });
    let second: ReturnType<typeof openDatabase> | undefined;
    try {
      await f.send(0, 0, [0], 'TOKEN_LEGACY_SCOPE'); await f.worker.runOnce();
      const turn = adapter.turns[0]!, root = comparisonKey(f.projects[0]!.path);
      second = openDatabase(join(f.dir, 'state.sqlite'));
      expect(recordedWriteConcurrency(second, turn.turnId, root).writePolicy).toBe('session_scope');
      // Deliberately bypass the command guard to test stale/in-flight leases.
      f.db.prepare("UPDATE projects SET write_concurrency_override='parallel_writers' WHERE id=?").run(f.projects[0]!.id);
      expect(recordedWriteConcurrency(second, turn.turnId, root).writePolicy).toBe('session_scope');
      const b = await f.send(0, 1, [1], 'TOKEN_NEW_POLICY'); await f.worker.drain();
      expect(adapter.turns).toHaveLength(1);
      await f.pumpUntil(() => f.taskStatus(b.taskId) === 'DONE');
      expect(resolveWriteConcurrency(f.db, { projectId: f.projects[0]!.id, fullAccess: false, eligible: true, sessionScopeKey: 'scope' })).toEqual({ writePolicy: 'single_writer' });
      expect(acquireLease(f.db, { ownerTurnId: turn.turnId, lockDomain: root, policy: 'parallel_writers', now: Date.now() }).ok).toBe(false);
    } finally { second?.close(); await f.close(); }
  }, 10_000);
});
