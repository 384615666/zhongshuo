import { describe, expect, it } from 'vitest';
import { coordinationProgressHint } from '../../src/ui/hifi/lib/coordinationProgressHint.ts';
import { taskRunHint } from '../../src/ui/hifi/lib/taskRunHint.ts';
import type { TaskExecutionBlocker } from '../../src/contracts/executionBlockers.ts';

const running = [{ status: 'RUNNING', memberName: '费用复核' }];

describe('R102 waiting coordinator with real member activity', () => {
  it('shows the executing member while retaining the persisted parent status', () => {
    const run = { status: 'WAITING' };
    expect(coordinationProgressHint('ACTIVE', run.status, running)).toMatchObject({
      label: '成员执行中', tone: 'info', detail: '费用复核 正在处理；协调成员等待成果返回',
    });
    expect(run.status).toBe('WAITING');
  });

  it('describes pending members as waiting rather than executing', () => {
    expect(coordinationProgressHint('ACTIVE', 'WAITING', [{ status: 'DISPATCHING', memberName: '方案核对' }])).toMatchObject({
      label: '等待其他成员', detail: '方案核对 尚未开始执行',
    });
  });

  it.each(['BLOCKED', 'WAITING_USER', 'DONE', 'CANCELLED'])('does not hide a %s task with stale progress', taskStatus => {
    expect(coordinationProgressHint(taskStatus, 'WAITING', running)).toBeNull();
  });

  it.each(['FAILED', 'INTERRUPTED', 'STOPPING', 'CANCELLED'])('does not hide a %s run with stale progress', runStatus => {
    expect(coordinationProgressHint('ACTIVE', runStatus, running)).toBeNull();
  });

  it('preserves an unknown-turn blocker ahead of live member facts', () => {
    const blocker = { reason: 'unknown-turn', note: '前序成员结果未知，需核对' } as TaskExecutionBlocker;
    const hint = coordinationProgressHint('ACTIVE', 'WAITING', running, blocker) ?? taskRunHint('WAITING', blocker);
    expect(hint).toMatchObject({ label: '占用未核实', detail: blocker.note });
  });

  it('does not invent execution from terminal, paused or missing progress', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'UNKNOWN', 'WAITING_APPROVAL', 'WAITING_INPUT', 'STOPPING']) {
      expect(coordinationProgressHint('ACTIVE', 'WAITING', [{ status, memberName: '成员' }])).toBeNull();
    }
    expect(coordinationProgressHint('ACTIVE', 'WAITING', [])).toBeNull();
  });

  it.each(['UNKNOWN', 'FAILED', 'WAITING_INPUT', 'WAITING_APPROVAL', 'STOPPING'])('does not obscure a child %s with another running child', status => {
    expect(coordinationProgressHint('ACTIVE', 'WAITING', [...running, { status, memberName: '待核对成员' }])).toBeNull();
  });
});
