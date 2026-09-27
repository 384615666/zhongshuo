import { describe, expect, it } from 'vitest';
import { resolveTopLevelRoute, resolveTopLevelRouteFromMessage } from '../../src/domain/routing/topLevelRoute.ts';
import type { TopLevelRouteInput } from '../../src/domain/routing/topLevelRoute.ts';
import type { MentionNode } from '../../src/contracts/routing.ts';

const ROOM: TopLevelRouteInput['room'] = {
  coordinatorMemberId: 'm_coord',
  enabledAgentMemberIds: ['m_coord', 'm_a', 'm_b', 'm_c'],
};

const m = (memberId: string): MentionNode => ({ kind: 'member', memberId });
const ALL: MentionNode = { kind: 'all' };

function route(intent: TopLevelRouteInput['intent'], mentions: readonly MentionNode[], room = ROOM) {
  return resolveTopLevelRoute({ intent, mentions, room });
}

describe('§4.2 路由表逐行（SendIntent=default）', () => {
  it('无 mention → AUTO，默认协调者接单（AT-01：仅协调者先启动）', () => {
    const r = route('default', []);
    expect(r).toMatchObject({
      ok: true,
      value: {
        kind: 'dispatch',
        mode: 'AUTO',
        coordinatorMemberId: 'm_coord',
        frozenMemberIds: ['m_coord'],
        initialWakeMemberIds: ['m_coord'],
      },
    });
  });

  it('单个明确 mention → DIRECT，仅指定成员（AT-07：其他成员零调用）', () => {
    const r = route('default', [m('m_b')]);
    expect(r).toMatchObject({
      ok: true,
      value: {
        kind: 'dispatch',
        mode: 'DIRECT',
        targetMemberId: 'm_b',
        frozenMemberIds: ['m_b'],
        initialWakeMemberIds: ['m_b'],
      },
    });
    if (r.ok) {
      expect(r.value.kind === 'dispatch' && r.value.initialWakeMemberIds).not.toContain('m_coord');
    }
  });

  it('@全体 → DELIBERATE，冻结房间启用名单', () => {
    const r = route('default', [ALL]);
    expect(r).toMatchObject({
      ok: true,
      value: {
        kind: 'dispatch',
        mode: 'DELIBERATE',
        rosterSource: 'all',
        frozenMemberIds: ['m_coord', 'm_a', 'm_b', 'm_c'],
      },
    });
  });

  it('多个明确 mention → DELIBERATE，仅所选子集', () => {
    const r = route('default', [m('m_a'), m('m_c')]);
    expect(r).toMatchObject({
      ok: true,
      value: { kind: 'dispatch', mode: 'DELIBERATE', rosterSource: 'selected', frozenMemberIds: ['m_a', 'm_c'] },
    });
  });

  it('同时 @全体 与单独 mention → 以全体为准并去重', () => {
    const r = route('default', [ALL, m('m_a')]);
    expect(r).toMatchObject({
      ok: true,
      value: {
        kind: 'dispatch',
        mode: 'DELIBERATE',
        rosterSource: 'all',
        frozenMemberIds: ['m_coord', 'm_a', 'm_b', 'm_c'],
      },
    });
    if (r.ok && r.value.kind === 'dispatch') {
      expect(new Set(r.value.frozenMemberIds).size).toBe(r.value.frozenMemberIds.length);
    }
  });

  it('多个 mention 去重且保持顺序', () => {
    const r = route('default', [m('m_b'), m('m_a'), m('m_b')]);
    expect(r).toMatchObject({
      ok: true,
      value: { mode: 'DELIBERATE', frozenMemberIds: ['m_b', 'm_a'] },
    });
  });
});

describe('一次性「仅记录」（§0.22/§4.2）', () => {
  it("record_only：保存记录，不建任务/运行/派发——含 @全体 也零唤醒", () => {
    const r = route('record_only', [ALL, m('m_a')]);
    expect(r).toEqual({
      ok: true,
      value: { kind: 'record_only', reason: 'explicit_record_only' },
    });
  });

  it('record_only 的 mention 节点不参与判定：无效成员引用也不报错', () => {
    const r = route('record_only', [m('m_unknown_member')]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.kind).toBe('record_only');
  });

  it('record_only 不产生任何派发目标（零模型预算）', () => {
    const r = route('record_only', []);
    expect(r.ok && r.value.kind).toBe('record_only');
  });
});

describe('mention 有效性（§4.1/AT-09）', () => {
  it('正文代码块中的 @全体 不触发：路由只看结构化节点（mentions 为空 → AUTO）', () => {
    const r = resolveTopLevelRouteFromMessage(
      { body: '```\n@全体 分析一下\n```', intent: 'default', mentions: [] },
      ROOM,
    );
    expect(r).toMatchObject({ ok: true, value: { kind: 'dispatch', mode: 'AUTO' } });
  });

  it('正文满屏 @ 也是普通文字（AT-09）：仍是 AUTO', () => {
    const r = resolveTopLevelRouteFromMessage(
      { body: '@全体 @m_a @m_b 请执行', intent: 'default', mentions: [] },
      ROOM,
    );
    expect(r).toMatchObject({ ok: true, value: { kind: 'dispatch', mode: 'AUTO' } });
  });

  it('引用未启用成员 → INVALID_MENTION', () => {
    const r = route('default', [m('m_disabled_or_absent')]);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_MENTION' } });
  });

  it('多选中混入未启用成员 → 整笔拒绝', () => {
    const r = route('default', [m('m_a'), m('m_not_in_room')]);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_MENTION' } });
  });

  it('协调者不在启用名单 → AUTO 拒绝（MEMBER_UNAVAILABLE，替代者选择归后续调度）', () => {
    const r = route('default', [], { ...ROOM, enabledAgentMemberIds: ['m_a', 'm_b'] });
    expect(r).toMatchObject({ ok: false, error: { code: 'MEMBER_UNAVAILABLE' } });
  });

  it('@全体 但房间无启用 agent → 拒绝', () => {
    const r = route('default', [ALL], { ...ROOM, enabledAgentMemberIds: [] });
    expect(r).toMatchObject({ ok: false, error: { code: 'MEMBER_UNAVAILABLE' } });
  });
});
