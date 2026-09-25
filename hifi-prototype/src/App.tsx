/**
 * 应用外壳：顶部栏 + 左侧栏 + 路由 + 全局浮层
 *
 * 布局依据 §17.1：顶部一条全局状态区（当前项目 / 后台任务 / 项目全停 / 设置），
 * 左侧项目与成员，中间房间主池，右侧任务回复串（窄窗改为全屏覆盖）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './components/Icon';
import { Menu, MenuItem, Modal, Switch, Tag, ErrorState } from './components/ui';
import { useStore, setTheme, clearToast } from './data/store';
import {
  coordinatorOfRoom, memberLabel, projectUnread, roomUnread, roomsOfProject,
} from './data/selectors';
import { confirmStartupResume, dismissStartupRecovery } from './data/actions';
import { focusProject, revealProjectForDeepLink, toggleProjectExpanded, toggleProjectVisible } from './data/actions-nav';
import { setNavAutoHidden } from './data/actions-preview';
import { navigate, parseQuery, pathOf, useHashRoute } from './lib/router';
import { RoomPage } from './pages/Room';
import { ActivityPage, LibraryPage, ProjectHomePage, WelcomePage } from './pages/pages-secondary';
import { FilesGitPage, MemberDetailPage, MembersPage } from './pages/pages-misc';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { SettingsPage } from './pages/SettingsPage';
import { TasksBoardPage } from './pages/pages-task';
import { DmPage } from './pages/Dm';
import { CommandPalette } from './components/CommandPalette';
import { TitleBar } from './components/TitleBar';
import {
  isThreadTabKey,
  resolveLegacyDeepLink,
  resolveThreadLink,
  targetForThread,
  threadHash,
} from './lib/threadNav';

export default function App() {
  const route = useHashRoute();
  // 原型一次订阅整个状态：写操作都会重建状态对象，因此每次写入都会重渲染。
  const s = useStore((x) => x);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(null);
  /** 侧栏项目行的「⋯」菜单（第十六批）：记录是哪个项目，以及菜单坐标 */
  const [projectMenuFor, setProjectMenuFor] = useState<string | null>(null);
  const [projectMenuAt, setProjectMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** 顶栏项目菜单里的项目搜索词（项目多时用得上） */
  const [projectFilter, setProjectFilter] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = s.ui.theme;
  }, [s.ui.theme]);

  // 允许用 URL 固定主题，便于分享与截图：#/room/xxx?theme=dark
  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('theme');
    if (t === 'dark' || t === 'light') {
      if (t !== s.ui.theme) setTheme(t);
    }
    // 只在首次挂载时读取，之后由界面按钮控制
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+K / ⌘K 全局搜索（§27.11）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // 首次进入显示恢复检查（E7：不自动续跑）。
  // 只在"启动落点"（欢迎页 / 项目主页）自动弹出；深链直接进线程时不遮住记录，
  // 改为在顶部栏保留一个可点开的入口。
  const [recoveryShown, setRecoveryShown] = useState(false);
  const path = pathOf(route);
  const query = parseQuery(route);
  // 启动恢复弹窗只在「欢迎页」自动弹一次：项目主页/深链不再被遮住，顶栏「恢复检查」入口始终保留
  const startupLanding = path === '/welcome' || path === '/';
  // ?recovery=0 抑制自动弹出（截图、分享用）；顶部栏入口始终保留
  const suppressRecovery = query.recovery === '0';

  useEffect(() => {
    if (!recoveryShown && !suppressRecovery && s.startupRecovery.needsAttention && startupLanding) {
      setRecoveryOpen(true);
      setRecoveryShown(true);
    }
  }, [s.startupRecovery.needsAttention, recoveryShown, startupLanding, suppressRecovery]);

  const activeProject = s.projects.find((p) => p.id === s.activeProjectId) ?? s.projects[0];

  /**
   * 单项目页统一同步焦点 + 深链补选（第十五批 §17.7）。
   *
   * 只在**确实需要改变状态**时才写：这个 effect 的依赖里含 activeProjectId 与
   * visibleProjectIds，一旦无条件 setState 就会与"正在进行的重定向"互相打断
   * （实测：旧深链 /task/:id 重定向到 tab 后线程面板渲染不出来）。
   * 因此所有分支都先判断"是否已经满足"，满足就直接返回，不触发写入。
   *
   * 判定"这个 URL 代表哪个项目"的规则（漏一条就会出现
   * "地址栏写着 A、页面在操作 B"）：
   *  1. `/project/:id/...` —— 路径里直接带项目（含项目设置单页）
   *  2. `?scope=project&projectId=X` —— 聚合页（看板/搜索）的单项目范围
   *  3. `/settings?section=<项目类>&projectId=X` —— **仅当 section 明确属于项目**时。
   *     第十六批 §17.8 要求"先规范化路由，再同步焦点"：应用设置链接上若残留
   *     无意义的 projectId，**不能**据此切换焦点（否则一个被改过的应用链接
   *     会悄悄把当前项目换掉）。所以这里必须看 section 的归属，不能见 projectId 就认。
   *     历史教训：这条判定曾连续漏两次（先是整个设置段、再是扁平分区名），
   *     那次矫枉过正成"任何 projectId 都认"；现在按 §17.8 收窄为**按 section 归属判断**。
   *  4. 旧 `/dm/:memberId` —— 按成员实体解析其所属项目（不能靠当前项目猜）
   */
  const urlProjectId = useMemo(() => {
    const m = path.match(/^\/project\/([^/]+)(?:\/|$)/);
    if (m) return m[1];
    // 看板/搜索的单项目范围
    if (query.scope === 'project' && query.projectId) return query.projectId;
    // 设置页：只有项目类 section 才认其中的 projectId
    if (path === '/settings' && query.projectId) {
      const sec = query.section;
      const isProjectSection =
        sec === 'project' || sec === 'collab' || sec === 'budget' || sec === 'write';
      if (isProjectSection) return query.projectId;
      // 应用类 section（general/runtime/lan/diagnostics/errors/app/reminders 或空）：
      // 忽略残留的 projectId —— 路由层会把它清掉，这里也不切焦点
      return undefined;
    }
    // 旧 /dm/:memberId：按成员实体解析其所属项目
    const dm = path.match(/^\/dm\/([^/]+)$/);
    if (dm) return s.members.find((x) => x.id === dm[1])?.projectId;
    return undefined;
  }, [path, query.projectId, query.scope, query.section, s.members]);

  useEffect(() => {
    if (!urlProjectId) return;
    const needFocus = urlProjectId !== s.activeProjectId;
    const needReveal = !s.visibleProjectIds.includes(urlProjectId);
    if (!needFocus && !needReveal) return;
    if (!s.projects.some((p) => p.id === urlProjectId)) return;
    revealProjectForDeepLink(urlProjectId, { announce: needReveal });
  }, [urlProjectId, s.activeProjectId, s.visibleProjectIds, s.projects]);

  /* activeTaskCount / runningCount 已随「项目全停」一起移到 ProjectSettingsPage。
     顺便修掉一个语义问题：原来的 runningCount 是**全局** turn 数，没按项目过滤，
     而项目全停只作用于当前项目 —— 摆在那个弹窗里会显示别的项目的数字。
     新位置按项目重算（见 ProjectSettingsPage 的 runningTurnCount）。 */

  /**
   * 待办角标（v1.12 §10.5 第 7 条）。
   *
   * 验收数量必须**按交付去重**：同一交付可能牵涉多个文件、多个 ChangeSet、
   * 多次 commit，但用户只需要做**一个**决定，所以不能各算一次。
   * 权限请求（approval）与其它动作类待办仍按条计，不混进交付计数。
   */
  const pendingAction = (() => {
    const others = s.attention.filter((a) => a.requiresAction && !a.readAt && a.kind !== 'review').length;
    const reviewDeliveries = new Set(
      s.attention
        .filter((a) => a.kind === 'review' && a.requiresAction && !a.readAt && a.deliveryId)
        .map((a) => a.deliveryId!),
    ).size;
    return others + reviewDeliveries;
  })();
  const savedCount = s.messages.filter((m) => m.saved).length;

  /* ---------- 侧栏当前页高亮 ----------
     之前所有侧栏项都没有 active 状态，任何页面都只高亮"当前项目"，
     用户读完一页后无法从侧栏确认自己在哪（实测：8 个页面全部只高亮「众说」）。
     这里按 path 判定，项目/房间/成员/功能页各自命中自己那一项。 */
  const navActive = {
    activity: path === '/activity',
    // §17.7：搜索与收藏合为 /library，旧 /saved 会被重定向过来
    library: path === '/library' || path === '/saved',
    tasks: path === '/tasks',
    // 成员管理现在带 projectId；旧 /members 会规范化到该路径
    members: /^\/project\/[^/]+\/members$/.test(path) || path === '/members' || /^\/member\//.test(path),
    // 文件与 Git 合页：两个旧路由都会被重定向到 /files
    files: /^\/project\/[^/]+\/(files|changes|git)$/.test(path),
    settings: path === '/settings' || path === '/runtimes',
    /**
     * 项目设置（第十六批）：独立路由 `/project/:id/settings`。
     * 它**不算**底部「设置」的当前位置 —— 否则两个入口同时看起来是当前页
     * （§17.8 明确要求：项目页时底部设置不高亮，应用页才高亮）。
     */
    projectSettings: /^\/project\/[^/]+\/settings$/.test(path),
    dm: path === '/dm' || path.startsWith('/dm/') || /^\/project\/[^/]+\/dm/.test(path),
  };
  /** 房间页：只有当前房间那一项高亮（含线程深链，因为线程属于房间） */
  const roomMatch = path.match(/^\/project\/([^/]+)\/room\/([^/]+)$/);
  const activeRoomId = roomMatch?.[2];
  /** 私信高亮要落到具体项目，避免"哪个项目的私信"含糊 */
  const dmProjectId = (path.match(/^\/project\/([^/]+)\/dm/) ?? [])[1] ?? s.activeProjectId;

  /**
   * 侧栏列出的是"可见项目"而不是全部项目（第十五批 §17.1）。
   * 顺序按 visibleProjectIds 保存的顺序，**不因切换焦点而重排**（§17.7）。
   */
  const visibleProjects = s.visibleProjectIds
    .map((id) => s.projects.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  return (
    <div className="app">
      {/* 桌面客户端自绘标题栏（取代浏览器/系统标题栏）。
          第二十六批：应用内那条 46px 顶部工具栏已整条去掉，
          它承载的内容分到 标题栏（外壳职责）/ 侧栏（项目与导航）/ 应用设置（配置项）。
          折叠侧栏的按钮也在这里 —— 侧栏折起来后自身不可见，入口不能再放在侧栏里。 */}
      <TitleBar
        sidebarOpen={sidebarOpen && !s.layout.navAutoHidden}
        onToggleSidebar={() => {
          /**
           * 用户显式点折叠按钮时：
           *  - 若当前是"自动临时隐藏"，这一下视为**要它回来**（解除自动隐藏）；
           *  - 否则走原有的手动折叠/展开。
           * 不这样做的话，自动隐藏期间点按钮会出现"点了没反应"
           * （按钮读的是 `sidebarOpen && !navAutoHidden`，而它只翻 sidebarOpen）。
           */
          if (s.layout.navAutoHidden) {
            setNavAutoHidden(false);
            setSidebarOpen(true);
            return;
          }
          setSidebarOpen((v) => !v);
        }}
        onOpenRecovery={() => setRecoveryOpen(true)}
      />

      <div className="app-body">
        {/* ================= 左侧栏（第十五批 §17.1）=================
            三段式，各段职责不同：
              上部固定区 — 四个功能入口，顺序不可调换，不随滚动
              中部滚动区 — 只列"顶栏勾选的可见项目"，项目多时只滚这里
              底部固定区 — 待我处理、设置，必须始终可达

            为什么功能入口与项目分开：功能页是"去哪"（全局，与项目无关），
            项目/房间是"在谁那里"（上下文）。混在一个滚动列表里时，项目一多
            就会把功能入口顶出视口（第十三批实测：窄窗最后一项不可达）。
            成员列表不再放这里：已由「成员管理」页承担，重复摆会挤占导航高度。 */}
        {sidebarOpen && !s.layout.navAutoHidden ? (
          <aside className="sidebar">
            {/* ---- 侧栏最顶部：当前项目选择器（第二十六批）----
                原来在应用内顶栏里。移到这里的理由：它管的就是下面那个"项目"列表，
                选择器和被选择的对象放在一起才顺手；顶栏那条整行因此可以去掉。
                展开后就是原来的项目菜单（勾选"显示在侧栏" + 切换当前项目 + 打开文件夹），
                动作完全没变，只是入口换了位置。 */}
            <div className="sidebar-project">
              <button
                className="side-project-picker"
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setProjectMenu({ x: r.left, y: r.bottom + 4 });
                }}
                title="显示在侧栏的项目 / 切换当前项目 / 打开文件夹"
              >
                <Icon
                  name={activeProject.status === 'missing' ? 'alert-triangle' : 'folder'}
                  size={14}
                  className={activeProject.status === 'missing' ? 'warn-icon' : 'faint'}
                />
                <span className="side-project-picker-name">{activeProject.displayName}</span>
                {/* 收起成一行后，"还有别的项目在列表里"要提示出来（§17.1 的"显示 N 个项目"） */}
                {s.visibleProjectIds.length > 1 ? (
                  <span className="side-project-picker-count">显示 {s.visibleProjectIds.length} 个</span>
                ) : null}
                <Icon name="chevron-down" size={12} className="faint" />
              </button>
              {activeProject.status === 'missing' ? (
                <div className="side-project-warn" title={activeProject.rootPath}>
                  目录失效，成员无法读写
                </div>
              ) : null}
            </div>

            {/* ---- 上部固定：四个功能入口 ---- */}
            <div className="sidebar-top">
              {/* 「搜索与收藏」在左，全局搜索（Ctrl+K）是它**右边**的小按钮、贴近侧栏右边缘
                  （用户第二十六批反馈：放收藏右边更顺手）。
                  这一行仍要让图标落在 x=32 那条基线上，与另外三个入口齐平 ——
                  所以行内条目保留 24px 左内边距，图标按钮用 margin-left:auto 顶到右边。 */}
              <div className="side-row-flat">
                <button
                  className={`side-item${navActive.library ? ' active' : ''}`}
                  onClick={() => navigate(`/library?tab=search&scope=project&projectId=${activeProject.id}`)}
                  title="搜索与收藏：同一页内两个标签，默认当前项目范围"
                >
                  <Icon name="bookmark" size={14} />
                  <span className="side-item-label">搜索与收藏</span>
                  {savedCount > 0 ? <span className="small faint">{savedCount}</span> : null}
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
                onClick={() => navigate(`/project/${activeProject.id}/files`)}
                title="文件与 Git：同一项目页内两个标签"
              >
                <Icon name="diff" size={14} />
                <span className="side-item-label">文件与 Git</span>
                {/* 角标 = 工作区未提交改动数。它**不是**审批数：验收属于任务交付
                    （v1.12 §10.5），普通 Git 改动数不能混作审批数（§17.1）。 */}
                {(() => {
                  const g = s.git[activeProject.id];
                  const n = g ? g.status.length : 0;
                  return n > 0 ? <Tag tone="info" icon="diff">{n}</Tag> : null;
                })()}
              </button>

              <button
                className={`side-item${navActive.tasks ? ' active' : ''}`}
                onClick={() => navigate('/tasks?scope=visible')}
                title="任务看板：默认按侧栏可见项目分组"
              >
                <Icon name="list" size={14} />
                <span className="side-item-label">任务看板</span>
              </button>

              <button
                className={`side-item${navActive.members ? ' active' : ''}`}
                onClick={() => navigate(`/project/${activeProject.id}/members`)}
                title="成员管理：页内可切换项目，与顶栏同步"
              >
                <Icon name="users" size={14} />
                <span className="side-item-label">成员管理</span>
              </button>
            </div>

            {/* ---- 中部滚动：可见项目 + 房间 + 私信 ---- */}
            <div className="sidebar-scroll">
              <div className="side-heading">
                项目
                <button title="打开文件夹作为新项目" onClick={() => navigate('/welcome')}>
                  <Icon name="plus" size={13} />
                </button>
              </div>

              {visibleProjects.length === 0 ? (
                <div className="side-empty">
                  没有显示中的项目
                  <button className="btn ghost sm" onClick={() => navigate('/welcome')}>打开文件夹</button>
                </div>
              ) : null}

              {visibleProjects.map((p) => {
                const unread = projectUnread(s, p.id);
                const isCurrent = p.id === activeProject.id;
                const expanded = s.expandedProjectIds.includes(p.id);
                const rooms = roomsOfProject(s, p.id);
                const dms = s.dms.filter((d) => d.projectId === p.id && !d.archivedAt);
                return (
                  <div key={p.id} className="side-project">
                    <div className={`side-row${isCurrent ? ' context-active' : ''}`}>
                      {/* 展开箭头与"切换项目"是两个动作，必须分开点：
                          点箭头只看房间列表，点名字才切当前项目。 */}
                      <button
                        className="side-caret"
                        title={expanded ? '收起房间列表' : '展开房间列表'}
                        onClick={(e) => { e.stopPropagation(); toggleProjectExpanded(p.id); }}
                      >
                        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
                      </button>
                      <button
                        className="side-item-label-btn"
                        onClick={() => {
                          focusProject(p.id);
                          const first = s.rooms.find((r) => r.projectId === p.id && !r.archivedAt);
                          navigate(first ? `/project/${p.id}/room/${first.id}` : `/project/${p.id}`);
                        }}
                        title={p.rootPath}
                      >
                        <Icon name={p.status === 'missing' ? 'alert-triangle' : 'folder'} size={14} />
                        <span className="side-item-label">{p.displayName}</span>
                        {/* "当前"是上下文标记，与"我在哪一页"的位置高亮不是一回事 */}
                        {isCurrent ? <span className="side-current-tag">当前</span> : null}
                        {unread > 0 ? <Tag tone="info" icon="message-square">{unread}</Tag> : null}
                      </button>

                      {/* 「⋯ → 项目设置」（第十六批 §17.8）：
                          独立按钮，**不触发项目切换/房间跳转/折叠** —— 只打开菜单，
                          选中里面的「项目设置」才聚焦该项目并导航。
                          hover / focus-within / 菜单打开 / 正处该项目设置时可见；
                          键盘可 Tab 到；触屏无 hover 时通过 CSS 常驻可见。 */}
                      <button
                        className={`side-project-more${projectMenuFor === p.id ? ' open' : ''}${navActive.projectSettings && p.id === activeProject.id ? ' on' : ''}`}
                        title={`${p.displayName} 的项目设置`}
                        aria-haspopup="menu"
                        aria-expanded={projectMenuFor === p.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setProjectMenuFor(projectMenuFor === p.id ? null : p.id);
                          setProjectMenuAt({ x: r.right + 4, y: r.bottom + 2 });
                        }}
                      >
                        <Icon name="more-horizontal" size={14} />
                        <span className="visually-hidden">{p.displayName} 的更多操作</span>
                      </button>
                    </div>

                    {expanded ? (
                      <>
                        {rooms.map((r) => {
                          const rUnread = roomUnread(s, r.id);
                          const coord = coordinatorOfRoom(s, r);
                          return (
                            <button
                              key={r.id}
                              className={`side-item sub${r.archivedAt ? ' archived' : ''}${r.id === activeRoomId ? ' active' : ''}`}
                              onClick={() => { focusProject(p.id, { announce: false }); navigate(`/project/${p.id}/room/${r.id}`); }}
                              title={r.archivedAt ? `已归档只读 · 协调者 ${memberLabel(coord)}` : `协调者 ${memberLabel(coord)}`}
                            >
                              <Icon name={r.archivedAt ? 'archive' : 'hash'} size={13} />
                              <span className="side-item-label">{r.name}</span>
                              {rUnread > 0 ? <Tag tone="info" icon="message-square">{rUnread}</Tag> : null}
                            </button>
                          );
                        })}
                        {/* 私信缩进在所属项目下并带 projectId：全局 /dm 隐含当前项目
                            会让两个项目的同名成员串线（§17.7 第 6 条） */}
                        <button
                          className={`side-item sub${navActive.dm && dmProjectId === p.id ? ' active' : ''}`}
                          onClick={() => { focusProject(p.id, { announce: false }); navigate(`/project/${p.id}/dm`); }}
                          title={`${p.displayName} 的私信`}
                        >
                          <Icon name="message-square" size={13} />
                          <span className="side-item-label">私信</span>
                          {dms.some((d) => d.unread > 0) ? <Tag tone="info" icon="message-square">·</Tag> : null}
                        </button>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* ---- 底部固定：待我处理 + 项目全停 + 设置 ---- */}
            <div className="sidebar-foot">
              <button
                className={`side-item${navActive.activity ? ' active' : ''}`}
                onClick={() => navigate('/activity')}
                title="未读、提及、授权、阻塞、待验收等聚合入口；默认汇总全部可访问项目"
              >
                <Icon name="inbox" size={14} />
                <span className="side-item-label">待我处理</span>
                {pendingAction > 0 ? <Tag tone="danger" icon="alert-circle">{pendingAction}</Tag> : <span className="small faint">0</span>}
              </button>

              {/* 「项目全停」已移入「项目设置 → 高级操作」（第二十六批第二轮）。
                  原因：用户担心它在侧栏底部容易被误触。
                  归属上也更自洽 —— 它是**项目级**动作，而 §17.8 明确要求
                  应用设置"不含项目配置"，所以放进 `/project/:id/settings` 而不是应用设置。
                  那里它被收在 warning 色「高级操作」带里，且仍需在确认弹窗里
                  二次点击"停止本项目全部任务"才真正执行。 */}

              <button
                className={`side-item${navActive.settings ? ' active' : ''}`}
                onClick={() => navigate('/settings?section=app')}
                title="应用设置：通用、执行工具（Runtime）、设备与局域网、诊断与帮助"
              >
                <Icon name="settings" size={14} />
                <span className="side-item-label">设置</span>
              </button>
            </div>
          </aside>
        ) : null}

        <Routes path={path} query={query} />
      </div>

      {/* ================= 浮层 ================= */}
      {/* 侧栏项目行的「⋯」菜单（第十六批 §17.8）：目前只有「项目设置」一项，
          将来可扩展。点它才聚焦该项目并进入 `/project/:id/settings`。 */}
      {projectMenuFor && projectMenuAt ? (() => {
        const p = s.projects.find((x) => x.id === projectMenuFor);
        if (!p) return null;
        return (
          <Menu anchor={projectMenuAt} onClose={() => { setProjectMenuFor(null); setProjectMenuAt(null); }}>
            <div className="menu-label">{p.displayName}</div>
            <MenuItem
              icon="settings"
              hint={navActive.projectSettings && p.id === s.activeProjectId ? '当前' : undefined}
              onClick={() => {
                focusProject(p.id, { announce: false });
                navigate(`/project/${p.id}/settings`);
                setProjectMenuFor(null);
                setProjectMenuAt(null);
              }}
            >
              项目设置
            </MenuItem>
            <MenuItem
              icon="refresh"
              onClick={() => {
                navigate(`/project/${p.id}`);
                setProjectMenuFor(null);
                setProjectMenuAt(null);
              }}
            >
              打开项目主页
            </MenuItem>
          </Menu>
        );
      })() : null}

      {/* 顶栏项目菜单（§17.1/§17.7）：**一个**菜单同时承担两件事——
          勾选框控制"显示在侧栏"，点项目名切换"当前项目"。
          两件事必须分开点击区域：如果点勾选框也切焦点，
          用户就没法"只是想多显示一个项目"而不打断手上的工作。 */}
      {projectMenu ? (
        <Menu anchor={projectMenu} onClose={() => { setProjectMenu(null); setProjectFilter(''); }}>
          <div className="menu-label">显示在侧栏 / 切换当前项目</div>

          <div className="menu-search">
            <Icon name="search" size={12} className="faint" />
            <input
              className="menu-search-input"
              placeholder="搜索项目…"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            />
          </div>

          <div className="menu-head row">
            <span className="small faint">显示在侧栏</span>
            <div className="spacer" />
            <span className="small faint">项目</span>
          </div>

          {s.projects
            .filter((p) => !projectFilter || p.displayName.toLowerCase().includes(projectFilter.toLowerCase()))
            .map((p) => {
              const visible = s.visibleProjectIds.includes(p.id);
              const isCurrent = p.id === activeProject.id;
              return (
                <div key={p.id} className="menu-project-row">
                  {/* 勾选框：只控制侧栏显示，不切焦点、不冒泡 */}
                  <button
                    className={`menu-check${visible ? ' on' : ''}${isCurrent ? ' locked' : ''}`}
                    aria-pressed={visible}
                    aria-label={`${visible ? '隐藏' : '显示'}项目 ${p.displayName}${isCurrent ? '（当前项目不可隐藏）' : ''}`}
                    title={isCurrent ? '当前项目不能隐藏，切换到其他项目后可隐藏' : (visible ? '从侧栏隐藏' : '显示在侧栏')}
                    onClick={(e) => { e.stopPropagation(); toggleProjectVisible(p.id); }}
                  >
                    <Icon name={visible ? 'check-square' : 'square'} size={13} />
                  </button>

                  <button
                    className="menu-project-name"
                    onClick={() => {
                      focusProject(p.id);
                      const first = s.rooms.find((r) => r.projectId === p.id && !r.archivedAt);
                      navigate(first ? `/project/${p.id}/room/${first.id}` : `/project/${p.id}`);
                      setProjectMenu(null);
                      setProjectFilter('');
                    }}
                    title={p.rootPath}
                  >
                    <Icon name={p.status === 'missing' ? 'alert-triangle' : 'folder'} size={13} />
                    <span className="truncate">{p.displayName}</span>
                    {isCurrent ? <Tag tone="accent">当前</Tag> : null}
                    {p.status === 'missing' ? <Tag tone="danger">目录失效</Tag> : null}
                  </button>
                </div>
              );
            })}

          <div className="menu-sep" />
          <MenuItem icon="folder" onClick={() => { navigate('/welcome'); setProjectMenu(null); }}>
            打开本地文件夹…
          </MenuItem>
          <MenuItem
            icon="refresh"
            hint={activeProject.status === 'missing' ? '需要' : undefined}
            onClick={() => { navigate(`/project/${activeProject.id}`); setProjectMenu(null); }}
          >
            重新定位项目目录
          </MenuItem>
        </Menu>
      ) : null}

      {/* 账号菜单（第二十六批移除）。
          它原来由应用内顶栏最右侧的头像打开，顶栏整条去掉后就没有入口了 ——
          留着一个打不开的浮层等于死代码。里面的三项已经各自有了正当去处：
            · 应用设置      → 侧栏底部的「设置」
            · 重置原型数据  → 应用设置 · 通用 · 高级操作
            · 退出          → 同上（关闭窗口本就只是缩到托盘，退出要走托盘菜单）
          原型没有登录体系，所以"本机账号 / 你（管理员）"这类展示也一并不需要了。 */}

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}

      {/* 全局轻提示宿主。
          修的是一个**长期存在的缺陷**：store.toast() 一直往状态里写提示、
          base.css 也一直有 .toast-host/.toast 样式，但没有任何组件渲染它 ——
          实测 DOM 里 .toast 数量恒为 0，构建产物里连 toast-host 都不存在。
          也就是说此前所有 toast（保存成功、权限被拒、深链补选提示等）**都不可见**，
          用户只看到"点了没反应"。这里补上唯一的渲染出口。 */}
      <ToastHost />

      {recoveryOpen ? (
        <RecoveryModal
          onClose={() => setRecoveryOpen(false)}
          onDismiss={() => {
            dismissStartupRecovery();
            setRecoveryOpen(false);
          }}
          onConfirm={(ids) => {
            confirmStartupResume(ids);
            setRecoveryOpen(false);
          }}
        />
      ) : null}

      {/* 「项目全停」确认弹窗已随按钮一起移到「项目设置 → 高级操作」
          （第二十六批第二轮）。这里不再保留一份 —— 否则会出现两个同类弹窗，
          而且这一份绑定的是**全局** runningCount，与"只停当前项目"的语义不符。 */}
    </div>
  );
}

/* ---------------- 路由分派 ----------------
   任务详情 / 研讨详情 / 运行详情 / 成果预览是"覆盖式查看面板"（§17.1），
   它们**不**接管整个工作区：底下仍然渲染所属房间，面板叠在上面。
   这样点开详情不会丢掉房间、回复串和阅读位置，关掉即原样回到原处。
*/

function Routes({ path, query }: { path: string; query: Record<string, string> }) {
  const store = useStore((x) => x);

  // 线程直达链接 #/thread/:id?message=:mid → 定位到所属房间与线程（§15.5）
  const link = resolveThreadLink(path, query);
  if (link) {
    const target = targetForThread(store, link.threadId);
    if (target) {
      return <RoomPage roomId={target.roomId} threadId={target.threadId} highlightMessageId={link.messageId} />;
    }
    return (
      <div className="main">
        <div className="page">
          <ErrorState code="ARTIFACT_MISSING" detail="链接指向的回复串不存在，可能已被归档或删除。" />
        </div>
      </div>
    );
  }

  // 旧的详情深链（/task/:id、/run/:id、/deliberation/:id、/artifact/:id）
  // 一律重定向到"所属线程 + 对应 tab"，就地渲染、不再弹覆盖层。
  const legacy = resolveLegacyDeepLink(store, path);
  if (legacy) {
    return <RedirectTo to={threadHash(legacy)} />;
  }

  return renderBase(path, query);
}

/**
 * 声明式重定向。
 *
 * §17.7 明确要求**兼容跳转使用 replace**：用 push 的话，"后退"会退回旧 URL、
 * 又被重定向一次，用户看到地址栏在两条路径间来回弹（重定向循环）。
 * 因此这里一律 replace。
 */
function RedirectTo({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return (
    <div className="main">
      <div className="page">
        <div className="small faint">正在打开…</div>
      </div>
    </div>
  );
}

/**
 * 旧 `/members` → `/project/:id/members`（§17.7：按当前项目规范化）。
 * 项目 ID 必须从 store 读，不能在渲染期猜或从 URL 拼。
 */
function NormalizeMembersLink() {
  const activeProjectId = useStore((x) => x.activeProjectId);
  useEffect(() => {
    navigate(`/project/${activeProjectId}/members`, { replace: true });
  }, [activeProjectId]);
  return (
    <div className="main">
      <div className="page">
        <div className="small faint">正在按当前项目打开成员管理…</div>
      </div>
    </div>
  );
}

/**
 * 旧的项目设置链接**没带 projectId** 时的处理（§17.8 兼容表）。
 *
 * 规则很明确：**只**在有有效当前项目时才补上并规范化；
 * 没有可用项目就提示从项目菜单进入 —— **不替用户挑第一个项目**
 * （那会让用户以为在改自己的项目，实际改了别的）。
 */
function NormalizeLegacyProjectSettings({ anchor }: { anchor: string }) {
  const activeProjectId = useStore((x) => x.activeProjectId);
  const hasProject = useStore((x) => x.projects.some((p) => p.id === x.activeProjectId));
  useEffect(() => {
    if (hasProject) navigate(`/project/${activeProjectId}/settings?anchor=${anchor}`, { replace: true });
  }, [activeProjectId, anchor, hasProject]);

  if (hasProject) {
    return (
      <div className="main">
        <div className="page">
          <div className="small faint">正在打开当前项目的设置…</div>
        </div>
      </div>
    );
  }
  return (
    <div className="main">
      <div className="page">
        <ErrorState
          code="PROJECT_MISSING"
          detail="这条链接没有指明是哪个项目。为避免改错项目，请从侧栏项目行旁的「⋯ → 项目设置」进入。"
        />
        <div className="panel-actions">
          <button className="btn sm" onClick={() => navigate('/welcome')}>打开本地文件夹</button>
        </div>
      </div>
    </div>
  );
}

/** 面板底下的页面；若当前 URL 本身就是面板路由，则渲染面板所属房间作为背板 */
function renderBase(path: string, query: Record<string, string>) {
  if (path === '/' || path === '/welcome') return <WelcomePage />;

  let m = path.match(/^\/project\/([^/]+)$/);
  if (m) return <ProjectHomePage projectId={m[1]} />;

  m = path.match(/^\/project\/([^/]+)\/room\/([^/]+)$/);
  if (m) {
    return (
      <RoomPage
        roomId={m[2]}
        threadId={query.thread}
        tab={isThreadTabKey(query.tab) ? query.tab : undefined}
        artifactId={query.artifact}
      />
    );
  }

  /* ---- 项目设置（第十六批 §17.8）----
     独立单页，路由绑定项目；页内不再有项目下拉与二级分类导航。 */
  m = path.match(/^\/project\/([^/]+)\/settings$/);
  if (m) return <ProjectSettingsPage projectId={m[1]} query={query} />;

  /* ---- 文件与 Git 合页（§17.7）----
     旧路由 /changes 与 /git 都重定向到这里，并把原有定位参数带过去，
     不能"只打开页头、丢掉对象"（§17.7：path/changeSetId/taskId/commit 必须保留）。
     replace 避免后退陷入重定向循环。 */
  m = path.match(/^\/project\/([^/]+)\/(files|changes|git)$/);
  if (m) {
    const pid = m[1];
    const legacyTab = m[2] === 'git' ? 'git' : m[2] === 'changes' ? 'files' : undefined;
    if (m[2] !== 'files') {
      const qs = new URLSearchParams({ tab: legacyTab!, ...query });
      return <RedirectTo to={`/project/${pid}/files?${qs.toString()}`} />;
    }
    return <FilesGitPage projectId={pid} query={query} />;
  }

  if (path === '/activity') return <ActivityPage />;

  /* ---- 搜索与收藏合页：旧 /saved 定位到 saved 标签 ---- */
  if (path === '/saved') {
    const qs = new URLSearchParams({ tab: 'saved', ...query });
    return <RedirectTo to={`/library?${qs.toString()}`} />;
  }
  if (path === '/library') return <LibraryPage query={query} />;

  // 裸 /tasks 缺省 visible；单项目入口必须显式带 projectId（§17.7）
  if (path === '/tasks') return <TasksBoardPage query={query} />;

  /* ---- 成员：单项目路径；旧 /members 按当前项目规范化（§17.7）---- */
  m = path.match(/^\/project\/([^/]+)\/members$/);
  if (m) return <MembersPage projectId={m[1]} />;
  if (path === '/members') return <NormalizeMembersLink />;

  m = path.match(/^\/member\/([^/]+)$/);
  if (m) return <MemberDetailPage memberId={m[1]} />;

  /* ---- 私信：项目内路径；旧 /dm 形式保留兼容 ---- */
  m = path.match(/^\/project\/([^/]+)\/dm$/);
  if (m) return <DmPage projectId={m[1]} />;
  // /dm/:memberId 是「与该成员私聊」的直达入口；从成员实体解析其所属项目（§17.7）
  m = path.match(/^\/dm\/([^/]+)$/);
  if (m) return <DmPage memberId={m[1]} />;
  if (path === '/dm') return <DmPage />;

  /* ---- 设置（第十六批 §17.8）----
     底部「设置」只打开**应用设置**。项目设置已移到 /project/:id/settings，
     所以旧的 `section=project|collab|budget|write` 必须在这里规范化过去
     （带 projectId），而不是当成应用分区渲染成空页。

     规则（§17.8 兼容表）：
      - 项目类 section：有 projectId → 规范化到项目页；没有 → 交给
        NormalizeLegacyProjectSettings 用"当前项目"补，补不上就提示从项目菜单进。
      - 应用类 section：**清除多余 projectId**，不据此切换焦点。
      - errors → diagnostics（并展开速查）；reminders → 待我处理。 */
  if (path === '/runtimes') return <RedirectTo to="/settings?section=runtime" />;

  if (path === '/settings') {
    const sec = query.section;
    if (sec === 'reminders') return <RedirectTo to="/activity" />;

    const isProjectSection = sec === 'project' || sec === 'collab' || sec === 'budget' || sec === 'write';
    if (isProjectSection) {
      const anchor = sec === 'write' ? 'write' : 'collab';
      // 显式带了 projectId：直接规范化；无效 ID 交给项目页报错（不回退）
      if (query.projectId) {
        return <RedirectTo to={`/project/${query.projectId}/settings?anchor=${anchor}`} />;
      }
      // 没带：用当前项目补（有才补）
      return <NormalizeLegacyProjectSettings anchor={anchor} />;
    }

    // 应用类：清掉无意义的 projectId，避免"看到 query.projectId 就切项目"
    if (query.projectId) {
      const qs = new URLSearchParams({ section: sec ?? 'general' });
      return <RedirectTo to={`/settings?${qs.toString()}`} />;
    }

    /* 旧 section=errors → 规范化到 diagnostics（并展开速查定位）。
       §17.8 兼容表要求"跳 section=diagnostics&anchor=errors"：
       必须**真的改 URL**，不能只在组件内部映射 —— 否则地址栏保留一个
       已经不存在的分区名，用户复制出去的链接含义不明。 */
    if (sec === 'errors') return <RedirectTo to="/settings?section=diagnostics&anchor=errors" />;

    return <SettingsPage query={query} />;
  }

  return <WelcomePage />;
}

/* 详情视图现在只在回复串的 tab 里就地渲染，不再有覆盖层与独立页面路由，
   因此原先的 renderPanelContent / renderPanelPage 已移除。 */

/**
 * 轻提示宿主（toast 的唯一渲染出口）。
 *
 * 只在有提示时出现；点击可立即关闭（不用等 3.6 秒自动消失）。
 * tone 决定边框颜色，文本本身不宣称任何安全结论 —— 提示只是回执。
 */
function ToastHost() {
  const t = useStore((x) => x.ui.toast);
  if (!t) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      <button className={`toast ${t.tone}`} onClick={() => clearToast()}>
        <Icon
          name={t.tone === 'success' ? 'check-circle' : t.tone === 'warn' || t.tone === 'error' ? 'alert-triangle' : 'info'}
          size={13}
          className="faint"
        />
        <span>{t.text}</span>
      </button>
    </div>
  );
}

/* ---------------- §16.4 启动恢复（E7：不自动续跑） ---------------- */

function RecoveryModal({
  onClose,
  onDismiss,
  onConfirm,
}: {
  onClose: () => void;
  onDismiss: () => void;
  onConfirm: (ids: string[]) => void;
}) {
  const startup = useStore((x) => x.startupRecovery);
  const [checked, setChecked] = useState<string[]>(startup.items.filter((i) => i.resumable).map((i) => i.id));

  return (
    <Modal
      size="lg"
      title="启动恢复检查"
      subtitle={`检查时间 ${new Date(startup.checkedAt).toLocaleTimeString('zh-CN')} · 已完成进程身份、会话、成果散列与工作区核对`}
      onClose={onClose}
      footer={
        <>
          <span className="small faint">
            未派发工作只重新排队，等你确认后才开放新调度（决策 44 / E7）
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onDismiss}>暂不处理</button>
          <button className="btn primary" onClick={() => onConfirm(checked)} disabled={checked.length === 0}>
            <Icon name="play" size={12} /> 继续选中的 {checked.length} 项
          </button>
        </>
      }
    >
      <div className="panel info">
        <div className="panel-title"><Icon name="info" size={13} /> 为什么在这里停下</div>
        重启之后不会自动接着烧调用。未派发的工作重新排队但保持暂停，等你看过下面这些项再决定。
        恢复流程也不会凭"PID 存在"就认定是原进程。
      </div>

      <div className="col" style={{ marginTop: 14, gap: 10 }}>
        {startup.items.map((it) => (
          <label
            key={it.id}
            className="card tight"
            style={{ display: 'flex', gap: 10, cursor: it.resumable ? 'pointer' : 'default', alignItems: 'flex-start' }}
          >
            <input
              type="checkbox"
              checked={checked.includes(it.id)}
              disabled={!it.resumable}
              onChange={(e) => setChecked((p) => (e.target.checked ? [...p, it.id] : p.filter((x) => x !== it.id)))}
              style={{ marginTop: 3 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row tight baseline wrap">
                <span className="strong">{it.title}</span>
                <Tag
                  tone={it.status === 'RECONCILE_REQUIRED' ? 'danger' : it.status === 'UNKNOWN' ? 'warning' : it.status === 'PARTIAL' ? 'neutral' : 'info'}
                  icon={it.status === 'RECONCILE_REQUIRED' ? 'help-circle' : it.status === 'UNKNOWN' ? 'alert-triangle' : 'play'}
                >
                  {it.status}
                </Tag>
                {!it.resumable ? <Tag plain icon="eye">仅可查看</Tag> : null}
              </div>
              <div className="small muted" style={{ marginTop: 3, lineHeight: 1.65 }}>{it.detail}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="divider" />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Switch
          checked={startup.awaitingUserConfirm}
          onChange={() => undefined}
          disabled
          label="自动继续任务"
          hint="默认关闭：自动开机自启与自动继续执行是两件事，后者坚持手动确认"
        />
        <span className="small faint">自动开机自启已开启（设置中可关）；自动继续执行保持关闭</span>
      </div>
    </Modal>
  );
}
