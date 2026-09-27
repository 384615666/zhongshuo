/**
 * 任务链来源推导（§31.8 / 开工契约 §3.1：connectionId 与 sourceConnectionId 分开）。
 * 本机用户新建根任务 sourceConnectionId=null；
 * 外部任务派生的子任务、提醒与本地 zs 调用必须继承原来源/范围，不能因入口本地化清空。
 */
import { domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

export interface TaskSourceInput {
  /** 父任务来源（子任务/交接/提醒继承链）。 */
  parentSourceConnectionId: string | null;
  /** 当前调用者的直接连接（本地 UI/zs 无连接时为 null）。 */
  callerConnectionId: string | null;
  /** 是否根任务（无父任务）。 */
  isRootTask: boolean;
}

export type TaskSourceDecision = { sourceConnectionId: string | null; basis: 'local_root' | 'inherit_parent' | 'caller_connection' };

export function deriveTaskSourceConnection(input: TaskSourceInput): DomainResult<TaskSourceDecision> {
  if (input.isRootTask) {
    if (input.callerConnectionId != null) {
      return domainOk({ sourceConnectionId: input.callerConnectionId, basis: 'caller_connection' });
    }
    return domainOk({ sourceConnectionId: null, basis: 'local_root' });
  }
  // 子任务/派生调用：父链来源优先，入口本地化不清空限制。
  return domainOk({
    sourceConnectionId: input.parentSourceConnectionId ?? input.callerConnectionId,
    basis: 'inherit_parent',
  });
}
