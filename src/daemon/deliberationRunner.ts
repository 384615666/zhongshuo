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
import { projectScopedFileListing } from './fileDiscovery.ts';
import { createHash, randomUUID } from 'node:crypto';
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
  type SaveArtifactInput,
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
import { z } from 'zod';

// ---------- 步骤身份（dispatch_key 语法） ----------

export type DelibStageCode = 'IND' | 'CR' | 'ISS' | 'CHK' | 'SYN' | 'RAT' | 'RPR';

export interface DelibStep {
  taskId: string;
  /** 归属 run：派发键/预算/成果都按 run 作用域——同任务新运行不复用旧运行键。 */
  runId: string;
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
    return `task:${step.taskId}:delib:${step.runId}:RPR:${step.memberId}:${step.roundNo}:${step.repairTarget ?? 'IND'}`;
  }
  return `task:${step.taskId}:delib:${step.runId}:${STAGE_CODE[step.stage]}:${step.memberId}:${step.roundNo}:${purposeChar}`;
}

export function parseDelibStep(dispatchKey: string): DelibStep | null {
  const m = dispatchKey.match(/^task:([^:]+):delib:(run_[^:]+):(IND|CR|ISS|CHK|SYN|RAT|RPR):([^:]+):(\d+):(w|c|f)$/);
  if (m == null) return null;
  const stage = m[3] as DelibStageCode;
  return {
    taskId: m[1]!,
    runId: m[2]!,
    stage,
    memberId: m[4]!,
    roundNo: Number(m[5]),
    purpose: m[6] === 'c' ? 'checkpoint' : m[6] === 'f' ? 'format_repair' : 'stage_work',
  };
}

/** RPR 键的目标阶段编码在用途位（w/c/f 位置放目标 code）。 */
export function repairDispatchKey(base: DelibStep): string {
  return `task:${base.taskId}:delib:${base.runId}:RPR:${base.memberId}:${base.roundNo}:${base.stage}`;
}

export function parseRepairTarget(dispatchKey: string): DelibStep | null {
  const m = dispatchKey.match(/^task:([^:]+):delib:(run_[^:]+):RPR:([^:]+):(\d+):(IND|CR|ISS|CHK|SYN|RAT)$/);
  if (m == null) return null;
  return { taskId: m[1]!, runId: m[2]!, stage: m[5] as DelibStep['stage'], memberId: m[3]!, roundNo: Number(m[4]), purpose: 'format_repair' };
}

function artifactsEntries(db: ZhongshuoDatabase, runId: string, kind: string): Array<{ artifactId: string; revision: number; hash: string }> {
  return listRunArtifacts(db, runId, kind as never).map((a) => ({ artifactId: a.id, revision: a.revision, hash: a.hash }));
}

/** SYNTHESIS 输入清单：全部初稿+互评+立场（迟到者含——进入本阶段时的新版本）。 */
function freezeSynthesisInputs(db: ZhongshuoDatabase, runId: string): void {
  const entries = [
    ...artifactsEntries(db, runId, 'analysis_draft'),
    ...artifactsEntries(db, runId, 'cross_review'),
    ...artifactsEntries(db, runId, 'issue_position'),
  ];
  freezeStageInputs(db, runId, 'SYNTHESIS', 0, entries);
}

function inputEntriesOf(db: ZhongshuoDatabase, runId: string, draftIds: readonly string[], _reviews: unknown): Array<{ artifactId: string; revision: number; hash: string }> {
  void _reviews;
  return artifactsEntries(db, runId, 'analysis_draft');
}

/** 按冻结清单读 artifacts（清单缺失或条目缺失=组装失败，不回退到实时查询）。 */
function draftsFromManifest(db: ZhongshuoDatabase, runId: string, manifest: FrozenInputs | null): DraftArtifact[] {
  if (manifest == null) return []; // 未冻结（旧数据）：调用方决定失败
  const out: DraftArtifact[] = [];
  for (const e of manifest.entries) {
    const row = db.prepare('SELECT id, run_id, author_id, kind, revision, hash, blob_path FROM artifacts WHERE id = ?').get(e.artifactId) as { id: string; run_id: string; author_id: string; revision: number; hash: string; blob_path: string } | undefined;
    if (row == null || row.run_id !== runId || row.revision !== e.revision || row.hash !== e.hash) continue; // 与冻结版本不一致：不读
    const payload = JSON.parse(readFileSync(row.blob_path, 'utf8')) as DraftArtifact['payload'];
    out.push({ artifactId: row.id, memberId: row.author_id, revision: row.revision, payload });
  }
  return out;
}

// ---------- E4 执行语义：成员执行时钟/缺席宽限/排队区分（§4.3） ----------

export interface MemberAbsenceVerdict {
  memberId: string;
  markedAbsent: boolean;
  /** open=有在途 turn 且执行时间达宽限；queued=未派发（不缺席）；terminalHandled=终态路径已处理。 */
  basis: 'open-execution' | 'queued' | 'no-stage-turn' | 'within-grace';
  effectiveExecMs?: number;
}

/** 成员当前阶段在途 turn 的 stage_key 前缀（delib.<stage>[.rN...]）。 */
function stageTurnPrefix(stage: string): string {
  return `delib.${stage.toLowerCase()}`;
}

/**
 * 逐成员缺席宽限判定（只标记，不杀 turn）：
 * - 宽限取**该 turn 派发时快照**（collab_absence_ms——第十八轮四：执行中改项目配置不影响
 *   在途 turn；快照缺失的历史行回落调用方传入的项目/全局值）；
 * - 有本阶段**在途** turn 且 有效执行时间(now-started-paused) ≥ grace → absent（basis=open-execution）；
 * - 无 turn（排队）→ 永不缺席；turn 未启动(exec_started_at 空) → 不计。
 * 单轮截止/UNKNOWN/失败等其他 basis 由 worker 终态路径处理（互不重复：此处只看在途）。
 */
export function evaluateMemberAbsence(db: ZhongshuoDatabase, runId: string, stage: string, now: number, graceMs: number, expectedMemberIds: readonly string[]): MemberAbsenceVerdict[] {
  const verdicts: MemberAbsenceVerdict[] = [];
  for (const memberId of expectedMemberIds) {
    const open = db.prepare(
      `SELECT id, exec_started_at, exec_paused_ms, collab_absence_ms FROM agent_turns
       WHERE run_id = ? AND member_id = ? AND stage_key LIKE ? AND status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT')
       ORDER BY rowid DESC LIMIT 1`,
    ).get(runId, memberId, `${stageTurnPrefix(stage)}%`) as { id: string; exec_started_at: number | null; exec_paused_ms: number; collab_absence_ms: number | null } | undefined;
    if (open == null) {
      // 无在途 turn：要么还没派发（排队），要么已终态（缺席/失败由终态路径负责）。
      const ever = db.prepare(
        'SELECT id FROM agent_turns WHERE run_id = ? AND member_id = ? AND stage_key LIKE ? LIMIT 1',
      ).get(runId, memberId, `${stageTurnPrefix(stage)}%`);
      verdicts.push({ memberId, markedAbsent: false, basis: ever == null ? 'queued' : 'no-stage-turn' });
      continue;
    }
    const effectiveGrace = open.collab_absence_ms ?? graceMs; // 快照优先；历史行回落现行值
    if (open.exec_started_at == null) {
      verdicts.push({ memberId, markedAbsent: false, basis: 'within-grace' }); // 未收到 turn.started：不累计
      continue;
    }
    const effective = Math.max(0, now - open.exec_started_at - (open.exec_paused_ms ?? 0));
    if (effective >= effectiveGrace) {
      const changed = db.prepare("UPDATE run_participants SET status = 'absent' WHERE run_id = ? AND member_id = ? AND status IN ('pending','late')").run(runId, memberId).changes;
      if (changed > 0) {
        appendDomainEvent(db, {
          schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: '',
          threadId: null, runId, kind: 'run.participantAbsent', createdAt: now,
          payload: { memberId, stage, reason: 'absence-grace', effectiveExecMs: effective, turnId: open.id, killed: false },
        });
      }
      verdicts.push({ memberId, markedAbsent: true, basis: 'open-execution', effectiveExecMs: effective });
    } else {
      verdicts.push({ memberId, markedAbsent: false, basis: 'within-grace', effectiveExecMs: effective });
    }
  }
  return verdicts;
}

/** 排队等待观察线：只记诊断（每成员每阶段一次），不改成员状态。 */
function noteDispatchWait(db: ZhongshuoDatabase, runId: string, stage: string, now: number, waitMs: number, memberId: string): void {
  const key = `delib:${runId}:dispatchwait:${stage}:${memberId}`;
  const exists = db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(key);
  if (exists != null) return;
  db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify({ memberId, stage, waitMs, at: now }), now);
  // 合同修正（收口轮四）：未开始成员有独立 dispatchWaitDeadline——超出按 unavailable
  // 规则处理（屏障不再无限等待该席位），非仅观察线。成员状态置 'unavailable'：
  //   - 屏障视同缺席终结（不占住阶段）；
  //   - 与 absent 区分：原因=排队等待（调度资源），后续轮次可恢复参与；
  //   - 资源恢复/用户重试不重复派发旧步骤（旧键已被屏障消费）。
  db.prepare("UPDATE run_participants SET status = 'unavailable' WHERE run_id = ? AND member_id = ? AND status = 'pending'").run(runId, memberId);
  appendDomainEvent(db, {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: '',
    threadId: null, runId, kind: 'run.dispatchWaitExceeded', createdAt: now,
    payload: { memberId, stage, waitMs, disposition: 'unavailable', note: '排队等待独立截止：按 unavailable 规则处理（屏障推进；后续阶段可恢复）' },
  });
}

// ---------- 阶段输入冻结清单（不可变输入版本/hash；迟到边界） ----------

export interface FrozenInputs {
  version: number;
  stage: string;
  round: number;
  /** artifactId@revision 列表（排序后参与 hash）；synthesis 类为 artifactId+revision+hash。 */
  entries: ReadonlyArray<{ artifactId: string; revision: number; hash: string }>;
  hash: string;
}

function freezeKey(runId: string, stage: string, round: number): string {
  return `delib:${runId}:inputs:${stage}:${round}`;
}

/** 冻结阶段输入（进入阶段时一次写入；后续迟到材料不改本清单——只入迟到记录与后续阶段清单）。 */
export function freezeStageInputs(db: ZhongshuoDatabase, runId: string, stage: string, round: number, entries: ReadonlyArray<{ artifactId: string; revision: number; hash: string }>): FrozenInputs {
  const sorted = [...entries].sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : a.revision - b.revision));
  const hash = createHashFor(sorted.map((e) => `${e.artifactId}@${e.revision}#${e.hash}`).join('|'));
  const frozen: FrozenInputs = { version: 1, stage, round, entries: sorted, hash };
  db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING')
    .run(freezeKey(runId, stage, round), JSON.stringify(frozen), Date.now());
  return frozen;
}

export function frozenStageInputs(db: ZhongshuoDatabase, runId: string, stage: string, round: number): FrozenInputs | null {
  const row = db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(freezeKey(runId, stage, round)) as { value: string } | undefined;
  return row != null ? (JSON.parse(row.value) as FrozenInputs) : null;
}

/** RATIFY 权威冻结整合稿（manifest 优先；缺失时回退 max-revision 供旧数据）。 */
export function frozenSynthesisOf(db: ZhongshuoDatabase, runId: string): { artifactId: string; revision: number; hash: string } | null {
  const m = frozenStageInputs(db, runId, 'RATIFY', 0);
  if (m != null && m.entries.length > 0) {
    const e = m.entries[0]!;
    return { artifactId: e.artifactId, revision: e.revision, hash: e.hash };
  }
  const fallback = currentSynthesisVersion(db, runId);
  if (fallback == null) return null;
  const row = db.prepare('SELECT hash FROM artifacts WHERE id = ?').get(fallback.artifactId) as { hash: string } | undefined;
  return { ...fallback, hash: row?.hash ?? '' };
}

function createHashFor(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
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
  /** E4 absenceGrace：成员**实际执行时间**（turn.started 起、扣审批/等待暂停）超过即按缺席推进；
   * 不强杀在途成员（其后续完成走迟到路径）。与单轮 turnDeadline（中断分支）分离。
   * 兼容旧字段名 absenceToleranceMs。默认 20 分钟。 */
  absenceToleranceMs: number;
  /** 排队等待观察线：成员步骤尚未派发超过此时长只记诊断事件（不记成员缺席——排队非成员责任）。 */
  dispatchWaitDeadlineMs?: number;
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
  const host = route.initialWakeMemberIds[0] ?? route.frozenMemberIds[0];
  if (host == null) return domainErr('VALIDATION_INVALID', 'DELIBERATE 路由缺少冻结名单');
  // 复用仅限活跃 run；终态后再次提交=承接新证据的新运行（新键/新版本，§6.5）。
  const existing = db.prepare(
    "SELECT * FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' AND status IN ('RUNNING','WAITING') ORDER BY rowid DESC LIMIT 1",
  ).get(task.id) as RunRow | undefined;
  if (existing != null) {
    enqueueIndependentSteps(db, existing.id, task.id, route.frozenMemberIds);
    return domainOk({ runId: existing.id });
  }
  const prevRoster = db.prepare("SELECT COALESCE(MAX(roster_revision), 0) AS r FROM workflow_runs WHERE task_id = ?").get(task.id) as { r: number };
  const runId = `run_${randomUUID()}`;
  const budget = initDeliberationBudget({
    rosterSize: route.frozenMemberIds.length,
    // E12 完整预估：默认讨论可到第 3 轮 → 含 C=1 检查点（6N+1+C）；用户设置可覆盖。
    runMaxTurns: options.runMaxTurns ?? deriveDeliberateMaxTurns(route.frozenMemberIds.length, { expectsCheckpointRound3: true }).core,
  });
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO workflow_runs (id, task_id, conversation_id, thread_id, mode, task_revision, status, stage, round_no, roster_revision, budget_json, stage_started_at)
       VALUES (?, ?, ?, ?, 'DELIBERATE', 0, 'RUNNING', 'INDEPENDENT', 0, ?, ?, ?)`,
    ).run(runId, task.id, task.conversationId, task.threadId, prevRoster.r + 1, JSON.stringify(budget), Date.now());
    db.prepare('INSERT INTO deliberation_run_scopes(run_id,stop_generation) SELECT ?,stop_generation FROM tasks WHERE id=?').run(runId,task.id);
    for (const memberId of route.frozenMemberIds) {
      db.prepare(
        `INSERT INTO run_participants (run_id, member_id, role, expected, status) VALUES (?, ?, ?, 1, 'pending')`,
      ).run(runId, memberId, memberId === host ? 'host' : 'member');
    }
    appendDomainEvent(db, {
      schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: task.conversationId,
      threadId: task.threadId, taskId: task.id, runId, kind: 'run.stageAdvanced', createdAt: Date.now(),
      payload: { stage: 'INDEPENDENT', rosterRevision: prevRoster.r + 1, members: route.frozenMemberIds },
    });
  });
  tx();
  enqueueIndependentSteps(db, runId, task.id, route.frozenMemberIds);
  return domainOk({ runId });
}

function enqueueIndependentSteps(db: ZhongshuoDatabase, runId: string, taskId: string, memberIds: readonly string[]): void {
  const tx = db.transaction(() => {
    for (const memberId of memberIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId, stage: 'IND', memberId, roundNo: 0, purpose: 'stage_work' }) });
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
  // 最新 run（任意状态）：INTERRUPTED 需如实 surfaced；终态的其他状态不推进。
  const run = db.prepare(
    "SELECT * FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE' ORDER BY rowid DESC LIMIT 1",
  ).get(taskId) as (RunRow & { stage_started_at: number | null }) | undefined;
  if (run == null) return { advanced: false };
  const unknown=db.prepare(`SELECT a.id FROM agent_turns a WHERE a.run_id=? AND a.status='UNKNOWN'
    AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='recovery.protectionReleased' AND json_extract(e.payload_json,'$.released')=1) LIMIT 1`).get(run.id) as {id:string}|undefined;
  if(unknown&&['RUNNING','WAITING'].includes(run.status)){
    db.prepare("UPDATE workflow_runs SET status='INTERRUPTED' WHERE id=?").run(run.id);
    db.prepare("UPDATE tasks SET status='BLOCKED',revision=revision+1 WHERE id=? AND status NOT IN ('CANCELLED','DONE')").run(taskId);
    appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:projectIdOf(db,taskId),conversationId:run.conversation_id,threadId:run.thread_id,taskId,runId:run.id,kind:'run.unknownBlocked',createdAt:now,payload:{turnId:unknown.id,message:'成员执行结果未知；保留原请求和保护，不继续自动研讨或生成成功交付'}});
    return {advanced:false,blocked:'成员执行结果未知，等待人工核实'};
  }
  if (run.status === 'INTERRUPTED') {
    // 单轮超时/中断后结果不确定（§10.2 不伪造）：如实把任务置 BLOCKED 供用户决策
    // （重开新研讨或停止），不让界面停在"进行中"。
    db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = ? AND status NOT IN ('CANCELLED','DONE','BLOCKED')").run(taskId);
    return { advanced: false, blocked: '运行中断（单轮超时结果不确定）' };
  }
  if (!['RUNNING', 'WAITING'].includes(run.status)) return { advanced: false };
  const task = db.prepare('SELECT id, conversation_id, conversation_thread_id, status FROM tasks WHERE id = ?').get(taskId) as
    | { id: string; conversation_id: string; conversation_thread_id: string | null; status: string }
    | undefined;
  if (task == null || ['CANCELLED', 'DONE'].includes(task.status)) return { advanced: false };
  const threadId = task.conversation_thread_id ?? run.thread_id ?? '';
  const roster = rosterOf(db, run.id);
  // E4 语义（修复轮）：排队等待≠缺席——缺席只来自成员自己的执行事实（宽限/截止中断/
  // UNKNOWN）。阶段起算时间只用于排队观察线，不标记成员。
  const stage = run.stage ?? 'INDEPENDENT';
  let participants = participantsOf(db, run.id);
  if (options.absenceToleranceMs > 0) {
    evaluateMemberAbsence(db, run.id, stage, now, options.absenceToleranceMs, roster.members.map((m) => m.memberId));
    participants = participantsOf(db, run.id); // 宽限标记后重读
  }
  if (options.dispatchWaitDeadlineMs != null && run.stage_started_at != null && now - run.stage_started_at >= options.dispatchWaitDeadlineMs) {
    for (const m of roster.members) {
      const dispatched = db.prepare('SELECT id FROM agent_turns WHERE run_id = ? AND member_id = ? AND stage_key LIKE ? LIMIT 1').get(run.id, m.memberId, `${stageTurnPrefix(stage)}%`);
      if (dispatched == null) noteDispatchWait(db, run.id, stage, now, now - run.stage_started_at, m.memberId);
    }
  }
  const drafts = frozenDrafts(db, run.id);

  const budget = readBudget(run.budget_json);
  // §6.5 预算兜底：前置配额耗尽且无在途步骤时，转入整合（有产出即出诚实报告；
  // 无任何产出 → BLOCKED，不合成虚构研讨）。讨论轮被截停属预期（AT-05）。
  const frontAvail = budgetAccounting(budget, 'front').stageAvailableTurns;
  if (frontAvail < 1 && ['INDEPENDENT', 'CROSS_REVIEW', 'ISSUE_DISCUSSION'].includes(stage) && drafts.length > 0) {
    const noPendingSteps = (db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ? AND status IN ('pending','leased')").get(`task:${taskId}:delib:${run.id}:%`) as { c: number }).c === 0;
    if (noPendingSteps) {
      advanceStage(db, run.id, taskId, 'SYNTHESIS', 0, now, { from: stage, reason: '前置预算耗尽，按 §6.5 转入整合' });
      freezeSynthesisInputs(db, run.id);
      enqueueSynthesis(db, run.id, taskId, hostOf(roster));
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
        // 冻结互评输入清单：此后到达的迟到初稿不入本阶段任何成员的互评材料（§4.3/E4 边界）。
        freezeStageInputs(db, run.id, 'CROSS_REVIEW', 0, artifactsEntries(db, run.id, 'analysis_draft'));
        enqueueReviewerSteps(db, run.id, taskId, drafts.map((d) => d.memberId));
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
          // 冻结第 2 轮起的讨论输入清单（初稿+互评集合，迟到材料不改）。
          freezeStageInputs(db, run.id, 'ISSUE_DISCUSSION', 1, inputEntriesOf(db, run.id, drafts.map((d) => d.artifactId), reviews.map((r) => r.stance)));
          const tx = db.transaction(() => {
            insertIssues(db, run.id, issues.map((i) => ({ issueId: i.issueId, statement: i.statement, evidenceRefs: [] })), 1);
            advanceStage(db, run.id, taskId, 'ISSUE_DISCUSSION', 1, now, { from: 'CROSS_REVIEW', reason: next.reason, issueCount: issues.length });
          });
          tx();
          enqueueIssueSteps(db, run.id, taskId, reviewers, 1);
        } else {
          advanceStage(db, run.id, taskId, 'SYNTHESIS', 0, now, { from: 'CROSS_REVIEW', reason: next.reason });
          freezeSynthesisInputs(db, run.id);
          enqueueSynthesis(db, run.id, taskId, hostOf(roster));
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
      // 'completed' 指上一阶段产出——本阶段收齐只认本阶段产出或跨阶段终结（缺席/失败/unavailable）。
      const allSettled = facts.every((f) => f.hasStageOutput || f.status === 'absent' || f.status === 'failed' || f.status === 'unavailable');
      if (!allSettled) return { advanced: false };
      // 第 3 轮强制检查点（§6.1）：host、意见已收集、未派发过。
      const host = hostOf(roster);
      const checkpointDone = listRunArtifacts(db, run.id, 'checkpoint_verdict').some((a) => a.revision === round);
      if (round === 3 && !checkpointDone) {
        enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId: run.id, stage: 'CHK', memberId: host, roundNo: round, purpose: 'checkpoint' }) });
        return { advanced: false };
      }
      if (round === 3 && checkpointDone) {
        const verdict = checkpointVerdictOf(db, run.id, round);
        if (verdict === 'continue') {
          advanceStage(db, run.id, taskId, 'ISSUE_DISCUSSION', round + 1, now, { from: 'ISSUE_DISCUSSION', reason: '第 3 轮检查点：继续（有新证据）', round: round + 1 });
          enqueueIssueSteps(db, run.id, taskId, reviewers, round + 1);
          return { advanced: true };
        }
        advanceStage(db, run.id, taskId, 'SYNTHESIS', 0, now, { from: 'ISSUE_DISCUSSION', reason: '检查点停止/预算上限，转入整合' });
        enqueueSynthesis(db, run.id, taskId, host);
        return { advanced: true };
      }
      if (round > 3) {
        // 检查点后的额外轮：一轮后即回检查点语义（预算承担硬上限，决策 06）。
        advanceStage(db, run.id, taskId, 'SYNTHESIS', 0, now, { from: 'ISSUE_DISCUSSION', reason: `第 ${round} 轮完成，转入整合` });
        freezeSynthesisInputs(db, run.id);
        enqueueSynthesis(db, run.id, taskId, host);
        return { advanced: true };
      }
      // round 1→2：直接进入下一轮（每轮开始冻结争议与证据版本；M1 复用 revision 1 争议集）。
      advanceStage(db, run.id, taskId, 'ISSUE_DISCUSSION', round + 1, now, { from: 'ISSUE_DISCUSSION', reason: `第 ${round} 轮意见收齐`, round: round + 1 });
      enqueueIssueSteps(db, run.id, taskId, reviewers, round + 1);
      return { advanced: true };
    }
    case 'SYNTHESIS': {
      const synthesis = currentSynthesisVersion(db, run.id);
      if (synthesis != null) return { advanced: false }; // 完成路径已入队 RATIFY
      const host = hostOf(roster);
      const hostFailed = statusOf(participants, host) === 'failed';
      // 在途守卫（E4 解耦）：SYN 已派发未终结（outbox 未 done 或 turn 非终态）→ 等待，
      // 不做预算失败判定——在途占用的预算会被误算成"预算不足以整合"（inline 串行下
      // 派发与完成同轮，从未暴露；detached 高频泵每 tick 都会看到在途状态）。
      const synKey = delibDispatchKey({ taskId, runId: run.id, stage: 'SYN', memberId: host, roundNo: 0, purpose: 'stage_work' });
      const synPending = db
        .prepare("SELECT 1 FROM outbox WHERE dispatch_key = ? AND status != 'done'")
        .get(synKey) != null;
      const synTurnOpen = db
        .prepare("SELECT 1 FROM agent_turns WHERE dispatch_key = ? AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','UNKNOWN')")
        .get(synKey) != null;
      if (!hostFailed && (synPending || synTurnOpen)) return { advanced: false };
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
      // 屏障收口（确定性，非 wall-clock）：待定格的成员若仍有可派发/在途的 RAT 步骤则等待；
      // 否则（席位失败/缺席/预算跳过）按 missing 关闭——程序记录，不伪造意见。
      const waiting = expectedMembers.filter((memberId) => {
        const cells = records.filter((r) => r.member_id === memberId);
        if (cells.length === 0) return true; // 矩阵不完整：等（不应发生）
        if (cells.some((r) => r.response_status === 'submitted')) return false;
        const participant = statusOf(participants, memberId);
        if (participant === 'failed' || participant === 'absent' || participant === 'unavailable') return false;
        const itemPending = (db.prepare("SELECT count(*) c FROM outbox WHERE dispatch_key LIKE ? AND status IN ('pending','leased')").get(`task:${taskId}:delib:${run.id}:RAT:${memberId}:%`) as { c: number }).c > 0;
        const turnActive = (db.prepare("SELECT count(*) c FROM agent_turns t JOIN outbox o ON o.turn_id = t.id WHERE t.run_id = ? AND t.member_id = ? AND t.stage_key = 'delib.ratify' AND t.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT')").get(run.id, memberId) as { c: number }).c > 0;
        return itemPending || turnActive;
      });
      if (waiting.length > 0) return { advanced: false };
      closeRatificationBarrier(db, { runId: run.id, synthesisArtifactId: synthesis.artifactId, synthesisRevision: synthesis.revision, missingReason: '席位终结（失败/缺席/预算跳过），未回复' });
      publishFinalReport(db, { runId: run.id, taskId, conversationId: task.conversation_id, threadId, claims, expectedMembers, synthesis, now, blobDir: options.blobDir, reviewPolicy: reviewPolicyOf(db, taskId) });
      return { advanced: true };
    }
    default:
      return { advanced: false };
  }
}

/** Stop is complete only after this exact run has no unclosed execution facts. */
export function settleStoppedDeliberation(db:ZhongshuoDatabase,taskId:string,runId:string):boolean {
  const run=db.prepare("SELECT id FROM workflow_runs WHERE id=? AND task_id=? AND mode='DELIBERATE' AND status='STOPPING'").get(runId,taskId);
  if(!run)return false;
  const active=db.prepare(`SELECT 1 FROM agent_turns a WHERE a.run_id=? AND (a.status IN ('PENDING','DISPATCHING','RUNNING','WAITING_APPROVAL','WAITING_INPUT','STOPPING')
    OR a.status='UNKNOWN' AND NOT EXISTS(SELECT 1 FROM domain_events e WHERE e.turn_id=a.id AND e.kind='recovery.protectionReleased' AND json_extract(e.payload_json,'$.released')=1)) LIMIT 1`).get(runId);
  if(active)return false;
  db.transaction(()=>{
    db.prepare("UPDATE workflow_runs SET status='CANCELLED' WHERE id=? AND task_id=? AND status='STOPPING'").run(runId,taskId);
    const latest=db.prepare('SELECT id FROM workflow_runs WHERE task_id=? ORDER BY rowid DESC LIMIT 1').get(taskId) as {id:string}|undefined;
    if(latest?.id===runId)db.prepare("UPDATE tasks SET status='CANCELLED',revision=revision+1 WHERE id=? AND status!='CANCELLED'").run(taskId);
    const task=db.prepare('SELECT project_id,conversation_id,conversation_thread_id FROM tasks WHERE id=?').get(taskId) as {project_id:string;conversation_id:string;conversation_thread_id:string};
    appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:task.project_id,conversationId:task.conversation_id,threadId:task.conversation_thread_id,taskId,runId,kind:'run.statusChanged',createdAt:Date.now(),payload:{status:'CANCELLED',reason:'本轮全部已知执行已收口；排队步骤未启动'}});
  })();return true;
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

function advanceStage(db: ZhongshuoDatabase, runId: string, taskId: string, stage: string, roundNo: number, now: number, payload: Record<string, unknown>): void {
  db.prepare('UPDATE workflow_runs SET stage = ?, round_no = ?, stage_started_at = ?, revision = revision + 1 WHERE id = ?').run(stage, roundNo, now, runId);
  appendDomainEvent(db, {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: '', conversationId: '',
    threadId: null, taskId, runId, kind: 'run.stageAdvanced', createdAt: now, payload: { stage, ...payload },
  });
}

function enqueueReviewerSteps(db: ZhongshuoDatabase, runId: string, taskId: string, reviewerIds: readonly string[]): void {
  const tx = db.transaction(() => {
    for (const memberId of [...reviewerIds].sort()) { // 成员序确定：派发顺序可复现
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId, stage: 'CR', memberId, roundNo: 0, purpose: 'stage_work' }) });
    }
  });
  tx();
}

function enqueueIssueSteps(db: ZhongshuoDatabase, runId: string, taskId: string, memberIds: readonly string[], round: number): void {
  const tx = db.transaction(() => {
    for (const memberId of memberIds) {
      enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId, stage: 'ISS', memberId, roundNo: round, purpose: 'stage_work' }) });
    }
  });
  tx();
}

function enqueueSynthesis(db: ZhongshuoDatabase, runId: string, taskId: string, hostId: string): void {
  const tx = db.transaction(() => {
    enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId, runId, stage: 'SYN', memberId: hostId, roundNo: 0, purpose: 'stage_work' }) });
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
  const synthesisPayload = artifactPayload(db, input.synthesis.artifactId) as { summary?: string; claims?: Array<{ statement: string }>; disputedClaims?: Array<{ statement: string;disagreementSummary?:string }>;recommendations?:string[] } | null;
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
    recommendations:synthesisPayload?.recommendations??[],
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
    db.prepare("UPDATE task_deliveries SET review_status='superseded' WHERE task_id=? AND review_status='pending'").run(input.taskId);
    db.prepare(
      `INSERT INTO task_deliveries (id, task_id, run_id, revision, manifest_hash, artifact_refs_json, change_set_refs_json, verification_refs_json, review_status)
       VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', ?)`,
    ).run(deliveryId, input.taskId, input.runId,
      (db.prepare('SELECT COALESCE(MAX(revision),0)+1 n FROM task_deliveries WHERE task_id=?').get(input.taskId) as {n:number}).n,
      createHash('sha256').update(JSON.stringify({runId:input.runId,artifactId,reportPayload})).digest('hex'),JSON.stringify([`artifact:${artifactId}`]),reviewStatus);
    db.prepare('UPDATE tasks SET status = ?, current_delivery_id = ?, response_kind=\'work\',revision=revision+1 WHERE id = ?').run(reviewStatus === 'pending' ? 'REVIEW' : 'DONE', deliveryId, input.taskId);
    db.prepare("UPDATE workflow_runs SET stage = 'PUBLISH', status = 'SUCCEEDED', stage_started_at = ? WHERE id = ?").run(input.now, input.runId);
    const messageId=`msg_report_${input.runId}`;
    if(!db.prepare('SELECT 1 FROM messages WHERE id=?').get(messageId)){
      const task=db.prepare('SELECT project_id,room_id FROM tasks WHERE id=?').get(input.taskId) as {project_id:string;room_id:string};
      const conv=db.prepare('UPDATE conversations SET last_message_seq=last_message_seq+1 WHERE id=? RETURNING last_message_seq').get(input.conversationId) as {last_message_seq:number};
      const thread=db.prepare('UPDATE conversation_threads SET last_message_seq=last_message_seq+1,revision=revision+1 WHERE id=? RETURNING last_message_seq').get(input.threadId) as {last_message_seq:number};
      const labels:Record<string,string>={unanimous:'共同确认',qualified:'附条件确认',disputed:'存在分歧',unconfirmed:'尚未核实'};
      const text=[reportPayload.summary,...reportPayload.claimResults.map(c=>`${c.statement}（${labels[c.consensus]??c.consensus}）`),...reportPayload.disputedClaims.map(c=>`分歧：${c.statement}${c.disagreementSummary?` · ${c.disagreementSummary}`:''}`),...reportPayload.recommendations].filter(Boolean).join('\n\n');
      db.prepare(`INSERT INTO messages(id,project_id,conversation_id,conversation_seq,room_id,thread_id,task_id,thread_message_seq,author_type,author_id,body_json,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,'agent',?,?,'final',?)`).run(messageId,task.project_id,input.conversationId,conv.last_message_seq,task.room_id,input.threadId,input.taskId,thread.last_message_seq,hostOf(rosterOf(db,input.runId)),JSON.stringify({text,runtimeControlResult:JSON.stringify(reportPayload)}),input.now);
      appendDomainEvent(db,{schemaVersion:1,eventId:`evt_${randomUUID()}`,projectId:task.project_id,conversationId:input.conversationId,threadId:input.threadId,taskId:input.taskId,runId:input.runId,kind:'thread.replyAdded',createdAt:input.now,payload:{messageId}});
    }
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

/**
 * 迟到材料记录（不计数）：发布 artifact（run 作用域）+ 审计事件。
 * 已停止/旧 run/发布后到达——只展示迟到材料；报告更新走新运行/新版本。
 */
function recordLateArrival(db: ZhongshuoDatabase, input: { taskId: string; runId: string; step: DelibStep; turnId: string; finalText: string; options: DeliberationOptions }, now: number, reason: string): DomainResult<StepOutputResult> {
  const schema = STEP_SCHEMAS[input.step.stage];
  if (schema == null) return domainErr('VALIDATION_INVALID', `未知研讨步骤 ${input.step.stage}`);
  const parsed = schema.safeParse(JSON.parse(input.finalText));
  if (!parsed.success) return domainOk({ counted: false, needsRepair: `迟到输出未通过校验（${reason}）` });
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(input.taskId) as
    | { id: string; project_id: string; conversation_id: string; conversation_thread_id: string | null }
    | undefined;
  if (task == null) return domainErr('RESOURCE_NOT_FOUND', '任务不存在');
  const artifactId = `art_${input.turnId}`;
  const kind = stepArtifactKind(input.step.stage);
  const revision = input.step.stage === 'ISS' || input.step.stage === 'CHK' ? input.step.roundNo : 1;
  const published = publishDeliberationArtifact(db, {
    artifactId, projectId: task.project_id, conversationId: task.conversation_id, threadId: task.conversation_thread_id ?? '',
    taskId: input.taskId, runId: input.runId, authorId: input.step.memberId, kind, revision,
    payload: parsed.data, blobDir: input.options.blobDir, now,
  });
  if (!published.ok) return domainErr(published.error.code, published.error.message);
  appendDomainEvent(db, {
    schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: task.project_id, conversationId: task.conversation_id,
    threadId: task.conversation_thread_id, taskId: input.taskId, runId: input.runId, kind: 'run.lateArrivalRecorded', createdAt: now,
    payload: { memberId: input.step.memberId, stage: input.step.stage, roundNo: input.step.roundNo, reason, artifactId, counted: false },
  });
  return domainOk({ counted: false, lateRecorded: true });
}

function stepArtifactKind(stage: DelibStageCode): SaveArtifactInput['kind'] {
  return stage === 'IND' ? 'analysis_draft'
    : stage === 'CR' ? 'cross_review'
      : stage === 'ISS' ? 'issue_position'
        : stage === 'CHK' ? 'checkpoint_verdict'
          : stage === 'SYN' ? 'synthesis'
            : 'ratify_response';
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
  task: { id: string; title: string; objective: string | null; root_message_id: string | null; project_id: string },
  roster: FrozenRoster,
): string {
  const rootText = task.root_message_id != null
    ? ((db.prepare('SELECT body_json FROM messages WHERE id = ?').get(task.root_message_id) as { body_json: string } | undefined)?.body_json ?? '')
    : '';
  const review=db.prepare('SELECT revision,review_status,review_note FROM task_deliveries WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(task.id) as {revision:number;review_status:string;review_note:string|null}|undefined;
  const base = `任务：${task.title}\n目标：${task.objective ?? '（无）'}\n原始请求：${rootText}${review?.review_status==='changes_requested'?`\n本轮明确执行返工：交付v${review.revision}，用户意见：${review.review_note??'无'}`:''}`;
  if (step.stage === 'IND') {
    // 隔离：不含任何他人草稿（此刻也不读取）。文件发现=项目范围清单（两模式一致规则，第七轮
    // §13.4/§6.3：项目源码默认可读+命名排除；修复 C 组「文件名不可发现+工具面认知差」；
    // 清单只含项目根内文件，生成失败不阻断）。
    const projectRootRow = db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(task.project_id) as { canonical_path: string } | undefined;
    const listing = projectRootRow != null ? projectScopedFileListing(projectRootRow.canonical_path) : null;
    const listingBlock = listing != null
      ? `\n\n【文件发现（项目范围清单，程序侧提供）】可直接按相对路径读取的文件（排除 VCS 内部/依赖缓存/构建产物/常见凭据；${listing.files.length} 项${listing.truncated ? '，达上限已截断' : ''}）：\n${listing.files.join('\n')}\n清单完整性：${listing.integrityNote}`
      : '';
    return `${base}${listingBlock}\n\n你是独立分析成员（${step.memberId}）。请独立完成首轮分析。`;
  }
  if (step.stage === 'CR') {
    // 冻结清单约束：只读 CROSS_REVIEW 冻结版本中的初稿（迟到初稿不改任何同轮成员材料）。
    const manifest = frozenStageInputs(db, runId, 'CROSS_REVIEW', 0);
    const drafts = (manifest != null ? draftsFromManifest(db, runId, manifest) : frozenDrafts(db, runId)).filter((d) => d.memberId !== step.memberId);
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
    const manifest = frozenStageInputs(db, runId, 'SYNTHESIS', 0);
    const drafts = manifest != null ? draftsFromManifest(db, runId, manifest).filter((d) => d.payload.claims != null) : frozenDrafts(db, runId);
    const reviews = collectReviews(db, runId);
    const positions = collectIssuePositions(db, runId);
    return `${base}\n\n全部初稿：\n${JSON.stringify(drafts.map((d) => ({ artifactId: d.artifactId, revision: d.revision, author: d.memberId, summary: d.payload.summary, claims: d.payload.claims })), null, 2)}\n\n全部互评：\n${JSON.stringify(reviews, null, 2)}\n\n讨论立场：\n${JSON.stringify(positions, null, 2)}\n\n你是主持者（${hostOf(roster)}），产出整合稿：共识入 claims、分歧如实入 disputedClaims。`;
  }
  // RATIFY：绑定冻结清单的精确整合稿（artifactId+revision+hash；不凭 clm 名/文本片段）。
  const synthesis = frozenSynthesisOf(db, runId);
  if (synthesis == null) return `${base}\n（整合稿缺失）`;
  const claims = getSynthesisClaims(db, runId, synthesis.artifactId, synthesis.revision);
  return `${base}\n\n冻结整合稿（${synthesis.artifactId} rev${synthesis.revision} hash=${synthesis.hash.slice(0, 12)}…）结论清单：\n${JSON.stringify(claims.map((c) => ({ claimId: c.claim_id, statement: c.statement })), null, 2)}`;
}

function collectIssuePositions(db: ZhongshuoDatabase, runId: string): unknown {
  return db.prepare('SELECT issue_id, issue_revision, member_id, stance FROM positions WHERE issue_id IN (SELECT id FROM issues WHERE run_id = ?)').all(runId);
}

// ---------- 输出校验与计入屏障 ----------

export interface StepOutputResult {
  counted: boolean;
  needsRepair?: string;
  stageAdvanced?: boolean;
  /** 运行终态/停止/stale-run 后的迟到输出：材料已记录但不计入屏障（不是格式问题，不入修复）。 */
  lateRecorded?: boolean;
}

const STEP_SCHEMAS: Partial<Record<DelibStageCode, z.ZodTypeAny>> = {
  IND: analysisDraftPayloadSchema,
  CR: reviewPayloadSchema,
  ISS: issuePositionPayloadSchema,
  CHK: checkpointVerdictPayloadSchema,
  SYN: synthesisPayloadSchema,
  RAT: ratifyPayloadSchema,
};

export function deliberationOutputSchema(stage:DelibStageCode) {
  const schema=STEP_SCHEMAS[stage];if(!schema)throw Error('未知研讨输出阶段');
  return z.toJSONSchema(schema,{target:'draft-7'});
}

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
  // 迟到/过期守卫（修复轮）：运行已终结/已停止/step 归属旧 run → 只留迟到材料记录，
  // 不计入屏障、不复活运行（更新报告须走新运行/新版本，§6.5/E4）。
  const runRow = db.prepare('SELECT status, stage FROM workflow_runs WHERE id = ?').get(input.runId) as { status: string; stage: string | null } | undefined;
  const taskRow0 = db.prepare('SELECT stop_generation, status FROM tasks WHERE id = ?').get(input.taskId) as { stop_generation: number; status: string } | undefined;
  const runTerminal = runRow == null || !['RUNNING', 'WAITING'].includes(runRow.status);
  const stopScope=db.prepare('SELECT stop_generation FROM deliberation_run_scopes WHERE run_id=?').get(input.runId) as {stop_generation:number}|undefined;
  const stopped = taskRow0 != null && (taskRow0.stop_generation > (stopScope?.stop_generation??0) || taskRow0.status === 'CANCELLED');
  if (runTerminal || stopped || input.step.runId !== input.runId) {
    return recordLateArrival(db, input, now, runTerminal ? `run-${runRow?.status ?? 'gone'}` : stopped ? 'task-stopped' : 'stale-run');
  }
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
    const wasAbsent = statusOf(participantsOf(db, input.runId), input.step.memberId) === 'absent';
    db.prepare("UPDATE run_participants SET status = ? WHERE run_id = ? AND member_id = ? AND status IN ('pending','late','absent')")
      .run(wasAbsent ? 'late' : 'completed', input.runId, input.step.memberId);
    if (wasAbsent) {
      appendDomainEvent(db, {
        schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: projectIdOf(db, input.taskId), conversationId: '',
        threadId: null, taskId: input.taskId, runId: input.runId, kind: 'run.lateArrivalRecorded', createdAt: now,
        payload: { memberId: input.step.memberId, stage: input.step.stage, roundNo: input.step.roundNo, note: '缺席后成果到达，纳入后续未冻结输入' },
      });
    }
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
      // 冻结 RATIFY 输入=整合稿精确定位（artifactId+revision+hash，不凭 clm 名或文本片段）。
      freezeStageInputs(db, input.runId, 'RATIFY', 0, [{ artifactId, revision: 1, hash: (published as { value?: { hash?: string } }).value?.hash ?? '' }]);
      const roster = rosterOf(db, input.runId);
      initRatificationMatrix(db, {
        runId: input.runId, synthesisArtifactId: artifactId, synthesisRevision: 1,
        claimIds: claims.map((c) => c.claimId), memberIds: roster.members.map((m) => m.memberId), rosterRevision: roster.revision ?? 1,
      });
      advanceStage(db, input.runId, input.taskId, 'RATIFY', 0, now, { from: 'SYNTHESIS', reason: '整合稿冻结，进入确认', synthesisArtifactId: artifactId });
      const tx2members = roster.members.map((m: { memberId: string }) => m.memberId);
      for (const memberId of tx2members) {
        if (['absent', 'unavailable'].includes(statusOf(participantsOf(db, input.runId), memberId))) continue; // 缺席/排队截止者不再派发确认
        enqueueOutbox(db, { dispatchKey: delibDispatchKey({ taskId: input.taskId, runId: input.runId, stage: 'RAT', memberId, roundNo: 0, purpose: 'stage_work' }) });
      }
    }
    if (input.step.stage === 'RAT') {
      const synthesis = frozenSynthesisOf(db, input.runId);
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
