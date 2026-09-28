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
import { z } from 'zod';

export interface DaemonCommandDeps {
  db: ZhongshuoDatabase;
  localUserId: string;
  interruptTurn: (turnId: string) => Promise<void>;
  /** 应用数据目录（changeset.* 的受管理内容存储位置；entry 注入）。 */
  appDataDir?: string;
}

export class DaemonCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DaemonCommandError';
    this.code = code;
  }
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
        const { isDispatchGateHeld } = await import('../persistence/daemonState.ts');
        const held = isDispatchGateHeld(deps.db);
        const pending = deps.db.prepare(`SELECT dispatch_key FROM outbox WHERE status = 'pending'`).all() as Array<{ dispatch_key: string }>;
        const interrupted = deps.db.prepare(`SELECT id, task_id, status FROM workflow_runs WHERE status IN ('INTERRUPTED')`).all() as Array<{ id: string; task_id: string; status: string }>;
        return withCommandId({
          ok: true,
          data: {
            gateHeld: held,
            pendingDispatchCount: pending.length,
            pendingDispatchKeys: pending.map((p) => p.dispatch_key),
            interruptedRuns: interrupted,
          },
        });
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
