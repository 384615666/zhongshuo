/**
 * 上下文过滤（§13.4 隔离矩阵的最小实现）：组装输入包时按任务范围过滤；
 * 未授权引用拒绝（CONTEXT_NOT_GRANTED），不先检索全房间再指望模型自己忽略。
 * agent 入口（zs/adapter 读取）与 daemon 组装共用本过滤。
 */
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';
import type { ContextRef } from '../../contracts/contextBundle.ts';

export interface ContextScopeInput {
  /** 当前任务（含线程）。 */
  task: { id: string; threadId: string | null };
  /** 本线程历史（允许）。 */
  threadMessageIds: readonly string[];
  /** 显式 context_grant 的引用（跨任务引用经用户确认创建，§13.4）。 */
  grantedRefs: readonly string[];
  /** agent/组装方请求的引用集合。 */
  requestedRefs: readonly ContextRef[];
}

export interface FilteredContext {
  included: ContextRef[];
  rejected: Array<{ ref: ContextRef; reason: 'not_in_task_scope' | 'grant_missing' }>;
}

/**
 * 规则（§13.4 矩阵）：
 * - directive/summary 类任务指令与摘要：允许（属当前任务）。
 * - message：必须属于本线程（threadMessageIds）或经 grant。
 * - artifact：必须经 grant（跨任务成果显式授权）；本任务自身成果由 stageArtifacts 白名单承接（DEV-08/09 扩展）。
 * - file：属项目基线范围（baselineId 存在即项目共享文件，允许；无基线引用按 not_in_task_scope 拒绝）。
 */
export function filterContextScope(input: ContextScopeInput): DomainResult<FilteredContext> {
  const included: ContextRef[] = [];
  const rejected: FilteredContext['rejected'] = [];
  const thread = new Set(input.threadMessageIds);
  const grants = new Set(input.grantedRefs);

  for (const ref of input.requestedRefs) {
    switch (ref.kind) {
      case 'directive':
      case 'summary':
        included.push(ref);
        break;
      case 'message':
        if (thread.has(ref.refId) || grants.has(ref.refId)) included.push(ref);
        else rejected.push({ ref, reason: 'not_in_task_scope' });
        break;
      case 'artifact':
        if (grants.has(ref.refId)) included.push(ref);
        else rejected.push({ ref, reason: 'grant_missing' });
        break;
      case 'file':
        if (ref.baselineId != null) included.push(ref);
        else rejected.push({ ref, reason: 'not_in_task_scope' });
        break;
    }
  }

  if (rejected.length > 0 && included.length === 0 && input.requestedRefs.length > 0) {
    // 全部被拒：明确报错，不装出“空但成功”的输入包。
    return domainErr('CONTEXT_NOT_GRANTED', '请求的引用全部超出当前任务上下文范围', {
      details: { rejected: rejected.map((r) => ({ refId: r.ref.refId, reason: r.reason })) },
    });
  }
  return domainOk({ included, rejected });
}
