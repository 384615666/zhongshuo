import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
import { AdapterCallError } from '../../src/contracts/runtime.ts';
import type { NormalizedRuntimeEvent, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';
import { DispatchAdmission } from '../../src/daemon/admission.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { openDatabase } from '../../src/persistence/db.ts';

type Frame = { method: string; params: Record<string, unknown> };
type Script = { providerTurnId?: string; before?: Frame[]; after?: Frame[]; holdResponse?: boolean };
type WireRow = { type: string; pid: number; key?: string; sequence?: number; frame?: Record<string, unknown>; context?: { THREAD: string; TURN: string; FINAL: string } };
const evidenceRoot = resolve('dist/r126-protocol-followup');
const fixtureEntry = resolve('tests/fixtures/chaosProtocolFollowupR125.mjs');
const executionSourceHashes = Object.fromEntries(['tests/integration/chaosProtocolFollowupR125.test.ts', 'tests/fixtures/chaosProtocolFollowupR125.mjs'].map(file => [file, createHash('sha256').update(readFileSync(resolve(file))).digest('hex')]));
const directories: string[] = [];
const audits: Array<{ dir: string; name: string }> = [];
const reached = new Set<string>();
const successfullyCleaned = new Set<string>();
let currentTestName = '';
const defect = process.env['ZS_R125_HEALTHY_ASSERTIONS'] === '1' ? it : it.fails;
mkdirSync(evidenceRoot, { recursive: true });

beforeEach(({ task }) => {
  currentTestName = task.name;
  directories.length = 0;
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  vi.stubEnv('ZS_RUNTIME', 'fake');
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD', '1');
});
// Suite hooks are outside it.fails inversion. A failed setup, early assertion,
// or cleanup must fail the whole suite even if a test was registered as fails.
afterAll(() => {
  for (const { dir, name } of audits) {
    expect(existsSync(join(dir, 'result.json')), `Completed business evidence required: ${name}`).toBe(true);
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as { businessAssertion?: string };
    if (/DEFECT|REPAIRED/.test(name)) {
      expect(reached.has(name), `Business invariant not reached: ${name}`).toBe(true);
      expect(result.businessAssertion).toBeTypeOf('string');
    }
    expect(successfullyCleaned.has(dir), `Cleanup must return normally, including dispose and snapshot writes: ${name}`).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'cleanup.json'), 'utf8'))).toMatchObject({ allOwnedChildrenClosed: true, remainingConsumers: [], databaseClosed: true });
  }
});
afterEach(({ task }) => {
  try {
    if (/DEFECT|REPAIRED/.test(task.name)) {
      expect(directories).toHaveLength(1);
      expect(reached.has(task.name), 'The exact business assertion must be reached; setup errors cannot establish a defect or repair').toBe(true);
    }
    for (const dir of directories) {
      expect(existsSync(join(dir, 'result.json')), 'A harness exception is not a product counterexample').toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'cleanup.json'), 'utf8'))).toMatchObject({ allOwnedChildrenClosed: true, remainingConsumers: [], databaseClosed: true });
    }
  } finally { vi.unstubAllEnvs(); }
});

async function bounded<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Harness timeout: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function outcome(promise: Promise<unknown>) {
  try { await promise; return { status: 'fulfilled' }; }
  catch (error) { return { status: 'rejected', message: error instanceof Error ? error.message : String(error), ...(error instanceof AdapterCallError ? { code: error.code, notStarted: error.notStarted } : {}) }; }
}
const frame = (method: string, params: Record<string, unknown>): Frame => ({ method, params });
const started = (key?: string) => frame('turn/started', { threadId: key ? `$THREAD{${key}}` : '$THREAD', turn: { id: key ? `$TURN{${key}}` : '$TURN', status: 'inProgress' } });
const message = (text: string, id: string, key?: string) => frame('item/completed', { threadId: key ? `$THREAD{${key}}` : '$THREAD', turnId: key ? `$TURN{${key}}` : '$TURN', item: { type: 'agentMessage', id, text } });
const terminal = (key: string, text = `$FINAL{${key}}`) => frame('turn/completed', { threadId: `$THREAD{${key}}`, turn: { id: `$TURN{${key}}`, status: 'completed', items: [{ type: 'agentMessage', text }] } });
const request = (key: string): TurnRequest => ({ turnId: `internal-${key}`, dispatchKey: key, text: key, inputBundleId: 'r125-local', policyId: 'readonly', taskRevision: 0, stage: `r125.${key}` });

async function scenario(label: string, turns: Record<string, Script>) {
  const dir = mkdtempSync(join(evidenceRoot, `${label}-`));
  directories.push(dir);
  audits.push({ dir, name: currentTestName });
  const projectPath = join(dir, 'project'); mkdirSync(projectPath);
  const configPath = join(dir, 'scenario.json'), logPath = join(dir, 'wire.jsonl'), controlPath = join(dir, 'control.jsonl');
  writeFileSync(configPath, JSON.stringify({ turns, controlPath }, null, 2));
  const children: ChildProcessWithoutNullStreams[] = [], closed: Promise<void>[] = [];
  const launches: Array<{ command: string; args: string[]; pid?: number; envKeys: string[] }> = [];
  const adapter = new CodexAppServerAdapter({
    mockEntry: { executable: fixtureEntry, args: [configPath, logPath] }, requestTimeoutMs: 5000,
    spawnFn: (command, args) => {
      if (command !== process.execPath || args[0] !== fixtureEntry || args[1] !== configPath) throw Error('Only the local Node protocol fixture may be launched');
      const env = { SystemRoot: process.env['SystemRoot'], WINDIR: process.env['WINDIR'], TEMP: dir, TMP: dir, ZS_R125_LOCAL_ONLY: '1' };
      const child = spawn(command, args, { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child); closed.push(new Promise<void>(done => child.once('close', () => done())));
      launches.push({ command, args, pid: child.pid, envKeys: Object.keys(env) });
      writeFileSync(join(dir, 'launches.json'), JSON.stringify({ realBusinessModelCalls: 0, launches }, null, 2));
      return child;
    },
  });
  const log = (): WireRow[] => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as WireRow) : [];
  let sequence = 0;
  async function control(frames: Frame[] = [], release: string[] = [], exitCode?: number) {
    const expected = ++sequence;
    appendFileSync(controlPath, JSON.stringify({ frames, release, ...(exitCode == null ? {} : { exitCode }) }) + '\n');
    await expect.poll(() => log().some(row => row.type === 'control.applied' && row.sequence === expected), { timeout: 3000, interval: 10 }).toBe(true);
    if (exitCode == null) await adapter.listModels(); // Pipe barrier: all injected frames have been parsed.
    else await bounded(Promise.all(closed), 'actual child close');
  }
  const db = openDatabase(join(dir, 'state.sqlite'));
  const admission = new DispatchAdmission({ globalMaxInFlight: 4, perProjectMaxInFlight: 2, perProviderMaxInFlight: 2 });
  const worker = new DispatchWorker({ db, adapter, admission, appDataDir: dir, leaseOwner: randomUUID(), detachedTurnConsumption: true, automaticRecovery: false });
  const deps = { db, localUserId: 'u_local', appDataDir: dir, interruptTurn: (id: string) => worker.interruptTurn(id), releaseAdmission: (id: string) => { admission.release(id); } };
  async function cmd<T>(method: string, params: unknown): Promise<T> {
    const commandId = randomUUID();
    const result = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method, params }) as { ok: boolean; data?: T; error?: unknown };
    appendFileSync(join(dir, 'commands.jsonl'), JSON.stringify({ commandId, method, params, result }) + '\n');
    if (!result.ok) throw Error(`Local command failed: ${JSON.stringify(result.error)}`);
    return result.data as T;
  }
  await cmd('app.settings.set', { key: 'callBudget.enabled', value: 'false' });
  const { project } = await cmd<{ project: { id: string } }>('project.open', { path: projectPath });
  const { memberId } = await cmd<{ memberId: string }>('member.create', { projectId: project.id, displayName: 'R125 local protocol member' });
  await cmd('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'plan' });
  const { room } = await cmd<{ room: { id: string; conversationId: string } }>('room.create', { projectId: project.id, name: 'R125 local room', memberIds: [memberId] });
  const { conversationId } = await cmd<{ conversationId: string }>('conversation.create', { projectId: project.id, peerMemberId: memberId });
  const snapshot = () => ({
    tasks: db.prepare('SELECT id,conversation_id,status FROM tasks ORDER BY rowid').all(),
    turns: db.prepare('SELECT id,run_id,session_id,status,exec_started_at,protection_state FROM agent_turns ORDER BY rowid').all(),
    workflows: db.prepare('SELECT id,task_id,status FROM workflow_runs ORDER BY rowid').all(),
    sessions: db.prepare('SELECT id,scope_kind,conversation_id,provider_session_id,session_generation FROM runtime_sessions ORDER BY rowid').all(),
    messages: db.prepare('SELECT id,conversation_id,thread_id,task_id,author_type,body_json FROM messages ORDER BY rowid').all(),
    events: db.prepare('SELECT seq,turn_id,kind,payload_json FROM domain_events ORDER BY seq').all(),
    outbox: db.prepare('SELECT id,turn_id,status,attempt_epoch FROM outbox ORDER BY id').all(),
    dmQueue: db.prepare("SELECT t.id,t.status FROM tasks t WHERE t.kind='dm_turn' AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.task_id=t.id) ORDER BY t.rowid").all(),
    admission: admission.snapshot(), realCalls: (db.prepare('SELECT count(*) n FROM real_calls').get() as { n: number }).n,
  });
  const status = (id: string) => (db.prepare('SELECT status FROM tasks WHERE id=?').get(id) as { status: string }).status;
  const replies = () => db.prepare("SELECT task_id,body_json FROM messages WHERE conversation_id=? AND author_type='agent' ORDER BY rowid").all(conversationId) as Array<{ task_id: string | null; body_json: string }>;
  const sendDm = (key: string) => cmd<{ taskId: string; disposition: string }>('message.submit', { target: { kind: 'dm', projectId: project.id, conversationId }, body: `${key} 本地协议验证`, intent: 'default', mentions: [] });
  const sendRoom = (key: string) => cmd<{ taskId: string; threadId: string }>('message.submit', { target: { kind: 'room_root', projectId: project.id, roomId: room.id, conversationId: room.conversationId }, body: `${key} 本地并行对照`, intent: 'default', mentions: [{ kind: 'member', memberId }] });
  const registered = (key: string) => log().find(row => row.type === 'turn.registered' && row.key === key);
  const capture = (session: SessionRef) => {
    const events: NormalizedRuntimeEvent[] = [];
    const done = (async () => { for await (const event of adapter.events(session)) { events.push(event); if (event.kind === 'process.exited') return; } })();
    return { events, done };
  };
  const open = (id: string, resume?: SessionRef) => adapter.openSession({ projectId: project.id, memberId, taskId: id, threadId: id, sessionGeneration: resume ? 1 : 0, cwd: projectPath, policyId: 'readonly', ...(resume ? { resume } : {}) });
  const save = (facts: Record<string, unknown>) => {
    const databaseBeforeCleanup = snapshot();
    expect(databaseBeforeCleanup.realCalls).toBe(0);
    const result = { label, dir, executionSourceHashes, realBusinessModelCalls: 0, databaseBeforeCleanup, ownedChildrenAtObservation: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })), ...facts };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(evidenceRoot, `${label}-latest.json`), JSON.stringify(result, null, 2));
  };
  return {
    dir, adapter, db, worker, admission, log, control, open, capture, save, snapshot, status, replies, sendDm, sendRoom, registered, conversationId,
    async close() {
      worker.stopAccepting(); worker.abortConsumers();
      const remaining = await bounded(worker.awaitInFlightTurns(2500), 'worker cleanup', 3000);
      try { await adapter.dispose(); }
      finally {
        for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
        await bounded(Promise.all(closed), 'owned children cleanup');
        try { writeFileSync(join(dir, 'after-cleanup.json'), JSON.stringify(snapshot(), null, 2)); }
        finally {
          db.close();
          writeFileSync(join(dir, 'cleanup.json'), JSON.stringify({ allOwnedChildrenClosed: children.every(child => child.exitCode != null || child.signalCode != null), ownedChildren: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })), remainingConsumers: remaining.remaining, databaseClosed: !db.open }, null, 2));
        }
      }
      // This is outside the finally above: a dispose/snapshot/DB/recording error
      // must remain observable by the suite hook even if cleanup.json exists.
      successfullyCleaned.add(dir);
    },
  };
}

describe('R126 protocol follow-up: deferred overlap and repaired completed-ID reuse', () => {
  defect('S1 adapter DEFECT: a bound but unfinished provider thread must reject a second resumed start', async ({ task }) => {
    const f = await scenario('S1-adapter-overlap', { first: { before: [started()] }, second: { before: [started()] }, other: { before: [started()] } });
    try {
      const first = await f.open('first'), firstStream = f.capture(first);
      await f.adapter.startTurn(first, request('first')); // Response received; no terminal is emitted.
      const second = await f.open('second', first), other = await f.open('other');
      const secondStream = f.capture(second), otherStream = f.capture(other);
      const [sameThread, differentThread] = await Promise.all([outcome(f.adapter.startTurn(second, request('second'))), outcome(f.adapter.startTurn(other, request('other')))]);
      await f.adapter.listModels();
      const activeWindow = { registered: f.log().filter(row => row.type === 'turn.registered'), terminalFrames: f.log().filter(row => row.type === 'out' && row.frame?.['method'] === 'turn/completed') };
      expect(second.providerSessionId).toBe(first.providerSessionId);
      expect(other.providerSessionId).not.toBe(first.providerSessionId);
      expect(differentThread.status).toBe('fulfilled');
      expect(activeWindow.terminalFrames).toHaveLength(0);
      expect(f.registered('first')).toBeDefined();
      await f.control([terminal('first'), terminal('second'), terminal('other')]);
      await f.control([], [], 0); await bounded(Promise.all([firstStream.done, secondStream.done, otherStream.done]), 'S1 event drains');
      for (const [index, key] of ['first', 'second', 'other'].entries()) {
        const events = [firstStream, secondStream, otherStream][index]!.events;
        expect(events.filter(e => e.kind === 'turn.completed')).toHaveLength(1);
        expect(events.filter(e => e.turnId != null).every(e => e.turnId === `internal-${key}`)).toBe(true);
      }
      f.save({ classification: 'adapter-counterexample-only', sameThread, differentThread, activeWindow, streams: [firstStream.events, secondStream.events, otherStream.events], businessAssertion: 'reject-overlapping-same-provider-thread' });
      reached.add(task.name);
      expect(sameThread.status, 'A response-bound first turn remains active until its terminal; a second start on its provider thread must be rejected').toBe('rejected');
    } finally { await f.close(); }
  }, 15000);

  it('S1 worker GUARDED: same DM queues while another thread progresses, then resumes after terminal', async () => {
    const f = await scenario('S1-worker-serial', { TOKEN_Q_FIRST: { before: [started()] }, TOKEN_Q_SECOND_LONG: { before: [started()] }, TOKEN_Q_OTHER_CONTROL: { before: [started()] } });
    try {
      const first = await f.sendDm('TOKEN_Q_FIRST'); await f.worker.runOnce();
      const second = await f.sendDm('TOKEN_Q_SECOND_LONG');
      const other = await f.sendRoom('TOKEN_Q_OTHER_CONTROL');
      for (let i = 0; i < 4; i++) await f.worker.runOnce();
      await f.adapter.listModels();
      expect(second.disposition).toBe('queued');
      expect(f.registered('TOKEN_Q_SECOND_LONG')).toBeUndefined();
      expect(f.registered('TOKEN_Q_OTHER_CONTROL')).toBeDefined();
      expect(f.registered('TOKEN_Q_FIRST')!.context!.THREAD).not.toBe(f.registered('TOKEN_Q_OTHER_CONTROL')!.context!.THREAD);
      const whileFirstActive = f.snapshot();
      expect(whileFirstActive.admission.global).toBe(2);
      expect(whileFirstActive.turns).toHaveLength(2);
      await f.control([terminal('TOKEN_Q_OTHER_CONTROL')]);
      await expect.poll(() => f.status(other.taskId)).toBe('DONE');
      expect(f.status(first.taskId)).toBe('ACTIVE');
      expect(f.registered('TOKEN_Q_SECOND_LONG')).toBeUndefined();
      await f.control([terminal('TOKEN_Q_FIRST')]);
      expect((await f.worker.awaitInFlightTurns(3000)).remaining).toEqual([]);
      await f.worker.runOnce();
      expect(f.registered('TOKEN_Q_SECOND_LONG')).toBeDefined();
      expect(f.registered('TOKEN_Q_SECOND_LONG')!.context!.THREAD).toBe(f.registered('TOKEN_Q_FIRST')!.context!.THREAD);
      expect(f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'thread/resume')).toHaveLength(1);
      await f.control([terminal('TOKEN_Q_SECOND_LONG')]);
      expect((await f.worker.awaitInFlightTurns(3000)).remaining).toEqual([]);
      expect(f.replies()).toHaveLength(2);
      expect(f.replies()[0]!.body_json).toContain('SAFE_TOKEN_Q_FIRST');
      expect(f.replies()[1]!.body_json).toContain('SAFE_TOKEN_Q_SECOND_LONG');
      expect(f.snapshot().admission.global).toBe(0);
      f.save({ classification: 'guarded-at-worker', first, second, other, whileFirstActive });
    } finally { await f.close(); }
  }, 15000);

  it('S2 same-session adapter REPAIRED: reject completed provider ID reuse without overwriting ownership or relabeling late output', async ({ task }) => {
    const f = await scenario('S2-adapter-reused-id', {
      old: { providerTurnId: 'reused-provider-id', before: [started()] },
      fresh: { providerTurnId: 'reused-provider-id', holdResponse: true, before: [started()] },
      recovery: { providerTurnId: 'distinct-recovery-id', before: [started(), message('SAFE_RECOVERY_BEFORE_RESPONSE', 'recovery-before')] },
    });
    try {
      const session = await f.open('same-session'), stream = f.capture(session);
      await f.adapter.startTurn(session, request('old'));
      await f.control([terminal('old', 'SAFE_OLD_COMPLETE')]);
      const originalCompletion = stream.events.find(e => e.kind === 'turn.completed' && e.turnId === 'internal-old');
      expect(originalCompletion).toMatchObject({ kind: 'turn.completed', finalText: 'SAFE_OLD_COMPLETE' });
      const freshStart = outcome(f.adapter.startTurn(session, request('fresh')));
      await expect.poll(() => f.log().some(row => row.type === 'response.held' && row.key === 'fresh')).toBe(true);
      await f.control([message('POISON_OLD_BEFORE_RESPONSE', 'old-before', 'old'), message('SAFE_NEW_BEFORE_RESPONSE', 'new-before', 'fresh'), terminal('old', 'OLD_TERMINAL_BEFORE_RESPONSE')]);
      const beforeResponse = stream.events.slice();
      await f.control([], ['fresh']);
      const freshResult = await bounded(freshStart, 'same-session reused-ID response');
      const afterResponseOffset = stream.events.length;
      await f.control([message('POISON_OLD_AFTER_RESPONSE', 'old-after', 'old'), message('SAFE_NEW_AFTER_RESPONSE', 'new-after', 'fresh'), terminal('old', 'POISON_OLD_TERMINAL_AFTER_RESPONSE'), terminal('fresh', 'SAFE_FRESH_TERMINAL')]);
      const interruptsBefore = f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'turn/interrupt').length;
      await f.adapter.interrupt(session, 'internal-old'); await f.adapter.listModels();
      const interruptsAfterOld = f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'turn/interrupt').length;
      await f.adapter.interrupt(session, 'internal-fresh'); await f.adapter.listModels();
      const interruptsAfterFresh = f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'turn/interrupt').length;
      // A later distinct ID must still start normally. Buffered output from the
      // rejected attempt must not be replayed into this subsequent turn either.
      await f.adapter.startTurn(session, request('recovery'));
      await f.control([message('POISON_OLD_DURING_RECOVERY', 'old-during-recovery', 'old'), terminal('recovery', 'SAFE_RECOVERY_COMPLETE')]);
      await f.control([], [], 0); await bounded(stream.done, 'S2 same-session event drain');
      const afterResponse = stream.events.slice(afterResponseOffset);
      f.save({ classification: 'repaired', freshResult, originalCompletion, beforeResponse, afterResponse, events: stream.events, interruptsBefore, interruptsAfterOld, interruptsAfterFresh, businessAssertion: 'reject-reused-completed-id-without-relabeling-or-buffer-replay' });
      reached.add(task.name);
      expect(freshResult, 'A real turn/start response reusing a completed ID must explicitly reject with uncertain execution semantics').toMatchObject({ status: 'rejected', code: 'CAPABILITY_UNSUPPORTED', notStarted: false });
      expect(f.log().some(row => row.type === 'response.released' && row.key === 'fresh')).toBe(true);
      expect(stream.events.filter(e => e.turnId === 'internal-fresh'), 'Rejected attempt must publish no buffered or subsequent turn events').toEqual([]);
      expect(interruptsAfterOld, 'Original ownership must remain mapped after rejected reuse').toBe(interruptsBefore + 1);
      expect(interruptsAfterFresh, 'Rejected attempt must acquire no provider mapping').toBe(interruptsAfterOld);
      expect(afterResponse.filter(e => e.turnId === 'internal-fresh' && JSON.stringify(e).includes('POISON_OLD')), 'Response ID reuse must not assign old messages or old terminals to the new internal turn').toEqual([]);
      expect(stream.events.filter(e => e.turnId === 'internal-recovery' && /POISON_OLD|SAFE_NEW|OLD_TERMINAL|SAFE_FRESH_TERMINAL/.test(JSON.stringify(e))), 'Rejected response buffers and late old messages must not leak into the next distinct turn').toEqual([]);
      expect(stream.events.filter(e => e.turnId === 'internal-recovery' && e.kind === 'turn.completed')).toEqual([expect.objectContaining({ finalText: 'SAFE_RECOVERY_COMPLETE' })]);
      expect(stream.events.filter(e => e.turnId === 'internal-recovery' && e.kind === 'message.completed')).toEqual([expect.objectContaining({ text: 'SAFE_RECOVERY_BEFORE_RESPONSE' })]);
      expect(originalCompletion).toMatchObject({ kind: 'turn.completed', turnId: 'internal-old', finalText: 'SAFE_OLD_COMPLETE' });
    } finally { await f.close(); }
  }, 15000);

  for (const reused of [false, true]) {
    it(`S2 worker ${reused ? 'REPAIRED' : 'CONTROL'}: ${reused ? 'reused' : 'distinct'} provider ID across completed DM and resumed session`, async ({ task }) => {
      const f = await scenario(reused ? 'S2-worker-reused-id' : 'S2-worker-distinct-id', {
        TOKEN_ID_OLD: { providerTurnId: 'provider-first', before: [started()] },
        TOKEN_ID_NEW_SECOND: { providerTurnId: reused ? 'provider-first' : 'provider-second', before: [started()], holdResponse: true },
      });
      try {
        const first = await f.sendDm('TOKEN_ID_OLD'); await f.worker.runOnce();
        const oldSessionId = (f.db.prepare('SELECT session_id FROM agent_turns').get() as { session_id: string }).session_id;
        const oldStream = f.capture({ id: oldSessionId } as SessionRef);
        await f.control([terminal('TOKEN_ID_OLD')]);
        expect((await f.worker.awaitInFlightTurns(3000)).remaining).toEqual([]);
        expect(f.status(first.taskId)).toBe('DONE');
        const originalReply = f.replies()[0]!;
        // Observe the actual transport returned by the real adapter. Rejection
        // precedes the worker's successful-start session_id persistence.
        const sessionOpens = vi.spyOn(f.adapter, 'openSession');
        const second = await f.sendDm('TOKEN_ID_NEW_SECOND');
        const startup = outcome(f.worker.runOnce());
        await expect.poll(() => f.log().some(row => row.type === 'response.held' && row.key === 'TOKEN_ID_NEW_SECOND')).toBe(true);
        const beforeResponse = f.snapshot();
        await f.control([message('POISON_OLD_BEFORE_RESPONSE', 'old-before', 'TOKEN_ID_OLD'), message('SAFE_NEW_BEFORE_RESPONSE', 'new-before', 'TOKEN_ID_NEW_SECOND'), terminal('TOKEN_ID_OLD', 'OLD_TERMINAL_BEFORE_RESPONSE')]);
        await f.control([], ['TOKEN_ID_NEW_SECOND']);
        const startupResult = await bounded(startup, 'formal second startup');
        const newSession = await sessionOpens.mock.results.at(-1)!.value as SessionRef;
        sessionOpens.mockRestore();
        const newSessionId = newSession.id;
        expect(newSessionId).not.toBe(oldSessionId);
        const newStream = f.capture({ id: newSessionId } as SessionRef);
        const afterStartup = f.snapshot();
        const afterStartupRemaining = await f.worker.awaitInFlightTurns(reused ? 250 : 0);
        const afterStartupSettlement = reused ? await f.worker.awaitSettlement(250) : undefined;
        const secondTurn = f.db.prepare('SELECT t.id,t.run_id,t.session_id,t.status,t.exec_started_at FROM agent_turns t JOIN workflow_runs r ON r.id=t.run_id WHERE r.task_id=? ORDER BY t.rowid DESC LIMIT 1').get(second.taskId) as { id: string; run_id: string; session_id: string | null; status: string; exec_started_at: number | null };
        const failureEvent = f.db.prepare("SELECT payload_json FROM domain_events WHERE turn_id=? AND kind='turn.startupFailed' ORDER BY seq DESC LIMIT 1").get(secondTurn.id) as { payload_json: string } | undefined;
        const startupFailure = failureEvent ? JSON.parse(failureEvent.payload_json) as { phase?: string; classification?: string; message?: string } : null;
        const unknownProtection = reused ? {
          admissionHeld: f.admission.has(secondTurn.id),
          workflow: f.db.prepare('SELECT id,status FROM workflow_runs WHERE id=?').get(secondTurn.run_id),
          outbox: f.db.prepare('SELECT turn_id,status,attempt_epoch FROM outbox WHERE turn_id=?').all(secondTurn.id),
        } : undefined;
        expect(f.registered('TOKEN_ID_NEW_SECOND')!.context!.THREAD).toBe(f.registered('TOKEN_ID_OLD')!.context!.THREAD);
        expect(f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'thread/resume')).toHaveLength(1);
        await f.control([message('POISON_OLD_AFTER_RESPONSE', 'old-after', 'TOKEN_ID_OLD'), message('SAFE_NEW_AFTER_RESPONSE', 'new-after', 'TOKEN_ID_NEW_SECOND'), terminal('TOKEN_ID_OLD', 'OLD_TERMINAL_AFTER_RESPONSE'), terminal('TOKEN_ID_NEW_SECOND')]);
        const remaining = await f.worker.awaitInFlightTurns(reused ? 250 : 3000);
        const afterLateFrames = f.snapshot();
        const replies = f.replies();
        expect(replies.filter(row => row.task_id === first.taskId)).toEqual([originalReply]);
        expect(JSON.stringify(replies)).not.toContain('POISON_OLD');
        let afterLeaseReclaim: ReturnType<typeof f.snapshot> | undefined;
        if (reused) {
          const startsBefore = f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'turn/start').length;
          const turnsBefore = afterLateFrames.turns.length;
          // Expire only this isolated DB's lease; the production existing-turn
          // reconciliation path must not create another provider execution.
          f.db.prepare('UPDATE outbox SET lease_until=0 WHERE turn_id=?').run(secondTurn.id);
          await f.worker.runOnce(); await f.worker.runOnce();
          expect((await f.worker.awaitSettlement(250)).remaining).toEqual([]);
          afterLeaseReclaim = f.snapshot();
          expect(f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'turn/start')).toHaveLength(startsBefore);
          expect(afterLeaseReclaim.turns).toHaveLength(turnsBefore);
          expect(afterLeaseReclaim.turns.find(row => (row as { id: string }).id === secondTurn.id)).toMatchObject({ status: 'UNKNOWN' });
          expect(f.admission.has(secondTurn.id)).toBe(true);
        }
        // Observe rejection/settlement while the shared server is still alive;
        // the later harness exit must not supply the consumer cleanup evidence.
        f.save({ classification: reused ? 'repaired' : 'guarded-control', reused, first, second, startupResult, startupFailure, secondTurn, unknownProtection, oldTransportSessionId: oldSessionId, newTransportSessionId: newSessionId, beforeResponse, afterStartup, afterStartupRemaining, afterStartupSettlement, afterLateFrames, afterLeaseReclaim, remaining, replies, oldEvents: oldStream.events, newEvents: newStream.events, observationWindowMs: reused ? 250 : 3000, turnDeadline: 'production default disabled', businessAssertion: 'resume-without-hanging-or-mixing-completed-identity' });
        const observedNewEvents = newStream.events.slice();
        await f.control([], [], 0); await bounded(Promise.all([oldStream.done, newStream.done]), 'formal streams drain');
        writeFileSync(join(f.dir, 'streams-after-harness-exit.json'), JSON.stringify({ oldEvents: oldStream.events, newEvents: newStream.events }, null, 2));
        if (reused) reached.add(task.name);
        expect(remaining.remaining, 'Reused terminal provider identity must be rejected or safely handled; parsed terminal frames must not leave the formal consumer running').toEqual([]);
        expect(f.log().some(row => row.type === 'response.released' && row.key === 'TOKEN_ID_NEW_SECOND')).toBe(true);
        if (reused) {
          expect(startupResult, 'Formal DM must expose the actual response validation rejection, rather than an unrelated setup error').toMatchObject({ status: 'rejected', code: 'CAPABILITY_UNSUPPORTED', notStarted: false });
          expect(afterStartupRemaining.remaining, 'Rejected startup must never leave a formal consumer attached').toEqual([]);
          expect(afterStartupSettlement?.remaining, 'Unknown protection must have neither a starting dispatch nor an active consumer').toEqual([]);
          expect(secondTurn).toMatchObject({ status: 'UNKNOWN', exec_started_at: null });
          expect(afterLateFrames.turns.find(row => (row as { id: string }).id === secondTurn.id)).toMatchObject({ status: 'UNKNOWN', exec_started_at: null });
          expect(startupFailure).toMatchObject({ phase: 'startTurn', classification: 'uncertain', message: expect.any(String) });
          expect(startupFailure?.message?.trim(), 'Persist a readable startup rejection reason').toBeTruthy();
          expect(unknownProtection).toMatchObject({ admissionHeld: true, workflow: { status: 'INTERRUPTED' }, outbox: [expect.objectContaining({ turn_id: secondTurn.id, status: 'leased' })] });
          expect(afterStartup.admission.global, 'Only the rejected UNKNOWN turn retains an admission protection slot').toBe(1);
          expect(afterLateFrames.admission.global).toBe(1);
          expect(replies.filter(row => row.task_id === second.taskId), 'Rejected DM must publish no buffered or late response as its own reply').toEqual([]);
          expect(observedNewEvents.filter(e => e.turnId != null), 'Rejected transport session must not publish attempt buffers or old output').toEqual([]);
        } else {
          expect(startupResult).toEqual({ status: 'fulfilled' });
          expect(f.status(second.taskId)).toBe('DONE');
          const secondReplies = replies.filter(row => row.task_id === second.taskId);
          expect(secondReplies).toHaveLength(2); // Two deliberately distinct item IDs; final text appends to the last message.
          expect(secondReplies[0]!.body_json).toContain('SAFE_NEW_BEFORE_RESPONSE');
          expect(secondReplies[1]!.body_json).toContain('SAFE_NEW_AFTER_RESPONSE');
          expect(secondReplies[1]!.body_json).toContain('SAFE_TOKEN_ID_NEW_SECOND');
        }
      } finally { await f.close(); }
    }, 15000);
  }
});
