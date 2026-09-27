/**
 * DELIBERATE 阶段机单元（§6.1/§6.5）：屏障、争议派生、检查点资格、共识聚合优先级。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateClaimConsensus,
  checkpointEligible,
  decideCrossReviewBarrier,
  decideIndependentBarrier,
  deriveIssues,
  nextAfterCrossReview,
  overallConsensus,
} from '../../src/domain/deliberation/stageMachine.ts';
import type { FrozenRoster, ParticipantStatus } from '../../src/contracts/deliberation.ts';

const roster = (n: number): FrozenRoster => ({
  revision: 1,
  members: Array.from({ length: n }, (_, i) => ({ memberId: `m${i + 1}`, role: i === 0 ? ('host' as const) : ('member' as const), expected: true })),
});

function facts(entries: Array<[string, ParticipantStatus, boolean]>) {
  return entries.map(([memberId, status, hasStageOutput]) => ({ memberId, status, hasStageOutput }));
}

describe('INDEPENDENT 屏障（§6.1/E4）', () => {
  it('未收齐 → wait；收齐 → advance；缺席席位终结后部分成果可推进', () => {
    expect(decideIndependentBarrier(roster(3), facts([['m1', 'completed', true], ['m2', 'pending', false], ['m3', 'completed', true]])).decision).toBe('wait');
    const advance = decideIndependentBarrier(roster(3), facts([['m1', 'completed', true], ['m2', 'absent', false], ['m3', 'completed', true]]));
    expect(advance).toMatchObject({ decision: 'advance', next: 'CROSS_REVIEW' });
  });

  it('全员无有效输入且全部终结 → blocked；仍有 pending → wait（不默认缺席者已完成）', () => {
    expect(decideIndependentBarrier(roster(2), facts([['m1', 'failed', false], ['m2', 'absent', false]])).decision).toBe('blocked');
    expect(decideIndependentBarrier(roster(2), facts([['m1', 'failed', false], ['m2', 'pending', false]])).decision).toBe('wait');
  });
});

describe('CROSS_REVIEW 屏障与争议派生', () => {
  it('互评未收齐 wait；收齐 advance', () => {
    expect(decideCrossReviewBarrier(roster(2), facts([['m1', 'completed', true], ['m2', 'pending', false]])).decision).toBe('wait');
    expect(decideCrossReviewBarrier(roster(2), facts([['m1', 'completed', true], ['m2', 'completed', true]])).decision).toBe('advance');
  });

  it('disagree/needs_evidence 派生争议（同 claim 合并）；无争议直入 SYNTHESIS', () => {
    const issues = deriveIssues(
      [
        { claimId: 'c1', statement: '结论一' },
        { claimId: 'c2', statement: '结论二' },
      ],
      [
        { reviewerMemberId: 'm1', targetClaimId: 'c1', stance: 'agree' },
        { reviewerMemberId: 'm2', targetClaimId: 'c1', stance: 'disagree' },
        { reviewerMemberId: 'm3', targetClaimId: 'c1', stance: 'needs_evidence' },
        { reviewerMemberId: 'm1', targetClaimId: 'c2', stance: 'agree' },
        { reviewerMemberId: 'm2', targetClaimId: 'c2', stance: 'agree' },
      ],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ issueId: 'iss_c1', disagreeMemberIds: ['m2'], needsEvidenceMemberIds: ['m3'] });
    expect(nextAfterCrossReview(issues).next).toBe('ISSUE_DISCUSSION');
    expect(nextAfterCrossReview([]).next).toBe('SYNTHESIS');
  });
});

describe('第 3 轮检查点资格（§6.1）', () => {
  it('仅 host、roundNo=3、意见已收集、未派发过', () => {
    const base = { roundOpinionsCollected: true, alreadyDispatchedCheckpoint: false };
    expect(checkpointEligible({ role: 'host', roundNo: 3, ...base })).toBe(true);
    expect(checkpointEligible({ role: 'member', roundNo: 3, ...base })).toBe(false);
    expect(checkpointEligible({ role: 'host', roundNo: 2, ...base })).toBe(false);
    expect(checkpointEligible({ role: 'host', roundNo: 3, roundOpinionsCollected: false, alreadyDispatchedCheckpoint: false })).toBe(false);
    expect(checkpointEligible({ role: 'host', roundNo: 3, roundOpinionsCollected: true, alreadyDispatchedCheckpoint: true })).toBe(false);
  });
});

describe('共识聚合（§6.5 优先级：disputed → unconfirmed → qualified → unanimous）', () => {
  const claims = ['clm_1', 'clm_2'];
  const members = ['m1', 'm2', 'm3'];
  const rec = (claimId: string, memberId: string, stance: 'confirm' | 'conditional' | 'object' | 'unconfirmed' | null, responseStatus: 'pending' | 'submitted' | 'missing' = 'submitted') =>
    ({ claimId, memberId, stance, responseStatus });

  it('全员 confirm → unanimous', () => {
    const s = aggregateClaimConsensus(['clm_1'], members, [rec('clm_1', 'm1', 'confirm'), rec('clm_1', 'm2', 'confirm'), rec('clm_1', 'm3', 'confirm')]);
    expect(s[0]).toMatchObject({ consensus: 'unanimous', confirms: 3, missing: 0 });
  });

  it('存在 conditional → qualified（条件保留）', () => {
    const s = aggregateClaimConsensus(['clm_1'], members, [rec('clm_1', 'm1', 'confirm'), rec('clm_1', 'm2', 'conditional'), rec('clm_1', 'm3', 'confirm')]);
    expect(s[0]).toMatchObject({ consensus: 'qualified', conditionals: 1 });
  });

  it('任一 object → disputed；缺席（missing）不覆盖反对', () => {
    const s = aggregateClaimConsensus(['clm_1'], members, [rec('clm_1', 'm1', 'object'), rec('clm_1', 'm2', 'confirm'), rec('clm_1', 'm3', null, 'missing')]);
    expect(s[0]).toMatchObject({ consensus: 'disputed', objects: 1, missing: 1 });
  });

  it('缺失/显式 unconfirmed → unconfirmed；条件性同意不覆盖缺失', () => {
    const a = aggregateClaimConsensus(['clm_1'], members, [rec('clm_1', 'm1', 'conditional'), rec('clm_1', 'm2', 'confirm'), rec('clm_1', 'm3', null, 'missing')]);
    expect(a[0]!.consensus).toBe('unconfirmed');
    const b = aggregateClaimConsensus(['clm_1'], members, [rec('clm_1', 'm1', 'confirm'), rec('clm_1', 'm2', 'unconfirmed'), rec('clm_1', 'm3', 'confirm')]);
    expect(b[0]!.consensus).toBe('unconfirmed');
  });

  it('整体主状态取最严重者', () => {
    const s = aggregateClaimConsensus(claims, members, [
      rec('clm_1', 'm1', 'confirm'), rec('clm_1', 'm2', 'confirm'), rec('clm_1', 'm3', 'confirm'),
      rec('clm_2', 'm1', 'object'), rec('clm_2', 'm2', 'confirm'), rec('clm_2', 'm3', 'confirm'),
    ]);
    expect(overallConsensus(s)).toBe('disputed');
  });
});
