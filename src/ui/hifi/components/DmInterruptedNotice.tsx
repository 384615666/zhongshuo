import type {DmConversation} from '../data/types';
import {requestRecoveryOpen} from '../lib/recovery';
import {Icon} from './Icon';

type InterruptedTask = NonNullable<DmConversation['interruptedTasks']>[number];

function isNotDispatched(task: InterruptedTask): boolean {
  return task.lastRunId == null && task.lastRunStatus == null;
}

/** Readable next steps; raw recovery evidence remains available without becoming instructions. */
export function DmInterruptedNotice({tasks, memberName, queuedCount = 0, busy = false, onRecover}: {
  tasks: readonly InterruptedTask[];
  memberName: string;
  queuedCount?: number;
  busy?: boolean;
  onRecover: (task: InterruptedTask) => void;
}) {
  if (!tasks.length) return null;
  const notDispatched = tasks.filter(isNotDispatched);
  const allNotDispatched = notDispatched.length === tasks.length;
  const needsCheck = tasks.some(task => !task.recoverable);
  const awaitingEnd = tasks.some(task => !task.recoverable && task.lastRunStatus === 'INTERRUPTED');
  const hasExecutedTask = tasks.some(task => !isNotDispatched(task));
  const queuedCopy = queuedCount > 0 ? `本对话有 ${queuedCount} 条消息在等待。` : '';
  const summary = allNotDispatched
    ? notDispatched.length === 1
      ? '这条消息尚未发给 AI，原消息已保留。处理下面原因后可重新提交。'
      : `这 ${notDispatched.length} 条消息尚未发给 AI，原消息均已保留。处理下面原因后可重新提交。`
    : needsCheck
      ? `${notDispatched.length > 0 ? `${notDispatched.length} 条消息尚未发给 AI，原消息已保留。` : ''}${awaitingEnd ? `尚未确认 ${memberName} 已结束处理。` : '目前还不能继续这次请求。'}${queuedCopy}请先查看上次回复状态。`
      : `${notDispatched.length > 0 ? `${notDispatched.length} 条消息尚未发给 AI，原消息已保留。` : ''}上次回复没有完成，原消息和已有文件都已保留。你可以选择继续这次请求。`;
  return <div className="panel info" style={{margin: '8px 14px 0'}} data-zs-dm-interrupted="hifi">
    <div className="row tight wrap"><Icon name="alert-triangle" size={13}/><strong>{allNotDispatched ? `${memberName} 的请求尚未派发` : tasks.some(task => task.lastRunStatus === 'INTERRUPTED') ? `${memberName} 上次回复中断` : `${memberName} 上次回复没有完成`}</strong></div>
    <div className="small" style={{marginTop: 4}}>{summary}</div>
    {needsCheck && hasExecutedTask ? <button type="button" className="btn sm" style={{marginTop: 7}} data-zs-open-recovery="1" onClick={() => requestRecoveryOpen()}>检查上次回复</button> : null}
    {tasks.map(task => {
      const notDispatchedTask = isNotDispatched(task);
      return <div key={task.taskId} style={{marginTop: 7}} data-zs-dm-interrupted-task={task.taskId} data-zs-dm-interrupted-kind={notDispatchedTask ? 'pre-dispatch' : 'executed'}>
        <div className="row tight wrap">
          <span style={{flex: 1, minWidth: 0}}>{task.title}</span>
          {notDispatchedTask ? <span className="small faint">尚未发给 AI</span> : null}
          {task.recoverable ? <button type="button" className="btn sm" disabled={busy} title={notDispatchedTask ? '使用当前配置重新提交这条消息' : undefined} onClick={() => onRecover(task)}>{task.formatRepair ? '修复回复格式' : notDispatchedTask ? '按当前配置重新提交' : '继续这次请求'}</button> : null}
        </div>
        {notDispatchedTask ? <div className="small" style={{marginTop: 4, color: 'var(--text-2)', overflowWrap: 'anywhere'}} data-zs-dm-predispatch-reason="1">失败原因：{task.lastFailureReason ?? '记录中未提供可读原因（不推测）'}</div> : null}
        <details className="small faint" style={{marginTop: 4, overflowWrap: 'anywhere'}}><summary>{notDispatchedTask ? '未派发详情' : '诊断详情'}</summary>
          <div>任务：{task.taskId} · {notDispatchedTask ? '尚未发给 AI' : `上次执行：${task.lastRunId ?? '未记录'} · 状态：${task.lastRunStatus ?? '未记录'}`}</div>
          {!notDispatchedTask && task.lastFailureReason ? <div>中断记录：{task.lastFailureReason}</div> : null}
          {task.blockReason ? <div>当前限制：{task.blockReason}</div> : null}
        </details>
      </div>
    })}
  </div>;
}
