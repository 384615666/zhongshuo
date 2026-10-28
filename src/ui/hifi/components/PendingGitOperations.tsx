import { userFacingSystemText } from '../../../contracts/userFacingText';
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
    } catch (e) { if (alive.current && ticket === generation.current) setError(`原操作读取失败：${userFacingSystemText((e as Error).message ?? '')}，未自动创建新身份。`); }
    finally { flight.current = false; }
  };
  if (!state.item && !state.error && !error) return null;
  return <div className="panel warning" data-zs-git-pending>
    <strong>{state.busy ? 'Git 操作正在等待回执' : 'Git 原操作待确认'}</strong>
    <div className="small">这里保留待确认的 Git 操作记录。请先查看状态，再决定是否重试。</div>
    {state.error || error ? <div role="alert">{userFacingSystemText(state.error ?? error ?? '')}</div> : null}
    {state.item ? <>
      <details><summary>原操作与目标</summary><div className="small mono">{state.item.method} · {state.item.commandId}<br/>项目 {projectId}<br/>路径 {String(state.item.params.path ?? state.item.params.name ?? state.item.params.branch ?? '原操作参数')}<br/>原提交 {String(state.item.params.commitOid ?? state.item.params.expectedHead ?? '未提供')}<br/>冲突快照 {String(state.item.params.expectedSnapshotHash ?? '不适用')}</div></details>
      <button className="btn sm" disabled={state.busy} data-zs-git-replay onClick={() => void replay()}>使用原记录重试</button>
      <button className="btn ghost sm" onClick={() => void refreshGitState(projectId)}>刷新仓库状态</button>
    </> : null}
  </div>;
}
