import { useEffect, useRef, useState } from 'react';
import { gitWriteInFlight, gitWriteStorageError, pendingGitWrites, type GitWriteEnvelope } from '../data/gitWrites';
import { refreshGitState, replayPendingGitOperation } from '../data/actions-git';

export function usePendingGitOperation(projectId: string) {
  const [state, setState] = useState<{ projectId: string; item?: GitWriteEnvelope; error: string | null; busy: boolean }>({ projectId, error: null, busy: false });
  useEffect(() => {
    const read = () => { try { setState({ projectId, item: pendingGitWrites().find(p => p.projectId === projectId), error: gitWriteStorageError, busy: gitWriteInFlight(projectId) }); } catch (e) { setState(prev => ({ projectId, item: prev.projectId === projectId ? prev.item : undefined, error: (e as Error).message, busy: gitWriteInFlight(projectId) })); } };
    read(); window.addEventListener('zs-git-writes', read);
    return () => window.removeEventListener('zs-git-writes', read);
  }, [projectId]);
  return state.projectId === projectId ? state : { projectId, error: null, busy: false, item: undefined };
}

export function PendingGitOperations({ projectId }: { projectId: string }) {
  const state = usePendingGitOperation(projectId), [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const generation = useRef(0), flight = useRef(false);
  useEffect(() => { alive.current = true; ++generation.current; setError(null); return () => { alive.current = false; ++generation.current; }; }, [projectId]);
  const replay = async () => {
    if (!state.item || state.busy || flight.current) return;
    flight.current = true; const ticket = generation.current;
    setError(null);
    try {
      const result = await replayPendingGitOperation(projectId);
      if (alive.current && ticket === generation.current && result.status !== 'ok') setError(result.error);
    } catch (e) { if (alive.current && ticket === generation.current) setError(`原操作读取失败：${(e as Error).message}，未自动创建新身份。`); }
    finally { flight.current = false; }
  };
  if (!state.item && !state.error && !error) return null;
  return <div className="panel warning" data-zs-git-pending>
    <strong>{state.busy ? 'Git 操作正在等待回执' : 'Git 原操作待确认'}</strong>
    <div className="small">重连、刷新和重开只恢复读取。待确认操作不会自动执行，也不会换新身份重建。</div>
    {state.error || error ? <div role="alert">{state.error ?? error}</div> : null}
    {state.item ? <>
      <details><summary>原操作与目标</summary><div className="small mono">{state.item.method} · {state.item.commandId}<br/>项目 {projectId}<br/>路径 {String(state.item.params.path ?? state.item.params.name ?? state.item.params.branch ?? '原冻结参数')}<br/>原提交 {String(state.item.params.commitOid ?? state.item.params.expectedHead ?? '未提供')}<br/>冲突快照 {String(state.item.params.expectedSnapshotHash ?? '不适用')}</div></details>
      <button className="btn sm" disabled={state.busy} data-zs-git-replay onClick={() => void replay()}>人工同号重放原操作</button>
      <button className="btn ghost sm" onClick={() => void refreshGitState(projectId)}>只刷新仓库事实</button>
    </> : null}
  </div>;
}
