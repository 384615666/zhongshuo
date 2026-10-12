import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskDetailsResult } from '../../../contracts/taskDetails.ts';
import { command } from '../bridge';
import { RunStatusTag, TaskStatusTag } from './ui';
import { fullTime } from '../lib/format';

export function useTaskDetails(projectId: string | undefined, taskId: string | undefined, revision: number | undefined, runId: string | undefined, runStatus: string | undefined) {
  const [state, setState] = useState<{ taskId: string; data: TaskDetailsResult | null; error: string | null; loading: boolean }>({ taskId: '', data: null, error: null, loading: false });
  const generation = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [requested, setRequested] = useState<{ taskId: string; runId: string } | null>(null);
  const selectedRunId = requested != null && requested.taskId === taskId ? requested.runId : runId;
  const refresh = useCallback(() => setRefreshKey((x) => x + 1), []);
  const selectRun = useCallback((id: string) => { if (taskId) setRequested({ taskId, runId: id }); }, [taskId]);
  useEffect(() => {
    const gen = ++generation.current;
    if (!projectId || !taskId) return;
    setState((old) => ({ taskId, data: old.taskId === taskId ? old.data : null, error: null, loading: true }));
    void command<TaskDetailsResult>('task.details', { projectId, taskId, ...(selectedRunId ? { runId: selectedRunId } : {}) }).then(
      (data) => { if (generation.current === gen) setState({ taskId, data, error: null, loading: false }); },
      (e: unknown) => { if (generation.current === gen) setState((old) => ({ taskId, data: old.taskId === taskId ? old.data : null, error: e instanceof Error ? e.message : String(e), loading: false })); },
    );
    return () => { generation.current += 1; };
  }, [projectId, taskId, revision, selectedRunId, runStatus, refreshKey]);
  return { data: state.taskId === taskId ? state.data : null, error: state.taskId === taskId ? state.error : null, loading: state.taskId === taskId && state.loading, refresh, selectRun };
}

export function DetailReadState({ error, loading, refresh }: { error: string | null; loading: boolean; refresh: () => void }) {
  return <div className="row tight wrap small" style={{ marginBottom: 8 }}>
    {error ? <span className="panel warning">详情读取失败：{error}。以下保留上次成功读取的事实。</span> : null}
    {loading ? <span className="faint">正在读取正式详情…</span> : null}
    <button className="btn ghost sm" onClick={refresh}>刷新详情</button>
  </div>;
}

const reviewLabel: Record<string, string> = { pending: '待验收', accepted: '已验收', changes_requested: '已要求修改', superseded: '已被新版替代', not_required: '无需人工验收' };

/** Keep task progress separate from the latest attempt's outcome. */
export function taskRunGuidance(detail: TaskDetailsResult): string {
  const latest = detail.runs.find((r) => r.id === detail.latestRunId);
  if (detail.task.status === 'BLOCKED') return '任务受阻。查看活动与运行诊断中的具体原因，处理成员、权限或前置条件后，再由原任务入口显式重试。';
  if (detail.task.status === 'REVIEW') return '新交付等待人工验收；在「交付与验收」核对当前版本后决定。';
  if (detail.task.status === 'DONE') return '任务已完成；历史运行与验收记录仍可查看。';
  if (detail.task.status === 'CANCELLED') return '任务已取消；历史运行保留。';
  if (latest == null) return '任务尚无运行；检查派发条件或从原任务入口明确发起。';
  if (latest.status === 'QUEUED') return '本次运行已排队，等待派发。若持续无进展，检查成员运行状态和派发门；停止请用原任务的停止入口。';
  if (latest.status === 'RUNNING') return '本次运行正在执行。可查看下方活动；需要停止时使用原任务的停止入口。';
  if (latest.status === 'WAITING') return '本次运行正在等待输入或批准；到回复串查看明确的待处理请求。';
  if (latest.status === 'STOPPING') return '停止请求正在收敛；先等待状态刷新，避免重复派发。';
  if (latest.status === 'INTERRUPTED') return '本次运行已中断，结果可能尚未确认。先到恢复入口核对退出与保护状态，再决定是否继续。';
  if (latest.status === 'FAILED' && detail.failedRetry.pending) return '最近一次运行失败；继续请求已入队，等待正式 worker 派发。请勿重复提交。';
  if (latest.status === 'FAILED' && detail.failedRetry.blockReason) return `最近一次运行失败，任务仍未完成。当前不能继续：${detail.failedRetry.blockReason}`;
  if (latest.status === 'FAILED') return `最近一次运行失败；任务仍是${detail.task.status === 'ACTIVE' ? '待继续处理' : detail.task.status}。查看诊断、修复原因后，在「运行详情」点“继续最近失败运行”。`;
  if (latest.status === 'PARTIAL') return '最近一次运行只完成一部分；查看诊断与已有成果，再从原回复串明确补充需要处理的部分。';
  return '查看活动、交付及验收记录，确认任务下一步。';
}

function usageText(value: unknown, quality: string): string {
  if (value == null || typeof value !== 'object') return `用量数据无法解析 · 质量 ${quality}`;
  const u = value as Record<string, unknown>;
  const n = (key: string): string => typeof u[key] === 'number' ? String(u[key]) : '未报告';
  return `${u.accounting === 'delta' ? '本次增量' : u.accounting === 'cumulative' ? '累计上报' : '上报口径未明'} · 输入 ${n('inputTokens')} tokens · 缓存 ${n('cachedTokens')} tokens · 输出 ${n('outputTokens')} tokens · 成本 ${typeof u.cost === 'number' ? `${u.cost} ${typeof u.currency === 'string' ? u.currency : ''}` : '未报告'} · 质量 ${quality}${typeof u.model === 'string' ? ` · 模型 ${u.model}` : ''}`;
}

export function TaskExtraFacts({ detail }: { detail: TaskDetailsResult }) {
  return <div className="card tight">
    <div className="section-title">任务与关联记录</div>
    <dl className="kv">
      <dt>原目标</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{detail.task.objective || '未记录独立目标，以原始要求为准'}</dd>
      <dt>验收策略</dt><dd>{detail.task.reviewPolicy === 'user_review' ? '需要人工验收' : '自动交付'}</dd>
      <dt>负责人</dt><dd>{detail.task.ownerDisplayName ?? '未指定'}</dd>
      <dt>子任务</dt><dd>{detail.children.length === 0 ? '没有记录' : detail.children.map((c) => <div key={c.id}><a href={c.locate}>{c.title}</a> · <TaskStatusTag status={c.status as Parameters<typeof TaskStatusTag>[0]['status']} /></div>)}{detail.truncated.children ? '仅显示最近 50 条' : null}</dd>
      <dt>改动集</dt><dd>{detail.changeSets.length === 0 ? '没有记录' : detail.changeSets.map((c) => <div key={c.id}>文件应用：{c.applicationStatus} · <a href={c.locate}>定位任务</a>{c.files.map((f) => <div key={f.path} className="small">{f.path} · {f.state}{f.size == null ? '' : ` · ${f.size} 字节`}</div>)}{c.filesTruncated ? <div className="faint small">仅显示前 100 个文件</div> : null}<details className="small faint"><summary>改动集身份</summary>{c.id} · {c.beforeRef} → {c.afterRef}</details></div>)}{detail.truncated.changeSets ? '仅显示最近 100 条' : null}</dd>
    </dl>
    <details className="small faint"><summary>技术身份</summary>任务 {detail.task.id} · 项目 {detail.task.projectId} · 负责人 {detail.task.ownerMemberId ?? '—'} · revision {detail.task.revision}</details>
  </div>;
}

export function ActualMembers({ detail }: { detail: TaskDetailsResult }) {
  return <div className="card tight">
    <div className="section-title">实际执行成员</div>
    {detail.runs.length === 0 ? <div className="faint small">尚无运行与执行轮次。</div> : detail.runs.map((r) => <div key={r.id} style={{ marginBottom: 8 }}>
      <div className="small strong">{r.mode} · <RunStatusTag status={r.status as Parameters<typeof RunStatusTag>[0]['status']} /></div>
      {r.participants.length > 0 ? r.participants.map((p) => <div key={p.memberId} className="small">{p.displayName} · {p.role} · {p.status}{p.expected ? '' : ' · 非预期参与'}</div>) : null}
      {r.turns.map((t) => <div key={t.id} className="small">{t.displayName} · {t.status} · {t.stageKey} · 第 {t.attempt} 次尝试</div>)}
      {r.participants.length === 0 && r.turns.length === 0 ? <div className="faint small">本次运行尚无成员参与记录。</div> : null}
      {r.turnsTruncated ? <div className="faint small">仅显示最近 80 轮</div> : null}
    </div>)}
    {detail.truncated.runs ? <div className="faint small">显示最近 20 次运行及已定位的旧运行；其他历史运行未在本窗口内。</div> : null}
  </div>;
}

export function RunExtraFacts({ detail, onSelectRun, onRetryFailed, retryBusy = false }: { detail: TaskDetailsResult; onSelectRun?: (runId: string) => void; onRetryFailed?: () => void; retryBusy?: boolean }) {
  const selected = detail.runs.find((r) => r.id === detail.selectedRunId);
  const ordered = selected != null && selected.id !== detail.latestRunId
    ? [selected, ...detail.runs.filter((r) => r.id !== selected.id)] : detail.runs;
  return <div className="msg-list">
    <div className="panel info">{taskRunGuidance(detail)}</div>
    {detail.failedRetry.available && onRetryFailed ? <button className="btn sm primary" disabled={retryBusy} onClick={onRetryFailed}>继续最近失败运行</button> : null}
    {detail.failedRetry.available && retryBusy ? <span className="faint small">继续请求正在提交或核对，暂不重复发送。</span> : null}
    {detail.failedRetry.pending ? <div className="panel info">继续已入队；等待派发结果。</div> : null}
    {detail.runs.length === 0 ? <div className="card tight">任务尚无运行记录。</div> : ordered.map((r) => <div key={r.id} className="card tight">
      <div className="section-title">{r.id === detail.currentRunId ? '当前运行' : r.id === detail.latestRunId ? '最近运行' : '历史运行'}{r.id === detail.selectedRunId && detail.selectedRunId !== detail.latestRunId ? ' · 已定位' : ''} · {r.mode}</div>
      {r.id !== detail.selectedRunId && onSelectRun ? <button className="btn ghost sm" onClick={() => onSelectRun(r.id)}>查看这次运行</button> : null}
      {r.id !== detail.selectedRunId ? <div className="small"><RunStatusTag status={r.status as Parameters<typeof RunStatusTag>[0]['status']} /> · 选择后查看轮次、用量与工具活动</div> : <>
      <dl className="kv"><dt>状态</dt><dd><RunStatusTag status={r.status as Parameters<typeof RunStatusTag>[0]['status']} /></dd>
        <dt>阶段 / 轮次</dt><dd>{r.stage ?? '无阶段记录'}{r.roundNo == null ? '' : ` · 第 ${r.roundNo} 轮`}</dd>
        <dt>预算</dt><dd>{r.budget == null ? '无预算记录' : <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.budget, null, 2)}</pre>}</dd>
        <dt>执行轮次</dt><dd>{r.turns.length === 0 ? '尚无轮次' : r.turns.map((t) => <div key={t.id}>
          {t.displayName} · {t.status} · {t.stageKey} · 第 {t.attempt} 次尝试
          {t.usage.length > 0 ? <details><summary>用量记录（{t.usage.length}）</summary>{t.usage.map((u, k) => <div key={k} className="small">{usageText(u.normalized, u.quality)}</div>)}{t.usageTruncated ? '仅显示最近 50 条' : null}</details> : ' · 无用量记录'}
          <details className="small faint"><summary>轮次身份</summary>{t.id}</details>
        </div>)}{r.turnsTruncated ? '仅显示最近 80 轮' : null}</dd>
      </dl><details className="small faint"><summary>运行身份</summary>{r.id} · revision {r.revision}</details>
      <div className="section-title">工具与诊断活动</div>
      {r.events.filter((e) => e.kind.startsWith('tool.') || e.kind.includes('Failed') || e.kind.includes('failure') || e.kind === 'run.reconcileRequired').length === 0
        ? <div className="faint small">这次运行的可见窗口没有工具或诊断事件。</div>
        : r.events.filter((e) => e.kind.startsWith('tool.') || e.kind.includes('Failed') || e.kind.includes('failure') || e.kind === 'run.reconcileRequired').map((e) =>
          <div key={e.seq} className="small">{fullTime(e.at)} · {e.kind === 'tool.started' ? '工具开始' : e.kind === 'tool.completed' ? '工具结束' : e.kind}{e.summary ? ` · ${e.summary}` : ''}<details className="faint"><summary>活动身份</summary>事件 #{e.seq} · 轮次 {e.turnId ?? '—'} · 工具 {e.toolCallId ?? '—'}</details></div>)}
      {r.eventsTruncated ? <div className="faint small">仅显示这次运行最近 120 条事件；更早的工具或诊断未在本窗口内。</div> : null}
      </>}
    </div>)}
    {detail.truncated.runs ? <div className="faint small">显示最近 20 次运行及已定位的旧运行；其他历史运行未在本窗口内。</div> : null}
  </div>;
}

export function TaskEventFacts({ detail }: { detail: TaskDetailsResult }) {
  return <div className="card tight"><div className="section-title">正式活动记录</div>
    {detail.events.length === 0 ? <div className="faint small">没有任务事件记录。</div> : detail.events.map((e) => <div key={e.seq} className="small" style={{ marginBottom: 5 }}><span className="faint">{fullTime(e.at)}</span> · {e.kind}{e.summary ? ` · ${e.summary}` : ''}<details className="faint"><summary>事件身份</summary>#{e.seq} · run {e.runId ?? '—'} · turn {e.turnId ?? '—'} · 工具 {e.toolCallId ?? '—'}</details></div>)}
    {detail.truncated.events ? <div className="faint small">仅显示最近 120 条活动；旧界面可继续查询历史事件。</div> : null}
  </div>;
}

export function DeliveryHistoryFacts({ detail }: { detail: TaskDetailsResult }) {
  return <div className="card tight"><div className="section-title">交付版本与验收历史</div>
    {detail.deliveries.length === 0 ? <div className="faint small">尚无正式交付版本。</div> : detail.deliveries.map((d) => <div key={d.id} style={{ marginBottom: 10 }}>
      <a href={d.locate}>交付 v{d.revision}</a> · {reviewLabel[d.reviewStatus] ?? d.reviewStatus}{d.reviewedAt != null ? ` · ${fullTime(d.reviewedAt)}` : ''}
      {d.reviewNote ? <div className="small">验收意见：{d.reviewNote}</div> : null}
      <div className="small faint">成果引用 {d.artifactRefs.length} · 验证引用 {d.verificationRefs.length} · 改动集 {d.changeSetRefs.length}</div>
      {d.artifactRefs.length > 0 ? <details className="small"><summary>成果引用</summary>{d.artifactRefs.map((x) => <div key={x} className="mono-sm">{x}</div>)}</details> : null}
      {d.verificationRefs.length > 0 ? <details className="small"><summary>验证引用</summary>{d.verificationRefs.map((x) => <div key={x} className="mono-sm">{x}</div>)}</details> : null}
      {d.changeSetRefs.length > 0 ? <details className="small"><summary>改动集引用</summary>{d.changeSetRefs.map((x) => <div key={x} className="mono-sm">{x}</div>)}</details> : null}
      <details className="small faint"><summary>版本身份</summary>{d.id} · manifest {d.manifestHash} · run {d.runId ?? '—'}</details>
    </div>)}{detail.truncated.deliveries ? <div className="faint small">仅显示最近 50 个版本</div> : null}
    <div className="section-title">已保存成果</div>
    {detail.artifacts.length === 0 ? <div className="faint small">没有任务成果记录。</div> : detail.artifacts.map((a) => <div key={a.id} className="small">{a.kind} · v{a.revision}<details className="faint"><summary>成果身份</summary>{a.id} · hash {a.hash}</details></div>)}
    {detail.truncated.artifacts ? <div className="faint small">仅显示最近 100 个成果</div> : null}
  </div>;
}
