/**
 * DELIBERATE 持久化编排（§6/§10.4/§4.3；DEV-08/09 M1）。
 *
 * 形态：每个逻辑步骤一条 outbox 项（dispatch_key 确定性编码 阶段/成员/轮次/用途），
 * worker 领取 → 组装阶段过滤输入 → 派发 → 输出校验通过才计入屏障 → 推进事务。
 * PREPARE/PUBLISH 由程序完成（不调用模型）；崩溃重领沿用 worker 的对账纪律（RT-03）。
 *
 * 输入隔离在组装侧：INDEPENDENT 不含他人草稿；CROSS_REVIEW 只读冻结初稿；
 * SYNTHESIS/RATIFY 绑定当前冻结整合稿版本——不信提示词自觉。
 *
 * 预算（E12）：派发前核对 stageAvailableTurns；尾部派发先占用 S/Q；
 * 结算/未启动取消退款走同一套账（budget_json 单一真源）；耗尽后不再调用模型。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { enqueueOutbox } from '../persistence/outbox.ts';
import { appendDomainEvent } from '../persistence/events.ts';
import {
  analysisDraftPayloadSchema,
  budgetAccounting,
  checkpointVerdictPayloadSchema,
  deriveDeliberateMaxTurns,
  initDeliberationBudget,
  issuePositionPayloadSchema,
  ratifyPayloadSchema,
  reviewPayloadSchema,
  synthesisPayloadSchema,
  type DeliberationBudgetState,
  type ParticipantStatus,
} from '../contracts/deliberation.ts';
import {
  aggregateClaimConsensus,
  decideCrossReviewBarrier,
  decideIndependentBarrier,
  deriveIssues,
  nextAfterCrossReview,
  overallConsensus,
  validateClaimReferences,
  type FrozenRoster,
  type FrozenClaim,
} from '../domain/deliberation/stageMachine.ts';
import {
  closeRatificationBarrier,
  getRatificationRecords,
  getSynthesisClaims,
  initRatificationMatrix,
  insertIssues,
  insertSynthesisClaims,
  listRunArtifacts,
  publishDeliberationArtifact,
  submitRatification,
  currentSynthesisVersion,
} from '../persistence/stores/deliberation.ts';
import { DELIBERATE_OUTPUT_CONTRACTS, selectStageInstruction } from '../contracts/prompts.ts';
import type { TopLevelRouteOutcome } from '../contracts/routing.ts';
import type { DomainResult } from '../contracts/errors.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { z } from 'zod';

// ---------- 步骤身份（dispatch_key 语法） ----------

export type DelibStageCode = 'IND' | 'CR' | 'ISS' | 'CHK' | 'SYN' | 'RAT' | 'RPR';

export interface DelibStep {
  taskId: string;
  stage: DelibStageCode;
  memberId: string;
  roundNo: number;
  purpose: 'stage_work' | 'checkpoint' | 'format_repair';
  /** RPR 的修复目标（原步骤的 stage code）。 */
  repairTarget?: DelibStageCode;
}

const STAGE_CODE: Record<DelibStageCode, string> = { IND: 'IND', CR: 'CR', ISS: 'ISS', CHK: 'CHK', SYN: 'SYN', RAT: 'RAT', RPR: 'RPR' };

export function delibDispatchKey(step: DelibStep): string {
  const purposeChar = step.purpose === 'checkpoint' ? 'c' : step.purpose === 'format_repair' ? 'f' : 'w';
  if (step.stage === 'RPR') {
    return `task:${step.taskId}:delib:RPR:${step.memberId}:${step.roundNo}:${step.repairTarget ?? 'IND'}`;
  }
  return `task:${step.taskId}:delib:${STAGE_CODE[step.stage]}:${step.memberId}:${step.roundNo}:${purposeChar}`;
}

export function parseDelibStep(dispatchKey: string): DelibStep | null {
  const m = dispatchKey.match(/^task:(.+):delib:(IND|CR|ISS|CHK|SYN|RAT|RPR):([^:]+):(\d+):(w|c|f)$/);
  if (m == null) return null;
  const stage = m[2] as DelibStageCode;
  return {
    taskId: m[1]!,
    stage,
    memberId: m[3]!,
    roundNo: Number(m[4]),
    purpose: m[5] === 'c' ? 'checkpoint' : m[5] === 'f' ? 'format_repair' : 'stage_work',
    repairTarget: stage === 'RPR' ? ((m[5] as unknown as DelibStageCode) ?? 'IND') : undefined,
  };
}

/** RPR 键的目标阶段编码在用途位（w/c/f 位置放目标 code）。 */
export function repairDispatchKey(base: DelibStep): string {
  return `task:${base.taskId}:delib:RPR:${base.memberId}:${base.roundNo}:${base.stage}`;
}

export function parseRepairTarget(dispatchKey: string): DelibStep | null {
  const m = dispatchKey.match(/^task:(.+):delib:RPR:([^:]+):(\d+):(IND|CR|ISS|CHK|SYN|RAT)$/);
  if (m == null) return null;
  return { taskId: m[1]!, stage: m[4] as DelibStep['stage'], memberId: m[2]!, roundNo: Number(m[3]), purpose: 'format_repair' };
}

// ---------- PREPARE（程序） ----------

export interface RunRow {
  id: string;
  task_id: string;
  conversation_id: string;
  thread_id: string | null;
  mode: string;
  status: string;
  stage: string | null;
  round_no: number | null;
  roster_revision: number | null;
  budget_json: string | null;
}

export interface DeliberationOptions {
  /** E4 缺席容忍（默认 20 分钟）；测试用小值假时钟推进。 */
  absenceToleranceMs: number;
  /** 总调用上限；缺省按 E12 核心公式推导（6N+1）。 */
  runMaxTurns?: number;
  blobDir: string;
}

/**
 * PREPARE：冻结名单（route.frozenMemberIds，host=coordinator/首位）、建 run
 * （stage=INDEPENDENT）、预算初始化（E12）、入队各成员独立首稿步骤。
 * 幂等：run 已存在则只补缺的 IND 步骤。
 */
export function prepareDeliberation(
  db: ZhongshuoDatabase,
  task: { id: string; conversationId: string; threadId: string },
  route: Extract<TopLevelRouteOutcome, { kind: 'dispatch'; mode: 'DELIBERATE' }>,
  options: DeliberationOptions,
): DomainResult<{ runId: string }> {
  const existing = db.prepare('SELECT * FROM workflow_runs WHERE task_id = ? AND mode = ?').get(task.id, 'DELIBERATE') as RunRow | undefined;
  const host = route.initialWakeMemberIds[0] ?? route.frozenMemberIds[0];
  if (host == null) return domainErr('VALIDATION_INVALID', 'DELIBERATE 路由缺少冻结名单');
  if (existing != null) {
    enqueueIndependentSteps(db, existing.id, task.id, route.frozenMemberIds);
    return domainOk({ runId: existing.id });
  }
  const runId = `run_${randomUUID()}`;
  const budget = initDeliberationBudget({
    rosterSize: route.frozenMemberIds.length,
    // E12 完整预估：默认讨论可到第 3 轮 → 含 C=1 检查点（6N+1+C）；用户设置可覆盖。
    runMaxTurns: options.runMaxTurns ?? deriveDeliberateMaxTurns(route.frozenMemberIds.length, { expectsCheckpointRound3: true }).core,
  });
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, stage, round_no, roster_revision, budget_json, stage_started_at)
       VALUES (?, ?, ?, ?, 'DELIBERATE', 0, 'RUNNING', 'INDEPENDENT', 0, 1, ?, ?)`,
    ).run(runId, task.id, task.conversationId, task.threadId, JSON.stringify(budget), Date.now());
    for (const memberId of route.frozenMemberIds) {
      db.prepare(
        `INSERT INTO run_participants (run_id, member_id, role, expected, status) VALUES (?, ?, ?, 1, 'pending')`,
      ).run(runId, memberId, memberId === host ? 'host' : 'member');
    }
    appendDomainEvent(db, {
      schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: task.conversationId,
      threadId: task.threadId, taskId: task.id, runId, kind: 'run.stageAdvanced', createdAt: Date.now(),
      payload: { stage: 'INDEPENDENT', rosterRevision: 1, members: route.frozenMemberIds },
    });
  });
  tx();
  enqueueIndependentSteps(db, runId, task.id, route.frozenMemberIds);
  return domainOk({ runId });
}

function enqueueIndependentSteps(db: ZhongshuoDatabase, runId: string, taskId: string, memberIds: readonly string[]): void {
  void runId;
  const tx = db.transaction(() => {
    for (const memberId of memberIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'IND', memberId, roundNo: 0, purpose: 'stage_work' }) });
    }
  });
  tx();
}

// ---------- 名单/事实/冻结成果读取 ----------

function rosterOf(db: ZhongshuoDatabase, runId: string): FrozenRoster {
  const rows = db.prepare('SELECT member_id, role FROM run_participants WHERE run_id = ? AND expected = 1').all(runId) as Array<{ member_id: string; role: string }>;
  const revisionRow = db.prepare('SELECT roster_revision FROM workflow_runs WHERE id = ?').get(runId) as { roster_revision: number | null } | undefined;
  return {
    revision: revisionRow?.roster_revision ?? 1,
    members: rows.map((r) => ({ memberId: r.member_id, role: r.role === 'host' ? ('host' as const) : ('member' as const), expected: true })),
  };
}

function participantsOf(db: ZhongshuoDatabase, runId: string): Array<{ memberId: string; status: ParticipantStatus }> {
  const rows = db.prepare('SELECT member_id, status FROM run_participants WHERE run_id = ?').all(runId) as Array<{ member_id: string; status: string }>;
  return rows.map((r) => ({ memberId: r.member_id, status: r.status as ParticipantStatus }));
}

function artifactPayload(db: ZhongshuoDatabase, artifactId: string): unknown {
  const row = db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(artifactId) as { blob_path: string } | undefined;
  if (row == null) return null;
  return JSON.parse(readFileSync(row.blob_path, 'utf8'));
}

interface DraftArtifact {
  artifactId: string;
  memberId: string;
  revision: number;
  payload: { summary: string; claims: Array<{ claimId: string; statement: string; kind: string; evidenceIds: string[]; uncertainty?: string }>; recommendations: string[]; openQuestions: string[] };
}

function frozenDrafts(db: ZhongshuoDatabase, runId: string): DraftArtifact[] {
  const rows = listRunArtifacts(db, runId, 'analysis_draft');
  const drafts: DraftArtifact[] = [];
  for (const r of rows) {
    const payload = artifactPayload(db, r.id) as DraftArtifact['payload'];
    if (payload != null) drafts.push({ artifactId: r.id, memberId: r.author_id, revision: r.revision, payload });
  }
  return drafts;
}

function draftClaims(drafts: readonly DraftArtifact[]): FrozenClaim[] {
  return drafts.flatMap((d) => d.payload.claims.map((c) => ({ artifactId: d.artifactId, artifactRevision: d.revision, claimId: c.claimId, statement: c.statement })));
}

// ---------- 阶段推进规划（幂等；屏障→入队下一步） ----------

export interface PumpResult {
  advanced: boolean;
  blocked?: string;
}

/**
 * 泵：对 RUNNING 的 DELIBERATE run 做①E4 缺席标记（按 stage_started_at，非统一
 * wall-clock）②屏障判定与阶段推进③下一步骤入队（幂等）。PUBLISH 收尾含共识聚合
 * 与最终报告发布（程序完成，不调用模型）。
 */
export function pumpDeliberation(db: ZhongshuoDatabase, taskId: string, options: DeliberationOptions, now = Date.now()): PumpResult {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE task_id = ? AND mode = ?').get(taskId, 'DELIBERATE') as (RunRow & { stage_started_at: number | null }) | undefined;
  if (run == null || !['RUNNING', 'WAITING'].includes(run.status)) return { advanced: false };
  const task = db.prepare('SELECT id, conversation_id, conversation_thread_id, status FROM tasks WHERE id = ?').get(taskId) as
    | { id: string; conversation_id: string; conversation_thread_id: string | null; status: string }
    | undefined;
  if (task == null || ['CANCELLED', 'DONE'].includes(task.status)) return { advanced: false };
  const threadId = task.conversation_thread_id ?? run.thread_id ?? '';
  const roster = rosterOf(db, run.id);
  let participants = participantsOf(db, run.id);
  const drafts = frozenDrafts(db, run.id);
  const stage = run.stage ?? 'INDEPENDENT';

  // E4：阶段开始超过容忍窗口仍未产出的 pending 席位 → absent（不打断在途成员）。
  const stageAge = run.stage_started_at != null ? now - run.stage_started_at : 0;
  if (options.absenceToleranceMs > 0 && stageAge >= options.absenceToleranceMs) {
    markOverdueAbsent(db, run.id, stage, now);
    participants = participantsOf(db, run.id); // 缺席标记后重读（否则屏障看到陈旧 pending）
  }

  const budget = readBudget(run.budget_json);
  // §6.5 预算兜底：前置配额耗尽且无在途步骤时，转入整合（有产出即出诚实报告；
  // 无任何产出 → BLOCKED，不合成虚构研讨）。讨论轮被截停属预期（AT-05）。
  const frontAvail = budgetAccounting(budget, 'front').stageAvailableTurns;
  if (frontAvail < 1 && ['INDEPENDENT', 'CROSS_REVIEW', 'ISSUE_DISCUSSION'].includes(stage) && drafts.length > 0) {
    const noPendingSteps = (db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ? AND status IN ('pending','leased')").get(`task:${taskId}:delib:%`) as { c: number }).c === 0;
    if (noPendingSteps) {
      advanceStage(db, run.id, taskId, 'SYNTHESIS', 0, now, { from: stage, reason: '前置预算耗尽，按 §6.5 转入整合' });
      enqueueSynthesis(db, taskId, hostOf(roster));
      return { advanced: true };
    }
  }

  switch (stage) {
    case 'INDEPENDENT': {
      const facts = roster.members.map((m: { memberId: string }) => ({
        memberId: m.memberId,
        status: statusOf(participants, m.memberId),
        hasStageOutput: drafts.some((d) => d.memberId === m.memberId),
      }));
      const decision = decideIndependentBarrier(roster, facts);
      if (decision.decision === 'advance') {
        advanceStage(db, run.id, taskId, 'CROSS_REVIEW', 0, now, { from: 'INDEPENDENT', reason: decision.reason });
        enqueueReviewerSteps(db, taskId, drafts.map((d) => d.memberId));
        return { advanced: true };
      }
      if (decision.decision === 'blocked') {
        // 全员无有效输入：明确阻塞——不合成虚构研讨报告（§6.1）。
        db.prepare("UPDATE workflow_runs SET status = 'FAILED' WHERE id = ?").run(run.id);
        db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = ? AND status NOT IN ('CANCELLED','DONE')").run(taskId);
        appendDomainEvent(db, {
          schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: task.conversation_id,
          threadId, taskId, runId: run.id, kind: 'run.deliberationBlocked', createdAt: now, payload: { reason: decision.reason },
        });
        return { advanced: true, blocked: decision.reason };
      }
      return { advanced: false };
    }
    case 'CROSS_REVIEW': {
      const reviewers = drafts.map((d) => d.memberId);
      const facts = reviewers.map((memberId: string) => ({
        memberId,
        status: statusOf(participants, memberId),
        hasStageOutput: listRunArtifacts(db, run.id, 'cross_review').some((a) => a.author_id === memberId),
      }));
      const decision = decideCrossReviewBarrier({ roster, expectedReviewerIds: reviewers, participants: facts });
      if (decision.decision === 'advance') {
        const reviews = collectReviews(db, run.id);
        const claims = draftClaims(drafts);
        const issues = deriveIssues(run.id, claims, reviews.map((r) => ({ reviewerMemberId: r.memberId, target: r.target, stance: r.stance })));
        const next = nextAfterCrossReview(issues);
        if (next.next === 'ISSUE_DISCUSSION') {
          const tx = db.transaction(() => {
            insertIssues(db, run.id, issues.map((i) => ({ issueId: i.issueId, statement: i.statement, evidenceRefs: [] })), 1);
            advanceStage(db, run.id, taskId, 'ISSUE_DISCUSSION', 1, now, { from: 'CROSS_REVIEW', reason: next.reason, issueCount: issues.length });
          });
          tx();
          enqueueIssueSteps(db, taskId, reviewers, 1);
        } else {
          advanceStage(db, run.id, taskId, 'SYNTHESIS', 0, now, { from: 'CROSS_REVIEW', reason: next.reason });
          enqueueSynthesis(db, taskId, hostOf(roster));
        }
        return { advanced: true };
      }
      if (decision.decision === 'blocked') return { advanced: false, blocked: decision.reason };
      return { advanced: false };
    }
    case 'ISSUE_DISCUSSION': {
      const round = run.round_no ?? 1;
      const reviewers = drafts.map((d) => d.memberId);
      const facts = reviewers.map((memberId: string) => ({
        memberId,
        status: statusOf(participants, memberId),
        hasStageOutput: listRunArtifacts(db, run.id, 'issue_position').some((a) => a.author_id === memberId && a.revision === round),
      }));
      // 'completed' 指上一阶段产出——本阶段收齐只认本阶段产出或跨阶段终结（缺席/失败）。
      const allSettled = facts.every((f) => f.hasStageOutput || f.status === 'absent' || f.status === 'failed');
      if (!allSettled) return { advanced: false };
      // 第 3 轮强制检查点（§6.1）：host、意见已收集、未派发过。
      const host = hostOf(roster);
      const checkpointDone = listRunArtifacts(db, run.id, 'checkpoint_verdict').some((a) => a.revision === round);
      if (round === 3 && !checkpointDone) {
        enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'CHK', memberId: host, roundNo: round, purpose: 'checkpoint' }) });
        return { advanced: false };
      }
      if (round === 3 && checkpointDone) {
        const verdict = checkpointVerdictOf(db, run.id, round);
        if (verdict === 'continue') {
          advanceStage(db, run.id, taskId, 'ISSUE_DISCUSSION', round + 1, now, { from: 'ISSUE_DISCUSSION', reason: '第 3 轮检查点：继续（有新证据）', round: round + 1 });
          enqueueIssueSteps(db, taskId, reviewers, round + 1);
          return { advanced: true };
        }
        advanceStage(db, run.id, taskId, 'SYNTHESIS', 0, now, { from: 'ISSUE_DISCUSSION', reason: '检查点停止/预算上限，转入整合' });
        enqueueSynthesis(db, taskId, host);
        return { advanced: true };
      }
      if (round > 3) {
        // 检查点后的额外轮：一轮后即回检查点语义（预算承担硬上限，决策 06）。
        advanceStage(db, run.id, taskId, 'SYNTHESIS', 0, now, { from: 'ISSUE_DISCUSSION', reason: `第 ${round} 轮完成，转入整合` });
        enqueueSynthesis(db, taskId, host);
        return { advanced: true };
      }
      // round 1→2：直接进入下一轮（每轮开始冻结争议与证据版本；M1 复用 revision 1 争议集）。
      advanceStage(db, run.id, taskId, 'ISSUE_DISCUSSION', round + 1, now, { from: 'ISSUE_DISCUSSION', reason: `第 ${round} 轮意见收齐`, round: round + 1 });
      enqueueIssueSteps(db, taskId, reviewers, round + 1);
      return { advanced: true };
    }
    case 'SYNTHESIS': {
      const synthesis = currentSynthesisVersion(db, run.id);
      if (synthesis != null) return { advanced: false }; // 完成路径已入队 RATIFY
      const host = hostOf(roster);
      const hostFailed = statusOf(participants, host) === 'failed';
      const acc = budgetAccounting(budget, 'SYNTHESIS');
      if (hostFailed || acc.stageAvailableTurns < 1) {
        // 整合不可得：不合成虚构报告——任务 BLOCKED（如实记录原因）。
        db.prepare("UPDATE workflow_runs SET status = 'FAILED' WHERE id = ?").run(run.id);
        db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = ?").run(taskId);
        appendDomainEvent(db, {
          schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: task.conversation_id,
          threadId, taskId, runId: run.id, kind: 'run.synthesisUnavailable', createdAt: now,
          payload: { reason: hostFailed ? 'host_failed' : 'budget_exhausted', stageAvailable: acc.stageAvailableTurns },
        });
        return { advanced: true, blocked: hostFailed ? '主持者失败且无整合' : '预算不足以整合' };
      }
      return { advanced: false };
    }
    case 'RATIFY': {
      const synthesis = currentSynthesisVersion(db, run.id);
      if (synthesis == null) return { advanced: false };
      const claims = getSynthesisClaims(db, run.id, synthesis.artifactId, synthesis.revision).map((c) => c.claim_id);
      const records = getRatificationRecords(db, run.id, synthesis.artifactId, synthesis.revision);
      const expectedMembers = roster.members.map((m) => m.memberId);
      const pendingMembers = expectedMembers.filter((memberId: string) => records.some((r) => r.member_id === memberId && r.response_status === 'pending'));
      const inFlight = listRunArtifacts(db, run.id, 'ratify_response'); // 已有答复的成员
      const stillWorking = pendingMembers.filter((memberId: string) => !inFlight.some((a) => a.author_id === memberId) || statusOf(participants, memberId) === 'pending');
      const overdue = run.stage_started_at != null && now - run.stage_started_at >= options.absenceToleranceMs;
      if (pendingMembers.length > 0 && !overdue) return { advanced: false };
      // 屏障关闭：未答复落 missing（程序记录，不伪造意见）。
      closeRatificationBarrier(db, { runId: run.id, synthesisArtifactId: synthesis.artifactId, synthesisRevision: synthesis.revision, missingReason: overdue ? '未回复（缺席容忍超时）' : '阶段终结' });
      void stillWorking;
      publishFinalReport(db, { runId: run.id, taskId, conversationId: task.conversation_id, threadId, claims, expectedMembers, synthesis, now, blobDir: options.blobDir, reviewPolicy: reviewPolicyOf(db, taskId) });
      return { advanced: true };
    }
    default:
      return { advanced: false };
  }
}

function statusOf(participants: ReadonlyArray<{ memberId: string; status: ParticipantStatus }>, memberId: string): ParticipantStatus {
  return participants.find((p) => p.memberId === memberId)?.status ?? 'pending';
}

function hostOf(roster: FrozenRoster): string {
  return roster.members.find((m) => m.role === 'host')?.memberId ?? roster.members[0]?.memberId ?? '';
}

function readBudget(json: string | null): DeliberationBudgetState {
  if (json == null) return initDeliberationBudget({ rosterSize: 1, runMaxTurns: 7 });
  return JSON.parse(json) as DeliberationBudgetState;
}

function markOverdueAbsent(db: ZhongshuoDatabase, runId: string, stage: string, now: number): void {
  const rows = db.prepare("SELECT member_id FROM run_participants WHERE run_id = ? AND status = 'pending'").all(runId) as Array<{ member_id: string }>;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const hasOutput = memberHasStageOutput(db, runId, stage, r.member_id);
      if (hasOutput) continue;
      db.prepare("UPDATE run_participants SET status = 'absent' WHERE run_id = ? AND member_id = ? AND status = 'pending'").run(runId, r.member_id);
      appendDomainEvent(db, {
        schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: '',
        threadId: null, runId, kind: 'run.participantAbsent', createdAt: now,
        payload: { memberId: r.member_id, stage, reason: 'absence-tolerance' },
      });
    }
  });
  tx();
}

function memberHasStageOutput(db: ZhongshuoDatabase, runId: string, stage: string, memberId: string): boolean {
  const kind = stage === 'INDEPENDENT' ? 'analysis_draft'
    : stage === 'CROSS_REVIEW' ? 'cross_review'
      : stage === 'ISSUE_DISCUSSION' ? 'issue_position'
        : stage === 'RATIFY' ? 'ratify_response'
          : null;
  if (kind == null) return true;
  return listRunArtifacts(db, runId, kind).some((a) => a.author_id === memberId);
}

function advanceStage(db: ZhongshuoDatabase, runId: string, taskId: string, stage: string, roundNo: number, now: number, payload: Record<string, unknown>): void {
  db.prepare('UPDATE workflow_runs SET stage = ?, round_no = ?, stage_started_at = ?, revision = revision + 1 WHERE id = ?').run(stage, roundNo, now, runId);
  appendDomainEvent(db, {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: '',
    threadId: null, taskId, runId, kind: 'run.stageAdvanced', createdAt: now, payload: { stage, ...payload },
  });
}

function enqueueReviewerSteps(db: ZhongshuoDatabase, taskId: string, reviewerIds: readonly string[]): void {
  const tx = db.transaction(() => {
    for (const memberId of reviewerIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'CR', memberId, roundNo: 0, purpose: 'stage_work' }) });
    }
  });
  tx();
}

function enqueueIssueSteps(db: ZhongshuoDatabase, taskId: string, memberIds: readonly string[], round: number): void {
  const tx = db.transaction(() => {
    for (const memberId of memberIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'ISS', memberId, roundNo: round, purpose: 'stage_work' }) });
    }
  });
  tx();
}

function enqueueSynthesis(db: ZhongshuoDatabase, taskId: string, hostId: string): void {
  const tx = db.transaction(() => {
    enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, stage: 'SYN', memberId: hostId, roundNo: 0, purpose: 'stage_work' }) });
  });
  tx();
}

interface CollectedReview {
  memberId: string;
  target: { artifactId: string; artifactRevision: number; claimId: string };
  stance: 'agree' | 'disagree' | 'needs_evidence';
}

function collectReviews(db: ZhongshuoDatabase, runId: string): CollectedReview[] {
  const reviews: CollectedReview[] = [];
  for (const row of listRunArtifacts(db, runId, 'cross_review')) {
    const payload = artifactPayload(db, row.id) as { reviews?: Array<{ targetArtifactId: string; targetRevision: number; targetClaimId: string; stance: 'agree' | 'disagree' | 'needs_evidence' }> };
    for (const r of payload?.reviews ?? []) {
      reviews.push({ memberId: row.author_id, target: { artifactId: r.targetArtifactId, artifactRevision: r.targetRevision, claimId: r.targetClaimId }, stance: r.stance });
    }
  }
  return reviews;
}

function checkpointVerdictOf(db: ZhongshuoDatabase, runId: string, round: number): 'continue' | 'stop' | null {
  const row = listRunArtifacts(db, runId, 'checkpoint_verdict').find((a) => a.revision === round);
  if (row == null) return null;
  const payload = artifactPayload(db, row.id) as { verdict?: 'continue' | 'stop' };
  return payload?.verdict ?? null;
}

function reviewPolicyOf(db: ZhongshuoDatabase, taskId: string): string {
  return (db.prepare('SELECT review_policy FROM tasks WHERE id = ?').get(taskId) as { review_policy: string } | undefined)?.review_policy ?? 'auto_deliver';
}

// ---------- PUBLISH（程序）：共识聚合 + 最终报告 + 交付 ----------

function publishFinalReport(db: ZhongshuoDatabase, input: {
  runId: string; taskId: string; conversationId: string; threadId: string;
  claims: string[]; expectedMembers: string[]; synthesis: { artifactId: string; revision: number };
  now: number; blobDir: string; reviewPolicy: string;
}): void {
  const records = getRatificationRecords(db, input.runId, input.synthesis.artifactId, input.synthesis.revision);
  const summaries = aggregateClaimConsensus(
    input.claims,
    input.expectedMembers,
    records.map((r) => ({ claimId: r.claim_id, memberId: r.member_id, stance: r.stance, responseStatus: r.response_status })),
  );
  const overall = overallConsensus(summaries);
  const synthesisPayload = artifactPayload(db, input.synthesis.artifactId) as { summary?: string; claims?: Array<{ statement: string }>; disputedClaims?: Array<{ statement: string }> } | null;
  const reportPayload = {
    schemaVersion: 'final-report-v1',
    synthesisRef: { artifactId: input.synthesis.artifactId, revision: input.synthesis.revision },
    summary: synthesisPayload?.summary ?? '',
    claimResults: input.claims.map((claimId) => {
      const s = summaries.find((x) => x.claimId === claimId)!;
      const statement = synthesisPayload?.claims?.find((_, i) => `clm_${i + 1}` === claimId)?.statement ?? '';
      return { claimId, statement, consensus: s.consensus, confirms: s.confirms, conditionals: s.conditionals, objects: s.objects, unconfirmedExplicit: s.unconfirmedExplicit, missing: s.missing };
    }),
    overallConsensus: overall,
    disputedClaims: synthesisPayload?.disputedClaims ?? [],
    publishedAt: input.now,
  };
  const artifactId = `art_${randomUUID()}`;
  const published = publishDeliberationArtifact(db, {
    artifactId, projectId: projectIdOf(db, input.taskId), conversationId: input.conversationId, threadId: input.threadId,
    taskId: input.taskId, runId: input.runId, authorId: hostOf(rosterOf(db, input.runId)), kind: 'final_report', revision: 1,
    payload: reportPayload, blobDir: input.blobDir, now: input.now,
  });
  if (!published.ok) throw new Error(`最终报告发布失败：${published.error.message}`);
  const tx = db.transaction(() => {
    const deliveryId = `dlv_${randomUUID()}`;
    const reviewStatus = input.reviewPolicy === 'user_review' ? 'pending' : 'not_required';
    db.prepare(
      `INSERT INTO task_deliveries (id, task_id, run_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status)
       VALUES (?, ?, ?, 1, '', ?, '[]', '[]', ?)`,
    ).run(deliveryId, input.taskId, input.runId, JSON.stringify([`artifact:${artifactId}`]), reviewStatus);
    db.prepare('UPDATE tasks SET status = ?, current_delivery_id = ? WHERE id = ?').run(reviewStatus === 'pending' ? 'REVIEW' : 'DONE', deliveryId, input.taskId);
    db.prepare("UPDATE workflow_runs SET stage = 'PUBLISH', status = 'SUCCEEDED', stage_started_at = ? WHERE id = ?").run(input.now, input.runId);
    appendDomainEvent(db, {
      schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: projectIdOf(db, input.taskId), conversationId: input.conversationId,
      threadId: input.threadId, taskId: input.taskId, runId: input.runId, kind: 'run.finalReportPublished', createdAt: input.now,
      payload: { artifactId, overallConsensus: overall, claims: input.claims.length },
    });
  });
  tx();
}

function projectIdOf(db: ZhongshuoDatabase, taskId: string): string {
  return (db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string }).project_id;
}

// ---------- 步骤输入组装（服务端隔离） ----------

export interface StepAssembly {
  stageKey: string;
  stage: string;
  role: 'host' | 'member';
  turnPurpose: 'stage_work' | 'checkpoint' | 'format_repair';
  text: string;
  instruction: string;
  outputContract: string;
}

/**
 * 按步骤组装输入（阶段过滤在服务端）：
 * - IND：任务根消息/目标（不含他人草稿——此刻也不存在）；
 * - CR：冻结初稿全集（标注 artifactId/revision/claimId 供引用）；
 * - ISS/CHK：冻结争议清单 +（检查点）本轮意见摘要；
 * - SYN：初稿+互评+立场摘要；RAT：冻结整合稿结论清单。
 */
export function assembleStepInput(db: ZhongshuoDatabase, input: {
  taskId: string;
  runId: string;
  /** 修复步骤：目标阶段/成员/轮次的原步骤（step 本身可为占位）。 */
  step: DelibStep;
  /** 非空 = 格式修复轮（一次为限）：正文附上次校验错误。 */
  repairError?: string;
}): DomainResult<StepAssembly> {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(input.runId) as (RunRow & { stage_started_at: number | null }) | undefined;
  if (run == null) return domainErr('RESOURCE_NOT_FOUND', '运行不存在');
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId) as
    | { id: string; title: string; objective: string | null; root_message_id: string | null; project_id: string; conversation_id: string }
    | undefined;
  if (task == null) return domainErr('RESOURCE_NOT_FOUND', '任务不存在');
  const roster = rosterOf(db, input.runId);
  const role: 'host' | 'member' = roster.members.find((m) => m.memberId === input.step.memberId)?.role ?? 'member';

  const isRepair = input.repairError != null;
  const stage = input.step.stage === 'IND' ? 'INDEPENDENT'
    : input.step.stage === 'CR' ? 'CROSS_REVIEW'
      : input.step.stage === 'ISS' ? 'ISSUE_DISCUSSION'
        : input.step.stage === 'CHK' ? 'ISSUE_DISCUSSION'
          : input.step.stage === 'SYN' ? 'SYNTHESIS' : 'RATIFY';
  const turnPurpose: StepAssembly['turnPurpose'] = isRepair
    ? 'format_repair'
    : input.step.stage === 'CHK' ? 'checkpoint' : 'stage_work';
  let body = renderStageBody(db, input.runId, input.taskId, input.step, task, roster);
  if (isRepair) {
    body = `${body}\n\n【格式修复】上一次输出未通过合同校验：${input.repairError}。请严格按输出契约重新提交完整 JSON，不要附加解释文本。`;
  }
  const contract = DELIBERATE_OUTPUT_CONTRACTS[`${stage}|${turnPurpose}`] ?? DELIBERATE_OUTPUT_CONTRACTS[`${stage}|stage_work`] ?? '';
  const instruction = selectStageInstruction({ mode: 'DELIBERATE', role, stage, turnPurpose });
  if (!instruction.ok) return domainErr('CAPABILITY_UNSUPPORTED', instruction.error.message);
  return domainOk({
    // stage_key 在 (run, member, stage_key, attempt) 唯一约束下区分轮次/检查点/修复轮。
    stageKey: `delib.${stage.toLowerCase()}${input.step.roundNo > 0 ? `.r${input.step.roundNo}` : ''}${turnPurpose === 'checkpoint' ? '.chk' : ''}${isRepair ? '.fx' : ''}`,
    stage,
    role,
    turnPurpose,
    instruction: instruction.value,
    outputContract: contract,
    text: `${body}\n\n【输出契约】只输出一个 JSON 对象，字段集如下（不得增删字段）：\n${contract}`,
  });
}

function renderStageBody(
  db: ZhongshuoDatabase,
  runId: string,
  taskId: string,
  step: DelibStep,
  task: { id: string; title: string; objective: string | null; root_message_id: string | null },
  roster: FrozenRoster,
): string {
  const rootText = task.root_message_id != null
    ? ((db.prepare('SELECT body_json FROM messages WHERE id = ?').get(task.root_message_id) as { body_json: string } | undefined)?.body_json ?? '')
    : '';
  const base = `任务：${task.title}\n目标：${task.objective ?? '（无）'}\n原始请求：${rootText}`;
  if (step.stage === 'IND') {
    // 隔离：不含任何他人草稿（此刻也不读取）。
    return `${base}\n\n你是独立分析成员（${step.memberId}）。请独立完成首轮分析。`;
  }
  if (step.stage === 'CR') {
    const drafts = frozenDrafts(db, runId).filter((d) => d.memberId !== step.memberId);
    const listing = drafts.map((d) => ({
      artifactId: d.artifactId,
      revision: d.revision,
      author: d.memberId,
      summary: d.payload.summary,
      claims: d.payload.claims.map((c) => ({ claimId: c.claimId, statement: c.statement, kind: c.kind, uncertainty: c.uncertainty })),
    }));
    return `${base}\n\n待评审初稿（冻结版本，引用须用 artifactId+revision+claimId 三元组）：\n${JSON.stringify(listing, null, 2)}`;
  }
  if (step.stage === 'ISS' || step.stage === 'CHK') {
    const issues = db.prepare('SELECT id, statement FROM issues WHERE run_id = ? ORDER BY id').all(runId) as Array<{ id: string; statement: string }>;
    const positions = collectIssuePositions(db, runId);
    return `${base}\n\n冻结争议清单（issueId 即身份）：\n${JSON.stringify(issues, null, 2)}\n\n已有立场摘要：\n${JSON.stringify(positions, null, 2)}`;
  }
  if (step.stage === 'SYN') {
    const drafts = frozenDrafts(db, runId);
    const reviews = collectReviews(db, runId);
    const positions = collectIssuePositions(db, runId);
    return `${base}\n\n全部初稿：\n${JSON.stringify(drafts.map((d) => ({ artifactId: d.artifactId, revision: d.revision, author: d.memberId, summary: d.payload.summary, claims: d.payload.claims })), null, 2)}\n\n全部互评：\n${JSON.stringify(reviews, null, 2)}\n\n讨论立场：\n${JSON.stringify(positions, null, 2)}\n\n你是主持者（${hostOf(roster)}），产出整合稿：共识入 claims、分歧如实入 disputedClaims。`;
  }
  // RATIFY
  const synthesis = currentSynthesisVersion(db, runId);
  if (synthesis == null) return `${base}\n（整合稿缺失）`;
  const claims = getSynthesisClaims(db, runId, synthesis.artifactId, synthesis.revision);
  return `${base}\n\n冻结整合稿（${synthesis.artifactId} rev${synthesis.revision}）结论清单：\n${JSON.stringify(claims.map((c) => ({ claimId: c.claim_id, statement: c.statement })), null, 2)}`;
}

function collectIssuePositions(db: ZhongshuoDatabase, runId: string): unknown {
  return db.prepare('SELECT issue_id, issue_revision, member_id, stance FROM positions WHERE issue_id IN (SELECT id FROM issues WHERE run_id = ?)').all(runId);
}

// ---------- 输出校验与计入屏障 ----------

export interface StepOutputResult {
  counted: boolean;
  needsRepair?: string;
  stageAdvanced?: boolean;
}

const STEP_SCHEMAS: Partial<Record<DelibStageCode, z.ZodTypeAny>> = {
  IND: analysisDraftPayloadSchema,
  CR: reviewPayloadSchema,
  ISS: issuePositionPayloadSchema,
  CHK: checkpointVerdictPayloadSchema,
  SYN: synthesisPayloadSchema,
  RAT: ratifyPayloadSchema,
};

/**
 * 步骤完成处理：schema 校验（IND/CR/RAT 含引用与覆盖校验）→ 发布成果（不可变）→
 * 计入屏障（参与者 completed / 立场 / 确认矩阵）→ 尝试推进。校验失败返回 needsRepair
 * （worker 决定一次格式修复或 OUTPUT_INVALID 终结）。
 */
export function onStepOutput(db: ZhongshuoDatabase, input: {
  taskId: string;
  runId: string;
  step: DelibStep;
  turnId: string;
  finalText: string;
  options: DeliberationOptions;
  now?: number;
}): DomainResult<StepOutputResult> {
  const now = input.now ?? Date.now();
  const schema = STEP_SCHEMAS[input.step.stage];
  if (schema == null) return domainErr('VALIDATION_INVALID', `未知研讨步骤 ${input.step.stage}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.finalText);
  } catch {
    return domainOk({ counted: false, needsRepair: '输出不是 JSON' });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return domainOk({ counted: false, needsRepair: result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  const payload = result.data as Record<string, unknown>;
  // 引用校验（CR：三元组属冻结可读版本）。
  if (input.step.stage === 'CR') {
    const drafts = frozenDrafts(db, input.runId);
    const claims = draftClaims(drafts);
    const reviews = (payload.reviews as Array<{ targetArtifactId: string; targetRevision: number; targetClaimId: string; stance: 'agree' | 'disagree' | 'needs_evidence' }>)
      .map((r) => ({ reviewerMemberId: input.step.memberId, target: { artifactId: r.targetArtifactId, artifactRevision: r.targetRevision, claimId: r.targetClaimId }, stance: r.stance }));
    const validated = validateClaimReferences(claims, reviews);
    if (!validated.ok) return domainOk({ counted: false, needsRepair: validated.error.message });
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId) as
    | { id: string; project_id: string; conversation_id: string; conversation_thread_id: string | null }
    | undefined;
  if (task == null) return domainErr('RESOURCE_NOT_FOUND', '任务不存在');
  const threadId = task.conversation_thread_id ?? '';
  const artifactId = `art_${input.turnId}`;
  const kind = input.step.stage === 'IND' ? 'analysis_draft'
    : input.step.stage === 'CR' ? 'cross_review'
      : input.step.stage === 'ISS' ? 'issue_position'
        : input.step.stage === 'CHK' ? 'checkpoint_verdict'
          : input.step.stage === 'SYN' ? 'synthesis'
            : 'ratify_response';
  const revision = input.step.stage === 'ISS' || input.step.stage === 'CHK' ? input.step.roundNo : 1;
  const published = publishDeliberationArtifact(db, {
    artifactId, projectId: task.project_id, conversationId: task.conversation_id, threadId,
    taskId: input.taskId, runId: input.runId, authorId: input.step.memberId,
    kind, revision, payload, blobDir: input.options.blobDir, now,
  });
  if (!published.ok) return domainErr(published.error.code, published.error.message);

  const tx = db.transaction(() => {
    db.prepare("UPDATE run_participants SET status = 'completed' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(input.runId, input.step.memberId);
    if (input.step.stage === 'ISS') {
      const positions = payload.positions as Array<{ issueId: string; stance: 'agree' | 'disagree' | 'needs_evidence' }>;
      for (const p of positions) {
        db.prepare(
          `INSERT INTO positions (issue_id, issue_revision, member_id, stance, conditions_json, source_artifact_id)
           VALUES (?, ?, ?, ?, NULL, ?)
           ON CONFLICT (issue_id, issue_revision, member_id) DO UPDATE SET stance = excluded.stance, source_artifact_id = excluded.source_artifact_id`,
        ).run(p.issueId, input.step.roundNo, input.step.memberId, p.stance, artifactId);
      }
    }
    if (input.step.stage === 'SYN') {
      const synthesisPayload = payload as unknown as { claims: Array<{ statement: string; sourceRefs: string[] }> };
      const claims = synthesisPayload.claims.map((c, i) => ({ claimId: `clm_${i + 1}`, statement: c.statement, sourceRefs: c.sourceRefs }));
      const inserted = insertSynthesisClaims(db, { runId: input.runId, synthesisArtifactId: artifactId, synthesisRevision: 1, claims });
      if (!inserted.ok) throw new Error(inserted.error.message);
      const roster = rosterOf(db, input.runId);
      initRatificationMatrix(db, {
        runId: input.runId, synthesisArtifactId: artifactId, synthesisRevision: 1,
        claimIds: claims.map((c) => c.claimId), memberIds: roster.members.map((m) => m.memberId), rosterRevision: roster.revision ?? 1,
      });
      advanceStage(db, input.runId, input.taskId, 'RATIFY', 0, now, { from: 'SYNTHESIS', reason: '整合稿冻结，进入确认', synthesisArtifactId: artifactId });
      const tx2members = roster.members.map((m: { memberId: string }) => m.memberId);
      for (const memberId of tx2members) {
        if (statusOf(participantsOf(db, input.runId), memberId) === 'absent') continue; // 缺席者不再派发确认
        enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId: input.taskId, stage: 'RAT', memberId, roundNo: 0, purpose: 'stage_work' }) });
      }
    }
    if (input.step.stage === 'RAT') {
      const synthesis = currentSynthesisVersion(db, input.runId);
      if (synthesis != null) {
        const responses = (payload.responses as Array<{ claimId: string; stance: 'confirm' | 'conditional' | 'object' | 'unconfirmed'; conditions?: string[]; reason?: string }>);
        const submitted = submitRatification(db, {
          runId: input.runId, synthesisArtifactId: synthesis.artifactId, synthesisRevision: synthesis.revision,
          memberId: input.step.memberId, turnId: input.turnId, responseArtifactId: artifactId,
          resultKey: `result_${input.turnId}`, responses, now,
        });
        if (!submitted.ok) throw new Error(`确认提交失败：${submitted.error.message}`);
      }
    }
  });
  try {
    tx();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return domainErr('STORAGE_UNAVAILABLE', message);
  }
  return domainOk({ counted: true });
}
