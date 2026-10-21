/**
 * 预算契约（§10.4 + 开工契约 §3.1 第四维）。
 * DEV-01 定义类型与纯校验；事务预占/结算由 DEV-02/05 承担。
 * 预算是调用额度，不代表模型可以自行派工；读取权限不附带任何模型调用额度。
 */
import { z } from 'zod';
import type { FrozenCallBudgetPolicy } from './callBudget.ts';

/**
 * 预算授权：task=任务/运行预算（所有入口共用）；connection_chain=发起连接工作链预算
 * （跨任务、连接生命周期内累计，无时间窗口；耗尽不为连接自动追加额度，§31.5）。
 */
export interface BudgetGrant {
  id: string;
  ownerKind: 'task' | 'connection_chain';
  ownerId: string;
  /** 调用次数上限（maxAgentTurns 口径；费用无 runtime 硬限时只能是软控制）。 */
  maxTurns: number;
}

export const budgetGrantSchema = z.strictObject({
  id: z.string().min(1),
  ownerKind: z.enum(['task', 'connection_chain']),
  ownerId: z.string().min(1),
  maxTurns: z.number().int().positive(),
});

/** 预算占用账本快照（§10.4 尾部账目公式的基础量）。 */
export interface BudgetState {
  grantId: string;
  /** M=runMaxTurns / grant.maxTurns。 */
  maxTurns: number;
  /** U=usedTurns：已结算调用。 */
  usedTurns: number;
  /** I=inFlightReservedTurns：已预占未结算。 */
  inFlightReservedTurns: number;
  /**
   * R98 request-frozen call-count policy. Missing means a legacy run whose
   * historical finite budget semantics must be preserved. New requests always
   * carry an explicit policy, including enforcement=disabled ("count only").
   */
  callBudget?: FrozenCallBudgetPolicy;
}

export const budgetStateSchema = z.strictObject({
  grantId: z.string().min(1),
  maxTurns: z.number().int().positive(),
  usedTurns: z.number().int().nonnegative(),
  inFlightReservedTurns: z.number().int().nonnegative(),
});

/** 预占记录：派发前在事务内预留调用配额；并发 worker 不能分别读取余额后同时超发。 */
export interface BudgetReservation {
  grantId: string;
  turns: number;
  purpose?: string;
}
