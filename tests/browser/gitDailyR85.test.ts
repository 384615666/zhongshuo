import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureReadingPositions } from '../../src/ui/hifi/data/readingPositions';
import { gitWrite, pendingGitWrites } from '../../src/ui/hifi/data/gitWrites';
import { getState, setState } from '../../src/ui/hifi/data/store';
import { loadFileDiff, refreshGitState, undoLastCommit } from '../../src/ui/hifi/data/actions-git';
import { gitEntryKey, selectedGitEntry } from '../../src/ui/hifi/data/gitEntries';

type Envelope = { commandId: string; method: string; params: Record<string, unknown> };
const ok = (data: unknown) => ({ ok: true, data });
const failed = (operationPending = false) => ({ ok: false, error: { code: 'STALE_REVISION', message: '实际目标已变化', ...(operationPending ? { operationPending: true } : {}) } });
let memory: Map<string, string>;
let namespace: string;
const original = getState();
function globals(handler: (envelope: Envelope) => Promise<unknown>) {
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } });
  vi.stubGlobal('window', { zs: { command: handler }, dispatchEvent: () => true, setTimeout: () => 0 });
}
beforeEach(() => { memory = new Map(); globals(async () => ok({})); namespace = 'r85-' + crypto.randomUUID(); configureReadingPositions(namespace); });
afterEach(() => { vi.unstubAllGlobals(); setState(() => original); });

describe('R85 Git original-envelope durability, distinct file versions and real timestamp units', () => {
  it('lost receipt survives a new client instance and only explicit replay sends original params/number', async () => {
    const calls: Envelope[] = []; let recover = false;
    globals(async env => { calls.push(structuredClone(env)); if (!recover) throw Error('pipe lost'); return ok({ resolved: true }); });
    const params = { projectId: 'A', path: '中文.txt', content: 'original proposal', expectedSnapshotHash: 'a'.repeat(64) };
    expect((await gitWrite('A', 'git.conflict.resolve', params)).status).toBe('unknown'); const saved = pendingGitWrites()[0]!;
    params.content = 'later edits';
    expect((await gitWrite('A', 'git.conflict.resolve', params)).status).toBe('unknown'); expect(calls).toHaveLength(1);
    // A re-read is side-effect free; recreate the client modules against the same persisted root.
    const serialized = [...memory.values()].find(v => v.includes(saved.commandId))!;
    expect(JSON.parse(serialized).items[0].params.content).toBe('original proposal');
    await vi.resetModules();
    const reading = await import('../../src/ui/hifi/data/readingPositions'); reading.configureReadingPositions(namespace);
    const cold = await import('../../src/ui/hifi/data/gitWrites');
    expect(cold.pendingGitWrites()).toEqual([saved]); expect(calls).toHaveLength(1);
    recover = true;
    expect((await cold.gitWrite('A', 'git.conflict.resolve', params, true)).status).toBe('ok');
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(pendingGitWrites()).toEqual([]);
  });
  it('server unresolved-operation evidence retains identity; explicit rejection without it closes only that envelope', async () => {
    globals(async () => failed(true));
    expect((await gitWrite('A', 'git.conflict.resolve', { projectId: 'A', content: 'proposal' })).status).toBe('unknown'); expect(pendingGitWrites()).toHaveLength(1);
    globals(async () => ({ ...failed(), error: { ...failed().error, operationKnownRejected: true } }));
    expect((await gitWrite('A', 'git.conflict.resolve', { projectId: 'A' }, true)).status).toBe('failed'); expect(pendingGitWrites()).toEqual([]);
  });
  it('unavailable local storage refuses before transmission and leaves the caller input unchanged', async () => {
    let calls = 0; globals(async () => { calls++; return ok({}); });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw Error('EACCES fixture'); } });
    const input = { projectId: 'A', name: 'kept input', expectedHead: 'a'.repeat(40) };
    expect((await gitWrite('A', 'git.branch.create', input)).status).toBe('failed'); expect(calls).toBe(0); expect(input.name).toBe('kept input');
  });
  it('double click sends one operation, and late acknowledgement from another root cannot remove its journal', async () => {
    let release: ((value: unknown) => void) | undefined; let calls = 0;
    globals(async () => { calls++; return await new Promise(r => { release = r; }); });
    const first = gitWrite('A', 'git.stage', { projectId: 'A', paths: ['first'] });
    expect((await gitWrite('A', 'git.stage', { projectId: 'A', paths: ['second'] })).status).toBe('failed'); expect(calls).toBe(1);
    const originalRoot = [...memory.keys()].find(k => k.includes('gitWrites'))!;
    configureReadingPositions('another-r85-root'); release!(ok({})); expect((await first).status).toBe('ok');
    expect(JSON.parse(memory.get(originalRoot)!).items).toHaveLength(1); expect(pendingGitWrites()).toEqual([]);
  });
  it('malformed or cross-target journal stays untouched and cannot be transmitted', async () => {
    let calls = 0; globals(async () => { calls++; return ok({}); });
    expect((await gitWrite('A', 'git.stage', { projectId: 'B', paths: ['file'] })).status).toBe('failed');
    expect((await gitWrite('A', 'unknown.write', { projectId: 'A' })).status).toBe('failed'); expect(calls).toBe(0);
    memory.set('zs.hifi.gitWrites.' + namespace, '{broken');
    expect((await gitWrite('A', 'git.stage', { projectId: 'A' })).status).toBe('failed'); expect(calls).toBe(0); expect(memory.get('zs.hifi.gitWrites.' + namespace)).toBe('{broken');
  });
  it('partially staged and conflicted paths retain distinct readable identities and truthful states', async () => {
    const stamp = 1792039824;
    globals(async e => {
      if (e.method === 'git.status') return ok({ branch: 'main', staged: [{ xy: 'MM', path: 'partial.txt' }, { xy: 'UU', path: 'conflict.txt' }], unstaged: [{ xy: 'MM', path: 'partial.txt' }, { xy: 'UU', path: 'conflict.txt' }], untracked: [], truncated: false });
      if (e.method === 'git.branch.list') return ok({ branches: [{ name: 'main', oid: 'a'.repeat(40), lastCommitTs: stamp, upstream: null, ahead: null, behind: null }] });
      if (e.method === 'git.history') return ok({ head: 'a'.repeat(40), items: [{ oid: 'a'.repeat(40), timestamp: stamp, parents: [], subject: 'actual commit', taskIds: [], changeSetIds: [] }] });
      if (e.method === 'git.remote.list') return ok({ remotes: [{ name: 'origin', url: 'local-engineering-remote' }] });
      if (e.method === 'git.diff') return ok({ patches: [{ path: 'partial.txt', text: e.params.staged ? '@@ -1 +1,2 @@\n BASE\n+INDEX_ONLY\n' : '@@ -1,2 +1,3 @@\n BASE\n INDEX_ONLY\n+WORKTREE_ONLY\n', binary: false, truncated: false }], truncatedOverall: false });
      throw Error(e.method);
    });
    setState(s => ({ ...s, git: {} })); await refreshGitState('A');
    const g = getState().git.A!;
    const versions = g.status.filter(e => e.path === 'partial.txt'); expect(versions).toHaveLength(2);
    expect(g.status.filter(e => e.state === 'conflicted')).toHaveLength(1); expect(g.status.find(e => e.state === 'conflicted')?.staged).toBe(false);
    const index = selectedGitEntry(g.status, gitEntryKey(versions.find(e => e.staged)!))!, worktree = selectedGitEntry(g.status, gitEntryKey(versions.find(e => !e.staged)!))!;
    expect(index.staged).toBe(true); expect(worktree.staged).toBe(false);
    expect(selectedGitEntry([g.status.find(e => e.state === 'conflicted')!, worktree], gitEntryKey(index))?.path).toBe('partial.txt');
    expect((await loadFileDiff('A', worktree.path, worktree.staged)).hunks[0]!.lines.at(-1)?.text).toBe('WORKTREE_ONLY');
    expect((await loadFileDiff('A', index.path, index.staged)).hunks[0]!.lines.at(-1)?.text).toBe('INDEX_ONLY');
    expect(g.commits[0]?.committedAt).toBe(stamp * 1000); expect(new Date(g.commits[0]!.committedAt).getFullYear()).toBe(2026); expect(g.branches[0]?.updatedAt).toBe(stamp * 1000); expect(g.remotes[0]?.authState).toBe('unknown');
  });
  it('untracked formal worktree-content is readable and undo sends the three approved identities unchanged', async () => {
    let sent: Envelope | undefined;
    globals(async e => { if (e.method === 'git.diff') return ok({ patches: [{ source: 'worktree-content', text: '# real new file\n', binary: false }], truncatedOverall: false }); sent = e; return failed(); });
    expect((await loadFileDiff('A', '说明.md', false)).hunks[0]?.lines[0]?.text).toBe('# real new file');
    const approved = { commitOid: 'a'.repeat(40), expectedHead: 'a'.repeat(40), expectedBranch: 'main' };
    expect((await undoLastCommit('A', approved)).status).toBe('failed'); expect(sent?.params).toEqual({ projectId: 'A', ...approved });
  });
});
