import { describe, expect, it } from 'vitest';
import {
  canReserveTurns,
  remainingTurns,
  releaseReservation,
  reserveForDispatch,
  reserveTurns,
  settleTurns,
} from '../../src/domain/budget.ts';

const S = { grantId: 'g', maxTurns: 6, usedTurns: 2, inFlightReservedTurns: 1 };

describe('预算纯校验（§10.4：R=M-U-I）', () => {
  it('remaining = max - used - inFlight', () => {
    expect(remainingTurns(S)).toBe(3);
  });

  it('预占不足 → BUDGET_EXHAUSTED，不产生部分预占', () => {
    const r = reserveTurns(S, 4);
    expect(r).toMatchObject({ ok: false, error: { code: 'BUDGET_EXHAUSTED' } });
  });

  it('预占成功后剩余相应减少', () => {
    const r = reserveTurns(S, 2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(remainingTurns(r.value)).toBe(1);
      expect(canReserveTurns(r.value, 2)).toBe(false);
    }
  });

  it('结算：I 减、U 加，R 不重复扣减', () => {
    const settled = settleTurns(S, 1);
    expect(settled).toEqual({ grantId: 'g', maxTurns: 6, usedTurns: 3, inFlightReservedTurns: 0 });
    expect(remainingTurns(settled)).toBe(3);
  });

  it('归还仅对未启动取消生效', () => {
    const released = releaseReservation(S, 1);
    expect(released.inFlightReservedTurns).toBe(0);
    expect(released.usedTurns).toBe(2);
  });

  it('任务预算与连接链预算同时检查：任一不足即拒绝', () => {
    const ok = reserveForDispatch({ taskBudget: S, connectionChainBudget: S });
    expect(ok.ok).toBe(true);
    const exhausted = { grantId: 'g2', maxTurns: 6, usedTurns: 6, inFlightReservedTurns: 0 };
    const bad = reserveForDispatch({ taskBudget: S, connectionChainBudget: exhausted });
    expect(bad).toMatchObject({ ok: false, error: { code: 'BUDGET_EXHAUSTED' } });
  });

  it('无连接链预算（本地 UI 根任务）只检查任务预算', () => {
    const r = reserveForDispatch({ taskBudget: S, connectionChainBudget: null });
    expect(r.ok).toBe(true);
  });
});
