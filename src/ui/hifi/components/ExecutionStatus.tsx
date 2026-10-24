import type {
  TaskExecutionAction,
  TaskExecutionMember,
  TaskExecutionPhase,
  TaskExecutionStatus,
} from '../../../contracts/executionStatus.ts';
import { Icon, type IconName } from './Icon';
import { Tag } from './ui';

type TagTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

const PHASE: Record<TaskExecutionPhase, {
  label: string;
  tone: TagTone;
  icon: IconName;
}> = {
  NOT_STARTED_FAILED: { label: '未能开始', tone: 'danger', icon: 'alert-triangle' },
  QUEUED: { label: '排队中', tone: 'neutral', icon: 'clock' },
  ADMISSION_WAITING: { label: '等待另一任务', tone: 'warning', icon: 'pause' },
  RUNNING: { label: '正在执行', tone: 'info', icon: 'activity' },
  WAITING_FOR_PEER: { label: '等同伴', tone: 'warning', icon: 'clock' },
  WAITING_FOR_USER: { label: '等你处理', tone: 'warning', icon: 'hand' },
  STOPPING: { label: '正在停止', tone: 'warning', icon: 'stop' },
  UNKNOWN: { label: '待核对', tone: 'danger', icon: 'help-circle' },
  COMPLETED: { label: '已完成', tone: 'success', icon: 'check-circle' },
  FAILED: { label: '未完成', tone: 'danger', icon: 'x-circle' },
  CANCELLED: { label: '已停止', tone: 'neutral', icon: 'slash' },
  IDLE: { label: '未开始', tone: 'neutral', icon: 'circle' },
};

const ACTION_ICON: Record<TaskExecutionAction['kind'], IconName> = {
  navigate: 'arrow-right',
  recover: 'help-circle',
  review: 'clipboard-check',
  retry: 'play',
};

export interface TaskExecutionStatusSummary {
  label: string;
  main: string;
  detail: string | null;
  result: string | null;
}
export function taskExecutionNeedsReview(status:TaskExecutionStatus):boolean{
  return (status.phase==='COMPLETED'||status.phase==='WAITING_FOR_USER')
    &&status.evidence.taskStatus==='REVIEW'&&status.waitingForUser?.kind==='review';
}

function memberActivityText(member: TaskExecutionMember): string {
  const activity=member.activity;
  if(activity?.kind==='tool'&&activity.status==='started'){
    if(activity.action==='read'||activity.action==='search')return `${member.displayName}正在查资料`;
    if(activity.action==='edit')return `${member.displayName}正在处理文件`;
    if(activity.action==='command')return `${member.displayName}正在执行命令`;
    return `${member.displayName}正在使用工具`;
  }
  return `${member.displayName}正在处理任务`;
}

function memberWaitingText(member: TaskExecutionMember): string {
  if (member.state === 'waiting-user') return `${member.displayName}等你回复`;
  if (member.state === 'starting') return `${member.displayName}等待开始`;
  if (member.state === 'stopping') return `${member.displayName}正在停止`;
  if (member.state === 'unknown') return `${member.displayName}结果待核对`;
  return `${member.displayName}等待结果`;
}

function friendlyDetail(status: TaskExecutionStatus): string | null {
  if (status.phase === 'ADMISSION_WAITING') {
    const blocker = status.evidence.executionBlocker;
    if (blocker?.reason === 'member-occupied') {
      return `${blocker.blockingMemberName ?? '同一位 AI'}正在处理另一任务，结束后会继续。`;
    }
    if (blocker?.reason === 'write-root-occupied') {
      return '另一任务正在修改同一位置，结束后会继续。';
    }
    if (blocker?.reason === 'unknown-turn') {
      return '上一项任务还在核对；确认结束后才能安全继续。';
    }
    return '请求已登记，正在等待执行席位。';
  }
  if (status.phase === 'UNKNOWN') {
    if (status.reason.code === 'PROTECTION_RETAINED') return '上一次执行还没确认结束；需要先核对，暂时不能继续。';
    if (status.reason.code === 'NO_EXECUTION_EVIDENCE') return '没有取得可确认的执行进展，正在安全等待刷新。';
    return '上一次执行的结果还没确认；需要先核对，暂时不能继续。';
  }
  if (status.phase === 'NOT_STARTED_FAILED' || status.phase === 'FAILED') return status.reason.message;
  if (status.phase === 'STOPPING') return '停止请求已送出，正在等执行端确认。';
  if (status.phase === 'WAITING_FOR_USER') return status.waitingForUser?.message ?? status.reason.message;
  if (status.phase === 'WAITING_FOR_PEER') {
    return status.waitingMembers.length > 0
      ? `${status.waitingMembers.map(memberWaitingText).join('、')}。`
      : '正在等待同伴完成。';
  }
  if (status.phase === 'COMPLETED') return status.waitingForUser?.kind === 'review' ? '等待你验收。' : null;
  if (status.phase === 'CANCELLED') return '任务已停止。';
  if (status.phase === 'IDLE') return '任务尚未开始执行。';
  return null;
}

/** Shared compact copy builder for room cards and thread/DM headers. */
export function taskExecutionStatusSummary(status: TaskExecutionStatus): TaskExecutionStatusSummary {
  const needsReview=taskExecutionNeedsReview(status);
  const label = needsReview?'待你验收':PHASE[status.phase].label;
  const performing = status.actualPerformingMembers.map(memberActivityText).join('、');
  const waiting = status.waitingMembers.map(memberWaitingText).join('、');
  let main = performing.length > 0 ? performing : label;
  if (performing.length > 0 && waiting.length > 0) main = `${performing}；${waiting}`;

  if (status.phase === 'COMPLETED') {
    const delivery = status.existingResults.currentDelivery;
    main = needsReview?`等待你验收${delivery?` · 交付 v${delivery.revision}`:''}`:delivery == null ? '任务已完成' : `已完成 · 交付 v${delivery.revision}`;
  } else if (status.phase === 'QUEUED') {
    const member = status.waitingMembers[0];
    main = member == null ? '排队中' : `${member.displayName}排队等待执行`;
  } else if (status.phase === 'ADMISSION_WAITING') {
    main = '等待另一任务结束';
  } else if (status.phase === 'WAITING_FOR_USER') {
    main = '等待你处理';
  } else if (status.phase === 'UNKNOWN') {
    main = '执行结果待核对';
  } else if (status.phase === 'NOT_STARTED_FAILED') {
    main = '请求未能开始';
  } else if (status.phase === 'FAILED') {
    main = '执行未完成';
  } else if (status.phase === 'STOPPING') {
    main = '正在停止';
  } else if (status.phase === 'CANCELLED') {
    main = '已停止';
  } else if (status.phase === 'IDLE') {
    main = '尚未开始';
  }

  const result = status.existingResults.hasResults
    ? status.existingResults.deliveries.length > 0
      ? `已有 ${status.existingResults.deliveries.length} 份结果`
      : status.existingResults.artifacts.length > 0
        ? `已有 ${status.existingResults.artifacts.length} 个文件`
        : '已有可查看成果'
    : null;
  const detail = friendlyDetail(status);
  return { label, main, detail: detail === main ? null : detail, result };
}

function timeText(at: number | null): string {
  if (at == null || !Number.isFinite(at)) return '时间未知';
  return new Date(at).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function memberText(member: TaskExecutionMember): string {
  return `${member.displayName}${member.stage == null ? '' : ` · ${member.stage}`}`;
}

function resultText(status: TaskExecutionStatus): string {
  const results = status.existingResults;
  const parts = [
    results.deliveries.length > 0 ? `结果 ${results.deliveries.length}` : null,
    results.artifacts.length > 0 ? `文件 ${results.artifacts.length}` : null,
  ].filter((part): part is string => part != null);
  if (parts.length === 0 && results.changeSets.length === 0) return '尚无正式成果';
  const current = results.currentDelivery;
  return `${parts.join(' · ')}${current == null ? '' : ` · 当前 v${current.revision}（${current.reviewStatus === 'pending' ? '待验收' : current.reviewStatus === 'accepted' ? '已验收' : current.reviewStatus === 'changes_requested' ? '要求修改' : current.reviewStatus === 'superseded' ? '已被替代' : '无需验收'}）`}`;
}

export interface ExecutionStatusProps {
  status: TaskExecutionStatus;
  /** Parent surfaces bind this to existing navigation or formal command entry points. */
  onAction?: (action: TaskExecutionAction) => void;
  /** Compact is the pool/thread default. Detail exposes IDs and raw evidence only on demand. */
  density?: 'compact' | 'detail';
  className?: string;
}

/**
 * Pure execution projection renderer. It never polls, invents percentages or
 * converts elapsed transport time into work progress.
 */
export function ExecutionStatus({
  status,
  onAction,
  density = 'compact',
  className,
}: ExecutionStatusProps) {
  const presentation = taskExecutionNeedsReview(status)?{label:'待你验收',tone:'warning' as const,icon:'eye' as const}:PHASE[status.phase];
  const summary = taskExecutionStatusSummary(status);
  const firstAction = status.actions.find(action =>
    action.kind === 'recover' || action.kind === 'review' || action.kind === 'retry')
    ?? status.actions[0];
  const remainingActions = status.actions.filter(action => action !== firstAction);

  return (
    <section
      className={`panel${status.phase === 'FAILED' || status.phase === 'NOT_STARTED_FAILED' || status.phase === 'UNKNOWN' ? ' danger' : status.phase === 'WAITING_FOR_USER' || status.phase === 'ADMISSION_WAITING' || status.phase === 'WAITING_FOR_PEER' || status.phase === 'STOPPING' ? ' warning' : taskExecutionNeedsReview(status) ? ' warning' : status.phase === 'COMPLETED' ? ' success' : ' info'}${className == null ? '' : ` ${className}`}`}
      role="status"
      aria-live="polite"
      data-zs-execution-status={status.schemaVersion}
      data-zs-execution-phase={status.phase}
      data-zs-execution-density={density}
      data-zs-performing-members={status.actualPerformingMembers.map(member => member.displayName).join(',')}
      data-zs-waiting-members={status.waitingMembers.map(member => member.displayName).join(',')}
      data-zs-heartbeat-used={status.evidence.heartbeatUsedAsActivity ? '1' : '0'}
      style={{ margin: 0, padding: '8px 10px', overflow: 'hidden' }}
    >
      <div className="row tight" style={{ alignItems: 'center', gap: 7, minHeight: 22 }}>
        <Tag tone={presentation.tone} icon={presentation.icon}>{summary.label}</Tag>
        <span className="small strong truncate" style={{ flex: 1, minWidth: 120 }} data-zs-execution-summary>
          {summary.main}
        </span>
        {summary.detail != null ? (
          <span className="small faint truncate" style={{ flex: 1, minWidth: 120 }} data-zs-execution-detail>
            {summary.detail}
          </span>
        ) : null}
        {firstAction != null ? (
          <button
            type="button"
            className={`btn sm${firstAction.kind === 'recover' || firstAction.kind === 'retry' ? ' primary' : ' ghost'}`}
            data-zs-execution-action={firstAction.kind}
            data-zs-action-id={firstAction.id}
            disabled={onAction == null}
            title={onAction == null ? '父界面尚未接入该操作的正式处理入口' : undefined}
            onClick={onAction == null ? undefined : () => onAction(firstAction)}
          >
            <Icon name={ACTION_ICON[firstAction.kind]} size={12} />
            {firstAction.label}
          </button>
        ) : null}
      </div>

      {density === 'detail' ? (
        <>
          {status.waitingForUser != null ? (
            <div className="small" data-zs-waiting-for-user={status.waitingForUser.kind} style={{ marginTop: 4 }}>
              需要你：{status.waitingForUser.message}
            </div>
          ) : null}
          {status.reason.message !== summary.detail && status.reason.message !== summary.main ? (
            <div className="small faint" style={{ marginTop: 4 }}>{status.reason.message}</div>
          ) : null}
          {summary.result != null ? (
            <div className="row tight" style={{ marginTop: 4, gap: 6 }}>
              <Icon name="inbox" size={11} />
              <span className="small">{summary.result}</span>
            </div>
          ) : null}
          {remainingActions.length > 0 ? (
            <div className="row tight wrap" style={{ marginTop: 6, gap: 6 }}>
              {remainingActions.map(action => (
                <button
                  key={action.id}
                  type="button"
                  className="btn ghost sm"
                  data-zs-execution-action={action.kind}
                  data-zs-action-id={action.id}
                  disabled={onAction == null}
                  title={onAction == null ? '父界面尚未接入该操作的正式处理入口' : undefined}
                  onClick={onAction == null ? undefined : () => onAction(action)}
                >
                  <Icon name={ACTION_ICON[action.kind]} size={12} />
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
          <details style={{ marginTop: 7 }}>
            <summary className="small faint">诊断</summary>
            <div
              className="small faint"
              style={{ marginTop: 6, lineHeight: 1.65 }}
              data-zs-last-business-activity={status.lastBusinessActivity?.kind ?? 'none'}
            >
              <div>最后业务活动：{status.lastBusinessActivity == null ? '无可确认活动' : `${status.lastBusinessActivity.summary} · ${timeText(status.lastBusinessActivity.at)}`}</div>
              <div>成果：{resultText(status)}</div>
              {status.actualPerformingMembers.map(member => (
                <div key={`actual:${member.memberId}:${member.turnId ?? ''}`}>{memberText(member)} · {member.status} · {member.turnId ?? '无 turn'}</div>
              ))}
              {status.waitingMembers.map(member => (
                <div key={`waiting:${member.memberId}:${member.turnId ?? member.runId ?? ''}`}>{memberText(member)} · {member.reason}</div>
              ))}
              <div>事件 #{status.evidence.sourceHighWatermark} · 任务 {status.evidence.taskStatus} · revision {status.evidence.taskRevision} · stop generation {status.evidence.stopGeneration}</div>
              <div>运行 {status.evidence.runCount} · 执行轮次 {status.evidence.turnCount} · 在途 run {status.evidence.activeRunIds.length} · 未闭环 UNKNOWN {status.evidence.unknownTurnIds.length}</div>
              <div>待派发队列 {status.evidence.outbox?.pendingCount ?? 0} · 心跳参与业务活动：否</div>
              {status.existingResults.changeSets.map(change => (
                <div key={change.id}>变更集 {change.id} · {change.applicationStatus}</div>
              ))}
              <div>本投影只读；不会停止、重派、释放保护或修改准入。</div>
            </div>
          </details>
        </>
      ) : null}
    </section>
  );
}

export const ExecutionStatusCard = ExecutionStatus;
export default ExecutionStatus;
