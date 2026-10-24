import { describe, expect, it } from 'vitest';
import { preDispatchFailureAction } from '../../src/daemon/preDispatchFailure.ts';

describe('R107 pre-dispatch failure guidance', () => {
  it('uses the structured write-baseline reason for an actionable directory scan explanation', () => {
    const action = preDispatchFailureAction(
      'task.contextAssemblyFailed',
      'write-baseline-incomplete',
    );
    expect(action.kind).toBe('resubmit-original-message');
    expect(action.instruction).toContain('junction/symlink');
    expect(action.instruction).toContain('生成目录');
    expect(action.instruction).toContain('按原消息重新提交');
  });

  it('prioritizes the analysis-only continuation contract when a recovery binding is eligible', () => {
    const action = preDispatchFailureAction(
      'task.contextAssemblyFailed',
      'write-baseline-incomplete',
      true,
    );
    expect(action).toEqual({
      kind: 'resubmit-original-message',
      instruction: '仅需分析可选择仅分析继续，原消息与成员不变；可写执行仍需完整基线。',
    });
  });

  it('keeps configuration recovery explicit and does not promise automatic authorization', () => {
    const changed = preDispatchFailureAction(
      'task.contextAssemblyFailed',
      'write-authorization-changed',
    );
    expect(changed.instruction).toContain('重新确认当前成员、项目和写入权限');
    expect(changed.instruction).toContain('不会自动沿用或恢复旧授权');

    const disabled = preDispatchFailureAction(
      'task.memberDisabledBlocked',
      'member-disabled',
    );
    expect(disabled.instruction).toContain('重新启用执行成员');
    expect(disabled.instruction).toContain('系统不会自动恢复旧授权');
  });

  it('falls back conservatively for an unknown reason', () => {
    const action = preDispatchFailureAction(
      'task.contextAssemblyFailed',
      'unrecognized-prepare-failure',
    );
    expect(action.instruction).toContain('按提示检查');
    expect(action.instruction).toContain('按原消息重新提交');
    expect(action.instruction).not.toContain('已授权');
  });
});
