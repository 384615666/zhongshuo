/**
 * R98 调用次数预算（纯策略契约）。
 *
 * 这是“用户是否主动启用调用次数上限”的统一语义，不复用旧的
 * BudgetGrant.maxTurns：旧契约必须永远有正数上限，无法如实表达“关闭但继续计数”。
 *
 * 关键口径：
 * - 默认关闭；关闭是独立 enforcement=disabled，不得用巨大整数冒充。
 * - 无论开关如何，真实调用都进入 CallBudgetState 计数。
 * - 开启后按请求模式取默认上限，或使用本次请求的显式覆盖；新请求冻结一份
 *   CallBudgetPolicy，不得回写进行中的运行或历史记录。
 * - 交接、修复、整合、继续等入口都应先按自身执行模式解析策略，再复用同一
 *   预留/结算账目；关闭时这些入口同样只计数、不因次数拦截。
 */
import { z } from 'zod';

/** app.settings 中稳定的应用级开关键；值为字符串 true/false，缺省等价于 false。 */
export const CALL_BUDGET_ENABLED_SETTING_KEY = 'callBudget.enabled' as const;

export const CALL_BUDGET_MODES = ['DIRECT', 'AUTO', 'DELIBERATE'] as const;
export type CallBudgetMode = (typeof CALL_BUDGET_MODES)[number];

/**
 * 产品默认上限。显式收件多人任务属于 AUTO，使用 AUTO 的 24 次额度；
 * DELIBERATE 的交接、格式修复、整合、确认与继续入口共用同一份冻结策略。
 */
export const DEFAULT_CALL_BUDGET_LIMITS: Readonly<Record<CallBudgetMode, number>> = Object.freeze({
  DIRECT: 6,
  AUTO: 24,
  DELIBERATE: 17,
});

export interface CallBudgetPolicyInput {
  mode: CallBudgetMode;
  enabled: boolean;
  /** 只在实际启用 enforcement 时生效；不是关闭态的替代上限。 */
  overrideLimit?: number | null;
}

export type CallBudgetPolicy =
  | {
      version: 1;
      mode: CallBudgetMode;
      enforcement: 'disabled';
      counting: 'always';
    }
  | {
      version: 1;
      mode: CallBudgetMode;
      enforcement: 'enabled';
      counting: 'always';
      limit: number;
      limitSource: 'default' | 'override';
    };

const callBudgetModeSchema = z.enum(CALL_BUDGET_MODES);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * 冻结策略的严格序列化结构。disabled 分支根本没有 limit/maxCalls 字段，
 * 从结构上阻止调用方把“关闭”编码为一个大数。
 */
export const callBudgetPolicySchema = z.discriminatedUnion('enforcement', [
  z.strictObject({
    version: z.literal(1),
    mode: callBudgetModeSchema,
    enforcement: z.literal('disabled'),
    counting: z.literal('always'),
  }),
  z.strictObject({
    version: z.literal(1),
    mode: callBudgetModeSchema,
    enforcement: z.literal('enabled'),
    counting: z.literal('always'),
    limit: positiveSafeIntegerSchema,
    limitSource: z.enum(['default', 'override']),
  }),
]);

export type FrozenCallBudgetPolicy = z.infer<typeof callBudgetPolicySchema>;

export function isSupportedCallBudgetLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function assertMode(mode: unknown): asserts mode is CallBudgetMode {
  if (!CALL_BUDGET_MODES.includes(mode as CallBudgetMode)) {
    throw new TypeError(`不支持的调用预算模式：${String(mode)}`);
  }
}

/**
 * 为新请求创建冻结前的策略。关闭态完全丢弃 overrideLimit，避免残留一个看似
 * “以后会自动生效”的隐藏上限。
 */
export function resolveCallBudgetPolicy(input: CallBudgetPolicyInput): CallBudgetPolicy {
  assertMode(input.mode);
  if (!input.enabled) {
    return {
      version: 1,
      mode: input.mode,
      enforcement: 'disabled',
      counting: 'always',
    };
  }

  const hasOverride = input.overrideLimit != null;
  const limit = hasOverride ? input.overrideLimit : DEFAULT_CALL_BUDGET_LIMITS[input.mode];
  if (!isSupportedCallBudgetLimit(limit)) {
    throw new RangeError('调用次数上限必须是大于 0 的安全整数');
  }
  return {
    version: 1,
    mode: input.mode,
    enforcement: 'enabled',
    counting: 'always',
    limit,
    limitSource: hasOverride ? 'override' : 'default',
  };
}

/** 校验并浅冻结一份策略，供本次请求后续共用。 */
export function freezeCallBudgetPolicy(policy: unknown): FrozenCallBudgetPolicy {
  return Object.freeze(callBudgetPolicySchema.parse(policy));
}

export function serializeCallBudgetPolicy(policy: unknown): string {
  return JSON.stringify(freezeCallBudgetPolicy(policy));
}

/**
 * 读取历史/请求中已冻结的策略。损坏或不认识的结构必须抛错，由调用方
 * fail-closed，不能悄悄解析成默认开启或默认关闭。
 */
export function parseFrozenCallBudgetPolicy(value: string | unknown): FrozenCallBudgetPolicy {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return freezeCallBudgetPolicy(parsed);
}

export type CallBudgetEnabledSettingValue = 'true' | 'false';

/** app.settings 缺省/空值均表示默认关闭；非法存储值显式报错而非猜测。 */
export function parseCallBudgetEnabledSetting(value: string | null | undefined): boolean {
  if (value == null || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`调用次数预算开关只接受 true/false，读到：${value}`);
}

export function serializeCallBudgetEnabledSetting(enabled: boolean): CallBudgetEnabledSettingValue {
  return enabled ? 'true' : 'false';
}

/**
 * 真实记账状态。reserve 后立即计入 count（同时位于 inFlight），结算后从
 * inFlight 移入 used；确认未启动则 refund，不污染真实调用次数。
 */
export interface CallBudgetState {
  usedCalls: number;
  inFlightCalls: number;
}

export function createCallBudgetState(initial?: Partial<CallBudgetState>): CallBudgetState {
  const state: CallBudgetState = {
    usedCalls: initial?.usedCalls ?? 0,
    inFlightCalls: initial?.inFlightCalls ?? 0,
  };
  assertCallBudgetState(state);
  return state;
}

function assertCallBudgetState(state: CallBudgetState): void {
  if (!Number.isSafeInteger(state.usedCalls) || state.usedCalls < 0) {
    throw new RangeError('usedCalls 必须是非负安全整数');
  }
  if (!Number.isSafeInteger(state.inFlightCalls) || state.inFlightCalls < 0) {
    throw new RangeError('inFlightCalls 必须是非负安全整数');
  }
}

export function callBudgetCount(state: CallBudgetState): number {
  assertCallBudgetState(state);
  const count = state.usedCalls + state.inFlightCalls;
  if (!Number.isSafeInteger(count)) throw new RangeError('调用计数超出安全整数范围');
  return count;
}

export interface CallBudgetProjection {
  version: 1;
  mode: CallBudgetMode;
  enforcement: 'disabled' | 'enabled';
  counting: 'always';
  count: number;
  usedCalls: number;
  inFlightCalls: number;
  /** 关闭态为 null；不使用 maxCalls 或伪大数。 */
  limit: number | null;
  /** 关闭态为 null；开启态不会小于 0。 */
  remaining: number | null;
}

export function projectCallBudget(policy: CallBudgetPolicy, state: CallBudgetState): CallBudgetProjection {
  const count = callBudgetCount(state);
  if (policy.enforcement === 'disabled') {
    return {
      version: 1,
      mode: policy.mode,
      enforcement: 'disabled',
      counting: 'always',
      count,
      usedCalls: state.usedCalls,
      inFlightCalls: state.inFlightCalls,
      limit: null,
      remaining: null,
    };
  }
  return {
    version: 1,
    mode: policy.mode,
    enforcement: 'enabled',
    counting: 'always',
    count,
    usedCalls: state.usedCalls,
    inFlightCalls: state.inFlightCalls,
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - count),
  };
}

export type CallBudgetReservation =
  | { allowed: true; state: CallBudgetState }
  | { allowed: false; code: 'CALL_BUDGET_EXHAUSTED'; state: CallBudgetState };

/**
 * 派发前预留一次调用。关闭态永不拒绝；开启态把在途调用计入占用，避免并发
 * 同时读到相同余额后超发。
 */
export function reserveCall(policy: CallBudgetPolicy, state: CallBudgetState): CallBudgetReservation {
  const projection = projectCallBudget(policy, state);
  if (projection.enforcement === 'enabled' && projection.remaining === 0) {
    return { allowed: false, code: 'CALL_BUDGET_EXHAUSTED', state: { ...state } };
  }
  return {
    allowed: true,
    state: { usedCalls: state.usedCalls, inFlightCalls: state.inFlightCalls + 1 },
  };
}

/** 实际调用结算：无论成功或失败，都从在途移入真实 used 计数。 */
export function settleCall(state: CallBudgetState): CallBudgetState {
  assertCallBudgetState(state);
  if (state.inFlightCalls < 1) throw new RangeError('没有可结算的在途调用');
  return {
    usedCalls: state.usedCalls + 1,
    inFlightCalls: state.inFlightCalls - 1,
  };
}

/** 确认调用从未启动时归还预留；不改变 usedCalls。 */
export function refundCallReservation(state: CallBudgetState): CallBudgetState {
  assertCallBudgetState(state);
  if (state.inFlightCalls < 1) throw new RangeError('没有可归还的在途调用');
  return {
    usedCalls: state.usedCalls,
    inFlightCalls: state.inFlightCalls - 1,
  };
}
