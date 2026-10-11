/**
 * 私信页（r56 H4 §5 扩展 → R66 P2/P5 原型布局还原）：真实 conversation.list/history/
 * create/markRead + Composer 正式异步发送。已读水位继承既有合同——**前台+贴底+当前路由**
 * 才推进（页面判定）；读取失败保留旧快照+就地错误；可见时轻量刷新。
 *
 * R66 布局（原型 Dm.tsx §17.9 第 2 条 + §5.3）：会话列表 320 / 对话 440 / 预览 480 为
 * 候选下限，按**实际容器宽度**（useElementWidth('.app-body')-侧栏）降级：先收列表，再切
 * 单区域（对话/文件二选一——隐藏区域保留草稿与阅读位置）。预览由本页自渲染（dm audience
 * 隔离；此前 App 相邻拼一个无宽度规则的 PreviewPane=反例 C 的 341px 挤压来源）。
 *
 * 头部信息层级（R66 P5）：标题+执行态常驻；重命名/归档/导出会话记录/原界面收进 ⋯ 菜单
 * ——「导出会话记录…」明确命名导出对象（此前三个平铺「导出 MD/HTML/DOCX」被混淆为
 * 保存当前预览文件）；待验收/返工/中断/停止等**状态动作**保持在正文上方原位（就地反馈）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import type { FormalSendOutcome } from './components/Composer';
import { Icon } from './components/Icon';
import { Avatar, Menu, MenuItem, Modal, Tag, memberColor } from './components/ui';
import { useStore, loadDmHistory, createDm, refreshDms, retryUnknownSend, setReadGate, toast, setState } from './shell';
import { buildDmEnvelope, sendEnvelope, attachmentRefsFromDraft, attachmentRangesFromDraft, submitTaskReview, executeTaskRework, toggleSavedMessage, type ReviewSnapshot } from './loader';
import { openPreview, recordWrite, stageOutbound, settleOutbound, dropOutbound, confirmOutboundUnknown } from './data/store';
import { command, openExportDir } from './bridge';
import { navigate, pathOf, useHashRoute } from './lib/router';
import { useElementWidth } from './lib/useElementWidth';
import { SIDEBAR_WIDTH } from './lib/layout';
import { audienceAllows, resourceOf } from './lib/resource';
import { autoHidePreviewForConversation, shouldAutoHidePreviewFor } from './data/actions-preview';
import { PreviewPane, PreviewReopenButton } from './preview/PreviewPane';

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
  const st = useStore((x) => x);
  const members = useMemo(() => membersAll.filter((m) => m.principalType === 'agent'), [membersAll]);
  const activeId = path.startsWith('/dm/') ? path.slice('/dm/'.length) : dms[0]?.id ?? '';
  const active = useMemo(() => dms.find((d) => d.id === activeId), [dms, activeId]);
  const msgs = historyMap[activeId] ?? EMPTY;
  const readError = useStore((s) => s.readErrors[activeId]);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 头部操作忙态（按动作名——同一时刻一个；失败原因走 toast 如实）。 */
  const [busy, setBusy] = useState<string | null>(null);
  /** ⋯ 菜单与新建私聊弹窗锚点（R66 P5：操作收进菜单，头部不铺满按钮）。 */
  const [opsAt, setOpsAt] = useState<{ x: number; y: number } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  /**
   * 编辑框目标快照（r57，review-r56 §4 跨会话误提交修复）：打开时捕获 conversationId（+
   * 重命名的 revision / 验收框的交付三重身份）。切换会话即作废（effect 清除）；提交前再核对
   * 当前归属——不符=零提交。同会话交付更新按完整身份（task/delivery/revision/hash）判定。
   */
  const [renaming, setRenaming] = useState<{ conversationId: string; revision: number } | null>(null);
  const [renameText, setRenameText] = useState('');
  const [reviewBox, setReviewBox] = useState<{ conversationId: string; mode: 'accept' | 'rework'; snapshot: ReviewSnapshot; note: string } | null>(null);
  /** 消息引用插入（r61：与线程同判——只写草稿，不派发；id 驱动 Composer 去重应用）。 */
  const [insertText, setInsertText] = useState<{ id: number; text: string } | null>(null);
  const savedRefs = useStore((s) => s.savedMessageRefs);
  // 切换会话：编辑框一律作废关闭（零提交、零串扰）——A 打开的框不会作用于 B。
  useEffect(() => { setRenaming(null); setRenameText(''); setReviewBox(null); setInsertText(null); setOpsAt(null); }, [activeId]);

  // 活动目标追踪（接管定位用）：当前会话写入 ui.activeThreadId。
  useEffect(() => { if (activeId !== '') setState((s) => ({ ...s, ui: { ...s.ui, activeThreadId: activeId } })); }, [activeId]);

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
    const nearBottom = box != null ? box.scrollHeight - box.scrollTop - box.clientHeight < 80 : true;
    void loadDmHistory(activeId, { markRead: document.visibilityState === 'visible' && nearBottom });
  }, [activeId]);

  // R68：挂载/项目就绪即刷新私信清单（一次）。重载/深链直达 #/dm/<id> 且项目由服务端导航
  // 偏好恢复时 switchFocusProject 会因「已激活」早退——store.dms 为空会停在「还没有私聊」
  // 回退态，此前只能等 5s 可见性轮询（窗口被遮挡时 visibility=hidden 更是无限期）。
  const mountProjectId = useStore((s) => s.activeProjectId);
  useEffect(() => { if (mountProjectId !== '') void refreshDms().catch(() => { /* 下次 interval 重试 */ }); }, [mountProjectId]);

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

  /* ---------- 布局解析（原型 §17.9：320 列表 / 440 对话 / 480 预览；先收列表再单区） ---------- */
  const workspace = useElementWidth<HTMLDivElement>('.app-body');
  const dmAvailable = Math.max(320, workspace.width - SIDEBAR_WIDTH);
  const DM_LIST_W = 320;
  const DM_MIN_CONTEXT = 440;
  const DM_MIN_PREVIEW = 480;
  /** 当前 DM 上下文可见的预览标签（audience 隔离——房间/项目资源在 DM 不可见）。 */
  const dmHasPreview = useMemo(() => {
    if (st.preview.hidden || active == null) return false;
    return st.preview.tabs.some((t) => {
      const r = resourceOf(st, t.resourceId);
      return r != null && audienceAllows(r.audience, { kind: 'dm', projectId: active.projectId, conversationId: active.id, threadId: active.threadId });
    });
  }, [st.preview.hidden, st.preview.tabs, st.resources, active?.id, active?.projectId, active?.threadId]);
  const dmKeepList = !dmHasPreview || dmAvailable >= DM_LIST_W + DM_MIN_CONTEXT + DM_MIN_PREVIEW + 8;
  const dmTwoRegion = dmHasPreview && dmAvailable >= DM_MIN_CONTEXT + DM_MIN_PREVIEW + 8;
  const dmSingle = dmHasPreview && !dmTwoRegion;
  const [dmRegion, setDmRegion] = useState<'context' | 'preview'>('context');
  useEffect(() => { setDmRegion(dmHasPreview ? 'preview' : 'context'); }, [dmHasPreview]);
  const dmShowContext = !dmSingle || dmRegion === 'context';
  const dmShowPreview = dmHasPreview && (!dmSingle || dmRegion === 'preview');
  const dmShowList = !dmHasPreview || dmKeepList;
  /** R69 P1-A：store.openPreview 已在调度层直接开标签——挂载判定回归 dmShowPreview，
   *  不再需要「legacy 单目标待归一」的额外挂载条件（死锁桥已拆除）。 */
  const dmMountPreview = active != null && dmShowPreview;

  /**
   * R74-P2（review-r73 §P2）：文件页来源的预览**不占私信**——工作区资源 audience=project 在
   * DM 上下文同样放行（audienceAllows），侧栏点进私信与点进房间是同一占用问题。判据与房间
   * 一致（shouldAutoHidePreviewFor：当前活动预览来源+explicitShow）；私信内主动打开/显式重开
   * 恒尊重，标签与阅读位置保留。
   */
  const dmAutoHideKey = active != null ? `dm:${active.projectId}:${active.id}` : '';
  useEffect(() => {
    if (active != null && shouldAutoHidePreviewFor({ kind: 'dm', projectId: active.projectId, conversationId: active.id, threadId: active.threadId })) {
      autoHidePreviewForConversation(dmAutoHideKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmAutoHideKey, st.preview.hidden, st.preview.tabs, st.resources]);

  const dailyDms = useMemo(() => dms.filter((d) => d.archivedAt == null), [dms]);
  const archivedDms = useMemo(() => dms.filter((d) => d.archivedAt != null), [dms]);

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
  /** 执行返工（r58 验收与执行分离；r59 完整身份）：点击时冻结 reworkPending 快照——
   * 服务端核对当前返工事实，旧引用（数据已推进）STALE 拒绝不改绑。 */
  const doExecuteRework = () => {
    const rp = active?.reworkPending;
    if (rp == null) return;
    const snapshot = { taskId: rp.taskId, deliveryId: rp.deliveryId, deliveryRevision: rp.deliveryRevision, manifestHash: rp.manifestHash, sourceRunId: rp.sourceRunId };
    setBusy(`rework:${rp.taskId}`);
    void (async () => {
      try {
        const r = await executeTaskRework(snapshot);
        if (!r.ok) { toast(`执行返工被拒：${r.error}——已刷新为当前返工事实`, 'error'); await reloadAll(); return; }
        toast('返工执行已入队（同任务新执行——完成后交付升级为新待验收版本）', 'success');
        await reloadAll();
      } finally { setBusy(null); }
    })();
  };
  /** 导出会话记录（R66 P5：明确命名——导出的是**这条会话的消息与托管附件**，不是当前
   * 预览的单个文件；单文件保存在预览的「下载原文件/另存为」）。 */
  const doExport = async (format: 'md' | 'html' | 'docx') => {
    if (active == null) return;
    setBusy(`export:${format}`);
    try {
      const r = await command<{ exportId: string; dir: string; files: string[]; stats: { messages: number; attachments: number; missing: number } }>('export.create', { target: { kind: 'conversation', projectId: active.projectId, conversationId: active.id }, format });
      recordWrite('export.create', `导出私信会话记录 ${format}（${r.stats.messages} 消息/${r.stats.attachments} 附件 → ${r.exportId}）`);
      toast(`已导出会话记录 ${format.toUpperCase()}（${r.stats.messages} 消息 · ${r.files.length} 文件）`, 'success');
      void openExportDir(r.dir).catch((e: unknown) => toast(`打开导出目录失败：${(e as Error).message}（目录 ${r.dir}）`, 'error'));
    } catch (e) { toast(`导出失败：${(e as Error).message}`, 'error'); }
    finally { setBusy(null); }
  };

  const dmTitle = active != null
    ? (active.title != null && active.title.length > 0 ? active.title : active.peerDisplayName ?? '成员')
    : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 }}>
      {/* 单区域时的「对话 / 文件」切换器（原型 §5.3：空间不足二选一，隐藏区域保留状态） */}
      {dmSingle ? (
        <div className="single-region-switch row tight" style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
          <div className="seg" role="group" aria-label="显示区域">
            <button className={dmRegion === 'context' ? 'on' : ''} onClick={() => setDmRegion('context')}>
              <Icon name="message-square" size={12} /> 对话
            </button>
            <button className={dmRegion === 'preview' ? 'on' : ''} onClick={() => setDmRegion('preview')}>
              <Icon name="file-text" size={12} /> 文件
            </button>
          </div>
          <span className="small faint">空间不足，已切为单区域；隐藏区域仍保留阅读位置与草稿</span>
        </div>
      ) : null}

      <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
        {/* 左：会话列表（320；空间不足时让位给两块内容）。 */}
        {dmShowList ? (
          <div className="col-main" style={{ flex: '0 0 320px', width: 320, maxWidth: 320, borderRight: '1px solid var(--border)', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="pool-head" style={{ padding: '12px 14px 8px' }}>
              <Icon name="message-square" size={15} className="faint" />
              <span className="pool-title">私信</span>
              <div className="spacer" />
              <button
                className="btn sm primary"
                title="新建私聊（1 对 1——选择一位成员，正式 conversation.create）"
                onClick={() => setCreateOpen(true)}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>
            <div className="dm-list" style={{ flex: 1, minHeight: 0, overflow: 'auto' }} data-zs-dm-list="hifi">
              {dailyDms.length === 0 ? (
                <div className="small faint" style={{ padding: 14 }} data-testid="dm-empty">
                  还没有私聊。点右上角 + 新建一个（1 对 1，独立会话与可见范围）。
                </div>
              ) : null}
              {dailyDms.map((d) => {
                const peer = membersAll.find((m) => m.id === d.memberIds[0]);
                return (
                  <button
                    key={d.id}
                    className={`dm-row${d.id === activeId ? ' on' : ''}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', border: 'none', background: d.id === activeId ? 'var(--bg-surface-2,#f1f5f9)' : 'transparent', cursor: 'pointer', textAlign: 'left' }}
                    title={d.title !== '' ? d.title : `${d.peerDisplayName ?? '成员'} 的一对一私信`}
                    onClick={() => navigate(`/dm/${d.id}`)}
                  >
                    <Avatar name={peer?.displayName ?? d.peerDisplayName ?? '成员'} color={peer != null ? memberColor(peer.id) : undefined} size={22} round />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, fontWeight: d.unread > 0 ? 600 : 400 }}>
                        {d.title != null && d.title.length > 0 ? d.title : d.peerDisplayName ?? '成员'}
                      </span>
                      <span className="small faint" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                        {d.lastMessagePreview ?? '（暂无消息）'}
                      </span>
                    </span>
                    {d.unread > 0 ? <Tag tone="info" icon="message-square">{d.unread}</Tag> : null}
                    {d.execState === 'running' || d.execState === 'queued' ? <span className="nav-dot" title={EXEC_TEXT[d.execState ?? 'idle'] ?? ''} style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--accent,#2563eb)', flex: 'none' }} /> : null}
                  </button>
                );
              })}
              {archivedDms.length > 0 ? (
                <>
                  <button
                    className="dm-archived-toggle"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '8px 12px', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-3)', fontSize: 12 }}
                    onClick={() => setShowArchived((v) => !v)}
                    title="归档的私聊只读，可取消归档"
                  >
                    <Icon name={showArchived ? 'chevron-down' : 'chevron-right'} size={12} />
                    <Icon name="archive" size={12} />
                    已归档 {archivedDms.length}
                  </button>
                  {showArchived ? archivedDms.map((d) => (
                    <button
                      key={d.id}
                      className={`dm-row${d.id === activeId ? ' on' : ''}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', border: 'none', background: d.id === activeId ? 'var(--bg-surface-2,#f1f5f9)' : 'transparent', cursor: 'pointer', textAlign: 'left', opacity: 0.72 }}
                      onClick={() => navigate(`/dm/${d.id}`)}
                    >
                      <Icon name="archive" size={13} className="faint" />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                        {d.title != null && d.title.length > 0 ? d.title : d.peerDisplayName ?? '成员'}
                      </span>
                      <Tag tone="neutral">已归档</Tag>
                    </button>
                  )) : null}
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* 对话区：两区并排时固定到可读下限（440），余量给预览；单区域时占满。 */}
        {dmShowContext ? (
          <div style={{ display: 'flex', flexDirection: 'column', flex: dmSingle ? '1 1 100%' : dmTwoRegion ? `0 0 ${DM_MIN_CONTEXT}px` : '1 1 auto', width: 'auto', minWidth: 0, minHeight: 0 }}>
            {active == null ? (
              <div className="panel info" style={{ margin: 14 }}>选择或新建一个私信会话。</div>
            ) : (
              <>
                <div className="thread-head" style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
                  <div className="row tight" style={{ flexWrap: 'wrap', gap: 8 }}>
                    <span className="strong">{dmTitle}</span>
                    {active.archivedAt != null ? <Tag tone="neutral" icon="archive">已归档 · 只读</Tag> : null}
                    <span className="faint small">
                      {EXEC_TEXT[active.execState ?? 'idle'] ?? ''}
                      {active.queuedCount != null && active.queuedCount > 0 ? ` · 排队 ${active.queuedCount} 条` : ''}
                      {active.stopPending === true ? ' · 停止退出未确认' : ''}
                    </span>
                    <span style={{ flex: 1 }} />
                    {/* R74-P2：收起预览后的重开入口（与房间头部同款——hidden 时 PreviewPane
                        不挂载，私信内需有独立恢复入口，自动收起不是单向门）。 */}
                    <PreviewReopenButton />
                    {/* 状态动作：执行态相关（停止/继续）就地常驻——它们是当前会话的事实，不是菜单项 */}
                    {active.activeTaskId != null && active.activeRunId != null ? (
                      <button className="btn ghost sm" disabled={busy != null} title={`停止执行（task.run 三重绑定：代次 ${active.activeStopGeneration ?? 0}——过时绑定由服务端拒绝）`} onClick={() => void doStop()}>停止执行</button>
                    ) : null}
                    {active.execState === 'paused' || (active.queuedCount ?? 0) > 0 ? (
                      <button className="btn ghost sm" disabled={busy != null} title="继续队列（dm.resume——显式泵一条排队消息，不自动连发）" onClick={() => void doResume()}>继续队列</button>
                    ) : null}
                    <button
                      className="icon-btn sm"
                      title="会话操作（重命名 / 归档 / 导出会话记录 / 原界面）"
                      aria-haspopup="menu"
                      data-zs-dm-ops="hifi"
                      onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setOpsAt({ x: r.right - 260, y: r.bottom + 4 }); }}
                    >
                      <Icon name="more-horizontal" size={14} />
                    </button>
                  </div>
                  {renaming != null ? (
                    <div className="row tight" style={{ marginTop: 8 }}>
                      <input
                        className="composer-input" style={{ minWidth: 200 }}
                        placeholder="会话标题（1–120 字）"
                        value={renameText}
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void doRename(); } if (e.key === 'Escape') setRenaming(null); }}
                      />
                      <button className="btn sm" disabled={busy != null} onClick={() => void doRename()}>保存</button>
                      <button className="btn ghost sm" onClick={() => setRenaming(null)}>取消</button>
                    </div>
                  ) : null}
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
                {/* 返工待执行（r58 验收与执行分离；r59 状态分列）：尚未执行/执行中按真实
                    事实作主标题（不再已入队仍称「尚未执行」），明确入口续跑、不自动执行。 */}
                {active.reworkPending != null ? (
                  <div className="panel info" style={{ margin: '8px 14px 0' }} data-zs-dm-rework="hifi" data-zs-dm-rework-state={active.reworkPending.queued ? 'executing' : 'recorded'}>
                    <div className="row tight wrap">
                      <Icon name="refresh" size={13} />
                      <strong>{active.reworkPending.queued ? '返工执行中（已入队/派发）' : '返工意见已记录、尚未执行'}</strong>
                      <Tag tone="warning">v{active.reworkPending.deliveryRevision} 被要求修改</Tag>
                      <span style={{ flex: 1 }} />
                      {active.reworkPending.queued ? (
                        <span className="faint small">完成后交付升级为新待验收版本</span>
                      ) : (
                        <button className="btn sm" disabled={busy != null} data-zs-dm-rework-run="1" title={`执行返工（task.executeRework——同任务新执行，意见注入模型输入；绑定 v${active.reworkPending.deliveryRevision} 完整身份）`} onClick={doExecuteRework}>执行返工</button>
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
                    <MessageView
                      key={m.id}
                      message={{ ...m, saved: savedRefs[m.id] === true }}
                      author={m.authorType === 'human' ? undefined : members.find((x) => x.id === m.authorId)}
                      onOpenAttachment={(att) => openPreview({ attachmentId: att.artifactId, filename: att.filename, kind: att.kind, conversationId: active.id, origin: '私信会话' })}
                      onSave={() => void toggleSavedMessage(m, active.projectId).then((r) => {
                        if (r.ok) { toast(r.saved ? '已收藏（独立保存，不改动原内容）' : '已取消收藏（原消息不受影响）', 'success'); return; }
                        if (r.busy === true) return;
                        toast(`收藏操作失败：${r.error ?? '未知错误'}（状态未变）`, 'error');
                      })}
                      onReact={(emoji) => { void command('message.react', { messageId: m.id, emoji }).then(() => loadDmHistory(active.id)).catch((e: unknown) => toast(`表情失败：${(e as Error).message}`, 'error')); }}
                      onQuote={() => {
                        const excerpt = m.body.replace(/\s+/g, ' ').trim().slice(0, 80);
                        setInsertText({ id: Date.now(), text: `> 引用消息（${m.id.slice(0, 10)}…）：${excerpt}` });
                        toast('已插入引用到输入框（引用不直接触发新任务）', 'success');
                      }}
                    />
                  ))}
                </div>
                {active.archivedAt != null ? (
                  <div className="panel info" style={{ margin: '0 14px 12px' }}>已归档会话禁止新发——「取消归档」在右上 ⋯ 菜单（恢复后排队消息用「继续队列」显式推进，不自动续跑）。</div>
                ) : (
                  <Composer
                    target={{ kind: 'dm', roomId: `dm:${active.id}`, dmId: active.id }}
                    draftKey={`dm:${active.id}`}
                    showMentions={false}
                    formalLimits={FORMAL_LIMITS}
                    insertText={insertText ?? undefined}
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
                      const env = buildDmEnvelope(p.commandId, active.id, p.body, intent, refs.refs, { imageAck: p.imageAck, attachmentRanges: attachmentRangesFromDraft(draftKey) });
                      env.revAtSend = p.draftRev;
                      const staged = stageOutbound(draftKey, env); // r62 P1：预 bridge 耐久落账（三态收口）
                      if (staged.ok !== true) return { status: 'failed', error: staged.error ?? '原信封未能耐久保存' };
                      const r = await sendEnvelope(env);
                      if (r.status === 'ok') settleOutbound(draftKey, env);
                      else if (r.status === 'failed') dropOutbound(draftKey, env);
                      else confirmOutboundUnknown(draftKey, env);
                      if (r.status === 'ok') {
                        void loadDmHistory(active.id, { markRead: true }).catch(() => { /* 读失败另有呈现 */ });
                        void refreshDms().catch(() => { /* 列表失败另有呈现 */ });
                        toast(intent === 'record_only' ? '已仅记录（不派发）' : '已发送', 'success');
                        return { status: 'ok' };
                      }
                      return r.status === 'failed' ? { status: 'failed', error: `${r.code}: ${r.error}` } : { status: 'unknown', error: r.error };
                    })()}
                  />
                )}
              </>
            )}
          </div>
        ) : null}

        {/* 私信预览：dm audience 隔离；两区并排时吃余量（≥480 下限），单区域占满。
            挂载不依赖 dmHasPreview：首个标签经 legacy 桥接（store.openPreview 单目标→
            PreviewPane 内 effect 归一为标签）产生——若只在有标签时挂载会形成死锁
            （标签永远不出现）。零标签时组件自身渲染 null（不占宽）。 */}
        {active != null && dmMountPreview ? (
          <PreviewPane
            context={{ kind: 'dm', projectId: active.projectId, conversationId: active.id, threadId: active.threadId }}
            quoteTarget={{ draftKey: `dm:${active.id}`, label: `与 ${dmTitle} 的私信` }}
            className="dm-preview"
            singleRegion={dmSingle}
            onBackToContext={() => setDmRegion('context')}
            flexStyle={{
              flex: dmSingle ? '1 1 100%' : '1 1 auto',
              minWidth: dmSingle ? 0 : DM_MIN_PREVIEW,
            }}
          />
        ) : null}
      </div>

      {/* ⋯ 会话操作菜单（R66 P5：重命名/归档/导出会话记录/原界面——头部不铺满按钮）。 */}
      {opsAt != null ? (
        <Menu anchor={opsAt} onClose={() => setOpsAt(null)}>
          <div className="menu-label">{dmTitle} · 会话操作</div>
          <MenuItem icon="edit" title="重命名会话（conversation.rename——revision CAS，他人改动会冲突如实报错）" onClick={() => { setRenameText(active?.title ?? ''); setRenaming({ conversationId: activeId, revision: active?.revision ?? 0 }); setOpsAt(null); }}>重命名…</MenuItem>
          {active?.archivedAt != null ? (
            <MenuItem icon="refresh" title="取消归档（conversation.restore——不自动续跑）" onClick={() => { setOpsAt(null); void doRestore(); }}>取消归档</MenuItem>
          ) : (
            <MenuItem icon="archive" title="归档（禁新发/新派发；活动运行走正式停止；历史只读）" onClick={() => { setOpsAt(null); void doArchive(); }}>归档会话…</MenuItem>
          )}
          <div className="menu-sep" />
          <MenuItem icon="download" title="导出这条会话的消息记录与托管附件（export.create 快照事务内固定；重放幂等）——不是保存当前预览的单个文件" onClick={() => { setOpsAt(null); void doExport('md'); }}>导出会话记录（Markdown）…</MenuItem>
          <MenuItem icon="download" title="导出这条会话的 HTML 记录" onClick={() => { setOpsAt(null); void doExport('html'); }}>导出会话记录（HTML）…</MenuItem>
          <MenuItem icon="download" title="导出这条会话的 DOCX 记录" onClick={() => { setOpsAt(null); void doExport('docx'); }}>导出会话记录（DOCX）…</MenuItem>
          <div className="menu-sep" />
          <MenuItem icon="external-link" title="在本会话的原界面打开（尚未换装的能力经此可达）" onClick={() => { setOpsAt(null); void import('./App').then((m) => m.takeLegacy('current-dm')); }}>在原界面打开</MenuItem>
        </Menu>
      ) : null}

      {/* 新建私聊（1 对 1：选一位成员——正式 conversation.create）。 */}
      {createOpen ? (
        <CreateDmModal members={members} onClose={() => setCreateOpen(false)} onCreated={(cid) => { setCreateOpen(false); navigate(`/dm/${cid}`); }} />
      ) : null}
    </div>
  );
}

function CreateDmModal({ members, onClose, onCreated }: {
  members: Array<{ id: string; displayName: string; model?: string }>;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      size="md"
      title="新建私聊"
      subtitle="1 对 1：选择一位成员（独立会话与可见范围——同一成员可有多条私聊，互不串上下文）"
      onClose={onClose}
      footer={
        <>
          <span className="small faint">{picked == null ? '请选择一位成员' : `将与 ${members.find((m) => m.id === picked)?.displayName ?? '?'} 创建私聊`}</span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={picked == null || busy}
            onClick={() => {
              if (picked == null) return;
              setBusy(true);
              void createDm(picked)
                .then((cid) => onCreated(cid))
                .catch((e: unknown) => { toast(`新建私信失败：${(e as Error).message}`, 'error'); setBusy(false); });
            }}
          >
            <Icon name="plus" size={12} /> {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      {members.length === 0 ? (
        <div className="panel info">本项目还没有 Agent 成员——先在「成员管理」确认成员存在。</div>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          {members.map((m) => (
            <label key={m.id} className={`wpolicy${picked === m.id ? ' on' : ''}`} style={{ padding: '8px 10px', cursor: 'pointer' }}>
              <input type="radio" name="dm-member" checked={picked === m.id} onChange={() => setPicked(m.id)} />
              <div className="row tight" style={{ flex: 1 }}>
                <Avatar name={m.displayName} size={22} round />
                <span className="strong">{m.displayName}</span>
                <div className="spacer" />
                {m.model != null ? <span className="small faint">{m.model}</span> : null}
              </div>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}
