import { userFacingSystemText } from '../../contracts/userFacingText';
/**
 * 线程视图（第五十一轮 H2 首版；r55 增「成果与附件」真实标签页）：主池线程卡 → 回复串页面
 * ——回复 / 详情（任务概况/交付验收）/ 成果与附件 三个可达视图；活动/成员/运行/研讨未换装，
 * 经「原界面」定向并如实标注。
 *
 * 正式链（review-r50 §4 修正后的 DTO 适配）：thread.get（实体+根消息+水位）→
 * thread.history（items+rootAttachments）→ task.get（pendingDelivery 只有 id/revision/
 * manifest_hash 三重身份——不猜其余字段）。回复=message.submit thread 目标（**不另建根
 * 任务**；历史记录串仍保留原消息语义，R90 起续聊发送新的 AI 请求）；停止绑定装载的 run+停止
 * 代次（过时绑定由服务端拒绝）；验收/返工在打开意见框时**冻结交付三重身份快照**（目标
 * 变化不悄悄换稿，review-r44/45 同判）。readGate=线程独立水位+当前导航/前台/贴底/接管
 * （不与 DM conversationSeq 门混用）。**关闭视图不停止执行**——卸载只清定时器/门。
 * r55：成果标签=attachment.listByConversation（会话附件，带真实版本/hash——预览头身份
 * 同源）+ files.view 交付成果按本任务过滤（#delivery= 深链定位）；回复消息收藏接
 * saved.add（独立保存，不改动原内容）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { latestReadableAgentMessageId, MessageView } from './components/MessageView';
import { ATTACHMENT_KIND_LABEL } from './components/MessageView';
import { Composer } from './components/Composer';
import type { FormalSendOutcome } from './components/Composer';
import { Icon } from './components/Icon';
import { Tag } from './components/ui';
import { useStore, loadThread, loadThreadOlder, refreshThreadTask, retryUnknownSend, setThreadReadGate, toast, setState } from './shell';
import { buildThreadEnvelope, sendEnvelope, stopThreadTask, submitTaskReview, executeTaskRework, attachmentRefsFromDraft, attachmentRangesFromDraft, markThreadReadIfAllowed, toggleSavedMessage, type ReviewSnapshot } from './loader';
import { openPreview, recordWrite, stageOutbound, settleOutbound, dropOutbound, confirmOutboundUnknown } from './data/store';
import { registerDeliveryResource, openPreviewTab } from './data/actions-preview';
import { command, openExportDir } from './bridge';
import { navigate } from './lib/router';

const EMPTY: never[] = [];
const FORMAL_LIMITS = {
  method: '对话串内继续使用任务原有的执行方式',
  access: '当前使用成员的默认权限',
} as const;

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: '执行中', WAITING_USER: '待你处理', BLOCKED: '受阻', REVIEW: '待验收', DONE: '已完成',
  CANCELLED: '已取消', FAILED: '失败', RUNNING: '运行中', WAITING: '排队中', STOPPING: '停止中',
};

/** 详情里未换装的分组——定向原界面（同房间），如实标注而非隐藏（r55：成果与附件已换装
 *  为本页真实标签，从本列表移除；文案不再写「R52 后接入」这类过期承诺）。 */
const LEGACY_SECTIONS: Array<{ key: string; label: string; note: string }> = [
  { key: 'activity', label: '活动与进展', note: '过程说明/程序校验记录在原界面（聚合活动流在新界面「活动流」页）' },
  { key: 'members', label: '参与成员', note: '参与者名单与关注状态在原界面（成员管理在新界面侧栏）' },
  { key: 'run', label: '运行详情', note: '运行/轮次明细在原界面' },
  { key: 'deliberation', label: '研讨详情', note: '研讨进度在原界面' },
];

/** 成果标签页的数据形态（attachment.listByConversation / files.view.deliveries）。 */
interface ConversationAttachment { attachmentId: string; filename: string; kind: string; hash: string; revision: number; createdAt: number }
interface DeliveryRow { deliveryId: string; revision: number; manifestHash: string; taskId: string; title: string; audience: 'dm' | 'room'; reviewedAt: number | null; locate: string }

export function ThreadPage({ threadId, initialTab, highlightMessageId }: { threadId: string; initialTab?: string; highlightMessageId?: string }) {
  const entity = useStore((s) => s.threadEntities[threadId]);
  const anchor = useStore((s) => s.threadAnchors[threadId]);
  const replies = useStore((s) => s.threadMessages[threadId]);
  const task = useStore((s) => s.threadTasks[threadId]);
  const readSeq = useStore((s) => s.threadReadSeq[threadId]);
  const readError = useStore((s) => s.readErrors[`thread:${threadId}`]);
  const savedRefs = useStore((s) => s.savedMessageRefs);
  const membersAll = useStore((s) => s.members);
  const allRooms = useStore((s) => s.rooms);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<'replies' | 'task' | 'artifacts'>(initialTab === 'task' ? 'task' : initialTab === 'artifacts' ? 'artifacts' : 'replies');
  /** 验收/返工框打开时冻结的交付快照（deliveryId/revision/manifestHash——提交只带这份）。
   *  r57：切线程即作废（同 DM 跨会话修复）；作废判定含完整身份（同 revision 不同交付也作废）。 */
  const [reviewBox, setReviewBox] = useState<{ threadId: string; mode: 'accept' | 'rework'; snapshot: ReviewSnapshot; note: string } | null>(null);
  /** 执行返工忙态（r58：与其它操作分列——面板独立呈现）。 */
  const [busyRework, setBusyRework] = useState(false);
  useEffect(() => { setReviewBox(null); }, [threadId]);
  const [stopping, setStopping] = useState(false);
  /** 成果标签页数据（r55）：会话附件 + 本任务交付（files.view 过滤）——代次收口，迟到不污染。 */
  const [artifacts, setArtifacts] = useState<{ attachments: ConversationAttachment[]; attErr: string | null; deliveries: DeliveryRow[]; delErr: string | null } | null>(null);
  const artGenRef = useRef(0);
  /** 人的阅读订阅（r56 H4：thread.subscribe 关注/静音——与 Agent 执行名单分列）。 */
  const [sub, setSub] = useState<{ followed: boolean; muted: boolean } | null>(null);
  /** 消息引用插入（r56：消息菜单「引用」→ 草稿追加引用块——只改草稿，不派发）。 */
  const [insertText, setInsertText] = useState<{ id: number; text: string } | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const isRecordThread = entity != null && entity.rootTaskId == null;
  const msgs = replies ?? EMPTY;
  const latestReadableAgentId = useMemo(() => latestReadableAgentMessageId(msgs), [msgs]);
  const projectIdOfRoom = useMemo(() => allRooms.find((r) => r.id === entity?.roomId)?.projectId ?? null, [allRooms, entity?.roomId]);

  // 装载（含任务详情）+ 阅读水位（门在发起此刻重查——ThreadPage 注册的独立线程门）。
  useEffect(() => {
    void loadThread(threadId, { markRead: true });
  }, [threadId]);
  // 人的阅读订阅事实（r56）：thread.subscriptions 只读查询本线程行（读失败不显示状态，不冒充）。
  useEffect(() => {
    let done = false;
    void command<{ items: Array<{ threadId: string; followed: boolean; muted: boolean }> }>('thread.subscriptions', {})
      .then((r) => { if (!done) setSub(() => { const hit = r.items.find((x) => x.threadId === threadId); return hit != null ? { followed: hit.followed, muted: hit.muted } : { followed: false, muted: false }; }); })
      .catch(() => { /* 读失败=不显示关注态（按钮仍可用，点击后按回执更新） */ });
    return () => { done = true; };
  }, [threadId]);
  const toggleSub = async (patch: { follow?: boolean; mute?: boolean }) => {
    setSubBusy(true);
    try {
      const r = await command<{ followed: boolean; muted: boolean }>('thread.subscribe', { threadId, ...patch });
      setSub({ followed: r.followed, muted: r.muted });
      recordWrite('thread.subscribe', `${patch.follow != null ? (patch.follow ? '关注' : '取消关注') : ''}${patch.mute != null ? (patch.mute ? '静音' : '取消静音') : ''}（人的阅读订阅——不改执行名单）`);
      toast(patch.mute === true ? '已静音（未读/通知聚合排除；待办保留）' : patch.follow === true ? '已关注（有新回复进「待我处理」）' : '订阅已更新', 'success');
    } catch (e) { toast(`订阅更新失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
    finally { setSubBusy(false); }
  };
  // 线程标读门注册（review-r51 §4 修复）：当前线程+**当前回复视图**+前台+非接管+贴底——
  // 滚动容器**必须实际存在**（详情视图/未挂载时 listRef 为 null → 一律拒绝，缺省不标读）。
  // 门在 markRead 发起时重查本闭包；tab 变化时重注册（gate 引用最新 tab）。
  useEffect(() => {
    setThreadReadGate((tid: string) =>
      tid === threadId
      && tab === 'replies'
      && document.visibilityState === 'visible'
      && !document.body.classList.contains('legacy-on')
      && (() => { const box = listRef.current; return box != null ? (box.scrollHeight - box.scrollTop - box.clientHeight < 80) : false; })());
    return () => { setThreadReadGate(null); };
  }, [threadId, tab]);
  // 同线程的 query 参数变化（?tab= 深链/前进后退）同步视图——初始 useState 只吃首帧（review-r51 §3.2）。
  useEffect(() => {
    const next = initialTab === 'task' ? 'task' : initialTab === 'artifacts' ? 'artifacts' : 'replies';
    setTab((cur) => (cur === next ? cur : next));
  }, [initialTab]);
  // r61 G7：在成果/详情标签下从预览「引用文件/摘录」——切回回复标签让输入区立即可见
  //（引用直写草稿不依赖此切换，但用户必须能看见落点，不要求先手动切回复再点）。
  useEffect(() => {
    const onFocus = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === `thread:${threadId}`) setTab('replies');
    };
    window.addEventListener('zs:focus-composer', onFocus);
    return () => window.removeEventListener('zs:focus-composer', onFocus);
  }, [threadId]);

  // 成果标签页装载（r55）：会话附件=attachment.listByConversation（真实版本/hash→预览头同源）；
  // 本任务交付=files.view(scope=project) 按 taskId 过滤（复用既有只读聚合，不另开命令面）。
  // 代次收口：切线程/切标签的迟到响应丢弃；失败分列如实（附件失败不掩盖交付失败）。
  useEffect(() => {
    if (tab !== 'artifacts' || entity == null) return;
    const gen = ++artGenRef.current;
    const conversationId = entity.conversationId ?? '';
    let cancelled = false;
    void (async () => {
      const next: { attachments: ConversationAttachment[]; attErr: string | null; deliveries: DeliveryRow[]; delErr: string | null } = { attachments: [], attErr: null, deliveries: [], delErr: null };
      if (conversationId !== '') {
        try {
          const r = await command<{ items: ConversationAttachment[] }>('attachment.listByConversation', { conversationId });
          if (gen !== artGenRef.current) return;
          next.attachments = r.items ?? [];
        } catch (e) { if (gen === artGenRef.current) next.attErr = (e as Error).message; }
      } else {
        next.attErr = '线程归属会话未知（conversationId 缺失）';
      }
      if (!cancelled && gen === artGenRef.current) setArtifacts({ ...next }); // 先上附件（交付慢不阻塞）
      if (task?.id != null && projectIdOfRoom != null) {
        try {
          const r = await command<{ groups: Array<{ projectId: string; deliveries: DeliveryRow[] }> }>('files.view', { scope: 'project', projectId: projectIdOfRoom });
          if (gen !== artGenRef.current) return;
          next.deliveries = (r.groups.find((g) => g.projectId === projectIdOfRoom)?.deliveries ?? []).filter((d) => d.taskId === task.id);
        } catch (e) { if (gen === artGenRef.current) next.delErr = (e as Error).message; }
      } else if (task == null) {
        next.delErr = null; // 记录串无任务——没有交付是事实，不是错误
      } else {
        next.delErr = '所属项目未知（无法按任务过滤交付）';
      }
      if (!cancelled && gen === artGenRef.current) setArtifacts({ ...next });
    })();
    return () => { cancelled = true; };
  }, [tab, entity?.conversationId, task?.id, projectIdOfRoom]);
  // 可见时轻量刷新（回复/任务状态可见；隐藏/接管暂停——关闭视图不停止执行，只停轮询）。
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('legacy-on')) void loadThread(threadId);
    }, 5000);
    return () => { window.clearInterval(t); };
  }, [threadId]);
  // 活动目标追踪（接管定位用）。
  useEffect(() => { setState((st) => ({ ...st, ui: { ...st.ui, activeRoomId: entity?.roomId ?? st.ui.activeRoomId } })); }, [entity?.roomId]);
  // 直达消息定位（review-r51 §3.2 修复 + r56 长历史补读）：等目标元素**实际存在**再滚动+高亮；
  // 不在已装载窗口时按 beforeSeq 游标**补读**（每轮 100 条，至多 5 轮），仍未见才如实「未定位」
  // ——不静默冒充，也不只改路由。
  useEffect(() => {
    if (highlightMessageId == null) return;
    setTab('replies');
    let cancelled = false;
    let rounds = 0;
    const locate = () => {
      if (cancelled) return;
      const el = document.getElementById('msg-' + highlightMessageId);
      if (el != null) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('msg-highlight');
        window.setTimeout(() => el.classList.remove('msg-highlight'), 2600);
        return;
      }
      rounds += 1;
      if (rounds > 6) {
        toast('目标消息（' + highlightMessageId.slice(0, 14) + '…）不在可补读范围（500 条）内——未定位', 'warn');
        return;
      }
      // 补读一轮更早历史（首条已装载回复的 seq 之前），到头（返回 0）即如实说明。
      const first = (replies ?? [])[0];
      if (first == null || (first.threadMessageSeq ?? 0) <= 1) {
        toast('目标消息（' + highlightMessageId.slice(0, 14) + '…）不在本线程历史内——未定位', 'warn');
        return;
      }
      void loadThreadOlder(threadId, first.threadMessageSeq ?? 1).then((added) => {
        if (cancelled) return;
        if (added === 0) { toast('目标消息（' + highlightMessageId.slice(0, 14) + '…）已到历史尽头仍未见——未定位', 'warn'); return; }
        window.setTimeout(locate, 300);
      }).catch(() => { if (!cancelled) toast('补读历史失败——未定位（可稍后重试）', 'warn'); });
    };
    const t = window.setTimeout(locate, 200);
    return () => { cancelled = true; window.clearTimeout(t); };
    // replies 引用变化不重跑（只按目标消息驱动——补读后由 locate 自轮询）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightMessageId, threadId]);

  // 贴底滚动推进水位（第五十二轮）：门在 markThreadReadIfAllowed 发起时重查——仅当前回复
  // 视图+实际容器+前台+贴底才推进；节流 1.5s。
  const lastMarkRef = useRef(0);
  const onListScroll = () => {
    const box = listRef.current;
    if (box == null) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > 80) return;
    const now = Date.now();
    if (now - lastMarkRef.current < 1500) return;
    lastMarkRef.current = now;
    void markThreadReadIfAllowed(threadId);
  };

  const memberById = useMemo(() => new Map(membersAll.map((m) => [m.id, m])), [membersAll]);
  const firstUnreadSeq = useMemo(() => {
    if (readSeq == null || readSeq <= 0) return undefined;
    const first = msgs.find((m) => (m.threadMessageSeq ?? 0) > readSeq && m.authorType !== 'human');
    return first?.threadMessageSeq;
  }, [msgs, readSeq]);

  if (entity == null) {
    return (
      <div className="page-stack" style={{ padding: 16 }}>
        {readError != null ? (
          <div className="panel info" style={{ borderColor: 'var(--warning)' }}>读取失败：{userFacingSystemText(readError ?? '')}（保留上次快照——可返回主池重进）</div>
        ) : (
          <div className="panel info">正在打开回复串…</div>
        )}
        <button className="btn ghost sm" onClick={() => window.history.back()}>返回</button>
      </div>
    );
  }

  const backToPool = () => navigate(`/room/${entity.roomId}`);
  const conversationId = entity.conversationId ?? '';
  const taskNo = task != null ? `#${task.roomTaskNumber}` : null;
  const delivery = task?.delivery;
  const statusLabel = task?.status === 'REVIEW' ? STATUS_LABEL.REVIEW
    : delivery?.status === 'delivered_with_questions' ? '已交付 · 有待确认'
      : delivery?.status === 'needs_user' ? '等待你补充'
        : delivery?.status === 'blocked' ? '交付未完成'
          : delivery?.status === 'legacy' ? '本轮已结束 · 旧格式'
            : task != null ? STATUS_LABEL[task.status] ?? task.status : null;
  const statusTone = task?.status === 'REVIEW' ? 'info'
    : delivery?.status === 'blocked' ? 'danger'
      : delivery?.status === 'needs_user' || delivery?.status === 'delivered_with_questions' || delivery?.status === 'legacy' ? 'warning'
        : task?.status === 'DONE' ? 'success' : 'neutral';
  const stoppable = task != null && ['ACTIVE', 'WAITING_USER', 'BLOCKED'].includes(task.status);
  const runStopping = task?.activeRun?.status === 'STOPPING';

  const openPreviewAtt = (att: { artifactId: string; filename: string; kind: string; revision?: number; hash?: string }) => {
    // 共享预览（第五十二轮 §6.1）：全类型经 PreviewPane（正式 preview* 命令+随包渲染器）。
    openPreview({ attachmentId: att.artifactId, filename: att.filename, kind: att.kind, conversationId, origin: '任务线程', revisionHint: att.revision, hashHint: att.hash });
  };

  /** R68 §6：打开交付文档（共享预览第三来源）——登记 delivery 资源并开标签；版本=交付
   *  revision、hash=manifest（不可变快照；正文经 delivery.document 按需装载并核对 hash）。 */
  const openDeliveryDoc = (d: { deliveryId: string; revision: number; manifestHash: string; taskId: string; title: string; audience: 'dm' | 'room' }) => {
    const target = { kind: 'thread' as const, projectId: entity.projectId, roomId: entity.roomId, threadId, tab: 'artifacts' as const };
    const rid = registerDeliveryResource({
      deliveryId: d.deliveryId, revision: d.revision, manifestHash: d.manifestHash,
      conversationId, threadId, taskTitle: d.title, audience: d.audience, roomId: entity.roomId,
      openedFrom: target,
    });
    openPreviewTab(rid, d.revision, { target });
    recordWrite('preview.delivery', `打开交付文档 ${d.deliveryId.slice(0, 14)}… v${d.revision}（交付校验值 ${d.manifestHash.slice(0, 8)}…）`);
  };

  const doStop = async () => {
    setStopping(true);
    const r = await stopThreadTask(threadId);
    setStopping(false);
    if (r.ok) toast('停止请求已提交，正在等待执行结束', 'success');
    else toast(`停止失败：${userFacingSystemText(r.error ?? '')}`, 'error');
  };

  /** 收藏切换（r61 G6：按钮按正式收藏事实显示已收藏状态——再次点击取消；连点互斥由
   * toggleSavedMessage 按 in-flight 忽略，第一笔回执决定状态；失败如实提示且状态不变）。 */
  const saveMessage = async (m: { id: string; body: string }) => {
    const r = await toggleSavedMessage(m, projectIdOfRoom);
    if (r.ok) {
      toast(r.saved ? '已收藏（独立保存，不改动原内容——侧栏「搜索与收藏」页可见）' : '已取消收藏（原消息不受影响）', 'success');
      return;
    }
    if (r.busy === true) return; // 快速连点：忽略后到点击——第一笔在途，回执后再看状态
    toast(`收藏操作失败：${userFacingSystemText(r.error ?? '未知错误')}（状态未变）`, 'error');
  };

  /** 消息引用（r56：插入草稿——只改变草稿，不直接派发）。 */
  const quoteMessage = (m: { id: string; body: string; authorType?: string }) => {
    const excerpt = m.body.replace(/\s+/g, ' ').trim().slice(0, 80);
    setInsertText({ id: Date.now(), text: `> 引用${m.authorType==='human'?'你':'回复'}：${excerpt}` });
    toast('已插入引用到输入框（引用不直接触发新任务）', 'success');
  };
  /** 消息表情（r56：message.react 正式命令——toggle 幂等；本地用户操作，不作为共识）。 */
  const reactMessage = async (m: { id: string }, emoji: string) => {
    try {
      await command('message.react', { messageId: m.id, emoji });
      void loadThread(threadId).catch(() => { /* 刷新失败另有呈现 */ });
    } catch (e) { toast(`表情失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
  };
  /** 导出本线程（r56：export.create thread 目标——快照事务固定消息+附件；打开导出目录走白名单）。 */
  const exportThread = async (format: 'md' | 'html' | 'docx') => {
    if (projectIdOfRoom == null || conversationId === '') { toast('线程归属未装载（项目/会话缺失）——稍后重试', 'error'); return; }
    try {
      const r = await command<{ exportId: string; dir: string; files: string[]; stats: { messages: number; attachments: number } }>('export.create', { target: { kind: 'thread', projectId: projectIdOfRoom, conversationId, threadId }, format });
      recordWrite('export.create', `导出线程 ${format}（${r.stats.messages} 消息/${r.stats.attachments} 附件 → ${r.exportId}）`);
      toast(`已导出 ${format.toUpperCase()}（${r.stats.messages} 消息 · ${r.files.length} 文件）`, 'success');
      void openExportDir(r.dir).catch((e: unknown) => toast(`打开导出目录失败：${userFacingSystemText((e as Error).message ?? '')}（目录 ${r.dir}）`, 'error'));
    } catch (e) { toast(`导出失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'); }
  };

  const openReview = (mode: 'accept' | 'rework') => {
    if (task?.pendingDelivery == null) return;
    // 打开即冻结三重身份（id+revision+manifestHash）——此后刷新出新交付也不悄悄换稿；绑定线程。
    const d = task.pendingDelivery;
    setReviewBox({ threadId, mode, snapshot: { taskId: task.id, deliveryId: d.id, deliveryRevision: d.revision, manifestHash: d.manifestHash }, note: '' });
  };
  const submitReview = async () => {
    if (reviewBox == null) return;
    if (reviewBox.threadId !== threadId) { toast('验收目标已切换（框属其它线程）——作废零提交', 'warn'); setReviewBox(null); return; }
    if (reviewBox.mode === 'rework' && reviewBox.note.trim().length === 0) {
      toast('请填写修改意见，AI 会据此继续修改。', 'warn');
      return;
    }
    const r = await submitTaskReview(reviewBox.snapshot, reviewBox.mode === 'accept' ? 'accept' : 'changes_requested', reviewBox.mode === 'rework' ? reviewBox.note.trim() : undefined, threadId);
    if (r.ok) { toast(reviewBox.mode === 'accept' ? '已验收通过（任务完成）' : '返工意见已记录、尚未执行——点击「执行返工」继续', 'success'); setReviewBox(null); void loadThread(threadId); }
    else { toast(`提交失败：${userFacingSystemText(r.error ?? '')}——意见已保留可修正重提；若交付已变化本框将作废`, 'error'); }
  };
  /** 执行返工（r58 验收与执行分离；r59 完整身份）：点击时冻结 reworkPending 快照——
   * 服务端核对当前返工事实，旧引用 STALE 拒绝不改绑。 */
  const doExecuteRework = () => {
    const rp = task?.reworkPending;
    if (task == null || rp == null) return;
    const snapshot = { taskId: task.id, deliveryId: rp.deliveryId, deliveryRevision: rp.deliveryRevision, manifestHash: rp.manifestHash, sourceRunId: rp.sourceRunId };
    setBusyRework(true);
    void (async () => {
      try {
        const r = await executeTaskRework(snapshot, threadId);
        if (!r.ok) { toast(`执行返工被拒：${userFacingSystemText(r.error ?? '')}——已刷新为当前返工事实`, 'error'); void loadThread(threadId); return; }
        toast('返工执行已入队（同任务新执行——完成后交付升级为新待验收版本）', 'success');
        void loadThread(threadId);
      } finally { setBusyRework(false); }
    })();
  };

  const detail = task;
  const pendingDeliveryStale = reviewBox != null && detail?.pendingDelivery != null
    && (detail.pendingDelivery.id !== reviewBox.snapshot.deliveryId
      || detail.pendingDelivery.revision !== reviewBox.snapshot.deliveryRevision
      || detail.pendingDelivery.manifestHash !== reviewBox.snapshot.manifestHash
      || reviewBox.threadId !== threadId);

  return (
    <div className="page-stack" style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, flex: 1 }}>
      {/* 单行紧凑导航（减负 §2 既有形态）：收起/返回 + 回复/成果/详情视图键。 */}
      <div className="thread-nav" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
        <button className="btn ghost sm" title="收起回复串，返回房间主池（不会停止任务，草稿保留）" onClick={backToPool}>
          <Icon name="arrow-left" size={13} /> 返回主池
        </button>
        <button role="tab" aria-selected={tab === 'replies'} className={`btn ghost sm${tab === 'replies' ? '' : ''}`} style={tab === 'replies' ? { fontWeight: 600 } : undefined} onClick={() => setTab('replies')}>
          <Icon name="message-square" size={13} /> 回复 <span className="faint">{msgs.length}</span>
        </button>
        <button role="tab" aria-selected={tab === 'task'} className="btn ghost sm" style={tab === 'task' ? { fontWeight: 600 } : undefined} onClick={() => setTab('task')}>
          <Icon name="list" size={13} /> 详情
        </button>
        <button role="tab" aria-selected={tab === 'artifacts'} className="btn ghost sm" style={tab === 'artifacts' ? { fontWeight: 600 } : undefined} onClick={() => setTab('artifacts')} title="本线程的会话附件（真实版本/hash，可预览）与本任务交付成果">
          <Icon name="file-text" size={13} /> 成果与附件
        </button>
        {/* 人的阅读订阅（r56：thread.subscribe——与 Agent 执行名单分列；纯偏好写）。 */}
        <button
          className="btn ghost sm"
          disabled={subBusy}
          data-zs-thread-follow={sub?.followed ? '1' : '0'}
          title={sub?.followed === true ? '已关注：有新回复进「待我处理」（点击取消）' : '关注本线程：有新回复进「待我处理」（人的阅读订阅——不改执行名单）'}
          onClick={() => void toggleSub({ follow: !(sub?.followed ?? false) })}
        >
          <Icon name="star" size={13} />{sub?.followed === true ? '已关注' : '关注'}
        </button>
        <button
          className="btn ghost sm"
          disabled={subBusy}
          data-zs-thread-mute={sub?.muted ? '1' : '0'}
          title={sub?.muted === true ? '已静音：未读/通知聚合排除（待办保留）——点击取消' : '静音：未读/通知聚合排除，待办保留'}
          onClick={() => void toggleSub({ mute: !(sub?.muted ?? false) })}
        >
          <Icon name={sub?.muted === true ? 'eye-off' : 'eye'} size={13} />{sub?.muted === true ? '已静音' : '静音'}
        </button>
        <details className="menu-wrap" style={{ display: 'inline-block' }}>
          <summary className="btn ghost sm" style={{ listStyle: 'none' }}><Icon name="download" size={13} /> 导出聊天</summary>
          <div className="menu" style={{ right: 0, left: 'auto' }}>
            <button className="menu-item" onClick={() => void exportThread('md')}>聊天记录（Markdown）</button>
            <button className="menu-item" onClick={() => void exportThread('docx')}>聊天记录（Word）</button>
          </div>
        </details>
        <div className="spacer" style={{ flex: 1 }} />
        {isRecordThread
          ? <Tag tone="neutral" icon="message-square">历史记录串 · 无任务号</Tag>
          : statusLabel != null ? <Tag tone={statusTone} icon="activity">{taskNo} {statusLabel}</Tag> : null}
      </div>

      {readError != null ? <div className="panel info" style={{ margin: '8px 14px 0', borderColor: 'var(--warning)' }}>读取失败：{userFacingSystemText(readError ?? '')}（保留上次快照——重试=切换视图或等待自动刷新）</div> : null}

      {tab === 'replies' ? (
        <>
          <div className="msg-list is-replies" ref={listRef} onScroll={onListScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {/* 根消息（房间级锚消息——不在 thread 历史内；thread.get anchor 提供） */}
            <div className="panel info" style={{ marginBottom: 8 }} id={`msg-${anchor?.id ?? 'anchor'}`}>
              <div className="row tight">
                <span className="small faint">原消息 · {anchor != null ? new Date(anchor.createdAt).toLocaleString() : '正文无法读取'}</span>
              </div>
              <div style={{ marginTop: 4 }}>{anchor?.body || '暂时无法读取原消息正文'}</div>
              {(anchor?.formalAttachments ?? []).length > 0 ? (
                <div className="msg-inline-attachments" data-zs-inline-attachments="1">
                  {(anchor?.formalAttachments ?? []).map((a) => (
                    <button key={a.artifactId} className={`inline-file-chip${a.kind === 'image_file' ? ' is-image' : ''}`} title={`预览 ${a.filename}（只读，不发送给 AI）`} onClick={() => openPreviewAtt(a)}>
                      <Icon name={a.kind === 'image_file' ? 'image' : 'file-text'} size={12} />
                      <span className="truncate">{a.filename}</span>
                      {/* r55：与回复芯片同一 kind 映射（此前只认 code/text——PPT 显示成「文本」）。 */}
                      <span className="inline-file-kind">{ATTACHMENT_KIND_LABEL[a.kind] ?? a.kind}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {msgs.length === 0 ? <div className="panel info">暂无回复——发送第一条跟进（不另建根任务）。</div> : null}
            {msgs.map((m) => (
              <div key={m.id} className="msg-item">
                {m.threadMessageSeq === firstUnreadSeq ? <div className="unread-divider" style={{ borderTop: '1px solid var(--accent, #2563eb)', margin: '8px 0', fontSize: 11, color: 'var(--accent, #2563eb)', textAlign: 'center' }}>以上未读之后的新回复</div> : null}
                <div id={`msg-${m.id}`}>
                  <MessageView
                    message={{ ...m, saved: savedRefs[m.id] === true }}
                    author={m.authorType === 'human' ? undefined : memberById.get(m.authorId)}
                    readingAids
                    forceExpanded={m.id === latestReadableAgentId}
                    onOpenAttachment={(att) => openPreviewAtt(att)}
                    onSave={() => void saveMessage(m)}
                    onQuote={() => quoteMessage(m)}
                    onReact={(emoji) => void reactMessage(m, emoji)}
                  />
                </div>
              </div>
            ))}
          </div>
          <Composer
            target={{ kind: 'thread', roomId: entity.roomId, threadId }}
            draftKey={`thread:${threadId}`}
            formalLimits={FORMAL_LIMITS}
            insertText={insertText ?? undefined}
            attachmentUpload={conversationId !== '' ? { conversationId } : undefined}
            onRetrySend={(env) => retryUnknownSend(env).then((r) => {
              if (r.status === 'ok') { void loadThread(threadId, { markRead: true }); toast('重发成功（上次发送记录）', 'success'); }
              return r.status === 'ok' ? { status: 'ok' } : r.status === 'failed' ? { status: 'failed', error: r.error } : { status: 'unknown', error: r.error };
            })}
            onSend={(p): Promise<FormalSendOutcome> => (async () => {
              const intent = 'default' as const;
              const draftKey = `thread:${threadId}`;
              const refs = attachmentRefsFromDraft(draftKey, intent);
              if (refs.blockError != null) return { status: 'failed', error: refs.blockError };
              if (conversationId === '') return { status: 'failed', error: '线程归属未装载（conversationId 缺失）——稍后重试' };
              const env = buildThreadEnvelope(p.commandId, threadId, p.body, intent, refs.refs, {
                mentionIds:p.mentionIds,
                ...(p.collaboration?{collaboration:p.collaboration}:{}),
                ...(p.collaboration&&p.budgetMaxTurns!=null?{deliberationBudget:{maxTurns:p.budgetMaxTurns}}:{}),
                imageAck:p.imageAck,
                attachmentRanges:attachmentRangesFromDraft(draftKey),
              });
              env.revAtSend = p.draftRev;
              env.quoteIds = p.quoteIds;
              // r62 P1：完整信封在交给 bridge 之前耐久落账；ok/failed/unknown 三态收口
              //（unknown→pendingSends 横幅=人工同号确认；崩溃窗口见 store 出站账本注释）。
              const staged = stageOutbound(draftKey, env);
              if (staged.ok !== true) return { status: 'failed', error: staged.error ?? '未能保存发送记录，请重试' };
              const r = await sendEnvelope(env);
              if (r.status === 'ok') settleOutbound(draftKey, env);
              else if (r.status === 'failed') dropOutbound(draftKey, env);
              else confirmOutboundUnknown(draftKey, env);
              if (r.status === 'ok') {
                void loadThread(threadId, { markRead: true }).catch(() => { /* 读失败另有呈现 */ });
                toast('已跟进（延续当前任务）', 'success');
                return { status: 'ok' };
              }
              return r.status === 'failed' ? { status: 'failed', error: r.error } : { status: 'unknown', error: r.error };
            })()}
          />
        </>
      ) : tab === 'task' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px' }} className="page-stack">
          {isRecordThread || detail == null ? (
            <div className="panel info">这是历史记录串（无根任务）：历史消息保持原样；继续回复会发送一条新的 AI 请求。</div>
          ) : (
            <>
              <div className="panel info">
                <div className="row tight wrap">
                  <strong>#{detail.roomTaskNumber} {detail.title}</strong>
                  <Tag tone={detail.status === 'DONE' ? 'success' : detail.status === 'REVIEW' ? 'info' : 'neutral'} icon="activity">{STATUS_LABEL[detail.status] ?? detail.status}</Tag>
                  {detail.activeRun != null ? <span className="faint small">run {STATUS_LABEL[detail.activeRun.status] ?? detail.activeRun.status}</span> : <span className="faint small">无活跃 run</span>}
                </div>
                <div className="faint small" style={{ marginTop: 4 }}>状态会在刷新时按实际进度更新。</div>
                {detail.lastStartupFailureMessage != null ? <div className="panel warning" style={{ marginTop: 8 }}>最近一次启动失败：{detail.lastStartupFailureMessage}</div> : null}
                <div className="row tight" style={{ marginTop: 8 }}>
                  {stoppable ? (
                    <button className="btn ghost sm" disabled={stopping || runStopping} title="停止当前执行；如果任务状态已更新，请刷新后再试" onClick={() => void doStop()}>
                      {stopping || runStopping ? '停止中…' : '停止任务'}
                    </button>
                  ) : null}
                  <button className="btn ghost sm" title="刷新任务详情（绑定服务端当前事实）" onClick={() => void refreshThreadTask(threadId).catch((e: unknown) => toast(`刷新失败：${userFacingSystemText((e as Error).message ?? '')}`, 'error'))}>刷新详情</button>
                  {/* 定位链接（r53 §5/T6）：桌面端没有地址栏——给用户一个**可复制**的正式定位符
                      （外部深链 #task=<实体ID>——不是房间任务序号 #N）。粘贴入口（打开定位）随
                      H3 设置页归位；当前跳转核验由工程验证器执行，用户项只核对复制格式。 */}
                  <button
                    className="btn ghost sm"
                    title="复制可在众说中打开的任务链接"
                    onClick={() => {
                      const link = `#task=${detail.id}`;
                      void navigator.clipboard?.writeText(link).then(
                        () => toast(`定位链接已复制：${link}`, 'success'),
                        () => toast(`复制失败——定位链接：${link}`, 'error'),
                      );
                    }}
                  >复制定位链接</button>
                  <span className="faint small">关闭本视图不会停止执行——执行属于任务，不属于页面。</span>
                </div>
              </div>

              <div className="panel info">
                <div className="row tight"><strong>交付与验收</strong></div>
                {detail.pendingDelivery == null ? (
                  <div className="faint small" style={{ marginTop: 4 }}>当前没有等你确认的成果。</div>
                ) : (
                  <>
                    <div className="faint small" style={{ marginTop: 4 }}>
                      最新成果 v{detail.pendingDelivery.revision} 等你确认。确认或要求修改前，版本不会自动切换。
                    </div>
                    <div className="row tight" style={{ marginTop: 8 }}>
                      <button className="btn sm primary" disabled={reviewBox != null} onClick={() => openReview('accept')} title="确认这份成果已经满足要求">确认完成</button>
                      <button className="btn sm" disabled={reviewBox != null} onClick={() => openReview('rework')} title="写下修改意见，再让 AI 修改">按这些意见修改</button>
                      <button className="btn ghost sm" title="查看本任务的成果与附件" onClick={() => setTab('artifacts')}>查看成果与附件</button>
                    </div>
                    {reviewBox != null ? (
                      <div style={{ marginTop: 8 }}>
                        {pendingDeliveryStale ? (
                          <div className="panel warning">
                            交付已更新（打开时查看的是 v{reviewBox.snapshot.deliveryRevision}，当前为 v{detail.pendingDelivery?.revision ?? '?'}）——本框已作废，请对新版本重新操作。
                            <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setReviewBox(null)}>关闭</button>
                          </div>
                        ) : (
                          <>
                            {reviewBox.mode === 'rework' ? (
                              <textarea
                                className="composer-input"
                                style={{ width: '100%', minHeight: 64 }}
                                placeholder="写下希望 AI 修改的地方"
                                value={reviewBox.note}
                                onChange={(e) => setReviewBox((b) => b == null ? b : { ...b, note: e.target.value })}
                              />
                            ) : <div className="faint small">将确认成果 v{reviewBox.snapshot.deliveryRevision} 完成。<details className="faint"><summary>版本身份</summary>{reviewBox.snapshot.deliveryId} · {reviewBox.snapshot.manifestHash}</details></div>}
                            <div className="row tight" style={{ marginTop: 6 }}>
                              <button className="btn sm" onClick={() => void submitReview()}>{reviewBox.mode === 'accept' ? '确认完成' : '保存修改意见'}</button>
                              <button className="btn ghost sm" onClick={() => setReviewBox(null)}>取消</button>
                            </div>
                          </>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
                {/* 返工待执行（r58 验收与执行分离；r59 状态分列）：尚未执行/执行中按真实事实作主标题。 */}
                {detail.reworkPending != null ? (
                  <div className="row tight wrap" style={{ marginTop: 8 }} data-zs-thread-rework="1" data-zs-thread-rework-state={detail.reworkPending.queued ? 'executing' : 'recorded'}>
                    <Icon name="refresh" size={13} />
                    <strong>{detail.reworkPending.queued ? '正在按你的意见修改' : '修改意见已保存，尚未开始'}</strong>
                    <Tag tone="warning">v{detail.reworkPending.deliveryRevision} 待修改</Tag>
                    <span style={{ flex: 1 }} />
                    {detail.reworkPending.queued ? (
                      <span className="faint small">完成后会出现新的待确认版本</span>
                    ) : (
                      <button className="btn sm" disabled={busyRework} title="让 AI 按已保存的意见修改，完成后生成新版本" onClick={doExecuteRework}>开始修改</button>
                    )}
                    {detail.reworkPending.note != null ? <div className="faint small" style={{ width: '100%' }}>验收意见：{detail.reworkPending.note}</div> : null}
                  </div>
                ) : null}
              </div>
            </>
          )}

          <details className="panel info">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>更多任务信息</summary>
            <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
              {LEGACY_SECTIONS.map((sec) => (
                <button key={sec.key} className="btn ghost sm" style={{ justifyContent: 'space-between' }} onClick={() => import('./App').then((m) => m.takeLegacy('current-room'))}>
                  <span>{sec.label}</span>
                  <span className="faint small">打开</span>
                </button>
              ))}
            </div>
          </details>
        </div>
      ) : (
        /* 成果与附件（r55 真实标签——替换原「R52 后接入」占位）：会话附件带真实版本/hash
           （预览头身份同源）；本任务交付来自 files.view 只读聚合。失败分列如实，不伪空态。 */
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 14px' }} className="page-stack" data-zs-thread-artifacts="hifi">
          <div className="panel info" style={{ marginTop: 0 }}>
            <div className="row tight">
              <strong>会话附件</strong>
              <span className="faint small">点击打开，不改变原件。</span>
            </div>
            {artifacts == null ? <div className="faint small" style={{ marginTop: 6 }}>正在装载…</div> : artifacts.attErr != null ? (
              <div className="panel warning" style={{ marginTop: 6 }}>附件列表读取失败：{artifacts.attErr}（可切回其它标签再进重试）</div>
            ) : artifacts.attachments.length === 0 ? (
              <div className="faint small" style={{ marginTop: 6 }}>本会话暂无托管附件。</div>
            ) : (
              <div className="msg-attach-row" style={{ marginTop: 6 }}>
                {artifacts.attachments.map((a) => (
                  <button
                    key={a.attachmentId}
                    className="msg-attach"
                    title={`预览 ${a.filename}——${ATTACHMENT_KIND_LABEL[a.kind] ?? a.kind} v${a.revision} · sha256=${a.hash.slice(0, 12)}… · 上传于 ${new Date(a.createdAt).toLocaleString()}`}
                    onClick={() => openPreview({ attachmentId: a.attachmentId, filename: a.filename, kind: a.kind, conversationId, origin: '成果与附件', hashHint: a.hash, revisionHint: a.revision })}
                  >
                    <Icon name="file-text" size={12} />
                    <span className="truncate">{a.filename}</span>
                    <span className="msg-attach-kind">{ATTACHMENT_KIND_LABEL[a.kind] ?? a.kind}</span>
                    <span className="msg-attach-kind mono-sm" data-zs-artifact-rev={`v${a.revision}`}>v{a.revision}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="panel info">
            <div className="row tight">
              <strong>任务成果</strong>
              <span className="faint small">当前任务生成的文件与报告。</span>
            </div>
            {artifacts == null ? <div className="faint small" style={{ marginTop: 6 }}>正在装载…</div> : isRecordThread ? (
              <div className="faint small" style={{ marginTop: 6 }}>历史记录串没有任务与交付；继续回复会创建新的 AI 请求。</div>
            ) : artifacts.delErr != null ? (
              <div className="panel warning" style={{ marginTop: 6 }}>交付列表读取失败：{artifacts.delErr}</div>
            ) : artifacts.deliveries.length === 0 ? (
              <div className="faint small" style={{ marginTop: 6 }}>本任务暂无交付记录（交付产生后在此列出各版本）。</div>
            ) : (
              <div style={{ marginTop: 6 }}>
                {artifacts.deliveries.map((d) => (
                  <div key={d.deliveryId} className="row tight" style={{ padding: '6px 8px', border: '1px solid var(--border,#dbe2ea)', borderRadius: 6, marginBottom: 6 }} data-zs-delivery-row={d.deliveryId}>
                    <Icon name="package" size={13} />
                    <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                    <Tag tone="info">v{d.revision}</Tag>
                    <span className="faint small">{d.reviewedAt != null ? `已确认 ${new Date(d.reviewedAt).toLocaleString()}` : '等你确认'}{d.audience === 'dm' ? ' · 私信' : ''}</span>
                    <button
                      className="btn ghost sm"
                      title="打开交付文档，可切换阅读或源码视图、另存和引用"
                      onClick={() => openDeliveryDoc(d)}
                    >打开/保存文件</button>
                    {d.deliveryId === detail?.pendingDelivery?.id ? <>
                      <button className="btn ghost sm" onClick={() => { setTab('task'); openReview('accept'); }}>确认完成</button>
                      <button className="btn ghost sm" onClick={() => { setTab('task'); openReview('rework'); }}>按意见修改</button>
                    </> : <button className="btn ghost sm" onClick={() => setTab('task')}>查看版本</button>}
                    <details className="faint small" style={{ width: '100%' }}><summary>版本身份</summary>{d.deliveryId} · {d.manifestHash}</details>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="faint small">“保存文件”保存当前成果原件；“导出聊天”只导出对话记录，两者分开。</div>
        </div>
      )}
    </div>
  );
}
