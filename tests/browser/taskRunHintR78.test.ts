import { describe, expect, it } from 'vitest';
import { taskRunHint } from '../../src/ui/hifi/lib/taskRunHint.ts';

describe('R78 room card run hint', () => {
  it('does not call a still ACTIVE task executing when the latest persisted run failed', () => {
    expect(taskRunHint('FAILED')).toMatchObject({ label: '运行失败', tone: 'danger' });
    expect(taskRunHint('FAILED').detail).toContain('任务仍未结束');
    expect(taskRunHint('QUEUED').label).toBe('等待执行');
    expect(taskRunHint('STOPPING').label).toBe('停止中');
    expect(taskRunHint(undefined)).toMatchObject({ label: '待核对', detail: '尚无运行事实' });
  });
});
