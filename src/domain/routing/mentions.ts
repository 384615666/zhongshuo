/**
 * 结构化 mention 解析（§4.1/AT-09）。
 * 路由只消费这里产出的目标集合；正文文本永不进入本模块——这就是
 * 「代码块、Markdown 引用、文件正文、系统日志/工具输出中的 @ 永不触发」的实现形态。
 */
import type { MentionNode } from '../../contracts/routing.ts';
import type { MemberId } from '../../contracts/project.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

export interface ResolvedMentionTargets {
  /** 去重后的明确成员（保持输入顺序）。 */
  memberIds: readonly MemberId[];
  hasAll: boolean;
}

/**
 * 解析 mention 节点为目标集合；未启用/不在房间名单的成员为 INVALID_MENTION。
 * record_only 意图下调用方不执行本函数（mention 不参与判定、零唤醒）。
 */
export function resolveMentionTargets(
  mentions: readonly MentionNode[],
  enabledAgentMemberIds: readonly MemberId[],
): DomainResult<ResolvedMentionTargets> {
  const enabled = new Set(enabledAgentMemberIds);
  const memberIds: MemberId[] = [];
  let hasAll = false;
  for (const node of mentions) {
    if (node.kind === 'all') {
      hasAll = true;
      continue;
    }
    if (!enabled.has(node.memberId)) {
      return domainErr(
        'INVALID_MENTION',
        `mention 目标 ${node.memberId} 不是当前房间启用的 Agent 成员`,
        { details: { memberId: node.memberId } },
      );
    }
    if (!memberIds.includes(node.memberId)) memberIds.push(node.memberId);
  }
  return domainOk({ memberIds, hasAll });
}

/**
 * 路由层的模式判定辅助：@全体 优先于单独 mention（§4.2「以全体为准，去重」）。
 */
export function mentionShapeOf(targets: ResolvedMentionTargets): 'none' | 'single' | 'all' | 'multi' {
  if (targets.hasAll) return 'all';
  if (targets.memberIds.length === 0) return 'none';
  if (targets.memberIds.length === 1) return 'single';
  return 'multi';
}
