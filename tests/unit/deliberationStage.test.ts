/**
 * DELIBERATE 阶段机单元（§6.1/§6.5 + M1 修复轮）：
 * 屏障（缺失事实不跳过/冻结参与集合/去重）、三元组引用与 run 范围 issueId、
 * 检查点资格、共识聚合优先级。
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateClaimConsensus,
  checkpointEligible,
  decideCrossReviewBarrier,
  decideIndependentBarrier,
  deriveIssues,
  issueIdFor,
  nextAfterCrossReview,
  overallConsensus,
  validateClaimReferences,
} from '../../src/domain/deliberation/stageMachine.ts';
import type { FrozenRoster, ParticipantStatus } from '../../src/contracts/deliberation.ts';

const roster = (n: number): FrozenRoster => ({
  revision: 1,
  members: Array.from({ length: n }, (_, i) => ({ memberId: `m${i + 1}`, role: i === 0 ? ('host' as const) : ('member' as const), expected: true })),
});

function facts(entries: Array<[string, ParticipantStatus, boolean]>) {
  return entries.map(([memberId, status, hasStageOutput]) => ({ memberId, status, hasStageOutput }));
}

describe('INDEPENDENT 屏障（§6.1/E4；修复轮：缺失事实=未完成）', () => {
  it('未收齐 → wait；收齐 → advance；缺席席位终结后部分成果可推进', () => {
    expect(decideIndependentBarrier(roster(3), facts([['m1', 'completed', true], ['m2', 'pending', false], ['m3', 'completed', true]])).decision).toBe('wait');
    const advance = decideIndependentBarrier(roster(3), facts([['m1', 'completed', true], ['m2', 'absent', false], ['m3', 'completed', true]]));
    expect(advance).toMatchObject({ decision: 'advance', next: 'CROSS_REVIEW' });
  });

  it('全员无有效输入且全部终结 → blocked；仍有 pending → wait（不默认缺席者已完成）', () => {
    expect(decideIndependentBarrier(roster(2), facts([['m1', 'failed', false], ['m2', 'absent', false]])).decision).toBe('blocked');
    expect(decideIndependentBarrier(roster(2), facts([['m1', 'failed', false], ['m2', 'pending', false]])).decision).toBe('wait');
  });

  it('修复轮：空 participants / 少一个成员 → wait（不能靠过滤凑收齐）', () => {
    expect(decideIndependentBarrier(roster(3), []).decision).toBe('wait');
    const missingOne = decideIndependentBarrier(roster(3), facts([['m1', 'completed', true], ['m3', 'completed', true]]));
    expect(missingOne.decision).toBe('wait');
    expect(missingOne).toMatchObject({ reason: expect.stringContaining('m2') });
  });

  it('修复轮：重复成员事实按最后一次出现去重（确定性）', () => {
    const dup = decideIndependentBarrier(roster(2), facts([['m1', 'pending', false], ['m1', 'completed', true], ['m2', 'completed', true]]));
    expect(dup.decision).toBe('advance');
  });
});

describe('CROSS_REVIEW 屏障（修复轮：冻结参与集合 + 缺失事实不跳过）', () => {
  const base = { roster: roster(3), expectedReviewerIds: ['m1', 'm2'] };

  it('空 participants → wait（不是 advance）', () => {
    expect(decideCrossReviewBarrier({ ...base, participants: [] }).decision).toBe('wait');
  });

  it('少一个成员的事实 → wait 并点名缺失成员', () => {
    const r = decideCrossReviewBarrier({ ...base, participants: facts([['m1', 'completed', true]]) });
    expect(r.decision).toBe('wait');
    expect(r).toMatchObject({ reason: expect.stringContaining('m2') });
  });

  it('部分完成 → wait；明确缺席 → 其席位终结可推进；全员无输入 → blocked', () => {
    expect(decideCrossReviewBarrier({ ...base, participants: facts([['m1', 'completed', true], ['m2', 'pending', false]]) }).decision).toBe('wait');
    expect(decideCrossReviewBarrier({ ...base, participants: facts([['m1', 'completed', true], ['m2', 'absent', false]]) }).decision).toBe('advance');
    expect(decideCrossReviewBarrier({ ...base, participants: facts([['m1', 'failed', false], ['m2', 'absent', false]]) }).decision).toBe('blocked');
  });

  it('集合外成员（名单内但无初稿）不参与互评；预期集合为空 → blocked', () => {
    const only3 = decideCrossReviewBarrier({ roster: roster(3), expectedReviewerIds: ['m3'], participants: facts([['m3', 'completed', true], ['m2', 'completed', true]]) });
    expect(only3.decision).toBe('advance'); // m2 的事实不影响 m3 单人集合的屏障
    expect(decideCrossReviewBarrier({ roster: roster(3), expectedReviewerIds: [], participants: [] }).decision).toBe('blocked');
  });

  it('重复成员事实去重：最后一条 completed 生效', () => {
    const r = decideCrossReviewBarrier({ ...base, participants: facts([['m1', 'pending', false], ['m1', 'completed', true], ['m2', 'completed', true]]) });
    expect(r.decision).toBe('advance');
  });
});

describe('成果引用三元组与争议身份（修复轮）', () => {
  const frozen = [
    { artifactId: 'art_a', artifactRevision: 1, claimId: 'c1', statement: '甲的结论' },
    { artifactId: 'art_b', artifactRevision: 1, claimId: 'c1', statement: '乙的结论（同名 claim）' },
    { artifactId: 'art_a', artifactRevision: 2, claimId: 'c1', statement: '甲的结论（修订版）' },
  ];

  it('两位成员都输出 c1：不同 artifactId 不混并，各自成争议', () => {
    const issues = deriveIssues('run_x', frozen, [
      { reviewerMemberId: 'm2', target: { artifactId: 'art_a', artifactRevision: 1, claimId: 'c1' }, stance: 'disagree' },
      { reviewerMemberId: 'm1', target: { artifactId: 'art_b', artifactRevision: 1, claimId: 'c1' }, stance: 'needs_evidence' },
    ]);
    expect(issues).toHaveLength(2);
    expect(new Set(issues.map((i) => i.issueId)).size).toBe(2);
    expect(issues.find((i) => i.target.artifactId === 'art_a')).toMatchObject({ disagreeMemberIds: ['m2'] });
    expect(issues.find((i) => i.target.artifactId === 'art_b')).toMatchObject({ needsEvidenceMemberIds: ['m1'] });
  });

  it('同一成果两个 revision：旧版本引用不合并进新版本', () => {
    const issues = deriveIssues('run_x', frozen, [
      { reviewerMemberId: 'm2', target: { artifactId: 'art_a', artifactRevision: 2, claimId: 'c1' }, stance: 'disagree' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.target.artifactRevision).toBe(2);
  });

  it('两个 run 各有同名 claim：issueId 不同（run 范围唯一）', () => {
    const a = issueIdFor('run_1', { artifactId: 'art_a', artifactRevision: 1, claimId: 'c1' });
    const b = issueIdFor('run_2', { artifactId: 'art_a', artifactRevision: 1, claimId: 'c1' });
    expect(a).not.toBe(b);
    expect(a.startsWith('iss_')).toBe(true);
  });

  it('引用不存在或未获准版本 → validateClaimReferences 拒绝并指出违规项', () => {
    const bad = validateClaimReferences(frozen, [
      { reviewerMemberId: 'm1', target: { artifactId: 'art_a', artifactRevision: 9, claimId: 'c1' }, stance: 'agree' },
    ]);
    expect(bad.ok).toBe(false);
    expect((bad as { error: { code: string } }).error.code).toBe('CLAIM_NOT_FOUND');
    const ok = validateClaimReferences(frozen, [
      { reviewerMemberId: 'm1', target: { artifactId: 'art_a', artifactRevision: 1, claimId: 'c1' }, stance: 'agree' },
      { reviewerMemberId: 'm1', target: { artifactId: 'art_b', artifactRevision: 1, claimId: 'c1' }, stance: 'disagree' },
    ]);
    expect(ok.ok).toBe(true);
  });

  it('无争议直入 SYNTHESIS；有争议进 ISSUE_DISCUSSION', () => {
    expect(nextAfterCrossReview([]).next).toBe('SYNTHESIS');
    const issues = deriveIssues('run_x', frozen, [
      { reviewerMemberId: 'm2', target: { artifactId: 'art_a', artifactRevision: 1, claimId: 'c1' }, stance: 'disagree' },
    ]);
    expect(nextAfterCrossReview(issues).next).toBe('ISSUE_DISCUSSION');
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

  it('缺失/显式 unconfirmed → unconfirmed；条件性同意不覆盖缺失；程序 missing 与显式 unconfirmed 分开计数', () => {
    const a = aggregateClaimConsensus(['clm_1'], members, [rec('clm_1', 'm1', 'conditional'), rec('clm_1', 'm2', 'confirm'), rec('clm_1', 'm3', null, 'missing')]);
    expect(a[0]).toMatchObject({ consensus: 'unconfirmed', unconfirmedExplicit: 0, missing: 1 });
    const b = aggregateClaimConsensus(['clm_1'], members, [rec('clm_1', 'm1', 'confirm'), rec('clm_1', 'm2', 'unconfirmed'), rec('clm_1', 'm3', 'confirm')]);
    expect(b[0]).toMatchObject({ consensus: 'unconfirmed', unconfirmedExplicit: 1, missing: 0 });
  });

  it('整体主状态取最严重者', () => {
    const s = aggregateClaimConsensus(claims, members, [
      rec('clm_1', 'm1', 'confirm'), rec('clm_1', 'm2', 'confirm'), rec('clm_1', 'm3', 'confirm'),
      rec('clm_2', 'm1', 'object'), rec('clm_2', 'm2', 'confirm'), rec('clm_2', 'm3', 'confirm'),
    ]);
    expect(overallConsensus(s)).toBe('disputed');
  });
});
