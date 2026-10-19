/**
 * R91 整体可见性夹具（模块3 · 整体验证准备，不属于产品功能）。
 *
 * 目标：用**合成小项目 + 真实 daemon 命令面 + FakeRuntimeAdapter + DispatchWorker**
 * 跑出：
 *   1) 两成员独立研讨（INDEPENDENT → CROSS_REVIEW → ISSUE_DISCUSSION → SYNTHESIS → RATIFY）
 *      的阶段产物——由后端可见性投影落成正式消息，**不直接 SQL 插入/伪造**；
 *   2) 同一线程一条正常的 Fake 最终回复，其 TaskComplete.files 声明的真实
 *      xlsx/csv/txt 文件经正式 snapshotGeneratedFiles 链登记为 artifacts +
 *      message_attachments（**真实读取字节 + sha256 + 内容寻址副本**）；
 *   3) 一个 DM（仅记录）与一个 **待推进的实时研讨请求**（留给工程 r78 daemon 在
 *      verify-r91-package.cjs 运行期间用真实 worker 推进，制造串内阶段更新）；
 *   4) `fixture.json`（含所有身份/哈希/预期 UI 断言）与 `app.settings autoOpenProjectPath`。
 *
 * 明确边界（报告与 fixture 中都标记）：
 *   - runtime = **fake**（FakeRuntimeAdapter）；**零真实模型调用**（real_calls=0）；
 *   - 不是真实模型认证；所有正文均为本脚本编写的合成材料；
 *   - 不修改产品源码、不修改迁移、不写用户真实数据。
 *
 * CLI（需要 Node ≥ 24 的 --experimental-strip-types）：
 *   node --experimental-strip-types scripts/prepare-r91-visible-fixture.ts \
 *     --root <fresh-root> [--app-data <dir>] [--project <dir>] [--report <file>] [--no-live]
 *
 * 默认：
 *   app-data = <root>/app-data（验证时可直接指向隔离包副本的 server-data）
 *   project  = <root>/project
 *   report   = <root>/fixture.json
 * 任何目标目录必须不存在或为空；本脚本只创建合成材料，不删除已有路径。
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { openDatabase } from '../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../src/daemon/commands.ts';
import { DispatchWorker } from '../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../src/adapter/fake/runtimeAdapter.ts';
import type { FakeTurnScript } from '../src/adapter/fake/script.ts';
import { TASK_COMPLETE_SCHEMA_VERSION } from '../src/contracts/prompts.ts';
import { localUserId } from '../src/contracts/daemonIpc.ts';
import { listRunArtifacts } from '../src/persistence/stores/deliberation.ts';

export const R91_FIXTURE_FORMAT = 'r91-visible-fixture-v1';
export const R91_LIVE_MARKER = 'R91_LIVE_STAGE_UPDATE';
export const R91_GENERATED_FILES = {
  xlsx: 'results/R91-成本对比-合成版.xlsx',
  csv: 'results/R91-逐条明细-合成版.csv',
  txt: 'results/R91-验收说明-合成版.txt',
} as const;

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

type Reply<T> = { ok: boolean; data?: T; error?: { code: string; message: string } };
type Submit = { taskId: string | null; threadId?: string; messageId?: string; disposition?: string };

interface FixtureStageRow { id: string; author_id: string; body_json: string; thread_message_seq: number; created_at: number }
interface FixtureArtifactRow { id: string; kind: string; hash: string; blob_path: string; source_name: string; author_id: string; revision: number }

/** 构建合成 xlsx 原件（SheetJS 生成真实 zip 容器；写盘字节与快照/另存核对同源）。 */
function buildSyntheticXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['方案', '成本（万元）', '交付期（周）', '风险'],
    ['方案A-合成', 12, 3, '中'],
    ['方案B-合成', 18, 2, '低'],
  ]), 'R91合成成本');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['检查项', '结论'],
    ['数据口径', '已复核（合成）'],
  ]), 'R91合成结论');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function generatedFileContents(): Record<string, { bytes: Buffer; kind: string; text?: string }> {
  const csvText = '项目,数值,备注\r\n成本差,6,合成材料\r\n交付期差,1,合成材料\r\n';
  const txtText = 'R91 合成验收说明\n\n本文件由 FakeRuntimeAdapter 脚本写入合成项目，\n经正式调度链快照为附件；不是真实模型产物。\n';
  return {
    [R91_GENERATED_FILES.xlsx]: { bytes: buildSyntheticXlsx(), kind: 'sheet_file' },
    [R91_GENERATED_FILES.csv]: { bytes: Buffer.from(csvText, 'utf8'), kind: 'sheet_file' },
    [R91_GENERATED_FILES.txt]: { bytes: Buffer.from(txtText, 'utf8'), kind: 'text_file' },
  };
}

function latestDeliberateRun(db: ReturnType<typeof openDatabase>): { id: string; taskId: string } | null {
  const row = db.prepare(
    "SELECT id, task_id FROM workflow_runs WHERE mode='DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY rowid DESC LIMIT 1",
  ).get() as { id: string; task_id: string } | undefined;
  return row == null ? null : { id: row.id, taskId: row.task_id };
}

function currentRunningMember(db: ReturnType<typeof openDatabase>): string | null {
  const row = db.prepare(
    "SELECT member_id FROM agent_turns WHERE status IN ('PENDING','DISPATCHING','RUNNING') ORDER BY rowid DESC LIMIT 1",
  ).get() as { member_id: string } | undefined;
  return row?.member_id ?? null;
}

/**
 * FAST DELIBERATE 阶段脚本（供 prepare 的 in-process worker 与 verify 的工程 r78 daemon 共用）。
 * `stallMs>0` 时每个阶段在产出前停延，用于全 APP 阶段更新/输入稳定性验证。
 * 契约输出与 tests/integration/r90ThreadDeliberation 同源（schemaVersion 驱动分支）。
 */
export function createDeliberationSequencer(
  db: ReturnType<typeof openDatabase>,
  options: { stallMs?: number; label?: string } = {},
): (input: { text: string }) => FakeTurnScript {
  const stallMs = Math.max(0, Math.floor(options.stallMs ?? 0));
  const label = options.label ?? 'R91 合成研讨';
  const done = (payload: unknown): FakeTurnScript => [
    ...(stallMs > 0 ? [{ kind: 'stall' as const, ms: stallMs }] : []),
    { kind: 'event', event: { kind: 'turn.completed', finalText: JSON.stringify(payload) } },
  ];
  return (input: { text: string }): FakeTurnScript => {
    const text = input.text;
    if (text.includes('"schemaVersion":"analysis-draft-v1"')) {
      const roundMarker = text.includes('第 2 轮') ? '（补充轮）' : '';
      return done({
        schemaVersion: 'analysis-draft-v1',
        summary: `${label}：独立分析${roundMarker}——方案 A 成本更低但交付期偏长；结论与证据均为合成材料。`,
        claims: [
          { claimId: 'r91_c1', statement: '方案 A 的合成成本比方案 B 低约 6 万元', kind: 'observed', evidenceIds: ['r91_ev_cost'], uncertainty: '样本为合成数据' },
          { claimId: 'r91_c2', statement: '方案 A 的合成交付期比方案 B 长约 1 周', kind: 'inferred', evidenceIds: ['r91_ev_schedule'] },
        ],
        recommendations: ['先做小规模合成验证'],
        openQuestions: ['交付期差异是否可接受'],
      });
    }
    if (text.includes('"schemaVersion":"cross-review-v1"')) {
      const run = latestDeliberateRun(db);
      if (run == null) return [{ kind: 'event', event: { kind: 'turn.failed', code: 'R91_FIXTURE_NO_RUN', message: '合成夹具缺少在途研讨运行', retryable: false } }];
      const drafts = listRunArtifacts(db, run.id, 'analysis_draft') as Array<FixtureArtifactRow & { id: string }>;
      const reviewer = currentRunningMember(db);
      const target = drafts.find((draft) => reviewer == null || draft.author_id !== reviewer) ?? drafts[0];
      const payloadText = target == null ? '' : readFileSync(target.blob_path, 'utf8');
      const claims = target == null ? [] : (JSON.parse(payloadText) as { claims?: Array<{ claimId: string }> }).claims ?? [];
      const claimId = claims[0]?.claimId ?? 'r91_c1';
      return done({
        schemaVersion: 'cross-review-v1',
        reviews: [{
          targetArtifactId: target?.id ?? '',
          targetRevision: target?.revision ?? 1,
          targetClaimId: claimId,
          stance: 'disagree',
          reason: '合成互评：该结论的证据来自单一合成样本，需要独立复核口径。',
          evidenceIds: ['r91_ev_review'],
          suggestedVerification: '补一组合成对照数据',
        }],
      });
    }
    if (text.includes('"schemaVersion":"issue-position-v1"')) {
      const run = latestDeliberateRun(db);
      const issue = run == null ? undefined : db.prepare('SELECT id FROM issues WHERE run_id=? ORDER BY id LIMIT 1').get(run.id) as { id: string } | undefined;
      return done({
        schemaVersion: 'issue-position-v1',
        positions: [{
          issueId: issue?.id ?? 'r91_issue',
          stance: 'needs_evidence',
          reason: '合成争议讨论：保留分歧，交由整合稿如实记录。',
          newEvidence: [],
        }],
      });
    }
    if (text.includes('"schemaVersion":"checkpoint-verdict-v1"')) {
      return done({ schemaVersion: 'checkpoint-verdict-v1', verdict: 'stop', reason: '合成检查点：没有新的可验证证据。' });
    }
    if (text.includes('"schemaVersion":"synthesis-v1"')) {
      return done({
        schemaVersion: 'synthesis-v1',
        summary: 'R91 合成整合结论：方案 A 成本更低、方案 B 交付更快；分歧保留为合成待验证项。',
        claims: [
          { statement: '方案 A 合成成本更低', sourceRefs: ['r91_c1'] },
          { statement: '方案 B 合成交付更快', sourceRefs: ['r91_c2'] },
        ],
        disputedClaims: [{ statement: '交付期差异是否可接受', disagreementSummary: '合成互评认为证据不足，需补充对照数据。', sourceRefs: ['r91_c2'] }],
        recommendations: ['补充合成对照数据后再决策'],
      });
    }
    if (text.includes('"schemaVersion":"ratify-v1"')) {
      const run = latestDeliberateRun(db);
      const claims = run == null ? [] : db.prepare('SELECT claim_id FROM synthesis_claims WHERE run_id=? ORDER BY claim_id').all(run.id) as Array<{ claim_id: string }>;
      return done({
        schemaVersion: 'ratify-v1',
        responses: (claims.length > 0 ? claims : [{ claim_id: 'r91_c1' }, { claim_id: 'r91_c2' }]).map((claim, index) => ({
          claimId: claim.claim_id,
          stance: index === 1 ? 'conditional' : 'confirm',
          ...(index === 1 ? { conditions: ['补充合成对照'] } : {}),
          reason: '合成确认：按合成材料确认/附条件。',
        })),
      });
    }
    return [{ kind: 'event', event: { kind: 'turn.failed', code: 'R91_FIXTURE_UNSCRIPTED', message: `合成夹具遇到未知阶段输入：${text.slice(0, 120)}`, retryable: false } }];
  };
}

function assertEmptyOrMissing(path: string): void {
  if (!existsSync(path)) return;
  if (!statSync(path).isDirectory()) throw new Error(`夹具目标不是目录：${path}`);
  if (readdirSync(path).length > 0) throw new Error(`夹具目标必须为空目录：${path}`);
}

function writeSyntheticProject(projectPath: string): void {
  mkdirSync(join(projectPath, '合成输入'), { recursive: true });
  writeFileSync(join(projectPath, 'README.md'), [
    '# R91 合成研讨项目（FAKE / SYNTHETIC）',
    '',
    '本目录只用于验证夹具，不包含真实用户数据。',
    '研讨与文件均由 FakeRuntimeAdapter + 真实调度链生成；零真实模型调用。',
  ].join('\n'), 'utf8');
  writeFileSync(join(projectPath, '合成输入', '背景说明.md'), '# 合成背景\n\n只用于 R91 可见性验证。\n', 'utf8');
  writeFileSync(join(projectPath, '合成输入', '成本口径.csv'), '项目,数值\n成本差,6\n交付期差,1\n', 'utf8');
}

interface PrepareOptions {
  root: string;
  appData: string;
  projectPath: string;
  reportPath: string;
  includeLive: boolean;
}

async function prepare(options: PrepareOptions): Promise<void> {
  const { root, appData, projectPath, reportPath, includeLive } = options;
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  assertEmptyOrMissing(appData);
  assertEmptyOrMissing(projectPath);
  mkdirSync(appData, { recursive: true });
  mkdirSync(projectPath, { recursive: true });
  writeSyntheticProject(projectPath);

  // Fake 仅显式开发模式；不设真实派发防护（这是工程夹具，不是每日包）；清除真实批次标记。
  process.env.ZS_ALLOW_FAKE = '1';
  process.env.ZS_RUNTIME = 'fake';
  process.env.ZS_DEFAULT_MEMBER_DISCOVERY = '0';
  delete process.env.ZS_REAL_DISPATCH_GUARD;
  delete process.env.ZS_REAL_BATCH_ID;
  delete process.env.ZS_PACKED_ENTRY;

  const dbPath = join(appData, 'state.sqlite');
  const db = openDatabase(dbPath);
  const adapter = new FakeRuntimeAdapter({ structuredFinal: false, turnScriptSequencer: createDeliberationSequencer(db, { label: 'R91 合成研讨' }) });
  let worker: DispatchWorker | null = null;
  const deps = {
    db, localUserId: localUserId(), appDataDir: appData,
    interruptTurn: async (turnId: string) => { await worker?.interruptTurn(turnId); },
  };
  const raw = <T>(method: string, params: unknown): Promise<Reply<T>> => dispatchDaemonCommand(deps, {
    protocolVersion: 1, commandId: `r91-fixture-${randomUUID()}`, method, params,
  }) as Promise<Reply<T>>;
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await raw<T>(method, params);
    if (!response.ok || response.data == null) throw new Error(`${method}: ${response.error?.code ?? 'NO_DATA'} ${response.error?.message ?? ''}`);
    return response.data;
  };
  const assertions: Record<string, unknown> = {};
  try {
    const opened = await cmd<{ project: { id: string } }>('project.open', {
      path: projectPath, displayName: 'R91 合成研讨项目（FAKE/SYNTHETIC）', agentNames: ['合成成员甲', '合成成员乙'],
    });
    const projectId = opened.project.id;
    const projectRow = db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId) as { revision: number };
    await cmd('project.reviewPolicy.set', { projectId, taskReviewEnabled: false, expectedRevision: projectRow.revision });
    const members = db.prepare(
      'SELECT id, display_name FROM project_members WHERE project_id=? ORDER BY rowid LIMIT 2',
    ).all(projectId) as Array<{ id: string; display_name: string }>;
    if (members.length !== 2) throw new Error(`合成项目应有两位成员，实际 ${members.length}`);
    for (const member of members) {
      await cmd('member.setRuntime', {
        memberId: member.id, kind: 'fake', executable: 'fake', permissionMode: 'bypassPermissions',
        model: 'synthetic-fake-r91',
      });
    }
    const createdRoom = await cmd<{ room: { id: string; conversationId: string } }>('room.create', {
      projectId, name: 'R91 合成研讨房间', memberIds: members.map((member) => member.id),
    });
    const room = createdRoom.room;
    const rootSubmit = await cmd<Submit>('message.submit', {
      target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
      body: 'R91 合成研讨请求：比较方案 A 与方案 B 的成本和交付期（FAKE/SYNTHETIC）。',
      intent: 'default', mentions: [{ kind: 'all' }],
      collaboration: 'deliberate', deliberationBudget: { maxTurns: 40 },
    });
    if (rootSubmit.taskId == null || rootSubmit.threadId == null) throw new Error('房间研讨未创建任务/线程');
    const taskId = rootSubmit.taskId;
    const threadId = rootSubmit.threadId;

    worker = new DispatchWorker({
      db, adapter, leaseOwner: `r91-fixture-${randomUUID().slice(0, 8)}`,
      enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: appData,
    });
    const deadline = Date.now() + 60_000;
    let idle = 0;
    while (Date.now() < deadline) {
      const worked = await worker.runOnce();
      if (!worked) idle += 1; else idle = 0;
      const status = (db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string } | undefined)?.status;
      if (status === 'DONE' || status === 'FAILED') break;
      if (idle > 20) break;
      await pause(60);
    }
    if (worker != null) await adapter.closeAllSessions().catch(() => undefined);
    const taskStatus = (db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string } | undefined)?.status;
    const run = db.prepare(
      "SELECT id,status,stage FROM workflow_runs WHERE task_id=? AND mode='DELIBERATE' ORDER BY rowid DESC LIMIT 1",
    ).get(taskId) as { id: string; status: string; stage: string } | undefined;
    if (taskStatus !== 'DONE' || run?.status !== 'SUCCEEDED') {
      throw new Error(`合成研讨未成功收口：task=${taskStatus ?? 'missing'} run=${JSON.stringify(run ?? null)}`);
    }
    const stageRows = db.prepare(
      "SELECT id, author_id, body_json, thread_message_seq, created_at FROM messages WHERE task_id=? AND id LIKE 'msg_delib_%' ORDER BY thread_message_seq",
    ).all(taskId) as FixtureStageRow[];
    const memberName = new Map(members.map((member) => [member.id, member.display_name]));
    const stageMessages = stageRows.map((row) => {
      const body = JSON.parse(row.body_json) as { text?: string; collaborationStage?: { stage?: string; roundNo?: number; turnId?: string; runId?: string } };
      const rawText = body.text ?? '';
      const lines = rawText.split('\n');
      const bodyPreview = (lines[0]?.trim().startsWith('【') ? lines.slice(1) : lines).join(' ').slice(0, 120);
      return {
        id: row.id,
        authorId: row.author_id,
        authorDisplayName: memberName.get(row.author_id) ?? row.author_id,
        stage: body.collaborationStage?.stage ?? null,
        roundNo: body.collaborationStage?.roundNo ?? null,
        seq: row.thread_message_seq,
        rawTextPreview: rawText.split('\n').slice(0, 2).join(' ').slice(0, 120),
        bodyPreview,
      };
    });
    const stages = new Set(stageMessages.map((message) => message.stage));
    for (const expected of ['INDEPENDENT', 'CROSS_REVIEW', 'ISSUE_DISCUSSION', 'SYNTHESIS', 'RATIFY']) {
      if (!stages.has(expected)) throw new Error(`合成研讨缺少可见阶段产物：${expected}（实际 ${[...stages].join(',')}）`);
    }
    if (!stageMessages.some((message) => message.stage === 'CROSS_REVIEW' && message.authorId !== members[0]!.id)) {
      throw new Error('合成互评缺少第二成员作者（真实作者约束）');
    }

    // ---------- 正常 Fake 最终回复 + 真实生成文件快照（同一线程） ----------
    const generated = generatedFileContents();
    const files = Object.keys(generated) as Array<keyof typeof generated>;
    const generatedAdapter = new FakeRuntimeAdapter({
      structuredFinal: false,
      turnScriptSequencer: (): FakeTurnScript => {
        const turn = db.prepare(
          "SELECT id FROM agent_turns WHERE status IN ('PENDING','DISPATCHING','RUNNING') ORDER BY rowid DESC LIMIT 1",
        ).get() as { id: string } | undefined;
        if (turn == null) return [{ kind: 'event', event: { kind: 'turn.failed', code: 'R91_FIXTURE_NO_TURN', message: '合成生成文件缺少在途 turn', retryable: false } }];
        const finalText = JSON.stringify({
          schemaVersion: TASK_COMPLETE_SCHEMA_VERSION,
          resultKey: `result_${turn.id}`,
          changeSummary: 'R91 合成生成文件回复（FAKE/SYNTHETIC）',
          files,
          executedVerifications: ['FakeRuntimeAdapter writeFile + 正式 snapshotGeneratedFiles 链'],
          unexecutedVerifications: [],
          remainingIssues: [],
        });
        return [
          { kind: 'writeFile', path: R91_GENERATED_FILES.xlsx, contentBase64: generated[R91_GENERATED_FILES.xlsx]!.bytes.toString('base64') },
          { kind: 'writeFile', path: R91_GENERATED_FILES.csv, content: generated[R91_GENERATED_FILES.csv]!.bytes.toString('utf8') },
          { kind: 'writeFile', path: R91_GENERATED_FILES.txt, content: generated[R91_GENERATED_FILES.txt]!.bytes.toString('utf8') },
          { kind: 'event', event: { kind: 'message.completed', messageId: `r91-final-${randomUUID().slice(0, 8)}`, text: finalText } },
          { kind: 'event', event: { kind: 'turn.completed', finalText } },
        ];
      },
    });
    worker = new DispatchWorker({
      db, adapter: generatedAdapter, leaseOwner: `r91-gen-${randomUUID().slice(0, 8)}`,
      enableDeliberate: true, absenceToleranceMs: 60_000, appDataDir: appData,
    });
    const followSubmit = await cmd<Submit>('message.submit', {
      target: { kind: 'thread', projectId, conversationId: room.conversationId, threadId },
      body: 'R91 合成生成文件请求：请输出 xlsx/csv/txt 三个真实文件（FAKE/SYNTHETIC）。',
      intent: 'default', mentions: [{ kind: 'member', memberId: members[1]!.id }],
    });
    if (followSubmit.taskId == null) throw new Error('线程跟进未绑定任务');
    const followDeadline = Date.now() + 60_000;
    let followIdle = 0;
    while (Date.now() < followDeadline) {
      const worked = await worker.runOnce();
      if (!worked) followIdle += 1; else followIdle = 0;
      const request = db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(followSubmit.messageId!) as { status: string } | undefined;
      if (request?.status === 'succeeded' || request?.status === 'failed') break;
      if (followIdle > 20) break;
      await pause(60);
    }
    await generatedAdapter.closeAllSessions().catch(() => undefined);
    if (worker != null) worker = null;
    const requestStatus = (db.prepare('SELECT status FROM thread_reply_requests WHERE message_id=?').get(followSubmit.messageId!) as { status: string } | undefined)?.status;
    if (requestStatus !== 'succeeded') throw new Error(`合成生成文件回复未成功：${requestStatus ?? 'missing'}`);
    const finalMessage = db.prepare(
      "SELECT id, author_id FROM messages WHERE thread_id=? AND id NOT LIKE 'msg_delib_%' AND author_type='agent' ORDER BY thread_message_seq DESC LIMIT 1",
    ).get(threadId) as { id: string; author_id: string } | undefined;
    if (finalMessage == null) throw new Error('合成生成文件回复消息缺失');    const artifactRows = db.prepare(
      'SELECT id, kind, hash, blob_path, source_name, author_id, revision FROM artifacts WHERE thread_id=? ORDER BY rowid',
    ).all(threadId) as FixtureArtifactRow[];
    const fileReports = files.map((file) => {
      const expected = generated[file]!;
      const basename = file.split(/[\\/]/).pop() ?? file;
      const artifact = artifactRows.find((row) => row.source_name === basename);
      if (artifact == null) throw new Error(`生成文件未登记 artifact：${file}`);
      const expectedHash = sha256(expected.bytes);
      if (artifact.hash !== expectedHash) throw new Error(`生成文件 hash 不一致：${file}`);
      const attachment = db.prepare(
        'SELECT id FROM message_attachments WHERE message_id=? AND artifact_id=?',
      ).get(finalMessage.id, artifact.id);
      if (attachment == null) throw new Error(`生成文件未挂到最终回复：${file}`);
      const diskBytes = readFileSync(artifact.blob_path);
      if (sha256(diskBytes) !== expectedHash) throw new Error(`托管副本 hash 不一致：${file}`);
      const projectBytes = readFileSync(join(projectPath, file));
      if (sha256(projectBytes) !== expectedHash) throw new Error(`项目文件 hash 不一致：${file}`);
      return {
        artifactId: artifact.id, filename: basename, requestPath: file, kind: artifact.kind,
        sha256: expectedHash, bytes: expected.bytes.length,
        messageId: finalMessage.id, projectPath: join(projectPath, file),
        blobPath: artifact.blob_path,
      };
    });
    if (fileReports.length !== 3) throw new Error('生成文件数量不是 3');

    // ---------- DM（仅记录；用于全 APP 草稿切换验证） ----------
    const dm = await cmd<{ conversationId: string }>('conversation.create', { projectId, peerMemberId: members[0]!.id, title: 'R91 合成私信' });
    const dmSubmit = await cmd<Submit>('message.submit', {
      target: { kind: 'dm', projectId, conversationId: dm.conversationId },
      body: 'R91 合成私信历史消息（仅记录，FAKE/SYNTHETIC）。', intent: 'record_only', mentions: [],
    });

    // ---------- 待推进的实时研讨请求（留给工程 r78 daemon 在 verify 期间推进） ----------
    let liveMessageId: string | null = null;
    if (includeLive) {
      const threadSnapshot = await cmd<{ members: { version: string; memberIds: string[] } }>('thread.get', { threadId });
      for (const member of members) {
        if (threadSnapshot.members.memberIds.includes(member.id)) continue;
        const current = await cmd<{ members: { version: string } }>('thread.get', { threadId });
        await cmd('thread.members.change', { projectId, threadId, memberId: member.id, action: 'add', expectedVersion: current.members.version });
      }
      const liveSubmit = await cmd<Submit>('message.submit', {
        target: { kind: 'thread', projectId, conversationId: room.conversationId, threadId },
        body: `${R91_LIVE_MARKER}：请继续一轮实时合成研讨（工程 Fake 推进，非真实模型）。`,
        intent: 'default', mentions: [{ kind: 'all' }],
        collaboration: 'deliberate', deliberationBudget: { maxTurns: 40 },
      });
      liveMessageId = liveSubmit.messageId ?? null;
      const request = liveMessageId == null ? undefined : db.prepare(
        'SELECT status FROM thread_reply_requests WHERE message_id=?',
      ).get(liveMessageId) as { status: string } | undefined;
      if (request?.status !== 'queued') throw new Error(`实时研讨请求应保持 queued 待工程 daemon 推进，实际 ${request?.status ?? 'missing'}`);
    }

    await cmd('app.settings.set', { key: 'ui.autoOpenProjectPath', value: projectPath });
    const realCalls = (db.prepare('SELECT count(*) AS n FROM real_calls').get() as { n: number }).n;
    const pendingTurns = (db.prepare("SELECT count(*) AS n FROM agent_turns WHERE status IN ('PENDING','DISPATCHING','RUNNING')").get() as { n: number }).n;
    assertions.taskStatus = taskStatus;
    assertions.runStatus = run?.status ?? null;
    assertions.stageCount = stageMessages.length;
    assertions.stageSet = [...stages].sort();
    assertions.generatedFiles = fileReports.length;
    assertions.realCalls = realCalls;
    assertions.pendingTurns = pendingTurns;
    assertions.liveRequestQueued = includeLive;
    if (realCalls !== 0) throw new Error(`合成夹具产生了真实调用计数：${realCalls}`);
    if (pendingTurns !== 0) throw new Error(`合成夹具仍有未收口 turn：${pendingTurns}`);

    const report = {
      format: R91_FIXTURE_FORMAT,
      synthetic: true,
      dedicatedFakeRuntime: true,
      modelCalls: 'none: FakeRuntimeAdapter scripted only (real_calls=0)',
      createdAt: new Date().toISOString(),
      root, appData, projectPath, dbPath,
      projectId, projectName: 'R91 合成研讨项目（FAKE/SYNTHETIC）',
      roomId: room.id, conversationId: room.conversationId, threadId, taskId,
      members: members.map((member) => ({ id: member.id, displayName: member.display_name })),
      rootMessageId: rootSubmit.messageId ?? null,
      rootMessagePreview: 'R91 合成研讨请求：比较方案 A 与方案 B 的成本和交付期（FAKE/SYNTHETIC）。',
      stageMessages,
      expectedStages: ['INDEPENDENT', 'CROSS_REVIEW', 'ISSUE_DISCUSSION', 'SYNTHESIS', 'RATIFY'],
      generatedMessageId: finalMessage.id,
      generatedMessageAuthor: { id: finalMessage.author_id, displayName: memberName.get(finalMessage.author_id) ?? finalMessage.author_id },
      generatedFiles: fileReports,
      dmConversationId: dm.conversationId,
      dmMessageId: dmSubmit.messageId ?? null,
      liveMarker: liveMessageId == null ? null : R91_LIVE_MARKER,
      liveMessageId,
      autoOpenProjectPath: projectPath,
      assertions,
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    process.stdout.write(`${JSON.stringify({ ok: true, report: reportPath, projectId, threadId, stageMessages: stageMessages.length, generatedFiles: fileReports.length, realCalls }, null, 2)}\n`);
  } finally {
    await adapter.closeAllSessions().catch(() => undefined);
    db.close();
  }
}

function parseArgs(argv: string[]): PrepareOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!;
    if (!argument.startsWith('--')) throw new Error(`未知参数：${argument}`);
    const key = argument.slice(2);
    if (['no-live'].includes(key)) { flags.add(key); continue; }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`参数缺少值：${argument}`);
    values.set(key, value);
    i += 1;
  }
  const rootValue = values.get('root');
  if (rootValue == null) throw new Error('usage: node --experimental-strip-types scripts/prepare-r91-visible-fixture.ts --root <fresh-root> [--app-data <dir>] [--project <dir>] [--report <file>] [--no-live]');
  const root = resolve(rootValue);
  return {
    root,
    appData: resolve(values.get('app-data') ?? join(root, 'app-data')),
    projectPath: resolve(values.get('project') ?? join(root, 'project')),
    reportPath: resolve(values.get('report') ?? join(root, 'fixture.json')),
    includeLive: !flags.has('no-live'),
  };
}

const invokedDirectly = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  prepare(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`[r91-fixture] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
