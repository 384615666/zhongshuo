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

  const inspection=(state:'ready'|'released'|'blocked',turnId='old-turn',budgetMark='settled')=>({
    schemaVersion:'recovery-inspection-v1',turnId,taskId:'child',budgetMark,turnStatus:'UNKNOWN',
    exitCheck:{state,action:state==='ready'?'release':state==='blocked'?'restart-windows':'none',message:'程序检查状态'},
  });

  it.each(['settled','refunded'])('rechecks a %s turn, releases only ready protection and verifies the receipt without redispatch',async budgetMark=>{
    const send=vi.fn().mockResolvedValueOnce(inspection('ready','old-turn',budgetMark)).mockResolvedValueOnce({released:true}).mockResolvedValueOnce(inspection('released'));
    const value=await createPreviousReplyCheck(send)('old-turn');
    expect(value.exitCheck.state).toBe('released');
    expect(send.mock.calls.map(call=>call[0])).toEqual(['recovery.inspect','recovery.releaseProtection','recovery.inspect']);
    expect(send.mock.calls.every(call=>call[1].turnId==='old-turn')).toBe(true);
  });

  it('keeps a blocked inspection readonly and never guesses the business outcome',async()=>{
    const send=vi.fn().mockResolvedValue(inspection('blocked'));
    expect((await createPreviousReplyCheck(send)('old-turn')).exitCheck.state).toBe('blocked');
    expect(send.mock.calls).toEqual([['recovery.inspect',{turnId:'old-turn'}]]);
  });

  it('does not rewrite a released historical UNKNOWN turn',async()=>{
    const send=vi.fn().mockResolvedValue(inspection('released'));
    await createPreviousReplyCheck(send)('old-turn');
    expect(send.mock.calls).toEqual([['recovery.inspect',{turnId:'old-turn'}]]);
  });

  it('joins rapid duplicate clicks until the whole asynchronous operation settles',async()=>{
    let finish!:(value:unknown)=>void;
    const send=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({}).mockResolvedValueOnce(inspection('released'));
    const check=createPreviousReplyCheck(send),first=check('old-turn');
    expect(check('old-turn')).toBe(first);expect(send).toHaveBeenCalledTimes(1);
    finish(inspection('ready'));await first;expect(send).toHaveBeenCalledTimes(3);
  });

  it('only reconciles an unaccounted unknown turn after a ready inspection',async()=>{
    const send=vi.fn().mockResolvedValueOnce(inspection('ready','old-turn','reserved')).mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockResolvedValueOnce(inspection('released'));
    await createPreviousReplyCheck(send)('old-turn');
    expect(send.mock.calls.map(call=>call[0])).toEqual(['recovery.inspect','recovery.reconcile','recovery.releaseProtection','recovery.inspect']);
  });

  it('does not report release success when the final inspection remains blocked',async()=>{
    const send=vi.fn().mockResolvedValueOnce(inspection('ready')).mockResolvedValueOnce({}).mockResolvedValueOnce(inspection('blocked'));
    await expect(createPreviousReplyCheck(send)('old-turn')).rejects.toThrow('程序检查状态');
    expect(send.mock.calls.some(call=>call[0]==='dispatch.resume')).toBe(false);
  });

  it('stops at a failed release and permits another explicit attempt',async()=>{
    const send=vi.fn().mockResolvedValueOnce(inspection('ready')).mockRejectedValueOnce(Error('still held'));
    const check=createPreviousReplyCheck(send);await expect(check('old-turn')).rejects.toThrow('still held');
    expect(send).toHaveBeenCalledTimes(2);
    send.mockResolvedValueOnce(inspection('ready')).mockResolvedValueOnce({}).mockResolvedValueOnce(inspection('released'));
    await check('old-turn');expect(send.mock.calls.filter(call=>call[0]==='recovery.reconcile')).toHaveLength(0);
  });

  it('rejects a changed inspection target before any mutation',async()=>{
    const send=vi.fn().mockResolvedValue(inspection('ready','another-turn'));
    await expect(createPreviousReplyCheck(send)('old-turn')).rejects.toThrow('对象已变化');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
