import { z } from 'zod';

/** Explicitly cancel unfinished work only after its entire task tree is idle. */
export interface TaskClosureBinding {
  taskId: string;
  expectedTaskRevision: number;
  expectedStopGeneration: number;
  /** Latest attempt by creation order, including terminal attempts; null before any run. */
  sourceRunId: string | null;
}

export const taskClosureParamsSchema = z.strictObject({
  taskId: z.string().min(1),
  expectedTaskRevision: z.number().int().nonnegative(),
  expectedStopGeneration: z.number().int().nonnegative(),
  sourceRunId: z.string().min(1).nullable(),
});

export interface TaskClosureBlockReason {
  code: 'RESOURCE_NOT_FOUND' | 'VALIDATION_INVALID' | 'WORKER_STILL_RUNNING' | 'RECONCILE_REQUIRED';
  message: string;
  taskId: string;
}

export interface TaskClosureRead {
  available: boolean;
  binding?: TaskClosureBinding;
  blockReason: TaskClosureBlockReason | null;
}

export interface TaskClosureResult {
  closed: true;
  taskId: string;
  status: 'CANCELLED';
  stopGeneration: number;
  taskRevision: number;
  sourceRunId: string | null;
  cancelledTaskIds: string[];
  cancelledOutboxCount: number;
}
