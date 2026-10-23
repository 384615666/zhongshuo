import type {DmConversation} from '../data/types';
import {requestRecoveryOpen} from '../lib/recovery';
import {Icon} from './Icon';

type InterruptedTask = NonNullable<DmConversation['interruptedTasks']>[number];

/** Readable next steps; raw recovery evidence remains available without becoming instructions. */
export function DmInterruptedNotice({tasks, memberName, queuedCount = 0, busy = false, onRecover}: {
  tasks: readonly InterruptedTask[];
  memberName: string;
  queuedCount?: number;
  busy?: boolean;
  onRecover: (task: InterruptedTask) => void;
}) {
  if (!tasks.length) return null;
  const needsCheck = tasks.some(task => !task.recoverable);
  const awaitingEnd = tasks.some(task => !task.recoverable && task.lastRunStatus === 'INTERRUPTED');
  return <div className="panel info" style={{margin: '8px 14px 0'}} data-zs-dm-interrupted="hifi">
    <div className="row tight wrap"><Icon name="alert-triangle" size={13}/><strong>{memberName} {tasks.some(task => task.lastRunStatus === 'INTERRUPTED') ? '上次回复中断' : '上次回复没有完成'}</strong></div>
    <div className="small" style={{marginTop: 4}}>
      {needsCheck ? `${awaitingEnd ? `尚未确认 ${memberName} 已结束处理。` : '目前还不能继续这次请求。'}${queuedCount > 0 ? `本对话有 ${queuedCount} 条消息在等待。` : ''}请先查看上次回复状态。` : '上次回复没有完成，原消息和已有文件都已保留。你可以选择继续这次请求。'}
    </div>
    {needsCheck ? <button type="button" className="btn sm" style={{marginTop: 7}} data-zs-open-recovery="1" onClick={() => requestRecoveryOpen()}>检查上次回复</button> : null}
    {tasks.map(task => <div key={task.taskId} style={{marginTop: 7}}>
      <div className="row tight wrap"><span style={{flex: 1, minWidth: 0}}>{task.title}</span>
        {task.recoverable ? <button type="button" className="btn sm" disabled={busy} onClick={() => onRecover(task)}>{task.formatRepair ? '修复回复格式' : '继续这次请求'}</button> : null}
      </div>
      <details className="small faint" style={{marginTop: 4, overflowWrap: 'anywhere'}}><summary>诊断详情</summary>
        <div>任务：{task.taskId} · 上次执行：{task.lastRunId ?? '未记录'} · 状态：{task.lastRunStatus ?? '未记录'}</div>
        {task.lastFailureReason ? <div>中断记录：{task.lastFailureReason}</div> : null}
        {task.blockReason ? <div>当前限制：{task.blockReason}</div> : null}
      </details>
    </div>)}
  </div>;
}
