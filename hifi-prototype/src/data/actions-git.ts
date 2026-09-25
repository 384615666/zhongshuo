/**
 * Git 写操作（内存）。
 *
 * 命令名：`git.*` 为本次新增命令面，已同步写入设计文档 §15.2（v1.9 第十三批）。
 * 在文档补齐之前一律不静默改文件——原型里改的是内存状态。
 *
 * 三条不能违反的底线（来自 §14.2 / §14.5，本次修订后依然成立）：
 *  1. **不 stash / reset / 自动提交用户原有改动**：`docs/README.md` 这类
 *     userPreExisting 的文件，在"暂存本任务改动"时绝不能被顺带暂存。
 *  2. **不做 reset --hard / 强制 checkout**：撤销提交走 reflog 软回退，
 *     保留工作区内容，不删除用户的项目文件。
 *  3. **agent 的提交不静默生效**：验收单位是**任务交付**（§10.5 v1.12），
 *     不是单个 commit。agent 产出的 commit 用 `authoredBy:'agent'` 标注事实，
 *     是否需要人工确认由该任务所属项目的 taskReviewEnabled 决定；
 *     commit 级 pendingReview 审批队列已取消，不要再加回来。
 */

import { getState, setState, recordWrite, recordLocalOnly, toast } from './store';
import type { GitState, GitStatusEntry, GitCommit, DiffHunk } from './types';

const now = () => Date.now();

/** 生成一个像样的短哈希（原型用，非真实 SHA-1） */
function fakeHash(): { hash: string; shortHash: string } {
  const hex = '0123456789abcdef';
  let full = '';
  for (let i = 0; i < 40; i++) full += hex[Math.floor(Math.random() * 16)];
  return { hash: full, shortHash: full.slice(0, 7) };
}

function patchGit(projectId: string, updater: (g: GitState) => GitState) {
  setState((s) => {
    const g = s.git[projectId];
    if (!g) return s;
    return { ...s, git: { ...s.git, [projectId]: updater(g) } };
  });
}

export function getGit(projectId: string): GitState | undefined {
  return getState().git[projectId];
}

/* ============================================================
   git.stage / git.unstage
   ============================================================ */

/**
 * 暂存单个文件。
 * 用户可以暂存任何文件（包括自己的改动）——这是显式操作，不算"自动提交用户改动"。
 */
export function stageFile(projectId: string, path: string) {
  patchGit(projectId, (g) => ({
    ...g,
    status: g.status.map((e) => (e.path === path ? { ...e, staged: true } : e)),
  }));
  recordWrite('git.stage', `project=${projectId} path=${path} → 已暂存`);
}

export function unstageFile(projectId: string, path: string) {
  patchGit(projectId, (g) => ({
    ...g,
    status: g.status.map((e) => (e.path === path ? { ...e, staged: false } : e)),
  }));
  recordWrite('git.stage', `project=${projectId} path=${path} unstaged → 已取消暂存`);
}

/**
 * 按归属批量暂存。
 *
 * 这是本页相对通用 Git 客户端最有用的一件事：能只暂存"某个任务改的"或
 * "某个改动集改的"，而把用户自己的改动留在工作区。
 *
 * `onlyTaskId` / `onlyChangeSetId` 为空时表示"全部"，但**仍然排除**
 * userPreExisting 的文件——§14.2 明确禁止把它们混进 agent 的提交里。
 */
export function stageByOwner(
  projectId: string,
  filter: { taskId?: string; changeSetId?: string; includeUserChanges?: boolean },
) {
  const g = getGit(projectId);
  if (!g) return;

  const matches = (e: GitStatusEntry) => {
    if (e.state === 'conflicted') return false; // 冲突必须先解决，不能直接提交
    if (filter.taskId && e.taskId !== filter.taskId) return false;
    if (filter.changeSetId && e.changeSetId !== filter.changeSetId) return false;
    // §14.2：用户原有改动不进批量暂存
    if (e.userPreExisting && !filter.includeUserChanges) return false;
    return true;
  };

  const hit = g.status.filter(matches);
  if (hit.length === 0) {
    toast('没有可暂存的改动（冲突文件需先解决）', 'warn');
    return;
  }

  patchGit(projectId, (s) => ({
    ...s,
    status: s.status.map((e) => (matches(e) ? { ...e, staged: true } : e)),
  }));

  const skippedUser = g.status.filter((e) => e.userPreExisting && !e.staged).length;
  const skippedConflict = g.status.filter((e) => e.state === 'conflicted').length;
  recordWrite(
    'git.stage',
    `project=${projectId} ${filter.taskId ? `task=${filter.taskId} ` : ''}${filter.changeSetId ? `changeSet=${filter.changeSetId} ` : ''}→ 暂存 ${hit.length} 个文件；跳过用户原有改动 ${skippedUser} 个、冲突 ${skippedConflict} 个`,
  );
  toast(
    `已暂存 ${hit.length} 个文件${skippedUser > 0 ? `；跳过你自己原有的 ${skippedUser} 个改动` : ''}${skippedConflict > 0 ? `；${skippedConflict} 个冲突待解决` : ''}`,
    'success',
  );
}

export function unstageAll(projectId: string) {
  patchGit(projectId, (g) => ({ ...g, status: g.status.map((e) => ({ ...e, staged: false })) }));
  recordWrite('git.stage', `project=${projectId} → 全部取消暂存`);
}

/* ============================================================
   git.commit
   ============================================================ */

export function setCommitMessage(projectId: string, message: string) {
  patchGit(projectId, (g) => ({ ...g, commitMessage: message }));
}

/**
 * 提交已暂存内容。
 *
 * 注意：**不改 ChangeSet 状态**。ChangeSet 记录的是"改动是否已应用到原目录"
 * （§14.3），提交是 Git 层的事实，两者是不同维度，不能互相冒充。
 */
export function commit(projectId: string) {
  const g = getGit(projectId);
  if (!g) return;

  const staged = g.status.filter((e) => e.staged);
  if (staged.length === 0) {
    toast('没有已暂存的内容，先暂存再提交', 'warn');
    return;
  }
  if (!g.commitMessage.trim()) {
    toast('提交信息不能为空', 'warn');
    return;
  }
  const conflicted = g.status.filter((e) => e.state === 'conflicted');
  if (conflicted.length > 0) {
    toast(`还有 ${conflicted.length} 个冲突未解决，解决后才能提交`, 'error');
    return;
  }

  const { hash, shortHash } = fakeHash();
  const head = g.commits[0];
  const msg = g.commitMessage.trim();
  const [subject, ...rest] = msg.split('\n');

  const newCommit: GitCommit = {
    hash,
    shortHash,
    subject,
    body: rest.join('\n').trim() || undefined,
    authorName: '你',
    authorEmail: 'you@local',
    authoredBy: 'human',
    committedAt: now(),
    parents: head ? [head.hash] : [],
    refs: ['HEAD', g.currentBranch],
    files: staged.map((e) => ({
      path: e.path,
      change:
        e.state === 'untracked' || e.state === 'added'
          ? 'added'
          : e.state === 'deleted'
            ? 'deleted'
            : e.state === 'renamed'
              ? 'renamed'
              : 'modified',
      additions: e.additions,
      deletions: e.deletions,
      diff: e.diff,
    })),
    changeSetId: staged.find((e) => e.changeSetId)?.changeSetId,
    taskId: staged.find((e) => e.taskId)?.taskId,
  };

  patchGit(projectId, (s) => ({
    ...s,
    commits: [newCommit, ...s.commits],
    // 已提交的文件离开工作区
    status: s.status.filter((e) => !e.staged),
    commitMessage: '',
    branches: s.branches.map((b) =>
      b.isCurrent ? { ...b, head: hash, ahead: b.ahead + 1, updatedAt: now() } : b,
    ),
    reflog: [{ at: now(), op: 'commit', ref: shortHash, detail: subject }, ...s.reflog],
    lastOp: { op: 'git.commit', ok: true, detail: `${shortHash} ${subject}`, at: now() },
  }));

  recordWrite(
    'git.commit',
    `project=${projectId} branch=${g.currentBranch} → ${shortHash}（${staged.length} 个文件）${newCommit.taskId ? ` task=${newCommit.taskId}` : ''}`,
  );
  toast(`已提交 ${shortHash}：${subject}`, 'success');
}

/**
 * 撤销最近一次提交（reflog 软回退）。
 *
 * 刻意**不做** `git reset --hard`（§14.5 明确排除）：
 * 提交内容退回工作区，文件一个都不删。
 */
export function undoLastCommit(projectId: string) {
  const g = getGit(projectId);
  if (!g || g.commits.length === 0) return;
  const head = g.commits[0];
  if (head.parents.length === 0) {
    toast('这是首个提交，撤销会丢失全部历史，已阻止', 'error');
    return;
  }

  patchGit(projectId, (s) => ({
    ...s,
    commits: s.commits.slice(1),
    // 软回退：内容回到工作区且保持已暂存，文件不删
    status: [
      ...head.files.map((f) => ({
        path: f.path,
        state: (f.change === 'added' ? 'untracked' : f.change === 'deleted' ? 'deleted' : 'modified') as GitStatusEntry['state'],
        staged: true,
        additions: f.additions,
        deletions: f.deletions,
        diff: f.diff as DiffHunk[],
        taskId: head.taskId,
      })),
      ...s.status,
    ].filter((e, i, arr) => arr.findIndex((x) => x.path === e.path) === i),
    branches: s.branches.map((b) =>
      b.isCurrent ? { ...b, head: head.parents[0].slice(0, 7), ahead: Math.max(0, b.ahead - 1), updatedAt: now() } : b,
    ),
    reflog: [{ at: now(), op: 'reset(soft)', ref: head.shortHash, detail: `撤销提交，内容保留在工作区` }, ...s.reflog],
    lastOp: { op: 'git.commit.undo', ok: true, detail: `已软回退 ${head.shortHash}，内容保留在工作区`, at: now() },
  }));

  recordWrite(
    'git.commit.undo',
    `project=${projectId} → 软回退 ${head.shortHash}；内容是回到工作区，不是删除（不做 reset --hard，§14.5）`,
  );
  toast(`已撤销提交 ${head.shortHash}：内容回到工作区，文件未删除`, 'success');
}

/* ============================================================
   git.push / git.pull / git.fetch
   ============================================================ */

export function push(projectId: string, remoteName = 'origin') {
  const g = getGit(projectId);
  if (!g) return;
  const remote = g.remotes.find((r) => r.name === remoteName);
  if (!remote) {
    toast(`找不到远端 ${remoteName}`, 'error');
    return;
  }
  // 凭据缺失时不假装成功（§16.5 AUTH_REQUIRED 口径）
  if (remote.authState !== 'ok') {
    patchGit(projectId, (s) => ({
      ...s,
      lastOp: {
        op: 'git.push',
        ok: false,
        detail: `AUTH_REQUIRED：远端 ${remoteName} 没有可用凭据，推送未执行`,
        at: now(),
      },
    }));
    recordWrite('git.push', `project=${projectId} remote=${remoteName} → AUTH_REQUIRED（未执行）`);
    toast(`推送失败：远端 ${remoteName} 未配置凭据。任务已保留，配置后可重试`, 'error');
    return;
  }
  if (g.branches.find((b) => b.isCurrent)?.ahead === 0) {
    toast('没有需要推送的提交', 'info');
    return;
  }

  const branch = g.branches.find((b) => b.isCurrent);
  const n = branch?.ahead ?? 0;
  patchGit(projectId, (s) => ({
    ...s,
    branches: s.branches.map((b) => (b.isCurrent ? { ...b, ahead: 0, upstream: b.upstream ?? `origin/${b.name}` } : b)),
    lastOp: { op: 'git.push', ok: true, detail: `已推送 ${n} 个提交到 ${remoteName}/${branch?.name}`, at: now() },
  }));
  recordWrite('git.push', `project=${projectId} remote=${remoteName} branch=${branch?.name} → 推送 ${n} 个提交`);
  toast(`已推送 ${n} 个提交到 ${remoteName}/${branch?.name}`, 'success');
}

export function pull(projectId: string, remoteName = 'origin') {
  const g = getGit(projectId);
  if (!g) return;
  const branch = g.branches.find((b) => b.isCurrent);
  if (!branch) return;

  const remote = g.remotes.find((r) => r.name === remoteName);
  if (!remote) {
    toast(`找不到远端 ${remoteName}`, 'error');
    return;
  }
  // 与 push 同一口径：凭据不可用时不假装成功
  if (remote.authState !== 'ok') {
    patchGit(projectId, (s) => ({
      ...s,
      lastOp: {
        op: 'git.pull',
        ok: false,
        detail: `AUTH_REQUIRED：远端 ${remoteName} 没有可用凭据，拉取未执行`,
        at: now(),
      },
    }));
    recordWrite('git.pull', `project=${projectId} remote=${remoteName} → AUTH_REQUIRED（未执行）`);
    toast(`拉取失败：远端 ${remoteName} 未配置凭据`, 'error');
    return;
  }

  if (branch.behind === 0) {
    toast('已经是最新，无需拉取', 'info');
    return;
  }

  const n = branch.behind;
  patchGit(projectId, (s) => ({
    ...s,
    branches: s.branches.map((b) => (b.isCurrent ? { ...b, behind: 0 } : b)),
    lastOp: {
      op: 'git.pull',
      ok: true,
      detail: `从 ${remoteName} 快进合并 ${n} 个提交；未 stash / reset 用户改动（§14.2）`,
      at: now(),
    },
    reflog: [{ at: now(), op: 'pull', ref: branch.head, detail: `从 ${remoteName} 快进合并 ${n} 个提交` }, ...s.reflog],
  }));
  recordWrite(
    'git.pull',
    `project=${projectId} remote=${remoteName} branch=${branch.name} → 快进 ${n} 个提交；未改动用户未提交内容（§14.2）`,
  );
  toast(`已从 ${remoteName} 拉取 ${n} 个提交。你的未提交改动没有被 stash 或覆盖`, 'success');
}

/* ============================================================
   git.branch.*
   ============================================================ */

export function checkoutBranch(projectId: string, name: string) {
  const g = getGit(projectId);
  if (!g) return;
  const target = g.branches.find((b) => b.name === name);
  if (!target) {
    toast(`找不到分支 ${name}`, 'error');
    return;
  }
  if (target.isCurrent) return;

  // 有未提交改动时如实说明会影响范围，而不是假装可以随便切
  const dirty = g.status.filter((e) => e.staged || e.state === 'modified' || e.state === 'untracked');
  patchGit(projectId, (s) => ({
    ...s,
    currentBranch: name,
    branches: s.branches.map((b) => ({ ...b, isCurrent: b.name === name })),
    reflog: [{ at: now(), op: 'checkout', ref: name, detail: `切到 ${name}` }, ...s.reflog],
    lastOp: {
      op: 'git.checkout',
      ok: true,
      detail: dirty.length > 0
        ? `已切到 ${name}；${dirty.length} 个未提交改动随之带入（未 stash）`
        : `已切到 ${name}`,
      at: now(),
    },
  }));
  recordWrite('git.checkout', `project=${projectId} → ${name}${dirty.length > 0 ? `；带入 ${dirty.length} 个未提交改动` : ''}`);
  toast(
    dirty.length > 0
      ? `已切到 ${name}。${dirty.length} 个未提交改动会跟着过去——原型不替你 stash`
      : `已切到分支 ${name}`,
    'success',
  );
}

export function createBranch(projectId: string, name: string) {
  const g = getGit(projectId);
  if (!g) return;
  const trimmed = name.trim();
  if (!trimmed) {
    toast('分支名不能为空', 'warn');
    return;
  }
  if (g.branches.some((b) => b.name === trimmed)) {
    toast(`分支 ${trimmed} 已存在`, 'error');
    return;
  }
  if (/[\s~^:?*[\\]/.test(trimmed)) {
    toast('分支名不能包含空格或 ~ ^ : ? * [ \\ 等字符', 'error');
    return;
  }

  const head = g.commits[0];
  patchGit(projectId, (s) => ({
    ...s,
    currentBranch: trimmed,
    branches: [
      ...s.branches.map((b) => ({ ...b, isCurrent: false })),
      {
        name: trimmed,
        head: head?.shortHash ?? '',
        ahead: 0,
        behind: 0,
        isCurrent: true,
        createdByZhongshuo: true,
        updatedAt: now(),
      },
    ],
    reflog: [{ at: now(), op: 'branch', ref: trimmed, detail: `从 ${head?.shortHash ?? '(空仓库)'} 创建` }, ...s.reflog],
  }));
  recordWrite('git.branch.create', `project=${projectId} → ${trimmed}（基于 ${head?.shortHash ?? '空仓库'}）`);
  toast(`已创建并切到分支 ${trimmed}`, 'success');
}

/* ============================================================
   git.conflict.resolve
   ============================================================ */

/**
 * 解决冲突。
 * 提供三方内容供用户选，**不提供"一键用某一边覆盖全部"**——
 * §14.2 要求冲突时停止自动应用并保留三方内容。
 */
export function resolveConflict(projectId: string, path: string, choice: 'ours' | 'theirs' | 'manual', manual?: string) {
  const g = getGit(projectId);
  const entry = g?.status.find((e) => e.path === path);
  if (!entry?.conflict) return;

  const resolved =
    choice === 'ours' ? entry.conflict.ours : choice === 'theirs' ? entry.conflict.theirs : manual ?? '';

  patchGit(projectId, (s) => ({
    ...s,
    status: s.status.map((e) => {
      if (e.path !== path) return e;
      const { conflict: _drop, ...rest } = e;
      const lines = resolved.split('\n');
      return {
        ...rest,
        state: 'modified' as const,
        // 解决后进入暂存区，等用户确认提交
        staged: true,
        additions: lines.length,
        deletions: 0,
        diff: [
          {
            header: `@@ -1,${lines.length} +1,${lines.length} @@`,
            lines: lines.map((t, i) => ({ type: 'add' as const, text: t, newNo: i + 1 })),
          },
        ],
      };
    }),
    lastOp: {
      op: 'git.conflict.resolve',
      ok: true,
      detail: `${path} 已按「${choice === 'ours' ? '保留我的' : choice === 'theirs' ? '采用对方' : '手动编辑'}」解决并暂存`,
      at: now(),
    },
  }));

  recordWrite(
    'git.conflict.resolve',
    `project=${projectId} path=${path} choice=${choice} → 已解决并暂存（保留三方内容，未做自动覆盖）`,
  );
  toast(`${path} 冲突已解决并暂存，确认无误后再提交`, 'success');
}

/* ============================================================
   git.reviewCommit —— 【v1.12 已废止】
   ============================================================ */

/**
 * 已废止：commit 级验收（v1.12 §10.5 / 第十五批命令面变更）。
 *
 * 为什么废止：一次用户任务的交付可能包含多个 commit，按 commit 逐个验收会
 * 造出多条待办；且"退回提交"极易被实现成软回退，与 §14.5 的撤销语义混淆。
 * 验收现在只属于 **TaskDelivery**，走 `task.delivery.review`。
 *
 * 保留这个导出只为兼容旧调用点：它**只返回已废止提示**，
 * 绝不暗中映射成任务验收，也不做 Git 回退（§14.6 明确要求）。
 * 需要撤销提交时，用户走原有的 `undoLastCommit`（reflog 软回退）或自行处理。
 */
export function reviewAgentCommit(_projectId: string, _hash: string, _decision: 'accept' | 'reject') {
  recordLocalOnly(
    'git.reviewCommit（已废止）',
    'commit 级验收已移除；验收请用 task.delivery.review（针对任务交付版本），撤销提交请用 git.commit.undo',
  );
  toast('「验收这个提交」已移除：验收请到任务交付详情进行；撤销提交是独立的 Git 操作', 'warn');
}

/**
 * 把某个改动集"提交到 Git"。
 * 这是 Git 页与「文件与改动」页之间的桥：从改动集一键进入待提交状态。
 */
export function stageChangeSet(projectId: string, changeSetId: string) {
  stageByOwner(projectId, { changeSetId });
}

/* 仅用于原型留痕：查看类操作不产生写 */
export function noteGitRead(projectId: string, what: string) {
  recordLocalOnly('git.read', `project=${projectId} ${what}（只读，不改状态）`);
}
