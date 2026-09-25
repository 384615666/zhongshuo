/**
 * Git 页（用户要求「加 git」，完整客户端口径）。
 *
 * 定位：不是一个通用 Git 客户端，而是**把 Git 接到协作流程上**。
 * 差异点在于每条提交都能回答"哪个任务改的、哪个改动集、谁批准的"，
 * 而通用客户端没有这些信息。
 *
 * 界面分区（左侧导航 + 右侧内容，与「文件与改动」一致）：
 *   工作区 / 历史 / 分支与远端 / 变更集（与「文件与改动」同一批数据）
 *
 * 三条底线在本页必须可见，不能被藏起来：
 *   1. 你自己的未提交改动不会被顺手提交（§14.2）——单独分组，批量暂存默认跳过
 *   2. 冲突不提供"一键全部用某边覆盖"，只给三方内容（§14.2）
 *   3. agent 产出的提交用 `agent 提交` 标注事实（authoredBy），不隐含审批状态；
 *      是否需要人工验收由任务交付决定（§10.5 v1.12），commit 不是验收单位
 */

import { useState } from 'react';
import { Icon } from '../components/Icon';
import { DiffView } from '../components/DiffView';
import { EmptyState, Modal, Tag } from '../components/ui';
import { useStore } from '../data/store';
import {
  checkoutBranch, commit, createBranch, pull, push, resolveConflict,
  setCommitMessage, stageByOwner, stageFile, undoLastCommit, unstageAll, unstageFile,
} from '../data/actions-git';
import { fullTime, relTime } from '../lib/format';
import { navigate } from '../lib/router';
import type { GitStatusEntry } from '../data/types';

type GitTab = 'worktree' | 'history' | 'branches';

const STATE_COPY: Record<GitStatusEntry['state'], { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  modified: { label: '修改', tone: 'warning' },
  added: { label: '新增', tone: 'success' },
  deleted: { label: '删除', tone: 'danger' },
  renamed: { label: '重命名', tone: 'info' },
  untracked: { label: '未跟踪', tone: 'neutral' },
  conflicted: { label: '冲突', tone: 'danger' },
};

export function GitPage({ projectId, embedded }: { projectId: string; embedded?: boolean }) {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === projectId);
  const git = s.git[projectId];
  const [tab, setTab] = useState<GitTab>('worktree');
  const [branchModal, setBranchModal] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [manualText, setManualText] = useState('');
  const [openCommit, setOpenCommit] = useState<string | null>(null);

  /* ---- 非 Git 目录：如实说明，不假装能用 ----
     §17.7 第 4 条：Git 标签显示"尚未初始化 Git"及"返回文件"，
     不自动 git init，也不把空态显示为"已连接仓库"。 */
  if (!project || !git || git.branches.length === 0) {
    const empty = (
      <>
        <EmptyState
          icon="folder"
          title={project?.isGit === false ? '尚未初始化 Git' : '没有 Git 数据'}
          detail="众说不自动 git init，也不会替你在项目里插入配置。你可以自行初始化后回到这里。"
        />
        <div className="panel">
          <div className="panel-title"><Icon name="info" size={13} /> 非 Git 目录下的改动记录仍然完整</div>
          任务改动照旧记录成改动集并支持 diff 与撤销（E15：非 Git 目录用整目录快照做内容级前像）。
          Git 标签只提供版本控制本身的能力，两者互不替代。
          {embedded ? (
            <div className="panel-actions">
              <button className="btn sm" onClick={() => navigate(`/project/${projectId}/files?tab=files`)}>
                <Icon name="file-text" size={12} /> 返回文件
              </button>
            </div>
          ) : (
            <div className="panel-actions">
              <button className="btn sm" onClick={() => navigate(`/project/${projectId}/files?tab=files`)}>
                <Icon name="file-text" size={12} /> 去看文件与改动
              </button>
            </div>
          )}
        </div>
      </>
    );
    // 合页模式：外壳（含"文件/Git"标签）由 FilesGitPage 提供，
    // 这里只返回标签内容，避免出现两层页头。
    if (embedded) return empty;
    return (
      <div className="main">
        <div className="page">
          <div className="page-head">
            <div>
              <div className="page-title">Git</div>
              <div className="page-sub mono">{project?.canonicalPath ?? projectId}</div>
            </div>
          </div>
          {empty}
        </div>
      </div>
    );
  }

  const staged = git.status.filter((e) => e.staged);
  const mine = git.status.filter((e) => !e.staged && !e.userPreExisting && e.state !== 'conflicted');
  const userOwn = git.status.filter((e) => e.userPreExisting);
  const conflicts = git.status.filter((e) => e.state === 'conflicted');
  const branch = git.branches.find((b) => b.isCurrent);
  const conflictEntry = git.status.find((e) => e.path === conflictPath);

  /** 按任务把待提交内容分组：这是本页最有用的视图 */
  const byTask = new Map<string, GitStatusEntry[]>();
  for (const e of mine) {
    const key = e.taskId ?? '__none__';
    byTask.set(key, [...(byTask.get(key) ?? []), e]);
  }

  return (
    <div className={`main${embedded ? ' embedded' : ''}`}>
      {/* 合页模式下，页头由 FilesGitPage 提供（统一的项目名 + 项目选择器 + 两标签），
          这里只保留 Git 自己的状态条与操作按钮，避免出现两套页头。 */}
      <div className="page">
        {embedded ? (
          <div className="row tight wrap" style={{ marginBottom: 12 }}>
            <Tag icon="git-branch">{git.currentBranch}</Tag>
            {branch?.upstream ? (
              <Tag plain title={`与 ${branch.upstream} 的差异`}>
                {branch.ahead > 0 ? `领先 ${branch.ahead}` : branch.behind > 0 ? `落后 ${branch.behind}` : '与远端一致'}
              </Tag>
            ) : (
              <Tag plain icon="info">没有上游分支</Tag>
            )}
            <Tag plain icon="diff">{git.status.length} 个未提交改动</Tag>
            <div className="spacer" />
            <button className="btn sm" onClick={() => pull(projectId)} disabled={!branch || branch.behind === 0}>
              <Icon name="download" size={12} /> 拉取
            </button>
            <button className="btn sm" onClick={() => push(projectId)} disabled={!branch || branch.ahead === 0}>
              <Icon name="upload" size={12} /> 推送 {branch?.ahead ? `(${branch.ahead})` : ''}
            </button>
            <button className="btn sm" onClick={() => setBranchModal(true)}>
              <Icon name="git-branch" size={12} /> 分支
            </button>
          </div>
        ) : (
          <div className="page-head">
            <div>
              <div className="page-title">Git</div>
              <div className="page-sub mono">{project.canonicalPath}</div>
              <div className="row tight wrap" style={{ marginTop: 8 }}>
                <Tag icon="git-branch">{git.currentBranch}</Tag>
                {branch?.upstream ? (
                  <Tag plain title={`与 ${branch.upstream} 的差异`}>
                    {branch.ahead > 0 ? `领先 ${branch.ahead}` : branch.behind > 0 ? `落后 ${branch.behind}` : '与远端一致'}
                  </Tag>
                ) : (
                  <Tag plain icon="info">没有上游分支</Tag>
                )}
                <Tag plain icon="diff">{git.status.length} 个未提交改动</Tag>
              </div>
            </div>
            <div className="page-head-actions">
              <button className="btn sm" onClick={() => pull(projectId)} disabled={!branch || branch.behind === 0}>
                <Icon name="download" size={12} /> 拉取
              </button>
              <button className="btn sm" onClick={() => push(projectId)} disabled={!branch || branch.ahead === 0}>
                <Icon name="upload" size={12} /> 推送 {branch?.ahead ? `(${branch.ahead})` : ''}
              </button>
              <button className="btn sm" onClick={() => setBranchModal(true)}>
                <Icon name="git-branch" size={12} /> 分支
              </button>
            </div>
          </div>
        )}

        {/* 最近一次操作结果：失败不静默（§16.5） */}
        {git.lastOp ? (
          <div className={`panel ${git.lastOp.ok ? '' : 'danger'}`} style={{ marginBottom: 14 }}>
            <div className="panel-title">
              <Icon name={git.lastOp.ok ? 'check-circle' : 'alert-triangle'} size={13} />
              {git.lastOp.op} · {git.lastOp.ok ? '成功' : '失败'}
            </div>
            {git.lastOp.detail}
            <span className="small faint"> · {relTime(git.lastOp.at)}</span>
          </div>
        ) : null}

        <div className="thread-tabs" style={{ marginBottom: 14 }}>
          <button className={`thread-tab${tab === 'worktree' ? ' on' : ''}`} onClick={() => setTab('worktree')}>
            <Icon name="edit" size={13} /> 工作区
            {git.status.length > 0 ? <span className="faint">{git.status.length}</span> : null}
          </button>
          <button className={`thread-tab${tab === 'history' ? ' on' : ''}`} onClick={() => setTab('history')}>
            <Icon name="git-commit" size={13} /> 历史
            <span className="faint">{git.commits.length}</span>
          </button>
          <button className={`thread-tab${tab === 'branches' ? ' on' : ''}`} onClick={() => setTab('branches')}>
            <Icon name="git-branch" size={13} /> 分支与远端
          </button>
        </div>

        {/* ==================== 工作区 ==================== */}
        {tab === 'worktree' ? (
          <>
            {/* 冲突优先，必须挡在提交前面 */}
            {conflicts.length > 0 ? (
              <div className="section">
                <div className="section-title" style={{ color: 'var(--danger)' }}>
                  <Icon name="alert-triangle" size={14} /> 冲突未解决
                  <span className="count">{conflicts.length}</span>
                </div>
                <div className="panel danger">
                  冲突文件不会被提交。众说不提供"全部用某一边覆盖"——冲突时保留三方内容让你逐个看。
                </div>
                {conflicts.map((e) => (
                  <div key={e.path} className="card tight" style={{ marginBottom: 8 }}>
                    <div className="row tight wrap">
                      <Icon name="file-text" size={14} className="faint" />
                      <span className="mono" style={{ fontSize: 12 }}>{e.path}</span>
                      <Tag tone="danger" icon="alert-triangle">冲突</Tag>
                      <div className="spacer" />
                      <button
                        className="btn sm"
                        onClick={() => {
                          setConflictPath(e.path);
                          setManualText(e.conflict?.ours ?? '');
                        }}
                      >
                        查看三方内容
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* 暂存区 */}
            <div className="section">
              <div className="section-title">
                <Icon name="bookmark" size={14} /> 已暂存
                <span className="count">{staged.length}</span>
                <div className="spacer" />
                {staged.length > 0 ? (
                  <button className="btn ghost sm" onClick={() => unstageAll(projectId)}>
                    全部取消暂存
                  </button>
                ) : null}
              </div>
              {staged.length === 0 ? (
                <div className="small faint">暂存区是空的。下面的改动选中后点「暂存」，或用按任务批量暂存。</div>
              ) : (
                staged.map((e) => (
                  <div key={e.path} className="card tight" style={{ marginBottom: 6 }}>
                    <div className="row tight wrap">
                      <span className="mono" style={{ fontSize: 12 }}>{e.path}</span>
                      <Tag tone={STATE_COPY[e.state].tone} icon="check">{STATE_COPY[e.state].label}</Tag>
                      {e.additions > 0 ? <span className="small" style={{ color: 'var(--success)' }}>+{e.additions}</span> : null}
                      {e.deletions > 0 ? <span className="small" style={{ color: 'var(--danger)' }}>−{e.deletions}</span> : null}
                      <div className="spacer" />
                      <button className="btn ghost sm" onClick={() => unstageFile(projectId, e.path)}>
                        取消暂存
                      </button>
                    </div>
                  </div>
                ))
              )}

              {/* 提交信息 */}
              <div className="card" style={{ marginTop: 10 }}>
                <textarea
                  className="composer-input git-commit-input"
                  rows={3}
                  placeholder="提交信息（首行为标题）…"
                  value={git.commitMessage}
                  onChange={(ev) => setCommitMessage(projectId, ev.target.value)}
                />
                <div className="row tight wrap" style={{ marginTop: 8 }}>
                  <span className="small faint">
                    {staged.length === 0
                      ? '暂存区为空，无法提交'
                      : `将提交 ${staged.length} 个文件到 ${git.currentBranch}`}
                  </span>
                  <div className="spacer" />
                  <button
                    className="btn primary sm"
                    disabled={staged.length === 0 || !git.commitMessage.trim() || conflicts.length > 0}
                    title={
                      conflicts.length > 0
                        ? '还有冲突未解决'
                        : staged.length === 0
                          ? '暂存区为空'
                          : !git.commitMessage.trim()
                            ? '提交信息不能为空'
                            : '提交已暂存内容'
                    }
                    onClick={() => commit(projectId)}
                  >
                    <Icon name="git-commit" size={12} /> 提交
                  </button>
                </div>
              </div>
            </div>

            {/* 按任务分组 —— 本页的核心价值 */}
            <div className="section">
              <div className="section-title">
                <Icon name="layers" size={14} /> 待提交改动（按任务归属）
                <span className="count">{mine.length}</span>
              </div>
              {mine.length === 0 ? (
                <div className="small faint">没有待提交的任务改动。</div>
              ) : (
                [...byTask.entries()].map(([taskId, entries]) => {
                  const task = s.tasks.find((t) => t.id === taskId);
                  return (
                    <div key={taskId} className="card" style={{ marginBottom: 10, padding: 0 }}>
                      <div className="row tight wrap" style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)' }}>
                        <Icon name="diff" size={14} className="faint" />
                        <span className="strong" style={{ fontSize: 12 }}>
                          {taskId === '__none__' ? '不属于任何任务' : task ? `#${task.roomTaskNumber} ${task.title}` : taskId}
                        </span>
                        <Tag plain>{entries.length} 个文件</Tag>
                        <div className="spacer" />
                        {taskId !== '__none__' ? (
                          <>
                            <button className="btn ghost sm" onClick={() => stageByOwner(projectId, { taskId })}>
                              暂存本任务改动
                            </button>
                            {task ? (
                              <button
                                className="btn ghost sm"
                                onClick={() => {
                                  const th = s.threads.find((t) => t.id === task.conversationThreadId);
                                  if (th) navigate(`/project/${projectId}/room/${th.roomId}?thread=${th.id}`);
                                }}
                              >
                                回到任务
                              </button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                      {entries.map((e) => (
                        <div key={e.path} className="git-file-row">
                          <div className="row tight wrap">
                            <span className="mono" style={{ fontSize: 12 }}>{e.path}</span>
                            <Tag tone={STATE_COPY[e.state].tone}>{STATE_COPY[e.state].label}</Tag>
                            {e.additions > 0 ? <span className="small" style={{ color: 'var(--success)' }}>+{e.additions}</span> : null}
                            {e.deletions > 0 ? <span className="small" style={{ color: 'var(--danger)' }}>−{e.deletions}</span> : null}
                            {e.changeSetId ? <Tag plain icon="layers">改动集</Tag> : null}
                            <div className="spacer" />
                            <button className="btn ghost sm" onClick={() => stageFile(projectId, e.path)}>暂存</button>
                          </div>
                          {e.diff.length > 0 ? <DiffView hunks={e.diff} /> : (
                            <div className="small faint" style={{ padding: '6px 12px' }}>
                              该文件没有可展示的文本 diff（二进制、大文件或超过前像上限）。
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </div>

            {/* 用户自己的改动：单独分组，说明不会被顺手提交 */}
            {userOwn.length > 0 ? (
              <div className="section">
                <div className="section-title">
                  <Icon name="user" size={14} /> 你自己的未提交改动
                  <span className="count">{userOwn.length}</span>
                </div>
                <div className="panel warning">
                  <div className="panel-title"><Icon name="shield-off" size={13} /> 不属于任何任务</div>
                  这些文件在本产品介入前就有未提交内容。众说不会 stash、reset 或自动提交它们，
                  按任务批量暂存也会默认跳过。你要提交的话需要显式勾选。
                </div>
                {userOwn.map((e) => (
                  <div key={e.path} className="card tight" style={{ marginBottom: 6 }}>
                    <div className="row tight wrap">
                      <span className="mono" style={{ fontSize: 12 }}>{e.path}</span>
                      <Tag tone="warning" icon="user">你自己的改动</Tag>
                      <div className="spacer" />
                      <button className="btn ghost sm" onClick={() => stageFile(projectId, e.path)}>暂存这个文件</button>
                    </div>
                    {e.diff.length > 0 ? <DiffView hunks={e.diff} /> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {/* ==================== 历史 ==================== */}
        {tab === 'history' ? (
          <>
            {/* v1.12 §10.5：原来是"有 agent 提交等你审阅"队列（commit 级审批）。
                已移除 —— 验收只属于任务交付，Git 页不做审批中心。
                这里改为说明两者关系，避免用户以为提交被静默当成成果。 */}
            <div className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-title"><Icon name="info" size={13} /> Git 提交与任务验收是两件事</div>
              提交只表示"内容进入了版本历史"；任务是否通过验收由任务交付单独记录。
              标记为 agent 作者只说明来源，<strong>不构成审阅结论</strong>，也不会因为某个提交属于某任务就整体打勾。
            </div>

            {git.commits.length === 0 ? (
              <EmptyState icon="git-commit" title="还没有提交" detail="这个仓库还没有任何提交记录。" />
            ) : (
              git.commits.map((c) => (
                <div key={c.hash} className="card" style={{ marginBottom: 10, padding: 0 }}>
                  <div className="row tight wrap" style={{ padding: '10px 12px' }}>
                    <Icon name="git-commit" size={14} className="faint" />
                    <span className="strong" style={{ fontSize: 12.5 }}>{c.subject}</span>
                    {/* 不再显示提交级「待审阅」：验收属于任务交付，不属于单个 commit */}
                    {c.authoredBy === 'agent' ? (
                      <Tag tone="info" icon="cpu">agent 提交</Tag>
                    ) : null}
                    {c.refs.filter((r) => r !== 'HEAD').map((r) => (
                      <Tag key={r} plain icon="git-branch">{r}</Tag>
                    ))}
                    <div className="spacer" />
                    <span className="mono-sm faint">{c.shortHash}</span>
                  </div>

                  <div className="row tight wrap small faint" style={{ padding: '0 12px 8px' }}>
                    <span>{c.authorName}</span>
                    <span>{fullTime(c.committedAt)}</span>
                    <span>{c.files.length} 个文件</span>
                    {/* 与任务的关联：通用 Git 客户端没有这一层 */}
                    {c.taskId ? (
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          const t = s.tasks.find((x) => x.id === c.taskId);
                          const th = t ? s.threads.find((x) => x.id === t.conversationThreadId) : undefined;
                          if (th) navigate(`/project/${projectId}/room/${th.roomId}?thread=${th.id}`);
                        }}
                      >
                        <Icon name="corner-down-right" size={11} /> 来自任务
                        {(() => {
                          const t = s.tasks.find((x) => x.id === c.taskId);
                          return t ? ` #${t.roomTaskNumber}` : '';
                        })()}
                      </button>
                    ) : null}
                    {c.changeSetId ? <Tag plain icon="layers">关联改动集</Tag> : null}
                    <div className="spacer" />
                    <button className="btn ghost sm" onClick={() => setOpenCommit(openCommit === c.hash ? null : c.hash)}>
                      {openCommit === c.hash ? '收起 diff' : '查看 diff'}
                    </button>
                  </div>

                  {/* v1.12 §10.5：**移除「验收这个提交」与 commit 专属审阅队列**。
                      原因：一次用户任务的交付可能包含多个 commit，按 commit 逐个验收
                      会造出多条待办，而用户只该对"这一次交付"做一个决定；
                      而且"退回提交"很容易被实现成软回退，与 §14.5 的撤销语义混淆。
                      现在这里只**如实展示关联交付的状态**，决定一律去交付详情做。
                      注意：既不显示"已审阅"勾（不能只凭 taskId 就给整个 commit 打勾，
                      §10.5 第 8 条），也不因为任务在 REVIEW 就禁用 Git 操作。 */}
                  {(() => {
                    const delivery = c.taskId
                      ? s.taskDeliveries.find((d) => d.taskId === c.taskId && d.status === 'pending')
                        ?? s.taskDeliveries.find((d) => d.taskId === c.taskId && d.revision === Math.max(
                          ...s.taskDeliveries.filter((x) => x.taskId === c.taskId).map((x) => x.revision),
                        ))
                      : undefined;
                    if (!delivery) return null;
                    const label =
                      delivery.status === 'pending' ? '关联交付待验收'
                        : delivery.status === 'accepted' ? '关联交付已验收'
                          : delivery.status === 'changes_requested' ? '关联交付已要求修改'
                            : '关联交付无需验收';
                    const tone =
                      delivery.status === 'pending' ? 'warning'
                        : delivery.status === 'accepted' ? 'success'
                          : delivery.status === 'changes_requested' ? 'danger' : 'neutral';
                    return (
                      <div className="row tight wrap" style={{ padding: '0 12px 10px' }}>
                        <Tag tone={tone} icon={delivery.status === 'pending' ? 'eye' : 'info'} title="提交归属的交付状态；验收针对整个交付，不针对单个提交">
                          {label}
                        </Tag>
                        <button
                          className="btn ghost sm"
                          onClick={() => {
                            const task = s.tasks.find((x) => x.id === c.taskId);
                            const thread = task ? s.threads.find((x) => x.id === task.conversationThreadId) : undefined;
                            if (thread) navigate(`/project/${projectId}/room/${thread.roomId}?thread=${thread.id}&tab=delivery`);
                          }}
                          title="去任务交付详情查看与决定；Git 页不承担审批"
                        >
                          <Icon name="corner-down-right" size={11} /> 查看交付详情
                        </button>
                      </div>
                    );
                  })()}

                  {openCommit === c.hash ? (
                    c.files.length === 0 ? (
                      <div className="small faint" style={{ padding: '0 12px 12px' }}>该提交没有文件改动（空提交）。</div>
                    ) : (
                      c.files.map((f) => (
                        <div key={f.path}>
                          <div className="row tight wrap" style={{ padding: '6px 12px', borderTop: '1px solid var(--border)' }}>
                            <span className="mono" style={{ fontSize: 11.5 }}>{f.path}</span>
                            <Tag tone={f.change === 'added' ? 'success' : f.change === 'deleted' ? 'danger' : 'warning'}>
                              {f.change === 'added' ? '新增' : f.change === 'deleted' ? '删除' : f.change === 'renamed' ? '重命名' : '修改'}
                            </Tag>
                            {f.additions > 0 ? <span className="small" style={{ color: 'var(--success)' }}>+{f.additions}</span> : null}
                            {f.deletions > 0 ? <span className="small" style={{ color: 'var(--danger)' }}>−{f.deletions}</span> : null}
                          </div>
                          {f.diff.length > 0 ? <DiffView hunks={f.diff} /> : (
                            <div className="small faint" style={{ padding: '4px 12px 8px' }}>无文本 diff。</div>
                          )}
                        </div>
                      ))
                    )
                  ) : null}
                </div>
              ))
            )}

            {/* reflog：撤销提交的入口 */}
            <div className="section">
              <div className="section-title"><Icon name="clock" size={14} /> 最近操作（reflog）</div>
              {git.reflog.slice(0, 8).map((r, i) => (
                <div key={i} className="row tight wrap small" style={{ marginBottom: 4 }}>
                  <span className="mono-sm faint">{r.op}</span>
                  <span className="mono-sm">{r.ref}</span>
                  <span className="faint">{r.detail}</span>
                  <span className="spacer" />
                  <span className="faint">{relTime(r.at)}</span>
                </div>
              ))}
              <div className="panel" style={{ marginTop: 10 }}>
                <div className="panel-title"><Icon name="info" size={13} /> 撤销提交是软回退</div>
                众说不用 <code>git reset --hard</code>、不强制 checkout、不删除你的项目文件。
                撤销后提交内容回到工作区，一个文件都不会丢。
                <div className="panel-actions">
                  <button className="btn sm" onClick={() => undoLastCommit(projectId)} disabled={git.commits.length === 0}>
                    <Icon name="corner-up-left" size={12} /> 撤销最近一次提交
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}

        {/* ==================== 分支与远端 ==================== */}
        {tab === 'branches' ? (
          <>
            <div className="section">
              <div className="section-title">
                <Icon name="git-branch" size={14} /> 分支
                <span className="count">{git.branches.length}</span>
                <div className="spacer" />
                {/* 「新建分支」是分支区唯一的创建动作，此前是 ghost（无底无框），
                    在 Git 页 primary 0 的审计结果里被漏掉。按 §5.8 升为主按钮。 */}
                <button className="btn primary sm" onClick={() => setBranchModal(true)}>
                  <Icon name="plus" size={12} /> 新建分支
                </button>
              </div>
              {git.branches.map((b) => (
                <div key={b.name} className="card tight" style={{ marginBottom: 8 }}>
                  <div className="row tight wrap">
                    <Icon name={b.isCurrent ? 'check-circle' : 'git-branch'} size={14} className={b.isCurrent ? '' : 'faint'} />
                    <span className="strong" style={{ fontSize: 12 }}>{b.name}</span>
                    {b.isCurrent ? <Tag tone="info">当前分支</Tag> : null}
                    {b.createdByZhongshuo ? <Tag plain icon="cpu">众说创建的隔离分支</Tag> : null}
                    <div className="spacer" />
                    {!b.isCurrent ? (
                      <button className="btn ghost sm" onClick={() => checkoutBranch(projectId, b.name)}>切换</button>
                    ) : null}
                  </div>
                  <div className="row tight wrap small faint" style={{ marginTop: 6 }}>
                    <span className="mono-sm">{b.head}</span>
                    {b.upstream ? <span>上游 {b.upstream}</span> : <span>没有上游</span>}
                    {b.ahead > 0 ? <span>领先 {b.ahead}</span> : null}
                    {b.behind > 0 ? <span>落后 {b.behind}</span> : null}
                    <span>{relTime(b.updatedAt)}</span>
                  </div>
                </div>
              ))}
              <div className="small faint" style={{ marginTop: 6 }}>
                切换分支不会替你 stash 未提交改动——它们会跟着过去。这是如实反映 Git 行为，不是保护你。
              </div>
            </div>

            <div className="section">
              <div className="section-title"><Icon name="upload" size={14} /> 远端</div>
              {git.remotes.length === 0 ? (
                <div className="small faint">没有配置远端。</div>
              ) : (
                git.remotes.map((r) => (
                  <div key={r.name} className="card tight" style={{ marginBottom: 8 }}>
                    <div className="row tight wrap">
                      <Icon name="power" size={14} className="faint" />
                      <span className="strong" style={{ fontSize: 12 }}>{r.name}</span>
                      <span className="mono-sm faint">{r.url}</span>
                      <div className="spacer" />
                      {/* 凭据状态如实显示：缺失就不假装能推送（AUTH_REQUIRED） */}
                      <Tag
                        tone={r.authState === 'ok' ? 'success' : r.authState === 'expired' ? 'warning' : 'danger'}
                        icon={r.authState === 'ok' ? 'check-circle' : 'alert-triangle'}
                      >
                        {r.authState === 'ok' ? '凭据可用' : r.authState === 'expired' ? '凭据已过期' : '缺少凭据'}
                      </Tag>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : null}
      </div>

      {/* 新建分支 */}
      {branchModal ? (
        <Modal
          size="sm"
          title="新建分支"
          subtitle="基于当前分支的 HEAD 创建并立即切换"
          onClose={() => setBranchModal(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setBranchModal(false)}>取消</button>
              <button
                className="btn primary"
                disabled={!branchName.trim()}
                onClick={() => {
                  createBranch(projectId, branchName);
                  setBranchName('');
                  setBranchModal(false);
                }}
              >
                创建并切换
              </button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">分支名</span>
            <input
              className="input"
              placeholder="例如 zs/task-15-refactor"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
            />
          </label>
          <div className="small faint" style={{ marginTop: 8 }}>
            基于 <span className="mono-sm">{git.commits[0]?.shortHash ?? '(空仓库)'}</span> 创建。
            工作区未提交改动会一并带入。
          </div>
        </Modal>
      ) : null}

      {/* 冲突三方内容：不提供一键全选覆盖 */}
      {conflictEntry?.conflict ? (
        <Modal
          size="md"
          title="解决冲突"
          subtitle={conflictEntry.path}
          onClose={() => setConflictPath(null)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setConflictPath(null)}>稍后处理</button>
              <button
                className="btn primary"
                onClick={() => {
                  resolveConflict(projectId, conflictEntry.path, 'manual', manualText);
                  setConflictPath(null);
                }}
              >
                用编辑后的内容解决
              </button>
            </>
          }
        >
          <div className="panel warning" style={{ marginBottom: 12 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 这里不提供「全部保留我的」按钮</div>
            冲突意味着归属不明确。众说停止自动应用，把三方内容摊开让你判断，
            而不是替你选一边。
          </div>

          <div className="section">
            <div className="section-title">共同祖先（base）</div>
            <pre className="conflict-pre">{conflictEntry.conflict.base}</pre>
          </div>
          <div className="section">
            <div className="section-title">
              我的版本（ours）
              <div className="spacer" />
              <button className="btn ghost sm" onClick={() => setManualText(conflictEntry.conflict!.ours)}>用这个</button>
            </div>
            <pre className="conflict-pre">{conflictEntry.conflict.ours}</pre>
          </div>
          <div className="section">
            <div className="section-title">
              对方版本（theirs）
              <div className="spacer" />
              <button className="btn ghost sm" onClick={() => setManualText(conflictEntry.conflict!.theirs)}>用这个</button>
            </div>
            <pre className="conflict-pre">{conflictEntry.conflict.theirs}</pre>
          </div>

          <div className="section">
            <div className="section-title">解决后的内容</div>
            <textarea
              className="composer-input"
              rows={3}
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
            />
            <div className="small faint" style={{ marginTop: 6 }}>
              解决后进入暂存区，确认无误再提交。
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
