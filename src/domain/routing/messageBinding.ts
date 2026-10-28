/**
 * 消息-会话绑定纯校验（开工契约 §2.2 null 约束的跨实体部分）：
 * DM 消息 room_id/thread_id/thread_message_seq 均 NULL、conversation_seq 非空；
 * 房间消息 roomId 必须等于所属会话的 roomId。
 * 单靠 Message schema 表达不了（需要会话 kind），故由本函数在服务端提交路径执行。
 */
import type { ConversationId } from '../../contracts/conversation.ts';
import type { RoomId } from '../../contracts/project.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

export interface MessageBindingCandidate {
  conversationId: ConversationId;
  roomId?: RoomId | null;
  threadId?: string | null;
  threadMessageSeq?: number | null;
}

export interface ConversationBindingRef {
  id: ConversationId;
  kind: 'room' | 'dm';
  roomId?: RoomId | null;
}

export function validateMessageConversationBinding(
  message: MessageBindingCandidate,
  conversation: ConversationBindingRef,
): DomainResult<{ conversationKind: 'room' | 'dm' }> {
  if (message.conversationId !== conversation.id) {
    return domainErr('CONVERSATION_SCOPE_MISMATCH', '消息不属于目标会话');
  }
  if (conversation.kind === 'dm') {
    if (message.roomId != null || message.threadId != null || message.threadMessageSeq != null) {
      return domainErr(
        'CONVERSATION_SCOPE_MISMATCH',
        '私信消息包含了不属于当前对话的信息',
      );
    }
    return domainOk({ conversationKind: 'dm' });
  }
  if (conversation.roomId == null || message.roomId !== conversation.roomId) {
    return domainErr('CONVERSATION_SCOPE_MISMATCH', '房间消息必须携带所属会话的 roomId');
  }
  return domainOk({ conversationKind: 'room' });
}
