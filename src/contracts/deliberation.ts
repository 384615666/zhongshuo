/**
 * DELIBERATE 研讨合同（§6/§10.4/§4.3；DEV-08/09/21-M1）。
 *
 * 模型输出按 schema 校验（§6.4）：payload 只含模型能决定的字段；artifactId/memberId/
 * revision/baselineId 等身份与版本由程序在落库时赋值，不信模型自报。
 * 输出契约模板（renderDeliberateBundle，DEV-21-M1）必须给出与这里完全一致的字段集
 * （ADR-I39 教训：字段集足以让陌生模型一次写对）。
 */
import { z } from 'zod';
import { documentSchema } from './document.ts';
import type { FrozenCallBudgetPolicy } from './callBudget.ts';

// ---------- 名单与缺席（§4.3/E4） ----------

/** run_participants.status 的语义集（迟到=超时后按缺席继续、成果随后到达）。 */
export const PARTICIPANT_STATUS = ['pending', 'completed', 'late', 'absent', 'unavailable', 'failed'] as const;
export type ParticipantStatus = (typeof PARTICIPANT_STATUS)[number];

/** 冻结名单（创建运行时冻结，不悄悄排除离线成员；新增房间成员不自动加入）。 */
export interface FrozenRoster {
  revision: number;
  members: ReadonlyArray<{
    memberId: string;
    /** host=主持者（默认协调者；其第一轮也先独立出报告）。 */
    role: 'host' | 'member';
    expected: boolean;
  }>;
}

// ---------- §6.4 报告与异议格式 ----------
// payload 携带不可变 schemaVersion（TaskComplete 同口径）：模板与校验共用同一字面量。

export const ANALYSIS_DRAFT_SCHEMA_VERSION = 'analysis-draft-v1';
export const CROSS_REVIEW_SCHEMA_VERSION = 'cross-review-v1';
export const ISSUE_POSITION_SCHEMA_VERSION = 'issue-position-v1';
export const CHECKPOINT_VERDICT_SCHEMA_VERSION = 'checkpoint-verdict-v1';
export const SYNTHESIS_SCHEMA_VERSION = 'synthesis-v1';
export const RATIFY_SCHEMA_VERSION = 'ratify-v1';

export const issueResolutionSchema = z.strictObject({
  issueId: z.string().min(1),
  status: z.enum(['resolved', 'needs_user', 'insufficient_evidence']),
  reason: z.string().min(1),
  question: z.string().optional(),
  owner: z.string().optional(),
});
export type IssueResolution = z.infer<typeof issueResolutionSchema>;

export const deliveryFeedbackSchema = z.strictObject({
  status: z.enum(['ready', 'needs_revision', 'needs_user']),
  reason: z.string().min(1),
  revisionRequest: z.string().optional(),
  question: z.string().optional(),
  owner: z.string().optional(),
});
export type DeliveryFeedback = z.infer<typeof deliveryFeedbackSchema>;


export const analysisClaimSchema = z.strictObject({
  claimId: z.string().min(1),
  statement: z.string().min(1),
  kind: z.enum(['observed', 'inferred', 'proposal']),
  evidenceIds: z.array(z.string().min(1)),
  uncertainty: z.string().optional(),
});

/**
 * R95 用户展示字段由模型自行撰写：summary 为简练总览，detailMarkdown 为完整 Markdown。
 * IND/SYN 的既有 summary 保持 required；新增 detailMarkdown 及 CR/ISS/CHK/RAT 的
 * summary 在存储 schema 中 optional，以兼容历史 artifact。provider 传输 schema 通过
 * deliberationOutputSchema().requireFields 对新调用强制要求两者。
 */
/** INDEPENDENT 阶段模型输出（artifactId/memberId/revision/baselineId 由程序赋值）。 */
export const analysisDraftPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ANALYSIS_DRAFT_SCHEMA_VERSION),
  summary: z.string().min(1),
  detailMarkdown: z.string().optional(),
  document: documentSchema.nullable().optional(),
  claims: z.array(analysisClaimSchema).min(1),
  recommendations: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type AnalysisDraftPayload = z.infer<typeof analysisDraftPayloadSchema>;

/** 落库后的完整 AnalysisReport（§6.4 接口）。 */
export interface AnalysisReport {
  artifactId: string;
  memberId: string;
  baselineId: string;
  revision: number;
  payload: AnalysisDraftPayload;
}

/** CROSS_REVIEW 阶段模型输出：对他人初稿 claim 的逐条评审（三元组绑定，防跨成员/跨版本混并）。 */
export const reviewPayloadSchema = z.strictObject({
  schemaVersion: z.literal(CROSS_REVIEW_SCHEMA_VERSION),
  summary: z.string().min(1).optional(),
  detailMarkdown: z.string().optional(),
  document: documentSchema.nullable().optional(),
  reviews: z.array(z.strictObject({
    targetArtifactId: z.string().min(1),
    targetRevision: z.number().int().min(1),
    targetClaimId: z.string().min(1),
    stance: z.enum(['agree', 'disagree', 'needs_evidence']),
    reason: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
    suggestedVerification: z.string().optional(),
  })).min(1),
});
export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

/** ISSUE_DISCUSSION 轮次模型输出：对冻结争议列表的立场与（可选）新证据。 */
export const issuePositionPayloadSchema = z.strictObject({
  schemaVersion: z.literal(ISSUE_POSITION_SCHEMA_VERSION),
  summary: z.string().min(1).optional(),
  detailMarkdown: z.string().optional(),
  document: documentSchema.nullable().optional(),
  positions: z.array(z.strictObject({
    issueId: z.string().min(1),
    stance: z.enum(['agree', 'disagree', 'needs_evidence']),
    reason: z.string().min(1),
    newEvidence: z.array(z.strictObject({
      description: z.string().min(1),
      evidenceId: z.string().min(1),
    })),
  })).min(1),
});
export type IssuePositionPayload = z.infer<typeof issuePositionPayloadSchema>;

/** 第 3 轮主持复核（turn_purpose=checkpoint）输出：继续或停止由主持者按证据判断（决策 06）。 */
export const checkpointVerdictPayloadSchema = z.strictObject({
  schemaVersion: z.literal(CHECKPOINT_VERDICT_SCHEMA_VERSION),
  summary: z.string().min(1).optional(),
  detailMarkdown: z.string().optional(),
  document: documentSchema.nullable().optional(),
  verdict: z.enum(['continue', 'stop']),
  reason: z.string().min(1),
  /** 值得继续追的新证据摘要（verdict=continue 时必填语义，schema 层不强制）。 */
  evidenceSummary: z.string().optional(),
});
export type CheckpointVerdictPayload = z.infer<typeof checkpointVerdictPayloadSchema>;

/** SYNTHESIS 整合稿模型输出：claimId 由程序赋值（`clm_N`），sourceRefs 引用分析 claimId。 */
export const synthesisPayloadSchema = z.strictObject({
  schemaVersion: z.literal(SYNTHESIS_SCHEMA_VERSION),
  summary: z.string().min(1),
  detailMarkdown: z.string().optional(),
  document: documentSchema.nullable().optional(),
  issueResolutions: z.array(issueResolutionSchema).optional(),
  claims: z.array(z.strictObject({
    statement: z.string().min(1),
    sourceRefs: z.array(z.string().min(1)),
  })).min(1),
  disputedClaims: z.array(z.strictObject({
    statement: z.string().min(1),
    disagreementSummary: z.string().min(1),
    sourceRefs: z.array(z.string().min(1)),
  })),
  recommendations: z.array(z.string()),
});
export type SynthesisPayload = z.infer<typeof synthesisPayloadSchema>;

/** RATIFY 模型输出：逐结论确认/异议；提交事务验证 claimId 全覆盖且无重复（§6.5）。 */
export const ratifyPayloadSchema = z.strictObject({
  schemaVersion: z.literal(RATIFY_SCHEMA_VERSION),
  summary: z.string().min(1).optional(),
  detailMarkdown: z.string().optional(),
  document: documentSchema.nullable().optional(),
  deliveryFeedback: deliveryFeedbackSchema.optional(),
  responses: z.array(z.strictObject({
    claimId: z.string().min(1),
    stance: z.enum(['confirm', 'conditional', 'object', 'unconfirmed']),
    conditions: z.array(z.string()).optional(),
    reason: z.string().optional(),
  })).min(1),
});
export type RatifyPayload = z.infer<typeof ratifyPayloadSchema>;

// ---------- 共识聚合（§6.5） ----------

export type ClaimConsensus = 'unanimous' | 'qualified' | 'disputed' | 'unconfirmed';

/** 单一主状态优先级：disputed → unconfirmed → qualified → unanimous（缺席不覆盖反对）。 */
export const CLAIM_CONSENSUS_PRIORITY: ReadonlyArray<ClaimConsensus> = ['disputed', 'unconfirmed', 'qualified', 'unanimous'];

export interface ClaimRatificationSummary {
  claimId: string;
  consensus: ClaimConsensus;
  confirms: number;
  conditionals: number;
  objects: number;
  unconfirmedExplicit: number;
  missing: number;
}

// ---------- 预算：E12 推导与尾部预留（§10.4，2026-09-19/20/24 口径） ----------

export interface DeliberationBudgetInit {
  /** 冻结名单人数 N。 */
  rosterSize: number;
  /** 用户设置的总上限（默认值由调用方决定；推导值发送前可见、设置可改——决策 12）。 */
  runMaxTurns: number;
  /** R98 request-frozen policy; missing preserves legacy finite-cap behavior. */
  callBudget?: FrozenCallBudgetPolicy | null;
}

export interface DeliberationBudgetState {
  /** M：运行总上限。 */
  runMaxTurns: number;
  /** U：已结算调用数。 */
  usedTurns: number;
  /** I：在途占用（含已占用的尾部保留步骤）。 */
  inFlightReservedTurns: number;
  /** S/Q：SYNTHESIS/RATIFY 未占用尾部预留（初始化 S=1、Q=N）。 */
  tailReservationByStage: { SYNTHESIS: number; RATIFY: number };
  callBudget?: FrozenCallBudgetPolicy | null;
}

/** E12 公式：核心 6N+1+C、含一次修订 7N+2+C（C=预计进入第 3 轮另加 1，否则 0）。 */
export function deriveDeliberateMaxTurns(rosterSize: number, options?: { expectsCheckpointRound3?: boolean }): {
  core: number;
  withRevision: number;
} {
  const n = rosterSize;
  const c = options?.expectsCheckpointRound3 === true ? 1 : 0;
  return { core: 6 * n + 1 + c, withRevision: 7 * n + 2 + c };
}

export function initDeliberationBudget(init: DeliberationBudgetInit): DeliberationBudgetState {
  return {
    runMaxTurns: init.runMaxTurns,
    usedTurns: 0,
    inFlightReservedTurns: 0,
    tailReservationByStage: { SYNTHESIS: 1, RATIFY: init.rosterSize },
    ...(init.callBudget !== undefined ? { callBudget: init.callBudget } : {}),
  };
}

/** R=M-U-I、T=S+Q、F=R-T（§10.4 尾部账目公式；所有字段非负）。 */
export interface BudgetAccounting {
  remainingTurns: number;
  tailReserved: number;
  tailReservationByStage: { SYNTHESIS: number; RATIFY: number };
  /** 前置工作/checkpoint/format_repair 可用配额（F）。 */
  nonTailAvailable: number;
  /** 当前可用配额 = F + 本阶段 ownReserve（SYNTHESIS=S / RATIFY=Q / 其余 0）。 */
  stageAvailableTurns: number;
  /** Disabled means count-only: availability numbers stay factual, but dispatch is allowed. */
  enforcement: 'enabled' | 'disabled' | 'legacy';
  canDispatch: boolean;
}

export function budgetAccounting(state: DeliberationBudgetState, stage: 'SYNTHESIS' | 'RATIFY' | 'front'): BudgetAccounting {
  const r = Math.max(0, state.runMaxTurns - state.usedTurns - state.inFlightReservedTurns);
  const s = Math.max(0, state.tailReservationByStage.SYNTHESIS);
  const q = Math.max(0, state.tailReservationByStage.RATIFY);
  const t = s + q;
  const f = Math.max(0, r - t);
  const ownReserve = stage === 'SYNTHESIS' ? s : stage === 'RATIFY' ? q : 0;
  const stageAvailableTurns = f + ownReserve;
  const enforcement = state.callBudget?.enforcement ?? 'legacy';
  return {
    remainingTurns: r,
    tailReserved: t,
    tailReservationByStage: { SYNTHESIS: s, RATIFY: q },
    nonTailAvailable: f,
    stageAvailableTurns,
    enforcement,
    canDispatch: enforcement === 'disabled' || stageAvailableTurns > 0,
  };
}

/**
 * Dispatch accounting stage. Format repairs are front-run and may consume only
 * non-tail F; normal SYN/RAT turns retain their configured own reserve.
 */
export function dispatchBudgetStage(
  stage: 'SYNTHESIS' | 'RATIFY' | 'front',
  isRepair: boolean,
): 'SYNTHESIS' | 'RATIFY' | 'front' {
  return isRepair ? 'front' : stage;
}

/** 派发尾部调用：先占用本阶段保留额（S/Q 减 1，I 加 1）。返回新状态（纯函数）。 */
export function occupyTailForDispatch(
  state: DeliberationBudgetState,
  stage: 'SYNTHESIS' | 'RATIFY',
): DeliberationBudgetState {
  return {
    ...state,
    inFlightReservedTurns: state.inFlightReservedTurns + 1,
    tailReservationByStage: {
      ...state.tailReservationByStage,
      [stage]: Math.max(0, state.tailReservationByStage[stage] - 1),
    },
  };
}

/**
 * 派发前置调用（IND/CR/DIS/checkpoint/格式修复）的占用预留（I 加 1）。
 * 2026-09-28 A 组真实运行缺陷修复：前置派发此前不设占用——两个前置 turn（如争议讨论
 * 的双成员 DIS）并行领取时各自读到同一份预算快照（usedTurns 未含对方），第 10 个调用
 * 漏出上限（runMaxTurns=9 实发 10）。派发时预留、settleTurn 释放，账目在并发下闭合。
 */
export function occupyFrontForDispatch(state: DeliberationBudgetState): DeliberationBudgetState {
  return { ...state, inFlightReservedTurns: state.inFlightReservedTurns + 1 };
}

/** 结算：I 减 1、U 加 1（R 不重复扣减）。重试/格式修复只能用 F（不借用其他预留）。 */
export function settleTurn(state: DeliberationBudgetState): DeliberationBudgetState {
  return {
    ...state,
    usedTurns: state.usedTurns + 1,
    inFlightReservedTurns: Math.max(0, state.inFlightReservedTurns - 1),
  };
}

/**
 * 确认未启动退款（DEV-13 recovery.reconcile verdict=notStarted）：仅释放在途预留
 * （I 减 1、U 不加——调用未发生不计数）。与 settleTurn 对应；用于崩溃后确认该请求
 * 从未到达 runtime 的占位回收。
 */
export function refundReservedTurn(state: DeliberationBudgetState): DeliberationBudgetState {
  return { ...state, inFlightReservedTurns: Math.max(0, state.inFlightReservedTurns - 1) };
}
