/**
 * 恢复检查（r56 H4 §4——正式事实接线）：消费 `recovery.status` 只读聚合，四类动作**分列**：
 *  - 确认继续派发=dispatch.resume{confirm:true}（恢复门禁的用户显式确认——不接受空参数；
 *    未派发意图确认前保持排队，不自动重放）。
 *  - 对账=recovery.reconcile（仅 UNKNOWN turn；verdict 人工判断+note 必填；notStarted 需
 *    manualRiskAck——租约与准入保留，不冒充程序确认）。
 *  - 解除保护=recovery.releaseProtection（只按服务端取证；alive/unknown/身份缺失=拒绝并保留）。
 *  - 定位=正式深链回原上下文（定位≠执行）。
 * 不自动重放、不用点击替代退出证明、不清预算；失败原因如实上屏。中断恢复执行
 * （task.redispatch）留在任务自身上下文（线程详情/DM 头部）——与对账/解除保护分离。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Select, Tag } from './ui';
import { DetailFold } from './SettingsRow';
import { command } from '../bridge';
import { toast } from '../shell';
import { openExternalDeepLink } from '../loader';
import { recordWrite } from '../data/store';
import {getState} from '../data/store';
import {refreshDms, refreshRooms, loadRoomPool, loadThread, loadDmHistory} from '../loader';
import {createPreviousReplyCheck} from '../lib/checkPreviousReply';

interface RecoveryStatus {
  gateHeld: boolean;
  pendingDispatchCount: number;
  pendingDispatchKeys: string[];
  interruptedRuns: Array<{ id: string; task_id: string; status: string }>;
  unknownTurns: Array<{ id: string; runId: string; stageKey: string; taskId: string; status: string }>;
  pendingRelease: Array<{ turnId: string; budgetMark: string | null; turnStatus: string; protectionState: string | null; leaseCount: number; lastProbeResult: string | null }>;
  stopRecord: { at?: number; phase?: string; reason?: string; drainPending?: boolean } | null;
  activeUndos: Array<{ id: string; changeSetId: string; status: string }>;
  heldLeases: Array<{ lock_domain: string; owner_turn_id: string; status: string; heartbeat_at: number }>;
}

const fmtAt = (at?: number) => (at != null ? new Date(at).toLocaleString() : '—');
const checkPreviousReply = createPreviousReplyCheck(command);

export function RecoveryPanel({ onClose, origin }: { onClose: () => void; origin?: 'startup' | 'runtime' | null }) {
  const [data, setData] = useState<RecoveryStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 对账表单（按 turn 展开：verdict/note/manualRiskAck）。 */
  const [recon, setRecon] = useState<{ turnId: string; verdict: 'notStarted' | 'executed' | 'keepUnknown'; note: string; manualRiskAck: boolean } | null>(null);
  const [relNote, setRelNote] = useState<{ turnId: string; note: string } | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const genRef = useRef(0);
  const checkBusy = useRef(false);
  const [checkResult, setCheckResult] = useState<Record<string, {ok: boolean; detail?: string}>>({});
  const [taskTitles, setTaskTitles] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const gen = ++genRef.current;
    setErr(null);
    try {
      const r = await command<RecoveryStatus>('recovery.status', {});
      if (gen !== genRef.current) return;
      setData(r);
      const names = await Promise.allSettled(r.unknownTurns.map(async turn => {
        const item = await command<{task: {title?: string; owner_member_id?: string}}>('task.get', {taskId: turn.taskId});
        const member = getState().members.find(member => member.id === item.task.owner_member_id)?.displayName;
        return [turn.id, [member, item.task.title].filter(Boolean).join(' · ') || '上次回复'] as const;
      }));
      if (gen === genRef.current) setTaskTitles(Object.fromEntries(names.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])));
    } catch (e) {
      if (gen === genRef.current) setErr((e as Error).message);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const checkAndContinue = async (turnId: string) => {
    if (checkBusy.current || busy != null) return;
    checkBusy.current = true;
    setBusy(`check:${turnId}`);
    setCheckResult(previous => ({...previous, [turnId]: {ok: false}}));
    try {
      await checkPreviousReply(turnId);
      recordWrite('recovery.releaseProtection', '已核查上次执行并允许排队消息继续；原请求结果保持未知，不重发');
      setCheckResult(previous => ({...previous, [turnId]: {ok: true}}));
      toast('已确认这次占用结束，并允许排队消息继续；原请求不会重发。', 'success');
    } catch (error) {
      setCheckResult(previous => ({...previous, [turnId]: {ok: false, detail: error instanceof Error ? error.message : String(error)}}));
      toast('暂未完成检查，尚未确认排队消息可以继续。请查看说明后重试检查。', 'warn');
    } finally {
      await reload();
      const state = getState();
      await Promise.allSettled([
        refreshDms(), refreshRooms(),
        ...(state.ui.activeRoomId ? [loadRoomPool(state.ui.activeRoomId)] : []),
        ...(state.ui.activeThreadId ? [loadThread(state.ui.activeThreadId)] : []),
        ...state.dms.filter(dm => dm.interruptedTasks?.some(task => data?.unknownTurns.some(turn => turn.id === turnId && turn.taskId === task.taskId))).map(dm => loadDmHistory(dm.id)),
      ]);
      checkBusy.current = false;
      setBusy(null);
    }
  };

  const resumeGate = async () => {
    setBusy('gate');
    try {
      await command('dispatch.resume', { confirm: true });
      recordWrite('dispatch.resume', '恢复门禁：用户显式确认继续派发（排队意图按合同继续）');
      toast('已允许排队消息继续；尚未确认结束的回复仍需检查。', 'success');
      await reload();
    } catch (e) { toast(`确认继续失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };
  const submitReconcile = async () => {
    if (recon == null) return;
    if (recon.note.trim().length === 0) { toast('对账必须填写人工依据（note）——人工判断留痕，不冒充程序事实', 'warn'); return; }
    if (recon.verdict === 'notStarted' && !recon.manualRiskAck) { toast('notStarted（人工分离）需勾选风险确认：租约与准入会保留，不凭人工解除物理写入保护', 'warn'); return; }
    setBusy(`recon:${recon.turnId}`);
    try {
      await command('recovery.reconcile', { turnId: recon.turnId, verdict: recon.verdict, note: recon.note.trim(), ...(recon.verdict === 'notStarted' ? { manualRiskAck: true } : {}) });
      recordWrite('recovery.reconcile', `对账 ${recon.turnId.slice(0, 12)}… verdict=${recon.verdict}`);
      toast('核对结果已保存；只有确认上次处理已结束，等待中的请求才能继续。', 'success');
      setRecon(null);
      await reload();
    } catch (e) { toast(`对账失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };
  const submitRelease = async () => {
    if (relNote == null) return;
    if (relNote.note.trim().length === 0) { toast('解除保护必须填写说明（note）', 'warn'); return; }
    setBusy(`rel:${relNote.turnId}`);
    try {
      const r = await command<{ stateChanged: boolean; note?: string; releasedLeases: string[] }>('recovery.releaseProtection', { turnId: relNote.turnId, note: relNote.note.trim() });
      recordWrite('recovery.releaseProtection', `解除保护 ${relNote.turnId.slice(0, 12)}…（${r.stateChanged ? `释放 ${r.releasedLeases.length} 租约` : '幂等 no-op'}）`);
      toast(r.stateChanged ? `保护已解除（释放 ${r.releasedLeases.length} 项租约——按服务端取证）` : `未变化：${r.note ?? '无未释放租约且无保留保护'}`, r.stateChanged ? 'success' : 'info');
      setRelNote(null);
      await reload();
    } catch (e) { toast(`解除保护被拒：${(e as Error).message}（保护保留——alive/unknown/身份缺失不解除）`, 'error'); }
    finally { setBusy(null); }
  };
  const locate = (link: string) => { void openExternalDeepLink(link).catch((e: unknown) => toast(`定位失败：${(e as Error).message}`, 'error')); };

  const realAttention = data != null && (data.gateHeld || data.unknownTurns.length > 0 || data.pendingRelease.length > 0 || data.activeUndos.length > 0 || data.interruptedRuns.length > 0);
  /** 仅普通排队（无任何恢复类事项）——不是故障（R66 P5 三态分类之一）。 */
  const pendingOnly = data != null && !realAttention && data.pendingDispatchCount > 0;
  const attention = realAttention || pendingOnly;

  return (
    <div className="scrim center" onClick={onClose} style={{ zIndex: 92 }} data-zs-recovery="hifi">
      <div className="modal lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="恢复检查" style={{ maxHeight: '78vh', display: 'flex', flexDirection: 'column', width: 'min(860px, 94vw)' }}>
        <div className="row tight" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="shield" size={15} />
          <strong>检查上次回复</strong>
          {realAttention && origin === 'startup' ? <Tag tone="warning" icon="clock">启动时已有</Tag> : null}
          {realAttention && origin === 'runtime' ? <Tag tone="warning" icon="zap">本次运行新出现</Tag> : null}
          {pendingOnly ? <Tag plain icon="clock">普通排队（非故障）</Tag> : null}
          <span className="faint small">先查看状态，再决定下一步；不会自动重发消息</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={() => void reload()}>重新检查状态</button>
          <button className="btn ghost sm" onClick={() => setShowDetails((value) => !value)}>{showDetails ? '收起详情' : '查看详情'}</button>
          <button className="btn ghost sm" onClick={onClose}>关闭</button>
        </div>
        <div style={{ padding: '12px 16px', overflow: 'auto' }} className="page-stack">
          {err != null ? <div className="panel warning">恢复状态读取失败：{err}（可刷新重试）</div> : null}
          {data == null && err == null ? <div className="panel info">正在检查上次回复状态…</div> : null}
          {data != null && !attention ? <div className="panel info">没有需要处理的事项。可以正常继续使用。</div> : null}
          {data != null && realAttention ? (
            <div className="panel info" data-zs-recovery-summary="1">
              <div className="row tight"><Icon name="info" size={14} /><strong>上次处理尚有待确认事项</strong></div>
              <div className="small" style={{ marginTop: 6, lineHeight: 1.8 }}>
                {data.gateHeld ? <div>上次关闭时还有未完成的事项；新消息会先等待。</div> : null}
                {data.unknownTurns.length > 0 ? <div>有 {data.unknownTurns.length} 次回复尚未确认结束，新的请求可能在等待这些回复。先查看原任务，再核对处理结果。</div> : null}
                {data.interruptedRuns.length > 0 ? <div>有 {data.interruptedRuns.length} 个任务上次中断了。任务和文件都还在，可打开原任务继续处理。</div> : null}
                {data.pendingRelease.length > 0 ? <div>上次文件操作还未确认结束，相关请求会继续等待。检查后仍在等待时，可打开诊断详情核对。</div> : null}
                {data.activeUndos.length > 0 ? <div>还有未完成的撤销操作，请回到原任务查看。</div> : null}
              </div>
              <div className="row tight wrap" style={{ marginTop: 8 }}>
                {data.gateHeld ? <button className="btn sm" disabled={busy != null} onClick={() => void resumeGate()}>{busy === 'gate' ? '正在继续…' : '继续处理已排队的消息'}</button> : null}
                {data.unknownTurns.slice(0, 3).map((turn, index) => <button key={turn.id} className="btn ghost sm" onClick={() => locate(`#task=${turn.taskId}`)}>查看待确认任务{data.unknownTurns.length > 1 ? ` ${index + 1}` : ''}</button>)}
                {data.interruptedRuns.slice(0, 3).map((run, index) => <button key={run.id} className="btn ghost sm" onClick={() => locate(`#task=${run.task_id}`)}>查看中断任务{data.interruptedRuns.length > 1 ? ` ${index + 1}` : ''}</button>)}
                {data.unknownTurns.length > 0 || data.pendingRelease.length > 0 || data.activeUndos.length > 0 ? <button className="btn ghost sm" onClick={() => setShowDetails(true)}>查看诊断与处理选项</button> : null}
              </div>
              {data.unknownTurns.map(turn => <div key={turn.id} style={{marginTop: 8}} data-zs-previous-reply={turn.id}>
                <strong>{taskTitles[turn.id] ?? '上次回复'}</strong>
                <div className="small">{checkResult[turn.id]?.ok ? '已确认这次占用结束；原回复结果仍未确认。排队消息已获准继续，其它等待原因以最新状态为准。' : '检查上次处理是否已结束；确认后继续排队消息，保留原请求结果。'}</div>
                <button type="button" className="btn sm" style={{marginTop: 5}} disabled={busy != null || checkResult[turn.id]?.ok === true} onClick={() => void checkAndContinue(turn.id)}>{busy === `check:${turn.id}` ? '正在检查…' : checkResult[turn.id]?.ok ? '已核查此项' : '检查并继续排队消息'}</button>
                {checkResult[turn.id]?.detail ? <><div className="small">检查尚未完成，相关消息可能仍在等待；可再次点击重试检查。</div><details className="small faint"><summary>诊断详情</summary>{checkResult[turn.id].detail}</details></> : null}
              </div>)}
            </div>
          ) : null}
          {pendingOnly ? (
            <div className="panel info">
              <div className="row tight">
                <Icon name="clock" size={13} />
                <strong>有 {data?.pendingDispatchCount ?? 0} 条消息在排队</strong>
              </div>
              <div className="small muted" style={{ marginTop: 4, lineHeight: 1.7 }}>
                这是正常等待，不是故障；无需确认。队列会按顺序继续处理。
              </div>
            </div>
          ) : null}
          {showDetails && data != null ? <DetailFold summary="详细状态与人工处理（高级）">
          {data.pendingDispatchCount > 0 ? (
            <div className="panel info">
              <div className="row tight"><strong>排队消息（{data.pendingDispatchCount}）</strong></div>
              <div className="mono faint small" style={{ marginTop: 6, maxHeight: 84, overflow: 'auto' }}>
                {data.pendingDispatchKeys.map((k) => <div key={k}>{k}</div>)}
              </div>
            </div>
          ) : null}
          {data.gateHeld ? (
            <div className="panel info" style={{ borderColor: 'var(--warning)' }}>
              <div className="row tight">
                <Icon name="octagon" size={13} />
                <strong>派发门禁已落下</strong>
                <span className="faint small">上次退出存在不确定状态——新派发已暂停；排队意图 {data.pendingDispatchCount} 条保持 pending，等你确认后按合同继续。</span>
              </div>
              {data.pendingDispatchKeys.length > 0 ? (
                <div className="mono faint small" style={{ marginTop: 6, maxHeight: 84, overflow: 'auto' }}>
                  {data.pendingDispatchKeys.map((k) => <div key={k}>{k}</div>)}
                </div>
              ) : null}
              <div className="row tight" style={{ marginTop: 8 }}>
                <button className="btn sm" disabled={busy != null} title="dispatch.resume{confirm:true}——用户显式确认；不接受空参数直开" onClick={() => void resumeGate()}>
                  {busy === 'gate' ? '确认中…' : '确认继续派发'}
                </button>
                <span className="faint small">确认≠对账：UNKNOWN turn 仍需逐项对账；中断任务的恢复执行在任务自身上下文（详情/DM 头部）。</span>
              </div>
            </div>
          ) : null}
          {data != null && data.unknownTurns.length > 0 ? (
            <div className="panel info">
              <div className="row tight"><strong>UNKNOWN turn（{data.unknownTurns.length}）——结局不确定，需逐项对账</strong></div>
              {data.unknownTurns.map((t) => (
                <div key={t.id} style={{ marginTop: 8, padding: 8, border: '1px solid var(--border,#dbe2ea)', borderRadius: 6 }}>
                  <div className="row tight wrap">
                    <Tag tone="warning" icon="alert-triangle">{t.status}</Tag>
                    <span className="mono small">{t.id.slice(0, 16)}…</span>
                    <span className="faint small">stage {t.stageKey}</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost sm" title="定位回原任务上下文（定位≠执行）" onClick={() => locate(`#task=${t.taskId}`)}>定位任务</button>
                    <button className="btn ghost sm" disabled={busy != null} onClick={() => setRecon(recon?.turnId === t.id ? null : { turnId: t.id, verdict: 'executed', note: '', manualRiskAck: false })}>对账…</button>
                  </div>
                  {recon?.turnId === t.id ? (
                    <div className="page-stack" style={{ marginTop: 8 }}>
                      <div className="row tight wrap">
                        <Select
                          value={recon.verdict}
                          ariaLabel="对账判定"
                          onChange={(v) => setRecon({ ...recon, verdict: v as typeof recon.verdict })}
                          options={[
                            { value: 'executed', label: 'executed（已执行——服务端自动做退出取证）' },
                            { value: 'notStarted', label: 'notStarted（未启动——人工分离，预算退款但租约保留）' },
                            { value: 'keepUnknown', label: 'keepUnknown（维持不确定）' },
                          ]}
                        />
                        {recon.verdict === 'notStarted' ? (
                          <label className="row tight small"><input type="checkbox" checked={recon.manualRiskAck} onChange={(e) => setRecon({ ...recon, manualRiskAck: e.target.checked })} />风险确认：存在未收口进程可能时不凭人工解除写入保护</label>
                        ) : null}
                      </div>
                      <textarea className="composer-input" style={{ width: '100%', minHeight: 52 }} placeholder="人工依据（必填——留痕，不冒充程序事实）" value={recon.note} onChange={(e) => setRecon({ ...recon, note: e.target.value })} />
                      <div className="row tight">
                        <button className="btn sm" disabled={busy != null} onClick={() => void submitReconcile()}>{busy === `recon:${t.id}` ? '提交中…' : '提交对账'}</button>
                        <button className="btn ghost sm" onClick={() => setRecon(null)}>取消</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {data != null && data.pendingRelease.length > 0 ? (
            <div className="panel info">
              <div className="row tight"><strong>待解除保护（{data.pendingRelease.length}）——预算已处置、保护未解除</strong></div>
              {data.pendingRelease.map((p) => (
                <div key={p.turnId} style={{ marginTop: 8, padding: 8, border: '1px solid var(--border,#dbe2ea)', borderRadius: 6 }}>
                  <div className="row tight wrap">
                    <Tag tone={p.protectionState === 'retained' ? 'warning' : 'neutral'} icon="lock">{p.protectionState ?? '?'}</Tag>
                    <span className="mono small">{p.turnId.slice(0, 16)}…</span>
                    <span className="faint small">turn {p.turnStatus} · 租约 {p.leaseCount} · 最近取证 {p.lastProbeResult ?? '无'}</span>
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost sm" disabled={busy != null} onClick={() => setRelNote(relNote?.turnId === p.turnId ? null : { turnId: p.turnId, note: '' })}>解除保护…</button>
                  </div>
                  {relNote?.turnId === p.turnId ? (
                    <div className="page-stack" style={{ marginTop: 8 }}>
                      <textarea className="composer-input" style={{ width: '100%', minHeight: 52 }} placeholder="解除说明（必填——只按服务端取证解除；alive/unknown/身份缺失会拒绝并保留保护）" value={relNote.note} onChange={(e) => setRelNote({ ...relNote, note: e.target.value })} />
                      <div className="row tight">
                        <button className="btn sm" disabled={busy != null} onClick={() => void submitRelease()}>{busy === `rel:${p.turnId}` ? '提交中…' : '提交解除'}</button>
                        <button className="btn ghost sm" onClick={() => setRelNote(null)}>取消</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {data != null && data.interruptedRuns.length > 0 ? (
            <div className="panel info">
              <div className="row tight"><strong>中断的执行（{data.interruptedRuns.length}）</strong><span className="faint small">恢复执行=task.redispatch（在任务详情/DM 头部按来源 run 发起）；这里只定位</span></div>
              {data.interruptedRuns.map((r) => (
                <div key={r.id} className="row tight" style={{ marginTop: 6 }}>
                  <span className="mono small">{r.id.slice(0, 14)}…</span>
                  <span className="faint small">{r.status}</span>
                  <span style={{ flex: 1 }} />
                  <button className="btn ghost sm" onClick={() => locate(`#task=${r.task_id}`)}>定位任务</button>
                </div>
              ))}
            </div>
          ) : null}
          {data != null && (data.activeUndos.length > 0 || data.heldLeases.length > 0 || data.stopRecord != null) ? (
            <div className="panel info">
              <div className="row tight"><strong>其它事实（只读）</strong></div>
              <div className="small" style={{ marginTop: 4, lineHeight: 1.8 }}>
                {data.stopRecord != null ? <div>上次退出：{fmtAt(data.stopRecord.at)} · 阶段 {data.stopRecord.phase ?? '?'}{data.stopRecord.reason != null ? ` · ${data.stopRecord.reason}` : ''}{data.stopRecord.drainPending === true ? ' · 停止时仍有未收口项' : ''}</div> : null}
                {data.activeUndos.length > 0 ? <div>未收口撤销 {data.activeUndos.length} 项——续跑走原界面 changeset.undo（三向判定，不清空占位后放行）</div> : null}
                {data.heldLeases.length > 0 ? <div>未释放租约 {data.heldLeases.length} 项（expired 仍阻塞新写者——RT-07）</div> : null}
              </div>
            </div>
          ) : null}
          </DetailFold> : null}
        </div>
      </div>
    </div>
  );
}
