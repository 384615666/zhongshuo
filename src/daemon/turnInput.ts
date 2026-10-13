/**
 * DIRECT 本轮输入组装（DEV-21-M0；规格 §4/§5.2）。
 * 必要材料（用户根消息、获准线程历史）缺失 → 组装失败，调用方不得继续派发；
 * 渲染全文敏感扫描零命中（PP-03）；信封与渲染文本、hash 由本函数一并产出（PP-04）。
 */
import type { TurnRequest } from '../contracts/runtime.ts';
import type { effectiveTaskWriteAccess } from './projectWriteAccess.ts';
import { createHash } from 'node:crypto';
import { readVerifiedCopy, readVerifiedBlob, validateImageBuffer, truncateUtf8Bytes as truncateUtf8BytesInput, ATT_EXCERPT_BYTES } from './attachments.ts';
import { validateExtractCache, renderSheetWindow, ARTIFACT_PARSE_KINDS } from './parseContracts.ts';

/** 组装行 → 信封附件条目（第二十九轮二/三/四）。图片=持久发送选择：include 经成员认证与原件核验后提供字节输入；
 * omit/local-only/旧记录注入**未发送说明**，不宣称已读；文档类=原件实根+实身份+sha256 核对 +
 * 提取缓存严格校验（schema v2——结构/版本/预算不符=fail-closed 不派发）后按类渲染：
 * PDF 页标注 / DOCX 有序文本 / 幻灯片按页+备注 / 表格按范围窗口（有界默认）。返回
 * string=组装失败原因（fail-closed）。 */
type DocAttachmentRow = { id: string; source_name: string | null; hash: string; blob_path: string; revision: number; kind: string; extracted_text_json: string | null; range_spec?: string | null; image_mode?: string | null };
function documentAttachmentForInput(
  row: DocAttachmentRow,
  blobRoot: string | undefined,
  allowImages = false,
): { entry: { ref: string; filename: string; hash: string; revision: number; originalBytes: number; truncated: boolean; text: string }; image?: NonNullable<TurnRequest['images']>[number] } | { error: string } {
  const label = row.source_name ?? row.id;
  const NL = String.fromCharCode(10);
  if (row.kind === 'image_file') {
    if (row.image_mode === 'include') {
      if (!allowImages) return { error: 'IMAGE_INPUT_UNVERIFIED：当前实际派发成员不在图片认证组合内；原消息与原件保留' };
      const verified = readVerifiedBlob(row.blob_path, row.hash, blobRoot);
      if (!verified.ok) return { error: verified.error.message };
      const meta = validateImageBuffer(verified.raw);
      if (!meta.ok) return { error: meta.message };
      return { entry: { ref: row.id, filename: label, hash: row.hash, revision: row.revision, originalBytes: verified.raw.length, truncated: false,
        text: `【图片输入附件】「${label}」（sha256 ${row.hash} v${row.revision}）；内容通过本轮独立图片输入块提供。` },
        image: { artifactId: row.id, hash: row.hash, mime: meta.meta.mime, dataBase64: verified.raw.toString('base64') } };
    }
    return { entry: { ref: row.id, filename: label, hash: row.hash, revision: row.revision, originalBytes: 0, truncated: false, text: `【图片附件未发送】「${label}」（sha256 ${row.hash.slice(0, 12)}… v${row.revision}）：${row.image_mode === 'omit' ? '用户已明确选择仅发送文字' : row.image_mode === 'local-only' ? '该消息选择仅记录，只保存原件' : '历史版本没有图片输入授权'}；图片内容未发送，模型未读图。` } };
  }
  const mapping = ARTIFACT_PARSE_KINDS[row.kind];
  if (mapping == null) return { error: `附件类型（${row.kind}）不在注入范围——拒绝组装` };
  const verified = readVerifiedBlob(row.blob_path, row.hash, blobRoot); // 原件缺失/改写/越界=拒绝
  if (!verified.ok) return { error: verified.error.message };
  const cache = validateExtractCache(row.extracted_text_json, row.hash, mapping.cache);
  if (cache == null || cache.kind !== mapping.cache) return { error: `提取缓存缺失/无效（${label}）——重新预览生成缓存后重试（fail-closed，不以路径冒充已读）` };
  let joined = '';
  switch (cache.kind) {
    case 'pdf': {
      for (const pg of cache.pages) joined += `[第 ${pg.page} 页]${NL}${pg.text}${NL}`;
      break;
    }
    case 'docx': {
      joined = cache.text;
      break;
    }
    case 'slides': {
      for (const sl of cache.slides) {
        joined += `[幻灯片 ${sl.slide}]${NL}${sl.text}${NL}`;
        if (sl.notes.trim().length > 0) joined += `[幻灯片 ${sl.slide} 备注]${NL}${sl.notes}${NL}`;
      }
      break;
    }
    case 'sheet': {
      const rendered = renderSheetWindow(cache, row.range_spec ?? null, ATT_EXCERPT_BYTES);
      if (!rendered.ok) return { error: `表格注入失败（${label}）：${rendered.error}` };
      joined = rendered.text;
      break;
    }
  }
  const originalBytes = Buffer.byteLength(joined, 'utf8');
  const cut = truncateUtf8BytesInput(joined, ATT_EXCERPT_BYTES);
  return { entry: { ref: row.id, filename: label, hash: row.hash, revision: row.revision, originalBytes, truncated: cut.truncated, text: cut.text } };
}

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
  DM_STANDING_PROMPT_VERSION,
  TURN_BUNDLE_VERSION,
  turnBundleEnvelopeSchema,
} from '../contracts/prompts.ts';
import type { TurnBundleEnvelope } from '../contracts/prompts.ts';
import { projectScopedFileListing } from './fileDiscovery.ts';
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
  /** DM 输入水位（第十九轮四）：本轮用户消息 conversation_seq——历史边界（房间任务为 null）。 */
  inputThroughSeq?: number | null;
}

export interface AssemblyIdentity {
  member: { id: string; displayName: string };
  project: { id: string; displayName: string };
  room: { id: string; name: string };
}

export interface AssembledTurnInput {
  db: ZhongshuoDatabase;
  /** 本次 appData 的托管存储根（{appData}/blobstore——第二十八轮三：附件读取按实际根校验路径越界）。 */
  blobRoot?: string;
  allowImages?: boolean;
  writeAccess?: ReturnType<typeof effectiveTaskWriteAccess>;
  task: AssemblyTaskRef;
  identity: AssemblyIdentity;
  turnId: string;
  budget: BudgetState;
  /**
   * 格式修复上下文（第六轮，task.redispatch formatRepair:true）：原输出全文+校验错误注入
   * 下一 turn 输入附注——修复与原逻辑输出正确绑定（不是无反馈重跑）；不截短原内容。
   */
  repairContext?: { originalTurnId: string; sourceResultKey: string; issues: string[]; originalText: string };
  /**
   * 返工反馈（第九轮 RT-25 闭环）：最近一次人工验收为 changes_requested 时注入后续派发
   * 输入——明确关联被退回的交付版本与验收说明（不是无反馈重跑）；新交付验收通过后消失。
   */
  reviewFeedback?: { deliveryRevision: number; note: string | null };
}

export interface AssembledTurn {
  images?: TurnRequest['images'];
  envelope: TurnBundleEnvelope;
  /** 层 B 渲染文本（发给模型的形态）。 */
  text: string;
  bundleId: string;
  hash: string;
  resultKey: string;
}

export function assembleDirectTurn(input: AssembledTurnInput): DomainResult<AssembledTurn> {
  const { db, task } = input;
  if (task.conversationKind === 'dm') return assembleDmTurn(input);
  if (task.threadId == null) {
    return assemblyFailure('missing-thread', '房间任务缺少线程引用');
  }

  // 必要材料 1：用户根消息（任务的原始工作请求）。
  if (task.rootMessageId == null) {
    return assemblyFailure('missing-root-message', '任务缺少根消息引用');
  }
  const root = db
    .prepare('SELECT id, body_json, author_type, author_id FROM messages WHERE id = ?')
    .get(task.rootMessageId) as { id: string; body_json: string; author_type: string; author_id: string } | undefined;
  if (root == null) return assemblyFailure('missing-root-message', '根消息记录不存在');
  if (!isAcceptableRootAuthor(root.author_type, root.author_id)) {
    return assemblyFailure('root-not-user-request', '根消息作者不是用户（任务原始请求缺失）');
  }
  const rootBody = JSON.parse(root.body_json) as { text: string };
  // DEV-24 文本附件注入（第二十六轮五·能力④经授权交给模型；第二十七轮二扩展）：
  // 根消息 + **线程跟进消息**挂的 text_file 附件都进入本轮输入（跟进附件不漏；均为组装时
  // 已落库的消息=不提前读后续）。读**获准副本**（artifacts.blob_path——原文件变化不影响
  // 已保存版本）经共享完整性路径（第二十七轮四：路径限定托管存储+sha256 实际字节核对——
  // 损坏/越界拒绝组装，不以路径冒充已读）；UTF-8 字节截断保留完整字符。
  const images: NonNullable<TurnRequest['images']> = [];
  const rootAttachments: Array<{ ref: string; filename: string; hash: string; revision: number; originalBytes: number; truncated: boolean; text: string }> = [];
  const attRows = db.prepare(
    `SELECT a.id, a.source_name, a.hash, a.blob_path, a.revision, a.kind, a.extracted_text_json, ma.range_spec, json_extract(m.body_json, '$.imageInput') AS image_mode,
            CASE WHEN ma.message_id = ? THEN -1 ELSE COALESCE(m.thread_message_seq, 999999) END AS ord
     FROM message_attachments ma
     JOIN artifacts a ON a.id = ma.artifact_id
     LEFT JOIN messages m ON m.id = ma.message_id
     WHERE (ma.message_id = ? OR m.thread_id = ?) AND a.kind IN ('text_file','code_file','pdf_file','docx_file','sheet_file','slides_file','image_file')
     ORDER BY ord, ma.rowid`,
  ).all(root.id, root.id, task.threadId) as Array<{ id: string; source_name: string | null; hash: string; blob_path: string; revision: number; kind: string; extracted_text_json: string | null; range_spec: string | null; image_mode: string | null }>;
  for (const row of attRows) {
    if (row.kind === 'text_file' || row.kind === 'code_file') {
      const verified = readVerifiedCopy(row.blob_path, row.hash, input.blobRoot);
      if (!verified.ok) return assemblyFailure(verified.error.code, verified.error.message);
      rootAttachments.push({ ref: row.id, filename: row.source_name ?? row.id, hash: verified.copy.hash, revision: row.revision, originalBytes: verified.copy.originalBytes, truncated: verified.copy.truncated, text: verified.copy.text });
      continue;
    }
    // 文档类（PDF/DOCX/表格/幻灯片=严格缓存+原件核对；图片=未发送说明）——第二十九轮二/三/四。
    const doc = documentAttachmentForInput(row, input.blobRoot, input.allowImages);
    if ('error' in doc) return assemblyFailure('attachment-unreadable', doc.error);
    rootAttachments.push(doc.entry);
    if (doc.image != null && !images.some((i) => i.artifactId === doc.image!.artifactId)) images.push(doc.image);
  }
  // R67：同 dm_turn——正文空+有附件引用=合法文件-only 任务；空且无附件仍拒。
  if (typeof rootBody.text !== 'string' || rootBody.text.length === 0) {
    const rootAttCount2 = (db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(root.id) as { c: number }).c;
    if (rootAttCount2 === 0) {
      return assemblyFailure('empty-root-message', '根消息正文为空且无附件（拒绝构造空模型输入）');
    }
  }

  const projectRoot = (db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(task.projectId) as { canonical_path: string } | undefined)?.canonical_path;
  const fileDiscovery = projectRoot != null ? projectScopedFileListing(projectRoot) : null;

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
    permission: input.writeAccess ? { tier: input.writeAccess.tier, intent: input.writeAccess.intent, policyId: input.writeAccess.policyId, modificationAuthorized: input.writeAccess.modificationAuthorized, allowedWriteRoots: input.writeAccess.allowedWriteRoots } : { tier:'plan', intent:'analyze', policyId:'policy-analyze', modificationAuthorized:false, allowedWriteRoots:[] },
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
    attachments: rootAttachments,
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
    // 附注（仅在存在时加键——显式 undefined 会改变 canonicalJson 键集；非附注轮的信封
    // 必须与既有 hash 完全一致）：格式修复轮 / 返工反馈（RT-25：关联被退回的交付版本）。
    ...(() => {
      const notes: string[] = [];
      if (input.repairContext != null) {
        notes.push(
          '【格式修复轮】上一轮输出未通过 TaskComplete 校验。校验错误：',
          JSON.stringify(input.repairContext.issues),
          `上一轮原始输出（turn=${input.repairContext.originalTurnId}，源逻辑输出 resultKey=${input.repairContext.sourceResultKey}，全文保留）：`,
          input.repairContext.originalText,
          '修复要求：按输出契约重新提交完整 TaskComplete——分析结论/清单完整放入 changeSummary（不要缩短或删除内容）；除 schema 字段外不得新增字段（未知键会被拒绝）；不要用 Markdown 代码围栏包裹 JSON；resultKey 使用本轮给定值。',
        );
      }
      if (input.reviewFeedback != null) {
        notes.push(
          `【返工】此前交付（第 ${input.reviewFeedback.deliveryRevision} 版）未通过人工验收（要求修改）。`,
          `验收说明：${input.reviewFeedback.note ?? '（验收未附说明）'}`,
          '要求：针对上述验收反馈修改后重新提交完整 TaskComplete。',
        );
      }
      return notes.length > 0 ? { notes } : {};
    })(),
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
    images,
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

/** DM 会话历史窗口（续接上文=最近 N 条；截断如实标注）。 */
const DM_HISTORY_LIMIT = 50;

/** 可接受的根消息作者（第二十四轮四）：用户原文，或提醒事件（DEV-23——system 来源
 * +author_id=reminder:{id}，归属由 root.task_id===task.id 校验兜底）。 */
function isAcceptableRootAuthor(authorType: string, authorId?: string): boolean {
  if (authorType === 'human') return true;
  return authorType === 'system' && (authorId ?? '').startsWith('reminder:');
}

/**
 * 私信 turn 组装（DEV-22；R4 §2.1/§2.2；第十九轮四：输入水位）：上下文=本会话中
 **≤ 本次用户消息 conversation_seq* 的消息（后续已保存但排队的消息不提前进入前一轮——
 * 停止/重启/重领边界均可解释为"水位固定于任务创建事务"）；根消息按项目/会话/作者/归属
 * 四重校验（不是 messageId 存在即接受）；无线程/房间/名单——roster 只含对端；
 * promptVersion=私信模板；task.threadId=NULL。
 */
function assembleDmTurn(input: AssembledTurnInput): DomainResult<AssembledTurn> {
  const { db, task } = input;
  if (task.rootMessageId == null) return assemblyFailure('missing-root-message', 'dm_turn 缺少根消息引用（本次用户消息）');
  const root = db
    .prepare('SELECT id, body_json, author_type, author_id, conversation_id, project_id, task_id FROM messages WHERE id = ?')
    .get(task.rootMessageId) as { id: string; body_json: string; author_type: string; author_id: string; conversation_id: string; project_id: string; task_id: string | null } | undefined;
  if (root == null) return assemblyFailure('missing-root-message', '根消息记录不存在');
  // 归属校验（第十九轮四）：项目/会话/作者/任务四重——防跨会话/跨项目/伪造归属的根消息进入本轮输入。
  if (root.conversation_id !== task.conversationId || root.project_id !== task.projectId) {
    return assemblyFailure('root-scope-mismatch', '根消息不属于本任务的项目/会话——拒绝组装');
  }
  // 根消息作者=用户，或=提醒事件（DEV-23：system 来源+author_id=reminder:{id}——不伪装人类；
  // 任务归属校验（下行 root.task_id）保证该根确实属于本任务）。
  if (!isAcceptableRootAuthor(root.author_type, root.author_id)) {
    return assemblyFailure('root-not-user-request', 'dm_turn 根消息作者不是用户');
  }
  if (root.task_id !== task.id) {
    return assemblyFailure('root-scope-mismatch', `根消息任务归属不符（msg.task_id=${root.task_id ?? 'null'} ≠ 本任务）——拒绝组装`);
  }
  const rootBody = JSON.parse(root.body_json) as { text: string };
  // R67（用户已批准：只有文件也沿用当前模式发送）：正文可空——前提是根消息**带附件引用**
  //（模型输入=附件注入文本；上方 hasImages/omit-images 门已在提交侧挡掉「仅图片+仅文字」
  // 的空输入组合）。无正文且无附件仍按空根消息拒绝（不构造空输入）。
  if (typeof rootBody.text !== 'string' || rootBody.text.length === 0) {
    const rootAttCount = (db.prepare('SELECT count(*) c FROM message_attachments WHERE message_id = ?').get(root.id) as { c: number }).c;
    if (rootAttCount === 0) {
      return assemblyFailure('empty-root-message', 'dm_turn 根消息正文为空且无附件（拒绝构造空模型输入）');
    }
  }
  if (task.inputThroughSeq == null) {
    return assemblyFailure('missing-input-boundary', 'dm_turn 缺少输入水位（input_through_seq）——拒绝组装（边界必须可解释）');
  }
  // 本会话历史（≤ 水位）：按 conversation_seq 取最近 N 条（截断如实标注）。
  const history = db
    .prepare('SELECT id, conversation_seq, body_json, author_id FROM messages WHERE conversation_id = ? AND conversation_seq <= ? ORDER BY conversation_seq DESC LIMIT ?')
    .all(task.conversationId, task.inputThroughSeq, DM_HISTORY_LIMIT) as Array<{ id: string; conversation_seq: number; body_json: string; author_id: string }>;
  history.reverse();
  const historyTexts = history.map((h) => {
    const body = JSON.parse(h.body_json) as { text: string };
    return { messageId: h.id, author: h.author_id, text: body.text ?? '' };
  });
  // DEV-24 附件注入（DM；第二十七轮二扩展到**水位内全部历史消息**）：排队消息的附件随其
  // 消息进入正确一轮（该轮水位恰含此消息）；水位后（未来）消息的附件不提前读；根消息即使
  // 滑出历史窗口也必含（本轮输入本体）。读取经共享完整性路径（第二十七轮四：路径限定托管
  // 存储+sha256 实际字节核对——损坏/越界拒绝组装）；UTF-8 字节截断保留完整字符。
  const images: NonNullable<TurnRequest['images']> = [];
  const rootAttachments: Array<{ ref: string; filename: string; hash: string; revision: number; originalBytes: number; truncated: boolean; text: string }> = [];
  const dmAttIds = history.map((h) => h.id);
  if (!dmAttIds.includes(root.id)) dmAttIds.push(root.id);
  if (dmAttIds.length > 0) {
    const dmAttRows = db.prepare(
      `SELECT a.id, a.source_name, a.hash, a.blob_path, a.revision, a.kind, a.extracted_text_json, ma.range_spec, json_extract(m.body_json, '$.imageInput') AS image_mode,
              CASE WHEN ma.message_id = ? THEN -1 ELSE m.conversation_seq END AS ord
       FROM message_attachments ma
       JOIN artifacts a ON a.id = ma.artifact_id
       JOIN messages m ON m.id = ma.message_id
       WHERE ma.message_id IN (${dmAttIds.map(() => '?').join(',')}) AND a.kind IN ('text_file','code_file','pdf_file','docx_file','sheet_file','slides_file','image_file')
       ORDER BY ord, ma.rowid`,
    ).all(root.id, ...dmAttIds) as Array<{ id: string; source_name: string | null; hash: string; blob_path: string; revision: number; kind: string; extracted_text_json: string | null; range_spec: string | null; image_mode: string | null }>;
    for (const row of dmAttRows) {
      if (row.kind === 'text_file' || row.kind === 'code_file') {
        const verified = readVerifiedCopy(row.blob_path, row.hash, input.blobRoot);
        if (!verified.ok) return assemblyFailure(verified.error.code, verified.error.message);
        rootAttachments.push({ ref: row.id, filename: row.source_name ?? row.id, hash: verified.copy.hash, revision: row.revision, originalBytes: verified.copy.originalBytes, truncated: verified.copy.truncated, text: verified.copy.text });
        continue;
      }
      // 文档类（同房间装配——严格缓存+原件核对；图片=未发送说明）。
      const doc = documentAttachmentForInput(row, input.blobRoot, input.allowImages);
      if ('error' in doc) return assemblyFailure('attachment-unreadable', doc.error);
      rootAttachments.push(doc.entry);
    if (doc.image != null && !images.some((i) => i.artifactId === doc.image!.artifactId)) images.push(doc.image);
    }
  }
  const remaining = input.budget.maxTurns - input.budget.usedTurns - input.budget.inFlightReservedTurns;
  const envelope: TurnBundleEnvelope = {
    bundleVersion: TURN_BUNDLE_VERSION,
    promptVersion: DM_STANDING_PROMPT_VERSION,
    turnId: input.turnId,
    taskRevision: task.taskRevision,
    mode: 'DIRECT',
    stage: null,
    turnPurpose: 'stage_work',
    you: { memberId: input.identity.member.id, role: 'executor' },
    roster: [{ memberId: input.identity.member.id, displayName: input.identity.member.displayName, status: 'expected' }],
    budget: {
      runMaxTurns: input.budget.maxTurns,
      usedTurns: input.budget.usedTurns,
      inFlightReservedTurns: input.budget.inFlightReservedTurns,
      remainingTurns: remaining,
      tailReserved: 0,
      tailReservationByStage: {},
      stageAvailableTurns: remaining,
    },
    permission: input.writeAccess ? { tier: input.writeAccess.tier, intent: input.writeAccess.intent, policyId: input.writeAccess.policyId, modificationAuthorized: input.writeAccess.modificationAuthorized, allowedWriteRoots: input.writeAccess.allowedWriteRoots } : { tier:'plan', intent:'analyze', policyId:'policy-analyze', modificationAuthorized:false, allowedWriteRoots:[] },
    task: {
      taskId: task.id,
      threadId: null, // DM 无线程（R4 §2.2）
      objective: task.objective ?? task.title,
      userConstraints: [],
    },
    baseline: null,
    materials: history.map((m) => ({
      ref: m.id,
      reason: m.id === root.id ? '用户本次消息' : '本会话历史（audience 推导——续接上文）',
      hash: `sha256:${sha256(messageTextOf(m.id, rootBody.text, historyTexts))}`,
    })),
    attachments: rootAttachments,
    threadDigest: {
      rootMessageId: root.id,
      rootText: rootBody.text,
      fromSeq: history[0]?.conversation_seq ?? 0,
      toSeq: history.length > 0 ? history[history.length - 1]!.conversation_seq : 0,
      truncated: history.length >= DM_HISTORY_LIMIT,
      messages: historyTexts,
    },
    // 附注（r58，review-r57 §3：DM 返工执行同样注入反馈——此前仅房间路径渲染，DM 返工
    // turn 的模型输入不含意见=无反馈重跑）：返工轮关联被退回的交付版本与验收说明；仅在
    // 存在时加键（非返工轮信封与既有 hash 完全一致）。
    ...(() => {
      const notes: string[] = [];
      if (input.reviewFeedback != null) {
        notes.push(
          `【返工】此前交付（第 ${input.reviewFeedback.deliveryRevision} 版）未通过人工验收（要求修改）。`,
          `验收说明：${input.reviewFeedback.note ?? '（验收未附说明）'}`,
          '要求：针对上述验收反馈修改后重新提交完整 TaskComplete。',
        );
      }
      return notes.length > 0 ? { notes } : {};
    })(),
    outputContract: {
      kind: 'TaskComplete',
      submitVia: 'final-result',
      resultKey: `result_${input.turnId}`,
      progressAllowed: true,
    },
    communicationContract: {
      mentionEnabled: false,
      disabledReason: '私信 1 对 1（§4.6）：无 @ 派工与成员唤醒',
    },
  };
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
    images,
    envelope,
    text,
    bundleId: `cb_${hash.slice(0, 24)}`,
    hash,
    resultKey: envelope.outputContract.resultKey,
  });
}

function assemblyFailure(reason: string, message: string, details?: unknown): DomainResult<never> {
  return domainErr('VALIDATION_INVALID', `输入组装失败（${reason}）：${message}`, { details: { reason, ...((details as object) ?? {}) } });
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
