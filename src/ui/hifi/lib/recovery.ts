export const OPEN_RECOVERY_EVENT = 'zs:open-recovery';

export interface RecoveryTarget {
  turnId: string;
  taskId?: string;
  runId?: string;
  projectId?: string;
  requestTaskId?: string;
}

/** Open the existing recovery panel without changing route or task context. */
export function requestRecoveryOpen(target?: RecoveryTarget): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_RECOVERY_EVENT, { detail: { origin: 'runtime', target } }));
}
