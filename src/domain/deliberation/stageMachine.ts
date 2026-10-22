/**
 * DELIBERATE 阶段机（§6.1/§6.5；纯逻辑，不触库）。
 * 阶段屏障只认程序侧事实（成员产物/缺席状态），不解析自然语言；
 * 主持者不能单方面把他人反对标成同意——聚合只认 ratification_records（§6.5）。
 *
 * 修复轮（M1 第二批）：
 * - 屏障以**程序冻结的阶段参与集合**为准：名单成员缺事实记录=未完成，不能靠
 *   “过滤掉未传入的成员”凑收齐；重复成员事实按最后一次出现去重（确定性）。
 * - 争议/互评引用绑定 (artifactId, artifactRevision, claimId) 三元组并校验其
 *   属于冻结可读版本；issueId 为运行范围唯一身份（含 runId 的稳定散列），
 *   不得用局部 claimId 冒充跨运行全局键。
 */
import { createHash } from 'node:crypto';
import type { ClaimConsensus, ClaimRatificationSummary, ParticipantStatus } from '../../contracts/deliberation.ts';
import type { FrozenRoster } from '../../contracts/deliberation.ts';

export type { FrozenRoster, ParticipantStatus, ClaimConsensus, ClaimRatificationSummary };
import { CLAIM_CONSENSUS_PRIORITY } from '../../contracts/deliberation.ts';
import type { DeliberateStage } from '../../contracts/run.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

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
  // 'completed' 指上一阶段产出（本阶段未产出时不是终结——否则上一阶段完成会绕过
  // 本阶段屏障）；缺席/失败/unavailable 是跨阶段终结（runner §收口轮四合同：排队截止
  // unavailable「屏障视同缺席终结」——第十七轮二补齐此处遗漏，否则停用/排队截止席位
  // 会让屏障永远等待）；late 无本阶段产出按缺席口径（E4）。
  return p.status === 'absent' || p.status === 'failed' || p.status === 'unavailable' || (p.status === 'late' && !p.hasStageOutput);
}

/** 重复成员事实去重：按最后一次出现（确定性；调用方按时间序追加）。 */
export function dedupeFacts(participants: ReadonlyArray<ParticipantFacts>): ParticipantFacts[] {
  const byId = new Map<string, ParticipantFacts>();
  for (const p of participants) byId.set(p.memberId, p);
  return [...byId.values()];
}

function factsFor(expected: ReadonlyArray<{ memberId: string }>, participants: ReadonlyArray<ParticipantFacts>): ParticipantFacts[] {
  const byId = new Map(dedupeFacts(participants).map((p) => [p.memberId, p]));
  return expected.map((m) => byId.get(m.memberId) ?? { memberId: m.memberId, status: 'pending' as const, hasStageOutput: false });
}

/**
 * INDEPENDENT 屏障（§6.1）：所有预期成员完成，或未完成席位已按缺席/失败/撤出规则终结；
 * 全员无有效输入 → BLOCKED。名单成员缺事实记录 = pending（未完成），不跳过。
 */
export function decideIndependentBarrier(roster: FrozenRoster, participants: ReadonlyArray<ParticipantFacts>): StageAdvanceDecision {
  const expected = roster.members.filter((m) => m.expected);
  if (expected.length === 0) return { decision: 'blocked', reason: '冻结名单为空' };
  const facts = factsFor(expected, participants);
  const withOutput = facts.filter((p) => p.hasStageOutput);
  if (withOutput.length === 0) {
    if (facts.every(terminatedForBarrier)) {
      return { decision: 'blocked', reason: '全员无有效输入（§6.1 INDEPENDENT 终结规则；不合成虚构研讨报告）' };
    }
    return { decision: 'wait', reason: `独立初稿 0/${expected.length}，等待或按 E4 缺席推进` };
  }
  const outstanding = facts.filter((p) => !p.hasStageOutput && !terminatedForBarrier(p));
  if (outstanding.length > 0) {
    return { decision: 'wait', reason: `独立初稿 ${withOutput.length}/${expected.length}；未完成：${outstanding.map((p) => p.memberId).join(', ')}` };
  }
  return { decision: 'advance', next: 'CROSS_REVIEW', reason: `独立初稿收齐（${withOutput.length}/${expected.length}，缺席/失败席位已终结）` };
}

/**
 * CROSS_REVIEW 屏障（修复轮）：预期参与者由**程序冻结**（= INDEPENDENT 产出有效初稿的
 * 成员集合，编排层在进入阶段时固化）。集合外的成员（名单内但无有效初稿者）不参与
 * 互评，也不因“没传事实”被跳过；预期集合为空 = 无可评审 → blocked。
 */
export function decideCrossReviewBarrier(input: {
  roster: FrozenRoster;
  /** 程序冻结的互评预期参与集合（进入 CROSS_REVIEW 时确定，不再随迟到成果变化）。 */
  expectedReviewerIds: ReadonlyArray<string>;
  participants: ReadonlyArray<ParticipantFacts>;
}): StageAdvanceDecision {
  const expected = [...new Set(input.expectedReviewerIds)];
  if (expected.length === 0) {
    return { decision: 'blocked', reason: '无可评审成果（预期互评集合为空）' };
  }
  const facts = factsFor(expected.map((memberId) => ({ memberId })), input.participants);
  const withOutput = facts.filter((p) => p.hasStageOutput);
  if (withOutput.length === 0) {
    if (facts.every(terminatedForBarrier)) {
      return { decision: 'blocked', reason: '互评全员无有效输入' };
    }
    return { decision: 'wait', reason: `互评 0/${expected.length}，等待或按 E4 缺席推进` };
  }
  const outstanding = facts.filter((p) => !p.hasStageOutput && !terminatedForBarrier(p));
  if (outstanding.length > 0) {
    return { decision: 'wait', reason: `互评未收齐（${withOutput.length}/${expected.length}）；待：${outstanding.map((p) => p.memberId).join(', ')}` };
  }
  return { decision: 'advance', next: 'ISSUE_DISCUSSION', reason: `互评收齐（${withOutput.length}/${expected.length}，缺席/失败席位已终结）` };
}

// ---------- 成果引用（三元组绑定）与争议身份 ----------

/** 结论的唯一身份：来源成果 + 版本 + 局部 claimId（缺一即可能跨成员/跨版本混并）。 */
export interface ClaimRef {
  artifactId: string;
  artifactRevision: number;
  claimId: string;
}

export interface FrozenClaim extends ClaimRef {
  statement: string;
}

export interface ReviewPosition {
  reviewerMemberId: string;
  target: ClaimRef;
  stance: 'agree' | 'disagree' | 'needs_evidence';
}

/** 运行范围唯一争议身份：含 runId 的稳定散列（不同 run 同名 claim 不冲突）。 */
export function issueIdFor(runId: string, ref: ClaimRef): string {
  const h = createHash('sha256').update(`${runId}|${ref.artifactId}|${ref.artifactRevision}|${ref.claimId}`).digest('hex');
  return `iss_${h.slice(0, 24)}`;
}

export interface DerivedIssue {
  issueId: string;
  target: ClaimRef;
  statement: string;
  status: 'open';
  disagreeMemberIds: string[];
  needsEvidenceMemberIds: string[];
}

/**
 * 校验互评引用属于当前冻结可读版本（组装/提交侧调用，不信模型自报）：
 * 未知成果、错误版本、未知 claimId → 整份拒绝并指出首个违规项。
 */
export function validateClaimReferences(frozenClaims: ReadonlyArray<FrozenClaim>, reviews: ReadonlyArray<ReviewPosition>): DomainResult<{ matched: ReadonlyArray<ReviewPosition> }> {
  const index = new Set(frozenClaims.map((c) => `${c.artifactId}|${c.artifactRevision}|${c.claimId}`));
  for (const r of reviews) {
    const key = `${r.target.artifactId}|${r.target.artifactRevision}|${r.target.claimId}`;
    if (!index.has(key)) {
      return domainErr('CLAIM_NOT_FOUND', `互评引用未获准的结论版本：artifact=${r.target.artifactId} rev=${r.target.artifactRevision} claim=${r.target.claimId}（评审人 ${r.reviewerMemberId}）`);
    }
  }
  return domainOk({ matched: reviews });
}

/**
 * 由互评立场构建结构化争议清单（按结论三元组合并同名项）：
 * 只收 disagree/needs_evidence；全员同意的 claim 不进争议。
 */
export function deriveIssues(
  runId: string,
  frozenClaims: ReadonlyArray<FrozenClaim>,
  reviews: ReadonlyArray<ReviewPosition>,
): DerivedIssue[] {
  const issues: DerivedIssue[] = [];
  for (const claim of frozenClaims) {
    const disagree = reviews.filter((r) => r.target.artifactId === claim.artifactId && r.target.artifactRevision === claim.artifactRevision && r.target.claimId === claim.claimId && r.stance === 'disagree').map((r) => r.reviewerMemberId);
    const needsEvidence = reviews.filter((r) => r.target.artifactId === claim.artifactId && r.target.artifactRevision === claim.artifactRevision && r.target.claimId === claim.claimId && r.stance === 'needs_evidence').map((r) => r.reviewerMemberId);
    if (disagree.length === 0 && needsEvidence.length === 0) continue;
    issues.push({
      issueId: issueIdFor(runId, claim),
      target: { artifactId: claim.artifactId, artifactRevision: claim.artifactRevision, claimId: claim.claimId },
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

export interface RoundIssuePosition {
  issueId: string;
  issueRevision: number;
  memberId: string;
  stance: 'agree' | 'disagree' | 'needs_evidence';
  sourceArtifactId: string;
}

export interface FrozenIssueStance {
  issueId: string;
  stance: 'agree' | 'disagree';
}

/**
 * 当前讨论轮是否已形成每项 issue 的完整一致立场矩阵。
 *
 * - 全 agree = 正向共识；
 * - 全 disagree = 一致否定旧主张/旧表述，同样是可进入整合的明确结论；
 * - needs_evidence、混合立场、缺项、历史轮或无来源均不收敛。
 *
 * 一致否定不能被当作 agree/confirm；它可以表示“争议已按否定意见处理”，
 * 但必须保留全部 disagree 立场与否定理由，并让更正后的 claims 继续走 RAT 确认。
 * 来源 artifact 的 run/kind/author/revision 校验由调用方查询完成。
 */
export function unanimousFrozenIssueStancesInRound(input: {
  issueIds: ReadonlyArray<string>;
  expectedMemberIds: ReadonlyArray<string>;
  roundNo: number;
  positions: ReadonlyArray<RoundIssuePosition>;
}): FrozenIssueStance[] | null {
  const issueIds = [...new Set(input.issueIds)];
  const memberIds = [...new Set(input.expectedMemberIds)];
  if (issueIds.length === 0 || memberIds.length === 0) return null;
  const result: FrozenIssueStance[] = [];
  for (const issueId of issueIds) {
    let issueStance: FrozenIssueStance['stance'] | null = null;
    for (const memberId of memberIds) {
      const matches = input.positions.filter((position) =>
        position.issueId === issueId
        && position.issueRevision === input.roundNo
        && position.memberId === memberId
        && position.sourceArtifactId.length > 0,
      );
      if (matches.length === 0) return null;
      const stances = new Set(matches.map((position) => position.stance));
      if (stances.size !== 1) return null;
      const stance = matches[0]!.stance;
      if (stance === 'needs_evidence') return null;
      if (issueStance == null) issueStance = stance;
      else if (issueStance !== stance) return null;
    }
    if (issueStance == null) return null;
    result.push({ issueId, stance: issueStance });
  }
  return result;
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
  /** null = 未提交（pending/missing；程序记 missing 不等于模型明确 unconfirmed）。 */
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
