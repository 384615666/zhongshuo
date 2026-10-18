/**
 * 主池根消息单事务写入路径（§3.4/§12.3）：RootMessage + ConversationThread + 根 Task
 * 预分配 ID、单事务创建；record_only 只建消息与记录串（root_task_id NULL），零任务零派发。
 * 该函数只管持久化形态；路由判定（mode/名单）由 domain 层先行完成并作为 route 传入。
 */
import type { ZhongshuoDatabase } from '../db.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';
import type { TopLevelRouteOutcome, MentionNode, SendIntent } from '../../contracts/routing.ts';
import type { DispatchDisposition } from '../../contracts/conversation.ts';
import { appendDomainEvent } from '../events.ts';
import { enqueueOutbox, stopGenerationOfTask } from '../outbox.ts';

export interface CreateRoomRootTaskInput {
  ids: { messageId: string; threadId: string; taskId: string; taskEventId: string; threadEventId: string };
  projectId: string;
  conversationId: string;
  roomId: string;
  intent: SendIntent;
  title: string;
  body: string;
  mentions: readonly MentionNode[];
  author: { authorType: 'human' | 'agent' | 'system' | 'third_party_app'; authorId: string; viaConnectionId?: string | null };
  /** 创建时快照（§10.5）：project.taskReviewEnabled → Task.reviewPolicy。 */
  reviewPolicy: 'auto_deliver' | 'user_review';
  /** 任务链来源（§31.8）：本机根任务 null；外部连接发起记录连接。 */
  sourceConnectionId: string | null;
  /** 路由判定结果（resolveTopLevelRoute 的成功值）。 */
  route: TopLevelRouteOutcome;
  now: number;
}

export interface CreateRoomRootTaskResult {
  messageId: string;
  conversationId: string;
  threadId: string;
  conversationSeq: number;
  taskId: string | null;
  roomTaskNumber: number | null;
  disposition: DispatchDisposition;
}

/** 初始接单成员：AUTO=协调者；DIRECT=指定成员；DELIBERATE=名单首位（多轮派发由后续调度扩展）。 */
function initialOwnerOf(route: TopLevelRouteOutcome & { kind: 'dispatch' }): string | null {
  switch (route.mode) {
    case 'AUTO':
      return route.coordinatorMemberId;
    case 'DIRECT':
      return route.targetMemberId;
    case 'DELIBERATE':
      return route.frozenMemberIds[0] ?? null;
  }
}

/**
 * 单事务步骤：会话校验 → 分配 conversation_seq → 写 anchor 消息 → 写 thread
 * （root_task_id 先空）→ 需要时写根任务并回填 thread.root_task_id → 追加事件 →
 * dispatch 路由时入 outbox。
 */
export function createRoomRootTask(
  db: ZhongshuoDatabase,
  input: CreateRoomRootTaskInput,
): DomainResult<CreateRoomRootTaskResult> {
  const conversation = db
    .prepare('SELECT project_id, kind, room_id, archived_at FROM conversations WHERE id = ?')
    .get(input.conversationId) as
    | { project_id: string; kind: string; room_id: string | null; archived_at: number | null }
    | undefined;
  if (conversation == null || conversation.project_id !== input.projectId) {
    return domainErr('RESOURCE_NOT_FOUND', '目标会话不存在');
  }
  if (conversation.kind !== 'room' || conversation.room_id !== input.roomId) {
    return domainErr('CONVERSATION_SCOPE_MISMATCH', 'room_root 目标必须是匹配的房间会话');
  }
  if (conversation.archived_at != null) {
    return domainErr('ROOM_ARCHIVED', '房间已归档，不能新增任务');
  }

  // conversation_seq 由服务端事务分配（开工契约 §2.2）。
  const seqInfo = db
    .prepare(
      'UPDATE conversations SET last_message_seq = last_message_seq + 1 WHERE id = ? RETURNING last_message_seq',
    )
    .get(input.conversationId) as { last_message_seq: number };
  const conversationSeq = seqInfo.last_message_seq;

  db.prepare(
    `INSERT INTO messages
       (id, project_id, conversation_id, conversation_seq, room_id, thread_id, task_id,
        reply_to_message_id, thread_message_seq, author_type, author_id, via_connection_id,
        body_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 'saved', ?)`,
  ).run(
    input.ids.messageId,
    input.projectId,
    input.conversationId,
    conversationSeq,
    input.roomId,
    input.author.authorType,
    input.author.authorId,
    input.author.viaConnectionId ?? null,
    JSON.stringify({ text: input.body, mentions: input.mentions }),
    input.now,
  );

  const isRecordOnly = input.route.kind === 'record_only';

  // thread 先建（root_task_id 空以满足 FK 顺序），任务插入后回填。
  db.prepare(
    `INSERT INTO conversation_threads
       (id, project_id, conversation_id, room_id, anchor_message_id, root_task_id, status, last_message_seq, revision)
     VALUES (?, ?, ?, ?, ?, NULL, 'open', 0, 0)`,
  ).run(input.ids.threadId, input.projectId, input.conversationId, input.roomId, input.ids.messageId);

  appendDomainEvent(db, {
    schemaVersion: 1,
    eventId: input.ids.threadEventId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    threadId: input.ids.threadId,
    kind: 'thread.created',
    createdAt: input.now,
    payload: { anchorMessageId: input.ids.messageId, recordOnly: isRecordOnly },
  });

  let taskId: string | null = null;
  let roomTaskNumber: number | null = null;
  let disposition: DispatchDisposition = 'none';

  if (!isRecordOnly && input.route.kind === 'dispatch') {
    // 房间任务号：同房间单调分配（daemon 单写者下事务安全）。
    const numRow = db
      .prepare(
        'SELECT COALESCE(MAX(room_task_number), 0) + 1 AS n FROM tasks WHERE room_id = ?',
      )
      .get(input.roomId) as { n: number };
    roomTaskNumber = numRow.n;
    taskId = input.ids.taskId;

    db.prepare(
      `INSERT INTO tasks
         (id, project_id, conversation_id, kind, room_id, conversation_thread_id, root_message_id,
          room_task_number, owner_member_id, source_connection_id, title, status, revision, review_policy,
          route_json, stop_generation)
       VALUES (?, ?, ?, 'room_task', ?, ?, ?, ?, ?, ?, ?, 'OPEN', 0, ?, ?, 0)`,
    ).run(
      taskId,
      input.projectId,
      input.conversationId,
      input.roomId,
      input.ids.threadId,
      input.ids.messageId,
      roomTaskNumber,
      input.route.kind === 'dispatch' ? initialOwnerOf(input.route) : null,
      input.sourceConnectionId,
      input.title,
      input.reviewPolicy,
      input.route.kind === 'dispatch' ? JSON.stringify(input.route) : null,
    );
    db.prepare('UPDATE conversation_threads SET root_task_id = ? WHERE id = ?').run(
      taskId,
      input.ids.threadId,
    );

    appendDomainEvent(db, {
      schemaVersion: 1,
      eventId: input.ids.taskEventId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      threadId: input.ids.threadId,
      taskId,
      kind: 'task.created',
      createdAt: input.now,
      payload: { mode: input.route.mode, rootMessageId: input.ids.messageId },
    });

    // Explicit multi-recipient messages seed one formal child task per selected member
    // in the same transaction. The parent is a container, not another hidden responder.
    const explicitGroup = input.route.mode === 'AUTO'
      && input.route.participantScope === 'selected'
      && input.route.frozenMemberIds.length > 1;
    if (!explicitGroup) {
      // 初始派发：outbox 与任务创建同事务（§11.2）。
      enqueueOutbox(db, { dispatchKey: `task:${taskId}:initial`, stopGenerationAtEnqueue: stopGenerationOfTask(db, taskId) }); // 意图入队代次（迁移 034）
    }
    disposition = 'queued';
  }

  return domainOk({
    messageId: input.ids.messageId,
    conversationId: input.conversationId,
    threadId: input.ids.threadId,
    conversationSeq,
    taskId,
    roomTaskNumber,
    disposition,
  });
}
