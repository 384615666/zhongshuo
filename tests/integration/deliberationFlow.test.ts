/**
 * DELIBERATE 编排集成（零额度，FakeRuntimeAdapter 逐步骤脚本）：
 * 完整正常流程（分歧→讨论→检查点→整合→确认→发布）、预算耗尽兜底。
 * 断言命令→调度→adapter→成果→屏障→最终报告全链与阶段过滤输入（IND 不含他人稿）。
 * 脚本按派发顺序即时注入（turnScripts 引用同一数组，越界用最后一条——因此每步
 * runOnce 前先 push 对应脚本，防止错误脚本被后续步骤消费）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
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

export function draft(summary: string, claims: Array<{ claimId: string; statement: string }>, detailMarkdown?: string): unknown {
  return {
    schemaVersion: 'analysis-draft-v1',
    summary,
    ...(detailMarkdown == null ? {} : { detailMarkdown }),
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
      '# 甲完整分析\n\n1. 成本项保持业务编号\n2. 风险仍需实测\n\nR95_IND_M1_TAIL',
    ))); // m1 IND
    await step(worker, scripts, done(draft(
      '乙的分析：方案 A 风险可能被低估。',
      [{ claimId: 'c1', statement: '方案 A 风险被低估' }],
      '# 乙完整分析\n\n1. 风险项\n2. 需要证据\n\nR95_IND_M2_TAIL',
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
    await step(worker, scripts, done({ schemaVersion: 'cross-review-v1', summary: '互评总览：发现一项风险论证缺口。', detailMarkdown: '# 互评完整详情\n\n1. 风险论证不足\n\nR95_CR_M1_TAIL', reviews: [
      { targetArtifactId: m2Art.id, targetRevision: 1, targetClaimId: 'c1', stance: 'disagree', reason: '风险论证不足', evidenceIds: ['ev2'] },
    ] })); // m1 CR
    await step(worker, scripts, done({ schemaVersion: 'cross-review-v1', summary: '互评总览：一项需要补证，一项同意。', detailMarkdown: '# 互评完整详情\n\n1. 需要数据\n2. 成本结论同意\n\nR95_CR_M2_TAIL', reviews: [
      { targetArtifactId: m1Art.id, targetRevision: 1, targetClaimId: 'c1', stance: 'needs_evidence', reason: '需要数据佐证', evidenceIds: ['ev3'] },
      { targetArtifactId: m1Art.id, targetRevision: 1, targetClaimId: 'c2', stance: 'agree', reason: '认同', evidenceIds: [] },
    ] })); // m2 CR
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'ISSUE_DISCUSSION' });
    const issues = db.prepare('SELECT id, statement FROM issues WHERE run_id = ?').all(runId) as Array<{ id: string; statement: string }>;
    expect(issues.length).toBeGreaterThanOrEqual(1);

    const position = (issueId: string, memberId: string, round: number) => done({
      schemaVersion: 'issue-position-v1',
      summary: `${memberId} 第${round}轮争议讨论：维持需要证据。`,
      detailMarkdown: `# ${memberId} 第${round}轮争议详情\n\n1. 立场：需要证据\n2. 未新增证据\n\nR95_ISS_${memberId}_R${round}_TAIL`,
      positions: [{ issueId, stance: 'needs_evidence', reason: '维持需要证据', newEvidence: [] }],
    });
    const issueId = issues[0]!.id;
    for (let round = 1; round <= 3; round += 1) {
      await step(worker, scripts, position(issueId, 'm1', round)); // m1
      await step(worker, scripts, position(issueId, 'm2', round)); // m2
    }
    await step(worker, scripts, done({
      schemaVersion: 'checkpoint-verdict-v1',
      summary: '检查点总览：没有新的可验证证据，转入整合。',
      detailMarkdown: '# 检查点完整详情\n\n1. 结论：停止讨论\n2. 理由：无新证据\n\nR95_CHK_TAIL',
      verdict: 'stop', reason: '无新证据，转入整合',
    })); // CHK host
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id = ?').get(runId)).toMatchObject({ stage: 'SYNTHESIS' });

    const synthesisSummary = '整合结论：方案可附条件推进，风险分歧仍保留。';
    const synthesisDetail = '# 整合完整详情\n\n1. 方案可推进\n2. 条件：补充风险清单\n3. 保留分歧：风险是否被低估\n\nR95_SYN_TAIL';
    await step(worker, scripts, done({ schemaVersion: 'synthesis-v1', summary: synthesisSummary, detailMarkdown: synthesisDetail, claims: [
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
      detailMarkdown: '# 确认完整详情\n\n1. 附条件确认\n2. 条件：补充风险清单\n\nR95_RAT_M1_TAIL',
      responses: [{ claimId: 'clm_1', stance: 'conditional', conditions: ['补充风险清单'] }],
    }));
    await step(worker, scripts, done({
      schemaVersion: 'ratify-v1',
      summary: '确认总览：本条结论确认。',
      detailMarkdown: '# 确认完整详情\n\n1. 确认\n\nR95_RAT_M2_TAIL',
      responses: [{ claimId: 'clm_1', stance: 'confirm' }],
    }));

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
        const body = JSON.parse(message.body_json) as { text: string; detailMarkdown?: string; collaborationStage: { turnId: string } };
        const artifact = db.prepare('SELECT blob_path FROM artifacts WHERE id=? AND run_id=?').get(`art_${body.collaborationStage.turnId}`, runId) as { blob_path: string };
        const canonical = JSON.parse(readFileSync(artifact.blob_path, 'utf8')) as { summary?: string; detailMarkdown?: string };
        expect(body.text, message.id).toBe(canonical.summary);
        expect(body.detailMarkdown, message.id).toBeUndefined();
        expect(canonical.detailMarkdown?.length, message.id).toBeGreaterThan(0);
        const attachment = db.prepare(`SELECT a.blob_path FROM message_attachments ma
          JOIN artifacts a ON a.id=ma.artifact_id
          WHERE ma.message_id=? AND ma.id LIKE 'matt_detail_%'`).get(message.id) as { blob_path: string } | undefined;
        expect(attachment, message.id).toBeDefined();
        expect(readFileSync(attachment!.blob_path, 'utf8'), message.id).toBe(canonical.detailMarkdown);
      }
    }
    const finalMessage = db.prepare('SELECT id,body_json FROM messages WHERE id=?').get(`msg_report_${runId}`) as { id: string; body_json: string };
    const finalBody = JSON.parse(finalMessage.body_json) as { text: string; detailMarkdown?: string; runtimeControlResult: string };
    expect(finalBody.text).toBe(synthesisSummary);
    expect(finalBody.detailMarkdown).toBeUndefined();
    const finalRuntime = JSON.parse(finalBody.runtimeControlResult) as { overallConsensus: string; claimResults: Array<{ consensus: string; conditionals: number }>; disputedClaims: unknown[] };
    expect(finalRuntime.overallConsensus).toBe('qualified');
    expect(finalRuntime.claimResults[0]).toMatchObject({ consensus: 'qualified', conditionals: 1 });
    expect(finalRuntime.disputedClaims).toHaveLength(1);
    const finalAttachment = db.prepare(`SELECT a.blob_path FROM message_attachments ma
      JOIN artifacts a ON a.id=ma.artifact_id
      WHERE ma.message_id=? AND ma.id LIKE 'matt_detail_%'`).get(finalMessage.id) as { blob_path: string } | undefined;
    expect(finalAttachment).toBeDefined();
    expect(readFileSync(finalAttachment!.blob_path, 'utf8')).toBe(synthesisDetail);
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
