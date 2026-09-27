/**
 * 停止目标判定（开工契约 §3.2 / §31.4 v1.21：停止请求绑定目标运行）。
 * 旧 run 的停止请求返回 target_obsolete，不修改新 run、不取消后续运行；
 * 同一运行并发 stop 只推进一次停止代次（代次推进本身由 DEV-05 的持久层承担）。
 */
import type { RunStatus } from '../../contracts/run.ts';
import { isRunTerminal } from '../../contracts/run.ts';
import type { TaskStopOutcome } from '../../contracts/task.ts';
import { domainErr, domainOk } from '../../contracts/errors.ts';
import type { DomainResult } from '../../contracts/errors.ts';

export interface StopTargetInput {
  /** 任务当前活跃运行（无活跃运行为 null）。 */
  taskCurrentRunId: string | null;
  /** 客户端停止请求绑定的目标运行。 */
  targetRunId: string;
  /** 客户端读取到的停止代次。 */
  expectedStopGeneration: number;
  /** 服务端当前停止代次。 */
  currentStopGeneration: number;
  /** 目标运行的当前状态（服务端视角）。 */
  targetRunStatus: RunStatus;
}

export function evaluateStopTarget(input: StopTargetInput): DomainResult<TaskStopOutcome> {
  if (input.expectedStopGeneration > input.currentStopGeneration) {
    return domainErr(
      'STALE_REVISION',
      'expectedStopGeneration 大于当前代次：请求携带了未来状态，拒绝执行',
    );
  }
  // 目标运行已不是任务当前运行（被恢复/重试取代）→ 迟到旧停止不伤新 run。
  if (input.targetRunId !== input.taskCurrentRunId) {
    if (isRunTerminal(input.targetRunStatus)) {
      return domainOk('already_stopped');
    }
    return domainOk('target_obsolete');
  }
  // 同一运行：代次已推进说明已有停止请求生效。
  if (input.expectedStopGeneration < input.currentStopGeneration) {
    return isRunTerminal(input.targetRunStatus) ? domainOk('stopped') : domainOk('stopping');
  }
  if (isRunTerminal(input.targetRunStatus)) {
    return domainOk('already_stopped');
  }
  return domainOk('stopping');
}
