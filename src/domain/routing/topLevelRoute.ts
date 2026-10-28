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
  /** Explicit advanced workflow; mentions alone only choose recipients. */
  collaboration?: 'deliberate';
  /** 输入框识别的结构化节点；代码块/引用/正文文本中的 @ 永不进入此数组。 */
  mentions: readonly MentionNode[];
  room: {
    /** 房间默认协调者（AUTO 接单者；新房间沿用项目当前默认，E5）。 */
    coordinatorMemberId: MemberId;
    /** 发送时该房间内启用的全部 agent（@全体 的冻结名单基础，§4.3）。 */
    enabledAgentMemberIds: readonly MemberId[];
  };
}

/** Ordinary multi-recipient messages use natural collaboration. The fixed
 * independent/review/ratification workflow requires an explicit advanced choice.
 * Record-only never dispatches, whatever recipients or advanced choice are set. */
export function resolveTopLevelRoute(input: TopLevelRouteInput): DomainResult<TopLevelRouteOutcome> {
  if (input.intent === 'record_only') {
    return domainOk({ kind: 'record_only', reason: 'explicit_record_only' });
  }

  const targets = resolveMentionTargets(input.mentions, input.room.enabledAgentMemberIds);
  if (!targets.ok) return targets;
  const shape = mentionShapeOf(targets.value);

  if(input.collaboration==='deliberate'){
    const frozen=shape==='all'?[...input.room.enabledAgentMemberIds]:[...targets.value.memberIds];
    if(frozen.length<2)return domainErr('VALIDATION_INVALID','独立研讨需要明确选择至少两位成员，或选择全体');
    return domainOk({kind:'dispatch',mode:'DELIBERATE',rosterSource:shape==='all'?'all':'selected',frozenMemberIds:frozen,initialWakeMemberIds:frozen});
  }
  switch (shape) {
    case 'none': {
      if (!input.room.enabledAgentMemberIds.includes(input.room.coordinatorMemberId)) {
        return domainErr(
          'MEMBER_UNAVAILABLE',
          '房间的默认 AI 当前不可用，请启用它或选择其他成员',
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
    case 'multi':
    case 'all': {
      const frozen=shape==='all'?[...input.room.enabledAgentMemberIds]:[...targets.value.memberIds];
      if(!frozen.length)return domainErr('MEMBER_UNAVAILABLE','房间没有可用的 AI 成员，请先添加成员');
      const coordinator=frozen.includes(input.room.coordinatorMemberId)?input.room.coordinatorMemberId:frozen[0]!;
      return domainOk({kind:'dispatch',mode:'AUTO',coordinatorMemberId:coordinator,participantScope:'selected',frozenMemberIds:frozen,initialWakeMemberIds:[coordinator]});
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
    collaboration?: 'deliberate';
    mentions: readonly MentionNode[];
  },
  room: TopLevelRouteInput['room'],
): DomainResult<TopLevelRouteOutcome> {
  void message.body; // 正文永不构成执行指令（§4.1/§31.1 第 5 条）
  return resolveTopLevelRoute({ intent: message.intent, collaboration:message.collaboration, mentions: message.mentions, room });
}
