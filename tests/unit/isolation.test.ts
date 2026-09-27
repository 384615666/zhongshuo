import { describe, expect, it } from 'vitest';
import {
  dmSessionKey,
  taskSessionKey,
  validateEventAttribution,
  validateExecutionBinding,
} from '../../src/domain/isolation/binding.ts';
import type { BindingEntityRefs } from '../../src/domain/isolation/binding.ts';
import { filterContextScope } from '../../src/domain/isolation/contextFilter.ts';

const REFS: BindingEntityRefs = {
  task: { id: 'task_1', projectId: 'p1', conversationId: 'conv_1', threadId: 'thread_1' },
  run: { id: 'run_1', taskId: 'task_1', conversationId: 'conv_1', threadId: 'thread_1', mode: 'DIRECT' },
  turn: { id: 'turn_1', runId: 'run_1', conversationId: 'conv_1', threadId: 'thread_1', memberId: 'm_a' },
  thread: { id: 'thread_1', projectId: 'p1', conversationId: 'conv_1', roomId: 'room_1' },
};

describe('五级归属绑定（DEV-17）', () => {
  it('一致时通过', () => {
    expect(validateExecutionBinding(REFS)).toEqual({ ok: true, value: { bound: true } });
  });

  it('run 属于别的任务 / turn 属于别的运行 → 拒绝', () => {
    expect(validateExecutionBinding({ ...REFS, run: { ...REFS.run, taskId: 'task_other' } }))
      .toMatchObject({ ok: false, error: { code: 'THREAD_SCOPE_MISMATCH' } });
    expect(validateExecutionBinding({ ...REFS, turn: { ...REFS.turn, runId: 'run_other' } }))
      .toMatchObject({ ok: false, error: { code: 'THREAD_SCOPE_MISMATCH' } });
  });

  it('run/turn 与任务会话不一致 → CONVERSATION_SCOPE_MISMATCH（§2.2 任务/run/turn 同时校验所属关系）', () => {
    expect(validateExecutionBinding({ ...REFS, run: { ...REFS.run, conversationId: 'conv_other' } }))
      .toMatchObject({ ok: false, error: { code: 'CONVERSATION_SCOPE_MISMATCH' } });
  });

  it('线程归属漂移 → 拒绝（输出不随 UI 切换漂移，§4.5）', () => {
    expect(validateExecutionBinding({ ...REFS, turn: { ...REFS.turn, threadId: 'thread_2' } }))
      .toMatchObject({ ok: false, error: { code: 'THREAD_SCOPE_MISMATCH' } });
    expect(
      validateExecutionBinding({
        ...REFS,
        thread: { ...REFS.thread!, conversationId: 'conv_other' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONVERSATION_SCOPE_MISMATCH' } });
  });
});

describe('事件归属（§4.5/RT-06）', () => {
  it('匹配 turn 通过；无 turn 事件（process.exited）通过', () => {
    expect(
      validateEventAttribution({ event: { turnId: 'turn_1', sessionId: 's1' }, turn: REFS.turn }),
    ).toEqual({ ok: true, value: { attributed: true } });
    expect(
      validateEventAttribution({ event: { sessionId: 's1' }, turn: REFS.turn }),
    ).toEqual({ ok: true, value: { attributed: true } });
  });

  it('其他 turn 的事件（迟到）→ 拒绝改变状态', () => {
    expect(
      validateEventAttribution({ event: { turnId: 'turn_old', sessionId: 's1' }, turn: REFS.turn }),
    ).toMatchObject({ ok: false, error: { code: 'THREAD_SCOPE_MISMATCH' } });
  });

  it('事件目标线程与 turn 绑定不一致 → 拒绝（agent 不能更换目的地）', () => {
    expect(
      validateEventAttribution({
        event: { turnId: 'turn_1', sessionId: 's1' },
        turn: REFS.turn,
        eventThreadId: 'thread_other',
      }),
    ).toMatchObject({ ok: false, error: { code: 'THREAD_SCOPE_MISMATCH' } });
  });
});

describe('会话复用键（§13.4/开工契约 §2.2）', () => {
  it('任务键含 task+generation；换任务/代次即新键', () => {
    const base = { projectId: 'p1', threadId: 'th1', memberId: 'm1', taskId: 't1', sessionGeneration: 0 };
    expect(taskSessionKey(base)).toBe('task:p1:th1:m1:t1:0');
    expect(taskSessionKey({ ...base, taskId: 't2' })).not.toBe(taskSessionKey(base));
    expect(taskSessionKey({ ...base, sessionGeneration: 1 })).not.toBe(taskSessionKey(base));
  });

  it('DM 键按会话+成员+代次；不同对话永不共享', () => {
    const base = { projectId: 'p1', conversationId: 'c1', memberId: 'm1', sessionGeneration: 0 };
    expect(dmSessionKey(base)).toBe('dm:p1:c1:m1:0');
    expect(dmSessionKey({ ...base, conversationId: 'c2' })).not.toBe(dmSessionKey(base));
    expect(dmSessionKey({ ...base, sessionGeneration: 1 })).not.toBe(dmSessionKey(base));
  });
});

describe('上下文过滤（§13.4 矩阵最小）', () => {
  it('本线程消息与指令放行；其他任务消息/未授权成果拒绝但返回部分结果', () => {
    const r = filterContextScope({
      task: { id: 'task_b', threadId: 'thread_b' },
      threadMessageIds: ['msg_b1', 'msg_b2'],
      grantedRefs: [],
      requestedRefs: [
        { kind: 'directive', refId: 'goal' },
        { kind: 'message', refId: 'msg_b1' },
        { kind: 'message', refId: 'msg_a9' }, // 任务 A 的消息
        { kind: 'artifact', refId: 'art_a1' }, // 未授权成果
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.included.map((x) => x.refId)).toEqual(['goal', 'msg_b1']);
      expect(r.value.rejected).toEqual([
        { ref: { kind: 'message', refId: 'msg_a9' }, reason: 'not_in_task_scope' },
        { ref: { kind: 'artifact', refId: 'art_a1' }, reason: 'grant_missing' },
      ]);
    }
  });

  it('grant 后的跨任务引用放行（TH-07 形态）', () => {
    const r = filterContextScope({
      task: { id: 'task_b', threadId: 'thread_b' },
      threadMessageIds: [],
      grantedRefs: ['art_a1@v3'],
      requestedRefs: [{ kind: 'artifact', refId: 'art_a1@v3', revision: 3 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.included).toHaveLength(1);
  });

  it('基线内文件放行；无基线文件拒绝', () => {
    const r = filterContextScope({
      task: { id: 't', threadId: 'th' },
      threadMessageIds: [],
      grantedRefs: [],
      requestedRefs: [
        { kind: 'file', refId: 'src/a.ts', baselineId: 'bl_1' },
        { kind: 'file', refId: 'secret.txt' },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.included.map((x) => x.refId)).toEqual(['src/a.ts']);
      expect(r.value.rejected[0]?.reason).toBe('not_in_task_scope');
    }
  });

  it('全部被拒 → CONTEXT_NOT_GRANTED（不装出空输入包）', () => {
    const r = filterContextScope({
      task: { id: 't', threadId: 'th' },
      threadMessageIds: [],
      grantedRefs: [],
      requestedRefs: [{ kind: 'artifact', refId: 'art_x' }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONTEXT_NOT_GRANTED' } });
  });
});
