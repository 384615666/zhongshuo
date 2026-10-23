import {describe, expect, it, vi} from 'vitest';
import {createPreviousReplyCheck, previousReplyStillHeld, previousReplySummary} from '../../src/ui/hifi/lib/checkPreviousReply';

describe('one-click previous reply check', () => {
  it('keeps an unknown historical outcome visible after release without claiming new messages are blocked', () => {
    const status = {unknownTurns: [{id: 'old-turn', protectionState: 'released', protectionReleased: true}], pendingRelease: [], heldLeases: []};
    expect(previousReplyStillHeld(status, 'old-turn')).toBe(false);
    const summary = previousReplySummary(status);
    expect(summary).toContain('原回复结果仍未确认');
    expect(summary).toContain('不阻挡新消息');
    expect(summary).not.toContain('正在等待');
    expect(summary).not.toContain('尚未确认结束');
    // Same read after reopening the panel: no local success marker is needed.
    expect(previousReplySummary(JSON.parse(JSON.stringify(status)))).toBe(summary);
  });

  it('still reports retained protection even with no workspace lease, and handles mixed released/held turns', () => {
    const status = {unknownTurns: [{id: 'retained'}, {id: 'released', protectionReleased: true}], pendingRelease: [{turnId: 'retained'}], heldLeases: []};
    expect(previousReplyStillHeld(status, 'retained')).toBe(true);
    expect(previousReplyStillHeld(status, 'released')).toBe(false);
    const summary = previousReplySummary(status);
    expect(summary).toContain('有 1 次上次回复需要检查');
    expect(summary).toContain('有 1 次原回复结果仍未确认');
    expect(previousReplyStillHeld({...status, pendingRelease: [], heldLeases: [{owner_turn_id: 'retained'}]}, 'retained')).toBe(true);
  });

  it.each([
    {id: 'old-turn'},
    {id: 'old-turn', protectionState: null, protectionReleased: false},
    {id: 'old-turn', protectionState: 'released', protectionReleased: false},
  ])('does not treat an unknown execution with no leases or no formal release as released: %j', turn => {
    const status = {unknownTurns: [turn], pendingRelease: [], heldLeases: []};
    expect(previousReplyStillHeld(status, turn.id)).toBe(true);
    expect(previousReplySummary(status)).toContain('需要检查');
    expect(previousReplySummary(status)).not.toContain('不阻挡新消息');
  });

  it('uses one stable turn, confirms unknown work, proves release, then resumes without redispatch', async () => {
    const send = vi.fn().mockResolvedValue({});
    await createPreviousReplyCheck(send)('old-turn');
    expect(send.mock.calls).toEqual([
      ['recovery.reconcile', {turnId: 'old-turn', verdict: 'executed', note: '上次请求已派发，结果仍未知；核查并结束占用，不重发原请求'}],
      ['recovery.releaseProtection', {turnId: 'old-turn', note: '检查并继续排队消息；保留原执行结果', endPreviousExecution: true}],
      ['dispatch.resume', {confirm: true}],
    ]);
  });

  it('joins rapid duplicate clicks until the whole asynchronous operation settles', async () => {
    let finish!: () => void;
    const firstStep = new Promise<void>(resolve => {finish = resolve;});
    const send = vi.fn().mockResolvedValue({}).mockImplementationOnce(() => firstStep);
    const check = createPreviousReplyCheck(send);
    const first = check('stable-turn');
    expect(check('stable-turn')).toBe(first);
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each([0, 1, 2])('stops after failure at step %s and permits a new idempotent check', async failedStep => {
    let calls = 0;
    const send = vi.fn().mockImplementation(() => {
      if (calls++ === failedStep) return Promise.reject(new Error('still running / not proven'));
      return Promise.resolve({});
    });
    const check = createPreviousReplyCheck(send);
    await expect(check('same-turn')).rejects.toThrow('not proven');
    expect(send).toHaveBeenCalledTimes(failedStep + 1);
    if (failedStep < 2) expect(send.mock.calls.some(call => call[0] === 'dispatch.resume')).toBe(false);
    send.mockResolvedValue({});
    await check('same-turn');
    expect(send.mock.calls.slice(-3).map(call => call[0])).toEqual(['recovery.reconcile', 'recovery.releaseProtection', 'dispatch.resume']);
    expect(send.mock.calls.filter(call => call[1].turnId != null).every(call => call[1].turnId === 'same-turn')).toBe(true);
    expect(send.mock.calls.some(call => /redispatch|dm\.send|task\.create/.test(call[0]))).toBe(false);
  });
});
