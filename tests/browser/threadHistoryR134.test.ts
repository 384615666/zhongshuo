import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { command } from '../../src/ui/hifi/bridge';
import { getState, setState } from '../../src/ui/hifi/data/store';
import { loadThread, loadThreadOlder, threadHistoryWindow } from '../../src/ui/hifi/loader';
import { historyScope, historyWindow, recordHistoryPage } from '../../src/ui/hifi/lib/threadHistory';

vi.mock('../../src/ui/hifi/bridge', () => ({ command: vi.fn(), sendCommand: vi.fn(), bridge: vi.fn() }));
const initial = getState();
let generation = 20000;
const rows = (count: number) => Array.from({ length: count }, (_, n) => ({
  id: `m${n + 1}`, seq: n + 1, authorType: 'human', authorId: 'you', body: { text: `history ${n + 1}` }, createdAt: n + 1,
}));
let items = rows(105);
const cmd = vi.mocked(command);
beforeEach(() => {
  setState(() => ({ ...initial, activeProjectId: 'p', loadGen: ++generation, threadEntities: {}, threadMessages: {}, threadAnchors: {}, threadTasks: {}, threads: [], messages: [], tasks: [], readErrors: {}, threadReadSeq: {}, readStates: {}, ui: { ...initial.ui, activeThreadId: 't' } }));
  items = rows(105);
  cmd.mockReset();
  cmd.mockImplementation(async (method, params = {}) => {
    if (method === 'thread.get') return { thread: { id: 't', projectId: 'p', conversationId: 'c', roomId: 'r', anchorMessageId: 'root', rootTaskId: null, status: 'open', lastMessageSeq: items.length, revision: 1 }, anchor: { id: 'root', authorType: 'human', authorId: 'you', body: { text: 'root' }, createdAt: 0, attachments: [] }, lastReadSeq: 0 };
    if (method === 'thread.history') return { items: items.filter(row => params.beforeSeq == null || row.seq < Number(params.beforeSeq)).slice(-100), rootAttachments: [] };
    return {};
  });
});
afterEach(() => { setState(() => initial); vi.restoreAllMocks(); });

describe('R134 thread history through the production loader', () => {
  it('merges 105 rows, preserves them on recent refresh, and never marks read during backfill', async () => {
    await loadThread('t');
    expect(getState().threadMessages.t?.[0]?.threadMessageSeq).toBe(6);
    expect(await loadThreadOlder('t', 6)).toBe(5);
    await loadThread('t');
    expect(getState().threadMessages.t).toHaveLength(105);
    expect(threadHistoryWindow('t')).toMatchObject({ oldestSeq: 1, exhausted: true });
    expect(cmd.mock.calls.filter(([method]) => method === 'thread.markRead')).toHaveLength(0);
  });
  it('can reach a target more than five full pages behind the tail', async () => {
    items = rows(1205);
    await loadThread('t');
    let pages = 0;
    while (!getState().threadMessages.t?.some(row => row.id === 'm1')) {
      await loadThreadOlder('t', threadHistoryWindow('t').oldestSeq!);
      pages++;
    }
    expect(pages).toBe(12);
    expect(getState().threadMessages.t).toHaveLength(1205);
  });
  it('coalesces concurrent page reads and merges a racing refresh once in sequence order', async () => {
    await loadThread('t');
    const original = cmd.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    cmd.mockImplementation(async (method, params) => {
      if (method === 'thread.history' && params?.beforeSeq === 6) await blocked;
      return original(method, params);
    });
    const a = loadThreadOlder('t', 6), b = loadThreadOlder('t', 6);
    await loadThread('t');
    release();
    await Promise.all([a, b]);
    expect(cmd.mock.calls.filter(([method, params]) => method === 'thread.history' && params?.beforeSeq === 6)).toHaveLength(1);
    expect(getState().threadMessages.t?.map(m => m.threadMessageSeq)).toEqual(rows(105).map(m => m.seq));
  });
  it.each(['thread', 'project', 'generation', 'guard'])('discards a delayed page after a %s change', async kind => {
    await loadThread('t');
    const original = cmd.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    cmd.mockImplementation(async (method, params) => { if (method === 'thread.history') await blocked; return original(method, params); });
    let current = true;
    const read = loadThreadOlder('t', 6, () => current);
    if (kind === 'thread') setState(s => ({ ...s, ui: { ...s.ui, activeThreadId: 'other' } }));
    if (kind === 'project') setState(s => ({ ...s, activeProjectId: 'other' }));
    if (kind === 'generation') setState(s => ({ ...s, loadGen: s.loadGen + 1 }));
    if (kind === 'guard') current = false;
    release();
    expect(await read).toBe(0);
    expect(getState().threadMessages.t).toHaveLength(100);
  });
  it('keeps a server private-scope denial retryable without fabricating an empty boundary', async () => {
    await loadThread('t');
    const original = cmd.getMockImplementation()!;
    cmd.mockRejectedValueOnce(Object.assign(new Error('private scope denied'), { code: 'FORBIDDEN' }));
    await expect(loadThreadOlder('t', 6)).rejects.toThrow('private scope denied');
    expect(threadHistoryWindow('t').exhausted).toBe(false);
    cmd.mockImplementation(original);
    expect(await loadThreadOlder('t', 6)).toBe(5);
  });
  it('records root-only history as exhausted without task.get or markRead', async () => {
    items = [];
    await loadThread('t');
    expect(threadHistoryWindow('t')).toMatchObject({ initialized: true, exhausted: true });
    expect(getState().messages.some(m => m.id === 'root')).toBe(true);
    expect(cmd.mock.calls.map(([method]) => method)).toEqual(['thread.get', 'thread.history']);
  });
  it('rejects a nonadvancing server cursor, preserving the retryable boundary', () => {
    const scope = historyScope(999, 'p', 'bad');
    recordHistoryPage(scope, rows(100).map(row => row.seq + 5));
    expect(() => recordHistoryPage(scope, [6], 6)).toThrow('未向前推进');
    expect(historyWindow(scope)).toMatchObject({ oldestSeq: 6, exhausted: false });
  });
});
