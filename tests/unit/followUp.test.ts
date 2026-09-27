import { describe, expect, it } from 'vitest';
import { resolveThreadFollowUp } from '../../src/domain/routing/followUp.ts';
import type { ThreadFollowUpInput } from '../../src/domain/routing/followUp.ts';
import type { MentionNode } from '../../src/contracts/routing.ts';

const BASE: Omit<ThreadFollowUpInput, 'mentions' | 'intent'> = {
  thread: { rootTaskId: 'task_1' },
  currentParticipantMemberIds: ['m_a', 'm_b'],
  roomEnabledAgentMemberIds: ['m_a', 'm_b', 'm_c', 'm_coord'],
};

const m = (memberId: string): MentionNode => ({ kind: 'member', memberId });
const ALL: MentionNode = { kind: 'all' };

describe('串内跟进（§4.2 讨论串行）', () => {
  it('任务串内无 mention → steering：延续当前参与者与模式', () => {
    const r = resolveThreadFollowUp({ ...BASE, intent: 'default', mentions: [] });
    expect(r).toEqual({ ok: true, value: { kind: 'steering' } });
  });

  it('点名当前参与者 → 定向提问，不重建工作流', () => {
    const r = resolveThreadFollowUp({ ...BASE, intent: 'default', mentions: [m('m_a')] });
    expect(r).toEqual({ ok: true, value: { kind: 'directed_question', memberIds: ['m_a'] } });
  });

  it('点名多个参与者 → 定向提问全部点名者', () => {
    const r = resolveThreadFollowUp({ ...BASE, intent: 'default', mentions: [m('m_a'), m('m_b')] });
    expect(r).toEqual({ ok: true, value: { kind: 'directed_question', memberIds: ['m_a', 'm_b'] } });
  });

  it('点名非参与者 → 待用户确认的扩大参与范围，不直接唤醒（决策 10）', () => {
    const r = resolveThreadFollowUp({ ...BASE, intent: 'default', mentions: [m('m_c')] });
    expect(r).toEqual({ ok: true, value: { kind: 'expansion_proposal', candidateMemberIds: ['m_c'] } });
  });

  it('混点名参与者+非参与者 → 非参与者触发扩大范围提案（保守处理）', () => {
    const r = resolveThreadFollowUp({ ...BASE, intent: 'default', mentions: [m('m_a'), m('m_c')] });
    expect(r).toEqual({ ok: true, value: { kind: 'expansion_proposal', candidateMemberIds: ['m_c'] } });
  });

  it('任务串内 @全体（房间含非参与者）→ 扩大范围提案', () => {
    const r = resolveThreadFollowUp({ ...BASE, intent: 'default', mentions: [ALL] });
    expect(r).toEqual({
      ok: true,
      value: { kind: 'expansion_proposal', candidateMemberIds: ['m_c', 'm_coord'] },
    });
  });

  it('历史记录串（root_task_id 为空）→ 默认仍是保存记录（兼容例外）', () => {
    const r = resolveThreadFollowUp({
      ...BASE,
      thread: { rootTaskId: null },
      intent: 'default',
      mentions: [],
    });
    expect(r).toEqual({ ok: true, value: { kind: 'record_only', reason: 'record_thread_default' } });
  });

  it('记录串内带 @全体 也不唤醒：讨论线程永不唤醒 agent（§3.4/E1）', () => {
    const r = resolveThreadFollowUp({
      ...BASE,
      thread: { rootTaskId: null },
      intent: 'default',
      mentions: [ALL, m('m_a')],
    });
    expect(r).toEqual({ ok: true, value: { kind: 'record_only', reason: 'record_thread_default' } });
  });

  it('任务串内显式 record_only → 只保存不 steering（意图复位由调用方持久化）', () => {
    const r = resolveThreadFollowUp({ ...BASE, intent: 'record_only', mentions: [m('m_a')] });
    expect(r).toEqual({ ok: true, value: { kind: 'record_only', reason: 'explicit_record_only' } });
  });

  it('点名未启用成员 → INVALID_MENTION', () => {
    const r = resolveThreadFollowUp({ ...BASE, intent: 'default', mentions: [m('m_stranger')] });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_MENTION' } });
  });
});
