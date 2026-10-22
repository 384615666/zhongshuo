/**
 * 项目设置（R65 原型还原·ProjectSettingsPage 同源）：路由绑定 projectId（无效项目报错不回退）；
 * 真实绑定=项目信息（project.update CAS）、任务交付验收（project.reviewPolicy.set CAS）、
 * 协作限制（project.collab.get/set——缺席容忍+单轮时限；原型的「分析/修改分列时限」后端为
 * 单一时限，分列字段标真实能力限制）、归档（project.lifecycle archive——未结束工作守卫）、
 * 项目全停（board.view→逐任务 task.stop 三重绑定）。并行写入策略（§14.7）后端延期——只读呈现。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { NumberField, SwitchRow } from '../components/SettingsRow';
import { ErrorState, Modal, Tag } from '../components/ui';
import { useStore, toast } from '../shell';
import { updateProjectReal, projectLifecycleReal, setTaskReviewReal, collabGet, collabSet, stopAllProjectReal } from '../loader';
import { navigate } from '../lib/router';
import { command } from '../bridge';
import { ProjectWriteAccessPanel } from '../components/ProjectWriteAccessPanel';
import { deadlineSecondsText, parseDeadlineSeconds } from '../lib/deadlineField';

export type ProjectSettingsAnchor = 'collab' | 'write' | 'delivery';

export function anchorOf(raw: string | undefined): ProjectSettingsAnchor {
  if (raw === 'write' || raw === 'files') return 'write';
  if (raw === 'delivery' || raw === 'task') return 'delivery';
  return 'collab';
}

/** Three distinct states: blank=inherit, 0=disabled, positive=explicit hard deadline. */
export function TurnDeadlineField({ value, effective, onCommit, disabled = false }: {
  value: number | null;
  effective: { ms: number | null; source: 'project' | 'global' | 'disabled' };
  onCommit: (value: number | null) => void;
  /** A save/read-back is in flight; accepting another edit would be silently dropped. */
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(deadlineSecondsText(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(deadlineSecondsText(value)); setError(null); }, [value]);
  const commit = () => {
    if (disabled) return;
    const parsed = parseDeadlineSeconds(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    if (parsed.value !== value) onCommit(parsed.value);
  };
  return <div className="pset-row">
    <div className="pset-row-label">
      <div className="pset-row-name">单轮最长运行</div>
      <div className="pset-row-hint">默认不设总时长上限；启用后达到设定时间会中断；只对之后开始的执行生效。</div>
      <div className="pset-row-hint">留空表示继承；0 表示明确关闭。当前实际生效：{effective.ms == null ? '不设总时长上限' : `${deadlineSecondsText(effective.ms)} 秒`}{effective.source === 'global' ? '（来自全局设置）' : ''}。</div>
    </div>
    <div className="row tight">
      <input
        className="input pset-number"
        type="number"
        min={0}
        max={86400}
        step={0.001}
        value={draft}
        placeholder="继承"
        aria-label="单轮最长运行（秒）"
        aria-invalid={error ? true : undefined}
        aria-busy={disabled ? true : undefined}
        disabled={disabled}
        title={disabled ? '正在保存并回读，完成后可继续编辑' : undefined}
        onChange={(event) => { setDraft(event.target.value); if (error) setError(null); }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') { setDraft(deadlineSecondsText(value)); setError(null); }
        }}
      />
      <span className="pset-unit">秒</span>
    </div>
    {error ? <div className="pset-row-error">{error}</div> : null}
  </div>;
}

export function ProjectSettingsPage({ projectId, query }: { projectId: string; query: Record<string, string> }) {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === projectId);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const lastInfo = useRef<{ id: string; name: string; description: string } | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [collab, setCollab] = useState<{
    absenceToleranceMs: number | null; turnDeadlineMs: number | null; revision: number;
    effectiveTurnDeadlineMs: number | null; turnDeadlineSource: 'project' | 'global' | 'disabled';
  } | null>(null);
  const [collabError, setCollabError] = useState<string | null>(null);
  const [collabSaving, setCollabSaving] = useState(false);
  const collabSavingRef = useRef(false);
  const routeIdentity = useRef({ id: projectId, generation: 0 });
  if (routeIdentity.current.id !== projectId) routeIdentity.current = { id: projectId, generation: routeIdentity.current.generation + 1 };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; routeIdentity.current.generation += 1; };
  }, []);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingReview, setPendingReview] = useState<{ projectId: string; count: number } | null>(null);
  const [pendingReviewError, setPendingReviewError] = useState<{ projectId: string; message: string } | null>(null);
  const [unfinished, setUnfinished] = useState<{ projectId: string; count: number } | null>(null);
  const [unfinishedError, setUnfinishedError] = useState<{ projectId: string; message: string } | null>(null);
  /** 同一组件可从 A 设置路由切到 B；旧回执不可回填 B，下一次渲染再绑定 B。 */
  const [boundId, setBoundId] = useState(projectId);
  useEffect(() => {
    setBoundId(projectId);
    setCollab(null);
    setCollabError(null);
    collabSavingRef.current = false;
    setCollabSaving(false);
    setBusy(false);
    setArchiveOpen(false);
    setStopAllOpen(false);
  }, [projectId]);
  useEffect(() => {
    let current = true;
    void collabGet(boundId).then((value) => {
      if (!current) return;
      setCollab(value);
      setCollabError(null);
    }).catch((e: unknown) => { if (current) setCollabError(`协作限制读取失败：${(e as Error).message}；当前值不能当作默认值。`); });
    return () => { current = false; };
  }, [boundId]);
  useEffect(() => {
    let current = true;
    void command<{ projects: Array<{ projectId: string; reviewTasks: unknown[] }> }>('mine.pending', {})
      .then((result) => { if (current) { setPendingReview({ projectId, count: result.projects.find((p) => p.projectId === projectId)?.reviewTasks.length ?? 0 }); setPendingReviewError(null); } })
      .catch((e: unknown) => { if (current) setPendingReviewError({ projectId, message: (e as Error).message }); });
    return () => { current = false; };
  }, [projectId]);
  useEffect(() => {
    let current = true;
    let inFlight = false;
    const load = () => {
      if (inFlight) return;
      inFlight = true;
      void command<{ groups: Array<{ rooms: Array<{ cards: Array<{ taskStatus: string }> }> }> }>('board.view', { scope: 'project', projectId })
        .then((result) => {
          if (!current) return;
          const count = result.groups.flatMap((g) => g.rooms.flatMap((r) => r.cards)).filter((c) => ['ACTIVE', 'WAITING_USER', 'BLOCKED', 'REVIEW'].includes(c.taskStatus)).length;
          setUnfinished({ projectId, count }); setUnfinishedError(null);
        })
        .catch((e: unknown) => { if (current) setUnfinishedError({ projectId, message: (e as Error).message }); })
        .finally(() => { if (current) inFlight = false; });
    };
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 10_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [projectId]);

  const saveCollab = async (patch: { absenceToleranceMs?: number | null; turnDeadlineMs?: number | null }) => {
    if (collabError != null) { toast('请先重试读取协作限制，再提交新值', 'warn'); return; }
    if (collab == null || collabSavingRef.current || boundId !== projectId) return;
    const id = projectId;
    const targetName = project?.displayName ?? id;
    const routeGeneration = routeIdentity.current.generation;
    collabSavingRef.current = true;
    setCollabSaving(true);
    setCollabError(null);
    try {
      const result = await collabSet(id, patch, collab.revision);
      if (!mounted.current || id !== routeIdentity.current.id || routeGeneration !== routeIdentity.current.generation) {
        toast(`「${targetName}」协作限制${result.ok ? '保存命令已接受，回读待重新进入原项目核对' : `保存失败：${result.error}`}（当前页面已切换/关闭）`, result.ok ? 'warn' : 'error');
        return;
      }
      if (!result.ok) { setCollabError(`保存失败：${result.error}`); toast(`保存失败：${result.error}`, 'error'); return; }
      let reread: Awaited<ReturnType<typeof collabGet>>;
      try { reread = await collabGet(id); }
      catch (e) { if (mounted.current && id === routeIdentity.current.id && routeGeneration === routeIdentity.current.generation) setCollabError(`保存命令已接受，但回读失败：${(e as Error).message}；当前值未获确认。`); return; }
      if (!mounted.current || id !== routeIdentity.current.id || routeGeneration !== routeIdentity.current.generation) return;
      setCollab(reread);
      toast('协作限制已保存并回读', 'success');
    } finally {
      if (mounted.current && id === routeIdentity.current.id && routeGeneration === routeIdentity.current.generation) { collabSavingRef.current = false; setCollabSaving(false); }
    }
  };

  useEffect(() => {
    if (project == null) return;
    const last = lastInfo.current;
    if (last == null || last.id !== project.id) {
      setNameDraft(project.displayName);
      setDescDraft(project.description ?? '');
    } else {
      // 背景注册表刷新可能推进 revision；只同步未编辑字段，保留当前用户草稿。
      setNameDraft((draft) => draft === last.name ? project.displayName : draft);
      setDescDraft((draft) => draft === last.description ? (project.description ?? '') : draft);
    }
    lastInfo.current = { id: project.id, name: project.displayName, description: project.description ?? '' };
    setSaveErr(null);
  }, [project?.id, project?.revision]);

  if (project == null || boundId !== projectId) {
    if (project != null && boundId !== projectId) {
      return (
        <div className="main"><div className="page">
          <ErrorState code="STALE_REVISION" detail="正在切换项目设置；旧项目的编辑与回执不会写入当前项目。" />
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

  const unfinishedCount = unfinished?.projectId === project.id ? unfinished.count : null;
  const unfinishedReadError = unfinishedError?.projectId === project.id ? unfinishedError.message : null;
  const dirtyInfo = nameDraft.trim() !== project.displayName || descDraft !== (project.description ?? '');

  const saveInfo = async () => {
    const id = project.id;
    const targetName = project.displayName;
    const routeGeneration = routeIdentity.current.generation;
    setBusy(true);
    setSaveErr(null);
    const r = await updateProjectReal(id, project.revision, { displayName: nameDraft.trim(), description: descDraft });
    if (!mounted.current || id !== routeIdentity.current.id || routeGeneration !== routeIdentity.current.generation) {
      toast(`「${targetName}」项目信息${r.ok ? '已保存' : `保存失败：${r.error}`}（当前页面已切换/关闭）`, r.ok ? 'info' : 'error');
      return;
    }
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
                onChange={(v) => { const targetName = project.displayName; void setTaskReviewReal(project.id, v, project.revision).then((r) => { if (!r.ok) toast(`「${targetName}」验收开关保存失败：${r.error}`, 'error'); }); }}
              >
                {pendingReview?.projectId === project.id && pendingReview.count > 0 ? <button className="pset-link" onClick={() => navigate('/pending')} title="去待我处理逐条验收">还有 {pendingReview.count} 个已有任务等待验收 → 查看</button> : null}
                {pendingReviewError?.projectId === project.id ? <span className="small faint">待验收数量读取失败：{pendingReviewError.message}（去待我处理查看）</span> : null}
              </SwitchRow>
              <div className="pset-note">
                关闭验收不等于自动批准权限、自动提交或推送 Git。这个开关与项目是否为 Git 仓库无关。
              </div>
            </div>
          </section>

          {/* ==================== 协作限制 ==================== */}
          <section className="pset-section" id="pset-collab">
            <div className="pset-section-title">协作限制</div>
            <div className="card">
              {collabError != null ? <div className="panel warning">{collabError} <button className="btn sm" onClick={() => { const id = project.id; const routeGeneration = routeIdentity.current.generation; setCollabError(null); void collabGet(id).then((value) => { if (id === routeIdentity.current.id && routeGeneration === routeIdentity.current.generation) setCollab(value); }).catch((e: unknown) => { if (id === routeIdentity.current.id && routeGeneration === routeIdentity.current.generation) setCollabError(`协作限制读取失败：${(e as Error).message}`); }); }}>重试读取</button></div> : null}
              {collab == null ? (collabError == null ? <div className="small faint">正在读取协作限制（project.collab.get）…</div> : null) : (
                <>
                  <NumberField
                    label="成员无响应后继续"
                    hint="超过这个时间就按在场成员继续，不再干等。迟到成果仍会并入。留空/设 0=服务端默认。"
                    value={collab.absenceToleranceMs == null ? 0 : Math.round(collab.absenceToleranceMs / 60000)}
                    min={0}
                    max={1440}
                    unit="分钟"
                    onCommit={(v) => { void saveCollab({ absenceToleranceMs: v > 0 ? v * 60000 : null }); }}
                    integer
                  />
                  <div className="pset-divider" />
                  <TurnDeadlineField
                    value={collab.turnDeadlineMs}
                    effective={{ ms: collab.effectiveTurnDeadlineMs, source: collab.turnDeadlineSource }}
                    disabled={collabSaving}
                    onCommit={(value) => { void saveCollab({ turnDeadlineMs: value }); }}
                  />
                  <div className="pset-note">
                    默认不设总时长上限；启用后达到设定时间会中断，且只对之后开始的执行生效。
                  </div>
                  {collabSaving ? <div className="small faint">正在保存并回读协作限制…</div> : null}
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
              <ProjectWriteAccessPanel key={projectId} projectId={projectId} name={project.displayName} path={project.rootPath??''}/>
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
                  {unfinishedCount != null ? unfinishedCount > 0 ? <> 当前还有 <strong>{unfinishedCount}</strong> 个工作未结束（board.view 最近回读），需要先处理。</> : <> 最近读取没有未结束任务；归档时服务端会再次复查。</> : <> 未结束任务数读取中；归档时服务端会再次复查。</>}
                  {unfinishedReadError != null ? <> 最近一次任务数读取失败：{unfinishedReadError}（保留上次回读，操作前请查看任务看板）。</> : null}
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
                  const routeGeneration = routeIdentity.current.generation;
                  const targetId = project.id;
                  const targetName = project.displayName;
                  setBusy(true);
                  void projectLifecycleReal(targetId, project.revision, 'archive').then((r) => {
                    if (!mounted.current || routeGeneration !== routeIdentity.current.generation || targetId !== routeIdentity.current.id) {
                      toast(`「${targetName}」归档${r.ok ? '完成' : `失败：${r.error}`}（当前页面已切换/关闭）`, r.ok ? 'info' : 'error');
                      return;
                    }
                    setBusy(false);
                    setArchiveOpen(false);
                    if (r.ok) { toast('项目已归档（历史保留只读）——可在项目 ⋯ 菜单恢复', 'success'); navigate(`/project/${targetId}`); }
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
                  const routeGeneration = routeIdentity.current.generation;
                  const targetId = project.id;
                  const targetName = project.displayName;
                  setBusy(true);
                  void stopAllProjectReal(targetId).then((r) => {
                    if (!mounted.current || routeGeneration !== routeIdentity.current.generation || targetId !== routeIdentity.current.id) {
                      toast(`「${targetName}」全停完成（当前页面已切换/关闭）：停止 ${r.stopped} 个；失败 ${r.failed.length} 个`, r.failed.length > 0 ? 'warn' : 'info');
                      return;
                    }
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
