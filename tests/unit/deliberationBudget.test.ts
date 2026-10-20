/**
 * DELIBERATE 预算（E12/§10.4 尾部账目公式）单元：推导、预留、占用/结算。
 */
import { describe, expect, it } from 'vitest';
import {
  budgetAccounting,
  deriveDeliberateMaxTurns,
  dispatchBudgetStage,
  initDeliberationBudget,
  occupyTailForDispatch,
  settleTurn,
} from '../../src/contracts/deliberation.ts';

describe('E12 推导公式', () => {
  it('核心 6N+1、含修订 7N+2；C=1 时 6N+1+C / 7N+2+C', () => {
    expect(deriveDeliberateMaxTurns(3)).toEqual({ core: 19, withRevision: 23 });
    expect(deriveDeliberateMaxTurns(3, { expectsCheckpointRound3: true })).toEqual({ core: 20, withRevision: 24 });
    expect(deriveDeliberateMaxTurns(6)).toEqual({ core: 37, withRevision: 44 });
    expect(deriveDeliberateMaxTurns(6, { expectsCheckpointRound3: true })).toEqual({ core: 38, withRevision: 45 });
  });
});

describe('尾部账目（M/U/I、S/Q、R/T/F）', () => {
  it('初始化 S=1、Q=N；前置阶段可用=F；SYNTHESIS/RATIFY 含 ownReserve', () => {
    const st = initDeliberationBudget({ rosterSize: 3, runMaxTurns: 24 });
    const front = budgetAccounting(st, 'front');
    expect(front).toMatchObject({ remainingTurns: 24, tailReserved: 4, nonTailAvailable: 20, stageAvailableTurns: 20 });
    expect(budgetAccounting(st, 'SYNTHESIS').stageAvailableTurns).toBe(21);
    expect(budgetAccounting(st, 'RATIFY').stageAvailableTurns).toBe(23);
  });

  it('占用尾部调用：S/Q 减 1、I 加 1；结算 U 加 1、I 减 1、R 不重复扣减', () => {
    let st = initDeliberationBudget({ rosterSize: 3, runMaxTurns: 24 });
    st = occupyTailForDispatch(st, 'SYNTHESIS');
    expect(st.inFlightReservedTurns).toBe(1);
    expect(st.tailReservationByStage.SYNTHESIS).toBe(0);
    expect(st.tailReservationByStage.RATIFY).toBe(3);
    expect(budgetAccounting(st, 'front').remainingTurns).toBe(23); // R=M-U-I=24-0-1
    st = settleTurn(st);
    expect(st.usedTurns).toBe(1);
    expect(st.inFlightReservedTurns).toBe(0);
    expect(budgetAccounting(st, 'front').remainingTurns).toBe(23); // 结算后 R 仍 23（不重复扣）
  });

  it('耗尽前置后：尾部仍保住 1+N（AT-05 兜底）；F=0 时前置/checkpoint 不可派发', () => {
    let st = initDeliberationBudget({ rosterSize: 3, runMaxTurns: 24 });
    // 前置消耗到只剩尾部 4（U=20, I=0）。
    for (let i = 0; i < 20; i += 1) st = settleTurn({ ...st, inFlightReservedTurns: st.inFlightReservedTurns + 1 });
    const front = budgetAccounting(st, 'front');
    expect(front.remainingTurns).toBe(4);
    expect(front.nonTailAvailable).toBe(0);
    expect(front.stageAvailableTurns).toBe(0); // 前置/checkpoint 无预留可用
    expect(budgetAccounting(st, 'SYNTHESIS').stageAvailableTurns).toBe(1);
    expect(budgetAccounting(st, 'RATIFY').stageAvailableTurns).toBe(3);
  });

  it('format repair always uses F; it never borrows an unfilled RAT reserve', () => {
    const st = initDeliberationBudget({ rosterSize: 3, runMaxTurns: 4 }); // R=4, T=1+3, F=0
    expect(budgetAccounting(st, 'front').stageAvailableTurns).toBe(0);
    expect(dispatchBudgetStage('RATIFY', true)).toBe('front');
    expect(dispatchBudgetStage('RATIFY', false)).toBe('RATIFY');
    expect(budgetAccounting(st, dispatchBudgetStage('RATIFY', false)).stageAvailableTurns).toBe(3);
  });
});
