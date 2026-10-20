/**
 * R91 模块2/3 后端：研讨阶段产物 → 串内正式消息（可见性投影）契约。
 *
 * 全部用例走真实 `onStepOutput` 入口（内存 SQLite + 临时 blob 目录，零额度），不直接调用
 * helper 伪造投影。覆盖：
 *  a. 正例：IND 成功产物投影为恰一条 `msg_delib_<runId>_IND_<memberId>_0`，作者/归属/
 *     body_json.collaborationStage 正确，正文含中文阶段标签与 summary，不含原始 JSON/
 *     reasoning/内部身份（evidenceIds 等）。
 *  b. 幂等重放：同一 turn 同输入调两次 → messages 1 条、artifacts 1 条（实际 DB count）。
 *  c. 格式修复：非法修复尝试不投影（counted=false）；合法修复产物投影且身份=修复轮 turnId；
 *     随后原 stage_work 的另一 turnId 同身份再提交 → 稳定身份只保留一条消息。
 *  d. 身份守卫负例：step.runId / step.taskId / run 归属 task / turn 成员 / turn 阶段任一
 *     不符 → 拒绝（错误的 late/错误作者消息都不产生）；无 agent_turns 行的历史合成输出
 *     仍计入但不投影。
 *  e. STOP/UNKNOWN 终态/旧 run：task 停止（stop_generation 超越 run scope 或 CANCELLED）、
 *     run INTERRUPTED、旧 run 的 step → 只走 recordLateArrival，不投影成功发言。
 *  f. 文本正确性：SYN 说「整合结论（待确认）」不称「共识结论」；CR/ISS/RAT 不出现内部
 *     identity（artifactId/ev/claimId 原样）；CHK 归入 ISSUE_DISCUSSION 且含「检查点」。
 *  g. DB 状态：迟到/拒绝分支下 run 状态、participants、artifacts、domain_events 原审计
 *     仍在（recordLateArrival 记录 + artifact 行），仅不做「成功发言」投影。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import {
  onStepOutput,
  type DelibStep,
  type DeliberationOptions,
} from '../../src/daemon/deliberationRunner.ts';
import {
  initRatificationMatrix,
  insertIssues,
  insertSynthesisClaims,
  listRunArtifacts,
  publishDeliberationArtifact,
} from '../../src/persistence/stores/deliberation.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-r91viz-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const RUN = 'run1';
const TASK = 'tk1';

function freshBlobDir(): string {
  return mkdtempSync(join(tmpRoot, 'art-'));
}

function options(blobDir: string): DeliberationOptions {
  return { absenceToleranceMs: 60_000, blobDir };
}

type StepOutcome = ReturnType<typeof onStepOutput>;

function expectCounted(out: StepOutcome): void {
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error(out.error.message);
  expect(out.value.counted).toBe(true);
  expect(out.value.lateRecorded).not.toBe(true);
  expect(out.value.needsRepair).toBeUndefined();
}

function expectRejected(out: StepOutcome, code: string): void {
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.error.code).toBe(code);
}

function expectLateRecorded(out: StepOutcome): void {
  expect(out.ok).toBe(true);
  if (!out.ok) throw new Error(out.error.message);
  expect(out.value.counted).toBe(false);
  expect(out.value.lateRecorded).toBe(true);
}

interface VisibleMessageRow {
  id: string;
  project_id: string;
  conversation_id: string;
  conversation_seq: number;
  room_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  thread_message_seq: number | null;
  author_type: string;
  author_id: string;
  body_json: string;
  status: string;
  created_at: number;
}

interface CollaborationStageBody {
  text: string;
  detailMarkdown?: string;
  collaborationStage: { stage: string; roundNo: number; turnId: string; runId: string };
}

function visibleMessages(db: ZhongshuoDatabase): VisibleMessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE id LIKE 'msg_delib_%' ORDER BY rowid")
    .all() as VisibleMessageRow[];
}

function bodyOf(row: VisibleMessageRow): CollaborationStageBody {
  return JSON.parse(row.body_json) as CollaborationStageBody;
}

function runArtifactCount(db: ZhongshuoDatabase): number {
  return (db.prepare('SELECT count(*) AS c FROM artifacts WHERE run_id = ?').get(RUN) as { c: number }).c;
}

function artifactRow(db: ZhongshuoDatabase, artifactId: string): { id: string; kind: string; run_id: string; author_id: string } | undefined {
  return db
    .prepare('SELECT id, kind, run_id, author_id FROM artifacts WHERE id = ?')
    .get(artifactId) as { id: string; kind: string; run_id: string; author_id: string } | undefined;
}

function eventsOfKind(db: ZhongshuoDatabase, kind: string): Array<{ payload_json: string }> {
  return db.prepare('SELECT payload_json FROM domain_events WHERE kind = ? ORDER BY seq').all(kind) as Array<{ payload_json: string }>;
}

/**
 * 最小同构种子（参考 tests/integration/deliberationStores.test.ts）：
 * projects / project_members / rooms / conversations / conversation_threads / messages /
 * tasks / workflow_runs / run_participants / deliberation_run_scopes。
 * conversation_threads.last_message_seq 从 0 起（根消息是顶层），投影时推进到 1，不撞唯一序号。
 */
function seed(db: ZhongshuoDatabase, opts: { taskStatus?: string; stopGeneration?: number; runStatus?: string; runStage?: string } = {}): void {
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1','演示项目','D:/x','D:/x','{}',0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
     VALUES ('m1','p1','甲','agent',1), ('m2','p1','乙','agent',1), ('m3','p1','丙','human',1)`,
  ).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅','m1')`).run();
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, room_id, last_message_seq) VALUES ('c1','p1','room','r1',1)`,
  ).run();
  db.prepare(
    `INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id, last_message_seq)
     VALUES ('th1','p1','c1','r1','msg1',0)`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at)
     VALUES ('msg1','p1','c1',1,'r1','human','m3','{"text":"请研讨方案 A"}','saved',0)`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, root_message_id,
       room_task_number, title, objective, status, revision, review_policy, stop_generation)
     VALUES ('tk1','p1','c1','room_task','r1','th1','msg1',1,'研讨方案 A','比较成本与风险',?,0,'auto_deliver',?)`,
  ).run(opts.taskStatus ?? 'ACTIVE', opts.stopGeneration ?? 0);
  db.prepare(
    `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, stage, round_no, roster_revision)
     VALUES ('run1','tk1','c1','th1','DELIBERATE',0,?,?,0,1)`,
  ).run(opts.runStatus ?? 'RUNNING', opts.runStage ?? 'INDEPENDENT');
  db.prepare(
    `INSERT INTO run_participants (run_id, member_id, role, expected, status)
     VALUES ('run1','m1','host',1,'pending'), ('run1','m2','member',1,'pending')`,
  ).run();
  db.prepare(`INSERT INTO deliberation_run_scopes (run_id, stop_generation) VALUES ('run1', 0)`).run();
}

function addTurn(db: ZhongshuoDatabase, input: {
  id: string;
  runId?: string;
  memberId?: string;
  stageKey: string;
  status?: string;
  purpose?: 'stage_work' | 'checkpoint' | 'format_repair';
  attempt?: number;
}): void {
  db.prepare(
    `INSERT INTO agent_turns (id, run_id, conversation_id, thread_id, member_id, stage_key, turn_purpose, attempt, status)
     VALUES (?, ?, 'c1', 'th1', ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId ?? RUN,
    input.memberId ?? 'm1',
    input.stageKey,
    input.purpose ?? 'stage_work',
    input.attempt ?? 1,
    input.status ?? 'RUNNING',
  );
}

function indStep(overrides: Partial<DelibStep> = {}): DelibStep {
  return { taskId: TASK, runId: RUN, stage: 'IND', memberId: 'm1', roundNo: 0, purpose: 'stage_work', ...overrides };
}

/** 合法 IND 产物（含 evidenceIds——投影必须过滤掉这类内部身份）。 */
function draftPayload(overrides: { summary?: string; statement?: string } = {}): unknown {
  return {
    schemaVersion: 'analysis-draft-v1',
    summary: overrides.summary ?? '甲的分析：方案 A 成本更低但交付期偏长',
    claims: [
      {
        claimId: 'c1',
        statement: overrides.statement ?? '方案 A 成本更低',
        kind: 'observed',
        evidenceIds: ['ev1'],
        uncertainty: '样本有限',
      },
    ],
    recommendations: ['先做小规模验证'],
    openQuestions: ['风险是否可控'],
  };
}

function publishSeedArtifact(db: ZhongshuoDatabase, blobDir: string, input: {
  artifactId: string;
  authorId: string;
  kind: 'analysis_draft' | 'synthesis';
  revision: number;
  payload: unknown;
}): void {
  const published = publishDeliberationArtifact(db, {
    artifactId: input.artifactId,
    projectId: 'p1',
    conversationId: 'c1',
    threadId: 'th1',
    taskId: TASK,
    runId: RUN,
    authorId: input.authorId,
    kind: input.kind,
    revision: input.revision,
    payload: input.payload,
    blobDir,
    now: 1,
  });
  expect(published.ok).toBe(true);
  if (!published.ok) throw new Error(published.error.message);
}

describe('a/b. 正例投影与幂等重放（真实 onStepOutput）', () => {
  it('IND 成功产物 → 恰一条串内正式消息，作者/归属/元数据/正文均符合契约', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_ind_1', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_ind_1',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 1_000,
    });
    expectCounted(out);

    const rows = visibleMessages(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // 稳定身份 = msg_delib_<runId>_<内部stage码>_<memberId>_<roundNo>
    expect(row.id).toBe('msg_delib_run1_IND_m1_0');
    expect(row.author_type).toBe('agent');
    expect(row.author_id).toBe('m1');
    expect(row.project_id).toBe('p1');
    expect(row.conversation_id).toBe('c1');
    expect(row.thread_id).toBe('th1');
    expect(row.task_id).toBe(TASK);
    expect(row.room_id).toBe('r1');
    expect(row.status).toBe('final');
    expect(row.conversation_seq).toBe(2); // 根消息 seq=1
    expect(row.thread_message_seq).toBe(1);

    const body = bodyOf(row);
    expect(body.collaborationStage).toEqual({ stage: 'INDEPENDENT', roundNo: 0, turnId: 'turn_ind_1', runId: RUN });
    expect(body.text).toContain('【独立分析】');
    expect(body.text).toContain('甲的分析：方案 A 成本更低但交付期偏长');
    expect(body.text).toContain('方案 A 成本更低');
    // 不把原始结构化 JSON / reasoning / evidenceIds 等内部身份写进正文。
    expect(body.text).not.toContain('schemaVersion');
    expect(body.text).not.toContain('reasoning');
    expect(body.text).not.toContain('ev1');
    expect(body.text).not.toContain('evidenceIds');
    expect(body.text).not.toMatch(/\{|\}/);
    // artifact 已发布，但不在正文里出现 artifactId。
    expect(listRunArtifacts(db, RUN, 'analysis_draft')).toHaveLength(1);
    expect(body.text).not.toContain('art_turn_ind_1');
    expect(db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(row.id)).toEqual({ n: 0 });
    db.close();
  });

  it('R95：模型 summary 逐字显示，detailMarkdown 逐字托管且 canonical 保留完整载荷', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_ind_r95', stageKey: 'delib.independent' });
    const summary = '模型总览：关键条件与待确认事项见详情。\n第二行保持原样  ';
    const detailMarkdown = '  \n# 模型完整详情\n\n1. A1 字段保持业务编号\n2. 查询条件不是程序摘录依据\n\n日期：2026-10-20\n\nR95_DETAIL_TAIL  ';

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_ind_r95',
      finalText: JSON.stringify({
        schemaVersion: 'analysis-draft-v1',
        summary,
        detailMarkdown,
        claims: [{ claimId: 'c1', statement: '结论', kind: 'proposal', evidenceIds: [], uncertainty: '' }],
        recommendations: [],
        openQuestions: [],
      }),
      options: options(blobDir),
      now: 1_100,
    });
    expectCounted(out);

    const row = visibleMessages(db)[0]!;
    const body = bodyOf(row);
    expect(body.text).toBe(summary);
    expect(body.detailMarkdown).toBeUndefined();
    const attachment = db.prepare(`SELECT ma.id,a.hash,a.blob_path FROM message_attachments ma
      JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=?`).get(row.id) as { id: string; hash: string; blob_path: string };
    expect(attachment.id.startsWith('matt_detail_')).toBe(true);
    const hosted = readFileSync(attachment.blob_path, 'utf8');
    expect(hosted).toBe(detailMarkdown);
    expect(attachment.hash).toBe(createHash('sha256').update(Buffer.from(detailMarkdown, 'utf8')).digest('hex'));

    const canonical = listRunArtifacts(db, RUN, 'analysis_draft')[0]!;
    const canonicalPayload = JSON.parse(readFileSync(canonical.blob_path, 'utf8')) as { summary?: string; detailMarkdown?: string };
    expect(canonicalPayload.summary).toBe(summary);
    expect(canonicalPayload.detailMarkdown).toBe(detailMarkdown);
    db.close();
  });

  it('R95：空 detailMarkdown 只显示模型 summary，不生成空附件，也不补写详情', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_ind_r95_short', stageKey: 'delib.independent' });
    const summary = '简短结论：无需额外详情。';
    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_ind_r95_short',
      finalText: JSON.stringify({
        schemaVersion: 'analysis-draft-v1',
        summary,
        detailMarkdown: '',
        claims: [{ claimId: 'c1', statement: '简短结论', kind: 'observed', evidenceIds: [] }],
        recommendations: [],
        openQuestions: [],
      }),
      options: options(blobDir),
      now: 1_200,
    });
    expectCounted(out);

    const row = visibleMessages(db)[0]!;
    expect(bodyOf(row).text).toBe(summary);
    expect(db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(row.id)).toEqual({ n: 0 });
    const canonical = listRunArtifacts(db, RUN, 'analysis_draft')[0]!;
    const canonicalPayload = JSON.parse(readFileSync(canonical.blob_path, 'utf8')) as { detailMarkdown?: string };
    expect(canonicalPayload.detailMarkdown).toBe('');
    db.close();
  });

  it('R95：全空白 summary 不作为模型总览，回退完整 legacy 正文且不伪造详情', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_ind_r95_blank', stageKey: 'delib.independent' });
    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_ind_r95_blank',
      finalText: JSON.stringify({
        schemaVersion: 'analysis-draft-v1',
        summary: '   ',
        detailMarkdown: '# 不应作为宿主详情',
        claims: [{ claimId: 'c1', statement: 'legacy 正文保留', kind: 'observed', evidenceIds: [] }],
        recommendations: [],
        openQuestions: [],
      }),
      options: options(blobDir),
      now: 1_300,
    });
    expectCounted(out);

    const row = visibleMessages(db)[0]!;
    const body = bodyOf(row);
    expect(body.text).toContain('【独立分析】');
    expect(body.text).toContain('legacy 正文保留');
    expect(body.text).not.toBe('   ');
    expect(db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(row.id)).toEqual({ n: 0 });
    db.close();
  });

  it('同一 turn 同输入幂等重放：messages 1 条、artifacts 1 条、投影审计事件 1 条', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_ind_replay', stageKey: 'delib.independent' });
    const call = () => onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_ind_replay',
      finalText: JSON.stringify(draftPayload({ summary: '重放分析' })),
      options: options(blobDir),
      now: 2_000,
    });

    expectCounted(call());
    expect(visibleMessages(db)).toHaveLength(1);
    expect(runArtifactCount(db)).toBe(1);
    const firstBody = visibleMessages(db)[0]!.body_json;

    // 重放（同 turnId/同 payload）：不得重复写消息、不得重复写 artifact/审计事件。
    expectCounted(call());
    expect(visibleMessages(db)).toHaveLength(1);
    expect(runArtifactCount(db)).toBe(1);
    expect(visibleMessages(db)[0]!.body_json).toBe(firstBody);
    expect(eventsOfKind(db, 'thread.replyAdded')).toHaveLength(1);
    db.close();
  });
});

describe('c. 格式修复轮：非法修复不投影、成功修复共享稳定身份', () => {
  it('非法 repair 尝试 counted=false 无消息；成功 repair 投影且 turnId=修复轮；原 stage_work 另一 turn 不再新增消息', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    const repairStep: DelibStep = { taskId: TASK, runId: RUN, stage: 'IND', memberId: 'm1', roundNo: 0, purpose: 'format_repair' };
    // 同一 (run, member, stage_key) 的修复轮以 attempt 区分（agent_turns 唯一约束）。
    addTurn(db, { id: 'turn_ind_fx_bad', stageKey: 'delib.independent.fx', purpose: 'format_repair', attempt: 1 });
    addTurn(db, { id: 'turn_ind_fx_ok', stageKey: 'delib.independent.fx', purpose: 'format_repair', attempt: 2 });
    addTurn(db, { id: 'turn_ind_w_ok', stageKey: 'delib.independent' });

    // 1) 非法修复输出（schema 不过）：拒绝计入，不投影、不发布成果。
    const bad = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: repairStep,
      turnId: 'turn_ind_fx_bad',
      finalText: JSON.stringify({ schemaVersion: 'analysis-draft-v1', summary: '', claims: [] }),
      options: options(blobDir),
      now: 3_000,
    });
    expect(bad.ok).toBe(true);
    if (!bad.ok) throw new Error(bad.error.message);
    expect(bad.value.counted).toBe(false);
    expect(bad.value.needsRepair).toBeTruthy();
    expect(visibleMessages(db)).toHaveLength(0);
    expect(runArtifactCount(db)).toBe(0);

    // 2) 合法修复输出（不同 turnId）：修复轮通过校验后共享原阶段身份投影一次。
    const fixed = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: repairStep,
      turnId: 'turn_ind_fx_ok',
      finalText: JSON.stringify(draftPayload({ summary: '修复后的分析' })),
      options: options(blobDir),
      now: 3_100,
    });
    expectCounted(fixed);
    let rows = visibleMessages(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('msg_delib_run1_IND_m1_0');
    expect(bodyOf(rows[0]!).collaborationStage).toEqual({ stage: 'INDEPENDENT', roundNo: 0, turnId: 'turn_ind_fx_ok', runId: RUN });
    expect(bodyOf(rows[0]!).text).toContain('修复后的分析');
    expect(runArtifactCount(db)).toBe(1);

    // 3) 原 stage_work 的另一 turnId、同 (stage, member, round) 再成功提交：
    //    产物照常计入（新 artifact），但稳定身份只保留一条消息（首次投影内容不被覆盖）。
    const original = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_ind_w_ok',
      finalText: JSON.stringify(draftPayload({ summary: '原阶段工作重放' })),
      options: options(blobDir),
      now: 3_200,
    });
    expectCounted(original);
    rows = visibleMessages(db);
    expect(rows).toHaveLength(1);
    expect(bodyOf(rows[0]!).collaborationStage.turnId).toBe('turn_ind_fx_ok');
    expect(bodyOf(rows[0]!).text).toContain('修复后的分析');
    expect(bodyOf(rows[0]!).text).not.toContain('原阶段工作重放');
    // 两次成功计入各自留下不可变 artifact（不同 turnId → 不同 artifact ID）。
    expect(runArtifactCount(db)).toBe(2);
    db.close();
  });
});

describe('d. 身份守卫负例（不产生错误作者/成功发言）', () => {
  it('step.runId ≠ input.runId → 迟到记录（ok=true, lateRecorded），无消息', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_stale_step', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep({ runId: 'run_old' }),
      turnId: 'turn_stale_step',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 4_000,
    });
    expectLateRecorded(out);
    expect(visibleMessages(db)).toHaveLength(0);
    const event = eventsOfKind(db, 'run.lateArrivalRecorded')[0]!;
    expect(JSON.parse(event.payload_json)).toMatchObject({ reason: 'stale-run', counted: false, artifactId: 'art_turn_stale_step' });
    expect(artifactRow(db, 'art_turn_stale_step')).toMatchObject({ kind: 'analysis_draft', run_id: RUN, author_id: 'm1' });
    db.close();
  });

  it('step.taskId 与 input.taskId 不符 → TARGET_KIND_MISMATCH，无消息/无 artifact', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_task_mismatch', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep({ taskId: 'tk_other' }),
      turnId: 'turn_task_mismatch',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 4_100,
    });
    expectRejected(out, 'TARGET_KIND_MISMATCH');
    expect(visibleMessages(db)).toHaveLength(0);
    expect(runArtifactCount(db)).toBe(0);
    db.close();
  });

  it('run 属于另一 task → TARGET_KIND_MISMATCH，无消息', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    // 另一任务 + 它自己的 run（run2 归属 tk2，但调用方声称 tk1）。
    db.prepare(
      `INSERT INTO tasks (id, project_id, conversation_id, kind, room_id, conversation_thread_id, room_task_number, title, status, revision, review_policy)
       VALUES ('tk2','p1','c1','room_task','r1','th1',2,'另一任务','ACTIVE',0,'auto_deliver')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, stage, round_no, roster_revision)
       VALUES ('run2','tk2','c1','th1','DELIBERATE',0,'RUNNING','INDEPENDENT',0,1)`,
    ).run();
    db.prepare(`INSERT INTO deliberation_run_scopes (run_id, stop_generation) VALUES ('run2', 0)`).run();
    addTurn(db, { id: 'turn_other_task_run', runId: 'run2', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: 'run2',
      step: indStep({ runId: 'run2' }),
      turnId: 'turn_other_task_run',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 4_200,
    });
    expectRejected(out, 'TARGET_KIND_MISMATCH');
    expect(visibleMessages(db)).toHaveLength(0);
    expect((db.prepare('SELECT count(*) AS c FROM artifacts WHERE run_id = ?').get('run2') as { c: number }).c).toBe(0);
    db.close();
  });

  it('turnId 的 agent_turns.member_id 为另一成员 → TARGET_KIND_MISMATCH，不出现错误作者消息', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_wrong_member', memberId: 'm2', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep({ memberId: 'm1' }),
      turnId: 'turn_wrong_member',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 4_300,
    });
    expectRejected(out, 'TARGET_KIND_MISMATCH');
    expect(visibleMessages(db)).toHaveLength(0);
    expect((db.prepare("SELECT count(*) AS c FROM messages WHERE author_id = 'm2'").get() as { c: number }).c).toBe(0);
    expect(runArtifactCount(db)).toBe(0);
    db.close();
  });

  it('turnId 的 stage_key 属另一阶段 → STAGE_MISMATCH，无消息', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_wrong_stage', stageKey: 'delib.cross_review' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep({ stage: 'IND' }),
      turnId: 'turn_wrong_stage',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 4_400,
    });
    expectRejected(out, 'STAGE_MISMATCH');
    expect(visibleMessages(db)).toHaveLength(0);
    expect(runArtifactCount(db)).toBe(0);
    db.close();
  });

  it('agent_turns 行缺失（历史合成迟到路径）→ 仍计入但不投影成功发言', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db); // 故意不建 agent_turns 行
    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_missing_turn_row',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 4_500,
    });
    expectCounted(out);
    expect(visibleMessages(db)).toHaveLength(0);
    // 阶段成功事实仍以 artifact 为准（不可投影不等于丢材料）。
    expect(artifactRow(db, 'art_turn_missing_turn_row')).toMatchObject({ kind: 'analysis_draft', run_id: RUN });
    db.close();
  });
});

describe('e. STOP/终态/旧 run：只记迟到材料，不转成功发言', () => {
  it('task stop_generation 超越 run scope → counted=false/lateRecorded，无消息', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_stop_gen', stageKey: 'delib.independent' });
    db.prepare('UPDATE tasks SET stop_generation = 1 WHERE id = ?').run(TASK);

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_stop_gen',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 5_000,
    });
    expectLateRecorded(out);
    expect(visibleMessages(db)).toHaveLength(0);
    const event = eventsOfKind(db, 'run.lateArrivalRecorded')[0]!;
    expect(JSON.parse(event.payload_json)).toMatchObject({ reason: 'task-stopped', counted: false });
    db.close();
  });

  it('task status=CANCELLED → counted=false/lateRecorded，无消息', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_task_cancelled', stageKey: 'delib.independent' });
    db.prepare("UPDATE tasks SET status = 'CANCELLED' WHERE id = ?").run(TASK);

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_task_cancelled',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 5_100,
    });
    expectLateRecorded(out);
    expect(visibleMessages(db)).toHaveLength(0);
    expect(JSON.parse(eventsOfKind(db, 'run.lateArrivalRecorded')[0]!.payload_json)).toMatchObject({ reason: 'task-stopped' });
    db.close();
  });

  it('run status=INTERRUPTED（终态）→ 无消息', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db, { runStatus: 'INTERRUPTED' });
    addTurn(db, { id: 'turn_interrupted_run', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_interrupted_run',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 5_200,
    });
    expectLateRecorded(out);
    expect(visibleMessages(db)).toHaveLength(0);
    expect(JSON.parse(eventsOfKind(db, 'run.lateArrivalRecorded')[0]!.payload_json)).toMatchObject({ reason: 'run-INTERRUPTED', counted: false });
    expect(artifactRow(db, 'art_turn_interrupted_run')).toMatchObject({ run_id: RUN });
    // 终态不被迟到输出复活。
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(RUN)).toMatchObject({ status: 'INTERRUPTED' });
    db.close();
  });

  it('旧 run 的 step（step.runId 不同，已 CANCELLED）→ 不投影，run 不被复活', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    db.prepare(
      `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, stage, round_no, roster_revision)
       VALUES ('run_prev','tk1','c1','th1','DELIBERATE',0,'CANCELLED','PUBLISH',0,1)`,
    ).run();
    db.prepare(`INSERT INTO deliberation_run_scopes (run_id, stop_generation) VALUES ('run_prev', 0)`).run();
    addTurn(db, { id: 'turn_old_run', runId: 'run_prev', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep({ runId: 'run_prev' }),
      turnId: 'turn_old_run',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 5_300,
    });
    expectLateRecorded(out);
    expect(visibleMessages(db)).toHaveLength(0);
    expect(JSON.parse(eventsOfKind(db, 'run.lateArrivalRecorded')[0]!.payload_json)).toMatchObject({ reason: 'stale-run' });
    // 旧 run 保持终态；当前 run 维持原状（未因迟到输出推进/复活）。
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run_prev')).toMatchObject({ status: 'CANCELLED' });
    expect(db.prepare('SELECT status, stage FROM workflow_runs WHERE id = ?').get(RUN)).toMatchObject({ status: 'RUNNING', stage: 'INDEPENDENT' });
    db.close();
  });
});

describe('f. 文本正确性：阶段标签可读、不泄露内部身份', () => {
  it('SYN：含「整合结论（待确认）」，不称「共识结论」', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_syn', stageKey: 'delib.synthesis' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: { taskId: TASK, runId: RUN, stage: 'SYN', memberId: 'm1', roundNo: 0, purpose: 'stage_work' },
      turnId: 'turn_syn',
      finalText: JSON.stringify({
        schemaVersion: 'synthesis-v1',
        summary: '综合各方观点：方案 A 可行但需分阶段',
        claims: [{ statement: '方案 A 可行', sourceRefs: ['c1', 'c2'] }],
        disputedClaims: [{ statement: '成本估计分歧', disagreementSummary: '一方认为偏高', sourceRefs: ['c3'] }],
        recommendations: ['分阶段实施'],
      }),
      options: options(blobDir),
      now: 6_000,
    });
    expectCounted(out);
    const body = bodyOf(visibleMessages(db)[0]!);
    expect(body.text).toContain('【整合】');
    expect(body.text).toContain('方案 A 可行但需分阶段');
    expect(body.text).toContain('整合结论（待确认）');
    expect(body.text).toContain('方案 A 可行');
    expect(body.text).toContain('保留分歧');
    expect(body.text).toContain('分阶段实施');
    // RATIFY 前只是主持者整合稿，不得提前承诺“共识”。
    expect(body.text).not.toContain('共识结论');
    expect(body.text).not.toContain('ev1');
    expect(body.text).not.toContain('schemaVersion');
    expect(body.text).not.toMatch(/\{|\}/);
    expect(body.collaborationStage).toEqual({ stage: 'SYNTHESIS', roundNo: 0, turnId: 'turn_syn', runId: RUN });
    db.close();
  });

  it('CR：保留「互评」标签，不出现 artifactId/ev/claimId 原样', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    publishSeedArtifact(db, blobDir, {
      artifactId: 'art_draft_m2',
      authorId: 'm2',
      kind: 'analysis_draft',
      revision: 1,
      payload: {
        schemaVersion: 'analysis-draft-v1',
        summary: '乙的初稿',
        claims: [{ claimId: 'c1', statement: '方案 A 成本被低估', kind: 'observed', evidenceIds: ['ev1'] }],
        recommendations: [],
        openQuestions: [],
      },
    });
    addTurn(db, { id: 'turn_cr', stageKey: 'delib.cross_review' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: { taskId: TASK, runId: RUN, stage: 'CR', memberId: 'm1', roundNo: 0, purpose: 'stage_work' },
      turnId: 'turn_cr',
      finalText: JSON.stringify({
        schemaVersion: 'cross-review-v1',
        reviews: [{
          targetArtifactId: 'art_draft_m2',
          targetRevision: 1,
          targetClaimId: 'c1',
          stance: 'disagree',
          reason: '缺少成本核算',
          evidenceIds: ['ev1'],
          suggestedVerification: '补充成本表',
        }],
      }),
      options: options(blobDir),
      now: 6_100,
    });
    expectCounted(out);
    const body = bodyOf(visibleMessages(db)[0]!);
    expect(body.text).toContain('【互评】');
    expect(body.text).toContain('对结论「方案 A 成本被低估」：不同意 — 缺少成本核算');
    expect(body.text).toContain('建议验证：补充成本表');
    expect(body.text).not.toContain('art_draft_m2');
    expect(body.text).not.toContain('ev1');
    expect(body.text).not.toContain('claimId');
    expect(body.text).not.toMatch(/\{|\}/);
    expect(body.collaborationStage).toEqual({ stage: 'CROSS_REVIEW', roundNo: 0, turnId: 'turn_cr', runId: RUN });
    db.close();
  });

  it('ISS：保留「争议讨论 · 第2轮」标签，不出现 issueId/ev 原样', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    const issues = insertIssues(db, RUN, [{ issueId: 'iss_1', statement: '成本估计是否可靠', evidenceRefs: ['ev1'] }], 2);
    expect(issues.ok).toBe(true);
    addTurn(db, { id: 'turn_iss', stageKey: 'delib.issue_discussion.r2' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: { taskId: TASK, runId: RUN, stage: 'ISS', memberId: 'm1', roundNo: 2, purpose: 'stage_work' },
      turnId: 'turn_iss',
      finalText: JSON.stringify({
        schemaVersion: 'issue-position-v1',
        positions: [{
          issueId: 'iss_1',
          stance: 'agree',
          reason: '成本证据充分',
          newEvidence: [{ description: '补充了供应商报价单', evidenceId: 'ev2' }],
        }],
      }),
      options: options(blobDir),
      now: 6_200,
    });
    expectCounted(out);
    const body = bodyOf(visibleMessages(db)[0]!);
    expect(body.text).toContain('【争议讨论 · 第2轮】');
    expect(body.text).toContain('争议「成本估计是否可靠」：同意 — 成本证据充分');
    expect(body.text).toContain('新增证据：补充了供应商报价单');
    expect(body.text).not.toContain('iss_1');
    expect(body.text).not.toContain('ev2');
    expect(body.text).not.toContain('claimId');
    expect(body.text).not.toMatch(/\{|\}/);
    expect(body.collaborationStage).toEqual({ stage: 'ISSUE_DISCUSSION', roundNo: 2, turnId: 'turn_iss', runId: RUN });
    db.close();
  });

  it('RAT：保留「确认」标签，结论用整合稿文本而非 claimId 原样', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    publishSeedArtifact(db, blobDir, {
      artifactId: 'art_syn_seed',
      authorId: 'm1',
      kind: 'synthesis',
      revision: 1,
      payload: { schemaVersion: 'synthesis-v1', summary: '整合稿', claims: [{ statement: '方案 A 可行', sourceRefs: ['c1'] }], disputedClaims: [], recommendations: [] },
    });
    const claims = insertSynthesisClaims(db, {
      runId: RUN, synthesisArtifactId: 'art_syn_seed', synthesisRevision: 1,
      claims: [{ claimId: 'clm_1', statement: '方案 A 可行', sourceRefs: ['c1'] }],
    });
    expect(claims.ok).toBe(true);
    const matrix = initRatificationMatrix(db, {
      runId: RUN, synthesisArtifactId: 'art_syn_seed', synthesisRevision: 1,
      claimIds: ['clm_1'], memberIds: ['m1', 'm2'], rosterRevision: 1,
    });
    expect(matrix.ok).toBe(true);
    db.prepare("UPDATE workflow_runs SET stage = 'RATIFY' WHERE id = ?").run(RUN);
    addTurn(db, { id: 'turn_rat', stageKey: 'delib.ratify' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: { taskId: TASK, runId: RUN, stage: 'RAT', memberId: 'm1', roundNo: 0, purpose: 'stage_work' },
      turnId: 'turn_rat',
      finalText: JSON.stringify({ schemaVersion: 'ratify-v1', responses: [{ claimId: 'clm_1', stance: 'confirm', reason: '证据充分' }] }),
      options: options(blobDir),
      now: 6_300,
    });
    expectCounted(out);
    const body = bodyOf(visibleMessages(db)[0]!);
    expect(body.text).toContain('【确认】');
    expect(body.text).toContain('结论「方案 A 可行」：确认 — 证据充分');
    expect(body.text).not.toContain('clm_1');
    expect(body.text).not.toContain('art_syn_seed');
    expect(body.text).not.toContain('claimId');
    expect(body.text).not.toMatch(/\{|\}/);
    expect(body.collaborationStage).toEqual({ stage: 'RATIFY', roundNo: 0, turnId: 'turn_rat', runId: RUN });
    db.close();
  });

  it('CHK：collaborationStage.stage 归入 ISSUE_DISCUSSION，正文含「检查点」', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_chk', stageKey: 'delib.issue_discussion.chk', purpose: 'checkpoint' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: { taskId: TASK, runId: RUN, stage: 'CHK', memberId: 'm1', roundNo: 3, purpose: 'checkpoint' },
      turnId: 'turn_chk',
      finalText: JSON.stringify({
        schemaVersion: 'checkpoint-verdict-v1',
        verdict: 'continue',
        reason: '仍有两点待验证',
        evidenceSummary: '新增了两组基准测试',
      }),
      options: options(blobDir),
      now: 6_400,
    });
    expectCounted(out);
    const rows = visibleMessages(db);
    expect(rows).toHaveLength(1);
    const body = bodyOf(rows[0]!);
    // CHK 归入既有阶段枚举，不发明客户端猜测值 CHECKPOINT。
    expect(body.collaborationStage).toEqual({ stage: 'ISSUE_DISCUSSION', roundNo: 3, turnId: 'turn_chk', runId: RUN });
    expect(body.text).toContain('【争议讨论 · 检查点 · 第3轮】');
    expect(body.text).toContain('检查点结论：继续研讨');
    expect(body.text).toContain('理由：仍有两点待验证');
    expect(body.text).toContain('新证据摘要：新增了两组基准测试');
    expect(body.text).not.toContain('checkpoint-verdict-v1');
    expect(body.text).not.toContain('schemaVersion');
    db.close();
  });
});

describe('g. DB 状态：负例只停止「成功发言」，原审计与运行状态保留', () => {
  it('停止路径：run.lateArrivalRecorded + artifact 行在、participants 不被转成功', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_stop_audit', stageKey: 'delib.independent' });
    db.prepare('UPDATE tasks SET stop_generation = 1 WHERE id = ?').run(TASK);

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_stop_audit',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 7_000,
    });
    expectLateRecorded(out);
    // 原审计：artifact 与迟到事件都在。
    expect(artifactRow(db, 'art_turn_stop_audit')).toMatchObject({ run_id: RUN, kind: 'analysis_draft', author_id: 'm1' });
    const events = eventsOfKind(db, 'run.lateArrivalRecorded');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload_json)).toMatchObject({
      memberId: 'm1', stage: 'IND', roundNo: 0, reason: 'task-stopped', artifactId: 'art_turn_stop_audit', counted: false,
    });
    // 只不转成功发言：无消息、participants 不进 completed、run 不推进。
    expect(visibleMessages(db)).toHaveLength(0);
    expect(db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?').get(RUN, 'm1')).toMatchObject({ status: 'pending' });
    expect(db.prepare('SELECT status, stage FROM workflow_runs WHERE id = ?').get(RUN)).toMatchObject({ status: 'RUNNING', stage: 'INDEPENDENT' });
    expect(eventsOfKind(db, 'thread.replyAdded')).toHaveLength(0);
    db.close();
  });

  it('身份拒绝路径：无 artifact/无消息/无 completion，原有 run 状态与审计不变', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db);
    addTurn(db, { id: 'turn_identity_rejected', memberId: 'm2', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep({ memberId: 'm1' }),
      turnId: 'turn_identity_rejected',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 7_100,
    });
    expectRejected(out, 'TARGET_KIND_MISMATCH');
    expect(runArtifactCount(db)).toBe(0);
    expect(visibleMessages(db)).toHaveLength(0);
    expect(eventsOfKind(db, 'run.lateArrivalRecorded')).toHaveLength(0);
    expect((db.prepare('SELECT count(*) AS c FROM domain_events').get() as { c: number }).c).toBe(0);
    expect(db.prepare('SELECT status FROM run_participants WHERE run_id = ? AND member_id = ?').get(RUN, 'm1')).toMatchObject({ status: 'pending' });
    expect(db.prepare('SELECT status, stage FROM workflow_runs WHERE id = ?').get(RUN)).toMatchObject({ status: 'RUNNING', stage: 'INDEPENDENT' });
    db.close();
  });

  it('终态迟到路径：INTERRUPTED run 不被复活，artifact/事件仍可审计', () => {
    const db = openDatabase(':memory:');
    const blobDir = freshBlobDir();
    seed(db, { runStatus: 'INTERRUPTED' });
    addTurn(db, { id: 'turn_interrupted_audit', stageKey: 'delib.independent' });

    const out = onStepOutput(db, {
      taskId: TASK,
      runId: RUN,
      step: indStep(),
      turnId: 'turn_interrupted_audit',
      finalText: JSON.stringify(draftPayload()),
      options: options(blobDir),
      now: 7_200,
    });
    expectLateRecorded(out);
    expect(artifactRow(db, 'art_turn_interrupted_audit')).toMatchObject({ run_id: RUN });
    expect(JSON.parse(eventsOfKind(db, 'run.lateArrivalRecorded')[0]!.payload_json)).toMatchObject({ reason: 'run-INTERRUPTED' });
    expect(db.prepare('SELECT status, stage FROM workflow_runs WHERE id = ?').get(RUN)).toMatchObject({ status: 'INTERRUPTED' });
    expect(visibleMessages(db)).toHaveLength(0);
    db.close();
  });
});
