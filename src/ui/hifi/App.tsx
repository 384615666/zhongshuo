/**
 * 正式外壳（H1 首包，第四十七轮修订）：原型侧栏三段式（§17.1/第十五批）+ 主区路由 房间/私信。
 * 未换装入口经「原界面」**定向接管**（takeLegacy(target) 按 legacy 既有面板/开关定位到对应
 * 页面——不要求用户在旧界面再找一次）；接管期间卸载 hifi 样式（原型全局选择器不污染旧界面），
 * 返回时恢复样式与数据刷新；启动/渲染失败由 ErrorBoundary 与页面看门狗兜底回退。
 */
import { Component, useEffect, type ReactNode } from 'react';
import { Icon } from './components/Icon';
import { NavUnreadDot } from './components/NavMarks';
import { useStore, toast, clearToast, hifiUi, refreshRooms, refreshDms } from './shell';
import { getState } from './data/store';
import { navigate, pathOf, parseQuery, useHashRoute } from './lib/router';
import { isExternalDeepLink } from './lib/deepLink';
import { openExternalDeepLink } from './loader';
import { RoomPage } from './RoomPage';
import { DmPage } from './DmPage';
import { ThreadPage } from './ThreadPage';
import { BoardPage } from './BoardPage';
import { FilesPage } from './FilesPage';
import { SettingsPage } from './SettingsPage';
import { MembersPage } from './MembersPage';
import { PendingPage } from './PendingPage';
import { LibraryPage } from './LibraryPage';
import { ActivityPage } from './ActivityPage';
import { TitleBar } from './components/TitleBar';
import { PreviewPane } from './preview/PreviewPane';
import { dmUnreadTotal, roomsOfProject } from './data/selectors';

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
  const legacyActive = useStore((x) => x.legacyActive === true);

  useEffect(() => { document.documentElement.dataset.theme = s.ui.theme; }, [s.ui.theme]);

  // 外部深链族（#dm=/#task=/#delivery=/#msg=）规范化（review-r50 §4）：deepLink.resolve 服务端
  // 定位实体 → 跨项目先开真实项目 → 内部路由（斜杠形态，刷新/前进后退可再解析）。失败如实
  // 报错，不静默跳转；legacy 接管期间由旧界面处理（本入口不抢导航）。
  // 注意用**完整 route**（含 query）判深链族——path 是 pathOf 去过 query 的（review-r51 §3.2）。
  useEffect(() => {
    if (!isExternalDeepLink(`#${route}`)) return;
    if (document.body.classList.contains('legacy-on')) return;
    let cancelled = false;
    void openExternalDeepLink(`#${route}`)
      .catch((e: unknown) => { if (!cancelled) toast(`深链打开失败：${(e as Error).message}`, 'error'); });
    return () => { cancelled = true; };
  }, [route]);

  // legacy 接管时的「返回新界面」：恢复样式、暂停旧端轮询、刷新当前数据。
  useEffect(() => {
    if (!legacyActive) return;
    const btn = document.createElement('button');
    btn.className = 'btn ghost sm zs-legacy-exit';
    btn.textContent = '⌂ 返回新界面';
    btn.title = '回到换装壳（原型风格界面）——恢复样式并刷新数据';
    btn.onclick = () => {
      takeoverToken += 1; // 取消在途定位重试
      document.body.classList.remove('legacy-on');
      (window as unknown as { __zsLegacySetVisible?: (v: boolean) => void }).__zsLegacySetVisible?.(false); // 暂停隐藏端轮询
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

  return (
    <>
      {/* 标题栏（portal 到 #zs-titlebar，错误边界之外）：子树渲染失败时窗口控制仍在；
          React 整体失败由 hifi-flag.js 看门狗重建最小壳兜底。 */}
      <TitleBar />
      <HifiErrorBoundary>
        <div className="app">
        <div className="app-body">
          <aside className="sidebar">
            <div className="sidebar-top">
              <button
                className={`side-item${path === '/library' ? ' active' : ''}`}
                title="搜索与收藏：消息/线程/任务标题检索（search.query——附件随所在消息）+ 收藏列表（saved.list）"
                onClick={() => navigate('/library')}
              >
                <Icon name="bookmark" size={14} />
                <span className="side-item-label">搜索与收藏</span>
              </button>
              <button
                className={`side-item${path === '/activity' ? ' active' : ''}`}
                title="活动流：domain_events 只读聚合（全部可访问项目/当前项目）——定位任务/会话"
                onClick={() => navigate('/activity')}
              >
                <Icon name="activity" size={14} />
                <span className="side-item-label">活动流</span>
              </button>
              <button
                className={`side-item${path === '/files' ? ' active' : ''}`}
                title="文件与 Git：Files 集合四类分列（只读）+ Git 诊断（状态/diff——写操作经原界面）"
                onClick={() => navigate('/files')}
              >
                <Icon name="diff" size={14} />
                <span className="side-item-label">文件与 Git</span>
              </button>
              <button
                className={`side-item${path === '/board' ? ' active' : ''}`}
                title="任务看板：board.view 只读聚合——卡片定位线程详情后执行停止/验收"
                onClick={() => navigate('/board')}
              >
                <Icon name="list" size={14} />
                <span className="side-item-label">任务看板</span>
              </button>
              <button
                className={`side-item${path === '/members' ? ' active' : ''}`}
                title="成员管理：项目成员/房间名单/协调者与启用状态（正式命令）"
                onClick={() => navigate('/members')}
              >
                <Icon name="users" size={14} />
                <span className="side-item-label">成员管理</span>
              </button>
              <button className={`side-item${path === '/dm' || path.startsWith('/dm/') ? ' active' : ''}`} title="私信：本项目一对一会话" onClick={() => navigate('/dm')}>
                <Icon name="message-square" size={14} />
                <span className="side-item-label">私信</span>
                <span className="side-marks"><NavUnreadDot count={dmUnread} where="私信" /></span>
              </button>
            </div>
            <div className="sidebar-scroll">
              <div className="side-heading">项目</div>
              {project == null ? (
                <div className="side-empty">
                  {s.boot === 'pending' ? '正在连接服务…' : s.boot === 'failed' ? `启动失败：${s.bootError ?? '未知'}` : '尚未打开项目'}
                  <button className="btn ghost sm" onClick={() => void hifiUi().pickAndOpenFolder()}>打开文件夹</button>
                  {s.boot === 'failed' ? <button className="btn ghost sm" onClick={() => location.reload()}>重试</button> : null}
                </div>
              ) : (
                <div className="side-project">
                  <div className="side-row context-active">
                    <button className="side-item-label-btn" title={`项目：${project.displayName}`}>
                      <Icon name="folder" size={13} />
                      <span className="side-item-label">{project.displayName}</span>
                    </button>
                  </div>
                  {rooms.map((room) => (
                    <button
                      key={room.id}
                      className={`side-item side-room${path === `/room/${room.id}` ? ' active' : ''}`}
                      title={`房间：${room.name}`}
                      onClick={() => navigate(`/room/${room.id}`)}
                    >
                      <Icon name="message-circle" size={14} />
                      <span className="side-item-label">{room.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="sidebar-foot">
              <button
                className={`side-item${path === '/pending' ? ' active' : ''}`}
                title="待我处理：权威业务状态汇总（待验收/未读/阻塞/待确认提醒——mine.pending）"
                onClick={() => navigate('/pending')}
              >
                <Icon name="inbox" size={14} />
                <span className="side-item-label">待我处理</span>
              </button>
              <button
                className={`side-item${path === '/settings' ? ' active' : ''}`}
                title="设置与帮助：应用设置/远程事实（只读）/打开定位；未换装项定向原界面"
                onClick={() => navigate('/settings')}
              >
                <Icon name="settings" size={14} />
                <span className="side-item-label">设置与帮助</span>
              </button>
            </div>
          </aside>

          <main className="workspace">
            {path.startsWith('/thread/') ? (
              (() => {
                // 从**完整 route**（含 query）解析线程参数——path 已被 pathOf 去掉查询串，
                // 此前 ?tab=/?message= 永远取不到（review-r51 §3.2）。
                const idAndQuery = route.slice('/thread/'.length);
                const q = parseQuery(idAndQuery);
                const id = pathOf(idAndQuery);
                return <ThreadPage threadId={decodeURIComponent(id)} initialTab={q.tab} highlightMessageId={q.message} />;
              })()
            ) : path.startsWith('/room/') ? (
              <RoomPage roomId={path.slice('/room/'.length)} />
            ) : path === '/board' ? (
              <BoardPage />
            ) : path === '/files' ? (
              <FilesPage />
            ) : path === '/library' ? (
              <LibraryPage />
            ) : path === '/activity' ? (
              <ActivityPage />
            ) : path === '/settings' ? (
              <SettingsPage />
            ) : path === '/members' ? (
              <MembersPage />
            ) : path === '/pending' ? (
              <PendingPage />
            ) : (
              <DmPage />
            )}
          </main>
        </div>

        {s.ui.toast != null ? (
          <div className="toast" onClick={() => clearToast()}>{s.ui.toast.text}</div>
        ) : null}
        <PreviewPane />
      </div>
      </HifiErrorBoundary>
    </>
  );
}
