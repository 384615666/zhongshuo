/**
 * DELIBERATE 持久化集成（§6.5 + M1 修复轮）：
 * 成果发布协议（幂等/冲突/中断反例/完整性核对/恢复）、RATIFY 提交全前置核对与幂等。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import {
  closeRatificationBarrier,
  getRatificationRecords,
  getSynthesisClaims,
  initRatificationMatrix,
  insertSynthesisClaims,
  listRunArtifacts,
  publishDeliberationArtifact,
  repairArtifactBody,
  submitRatification,
  verifyArtifactIntegrity,
} from '../../src/persistence/stores/deliberation.ts';
import { aggregateClaimConsensus } from '../../src/domain/deliberation/stageMachine.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-delib2-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function seed(db: ZhongshuoDatabase): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('m1','p1','甲','agent',1), ('m2','p1','乙','agent',1), ('m3','p1','丙','human',1)`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m1')`).run();
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
  db.prepare(`INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id) VALUES ('th1','p1','c1','r1','msg1')`).run();
  db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at) VALUES ('msg1','p1','c1',1,'r1','human','m3','{"text":"研讨任务"}','saved',0)`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, root_message_id, room_task_number, title, status, revision, review_policy) VALUES ('tk1','p1','c1','room_task','r1','th1','msg1',1,'研讨','ACTIVE',0,'auto_deliver')`).run();
  db.prepare(`INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, status, stage) VALUES ('run1','tk1','c1','th1','DELIBERATE','RUNNING','RATIFY')`).run();
  db.prepare(`INSERT INTO run_participants (run_id, member_id, role, expected, status) VALUES ('run1','m1','host',1,'completed'), ('run1','m2','member',1,'pending')`).run();
}

let blobDir: string;
function freshDir(): string {
  blobDir = mkdtempSync(join(tmpRoot, 'art-'));
  return blobDir;
}

const draftPayload = (summary: string) => ({
  schemaVersion: 'analysis-draft-v1',
  summary,
  claims: [{ claimId: 'c1', statement: '结论', kind: 'observed' as const, evidenceIds: ['ev1'] }],
  recommendations: [],
  openQuestions: [],
});

describe('成果发布协议（修复轮：不可变版本 + 失败恢复）', () => {
  it('正常发布：行与磁盘正文一致；同 ID 同内容幂等（不重复写入）', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    const payload = draftPayload('初稿');
    const r1 = publishDeliberationArtifact(db, { artifactId: 'art_1', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'analysis_draft', revision: 1, payload, blobDir, now: 1 });
    expect(r1.ok).toBe(true);
    const r2 = publishDeliberationArtifact(db, { artifactId: 'art_1', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'analysis_draft', revision: 1, payload: draftPayload('初稿'), blobDir, now: 2 });
    expect(r2.ok).toBe(true);
    expect((r2 as { value: { idempotentReplay: boolean } }).value.idempotentReplay).toBe(true);
    expect(listRunArtifacts(db, 'run1', 'analysis_draft')).toHaveLength(1);
    const row = listRunArtifacts(db, 'run1', 'analysis_draft')[0]!;
    expect(existsSync(row.blob_path)).toBe(true);
    db.close();
  });

  it('重复 ID 不同正文 → 冲突（已提交成果不可覆盖），磁盘与行不变', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    publishDeliberationArtifact(db, { artifactId: 'art_2', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'analysis_draft', revision: 1, payload: draftPayload('v1'), blobDir, now: 1 });
    const before = readFileSync(join(blobDir, 'art_2.json'), 'utf8');
    const r = publishDeliberationArtifact(db, { artifactId: 'art_2', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'analysis_draft', revision: 1, payload: draftPayload('v2-不同'), blobDir, now: 2 });
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('ARTIFACT_CONFLICT');
    expect(readFileSync(join(blobDir, 'art_2.json'), 'utf8')).toBe(before);
    db.close();
  });

  it('数据库写入失败 → 临时文件清理、无新行残留（文件不领先于数据库）', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    // 在临时文件写入后、INSERT 前注入同 ID 冲突行 → 数据库写入失败路径。
    let hookRan = false;
    const r = publishDeliberationArtifact(db, { artifactId: 'art_3', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'analysis_draft', revision: 1, payload: draftPayload('x'), blobDir, now: 1 }, {
      onBeforeInsert: () => {
        hookRan = true;
        db.prepare(`INSERT INTO artifacts (id, project_id, author_id, kind, revision, hash, blob_path, run_id, task_id) VALUES ('art_3','p1','m1','other',1,'otherhash','${join(blobDir, 'other.json').replaceAll('\\', '/')}','run1','tk1')`).run();
      },
    });
    expect(hookRan).toBe(true);
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('ARTIFACT_CONFLICT');
    expect(readdirSync(blobDir).filter((f) => f.startsWith('.tmp-art_3'))).toHaveLength(0); // 临时文件已清理
    db.close();
  });

  it('rename 前中断 → 行已入库但正文缺失：完整性校验发现 + repairArtifactBody 恢复', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    const payload = draftPayload('中断测试');
    const r = publishDeliberationArtifact(db, { artifactId: 'art_4', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'analysis_draft', revision: 1, payload, blobDir, now: 1 }, {
      onBeforeRename: () => { throw new Error('simulated rename failure'); },
    });
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('ARTIFACT_BODY_MISSING');
    expect(existsSync(join(blobDir, 'art_4.json'))).toBe(false);
    const report = verifyArtifactIntegrity(db, { runId: 'run1', blobDir });
    const bad = report.rows.find((x) => x.artifactId === 'art_4');
    expect(bad).toMatchObject({ ok: false, problem: 'body_missing' });
    const repaired = repairArtifactBody(db, 'art_4', payload);
    expect(repaired.ok).toBe(true);
    expect(verifyArtifactIntegrity(db, { runId: 'run1' }).rows.find((x) => x.artifactId === 'art_4')!.ok).toBe(true);
    db.close();
  });

  it('insert 前中断 → 无行无正文，临时文件可核对（孤儿识别）', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    const r = publishDeliberationArtifact(db, { artifactId: 'art_5', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'analysis_draft', revision: 1, payload: draftPayload('y'), blobDir, now: 1 }, {
      onBeforeInsert: () => { throw new Error('simulated insert failure'); },
    });
    expect(r.ok).toBe(false);
    expect((r as { error: { code: string } }).error.code).toBe('STORAGE_UNAVAILABLE');
    expect(listRunArtifacts(db, 'run1', 'analysis_draft').find((x) => x.id === 'art_5')).toBeUndefined();
    const report = verifyArtifactIntegrity(db, { blobDir });
    expect(report.orphanFiles.some((f) => f.includes('.tmp-art_5'))).toBe(true);
    db.close();
  });

  it('磁盘正文被篡改 → hash 不一致可检出（不静默重写）', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    publishDeliberationArtifact(db, { artifactId: 'art_6', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'analysis_draft', revision: 1, payload: draftPayload('z'), blobDir, now: 1 });
    writeFileSync(join(blobDir, 'art_6.json'), '{"tampered":true}', 'utf8');
    const report = verifyArtifactIntegrity(db, { runId: 'run1' });
    expect(report.rows.find((x) => x.artifactId === 'art_6')).toMatchObject({ ok: false, problem: 'hash_mismatch' });
    db.close();
  });
});

describe('RATIFY 确认矩阵（§6.5 提交事务 + 修复轮幂等/行数核对）', () => {
  function prepared(db: ZhongshuoDatabase): void {
    publishDeliberationArtifact(db, { artifactId: 'art_syn', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'synthesis', revision: 1, payload: { schemaVersion: 'synthesis-v1' }, blobDir, now: 1 });
    insertSynthesisClaims(db, {
      runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1,
      claims: [
        { claimId: 'clm_1', statement: '结论一', sourceRefs: ['c1'] },
        { claimId: 'clm_2', statement: '结论二', sourceRefs: ['c2'] },
      ],
    });
    initRatificationMatrix(db, { runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, claimIds: ['clm_1', 'clm_2'], memberIds: ['m1', 'm2'], rosterRevision: 1 });
    // 成员各自的 RATIFY turn（提交须核对 turn 归属 run+成员）。
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status) VALUES ('turn_m1','run1','c1','th1','m1','ratify','SUCCEEDED'), ('turn_m2','run1','c1','th1','m2','ratify','SUCCEEDED'), ('turn_other','run1','c1','th1','m1','other','SUCCEEDED')`).run();
  }

  const base = { runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, memberId: 'm1', turnId: 'turn_m1', responseArtifactId: 'art_r1', now: 10 } as const;

  it('合法完整提交：accepted=2、每格落 submitted；同键同（规范化）载荷重放返回原回执', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    prepared(db);
    const responses = [
      { claimId: 'clm_1', stance: 'confirm' as const },
      { claimId: 'clm_2', stance: 'conditional' as const, conditions: ['补充验证 X'] },
    ];
    const submit = submitRatification(db, { ...base, resultKey: 'rk-1', responses });
    expect(submit.ok).toBe(true);
    expect((submit as { value: { accepted: number } }).value.accepted).toBe(2);
    const replay = submitRatification(db, { ...base, resultKey: 'rk-1', now: 11, responses: [
      { claimId: 'clm_2', stance: 'conditional', conditions: ['补充验证 X'] },
      { claimId: 'clm_1', stance: 'confirm' }, // 顺序不同=规范化后相同 → 仍重放
    ] });
    expect(replay.ok).toBe(true);
    expect((replay as { value: { replayed: boolean } }).value.replayed).toBe(true);
    db.close();
  });

  it('同键异载荷 → IDEMPOTENCY_CONFLICT（不静默当成功重放）', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    prepared(db);
    submitRatification(db, { ...base, resultKey: 'rk-1', responses: [
      { claimId: 'clm_1', stance: 'confirm' },
      { claimId: 'clm_2', stance: 'confirm' },
    ] });
    const conflict = submitRatification(db, { ...base, resultKey: 'rk-1', responses: [
      { claimId: 'clm_1', stance: 'object', reason: '改主意' },
      { claimId: 'clm_2', stance: 'confirm' },
    ] });
    expect(conflict.ok).toBe(false);
    expect((conflict as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
    db.close();
  });

  it('停止后提交 / 阶段不符 / 错误 turn / 非预期成员 → 拒绝且矩阵不动', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    prepared(db);
    const full = [
      { claimId: 'clm_1', stance: 'confirm' as const },
      { claimId: 'clm_2', stance: 'confirm' as const },
    ];
    db.prepare("UPDATE workflow_runs SET status = 'STOPPING' WHERE id = 'run1'").run();
    const stopped = submitRatification(db, { ...base, resultKey: 'rk-s', responses: full });
    expect((stopped as { error: { code: string } }).error.code).toBe('STALE_EXECUTION');
    db.prepare("UPDATE workflow_runs SET status = 'RUNNING', stage = 'SYNTHESIS' WHERE id = 'run1'").run();
    const wrongStage = submitRatification(db, { ...base, resultKey: 'rk-s', responses: full });
    expect((wrongStage as { error: { code: string } }).error.code).toBe('STAGE_MISMATCH');
    db.prepare("UPDATE workflow_runs SET stage = 'RATIFY' WHERE id = 'run1'").run();
    const wrongTurn = submitRatification(db, { ...base, turnId: 'turn_m2', resultKey: 'rk-s', responses: full });
    expect((wrongTurn as { error: { code: string } }).error.code).toBe('TARGET_KIND_MISMATCH');
    // 名单外成员用自己的 turn 提交 → PARTICIPANT_NOT_EXPECTED（先过 turn 归属核对）。
    db.prepare(`INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, status) VALUES ('turn_m3','run1','c1','th1','m3','ratify','SUCCEEDED')`).run();
    const outsider = submitRatification(db, { ...base, memberId: 'm3', turnId: 'turn_m3', resultKey: 'rk-s', responses: full });
    expect((outsider as { error: { code: string } }).error.code).toBe('PARTICIPANT_NOT_EXPECTED');
    expect(getRatificationRecords(db, 'run1', 'art_syn', 1).every((r) => r.response_status === 'pending')).toBe(true);
    db.close();
  });

  it('旧稿版本提交 → STALE_REVISION；空矩阵 → RESOURCE_NOT_FOUND', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    prepared(db);
    const full = [
      { claimId: 'clm_1', stance: 'confirm' as const },
      { claimId: 'clm_2', stance: 'confirm' as const },
    ];
    publishDeliberationArtifact(db, { artifactId: 'art_syn2', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1', authorId: 'm1', kind: 'synthesis', revision: 2, payload: { schemaVersion: 'synthesis-v1', v: 2 }, blobDir, now: 2 });
    insertSynthesisClaims(db, { runId: 'run1', synthesisArtifactId: 'art_syn2', synthesisRevision: 2, claims: [{ claimId: 'clm_1', statement: '修订结论', sourceRefs: [] }] });
    const stale = submitRatification(db, { ...base, resultKey: 'rk-old', responses: full });
    expect((stale as { error: { code: string } }).error.code).toBe('STALE_REVISION');
    const noMatrix = submitRatification(db, { runId: 'run1', synthesisArtifactId: 'art_syn2', synthesisRevision: 2, memberId: 'm1', turnId: 'turn_m1', responseArtifactId: 'a', resultKey: 'rk-nm', now: 1, responses: [{ claimId: 'clm_1', stance: 'confirm' }] });
    expect((noMatrix as { error: { code: string } }).error.code).toBe('RESOURCE_NOT_FOUND');
    db.close();
  });

  it('屏障关闭后到达 → STALE_EXECUTION；关屏障 pending→missing 不伪造 stance/turn；聚合 unconfirmed', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    prepared(db);
    submitRatification(db, { ...base, resultKey: 'rk-a', responses: [
      { claimId: 'clm_1', stance: 'confirm' },
      { claimId: 'clm_2', stance: 'confirm' },
    ] });
    closeRatificationBarrier(db, { runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, missingReason: '未回复' });
    const late = submitRatification(db, { runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, memberId: 'm2', turnId: 'turn_m2', responseArtifactId: 'a', resultKey: 'rk-late', now: 99, responses: [
      { claimId: 'clm_1', stance: 'confirm' },
      { claimId: 'clm_2', stance: 'confirm' },
    ] });
    expect((late as { error: { code: string } }).error.code).toBe('STALE_EXECUTION');
    const records = getRatificationRecords(db, 'run1', 'art_syn', 1);
    const m2 = records.filter((r) => r.member_id === 'm2');
    expect(m2.every((r) => r.response_status === 'missing' && r.missing_reason === '未回复' && r.turn_id == null && r.stance == null)).toBe(true);
    const claims = getSynthesisClaims(db, 'run1', 'art_syn', 1).map((c) => c.claim_id);
    const summaries = aggregateClaimConsensus(claims, ['m1', 'm2'], records.map((r) => ({ claimId: r.claim_id, memberId: r.member_id, stance: r.stance, responseStatus: r.response_status })));
    expect(summaries.every((s) => s.consensus === 'unconfirmed')).toBe(true);
    db.close();
  });

  it('conditional 缺条件 / object 与 unconfirmed 缺原因 → 整份拒绝', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    prepared(db);
    const noCond = submitRatification(db, { ...base, resultKey: 'rk-c', responses: [
      { claimId: 'clm_1', stance: 'conditional' },
      { claimId: 'clm_2', stance: 'confirm' },
    ] });
    expect((noCond as { error: { code: string } }).error.code).toBe('VALIDATION_INVALID');
    const noReason = submitRatification(db, { ...base, resultKey: 'rk-o', responses: [
      { claimId: 'clm_1', stance: 'object' },
      { claimId: 'clm_2', stance: 'unconfirmed' },
    ] });
    expect((noReason as { error: { code: string } }).error.code).toBe('VALIDATION_INVALID');
    expect(getRatificationRecords(db, 'run1', 'art_syn', 1).every((r) => r.response_status === 'pending')).toBe(true);
    db.close();
  });

  it('覆盖不全 / 重复 / 未知 claimId → 整份拒绝（不产生默认确认）', () => {
  freshDir();
    const db = openDatabase(':memory:');
    seed(db);
    prepared(db);
    const partial = submitRatification(db, { ...base, resultKey: 'rk-1', responses: [{ claimId: 'clm_1', stance: 'confirm' }] });
    expect((partial as { error: { code: string } }).error.code).toBe('CLAIM_COVERAGE_INCOMPLETE');
    const dup = submitRatification(db, { ...base, resultKey: 'rk-1', responses: [{ claimId: 'clm_1', stance: 'confirm' }, { claimId: 'clm_1', stance: 'confirm' }] });
    expect((dup as { error: { code: string } }).error.code).toBe('CLAIM_DUPLICATED');
    const unknown = submitRatification(db, { ...base, resultKey: 'rk-1', responses: [{ claimId: 'clm_x', stance: 'confirm' }, { claimId: 'clm_2', stance: 'confirm' }] });
    expect((unknown as { error: { code: string } }).error.code).toBe('CLAIM_NOT_FOUND');
    expect(getRatificationRecords(db, 'run1', 'art_syn', 1).every((r) => r.response_status === 'pending')).toBe(true);
    db.close();
  });
});
