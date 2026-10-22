/**
 * Read-only execution facts for a task that has queued work but no executing turn.
 *
 * This is deliberately descriptive, not an admission decision: the worker remains the
 * only authority that may acquire/release a slot. The projection exists so the UI does
 * not turn "pending outbox" or an unresolved occupancy into a false "model is working".
 */
export type TaskExecutionBlockerReason =
  | 'queued'
  | 'unknown-turn'
  | 'member-occupied'
  | 'write-root-occupied';

export interface TaskExecutionBlocker {
  reason: TaskExecutionBlockerReason;
  /** Human-readable factual explanation; never a fabricated progress heartbeat. */
  note: string;
  pendingOutboxCount: number;
  outboxId: number | null;
  outboxStatus: 'pending' | 'leased' | null;
  dispatchKey: string | null;
  leaseUntil: number | null;
  stage: string | null;
  runId: string | null;
  turnId: string | null;
  memberId: string | null;
  memberName: string | null;
  /** Task currently holding a member/write-root slot, when one can be identified. */
  blockingTaskId: string | null;
  blockingTaskTitle: string | null;
  /** Room-visible task number for the actual holder. */
  blockingTaskNumber?: number | null;
  /** Child-task holders resolve to their root task for navigation/labels. */
  blockingRootTaskId?: string | null;
  blockingRootTaskTitle?: string | null;
  blockingRootTaskNumber?: number | null;
  blockingMemberId: string | null;
  blockingMemberName: string | null;
  blockingTurnId: string | null;
  blockingTurnStatus: string | null;
  protectionState: string | null;
  writeRootKey: string | null;
}
