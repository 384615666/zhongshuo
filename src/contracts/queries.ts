/**
 * 四项只读查询契约（开工契约 §3.3：现在定字段，FULL-11 才接 MCP 工具面）。
 * 游标不透明且绑定主体、过滤条件和授权版本；越权与不存在统一 RESOURCE_NOT_FOUND；
 * 分页不能先截全局前 N 条再漏掉该页全部可见项。
 */
import { z } from 'zod';
import type { OpaqueCursor } from './common.ts';
import type { Support } from './common.ts';
import type { ProjectId, RoomId } from './project.ts';
import type { ConversationId } from './conversation.ts';
import type { ThreadId } from './thread.ts';
import type { TaskId, TaskDelivery } from './task.ts';

// ---------- room.list ----------

export interface RoomListParams {
  projectId: ProjectId;
  includeArchived?: boolean;
  limit?: number;
  cursor?: OpaqueCursor;
}

export interface RoomSummaryItem {
  id: RoomId;
  projectId: ProjectId;
  conversationId: ConversationId;
  name: string;
  archived: boolean;
  revision: number;
}

export interface RoomListResult {
  items: RoomSummaryItem[];
  nextCursor?: OpaqueCursor;
}

export const roomListParamsSchema = z.strictObject({
  projectId: z.string().min(1),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

// ---------- member.list（不暴露凭据/环境变量/私有配置） ----------

export type MemberRuntimeHealth =
  | 'ok'
  | 'auth_required'
  | 'not_installed'
  | 'version_incompatible'
  | 'unverified'
  | 'unknown';

/** 能力摘要：三态，不复制完整 capabilities_json。 */
export interface MemberCapabilitiesSummary {
  restrictWrites: Support;
  interactiveApprovals: Support;
  resumeSession: Support;
  steerActiveTurn: Support;
}

export interface MemberListItem {
  id: string;
  displayName: string;
  enabled: boolean;
  runtimeHealth: MemberRuntimeHealth;
  capabilities: MemberCapabilitiesSummary;
  dispatchable: boolean;
}

export interface MemberListParams {
  projectId: ProjectId;
  roomId?: RoomId;
  limit?: number;
  cursor?: OpaqueCursor;
}

export interface MemberListResult {
  items: MemberListItem[];
  nextCursor?: OpaqueCursor;
}

export const memberListParamsSchema = z.strictObject({
  projectId: z.string().min(1),
  roomId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

// ---------- task.get（未形成交付的任务也可查） ----------

export interface TaskGetParams {
  taskId: TaskId;
}

export interface TaskAttentionSummary {
  waitingForUserCount: number;
  pendingApprovalCount: number;
  blockedReason?: string | null;
}

export interface TaskGetResult {
  id: TaskId;
  conversationId: ConversationId;
  threadId?: ThreadId | null;
  status: string;
  revision: number;
  activeRunId?: string | null;
  stopGeneration: number;
  delivery?: TaskDelivery | null;
  attentionSummary: TaskAttentionSummary;
}

export const taskGetParamsSchema = z.strictObject({
  taskId: z.string().min(1),
});

// ---------- events.list（有限批次；无新事件立即空返回，不持有请求） ----------

export interface EventsListParams {
  projectId: ProjectId;
  conversationId?: ConversationId;
  taskId?: TaskId;
  afterSeq?: number;
  cursor?: OpaqueCursor;
  limit?: number;
}

export interface EventsListResultItem {
  eventId: string;
  seq: number;
  kind: string;
  createdAt: number;
  payload: unknown;
}

export interface EventsListResult {
  items: EventsListResultItem[];
  nextCursor: OpaqueCursor | null;
  hasMore: boolean;
  /** 当前范围高水位；重连游标过旧返回 SNAPSHOT_REQUIRED。 */
  highWatermark: number;
}

export const eventsListParamsSchema = z.strictObject({
  projectId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  afterSeq: z.number().int().nonnegative().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
