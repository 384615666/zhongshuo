import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/persistence/db.ts';
import type { ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { createRoomRootTask } from '../../src/persistence/stores/roomRootTask.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../../src/adapter/fake/script.ts';
import { deliberationOutputSchema, pumpDeliberation } from '../../src/daemon/deliberationRunner.ts';
import { selectStageInstruction } from '../../src/contracts/prompts.ts';
import { ratifyIssueResponseSchema } from '../../src/contracts/deliberation.ts';
import { currentSynthesisVersion, listRunArtifacts } from '../../src/persistence/stores/deliberation.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-ratify-issue-closure-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function seed(db: ZhongshuoDatabase, memberIds: string[]): void {
  db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
    VALUES ('p1','项目','D:/workspace','D:/workspace','{}',0)`).run();
  const members = memberIds.map((id, i) => `('${id}','p1','成员${i + 1}','agent',1)`).join(', ');
  db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ${members}`).run();
  db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('r1','p1','大厅',?)`).run(memberIds[0]);
  db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('c1','p1','room','r1')`).run();
}

function createTask(db: ZhongshuoDatabase): string {
  const ids = { messageId: 'msg_root', threadId: 'thread_root', taskId: 'task_root', taskEventId: 'evt_task', threadEventId: 'evt_thread' };
  createRoomRootTask(db, {
    ids,
    projectId: 'p1',
    conversationId: 'c1',
    roomId: 'r1',
    intent: 'default',
    title: 'RATIFY issue closure',
    body: '确认修订稿中的议题',
    mentions: ['m1', 'm2'].map((memberId) => ({ kind: 'member' as const, memberId })),
    author: { authorType: 'human' as const, authorId: 'u1' },
    reviewPolicy: 'auto_deliver',
    sourceConnectionId: null,
    route: {
      kind: 'dispatch', mode: 'DELIBERATE', rosterSource: 'all',
      frozenMemberIds: ['m1', 'm2'], initialWakeMemberIds: ['m1', 'm2'],
    } as never,
    now: 1,
  });
  return ids.taskId;
}

const done = (payload: unknown): FakeTurnScript => [
  { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify(payload) } },
];

function draft(summary: string, statement: string): unknown {
  return {
    schemaVersion: 'analysis-draft-v1',
    summary,
    document: null,
    claims: [{ claimId: 'c1', statement, kind: 'observed', evidenceIds: ['ev1'] }],
    recommendations: [],
    openQuestions: [],
  };
}

async function step(worker: DispatchWorker, scripts: FakeTurnScript[], script?: FakeTurnScript): Promise<void> {
  if (script != null) scripts.push(script);
  if (!(await worker.runOnce())) throw new Error('expected an outbox item');
}

function runIdOf(db: ZhongshuoDatabase): string {
  return (db.prepare("SELECT id FROM workflow_runs WHERE mode='DELIBERATE' ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
}

async function reachRatifyWithIssue(
  db: ZhongshuoDatabase,
  worker: DispatchWorker,
  scripts: FakeTurnScript[],
  synthesisStatus: 'insufficient_evidence' | 'needs_user' = 'insufficient_evidence',
  synthesisDocument: { filename: string; purpose: string; markdown: string } | null = {
    filename: '合成整合稿.md', purpose: '合成整合稿', markdown: '# 合成整合稿\n\n完整正文。',
  },
  includeDocument = true,
) {
  const taskId = createTask(db);
  await step(worker, scripts);
  await step(worker, scripts, done(draft('甲：方案可做', '方案 A')));
  await step(worker, scripts, done(draft('乙：方案有风险', '方案 A')));
  const runId = runIdOf(db);
  const drafts = listRunArtifacts(db, runId, 'analysis_draft');
  const m1 = drafts.find((row) => row.author_id === 'm1')!;
  const m2 = drafts.find((row) => row.author_id === 'm2')!;

  // Only m2's claim becomes an issue: m1 disagrees with it; m2 agrees with m1.
  await step(worker, scripts, done({
    schemaVersion: 'cross-review-v1', summary: '互评', document: null,
    reviews: [{ targetArtifactId: m2.id, targetRevision: 1, targetClaimId: 'c1', stance: 'disagree', reason: '证据不足', evidenceIds: [] }],
  }));
  await step(worker, scripts, done({
    schemaVersion: 'cross-review-v1', summary: '互评', document: null,
    reviews: [{ targetArtifactId: m1.id, targetRevision: 1, targetClaimId: 'c1', stance: 'agree', reason: '同意', evidenceIds: [] }],
  }));
  const issue = db.prepare('SELECT id FROM issues WHERE run_id=? ORDER BY id LIMIT 1').get(runId) as { id: string };

  const position = (memberId: string, round: number) => done({
    schemaVersion: 'issue-position-v1', summary: `${memberId} 第${round}轮`, document: null,
    positions: [{ issueId: issue.id, stance: 'agree', reason: '已核对', newEvidence: [] }],
  });
  for (let round = 1; round <= 3; round += 1) {
    await step(worker, scripts, position('m1', round));
    await step(worker, scripts, position('m2', round));
  }
  await step(worker, scripts, done({
    schemaVersion: 'checkpoint-verdict-v1', summary: '停止讨论', document: null,
    verdict: 'stop', reason: '没有新证据',
  }));
  await step(worker, scripts, done({
    schemaVersion: 'synthesis-v1', summary: '修订整合稿',
    ...(includeDocument ? { document: synthesisDocument } : {}),
    issueResolutions: [{
      issueId: issue.id,
      status: synthesisStatus,
      reason: '仍需最终确认',
      ...(synthesisStatus === 'needs_user' ? { question: '需要用户决定什么？', owner: '用户' } : {}),
    }],
    claims: [{ statement: '方案 A 可按条件推进', sourceRefs: ['c1'] }],
    disputedClaims: [], recommendations: [],
  }));
  return { taskId, runId, issueId: issue.id };
}

type RatifyTemplate = {
  summary?: string;
  omitSummary?: boolean;
  deliveryFeedback: {
    status: 'ready' | 'needs_revision' | 'needs_user';
    reason: string;
    revisionRequest?: string;
    question?: string;
    owner?: string;
  };
  issueResponses?: Array<{ issueId: string; stance: 'resolved' | 'still_open'; reason: string }>;
  responses: Array<{ claimId: string; stance: 'confirm' | 'conditional' | 'object' | 'unconfirmed'; conditions?: string[]; reason?: string }>;
};

async function runRatifyScenario(input: {
  synthesisStatus?: 'insufficient_evidence' | 'needs_user';
  synthesisDocument?: { filename: string; purpose: string; markdown: string } | null;
  includeDocument?: boolean;
  ratify: (issueId: string, memberIndex: number) => RatifyTemplate;
  dbFile?: string;
  beforeRatify?: (db: ZhongshuoDatabase, issueId: string) => void;
}) {
  const db = openDatabase(input.dbFile ?? ':memory:');
  seed(db, ['m1', 'm2']);
  const scripts: FakeTurnScript[] = [];
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({}) });
  const worker = new DispatchWorker({
    db, adapter, leaseOwner: `ratify-issue-${Math.random()}`, enableDeliberate: true,
    absenceToleranceMs: 60_000, deliberateMaxTurns: 40, appDataDir: join(root, `app-${Math.random()}`),
  });
  const flow = await reachRatifyWithIssue(db, worker, scripts, input.synthesisStatus, input.synthesisDocument, input.includeDocument);
  input.beforeRatify?.(db, flow.issueId);
  for (let memberIndex = 0; memberIndex < 2; memberIndex += 1) {
    const template = input.ratify(flow.issueId, memberIndex);
    await step(worker, scripts, done({
      schemaVersion: 'ratify-v1',
      ...(template.omitSummary ? {} : { summary: template.summary ?? `成员 ${memberIndex + 1} 确认` }),
      document: null,
      deliveryFeedback: template.deliveryFeedback,
      ...(template.issueResponses != null ? { issueResponses: template.issueResponses } : {}),
      responses: template.responses,
    }));
  }
  return { ...flow, db };
}

function reportOf(db: ZhongshuoDatabase, runId: string) {
  const report = listRunArtifacts(db, runId, 'final_report')[0];
  if (report == null) throw new Error('final report missing');
  return JSON.parse(readFileSync(report.blob_path, 'utf8')) as {
    deliveryStatus: string;
    issueResolutions: Array<{ issueId: string; status: string }>;
    unresolvedIssues: Array<{ id: string; status: string }>;
  };
}

describe('RATIFY explicit issue closure', () => {
  it('closes the exact frozen issue only after every expected member explicitly resolves it and delivery is ready', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({}) });
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'ratify-issue', enableDeliberate: true,
      absenceToleranceMs: 60_000, deliberateMaxTurns: 40, appDataDir: join(root, 'app'),
    });
    const { taskId, runId, issueId } = await reachRatifyWithIssue(db, worker, scripts);
    const synthesis = currentSynthesisVersion(db, runId)!;
    expect(synthesis).not.toBeNull();

    for (const memberId of ['m1', 'm2']) {
      await step(worker, scripts, done({
        schemaVersion: 'ratify-v1', summary: `${memberId} 确认`, document: null,
        deliveryFeedback: { status: 'ready', reason: '冻结稿可交付', revisionRequest: '', question: '', owner: '' },
        issueResponses: [{ issueId, stance: 'resolved', reason: '本次冻结稿已解决该议题' }],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }));
    }

    const ratBundle = db.prepare(`SELECT cb.included_refs_json FROM context_bundles cb
      JOIN agent_turns a ON a.id=cb.turn_id WHERE a.run_id=? AND a.stage_key LIKE 'delib.ratify%'
      ORDER BY cb.rowid DESC LIMIT 1`).get(runId) as { included_refs_json: string } | undefined;
    expect(ratBundle?.included_refs_json).toContain(issueId);
    expect(ratBundle?.included_refs_json).toContain(synthesis.artifactId);
    expect(JSON.stringify(deliberationOutputSchema('RAT'))).toContain('issueResponses');
    expect(ratifyIssueResponseSchema.safeParse({ issueId, stance: 'resolved', reason: '   ' }).success).toBe(false);
    const ratifyInstruction = selectStageInstruction({ mode: 'DELIBERATE', role: 'member', stage: 'RATIFY', turnPurpose: 'stage_work' });
    expect(ratifyInstruction.ok).toBe(true);
    if (ratifyInstruction.ok) expect(ratifyInstruction.value).toContain('issueResponses');
    expect(db.prepare('SELECT status FROM issues WHERE id=?').get(issueId)).toEqual({ status: 'resolved' });
    const report = listRunArtifacts(db, runId, 'final_report')[0]!;
    const payload = JSON.parse(readFileSync(report.blob_path, 'utf8')) as {
      deliveryStatus: string;
      issueResolutions: Array<{ issueId: string; status: string }>;
      unresolvedIssues: unknown[];
    };
    expect(payload.deliveryStatus).toBe('delivered');
    expect(payload.unresolvedIssues).toEqual([]);
    expect(payload.issueResolutions).toContainEqual(expect.objectContaining({ issueId, status: 'resolved' }));
    const finalMessage = db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${runId}`) as { body_json: string };
    const finalBody = JSON.parse(finalMessage.body_json) as {
      text: string;
      summaryRef?: { artifactId?: string; turnId?: string };
      document?: { filename?: string; artifactId?: string };
      runtimeControlResult: string;
    };
    const finalRuntime = JSON.parse(finalBody.runtimeControlResult) as {
      summary: string;
      synthesisSummary: string;
      summaryRef: { source: string; artifactId: string; turnId: string; memberId: string; synthesisArtifactId: string; synthesisRevision: number; synthesisHash: string };
    };
    expect(finalBody.text).toBe('m1 确认');
    expect(finalBody.summaryRef?.artifactId).toMatch(/^art_/);
    expect(finalBody.summaryRef?.turnId).toMatch(/^turn_/);
    const finalAttachment = db.prepare(`SELECT a.blob_path FROM message_attachments ma
      JOIN artifacts a ON a.id=ma.artifact_id WHERE ma.message_id=? AND ma.id LIKE 'matt_detail_%' LIMIT 1`).get(`msg_report_${runId}`) as { blob_path: string } | undefined;
    expect(readFileSync(finalAttachment!.blob_path, 'utf8')).toBe('# 合成整合稿\n\n完整正文。');
    expect(finalRuntime.summary).toBe('m1 确认');
    expect(finalRuntime.synthesisSummary).toBe('修订整合稿');
    expect(finalRuntime.summaryRef).toMatchObject({
      source: 'ratify',
      memberId: 'm1',
      synthesisArtifactId: synthesis.artifactId,
      synthesisRevision: synthesis.revision,
    });
    expect(finalRuntime.summaryRef.synthesisHash).toMatch(/^[a-f0-9]{64}$/);
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.ratifyIssueResponse'").get(runId) as { c: number }).c).toBe(2);
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(runId) as { c: number }).c).toBe(1);
    expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId)).toEqual({ status: 'DONE' });
    db.close();
  }, 20_000);

  it('does not close from a generic ready response with missing/empty issue responses', async () => {
    const { db, runId, issueId } = await runRatifyScenario({
      ratify: (issue, memberIndex) => ({
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: memberIndex === 0
          ? [{ issueId: issue, stance: 'resolved', reason: '我认为已解决' }]
          : [],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    expect(db.prepare('SELECT status FROM issues WHERE id=?').get(issueId)).toEqual({ status: 'insufficient_evidence' });
    const report = reportOf(db, runId);
    expect(report.deliveryStatus).toBe('delivered_with_questions');
    expect(report.unresolvedIssues).toContainEqual(expect.objectContaining({ id: issueId }));
    expect(report.issueResolutions).toContainEqual(expect.objectContaining({ issueId, status: 'insufficient_evidence' }));
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(runId) as { c: number }).c).toBe(0);
    db.close();
  }, 20_000);

  it('does not close a needs_user delivery decision or a synthesis needs_user resolution', async () => {
    const needsUser = await runRatifyScenario({
      ratify: (issue) => ({
        deliveryFeedback: { status: 'needs_user', reason: '需要用户决定', question: '是否接受该方案？', owner: '用户' },
        issueResponses: [{ issueId: issue, stance: 'resolved', reason: '成员认为已解决' }],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    expect(needsUser.db.prepare('SELECT status FROM issues WHERE id=?').get(needsUser.issueId)).toEqual({ status: 'insufficient_evidence' });
    expect(needsUser.db.prepare('SELECT status FROM tasks WHERE id=?').get(needsUser.taskId)).toEqual({ status: 'WAITING_USER' });
    expect(reportOf(needsUser.db, needsUser.runId).deliveryStatus).toBe('needs_user');
    needsUser.db.close();

    const synthesisNeedsUser = await runRatifyScenario({
      synthesisStatus: 'needs_user',
      ratify: (issue) => ({
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: [{ issueId: issue, stance: 'resolved', reason: '成员认为已解决' }],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    expect(synthesisNeedsUser.db.prepare('SELECT status FROM issues WHERE id=?').get(synthesisNeedsUser.issueId)).toEqual({ status: 'needs_user' });
    expect(reportOf(synthesisNeedsUser.db, synthesisNeedsUser.runId).deliveryStatus).toBe('delivered_with_questions');
    synthesisNeedsUser.db.close();
  }, 20_000);

  it('does not close when a claim is conditional or an issue is explicitly still_open', async () => {
    const conditional = await runRatifyScenario({
      ratify: (issue, memberIndex) => ({
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: [{ issueId: issue, stance: memberIndex === 0 ? 'resolved' : 'still_open', reason: '仍需确认' }],
        responses: [{ claimId: 'clm_1', stance: memberIndex === 0 ? 'confirm' : 'conditional', conditions: ['补充风险清单'] }],
      }),
    });
    expect(conditional.db.prepare('SELECT status FROM issues WHERE id=?').get(conditional.issueId)).toEqual({ status: 'insufficient_evidence' });
    expect(reportOf(conditional.db, conditional.runId).deliveryStatus).toBe('delivered_with_questions');
    const conditionalMessage = conditional.db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${conditional.runId}`) as { body_json: string };
    expect((JSON.parse(conditionalMessage.body_json) as { text: string }).text).toBe('修订整合稿');
    expect((conditional.db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(conditional.runId) as { c: number }).c).toBe(0);
    conditional.db.close();
  }, 20_000);

  it('keeps legacy RATIFY artifacts without issueResponses unchanged', async () => {
    const legacy = await runRatifyScenario({
      ratify: () => ({
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    expect(legacy.db.prepare('SELECT status FROM issues WHERE id=?').get(legacy.issueId)).toEqual({ status: 'insufficient_evidence' });
    expect(reportOf(legacy.db, legacy.runId).deliveryStatus).toBe('delivered_with_questions');
    const legacyMessage = legacy.db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${legacy.runId}`) as { body_json: string };
    expect((JSON.parse(legacyMessage.body_json) as { text: string }).text).toBe('修订整合稿');
    expect((legacy.db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(legacy.runId) as { c: number }).c).toBe(0);
    legacy.db.close();
  }, 20_000);

  it('falls back to the synthesis summary when the host RATIFY summary is absent', async () => {
    const missingHostSummary = await runRatifyScenario({
      ratify: (issue, memberIndex) => ({
        ...(memberIndex === 0 ? { omitSummary: true } : { summary: '成员 2 确认' }),
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: [{ issueId: issue, stance: 'resolved', reason: '当前版本已解决' }],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    const report = reportOf(missingHostSummary.db, missingHostSummary.runId);
    expect(report.deliveryStatus).toBe('delivered');
    const message = missingHostSummary.db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${missingHostSummary.runId}`) as { body_json: string };
    const body = JSON.parse(message.body_json) as { text: string; runtimeControlResult: string };
    expect(body.text).toBe('修订整合稿');
    expect((JSON.parse(body.runtimeControlResult) as { summaryRef: unknown }).summaryRef).toBeNull();
    missingHostSummary.db.close();
  }, 20_000);

  it('keeps the legacy full report text when no document and no host summary exist', async () => {
    const legacyDisplay = await runRatifyScenario({
      includeDocument: false,
      ratify: (issue, memberIndex) => ({
        ...(memberIndex === 0 ? { omitSummary: true } : { summary: '成员 2 确认' }),
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: [{ issueId: issue, stance: 'resolved', reason: '当前版本已解决' }],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    const message = legacyDisplay.db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${legacyDisplay.runId}`) as { body_json: string };
    const body = JSON.parse(message.body_json) as { text: string };
    expect(body.text).toContain('方案 A 可按条件推进');
    expect(body.text).not.toBe('修订整合稿');
    legacyDisplay.db.close();
  }, 20_000);

  it('preserves the host RATIFY summary bytes when explicit resolution succeeds', async () => {
    const exact = await runRatifyScenario({
      ratify: (issue, memberIndex) => ({
        summary: memberIndex === 0 ? '  原样编号 7  ' : '成员 2 确认',
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: [{ issueId: issue, stance: 'resolved', reason: '当前版本已解决' }],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    const message = exact.db.prepare('SELECT body_json FROM messages WHERE id=?').get(`msg_report_${exact.runId}`) as { body_json: string };
    expect((JSON.parse(message.body_json) as { text: string }).text).toBe('  原样编号 7  ');
    exact.db.close();
  }, 20_000);

  it('rejects unknown and duplicate issue ids without closing the issue', async () => {
    for (const kind of ['unknown', 'duplicate'] as const) {
      const db = openDatabase(':memory:');
      seed(db, ['m1', 'm2']);
      const scripts: FakeTurnScript[] = [];
      const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({}) });
      const worker = new DispatchWorker({
        db, adapter, leaseOwner: `invalid-issue-${kind}`, enableDeliberate: true,
        absenceToleranceMs: 60_000, deliberateMaxTurns: 40, appDataDir: join(root, `invalid-${kind}`),
      });
      const flow = await reachRatifyWithIssue(db, worker, scripts);
      const responses = kind === 'unknown'
        ? [{ issueId: 'iss_not_in_frozen_version', stance: 'resolved' as const, reason: '越界确认' }]
        : [
          { issueId: flow.issueId, stance: 'resolved' as const, reason: '第一次确认' },
          { issueId: flow.issueId, stance: 'still_open' as const, reason: '重复确认' },
        ];
      await step(worker, scripts, done({
        schemaVersion: 'ratify-v1', summary: '无效议题确认', document: null,
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: responses,
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }));
      expect(db.prepare('SELECT status FROM issues WHERE id=?').get(flow.issueId)).toEqual({ status: 'insufficient_evidence' });
      expect(db.prepare('SELECT status FROM tasks WHERE id=?').get(flow.taskId)).toEqual({ status: 'ACTIVE' });
      expect(db.prepare("SELECT status FROM agent_turns WHERE run_id=? ORDER BY rowid DESC LIMIT 1").get(flow.runId)).toEqual({ status: 'FAILED' });
      expect((db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='turn.outputInvalid'").get(flow.runId) as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(flow.runId) as { c: number }).c).toBe(0);
      db.close();
    }
  }, 20_000);

  it('does not publish or close while the submitted source turn is still RUNNING', async () => {
    const held = await runRatifyScenario({
      beforeRatify: (db) => {
        db.prepare(`CREATE TRIGGER hold_second_ratify_turn
          AFTER UPDATE OF status ON agent_turns
          WHEN NEW.member_id='m2' AND NEW.stage_key LIKE 'delib.ratify%' AND NEW.status='SUCCEEDED'
          BEGIN UPDATE agent_turns SET status='RUNNING' WHERE id=NEW.id; END`).run();
      },
      ratify: (issue) => ({
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: [{ issueId: issue, stance: 'resolved', reason: '逐项确认' }],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    expect(held.db.prepare('SELECT status FROM issues WHERE id=?').get(held.issueId)).toEqual({ status: 'insufficient_evidence' });
    expect(held.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(held.runId)).toEqual({ status: 'RUNNING' });
    expect(held.db.prepare('SELECT count(*) c FROM messages WHERE id=?').get(`msg_report_${held.runId}`)).toEqual({ c: 0 });
    held.db.close();
  }, 20_000);

  it('does not close when the submitted RATIFY source turn later ends FAILED', async () => {
    for (const terminalStatus of ['FAILED', 'UNKNOWN'] as const) {
      const failedTurn = await runRatifyScenario({
        beforeRatify: (db) => {
          db.prepare(`CREATE TRIGGER terminal_second_ratify_turn
            AFTER UPDATE OF status ON agent_turns
            WHEN NEW.member_id='m2' AND NEW.stage_key LIKE 'delib.ratify%' AND NEW.status='SUCCEEDED'
            BEGIN UPDATE agent_turns SET status='${terminalStatus}' WHERE id=NEW.id; END`).run();
        },
        ratify: (issue) => ({
          deliveryFeedback: { status: 'ready', reason: '可交付' },
          issueResponses: [{ issueId: issue, stance: 'resolved', reason: '逐项确认' }],
          responses: [{ claimId: 'clm_1', stance: 'confirm' }],
        }),
      });
      expect(failedTurn.db.prepare('SELECT status FROM issues WHERE id=?').get(failedTurn.issueId)).toEqual({ status: 'insufficient_evidence' });
      expect(failedTurn.db.prepare("SELECT status FROM agent_turns WHERE run_id=? AND member_id='m2' AND stage_key LIKE 'delib.ratify%'").get(failedTurn.runId)).toEqual({ status: terminalStatus });
      expect((failedTurn.db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(failedTurn.runId) as { c: number }).c).toBe(0);
      failedTurn.db.close();
    }
  }, 20_000);

  it('does not let an old synthesis RATIFY artifact close the current revision', async () => {
    const db = openDatabase(':memory:');
    seed(db, ['m1', 'm2']);
    const scripts: FakeTurnScript[] = [];
    const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: () => scripts.shift() ?? done({}) });
    const worker = new DispatchWorker({
      db, adapter, leaseOwner: 'old-version-ratify', enableDeliberate: true,
      absenceToleranceMs: 60_000, deliberateMaxTurns: 40, appDataDir: join(root, 'old-version'),
    });
    const flow = await reachRatifyWithIssue(db, worker, scripts);
    const revisionRequest = {
      status: 'needs_revision' as const,
      reason: '需要修订',
      revisionRequest: '补充当前冻结稿',
    };
    const oldRat = {
      schemaVersion: 'ratify-v1', summary: '旧版本确认', document: null,
      deliveryFeedback: revisionRequest,
      issueResponses: [{ issueId: flow.issueId, stance: 'resolved' as const, reason: '旧版本已解决' }],
      responses: [{ claimId: 'clm_1', stance: 'confirm' as const }],
    };
    await step(worker, scripts, done(oldRat));
    await step(worker, scripts, done(oldRat));
    expect(db.prepare('SELECT status FROM issues WHERE id=?').get(flow.issueId)).toEqual({ status: 'insufficient_evidence' });
    expect(db.prepare('SELECT stage,round_no FROM workflow_runs WHERE id=?').get(flow.runId)).toEqual({ stage: 'SYNTHESIS', round_no: 1 });

    await step(worker, scripts, done({
      schemaVersion: 'synthesis-v1', summary: '第二版修订稿', document: null,
      issueResolutions: [{ issueId: flow.issueId, status: 'insufficient_evidence', reason: '等待当前版本确认' }],
      claims: [{ statement: '方案 A 可按条件推进', sourceRefs: ['c1'] }],
      disputedClaims: [], recommendations: [],
    }));
    expect(db.prepare('SELECT stage FROM workflow_runs WHERE id=?').get(flow.runId)).toEqual({ stage: 'RATIFY' });
    await step(worker, scripts, done({
      schemaVersion: 'ratify-v1', summary: '当前版本成员一确认', document: null,
      deliveryFeedback: { status: 'ready', reason: '可交付' },
      issueResponses: [{ issueId: flow.issueId, stance: 'resolved', reason: '当前版本已解决' }],
      responses: [{ claimId: 'clm_1', stance: 'confirm' }],
    }));
    expect(db.prepare('SELECT status FROM issues WHERE id=?').get(flow.issueId)).toEqual({ status: 'insufficient_evidence' });
    expect(db.prepare('SELECT count(*) c FROM messages WHERE id=?').get(`msg_report_${flow.runId}`)).toEqual({ c: 0 });
    expect((db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(flow.runId) as { c: number }).c).toBe(0);
    db.close();
  }, 20_000);

  it('keeps the closed status and report arrays after reopening the persisted database', async () => {
    const dbFile = join(root, 'ratify-closure-persisted.sqlite');
    const result = await runRatifyScenario({
      dbFile,
      ratify: (issue) => ({
        deliveryFeedback: { status: 'ready', reason: '可交付' },
        issueResponses: [{ issueId: issue, stance: 'resolved', reason: '逐项确认' }],
        responses: [{ claimId: 'clm_1', stance: 'confirm' }],
      }),
    });
    const closureEventsBeforePump = (result.db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(result.runId) as { c: number }).c;
    const pumpAgain = pumpDeliberation(result.db, result.taskId, {
      absenceToleranceMs: 60_000,
      blobDir: join(root, 'app-persisted'),
    });
    expect(pumpAgain.advanced).toBe(false);
    expect((result.db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(result.runId) as { c: number }).c).toBe(closureEventsBeforePump);
    const eventCount = (result.db.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(result.runId) as { c: number }).c;
    result.db.close();
    const reopened = openDatabase(dbFile);
    expect(reopened.prepare('SELECT status FROM issues WHERE id=?').get(result.issueId)).toEqual({ status: 'resolved' });
    expect((reopened.prepare("SELECT count(*) c FROM domain_events WHERE run_id=? AND kind='run.issueClosure'").get(result.runId) as { c: number }).c).toBe(eventCount);
    const reopenedReport = reportOf(reopened, result.runId);
    expect(reopenedReport.deliveryStatus).toBe('delivered');
    expect(reopenedReport.unresolvedIssues).toEqual([]);
    reopened.close();
  }, 20_000);
});
