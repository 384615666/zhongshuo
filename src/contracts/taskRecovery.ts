/** A user-visible recovery action binds the exact unsuccessful attempt. */
export type RetryRunStatus = 'FAILED' | 'PARTIAL' | 'INTERRUPTED';
export interface FailedTaskRecoveryBinding {
  method: 'task.redispatch';
  taskId: string;
  sourceRunId: string;
  expectedTaskRevision: number;
  expectedStopGeneration: number;
  expectedRunStatus: RetryRunStatus;
  formatRepair?: true;
  useCurrentExecutionSnapshot?: true;
}
export function isRetryRunStatus(status:string):status is RetryRunStatus {
  return status==='FAILED'||status==='PARTIAL'||status==='INTERRUPTED';
}
