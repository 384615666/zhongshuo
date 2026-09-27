import { describe, expect, it } from 'vitest';
import { resolveDmRoute } from '../../src/domain/routing/dmRoute.ts';
import type { DmRouteInput } from '../../src/domain/routing/dmRoute.ts';

function dmInput(overrides: Partial<DmRouteInput['conversation']> = {}, intent: DmRouteInput['intent'] = 'default'): DmRouteInput {
  return {
    intent,
    conversation: {
      id: 'conv_dm_1',
      kind: 'dm',
      archived: false,
      peerMember: { memberId: 'm_agent_x', principalType: 'agent' },
      ...overrides,
    },
  };
}

describe('私信 1 对 1 路由（§4.6/开工契约 §2）', () => {
  it('agent 对端：投递给该会话唯一成员，daemon 建立 dm_turn 执行', () => {
    const r = resolveDmRoute(dmInput());
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'deliver_to_peer',
        conversationId: 'conv_dm_1',
        peerMemberId: 'm_agent_x',
        executes: true,
      },
    });
  });

  it('human 对端：只投递保存，派发集合为空', () => {
    const r = resolveDmRoute(dmInput({ peerMember: { memberId: 'u_human', principalType: 'human' } }));
    expect(r).toEqual({
      ok: true,
      value: {
        kind: 'deliver_to_peer',
        conversationId: 'conv_dm_1',
        peerMemberId: 'u_human',
        executes: false,
      },
    });
  });

  it('正文/粘贴文本中的 @ 对结果零影响（正文不是路由输入）', () => {
    // resolveDmRoute 不接受 body 参数——本用例固化该事实：函数形态即「正文 @ 零影响」。
    const r = resolveDmRoute(dmInput());
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'deliver_to_peer') {
      expect(r.value.peerMemberId).toBe('m_agent_x');
      expect(Object.keys(r.value)).not.toContain('mentions');
    }
  });

  it('同一成员的多条私信按 conversationId 隔离：不合并、不串上下文', () => {
    const a = resolveDmRoute(dmInput());
    const b = resolveDmRoute(dmInput({ id: 'conv_dm_2' }));
    expect(a.ok && a.value.kind === 'deliver_to_peer' && a.value.conversationId).toBe('conv_dm_1');
    expect(b.ok && b.value.kind === 'deliver_to_peer' && b.value.conversationId).toBe('conv_dm_2');
  });

  it('record_only：只保存，不建 dm_turn 执行', () => {
    const r = resolveDmRoute(dmInput({}, 'record_only'));
    expect(r).toEqual({
      ok: true,
      value: { kind: 'record_only', reason: 'explicit_record_only', conversationId: 'conv_dm_1' },
    });
  });

  it('不分配房间任务号：结果类型不含 roomTaskNumber/roomId/taskId', () => {
    const r = resolveDmRoute(dmInput());
    if (r.ok && r.value.kind === 'deliver_to_peer') {
      const keys = Object.keys(r.value);
      expect(keys).not.toContain('roomTaskNumber');
      expect(keys).not.toContain('roomId');
      expect(keys).not.toContain('taskId');
    }
  });

  it('不推导 Mode：结果不携带 AUTO/DELIBERATE/DIRECT', () => {
    const r = resolveDmRoute(dmInput());
    if (r.ok) {
      expect(Object.keys(r.value)).not.toContain('mode');
    }
  });

  it('归档对话禁止新发（CONVERSATION_ARCHIVED）', () => {
    const r = resolveDmRoute(dmInput({ archived: true }));
    expect(r).toMatchObject({ ok: false, error: { code: 'CONVERSATION_ARCHIVED' } });
  });
});
