import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexAppServerAdapter, CODEX_STRUCTURED_FINAL_INSTRUCTION } from '../../src/adapter/codex/appServerAdapter.ts';
import type { NormalizedRuntimeEvent, OpenSessionInput, SessionRef } from '../../src/contracts/runtime.ts';

interface Rpc { method?: string; params?: Record<string, unknown> }
const fixtures: Array<{ adapter: CodexAppServerAdapter; root: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.adapter.dispose();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'zs-codex-history-'));
  const scenario = join(root, 'scenario.json'), log = join(root, 'rpc.jsonl');
  writeFileSync(scenario, JSON.stringify({ turns: [completed(), completed()], ...extra }));
  const adapter = new CodexAppServerAdapter({
    model: 'fixture-model', requestTimeoutMs: 2_000,
    mockEntry: { executable: resolve('tests/fixtures/mockAppServer.mjs'), args: [scenario, log] },
  });
  fixtures.push({ adapter, root });
  const rpcs = (): Rpc[] => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Rpc);
  const open = (resume?: SessionRef, overrides: Partial<OpenSessionInput> = {}) => adapter.openSession({
    projectId: 'p', memberId: 'm', taskId: 't', threadId: 'chat', cwd: root,
    sessionGeneration: 0, policyId: 'read-only', developerInstructions: 'KEEP_NATIVE_INSTRUCTIONS',
    ...(resume ? { resume } : {}), ...overrides,
  });
  return { adapter, open, rpcs, root };
}

function completed(status = 'completed', extra: Record<string, unknown> = {}) {
  return { notifications: [{ kind: 'turn.started' }, { kind: 'turn.completed', status, finalText: 'fixture result' }], ...extra };
}

async function turn(adapter: CodexAppServerAdapter, session: SessionRef, id: string) {
  const result = (async () => {
    for await (const event of adapter.events(session)) {
      if (event.turnId === id && (event.kind === 'turn.completed' || event.kind === 'turn.failed')) return event;
    }
    throw Error('missing terminal');
  })();
  await adapter.startTurn(session, { turnId: id, dispatchKey: `dispatch-${id}`, inputBundleId: 'bundle', text: 'fixture', policyId: 'read-only', taskRevision: 0 });
  return await result;
}

async function archiveCount(f: ReturnType<typeof fixture>, count: number) {
  await expect.poll(() => f.rpcs().filter(rpc => rpc.method === 'thread/archive').length).toBe(count);
}

describe('R175 Codex internal history is archived without losing native resume', () => {
  it.each(['completed', 'failed', 'interrupted'])('archives an idle %s turn without creating another model turn', async status => {
    const f = fixture({ turns: [completed(status)] }), session = await f.open();
    const event = await turn(f.adapter, session, 'one');
    expect(event.kind).toBe(status === 'completed' ? 'turn.completed' : 'turn.failed');
    await archiveCount(f, 1);
    expect(f.rpcs().find(rpc => rpc.method === 'thread/archive')?.params).toEqual({ threadId: session.providerSessionId });
    expect(f.rpcs().filter(rpc => rpc.method === 'turn/start')).toHaveLength(1);
    expect(f.rpcs().some(rpc => rpc.method === 'thread/delete')).toBe(false);
    expect(f.rpcs().find(rpc => rpc.method === 'thread/start')?.params).not.toHaveProperty('ephemeral', true);
  });

  it('restores a reused in-memory session before its next turn with the same model, scope and instructions', async () => {
    const f = fixture(), session = await f.open();
    await turn(f.adapter, session, 'one'); await archiveCount(f, 1);
    expect(await turn(f.adapter, session, 'two')).toMatchObject({ kind: 'turn.completed', finalText: 'fixture result' });
    await archiveCount(f, 2);
    const methods = f.rpcs().map(rpc => rpc.method);
    expect(methods.indexOf('thread/unarchive')).toBeGreaterThan(methods.indexOf('thread/archive'));
    expect(methods.indexOf('thread/resume')).toBeGreaterThan(methods.indexOf('thread/unarchive'));
    const starts = f.rpcs().filter(rpc => rpc.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts.every(rpc => rpc.params?.threadId === session.providerSessionId)).toBe(true);
    expect(f.rpcs().find(rpc => rpc.method === 'thread/resume')?.params).toMatchObject({
      threadId: session.providerSessionId, cwd: f.root, sandbox: 'read-only', model: 'fixture-model', approvalPolicy: 'never',
      developerInstructions: `KEEP_NATIVE_INSTRUCTIONS\n\n${CODEX_STRUCTURED_FINAL_INSTRUCTION}`,
    });
    expect(f.rpcs().filter(rpc => rpc.method === 'thread/start')).toHaveLength(1);
  });

  it('finds a previously archived persisted session after a new adapter connection', async () => {
    const id = 'persisted-owned-thread', f = fixture({ archivedThreads: [id] });
    const session = await f.open({ id: 'old', providerSessionId: id, runtimeInstallationId: 'codex:old', adapterVersion: 'old', threadId: 'chat', sessionGeneration: 0, cwd: f.root });
    expect(session.providerSessionId).toBe(id);
    expect(f.rpcs().map(rpc => rpc.method)).toEqual(['initialize', 'initialized', 'thread/read', 'thread/unarchive', 'thread/resume']);
    expect(await turn(f.adapter, session, 'one')).toMatchObject({ kind: 'turn.completed' });
    await archiveCount(f, 1);
  });

  it('waits for an archive already on the wire before restoring and dispatching again', async () => {
    const f = fixture({ archiveDelayMs: 150 }), session = await f.open();
    await turn(f.adapter, session, 'one'); await archiveCount(f, 1);
    expect(await turn(f.adapter, session, 'two')).toMatchObject({ kind: 'turn.completed' });
    expect(f.rpcs().filter(rpc => rpc.method === 'thread/unarchive')).toHaveLength(1);
  });

  it.each([{ archiveError: true }, { archiveDropReply: true }])('keeps the task result and exact resume identity when archive acknowledgement fails: %j', async extra => {
    const f = fixture(extra), session = await f.open();
    expect(await turn(f.adapter, session, 'one')).toMatchObject({ kind: 'turn.completed' });
    await archiveCount(f, 1);
    expect(await turn(f.adapter, session, 'two')).toMatchObject({ kind: 'turn.completed' });
    expect(f.rpcs().filter(rpc => rpc.method === 'thread/start')).toHaveLength(1);
    expect(f.rpcs().filter(rpc => rpc.method === 'turn/start')).toHaveLength(2);
  });

  it('does not issue another model turn or create a replacement when unarchiving fails', async () => {
    const f = fixture({ unarchiveError: true }), session = await f.open();
    await turn(f.adapter, session, 'one'); await archiveCount(f, 1);
    await expect(turn(f.adapter, session, 'two')).rejects.toThrow('fixture unarchive failure');
    expect(f.rpcs().filter(rpc => rpc.method === 'turn/start')).toHaveLength(1);
    expect(f.rpcs().filter(rpc => rpc.method === 'thread/start')).toHaveLength(1);
  });

  it('archives metadata-only preparation on close, but leaves another active thread alone', async () => {
    const f = fixture({ turns: [{ notifications: [{ kind: 'turn.started' }] }] });
    const active = await f.open(), idle = await f.open();
    await f.adapter.startTurn(active, { turnId: 'active', dispatchKey: 'dispatch-active', inputBundleId: 'b', text: 'fixture', policyId: 'p', taskRevision: 0 });
    await f.adapter.close(idle);
    expect(f.rpcs().filter(rpc => rpc.method === 'thread/archive').map(rpc => rpc.params?.threadId)).toEqual([idle.providerSessionId]);
    await f.adapter.dispose();
    expect(f.rpcs().some(rpc => rpc.method === 'thread/archive' && rpc.params?.threadId === active.providerSessionId)).toBe(false);
  });

  it('does not archive a thread whose provider still reports active after a terminal-like notification', async () => {
    const f = fixture({ historyReadActive: true }), session = await f.open();
    const event: NormalizedRuntimeEvent = await turn(f.adapter, session, 'one');
    expect(event.kind).toBe('turn.completed');
    await f.adapter.dispose();
    expect(f.rpcs().some(rpc => rpc.method === 'thread/archive')).toBe(false);
  });

  it('cleans an exact stored ID with metadata calls only and retains the eligibility check through dispose', async () => {
    const f = fixture();
    let eligible = true;
    await f.adapter.archiveStoredThread('stored-owned', () => eligible);
    expect(f.rpcs().filter(rpc => rpc.method === 'thread/archive').map(rpc => rpc.params?.threadId)).toEqual(['stored-owned']);
    eligible = false;
    await f.adapter.dispose();
    expect(f.rpcs().some(rpc => rpc.method === 'thread/start' || rpc.method === 'turn/start')).toBe(false);
    expect(f.rpcs().filter(rpc => rpc.method === 'thread/archive')).toHaveLength(1);
  });

  it('retries when the native thread becomes idle just after its turn terminal', async () => {
    const f = fixture({ historyReadActiveOnce: true }), session = await f.open();
    await turn(f.adapter, session, 'one');
    await archiveCount(f, 1);
  });

  it('shares the initialization handshake with concurrent metadata and session requests', async () => {
    const f = fixture({ initializeDelayMs: 40 });
    await Promise.all([f.adapter.listModels(), f.open()]);
    expect(f.rpcs().filter(rpc => rpc.method === 'initialize')).toHaveLength(1);
    expect(f.rpcs().filter(rpc => rpc.method === 'initialized')).toHaveLength(1);
  });

  it('replaces a timed-out maintenance connection before opening a real task session', async () => {
    const f = fixture({ initializeDelayMs: 900 });
    await expect(f.adapter.archiveStoredThread('stored-owned', () => true)).rejects.toThrow('initialize 请求超时');
    const session = await f.open();
    expect(await turn(f.adapter, session, 'one')).toMatchObject({ kind: 'turn.completed' });
    expect(f.rpcs().filter(rpc => rpc.method === 'initialize')).toHaveLength(2);
  });
});
