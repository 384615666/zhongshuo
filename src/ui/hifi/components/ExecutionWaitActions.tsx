import type {TaskExecutionBlocker} from '../../../contracts/executionBlockers';
import {userFacingSystemText} from '../../../contracts/userFacingText';
import {ContinueTaskButton} from './ContinueTaskButton';

/** Root-card recovery action and evidence; no guessed room number for DM tasks. */
export function ExecutionWaitActions({blocker,taskId,projectId}: {blocker: TaskExecutionBlocker;taskId?:string;projectId?:string}) {
  const title = blocker.blockingRootTaskTitle ?? blocker.blockingTaskTitle;
  const number = blocker.blockingRootTaskNumber ?? blocker.blockingTaskNumber;
  const blockingTaskId = blocker.blockingRootTaskId ?? blocker.blockingTaskId;
  return <div className="faint small" data-zs-execution-wait="1" onClick={event => event.stopPropagation()}>
    {title ? <div>正在等待的上次请求：{title}{number != null ? ` · #${number}` : ''}</div> : null}
    {blocker.reason === 'unknown-turn' ? taskId
      ? <ContinueTaskButton key={`${taskId}:${blocker.blockingTurnId}`} className="btn ghost sm" projectId={projectId} binding={{taskId}}/>
      : blockingTaskId ? <a className="btn ghost sm" href={`#task=${blockingTaskId}`}>查看上次任务</a> : null
      : null}
    <details><summary>诊断详情</summary><div>{userFacingSystemText(blocker.note)}</div>
    </details>
  </div>;
}
