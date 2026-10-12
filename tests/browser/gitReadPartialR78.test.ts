/** R78：正式 Git 状态读取的部分失败与乱序回执。仅控制 bridge 回执，不改用户仓库。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshGitState } from '../../src/ui/hifi/data/actions-git.ts';
import { getState, setState } from '../../src/ui/hifi/data/store.ts';
import type { GitState } from '../../src/ui/hifi/data/types.ts';

type Envelope = { method: string; params: { projectId?: string } };
const ok = (data: unknown) => ({ ok: true, data });
const fail = (message: string) => ({ ok: false, error: { code: 'READ_FAIL', message } });
const status = (name: string) => ({ branch: 'main', worktreeRoot: 'D:/r78-fixture', projectRootIsWorktreeRoot: true, staged: [], unstaged: [{ xy: ' M', path: name }], untracked: [], truncated: false });
const branches = { current: 'main', branches: [{ name: 'main', oid: 'a'.repeat(40), lastCommitTs: 1, upstream: null, ahead: null, behind: null }], dirtyCount: 1 };
const history = { head: 'a'.repeat(40), hasMore: false, items: [{ oid: 'a'.repeat(40), parent: '', parents: [], authorName: 'Fixture', authorEmail: 'fixture@example.invalid', timestamp: 1, subject: 'baseline', taskIds: [], changeSetIds: [] }] };
const remotes = { remotes: [{ name: 'origin', url: 'https://example.invalid/repo.git' }] };
const original = getState();

beforeEach(() => {
  setState((s) => ({ ...s, projects: [{ id: 'p1', isGit: false } as typeof s.projects[number]], git: {}, ui: { ...s.ui, writeLog: [] } }));
});
afterEach(() => { vi.unstubAllGlobals(); setState(() => original); });

describe('R78 Git 部分只读失败保留事实', () => {
  it('单项失败保留历史/分支/远端旧确认值，status 成功仍更新；成功空列表才清旧值', async () => {
    let phase: 'initial' | 'partial' | 'empty' = 'initial';
    vi.stubGlobal('window', { zs: { command: async (env: Envelope) => {
      if (env.method === 'git.status') return ok(status(phase === 'initial' ? 'before.md' : 'after.md'));
      if (phase === 'partial') return fail(`${env.method} 故障`);
      if (env.method === 'git.branch.list') return ok(branches);
      if (env.method === 'git.history') return ok(phase === 'empty' ? { ...history, items: [], head: null } : history);
      if (env.method === 'git.remote.list') return ok(phase === 'empty' ? { remotes: [] } : remotes);
      throw new Error(env.method);
    } } });
    await refreshGitState('p1');
    const initial = getState().git.p1 as GitState;
    expect(initial.status.map((e) => e.path)).toEqual(['before.md']);
    expect([initial.branches.length, initial.commits.length, initial.remotes.length]).toEqual([1, 1, 1]);
    phase = 'partial';
    await refreshGitState('p1');
    const partial = getState().git.p1 as GitState;
    expect(partial.status.map((e) => e.path)).toEqual(['after.md']);
    expect([partial.branches.length, partial.commits.length, partial.remotes.length]).toEqual([1, 1, 1]);
    expect(partial.readErrors).toMatchObject({ branches: expect.stringContaining('git.branch.list 故障'), history: expect.stringContaining('git.history 故障'), remotes: expect.stringContaining('git.remote.list 故障') });
    phase = 'empty';
    await refreshGitState('p1');
    const empty = getState().git.p1 as GitState;
    expect(empty.branches).toHaveLength(1);
    expect(empty.commits).toEqual([]);
    expect(empty.remotes).toEqual([]);
    expect(empty.readErrors).toEqual({});
  });

  it('旧请求迟到不能覆盖新请求，即使新请求已完成并清除在途登记', async () => {
    let releaseOld: ((value: ReturnType<typeof ok>) => void) | null = null;
    let statusCalls = 0;
    vi.stubGlobal('window', { zs: { command: async (env: Envelope) => {
      if (env.method === 'git.status') {
        statusCalls += 1;
        if (statusCalls === 1) return await new Promise<ReturnType<typeof ok>>((resolve) => { releaseOld = resolve; });
        return ok(status('new.md'));
      }
      if (env.method === 'git.branch.list') return ok(branches);
      if (env.method === 'git.history') return ok(history);
      if (env.method === 'git.remote.list') return ok(remotes);
      throw new Error(env.method);
    } } });
    const old = refreshGitState('p1');
    const newer = refreshGitState('p1');
    await newer;
    expect(getState().git.p1?.status.map((e) => e.path)).toEqual(['new.md']);
    expect(releaseOld).not.toBeNull();
    releaseOld!(ok(status('old.md')));
    await old;
    expect(getState().git.p1?.status.map((e) => e.path)).toEqual(['new.md']);
  });
});
