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
import { readFileSync } from 'node:fs';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { runCommand } from '../persistence/commandGateway.ts';
import { createRoomRootTask } from '../persistence/stores/roomRootTask.ts';
import { openProject } from './projectStore.ts';
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
import { getProbe as getProbeRecord, getTurnProcessRegistration, probeTurnExit, type ProbeOutcome } from './processRegistry.ts';

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
    releasedLeases?: string[];
  }>;
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
  return probeTurnExit(deps.db, turnId, deps.processQuery ?? ((pid: number) => checkProcessLiveness(pid)), { createdBy: 'reconcile', treeScan: deps.processTree });
}

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
  ]),
  body: z.string().min(1),
  intent: z.enum(['default', 'record_only']),
  mentions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member'), memberId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('all') }),
  ])),
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
        return withCommandId({ ok: true, data: { items: rows.reverse().map((r) => ({ id: r.id, authorType: r.author_type, authorId: r.author_id, seq: r.thread_message_seq, body: JSON.parse(r.body_json) as { text: string }, createdAt: r.created_at })) } });
      }
      case 'task.get': {
        const params = z.strictObject({ taskId: z.string().min(1) }).parse(env.params);
        const task = deps.db.prepare('SELECT id, title, status, room_id, conversation_thread_id, room_task_number, revision, stop_generation FROM tasks WHERE id = ?').get(params.taskId) as Record<string, unknown> | undefined;
        if (task == null) return withCommandId({ ok: false, error: { code: 'RESOURCE_NOT_FOUND', message: '任务不存在', retryable: false } });
        const activeRun = deps.db.prepare('SELECT id, status FROM workflow_runs WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(params.taskId) as { id: string; status: string } | undefined;
        return withCommandId({ ok: true, data: { task: { ...task, stopGeneration: task.stop_generation }, activeRun: activeRun ?? null } });
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
                return insertThreadMessage(deps.db, {
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
              }
              // 任务串：M0 阶段人类跟进先落消息并标记待处理（task.steer 的完整调度
              // 由 DEV-08/09 扩展；此处持久化目标+内容，不新建根任务、不假装已派发）。
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
              return { ...message, disposition: 'none' as const, taskId: thread.root_task_id, followUpRecorded: true };
            })();
          }
          const target = params.target;
          if (target.kind !== 'room_root') throw new DaemonCommandError('VALIDATION_INVALID', '路由目标缺失');
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
        const probe = probeTurnExit(deps.db, params.turnId, deps.processQuery ?? ((pid: number) => checkProcessLiveness(pid)), { createdBy: 'probe', treeScan: deps.processTree });
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
              if (p.result === 'exited') {
                // 退出事实=服务端 OS 证据确认退出：释放租约；成果事实=无已入库产物（不伪造成功，
                // 也不臆断业务失败——FAILED 仅记录「执行过且无可入库成果」这一证据内事实）。
                releasedLeases = releaseLeases();
                deps.db.prepare(`UPDATE agent_turns SET status = 'FAILED' WHERE id = ?`).run(turn.id);
                turnFinalStatus = 'FAILED'; reason = `executed-exited-${p.processModel}`;
                emit({ verdict: 'executed', exitFact: 'exited', probe: { probeId: p.probeId, result: p.result, processModel: p.processModel, pid: p.pid, observedAt: p.observedAt, detail: p.detail }, releasedLeases, turnFinalStatus, reason });
              } else if (p.result === 'no-os-process') {
                // 无子进程模型（程序事实）：无 OS 遗留进程可能——释放保护。
                releasedLeases = releaseLeases();
                deps.db.prepare(`UPDATE agent_turns SET status = 'FAILED' WHERE id = ?`).run(turn.id);
                turnFinalStatus = 'FAILED'; reason = 'executed-no-os-process';
                emit({ verdict: 'executed', exitFact: 'no-os-process', probe: { probeId: p.probeId, result: p.result, detail: p.detail }, releasedLeases, turnFinalStatus, reason });
              } else {
                // 仍存活/退出未知/身份缺失/复用：结算预算但**保留租约与准入占位**、turn 保持
                // UNKNOWN——不提前放行（后续取得退出证据再对账；budget_mark 已防重复结算）。
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
          if (probe.result !== 'exited' && probe.result !== 'no-os-process') {
            // 进程仍活/无法确认：拒绝释放——保护保留（如实记录拒绝原因，不改任何状态）。
            emit({ released: false, reason: `release-denied-${probe.result}`, protectionRetained: true });
            throw new DaemonCommandError('STALE_REVISION', `服务端取证未确认执行已结束（${probe.result}：${probe.detail}）——保护保留，不得释放`);
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
        const params = z.strictObject({ changeSetId: z.string().min(1) }).parse(env.params);
        if (deps.appDataDir == null) throw new DaemonCommandError('STORAGE_UNAVAILABLE', 'daemon 未配置 appDataDir（内容前像存储不可用）');
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
          const lastReply = deps.db.prepare('SELECT created_at FROM messages WHERE thread_id = ? ORDER BY thread_message_seq DESC LIMIT 1').get(t.id) as { created_at: number } | undefined;
          items.push({
            threadId: t.id,
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
