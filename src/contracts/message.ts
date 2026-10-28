/**
 * 消息契约（§12.2 messages 表 + 开工契约 §2.2 增量）。
 * 关键约束：anchor 消息 thread_id 为 NULL；线程回复必带 thread_id 与 thread_message_seq；
 * DM 消息 room/thread/线程序号为空、conversation_seq 非空；via_connection_id 仅限 human 代发。
 */
import { z } from 'zod';
import { collaborationStageSchema, type CollaborationStageMetadata } from './collaborationStage.ts';
import type { ConversationId, MessageTarget, DispatchDisposition } from './conversation.ts';
import type { MentionNode, SendIntent, TopLevelRouteOutcome, ThreadFollowUpOutcome, DmRouteOutcome } from './routing.ts';
import type { ProjectId, RoomId } from './project.ts';
import type { ThreadId } from './thread.ts';
import type { TimestampMs } from './common.ts';
import type { TaskId } from './task.ts';

export type MessageId = string;

/** author_type 四类（§12.2）；不新增取值——third_party_app 留给应用生态（§31.8）。 */
export type AuthorType = 'human' | 'agent' | 'system' | 'third_party_app';

/** 保存→流式→终结（§12.6：一条流式回复先显示进行中，终结时只计一次）。 */
export type MessageStatus = 'saved' | 'streaming' | 'final' | 'invalid';

/**
 * 消息正文 JSON：文本 + 输入框识别的结构化 mention 节点（渲染与审计用）。
 * mentions 是路由唯一依据的镜像存储；正文文本中的 @ 无执行语义。
 */
export interface MessageBodyJson {
  text: string;
  mentions?: readonly MentionNode[];
  conversationIntent?: 'default'|'record_only';
  runtimeControlResult?:string;
  /** 已完成研讨阶段产物的呈现标记（R91；仅结构化阶段产物消息携带）。 */
  collaborationStage?: CollaborationStageMetadata;
}

export interface Message {
  id: MessageId;
  projectId: ProjectId;
  conversationId: ConversationId;
  /** 服务端事务分配的会话内序号；(conversation_id,conversation_seq) 唯一。 */
  conversationSeq: number;
  roomId?: RoomId | null;
  /** 顶层 anchor 消息为 NULL；线程回复必填。 */
  threadId?: ThreadId | null;
  taskId?: TaskId | null;
  replyToMessageId?: MessageId | null;
  threadMessageSeq?: number | null;
  authorType: AuthorType;
  authorId: string;
  /** 仅 author_type=human 的直接代发标记（经外部助手 X 代发）；不作为任务链授权真源（§31.8）。 */
  viaConnectionId?: string | null;
  bodyJson: MessageBodyJson;
  status: MessageStatus;
  createdAt: TimestampMs;
}

export const messageBodyJsonSchema = z.strictObject({
  text: z.string(),
  conversationIntent:z.enum(['default','record_only']).optional(),
  runtimeControlResult:z.string().optional(),
  collaborationStage: collaborationStageSchema.optional(),
  mentions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member'), memberId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('all') }),
  ])).optional(),
});

export const messageSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  conversationSeq: z.number().int().nonnegative(),
  roomId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
  taskId: z.string().min(1).nullable().optional(),
  replyToMessageId: z.string().min(1).nullable().optional(),
  threadMessageSeq: z.number().int().nonnegative().nullable().optional(),
  authorType: z.enum(['human', 'agent', 'system', 'third_party_app']),
  authorId: z.string().min(1),
  viaConnectionId: z.string().min(1).nullable().optional(),
  bodyJson: messageBodyJsonSchema,
  status: z.enum(['saved', 'streaming', 'final', 'invalid']),
  createdAt: z.number().int().nonnegative(),
}).refine((m) => m.viaConnectionId == null || m.authorType === 'human', {
  message: '消息来源与作者类型不匹配',
}).refine((m) => {
  // anchor：thread_id 为 NULL ⇔ thread_message_seq 为 NULL；线程回复两者皆非空。
  const isAnchor = m.threadId == null;
  return isAnchor === (m.threadMessageSeq == null);
}, {
  message: 'thread_id 与 thread_message_seq 必须同为空（anchor）或同非空（串内回复）',
});

// ---------- message.submit（§15.2 + 开工契约 §2.3） ----------

export interface MessageSubmitParams {
  target: MessageTarget;
  body: string;
  attachmentRefs: readonly string[];
  intent: SendIntent;
  /** 结构化 mention 节点；DM 目标必须为空（无私信 @ 派工）。 */
  mentions: readonly MentionNode[];
  commandId: string;
}

export interface MessageSubmitResult {
  messageId: MessageId;
  conversationId: ConversationId;
  threadId?: ThreadId | null;
  taskId?: TaskId | null;
  runId?: string | null;
  disposition: DispatchDisposition;
  /** 服务端二次校验后的最终路由事实（§15.2）。 */
  resolvedRoute:
    | { surface: 'room_root'; outcome: TopLevelRouteOutcome }
    | { surface: 'thread'; outcome: ThreadFollowUpOutcome }
    | { surface: 'dm'; outcome: DmRouteOutcome };
}
