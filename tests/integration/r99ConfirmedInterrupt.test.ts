import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { DispatchAdmission } from '../../src/daemon/admission.ts';
import type { OpenSessionInput, ProbeResult, RuntimeAdapter, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r99-interrupt-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

class InterruptProbeAdapter implements RuntimeAdapter {
  constructor(private readonly inner: FakeRuntimeAdapter, private readonly confirmed: boolean) {}
  probe(): Promise<ProbeResult> { return this.inner.probe(); }
  openSession(input: OpenSessionInput): Promise<SessionRef> { return this.inner.openSession(input); }
  startTurn(session: SessionRef, input: TurnRequest): Promise<void> { return this.inner.startTurn(session, input); }
  events(session: SessionRef) { return this.inner.events(session); }
  steer(session: SessionRef, input: TurnRequest): Promise<void> { return this.inner.steer(session, input); }
  respondApproval(session: SessionRef, approvalId: string, choice: 'allow_once' | 'deny'): Promise<void> {
    return this.inner.respondApproval(session, approvalId, choice);
  }
  async interrupt(session: SessionRef, turnId: string): Promise<void> {
    if (!this.confirmed) return this.inner.interrupt(session, turnId);
    this.inner.pushLateEvent(session.id, turnId, {
      kind: 'turn.failed', code: 'INTERRUPTED', message: 'provider terminal confirms interrupted', retryable: false,
      terminalEvidence: { source: 'provider-turn-completed', status: 'interrupted', providerTurnId: 'provider-turn-r99' },
    });
  }
  close(session: SessionRef): Promise<void> { return this.inner.close(session); }
  processIdentity(session: SessionRef, turnId: string) { return this.inner.processIdentity?.(session, turnId) ?? null; }
}

function seedTask(db: ZhongshuoDatabase, projectId: string, roomId: string, conversationId: string, memberId: string, n: number): string {
  const path = join(root, projectId);
  mkdirSync(path, { recursive: true });
  db.prepare(`INSERT INTO projects (id,display_name,root_path,canonical_path,directory_identity,created_at)
    VALUES(?,?,?,?, '{}',0)`).run(projectId, projectId, path, path);
  db.prepare(`INSERT INTO project_members (id,project_id,display_name,principal_type,enabled)
    VALUES(?,?,?,'agent',1)`).run(memberId, projectId, memberId);
  db.prepare('INSERT INTO rooms (id,project_id,name,coordinator_member_id) VALUES(?,?,?,?)').run(roomId, projectId, roomId, memberId);
  db.prepare("INSERT INTO conversations (id,project_id,kind,room_id) VALUES(?,?,'room',?)").run(conversationId, projectId, roomId);
  const taskId = `task_${n}`;
  const created = createRoomRootTask(db, {
    ids: { messageId: `msg_${n}`, threadId: `thread_${n}`, taskId, taskEventId: `evt_task_${n}`, threadEventId: `evt_thread_${n}` },
    projectId, conversationId, roomId, intent: 'default', title: `任务 ${n}`, body: `任务 ${n}`,
    mentions: [{ kind: 'member', memberId }], author: { authorType: 'human', authorId: 'u_local' },
    reviewPolicy: 'auto_deliver', sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DIRECT', targetMemberId: memberId, frozenMemberIds: [memberId], initialWakeMemberIds: [memberId] },
    now: n,
  });
  if (!created.ok) throw new Error(created.error.message);
  return taskId;
}

async function runProbe(confirmed: boolean) {
  const db = openDatabase(':memory:');
  const projectId = confirmed ? 'p_confirm' : 'p_ack';
  const taskId = seedTask(db, projectId, 'r1', 'c1', 'm1', confirmed ? 1 : 2);
  const inner = new FakeRuntimeAdapter({ turnScriptSequencer: () => [{ kind: 'stall', ms: 5_000 }] });
  const adapter = new InterruptProbeAdapter(inner, confirmed);
  const admission = new DispatchAdmission({ globalMaxInFlight: 1, perProjectMaxInFlight: 1, perProviderMaxInFlight: 1 });
  const worker = new DispatchWorker({
    db, adapter, leaseOwner: `w-${projectId}`, admission,
    turnDeadlineMs: 40, interruptGraceMs: 25, appDataDir: join(root, `data-${projectId}`),
  });
  await worker.runOnce();
  const turn = db.prepare('SELECT id,status FROM agent_turns WHERE run_id IN (SELECT id FROM workflow_runs WHERE task_id=?)').get(taskId) as { id: string; status: string };
  const result = {
    db, taskId, turn,
    admissionHeld: admission.snapshot().global,
    runStatus: (db.prepare('SELECT status FROM workflow_runs WHERE task_id=?').get(taskId) as { status: string }).status,
  };
  await inner.closeAllSessions();
  return result;
}

function stopAttributionCase(n: number) {
  const db = openDatabase(':memory:');
  const taskId = seedTask(db, `p_stop_attr_${n}`, 'r1', 'c1', 'm1', n);
  db.prepare("UPDATE tasks SET stop_generation=1 WHERE id=?").run(taskId);
  const runId = `run_stop_attr_${n}`;
  const turnId = `turn_stop_attr_${n}`;
  db.prepare(`INSERT INTO workflow_runs (id,task_id,conversation_id,thread_id,mode,task_revision,status)
    VALUES(?,?,'c1',?,'DIRECT',0,'STOPPING')`).run(runId, taskId, `thread_${n}`);
  db.prepare(`INSERT INTO agent_turns
    (id,run_id,conversation_id,thread_id,member_id,stage_key,turn_purpose,status,dispatch_key,attempt,epoch,collab_absence_ms,collab_turn_deadline_ms,collab_config_revision,stop_generation_snapshot)
    VALUES(?,?,'c1',?,'m1','direct.work','stage_work','STOPPING',?,1,1,1200000,0,0,0)`).run(
    turnId, runId, `thread_${n}`, `stop-${n}`,
  );
  const worker = new DispatchWorker({ db, adapter: new FakeRuntimeAdapter(), leaseOwner: `w-stop-attr-${n}`, appDataDir: join(root, `data-stop-${n}`) });
  return { db, worker, taskId, runId, turnId };
}

describe('R99 provider-confirmed interrupt evidence', () => {
  it('an exact mapped provider terminal settles FAILED and releases the turn slot', async () => {
    const result = await runProbe(true);
    expect(result.turn.status).toBe('FAILED');
    expect(result.runStatus).toBe('FAILED');
    expect(result.admissionHeld).toBe(0);
    const audit = result.db.prepare("SELECT payload_json FROM domain_events WHERE turn_id=? AND kind='turn.statusChanged' ORDER BY seq DESC LIMIT 1").get(result.turn.id) as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ status: 'FAILED', terminalEvidence: { source: 'provider-turn-completed' } });
    result.db.close();
  }, 20_000);

  it('an interrupt RPC acknowledgement without a provider terminal stays UNKNOWN and retains the slot', async () => {
    const result = await runProbe(false);
    expect(result.turn.status).toBe('UNKNOWN');
    expect(result.runStatus).toBe('INTERRUPTED');
    expect(result.admissionHeld).toBe(1);
    const audit = result.db.prepare("SELECT payload_json FROM domain_events WHERE turn_id=? AND kind='turn.statusChanged' ORDER BY seq DESC LIMIT 1").get(result.turn.id) as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ status: 'UNKNOWN', reason: 'turn-deadline-interrupt' });
    result.db.close();
  }, 20_000);

  it('INTERRUPTED without this worker having sent a deadline interrupt is not mislabeled as a deadline', async () => {
    const db = openDatabase(':memory:');
    const taskId = seedTask(db, 'p_reason', 'r1', 'c1', 'm1', 9);
    db.prepare(`INSERT INTO workflow_runs (id,task_id,conversation_id,thread_id,mode,task_revision,status)
      VALUES('run_reason',?,'c1','thread_9','DIRECT',0,'RUNNING')`).run(taskId);
    db.prepare(`INSERT INTO agent_turns
      (id,run_id,conversation_id,thread_id,member_id,stage_key,turn_purpose,status,dispatch_key,attempt,epoch,collab_absence_ms,collab_turn_deadline_ms,collab_config_revision,stop_generation_snapshot)
      VALUES('turn_reason','run_reason','c1','thread_9','m1','direct.work','stage_work','RUNNING','reason',1,1,1200000,0,0,0)`).run();
    const adapter = new FakeRuntimeAdapter();
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'w-reason', appDataDir: join(root, 'data-reason') });
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    worker.applyEvent(task as never, 'run_reason', 'turn_reason', {
      kind: 'turn.failed', code: 'INTERRUPTED', message: 'external interrupt acknowledgement only', retryable: false,
      eventKey: 'external-ack', sessionId: 'external-session', turnId: 'turn_reason', receivedAt: Date.now(),
    });
    expect(db.prepare("SELECT status FROM agent_turns WHERE id='turn_reason'").get()).toMatchObject({ status: 'UNKNOWN' });
    const audit = db.prepare("SELECT payload_json FROM domain_events WHERE turn_id='turn_reason' AND kind='turn.statusChanged' ORDER BY seq DESC LIMIT 1").get() as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ status: 'UNKNOWN', reason: 'provider-interrupted-without-terminal-proof' });
    db.close();
  });

  it('user stop accepts an exact attributed provider terminal even without automatic-deadline evidence', () => {
    const f = stopAttributionCase(11);
    const task = f.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.taskId);
    f.worker.applyEvent(task as never, f.runId, f.turnId, {
      kind: 'turn.failed', code: 'INTERRUPTED', message: 'provider confirmed user stop', retryable: false,
      eventKey: 'stop-exact', sessionId: 's1', turnId: f.turnId, receivedAt: Date.now(),
    });
    expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(f.turnId)).toMatchObject({ status: 'CANCELLED' });
    f.db.close();
  });

  it('wrong or missing terminal attribution cannot be confirmed as a user stop', () => {
    for (const [n, eventTurnId] of [[12, 'wrong-turn'], [13, undefined]] as const) {
      const f = stopAttributionCase(n);
      const task = f.db.prepare('SELECT * FROM tasks WHERE id=?').get(f.taskId);
      f.worker.applyEvent(task as never, f.runId, f.turnId, {
        kind: 'turn.failed', code: 'INTERRUPTED', message: 'unattributed transport close', retryable: false,
        eventKey: `bad-stop-${n}`, sessionId: 's1', ...(eventTurnId != null ? { turnId: eventTurnId } : {}), receivedAt: Date.now(),
      });
      expect(f.db.prepare('SELECT status FROM agent_turns WHERE id=?').get(f.turnId)).toMatchObject({ status: 'UNKNOWN' });
      f.db.close();
    }
  });
});
