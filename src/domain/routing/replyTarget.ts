/**
 * 回复目的地解析（§4.5：回复目的地是服务端约束；开工契约 §2.3 目标判别）。
 * 目标不匹配返回错误，绝不兜底发到主池。
 */
import type { MessageTarget } from '../../contracts/conversation.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

export interface ReplyTargetKnownEntities {
  /** thread 目标时服务端反查的线程记录；room 顶层 anchor 消息新线程的创建见 §12.3 单事务。 */
  thread?: {
    id: string;
    projectId: string;
    conversationId: string;
    roomId: string;
    anchorMessageId: string;
    rootTaskId?: string | null;
  } | null;
  conversation?: {
    id: string;
    projectId: string;
    kind: 'room' | 'dm';
    roomId?: string | null;
    archived?: boolean;
  } | null;
  /** reply_to_message_id 指向的候选消息（§12.3：必须指向同串回复或该串 anchor）。 */
  replyToMessage?: {
    id: string;
    threadId?: string | null;
    /** 是否为其线程的 anchor（thread_id 为 NULL 的顶层消息）。 */
    isRoomAnchor: boolean;
    anchorOfThreadId?: string | null;
  } | null;
}

export type ReplyTargetResolution =
  | {
      /** 主池发送 → 创建新线程（预分配 threadId，§12.3 单事务关联）。 */
      kind: 'new_thread';
      roomId: string;
      conversationId: string;
      anchorMessageId: string;
      preallocatedThreadId: string;
    }
  | { kind: 'existing_thread'; threadId: string; conversationId: string }
  | { kind: 'dm_conversation'; conversationId: string };

export interface ResolveReplyTargetInput {
  target: MessageTarget;
  entities: ReplyTargetKnownEntities;
  /** 调用方（事务层）预分配的新线程 ID；根消息、线程与任务使用不同 ID 单事务创建（§3.4）。 */
  preallocatedThreadId?: string;
  /** 主池根消息 ID（anchor）。 */
  newAnchorMessageId?: string;
}

export function resolveReplyTarget(
  input: ResolveReplyTargetInput,
): DomainResult<ReplyTargetResolution> {
  const { target, entities } = input;

  switch (target.kind) {
    case 'room_root': {
      const conv = entities.conversation;
      if (conv == null) {
        return domainErr('RESOURCE_NOT_FOUND', '目标会话不存在');
      }
      if (conv.projectId !== target.projectId || conv.id !== target.conversationId) {
        return domainErr('CONVERSATION_SCOPE_MISMATCH', 'room_root 目标与会话归属不一致');
      }
      if (conv.kind !== 'room' || conv.roomId !== target.roomId) {
        return domainErr('CONVERSATION_SCOPE_MISMATCH', 'room_root 目标必须是房间会话且 roomId 一致');
      }
      if (conv.archived) {
        return domainErr('ROOM_ARCHIVED', '房间已归档，恢复后可以新增任务；已有记录仍可查看');
      }
      if (input.preallocatedThreadId == null || input.newAnchorMessageId == null) {
        return domainErr(
          'VALIDATION_INVALID',
          '对话创建未完成，请重新发送',
        );
      }
      return domainOk({
        kind: 'new_thread',
        roomId: target.roomId,
        conversationId: target.conversationId,
        anchorMessageId: input.newAnchorMessageId,
        preallocatedThreadId: input.preallocatedThreadId,
      });
    }
    case 'thread': {
      const thread = entities.thread;
      if (thread == null) {
        return domainErr('RESOURCE_NOT_FOUND', '目标线程不存在');
      }
      if (
        thread.projectId !== target.projectId ||
        thread.conversationId !== target.conversationId ||
        thread.id !== target.threadId
      ) {
        // 不兜底发到主池；保留草稿并提示（§16.5 THREAD_SCOPE_MISMATCH）。
        return domainErr('THREAD_SCOPE_MISMATCH', '回复目标线程与项目/会话不一致，拒绝提交');
      }
      const replyTo = entities.replyToMessage;
      if (replyTo != null) {
        const inSameThread =
          replyTo.threadId === thread.id ||
          (replyTo.isRoomAnchor && replyTo.anchorOfThreadId === thread.id);
        if (!inSameThread) {
          return domainErr(
            'THREAD_SCOPE_MISMATCH',
            '引用的消息不在当前回复串中',
          );
        }
      }
      return domainOk({
        kind: 'existing_thread',
        threadId: thread.id,
        conversationId: thread.conversationId,
      });
    }
    case 'dm': {
      const conv = entities.conversation;
      if (conv == null) {
        return domainErr('RESOURCE_NOT_FOUND', '目标会话不存在');
      }
      if (conv.projectId !== target.projectId || conv.id !== target.conversationId) {
        return domainErr('CONVERSATION_SCOPE_MISMATCH', 'dm 目标与会话归属不一致');
      }
      if (conv.kind !== 'dm') {
        return domainErr('CONVERSATION_SCOPE_MISMATCH', 'dm 目标必须是 kind=dm 的会话');
      }
      // DM 的目的地是 conversationId，不创建伪 thread（§4.5）。
      return domainOk({ kind: 'dm_conversation', conversationId: target.conversationId });
    }
    default: {
      // 运行时防御：schema 之外的 kind 整笔拒绝，不猜测目标（必须且只能提供一种目标）。
      const exhaustive: never = target;
      return domainErr(
        'VALIDATION_INVALID',
        `未知 MessageTarget kind：${JSON.stringify((exhaustive as { kind?: unknown })?.kind)}`,
      );
    }
  }
}
