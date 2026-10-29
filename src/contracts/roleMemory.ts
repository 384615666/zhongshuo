import { z } from 'zod';

/** A room shares memory across threads; each DM conversation has its own scope. */
export const roleMemoryScopeSchema = z.strictObject({
  projectId: z.string().min(1),
  memberId: z.string().min(1),
  conversationId: z.string().min(1),
});
export type RoleMemoryScope = z.infer<typeof roleMemoryScopeSchema>;

/** Model-authored deltas only: no delete, replace, or whole-snapshot operation. */
export const memoryUpdateSchema = z.strictObject({
  key: z.string().trim().min(1),
  text: z.string().trim().min(1),
});
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;

export const roleMemoryValueSchema = z.strictObject({
  text: z.string().trim().min(1),
  sourceTaskId: z.string().min(1),
  sourceThreadId: z.string().min(1).nullable(),
  sourceTurnId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
});
export type RoleMemoryValue = z.infer<typeof roleMemoryValueSchema>;

export const roleMemoryEntrySchema = z.strictObject({
  key: z.string().trim().min(1),
  conflicted: z.boolean(),
  // Equal text from different turns deliberately retains each source.
  values: z.array(roleMemoryValueSchema).min(1),
}).refine((entry) => entry.conflicted === (new Set(entry.values.map((value) => value.text)).size > 1), {
  message: 'Memory conflict flag must reflect distinct texts',
});
export type RoleMemoryEntry = z.infer<typeof roleMemoryEntrySchema>;

export const roleMemorySnapshotSchema = z.strictObject({
  scope: roleMemoryScopeSchema,
  revision: z.number().int().nonnegative(),
  entries: z.array(roleMemoryEntrySchema),
});
export type RoleMemorySnapshot = z.infer<typeof roleMemorySnapshotSchema>;

export const mergeRoleMemoryInputSchema = z.strictObject({
  scope: roleMemoryScopeSchema,
  turnId: z.string().min(1),
  taskId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  updates: z.array(memoryUpdateSchema),
});
export type MergeRoleMemoryInput = z.infer<typeof mergeRoleMemoryInputSchema>;
