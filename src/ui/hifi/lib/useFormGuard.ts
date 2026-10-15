import { useEffect, useRef, useState } from 'react';
import { getState, useStore } from '../shell';
import { currentNavSeq } from './router';

/** Capture the entity and navigation generation; A -> B -> A cannot revive a form. */
export function useFormGuard(projectId?: string) {
  const active = useStore(s => s.activeProjectId);
  const origin = useRef(currentNavSeq());
  const [invalid, setInvalid] = useState(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    const changed = () => { if (currentNavSeq() !== origin.current) setInvalid(true); };
    window.addEventListener('hashchange', changed);
    return () => { alive.current = false; window.removeEventListener('hashchange', changed); };
  }, []);
  useEffect(() => { if (projectId && active !== projectId) setInvalid(true); }, [projectId, active]);
  return { alive, invalid: invalid || (projectId != null && active !== projectId), valid: () => alive.current && currentNavSeq() === origin.current && (projectId == null || getState().activeProjectId === projectId) };
}
