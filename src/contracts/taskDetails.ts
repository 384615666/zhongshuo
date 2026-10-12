/** Read-only task detail projection. Every collection reports whether the bounded page is complete. */
import { z } from 'zod';

export interface TaskDetailsParams { projectId: string; taskId: string; runId?: string }
export const taskDetailsParamsSchema = z.strictObject({
  projectId: z.string().min(1), taskId: z.string().min(1), runId: z.string().min(1).optional(),
});
export const taskHistoryParamsSchema = z.strictObject({
  projectId: z.string().min(1), taskId: z.string().min(1),
  kind: z.enum(['runs', 'activity', 'deliveries']), runId: z.string().min(1).optional(),
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
}
export interface ConversationFailedTasksResult { conversationId: string; items: FailedDmTask[]; truncated: boolean }

export interface TaskDetailEvent {
  seq: number; kind: string; at: number; runId: string | null; turnId: string | null;
  toolCallId: string | null; summary: string;
  status?: string | null; code?: string | null;
}

export interface TaskDetailRun {
  id: string; mode: string; status: string; stage: string | null; roundNo: number | null;
  revision: number; budget: unknown | null;
  participants: Array<{ memberId: string; displayName: string; role: string; expected: boolean; status: string }>;
  turns: Array<{ id: string; memberId: string; displayName: string; status: string; stageKey: string; purpose: string; attempt: number; usage: Array<{ normalized: unknown; quality: string }>; usageTruncated: boolean }>;
  turnsTruncated: boolean;
  events: TaskDetailEvent[]; eventsTruncated: boolean;
  /** False means only a run summary was read, never an authoritative empty detail. */
  detailLoaded?: boolean;
}

export interface TaskDetailsResult {
  task: { id: string; projectId: string; conversationId: string; title: string; objective: string | null; status: string; reviewPolicy: string; revision: number; stopGeneration: number; roomTaskNumber: number | null; ownerMemberId: string | null; ownerDisplayName: string | null; parentTaskId: string | null; currentDeliveryId: string | null };
  failedRetry: { available: boolean; pending: boolean; blockReason: string | null };
  children: Array<{ id: string; title: string; status: string; locate: string }>;
  /** Latest creation order is stable; selectedRunId can point to an older run appended to the bounded list. */
  latestRunId: string | null;
  currentRunId: string | null;
  selectedRunId: string | null;
  runs: TaskDetailRun[];
  events: TaskDetailEvent[];
  deliveries: Array<{ id: string; revision: number; manifestHash: string; runId: string | null; reviewStatus: string; reviewedAt: number | null; reviewNote: string | null; artifactRefs: string[]; changeSetRefs: string[]; verificationRefs: string[]; locate: string }>;
  changeSets: Array<{ id: string; applicationStatus: string; beforeRef: string; afterRef: string; locate: string; files: Array<{ path: string; state: string; sha256: string | null; size: number | null }>; filesTruncated: boolean }>;
  artifacts: Array<{ id: string; kind: string; revision: number; hash: string }>;
  nextCursors?: { runs: string | null; activity: string | null; deliveries: string | null; runActivity: string | null };
  truncated: { children: boolean; runs: boolean; events: boolean; deliveries: boolean; changeSets: boolean; artifacts: boolean };
}
