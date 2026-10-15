/**
 * Git 页（用户要求「加 git」，完整客户端口径）。
 *
 * 定位：不是一个通用 Git 客户端，而是**把 Git 接到协作流程上**。
 * 差异点在于每条提交都能回答"哪个任务改的、哪个改动集、谁批准的"，
 * 而通用客户端没有这些信息。
 *
 * 布局（合页改造后）：**左清单 / 右详情**，与文件页同一副骨架。
 *   左 300px：工作区 / 历史 / 分支与远端 三个视图切换 + 选中列表
 *   右 1fr：当前选中项的详情与 diff
 *
 * 滚动契约（2026-09-26 交互收尾）：
 *   左右两栏**各自一条纵向滚动条**。滚一侧不动另一侧，滚到底也不把外层
 *   页面带着走（overscroll-behavior: contain + 每级 flex 都有 min-height:0）。
 *   右栏只有一个主要滚动容器：准备提交卡常驻顶部（flex:none，不 sticky），
 *   下面是唯一的 .fg-pane-scroll。
 *
 * 三条底线在本页必须可见，不能被藏起来：
 *   1. 你自己的未提交改动不会被顺手提交（§14.2）——单独分组，批量暂存默认跳过，
 *      且那句说明**不跟着折叠收起**
 *   2. 冲突不提供"一键全部用某边覆盖"，只给三方内容（§14.2）
 *   3. agent 产出的提交用 `agent 提交` 标注事实（authoredBy），不隐含审批状态；
 *      是否需要人工验收由任务交付决定（§10.5 v1.12），commit 不是验收单位
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { DiffView } from '../components/DiffView';
import { EmptyState, Segmented, Tag } from '../components/ui';
import { useStore, toast } from '../data/store';
import {
  checkoutBranch, commit, pull, push, refreshGitState, setCommitMessage, stageByOwner, stageFile,
  unstageAll, unstageFile, loadFileDiff, loadCommitDiff, parseUnifiedDiff, gitOperationLabel,
} from '../data/actions-git';
import { fullTime, relTime } from '../lib/format';
import { navigate } from '../lib/router';
import { ConflictModal, NewBranchModal, UndoCommitModal } from './GitDialogs';
import type { GitStatusEntry } from '../data/types';
import { gitEntryKey, selectedGitEntry } from '../data/gitEntries';
import { openExternalDeepLink } from '../loader';

type GitTab = 'worktree' | 'history' | 'branches';

const STATE_COPY: Record<GitStatusEntry['state'], { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }> = {
  modified: { label: '修改', tone: 'warning' },
  added: { label: '新增', tone: 'success' },
  deleted: { label: '删除', tone: 'danger' },
  renamed: { label: '重命名', tone: 'info' },
  untracked: { label: '未跟踪', tone: 'neutral' },
  conflicted: { label: '冲突', tone: 'danger' },
};

/**
 * 窄窗口（< 1100px）下的"列表 → 详情 → 返回列表"。
 *
 * 不做"把完整长列表垂直堆在详情上方"——那等于让用户为了看一条 diff
 * 先滚过 60 条历史。改为一次只显示一栏：
 *   进入详情前记住列表 scrollTop，返回时还原，选中项也保持不变。
 * `override` 用于合页模式：宽度判断由外壳（FilesGitPage）统一给出，
 *  避免出现两套不一致的断点。
 */
export function useNarrowPane(override?: boolean) {
  const [detected, setDetected] = useState(false);
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const listRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const keep = useRef(0);

  useEffect(() => {
    if (override !== undefined) return;
    const mq = window.matchMedia('(max-width: 1100px)');
    const on = () => setDetected(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [override]);

  const narrow = override ?? detected;

  const openDetail = useCallback(() => {
    if (!narrow) return;
    // 必须在隐藏之前取，隐藏后 scrollTop 就没了
    keep.current = listRef.current?.scrollTop ?? 0;
    setPane('detail');
  }, [narrow]);

  const backToList = useCallback(() => setPane('list'), []);

  useEffect(() => {
    if (narrow && pane === 'list' && listRef.current) listRef.current.scrollTop = keep.current;
  }, [narrow, pane]);

  return { narrow, pane, openDetail, backToList, listRef, detailRef };
}

/**
 * 左栏一行：状态点 + 路径 + 增删数字（数字等宽右对齐，行与行才对得上）。
 *
 * `action` 存在时，主区与操作区是**兄弟**元素：
 * 点主区 = 选中该文件；点操作 = 执行该操作（取消暂存）。
 * 之前"取消暂存"和"选中"抢同一次点击，导致暂存后根本没法逐个复核。
 */
function ListRow({
  active, onClick, title, action, children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  if (!action) {
    return (
      <button type="button" className={`git-list-row${active ? ' on' : ''}`} onClick={onClick} title={title}>
        {children}
      </button>
    );
  }
  return (
    /* 整行与行内主区都可点（点哪都能选中）；行内操作自己 stopPropagation，
       所以「取消暂存」不会顺带把选中项改掉。 */
    <div className={`git-list-row wrap${active ? ' on' : ''}`} title={title} onClick={onClick}>
      <button
        type="button"
        className="git-row-main"
        onClick={(ev) => { ev.stopPropagation(); onClick(); }}
      >
        {children}
      </button>
      <span className="git-row-act">{action}</span>
    </div>
  );
}

export function GitPage({
  projectId, embedded, onRequestBranch, narrow: narrowProp,
}: {
  projectId: string;
  embedded?: boolean;
  /** 合页页头「新建分支」按钮共用同一个对话框时传入 */
  onRequestBranch?: () => void;
  /** 合页模式由外壳统一判断窄窗口，避免两套断点 */
  narrow?: boolean;
}) {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === projectId);
  const git = s.git[projectId];
  const [tab, setTab] = useState<GitTab>('worktree');
  const [sel, setSel] = useState<string | null>(null);
  const [openDiff, setOpenDiff] = useState<string[]>([]);
  const [branchModal, setBranchModal] = useState(false);
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const [undoApproved, setUndoApproved] = useState<{ commitOid: string; expectedHead: string; expectedBranch: string; subject: string } | null>(null);
  /** 「你自己的改动」默认折叠：它是保护性说明，不是主要工作对象 */
  const [ownOpen, setOwnOpen] = useState(false);
  const { narrow, pane, openDetail, backToList, listRef, detailRef } = useNarrowPane(embedded ? narrowProp : undefined);

  /* 切项目：清掉上一个项目的选中与展开态。
     否则会出现"左边还高亮着 A 项目的文件、右边已经在显示 B 项目"的错位。 */
  useEffect(() => {
    setSel(null);
    setOpenDiff([]);
    setOwnOpen(false);
    setConflictPath(null);
    setBranchModal(false);
    setUndoApproved(null);
    setTab('worktree');
  }, [projectId]);

  /* R64：真实装载（status/branch.list/commitPreview/history 一次投影）+ 可见时轻量刷新。 */
  useEffect(() => { void refreshGitState(projectId); }, [projectId]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('legacy-on')) void refreshGitState(projectId);
    }, 10000);
    return () => { window.clearInterval(t); };
  }, [projectId]);
  /* 单文件 diff（选中即装载——git.diff 按需取真实正文）。 */
  type FileDiff = Awaited<ReturnType<typeof loadFileDiff>>;
  const [entryRead, setEntryRead] = useState<{ key: string; data: FileDiff | null; error: string | null; loading: boolean; at: number | null } | null>(null);
  const entryReload = useRef<() => void>(() => {});
  const activeEntryKey = selectedGitEntry(git?.status ?? [], sel);
  const entryReadKey = JSON.stringify([projectId, activeEntryKey?.path, activeEntryKey?.staged]);
  const entryDiff = entryRead?.key === entryReadKey ? entryRead.data : null;
  const entryReadError = entryRead?.key === entryReadKey ? entryRead.error : null;
  useEffect(() => {
    if (tab !== 'worktree' || activeEntryKey == null || activeEntryKey.state === 'conflicted') return;
    let cancelled = false, busy = false;
    const read = async () => {
      if (cancelled || busy || document.visibilityState === 'hidden' || document.body.classList.contains('legacy-on')) return;
      busy = true;
      setEntryRead(prev => ({ key: entryReadKey, data: prev?.key === entryReadKey ? prev.data : null, error: null, loading: true, at: prev?.key === entryReadKey ? prev.at : null }));
      try {
        const data = await loadFileDiff(projectId, activeEntryKey.path, activeEntryKey.staged);
        if (!cancelled) setEntryRead({ key: entryReadKey, data, error: null, loading: false, at: Date.now() });
      } catch (e) {
        if (!cancelled) setEntryRead(prev => ({ key: entryReadKey, data: prev?.key === entryReadKey ? prev.data : null, error: (e as Error).message, loading: false, at: prev?.key === entryReadKey ? prev.at : null }));
      } finally { busy = false; }
    };
    entryReload.current = () => { void read(); };
    const visible = () => { void read(); };
    void read();
    const timer = window.setInterval(visible, 10000);
    document.addEventListener('visibilitychange', visible);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); entryReload.current = () => {}; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, entryReadKey, activeEntryKey?.state]);
  /* 提交 diff（历史选中即装载——选父 OID 绑定由 R62 合同保证）。 */
  type CommitDiff = Awaited<ReturnType<typeof loadCommitDiff>>;
  const [commitParent, setCommitParent] = useState<{ oid: string; parent: string } | null>(null);
  const [commitRead, setCommitRead] = useState<{ key: string; data: CommitDiff | null; error: string | null; loading: boolean } | null>(null);
  const commitReload = useRef<() => void>(() => {});
  const activeCommitHash = git?.commits.find((c) => c.hash === sel)?.hash ?? git?.commits[0]?.hash ?? null;
  const parentOid = commitParent?.oid === activeCommitHash ? commitParent.parent : undefined;
  const commitReadKey = JSON.stringify([projectId, activeCommitHash, parentOid]);
  const commitData = commitRead?.key === commitReadKey ? commitRead.data : null;
  const commitError = commitRead?.key === commitReadKey ? commitRead.error : null;
  const commitFiles = (commitData?.patches ?? []).map(pt => ({ ...pt, diff: pt.binary ? [] : parseUnifiedDiff(pt.text) }));
  const commitFilesLoaded = commitData != null;
  useEffect(() => {
    if (tab !== 'history' || activeCommitHash == null) return;
    let cancelled = false, busy = false;
    const read = async () => {
      if (cancelled || busy) return;
      busy = true;
      setCommitRead(prev => ({ key: commitReadKey, data: prev?.key === commitReadKey ? prev.data : null, error: null, loading: true }));
      try {
        const data = await loadCommitDiff(projectId, activeCommitHash, parentOid);
        if (data.commit.oid !== activeCommitHash || (parentOid != null && data.comparedParent !== parentOid)) throw Error('提交或比较父身份不匹配，请重新读取');
        if (!cancelled) setCommitRead({ key: commitReadKey, data, error: null, loading: false });
      } catch (e) { if (!cancelled) setCommitRead(prev => ({ key: commitReadKey, data: prev?.key === commitReadKey ? prev.data : null, error: (e as Error).message, loading: false })); }
      finally { busy = false; }
    };
    commitReload.current = () => { void read(); };
    void read();
    return () => { cancelled = true; commitReload.current = () => {}; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, tab, activeCommitHash, parentOid, commitReadKey]);

  /* 换选中项：详情从顶部开始展示（左栏自己的滚动位置不动） */
  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [sel, tab, detailRef]);

  /* ---- 非 Git 目录：如实说明，不假装能用 ----
     §17.7 第 4 条：Git 标签显示"尚未初始化 Git"及"返回文件"，
     不自动 git init，也不把空态显示为"已连接仓库"。 */
  if (!project || (!git && (s.git[projectId]?.lastOp?.ok ?? true))) {
    return (
      <div className={`fg-body${narrow ? ' narrow' : ''}`} data-pane={pane}>
        <div className="fg-pane fg-pane-list"><div className="fg-pane-head git-list-head"><span className="small faint">Git</span></div></div>
        <div className="fg-pane fg-pane-detail"><div className="fg-pane-scroll"><div className="panel info">正在读取仓库状态（git.status / branch.list / history）…</div></div></div>
      </div>
    );
  }
  if (!project || !git || git.notARepo === true) {
    const branchReadError = git?.readErrors?.branches;
    const empty = (
      <>
        <EmptyState
          icon={branchReadError != null ? 'alert-triangle' : 'folder'}
          title={branchReadError != null ? '分支列表读取失败' : project?.isGit === false ? '尚未初始化 Git' : '没有 Git 数据'}
          detail={branchReadError != null ? `${branchReadError}；当前分支/工作区仍按 git.status 显示。` : '众说不自动 git init，也不会替你在项目里插入配置。你可以自行初始化后回到这里。'}
        />
        {branchReadError != null ? <div className="panel-actions"><button className="btn sm" onClick={() => void refreshGitState(projectId)}>重试读取</button></div> : <div className="panel">
          <div className="panel-title"><Icon name="info" size={13} /> 非 Git 目录下的改动记录仍然完整</div>
          任务改动照旧记录成改动集并支持 diff 与撤销（E15：非 Git 目录用整目录快照做内容级前像）。
          Git 标签只提供版本控制本身的能力，两者互不替代。
          <div className="panel-actions">
            <button className="btn sm" onClick={() => navigate(`/project/${projectId}/files?tab=files`)}>
              <Icon name="file-text" size={12} /> {embedded ? '返回文件' : '去看文件与改动'}
            </button>
          </div>
        </div>}
      </>
    );
    // 合页模式：外壳（含页头、状态条、文件/Git 标签）由 FilesGitPage 提供，
    // 这里只返回内容，避免出现两层页头。
    if (embedded) return empty;
    return (
      <div className="main">
        <div className="page">
          <div className="page-head">
            {/* 标题已删除（2026-09-26），空态本身已经说明"这个目录还不是 Git 仓库"。 */}
            <div>
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

  const toggleDiff = (key: string) =>
    setOpenDiff((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  /* 右栏永远有内容：没手动选就回退到该视图的第一条（工作区里冲突优先）。
     左栏高亮用的也是这个 activeEntry —— 列表与详情是同一个有效选中对象。 */
  const activeEntry = activeEntryKey;
  const activeCommit = git.commits.find((c) => c.hash === sel) ?? git.commits[0];
  const activeBranch =
    git.branches.find((b) => b.name === sel) ?? git.branches.find((b) => b.isCurrent) ?? git.branches[0];

  const goTask = (taskId: string) => {
    void openExternalDeepLink(`#task=${encodeURIComponent(taskId)}`).catch((e: unknown) => toast(`任务定位失败：${(e as Error).message}`, 'error'));
  };

  /** 左栏选中：窄窗口同时切到详情栏 */
  const pick = (key: string) => {
    setSel(key);
    openDetail();
  };

  const commitDisabled = staged.length === 0 || !git.commitMessage.trim() || conflicts.length > 0;
  const commitReason =
    conflicts.length > 0 ? '还有冲突未解决'
      : staged.length === 0 ? '暂存区为空，无法提交'
        : !git.commitMessage.trim() ? '提交信息不能为空'
          : `将提交 ${staged.length} 个文件到 ${git.currentBranch}`;

  const commitBtn = (
    <button
      className="btn primary sm"
      disabled={commitDisabled}
      title={commitReason}
      onClick={() => commit(projectId)}
    >
      <Icon name="git-commit" size={12} /> 提交
    </button>
  );

  /* 准备提交：暂存区为空时**收成一行提示**，不占着阅读区放一个大 textarea；
     有暂存内容时才展开成"数量 + 目标分支 + 提交信息 + 提交按钮"。
     它常驻右栏顶部（flex:none），所以入口始终可达，又不会盖住正文。 */
  const prepare = staged.length === 0 ? (
    <div className="git-prepare git-prepare-idle">
      <div className="row tight wrap">
        <span className="card-title">准备提交</span>
        <span className="small faint">
          暂存区为空 —— 选中左侧文件后暂存，这里会出现提交表单。
        </span>
        <div className="spacer" />
        {commitBtn}
      </div>
    </div>
  ) : (
    <div className="git-prepare">
      <div className="row tight wrap">
        <span className="card-title">准备提交</span>
        <Tag plain icon="git-branch">{git.currentBranch}</Tag>
        <span className="small">将提交 {staged.length} 个文件</span>
        <div className="spacer" />
        <button className="btn ghost sm" onClick={() => unstageAll(projectId)}>全部取消暂存</button>
        {commitBtn}
      </div>
      <textarea
        className="composer-input git-commit-input"
        rows={2}
        placeholder="提交信息（首行为标题）…"
        value={git.commitMessage}
        onChange={(ev) => setCommitMessage(projectId, ev.target.value)}
      />
      <div className="small faint">{commitReason}</div>
    </div>
  );

  const narrowBack = narrow ? (
    <div className="fg-pane-head row">
      <button className="btn ghost sm" onClick={backToList}>
        <Icon name="arrow-left" size={12} /> 返回列表
      </button>
      <span className="small faint">
        {tab === 'worktree' ? (activeEntry?.path ?? '工作区') : tab === 'history' ? '提交详情' : '分支与远端'}
      </span>
    </div>
  ) : null;

  const body = (
    <div
      className={`fg-body git-layout${narrow ? ' narrow' : ''}`}
      data-pane={pane}
    >
      {/* ==================== 左：清单（自己一条滚动条） ==================== */}
      <div className="fg-pane fg-pane-list git-list">
        <div className="fg-pane-head git-list-head">
          <Segmented<GitTab>
            value={tab}
            onChange={(v) => { setTab(v); setSel(null); }}
            options={[
              { value: 'worktree', label: git.status.length ? `工作区 ${new Set(git.status.map(e => e.path)).size}` : '工作区' },
              { value: 'history', label: `历史 ${git.commits.length}` },
              { value: 'branches', label: '分支' },
            ]}
          />
        </div>

        <div className="fg-pane-scroll" ref={listRef}>
          <div className="git-list-body">
            {tab === 'worktree' ? (
              <>
                {/* 1) 冲突优先，挡在提交前面 */}
                {conflicts.length > 0 ? (
                  <div className="git-list-sec">
                    <div className="section-title" style={{ color: 'var(--danger)' }}>
                      <Icon name="alert-triangle" size={13} /> 冲突未解决
                      <span className="count">{conflicts.length}</span>
                    </div>
                    {conflicts.map((e) => (
                      <ListRow key={gitEntryKey(e)} active={activeEntry != null && gitEntryKey(activeEntry) === gitEntryKey(e)} onClick={() => pick(gitEntryKey(e))} title={`${e.path} · 冲突`}>
                        <span className="git-dot conflicted" />
                        <span className="git-list-path mono">{e.path}</span>
                      </ListRow>
                    ))}
                  </div>
                ) : null}

                {/* 2) 已暂存：放在冲突之后、未暂存任务分组之前 —— 提交前复核要容易到达 */}
                <div className="git-list-sec">
                  <div className="section-title">
                    <Icon name="bookmark" size={13} /> 已暂存
                    <span className="count">{staged.length}</span>
                  </div>
                  {staged.length === 0 ? (
                    <div className="small faint" style={{ padding: '2px 8px 6px' }}>暂存区是空的。</div>
                  ) : (
                    <>
                      {staged.map((e) => (
                        <ListRow
                          key={gitEntryKey(e)}
                          active={activeEntry != null && gitEntryKey(activeEntry) === gitEntryKey(e)}
                          onClick={() => pick(gitEntryKey(e))}
                          title={`${e.path} · 已暂存（选中可在右侧复核）`}
                          action={
                            <button
                              type="button"
                              className="btn ghost sm"
                              title="取消暂存：独立操作，不影响你正在看哪个文件"
                              onClick={(ev) => {
                                ev.stopPropagation(); // 不要把这次点击当成"选中该文件"
                                unstageFile(projectId, e.path);
                              }}
                            >
                              取消暂存
                            </button>
                          }
                        >
                          <span className={`git-dot ${e.state}`} />
                          <span className="git-list-path mono">{e.path}</span>
                          {e.additions > 0 ? <span className="git-list-num add">+{e.additions}</span> : null}
                          {e.deletions > 0 ? <span className="git-list-num del">−{e.deletions}</span> : null}
                        </ListRow>
                      ))}
                      <div className="git-note">
                        选中任一文件可在右侧复核；「取消暂存」与该行的选中互不影响。
                      </div>
                    </>
                  )}
                </div>

                {/* 3) 待提交：按任务归属分组 */}
                <div className="git-list-sec">
                  <div className="section-title">
                    <Icon name="layers" size={13} /> 待提交 · 按任务
                    <span className="count">{mine.length}</span>
                  </div>
                  {mine.length === 0 ? (
                    <div className="small faint" style={{ padding: '2px 8px 6px' }}>没有待提交的任务改动。</div>
                  ) : (
                    [...byTask.entries()].map(([taskId, entries]) => {
                      const task = s.tasks.find((t) => t.id === taskId);
                      return (
                        <div key={taskId} className="git-task">
                          <div className="row tight">
                            <Icon name="diff" size={13} className="faint" />
                            <span className="strong git-task-title">
                              {taskId === '__none__' ? '未提供任务归属' : task ? `#${task.roomTaskNumber} ${task.title}` : taskId}
                            </span>
                            <span className="count">{entries.length}</span>
                          </div>
                          <div className="row tight" style={{ marginTop: 4 }}>
                            {taskId !== '__none__' ? (
                              <button className="btn ghost sm" onClick={() => stageByOwner(projectId, { taskId })}>
                                暂存本任务改动
                              </button>
                            ) : null}
                            {taskId !== '__none__' ? (
                              <button className="btn ghost sm" onClick={() => goTask(taskId)}>回到任务</button>
                            ) : null}
                          </div>
                          {entries.map((e) => (
                            <ListRow key={gitEntryKey(e)} active={activeEntry != null && gitEntryKey(activeEntry) === gitEntryKey(e)} onClick={() => pick(gitEntryKey(e))} title={e.path}>
                              <span className={`git-dot ${e.state}`} />
                              <span className="git-list-path mono">{e.path}</span>
                              {e.additions > 0 ? <span className="git-list-num add">+{e.additions}</span> : null}
                              {e.deletions > 0 ? <span className="git-list-num del">−{e.deletions}</span> : null}
                            </ListRow>
                          ))}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* 4) 你自己的改动：默认折叠，但保护说明常驻（§14.2） */}
                {userOwn.length > 0 ? (
                  <div className="git-list-sec">
                    <div className="section-title">
                      <Icon name="user" size={13} /> 你自己的改动
                      <span className="count">{userOwn.length}</span>
                    </div>
                    <div className="git-note">默认跳过批量暂存，不会被顺手提交</div>
                    <button type="button" className="git-list-row" onClick={() => setOwnOpen(!ownOpen)}>
                      <Icon name={ownOpen ? 'chevron-down' : 'chevron-right'} size={11} className="faint" />
                      <span>{ownOpen ? '收起' : `展开 ${userOwn.length} 个文件`}</span>
                    </button>
                    {ownOpen ? userOwn.map((e) => (
                      <ListRow key={gitEntryKey(e)} active={activeEntry != null && gitEntryKey(activeEntry) === gitEntryKey(e)} onClick={() => pick(gitEntryKey(e))} title={e.path}>
                        <span className={`git-dot ${e.state}`} />
                        <span className="git-list-path mono">{e.path}</span>
                      </ListRow>
                    )) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {tab === 'history' ? (
              <>
                <div className="git-list-sec">
                  <div className="section-title">
                    <Icon name="git-commit" size={13} /> 提交
                    <span className="count">{git.commits.length}</span>
                  </div>
                  {git.commits.length === 0 ? (
                    <div className="small faint" style={{ padding: '2px 8px 6px' }}>这个仓库还没有提交。</div>
                  ) : (
                    git.commits.map((c) => (
                      <ListRow
                        key={c.hash}
                        active={activeCommit?.hash === c.hash}
                        onClick={() => pick(c.hash)}
                        /* agent 提交在列表里也要能扫到（图标 + 行说明），
                           不能只在选中后的详情里才看得见（§10.5：只说明来源，不是审批结论） */
                        title={c.authoredBy === 'agent' ? `${c.subject} · agent 提交` : c.subject}
                      >
                        {c.authoredBy === 'agent' ? <Icon name="cpu" size={11} className="faint" /> : null}
                        <span className="git-list-path">{c.subject}</span>
                        <span className="mono-sm faint">{c.shortHash}</span>
                      </ListRow>
                    ))
                  )}
                </div>
                <div className="git-note">提交 ≠ 验收。验收只在任务交付里做，Git 页不做审批中心。</div>
              </>
            ) : null}

            {tab === 'branches' ? (
              <>
                <div className="git-list-sec">
                  <div className="section-title">
                    <Icon name="git-branch" size={13} /> 分支
                    <span className="count">{git.branches.length}</span>
                  </div>
                  {git.branches.map((b) => (
                    <ListRow key={b.name} active={activeBranch?.name === b.name} onClick={() => pick(b.name)} title={b.name}>
                      <Icon name={b.isCurrent ? 'check-circle' : 'git-branch'} size={12} className={b.isCurrent ? '' : 'faint'} />
                      <span className="git-list-path">{b.name}</span>
                      {b.ahead != null && b.ahead > 0 ? <span className="git-list-num add">↑{b.ahead}</span> : null}
                      {b.behind != null && b.behind > 0 ? <span className="git-list-num del">↓{b.behind}</span> : null}
                    </ListRow>
                  ))}
                  <div className="small faint" style={{ padding: '4px 8px 2px' }}>
                    切换分支不会替你 stash 未提交改动——它们会跟着过去。
                  </div>
                </div>
                <div className="git-list-sec">
                  <div className="section-title">
                    <Icon name="upload" size={13} /> 远端
                    <span className="count">{git.remotes.length}</span>
                  </div>
                  {git.remotes.length === 0 ? (
                    <div className="small faint" style={{ padding: '2px 8px 6px' }}>没有配置远端。</div>
                  ) : (
                    git.remotes.map((r) => (
                      <ListRow key={r.name} active={sel === `r:${r.name}`} onClick={() => pick(`r:${r.name}`)} title={r.url}>
                        <Icon name="power" size={12} className="faint" />
                        <span className="git-list-path">{r.name}</span>
                        <span
                          className={`git-dot ${r.authState === 'ok' ? 'added' : r.authState === 'expired' ? 'modified' : r.authState === 'unknown' ? 'untracked' : 'conflicted'}`}
                          title={r.authState === 'ok' ? '凭据可用' : r.authState === 'expired' ? '凭据已过期' : r.authState === 'unknown' ? '凭据尚未检查' : '缺少凭据'}
                        />
                      </ListRow>
                    ))
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* ==================== 右：详情（自己一条滚动条） ==================== */}
      <div className="fg-pane fg-pane-detail git-detail">
        {narrowBack}

        {tab === 'worktree' ? (
          <>
            {prepare}
            <div className="fg-pane-scroll git-detail-scroll" ref={detailRef}>
              {activeEntry ? (
                <div className="card">
                  <div className="row tight wrap">
                    <span className="mono" style={{ fontSize: 12 }}>{activeEntry.path}</span>
                    <Tag tone={STATE_COPY[activeEntry.state].tone}>{STATE_COPY[activeEntry.state].label}</Tag>
                    {activeEntry.staged ? <Tag tone="info" icon="bookmark">已暂存</Tag> : null}
                    {activeEntry.additions > 0 ? <span className="small" style={{ color: 'var(--success)' }}>+{activeEntry.additions}</span> : null}
                    {activeEntry.deletions > 0 ? <span className="small" style={{ color: 'var(--danger)' }}>−{activeEntry.deletions}</span> : null}
                    {activeEntry.changeSetId ? <Tag plain icon="layers">改动集</Tag> : null}
                    {activeEntry.userPreExisting ? (
                      <Tag
                        tone="warning"
                        icon="user"
                        title="这个文件在你发起任务之前就有未提交修改。任务不会覆盖它，按任务批量暂存也会跳过；要提交需显式勾选。"
                      >
                        你自己在任务前改过
                      </Tag>
                    ) : null}
                    <div className="spacer" />
                    {activeEntry.staged ? (
                      <button className="btn ghost sm" onClick={() => unstageFile(projectId, activeEntry.path)}>取消暂存</button>
                    ) : (
                      <button className="btn sm" onClick={() => stageFile(projectId, activeEntry.path)}>暂存</button>
                    )}
                  </div>

                  {/* 冲突：不提供一键覆盖，只给入口去看三方内容 */}
                  {activeEntry.state === 'conflicted' ? (
                    <div className="panel danger" style={{ marginTop: 10 }}>
                      <div className="panel-title"><Icon name="alert-triangle" size={13} /> 冲突未解决</div>
                      冲突文件不会被提交。众说不提供"全部用某一边覆盖"——冲突时保留三方内容让你逐个看。
                      <div className="panel-actions">
                        <button className="btn sm" onClick={() => setConflictPath(activeEntry.path)}>查看三方内容</button>
                      </div>
                    </div>
                  ) : null}

                  {/*
                    工作区一次只显示一个选中文件，所以有文本 diff 时**选中后直接显示**，
                    不再要求先点一次「展开 diff」。没有 diff 时如实说明，
                    也不再放一个点了没反应的展开按钮。
                  */}
                  <div className="section-title" style={{ marginTop: 12 }}>
                    <Icon name="diff" size={13} /> {activeEntry.staged ? '已暂存差异' : '工作区差异'}
                    <div className="spacer" />
                    <button className="btn ghost sm" disabled={entryRead?.key === entryReadKey && entryRead.loading} onClick={() => entryReload.current()}>刷新差异</button>
                  </div>
                  {entryReadError ? <div className="panel warning" role="alert">差异读取失败：{entryReadError}。{entryDiff ? '保留上次确认的差异。' : '尚未取得该版本差异。'}可点「刷新差异」重试。</div> : null}
                  {entryRead?.key === entryReadKey && entryRead.at != null ? <div className="small faint">差异更新于 {fullTime(entryRead.at)}{entryRead.loading ? ' · 正在刷新…' : ''}</div> : null}
                  {activeEntry.staged ? (
                    <div className="git-note" style={{ margin: '0 0 6px' }}>
                      显示的是<strong>{activeEntry.staged ? '已暂存内容' : '工作区当前内容'}</strong>的 diff
                     （git.diff staged={String(activeEntry.staged)}——真实命令按需读取）。
                    </div>
                  ) : null}
                  {activeEntry.state === 'conflicted' ? <div className="small faint">该文件有未解决冲突；请查看上方三方内容后编辑并确认。</div> : entryDiff == null ? (
                    entryReadError ? null : <div className="small faint" style={{ padding: '4px 0' }}>正在读取差异…</div>
                  ) : entryDiff.binary ? (
                    <div className="panel">
                      <div className="panel-title"><Icon name="info" size={13} /> 二进制文件</div>
                      不生成逐行 diff；路径与增减统计为事实（git numstat）。
                    </div>
                  ) : entryDiff.hunks.length > 0 ? (
                    <>
                      <DiffView hunks={entryDiff.hunks} />
                      {entryDiff.truncated ? <div className="small faint" style={{ marginTop: 4 }}>diff 正文超上限已截断——完整差异请用 git 客户端。</div> : null}
                    </>
                  ) : (
                    <div className="panel">
                      <div className="panel-title"><Icon name="info" size={13} /> 没有可展示的文本 diff</div>
                      {activeEntry.state === 'deleted'
                        ? '文件已删除，按路径记录删除事实。'
                        : '二进制、超大文件或未跟踪新文件可能没有 unified diff 正文。'}
                    </div>
                  )}
                </div>
              ) : (
                <div className="card">
                  <div className="small faint">左侧没有待处理的改动。选中一个文件可看它的 diff 与操作。</div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="fg-pane-scroll git-detail-scroll" ref={detailRef}>
            {tab === 'history' ? (
              <>
                {activeCommit ? (
                  <div className="card">
                    <div className="row tight wrap">
                      <Icon name="git-commit" size={14} className="faint" />
                      <span className="strong" style={{ fontSize: 12.5 }}>{activeCommit.subject}</span>
                      {activeCommit.authoredBy === 'agent' ? <Tag tone="info" icon="cpu">agent 提交</Tag> : null}
                      {activeCommit.refs.filter((r) => r !== 'HEAD').map((r) => (
                        <Tag key={r} plain icon="git-branch">{r}</Tag>
                      ))}
                      <div className="spacer" />
                      <span className="mono-sm faint">{activeCommit.shortHash}</span>
                    </div>
                    <div className="row tight wrap small faint" style={{ marginTop: 6 }}>
                      <span>{activeCommit.authorName}</span>
                      <span>{fullTime(activeCommit.committedAt)}</span>
                      <span>{commitFilesLoaded ? `${commitFiles.length} 个文件` : '文件列表尚未读取'}</span>
                      {activeCommit.taskId ? (
                        <button className="btn ghost sm" onClick={() => goTask(activeCommit.taskId!)}>
                          <Icon name="corner-down-right" size={11} /> 来自任务
                          {(() => {
                            const t = s.tasks.find((x) => x.id === activeCommit.taskId);
                            return t ? ` #${t.roomTaskNumber}` : '';
                          })()}
                        </button>
                      ) : null}
                      {activeCommit.changeSetId ? <Tag plain icon="layers">关联改动集</Tag> : null}
                    </div>

                    {/* §10.5：这里只如实展示关联交付的状态，决定一律去交付详情做。
                        既不显示"已审阅"勾，也不因为任务在 REVIEW 就禁用 Git 操作。 */}
                    {(() => {
                      const deliveries = s.taskDeliveries.filter((d) => d.taskId === activeCommit.taskId);
                      if (!activeCommit.taskId || deliveries.length === 0) return null;
                      const delivery =
                        deliveries.find((d) => d.status === 'pending')
                        ?? deliveries.find((d) => d.revision === Math.max(...deliveries.map((x) => x.revision)));
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
                        <div className="row tight wrap" style={{ marginTop: 8 }}>
                          <Tag tone={tone} icon={delivery.status === 'pending' ? 'eye' : 'info'} title="验收针对整个交付，不针对单个提交">
                            {label}
                          </Tag>
                          <button
                            className="btn ghost sm"
                            onClick={() => {
                              const task = s.tasks.find((x) => x.id === activeCommit.taskId);
                              const th = task ? s.threads.find((x) => x.id === task.conversationThreadId) : undefined;
                              if (th) navigate(`/project/${projectId}/room/${th.roomId}?thread=${th.id}&tab=delivery`);
                            }}
                            title="去任务交付详情查看与决定；Git 页不承担审批"
                          >
                            <Icon name="corner-down-right" size={11} /> 查看交付详情
                          </button>
                        </div>
                      );
                    })()}

                    <div className="section-title" style={{ marginTop: 12 }}>
                      <Icon name="file-text" size={13} /> 改动文件
                      <span className="count">{commitFiles.length}</span>
                      <div className="spacer" />
                      {/* 一次提交可能有多个文件：保留逐文件折叠 + 批量展开收起 */}
                      {commitFiles.length > 0 ? (
                        <>
                          <button
                            className="btn ghost sm"
                            onClick={() => setOpenDiff(commitFiles.map((f) => `h:${activeCommit.hash}:${f.path}`))}
                          >
                            全部展开
                          </button>
                          <button
                            className="btn ghost sm"
                            onClick={() => setOpenDiff((prev) => prev.filter((k) => !k.startsWith(`h:${activeCommit.hash}:`)))}
                          >
                            全部收起
                          </button>
                        </>
                      ) : null}
                    </div>
                    {commitError ? <div className="panel warning" role="alert">提交差异读取失败：{commitError}。{commitData ? '保留上次确认内容。' : '尚未取得该提交差异。'}</div> : null}
                    <button className="btn ghost sm" disabled={commitRead?.key === commitReadKey && commitRead.loading} onClick={() => commitReload.current()}>刷新提交差异</button>
                    {(commitData?.parentsMeta?.length ?? 0) > 1 ? <div className="row wrap" data-zs-git-parents>
                      <span className="small faint">合并提交 · 选择比较父</span>
                      {commitData!.parentsMeta!.map(p => <button key={p.oid} className={`chip${commitData?.comparedParent === p.oid ? ' on' : ''}`} onClick={() => setCommitParent({ oid: activeCommit.hash, parent: p.oid })}>{p.oid.slice(0,8)} · {p.subject}</button>)}
                    </div> : null}
                    {commitData?.mergeNote ? <div className="panel info">{commitData.mergeNote}</div> : null}
                    {commitData?.comparedParent ? <div className="small faint">相对父 {commitData.comparedParent.slice(0,8)}</div> : null}
                    {commitFiles.length === 0 ? (
                      commitError || commitData?.mergeNote ? null : <div className="small faint">{commitFilesLoaded ? '该提交没有文件改动（空提交）。' : '正在读取提交差异…'}</div>
                    ) : (
                      commitFiles.map((f) => {
                        const key = `h:${activeCommit.hash}:${f.path}`;
                        const open = openDiff.includes(key);
                        return (
                          <div key={f.path} style={{ marginBottom: 6 }}>
                            <div className="row tight wrap">
                              <span className="mono" style={{ fontSize: 11.5 }}>{f.path}</span>
                              <Tag tone={f.change === 'added' ? 'success' : f.change === 'deleted' ? 'danger' : 'warning'}>
                                {f.change === 'added' ? '新增' : f.change === 'deleted' ? '删除' : f.change === 'renamed' ? '重命名' : '修改'}
                              </Tag>
                              {(f.diff.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0)) > 0 ? <span className="small" style={{ color: 'var(--success)' }}>+{f.diff.reduce((n, h) => n + h.lines.filter((l) => l.type === 'add').length, 0)}</span> : null}
                              {(f.diff.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0)) > 0 ? <span className="small" style={{ color: 'var(--danger)' }}>−{f.diff.reduce((n, h) => n + h.lines.filter((l) => l.type === 'del').length, 0)}</span> : null}
                              <div className="spacer" />
                              <button className="btn ghost sm" onClick={() => toggleDiff(key)}>
                                <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
                                {open ? '收起 diff' : '查看 diff'}
                              </button>
                            </div>
                            {open ? (
                              f.diff.length > 0 ? <DiffView hunks={f.diff} /> : (
                                <div className="small faint" style={{ padding: '4px 0' }}>{f.binary ? '二进制文件（无逐行 diff）。' : f.truncated ? 'diff 已截断。' : '无文本 diff。'}</div>
                              )
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                ) : (
                  <div className="card">
                    <EmptyState icon="git-commit" title="还没有提交" detail="这个仓库还没有任何提交记录。" />
                  </div>
                )}

                {/* reflog：撤销入口保留，说明照旧（软回退，不丢文件） */}
                <div className="card">
                  <div className="section-title"><Icon name="clock" size={13} /> 最近操作（reflog）</div>
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
                      <button className="btn danger sm" onClick={() => { const head=git.commits[0]; if(head)setUndoApproved({commitOid:head.hash,expectedHead:head.hash,expectedBranch:git.currentBranch,subject:head.subject}); }} disabled={git.commits.length === 0 || !!git.readErrors?.history || !git.currentBranch || git.currentBranch === 'HEAD'}>
                        <Icon name="corner-up-left" size={12} /> 撤销当前 HEAD 提交
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                {sel?.startsWith('r:') ? (
                  (() => {
                    const r = git.remotes.find((x) => x.name === sel.slice(2));
                    if (!r) return null;
                    return (
                      <div className="card">
                        <div className="row tight wrap">
                          <Icon name="power" size={14} className="faint" />
                          <span className="strong" style={{ fontSize: 12.5 }}>{r.name}</span>
                          <Tag
                            tone={r.authState === 'ok' ? 'success' : r.authState === 'expired' ? 'warning' : r.authState === 'unknown' ? 'neutral' : 'danger'}
                            icon={r.authState === 'ok' ? 'check-circle' : r.authState === 'unknown' ? 'info' : 'alert-triangle'}
                          >
                            {r.authState === 'ok' ? '凭据可用' : r.authState === 'expired' ? '凭据已过期' : r.authState === 'unknown' ? '凭据尚未检查' : '缺少凭据'}
                          </Tag>
                        </div>
                        <div className="small faint" style={{ marginTop: 6 }}>
                          <span className="mono-sm">{r.url}</span>
                        </div>
                        <div className="small faint" style={{ marginTop: 6 }}>
                          {r.authState === 'unknown' ? '读取远端配置不会验证账号；推送或拉取时按实际回执报告结果。本地远端可能无需网络凭据。' : '实际推送或拉取失败会就地显示原因。'}
                        </div>
                      </div>
                    );
                  })()
                ) : activeBranch ? (
                  <div className="card">
                    <div className="row tight wrap">
                      <Icon name={activeBranch.isCurrent ? 'check-circle' : 'git-branch'} size={14} className={activeBranch.isCurrent ? '' : 'faint'} />
                      <span className="strong" style={{ fontSize: 12.5 }}>{activeBranch.name}</span>
                      {activeBranch.isCurrent ? <Tag tone="info">当前分支</Tag> : null}
                      {activeBranch.createdByZhongshuo ? <Tag plain icon="cpu">众说创建的隔离分支</Tag> : null}
                      <div className="spacer" />
                      {!activeBranch.isCurrent ? (
                        <button className="btn sm" onClick={() => checkoutBranch(projectId, activeBranch.name)}>切换</button>
                      ) : null}
                    </div>
                    <div className="row tight wrap small faint" style={{ marginTop: 8 }}>
                      <span className="mono-sm">{activeBranch.head}</span>
                      {activeBranch.upstream ? <span>上游 {activeBranch.upstream}</span> : <span>没有上游</span>}
                      {activeBranch.ahead != null && activeBranch.ahead > 0 ? <span>领先 {activeBranch.ahead}</span> : null}
                      {activeBranch.behind != null && activeBranch.behind > 0 ? <span>落后 {activeBranch.behind}</span> : null}
                      <span>{relTime(activeBranch.updatedAt)}</span>
                    </div>
                    {!activeBranch.isCurrent ? (
                      <div className="small faint" style={{ marginTop: 8 }}>
                        切换分支不会替你 stash 未提交改动——它们会跟着过去。这是如实反映 Git 行为，不是保护你。
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="card"><div className="small faint">从左侧选一个分支或远端查看详情。</div></div>
                )}

                {/* 「新建分支」是分支区唯一的创建动作，保持主按钮（§5.8） */}
                <div className="card">
                  <div className="row tight">
                    <span className="card-title">新建分支</span>
                    <div className="spacer" />
                    <button
                      className="btn primary sm"
                      onClick={() => (onRequestBranch ? onRequestBranch() : setBranchModal(true))}
                    >
                      <Icon name="plus" size={12} /> 新建分支
                    </button>
                  </div>
                  <div className="small faint" style={{ marginTop: 6 }}>
                    在已确认的提交上创建分支。需要切换时，在分支列表选择目标后明确切换。
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  /* 新建分支：合页模式由页头按钮打开时状态在 FilesGitPage，这里不再渲染第二份 */
  const branchModalNode = branchModal && !onRequestBranch ? (
    <NewBranchModal
      projectId={projectId}
      base={git.commits[0]?.shortHash ?? '(空仓库)'}
      onClose={() => setBranchModal(false)}
    />
  ) : null;
  const conflictNode = conflictEntry?.state === 'conflicted' ? (
    <ConflictModal key={`${projectId}:${conflictEntry.path}`} projectId={projectId} entry={conflictEntry} onClose={() => setConflictPath(null)} />
  ) : null;
  const undoNode = undoApproved ? <UndoCommitModal projectId={projectId} approved={undoApproved} onClose={() => setUndoApproved(null)} /> : null;

  // 合页模式：外壳（页头 / 状态条 / 顶层标签 / .page.fg-page）由 FilesGitPage 提供，
  // 这里只交出内容，避免出现两层页头与两条互相打架的滚动条。
  if (embedded) {
    return (<>{body}{branchModalNode}{conflictNode}{undoNode}</>);
  }

  return (
    <div className="main">
      <div className="page fg-page">
        <div className="page-head">
          {/* 标题已按用户要求删除（2026-09-26）：视图由页签「Git」表达，路径保留为坐标。 */}
          <div>
            <div className="page-sub mono">{project.canonicalPath}</div>
          </div>
          <div className="page-head-actions">
            <button className="btn sm" onClick={() => pull(projectId)} disabled={!branch || branch.behind === 0}>
              <Icon name="download" size={12} /> 拉取
            </button>
            <button className="btn sm" onClick={() => push(projectId)} disabled={!branch || branch.ahead === 0}>
              <Icon name="upload" size={12} /> 推送 {branch?.ahead ? `(${branch.ahead})` : ''}
            </button>
            <button className="btn sm" onClick={() => setBranchModal(true)}>
              <Icon name="git-branch" size={12} /> 新建分支
            </button>
          </div>
        </div>

        {/* 最近一次操作失败：不静默（§16.5）。成功态已并入状态条，不在这里重复占一块。 */}
        {git.lastOp && !git.lastOp.ok ? (
          <div className="panel danger" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> {gitOperationLabel(git.lastOp.op)}{git.lastOp.outcome === 'unknown' ? '结果待确认' : '未完成'}</div>
            {git.lastOp.detail}
            <span className="small faint"> · {relTime(git.lastOp.at)}</span>
          </div>
        ) : null}

        {body}
      </div>
      {branchModalNode}
      {conflictNode}
      {undoNode}
    </div>
  );
}
