/** Only successful server pages establish a history boundary. Refreshes cannot
 * move that boundary forward or discard an already loaded older window. */
export interface ThreadHistoryWindow { initialized: boolean; oldestSeq?: number; exhausted: boolean }
const windows = new Map<string, ThreadHistoryWindow>();
const pending = new Map<string, Promise<unknown>>();
export const historyScope = (generation: number, projectId: string, threadId: string) =>
  JSON.stringify([generation, projectId, threadId]);
export function historyWindow(scope: string): ThreadHistoryWindow {
  return windows.get(scope) ?? { initialized: false, exhausted: false };
}
export function recordHistoryPage(scope: string, seqs: number[], beforeSeq?: number): void {
  if (seqs.some(seq => !Number.isSafeInteger(seq) || seq < 1 || (beforeSeq != null && seq >= beforeSeq))) {
    throw new Error('历史分页未向前推进，请重试');
  }
  const previous = historyWindow(scope);
  const oldestSeq = Math.min(previous.oldestSeq ?? Infinity, ...seqs);
  windows.set(scope, {
    initialized: true,
    oldestSeq: Number.isFinite(oldestSeq) ? oldestSeq : undefined,
    exhausted: previous.exhausted || seqs.length < 100 || oldestSeq <= 1,
  });
}
/** Coalesce only in-flight reads; a failure is immediately retryable. The bridge
 * still authenticates every page, including private thread scope. */
export function readHistoryOnce<T>(scope: string, beforeSeq: number | undefined, read: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([scope, beforeSeq ?? null]);
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const request = read().finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}
