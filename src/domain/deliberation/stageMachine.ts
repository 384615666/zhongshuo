/**
 * DELIBERATE 阶段机（§6.1/§6.5；纯逻辑，不触库）。
 * 阶段屏障只认程序侧事实（成员产物/缺席状态），不解析自然语言；
 * 主持者不能单方面把他人反对标成同意——聚合只认 ratification_records（§6.5）。
 */
import type { ClaimConsensus, ClaimRatificationSummary, FrozenRoster, ParticipantStatus } from '../../contracts/deliberation.ts';
import { CLAIM_CONSENSUS_PRIORITY } from '../../contracts/deliberation.ts';
import type { DeliberateStage } from '../../contracts/run.ts';

export interface ParticipantFacts {
  memberId: string;
  status: ParticipantStatus;
  /** 该成员在当前阶段是否已有有效产物（初稿/互评/立场/确认）。 */
  hasStageOutput: boolean;
}

export type StageAdvanceDecision =
  | { decision: 'advance'; next: DeliberateStage; reason: string }
  | { decision: 'wait'; reason: string }
  | { decision: 'blocked'; reason: string };

/** 参与者是否已对该阶段屏障终结（完成/缺席/失败——E4：缺席不默认当作已完成）。 */
function terminatedForBarrier(p: ParticipantFacts): boolean {
  return p.status === 'completed' || p.status === 'absent' || p.status === 'failed' || (p.status === 'late' && !p.hasStageOutput);
}

/**
 * INDEPENDENT 屏障（§6.1）：所有预期成员完成，或未完成席位已按缺席/失败/撤出规则终结；
 * 全员无有效输入 → BLOCKED。
 */
export function decideIndependentBarrier(roster: FrozenRoster, participants: ReadonlyArray<ParticipantFacts>): StageAdvanceDecision {
  const expected = roster.members.filter((m) => m.expected);
  if (expected.length === 0) return { decision: 'blocked', reason: '冻结名单为空' };
  const facts = expected.map((m) => participants.find((p) => p.memberId === m.memberId) ?? { memberId: m.memberId, status: 'pending' as const, hasStageOutput: false });
  const withOutput = facts.filter((p) => p.hasStageOutput);
  if (withOutput.length === 0) {
    const allTerminated = facts.every(terminatedForBarrier);
    if (allTerminated) return { decision: 'blocked', reason: '全员无有效输入（§6.1 INDEPENDENT 终结规则）' };
    return { decision: 'wait', reason: `独立初稿 0/${expected.length}，等待或按 E4 缺席推进` };
  }
  const outstanding = facts.filter((p) => !p.hasStageOutput && !terminatedForBarrier(p));
  if (outstanding.length > 0) {
    return { decision: 'wait', reason: `独立初稿 ${withOutput.length}/${expected.length}；未完成：${outstanding.map((p) => p.memberId).join(', ')}` };
  }
  return { decision: 'advance', next: 'CROSS_REVIEW', reason: `独立初稿收齐（${withOutput.length}/${expected.length}，缺席/失败席位已终结）` };
}

/** CROSS_REVIEW 屏障：收齐本阶段预期互评（有初稿者才被期待互评）。 */
export function decideCrossReviewBarrier(roster: FrozenRoster, participants: ReadonlyArray<ParticipantFacts>): StageAdvanceDecision {
  const expectedReviewers = roster.members.filter((m) => m.expected);
  const outstanding = expectedReviewers.filter((m) => {
    const p = participants.find((x) => x.memberId === m.memberId);
    return p != null && !p.hasStageOutput && !terminatedForBarrier(p);
  });
  if (outstanding.length > 0) {
    return { decision: 'wait', reason: `互评未收齐；待：${outstanding.map((m) => m.memberId).join(', ')}` };
  }
  return { decision: 'advance', next: 'ISSUE_DISCUSSION', reason: '互评收齐（或未完成席位已终结）' };
}

// ---------- 争议清单构建（CROSS_REVIEW → ISSUE_DISCUSSION 输入） ----------

export interface ReviewPosition {
  reviewerMemberId: string;
  targetClaimId: string;
  stance: 'agree' | 'disagree' | 'needs_evidence';
}

export interface DerivedIssue {
  /** 派生自被异议的 claim：`iss_{claimId}`（同 claim 的异议合并为一项争议）。 */
  issueId: string;
  targetClaimId: string;
  statement: string;
  status: 'open';
  disagreeMemberIds: string[];
  needsEvidenceMemberIds: string[];
}

/**
 * 由互评立场构建结构化争议清单：只收 disagree/needs_evidence；
 * 全员同意的 claim 不进争议（无争议 → 跳过 ISSUE_DISCUSSION 直入 SYNTHESIS）。
 */
export function deriveIssues(
  claims: ReadonlyArray<{ claimId: string; statement: string }>,
  reviews: ReadonlyArray<ReviewPosition>,
): DerivedIssue[] {
  const issues: DerivedIssue[] = [];
  for (const claim of claims) {
    const disagree = reviews.filter((r) => r.targetClaimId === claim.claimId && r.stance === 'disagree').map((r) => r.reviewerMemberId);
    const needsEvidence = reviews.filter((r) => r.targetClaimId === claim.claimId && r.stance === 'needs_evidence').map((r) => r.reviewerMemberId);
    if (disagree.length === 0 && needsEvidence.length === 0) continue;
    issues.push({
      issueId: `iss_${claim.claimId}`,
      targetClaimId: claim.claimId,
      statement: claim.statement,
      status: 'open',
      disagreeMemberIds: disagree,
      needsEvidenceMemberIds: needsEvidence,
    });
  }
  return issues;
}

/** 有开放争议才进 ISSUE_DISCUSSION；否则直入 SYNTHESIS（§6.1 推进条件）。 */
export function nextAfterCrossReview(issues: ReadonlyArray<DerivedIssue>): { next: 'ISSUE_DISCUSSION' | 'SYNTHESIS'; reason: string } {
  if (issues.length > 0) return { next: 'ISSUE_DISCUSSION', reason: `存在 ${issues.length} 项开放争议` };
  return { next: 'SYNTHESIS', reason: '互评无争议，跳过分歧讨论' };
}

/** 第 3 轮复核检查点可派发条件（§6.1）：host、roundNo=3、该轮意见已收集或明确记缺席。 */
export function checkpointEligible(input: {
  role: 'host' | 'member';
  roundNo: number;
  roundOpinionsCollected: boolean;
  alreadyDispatchedCheckpoint: boolean;
}): boolean {
  return input.role === 'host' && input.roundNo === 3 && input.roundOpinionsCollected && !input.alreadyDispatchedCheckpoint;
}

// ---------- 共识聚合（§6.5） ----------

export interface ClaimRatifyRecord {
  claimId: string;
  memberId: string;
  /** null = pending/missing（未收到答复；关闭屏障后落 missing）。 */
  stance: 'confirm' | 'conditional' | 'object' | 'unconfirmed' | null;
  responseStatus: 'pending' | 'submitted' | 'missing';
}

/**
 * 逐结论聚合：
 * - disputed：任一 object（未解决反对）。
 * - unconfirmed：任一 missing/pending/显式 unconfirmed（缺席不覆盖反对，但覆盖条件性同意）。
 * - qualified：存在 conditional 且无 object/missing。
 * - unanimous：全部显式 confirm。
 * 单一主状态按 disputed → unconfirmed → qualified → unanimous（CLAIM_CONSENSUS_PRIORITY）。
 */
export function aggregateClaimConsensus(
  claimIds: ReadonlyArray<string>,
  expectedMemberIds: ReadonlyArray<string>,
  records: ReadonlyArray<ClaimRatifyRecord>,
): ClaimRatificationSummary[] {
  return claimIds.map((claimId) => {
    let confirms = 0;
    let conditionals = 0;
    let objects = 0;
    let unconfirmedExplicit = 0;
    let missing = 0;
    for (const memberId of expectedMemberIds) {
      const record = records.find((r) => r.claimId === claimId && r.memberId === memberId);
      if (record == null || record.responseStatus !== 'submitted' || record.stance == null) {
        missing += 1;
        continue;
      }
      if (record.stance === 'confirm') confirms += 1;
      else if (record.stance === 'conditional') conditionals += 1;
      else if (record.stance === 'object') objects += 1;
      else unconfirmedExplicit += 1;
    }
    let consensus: ClaimConsensus;
    if (objects > 0) consensus = 'disputed';
    else if (missing > 0 || unconfirmedExplicit > 0) consensus = 'unconfirmed';
    else if (conditionals > 0) consensus = 'qualified';
    else consensus = 'unanimous';
    return { claimId, consensus, confirms, conditionals, objects, unconfirmedExplicit, missing };
  });
}

/** 整体主状态：取各 claim 最严重者（优先级序）。 */
export function overallConsensus(summaries: ReadonlyArray<ClaimRatificationSummary>): ClaimConsensus | null {
  let worst: ClaimConsensus | null = null;
  for (const s of summaries) {
    if (worst == null || CLAIM_CONSENSUS_PRIORITY.indexOf(s.consensus) < CLAIM_CONSENSUS_PRIORITY.indexOf(worst)) {
      worst = s.consensus;
    }
  }
  return worst;
}

// ---------- E4 缺席容忍 ----------

/** 超过容忍窗口（默认 20 分钟，可设置）→ 可按缺席继续；迟到者 roster 标记 late。 */
export function absenceDue(input: { startedAt: number; now: number; absenceToleranceMinutes: number }): boolean {
  return input.now - input.startedAt >= input.absenceToleranceMinutes * 60_000;
}
