/**
 * 私信路由（§4.6，2026-09-25 收敛为 1 对 1；开工契约 §2）。
 * 发送＝把这条消息交给该会话唯一成员；不推导 Mode、不涉及协调者、无群聊冻结名单；
 * 正文/粘贴文本中的 @ 对结果零影响（正文不是本函数输入）。
 */
import type { DmRouteOutcome, SendIntent } from '../../contracts/routing.ts';
import type { ConversationId } from '../../contracts/conversation.ts';
import type { MemberId, PrincipalType } from '../../contracts/project.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

export interface DmRouteInput {
  intent: SendIntent;
  conversation: {
    id: ConversationId;
    kind: 'dm';
    archived: boolean;
    /** 会话唯一对端（dm_participants 恰两个主体中的非本机用户一侧）。 */
    peerMember: { memberId: MemberId; principalType: PrincipalType };
  };
}

/**
 * - record_only → 只保存，不建执行；
 * - agent 对端 → daemon 建立 dm_turn/DIRECT 内部执行（executes=true）；
 * - human 对端 → 只投递保存，派发集合为空（executes=false）；
 * - 不分配房间任务号、不产出任务卡；同成员多条私信按 conversationId 隔离。
 */
export function resolveDmRoute(input: DmRouteInput): DomainResult<DmRouteOutcome> {
  if (input.conversation.archived) {
    return domainErr('CONVERSATION_ARCHIVED', '对话已归档，恢复后可以继续发送消息');
  }
  if (input.intent === 'record_only') {
    return domainOk({
      kind: 'record_only',
      reason: 'explicit_record_only',
      conversationId: input.conversation.id,
    });
  }
  const peer = input.conversation.peerMember;
  return domainOk({
    kind: 'deliver_to_peer',
    conversationId: input.conversation.id,
    peerMemberId: peer.memberId,
    executes: peer.principalType === 'agent',
  });
}
