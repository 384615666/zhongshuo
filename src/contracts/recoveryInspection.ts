export interface RecoveryInspection {
  schemaVersion: 'recovery-inspection-v1';
  turnId: string;
  taskId: string;
  parentTaskId: string | null;
  taskTitle: string;
  memberName: string;
  turnStatus: string;
  protectionState: string | null;
  budgetMark: string | null;
  result: {
    complete: boolean;
    answer: string | null;
    files: Array<{artifactId: string; filename: string; kind: string}>;
  };
  lastActivity: {at: number; description: string; outcome: string | null} | null;
  exitCheck: {
    state: 'released' | 'ready' | 'blocked';
    message: string;
    action: 'none' | 'release' | 'restart-windows' | 'retry';
    checkedAt: number;
  };
}
