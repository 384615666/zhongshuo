export const OPEN_RECOVERY_EVENT = 'zs:open-recovery';

/** Open the existing recovery panel without changing route or task context. */
export function requestRecoveryOpen(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_RECOVERY_EVENT, { detail: { origin: 'runtime' } }));
}
