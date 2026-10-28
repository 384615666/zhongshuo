import { userFacingSystemText } from '../../../contracts/userFacingText';
/**
 * Git 的两个对话框：新建分支 / 冲突三方内容。
 *
 * 为什么单独抽出来：合页改造后「分支」入口上移到页头操作簇（P0 状态条右侧），
 * 而 Git 页分支区自己的「新建分支」按钮仍在 —— 两处必须打开同一个对话框，
 * 各写一份就会出现两套文案与两套校验。
 *
 * 这里只搬 UI 与原有语义，不改行为：
 *  - 新建分支：在已批准的 HEAD 创建；切换由分支列表中的独立动作执行。
 *  - 冲突：不提供「全部保留我的」，只摊开 base/ours/theirs 三方内容
 */

import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { Modal } from '../components/ui';
import { createBranch, resolveConflict, loadConflictContent, getGit, undoLastCommit, refreshGitState } from '../data/actions-git';
import { useFormGuard } from '../lib/useFormGuard';
import { usePendingGitOperation } from '../components/PendingGitOperations';
import { useStore } from '../shell';
import type { GitStatusEntry } from '../data/types';

export function NewBranchModal({
  projectId, base, onClose,
}: {
  projectId: string;
  /** 基于哪个提交创建（当前分支 HEAD；空仓库显示为"(空仓库)"） */
  base: string;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [head, setHead] = useState(() => getGit(projectId)?.commits[0]?.hash ?? getGit(projectId)?.branches.find(b => b.isCurrent)?.head ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  // Git targets the explicit route project; an unrelated navigation focus is not its authority.
  const flight = useRef(false), guard = useFormGuard(), pending = usePendingGitOperation(projectId);
  const projectName = useStore(s => s.projects.find(p => p.id === projectId)?.displayName ?? projectId);
  const reread = async () => { if (flight.current || !guard.valid()) return; flight.current = true; setBusy(true); await refreshGitState(projectId); if (guard.valid()) { const g = getGit(projectId), error = g?.readErrors?.status ?? g?.readErrors?.history; if (error) setError(`当前提交读取失败：${userFacingSystemText(error ?? '')}`); else { setHead(g?.commits[0]?.hash ?? null); setError(null); } } flight.current = false; if (guard.alive.current) setBusy(false); };
  const submit = async () => {
    if (flight.current || !name.trim() || !guard.valid() || pending.item || pending.error) return;
    flight.current = true; setBusy(true); setError(null);
    const result = await createBranch(projectId, name, head);
    if (guard.valid()) { if (result.status === 'ok') onClose(); else setError(result.error); }
    flight.current = false; if (guard.alive.current) setBusy(false);
  };
  return (
    <Modal
      size="sm"
      title="新建分支"
      subtitle="在已确认的提交上创建分支；需要切换时在分支列表明确操作"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || guard.invalid || !!pending.item || !!pending.error}
            onClick={() => void submit()}
          >
            {busy ? '正在处理…' : '创建分支'}
          </button>
        </>
      }
    >
      <p className="small">目标项目：{projectName}</p>
      {error ? <div className="panel warning" role="alert">分支未确认完成：{userFacingSystemText(error ?? '')}。输入保留。</div> : null}
      {guard.invalid ? <div className="panel warning">项目或页面已切换，此表单已作废；不会改写新项目。</div> : null}
      {pending.item && !busy ? <div className="panel warning">该项目有 Git 操作结果待确认，请先查看原操作，或使用原记录重试。</div> : null}
      <label className="field">
        <span className="field-label">分支名</span>
        <input
          className="input"
          placeholder="例如 zs/task-15-refactor"
          value={name}
          disabled={busy || guard.invalid}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="small faint" style={{ marginTop: 8 }}>
        基于 <span className="mono-sm">{head?.slice(0,8) ?? base}</span> 创建；此批准提交身份已固定，变化会被拒绝。工作区未提交改动会一并带入。
      </div>
      <button className="btn ghost sm" disabled={busy || guard.invalid || !!pending.item} onClick={() => void reread()}>保留名称并重新读取 HEAD</button>
    </Modal>
  );
}

export function ConflictModal({
  projectId, entry, onClose,
}: {
  projectId: string;
  entry: GitStatusEntry;
  onClose: () => void;
}) {
  const [manualText, setManualText] = useState('');
  type Tri = Awaited<ReturnType<typeof loadConflictContent>>;
  const [tri, setTri] = useState<Tri | null>(null), [reading, setReading] = useState(true), [readError, setReadError] = useState<string | null>(null), [saveError, setSaveError] = useState<string | null>(null), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const edited = useRef(false), flight = useRef(false), guard = useFormGuard(), pending = usePendingGitOperation(projectId);
  const projectName = useStore(s => s.projects.find(p => p.id === projectId)?.displayName ?? projectId);
  useEffect(() => {
    let done = false; setReading(true); setReadError(null);
    void loadConflictContent(projectId, entry.path).then((r) => {
      if (!done) {
        if (r.path !== entry.path || !/^[0-9a-f]{64}$/.test(r.snapshotHash)) throw Error('冲突身份未获核实');
        setTri(r); if (!edited.current) setManualText(r.ours ?? r.theirs ?? '');
      }
    }).catch(e => { if (!done) setReadError((e as Error).message); }).finally(() => { if (!done) setReading(false); });
    return () => { done = true; };
  }, [projectId, entry.path, reload]);
  const submit = async () => {
    if (flight.current || !guard.valid() || !tri || reading || readError || pending.item || pending.error) return;
    flight.current = true; setBusy(true); setSaveError(null);
    const result = await resolveConflict(projectId, entry.path, manualText, tri.snapshotHash);
    if (guard.valid()) { if (result.status === 'ok') onClose(); else setSaveError(result.error); }
    flight.current = false; if (guard.alive.current) setBusy(false);
  };
  return (
    <Modal
      size="md"
      title="解决冲突"
      subtitle={entry.path}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>稍后处理</button>
          <button
            className="btn primary"
            disabled={busy || reading || !tri || !!readError || guard.invalid || !!pending.item || !!pending.error}
            onClick={() => void submit()}
          >
            {busy ? '正在确认…' : '用编辑后的内容解决'}
          </button>
        </>
      }
    >
      <p className="small">目标项目：{projectName}</p>
      {guard.invalid ? <div className="panel warning">项目或页面已切换，此表单已作废；提案不会写入新目标。</div> : null}
      {readError ? <div className="panel warning" role="alert">三方内容读取失败：{userFacingSystemText(readError ?? '')}。未当作空内容，可重读；编辑提案保留。</div> : null}
      {saveError ? <div className="panel warning" role="alert">冲突未确认完成：{userFacingSystemText(saveError ?? '')}。提案保留；重新读取会保留你的编辑，再由你明确提交。</div> : null}
      {pending.item && !busy ? <div className="panel warning">原操作结果待确认，请先查看原操作，或使用原记录重试。</div> : null}
      <button className="btn sm" disabled={reading || busy || guard.invalid} onClick={() => setReload(n => n + 1)}>{reading ? '正在读取三方…' : '重新读取三方内容'}</button>
      {tri ? <details className="small"><summary>已读取的冲突身份</summary><span className="mono">{tri.snapshotHash}</span></details> : null}
      <div className="panel warning" style={{ marginBottom: 12 }}>
        <div className="panel-title"><Icon name="alert-triangle" size={13} /> 这里不提供「全部保留我的」按钮</div>
        冲突意味着归属不明确。众说停止自动应用，把三方内容摊开让你判断，
        而不是替你选一边。
      </div>

      <div className="section">
        <div className="section-title">共同祖先（base）</div>
        <pre className="conflict-pre">{tri ? tri.base ?? '该冲突没有共同祖先版本' : '尚未取得三方快照'}</pre>
      </div>
      <div className="section">
        <div className="section-title">
          我的版本（ours）
          <div className="spacer" />
          <button className="btn ghost sm" disabled={!tri || tri.ours == null || reading || !!readError || busy || guard.invalid} onClick={() => { edited.current = true; setManualText(tri!.ours!); }}>放入编辑区</button>
        </div>
        <pre className="conflict-pre">{tri ? tri.ours ?? '这一方的文件不存在（删除）' : '尚未取得三方快照'}</pre>
      </div>
      <div className="section">
        <div className="section-title">
          对方版本（theirs）
          <div className="spacer" />
          <button className="btn ghost sm" disabled={!tri || tri.theirs == null || reading || !!readError || busy || guard.invalid} onClick={() => { edited.current = true; setManualText(tri!.theirs!); }}>放入编辑区</button>
        </div>
        <pre className="conflict-pre">{tri ? tri.theirs ?? '这一方的文件不存在（删除）' : '尚未取得三方快照'}</pre>
      </div>

      <div className="section">
        <div className="section-title">解决后的内容</div>
        <textarea
          className="composer-input"
          rows={3}
          value={manualText}
          disabled={busy || guard.invalid}
          onChange={(e) => { edited.current = true; setManualText(e.target.value); }}
        />
        <div className="small faint" style={{ marginTop: 6 }}>
          解决后进入暂存区，确认无误再提交。
        </div>
      </div>
    </Modal>
  );
}

export function UndoCommitModal({ projectId, approved, onClose }: { projectId: string; approved: { commitOid: string; expectedHead: string; expectedBranch: string; subject: string }; onClose: () => void }) {
  const guard = useFormGuard(), pending = usePendingGitOperation(projectId), flight = useRef(false);
  const projectName = useStore(s => s.projects.find(p => p.id === projectId)?.displayName ?? projectId);
  const [busy,setBusy] = useState(false), [error,setError] = useState<string | null>(null);
  const submit = async () => {
    if (flight.current || !guard.valid() || pending.item || pending.error) return;
    flight.current = true; setBusy(true); setError(null);
    const result = await undoLastCommit(projectId, { commitOid: approved.commitOid, expectedHead: approved.expectedHead, expectedBranch: approved.expectedBranch });
    if (guard.valid()) { if (result.status === 'ok') onClose(); else setError(result.error); }
    flight.current = false; if (guard.alive.current) setBusy(false);
  };
  return <Modal title="撤销当前 HEAD 提交" size="sm" onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><div className="spacer"/><button className="btn danger" disabled={busy || guard.invalid || !!pending.item || !!pending.error} onClick={() => void submit()}>{busy ? '正在确认…' : '确认软回退'}</button></>}>
    <p className="small">目标项目：{projectName}</p><p>{approved.subject}</p><p className="mono small">{approved.expectedBranch} · {approved.commitOid}</p>
    <p>仅撤销这份已确认的当前提交。内容保留在暂存区和工作区；不删除文件、不撤销任务验收。HEAD 或分支变化会被拒绝。</p>
    {error ? <div className="panel warning" role="alert">未确认完成：{userFacingSystemText(error ?? '')}</div> : null}
    {guard.invalid ? <div className="panel warning">页面或项目已切换，本次批准作废。</div> : null}
    {pending.item && !busy ? <div className="panel warning">原操作结果待确认，请使用页内的重试操作。</div> : null}
  </Modal>;
}
