/**
 * daemon 命令面（DEV-07；修复轮 5 扩充）。
 * - 每连接经凭据握手后才进入此处；CallerContext 由验证入口构造（可信）。
 * - project.open：引导默认成员/房间/房间成员关系/会话（room_members 不再由测试补）。
 * - 只读查询：room.list / member.list / thread.history / task.get（UI 稳定返回值）。
 * - dispatch.resume 参数化（confirm:true 显式确认）+ runCommand 幂等。
 * - task.stop 委托 requestStop（自包幂等/中断）。
 * - run() 为同步事务（ADR-I37）；异步命令自包 runCommand。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { runCommand } from '../persistence/commandGateway.ts';
import { createRoomRootTask } from '../persistence/stores/roomRootTask.ts';
import {
  createDmConversation, listDmConversations, dmConversationOf, dmPeerOf, dmLocalUserOf,
  releaseDmPauseGate, pumpDmQueue, dmHasActiveRun, createDmTurn, holdDmPauseGate,
} from '../persistence/stores/dm.ts';
import { openProject } from './projectStore.ts';
import { computeNextAt, validateSchedule, checkReminderBudget, recheckReminderAuthority, type ReminderSchedule } from './reminderScheduler.ts';
import { dispatchReminderExecution, reminderCallUsage } from './reminderDispatch.ts';
import { resolveTopLevelRoute } from '../domain/routing/topLevelRoute.ts';
import type { TopLevelRouteOutcome, MentionNode } from '../contracts/routing.ts';
import { commandEnvelopeSchema } from '../contracts/commands.ts';
import { computeCommandPayloadHash } from '../domain/idempotency.ts';
import { requestStop } from './stopFlow.ts';
import { appendDomainEvent, listEvents } from '../persistence/events.ts';
import { openDispatchGate } from '../persistence/daemonState.ts';
import { readMemberRuntimeBinding } from './memberRuntime.ts';
import { CLAUDE_ADAPTER_VERSION, claudeCapabilities } from '../adapter/claude/cliAdapter.ts';
import { createHash } from 'node:crypto';
import { refundReservedTurn as _refundReservedTurn, settleTurn as _settleTurn } from '../contracts/deliberation.ts';
import { checkProcessLiveness, type LivenessResult, type TreeScan } from './processCheck.ts';
import { getProbe as getProbeRecord, getTurnProcessRegistration, probeTurnExit, type ManagedJobObservation, type ProbeOutcome } from './processRegistry.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** DEV-24 文本附件（第二十六轮五）：副本上限与截断规则——超过 128KB 保存原文但预览/注入
 * 截断至 64KB（注明 originalBytes）；>256KB 拒绝（明确规则不静默）。 */
import { ATT_MAX_BYTES, ATT_EXCERPT_BYTES, ATT_TEXT_KINDS, kindForFilename, readVerifiedCopy } from './attachments.ts';

const deliberationBudgetFns = { refundReservedTurn: _refundReservedTurn, settleTurn: _settleTurn };
import { z } from 'zod';

export interface DaemonCommandDeps {
  db: ZhongshuoDatabase;
  localUserId: string;
  interruptTurn: (turnId: string) => Promise<void>;
  /** 应用数据目录（changeset.* 的受管理内容存储位置；entry 注入）。 */
  appDataDir?: string;
  /**
   * 同 daemon 内存联动钩子（DEV-13）：对账事务成功且 turn 已终态时释放 worker 准入账本中
   * 该 turn 的 UNKNOWN 保留占位（entry 接线 worker.reconcileRelease）。缺省（测试直连）不调用——
   * 持久事实（租约/UNKNOWN/gate）不依赖内存账本。
   */
  releaseAdmission?: (turnId: string) => void;
  /**
   * 进程存活查询函数（DEV-13 第七轮：OS 退出证据服务端生成）。缺省=checkProcessLiveness
   * （真实 OS 查询）；测试可注入故障（查询失败/PID 复用等场景仍走正式命令链）。
   */
  processQuery?: (pid: number) => LivenessResult;
  /**
   * 进程树归属分析注入（第八轮：测试故障模拟）；缺省=真实 analyzeProcessTree
   * （全表快照+现存树 BFS+活跃期快照历史代际核对）。
   */
  processTree?: (rootPid: number, historical: Array<{ pid: number; startedAt: number | null }>) => TreeScan;
  /**
   * 迟到成果泵（第八轮：entry 接线 worker.pumpLateEventsForTurn）。UNKNOWN turn 截止后
   * 到达的终态事件经 adapter 正式通道（lateEvents）进入生产路径。缺省（测试直连）时命令
   * 明确拒绝——不靠直调处理函数冒充生产支持。
   */
  pumpLateEvents?: (turnId: string) => Promise<{
    status: 'pumped' | 'not-found' | 'not-unknown' | 'unsupported-mode' | 'no-session' | 'unsupported';
    turnStatus?: string;
    reason?: string;
    applied?: Array<{ eventKey: string; outcome: string }>;
  }>;
  /**
   * 正式关闭入口（DEV-15 第十四轮三：daemon.shutdown——IPC 驱动的优雅停机；安装产物
   * 验证与 UI 宿主同路径）。注入方（standalone entry）自行调度实际 stop+退出（响应先于
   * 关闭发出）。缺省（内嵌测试实例）=命令明确拒绝——不经命令面伪造进程管理。
   */
  scheduleShutdown?: () => void;
}

export class DaemonCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DaemonCommandError';
    this.code = code;
  }
}

/**
 * 服务端退出取证解析（reconcile / releaseProtection 共用）：probeId 引用则校验
 * turn 归属/登记一致/新鲜（≤10 分钟）；否则按该 turn 已登记身份自动取证。
 * 只接受服务端生成的证据记录——调用方自报结果无从进入。
 */
function resolveServerProbe(deps: DaemonCommandDeps, turnId: string, probeId: string | undefined, now: number): ProbeOutcome {
  if (probeId != null) {
    const referenced = getProbeRecord(deps.db, probeId);
    if (referenced == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `引用的取证记录不存在：${probeId}`);
    if (referenced.turnId !== turnId) throw new DaemonCommandError('VALIDATION_INVALID', '取证记录不属于目标 turn（其他 turn 的证据不能冒充）');
    const reg = getTurnProcessRegistration(deps.db, turnId);
    if (reg == null || referenced.registryId !== reg.id) throw new DaemonCommandError('STALE_REVISION', '取证记录与当前进程登记不一致（登记已更新）——请重新取证');
    if (now - referenced.observedAt > 10 * 60 * 1000) throw new DaemonCommandError('STALE_REVISION', '取证记录已过期（>10 分钟）——请重新取证');
    return referenced;
  }
  return probeTurnExit(deps.db, turnId, deps.processQuery ?? ((pid: number) => checkProcessLiveness(pid)), {
    createdBy: 'reconcile', treeScan: deps.processTree,
    // 受管登记（第十四轮二）：按 managed_job_id 查现场——PID 复用/无句柄/错位不冒充证据。
    managedJob: managedJobObservation,
  });
}

/** 受管 job 现场观察（probe/reconcile 注入——jobId 查找+PID 辅助核对，第十四轮二）。 */
function managedJobObservation(jobId: string | null): ManagedJobObservation | null {
  if (jobId == null) return { held: false, pid: null, rootExited: false, activeCount: null };
  const mp = managedJobById(jobId);
  if (mp == null) return { held: false, pid: null, rootExited: false, activeCount: null };
  // rootExited 先取生命周期备忘（bridge close 后进程句柄已释放——handle 查询恒败，
  // 不能把「已完整结束」误报为「根仍存活」）；句柄在时以实时查询兜底。
  const memo = mp.lifecycle();
  return { held: true, pid: mp.pid, rootExited: memo.rootExited || !mp.waitRootExit(0).timedOut, activeCount: mp.activeCount() };
}

// REC-LIFE-1（第十四轮二）：受管证据按稳定身份（jobId）取用——PID 可复用，仅辅助核对。
import { managedJobById } from './managed/bridge.ts';
import { retireManagedJob } from './managedRetirement.ts';

const localScope = (userId: string): string => `user:${userId}`;

/** project.open 的默认引导（成员/房间/房间成员关系/会话；重复打开不重复创建）。 */
function bootstrapProject(db: ZhongshuoDatabase, projectId: string, agentNames?: string[]): void {
  const memberCount = (db.prepare('SELECT count(*) c FROM project_members WHERE project_id = ?').get(projectId) as { c: number }).c;
  if (memberCount === 0) {
    // 可选多成员引导（M1 研讨用；缺省单成员「执行成员」不变）。
    const names = agentNames != null && agentNames.length > 0 ? agentNames : ['执行成员'];
    for (const [i, name] of names.entries()) {
      db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES (?, ?, ?, 'agent', 1)`)
        .run(`m_default_${projectId}_${i}`, projectId, name);
    }
  }
  const roomCount = (db.prepare('SELECT count(*) c FROM rooms WHERE project_id = ?').get(projectId) as { c: number }).c;
  if (roomCount === 0) {
    const defaultMember = (db.prepare('SELECT id FROM project_members WHERE project_id = ? ORDER BY id LIMIT 1').get(projectId) as { id: string }).id;
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, '默认房间', ?)`)
      .run(`room_default_${projectId}`, projectId, defaultMember);
  }
  const roomId = `room_default_${projectId}`;
  // 房间成员关系（修复轮 5：此前 smoke 手工 INSERT 绕过——正式链路必须引导）。
  db.prepare('INSERT OR IGNORE INTO room_members (room_id, member_id) SELECT ?, id FROM project_members WHERE project_id = ?')
    .run(roomId, projectId);
  const convCount = (db.prepare('SELECT count(*) c FROM conversations WHERE room_id = ?').get(roomId) as { c: number }).c;
  if (convCount === 0) {
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)`)
      .run(`conv_default_${projectId}`, projectId, roomId);
  }
}

const messageSubmitParams = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('room_root'),
      projectId: z.string().min(1),
      conversationId: z.string().min(1),
      roomId: z.string().min(1),
    }),
    // 线程跟进（修复轮 6）：目标在提交时固定，异步返回不随界面焦点漂移。
    z.strictObject({
      kind: z.literal('thread'),
      projectId: z.string().min(1),
      conversationId: z.string().min(1),
      threadId: z.string().min(1),
      replyToMessageId: z.string().min(1).optional(),
    }),
    // 私信（DEV-22；R4 §2.3）：目标是会话本身——无房间/线程/任务号语义。
    z.strictObject({
      kind: z.literal('dm'),
      projectId: z.string().min(1),
      conversationId: z.string().min(1),
    }),
  ]),
  body: z.string().min(1),
  intent: z.enum(['default', 'record_only']),
  mentions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member'), memberId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('all') }),
  ])),
  attachmentRefs: z.array(z.string().min(1)).optional(),
});

function coordinatorOf(db: ZhongshuoDatabase, roomId: string): string {
  return (db.prepare('SELECT coordinator_member_id c FROM rooms WHERE id = ?').get(roomId) as { c: string } | undefined)?.c ?? '';
}
function enabledAgents(db: ZhongshuoDatabase, roomId: string): string[] {
  return (db.prepare(`SELECT rm.member_id FROM room_members rm JOIN project_members pm ON pm.id = rm.member_id WHERE rm.room_id = ? AND pm.enabled = 1`).all(roomId) as Array<{ member_id: string }>).map((r) => r.member_id);
}
function reviewPolicyOf(db: ZhongshuoDatabase, projectId: string): 'auto_deliver' | 'user_review' {
  const row = db.prepare('SELECT task_review_enabled FROM projects WHERE id = ?').get(projectId) as { task_review_enabled: number } | undefined;
  return row?.task_review_enabled === 1 ? 'user_review' : 'auto_deliver';
}

/**
 * 附件归属与能力校验（第二十七轮二：主池/任务线程/记录线程/DM 四通道共用）。
 * ref=artifacts.id；上传侧（attachment.uploadText）已校验 audience/归档/大小——此处对每个
 * 引用再核：存在、kind 支持、**归属会话与提交目标一致**（跨会话引用=audience 拒绝）。
 * 不存在/不支持/跨会话都明确拒绝——绝不静默丢附件。
 */
function resolveAttachmentRefs(
  db: ZhongshuoDatabase,
  conversationId: string,
  refs: string[] | undefined,
): Array<{ artifactId: string; displayName: string; hash: string }> {
  if (refs == null || refs.length === 0) return [];
  const out: Array<{ artifactId: string; displayName: string; hash: string }> = [];
  for (const attId of refs) {
    const att = db.prepare('SELECT conversation_id, kind, source_name, hash FROM artifacts WHERE id = ?').get(attId) as
      | { conversation_id: string; kind: string; source_name: string | null; hash: string }
      | undefined;
    if (att == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${attId}`);
    if (!(ATT_TEXT_KINDS as readonly string[]).includes(att.kind)) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `仅文本/代码/Markdown 附件（首包+代码批）——${attId} 为 ${att.kind}`);
    if (att.conversation_id !== conversationId) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 拒绝）');
    out.push({ artifactId: attId, displayName: att.source_name ?? attId, hash: att.hash });
  }
  return out;
}

/** 消息-附件关联（与消息插入同一事务调用——消息落库与关联原子）。 */
function attachMessageRefs(db: ZhongshuoDatabase, messageId: string, resolved: Array<{ artifactId: string; displayName: string; hash: string }>): void {
  for (const a of resolved) {
    db.prepare('INSERT INTO message_attachments (id, message_id, artifact_id, display_name, source_hash) VALUES (?, ?, ?, ?, ?)')
      .run(`matt_${randomUUID()}`, messageId, a.artifactId, a.displayName, a.hash);
  }
}

/** 历史读取用：批量取消息附件摘要（artifactId/filename——点击预览经 attachment.previewText
 * 走 audience+完整性校验，此处只发 id 与名字不下发正文）。 */
function messageAttachmentSummaries(db: ZhongshuoDatabase, messageIds: string[]): Map<string, Array<{ artifactId: string; filename: string }>> {
  const out = new Map<string, Array<{ artifactId: string; filename: string }>>();
  if (messageIds.length === 0) return out;
  const rows = db.prepare(
    `SELECT message_id, artifact_id, display_name FROM message_attachments WHERE message_id IN (${messageIds.map(() => '?').join(',')}) ORDER BY rowid`,
  ).all(...messageIds) as Array<{ message_id: string; artifact_id: string; display_name: string | null }>;
  for (const r of rows) {
    const list = out.get(r.message_id) ?? [];
    list.push({ artifactId: r.artifact_id, filename: r.display_name ?? r.artifact_id });
    out.set(r.message_id, list);
  }
  return out;
}

/** 就地为驼峰历史条目（thread.history items）填 attachments 摘要。 */
function attachMessageSummaries(db: ZhongshuoDatabase, items: Array<{ id: string; attachments?: unknown }>): void {
  const byMsg = messageAttachmentSummaries(db, items.map((i) => i.id));
  for (const it of items) it.attachments = byMsg.get(it.id) ?? [];
}

/** 线程内插入一条消息（修复轮 6：thread 目标提交的持久化路径；会话/线程序号事务内分配）。 */
function insertThreadMessage(
  db: ZhongshuoDatabase,
  input: {
    projectId: string;
    conversationId: string;
    roomId: string;
    threadId: string;
    threadMessageSeq: number;
    body: string;
    mentions: readonly MentionNode[];
    authorId: string;
    taskId: string | null;
  },
): { messageId: string; conversationId: string; threadId: string; threadMessageSeq: number } {
  const messageId = `msg_${randomUUID()}`;
  const conversationSeq = (db.prepare('UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq').get(input.conversationId) as { last_message_seq: number }).last_message_seq;
  db.prepare(`INSERT INTO messages (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id, thread_message_seq, author_type, author_id, body_json, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?, 'saved', ?)`)
    .run(messageId, input.projectId, input.conversationId, conversationSeq, input.roomId, input.threadId, input.taskId, input.threadMessageSeq, input.authorId, JSON.stringify({ text: input.body, mentions: input.mentions }), Date.now());
  db.prepare('UPDATE conversation_threads SET last_message_seq = ?, revision = revision + 1 WHERE id = ?')
    .run(input.threadMessageSeq, input.threadId);
  appendDomainEvent(db, {
    schemaVersion: 1,
    eventId: `evt_${randomUUID()}`,
    projectId: input.projectId,
    conversationId: input.conversationId,
    threadId: input.threadId,
    taskId: input.taskId ?? undefined,
    kind: 'thread.replyAdded',
    createdAt: Date.now(),
    payload: { messageId },
  });
  return { messageId, conversationId: input.conversationId, threadId: input.threadId, threadMessageSeq: input.threadMessageSeq };
}

/**
 * 会话级 audience 校验（DEV-18 第二三轮三）：统一按目标**实际 conversation** 核对——
 * DM=双成员（本地用户必须是人参与者；否则任何链接形态/汇总都不得泄露）；房间=项目可达。
 * #task/#delivery/#msg/mine.pending/task.review 全走这一处，不留下可绕过的链接形态。
 */
function assertConversationAudience(db: ZhongshuoDatabase, localUserId: string, conversationId: string): { projectId: string; kind: string } {
  const conv = db.prepare('SELECT project_id AS project_id_, kind FROM conversations WHERE id = ?').get(conversationId) as { project_id_: string; kind: string } | undefined;
  if (conv == null) throw new DaemonCommandError('NOT_FOUND', `会话不存在或已删除：${conversationId}`);
  if (conv.kind === 'dm') {
    if (dmLocalUserOf(db, conversationId) !== localUserId) throw new DaemonCommandError('FORBIDDEN', '目标属于他人私信（audience 校验拒绝）');
  } else if (db.prepare('SELECT id FROM projects WHERE id = ?').get(conv.project_id_) == null) {
    throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话所属项目不可达');
  }
  return { projectId: conv.project_id_, kind: conv.kind };
}

/** 项目根路径（深链跨项目切换用：renderer 需以 path 打开来源项目——project.open 按 path）。 */
function rootPathOf(db: ZhongshuoDatabase, projectId: string): string | null {
  return (db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(projectId) as { canonical_path: string } | undefined)?.canonical_path ?? null;
}

export async function dispatchDaemonCommand(deps: DaemonCommandDeps, envelope: unknown): Promise<unknown> {
  const parsedEnvelope = commandEnvelopeSchema(z.unknown()).safeParse(envelope);
  // 信封校验失败时 commandId 尽力取原始 envelope 的（可能缺失）——客户端丢弃无等待者响应。
  const fallbackCommandId = (envelope as { commandId?: string })?.commandId;
  if (!parsedEnvelope.success) {
    return { commandId: fallbackCommandId, ok: false, error: { code: 'VALIDATION_INVALID', message: `信封校验失败：${parsedEnvelope.error?.issues[0]?.message ?? '无效'}`, retryable: false } };
  }
  const env = parsedEnvelope.data;
  // 所有可关联回执（成功与错误）都带 commandId：客户端按它配对响应（修复轮 6）。
  const withCommandId = (result: object): object => ({ commandId: env.commandId, ...result });
  const payloadHash = computeCommandPayloadHash({ method: env.method, target: null, params: env.params, expectedRevision: env.expectedRevision ?? null });
  const scope = localScope(deps.localUserId);
  // runCommand 为同步事务：handler 必须同步返回（异步命令自包 runCommand，如 task.stop）。
  const run = <T>(handler: () => T): { data: T; replayed: boolean } => {
    const outcome = runCommand<T>(deps.db, { idempotencyScope: scope, commandId: env.commandId, payloadHash, now: Date.now() }, handler);
    if (!outcome.ok) throw new DaemonCommandError(outcome.error.code, outcome.error.message);
    return { data: outcome.data, replayed: outcome.replayed };
  };

  try {
    switch (env.method) {
      case 'project.open': {
        const params = z.strictObject({ path: z.string().min(1), displayName: z.string().optional(), agentNames: z.array(z.string().min(1)).optional() }).parse(env.params);
        const result = run(() => {
          const opened = openProject(deps.db, { rootPath: params.path, displayName: params.displayName, now: Date.now() });
          if (!opened.ok) throw new DaemonCommandError(opened.error.code, opened.error.message);
          bootstrapProject(deps.db, opened.value.project.id, params.agentNames ?? (process.env.ZS_BOOTSTRAP_AGENTS?.split(',').filter((n) => n.trim().length > 0)));
          return { project: opened.value.project, created: opened.value.created };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'room.create': {
        // 建房命令（M1 收口轮）：房间为项目的正式聚合单元——跨房间切换/隔离 UI 场景的前提。
        const params = z.strictObject({ projectId: z.string().min(1), name: z.string().min(1).max(60), memberIds: z.array(z.string().min(1)).optional() }).parse(env.params);
        const result = run(() => {
          const roomCount = (deps.db.prepare('SELECT count(*) c FROM rooms WHERE project_id = ?').get(params.projectId) as { c: number }).c;
          const roomId = `room_${randomUUID()}`;
          const defaultMember = (deps.db.prepare('SELECT id FROM project_members WHERE project_id = ? AND principal_type = ? ORDER BY id LIMIT 1').get(params.projectId, 'agent') as { id: string } | undefined)?.id;
          deps.db.prepare('INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, ?, ?)').run(roomId, params.projectId, params.name, defaultMember ?? null);
          const convId = `conv_${randomUUID()}`;
          deps.db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)").run(convId, params.projectId, roomId);
          const members = params.memberIds ?? (deps.db.prepare('SELECT id FROM project_members WHERE project_id = ?').all(params.projectId) as Array<{ id: string }>).map((m) => m.id);
          for (const memberId of members) {
            deps.db.prepare('INSERT OR IGNORE INTO room_members (room_id, member_id) VALUES (?, ?)').run(roomId, memberId);
          }
          return { room: { id: roomId, name: params.name, conversationId: convId }, roomIndex: roomCount + 1 };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'room.list': {
        const params = z.strictObject({ projectId: z.string().min(1) }).parse(env.params);
        const rooms = deps.db.prepare('SELECT id, name, archived_at FROM rooms WHERE project_id = ? ORDER BY id').all(params.projectId) as Array<{ id: string; name: string; archived_at: number | null }>;
        const items = rooms.map((r) => {
          const conversation = deps.db.prepare('SELECT id FROM conversations WHERE room_id = ? LIMIT 1').get(r.id) as { id: string } | undefined;
          return { id: r.id, name: r.name, archived: r.archived_at != null, conversationId: conversation?.id ?? null };
        });
        return withCommandId({ ok: true, data: { items } });
      }
      case 'member.list': {
        const params = z.strictObject({ projectId: z.string().min(1), roomId: z.string().min(1).optional() }).parse(env.params);
        const rows = params.roomId != null
          ? (deps.db.prepare(`SELECT pm.id, pm.display_name, pm.principal_type, pm.enabled FROM room_members rm JOIN project_members pm ON pm.id = rm.member_id WHERE rm.room_id = ? ORDER BY pm.id`).all(params.roomId) as Array<{ id: string; display_name: string; principal_type: string; enabled: number }>)
          : (deps.db.prepare('SELECT id, display_name, principal_type, enabled FROM project_members WHERE project_id = ? ORDER BY id').all(params.projectId) as Array<{ id: string; display_name: string; principal_type: string; enabled: number }>);
        return withCommandId({ ok: true, data: { items: rows.map((r) => ({ id: r.id, displayName: r.display_name, principalType: r.principal_type, enabled: r.enabled === 1 })) } });
      }
      case 'member.setEnabled': {
        // 协作参与设置（第十六轮六）：停用成员=不再参与之后派发（enabledAgents 过滤已在生产链路）；
        // 在途 turn 不受影响（派发时点读取）。协调者不可停用（AUTO 路由依赖，明确拒绝不静默换人）。
        const params = z.strictObject({ memberId: z.string().min(1), enabled: z.boolean() }).parse(env.params);
        // 校验在事务外（run 内抛领域错会被幂等网关包装成 STORAGE_UNAVAILABLE——丢失错误码）。
        const member = deps.db.prepare('SELECT pm.id, pm.enabled, r.coordinator_member_id FROM project_members pm LEFT JOIN rooms r ON r.coordinator_member_id = pm.id WHERE pm.id = ? LIMIT 1').get(params.memberId) as { id: string; enabled: number; coordinator_member_id: string | null } | undefined;
        if (member == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `成员不存在：${params.memberId}`);
        if (params.enabled === false && member.coordinator_member_id === member.id) {
          throw new DaemonCommandError('VALIDATION_INVALID', '协调者不可停用（房间 AUTO 路由依赖协调者——如需更换请先调整协调者）');
        }
        const result = run(() => {
          deps.db.prepare('UPDATE project_members SET enabled = ? WHERE id = ?').run(params.enabled ? 1 : 0, params.memberId);
          return { memberId: params.memberId, enabled: params.enabled, scope: '该成员之后的派发（在途 turn 不受影响）' };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'member.setRuntime': {
        // 成员级 runtime 绑定（DEV-10）：成员→profile→installation 链落库；派发侧按此选 adapter。
        // fake 仅显式开发模式（ZS_ALLOW_FAKE=1）；claude 必须显式模型（默认配置不被 CLI 接受）。
        // capabilities_json 分开记录工具能力三态/模型可用性/权限认证——不因配置成功宣称已认证。
        const params = z.strictObject({
          memberId: z.string().min(1),
          kind: z.enum(['codex', 'claude', 'fake']),
          model: z.string().min(1).optional(),
          executable: z.string().min(1).optional(),
          permissionMode: z.enum(['plan', 'manual', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']).optional(),
        }).parse(env.params);
        if (params.kind === 'fake' && process.env.ZS_ALLOW_FAKE !== '1') {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', 'fake runtime 仅限显式开发模式（ZS_ALLOW_FAKE=1）');
        }
        if (params.kind === 'claude' && (params.model == null || params.model.length === 0)) {
          throw new DaemonCommandError('VALIDATION_INVALID', 'claude 绑定必须显式指定模型（如 deepseek-flash）');
        }
        const result = run(() => {
          const member = deps.db.prepare('SELECT id FROM project_members WHERE id = ?').get(params.memberId) as { id: string } | undefined;
          if (member == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `成员不存在：${params.memberId}`);
          const executable = params.executable ?? (params.kind === 'claude' ? 'claude' : params.kind);
          const installationId = `ri_${params.kind}_${createHash('sha256').update(`${params.kind}|${executable}`).digest('hex').slice(0, 10)}`;
          const adapterVersion = params.kind === 'claude' ? CLAUDE_ADAPTER_VERSION : params.kind === 'codex' ? 'codex-appserver-adapter' : 'fake-adapter';
          // 能力登记（单一真源=adapter 能力表；分别记录：工具能力三态/模型可用性/权限认证——
          // 配置成功≠已认证，真实认证结论只适用于实测组合）。
          const toolCapabilities = params.kind === 'claude' ? claudeCapabilities() : { note: 'codex/fake 能力表随各自 adapter 认证轮登记' };
          const capabilities = {
            toolCapabilities,
            modelAvailability: params.model != null ? 'configured-unverified' : 'not-specified',
            permissionAuth: 'unverified',
          };
          deps.db.prepare(
            `INSERT INTO runtime_installations (id, kind, executable, version, adapter_version, capabilities_json, detected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET capabilities_json = excluded.capabilities_json, detected_at = excluded.detected_at`,
          ).run(installationId, params.kind, executable, '', adapterVersion, JSON.stringify(capabilities), Date.now());
          const profileId = `ap_${params.memberId}`;
          deps.db.prepare(
            `INSERT INTO agent_profiles (id, name, description, runtime_installation_id, settings_json) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET runtime_installation_id = excluded.runtime_installation_id, settings_json = excluded.settings_json`,
          ).run(profileId, `成员 ${params.memberId} 的 runtime profile`, null, installationId, JSON.stringify({ model: params.model ?? null, permissionMode: params.permissionMode ?? null }));
          deps.db.prepare('UPDATE project_members SET profile_id = ?, settings_revision = settings_revision + 1 WHERE id = ?').run(profileId, params.memberId);
          return { memberId: params.memberId, installationId, kind: params.kind, model: params.model ?? null, permissionMode: params.permissionMode ?? null };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'member.runtime': {
        const params = z.strictObject({ memberId: z.string().min(1) }).parse(env.params);
        const binding = readMemberRuntimeBinding(deps.db, params.memberId);
        if (binding == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `成员不存在：${params.memberId}`);
        const installation = binding.installationId == null ? null
          : (deps.db.prepare('SELECT id, kind, executable, capabilities_json FROM runtime_installations WHERE id = ?').get(binding.installationId) as { id: string; kind: string; executable: string; capabilities_json: string | null } | undefined) ?? null;
        return withCommandId({ ok: true, data: { binding, installation } });
      }
      case 'thread.history': {
        const params = z.strictObject({ threadId: z.string().min(1), beforeSeq: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(env.params);
        const limit = params.limit ?? 50;
        const rows = (params.beforeSeq != null
          ? deps.db.prepare('SELECT id, author_type, author_id, thread_message_seq, body_json, created_at FROM messages WHERE thread_id = ? AND thread_message_seq < ? ORDER BY thread_message_seq DESC LIMIT ?').all(params.threadId, params.beforeSeq, limit)
          : deps.db.prepare('SELECT id, author_type, author_id, thread_message_seq, body_json, created_at FROM messages WHERE thread_id = ? ORDER BY thread_message_seq DESC LIMIT ?').all(params.threadId, limit)) as Array<{ id: string; author_type: string; author_id: string; thread_message_seq: number; body_json: string; created_at: number }>;
        const items = rows.reverse().map((r) => ({ id: r.id, authorType: r.author_type, authorId: r.author_id, seq: r.thread_message_seq, body: JSON.parse(r.body_json) as { text: string }, createdAt: r.created_at }));
        // 消息附件（第二十七轮三：已发消息附件可点击预览——能力②闭环到页面）。
        attachMessageSummaries(deps.db, items);
        return withCommandId({ ok: true, data: { items } });
      }
      case 'task.get': {
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        const task = deps.db.prepare('SELECT id, title, status, room_id, conversation_thread_id, room_task_number, revision, stop_generation FROM tasks WHERE id = ?').get(params.taskId) as Record<string, unknown> | undefined;
        if (task == null) return withCommandId({ ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在', retryable: false } });
        const activeRun = deps.db.prepare('SELECT id, status FROM workflow_runs WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(params.taskId) as { id: string; status: string } | undefined;
        // 待验收交付（第九轮：验收操作绑定具体版本——UI 展示与提交同源）。
        const pendingDelivery = deps.db.prepare(`SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id = ? AND review_status = 'pending' LIMIT 1`).get(params.taskId) as { id: string; revision: number; manifest_hash: string } | undefined;
        // 最近一次启动失败原因（第十六轮四：验收防护拒绝等如实上屏——「待处理/失败」无解释=用户不可知）。
        const lastStartupFailure = (deps.db.prepare(
          `SELECT e.payload_json FROM domain_events e JOIN agent_turns t ON t.id = e.turn_id
           WHERE e.kind = 'turn.startupFailed' AND t.run_id IN (SELECT id FROM workflow_runs WHERE task_id = ?)
           ORDER BY e.seq DESC LIMIT 1`,
        ).get(params.taskId) as { payload_json: string } | undefined);
        let lastStartupFailureMessage: string | null = null;
        if (lastStartupFailure != null) {
          try { lastStartupFailureMessage = (JSON.parse(lastStartupFailure.payload_json) as { message?: string }).message?.slice(0, 200) ?? null; } catch { /* 残缺不虚构 */ }
        }
        return withCommandId({ ok: true, data: { task: { ...task, stopGeneration: task.stop_generation }, activeRun: activeRun ?? null, pendingDelivery: pendingDelivery ?? null, ...(lastStartupFailureMessage != null ? { lastStartupFailureMessage } : {}) } });
      }
      case 'message.submit': {
        const params = messageSubmitParams.parse(env.params);
        const result = run(() => {
          if (params.target.kind === 'thread') {
            const target = params.target;
            // 线程跟进（修复轮 6）：沿用绑定线程的当前任务（§4.2 串内跟进）——
            // 不新建根任务；目标在提交时固定。M0 仅支持人类跟进输入（按 steering 落库）。
            return deps.db.transaction(() => {
              const thread = deps.db.prepare('SELECT id, project_id, conversation_id, room_id, root_task_id, last_message_seq FROM conversation_threads WHERE id = ?').get(target.threadId) as
                | { id: string; project_id: string; conversation_id: string; room_id: string; root_task_id: string | null; last_message_seq: number }
                | undefined;
              if (thread == null || thread.project_id !== params.target.projectId || thread.conversation_id !== params.target.conversationId) {
                throw new DaemonCommandError('THREAD_SCOPE_MISMATCH', '线程目标与项目/会话不一致，拒绝提交（§4.5）');
              }
              if (thread.root_task_id == null) {
                // 记录串（E1）：讨论线程永不唤醒 agent——默认仍是保存记录。
                const resolvedAtts = resolveAttachmentRefs(deps.db, target.conversationId, params.attachmentRefs);
                const saved = insertThreadMessage(deps.db, {
                  projectId: params.target.projectId,
                  conversationId: params.target.conversationId,
                  roomId: thread.room_id,
                  threadId: thread.id,
                  threadMessageSeq: thread.last_message_seq + 1,
                  body: params.body,
                  mentions: params.mentions as MentionNode[],
                  authorId: deps.localUserId,
                  taskId: null,
                });
                attachMessageRefs(deps.db, saved.messageId, resolvedAtts);
                return saved;
              }
              // 任务串：M0 阶段人类跟进先落消息并标记待处理（task.steer 的完整调度
              // 由 DEV-08/09 扩展；此处持久化目标+内容，不新建根任务、不假装已派发）。
              const resolvedAtts = resolveAttachmentRefs(deps.db, target.conversationId, params.attachmentRefs);
              const message = insertThreadMessage(deps.db, {
                projectId: params.target.projectId,
                conversationId: params.target.conversationId,
                roomId: thread.room_id,
                threadId: thread.id,
                threadMessageSeq: thread.last_message_seq + 1,
                body: params.body,
                mentions: params.mentions as MentionNode[],
                authorId: deps.localUserId,
                taskId: thread.root_task_id,
              });
              attachMessageRefs(deps.db, message.messageId, resolvedAtts);
              return { ...message, disposition: 'none' as const, taskId: thread.root_task_id, followUpRecorded: true };
            })();
          }
          const target = params.target;
          if (target.kind === 'dm') {
            // 私信发送（DEV-22；R4 §2.3/§4.6）：mentions 必空（无 @ 派工）；record_only 只保存；
            // 附件=DEV-24 文本首包（第二十六轮五）：attachmentRefs=artifacts.id——归属/能力校验
            // 走四通道共用 resolveAttachmentRefs（第二十七轮二），消息-附件关联同事务。
            if (params.mentions.length > 0) throw new DaemonCommandError('VALIDATION_INVALID', '私信不做 @ 派工（§4.6 一对一）：mentions 必须为空');
            const resolvedAtts = resolveAttachmentRefs(deps.db, target.conversationId, params.attachmentRefs);
            const conv = dmConversationOf(deps.db, target.conversationId);
            if (conv == null || conv.kind !== 'dm' || conv.project_id !== target.projectId) {
              throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '目标不是该项目的私信会话');
            }
            if (conv.archived_at != null) {
              throw new DaemonCommandError('CONVERSATION_ARCHIVED', '对话已归档：禁止新发/续跑，保留历史（R4 §2.1）');
            }
            const peer = dmPeerOf(deps.db, target.conversationId);
            if (peer == null) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '私信会话缺少 Agent 对端（数据不完整）');
            return deps.db.transaction(() => {
              const r = createDmTurn(deps.db, {
                conversationId: target.conversationId,
                projectId: target.projectId,
                peerMemberId: peer.principal_id,
                localUserId: deps.localUserId,
                body: params.body,
                intent: params.intent,
                reviewPolicy: reviewPolicyOf(deps.db, target.projectId),
              });
              attachMessageRefs(deps.db, r.messageId, resolvedAtts);
              appendDomainEvent(deps.db, {
                schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: target.projectId,
                conversationId: target.conversationId, threadId: null, runId: null, taskId: r.taskId,
                turnId: null, kind: 'message.submitted', createdAt: Date.now(),
                payload: { target: 'dm', disposition: r.disposition, intent: params.intent, taskId: r.taskId, note: r.note ?? null },
              });
              return { messageId: r.messageId, conversationId: target.conversationId, threadId: null, taskId: r.taskId, disposition: r.disposition, note: r.note ?? null };
            })();
          }
          if (target.kind !== 'room_root') throw new DaemonCommandError('VALIDATION_INVALID', '路由目标缺失');
          // 附件（第二十七轮二：主池通道补齐——此前主池发送带 attachmentRefs 被后端静默忽略）：
          // 归属/能力校验共用；关联与 createRoomRootTask 同事务（根消息 id=ids.messageId，
          // record/dispatch 两类路由结果都挂——record_only 零派发只保存）。
          const resolvedAtts = resolveAttachmentRefs(deps.db, target.conversationId, params.attachmentRefs);
          const route = resolveTopLevelRoute({
            intent: params.intent,
            mentions: params.mentions as MentionNode[],
            room: {
              coordinatorMemberId: coordinatorOf(deps.db, target.roomId),
              enabledAgentMemberIds: enabledAgents(deps.db, target.roomId),
            },
          });
          if (!route.ok) throw new DaemonCommandError(route.error.code, route.error.message);
          return deps.db.transaction(() => {
            const ids = {
              messageId: `msg_${randomUUID()}`,
              threadId: `thread_${randomUUID()}`,
              taskId: `task_${randomUUID()}`,
              taskEventId: `evt_${randomUUID()}`,
              threadEventId: `evt_${randomUUID()}`,
            };
            const created = createRoomRootTask(deps.db, {
              ids,
              projectId: target.projectId,
              conversationId: target.conversationId,
              roomId: target.roomId,
              intent: params.intent,
              title: params.body.slice(0, 60),
              body: params.body,
              mentions: params.mentions as MentionNode[],
              author: { authorType: 'human', authorId: deps.localUserId },
              reviewPolicy: reviewPolicyOf(deps.db, params.target.projectId),
              sourceConnectionId: null,
              route: route.value as TopLevelRouteOutcome,
              now: Date.now(),
            });
            if (!created.ok) throw new DaemonCommandError(created.error.code, created.error.message);
            attachMessageRefs(deps.db, ids.messageId, resolvedAtts);
            return created.value;
          })();
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'thread.toolCalls': {
        // 线程内工具审计（2026-09-28 第五轮）：真源=worker 落库的 tool.started/tool.completed
        // 审计事件（非模型 executedVerifications 自述）。按线程→task 限定隔离；合并键=
        // turnId+toolCallId（带作用域——不同 turn/成员的同名 toolCallId 各自保留）；
        // started 取首、completed 取末（结果与完成时间取自同一条选定事件）；eventKey 重复
        // 不重复计数；身份不完整（缺 turnId 或 toolCallId）的事件保留为未归属条目，不按
        // 时间戳强行合并。字段范围：toolCallId/toolName/outcome/eventKey/成员与 turn 归属
        // ——工具参数正文不落库（worker 审计不含参数），因此查询面不含参数与凭据字段。
        const params = z.strictObject({ threadId: z.string().min(1) }).parse(env.params);
        const rows = deps.db.prepare(
          `SELECT de.kind, de.payload_json, de.created_at, de.turn_id
           FROM domain_events de
           WHERE de.kind IN ('tool.started','tool.completed')
             AND de.task_id IN (SELECT id FROM tasks WHERE conversation_thread_id = ?)
           ORDER BY de.seq`,
        ).all(params.threadId) as Array<{ kind: string; payload_json: string; created_at: number; turn_id: string | null }>;
        interface ToolCallItem {
          toolCallId: string; toolName: string | null; memberId: string | null; turnId: string | null;
          startedAt: number | null; completedAt: number | null; outcome: string | null;
          eventKeys: string[]; unattributed: boolean;
        }
        const byCall = new Map<string, ToolCallItem>();
        const pushEventKey = (item: ToolCallItem, eventKey: string | undefined): void => {
          if (eventKey != null && !item.eventKeys.includes(eventKey)) item.eventKeys.push(eventKey);
        };
        for (const r of rows) {
          const payload = JSON.parse(r.payload_json) as { toolCallId?: string; toolName?: string; outcome?: string; eventKey?: string };
          const hasIdentity = r.turn_id != null && payload.toolCallId != null;
          // 带作用域的合并键：turnId+toolCallId；身份不完整 → 每条事件独立未归属条目（seq 唯一）。
          const key = hasIdentity ? `${r.turn_id}:${payload.toolCallId}` : `unattributed:${r.created_at}:${r.kind}:${payload.eventKey ?? ''}`;
          let entry = byCall.get(key);
          if (entry == null) {
            entry = {
              toolCallId: payload.toolCallId ?? '(未归属)', toolName: null, memberId: null,
              turnId: r.turn_id, startedAt: null, completedAt: null, outcome: null,
              eventKeys: [], unattributed: !hasIdentity,
            };
            byCall.set(key, entry);
          }
          if (r.kind === 'tool.started' && entry.startedAt == null) {
            // started 取首：时间与工具名取自同一条选定事件。
            entry.startedAt = r.created_at;
            entry.toolName = payload.toolName ?? entry.toolName;
          }
          if (r.kind === 'tool.completed' && r.turn_id === entry.turnId) {
            // completed 取末：结果与完成时间取自同一条选定事件（不同 turn 的同名 id 不串）。
            entry.completedAt = r.created_at;
            entry.outcome = payload.outcome ?? null;
          }
          pushEventKey(entry, payload.eventKey);
        }
        // memberId：turn 归属成员（批量查询一次）。
        const items = [...byCall.values()];
        for (const item of items) {
          if (item.turnId != null) {
            const member = deps.db.prepare('SELECT member_id FROM agent_turns WHERE id = ?').get(item.turnId) as { member_id: string } | undefined;
            item.memberId = member?.member_id ?? null;
          }
        }
        return withCommandId({ ok: true, data: { items } });
      }
      case 'events.list': {
        const params = z.strictObject({ projectId: z.string().min(1), afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(env.params);
        const items = listEvents(deps.db, params.projectId, params.afterSeq ?? 0, params.limit ?? 100);
        return withCommandId({ ok: true, data: { items, hasMore: items.length >= (params.limit ?? 100) } });
      }
      case 'recovery.status': {
        // 只读恢复状态查询（修复轮 6）：禁止用「尝试恢复命令」探测门禁。
        // DEV-13 扩展：UNKNOWN turn 明细（对账入口）+ 上次 stop 记录 + 未收口撤销（DEV-12
        // 崩溃窗口续跑指引）+ 租约持有（daemon 死≠子进程死——身份核对如实，不假装可判活）。
        // 第七轮：附每个 UNKNOWN turn 的进程登记与最近退出取证（程序观测事实，供 UI 与人工判断分层展示）。
        const { isDispatchGateHeld } = await import('../persistence/daemonState.ts');
        const held = isDispatchGateHeld(deps.db);
        const pending = deps.db.prepare(`SELECT dispatch_key FROM outbox WHERE status = 'pending'`).all() as Array<{ dispatch_key: string }>;
        const interrupted = deps.db.prepare(`SELECT id, task_id, status FROM workflow_runs WHERE status IN ('INTERRUPTED')`).all() as Array<{ id: string; task_id: string; status: string }>;
        const unknownTurns = deps.db.prepare(
          `SELECT t.id, t.run_id AS runId, t.stage_key AS stageKey, r.task_id AS taskId, t.status FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id WHERE t.status = 'UNKNOWN'`,
        ).all();
        const processRegistry = unknownTurns.length > 0
          ? (deps.db.prepare(
            `SELECT r.turn_id AS turnId, r.process_model AS processModel, r.pid, r.started_at_ms AS startedAtMs,
                    r.identity_source AS identitySource, r.closed_at AS closedAt, r.adapter_kind AS adapterKind,
                    (SELECT p.result FROM recovery_exit_probes p WHERE p.turn_id = r.turn_id ORDER BY p.observed_at DESC LIMIT 1) AS lastProbeResult,
                    (SELECT p.detail FROM recovery_exit_probes p WHERE p.turn_id = r.turn_id ORDER BY p.observed_at DESC LIMIT 1) AS lastProbeDetail,
                    (SELECT p.observed_at FROM recovery_exit_probes p WHERE p.turn_id = r.turn_id ORDER BY p.observed_at DESC LIMIT 1) AS lastProbeAt
             FROM runtime_process_registry r`,
          ).all())
          : [];
        const stopRecordRow = deps.db.prepare(`SELECT value FROM daemon_state WHERE key = 'daemon:stop:last'`).get() as { value: string } | undefined;
        let stopRecord: unknown = null;
        if (stopRecordRow != null) { try { stopRecord = JSON.parse(stopRecordRow.value); } catch { stopRecord = null; } }
        const activeUndos = deps.db.prepare(`SELECT id, change_set_id AS changeSetId, status FROM change_set_undos WHERE status IN ('in_progress','failed')`).all();
        const heldLeases = deps.db.prepare(`SELECT lock_domain, owner_turn_id, status, heartbeat_at FROM workspace_leases WHERE status != 'released'`).all();
        // 「预算已处置、保护待解除」遗留保护（人工声明 notStarted 后可经 releaseProtection 收口）。
        const pendingRelease = deps.db.prepare(
          `SELECT l.owner_turn_id AS turnId, t.budget_mark AS budgetMark, t.status AS turnStatus,
                  count(*) AS leaseCount, max(r.result) AS lastProbeResult
           FROM workspace_leases l
           JOIN agent_turns t ON t.id = l.owner_turn_id
           LEFT JOIN recovery_exit_probes r ON r.turn_id = l.owner_turn_id
           WHERE l.status != 'released'
           GROUP BY l.owner_turn_id`,
        ).all();
        return withCommandId({
          ok: true,
          data: {
            gateHeld: held,
            pendingDispatchCount: pending.length,
            pendingDispatchKeys: pending.map((p) => p.dispatch_key),
            interruptedRuns: interrupted,
            unknownTurns,
            processRegistry,
            pendingRelease,
            stopRecord,
            activeUndos,
            heldLeases,
            leaseNote: 'daemon 退出不证明 runtime 子进程已退出（单实例锁≠进程树）；expired 租约仍阻塞新写者（RT-07）。退出事实以服务端取证（recovery.probeProcess：按已登记进程身份做 OS 核对）为准——不接受调用方自报；人工声明后的遗留保护经 recovery.releaseProtection 按服务端证据收口',
            undoNote: '未收口撤销：续跑走 changeset.undo（三向判定区分未执行/已执行未记账/外部修改），不清空占位后放行',
          },
        });
      }
      case 'recovery.probeProcess': {
        // DEV-13 第七轮：服务端退出取证（只读，不改 turn/租约/预算状态）。
        // 按 turn 的**已登记身份**（runtime_process_registry——worker 启动时写入）做 OS 核对，
        // 生成服务端证据记录（recovery_exit_probes）。错误 PID、其他 turn 证据、PID 复用、
        // 缺失历史身份都不能冒充确认退出——各按结果枚举如实返回。
        const params = z.strictObject({ turnId: z.string().min(1) }).parse(env.params);
        const turn = deps.db.prepare('SELECT id FROM agent_turns WHERE id = ?').get(params.turnId) as { id: string } | undefined;
        if (turn == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `turn 不存在：${params.turnId}`);
        const probe = probeTurnExit(deps.db, params.turnId, deps.processQuery ?? ((pid: number) => checkProcessLiveness(pid)), {
          createdBy: 'probe', treeScan: deps.processTree,
          managedJob: managedJobObservation,
        });
        return withCommandId({ ok: true, data: probe });
      }
      case 'recovery.reconcile': {
        // DEV-13（第七轮重写）：执行事实/退出事实/成果事实分离——**退出证据由服务端生成与校验**。
        // - 执行事实 verdict（人工判断，需留人工依据 note）：notStarted|executed|keepUnknown。
        //   **仅 UNKNOWN turn 可对账**（含 keepUnknown）。
        // - 退出事实：executed 时由 daemon 按已登记身份做 OS 核对（自动取证，或校验调用方
        //   引用的此前服务端 probeId——校验 turn 归属/登记一致/观测新鲜）。调用方**不再能
        //   自报 alive=false**（旧 exitEvidence 参数已删除）。alive/unknown/复用/身份缺失 →
        //   保留租约与准入占位；exited（per-turn 专属进程退出；shared=共享载体退出，证据按
        //   模型标注）→ 释放；no-os-process（无子进程模型=程序事实无 OS 遗留进程可能）→ 释放。
        // - notStarted 人工分离：启动窗口崩溃的 UNKNOWN turn 无程序确认来源（确认未启动在
        //   启动窗口内当场收口，不遗留 UNKNOWN）。人工声明须 manualRiskAck=true（独立语义）：
        //   预算退款+turn FAILED，但**租约与准入保留**（存在未收口进程可能时不凭人工解除
        //   物理写入保护），事件 recordedAs='manual-claim'——不伪装为程序已确认事实。
        // - 成果事实：确认执行不自动等于业务失败也不伪造成功交付——无已入库产物证据时
        //   turn 记 FAILED（reason=executed-no-recorded-outcome，留证可复核）。
        // - 预算逐 turn 标记（budget_mark）幂等防双算；DELIB 尾部 turn 退款同步恢复尾部预留。
        // - 同 daemon 内存联动：对账事务成功后调用 releaseAdmission 钩子（entry 接线）。
        const params = z.strictObject({
          turnId: z.string().min(1),
          verdict: z.enum(['notStarted', 'executed', 'keepUnknown']),
          /** 人工依据说明（所有 verdict 必填——人工判断留痕，不冒充程序事实）。 */
          note: z.string().min(1).max(500),
          /** notStarted 人工风险确认（UNKNOWN turn 无程序确认来源时必填）。 */
          manualRiskAck: z.boolean().optional(),
          /** 引用此前服务端 probe 证据（executed 可选；缺省自动取证）。 */
          probeId: z.string().min(1).optional(),
        }).parse(env.params);
        if (params.verdict === 'notStarted' && params.manualRiskAck !== true) {
          throw new DaemonCommandError('VALIDATION_INVALID', 'notStarted 对 UNKNOWN turn 无程序确认来源：人工声明须 manualRiskAck=true（独立语义——退款但保留租约保护，不伪装为程序已确认）');
        }
        const result = run(() => {
          const turn = deps.db.prepare('SELECT id, run_id, status, stage_key, budget_mark FROM agent_turns WHERE id = ?').get(params.turnId) as { id: string; run_id: string; status: string; stage_key: string; budget_mark: string | null } | undefined;
          if (turn == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `turn 不存在：${params.turnId}`);
          if (turn.status !== 'UNKNOWN') {
            throw new DaemonCommandError('STALE_REVISION', `仅 UNKNOWN turn 可对账（实际：${turn.status}）——keepUnknown 亦不适用于非 UNKNOWN turn`);
          }
          if (turn.budget_mark === 'refunded' && params.verdict !== 'keepUnknown') {
            throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', '该 turn 已按未启动退款：不得再按执行结算');
          }
          if (turn.budget_mark === 'settled' && params.verdict === 'notStarted') {
            throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', '该 turn 已按执行结算：不得再改为未启动退款（事实矛盾）');
          }
          // budget_mark='settled' 且再次 executed=**补交退出证据**（首次退出未知时预算已结算、
          // 保护保留）——跳过预算重算，仅推进退出事实；不构成双算。
          const run = deps.db.prepare('SELECT id, task_id, budget_json FROM workflow_runs WHERE id = ?').get(turn.run_id) as { id: string; task_id: string; budget_json: string | null } | undefined;
          const projectId = run != null ? (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(run.task_id) as { project_id: string } | undefined)?.project_id : undefined;
          const now = Date.now();
          const emit = (payload: Record<string, unknown>): void => {
            appendDomainEvent(deps.db, {
              schemaVersion: 1, eventId: `evt_${randomUUID()}`,
              projectId: projectId ?? 'unknown', taskId: run?.task_id, runId: turn.run_id, turnId: turn.id,
              kind: 'recovery.reconciled', createdAt: now,
              payload: { ...payload, manualNote: params.note },
            });
          };
          if (params.verdict === 'keepUnknown') {
            emit({ verdict: 'keepUnknown', note: '维持不确定：占位/租约/预算/状态全不动，不因时间流逝清空' });
            return { turnId: turn.id, verdict: 'keepUnknown' as const, stateChanged: false as const };
          }
          // 服务端退出取证（executed；notStarted 不需要——保护保留）：
          // probeId 引用则校验归属/登记一致/新鲜（≤10 分钟）；否则按登记身份自动取证。
          let probe: ProbeOutcome | null = null;
          if (params.verdict === 'executed') {
            probe = resolveServerProbe(deps, turn.id, params.probeId, now);
          }
          const releaseLeases = (): string[] => {
            const leases = deps.db.prepare(`SELECT lock_domain FROM workspace_leases WHERE owner_turn_id = ? AND status != 'released'`).all(turn.id) as Array<{ lock_domain: string }>;
            for (const l of leases) {
              deps.db.prepare(`UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`).run(l.lock_domain, turn.id);
            }
            return leases.map((l) => l.lock_domain);
          };
          const tx = deps.db.transaction(() => {
            let releasedLeases: string[] = [];
            let turnFinalStatus: string;
            let reason: string;
            let protectionRetained = false;
            if (params.verdict === 'notStarted') {
              // 人工声明未启动（独立语义）：退款（I-1；DELIB 尾部预留恢复）+ turn FAILED，
              // 但**租约与准入保留**——存在未收口进程可能时不凭人工解除物理写入保护。
              if (run?.budget_json != null) {
                const budget = JSON.parse(run.budget_json) as { usedTurns: number; inFlightReservedTurns: number; runMaxTurns?: number; tailReservationByStage?: Record<string, number> };
                const next = deliberationBudgetFns.refundReservedTurn(budget as never) as typeof budget;
                const tailStage = turn.stage_key?.startsWith('delib.synthesis') ? 'SYNTHESIS' : turn.stage_key?.startsWith('delib.ratify') ? 'RATIFY' : null;
                if (tailStage != null && next.tailReservationByStage != null) {
                  next.tailReservationByStage = { ...next.tailReservationByStage, [tailStage]: (next.tailReservationByStage[tailStage] ?? 0) + 1 };
                }
                deps.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(next), run.id);
              }
              deps.db.prepare(`UPDATE agent_turns SET status = 'FAILED', budget_mark = 'refunded' WHERE id = ?`).run(turn.id);
              turnFinalStatus = 'FAILED'; reason = 'manual-not-started-risk-ack'; protectionRetained = true;
              emit({ verdict: 'notStarted', recordedAs: 'manual-claim', protectionRetained, turnFinalStatus, reason, note: '人工声明（风险确认）：预算退款；租约/准入保留——程序未确认无遗留进程' });
            } else {
              // 执行事实=已执行：结算（U+1）——首次结算；补交退出证据的二次调用跳过（幂等）。
              if (run?.budget_json != null && turn.budget_mark == null) {
                const budget = JSON.parse(run.budget_json) as { usedTurns: number; inFlightReservedTurns: number };
                const next = deliberationBudgetFns.settleTurn(budget as never) as typeof budget;
                deps.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?').run(JSON.stringify(next), run.id);
              }
              if (turn.budget_mark == null) deps.db.prepare(`UPDATE agent_turns SET budget_mark = 'settled' WHERE id = ?`).run(turn.id);
              const p = probe!;
              if (p.result === 'no-os-process') {
                // 无子进程模型（程序事实）：无 OS 遗留进程可能——释放保护。
                releasedLeases = releaseLeases();
                deps.db.prepare(`UPDATE agent_turns SET status = 'FAILED' WHERE id = ?`).run(turn.id);
                turnFinalStatus = 'FAILED'; reason = 'executed-no-os-process';
                emit({ verdict: 'executed', exitFact: 'no-os-process', probe: { probeId: p.probeId, result: p.result, detail: p.detail }, releasedLeases, turnFinalStatus, reason });
              } else {
                // alive/未完整确认（第九轮收紧：**周期快照不构成完整退出证明**——per-turn/
                // shared 的 exited 自动释放路径已关闭，probe 不再产生 exited）：结算预算但
                // **保留租约与准入占位**、turn 保持 UNKNOWN——观察事实见 probe.detail；
                // budget_mark 已防重复结算；解除待受管生命周期机制（Job Object/ETW 等另批）。
                turnFinalStatus = 'UNKNOWN'; reason = `executed-exit-${p.result}-protection-retained`; protectionRetained = true;
                emit({ verdict: 'executed', exitFact: p.result, protectionRetained: true, probe: { probeId: p.probeId, result: p.result, processModel: p.processModel, pid: p.pid, observedAt: p.observedAt, detail: p.detail }, reason });
              }
            }
            return {
              turnId: turn.id, verdict: params.verdict, stateChanged: true as const,
              releasedLeases, turnFinalStatus, reason, protectionRetained,
              admissionReleased: releasedLeases.length >= 0 && turnFinalStatus === 'FAILED' && reason !== 'manual-not-started-risk-ack',
            };
          });
          const out = tx();
          // 内存联动（DB 事务成功后）：释放该 turn 在 worker 准入账本的 UNKNOWN 保留占位。
          // 人工 notStarted 不联动（保护保留语义与租约一致）。
          if (out.admissionReleased && deps.releaseAdmission != null) {
            try { deps.releaseAdmission(params.turnId); } catch { /* 进程内钩子失败不回滚持久事实；重启后账本自然为空 */ }
          }
          return out;
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'recovery.releaseProtection': {
        // DEV-13（第七轮·补）：解除「预算已处置、保护未解除」的遗留保护（人工声明 notStarted
        // 后租约保留——后续取得服务端退出证据时的正式收口入口）。
        // - 前置：该 turn 存在未释放租约；预算处置必须已完成（budget_mark 非空）或 turn 已
        //   终态——顺序错误（应先 reconcile）明确拒绝；无租约=幂等 no-op。
        // - 只按服务端取证解除（exited/no-os-process）：alive/unknown/身份缺失/复用→拒绝并
        //   保留保护；**不再退款、不再结算、不改写原人工声明**（budget_json/budget_mark 全不动）。
        // - 同 daemon 联动 releaseAdmission；全部依据 DB——重启后可继续收口。
        const params = z.strictObject({
          turnId: z.string().min(1),
          note: z.string().min(1).max(500),
          probeId: z.string().min(1).optional(),
        }).parse(env.params);
        const result = run(() => {
          const turn = deps.db.prepare('SELECT id, run_id, status, budget_mark FROM agent_turns WHERE id = ?').get(params.turnId) as { id: string; run_id: string; status: string; budget_mark: string | null } | undefined;
          if (turn == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `turn 不存在：${params.turnId}`);
          const leases = deps.db.prepare(`SELECT lock_domain FROM workspace_leases WHERE owner_turn_id = ? AND status != 'released'`).all(turn.id) as Array<{ lock_domain: string }>;
          if (leases.length === 0) {
            return { turnId: turn.id, stateChanged: false as const, releasedLeases: [] as string[], note: '该 turn 无未释放租约（保护已收口）——幂等 no-op' };
          }
          if (turn.budget_mark == null && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(turn.status)) {
            throw new DaemonCommandError('STALE_REVISION', `顺序错误：该 turn 仍 ${turn.status} 且预算未处置——先走 recovery.reconcile 对账，再解除保护`);
          }
          const now = Date.now();
          const probe = resolveServerProbe(deps, turn.id, params.probeId, now);
          const run = deps.db.prepare('SELECT id, task_id FROM workflow_runs WHERE id = ?').get(turn.run_id) as { id: string; task_id: string } | undefined;
          const projectId = (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(run?.task_id ?? '') as { project_id: string } | undefined)?.project_id ?? 'unknown';
          const emit = (payload: Record<string, unknown>): void => {
            appendDomainEvent(deps.db, {
              schemaVersion: 1, eventId: `evt_${randomUUID()}`,
              projectId, taskId: run?.task_id, runId: turn.run_id, turnId: turn.id,
              kind: 'recovery.protectionReleased', createdAt: now,
              payload: { ...payload, manualNote: params.note, probe: { probeId: probe.probeId, result: probe.result, processModel: probe.processModel, pid: probe.pid, observedAt: probe.observedAt, detail: probe.detail } },
            });
          };
          // REC-LIFE-1（第十四轮二）：受管执行的解除证据——按登记的 managed_job_id（稳定
          // 身份）查找并核对，PID 仅辅助属性：缺 jobId/无句柄（重启/已收尾）/PID 不一致/
          // 其他 job 的证据一律拒绝自动解除。顺序：证据查询 → DB 事务（租约+事件）→
          // markConsumed → 准入联动 → 收尾闸门（per-turn 且无共享者才 dispose——失败可重试，
          // 证据不提前丢）。
          const reg = getTurnProcessRegistration(deps.db, turn.id);
          if (reg?.identity_source === 'managed-job') {
            if (reg.managed_job_id == null) {
              throw new DaemonCommandError('STALE_REVISION', '该 turn 登记为受管执行但缺受管稳定身份（managed_job_id）——登记不完整，拒绝自动解除，人工核对');
            }
            const mp = managedJobById(reg.managed_job_id);
            if (mp == null) {
              throw new DaemonCommandError('STALE_REVISION', '该 turn 登记为受管执行，但本进程未持有其 job 句柄（daemon 重启或已收尾）——无法核对完整结束，进入人工核对；「曾纳管」不追认为完整退出证据');
            }
            if (reg.pid != null && mp.pid !== reg.pid) {
              throw new DaemonCommandError('STALE_REVISION', `登记 PID(${reg.pid}) 与 job 实际 PID(${mp.pid}) 不一致（PID 复用或登记错位）——该 job 的证据不属本 turn，拒绝解除`);
            }
            const evidence = mp.releaseEvidence();
            if (!evidence.releasable) {
              throw new DaemonCommandError('STALE_REVISION', `受管执行未完整结束（拒绝解除）：${evidence.reason}`);
            }
            const txm = deps.db.transaction(() => {
              for (const l of leases) {
                deps.db.prepare(`UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`).run(l.lock_domain, turn.id);
              }
              emit({ released: true, releasedLeases: leases.map((l) => l.lock_domain), reason: 'protection-released-managed-job-evidence', managedEvidence: evidence, managedJobId: reg.managed_job_id });
            });
            txm();
            mp.markConsumed(); // DB 事务成功后才消费（失败可重试——证据不提前丢）
            const retire = retireManagedJob(deps.db, turn.id); // 最后收尾：per-turn 且无共享者→dispose；shared/共享者→保留
            return { turnId: turn.id, stateChanged: true as const, releasedLeases: leases.map((l) => l.lock_domain), reason: 'protection-released-managed-job-evidence', managedRetire: retire };
          }
          if (probe.result !== 'no-os-process') {
            // 第九轮收紧：释放只凭**程序事实**（none 模型 no-os-process）。alive/未完整确认
            // 拒绝；**exited 观察同样不释放**（周期快照不构成完整退出证明——含升级前 ≤10min
            // 的历史 exited 取证记录，防御性拒绝并说明原因）。
            const detail = probe.result === 'exited'
              ? '该取证结果（exited）为升级前观察——周期快照机制不能证明全部受管执行已结束，自本轮起不再作为释放依据'
              : `${probe.result}：${probe.detail}`;
            emit({ released: false, reason: `release-denied-${probe.result}`, protectionRetained: true });
            throw new DaemonCommandError('STALE_REVISION', `服务端取证未确认执行已结束（${detail}）——保护保留，不得释放`);
          }
          const tx = deps.db.transaction(() => {
            for (const l of leases) {
              deps.db.prepare(`UPDATE workspace_leases SET status = 'released' WHERE lock_domain = ? AND owner_turn_id = ?`).run(l.lock_domain, turn.id);
            }
            // 预算处置与原人工声明不动（budget_json/budget_mark 均不写）。
            emit({ released: true, releasedLeases: leases.map((l) => l.lock_domain), reason: `protection-released-${probe.result}` });
          });
          tx();
          return { turnId: turn.id, stateChanged: true as const, releasedLeases: leases.map((l) => l.lock_domain), probeResult: probe.result };
        });
        const out = result.data as { stateChanged: boolean; releasedLeases: string[] };
        if (out.stateChanged && deps.releaseAdmission != null) {
          try { deps.releaseAdmission(params.turnId); } catch { /* 进程内钩子失败不回滚持久事实；重启后账本自然为空 */ }
        }
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'recovery.correctToExecuted': {
        // DEV-13（第七轮·补）：事实冲突纠正（人工声明未启动退款后，发现该 turn 实际执行过
        // ——渠道账单/迟到产物等人工证据）。账目纠正：budget_mark refunded→settled、
        // usedTurns 重记 U+1（退款已归还预留，不重复占用）；**原人工声明事件保留不改写**，
        // 纠正以 fact-conflict-correction 事件叠加记录。保护处置独立走 releaseProtection。
        const params = z.strictObject({
          turnId: z.string().min(1),
          note: z.string().min(1).max(500),
          evidence: z.strictObject({
            source: z.string().min(1).max(200), // 人工证据来源（渠道账单/迟到产物核对等）
            at: z.number().int().nonnegative(),
            ref: z.string().max(300).optional(),
          }),
        }).parse(env.params);
        const result = run(() => {
          const turn = deps.db.prepare('SELECT id, run_id, status, budget_mark FROM agent_turns WHERE id = ?').get(params.turnId) as { id: string; run_id: string; status: string; budget_mark: string | null } | undefined;
          if (turn == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `turn 不存在：${params.turnId}`);
          if (turn.budget_mark !== 'refunded') {
            throw new DaemonCommandError('STALE_REVISION', `事实纠正仅适用于已按未启动退款的 turn（实际 budget_mark=${turn.budget_mark ?? 'null'}）——无冲突可纠正`);
          }
          const now = Date.now();
          const run = deps.db.prepare('SELECT id, task_id, budget_json FROM workflow_runs WHERE id = ?').get(turn.run_id) as { id: string; task_id: string; budget_json: string | null } | undefined;
          const projectId = (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(run?.task_id ?? '') as { project_id: string } | undefined)?.project_id ?? 'unknown';
          const tx = deps.db.transaction(() => {
            if (run?.budget_json != null) {
              const budget = JSON.parse(run.budget_json) as { usedTurns: number; inFlightReservedTurns: number };
              // 纠正重记：执行实际发生——U+1（预留已退款归还，不再重新占用 I）。
              deps.db.prepare('UPDATE workflow_runs SET budget_json = ? WHERE id = ?')
                .run(JSON.stringify({ ...budget, usedTurns: budget.usedTurns + 1 } as typeof budget), run.id);
            }
            deps.db.prepare(`UPDATE agent_turns SET budget_mark = 'settled' WHERE id = ?`).run(turn.id);
            appendDomainEvent(deps.db, {
              schemaVersion: 1, eventId: `evt_${randomUUID()}`,
              projectId, taskId: run?.task_id, runId: turn.run_id, turnId: turn.id,
              kind: 'recovery.factConflictCorrected', createdAt: now,
              payload: {
                recordedAs: 'fact-conflict-correction', fromBudgetMark: 'refunded', toBudgetMark: 'settled',
                manualNote: params.note, evidence: params.evidence,
                note: '人工声明未启动退款后取得执行证据——账目按实际事实纠正；原 manual-claim 声明事件保留不改写',
              },
            });
          });
          tx();
          return { turnId: turn.id, corrected: true as const, budgetMark: 'settled' as const };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'recovery.pumpLateEvents': {
        // 第八轮：迟到成果正式接收入口——UNKNOWN turn 截止/重启后到达的终态事件，经
        // adapter 正式通道（lateEvents：持久化会话记录/重连存量流）拉取并走 applyEvent
        // 生产路径（身份/停止代次/重复终态/被替代 run/退款冲突守卫在 worker 侧统一承载）。
        // 幂等=late_event_receipts（eventKey 回执）+ turn 终态 CAS；unsupported 各态如实返回。
        const params = z.strictObject({ turnId: z.string().min(1) }).parse(env.params);
        if (deps.pumpLateEvents == null) {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', '该 daemon 未接线迟到事件泵（worker 不可达）——生产入口在 daemon entry');
        }
        const data = await deps.pumpLateEvents(params.turnId);
        return withCommandId({ ok: true, data });
      }
      case 'changeset.captureBaseline': {
        // DEV-12 正式命令：基线捕获（Git HEAD+索引状态+内容前像；变更归属 taskId/runId）。
        const params = z.strictObject({
          projectId: z.string().min(1),
          taskId: z.string().min(1).nullable().optional(),
          runId: z.string().min(1).nullable().optional(),
          paths: z.array(z.string().min(1)).optional(),
          maxBytes: z.number().int().positive().optional(),
        }).parse(env.params);
        if (deps.appDataDir == null) throw new DaemonCommandError('STORAGE_UNAVAILABLE', 'daemon 未配置 appDataDir（内容前像存储不可用）');
        const { captureBaseline } = await import('./changeset.ts');
        const r = captureBaseline(deps.db, {
          projectId: params.projectId, taskId: params.taskId ?? null, runId: params.runId ?? null,
          paths: params.paths, maxBytes: params.maxBytes, appDataDir: deps.appDataDir, now: Date.now(),
        });
        if (!r.ok) throw new DaemonCommandError(r.error.code, r.error.message);
        return withCommandId({ ok: true, data: r.value });
      }
      case 'changeset.finalize': {
        // 差异定型：捕获 after 前像+diff 入库（直接原目录模式 → application_status='applied'）。
        const params = z.strictObject({ changeSetId: z.string().min(1) }).parse(env.params);
        if (deps.appDataDir == null) throw new DaemonCommandError('STORAGE_UNAVAILABLE', 'daemon 未配置 appDataDir（内容前像存储不可用）');
        const { finalizeChangeset } = await import('./changeset.ts');
        const r = finalizeChangeset(deps.db, { changeSetId: params.changeSetId, appDataDir: deps.appDataDir, now: Date.now() });
        if (!r.ok) throw new DaemonCommandError(r.error.code, r.error.message);
        return withCommandId({ ok: true, data: r.value });
      }
      case 'changeset.undo': {
        // 非破坏撤销（§14.5）：执行前逐文件重验当前==after；冲突不覆盖；逐步持久化可恢复续跑。
        // 第十一轮：与产品内 Git 写操作互斥——撤销逐步恢复期间索引/工作区不得被 Git 写改。
        const params = z.strictObject({ changeSetId: z.string().min(1) }).parse(env.params);
        if (deps.appDataDir == null) throw new DaemonCommandError('STORAGE_UNAVAILABLE', 'daemon 未配置 appDataDir（内容前像存储不可用）');
        const csRow = deps.db.prepare('SELECT project_id FROM change_sets WHERE id = ?').get(params.changeSetId) as { project_id: string } | undefined;
        if (csRow == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `改动集不存在：${params.changeSetId}`);
        const csProject = deps.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(csRow.project_id) as { canonical_path: string } | undefined;
        if (csProject != null) {
          const { repoWriteBusy } = await import('./gitWrite.ts');
          if (repoWriteBusy(csProject.canonical_path)) {
            throw new DaemonCommandError('WORKSPACE_BUSY', '该项目的 Git 写操作正在进行——请等其完成后再撤销（两侧互斥，防止撤销期间索引被改写）');
          }
        }
        const { undoChangeset } = await import('./changeset.ts');
        const r = undoChangeset(deps.db, { changeSetId: params.changeSetId, appDataDir: deps.appDataDir, now: Date.now() });
        if (!r.ok) throw new DaemonCommandError(r.error.code, r.error.message);
        return withCommandId({ ok: true, data: r.value });
      }
      case 'changeset.get': {
        // 只读查询：before/after 前像、应用状态与撤销进度（恢复/对账依据）。
        const params = z.strictObject({ changeSetId: z.string().min(1) }).parse(env.params);
        const { getChangeSet } = await import('./changeset.ts');
        const r = getChangeSet(deps.db, params.changeSetId);
        if (!r.ok) throw new DaemonCommandError(r.error.code, r.error.message);
        return withCommandId({ ok: true, data: r.value });
      }
      case 'changeset.listByTask': {
        // DEV-14（第八轮增强）：任务串的变更记录清单——application_status+文件级 state
        // +撤销进度/冲突原因（不可撤销与恢复进度的用户可见来源）。只读；撤销走
        // changeset.undo 正式命令。
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        const sets = deps.db.prepare(
          `SELECT cs.id, cs.application_status AS applicationStatus, cs.before_ref, cs.after_ref,
                  (SELECT count(*) FROM change_set_files f WHERE f.change_set_id = cs.id AND f.role = 'after') AS fileCount,
                  (SELECT u.status FROM change_set_undos u WHERE u.change_set_id = cs.id ORDER BY u.id DESC LIMIT 1) AS undoStatus
           FROM change_sets cs WHERE cs.task_id = ? ORDER BY cs.rowid DESC`,
        ).all(params.taskId) as Array<{
          id: string; applicationStatus: string; before_ref: string; after_ref: string;
          fileCount: number; undoStatus: string | null;
        }>;
        const items = sets.map((cs) => {
          const undoRow = deps.db.prepare(
            `SELECT status, steps_json, failure_json, summary_json FROM change_set_undos WHERE change_set_id = ? ORDER BY id DESC LIMIT 1`,
          ).get(cs.id) as { status: string; steps_json: string; failure_json: string | null; summary_json: string | null } | undefined;
          let undoDetail: {
            status: string;
            totalSteps: number;
            doneSteps: number;
            /** 冲突/失败原因（不可继续撤销的具体说明——含冲突文件清单）。 */
            failure: string | null;
            /** 恢复进度说明：中断后可续跑（逐步幂等重验）。 */
            resumable: boolean;
          } | null = null;
          if (undoRow != null) {
            const steps = JSON.parse(undoRow.steps_json) as Array<{ state?: string }>;
            undoDetail = {
              status: undoRow.status,
              totalSteps: steps.length,
              doneSteps: steps.filter((st) => st.state === 'done').length,
              failure: undoRow.failure_json != null ? String(undoRow.failure_json).slice(0, 300) : null,
              resumable: undoRow.status === 'in_progress' || undoRow.status === 'failed',
            };
          }
          return {
            id: cs.id,
            applicationStatus: cs.applicationStatus,
            beforeRef: cs.before_ref,
            afterRef: cs.after_ref,
            fileCount: cs.fileCount,
            undoStatus: cs.undoStatus,
            undo: undoDetail,
            files: deps.db.prepare(
              `SELECT role, path, state FROM change_set_files WHERE change_set_id = ? ORDER BY role, path`,
            ).all(cs.id) as Array<{ role: string; path: string; state: string }>,
          };
        });
        return withCommandId({ ok: true, data: { taskId: params.taskId, items } });
      }
      case 'git.status': {
        // DEV-14/RT-24（第八轮）：仓库状态只读视图——真实 git 数据（暂存/未暂存/未跟踪
        // 严格区分），不改工作区（保留用户已有未提交内容）。Git 提交不等同任务验收
        // （RT-25）；写操作不在本命令。
        const params = z.strictObject({ projectId: z.string().min(1) }).parse(env.params);
        const project = deps.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(params.projectId) as { canonical_path: string } | undefined;
        if (project == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
        const { gitRepoStatus } = await import('./gitStatus.ts');
        const r = await gitRepoStatus(project.canonical_path);
        if (!r.ok) throw new DaemonCommandError(r.code === 'NOT_A_GIT_REPO' ? 'VALIDATION_INVALID' : 'STORAGE_UNAVAILABLE', r.message);
        return withCommandId({ ok: true, data: r });
      }
      case 'git.diff': {
        // DEV-14/RT-24（第九轮）：diff 正文只读视图——暂存/未暂存区分、重命名/删除标注、
        // 二进制与超限截断如实；路径校验（拒绝绝对路径/..越界）；不改索引与用户工作区。
        const params = z.strictObject({
          projectId: z.string().min(1),
          staged: z.boolean().optional(),
          path: z.string().min(1).max(400).optional(),
        }).parse(env.params);
        const project = deps.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(params.projectId) as { canonical_path: string } | undefined;
        if (project == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
        const { gitDiff } = await import('./gitStatus.ts');
        const r = await gitDiff(project.canonical_path, { staged: params.staged, path: params.path });
        if (!r.ok) {
          const code = r.code === 'NOT_A_GIT_REPO' || r.code === 'PATH_OUT_OF_REPO' || r.code === 'PATH_IS_DIRECTORY' ? 'VALIDATION_INVALID' : 'STORAGE_UNAVAILABLE';
          throw new DaemonCommandError(code, r.message);
        }
        return withCommandId({ ok: true, data: r });
      }
      case 'git.stage':
      case 'git.unstage':
      case 'git.stageTask':
      case 'git.commit':
      case 'git.commitPreview':
      case 'git.history':
      case 'git.remoteHead':
      case 'git.branch.list':
      case 'git.branch.create':
      case 'git.checkout':
      case 'git.commitDiff':
      case 'git.push':
      case 'git.pull':
      case 'git.conflict.content':
      case 'git.conflict.resolve':
      case 'git.commit.undo': {
        // 第十轮·二：Git 写操作闭环（RT-24/§14.6/§15.2）。自包幂等（git_operations 日志+
        // 命令回执同事务；commit 另有尾部标记崩溃恢复），不经 run() 同步包装。
        // 边界：不做 reset --hard/rebase/强推；批量暂存跳过 userPreExisting；提交不改
        // ChangeSet/验收状态；保护租约生效时拒绝写操作；身份缺失如实报错不代改配置。
        const gitProjectId = z.object({ projectId: z.string().min(1) }).parse(env.params).projectId;
        const gitProject = deps.db.prepare('SELECT canonical_path FROM projects WHERE id = ?').get(gitProjectId) as { canonical_path: string } | undefined;
        if (gitProject == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${gitProjectId}`);
        const journal = { commandId: env.commandId, scope, payloadHash, now: Date.now() };
        const { GitWriteError: GWE } = await import('./gitWrite.ts');
        const mapErr = (error: unknown): DaemonCommandError => {
          if (error instanceof DaemonCommandError) return error;
          if (error instanceof GWE) return new DaemonCommandError(error.code, error.message);
          return new DaemonCommandError('STORAGE_UNAVAILABLE', error instanceof Error ? error.message : String(error));
        };
        try {
          if (env.method === 'git.stage') {
            const params = z.strictObject({ projectId: z.string().min(1), paths: z.array(z.string().min(1).max(400)).min(1).max(100) }).parse(env.params);
            const { gitStage } = await import('./gitWrite.ts');
            const data = await gitStage(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.unstage') {
            const params = z.strictObject({ projectId: z.string().min(1), paths: z.array(z.string().min(1).max(400)).min(1).max(100) }).parse(env.params);
            const { gitUnstage } = await import('./gitWrite.ts');
            const data = await gitUnstage(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.stageTask') {
            const params = z.strictObject({
              projectId: z.string().min(1),
              taskId: z.string().min(1).optional(),
              changeSetId: z.string().min(1).optional(),
            }).refine((p) => (p.taskId != null) !== (p.changeSetId != null), { message: 'taskId 与 changeSetId 二选一' }).parse(env.params);
            const { gitStageTask } = await import('./gitWrite.ts');
            const data = await gitStageTask(deps.db, { projectId: params.projectId, projectRoot: gitProject.canonical_path, taskId: params.taskId, changeSetId: params.changeSetId, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.commitPreview') {
            const { gitCommitPreview } = await import('./gitWrite.ts');
            const data = await gitCommitPreview(deps.db, { projectId: (env.params as { projectId: string }).projectId, projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.commit') {
            const params = z.strictObject({
              projectId: z.string().min(1),
              message: z.string().min(1).max(2000),
              expectedHead: z.string().min(4).max(64).nullable(),
              expectedIndexTree: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
              expectedBranch: z.string().min(1).max(200).nullable(),
              taskId: z.string().min(1).optional(),
              changeSetIds: z.array(z.string().min(1)).max(50).optional(),
            }).parse(env.params);
            const { gitCommit } = await import('./gitWrite.ts');
            const data = await gitCommit(deps.db, {
              projectId: params.projectId, projectRoot: gitProject.canonical_path, message: params.message,
              expectedHead: params.expectedHead, expectedIndexTree: params.expectedIndexTree, expectedBranch: params.expectedBranch,
              taskId: params.taskId ?? null, changeSetIds: params.changeSetIds,
              journal,
            });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.remoteHead') {
            const params = z.strictObject({ projectId: z.string().min(1), remote: z.string().min(1).max(200), branch: z.string().min(1).max(200) }).parse(env.params);
            const { remoteHead, pushUrl, redactRemoteText } = await import('./gitWrite.ts');
            const { locateRepo } = await import('./gitStatus.ts');
            const loc = await locateRepo(gitProject.canonical_path);
            const [head, url] = await Promise.all([remoteHead(loc, params.remote, params.branch), pushUrl(loc, params.remote)]);
            return withCommandId({ ok: true, data: { remote: params.remote, branch: params.branch, head, url: redactRemoteText(url) } });
          }
          if (env.method === 'git.branch.list') {
            const { gitBranchList } = await import('./gitWrite.ts');
            const data = await gitBranchList({ projectId: gitProjectId, projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.branch.create') {
            const params = z.strictObject({ projectId: z.string().min(1), name: z.string().min(1).max(200), expectedHead: z.string().min(4).max(64).nullable() }).parse(env.params);
            const { gitBranchCreate } = await import('./gitWrite.ts');
            const data = await gitBranchCreate(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.checkout') {
            const params = z.strictObject({ projectId: z.string().min(1), branch: z.string().min(1).max(200), expectedHead: z.string().min(4).max(64).nullable(), expectedBranch: z.string().min(1).max(200) }).parse(env.params);
            const { gitCheckout } = await import('./gitWrite.ts');
            const data = await gitCheckout(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.commitDiff') {
            // parentOid（第十四轮五）：merge 提交选择比较父——数据与展示绑定该父 OID；
            // 非 merge 提交传非其父的值由 daemon 校验拒绝。
            const params = z.strictObject({ projectId: z.string().min(1), oid: z.string().regex(/^[0-9a-f]{40}$/), parentOid: z.string().regex(/^[0-9a-f]{40}$/).optional() }).parse(env.params);
            const { gitCommitDiff } = await import('./gitWrite.ts');
            const data = await gitCommitDiff(deps.db, { ...params, projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.push') {
            // 推送绑定用户确认的远端/分支/两端头（§14.6 风险告知；仅快进，不强推）。
            const params = z.strictObject({ projectId: z.string().min(1), remote: z.string().min(1).max(200), branch: z.string().min(1).max(200), expectedHead: z.string().regex(/^[0-9a-f]{40}$/), expectedRemoteHead: z.string().regex(/^[0-9a-f]{40}$/).nullable(), expectedRemoteUrl: z.string().min(1).max(2000) }).parse(env.params);
            const { gitPush } = await import('./gitWrite.ts');
            const data = await gitPush(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.pull') {
            const params = z.strictObject({ projectId: z.string().min(1), remote: z.string().min(1).max(200), branch: z.string().min(1).max(200), expectedHead: z.string().regex(/^[0-9a-f]{40}$/) }).parse(env.params);
            const { gitPull } = await import('./gitWrite.ts');
            const data = await gitPull(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.conflict.content') {
            const params = z.strictObject({ projectId: z.string().min(1), path: z.string().min(1).max(400) }).parse(env.params);
            const { gitConflictContent } = await import('./gitWrite.ts');
            const data = await gitConflictContent({ ...params, projectRoot: gitProject.canonical_path });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.conflict.resolve') {
            // 三方内容+手动解决（§14.6：不提供整文件一键用某边覆盖——只接受用户提交的内容）。
            const params = z.strictObject({ projectId: z.string().min(1), path: z.string().min(1).max(400), content: z.string().max(4 * 1024 * 1024) }).parse(env.params);
            const { gitConflictResolve } = await import('./gitWrite.ts');
            const data = await gitConflictResolve(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          if (env.method === 'git.commit.undo') {
            // reflog 软回退（§14.6）：内容回工作区、文件不删；只允许撤销当前 HEAD 提交。
            const params = z.strictObject({ projectId: z.string().min(1), commitOid: z.string().regex(/^[0-9a-f]{40}$/), expectedHead: z.string().regex(/^[0-9a-f]{40}$/), expectedBranch: z.string().min(1).max(200) }).parse(env.params);
            const { gitCommitUndo } = await import('./gitWrite.ts');
            const data = await gitCommitUndo(deps.db, { ...params, projectRoot: gitProject.canonical_path, journal });
            return withCommandId({ ok: true, data });
          }
          const historyParams = z.strictObject({ projectId: z.string().min(1), limit: z.number().int().min(1).max(200).optional(), cursor: z.number().int().min(0).optional() }).parse(env.params);
          const { gitHistory } = await import('./gitWrite.ts');
          const data = await gitHistory(deps.db, { ...historyParams, projectRoot: gitProject.canonical_path });
          return withCommandId({ ok: true, data });
        } catch (error) {
          throw mapErr(error);
        }
      }
      case 'project.reviewPolicy.set': {
        // RT-25/§10.5/§15.2：项目级「任务验收」开关。CAS（expectedRevision）；只影响之后
        // 创建的用户任务（创建时快照 Task.reviewPolicy）——已有任务策略不批量改写；
        // 关闭不授权自动提交/推送，也不放宽 runtime 权限（RT-25①）。
        const params = z.strictObject({
          projectId: z.string().min(1),
          taskReviewEnabled: z.boolean(),
          expectedRevision: z.number().int().nonnegative(),
        }).parse(env.params);
        const result = run(() => {
          const row = deps.db.prepare('SELECT id, revision, task_review_enabled FROM projects WHERE id = ?').get(params.projectId) as { id: string; revision: number; task_review_enabled: number } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          if (row.revision !== params.expectedRevision) {
            throw new DaemonCommandError('STALE_REVISION', `项目 revision 已变化（期望 ${params.expectedRevision}，当前 ${row.revision}）——请刷新后重试`);
          }
          if ((row.task_review_enabled === 1) === params.taskReviewEnabled) {
            return { projectId: params.projectId, taskReviewEnabled: params.taskReviewEnabled, revision: row.revision, unchanged: true };
          }
          const updated = deps.db
            .prepare('UPDATE projects SET task_review_enabled = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
            .run(params.taskReviewEnabled ? 1 : 0, params.projectId, params.expectedRevision);
          if (updated.changes !== 1) throw new DaemonCommandError('STALE_REVISION', '并发更新冲突（revision 条件更新未命中）——请刷新后重试');
          appendDomainEvent(deps.db, {
            schemaVersion: 1,
            eventId: `evt_${randomUUID()}`,
            projectId: params.projectId,
            kind: 'project.reviewPolicyUpdated',
            createdAt: Date.now(),
            payload: { taskReviewEnabled: params.taskReviewEnabled, effect: '仅影响之后创建的用户任务；已有任务保持创建时策略快照' },
          });
          return { projectId: params.projectId, taskReviewEnabled: params.taskReviewEnabled, revision: params.expectedRevision + 1, unchanged: false };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'project.collab.get':
      case 'project.collab.set': {
        // §17.8 协作限制（第十七轮三）：缺席等待（absenceTolerance）与单轮运行时限
        //（turnDeadline）项目级配置。NULL=回落 daemon 全局默认；生效边界=新派发 turn 起
        // 读取（在途不变）；CAS 沿用 projects.revision。并行写入策略（§14.7）延期——不在
        // 本命令面（文件修改节=只读呈现，不伪造可配置）。
        if (env.method === 'project.collab.get') {
          const params = z.strictObject({ projectId: z.string().min(1) }).parse(env.params);
          const row = deps.db.prepare('SELECT revision, collab_absence_tolerance_ms, collab_turn_deadline_ms FROM projects WHERE id = ?').get(params.projectId) as { revision: number; collab_absence_tolerance_ms: number | null; collab_turn_deadline_ms: number | null } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          return withCommandId({ ok: true, data: { projectId: params.projectId, revision: row.revision, absenceToleranceMs: row.collab_absence_tolerance_ms, turnDeadlineMs: row.collab_turn_deadline_ms, scope: '新派发 turn 起生效（在途 turn 保持派发时的时限）；NULL=回落 daemon 全局默认' } });
        }
        const params = z.strictObject({
          projectId: z.string().min(1),
          absenceToleranceMs: z.number().int().min(10_000).max(86_400_000).nullable().optional(),
          turnDeadlineMs: z.number().int().min(10_000).max(86_400_000).nullable().optional(),
          expectedRevision: z.number().int().nonnegative(),
        }).parse(env.params);
        const result = run(() => {
          const row = deps.db.prepare('SELECT id, revision FROM projects WHERE id = ?').get(params.projectId) as { id: string; revision: number } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `项目不存在：${params.projectId}`);
          if (row.revision !== params.expectedRevision) {
            throw new DaemonCommandError('STALE_REVISION', `配置版本冲突（期望 revision=${params.expectedRevision}，当前=${row.revision}）——请刷新后重试`);
          }
          const sets: string[] = [];
          const vals: unknown[] = [];
          if (params.absenceToleranceMs !== undefined) { sets.push('collab_absence_tolerance_ms = ?'); vals.push(params.absenceToleranceMs); }
          if (params.turnDeadlineMs !== undefined) { sets.push('collab_turn_deadline_ms = ?'); vals.push(params.turnDeadlineMs); }
          if (sets.length === 0) return { projectId: row.id, revision: row.revision, changed: false as const };
          deps.db.prepare(`UPDATE projects SET ${sets.join(', ')}, revision = revision + 1 WHERE id = ? AND revision = ?`).run(...vals, row.id, params.expectedRevision);
          const after = deps.db.prepare('SELECT revision, collab_absence_tolerance_ms, collab_turn_deadline_ms FROM projects WHERE id = ?').get(row.id) as { revision: number; collab_absence_tolerance_ms: number | null; collab_turn_deadline_ms: number | null };
          appendDomainEvent(deps.db, {
            schemaVersion: 1, eventId: `evt_${randomUUID()}`, projectId: row.id, conversationId: null, threadId: null, taskId: null, runId: null, turnId: null,
            kind: 'project.collabUpdated', createdAt: Date.now(),
            payload: { fromRevision: params.expectedRevision, toRevision: after.revision, absenceToleranceMs: after.collab_absence_tolerance_ms, turnDeadlineMs: after.collab_turn_deadline_ms, note: '协作限制更新：新派发 turn 起生效（在途不变）' },
          });
          return { projectId: row.id, revision: after.revision, changed: true as const, absenceToleranceMs: after.collab_absence_tolerance_ms, turnDeadlineMs: after.collab_turn_deadline_ms };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'conversation.create': {
        // 私信会话创建（DEV-22；R4 §2.3；第十九轮三：新建/打开分离）——每个新的业务请求
        // 创建独立 conversationId（同成员可多条独立私信）；同 commandId 重试经幂等网关返回
        // 原创建结果；打开已有会话用 conversation.list/history + 明确 conversationId。
        const params = z.strictObject({
          projectId: z.string().min(1),
          peerMemberId: z.string().min(1),
          title: z.string().min(1).max(120).optional(),
        }).parse(env.params);
        const project = deps.db.prepare('SELECT id FROM projects WHERE id = ?').get(params.projectId) as { id: string } | undefined;
        if (project == null) throw new DaemonCommandError('PROJECT_MISSING', '项目不存在');
        const result = run(() => {
          const created = createDmConversation(deps.db, { projectId: params.projectId, peerMemberId: params.peerMemberId, title: params.title, localUserId: deps.localUserId });
          if (!created.ok) throw new DaemonCommandError(created.code, created.message);
          return { conversationId: created.conversationId };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'conversation.list': {
        const params = z.strictObject({ projectId: z.string().min(1).optional(), archived: z.boolean().optional() }).parse(env.params);
        const all = listDmConversations(deps.db, deps.localUserId, params.projectId);
        const rows = params.archived == null ? all : all.filter((c) => params.archived === (c.archivedAt != null));
        return withCommandId({ ok: true, data: { conversations: rows } });
      }
      case 'conversation.history': {
        const params = z.strictObject({ conversationId: z.string().min(1), beforeSeq: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (dmLocalUserOf(deps.db, params.conversationId) !== deps.localUserId) {
          throw new DaemonCommandError('FORBIDDEN', '仅该私信 audience 可读取（R4 §2.3）');
        }
        const limit = params.limit ?? 50;
        const rows = (params.beforeSeq != null
          ? deps.db.prepare('SELECT id, conversation_seq, author_type, author_id, body_json, status, created_at FROM messages WHERE conversation_id = ? AND conversation_seq < ? ORDER BY conversation_seq DESC LIMIT ?').all(params.conversationId, params.beforeSeq, limit)
          : deps.db.prepare('SELECT id, conversation_seq, author_type, author_id, body_json, status, created_at FROM messages WHERE conversation_id = ? ORDER BY conversation_seq DESC LIMIT ?').all(params.conversationId, limit)) as Array<Record<string, unknown>>;
        const messages = rows.reverse();
        // 消息附件（第二十七轮三：已发消息附件可点击预览；raw 行补 attachments 键）。
        const attByMsg = messageAttachmentSummaries(deps.db, messages.map((m) => String(m.id)));
        for (const m of messages) {
          (m as { attachments?: unknown }).attachments = attByMsg.get(String(m.id)) ?? [];
        }
        return withCommandId({ ok: true, data: { messages, nextCursor: rows.length === limit ? rows[0]!.conversation_seq : null } });
      }
      case 'conversation.markRead': {
        // DEV-18 首包：通用阅读水位（房间/线程/DM）——幂等（同水位重复=advanced:false；
        // commandGateway 另有 commandId 级回执幂等）；**未来水位拒绝**（throughMessageSeq >
        // conversations.last_message_seq = 不吞未来消息——读到的才是已读）；DM=双成员校验
        // （不得替另一参与者标读），房间/线程=本地用户（projects 行存在即可达）。
        const params = z.strictObject({ conversationId: z.string().min(1), throughMessageSeq: z.number().int().min(0) }).parse(env.params);
        const conv = deps.db.prepare('SELECT id, project_id, kind, last_message_seq FROM conversations WHERE id = ?').get(params.conversationId) as { id: string; project_id: string; kind: string; last_message_seq: number } | undefined;
        if (conv == null) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在');
        if (params.throughMessageSeq > conv.last_message_seq) {
          throw new DaemonCommandError('VALIDATION_INVALID', `未来水位拒绝：throughMessageSeq=${params.throughMessageSeq} 超过会话最新消息序 ${conv.last_message_seq}（未读到的不算已读）`);
        }
        if (conv.kind === 'dm') {
          if (dmLocalUserOf(deps.db, params.conversationId) !== deps.localUserId) throw new DaemonCommandError('FORBIDDEN', '不得替另一参与者标记已读');
        } else if (deps.db.prepare('SELECT id FROM projects WHERE id = ?').get(conv.project_id) == null) {
          throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话所属项目不可达');
        }
        const result = deps.db.transaction((): { advanced: boolean } => {
          // UPSERT（DEV-18：房间/线程会话无预插 read_state 行——首标即插入；幂等=同水位不前进）。
          deps.db.prepare('INSERT OR IGNORE INTO conversation_read_states (project_id, conversation_id, viewer_id, last_read_seq) VALUES (?, ?, ?, 0)').run(conv.project_id, params.conversationId, deps.localUserId);
          const changes = deps.db.prepare(
            'UPDATE conversation_read_states SET last_read_seq = MAX(last_read_seq, ?), revision = revision + 1 WHERE conversation_id = ? AND viewer_id = ? AND last_read_seq < ?',
          ).run(params.throughMessageSeq, params.conversationId, deps.localUserId, params.throughMessageSeq).changes;
          return { advanced: changes > 0 };
        });
        // 经 commandGateway（DEV-18：commandId 级回执幂等——重试/重放同结果，与语义幂等双层）。
        const r = run(result);
        return withCommandId({ ok: true, data: r.data });
      }
      case 'thread.markRead': {
        // DEV-18（第二十三轮一）：线程独立阅读水位——thread_message_seq 域（会话序与线程序
        // 分开：打开房间≠读完所有线程、读线程 A 不影响 B）。幂等（同序 advanced:false+
        // commandGateway commandId 回执）；未来序号拒绝（>last_message_seq 不吞未来）；
        // 归属：线程→会话→项目（DM 线程=双成员校验；房间线程=项目可达）。
        const params = z.strictObject({ threadId: z.string().min(1), throughMessageSeq: z.number().int().min(0) }).parse(env.params);
        const thread = deps.db.prepare(
          'SELECT t.id AS thread_id, t.conversation_id, c.kind, c.project_id, t.last_message_seq FROM conversation_threads t JOIN conversations c ON c.id = t.conversation_id WHERE t.id = ?',
        ).get(params.threadId) as { thread_id: string; conversation_id: string; kind: string; project_id: string; last_message_seq: number } | undefined;
        if (thread == null) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', `线程不存在：${params.threadId}`);
        if (params.throughMessageSeq > thread.last_message_seq) {
          throw new DaemonCommandError('VALIDATION_INVALID', `未来水位拒绝：throughMessageSeq=${params.throughMessageSeq} 超过线程最新消息序 ${thread.last_message_seq}`);
        }
        if (thread.kind === 'dm') {
          if (dmLocalUserOf(deps.db, thread.conversation_id) !== deps.localUserId) throw new DaemonCommandError('FORBIDDEN', '不得替另一参与者标记已读');
        } else if (deps.db.prepare('SELECT id FROM projects WHERE id = ?').get(thread.project_id) == null) {
          throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '线程所属项目不可达');
        }
        const tx = deps.db.transaction((): { advanced: boolean } => {
          // 表=001 预埋（列 last_read_message_seq/updated_at，无 project_id）——UPSERT 首标+单调。
          deps.db.prepare('INSERT OR IGNORE INTO thread_read_states (thread_id, viewer_id, last_read_message_seq, updated_at) VALUES (?, ?, 0, ?)').run(params.threadId, deps.localUserId, Date.now());
          const changes = deps.db.prepare(
            'UPDATE thread_read_states SET last_read_message_seq = MAX(last_read_message_seq, ?), updated_at = ? WHERE thread_id = ? AND viewer_id = ? AND last_read_message_seq < ?',
          ).run(params.throughMessageSeq, Date.now(), params.threadId, deps.localUserId, params.throughMessageSeq).changes;
          return { advanced: changes > 0 };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data });
      }
      case 'reminder.schedule': {
        // DEV-23（第二十四轮三——REM-5/6）：一次/循环计划。audience/owner 范围/DM 对端统一
        // 校验；reminderId **事务内**生成、返回 r.data——同 commandId 重放返回原 ID 与计划
        // （网关 run() 同事务存回执；同号异参被 payloadHash 拒绝）。autoDispatch=显式授权位
        // （sourceRef 字符串不构成授权事实——授权只能来自本地入口的显式选择并落库冻结）。
        const params = z.strictObject({
          projectId: z.string().min(1),
          conversationId: z.string().min(1),
          threadId: z.string().min(1).optional(),
          taskId: z.string().min(1).optional(),
          ownerMemberId: z.string().min(1),
          title: z.string().min(1).max(200),
          sourceRef: z.string().max(200).optional(),
          schedule: z.union([
            z.strictObject({ kind: z.literal('once'), at: z.number().int().positive() }),
            z.strictObject({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().min(1).optional() }),
            z.strictObject({ kind: z.literal('weekly'), weekday: z.number().int().min(0).max(6), time: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().min(1).optional() }),
          ]),
          budgetLimit: z.strictObject({ sum: z.number().int().min(0) }).optional(),
          autoDispatch: z.boolean().optional(),
          maxTriggers: z.number().int().min(1).optional(),
        }).parse(env.params);
        const schedule = params.schedule as ReminderSchedule;
        const scheduleCheck = validateSchedule(schedule);
        if (!scheduleCheck.ok) throw new DaemonCommandError('VALIDATION_INVALID', `提醒计划无效：${scheduleCheck.error}`);
        const convInfo = assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        if (convInfo.projectId !== params.projectId) throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不属于该项目');
        const nextAt = computeNextAt(schedule, Date.now());
        if (nextAt == null) throw new DaemonCommandError('VALIDATION_INVALID', '计划无法产生未来触发时刻（once.at 已过或循环无解）——请提供未来时刻');
        // owner 范围（REM-5，网关外只读校验——保住正式错误码，run() 内领域错会被包装
        // STORAGE_UNAVAILABLE）：项目成员+启用；DM 会话只能唤醒该对话的 agent 对端。
        const member = deps.db.prepare('SELECT id, enabled, project_id FROM project_members WHERE id = ?').get(params.ownerMemberId) as
          | { id: string; enabled: number; project_id: string } | undefined;
        if (member == null || member.project_id !== params.projectId) throw new DaemonCommandError('SCOPE_MISMATCH', 'owner 必须是该项目的成员');
        if (member.enabled !== 1) throw new DaemonCommandError('VALIDATION_INVALID', 'owner 成员已停用——不能作为唤醒对象');
        if (convInfo.kind === 'dm') {
          const peer = deps.db.prepare("SELECT 1 AS ok FROM dm_participants WHERE conversation_id = ? AND principal_type = 'agent' AND principal_id = ?").get(params.conversationId, params.ownerMemberId);
          if (peer == null) throw new DaemonCommandError('SCOPE_MISMATCH', '私信提醒只能唤醒该对话的 agent 对端');
        }
        if (params.taskId != null) {
          const task = deps.db.prepare('SELECT conversation_id FROM tasks WHERE id = ?').get(params.taskId) as { conversation_id: string } | undefined;
          if (task?.conversation_id !== params.conversationId) throw new DaemonCommandError('SCOPE_MISMATCH', '任务不属于目标会话');
        }
        if (params.threadId != null) {
          const thread = deps.db.prepare('SELECT conversation_id, root_task_id FROM conversation_threads WHERE id = ?').get(params.threadId) as { conversation_id: string; root_task_id: string | null } | undefined;
          if (thread?.conversation_id !== params.conversationId) throw new DaemonCommandError('SCOPE_MISMATCH', '线程不属于目标会话');
          if (thread.root_task_id == null) throw new DaemonCommandError('SCOPE_MISMATCH', '讨论串（无任务）不能作为提醒执行目标——请挂任务串或房间/私信会话');
        }
        const tx = deps.db.transaction((): { reminderId: string; nextAt: number } => {
          const reminderId = `rem_${randomUUID()}`;
          const now = Date.now();
          // 任务停止代次绑定快照（第二十五轮三）：绑定后发生**新**停止才判停——历史停止不永久禁止。
          const boundStopGeneration = params.taskId != null
            ? (deps.db.prepare('SELECT stop_generation FROM tasks WHERE id = ?').get(params.taskId) as { stop_generation: number } | undefined)?.stop_generation ?? 0
            : 0;
          deps.db.prepare(`INSERT INTO reminders (id, conversation_id, thread_id, task_id, owner_member_id, owner_user, title, source_ref, timezone, schedule_json, next_at, status, budget_json, auto_dispatch, max_triggers, bound_stop_generation, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
            .run(reminderId, params.conversationId, params.threadId ?? null, params.taskId ?? null, params.ownerMemberId, deps.localUserId, params.title, params.sourceRef ?? null,
              schedule.tz ?? 'UTC', JSON.stringify(schedule), nextAt,
              params.budgetLimit != null ? JSON.stringify(params.budgetLimit) : null, params.autoDispatch === true ? 1 : 0, params.maxTriggers ?? null, boundStopGeneration, now, now);
          return { reminderId, nextAt };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.snooze': {
        const params = z.strictObject({ reminderId: z.string().min(1), until: z.number().int().positive() }).parse(env.params);
        // 授权校验（每次——含重放）在网关外；状态类前置在事务内重读核对（第二十五轮二：
        // 并发取消/触发不被旧快照放行；重放先命中回执——状态校验不阻塞同号重试）。
        const rowPre = deps.db.prepare('SELECT id, conversation_id FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; conversation_id: string } | undefined;
        if (rowPre == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
        assertConversationAudience(deps.db, deps.localUserId, rowPre.conversation_id);
        const tx = deps.db.transaction((): { snoozed: boolean } => {
          const row = deps.db.prepare('SELECT id, status, next_at FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; status: string; next_at: number } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
          if (row.status !== 'active') throw new DaemonCommandError('VALIDATION_INVALID', `仅 active 提醒可贪睡（当前 ${row.status}）`);
          if (params.until <= row.next_at) throw new DaemonCommandError('VALIDATION_INVALID', '贪睡时刻必须晚于当前下次触发时刻');
          const changed = deps.db.prepare(`UPDATE reminders SET next_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND next_at = ? AND status = 'active'`).run(params.until, Date.now(), row.id, row.next_at).changes;
          return { snoozed: changed === 1 };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.update': {
        const params = z.strictObject({
          reminderId: z.string().min(1), expectedRevision: z.number().int().min(0),
          title: z.string().min(1).max(200).optional(),
          schedule: z.union([
            z.strictObject({ kind: z.literal('once'), at: z.number().int().positive() }),
            z.strictObject({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().min(1).optional() }),
            z.strictObject({ kind: z.literal('weekly'), weekday: z.number().int().min(0).max(6), time: z.string().regex(/^\d{2}:\d{2}$/), tz: z.string().min(1).optional() }),
          ]).optional(),
          autoDispatch: z.boolean().optional(),
        }).parse(env.params);
        // 授权校验（网关外，每次）；revision/状态在事务内重读核对（并发安全+重放不阻塞）。
        const rowPre = deps.db.prepare('SELECT id, conversation_id FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; conversation_id: string } | undefined;
        if (rowPre == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
        assertConversationAudience(deps.db, deps.localUserId, rowPre.conversation_id);
        const tx = deps.db.transaction((): { revision: number } => {
          const row = deps.db.prepare('SELECT id, revision, schedule_json, status FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; revision: number; schedule_json: string; status: string } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
          if (row.revision !== params.expectedRevision) throw new DaemonCommandError('REVISION_CONFLICT', `期望 revision=${params.expectedRevision}，当前=${row.revision}`);
          if (row.status === 'cancelled') throw new DaemonCommandError('VALIDATION_INVALID', '已取消的提醒不能更新复活——请重新创建（取消后不复活）');
          const schedule = params.schedule != null ? (params.schedule as ReminderSchedule) : JSON.parse(row.schedule_json) as ReminderSchedule;
          const scheduleCheck = validateSchedule(schedule);
          if (!scheduleCheck.ok) throw new DaemonCommandError('VALIDATION_INVALID', `新计划无效：${scheduleCheck.error}`);
          const nextAt = computeNextAt(schedule, Date.now());
          if (nextAt == null) throw new DaemonCommandError('VALIDATION_INVALID', '新计划无法产生未来触发时刻');
          // timezone 列与 schedule_json 保持一致（第二十四轮二修复：旧实现改计划不同步列）。
          // paused→active=显式继续（authority 类暂停在下次触发重查时如实再判定；恢复不自动补跑）。
          deps.db.prepare(`UPDATE reminders SET title = COALESCE(?, title), schedule_json = ?, timezone = ?, next_at = ?, auto_dispatch = COALESCE(?, auto_dispatch),
                           status = 'active', paused_reason = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`)
            .run(params.title ?? null, JSON.stringify(schedule), schedule.tz ?? 'UTC', nextAt, params.autoDispatch == null ? null : (params.autoDispatch ? 1 : 0), Date.now(), row.id);
          return { revision: row.revision + 1 };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.cancel': {
        const params = z.strictObject({ reminderId: z.string().min(1) }).parse(env.params);
        const rowPre = deps.db.prepare('SELECT id, conversation_id FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; conversation_id: string } | undefined;
        if (rowPre == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
        assertConversationAudience(deps.db, deps.localUserId, rowPre.conversation_id);
        const tx = deps.db.transaction((): { cancelled: boolean; settledAwaiting: number } => {
          const row = deps.db.prepare('SELECT id, status FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; status: string } | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
          // once 到点后（done）仍有待确认触发→必须可取消（第二十五轮二：取消=结算待确认事项；
          // 已开始执行的任务不在此处冒充停止——按正式停止入口处理）。
          if (row.status === 'done') {
            const settled = deps.db.prepare("UPDATE reminder_occurrences SET outcome = 'cancelled_by_user', fired_at = COALESCE(fired_at, ?) WHERE reminder_id = ? AND outcome = 'awaiting_confirmation' AND status = 'fired'")
              .run(Date.now(), params.reminderId).changes;
            if (settled > 0) {
              deps.db.prepare("UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'done'").run(Date.now(), params.reminderId);
              return { cancelled: true, settledAwaiting: settled };
            }
            return { cancelled: false, settledAwaiting: 0 }; // done 且无可结算事项——如实无变化
          }
          const changed = deps.db.prepare(`UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('active','paused')`).run(Date.now(), params.reminderId).changes;
          if (changed === 1) {
            // 同步结算待确认触发（active/paused 取消路径同样适用——待我处理不再出现）。
            const settled = deps.db.prepare("UPDATE reminder_occurrences SET outcome = 'cancelled_by_user' WHERE reminder_id = ? AND outcome = 'awaiting_confirmation' AND status = 'fired'")
              .run(params.reminderId).changes;
            return { cancelled: true, settledAwaiting: settled };
          }
          return { cancelled: false, settledAwaiting: 0 };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.confirm': {
        // REM-8 正式确认入口：awaiting_confirmation 的 occurrence 经用户确认→正式执行派发
        // （任务+outbox+调用预占，author=system——不伪装人类）。状态/授权/预算**事务内重读
        // 核对**（并发取消/额度争用在提交前拦截——两条待确认争最后一格恰一条获准）；
        // 重放先命中回执（网关）——首次成功后的状态变化不阻塞同号重试。
        const params = z.strictObject({ reminderId: z.string().min(1), scheduledAt: z.number().int().positive() }).parse(env.params);
        const rowPre = deps.db.prepare('SELECT id, conversation_id FROM reminders WHERE id = ?').get(params.reminderId) as { id: string; conversation_id: string } | undefined;
        if (rowPre == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
        assertConversationAudience(deps.db, deps.localUserId, rowPre.conversation_id); // 授权每次重检（含重放）
        const tx = deps.db.transaction((): { taskId: string; confirmedAt: number } => {
          const row = deps.db.prepare('SELECT * FROM reminders WHERE id = ?').get(params.reminderId) as
            | { id: string; conversation_id: string; thread_id: string | null; task_id: string | null; owner_member_id: string; owner_user: string | null; title: string | null; source_ref: string | null; timezone: string; schedule_json: string; budget_json: string | null; auto_dispatch: number; bound_stop_generation: number; status: string }
            | undefined;
          if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `提醒不存在：${params.reminderId}`);
          if (row.status === 'cancelled') throw new DaemonCommandError('VALIDATION_INVALID', '提醒已取消——不能确认执行（待确认事项已结算）');
          const occ = deps.db.prepare('SELECT status, outcome, missed_count FROM reminder_occurrences WHERE reminder_id = ? AND scheduled_at = ?').get(params.reminderId, params.scheduledAt) as
            | { status: string; outcome: string; missed_count: number } | undefined;
          if (occ == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `触发记录不存在：${params.reminderId}@${params.scheduledAt}`);
          if (occ.status !== 'fired' || occ.outcome !== 'awaiting_confirmation') {
            throw new DaemonCommandError('VALIDATION_INVALID', `当前状态 ${occ.status}/${occ.outcome} 不可确认（仅待确认触发可确认）`);
          }
          const authority = recheckReminderAuthority(deps.db, row);
          if (!authority.ok) throw new DaemonCommandError('FORBIDDEN', `授权重查未通过：${authority.reason}`);
          const budget = checkReminderBudget(deps.db, row);
          if (!budget.ok) throw new DaemonCommandError('BUDGET_EXCEEDED', budget.reason === 'budget_corrupt' ? '预算记录损坏——拒绝派发（fail-closed）' : '预算已用尽——拒绝派发');
          const dispatch = dispatchReminderExecution(deps.db, {
            reminder: row,
            scheduledAt: params.scheduledAt,
            missedCount: occ.missed_count ?? 0,
            dispatchedCount: reminderCallUsage(deps.db, row.id),
            now: Date.now(),
          });
          const changed = deps.db.prepare(`UPDATE reminder_occurrences SET outcome = 'dispatched', task_id = ?, confirmed_at = ? WHERE reminder_id = ? AND scheduled_at = ? AND outcome = 'awaiting_confirmation'`)
            .run(dispatch.taskId, Date.now(), params.reminderId, params.scheduledAt).changes;
          if (changed !== 1) throw new DaemonCommandError('REVISION_CONFLICT', '确认竞态：触发状态已变化');
          return { taskId: dispatch.taskId, confirmedAt: Date.now() };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'reminder.list': {
        // REM-5：audience 过滤——他人 DM 的提醒（标题/计划/occurrence）不因列表泄露。
        const params = z.strictObject({ projectId: z.string().min(1).optional() }).parse(env.params);
        const audienceFilter = ' AND (c.kind != \'dm\' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = \'human\' AND dp.principal_id = ?))';
        const rows = (params.projectId != null
          ? deps.db.prepare(`SELECT r.*, c.project_id AS project_id_ FROM reminders r JOIN conversations c ON c.id = r.conversation_id WHERE c.project_id = ?${audienceFilter} ORDER BY r.rowid DESC`).all(params.projectId, deps.localUserId)
          : deps.db.prepare(`SELECT r.*, c.project_id AS project_id_ FROM reminders r JOIN conversations c ON c.id = r.conversation_id WHERE 1=1${audienceFilter} ORDER BY r.rowid DESC`).all(deps.localUserId)) as Array<Record<string, unknown>>;
        const items = rows.map((row) => ({
          reminderId: row.id, projectId: row.project_id_, conversationId: row.conversation_id, threadId: row.thread_id, taskId: row.task_id,
          ownerMemberId: row.owner_member_id, title: row.title, sourceRef: row.source_ref,
          schedule: JSON.parse(row.schedule_json as string) as ReminderSchedule,
          timezone: row.timezone,
          nextAt: row.next_at, status: row.status, pausedReason: row.paused_reason,
          budgetLimit: row.budget_json != null ? JSON.parse(row.budget_json as string) : null,
          revision: row.revision,
          autoDispatch: row.auto_dispatch === 1,
          lastFiredAt: row.last_fired_at,
          occurrences: (deps.db.prepare(`SELECT scheduled_at, status, outcome, missed_count, fired_at, task_id, confirmed_at FROM reminder_occurrences WHERE reminder_id = ? ORDER BY scheduled_at DESC LIMIT 200`).all(row.id) as Array<{ scheduled_at: number; status: string; outcome: string | null; missed_count: number; fired_at: number | null; task_id: string | null; confirmed_at: number | null }>),
        }));
        return withCommandId({ ok: true, data: { items } });
      }
      case 'thread.subscribe': {
        // DEV-18 关注/静音（第二十五轮四）：**人的阅读订阅**（thread_subscriptions——与
        // thread_agent_followers=Agent 执行跟进名单分列）。纯偏好写：不建运行/不停止任务/
        // 不改冻结参与者；未读/通知聚合按 muted 排除、followed 进待我处理（另处消费）。
        const params = z.strictObject({ threadId: z.string().min(1), follow: z.boolean().optional(), mute: z.boolean().optional() }).parse(env.params);
        const thread = deps.db.prepare('SELECT conversation_id, project_id FROM conversation_threads WHERE id = ?').get(params.threadId) as { conversation_id: string; project_id: string } | undefined;
        if (thread == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `线程不存在：${params.threadId}`);
        assertConversationAudience(deps.db, deps.localUserId, thread.conversation_id);
        const tx = deps.db.transaction((): { followed: boolean; muted: boolean } => {
          const cur = deps.db.prepare('SELECT followed, muted FROM thread_subscriptions WHERE thread_id = ? AND viewer_id = ?').get(params.threadId, deps.localUserId) as { followed: number; muted: number } | undefined;
          const followed = params.follow ?? cur?.followed === 1;
          const muted = params.mute ?? cur?.muted === 1;
          deps.db.prepare(`INSERT INTO thread_subscriptions (thread_id, viewer_id, followed, muted) VALUES (?, ?, ?, ?)
                           ON CONFLICT(thread_id, viewer_id) DO UPDATE SET followed = excluded.followed, muted = excluded.muted`)
            .run(params.threadId, deps.localUserId, followed ? 1 : 0, muted ? 1 : 0);
          return { followed, muted };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'thread.subscriptions': {
        const params = z.strictObject({ projectId: z.string().min(1).optional() }).parse(env.params);
        const rows = (params.projectId != null
          ? deps.db.prepare(`SELECT s.thread_id, s.followed, s.muted, c.project_id, t.root_task_id FROM thread_subscriptions s JOIN conversation_threads t ON t.id = s.thread_id JOIN conversations c ON c.id = t.conversation_id WHERE c.project_id = ? AND s.viewer_id = ?`)
          : deps.db.prepare(`SELECT s.thread_id, s.followed, s.muted, c.project_id, t.root_task_id FROM thread_subscriptions s JOIN conversation_threads t ON t.id = s.thread_id JOIN conversations c ON c.id = t.conversation_id WHERE s.viewer_id = ?`))
          .all(...(params.projectId != null ? [params.projectId, deps.localUserId] : [deps.localUserId])) as Array<{ thread_id: string; followed: number; muted: number; project_id: string; root_task_id: string | null }>;
        return withCommandId({ ok: true, data: { items: rows.map((r) => ({ threadId: r.thread_id, followed: r.followed === 1, muted: r.muted === 1, projectId: r.project_id, taskId: r.root_task_id })) } });
      }
      case 'search.query': {
        // DEV-18 搜索（第二十五轮四）：消息/线程锚文本/任务标题（附件**只随所在消息**检索
        // ——附件名命中即该消息命中；正文提取未实施不冒充）。范围：project=当前项目 /
        // all=全部可访问项目（同 mine.pending 口径——正式链无隐藏位）。audience：他人 DM
        // 的消息/线程/任务与摘要一律不返回。确定性排序（created_at/seq+id）+分页。
        const params = z.strictObject({
          text: z.string().min(1).max(200),
          scope: z.enum(['project', 'all']).default('project'),
          projectId: z.string().min(1).optional(),
          conversationId: z.string().min(1).optional(),
          authorDisplayName: z.string().min(1).max(100).optional(),
          fromDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          toDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          kind: z.enum(['all', 'message', 'thread', 'task']).default('all'),
          page: z.number().int().min(1).default(1),
          pageSize: z.number().int().min(1).max(50).default(20),
        }).parse(env.params);
        if (params.scope === 'project' && params.projectId == null) throw new DaemonCommandError('VALIDATION_INVALID', 'scope=project 需要 projectId');
        // 日期按**用户本地时区**解释（第二十六轮三：界面日期选择器即本地日——无 Z 后缀解析为
        // 本地午夜；toDay 含当日。UTC 日边界不冒充用户「当日」——北京时间凌晨边界用例锁定）。
        const localDayMs = (day: string, endExclusive = false): number => {
          const t = new Date(`${day}T00:00:00`).getTime(); // 本地午夜（无 Z）
          if (!Number.isFinite(t)) throw new DaemonCommandError('VALIDATION_INVALID', `日期无法解析：${day}`);
          return endExclusive ? t + 86_400_000 : t;
        };
        const escapeLike = (raw: string): string => raw.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const pattern = `%${escapeLike(params.text)}%`;
        const fromMs = params.fromDay != null ? localDayMs(params.fromDay) : null;
        const toMs = params.toDay != null ? localDayMs(params.toDay, true) : null;
        // 作者过滤：显示名→成员 id 集（跨项目同名都收——文本匹配如实）。
        const authorIds = params.authorDisplayName != null
          ? (deps.db.prepare('SELECT id FROM project_members WHERE display_name = ?').all(params.authorDisplayName) as Array<{ id: string }>).map((r) => r.id)
          : null;
        const audienceFilter = ` AND (c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))`;
        const convFilter = params.conversationId != null ? ' AND m.conversation_id = ?' : '';
        const authorFilter = authorIds != null ? ` AND m.author_id IN (${authorIds.map(() => '?').join(',') || "''"})` : '';
        const dateFilter = (fromMs != null ? ' AND m.created_at >= ?' : '') + (toMs != null ? ' AND m.created_at < ?' : '');
        const bind = (m: boolean): unknown[] => {
          const out: unknown[] = m ? [deps.localUserId] : [];
          if (params.scope === 'project') out.push(params.projectId!);
          if (params.conversationId != null) out.push(params.conversationId);
          if (authorIds != null) out.push(...authorIds);
          if (fromMs != null) out.push(fromMs);
          if (toMs != null) out.push(toMs);
          return out;
        };
        const pageSize = params.pageSize;
        const offset = (params.page - 1) * pageSize;
        const snippetOf = (text: string): string => {
          const idx = text.indexOf(params.text);
          if (idx < 0) return text.slice(0, 48);
          return text.slice(Math.max(0, idx - 16), Math.min(text.length, idx + params.text.length + 24));
        };
        let messages: Array<Record<string, unknown>> = [];
        let threads: Array<Record<string, unknown>> = [];
        let tasks: Array<Record<string, unknown>> = [];
        // 过滤一致性（第二十六轮三）：作者/会话/日期过滤对**全部类型统一生效**（线程=锚消息
        // 作者/会话/创建时刻；任务=根消息作者/会话/创建时刻——任务标题命中但锚消息不符筛选
        // 时不混入 kind=all）。各类型 JOIN 根消息 m 统一承载过滤列。
        const scopeOnJoin = params.scope === 'project' ? ' AND m.project_id = ?' : '';
        if (params.kind === 'all' || params.kind === 'message') {
          messages = (deps.db.prepare(
            `SELECT m.id, m.project_id, p.display_name AS project_name, m.conversation_id, m.thread_id, m.conversation_seq, m.created_at, m.author_type, m.author_id, json_extract(m.body_json, '$.text') AS text
             FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN projects p ON p.id = m.project_id
             WHERE (json_extract(m.body_json, '$.text') LIKE ? COLLATE NOCASE ESCAPE '\\'
                    OR EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id AND a.display_name LIKE ? COLLATE NOCASE ESCAPE '\\'))${audienceFilter}${scopeOnJoin}${convFilter}${authorFilter}${dateFilter}
             ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
          ).all(pattern, pattern, ...bind(true), pageSize, offset) as Array<{ id: string; project_id: string; project_name: string; conversation_id: string; thread_id: string | null; conversation_seq: number; created_at: number; author_type: string; author_id: string; text: string | null }>)
            .map((r) => ({ kind: 'message', messageId: r.id, projectId: r.project_id, projectName: r.project_name, conversationId: r.conversation_id, threadId: r.thread_id, seq: r.conversation_seq, createdAt: r.created_at, authorType: r.author_type, authorId: r.author_id, snippet: snippetOf(String(r.text ?? '')), locate: `#msg=${r.id}` }));
        }
        if (params.kind === 'all' || params.kind === 'thread') {
          threads = (deps.db.prepare(
            `SELECT t.id, t.project_id, p.display_name AS project_name, t.conversation_id, t.root_task_id, t.anchor_message_id, m.created_at, m.author_id, json_extract(m.body_json, '$.text') AS text
             FROM conversation_threads t
             JOIN messages m ON m.id = t.anchor_message_id
             JOIN conversations c ON c.id = t.conversation_id JOIN projects p ON p.id = t.project_id
             WHERE json_extract(m.body_json, '$.text') LIKE ? COLLATE NOCASE ESCAPE '\\'${audienceFilter}${scopeOnJoin}${convFilter}${authorFilter}${dateFilter}
             ORDER BY m.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
          ).all(pattern, ...bind(true), pageSize, offset) as Array<{ id: string; project_id: string; project_name: string; conversation_id: string; root_task_id: string | null; anchor_message_id: string; created_at: number; author_id: string; text: string | null }>)
            .map((r) => ({ kind: 'thread', threadId: r.id, projectId: r.project_id, projectName: r.project_name, conversationId: r.conversation_id, taskId: r.root_task_id, createdAt: r.created_at, snippet: snippetOf(String(r.text ?? '')), locate: r.root_task_id != null ? `#task=${r.root_task_id}` : `#msg=${r.anchor_message_id}` }));
        }
        if (params.kind === 'all' || params.kind === 'task') {
          // 任务过滤统一（第二十六轮三）：范围/会话按任务自身列；作者/日期按**根消息**
          // （LEFT JOIN——无根消息的任务仅在不设作者/日期过滤时可见；设过滤时无法匹配=如实排除）。
          tasks = (deps.db.prepare(
            `SELECT t.id, t.project_id, p.display_name AS project_name, t.conversation_id, t.title, t.status, m.created_at, m.author_id
             FROM tasks t
             LEFT JOIN messages m ON m.id = t.root_message_id
             JOIN conversations c ON c.id = t.conversation_id JOIN projects p ON p.id = t.project_id
             WHERE t.title LIKE ? COLLATE NOCASE ESCAPE '\\'${audienceFilter}${params.scope === 'project' ? ' AND t.project_id = ?' : ''}${params.conversationId != null ? ' AND t.conversation_id = ?' : ''}${authorFilter}${dateFilter}
             ORDER BY t.rowid DESC LIMIT ? OFFSET ?`,
          ).all(pattern, deps.localUserId, ...(params.scope === 'project' ? [params.projectId!] : []), ...(params.conversationId != null ? [params.conversationId] : []), ...(authorIds ?? []), ...(fromMs != null ? [fromMs] : []), ...(toMs != null ? [toMs] : []), pageSize, offset) as Array<{ id: string; project_id: string; project_name: string; conversation_id: string; title: string; status: string; created_at: number | null; author_id: string | null }>)
            .map((r) => ({ kind: 'task', taskId: r.id, projectId: r.project_id, projectName: r.project_name, conversationId: r.conversation_id, title: r.title, status: r.status, createdAt: r.created_at, authorId: r.author_id, locate: `#task=${r.id}` }));
        }
        return withCommandId({ ok: true, data: { page: params.page, pageSize, scope: params.scope, messages, threads, tasks, attachmentNote: '附件按所在消息的文件名检索；正文提取未实施（不冒充支持）；日期按本机时区解释' } });
      }
      case 'attachment.uploadText': {
        // DEV-24 文本/Markdown 首包（第二十六轮五；第二十七轮六扩代码类）——能力①保存副本：
        // 内容寻址落应用数据区（{appData}/blobstore/{hash}.txt——不在用户项目目录生成副本）；
        // artifacts 持久 hash/版本（revision）/来源文件名/conversation audience；同文件不同内容
        // =不同资源。**kind 按扩展名推导**（kindForFilename：源代码扩展名=code_file，其余=
        // text_file——同一读取/截断/完整性/注入链路）。规则：utf-8（BOM 容忍）；含 NUL 控制字节
        // =二进制拒绝；>256KB 拒绝；>64KB 保存全文但预览/注入截断（truncated+originalBytes 如实
        // 注明）。
        const params = z.strictObject({
          conversationId: z.string().min(1),
          filename: z.string().min(1).max(200),
          content: z.string().min(1).max(600_000),
        }).parse(env.params);
        const convInfo = assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        if (/[\u0000-\u0008\u000E-\u001F]/.test(params.content)) throw new DaemonCommandError('VALIDATION_INVALID', '内容含二进制控制字节——不是文本附件（七类二进制随后续批次）');
        const bytes = Buffer.byteLength(params.content, 'utf8');
        if (bytes > ATT_MAX_BYTES) throw new DaemonCommandError('VALIDATION_INVALID', `文件大小 ${bytes}B 超过文本附件上限 ${ATT_MAX_BYTES}B（明确规则：不静默截断保存）`);
        const convArchived = (deps.db.prepare('SELECT archived_at FROM conversations WHERE id = ?').get(params.conversationId) as { archived_at: number | null }).archived_at;
        if (convArchived != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '会话已归档：禁止新上传（历史附件仍可预览）');
        const hash = createHash('sha256').update(params.content, 'utf8').digest('hex');
        const blobRoot = join(deps.appDataDir ?? process.env.ZS_APP_DATA ?? process.cwd(), 'blobstore');
        mkdirSync(blobRoot, { recursive: true });
        writeFileSync(join(blobRoot, `${hash}.txt`), params.content, 'utf8'); // 副本（内容寻址——同内容不重复）
        const tx = deps.db.transaction((): { attachmentId: string; hash: string; bytes: number; truncated: boolean; originalBytes: number } => {
          const attachmentId = `art_${randomUUID()}`;
          deps.db.prepare(`INSERT INTO artifacts (id, project_id, conversation_id, author_id, kind, revision, hash, blob_path, source_name, created_at)
                           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(attachmentId, convInfo.projectId, params.conversationId, deps.localUserId, kindForFilename(params.filename), hash, join(blobRoot, `${hash}.txt`), params.filename, Date.now());
          return { attachmentId, hash, bytes, truncated: bytes > ATT_EXCERPT_BYTES, originalBytes: bytes };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.previewText': {
        // 能力②预览+③提取正文：读**获准副本**（blob_path——原文件变化不改变已保存版本）；
        // audience：归属会话（或本地用户可达）——跨会话/他人 DM 拒绝。读取经共享完整性路径
        //（第二十七轮四：路径限定托管存储+sha256 实际字节核对——损坏明确拒绝）；UTF-8 **字节**
        // 截断（保留完整字符），原始大小/提取大小/截断事实分别注明。
        const params = z.strictObject({ attachmentId: z.string().min(1), conversationId: z.string().min(1).optional() }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash, blob_path, source_name, kind FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string; blob_path: string; source_name: string; kind: string } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        const convId = params.conversationId ?? row.conversation_id;
        assertConversationAudience(deps.db, deps.localUserId, convId);
        if (convId !== row.conversation_id) throw new DaemonCommandError('FORBIDDEN', '附件不属于该会话（audience 校验拒绝）');
        if (!(ATT_TEXT_KINDS as readonly string[]).includes(row.kind)) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）非文本/代码附件范围`);
        const verified = readVerifiedCopy(row.blob_path, row.hash);
        if (!verified.ok) throw new DaemonCommandError('STORAGE_UNAVAILABLE', verified.error.message);
        return withCommandId({ ok: true, data: { attachmentId: row.id, filename: row.source_name, kind: row.kind, hash: verified.copy.hash, text: verified.copy.text, truncated: verified.copy.truncated, originalBytes: verified.copy.originalBytes, excerptBytes: verified.copy.excerptBytes } });
      }
      case 'attachment.listByConversation': {
        const params = z.strictObject({ conversationId: z.string().min(1) }).parse(env.params);
        assertConversationAudience(deps.db, deps.localUserId, params.conversationId);
        const rows = deps.db.prepare(`SELECT a.id, a.source_name, a.hash, a.revision, a.kind, a.created_at FROM artifacts a WHERE a.conversation_id = ? AND a.kind IN ('text_file','code_file') ORDER BY a.rowid DESC`).all(params.conversationId) as Array<{ id: string; source_name: string; hash: string; revision: number; kind: string; created_at: number }>;
        return withCommandId({ ok: true, data: { items: rows.map((r) => ({ attachmentId: r.id, filename: r.source_name, kind: r.kind, hash: r.hash, revision: r.revision, createdAt: r.created_at })) } });
      }
      case 'attachment.comment.add': {
        // 附件基础评论（第二十七轮六：文本/代码/Markdown）：行号/选区（quote 原文引用）+
        // 正文；**锚定评论时资源版本**（artifact_hash/revision 快照入库）——资源后续更新时
        // 旧评论标旧（list 比对当前 hash），行号/选区锚点不漂移不重算。audience=归属会话
        //（跨会话/他人 DM 拒绝）。
        const params = z.strictObject({
          attachmentId: z.string().min(1),
          body: z.string().min(1).max(2000),
          quote: z.string().max(500).optional(),
          lineFrom: z.number().int().min(1).optional(),
          lineTo: z.number().int().min(1).optional(),
        }).parse(env.params);
        if (params.lineTo != null && params.lineFrom != null && params.lineTo < params.lineFrom) throw new DaemonCommandError('VALIDATION_INVALID', '行区间无效：lineTo < lineFrom');
        const row = deps.db.prepare('SELECT id, conversation_id, kind, hash, revision FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; kind: string; hash: string; revision: number } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        assertConversationAudience(deps.db, deps.localUserId, row.conversation_id);
        if (!(ATT_TEXT_KINDS as readonly string[]).includes(row.kind)) throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', `该附件类型（${row.kind}）不支持评论（文本/代码/Markdown 首批）`);
        const tx = deps.db.transaction((): { commentId: string; anchoredRevision: number } => {
          const commentId = `ac_${randomUUID()}`;
          deps.db.prepare(`INSERT INTO attachment_comments (id, artifact_id, author_id, quote, line_from, line_to, body, artifact_hash, artifact_revision, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(commentId, row.id, deps.localUserId, params.quote ?? null, params.lineFrom ?? null, params.lineTo ?? null, params.body, row.hash, row.revision, Date.now());
          return { commentId, anchoredRevision: row.revision };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'attachment.comment.list': {
        // 评论列表（audience 同上）：逐条带 anchoredTo（锚定 hash/revision）+stale（当前资源
        // hash ≠ 锚定 hash=资源已更新——旧评论明确标旧，不漂移到新版行号）。
        const params = z.strictObject({ attachmentId: z.string().min(1) }).parse(env.params);
        const row = deps.db.prepare('SELECT id, conversation_id, hash FROM artifacts WHERE id = ?').get(params.attachmentId) as
          | { id: string; conversation_id: string; hash: string } | undefined;
        if (row == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `附件不存在：${params.attachmentId}`);
        assertConversationAudience(deps.db, deps.localUserId, row.conversation_id);
        const rows = deps.db.prepare('SELECT id, author_id, quote, line_from, line_to, body, artifact_hash, artifact_revision, created_at FROM attachment_comments WHERE artifact_id = ? ORDER BY created_at, rowid').all(params.attachmentId) as Array<{ id: string; author_id: string; quote: string | null; line_from: number | null; line_to: number | null; body: string; artifact_hash: string; artifact_revision: number; created_at: number }>;
        return withCommandId({ ok: true, data: { currentHash: row.hash, items: rows.map((c) => ({ commentId: c.id, authorId: c.author_id, quote: c.quote, lineFrom: c.line_from, lineTo: c.line_to, body: c.body, anchoredTo: { hash: c.artifact_hash, revision: c.artifact_revision }, stale: c.artifact_hash !== row.hash, createdAt: c.created_at })) } });
      }
      case 'saved.add': {
        // DEV-18 收藏（第二十五轮四）：独立持久（saved_refs——001 的 saved_items 为消息 FK
        // 专位保留）；重复收藏幂等（已存在=existed）；取消收藏不删原内容（saved.remove）。
        const params = z.strictObject({
          kind: z.enum(['message', 'link', 'task', 'delivery']),
          ref: z.string().min(1).max(500),
          title: z.string().max(200).optional(),
          projectId: z.string().min(1).optional(),
        }).parse(env.params);
        if (params.kind === 'link' && !/^https?:\/\//i.test(params.ref)) throw new DaemonCommandError('VALIDATION_INVALID', '链接收藏需 http(s) URL');
        const target = (() => {
          if (params.kind === 'message') {
            const row = deps.db.prepare('SELECT id, conversation_id FROM messages WHERE id = ?').get(params.ref) as { id: string; conversation_id: string } | undefined;
            return row == null ? null : { conversationId: row.conversation_id };
          }
          if (params.kind === 'task') {
            const row = deps.db.prepare('SELECT id, conversation_id, title FROM tasks WHERE id = ?').get(params.ref) as { id: string; conversation_id: string; title: string } | undefined;
            return row == null ? null : { conversationId: row.conversation_id };
          }
          if (params.kind === 'delivery') {
            const row = deps.db.prepare('SELECT d.id, t.conversation_id FROM task_deliveries d JOIN tasks t ON t.id = d.task_id WHERE d.id = ?').get(params.ref) as { id: string; conversation_id: string } | undefined;
            return row == null ? null : { conversationId: row.conversation_id };
          }
          return { conversationId: null as string | null }; // link：无会话归属
        })();
        if (target == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `收藏目标不存在：${params.ref}`);
        if (target.conversationId != null) assertConversationAudience(deps.db, deps.localUserId, target.conversationId);
        const tx = deps.db.transaction((): { saved: boolean; existed: boolean } => {
          const existing = deps.db.prepare('SELECT 1 AS ok FROM saved_refs WHERE viewer_id = ? AND kind = ? AND ref = ?').get(deps.localUserId, params.kind, params.ref);
          if (existing != null) return { saved: true, existed: true };
          deps.db.prepare('INSERT INTO saved_refs (viewer_id, kind, ref, title, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(deps.localUserId, params.kind, params.ref, params.title ?? null, params.projectId ?? null, Date.now());
          return { saved: true, existed: false };
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'saved.remove': {
        const params = z.strictObject({ kind: z.enum(['message', 'link', 'task', 'delivery']), ref: z.string().min(1).max(500) }).parse(env.params);
        const tx = deps.db.transaction((): { removed: boolean } => {
          const changed = deps.db.prepare('DELETE FROM saved_refs WHERE viewer_id = ? AND kind = ? AND ref = ?').run(deps.localUserId, params.kind, params.ref).changes;
          return { removed: changed === 1 }; // 只删收藏行——原内容不动
        });
        const r = run(tx);
        return withCommandId({ ok: true, data: r.data, replayed: r.replayed });
      }
      case 'saved.list': {
        // 逐条校验：目标存在+audience → ok/missing/forbidden（如实呈现；跳转复用正式深链）。
        const rows = deps.db.prepare('SELECT kind, ref, title, project_id, created_at FROM saved_refs WHERE viewer_id = ? ORDER BY created_at DESC, rowid DESC').all(deps.localUserId) as Array<{ kind: string; ref: string; title: string | null; project_id: string | null; created_at: number }>;
        const items = rows.map((row) => {
          const base = { kind: row.kind, ref: row.ref, title: row.title, projectId: row.project_id, createdAt: row.created_at };
          if (row.kind === 'link') return { ...base, status: 'ok', locate: null as string | null };
          if (row.kind === 'message') {
            const m = deps.db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(row.ref) as { conversation_id: string } | undefined;
            if (m == null) return { ...base, status: 'missing', locate: null };
            try { assertConversationAudience(deps.db, deps.localUserId, m.conversation_id); } catch { return { ...base, status: 'forbidden', locate: null }; }
            return { ...base, status: 'ok', locate: `#msg=${row.ref}` };
          }
          if (row.kind === 'task') {
            const t = deps.db.prepare('SELECT conversation_id FROM tasks WHERE id = ?').get(row.ref) as { conversation_id: string } | undefined;
            if (t == null) return { ...base, status: 'missing', locate: null };
            try { assertConversationAudience(deps.db, deps.localUserId, t.conversation_id); } catch { return { ...base, status: 'forbidden', locate: null }; }
            return { ...base, status: 'ok', locate: `#task=${row.ref}` };
          }
          const d = deps.db.prepare('SELECT t.conversation_id FROM task_deliveries d JOIN tasks t ON t.id = d.task_id WHERE d.id = ?').get(row.ref) as { conversation_id: string } | undefined;
          if (d == null) return { ...base, status: 'missing', locate: null };
          try { assertConversationAudience(deps.db, deps.localUserId, d.conversation_id); } catch { return { ...base, status: 'forbidden', locate: null }; }
          return { ...base, status: 'ok', locate: `#delivery=${row.ref}` };
        });
        return withCommandId({ ok: true, data: { items } });
      }
      case 'board.view': {
        // DEV-19 看板首包（第二十六轮四）：纯读聚合——复用正式任务/运行/交付数据（不建新表，
        // 不改任务状态——已有动作只接正式命令，看板不可拖动改库）。卡片保留项目/房间/taskId/
        // 线程身份（同名房间按 roomId 区分、同号任务按 taskId）；dm_turn 不进房间看板；
        // 他人 DM 不泄露。状态分列如实：running/review/blocked（runStatus=UNKNOWN 标注退出
        // 未确认）/stopped/waiting。子任务=根任务即卡片位（不重复计交付——pendingDelivery
        // 取最高 pending 一条）。
        const params = z.strictObject({ scope: z.enum(['project', 'all']).default('project'), projectId: z.string().min(1).optional() }).parse(env.params);
        if (params.scope === 'project' && params.projectId == null) throw new DaemonCommandError('VALIDATION_INVALID', 'scope=project 需要 projectId');
        const projects = (params.scope === 'project'
          ? deps.db.prepare('SELECT id, display_name FROM projects WHERE id = ?').all(params.projectId)
          : deps.db.prepare('SELECT id, display_name FROM projects ORDER BY rowid').all()) as Array<{ id: string; display_name: string }>;
        const groups = projects.map((p) => {
          const rooms = (deps.db.prepare('SELECT id, name FROM rooms WHERE project_id = ? ORDER BY rowid').all(p.id) as Array<{ id: string; name: string }>).map((room) => {
            const cards = (deps.db.prepare(
              `SELECT t.id, t.title, t.status, t.stop_generation, t.conversation_thread_id, t.owner_member_id,
                      (SELECT r.id FROM workflow_runs r WHERE r.task_id = t.id ORDER BY r.rowid DESC LIMIT 1) AS run_id,
                      (SELECT r.status FROM workflow_runs r WHERE r.task_id = t.id ORDER BY r.rowid DESC LIMIT 1) AS run_status
               FROM tasks t JOIN conversations c ON c.id = t.conversation_id
               WHERE t.room_id = ? AND t.kind = 'room_task' AND c.project_id = ?
               ORDER BY t.rowid DESC`,
            ).all(room.id, p.id) as Array<{ id: string; title: string; status: string; stop_generation: number; conversation_thread_id: string | null; owner_member_id: string | null; run_id: string | null; run_status: string | null }>).map((t) => {
              const pendingDelivery = t.status === 'REVIEW'
                ? (deps.db.prepare(`SELECT id, revision, manifest_hash FROM task_deliveries WHERE task_id = ? AND review_status = 'pending' ORDER BY revision DESC LIMIT 1`).get(t.id) as { id: string; revision: number; manifest_hash: string } | undefined) ?? null
                : null;
              // 状态映射按**任务/run 状态机**（第二十七轮五修正）：任务终态如实分列（DONE/FAILED=
              // 已完成、CANCELLED=已停止）；stop_generation 是代次不是停止证明——历史停止后
              // 新运行照常按 run 状态列位（旧实现 stop_generation>0 恒落 stopped、DONE 落
              // waiting 两缺陷同修）。STOPPING=停止中；INTERRUPTED=中断（列停止，恢复入口
              // 另接——不冒充等待）。
              const column = t.status === 'REVIEW' ? 'review'
                : t.status === 'BLOCKED' ? 'blocked'
                : t.status === 'DONE' || t.status === 'FAILED' ? 'done'
                : t.status === 'CANCELLED' ? 'stopped'
                : t.run_status === 'STOPPING' ? 'stopped'
                : t.run_status === 'RUNNING' || t.run_status === 'WAITING' || t.run_status === 'QUEUED' ? 'running'
                : t.run_status === 'INTERRUPTED' ? 'stopped'
                : 'waiting';
              // 退出未确认：来自 turn/恢复事实——run INTERRUPTED 且该 run 存在 UNKNOWN turn
              // （不确定结局）。workflow_runs 状态机无 UNKNOWN（旧检查 run_status==='UNKNOWN'
              // 恒假——那是 agent_turns 状态，已删）。
              const exitUnconfirmed = t.run_status === 'INTERRUPTED' && t.run_id != null
                && ((deps.db.prepare("SELECT count(*) c FROM agent_turns WHERE run_id = ? AND status = 'UNKNOWN'").get(t.run_id) as { c: number }).c > 0);
              return {
                taskId: t.id, title: t.title, threadId: t.conversation_thread_id,
                projectId: p.id, roomId: room.id, ownerMemberId: t.owner_member_id,
                taskStatus: t.status, runStatus: t.run_status, runId: t.run_id, stopGeneration: t.stop_generation, column,
                exitUnconfirmed,
                pendingDelivery: pendingDelivery == null ? null : { deliveryId: pendingDelivery.id, revision: pendingDelivery.revision, manifestHash: pendingDelivery.manifest_hash },
                locate: `#task=${t.id}`,
              };
            });
            return { roomId: room.id, name: room.name, cards };
          });
          return { projectId: p.id, displayName: p.display_name, rooms };
        });
        return withCommandId({ ok: true, data: { groups, note: '只读聚合——不改变任何任务状态；动作走正式命令（停止/验收/追加执行）' } });
      }
      case 'files.view': {
        // DEV-19 Files 集合（第二十七轮五）：**纯读**四类分列——项目文件（用户项目目录本身，
        // 非托管副本）/托管附件（artifacts——audience 过滤：房间全量+**本地用户参与的** DM，
        // 他人 DM 不进集合；私信资源标注 dm 不因聚合扩大可见性）/Agent 草稿（change_sets——
        // 变更集与应用状态）/交付成果（task_deliveries——深链 #delivery=）。逐项保留来源
        // （项目/会话/房间/任务）、版本、hash 与定位；不混成无来源文件列表。零运行零唤醒。
        const params = z.strictObject({ scope: z.enum(['project', 'all']).default('project'), projectId: z.string().min(1).optional() }).parse(env.params);
        if (params.scope === 'project' && params.projectId == null) throw new DaemonCommandError('VALIDATION_INVALID', 'scope=project 需要 projectId');
        const projects = (params.scope === 'project'
          ? deps.db.prepare('SELECT id, display_name, canonical_path FROM projects WHERE id = ?').all(params.projectId)
          : deps.db.prepare('SELECT id, display_name, canonical_path FROM projects ORDER BY rowid').all()) as Array<{ id: string; display_name: string; canonical_path: string }>;
        const groups = projects.map((p) => {
          const attachments = (deps.db.prepare(
            `SELECT a.id, a.source_name, a.hash, a.revision, a.kind, a.conversation_id, c.kind AS conversation_kind, c.room_id, a.created_at,
                    (SELECT ma.message_id FROM message_attachments ma WHERE ma.artifact_id = a.id ORDER BY ma.rowid LIMIT 1) AS message_id
             FROM artifacts a JOIN conversations c ON c.id = a.conversation_id
             WHERE c.project_id = ? AND (
               c.kind = 'room'
               OR (c.kind = 'dm' AND EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ) ORDER BY a.rowid DESC LIMIT 200`,
          ).all(p.id, deps.localUserId) as Array<{ id: string; source_name: string | null; hash: string; revision: number; kind: string; conversation_id: string; conversation_kind: string; room_id: string | null; created_at: number; message_id: string | null }>).map((a) => ({
            attachmentId: a.id, filename: a.source_name ?? a.id, hash: a.hash, revision: a.revision, kind: a.kind,
            conversationId: a.conversation_id, conversationKind: a.conversation_kind, roomId: a.room_id,
            audience: a.conversation_kind === 'dm' ? 'dm' : 'room', createdAt: a.created_at,
            locate: a.message_id != null ? `#msg=${a.message_id}` : a.conversation_kind === 'dm' ? `#dm=${a.conversation_id}` : null,
          }));
          const drafts = (deps.db.prepare(
            `SELECT cs.id, cs.task_id, cs.application_status, cs.before_ref, cs.after_ref, t.title AS task_title
             FROM change_sets cs LEFT JOIN tasks t ON t.id = cs.task_id
             WHERE cs.project_id = ? ORDER BY cs.rowid DESC LIMIT 100`,
          ).all(p.id) as Array<{ id: string; task_id: string | null; application_status: string; before_ref: string; after_ref: string; task_title: string | null }>).map((d) => ({
            changeSetId: d.id, taskId: d.task_id, taskTitle: d.task_title, applicationStatus: d.application_status,
            beforeRef: d.before_ref, afterRef: d.after_ref, locate: d.task_id != null ? `#task=${d.task_id}` : null,
          }));
          const deliveries = (deps.db.prepare(
            `SELECT d.id, d.revision, d.manifest_hash, d.reviewed_at, t.id AS task_id, t.title, c.kind AS conversation_kind, t.conversation_thread_id
             FROM task_deliveries d JOIN tasks t ON t.id = d.task_id JOIN conversations c ON c.id = t.conversation_id
             WHERE t.project_id = ? AND (
               c.kind = 'room'
               OR (c.kind = 'dm' AND EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ) ORDER BY d.rowid DESC LIMIT 100`,
          ).all(p.id, deps.localUserId) as Array<{ id: string; revision: number; manifest_hash: string; reviewed_at: number | null; task_id: string; title: string; conversation_kind: string }>).map((d) => ({
            deliveryId: d.id, revision: d.revision, manifestHash: d.manifest_hash, taskId: d.task_id, title: d.title,
            audience: d.conversation_kind === 'dm' ? 'dm' : 'room', reviewedAt: d.reviewed_at, locate: `#delivery=${d.id}`,
          }));
          // 项目文件：项目根一层条目（来源=用户项目目录；只列名——浏览走系统资源管理器/Git 页）。
          let projectFiles: Array<{ name: string; dir: boolean }> = [];
          let projectFilesNote: string | null = null;
          try {
            const entries = readdirSync(p.canonical_path, { withFileTypes: true }).slice(0, 100);
            projectFiles = entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
          } catch (error) {
            projectFilesNote = `项目目录不可读：${error instanceof Error ? error.message : String(error)}`;
          }
          return { projectId: p.id, displayName: p.display_name, projectFiles, ...(projectFilesNote != null ? { projectFilesNote } : {}), attachments, drafts, deliveries };
        });
        return withCommandId({ ok: true, data: { groups, note: 'Files 集合（只读四类分列：项目文件/托管附件/Agent 草稿/交付成果——逐项保留来源/版本/hash/定位；私信资源仅本人可见）' } });
      }
      case 'thread.collaborators': {
        // DEV-19 协作视图首包（第二十六轮四）：四列分列——人的关注（thread_subscriptions）/        // Agent 跟进名单（thread_agent_followers）/冻结参与者（route_json.frozenMemberIds）/
        // 实时执行（run_participants）。纯读零运行。
        const params = z.strictObject({ threadId: z.string().min(1) }).parse(env.params);
        const thread = deps.db.prepare('SELECT conversation_id, project_id FROM conversation_threads WHERE id = ?').get(params.threadId) as { conversation_id: string; project_id: string } | undefined;
        if (thread == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `线程不存在：${params.threadId}`);
        assertConversationAudience(deps.db, deps.localUserId, thread.conversation_id);
        const humanFollowers = (deps.db.prepare('SELECT count(*) c FROM thread_subscriptions WHERE thread_id = ? AND followed = 1').get(params.threadId) as { c: number }).c;
        const agentFollowers = (deps.db.prepare('SELECT member_id, status FROM thread_agent_followers WHERE thread_id = ? ORDER BY member_id').all(params.threadId) as Array<{ member_id: string; status: string }>).map((r) => ({ memberId: r.member_id, status: r.status }));
        const task = deps.db.prepare('SELECT id, route_json FROM tasks WHERE conversation_thread_id = ? ORDER BY rowid DESC LIMIT 1').get(params.threadId) as { id: string; route_json: string | null } | undefined;
        let frozenParticipants: string[] = [];
        if (task?.route_json != null) {
          try { const route = JSON.parse(task.route_json) as { frozenMemberIds?: string[] }; if (Array.isArray(route.frozenMemberIds)) frozenParticipants = route.frozenMemberIds; } catch { /* 损坏如实空列 */ }
        }
        const activeRun = task != null
          ? (() => {
            const run = deps.db.prepare("SELECT id, status FROM workflow_runs WHERE task_id = ? AND status IN ('RUNNING','WAITING') ORDER BY rowid DESC LIMIT 1").get(task.id) as { id: string; status: string } | undefined;
            if (run == null) return null;
            const participants = (deps.db.prepare('SELECT member_id, role, status FROM run_participants WHERE run_id = ? ORDER BY role, member_id').all(run.id) as Array<{ member_id: string; role: string; status: string }>).map((r) => ({ memberId: r.member_id, role: r.role, status: r.status }));
            return { runId: run.id, participants };
          })()
          : null;
        return withCommandId({ ok: true, data: { humanFollowers, agentFollowers, frozenParticipants, activeRun } });
      }
      case 'mine.pending': {
        // DEV-18 首包：待我处理=权威业务状态汇总（纯读——零新增运行/零预算）。覆盖全部项目
        // 行（正式链无隐藏位——"含隐藏项目"=全部 projects）。逐项：
        // - 待验收任务（tasks.status='REVIEW'，按任务逐条——同一会话多任务不因 conversation
        //   级 LIMIT1 漏项），每条绑定当前交付（pending 优先，其次最新行）：
        //   deliveryId/revision/manifestHash（验收按此核对——旧交付不能批准新版）；
        // - DM 未读（agent 消息且 conversation_seq > last_read_seq 的条数+最新序）。
        const projects = deps.db.prepare('SELECT id, display_name FROM projects ORDER BY rowid').all() as Array<{ id: string; display_name: string }>;
        const out = projects.map((p) => {
          // audience（第二十三轮三）：REVIEW 任务按其实际会话过滤——他人 DM 的任务/标题/版本
          // 一律不出现在汇总（不因聚合形态泄露；房间任务=项目内可见）。无 pending 交付的
          // REVIEW 任务 delivery 如实 null+actionable=false（已处理/被替代交付不因聚合成为
          // 可批准对象——验收入口据此拒绝并显示诊断，不假装正常待验收）。
          const reviewTasks = (deps.db.prepare(
            `SELECT t.id AS task_id, t.kind AS task_kind, t.conversation_id, c.kind AS conversation_kind, t.status,
                    d.id AS delivery_id, d.revision, d.manifest_hash
             FROM tasks t
             JOIN conversations c ON c.id = t.conversation_id
             LEFT JOIN task_deliveries d ON d.task_id = t.id AND d.review_status = 'pending'
             WHERE t.project_id = ? AND t.status = 'REVIEW'
               AND (c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ORDER BY t.rowid`,
          ).all(p.id, deps.localUserId) as Array<{ task_id: string; task_kind: string; conversation_id: string | null; conversation_kind: string; status: string; delivery_id: string | null; revision: number | null; manifest_hash: string | null }>)
            .map((r) => ({ ...r, actionable: r.delivery_id != null }));
          const dmUnread = (deps.db.prepare(
            `SELECT c.id AS conversation_id, c.title,
                    (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.author_type = 'agent' AND m.conversation_seq > COALESCE((SELECT s.last_read_seq FROM conversation_read_states s WHERE s.conversation_id = c.id AND s.viewer_id = ?), 0)) AS unread,
                    (SELECT max(m2.conversation_seq) FROM messages m2 WHERE m2.conversation_id = c.id AND m2.author_type = 'agent') AS last_agent_seq
             FROM conversations c
             WHERE c.project_id = ? AND c.kind = 'dm' AND c.archived_at IS NULL
               AND EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?)`,
          ).all(deps.localUserId, p.id, deps.localUserId) as Array<{ conversation_id: string; title: string | null; unread: number; last_agent_seq: number | null }>).filter((r) => r.unread > 0);
          // 线程未读（第二十三轮一）：主池聚合数据面——每线程 agent 回复 thread_message_seq >
          // 水位的条数（打开房间≠读完线程；读线程 A 不影响 B）。静音线程排除（第二十五轮四）。
          const threadUnread = (deps.db.prepare(
            `SELECT t.id AS thread_id,
                    (SELECT count(*) FROM messages m WHERE m.thread_id = t.id AND m.author_type = 'agent' AND m.thread_message_seq > COALESCE((SELECT s.last_read_message_seq FROM thread_read_states s WHERE s.thread_id = t.id AND s.viewer_id = ?), 0)) AS unread
             FROM conversation_threads t
             JOIN conversations c ON c.id = t.conversation_id
             WHERE t.project_id = ? AND c.kind = 'room'
               AND NOT EXISTS (SELECT 1 FROM thread_subscriptions sub WHERE sub.thread_id = t.id AND sub.viewer_id = ? AND sub.muted = 1)`,
          ).all(deps.localUserId, p.id, deps.localUserId) as Array<{ thread_id: string; unread: number }>).filter((r) => r.unread > 0);
          // 关注线程（第二十五轮四）：人的阅读订阅（与 Agent 执行名单分列）——有未读时进
          // 待我处理（muted 的关注仍排除未读——静音优先）。
          const followedThreads = (deps.db.prepare(
            `SELECT sub.thread_id, t.root_task_id, t.anchor_message_id,
                    (SELECT count(*) FROM messages m WHERE m.thread_id = t.id AND m.author_type = 'agent' AND m.thread_message_seq > COALESCE((SELECT s.last_read_message_seq FROM thread_read_states s WHERE s.thread_id = t.id AND s.viewer_id = ?), 0)) AS unread
             FROM thread_subscriptions sub
             JOIN conversation_threads t ON t.id = sub.thread_id
             JOIN conversations c ON c.id = t.conversation_id
             WHERE sub.viewer_id = ? AND sub.followed = 1 AND sub.muted = 0 AND c.project_id = ? AND c.kind = 'room'`,
          ).all(deps.localUserId, deps.localUserId, p.id) as Array<{ thread_id: string; root_task_id: string | null; anchor_message_id: string; unread: number }>).filter((r) => r.unread > 0);
          // 阻塞任务（第二十三轮三：如实列出——可见≠审批：不并入待验收，处理入口=线程本身；
          // 不把所有 BLOCKED 都当人工审批，授权请求（WAITING_APPROVAL）等其余未覆盖项见
          // continuation 登记范围）。
          const blockedTasks = (deps.db.prepare(
            `SELECT t.id AS task_id, t.kind AS task_kind, t.title, t.conversation_id, c.kind AS conversation_kind
             FROM tasks t JOIN conversations c ON c.id = t.conversation_id
             WHERE t.project_id = ? AND t.status = 'BLOCKED'
               AND (c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ORDER BY t.rowid`,
          ).all(p.id, deps.localUserId) as Array<{ task_id: string; task_kind: string; title: string; conversation_id: string | null; conversation_kind: string }>);
          // 待确认提醒触发（REM-8）：确认入口由此可达；他人 DM 不泄露。locate（第二十六轮二）：
          // 服务端按目标实际形态构造准确深链——DM=#dm=；房间任务串=#task=；讨论串=#msg=锚。
          // notifyMuted=目标**线程**静音（提醒通知过滤——不能用未读聚合过滤代替；待办保留仅禁通知）。
          const reminderAwaitsRaw = (deps.db.prepare(
            `SELECT ro.reminder_id, ro.scheduled_at, ro.missed_count, r.title, r.conversation_id, r.thread_id, r.task_id, c.kind AS conversation_kind,
                    (SELECT t.root_task_id FROM conversation_threads t WHERE t.id = r.thread_id) AS root_task_id,
                    (SELECT t.anchor_message_id FROM conversation_threads t WHERE t.id = r.thread_id) AS anchor_message_id,
                    EXISTS(SELECT 1 FROM thread_subscriptions sub WHERE sub.thread_id = r.thread_id AND sub.viewer_id = ? AND sub.muted = 1) AS notify_muted
             FROM reminder_occurrences ro
             JOIN reminders r ON r.id = ro.reminder_id
             JOIN conversations c ON c.id = r.conversation_id
             WHERE c.project_id = ? AND ro.status = 'fired' AND ro.outcome = 'awaiting_confirmation'
               AND (c.kind != 'dm' OR EXISTS (SELECT 1 FROM dm_participants dp WHERE dp.conversation_id = c.id AND dp.principal_type = 'human' AND dp.principal_id = ?))
             ORDER BY ro.scheduled_at`,
          ).all(deps.localUserId, p.id, deps.localUserId) as Array<{ reminder_id: string; scheduled_at: number; missed_count: number; title: string | null; conversation_id: string; thread_id: string | null; task_id: string | null; conversation_kind: string; root_task_id: string | null; anchor_message_id: string | null; notify_muted: number }>);
          const reminderAwaits = reminderAwaitsRaw.map((row) => ({
            reminderId: row.reminder_id, scheduledAt: row.scheduled_at, missedCount: row.missed_count, title: row.title,
            conversationId: row.conversation_id,
            locate: row.conversation_kind === 'dm'
              ? `#dm=${row.conversation_id}`
              : (row.task_id ?? row.root_task_id) != null ? `#task=${row.task_id ?? row.root_task_id}` : `#msg=${row.anchor_message_id}`,
            notifyMuted: row.notify_muted === 1, // 点击定位不受影响——仅系统通知禁发
          }));
          return { projectId: p.id, displayName: p.display_name, reviewTasks, dmUnread, threadUnread, blockedTasks, reminderAwaits, followedThreads };
        }).filter((p) => p.reviewTasks.length > 0 || p.dmUnread.length > 0 || p.threadUnread.length > 0 || p.blockedTasks.length > 0 || p.reminderAwaits.length > 0 || p.followedThreads.length > 0);
        return withCommandId({ ok: true, data: { projects: out, generatedAt: Date.now() } });
      }
      case 'deepLink.resolve': {
        // DEV-18 首包：深链按实体真实归属定位（纯读——零新增运行/零预算）。失效/无权限/归属
        // 矛盾明确报错（不静默跳转）。支持：#dm=/#task=/#delivery=/#msg=。
        const params = z.strictObject({ hash: z.string().min(1).max(200) }).parse(env.params);
        const m = /^#(dm|task|delivery|msg)=([A-Za-z0-9_:-]+)$/.exec(params.hash.trim());
        if (m == null) throw new DaemonCommandError('VALIDATION_INVALID', `深链格式无效：${params.hash.slice(0, 60)}`);
        const kind = m[1] as 'dm' | 'task' | 'delivery' | 'msg';
        const id = m[2] as string;
        const convOf = (conversationId: string): { projectId: string; kind: string } => {
          const row = deps.db.prepare('SELECT project_id, kind FROM conversations WHERE id = ?').get(conversationId) as { project_id: string; kind: string } | undefined;
          if (row == null) throw new DaemonCommandError('NOT_FOUND', `会话不存在或已删除：${conversationId}`);
          return { projectId: row.project_id, kind: row.kind };
        };
        if (kind === 'dm') {
          const conv0 = convOf(id);
          if (conv0.kind !== 'dm') throw new DaemonCommandError('LINK_TARGET_MISMATCH', `#${kind}=${id} 指向非私信会话（kind=${conv0.kind}）——深链与实体归属矛盾`);
          const conv = assertConversationAudience(deps.db, deps.localUserId, id);
          return withCommandId({ ok: true, data: { kind: 'dm', projectId: conv.projectId, conversationId: id, rootPath: rootPathOf(deps.db, conv.projectId) } });
        }
        if (kind === 'task') {
          const row = deps.db.prepare('SELECT id, project_id, conversation_id, conversation_thread_id FROM tasks WHERE id = ?').get(id) as { id: string; project_id: string; conversation_id: string; conversation_thread_id: string | null } | undefined;
          if (row == null) throw new DaemonCommandError('NOT_FOUND', `任务不存在或已删除：${id}`);
          const conv = assertConversationAudience(deps.db, deps.localUserId, row.conversation_id); // 任务经会话核 audience——链接形态不绕过私信限制
          return withCommandId({ ok: true, data: { kind: 'task', projectId: conv.projectId, conversationId: row.conversation_id, threadId: row.conversation_thread_id, taskId: row.id, rootPath: rootPathOf(deps.db, conv.projectId) } });
        }
        if (kind === 'delivery') {
          const row = deps.db.prepare(
            'SELECT d.id, d.revision, d.manifest_hash, t.id AS task_id, t.project_id, t.conversation_id FROM task_deliveries d JOIN tasks t ON t.id = d.task_id WHERE d.id = ?',
          ).get(id) as { id: string; revision: number; manifest_hash: string; task_id: string; project_id: string; conversation_id: string } | undefined;
          if (row == null) throw new DaemonCommandError('NOT_FOUND', `交付不存在或已删除：${id}`);
          const conv = assertConversationAudience(deps.db, deps.localUserId, row.conversation_id); // 交付经会话核 audience
          return withCommandId({ ok: true, data: { kind: 'delivery', projectId: conv.projectId, conversationId: row.conversation_id, taskId: row.task_id, deliveryId: row.id, revision: row.revision, manifestHash: row.manifest_hash, rootPath: rootPathOf(deps.db, conv.projectId) } });
        }
        const msgRow = deps.db.prepare('SELECT id, conversation_id, conversation_seq, thread_id FROM messages WHERE id = ?').get(id) as { id: string; conversation_id: string; conversation_seq: number; thread_id: string | null } | undefined;
        if (msgRow == null) throw new DaemonCommandError('NOT_FOUND', `消息不存在或已删除：${id}`);
        const conv = assertConversationAudience(deps.db, deps.localUserId, msgRow.conversation_id); // 消息经会话核 audience（含线程归属消息）
        return withCommandId({ ok: true, data: { kind: 'msg', projectId: conv.projectId, conversationId: msgRow.conversation_id, threadId: msgRow.thread_id, messageId: msgRow.id, messageSeq: msgRow.conversation_seq, rootPath: rootPathOf(deps.db, conv.projectId) } });
      }
      case 'conversation.rename': {
        const params = z.strictObject({ conversationId: z.string().min(1), title: z.string().min(1).max(120), expectedRevision: z.number().int().min(0) }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (conv.revision !== params.expectedRevision) throw new DaemonCommandError('REVISION_CONFLICT', `期望 revision=${params.expectedRevision}，当前=${conv.revision}`);
        deps.db.prepare('UPDATE conversations SET title = ?, revision = revision + 1 WHERE id = ?').run(params.title, params.conversationId);
        return withCommandId({ ok: true, data: { conversationId: params.conversationId, revision: params.expectedRevision + 1 } });
      }
      case 'conversation.archive': {
        // 归档（第十九轮六：对齐基线 §2.1）——顺序：禁止新发/新派发（archived_at 事务内置位+
        // 队列挂起）→ 活动运行按停止规则处理（requestStop 正式流程+协议中断）→ 历史只读。
        // 停止退出无法确认时保留明确状态（stopPending——不伪称已停）；重复归档幂等返回。
        const params = z.strictObject({ conversationId: z.string().min(1), expectedRevision: z.number().int().min(0) }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (conv.archived_at != null) {
          return withCommandId({ ok: true, data: { conversationId: params.conversationId, archived: true, already: true, stopPending: dmHasActiveRun(deps.db, params.conversationId) } });
        }
        if (conv.revision !== params.expectedRevision) throw new DaemonCommandError('REVISION_CONFLICT', `期望 revision=${params.expectedRevision}，当前=${conv.revision}`);
        const activeRuns = deps.db.prepare(
          `SELECT t.id AS taskId, t.stop_generation AS stopGen, r.id AS runId FROM workflow_runs r JOIN tasks t ON t.id = r.task_id
           WHERE t.conversation_id = ? AND t.kind = 'dm_turn' AND r.status IN ('RUNNING','WAITING','STOPPING')`,
        ).all(params.conversationId) as Array<{ taskId: string; stopGen: number; runId: string }>;
        const result = run(() => {
          deps.db.prepare('UPDATE conversations SET archived_at = ?, revision = revision + 1 WHERE id = ?').run(Date.now(), params.conversationId);
          holdDmPauseGate(deps.db, params.conversationId, '归档：队列暂停（恢复会话不自动续跑——继续由 dm.resume 显式控制）');
          return { conversationId: params.conversationId, revision: params.expectedRevision + 1, archived: true, already: false, stopPending: activeRuns.length > 0 };
        });
        // 归档后对活动运行逐个走正式停止流程（请求≠退出确认；无法确认时状态如实保留）。
        for (const active of activeRuns) {
          try {
            await requestStop(deps.db, {
              taskId: active.taskId, targetRunId: active.runId, expectedStopGeneration: active.stopGen,
              commandId: `${env.commandId}:stop:${active.runId}`, idempotencyScope: scope, payloadHash, now: Date.now(),
              interruptTurn: deps.interruptTurn,
            });
          } catch (stopError) {
            // 单个停止失败不回滚归档（已禁止新发/派发）；状态以 stopPending 如实呈现。
            void stopError;
          }
        }
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'conversation.restore': {
        const params = z.strictObject({ conversationId: z.string().min(1) }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (conv.archived_at == null) return withCommandId({ ok: true, data: { conversationId: params.conversationId, restored: false } });
        deps.db.prepare('UPDATE conversations SET archived_at = NULL, revision = revision + 1 WHERE id = ?').run(params.conversationId);
        // restore 不自动续跑（R4）：清除停止挂起但不泵队列——排队消息保持排队等待发送或显式继续。
        releaseDmPauseGate(deps.db, params.conversationId);
        return withCommandId({ ok: true, data: { conversationId: params.conversationId, restored: true } });
      }
      case 'dm.resume': {
        // 显式继续（R4：停止后队列 paused，需用户继续）：清挂起并泵一条排队消息。
        const params = z.strictObject({ conversationId: z.string().min(1) }).parse(env.params);
        const conv = dmConversationOf(deps.db, params.conversationId);
        if (conv == null || conv.kind !== 'dm') throw new DaemonCommandError('CONVERSATION_SCOPE_MISMATCH', '会话不存在或非私信');
        if (conv.archived_at != null) throw new DaemonCommandError('CONVERSATION_ARCHIVED', '对话已归档：禁止续跑');
        releaseDmPauseGate(deps.db, params.conversationId);
        const pumped = pumpDmQueue(deps.db, params.conversationId);
        return withCommandId({ ok: true, data: { conversationId: params.conversationId, enqueued: pumped.enqueued } });
      }
      case 'realCalls.summary': {
        // 真实调用护栏台账查询（第十七轮四：startTurn 级实际请求边界——batchId/状态/归属分列；
        // fake 不产生行）。只读诊断面，不用于绕过防护。
        const params = z.strictObject({ batchId: z.string().min(1).max(100).optional() }).parse(env.params);
        const { realCallSummary } = await import('./realCallLedger.ts');
        return withCommandId({ ok: true, data: realCallSummary(deps.db, params.batchId) });
      }
      case 'app.settings.get': {
        // 应用设置（第九轮）：daemon_state kv 白名单——持久化并跨重开生效；未知键拒绝。
        const params = z.strictObject({ keys: z.array(z.enum(['repoStatus.visible', 'ui.autoOpenProjectPath'])).min(1) }).parse(env.params);
        const values: Record<string, string | null> = {};
        for (const key of params.keys) {
          const row = deps.db.prepare('SELECT value FROM daemon_state WHERE key = ?').get(`app:setting:${key}`) as { value: string } | undefined;
          values[key] = row?.value ?? null;
        }
        return withCommandId({ ok: true, data: { values } });
      }
      case 'app.settings.set': {
        const params = z.strictObject({
          key: z.enum(['repoStatus.visible', 'ui.autoOpenProjectPath']),
          value: z.string().min(1).max(600),
        }).parse(env.params);
        const result = run(() => {
          const allowed: Record<string, string[]> = { 'repoStatus.visible': ['true', 'false'] };
          if (allowed[params.key] != null && !allowed[params.key]!.includes(params.value)) {
            throw new DaemonCommandError('VALIDATION_INVALID', `设置 ${params.key} 不接受值 ${params.value}（允许：${allowed[params.key]!.join('/')}）`);
          }
          deps.db.prepare('INSERT INTO daemon_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
            .run(`app:setting:${params.key}`, params.value, Date.now());
          return { key: params.key, value: params.value };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'task.review': {
        // RT-25 可选任务验收（第八轮）：按任务创建时的策略快照（review_policy=user_review
        // 才有 pending 交付）处理唯一待验收交付。accept→任务 DONE；changes_requested→任务
        // 回 ACTIVE（返工经 redispatch 正式链）。**Git 提交不等同验收**——本命令只写
        // review 账本与任务状态，不触碰 git/changeset。
        // 第九轮（验收绑定具体交付版本，防错稿）：提交须带 UI 展示时的 deliveryId+revision；
        // 事务内条件更新并核对影响行数——已被新版本替代/已处理/状态变化各返回明确冲突，
        // 不自动套用到新交付。同 commandId 重放=网关幂等原回执；不同 commandId 对已处理
        // 版本不再次生效（条件更新 0 行=冲突）。
        const params = z.strictObject({
          taskId: z.string().min(1),
          deliveryId: z.string().min(1),
          deliveryRevision: z.number().int().positive(),
          manifestHash: z.string().min(8), // 三重绑定（第二十三轮三）：id+revision+内容 hash——错稿防线最后一级
          decision: z.enum(['accept', 'changes_requested']),
          note: z.string().min(1).max(500).optional(),
        }).refine((p) => p.decision !== 'changes_requested' || (p.note != null && p.note.trim().length > 0), {
          message: '要求修改必须填写意见（§10.5-4：意见进入正式任务记录并注入返工输入）',
          path: ['note'],
        }).parse(env.params);
        const result = run(() => {
          const task = deps.db.prepare('SELECT id, status, review_policy, conversation_id FROM tasks WHERE id = ?').get(params.taskId) as { id: string; status: string; review_policy: string; conversation_id: string } | undefined;
          if (task == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `任务不存在：${params.taskId}`);
          // audience（第二十三轮三）：房间/DM/待办共用本命令——按任务实际会话核双成员
          //（与 deepLink 同一校验处，不因命令形态绕过私信限制）。
          assertConversationAudience(deps.db, deps.localUserId, task.conversation_id);
          if (task.review_policy !== 'user_review') {
            throw new DaemonCommandError('STALE_REVISION', `任务策略为 ${task.review_policy}（非 user_review）：无待验收交付——验收状态与创建时策略快照一致`);
          }
          const delivery = deps.db.prepare(
            'SELECT id, revision, manifest_hash, run_id, review_status FROM task_deliveries WHERE task_id = ? AND id = ?',
          ).get(params.taskId, params.deliveryId) as { id: string; revision: number; manifest_hash: string; run_id: string | null; review_status: string } | undefined;
          if (delivery == null) {
            throw new DaemonCommandError('RESOURCE_NOT_FOUND', `交付不存在或不属于该任务：${params.deliveryId}（验收不跨任务套用）`);
          }
          if (delivery.revision !== params.deliveryRevision) {
            throw new DaemonCommandError('STALE_REVISION', `交付版本不符：提交第 ${params.deliveryRevision} 版，记录为第 ${delivery.revision} 版——版本绑定校验失败`);
          }
          if (delivery.manifest_hash !== params.manifestHash) {
            throw new DaemonCommandError('STALE_REVISION', `交付内容不符：manifestHash 不匹配（提交 ${params.manifestHash.slice(0, 12)}，记录 ${delivery.manifest_hash.slice(0, 12)}）——同版本号不同内容不可验收`);
          }
          if (delivery.review_status === 'superseded') {
            const current = deps.db.prepare(`SELECT revision FROM task_deliveries WHERE task_id = ? AND review_status = 'pending' LIMIT 1`).get(params.taskId) as { revision: number } | undefined;
            throw new DaemonCommandError('STALE_REVISION', `第 ${delivery.revision} 版交付已被新交付替代（当前待验收为第 ${current?.revision ?? '?'} 版）——验收不自动套用到新交付`);
          }
          if (delivery.review_status !== 'pending') {
            throw new DaemonCommandError('STALE_REVISION', `第 ${delivery.revision} 版交付已处理（${delivery.review_status}）——不同命令号不重复生效`);
          }
          if (task.status !== 'REVIEW') {
            throw new DaemonCommandError('STALE_REVISION', `任务状态 ${task.status} 非 REVIEW：验收不适用于当前状态`);
          }
          const now = Date.now();
          const projectId = (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(task.id) as { project_id: string }).project_id;
          const nextStatus = params.decision === 'accept' ? 'accepted' : 'changes_requested';
          const taskNext = params.decision === 'accept' ? 'DONE' : 'ACTIVE';
          const tx = deps.db.transaction(() => {
            const updated = deps.db.prepare(
              `UPDATE task_deliveries SET review_status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
               WHERE id = ? AND task_id = ? AND revision = ? AND review_status = 'pending'`,
            ).run(nextStatus, deps.localUserId, now, params.note ?? null, delivery.id, params.taskId, delivery.revision);
            if (updated.changes !== 1) {
              throw new DaemonCommandError('STALE_REVISION', '条件更新未命中（交付状态在事务内已变化）——验收不生效，请刷新后重试');
            }
            const taskUpdated = deps.db.prepare(`UPDATE tasks SET status = ?, revision = revision + 1 WHERE id = ? AND status = 'REVIEW'`).run(taskNext, task.id);
            if (taskUpdated.changes !== 1) {
              throw new DaemonCommandError('STALE_REVISION', '任务状态在事务内已变化——验收不生效，请刷新后重试');
            }
            appendDomainEvent(deps.db, {
              schemaVersion: 1, eventId: `evt_${randomUUID()}`,
              projectId, taskId: task.id, runId: delivery.run_id ?? undefined,
              kind: 'task.reviewRecorded', createdAt: now,
              payload: {
                decision: params.decision, deliveryId: delivery.id, deliveryRevision: delivery.revision,
                reviewedBy: deps.localUserId, note: params.note ?? null,
                taskStatusAfter: taskNext,
                gitCommitIsNotReview: 'Git 提交不等同验收（RT-25）：本记录只承载人工验收事实',
                reworkNote: params.decision === 'changes_requested'
                  ? '返工反馈将注入后续派发输入（明确关联被退回的交付版本）'
                  : null,
              },
            });
          });
          tx();
          return { taskId: task.id, decision: params.decision, deliveryId: delivery.id, deliveryRevision: delivery.revision, reviewStatus: nextStatus, taskStatusAfter: params.decision === 'accept' ? 'DONE' : 'ACTIVE' };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'runtime.status': {
        // DEV-14（第八轮）：运行能力真实状态（只读、不 spawn 子进程）——成员绑定、静态
        // 能力矩阵关键项、本 daemon 的恢复取证/迟到回放能力与真实性标注。
        const installations = deps.db.prepare(
          'SELECT id, kind, executable FROM runtime_installations ORDER BY kind',
        ).all() as Array<{ id: string; kind: string; executable: string | null }>;
        const bindings = deps.db.prepare(
          `SELECT pm.id AS memberId, pm.display_name AS displayName, ri.kind AS kind, ap.settings_json AS settingsJson
           FROM project_members pm
           LEFT JOIN agent_profiles ap ON ap.id = pm.profile_id
           LEFT JOIN runtime_installations ri ON ri.id = ap.runtime_installation_id
           ORDER BY pm.id`,
        ).all() as Array<{ memberId: string; displayName: string; kind: string | null; settingsJson: string | null }>;
        const memberBindings = bindings.map((b) => {
          let model: string | null = null;
          try { model = b.settingsJson != null ? (JSON.parse(b.settingsJson) as { model?: string }).model ?? null : null; } catch { /* settings 解析失败=无模型 */ }
          return { memberId: b.memberId, displayName: b.displayName, kind: b.kind ?? '(默认 runtime)', model };
        });
        return withCommandId({ ok: true, data: {
          installations,
          memberBindings,
          capabilities: {
            claude: { keyAbilities: { structuredFinal: 'supported', restrictWrites: 'unverified', interactiveApprovals: 'unverified' }, adapterVersion: CLAUDE_ADAPTER_VERSION },
          },
          daemonRecovery: {
            processTreeEvidence: process.platform === 'win32' ? 'supported（全表 CIM+活跃期快照历史归属核对）' : 'unsupported（仅 win32——保护保留语义）',
            lateEventPump: 'fake 已验证（同 daemon+重启演练）；真实 CLI 会话文件回放待补证（adapter.lateEvents 未实现=如实 unsupported）',
            probeServerSideOnly: true,
          },
          note: '真实性口径：能力结论只适用于实测组合；未认证/未验证项如实标注（runtime-capability-matrix）',
        } });
      }
      case 'room.pool': {
        // 房间主池（修复轮 6）：room 限定的根消息+线程摘要——不用事件拼接、不混其他房间。
        const params = z.strictObject({ roomId: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }).parse(env.params);
        const limit = params.limit ?? 50;
        const threads = deps.db.prepare(
          `SELECT t.id, t.anchor_message_id, t.root_task_id, t.last_message_seq, t.revision,
                  m.body_json, m.created_at,
                  tk.status AS task_status, tk.room_task_number
           FROM conversation_threads t
           JOIN messages m ON m.id = t.anchor_message_id
           LEFT JOIN tasks tk ON tk.id = t.root_task_id
           WHERE t.room_id = ?
           ORDER BY m.created_at DESC LIMIT ?`,
        ).all(params.roomId, limit) as Array<{
          id: string; anchor_message_id: string; root_task_id: string | null; last_message_seq: number; revision: number;
          body_json: string; created_at: number; task_status: string | null; room_task_number: number | null;
        }>;
        const items = [];
        for (const t of threads) {
          const replyCount = (deps.db.prepare('SELECT count(*) c FROM messages WHERE thread_id = ?').get(t.id) as { c: number }).c;
          // 静音尊重（第二十五轮四）：muted 线程未读恒 0（不进未读/通知聚合——卡片仍可见）。
          const muted = (deps.db.prepare('SELECT muted FROM thread_subscriptions WHERE thread_id = ? AND viewer_id = ?').get(t.id, deps.localUserId) as { muted: number } | undefined)?.muted === 1;
          // 线程未读（第二十三轮一：主池聚合）——agent 回复 thread_message_seq > 水位的条数。
          const unread = muted ? 0 : (deps.db.prepare(
            `SELECT count(*) c FROM messages m WHERE m.thread_id = ? AND m.author_type = 'agent' AND m.thread_message_seq > COALESCE((SELECT s.last_read_message_seq FROM thread_read_states s WHERE s.thread_id = ? AND s.viewer_id = ?), 0)`,
          ).get(t.id, t.id, deps.localUserId) as { c: number }).c;
          const followed = (deps.db.prepare('SELECT followed FROM thread_subscriptions WHERE thread_id = ? AND viewer_id = ?').get(t.id, deps.localUserId) as { followed: number } | undefined)?.followed === 1;
          const lastReply = deps.db.prepare('SELECT created_at FROM messages WHERE thread_id = ? ORDER BY thread_message_seq DESC LIMIT 1').get(t.id) as { created_at: number } | undefined;
          items.push({
            threadId: t.id, unread, muted, followed,
            anchorMessageId: t.anchor_message_id,
            body: JSON.parse(t.body_json) as { text: string },
            createdAt: t.created_at,
            replyCount,
            lastReplyAt: lastReply?.created_at ?? null,
            taskId: t.root_task_id,
            taskStatus: t.task_status,
            roomTaskNumber: t.room_task_number,
          });
        }
        return withCommandId({ ok: true, data: { items } });
      }
      case 'run.progress': {
        // 研讨进度（只读）：阶段/轮次/成员状态/预算——「模型说一致」不作为程序共识。
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        const run = deps.db.prepare("SELECT * FROM workflow_runs WHERE task_id = ? AND mode = 'DELIBERATE'").get(params.taskId) as
          | { id: string; stage: string | null; round_no: number | null; status: string; budget_json: string | null }
          | undefined;
        if (run == null) {
          const direct = deps.db.prepare('SELECT stage, status FROM workflow_runs WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(params.taskId) as { stage: string | null; status: string } | undefined;
          return withCommandId({ ok: true, data: { mode: 'DIRECT', stage: direct?.stage ?? null, runStatus: direct?.status ?? null, participants: [], budget: null, issues: [] } });
        }
        const participants = (deps.db.prepare(
          'SELECT rp.member_id, rp.role, rp.status, pm.display_name FROM run_participants rp JOIN project_members pm ON pm.id = rp.member_id WHERE rp.run_id = ? ORDER BY rp.role, rp.member_id',
        ).all(run.id) as Array<{ member_id: string; role: string; status: string; display_name: string }>).map((r) => ({ memberId: r.member_id, displayName: r.display_name, role: r.role, status: r.status }));
        const budget = run.budget_json != null ? JSON.parse(run.budget_json) as { runMaxTurns: number; usedTurns: number } : null;
        const issues = (deps.db.prepare('SELECT id, statement, status FROM issues WHERE run_id = ? ORDER BY id').all(run.id) as Array<{ id: string; statement: string; status: string }>);
        return withCommandId({ ok: true, data: { mode: 'DELIBERATE', stage: run.stage, roundNo: run.round_no, runStatus: run.status, participants, budget, issues } });
      }
      case 'report.get': {
        // 最终报告（只读）：整合稿引用 + 逐结论确认状态（反对/条件/未确认/缺席可见）。
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        const report = deps.db.prepare("SELECT id, blob_path FROM artifacts WHERE task_id = ? AND kind = 'final_report' ORDER BY revision DESC LIMIT 1").get(params.taskId) as { id: string; blob_path: string } | undefined;
        if (report == null) return withCommandId({ ok: true, data: { report: null } });
        const payload = JSON.parse(readFileSync(report.blob_path, 'utf8')) as Record<string, unknown>;
        return withCommandId({ ok: true, data: { report: { artifactId: report.id, ...payload } } });
      }
      case 'dispatch.resume': {
        // 恢复门禁的用户确认（修复轮 5：须显式 confirm:true，不接受空参数直开）。
        z.strictObject({ confirm: z.literal(true) }).parse(env.params);
        const result = run(() => {
          openDispatchGate(deps.db);
          return { gate: 'open' as const };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      case 'task.stop': {
        const params = z.strictObject({ taskId: z.string().min(1), targetRunId: z.string().min(1), expectedStopGeneration: z.number().int().nonnegative() }).parse(env.params);
        // requestStop 内部自包 runCommand（含中断回调在外层执行）——此处不重复包裹。
        const data = await requestStop(deps.db, {
          taskId: params.taskId,
          targetRunId: params.targetRunId,
          expectedStopGeneration: params.expectedStopGeneration,
          commandId: env.commandId,
          idempotencyScope: scope,
          payloadHash,
          now: Date.now(),
          interruptTurn: deps.interruptTurn,
        });
        return withCommandId({ ok: true, data });
      }
      case 'daemon.shutdown': {
        // DEV-15（第十四轮三）：正式关闭动作——IPC 命令驱动（打包产物验证/宿主停机同路径）。
        // 响应=「关闭已调度」；**确认结果=进程退出码与 daemon:stop:last 记录**（关闭本身会断
        // IPC，不在响应里声称完成）。内嵌实例未注入=拒绝（不经命令面伪造进程管理）。
        z.strictObject({}).parse(env.params);
        if (deps.scheduleShutdown == null) {
          throw new DaemonCommandError('CAPABILITY_UNSUPPORTED', '该 daemon 未注入关闭入口（内嵌实例）——由宿主进程管理停止');
        }
        deps.scheduleShutdown();
        return withCommandId({ ok: true, data: { accepted: true, note: '优雅关闭已调度（拒新命令→收拢→关库→退出 0；未收敛→强制→退出 3）——确认以进程退出码与 daemon:stop:last 为准' } });
      }
      case 'task.redispatch': {
        // DIRECT 追加 turn（跟进/格式修复）：经 outbox 正式编排（worker 领取→准入→成员绑定
        // adapter），不绕过产品链路直调 CLI。前置：任务存在、非终态、stop_generation=0、
        // 无在途 turn（防止并发双派）；同 (taskId, 在途) 语义下重复调用幂等拒绝。
        // formatRepair:true=**合同内一次格式修复**（第六轮）：仅当上一 turn FAILED 且存在
        // turn.outputInvalid；每任务至多一次；修复上下文（原输出全文+校验错误）注入下一 turn
        // 输入（组装侧），审计绑定原 turn——不是无反馈的"重跑"。
        const params = z.strictObject({ taskId: z.string().min(1), reason: z.string().min(1).max(200).optional(), formatRepair: z.boolean().optional() }).parse(env.params);
        const result = run(() => {
          const task = deps.db
            .prepare('SELECT id, status, stop_generation FROM tasks WHERE id = ?')
            .get(params.taskId) as { id: string; status: string; stop_generation: number } | undefined;
          if (task == null) throw new DaemonCommandError('RESOURCE_NOT_FOUND', `任务不存在：${params.taskId}`);
          if (['DONE', 'CANCELLED'].includes(task.status)) throw new DaemonCommandError('STALE_REVISION', `任务已终态（${task.status}）：不再追加 turn`);
          if (task.stop_generation > 0) throw new DaemonCommandError('STALE_REVISION', '任务停止已生效：不再追加 turn');
          const inFlight = deps.db
            .prepare(`SELECT count(*) c FROM agent_turns t JOIN workflow_runs r ON r.id = t.run_id
              WHERE t.dispatch_key LIKE 'task:' || ? || ':%' AND t.status NOT IN ('SUCCEEDED','FAILED','CANCELLED','UNKNOWN')`)
            .get(params.taskId) as { c: number };
          if (inFlight.c > 0) throw new DaemonCommandError('WORKER_STILL_RUNNING', `该任务已有在途/未收口 turn（${inFlight.c}）：不得并发追加`);
          // formatRepair 守卫（第七轮：按**根逻辑输出**限制一次——禁止修复套修复）：
          // - 源 turn=任务最后一个 turn 且 FAILED，且**其自身**存在 turn.outputInvalid 事件
          //   （turn_id 绑定——旧轮校验失败不给新轮提供修复资格）；
          // - 根逻辑输出身份：源 turn 是修复轮（consumed_turn_id 指向它的工作项存在）则继承
          //   该工作项的 logical_output_id；否则=源 turn 自身。初始输出与其修复尝试共享
          //   逻辑输出身份——修复失败后不得把修复 turn 当作新的独立输出再修；
          // - 每份逻辑输出最多一次：UNIQUE(task_id, logical_output_id)（迁移 010）——用户
          //   后续正式发起的独立输出有自己的身份与修复资格（不靠生成新 turn ID 获得）；
          // - 被拒的第二次修复不创建工作项/outbox/模型调用（守卫在 INSERT 前抛错回滚）；
          // - 源输出=该 turn 的实际完成输出（thread.replyAdded(turn_id=源) 最后一条消息），
          //   不用任务最后一条消息顶替；输出须为可解析 JSON（resultKey 可绑定）；
          // - 三者一致性在工作项内固化（hash/事件 id/原文），worker 侧复核损坏+授权链。
          if (params.formatRepair === true) {
            // 源 turn=任务最后一个**有效** turn（豁免 refunded——确认未启动退款无逻辑输出，
            // 不挡住更早有效输出的修复资格）且 FAILED，且**其自身**存在 turn.outputInvalid 事件。
            const sourceTurn = deps.db
              .prepare(`SELECT id, status FROM agent_turns WHERE dispatch_key LIKE 'task:' || ? || ':%' AND (budget_mark IS NULL OR budget_mark != 'refunded') ORDER BY rowid DESC LIMIT 1`)
              .get(params.taskId) as { id: string; status: string } | undefined;
            if (sourceTurn == null || sourceTurn.status !== 'FAILED') {
              throw new DaemonCommandError('STALE_REVISION', `格式修复仅适用于最后一个 turn FAILED（实际：${sourceTurn?.status ?? '无 turn'}）`);
            }
            const inherited = deps.db
              .prepare(`SELECT logical_output_id FROM format_repair_workitems WHERE consumed_turn_id = ?`)
              .get(sourceTurn.id) as { logical_output_id: string } | undefined;
            const logicalOutputId = inherited?.logical_output_id ?? sourceTurn.id;
            const existing = deps.db
              .prepare(`SELECT id, status FROM format_repair_workitems WHERE task_id = ? AND logical_output_id = ?`)
              .get(params.taskId, logicalOutputId) as { id: string; status: string } | undefined;
            if (existing != null) {
              throw new DaemonCommandError('STALE_REVISION', `该逻辑输出（${logicalOutputId}）已用过修复资格（工作项 ${existing.id}，${existing.status}）——修复尝试与初始输出共享身份，不得修复套修复`);
            }
            const invalid = deps.db
              .prepare(`SELECT event_id, payload_json FROM domain_events WHERE kind = 'turn.outputInvalid' AND turn_id = ? ORDER BY seq DESC LIMIT 1`)
              .get(sourceTurn.id) as { event_id: string; payload_json: string } | undefined;
            if (invalid == null) throw new DaemonCommandError('STALE_REVISION', '源 turn 无自身 outputInvalid 事件：不构成格式修复条件（provider 失败等不适用）');
            const replyEvt = deps.db
              .prepare(`SELECT payload_json FROM domain_events WHERE kind = 'thread.replyAdded' AND turn_id = ? ORDER BY seq DESC LIMIT 1`)
              .get(sourceTurn.id) as { payload_json: string } | undefined;
            if (replyEvt == null) throw new DaemonCommandError('STALE_REVISION', '源 turn 无完成输出消息（不能以任务级最后消息顶替）');
            const messageId = (JSON.parse(replyEvt.payload_json) as { messageId: string }).messageId;
            const msg = deps.db.prepare('SELECT body_json FROM messages WHERE id = ?').get(messageId) as { body_json: string } | undefined;
            if (msg == null) throw new DaemonCommandError('STALE_REVISION', `源输出消息缺失：${messageId}`);
            const outputText = (JSON.parse(msg.body_json) as { text?: string }).text ?? '';
            // 源逻辑输出 resultKey=确定性约定 result_<turnId>（与该 turn 的 run.created 审计
            // payload.resultKey 核对一致）——散文类失败同样可修复（原文全文入上下文）。
            const sourceResultKey = `result_${sourceTurn.id}`;
            const runCreated = deps.db
              .prepare(`SELECT count(*) c FROM domain_events WHERE kind = 'run.created' AND turn_id = ? AND payload_json LIKE ?`)
              .get(sourceTurn.id, `%${sourceResultKey}%`) as { c: number };
            if (runCreated.c < 1) throw new DaemonCommandError('STALE_REVISION', `源 turn 的 run.created 审计与 ${sourceResultKey} 不一致：绑定失败`);
            const lastRun = deps.db.prepare('SELECT id FROM workflow_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1').get(params.taskId) as { id: string } | undefined;
            const now2 = Date.now();
            deps.db.prepare(
              `INSERT INTO format_repair_workitems
                 (id, task_id, source_turn_id, source_result_key, logical_output_id, invalid_event_id,
                  source_output_hash, source_output_text, invalid_issues_json, target_dispatch_key,
                  budget_run_id, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            ).run(
              `frw_${randomUUID()}`, params.taskId, sourceTurn.id, sourceResultKey, logicalOutputId, invalid.event_id,
              createHash('sha256').update(outputText, 'utf8').digest('hex'), outputText,
              JSON.stringify((JSON.parse(invalid.payload_json) as { issues: string[] }).issues),
              `task:${params.taskId}:repair:${sourceTurn.id}`, lastRun?.id ?? 'none', now2, now2,
            );
          }
          const dispatchKey = params.formatRepair === true
            ? `task:${params.taskId}:repair:${(deps.db.prepare(`SELECT source_turn_id FROM format_repair_workitems WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`).get(params.taskId) as { source_turn_id: string }).source_turn_id}` // 按逻辑输出版本化——同任务多轮修复不撞唯一键
            : `task:${params.taskId}:redispatch`;
          const already = deps.db
            .prepare(`SELECT count(*) c FROM outbox WHERE dispatch_key = ? AND status != 'done'`)
            .get(dispatchKey) as { c: number };
          if (already.c > 0) throw new DaemonCommandError('IDEMPOTENCY_CONFLICT', 'redispatch 已在队列：不重复入队');
          deps.db.prepare('INSERT INTO outbox (dispatch_key) VALUES (?)').run(dispatchKey);
          appendDomainEvent(deps.db, {
            schemaVersion: 1,
            eventId: `evt_${randomUUID()}`,
            projectId: (deps.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(params.taskId) as { project_id: string }).project_id,
            taskId: params.taskId,
            kind: 'task.redispatchEnqueued',
            createdAt: Date.now(),
            payload: { reason: params.reason ?? 'manual-redispatch', formatRepair: params.formatRepair === true },
          });
          return { enqueued: true as const, dispatchKey, formatRepair: params.formatRepair === true };
        });
        return withCommandId({ ok: true, data: result.data, replayed: result.replayed });
      }
      default:
        return withCommandId({ ok: false, error: { code: 'VALIDATION_INVALID', message: `未知命令：${env.method}`, retryable: false } });
    }
  } catch (error) {
    if (error instanceof DaemonCommandError) {
      return withCommandId({ ok: false, error: { code: error.code, message: error.message, retryable: false } });
    }
    if (error instanceof z.ZodError) {
      return withCommandId({ ok: false, error: { code: 'VALIDATION_INVALID', message: error.issues[0]?.message ?? '参数无效', retryable: false } });
    }
    // 不吞异常假装成功（§16.5）。
    return withCommandId({ ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: false } });
  }
}
