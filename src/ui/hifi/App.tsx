/**
 * 正式外壳（H1 首包，第四十六轮）：按已批准原型的侧栏三段式结构（§17.1/第十五批）组合——
 * 上四固定入口 + 项目滚动区 + 底部固定区；主区路由 房间/私信。**尚未换装的入口经
 * 「原界面」整体接管**（同一页面 legacy root），入口如实标注，不用禁用假装。
 */
import { useEffect } from 'react';
import { Icon } from './components/Icon';
import { NavUnreadDot } from './components/NavMarks';
import { useStore, toast, clearToast, hifiUi } from './shell';
import { navigate, pathOf, useHashRoute } from './lib/router';
import { RoomPage } from './RoomPage';
import { DmPage } from './DmPage';
import { dmUnreadTotal, roomsOfProject } from './data/selectors';

/** 进入「原界面」（未换装能力接管）：启动 legacy app 一次并切换显示；退出按钮由 shell 注入。 */
export function takeLegacy(reason: string): void {
  const w = window as unknown as { __zsLegacyStart?: () => void; __zsLegacyStarted?: boolean };
  if (w.__zsLegacyStart != null && w.__zsLegacyStarted !== true) { w.__zsLegacyStart(); w.__zsLegacyStarted = true; }
  document.body.classList.add('legacy-on');
  hifiUi().legacyEnter(reason);
}

export default function App() {
  const route = useHashRoute();
  const s = useStore((x) => x);
  const path = pathOf(route);
  const legacyActive = useStore((x) => (x as { legacyActive?: boolean }).legacyActive === true);

  // legacy 接管时的「返回新界面」按钮：注入 body（#hifi-root 已被隐藏，不能挂在壳内）。
  useEffect(() => {
    if (!legacyActive) return;
    const btn = document.createElement('button');
    btn.className = 'btn ghost sm zs-legacy-exit';
    btn.textContent = '⌂ 返回新界面';
    btn.title = '回到换装壳（原型风格界面）';
    btn.onclick = () => { document.body.classList.remove('legacy-on'); };
    document.body.append(btn);
    return () => { btn.remove(); };
  }, [legacyActive]);

  useEffect(() => { document.documentElement.dataset.theme = (s.ui as { theme?: string }).theme ?? 'light'; }, [(s.ui as { theme?: string }).theme]);

  const project = s.projects.find((p) => p.id === s.activeProjectId);
  const rooms = project ? roomsOfProject(s, project.id) : [];
  const dmUnread = dmUnreadTotal(s);
  const sideItem = (active: boolean, title: string, icon: Parameters<typeof Icon>[0]['name'], label: string, onClick: () => void, marks?: true | React.ReactNode) => (
    <button className={`side-item${active ? ' active' : ''}`} title={title} onClick={onClick}>
      <Icon name={icon} size={14} />
      <span className="side-item-label">{label}</span>
      {marks === true ? null : marks}
    </button>
  );
  const legacyEntry = (icon: Parameters<typeof Icon>[0]['name'], label: string, title: string) =>
    sideItem(false, `${title}（尚未换装——进入原界面操作）`, icon, label, () => takeLegacy(title));

  return (
    <div className="app">
      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-top">
            {legacyEntry('bookmark', '搜索与收藏', '搜索与收藏')}
            {legacyEntry('diff', '文件与 Git', '文件与 Git（按原型归位在 H3——当前经原界面）')}
            {legacyEntry('list', '任务看板', '任务看板')}
            {legacyEntry('users', '成员管理', '成员管理')}
            {sideItem(path === '/dm', '私信：本项目一对一会话', 'message-square', '私信', () => navigate('/dm'),
              <span className="side-marks"><NavUnreadDot count={dmUnread} where="私信" /></span>)}
          </div>
          <div className="sidebar-scroll">
            <div className="side-heading">项目</div>
            {project == null ? (
              <div className="side-empty">
                {(s.ui as { booted?: boolean }).booted ? '尚未打开项目' : '正在连接服务…'}
                <button className="btn ghost sm" onClick={() => void hifiUi().pickAndOpenFolder()}>打开文件夹</button>
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
            {legacyEntry('inbox', '待我处理', '待我处理')}
            {legacyEntry('settings', '设置', '应用设置')}
          </div>
        </aside>

        <main className="workspace">
          {path.startsWith('/room/') ? <RoomPage roomId={path.slice('/room/'.length)} /> : <DmPage />}
        </main>
      </div>

      {(s.ui as { toast?: { text: string } | null }).toast != null ? (
        <div className="toast" onClick={() => clearToast()}>{(s.ui as { toast: { text: string } }).toast.text}</div>
      ) : null}
    </div>
  );
}
