import { useEffect, useMemo, useState } from 'react';
import { runtimeProgressWaitLabel, type RuntimeActivityFact, type ThreadVisibleProgress } from '../../../contracts/runtimeProgress';
import { stageLabel } from '../lib/format';
import { Icon } from './Icon';

const ACTION_LABEL: Record<RuntimeActivityFact['action'], string> = {
  read: '读取文件',
  search: '搜索',
  command: '执行命令',
  edit: '编辑文件',
  other: '工具活动',
};

function secondsText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function agoText(at: number | null, now: number): string {
  if (at == null) return '暂未收到新活动';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `最近活动 ${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  return `最近活动 ${minutes} 分 ${seconds % 60} 秒前`;
}

function activityCopy(activity: RuntimeActivityFact): string {
  const verb = ACTION_LABEL[activity.action];
  if (activity.status === 'failure') return `${verb}失败${activity.target ? ` · ${activity.target}` : ''}`;
  if (activity.status === 'started') return `正在${verb}${activity.target ? ` · ${activity.target}` : ''}`;
  if (activity.status === 'success') return `${verb}完成${activity.target ? ` · ${activity.target}` : ''}`;
  return `${verb}结果未知${activity.target ? ` · ${activity.target}` : ''}`;
}

/** Local 1-second clock; polling only discovers new facts, it never drives the elapsed display. */
export function LiveProgressCard({
  progress,
  memberName,
  readError,
  readAt,
}: {
  progress: ThreadVisibleProgress;
  memberName: string;
  readError?: string | null;
  readAt?: number;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress.turnId]);

  const activities = progress.activities ?? [];
  const active = [...activities].reverse().find((activity) => activity.status === 'started');
  const latest = active ?? activities.at(-1) ?? null;
  const elapsed = progress.executionStartedAt == null ? null : secondsText(now - progress.executionStartedAt);
  const waitLabel = active != null && progress.status === 'RUNNING'
    ? '工具执行中'
    : runtimeProgressWaitLabel(progress, now);
  const text = progress.text?.trim() ?? '';
  const activityDetail = useMemo(
    () => (progress.activities ?? []).slice(-12),
    [progress.activities],
  );

  return (
    <div className="panel live-progress" role="status" data-zs-live-progress={progress.turnId}>
      <div className="row tight wrap live-progress-head">
        <span className="strong">{memberName}</span>
        {progress.stage ? <span className="small faint">{stageLabel(progress.stage)}</span> : null}
        {elapsed != null ? <span className="small faint" data-zs-live-elapsed>{`本轮已用时 ${elapsed}`}</span> : null}
        <span className="small faint" data-zs-live-wait={progress.status}>{waitLabel}</span>
      </div>
      <div className="small live-progress-activity" data-zs-live-activity={latest?.status ?? 'none'}>
        {latest != null
          ? <><Icon name={latest.status === 'failure' ? 'alert-triangle' : latest.status === 'started' ? 'activity' : 'check-circle'} size={12} /> {activityCopy(latest)} <span className="faint">· {agoText(latest.completedAt ?? latest.startedAt, now)}</span></>
          : <><Icon name="clock" size={12} /> {agoText(progress.lastActivityAt, now)}</>}
      </div>
      {text.length > 0 ? <div className="live-progress-text">{text}</div> : null}
      {activityDetail.length > 0 ? (
        <details className="live-progress-details">
          <summary>展开活动（{activityDetail.length} 项）</summary>
          <ol>
            {activityDetail.map((activity) => (
              <li key={activity.toolCallId} data-zs-activity-status={activity.status}>
                <span className="small">{activityCopy(activity)}</span>
                {activity.resultSummary ? <span className="small faint"> · {activity.resultSummary}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {readError ? <div className="small faint">进展刷新失败，保留上次事实 · {readAt ? new Date(readAt).toLocaleTimeString() : '时间未知'} · {readError}</div> : null}
    </div>
  );
}
