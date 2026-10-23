type RecoveryCommand = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** One operation per stable turn, including rapid clicks and partial-failure retry.
 * Only the backend can prove the old execution ended; never redispatch that request.
 */
export function createPreviousReplyCheck(send: RecoveryCommand) {
  const inFlight = new Map<string, Promise<void>>();
  return (turnId: string): Promise<void> => {
    const existing = inFlight.get(turnId);
    if (existing) return existing;
    const pending = (async () => {
      await send('recovery.reconcile', {
        turnId, verdict: 'executed', note: '上次请求已派发，结果仍未知；核查并结束占用，不重发原请求',
      });
      await send('recovery.releaseProtection', {
        turnId, note: '检查并继续排队消息；保留原执行结果', endPreviousExecution: true,
      });
      await send('dispatch.resume', {confirm: true});
    })().finally(() => { inFlight.delete(turnId); });
    inFlight.set(turnId, pending);
    return pending;
  };
}
