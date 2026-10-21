/** Read-only task detail projection. Every collection reports whether the bounded page is complete. */
import { z } from 'zod';
import type { CoordinationDetails } from './coordination.ts';

export interface TaskDetailsParams { projectId: string; taskId: string; runId?: string; conversationId?:string; deliveryId?:string }
export const taskDetailsParamsSchema = z.strictObject({
  deliveryId:z.string().min(1).optional(),
  projectId: z.string().min(1), taskId: z.string().min(1), runId: z.string().min(1).optional(),
  conversationId:z.string().min(1).optional(),
});
export const taskHistoryParamsSchema = z.strictObject({
  projectId: z.string().min(1), taskId: z.string().min(1),
  kind: z.enum(['runs', 'activity', 'deliveries']), runId: z.string().min(1).optional(),
  conversationId:z.string().min(1).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export type TaskHistoryParams = z.infer<typeof taskHistoryParamsSchema>;
export interface TaskHistoryPage {
  kind: TaskHistoryParams['kind'];
  items: TaskDetailRun[] | TaskDetailEvent[] | TaskDetailsResult['deliveries'];
  nextCursor: string | null;
}

export const conversationFailedTasksParamsSchema = z.strictObject({ projectId: z.string().min(1), conversationId: z.string().min(1) });
export interface FailedDmTask {
  taskId: string; title: string; taskRevision: number; stopGeneration: number; latestRunId: string;
  available: boolean; pending: boolean; blockReason: string | null;
  formatRepair?: boolean;
}
export interface ConversationFailedTasksResult { conversationId: string; items: FailedDmTask[]; truncated: boolean }

export interface TaskDetailEvent {
  seq: number; kind: string; at: number; runId: string | null; turnId: string | null;
  toolCallId: string | null; summary: string;
  status?: string | null; code?: string | null;
  action?: string | null; target?: string | null; resultSummary?: string | null;
  memberId?: string | null; stage?: string | null; outcome?: string | null;
}

export interface TaskDetailFailure {
  eventKind: string; at: number; message: string | null; code: string | null;
}

export interface TaskDetailRun {
  id: string; mode: string; status: string; stage: string | null; roundNo: number | null;
  revision: number; budget: unknown | null;
  participants: Array<{ memberId: string; displayName: string; role: string; expected: boolean; status: string }>;
  turns: Array<{ id: string; memberId: string; displayName: string; status: string; stageKey: string; purpose: string; attempt: number; runtime?:{kind:string|null;model:string|null;effort:string|null;policy:string|null};usage: Array<{ normalized: unknown; quality: string }>; usageTruncated: boolean }>;
  turnsTruncated: boolean;
  events: TaskDetailEvent[]; eventsTruncated: boolean;
  /** False means only a run summary was read, never an authoritative empty detail. */
  detailLoaded?: boolean;
}

/** A persisted child-task run reached through coordination_steps. */
export interface TaskDetailMemberRun extends TaskDetailRun {
  scope: 'member'; coordinationRunId: string; coordinationStepKey: string; coordinationRole: string;
  taskId: string; taskTitle: string; taskStatus: string;
  memberId: string | null; memberName: string | null;
  /** Only from a persisted failure event; absence is not interpreted as health. */
  failure: TaskDetailFailure | null;
  lastActivityAt: number | null;
  locate: string;
}

export interface TaskDetailsResult {
  coordination?:CoordinationDetails|null;
  task: { id: string; projectId: string; conversationId: string; title: string; objective: string | null; status: string; reviewPolicy: string; revision: number; stopGeneration: number; roomTaskNumber: number | null; ownerMemberId: string | null; ownerDisplayName: string | null; parentTaskId: string | null; currentDeliveryId: string | null };
  clarificationRetry?: { available:boolean;pending:boolean;blockReason:string|null };
  failedRetry: { available: boolean; pending: boolean; blockReason: string | null; formatRepair?:boolean };
  children: Array<{ id: string; title: string; status: string; locate: string }>;
  /** Latest creation order is stable; selectedRunId can point to an older run appended to the bounded list. */
  latestRunId: string | null;
  currentRunId: string | null;
  /** May identify a member child run when the caller explicitly queried one. */
  selectedRunId: string | null;
  runs: TaskDetailRun[];
  /** Present only for a coordination parent; ordinary runs keep their original projection. */
  memberRuns?: TaskDetailMemberRun[];
  memberRunsTruncated?: boolean;
  events: TaskDetailEvent[];
  deliveries: Array<{ id: string; revision: number; manifestHash: string; runId: string | null; reviewStatus: string; reviewedAt: number | null; reviewNote: string | null; artifactRefs: string[]; changeSetRefs: string[]; verificationRefs: string[]; locate: string }>;
  changeSets: Array<{ id: string; applicationStatus: string; beforeRef: string; afterRef: string; locate: string; files: Array<{ path: string; state: string; sha256: string | null; size: number | null }>; filesTruncated: boolean }>;
  artifacts: Array<{ id: string; kind: string; revision: number; hash: string }>;
  nextCursors?: { runs: string | null; activity: string | null; deliveries: string | null; runActivity: string | null; memberRunActivity?: string | null };
  truncated: { children: boolean; runs: boolean; events: boolean; deliveries: boolean; changeSets: boolean; artifacts: boolean };
}
