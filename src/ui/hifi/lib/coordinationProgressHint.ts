import type { TaskExecutionBlocker } from '../../../contracts/executionBlockers.ts';
import type { TaskRunHint } from './taskRunHint.ts';

/** Presentation only: a waiting coordinator can have executing member turns. */
export function coordinationProgressHint(
  taskStatus: string,
  runStatus: string | undefined,
  progress: ReadonlyArray<{ status: string; memberName: string }>,
  blocker?: TaskExecutionBlocker | null,
): TaskRunHint | null {
  if (taskStatus !== 'ACTIVE' || runStatus !== 'WAITING' || blocker != null) return null;
  if (progress.some(item => ['UNKNOWN', 'FAILED', 'WAITING_INPUT', 'WAITING_APPROVAL', 'STOPPING'].includes(item.status))) return null;
  const running = progress.filter(item => item.status === 'RUNNING');
  if (running.length > 0) return {
    label: '成员执行中', icon: 'play', tone: 'info',
    detail: `${running.map(item => item.memberName).join('、')} 正在处理；协调成员等待成果返回`,
  };
  const pending = progress.filter(item => ['PENDING', 'DISPATCHING'].includes(item.status));
  if (pending.length > 0) return {
    label: '等待其他成员', icon: 'clock', tone: 'neutral',
    detail: `${pending.map(item => item.memberName).join('、')} 尚未开始执行`,
  };
  return null;
}
