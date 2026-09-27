/**
 * 顶层（主池根消息）路由（§4.2 路由表逐行）。
 * 纯函数、无状态；不做任何 IO。正文文本不是输入——AT-09 由函数形态保证。
 */
import type {
  MentionNode,
  SendIntent,
  TopLevelRouteOutcome,
} from '../../contracts/routing.ts';
import type { MemberId } from '../../contracts/project.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';
import { mentionShapeOf, resolveMentionTargets } from './mentions.ts';

export interface TopLevelRouteInput {
  intent: SendIntent;
  /** 输入框识别的结构化节点；代码块/引用/正文文本中的 @ 永不进入此数组。 */
  mentions: readonly MentionNode[];
  room: {
    /** 房间默认协调者（AUTO 接单者；新房间沿用项目当前默认，E5）。 */
    coordinatorMemberId: MemberId;
    /** 发送时该房间内启用的全部 agent（@全体 的冻结名单基础，§4.3）。 */
    enabledAgentMemberIds: readonly MemberId[];
  };
}

/**
 * §4.2 路由表：
 * - 无 mention → AUTO（默认协调者接单）
 * - 单个明确 mention → DIRECT（仅指定成员）
 * - @全体 → DELIBERATE（冻结房间启用名单）
 * - 多个明确 mention → DELIBERATE（仅所选子集）
 * - @全体 + 单独 mention → 以全体为准，去重
 * - intent='record_only' → 保存记录：零任务/运行/派发/预算，mention 不参与判定、零唤醒
 */
export function resolveTopLevelRoute(input: TopLevelRouteInput): DomainResult<TopLevelRouteOutcome> {
  if (input.intent === 'record_only') {
    return domainOk({ kind: 'record_only', reason: 'explicit_record_only' });
  }

  const targets = resolveMentionTargets(input.mentions, input.room.enabledAgentMemberIds);
  if (!targets.ok) return targets;
  const shape = mentionShapeOf(targets.value);

  switch (shape) {
    case 'none': {
      if (!input.room.enabledAgentMemberIds.includes(input.room.coordinatorMemberId)) {
        return domainErr(
          'MEMBER_UNAVAILABLE',
          '默认协调者当前不可用；AUTO 模式需要可用的协调者（替代者选择见 §4.3，由后续调度包承载）',
          { details: { coordinatorMemberId: input.room.coordinatorMemberId } },
        );
      }
      const coordinator = input.room.coordinatorMemberId;
      return domainOk<TopLevelRouteOutcome>({
        kind: 'dispatch',
        mode: 'AUTO',
        coordinatorMemberId: coordinator,
        frozenMemberIds: [coordinator],
        initialWakeMemberIds: [coordinator],
      });
    }
    case 'single': {
      const target = targets.value.memberIds[0];
      if (target === undefined) {
        return domainErr('VALIDATION_INVALID', 'mention 解析异常：single 但无成员');
      }
      return domainOk<TopLevelRouteOutcome>({
        kind: 'dispatch',
        mode: 'DIRECT',
        targetMemberId: target,
        frozenMemberIds: [target],
        initialWakeMemberIds: [target],
      });
    }
    case 'multi': {
      return domainOk<TopLevelRouteOutcome>({
        kind: 'dispatch',
        mode: 'DELIBERATE',
        rosterSource: 'selected',
        frozenMemberIds: [...targets.value.memberIds],
        initialWakeMemberIds: [...targets.value.memberIds],
      });
    }
    case 'all': {
      // 以全体为准并去重；名单在创建运行时冻结，不悄悄排除离线成员（§4.3）。
      const frozen = [...input.room.enabledAgentMemberIds];
      if (frozen.length === 0) {
        return domainErr(
          'MEMBER_UNAVAILABLE',
          '@全体 但房间没有启用的 Agent 成员，无法冻结名单',
        );
      }
      return domainOk<TopLevelRouteOutcome>({
        kind: 'dispatch',
        mode: 'DELIBERATE',
        rosterSource: 'all',
        frozenMemberIds: frozen,
        initialWakeMemberIds: frozen,
      });
    }
  }
}

/**
 * message.submit 层的演示管道：证明正文文本不参与路由（AT-09）。
 * body 参数被有意不使用；路由只看 mentions/intent/room。
 */
export function resolveTopLevelRouteFromMessage(
  message: {
    body: string;
    intent: SendIntent;
    mentions: readonly MentionNode[];
  },
  room: TopLevelRouteInput['room'],
): DomainResult<TopLevelRouteOutcome> {
  void message.body; // 正文永不构成执行指令（§4.1/§31.1 第 5 条）
  return resolveTopLevelRoute({ intent: message.intent, mentions: message.mentions, room });
}
