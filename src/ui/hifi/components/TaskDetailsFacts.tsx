import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskDetailsResult, TaskHistoryPage, TaskDetailEvent, TaskDetailRun } from '../../../contracts/taskDetails.ts';
import { command } from '../bridge';
import { RunStatusTag, TaskStatusTag } from './ui';
import { fullTime } from '../lib/format';

// Pending transports only, not a fact cache. Returning to the same target joins its existing read.
const detailReads = new Map<string, Promise<TaskDetailsResult>>();
function readDetails(key: string, params: { projectId: string; taskId: string; runId?: string }) {
  const existing = detailReads.get(key);
  if (existing) return existing;
  const pending = command<TaskDetailsResult>('task.details', params).finally(() => {
    if (detailReads.get(key) === pending) detailReads.delete(key);
  });
  detailReads.set(key, pending);
  return pending;
}

export function useTaskDetails(projectId: string | undefined, taskId: string | undefined, revision: number | undefined, runId: string | undefined, runStatus: string | undefined) {
  const target = JSON.stringify([projectId, taskId]);
  const [requested, setRequested] = useState<{ target: string; runId: string } | null>(null);
  const selectedRunId = requested?.target === target ? requested.runId : runId;
  const key = JSON.stringify([projectId, taskId, selectedRunId]);
  const [state, setState] = useState<{ key: string; data: TaskDetailsResult | null; error: string | null; loading: boolean; updatedAt: number | null }>({ key: '', data: null, error: null, loading: false, updatedAt: null });
  const read = useRef<(() => void) | null>(null);
  const source = useRef({ key, revision, runStatus });
  const refresh = useCallback(() => read.current?.(), []);
  const selectRun = useCallback((id: string) => { if (taskId) setRequested({ target, runId: id }); }, [target, taskId]);
  useEffect(() => {
    if (!projectId || !taskId) return;
    let alive = true; let busy = false; let pending = false; let intent = 0;
    const visible = () => document.visibilityState !== 'hidden' && !document.body.classList.contains('legacy-on');
    const request = () => {
      if (!alive) return;
      if (!visible()) { pending = true; return; }
      if (busy) { pending = true; return; }
      busy = true; pending = false; const ticket = ++intent;
      setState(old => ({ key, data: old.key === key ? old.data : null, error: old.key === key ? old.error : null, updatedAt: old.key === key ? old.updatedAt : null, loading: true }));
      void readDetails(key, { projectId, taskId, ...(selectedRunId ? { runId: selectedRunId } : {}) }).then(
        data => { if (alive && ticket === intent && visible()) setState({ key, data, error: null, loading: false, updatedAt: Date.now() }); },
        (e: unknown) => { if (alive && ticket === intent && visible()) setState(old => ({ key, data: old.key === key ? old.data : null, updatedAt: old.key === key ? old.updatedAt : null, error: e instanceof Error ? e.message : String(e), loading: false })); },
      ).finally(() => { busy = false; if (alive && pending && visible()) request(); });
    };
    const visibility = () => { if (!visible()) { intent++; pending = true; } else request(); };
    read.current = request;
    document.addEventListener('visibilitychange', visibility);
    let wasVisible = visible();
    const takeover = new MutationObserver(() => { const now = visible(); if (now !== wasVisible) { wasVisible = now; visibility(); } });
    takeover.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Polls skip in-flight reads rather than accumulating a queue. Explicit intent coalesces once.
    const timer = window.setInterval(() => { if (!busy && visible()) request(); }, 5000);
    request();
    return () => { alive = false; intent++; read.current = null; window.clearInterval(timer); takeover.disconnect(); document.removeEventListener('visibilitychange', visibility); };
  }, [projectId, taskId, selectedRunId, key]);
  useEffect(() => {
    const old = source.current;
    source.current = { key, revision, runStatus };
    if (old.key === key && (old.revision !== revision || old.runStatus !== runStatus)) refresh();
  }, [key, revision, runStatus, refresh]);
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : null, loading: state.key === key && state.loading, updatedAt: state.key === key ? state.updatedAt : null, refresh, selectRun };
}

export function DetailReadState({ error, loading, updatedAt, refresh }: { error: string | null; loading: boolean; updatedAt?: number | null; refresh: () => void }) {
  return <div className="row tight wrap small" style={{ marginBottom: 8 }}>
    {error ? <span className="panel warning">详情读取失败：{error}。{updatedAt ? '保留上次成功读取的事实。' : '尚未取得详情快照。'}</span> : null}
    {updatedAt ? <span className="faint">更新于 {fullTime(updatedAt)}</span> : <span className="faint">尚未读取详情</span>}
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

const qualityLabel: Record<string,string> = { reported:'渠道报告', estimated:'估算', unknown:'未确认' };
const executionLabel: Record<string,string> = { PENDING:'待派发',DISPATCHING:'正在启动',RUNNING:'执行中',WAITING_APPROVAL:'等待批准',WAITING_INPUT:'等待输入',STOPPING:'停止中',SUCCEEDED:'执行成功',FAILED:'执行失败',CANCELLED:'已停止',UNKNOWN:'结果待核对' };
const purposeLabel: Record<string,string> = { stage_work:'任务执行',checkpoint:'检查点',format_repair:'格式修复' };
const roleLabel: Record<string,string> = { executor:'执行成员',coordinator:'协调成员',worker:'执行成员' };
const eventLabel: Record<string,string> = {
  'tool.started':'工具开始', 'tool.completed':'工具结束', 'turn.started':'开始执行', 'turn.completed':'执行完成', 'turn.failed':'执行失败',
  'usage.updated':'用量更新', 'message.completed':'回复已保存', 'task.reviewRecorded':'验收意见已记录', 'task.reworkRequested':'返工已请求',
  'run.reconcileRequired':'运行结果需要核对', 'task.deliveryCreated':'新交付已保存', 'run.started':'运行开始', 'run.failed':'运行失败',
  'input.requested':'等待补充输入', 'approval.requested':'等待批准',
};
export function isDiagnosticEvent(kind:string):boolean {
  return kind.startsWith('tool.') || /failed|failure/i.test(kind) || ['turn.statusChanged','run.reconcileRequired','input.requested','approval.requested'].includes(kind);
}
export function activityLabel(kind: string, status?:string|null): string {
  if(kind==='turn.statusChanged') return status!=null ? executionLabel[status]??'执行状态更新' : '执行状态更新';
  return eventLabel[kind] ?? (kind.includes('Failed') || kind.includes('failure') ? '执行诊断' : '执行记录');
}
export function budgetText(value: unknown): string {
  if (value == null || typeof value !== 'object') return '无可解析的预算记录';
  const b=value as Record<string,unknown>; const n=(key:string)=>typeof b[key]==='number'?String(b[key]):'未提供';
  return `调用上限 ${n('maxTurns')} · 已结算 ${n('usedTurns')} · 在途预占 ${n('inFlightReservedTurns')}。这是调用额度，不代表费用或 token 余额。`;
}

/** Only the newest cumulative record is summarized; never add cumulative snapshots. */
export function usageSummary(records: Array<{normalized:unknown;quality:string}>): string {
  const cumulative=records.find(u=>u.normalized!=null&&typeof u.normalized==='object'&&(u.normalized as Record<string,unknown>).accounting==='cumulative');
  return cumulative ? `最近累计上报：${usageText(cumulative.normalized,cumulative.quality)}；其余记录未重复相加。` : '没有累计上报；以下是独立增量或未明口径的记录，不据部分记录推算总用量。';
}

function usageText(value: unknown, quality: string): string {
  if (value == null || typeof value !== 'object') return `用量数据无法解析 · 质量 ${qualityLabel[quality] ?? '未确认'}`;
  const u = value as Record<string, unknown>;
  const n = (key: string): string => typeof u[key] === 'number' ? String(u[key]) : '未报告';
  return `${u.accounting === 'delta' ? '本次增量' : u.accounting === 'cumulative' ? '累计上报' : '上报口径未明'} · 输入 ${n('inputTokens')} tokens · 缓存 ${n('cachedTokens')} tokens · 输出 ${n('outputTokens')} tokens · 成本 ${typeof u.cost === 'number' ? `${u.cost} ${typeof u.currency === 'string' ? u.currency : ''}` : '未报告'} · 质量 ${qualityLabel[quality] ?? '未确认'}${typeof u.model === 'string' ? ` · 模型 ${u.model}` : ''}`;
}

/** One bounded page at a time, no ever-growing history cache. */
function HistoryReader({ detail, kind, runId, cursor, onSelectRun }: { detail:TaskDetailsResult; kind:'runs'|'activity'|'deliveries'; runId?:string; cursor?:string|null; onSelectRun?:(id:string)=>void }) {
  const key=JSON.stringify([detail.task.projectId,detail.task.id,kind,runId]);
  const [state,setState]=useState<{key:string;page:TaskHistoryPage|null;error:string|null;loading:boolean}>({key:'',page:null,error:null,loading:false});
  const ticket=useRef(0);const busy=useRef(false);
  useEffect(()=>{busy.current=false;ticket.current++;return()=>{ticket.current++;};},[key]);
  const current=state.key===key?state:null;
  const next=current?.page?current.page.nextCursor:cursor;
  const load=()=>{if(busy.current||!next)return;busy.current=true;const id=++ticket.current;setState(old=>({key,page:old.key===key?old.page:null,error:null,loading:true}));
    void command<TaskHistoryPage>('task.history',{projectId:detail.task.projectId,taskId:detail.task.id,kind,...(runId?{runId}:{}),cursor:next}).then(page=>{if(ticket.current===id)setState({key,page,error:null,loading:false});},(e:unknown)=>{if(ticket.current===id)setState(old=>({...old,error:e instanceof Error?e.message:String(e),loading:false}));}).finally(()=>{if(ticket.current===id)busy.current=false;});};
  if (!next && !current?.page && !current?.loading && !current?.error) return null;
  return <div className="card tight" data-zs-history={kind}>
    {current?.page?<><div className="faint small">更早历史页 · 每页最多 {kind==='runs'?20:kind==='deliveries'?50:120} 条；仅保存当前页。</div>
      {kind==='runs'?(current.page.items as TaskDetailRun[]).map(r=><div key={r.id}><RunStatusTag status={r.status as Parameters<typeof RunStatusTag>[0]['status']}/><button className="btn ghost sm" onClick={()=>onSelectRun?.(r.id)}>查看这次运行</button><details className="faint small"><summary>运行身份</summary>{r.id}</details></div>):null}
      {kind==='activity'?(current.page.items as TaskDetailEvent[]).map(e=><div key={e.seq} className="small">{fullTime(e.at)} · {activityLabel(e.kind,e.status)}{e.summary?` · ${e.summary}`:''}<details className="faint"><summary>事件身份</summary>#{e.seq} · {e.kind} · run {e.runId??'—'}</details></div>):null}
      {kind==='deliveries'?(current.page.items as TaskDetailsResult['deliveries']).map(d=><div key={d.id}><a href={d.locate}>交付 v{d.revision}</a> · {reviewLabel[d.reviewStatus]??d.reviewStatus}{d.reviewNote?<div>{d.reviewNote}</div>:null}<details className="faint small"><summary>版本身份</summary>{d.id} · {d.manifestHash}</details></div>):null}
      {current.page.items.length===0?<span>本页权威读取为空。</span>:null}
      <button className="btn ghost sm" disabled={current?.loading} onClick={()=>{ticket.current++;busy.current=false;setState({key,page:null,error:null,loading:false});}}>返回最新窗口</button></>:null}
    {current?.error?<div className="panel warning">历史读取失败：{current.error}。保留已读取的当前页，可重试。</div>:null}
    {next?<button className="btn ghost sm" disabled={current?.loading} onClick={load}>{current?.error?'重试读取更早历史':'加载更早历史'}</button>:current?.page?<span className="faint small">已到历史起点</span>:null}
    {current?.loading?<span className="faint small">正在读取历史…</span>:null}
  </div>;
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
      {r.detailLoaded === false ? <div className="faint small">在运行详情中选择本次运行后读取执行成员。</div> : null}
      {r.participants.length > 0 ? r.participants.map((p) => <div key={p.memberId} className="small">{p.displayName} · {roleLabel[p.role]??'参与成员'} · {executionLabel[p.status]??'状态未提供'}{p.expected ? '' : ' · 非预期参与'}<details className="faint"><summary>参与身份</summary>{p.role} · {p.status}</details></div>) : null}
      {r.turns.map((t) => <div key={t.id} className="small">{t.displayName} · {executionLabel[t.status]??'状态未提供'} · {purposeLabel[t.purpose]??'执行轮次'} · 第 {t.attempt} 次尝试</div>)}
      {r.detailLoaded !== false && r.participants.length === 0 && r.turns.length === 0 ? <div className="faint small">本次运行尚无成员参与记录。</div> : null}
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
        <dt>预算</dt><dd>{r.budget == null ? '无预算记录' : <>{budgetText(r.budget)}<details className="small faint"><summary>预算原始详情</summary><pre>{JSON.stringify(r.budget,null,2)}</pre></details></>}</dd>
        <dt>执行轮次</dt><dd>{r.turns.length === 0 ? '尚无轮次' : r.turns.map((t) => <div key={t.id}>
          {t.displayName} · {executionLabel[t.status]??'状态未提供'} · {purposeLabel[t.purpose]??'执行轮次'} · 第 {t.attempt} 次尝试
          {t.usage.length > 0 ? <details><summary>用量记录（{t.usage.length}）</summary><div>{usageSummary(t.usage)}</div>{t.usage.map((u, k) => <div key={k} className="small">{usageText(u.normalized, u.quality)}</div>)}{t.usageTruncated ? '仅显示最近 50 条' : null}</details> : ' · 无用量记录'}
          <details className="small faint"><summary>轮次身份与原始状态</summary>{t.id} · {t.status} · {t.stageKey} · {t.purpose}</details>
        </div>)}{r.turnsTruncated ? '仅显示最近 80 轮' : null}</dd>
      </dl><details className="small faint"><summary>运行身份</summary>{r.id} · revision {r.revision}</details>
      <div className="section-title">工具与诊断活动</div>
      {r.events.filter((e) => isDiagnosticEvent(e.kind)).length === 0
        ? <div className="faint small">这次运行的可见窗口没有工具或诊断事件。</div>
        : r.events.filter((e) => isDiagnosticEvent(e.kind)).map((e) =>
          <div key={e.seq} className="small">{fullTime(e.at)} · {activityLabel(e.kind,e.status)}{e.summary ? ` · ${e.summary}` : ''}<details className="faint"><summary>活动身份</summary>{e.kind}{e.code?` · ${e.code}`:''} · 事件 #{e.seq} · 轮次 {e.turnId ?? '—'} · 工具 {e.toolCallId ?? '—'}</details></div>)}
      {r.eventsTruncated ? <div className="faint small">仅显示这次运行最近 120 条事件。</div> : null}<HistoryReader detail={detail} kind="activity" runId={r.id} cursor={detail.nextCursors?.runActivity}/>
      </>}
    </div>)}
    {detail.truncated.runs ? <div className="faint small">显示最近 20 次运行及已定位的旧运行；其他历史运行未在本窗口内。</div> : null}
    <HistoryReader detail={detail} kind="runs" cursor={detail.nextCursors?.runs} onSelectRun={onSelectRun}/>
  </div>;
}

export function TaskEventFacts({ detail }: { detail: TaskDetailsResult }) {
  return <div className="card tight"><div className="section-title">正式活动记录</div>
    {detail.events.length === 0 ? <div className="faint small">没有任务事件记录。</div> : detail.events.map((e) => <div key={e.seq} className="small" style={{ marginBottom: 5 }}><span className="faint">{fullTime(e.at)}</span> · {activityLabel(e.kind,e.status)}{e.summary ? ` · ${e.summary}` : ''}<details className="faint"><summary>事件身份</summary>{e.kind} · #{e.seq} · run {e.runId ?? '—'} · turn {e.turnId ?? '—'} · 工具 {e.toolCallId ?? '—'}</details></div>)}
    {detail.truncated.events ? <div className="faint small">当前显示最近 120 条活动。</div> : null}<HistoryReader detail={detail} kind="activity" cursor={detail.nextCursors?.activity}/>
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
    </div>)}{detail.truncated.deliveries ? <div className="faint small">仅显示最近 50 个版本</div> : null}<HistoryReader detail={detail} kind="deliveries" cursor={detail.nextCursors?.deliveries}/>
    <div className="section-title">已保存成果</div>
    {detail.artifacts.length === 0 ? <div className="faint small">没有任务成果记录。</div> : detail.artifacts.map((a) => <div key={a.id} className="small">{a.kind} · v{a.revision}<details className="faint"><summary>成果身份</summary>{a.id} · hash {a.hash}</details></div>)}
    {detail.truncated.artifacts ? <div className="faint small">仅显示最近 100 个成果</div> : null}
  </div>;
}
