type RecoveryCommand = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface ReplyOccupancyStatus {
  unknownTurns: readonly {id: string; protectionReleased?: boolean; protectionState?: string | null}[];
  pendingRelease: readonly {turnId: string}[];
  heldLeases: readonly {owner_turn_id: string}[];
}

/** Only the backend's guard-aligned release fact closes an unknown execution.
 * Missing rows/leases or a raw protectionState alone never prove release.
 */
export function previousReplyStillHeld(status: ReplyOccupancyStatus, turnId: string): boolean {
  return status.unknownTurns.find(turn => turn.id === turnId)?.protectionReleased !== true
    || status.pendingRelease.some(item => item.turnId === turnId)
    || status.heldLeases.some(item => item.owner_turn_id === turnId);
}

export function previousReplySummary(status: ReplyOccupancyStatus): string {
  const held = status.unknownTurns.filter(turn => previousReplyStillHeld(status, turn.id)).length;
  const released = status.unknownTurns.length - held;
  return [
    held > 0 ? `有 ${held} 次上次回复需要检查，相关新请求可能正在等待，请检查后继续。` : '',
    released > 0 ? `有 ${released} 次原回复结果仍未确认，但已不再保留占用，不阻挡新消息；原请求不会重发。` : '',
  ].filter(Boolean).join(' ');
}

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
