import { describe, expect, it } from 'vitest';
import {
  CALL_BUDGET_ENABLED_SETTING_KEY,
  DEFAULT_CALL_BUDGET_LIMITS,
  callBudgetCount,
  createCallBudgetState,
  parseCallBudgetEnabledSetting,
  parseFrozenCallBudgetPolicy,
  projectCallBudget,
  refundCallReservation,
  reserveCall,
  resolveCallBudgetPolicy,
  serializeCallBudgetEnabledSetting,
  serializeCallBudgetPolicy,
  settleCall,
} from '../../src/contracts/callBudget.ts';

describe('R98 调用预算策略', () => {
  it('默认关闭是独立 disabled 分支，不携带 limit/maxCalls 伪值', () => {
    expect(CALL_BUDGET_ENABLED_SETTING_KEY).toBe('callBudget.enabled');
    for (const mode of ['DIRECT', 'AUTO', 'DELIBERATE'] as const) {
      const policy = resolveCallBudgetPolicy({ mode, enabled: false, overrideLimit: 999_999 });
      expect(policy).toEqual({
        version: 1,
        mode,
        enforcement: 'disabled',
        counting: 'always',
      });
      expect('limit' in policy).toBe(false);
      expect('maxCalls' in policy).toBe(false);
    }
  });

  it('开启后按 DIRECT/AUTO/DELIBERATE 使用 6/24/17 默认值', () => {
    expect(DEFAULT_CALL_BUDGET_LIMITS).toEqual({ DIRECT: 6, AUTO: 24, DELIBERATE: 17 });
    for (const mode of ['DIRECT', 'AUTO', 'DELIBERATE'] as const) {
      expect(resolveCallBudgetPolicy({ mode, enabled: true })).toEqual({
        version: 1,
        mode,
        enforcement: 'enabled',
        counting: 'always',
        limit: DEFAULT_CALL_BUDGET_LIMITS[mode],
        limitSource: 'default',
      });
    }
  });

  it('显式覆盖只在开启时生效，并可冻结、序列化后原样读回', () => {
    const policy = resolveCallBudgetPolicy({ mode: 'AUTO', enabled: true, overrideLimit: 31 });
    expect(policy).toMatchObject({ enforcement: 'enabled', limit: 31, limitSource: 'override' });
    const serialized = serializeCallBudgetPolicy(policy);
    expect(JSON.parse(serialized)).toEqual(policy);
    expect(parseFrozenCallBudgetPolicy(serialized)).toEqual(policy);
  });

  it('非法上限与未知/损坏的冻结结构 fail-closed', () => {
    for (const overrideLimit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveCallBudgetPolicy({ mode: 'DIRECT', enabled: true, overrideLimit })).toThrow();
    }
    expect(() => parseFrozenCallBudgetPolicy('{"version":1}')).toThrow();
    expect(() => parseFrozenCallBudgetPolicy({
      version: 1,
      mode: 'AUTO',
      enforcement: 'disabled',
      counting: 'always',
      maxCalls: 999_999,
    })).toThrow();
  });

  it('设置值缺省为 false，且只接受明确的 true/false 字符串', () => {
    expect(parseCallBudgetEnabledSetting(null)).toBe(false);
    expect(parseCallBudgetEnabledSetting(undefined)).toBe(false);
    expect(parseCallBudgetEnabledSetting('')).toBe(false);
    expect(parseCallBudgetEnabledSetting('true')).toBe(true);
    expect(parseCallBudgetEnabledSetting('false')).toBe(false);
    expect(serializeCallBudgetEnabledSetting(true)).toBe('true');
    expect(serializeCallBudgetEnabledSetting(false)).toBe('false');
    expect(() => parseCallBudgetEnabledSetting('1')).toThrow();
  });
});

describe('R98 关闭仍计数、开启才拦截', () => {
  it('disabled 在高计数时仍允许调用，limit/remaining 始终为 null', () => {
    const policy = resolveCallBudgetPolicy({ mode: 'DIRECT', enabled: false });
    const state = createCallBudgetState({ usedCalls: 1_000_000, inFlightCalls: 4 });
    expect(callBudgetCount(state)).toBe(1_000_004);
    expect(projectCallBudget(policy, state)).toMatchObject({
      enforcement: 'disabled',
      counting: 'always',
      count: 1_000_004,
      limit: null,
      remaining: null,
    });
    const reserved = reserveCall(policy, state);
    expect(reserved.allowed).toBe(true);
    expect(reserved.state).toEqual({ usedCalls: 1_000_000, inFlightCalls: 5 });
  });

  it('enabled 将在途计入余额，并发预留在同一上限处闭合', () => {
    const policy = resolveCallBudgetPolicy({ mode: 'DIRECT', enabled: true, overrideLimit: 2 });
    const first = reserveCall(policy, createCallBudgetState());
    expect(first.allowed).toBe(true);
    const second = reserveCall(policy, first.state);
    expect(second.allowed).toBe(true);
    expect(projectCallBudget(policy, second.state)).toMatchObject({ count: 2, limit: 2, remaining: 0 });
    const blocked = reserveCall(policy, second.state);
    expect(blocked).toEqual({
      allowed: false,
      code: 'CALL_BUDGET_EXHAUSTED',
      state: { usedCalls: 0, inFlightCalls: 2 },
    });
  });

  it('结算把在途移入真实 used；未启动退款不增加 used', () => {
    const policy = resolveCallBudgetPolicy({ mode: 'DELIBERATE', enabled: true, overrideLimit: 1 });
    const reserved = reserveCall(policy, createCallBudgetState());
    if (!reserved.allowed) throw new Error('expected reservation');
    const settled = settleCall(reserved.state);
    expect(settled).toEqual({ usedCalls: 1, inFlightCalls: 0 });
    expect(reserveCall(policy, settled)).toMatchObject({ allowed: false, code: 'CALL_BUDGET_EXHAUSTED' });

    const reservedAgain = reserveCall(policy, createCallBudgetState());
    if (!reservedAgain.allowed) throw new Error('expected reservation');
    expect(refundCallReservation(reservedAgain.state)).toEqual({ usedCalls: 0, inFlightCalls: 0 });
    expect(reserveCall(policy, createCallBudgetState()).allowed).toBe(true);
  });
});
