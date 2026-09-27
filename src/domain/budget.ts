/**
 * 预算纯校验（§10.4：派发前在事务内预留调用配额的纯逻辑部分）。
 * R=M-U-I；检查与占用必须同事务（DEV-02/05 承载）；
 * 明确未启动的取消才归还保留额，恢复/超时不盲目退款。
 */
import type { BudgetState } from '../contracts/budget.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';

export function remainingTurns(state: BudgetState): number {
  return state.maxTurns - state.usedTurns - state.inFlightReservedTurns;
}

export function canReserveTurns(state: BudgetState, turns: number): boolean {
  return remainingTurns(state) >= turns;
}

/** 预占：失败返回 BUDGET_EXHAUSTED，不产生部分预占。 */
export function reserveTurns(
  state: BudgetState,
  turns: number,
): DomainResult<BudgetState> {
  if (!canReserveTurns(state, turns)) {
    return domainErr('BUDGET_EXHAUSTED', '剩余调用配额不足', {
      retryable: false,
      details: { remaining: remainingTurns(state), requested: turns },
    });
  }
  return domainOk({ ...state, inFlightReservedTurns: state.inFlightReservedTurns + turns });
}

/** 结算：I 减 1、U 加 1，R 不重复扣减（§10.4）。 */
export function settleTurns(state: BudgetState, turns: number): BudgetState {
  return {
    ...state,
    inFlightReservedTurns: Math.max(0, state.inFlightReservedTurns - turns),
    usedTurns: state.usedTurns + turns,
  };
}

/** 归还：仅明确未启动的取消按原分配归还保留额。 */
export function releaseReservation(state: BudgetState, turns: number): BudgetState {
  return { ...state, inFlightReservedTurns: Math.max(0, state.inFlightReservedTurns - turns) };
}

/**
 * 派发前同时检查任务预算与发起连接工作链预算（开工契约 §3.1 第四维）：
 * 两者都通过才允许；任一失败即拒绝，不产生部分预占。
 */
export function reserveForDispatch(budgets: {
  taskBudget?: BudgetState | null;
  connectionChainBudget?: BudgetState | null;
}): DomainResult<{ taskBudget?: BudgetState; connectionChainBudget?: BudgetState }> {
  let taskBudget: BudgetState | undefined;
  let chainBudget: BudgetState | undefined;
  if (budgets.taskBudget != null) {
    const r = reserveTurns(budgets.taskBudget, 1);
    if (!r.ok) return r;
    taskBudget = r.value;
  }
  if (budgets.connectionChainBudget != null) {
    const r = reserveTurns(budgets.connectionChainBudget, 1);
    if (!r.ok) return r;
    chainBudget = r.value;
  }
  return domainOk({ taskBudget, connectionChainBudget: chainBudget });
}
