import { z } from 'zod';

/**
 * Read-only presentation identity for one format-repair output lineage.
 *
 * A lineage is exposed only after the worker's persisted repair workitem and
 * the exact source/replacement messages agree on every scope-bearing id.
 */
export const messageRepairLineageStateSchema = z.enum([
  'repaired',
  'pending',
  'failed',
  'unknown',
]);
export type MessageRepairLineageState = z.infer<typeof messageRepairLineageStateSchema>;

export const messageRepairLineageRoleSchema = z.enum(['source', 'replacement']);
export type MessageRepairLineageRole = z.infer<typeof messageRepairLineageRoleSchema>;

export const messageRepairLineageSchema = z.strictObject({
  state: messageRepairLineageStateSchema,
  messageRole: messageRepairLineageRoleSchema,
  sourceMessageId: z.string().min(1),
  replacementMessageId: z.string().min(1).nullable(),
  workitemId: z.string().min(1),
  logicalOutputId: z.string().min(1),
  sourceResultKey: z.string().min(1),
  sourceTurnId: z.string().min(1),
  repairTurnId: z.string().min(1).nullable(),
  sourceRunId: z.string().min(1),
  repairRunId: z.string().min(1).nullable(),
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  taskId: z.string().min(1),
  memberId: z.string().min(1),
}).superRefine((lineage, context) => {
  if ((lineage.repairTurnId == null) !== (lineage.repairRunId == null)) {
    context.addIssue({
      code: 'custom',
      message: 'repair turn and run ids must both be present or both be absent',
    });
  }
  if (lineage.state === 'repaired') {
    if (lineage.replacementMessageId == null
      || lineage.repairTurnId == null
      || lineage.repairRunId == null) {
      context.addIssue({
        code: 'custom',
        message: 'repaired lineage requires the exact replacement message, turn, and run',
      });
    }
    if (lineage.replacementMessageId === lineage.sourceMessageId) {
      context.addIssue({
        code: 'custom',
        message: 'source and replacement message ids must differ',
      });
    }
  } else {
    if (lineage.messageRole !== 'source' || lineage.replacementMessageId != null) {
      context.addIssue({
        code: 'custom',
        message: 'an incomplete repair can only describe its source message',
      });
    }
    // Pending covers both queued-before-consumption (null ids) and a consumed
    // repair turn that is still RUNNING/WAITING/STOPPING (bound ids).
  }
});

export type MessageRepairLineage = z.infer<typeof messageRepairLineageSchema>;
