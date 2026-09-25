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
import { Icon } from '../components/Icon';
import { MessageView } from '../components/MessageView';
import { DeliveryPanel } from '../components/DeliveryPanel';
import { PreviewPane, PreviewReopenButton } from '../components/PreviewPane';
import { Avatar, EmptyState, ErrorState, Menu, MenuItem, Modal, PanelNavButton, RunStatusTag, Tag, TaskStatusTag, anchorFromElement, memberColor } from '../components/ui';
import { useStore, toast, setState, recordLocalOnly } from '../data/store';
import {
  anchorOf, artifactsOfThread, byId, childTasksOf, coordinatorOfRoom,
  firstUnreadSeq, lockOfProject, memberLabel, processNotesOfThread, replyCount,
  replyPreview, replyThreadMessages, roomOf, rootMessages, roomUnread,
  taskOfThread, threadOf, unreadCount,
} from '../data/selectors';
import {
  allowMissing, archiveRoom, createRoom, markThreadRead, reactMessage, removeFollower,
  respondApproval, retryTask, saveMessage, steerSubtask,
  submitMessage, toggleFollow, toggleMute, updateRoom, stopTask, unarchiveRoom,
} from '../data/actions';
import { addRoomMember, removeRoomMember } from '../data/actions';import { formatBytes, formatDuration, fullTime, relTime, routeModeCopy, stageLabel } from '../lib/format';
import { navigate } from '../lib/router';
import { TaskDetailPage, DeliberationPage, RunDetailPage } from './pages-task';
import { exportArtifact } from '../data/actions';
import { type ThreadTabKey } from '../lib/threadNav';
import {
  type DetailsSection, type ThreadView,
  detailsSectionOfTab, tabFor, viewOfTab,
} from '../lib/threadNav';
import type { AppState, ContextLocation, Message, Task, WorkflowRun } from '../data/types';
/* ---------- UX-PREVIEW-01：共享预览（§17.9） ---------- */
import { attachmentsOfMessage, audienceAllows } from '../lib/resource';
import { contextTargetOf, hidePreview, noteContextChanged, openPreview, setNavAutoHidden, setPreviewContextSide } from '../data/actions-preview';
import { resolveLayout, SIDEBAR_WIDTH } from '../lib/layout';
import { useElementWidth } from '../lib/useElementWidth';

/** 窄窗口判定：右栏改为覆盖式全屏页（§17.1） */
function useNarrow(breakpoint = 1280) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return narrow;
}

const THREAD_MIN = 380;
/** 中间主池的最小可读宽度：回复串再宽也不能把主池挤没 */
const MAIN_MIN = 420;
/** 左侧栏宽度（与 CSS `.sidebar { width: 246px }` 保持一致） */
const SIDEBAR_W = 246;

/**
 * 当前窗口允许的回复串最大宽度。
 *
 * 必须扣掉左侧栏：.app-body 里同时装着 sidebar + 主池 + 回复串。
 * 之前只按 window.innerWidth 算（或去读 DOM 宽度），结果 1480 窗口上给出 918px，
 * 主池只剩 316px；更早还存过 1018px，主池直接被挤成 216px。
 *
 * 这里改成纯算术、不依赖 DOM 是否已挂载，保证首帧就是正确值。
 */
function threadMaxWidth() {
  const w = typeof window === 'undefined' ? 1600 : window.innerWidth;
  const sidebarOpen = typeof document !== 'undefined' ? !!document.querySelector('.sidebar') : true;
  const avail = w - (sidebarOpen ? SIDEBAR_W : 0);
  return Math.max(THREAD_MIN, Math.min(1100, avail - MAIN_MIN));
}

/**
 * 回复串宽度：可拖动。**不跨会话记忆**（用户要求）。
 *
 * 原实现把宽度写进 localStorage 并在下次打开时读回。实测问题：
 * 开关附件预览时回复串会在"记忆宽度"与"布局解析宽度"之间跳一次
 * （620 → 517），观感很突兀；若记忆值还是在别的窗口尺寸下存的，跳得更狠。
 * 现在只保留**本次会话内的拖动结果**；打开预览时保持回复串**当前**宽度
 * （见 twoRegion 的宽度计算），开关附件时对话侧不再移动。
 */
function useThreadWidth() {
  const [width, setWidth] = useState(620);

  // 窗口尺寸变化或侧栏折叠时，把宽度重新收敛到合法区间
  useEffect(() => {
    const onResize = () => setWidth((w) => Math.min(Math.max(w, THREAD_MIN), threadMaxWidth()));
    window.addEventListener('resize', onResize);
    // 侧栏折叠会改变可用宽度；用 rAF 等布局落定后再收敛
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(onResize);
    });
    const body = document.querySelector('.app-body');
    if (body) ro.observe(body);
    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
    };
  }, []);

  const dragRef = useRef<{ startX: number; startWidth: number; invert: boolean } | null>(null);
  /**
   * 分隔条方向是否要反过来。由调用方每帧写入（见 RoomPage 里 `twoRegion` 之后）。
   *
   * 分隔条在两种布局里的**位置不同**，所以拖拽语义必须相反：
   *  · L2：分隔条在「主池 | 回复串」之间 → 向右拖 = 回复串变窄
   *  · L4：分隔条在回复串**左缘**（它左边是导航）→ 向右拖 = 回复串变窄，
   *        而 L4 里回复串宽度 = 总宽 − 右列宽，所以等价于 `width` **变大**
   * 用错方向会让"往右拖反而变宽"。
   */
  const invertRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: width, invert: invertRef.current };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    // 向右拖 = 回复串变窄（L4 下由 invert 取反，见 invertRef 注释）
    const next = Math.min(threadMaxWidth(), Math.max(THREAD_MIN, d.startWidth + (d.invert ? dx : -dx)));
    setWidth(next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
    // 不再写 localStorage：宽度只保留在本次会话内（用户要求"不用记忆"）
  };

  /** 双击分隔条：恢复默认宽度 */
  const reset = () => {
    setWidth(620);
  };

  return { width, onPointerDown, onPointerMove, onPointerUp, reset, invertRef };
}

export function RoomPage({
  roomId,
  threadId,
  highlightMessageId,
  tab,
  artifactId,
}: {
  roomId: string;
  threadId?: string;
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
  /** 房间「⋯」菜单锚点（房间设置/成员/归档统一入口） */
  const [roomMenuAnchor, setRoomMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  // 所有 Hook 必须在任何 early return 之前调用（rules-of-hooks）。
  // 之前 useNarrow/useThreadWidth 放在 if (!room) 之后：现在不炸只是因为
  // room 不会从"有"变"无"，但任何"房间被删后组件仍挂载"的路径都会崩。
  const narrow = useNarrow();
  const threadWidth = useThreadWidth();

  /* ---------- UX-PREVIEW-01：共享预览（§17.9） ----------
     用**容器宽度**而不是 window.innerWidth 决定布局（§5.2 第 4 条）。
     测量对象选 `.app-body`：它的宽度由视口决定，**不随"导航是否收起"变化**，
     因此不会与"要不要收起导航"这个布局决定形成反馈环。 */
  const workspace = useElementWidth<HTMLDivElement>('.app-body');
  const previewTabs = useStore((x) => x.preview.tabs);
  const previewHidden = useStore((x) => x.preview.hidden);

  const context = useMemo(
    () => contextTargetOf(s.activeProjectId, { roomId, threadId, roomView: roomTab }),
    [s.activeProjectId, roomId, threadId, roomTab],
  );

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
    const body = Math.max(320, workspace.width);
    return Math.max(320, body - SIDEBAR_WIDTH);
  }, [workspace.width]);

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
   *  - **打开附件时回复串从 620px 跳到 517px**（解析候选值），关闭再跳回来，很突兀；
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
   * 两个宽度都是纯算术，不需要测量 DOM：
   *   右列宽 = 回复串当前宽度（默认 620）
   *   左列宽 = 可用宽度 − 右列宽 − 分隔条
   * 两侧都用 `flex: 0 1 <w>px`：空间足够时严格保持各自宽度；
   * 空间不足时允许收缩，不会溢出被裁（修掉"只显示半个"的另一半）。
   */
  const SPLIT_W = 8;
  /**
   * 注意：这里必须用 `navVisibleWidth`（**内容区**宽度 = app-body − 侧栏），
   * 不能用 `workspace.width`（那是整个 app-body，含 246px 侧栏）。
   * 用错基准会让两列基准之和超出容器，flex 只能按比例收缩，
   * 结果"对调"变成"各缩一点"（实测 1440px：应为 566/620，实际 677/517）。
   */
  const rightColW = Math.max(380, Math.min(threadWidth.width, Math.max(380, navVisibleWidth - 420 - SPLIT_W)));
  const leftColW = Math.max(420, navVisibleWidth - rightColW - SPLIT_W);
  const contextFlex = twoRegion
    ? { flex: `0 1 ${leftColW}px`, minWidth: 0 } as React.CSSProperties
    : undefined;
  const previewFlex = undefined; // 预览列宽度改由 CSS 的 --preview-w 表达（见 preview.css，便于做入场动画）

  /* 分隔条方向：L4 里它在回复串左缘，语义与 L2 相反（见 useThreadWidth 注释）。
     写 ref 而不是 state —— 它只被事件处理器读取，不参与渲染输出。 */
  threadWidth.invertRef.current = twoRegion;

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
           * 协调者与成员数合并成**一个轻量房间信息入口**（减负 §3）。
           * 原来它们是两个并列元素（「协调者 X」标签 + 「N 名成员」文字），
           * 加上右侧的「房间设置」按钮，同一件事有多个入口。
           * 现在信息入口只负责"看"，设置统一进房间「⋯」，不再互相竞争。
           */}
          <button
            type="button"
            className="pool-info"
            title={`房间信息：协调者 ${memberLabel(coord)}，${room.memberIds.length} 名成员；名称、成员、归档在右侧 ⋯ 里改`}
            aria-haspopup="menu"
            onClick={(e) => setRoomMenuAnchor(anchorFromElement(e.currentTarget))}
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
              onClick={() => { setRoomMenuAnchor(null); setSettingsOpen(true); }}
            >
              房间设置
            </MenuItem>
            <MenuItem
              icon="users"
              title="添加或移出房间成员、指定协调者"
              onClick={() => { setRoomMenuAnchor(null); setSettingsOpen(true); }}
            >
              房间成员
            </MenuItem>
            {room.archivedAt ? (
              <MenuItem
                icon="refresh"
                title="取消归档后可以继续发任务；旧的待派发任务不会自动重放"
                onClick={() => { setRoomMenuAnchor(null); unarchiveRoom(room.id); }}
              >
                取消归档
              </MenuItem>
            ) : (
              <MenuItem
                icon="archive"
                title="进入房间设置里的归档区块；存在活跃任务时会被阻止"
                onClick={() => { setRoomMenuAnchor(null); setSettingsOpen(true); }}
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

        {roomTab === 'chat' ? <RoomPool roomId={room.id} threadId={threadId} onOpenSettings={() => setSettingsOpen(true)} onOpenResource={openResource} /> : null}
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
          {!single && !narrow ? (
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整回复串宽度"
              title="拖动调整宽度 · 双击恢复默认"
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
               flex-basis（= 对调过来的左列宽）决定；同时传一个 620px 的
               inline width 会和 flex-basis 打架，实测渲染出来 597px
               而不是应有的 566px。 */
            width={single || narrow || twoRegion ? undefined : threadWidth.width}
            flexStyle={twoRegion ? contextFlex : undefined}
            highlightMessageId={highlightMessageId}
            initialTab={tab}
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

      {settingsOpen ? <RoomSettings roomId={room.id} onClose={() => setSettingsOpen(false)} /> : null}
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
  const listRef = useRef<HTMLDivElement>(null);
  const roots = useMemo(
    () => rootMessages(s, roomId).slice().sort((a, b) => b.createdAt - a.createdAt),
    [s, roomId],
  );
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

        {room && room.memberIds.length === 0 ? (
          <div className="panel warning" style={{ marginBottom: 10 }}>
            <div className="panel-title"><Icon name="users" size={13} /> 这个房间还没有成员</div>
            当前只能保存草稿，不能发送任务或唤醒 Agent。添加至少一名成员后，已保存的草稿仍会保留并可继续发送。
            <div className="panel-actions">
              <button className="btn sm primary" onClick={onOpenSettings}>
                <Icon name="user-plus" size={12} /> 添加房间成员
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
          sendDisabledReason={room.memberIds.length === 0 ? '请先添加房间成员' : undefined}
          /* 目标摘要行已按用户要求移除（第三轮）：房间名就在正上方的房间头部，
             发到哪里由 placeholder 与房间上下文表达，不再单占一行。 */
          onSend={(p) => {
            const r = submitMessage({ ...p, target: { kind: 'room_root', roomId } });
            if (r.threadId) navigate(`/project/${s.activeProjectId}/room/${roomId}?thread=${r.threadId}`);
          }}
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

function RootCard({
  message, selected, onOpenResource,
}: {
  message: Message;
  selected: boolean;
  onOpenResource?: (resourceId: string, revision?: number, from?: ContextLocation) => void;
}) {
  const s = useStore((x) => x);
  const thread = s.threads.find((t) => t.anchorMessageId === message.id);
  /** 卡片 ⋯ 菜单锚点（关注/静音/复制链接等次级操作的家） */
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const task = thread ? taskOfThread(s, thread) : undefined;
  const run = task ? s.runs.find((r) => r.taskId === task.id) : undefined;
  const unread = thread ? unreadCount(s, thread.id) : 0;
  const replies = thread ? replyCount(s, thread.id) : 0;
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
    if (task.status === 'WAITING_USER') {
      const open = s.issues.filter((i) => i.runId === run?.id && i.status === 'needs_user').length;
      return {
        label: '需要你决定', icon: 'hand', tone: 'warning' as const,
        detail: open > 0 ? `还有 ${open} 项分歧等你拍板` : '有事项等你处理',
      };
    }
    if (task.status === 'BLOCKED') {
      return { label: '阻塞', icon: 'octagon', tone: 'danger' as const, detail: '缺少必要的前置成果，需要你处理' };
    }
    if (task.status === 'DONE') {
      return { label: '已完成', icon: 'check-circle', tone: 'success' as const, detail: '成果已交付' };
    }
    if (task.status === 'CANCELLED') {
      return { label: '已取消', icon: 'slash', tone: 'neutral' as const, detail: '' };
    }
    // 2) 仍在跑：说明"谁在工作"，而不是罗列状态词
    if (run?.status === 'WAITING' || s.turns.some((t) => t.threadId === thread?.id && t.status === 'RUNNING')) {
      const running = s.turns.filter((t) => t.threadId === thread?.id && t.status === 'RUNNING');
      const who = running.map((t) => memberLabel(byId(s.members, t.memberId))).filter(Boolean);
      return {
        label: '执行中', icon: 'play', tone: 'info' as const,
        detail: who.length > 0 ? `${who.join('、')} 正在处理` : '成员正在处理',
      };
    }
    return { label: '执行中', icon: 'play', tone: 'info' as const, detail: '' };
  }, [task, run, s.changeSets, s.issues, s.turns, s.members, thread?.id]);
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
    const links = attachmentsOfMessage(s, message.id);
    return (
      <div className="root-card plain">
        <div className="root-card-head">
          <Tag tone="neutral" icon="message-square">普通消息 · 无任务</Tag>
          <div className="spacer" />
          <span className="small faint">{relTime(message.createdAt)}</span>
        </div>
        <div className="root-body">{message.body}</div>

        {/* 附件：**无 taskId 也能打开只读预览**（PV-01 的核心证据） */}
        {links.length > 0 ? (
          <div className="msg-attach-row">
            {links.map((link) => {
              const res = s.resources.find((r) => r.id === link.resourceId);
              if (!res) return null;
              return (
                <button
                  key={link.id}
                  className="msg-attach"
                  title={`打开 ${res.title}（v${link.revision}）· 只读预览，不派任务、不发言`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenResource?.(link.resourceId, link.revision, {
                      target: {
                        kind: 'room', projectId: message.projectId,
                        roomId: message.roomId, view: 'chat',
                      },
                      messageId: message.id,
                    });
                  }}
                >
                  <Icon name="paperclip" size={12} />
                  <span className="truncate">{res.title}</span>
                  <span className="msg-attach-kind mono-sm">v{link.revision}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="root-foot">
          <span className="small faint">这条消息没有派发任务，因此没有回复串</span>
        </div>
      </div>
    );
  }

  const open = () => {
    markThreadRead(thread.id);
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
  const followed = Boolean(s.subscriptions[thread.id]?.followed);
  const muted = Boolean(s.subscriptions[thread.id]?.muted);

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
      className={`root-card${selected ? ' selected' : ''}`}
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
      {/* 主状态之外，给一句"现在发生了什么、要不要你动手" */}
      {primary?.detail ? <div className="root-next">{primary.detail}</div> : null}
      <div className="root-body clamp-2">{message.body}</div>

      {/* 主池消息携带的资源（§17.9）：**无 taskId 的普通附件也在这里可点开**。
          点击只打开只读预览，不进入附件"所属任务"（那条任务可能根本不存在）。 */}
      {attachmentsOfMessage(s, message.id).length > 0 ? (
        <div className="msg-attach-row">
          {attachmentsOfMessage(s, message.id).map((link: { id: string; resourceId: string; revision: number }) => {
            const res = s.resources.find((r) => r.id === link.resourceId);
            if (!res) return null;
            return (
              <button
                key={link.id}
                className="msg-attach"
                title={`打开 ${res.title}（v${link.revision}）· 只读预览，不发送给 AI`}
                onClick={(e) => {
                  // 嵌套控件各自处理，不让点击冒泡成"打开回复串"
                  e.stopPropagation();
                  onOpenResource?.(link.resourceId, link.revision, {
                    target: { kind: 'room', projectId: message.projectId, roomId: message.roomId, view: 'chat' },
                    messageId: message.id,
                  });
                }}
              >
                <Icon name="paperclip" size={12} />
                <span className="truncate">{res.title}</span>
                <span className="msg-attach-kind mono-sm">v{link.revision}</span>
              </button>
            );
          })}
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
        {/**
         * 卡片 ⋯（新建 UI）：关注状态不再常驻在每张卡上，移到这里查看/切换。
         * 与线程 ⋯ 读的是**同一份订阅状态**（s.subscriptions），不各存一份。
         */}
        <button
          type="button"
          className="icon-btn sm"
          title="更多：关注这条任务、复制链接"
          aria-label="更多卡片操作"
          aria-haspopup="menu"
          onClick={(e) => { e.stopPropagation(); setMenuAnchor(anchorFromElement(e.currentTarget)); }}
        >
          <Icon name="more-horizontal" size={14} />
        </button>
      </div>

      {/* 菜单挂在卡片里，但点菜单项不应该顺手把回复串也打开 */}
      {menuAnchor ? (
        <div onClick={(e) => e.stopPropagation()}>
        <Menu anchor={menuAnchor} onClose={() => setMenuAnchor(null)}>
          <div className="menu-label">{isDiscussion ? '这条记录' : `任务 #${task?.roomTaskNumber}`}</div>
          <MenuItem icon="message-square" title="打开右侧回复串，查看这条任务的完整讨论" onClick={() => { setMenuAnchor(null); open(); }}>
            打开回复串
          </MenuItem>
          <MenuItem
            icon={followed ? 'eye' : 'eye-off'}
            title={followed ? '只停通知，不停止任务，也不改变参与与执行权限' : '关注后这条串的回复会进入你的通知'}
            hint={followed ? '已关注' : '未关注'}
            onClick={() => { toggleFollow(thread.id); setMenuAnchor(null); }}
          >
            {followed ? '取消关注' : '关注'}
          </MenuItem>
          <MenuItem
            icon="bell"
            title={muted ? '恢复这条串的通知；不改变参与名单与执行权限' : '只改通知偏好，不改变参与名单与执行权限'}
            hint={muted ? '已静音' : '未静音'}
            onClick={() => { toggleMute(thread.id); setMenuAnchor(null); }}
          >
            {muted ? '取消静音' : '静音'}
          </MenuItem>
          <MenuItem
            icon="copy"
            title="复制应用内直达链接（不是公网分享链接）"
            onClick={() => {
              const link = `zhongshuo://#/thread/${thread.id}`;
              void navigator.clipboard?.writeText(link);
              recordLocalOnly('thread.link.copy', `thread=${thread.id} → ${link}（应用内直达链接）`);
              toast('已复制本串的应用内链接', 'info');
              setMenuAnchor(null);
            }}
          >
            复制本串链接
          </MenuItem>
        </Menu>
        </div>
      ) : null}
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

  /**
   * 回复列表只渲染**回复视图真正显示**的消息。
   *
   * 普通过程说明（路由推导、程序校验通过、派发规则）已移到「详情 → 活动与进展」，
   * 它们不再出现在回复列表里；但消息本体、threadMessageSeq 与未读水位都不动。
   * 首条未读的判定和分隔线必须跟着这份列表走，否则"跳转首条未读"会指向
   * 一个没有渲染的元素而静默失效（lib/threadNav 与 selectors 的同一口径）。
   */
  const list = useMemo(() => (thread ? replyThreadMessages(s, thread.id) : []), [s, thread?.id]);
  /** 我们自己写进 URL 的 tab：用于区分"外部深链改了 tab"与"内部切页写了 URL" */
  const urlTabRef = useRef<ThreadTabLocal>(initialTab ?? 'replies');
  const anchor = thread ? anchorOf(s, thread) : undefined;
  const threadRoom = thread ? roomOf(s, thread.roomId) : undefined;
  const task = thread ? taskOfThread(s, thread) : undefined;
  const run = task ? s.runs.find((r) => r.taskId === task.id) : undefined;
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
   */
  const threadAttachments = useMemo(
    () => (thread
      ? s.messageAttachments.filter((l) => s.messages.some((m) => m.id === l.messageId && m.threadId === thread.id))
      : []),
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

  // 直达链接：滚到目标消息并高亮（§15.5 只定位已有记录，不执行任何命令）
  useEffect(() => {
    if (!highlightMessageId) return;
    setTab('replies');
    const t = window.setTimeout(() => {
      const el = document.getElementById(`msg-${highlightMessageId}`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('msg-highlight');
        window.setTimeout(() => el.classList.remove('msg-highlight'), 2600);
      }
    }, 350);
    return () => window.clearTimeout(t);
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
    const prefix = kind === 'quote' ? `> ${message.body}` : `更正（针对消息 ${message.id}）：`;
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
            onClick={() => { toggleFollow(thread.id); setThreadMenuAnchor(null); }}
          >
            {followed ? '取消关注' : '关注'}
          </MenuItem>
          <MenuItem
            icon="bell"
            title={muted
              ? '恢复这条串的通知；不改变参与名单与执行权限'
              : '只改通知偏好，不改变参与名单与执行权限'}
            hint={muted ? '已静音' : '未静音'}
            onClick={() => { toggleMute(thread.id); setThreadMenuAnchor(null); }}
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
          超过容忍后会自动"按缺席继续"：不打断仍在运行的成员，阶段屏障以现有成果推进并先生成部分成果，
          roster 标记该成员迟到。缺席容忍（absenceGrace）与单轮硬保护（turnDeadline）是两个独立设置。
          <div className="panel-actions">
            <button className="btn sm" onClick={() => retryTask(task?.id ?? '', 'strict')}>重试该成员</button>
            <button className="btn sm" onClick={() => run && allowMissing(run.id, [absence.memberId])}>按现有成员继续</button>
          </div>
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
              className="msg-list"
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                setPinnedToBottom(atBottom);
                if (atBottom) setPendingNew(0);
              }}
            >
              {list.map((m) => {
                const seq = m.threadMessageSeq;
                const watermark = s.readStates[thread.id] ?? 0;
                const isFirstUnread = seq !== undefined && seq > watermark && !list.some((x) => (x.threadMessageSeq ?? 0) > watermark && (x.threadMessageSeq ?? 0) < seq);
                return (
                  <div key={m.id} id={seq !== undefined ? `msg-seq-${thread.id}-${seq}` : undefined}>
                    {isFirstUnread ? (
                      <div className="row tight" style={{ marginBottom: 8 }}>
                        <div className="divider" style={{ flex: 1, margin: 0 }} />
                        <Tag tone="info" icon="message-square">首条未读</Tag>
                        <div className="divider" style={{ flex: 1, margin: 0 }} />
                      </div>
                    ) : null}
                    <MessageView
                      message={m}
                      author={byId(s.members, m.authorId)}
                      mode={task?.mode}
                      isMentioned={Boolean(m.payload?.mentionIds?.includes('you') || m.payload?.mentionIds?.some((id) => id === m.authorId))}
                      onOpenSubtask={(st) => {
                        setSubtaskTarget(st);
                        changeTab('replies');
                        toast(`已定向到子任务 #${st.number}：输入框会把内容直接交付该子任务负责人`, 'info');
                      }}
                      onOpenThread={() => undefined}
                      onOpenArtifact={(id) => { changeTab('artifacts'); setOpenArtifactId(id); }}
                      onReact={(e) => reactMessage(m.id, e)}
                      onSave={() => saveMessage(m.id)}
                      onApproval={(c) =>
                        m.payload?.approval && respondApproval(m.id, m.payload.approval.approvalId, c)
                      }
                      onRetry={() => task && retryTask(task.id, 'strict')}
                      onAllowMissing={() => run && allowMissing(run.id, [])}
                      onSteer={() => undefined}
                      onQuote={(message) => insertMessageAction(message, 'quote')}
                      onCorrection={(message) => insertMessageAction(message, 'correction')}
                      onOpenResource={(id, rev) => onOpenResource?.(id, rev, {
                        target: {
                          kind: 'thread', projectId: s.activeProjectId,
                          roomId: thread.roomId, threadId, tab: 'replies',
                        },
                        messageId: m.id,
                      })}
                    />
                  </div>
                );
              })}
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
            run={run}
            isDiscussion={isDiscussion}
            section={section}
            followerCount={followers.length}
            onChangeSection={(sec) => goView('details', sec)}
            onChangeTab={changeTab}
          />
        ) : null}
      </div>

      {!isDiscussion ? (
        <Composer
          target={{ kind: 'thread', roomId: thread.roomId, threadId: thread.id, subtask: subtaskTarget }}
          draftKey={`thread:${thread.id}`}
          insertText={composerInsert}
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
          /* 2026-09-25：输入区文案改为"跟进当前任务，可 @ 指定成员…"，
             任务号与方式的常驻提示不再占用 placeholder（它们在
             「线程 ⋯ → 任务 #N」与「详情 → 任务概况」里仍可查）。 */
          /* 「跟进 #N · 标题」这一行已按用户要求移除（第三轮）：
             任务身份在 placeholder、输入区下方与「详情 → 任务概况」里都能查到，
             不再在输入框上方单占一行。 */
          runBudget={run ? { used: run.budget.usedAgentTurns, max: run.budget.maxAgentTurns } : undefined}
          /* 停止入口按**任务真实状态**出现，不由输入框是否可发送推断（§2.3） */
          stop={task && (canStop || stopping)
            ? { onStop: () => stopTask(task.id), stopping }
            : undefined}
          onClearSubtask={() => setSubtaskTarget(undefined)}
          onSend={(p) => {
            /* 定向跟进是"交给 AI"的动作：仅记录不会定向派发（§4），
               它按记录路径保存到本串里，子任务定向仍留在输入区不丢。 */
            if (subtaskTarget && p.sendAs === 'ai') {
              steerSubtask(subtaskTarget.taskId, p.body, 'after_turn');
              setSubtaskTarget(undefined);
              return;
            }
            submitMessage({ ...p, target: { kind: 'thread', roomId: thread.roomId, threadId: thread.id } });
          }}
        />
      ) : (
        /* 历史**记录串**（无任务的讨论串）：仍有独立回复历史，但永不唤醒成员。
           2026-09-25 起它是"仅记录"的兼容例外：在里面回复默认仍是保存记录
           （recordThread），不会因为删掉常驻切换就被静默变成一次 AI 调用。 */
        <Composer
          target={{ kind: 'thread', roomId: thread.roomId, threadId: thread.id }}
          draftKey={`thread:${thread.id}`}
          recordThread
          insertText={composerInsert}
          sendDisabledReason={
            threadRoom?.archivedAt
              ? '房间已归档 · 只读，不能发送新内容'
              : threadRoom && s.projects.find((p) => p.id === threadRoom.projectId)?.archivedAt
                ? '项目已归档 · 只读，不能发送新内容'
                : threadRoom?.memberIds.length === 0
                  ? '房间还没有成员，请先添加成员'
                  : undefined
          }
          /* 讨论串的目标摘要行同样已移除（第三轮）：讨论内容就在上方回复流里，
             不必再在输入框上方重复一次根消息摘要。 */
          onSend={(p) => submitMessage({ ...p, target: { kind: 'thread', roomId: thread.roomId, threadId: thread.id } })}
        />
      )}
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
  s, threadId, anchor, task, run, isDiscussion, section, followerCount,
  onChangeSection, onChangeTab,
}: {
  s: AppState;
  threadId: string;
  anchor: Message;
  task?: Task;
  run?: WorkflowRun;
  isDiscussion: boolean;
  section: DetailsSection;
  followerCount: number;
  onChangeSection: (sec: DetailsSection) => void;
  onChangeTab: (tab: ThreadTabLocal) => void;
}) {
  const pendingDelivery = task?.currentDeliveryId
    ? s.taskDeliveries.find((d) => d.id === task.currentDeliveryId)
    : undefined;
  const hasDelivery = Boolean(
    task && (task.currentDeliveryId || s.taskDeliveries.some((d) => d.taskId === task.id)),
  );

  const groups: { key: DetailsSection; label: string; icon: string; hint: string }[] = [
    { key: 'overview', label: isDiscussion ? '记录信息' : '任务概况', icon: 'list', hint: isDiscussion ? '根消息与参与者' : '标题、编号、完整原始要求、状态与方式' },
    { key: 'members', label: '参与成员', icon: 'users', hint: '线程成员与跟进名单：移出=停止自动唤醒，历史保留，可再 @ 回来' },
    { key: 'activity', label: '活动与进展', icon: 'activity', hint: '本串执行记录与普通过程说明（路由推导、校验通过、阶段推进）' },
  ];
  if (run) {
    groups.push({ key: 'run', label: '运行详情', icon: 'terminal', hint: '工具活动、用量、错误与原始诊断' });
  }
  if (hasDelivery || section === 'delivery') {
    groups.push({ key: 'delivery', label: '交付与验收', icon: 'check-circle', hint: '完成摘要、版本、验证、残余问题与验收决定（可选验收的唯一入口）' });
  }
  if (task && run?.mode === 'DELIBERATE') {
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
        {active !== section ? (
          <div className="panel info" style={{ margin: '0 0 10px' }}>
            <div className="panel-title"><Icon name="info" size={13} /> 该分组在当前任务上不适用</div>
            原链接指向的分组（{section}）在这个线程里没有对应内容，已显示任务概况。
            这不会改动任何任务、交付或运行状态。
          </div>
        ) : null}
        {active === 'overview' ? (
          <ThreadOverview s={s} anchor={anchor} task={task} run={run} isDiscussion={isDiscussion} />
        ) : null}
        {active === 'members' ? <ThreadMembers threadId={threadId} isDiscussion={isDiscussion} /> : null}
        {active === 'activity' ? <ThreadActivity threadId={threadId} onChangeTab={onChangeTab} /> : null}
        {active === 'run' && run ? (
          <div className="thread-embed">
            <RunDetailPage runId={run.id} host="panel" />
          </div>
        ) : null}
        {/* v1.12 §10.5：交付详情仍是**可选验收的唯一主入口**，决定只在这里做一次 */}
        {active === 'delivery' && task ? (
          <div className="thread-embed">
            <DeliveryPanel taskId={task.id} />
          </div>
        ) : null}
        {active === 'deliberation' && run ? (
          <div className="thread-embed">
            <DeliberationPage runId={run.id} host="panel" />
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
  s, anchor, task, run, isDiscussion,
}: {
  s: AppState;
  anchor: Message;
  task?: Task;
  run?: WorkflowRun;
  isDiscussion: boolean;
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
  const modeCopy = task ? routeModeCopy[task.mode] : undefined;
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
                <TaskStatusTag status={task.status} />
                {run ? <RunStatusTag status={run.status} /> : null}
              </dd>
              <dt>方式</dt>
              <dd title={modeCopy?.detail}>{modeCopy?.label}</dd>
              <dt>阶段</dt>
              <dd>{run ? stageLabel(run.stage) : '尚无运行'}</dd>
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

      {/* 完整原始要求：不裁剪、不折叠，长文本完整可读（原消息身份与定位能力保留） */}
      <div className="card tight">
        <div className="section-title">原始要求（原消息）</div>
        <div className="row tight">
          <Avatar name="我" color="var(--m-human)" size={18} />
          <span className="strong">你</span>
          <span className="small faint">{fullTime(anchor.createdAt)}</span>
        </div>
        <div className="overview-anchor-body">{anchor.body}</div>
      </div>

      {task ? (
        <div className="thread-embed">
          {/**
           * 内嵌 TaskDetailPage：只复用它**具体的内容区块**
           * （任务属性 / 运行与预算 / 参与与缺席 / 子任务 / 改动集 …）。
           * 身份与那一排操作不重复渲染 —— 上面这张概况卡已经给了标题、任务号、
           * 状态、方式、阶段、派发摘要、来源与完整原始要求（减负第二轮 §1）。
           */}
          <TaskDetailPage taskId={task.id} host="panel" embedded />
        </div>
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
  run?: WorkflowRun;
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
            <span className="small faint truncate">缺少必要的前置成果，已有部分成果保留</span>
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

function ThreadMembers({ threadId, isDiscussion }: { threadId: string; isDiscussion: boolean }) {
  const s = useStore((x) => x);
  const thread = threadOf(s, threadId);
  const followers = s.followers[threadId] ?? [];
  const room = thread ? roomOf(s, thread.roomId) : undefined;
  const roomMembers = room ? room.memberIds.map((id) => byId(s.members, id)).filter(Boolean) : [];
  const notFollowing = roomMembers.filter((m) => m && !followers.includes(m.id));

  if (isDiscussion) {
    return (
      <div className="msg-list">
        <div className="panel">
          <div className="panel-title"><Icon name="info" size={13} /> 记录串没有跟进名单</div>
          记录不派工、不唤醒成员，因此不存在"哪些成员持续跟进"的概念。
          这里只列出房间成员，方便你决定要不要 @ 谁把它变成任务。
        </div>
        <div className="section-title">房间成员<span className="count">{roomMembers.length}</span></div>
        {roomMembers.map((m) => m && (
          <div key={m.id} className="row" style={{ justifyContent: 'space-between' }}>
            <span className="row tight">
              <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} state={m.workState} />
              <span className="strong">{memberLabel(m)}</span>
            </span>
            <span className="small faint">{m.workStateReason}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="msg-list">
      <div className="panel info">
        <div className="panel-title"><Icon name="users" size={13} /> 串内成员与跟进名单（和侧栏的「成员管理」不是一回事）</div>
        移出跟进 = 不再自动唤醒它；历史与已产出成果都保留；随时可以再 @ 回来。
        人的关注只控制通知，不改变成员是否运行（13B、§25.4）。
      </div>

      <div className="section-title">正在跟进<span className="count">{followers.length}</span></div>
      {followers.length === 0 ? (
        <EmptyState icon="users" title="没有成员在跟进" detail="在串里 @ 某个成员即可把它叫回来。" />
      ) : (
        <div className="col" style={{ gap: 8 }}>
          {followers.map((id) => {
            const m = byId(s.members, id);
            return (
              <div key={id} className="row" style={{ justifyContent: 'space-between' }}>
                <span className="row tight">
                  <Avatar
                    name={m?.displayName ?? '?'}
                    ordinal={m?.ordinal}
                    color={memberColor(id, m?.ordinal)}
                    size={22}
                    state={m?.workState}
                    stateTitle={m?.workStateReason}
                  />
                  <span>
                    <span className="strong">{memberLabel(m)}</span>
                    <span className="small faint" style={{ marginLeft: 6 }}>{m?.workStateReason}</span>
                  </span>
                </span>
                <button className="btn sm danger" onClick={() => removeFollower(threadId, id)}>
                  移出跟进
                </button>
              </div>
            );
          })}
        </div>
      )}

      {notFollowing.length > 0 ? (
        <>
          <div className="section-title" style={{ marginTop: 16 }}>
            房间其他成员<span className="count">{notFollowing.length}</span>
          </div>
          <div className="small faint" style={{ marginBottom: 8 }}>
            把它们加入跟进：之后本任务的后续动作会自动唤醒它们（受模式与预算约束）。
          </div>
          <div className="col" style={{ gap: 8 }}>
            {notFollowing.map((m) => m && (
              <div key={m.id} className="row" style={{ justifyContent: 'space-between' }}>
                <span className="row tight">
                  <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} state={m.workState} />
                  <span className="strong">{memberLabel(m)}</span>
                </span>
                <button
                  className="btn sm"
                  onClick={() => {
                    setState((st) => ({
                      ...st,
                      followers: { ...st.followers, [threadId]: [...(st.followers[threadId] ?? []), m.id] },
                    }));
                    recordLocalOnly('thread.follower.add', `thread=${threadId} member=${m.id}：加入跟进，后续自动唤醒`);
                    toast(`${memberLabel(m)} 已加入跟进`, 'success');
                  }}
                >
                  加入跟进
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ---------------- 串内成果 tab ---------------- */

function ThreadArtifacts({
  threadId,
  isDiscussion,
  onOpenResource,
}: {
  threadId: string;
  /** 讨论串：只有消息附件，没有任务成果（Artifact 需要 taskId） */
  isDiscussion?: boolean;
  /**
   * 旧的"就地展开成果"参数已不再使用。
   *
   * §17.9：具体文件正文进入**共享预览区域**，不再用 `thread-embed`
   * 整块替换成果列表 —— 那样回复正文与成果正文无法同时显示，
   * 也无法与对话并排对照。调用方仍传这三个参数以兼容既有深链解析，
   * 但组件不再据此替换视图（`?artifact=` 深链由 RoomPage 转成预览）。
   */
  openId?: string;
  onOpen?: (id: string) => void;
  onBack?: () => void;
  /** UX-PREVIEW-01：在共享预览区打开资源 */
  onOpenResource?: (resourceId: string, revision?: number, from?: ContextLocation) => void;
}) {
  const s = useStore((x) => x);
  const list = artifactsOfThread(s, threadId);

  /** 本串挂的资源（消息附件形式）—— **与成果列表相互独立** */
  const threadResourceLinks = s.messageAttachments.filter((link) =>
    s.messages.some((m) => m.id === link.messageId && m.threadId === threadId),
  );

  /**
   * 成果 → 预览资源的映射（§17.9 第 2 条）。
   *
   * 为什么不再就地展开全文：旧实现用 `thread-embed` **整块替换**成果列表，
   * 于是"回复正文与成果正文不能同时显示"，也无法与对话并排对照。
   * 现在正文进入右侧共享预览，左侧保留这份列表。
   */
  const resourceForArtifact = (artifactId: string) => {
    const art = s.artifacts.find((a) => a.id === artifactId);
    if (!art) return undefined;
    return s.resources.find((r) => r.title === art.title);
  };

  /** 本串资源区块：即使没有"成果"也要显示（附件可能挂在普通消息上） */
  const resourcesBlock = threadResourceLinks.length > 0 ? (
    <div className="card tight" style={{ marginBottom: 10 }}>
      <div className="row tight" style={{ marginBottom: 6 }}>
        <Icon name="paperclip" size={13} className="faint" />
        <span className="strong" style={{ fontSize: 12 }}>本串附件与产物</span>
        <span className="small faint">{threadResourceLinks.length}</span>
      </div>
      <div className="msg-attach-row" style={{ marginTop: 0 }}>
        {threadResourceLinks.map((link) => {
          const res = s.resources.find((r) => r.id === link.resourceId);
          if (!res) return null;
          return (
            <button
              key={link.id}
              className="msg-attach"
              title={`在右侧共享预览打开 ${res.title}（v${link.revision}）· 保留当前列表与对话`}
              onClick={() => onOpenResource?.(link.resourceId, link.revision)}
            >
              <Icon name="file-text" size={12} />
              <span className="truncate">{res.title}</span>
              <span className="msg-attach-kind mono-sm">v{link.revision}</span>
            </button>
          );
        })}
      </div>
      {/* 教程文字不常驻：「打开后进入右侧预览、列表不变」写在每个 chip 的 title 里 */}
    </div>
  ) : null;

  if (list.length === 0 && threadResourceLinks.length === 0) {
    return (
      <EmptyState
        icon="file-text"
        title={isDiscussion ? '还没有附件' : '还没有成果'}
        detail={isDiscussion
          ? '这条记录还没有携带附件。'
          : '成员的报告、附件与交付物会汇总在这里。'}
      />
    );
  }

  return (
    <div className="msg-list">
      {/* 本串资源：先于"成果"渲染，且不受成果为空影响 */}
      {resourcesBlock}

      {list.length === 0 ? (
        <div className="small faint" style={{ padding: '4px 2px' }}>
          还没有已提交的成果条目。
        </div>
      ) : null}

      {/* v1.12 §10.5：成果 tab 需要指向当前交付，不另生成第二条审批。
          这里给出交付状态与入口，决定本身只在交付详情做一次。 */}
      {(() => {
        const thread = s.threads.find((t) => t.id === threadId);
        const task = thread?.rootTaskId ? s.tasks.find((t) => t.id === thread.rootTaskId) : undefined;
        if (!task) return null;
        const d = task.currentDeliveryId
          ? s.taskDeliveries.find((x) => x.id === task.currentDeliveryId)
          : undefined;
        if (!d) return null;
        const label =
          d.status === 'pending' ? '待验收'
            : d.status === 'accepted' ? '已验收'
              : d.status === 'changes_requested' ? '已要求修改'
                : '已完成 · 无需验收';
        const tone =
          d.status === 'pending' ? 'warning'
            : d.status === 'accepted' ? 'success'
              : d.status === 'changes_requested' ? 'danger' : 'neutral';
        return (
          <div className="card tight" style={{ marginBottom: 10 }}>
            <div className="row tight wrap">
              <Icon name="check-circle" size={14} className="faint" />
              <span className="strong" style={{ fontSize: 12 }}>当前交付 r{d.revision}</span>
              <Tag tone={tone} icon={d.status === 'pending' ? 'eye' : 'info'}>{label}</Tag>
              <div className="spacer" />
              <button
                className="btn sm"
                onClick={() => navigate(`/project/${s.activeProjectId}/room/${thread!.roomId}?thread=${threadId}&tab=delivery`)}
              >
                <Icon name="corner-down-right" size={12} /> 查看交付
              </button>
            </div>
            <div className="small faint" style={{ marginTop: 4, lineHeight: 1.65 }}>{d.summary}</div>
          </div>
        );
      })()}

      {list.map((a) => (
        <div key={a.id} className="card tight">
          <div className="row tight" style={{ marginBottom: 4 }}>
            <Icon name="file-text" size={14} className="faint" />
            <span className="strong truncate" style={{ fontSize: 12 }}>{a.title}</span>
          </div>
          <div className="row tight wrap small faint">
            <Tag plain icon="user">{memberLabel(byId(s.members, a.authorId))}</Tag>
            <Tag plain>R{a.revision}</Tag>
            <span>{formatBytes(a.sizeBytes)}</span>
            <span className="mono-sm">{a.hash}</span>
            <span>{relTime(a.createdAt)}</span>
          </div>
          <div className="row tight" style={{ marginTop: 8 }}>
            {/* §17.9：正文进入**共享预览**，左侧保留本列表；
                不再整块替换对话（那会让人无法边讨论边对照） */}
            <button
              className="btn sm"
              title="在右侧共享预览中打开这份成果（保留当前列表与对话）"
              onClick={() => {
                const res = resourceForArtifact(a.id);
                if (res) onOpenResource?.(res.id, undefined);
                else {
                  // 找不到可预览资源时如实说明，不假装打开成功
                  toast('这份成果尚未接入可预览的资源内容（原型仅为部分成果提供真实内容）', 'info');
                }
              }}
            >
              <Icon name="eye" size={12} /> 打开
            </button>
            <button className="btn sm" onClick={() => exportArtifact(a.id, 'markdown')}>
              <Icon name="download" size={12} /> 导出
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 串内活动 tab ---------------- */

function ThreadActivity({ threadId, onChangeTab }: { threadId: string; onChangeTab: (t: ThreadTabLocal) => void }) {
  const s = useStore((x) => x);
  const turns = s.turns.filter((t) => t.threadId === threadId);
  const diags = s.diagnostics.filter((d) => d.trace.turnId && turns.some((t) => t.id === d.trace.turnId));
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
        <div className="panel-title"><Icon name="terminal" size={13} /> 工具输出折叠在运行详情</div>
        这是本回复串的执行记录：成员的原始工具活动、用量与诊断不进入对话正文。
        普通的路由推导与程序校验说明也从对话里移到这里，故障与权限请求仍留在对话中。
        全局「待我处理」在左侧栏底部，是另一回事。
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

      <div className="section-title">本串执行记录（AgentTurn）<span className="count">{turns.length}</span></div>
      {turns.map((t) => (
        <div key={t.id} className="card tight">
          <div className="row tight wrap">
            <Avatar name={byId(s.members, t.memberId)?.displayName ?? '?'} ordinal={byId(s.members, t.memberId)?.ordinal} color={memberColor(t.memberId)} size={18} />
            <span className="strong" style={{ fontSize: 12 }}>{memberLabel(byId(s.members, t.memberId))}</span>
            <Tag plain icon="layers">{stageLabel(t.stageKey)}</Tag>
            <Tag plain>attempt {t.attempt}</Tag>
            <div className="spacer" />
            <button className="btn ghost sm" onClick={() => onChangeTab('run')}>
              运行详情 <Icon name="chevron-right" size={11} />
            </button>
          </div>
          <div className="row tight wrap small faint" style={{ marginTop: 5 }}>
            <span className="mono-sm">dispatchKey {t.dispatchKey}</span>
            <span>epoch {t.epoch}</span>
            {t.durationMs ? <span>{formatDuration(t.durationMs)}</span> : null}
          </div>
        </div>
      ))}

      {/**
       * 诊断不再在这里重复一遍（减负：同一份内容两处渲染）。
       * 运行详情里有完整的诊断条目与上下文，这里只给出口与数量。
       */}
      <div className="card tight">
        <div className="row tight wrap">
          <Icon name="info" size={13} className="faint" />
          <span className="strong" style={{ fontSize: 12 }}>错误与原始诊断（{diags.length}）</span>
          <span className="small faint">完整条目带 trace 字段，在运行详情里查看，避免两处各渲染一份</span>
          <div className="spacer" />
          <button className="btn sm" onClick={() => onChangeTab('run')}>
            运行详情 <Icon name="chevron-right" size={11} />
          </button>
        </div>
      </div>
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
        这里集合本房间消息的附件与已提交成果（房间级汇总）。
        磁盘文件的改动看侧栏「文件与改动」，Git 状态看「Git」页——三者各管一段，不要混淆。
        附件摄取为本机不可变副本并记录 hash，避免原临时文件消失后报告失去依据。
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
        <div className="small faint" style={{ marginTop: 8, lineHeight: 1.65 }}>
          七类格式都保证保存与预览（决策 31）。<strong>正文能否被 agent 解析由 runtime 能力决定</strong>：
          不支持时显示「可保存/预览，当前成员无法解析」，不会默默跳过附件再宣称分析完成。
          文件摄取过程不执行脚本，也不把整个来源目录加入权限。
        </div>
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
                className="btn primary"
                onClick={() => {
                  recordLocalOnly(
                    'fileComment.create',
                    'artifact=…/version=1/锚点=行 12-15 → 评论写入文件线程；文件更新后旧评论标为旧版',
                  );
                  setCommentOpen(false);
                  toast('已提交选区评论（原型不落库）：评论锚定在该版本上，文件更新后不会静默漂移', 'success');
                }}
              >
                提交评论
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

function RoomSettings({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const s = useStore((x) => x);
  const room = roomOf(s, roomId)!;
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
            disabled={activeTasks.length > 0}
            title={activeTasks.length > 0 ? '先停止活跃任务' : '归档后房间只读'}
            onClick={() => {
              archiveRoom(room.id);
              onClose();
            }}
          >
            <Icon name="archive" size={12} /> 归档房间
          </button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            onClick={() => {
              updateRoom(room.id, { name, description: desc, coordinatorMemberId: coordinator });
              onClose();
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
      <div className="section-title" style={{ marginTop: 0 }}>
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
                />
                <span style={{ minWidth: 0 }}>
                  <span className="row tight">
                    <span className="strong">{memberLabel(m)}</span>
                    {isCoord ? <Tag tone="accent" icon="star">协调者</Tag> : null}
                  </span>
                  <span className="small faint">{m.model} · {m.workStateReason}</span>
                </span>
              </span>
              <button
                className="btn sm"
                disabled={isCoord}
                title={isCoord ? '协调者不能移出：请先改协调者' : '移出本房间'}
                onClick={() => removeRoomMember(room.id, m.id)}
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
                  <Avatar name={m.displayName} ordinal={m.ordinal} color={memberColor(m.id, m.ordinal)} size={22} state={m.workState} />
                  <span className="strong">{memberLabel(m)}</span>
                </span>
                <button className="btn sm primary" onClick={() => addRoomMember(room.id, m.id)}>
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
      {activeTasks.length > 0 ? (
        <div className="panel danger" style={{ marginBottom: 12 }}>
          <div className="panel-title"><Icon name="octagon" size={13} /> 当前有 {activeTasks.length} 个活跃任务，不能归档</div>
          归档前会检查所有根任务、子任务与待派发项。存在活跃工作时先阻止归档，并在这里给出停止入口。
          <div className="panel-actions">
            {activeTasks.map((t) => (
              <button key={t.id} className="btn sm danger" onClick={() => stopTask(t.id)}>
                停止 #{t.roomTaskNumber}
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
            disabled={!name.trim()}
            onClick={() => {
              const id = createRoom(projectId, name.trim(), members[0]?.id ?? '');
              onClose();
              // 创建后落点与项目页一致：直接进这个新房间（它属于被点击的那个项目）
              navigate(`/project/${projectId}/room/${id}`);
            }}
          >
            创建
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
