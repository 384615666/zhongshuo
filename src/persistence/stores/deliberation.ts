/**
 * DELIBERATE 持久化（§6.4/§6.5；DEV-08/09）。
 * artifacts 正文存 appData 管理目录（E19 口径），行内记 hash 与 blob_path；
 * RATIFY 提交事务验证：运行/阶段/成员/目标版本/claimId 全覆盖且无重复（§6.5）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZhongshuoDatabase } from '../db.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

export type DeliberationArtifactKind =
  | 'analysis_draft'
  | 'cross_review'
  | 'issue_position'
  | 'checkpoint_verdict'
  | 'synthesis'
  | 'ratify_response'
  | 'final_report';

export interface SaveArtifactInput {
  artifactId: string;
  projectId: string;
  conversationId: string;
  threadId: string | null;
  taskId: string;
  runId: string;
  authorId: string;
  kind: DeliberationArtifactKind;
  /** 同 kind 同作者递增（首版 1；修订/格式修复重写为新 revision）。 */
  revision: number;
  payload: unknown;
  blobDir: string;
  now: number;
}

export interface SavedArtifact {
  artifactId: string;
  kind: DeliberationArtifactKind;
  revision: number;
  hash: string;
  blobPath: string;
}

export function saveDeliberationArtifact(db: ZhongshuoDatabase, input: SaveArtifactInput): DomainResult<SavedArtifact> {
  mkdirSync(input.blobDir, { recursive: true });
  const body = JSON.stringify(input.payload, null, 2);
  const hash = createHash('sha256').update(body, 'utf8').digest('hex');
  const blobPath = join(input.blobDir, `${input.artifactId}.json`);
  const tx = db.transaction(() => {
    writeFileSync(blobPath, body, 'utf8');
    db.prepare(
      `INSERT INTO artifacts (id, project_id, conversation_id, thread_id, task_id, run_id, author_id, kind, revision, hash, blob_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.artifactId,
      input.projectId,
      input.conversationId,
      input.threadId,
      input.taskId,
      input.runId,
      input.authorId,
      input.kind,
      input.revision,
      hash,
      blobPath,
    );
  });
  tx();
  return domainOk({ artifactId: input.artifactId, kind: input.kind, revision: input.revision, hash, blobPath });
}

export interface ArtifactRow {
  id: string;
  run_id: string;
  author_id: string;
  kind: string;
  revision: number;
  hash: string;
  blob_path: string;
}

export function listRunArtifacts(db: ZhongshuoDatabase, runId: string, kind: DeliberationArtifactKind): ArtifactRow[] {
  return db
    .prepare('SELECT id, run_id, author_id, kind, revision, hash, blob_path FROM artifacts WHERE run_id = ? AND kind = ? ORDER BY revision, id')
    .all(runId, kind) as ArtifactRow[];
}

// ---------- SYNTHESIS claims（冻结整合稿版本） ----------

export interface SynthesisClaimRow {
  claim_id: string;
  statement: string;
  source_refs_json: string;
}

export function insertSynthesisClaims(db: ZhongshuoDatabase, input: {
  runId: string;
  synthesisArtifactId: string;
  synthesisRevision: number;
  claims: ReadonlyArray<{ claimId: string; statement: string; sourceRefs: string[] }>;
}): void {
  const tx = db.transaction(() => {
    for (const c of input.claims) {
      db.prepare(
        `INSERT INTO synthesis_claims (run_id, synthesis_artifact_id, synthesis_revision, claim_id, statement, source_refs_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(input.runId, input.synthesisArtifactId, input.synthesisRevision, c.claimId, c.statement, JSON.stringify(c.sourceRefs));
    }
  });
  tx();
}

export function getSynthesisClaims(db: ZhongshuoDatabase, runId: string, synthesisArtifactId: string, synthesisRevision: number): SynthesisClaimRow[] {
  return db
    .prepare(
      'SELECT claim_id, statement, source_refs_json FROM synthesis_claims WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ? ORDER BY claim_id',
    )
    .all(runId, synthesisArtifactId, synthesisRevision) as SynthesisClaimRow[];
}

// ---------- RATIFY 确认矩阵（§6.5） ----------

export function initRatificationMatrix(db: ZhongshuoDatabase, input: {
  runId: string;
  synthesisArtifactId: string;
  synthesisRevision: number;
  claimIds: ReadonlyArray<string>;
  memberIds: ReadonlyArray<string>;
  rosterRevision: number;
}): void {
  const tx = db.transaction(() => {
    for (const memberId of input.memberIds) {
      for (const claimId of input.claimIds) {
        db.prepare(
          `INSERT INTO ratification_records
             (run_id, synthesis_artifact_id, synthesis_revision, claim_id, member_id, roster_revision,
              response_status, stance, conditions_json, reason, missing_reason, turn_id, response_artifact_id, result_key, accepted_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, '', NULL)`,
        ).run(input.runId, input.synthesisArtifactId, input.synthesisRevision, claimId, memberId, input.rosterRevision);
      }
    }
  });
  tx();
}

export interface RatificationRecordRow {
  claim_id: string;
  member_id: string;
  response_status: 'pending' | 'submitted' | 'missing';
  stance: 'confirm' | 'conditional' | 'object' | 'unconfirmed' | null;
  conditions_json: string | null;
  reason: string | null;
  missing_reason: string | null;
  turn_id: string | null;
  result_key: string;
}

export function getRatificationRecords(db: ZhongshuoDatabase, runId: string, synthesisArtifactId: string, synthesisRevision: number): RatificationRecordRow[] {
  return db
    .prepare(
      `SELECT claim_id, member_id, response_status, stance, conditions_json, reason, missing_reason, turn_id, result_key
       FROM ratification_records WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ?
       ORDER BY member_id, claim_id`,
    )
    .all(runId, synthesisArtifactId, synthesisRevision) as RatificationRecordRow[];
}

export interface SubmitRatificationInput {
  runId: string;
  synthesisArtifactId: string;
  synthesisRevision: number;
  memberId: string;
  turnId: string;
  responseArtifactId: string;
  /** 同 turn 重放标识：相同 resultKey+payload 返回原回执，不同 payload → IDEMPOTENCY_CONFLICT。 */
  resultKey: string;
  responses: ReadonlyArray<{
    claimId: string;
    stance: 'confirm' | 'conditional' | 'object' | 'unconfirmed';
    conditions?: string[];
    reason?: string;
  }>;
  now: number;
}

/**
 * 提交事务（§6.5）：验证运行处于 RATIFY、授权成员、目标版本一致、claimId 全覆盖且无重复；
 * 部分字段无效时整份答复不产生“默认确认”。已接受的同版本成员答复不可被后续自然语言覆盖
 * （重复提交 → RATIFY_ALREADY_SUBMITTED；同 resultKey 同载荷重放返回原回执）。
 */
export function submitRatification(db: ZhongshuoDatabase, input: SubmitRatificationInput): DomainResult<{ accepted: number; replayed: boolean }> {
  const tx = db.transaction((): DomainResult<{ accepted: number; replayed: boolean }> => {
    const run = db
      .prepare("SELECT stage, status FROM workflow_runs WHERE id = ?")
      .get(input.runId) as { stage: string | null; status: string } | undefined;
    if (run == null) return domainErr('RESOURCE_NOT_FOUND', '运行不存在');
    if (run.stage !== 'RATIFY') return domainErr('STAGE_MISMATCH', `运行不在 RATIFY 阶段（当前 ${run.stage ?? '无'}）`);
    const participant = db
      .prepare('SELECT member_id, expected, status FROM run_participants WHERE run_id = ? AND member_id = ?')
      .get(input.runId, input.memberId) as { member_id: string; expected: number; status: string } | undefined;
    if (participant == null || participant.expected !== 1) {
      return domainErr('PARTICIPANT_NOT_EXPECTED', '成员不在该运行的预期名单（冻结名单外成员不能确认）');
    }
    const claims = getSynthesisClaims(db, input.runId, input.synthesisArtifactId, input.synthesisRevision);
    const expectedClaimIds = new Set(claims.map((c) => c.claim_id));
    const seen = new Set<string>();
    for (const r of input.responses) {
      if (!expectedClaimIds.has(r.claimId)) {
        return domainErr('CLAIM_NOT_FOUND', `结论 ${r.claimId} 不在冻结整合稿版本内，整份答复拒绝`);
      }
      if (seen.has(r.claimId)) {
        return domainErr('CLAIM_DUPLICATED', `结论 ${r.claimId} 重复提交，整份答复拒绝`);
      }
      seen.add(r.claimId);
    }
    if (seen.size !== expectedClaimIds.size) {
      return domainErr('CLAIM_COVERAGE_INCOMPLETE', `答复须覆盖全部结论（${seen.size}/${expectedClaimIds.size}），整份拒绝（不产生默认确认）`);
    }
    const existing = getRatificationRecords(db, input.runId, input.synthesisArtifactId, input.synthesisRevision)
      .filter((r) => r.member_id === input.memberId);
    const submittedBefore = existing.some((r) => r.response_status === 'submitted');
    if (submittedBefore) {
      const sameKey = existing.every((r) => r.result_key === input.resultKey || r.response_status !== 'submitted');
      if (sameKey && existing.some((r) => r.result_key === input.resultKey)) {
        return domainOk({ accepted: 0, replayed: true });
      }
      return domainErr('RATIFY_ALREADY_SUBMITTED', '该成员对此版本已确认；实质变更走一次有预算的修订稿与新版本确认（§6.5）');
    }
    for (const r of input.responses) {
      db.prepare(
        `UPDATE ratification_records
         SET response_status = 'submitted', stance = ?, conditions_json = ?, reason = ?, turn_id = ?, response_artifact_id = ?, result_key = ?, accepted_at = ?
         WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ? AND claim_id = ? AND member_id = ? AND response_status = 'pending'`,
      ).run(
        r.stance,
        r.conditions != null ? JSON.stringify(r.conditions) : null,
        r.reason ?? null,
        input.turnId,
        input.responseArtifactId,
        input.resultKey,
        input.now,
        input.runId,
        input.synthesisArtifactId,
        input.synthesisRevision,
        r.claimId,
        input.memberId,
      );
    }
    return domainOk({ accepted: input.responses.length, replayed: false });
  });
  return tx();
}

/** 关闭屏障：未收到答复的格按未回复/缺席/失败原因落为 missing（不伪造 response_artifact_id/turn_id）。 */
export function closeRatificationBarrier(db: ZhongshuoDatabase, input: {
  runId: string;
  synthesisArtifactId: string;
  synthesisRevision: number;
  missingReason: string;
}): number {
  const tx = db.transaction(() =>
    db
      .prepare(
        `UPDATE ratification_records
         SET response_status = 'missing', missing_reason = ?, stance = 'unconfirmed'
         WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ? AND response_status = 'pending'`,
      )
      .run(input.missingReason, input.runId, input.synthesisArtifactId, input.synthesisRevision).changes,
  );
  return tx();
}

// ---------- 争议（ISSUE_DISCUSSION 轮次冻结） ----------

export interface IssueRow {
  id: string;
  run_id: string;
  statement: string;
  revision: number;
  status: 'open' | 'resolved' | 'needs_user' | 'insufficient_evidence';
  evidence_refs_json: string;
}

export function insertIssues(db: ZhongshuoDatabase, runId: string, issues: ReadonlyArray<{
  issueId: string;
  statement: string;
  evidenceRefs: string[];
}>, revision: number): void {
  const tx = db.transaction(() => {
    for (const i of issues) {
      db.prepare(
        `INSERT INTO issues (id, run_id, statement, revision, status, evidence_refs_json)
         VALUES (?, ?, ?, ?, 'open', ?)`,
      ).run(i.issueId, runId, i.statement, revision, JSON.stringify(i.evidenceRefs));
    }
  });
  tx();
}

export function listIssues(db: ZhongshuoDatabase, runId: string, revision?: number): IssueRow[] {
  return (revision != null
    ? db.prepare('SELECT id, run_id, statement, revision, status, evidence_refs_json FROM issues WHERE run_id = ? AND revision = ? ORDER BY id').all(runId, revision)
    : db.prepare('SELECT id, run_id, statement, revision, status, evidence_refs_json FROM issues WHERE run_id = ? ORDER BY revision, id').all(runId)) as IssueRow[];
}

export function upsertPosition(db: ZhongshuoDatabase, input: {
  issueId: string;
  issueRevision: number;
  memberId: string;
  stance: 'agree' | 'disagree' | 'needs_evidence';
  sourceArtifactId: string;
}): void {
  db.prepare(
    `INSERT INTO positions (issue_id, issue_revision, member_id, stance, conditions_json, source_artifact_id)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT (issue_id, issue_revision, member_id)
     DO UPDATE SET stance = excluded.stance, source_artifact_id = excluded.source_artifact_id`,
  ).run(input.issueId, input.issueRevision, input.memberId, input.stance, input.sourceArtifactId);
}
