/**
 * 串内跟进路由（§4.2 任务讨论串三行 + 记录串兼容例外 + §0.22 一次性「仅记录」）。
 */
import type {
  MentionNode,
  SendIntent,
  ThreadFollowUpOutcome,
} from '../../contracts/routing.ts';
import type { MemberId } from '../../contracts/project.ts';
import { domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';
import { resolveMentionTargets } from './mentions.ts';

export interface ThreadFollowUpInput {
  intent: SendIntent;
  mentions: readonly MentionNode[];
  thread: {
    /** 空＝历史记录串（E1）：讨论线程永不唤醒 agent，默认仍是保存记录（兼容例外）。 */
    rootTaskId: string | null;
  };
  /** 当前任务参与者（本次 run_participants）。 */
  currentParticipantMemberIds: readonly MemberId[];
  /** 房间启用 agent 名单（@全体 解析基础）。 */
  roomEnabledAgentMemberIds: readonly MemberId[];
}

/**
 * - 记录串 → record_only（无论 mention 与 intent；讨论线程永不唤醒）
 * - intent=record_only → record_only（不 steering）
 * - 无 mention → steering（延续当前参与者与模式）
 * - 点名当前参与者 → 定向提问
 * - 点名非参与者 → expansion_proposal（待用户确认扩大范围，不直接唤醒，决策 10）
 * ADR-15 任务内互唤的执行语义留给后续 daemon/domain 包，本函数只做分类。
 */
export function resolveThreadFollowUp(
  input: ThreadFollowUpInput,
): DomainResult<ThreadFollowUpOutcome> {
  if (input.thread.rootTaskId == null) {
    return domainOk({ kind: 'record_only', reason: 'record_thread_default' });
  }
  if (input.intent === 'record_only') {
    return domainOk({ kind: 'record_only', reason: 'explicit_record_only' });
  }

  const targets = resolveMentionTargets(input.mentions, input.roomEnabledAgentMemberIds);
  if (!targets.ok) return targets;

  // @全体 解析为房间全部启用 agent；点名语义与成员 mention 一致。
  const mentioned: readonly MemberId[] = targets.value.hasAll
    ? [...input.roomEnabledAgentMemberIds]
    : targets.value.memberIds;
  if (mentioned.length === 0) {
    return domainOk({ kind: 'steering' });
  }

  const participants = new Set(input.currentParticipantMemberIds);
  const nonParticipants = mentioned.filter((id) => !participants.has(id));
  if (nonParticipants.length > 0) {
    return domainOk({ kind: 'expansion_proposal', candidateMemberIds: nonParticipants });
  }
  return domainOk({ kind: 'directed_question', memberIds: [...mentioned] });
}
