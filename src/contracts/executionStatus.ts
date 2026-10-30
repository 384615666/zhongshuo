import type { TaskExecutionBlocker } from './executionBlockers.ts';
import type {FailedTaskRecoveryBinding} from './taskRecovery.ts';
import type {TaskClosureBinding} from './taskClosure.ts';
import type {RuntimeToolAction} from './runtime.ts';
import type {
  PreDispatchFailureProjection,
  PreDispatchFailureRecoveryBinding,
} from './taskDetails.ts';

export const TASK_EXECUTION_STATUS_SCHEMA_VERSION = 'task-execution-status-v1' as const;

/** One execution language shared by room cards, thread views and DM records. */
export type TaskExecutionPhase =
  | 'NOT_STARTED_FAILED'
  | 'QUEUED'
  | 'ADMISSION_WAITING'
  | 'RUNNING'
  | 'WAITING_FOR_PEER'
  | 'WAITING_FOR_USER'
  | 'STOPPING'
  | 'UNKNOWN'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'IDLE';

export type TaskExecutionSurface = 'room' | 'thread' | 'dm';

export interface TaskExecutionScope {
  projectId: string;
  conversationId: string;
  roomId: string | null;
  threadId: string | null;
  taskKind: 'room_task' | 'dm_turn';
  /** room_task appears in the room pool and its thread; DM appears only in its conversation. */
  surfaces: TaskExecutionSurface[];
}

export type TaskExecutionReasonCode =
  | 'PRE_DISPATCH_FAILED'
  | 'OUTBOX_QUEUED'
  | 'MEMBER_OCCUPIED'
  | 'WRITE_ROOT_OCCUPIED'
  | 'PRIOR_UNKNOWN_BLOCKS_ADMISSION'
  | 'RUN_QUEUED'
  | 'TURN_PENDING'
  | 'TURN_DISPATCHING'
  | 'MEMBER_PERFORMING'
  | 'WAITING_FOR_PEER'
  | 'WAITING_APPROVAL'
  | 'WAITING_INPUT'
  | 'WAITING_CLARIFICATION'
  | 'WAITING_REWORK'
  | 'WAITING_REVIEW'
  | 'STOPPING'
  | 'UNKNOWN_TURN'
  | 'PROTECTION_RETAINED'
  | 'RECOVERY_REQUIRED'
  | 'TASK_COMPLETED'
  | 'RUN_FAILED'
  | 'TASK_BLOCKED'
  | 'TASK_CANCELLED'
  | 'NO_EXECUTION_EVIDENCE'
  | 'TASK_IDLE';

export type TaskExecutionReasonSource =
  | 'task'
  | 'pre-dispatch'
  | 'outbox'
  | 'blocker'
  | 'run'
  | 'turn'
  | 'coordination'
  | 'recovery';

export interface TaskExecutionReason {
  code: TaskExecutionReasonCode;
  /** Durable explanation. Absence of a durable explanation is reported as unknown. */
  message: string;
  source: TaskExecutionReasonSource;
  taskId: string | null;
  runId: string | null;
  turnId: string | null;
  eventSeq: number | null;
}

export type TaskExecutionMemberState =
  | 'performing'
  | 'starting'
  | 'waiting-peer'
  | 'waiting-user'
  | 'stopping'
  | 'unknown';

export interface TaskExecutionMemberActivity {
  action?:RuntimeToolAction;
  kind: 'tool' | 'model' | 'wait';
  summary: string;
  status: 'started' | 'completed' | 'waiting';
  toolCallId: string | null;
}

export interface TaskExecutionMember {
  memberId: string;
  displayName: string;
  state: TaskExecutionMemberState;
  status: string;
  taskId: string;
  runId: string | null;
  turnId: string | null;
  stage: string | null;
  since: number | null;
  lastActivityAt: number | null;
  reason: string;
  activity: TaskExecutionMemberActivity | null;
}

export type TaskUserWaitKind =
  | 'approval'
  | 'input'
  | 'clarification'
  | 'review'
  | 'rework';

export interface TaskUserWait {
  kind: TaskUserWaitKind;
  message: string;
  memberIds: string[];
  runId: string | null;
  turnId: string | null;
  deliveryId: string | null;
  eventSeq: number | null;
  since: number | null;
}

export interface TaskBusinessActivity {
  kind:
    | 'tool'
    | 'assistant-progress'
    | 'reply'
    | 'artifact'
    | 'report'
    | 'handoff'
    | 'planning'
    | 'clarification';
  summary: string;
  memberId: string | null;
  taskId: string | null;
  runId: string | null;
  turnId: string | null;
  toolCallId: string | null;
  source: 'tool-event' | 'visible-progress' | 'message' | 'business-event';
  sourceEventSeq: number | null;
  at: number;
}

export interface TaskDeliveryOutcome {
  id: string;
  taskId: string;
  runId: string | null;
  revision: number;
  manifestHash: string;
  reviewStatus: 'not_required' | 'pending' | 'accepted' | 'changes_requested' | 'superseded';
  artifactRefs: string[];
  changeSetRefs: string[];
  locate: string;
}

export interface TaskArtifactOutcome {
  id: string;
  taskId: string;
  runId: string | null;
  kind: string;
  revision: number;
  hash: string;
  locate: string;
}

export interface TaskChangeSetOutcome {
  id: string;
  taskId: string;
  applicationStatus: 'applied' | 'not_applied' | 'reverted' | 'partial';
  beforeRef: string;
  afterRef: string;
  locate: string;
}

export interface TaskExecutionResults {
  hasResults: boolean;
  currentDelivery: TaskDeliveryOutcome | null;
  pendingReviewDelivery: TaskDeliveryOutcome | null;
  deliveries: TaskDeliveryOutcome[];
  artifacts: TaskArtifactOutcome[];
  changeSets: TaskChangeSetOutcome[];
  truncated: {
    deliveries: boolean;
    artifacts: boolean;
    changeSets: boolean;
  };
}

export interface TaskExecutionActionTarget {
  kind: 'room' | 'thread' | 'dm' | 'task' | 'delivery' | 'recovery';
  id: string;
}

export type TaskExecutionAction =
  | {
      id: string;
      kind: 'navigate';
      label: string;
      target: TaskExecutionActionTarget;
    }
  | {
      id: string;
      kind: 'recover';
      label: string;
      target: TaskExecutionActionTarget & { kind: 'recovery' };
    }
  | {
      id: string;
      kind: 'review';
      label: string;
      target: TaskExecutionActionTarget & { kind: 'delivery' };
    }
  | {
      id: string;
      kind: 'retry';
      label: string;
      binding: PreDispatchFailureRecoveryBinding | FailedTaskRecoveryBinding;
    }
  | {
      id:string;
      kind:'close';
      label:string;
      binding:TaskClosureBinding;
    };

export interface TaskRecoveryEvidence {
  code: 'WORKER_STILL_RUNNING' | 'RECONCILE_REQUIRED';
  message: string;
  fact: {
    kind: string;
    count?: number;
    turnId?: string;
    lockDomain?: string;
  };
}

export interface TaskExecutionEvidence {
  sourceHighWatermark: number;
  taskStatus: string;
  taskRevision: number;
  stopGeneration: number;
  runCount: number;
  turnCount: number;
  activeRunIds: string[];
  unknownTurnIds: string[];
  latestRun: {
    id: string;
    status: string;
    stage: string | null;
    mode: string;
  } | null;
  outbox: {
    pendingCount: number;
    firstId: number;
    firstStatus: 'pending' | 'leased';
    dispatchKey: string;
    leaseUntil: number | null;
  } | null;
  executionBlocker: TaskExecutionBlocker | null;
  preDispatchFailure: PreDispatchFailureProjection | null;
  recovery: TaskRecoveryEvidence | null;
  /** This projection never uses lease/session/process heartbeats as business activity. */
  heartbeatUsedAsActivity: false;
}

/**
 * Authoritative, read-only task execution projection.
 *
 * Parent command/read surfaces should return this object unchanged as `executionStatus`.
 * The projection records facts and nearby entity bindings; it does not stop, retry,
 * release protection or mutate admission.
 */
export interface TaskExecutionStatus {
  schemaVersion: typeof TASK_EXECUTION_STATUS_SCHEMA_VERSION;
  taskId: string;
  scope: TaskExecutionScope;
  phase: TaskExecutionPhase;
  reason: TaskExecutionReason;
  actualPerformingMembers: TaskExecutionMember[];
  waitingMembers: TaskExecutionMember[];
  waitingForUser: TaskUserWait | null;
  lastBusinessActivity: TaskBusinessActivity | null;
  existingResults: TaskExecutionResults;
  actions: TaskExecutionAction[];
  evidence: TaskExecutionEvidence;
  observedAt: number;
}
