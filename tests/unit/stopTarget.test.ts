import { describe, expect, it } from 'vitest';
import { evaluateStopTarget } from '../../src/domain/scope/stopTarget.ts';

describe('停止目标判定（开工契约 §3.2/§31.4 v1.21）', () => {
  it('目标运行活跃且代次一致 → stopping', () => {
    const r = evaluateStopTarget({
      taskCurrentRunId: 'run_1',
      targetRunId: 'run_1',
      expectedStopGeneration: 0,
      currentStopGeneration: 0,
      targetRunStatus: 'RUNNING',
    });
    expect(r).toEqual({ ok: true, value: 'stopping' });
  });

  it('旧 run 的停止请求不伤新 run → target_obsolete（目标运行未终态但已被取代）', () => {
    const r = evaluateStopTarget({
      taskCurrentRunId: 'run_2', // 任务已被恢复/重试推进到新运行
      targetRunId: 'run_1',
      expectedStopGeneration: 0,
      currentStopGeneration: 0,
      targetRunStatus: 'RUNNING', // 旧运行尚未终结：停止它不能波及新运行
    });
    expect(r).toEqual({ ok: true, value: 'target_obsolete' });
  });

  it('旧 run 已终态 → already_stopped（不修改新 run、不取消后续运行）', () => {
    const r = evaluateStopTarget({
      taskCurrentRunId: 'run_2',
      targetRunId: 'run_1',
      expectedStopGeneration: 0,
      currentStopGeneration: 0,
      targetRunStatus: 'CANCELLED',
    });
    expect(r).toEqual({ ok: true, value: 'already_stopped' });
  });

  it('携带过期代次的请求 → target_obsolete', () => {
    const r = evaluateStopTarget({
      taskCurrentRunId: 'run_1',
      targetRunId: 'run_1',
      expectedStopGeneration: 0,
      currentStopGeneration: 1, // 已有停止推进过代次
      targetRunStatus: 'RUNNING',
    });
    expect(r).toEqual({ ok: true, value: 'stopping' });
  });

  it('本次请求的停止已完成（代次推进且目标运行已终止）→ stopped', () => {
    const r = evaluateStopTarget({
      taskCurrentRunId: 'run_1',
      targetRunId: 'run_1',
      expectedStopGeneration: 0,
      currentStopGeneration: 1,
      targetRunStatus: 'CANCELLED',
    });
    expect(r).toEqual({ ok: true, value: 'stopped' });
  });

  it('目标运行已自行终态 → already_stopped', () => {
    const r = evaluateStopTarget({
      taskCurrentRunId: 'run_1',
      targetRunId: 'run_1',
      expectedStopGeneration: 0,
      currentStopGeneration: 0,
      targetRunStatus: 'SUCCEEDED',
    });
    expect(r).toEqual({ ok: true, value: 'already_stopped' });
  });

  it('任务无活跃运行 → already_stopped/target_obsolete，不虚构停止过程', () => {
    const r = evaluateStopTarget({
      taskCurrentRunId: null,
      targetRunId: 'run_1',
      expectedStopGeneration: 0,
      currentStopGeneration: 0,
      targetRunStatus: 'FAILED',
    });
    expect(r).toEqual({ ok: true, value: 'already_stopped' });
  });

  it('携带未来代次的请求拒绝执行（STALE_REVISION）', () => {
    const r = evaluateStopTarget({
      taskCurrentRunId: 'run_1',
      targetRunId: 'run_1',
      expectedStopGeneration: 5,
      currentStopGeneration: 1,
      targetRunStatus: 'RUNNING',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
  });
});
