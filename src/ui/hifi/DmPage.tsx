/**
 * 私信页（r56 H4 §5 扩展）：真实 conversation.list/history/create/markRead + Composer 正式
 * 异步发送。已读水位继承既有合同——**前台+贴底+当前路由**才推进（页面判定）；读取失败保留
 * 旧快照+就地错误；可见时轻量刷新（会话列表+当前历史）。
 * 本批归位的正式操作（头部操作行，绑定服务端事实）：重命名（conversation.rename revision
 * CAS）、归档/恢复（conversation.archive/restore——归档禁新发+活动运行走正式停止）、停止
 * （task.stop 三重绑定 task/run/停止代次）、继续队列（dm.resume 显式泵一条）、待验收/返工
 * （task.review 绑定交付三重身份快照——目标变化不悄悄换稿）、中断恢复（task.redispatch 绑
 * 来源 run；不可恢复给服务端原因）、导出会话（export.create md/html/docx + 打开导出目录走
 * exports/ 白名单）。跨会话切换目标不误操作（每按钮取当前 active 事实重发）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import type { FormalSendOutcome } from './components/Composer';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, loadDmHistory, createDm, refreshDms, retryUnknownSend, setReadGate, toast, setState } from './shell';
import { buildDmEnvelope, sendEnvelope, attachmentRefsFromDraft, attachmentRangesFromDraft, submitTaskReview, executeTaskRework, type ReviewSnapshot } from './loader';
import { parkUnknownEnvelope, openPreview, recordWrite } from './data/store';
import { command, openExportDir } from './bridge';
import { navigate, pathOf, useHashRoute } from './lib/router';

const EXEC_TEXT: Record<string, string> = {
  idle: '', running: '运行中…', queued: '排队等待（串行）', paused: '队列已暂停（停止后）', interrupted: '有中断待恢复的任务',
};
const EMPTY: never[] = [];
const FORMAL_LIMITS = {
  access: '权限档位声明尚未接入本包（H3 按已认证能力开放）——私信按成员默认权限执行',
} as const;

export function DmPage() {
  const route = useHashRoute();
  const path = pathOf(route);
  const dms = useStore((s) => s.dms);
  const membersAll = useStore((s) => s.members);
  const historyMap = useStore((s) => s.dmHistory);
  const members = useMemo(() => membersAll.filter((m) => m.principalType === 'agent'), [membersAll]);
  const activeId = path.startsWith('/dm/') ? path.slice('/dm/'.length) : dms[0]?.id ?? '';
  const active = useMemo(() => dms.find((d) => d.id === activeId), [dms, activeId]);
  const msgs = historyMap[activeId] ?? EMPTY;
  const readError = useStore((s) => s.readErrors[activeId]);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 头部操作忙态（按动作名——同一时刻一个；失败原因走 toast 如实）。 */
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * 编辑框目标快照（r57，review-r56 §4 跨会话误提交修复）：打开时捕获 conversationId（+
   * 重命名的 revision / 验收框的交付三重身份）。切换会话即作废（effect 清除）；提交前再核对
   * 当前归属——不符=零提交。同会话交付更新按完整身份（task/delivery/revision/hash）判定。
   */
  const [renaming, setRenaming] = useState<{ conversationId: string; revision: number } | null>(null);
  const [renameText, setRenameText] = useState('');
  const [reviewBox, setReviewBox] = useState<{ conversationId: string; mode: 'accept' | 'rework'; snapshot: ReviewSnapshot; note: string } | null>(null);
  // 切换会话：编辑框一律作废关闭（零提交、零串扰）——A 打开的框不会作用于 B。
  useEffect(() => { setRenaming(null); setRenameText(''); setReviewBox(null); }, [activeId]);

  // 活动目标追踪（接管定位用）：当前会话写入 ui.activeThreadId。
  useEffect(() => { if (activeId !== '') setState((st) => ({ ...st, ui: { ...st.ui, activeThreadId: activeId } })); }, [activeId]);

  // 标读统一门（review-r47 §4）：页面注册——markRead 发起**此刻**重查（当前会话/前台/贴底/接管）。
  useEffect(() => {
    setReadGate((conversationId: string) =>
      conversationId === activeId
      && document.visibilityState === 'visible'
      && !document.body.classList.contains('legacy-on')
      && (() => { const box = listRef.current; return box != null ? (box.scrollHeight - box.scrollTop - box.clientHeight < 80) : true; })());
    return () => { setReadGate(null); };
  }, [activeId]);

  // 历史装载+已读水位（前台+贴底才推进——装载前记录贴底状态）。
  useEffect(() => {
    if (activeId === '') return;
    const box = listRef.current;
    const nearBottom = box != null ? (box.scrollHeight - box.scrollTop - box.clientHeight < 80) : true;
    void loadDmHistory(activeId, { markRead: document.visibilityState === 'visible' && nearBottom });
  }, [activeId]);

  // 可见时轻量刷新：执行态/新消息可见（隐藏/接管时暂停）。
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || document.body.classList.contains('legacy-on')) return;
      const box = listRef.current;
      const nearBottom = box != null ? (box.scrollHeight - box.scrollTop - box.clientHeight < 80) : true;
      if (activeId !== '') void loadDmHistory(activeId, { markRead: nearBottom });
      void refreshDms();
    }, 5000);
    return () => { window.clearInterval(t); };
  }, [activeId]);

  /** ── 头部正式操作（每项取打开时的目标快照+提交前重核当前归属；失败如实）。 ── */
  const reloadAll = async () => { await refreshDms(); if (activeId !== '') await loadDmHistory(activeId); };
  const doRename = async () => {
    if (renaming == null || renameText.trim().length === 0) return;
    // 提交前核对：框属于哪个会话就用哪个会话的快照（捕获的 conversationId/revision）——
    // 切走后当前 active 不是目标=作废零提交（r57 跨会话误提交修复）。
    const target = dms.find((d) => d.id === renaming.conversationId);
    if (target == null) { toast('重命名目标已不可用（会话已切换或移除）——框已作废', 'warn'); setRenaming(null); return; }
    setBusy('rename');
    try {
      await command('conversation.rename', { conversationId: renaming.conversationId, title: renameText.trim(), expectedRevision: renaming.revision });
      recordWrite('conversation.rename', `私信重命名 →「${renameText.trim()}」`);
      toast('已重命名（revision CAS 通过）', 'success');
      setRenaming(null);
      await reloadAll();
    } catch (e) {
      toast(`重命名失败：${(e as Error).message}`, 'error');
      // CAS 冲突=列表里有更新版本——保留文本关闭框（重开取新 revision），不静默丢弃输入。
      setRenaming(null);
      await refreshDms();
    } finally { setBusy(null); }
  };
  const doArchive = async () => {
    if (active == null) return;
    setBusy('archive');
    try {
      const r = await command<{ archived: boolean; already: boolean; stopPending: boolean }>('conversation.archive', { conversationId: active.id, expectedRevision: active.revision ?? 0 });
      recordWrite('conversation.archive', `归档私信（stopPending=${r.stopPending}——活动运行走正式停止）`);
      toast(r.already ? '已归档（幂等）' : `已归档${r.stopPending ? '——活动运行停止请求已发（退出未确认会如实保留状态）' : ''}`, 'success');
      await reloadAll();
    } catch (e) { toast(`归档失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };
  const doRestore = async () => {
    if (active == null) return;
    setBusy('restore');
    try {
      await command('conversation.restore', { conversationId: active.id });
      recordWrite('conversation.restore', '恢复私信（不自动续跑——排队消息等待发送或 dm.resume）');
      toast('已取消归档（不自动续跑——排队消息用「继续队列」显式推进）', 'success');
      await reloadAll();
    } catch (e) { toast(`恢复失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };
  const doStop = async () => {
    if (active?.activeTaskId == null || active.activeRunId == null) return;
    setBusy('stop');
    try {
      await command('task.stop', { taskId: active.activeTaskId, targetRunId: active.activeRunId, expectedStopGeneration: active.activeStopGeneration ?? 0 });
      recordWrite('task.stop', `停止私信执行（task ${active.activeTaskId.slice(0, 10)}… run ${active.activeRunId.slice(0, 10)}… 代次 ${active.activeStopGeneration ?? 0}）`);
      toast('停止请求已提交（等活跃 turn 结束——队列进入暂停）', 'success');
      await reloadAll();
    } catch (e) { toast(`停止失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };
  const doResume = async () => {
    if (active == null) return;
    setBusy('resume');
    try {
      const r = await command<{ enqueued: number | boolean }>('dm.resume', { conversationId: active.id });
      recordWrite('dm.resume', `继续队列（泵 ${typeof r.enqueued === 'number' ? r.enqueued : Number(r.enqueued)} 条）`);
      toast(`已继续队列（本次泵入 ${typeof r.enqueued === 'number' ? r.enqueued : r.enqueued ? 1 : 0} 条排队消息）`, 'success');
      await reloadAll();
    } catch (e) { toast(`继续失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };
  const openReview = (mode: 'accept' | 'rework') => {
    const p = active?.pendingReview;
    if (p == null || active == null) return;
    // 快照=当前会话+交付三重身份（r57）：此后切走/更版都按完整身份判定作废。
    setReviewBox({ conversationId: active.id, mode, snapshot: { taskId: p.taskId, deliveryId: p.deliveryId, deliveryRevision: p.revision, manifestHash: p.manifestHash }, note: '' });
  };
  const submitReview = async () => {
    if (reviewBox == null) return;
    if (reviewBox.mode === 'rework' && reviewBox.note.trim().length === 0) { toast('要求修改必须填写意见（进入正式任务记录并注入返工输入）', 'warn'); return; }
    // 提交前核对：当前会话必须还是框的归属会话（跨会话切换后 UI 已作废；此处双保险）。
    if (active?.id !== reviewBox.conversationId) { toast('验收目标已切换（框属其它会话）——作废零提交', 'warn'); setReviewBox(null); return; }
    setBusy('review');
    try {
      // r57：复用正式适配器 submitTaskReview（返工 note 字段——旧实现误传 reviewComment 被拒）。
      const r = await submitTaskReview(reviewBox.snapshot, reviewBox.mode === 'accept' ? 'accept' : 'changes_requested', reviewBox.mode === 'rework' ? reviewBox.note.trim() : undefined);
      if (r.ok) {
        toast(reviewBox.mode === 'accept' ? '已验收通过' : '返工意见已记录、尚未执行——点击「执行返工」继续', 'success');
        setReviewBox(null);
        await reloadAll().catch(() => { /* 刷新失败另有呈现——忙态必须释放（r58 P4：不锁死操作） */ });
        return;
      }
      // 失败：原因准确呈现；保留意见文本可修正重提（不称「交付可能更新」一刀切丢文本）。
      const stale = active?.pendingReview == null
        || active.pendingReview.taskId !== reviewBox.snapshot.taskId
        || active.pendingReview.deliveryId !== reviewBox.snapshot.deliveryId
        || active.pendingReview.revision !== reviewBox.snapshot.deliveryRevision;
      toast(`提交失败：${r.error}${stale ? '（交付已变化——本框作废，请对新版本重新操作）' : '（意见已保留，可修正后重提）'}`, 'error');
      if (stale) setReviewBox(null);
      await reloadAll().catch(() => { /* 同上：刷新失败不阻断忙态释放 */ });
    } finally {
      setBusy(null); // r58 P4：成功/失败/刷新异常统一释放——不锁死操作忙态
    }
  };
  const doRecover = async (it: { taskId: string; lastRunId: string | null }) => {
    setBusy(`recover:${it.taskId}`);
    try {
      await command('task.redispatch', { taskId: it.taskId, reason: '私信中断恢复（新界面显式发起）', ...(it.lastRunId != null ? { sourceRunId: it.lastRunId } : {}) });
      recordWrite('task.redispatch', `私信中断恢复 task ${it.taskId.slice(0, 10)}…（来源 run ${it.lastRunId?.slice(0, 10) ?? '?'}）`);
      toast('恢复执行已提交（经 outbox 正式编排——不自动重放）', 'success');
      await reloadAll();
    } catch (e) { toast(`恢复被拒：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };
  /** 执行返工（r58 验收与执行分离）：意见已在 task.review 入账；此处只传任务号——
   * 入队后由轮询推进（新交付 revision+1 → 再次待验收）。 */
  const doExecuteRework = async (taskId: string) => {
    setBusy(`rework:${taskId}`);
    try {
      const r = await executeTaskRework(taskId);
      if (!r.ok) { toast(`执行返工被拒：${r.error}`, 'error'); await reloadAll(); return; }
      toast('返工执行已入队（同任务新执行——完成后交付升级为新待验收版本）', 'success');
      await reloadAll();
    } finally { setBusy(null); }
  };
  const doExport = async (format: 'md' | 'html' | 'docx') => {
    if (active == null) return;
    setBusy(`export:${format}`);
    try {
      const r = await command<{ exportId: string; dir: string; files: string[]; stats: { messages: number; attachments: number; missing: number } }>('export.create', { target: { kind: 'conversation', projectId: active.projectId, conversationId: active.id }, format });
      recordWrite('export.create', `导出私信 ${format}（${r.stats.messages} 消息/${r.stats.attachments} 附件 → ${r.exportId}）`);
      toast(`已导出 ${format.toUpperCase()}（${r.stats.messages} 消息 · ${r.files.length} 文件）`, 'success');
      void openExportDir(r.dir).catch((e: unknown) => toast(`打开导出目录失败：${(e as Error).message}（目录 ${r.dir}）`, 'error'));
    } catch (e) { toast(`导出失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div style={{ display: 'flex', height: '100%', minWidth: 0, flex: 1 }}>
      <div className="sidebar-scroll" style={{ flex: '0 0 224px', width: 224, borderRight: '1px solid var(--border)', padding: 8, minHeight: 0, overflow: 'auto' }}>
        <div className="side-heading">私信</div>
        {dms.length === 0 ? <div className="side-empty">本项目暂无私信会话</div> : null}
        {dms.map((d) => (
          <button
            key={d.id}
            className={`side-item${d.id === activeId ? ' active' : ''}`}
            title={d.title !== '' ? d.title : `${d.peerDisplayName ?? '成员'} 的一对一私信`}
            onClick={() => navigate(`/dm/${d.id}`)}
          >
            <span className="side-item-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.peerDisplayName ?? '成员'}{d.title != null && d.title.length > 0 ? ` · ${d.title}` : ''}
            </span>
            {d.unread > 0 ? <span className="side-marks"><NavDot /></span> : null}
          </button>
        ))}
        <div className="row tight wrap" style={{ marginTop: 6 }}>
          {members.map((m) => (
            <button key={m.id} className="btn ghost sm" title={`与 ${m.displayName} 新建一对一私信（正式 conversation.create）`} onClick={() => {
              void createDm(m.id).then((cid) => navigate(`/dm/${cid}`)).catch((e) => toast(`新建私信失败：${(e as Error).message}`, 'error'));
            }}>+ {m.displayName}</button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        {active == null ? (
          <div className="panel info" style={{ margin: 14 }}>选择或新建一个私信会话。</div>
        ) : (
          <>
            <div className="row tight wrap" style={{ padding: '10px 14px 0' }} data-zs-dm-ops="hifi">
              {renaming != null ? (
                <span className="row tight">
                  <input
                    className="composer-input" style={{ minWidth: 200 }}
                    placeholder="会话标题（1–120 字）"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void doRename(); } if (e.key === 'Escape') setRenaming(null); }}
                  />
                  <button className="btn sm" disabled={busy != null} onClick={() => void doRename()}>保存</button>
                  <button className="btn ghost sm" onClick={() => setRenaming(null)}>取消</button>
                </span>
              ) : (
                <span className="section-title">{active.peerDisplayName ?? '成员'}{active.title != null && active.title.length > 0 ? ` · ${active.title}` : ''}</span>
              )}
              <span className="faint small">
                {active.archivedAt != null ? '已归档（只读）' : EXEC_TEXT[active.execState ?? 'idle'] ?? ''}
                {active.queuedCount != null && active.queuedCount > 0 ? ` · 排队 ${active.queuedCount} 条` : ''}
                {active.stopPending === true ? ' · 停止退出未确认' : ''}
              </span>
              <span style={{ flex: 1 }} />
              {/* 正式操作行（r56）：按服务端事实出现——不摆不可用按钮。 */}
              <button className="btn ghost sm" disabled={busy != null} title="重命名会话（conversation.rename——revision CAS，他人改动会冲突如实报错）" onClick={() => { setRenameText(active.title ?? ''); setRenaming({ conversationId: active.id, revision: active.revision ?? 0 }); }}>重命名</button>
              {active.activeTaskId != null && active.activeRunId != null ? (
                <button className="btn ghost sm" disabled={busy != null} title={`停止执行（task.run 三重绑定：代次 ${active.activeStopGeneration ?? 0}——过时绑定由服务端拒绝）`} onClick={() => void doStop()}>停止执行</button>
              ) : null}
              {active.execState === 'paused' || (active.queuedCount ?? 0) > 0 ? (
                <button className="btn ghost sm" disabled={busy != null} title="继续队列（dm.resume——显式泵一条排队消息，不自动连发）" onClick={() => void doResume()}>继续队列</button>
              ) : null}
              {active.archivedAt != null ? (
                <button className="btn ghost sm" disabled={busy != null} title="取消归档（conversation.restore——不自动续跑）" onClick={() => void doRestore()}>取消归档</button>
              ) : (
                <button className="btn ghost sm" disabled={busy != null} title="归档（禁新发/新派发；活动运行走正式停止；历史只读）" onClick={() => void doArchive()}>归档</button>
              )}
              <button className="btn ghost sm" disabled={busy != null} title="导出会话（export.create——快照事务内固定消息+附件；重放幂等）" onClick={() => void doExport('md')}>导出 MD</button>
              <button className="btn ghost sm" disabled={busy != null} title="导出会话 HTML" onClick={() => void doExport('html')}>HTML</button>
              <button className="btn ghost sm" disabled={busy != null} title="导出会话 DOCX" onClick={() => void doExport('docx')}>DOCX</button>
              <button className="btn ghost sm" style={{ marginLeft: 4 }} title="在本会话的原界面打开（尚未换装的能力经此可达）" onClick={() => import('./App').then((m) => m.takeLegacy('current-dm'))}>原界面</button>
            </div>
            {/* 待验收交付（三重身份冻结——提交只带打开时的这份）。 */}
            {active.pendingReview != null ? (
              <div className="panel info" style={{ margin: '8px 14px 0' }} data-zs-dm-review="hifi">
                <div className="row tight wrap">
                  <Icon name="package" size={13} />
                  <strong>待验收交付</strong>
                  <Tag tone="info">v{active.pendingReview.revision} · manifest {active.pendingReview.manifestHash.slice(0, 10)}…</Tag>
                  <span className="faint small">验收绑定打开时的三重身份——交付更新后本框作废重开</span>
                  <span style={{ flex: 1 }} />
                  <button className="btn ghost sm" disabled={busy != null || reviewBox != null} onClick={() => openReview('accept')}>验收通过</button>
                  <button className="btn ghost sm" disabled={busy != null || reviewBox != null} onClick={() => openReview('rework')}>要求返工</button>
                </div>
                {reviewBox != null ? (
                  <div className="page-stack" style={{ marginTop: 8 }}>
                    {/* 作废判定按**完整身份**（会话+task/delivery/revision/hash）——同 revision 不同
                        交付（A→B 反例）也作废；作废框保留关闭入口（r57）。 */}
                    {(() => {
                      const p = active.pendingReview;
                      const stale = p == null
                        || p.taskId !== reviewBox.snapshot.taskId
                        || p.deliveryId !== reviewBox.snapshot.deliveryId
                        || p.revision !== reviewBox.snapshot.deliveryRevision
                        || p.manifestHash !== reviewBox.snapshot.manifestHash;
                      return stale ? (
                        <>
                          <div className="panel warning">交付已变化（打开时 v{reviewBox.snapshot.deliveryRevision}，当前 {p != null ? `v${p.revision}` : '无待验收交付'}）——本框作废。</div>
                          <div className="row tight">
                            <button className="btn ghost sm" onClick={() => setReviewBox(null)}>关闭作废框</button>
                          </div>
                        </>
                      ) : reviewBox.mode === 'rework' ? (
                        <textarea className="composer-input" style={{ width: '100%', minHeight: 56 }} placeholder="返工意见（必填——进入正式任务记录并注入返工输入）" value={reviewBox.note} onChange={(e) => setReviewBox((b) => b == null ? b : { ...b, note: e.target.value })} />
                      ) : (
                        <div className="faint small">将验收通过 v{reviewBox.snapshot.deliveryRevision}（manifest {reviewBox.snapshot.manifestHash.slice(0, 10)}…）。</div>
                      );
                    })()}
                    {(() => {
                      const p = active.pendingReview;
                      const stillValid = p != null && p.taskId === reviewBox.snapshot.taskId && p.deliveryId === reviewBox.snapshot.deliveryId && p.revision === reviewBox.snapshot.deliveryRevision && p.manifestHash === reviewBox.snapshot.manifestHash;
                      return stillValid ? (
                        <div className="row tight">
                          <button className="btn sm" disabled={busy != null} onClick={() => void submitReview()}>{reviewBox.mode === 'accept' ? '确认验收' : '提交返工意见'}</button>
                          <button className="btn ghost sm" onClick={() => setReviewBox(null)}>取消</button>
                        </div>
                      ) : null;
                    })()}
                  </div>
                ) : null}
              </div>
            ) : null}
            {/* 返工待执行（r58 验收与执行分离）：意见已记录、尚未执行——明确入口续跑，
                不自动执行、不等「出新稿」。执行中由队列/运行态呈现，新交付落回待验收面板。 */}
            {active.reworkPending != null ? (
              <div className="panel info" style={{ margin: '8px 14px 0' }} data-zs-dm-rework="hifi">
                <div className="row tight wrap">
                  <Icon name="refresh" size={13} />
                  <strong>返工意见已记录、尚未执行</strong>
                  <Tag tone="warning">v{active.reworkPending.deliveryRevision} 被要求修改</Tag>
                  <span style={{ flex: 1 }} />
                  {active.reworkPending.queued ? (
                    <span className="faint small">返工执行中（已入队/派发）——完成后交付升级为新待验收版本</span>
                  ) : (
                    <button className="btn sm" disabled={busy != null} data-zs-dm-rework-run="1" title="执行返工（task.executeRework——同任务新执行，意见注入模型输入）" onClick={() => void doExecuteRework(active.reworkPending!.taskId)}>执行返工</button>
                  )}
                </div>
                {active.reworkPending.note != null ? (
                  <div className="faint small" style={{ marginTop: 6 }}>验收意见：{active.reworkPending.note}</div>
                ) : null}
              </div>
            ) : null}
            {/* 中断待恢复（服务端分列可恢复性——不可恢复给原因，不放按钮）。 */}
            {(active.interruptedTasks ?? []).length > 0 ? (
              <div className="panel info" style={{ margin: '8px 14px 0' }} data-zs-dm-interrupted="hifi">
                <div className="row tight"><Icon name="alert-triangle" size={13} /><strong>中断待恢复</strong><span className="faint small">恢复执行经 outbox 正式编排（绑来源 run）；不自动重放</span></div>
                {(active.interruptedTasks ?? []).map((it) => (
                  <div key={it.taskId} className="row tight" style={{ marginTop: 6 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.title}</span>
                    <span className="faint small">上次 run {it.lastRunStatus ?? '?'}</span>
                    {it.recoverable ? (
                      <button className="btn sm" disabled={busy != null} title={`恢复执行（task.redispatch——来源 run ${it.lastRunId?.slice(0, 10) ?? '?'}）`} onClick={() => void doRecover(it)}>恢复执行</button>
                    ) : (
                      <Tag tone="warning" icon="octagon" title={it.blockReason ?? '不可恢复'}>不可恢复</Tag>
                    )}
                  </div>
                ))}
                {(active.interruptedTasks ?? []).some((it) => !it.recoverable && it.blockReason != null) ? (
                  <div className="faint small" style={{ marginTop: 4 }}>
                    {(active.interruptedTasks ?? []).filter((it) => !it.recoverable && it.blockReason != null).map((it) => `· ${it.title}：${it.blockReason}`).join(' ')}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="msg-list" ref={listRef} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 14px' }}>
              {readError != null ? (
                <div className="panel info" style={{ borderColor: 'var(--warning)' }} data-zs-dm-readerror="1">
                  读取失败：{readError}（保留上次快照）
                  <button className="btn ghost sm" style={{ marginLeft: 8 }} disabled={busy != null} title="立即重读本会话（后台 5s 轻量刷新也会自动重试）" onClick={() => { void loadDmHistory(activeId).catch(() => { /* 失败仍由面板呈现 */ }); }}>重试</button>
                </div>
              ) : null}
              {msgs.length === 0 && readError == null ? <div className="panel info">会话暂无消息。</div> : null}
              {msgs.map((m) => (
                <MessageView key={m.id} message={m} author={m.authorType === 'human' ? undefined : members.find((x) => x.id === m.authorId)} onOpenAttachment={(att) => openPreview({ attachmentId: att.artifactId, filename: att.filename, kind: att.kind, conversationId: active.id, origin: '私信会话' })} />
              ))}
            </div>
            {active.archivedAt != null ? (
              <div className="panel info" style={{ margin: '0 14px 12px' }}>已归档会话禁止新发——「取消归档」在上方操作行（恢复后排队消息用「继续队列」显式推进，不自动续跑）。</div>
            ) : (
              <Composer
                target={{ kind: 'dm', roomId: `dm:${active.id}`, dmId: active.id }}
                draftKey={`dm:${active.id}`}
                showMentions={false}
                formalLimits={FORMAL_LIMITS}
                attachmentUpload={{ conversationId: active.id }}
                onRetrySend={(env) => retryUnknownSend(env).then((r) => {
                  if (r.status === 'ok') { void loadDmHistory(active.id, { markRead: true }); void refreshDms(); toast('重发成功（原信封）', 'success'); }
                  return r.status === 'ok' ? { status: 'ok' } : r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
                })}
                onSend={(p): Promise<FormalSendOutcome> => (async () => {
                  // 发送前固化完整正式信封（dm 目标=projectId+conversationId——不带 UI 的
                  // roomId/dmId 私有字段，review-r48 §3）；unknown 冻结原信封。
                  const intent = p.sendAs === 'record' ? 'record_only' : 'default';
                  const draftKey = `dm:${active.id}`;
                  const refs = attachmentRefsFromDraft(draftKey, intent);
                  if (refs.blockError != null) return { status: 'failed', error: refs.blockError };
                  if (refs.hasImages === true && p.imageAck == null) return { status: 'failed', error: '图片能力门：请先在输入区选择「仅发送文字」或「改为仅记录」' };
                  const env = buildDmEnvelope(p.commandId, active.id, p.body, intent, refs.refs, { imageAck: p.imageAck, attachmentRanges: attachmentRangesFromDraft(draftKey) });
                  env.revAtSend = p.draftRev;
                  const r = await sendEnvelope(env);
                  if (r.status === 'ok') {
                    void loadDmHistory(active.id, { markRead: true }).catch(() => { /* 读失败另有呈现 */ });
                    void refreshDms().catch(() => { /* 列表失败另有呈现 */ });
                    toast(intent === 'record_only' ? '已仅记录（不派发）' : '已发送', 'success');
                    return { status: 'ok' };
                  }
                  if (r.status === 'unknown') parkUnknownEnvelope(draftKey, env);
                  return r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
                })()}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NavDot() { return <span className="nav-dot" title="有未读" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent, #2563eb)', display: 'inline-block' }} />; }
