import type {TaskExecutionBlocker} from '../../../contracts/executionBlockers';
import {requestRecoveryOpen} from '../lib/recovery';

/** Root-card recovery action and evidence; no guessed room number for DM tasks. */
export function ExecutionWaitActions({blocker}: {blocker: TaskExecutionBlocker}) {
  const title = blocker.blockingRootTaskTitle ?? blocker.blockingTaskTitle;
  const number = blocker.blockingRootTaskNumber ?? blocker.blockingTaskNumber;
  return <div className="faint small" data-zs-execution-wait="1" onClick={event => event.stopPropagation()}>
    {title ? <div>正在等待的上次请求：{title}{number != null ? ` · #${number}` : ''}</div> : null}
    {blocker.reason === 'unknown-turn' ? <button type="button" className="btn ghost sm" data-zs-open-recovery="1" onClick={() => requestRecoveryOpen()}>检查上次回复</button> : null}
    <details><summary>诊断详情</summary><div>{blocker.note}</div>
      {blocker.blockingTurnId ? <div>执行记录：{blocker.blockingTurnId}</div> : null}
      {blocker.protectionState ? <div>保护状态：{blocker.protectionState}</div> : null}
    </details>
  </div>;
}
