import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * 成果预览 / 文件与改动 / 成员设置 / Runtime / 应用设置 / 私信
 *
 * 关键口径：
 *  - §6.6 最终报告模板七段结构；成果有版本，一个磁盘路径本身不是不可变成果
 *  - §14.5 撤销带版本检查；大文件无前像要显式警告（E15）
 *  - RT-10/11 用户未提交改动与外部编辑器同时改的归属提示
 *  - §8.2 决策 38 成员级模型与思考强度；三类重置范围分开（§25.6）
 *  - §8.3 局域网配对：配对码用户可自设、限时一次一用、设备可逐个吊销、强制 HTTPS/WSS
 *  - §16.5 错误码在界面上逐条有恢复动作
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, Segmented, Tag } from '../components/ui';
import { useStore, toast, recordWrite } from '../data/store';
import { Modal } from '../components/ui';
import { byId, lockOfProject } from '../data/selectors';
import { consensusLabel, formatBytes, formatDuration, fullTime, relTime } from '../lib/format';
import { pull, push, refreshGitState, stageByOwner, gitOperationLabel } from '../data/actions-git';
import { PendingGitOperations } from '../components/PendingGitOperations';
import { focusProject, rememberFileGitTab, resolveFileGitTab } from '../data/actions-nav';
import { useLazyTree, fileSizeLabel, type TreeNode } from '../data/project-files';
import { navigate } from '../lib/router';
import { GitPage, useNarrowPane } from './GitPage';
import { NewBranchModal } from './GitDialogs';
/* UX-PREVIEW-01：文件与 Git 复用共享预览（§17.9 第 2 条） */
import { PreviewPane } from '../preview/PreviewPane';
import { openWorktreePreview } from '../data/actions-preview';
import type { AppState, ContextLocation } from '../data/types';
import {useFormalChanges,FormalChangeList,FormalChangeDetail} from '../components/FormalChanges';

/* ============================================================
   成果预览（§17.2 成果预览 / §6.6 报告模板）
   ============================================================ */

function TreeNodeRow({
  node, expanded, onToggle, selectedPath, onSelect, changedPaths,
}: {
  node: TreeNode;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selectedPath: string | undefined;
  onSelect: (node: TreeNode) => void;
  changedPaths: Map<string, string>;
}) {
  const isOpen = expanded.has(node.path);
  const change = changedPaths.get(node.path);
  return (
    <>
      <button
        className={`file-row${selectedPath === node.path ? ' on' : ''}`}
        style={{ paddingLeft: 8 + node.depth * 12 }}
        onClick={() => (node.kind === 'dir' ? onToggle(node.path) : onSelect(node))}
        title={node.path}
      >
        {node.kind === 'dir' ? (
          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={11} className="faint" />
        ) : (
          <span className="file-row-gap" />
        )}
        <Icon
          name={node.kind === 'dir' ? 'folder' : 'file-text'}
          size={13}
          className={change ? 'faint' : 'faint'}
        />
        <span className="side-item-label">{node.name}</span>
        {/* 已有任务改动的文件标出来源，让"文件树"与"改动集"对得上 */}
        {change ? <span className={`file-change-dot ${change}`} title={`本任务改动：${change}`} /> : null}
        {node.kind === 'file' && node.sizeBytes !== undefined ? (
          <span className="file-row-size">{fileSizeLabel(node.sizeBytes)}</span>
        ) : null}
      </button>
      {node.kind === 'dir' && isOpen ? (
        node.children.length === 0 ? (
          <div className="file-empty" style={{ paddingLeft: 20 + node.depth * 12 }}>空目录</div>
        ) : (
          node.children.map((c) => (
            <TreeNodeRow
              key={c.path}
              node={c}
              expanded={expanded}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
              changedPaths={changedPaths}
            />
          ))
        )
      ) : null}
    </>
  );
}

export function FilesGitPage({ projectId, query }: { projectId: string; query: Record<string, string> }) {
  // 文件树、选中对象和阅读器按项目隔离；路由从 A 直切 B 时卸载 A 的在途读取。
  return <FilesGitPageForProject key={projectId} projectId={projectId} query={query} />;
}

function FilesGitPageForProject({ projectId, query }: { projectId: string; query: Record<string, string> }) {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === projectId);
  const formalChanges=useFormalChanges(projectId);

  /**
   * 标签解析顺序（§17.7）：**URL 显式 tab 优先于记忆**。
   * 否则一个分享出去的 `?tab=git` 链接，在收件人机器上会被他自己的
   * "上次看的是 files" 覆盖掉，链接就失去了定位意义。
   */
  const tab = resolveFileGitTab(projectId, query.tab);
  const setTab = (next: 'files' | 'git') => {
    rememberFileGitTab(projectId, next);
    const qs = new URLSearchParams({ ...query, tab: next });
    navigate(`/project/${projectId}/files?${qs.toString()}`, { replace: true });
  };

  /* ---- 文件树（R64：真实目录懒装载——project.files.list 只读投影） ---- */
  const tree = useLazyTree(projectId);
  const { expanded, toggleDir } = tree;
  const [selected, setSelected] = useState<TreeNode | null>(null);
  /** 「新建分支」对话框：页头操作簇与 Git 页分支区共用同一个（状态提到合页这一层） */
  const [branchModal, setBranchModal] = useState(false);

  /**
   * 左栏在「目录树 / 改动集」之间切换，右栏因此永远只显示一件事。
   * 窄窗口下两栏改成分步显示（列表 → 详情 → 返回列表），
   * 不做"把长列表垂直堆在详情上方"。
   */
  const [leftTab, setLeftTab] = useState<'tree' | 'changes'>('tree');
  const [csId, setCsId] = useState<string | undefined>(undefined);
  const { narrow, pane, openDetail, backToList, listRef, detailRef } = useNarrowPane();

  // 切项目时重置选中与改动集选中：
  // A 项目的文件不该在 B 项目里"看起来还选中着"，也不该左边高亮旧项、右边显示新详情。
  useEffect(() => {
    setSelected(null);
    setCsId(undefined);
    backToList();
  }, [projectId, backToList]);

  /* R64：Git 状态真实装载（状态条/页头按钮/Git 页共一份投影）。 */
  useEffect(() => { void refreshGitState(projectId); }, [projectId]);

  /** 本项目的改动集：左栏「改动集」分组与树上的改动标记同源，不复制两份数据（§4） */
  const changeSets = useMemo(() => {
    const taskIds = s.tasks.filter((t) => t.projectId === projectId).map((t) => t.id);
    return s.changeSets.filter((c) => taskIds.includes(c.taskId));
  }, [s.changeSets, s.tasks, projectId]);

  /** 改动集里的文件路径 → 变更类型，用于在树上打标记 */
  const changedPaths = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of changeSets) {
      for (const f of c.files) m.set(f.path, f.change);
    }
    return m;
  }, [changeSets]);

  const fileCount = tree.fileCount;

  /**
   * **唯一有效的选中改动集**。
   * 原来右栏默认展示 sets[0]、左栏却按 `csId`（初始 undefined）判高亮 ——
   * 于是"右边已经在显示第一条的详情，左边一项都没亮"。
   * 现在列表与详情用同一个 activeCs，切项目或改动集消失时自动回落到第一条。
   */
  const activeCs = useMemo(() => {
    if (csId && formalChanges.items?.some(c=>c.changeSetId===csId)) return csId;
    return formalChanges.items?.[0]?.changeSetId;
  }, [csId, formalChanges.items]);

  /** 换选中对象时详情从顶部开始；左栏自己的滚动位置不动（两栏互不干扰） */
  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [activeCs, leftTab, selected?.path, detailRef]);

  const git = s.git[projectId];
  const isGit = Boolean(project?.isGit) && git != null && git.notARepo !== true;
  const changedFileCount = new Set(git?.status.map(e => e.path) ?? []).size;
  /** 状态条要用的两项：当前分支（算领先/落后）与本项目的写入锁（§10.3 锁域 = 同一物理目录） */
  const curBranch = git?.branches.find((b) => b.isCurrent);
  const lock = lockOfProject(s, projectId);

  if (!project) {
    return (
      <div className="main">
        <div className="page">
          <ErrorState code="PROJECT_NOT_FOUND" detail={`路径里的项目不存在：${projectId}`} />
        </div>
      </div>
    );
  }

  return (
    <div className="main">
      {/*
        本页的 .page 用 .fg-page 变体：**页面自身不滚动**。
        页头 / 顶层标签 / 状态条各占 flex:none 的位置，剩下的高度全部给
        .fg-body，左右两栏在里面各自滚动 —— 这就是"左右阅读与选择互不干扰"。
        其它页面（房间 / 线程 / 私信 / 看板）用的还是普通 .page，不受影响。
      */}
      <div className="page fg-page">
        {/* 页头**一行**：标题 + 路径 + 项目选择器 + 操作簇。
            项目选择器留在页内是因为 §17.7 要求"顶栏写一个项目、页面操作另一个"不能发生；
            它和顶栏是同一个动作，但不再单独占一条筛选带（原来页头/筛选/页签三条横带叠在一起）。 */}
        <div className="page-head">
          {/* 标题已按用户要求删除（2026-09-26）：保留路径这一行（"当前是哪个目录"是坐标，不是说明文字），
              页签「文件 / Git」就在下面。 */}
          <div>
            <div className="page-sub mono">{project.canonicalPath}</div>
          </div>
          <div className="page-head-actions">
            <label className="field inline">
              <span className="field-label">项目</span>
              <select
                className="select"
                value={projectId}
                onChange={(e) => {
                  const next = e.target.value;
                  focusProject(next, { announce: false });
                  navigate(`/project/${next}/files?tab=${tab}`);
                }}
              >
                {s.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </select>
            </label>
            {tab === 'git' && isGit ? (
              <>
                <button
                  className="btn sm"
                  title={`真实 git.pull（origin/${git?.currentBranch ?? ''}）`}
                  onClick={() => void pull(projectId)}
                  disabled={!curBranch}
                >
                  <Icon name="download" size={12} /> 拉取
                </button>
                <button
                  className="btn sm"
                  title={`推送到所选远端；推送前检查版本，保留远端已有提交${curBranch?.ahead != null && curBranch.ahead > 0 ? `——本地领先 ${curBranch.ahead}` : ''}`}
                  onClick={() => void push(projectId)}
                  disabled={!curBranch}
                >
                  <Icon name="upload" size={12} /> 推送{curBranch?.ahead != null && curBranch.ahead > 0 ? ` (${curBranch.ahead})` : ''}
                </button>
                {/* 「分支」→「新建分支」：这个按钮是**创建**动作，
                    左栏的「分支」是**查看**视图，两个不能同名。
                    之前同名会让"点顶部想新建"和"点左栏想看分支"分不清。 */}
                <button className="btn sm" onClick={() => setBranchModal(true)} title="基于已确认的 HEAD 创建分支；切换另行操作">
                  <Icon name="git-branch" size={12} /> 新建分支
                </button>
              </>
            ) : null}
          </div>
        </div>

        {/* 顶层两标签：文件 / Git。历史属于 Git 内部导航，不另加第三个顶层标签。 */}
        <div className="thread-tabs" style={{ marginBottom: 10 }}>
          <button className={`thread-tab${tab === 'files' ? ' on' : ''}`} onClick={() => setTab('files')}>
            <Icon name="file-text" size={13} /> 文件
          </button>
          <button className={`thread-tab${tab === 'git' ? ' on' : ''}`} onClick={() => setTab('git')}>
            <Icon name="git-branch" size={13} /> Git
            {/* 这个数字是**工作区改动文件数**，不是提交数、也不是审批数 */}
            {git && git.status.length > 0 ? (
              <span className="faint" title="工作区改动文件数">{changedFileCount}</span>
            ) : null}
            {!isGit ? <span className="faint">未初始化</span> : null}
          </button>
        </div>

        {/* 状态条：状态**只在这里说一遍**。
            它合并了原来散在四处的信息 —— page-filters 的"Git 仓库 · 分支"、
            Git 页自己的 Tag 行、改动集上方的"当前写入锁"、lastOp 成功提示。 */}
        <div className="fg-statusbar">
          <span>{project.isGit ? 'Git 仓库' : '非 Git 目录 · 改动按整目录快照记录'}</span>
          {isGit && git ? (
            <>
              <span className="fg-sep" />
              <span className="mono-sm">{git.currentBranch}</span>
              <span className="fg-sep" />
              {/* 领先与落后**同时存在时必须都写出来**。
                  原来写成三元的 if/else，落后的时候就把领先吃掉（反之亦然），
                  于是"既领先 2 又落后 3"被显示成"领先 2"。 */}
              <span>
                {curBranch?.upstream == null
                  ? (git?.remotes.length ?? 0) > 0 ? '没有上游分支（远端已配置，可推送/拉取）' : '没有上游分支'
                  : curBranch.ahead == null || curBranch.behind == null
                    ? `${curBranch.upstream}（领先/落后未知——rev-list 未取得）`
                    : (() => {
                      const parts: string[] = [];
                      if (curBranch.ahead > 0) parts.push(`领先 ${curBranch.ahead}`);
                      if (curBranch.behind > 0) parts.push(`落后 ${curBranch.behind}`);
                      return parts.length > 0 ? parts.join(' · ') : '与远端一致';
                    })()}
              </span>
              <span className="fg-sep" />
              <span title="工作区改动文件数">{changedFileCount} 个未提交改动</span>
            </>
          ) : null}
          {lock ? (
            <>
              <span className="fg-sep" />
              <span title={`${lock.ownerTaskLabel} 持有 ${lock.lockDomain}；其他需要写入的任务会排队，不会并发绕开单写者`}>
                锁：{lock.ownerTaskLabel} 持有
              </span>
            </>
          ) : null}
          {git?.lastOp?.ok ? (
            <>
              <span className="fg-sep" />
              {/* 成功态也把真实结果说清楚（detail 是动作的结果），不写一个孤零零的"成功" */}
              <span title={`${git.lastOp.op} · ${relTime(git.lastOp.at)}`}>
                {git.lastOp.detail} · {relTime(git.lastOp.at)}
              </span>
            </>
          ) : null}
        </div>

        {git?.readErrors != null && Object.keys(git.readErrors).length > 0 ? (
          <div className="panel warning" style={{ marginBottom: 10 }} data-zs-git-read-errors="1">
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> Git 部分信息读取失败</div>
            {git.readErrors.status != null ? <div>仓库状态：{git.readErrors.status}（保留上次确认事实）</div> : null}
            {git.readErrors.branches != null ? <div>分支：{git.readErrors.branches}（保留上次已确认列表）</div> : null}
            {git.readErrors.history != null ? <div>历史：{git.readErrors.history}（保留上次已确认列表）</div> : null}
            {git.readErrors.remotes != null ? <div>远端：{git.readErrors.remotes}（保留上次已确认列表）</div> : null}
          </div>
        ) : null}

        {/* R71：普通非 Git 目录=中性形态（不是失败）——一行说明即可；文件阅读照常。 */}
        {git?.notARepo ? (
          <div className="panel info" style={{ marginBottom: 14 }} data-zs-git-neutral="1">
            <div className="panel-title"><Icon name="info" size={13} /> 此文件夹未初始化 Git</div>
            <span className="small faint">普通目录是受支持的项目形态——文件树与预览不受影响；Git 页的历史/差异/提交操作需要 Git 仓库。</span>
          </div>
        ) : null}

        {/* 失败不静默（§16.5）：成功态已收进状态条一行，失败才占一块说清-
            楚。真实 Git 执行错误/权限/目录失效仍在此（NOT_A_GIT_REPO 已分流为上方中性态）。 */}
        {git?.lastOp && !git.lastOp.ok ? (
          <div className="panel danger" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> {gitOperationLabel(git.lastOp.op)}{git.lastOp.outcome === 'unknown' ? '结果待确认' : '未完成'}</div>
            {git.lastOp.detail}
            <span className="small faint"> · {relTime(git.lastOp.at)}</span>
            <button className="btn ghost sm" onClick={() => void refreshGitState(projectId)}>刷新仓库事实</button>
          </div>
        ) : null}

        {tab === 'git' ? <PendingGitOperations projectId={projectId}/> : null}
        {project.status === 'missing' ? (
          <div className="panel warning" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 项目目录失效</div>
            路径 {project.rootPath} 当前不可访问。历史记录仍可查看，但读取文件与 Git 操作会失败；
            请在顶栏项目菜单里重新定位目录。
          </div>
        ) : null}

        {tab === 'files' ? (
          /**
           * 文件工作区（L5，§17.9 第 2 条）：左侧目录树 + **右侧共享预览**。
           *
           * 这里原来有一套自己的预览壳（卡头 + `<pre>`），与房间/线程那套
           * 并行存在 —— 于是版本徽标、来源行、引用入口只长在其中一套上。
           * 现在选中节点即调用 `openWorktreeNode` 把内容交给**同一个** PreviewPane。
           */
          <div className={`fg-body${narrow ? ' narrow' : ''}`} data-pane={pane}>
            {/* 左：目录树 / 改动集 二选一。
                头部（标题 + 视图切换）常驻在 pane 里，不会被内容滚走。 */}
            <div className="fg-pane fg-pane-list">
              <div className="fg-pane-head">
                <div className="card-title row tight">
                  <Icon name="folder" size={13} /> 项目文件
                  <span className="count">{fileCount}</span>
                  <div className="spacer" />
                  {/* 真实目录标注：来自用户项目磁盘（project.files.list 安全根内只读列举）。 */}
                  <span className="small faint" title="项目目录，点击文件可预览">
                    <Icon name="info" size={11} /> 真实目录
                  </span>
                </div>
                <Segmented<'tree' | 'changes'>
                  value={leftTab}
                  onChange={(v) => { setLeftTab(v); backToList(); }}
                  options={[
                    { value: 'tree', label: '目录树' },
                    /* 「改动 N」→「改动集 N」：这里是**改动集的数量**，
                       不是改动文件数，也不是待提交数。 */
                    { value: 'changes', label: formalChanges.items===null?'改动集 · 未读取':`改动集 · 最近 ${formalChanges.items.length} 项` },
                  ]}
                />
              </div>

              {/* 左栏唯一滚动容器：目录树很长时在这里滚，不影响右栏 */}
              <div className="fg-pane-scroll files-tree" ref={listRef}>
                {leftTab === 'changes' ? (
                  <FormalChangeList
                    facts={formalChanges}
                    selected={activeCs}
                    onSelect={(id) => { setCsId(id); openDetail(); }}
                  />
                ) : tree.error != null ? (
                  <div className="panel warning" style={{ margin: 8 }}>
                    目录读取失败：{userFacingSystemText(tree.error ?? '')}（点击刷新可重新读取）
                    <div className="panel-actions">
                      <button className="btn sm" onClick={() => tree.reload()}>重试</button>
                    </div>
                  </div>
                ) : tree.loading && tree.roots.length === 0 ? (
                  <div className="small faint" style={{ padding: 8 }}>正在读取项目目录…</div>
                ) : tree.roots.length === 0 ? (
                  <div className="small faint" style={{ padding: 8 }}>
                    {project.status === 'missing'
                      ? '目录失效，无法读取文件列表。'
                      : '这个项目目录为空。'}
                  </div>
                ) : (
                  <div className="file-tree">
                    {tree.roots.map((n) => (
                      <TreeNodeRow
                        key={n.path}
                        node={n}
                        expanded={expanded}
                        onToggle={toggleDir}
                        selectedPath={selected?.path}
                        onSelect={(node) => {
                          setSelected(node);
                          /**
                           * 选中即打开共享预览（§17.9）。真实链：登记工作区资源（真实路径/大小）
                           * → 预览面板经 project.file.read 实际读取内容（安全根内只读快照）。
                           * 只有**文件**节点才打开；目录节点不产生预览。
                           */
                          if (node.kind === 'file') {
                            openWorktreePreview(projectId,node.path,node.sizeBytes??0, {
                              target: { kind: 'files', projectId, view: 'files', selection: node.path },
                            });
                            openDetail();
                          }
                        }}
                        changedPaths={changedPaths}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* 右：目录树 → 共享预览；改动集 → 该改动集的详情（一次只做一件事） */}
            <div className="fg-pane fg-pane-detail">
              {/* 窄窗口：一次只显示一栏，给一条明确的回退路径 */}
              {narrow ? (
                <div className="fg-pane-head row">
                  <button className="btn ghost sm" onClick={backToList}>
                    <Icon name="arrow-left" size={12} /> 返回列表
                  </button>
                  <span className="small faint">
                    {leftTab === 'changes' ? '改动集详情' : selected?.path ?? '文件预览'}
                  </span>
                </div>
              ) : null}

              {leftTab === 'changes' ? (
                <div className="fg-pane-scroll" ref={detailRef}>
                  <FormalChangeDetail key={`${projectId}:${activeCs}`} projectId={projectId} entry={formalChanges.items?.find(c=>c.changeSetId===activeCs)} />
                </div>
              ) : selected ? (
                /*
                 * 共享预览直接当右栏的滚动宿主：它内部的 .preview-body 就是那
                 * 一条滚动条，外面**不再套一层** —— 右栏只有一个主要纵向
                 * 滚动容器，长行由 .preview-diff-body 横向滚。
                 */
                <div className="fg-pane-body">
                  <PreviewPane
                    context={{ kind: 'files', projectId, view: 'files', selection: selected.path }}
                    quoteTarget={{ draftKey: `files:${projectId}`, label: '选择讨论位置' }}
                    className="files-preview-pane"
                    /*
                     * 必须给 showEmpty：共享预览在"没有标签"时会 return null，
                     * 而那个 return 在它自己的 hooks 之前 —— 文件页关掉最后一个
                     * 标签就会触发 React #300（Rendered fewer hooks than expected）
                     * 把整页打崩。给 showEmpty 后它渲染空态，右栏结构也保持稳定。
                     */
                    showEmpty
                  />
                </div>
              ) : (
                <div className="fg-pane-scroll">
                  <div className="small faint">
                    从左侧选择一个文件查看内容 —— 选中后进入共享预览区
                    （与房间、线程、私信用的是同一个预览器）。
                    目录可以展开；带标记的文件是本任务改动过的。
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <GitPage
            projectId={projectId}
            embedded
            narrow={narrow}
            onRequestBranch={() => setBranchModal(true)}
          />
        )}
      </div>

      {/* 「新建分支」只有一份：页头「分支」按钮与 Git 页分支区的按钮都打开它 */}
      {branchModal && isGit ? (
        <NewBranchModal
          projectId={projectId}
          base={git?.commits[0]?.shortHash ?? '(空仓库)'}
          onClose={() => setBranchModal(false)}
        />
      ) : null}
    </div>
  );
}

/* ============================================================
   文件与改动（§14）
   ============================================================ */

/* ---------------- 改动集：列表与详情拆开 ----------------
   合页改造后两者分别住在左右两栏（左选择、右详情），所以拆成两个组件；
   独立页再由 ChangesPage 组合起来，不复制两份数据（§4）。 */

/** 左栏：一张卡片一个改动集 */
export function ChangeSetList({
  projectId, activeId, onSelect,
}: {
  projectId: string;
  activeId?: string;
  onSelect: (id: string) => void;
}) {
  const s = useStore((x) => x);
  const taskIds = s.tasks.filter((t) => t.projectId === projectId).map((t) => t.id);
  const sets = s.changeSets.filter((c) => taskIds.includes(c.taskId));
  if (sets.length === 0) {
    return <div className="small faint" style={{ padding: '2px 8px 6px' }}>这个项目还没有改动集。</div>;
  }
  return (
    <div className="col" style={{ gap: 6 }}>
      {sets.map((c) => {
        const title = s.tasks.find((t) => t.id === c.taskId)?.title ?? c.taskId;
        return (
          <button
            key={c.id}
            type="button"
            className={`card tight${c.id === activeId ? ' selected' : ''}`}
            style={{
              width: '100%', textAlign: 'left', cursor: 'pointer',
              borderColor: c.id === activeId ? 'var(--accent)' : undefined,
            }}
            onClick={() => onSelect(c.id)}
            title={title}
          >
            <div className="row tight">
              <Icon name="diff" size={13} className="faint" />
              <span
                className="strong"
                style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {title}
              </span>
            </div>
            <div className="row tight wrap small faint" style={{ marginTop: 6 }}>
              <Tag
                tone={c.applicationStatus === 'reverted' ? 'neutral' : c.applicationStatus === 'applied' ? 'success' : 'warning'}
                icon={c.applicationStatus === 'reverted' ? 'corner-up-left' : c.applicationStatus === 'applied' ? 'check-circle' : 'eye'}
                title="文件应用状态；人工验收请看任务交付"
              >
                {c.applicationStatus === 'reverted' ? '已还原' : c.applicationStatus === 'applied' ? '已应用' : c.applicationStatus === 'partial' ? '部分应用' : '未应用'}
              </Tag>
              <span>{c.files.length} 文件</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** 右栏：当前选中改动集的详情（diff 默认收起） */
export function ChangeSetDetail({ projectId, setId }: { projectId: string; setId?: string }) {
  const s = useStore((x) => x);
  const taskIds = s.tasks.filter((t) => t.projectId === projectId).map((t) => t.id);
  const sets = s.changeSets.filter((c) => taskIds.includes(c.taskId));
  /** 撤销是破坏性且可能部分失败的操作，必须二次确认并列出影响范围 */
  const [revertConfirm, setRevertConfirm] = useState<string | null>(null);
  const [openDiff, setOpenDiff] = useState<string[]>([]);
  const active = sets.find((c) => c.id === setId) ?? sets[0];
  const toggleDiff = (k: string) =>
    setOpenDiff((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  /** 展开态不跨改动集 / 项目泄漏：换了对象就收起 */
  useEffect(() => { setOpenDiff([]); }, [active?.id, projectId]);

  if (!active) {
    return (
      <div className="card">
        <EmptyState icon="diff" title="还没有改动" detail="任务修改项目文件后，这里会按改动集展示基线与 diff。" />
      </div>
    );
  }

  const taskTitle = s.tasks.find((t) => t.id === active.taskId)?.title ?? active.taskId;

  return (
    <>
      <div className="card">
        {/*
          先回答"这是什么"：任务名 → 改动集标识 → 文件数 → 应用状态。
          引用类细节（beforeRef / afterRef / workspaceId）是排查时才看的，
          降到下面的次要区，不再抢占第一行。
        */}
        <div className="row tight wrap">
          <Icon name="diff" size={14} className="faint" />
          <span className="strong" style={{ fontSize: 13 }}>{taskTitle}</span>
          <Tag plain icon="layers" title="改动集标识">{active.id}</Tag>
          <span className="small faint">{active.files.length} 个文件</span>
          <Tag
            tone={active.applicationStatus === 'reverted' ? 'neutral' : active.applicationStatus === 'applied' ? 'success' : 'warning'}
            icon={active.applicationStatus === 'reverted' ? 'corner-up-left' : active.applicationStatus === 'applied' ? 'check-circle' : 'eye'}
            title="文件应用状态；人工验收请看任务交付"
          >
            {active.applicationStatus === 'reverted' ? '已还原' : active.applicationStatus === 'applied' ? '已应用' : active.applicationStatus === 'partial' ? '部分应用' : '未应用'}
          </Tag>
        </div>

        {/* 文件应用状态（v1.12 §10.5）：这里**只**报告"文件是否已写入"，
            不再承担验收职责 —— 验收只属于任务交付（taskDeliveries），本页改为指过去。 */}
        <div className="small faint" style={{ marginBottom: 8 }}>
          {active.applicationStatus === 'applied'
            ? '这些改动已经写入项目目录。文件应用状态与人工验收是两件事，验收在任务交付里。'
            : active.applicationStatus === 'reverted'
              ? '这些改动已按前像还原。'
              : active.applicationStatus === 'partial'
                ? '这些改动部分应用成功。'
                : '这些改动尚未应用到项目目录。'}
        </div>

        <div className="panel-actions">
          <button className="btn ghost sm" onClick={() => toast('演示界面无法打开外部编辑器', 'info')}>
            <Icon name="external-link" size={12} /> 用外部编辑器打开
          </button>
          {/* 指向所属任务交付（唯一验收入口）。无交付时不显示，不伪造入口。 */}
          {(() => {
            const d = s.taskDeliveries.find((x) => x.changeSetRefs.includes(active.id));
            if (!d) return null;
            const t = s.tasks.find((x) => x.id === d.taskId);
            const thread = t ? s.threads.find((x) => x.id === t.conversationThreadId) : undefined;
            return (
              <button
                className="btn sm"
                onClick={() => {
                  recordWrite('task.delivery.get', `changeSet=${active.id} → delivery=${d.id} revision=${d.revision}`);
                  if (thread) {
                    navigate(`/project/${projectId}/room/${thread.roomId}?thread=${thread.id}&tab=delivery`);
                  }
                }}
                title="跳到该改动所属任务的交付详情；验收针对整个交付，不针对单个改动集"
              >
                <Icon name="corner-down-right" size={12} /> 查看所属交付
                {d.status === 'pending' ? ' · 待验收' : d.status === 'accepted' ? ' · 已验收' : ''}
              </button>
            );
          })()}
          {/* 桥到 Git 页：把该改动集的文件按归属暂存。
              只暂存本改动集的文件，不碰用户自己的改动（§14.2）。 */}
          {s.git[projectId] ? (
            <button
              className="btn sm"
              onClick={() => {
                stageByOwner(projectId, { changeSetId: active.id });
                navigate(`/project/${projectId}/files?tab=git`);
              }}
              title="只暂存本改动集的文件；你自己的未提交改动不会被一起提交"
            >
              <Icon name="git-commit" size={12} /> 暂存到 Git
            </button>
          ) : null}
          {/* 撤销是破坏性操作：降到次级，并先说明影响范围 */}
          <button
            className="btn danger sm"
            onClick={() => setRevertConfirm(active.id)}
            disabled={active.applicationStatus === 'reverted'}
          >
            <Icon name="corner-up-left" size={12} /> 撤销这些改动…
          </button>
        </div>
        <div className="small faint" style={{ marginTop: 8 }}>
          停止 ≠ 撤销。停止只取消后续派发并保留已产生的文件；撤销是带版本检查的独立操作，
          要求文件仍匹配 after_ref，否则不会执行无条件还原。
        </div>

        {/*
          引用细节是**次要**信息：降到小字、弱色，排在主信息之后，不再占首屏第一行。
          但**不折叠隐藏** —— 前像到底是 git ref 还是整目录快照是一条如实披露
          （§14.3 / RT-26⑫），藏起来等于让评审看到"没有前像"的假象。
        */}
        <div className="cs-refs">
          <div className="cs-refs-title">基线引用与工作区标识</div>
          <dl className="kv">
            <dt>基线前像</dt><dd className="mono-sm">{active.beforeRef}</dd>
            <dt>改动后</dt><dd className="mono-sm">{active.afterRef}</dd>
            <dt>工作区</dt><dd className="mono-sm">{active.workspaceId}</dd>
          </dl>
        </div>
      </div>

      {active.files.length === 0 ? (
        <div className="card"><div className="panel">这次运行没有产生文件改动。</div></div>
      ) : (
        <>
          <div className="row tight wrap" style={{ marginTop: 2 }}>
            <span className="section-title" style={{ margin: 0 }}>
              <Icon name="file-text" size={13} /> 改动文件
              <span className="count">{active.files.length}</span>
            </span>
            <div className="spacer" />
            {/* 一个改动集可能有多个文件：保留逐文件折叠 + 批量展开收起 */}
            <button
              className="btn ghost sm"
              onClick={() => setOpenDiff(active.files.map((f) => f.path))}
            >
              全部展开
            </button>
            <button className="btn ghost sm" onClick={() => setOpenDiff([])}>全部收起</button>
          </div>
          {active.files.map((f) => {
          const open = openDiff.includes(f.path);
          return (
            <div key={f.path} className="card" style={{ padding: 0 }}>
              <div className="row tight" style={{ padding: '9px 12px', borderBottom: open ? '1px solid var(--border)' : 'none', flexWrap: 'wrap' }}>
                <Icon name="file-text" size={14} className="faint" />
                <span className="mono" style={{ fontSize: 12 }}>{f.path}</span>
                <Tag
                  tone={f.change === 'added' ? 'success' : f.change === 'deleted' ? 'danger' : 'warning'}
                  icon={f.change === 'added' ? 'plus' : f.change === 'deleted' ? 'minus' : 'edit'}
                >
                  {f.change === 'added' ? '新增' : f.change === 'deleted' ? '删除' : f.change === 'renamed' ? '重命名' : '修改'}
                </Tag>
                {f.additions > 0 ? <span className="small" style={{ color: 'var(--success)' }}>+{f.additions}</span> : null}
                {f.deletions > 0 ? <span className="small" style={{ color: 'var(--danger)' }}>−{f.deletions}</span> : null}
                {/* 原来这两条各占一整块 panel，与 Tag 说的是同一件事；
                    现在收成文件行里的 Tag（解释进 tooltip），完整说明只在展开 diff 时给一行。 */}
                {f.userPreExisting ? (
                  <Tag tone="warning" icon="user" title="这个文件在你发起任务之前就有未提交修改；任务不会覆盖它">
                    你在任务开始前改过
                  </Tag>
                ) : null}
                {f.cannotRevert ? (
                  <Tag tone="danger" icon="alert-triangle" title="超过前像上限，只记录了引用，无法内容级撤销；其它文件不受影响">
                    超过前像上限
                  </Tag>
                ) : null}
                <div className="spacer" />
                <button className="btn ghost sm" onClick={() => toggleDiff(f.path)}>
                  <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
                  {open ? '收起 diff' : '展开 diff'}
                </button>
              </div>

              {open ? (
                <>
                  {f.userPreExisting || f.cannotRevert ? (
                    <div className="small faint" style={{ padding: '8px 12px 0' }}>
                      {f.userPreExisting
                        ? '这个文件在你发起任务之前就有未提交修改。diff 会正确区分任务改动与你的原有修改，任务不会覆盖你已有的改动。'
                        : null}
                      {f.cannotRevert
                        ? '该文件超过前像上限（非 Git 目录使用整目录快照做内容级前像，超限大文件只能记录引用）。可以撤销的其它文件不受影响。'
                        : null}
                    </div>
                  ) : null}
                  {f.diff.length > 0 ? (
                    <div className="diff-view">
                      {f.diff.map((h, hi) => (
                        <div key={hi}>
                          <div className="diff-hunk-head">{h.header}</div>
                          {h.lines.map((l, li) => (
                            <div key={li} className={`diff-line ${l.type}`}>
                              <span className="diff-no">{l.oldNo ?? ''}</span>
                              <span className="diff-no">{l.newNo ?? ''}</span>
                              <span className="diff-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                              <span className="diff-text">{l.text}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ) : !f.cannotRevert ? (
                    <div className="small faint" style={{ padding: '8px 12px' }}>
                      该文件没有可展示的文本 diff（二进制或大文件）。
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          );
          })}
        </>
      )}

      {/* 撤销确认：列出真实影响范围，并预告无法内容级还原的文件 */}
      {revertConfirm ? (() => {
        const cs = sets.find((c) => c.id === revertConfirm);
        if (!cs) return null;
        const blocked = cs.files.filter((f) => f.cannotRevert);
        const pre = cs.files.filter((f) => f.userPreExisting);
        return (
          <Modal
            size="sm"
            title="撤销这些改动"
            subtitle="撤销是带版本检查的操作，不等于「停止」"
            onClose={() => setRevertConfirm(null)}
            footer={
              <>
                <div className="spacer" />
                <button className="btn" onClick={() => setRevertConfirm(null)}>取消</button>
                <button
                  className="btn"
                  disabled
                  title="本页暂不支持撤销文件改动。已提交的改动可到 Git 页撤销提交。"
                >
                  <Icon name="corner-up-left" size={12} /> 确认撤销（未接入）
                </button>
              </>
            }
          >
            <div className="panel danger">
              <div className="panel-title"><Icon name="alert-triangle" size={13} /> 影响范围</div>
              将按任务开始前的内容前像还原 <strong>{cs.files.length - blocked.length}</strong> 个文件。
              要求文件仍匹配 <code>{cs.afterRef}</code>，否则不会执行无条件还原。
            </div>
            {blocked.length > 0 ? (
              <div className="panel warning" style={{ marginTop: 10 }}>
                <div className="panel-title"><Icon name="alert-triangle" size={13} /> {blocked.length} 个文件无法内容级撤销</div>
                超过前像上限，只记录了引用：{blocked.map((f) => f.path).join('、')}
              </div>
            ) : null}
            {pre.length > 0 ? (
              <div className="panel" style={{ marginTop: 10 }}>
                <div className="panel-title"><Icon name="info" size={13} /> {pre.length} 个文件是你在任务开始前改的</div>
                这些属于你的原有改动，不会被任务撤销误伤。
              </div>
            ) : null}
          </Modal>
        );
      })() : null}
    </>
  );
}

/** 独立页（/changes 已重定向到合页，这里保留组合形态供深链与后续使用） */
export function ChangesPage({ projectId, embedded }: { projectId: string; embedded?: boolean }) {
  const s = useStore((x) => x);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const taskIds = s.tasks.filter((t) => t.projectId === projectId).map((t) => t.id);
  const sets = s.changeSets.filter((c) => taskIds.includes(c.taskId));
  return (
    <div className={embedded ? '' : 'main'}>
      {/* 独立页也用 .fg-page：页面自身不滚动，高度交给下面两栏各自滚动 */}
      <div className={embedded ? '' : 'page fg-page'}>
        {/* 合页模式下页头由 FilesGitPage 提供，这里只给小节标题，避免两层页头。 */}
        {embedded ? (
          <div className="section-title" style={{ marginBottom: 10 }}>
            <Icon name="diff" size={13} /> 本项目的任务改动集
            <span className="count">{sets.length}</span>
          </div>
        ) : (
          <div className="page-head">
            <div>
              {/* 标题已按用户要求删除（2026-09-26），保留路径与下面的锁域/分支标签。 */}
              <div className="page-sub mono">{s.projects.find((p) => p.id === projectId)?.canonicalPath}</div>
              <div className="row tight wrap" style={{ marginTop: 8 }}>
                <Tag plain icon="lock">同一目录中的文件修改依次执行</Tag>
                {s.projects.find((p) => p.id === projectId)?.isGit
                  ? <Tag plain icon="git-branch">{s.projects.find((p) => p.id === projectId)?.gitBranch}</Tag>
                  : <Tag plain icon="folder">非 Git 目录</Tag>}
              </div>
            </div>
          </div>
        )}

        {/* 合页模式下锁已经在页头状态条里说过一遍（P0），这里不再重复渲染整块面板 */}
        {!embedded && lockOfProject(s, projectId) ? (
          <div className="panel warning" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="lock" size={13} /> 当前写入锁</div>
            {lockOfProject(s, projectId)!.ownerTaskLabel} 持有 {lockOfProject(s, projectId)!.lockDomain}。
            其他需要写入的任务会排队并显示锁持有者，不会并发绕开单写者。
          </div>
        ) : null}

        <div className="git-layout">
          <div className="git-list">
            <ChangeSetList projectId={projectId} activeId={activeId} onSelect={setActiveId} />
          </div>
          <div className="git-detail">
            <ChangeSetDetail projectId={projectId} setId={activeId} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   成员总览
   ============================================================ */

/**
 * 成员管理（第十五批 §17.7 第 6 条）。
 *
 * 项目选择与顶栏**同源**：切换后仅显示目标项目的 ProjectMember，
 * 并同步 activeProjectId 与路由。同一个 profile/runtime 被多个项目使用时，
 * 成员身份与私信会话不能合并 —— 所以这里按 projectId 过滤，不做跨项目合并列表。
 */
