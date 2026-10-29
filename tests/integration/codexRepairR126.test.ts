import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
import type { NormalizedRuntimeEvent, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';
import { openDatabase } from '../../src/persistence/db.ts';

type Frame = { method: string; params: Record<string, unknown>; id?: string | number };
type Row = { type: string; sequence?: number; frame?: Record<string, unknown> };
type Script = { waitApproval?: number; errorBeforeResponse?: boolean; responseTurnId?: string; omitStarted?: boolean };
const root = resolve('dist/r126-protocol/extra');
const fixtureEntry = resolve('tests/fixtures/codexRepairR126.mjs');
const audits: Array<{ dir: string; cleanupReturned: boolean }> = [];
mkdirSync(root, { recursive: true });
beforeEach(() => { vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake'); });
afterEach(() => vi.unstubAllEnvs());
afterAll(() => {
  for (const audit of audits) {
    expect(audit.cleanupReturned, `Cleanup did not return normally: ${audit.dir}`).toBe(true);
    expect(existsSync(join(audit.dir, 'result.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(audit.dir, 'cleanup.json'), 'utf8'))).toMatchObject({ allOwnedChildrenClosed: true, databaseClosed: true });
  }
});
async function bounded<T>(promise: Promise<T>, ms = 2500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Harness bounded wait expired')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function outcome(promise: Promise<unknown>) {
  try { await promise; return { status: 'fulfilled' }; }
  catch (error) { return { status: 'rejected', message: error instanceof Error ? error.message : String(error) }; }
}
const request = (key: string): TurnRequest => ({ turnId: `internal-${key}`, dispatchKey: key, inputBundleId: 'r126', text: key, taskRevision: 0, policyId: 'readonly' });
const approval = (key: string, id: string | number, extra: Record<string, unknown> = {}): Frame => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId: `$THREAD{${key}}`, turnId: `$TURN{${key}}`, command: 'echo LOCAL_ONLY', ...extra } });
const terminal = (key: string): Frame => ({ method: 'turn/completed', params: { threadId: `$THREAD{${key}}`, turn: { id: `$TURN{${key}}`, status: 'completed', items: [{ type: 'agentMessage', text: `SAFE_${key}` }] } } });

function setup(label: string, turns: Record<string, Script> = {}) {
  const dir = mkdtempSync(join(root, `${label}-`)), project = join(dir, 'project'); mkdirSync(project);
  const audit = { dir, cleanupReturned: false }; audits.push(audit);
  const controlPath = join(dir, 'control.jsonl'), configPath = join(dir, 'scenario.json'), wirePath = join(dir, 'wire.jsonl');
  writeFileSync(configPath, JSON.stringify({ turns, controlPath }, null, 2));
  const db = openDatabase(join(dir, 'state.sqlite'));
  const children: ChildProcessWithoutNullStreams[] = [], closed: Promise<void>[] = [];
  const observers: Array<{ stop: () => void; done: Promise<void> }> = [];
  const adapter = new CodexAppServerAdapter({ mockEntry: { executable: fixtureEntry, args: [configPath, wirePath] }, requestTimeoutMs: 5000,
    spawnFn: (command, args) => {
      if (command !== process.execPath || args[0] !== fixtureEntry || args[1] !== configPath) throw Error('Local-only fixture path guard');
      const child = spawn(command, args, { cwd: project, env: { SystemRoot: process.env['SystemRoot'], WINDIR: process.env['WINDIR'], TEMP: dir, TMP: dir }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      children.push(child); closed.push(new Promise<void>(done => child.once('close', () => done())));
      writeFileSync(join(dir, 'launches.json'), JSON.stringify({ command, args, pid: child.pid, realBusinessModelCalls: 0 }, null, 2));
      return child;
    },
  });
  const log = (): Row[] => existsSync(wirePath) ? readFileSync(wirePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Row) : [];
  let sequence = 0;
  const control = async (frames: Frame[]) => {
    appendFileSync(controlPath, JSON.stringify({ frames }) + '\n'); const expected = ++sequence;
    await expect.poll(() => log().some(row => row.type === 'control.applied' && row.sequence === expected), { timeout: 2000 }).toBe(true);
    await adapter.listModels();
  };
  const open = (key: string, resume?: SessionRef) => adapter.openSession({ projectId: label, memberId: 'synthetic-member', taskId: key, threadId: key, sessionGeneration: resume ? 1 : 0, cwd: project, policyId: 'readonly', ...(resume ? { resume } : {}) });
  const observe = (session: SessionRef) => {
    const events: NormalizedRuntimeEvent[] = [], iterator = adapter.events(session)[Symbol.asyncIterator]();
    let stop!: () => void;
    const stopped = new Promise<undefined>(done => { stop = () => done(undefined); });
    const consume = (async () => { for (;;) { const next = await Promise.race([iterator.next(), stopped]); if (next == null || next.done) return; events.push(next.value); if (next.value.kind === 'process.exited') return; } })();
    observers.push({ stop, done: consume });
    return events;
  };
  const save = (facts: Record<string, unknown>) => writeFileSync(join(dir, 'result.json'), JSON.stringify({ label, dir, facts, databaseBeforeCleanup: { realCalls: (db.prepare('SELECT count(*) n FROM real_calls').get() as { n: number }).n, turns: db.prepare('SELECT id,status FROM agent_turns').all(), messages: db.prepare('SELECT id,body_json FROM messages').all() }, childrenBeforeCleanup: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })) }, null, 2));
  return { adapter, open, observe, control, log, save,
    async close() {
      for (const observer of observers) observer.stop();
      await bounded(Promise.all(observers.map(observer => observer.done)));
      try { await adapter.dispose(); }
      finally {
        for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
        await bounded(Promise.all(closed)); db.close();
        writeFileSync(join(dir, 'cleanup.json'), JSON.stringify({ allOwnedChildrenClosed: true, databaseClosed: !db.open, children: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })) }, null, 2));
      }
      audit.cleanupReturned = true;
    },
  };
}

describe('R126 protocol repair boundaries through a local Node server', () => {
  it('responds to a legitimate exact early approval before the provider returns its start response', async () => {
    const f = setup('early-approval', { early: { waitApproval: 6101 } });
    try {
      const session = await f.open('early'), events = f.observe(session);
      const start = outcome(f.adapter.startTurn(session, request('early')));
      await expect.poll(() => events.some(e => e.kind === 'approval.requested')).toBe(true);
      expect(f.log().some(row => row.type === 'out' && row.frame?.['result'] != null && (row.frame['result'] as { turn?: unknown }).turn != null)).toBe(false);
      const event = events.find(e => e.kind === 'approval.requested')!;
      if (event.kind !== 'approval.requested') throw Error('Missing approval');
      await f.adapter.respondApproval(session, event.approvalId, 'allow_once');
      expect(await bounded(start)).toEqual({ status: 'fulfilled' });
      await f.control([terminal('early')]);
      f.save({ events, approvalToken: event.approvalId });
      expect(events.filter(e => e.kind === 'turn.completed')).toHaveLength(1);
      expect(f.log().some(row => row.type === 'in' && row.frame?.['id'] === 6101 && (row.frame['result'] as { decision?: string })?.decision === 'accept')).toBe(true);
    } finally { await f.close(); }
  });

  for (const omitStarted of [false, true]) it(`rejects a precise nonretryable error before start response without timeout, omitStarted=${omitStarted}`, async () => {
    const f = setup(`early-error-${omitStarted}`, { broken: { errorBeforeResponse: true, omitStarted } });
    try {
      const session = await f.open('broken'), events = f.observe(session);
      const failed = await bounded(outcome(f.adapter.startTurn(session, request('broken'))));
      expect(failed).toMatchObject({ status: 'rejected', message: expect.stringContaining('启动响应前') });
      await f.adapter.startTurn(session, request('retry'));
      await f.control([terminal('retry')]); f.save({ failed, events });
      expect(events.filter(e => e.kind === 'turn.completed')).toEqual([expect.objectContaining({ turnId: 'internal-retry' })]);
      expect(events.filter(e => e.turnId === 'internal-broken')).toEqual([]);
    } finally { await f.close(); }
  });

  it('keeps string and numeric RPC IDs distinct and echoes them unchanged on the wire', async () => {
    const f = setup('typed-rpc-id');
    try {
      const session = await f.open('typed'), events = f.observe(session);
      await f.adapter.startTurn(session, request('typed'));
      await f.control([approval('typed', '6701'), approval('typed', 6701), approval('typed', 'opaque-request')]);
      const approvals = events.filter(e => e.kind === 'approval.requested');
      expect(approvals).toHaveLength(3);
      for (const pending of approvals) await f.adapter.respondApproval(session, pending.approvalId, 'deny');
      await f.adapter.listModels(); f.save({ events });
      const replies = f.log().filter(row => row.type === 'in' && row.frame?.['result'] != null && ['6701', 6701, 'opaque-request'].includes(row.frame['id'] as string | number));
      expect(replies.map(row => row.frame)).toEqual([
        expect.objectContaining({ id: '6701', result: { decision: 'decline' } }),
        expect.objectContaining({ id: 6701, result: { decision: 'decline' } }),
        expect.objectContaining({ id: 'opaque-request', result: { decision: 'decline' } }),
      ]);
    } finally { await f.close(); }
  });

  it('denies contradictions in nested approval identity fields as well as top-level aliases', async () => {
    const f = setup('nested-approval-conflict');
    try {
      const a = await f.open('a'), b = await f.open('b'), events = f.observe(a);
      await f.adapter.startTurn(a, request('a')); await f.adapter.startTurn(b, request('b'));
      await f.control([approval('a', 6801, { turn: { id: '$TURN{a}', threadId: '$THREAD{b}' } }), approval('a', 6802, { turn: { id: '$TURN{a}', turnId: '$TURN{b}' } })]);
      f.save({ events });
      expect(events.filter(e => e.kind === 'approval.requested')).toEqual([]);
      expect(f.log().filter(row => row.type === 'in' && [6801, 6802].includes(row.frame?.['id'] as number)).map(row => row.frame)).toEqual([
        expect.objectContaining({ id: 6801, result: { decision: 'decline' } }),
        expect.objectContaining({ id: 6802, result: { decision: 'decline' } }),
      ]);
    } finally { await f.close(); }
  });

  it('uses protocol-valid legacy approval responses and rejects unsupported server request methods', async () => {
    const f = setup('legacy-response-shape');
    try {
      const session = await f.open('legacy'), events = f.observe(session);
      await f.adapter.startTurn(session, request('legacy'));
      await f.control([
        { id: 'legacy-allow', method: 'execCommandApproval', params: { conversationId: '$THREAD{legacy}', command: ['echo', 'LOCAL_ONLY'] } },
        { id: 'legacy-deny', method: 'applyPatchApproval', params: { conversationId: '$THREAD{legacy}', fileChanges: {} } },
        { id: 'unsupported', method: 'item/tool/call', params: { threadId: '$THREAD{legacy}', turnId: '$TURN{legacy}' } },
      ]);
      const approvals = events.filter(e => e.kind === 'approval.requested');
      expect(approvals).toHaveLength(2);
      await f.adapter.respondApproval(session, approvals[0]!.approvalId, 'allow_once');
      await f.adapter.respondApproval(session, approvals[1]!.approvalId, 'deny'); await f.adapter.listModels();
      f.save({ events });
      expect(f.log().find(row => row.type === 'in' && row.frame?.['id'] === 'legacy-allow')?.frame).toMatchObject({ result: { decision: 'approved' } });
      expect(f.log().find(row => row.type === 'in' && row.frame?.['id'] === 'legacy-deny')?.frame).toMatchObject({ result: { decision: { denied: { rejection: expect.any(String) } } } });
      expect(f.log().find(row => row.type === 'in' && row.frame?.['id'] === 'unsupported')?.frame).toMatchObject({ error: { code: -32601 } });
    } finally { await f.close(); }
  });

  it('does not send a second provider request for an already bound internal turn', async () => {
    const f = setup('duplicate-internal-turn');
    try {
      const session = await f.open('once'); await f.adapter.startTurn(session, request('once'));
      await expect(f.adapter.startTurn(session, request('once'))).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED', notStarted: true });
      await f.adapter.listModels(); f.save({ starts: f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'turn/start') });
      expect(f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'turn/start')).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('does not turn a completed status carrying a provider error into a successful result', async () => {
    const f = setup('contradictory-terminal');
    try {
      const session = await f.open('contradictory'), events = f.observe(session);
      await f.adapter.startTurn(session, request('contradictory'));
      await f.control([{ method: 'turn/completed', params: { threadId: '$THREAD{contradictory}', turn: { id: '$TURN{contradictory}', status: 'completed', error: { message: 'Synthetic contradiction' }, items: [{ type: 'agentMessage', text: 'POISON_SUCCESS' }] } } }]);
      f.save({ events });
      expect(events.filter(e => e.kind === 'turn.completed')).toEqual([]);
      expect(events.filter(e => e.kind === 'turn.failed')).toEqual([expect.objectContaining({ code: 'CODEX_INVALID_TERMINAL_STATUS', turnId: 'internal-contradictory' })]);
    } finally { await f.close(); }
  });

  it('uses a new approval token when the same RPC number is reused after a completed round', async () => {
    const f = setup('approval-token-reuse');
    try {
      const session = await f.open('first'), events = f.observe(session);
      await f.adapter.startTurn(session, request('first'));
      await f.control([approval('first', 6201)]);
      const first = events.find(e => e.kind === 'approval.requested')!;
      if (first.kind !== 'approval.requested') throw Error('Missing first approval');
      await f.adapter.respondApproval(session, first.approvalId, 'deny');
      await f.control([terminal('first')]);
      await f.adapter.startTurn(session, request('second'));
      await f.control([approval('second', 6201)]);
      const second = events.filter(e => e.kind === 'approval.requested').at(-1)!;
      if (second.kind !== 'approval.requested') throw Error('Missing second approval');
      expect(second.approvalId).not.toBe(first.approvalId);
      await expect(f.adapter.respondApproval(session, first.approvalId, 'allow_once')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
      await f.adapter.respondApproval(session, second.approvalId, 'deny'); await f.adapter.listModels();
      f.save({ first, second, events });
      const replies = f.log().filter(row => row.type === 'in' && row.frame?.['id'] === 6201);
      expect(replies).toHaveLength(2);
      expect(replies.every(row => (row.frame!['result'] as { decision?: string }).decision === 'decline')).toBe(true);
    } finally { await f.close(); }
  });

  it('keeps each pending attempt buffer isolated when another distinct ID starts on the same SessionRef', async () => {
    const f = setup('overlapping-attempt-buffers', { first: { waitApproval: 6501, responseTurnId: 'conflicting-response' } });
    try {
      const session = await f.open('first'), events = f.observe(session);
      const first = outcome(f.adapter.startTurn(session, request('first')));
      await expect.poll(() => events.some(e => e.kind === 'approval.requested')).toBe(true);
      await f.adapter.startTurn(session, request('second'));
      await f.control([{ method: 'item/completed', params: { threadId: '$THREAD{first}', turnId: '$TURN{first}', item: { type: 'agentMessage', id: 'old-pending', text: 'POISON_PENDING_FIRST' } } }]);
      expect(events.filter(e => e.turnId === 'internal-first' && e.kind !== 'approval.requested')).toEqual([]);
      const approval = events.find(e => e.kind === 'approval.requested');
      if (approval?.kind !== 'approval.requested') throw Error('Missing held-start approval');
      await f.adapter.respondApproval(session, approval.approvalId, 'deny');
      const rejected = await bounded(first);
      expect(rejected).toMatchObject({ status: 'rejected', message: expect.stringContaining('不一致') });
      await f.control([terminal('second')]); f.save({ rejected, events });
      expect(events.filter(e => e.turnId === 'internal-first' && e.kind !== 'approval.requested')).toEqual([]);
      expect(JSON.stringify(events)).not.toContain('POISON_PENDING_FIRST');
      expect(events.filter(e => e.kind === 'turn.completed')).toEqual([expect.objectContaining({ turnId: 'internal-second' })]);
    } finally { await f.close(); }
  });

  it('closing a response-pending session rejects its own request while another session keeps the process alive', async () => {
    const f = setup('close-pending', { old: { waitApproval: 6601 } });
    try {
      const old = await f.open('old'), keeper = await f.open('keeper'), events = f.observe(old);
      await f.adapter.startTurn(keeper, request('keeper'));
      const start = outcome(f.adapter.startTurn(old, request('old')));
      await expect.poll(() => events.some(e => e.kind === 'approval.requested')).toBe(true);
      await f.adapter.close(old);
      const rejected = await bounded(start);
      await f.adapter.listModels(); f.save({ rejected, events });
      expect(rejected).toMatchObject({ status: 'rejected', message: expect.stringContaining('会话已关闭') });
      expect(f.log().filter(row => row.type === 'in' && row.frame?.['method'] === 'initialize')).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('denies legacy approvals with two active rounds on the same thread while preserving exact scoped approvals', async () => {
    const f = setup('legacy-ambiguous');
    try {
      const a = await f.open('a'), b = await f.open('b', a), ea = f.observe(a), eb = f.observe(b);
      await f.adapter.startTurn(a, request('a')); await f.adapter.startTurn(b, request('b'));
      await f.control([{ id: 6301, method: 'item/commandExecution/requestApproval', params: { conversationId: '$THREAD{a}', command: 'echo LOCAL_ONLY' } }, approval('a', 6302)]);
      const exact = ea.find(e => e.kind === 'approval.requested');
      if (exact?.kind !== 'approval.requested') throw Error('Missing exact approval');
      await f.adapter.respondApproval(a, exact.approvalId, 'deny'); await f.adapter.listModels();
      f.save({ a: ea, b: eb });
      expect(ea.filter(e => e.kind === 'approval.requested')).toHaveLength(1);
      expect(eb.filter(e => e.kind === 'approval.requested')).toEqual([]);
      expect(f.log().filter(row => row.type === 'in' && row.frame?.['id'] === 6301)).toEqual([expect.objectContaining({ frame: expect.objectContaining({ result: { decision: 'decline' } }) })]);
    } finally { await f.close(); }
  });

  for (const invalidation of ['terminal', 'close'] as const) {
    it(`invalidates an unresolved approval on ${invalidation} while the shared process remains live`, async () => {
      const f = setup(`approval-${invalidation}`);
      try {
        const session = await f.open('old'), keeper = await f.open('keeper'), events = f.observe(session);
        await f.adapter.startTurn(session, request('old')); await f.adapter.startTurn(keeper, request('keeper'));
        await f.control([approval('old', 6401)]);
        const pending = events.find(e => e.kind === 'approval.requested');
        if (pending?.kind !== 'approval.requested') throw Error('Missing pending approval');
        if (invalidation === 'terminal') await f.control([terminal('old')]); else await f.adapter.close(session);
        await expect(f.adapter.respondApproval(session, pending.approvalId, 'allow_once')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
        await f.adapter.listModels(); f.save({ pending, events });
        expect(f.log().filter(row => row.type === 'in' && row.frame?.['id'] === 6401 && (row.frame['result'] as { decision?: string })?.decision === 'accept')).toEqual([]);
      } finally { await f.close(); }
    });
  }
});
