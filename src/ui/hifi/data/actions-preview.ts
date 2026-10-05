/**
 * 预览/引用动作（正式侧 H1 占位实现）：`takePendingQuotes` 是 Composer 的既有依赖——
 * 共享预览与引用插入属 H2，此处真实地从 pendingQuotes 队列取（队列为空=无引用，不造数据）。
 */
import { getState, setState } from './store';
import type { DraftReference } from './types';

export function takePendingQuotes(draftKey: string): DraftReference[] {
  const s = getState();
  const mine = (s.pendingQuotes ?? []).filter((q) => q.draftKey === draftKey);
  if (mine.length === 0) return [];
  setState((prev) => ({ ...prev, pendingQuotes: (prev.pendingQuotes ?? []).filter((q) => q.draftKey !== draftKey) } as typeof prev));
  return mine.map((q) => q.reference);
}

/** 共享预览「引用到输入框」（r56 H4）：入队引用（固定版本+摘录）——由目标 Composer 在
 * zs:focus-composer 时消费；只改变草稿，不直接派发。 */
export function addPendingQuote(draftKey: string, reference: DraftReference): void {
  setState((prev) => ({ ...prev, pendingQuotes: [...(prev.pendingQuotes ?? []), { draftKey, reference }] } as typeof prev));
}
