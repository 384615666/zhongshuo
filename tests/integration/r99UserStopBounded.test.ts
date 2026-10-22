import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { DispatchAdmission } from '../../src/daemon/admission.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r99-stop-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待超时');
}

function setup(db: ZhongshuoDatabase, n: number): { taskId: string; runId: string; turnId: string } {
  const projectId = `p_stop_${n}`;
  const path = join(root, projectId);
  mkdirSync(path, { recursive: true });
  db.prepare(`INSERT INTO projects (id,display_name,root_path,canonical_path,directory_identity,created_at)
    VALUES(?,?,?,?, '{}',0)`).run(projectId, projectId, path, path);
  db.prepare(`INSERT INTO project_members (id,project_id,display_name,principal_type,enabled)
    VALUES(?,?,?,'agent',1)`).run(`m${n}`, projectId, `成员${n}`);
  db.prepare('INSERT INTO rooms (id,project_id,name,coordinator_member_id) VALUES(?,?,?,?)').run(`r${n}`, projectId, `r${n}`, `m${n}`);
  db.prepare("INSERT INTO conversations (id,project_id,kind,room_id) VALUES(?,?,'room',?)").run(`c${n}`, projectId, `r${n}`);
  const taskId = `task_stop_${n}`;
  const created = createRoomRootTask(db, {
    ids: { messageId: `msg_stop_${n}`, threadId: `thread_stop_${n}`, taskId, taskEventId: `evt_task_stop_${n}`, threadEventId: `evt_thread_stop_${n}` },
    projectId, conversationId: `c${n}`, roomId: `r${n}`, intent: 'default', title: `停止测试 ${n}`, body: '停止测试',
    mentions: [{ kind: 'member', memberId: `m${n}` }], author: { authorType: 'human', authorId: 'u_local' },
    reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: `m${n}`, frozenMemberIds: [`m${n}`], initialWakeMemberIds: [`m${n}`] },
    now: n,
  });
  if (!created.ok) throw new Error(created.error.message);
  return { taskId, runId: '', turnId: '' };
}

async function runStop(n: number, script: FakeTurnScript, opts: { hangInterrupt?: boolean; repeated?: boolean } = {}) {
  const db = openDatabase(':memory:');
  const ids = setup(db, n);
  const adapter = new FakeRuntimeAdapter({ turnScripts: [script], hangInterrupt: opts.hangInterrupt });
  const admission = new DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 1, perProviderMaxInFlight: 1 });
  const worker = new DispatchWorker({
    db, adapter, leaseOwner: `w-stop-${n}`, admission, detachedTurnConsumption: true,
    turnDeadlineMs: null, interruptGraceMs: 80, appDataDir: join(root, `data-${n}`),
  });
  await worker.runOnce();
  const turn = db.prepare('SELECT id,run_id FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id=?)').get(ids.taskId) as { id: string; run_id: string };
  ids.runId = turn.run_id;
  ids.turnId = turn.id;
  await waitUntil(() => (db.prepare('SELECT status FROM agent_turns WHERE id=?').get(turn.id) as { status: string }).status === 'RUNNING');
  const deps = { db, localUserId: 'u_local', interruptTurn: (turnId: string) => worker.interruptTurn(turnId) };
  const stop = async (expectedStopGeneration: number) => dispatchDaemonCommand(deps, {
    protocolVersion: 1, commandId: `r99-stop-${randomUUID()}`, method: 'task.stop',
    params: { taskId: ids.taskId, targetRunId: ids.runId, expectedStopGeneration },
  });
  const started = Date.now();
  const first = await stop(0) as { ok: boolean };
  expect(first.ok).toBe(true);
  if (opts.repeated) {
    const second = await stop(0) as { ok: boolean };
    expect(second.ok).toBe(true);
  }
  await waitUntil(() => {
    const status = (db.prepare('SELECT status FROM agent_turns WHERE id=?').get(turn.id) as { status: string }).status;
    return status === 'UNKNOWN' || status === 'CANCELLED';
  }, 4_000);
  await worker.awaitInFlightTurns(2_000);
  const result = {
    db, ...ids,
    elapsed: Date.now() - started,
    turnStatus: (db.prepare('SELECT status FROM agent_turns WHERE id=?').get(turn.id) as { status: string }).status,
    runStatus: (db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(turn.run_id) as { status: string }).status,
    admissionHeld: admission.snapshot().global,
    stopStartedEvents: (db.prepare("SELECT count(*) c FROM domain_events WHERE turn_id=? AND kind='run.stopConfirmationStarted'").get(turn.id) as { c: number }).c,
  };
  await adapter.closeAllSessions();
  return result;
}

describe('R99 user stop remains bounded when the automatic deadline is disabled', () => {
  it('formal task.stop with a provider terminal settles CANCELLED and releases the slot', async () => {
    const result = await runStop(1, [{ kind: 'stall', ms: 5_000 }]);
    expect(result.turnStatus).toBe('CANCELLED');
    expect(result.runStatus).toBe('CANCELLED');
    expect(result.admissionHeld).toBe(0);
    expect(result.elapsed).toBeLessThan(2_000);
    expect(result.stopStartedEvents).toBe(1);
    result.db.close();
  }, 20_000);

  it('hanging interrupt and no terminal become UNKNOWN after grace; repeated stop does not restart the window', async () => {
    const result = await runStop(2, [{ kind: 'unresponsiveToInterrupt' }, { kind: 'stall', ms: 10_000 }], { hangInterrupt: true, repeated: true });
    expect(result.turnStatus).toBe('UNKNOWN');
    expect(result.runStatus).toBe('INTERRUPTED');
    expect(result.admissionHeld).toBe(1);
    expect(result.elapsed).toBeLessThan(2_000);
    expect(result.stopStartedEvents).toBe(1);
    const audit = result.db.prepare("SELECT payload_json FROM domain_events WHERE turn_id=? AND kind='turn.statusChanged' ORDER BY seq DESC LIMIT 1").get(result.turnId) as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ status: 'UNKNOWN', reason: 'stop-confirmation-grace-expired' });
    result.db.close();
  }, 20_000);
});
