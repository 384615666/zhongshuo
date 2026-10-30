import { describe, expect, it, vi } from 'vitest';
import { watchComposerWriteCapability } from '../../src/ui/hifi/lib/composerWriteCapability';
import type { ComposerWriteCapability } from '../../src/ui/hifi/lib/composerWriteCapability';

function fixture() {
  let visible = true;
  let poll = () => {};
  let visibility = () => {};
  const stopTimer = vi.fn();
  const stopVisible = vi.fn();
  const pending: Array<{resolve: (value: ComposerWriteCapability) => void; reject: (error: unknown) => void}> = [];
  const read = vi.fn(() => new Promise<ComposerWriteCapability>((resolve, reject) => pending.push({resolve, reject})));
  const success = vi.fn();
  const failure = vi.fn();
  const watcher = watchComposerWriteCapability(read, success, failure, {
    visible: () => visible,
    every: callback => { poll = callback; return stopTimer; },
    onVisible: callback => { visibility = callback; return stopVisible; },
  });
  return { watcher, pending, read, success, failure, stopTimer, stopVisible, poll: () => poll(), visible: (value: boolean) => { visible = value; visibility(); } };
}

const capability = {modificationAuthorized: false, willDispatch: true, blocked: true, reason: '原任务暂不可执行'};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('R129 advisory permission read lifecycle', () => {
  it('passes an explicit blocked result unchanged and keeps it distinct from a rejected query', async () => {
    const f = fixture();
    f.watcher.refresh();
    f.pending[0]!.resolve(capability);
    await flush();
    expect(f.success).toHaveBeenCalledWith(capability);
    expect(f.failure).not.toHaveBeenCalled();
    f.poll();
    const error = new Error('service rejected query');
    f.pending[1]!.reject(error);
    await flush();
    expect(f.failure).toHaveBeenCalledWith(error);
    expect(f.success).toHaveBeenCalledTimes(1);
    f.poll();
    f.pending[2]!.resolve(capability);
    await flush();
    expect(f.success).toHaveBeenCalledTimes(2);
    f.watcher.cancel();
  });

  it('coalesces task refreshes and skips overlapping periodic polls', async () => {
    const f = fixture();
    f.watcher.refresh();
    f.poll();
    f.watcher.refresh();
    f.watcher.refresh();
    expect(f.read).toHaveBeenCalledTimes(1);
    f.pending[0]!.resolve(capability);
    await flush();
    expect(f.success).toHaveBeenCalledWith(capability);
    expect(f.read).toHaveBeenCalledTimes(2);
    f.pending[1]!.resolve(capability);
    await flush();
    expect(f.read).toHaveBeenCalledTimes(2);
    f.watcher.cancel();
  });

  it.each(['success', 'failure'] as const)('discards late %s and queued refresh after cancellation', async outcome => {
    const f = fixture();
    f.watcher.refresh();
    f.watcher.refresh();
    f.watcher.cancel();
    if (outcome === 'success') f.pending[0]!.resolve(capability);
    else f.pending[0]!.reject(new Error('late query failure'));
    await flush();
    f.poll();
    f.visible(true);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.success).not.toHaveBeenCalled();
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.stopTimer).toHaveBeenCalledOnce();
    expect(f.stopVisible).toHaveBeenCalledOnce();
  });

  it('suspends hidden reads and resumes on visibility without inventing results', async () => {
    const f = fixture();
    f.visible(false);
    f.watcher.refresh();
    f.poll();
    expect(f.read).not.toHaveBeenCalled();
    f.visible(true);
    expect(f.read).toHaveBeenCalledOnce();
    f.pending[0]!.reject(new Error('actual transport failure'));
    await flush();
    expect(f.success).not.toHaveBeenCalled();
    expect(f.failure).toHaveBeenCalledOnce();
    f.watcher.cancel();
  });
});
