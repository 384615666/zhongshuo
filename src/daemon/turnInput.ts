/**
 * DIRECT 本轮输入组装（DEV-21-M0；规格 §4/§5.2）。
 * 必要材料（用户根消息、获准线程历史）缺失 → 组装失败，调用方不得继续派发；
 * 渲染全文敏感扫描零命中（PP-03）；信封与渲染文本、hash 由本函数一并产出（PP-04）。
 */
import { createHash } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';
import type { BudgetState } from '../contracts/budget.ts';
import {
  computeTurnBundleHash,
  renderTurnBundle,
  scanSensitivePatterns,
  selectStageInstruction,
  STANDING_PROMPT_VERSION,
  TURN_BUNDLE_VERSION,
  turnBundleEnvelopeSchema,
} from '../contracts/prompts.ts';
import type { TurnBundleEnvelope } from '../contracts/prompts.ts';
import { taskScopedFileListing } from './fileDiscovery.ts';
import { filterContextScope } from '../domain/isolation/contextFilter.ts';

export interface AssemblyTaskRef {
  id: string;
  projectId: string;
  conversationId: string;
  conversationKind: 'room' | 'dm';
  roomId: string;
  threadId: string;
  rootMessageId: string | null;
  title: string;
  objective: string | null;
  taskRevision: number;
}

export interface AssemblyIdentity {
  member: { id: string; displayName: string };
  project: { id: string; displayName: string };
  room: { id: string; name: string };
}

export interface AssembledTurnInput {
  db: ZhongshuoDatabase;
  task: AssemblyTaskRef;
  identity: AssemblyIdentity;
  turnId: string;
  budget: BudgetState;
  /**
   * 格式修复上下文（第六轮，task.redispatch formatRepair:true）：原输出全文+校验错误注入
   * 下一 turn 输入附注——修复与原逻辑输出正确绑定（不是无反馈重跑）；不截短原内容。
   */
  repairContext?: { originalTurnId: string; sourceResultKey: string; issues: string[]; originalText: string };
}

export interface AssembledTurn {
  envelope: TurnBundleEnvelope;
  /** 层 B 渲染文本（发给模型的形态）。 */
  text: string;
  bundleId: string;
  hash: string;
  resultKey: string;
}

export function assembleDirectTurn(input: AssembledTurnInput): DomainResult<AssembledTurn> {
  const { db, task } = input;
  if (task.conversationKind === 'dm') {
    return domainErr('CAPABILITY_UNSUPPORTED', 'DM turn 组装契约随 DEV-22（M0 不派发私信 turn）');
  }

  // 必要材料 1：用户根消息（任务的原始工作请求）。
  if (task.rootMessageId == null) {
    return assemblyFailure('missing-root-message', '任务缺少根消息引用');
  }
  const root = db
    .prepare('SELECT id, body_json, author_type FROM messages WHERE id = ?')
    .get(task.rootMessageId) as { id: string; body_json: string; author_type: string } | undefined;
  if (root == null) return assemblyFailure('missing-root-message', '根消息记录不存在');
  if (root.author_type !== 'human') {
    return assemblyFailure('root-not-user-request', '根消息作者不是用户（任务原始请求缺失）');
  }
  const rootBody = JSON.parse(root.body_json) as { text: string };
  if (typeof rootBody.text !== 'string' || rootBody.text.length === 0) {
    return assemblyFailure('empty-root-message', '根消息正文为空');
  }

  const projectRoot = (db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(task.projectId) as { canonical_path: string } | undefined)?.canonical_path;
  const fileDiscovery = projectRoot != null ? taskScopedFileListing(db, task.projectId, task.id, projectRoot) : null;

  // 必要材料 2：本线程获准历史（§13.1-6：当前 root message、线程回复）。
  const history = db
    .prepare('SELECT id, body_json, author_id, thread_message_seq FROM messages WHERE thread_id = ? ORDER BY thread_message_seq')
    .all(task.threadId) as Array<{ id: string; body_json: string; author_id: string; thread_message_seq: number }>;
  const historyTexts = history.map((h) => {
    const body = JSON.parse(h.body_json) as { text: string };
    return { messageId: h.id, author: h.author_id, text: body.text ?? '' };
  });

  // §13.4 过滤：指令白名单 + 本线程消息（root + 回复）。
  const threadMessageIds = [root.id, ...history.map((h) => h.id)];
  const filtered = filterContextScope({
    task: { id: task.id, threadId: task.threadId },
    threadMessageIds,
    allowedDirectives: [`task:${task.id}:goal`],
    allowedSummaries: [`thread:${task.threadId}:summary`],
    allowedBaselineIds: [],
    grantedRefs: [],
    requestedRefs: [
      { kind: 'directive', refId: `task:${task.id}:goal` },
      ...threadMessageIds.map((id) => ({ kind: 'message' as const, refId: id })),
    ],
  });
  if (!filtered.ok) return filtered;
  const includedMessages = filtered.value.included.filter((r) => r.kind === 'message');

  // 模板选择（程序表）：M0 仅 DIRECT/executor/stage_work。
  const instruction = selectStageInstruction({ mode: 'DIRECT', role: 'executor', stage: null, turnPurpose: 'stage_work' });
  if (!instruction.ok) return instruction;

  const remaining = input.budget.maxTurns - input.budget.usedTurns - input.budget.inFlightReservedTurns;
  const envelope: TurnBundleEnvelope = {
    bundleVersion: TURN_BUNDLE_VERSION,
    promptVersion: STANDING_PROMPT_VERSION,
    turnId: input.turnId,
    taskRevision: task.taskRevision,
    mode: 'DIRECT',
    stage: null,
    turnPurpose: 'stage_work',
    you: { memberId: input.identity.member.id, role: 'executor' },
    roster: [
      { memberId: input.identity.member.id, displayName: input.identity.member.displayName, status: 'expected' },
    ],
    budget: {
      runMaxTurns: input.budget.maxTurns,
      usedTurns: input.budget.usedTurns,
      inFlightReservedTurns: input.budget.inFlightReservedTurns,
      remainingTurns: remaining,
      tailReserved: 0,
      tailReservationByStage: {},
      stageAvailableTurns: remaining,
    },
    permission: {
      tier: 'plan',
      intent: 'analyze',
      policyId: 'policy-analyze',
      modificationAuthorized: false,
      allowedWriteRoots: [],
    },
    task: {
      taskId: task.id,
      threadId: task.threadId,
      objective: task.objective ?? task.title,
      userConstraints: [],
    },
    baseline: null,
    materials: includedMessages.map((m) => ({
      ref: m.refId,
      reason: m.refId === root.id ? '用户根消息' : '本线程历史',
      hash: `sha256:${sha256(messageTextOf(m.refId, rootBody.text, historyTexts))}`,
    })),
    threadDigest: {
      rootMessageId: root.id,
      rootText: rootBody.text,
      fromSeq: 1,
      toSeq: history.length,
      truncated: false,
      messages: historyTexts,
    },
    // 文件发现（经授权清单，第六轮）：项目根存在时注入；生成失败不加键（不阻断派发）。
    ...(fileDiscovery != null ? { fileDiscovery } : {}),
    // 格式修复附注：仅在修复轮存在该键（显式 undefined 会改变 canonicalJson 键集——
    // 非修复轮的信封必须与既有 hash 完全一致）。
    ...(input.repairContext != null ? {
      notes: [
        '【格式修复轮】上一轮输出未通过 TaskComplete 校验。校验错误：',
        JSON.stringify(input.repairContext.issues),
        `上一轮原始输出（turn=${input.repairContext.originalTurnId}，源逻辑输出 resultKey=${input.repairContext.sourceResultKey}，全文保留）：`,
        input.repairContext.originalText,
        '修复要求：按输出契约重新提交完整 TaskComplete——分析结论/清单完整放入 changeSummary（不要缩短或删除内容）；除 schema 字段外不得新增字段（未知键会被拒绝）；不要用 Markdown 代码围栏包裹 JSON；resultKey 使用本轮给定值。',
      ],
    } : {}),
    outputContract: {
      kind: 'TaskComplete',
      submitVia: 'final-result',
      resultKey: `result_${input.turnId}`,
      progressAllowed: true,
    },
    communicationContract: {
      mentionEnabled: false,
      disabledReason: 'E11 提交契约与阶段允许表未完成（规格 §4.4.1）',
    },
  };

  // 信封 schema 校验（缺必填/多余字段在此拦下，不输出半成品输入包）。
  const parsed = turnBundleEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    return assemblyFailure('envelope-schema-invalid', `信封校验失败：${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  }

  const text = renderTurnBundle(envelope);
  const hits = scanSensitivePatterns(text);
  if (hits.length > 0) {
    return assemblyFailure('sensitive-content', '渲染输入含敏感模式（PP-03 零命中要求）', { hits });
  }
  const hash = computeTurnBundleHash(envelope);
  return domainOk({
    envelope,
    text,
    bundleId: `cb_${hash.slice(0, 24)}`,
    hash,
    resultKey: envelope.outputContract.resultKey,
  });
}

function messageTextOf(refId: string, rootText: string, history: Array<{ messageId: string; text: string }>): string {
  return history.find((h) => h.messageId === refId)?.text ?? rootText;
}

function assemblyFailure(reason: string, message: string, details?: unknown): DomainResult<never> {
  return domainErr('VALIDATION_INVALID', `输入组装失败（${reason}）：${message}`, { details: { reason, ...((details as object) ?? {}) } });
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
