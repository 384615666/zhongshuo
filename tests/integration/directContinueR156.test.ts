import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchBlockedFixture } from '../fixtures/dispatchBlockedR154.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';
import { assessTaskRedispatchReadiness } from '../../src/persistence/stores/recoveryGuard.ts';
import { DispatchWorker, type TaskRow } from '../../src/daemon/dispatchWorker.ts';
import type { NormalizedRuntimeEvent } from '../../src/contracts/runtime.ts';
import { DispatchAdmission } from '../../src/daemon/admission.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { completeOutbox, failOutbox, releaseOutbox } from '../../src/persistence/outbox.ts';
import { holdDispatchGate } from '../../src/persistence/daemonState.ts';
import { freezeCoordinationScope } from '../../src/daemon/coordination.ts';
import { readTaskExecutionStatus } from '../../src/daemon/executionStatus.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { snapshotTaskWriteAccess } from '../../src/daemon/projectWriteAccess.ts';

type Reply = {
  ok: boolean;
  commandId: string;
  replayed?: boolean;
  data?: { enqueued?: boolean; dispatchKey?: string; disposition?: string; messageId?: string; taskId?: string;
    interruptedRuns?: Array<{ id: string; task_id: string; status: string }>;
    unknownTurns?: Array<{ id: string; taskId: string; status: string; protectionReleased: boolean }>;
    applied?: Array<{ eventKey: string; outcome: string }> };
  error?: { code: string; message: string };
};
type Fixture = ReturnType<typeof fixture>;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
});

/** R155's parent/child interruption, with an actual isolated project directory.
 * The old execution is Pi; only new configuration snapshots use fake runtime.
 * All worker execution below uses fake runtime and makes zero model calls. */
function fixture(options: { status?: 'UNKNOWN' | 'FAILED'; budgetMark?: 'settled' | 'refunded' | null; lease?: boolean } = {}) {
  vi.stubEnv('ZS_RUNTIME', 'fake');
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  const root = mkdtempSync(join(tmpdir(), 'zs-r156-direct-continue-'));
  const { db, event } = dispatchBlockedFixture();
  cleanups.push(() => {
    try { db.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const project = realpathSync.native(root);
  db.prepare('UPDATE projects SET root_path=?,canonical_path=? WHERE id=\'p\'').run(project, project);
  db.prepare("UPDATE conversations SET last_message_seq=1 WHERE id='conv'").run();
  db.prepare("UPDATE messages SET body_json=? WHERE id='msg'").run(JSON.stringify({ text: '继续原有项目工作', mentions: [] }));
  db.prepare("UPDATE conversation_threads SET root_task_id='parent' WHERE id='thread'").run();
  const status = options.status ?? 'UNKNOWN';
  const budgetMark = options.budgetMark === undefined ? 'settled' : options.budgetMark;
  const budget = { runMaxTurns: 9, usedTurns: 2, inFlightReservedTurns: budgetMark == null ? 1 : 0,
    tailReservationByStage: { SYNTHESIS: 1, RATIFY: 2 } };
  db.prepare(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status,budget_json)
    VALUES('interrupted','child','conv','thread','DIRECT','INTERRUPTED',?)`).run(JSON.stringify(budget));
  db.prepare(`INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,
    protection_state,budget_mark,dispatch_key) VALUES('lost','interrupted','conv','thread','reviewer',
    'coordination.child',?,'retained',?,'task:child:legacy-pi')`).run(status, budgetMark);
  event('child', 'interrupted', 'turn.statusChanged', { status: 'RUNNING', adapterKind: 'pi' }, 'lost');
  event('child', 'interrupted', 'tool.started', { toolCallId: 'old-tool', toolName: 'Bash', target: 'python --version' }, 'lost');
  event('child', 'interrupted', 'turn.statusChanged', { status }, 'lost');
  db.exec(`INSERT INTO outbox(dispatch_key,turn_id,status,attempt_epoch,stop_generation_at_enqueue) VALUES
    ('task:child:legacy-pi','lost','done',3,0),('task:child:old-failed',NULL,'failed',2,0);`);
  if (options.lease !== false) {
    db.prepare(`INSERT INTO workspace_leases(lock_domain,owner_turn_id,epoch,heartbeat_at,status)
      VALUES(?,'lost',1,0,'expired')`).run(project);
  }
  const interruptTurn = vi.fn(async () => {});
  const releaseAdmission = vi.fn<(turnId: string) => void>();
  const processQuery = vi.fn((): never => { throw Error('Direct continue must not require an OS probe'); });
  const processTree = vi.fn((): never => { throw Error('Direct continue must not require an OS tree scan'); });
  const deps: DaemonCommandDeps = { db, localUserId: 'u', appDataDir: root, interruptTurn, releaseAdmission, processQuery, processTree };
  const command = (method: string, params: unknown, commandId = randomUUID(), overrides: Partial<DaemonCommandDeps> = {}) =>
    dispatchDaemonCommand({ ...deps, ...overrides }, { protocolVersion: 1, commandId, method, params }) as Promise<Reply>;
  const binding = () => {
    const task = db.prepare("SELECT revision,stop_generation FROM tasks WHERE id='parent'").get() as { revision: number; stop_generation: number };
    return { taskId: 'parent', sourceRunId: 'parent-current', expectedTaskRevision: task.revision, expectedStopGeneration: task.stop_generation };
  };
  const followUp = (extra: Record<string, unknown> = {}) => ({
    target: { kind: 'thread', projectId: 'p', conversationId: 'conv', threadId: 'thread' },
    body: '继续完成刚才的工作', intent: 'default', mentions: [{ kind: 'member', memberId: 'owner' }], ...extra,
  });
  const readBudget = () => JSON.parse((db.prepare("SELECT budget_json FROM workflow_runs WHERE id='interrupted'").get() as { budget_json: string }).budget_json) as typeof budget;
  return { db, event, root, command, binding, followUp, readBudget, interruptTurn, releaseAdmission, processQuery, processTree };
}

function snapshot(f: Fixture) {
  const tables = ['tasks', 'workflow_runs', 'agent_turns', 'workspace_leases', 'domain_events', 'outbox',
    'messages', 'conversation_threads', 'thread_reply_requests', 'coordination_runs', 'coordination_steps',
    'runtime_process_registry', 'recovery_exit_probes', 'daemon_state'];
  // Use the schema's available process-registration table across fixture versions.
  return Object.fromEntries(tables.filter(table => f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    .map(table => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function releasedEvents(f: Fixture, turnId = 'lost') {
  return f.db.prepare("SELECT task_id,run_id,turn_id,payload_json FROM domain_events WHERE kind='recovery.protectionReleased' AND turn_id=? ORDER BY seq")
    .all(turnId) as Array<{ task_id: string; run_id: string; turn_id: string; payload_json: string }>;
}

function expectReleased(f: Fixture, status = 'UNKNOWN', budgetMark = 'settled') {
  expect(f.db.prepare("SELECT status,protection_state,budget_mark FROM agent_turns WHERE id='lost'").get())
    .toEqual({ status, protection_state: 'released', budget_mark: budgetMark });
  expect(f.db.prepare("SELECT 1 FROM workspace_leases WHERE owner_turn_id='lost' AND status!='released'").get()).toBeUndefined();
  const events = releasedEvents(f);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ task_id: 'child', run_id: 'interrupted', turn_id: 'lost' });
  expect(JSON.parse(events[0]!.payload_json)).toMatchObject({ released: true });
  expect(f.releaseAdmission.mock.calls).toEqual([['lost']]);
  expect(f.processQuery).not.toHaveBeenCalled();
  expect(f.processTree).not.toHaveBeenCalled();
  expect(f.interruptTurn).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT * FROM recovery_exit_probes').all()).toEqual([]);
  expect(assessTaskRedispatchReadiness(f.db, 'parent')).toBeNull();
}

function expectEnqueued(result: Reply) {
  expect(result, JSON.stringify(result.error)).toMatchObject({ ok: true, data: { enqueued: true } });
  expect(result.data?.dispatchKey).toBe('task:parent:redispatch:parent-current');
}

async function expectHistoricalInterruptionClosed(f: Fixture) {
  const status = await f.command('recovery.status', {});
  expect(status.ok).toBe(true);
  expect(status.data?.interruptedRuns).not.toContainEqual(expect.objectContaining({ id: 'interrupted', task_id: 'child' }));
  expect(status.data?.unknownTurns).toContainEqual(expect.objectContaining({ id: 'lost', taskId: 'child', status: 'UNKNOWN', protectionReleased: true }));
  return status.data!;
}

async function expectRejectedWithoutRelease(f: Fixture, params: unknown, code: string, overrides: Partial<DaemonCommandDeps> = {}, method = 'task.continue') {
  const before = snapshot(f);
  const result = await f.command(method, params, randomUUID(), overrides);
  expect(result).toMatchObject({ ok: false, error: { code } });
  expect(snapshot(f)).toEqual(before);
  expect(f.releaseAdmission).not.toHaveBeenCalled();
  expect(f.processQuery).not.toHaveBeenCalled();
  expect(f.processTree).not.toHaveBeenCalled();
}

describe('R156 direct continue of historical interruptions', () => {
  it.each(['task.continue', 'task.redispatch'])('%s closes the old Pi child and enqueues once without note, inspection or reboot evidence', async method => {
    const f = fixture();
    const history = f.db.prepare('SELECT * FROM domain_events ORDER BY seq').all();
    const runs = f.db.prepare('SELECT * FROM workflow_runs ORDER BY rowid').all();
    const outbox = f.db.prepare('SELECT * FROM outbox ORDER BY id').all();
    expect(assessTaskRedispatchReadiness(f.db, 'parent')).toMatchObject({ code: 'RECONCILE_REQUIRED' });
    expectEnqueued(await f.command(method, f.binding()));
    expectReleased(f);
    await expectHistoricalInterruptionClosed(f);
    expect(f.db.prepare('SELECT * FROM workflow_runs ORDER BY rowid').all()).toEqual(runs);
    expect(f.db.prepare('SELECT * FROM domain_events ORDER BY seq LIMIT ?').all(history.length)).toEqual(history);
    expect(f.db.prepare('SELECT * FROM outbox ORDER BY id LIMIT ?').all(outbox.length)).toEqual(outbox);
    expect(f.db.prepare("SELECT dispatch_key,status,turn_id FROM outbox WHERE status='pending'").all())
      .toEqual([{ dispatch_key: 'task:parent:redispatch:parent-current', status: 'pending', turn_id: null }]);
    expect(f.db.prepare("SELECT * FROM domain_events WHERE kind IN ('recovery.reconciled','recovery.processProbed')").all()).toEqual([]);
  });

  it('accepts the minimal taskId-only continue contract', async () => {
    const f = fixture({ lease: false });
    expectEnqueued(await f.command('task.continue', { taskId: 'parent' }));
    expectReleased(f);
  });

  it('settles an unset budget exactly once, preserving UNKNOWN, tail reservations and the original run', async () => {
    const f = fixture({ budgetMark: null });
    const commandId = randomUUID(), params = f.binding();
    const result = await f.command('task.continue', params, commandId);
    expectEnqueued(result);
    expectReleased(f);
    expect(f.readBudget()).toEqual({ runMaxTurns: 9, usedTurns: 3, inFlightReservedTurns: 0, tailReservationByStage: { SYNTHESIS: 1, RATIFY: 2 } });
    const after = snapshot(f);
    const replay = await f.command('task.continue', params, commandId);
    expect(replay).toMatchObject({ ok: true, replayed: true, data: result.data });
    expect(snapshot(f)).toEqual(after);
    expect(f.releaseAdmission.mock.calls).toEqual([['lost']]);
  });

  it('releases FAILED/refunded retained protection without charging or refunding again', async () => {
    const f = fixture({ status: 'FAILED', budgetMark: 'refunded' });
    const budget = f.readBudget();
    expectEnqueued(await f.command('task.continue', f.binding()));
    expectReleased(f, 'FAILED', 'refunded');
    expect(f.readBudget()).toEqual(budget);
  });

  it('replays the same accepted commandId without another queue row, event or admission release', async () => {
    const f = fixture();
    const commandId = randomUUID(), params = f.binding();
    const result = await f.command('task.continue', params, commandId);
    expectEnqueued(result);
    const after = snapshot(f);
    expect(await f.command('task.continue', params, commandId)).toMatchObject({ ok: true, replayed: true, data: result.data });
    expect(snapshot(f)).toEqual(after);
    expectReleased(f);
  });

  it.each(['run', 'turn', 'both'] as const)('does not bypass an active child %s or release its historical sibling', async active => {
    const f = fixture({ budgetMark: null });
    f.db.prepare(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status)
      VALUES('active-run','old-child','conv','thread','DIRECT',?)`).run(active === 'turn' ? 'INTERRUPTED' : 'RUNNING');
    if (active !== 'run') f.db.exec(`INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status)
      VALUES('active-turn','active-run','conv','thread','reviewer','direct.work','RUNNING');`);
    await expectRejectedWithoutRelease(f, f.binding(), 'WORKER_STILL_RUNNING');
  });

  it.each([
    ['revision', { expectedTaskRevision: 100 }, 'STALE_REVISION'],
    ['stop generation', { expectedStopGeneration: 1 }, 'STALE_REVISION'],
    ['old source', { sourceRunId: 'parent-old' }, 'STALE_REVISION'],
    ['foreign child source', { sourceRunId: 'interrupted' }, 'RESOURCE_NOT_FOUND'],
    ['missing source', { sourceRunId: 'missing' }, 'RESOURCE_NOT_FOUND'],
    ['invalid revision', { expectedTaskRevision: -1 }, 'VALIDATION_INVALID'],
  ] as const)('rejects %s with zero historical release or budget changes', async (_label, extra, code) => {
    const f = fixture({ budgetMark: null });
    await expectRejectedWithoutRelease(f, { ...f.binding(), ...extra }, code);
  });

  it('rejects an archived project with zero release', async () => {
    const f = fixture({ budgetMark: null });
    f.db.prepare("UPDATE projects SET status='archived' WHERE id='p'").run();
    await expectRejectedWithoutRelease(f, f.binding(), 'STALE_REVISION');
  });

  it.each(['DONE', 'CANCELLED'])('rejects a %s parent before historical cleanup', async status => {
    const f = fixture({ budgetMark: null });
    f.db.prepare("UPDATE tasks SET status=? WHERE id='parent'").run(status);
    await expectRejectedWithoutRelease(f, f.binding(), 'STALE_REVISION');
  });

  it('rejects unauthorized DM audience without releasing a descendant', async () => {
    const f = fixture({ budgetMark: null });
    f.db.exec(`INSERT INTO conversations(id,project_id,kind) VALUES('private','p','dm');
      UPDATE tasks SET conversation_id='private' WHERE id='parent';`);
    await expectRejectedWithoutRelease(f, f.binding(), 'FORBIDDEN');
  });

  it('honors authorization rejection at the commit gate without releasing admission or budget', async () => {
    const f = fixture({ budgetMark: null });
    const gate = vi.fn<NonNullable<DaemonCommandDeps['remoteGate']>>()
      .mockReturnValueOnce({ ok: true })
      .mockReturnValue({ ok: false, code: 'PERMISSION_DENIED', message: 'synthetic authorization revoked' });
    await expectRejectedWithoutRelease(f, f.binding(), 'PERMISSION_DENIED', { remoteGate: gate });
    expect(gate).toHaveBeenCalledTimes(2);
  });

  it('rolls historical cleanup back when the final enqueue fails', async () => {
    const f = fixture({ budgetMark: null });
    f.db.exec(`CREATE TRIGGER fail_r156_enqueue BEFORE INSERT ON outbox
      WHEN NEW.dispatch_key='task:parent:redispatch:parent-current'
      BEGIN SELECT RAISE(ABORT,'synthetic R156 enqueue failure'); END;`);
    const before = snapshot(f);
    const result = await f.command('task.continue', f.binding());
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(snapshot(f)).toEqual(before);
    expect(f.releaseAdmission).not.toHaveBeenCalled();
  });

  it('keeps a second commandId from creating another pending continue intent', async () => {
    const f = fixture();
    expectEnqueued(await f.command('task.continue', f.binding()));
    const before = snapshot(f);
    expect(await f.command('task.continue', f.binding())).toMatchObject({ ok: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(snapshot(f)).toEqual(before);
    expectReleased(f);
  });

  it.each(['pending', 'leased'])('closes and fences the old %s outbox linked to UNKNOWN without touching unbound new work', async status => {
    const f = fixture();
    f.db.prepare(`UPDATE outbox SET status=?,lease_owner='old-worker',lease_until=9999999999999
      WHERE dispatch_key='task:child:legacy-pi'`).run(status);
    f.db.exec(`INSERT INTO outbox(dispatch_key,status,lease_owner,lease_until,attempt_epoch,stop_generation_at_enqueue)
      VALUES('task:parent:thread-reply:new-accepted','leased','new-worker',9999999999999,8,0);`);
    const old = f.db.prepare("SELECT id,attempt_epoch FROM outbox WHERE turn_id='lost'").get() as { id: number; attempt_epoch: number };
    const other = f.db.prepare("SELECT * FROM outbox WHERE dispatch_key='task:parent:thread-reply:new-accepted'").get();
    expectEnqueued(await f.command('task.continue', f.binding()));
    expect(f.db.prepare('SELECT status,lease_owner,lease_until,attempt_epoch FROM outbox WHERE id=?').get(old.id))
      .toEqual({ status: 'done', lease_owner: null, lease_until: null, attempt_epoch: old.attempt_epoch + 1 });
    expect(completeOutbox(f.db, old.id, old.attempt_epoch)).toBe(false);
    expect(failOutbox(f.db, old.id, old.attempt_epoch)).toBe(false);
    expect(releaseOutbox(f.db, old.id, old.attempt_epoch)).toBe(false);
    expect(f.db.prepare("SELECT * FROM outbox WHERE dispatch_key='task:parent:thread-reply:new-accepted'").get()).toEqual(other);
    expectReleased(f);
  });

  it('settles two UNKNOWN turns in the same old run without losing either budget increment', async () => {
    const f = fixture({ budgetMark: null });
    f.db.prepare("UPDATE workflow_runs SET budget_json=json_set(budget_json,'$.inFlightReservedTurns',2) WHERE id='interrupted'").run();
    f.db.exec(`INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,protection_state)
      VALUES('lost-second','interrupted','conv','thread','writer','coordination.child','UNKNOWN','retained');`);
    expectEnqueued(await f.command('task.continue', f.binding()));
    expect(f.readBudget()).toMatchObject({ usedTurns: 4, inFlightReservedTurns: 0, tailReservationByStage: { SYNTHESIS: 1, RATIFY: 2 } });
    expect(f.releaseAdmission.mock.calls).toEqual([['lost'], ['lost-second']]);
    expect(releasedEvents(f)).toHaveLength(1);
    expect(releasedEvents(f, 'lost-second')).toHaveLength(1);
  });

  it('does not release interrupted turns outside the selected task subtree', async () => {
    const f = fixture();
    f.db.exec(`INSERT INTO messages(id,project_id,conversation_id,conversation_seq,room_id,author_type,author_id,body_json,created_at)
      VALUES('unrelated-msg','p','conv',2,'room','human','u','{}',0);
      INSERT INTO tasks(id,project_id,conversation_id,kind,room_id,conversation_thread_id,root_message_id,
      owner_member_id,title,status,review_policy) VALUES('unrelated','p','conv','room_task','room','thread','unrelated-msg',
      'writer','其他根任务','BLOCKED','auto_deliver');
      INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status)
      VALUES('unrelated-run','unrelated','conv','thread','DIRECT','INTERRUPTED');
      INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status,protection_state,budget_mark)
      VALUES('unrelated-turn','unrelated-run','conv','thread','writer','direct.work','UNKNOWN','retained',NULL);`);
    const unrelated = f.db.prepare("SELECT * FROM agent_turns WHERE id='unrelated-turn'").get();
    expectEnqueued(await f.command('task.continue', f.binding()));
    expectReleased(f);
    expect(f.db.prepare("SELECT * FROM agent_turns WHERE id='unrelated-turn'").get()).toEqual(unrelated);
    expect(releasedEvents(f, 'unrelated-turn')).toEqual([]);
    const recovery = await expectHistoricalInterruptionClosed(f);
    expect(recovery.interruptedRuns).toContainEqual({ id: 'unrelated-run', task_id: 'unrelated', status: 'INTERRUPTED' });
    expect(recovery.unknownTurns).toContainEqual(expect.objectContaining({ id: 'unrelated-turn', status: 'UNKNOWN', protectionReleased: false }));
  });
});

describe('R156 formal worker dispatch after direct continue', () => {
  function workerFixture(f: Fixture, plan = false) {
    const route = { kind: 'dispatch', mode: 'AUTO', coordinatorMemberId: 'owner', frozenMemberIds: ['owner', 'writer', 'reviewer'], initialWakeMemberIds: ['owner'] };
    f.db.prepare("UPDATE tasks SET route_json=? WHERE id='parent'").run(JSON.stringify(route));
    freezeCoordinationScope(f.db, 'parent');
    let starts = 0;
    const adapter = new FakeRuntimeAdapter({ sessionStoreDir: join(f.root, 'sessions'), turnScriptSequencer: () => [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify({
      schemaVersion: 'task-complete-v1', resultKey: 'fixture', answer: '完成本次继续', responseKind: 'work', changeSummary: '合成工作已完成',
      files: [], executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
      ...(plan && starts++ === 0 ? { coordinationPlan: { summary: '继续后的新计划', steps: [
        { key: 'fresh-analysis', memberId: 'writer', title: '新的分析步骤', objective: '独立完成本次请求', role: 'analysis', dependsOn: [] },
      ] } } : {}),
    }) } }] });
    const admission = new DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 4, perProviderMaxInFlight: 4 });
    const worker = new DispatchWorker({ db: f.db, adapter, admission, leaseOwner: 'r156-worker', appDataDir: f.root });
    const releaseAdmission = vi.fn((turnId: string) => worker.reconcileRelease(turnId));
    return { worker, adapter, admission, releaseAdmission };
  }

  it('releases restored UNKNOWN admission and a crash gate, then dispatches the continued parent through the worker', async () => {
    const f = fixture();
    const w = workerFixture(f);
    try {
      expect(w.admission.has('lost')).toBe(true);
      holdDispatchGate(f.db, 1000);
      expectEnqueued(await f.command('task.continue', f.binding(), randomUUID(), { releaseAdmission: w.releaseAdmission }));
      expect(w.admission.has('lost')).toBe(false);
      expect(await w.worker.runOnce()).toBe(true);
      expect(w.adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare("SELECT status FROM outbox WHERE dispatch_key='task:parent:redispatch:parent-current'").get()).toEqual({ status: 'done' });
      expect(f.db.prepare("SELECT status FROM agent_turns WHERE id='lost'").get()).toEqual({ status: 'UNKNOWN' });
      expect(f.db.prepare("SELECT status FROM tasks WHERE id='parent'").get()).toEqual({ status: 'DONE' });
      expect(f.db.prepare("SELECT state FROM coordination_runs WHERE run_id='parent-current'").get()).toEqual({ state: 'blocked' });
      await expectHistoricalInterruptionClosed(f);
      const restored = new DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 4, perProviderMaxInFlight: 4 });
      new DispatchWorker({ db: f.db, adapter: w.adapter, admission: restored, leaseOwner: 'r156-restored', appDataDir: f.root });
      expect(restored.has('lost')).toBe(false);
    } finally { await w.adapter.closeAllSessions(); }
  });

  it('runs a new parent plan, child and integration without reviving the obsolete blocked coordination', async () => {
    const f = fixture();
    const w = workerFixture(f, true);
    try {
      expectEnqueued(await f.command('task.continue', f.binding(), randomUUID(), { releaseAdmission: w.releaseAdmission }));
      for (let i = 0; i < 8; i++) if (!await w.worker.runOnce()) break;
      const failures=f.db.prepare("SELECT kind,payload_json FROM domain_events WHERE kind IN ('turn.outputInvalid','coordination.dispatchBlocked','run.dispatchFailed')").all();
      expect(w.adapter.startTurnLog, JSON.stringify(failures)).toHaveLength(3);
      expect(f.db.prepare("SELECT status FROM tasks WHERE id='parent'").get()).toEqual({ status: 'DONE' });
      expect(f.db.prepare("SELECT state FROM coordination_runs WHERE run_id='parent-current'").get()).toEqual({ state: 'blocked' });
      expect(f.db.prepare("SELECT state FROM coordination_runs WHERE task_id='parent' AND run_id NOT IN ('parent-current','parent-old')").all())
        .toEqual([{ state: 'completed' }]);
      expect(f.db.prepare("SELECT status FROM agent_turns WHERE id='lost'").get()).toEqual({ status: 'UNKNOWN' });
      expect(f.db.prepare("SELECT status FROM outbox WHERE dispatch_key='task:child:legacy-pi'").get()).toEqual({ status: 'done' });
      await expectHistoricalInterruptionClosed(f);
    } finally { await w.adapter.closeAllSessions(); }
  });

  it.each([
    { terminal: 'completed', budgetMark: 'settled' }, { terminal: 'failed', budgetMark: 'settled' },
    { terminal: 'completed', budgetMark: null }, { terminal: 'failed', budgetMark: null },
  ] as const)('keeps an abandoned UNKNOWN historical after late $terminal with initial budget $budgetMark', async ({ terminal, budgetMark }) => {
    const f = fixture({ budgetMark });
    const w = workerFixture(f);
    try {
      const session = await w.adapter.openSession({ projectId: 'p', memberId: 'reviewer', taskId: 'child', threadId: 'thread',
        sessionGeneration: 0, cwd: f.root, policyId: 'policy-analyze' });
      f.db.prepare(`INSERT INTO runtime_sessions(id,project_id,conversation_id,scope_kind,thread_id,member_id,task_id,cwd)
        VALUES(?,'p','conv','task','thread','reviewer','child',?)`).run(session.id, f.root);
      f.db.prepare("UPDATE agent_turns SET session_id=? WHERE id='lost'").run(session.id);
      f.db.prepare(`INSERT INTO context_bundles(id,turn_id,thread_id,task_revision,included_refs_json,scope_grants_json,hash)
        VALUES('lost-context','lost','thread',0,?,'[]','r156-synthetic')`).run(JSON.stringify({
        roleMemory: { scope: { projectId: 'p', memberId: 'reviewer', conversationId: 'conv' }, revision: 0, entries: [] },
      }));
      expectEnqueued(await f.command('task.continue', f.binding(), randomUUID(), { releaseAdmission: w.releaseAdmission }));
      await w.worker.runOnce();
      const budget = f.readBudget();
      const parent = f.db.prepare("SELECT * FROM tasks WHERE id='parent'").get();
      const child = f.db.prepare("SELECT * FROM tasks WHERE id='child'").get();
      const deliveries = f.db.prepare('SELECT * FROM task_deliveries ORDER BY rowid').all();
      const late = terminal === 'completed'
        ? { kind: 'turn.completed' as const, finalText: JSON.stringify({ schemaVersion: 'task-complete-v1', resultKey: 'result_lost',
          answer: '旧 Pi 的迟到结果', responseKind: 'work', changeSummary: '旧结果', files: [],
          executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
          memoryUpdates: [{ key: 'abandoned', text: 'R156_ABANDONED_RESULT_MUST_NOT_MERGE' }] }) }
        : { kind: 'turn.failed' as const, code: 'LATE_OLD_FAILURE', message: 'synthetic old execution failure', retryable: false };
      w.adapter.pushLateEvent(session.id, 'lost', late);
      const overrides = { pumpLateEvents: (turnId: string) => w.worker.pumpLateEventsForTurn(turnId) };
      const pumped = await f.command('recovery.pumpLateEvents', { turnId: 'lost' }, randomUUID(), overrides);
      expect(pumped).toMatchObject({ ok: true, data: { applied: [{ outcome: 'skipped-user-continue' }] } });
      expect(await f.command('recovery.pumpLateEvents', { turnId: 'lost' }, randomUUID(), overrides))
        .toMatchObject({ ok: true, data: { applied: [{ outcome: 'duplicate-ignored' }] } });
      expect(f.readBudget()).toEqual(budget);
      expect(f.db.prepare("SELECT status,protection_state,budget_mark FROM agent_turns WHERE id='lost'").get())
        .toEqual({ status: 'UNKNOWN', protection_state: 'released', budget_mark: 'settled' });
      expect(f.db.prepare("SELECT * FROM tasks WHERE id='parent'").get()).toEqual(parent);
      expect(f.db.prepare("SELECT * FROM tasks WHERE id='child'").get()).toEqual(child);
      expect(f.db.prepare('SELECT * FROM task_deliveries ORDER BY rowid').all()).toEqual(deliveries);
      expect(f.db.prepare("SELECT outcome FROM late_event_receipts WHERE turn_id='lost'").all()).toEqual([{ outcome: 'ignored' }]);
      expect(f.db.prepare("SELECT 1 FROM daemon_state WHERE key='role-memory-pending:lost'").get()).toBeUndefined();
      expect(f.db.prepare("SELECT 1 FROM role_memory_commits WHERE source_turn_id='lost'").get()).toBeUndefined();
      expect(f.db.prepare("SELECT kind FROM domain_events WHERE turn_id='lost' AND kind='turn.lateEventAfterContinue'").all()).toHaveLength(1);
      expect(w.adapter.startTurnLog).toHaveLength(1);
    } finally { await w.adapter.closeAllSessions(); }
  });

  it.each(['coordination.child', 'delib.independent'])('fences the direct event path for an abandoned %s attempt before it publishes or changes state', async stage => {
    const f = fixture();
    f.db.prepare("UPDATE agent_turns SET stage_key=? WHERE id='lost'").run(stage);
    const w = workerFixture(f);
    try {
      expectEnqueued(await f.command('task.continue', f.binding(), randomUUID(), { releaseAdmission: w.releaseAdmission }));
      const task = f.db.prepare("SELECT * FROM tasks WHERE id='child'").get() as TaskRow;
      const before = snapshot(f);
      const base = { sessionId: 'old-session', turnId: 'lost', receivedAt: 1000 };
      const events: NormalizedRuntimeEvent[] = [
        { ...base, eventKey: 'started-after-continue', kind: 'turn.started' },
        { ...base, eventKey: 'message-after-continue', kind: 'message.completed', messageId: 'old-answer', text: '不得发布的旧答案' },
        { ...base, eventKey: 'approval-after-continue', kind: 'approval.requested', approvalId: 'old-approval', request: {}, allowedChoices: ['deny'] },
        { ...base, eventKey: 'success-after-continue', kind: 'turn.completed', finalText: JSON.stringify({
          schemaVersion: 'task-complete-v1', resultKey: 'result_lost', changeSummary: '旧成功', files: [],
          executedVerifications: [], unexecutedVerifications: [], remainingIssues: [],
        }) },
        { ...base, eventKey: 'invalid-status-after-continue', kind: 'turn.failed', code: 'CODEX_INVALID_TERMINAL_STATUS', message: '旧无效状态', retryable: false },
        { ...base, eventKey: 'failure-after-continue', kind: 'turn.failed', code: 'OLD_FAILURE', message: '旧失败', retryable: false },
      ];
      for (const event of events) w.worker.applyEvent(task, 'interrupted', 'lost', event);
      const after = snapshot(f);
      expect({ ...after, domain_events: before.domain_events }).toEqual(before);
      expect(f.db.prepare("SELECT kind FROM domain_events WHERE turn_id='lost' AND kind='turn.lateEventAfterContinue'").all()).toHaveLength(events.length);
      expect(f.db.prepare("SELECT 1 FROM task_deliveries WHERE task_id='child'").get()).toBeUndefined();
      expect(w.adapter.startTurnLog).toHaveLength(0);
    } finally { await w.adapter.closeAllSessions(); }
  });
});

describe('R156 accepted thread follow-up closes historical interruptions', () => {
  it('accepts formal message.submit after a lost child, retains business history and queues only the new reply', async () => {
    const f = fixture({ budgetMark: null });
    const oldOutbox = f.db.prepare('SELECT * FROM outbox ORDER BY id').all();
    const commandId = randomUUID(), params = f.followUp();
    const result = await f.command('message.submit', params, commandId);
    expect(result, JSON.stringify(result.error)).toMatchObject({ ok: true, data: { taskId: 'parent', disposition: 'enqueued' } });
    expectReleased(f);
    await expectHistoricalInterruptionClosed(f);
    expect(f.readBudget().usedTurns).toBe(3);
    expect(f.readBudget().inFlightReservedTurns).toBe(0);
    expect(f.db.prepare('SELECT * FROM outbox ORDER BY id LIMIT ?').all(oldOutbox.length)).toEqual(oldOutbox);
    expect(f.db.prepare("SELECT dispatch_key,status,turn_id FROM outbox WHERE status='pending'").all())
      .toEqual([{ dispatch_key: result.data!.dispatchKey, status: 'pending', turn_id: null }]);
    expect(f.db.prepare('SELECT task_id,status FROM thread_reply_requests WHERE message_id=?').get(result.data!.messageId))
      .toEqual({ task_id: 'parent', status: 'queued' });
    const after = snapshot(f);
    expect(await f.command('message.submit', params, commandId)).toMatchObject({ ok: true, replayed: true, data: result.data });
    expect(snapshot(f)).toEqual(after);
    expect(f.releaseAdmission.mock.calls).toEqual([['lost']]);
  });

  it.each([
    ['stale roster', { threadMemberVersion: '0'.repeat(64) }, 'STALE_REVISION'],
    ['unavailable recipient', { mentions: [{ kind: 'member', memberId: 'missing-member' }] }, 'MEMBER_UNAVAILABLE'],
    ['invalid attachment', { attachmentRefs: ['missing-attachment'] }, 'RESOURCE_NOT_FOUND'],
  ] as const)('leaves interruptions intact when follow-up is rejected for %s', async (_label, extra, code) => {
    const f = fixture({ budgetMark: null });
    await expectRejectedWithoutRelease(f, f.followUp(extra), code, {}, 'message.submit');
  });

  it('keeps record_only messages from releasing historical protection', async () => {
    const f = fixture({ budgetMark: null });
    const turn = f.db.prepare("SELECT * FROM agent_turns WHERE id='lost'").get(), budget = f.readBudget();
    expect(await f.command('message.submit', f.followUp({ intent: 'record_only' })))
      .toMatchObject({ ok: true, data: { disposition: 'none' } });
    expect(f.db.prepare("SELECT * FROM agent_turns WHERE id='lost'").get()).toEqual(turn);
    expect(f.readBudget()).toEqual(budget);
    expect(releasedEvents(f)).toEqual([]);
    expect(f.releaseAdmission).not.toHaveBeenCalled();
  });
});

describe('R156 continue an existing queue blocked by another task', () => {
  function queuedWaiter(f: Fixture, status: 'pending' | 'leased' = 'pending', queuedRun = false) {
    const created = createRoomRootTask(f.db, {
      ids: { taskId: 'waiter', threadId: 'waiter-thread', messageId: 'waiter-msg', taskEventId: 'waiter-event', threadEventId: 'waiter-thread-event' },
      projectId: 'p', conversationId: 'conv', roomId: 'room', intent: 'default', title: '等待同成员的新任务', body: '当前已经排队的请求',
      mentions: [{ kind: 'member', memberId: 'reviewer' }], author: { authorType: 'human', authorId: 'u' },
      reviewPolicy: 'auto_deliver', sourceConnectionId: null,
      route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: 'reviewer', frozenMemberIds: ['reviewer'], initialWakeMemberIds: ['reviewer'] }, now: 1000,
    });
    expect(created.ok).toBe(true);
    snapshotTaskWriteAccess(f.db, 'waiter');
    if (queuedRun) f.db.exec(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status)
      VALUES('waiter-run','waiter','conv','waiter-thread','DIRECT','QUEUED');`);
    if (status === 'leased') f.db.prepare(`UPDATE outbox SET status='leased',lease_owner='previous-worker',lease_until=0,attempt_epoch=4
      WHERE dispatch_key='task:waiter:initial'`).run();
    const projection = readTaskExecutionStatus(f.db, 'waiter')!;
    expect(projection).toMatchObject({ phase: 'ADMISSION_WAITING', reason: { code: 'PRIOR_UNKNOWN_BLOCKS_ADMISSION', taskId: 'child', turnId: 'lost' } });
    const action = projection.actions.find(action => action.kind === 'continue');
    expect(action?.kind).toBe('continue');
    if (action?.kind !== 'continue') throw Error('Missing formal continue binding');
    expect(action.binding.taskId).toBe('waiter');
    return action.binding;
  }

  it.each(['pending', 'leased'] as const)('releases the exact external blocker and reuses the current %s intent without replaying either task', async status => {
    const f = fixture({ budgetMark: null });
    const binding = queuedWaiter(f, status);
    const adapter = new FakeRuntimeAdapter();
    const admission = new DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 4, perProviderMaxInFlight: 4 });
    const worker = new DispatchWorker({ db: f.db, adapter, admission, leaseOwner: 'r156-queued-worker', appDataDir: f.root });
    const release = vi.fn((turnId: string) => worker.reconcileRelease(turnId));
    try {
      expect(admission.has('lost')).toBe(true);
      const outbox = f.db.prepare('SELECT * FROM outbox ORDER BY id').all();
      const commandId = randomUUID();
      const result = await f.command('task.continue', binding, commandId, { releaseAdmission: release });
      expect(result, JSON.stringify(result.error)).toMatchObject({ ok: true, data: { enqueued: true, dispatchKey: 'task:waiter:initial' } });
      expect(release.mock.calls).toEqual([['lost']]);
      expect(admission.has('lost')).toBe(false);
      expect(f.readBudget()).toMatchObject({ usedTurns: 3, inFlightReservedTurns: 0 });
      expect(f.db.prepare('SELECT * FROM outbox ORDER BY id').all()).toEqual(outbox);
      expect(f.db.prepare("SELECT * FROM domain_events WHERE task_id='waiter' AND kind='task.redispatchEnqueued'").all()).toEqual([]);
      expect(f.db.prepare("SELECT kind FROM domain_events WHERE task_id='waiter' AND kind='task.queuedContinuationRequested'").all()).toHaveLength(1);
      expect(await f.command('task.continue', binding, commandId, { releaseAdmission: release })).toMatchObject({ ok: true, replayed: true, data: result.data });
      expect(release.mock.calls).toEqual([['lost']]);
      expect(await worker.runOnce()).toBe(true);
      expect(adapter.startTurnLog).toHaveLength(1);
      expect(f.db.prepare("SELECT status FROM outbox WHERE dispatch_key='task:waiter:initial'").get()).toEqual({ status: 'done' });
      expect(f.db.prepare("SELECT status FROM tasks WHERE id='waiter'").get()).toEqual({ status: 'DONE' });
      expect(f.db.prepare("SELECT status FROM agent_turns WHERE id='lost'").get()).toEqual({ status: 'UNKNOWN' });
      expect(f.db.prepare("SELECT 1 FROM workflow_runs WHERE task_id IN ('parent','child') AND status='RUNNING'").get()).toBeUndefined();
    } finally { await adapter.closeAllSessions(); }
  });

  it('preserves a synthetic legacy QUEUED workflow while reusing its existing intent without duplicate dispatch', async () => {
    const f = fixture();
    const binding = queuedWaiter(f, 'pending', true);
    const outbox = f.db.prepare('SELECT * FROM outbox ORDER BY id').all();
    const run = f.db.prepare("SELECT * FROM workflow_runs WHERE id='waiter-run'").get();
    expect(await f.command('task.continue', binding)).toMatchObject({ ok: true, data: { enqueued: true, dispatchKey: 'task:waiter:initial' } });
    expect(f.db.prepare('SELECT * FROM outbox ORDER BY id').all()).toEqual(outbox);
    expect(f.db.prepare("SELECT * FROM workflow_runs WHERE id='waiter-run'").get()).toEqual(run);
    expect(f.releaseAdmission.mock.calls).toEqual([['lost']]);
  });

  it('rolls back an external blocker release if current input revision is stale', async () => {
    const f = fixture({ budgetMark: null });
    const binding = queuedWaiter(f);
    await expectRejectedWithoutRelease(f, { ...binding, expectedTaskRevision: binding.expectedTaskRevision + 1 }, 'STALE_REVISION');
  });

  it('does not release an external blocker for a current task that already has an active turn', async () => {
    const f = fixture({ budgetMark: null });
    const binding = queuedWaiter(f);
    f.db.exec(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status)
      VALUES('waiter-active','waiter','conv','waiter-thread','DIRECT','RUNNING');
      INSERT INTO agent_turns(id,run_id,conversation_id,thread_id,member_id,stage_key,status)
      VALUES('waiter-active-turn','waiter-active','conv','waiter-thread','reviewer','direct.work','RUNNING');`);
    await expectRejectedWithoutRelease(f, binding, 'WORKER_STILL_RUNNING');
  });

  it('keeps the RUNNING workflow guard even before its current turn has been recorded', async () => {
    const f = fixture({ budgetMark: null });
    const binding = queuedWaiter(f);
    f.db.exec(`INSERT INTO workflow_runs(id,task_id,conversation_id,thread_id,mode,status)
      VALUES('waiter-active','waiter','conv','waiter-thread','DIRECT','RUNNING');`);
    await expectRejectedWithoutRelease(f, binding, 'WORKER_STILL_RUNNING');
  });

  it('refuses an external blocker outside the current user DM audience with zero release', async () => {
    const f = fixture({ budgetMark: null });
    const binding = queuedWaiter(f);
    f.db.exec(`INSERT INTO conversations(id,project_id,kind) VALUES('private-blocker','p','dm');
      UPDATE tasks SET conversation_id='private-blocker' WHERE id='child';`);
    await expectRejectedWithoutRelease(f, binding, 'FORBIDDEN');
  });
});
