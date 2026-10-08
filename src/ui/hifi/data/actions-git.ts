/**
 * Git 动作的正式适配层（R64 原型还原）：原型 mock actions-git 的同名导出 → 真实命令
 *（git.status/branch.list/commitPreview/history/commitDiff/stage/unstage/commit/branch.create/
 * checkout/push/pull/remoteHead/commit.undo）。全部写操作走 daemon 的正式幂等管线
 *（git_operations 日志+租约门禁+用户改动保护）；失败如实入 s.git.lastOp，不静默。
 *
 * 原型没有的归属信息（changeSet/task 关联、userPreExisting 标注）不虚构：状态条目只按
 * porcelain 分类（staged/unstaged/untracked）呈现；taskIds/changeSetIds 仅在服务端返回时展示。
 */
import { command } from '../bridge';
import { getState, setState, toast, recordWrite } from './store';
import type { GitBranch, GitCommit, GitState, GitStatusEntry } from './types';
import type { DiffHunk } from './types';

/* ---------- daemon DTO 最小类型 ---------- */
interface RepoStatusData {
  branch: string; worktreeRoot: string;
  staged: Array<{ xy: string; path: string; renamedFrom?: string }>;
  unstaged: Array<{ xy: string; path: string; renamedFrom?: string }>;
  untracked: Array<{ xy: string; path: string }>;
  truncated: boolean;
}
interface BranchListData { current: string | null; branches: Array<{ name: string; oid: string; lastCommitTs: number; upstream: string | null; ahead: number | null; behind: number | null }>; dirtyCount: number }
interface RemoteListData { remotes: Array<{ name: string; url: string }> }
interface BranchItem { name: string; oid: string; lastCommitTs: number; upstream: string | null; ahead: number | null; behind: number | null }
interface HistoryItem { oid: string; parent: string; parents: string[]; authorName: string; authorEmail: string; timestamp: number; subject: string; taskIds: string[]; changeSetIds: string[] }
interface CommitPreviewData {
  head: string | null; branch: string | null;
  staged: Array<{ xy: string; path: string; renamedFrom?: string }>;
  unstagedCount: number; untrackedCount: number; conflicts: string[];
  identity: { name: string | null; email: string | null };
  indexTree: string | null; canCommit: boolean; blockers: string[]; notes: string[];
}
interface HistoryData { items: Array<{ oid: string; parent: string; parents: string[]; authorName: string; authorEmail: string; timestamp: number; subject: string; taskIds: string[]; changeSetIds: string[] }>; head: string | null; hasMore: boolean }

const stateOf = (xy: string): GitStatusEntry['state'] => {
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('A') || xy === '??') return 'added';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('C')) return 'renamed';
  return 'modified';
};

const entryOf = (e: { xy: string; path: string; renamedFrom?: string }, staged: boolean, additions = 0, deletions = 0): GitStatusEntry => ({
  path: e.path,
  state: stateOf(e.xy),
  staged,
  additions, deletions,
  diff: [],
  conflict: undefined,
});

/** 装载某项目的 Git 状态（status+branch.list+commitPreview+history → s.git 投影）。 */
export async function refreshGitState(projectId: string): Promise<void> {
  const prev = getState().git[projectId];
  const markOp = (op: string, ok: boolean, detail: string): void => {
    setState((s) => ({ ...s, git: { ...s.git, [projectId]: { ...(s.git[projectId] ?? emptyGit()), lastOp: { op, ok, detail, at: Date.now() } } } }));
  };
  try {
    const status = await command<RepoStatusData>('git.status', { projectId });
    const box: { branches: BranchListData | null; history: HistoryData | null; remotes: RemoteListData | null } = { branches: null, history: null, remotes: null };
    await Promise.all([
      command<BranchListData>('git.branch.list', { projectId }).then((r) => { box.branches = r; }).catch(() => { box.branches = null; }),
      command<HistoryData>('git.history', { projectId, limit: 50 }).then((r) => { box.history = r; }).catch(() => { box.history = null; }),
      command<RemoteListData>('git.remote.list', { projectId }).then((r) => { box.remotes = r; }).catch(() => { box.remotes = null; }),
    ]);
    const cur = getState().git[projectId] ?? emptyGit();
    const statusEntries: GitStatusEntry[] = [
      ...status.staged.map((e) => entryOf(e, true)),
      ...status.unstaged.map((e) => entryOf(e, false)),
      ...status.untracked.map((e) => ({ ...entryOf(e, false), state: 'untracked' as const })),
    ];
    const branchList: GitBranch[] = (box.branches?.branches ?? []).map((b: BranchItem) => ({
      name: b.name, head: b.oid,
      upstream: b.upstream,
      ahead: b.ahead, behind: b.behind,
      isCurrent: b.name === status.branch,
      updatedAt: b.lastCommitTs,
    }));
    const remotes: import('./types').GitRemote[] = (box.remotes?.remotes ?? []).map((r) => ({ name: r.name, url: r.url, authState: 'unknown' as const }));
    const commits: GitCommit[] = (box.history?.items ?? []).map((c: HistoryItem) => ({
      hash: c.oid, shortHash: c.oid.slice(0, 8), subject: c.subject, body: undefined,
      authorName: c.authorName, authorEmail: c.authorEmail,
      authoredBy: (c.taskIds.length > 0 || c.changeSetIds.length > 0 ? 'agent' : 'human') as 'human' | 'agent',
      committedAt: c.timestamp, parents: c.parents, refs: [],
      files: [], taskId: c.taskIds[0], changeSetId: c.changeSetIds[0],
    }));
    const next: GitState = {
      ...cur,
      currentBranch: status.branch,
      branches: branchList,
      remotes,
      commits,
      status: statusEntries,
      commitMessage: cur.commitMessage,
      reflog: cur.reflog,
    };
    setState((s) => ({
      ...s,
      // git.status 成功=真实 Git 仓库（openProject 响应不带该事实——按真实命令回写）
      projects: s.projects.map((pr) => (pr.id === projectId ? { ...pr, isGit: true } : pr)),
      git: { ...s.git, [projectId]: next },
    }));
    if (status.truncated) markOp('git.status', true, '状态条目超过 200 已截断（porcelain 上限）');
    recordWrite('git.status', `分支 ${status.branch} · ${statusEntries.length} 个未提交改动`);
  } catch (e) {
    const msg = String((e as Error).message);
    // R71：普通非 Git 目录是支持的项目形态——中性标注（isGit=false），不进失败横幅；
    // 真实 Git 执行错误/权限/目录失效仍走红「失败」面板（不吞错）。
    if (msg.startsWith('NOT_A_GIT_REPO')) {
      setState((s) => ({
        ...s,
        projects: s.projects.map((pr) => (pr.id === projectId ? { ...pr, isGit: false } : pr)),
        git: { ...s.git, [projectId]: { ...(s.git[projectId] ?? emptyGit()), notARepo: true, lastOp: undefined } },
      }));
      recordWrite('git.status', '此文件夹未初始化 Git（中性状态）——文件阅读与预览不受影响');
      return;
    }
    markOp('git.status', false, msg);
  }
}

function emptyGit(): GitState {
  return { currentBranch: '', branches: [], remotes: [], commits: [], status: [], commitMessage: '', reflog: [] };
}

export function getGit(projectId: string): GitState | undefined {
  return getState().git[projectId];
}

/* ---------- 单文件 diff（git.diff → DiffHunk 简易解析） ---------- */

export async function loadFileDiff(projectId: string, path: string, staged: boolean): Promise<{ hunks: DiffHunk[]; truncated: boolean; binary: boolean }> {
  const r = await command<{ patches: Array<{ path: string; binary: boolean; truncated: boolean; text: string; addedCount: number | null; deletedCount: number | null }>; truncatedOverall: boolean }>('git.diff', { projectId, path, staged });
  const patch = (r.patches ?? [])[0];
  const text = patch?.text ?? '';
  return { hunks: parseUnifiedDiff(text), truncated: patch?.truncated === true || r.truncatedOverall === true, binary: patch?.binary === true };
}

/** unified diff 文本 → DiffHunk（标题行+上下文/增/删行号）。 */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  if (text.length === 0) return [];
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split('\n')) {
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hm != null) {
      cur = { header: line, lines: [] };
      hunks.push(cur);
      oldNo = Number(hm[1]);
      newNo = Number(hm[2]);
      continue;
    }
    if (cur == null) continue;
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('+')) cur.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
    else if (line.startsWith('-')) cur.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
    else if (line.startsWith('\\')) cur.lines.push({ type: 'ctx', text: line });
    else { cur.lines.push({ type: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ }); }
  }
  return hunks;
}

/* ---------- 暂存/提交/推送/拉取/分支（全部真实命令） ---------- */

async function afterWrite(projectId: string, op: string, okText: string): Promise<void> {
  await refreshGitState(projectId);
  setState((s) => ({ ...s, git: { ...s.git, [projectId]: { ...(s.git[projectId] ?? emptyGit()), lastOp: { op, ok: true, detail: okText, at: Date.now() } } } }));
}

export async function stageFile(projectId: string, path: string): Promise<void> {
  try {
    await command('git.stage', { projectId, paths: [path] });
    await afterWrite(projectId, 'git.stage', `已暂存 ${path}`);
  } catch (e) { gitFail(projectId, 'git.stage', e); }
}

export async function unstageFile(projectId: string, path: string): Promise<void> {
  try {
    await command('git.unstage', { projectId, paths: [path] });
    await afterWrite(projectId, 'git.unstage', `已取消暂存 ${path}`);
  } catch (e) { gitFail(projectId, 'git.unstage', e); }
}

export async function unstageAll(projectId: string): Promise<void> {
  const g = getGit(projectId);
  const paths = (g?.status ?? []).filter((x) => x.staged).map((x) => x.path);
  if (paths.length === 0) return;
  try {
    await command('git.unstage', { projectId, paths });
    await afterWrite(projectId, 'git.unstage', `已取消全部 ${paths.length} 个暂存`);
  } catch (e) { gitFail(projectId, 'git.unstage', e); }
}

/** 批量暂存：
 *  - 对象形态（{taskId}|{changeSetId}）= **真实任务/改动集通道** git.stageTask——服务端按
 *    改动集事实圈定路径并跳过用户既有改动（§14.2）；
 *  - owner 字符串形态 = 状态条目无归属标注，按路径全集暂存（warn 如实说明，不虚构归属）。 */
export async function stageByOwner(projectId: string, owner: 'agent' | 'user' | { taskId?: string; changeSetId?: string }): Promise<void> {
  if (typeof owner === 'object') {
    try {
      const r = await command<{ staged: string[]; skippedUserPreExisting?: string[] }>('git.stageTask', {
        projectId,
        ...(owner.taskId != null ? { taskId: owner.taskId } : {}),
        ...(owner.changeSetId != null ? { changeSetId: owner.changeSetId } : {}),
      });
      await afterWrite(projectId, 'git.stageTask', `已按${owner.taskId != null ? '任务' : '改动集'}暂存 ${r.staged?.length ?? 0} 个文件${(r.skippedUserPreExisting?.length ?? 0) > 0 ? `（跳过你的既有改动 ${r.skippedUserPreExisting?.length} 个）` : ''}`);
      return;
    } catch (e) { gitFail(projectId, 'git.stageTask', e); return; }
  }
  // R65（review §6）：owner 字符串形态**不再降级为全部路径**——状态条目无归属标注，
  // 全量暂存会绕开「按任务/改动集」与用户改动保护语义。明确拒绝并指路真实通道。
  toast('状态条目不带归属标注——不按 owner 全量暂存。请用任务分组的「暂存本任务改动」（git.stageTask，服务端按改动集圈定并跳过你的既有改动）或逐文件「暂存」', 'warn');
  void owner;
}

/* ---------- 冲突（三方内容如实；不做一键覆盖） ---------- */

export async function loadConflictContent(projectId: string, path: string): Promise<{ base: string | null; ours: string | null; theirs: string | null }> {
  return command('git.conflict.content', { projectId, path });
}

export async function resolveConflict(projectId: string, path: string, content: string): Promise<void> {
  try {
    await command('git.conflict.resolve', { projectId, path, content });
    await afterWrite(projectId, 'git.conflict.resolve', `已按你确认的内容解决 ${path} 并暂存`);
  } catch (e) { gitFail(projectId, 'git.conflict.resolve', e); }
}

export function setCommitMessage(projectId: string, message: string): void {
  setState((s) => ({ ...s, git: { ...s.git, [projectId]: { ...(s.git[projectId] ?? emptyGit()), commitMessage: message } } }));
}

export async function commit(projectId: string): Promise<void> {
  const g = getGit(projectId);
  const message = g?.commitMessage?.trim();
  if (message == null || message.length === 0) { toast('请先填写提交信息', 'warn'); return; }
  try {
    const preview = await command<CommitPreviewData>('git.commitPreview', { projectId });
    if (preview.canCommit !== true) {
      toast(`暂不能提交：${preview.blockers.join('；') || '索引为空或存在冲突'}`, 'error');
      return;
    }
    await command('git.commit', {
      projectId, message,
      expectedHead: preview.head, expectedIndexTree: preview.indexTree, expectedBranch: preview.branch,
    });
    setCommitMessage(projectId, '');
    await afterWrite(projectId, 'git.commit', `已提交：${message.split('\n')[0] ?? message}`);
    toast('已提交（commit-tree 不跑钩子；关联任务/改动集未随意外推）', 'success');
  } catch (e) { gitFail(projectId, 'git.commit', e); }
}

export async function push(projectId: string, remoteName = 'origin'): Promise<void> {
  const g = getGit(projectId);
  const branch = g?.currentBranch;
  if (branch == null || branch.length === 0) { toast('当前不在分支上（detached HEAD）——不能推送', 'error'); return; }
  try {
    const head = (g?.commits[0]?.hash) ?? null;
    const rh = await command<{ remote: string; branch: string; head: string | null; url: string }>('git.remoteHead', { projectId, remote: remoteName, branch });
    if (head == null) { toast('本地 HEAD 未知（先刷新历史）', 'error'); return; }
    await command('git.push', { projectId, remote: remoteName, branch, expectedHead: head, expectedRemoteHead: rh.head, expectedRemoteUrl: rh.url });
    await afterWrite(projectId, 'git.push', `已推送 ${remoteName}/${branch}`);
  } catch (e) { gitFail(projectId, 'git.push', e); }
}

export async function pull(projectId: string, remoteName = 'origin'): Promise<void> {
  const g = getGit(projectId);
  const branch = g?.currentBranch;
  if (branch == null || branch.length === 0) { toast('当前不在分支上（detached HEAD）——不能拉取', 'error'); return; }
  try {
    const head = g?.commits[0]?.hash;
    if (head == null) { toast('本地 HEAD 未知（先刷新历史）', 'error'); return; }
    const r = await command<{ from: string; to: string; pulledCount: number }>('git.pull', { projectId, remote: remoteName, branch, expectedHead: head });
    await afterWrite(projectId, 'git.pull', `已拉取 ${r.pulledCount} 个提交（${remoteName}/${branch}）`);
  } catch (e) { gitFail(projectId, 'git.pull', e); }
}

export async function checkoutBranch(projectId: string, branch: string): Promise<void> {
  try {
    const g = getGit(projectId);
    const expectedHead = g?.commits[0]?.hash ?? null;
    await command('git.checkout', { projectId, branch, expectedHead, expectedBranch: g?.currentBranch ?? '' });
    await afterWrite(projectId, 'git.checkout', `已切换到 ${branch}`);
  } catch (e) { gitFail(projectId, 'git.checkout', e); }
}

export async function createBranch(projectId: string, name: string): Promise<void> {
  try {
    const g = getGit(projectId);
    const expectedHead = g?.commits[0]?.hash ?? null;
    await command('git.branch.create', { projectId, name, expectedHead });
    await afterWrite(projectId, 'git.branch.create', `已创建分支 ${name}`);
  } catch (e) { gitFail(projectId, 'git.branch.create', e); }
}

export async function undoLastCommit(projectId: string): Promise<void> {
  try {
    await command('git.commit.undo', { projectId });
    await afterWrite(projectId, 'git.commit.undo', '已撤销最近一次本产品提交（保留工作区内容）');
  } catch (e) { gitFail(projectId, 'git.commit.undo', e); }
}

/* ---------- 提交 diff（选父 OID 绑定——R62 合同） ---------- */

export async function loadCommitDiff(projectId: string, oid: string, parentOid?: string): Promise<{
  commit: { oid: string; parents: string[]; subject: string; authorName: string; authorEmail: string; timestamp: number; taskIds: string[]; changeSetIds: string[] };
  parentsMeta?: Array<{ oid: string; short: string; subject: string; timestamp: number }>;
  comparedParent?: string;
  patches: Array<{ path: string; oldPath?: string; change: string; binary: boolean; truncated: boolean; text: string }>;
  mergeNote?: string;
}> {
  return command('git.commitDiff', { projectId, oid, ...(parentOid != null ? { parentOid } : {}) });
}

function gitFail(projectId: string, op: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  setState((s) => ({ ...s, git: { ...s.git, [projectId]: { ...(s.git[projectId] ?? emptyGit()), lastOp: { op, ok: false, detail: msg, at: Date.now() } } } }));
  toast(`${op} 失败：${msg}`, 'error');
}
