/**
 * 上下文过滤（§13.4 隔离矩阵）：组装输入包时按任务范围过滤。
 * 所有引用按「服务端解析的真实归属」校验——指令/摘要/文件与消息一样有白名单，
 * 不因 kind 是 directive/summary 或带了个 baselineId 就无条件放行。
 * agent 入口（zs/adapter 读取）与 daemon 组装共用本过滤。
 */
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';
import type { ContextRef } from '../../contracts/contextBundle.ts';

export interface ContextScopeInput {
  /** 当前任务（含线程）。 */
  task: { id: string; threadId: string | null };
  /** 本线程历史消息 ID（允许）。 */
  threadMessageIds: readonly string[];
  /** 当前任务获准的指令引用（如 `task:{id}:goal`）。 */
  allowedDirectives: readonly string[];
  /** 当前线程获准的摘要引用（如 `thread:{id}:summary`）。 */
  allowedSummaries: readonly string[];
  /** 当前任务获准的分析基线 ID（§6.3/§13.2：文件引用必须落在基线内）。 */
  allowedBaselineIds: readonly string[];
  /** 显式 context_grant 的引用（跨任务引用经用户确认创建，§13.4）。 */
  grantedRefs: readonly string[];
  /** agent/组装方请求的引用集合。 */
  requestedRefs: readonly ContextRef[];
}

export interface FilteredContext {
  included: ContextRef[];
  rejected: Array<{ ref: ContextRef; reason: 'not_in_task_scope' | 'grant_missing' | 'baseline_not_allowed' }>;
}

/**
 * 规则（§13.4 矩阵）：
 * - directive/summary：必须在任务/线程白名单内（服务端解析归属，不信请求自报）。
 * - message：本线程历史或经 grant。
 * - artifact：仅经 grant（本任务自身成果白名单由 DEV-08/09 阶段承接扩展）。
 * - file：baselineId 必须属于当前任务获准基线。
 */
export function filterContextScope(input: ContextScopeInput): DomainResult<FilteredContext> {
  const included: ContextRef[] = [];
  const rejected: FilteredContext['rejected'] = [];
  const thread = new Set(input.threadMessageIds);
  const grants = new Set(input.grantedRefs);
  const directives = new Set(input.allowedDirectives);
  const summaries = new Set(input.allowedSummaries);
  const baselines = new Set(input.allowedBaselineIds);

  for (const ref of input.requestedRefs) {
    switch (ref.kind) {
      case 'directive':
        if (directives.has(ref.refId)) included.push(ref);
        else rejected.push({ ref, reason: 'not_in_task_scope' });
        break;
      case 'summary':
        if (summaries.has(ref.refId)) included.push(ref);
        else rejected.push({ ref, reason: 'not_in_task_scope' });
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
        if (ref.baselineId != null && baselines.has(ref.baselineId)) included.push(ref);
        else rejected.push({ ref, reason: ref.baselineId == null ? 'not_in_task_scope' : 'baseline_not_allowed' });
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
