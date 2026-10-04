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
import { navigate, pathOf, useHashRoute } from './lib/router';
import { RoomPage } from './RoomPage';
import { DmPage } from './DmPage';
import { dmUnreadTotal, roomsOfProject } from './data/selectors';

/** 定向接管目标 → legacy 既有控件/面板（review-r46 §6：切换后必须落在对应页面）。 */
const LEGACY_TARGETS: Record<string, { label: string; locate: () => string | null }> = {
  search: { label: '搜索与收藏', locate: () => openDetails('search-panel') },
  git: { label: '文件与 Git', locate: () => togglePanel('files-toggle', 'files') },
  tasks: { label: '任务看板', locate: () => togglePanel('board-toggle', 'board') },
  members: { label: '成员管理', locate: () => openDetails('project-settings') },
  pending: { label: '待我处理', locate: () => document.getElementById('pending-list')?.scrollIntoView({ block: 'start' }) ?? '未找到待我处理列表' },
  settings: { label: '应用设置', locate: () => openDetails('help-panel') },
};

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

/** 进入「原界面」（定向接管）：启动 legacy 一次→按目标定位→卸载 hifi 样式；返回时恢复。 */
export function takeLegacy(targetKey: string): void {
  const target = LEGACY_TARGETS[targetKey] ?? { label: targetKey, locate: () => null };
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

  // legacy 接管时的「返回新界面」：恢复样式、暂停旧端轮询、刷新当前数据。
  useEffect(() => {
    if (!legacyActive) return;
    const btn = document.createElement('button');
    btn.className = 'btn ghost sm zs-legacy-exit';
    btn.textContent = '⌂ 返回新界面';
    btn.title = '回到换装壳（原型风格界面）——恢复样式并刷新数据';
    btn.onclick = () => {
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
  const legacyItem = (key: string, icon: Parameters<typeof Icon>[0]['name'], label: string, title: string) => (
    <button className="side-item" title={`${title}（尚未换装——进入原界面并定位）`} onClick={() => takeLegacy(key)}>
      <Icon name={icon} size={14} />
      <span className="side-item-label">{label}</span>
    </button>
  );

  return (
    <HifiErrorBoundary>
      <div className="app">
        <div className="app-body">
          <aside className="sidebar">
            <div className="sidebar-top">
              {legacyItem('search', 'bookmark', '搜索与收藏', '搜索与收藏')}
              {legacyItem('git', 'diff', '文件与 Git', '文件与 Git（H3 按原型归位——当前经原界面定位）')}
              {legacyItem('tasks', 'list', '任务看板', '任务看板')}
              {legacyItem('members', 'users', '成员管理', '成员管理')}
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
              {legacyItem('pending', 'inbox', '待我处理', '待我处理')}
              {legacyItem('settings', 'settings', '设置', '应用设置')}
            </div>
          </aside>

          <main className="workspace">
            {path.startsWith('/room/') ? <RoomPage roomId={path.slice('/room/'.length)} /> : <DmPage />}
          </main>
        </div>

        {s.ui.toast != null ? (
          <div className="toast" onClick={() => clearToast()}>{s.ui.toast.text}</div>
        ) : null}
      </div>
    </HifiErrorBoundary>
  );
}
