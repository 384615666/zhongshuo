/**
 * 授权范围逐次校验（§31.1 第 3 条的最小落地；开工契约 §3.1）。
 * 「可读上下文 / 可执行操作 / 可调度成员」三维分别判断 + 第四维预算；
 * 读不蕴含唤醒，发起不蕴含扩权。
 */
import type { CallerContext, OperationKind } from '../../contracts/caller.ts';
import { USER_ONLY_OPERATIONS } from '../../contracts/caller.ts';
import type { BudgetState } from '../../contracts/budget.ts';
import type { ConversationId } from '../../contracts/conversation.ts';
import type { MemberId, ProjectId } from '../../contracts/project.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';
import { canReserveTurns } from '../budget.ts';

/** 会触发模型派发的操作（区别于纯读取/纯保存）。 */
export type DispatchBearingOperation = 'message.submit' | 'task.create' | 'task.steer';

export interface PlannedDispatch {
  projectId: ProjectId;
  conversationId?: ConversationId;
  targetMemberIds: readonly MemberId[];
  operation: DispatchBearingOperation;
  /** 任务预算快照（本地 UI 根任务也受任务/运行预算约束）。 */
  taskBudget?: BudgetState | null;
  /** 发起连接工作链预算：仅连接来源的工作链需要（本地 UI 为空）。 */
  connectionChainBudget?: BudgetState | null;
}

export interface DispatchScopeCheck {
  contextGranted: boolean;
  operationGranted: boolean;
  membersGranted: boolean;
  budgetGranted: boolean;
  blockedMemberIds: readonly MemberId[];
}

function contextAllows(caller: CallerContext, plan: PlannedDispatch): boolean {
  if (!caller.projectIds.includes(plan.projectId)) return false;
  if (plan.conversationId != null) {
    const scope = caller.conversationScope;
    if (scope.kind === 'listed' && !scope.conversationIds.includes(plan.conversationId)) {
      return false;
    }
  }
  return true;
}

function membersAllow(caller: CallerContext, plan: PlannedDispatch): {
  granted: boolean;
  blocked: readonly MemberId[];
} {
  const scope = caller.dispatchMemberScope;
  if (scope.kind === 'all_enabled') return { granted: true, blocked: [] };
  const allowed = new Set(scope.memberIds);
  const blocked = plan.targetMemberIds.filter((id) => !allowed.has(id));
  return { granted: blocked.length === 0, blocked };
}

function budgetAllows(plan: PlannedDispatch): boolean {
  if (plan.taskBudget != null && !canReserveTurns(plan.taskBudget, 1)) return false;
  if (plan.connectionChainBudget != null && !canReserveTurns(plan.connectionChainBudget, 1)) {
    return false;
  }
  return true;
}

/**
 * 逐维校验并给出首个失败维度的错误码：
 * - CONTEXT_NOT_GRANTED_TO_CALLER：调用者无目标上下文读取范围
 * - OPERATION_NOT_GRANTED：读不蕴含唤醒（操作集不含派发型操作）
 * - MEMBER_NOT_DISPATCHABLE：目标成员超出可调度范围（连接链硬上限，§31.5）
 * - BUDGET_EXHAUSTED：任一预算维度不足
 */
export function validateDispatchScope(
  caller: CallerContext,
  plan: PlannedDispatch,
): DomainResult<DispatchScopeCheck> {
  const contextGranted = contextAllows(caller, plan);
  if (!contextGranted) {
    return domainErr(
      'CONTEXT_NOT_GRANTED_TO_CALLER',
      '调用者不具备目标上下文的可读范围（读不蕴含唤醒，更不蕴含派发）',
    );
  }
  const operationGranted = caller.operations.includes(plan.operation);
  if (!operationGranted) {
    return domainErr(
      'OPERATION_NOT_GRANTED',
      `操作 ${plan.operation} 不在调用者授权操作集内；读取权限不附带派发权`,
    );
  }
  const members = membersAllow(caller, plan);
  if (!members.granted) {
    return domainErr(
      'MEMBER_NOT_DISPATCHABLE',
      '目标成员超出调用者可调度成员范围（连接工作链的硬上限）',
      { details: { blockedMemberIds: members.blocked } },
    );
  }
  const budgetGranted = budgetAllows(plan);
  if (!budgetGranted) {
    return domainErr('BUDGET_EXHAUSTED', '任务预算或发起连接工作链预算不足，拒绝派发');
  }
  return domainOk({
    contextGranted,
    operationGranted,
    membersGranted: true,
    budgetGranted,
    blockedMemberIds: [],
  });
}

/**
 * 「仅用户可做」按实际调用主体判断（§31.2 归属≠权限）：
 * external_connection / agent_task_credential 一律拒绝；
 * paired_device 映射已认证人类主体，允许。
 */
export function assertUserOnlyOperation(
  caller: CallerContext,
  operation: OperationKind,
): DomainResult<{ allowed: true }> {
  if (!USER_ONLY_OPERATIONS.includes(operation)) {
    return domainOk({ allowed: true });
  }
  const principalIsHuman =
    caller.actualPrincipal.kind === 'local_user' ||
    caller.actualPrincipal.kind === 'paired_device';
  if (!principalIsHuman) {
    return domainErr(
      'OPERATION_NOT_GRANTED',
      `操作 ${operation} 仅用户可做：实际调用主体是 ${caller.actualPrincipal.kind}，与代发归属/author_type 无关`,
    );
  }
  if (!caller.operations.includes(operation)) {
    return domainErr('OPERATION_NOT_GRANTED', `操作 ${operation} 不在调用者操作集内`);
  }
  return domainOk({ allowed: true });
}
