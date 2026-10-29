import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
import { AdapterCallError } from '../../src/contracts/runtime.ts';
import type { NormalizedRuntimeEvent, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';
import { DispatchAdmission } from '../../src/daemon/admission.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { openDatabase } from '../../src/persistence/db.ts';

type Frame = { method: string; params: Record<string, unknown>; id?: number };
interface TurnScript {
  providerTurnId?: string;
  responseTurnId?: string;
  before?: Frame[];
  after?: Frame[];
  responseError?: { code: number; message: string };
  noResponse?: boolean;
  holdResponse?: boolean;
  exitAfterStart?: number;
}
type WireRow = { pid: number; role: string; type: string; at: number; frame?: Record<string, unknown>; key?: string; sequence?: number };
const evidenceRoot = resolve('dist/r126-protocol/r124');
const fixtureEntry = resolve('tests/fixtures/codexRepairR126Protocol.mjs');
const evidenceForCurrentTest: string[] = [];
mkdirSync(evidenceRoot, { recursive: true });

beforeEach(() => {
  evidenceForCurrentTest.length = 0;
  vi.stubEnv('ZS_ALLOW_FAKE', '1');
  vi.stubEnv('ZS_RUNTIME', 'fake');
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD', '1');
});
afterEach(() => {
  try {
    // Require completed evidence and confirmed cleanup for every healthy scenario.
    for (const dir of evidenceForCurrentTest) {
      expect(existsSync(join(dir, 'result.json')), `Missing completed scenario evidence: ${dir}`).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'cleanup.json'), 'utf8'))).toMatchObject({ allOwnedChildrenClosed: true });
    }
  } finally { vi.unstubAllEnvs(); }
});
async function bounded<T>(promise: Promise<T>, label: string, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Harness timeout: ${label}`)), ms); })]);
  } finally { clearTimeout(timer); }
}
async function outcome(promise: Promise<unknown>) {
  try { await promise; return { status: 'fulfilled' as const }; }
  catch (error) { return { status: 'rejected' as const, adapterCallError: error instanceof AdapterCallError, code: (error as { code?: string }).code, notStarted: (error as { notStarted?: boolean }).notStarted, message: error instanceof Error ? error.message : String(error) }; }
}
function frame(method: string, params: Record<string, unknown>): Frame { return { method, params }; }
const identity = { threadId: '$THREAD', turnId: '$TURN' };
const started = (turn = '$TURN') => frame('turn/started', { threadId: '$THREAD', turn: { id: turn, status: 'inProgress' } });
const message = (text: string, id = 'same-message', turn = '$TURN') => frame('item/completed', { threadId: '$THREAD', turnId: turn, item: { type: 'agentMessage', id, text } });
const terminal = (text = '$FINAL', turn = '$TURN', status = 'completed') => frame('turn/completed', { threadId: '$THREAD', turn: { id: turn, status, items: [{ type: 'agentMessage', text }] } });
const tool = (method: 'item/started' | 'item/completed', command?: string) => frame(method, {
  ...identity, item: { type: 'commandExecution', id: 'same-tool', status: method === 'item/started' ? 'inProgress' : 'completed', ...(command ? { command } : {}) },
});
const approval = (id: number, key: string, extra: Record<string, unknown> = {}): Frame => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: `$THREAD{${key}}`, turnId: `$TURN{${key}}`, command: `echo SYNTHETIC_${key}`, ...extra } });

function protocol(label: string, turns: Record<string, TurnScript>, requestTimeoutMs = 1200) {
  const dir = mkdtempSync(join(evidenceRoot, `${label}-`));
  evidenceForCurrentTest.push(dir);
  const configPath = join(dir, 'scenario.json'), logPath = join(dir, 'wire.jsonl');
  const controlPath = join(dir, 'control.jsonl');
  writeFileSync(configPath, JSON.stringify({ turns, controlPath }, null, 2));
  const children: ChildProcessWithoutNullStreams[] = [];
  const closed: Promise<void>[] = [];
  const launches: Array<{ command: string; args: string[]; pid?: number; envKeys: string[] }> = [];
  const adapter = new CodexAppServerAdapter({
    mockEntry: { executable: fixtureEntry, args: [configPath, logPath] }, requestTimeoutMs,
    spawnFn: (command, args) => {
      if (command !== process.execPath || args[0] !== fixtureEntry || args[1] !== configPath) throw Error('Unexpected executable: local-only fixture guard');
      const env = { SystemRoot: process.env['SystemRoot'], WINDIR: process.env['WINDIR'], TEMP: dir, TMP: dir, ZS_R124_LOCAL_ONLY: '1' };
      const child = spawn(command, args, { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child);
      closed.push(new Promise<void>(done => child.once('close', () => done())));
      launches.push({ command, args, pid: child.pid, envKeys: Object.keys(env) });
      writeFileSync(join(dir, 'launches.json'), JSON.stringify({ realModelCalls: 0, remoteCalls: 0, launches }, null, 2));
      return child;
    },
  });
  const log = (): WireRow[] => existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as WireRow) : [];
  let sequence = 0;
  const control = async (frames: Frame[] = [], exitCode?: number, releaseStart?: string) => {
    appendFileSync(controlPath, JSON.stringify({ frames, ...(exitCode == null ? {} : { exitCode }), ...(releaseStart == null ? {} : { releaseStart }) }) + '\n');
    const expected = ++sequence;
    await expect.poll(() => log().some(row => row.type === 'control.applied' && row.sequence === expected), { timeout: 2500, interval: 10 }).toBe(true);
    if (exitCode == null) await adapter.listModels(); // Actual pipe-response barrier after all injected frames.
  };
  const save = (facts: Record<string, unknown>) => {
    const result = { label, dir, executable: fixtureEntry, realModelCalls: 0, remoteCalls: 0, ...facts };
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(evidenceRoot, `${label}-latest.json`), JSON.stringify(result, null, 2));
  };
  return {
    dir, adapter, children, closed, log, control, save,
    async exit(code = 0) { await control([], code); await bounded(closed.at(-1)!, 'server close'); },
    async close() {
      await adapter.dispose();
      for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
      await bounded(Promise.all(closed), 'owned children cleanup');
      writeFileSync(join(dir, 'cleanup.json'), JSON.stringify({ ownedChildren: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })), allOwnedChildrenClosed: true }, null, 2));
    },
  };
}
type Protocol = ReturnType<typeof protocol>;
async function open(f: Protocol, id: string, resume?: SessionRef) {
  return f.adapter.openSession({ projectId: 'r124-protocol-only', memberId: 'same-member', taskId: id, threadId: id, sessionGeneration: resume == null ? 0 : 1, cwd: f.dir, policyId: 'readonly', ...(resume ? { resume } : {}) });
}
function request(key: string): TurnRequest {
  return { turnId: `internal-${key}`, dispatchKey: key, inputBundleId: 'r124-local', text: key, policyId: 'readonly', taskRevision: 0, stage: `r124.${key}` };
}
function capture(f: Protocol, session: SessionRef) {
  const events: NormalizedRuntimeEvent[] = [];
  const done = (async () => { for await (const event of f.adapter.events(session)) { events.push(event); if (event.kind === 'process.exited') return; } })();
  return { events, done };
}
function approvalToken(events: NormalizedRuntimeEvent[], rpcId: number): string {
  const approvals = events.filter(e => e.kind === 'approval.requested' && e.approvalId.startsWith(`appr_${rpcId}_`));
  expect(approvals).toHaveLength(1);
  const event = approvals[0]!;
  if (event.kind !== 'approval.requested') throw Error('Missing observed approval token');
  return event.approvalId;
}
async function workerFixture(f: Protocol) {
  const db = openDatabase(join(f.dir, 'state.sqlite'));
  const admission = new DispatchAdmission({ globalMaxInFlight: 4, perProjectMaxInFlight: 2, perProviderMaxInFlight: 2 });
  const worker = new DispatchWorker({ db, adapter: f.adapter, admission, appDataDir: f.dir, leaseOwner: randomUUID(), detachedTurnConsumption: true, automaticRecovery: false, interruptGraceMs: 60 });
  const deps = { db, localUserId: 'u_local', appDataDir: f.dir, interruptTurn: (turnId: string) => worker.interruptTurn(turnId), releaseAdmission: (turnId: string) => { admission.release(turnId); } };
  async function cmd<T>(method: string, params: unknown): Promise<T> {
    const commandId = randomUUID();
    const result = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method, params }) as { ok: boolean; data?: T; error?: unknown };
    appendFileSync(join(f.dir, 'commands.jsonl'), JSON.stringify({ method, params, commandId, result }) + '\n');
    if (!result.ok) throw Error(`Local command failed: ${JSON.stringify(result.error)}`);
    return result.data as T;
  }
  await cmd('app.settings.set', { key: 'callBudget.enabled', value: 'false' });
  const projectPath = join(f.dir, 'project'); mkdirSync(projectPath);
  const { project } = await cmd<{ project: { id: string } }>('project.open', { path: projectPath });
  const { memberId } = await cmd<{ memberId: string }>('member.create', { projectId: project.id, displayName: 'R124 synthetic protocol' });
  await cmd('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'plan' });
  const { room } = await cmd<{ room: { id: string; conversationId: string } }>('room.create', { projectId: project.id, name: 'R124 local room', memberIds: [memberId] });
  const send = (key: string) => cmd<{ taskId: string; threadId: string }>('message.submit', { target: { kind: 'room_root', projectId: project.id, roomId: room.id, conversationId: room.conversationId }, body: `${key} 本地协议故障合成请求`, intent: 'default', mentions: [{ kind: 'member', memberId }] });
  const snapshot = () => ({
    tasks: db.prepare('SELECT id,status FROM tasks ORDER BY rowid').all(),
    turns: db.prepare('SELECT id,session_id,status,exec_started_at,protection_state FROM agent_turns ORDER BY rowid').all(),
    messages: db.prepare('SELECT id,thread_id,task_id,author_type,body_json FROM messages ORDER BY rowid').all(),
    events: db.prepare('SELECT seq,turn_id,kind,payload_json FROM domain_events ORDER BY seq').all(),
    outbox: db.prepare('SELECT id,status,attempt_epoch FROM outbox ORDER BY id').all(),
    admission: admission.snapshot(), realCalls: (db.prepare('SELECT count(*) n FROM real_calls').get() as { n: number }).n,
  });
  const status = (taskId: string) => (db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }).status;
  const replies = (threadId: string) => db.prepare("SELECT id,body_json FROM messages WHERE thread_id=? AND author_type='agent' ORDER BY rowid").all(threadId) as Array<{ id: string; body_json: string }>;
  return {
    db, worker, admission, send, snapshot, status, replies,
    async close() {
      // Preserve result.json before this explicit harness-only forced shutdown.
      worker.stopAccepting(); worker.abortConsumers();
      await bounded(worker.awaitInFlightTurns(2000), 'worker cleanup', 2500);
      await f.close();
      writeFileSync(join(f.dir, 'after-cleanup.json'), JSON.stringify(snapshot(), null, 2));
      db.close();
    },
  };
}

describe('R124 protocol combinations through the actual local Codex adapter', () => {
  it('P01 GUARDED: reused turn/tool IDs across threads plus completion-before-start and crossed identity stay scoped', async () => {
    const f = protocol('P01-tuple-tools', {
      a: { providerTurnId: 'shared-provider-turn', before: [started(), tool('item/started', 'echo TOOL_A')] },
      b: { providerTurnId: 'shared-provider-turn', before: [started(), tool('item/completed'), tool('item/started', 'echo TOOL_B')] },
      c: { before: [started()] },
    });
    try {
      const a = await open(f, 'a'), b = await open(f, 'b'), c = await open(f, 'c');
      const streams = [a, b, c].map(session => capture(f, session));
      await Promise.all([f.adapter.startTurn(a, request('a')), f.adapter.startTurn(b, request('b')), f.adapter.startTurn(c, request('c'))]);
      await f.control([
        frame('item/completed', { threadId: '$THREAD{a}', turnId: '$TURN{c}', item: { type: 'agentMessage', id: 'same-message', text: 'POISON_CROSSED_TUPLE' } }),
        frame('item/completed', { threadId: '$THREAD{b}', turnId: '$TURN{b}', turn: { id: '$TURN{c}' }, item: { type: 'agentMessage', text: 'POISON_CONFLICTING_TUPLE' } }),
        frame('item/completed', { threadId: '$THREAD{b}', turnId: '$TURN{b}', item: { type: 'commandExecution', id: 'same-tool', status: 'completed' } }),
        frame('item/completed', { threadId: '$THREAD{a}', turnId: '$TURN{a}', item: { type: 'commandExecution', id: 'same-tool', status: 'completed' } }),
        ...['a', 'b', 'c'].map(key => frame('turn/completed', { threadId: `$THREAD{${key}}`, turn: { id: `$TURN{${key}}`, status: 'completed', items: [{ type: 'agentMessage', text: `SAFE_${key}` }] } })),
      ]);
      await f.exit(); await bounded(Promise.all(streams.map(s => s.done)), 'P01 event drain');
      f.save({ classification: 'guarded', streams: streams.map(s => s.events) });
      expect(JSON.stringify(streams)).not.toContain('POISON_');
      for (const [i, key] of ['a', 'b', 'c'].entries()) {
        expect(streams[i]!.events.filter(e => e.turnId != null).every(e => e.turnId === `internal-${key}` && e.stage === `r124.${key}`)).toBe(true);
        expect(streams[i]!.events.filter(e => e.kind === 'turn.completed')).toHaveLength(1);
      }
      expect(streams[0]!.events.find(e => e.kind === 'tool.completed')).toMatchObject({ target: 'echo TOOL_A' });
      const bTools = streams[1]!.events.filter(e => e.kind === 'tool.completed');
      expect(bTools).toHaveLength(2);
      expect(JSON.stringify(bTools[0])).not.toContain('TOOL_A');
      expect(bTools[1]).toMatchObject({ target: 'echo TOOL_B' });
    } finally { await f.close(); }
  }, 10000);

  it('P02 repaired: conflicting early-start and response IDs reject without publishing worker output or hanging consumers', async () => {
    const f = protocol('P02-start-alias-worker', {
      TOKEN_P02: { providerTurnId: 'early-claim', responseTurnId: 'different-response', before: [started(), message('POISON_EARLY_ALIAS'), terminal()], after: [message('POISON_EARLY_ALIAS'), terminal('$FINAL', '$RESPONSE')] },
      TOKEN_P02_PEER: { before: [started()], after: [terminal()] },
    });
    const w = await workerFixture(f);
    const start = vi.spyOn(f.adapter, 'startTurn');
    try {
      const root = await w.send('TOKEN_P02'), peer = await w.send('TOKEN_P02_PEER');
      const firstRun = await outcome(w.worker.runOnce());
      await w.worker.runOnce();
      await expect.poll(() => w.status(peer.taskId), { timeout: 3000 }).toBe('DONE');
      const rejection = await outcome(start.mock.results[0]!.value as Promise<void>);
      const remaining = await w.worker.awaitInFlightTurns(1000);
      const visiblePoison = w.replies(root.threadId).some(row => row.body_json.includes('POISON_EARLY_ALIAS'));
      const snapshot = w.snapshot();
      f.save({ classification: 'repaired', rejection, firstRun, remaining, visiblePoison, root, peer, databaseBeforeCleanup: snapshot });
      expect(rejection).toMatchObject({ status: 'rejected', adapterCallError: true, code: 'CAPABILITY_UNSUPPORTED', notStarted: false });
      expect(remaining.remaining).toEqual([]);
      expect(w.snapshot().realCalls).toBe(0);
      expect(w.status(root.taskId)).not.toBe('DONE');
      expect(w.replies(root.threadId)).toHaveLength(0);
      expect(w.replies(peer.threadId).some(row => row.body_json.includes('SAFE_TOKEN_P02_PEER'))).toBe(true);
      expect(w.replies(peer.threadId).every(row => !row.body_json.includes('POISON_'))).toBe(true);
      expect(visiblePoison, 'Conflicting provider IDs must fail closed before publishing either alias').toBe(false);
    } finally { start.mockRestore(); await w.close(); }
  }, 12000);

  it('P03 repaired: shared process exit settles unfinished work as UNKNOWN and retains its protection', async () => {
    const f = protocol('P03-half-complete-crash', { TOKEN_P03_DONE: { before: [started()] }, TOKEN_P03_LIVE: { before: [started()] } });
    const w = await workerFixture(f);
    try {
      const done = await w.send('TOKEN_P03_DONE'), live = await w.send('TOKEN_P03_LIVE');
      await w.worker.runOnce(); await w.worker.runOnce();
      const streams = (w.db.prepare('SELECT session_id FROM agent_turns ORDER BY rowid').all() as Array<{session_id:string}>).map(row => capture(f, { id: row.session_id } as SessionRef));
      await f.control([frame('turn/completed', { threadId: '$THREAD{TOKEN_P03_DONE}', turn: { id: '$TURN{TOKEN_P03_DONE}', status: 'completed', items: [{ type: 'agentMessage', text: '$FINAL{TOKEN_P03_DONE}' }] } })]);
      await expect.poll(() => w.status(done.taskId)).toBe('DONE');
      await f.exit(23);
      await bounded(Promise.all(streams.map(stream => stream.done)), 'P03 exit broadcast');
      const remaining = await w.worker.awaitInFlightTurns(650);
      const snapshot = w.snapshot();
      const states = w.db.prepare('SELECT a.id,a.status AS turnStatus,r.status AS workflowStatus FROM agent_turns a JOIN workflow_runs r ON r.id=a.run_id WHERE r.task_id=?').all(live.taskId) as Array<{ id: string; turnStatus: string; workflowStatus: string }>;
      f.save({ classification: 'repaired', done, live, remaining, states, rawAdapterEvents: streams.map(stream => stream.events), databaseBeforeCleanup: snapshot, exitCode: 23, observationWindowMs: 650, deadline: 'production default disabled' });
      expect(snapshot.realCalls).toBe(0);
      expect(w.status(done.taskId)).toBe('DONE');
      expect(w.replies(done.threadId).some(row => row.body_json.includes('SAFE_TOKEN_P03_DONE'))).toBe(true);
      expect(remaining.remaining, 'A confirmed shared carrier exit must not leave its consumer running indefinitely').toEqual([]);
      expect(states).toMatchObject([{ turnStatus: 'UNKNOWN', workflowStatus: 'INTERRUPTED' }]);
      expect(w.status(live.taskId)).not.toBe('DONE');
      expect(w.replies(live.threadId)).toEqual([]);
      expect(w.admission.has(states[0]!.id), 'UNKNOWN keeps its admission protection after consumer settlement').toBe(true);
      expect(snapshot.admission.global).toBe(1);
    } finally { await w.close(); }
  }, 12000);

  it('P04 GUARDED worker: duplicate notifications and contradictory/post-terminal output do not rewrite visible success', async () => {
    const f = protocol('P04-duplicate-terminal-worker', { TOKEN_P04: { before: [started()] } });
    const w = await workerFixture(f);
    try {
      const root = await w.send('TOKEN_P04'); await w.worker.runOnce();
      const session = { id: (w.db.prepare('SELECT session_id FROM agent_turns').get() as { session_id: string }).session_id } as SessionRef;
      const observed = capture(f, session);
      const owned = (method: string, params: Record<string, unknown>) => frame(method, { threadId: '$THREAD{TOKEN_P04}', turnId: '$TURN{TOKEN_P04}', ...params });
      const reply = owned('item/completed', { item: { type: 'agentMessage', id: 'duplicate-final-id', text: '$FINAL{TOKEN_P04}' } });
      const final = owned('turn/completed', { turn: { id: '$TURN{TOKEN_P04}', status: 'completed', items: [{ type: 'agentMessage', text: '$FINAL{TOKEN_P04}' }] } });
      await f.control([owned('turn/started', { turn: { id: '$TURN{TOKEN_P04}' } }), reply, reply, final,
        owned('item/agentMessage/delta', { itemId: 'post-final', delta: 'POISON_AFTER_TERMINAL' }),
        owned('item/completed', { item: { type: 'agentMessage', id: 'post-final', text: 'POISON_AFTER_TERMINAL' } }),
        owned('turn/completed', { turn: { id: '$TURN{TOKEN_P04}', status: 'failed', error: { kind: 'LateContradiction', message: 'POISON_AFTER_TERMINAL' }, items: [] } }), final,
      ]);
      await expect.poll(() => w.status(root.taskId)).toBe('DONE');
      await f.exit(); await bounded(observed.done, 'P04 raw stream');
      const replies = w.replies(root.threadId), raw = observed.events;
      f.save({ classification: 'guarded-at-worker-only', root, rawAdapterEvents: raw, databaseBeforeCleanup: w.snapshot(), adapterStillEmitsAfterTerminal: raw.some(e => e.kind === 'message.completed' && e.text === 'POISON_AFTER_TERMINAL') });
      expect(w.snapshot().realCalls).toBe(0);
      expect(replies).toHaveLength(1);
      expect(replies[0]!.body_json).toContain('SAFE_TOKEN_P04');
      expect(JSON.stringify(replies)).not.toContain('POISON_AFTER_TERMINAL');
      expect(raw.some(e => e.kind === 'message.completed' && e.text === 'POISON_AFTER_TERMINAL')).toBe(true);
      expect(raw.filter(e => e.kind === 'turn.completed')).toHaveLength(2);
      expect(raw.filter(e => e.kind === 'turn.failed')).toHaveLength(1);
    } finally { await w.close(); }
  }, 12000);

  it('P05 repaired [DeepSeek cross-discovery]: every contradictory approval identity must deny without delivery', async () => {
    const f = protocol('P05-conflicting-approval', { a: { before: [started()] }, b: { before: [started()] } });
    try {
      const a = await open(f, 'a'), b = await open(f, 'b'), sa = capture(f, a), sb = capture(f, b);
      await f.adapter.startTurn(a, request('a')); await f.adapter.startTurn(b, request('b'));
      const conflicts = [
        { conversationId: '$THREAD{b}' },
        { turn: { id: '$TURN{b}' } },
        { conversationId: '$THREAD{b}', turn: { id: '$TURN{b}' } },
        { threadId: '$THREAD{b}', conversationId: '$THREAD{a}' },
        { turnId: '$TURN{b}', turn: { id: '$TURN{a}' } },
      ];
      await f.control(conflicts.map((extra, index) => approval(7501 + index, 'a', extra)));
      const approvals = [...sa.events, ...sb.events].filter(e => e.kind === 'approval.requested');
      const responses = [];
      for (let index = 0; index < conflicts.length; index++) responses.push(await outcome(f.adapter.respondApproval(a, `appr_${7501 + index}`, 'allow_once')));
      await f.adapter.listModels();
      await f.exit(); await bounded(Promise.all([sa.done, sb.done]), 'P05 streams');
      const wireReplies = f.log().filter(row => row.type === 'in' && Number(row.frame?.['id']) >= 7501 && Number(row.frame?.['id']) <= 7505 && row.frame?.['result'] != null);
      const accepted = wireReplies.filter(row => (row.frame?.['result'] as { decision?: string })?.decision === 'accept');
      f.save({ classification: 'repaired', responses, approvals, wireReplies, streams: [sa.events, sb.events], deepSeekCrossDiscovery: 'design item 6' });
      expect(approvals).toEqual([]);
      expect(responses).toHaveLength(conflicts.length);
      for (const response of responses) expect(response).toMatchObject({ status: 'rejected', adapterCallError: true });
      expect(wireReplies.map(row => row.frame)).toEqual(conflicts.map((_, index) => expect.objectContaining({ id: 7501 + index, result: { decision: 'decline' } })));
      expect(accepted, 'Conflicting identity fields must never produce an accepted request').toHaveLength(0);
    } finally { await f.close(); }
  }, 10000);

  it('P06 repaired [DeepSeek cross-discovery]: duplicate outstanding approval RPC id retains the original owner', async () => {
    const f = protocol('P06-duplicate-approval-id', { a: { before: [started()] }, b: { before: [started()] } });
    try {
      const a = await open(f, 'a'), b = await open(f, 'b'), sa = capture(f, a), sb = capture(f, b);
      await f.adapter.startTurn(a, request('a')); await f.adapter.startTurn(b, request('b'));
      await f.control([approval(7601, 'a'), approval(7601, 'b')]);
      const token = approvalToken(sa.events, 7601);
      const foreignReply = await outcome(f.adapter.respondApproval(b, token, 'allow_once'));
      const originalReply = await outcome(f.adapter.respondApproval(a, token, 'deny'));
      const replacementReply = await outcome(f.adapter.respondApproval(b, token, 'allow_once'));
      await f.adapter.listModels(); await f.exit(); await bounded(Promise.all([sa.done, sb.done]), 'P06 streams');
      const accepted = f.log().filter(row => row.type === 'in' && row.frame?.['id'] === 7601 && (row.frame['result'] as { decision?: string } | undefined)?.decision === 'accept');
      const wireReplies = f.log().filter(row => row.type === 'in' && row.frame?.['id'] === 7601 && row.frame['result'] != null);
      f.save({ classification: 'repaired', foreignReply, originalReply, replacementReply, accepted, wireReplies, streams: [sa.events, sb.events], deepSeekCrossDiscovery: 'design item 7' });
      expect(sa.events.filter(e => e.kind === 'approval.requested')).toMatchObject([{ approvalId: token, sessionId: a.id, turnId: 'internal-a' }]);
      expect(sb.events.filter(e => e.kind === 'approval.requested')).toEqual([]);
      expect(foreignReply).toMatchObject({ status: 'rejected', code: 'THREAD_SCOPE_MISMATCH' });
      expect(originalReply).toEqual({ status: 'fulfilled' });
      expect(replacementReply).toMatchObject({ status: 'rejected' });
      expect(wireReplies.map(row => row.frame)).toEqual([expect.objectContaining({ id: 7601, result: { decision: 'decline' } })]);
      expect(accepted, 'Repeated outstanding RPC ids must quarantine or retain the original binding').toHaveLength(0);
    } finally { await f.close(); }
  }, 10000);

  it('P07 repaired: explicit turn/start failure clears awaiting and permits a clean retry', async () => {
    const f = protocol('P07-failed-start-retry', { rejected: { responseError: { code: -32000, message: 'SYNTHETIC rejected before any turn exists' } }, retry: { before: [started()], after: [terminal('SAFE_RETRY')] } });
    try {
      const session = await open(f, 'retry'), stream = capture(f, session);
      const first = await outcome(f.adapter.startTurn(session, request('rejected')));
      const retry = await outcome(f.adapter.startTurn(session, request('retry')));
      await f.exit(); await bounded(stream.done, 'P07 stream');
      const starts = f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'turn/start');
      f.save({ classification: 'repaired', first, retry, actualTurnStartRequests: starts.length, events: stream.events });
      expect(first).toMatchObject({ status: 'rejected', code: 'CAPABILITY_UNSUPPORTED' });
      expect(retry, 'Rejected start must not leave an unclaimable awaitingTurn forever').toMatchObject({ status: 'fulfilled' });
      expect(starts).toHaveLength(2);
      expect(stream.events.filter(e => e.turnId === 'internal-rejected')).toEqual([]);
      expect(stream.events.filter(e => e.kind === 'turn.completed')).toMatchObject([{ turnId: 'internal-retry', finalText: 'SAFE_RETRY' }]);
    } finally { await f.close(); }
  }, 10000);

  it('P08 repaired: unbound old-generation start does not block a fresh generation with reused provider thread id', async () => {
    const f = protocol('P08-old-unbound-generation', {
      old: { noResponse: true, exitAfterStart: 17 },
      fresh: { before: [started()], after: [terminal('SAFE_FRESH')] },
    }, 900);
    try {
      const old = await open(f, 'old');
      const oldStart = outcome(f.adapter.startTurn(old, request('old')));
      await expect.poll(() => f.children[0]!.exitCode, { timeout: 2000, interval: 10 }).toBe(17);
      const fresh = await open(f, 'fresh'), stream = capture(f, fresh);
      expect(fresh.providerSessionId).toBe(old.providerSessionId);
      const firstFreshAttempt = await outcome(f.adapter.startTurn(fresh, request('fresh')));
      await f.adapter.close(old);
      await bounded(f.closed[0]!, 'old process close');
      const oldStartResult = await oldStart;
      await f.exit(); await bounded(stream.done, 'P08 fresh stream');
      f.save({ classification: 'repaired', firstFreshAttempt, oldStartResult, sameProviderThread: old.providerSessionId, freshEvents: stream.events, launches: f.children.length });
      expect(oldStartResult.status).toBe('rejected');
      expect(f.children).toHaveLength(2);
      expect(stream.events.filter(e => e.kind === 'turn.completed')).toMatchObject([{ turnId: 'internal-fresh', finalText: 'SAFE_FRESH' }]);
      expect(stream.events.filter(e => e.turnId === 'internal-old')).toEqual([]);
      expect(stream.events.filter(e => e.kind === 'process.exited')).toHaveLength(1);
      expect(firstFreshAttempt, 'Old pending session state must be excluded from the new process generation').toMatchObject({ status: 'fulfilled' });
    } finally { await f.close(); }
  }, 10000);

  it('P09 repaired [DeepSeek design 4]: dead-generation approval rejects without spawning or writing to a new process', async () => {
    const f = protocol('P09-old-approval-generation', { old: { before: [started()] } });
    try {
      const old = await open(f, 'old'), stream = capture(f, old);
      await f.adapter.startTurn(old, request('old'));
      await f.control([approval(7901, 'old')]);
      const token = approvalToken(stream.events, 7901);
      expect(stream.events.filter(e => e.kind === 'approval.requested')).toMatchObject([{ approvalId: token, turnId: 'internal-old' }]);
      await f.exit(29); await bounded(stream.done, 'P09 old stream');
      const staleReply = await outcome(f.adapter.respondApproval(old, token, 'allow_once'));
      const accepted = f.log().filter(row => row.type === 'in' && row.frame?.['id'] === 7901 && (row.frame['result'] as { decision?: string })?.decision === 'accept');
      f.save({ classification: 'repaired', staleReply, launches: f.children.length, accepted, oldPid: f.children[0]!.pid, oldEvents: stream.events, deepSeekProposedBeforeImplementation: 'design item 4' });
      expect(staleReply).toMatchObject({ status: 'rejected', adapterCallError: true });
      expect(accepted).toEqual([]);
      expect(f.children, 'Stale approval must be invalidated at generation death; a reply cannot create a new carrier').toHaveLength(1);
    } finally { await f.close(); }
  }, 10000);

  it('P10 repaired [DeepSeek design 5]: a closed session tombstone rejects late started while a legitimate new ID completes', async () => {
    const f = protocol('P10-closed-resume-late-start', {
      old: { providerTurnId: 'closed-old-turn', before: [started()], after: [terminal('SAFE_OLD')] },
      keepalive: { before: [started()] },
      resumed: { providerTurnId: 'real-new-turn', before: [started('closed-old-turn'), message('POISON_CLOSED_OLD_SESSION', 'late-old', 'closed-old-turn'), terminal('POISON_CLOSED_OLD_SESSION', 'closed-old-turn')], after: [started(), message('SAFE_RESUMED'), terminal('SAFE_RESUMED')] },
    });
    try {
      const old = await open(f, 'old'), keepalive = await open(f, 'keepalive');
      await f.adapter.startTurn(old, request('old')); await f.adapter.startTurn(keepalive, request('keepalive'));
      await f.adapter.close(old); // The keepalive session retains this same physical process.
      const resumed = await open(f, 'resumed', old), stream = capture(f, resumed), other = capture(f, keepalive);
      await f.adapter.startTurn(resumed, request('resumed'));
      await f.exit(); await bounded(Promise.all([stream.done, other.done]), 'P10 streams');
      const leaked = stream.events.filter(e => e.kind === 'message.completed' && e.text.includes('POISON_CLOSED_OLD_SESSION'));
      f.save({ classification: 'repaired', launches: f.children.length, oldSessionId: old.id, resumedSessionId: resumed.id, sameProviderThread: old.providerSessionId === resumed.providerSessionId, resumedEvents: stream.events, keepaliveEvents: other.events, leaked, deepSeekProposedBeforeImplementation: 'design item 5' });
      expect(f.children).toHaveLength(1);
      expect(resumed.providerSessionId).toBe(old.providerSessionId);
      expect(stream.events.filter(e => e.kind === 'turn.started')).toMatchObject([{ turnId: 'internal-resumed', providerTurnId: 'real-new-turn' }]);
      expect(stream.events.filter(e => e.kind === 'turn.completed')).toMatchObject([{ turnId: 'internal-resumed', finalText: 'SAFE_RESUMED' }]);
      expect(JSON.stringify(other.events)).not.toContain('POISON_CLOSED_OLD_SESSION');
      expect(leaked, 'A closed session must retain enough retired identity to reject its delayed start').toHaveLength(0);
    } finally { await f.close(); }
  }, 10000);

  for (const conflicting of [false, true]) {
    it(`R126 buffers start, message, tool, usage and terminal events until response validation (conflict=${conflicting})`, async () => {
      const f = protocol(`R126-buffer-${conflicting ? 'conflict' : 'valid'}`, {
        a: { holdResponse: true, ...(conflicting ? { responseTurnId: 'conflicting-response' } : {}), before: [
          started(),
          frame('item/agentMessage/delta', { ...identity, itemId: 'early-delta', delta: 'BUFFERED_BODY' }),
          message('BUFFERED_BODY'), tool('item/started', 'echo BUFFERED_TOOL'), tool('item/completed'),
          frame('thread/tokenUsage/updated', { ...identity, tokenUsage: { total: { inputTokens: 13, outputTokens: 7 } } }),
          terminal('BUFFERED_FINAL'),
        ] },
        retry: { before: [started()], after: [terminal('SAFE_AFTER_BUFFER')] },
      });
      try {
        const session = await open(f, 'a'), stream = capture(f, session);
        const pending = outcome(f.adapter.startTurn(session, request('a')));
        await expect.poll(() => f.log().some(row => row.type === 'turn.registered' && row.key === 'a')).toBe(true);
        await f.control(); // A real response on the same pipe proves all early frames were parsed.
        const beforeResponse = [...stream.events];
        await f.control([], undefined, 'a');
        const startResult = await pending;
        const afterResponse = [...stream.events];
        const retry = await outcome(f.adapter.startTurn(session, request('retry')));
        await f.exit(); await bounded(stream.done, 'R126 buffered stream');
        f.save({ classification: 'repaired', conflicting, beforeResponse, afterResponse, startResult, retry, events: stream.events });
        expect(beforeResponse.map(e => e.kind)).toEqual(['session.ready']);
        if (conflicting) {
          expect(startResult).toMatchObject({ status: 'rejected', adapterCallError: true, code: 'CAPABILITY_UNSUPPORTED', notStarted: false });
          expect(afterResponse.map(e => e.kind)).toEqual(['session.ready']);
          expect(JSON.stringify(stream.events)).not.toContain('BUFFERED_');
          expect(stream.events.filter(e => e.turnId === 'internal-a')).toEqual([]);
        } else {
          expect(startResult).toEqual({ status: 'fulfilled' });
          expect(afterResponse.map(e => e.kind)).toEqual(['session.ready', 'turn.started', 'message.delta', 'message.completed', 'tool.started', 'tool.completed', 'usage.updated', 'turn.completed']);
          expect(afterResponse.slice(1).every(e => e.turnId === 'internal-a' && e.sessionId === session.id && e.stage === 'r124.a')).toBe(true);
          expect(afterResponse.find(e => e.kind === 'tool.completed')).toMatchObject({ target: 'echo BUFFERED_TOOL' });
          expect(afterResponse.find(e => e.kind === 'usage.updated')).toMatchObject({ inputTokens: 13, outputTokens: 7 });
        }
        expect(retry).toEqual({ status: 'fulfilled' });
        expect(stream.events.filter(e => e.kind === 'turn.completed' && e.turnId === 'internal-retry')).toMatchObject([{ finalText: 'SAFE_AFTER_BUFFER' }]);
      } finally { await f.close(); }
    }, 10000);
  }
});
