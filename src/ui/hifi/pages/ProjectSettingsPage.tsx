/**
 * 项目设置（R65 原型还原·ProjectSettingsPage 同源）：路由绑定 projectId（无效项目报错不回退）；
 * 真实绑定=项目信息（project.update CAS）、任务交付验收（project.reviewPolicy.set CAS）、
 * 协作限制（project.collab.get/set——缺席容忍+单轮时限；原型的「分析/修改分列时限」后端为
 * 单一时限，分列字段标真实能力限制）、归档（project.lifecycle archive——未结束工作守卫）、
 * 项目全停（board.view→逐任务 task.stop 三重绑定）。并行写入策略（§14.7）后端延期——只读呈现。
 */
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { NumberField, SwitchRow } from '../components/SettingsRow';
import { ErrorState, Modal, Tag } from '../components/ui';
import { useStore, toast } from '../shell';
import { updateProjectReal, projectLifecycleReal, setTaskReviewReal, collabGet, collabSet, stopAllProjectReal } from '../loader';
import { navigate } from '../lib/router';

export type ProjectSettingsAnchor = 'collab' | 'write' | 'delivery';

export function anchorOf(raw: string | undefined): ProjectSettingsAnchor {
  if (raw === 'write' || raw === 'files') return 'write';
  if (raw === 'delivery' || raw === 'task') return 'delivery';
  return 'collab';
}

export function ProjectSettingsPage({ projectId, query }: { projectId: string; query: Record<string, string> }) {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === projectId);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [collab, setCollab] = useState<{ absenceToleranceMs: number | null; turnDeadlineMs: number | null; revision: number } | null>(null);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 页面接收的 projectId（保存绑定原目标——切项目旧框作废，不写进 B）。 */
  const [boundId] = useState(projectId);
  useEffect(() => { void collabGet(boundId).then(setCollab); }, [boundId]);

  useEffect(() => {
    if (project == null) return;
    setNameDraft(project.displayName);
    setDescDraft(project.description ?? '');
    setSaveErr(null);
  }, [project?.id, project?.revision]);

  if (project == null || boundId !== projectId) {
    if (project != null && boundId !== projectId) {
      return (
        <div className="main"><div className="page">
          <ErrorState code="STALE_REVISION" detail="路由已切到其它项目——本页编辑绑定原项目，已作废（零提交）。请从侧栏重新进入目标项目的设置。" />
        </div></div>
      );
    }
    return (
      <div className="main"><div className="page">
        <ErrorState code="PROJECT_NOT_FOUND" detail={`项目不存在或不可访问：${projectId}。为避免改错项目，这里不回退到其他项目。`} />
        <div className="panel-actions">
          <button className="btn sm" onClick={() => navigate('/welcome')}>回到欢迎页</button>
        </div>
      </div></div>
    );
  }

  const unfinishedCount = s.tasks.filter(
    (t) => t.projectId === project.id && ['ACTIVE', 'WAITING_USER', 'BLOCKED', 'REVIEW'].includes(t.status),
  ).length;
  const dirtyInfo = nameDraft.trim() !== project.displayName || descDraft !== (project.description ?? '');

  const saveInfo = async () => {
    setBusy(true);
    setSaveErr(null);
    const r = await updateProjectReal(project.id, project.revision, { displayName: nameDraft.trim(), description: descDraft });
    setBusy(false);
    if (r.ok) toast('项目信息已保存（回读一致；revision 已推进）', 'success');
    else { setSaveErr(r.error ?? '未知错误'); toast(`保存失败：${r.error}（输入已保留）`, 'error'); }
  };

  return (
    <div className="main">
      <div className="page">
        <div className="page-head">
          <div>
            <div className="page-title">{project.displayName} · 项目设置</div>
            <div className="page-sub mono">{project.rootPath}</div>
          </div>
        </div>

        {/* 项目信息：project.update（CAS——A 的编辑不写进 B；失败保留草稿） */}
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-title"><Icon name="folder" size={13} /> 项目信息</div>
          <div className="row" style={{ gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: '1 1 220px', minWidth: 180 }}>
              <label className="field-label">显示名称</label>
              <input className="input" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="项目显示名" />
            </div>
            <div className="field" style={{ flex: '2 1 280px', minWidth: 200 }}>
              <label className="field-label">描述（可选）</label>
              <input className="input" value={descDraft} onChange={(e) => setDescDraft(e.target.value)} placeholder="例如：订单表回填与数据修复" />
            </div>
            <button className="btn sm primary" disabled={busy || !nameDraft.trim() || !dirtyInfo} onClick={() => void saveInfo()}>保存</button>
          </div>
          {saveErr != null ? <div className="panel warning" style={{ marginTop: 8 }}>保存失败：{saveErr}（输入已保留；若项目已被他人/他端修改，请刷新后重试——revision 乐观锁）</div> : null}
          <div className="small faint" style={{ marginTop: 6 }}>
            只改应用里的显示信息，<strong>不会</strong>重命名磁盘目录（{project.rootPath}）。保存按 revision {project.revision} 乐观锁提交。
          </div>
        </div>

        {project.status === 'missing' ? (
          <div className="panel warning" style={{ marginBottom: 14 }}>
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 目录已失效，配置仍可查看</div>
            路径 {project.rootPath} 当前不可访问——请先在欢迎页/项目主页重新定位目录。
          </div>
        ) : null}

        <div className="pset">
          {/* ==================== 任务交付 ==================== */}
          <section className="pset-section" id="pset-delivery">
            <div className="pset-section-title">任务交付</div>
            <div className="card">
              <SwitchRow
                label="任务交付后需要我确认"
                hint="开启后，任务交付会等你验收才算完成；关闭后，满足交付要求即完成。仅影响新任务（创建时快照）。"
                checked={project.taskReviewEnabled ?? false}
                onChange={(v) => { void setTaskReviewReal(project.id, v, project.revision).then((r) => { if (!r.ok) toast(`验收开关保存失败：${r.error}`, 'error'); }); }}
              />
              <div className="pset-note">
                关闭验收不等于自动批准权限、自动提交或推送 Git。与是否 Git 仓库无关：本项目{project.isGit ? '是' : '不是'} Git 仓库，开关照常可用。
              </div>
            </div>
          </section>

          {/* ==================== 协作限制 ==================== */}
          <section className="pset-section" id="pset-collab">
            <div className="pset-section-title">协作限制</div>
            <div className="card">
              {collab == null ? <div className="small faint">正在读取协作限制（project.collab.get）…</div> : (
                <>
                  <NumberField
                    label="成员无响应后继续"
                    hint="超过这个时间就按在场成员继续，不再干等。迟到成果仍会并入。留空/设 0=服务端默认。"
                    value={collab.absenceToleranceMs == null ? 0 : Math.round(collab.absenceToleranceMs / 60000)}
                    min={0}
                    max={1440}
                    unit="分钟"
                    onCommit={(v) => { void collabSet(project.id, { absenceToleranceMs: v > 0 ? v * 60000 : null }, collab.revision).then((r) => { if (r.ok) void collabGet(project.id).then(setCollab); else toast(`保存失败：${r.error}`, 'error'); }); }}
                    integer
                  />
                  <div className="pset-divider" />
                  <NumberField
                    label="单轮最长运行"
                    hint="到点强制结束这一轮，避免成员卡住一直消耗预算。留空/设 0=服务端默认。"
                    value={collab.turnDeadlineMs == null ? 0 : Math.round(collab.turnDeadlineMs / 60000)}
                    min={0}
                    max={720}
                    unit="分钟"
                    onCommit={(v) => { void collabSet(project.id, { turnDeadlineMs: v > 0 ? v * 60000 : null }, collab.revision).then((r) => { if (r.ok) void collabGet(project.id).then(setCollab); else toast(`保存失败：${r.error}`, 'error'); }); }}
                    integer
                  />
                  <div className="pset-note">
                    新派发 turn 起生效（在途 turn 保持派发时的时限）。原型把时限分为「分析/修改」两档——当前后端为单一时限（真实能力限制），不伪造分档。
                  </div>
                </>
              )}
            </div>
          </section>

          {/* ==================== 文件修改 ==================== */}
          <section className="pset-section" id="pset-write">
            <div className="pset-section-title">文件修改</div>
            <div className="card">
              <div className="pset-row">
                <div className="pset-row-label">
                  <div className="pset-row-name">同时修改文件的任务</div>
                  <div className="pset-row-hint">单写者策略（同一物理目录最多 1 个受管理写入者，其他任务排队）。</div>
                </div>
                <Tag tone="success" icon="check-circle">单写者（当前策略）</Tag>
              </div>
              <div className="pset-note">
                并行写入策略（§14.7）在正式合同中延期——本节只读呈现当前策略，不提供切换（不伪造可配置）。
              </div>
              <div className="pset-status">当前没有任务在修改文件时，这里不显示占用（写入占用见房间主池一行）。</div>
            </div>
          </section>

          <div className="pset-foot">
            改动立即保存并按 revision 乐观锁提交；这些设置只影响 <strong>{project.displayName}</strong>。
          </div>

          {/* 高级操作 */}
          <div className="settings-advanced">
            <div className="settings-advanced-head">
              <Icon name="alert-triangle" size={13} />
              高级操作
              <span className="small faint">停止是不可逆的动作，请确认后再用</span>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div className="strong" style={{ fontSize: 12 }}>归档项目</div>
                <div className="small faint" style={{ marginTop: 2, lineHeight: 1.6 }}>
                  退出日常项目列表、历史保留只读；其下房间不再收消息、不建任务、不被唤醒。磁盘文件不受影响。
                  {unfinishedCount > 0 ? <> 当前还有 <strong>{unfinishedCount}</strong> 个工作未结束（已装载视图口径），需要先处理。</> : null}
                </div>
              </div>
              <button className="btn sm" disabled={Boolean(project.archivedAt)} onClick={() => setArchiveOpen(true)}>
                <Icon name="archive" size={12} /> {project.archivedAt ? '已归档' : '归档项目'}
              </button>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div className="strong" style={{ fontSize: 12 }}>停止这个项目的全部任务</div>
                <div className="small faint" style={{ marginTop: 2, lineHeight: 1.6 }}>
                  覆盖 <strong>{project.displayName}</strong> 的所有房间：按看板权威清单逐任务停止（每次绑定该任务 run+停止代次）。
                </div>
              </div>
              <button className="btn sm danger" onClick={() => setStopAllOpen(true)}>
                <Icon name="octagon" size={12} /> 项目全停
              </button>
            </div>
          </div>
        </div>
      </div>

      {archiveOpen ? (
        <Modal
          size="sm"
          title={`归档项目「${project.displayName}」`}
          onClose={() => setArchiveOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setArchiveOpen(false)}>取消</button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void projectLifecycleReal(project.id, project.revision, 'archive').then((r) => {
                    setBusy(false);
                    setArchiveOpen(false);
                    if (r.ok) { toast('项目已归档（历史保留只读）——可在项目 ⋯ 菜单恢复', 'success'); navigate(`/project/${project.id}`); }
                    else toast(`归档被拒：${r.error}`, 'error');
                  });
                }}
              >
                归档项目
              </button>
            </>
          }
        >
          <div className="small muted" style={{ lineHeight: 1.75 }}>
            归档后项目退出日常项目列表、历史保留只读；恢复不会重放旧的待派发任务。磁盘文件与历史记录不受影响。
            存在未结束任务时服务端会拒绝（不自动停止/派发）。
          </div>
        </Modal>
      ) : null}

      {stopAllOpen ? (
        <Modal
          size="sm"
          title="项目全停"
          subtitle={`覆盖 ${project.displayName} 的所有房间（board.view 权威清单 → 逐任务 task.stop）`}
          onClose={() => setStopAllOpen(false)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setStopAllOpen(false)}>取消</button>
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void stopAllProjectReal(project.id).then((r) => {
                    setBusy(false);
                    setStopAllOpen(false);
                    toast(`项目全停完成：停止 ${r.stopped} 个${r.failed.length > 0 ? `；失败 ${r.failed.length} 个（${r.failed.slice(0, 3).join('；')}）` : ''}`, r.failed.length > 0 ? 'warn' : 'success');
                  });
                }}
              >
                <Icon name="octagon" size={12} /> 停止本项目全部任务
              </button>
            </>
          }
        >
          <div className="panel warning">
            <div className="panel-title"><Icon name="alert-triangle" size={13} /> 停止不是撤销</div>
            已写入磁盘的改动会保留；撤销是带版本检查的独立操作。每次停止绑定该任务当前 run 与停止代次（过时绑定会被服务端拒绝）。
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
