/**
 * 正式外壳（H1 首包，第四十七轮修订）：原型侧栏三段式（§17.1/第十五批）+ 主区路由 房间/私信。
 * 未换装入口经「原界面」**定向接管**（takeLegacy(target) 按 legacy 既有面板/开关定位到对应
 * 页面——不要求用户在旧界面再找一次）；接管期间卸载 hifi 样式（原型全局选择器不污染旧界面），
 * 返回时恢复样式与数据刷新；启动/渲染失败由 ErrorBoundary 与页面看门狗兜底回退。
 */
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './components/Icon';
import { NavUnreadDot } from './components/NavMarks';
import { CommandPalette } from './components/CommandPalette';
import { RecoveryPanel } from './components/RecoveryPanel';
import { useStore, toast, clearToast, hifiUi, refreshRooms, refreshDms } from './shell';
import { getState, setAppearanceState } from './data/store';
import { command } from './bridge';
import { navigate, pathOf, parseQuery, useHashRoute, currentNavSeq } from './lib/router';
import { registerNavIntent, releaseNavIntent, navIntentActive, cancelNavIntent } from './lib/navIntent';
import { isExternalDeepLink } from './lib/deepLink';
import { openExternalDeepLink } from './loader';
import { DmPage } from './DmPage';
import { MembersPage } from './MembersPage';
import { MemberDetailPage } from './pages/MemberDetailPage';
import { PendingPage } from './PendingPage';
import { LibraryPage } from './LibraryPage';
import { ActivityPage } from './ActivityPage';
import { TitleBar } from './components/TitleBar';
import { dmUnreadTotal, navTaskStateOfRoom, roomUnread, roomsOfProject } from './data/selectors';
import { RoomPage, CreateRoomModal } from './pages/Room';
import { FilesGitPage } from './pages/pages-misc';
import { SettingsPage } from './pages/SettingsPage';
import { ProjectHomePage, WelcomePage, OpenFolderModal } from './pages/ProjectHome';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { TasksBoardPage } from './pages/TasksBoard';
import { ArchivePage } from './pages/ArchivePage';
import { updateProjectReal, projectLifecycleReal, switchFocusProject } from './loader';
import { toggleProjectPinned } from './data/actions-nav';
import { Menu, MenuItem, Modal, Tag } from './components/ui';
import { toggleProjectExpanded } from './data/actions-nav';

/** 接管代次：返回新界面/再次接管时取消未完成的定位重试（review-r47 §5）。 */
let takeoverToken = 0;

/** 定向接管目标 → legacy 既有控件/面板（review-r46 §6 / r47 §5：切换后落在对应页面与实体）。 */
const LEGACY_TARGETS: Record<string, { label: string; locate: () => string | null }> = {
  search: { label: '搜索与收藏', locate: () => openDetails('search-panel') },
  git: { label: '文件与 Git', locate: () => togglePanel('files-toggle', 'files') },
  tasks: { label: '任务看板', locate: () => togglePanel('board-toggle', 'board') },
  members: { label: '成员管理', locate: () => openDetails('project-settings') },
  pending: {
    label: '待我处理',
    // scrollIntoView 正常返回 undefined——先判存在再滚动（review-r47 §5 反例）。
    locate: () => {
      const el = document.getElementById('pending-list');
      if (el == null) return '未找到待我处理列表';
      el.scrollIntoView({ block: 'start' });
      return null;
    },
  },
  settings: { label: '设置与帮助', locate: () => openDetails('help-panel') },
  remote: { label: '远程访问设置', locate: () => openDetails('remote-settings') },
};

/** 按机器身份定位 legacy 目标（review-r48 §4：名称 includes 会把同成员第二个会话/同名房间
 * 打开成第一个——一律先 data-room-id/data-conversation-id 精确匹配，缺属性才回退名称并标注）。 */
function locateLegacyRoom(roomId: string, name: string): string | null {
  const byId = document.querySelector(`#room-list .room-item[data-room-id="${CSS.escape(roomId)}"]`) as HTMLElement | null;
  if (byId != null) { byId.click(); return null; }
  const byName = [...document.querySelectorAll('#room-list .room-item')].find((b) => (b.textContent ?? '').includes(name));
  if (byName != null) { (byName as HTMLElement).click(); return `已按名称回退定位房间「${name}」（原界面缺 data-room-id——建议升级包）`; }
  return `原界面未找到房间「${name}」（${roomId}）`;
}
function locateLegacyDm(conversationId: string, fallbackLabel: string): string | null {
  const byId = document.querySelector(`#dm-list button[data-conversation-id="${CSS.escape(conversationId)}"]`) as HTMLElement | null;
  if (byId != null) { byId.click(); return null; }
  return `原界面未找到私信会话 ${conversationId}（${fallbackLabel}）——不按名称猜测`;
}

function openDetails(id: string): string | null {
  const el = document.getElementById(id) as HTMLDetailsElement | null;
  if (el == null) return `原界面面板 #${id} 未找到`;
  el.open = true;
  el.scrollIntoView({ block: 'start' });
  return null;
}

function togglePanel(toggleId: string, panelId?: string): string | null {
  const btn = document.getElementById(toggleId);
  if (btn == null) return `原界面入口 #${toggleId} 未找到`;
  // 已可见则不再点击（toggle 语义：重复点击=关闭——review-r46 定位重试的竞态源）。
  if (panelId != null) {
    const panel = document.getElementById(panelId);
    if (panel != null && !panel.classList.contains('hidden') && getComputedStyle(panel).display !== 'none') return null;
  }
  btn.click();
  // legacy 启动期的 loadProject→showPool 会把工具面板重新收起（resetToolPanels）——
  // 点击后必须复核面板确实可见，未可见则由 takeLegacy 的有界重试再次点击。
  if (panelId != null) {
    const panel = document.getElementById(panelId);
    const visible = panel != null && !panel.classList.contains('hidden') && getComputedStyle(panel).display !== 'none';
    if (!visible) return `#${panelId} 点击后仍不可见（legacy 启动中——重试）`;
  }
  return null;
}

/** 进入「原界面」（定向接管）：启动 legacy 一次→按目标定位→卸载 hifi 样式；返回时恢复。
 * targetKey 为 LEGACY_TARGETS 键或 'current-room'/'current-dm'（携带当前身份定位）。 */
export function takeLegacy(targetKey: string): void {
  takeoverToken += 1;
  const myToken = takeoverToken;
  const state = getState();
  let target: { label: string; locate: () => string | null };
  if (targetKey === 'current-room') {
    const currentRoomId = state.ui.activeRoomId || (state.rooms[0]?.id ?? '');
    const room = state.rooms.find((r) => r.id === currentRoomId) ?? state.rooms[0];
    target = room != null ? { label: `房间 ${room.name}`, locate: () => locateLegacyRoom(room.id, room.name) } : LEGACY_TARGETS.tasks!;
  } else if (targetKey === 'current-dm') {
    const dm = state.dms.find((d) => d.id === state.ui.activeThreadId) ?? state.dms[0];
    const label = dm != null ? `${dm.peerDisplayName ?? ''}${dm.title != null && dm.title.length > 0 ? ` · ${dm.title}` : ''}` : '';
    target = dm != null ? { label: `私信 ${label}`, locate: () => locateLegacyDm(dm.id, label) } : LEGACY_TARGETS.search;
  } else {
    target = LEGACY_TARGETS[targetKey] ?? { label: targetKey, locate: () => null };
  }
  const w = window as unknown as { __zsLegacyStart?: () => void; __zsLegacyStarted?: boolean; __zsLegacySetVisible?: (v: boolean) => void };
  if (w.__zsLegacyStart != null && w.__zsLegacyStarted !== true) { w.__zsLegacyStart(); w.__zsLegacyStarted = true; }
  document.body.classList.add('legacy-on');
  w.__zsLegacySetVisible?.(true); // 恢复旧端轮询（隐藏期暂停）
  disableHifiStyles();
  // legacy 渲染就绪后定位（boot 需要时间；且 loadProject→showPool 会把面板重新收起——
  // 点击后须**连续多次确认稳定可见**才算定位成功，有界重试，失败如实提示）。
  let tries = 0;
  let stable = 0;
  const tryLocate = () => {
    if (takeoverToken !== myToken) return; // 已返回新界面/再次接管——取消旧定位重试
    const problem = target.locate();
    if (problem == null) {
      stable += 1;
      if (stable >= 3) return; // 连续 3 次（≈750ms）稳定——boot 收起竞态已过
    } else {
      stable = 0;
      tries += 1;
      if (tries >= 40) {
        toast(`原界面已打开，但「${target.label}」定位失败：${problem}`, 'warn');
        return;
      }
    }
    window.setTimeout(tryLocate, 250);
  };
  window.setTimeout(tryLocate, 300);
  hifiUi().legacyEnter(target.label);
}

function hifiStyleLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[href="hifi/app.css"]');
}

/** 样式隔离（review-r46 §6）：legacy 接管期间移除 hifi 全局样式；返回时恢复。 */
function disableHifiStyles(): void { hifiStyleLink()?.setAttribute('disabled', 'disabled'); }
function enableHifiStyles(): void { hifiStyleLink()?.removeAttribute('disabled'); }

/** 渲染期致命错误兜底：回退原界面（数据错误不切——由页面就地呈现/重试）。 */
class HifiErrorBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  constructor(props: { children: ReactNode }) { super(props); this.state = { failed: null }; }
  static getDerivedStateFromError(e: unknown) { return { failed: e instanceof Error ? e.message : String(e) }; }
  componentDidCatch(e: unknown) {
    console.error('[hifi] 渲染错误，回退原界面：', e);
    const w = window as unknown as { __zsHifiFailed?: boolean; __zsLegacyStart?: () => void; __zsLegacyStarted?: boolean };
    w.__zsHifiFailed = true;
    document.body.classList.add('legacy-on');
    hifiStyleLink()?.setAttribute('disabled', 'disabled'); // 回退时关闭 hifi 全局样式（r47 §5）
    if (w.__zsLegacyStart != null && w.__zsLegacyStarted !== true) { w.__zsLegacyStart(); w.__zsLegacyStarted = true; }
  }
  render() { return this.state.failed == null ? this.props.children : <div style={{ padding: 24 }}>界面渲染失败（{this.state.failed}）——已回退原界面。</div>; }
}

export default function App() {
  const route = useHashRoute();
  const s = useStore((x) => x);
  const path = pathOf(route);
  const query = parseQuery(route);
  const legacyActive = useStore((x) => x.legacyActive === true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryAttention, setRecoveryAttention] = useState(false);
  /** 恢复三态（R66 P5，review-r65 §F：启动已有 vs 运行中新增 vs 普通排队）——
   *  · 启动已有异常：首次检查即存在 → 自动开一次面板（既有合同）；
   *  · 运行中新失败：首次检查之后才出现 → **就地 toast** 提醒 + 侧栏标记，不再突然弹遮挡
   *    输入的通用弹窗（原会话/任务自身的状态面板是主反馈位）；
   *  · 普通排队（仅 pendingDispatch>0，无任何恢复类事项）：不是故障——中性展示，不标警示色。 */
  const [recoveryOrigin, setRecoveryOrigin] = useState<'startup' | 'runtime' | null>(null);
  const [pendingWaitCount, setPendingWaitCount] = useState(0);
  const recoveryAutoShownRef = useRef(false);
  /**
   * R67 P2-A（review-r66 §2P2-A 反例）：**启动来源按首次成功快照的异常实体签名固定**——
   * `startupSignatureRef` 在第一次成功 recovery.status 时记录当时全部异常实体 id（UNKNOWN
   * turns/中断 runs/待解除保护/未收口撤销/门禁）。此后任何轮询：
   *  - 实体全部 ⊆ 启动签名 → origin=startup（同一运行中**永不**改判、永不再自动弹窗——
   *    反例根因是旧判据 `isFirstCheck || hadRealAttention` 在第二次轮询把 runtime 倒退成
   *    startup 并弹遮挡窗）；
   *  - 出现签名外**新实体** → origin=runtime：就地 toast（每个新实体集只提醒一次）+侧栏
   *    标记，不自动弹窗；
   *  - 全部消失 → origin=null；之后再出现（即便实体同旧）=运行中新失败（toast，不弹窗）。
   */
  const startupSignatureRef = useRef<Set<string> | null>(null);
  const lastNotifiedSignatureRef = useRef<string>('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  /* R65：侧栏项目 ⋯ 菜单与其弹窗（编辑信息/归档/移除）+ 项目行 + 建房。 */
  const [projectMenuFor, setProjectMenuFor] = useState<string | null>(null);
  const [projectMenuAt, setProjectMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [editInfoFor, setEditInfoFor] = useState<string | null>(null);
  const [archiveProjFor, setArchiveProjFor] = useState<string | null>(null);
  const [removeProjFor, setRemoveProjFor] = useState<string | null>(null);
  const [createRoomFor, setCreateRoomFor] = useState<string | null>(null);
  const [openFolder, setOpenFolder] = useState(false);

  useEffect(() => { document.documentElement.dataset.theme = s.ui.theme; }, [s.ui.theme]);

  useEffect(()=>{
    let cancelled=false;
    void command<{showAvatars:boolean;avatars:Record<string,string>}>('app.appearance.get',{})
      .then(value=>{if(!cancelled)setAppearanceState(value.showAvatars,value.avatars);})
      .catch(()=>{/* 读取失败保留默认隐藏头像，不伪造设置 */});
    return()=>{cancelled=true;};
  },[]);

  // Ctrl/Cmd+K 命令面板（仅 hifi 可见时响应）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.body.classList.contains('legacy-on') || !document.body.classList.contains('hifi-on')) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPaletteOpen((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 恢复注意项（recovery.status 只读轮询；R66 P5 三态 + R67 P2-A 来源稳定）
  useEffect(() => {
    if (s.boot !== 'ready') return;
    let cancelled = false;
    const check = () => {
      if (cancelled || document.body.classList.contains('legacy-on')) return;
      void command<{ gateHeld: boolean; unknownTurns: Array<{ id: string }>; pendingRelease: Array<{ turnId: string }>; activeUndos: Array<{ id: string }>; interruptedRuns: Array<{ id: string }>; pendingDispatchCount: number }>('recovery.status', {})
        .then((r) => {
          if (cancelled) return;
          const entities: string[] = [];
          if (r.gateHeld) entities.push('gate:held');
          for (const x of r.unknownTurns) entities.push(`turn:${x.id}`);
          for (const x of r.pendingRelease) entities.push(`release:${x.turnId}`);
          for (const x of r.activeUndos) entities.push(`undo:${x.id}`);
          for (const x of r.interruptedRuns) entities.push(`run:${x.id}`);
          const signature = [...entities].sort().join('|');
          const realAttention = entities.length > 0;
          // 首次成功快照：固定启动签名（此后同一运行内不再重判 startup）。
          const isFirstSnapshot = startupSignatureRef.current == null;
          if (isFirstSnapshot) startupSignatureRef.current = new Set(entities);
          setRecoveryAttention(realAttention);
          setPendingWaitCount(!realAttention && r.pendingDispatchCount > 0 ? r.pendingDispatchCount : 0);
          if (realAttention) {
            const startupSet = startupSignatureRef.current ?? new Set<string>();
            const allFromStartup = entities.every((e) => startupSet.has(e));
            if (isFirstSnapshot) {
              // 启动时已有：沿用一次自动打开合同（仅此一次）。
              setRecoveryOrigin('startup');
              if (!recoveryAutoShownRef.current) { recoveryAutoShownRef.current = true; setRecoveryOpen(true); }
            } else if (allFromStartup) {
              // 持续的启动既有事项：保持 startup 分类，**不再自动弹窗**（面板开着也不动）。
              setRecoveryOrigin('startup');
            } else {
              // 运行中新失败（签名外新实体）：就地 toast（同一实体集只提醒一次）+侧栏标记。
              setRecoveryOrigin('runtime');
              if (lastNotifiedSignatureRef.current !== signature) {
                lastNotifiedSignatureRef.current = signature;
                toast('刚刚出现需要处理的新事项（未知结果/中断/保护）——侧栏「恢复检查」已标记，点击查看', 'warn');
              }
            }
          } else {
            setRecoveryOrigin(null);
          }
        })
        .catch(() => { /* 读取失败不冒充 */ });
    };
    check();
    const t = window.setInterval(check, 30_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [s.boot]);

  // 外部深链族（#dm=/#task=/#delivery=/#msg=）规范化
  useEffect(() => {
    if (!isExternalDeepLink(`#${route}`)) return;
    if (document.body.classList.contains('legacy-on')) return;
    let cancelled = false;
    void openExternalDeepLink(`#${route}`).catch((e: unknown) => { if (!cancelled) toast(`深链打开失败：${(e as Error).message}`, 'error'); });
    return () => { cancelled = true; };
  }, [route]);

  // legacy 接管的「返回新界面」
  useEffect(() => {
    if (!legacyActive) return;
    const btn = document.createElement('button');
    btn.className = 'btn ghost sm zs-legacy-exit';
    btn.textContent = '⌂ 返回新界面';
    btn.title = '回到换装壳（原型还原界面）——恢复样式并刷新数据';
    btn.onclick = () => {
      takeoverToken += 1;
      document.body.classList.remove('legacy-on');
      (window as unknown as { __zsLegacySetVisible?: (v: boolean) => void }).__zsLegacySetVisible?.(false);
      enableHifiStyles();
      hifiUi().legacyExit();
      void refreshRooms(); void refreshDms();
    };
    document.body.append(btn);
    return () => { btn.remove(); };
  }, [legacyActive]);

  const project = s.projects.find((p) => p.id === s.activeProjectId);
  const rooms = project ? roomsOfProject(s, project.id) : [];
  const dmUnread = dmUnreadTotal(s);
  const expanded = project != null && s.expandedProjectIds.includes(project.id);
  /** 房间路由匹配（项目路径形态 + 换装期旧 /room/:id）。 */
  const roomMatch = path.match(/^\/project\/([^/]+)\/room\/([^/]+)$/);
  const activeRoomId = roomMatch?.[2] ?? (path.startsWith('/room/') ? path.slice('/room/'.length) : undefined);

  const navActive = {
    library: path === '/library',
    activity: path === '/activity',
    files: /^\/project\/[^/]+\/files$/.test(path) || path === '/files',
    tasks: path === '/board',
    members: /^\/project\/[^/]+\/(?:members|member\/[^/]+)$/.test(path) || path === '/members',
    settings: path === '/settings',
    dm: path === '/dm' || path.startsWith('/dm/') || /^\/project\/[^/]+\/dm$/.test(path),
    pending: path === '/pending',
  };

  return (
    <>
      <TitleBar />
      <HifiErrorBoundary>
        <div className="app" data-zs-boot={s.boot}>
        <div className="app-body">
          {sidebarOpen && !s.layout.navAutoHidden ? (
          <aside className="sidebar">
            <div className="sidebar-top">
              <div className="side-row-flat">
                <button
                  className={`side-item${navActive.library ? ' active' : ''}`}
                  title="搜索与收藏：消息/线程/任务标题检索 + 收藏列表"
                  onClick={() => navigate(project != null ? `/library?scope=project&projectId=${project.id}` : '/library')}
                >
                  <Icon name="bookmark" size={14} />
                  <span className="side-item-label">搜索与收藏</span>
                </button>
                <button
                  className="side-icon-btn"
                  title="全局搜索（Ctrl+K）：跨项目搜消息、任务、成果"
                  onClick={() => setPaletteOpen(true)}
                >
                  <Icon name="search" size={14} />
                  <span className="visually-hidden">全局搜索</span>
                </button>
              </div>
              <button
                className={`side-item${navActive.files ? ' active' : ''}`}
                title="文件与 Git：同一项目页内两个标签（真实目录树 + Git 全链）"
                onClick={() => navigate(project != null ? `/project/${project.id}/files` : '/files')}
              >
                <Icon name="diff" size={14} />
                <span className="side-item-label">文件与 Git</span>
              </button>
              <button
                className={`side-item${navActive.tasks ? ' active' : ''}`}
                title="任务看板：全部可访问项目聚合"
                onClick={() => navigate('/board')}
              >
                <Icon name="list" size={14} />
                <span className="side-item-label">任务看板</span>
              </button>
              <button
                className={`side-item${navActive.members ? ' active' : ''}`}
                title="成员管理：成员名单与 runtime 绑定（正式命令）"
                onClick={() => navigate(project != null ? `/project/${project.id}/members` : '/members')}
              >
                <Icon name="users" size={14} />
                <span className="side-item-label">成员管理</span>
              </button>
              <button
                className={`side-item${navActive.dm ? ' active' : ''}`}
                title="私信：本项目一对一会话"
                onClick={() => navigate('/dm')}
              >
                <Icon name="message-square" size={14} />
                <span className="side-item-label">私信</span>
                <span className="side-marks"><NavUnreadDot count={dmUnread} where="私信" /></span>
              </button>
            </div>
            <div className="sidebar-scroll">
              <div className="side-heading">项目</div>
              {project == null ? (
                <div className="side-empty">
                  {s.boot === 'pending' ? '正在连接服务…' : s.boot === 'failed' ? `连接失败：${s.bootError ?? '未知'}` : '尚未打开项目'}
                  <button className="btn ghost sm" onClick={() => setOpenFolder(true)}>打开文件夹</button>
                  {s.boot === 'failed' ? <button className="btn ghost sm" onClick={() => location.reload()}>重试</button> : null}
                </div>
              ) : null}
              {(() => {
                const daily = s.projects.filter((p) => p.removedAt == null);
                const dailyIds = new Set(daily.map((p) => p.id));
                const visibleProjects = [
                  ...s.pinnedProjectIds.filter((id) => dailyIds.has(id)),
                  ...s.visibleProjectIds.filter((id) => dailyIds.has(id) && !s.pinnedProjectIds.includes(id)),
                ].map((id) => daily.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => p != null);
                return visibleProjects.map((p) => {
                  const isCurrent = p.id === s.activeProjectId;
                  const expanded = s.expandedProjectIds.includes(p.id);
                  const rooms = roomsOfProject(s, p.id);
                  return (
                    <div key={p.id} className="side-project">
                      <div className={`side-row${isCurrent ? ' context-active' : ''}`}>
                        <button
                          className="side-caret"
                          title={expanded ? '收起房间列表' : '展开房间列表'}
                          aria-expanded={expanded}
                          onClick={(e) => { e.stopPropagation(); toggleProjectExpanded(p.id); }}
                        >
                          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
                        </button>
                        <button
                          className="side-item-label-btn"
                          title={`${p.displayName} · ${p.rootPath}${p.archivedAt != null ? '（已归档·只读）' : ''}`}
                          onClick={() => toggleProjectExpanded(p.id)}
                        >
                          <Icon name={p.status === 'missing' ? 'alert-triangle' : p.isGit ? 'git-branch' : 'folder'} size={13} className={p.status === 'missing' ? 'warn-icon' : 'faint'} />
                          <span className="side-item-label">{p.displayName}</span>
                        </button>
                        <span className="side-row-actions">
                          <button
                            className={`side-row-act${projectMenuFor === p.id ? ' on' : ''}`}
                            title={`「${p.displayName}」的更多操作`}
                            aria-haspopup="menu"
                            onClick={(e) => {
                              e.stopPropagation();
                              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setProjectMenuFor(projectMenuFor === p.id ? null : p.id);
                              setProjectMenuAt({ x: r.right + 4, y: r.bottom + 4 });
                            }}
                          >
                            <Icon name="more-horizontal" size={14} />
                          </button>
                          <button
                            className="side-row-act"
                            title={`在「${p.displayName}」中新建房间（真实 room.create）`}
                            onClick={(e) => { e.stopPropagation(); setCreateRoomFor(p.id); }}
                          >
                            <Icon name="plus" size={14} />
                          </button>
                        </span>
                      </div>
                      {expanded ? rooms.filter((r) => r.archivedAt == null).map((room) => {
                        const rState = navTaskStateOfRoom(s, room.id);
                        const rUnread = roomUnread(s, room.id);
                        return (
                          <button
                            key={room.id}
                            className={`side-item sub${room.id === activeRoomId ? ' active' : ''}`}
                            onClick={() => { void switchFocusProject(p.id); navigate(`/project/${p.id}/room/${room.id}`); }}
                          >
                            {rState.state ? (
                              <span className="side-icon-slot" title={`房间任务状态：${rState.state}（${rState.total} 个未结束）`}>
                                <Icon name={rState.state === 'BLOCKED' ? 'octagon' : rState.state === 'WAITING_USER' ? 'hand' : rState.state === 'REVIEW' ? 'eye' : 'play'} size={12} style={{ color: 'var(--warning,#b45309)' }} />
                              </span>
                            ) : (
                              <span className="side-icon-slot" aria-hidden="true" />
                            )}
                            <span className="side-item-label" title={room.name}>{room.name}</span>
                            <span className="side-marks"><NavUnreadDot count={rUnread} where={room.name} /></span>
                          </button>
                        );
                      }) : null}
                    </div>
                  );
                });
              })()}
              <button
                className="side-item"
                data-zs-open-project="hifi"
                title="打开/注册项目：选择一个文件夹（已注册则幂等重开并切换焦点；其它项目保留在侧栏）"
                onClick={() => setOpenFolder(true)}
              >
                <Icon name="folder" size={13} />
                <span className="side-item-label">打开/切换项目</span>
              </button>
            </div>
            <div className="sidebar-foot">
              <button
                className={`side-item${recoveryAttention ? ' zs-recovery-attention' : ''}`}
                title={recoveryAttention
                  ? recoveryOrigin === 'runtime'
                    ? `恢复检查：本次运行新出现需要处理的事项（未知/中断/保护）——点击查看与分列操作`
                    : `恢复检查：存在需要处理的事项——点击查看与分列操作`
                  : pendingWaitCount > 0
                    ? `恢复检查：${pendingWaitCount} 条排队意图等待派发（普通排队，非故障）`
                    : '恢复检查：查看恢复事实'}
                data-zs-recovery-attention={recoveryAttention ? '1' : '0'}
                onClick={() => setRecoveryOpen(true)}
              >
                <Icon name="shield" size={14} />
                <span className="side-item-label">恢复检查</span>
                {recoveryAttention ? <span className="side-marks"><span className="nav-dot" title={recoveryOrigin === 'runtime' ? '本次运行新出现' : '启动时已有'} style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--warning,#b45309)', display: 'inline-block' }} /></span> : null}
                {!recoveryAttention && pendingWaitCount > 0 ? <span className="side-marks"><span className="nav-dot" title="普通排队（非故障）" style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--text-4,#98a0ad)', display: 'inline-block' }} /></span> : null}
              </button>
              <button
                className={`side-item${navActive.pending ? ' active' : ''}`}
                title="待我处理：权威业务状态汇总"
                onClick={() => navigate('/pending')}
              >
                <Icon name="inbox" size={14} />
                <span className="side-item-label">待我处理</span>
              </button>
              <button
                className={`side-item${navActive.settings ? ' active' : ''}`}
                title="应用设置：七项导航（原型布局）——通用/外观/通知/AI 工具/连接与设备/数据与存储/帮助与关于"
                onClick={() => navigate('/settings?section=general')}
              >
                <Icon name="settings" size={14} />
                <span className="side-item-label">设置</span>
              </button>
            </div>
          </aside>
          ) : null}

          <Routes path={path} route={route} query={query} />
        </div>
        </div>
      </HifiErrorBoundary>
      {projectMenuFor != null && projectMenuAt != null ? (() => {
        const p = s.projects.find((x) => x.id === projectMenuFor);
        if (p == null) return null;
        const close = () => { setProjectMenuFor(null); setProjectMenuAt(null); };
        const pinned = s.pinnedProjectIds.includes(p.id);
        return (
          <Menu anchor={projectMenuAt} onClose={close}>
            <div className="menu-label">{p.displayName}</div>
            <MenuItem icon="pin" hint={pinned ? '已置顶' : undefined} title={pinned ? '取消置顶：恢复按侧栏顺序排列' : '置顶：排到项目列表前部'} onClick={() => { toggleProjectPinned(p.id); close(); }}>
              {pinned ? '取消置顶' : '置顶项目'}
            </MenuItem>
            <MenuItem icon="edit" title="编辑显示名称与描述（project.update 乐观锁——不重命名磁盘目录）" onClick={() => { setEditInfoFor(p.id); close(); }}>编辑项目信息…</MenuItem>
            <div className="menu-sep" />
            <MenuItem icon="folder" title="打开项目主页（房间/成员/活跃任务概览）" onClick={() => { void switchFocusProject(p.id); navigate(`/project/${p.id}`); close(); }}>项目主页</MenuItem>
            <MenuItem icon="users" title="成员管理（含 runtime 绑定）" onClick={() => { void switchFocusProject(p.id); navigate(`/project/${p.id}/members`); close(); }}>成员管理</MenuItem>
            <MenuItem icon="settings" title="项目设置（信息/交付/协作限制/高级操作）" onClick={() => { void switchFocusProject(p.id); navigate(`/project/${p.id}/settings`); close(); }}>项目设置</MenuItem>
            <div className="menu-sep" />
            {p.archivedAt != null ? (
              <MenuItem icon="refresh" title="恢复为日常项目（原归档房不跟着恢复）" onClick={() => { void projectLifecycleReal(p.id, p.revision, 'unarchive').then((r) => { toast(r.ok ? '项目已恢复' : `恢复失败：${r.error}`, r.ok ? 'success' : 'error'); }); close(); }}>恢复项目</MenuItem>
            ) : (
              <MenuItem icon="archive" title="归档：退出日常列表、历史保留只读（有未结束工作会被拒绝）" onClick={() => { setArchiveProjFor(p.id); close(); }}>归档项目…</MenuItem>
            )}
            <MenuItem icon="trash" title="移除：只在应用里解除关联，不删除磁盘文件与历史（可在欢迎页重新打开）" onClick={() => { setRemoveProjFor(p.id); close(); }}>移除项目…</MenuItem>
            <div className="menu-sep" />
            <MenuItem icon="archive" title="查看已归档的项目与房间（查看历史 + 恢复——不动磁盘文件与历史）" onClick={() => { navigate('/archive'); close(); }}>归档管理</MenuItem>
          </Menu>
        );
      })() : null}

      {editInfoFor != null ? (() => {
        const p = s.projects.find((x) => x.id === editInfoFor);
        if (p == null) return null;
        return <EditProjectInfoModal key={p.id} projectId={p.id} onClose={() => setEditInfoFor(null)} />;
      })() : null}

      {archiveProjFor != null ? (() => {
        const p = s.projects.find((x) => x.id === archiveProjFor);
        if (p == null) return null;
        return (
          <Modal
            size="sm"
            title={`归档项目「${p.displayName}」`}
            onClose={() => setArchiveProjFor(null)}
            footer={<><div className="spacer" /><button className="btn" onClick={() => setArchiveProjFor(null)}>取消</button><ProjectLifecycleButton projectId={p.id} revision={p.revision} action="archive" onDone={() => { setArchiveProjFor(null); navigate(`/archive?project=${p.id}`); }} /></>}
          >
            <div className="small muted" style={{ lineHeight: 1.75 }}>
              归档后项目退出日常项目列表、历史保留只读；恢复不重放旧任务。磁盘文件不受影响。存在未结束任务时服务端拒绝（不自动停止/派发）。
            </div>
          </Modal>
        );
      })() : null}

      {removeProjFor != null ? (() => {
        const p = s.projects.find((x) => x.id === removeProjFor);
        if (p == null) return null;
        return (
          <Modal
            size="sm"
            title={`移除项目「${p.displayName}」`}
            onClose={() => setRemoveProjFor(null)}
            footer={<><div className="spacer" /><button className="btn" onClick={() => setRemoveProjFor(null)}>取消</button><ProjectLifecycleButton projectId={p.id} revision={p.revision} action="remove" danger onDone={() => setRemoveProjFor(null)} /></>}
          >
            <div className="col" style={{ gap: 10 }}>
              <div className="small muted" style={{ lineHeight: 1.75 }}>
                「移除」= 从应用的项目列表解除关联：**不删除磁盘文件、不删除历史记录**（重新打开同一目录即恢复，projectId 不变）。
              </div>
              <div className="small faint">目录：{p.rootPath}</div>
            </div>
          </Modal>
        );
      })() : null}

      {createRoomFor != null ? <CreateRoomModal projectId={createRoomFor} onClose={() => setCreateRoomFor(null)} /> : null}
      {openFolder ? <OpenFolderModal autoPick onClose={() => setOpenFolder(false)} /> : null}

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      {recoveryOpen ? <RecoveryPanel origin={recoveryOrigin} onClose={() => setRecoveryOpen(false)} /> : null}
      {s.ui.toast != null ? (
        <div className="toast-host" role="status" aria-live="polite">
          <button className={`toast ${s.ui.toast.tone}`} onClick={() => clearToast()}>
            <Icon name={s.ui.toast.tone === 'success' ? 'check-circle' : s.ui.toast.tone === 'warn' || s.ui.toast.tone === 'error' ? 'alert-triangle' : 'info'} size={13} className="faint" />
            <span>{s.ui.toast.text}</span>
          </button>
        </div>
      ) : null}
    </>
  );
}

/* ---------------- 路由分派（原型路由表 + 换装期旧路由归一） ---------------- */

function Routes({ path, route, query }: { path: string; route: string; query: Record<string, string> }) {
  const s = useStore((x) => x);
  void route;

  // 线程直达链接 #/thread/:id?message=:mid → 所属房间 + 线程面板（§15.5）
  const threadDirect = path.match(/^\/thread\/([^/?]+)$/);
  if (threadDirect != null) {
    const tid = decodeURIComponent(threadDirect[1] ?? '');
    const ent = (s as { threadEntities?: Record<string, { projectId: string; roomId: string }> }).threadEntities?.[tid];
    // R72：实体已缓存**且归属项目正是活跃项目**才直接渲染——否则 loadThread 的
    // stillCurrent 双门会丢弃装载（切项目后点旧直链=线程面板拿不到数据），走定位器对齐。
    const opening=s.openInFlightTarget;
    // Cached identity does not mean its project refresh finished. Keep the
    // locating component (and its intent) mounted until its whole owned wave
    // settles; early RoomPage handoff cancels it and rolls focus back forever.
    if (ent != null && ent.projectId === s.activeProjectId
      && s.rooms.some(r=>r.projectId===ent.projectId)
      && opening?.projectId!==ent.projectId) {
      return <RoomPage roomId={ent.roomId} threadId={tid} focusedTaskId={query.task} focusedDeliveryId={query.delivery} highlightMessageId={query.message} tab={isThreadTab(query.tab) ? query.tab : undefined} />;
    }
    if(ent!=null&&opening!=null&&opening.projectId!==ent.projectId&&opening.urlSeqAtStart>=currentNavSeq())return <div className="main"><div className="page"><div className="panel info">正在打开项目…</div></div></div>;
    return (
      <div className="main"><div className="page">
        <div className="panel info">正在定位线程（对齐所属项目后自动进入房间）…</div>
        <LocateThread threadId={tid} messageId={query.message} tab={query.tab} focusedTaskId={query.task} focusedDeliveryId={query.delivery}/>
      </div></div>
    );
  }

  if (path === '/' || path === '/welcome' || path === '') return <WelcomePage />;
  if (path === '/dm' || path.startsWith('/dm/')) return <DmPage />;
  if (path === '/archive') return <ArchivePage query={query} />;
  if (path === '/board') return <TasksBoardPage query={query} />;
  if (path === '/library') return <LibraryPage />;
  if (path === '/activity') return <ActivityPage />;
  if (path === '/pending') return <PendingPage />;
  if (path === '/settings') return <SettingsPage query={query} />;
  if (path === '/members') return <MembersPage />;

  let m = path.match(/^\/room\/([^/?]+)$/);
  if (m != null) {
    const pid = s.activeProjectId;
    return pid !== '' ? <RedirectTo to={`/project/${pid}/room/${m[1]}`} /> : <WelcomePage />;
  }
  if (path === '/files') {
    const pid = s.activeProjectId;
    return pid !== '' ? <RedirectTo to={`/project/${pid}/files`} /> : <WelcomePage />;
  }

  m = path.match(/^\/project\/([^/]+)\/room\/([^/?]+)$/);
  if (m != null) {
    const pid = m[1] ?? '';
    // R72：看板/待办/归档会带任务自己的 projectId 跨项目跳房间/线程；房间与线程装载
    // （roomOf/loadThread）绑活跃项目——未对齐时房间报「不存在」、线程被 stillCurrent
    // 丢弃。先对齐（已装载=轻切焦点；未装载=全链打开），对齐后本路由自然重渲 RoomPage。
    // R73：**活跃≠已装载**——applyServerNavPrefs 恢复 active 但房间未装时（冷房间直链）
    // 同样要对齐，否则 RoomPage 落「找不到该房间」（review-r72 §2 源码疑点，先证后修）。
    // R75（review-r74 §P1/§P2）：打开链所有权——
    //  ①**本项目的打开在途**（openInFlightTarget=pid）：保持对齐分支挂载（ProjectAlign
    //    及其意图存活），装载波收尾后自然切 RoomPage。此前房间中途就绪就让 RoomPage 抢挂、
    //    ProjectAlign 卸载释放意图——用户此刻跳走时波内已无主（navigation.set(A) 照写，
    //    review-r74 §P2 反例）；而卸载即取消又会把成功交接误判取消（project.open 循环）。
    //  ②**他项目的用户打开在途**且 URL 自该打开起未变（弹窗期用户点不了侧栏）：本路由是
    //    打开前的陈旧 URL——让位，不抢回焦点（打开动作自身按目标落位导航）。
    const openT = s.openInFlightTarget;
    if (openT != null && openT.projectId === pid) {
      return <div className="main"><div className="page"><div className="panel info">正在打开所属项目…</div><ProjectAlign projectId={pid} /></div></div>;
    }
    if (pid !== s.activeProjectId || !s.rooms.some((r) => r.projectId === pid)) {
      if (openT != null && openT.projectId !== pid && openT.urlSeqAtStart >= currentNavSeq()) {
        return <div className="main"><div className="page"><div className="panel info">正在打开项目…</div></div></div>;
      }
      return <div className="main"><div className="page"><div className="panel info">正在打开所属项目…</div><ProjectAlign projectId={pid} /></div></div>;
    }
    return (
      <RoomPage
        roomId={m[2] ?? ''}
        threadId={query.thread}
        focusedTaskId={query.task} focusedDeliveryId={query.delivery}
        tab={isThreadTab(query.tab) ? query.tab : undefined}
        artifactId={query.artifact}
      />
    );
  }

  m = path.match(/^\/project\/([^/]+)\/files$/);
  if (m != null) return <FilesGitPage projectId={m[1] ?? ''} query={query} />;

  m = path.match(/^\/project\/([^/]+)\/settings$/);
  if (m != null) {
    const pid=m[1]??'';
    const open=s.openInFlightTarget;
    // Settings writes use the same current-project guard as member forms. Mount only
    // after the explicit route's project has settled; otherwise its initial read and
    // guard bind to the previously active project and cannot become usable later.
    if(pid!==s.activeProjectId||open?.projectId===pid) {
      if(open!=null&&open.projectId!==pid&&open.urlSeqAtStart>=currentNavSeq())return <div className="main"><div className="page"><div className="panel info">正在打开项目…</div></div></div>;
      return <div className="main"><div className="page"><div className="panel info">正在打开所属项目…</div><ProjectAlign projectId={pid}/></div></div>;
    }
    return <ProjectSettingsPage key={pid} projectId={pid} query={query} />;
  }

  m = path.match(/^\/project\/([^/]+)\/members$/);
  if (m != null) return <MembersPage projectId={m[1]} />;

  m = path.match(/^\/project\/([^/]+)\/member\/([^/?]+)$/);
  if (m != null) return <MemberDetailPage key={`${m[1]}:${m[2]}`} projectId={m[1] ?? ''} memberId={m[2] ?? ''} />;

  m = path.match(/^\/project\/([^/]+)$/);
  if (m != null) return <ProjectHomePage projectId={m[1] ?? ''} />;

  return <WelcomePage />;
}

function isThreadTab(v: string | undefined): v is 'replies' | 'artifacts' | 'activity' | 'members' | 'task' | 'delivery' | 'deliberation' | 'run' {
  return v === 'replies' || v === 'artifacts' || v === 'activity' || v === 'members' || v === 'task' || v === 'delivery' || v === 'deliberation' || v === 'run';
}

function RedirectTo({ to }: { to: string }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return <div className="main"><div className="page"><div className="small faint">正在打开…</div></div></div>;
}

/** R72：项目路由对齐器（房间/线程跨项目跳转前置）——对齐成功由路由自然重渲接管。
 * R73：意图登记——用户跳走/切项目后，链内每个 await 之后不再抢焦点/写偏好/弹旧错。
 * R75：卸载≠必然取消——**目标已达成**（本项目已活跃且房间已装载=装载波中途路由就
 * 切到 RoomPage 的成功交接）只释放不取消；否则（用户真跳走/组件被替换）才取消。
 * 此前无条件取消会让装载波收尾被误判为取消并回滚整表投影——路由又回对齐分支，
 * 形成 project.open 无限循环（r75 探针 cmds.log 实证）。 */
function ProjectAlign({ projectId }: { projectId: string }) {
  useEffect(() => {
    const intent = registerNavIntent();
    void (async () => {
      const { ensureProjectActive } = await import('./shell');
      try {
        await ensureProjectActive(projectId, intent);
      } catch (e) {
        if (!navIntentActive(intent)) return; // 已取消：不弹旧错误
        toast(`打开所属项目失败：${(e as Error).message}`, 'error');
        navigate('/', { replace: true });
      }
    })();
    return () => {
      // 卸载≠必然取消，判据=**URL 是否仍指向本项目**：
      // ①装载波中途房间就绪、路由自然切到 RoomPage（成功交接）——hash 未变（仍在
      // /project/<pid>/…），只释放不取消（否则装载收尾被误判取消并回滚整表投影，
      // 路由又回对齐分支形成 project.open 无限循环——r75 探针 cmds.log 实证 47k 条）；
      // ②用户跳走（hash 变成设置页/其它项目）——取消，链内安静停+回滚本操作拥有的状态。
      const h = window.location.hash.replace(/^#/, '') || '/welcome';
      const stillOnThisProject = h === `/project/${projectId}` || h.startsWith(`/project/${projectId}/`);
      if (stillOnThisProject !== true) cancelNavIntent(intent);
      releaseNavIntent(intent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  return null;
}

/** 旧线程路由的装载定位（R72：locateThread 对齐所属项目后跳该房间——修跨项目深链丢弃）。
 *  R73：①意图登记（取消后链内不再抢焦点/重试/弹旧错）；②deps 补 message/tab——同一
 *  threadId 快速改定位目标时采用**最新**用户意图，旧 effect 的取消标志随清理置位。 */
function LocateThread({ threadId, messageId, tab,focusedTaskId,focusedDeliveryId }: { threadId: string; messageId?: string; tab?: string;focusedTaskId?:string;focusedDeliveryId?:string }) {
  useEffect(() => {
    const intent = registerNavIntent();
    void (async () => {
      const { locateThread } = await import('./shell');
      try {
        const ent = await locateThread(threadId, intent); // {projectId, roomId}——项目已对齐激活
        if (!navIntentActive(intent)) return;
        const q = new URLSearchParams();
        q.set('thread', threadId);
        if (tab != null && tab !== 'replies') q.set('tab', tab);
        if (messageId != null) q.set('message', messageId);
        if(focusedTaskId)q.set('task',focusedTaskId);
        if(focusedDeliveryId)q.set('delivery',focusedDeliveryId);
        navigate(`/project/${ent.projectId}/room/${ent.roomId}?${q.toString()}`, { replace: true });
      } catch (e) {
        if (!navIntentActive(intent)) return; // 已取消：不弹旧错误
        // 真实原因分列（review-r72 §1）：不存在/权限/装载失败按服务端与链路原话，不用「不可访问」覆盖一切。
        toast(`打开回复串失败：${(e as Error).message}`, 'error');
        navigate('/', { replace: true });
      }
    })();
    return () => { cancelNavIntent(intent); releaseNavIntent(intent); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, messageId, tab,focusedTaskId,focusedDeliveryId]);
  return null;
}
/* DM 页自渲染共享预览（R66 P2：原型 320/440/480 宽度降级 + 列表收起 + 单区切换在
   DmPage 内实现——App 不再相邻拼一个无宽度规则的 PreviewPane）。 */

/* ---------------- 项目生命周期/信息编辑弹窗按钮（真实命令） ---------------- */

function ProjectLifecycleButton({ projectId, revision, action, danger, onDone }: { projectId: string; revision: number; action: 'archive' | 'remove'; danger?: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={danger === true ? 'btn danger' : 'btn primary'}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void projectLifecycleReal(projectId, revision, action).then((r) => {
          setBusy(false);
          onDone();
          if (r.ok) toast(action === 'archive' ? '项目已归档（历史保留只读）' : '项目已移除关联（磁盘与历史不动；重新打开同目录即恢复）', 'success');
          else toast(`${action === 'archive' ? '归档' : '移除'}被拒：${r.error}`, 'error');
        });
      }}
    >
      {action === 'archive' ? '归档项目' : '移除项目'}
    </button>
  );
}

function EditProjectInfoModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const s = useStore((x) => x);
  const p = s.projects.find((x) => x.id === projectId);
  const [name, setName] = useState(p?.displayName ?? '');
  const [desc, setDesc] = useState(p?.description ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (p == null) return null;
  return (
    <Modal
      size="sm"
      title="编辑项目信息"
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={busy || !name.trim()}
            onClick={() => {
              setBusy(true); setErr(null);
              void updateProjectReal(projectId, p.revision, { displayName: name.trim(), description: desc }).then((r) => {
                setBusy(false);
                if (r.ok) { toast('已保存（revision 乐观锁通过，回读一致）', 'success'); onClose(); }
                else { setErr(r.error ?? '未知错误'); toast(`保存失败：${r.error}（输入保留）`, 'error'); }
              });
            }}
          >
            保存
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="field">
          <label className="field-label">显示名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="项目显示名" />
          <div className="field-hint">只改应用里的显示名称，**不会**重命名磁盘目录。</div>
        </div>
        <div className="field">
          <label className="field-label">描述（可选）</label>
          <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="例如：订单表回填与数据修复" />
        </div>
        {err != null ? <div className="panel warning">保存失败：{err}（若项目已被他端修改请刷新重试）</div> : null}
        <div className="small faint">目录：{p.rootPath} · revision {p.revision}</div>
      </div>
    </Modal>
  );
}
