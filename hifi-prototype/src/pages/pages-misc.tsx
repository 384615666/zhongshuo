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
import {
  Avatar, ConsensusTag, CostText, EmptyState, ErrorState, Modal, Switch, Tag, memberColor,
  hostClass, type DetailHost,
} from '../components/ui';
import { useStore, toast, recordWrite } from '../data/store';
import { byId, lockOfProject, memberLabel, runtimeOfMember } from '../data/selectors';
import {
  clearMemberSession, configureMember, createMember, exportArtifact, revertChangeSet,
} from '../data/actions';
import { consensusLabel, formatBytes, formatDuration, fullTime } from '../lib/format';
import { stageByOwner } from '../data/actions-git';
import { focusProject, rememberFileGitTab, resolveFileGitTab } from '../data/actions-nav';
import { buildTree, fileSizeLabel, mockTreeOf, type TreeNode } from '../data/mock-tree';
import { navigate } from '../lib/router';
import { GitPage } from './GitPage';
/* UX-PREVIEW-01：文件与 Git 复用共享预览（§17.9 第 2 条） */
import { PreviewPane } from '../components/PreviewPane';
import { openWorktreeNode } from '../data/actions-preview';
import type { ProjectMember } from '../data/types';

/*
 * 设置相关的东西（错误码表、写入策略、循环预算、局域网配对、提醒）已全部迁到
 * ./SettingsPage.tsx。提醒进一步搬到了「待我处理」页（见 pages-secondary.tsx）。
 * 这里不再导入 setTaskReviewEnabled / setWriteConcurrencyPolicy / updateLoopSettings /
 * errorCopy / ErrorCode / toggleReminder / createReminder 等 —— tsconfig 开了
 * noUnusedLocals，留着会直接构建失败。
 */

/* ============================================================
   成果预览（§17.2 成果预览 / §6.6 报告模板）
   ============================================================ */

export function ArtifactPage({ artifactId, host }: { artifactId: string; host?: DetailHost }) {
  const s = useStore((x) => x);
  const a = s.artifacts.find((x) => x.id === artifactId);
  const [exportOpen, setExportOpen] = useState(false);

  if (!a) {
    return (
      <div className={hostClass(host, 'main')}>
        <div className={hostClass(host, 'page')}>
          <ErrorState
            code="ARTIFACT_MISSING"
            detail="成果对象不存在或已被清理。界面不会展示空白成功页。"
            actions={<button className="btn sm" onClick={() => navigate('/activity')}>回到待我处理</button>}
          />
        </div>
      </div>
    );
  }

  const task = s.tasks.find((t) => t.id === a.taskId);
  const thread = s.threads.find((t) => t.id === a.threadId);
  const author = byId(s.members, a.authorId);
  const report = a.report;

  return (
    <div className={hostClass(host, 'main')}>
      <div className={host === 'panel' ? 'page as-panel-page narrow' : 'page narrow'}>
        <div className="page-head">
          <div style={{ minWidth: 0 }}>
            <div className="row tight wrap">
              <Tag tone="accent" icon="file-text">{a.kind === 'report' ? '报告' : '附件'}</Tag>
              <Tag plain>R{a.revision}</Tag>
              {report ? <ConsensusTag consensus={report.consensus} /> : null}
            </div>
            <div className="page-title" style={{ marginTop: 8 }}>{a.title}</div>
            <div className="row tight wrap small faint" style={{ marginTop: 6 }}>
              <span>作者 {memberLabel(author)}</span>
              <span>· {fullTime(a.createdAt)}</span>
              <span>· {formatBytes(a.sizeBytes)}</span>
              <span className="mono-sm">{a.hash}</span>
            </div>
          </div>
          <div className="page-head-actions">
            <button
              className="btn sm"
              onClick={() => thread && navigate(`/project/${s.activeProjectId}/room/${thread.roomId}?thread=${thread.id}`)}
            >
              <Icon name="message-square" size={12} /> 回到来源串
            </button>
            {task && thread ? (
              <button
                className="btn sm"
                onClick={() =>
                  navigate(`/project/${s.activeProjectId}/room/${thread.roomId}?thread=${thread.id}&tab=task`)
                }
              >
                <Icon name="list" size={12} /> 任务详情
              </button>
            ) : null}
            <button className="btn primary sm" onClick={() => setExportOpen(true)}>
              <Icon name="download" size={12} /> 导出
            </button>
          </div>
        </div>

        {report ? (
          <>
            <div className="panel info" style={{ marginBottom: 16 }}>
              <div className="panel-title"><Icon name="scale" size={13} /> 共识状态：{consensusLabel(report.consensus)}</div>
              共识状态由程序按成员对同一结论修订版的确认记录计算，主持者不能单方面改写。
              达到预算上限时仍生成诚实的整合报告，绝不伪造缺席者的意见。
            </div>

            <ReportSection title="1 · 任务目标与参与者">
              <dl className="kv">
                <dt>目标</dt><dd>{report.goal}</dd>
                <dt>参与者</dt><dd>{report.participants}</dd>
                <dt>实际参与</dt><dd>{report.actualParticipation}</dd>
              </dl>
            </ReportSection>

            <ReportSection title="2 · 项目基线与资料范围">
              <div className="mono-sm" style={{ lineHeight: 1.8 }}>{report.baseline}</div>
              <div className="small faint" style={{ marginTop: 6 }}>
                所有成员分析同一份文件内容（baselineId），而不是仅共享相同路径。
              </div>
            </ReportSection>

            <ReportSection title="3 · 共同确认的结论及证据">
              {report.confirmed.map((c, i) => (
                <div key={i} className="subtask-row">
                  <Icon name="check-circle" size={14} style={{ color: 'var(--success)', marginTop: 3 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="small strong">{c.statement}</div>
                    <div className="small faint" style={{ marginTop: 2 }}>证据：{c.evidence}</div>
                  </div>
                </div>
              ))}
            </ReportSection>

            <ReportSection title="4 · 建议执行方案">
              <ol style={{ paddingLeft: 18, listStyle: 'decimal' }}>
                {report.plan.map((p, i) => (
                  <li key={i} className="small" style={{ marginBottom: 4, lineHeight: 1.7 }}>{p}</li>
                ))}
              </ol>
            </ReportSection>

            <ReportSection title="5 · 分歧、条件与需要你决定的事项">
              {report.disputes.length === 0 ? (
                <div className="small faint">没有未解决分歧。</div>
              ) : (
                report.disputes.map((d, i) => (
                  <div key={i} className="panel warning" style={{ marginBottom: 8 }}>
                    <div className="panel-title"><Icon name="scale" size={13} /> {d.statement}</div>
                    {d.detail}
                  </div>
                ))
              )}
              <button className="btn sm" onClick={() => navigate('/activity')}>
                <Icon name="inbox" size={12} /> 到「待我处理」做取舍
              </button>
            </ReportSection>

            <ReportSection title="6 · 验证记录、局限与未完成检查">
              <table className="tbl">
                <thead>
                  <tr><th>验证项</th><th style={{ width: 260 }}>结果</th></tr>
                </thead>
                <tbody>
                  {report.verification.map((v, i) => (
                    <tr key={i}>
                      <td className="small">{v.item}</td>
                      <td className="small">
                        {v.result.startsWith('未执行') ? (
                          <span className="row tight"><Icon name="alert-triangle" size={12} style={{ color: 'var(--warning)' }} />{v.result}</span>
                        ) : (
                          <span className="row tight"><Icon name="check-circle" size={12} style={{ color: 'var(--success)' }} />{v.result}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="small faint" style={{ marginTop: 8 }}>
                模型说"测试通过"不会直接生成测试成功状态，必须关联真实执行记录。涉及代码的交付包含变更摘要、
                文件列表、已执行与未执行的验证及原因、残余问题。
              </div>
            </ReportSection>

            <ReportSection title="7 · 过程记录链接">
              <div className="col" style={{ gap: 6 }}>
                {report.links.map((l, i) => (
                  <button key={i} className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={() => navigate(`/project/${s.activeProjectId}/room/${thread?.roomId ?? ''}?thread=${thread?.id ?? ''}&tab=artifacts&artifact=${l.ref}`)}>
                    <Icon name="file-text" size={12} /> {l.label}
                    <span className="spacer" />
                    <Icon name="chevron-right" size={12} />
                  </button>
                ))}
              </div>
            </ReportSection>
          </>
        ) : (
          <div className="panel">
            这是任务附件，不是结构化报告。附件摄取为本机不可变副本并记录 hash，
            避免原临时文件消失后报告失去依据。
          </div>
        )}
      </div>

      {exportOpen ? (
        <Modal
          size="sm"
          title="导出成果"
          subtitle="导出范围由你主动发起"
          onClose={() => setExportOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setExportOpen(false)}>取消</button>
              <button
                className="btn primary"
                onClick={() => {
                  exportArtifact(a.id, 'word');
                  setExportOpen(false);
                }}
              >
                导出
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">格式</label>
            <div className="col" style={{ gap: 6 }}>
              {([
                ['markdown', 'Markdown（基础格式）'],
                ['word', 'Word / HTML（决策 34，M3 批次）'],
              ] as const).map(([f, label]) => (
                <button key={f} className="btn" style={{ justifyContent: 'flex-start' }} onClick={() => { exportArtifact(a.id, f); setExportOpen(false); }}>
                  <Icon name="file-text" size={12} /> {label}
                </button>
              ))}
            </div>
          </div>
          <div className="panel">
            导出只包含这份成果的内容与你选择的格式，不会连带把其他任务的上下文或成员的私有草稿打包出去。
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function ReportSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      <div className="card">{children}</div>
    </div>
  );
}

/* ============================================================
   文件与 Git 合页（第十五批 §4 / §17.7）
   ============================================================ */

/** 一次渲染一个文件树节点（含子节点递归） */
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
        node.emptyDir && node.children.length === 0 ? (
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
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === projectId);

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

  /* ---- 文件树 ---- */
  const tree = useMemo(() => buildTree(mockTreeOf(projectId)), [projectId]);
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(mockTreeOf(projectId).filter((n) => n.kind === 'dir' && n.path.startsWith('src')).map((n) => n.path)),
  );
  const [selected, setSelected] = useState<TreeNode | null>(null);

  // 切项目时重置展开态与选中：A 项目的文件不该在 B 项目里"看起来还选中着"
  useEffect(() => {
    setExpanded(new Set(mockTreeOf(projectId).filter((n) => n.kind === 'dir' && n.path.startsWith('src')).map((n) => n.path)));
    setSelected(null);
  }, [projectId]);

  const toggleDir = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** 改动集里的文件路径 → 变更类型，用于在树上打标记 */
  const changedPaths = useMemo(() => {
    const m = new Map<string, string>();
    const taskIds = s.tasks.filter((t) => t.projectId === projectId).map((t) => t.id);
    for (const c of s.changeSets.filter((x) => taskIds.includes(x.taskId))) {
      for (const f of c.files) m.set(f.path, f.change);
    }
    return m;
  }, [s.changeSets, s.tasks, projectId]);

  const git = s.git[projectId];
  const isGit = Boolean(project?.isGit) && Boolean(git && git.branches.length > 0);

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
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">文件与 Git</div>
            <div className="page-sub mono">{project.canonicalPath}</div>
          </div>
        </div>

        {/* 项目选择与筛选行统一（左对齐、同一样式）。
            页内项目选择与顶栏是**同一个动作**（§17.7）：
            避免顶栏写"众说"、页面实际在操作另一个项目。 */}
        <div className="page-filters">
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
          <span className="filter-note">
            {project.isGit ? `Git 仓库 · ${project.gitBranch ?? ''}` : '非 Git 目录 · 改动按整目录快照记录'}
          </span>
        </div>

        {project.status === 'missing' ? (
          <div className="panel warning" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 项目目录失效</div>
            路径 {project.rootPath} 当前不可访问。历史记录仍可查看，但读取文件与 Git 操作会失败；
            请在顶栏项目菜单里重新定位目录。
          </div>
        ) : null}

        {/* 顶层两标签：文件 / Git。历史属于 Git 内部导航，不另加第三个顶层标签。 */}
        <div className="thread-tabs" style={{ marginBottom: 14 }}>
          <button className={`thread-tab${tab === 'files' ? ' on' : ''}`} onClick={() => setTab('files')}>
            <Icon name="file-text" size={13} /> 文件
          </button>
          <button className={`thread-tab${tab === 'git' ? ' on' : ''}`} onClick={() => setTab('git')}>
            <Icon name="git-branch" size={13} /> Git
            {git && git.status.length > 0 ? <span className="faint">{git.status.length}</span> : null}
            {!isGit ? <span className="faint">未初始化</span> : null}
          </button>
        </div>

        {tab === 'files' ? (
          /**
           * 文件工作区（L5，§17.9 第 2 条）：左侧目录树 + **右侧共享预览**。
           *
           * 这里原来有一套自己的预览壳（卡头 + `<pre>`），与房间/线程那套
           * 并行存在 —— 于是版本徽标、来源行、引用入口只长在其中一套上。
           * 现在选中节点即调用 `openWorktreeNode` 把内容交给**同一个** PreviewPane。
           */
          <div className="files-layout">
            {/* 左：目录树 */}
            <div className="files-tree card">
              <div className="card-title row tight" style={{ marginBottom: 8 }}>
                <Icon name="folder" size={13} /> 项目文件
                <div className="spacer" />
                <span className="small faint">mock 目录</span>
              </div>
              {tree.length === 0 ? (
                <div className="small faint" style={{ padding: 8 }}>
                  {project.status === 'missing'
                    ? '目录失效，无法读取文件列表。'
                    : '这个项目还没有可显示的文件。'}
                </div>
              ) : (
                <div className="file-tree">
                  {tree.map((n) => (
                    <TreeNodeRow
                      key={n.path}
                      node={n}
                      expanded={expanded}
                      onToggle={toggleDir}
                      selectedPath={selected?.path}
                      onSelect={(node) => {
                        setSelected(node);
                        /**
                         * 选中即打开共享预览（§17.9）。
                         *
                         * 只有**文件**节点才打开；目录节点不产生预览
                         * （目录不是可预览资源，给它造一个空预览会误导用户）。
                         */
                        if (node.kind === 'file') {
                          openWorktreeNode(
                            projectId,
                            node.path,
                            {
                              preview: node.preview,
                              notPreviewable: node.notPreviewable,
                              sizeBytes: node.sizeBytes,
                            },
                            {
                              target: {
                                kind: 'files', projectId, view: 'files',
                                selection: node.path,
                              },
                            },
                          );
                        }
                      }}
                      changedPaths={changedPaths}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* 右：共享预览（内容由 PreviewPane 渲染）+ 改动集 */}
            <div className="col" style={{ gap: 12, minWidth: 0, flex: 1 }}>
              {selected ? (
                <PreviewPane
                  context={{ kind: 'files', projectId, view: 'files', selection: selected.path }}
                  quoteTarget={{ draftKey: `files:${projectId}`, label: '选择讨论位置' }}
                  className="files-preview-pane"
                />
              ) : (
                <div className="card">
                  <div className="small faint">
                    从左侧选择一个文件查看内容 —— 选中后进入共享预览区
                    （与房间、线程、私信用的是同一个预览器）。
                    目录可以展开；带标记的文件是本任务改动过的。
                  </div>
                </div>
              )}

              {/* 改动集与 diff 复用（§4：不复制两份数据） */}
              <ChangesPage projectId={projectId} embedded />
            </div>
          </div>
        ) : (
          <GitPage projectId={projectId} embedded />
        )}
      </div>
    </div>
  );
}

/* ============================================================
   文件与改动（§14）
   ============================================================ */

export function ChangesPage({ projectId, embedded }: { projectId: string; embedded?: boolean }) {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === projectId);
  const taskIds = s.tasks.filter((t) => t.projectId === projectId).map((t) => t.id);
  const sets = s.changeSets.filter((c) => taskIds.includes(c.taskId));
  const [activeId, setActiveId] = useState(sets[0]?.id);
  /** 撤销是破坏性且可能部分失败的操作，必须二次确认并列出影响范围 */
  const [revertConfirm, setRevertConfirm] = useState<string | null>(null);
  const active = sets.find((c) => c.id === activeId) ?? sets[0];

  return (
    <div className={embedded ? '' : 'main'}>
      <div className={embedded ? '' : 'page'}>
        {/* 合页模式下页头由 FilesGitPage 提供，这里只给"当前项目改动集"小节标题，
            避免出现两层页头与重复的项目路径。 */}
        {embedded ? (
          <div className="section-title" style={{ marginBottom: 10 }}>
            <Icon name="diff" size={13} /> 本项目的任务改动集
            <span className="count">{sets.length}</span>
          </div>
        ) : (
          <div className="page-head">
            <div>
              <div className="page-title">文件与改动</div>
              <div className="page-sub mono">{project?.canonicalPath}</div>
              <div className="row tight wrap" style={{ marginTop: 8 }}>
                <Tag plain icon="lock">同一物理目录最多 1 个受管理写入者</Tag>
                {project?.isGit ? <Tag plain icon="git-branch">{project.gitBranch}</Tag> : <Tag plain icon="folder">非 Git 目录</Tag>}
              </div>
            </div>
          </div>
        )}

        {/* 写入锁必须取**当前项目**的（§10.3 锁域 = 同一物理原目录）。
            早先这里读全局 s.writeLock，导致看 notes-vault 的文件页时
            会显示众说任务 #13 的锁 —— 跨项目串状态。 */}
        {lockOfProject(s, projectId) ? (
          <div className="panel warning" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="lock" size={13} /> 当前写入锁</div>
            {lockOfProject(s, projectId)!.ownerTaskLabel} 持有 {lockOfProject(s, projectId)!.lockDomain}。
            其他需要写入的任务会排队并显示锁持有者，不会并发绕开单写者。
          </div>
        ) : null}

        {sets.length === 0 ? (
          <EmptyState icon="diff" title="还没有改动" detail="任务修改项目文件后，这里会按改动集展示基线与 diff。" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 300px) 1fr', gap: 16, alignItems: 'start' }}>
            <div className="col" style={{ gap: 8 }}>
              {sets.map((c) => (
                <div
                  key={c.id}
                  className={`card tight${c.id === active?.id ? ' selected' : ''}`}
                  style={{ cursor: 'pointer', borderColor: c.id === active?.id ? 'var(--accent)' : undefined }}
                  onClick={() => setActiveId(c.id)}
                >
                  <div className="row tight">
                    <Icon name="diff" size={14} className="faint" />
                    <span className="strong" style={{ fontSize: 12 }}>
                      {s.tasks.find((t) => t.id === c.taskId)?.title ?? c.taskId}
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
                </div>
              ))}
            </div>

            {active ? (
              <div>
                <div className="card" style={{ marginBottom: 12 }}>
                  <dl className="kv">
                    <dt>基线前像</dt><dd className="mono-sm">{active.beforeRef}</dd>
                    <dt>改动后</dt><dd className="mono-sm">{active.afterRef}</dd>
                    <dt>工作区</dt><dd className="mono-sm">{active.workspaceId}</dd>
                  </dl>

                  {/* 文件应用状态（v1.12 §10.5）：这里**只**报告"文件是否已写入"，
                      不再承担验收职责。
                      原实现在这里放了「验收通过 / 要求修改」，做的是：
                        - 把 changeSet.status 从 pending_review 改成 applied
                        - 把**整个任务**标成 DONE
                      两个问题：①一个任务可能有多个改动集，验收其中一个就把任务完结，
                      语义错位；②同类按钮在多页重复出现，会各自维护状态。
                      现在验收只属于任务交付（taskDeliveries），本页改为指过去。 */}
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
                    <button className="btn ghost sm" onClick={() => toast('原型不实际打开外部编辑器', 'info')}>
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
                        只暂存本改动集的文件，不碰用户自己的改动（§14.2）。
                        注意：这个入口**不依赖任务是否待验收** —— Git 流程与验收独立。 */}
                    {s.git[projectId] ? (
                      <button
                        className="btn sm"
                        onClick={() => {
                          stageByOwner(projectId, { changeSetId: active.id });
                          navigate(`/project/${projectId}/git`);
                        }}
                        title="只暂存本改动集的文件；你自己的未提交改动不会被一起提交"
                      >
                        <Icon name="git-commit" size={12} /> 暂存到 Git 并去提交
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
                </div>

                {active.files.length === 0 ? (
                  <div className="panel">这次运行没有产生文件改动。</div>
                ) : (
                  active.files.map((f) => (
                    <div key={f.path} className="card" style={{ marginBottom: 12, padding: 0 }}>
                      <div className="row tight" style={{ padding: '9px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
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
                        {f.userPreExisting ? <Tag tone="warning" icon="user">你在任务开始前已有改动</Tag> : null}
                        {f.cannotRevert ? <Tag tone="danger" icon="alert-triangle">超过前像上限</Tag> : null}
                      </div>

                      {f.userPreExisting ? (
                        <div className="panel warning" style={{ margin: 12 }}>
                          <div className="panel-title"><Icon name="alert-triangle" size={13} /> 不属于本次任务改动</div>
                          这个文件在你发起任务之前就有未提交修改。diff 会正确区分任务改动与你的原有修改，
                          任务不会覆盖你已有的改动。
                        </div>
                      ) : null}

                      {f.cannotRevert ? (
                        <div className="panel danger" style={{ margin: 12 }}>
                          <div className="panel-title"><Icon name="alert-triangle" size={13} /> 无法内容级撤销</div>
                          该文件超过前像上限（非 Git 目录使用整目录快照做内容级前像，超限大文件只能记录引用）。
                          可以撤销的其它文件不受影响。
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
                        <div className="small faint" style={{ padding: 12 }}>该文件没有可展示的文本 diff（二进制或大文件）。</div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>

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
                  className="btn danger"
                  onClick={() => {
                    revertChangeSet(cs.id);
                    setRevertConfirm(null);
                  }}
                >
                  <Icon name="corner-up-left" size={12} /> 确认撤销
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
export function MembersPage({ projectId }: { projectId?: string }) {
  const s = useStore((x) => x);
  const pid = projectId ?? s.activeProjectId;
  const project = s.projects.find((p) => p.id === pid);
  const members = s.members.filter((m) => m.projectId === pid);
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="main">
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">成员管理</div>
            <div className="page-sub">
              管理本项目的成员实例（模板、runtime、启停与私信入口）。
              与回复串里的「成员」tab 不同：那里只管某一条任务串的跟进名单。
            </div>
          </div>
        </div>

        {/* 项目选择与筛选行统一（左对齐、与其他页同一套控件样式）。
            "添加成员"是动作而不是筛选，放在筛选行右侧但仍在内容区左半部，
            不回到页头最右端。 */}
        <div className="page-filters">
          <label className="field inline">
            <span className="field-label">项目</span>
            <select
              className="select"
              value={pid}
              onChange={(e) => {
                const next = e.target.value;
                focusProject(next, { announce: false });
                navigate(`/project/${next}/members`);
              }}
            >
              {s.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          </label>
          <span className="filter-note">
            {members.length} 名成员 · 成员是项目级实例，同名成员不合并
          </span>
          {/* 「添加成员」是这个页面唯一的本页创建动作（页头没有其他主操作），
              按规范 §5.8/§7「empty 给一个主操作」应为**主按钮**。
              同一操作区（本筛选行）只有它一个 --grad，符合 §5.8 第 3 条。 */}
          <button className="btn primary sm" onClick={() => setAddOpen(true)}>
            <Icon name="user-plus" size={12} /> 添加成员
          </button>
        </div>

        {project?.status === 'missing' ? (
          <div className="panel warning" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 项目目录失效</div>
            成员记录仍可查看与配置，但让成员读写这个目录会失败。请先重新定位项目目录。
          </div>
        ) : null}

        {members.length === 0 ? (
          <EmptyState
            icon="users"
            title="这个项目还没有成员"
            detail="成员是项目级实例：同一个模板可以在多个项目里各建一个成员，身份与会话互不合并。"
          />
        ) : null}

        <div className="grid grid-2">
          {members.map((m) => {
            const rt = runtimeOfMember(s, m);
            const profile = byId(s.profiles, m.profileId);
            const runningTasks = s.tasks.filter((t) => t.ownerMemberId === m.id && ['ACTIVE', 'WAITING_USER'].includes(t.status));
            return (
              <div key={m.id} className="card" style={{ cursor: 'pointer' }} onClick={() => navigate(`/member/${m.id}`)}>
                <div className="row tight">
                  <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={36} state={m.workState} stateTitle={m.workStateReason} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row tight">
                      <span className="strong">{memberLabel(m)}</span>
                      {m.isCoordinatorDefault ? <Tag tone="accent" icon="star">默认协调者</Tag> : null}
                      {!m.enabled ? <Tag tone="neutral" icon="slash">已停用</Tag> : null}
                    </div>
                    <div className="small faint truncate">{profile?.description}</div>
                  </div>
                </div>
                <div className="row tight wrap" style={{ marginTop: 9 }}>
                  <Tag plain icon="cpu">{rt?.label ?? '未配置 runtime'}</Tag>
                  <Tag plain icon="sparkles">{m.model}</Tag>
                  <Tag plain>思考强度 {m.effort}</Tag>
                  {m.internalSubagents ? <Tag plain icon="layers">内部子助手开</Tag> : null}
                </div>
                <div className="small faint" style={{ marginTop: 8 }}>
                  {m.workStateReason}
                  {runningTasks.length > 0 ? ` · 负责任务 ${runningTasks.map((t) => `#${t.roomTaskNumber}`).join('、')}` : ''}
                </div>
              </div>
            );
          })}
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>可复用的成员模板</div>
        <div className="grid grid-3">
          {s.profiles.map((p) => {
            const rt = byId(s.runtimeInstallations, p.runtimeInstallationId);
            const used = s.members.filter((m) => m.profileId === p.id).length;
            return (
              <div key={p.id} className="card tight">
                <div className="strong">{p.name}</div>
                <div className="small faint" style={{ marginTop: 3 }}>{p.description}</div>
                <div className="row tight wrap" style={{ marginTop: 8 }}>
                  <Tag plain icon="cpu">{rt?.label}</Tag>
                  <Tag plain>{used} 个实例</Tag>
                </div>
              </div>
            );
          })}
        </div>

        <div className="panel" style={{ marginTop: 18 }}>
          <div className="panel-title"><Icon name="info" size={13} /> 三类身份不要混用</div>
          Profile 是成员模板，ProjectMember 是项目内身份，RuntimeInstallation 是执行程序。
          一个成员跨项目使用时是不同实例；会话按项目、线程、成员、执行任务与会话代次隔离，
          不会复用整个房间的一条长会话。
        </div>
      </div>

      {addOpen ? (
        <AddMemberDialog
          projectId={pid}
          projectName={project?.displayName ?? ''}
          existingMembers={members}
          onClose={() => setAddOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * 新增成员对话框（AGENT-01）。
 *
 * 表单字段按 §3.2 的分层来分：**runtime 属于模板（Profile）**，
 * **模型与思考强度属于成员实例（ProjectMember）** —— 所以界面上分两组显示，
 * 而不是混成一排，避免实现时把三者当成同一个东西。
 *
 * 三处如实告知（不制造假成功）：
 *  1. runtime 未就绪时**仍然允许创建**，但明确写出"建好后还不能派工"及原因；
 *  2. 新成员**不会自动成为协调者**（协调者是房间级字段，E5），也不加入正在运行的研讨（§10.4）；
 *  3. 标注这是原型新增，真实验证以本机检测结果为准。
 */
function AddMemberDialog({
  projectId, projectName, existingMembers, onClose,
}: {
  projectId: string;
  projectName: string;
  existingMembers: ProjectMember[];
  onClose: () => void;
}) {
  const s = useStore((x) => x);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [runtimeId, setRuntimeId] = useState(s.runtimeInstallations[0]?.id ?? '');
  const [model, setModel] = useState('gpt-5-codex');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium');
  const [error, setError] = useState('');

  const rt = byId(s.runtimeInstallations, runtimeId);
  /** 同名实例预告序号，让用户在提交前就知道会叫 Codex#2 还是 Codex（§3.2） */
  const sameName = existingMembers.filter((m) => m.displayName === displayName.trim());
  const nextOrdinal = sameName.length > 0 ? Math.max(0, ...sameName.map((m) => m.ordinal ?? 1)) + 1 : undefined;
  const joinableRooms = s.rooms.filter((r) => r.projectId === projectId && !r.archivedAt);

  const submit = () => {
    if (!displayName.trim()) {
      setError('请填写成员名称');
      return;
    }
    if (!runtimeId) {
      setError('请选择 runtime');
      return;
    }
    const id = createMember({
      projectId,
      displayName,
      description,
      runtimeInstallationId: runtimeId,
      model,
      effort,
    });
    if (id) onClose();
  };

  return (
    <Modal
      title="添加成员"
      subtitle={`添加到 ${projectName}（成员是项目级实例，不会与其他项目的同名成员合并）`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost sm" onClick={onClose}>取消</button>
          <button className="btn primary sm" onClick={submit}>
            <Icon name="user-plus" size={12} /> 添加成员
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">成员名称</label>
        <input
          className="input"
          value={displayName}
          autoFocus
          placeholder="例如 Codex、审查者"
          onChange={(e) => {
            setDisplayName(e.target.value);
            if (error) setError('');
          }}
        />
        <div className="field-hint">
          {nextOrdinal
            ? <>已存在同名成员，这个会显示为 <strong>{displayName.trim()}#{nextOrdinal}</strong> 以便区分。</>
            : <>名称可以重复，重名时界面自动加序号区分。稳定 ID 与显示名分开，改名不会断历史引用。</>}
        </div>
      </div>

      <div className="field">
        <label className="field-label">说明（它会做什么）</label>
        <input
          className="input"
          value={description}
          placeholder="例如 实现与重构，偏好直接给结论"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="field-hint">
          这段说明会出现在成员卡片与 @ 选择里，帮助你和模型判断该找谁。
        </div>
      </div>

      <div className="divider" />
      <div className="card-title" style={{ marginBottom: 8 }}>执行程序与模型</div>

      <div className="field">
        <label className="field-label">Runtime</label>
        <select className="select" value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)}>
          {s.runtimeInstallations.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} · {r.health === 'ready' ? '已就绪' : r.health === 'not_installed' ? '未安装' : r.health === 'not_logged_in' ? '未登录' : r.health === 'incompatible' ? '版本不兼容' : '未验证'}
            </option>
          ))}
        </select>
        <div className="field-hint">
          Runtime 属于<strong>成员模板</strong>：它是"用哪个执行程序"，与"这个成员是谁"分开保存。
          首版仅 Codex App Server 与 Claude Code headless（决策 37）。
        </div>
      </div>

      {/* runtime 状态如实呈现：未安装/未登录/未验证分开，不合并成"不可用"（§9.5） */}
      {rt && rt.health !== 'ready' ? (
        <div className="panel warning" style={{ marginBottom: 12 }}>
          <div className="panel-title"><Icon name="alert-triangle" size={13} /> 这个 runtime 现在还不能派工</div>
          {rt.health === 'not_installed' ? '本机没有检测到它的可执行文件。'
            : rt.health === 'not_logged_in' ? '它还没登录，调用会失败。'
              : rt.health === 'incompatible' ? '版本与本适配器不兼容。'
                : '它尚未通过能力验证。'}
          仍然可以先建好成员（配置会保存），但派任务前需要先在
          「应用设置 → 执行工具」里处理这个状态。
        </div>
      ) : null}

      <div className="grid grid-2">
        <div className="field">
          <label className="field-label">模型</label>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="gpt-5-codex">gpt-5-codex</option>
            <option value="gpt-5">gpt-5</option>
            <option value="claude-sonnet-4-5">claude-sonnet-4-5</option>
            <option value="claude-opus-4-1">claude-opus-4-1</option>
          </select>
          <div className="field-hint">模型属于<strong>成员实例</strong>，同一个 runtime 的不同成员可以用不同模型（决策 38）。</div>
        </div>

        <div className="field">
          <label className="field-label">思考强度</label>
          <div className="seg">
            {(['low', 'medium', 'high'] as const).map((e) => (
              <button key={e} className={effort === e ? 'on' : ''} onClick={() => setEffort(e)} type="button">
                {e === 'low' ? '低' : e === 'medium' ? '中' : '高'}
              </button>
            ))}
          </div>
          <div className="field-hint">越高越慢、越贵。建好后仍可在成员详情里改。</div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 4 }}>
        <div className="panel-title"><Icon name="info" size={13} /> 添加后会怎样</div>
        <div className="col" style={{ gap: 5, marginTop: 4 }}>
          <div className="row tight" style={{ alignItems: 'flex-start' }}>
            <Icon name="check" size={12} style={{ color: 'var(--text-4)', marginTop: 4, flex: 'none' }} />
            <span className="small">
              加入本项目 <strong>{joinableRooms.length}</strong> 个未归档房间
              {joinableRooms.length > 0 ? `（${joinableRooms.map((r) => r.name).join('、')}）` : ''}；
              归档房间保持只读，不会因此复活。
            </span>
          </div>
          <div className="row tight" style={{ alignItems: 'flex-start' }}>
            <Icon name="check" size={12} style={{ color: 'var(--text-4)', marginTop: 4, flex: 'none' }} />
            <span className="small"><strong>不会</strong>自动成为协调者 —— 协调者是房间级设置，要换请到房间设置里显式指定。</span>
          </div>
          <div className="row tight" style={{ alignItems: 'flex-start' }}>
            <Icon name="check" size={12} style={{ color: 'var(--text-4)', marginTop: 4, flex: 'none' }} />
            <span className="small"><strong>不会</strong>加入正在运行的研讨：新成员只影响之后的派发。</span>
          </div>
          <div className="row tight" style={{ alignItems: 'flex-start' }}>
            <Icon name="check" size={12} style={{ color: 'var(--text-4)', marginTop: 4, flex: 'none' }} />
            <span className="small faint">
              原型边界：这里只是内存里新增成员并留痕，不会真的安装 CLI、不会自动登录、也不消耗额度。
            </span>
          </div>
        </div>
      </div>

      {error ? <div className="panel danger" style={{ marginTop: 10 }}>{error}</div> : null}
    </Modal>
  );
}

/* ============================================================
   成员设置（§17.2：名称、runtime、配置、能力；未安装/未登录/未验证分开）
   ============================================================ */

export function MemberDetailPage({ memberId }: { memberId: string }) {
  const s = useStore((x) => x);
  const m = byId(s.members, memberId);
  const [resetOpen, setResetOpen] = useState(false);
  const [sessionScope, setSessionScope] = useState<'thread' | 'member' | 'full'>('thread');
  const [privateOpen, setPrivateOpen] = useState(false);

  if (!m) {
    return (
      <div className="main">
        <div className="page"><ErrorState code="ARTIFACT_MISSING" detail="找不到该成员。" /></div>
      </div>
    );
  }

  const rt = runtimeOfMember(s, m);
  const profile = byId(s.profiles, m.profileId);
  const turns = s.turns.filter((t) => t.memberId === m.id);
  const threads = Array.from(new Set(turns.map((t) => t.threadId))).map((id) => s.threads.find((t) => t.id === id)!);

  return (
    <div className="main">
      <div className="page">
        <div className="page-head">
          <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={36} state={m.workState} />
          <div style={{ minWidth: 0 }}>
            <div className="row tight wrap">
              <span className="page-title" style={{ fontSize: 18 }}>{memberLabel(m)}</span>
              {m.isCoordinatorDefault ? <Tag tone="accent" icon="star">默认协调者</Tag> : null}
            </div>
            <div className="page-sub">{m.workStateReason}</div>
          </div>
          <div className="page-head-actions">
            <button
              className="btn sm"
              onClick={() => configureMember(m.id, { enabled: !m.enabled })}
            >
              <Icon name={m.enabled ? 'pause' : 'play'} size={12} />
              {m.enabled ? '停止成员' : '恢复成员'}
            </button>
            <button className="btn sm" onClick={() => setResetOpen(true)}>
              <Icon name="refresh" size={12} /> 重置会话
            </button>
            <button className="btn sm" onClick={() => navigate(`/dm/${m.id}`)} title="打开与该成员的私聊；同一成员的多个话题分开建会话">
              <Icon name="message-square" size={12} /> 私信
            </button>
          </div>
        </div>

        <div className="grid grid-2">
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>身份与执行程序</div>
            <div className="field">
              <label className="field-label">显示名</label>
              <input
                className="input"
                defaultValue={m.displayName}
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value !== m.displayName) {
                    configureMember(m.id, { displayName: e.target.value.trim() });
                  }
                }}
              />
              <div className="field-hint">
                显示名可改且不破坏历史提及；稳定主体 ID 用于数据关联，不可修改。
                同名实例用序号消歧（当前：{memberLabel(m)}）。
              </div>
            </div>
            <dl className="kv">
              <dt>成员模板</dt><dd>{profile?.name}</dd>
              <dt>Runtime</dt>
              <dd className="row tight wrap">
                <span>{rt?.label}</span>
                <Tag
                  tone={rt?.health === 'ready' ? 'success' : rt?.health === 'not_installed' ? 'danger' : 'warning'}
                  icon={rt?.health === 'ready' ? 'check-circle' : rt?.health === 'not_installed' ? 'x-circle' : 'help-circle'}
                >
                  {rt?.health === 'ready' ? '已就绪' : rt?.health === 'not_installed' ? '未安装' : rt?.health === 'not_logged_in' ? '未登录' : rt?.health === 'incompatible' ? '版本不兼容' : '未验证'}
                </Tag>
              </dd>
              <dt>版本</dt><dd className="mono-sm">{rt?.version} · adapter {rt?.adapterVersion}</dd>
              <dt>可执行文件</dt><dd className="mono-sm">{rt?.executable}</dd>
              <dt>成员 ID</dt><dd className="mono-sm">{m.id}</dd>
            </dl>
            <div className="panel" style={{ marginTop: 10 }}>
              runtime 未安装、未登录、未验证是三种不同状态，恢复动作也不同。切到成员设置里会分别显示，
              不会合并成一个"不可用"。
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>模型与能力（决策 38）</div>
            <div className="field">
              <label className="field-label">模型</label>
              <select className="select" value={m.model} onChange={(e) => configureMember(m.id, { model: e.target.value })}>
                <option value="gpt-5-codex">gpt-5-codex</option>
                <option value="gpt-5">gpt-5</option>
                <option value="claude-sonnet-4-5">claude-sonnet-4-5</option>
                <option value="claude-opus-4-1">claude-opus-4-1</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label">思考强度</label>
              <div className="seg">
                {(['low', 'medium', 'high'] as const).map((e) => (
                  <button key={e} className={m.effort === e ? 'on' : ''} onClick={() => configureMember(m.id, { effort: e })}>
                    {e === 'low' ? '低' : e === 'medium' ? '中' : '高'}
                  </button>
                ))}
              </div>
            </div>
            <div className="divider" />
            <div className="col" style={{ gap: 10 }}>
              <Switch
                checked={m.internalSubagents}
                onChange={(v) => configureMember(m.id, { internalSubagents: v })}
                label="允许 runtime 内部子助手"
                hint="决策 11：只限制群里其他成员，内部委派可单独开关；开启时计入该成员用量与活动记录，不假装是零成本单次调用"
              />
              <div className="small faint">
                指定成员模式（DIRECT）下其他群成员零调用，但该成员内部的子助手由这个开关决定。
              </div>
            </div>

            <div className="divider" />
            <div className="card-title" style={{ marginBottom: 8 }}>能力协商结果</div>
            <div className="row tight wrap">
              {rt ? (
                <>
                  <Tag tone={rt.capabilities.streaming ? 'success' : 'neutral'} icon={rt.capabilities.streaming ? 'check' : 'x'}>流式输出</Tag>
                  <Tag tone={rt.capabilities.toolEvents ? 'success' : 'neutral'} icon={rt.capabilities.toolEvents ? 'check' : 'x'}>工具事件</Tag>
                  <Tag tone={rt.capabilities.usage ? 'success' : 'neutral'} icon={rt.capabilities.usage ? 'check' : 'x'}>用量上报</Tag>
                  <Tag tone={rt.capabilities.interrupt ? 'success' : 'neutral'} icon={rt.capabilities.interrupt ? 'check' : 'x'}>可中断</Tag>
                  <Tag tone={rt.capabilities.resume ? 'success' : 'neutral'} icon={rt.capabilities.resume ? 'check' : 'x'}>可续接会话</Tag>
                  <Tag tone="warning" icon="shield-off">受限读取：不支持</Tag>
                </>
              ) : null}
            </div>
            <div className="panel warning" style={{ marginTop: 10 }}>
              <div className="panel-title"><Icon name="shield-off" size={13} /> "只分析"在 v0.1 拦不住写文件</div>
              当前 CLI 拥有你的完整本机权限，daemon 侧闸门可以被绕过。界面上只显示预期意图，
              不画锁或盾牌。真正的写入拦截归 DEV-20（ADR-14 后置项）。需要强隔离时使用独立沙箱或账号。
            </div>
          </div>
        </div>

        {/* 生命周期：三类重置范围分开（§25.6） */}
        <div className="section-title" style={{ marginTop: 20 }}>生命周期动作</div>
        <div className="grid grid-3">
          <div className="card tight">
            <div className="strong" style={{ fontSize: 12.5 }}>重启 runtime</div>
            <div className="small faint" style={{ marginTop: 4 }}>
              针对选定运行进程，按能力续接；同成员其他进程不受影响。保留会话。
            </div>
            <button className="btn sm" style={{ marginTop: 9 }} onClick={() => toast('已请求重启：仅针对选定进程，其他进程不受影响', 'info')}>
              重启
            </button>
          </div>
          <div className="card tight">
            <div className="strong" style={{ fontSize: 12.5 }}>重置任务会话</div>
            <div className="small faint" style={{ marginTop: 4 }}>
              选择 thread/task，创建新的 sessionGeneration；其他线程不变。保留工作空间。
            </div>
            <button className="btn sm" style={{ marginTop: 9 }} onClick={() => setResetOpen(true)}>
              选择范围
            </button>
          </div>
          <div className="card tight">
            <div className="strong" style={{ fontSize: 12.5 }}>清理托管私有资料</div>
            <div className="small faint" style={{ marginTop: 4 }}>
              列出将清理的应用私有路径，确认无活跃引用后才执行。永不含你的项目目录。
            </div>
            <button className="btn sm" style={{ marginTop: 9 }} onClick={() => setPrivateOpen(true)}>
              查看范围
            </button>
          </div>
        </div>

        {/* 活动 */}
        <div className="section-title" style={{ marginTop: 20 }}>
          最近调用<span className="count">{turns.length}</span>
        </div>
        {turns.length === 0 ? (
          <div className="small faint">还没有调用记录。</div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>阶段</th><th>状态</th><th>时长</th><th>用量</th><th>费用</th><th>运行</th>
                </tr>
              </thead>
              <tbody>
                {turns.slice(-8).reverse().map((t) => (
                  <tr key={t.id}>
                    <td className="small">{t.stageKey}</td>
                    <td className="small">{t.status}</td>
                    <td className="small">{t.durationMs ? formatDuration(t.durationMs) : '—'}</td>
                    <td className="mono-sm">{t.usage ? `入 ${t.usage.inputTokens} · 出 ${t.usage.outputTokens}` : '—'}</td>
                    <td>{t.usage ? <CostText quality={t.usage.costQuality} amount={t.usage.costAmount} /> : <span className="faint">—</span>}</td>
                    <td>
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          const th = s.threads.find((x) => x.id === t.threadId);
                          if (th) navigate(`/project/${s.activeProjectId}/room/${th.roomId}?thread=${th.id}&tab=run`);
                        }}
                      >
                        详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {resetOpen ? (
        <Modal
          size="md"
          title="重置会话"
          subtitle="不同范围影响不同，请确认后执行"
          onClose={() => setResetOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setResetOpen(false)}>取消</button>
              <button
                className="btn danger"
                onClick={() => {
                  clearMemberSession(m.id, sessionScope);
                  setResetOpen(false);
                }}
              >
                执行重置
              </button>
            </>
          }
        >
          <div className="col" style={{ gap: 8 }}>
            {([
              ['thread', '仅这个线程', '创建新的会话代次，其他线程的会话完全不受影响。'],
              ['member', '该成员在本项目的全部会话', '所有线程的会话代次重建，已交付成果与项目文件保持不变。'],
              ['full', '会话 + 托管私有工作空间', '额外清理 drafts/ 下该成员的托管草稿。永远不包含你打开的项目目录。'],
            ] as const).map(([k, title, desc]) => (
              <label key={k} className="card tight" style={{ display: 'flex', gap: 10, cursor: 'pointer' }}>
                <input type="radio" checked={sessionScope === k} onChange={() => setSessionScope(k)} style={{ marginTop: 3 }} />
                <div>
                  <div className="strong" style={{ fontSize: 12.5 }}>{title}</div>
                  <div className="small faint" style={{ marginTop: 3 }}>{desc}</div>
                </div>
              </label>
            ))}
          </div>
          {threads.length > 0 ? (
            <div className="panel" style={{ marginTop: 12 }}>
              该成员参与过的线程：{threads.map((t) => t?.id).filter(Boolean).length} 个。
              「清空会话」保留项目文件和已交付成果；「移除成员」保留历史作者信息。
            </div>
          ) : null}
          <div className="panel danger" style={{ marginTop: 10 }}>
            不提供含义模糊的"全量重置项目"按钮。已交付消息与成果的保留策略，和私有草稿清理是两件事。
          </div>
        </Modal>
      ) : null}

      {privateOpen ? (
        <Modal
          size="md"
          title="清理托管私有资料"
          subtitle="执行前会检查是否存在活跃引用"
          onClose={() => setPrivateOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setPrivateOpen(false)}>取消</button>
              <button
                className="btn danger"
                onClick={() => {
                  clearMemberSession(m.id, 'full');
                  setPrivateOpen(false);
                }}
              >
                确认清理
              </button>
            </>
          }
        >
          <div className="panel" style={{ marginBottom: 12 }}>
            以下路径位于应用数据区，不属于你的项目目录。清理不会触碰项目源文件，
            也不会清除其他 CLI 的全局配置。
          </div>
          <div className="col" style={{ gap: 6 }}>
            {[
              '<appData>/zhongshuo/drafts/proj_zs_01/member_codex/',
              '<appData>/zhongshuo/contexts/proj_zs_01/member_codex/',
              '<appData>/zhongshuo/runtime-installations/（仅非敏感检测结果）',
            ].map((p) => (
              <div key={p} className="mono-sm" style={{ padding: '5px 9px', background: 'var(--bg-surface-2)', borderRadius: 6 }}>
                {p}
              </div>
            ))}
          </div>
          <div className="panel warning" style={{ marginTop: 12 }}>
            不包含：{s.projects[0]?.rootPath}（你的项目目录）、其他成员的工作空间、其他 CLI 的凭据与配置。
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ============================================================
   Runtime 页（§19 兼容性验证；决策 37：首版仅两个 runtime）
   ============================================================ */

/**
 * 执行工具（Runtime）面板。
 *
 * 第十五批 §17.7：Runtime 收入「应用设置 → 执行工具（Runtime）」，
 * **只搬入口、不删能力** —— 安装检测、版本、连接/登录、能力认证、
 * 诊断都原样保留，异常入口可直接链接过来。
 * 它是**应用级**配置：切换项目不会换出另一套 runtime_installations。
 */
export function RuntimePanel({ embedded }: { embedded?: boolean }) {
  const s = useStore((x) => x);
  return (
    <>
      {!embedded ? (
        <div className="page-head">
          <div>
            <div className="page-title">Runtime</div>
            <div className="page-sub">
              首版仅接入 Codex App Server 与 Claude Code headless（决策 37）。第三个 runtime（Gemini）经决策不装，
              后续按 §19 扩展。未安装、未登录、未验证分开显示，不合并成"不可用"。
            </div>
          </div>
          <div className="page-head-actions">
            <button className="btn sm" onClick={() => toast('已重新检测本机 CLI；不会自动启动登录或消耗额度', 'info')}>
              <Icon name="refresh" size={12} /> 重新检测
            </button>
          </div>
        </div>
      ) : (
        <div className="row tight wrap" style={{ marginBottom: 12 }}>
          <Tag plain icon="cpu">应用级配置 · 与项目无关</Tag>
          <div className="spacer" />
          <button className="btn sm" onClick={() => toast('已重新检测本机 CLI；不会自动启动登录或消耗额度', 'info')}>
            <Icon name="refresh" size={12} /> 重新检测
          </button>
        </div>
      )}

        <div className="grid grid-2">
          {s.runtimeInstallations.map((rt) => {
            const usedBy = s.members.filter((m) => {
              const p = byId(s.profiles, m.profileId);
              return p?.runtimeInstallationId === rt.id;
            });
            return (
              <div key={rt.id} className="card">
                <div className="row tight">
                  <Icon name="cpu" size={16} className="faint" />
                  <span className="strong">{rt.label}</span>
                  <div className="spacer" />
                  <Tag
                    tone={rt.health === 'ready' ? 'success' : 'danger'}
                    icon={rt.health === 'ready' ? 'check-circle' : 'x-circle'}
                  >
                    {rt.health === 'ready' ? '已就绪' : '不可用'}
                  </Tag>
                </div>
                <dl className="kv" style={{ marginTop: 10 }}>
                  <dt>版本</dt><dd className="mono-sm">{rt.version}</dd>
                  <dt>适配器</dt><dd className="mono-sm">{rt.adapterVersion}</dd>
                  <dt>可执行文件</dt><dd className="mono-sm">{rt.executable}</dd>
                  <dt>使用成员</dt><dd>{usedBy.length > 0 ? usedBy.map((m) => memberLabel(m)).join('、') : '暂无'}</dd>
                </dl>
                <div className="divider soft" />
                <div className="small faint" style={{ marginBottom: 6 }}>能力协商</div>
                <div className="row tight wrap">
                  <Tag tone={rt.capabilities.streaming ? 'success' : 'neutral'} icon={rt.capabilities.streaming ? 'check' : 'x'}>流式</Tag>
                  <Tag tone={rt.capabilities.toolEvents ? 'success' : 'neutral'} icon={rt.capabilities.toolEvents ? 'check' : 'x'}>工具事件</Tag>
                  <Tag tone={rt.capabilities.usage ? 'success' : 'neutral'} icon={rt.capabilities.usage ? 'check' : 'x'}>用量</Tag>
                  <Tag tone={rt.capabilities.interrupt ? 'success' : 'neutral'} icon={rt.capabilities.interrupt ? 'check' : 'x'}>中断</Tag>
                  <Tag tone={rt.capabilities.resume ? 'success' : 'neutral'} icon={rt.capabilities.resume ? 'check' : 'x'}>续接</Tag>
                  <Tag tone="warning" icon="shield-off">受限读取不支持</Tag>
                </div>
                <div className="panel-actions">
                  <button className="btn sm" onClick={() => toast('连接测试由你主动触发：会发出一次最小调用，可能消耗额度', 'warn')}>
                    连接测试
                  </button>
                  <button className="btn ghost sm" onClick={() => toast('凭据留在 runtime 自己的认证体系或操作系统凭据存储中', 'info')}>
                    认证方式
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>验证等级</div>
        <div className="card">
          <table className="tbl">
            <thead>
              <tr><th style={{ width: 130 }}>等级</th><th>证明内容</th><th style={{ width: 200 }}>当前状态</th></tr>
            </thead>
            <tbody>
              {[
                ['C0 认证', '能启动、能完成一次最小调用并拿到结构化结果', '两者均通过（2026-09-17 实测）'],
                ['C1 隔离与续接', '会话隔离、resume 续接、事件流完整', '两者均通过'],
                ['C2 事件与用量', '增量事件、终结事件、usage 口径', '通过（Claude 经中转返回 costBasis=unknown）'],
                ['C3 工具事件', '工具调用与授权请求的结构化回流', 'Codex 通过；Claude 部分验证'],
                ['C4 中断与停止', '协议中断 + 进程树终止', '通过；进程树停止策略 RT-12 覆盖'],
              ].map(([lv, detail, st]) => (
                <tr key={lv}>
                  <td className="strong">{lv}</td>
                  <td className="small">{detail}</td>
                  <td className="small">{st}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel warning" style={{ marginTop: 14 }}>
          <div className="panel-title"><Icon name="alert-triangle" size={13} /> 不要调用模型 API 自建执行循环</div>
          通过适配器接入现有 CLI，复用你自己的订阅或 API key，runtime 直连 provider。
          注册 CLI 不代表自动启动登录或消费模型额度。
        </div>
    </>
  );
}

/** 旧路径 /runtimes 的兜底页面：现在由 /settings?section=runtime 承担主入口 */
export function RuntimesPage() {
  return (
    <div className="main">
      <div className="page">
        <RuntimePanel />
      </div>
    </div>
  );
}

/* 文件到此结束：不要把 store 的符号从这里再导出一次，
   否则 Vite Fast Refresh 会因"混用了组件与非组件导出"而整页失效。 */
