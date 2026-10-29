import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from '../../src/adapter/codex/appServerAdapter.ts';
import type { NormalizedRuntimeEvent, SessionRef, TurnRequest } from '../../src/contracts/runtime.ts';

type Frame = { method: string; params: Record<string, unknown>; id?: number };
interface Script {
  providerTurnId?: string;
  before?: Frame[];
  after?: Frame[];
  exitWithOpenPipes?: boolean;
  lateBeforeClose?: Frame[];
  exitCode?: number;
}

const identity = { threadId: '$THREAD', turnId: '$TURN' };
const started: Frame = { method: 'turn/started', params: { threadId: '$THREAD', turn: { id: '$TURN' } } };
const terminal = (text: string): Frame => ({ method: 'turn/completed', params: {
  threadId: '$THREAD', turn: { id: '$TURN', status: 'completed', items: [{ type: 'agentMessage', text }] },
} });
const message = (text: string): Frame => ({ method: 'item/completed', params: {
  ...identity, item: { type: 'agentMessage', id: 'reused-item', text },
} });

function fixture(turns: Record<string, Script>, startBarrier = 1, modelNotifications?: Frame[]) {
  const dir = mkdtempSync(join(tmpdir(), 'zs-r123-attribution-'));
  const configPath = join(dir, 'scenario.json'), logPath = join(dir, 'rpc.jsonl'), releasePath = join(dir, 'release');
  const modelReleasePath = join(dir, 'release-models');
  writeFileSync(configPath, JSON.stringify({ turns, startBarrier, releasePath, modelReleasePath, holdModelList: modelNotifications != null, modelNotifications }));
  const children: ChildProcessWithoutNullStreams[] = [];
  const closures: Promise<unknown>[] = [];
  const adapter = new CodexAppServerAdapter({
    mockEntry: { executable: resolve('tests/fixtures/codexEventAttributionR123.mjs'), args: [configPath, logPath] },
    requestTimeoutMs: 3000,
    spawnFn: (cmd, args) => {
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      children.push(child);
      closures.push(once(child, 'close'));
      return child;
    },
  });
  return {
    adapter, children,
    log: () => readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>),
    release: () => writeFileSync(releasePath, ''),
    releaseModels: () => writeFileSync(modelReleasePath, ''),
    async close() {
      writeFileSync(releasePath, '');
      await adapter.dispose();
      for (const child of children) if (child.exitCode == null && child.signalCode == null) child.kill();
      await Promise.all(closures);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function open(adapter: CodexAppServerAdapter, id: string, resume?: SessionRef): Promise<SessionRef> {
  return adapter.openSession({ projectId: 'r123', memberId: 'same-member', taskId: id, threadId: id,
    sessionGeneration: resume == null ? 0 : 1, cwd: tmpdir(), policyId: 'readonly', ...(resume ? { resume } : {}),
  });
}
function request(id: string): TurnRequest {
  return { turnId: `internal-${id}`, dispatchKey: id, inputBundleId: 'r123', text: id, policyId: 'readonly', taskRevision: 0 };
}
async function readUntil(adapter: CodexAppServerAdapter, session: SessionRef, stop: NormalizedRuntimeEvent['kind']) {
  const events: NormalizedRuntimeEvent[] = [];
  for await (const event of adapter.events(session)) {
    events.push(event);
    if (event.kind === stop) return events;
  }
  throw Error('missing protocol barrier');
}

// Every adapter-supported message/progress/tool/terminal notification must fail
// closed for each missing, foreign, or contradictory identity, even during start.
function poisonFrames(): Frame[] {
  const frames: Frame[] = [
    started,
    { method: 'item/agentMessage/delta', params: { ...identity, itemId: 'reused-item', delta: 'PRIVATE_POISON' } },
    message('PRIVATE_POISON'),
    { method: 'item/started', params: { ...identity, item: { type: 'commandExecution', id: 'reused-tool', command: 'echo PRIVATE_POISON' } } },
    { method: 'item/completed', params: { ...identity, item: { type: 'commandExecution', id: 'reused-tool', status: 'completed', command: 'echo PRIVATE_POISON' } } },
    { method: 'thread/tokenUsage/updated', params: { ...identity, tokenUsage: { total: { inputTokens: 999 } } } },
    { method: 'error', params: { ...identity, willRetry: false, error: { kind: 'Poison', message: 'PRIVATE_POISON' } } },
    terminal('PRIVATE_POISON'),
  ];
  const mutations = [
    (p: Record<string, unknown>) => { delete p['threadId']; },
    (p: Record<string, unknown>) => { delete p['turnId']; delete p['turn']; },
    (p: Record<string, unknown>) => { delete p['threadId']; delete p['turnId']; delete p['turn']; },
    (p: Record<string, unknown>) => { p['threadId'] = 'unknown-thread'; },
    (p: Record<string, unknown>) => { p['turnId'] = 'unknown-turn'; delete p['turn']; },
    (p: Record<string, unknown>) => { p['threadId'] = ''; },
    (p: Record<string, unknown>) => { p['turnId'] = ''; delete p['turn']; },
    (p: Record<string, unknown>) => { p['turnId'] = '$TURN'; p['turn'] = { id: 'conflicting-turn' }; },
  ];
  return mutations.flatMap(mutate => frames.map(frame => {
    const copy = structuredClone(frame); mutate(copy.params); return copy;
  }));
}

describe('R123 local Codex protocol attribution', () => {
  it('keeps interleaved early starts unique and drops unidentified messages, tools, usage and terminals without logging their bodies', async () => {
    const legitimate = (id: string): Frame[] => [
      // Complete identity alone cannot claim awaiting; only turn/started can.
      message('PRIVATE_POISON_BEFORE_STARTED'),
      { method: 'item/started', params: { ...identity, item: { type: 'commandExecution', id: 'reused-tool', command: 'echo PRIVATE_POISON' } } },
      started, ...poisonFrames(),
      { method: 'item/agentMessage/delta', params: { ...identity, itemId: 'reused-item', delta: id } },
      message(id),
      { method: 'item/started', params: { ...identity, item: { type: 'commandExecution', id: 'reused-tool', command: `echo ${id}` } } },
      { method: 'item/completed', params: { ...identity, item: { type: 'commandExecution', id: 'reused-tool', status: 'completed' } } },
      { method: 'thread/tokenUsage/updated', params: { ...identity, tokenUsage: { total: { inputTokens: 2 } } } },
      terminal(id),
    ];
    const f = fixture({ a: { before: legitimate('a') }, b: { before: legitimate('b') } }, 2);
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const a = await open(f.adapter, 'a'), b = await open(f.adapter, 'b');
      const reads = [readUntil(f.adapter, a, 'turn.completed'), readUntil(f.adapter, b, 'turn.completed')];
      await Promise.all([f.adapter.startTurn(a, request('a')), f.adapter.startTurn(b, request('b'))]);
      for (const [index, events] of (await Promise.all(reads)).entries()) {
        const id = index === 0 ? 'a' : 'b';
        expect(events.map(e => e.kind)).toEqual(['session.ready', 'turn.started', 'message.delta', 'message.completed', 'tool.started', 'tool.completed', 'usage.updated', 'turn.completed']);
        expect(events.slice(1).every(e => e.turnId === `internal-${id}` && e.sessionId === (index === 0 ? a.id : b.id))).toBe(true);
        expect(events.find(e => e.kind === 'message.completed')).toMatchObject({ text: id });
        expect(events.find(e => e.kind === 'tool.completed')).toMatchObject({ target: `echo ${id}` });
        expect(JSON.stringify(events)).not.toContain('PRIVATE_POISON');
      }
      expect(diagnostic.mock.calls.length).toBeGreaterThan(100);
      for (const [line] of diagnostic.mock.calls) expect(String(line)).toMatch(/^\[codex-appserver\] ignored notification: (missing-identity|conflicting-turn|unknown-or-ambiguous)\n$/);
    } finally { await f.close(); diagnostic.mockRestore(); }
  });

  it('registers response mappings synchronously before following notifications in the same stdout write', async () => {
    const f = fixture({ a: { after: [message('response-first'), terminal('response-first')] } });
    try {
      const a = await open(f.adapter, 'a'), read = readUntil(f.adapter, a, 'turn.completed');
      await f.adapter.startTurn(a, request('a'));
      expect((await read).slice(1)).toMatchObject([
        { kind: 'message.completed', turnId: 'internal-a', text: 'response-first' },
        { kind: 'turn.completed', turnId: 'internal-a', finalText: 'response-first' },
      ]);
    } finally { await f.close(); }
  });

  it('rejects ambiguous resumed thread/turn mappings while keeping the shared process exit broadcast', async () => {
    const f = fixture({ a: {}, b: { after: [message('PRIVATE_POISON'), terminal('PRIVATE_POISON')], exitCode: 7 } });
    try {
      const a = await open(f.adapter, 'a'), readA = readUntil(f.adapter, a, 'process.exited');
      await f.adapter.startTurn(a, request('a'));
      const b = await open(f.adapter, 'b', a), readB = readUntil(f.adapter, b, 'process.exited');
      await f.adapter.startTurn(b, request('b'));
      for (const events of await Promise.all([readA, readB])) {
        expect(events.map(e => e.kind)).toEqual(['session.ready', 'process.exited']);
        expect(events.at(-1)).toMatchObject({ exitCode: 7 });
      }
    } finally { await f.close(); }
  });

  it('preserves early v2 and legacy approval bindings and denies foreign requests or cross-session replies', async () => {
    const approvalMethod = 'item/commandExecution/requestApproval';
    const f = fixture({ a: { before: [
      started,
      { id: 1001, method: approvalMethod, params: { ...identity, command: 'echo v2' } },
      { id: 1002, method: approvalMethod, params: { conversationId: '$THREAD', command: 'echo legacy' } },
      { id: 1003, method: approvalMethod, params: { threadId: 'unknown-thread', turnId: '$TURN' } },
    ], after: [terminal('a')] } });
    try {
      const a = await open(f.adapter, 'a'), b = await open(f.adapter, 'b');
      const read = readUntil(f.adapter, a, 'turn.completed');
      await f.adapter.startTurn(a, request('a'));
      const approvals = (await read).filter(e => e.kind === 'approval.requested');
      expect(approvals).toHaveLength(2);
      expect(approvals[0]).toMatchObject({ sessionId: a.id, turnId: 'internal-a', approvalId: 'appr_1001' });
      expect(approvals[1]).toMatchObject({ sessionId: a.id, approvalId: 'appr_1002' });
      await expect(f.adapter.respondApproval(b, 'appr_1001', 'allow_once')).rejects.toMatchObject({ code: 'THREAD_SCOPE_MISMATCH' });
      await f.adapter.respondApproval(a, 'appr_1001', 'allow_once');
      await f.adapter.respondApproval(a, 'appr_1002', 'deny');
      await expect.poll(() => f.log().filter(row => row['result'] != null).length).toBe(3);
      expect(f.log().filter(row => row['result'] != null)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 1001, result: { decision: 'accept' } }),
        expect.objectContaining({ id: 1002, result: { decision: 'deny' } }),
        expect.objectContaining({ id: 1003, result: { decision: 'deny' } }),
      ]));
    } finally { await f.close(); }
  });

  it('delivers a delayed old process close only to its generation, even when thread/turn IDs are reused', async () => {
    const f = fixture({
      old: { before: [started], exitWithOpenPipes: true, lateBeforeClose: [message('PRIVATE_OLD_PROCESS_POISON')] },
      fresh: { before: [started], after: [message('fresh')] },
    }, 1, [terminal('fresh')]);
    let oldClosed: Promise<unknown> | undefined;
    try {
      const old = await open(f.adapter, 'old'), oldEvents = readUntil(f.adapter, old, 'process.exited');
      const child = f.children[0]!;
      oldClosed = once(child, 'close');
      const oldExited = once(child, 'exit');
      await f.adapter.startTurn(old, request('old'));
      await oldExited;
      const fresh = await open(f.adapter, 'fresh'), read = readUntil(f.adapter, fresh, 'turn.completed');
      await f.adapter.startTurn(fresh, request('fresh'));
      // Keep a new-generation request in flight while the old close is delivered.
      const pending = f.adapter.listModels();
      await expect.poll(() => f.log().some(row => row['method'] === 'model/list')).toBe(true);
      f.release();
      await oldClosed;
      expect((await oldEvents).at(-1)).toMatchObject({ kind: 'process.exited', sessionId: old.id, exitCode: 7 });
      f.releaseModels();
      await expect(pending).resolves.toEqual([]);
      const events = await read;
      expect(events.map(e => e.kind)).toEqual(['session.ready', 'turn.started', 'message.completed', 'turn.completed']);
      expect(events.slice(1).every(e => e.turnId === 'internal-fresh')).toBe(true);
    } finally { await f.close(); }
  });
});
