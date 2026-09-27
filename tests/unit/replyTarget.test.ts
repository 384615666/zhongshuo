import { describe, expect, it } from 'vitest';
import { resolveReplyTarget } from '../../src/domain/routing/replyTarget.ts';
import type { ReplyTargetKnownEntities } from '../../src/domain/routing/replyTarget.ts';
import type { MessageTarget } from '../../src/contracts/conversation.ts';

const roomConversation: NonNullable<ReplyTargetKnownEntities['conversation']> = {
  id: 'conv_room_1',
  projectId: 'p1',
  kind: 'room',
  roomId: 'room_1',
  archived: false,
};

const threadEntity: NonNullable<ReplyTargetKnownEntities['thread']> = {
  id: 'thread_1',
  projectId: 'p1',
  conversationId: 'conv_room_1',
  roomId: 'room_1',
  anchorMessageId: 'msg_anchor_1',
  rootTaskId: 'task_1',
};

describe('回复目标绑定三分支（§4.5）', () => {
  it('房间主池发送 → 创建新线程（预分配 threadId）', () => {
    const r = resolveReplyTarget({
      target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room_1', roomId: 'room_1' },
      entities: { conversation: roomConversation },
      preallocatedThreadId: 'thread_new_1',
      newAnchorMessageId: 'msg_new_1',
    });
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'new_thread',
        roomId: 'room_1',
        conversationId: 'conv_room_1',
        anchorMessageId: 'msg_new_1',
        preallocatedThreadId: 'thread_new_1',
      },
    });
  });

  it('串内跟进 → 沿用该 threadId', () => {
    const r = resolveReplyTarget({
      target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_room_1', threadId: 'thread_1' },
      entities: { thread: threadEntity, conversation: roomConversation },
    });
    expect(r).toEqual({
      ok: true,
      value: { kind: 'existing_thread', threadId: 'thread_1', conversationId: 'conv_room_1' },
    });
  });

  it('DM → 保持 conversationId，不创建 thread', () => {
    const r = resolveReplyTarget({
      target: { kind: 'dm', projectId: 'p1', conversationId: 'conv_dm_1' },
      entities: { conversation: { id: 'conv_dm_1', projectId: 'p1', kind: 'dm' } },
    });
    expect(r).toEqual({
      ok: true,
      value: { kind: 'dm_conversation', conversationId: 'conv_dm_1' },
    });
    if (r.ok) {
      expect(Object.keys(r.value)).not.toContain('threadId');
    }
  });
});

describe('目标不匹配：绝不兜底发到主池（§16.5）', () => {
  it('thread 目标与线程记录的 projectId 不一致 → THREAD_SCOPE_MISMATCH', () => {
    const r = resolveReplyTarget({
      target: { kind: 'thread', projectId: 'p2', conversationId: 'conv_room_1', threadId: 'thread_1' },
      entities: { thread: threadEntity },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'THREAD_SCOPE_MISMATCH' } });
  });

  it('thread 目标指向其他会话 → THREAD_SCOPE_MISMATCH', () => {
    const r = resolveReplyTarget({
      target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_other', threadId: 'thread_1' },
      entities: { thread: threadEntity },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'THREAD_SCOPE_MISMATCH' } });
  });

  it('thread 目标不存在 → RESOURCE_NOT_FOUND（不是静默新建线程）', () => {
    const r = resolveReplyTarget({
      target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_room_1', threadId: 'thread_missing' },
      entities: { thread: null },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'RESOURCE_NOT_FOUND' } });
  });

  it('dm 目标落在房间会话上 → CONVERSATION_SCOPE_MISMATCH', () => {
    const r = resolveReplyTarget({
      target: { kind: 'dm', projectId: 'p1', conversationId: 'conv_room_1' },
      entities: { conversation: roomConversation },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONVERSATION_SCOPE_MISMATCH' } });
  });

  it('room_root 目标落在 dm 会话上 → CONVERSATION_SCOPE_MISMATCH', () => {
    const r = resolveReplyTarget({
      target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_dm_1', roomId: 'room_1' },
      entities: { conversation: { id: 'conv_dm_1', projectId: 'p1', kind: 'dm' } },
      preallocatedThreadId: 't',
      newAnchorMessageId: 'm',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONVERSATION_SCOPE_MISMATCH' } });
  });

  it('归档房间禁止新增根任务 → ROOM_ARCHIVED', () => {
    const r = resolveReplyTarget({
      target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room_1', roomId: 'room_1' },
      entities: { conversation: { ...roomConversation, archived: true } },
      preallocatedThreadId: 't',
      newAnchorMessageId: 'm',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'ROOM_ARCHIVED' } });
  });

  it('reply_to 指向其他线程的消息 → THREAD_SCOPE_MISMATCH（不生成新串）', () => {
    const r = resolveReplyTarget({
      target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_room_1', threadId: 'thread_1' },
      entities: {
        thread: threadEntity,
        replyToMessage: { id: 'msg_other_thread', threadId: 'thread_2', isRoomAnchor: false },
      },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'THREAD_SCOPE_MISMATCH' } });
  });

  it('reply_to 指向本串 anchor 或串内回复 → 通过（引用某条串内回复是普通回复，§4.5）', () => {
    for (const replyTo of [
      { id: 'msg_anchor_1', threadId: null, isRoomAnchor: true, anchorOfThreadId: 'thread_1' },
      { id: 'msg_in_thread', threadId: 'thread_1', isRoomAnchor: false },
    ]) {
      const r = resolveReplyTarget({
        target: { kind: 'thread', projectId: 'p1', conversationId: 'conv_room_1', threadId: 'thread_1' },
        entities: { thread: threadEntity, replyToMessage: replyTo },
      });
      expect(r.ok).toBe(true);
    }
  });

  it('主池发送缺预分配 ID → VALIDATION_INVALID（不允许无事务关联地发消息）', () => {
    const r = resolveReplyTarget({
      target: { kind: 'room_root', projectId: 'p1', conversationId: 'conv_room_1', roomId: 'room_1' },
      entities: { conversation: roomConversation },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID' } });
  });
});

describe('MessageTarget 判别联合', () => {
  it('必须且只能提供一种目标：构造期即无法并存（类型级），运行时拒绝未知 kind', () => {
    const bad = { kind: 'room_root_and_thread', projectId: 'p1' } as unknown as MessageTarget;
    const r = resolveReplyTarget({
      target: bad,
      entities: {},
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID' } });
  });
});
