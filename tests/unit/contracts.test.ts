import { describe, expect, it } from 'vitest';
import {
  conversationSchema,
  messageTargetSchema,
  conversationCreateParamsSchema,
} from '../../src/contracts/conversation.ts';
import {
  conversationThreadSchema,
} from '../../src/contracts/thread.ts';
import { messageBodyJsonSchema, messageSchema } from '../../src/contracts/message.ts';
import { validateMessageConversationBinding } from '../../src/domain/routing/messageBinding.ts';
import { taskSchema, taskDeliverySchema, taskDeliveryReviewParamsSchema } from '../../src/contracts/task.ts';
import { workflowRunSchema } from '../../src/contracts/run.ts';
import { navigationPreferencesSchema } from '../../src/contracts/project.ts';
import { callerContextSchema } from '../../src/contracts/caller.ts';
import { commandReceiptSchema } from '../../src/contracts/commands.ts';
import {
  roomListParamsSchema,
  memberListParamsSchema,
  eventsListParamsSchema,
  taskGetParamsSchema,
} from '../../src/contracts/queries.ts';

describe('会话（开工契约 §2.2）', () => {
  it('room 会话必须携带 roomId', () => {
    expect(
      conversationSchema.safeParse({
        id: 'c1', projectId: 'p1', kind: 'room', revision: 0, lastMessageSeq: 0,
      }).success,
    ).toBe(false);
  });

  it('dm 会话 roomId 必须为空', () => {
    expect(
      conversationSchema.safeParse({
        id: 'c1', projectId: 'p1', kind: 'dm', roomId: 'room_1', revision: 0, lastMessageSeq: 0,
      }).success,
    ).toBe(false);
    expect(
      conversationSchema.safeParse({
        id: 'c1', projectId: 'p1', kind: 'dm', roomId: null, revision: 0, lastMessageSeq: 0,
      }).success,
    ).toBe(true);
  });
});

describe('MessageTarget 判别联合', () => {
  it('三种目标各自成立', () => {
    expect(messageTargetSchema.safeParse({ kind: 'room_root', projectId: 'p', conversationId: 'c', roomId: 'r' }).success).toBe(true);
    expect(messageTargetSchema.safeParse({ kind: 'thread', projectId: 'p', conversationId: 'c', threadId: 't' }).success).toBe(true);
    expect(messageTargetSchema.safeParse({ kind: 'dm', projectId: 'p', conversationId: 'c' }).success).toBe(true);
  });

  it('缺判别字段/未知 kind/同时携带两种目标字段 → 拒绝', () => {
    expect(messageTargetSchema.safeParse({ kind: 'thread', projectId: 'p', conversationId: 'c' }).success).toBe(false);
    expect(messageTargetSchema.safeParse({ kind: 'room_root_and_thread', projectId: 'p' }).success).toBe(false);
    expect(
      messageTargetSchema.safeParse({
        kind: 'dm', projectId: 'p', conversationId: 'c', threadId: 't',
      }).success,
    ).toBe(false);
  });

  it('conversation.create：kind 只接受 dm（房间会话随 room 创建，不手工建）', () => {
    expect(
      conversationCreateParamsSchema.safeParse({
        projectId: 'p1', kind: 'dm', peerMemberId: 'm1', commandId: 'cmd-12345678',
      }).success,
    ).toBe(true);
    expect(
      conversationCreateParamsSchema.safeParse({
        projectId: 'p1', kind: 'room', peerMemberId: 'm1', commandId: 'cmd-12345678',
      }).success,
    ).toBe(false);
  });
});

describe('消息空值约束（§12.2 + 开工契约 §2.2）', () => {
  const base = {
    id: 'msg1', projectId: 'p1', conversationId: 'c1', conversationSeq: 1,
    authorType: 'human', authorId: 'u1', bodyJson: { text: 'hi' },
    status: 'saved', createdAt: 0,
  } as const;

  it('DM 消息（无 room/thread/线程序号）通过基础 schema', () => {
    expect(messageSchema.safeParse(base).success).toBe(true);
  });

  it('DM 消息绑定校验：room/thread/线程序号均空（跨实体约束走 domain）', () => {
    // DM 消息不得携带 roomId/threadId/threadMessageSeq（开工契约 §2.2）
    expect(
      validateMessageConversationBinding(
        { conversationId: 'c_dm_1' },
        { id: 'c_dm_1', kind: 'dm', roomId: null },
      ).ok,
    ).toBe(true);
    expect(
      validateMessageConversationBinding(
        { conversationId: 'c_dm_1', roomId: 'r1' },
        { id: 'c_dm_1', kind: 'dm', roomId: null },
      ),
    ).toMatchObject({ ok: false, error: { code: 'CONVERSATION_SCOPE_MISMATCH' } });
    expect(
      validateMessageConversationBinding(
        { conversationId: 'c_dm_1', threadId: 't1', threadMessageSeq: 1 },
        { id: 'c_dm_1', kind: 'dm', roomId: null },
      ),
    ).toMatchObject({ ok: false, error: { code: 'CONVERSATION_SCOPE_MISMATCH' } });
    // 房间消息必须携带所属会话 roomId 且一致
    expect(
      validateMessageConversationBinding(
        { conversationId: 'c_room_1', roomId: 'room_1' },
        { id: 'c_room_1', kind: 'room', roomId: 'room_1' },
      ).ok,
    ).toBe(true);
    expect(
      validateMessageConversationBinding(
        { conversationId: 'c_room_1', roomId: 'room_other' },
        { id: 'c_room_1', kind: 'room', roomId: 'room_1' },
      ).ok,
    ).toBe(false);
  });

  it('anchor 与串内回复的 thread_id/thread_message_seq 同生同灭', () => {
    expect(
      messageSchema.safeParse({ ...base, threadId: 't1', threadMessageSeq: null }).success,
    ).toBe(false);
    expect(
      messageSchema.safeParse({
        ...base, roomId: 'r1', threadId: 't1', threadMessageSeq: 1,
      }).success,
    ).toBe(true);
  });

  it('via_connection_id 仅 author_type=human 可用（代发标记）', () => {
    expect(
      messageSchema.safeParse({ ...base, viaConnectionId: 'conn_1' }).success,
    ).toBe(true);
    expect(
      messageSchema.safeParse({
        ...base, authorType: 'agent', viaConnectionId: 'conn_1',
      }).success,
    ).toBe(false);
  });

  it('bodyJson 内 mention 节点结构合法', () => {
    expect(
      messageBodyJsonSchema.safeParse({ text: 'x', mentions: [{ kind: 'all' }] }).success,
    ).toBe(true);
    expect(
      messageBodyJsonSchema.safeParse({ text: 'x', mentions: [{ kind: 'everyone' }] }).success,
    ).toBe(false);
  });
});

describe('线程（§12.2：DM 不伪造 thread）', () => {
  it('thread 必须携带 roomId（仅房间会话创建）', () => {
    const t = {
      id: 't1', projectId: 'p1', conversationId: 'c_room', roomId: 'room_1',
      anchorMessageId: 'msg1', rootTaskId: null, status: 'open', lastMessageSeq: 0, revision: 0,
    };
    expect(conversationThreadSchema.safeParse(t).success).toBe(true);
    expect(conversationThreadSchema.safeParse({ ...t, roomId: '' }).success).toBe(false);
  });
});

describe('任务（开工契约 §2.2 dm_turn 空值约束）', () => {
  const roomTask = {
    id: 'task1', projectId: 'p1', kind: 'room_task', conversationId: 'c_room',
    roomId: 'room_1', conversationThreadId: 't1', rootMessageId: 'msg1', roomTaskNumber: 1,
    title: 'x', status: 'OPEN', revision: 0, reviewPolicy: 'auto_deliver',
  };
  const dmTurn = {
    id: 'task2', projectId: 'p1', kind: 'dm_turn', conversationId: 'c_dm',
    rootMessageId: 'msg_dm_1', title: 'dm turn', status: 'ACTIVE', revision: 0,
    reviewPolicy: 'auto_deliver',
  };

  it('room_task 与 dm_turn 各自合法', () => {
    expect(taskSchema.safeParse(roomTask).success).toBe(true);
    expect(taskSchema.safeParse(dmTurn).success).toBe(true);
  });

  it('dm_turn 带 roomId/房间任务号 → 拒绝', () => {
    expect(taskSchema.safeParse({ ...dmTurn, roomId: 'room_1' }).success).toBe(false);
    expect(taskSchema.safeParse({ ...dmTurn, roomTaskNumber: 7 }).success).toBe(false);
    expect(taskSchema.safeParse({ ...dmTurn, conversationThreadId: 't1' }).success).toBe(false);
  });
});

describe('交付与验收（§10.5）', () => {
  const delivery = {
    id: 'd1', taskId: 'task1', revision: 1, manifestHash: 'h1',
    artifactRefs: [], changeSetRefs: [], verificationRefs: [],
    reviewStatus: 'not_required',
  };

  it('not_required 不携带人工记录（不伪造人工通过）', () => {
    expect(taskDeliverySchema.safeParse(delivery).success).toBe(true);
    expect(
      taskDeliverySchema.safeParse({ ...delivery, reviewedBy: 'u1', reviewedAt: 1 }).success,
    ).toBe(false);
  });

  it('accepted 必须有人工记录', () => {
    expect(
      taskDeliverySchema.safeParse({ ...delivery, reviewStatus: 'accepted' }).success,
    ).toBe(false);
    expect(
      taskDeliverySchema.safeParse({
        ...delivery, reviewStatus: 'accepted', reviewedBy: 'u1', reviewedAt: 1,
      }).success,
    ).toBe(true);
  });

  it('request_changes 必填意见', () => {
    expect(
      taskDeliveryReviewParamsSchema.safeParse({
        taskId: 't', deliveryId: 'd', expectedRevision: 1, manifestHash: 'h',
        decision: 'request_changes',
      }).success,
    ).toBe(false);
    expect(
      taskDeliveryReviewParamsSchema.safeParse({
        taskId: 't', deliveryId: 'd', expectedRevision: 1, manifestHash: 'h',
        decision: 'request_changes', note: '请补充验证',
      }).success,
    ).toBe(true);
  });
});

describe('WorkflowRun（DM 内部 run：thread 空、mode=DIRECT）', () => {
  it('dm run 合法：threadId 空 + DIRECT', () => {
    expect(
      workflowRunSchema.safeParse({
        id: 'run1', taskId: 'task2', conversationId: 'c_dm', threadId: null,
        mode: 'DIRECT', taskRevision: 0, status: 'QUEUED', revision: 0,
      }).success,
    ).toBe(true);
  });
});

describe('导航偏好（§17.7）', () => {
  it('当前项目必须包含在可见集合中', () => {
    expect(
      navigationPreferencesSchema.safeParse({
        viewerId: 'u', clientId: 'c', visibleProjectIds: ['p1'],
        activeProjectId: 'p1', expandedProjectIds: [], revision: 0,
      }).success,
    ).toBe(true);
    expect(
      navigationPreferencesSchema.safeParse({
        viewerId: 'u', clientId: 'c', visibleProjectIds: ['p2'],
        activeProjectId: 'p1', expandedProjectIds: [], revision: 0,
      }).success,
    ).toBe(false);
  });

  it('visibleProjectIds 去重', () => {
    expect(
      navigationPreferencesSchema.safeParse({
        viewerId: 'u', clientId: 'c', visibleProjectIds: ['p1', 'p1'],
        activeProjectId: 'p1', expandedProjectIds: [], revision: 0,
      }).success,
    ).toBe(false);
  });
});

describe('四项只读查询 DTO（开工契约 §3.3）', () => {
  it('limit 边界 1..200', () => {
    expect(roomListParamsSchema.safeParse({ projectId: 'p1', limit: 200 }).success).toBe(true);
    expect(roomListParamsSchema.safeParse({ projectId: 'p1', limit: 201 }).success).toBe(false);
    expect(memberListParamsSchema.safeParse({ projectId: 'p1', limit: 0 }).success).toBe(false);
    expect(eventsListParamsSchema.safeParse({ projectId: 'p1', limit: 1 }).success).toBe(true);
  });

  it('events.list 需要 projectId', () => {
    expect(eventsListParamsSchema.safeParse({ limit: 100 }).success).toBe(false);
  });

  it('task.get 只需要 taskId', () => {
    expect(taskGetParamsSchema.safeParse({ taskId: 't1' }).success).toBe(true);
  });
});

describe('CallerContext schema', () => {
  it('MCP 外部助手主体通过 schema（actualPrincipal=external_connection）', () => {
    const r = callerContextSchema.safeParse({
      actualPrincipal: { kind: 'external_connection', id: 'conn_1' },
      entry: 'mcp', credentialId: 'cred_1', connectionId: 'conn_1',
      projectIds: ['p1'], conversationScope: { kind: 'all_in_project' },
      operations: ['read'], dispatchMemberScope: { kind: 'listed', memberIds: ['m1'] },
      grantRevision: 1,
    });
    expect(r.success).toBe(true);
  });

  it('未知主体 kind 拒绝', () => {
    const r = callerContextSchema.safeParse({
      actualPrincipal: { kind: 'mysterious', id: 'x' },
      entry: 'ui', credentialId: 'c', projectIds: [], conversationScope: { kind: 'all_in_project' },
      operations: [], dispatchMemberScope: { kind: 'all_enabled' }, grantRevision: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe('CommandReceipt 墓碑（开工契约 §3.2）', () => {
  it('回执携带 scope/commandId/payloadHash', () => {
    expect(
      commandReceiptSchema.safeParse({
        idempotencyScope: 'user:u1', commandId: 'cmd-12345678',
        payloadHash: 'abc', createdAt: 1,
      }).success,
    ).toBe(true);
  });
});
