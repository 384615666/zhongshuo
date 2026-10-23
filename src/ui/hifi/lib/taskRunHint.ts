import type { RunStatus } from '../data/types.ts';
import type { TaskExecutionBlocker } from '../../../contracts/executionBlockers.ts';

export interface TaskRunHint {
  label: string;
  detail: string;
  tone: 'danger' | 'warning' | 'neutral' | 'info';
  icon: string;
}

/** Explicit null is a completed read, not permission to revive an older blocker. */
export function taskExecutionBlocker(
  threadSnapshot: {executionBlocker?: TaskExecutionBlocker | null} | undefined,
  poolSnapshot: {executionBlocker?: TaskExecutionBlocker | null} | undefined,
): TaskExecutionBlocker | null {
  return threadSnapshot?.executionBlocker !== undefined
    ? threadSnapshot.executionBlocker : poolSnapshot?.executionBlocker ?? null;
}

/** Queued work without an executing turn must never read as an active model. */
export function executionBlockerHint(blocker: TaskExecutionBlocker): TaskRunHint {
  const member = blocker.blockingMemberName ?? blocker.memberName ?? '成员';
  switch (blocker.reason) {
    case 'unknown-turn':
      return { label: '等待确认上次回复', icon: 'help-circle', tone: 'warning',
        detail: `${member} 的上次回复尚未确认结束，当前请求正在等待。请检查上次回复状态。` };
    case 'member-occupied':
      return { label: '等待成员', icon: 'clock', tone: 'neutral',
        detail: `${member} 正在处理其他请求，当前请求正在排队等待。` };
    case 'write-root-occupied':
      return { label: '等待文件操作结束', icon: 'lock', tone: 'neutral',
        detail: `${member} 的文件操作尚未结束，当前请求正在等待，避免同时修改同一份文件。` };
    default:
      return { label: '等待执行', icon: 'clock', tone: 'neutral', detail: '当前请求已排队，尚未开始处理。' };
  }
}

/** 主池有限投影的显示语义；任务 ACTIVE 与最近运行 FAILED 必须分开。 */
export function taskRunHint(status: RunStatus | undefined, blocker?: TaskExecutionBlocker | null): TaskRunHint {
  if (blocker != null) return executionBlockerHint(blocker);
  switch (status) {
    case 'FAILED': return { label: '运行失败', icon: 'alert-triangle', tone: 'danger', detail: '任务仍未结束；打开详情查看原因与继续入口' };
    case 'INTERRUPTED':
    case 'PARTIAL': return { label: '运行未完成', icon: 'alert-triangle', tone: 'warning', detail: '任务仍未结束；打开详情查看运行结果' };
    case 'STOPPING': return { label: '停止中', icon: 'square', tone: 'warning', detail: '正在等待运行停止' };
    case 'QUEUED': return { label: '等待执行', icon: 'clock', tone: 'neutral', detail: '任务已排队' };
    case 'WAITING': return { label: '运行等待中', icon: 'clock', tone: 'warning', detail: '打开详情查看等待原因' };
    case 'SUCCEEDED': return { label: '运行已完成', icon: 'check-circle', tone: 'info', detail: '任务仍未结束；打开详情查看交付状态' };
    case 'CANCELLED': return { label: '运行已取消', icon: 'slash', tone: 'neutral', detail: '任务仍未结束；打开详情查看状态' };
    case 'RUNNING': return { label: '执行中', icon: 'play', tone: 'info', detail: '成员正在处理' };
    default: return { label: '待核对', icon: 'info', tone: 'neutral', detail: '尚无运行事实' };
  }
}
