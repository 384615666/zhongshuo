/**
 * DELIBERATE 持久化（§6.4/§6.5；DEV-08/09 + M1 修复轮）。
 *
 * 成果发布协议（修复轮）：不可变成果版本——临时文件写入 → 事务 INSERT → 发布
 * （rename）；数据库失败删除临时文件回滚；同 ID 同内容幂等、同 ID 异内容冲突
 * （已提交成果不可覆盖）；正文缺失/不一致可核对与恢复。见 publishDeliberationArtifact。
 *
 * RATIFY 提交事务（§6.5 + 修复轮）：同 resultKey 同规范化载荷=重放原回执，异载荷
 * =IDEMPOTENCY_CONFLICT；提交前核对运行有效/阶段/turn 归属/当前冻结版本/成员在
 * 冻结范围/claim 全覆盖且无重复；conditional 必须有非空条件、object/unconfirmed
 * 必须有原因；所有更新核对实际影响行数，矩阵不存在/已关闭/零行更新不得计 accepted。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZhongshuoDatabase } from '../db.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 规范化 JSON：键序稳定 + 无多余空白——幂等比较与 hash 的唯一口径。 */
export function canonicalJson(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v != null && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(stable(value));
}

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
  /** 同 kind 同作者递增（首版 1；修订/格式修复为新版本新 ID，不覆盖旧版）。 */
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
  /** true = 已存在同 ID 同内容行，幂等返回（未重复写入）。 */
  idempotentReplay: boolean;
}

/** 测试注入点：关键写入步骤中断反例（数据库插入前/发布改名前）。 */
export interface PublishHooks {
  onBeforeInsert?: () => void;
  onBeforeRename?: () => void;
}

/**
 * 发布成果（修复轮协议）：
 * 1. 已存在同 ID：核对磁盘正文与行内 hash——同内容幂等返回；异内容 ARTIFACT_CONFLICT
 *    （不可覆盖已提交成果）；正文缺失/不一致 → INTEGRITY 错误（可恢复，不静默重写）。
 * 2. 新成果：写临时文件 → 事务 INSERT → rename 发布；数据库失败删临时回滚；
 *    rename 前中断 → 行未落库、临时文件可清理；rename 后中断可由
 *    verifyArtifactIntegrity 识别并由 repairArtifactBody 恢复。
 */
export function publishDeliberationArtifact(db: ZhongshuoDatabase, input: SaveArtifactInput, hooks?: PublishHooks): DomainResult<SavedArtifact> {
  mkdirSync(input.blobDir, { recursive: true });
  const body = canonicalJson(input.payload);
  const hash = sha256Of(body);
  const finalPath = join(input.blobDir, `${input.artifactId}.json`);

  const existing = db
    .prepare('SELECT id, kind, revision, hash, blob_path FROM artifacts WHERE id = ?')
    .get(input.artifactId) as { id: string; kind: string; revision: number; hash: string; blob_path: string } | undefined;
  if (existing != null) {
    if (!existsSync(existing.blob_path)) {
      return domainErr('ARTIFACT_BODY_MISSING', `成果 ${input.artifactId} 的正文缺失（blob ${existing.blob_path}）；先恢复再操作`);
    }
    const diskHash = sha256Of(readFileSync(existing.blob_path, 'utf8'));
    if (diskHash !== existing.hash) {
      return domainErr('ARTIFACT_BODY_MISMATCH', `成果 ${input.artifactId} 磁盘正文与记录 hash 不一致；需人工/恢复流程核对`);
    }
    if (hash !== existing.hash) {
      return domainErr('ARTIFACT_CONFLICT', `成果 ${input.artifactId} 已提交且内容不同（不可变版本，修订须用新 ID/新版本）`);
    }
    return domainOk({ artifactId: existing.id, kind: existing.kind as DeliberationArtifactKind, revision: existing.revision, hash: existing.hash, blobPath: existing.blob_path, idempotentReplay: true });
  }
  if (existsSync(finalPath)) {
    return domainErr('ARTIFACT_CONFLICT', `成果正文 ${finalPath} 已存在但无数据库记录（孤儿文件）；需核对来源后清理`);
  }

  const tempPath = join(input.blobDir, `.tmp-${input.artifactId}-${randomUUID().slice(0, 8)}.json`);
  writeFileSync(tempPath, body, 'utf8');
  try {
    hooks?.onBeforeInsert?.();
  } catch (error) {
    // 中断语义（INSERT 前）：行未写入、临时文件保留（孤儿可识别）。
    const message = error instanceof Error ? error.message : String(error);
    return domainErr('STORAGE_UNAVAILABLE', `成果 ${input.artifactId} 在数据库写入前中断：${message}（行未入库，临时文件待清理）`);
  }
  try {
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
      finalPath,
    );
  } catch (error) {
    rmSync(tempPath, { force: true }); // 数据库失败：临时文件随回滚清理
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed: artifacts.id')) {
      return domainErr('ARTIFACT_CONFLICT', `成果 ${input.artifactId} 并发已提交（唯一键冲突）`);
    }
    return domainErr('STORAGE_UNAVAILABLE', `成果 ${input.artifactId} 数据库写入失败：${message}`);
  }
  try {
    hooks?.onBeforeRename?.();
    renameSync(tempPath, finalPath); // 发布：原子改名（同目录）
  } catch (error) {
    // 行已落库但正文未发布：保留临时文件供恢复（repairArtifactBody）。
    const message = error instanceof Error ? error.message : String(error);
    return domainErr('ARTIFACT_BODY_MISSING', `成果 ${input.artifactId} 发布失败（行已入库、正文在临时文件）：${message}`);
  }
  return domainOk({ artifactId: input.artifactId, kind: input.kind, revision: input.revision, hash, blobPath: finalPath, idempotentReplay: false });
}

/** 兼容旧调用（保存语义=发布语义）。 */
export function saveDeliberationArtifact(db: ZhongshuoDatabase, input: SaveArtifactInput): DomainResult<SavedArtifact> {
  return publishDeliberationArtifact(db, input);
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

export function getArtifact(db: ZhongshuoDatabase, artifactId: string): ArtifactRow | undefined {
  return db.prepare('SELECT id, run_id, author_id, kind, revision, hash, blob_path FROM artifacts WHERE id = ?').get(artifactId) as ArtifactRow | undefined;
}

export interface IntegrityReport {
  artifactId: string;
  ok: boolean;
  problem?: 'body_missing' | 'hash_mismatch';
}

/** 核对“数据库引用-磁盘正文-hash”一致性；blobDir 给出时同时列出孤儿/残留临时文件。 */
export function verifyArtifactIntegrity(db: ZhongshuoDatabase, options: { runId?: string; blobDir?: string }): {
  rows: IntegrityReport[];
  orphanFiles: string[];
} {
  const rows = options.runId != null
    ? (db.prepare('SELECT id, hash, blob_path FROM artifacts WHERE run_id = ?').all(options.runId) as Array<{ id: string; hash: string; blob_path: string }>)
    : (db.prepare('SELECT id, hash, blob_path FROM artifacts').all() as Array<{ id: string; hash: string; blob_path: string }>);
  const reports = rows.map((r) => {
    if (!existsSync(r.blob_path)) return { artifactId: r.id, ok: false, problem: 'body_missing' as const };
    const disk = sha256Of(readFileSync(r.blob_path, 'utf8'));
    return disk === r.hash ? { artifactId: r.id, ok: true } : { artifactId: r.id, ok: false, problem: 'hash_mismatch' as const };
  });
  const orphanFiles: string[] = [];
  if (options.blobDir != null && existsSync(options.blobDir)) {
    const known = new Set(rows.map((r) => r.blob_path));
    for (const name of readdirSync(options.blobDir)) {
      const full = join(options.blobDir, name);
      if (!known.has(full)) orphanFiles.push(full);
    }
  }
  return { rows: reports, orphanFiles };
}

/** 恢复：按期望载荷修复缺失正文，并复核与记录 hash 一致（不一致=恢复载荷错误，拒绝）。 */
export function repairArtifactBody(db: ZhongshuoDatabase, artifactId: string, expectedPayload: unknown): DomainResult<{ restored: boolean }> {
  const row = getArtifact(db, artifactId);
  if (row == null) return domainErr('RESOURCE_NOT_FOUND', `成果 ${artifactId} 无数据库记录`);
  const body = canonicalJson(expectedPayload);
  const hash = sha256Of(body);
  if (hash !== row.hash) {
    return domainErr('ARTIFACT_CONFLICT', `恢复载荷与记录 hash 不一致（${artifactId}）：期望内容不是该版本`);
  }
  if (!existsSync(row.blob_path)) writeFileSync(row.blob_path, body, 'utf8');
  return domainOk({ restored: true });
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
}): DomainResult<{ inserted: number }> {
  const tx = db.transaction((): DomainResult<{ inserted: number }> => {
    for (const c of input.claims) {
      try {
        db.prepare(
          `INSERT INTO synthesis_claims (run_id, synthesis_artifact_id, synthesis_revision, claim_id, statement, source_refs_json)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(input.runId, input.synthesisArtifactId, input.synthesisRevision, c.claimId, c.statement, canonicalJson(c.sourceRefs));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('UNIQUE constraint failed')) {
          return domainErr('ARTIFACT_CONFLICT', `整合结论 (${input.synthesisArtifactId}#${c.claimId}) 已冻结，不可重复插入`);
        }
        return domainErr('STORAGE_UNAVAILABLE', message);
      }
    }
    return domainOk({ inserted: input.claims.length });
  });
  return tx();
}

export function getSynthesisClaims(db: ZhongshuoDatabase, runId: string, synthesisArtifactId: string, synthesisRevision: number): SynthesisClaimRow[] {
  return db
    .prepare(
      'SELECT claim_id, statement, source_refs_json FROM synthesis_claims WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ? ORDER BY claim_id',
    )
    .all(runId, synthesisArtifactId, synthesisRevision) as SynthesisClaimRow[];
}

/** 当前冻结整合稿版本：run 最新（revision 最大）的 synthesis 成果。 */
export function currentSynthesisVersion(db: ZhongshuoDatabase, runId: string): { artifactId: string; revision: number } | null {
  const row = db
    .prepare("SELECT id, MAX(revision) AS revision FROM artifacts WHERE run_id = ? AND kind = 'synthesis'")
    .get(runId) as { id: string | null; revision: number | null };
  return row.id != null ? { artifactId: row.id, revision: row.revision ?? 1 } : null;
}

// ---------- RATIFY 确认矩阵（§6.5） ----------

export function initRatificationMatrix(db: ZhongshuoDatabase, input: {
  runId: string;
  synthesisArtifactId: string;
  synthesisRevision: number;
  claimIds: ReadonlyArray<string>;
  memberIds: ReadonlyArray<string>;
  rosterRevision: number;
}): DomainResult<{ cells: number }> {
  const existing = getRatificationRecords(db, input.runId, input.synthesisArtifactId, input.synthesisRevision);
  if (existing.length > 0) {
    return domainErr('ARTIFACT_CONFLICT', '该整合稿版本的确认矩阵已初始化（不可重复初始化）');
  }
  const tx = db.transaction(() => {
    for (const memberId of input.memberIds) {
      for (const claimId of input.claimIds) {
        db.prepare(
          `INSERT INTO ratification_records
             (run_id, synthesis_artifact_id, synthesis_revision, claim_id, member_id, roster_revision,
              response_status, stance, conditions_json, reason, missing_reason, turn_id, response_artifact_id, result_key, accepted_at, payload_hash)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, '', NULL, NULL)`,
        ).run(input.runId, input.synthesisArtifactId, input.synthesisRevision, claimId, memberId, input.rosterRevision);
      }
    }
  });
  tx();
  return domainOk({ cells: input.claimIds.length * input.memberIds.length });
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
  response_artifact_id: string | null;
  result_key: string;
  payload_hash: string | null;
}

export function getRatificationRecords(db: ZhongshuoDatabase, runId: string, synthesisArtifactId: string, synthesisRevision: number): RatificationRecordRow[] {
  return db
    .prepare(
      `SELECT claim_id, member_id, response_status, stance, conditions_json, reason, missing_reason, turn_id, response_artifact_id, result_key, payload_hash
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
  /** 提交来源 turn：必须属于该 run 且为该成员的 turn（不信自报）。 */
  turnId: string;
  responseArtifactId: string;
  resultKey: string;
  responses: ReadonlyArray<{
    claimId: string;
    stance: 'confirm' | 'conditional' | 'object' | 'unconfirmed';
    conditions?: string[];
    reason?: string;
  }>;
  now: number;
}

function normalizeRatifyPayload(input: SubmitRatificationInput): string {
  // 规范化载荷：claim 覆盖集 + 立场 + 条件/理由（键序/空白稳定；不含 turn/时间等执行细节）。
  return canonicalJson(
    input.responses
      .map((r) => ({ claimId: r.claimId, stance: r.stance, conditions: r.conditions ?? [], reason: (r.reason ?? '').trim() }))
      .sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0)),
  );
}

/**
 * 提交事务（§6.5 + 修复轮）。前置核对：运行存在且未停止/终结、阶段=RATIFY、turn 归属
 * run+成员、目标=当前冻结整合稿版本、成员在冻结名单、claim 全覆盖且无重复、
 * conditional 非空条件、object/unconfirmed 非空原因。幂等：同 resultKey 同规范化
 * 载荷=重放原回执；异载荷=IDEMPOTENCY_CONFLICT。矩阵为空/已关闭/更新零行 → 明确错误，
 * 不计 accepted。
 */
export function submitRatification(db: ZhongshuoDatabase, input: SubmitRatificationInput): DomainResult<{ accepted: number; replayed: boolean }> {
  const payloadHash = sha256Of(normalizeRatifyPayload(input));
  const tx = db.transaction((): DomainResult<{ accepted: number; replayed: boolean }> => {
    const run = db
      .prepare('SELECT stage, status FROM workflow_runs WHERE id = ?')
      .get(input.runId) as { stage: string | null; status: string } | undefined;
    if (run == null) return domainErr('RESOURCE_NOT_FOUND', '运行不存在');
    if (['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'STOPPING'].includes(run.status)) {
      return domainErr('STALE_EXECUTION', `运行已停止/终结（${run.status}），不接受确认提交`);
    }
    if (run.stage !== 'RATIFY') return domainErr('STAGE_MISMATCH', `运行不在 RATIFY 阶段（当前 ${run.stage ?? '无'}）`);
    const turn = db
      .prepare('SELECT run_id, member_id FROM agent_turns WHERE id = ?')
      .get(input.turnId) as { run_id: string; member_id: string } | undefined;
    if (turn == null || turn.run_id !== input.runId || turn.member_id !== input.memberId) {
      return domainErr('TARGET_KIND_MISMATCH', `turn ${input.turnId} 不属于该运行/成员，拒绝提交`);
    }
    const participant = db
      .prepare('SELECT member_id, expected, status FROM run_participants WHERE run_id = ? AND member_id = ?')
      .get(input.runId, input.memberId) as { member_id: string; expected: number; status: string } | undefined;
    if (participant == null || participant.expected !== 1) {
      return domainErr('PARTICIPANT_NOT_EXPECTED', '成员不在该运行的预期名单（冻结名单外成员不能确认）');
    }
    const current = currentSynthesisVersion(db, input.runId);
    if (current == null || current.artifactId !== input.synthesisArtifactId || current.revision !== input.synthesisRevision) {
      return domainErr('STALE_REVISION', `目标整合稿版本不是当前冻结版本（当前 ${current?.artifactId ?? '无'}#${current?.revision ?? '-'}）`);
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
      if (r.stance === 'conditional' && (r.conditions == null || r.conditions.filter((c) => c.trim().length > 0).length === 0)) {
        return domainErr('VALIDATION_INVALID', `结论 ${r.claimId} 的 conditional 必须有非空条件`);
      }
      if ((r.stance === 'object' || r.stance === 'unconfirmed') && (r.reason == null || r.reason.trim().length === 0)) {
        return domainErr('VALIDATION_INVALID', `结论 ${r.claimId} 的 ${r.stance} 必须有非空原因`);
      }
    }
    if (seen.size !== expectedClaimIds.size) {
      return domainErr('CLAIM_COVERAGE_INCOMPLETE', `答复须覆盖全部结论（${seen.size}/${expectedClaimIds.size}），整份拒绝（不产生默认确认）`);
    }
    const records = getRatificationRecords(db, input.runId, input.synthesisArtifactId, input.synthesisRevision);
    const mine = records.filter((r) => r.member_id === input.memberId);
    if (mine.length === 0) {
      return domainErr('RESOURCE_NOT_FOUND', '确认矩阵不存在（未初始化或目标版本过期）');
    }
    const submitted = mine.filter((r) => r.response_status === 'submitted');
    if (submitted.length > 0) {
      if (submitted.some((r) => r.result_key === input.resultKey)) {
        // 重放判定：同 resultKey 且规范化载荷一致 → 原回执；不一致 → 明确冲突。
        const samePayload = submitted.every((r) => r.payload_hash === payloadHash || r.payload_hash == null);
        if (samePayload) return domainOk({ accepted: 0, replayed: true });
        return domainErr('IDEMPOTENCY_CONFLICT', '同 resultKey 但载荷不同：确认内容不可静默修改（实质变更走修订稿）');
      }
      return domainErr('RATIFY_ALREADY_SUBMITTED', '该成员对此版本已确认；实质变更走一次有预算的修订稿与新版本确认（§6.5）');
    }
    if (mine.every((r) => r.response_status === 'missing')) {
      return domainErr('STALE_EXECUTION', '确认屏障已关闭（矩阵落 missing），迟到答复不并入本版本');
    }
    let accepted = 0;
    for (const r of input.responses) {
      const changes = db
        .prepare(
          `UPDATE ratification_records
           SET response_status = 'submitted', stance = ?, conditions_json = ?, reason = ?, turn_id = ?, response_artifact_id = ?, result_key = ?, accepted_at = ?, payload_hash = ?
           WHERE run_id = ? AND synthesis_artifact_id = ? AND synthesis_revision = ? AND claim_id = ? AND member_id = ? AND response_status = 'pending'`,
        )
        .run(
          r.stance,
          r.conditions != null ? canonicalJson(r.conditions) : null,
          r.reason ?? null,
          input.turnId,
          input.responseArtifactId,
          input.resultKey,
          input.now,
          payloadHash,
          input.runId,
          input.synthesisArtifactId,
          input.synthesisRevision,
          r.claimId,
          input.memberId,
        ).changes;
      if (changes !== 1) {
        throw new StoreInvariantError(`结论 ${r.claimId} 更新行数异常（${changes}），事务回滚`);
      }
      accepted += changes;
    }
    if (accepted !== input.responses.length) {
      throw new StoreInvariantError(`接受数 ${accepted} ≠ 提交数 ${input.responses.length}，事务回滚`);
    }
    return domainOk({ accepted, replayed: false });
  });
  try {
    return tx();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return domainErr('STORAGE_UNAVAILABLE', `确认提交事务失败（已回滚）：${message}`);
  }
}

class StoreInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreInvariantError';
  }
}

/** 关闭屏障：未收到答复的格按原因落 missing（程序记录，不伪造 stance/turn_id——与模型显式 unconfirmed 分开）。 */
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
         SET response_status = 'missing', missing_reason = ?
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
}>, revision: number): DomainResult<{ inserted: number }> {
  const tx = db.transaction((): DomainResult<{ inserted: number }> => {
    for (const i of issues) {
      try {
        db.prepare(
          `INSERT INTO issues (id, run_id, statement, revision, status, evidence_refs_json)
           VALUES (?, ?, ?, ?, 'open', ?)`,
        ).run(i.issueId, runId, i.statement, revision, canonicalJson(i.evidenceRefs));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('UNIQUE constraint failed')) {
          return domainErr('ARTIFACT_CONFLICT', `争议 ${i.issueId} 已存在于该 revision（不可重复插入）`);
        }
        return domainErr('STORAGE_UNAVAILABLE', message);
      }
    }
    return domainOk({ inserted: issues.length });
  });
  return tx();
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
