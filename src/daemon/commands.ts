/**
 * daemon 命令面（DEV-07）：命名管道上的统一业务入口。
 * - CommandEnvelope strict 校验 + 本地 UI CallerContext（可信身份，无连接 ID）。
 * - 命令：project.open（打开/去重/引导默认房间与成员）、message.submit（路由→单事务落库→入 outbox）、
 *   events.list（增量读取）、dispatch.resume（恢复门禁的用户确认）、task.stop。
 * - 幂等经 runCommand（command_receipts 同事务）；错误映射 CommandResult.error，不吞异常。
 */
import { randomUUID } from 'node:crypto';
import type { ZhongshuoDatabase } from '../persistence/db.ts';
import { runCommand } from '../persistence/commandGateway.ts';
import { createRoomRootTask } from '../persistence/stores/roomRootTask.ts';
import { openProject } from './projectStore.ts';
import { resolveTopLevelRoute } from '../domain/routing/topLevelRoute.ts';
import type { TopLevelRouteOutcome } from '../contracts/routing.ts';
import type { MentionNode } from '../contracts/routing.ts';
import { commandEnvelopeSchema } from '../contracts/commands.ts';
import { computeCommandPayloadHash } from '../domain/idempotency.ts';
import { requestStop } from './stopFlow.ts';
import { listEvents } from '../persistence/events.ts';
import { z } from 'zod';

export interface DaemonCommandDeps {
  db: ZhongshuoDatabase;
  localUserId: string;
  interruptTurn: (turnId: string) => Promise<void>;
}

const localScope = (userId: string): string => `user:${userId}`;

/** 引导默认房间/会话/成员（project.open 幂等副作用；仅缺失时创建）。 */
function bootstrapProject(db: ZhongshuoDatabase, projectId: string): void {
  const memberCount = (db.prepare('SELECT count(*) c FROM project_members WHERE project_id = ?').get(projectId) as { c: number }).c;
  if (memberCount === 0) {
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES (?, ?, '执行成员', 'agent', 1)`)
      .run(`m_default_${projectId}`, projectId);
  }
  const roomCount = (db.prepare('SELECT count(*) c FROM rooms WHERE project_id = ?').get(projectId) as { c: number }).c;
  if (roomCount === 0) {
    const defaultMember = (db.prepare('SELECT id FROM project_members WHERE project_id = ? ORDER BY id LIMIT 1').get(projectId) as { id: string }).id;
    db.prepare(`INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES (?, ?, '默认房间', ?)`)
      .run(`room_default_${projectId}`, projectId, defaultMember);
  }
  const convCount = (db.prepare('SELECT count(*) c FROM conversations WHERE room_id = ?').get(`room_default_${projectId}`) as { c: number }).c;
  if (convCount === 0) {
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES (?, ?, 'room', ?)`)
      .run(`conv_default_${projectId}`, projectId, `room_default_${projectId}`);
  }
}

const messageSubmitParams = z.strictObject({
  target: z.strictObject({
    kind: z.literal('room_root'),
    projectId: z.string().min(1),
    conversationId: z.string().min(1),
    roomId: z.string().min(1),
  }),
  body: z.string().min(1),
  intent: z.enum(['default', 'record_only']),
  mentions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('member'), memberId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('all') }),
  ])),
});

export async function dispatchDaemonCommand(deps: DaemonCommandDeps, envelope: unknown): Promise<unknown> {
  const parsedEnvelope = commandEnvelopeSchema(z.unknown()).safeParse(envelope);
  if (!parsedEnvelope.success) {
    return { ok: false, error: { code: 'VALIDATION_INVALID', message: `信封校验失败：${parsedEnvelope.error.issues[0]?.message}`, retryable: false } };
  }
  const env = parsedEnvelope.data;
  const payloadHash = computeCommandPayloadHash({ method: env.method, target: null, params: env.params, expectedRevision: env.expectedRevision ?? null });
  const scope = localScope(deps.localUserId);
  // runCommand 为同步事务：handler 必须同步返回（异步命令自行包 runCommand，见 task.stop）。
  const run = <T>(handler: () => T): { data: T; replayed: boolean } => {
    const outcome = runCommand<T>(deps.db, { idempotencyScope: scope, commandId: env.commandId, payloadHash, now: Date.now() }, handler);
    if (!outcome.ok) throw new DaemonCommandError(outcome.error.code, outcome.error.message);
    return { data: outcome.data, replayed: outcome.replayed };
  };

  try {
    switch (env.method) {
      case 'project.open': {
        const params = z.strictObject({ path: z.string().min(1), displayName: z.string().optional() }).parse(env.params);
        const result = run(() => {
          const opened = openProject(deps.db, { rootPath: params.path, displayName: params.displayName, now: Date.now() });
          if (!opened.ok) throw new DaemonCommandError(opened.error.code, opened.error.message);
          bootstrapProject(deps.db, opened.value.project.id);
          return { project: opened.value.project, created: opened.value.created };
        });
        return { ok: true, commandId: env.commandId, data: result.data, replayed: result.replayed };
      }
      case 'message.submit': {
        const params = messageSubmitParams.parse(env.params);
        const result = run(() => {
          const route = resolveTopLevelRoute({
            intent: params.intent,
            mentions: params.mentions as MentionNode[],
            room: {
              coordinatorMemberId: coordinatorOf(deps.db, params.target.roomId),
              enabledAgentMemberIds: enabledAgents(deps.db, params.target.roomId),
            },
          });
          if (!route.ok) throw new DaemonCommandError(route.error.code, route.error.message);
          const outcome = deps.db.transaction(() => {
            const ids = {
              messageId: `msg_${randomUUID()}`,
              threadId: `thread_${randomUUID()}`,
              taskId: `task_${randomUUID()}`,
              taskEventId: `evt_${randomUUID()}`,
              threadEventId: `evt_${randomUUID()}`,
            };
            const created = createRoomRootTask(deps.db, {
              ids,
              projectId: params.target.projectId,
              conversationId: params.target.conversationId,
              roomId: params.target.roomId,
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
          return outcome;
        });
        return { ok: true, commandId: env.commandId, data: result.data, replayed: result.replayed };
      }
      case 'events.list': {
        const params = z.strictObject({ projectId: z.string().min(1), afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(200).optional() }).parse(env.params);
        const items = listEvents(deps.db, params.projectId, params.afterSeq ?? 0, params.limit ?? 100);
        return { ok: true, commandId: env.commandId, data: { items, hasMore: items.length >= (params.limit ?? 100) } };
      }
      case 'dispatch.resume': {
        // 恢复门禁的用户确认（§16.4-6：恢复后先列出可继续任务，确认才开放调度）。
        const { openDispatchGate } = await import('../persistence/daemonState.ts');
        openDispatchGate(deps.db);
        return { ok: true, commandId: env.commandId, data: { gate: 'open' } };
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
        return { ok: true, commandId: env.commandId, data };
      }
      default:
        return { ok: false, error: { code: 'VALIDATION_INVALID', message: `未知命令：${env.method}`, retryable: false } };
    }
  } catch (error) {
    if (error instanceof DaemonCommandError) {
      return { ok: false, error: { code: error.code, message: error.message, retryable: false } };
    }
    if (error instanceof z.ZodError) {
      return { ok: false, error: { code: 'VALIDATION_INVALID', message: error.issues[0]?.message ?? '参数无效', retryable: false } };
    }
    // 不吞异常假装成功（§16.5）。
    return { ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}

export class DaemonCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DaemonCommandError';
    this.code = code;
  }
}

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
