/** Advisory reads never authorize a send; submit/dispatch own that decision. */
export interface ComposerWriteCapability {
  modificationAuthorized: boolean;
  fullAccess?: boolean;
  willDispatch: boolean;
  blocked?: boolean;
  reason: string;
}

export interface WriteCapabilityReadHost {
  visible(): boolean;
  every(callback: () => void): () => void;
  onVisible(callback: () => void): () => void;
}

/** Keep an in-flight read when task facts refresh, and coalesce its follow-up. */
export function watchComposerWriteCapability(
  read: () => Promise<ComposerWriteCapability>,
  success: (capability: ComposerWriteCapability) => void,
  failure: (error: unknown) => void,
  host: WriteCapabilityReadHost,
): { refresh: () => void; cancel: () => void } {
  let cancelled = false;
  let reading = false;
  let refreshPending = false;
  const run = async (queue: boolean): Promise<void> => {
    if (cancelled || !host.visible()) return;
    if (reading) {
      if (queue) refreshPending = true;
      return;
    }
    reading = true;
    try {
      const capability = await read();
      if (!cancelled) success(capability);
    } catch (error) {
      if (!cancelled) failure(error);
    } finally {
      reading = false;
      if (refreshPending && !cancelled) {
        refreshPending = false;
        void run(false);
      }
    }
  };
  const refresh = () => { void run(true); };
  const stopTimer = host.every(() => { void run(false); });
  const stopVisible = host.onVisible(refresh);
  // Composer's revision effect performs the initial refresh as well.
  return {
    refresh,
    cancel: () => { cancelled = true; stopTimer(); stopVisible(); },
  };
}
