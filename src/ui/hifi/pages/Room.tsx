/**
 * 房间页（§17.1 主窗口布局 / §17.2 房间 / §17.6 多任务不变量）
 *
 * 三栏：左侧全局侧栏（App 渲染）+ 中间对话池与任务看板与 Files + 右侧任务回复串。
 * 关键不变量：
 *  - 主池只保留原消息与聚合，完整回复全在串内，界面不复制两份消息
 *  - 打开 A 时只订阅 A 的回复正文；B 的进度只更新自己的卡片和未读
 *  - 关闭右侧面板不停止任务
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Composer } from '../components/Composer';
import type { FormalSendOutcome } from '../components/Composer';
import { Icon } from '../components/Icon';
import { MessageView } from '../components/MessageView';
import { ATTACHMENT_KIND_LABEL } from '../components/MessageView';
import { PreviewPane, PreviewReopenButton } from '../preview/PreviewPane';
import { MarkdownView } from '../preview/MarkdownView';
import { Avatar, EmptyState, ErrorState, Menu, MenuItem, Modal, PanelNavButton, RunStatusTag, Segmented, Tag, TaskStatusTag, anchorFromElement, memberColor } from '../components/ui';
import { taskRunHint } from '../lib/taskRunHint';
import { requestRecoveryOpen } from '../lib/recovery';
import { useStore, toast, setState, getState, recordLocalOnly, recordWrite } from '../shell';
import { loadRoomPool, loadThread, refreshThreadTask, retryUnknownSend, setThreadReadGate } from '../shell';
import {
  buildRoomRootEnvelope, buildThreadEnvelope, sendEnvelope, stopThreadTask, submitTaskReview,
  executeTaskRework, attachmentRefsFromDraft, attachmentRangesFromDraft, markThreadReadIfAllowed,
  toggleSavedMessage, type ReviewSnapshot,
} from '../loader';
import { stageOutbound, settleOutbound, dropOutbound, confirmOutboundUnknown, queueDraftInsert } from '../data/store';
import { command, openExportDir } from '../bridge';
import {
  anchorOf, byId, childTasksOf, coordinatorOfRoom,
  firstUnreadSeq, lockOfProject, memberLabel, processNotesOfThread, replyCount,
  replyPreview, replyThreadMessages, roomOf, rootMessages, roomUnread,
  taskOfThread, threadOf, unreadCount,
} from '../data/selectors';
import {
  toggleThreadSubscription, markThreadReadReal, reactMessageReal, createRoomReal, exportThreadReal,
} from '../data/actions-room';
import { updateRoomReal, roomArchiveReal, roomMembersSetReal } from '../loader';
import { formatBytes, formatDuration, fullTime, relTime, routeModeCopy, runtimeModelDisplayName, stageLabel } from '../lib/format';
import { chatAnswer } from '../../../contracts/chatAnswer';
import { LiveProgressCard } from '../components/LiveProgress';
import { navigate } from '../lib/router';
import { type ThreadTabKey } from '../lib/threadNav';
import {
  type DetailsSection, type ThreadView,
  detailsSectionOfTab, tabFor, viewOfTab,
} from '../lib/threadNav';
import type { AppState, ContextLocation, Message, Task, WorkflowRun, FormalAttachmentSummary,ProjectMember } from '../data/types';
/* ---------- UX-PREVIEW-01：共享预览（§17.9） ---------- */
import { audienceAllows, resourceOf } from '../lib/resource';
import { contextTargetOf, hidePreview, noteContextChanged, registerAttachmentResource, registerDeliveryResource, openPreview, openPreviewTab, setNavAutoHidden, setPreviewContextSide, autoHidePreviewForConversation, shouldAutoHidePreviewFor } from '../data/actions-preview';
import {
  PREVIEW_PANE_POLICY, SIDEBAR_WIDTH, THREAD_PANE_POLICY, displayedSplitPaneWidth,
  maxSplitPanePrimaryWidth, resolveLayout, resolveSplitPaneWidths, type SplitPanePolicy,
} from '../lib/layout';
import {useChatReading} from '../lib/useChatReading';
import { useElementWidth } from '../lib/useElementWidth';
import { ActualMembers, ChildTaskDetails,DeliveryHistoryFacts, DetailReadState, RunExtraFacts, TaskEventFacts, TaskExtraFacts, taskRunGuidance, useTaskDetails } from '../components/TaskDetailsFacts';
import type { TaskDetailsResult } from '../../../contracts/taskDetails.ts';

/** 正式侧能力锁定（未接通能力点击前禁用并说明——不在原型位置伪造可用）。 */
const FORMAL_LIMITS = {
  method: '执行方式开关（计划/跳过初稿/分工）尚未接入本包执行链——当前按项目默认方式派发',
  access: '实际执行权限由明确项目授权与成员配置共同决定；发送前显示回读事实，派发前服务端复查',
} as const;

/** 打开会话附件：登记资源（真实 attachmentId/audience）→ 共享预览标签。 */
function openAttachment(att: FormalAttachmentSummary, openedFrom: ContextLocation, conversationId: string): void {
  registerAttachmentResource({
    attachmentId: att.artifactId, filename: att.filename, kind: att.kind,
    revision: att.revision, hash: att.hash, sizeBytes: att.sizeBytes,
    audience: openedFrom.target, origin: conversationId,
  });
  openPreview(att.artifactId, att.revision, openedFrom);
}

const THREAD_NARROW_NEED = THREAD_PANE_POLICY.primaryMin + THREAD_PANE_POLICY.secondaryMin + THREAD_PANE_POLICY.splitter;

/**
 * 双区宽度的“响应式默认 + 本会话手调意图”。
 *
 * - 没有手调值时，宽度始终由当前真实可用宽度和布局策略算出；
 * - 手调后仅保存用户意图，窗口缩窄只钳制显示，不把手调值写成小值；
 * - 双击分隔条清空手调值，回到当前宽度下的响应式默认；
 * - 不写 localStorage，因此不会跨会话记忆。
 */
function useResponsivePaneWidth(availableWidth: number, policy: SplitPanePolicy) {
  const [manualWidth, setManualWidth] = useState<number | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const width = displayedSplitPaneWidth(availableWidth, policy, manualWidth);
  const maxWidth = maxSplitPanePrimaryWidth(availableWidth, policy);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: width };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const requested = drag.startWidth - (e.clientX - drag.startX);
    setManualWidth(Math.min(maxWidth, Math.max(policy.primaryMin, requested)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
  };
  const reset = () => setManualWidth(null);

  return { width, maxWidth, manualWidth, onPointerDown, onPointerMove, onPointerUp, reset };
}

export function RoomPage({
  roomId,
  threadId,
  focusedTaskId,focusedDeliveryId,
  highlightMessageId,
  tab,
  artifactId,
}: {
  roomId: string;
  threadId?: string;
  focusedTaskId?:string;focusedDeliveryId?:string;
  /** 来自 #/thread/:id?message=:mid 的直达链接：定位到并高亮该消息（§15.5） */
  highlightMessageId?: string;
  /** 初始 tab（来自 ?tab=）：让"打开任务详情"这类动作落在对应 tab 上 */
  tab?: ThreadTabKey;
  /** 成果 tab 内要就地打开的成果 */
  artifactId?: string;
}) {
  const s = useStore((x) => x);
  const room = roomOf(s, roomId);
  /** 项目归档/移除 ⇒ 房间头部要标明整体只读（第十七批 §十；写入守卫另有 submitMessage 一层） */
  const ownerProject = room ? s.projects.find((p) => p.id === room.projectId) : undefined;
  const ownerReadOnly = ownerProject?.archivedAt
    ? `项目已归档 · 只读`
    : ownerProject?.removedAt
      ? '项目已移除 · 只读'
      : undefined;
  const [roomTab, setRoomTab] = useState<'chat' | 'tasks' | 'files'>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection,setSettingsSection]=useState<'general'|'members'|'archive'>('general');
  /** 房间「⋯」菜单锚点（房间设置/成员/归档统一入口） */
  const [roomMenuAnchor, setRoomMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  // 所有 Hook 必须在任何 early return 之前调用（rules-of-hooks）。
  // 宽度 Hook 必须始终早于 if (!room) 的提前返回调用；否则房间删除时
  // Hook 数量变化会直接触发 React 的 Rendered fewer hooks 错误。
  /* ---------- UX-PREVIEW-01：共享预览（§17.9） ----------
     用**容器宽度**而不是 window.innerWidth 决定布局（§5.2 第 4 条）。
     测量对象选 `.app-body`：它的宽度由视口决定，**不随"导航是否收起"变化**，
     因此不会与"要不要收起导航"这个布局决定形成反馈环。 */
  const shell = useElementWidth<HTMLDivElement>('.app-body');
  const workspace = useElementWidth<HTMLDivElement>();
  const previewTabs = useStore((x) => x.preview.tabs);
  const previewHidden = useStore((x) => x.preview.hidden);

  const context = useMemo(
    () => contextTargetOf(s.activeProjectId, { roomId, threadId, roomView: roomTab }),
    [s.activeProjectId, roomId, threadId, roomTab],
  );

  /**
   * R73-A：文件页来源的预览**不占房间**。进入对话上下文（房间/线程）时自动收起：只改可见性，
   * 标签/阅读位置/各草稿全保留，房间头部「文件预览」重开按钮可恢复（恢复即显式，本会话不再
   * 自动收起）。房间内正常打开的文件（openedFrom=room/thread，explicitShow=true）不触发；
   * DM 资源在房间上下文本就不可见（audience 过滤），无需处理。
   * R74-P2（review-r73 §P2）：判据改为**当前活动预览的来源**（shouldAutoHidePreviewFor）——
   * 房间里保留的历史标签（room-file.md）不再让「全部标签都来自文件页」条件失效；只有本次
   * 文件页活动（activeKey 指向 files 来源标签且未显式恢复）才收起。
   */
  const autoHideCtxKey = `${s.activeProjectId}:${roomId}:${threadId ?? ''}:${roomTab}`;
  useEffect(() => {
    if (shouldAutoHidePreviewFor(context)) {
      autoHidePreviewForConversation(autoHideCtxKey);
    }
    // s.resources 必须在依赖里：在途工作区读取（大文件 readFull）的资源登记晚于进房，
    // 资源到达后本效应须重估——否则文件页来源的预览会因「当时还看不见」而漏收起（回弹）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoHideCtxKey, s.preview.hidden, s.preview.tabs, s.resources]);

  // 当前上下文下可见的预览标签（DM 隔离：不可见的既不显示也不计数标题）
  const visiblePreviewTabs = useMemo(
    () =>
      previewTabs.filter((t) => {
        const res = s.resources.find((r) => r.id === t.resourceId);
        return res ? audienceAllows(res.audience, context) : false;
      }),
    [previewTabs, s.resources, context],
  );

  const hasPreview = !previewHidden && visiblePreviewTabs.length > 0;

  /**
   * 解析器的输入宽度。
   *
   * `.app-body` 的宽度**总是**包含导航占位（导航是它的子元素），
   * 所以"导航可见时的内容区宽度" = app-body 宽度 − 导航宽度。
   * 这是一个**不依赖当前隐藏状态**的纯计算，因此布局决定不会自激
   * （早先用 workspace 实测宽度反推 navAutoHidden，触发了
   *  "Maximum update depth exceeded"：隐藏→变宽→判定不必隐藏→显示→…）。
   */
  const navVisibleWidth = useMemo(() => {
    const body = Math.max(320, shell.width);
    return Math.max(320, body - SIDEBAR_WIDTH);
  }, [shell.width]);

  const decision = useMemo(
    () =>
      resolveLayout({
        navVisibleWidth,
        hasThread: Boolean(threadId),
        hasPreview,
        navPinned: s.layout.navPinned,
      }),
    [navVisibleWidth, threadId, hasPreview, s.layout.navPinned],
  );

  /**
   * 实际被两个内容区消费的宽度。自动隐藏导航后，.app-body 不变而 .workspace
   * 会扩大到整个 app-body；这里读取后者的 ResizeObserver 结果。布局解析要求
   * 隐藏导航时，用“隐藏后的目标宽度”兜住观察器回报前的首帧，避免线程先闪成窄屏。
   */
  const contentAvailableWidth = useMemo(() => {
    const measured = Math.max(320, workspace.width);
    const visible = Math.max(320, navVisibleWidth);
    if (decision.hideNav) return Math.max(measured, visible + SIDEBAR_WIDTH);
    return s.layout.navAutoHidden
      ? Math.max(measured, visible)
      : Math.min(measured, visible);
  }, [workspace.width, navVisibleWidth, s.layout.navAutoHidden, decision.hideNav]);

  const threadWidth = useResponsivePaneWidth(contentAvailableWidth, THREAD_PANE_POLICY);
  const previewWidth = useResponsivePaneWidth(contentAvailableWidth, PREVIEW_PANE_POLICY);
  const narrow = contentAvailableWidth < THREAD_NARROW_NEED;

  // 单区域模式下的"对话 / 文件"二选一（§5.3 第 4 条）
  const [singleRegion, setSingleRegion] = useState<'context' | 'preview'>('context');
  useEffect(() => {
    // 打开文件默认展示文件；返回对话保留阅读位置
    if (hasPreview) setSingleRegion('preview');
    else setSingleRegion('context');
  }, [hasPreview]);

  /**
   * 落地解析器的"临时隐藏导航"建议（§5.3 第 3 条）。
   *
   * 判定输入固定为 `navVisibleWidth`（与当前隐藏状态无关），所以这个 effect
   * 是**收敛**的：宽度不变时 `decision.hideNav` 不变，setter 幂等，不会自激。
   *
   * **不要再加"卸载时 setNavAutoHidden(false)"的清理**：那会与这个 effect 直接对打
   * —— StrictMode 下 React 会 mount → unmount → remount，清理把它置 false、
   * 本 effect 又置回 true，实测触发 "Maximum update depth exceeded"
   * （调用栈落在 store.setState → emit → handleStoreChange）。
   * 离开房间后的复位改在 App 按路由处理（见 App.tsx），职责也更正确：
   * "导航是否该隐藏"本来就是工作区级状态，不该由页面的生命周期决定。
   */
  useEffect(() => {
    setNavAutoHidden(decision.hideNav);
  }, [decision.hideNav]);

  /** 打开资源：openedFrom 由调用处给定（主池消息 vs 线程消息） */
  /**
   * 主动切换上下文 → 预览并排的那一侧跟着走（§3.3），并置位"期间切过上下文"（§3.4 第 2 条）。
   *
   * 只在**已经打开预览**且 `threadId` 真的发生变化时改写：
   *  · 打开文件那一刻不改（否则会覆盖 §3.2"从主池打开就留在主池"的规则）；
   *  · 从主池点开一条回复串时，卡片 `open()` 会主动改成 thread 侧并收起附件（L2）；
   *  · L4 点「主池」→ 改成 pool 侧 → L3（主池＋文件）✓
   */
  const prevThreadIdRef = useRef<string | undefined>(threadId);
  useEffect(() => {
    const prev = prevThreadIdRef.current;
    prevThreadIdRef.current = threadId;
    if (prev === threadId) return;
    if (!hasPreview) return;
    setPreviewContextSide(threadId ? 'thread' : 'pool');
    // §3.4 第 2 条：期间主动切过上下文 → 关闭预览时保留最新选择，不跳回旧任务
    noteContextChanged();
  }, [threadId, hasPreview]);

  /**
   * R72：路由直达线程（/project/:pid/room/:rid?thread=…）时上下文侧必须显示线程。
   * 上面那只 effect 只看**变化**——组件因路由重挂载时 prevThreadIdRef 初值即当前
   * threadId（比较相等、不动作），而上传芯片在主池侧打开的预览把 previewSide 留在
   * 'pool'，线程面板会被 `previewSide !== 'pool'` 判断整个隐藏（深链进来只见主池）。
   */
  useEffect(() => {
    if (threadId != null) setPreviewContextSide('thread');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  const openResource = useCallback(
    (resourceId: string, revision: number | undefined, from?: ContextLocation) => {
      const target: ContextLocation = from ?? { target: context };
      openPreview(resourceId, revision, target);
    },
    [context],
  );

  /**
   * 房间不存在（旧链接、归档后被删、刷新后内存态回种子）→ 明确的错误态。
   *
   * 位置很关键：必须在**所有 Hook 之后**。此前这个 early return 排在
   * "跟踪 threadId 改预览侧"那对 useRef/useEffect 之前，于是"房间从有到无"时
   * RoomPage 渲染的 Hook 变少 —— React 抛 "Rendered fewer hooks than expected"，
   * 整棵树白屏（实测：打开一个不存在的房间链接后，侧栏与顶栏一起消失）。
   * 第十七批顺手修掉：把它挪到 Hook 之后。
   */
  /* ---------- 正式装载链（R64）：主池快照 + 活动目标 + 可见时轻量刷新 ----------
   * room.pool 拉取后经水合层供本页 selectors；线程装载在 ThreadPanel 挂载时触发。 */
  useEffect(() => { void loadRoomPool(roomId); }, [roomId]);
  useEffect(() => { setState((st) => ({ ...st, ui: { ...st.ui, activeRoomId: roomId } })); }, [roomId]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('legacy-on')) void loadRoomPool(roomId);
    }, 5000);
    return () => { window.clearInterval(t); };
  }, [roomId]);

  if (!room) {
    return (
      <div className="main">
        <div className="page">
          <ErrorState code="PROJECT_MISSING" detail="找不到该房间，可能已被删除或项目被移动。" />
        </div>
      </div>
    );
  }

  const coord = coordinatorOfRoom(s, room);
  const unread = roomUnread(s, room.id);

  /**
   * 预览的**来源侧**决定 L3 还是 L4（§3.2 来源规则）：
   *  - 从主池消息打开 → 「主池 + 文件」，线程暂时收起；
   *  - 从线程消息/成果打开 → 「线程 + 文件」，主池暂时收起。
   * 收起只是**隐藏**，草稿与阅读位置都保留（§17.9 第 3 条）。
   */
  const activePreviewTab =
    visiblePreviewTabs.find((t) => t.key === s.preview.activeKey) ?? visiblePreviewTabs[0];
  const previewFromThread = activePreviewTab?.openedFrom.target.kind === 'thread';
  /* 注：原先还有 `previewFromDm`。它在房间页其实**不可能为真**
     —— DM 资源的 audience 过不了 `audienceAllows(room 上下文)`，
     早就被 `visiblePreviewTabs` 过滤掉了；保留它只会让"显示哪一侧上下文"
     出现第三个分支（那次同时渲染主池+回复串+预览三个区）。
     现在统一用 `previewSide` 一个来源，见下方。 */

  const single = decision.layout === 'single' && hasPreview;
  const showContextRegion = !single || singleRegion === 'context';
  const showPreviewRegion = hasPreview && (!single || singleRegion === 'preview');
  /** 引用目标（§7.2）：按当前上下文推导，不猜"最后聚焦过哪个输入框" */
  const quoteTarget = threadId
    ? (() => {
        const t = s.tasks.find((x) => x.conversationThreadId === threadId);
        return { draftKey: `thread:${threadId}`, label: t ? `任务 #${t.roomTaskNumber}` : '此记录' };
      })()
    : { draftKey: `room:${room.id}`, label: room.name };

  /**
   * 双区并排时的宽度分配（用户要求："不用记忆，用当前的左右宽度"）。
   *
   * 历史缺陷：`resolveLayout` 算出 contextWidth / previewWidth，但 JSX 只用 data-layout，
   * 宽度全交给 flex 自由分配 → 预览把内容区挤到 0 宽。后来改成两侧都写死
   * `flex: 0 0 <解析值>`，又带来两个新问题：
   *  - **打开附件时回复串从手调宽度跳到一个无关的解析候选值**，关闭再跳回来，很突兀；
   *  - 两侧都不可收缩，解析值之和一旦超过容器就溢出被裁 →「附件页只显示半个」。
   *
   * 现在：
   *  - 对话侧（回复串）**保持它此刻的宽度**，`flex: 0 1` 允许空间不足时收缩；
   *  - 预览侧 `flex: 1 1 auto` 吃掉剩余宽度，并保底 `--preview` 下限。
   * 开关附件时对话侧纹丝不动；窗口变窄时先挤预览侧，不会溢出。
   */
  const twoRegion = decision.layout === 'context-preview' && !single;
  /**
   * 双区并排时的宽度 —— **两侧宽度对调**（用户明确要求）。
   *
   * 用户的原话："打开附件后，回复串变到左边，用的原来左边对话池的宽度；
   * 右边变成附件后，附件使用的是原来回复串的宽度。"
   *
   * 也就是：打开附件时不要"重新分配"，而是把**左右两列的宽度原样换位**：
   *   左列（回复串） ← 原来左列（对话池）的宽度
   *   右列（附件）   ← 原来右列（回复串）的宽度
   * 这样两侧都不会"变宽变窄"，只是换了内容，观感连续。
   *
   * 两个宽度都来自真实 .workspace 容器：
   *   右列宽 = 预览响应式默认或本会话手调值
   *   左列宽 = 实际可用宽度 − 右列宽 − 分隔条
   * 两侧都用 `flex: 0 1 <w>px`：空间足够时严格保持各自宽度；
   * 空间不足时允许收缩，不会溢出被裁（修掉"只显示半个"的另一半）。
   */
  /**
   * R73-B：L3/L4 的预览列宽度改由**专用分隔条**驱动（`usePreviewWidth`——真实两区
   * 边界「上下文列 | 预览列」；此前 L3 无分隔条、L4 的分隔条在回复串左缘都不在边界上，
   * 用户无法拖动）。显示侧动态 clamp（R71 纪律：窗口缩窄不写回用户宽度，拉宽即回弹）：
   * 预览 ∈ [480, 可用宽度−440−split]，上下文列保底 440。
   */
  const previewWidths = resolveSplitPaneWidths(contentAvailableWidth, PREVIEW_PANE_POLICY, previewWidth.manualWidth);
  const rightColW = previewWidth.width;
  const leftColW = previewWidths.secondary;
  const contextFlex = twoRegion
    ? { flex: `0 1 ${leftColW}px`, minWidth: 0 } as React.CSSProperties
    : undefined;
  const previewFlex = undefined; // 预览列宽度改由 CSS 的 --preview-w 表达（见 preview.css，便于做入场动画）

  // L2（主池 + 线程）也把线程宽度交给既有 threadWidth 逻辑，不改动它的既有行为
  const layoutStyle = twoRegion
    ? ({
        // 两列宽度由 JS 算好、以自定义属性下发：
        // CSS 的 `--preview-w` 同时被 `flex` 与入场 keyframes 使用（见 preview.css）
        '--context-w': `${leftColW}px`,
        '--preview-w': `${rightColW}px`,
      } as React.CSSProperties)
    : undefined;

  /**
   * 有预览时，上下文侧**二选一**，且必须与预览并排 —— 绝不允许"只剩附件"。
   *
   * 原写法用两个独立条件：
   *   showMainPool   = showContextRegion && !(hasPreview && previewFromThread)
   *   showThreadRegion = threadId && showContextRegion && !(hasPreview && !previewFromThread && !previewFromDm)
   * 它们在 `previewFromDm` 为真时会**同时成立**（主池 + 回复串 + 预览 = 三个区），
   * 在别的组合下又可能**同时为假** —— 实测到过"切回房间后只剩附件占满整页"。
   *
   * 现在改成单一来源 `previewSide`：预览从哪儿打开，就只留哪一侧的上下文。
   *  · 从回复串打开 → 只留回复串（L4）
   *  · 从主池/私信打开 → 只留主池（L3）
   * 两个布尔值由同一个变量派生，天然互斥、且至少有一个为真。
   *
   * ⚠ 实测缺陷（2026-09-24 截图取证时抓到，已修）：上面的"互斥"有一个例外 ——
   * **预览来自回复串、但当前没有打开任何回复串**（典型路径：L4 打开文件后点
   * 「收起/返回主池」，URL 变成不带 `?thread=`）。此时 `previewSide === 'thread'`
   * 会把主池也藏起来，而回复串又因为 `threadId` 为空渲染不出来 →
   * **上下文区整块空白，只剩文件**，"返回主池"实际没回到主池。
   * 修正：预览来源只决定"和谁并排"，**不能把两侧都藏掉**。
   * 没有回复串可显示时，主池照常渲染，文件按共享预览既有规则保留
   * （这不是关闭文件，标签与阅读位置都在）。
   */
  /**
   * 预览并排的那一侧（§3.2 + §3.3）。
   *
   * 打开文件时由 `openPreview` 按来源写入 `preview.side`（从主池打开 → 主池侧）；
   * 之后用户**主动切换上下文**时由下面的 effect 改写成新上下文所在侧 ——
   * 于是"从主池打开文件后点开回复串"会变成 L4（回复串＋文件），
   * 不必先关掉文件（用户实测反馈）。老会话没有 side 字段时按来源兜底。
   *
   * ⚠ 必须保留 `hasPreview` 前置：**没有打开任何预览时既不是 thread 侧也不是 pool 侧**
   * （null）。漏掉它会让"没有预览"被当成 pool 侧，于是打开回复串时线程面板直接不渲染
   * （实测回归：1680px L2 下 `.col-thread` 整个消失）。
   */
  const previewSide: 'thread' | 'pool' | null =
    hasPreview ? (s.preview.side ?? (previewFromThread ? 'thread' : 'pool')) : null;

  const showMainPool = showContextRegion && !(previewSide === 'thread' && Boolean(threadId));
  const showThreadRegion = Boolean(threadId) && showContextRegion && previewSide !== 'pool';

  /**
   * 主池是否**被文件挤掉**（L4：左侧是回复串、右侧是文件）—— 用户实测反馈：
   * 在对话池打开附件后点开一条串，主池就看不见了，于是"打不开其他回复串"。
   * 这个布尔值交给回复串导航行：把左端按钮的文案从「收起」改成「主池」，
   * 并在「⋯」里给出"回主池 / 直接切到本房间其他回复串"的入口。
   */
  const poolCollapsedByFile = hasPreview && showContextRegion && !showMainPool && Boolean(threadId);


  /**
   * 回复串「收起/返回」在 RoomPage 层的动作。
   *
   * 除了回到主池 URL，单区域布局还要把可见区域切回上下文 ——
   * 否则按钮写着"返回主池"、画面仍是文件（实测错位）。
   */
  const collapseThread = () => {
    if (single) setSingleRegion('context');
    navigate(`/project/${s.activeProjectId}/room/${room.id}`);
  };

  return (
    <div className="workspace" ref={workspace.ref} data-layout={decision.layout} style={layoutStyle}>
      {/* 单区域模式的「对话 / 文件」切换器（§5.3 第 4 条） */}
      {single ? (        <div className="single-region-switch">
          <div className="seg" role="group" aria-label="显示区域">
            <button
              className={singleRegion === 'context' ? 'on' : ''}
              onClick={() => setSingleRegion('context')}
            >
              <Icon name="message-square" size={12} /> 对话
            </button>
            <button
              className={singleRegion === 'preview' ? 'on' : ''}
              onClick={() => setSingleRegion('preview')}
            >
              <Icon name="file-text" size={12} /> 文件
            </button>
          </div>
          <span className="small faint">
            空间不足，已切为单区域；隐藏区域仍保留阅读位置与草稿
          </span>
        </div>
      ) : null}

      {/*
        窄窗覆盖式线程面板：**只在"桌面双栏分支不会渲染线程"时才渲染**。
        判定必须与下面 `showThreadRegion` 严格互斥，否则 900px 下两处同时成立，
        同一个 threadId 被渲染成**两个并排的线程面板**（实测：`col-thread` × 2、
        输入条 × 3、页签组 × 3，用户看到的就是"回复串被复制了一份"）。
        这里用 `!showThreadRegion` 作为前置条件，把两者的关系写成显式互斥。
      */}
      {threadId && narrow && !hasPreview && !showThreadRegion ? (
        <ThreadPanel
          threadId={threadId}
          narrow
          highlightMessageId={highlightMessageId}
          initialTab={tab}
          focusedTaskId={focusedTaskId} focusedDeliveryId={focusedDeliveryId}
          initialArtifactId={artifactId}
          onBackToPool={collapseThread}
          poolCollapsedByFile={poolCollapsedByFile}
          onOpenResource={(id, rev) => openResource(id, rev, {
            target: {
              kind: 'thread', projectId: s.activeProjectId, roomId: room.id,
              threadId, tab: 'replies',
            },
          })}
        />
      ) : null}

      {showMainPool ? (
      <div
        className="col-main"
        style={{
          ...(threadId && narrow && !hasPreview ? { display: 'none' } : {}),
          ...(twoRegion ? contextFlex : {}),
        }}
      >
        <div className="pool-head" style={{ padding: '12px 18px 0' }}>
          <Icon name={room.archivedAt ? 'archive' : 'hash'} size={16} className="faint" />
          <span className="pool-title">{room.name}</span>
          {room.archivedAt || ownerReadOnly ? (
            <Tag tone="neutral" icon="archive">{room.archivedAt ? '已归档 · 只读' : ownerReadOnly}</Tag>
          ) : null}
          {/**
           * 人数入口直接定位成员与协调者；通用设置仍经右侧菜单进入。
           */}
          <button
            type="button"
            className="pool-info"
            title={`查看房间成员与协调者：${memberLabel(coord)}，${room.memberIds.length} 名成员`}
            aria-haspopup="dialog"
            onClick={() => {setRoomMenuAnchor(null);setSettingsSection('members');setSettingsOpen(true);}}
          >
            <Icon name="users" size={11} />
            {memberLabel(coord)} · {room.memberIds.length} 名成员
          </button>
          <div className="spacer" />
          {/**
           * 收起预览后的重开入口放在房间头部（原先浮在右下角，会压住输入区的
           * 发送按钮 —— 用户截图反馈）。它属于"这个房间当前收着一份文件"的状态，
           * 放头部与未读/房间 ⋯ 同排；窄窗只留图标 + 计数，避免挤掉右侧操作。
           */}
          <PreviewReopenButton compact={narrow} />
          {unread > 0 ? (
            <Tag tone="info" icon="message-square">{unread} 条未读</Tag>
          ) : null}
          {/**
           * 房间 ⋯：房间设置、成员、归档/取消归档都在这里，能力一个不少。
           * 归档房的「取消归档」是唯一出口（§25.6），必须在 ⋯ 里保留可见名称，
           * 不能只留一个"更多"图标把它埋掉。
           */}
          <button
            type="button"
            className="icon-btn sm"
            title="房间操作：房间信息、成员、归档"
            aria-label="房间操作"
            aria-haspopup="menu"
            onClick={(e) => setRoomMenuAnchor(anchorFromElement(e.currentTarget))}
          >
            <Icon name="more-horizontal" size={15} />
          </button>
        </div>

        {roomMenuAnchor ? (
          <Menu anchor={roomMenuAnchor} onClose={() => setRoomMenuAnchor(null)}>
            <div className="menu-label">房间「{room.name}」</div>
            <MenuItem
              icon="settings"
              title="改房间名称、成员与协调者"
              onClick={() => { setRoomMenuAnchor(null);setSettingsSection('general'); setSettingsOpen(true); }}
            >
              房间设置
            </MenuItem>
            {room.archivedAt ? (
              <MenuItem
                icon="refresh"
                title="取消归档后可继续发任务；旧的待派发任务不会自动重放（room.archive unarchive）"
                onClick={() => {
                  setRoomMenuAnchor(null);
                  void roomArchiveReal(room.id, room.revision, 'unarchive').then((r) => {
                    toast(r.ok ? '已取消归档' : `取消归档失败：${r.error}`, r.ok ? 'success' : 'error');
                  });
                }}
              >
                取消归档
              </MenuItem>
            ) : (
              <MenuItem
                icon="archive"
                title="进入房间设置里的归档区块；存在活跃任务时会被阻止"
                onClick={() => { setRoomMenuAnchor(null);setSettingsSection('archive'); setSettingsOpen(true); }}
              >
                归档房间
              </MenuItem>
            )}
          </Menu>
        ) : null}

        <div className="thread-tabs" style={{ marginTop: 8 }}>
          <button className={`thread-tab${roomTab === 'chat' ? ' on' : ''}`} onClick={() => setRoomTab('chat')}>
            <Icon name="message-square" size={13} /> 对话池
          </button>
          <button className={`thread-tab${roomTab === 'tasks' ? ' on' : ''}`} onClick={() => setRoomTab('tasks')} title="本房间任务看板；全部项目的任务看板在左侧栏">
            <Icon name="list" size={13} /> 任务看板
          </button>
          <button className={`thread-tab${roomTab === 'files' ? ' on' : ''}`} onClick={() => setRoomTab('files')}>
            <Icon name="file-text" size={13} /> 文件
          </button>
        </div>

        {roomTab === 'chat' ? <RoomPool roomId={room.id} threadId={threadId} onOpenSettings={() => {setSettingsSection('members');setSettingsOpen(true);}} onOpenResource={openResource} /> : null}
        {roomTab === 'tasks' ? <RoomTasks roomId={room.id} /> : null}
        {roomTab === 'files' ? <RoomFiles roomId={room.id} onOpenResource={openResource} /> : null}
      </div>
      ) : null}

      {showThreadRegion ? (
        <>
          {/**
           * 分隔条只在**两区并排**时出现。
           *
           * 之前的写法是 `showThreadRegion && !narrow`，于是"窄窗 + 有预览"
           * 时线程被排除在渲染之外：上面的窄窗分支要求 `!hasPreview`，
           * 这里又要求 `!narrow` —— 两侧都不成立，结果是**对话侧整块空白**
           * （实测：900px 单区域切回"对话"后 col-thread 不存在）。
           * 现在改为：线程按 showThreadRegion 渲染，用 narrow 决定**布局形态**，
           * 而不是决定**渲染与否**。
           */}
          {!single && !narrow && !twoRegion ? (
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整回复串宽度"
              title="拖动调整宽度 · 双击恢复响应式默认"
              onPointerDown={threadWidth.onPointerDown}
              onPointerMove={threadWidth.onPointerMove}
              onPointerUp={threadWidth.onPointerUp}
              onDoubleClick={threadWidth.reset}
            />
          ) : null}
          <ThreadPanel
            threadId={threadId!}
            narrow={narrow || single}
            /* 双区（L4）时**不要再传 width**：那时宽度由 `flexStyle` 的
               flex-basis（= 对调过来的左列宽）决定；同时传一个像素值
               inline width 会和 flex-basis 打架，实测渲染出来会偏离解析宽度
               而不是应有的 566px。 */
            width={single || narrow || twoRegion ? undefined : threadWidth.width}
            flexStyle={twoRegion ? contextFlex : undefined}
            highlightMessageId={highlightMessageId}
            initialTab={tab}
            focusedTaskId={focusedTaskId} focusedDeliveryId={focusedDeliveryId}
            initialArtifactId={artifactId}
            onBackToPool={collapseThread}
          poolCollapsedByFile={poolCollapsedByFile}
            onOpenResource={(id, rev) => openResource(id, rev, {
              target: {
                kind: 'thread', projectId: s.activeProjectId, roomId: room.id,
                threadId: threadId!, tab: 'replies',
              },
            })}
          />
        </>
      ) : null}

      {/* R73-B：L3/L4 的**真实两区边界**分隔条（上下文列 | 预览列）——位于 PreviewPane
          紧左侧；原生 pointer 拖动直接改 previewWidth（rect 实际变化），双击回到响应式默认。
          窄窗单区域（single）没有并排边界，不渲染。 */}
      {showPreviewRegion && twoRegion && !single ? (
        <div
          className="splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整文件预览宽度"
          title="拖动调整宽度 · 双击恢复响应式默认"
          onPointerDown={previewWidth.onPointerDown}
          onPointerMove={previewWidth.onPointerMove}
          onPointerUp={previewWidth.onPointerUp}
          onDoubleClick={previewWidth.reset}
        />
      ) : null}

      {/* ---------- 共享预览区（L3/L4，§17.9） ---------- */}
      {showPreviewRegion ? (
        <PreviewPane
          context={context}
          quoteTarget={quoteTarget}
          singleRegion={single}
          flexStyle={twoRegion ? previewFlex : undefined}
          onBackToContext={() => setSingleRegion('context')}
          className={decision.layout === 'context-preview' && !single ? '' : 'single'}
        />
      ) : null}

      {/* 收起后的重开入口现在放在房间头部里（见 .pool-head），不再浮在右下角：
          原先它压在输入区的发送按钮上（用户截图反馈）。这里不再单独渲染。 */}

      {settingsOpen ? <RoomSettings roomId={room.id} initialSection={settingsSection} onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}

/* ============================================================
   对话池
   ============================================================ */

function RoomPool({
  roomId, threadId, onOpenSettings, onOpenResource,
}: {
  roomId: string;
  threadId?: string;
  onOpenSettings: () => void;
  /** UX-PREVIEW-01：打开消息携带的资源（主池入口，§17.9） */
  onOpenResource?: (resourceId: string, revision?: number, from?: ContextLocation) => void;
}) {
  const s = useStore((x) => x);
  const roots = useMemo(
    () => rootMessages(s, roomId),
    [s, roomId],
  );
  const listRef=useChatReading(`room-pool:${s.activeProjectId}:${roomId}`,roots.map(m=>m.id).join('|'));
  const room = roomOf(s, roomId);
  const project = room ? s.projects.find((p) => p.id === room.projectId) : undefined;
  /**
   * 第十七批 §十：**项目归档后其下房间整体只读** —— 不能发消息、建任务、被唤醒。
   * 判定放在这里一次，供房间头部标签、输入区与只读说明共用；
   * 写入路径上还有一层守卫（`submitMessage`），界面禁用了也改不动状态。
   */
  const projectReadOnlyReason = project?.archivedAt
    ? `项目「${project.displayName}」已归档 · 只读`
    : project?.removedAt
      ? `项目「${project.displayName}」已从应用移除 · 仅可查看历史`
      : undefined;
  const roomReadOnlyReason = room?.archivedAt ? '已归档 · 只读' : projectReadOnlyReason;
  const enabledRoomAgentIds = room?.memberIds.filter((memberId) => {
    const member = s.members.find((candidate) => candidate.id === memberId);
    return member?.principalType === 'agent' && member.enabled;
  }) ?? [];
  const lease = project ? lockOfProject(s, project.id) : null;
  const parallel = project?.writeConcurrencyPolicy === 'parallel_writers';
  const holders = lease ? (lease.parallelHolders ?? [lease.ownerTaskId]) : [];
  const maxWriters = project?.maxParallelWriters;

  /* 只读场景也要保留"这是哪个目标"（减负 §2.1）：
     输入框被隐藏不等于身份消失，这里用同一套目标摘要元素（静态态）表达。 */
  return (
    <>
      <div className="pool" ref={listRef}>
        {/**
         * 写入占用：**一行**（减负 §3）。
         *
         * 历史：这里曾有一条常驻横幅，按用户要求整块删掉了（会被误读成
         * "整个项目出问题了"）。现在按"正常缩成一行、异常给出原因和动作"处理：
         *  · 无租约 → 不渲染（不需要占位说"没人写入"）；
         *  · 单写者持锁或并行未满 → 一行 muted 文字，说明谁在写；
         *  · 并发上限已满 → 警告行，写明策略、上限与动作。
         * 策略解释（"同一物理目录最多 1 个受管理写入者"）进 title，不占常驻文案。
         */}
        {lease ? (
          <div
            className={`write-line${parallel && maxWriters && holders.length >= maxWriters ? ' warn' : ''}`}
            title={parallel
              ? `并行写入策略：同物理目录最多 ${maxWriters ?? '—'} 个受管理写入者；达上限的任务排队`
              : '单写者策略：同一物理目录最多 1 个受管理写入者，其他任务排队'}
          >
            <Icon name={parallel && maxWriters && holders.length >= maxWriters ? 'alert-triangle' : 'lock'} size={11} />
            <span className="truncate">
              {parallel
                ? `写入占用：${holders.length}${maxWriters ? `/${maxWriters}` : ''} 个任务正在改文件`
                : `写入占用：${lease.ownerTaskLabel} 正在写入`}
            </span>
            {parallel && maxWriters && holders.length >= maxWriters ? (
              <span className="faint">已达上限，新任务会排队；可在项目设置调整上限</span>
            ) : null}
          </div>
        ) : null}

        {room && enabledRoomAgentIds.length === 0 ? (
          <div className="panel warning" style={{ marginBottom: 10 }}>
            <div className="panel-title"><Icon name="users" size={13} /> 这个房间还没有可用 AI</div>
            添加 AI 后即可发送；输入与草稿会保留。
            <div className="panel-actions">
              <button className="btn sm primary" onClick={onOpenSettings}>
                <Icon name="user-plus" size={12} /> 添加 AI
              </button>
            </div>
          </div>
        ) : roots.length === 0 ? (
          <EmptyState
            icon="message-square"
            title="这个房间还没有消息"
            detail="在下面发布第一个任务。可以 @ 指定成员，也可以不 @ 由协调者接单。"
          />
        ) : null}

        {roots.map((m) => (
          <RootCard
            key={m.id}
            message={m}
            onOpenResource={onOpenResource}
            /* 归属用「本卡对应的线程」判断，不能用 m.threadId：
               顶层 anchor 的 thread_id 本来就是 NULL（§3.4），
               与"当前没打开任何线程"（threadId === undefined）比较会全部相等，
               导致所有卡片都被标成选中（实测 5/5 全蓝）。 */
            selected={Boolean(threadId) && s.threads.find((t) => t.anchorMessageId === m.id)?.id === threadId}
          />
        ))}
      </div>

      {room && !roomReadOnlyReason ? (
        <Composer
          target={{ kind: 'room_root', roomId }}
          draftKey={`room:${roomId}`}
          formalLimits={FORMAL_LIMITS}
          attachmentUpload={room.conversationId != null && room.conversationId !== '' ? { conversationId: room.conversationId } : undefined}
          sendDisabledReason={enabledRoomAgentIds.length === 0 ? '添加 AI 后即可发送' : undefined}
          sendDisabledLabel={enabledRoomAgentIds.length === 0 ? '添加 AI 后即可发送' : undefined}
          onRetrySend={(env) => retryUnknownSend(env).then((r) => {
            if (r.status === 'ok') { void loadRoomPool(roomId); toast('重发成功（原信封）', 'success'); }
            return r.status === 'ok' ? { status: 'ok' } : r.status === 'failed' ? { status: 'failed', error: r.error } : { status: 'unknown', error: r.error };
          })}
          onSend={(p): Promise<FormalSendOutcome> => (async () => {
            const intent = 'default' as const;
            if (enabledRoomAgentIds.length === 0) {
              return { status: 'failed', error: '当前房间没有可用 AI——请先添加或启用 AI' };
            }
            const draftKey = `room:${roomId}`;
            const refs = attachmentRefsFromDraft(draftKey, intent);
            if (refs.blockError != null) return { status: 'failed', error: refs.blockError };
            const env = buildRoomRootEnvelope(p.commandId, roomId, p.body, intent, p.mentionIds, refs.refs, {
              collaboration: p.collaboration,
              ...(p.collaboration != null && p.budgetMaxTurns != null ? { deliberationBudget: { maxTurns: p.budgetMaxTurns } } : {}),
              imageAck: p.imageAck,
              attachmentRanges: attachmentRangesFromDraft(draftKey),
            });
            env.revAtSend = p.draftRev;
            const staged = stageOutbound(draftKey, env); // r62 P1：预 bridge 耐久落账
            if (staged.ok !== true) return { status: 'failed', error: staged.error ?? '原信封未能耐久保存' };
            const r = await sendEnvelope(env);
            if (r.status === 'ok') settleOutbound(draftKey, env);
            else if (r.status === 'failed') dropOutbound(draftKey, env);
            else confirmOutboundUnknown(draftKey, env);
            if (r.status === 'ok') {
              void loadRoomPool(roomId).catch(() => { /* 读取失败另有呈现 */ });
              toast('已发送', 'success');
              return { status: 'ok' };
            }
            return r.status === 'failed' ? { status: 'failed', error: r.error } : { status: 'unknown', error: r.error };
          })()}
        />
      ) : (
        <div className="composer">
          {/**
           * 只读场景也要保留"这是哪个目标"（减负 §2.1）：
           * 输入框被隐藏不等于身份消失，这里用同一套目标摘要元素（静态态）表达。
           */}
          <div className="composer-target-line">
            <span
              className="composer-target-summary static"
              title={roomReadOnlyReason ? `${projectReadOnlyReason ?? `「${room?.name ?? '此房间'}」已归档`}，只读` : '只读'}
            >
              <Icon name="archive" size={11} />
              <span className="composer-target-label">{room?.name ?? '此房间'}</span>
              <span className="faint">·</span>
              <span className="composer-target-title">{roomReadOnlyReason ?? '只读'}</span>
            </span>
          </div>
          <div className="panel" style={{ margin: 0 }}>
            <div className="panel-title"><Icon name="archive" size={13} /> 房间已归档</div>
            已归档房间为只读：不能新增任务、不被提醒唤醒；迟到的运行事件只进入审计与恢复记录。
            取消归档后可以继续，但不会把旧的待派发任务全部重放。
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- 主池原消息卡 ---------------- */

function RootCardActions({ message, saved }: { message: Message; saved: boolean }) {
  const [copyState,setCopyState]=useState<'idle'|'copied'|'failed'>('idle');
  const visibleBody=chatAnswer(message.body,message.authorType);
  const copy=async():Promise<void>=>{
    try{
      if(navigator.clipboard==null)throw Error('clipboard unavailable');
      await navigator.clipboard.writeText(visibleBody);
      setCopyState('copied');
      window.setTimeout(()=>setCopyState('idle'),1400);
    }catch{
      setCopyState('failed');
      window.setTimeout(()=>setCopyState('idle'),1800);
    }
  };
  return (
    <div className="root-card-actions" onClick={(event)=>event.stopPropagation()}>
      <button type="button" className="btn ghost sm" title="复制可读正文" onClick={()=>void copy()}><Icon name="copy" size={12}/> 复制</button>
      <button type="button" className="btn ghost sm" title="引用到输入区" onClick={()=>{
        const key=`room:${message.roomId}`;
        queueDraftInsert(key,`> ${visibleBody.replace(/\s+/g,' ').trim().slice(0,400)}`);
        window.dispatchEvent(new CustomEvent('zs:focus-composer',{detail:key}));
      }}><Icon name="corner-down-right" size={12}/> 引用</button>
      <button type="button" className="btn ghost sm" data-zs-saved={saved?'1':undefined} title={saved?'取消收藏':'收藏，不改动原消息'} onClick={()=>{
        void toggleSavedMessage(message,message.projectId).then(r=>{if(r.ok)toast(r.saved?'已收藏':'已取消收藏','success');else if(!r.busy)toast(r.error??'收藏失败','error');});
      }}><Icon name="bookmark" size={12}/> {saved?'已收藏':'收藏'}</button>
      <span className="small msg-action-feedback" aria-live="polite">{copyState==='copied'?'已复制':copyState==='failed'?'复制失败':''}</span>
    </div>
  );
}

function RootCard({
  message, selected, onOpenResource,
}: {
  message: Message;
  selected: boolean;
  onOpenResource?: (resourceId: string, revision?: number, from?: ContextLocation) => void;
}) {
  const s = useStore((x) => x);
  const thread = s.threads.find((t) => t.anchorMessageId === message.id);
  const task = thread ? taskOfThread(s, thread) : undefined;
  const run = task ? s.runs.find((r) => r.taskId === task.id) ?? task.latestRun ?? undefined : undefined;
  const executionBlocker = thread
    ? s.threadTasks[thread.id]?.executionBlocker
      ?? s.roomPool[message.roomId]?.find((card) => card.threadId === thread.id)?.executionBlocker
      ?? null
    : null;
  const unread = thread ? unreadCount(s, thread.id) : 0;
  const replies = thread ? replyCount(s, thread.id) : 0;
  const saved = s.savedMessageRefs[message.id] === true || message.saved === true;
  const delivery = task?.delivery;
  const deliveryFeedback = delivery?.feedback?.find((item) => item.status === 'needs_revision')
    ?? delivery?.feedback?.find((item) => item.status === 'needs_user')
    ?? delivery?.feedback?.[0];
  const deliveryIssue = delivery?.issueResolutions?.find((item) => item.status === 'needs_user')
    ?? delivery?.issueResolutions?.find((item) => item.status === 'insufficient_evidence');
  const deliveryDetail = (deliveryFeedback?.question ? `${deliveryFeedback.question}${deliveryFeedback.owner ? `（责任方：${deliveryFeedback.owner}）` : ''}` : '')
    || deliveryFeedback?.revisionRequest || deliveryFeedback?.reason
    || (deliveryIssue?.question ? `${deliveryIssue.question}${deliveryIssue.owner ? `（责任方：${deliveryIssue.owner}）` : ''}` : '')
    || deliveryIssue?.reason
    || (delivery?.unresolvedIssues?.length ? `${delivery.unresolvedIssues.length} 项未解决，打开详情查看` : '');
  const deliveryLabel = delivery == null ? null
    : delivery.status === 'delivered' ? '已交付'
      : delivery.status === 'delivered_with_questions' ? '已交付 · 有待确认'
        : delivery.status === 'needs_user' ? '等待你补充'
          : delivery.status === 'blocked' ? '交付未完成'
            : '本轮已结束 · 旧格式';
  const deliveryFactLine = deliveryLabel == null ? null
    : `程序交付：${deliveryLabel}${delivery?.overallConsensus === 'disputed' ? ' · 仍有分歧' : delivery?.overallConsensus === 'unconfirmed' ? ' · 仍有成员未确认' : delivery?.overallConsensus === 'qualified' ? ' · 附条件确认' : ''}`;
  // 主池只留 2 条预览：它是"要不要点进去"的判断依据，不是正文（§3.4 允许 2—3 条）
  const preview = thread ? replyPreview(s, thread.id, 2) : [];

  /**
   * 主状态：每张卡只突出一个，并给一句"下一步"。
   *
   * 评审指出「同一任务同时出现"执行中"和"运行中"，这两个标签对用户几乎没有区别」，
   * 且真正的判断依据（要不要我介入）看不出来。所以按"需要你做什么"排序，
   * 而不是按内部状态机的字段逐个展示。
   */
  const primary = useMemo(() => {
    if (!task) return null;
    // 1) 需要用户介入的最高优先
    if (task.status === 'REVIEW') {
      const cs = s.changeSets.find((c) => c.taskId === task.id);
      const n = cs?.files.filter((f) => !f.userPreExisting).length ?? 0;
      return {
        label: '待你审阅', icon: 'eye', tone: 'accent' as const,
        detail: n > 0 ? `${memberLabel(byId(s.members, task.ownerMemberId))} 已修改 ${n} 个文件` : '有成果等你确认',
      };
    }
    if (executionBlocker != null) return taskRunHint(run?.status, executionBlocker);
    const running = s.turns.filter((t) => t.threadId === thread?.id && t.status === 'RUNNING');
    if (task.status === 'ACTIVE' && (run?.status === 'RUNNING' || running.length > 0)) {
      const who = running.map((t) => memberLabel(byId(s.members, t.memberId))).filter(Boolean);
      const startedAt = running.map((t) => t.startedAt).filter((at) => Number.isFinite(at) && at > 0).sort((a, b) => a - b)[0];
      const waited = startedAt != null ? formatDuration(Math.max(0, Date.now() - startedAt)) : null;
      const stage = run != null && 'stage' in run && typeof run.stage === 'string' && run.stage.length > 0 ? stageLabel(run.stage) : null;
      return {
        label: '执行中', icon: 'play', tone: 'info' as const,
        detail: [
          who.length > 0 ? `${who.join('、')} 正在处理` : '成员正在处理',
          stage,
          waited != null ? `已运行 ${waited}` : null,
        ].filter(Boolean).join(' · '),
      };
    }
    if (delivery?.status === 'needs_user') {
      return { label: '等待你补充', icon: 'hand', tone: 'warning' as const, detail: deliveryDetail || '有具体问题等待你处理' };
    }
    if (delivery?.status === 'blocked') {
      return { label: '交付未完成', icon: 'octagon', tone: 'danger' as const, detail: deliveryDetail || '内部仍有未解决项，打开详情查看' };
    }
    if (delivery?.status === 'delivered_with_questions') {
      return { label: '已交付 · 有待确认', icon: 'alert-circle', tone: 'warning' as const, detail: deliveryDetail || '交付可用，但仍有未确认事项' };
    }
    if (delivery?.status === 'legacy') {
      const consensus = delivery.overallConsensus === 'disputed' ? '仍有分歧' : delivery.overallConsensus === 'unconfirmed' ? '仍有成员未确认' : '交付反馈未提供';
      return { label: '本轮已结束 · 旧格式', icon: 'history', tone: delivery.overallConsensus === 'disputed' || delivery.overallConsensus === 'unconfirmed' ? 'warning' as const : 'neutral' as const, detail: `${consensus}；打开详情核对实际记录` };
    }
    if (task.status === 'WAITING_USER') {
      const open = s.issues.filter((i) => i.runId === run?.id && i.status === 'needs_user').length;
      return {
        label: '需要你决定', icon: 'hand', tone: 'warning' as const,
        detail: deliveryDetail || (open > 0 ? `还有 ${open} 项分歧等你拍板` : '有事项等你处理'),
      };
    }
    if (task.status === 'BLOCKED') {
      return { label: '阻塞', icon: 'octagon', tone: 'danger' as const, detail: deliveryDetail || '缺少必要的前置成果，需要你处理' };
    }
    if (task.status === 'DONE') {
      return { label: task.responseKind==='conversation'?'已回复':'已完成', icon: 'check-circle', tone: 'success' as const, detail: task.responseKind==='conversation'?'这是对话回答，没有工作交付或验收待办':'已完成' };
    }
    if (task.status === 'CANCELLED') {
      return { label: '已取消', icon: 'slash', tone: 'neutral' as const, detail: '' };
    }
    // 2) 未结束任务与最近运行分列：FAILED run 下的 ACTIVE task 并非正在执行。
    if (executionBlocker != null) return taskRunHint(run?.status, executionBlocker);
    if (run != null && run.status !== 'RUNNING') return taskRunHint(run.status);
    if (run?.status === 'RUNNING') {
      const who = running.map((t) => memberLabel(byId(s.members, t.memberId))).filter(Boolean);
      const startedAt = running.map((turn) => turn.startedAt).filter((at) => Number.isFinite(at) && at > 0).sort((a, b) => a - b)[0];
      const waited = startedAt != null ? formatDuration(Math.max(0, Date.now() - startedAt)) : null;
      const stage = run != null && 'stage' in run && typeof run.stage === 'string' && run.stage.length > 0 ? stageLabel(run.stage) : null;
      return {
        label: '执行中', icon: 'play', tone: 'info' as const,
        detail: [
          who.length > 0 ? `${who.join('、')} 正在处理` : '成员正在处理',
          stage,
          waited != null ? `已运行 ${waited}` : null,
        ].filter(Boolean).join(' · '),
      };
    }
    return taskRunHint(run?.status, executionBlocker);
  }, [task, run, executionBlocker, s.changeSets, s.issues, s.turns, s.members, thread?.id, delivery, deliveryDetail]);
  const isDiscussion = Boolean(thread && !thread.rootTaskId);
  const absent = s.absence[thread?.id ?? ''];

  /**
   * **没有串的主池消息也必须渲染**（UX-PREVIEW-01 修复的实际缺陷）。
   *
   * 旧实现是 `if (!thread) return null` —— 于是"一条普通消息，没有派任务、
   * 没有回复串、只带了个附件"在界面上**完全消失**。这不只是"没有可点击的
   * 文件名"，而是消息本身不可见：用户在对话池里发了东西，界面当作没发生。
   *
   * §17.9 第 1 条要求"普通主池附件可无 taskId"，前提是这条消息得先能显示。
   * 所以这里为无串消息渲染一张**简化卡**：正文 + 附件 + 时间，
   * 不显示任务号、状态、回复数与"打开回复串"（那些它确实没有）。
   */
  if (!thread) {
    const atts = message.formalAttachments ?? [];
    const plainConv = roomOf(s, message.roomId)?.conversationId ?? '';
    return (
      <div className="root-card plain">
        <div className="root-card-head">
          <Tag tone="neutral" icon="message-square">普通消息 · 无任务</Tag>
          <div className="spacer" />
          <span className="small faint">{relTime(message.createdAt)}</span>
        </div>
        <div className="root-body"><MarkdownView text={chatAnswer(message.body,message.authorType)} /></div>

        {/* 附件：**无 taskId 也能打开只读预览**（PV-01 的核心证据；正式=真实 attachmentId） */}
        {atts.length > 0 ? (
          <div className="msg-attach-row">
            {atts.map((att) => (
              <button
                key={att.artifactId}
                data-zs-artifact-id={att.artifactId}
                className="msg-attach"
                title={`打开 ${att.filename}（${ATTACHMENT_KIND_LABEL[att.kind] ?? att.kind}）· 只读预览，不派任务、不发言`}
                onClick={(e) => {
                  e.stopPropagation();
                  openAttachment(att, {
                    target: { kind: 'room', projectId: message.projectId, roomId: message.roomId, view: 'chat' },
                    messageId: message.id,
                  }, plainConv);
                }}
              >
                <Icon name="paperclip" size={12} />
                <span className="truncate">{att.filename}</span>
                <span className="msg-attach-kind mono-sm">{ATTACHMENT_KIND_LABEL[att.kind] ?? att.kind}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="root-foot">
          <span className="small faint">这条消息没有派发任务，因此没有回复串</span>
          <div className="spacer" />
          <RootCardActions message={message} saved={saved}/>
        </div>
      </div>
    );
  }

  const open = () => {
    markThreadReadReal(thread.id);
    /**
     * 用户要的是"看这条回复串"，所以点卡片时：
     *  1. 先把预览的并排侧认到线程 —— 之后重开预览时会与回复串并排，
     *     而不是又把回复串挤掉；
     *  2. 再**收起当前打开的文件**（收起预览区：保留全部标签与阅读位置，可一键重开）。
     * 这样"打开附件 → 点回复串"看到的就是回复串本身，而不是被文件挤成两半。
     *
     * 只收起"从主池打开的文件"：从线程打开的文件（side 已是线程）说明用户正在
     * 那条串里对着文件看，此时不该把它收掉。
     */
    const activeTab = s.preview.tabs.find((t) => t.key === s.preview.activeKey) ?? s.preview.tabs[0];
    const fileFromThread = activeTab?.openedFrom.target.kind === 'thread';
    setPreviewContextSide('thread');
    if (!fileFromThread && !s.preview.hidden && s.preview.tabs.length > 0) hidePreview();
    navigate(`/project/${message.projectId}/room/${message.roomId}?thread=${thread.id}`);
  };

  /**
   * 整条卡片可点（用户反馈：只点「N 条回复」太难命中）。
   *
   * 两个必须保留的保护，避免"点哪儿都算打开线程"：
   *  1. **嵌套控件各自 stopPropagation**（附件、回复数、标题、⋯）：点它们只做自己的事；
   *  2. **文本选择不算点击**：在卡片里拖选文字（想复制）后松开鼠标会派发 click，
   *     这里检测到非折叠选区就忽略，不会跳进回复串。
   *
   * 键盘可达性不依赖整卡：标题、回复数、卡片 ⋯ 都是真实按钮，Tab 顺序完整
   * （因此卡片容器**不加** role="button"/tabIndex —— 否则就是"按钮里套按钮"的
   * 无效 ARIA 结构，反而让读屏软件念不准）。
   */
  const openFromPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      const node = sel.anchorNode;
      if (node && e.currentTarget.contains(node)) return;
    }
    open();
  };

  return (
    /**
     * 卡片恢复整块可点（用户明确要求）。`.root-card` / `.selected` 类名保持不变
     * （多处回归脚本按它们计数与断言）。
     */
    <div
      data-reading-message={message.id} className={`root-card${selected ? ' selected' : ''}`}
      onClick={openFromPointer}
    >
      <div className="root-card-head">
        {isDiscussion ? (
          <Tag tone="neutral" icon="message-square">记录 · 无任务号</Tag>
        ) : (
          <>
            {/* 任务号降为次级元信息，不与标题争空间（减负 §3） */}
            <span className="root-task-no">#{task?.roomTaskNumber}</span>
            {/* 只突出**一个主状态 + 一句下一步**：「执行中」和「运行中」同屏没有信息量 */}
            {primary ? <Tag tone={primary.tone} icon={primary.icon}>{primary.label}</Tag> : null}
          </>
        )}
        <div className="spacer" />
        <span className="small faint">{relTime(message.createdAt)}</span>
      </div>

      {!isDiscussion && task ? (
        <button
          type="button"
          className="root-title root-title-btn"
          title={`打开回复串：${task.title}`}
          onClick={(e) => { e.stopPropagation(); open(); }}
        >
          {task.title}
        </button>
      ) : null}
      {!isDiscussion && task?.currentRunBudget ? (
        <div className="faint small">
          {task.currentRunBudget.enforcement === 'disabled'
            ? `本轮调用次数限制已关闭（仅真实记账）：已记录 ${task.currentRunBudget.usedTurns} 次`
            : <>本轮冻结预算：已用 {task.currentRunBudget.usedTurns}/{task.currentRunBudget.runMaxTurns} 次调用
              {task.currentRunBudget.remainingTurns > 0 ? ` · 剩余 ${task.currentRunBudget.remainingTurns} 次` : ' · 已用尽'}</>}
        </div>
      ) : null}
      {/* 主状态之外，给一句"现在发生了什么、要不要你动手" */}
      {primary?.detail ? <div className="root-next">{primary.detail}</div> : null}
      {executionBlocker?.reason === 'unknown-turn' ? <div className="faint small">
        <button type="button" className="btn ghost sm" data-zs-open-recovery="1" onClick={(event) => {
          event.stopPropagation();
          requestRecoveryOpen();
        }}>打开恢复中心核对占用任务 #{executionBlocker.blockingRootTaskNumber ?? '?'} 的退出与保护状态</button>
      </div> : null}
      {deliveryFactLine ? <div className="faint small" data-zs-delivery-fact={delivery?.status}>{deliveryFactLine}</div> : null}
      <div className="root-body"><MarkdownView text={chatAnswer(message.body,message.authorType)} /></div>

      {/* 主池消息携带的附件（正式=真实 attachmentId 芯片——点击只读预览，不发送给 AI）。 */}
      {(message.formalAttachments ?? []).length > 0 ? (
        <div className="msg-inline-attachments" data-zs-inline-attachments="1">
          {(message.formalAttachments ?? []).map((att) => (
            <button
              key={att.artifactId}
              data-zs-artifact-id={att.artifactId}
              className={`inline-file-chip${att.kind === 'image_file' ? ' is-image' : ''}`}
              title={`打开 ${att.filename}（${ATTACHMENT_KIND_LABEL[att.kind] ?? att.kind}）· 只读预览，不发送给 AI`}
              onClick={(e) => {
                e.stopPropagation();
                openAttachment(att, {
                  target: { kind: 'room', projectId: message.projectId, roomId: message.roomId, view: 'chat' },
                  messageId: message.id,
                }, roomOf(s, message.roomId)?.conversationId ?? '');
              }}
            >
              <Icon name={att.kind === 'image_file' ? 'image' : 'file-text'} size={12} />
              <span className="truncate">{att.filename}</span>
              <span className="inline-file-kind">{ATTACHMENT_KIND_LABEL[att.kind] ?? att.kind}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* E4：有人一直不回时，线程里明确显示等待谁 */}
      {absent && !absent.continued ? (
        <div className="panel warning" style={{ marginTop: 8 }}>
          <div className="panel-title">
            <Icon name="clock" size={13} />
            等 {memberLabel(byId(s.members, absent.memberId))}（已 {Math.round((Date.now() - absent.since) / 60000)} 分钟）
          </div>
          超过缺席容忍后会按缺席继续，不会一直转圈。
        </div>
      ) : null}

      {/* 主池预览：线程消息的有限投影，不是副本（§17.6 第 5 条） */}
      {preview.length > 0 ? (
        <div className="root-preview">
          {preview.map((p) => (
            <div key={p.id} className="root-preview-row">
              <span className="root-preview-author">
                {p.authorType === 'human' ? '你' : memberLabel(byId(s.members, p.authorId))}
              </span>
              <span className="root-preview-text">{p.body}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="root-foot">
        {/**
         * 回复数就是**显式打开入口**（去掉重复的常驻「打开回复串」按钮，§3）。
         * 未读与回复数同处一行，但同一张卡只保留一种未读表达：
         * 保留可读的「N 条未读」文字，去掉卡片右上角的圆点
         * （`.root-card.unread::after`），两者说的是同一件事。
         * 房间级未读汇总在房间头部，仍然是另一层，不重复。
         */}
        <button
          type="button"
          className="root-replies-btn row tight"
          title={`打开回复串：${replies} 条回复${unread > 0 ? `，${unread} 条未读` : ''}`}
          onClick={open}
        >
          <Icon name="message-square" size={11} />
          {replies} 条回复
        </button>
        {unread > 0 ? <Tag tone="info" icon="message-square">{unread} 条未读</Tag> : null}
        <div className="spacer" />
        <RootCardActions message={message} saved={saved}/>
      </div>
    </div>
  );
}

/* ============================================================
   右侧：任务回复串
   ============================================================ */

/** 本地别名：回复串面板的 tab（取值定义见 lib/threadNav.ts，含新增的 run） */
type ThreadTabLocal = ThreadTabKey;

function ThreadPanel({
  threadId,
  focusedTaskId,focusedDeliveryId,
  narrow,
  width,
  highlightMessageId,
  initialTab,
  initialArtifactId,
  onOpenResource,
  onBackToPool,
  poolCollapsedByFile,
  flexStyle,
}: {
  threadId: string;
  focusedTaskId?:string;focusedDeliveryId?:string;
  narrow?: boolean;
  width?: number;
  /** 两区并排时由布局解析给出的宽度约束（§5.2） */
  flexStyle?: React.CSSProperties;
  /** 直达链接定位到的消息：滚到该处并短暂高亮（§15.5） */
  highlightMessageId?: string;
  /** 初始 tab（来自 ?tab=） */
  initialTab?: ThreadTabKey;
  initialArtifactId?: string;
  /** UX-PREVIEW-01：从线程打开资源（成果条目、消息附件） */
  onOpenResource?: (resourceId: string, revision?: number, from?: ContextLocation) => void;
  /**
   * 「收起/返回」的实际动作由 RoomPage 注入：单区域布局下除了改 URL，
   * 还要把可见区域切回上下文（那个状态在 RoomPage 里）。
   */
  onBackToPool?: () => void;
  /**
   * 主池被文件挤掉（L4：左串右文件）：
   * 左端按钮改文案为「主池」，并在 ⋯ 里给出切换其他回复串的入口。
   */
  poolCollapsedByFile?: boolean;
}) {
  const s = useStore((x) => x);
  const thread = threadOf(s, threadId);
  const [tab, setTab] = useState<ThreadTabLocal>(initialTab ?? 'replies');
  const [openArtifactId, setOpenArtifactId] = useState<string | undefined>(initialArtifactId);
  const [subtaskTarget, setSubtaskTarget] = useState<{ taskId: string; number: number; title: string } | undefined>();
  /** 原消息已移入「详情 → 任务概况」，不再有顶部摘要条的展开状态（减负 §2） */
  const listRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [pendingNew, setPendingNew] = useState(0);
  const [composerInsert, setComposerInsert] = useState<{ id: number; text: string }>();
  /** 线程「⋯」菜单锚点（由触发元素的矩形算出，键盘打开也落在同一处） */
  const [threadMenuAnchor, setThreadMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const lastCountRef = useRef(0);

  /* ---------- 正式装载链（R64）：thread.get/history/task.get + 独立标读门 + 轻量刷新 ----------
   * 打开即按门推进水位（前台+当前回复视图+贴底；门在发起此刻重查）；5s 刷新让 worker/
   * 其它端的新回复可见（隐藏/接管暂停——关闭面板不停止执行，只停轮询）。 */
  const repliesBoxRef = useRef<HTMLDivElement | null>(null);
  /** 当前 tab 的可变镜像（标读门闭包读取——replies 视图才允许推进水位）。 */
  const activeTabRef = useRef<{ v: ThreadTabLocal }>({ v: initialTab ?? 'replies' });
  activeTabRef.current.v = tab;
  useEffect(() => { void loadThread(threadId, { markRead: true }); }, [threadId]);
  useEffect(() => {
    setThreadReadGate((tid: string) =>
      tid === threadId
      && activeTabRef.current.v === 'replies'
      && document.visibilityState === 'visible'
      && !document.body.classList.contains('legacy-on')
      && (() => { const box = repliesBoxRef.current; return box != null ? (box.scrollHeight - box.scrollTop - box.clientHeight < 80) : false; })());
    return () => { setThreadReadGate(null); };
  }, [threadId]);
  useEffect(() => {
    const onFocus = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === `thread:${threadId}`) changeTab('replies');
    };
    window.addEventListener('zs:focus-composer', onFocus);
    return () => { window.removeEventListener('zs:focus-composer', onFocus); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('legacy-on')) void loadThread(threadId);
    }, 5000);
    return () => { window.clearInterval(t); };
  }, [threadId]);
  // 贴底推进水位（节流 1.5s——门在发起时重查）。
  const lastMarkRef = useRef(0);
  const onRepliesScroll = () => {
    const box = repliesBoxRef.current;
    if (box == null) return;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > 80) return;
    const now = Date.now();
    if (now - lastMarkRef.current < 1500) return;
    lastMarkRef.current = now;
    void markThreadReadIfAllowed(threadId);
  };

  /**
   * 回复列表只渲染**回复视图真正显示**的消息。
   *
   * 普通过程说明（路由推导、程序校验通过、派发规则）已移到「详情 → 活动与进展」，
   * 它们不再出现在回复列表里；但消息本体、threadMessageSeq 与未读水位都不动。
   * 首条未读的判定和分隔线必须跟着这份列表走，否则"跳转首条未读"会指向
   * 一个没有渲染的元素而静默失效（lib/threadNav 与 selectors 的同一口径）。
   */
  /** 我们自己写进 URL 的 tab：用于区分"外部深链改了 tab"与"内部切页写了 URL" */
  const urlTabRef = useRef<ThreadTabLocal>(initialTab ?? 'replies');
  const anchor = (thread ? anchorOf(s, thread) : undefined) ?? (s as AppState & { threadAnchors?: Record<string, Message | null> }).threadAnchors?.[threadId] ?? undefined;
  const list = useMemo(()=>{const replies=thread?replyThreadMessages(s,thread.id):[];return anchor?[anchor,...replies.filter(m=>m.id!==anchor.id)]:replies;},[s,thread?.id,anchor]);
  /** 线程归属会话（正式 thread.get 实体——发送信封 target 用，不从 UI 目标重造）。 */
  const entityConversationId = (s as AppState & { threadEntities?: Record<string, { conversationId?: string }> }).threadEntities?.[threadId]?.conversationId ?? '';
  const threadRoom = thread ? roomOf(s, thread.roomId) : undefined;
  const task = thread ? taskOfThread(s, thread) : undefined;
  const run = task ? s.runs.find((r) => r.taskId === task.id) ?? task.latestRun ?? undefined : undefined;
  const isDiscussion = Boolean(thread && !thread.rootTaskId);
  const followers = thread ? s.followers[thread.id] ?? [] : [];
  const absence = s.absence[threadId];
  /** 关注/静音读的是**同一份订阅状态**：顶部行、卡片菜单、详情成员分组不会各存一份 */
  const followed = Boolean(thread && s.subscriptions[thread.id]?.followed);
  const muted = Boolean(thread && s.subscriptions[thread.id]?.muted);
  const unread = thread ? unreadCount(s, thread.id) : 0;
  /**
   * 本串的消息附件（与"成果"列表相互独立）。
   *
   * 讨论串没有 taskId，`artifactsOfThread` 恒为空，但消息附件是独立聚合的 ——
   * 所以不能用"Artifact 需要 taskId"推断讨论串没有附件（减负 §2）。
   *
   * R70 修复：**根消息（锚）附件一并纳入**——锚消息 thread_id=null，旧选择器只按
   * m.threadId===thread.id 过滤结构性看不到根附件（记录串「附件」页签恒隐藏、
   * 已发记录的附件无处打开——独立复核反例的"已发根消息"入口）。loader 水合的
   * threadAnchors[tid].formalAttachments 即根附件事实（thread.history rootAttachments）。
   */
  const threadAttachments = useMemo(
    () => {
      if (thread == null) return [];
      const anchor = s.threadAnchors[thread.id];
      const anchorAtts = (anchor as unknown as { formalAttachments?: Array<{ artifactId: string; filename: string; kind: string }> } | null)?.formalAttachments ?? [];
      const fromAnchor = anchorAtts.map((a, i) => ({ messageId: anchor?.id ?? '', attachmentId: a.artifactId, filename: a.filename, kind: a.kind, ordinal: i }));
      const fromReplies = s.messageAttachments
        .filter((l) => s.messages.some((m) => m.id === l.messageId && m.threadId === thread.id))
        .map((l) => {
          const res = s.resources.find((r) => r.id === l.resourceId);
          return { messageId: l.messageId, attachmentId: l.resourceId, filename: res?.title ?? l.resourceId, kind: res?.mimeType ?? '', ordinal: l.ordinal };
        });
      return [...fromAnchor, ...fromReplies];
    },
    [s, thread?.id],
  );
  /**
   * 可停止的任务状态 —— 与「任务详情」里的停止按钮**同一判定**，
   * 不新造第二套规则（减负 §2.3）。任务被停掉后状态变 CANCELLED，
   * 停止按钮自然消失，仅保留"停止中…"直到活跃 turn 真正结束。
   */
  const canStop = Boolean(
    task && (['ACTIVE', 'WAITING_USER', 'BLOCKED'] as Task['status'][]).includes(task.status),
  );
  const stopping = run?.status === 'STOPPING';

  /**
   * 主池被文件挤掉（L4）时，「⋯」里列出**本房间的其他回复串**，可以直接切过去。
   *
   * 用户实测反馈：在对话池打开附件后点开一条串，主池就看不见了，
   * 于是"打不开其他回复串"（先点「主池」再找卡片是两跳，而且出口不明显）。
   * 这里不新增常驻切换器 —— 只在主池确实被挤掉、且用户主动打开 ⋯ 时给一份列表，
   * 切换时**文件与阅读位置都保留**（§3.3：左侧切到新上下文，右侧仍看那份文件）。
   */
  const otherThreads = useMemo(() => {
    if (!thread || !poolCollapsedByFile) return [];
    const out: { id: string; label: string; unread: number }[] = [];
    for (const m of rootMessages(s, thread.roomId)) {
      const t = s.threads.find((x) => x.anchorMessageId === m.id);
      if (!t || t.id === thread.id) continue;
      const tk = t.rootTaskId ? s.tasks.find((x) => x.id === t.rootTaskId) : undefined;
      out.push({
        id: t.id,
        label: tk ? `#${tk.roomTaskNumber} ${tk.title}` : '记录（无任务号）',
        unread: unreadCount(s, t.id),
      });
    }
    return out;
  }, [s, thread?.id, poolCollapsedByFile]);

  const progressContentKey=JSON.stringify((s.threadProgress[threadId]?.items??[]).map(p=>[p.turnId,p.text,p.phase,p.status,p.lastActivityAt,p.activities]));
  useEffect(()=>{const el=listRef.current;if(el&&pinnedToBottom)el.scrollTop=el.scrollHeight;},[progressContentKey,pinnedToBottom]);

  // 流式更新不抢滚动位置：用户向上翻历史时显示"有新消息"，不自动跳到底部（§17.5）
  useEffect(() => {
    const el = listRef.current;
    const grew = list.length > lastCountRef.current;
    lastCountRef.current = list.length;
    if (!el || !grew) return;
    if (pinnedToBottom) el.scrollTop = el.scrollHeight;
    else setPendingNew((n) => n + 1);
  }, [list.length, pinnedToBottom]);

  // 切换线程时重置阅读锚点，并采用 URL 上指定的 tab
  useEffect(() => {
    setSubtaskTarget(undefined);
    setTab(initialTab ?? 'replies');
    urlTabRef.current = initialTab ?? 'replies';
    setOpenArtifactId(initialArtifactId);
    setComposerInsert(undefined);
    setPendingNew(0);
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    // 只在切换线程时重置。initialTab/initialArtifactId 故意不作为依赖：
    // 同一线程内切 tab 会写回 URL（?tab=…），若依赖它们会整面板重置，
    // 输入中的草稿、滚动位置与收起状态全部丢失。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  /**
   * 同一线程内的 **URL → 界面** 同步（深链、前进/后退）。
   *
   * 上面那个 effect 只在换线程时采用 URL 的 tab，于是"同一个线程、只换 tab"
   * 的深链（`?thread=T&tab=delivery`、`?tab=members`、浏览器后退）不会生效，
   * URL 与界面就会不一致。这里补一条：只有当 URL 的 tab 既不是当前状态、
   * 也不是**我们自己刚写进去**的值时才采用 —— 内部切页写 URL 不会被反向重置。
   */
  useEffect(() => {
    const next = initialTab ?? 'replies';
    if (next === tab || next === urlTabRef.current) return;
    urlTabRef.current = next;
    setTab(next);
    // tab 故意不进依赖：它由本次同步写入，进依赖会与 changeTab 形成回环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab, threadId]);

  /**
   * 顶层视图与「详情」分组都从 URL 的 tab 键推出（减负 §8 映射表）。
   * 这样旧链接（?tab=task/run/delivery/…）落进来就自动展开对应分组，
   * 不需要为三视图另造一套状态，也不必迁移 URL。
   */
  const view: ThreadView = viewOfTab(tab);
  const section: DetailsSection = detailsSectionOfTab(tab) ?? 'overview';

  /** 切 tab 时把 tab 写回 URL，便于分享与返回（不 reload） */
  const changeTab = (next: ThreadTabLocal) => {
    urlTabRef.current = next;
    setTab(next);
    if (next !== 'artifacts') setOpenArtifactId(undefined);
    if (!thread) return;
    const q = new URLSearchParams();
    q.set('thread', thread.id);
    if (next !== 'replies') q.set('tab', next);
    navigate(`/project/${s.activeProjectId}/room/${thread.roomId}?${q.toString()}`, { replace: true });
  };

  /** 按"顶层视图 + 详情分组"切页；内部转成既有 tab 键 */
  const goView = (nextView: ThreadView, nextSection: DetailsSection = 'overview') =>
    changeTab(tabFor(nextView, nextSection));

  /**
   * 「收起 / 返回」的唯一动作：回到所属房间主池。
   *
   * 三个场景的**导航目标相同**（去掉 ?thread=），差别只在文案：
   *  · L2 主池＋回复串 → 收起回复串，主池保留；
   *  · 单区域线程 / 窄窗 → 返回主池；
   *  · L4 线程＋文件 → 回到主池上下文，文件按共享预览既有规则保留或暂藏。
   * 一律**不停止任务、不清草稿、不删成果与文件标签**（减负 §2.1）。
   *
   * 单区域布局下还要把可见区域切回上下文：那里是"对话/文件二选一"，
   * 只改 URL 会出现"按钮写着返回主池、画面仍是文件"的错位（实测）。
   * 单区域的可见区域状态在 RoomPage 里，所以这一步由调用方注入。
   */
  const backToPool = onBackToPool ?? (() => navigate(`/project/${s.activeProjectId}/room/${thread?.roomId ?? ''}`));

  // 直达链接：滚到目标消息并高亮（§15.5 只定位已有记录，不执行任何命令）。
  // R72：消息由 loadThread 异步装载——冷启动深链时 +350ms 元素常不存在（单次定时器
  // 静默漏定位）。有界重试（~18s）等元素真正挂载；到期仍无=如实不高亮（不伪造）。
  useEffect(() => {
    if (!highlightMessageId) return;
    setTab('replies');
    let tries = 0;
    let timer = 0;
    const tryHighlight = () => {
      const el = document.getElementById(`thread-msg-${highlightMessageId}`);
      if (el == null) {
        if (tries < 60) { tries += 1; timer = window.setTimeout(tryHighlight, 300); }
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('msg-highlight');
      window.setTimeout(() => el.classList.remove('msg-highlight'), 2600);
    };
    timer = window.setTimeout(tryHighlight, 350);
    return () => window.clearTimeout(timer);
  }, [highlightMessageId, threadId]);

  if (!thread || !anchor) {
    return (
      <aside className="col-thread">
        <div className="overlay-head">
          <span className="overlay-title">回复串</span>
        </div>
        <EmptyState icon="message-square" title="找不到该回复串" detail="链接可能指向已被归档或删除的记录。" />
      </aside>
    );
  }

  const jumpToFirstUnread = () => {
    const seq = firstUnreadSeq(s, thread.id);
    if (seq === undefined) return;
    const el = document.getElementById(`msg-seq-${thread.id}-${seq}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const insertMessageAction = (message: Message, kind: 'quote' | 'correction') => {
    const visible=chatAnswer(message.body,message.authorType).replace(/\s+/g,' ').trim().slice(0,400);
    const prefix = kind === 'quote' ? `> ${visible}` : '更正（针对上一条消息）：';
    setComposerInsert({ id: Date.now(), text: prefix });
    recordLocalOnly(
      `message.${kind}`,
      `message=${message.id} → 已插入当前串输入框；发送前仍可编辑，已发消息与执行依据不被覆盖`,
    );
    toast(kind === 'quote' ? '已引用到当前串输入框，可继续编辑后发送' : '已加入更正草稿，可补充内容后发送', 'info');
  };

  return (
    <aside
      className={`col-thread${narrow ? ' narrow' : ''}`}
      /**
       * 宽度来源优先级：
       *  1. flexStyle —— 有预览时由布局解析给出的两区宽度（§5.2）
       *  2. width —— 无预览时的既有可拖动宽度（不改动原行为）
       */
      style={flexStyle ?? (!narrow && width ? { width, flex: `0 0 ${width}px` } : undefined)}
    >
      {/**
       * ---------- 回复串唯一的一条紧凑导航栏（界面信息减负 §2） ----------
       *
       * 删掉的是这里的**两行常驻区域**：
       *  ① 任务号 / 执行中·运行中状态标签 / 另起任务·跳首条未读·关注·静音·关闭 图标组；
       *  ② 原消息摘要横条（展开箭头 + 作者 + 时间）。
       * 不换成同等高度的标题栏或摘要条：任务身份由输入区的目标摘要承担
       * （`跟进 #N · 标题`，删除后下方 Composer 仍在，长标题可点进详情看全文），
       * 完整标题、编号、原消息、真实状态都在「详情 → 任务概况」。
       */}
      <div className="thread-nav">
        {/* 区域级「收起/返回」：与文件预览的收起**同一个组件、同一侧（左）**，
            文案/图标按布局变化，tooltip 与可访问名称各自准确。
            · L2（主池在位）→「收起」：收起回复串，主池本来就在左边；
            · 单区域/窄窗 →「返回」：整个面板是全屏页，回主池；
            · L4（文件把主池挤掉）→「主池」：用户实测反馈"打开附件后回不到主池、
              也就打不开其他回复串"，所以这里把出口直接写成要去的地方。 */}
        <PanelNavButton
          className="thread-nav-back"
          icon={narrow || poolCollapsedByFile ? 'arrow-left' : 'chevron-right'}
          label={poolCollapsedByFile && !narrow ? '主池' : narrow ? '返回' : '收起'}
          ariaLabel={narrow || poolCollapsedByFile ? '返回主池' : '收起回复串'}
          title={poolCollapsedByFile && !narrow
            ? '返回主池（可在主池里选其他回复串；当前文件与草稿都保留）'
            : narrow
              ? '返回主池（不会停止任务，草稿保留）'
              : '收起回复串（保留主池；不会停止任务，草稿保留）'}
          onClick={backToPool}
        />

        <div className="thread-nav-views" role="tablist" aria-label="回复串视图">
          <button
            role="tab"
            aria-selected={view === 'replies'}
            className={`thread-tab${view === 'replies' ? ' on' : ''}`}
            onClick={() => changeTab('replies')}
          >
            <Icon name="message-square" size={13} /> 回复
            <span className="faint">{replyCount(s, thread.id)}</span>
          </button>
          {/**
           * 讨论串用「附件」而不是「成果」：Artifact 需要 taskId，讨论串恒为空，
           * 但**消息附件是独立聚合的**（messageAttachments），所以讨论串确实可能有附件。
           * 无附件时隐藏该入口；若 URL 明确指向附件视图（?tab=artifacts 旧链接）
           * 则强制显示，保证深链永远可达。
           */}
          {!isDiscussion || threadAttachments.length > 0 || tab === 'artifacts' ? (
            <button
              role="tab"
              aria-selected={view === 'artifacts'}
              className={`thread-tab${view === 'artifacts' ? ' on' : ''}`}
              onClick={() => changeTab('artifacts')}
              title={isDiscussion
                ? '这条记录携带的附件与产物（文件正文在共享预览里打开）'
                : '本串成果与附件；文件正文在共享预览里打开，不替换列表'}
            >
              <Icon name="file-text" size={13} /> {isDiscussion ? '附件' : '成果'}
              {isDiscussion && threadAttachments.length > 0 ? (
                <span className="faint">{threadAttachments.length}</span>
              ) : null}
            </button>
          ) : null}
          <button
            role="tab"
            aria-selected={view === 'details'}
            className={`thread-tab${view === 'details' ? ' on' : ''}`}
            onClick={() => goView('details', 'overview')}
            title="详情：任务概况、参与成员、活动与进展、运行、交付与验收、研讨"
          >
            <Icon name="list" size={13} /> 详情
          </button>
        </div>

        <div className="spacer" />

        {/**
         * ⋯ 收纳的是**次级但完整**的操作，不新增"另起任务"图标：
         * 新任务统一从房间主池输入框发起（减负 §2）。
         * 关注/静音显示当前状态，不只给无状态文字（§2.3）。
         */}
        <button
          className="icon-btn sm"
          title="更多：关注、静音、跳转首条未读、复制链接"
          aria-label="更多线程操作"
          aria-haspopup="menu"
          onClick={(e) => setThreadMenuAnchor(anchorFromElement(e.currentTarget))}
        >
          <Icon name="more-horizontal" size={16} />
        </button>
      </div>

      {threadMenuAnchor ? (
        <Menu anchor={threadMenuAnchor} onClose={() => setThreadMenuAnchor(null)}>
          {/**
           * 主池被文件挤掉时（L4），这里给出"回去"和"直接切别的串"两条路。
           * 只在需要时出现，不是常驻切换器；切换后文件与阅读位置都保留。
           */}
          {poolCollapsedByFile ? (
            <>
              <div className="menu-label">主池被文件收起时</div>
              <MenuItem
                icon="arrow-left"
                title="收起回复串、回到主池；文件与草稿都保留，可在主池卡片里选其他回复串"
                onClick={() => { setThreadMenuAnchor(null); backToPool(); }}
              >
                回主池
              </MenuItem>
              {otherThreads.length > 0 ? (
                <>
                  <div className="menu-label">其他回复串</div>
                  {otherThreads.map((t) => (
                    <MenuItem
                      key={t.id}
                      icon="message-square"
                      title={`切换到「${t.label}」；当前文件与阅读位置保留`}
                      hint={t.unread > 0 ? `${t.unread} 条未读` : undefined}
                      onClick={() => {
                        setThreadMenuAnchor(null);
                        const q = new URLSearchParams();
                        q.set('thread', t.id);
                        if (tab !== 'replies') q.set('tab', tab);
                        navigate(`/project/${s.activeProjectId}/room/${thread.roomId}?${q.toString()}`);
                      }}
                    >
                      {t.label}
                    </MenuItem>
                  ))}
                </>
              ) : (
                <div className="menu-note">这个房间目前只有本条回复串。</div>
              )}
              <div className="menu-sep" />
            </>
          ) : null}
          <div className="menu-label">本条回复串</div>
          <MenuItem
            icon={followed ? 'eye' : 'eye-off'}
            title={followed
              ? '只停通知，不停止任务，也不改变参与与执行权限'
              : '关注后这条串的回复会进入你的通知'}
            hint={followed ? '已关注' : '未关注'}
            onClick={() => { void toggleThreadSubscription(thread.id, { follow: !followed }); setThreadMenuAnchor(null); }}
          >
            {followed ? '取消关注' : '关注'}
          </MenuItem>
          <MenuItem
            icon="bell"
            title={muted
              ? '恢复这条串的通知；不改变参与名单与执行权限'
              : '只改通知偏好，不改变参与名单与执行权限'}
            hint={muted ? '已静音' : '未静音'}
            onClick={() => { void toggleThreadSubscription(thread.id, { mute: !muted }); setThreadMenuAnchor(null); }}
          >
            {muted ? '取消静音' : '静音'}
          </MenuItem>
          {unread > 0 ? (
            <MenuItem
              icon="corner-down-right"
              title="滚到这条串里第一条未读消息"
              hint={`${unread} 条未读`}
              onClick={() => { jumpToFirstUnread(); setThreadMenuAnchor(null); }}
            >
              跳转首条未读
            </MenuItem>
          ) : null}
          <MenuItem
            icon="copy"
            title="复制应用内直达链接（不是公网分享链接）"
            onClick={() => {
              const link = `zhongshuo://#/thread/${thread.id}`;
              void navigator.clipboard?.writeText(link);
              recordLocalOnly(
                'thread.link.copy',
                `thread=${thread.id} → ${link}（应用内直达链接，不是公网分享链接）`,
              );
              toast('已复制本串的应用内链接', 'info');
              setThreadMenuAnchor(null);
            }}
          >
            复制本串链接
          </MenuItem>
        </Menu>
      ) : null}

      {/**
       * E4 缺席容忍：这是**真正需要用户处理**的异常，保留在导航下方
       * （减负只收正常信息，不收异常；不能因为精简把可操作的风险藏起来）。
       */}
      {absence && !absence.continued ? (
        <div className="panel warning" style={{ margin: '8px 12px 0' }}>
          <div className="panel-title">
            <Icon name="clock" size={13} />
            等 {memberLabel(byId(s.members, absence.memberId))}（已 {Math.round((Date.now() - absence.since) / 60000)} 分钟，容忍 {Math.round(absence.graceMs / 60000)} 分钟）
          </div>
          超过等待时间后会先带着现有成果继续，不会打断仍在工作的成员。需要它继续参与时，可在串里重新 @ 它。
        </div>
      ) : null}

      {/**
       * 原来这里是第三个常驻行：回复/成果/活动/成员/任务详情/交付/研讨详情/运行详情
       * 最多 8 个页签。它们已按 §8 映射表收进三个常驻视图：
       *   活动/成员/任务详情/交付/研讨详情/运行详情 → 「详情」内的分组
       * 「回复」「成果」保持原样。URL 仍写既有 tab 键，旧深链不动。
       */}

      <div className="list-wrap">
        {view === 'replies' ? (
          <>
            {/**
             * 待处理提示条：待验收 / 阻塞 / 运行失败这类**必须能被发现**的事项
             * 保留在回复视图里，并直达对应分组（§2.2、§2.3）。
             * 它只在这些状态真实存在时出现，不是常驻工具条。
             * 授权请求、需用户决定的分歧本身就以消息卡形式留在对话里，不在这里重复。
             */}
            <ThreadPendingStrip
              s={s}
              task={task}
              run={run}
              onOpenSection={(sec) => goView('details', sec)}
            />
            <div
              className="msg-list is-replies"
              ref={(el) => { (listRef as { current: HTMLDivElement | null }).current = el; repliesBoxRef.current = el; }}
              onScroll={(e) => {
                const el = e.currentTarget;
                const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                setPinnedToBottom(atBottom);
                if (atBottom) setPendingNew(0);
                if (atBottom) onRepliesScroll();
              }}
            >
              {list.map((m) => {
                const seq = m.threadMessageSeq;
                const watermark = s.readStates[thread.id] ?? 0;
                const isFirstUnread = seq !== undefined && seq > watermark && !list.some((x) => (x.threadMessageSeq ?? 0) > watermark && (x.threadMessageSeq ?? 0) < seq);
                return (
                  <div key={m.id} className="msg-item" id={seq !== undefined ? `msg-seq-${thread.id}-${seq}` : undefined}>
                    {isFirstUnread ? (
                      <div className="row tight" style={{ marginBottom: 8 }}>
                        <div className="divider" style={{ flex: 1, margin: 0 }} />
                        <Tag tone="info" icon="message-square">首条未读</Tag>
                        <div className="divider" style={{ flex: 1, margin: 0 }} />
                      </div>
                    ) : null}
                    <MessageView
                      message={{...m,saved:s.savedMessageRefs[m.id]===true||m.saved===true}}
                      domId={`thread-msg-${m.id}`}
                      linkThreadId={thread.id}
                      readingAids
                      author={m.authorType === 'human' ? undefined : byId(s.members, m.authorId)}
                      mode={task?.mode}
                      isMentioned={Boolean(m.payload?.mentionIds?.includes('you') || m.payload?.mentionIds?.some((id) => id === m.authorId))}
                      onOpenThread={() => undefined}
                      onOpenArtifact={() => changeTab('artifacts')}
                      onOpenAttachment={(att) => openAttachment(att, {
                        target: {
                          kind: 'thread', projectId: s.activeProjectId,
                          roomId: thread.roomId, threadId, tab: 'replies',
                        },
                        messageId: m.id,
                      }, entityConversationId)}
                      onReact={(e) => void reactMessageReal(m.id, e, threadId)}
                      onSave={() => {
                        void toggleSavedMessage(m, s.projects.find((pr) => pr.id === s.activeProjectId)?.id ?? null).then((r) => {
                          if (r.ok) toast(r.saved ? '已收藏（独立保存，不改动原内容）' : '已取消收藏', 'success');
                          else if (r.busy !== true) toast(`收藏操作失败：${r.error ?? '未知错误'}`, 'error');
                        });
                      }}
                      onQuote={(message) => insertMessageAction(message, 'quote')}
                      onCorrection={(message) => insertMessageAction(message, 'correction')}
                    />
                  </div>
                );
              })}
              {(s.threadProgress[thread.id]?.items??[]).map(progress=><LiveProgressCard
                key={progress.turnId}
                progress={progress}
                memberName={memberLabel(byId(s.members,progress.memberId))}
                readError={s.readErrors['thread:'+thread.id]}
                readAt={s.threadProgress[thread.id]?.readAt}
              />)}
            </div>

            {!pinnedToBottom && pendingNew > 0 ? (
              <button
                className="new-msg-pill"
                onClick={() => {
                  const el = listRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                  setPinnedToBottom(true);
                  setPendingNew(0);
                }}
              >
                <Icon name="chevron-down" size={13} /> 有新消息（{pendingNew}）
              </button>
            ) : null}
          </>
        ) : null}

        {view === 'artifacts' ? (
          <ThreadArtifacts
            threadId={thread.id}
            isDiscussion={isDiscussion}
            openId={openArtifactId}
            onOpen={(id) => {
              setOpenArtifactId(id);
              const q = new URLSearchParams();
              q.set('thread', thread.id);
              q.set('tab', 'artifacts');
              q.set('artifact', id);
              navigate(`/project/${s.activeProjectId}/room/${thread.roomId}?${q.toString()}`, { replace: true });
            }}
            onBack={() => {
              setOpenArtifactId(undefined);
              const q = new URLSearchParams();
              q.set('thread', thread.id);
              q.set('tab', 'artifacts');
              navigate(`/project/${s.activeProjectId}/room/${thread.roomId}?${q.toString()}`, { replace: true });
            }}
            onOpenResource={onOpenResource}
            onReview={() => changeTab('delivery')}
          />
        ) : null}

        {/**
         * 「详情」= 原来 8 个页签里除回复/成果外的全部内容，按分组就地渲染。
         * 分组导航是**紧凑 chip 行**（可换行），不是第二条同重量的常驻页签栏；
         * 分组按任务实际情况出现（讨论串没有任务/运行/交付/研讨分组）。
         */}
        {view === 'details' ? (
          <ThreadDetails
            s={s}
            threadId={thread.id}
            anchor={anchor}
            task={task}
            focusedTaskId={focusedTaskId} focusedDeliveryId={focusedDeliveryId}
            run={run}
            isDiscussion={isDiscussion}
            section={section}
            followerCount={followers.length}
            onChangeSection={(sec) => goView('details', sec)}
            onChangeTab={changeTab}
          />
        ) : null}
      </div>

        <Composer
          target={{ kind: 'thread', roomId: thread.roomId, threadId: thread.id, subtask: subtaskTarget }}
          draftKey={`thread:${thread.id}`}
          insertText={composerInsert}
          formalLimits={FORMAL_LIMITS}
          attachmentUpload={entityConversationId !== '' ? { conversationId: entityConversationId } : undefined}
          /* 归档房间是只读的：主池早已这样处理，线程输入条此前漏了同一判定 */
          sendDisabledReason={
            threadRoom?.archivedAt
              ? '房间已归档 · 只读，不能发送新内容'
              : threadRoom && s.projects.find((p) => p.id === threadRoom.projectId)?.archivedAt
                ? '项目已归档 · 只读，不能发送新内容'
                : threadRoom?.memberIds.length === 0
                  ? '房间还没有成员，请先添加成员'
                  : undefined
          }
          runBudget={run != null && 'budget' in run && run.budget != null ? { used: (run as WorkflowRun).budget.usedAgentTurns, max: (run as WorkflowRun).budget.maxAgentTurns } : undefined}
          /* 停止入口按**任务真实状态**出现（stop=task.stop 三重绑定；关闭/收起永不触发） */
          stop={task && (canStop || stopping)
            ? {
              onStop: () => {
                void stopThreadTask(threadId).then((r) => {
                  if (r.ok) toast('停止请求已提交（等活跃 turn 结束——详情状态会刷新）', 'success');
                  else toast(`停止失败：${r.error}`, 'error');
                });
              },
              stopping,
            }
            : undefined}
          onClearSubtask={() => setSubtaskTarget(undefined)}
          onRetrySend={(env) => retryUnknownSend(env).then((r) => {
            if (r.status === 'ok') { void loadThread(threadId, { markRead: true }); toast('重发成功（原信封）', 'success'); }
            return r.status === 'ok' ? { status: 'ok' } : r.status === 'failed' ? { status: 'failed', error: r.error } : { status: 'unknown', error: r.error };
          })}
          onSend={(p): Promise<FormalSendOutcome> => (async () => {
            const intent = 'default' as const;
            const draftKey = `thread:${threadId}`;
            const refs = attachmentRefsFromDraft(draftKey, intent);
            if (refs.blockError != null) return { status: 'failed', error: refs.blockError };
            if (entityConversationId === '') return { status: 'failed', error: '线程归属未装载（conversationId 缺失）——稍后重试' };
            const env = buildThreadEnvelope(p.commandId, threadId, p.body, intent, refs.refs, { mentionIds:p.mentionIds, imageAck: p.imageAck, attachmentRanges: attachmentRangesFromDraft(draftKey) });
            env.revAtSend = p.draftRev;
            const staged = stageOutbound(draftKey, env); // r62 P1：预 bridge 耐久落账
            if (staged.ok !== true) return { status: 'failed', error: staged.error ?? '原信封未能耐久保存' };
            const r = await sendEnvelope(env);
            if (r.status === 'ok') settleOutbound(draftKey, env);
            else if (r.status === 'failed') dropOutbound(draftKey, env);
            else confirmOutboundUnknown(draftKey, env);
            if (r.status === 'ok') {
              void loadThread(threadId, { markRead: true }).catch(() => { /* 读失败另有呈现 */ });
              toast(r.data.disposition==='enqueued'?'已发送，等待 AI 回复':'已跟进', 'success');
              return { status: 'ok' };
            }
            return r.status === 'failed' ? { status: 'failed', error: r.error } : { status: 'unknown', error: r.error };
          })()}
        />
    </aside>
  );
}

/* ============================================================
   详情：分组导航与各分组内容（界面信息减负 §2.2）

   原来的 8 个常驻页签里，除「回复」「成果」外的全部内容收进这里：
   任务概况 / 参与成员 / 活动与进展 / 运行详情 / 交付与验收 / 研讨详情。
   分组导航是**紧凑 chip 行**（可换行、可淡出），不是第二条同重量的常驻页签栏；
   分组按任务实际情况出现，普通讨论串不渲染任务、运行或验收控件。
   URL 仍用既有 tab 键，旧深链落进来就自动展开对应分组（§8）。
   ============================================================ */

function ThreadDetails({
  s, threadId, anchor, task, run, isDiscussion, section, followerCount,focusedTaskId,focusedDeliveryId,
  onChangeSection, onChangeTab,
}: {
  s: AppState;
  threadId: string;
  anchor: Message;
  task?: Task;
  focusedTaskId?:string;focusedDeliveryId?:string;
  run?: WorkflowRun | NonNullable<Task['latestRun']>;
  isDiscussion: boolean;
  section: DetailsSection;
  followerCount: number;
  onChangeSection: (sec: DetailsSection) => void;
  onChangeTab: (tab: ThreadTabLocal) => void;
}) {
  const childFocused=Boolean(focusedTaskId&&focusedTaskId!==task?.id);
  const formal = useTaskDetails(task?.projectId, childFocused?undefined:task?.id, task?.revision, run?.id, run?.status);
  const [retryBusyTask, setRetryBusyTask] = useState<string | null>(null);
  const [acceptedRetryRun, setAcceptedRetryRun] = useState<string | null>(null);
  const retryFailed = () => {
    const details = formal.data;
    const latest = details?.runs.find((r) => r.id === details.latestRunId);
    if (task == null || details == null || !(latest?.status==='FAILED'&&details.failedRetry.available||latest?.status==='SUCCEEDED'&&details.clarificationRetry?.available) || acceptedRetryRun === latest.id) return;
    const snapshot = { taskId: details.task.id, sourceRunId: latest.id,
      expectedTaskRevision: details.task.revision, expectedStopGeneration: details.task.stopGeneration,
      expectedRunStatus: latest.status as 'FAILED'|'SUCCEEDED' };
    setRetryBusyTask(snapshot.taskId);
    void (async () => {
      try {
        await command('task.redispatch', { ...snapshot,...(details.failedRetry.formatRepair?{formatRepair:true}:{}), reason: latest.status==='SUCCEEDED'?'用户补充后显式继续工作':details.failedRetry.formatRepair?'用户显式修复输出格式':'用户在运行详情显式继续最近失败运行' });
        setAcceptedRetryRun(snapshot.sourceRunId);
        recordWrite('task.redispatch', `继续失败运行（任务 ${snapshot.taskId.slice(0, 12)}…）`);
        toast('继续请求已入队；等待正式执行结果', 'success');
      } catch (e) {
        toast(`继续被拒：${(e as Error).message}——请按当前任务事实重新决定`, 'error');
      } finally {
        setRetryBusyTask((current) => current === snapshot.taskId ? null : current);
        formal.refresh();
        void loadThread(threadId).catch(() => { /* 读取失败由详情保留事实并提示 */ });
      }
    })();
  };
  const pendingDelivery = task?.currentDeliveryId
    ? s.taskDeliveries.find((d) => d.id === task.currentDeliveryId)
    : undefined;
  const hasDelivery = Boolean(
    task && (task.currentDeliveryId || s.taskDeliveries.some((d) => d.taskId === task.id) || formal.data?.deliveries.length),
  );

  if(childFocused&&task&&focusedTaskId)return <ChildTaskDetails deliveryId={focusedDeliveryId} projectId={task.projectId} taskId={focusedTaskId} parentTaskId={task.id} conversationId={threadOf(s,threadId)?.conversationId}/>;
  const groups: { key: DetailsSection; label: string; icon: string; hint: string }[] = [
    { key: 'overview', label: isDiscussion ? '记录信息' : '任务概况', icon: 'list', hint: isDiscussion ? '根消息与参与者' : '标题、编号、完整原始要求、状态与方式' },
    { key: 'members', label: '参与成员', icon: 'users', hint: '线程成员与跟进名单：移出=停止自动唤醒，历史保留，可再 @ 回来' },
    { key: 'activity', label: '活动与进展', icon: 'activity', hint: '本串执行记录与普通过程说明（路由推导、校验通过、阶段推进）' },
  ];
  if (task) {
    groups.push({ key: 'run', label: '运行详情', icon: 'terminal', hint: '工具活动、用量、错误与原始诊断' });
  }
  if (hasDelivery || section === 'delivery') {
    groups.push({ key: 'delivery', label: '交付与验收', icon: 'check-circle', hint: '完成摘要、版本、验证、残余问题与验收决定（可选验收的唯一入口）' });
  }
  if (task && formal.data?.runs[0]?.mode === 'DELIBERATE') {
    groups.push({ key: 'deliberation', label: '研讨详情', icon: 'layers', hint: '初稿、互评、争议、确认矩阵' });
  }

  /* 深链指向的分组在当前任务上不存在（例如 ?tab=run 但没有运行）时，
     退回概况并如实说明，不静默留在空白页。 */
  const active: DetailsSection = groups.some((g) => g.key === section) ? section : 'overview';

  return (
    <div className="thread-details">
      <div className="details-subnav" role="tablist" aria-label="详情分组">
        {groups.map((g) => (
          <button
            key={g.key}
            role="tab"
            aria-selected={active === g.key}
            className={`details-chip${active === g.key ? ' on' : ''}`}
            title={g.hint}
            onClick={() => onChangeSection(g.key)}
          >
            <Icon name={g.icon} size={11} /> {g.label}
            {g.key === 'members' && followerCount > 0 ? <span className="faint">{followerCount}</span> : null}
            {g.key === 'delivery' && pendingDelivery?.status === 'pending' ? (
              <Tag tone="warning" icon="eye">待验收</Tag>
            ) : null}
          </button>
        ))}
      </div>

      <div className="details-body">
        {task ? <DetailReadState error={formal.error} loading={formal.loading} updatedAt={formal.updatedAt} refresh={formal.refresh} readingKey={`${formal.readingKey}:${section}`} /> : null}
        {active !== section ? (
          <div className="panel info" style={{ margin: '0 0 10px' }}>
            <div className="panel-title"><Icon name="info" size={13} /> 该分组在当前任务上不适用</div>
            原链接指向的分组（{section}）在这个线程里没有对应内容，已显示任务概况。
            这不会改动任何任务、交付或运行状态。
          </div>
        ) : null}
        {active === 'overview' ? (
          <ThreadOverview s={s} threadId={threadId} anchor={anchor} task={task} isDiscussion={isDiscussion} formal={formal.data} />
        ) : null}
        {active === 'members' ? <>{formal.data ? <ActualMembers detail={formal.data} /> : null}<ThreadMembers threadId={threadId} isDiscussion={isDiscussion} /></> : null}
        {active === 'activity' ? <ThreadActivity threadId={threadId} detail={formal.data} onChangeTab={onChangeTab} /> : null}
        {active === 'run' && task ? <ThreadRunFacts detail={formal.data} onSelectRun={formal.selectRun} onRetryFailed={retryFailed} retryBusy={retryBusyTask === task.id || acceptedRetryRun === formal.data?.latestRunId} /> : null}
        {/* v1.12 §10.5：交付详情仍是**可选验收的唯一主入口**，决定只在这里做一次 */}
        {active === 'delivery' && task ? <><ThreadDeliveryPanel threadId={threadId} task={task} />{formal.data ? <DeliveryHistoryFacts detail={formal.data} /> : null}</> : null}
        {active === 'deliberation' && formal.data?.runs[0]?.mode === 'DELIBERATE' ? (
          <div className="msg-list">
            <div className="panel info">
              <div className="panel-title"><Icon name="layers" size={13} /> 研讨详情（阶段/初稿/互评/确认矩阵）</div>
              研讨过程明细的只读投影尚未接入本页——经「⋯ → 原界面」可查完整研讨记录。
              这里不伪造阶段进度或共识状态。
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 任务概况 / 讨论信息。
 *
 * 这里是**原消息与任务身份的新家**：顶部两行删掉后，
 * 完整原始要求、任务号、真实状态、方式、阶段与来源都必须仍可查（§2.2）。
 *
 * 下面内嵌 TaskDetailPage 时传 `embedded`（减负第二轮 §1）：只复用它**具体的内容区块**
 * （任务属性、运行与预算、参与者、子任务、成果、改动集……），
 * 不再重复本卡已经给出的标题/状态/方式与那排操作 —— 但子任务、改动集、
 * 预算明细、定向跟进因此一个都不丢（停止在输入区、研讨与交付在详情分组里另有入口）。
 */
function ThreadOverview({
  s, threadId, anchor, task, isDiscussion, formal,
}: {
  s: AppState;
  threadId: string;
  anchor: Message;
  task?: Task;
  isDiscussion: boolean;
  formal: TaskDetailsResult | null;
}) {
  const room = roomOf(s, anchor.roomId);
  const project = s.projects.find((p) => p.id === anchor.projectId);
  /**
   * 方式与派发摘要（2026-09-24 收尾①）。
   *
   * 原来这两行说的是同一句话：`方式 = 共同研讨 · @全体 或多个 @：冻结名单、阶段推进`，
   * `派发摘要 = @全体 或多个 @：冻结名单、阶段推进`（都取自 routeModeCopy.detail）。
   * 现在：
   *  · 方式行只给**模式名**（完整解释进 tooltip）；
   *  · 「派发」行只在**存在独立派发信息**时出现 —— 这条原消息到底点了谁、
   *    或者是某个任务的子任务；没有点名也没有父任务就整行不渲染。
   */
  // task.get hydration keeps a minimal UI shape with placeholder mode/stage/budget.
  // Detail labels must come from the formal run projection, never from that placeholder.
  const latestRun = formal?.runs[0];
  const modeCopy = latestRun != null && (latestRun.mode === 'AUTO' || latestRun.mode === 'DELIBERATE' || latestRun.mode === 'DIRECT')
    ? routeModeCopy[latestRun.mode] : undefined;
  const parentTask = task?.parentTaskId ? s.tasks.find((x) => x.id === task.parentTaskId) : undefined;
  const mentionIds = anchor.payload?.mentionIds ?? [];
  const dispatchParts: string[] = [];
  if (task) {
    if (mentionIds.includes('all')) dispatchParts.push('已点名 @全体');
    else {
      const named = mentionIds.filter((id) => id !== 'all');
      if (named.length > 0) {
        dispatchParts.push(`已点名 ${named.map((id) => memberLabel(byId(s.members, id))).join('、')}`);
      }
    }
    if (parentTask) dispatchParts.push(`子任务 of #${parentTask.roomTaskNumber}`);
  }

  return (
    <div className="msg-list">
      <div className="card tight">
        <div className="section-title">
          <Icon name={isDiscussion ? 'message-square' : 'list'} size={13} />
          {isDiscussion ? '记录信息' : '任务概况'}
        </div>
        <dl className="kv">
          <dt>标题</dt>
          <dd>{task ? task.title : '（记录串：没有任务标题，也不伪造编号）'}</dd>
          {task ? (
            <>
              <dt>任务号</dt>
              <dd className="mono-sm">#{task.roomTaskNumber}</dd>
              <dt>状态</dt>
              <dd className="row tight wrap">
                <TaskStatusTag status={(formal?.task.status ?? task.status) as Task['status']} />
                {task.delivery != null && task.delivery.status !== 'delivered' ? <Tag tone={task.delivery.status === 'blocked' || task.delivery.status === 'needs_user' ? 'warning' : 'neutral'} icon="alert-circle">{task.delivery.status === 'delivered_with_questions' ? '已交付 · 有待确认' : task.delivery.status === 'needs_user' ? '等待你补充' : task.delivery.status === 'blocked' ? '交付未完成' : '本轮已结束 · 旧格式'}</Tag> : null}
                {latestRun ? <RunStatusTag status={latestRun.status as WorkflowRun['status']} /> : null}
              </dd>
              <dt>方式</dt>
              <dd title={modeCopy?.detail}>{modeCopy?.label ?? '读取运行详情后显示'}</dd>
              <dt>阶段</dt>
              <dd>{latestRun ? (latestRun.stage == null ? '无阶段记录' : stageLabel(latestRun.stage as WorkflowRun['stage'])) : '尚无运行详情'}</dd>
              {dispatchParts.length > 0 ? (
                <>
                  <dt>派发</dt>
                  <dd>{dispatchParts.join(' · ')}</dd>
                </>
              ) : null}
            </>
          ) : null}
          <dt>来源</dt>
          <dd>{project?.displayName ?? '未知项目'} / {room?.name ?? '未知房间'}</dd>
        </dl>
      </div>

      {formal ? <div className="panel info">{taskRunGuidance(formal)}</div> : null}

      {/* 完整原始要求：不裁剪、不折叠，长文本完整可读（原消息身份与定位能力保留） */}
      <div className="card tight">
        <div className="section-title">原始要求（原消息）</div>
        <div className="row tight">
          <Avatar name="我" color="var(--m-human)" size={18} subject="user" />
          <span className="strong">你</span>
          <span className="small faint">{fullTime(anchor.createdAt)}</span>
        </div>
        <div className="overview-anchor-body">{anchor.body}</div>
      </div>

      {task ? (
        <ThreadTaskFacts threadId={threadId} task={task} formal={formal} />
      ) : (
        <div className="panel info">
          <div className="panel-title"><Icon name="info" size={13} /> 记录串没有任务、运行与验收</div>
          记录只保存消息：不调用模型、不派工、没有任务号。需要 AI 处理这些内容时，把要点引用或复制到普通输入里发送
          （本轮不做"把记录转成任务"的一键转换）。
        </div>
      )}
    </div>
  );
}

/**
 * 回复视图里的待处理提示条（§2.2 末段 / §2.3）。
 *
 * 只列**不在对话正文里**的待处理事项：待验收、阻塞、运行失败/结果不确定。
 * 授权请求与需用户决定的分歧本身就以消息卡形式留在回复列表里，
 * 这里不重复，避免同一件事出现两个入口。
 * 没有任何待处理时整块不渲染 —— 它不是常驻工具条。
 */
function ThreadPendingStrip({
  s, task, run, onOpenSection,
}: {
  s: AppState;
  task?: Task;
  run?: WorkflowRun | NonNullable<Task['latestRun']>;
  onOpenSection: (sec: DetailsSection) => void;
}) {
  // 讨论串没有任务：不渲染任何任务/运行/验收控件（§8）
  if (!task) return null;
  const pendingDelivery = task.currentDeliveryId
    ? s.taskDeliveries.find((d) => d.id === task.currentDeliveryId)
    : undefined;
  const deliveryPending = pendingDelivery?.status === 'pending';
  const blocked = task.status === 'BLOCKED';
  const runTrouble = run?.status === 'FAILED' || run?.status === 'PARTIAL' || run?.status === 'INTERRUPTED';
  if (!deliveryPending && !blocked && !runTrouble) return null;

  return (
    <div className="thread-pending">
      {deliveryPending && pendingDelivery ? (
        <div className="card tight">
          <div className="row tight wrap">
            <Icon name="eye" size={13} />
            <span className="strong" style={{ fontSize: 12 }}>交付 r{pendingDelivery.revision} 等你验收</span>
            <span className="small faint truncate">{pendingDelivery.summary}</span>
            <div className="spacer" />
            <button className="btn sm primary" onClick={() => onOpenSection('delivery')}>
              去验收
            </button>
          </div>
        </div>
      ) : null}

      {blocked ? (
        <div className="card tight">
          <div className="row tight wrap">
            <Icon name="octagon" size={13} />
            <span className="strong" style={{ fontSize: 12 }}>任务被阻塞，需要你处理</span>
            <span className="small faint truncate">请在详情查看正式受阻原因与下一步</span>
            <div className="spacer" />
            <button className="btn sm" onClick={() => onOpenSection(run ? 'run' : 'overview')}>
              查看详情
            </button>
          </div>
        </div>
      ) : null}

      {runTrouble && run ? (
        <div className="card tight">
          <div className="row tight wrap">
            <Icon name="alert-triangle" size={13} />
            <span className="strong" style={{ fontSize: 12 }}>
              运行{run.status === 'FAILED' ? '失败' : run.status === 'PARTIAL' ? '只完成一部分' : '被中断'}
            </span>
            <span className="small faint truncate">已停止、结果不确定等状态在运行详情里有真实记录</span>
            <div className="spacer" />
            <button className="btn sm" onClick={() => onOpenSection('run')}>
              运行详情
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- 串内成员 / 跟进名单（原为头部常驻，现已并入「详情」） ---------------- */

function ThreadMembers({ threadId }: { threadId: string; isDiscussion: boolean }) {
  const s = useStore((x) => x);
  const thread = threadOf(s, threadId);
  const snapshot = s.threadMemberships[threadId];
  const room = thread ? roomOf(s, thread.roomId) : undefined;
  const [operation, setOperation] = useState<{target:string;pending:boolean;error:string|null}>({target:'',pending:false,error:null});
  const live = useRef(true);
  const operationSerial=useRef(0);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const target=threadId+':'+s.activeProjectId;
  const pending=operation.target===target&&operation.pending;
  const error=operation.target===target?operation.error:null;
  const members=(snapshot?.memberIds??[]).map(id=>byId(s.members,id)).filter((m):m is ProjectMember=>Boolean(m));
  const candidates=(room?.memberIds??[]).map(id=>byId(s.members,id)).filter((m):m is ProjectMember=>Boolean(m)&&!snapshot?.memberIds.includes(m!.id));
  const change=async(memberId:string,action:'add'|'remove')=>{
    if(!thread||!snapshot||pending)return;
    const projectId=s.activeProjectId,gen=s.loadGen,scope=target;
    const serial=++operationSerial.current;
    setOperation({target:scope,pending:true,error:null});
    try {
      await command('thread.members.change',{projectId,threadId,memberId,action,expectedVersion:snapshot.version});
      if(getState().activeProjectId===projectId&&getState().loadGen===gen)await loadThread(threadId);
    } catch(error) {
      if(live.current&&operationSerial.current===serial&&getState().activeProjectId===projectId&&getState().loadGen===gen)setOperation({target:scope,pending:false,error:(error as Error).message});
      return;
    }
    if(live.current&&operationSerial.current===serial)setOperation({target:scope,pending:false,error:null});
  };
  const readError=s.readErrors['thread:'+threadId];
  return <div className="msg-list">
    <div className="section-title">本串成员 <span className="count">{snapshot?members.length:'…'}</span></div>
    {error||readError?<div className="panel danger" role="alert">{error??readError}<button className="btn sm" onClick={()=>void loadThread(threadId)}>刷新名单</button></div>:null}
    {!snapshot?<div className="small faint">正在读取成员…</div>:members.length===0?<EmptyState icon="users" title="还没有 AI 参与" detail="从下方添加一位 AI，再发消息。"/>:null}
    {members.map(m=><div key={m.id} className="row" style={{justifyContent:'space-between'}}>
      <span className="row tight"><Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id,m.ordinal)} size={22} state={m.workState} subject={`member:${m.id}`}/><span className="strong">{memberLabel(m)}</span><span className="small faint">{snapshot?.eligibleMemberIds.includes(m.id)?(m.workStateReason||'状态未提供'):'暂不可接收新消息'}</span></span>
      <button className="btn sm" disabled={pending} onClick={()=>void change(m.id,'remove')}>移出</button>
    </div>)}
    {(snapshot?.runningMemberIds??[]).filter(id=>!snapshot?.memberIds.includes(id)).map(id=><div key={id} className="small faint">{memberLabel(byId(s.members,id))} 已移出，当前执行仍在进行；可在任务中停止。</div>)}
    {candidates.length>0?<><div className="section-title" style={{marginTop:16}}>添加 AI</div>{candidates.map(m=><div key={m.id} className="row" style={{justifyContent:'space-between'}}><span>{memberLabel(m)}</span><button className="btn sm" disabled={pending||!snapshot||m.enabled===false} onClick={()=>void change(m.id,'add')}>添加到本串</button></div>)}</>:null}
  </div>;
}

/* ---------------- 串内成果 tab ---------------- */

function ThreadArtifacts({
  threadId,
  isDiscussion,
  onOpenResource,
  onReview,
}: {
  threadId: string;
  /** 讨论串：只有消息附件，没有任务成果（Artifact 需要 taskId） */
  isDiscussion?: boolean;
  openId?: string;
  onOpen?: (id: string) => void;
  onBack?: () => void;
  /** UX-PREVIEW-01：在共享预览区打开资源 */
  onOpenResource?: (resourceId: string, revision?: number, from?: ContextLocation) => void;
  onReview?: () => void;
}) {
  const s = useStore((x) => x);
  /** 线程归属会话与任务（真实实体——附件按会话聚合、交付按任务过滤）。 */
  const entity = (s as AppState & { threadEntities?: Record<string, { conversationId?: string }> }).threadEntities?.[threadId];
  const conversationId = entity?.conversationId ?? '';
  const thread = threadOf(s, threadId);
  const task = thread ? taskOfThread(s, thread) : undefined;
  const room = thread ? roomOf(s, thread.roomId) : undefined;
  const projectId = s.activeProjectId;
  const [data, setData] = useState<
    { attachments: Array<{ attachmentId: string; filename: string; kind: string; hash: string; revision: number; createdAt: number }>; attErr: string | null; deliveries: Array<{ deliveryId: string; revision: number; manifestHash: string; taskId: string; title: string; reviewedAt: number | null }>; delErr: string | null } | null
  >(null);
  const genRef = useRef(0);
  useEffect(() => {
    if (conversationId === '') return;
    const gen = ++genRef.current;
    const next = { attachments: [] as NonNullable<typeof data>['attachments'], attErr: null as string | null, deliveries: [] as NonNullable<typeof data>['deliveries'], delErr: null as string | null };
    void (async () => {
      try {
        const r = await command<{ items: NonNullable<typeof data>['attachments'] }>('attachment.listByConversation', { conversationId });
        if (gen !== genRef.current) return;
        next.attachments = r.items ?? [];
      } catch (e) { if (gen === genRef.current) next.attErr = (e as Error).message; }
      if (gen === genRef.current) setData({ ...next });
      if (task != null && projectId !== '') {
        try {
          const r = await command<{ groups: Array<{ projectId: string; deliveries: NonNullable<typeof data>['deliveries'] }> }>('files.view', { scope: 'project', projectId });
          if (gen !== genRef.current) return;
          next.deliveries = (r.groups.find((g) => g.projectId === projectId)?.deliveries ?? []).filter((d) => d.taskId === task.id);
        } catch (e) { if (gen === genRef.current) next.delErr = (e as Error).message; }
      }
      if (gen === genRef.current) setData({ ...next });
    })();
    return () => { genRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, task?.id]);

  const openAtt = (att: { attachmentId: string; filename: string; kind: string }) => {
    registerAttachmentResource({
      attachmentId: att.attachmentId, filename: att.filename, kind: att.kind,
      audience: { kind: 'thread', projectId, roomId: thread?.roomId ?? '', threadId, tab: 'replies' },
      origin: conversationId,
    });
    onOpenResource?.(att.attachmentId, undefined, {
      target: { kind: 'thread', projectId, roomId: thread?.roomId ?? '', threadId, tab: 'replies' },
    });
  };

  if (data == null) {
    return <div className="msg-list"><div className="panel info">正在装载本串附件与交付…</div></div>;
  }
  const empty = data.attachments.length === 0 && data.deliveries.length === 0;
  if (empty && data.attErr == null && data.delErr == null) {
    return (
      <EmptyState
        icon="file-text"
        title={isDiscussion ? '还没有附件' : '还没有成果'}
        detail={isDiscussion ? '这条记录还没有携带附件。' : '成员的报告、附件与交付物会汇总在这里（按本线程的会话与任务聚合）。'}
      />
    );
  }
  return (
    <div className="msg-list">
      {data.attErr != null ? <div className="panel warning">附件列表读取失败：{data.attErr}（可切回回复再进重试）</div> : null}
      {data.delErr != null ? <div className="panel warning">交付列表读取失败：{data.delErr}</div> : null}

      {data.attachments.length > 0 ? (
        <>
          <div className="card tight" style={{ marginBottom: 10 }}>
            <div className="row tight" style={{ marginBottom: 6 }}>
              <Icon name="paperclip" size={13} className="faint" />
              <span className="strong" style={{ fontSize: 12 }}>附件</span>
              <span className="small faint">{data.attachments.length}</span>
            </div>
            <div className="msg-attach-row" style={{ marginTop: 0 }}>
              {data.attachments.map((a) => (
                <button
                  key={a.attachmentId}
                  className="msg-attach"
                  title={`打开 ${a.filename}，不改变原件`}
                  onClick={() => openAtt(a)}
                >
                  <Icon name="file-text" size={12} />
                  <span className="truncate">{a.filename}</span>
                  <span className="msg-attach-kind mono-sm">v{a.revision}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {(() => {
        if (isDiscussion) return null;
        if (data.deliveries.length === 0) {
          return <div className="small faint" style={{ padding: '4px 2px' }}>还没有任务成果。</div>;
        }
        return (
          <>
            {data.deliveries.map((d) => (
              <div key={d.deliveryId} className="card tight" data-zs-delivery-row={d.deliveryId}>
                <div className="row tight" style={{ marginBottom: 4 }}>
                  <Icon name="package" size={14} className="faint" />
                  <span className="strong truncate" style={{ fontSize: 12 }}>{d.title}</span>
                  <Tag tone="info">v{d.revision}</Tag>
                  <div className="spacer" />
                  <span className="small faint">{d.reviewedAt != null ? `已确认 ${relTime(d.reviewedAt)}` : '等你确认'}</span>
                </div>
                <div className="row tight">
                  <button
                    className="btn ghost sm"
                    title="打开成果；阅读后可在预览里保存原件"
                    onClick={() => {
                      // R68 §6 第三来源：登记 delivery 资源并开标签（与 ThreadPage 成果页同一通道）。
                      const target = { kind: 'thread' as const, projectId, roomId: thread?.roomId ?? '', threadId, tab: 'artifacts' as const };
                      const rid = registerDeliveryResource({
                        deliveryId: d.deliveryId, revision: d.revision, manifestHash: d.manifestHash,
                        conversationId, threadId, taskTitle: d.title, audience: 'room', roomId: thread?.roomId ?? '',
                        openedFrom: target,
                      });
                      openPreviewTab(rid, d.revision, { target });
                      recordWrite('preview.delivery', `打开交付文档 ${d.deliveryId.slice(0, 14)}… v${d.revision}（manifest ${d.manifestHash.slice(0, 8)}…）`);
                    }}
                  >打开/保存文件</button>
                  <button className="btn ghost sm" onClick={onReview}>确认或修改</button>
                </div>
                <details className="small faint"><summary>版本身份</summary>{d.deliveryId} · {d.manifestHash}</details>
              </div>
            ))}
          </>
        );
      })()}

      <div className="faint small">“保存文件”保存成果原件；“导出聊天”只导出对话记录。</div>
    </div>
  );
}

/* ---------------- 任务事实卡（ThreadOverview 内嵌——task.get 真实投影） ---------------- */

function ThreadTaskFacts({ threadId, task, formal }: { threadId: string; task?: Task; formal: TaskDetailsResult | null }) {
  const s = useStore((x) => x);
  const detail = (s as AppState & { threadTasks?: Record<string, { revision: number; stopGeneration: number; activeRun: { id: string; status: string } | null; lastStartupFailureMessage?: string | null }> }).threadTasks?.[threadId];
  const recentRun = formal?.runs.find((r) => r.id === formal.latestRunId);
  if (task == null) return null;
  return (
    <>
    <div className="card tight">
      <div className="section-title">任务当前事实</div>
      <div className="small">{recentRun != null ? `最近运行：${recentRun.status}` : formal != null ? '尚无运行' : detail?.activeRun != null ? `最近运行：${detail.activeRun.status}` : '正在读取运行事实'}</div>
      {detail?.lastStartupFailureMessage != null ? (
        <div className="panel warning" style={{ marginTop: 8 }}>最近一次启动失败：{detail.lastStartupFailureMessage}</div>
      ) : null}
      <div className="row tight" style={{ marginTop: 8 }}>
        <button
          className="btn ghost sm"
          title="刷新任务详情（绑定服务端当前事实）"
          onClick={() => void refreshThreadTask(threadId).catch((e: unknown) => toast(`刷新失败：${(e as Error).message}`, 'error'))}
        >刷新详情</button>
        <button
          className="btn ghost sm"
          title="复制本任务的正式定位链接（#task=<实体ID>——应用内深链，不是公网分享链接）"
          onClick={() => {
            const link = `#task=${task.id}`;
            void navigator.clipboard?.writeText(link).then(
              () => toast(`定位链接已复制：${link}`, 'success'),
              () => toast(`复制失败——定位链接：${link}`, 'error'),
            );
          }}
        >复制定位链接</button>
      </div>
      <details className="small faint"><summary>操作快照身份</summary>任务 revision {detail?.revision ?? task.revision} · 停止代次 {detail?.stopGeneration ?? '—'} · 最近 run {detail?.activeRun?.id ?? '—'}</details>
    </div>
    {formal ? <TaskExtraFacts detail={formal} /> : null}
    </>
  );
}

/* ---------------- 运行事实（详情分组——activeRun 真实投影） ---------------- */

function ThreadRunFacts({ detail, onSelectRun, onRetryFailed, retryBusy }: { detail: TaskDetailsResult | null; onSelectRun: (runId: string) => void; onRetryFailed: () => void; retryBusy: boolean }) {
  return detail ? <RunExtraFacts detail={detail} onSelectRun={onSelectRun} onRetryFailed={onRetryFailed} retryBusy={retryBusy} /> : <div className="card tight">运行详情尚未读到；可刷新重试。</div>;
}

/* ---------------- 交付与验收（详情分组——正式验收/返工两步走，冻结三重身份） ---------------- */

function ThreadDeliveryPanel({ threadId, task }: { threadId: string; task: Task }) {
  const s = useStore((x) => x);
  const detail = (s as AppState & { threadTasks?: Record<string, { pendingDelivery: { id: string; revision: number; manifestHash: string } | null; reworkPending: { deliveryId: string; deliveryRevision: number; manifestHash: string; sourceRunId: string; note: string | null; queued: boolean } | null }> }).threadTasks?.[threadId];
  const [reviewBox, setReviewBox] = useState<{ mode: 'accept' | 'rework'; snapshot: ReviewSnapshot; note: string } | null>(null);
  const [busyRework, setBusyRework] = useState(false);
  useEffect(() => { setReviewBox(null); }, [threadId, detail?.pendingDelivery?.id]);
  const pending = detail?.pendingDelivery ?? null;
  const stale = reviewBox != null && pending != null
    && (pending.id !== reviewBox.snapshot.deliveryId
      || pending.revision !== reviewBox.snapshot.deliveryRevision
      || pending.manifestHash !== reviewBox.snapshot.manifestHash);
  const openReview = (mode: 'accept' | 'rework') => {
    if (pending == null) return;
    setReviewBox({ mode, snapshot: { taskId: task.id, deliveryId: pending.id, deliveryRevision: pending.revision, manifestHash: pending.manifestHash }, note: '' });
  };
  const submitReview = async () => {
    if (reviewBox == null) return;
    if (reviewBox.mode === 'rework' && reviewBox.note.trim().length === 0) {
      toast('请写下希望修改的地方', 'warn');
      return;
    }
    const r = await submitTaskReview(reviewBox.snapshot, reviewBox.mode === 'accept' ? 'accept' : 'changes_requested', reviewBox.mode === 'rework' ? reviewBox.note.trim() : undefined, threadId);
    if (r.ok) { toast(reviewBox.mode === 'accept' ? '已确认完成' : '修改意见已保存，下一步可以开始修改', 'success'); setReviewBox(null); void loadThread(threadId); }
    else toast(`提交失败：${r.error}——意见已保留；如果成果已更新，请对新版本重新操作`, 'error');
  };
  const rp = detail?.reworkPending ?? null;
  return (
    <div className="msg-list">
      <div className="card tight">
        <div className="section-title">确认成果与修改</div>
        {pending == null ? (
          <div className="small faint" style={{ marginTop: 4 }}>当前没有等你确认的成果。</div>
        ) : (
          <>
            <div className="small faint" style={{ marginTop: 4 }}>
              v{pending.revision} 等你确认。确认或修改只针对这个版本。
            </div>
            <div className="row tight" style={{ marginTop: 8 }}>
              <button className="btn sm primary" disabled={reviewBox != null} onClick={() => openReview('accept')} title="确认这份成果已经满足要求">确认完成</button>
              <button className="btn sm" disabled={reviewBox != null} onClick={() => openReview('rework')} title="写下修改意见，再让 AI 修改">按这些意见修改</button>
            </div>
            {reviewBox != null ? (
              <div style={{ marginTop: 8 }}>
                {stale ? (
                  <div className="panel warning">
                    交付已更新（打开时冻结的是 v{reviewBox.snapshot.deliveryRevision}，当前为 v{pending.revision}）——本框已作废，请对新版本重新操作。
                    <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => setReviewBox(null)}>关闭</button>
                  </div>
                ) : (
                  <>
                    {reviewBox.mode === 'rework' ? (
                      <textarea
                        className="textarea"
                        style={{ width: '100%', minHeight: 64 }}
                        placeholder="写下希望 AI 修改的地方"
                        value={reviewBox.note}
                        onChange={(e) => setReviewBox((b) => b == null ? b : { ...b, note: e.target.value })}
                      />
                    ) : <div className="faint small">将确认成果 v{reviewBox.snapshot.deliveryRevision} 完成。<details className="faint"><summary>版本身份</summary>{reviewBox.snapshot.deliveryId} · {reviewBox.snapshot.manifestHash}</details></div>}
                    <div className="row tight" style={{ marginTop: 6 }}>
                      <button className="btn sm primary" onClick={() => void submitReview()}>{reviewBox.mode === 'accept' ? '确认完成' : '保存修改意见'}</button>
                      <button className="btn ghost sm" onClick={() => setReviewBox(null)}>取消</button>
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </>
        )}
        {rp != null ? (
          <div className="row tight wrap" style={{ marginTop: 8 }} data-zs-thread-rework="1" data-zs-thread-rework-state={rp.queued ? 'executing' : 'recorded'}>
            <Icon name="refresh" size={13} />
            <strong>{rp.queued ? '正在按你的意见修改' : '修改意见已保存，尚未开始'}</strong>
            <Tag tone="warning">v{rp.deliveryRevision} 待修改</Tag>
            <span style={{ flex: 1 }} />
            {rp.queued ? (
              <span className="faint small">完成后会出现新的待确认版本</span>
            ) : (
              <button
                className="btn sm"
                disabled={busyRework}
                title={`执行返工（task.executeRework——同任务新执行；绑定 v${rp.deliveryRevision} 完整身份）`}
                onClick={() => {
                  const snapshot = { taskId: task.id, deliveryId: rp.deliveryId, deliveryRevision: rp.deliveryRevision, manifestHash: rp.manifestHash, sourceRunId: rp.sourceRunId };
                  setBusyRework(true);
                  void (async () => {
                    try {
                      const r = await executeTaskRework(snapshot, threadId);
                      if (!r.ok) { toast(`执行返工被拒：${r.error}——已刷新为当前返工事实`, 'error'); void loadThread(threadId); return; }
                      toast('返工执行已入队（完成后交付升级为新待验收版本）', 'success');
                      void loadThread(threadId);
                    } finally { setBusyRework(false); }
                  })();
                }}
              >开始修改</button>
            )}
            {rp.note != null ? <div className="faint small" style={{ width: '100%' }}>验收意见：{rp.note}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- 串内活动 tab ---------------- */

function ThreadActivity({ threadId, detail, onChangeTab }: { threadId: string; detail: TaskDetailsResult | null; onChangeTab: (t: ThreadTabLocal) => void }) {
  const s = useStore((x) => x);
  /**
   * 普通过程说明（路由推导、程序校验通过、派发规则、阶段推进）。
   *
   * 它们被移出回复区域是为了减少常驻信息，**不是删除事件记录**（§4）：
   * 消息本体、threadMessageSeq 与创建时间都原样保留，这里按时间如实列出。
   */
  const notes = processNotesOfThread(s, threadId);

  return (
    <div className="msg-list">
      <div className="panel">
        <div className="panel-title"><Icon name="terminal" size={13} /> 活动与进展</div>
        正式任务事件按时间列在下方；工具事件来自 worker 审计，用量见运行详情。
      </div>

      {/* 普通过程说明：正常信息不占对话区域，但记录一条都不少 */}
      {notes.length > 0 ? (
        <>
          <div className="section-title">过程说明<span className="count">{notes.length}</span></div>
          {notes.map((m) => (
            <div key={m.id} className="card tight">
              <div className="row tight wrap">
                <Icon name="info" size={13} className="faint" />
                <span className="strong" style={{ fontSize: 12 }}>{m.payload?.system?.title ?? m.body}</span>
                <div className="spacer" />
                <span className="small faint">{relTime(m.createdAt)}</span>
              </div>
              {m.payload?.system?.detail ? (
                <div className="small faint" style={{ marginTop: 4, lineHeight: 1.65 }}>{m.payload.system.detail}</div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}

      {detail ? <TaskEventFacts detail={detail} /> : <div className="card tight faint small">正式活动尚未读到；可刷新重试。</div>}
      {detail?.runs.some((r) => r.turns.length > 0) ? <button className="btn sm" onClick={() => onChangeTab('run')}>查看执行轮次与用量 <Icon name="chevron-right" size={11} /></button> : null}
    </div>
  );
}

/* ============================================================
   房间任务看板（§25.5：既有 Task 表的视图）
   ============================================================ */

const BOARD_GROUPS: { label: string; statuses: Task['status'][] }[] = [
  { label: '待开始', statuses: ['OPEN'] },
  { label: '执行中', statuses: ['ACTIVE'] },
  { label: '等我处理', statuses: ['WAITING_USER'] },
  { label: '阻塞', statuses: ['BLOCKED'] },
  { label: '待审阅', statuses: ['REVIEW'] },
  { label: '已完成', statuses: ['DONE'] },
  { label: '已取消', statuses: ['CANCELLED'] },
];

function RoomTasks({ roomId }: { roomId: string }) {
  const s = useStore((x) => x);
  const tasks = s.tasks.filter((t) => t.roomId === roomId && !t.parentTaskId);

  return (
    <div className="page" style={{ paddingTop: 14 }}>
      <div className="panel info" style={{ marginBottom: 14 }}>
        看板是既有 Task 表的视图，点击任意一项打开同一根消息与回复串。
        变更负责人或恢复取消任务走状态机与审计，不通过拖拽直接修改执行中的会话归属；首版允许按钮改状态，拖拽后置。
      </div>
      {BOARD_GROUPS.map((g) => {
        const items = tasks.filter((t) => g.statuses.includes(t.status));
        if (items.length === 0) return null;
        return (
          <div className="section" key={g.label}>
            <div className="section-title">{g.label}<span className="count">{items.length}</span></div>
            <div className="grid grid-2">
              {items.map((t) => {
                const run = s.runs.find((r) => r.taskId === t.id);
                const subs = childTasksOf(s, t.id);
                return (
                  <div
                    key={t.id}
                    className="card"
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/project/${t.projectId}/room/${t.roomId}?thread=${t.conversationThreadId}&tab=task`)}
                  >
                    <div className="row tight wrap">
                      <span className="root-task-no">#{t.roomTaskNumber}</span>
                      <TaskStatusTag status={t.status} />
                      {run ? <Tag plain icon="git-commit">{run.mode}</Tag> : null}
                      <div className="spacer" />
                      {subs.length > 0 ? <Tag plain icon="layers">{subs.length} 子任务</Tag> : null}
                    </div>
                    <div className="strong" style={{ marginTop: 6, fontSize: 12.5 }}>{t.title}</div>
                    <div className="small muted clamp-2" style={{ marginTop: 3 }}>{t.objective}</div>
                    <div className="row tight wrap small faint" style={{ marginTop: 8 }}>
                      <Tag plain icon="user">{memberLabel(byId(s.members, t.ownerMemberId))}</Tag>
                      <Tag plain icon={t.reviewPolicy === 'user_review' ? 'eye' : 'check-circle'}>
                        {t.reviewPolicy === 'user_review' ? '代码人工审阅' : '报告自动交付'}
                      </Tag>
                      <span>rev {t.revision}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      {tasks.length === 0 ? (
        <EmptyState icon="list" title="本房间还没有任务" detail="在对话池发布一条任务后，看板会按状态自动分组。" />
      ) : null}
    </div>
  );
}

/* ============================================================
   Files tab（§25.5：只集合本房间的附件与成果，不是磁盘目录）
   ============================================================ */

function RoomFiles({
  roomId, onOpenResource,
}: {
  roomId: string;
  /** UX-PREVIEW-01：从房间文件集合打开共享预览（保留房间作为来源上下文） */
  onOpenResource?: (resourceId: string, revision?: number, from?: ContextLocation) => void;
}) {
  const s = useStore((x) => x);
  const [commentOpen, setCommentOpen] = useState(false);
  const threads = s.threads.filter((t) => t.roomId === roomId).map((t) => t.id);
  const arts = s.artifacts.filter((a) => threads.includes(a.threadId));
  const changes = s.changeSets.filter((c) => s.tasks.some((t) => t.id === c.taskId && t.roomId === roomId));

  /** 本房间的资源（附件 + 成果对应项），统一在共享预览打开 */
  const roomResources = s.resources.filter(
    (r) => r.audience.kind === 'room' && r.audience.roomId === roomId,
  );

  return (
    <div className="page" style={{ paddingTop: 14 }}>
      <div className="panel info" style={{ marginBottom: 14 }}>
        这里汇总本房间的附件和已提交成果。工作区文件改动与 Git 状态分别在侧栏对应页面查看。
      </div>

      {/* 决策 31 / 33（M3 批次）：附件七类格式与文件选区评论 */}
      <div className="card tight" style={{ marginBottom: 14 }}>
        <div className="row tight wrap">
          <Icon name="paperclip" size={13} className="faint" />
          <span className="strong" style={{ fontSize: 12 }}>支持保存与预览的附件格式</span>
          <Tag plain data-batch="M3">M3 批次</Tag>
        </div>
        <div className="row tight wrap" style={{ marginTop: 7 }}>
          {['文本 / 代码', '图片', 'PDF', 'Word', 'Excel', 'PowerPoint', 'CSV'].map((t) => (
            <Tag key={t} plain>{t}</Tag>
          ))}
        </div>
        <details className="small faint" style={{ marginTop: 8 }}>
          <summary>查看格式与安全说明</summary>
          <div style={{ lineHeight: 1.65, marginTop: 6 }}>
            文件可保存和预览；成员能否解析取决于当前 AI 配置。系统不会执行文件内脚本，也不会把整个来源目录加入权限。
          </div>
        </details>
        <div className="row tight wrap" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => setCommentOpen(true)}>
            <Icon name="message-square" size={12} /> 文件选区评论（决策 33）
          </button>
          <span className="small faint">
            以 artifactId/version/hash 与文本、行范围锚定，评论在原任务串内显示；文件更新后旧评论标为旧版，不静默漂移
          </span>
        </div>
      </div>

      {/* 本房间可预览的资源（含**无任务归属**的普通附件，§2.2） */}
      {roomResources.length > 0 ? (
        <>
          <div className="section-title">
            房间文件<span className="count">{roomResources.length}</span>
          </div>
          <div className="grid grid-2" style={{ marginBottom: 18 }}>
            {roomResources.map((r) => {
              const latest = r.revisions.reduce((m, x) => Math.max(m, x.revision), 1);
              return (
                <button
                  key={r.id}
                  className="card tight"
                  style={{ cursor: 'pointer', textAlign: 'left' }}
                  title={`在右侧共享预览打开 ${r.title}`}
                  onClick={() => onOpenResource?.(r.id, latest, {
                    target: { kind: 'room', projectId: r.projectId, roomId, view: 'files' },
                  })}
                >
                  <div className="row tight">
                    <Icon name="file-text" size={14} className="faint" />
                    <span className="strong truncate" style={{ fontSize: 12 }}>{r.title}</span>
                    <div className="spacer" />
                    {r.origin.kind === 'message' ? (
                      <Tag plain icon="message-square">消息附件</Tag>
                    ) : (
                      <Tag plain icon="layers">成果</Tag>
                    )}
                  </div>
                  <div className="row tight wrap small faint" style={{ marginTop: 5 }}>
                    <span className="mono-sm">{r.relativePath ?? r.mimeType}</span>
                    <span>·</span>
                    <span>v{latest}</span>
                    {!r.mutable ? <span>· 固定版本</span> : <span>· 工作区当前</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      ) : null}

      <div className="section-title">成果与报告<span className="count">{arts.length}</span></div>
      {arts.length === 0 ? (
        <div className="small faint">还没有成果。</div>
      ) : (
        <div className="grid grid-2">
          {arts.map((a) => (
            <div key={a.id} className="card tight" style={{ cursor: 'pointer' }} onClick={() => navigate(`/artifact/${a.id}`)}>
              <div className="row tight">
                <Icon name="file-text" size={14} className="faint" />
                <span className="strong truncate" style={{ fontSize: 12 }}>{a.title}</span>
              </div>
              <div className="row tight wrap small faint" style={{ marginTop: 5 }}>
                <Tag plain icon="user">{memberLabel(byId(s.members, a.authorId))}</Tag>
                <span>{formatBytes(a.sizeBytes)}</span>
                <span className="mono-sm">{a.hash}</span>
              </div>
              <div className="row tight wrap" style={{ marginTop: 6 }}>
                <Tag plain>{a.mimeType === 'text/markdown' ? 'Markdown' : '文本'}</Tag>
                <button
                  className="btn ghost sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCommentOpen(true);
                  }}
                >
                  <Icon name="message-square" size={11} /> 评论
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="section-title" style={{ marginTop: 20 }}>改动集<span className="count">{changes.length}</span></div>
      {changes.map((c) => (
        <div key={c.id} className="card tight" style={{ marginBottom: 8 }}>
          <div className="row tight wrap">
            <Icon name="diff" size={14} className="faint" />
            <span className="strong" style={{ fontSize: 12 }}>
              {s.tasks.find((t) => t.id === c.taskId)?.title ?? c.taskId}
            </span>
            <Tag
              tone={c.applicationStatus === 'reverted' ? 'neutral' : c.applicationStatus === 'applied' ? 'success' : 'warning'}
              icon={c.applicationStatus === 'reverted' ? 'corner-up-left' : c.applicationStatus === 'applied' ? 'check-circle' : 'eye'}
              title="文件应用状态；人工验收在任务交付里"
            >
              {c.applicationStatus === 'reverted' ? '已还原' : c.applicationStatus === 'applied' ? '已应用' : c.applicationStatus === 'partial' ? '部分应用' : '未应用'}
            </Tag>
            <div className="spacer" />
            <button className="btn ghost sm" onClick={() => navigate(`/project/${s.activeProjectId}/changes`)}>
              查看 diff
            </button>
          </div>
          <div className="small faint" style={{ marginTop: 4 }}>
            {c.files.length} 个文件 · after {c.afterRef}
          </div>
        </div>
      ))}

      {/* 文件选区评论（决策 33，M3 批次）：锚点类型与"旧版不漂移"口径 */}
      {commentOpen ? (
        <Modal
          size="md"
          title="文件选区评论"
          subtitle="决策 33 · M3 批次 · 以 artifactId/version/hash 与文本或行范围锚定"
          onClose={() => setCommentOpen(false)}
          footer={
            <>
              <span className="small faint">评论是文件线程的普通回复，有 re: 引用可回精确位置</span>
              <div className="spacer" />
              <button className="btn" onClick={() => setCommentOpen(false)}>关闭</button>
              <button
                className="btn"
                disabled
                title="选区评论（决策 33）的锚点写入命令尚未接入本包——文件级评论经预览面板「评论此文件」走真实仅记录提交"
              >
                提交评论（未接入）
              </button>
            </>
          }
        >
          <div className="panel info" style={{ marginBottom: 12 }}>
            Raft 目前不支持 PDF/图片的定位评论；众说也如实照此说明，不把不支持的媒体写成已支持。
          </div>
          <div className="field">
            <label className="field-label">支持的五类锚点</label>
            <div className="col" style={{ gap: 6 }}>
              {[
                ['Markdown 段落 / 章节', '按标题与段落锚定'],
                ['文本与代码单/多行', '按行号范围锚定'],
                ['CSV 单/多行', '按行锚定'],
                ['HTML 渲染区域', '按元素锚定'],
                ['视频时间点', '按时间戳锚定'],
              ].map(([t, d]) => (
                <div key={t} className="row tight">
                  <Icon name="check" size={12} style={{ color: 'var(--success)', marginTop: 4 }} />
                  <span className="small">
                    <span className="strong">{t}</span>
                    <span className="faint"> · {d}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="field-label">评论内容</label>
            <textarea
              className="textarea"
              rows={3}
              defaultValue="这里的两处 import 应该走 contracts，不要直接引 persistence。"
            />
            <div className="field-hint">
              需要频道成员身份；版本关系记录为 artifactId + version + hash，文件更新后旧评论标记为旧版。
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/* ============================================================
   房间设置抽屉
   ============================================================ */

function RoomSettings({ roomId, initialSection='general', onClose }: { roomId: string; initialSection?:'general'|'members'|'archive'; onClose: () => void }) {
  const memberSection=useRef<HTMLDivElement>(null),archiveSection=useRef<HTMLDivElement>(null);
  useEffect(()=>{const target=initialSection==='members'?memberSection.current:initialSection==='archive'?archiveSection.current:null;target?.scrollIntoView({block:'start'});target?.focus({preventScroll:true});},[roomId,initialSection]);
  const s = useStore((x) => x);
  const room = roomOf(s, roomId)!;
  const [saveBusy, setSaveBusy] = useState(false);
  const [name, setName] = useState(room.name);
  const [desc, setDesc] = useState(room.description ?? '');
  const [coordinator, setCoordinator] = useState(room.coordinatorMemberId);
  const members = s.members.filter((m) => m.projectId === room.projectId);
  const roomMembers = members.filter((m) => room.memberIds.includes(m.id));
  const projectMembersNotInRoom = members.filter((m) => !room.memberIds.includes(m.id));

  const activeTasks = s.tasks.filter(
    (t) => t.roomId === roomId && ['ACTIVE', 'WAITING_USER', 'BLOCKED'].includes(t.status),
  );

  return (
    <Modal
      size="md"
      title="房间设置"
      subtitle={room.name}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn danger"
            disabled={saveBusy}
            title="归档=只读保留历史（room.archive；有未结束任务时服务端拒绝，给出去停止的入口）"
            onClick={() => {
              setSaveBusy(true);
              void roomArchiveReal(room.id, room.revision, 'archive').then((r) => {
                setSaveBusy(false);
                if (r.ok) { toast('房间已归档（历史保留·只读）——可在房间 ⋯ 菜单取消归档', 'success'); onClose(); }
                else toast(`归档被拒：${r.error}`, 'error');
              });
            }}
          >
            <Icon name="archive" size={12} /> 归档房间
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={saveBusy || !name.trim() || (name === room.name && desc === (room.description ?? '') && coordinator === room.coordinatorMemberId)}
            title="保存（room.update 乐观锁：名称/描述/协调者——协调者须为房间成员）"
            onClick={() => {
              setSaveBusy(true);
              void updateRoomReal(room.id, room.revision, {
                name: name.trim(),
                description: desc,
                ...(coordinator !== room.coordinatorMemberId ? { coordinatorMemberId: coordinator } : {}),
              }).then((r) => {
                setSaveBusy(false);
                if (r.ok) { toast('房间设置已保存（回读一致；revision 已推进）', 'success'); onClose(); }
                else { toast(`保存失败：${r.error}（输入已保留）`, 'error'); }
              });
            }}
          >
            保存
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">房间名称</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label">描述</label>
        <textarea className="textarea" value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} />
      </div>
      <div className="field">
        <label className="field-label">协调者</label>
        <select className="select" value={coordinator} onChange={(e) => setCoordinator(e.target.value)}>
          {roomMembers.map((m) => (
            <option key={m.id} value={m.id}>{memberLabel(m)}</option>
          ))}
        </select>
        <div className="field-hint">
          协调者是房间级字段（rooms.coordinator_member_id）。不写 @ 的任务由它接单，它可以自己直接完成，
          也可以提交结构化分工计划。新建房间沿用项目当前默认协调者。
        </div>
      </div>

      {/* ---------- 房间成员管理（room.members.add / remove，§15.2） ---------- */}
      <div className="divider" />
      <div ref={memberSection} data-zs-room-section="members" tabIndex={-1} className="section-title" style={{ marginTop: 0 }}>
        房间成员<span className="count">{roomMembers.length}</span>
      </div>
      <div className="field-hint" style={{ marginBottom: 10 }}>
        房间成员决定这个房间可见与可派发的范围。与「线程跟进名单」不是一回事：
        跟进名单控制的是某个任务要不要自动唤醒谁。
      </div>

      <div className="col" style={{ gap: 8 }}>
        {roomMembers.map((m) => {
          const isCoord = m.id === room.coordinatorMemberId;
          return (
            <div key={m.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span className="row tight" style={{ minWidth: 0 }}>
                <Avatar
                  name={m.displayName}
                  ordinal={m.ordinal}
                  color={memberColor(m.id, m.ordinal)}
                  size={22}
                  state={m.workState}
                  stateTitle={m.workStateReason}
                  subject={`member:${m.id}`}
                />
                <span style={{ minWidth: 0 }}>
                  <span className="row tight">
                    <span className="strong">{memberLabel(m)}</span>
                    {isCoord ? <Tag tone="accent" icon="star">协调者</Tag> : null}
                  </span>
                  <span className="small faint" title={m.model?`完整模型 ID：${m.model}`:undefined}>{[m.model?runtimeModelDisplayName({id:m.model,label:m.model}):'',m.workStateReason].map((part)=>part?.trim()).filter(Boolean).join(' · ')||(m.enabled?'可用':'已停用')}</span>
                </span>
              </span>
              <button
                className="btn sm"
                disabled={saveBusy || isCoord}
                title={isCoord ? '协调者不能移出——先在上方更换协调者' : '移出本房间（room.members.set；新增/移出只对后续新任务生效——运行中研讨名单冻结）'}
                onClick={() => {
                  setSaveBusy(true);
                  void roomMembersSetReal(room.id, m.id, 'remove').then((r) => {
                    setSaveBusy(false);
                    if (!r.ok) toast(`移出失败：${r.error}`, 'error');
                  });
                }}
              >
                移出
              </button>
            </div>
          );
        })}
      </div>

      {projectMembersNotInRoom.length > 0 ? (
        <>
          <div className="section-title" style={{ marginTop: 16 }}>
            可加入的项目成员<span className="count">{projectMembersNotInRoom.length}</span>
          </div>
          <div className="col" style={{ gap: 8 }}>
            {projectMembersNotInRoom.map((m) => (
              <div key={m.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span className="row tight">
                  <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} state={m.workState} stateTitle={m.workStateReason} subject={`member:${m.id}`} />
                  <span className="strong">{memberLabel(m)}</span>
                </span>
                <button
                  className="btn sm primary"
                  disabled={saveBusy}
                  title="加入本房间（room.members.set——新增只对后续新任务生效，正在运行的研讨沿用冻结名单）"
                  onClick={() => {
                    setSaveBusy(true);
                    void roomMembersSetReal(room.id, m.id, 'add').then((r) => {
                      setSaveBusy(false);
                      if (!r.ok) toast(`加入失败：${r.error}`, 'error');
                    });
                  }}
                >
                  加入
                </button>
              </div>
            ))}
          </div>
          <div className="panel" style={{ marginTop: 10 }}>
            任务中新增房间成员不会自动加入正在运行的研讨：新房间成员对后续新任务生效，
            正在跑的研讨沿用其冻结名单。
          </div>
        </>
      ) : null}

      <div className="divider" />
      <div ref={archiveSection} data-zs-room-section="archive" tabIndex={-1}/>
      {activeTasks.length > 0 ? (
        <div className="panel danger" style={{ marginBottom: 12 }}>
          <div className="panel-title"><Icon name="octagon" size={13} /> 当前有 {activeTasks.length} 个活跃任务，不能归档</div>
          归档前会检查所有根任务、子任务与待派发项。存在活跃工作时先阻止归档，并在这里给出停止入口。
          <div className="panel-actions">
            {activeTasks.map((t) => (
              <button
                key={t.id}
                className="btn sm danger"
                title="打开该任务线程，在输入区/详情执行停止（task.stop 三重绑定）"
                onClick={() => navigate(`/project/${s.activeProjectId}/room/${t.roomId}?thread=${t.conversationThreadId}&tab=task`)}
              >
                停止 #{t.roomTaskNumber}（去线程）
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="panel warning">
        <div className="panel-title"><Icon name="alert-triangle" size={13} /> 归档后会发生什么</div>
        房间变只读、不创建新任务、不被提醒唤醒；迟到的运行事件只进入审计与恢复记录。
        取消归档后可以继续，但不会把旧的待派发任务全部重放。已归档房间的成员与历史消息都保留。
      </div>
    </Modal>
  );
}

/* ============================================================
   F 房间切换辅助（供页面其它位置创建房间）
   ============================================================ */

/**
 * 「新建对话池 / 房间」弹窗（第十七批：抽出来给侧栏项目行的 `+` 复用）。
 *
 * 用户要求侧栏项目行的 `+` "直接打开添加对话池流程、绑定该项目、不重复询问项目归属"，
 * 且要"复用现有创建流程，保留输入校验、成功反馈和合理的创建后落点" ——
 * 所以这里把原来只藏在项目页页头的弹窗抽成组件：同一个表单、同一个 createRoom、
 * 同样的创建后跳转（进新房间），只是入口多了侧栏一个。
 */
export function CreateRoomModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const s = useStore((x) => x);
  const [name, setName] = useState('');
  /** 在途锁：创建期间按钮禁用——连点恰一次；失败保留输入（不 onClose 清掉）。 */
  const [busy, setBusy] = useState(false);
  const project = s.projects.find((p) => p.id === projectId);
  const members = s.members.filter((m) => m.projectId === projectId);

  return (
    <Modal
      size="sm"
      title={`新建对话池 · ${project?.displayName ?? '项目'}`}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={() => {
              if (busy) return;
              setBusy(true);
              void createRoomReal(projectId, name.trim()).then((id) => {
                setBusy(false);
                if (id != null) { onClose(); navigate(`/project/${projectId}/room/${id}`); }
                // 失败：toast 已由 createRoomReal 给出——弹窗与输入保留可改可重试
              });
            }}
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">房间名称</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：性能专项" />
        <div className="field-hint">
          将建在项目「{project?.displayName ?? projectId}」下；协调者沿用项目当前默认协调者（
          {memberLabel(members[0])}），成员默认加入项目现有成员。
        </div>
      </div>
    </Modal>
  );
}

export function NewRoomButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* 「新建房间」是项目页页头的主创建动作（同区另一枚「文件与改动」是导航，
          不是创建）。此前用次按钮样式，导致**项目页没有任何 --grad 主按钮**，
          与规范 §5.8「主按钮给重操作」不符。同一操作区仍只有一个 --grad。
          第十七批：弹窗抽成 `CreateRoomModal`，与侧栏项目行的 `+` 共用同一套流程。 */}
      <button className="btn primary sm" onClick={() => setOpen(true)}>
        <Icon name="plus" size={12} /> 新建房间
      </button>
      {open ? <CreateRoomModal projectId={projectId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
