/**
 * 线程契约（§3.4/§12.2）：仅房间会话创建 thread；DM 不伪造 thread。
 * root_task_id 为空＝历史记录串（决策 21 修订后的兼容形态），永不唤醒 agent。
 */
import { z } from 'zod';
import type { ConversationId } from './conversation.ts';
import type { MemberId, ProjectId, RoomId } from './project.ts';
import type { MessageId } from './message.ts';
import type { Revision } from './common.ts';

export type ThreadId = string;

/**
 * 线程状态：open=正常；closed=任务终态后关闭（保留读取）；
 * archived=所属房间/线程归档（只读）。转换规则由后续包的状态机承担。
 */
export type ThreadStatus = 'open' | 'closed' | 'archived';

export interface ConversationThread {
  id: ThreadId;
  projectId: ProjectId;
  conversationId: ConversationId;
  /** 房间 thread 保留 room_id；DM 不创建 thread（不存在 room_id 为空的 thread）。 */
  roomId: RoomId;
  /** 唯一 anchor：一个顶层消息最多一个串（one_thread_per_anchor）。 */
  anchorMessageId: MessageId;
  /** 空＝记录串（E1）：主池卡片不显示任务编号与状态，永不唤醒 agent。 */
  rootTaskId?: string | null;
  status: ThreadStatus;
  lastMessageSeq: number;
  revision: Revision;
}

export const conversationThreadSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  conversationId: z.string().min(1),
  roomId: z.string().min(1),
  anchorMessageId: z.string().min(1),
  rootTaskId: z.string().min(1).nullable().optional(),
  status: z.enum(['open', 'closed', 'archived']),
  lastMessageSeq: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
}).refine((t) => t.roomId.length > 0, {
  message: 'thread 只属于房间会话；DM 不创建 thread（开工契约 §2.2）',
});

/** 主池卡片聚合视图（§12.6 ThreadSummary）。 */
export interface ThreadSummary {
  threadId: ThreadId;
  replyCount: number;
  participantIds: readonly MemberId[];
  lastReplyAt?: number | null;
  previews: readonly string[];
  taskStatus?: string | null;
  finalArtifactRef?: string | null;
  unreadCount: number;
}
