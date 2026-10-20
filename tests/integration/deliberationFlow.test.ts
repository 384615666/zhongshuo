/**
 * DELIBERATE 编排集成（零额度，FakeRuntimeAdapter 逐步骤脚本）：
 * 完整正常流程（分歧→讨论→检查点→整合→确认→发布）、预算耗尽兜底。
 * 断言命令→调度→adapter→成果→屏障→最终报告全链与阶段过滤输入（IND 不含他人稿）。
 * 脚本按派发顺序即时注入（turnScripts 引用同一数组，越界用最后一条——因此每步
 * runOnce 前先 push 对应脚本，防止错误脚本被后续步骤消费）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { assembleStepInput, frozenStageInputs, pumpDeliberation } from '../../src/daemon/deliberationRunner.ts';
import { listRunArtifacts, getRatificationRecords, getSynthesisClaims, currentSynthesisVersion } from '../../src/persistence/stores/deliberation.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-delibflow-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

export function seed(db: ZhongshuoDatabase, memberIds: string[]): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','d','D:/x','D:/x','{}',0)`).run();
  const members = memberIds.map((id, i) => `('${id}','p1','成员${i + 1}','agent',1)`).join(', ');
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ${members}`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅',?)`).run(memberIds[0]);
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
}

export function createDelibTask(db: ZhongshuoDatabase, n: number, memberIds: string[]): string {
  const ids = { messageId: `msg_root_${n}`, threadId: `thread_${n}`, taskId: `task_${n}`, taskEventId: `evt_t_${n}`, threadEventId: `evt_h_${n}` };
  createRoomRootTask(db, {
    ids,
    projectId: 'p1', conversationId: 'c1', roomId: 'r1', intent: 'default',
    title: `研讨${n}`, body: `请研讨 ${n}`, mentions: memberIds.map((m) => ({ kind: 'member' as const, memberId: m })),
    author: { authorType: 'human' as const, authorId: 'u_human' },
    reviewPolicy: 'auto_deliver',
    sourceConnectionId: null,
    route: { kind: 'dispatch', mode: 'DELIBERATE', rosterSource: 'all', frozenMemberIds: memberIds, initialWakeMemberIds: memberIds } as never,
    now: 1000 + n,
  });
  // createRoomRootTask 已自带 task:{id}:initial 入队——不再手工播种（重复键会错位脚本序）。
  return ids.taskId;
}

export const done = (payload: unknown): FakeTurnScript => [{ kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify(payload) } }];

export function draft(summary: string, claims: Array<{ claimId: string; statement: string }>, document?: { filename: string; purpose: string; markdown: string } | null): unknown {
  return {
    schemaVersion: 'analysis-draft-v1',
    summary,
    ...(document === undefined ? {} : { document }),
    claims: claims.map((c) => ({ claimId: c.claimId, statement: c.statement, kind: 'observed', evidenceIds: ['ev1'] })),
    recommendations: [],
    openQuestions: [],
  };
}

export function runIdOf(db: ZhongshuoDatabase): string {
  return (db.prepare("SELECT id FROM workflow_runs WHERE mode = 'DELIBERATE'").get() as { id: string }).id;
}

/** 单步推进：先注入该步脚本再领取（防止越界回退用错误脚本）。 */
export async function step(worker: DispatchWorker, scripts: FakeTurnScript[], script?: FakeTurnScript): Promise<void> {
  if (script != null) scripts.push(script);
  if (!(await worker.runOnce())) throw new Error('预期有可领取的 outbox 项（上一步后无新步骤入队）');
}

async function reachSynthesisAfterAgreement(
  db: ZhongshuoDatabase,
  worker: DispatchWorker,
  scripts: FakeTurnScript[],
  taskNumber: number,
): Promise<{ taskId: string; runId: string }> {
  const taskId = createDelibTask(db, taskNumber, ['m1', 'm2']);
  await step(worker, scripts); // PREPARE
  await step(worker, scripts, done(draft('甲交付', [{ claimId: 'c1', statement: '结论一' }], null)));
  await step(worker, scripts, done(draft('乙交付', [{ claimId: 'c1', statement: '结论一' }], null)));
  const runId = runIdOf(db);
  const m1 = db.prepare("SELECT id FROM artifacts WHERE run_id=? AND author_id='m1' AND kind='analysis_draft'").get(runId) as { id: string };
  const m2 = db.prepare("SELECT id FROM artifacts WHERE run_id=? AND author_id='m2' AND kind='analysis_draft'").get(runId) as { id: string };
  await step(worker, scripts, done({ schemaVersion: 'cross-review-v1', summary: '互评无争议', document: null, reviews: [
    { targetArtifactId: m2.id, targetRevision: 1, targetClaimId: 'c1', stance: 'agree', reason: '一致', evidenceIds: [] },
  ] }));
  await step(worker, scripts, done({ schemaVersion: 'cross-review-v1', summary: '互评无争议', document: null, reviews: [
    { targetArtifactId: m1.id, targetRevision: 1, targetClaimId: 'c1', stance: 'agree', reason: '一致', evidenceIds: [] },
  ] }));
  return { taskId, runId };
}

describe('DELIBERATE 编排：完整正常流程（分歧→讨论→检查点→整合→确认→发布）', () => {
  it('两名成员全链路：阶段推进/输入隔离/成果/确认矩阵/最终报告共识', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const taskId = createDelibTask(db, 1, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    // 每步骤一个新会话：用全局序列器按派发顺序取脚本（会话内索引会重置）。
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'w1', enableDeliberate: true,
      absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app-full'),
    });

    await step(worker, scripts); // initial → PREPARE（程序，无模型调用）
    await step(worker, scripts, done(draft(
      '甲的分析：方案 A 成本更低，风险仍需实测。',
      [{ claimId: 'c1', statement: '方案 A 成本更低' }, { claimId: 'c2', statement: '风险可控' }],
      null,
    ))); // m1 IND
    await step(worker, scripts, done(draft(
      '乙的分析：方案 A 风险可能被低估。',
      [{ claimId: 'c1', statement: '方案 A 风险被低估' }],
      null,
    ))); // m2 IND
    const runId = runIdOf(db);
    const drafts = listRunArtifacts(db, runId, 'analysis_draft');
    expect(drafts).toHaveLength(2);

    // 输入隔离：m1 的 IND ContextBundle 只标注 INDEPENDENT 自身边界（服务端组装）。
    const bundle = db.prepare("SELECT included_refs_json FROM context_bundles cb JOIN agent_turns at ON at.id = cb.turn_id WHERE at.stage_key = 'delib.independent' AND at.member_id = 'm1'").get() as { included_refs_json: string };
    const bundleMeta = JSON.parse(bundle.included_refs_json) as { stage: string; memberId: string };
    expect(bundleMeta).toMatchObject({ stage: 'INDEPENDENT', memberId: 'm1' });
    // IND 输入正文不含他人草稿摘要（此刻仅有任务根消息）。
    const indTextHash = db.prepare("SELECT hash FROM context_bundles cb JOIN agent_turns at ON at.id = cb.turn_id WHERE at.stage_key = 'delib.independent' AND at.member_id = 'm1'").get() as { hash: string };
    expect(indTextHash.hash).toHaveLength(64);

    const m1Art = drafts.find((a) => a.author_id === 'm1')!;
    const m2Art = drafts.find((a) => a.author_id === 'm2')!;
    await step(worker, scripts, done({ schemaVersion: 'cross-review-v1', summary: '互评总览：发现一项风险论证缺口。', document: null, reviews: [
      { targetArtifactId: m2Art.id, targetRevision: 1, targetClaimId: 'c1', stance: 'disagree', reason: '风险论证不足', evidenceIds: ['ev2'] },
    ] })); // m1 CR
    await step(worker, scripts, done({ schemaVersion: 'cross-review-v1', summary: '互评总览：一项需要补证，一项同意。', document: null, reviews: [
      { targetArtifactId: m1Art.id, targetRevision: 1, targetClaimId: 'c1', stance: 'needs_evidence', reason: '需要数据佐证', evidenceIds: ['ev3'] },
      { targetArtifactId: m1Art.id, targetRevision: 1, targetClaimId: 'c2', stance: 'agree', reason: '认同', evidenceIds: [] },
    ] })); // m2 CR
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'ISSUE_DISCUSSION' });
    const issues = db.prepare('SELECT id, statement FROM issues WHERE run_id = ?').all(runId) as Array<{ id: string; statement: string }>;
    expect(issues.length).toBeGreaterThanOrEqual(1);

    const position = (issueId: string, memberId: string, round: number) => done({
      schemaVersion: 'issue-position-v1',
      summary: `${memberId} 第${round}轮争议讨论：维持需要证据。`,
      document: null,
      positions: [{ issueId, stance: 'needs_evidence', reason: '维持需要证据', newEvidence: [] }],
    });
    const issueId = issues[0]!.id;
    const issueIds = issues.map((issue) => issue.id);
    for (let round = 1; round <= 3; round += 1) {
      await step(worker, scripts, position(issueId, 'm1', round)); // m1
      await step(worker, scripts, position(issueId, 'm2', round)); // m2
    }
    await step(worker, scripts, done({
      schemaVersion: 'checkpoint-verdict-v1',
      summary: '检查点总览：没有新的可验证证据，转入整合。',
      document: null,
      verdict: 'stop', reason: '无新证据，转入整合',
    })); // CHK host
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'SYNTHESIS' });

    const synthesisSummary = '整合结论：方案可附条件推进，风险分歧仍保留。';
    const synthesisDetail = '# 整合完整详情\n\n1. 方案可推进\n2. 条件：补充风险清单\n3. 保留分歧：风险是否被低估\n\nR95_SYN_TAIL';
    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: synthesisSummary, document: { filename: '整合方案.md', purpose: '供用户执行的整合方案与保留分歧', markdown: synthesisDetail }, issueResolutions: issueIds.map((id) => ({ issueId: id, status: 'insufficient_evidence', reason: '仍存在风险争议', question: '是否需要先补证据', owner: '用户' })), claims: [
      { statement: '风险可控（双方认可）', sourceRefs: ['c2'] },
    ], disputedClaims: [
      { statement: '方案 A 风险是否被低估', disagreementSummary: '甲认为成本低，乙认为风险被低估', sourceRefs: ['c1'] },
    ], recommendations: [] }));
    const synthesis = currentSynthesisVersion(db, runId);
    expect(synthesis).not.toBeNull();
    expect(getSynthesisClaims(db, runId, synthesis!.artifactId, synthesis!.revision).map((c) => c.claim_id)).toEqual(['clm_1']);
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'RATIFY' });

    await step(worker, scripts, done({
      schemaVersion: 'ratify-v1',
      summary: '确认总览：附条件确认，需补充风险清单。',
      document: null,
      deliveryFeedback: { status: 'ready', reason: '当前整合稿可作为交付', revisionRequest: '', question: '', owner: '' },
      responses: [{ claimId: 'clm_1', stance: 'conditional', conditions: ['补充风险清单'] }],
    }));
    await step(worker, scripts, done({
      schemaVersion: 'ratify-v1',
      summary: '确认总览：本条结论确认。',
      document: null,
      deliveryFeedback: { status: 'ready', reason: '当前整合稿可作为交付', revisionRequest: '', question: '', owner: '' },
      responses: [{ claimId: 'clm_1', stance: 'confirm' }],
    }));
    const ratBundle = db.prepare(`SELECT cb.included_refs_json FROM context_bundles cb
      JOIN agent_turns a ON a.id=cb.turn_id WHERE a.run_id=? AND a.stage_key='delib.ratify' AND a.member_id='m1'
      ORDER BY cb.rowid DESC LIMIT 1`).get(runId) as { included_refs_json: string } | undefined;
    expect(ratBundle?.included_refs_json).toContain('R95_SYN_TAIL');

    const taskRow = db.prepare('SELECT status, current_delivery_id FROM tasks WHERE id = ?').get(taskId) as { status: string; current_delivery_id: string | null };
    expect(taskRow.status).toBe('DONE');
    expect(db.prepare('SELECT stage, status FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'PUBLISH', status: 'SUCCEEDED' });
    const reports = listRunArtifacts(db, runId, 'final_report');
    expect(reports).toHaveLength(1);
    const reportPayload = JSON.parse(readFileSync(reports[0]!.blob_path, 'utf8')) as { overallConsensus: string; claimResults: Array<{ consensus: string; conditionals: number }> };
    expect(reportPayload.overallConsensus).toBe('qualified');
    expect(reportPayload.claimResults[0]).toMatchObject({ consensus: 'qualified', conditionals: 1 });
    const records = getRatificationRecords(db, runId, synthesis!.artifactId, synthesis!.revision);
    expect(records.filter((r) => r.response_status === 'submitted')).toHaveLength(2);
    expect(records.some((r) => r.stance === 'conditional' && r.conditions_json != null)).toBe(true);
    const threadId = (db.prepare('SELECT conversation_thread_id FROM tasks WHERE id = ?').get(taskId) as { conversation_thread_id: string }).conversation_thread_id;
    const expectedStageCounts = { IND: 2, CR: 2, ISS: 6, CHK: 1, SYN: 1, RAT: 2 } as const;
    for (const [code, expected] of Object.entries(expectedStageCounts)) {
      const stageMessages = db.prepare(`SELECT id,body_json FROM messages
        WHERE thread_id=? AND id LIKE ? ORDER BY rowid`).all(threadId, `msg_delib_${runId}_${code}_%`) as Array<{ id: string; body_json: string }>;
      expect(stageMessages, code).toHaveLength(expected);
      for (const message of stageMessages) {
        const body = JSON.parse(message.body_json) as { text: string; detailMarkdown?: string; document?: { filename?: string; purpose?: string; artifactId?: string; markdown?: string }; collaborationStage: { turnId: string } };
        const artifact = db.prepare('SELECT blob_path FROM artifacts WHERE id=? AND run_id=?').get(`art_${body.collaborationStage.turnId}`, runId) as { blob_path: string };
        const canonical = JSON.parse(readFileSync(artifact.blob_path, 'utf8')) as { summary?: string; document?: { filename?: string; purpose?: string; markdown?: string } | null; detailMarkdown?: string };
        expect(body.text, message.id).toBe(canonical.summary);
        expect(body.detailMarkdown, message.id).toBeUndefined();
        expect(canonical.detailMarkdown, message.id).toBeUndefined();
        const attachment = db.prepare(`SELECT a.blob_path FROM message_attachments ma
          JOIN artifacts a ON a.id=ma.artifact_id
          WHERE ma.message_id=? AND ma.id LIKE 'matt_detail_%'`).get(message.id) as { blob_path: string } | undefined;
        if (code === 'SYN') {
          expect(canonical.document?.filename, message.id).toBe('整合方案.md');
          expect(canonical.document?.purpose, message.id).toBe('供用户执行的整合方案与保留分歧');
          expect(canonical.document?.markdown, message.id).toBe(synthesisDetail);
          expect(body.document?.artifactId, message.id).toBeTruthy();
          expect(attachment, message.id).toBeDefined();
          expect(readFileSync(attachment!.blob_path, 'utf8'), message.id).toBe(synthesisDetail);
        } else {
          expect(canonical.document, message.id).toBeNull();
          expect(attachment, message.id).toBeUndefined();
        }
      }
    }
    const finalMessage = db.prepare('SELECT id,body_json FROM messages WHERE id=?').get(`msg_report_${runId}`) as { id: string; body_json: string };
    const finalBody = JSON.parse(finalMessage.body_json) as { text: string; detailMarkdown?: string; document?: { artifactId?: string; filename?: string; purpose?: string }; delivery?: { status?: string }; runtimeControlResult: string };
    expect(finalBody.text).toBe(synthesisSummary);
    expect(finalBody.detailMarkdown).toBeUndefined();
    expect(finalBody.document).toMatchObject({ filename: '整合方案.md', purpose: '供用户执行的整合方案与保留分歧' });
    expect(finalBody.document?.artifactId).toBeTruthy();
    expect(finalBody.delivery?.status).toBe('delivered_with_questions');
    const finalRuntime = JSON.parse(finalBody.runtimeControlResult) as { overallConsensus: string; claimResults: Array<{ consensus: string; conditionals: number }>; disputedClaims: unknown[]; deliveryStatus: string };
    expect(finalRuntime.overallConsensus).toBe('qualified');
    expect(finalRuntime.claimResults[0]).toMatchObject({ consensus: 'qualified', conditionals: 1 });
    expect(finalRuntime.disputedClaims).toHaveLength(1);
    expect(finalRuntime.deliveryStatus).toBe('delivered_with_questions');
    const finalAttachment = db.prepare(`SELECT a.id artifact_id,a.blob_path FROM message_attachments ma
      JOIN artifacts a ON a.id=ma.artifact_id
      WHERE ma.message_id=? AND ma.id LIKE 'matt_detail_%'`).get(finalMessage.id) as { artifact_id: string; blob_path: string } | undefined;
    expect(finalAttachment).toBeDefined();
    expect(readFileSync(finalAttachment!.blob_path, 'utf8')).toBe(synthesisDetail);
    expect(finalAttachment!.artifact_id).toBe(finalBody.document?.artifactId);
    // 预算账：14 步全结算（IND2+CR2+ISS6+CHK1+SYN1+RAT2，host 多承担 CHK/SYN），尾部保留清零；
    const budget = JSON.parse((db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json) as { usedTurns: number; tailReservationByStage: { SYNTHESIS: number; RATIFY: number } };
    expect(budget.usedTurns).toBe(14);
    expect(budget.tailReservationByStage.SYNTHESIS).toBe(0);
    expect(budget.tailReservationByStage.RATIFY).toBe(0);
    // §6.2 会话隔离：每步骤新任务专用会话（不复用看过同题他人报告的会话）——
    // 14 步 14 会话，且每成员各 7 个、无共享。
    expect((db.prepare('SELECT count(*) c FROM runtime_sessions').get() as { c: number }).c).toBe(14);
    expect(db.prepare("SELECT count(*) c FROM runtime_sessions WHERE member_id = 'm1'").get()).toMatchObject({ c: 8 });
    expect(db.prepare("SELECT count(*) c FROM runtime_sessions WHERE member_id = 'm2'").get()).toMatchObject({ c: 6 });
    await adapter.closeAllSessions();
    db.close();
  }, 60_000);
});

describe('R96 delivery feedback and bounded revision', () => {
  it('uses one new SYN revision and a fresh RAT matrix for needs_revision', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r96-revision', enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app-r96-revision') });
    const { taskId, runId } = await reachSynthesisAfterAgreement(db, worker, scripts, 21);
    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: '第一版方案', document: null, issueResolutions: [], claims: [{ statement: '方案 A', sourceRefs: ['c1'] }], disputedClaims: [], recommendations: [] }));
    const feedback = { status: 'needs_revision' as const, reason: '交付目标未完全覆盖', revisionRequest: '补充回滚步骤并保留既有验证', question: '', owner: '' };
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '需要修订', document: null, deliveryFeedback: feedback, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '需要修订', document: null, deliveryFeedback: feedback, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    expect(db.prepare('SELECT stage, round_no FROM workflow_runs WHERE id=?').get(runId)).toMatchObject({ stage: 'SYNTHESIS', round_no: 1 });
    const first = listRunArtifacts(db, runId, 'synthesis');
    expect(first).toHaveLength(1);
    expect(getRatificationRecords(db, runId, first[0]!.id, 1).filter((r) => r.response_status === 'submitted')).toHaveLength(2);

    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: '第二版方案', document: null, issueResolutions: [], claims: [{ statement: '方案 A', sourceRefs: ['c1'] }], disputedClaims: [], recommendations: [] }));
    const revisionBundle = db.prepare(`SELECT cb.included_refs_json FROM context_bundles cb
      JOIN agent_turns a ON a.id=cb.turn_id WHERE a.run_id=? AND a.stage_key='delib.synthesis.r1'
      ORDER BY cb.rowid DESC LIMIT 1`).get(runId) as { included_refs_json: string } | undefined;
    expect(revisionBundle?.included_refs_json).toContain('补充回滚步骤并保留既有验证');
    const beforePump = JSON.parse((db.prepare('SELECT budget_json FROM workflow_runs WHERE id=?').get(runId) as { budget_json: string }).budget_json) as { usedTurns: number };
    for (let i = 0; i < 3; i += 1) {
      const pumped = pumpDeliberation(db, taskId, { absenceToleranceMs: 60_000, blobDir: join(tmpRoot, 'app-r96-revision') });
      expect(pumped.advanced).toBe(false);
    }
    expect(JSON.parse((db.prepare('SELECT budget_json FROM workflow_runs WHERE id=?').get(runId) as { budget_json: string }).budget_json).usedTurns).toBe(beforePump.usedTurns);
    expect(db.prepare('SELECT count(*) n FROM messages WHERE id=?').get(`msg_report_${runId}`)).toEqual({ n: 0 });
    const versions = listRunArtifacts(db, runId, 'synthesis');
    expect(versions.map((a) => a.revision)).toEqual([1, 2]);
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '可交付', document: null, deliveryFeedback: { status: 'ready', reason: '已覆盖交付目标', revisionRequest: '', question: '', owner: '' }, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '可交付', document: null, deliveryFeedback: { status: 'ready', reason: '已覆盖交付目标', revisionRequest: '', question: '', owner: '' }, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    const current = currentSynthesisVersion(db, runId)!;
    expect(current.revision).toBe(2);
    expect(getRatificationRecords(db, runId, current.artifactId, 2).filter((r) => r.response_status === 'submitted')).toHaveLength(2);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'DONE' });
    await adapter.closeAllSessions();
    db.close();
  });

  it('rejects a synthesis revision input whose frozen identity was changed', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r96-revision-identity', enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app-r96-revision-identity') });
    const { taskId, runId } = await reachSynthesisAfterAgreement(db, worker, scripts, 25);
    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: '第一版方案', document: null, issueResolutions: [], claims: [{ statement: '方案 A', sourceRefs: ['c1'] }], disputedClaims: [], recommendations: [] }));
    const feedback = { status: 'needs_revision' as const, reason: '交付目标未完全覆盖', revisionRequest: '补充回滚步骤', question: '', owner: '' };
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '需要修订', document: null, deliveryFeedback: feedback, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '需要修订', document: null, deliveryFeedback: feedback, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));

    const stage = 'SYNTHESIS_REVISION';
    const round = 1;
    const key = `delib:${runId}:inputs:${stage}:${round}`;
    const frozen = frozenStageInputs(db, runId, stage, round);
    expect(frozen).not.toBeNull();
    const synthesisEntry = frozen!.entries.find((entry) => {
      const row = db.prepare('SELECT kind FROM artifacts WHERE id = ?').get(entry.artifactId) as { kind: string } | undefined;
      return row?.kind === 'synthesis';
    });
    expect(synthesisEntry).toBeDefined();
    const artifact = db.prepare('SELECT run_id, revision, hash, kind, blob_path FROM artifacts WHERE id = ?').get(synthesisEntry!.artifactId) as
      { run_id: string | null; revision: number; hash: string; kind: string; blob_path: string };
    const originalBlob = readFileSync(artifact.blob_path);
    const originalManifest = (db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(key) as { value: string }).value;
    const stepInput = { taskId, runId, step: { taskId, runId, stage: 'SYN' as const, memberId: 'm1', roundNo: round, purpose: 'stage_work' as const } };
    const expectRejected = (messageContains?: string): void => {
      const assembled = assembleStepInput(db, stepInput);
      expect(assembled.ok).toBe(false);
      if (!assembled.ok) {
        expect(assembled.error.code).toBe('VALIDATION_INVALID');
        expect(assembled.error.message).toContain(stage);
        if (messageContains != null) expect(assembled.error.message).toContain(messageContains);
      }
    };

    try {
      db.prepare('UPDATE artifacts SET run_id = ? WHERE id = ?').run('run_foreign', synthesisEntry!.artifactId);
      expectRejected();
      db.prepare('UPDATE artifacts SET run_id = ? WHERE id = ?').run(artifact.run_id, synthesisEntry!.artifactId);

      db.prepare('UPDATE artifacts SET revision = ? WHERE id = ?').run(artifact.revision + 1, synthesisEntry!.artifactId);
      expectRejected();
      db.prepare('UPDATE artifacts SET revision = ? WHERE id = ?').run(artifact.revision, synthesisEntry!.artifactId);

      db.prepare('UPDATE artifacts SET hash = ? WHERE id = ?').run('0'.repeat(64), synthesisEntry!.artifactId);
      expectRejected();
      db.prepare('UPDATE artifacts SET hash = ? WHERE id = ?').run(artifact.hash, synthesisEntry!.artifactId);

      db.prepare('UPDATE artifacts SET kind = ? WHERE id = ?').run('text_file', synthesisEntry!.artifactId);
      expectRejected();
      db.prepare('UPDATE artifacts SET kind = ? WHERE id = ?').run(artifact.kind, synthesisEntry!.artifactId);

      writeFileSync(artifact.blob_path, Buffer.concat([originalBlob, Buffer.from('\n')]));
      expectRejected('哈希');
      writeFileSync(artifact.blob_path, originalBlob);

      db.prepare('DELETE FROM daemon_state WHERE key = ?').run(key);
      expectRejected('缺失');
    } finally {
      db.prepare('UPDATE artifacts SET run_id = ?, revision = ?, hash = ?, kind = ? WHERE id = ?')
        .run(artifact.run_id, artifact.revision, artifact.hash, artifact.kind, synthesisEntry!.artifactId);
      writeFileSync(artifact.blob_path, originalBlob);
      db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, originalManifest, Date.now());
    }

    const restored = assembleStepInput(db, stepInput);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.value.text).toContain('补充回滚步骤');
    await adapter.closeAllSessions();
    db.close();
  });

  it('publishes needs_user as WAITING_USER/PARTIAL with actionable question and owner', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r96-needs-user', enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app-r96-needs-user') });
    const { taskId, runId } = await reachSynthesisAfterAgreement(db, worker, scripts, 22);
    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: '方案待外部确认', document: null, issueResolutions: [], claims: [{ statement: '方案 A', sourceRefs: ['c1'] }], disputedClaims: [], recommendations: [] }));
    const feedback = { status: 'needs_user' as const, reason: '需要外部确认', revisionRequest: '', question: '请确认生产窗口', owner: '用户' };
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '等待用户', document: null, deliveryFeedback: feedback, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '等待用户', document: null, deliveryFeedback: feedback, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'WAITING_USER' });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(runId)).toEqual({ status: 'PARTIAL' });
    const final = db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${runId}`) as { body_json: string };
    const body = JSON.parse(final.body_json) as { delivery?: { status?: string }; runtimeControlResult?: string };
    expect(body.delivery?.status).toBe('needs_user');
    const report = JSON.parse(body.runtimeControlResult ?? '{}') as { deliveryFeedback?: Array<{ question?: string; owner?: string }> };
    expect(report.deliveryFeedback).toContainEqual(expect.objectContaining({ question: '请确认生产窗口', owner: '用户' }));
    await adapter.closeAllSessions();
    db.close();
  });

  it('does not invent a revision slot and publishes partial when the frozen budget is insufficient', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r96-budget', enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app-r96-budget'), deliberateMaxTurns: 8 });
    const { taskId, runId } = await reachSynthesisAfterAgreement(db, worker, scripts, 23);
    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: '预算边缘方案', document: null, issueResolutions: [], claims: [{ statement: '方案 A', sourceRefs: ['c1'] }], disputedClaims: [], recommendations: [] }));
    const feedback = { status: 'needs_revision' as const, reason: '内部仍需修订', revisionRequest: '补充缺失步骤', question: '', owner: '' };
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '需要修订', document: null, deliveryFeedback: feedback, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', summary: '需要修订', document: null, deliveryFeedback: feedback, responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'BLOCKED' });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(runId)).toEqual({ status: 'PARTIAL' });
    expect(listRunArtifacts(db, runId, 'synthesis')).toHaveLength(1);
    const final = db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${runId}`) as { body_json: string };
    const body = JSON.parse(final.body_json) as { delivery?: { status?: string }; runtimeControlResult?: string };
    expect(body.delivery?.status).toBe('blocked');
    expect((JSON.parse(body.runtimeControlResult ?? '{}') as { deliveryStatus?: string }).deliveryStatus).toBe('blocked');
    await adapter.closeAllSessions();
    db.close();
  });

  it('never treats one legacy RAT submission plus a missing member as complete legacy delivery', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r96-legacy-missing', enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app-r96-legacy-missing') });
    const { taskId, runId } = await reachSynthesisAfterAgreement(db, worker, scripts, 24);
    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: '旧式整合稿', document: null, issueResolutions: [], claims: [{ statement: '方案 A', sourceRefs: ['c1'] }], disputedClaims: [], recommendations: [] }));
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));
    db.prepare("UPDATE run_participants SET status='absent' WHERE run_id=? AND member_id='m2'").run(runId);
    db.prepare("DELETE FROM outbox WHERE dispatch_key LIKE ?").run(`task:${taskId}:delib:${runId}:RAT:m2:%`);
    const pumped = pumpDeliberation(db, taskId, { absenceToleranceMs: 60_000, blobDir: join(tmpRoot, 'app-r96-legacy-missing') });
    expect(pumped.advanced).toBe(true);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'BLOCKED' });
    expect(db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(runId)).toEqual({ status: 'PARTIAL' });
    const final = db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${runId}`) as { body_json: string };
    expect((JSON.parse(final.body_json) as { delivery?: { status?: string } }).delivery?.status).toBe('blocked');
    await adapter.closeAllSessions();
    db.close();
  });
});

describe('DELIBERATE 编排：预算耗尽兜底（不无界调用）', () => {
  it('前置耗尽后跳过讨论直接整合；SYNTHESIS/RATIFY 尾部保证；报告如实 disputed', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const taskId = createDelibTask(db, 2, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({ schemaVersion: 'analysis-draft-v1' }) });
    // runMaxTurns=7：IND×2+CR×2 后前置耗尽（T=S+Q=3 保留）——讨论零调用，尾部保证整合与确认。
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'w1', enableDeliberate: true,
      absenceToleranceMs: 60_000, appDataDir: join(tmpRoot, 'app-budget'), deliberateMaxTurns: 7,
    });
    await step(worker, scripts); // PREPARE
    await step(worker, scripts, done(draft('甲', [{ claimId: 'c1', statement: '结论一' }])));
    await step(worker, scripts, done(draft('乙', [{ claimId: 'c1', statement: '结论一（乙）' }])));
    const runId = runIdOf(db);
    const drafts = listRunArtifacts(db, runId, 'analysis_draft');
    await step(worker, scripts, done({ schemaVersion: 'cross-review-v1', reviews: [
      { targetArtifactId: drafts.find((a) => a.author_id !== 'm1')!.id, targetRevision: 1, targetClaimId: 'c1', stance: 'disagree', reason: '异议', evidenceIds: [] },
    ] }));
    await step(worker, scripts, done({ schemaVersion: 'cross-review-v1', reviews: [
      { targetArtifactId: drafts.find((a) => a.author_id !== 'm2')!.id, targetRevision: 1, targetClaimId: 'c1', stance: 'disagree', reason: '异议', evidenceIds: [] },
    ] }));
    // 互评后讨论步骤被入队但派发时预算拒绝（budgetSkipped，无模型调用）——两步被领取即完结。
    await step(worker, scripts);
    await step(worker, scripts);
    // 预算耗尽后直接转 SYNTHESIS（尾部 S）。
    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: '预算受限下的整合', claims: [{ statement: '共同结论', sourceRefs: ['c1'] }], disputedClaims: [], recommendations: [] }));
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', responses: [{ claimId: 'clm_1', stance: 'object', reason: '证据不足' }] }));
    await step(worker, scripts, done({ schemaVersion: 'ratify-v1', responses: [{ claimId: 'clm_1', stance: 'confirm' }] }));

    const reports = listRunArtifacts(db, runId, 'final_report');
    expect(reports).toHaveLength(1);
    const payload = JSON.parse(readFileSync(reports[0]!.blob_path, 'utf8')) as { overallConsensus: string };
    expect(payload.overallConsensus).toBe('disputed');
    expect((db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('DONE');
    const legacyFinal = db.prepare('SELECT id,body_json FROM messages WHERE id=?').get(`msg_report_${runId}`) as { id: string; body_json: string };
    const legacyBody = JSON.parse(legacyFinal.body_json) as { text: string; detailMarkdown?: string };
    expect(legacyBody.text).toContain('预算受限下的整合');
    expect(legacyBody.text).toContain('共同结论（存在分歧）');
    expect(legacyBody.detailMarkdown).toBeUndefined();
    expect(db.prepare('SELECT count(*) n FROM message_attachments WHERE message_id=?').get(legacyFinal.id)).toEqual({ n: 0 });
    // 讨论零调用：无 issue_position/checkpoint 产物（预算拒绝，不冒充已讨论）。
    expect(listRunArtifacts(db, runId, 'issue_position')).toHaveLength(0);
    expect(listRunArtifacts(db, runId, 'checkpoint_verdict')).toHaveLength(0);
    const budget = JSON.parse((db.prepare('SELECT budget_json FROM workflow_runs WHERE id = ?').get(runId) as { budget_json: string }).budget_json) as { usedTurns: number };
    expect(budget.usedTurns).toBe(7); // IND2+CR2+SYN1+RAT2 恰好用满，讨论零调用
    await adapter.closeAllSessions();
    db.close();
  }, 60_000);
});
