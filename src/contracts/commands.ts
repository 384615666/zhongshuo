/**
 * 命令信封、结果、领域事件与幂等回执（§15.1、开工契约 §3.2）。
 *
 * CommandEnvelope 是 strict schema：多余字段（如自报 authorId）解析失败——
 * 「契约层不接受自报 authorId 作为授权依据」在类型与运行时双重成立。
 */
import { z } from 'zod';
import type { ConversationId } from './conversation.ts';
import type { ProjectId } from './project.ts';
import type { ThreadId } from './thread.ts';
import type { CommandError } from './errors.ts';
import type { Revision, TimestampMs } from './common.ts';

export const PROTOCOL_VERSION = 1 as const;

export type CommandId = string;
export type IdempotencyScope = string;
/** 规范化 payload 的十六进制摘要；不含凭据（开工契约 §3.2）。 */
export type PayloadHash = string;

/** 幂等键约束：MCP create/send/steer 必带；无键请求直接拒绝（§31.4）。 */
export const commandIdSchema = z.string().min(8).max(128);

export interface CommandEnvelope<TParams = unknown> {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: CommandId;
  method: string;
  projectId?: ProjectId | null;
  expectedRevision?: Revision | null;
  params: TParams;
}

export function commandEnvelopeSchema<TParams extends z.ZodTypeAny>(paramsSchema: TParams) {
  return z.strictObject({
    protocolVersion: z.literal(1),
    commandId: commandIdSchema,
    method: z.string().min(1),
    projectId: z.string().min(1).nullable().optional(),
    expectedRevision: z.number().int().nonnegative().nullable().optional(),
    params: paramsSchema,
  });
}

export interface CommandResult<TData = unknown> {
  commandId: CommandId;
  ok: boolean;
  data?: TData;
  error?: CommandError;
}

/** 幂等回执（command_receipts 行；(idempotency_scope,command_id) 唯一，长期保留墓碑）。 */
export interface CommandReceipt {
  idempotencyScope: IdempotencyScope;
  commandId: CommandId;
  payloadHash: PayloadHash;
  resultJson?: unknown;
  /** 结果数据可能按清理策略删除；删除后同键重试返回 RESULT_EXPIRED，不重新执行。 */
  resultExpiresAt?: TimestampMs | null;
  createdAt: TimestampMs;
}

export const commandReceiptSchema = z.strictObject({
  idempotencyScope: z.string().min(1),
  commandId: commandIdSchema,
  payloadHash: z.string().min(1),
  resultJson: z.unknown().optional(),
  resultExpiresAt: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.number().int().nonnegative(),
});

/** command.result.get(commandId)：scope 从 CallerContext 推导（开工契约 §3.2）。 */
export interface CommandResultGetParams {
  commandId: CommandId;
}

// ---------- 领域事件（§15.1 + 开工契约 §2.2 conversationId 增量） ----------

export interface DomainEvent<TPayload = unknown> {
  schemaVersion: 1;
  eventId: string;
  seq: number;
  projectId: ProjectId;
  /** 会话事件必填；DM 不伪造 threadId。 */
  conversationId?: ConversationId | null;
  /** 线程相关事件必须提供；应用级事件可省略。 */
  threadId?: ThreadId | null;
  taskId?: string | null;
  runId?: string | null;
  turnId?: string | null;
  kind: string;
  createdAt: TimestampMs;
  payload: TPayload;
}

/** 已知事件 kind（非穷尽；§15.5 起步 + §31.7 外部连接审计）。 */
export const KNOWN_EVENT_KINDS = [
  'thread.created',
  'thread.replyAdded',
  'thread.summaryUpdated',
  'thread.readStateChanged',
  'thread.subscriptionChanged',
  'context.granted',
  'context.revoked',
  'message.recorded',
  'task.created',
  'task.statusChanged',
  'run.created',
  'run.statusChanged',
  'turn.dispatched',
  'turn.statusChanged',
  'external.connection.created',
  'external.connection.rotated',
  'external.connection.revoked',
  'external.grant.changed',
  'external.tool_invoked',
] as const;

export type KnownEventKind = (typeof KNOWN_EVENT_KINDS)[number];
