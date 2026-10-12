import type { RunStatus } from '../data/types';

/** 主池有限投影的显示语义；任务 ACTIVE 与最近运行 FAILED 必须分开。 */
export function taskRunHint(status: RunStatus | undefined): { label: string; detail: string; tone: 'danger' | 'warning' | 'neutral' | 'info'; icon: string } {
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
