import { z } from 'zod';

/**
 * Native desktop notifications are deliberately split into a renderer poll and
 * a main-only claim. The renderer only ever sees opaque IDs; titles, bodies and
 * navigation targets stay daemon-controlled until main claims and validates
 * them.
 */
export const TASK_NOTIFICATION_COMMANDS = {
  poll: 'taskNotification.poll',
  claim: 'taskNotification.claim',
  ack: 'taskNotification.ack',
} as const;

export const TASK_NOTIFICATION_IPC = {
  show: 'zs:task-notification.show',
  click: 'zs:task-notification.click',
} as const;

export const taskNotificationIdSchema = z.string().regex(/^ntf_[a-f0-9]{32}$/);

export const taskNotificationKindSchema = z.enum([
  'task.completed',
  'task.needs_attention',
  'task.needs_input',
  'task.needs_review',
]);
export type TaskNotificationKind = z.infer<typeof taskNotificationKindSchema>;

export const taskNotificationLocatorSchema = z.strictObject({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  roomId: z.string().min(1).max(200).nullable(),
  threadId: z.string().min(1).max(200).nullable(),
  taskId: z.string().min(1).max(200),
  hash: z.string().regex(/^#(?:task|msg|dm)=[A-Za-z0-9_:-]{1,180}$/),
});
export type TaskNotificationLocator = z.infer<typeof taskNotificationLocatorSchema>;

export const taskNotificationDeliverySchema = z.strictObject({
  notificationId: taskNotificationIdSchema,
  kind: taskNotificationKindSchema,
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(400),
  createdAt: z.number().int().nonnegative(),
  locator: taskNotificationLocatorSchema,
});
export type TaskNotificationDelivery = z.infer<typeof taskNotificationDeliverySchema>;

export const taskNotificationPollParamsSchema = z.strictObject({
  limit: z.number().int().min(1).max(20).default(3),
});
export type TaskNotificationPollParams = z.infer<typeof taskNotificationPollParamsSchema>;

export const taskNotificationAttemptViewSchema = z.strictObject({
  notificationId: taskNotificationIdSchema,
  title: z.string().min(1).max(120),
  state: z.enum(['pending', 'claimed', 'show_requested', 'shown', 'failed', 'unknown', 'suppressed']),
  claimRequestedAt: z.number().int().nonnegative(),
  showRequestedAt: z.number().int().nonnegative().nullable(),
  shownAt: z.number().int().nonnegative().nullable(),
  failedAt: z.number().int().nonnegative().nullable(),
  failureReason: z.string().max(500).nullable(),
  clickedAt: z.number().int().nonnegative().nullable(),
  closedAt: z.number().int().nonnegative().nullable(),
});
export type TaskNotificationAttemptView = z.infer<typeof taskNotificationAttemptViewSchema>;

export const taskNotificationPollResultSchema = z.strictObject({
  items: z.array(z.strictObject({ notificationId: taskNotificationIdSchema })).max(20),
  scannedThroughSeq: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  health: z.strictObject({
    attempted: z.number().int().nonnegative(),
    showRequested: z.number().int().nonnegative(),
    shown: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    clicked: z.number().int().nonnegative(),
  }),
  recentAttempts: z.array(taskNotificationAttemptViewSchema).max(5),
});
export type TaskNotificationPollResult = z.infer<typeof taskNotificationPollResultSchema>;

export const taskNotificationClaimParamsSchema = z.strictObject({
  notificationId: taskNotificationIdSchema,
});

export const taskNotificationClaimResultSchema = z.discriminatedUnion('claimed', [
  z.strictObject({ claimed: z.literal(true), notification: taskNotificationDeliverySchema }),
  z.strictObject({
    claimed: z.literal(false),
    reason: z.enum(['not_found', 'not_pending', 'in_flight', 'muted']),
  }),
]);
export type TaskNotificationClaimResult = z.infer<typeof taskNotificationClaimResultSchema>;

export const taskNotificationAckParamsSchema = z.strictObject({
  notificationId: taskNotificationIdSchema,
  stage: z.enum(['show_requested', 'shown', 'failed', 'clicked', 'closed']),
  error: z.string().max(500).optional(),
});
export type TaskNotificationAckParams = z.infer<typeof taskNotificationAckParamsSchema>;

export const taskNotificationAckResultSchema = z.strictObject({
  notificationId: taskNotificationIdSchema,
  state: z.enum(['claimed', 'show_requested', 'shown', 'failed', 'unknown', 'suppressed']),
  attempt: taskNotificationAttemptViewSchema,
});
export type TaskNotificationAckResult = z.infer<typeof taskNotificationAckResultSchema>;

export const taskNotificationClickSchema = z.strictObject({
  notificationId: taskNotificationIdSchema,
  kind: taskNotificationKindSchema.optional(),
  locator: taskNotificationLocatorSchema,
});
export type TaskNotificationClick = z.infer<typeof taskNotificationClickSchema>;

export const taskNotificationShowResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    notificationId: taskNotificationIdSchema,
    state: z.literal('requested'),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(['not_found', 'not_pending', 'in_flight', 'muted', 'unsupported']),
  }),
]);
export type TaskNotificationShowResult = z.infer<typeof taskNotificationShowResultSchema>;
