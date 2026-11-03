import { useEffect, useRef, useState } from 'react';
import { getState, useStore } from '../shell';
import { currentNavSeq } from './router';

/** 成员管理（R171）等页面可以把表单绑定到**页内选中项目**，而不要求它就是侧栏 active 项目。 */
export interface FormGuardOptions {
    /** 页内项目作用域：传入时按它校验目标项目；不传时与原来完全一致（=全局 activeProjectId）。 */
    scopeProjectId?: string | null;
}

/** Capture the entity and navigation generation; A -> B -> A cannot revive a form. */
export function useFormGuard(projectId?: string, opts?: FormGuardOptions) {
  const active = useStore(s => s.activeProjectId);
  // 未传 scopeProjectId 时行为不变：仍跟随全局 activeProjectId。
  const scope = opts?.scopeProjectId ?? active;
  const currentScope = () => opts?.scopeProjectId ?? getState().activeProjectId;
  const origin = useRef(currentNavSeq());
  const [invalid, setInvalid] = useState(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const changed = () => { if (currentNavSeq() !== origin.current) setInvalid(true); };
    window.addEventListener('hashchange', changed);
    return () => { alive.current = false; window.removeEventListener('hashchange', changed); };
  }, []);
  useEffect(() => { if (projectId && scope !== projectId) setInvalid(true); }, [projectId, scope]);
  return { alive, invalid: invalid || (projectId != null && scope !== projectId), valid: () => alive.current && currentNavSeq() === origin.current && (projectId == null || currentScope() === projectId) };
}
