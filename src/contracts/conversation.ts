/**
 * 会话（room/dm）、私信参与者、阅读水位与 message.submit 目标判别联合。
 * 依据：主设计 §12.2 + 开工契约 §2.2/§2.3（v1.23 会话增量）。
 */
import { z } from 'zod';
import type { ProjectId, RoomId } from './project.ts';
import type { OpaqueCursor, Revision, TimestampMs } from './common.ts';

export type ConversationId = string;

/** room=房间公共会话（每房间恰一个）；dm=一对一私信（同项目可有多个）。 */
export type ConversationKind = 'room' | 'dm';

export interface Conversation {
  id: ConversationId;
  projectId: ProjectId;
  kind: ConversationKind;
  /** room 会话必填且 (project_id,room_id) 唯一；dm 为 NULL。 */
  roomId?: RoomId | null;
  title?: string | null;
  archivedAt?: TimestampMs | null;
  revision: Revision;
  lastMessageSeq: number;
}

export const conversationSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: z.enum(['room', 'dm']),
  roomId: z.string().min(1).nullable().optional(),
  title: z.string().nullable().optional(),
  archivedAt: z.number().int().nonnegative().nullable().optional(),
  revision: z.number().int().nonnegative(),
  lastMessageSeq: z.number().int().nonnegative(),
}).refine((c) => (c.kind === 'room') !== (c.roomId == null), {
  message: '对话的类型与所属房间信息不匹配',
});

/** DM 参与者：一对一恰两个不同主体；创建后不可追加第三人或替换对端。 */
export interface DmParticipant {
  projectId: ProjectId;
  conversationId: ConversationId;
  principalType: 'human' | 'agent';
  principalId: string;
}

export const dmParticipantSchema = z.strictObject({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  principalType: z.enum(['human', 'agent']),
  principalId: z.string().min(1),
});

/** DM 阅读水位：仅真实授权读取后可推进、单调不回退、不可替其他参与者标已读（§12.2）。 */
export interface ConversationReadState {
  projectId: ProjectId;
  conversationId: ConversationId;
  viewerId: string;
  lastReadSeq: number;
  revision: Revision;
}

export const conversationReadStateSchema = z.strictObject({
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  viewerId: z.string().min(1),
  lastReadSeq: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

/**
 * message.submit 的目标判别联合（开工契约 §2.3）：
 * 必须且只能提供一种目标；旧版客户端参数由版本兼容层转换，不能两种目标并存（§15.2）。
 */
export type MessageTarget =
  | { kind: 'room_root'; projectId: string; conversationId: string; roomId: string }
  | { kind: 'thread'; projectId: string; conversationId: string; threadId: string }
  | { kind: 'dm'; projectId: string; conversationId: string };

export const messageTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('room_root'),
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
    roomId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('thread'),
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
    threadId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('dm'),
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
  }),
]);

/** 派发处置（开工契约 §2.3）：'none'=无派发（record_only/human 对端）；blocked 带原因。 */
export type DispatchDisposition = 'none' | 'queued' | 'paused' | 'blocked';

// ---------- 会话命令契约（开工契约 §2.3） ----------

export interface ConversationCreateParams {
  projectId: ProjectId;
  kind: 'dm';
  peerMemberId: string;
  title?: string;
  commandId: string;
}

export interface ConversationCreateResult {
  conversationId: ConversationId;
  revision: Revision;
}

export interface ConversationListParams {
  projectId: ProjectId;
  archived?: boolean;
  limit?: number;
  cursor?: OpaqueCursor;
}

export interface ConversationSummary {
  conversationId: ConversationId;
  kind: ConversationKind;
  title?: string | null;
  archived: boolean;
  revision: Revision;
  /** 最后消息摘要与未读数；不返回其他 audience 正文。 */
  lastMessagePreview?: string | null;
  lastMessageAt?: TimestampMs | null;
  unreadCount: number;
}

export interface ConversationListResult {
  items: ConversationSummary[];
  nextCursor?: OpaqueCursor;
}

export interface ConversationHistoryParams {
  conversationId: ConversationId;
  beforeSeq?: number;
  limit?: number;
}

export interface ConversationHistoryResult {
  messages: unknown[]; // DEV-02/22 承载具体消息分页载荷
  nextCursor?: OpaqueCursor;
}

export interface ConversationMarkReadParams {
  conversationId: ConversationId;
  throughMessageSeq: number;
}

export interface ConversationMarkReadResult {
  lastReadSeq: number;
  revision: Revision;
}

export interface ConversationRenameParams {
  conversationId: ConversationId;
  title: string;
  expectedRevision: Revision;
}

export interface ConversationArchiveParams {
  conversationId: ConversationId;
  expectedRevision: Revision;
}

export interface ConversationRestoreParams {
  conversationId: ConversationId;
  expectedRevision: Revision;
}

export const conversationCreateParamsSchema = z.strictObject({
  projectId: z.string().min(1),
  kind: z.literal('dm'),
  peerMemberId: z.string().min(1),
  title: z.string().optional(),
  commandId: z.string().min(1),
});

export const conversationListParamsSchema = z.strictObject({
  projectId: z.string().min(1),
  archived: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export const conversationHistoryParamsSchema = z.strictObject({
  conversationId: z.string().min(1),
  beforeSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const conversationMarkReadParamsSchema = z.strictObject({
  conversationId: z.string().min(1),
  throughMessageSeq: z.number().int().nonnegative(),
});

export const conversationRenameParamsSchema = z.strictObject({
  conversationId: z.string().min(1),
  title: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
});

export const conversationArchiveParamsSchema = z.strictObject({
  conversationId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
});

export const conversationRestoreParamsSchema = z.strictObject({
  conversationId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
});
