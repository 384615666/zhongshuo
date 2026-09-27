/**
 * DELIBERATE 持久化集成（§6.5 提交事务）：artifacts 往返、synthesis claims、
 * RATIFY 矩阵初始化/提交校验/重放/覆盖拒绝/关屏障落 missing。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
  saveDeliberationArtifact,
  submitRatification,
} from '../../src/persistence/stores/deliberation.ts';
import { aggregateClaimConsensus } from '../../src/domain/deliberation/stageMachine.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-delib-'));
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

function openWithSeed(): ZhongshuoDatabase {
  const db = openDatabase(':memory:');
  seed(db);
  return db;
}

const blobDir = join(tmpRoot, 'artifacts');

describe('deliberation artifacts（E19 管理目录 + hash）', () => {
  it('保存后可按 run+kind 列出；正文与 hash 落盘一致', () => {
    const db = openWithSeed();
    const payload = { schemaVersion: 'analysis-draft-v1', summary: 's', claims: [], recommendations: [], openQuestions: [] };
    const r = saveDeliberationArtifact(db, {
      artifactId: 'art_1', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1',
      authorId: 'm1', kind: 'analysis_draft', revision: 1, payload, blobDir, now: 1,
    });
    expect(r.ok).toBe(true);
    const rows = listRunArtifacts(db, 'run1', 'analysis_draft');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ author_id: 'm1', revision: 1 });
    expect(readFileSync(rows[0]!.blob_path, 'utf8')).toBe(JSON.stringify(payload, null, 2));
    db.close();
  });
});

describe('RATIFY 确认矩阵（§6.5 提交事务）', () => {
  function prepared(db: ZhongshuoDatabase): void {
    saveDeliberationArtifact(db, {
      artifactId: 'art_syn', projectId: 'p1', conversationId: 'c1', threadId: 'th1', taskId: 'tk1', runId: 'run1',
      authorId: 'm1', kind: 'synthesis', revision: 1, payload: { schemaVersion: 'synthesis-v1', summary: 's', claims: [], disputedClaims: [], recommendations: [] }, blobDir, now: 1,
    });
    insertSynthesisClaims(db, {
      runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1,
      claims: [
        { claimId: 'clm_1', statement: '结论一', sourceRefs: ['c1'] },
        { claimId: 'clm_2', statement: '结论二', sourceRefs: ['c2'] },
      ],
    });
    initRatificationMatrix(db, { runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, claimIds: ['clm_1', 'clm_2'], memberIds: ['m1', 'm2'], rosterRevision: 1 });
  }

  it('初始化 pending 矩阵；合法提交整份落库；同 resultKey 重放返回原回执', () => {
    const db = openWithSeed();
    prepared(db);
    expect(getRatificationRecords(db, 'run1', 'art_syn', 1)).toHaveLength(4); // 2 成员 × 2 结论，全 pending
    const submit = submitRatification(db, {
      runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, memberId: 'm1', turnId: 'turn_1',
      responseArtifactId: 'art_r1', resultKey: 'rk-1', now: 10,
      responses: [
        { claimId: 'clm_1', stance: 'confirm' },
        { claimId: 'clm_2', stance: 'conditional', conditions: ['补充验证'] },
      ],
    });
    expect(submit.ok).toBe(true);
    expect((submit as { value: { accepted: number } }).value.accepted).toBe(2);
    const replay = submitRatification(db, {
      runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, memberId: 'm1', turnId: 'turn_1',
      responseArtifactId: 'art_r1', resultKey: 'rk-1', now: 11,
      responses: [
        { claimId: 'clm_1', stance: 'confirm' },
        { claimId: 'clm_2', stance: 'conditional', conditions: ['补充验证'] },
      ],
    });
    expect(replay.ok).toBe(true);
    expect((replay as { value: { replayed: boolean } }).value.replayed).toBe(true);
    db.close();
  });

  it('覆盖不全 / 重复 / 未知 claimId / 非预期成员 / 阶段不符 → 整份拒绝（不产生默认确认）', () => {
    const db = openWithSeed();
    prepared(db);
    const base = { runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, turnId: 'turn_2', responseArtifactId: 'art_r2', resultKey: 'rk-2', now: 20 } as const;
    const partial = submitRatification(db, { ...base, memberId: 'm1', responses: [{ claimId: 'clm_1', stance: 'confirm' }] });
    expect(partial.ok).toBe(false);
    expect((partial as { error: { code: string } }).error.code).toBe('CLAIM_COVERAGE_INCOMPLETE');
    const dup = submitRatification(db, { ...base, memberId: 'm1', responses: [{ claimId: 'clm_1', stance: 'confirm' }, { claimId: 'clm_1', stance: 'confirm' }] });
    expect((dup as { error: { code: string } }).error.code).toBe('CLAIM_DUPLICATED');
    const unknown = submitRatification(db, { ...base, memberId: 'm1', responses: [{ claimId: 'clm_x', stance: 'confirm' }, { claimId: 'clm_2', stance: 'confirm' }] });
    expect((unknown as { error: { code: string } }).error.code).toBe('CLAIM_NOT_FOUND');
    const outsider = submitRatification(db, { ...base, memberId: 'm3', responses: [{ claimId: 'clm_1', stance: 'confirm' }, { claimId: 'clm_2', stance: 'confirm' }] });
    expect((outsider as { error: { code: string } }).error.code).toBe('PARTICIPANT_NOT_EXPECTED');
    db.prepare("UPDATE workflow_runs SET stage = 'SYNTHESIS' WHERE id = 'run1'").run();
    const wrongStage = submitRatification(db, { ...base, memberId: 'm1', responses: [{ claimId: 'clm_1', stance: 'confirm' }, { claimId: 'clm_2', stance: 'confirm' }] });
    expect((wrongStage as { error: { code: string } }).error.code).toBe('STAGE_MISMATCH');
    // 全部失败后：矩阵仍全 pending（无默认确认）。
    expect(getRatificationRecords(db, 'run1', 'art_syn', 1).every((r) => r.response_status === 'pending')).toBe(true);
    db.close();
  });

  it('已确认成员的再次提交被拒（实质变更走修订稿）；关屏障后 pending → missing；聚合 unconfirmed', () => {
    const db = openWithSeed();
    prepared(db);
    const base = { runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, turnId: 'turn_3', responseArtifactId: 'art_r3', now: 30 } as const;
    const first = submitRatification(db, { ...base, memberId: 'm1', resultKey: 'rk-a', responses: [{ claimId: 'clm_1', stance: 'confirm' }, { claimId: 'clm_2', stance: 'confirm' }] });
    expect(first.ok).toBe(true);
    const again = submitRatification(db, { ...base, memberId: 'm1', resultKey: 'rk-b', responses: [{ claimId: 'clm_1', stance: 'object', reason: '改主意' }, { claimId: 'clm_2', stance: 'confirm' }] });
    expect((again as { error: { code: string } }).error.code).toBe('RATIFY_ALREADY_SUBMITTED');
    const closed = closeRatificationBarrier(db, { runId: 'run1', synthesisArtifactId: 'art_syn', synthesisRevision: 1, missingReason: '未回复' });
    expect(closed).toBe(2); // m2 的两格
    const records = getRatificationRecords(db, 'run1', 'art_syn', 1);
    const m2 = records.filter((r) => r.member_id === 'm2');
    expect(m2.every((r) => r.response_status === 'missing' && r.missing_reason === '未回复' && r.turn_id == null)).toBe(true);
    const claims = getSynthesisClaims(db, 'run1', 'art_syn', 1).map((c) => c.claim_id);
    const summaries = aggregateClaimConsensus(claims, ['m1', 'm2'], records.map((r) => ({ claimId: r.claim_id, memberId: r.member_id, stance: r.stance, responseStatus: r.response_status })));
    expect(summaries.every((s) => s.consensus === 'unconfirmed')).toBe(true); // m1 confirm + m2 missing
    db.close();
  });
});
