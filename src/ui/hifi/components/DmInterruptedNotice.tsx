import { userFacingSystemText } from '../../../contracts/userFacingText';
import type {DmConversation} from '../data/types';
import {ContinueTaskButton} from './ContinueTaskButton';
import {Icon} from './Icon';

type InterruptedTask = NonNullable<DmConversation['interruptedTasks']>[number];

function isNotDispatched(task: InterruptedTask): boolean {
  return task.lastRunId == null && task.lastRunStatus == null;
}

function canContinue(task: InterruptedTask): boolean {
  if (task.recoverable || isNotDispatched(task)) return false;
  return task.lastRunStatus === 'UNKNOWN'
    || task.lastRunStatus === 'INTERRUPTED'
    || /retained|protection_state/i.test(task.blockReason ?? '');
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
  const needsContinue = tasks.some(canContinue);
  const awaitingEnd = tasks.some(task => canContinue(task) && task.lastRunStatus === 'INTERRUPTED');
  const queuedCopy = queuedCount > 0 ? `本对话有 ${queuedCount} 条消息在等待。` : '';
  const summary = allNotDispatched
    ? notDispatched.length === 1
      ? '这条消息尚未发给 AI，原消息已保留。处理下面原因后可重新提交。'
      : `这 ${notDispatched.length} 条消息尚未发给 AI，原消息均已保留。处理下面原因后可重新提交。`
    : needsContinue
      ? `${notDispatched.length > 0 ? `${notDispatched.length} 条消息尚未发给 AI，原消息已保留。` : ''}${awaitingEnd ? `${memberName} 的上次回复未完成，原消息和已有文件均已保留。` : '上次回复没有完成，原消息和已有文件都已保留。'}${queuedCopy}可以继续任务。`
      : `${notDispatched.length > 0 ? `${notDispatched.length} 条消息尚未发给 AI，原消息已保留。` : ''}上次回复没有完成，原消息和已有文件都已保留。${tasks.some(task => task.recoverable) ? '你可以选择继续这次请求。' : '请查看详情中的限制。'}`;
  return <div className="panel info" style={{margin: '8px 14px 0'}} data-zs-dm-interrupted="hifi">
    <div className="row tight wrap"><Icon name="alert-triangle" size={13}/><strong>{allNotDispatched ? `${memberName} 的请求尚未派发` : tasks.some(task => task.lastRunStatus === 'INTERRUPTED') ? `${memberName} 上次回复中断` : `${memberName} 上次回复没有完成`}</strong></div>
    <div className="small" style={{marginTop: 4}}>{summary}</div>
    {tasks.map(task => {
      const notDispatchedTask = isNotDispatched(task);
      return <div key={task.taskId} style={{marginTop: 7}} data-zs-dm-interrupted-task={task.taskId} data-zs-dm-interrupted-kind={notDispatchedTask ? 'pre-dispatch' : 'executed'}>
        <div className="row tight wrap">
          <span style={{flex: 1, minWidth: 0}}>{task.title}</span>
          {notDispatchedTask ? <span className="small faint">尚未发给 AI</span> : null}
          {canContinue(task) ? <ContinueTaskButton key={task.lastRunId} binding={{taskId:task.taskId,...(task.lastRunId?{sourceRunId:task.lastRunId}:{})}}/>:null}
          {task.recoverable ? <button type="button" className="btn sm" disabled={busy} title={notDispatchedTask ? '使用当前配置重新提交这条消息' : undefined} onClick={() => onRecover(task)}>{task.formatRepair ? '修复回复格式' : notDispatchedTask ? '按当前配置重新提交' : '继续这次请求'}</button> : null}
        </div>
        {notDispatchedTask ? <div className="small" style={{marginTop: 4, color: 'var(--text-2)', overflowWrap: 'anywhere'}} data-zs-dm-predispatch-reason="1">失败原因：{userFacingSystemText(task.lastFailureReason ?? '记录中未提供具体原因')}</div> : null}
        {(!notDispatchedTask && task.lastFailureReason) || task.blockReason ? <details className="small faint" style={{marginTop: 4, overflowWrap: 'anywhere'}}><summary>{notDispatchedTask ? '未派发详情' : '诊断详情'}</summary>
          {!notDispatchedTask && task.lastFailureReason ? <div>中断记录：{userFacingSystemText(task.lastFailureReason)}</div> : null}
          {task.blockReason ? <div>当前限制：{userFacingSystemText(task.blockReason ?? '')}</div> : null}
        </details> : null}
      </div>
    })}
  </div>;
}
