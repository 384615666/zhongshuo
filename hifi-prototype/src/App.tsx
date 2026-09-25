/**
 * 应用外壳：顶部栏 + 左侧栏 + 路由 + 全局浮层
 *
 * 布局依据 §17.1：顶部一条全局状态区（当前项目 / 后台任务 / 项目全停 / 设置），
 * 左侧项目与成员，中间房间主池，右侧任务回复串（窄窗改为全屏覆盖）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from './components/Icon';
import { NavCountBadge, NavTaskMark, NavUnreadDot } from './components/NavMarks';
import { Menu, MenuItem, Modal, Switch, Tag, ErrorState } from './components/ui';
import { useStore, setTheme, clearToast } from './data/store';
import {
  coordinatorOfRoom, dailyProjects, dmUnreadTotal, memberLabel, navTaskStateOfProject,
  navTaskStateOfRoom, projectUnread, roomUnread, roomsOfProject,
} from './data/selectors';
import {
  archiveProject, openProjectInExplorer, removeProject, toggleProjectPinned,
  unfinishedTasksOfProject, updateProjectInfo,
} from './data/actions-project';
import { confirmStartupResume, dismissStartupRecovery } from './data/actions';
import { focusProject, revealProjectForDeepLink, toggleProjectExpanded, toggleProjectVisible } from './data/actions-nav';
import { setNavAutoHidden } from './data/actions-preview';
import { navigate, parseQuery, pathOf, useHashRoute } from './lib/router';
import type { Project } from './data/types';
import { CreateRoomModal, RoomPage } from './pages/Room';
import { ActivityPage, LibraryPage, ProjectHomePage, WelcomePage } from './pages/pages-secondary';
import { FilesGitPage, MemberDetailPage, MembersPage } from './pages/pages-misc';
import { ArchivePage } from './pages/ArchivePage';
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
  /** 侧栏项目行 `+`：为哪个项目添加对话池 */
  const [createRoomFor, setCreateRoomFor] = useState<string | null>(null);
  /** 项目 ⋯ 菜单里的三个对话框（编辑信息 / 归档 / 移除） */
  const [editInfoFor, setEditInfoFor] = useState<string | null>(null);
  const [archiveFor, setArchiveFor] = useState<string | null>(null);
  const [removeFor, setRemoveFor] = useState<string | null>(null);
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

  /**
   * 侧栏列出的是"可见项目"而不是全部项目（第十五批 §17.1）。
   * 顺序按 visibleProjectIds 保存的顺序，**不因切换焦点而重排**（§17.7）。
   */
  /**
   * 侧栏项目区的项目（第十七批）：
   *  - 只列**日常项目**（归档项目退出这棵树，已移除的项目不再出现）；
   *  - 顺序 = 可见集合的顺序，但**置顶项目排在前面**（置顶只改排列，不复制入口）。
   */
  const daily = dailyProjects(s);
  const dailyIds = new Set(daily.map((p) => p.id));
  const visibleProjects = [
    ...s.pinnedProjectIds.filter((id) => dailyIds.has(id)),
    ...s.visibleProjectIds.filter((id) => dailyIds.has(id) && !s.pinnedProjectIds.includes(id)),
  ]
    .map((id) => daily.find((p) => p.id === id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));
  /** 统一私信入口未读（跨项目；私信已从项目树搬到一级入口） */
  const dmUnreadAll = dmUnreadTotal(s);

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
        projectMenuOpen={Boolean(projectMenu)}
        onOpenProjectMenu={(rect) =>
          /* toggle：点一次展开、再点一次收起（用户复核："第二次点击应该收起来"） */
          setProjectMenu((prev) => (prev ? null : { x: Math.max(8, rect.left), y: rect.bottom + 6 }))
        }
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
            {/* 项目选择器已按第十七批移到**顶栏**（原名单位置），侧栏不再重复一份：
                这里只留功能入口与项目树。 */}

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
                {/* 行尾 = 工作区未提交改动数（**数量**用数字徽标）。
                    它**不是**审批数：验收属于任务交付（v1.12 §10.5），
                    普通 Git 改动数不能混作审批数（§17.1）。
                    2026-09-25：徽标只放数字，去掉了重复的 diff 图标
                    （左侧入口图标已经说明了这是"文件与 Git"）。 */}
                <span className="side-marks">
                  <NavCountBadge
                    count={s.git[activeProject.id]?.status.length ?? 0}
                    tone="neutral"
                    hint="未提交改动"
                    where={`${activeProject.displayName} 的文件与 Git`}
                  />
                </span>
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

              {/* 统一私信入口（第十七批 §三）：一级导航里**唯一**的私信入口，位置在成员管理下面。
                  它是"跨项目的会话聚合"，不是合并项目上下文 —— 每条会话仍带自己的
                  projectId/conversationId/audience。项目树里不再有这个行。
                  行尾小蓝点表示"有未读"，不挂数字徽标（用户口径）。 */}
              <button
                className={`side-item${navActive.dm ? ' active' : ''}`}
                onClick={() => navigate('/dm')}
                title="私信：全部可访问项目的会话（页内可按项目筛选）"
              >
                <Icon name="message-square" size={14} />
                <span className="side-item-label">私信</span>
                <span className="side-marks">
                  <NavUnreadDot count={dmUnreadAll} where="私信" />
                </span>
              </button>
            </div>

            {/* ---- 中部滚动：可见项目 + 房间 + 私信 ---- */}
            <div className="sidebar-scroll">
              {/* 分区标题只有文字（第十七批复核）：原来这里挂着 `+`（添加项目，
                  已移到顶栏项目管理菜单），后来又换成 `…`（归档管理入口）——
                  用户 2026-09-25 复核指出"项目的归档管理入口还是去掉吧，影响美观"，
                  于是标题保持干净。归档管理仍有**两个**入口：
                    · 应用设置 → 归档管理（正式管理入口）
                    · 项目 ⋯ → 查看本项目归档（带 ?project=<id> 定位） */}
              <div className="side-heading">项目</div>

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
                /* 项目行只在**折叠**时显示汇总（2026-09-25 用户口径）：
                   展开时子项各自显示，项目行不重复；折叠时项目行就是"这一项目怎么样了"。 */
                const projState = navTaskStateOfProject(s, p.id);
                return (
                  <div key={p.id} className="side-project">
                    <div className={`side-row${isCurrent ? ' context-active' : ''}`}>
                      {/* 第十七批 §五：项目行的点击语义重做 ——
                          **名称、文件夹图标、行内空白、左侧箭头都只做"展开/收起"**，
                          只改项目树，不跳页、不切当前项目、不动主内容
                          （原来点名称会 focusProject + 跳到第一个房间，用户要求去掉）。
                          切换当前项目只保留在**顶栏的项目管理菜单**里做显式切换。 */}
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
                        title={`${expanded ? '收起' : '展开'}「${p.displayName}」的房间列表`}
                        aria-expanded={expanded}
                        onClick={(e) => { e.stopPropagation(); toggleProjectExpanded(p.id); }}
                      >
                        {/* 名称前的图标位同时承担两件事，优先级：
                            ① 项目**自身**状态（目录失效）—— 这是项目级的硬警告，不能被聚合状态顶掉；
                            ② 折叠时的子房间聚合任务状态（展开时房间行各自显示，这里不重复）；
                            ③ 都没有 → 默认的项目图标。
                            三种情况都只占 13/14px 一格，所以名称横坐标恒定，
                            状态出现或消失不会让项目名跳一下（用户要求"占位尺寸保持一致"）。 */}
                        {!expanded && projState.state && p.status !== 'missing' ? (
                          <NavTaskMark summary={projState} where={p.displayName} />
                        ) : (
                          <Icon
                            name={p.status === 'missing' ? 'alert-triangle' : 'folder'}
                            size={14}
                            className={p.status === 'missing' ? 'warn-icon' : 'faint'}
                          />
                        )}
                        {/* 行级说明挂在**名称**上，不挂整行（2026-09-25 用户反馈）：
                            挂在整行按钮上时，鼠标停在名称右边那段空白（比如小蓝点后面）
                            也会弹出"协调者 Codex"，看起来像那里藏着看不见的标记。
                            现在只在有东西的地方出提示：名称 → 协调者/路径，标记 → 状态/未读数。 */}
                        <span className="side-item-label" title={`${p.displayName} · ${p.rootPath}`}>{p.displayName}</span>
                        <span className="side-marks">
                          {/* 折叠 = 汇总，**只汇总这棵树里实际展示的东西**（第十七批 §三）：
                              私信已移到一级「私信」入口，所以这里只算房间未读 ——
                              否则会出现"项目显示有未读、展开后却找不到来源"。
                              私信未读由一级「私信」入口的小蓝点承担，不重复提示。 */}
                          {!expanded ? <NavUnreadDot count={unread} where={p.displayName} /> : null}
                        </span>
                      </button>

                      {/* ⋯ / +（第十七批 §六）：两个独立按钮、**阻止冒泡**，
                          不会同时触发展开/收起。默认隐藏，项目行 hover / 键盘聚焦 /
                          菜单打开时显示；位置恒定占位，显示或隐藏都不挤动名称与提示标记。
                          · ⋯：项目操作菜单（置顶、编辑信息、成员管理、归档、移除…）
                          · +：添加该项目的对话池（复用项目页那套新建房间流程，项目已绑定） */}
                      <span className="side-row-actions">
                        <button
                          className={`side-row-act${projectMenuFor === p.id ? ' on' : ''}${navActive.projectSettings && p.id === activeProject.id ? ' active' : ''}`}
                          title={`「${p.displayName}」的更多操作`}
                          aria-haspopup="menu"
                          aria-expanded={projectMenuFor === p.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            setProjectMenuFor(projectMenuFor === p.id ? null : p.id);
                            /* 菜单从按钮**右侧**展开（用户复核："菜单应该显示在右边"）：
                               侧栏只有 246px 宽，菜单往右压在主内容上是常规做法；
                               贴左缘只留 4px 安全边距。 */
                            setProjectMenuAt({ x: r.right + 4, y: r.bottom + 4 });
                          }}
                        >
                          <Icon name="more-horizontal" size={14} />
                          <span className="visually-hidden">{p.displayName} 的更多操作</span>
                        </button>
                        <button
                          className="side-row-act"
                          title={`在「${p.displayName}」中添加对话池`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCreateRoomFor(p.id);
                          }}
                        >
                          <Icon name="plus" size={14} />
                          <span className="visually-hidden">在「{p.displayName}」中添加对话池</span>
                        </button>
                      </span>
                    </div>

                    {expanded ? (
                      <>
                        {/* 第十七批 §八：**归档房间不再混在活跃房间里** —— 它们只在
                           「项目 ⋯ → 查看本项目归档」与归档管理页里出现（只读、可恢复）。 */}
                        {rooms.filter((r) => !r.archivedAt).map((r) => {
                          const rUnread = roomUnread(s, r.id);
                          const rState = navTaskStateOfRoom(s, r.id);
                          const coord = coordinatorOfRoom(s, r);
                          return (
                            <button
                              key={r.id}
                              className={`side-item sub${r.id === activeRoomId ? ' active' : ''}`}
                              onClick={() => { focusProject(p.id, { announce: false }); navigate(`/project/${p.id}/room/${r.id}`); }}
                            >
                              {/* 房间名**前面**只放任务状态位（2026-09-25 三轮定稿）：
                                  实际执行中才转（`NavTaskMark` 只对 ACTIVE 加旋转），
                                  等待/受阻/待验收是静态的琥珀色图标，靠形状区分。
                                  **没有任务状态时图标位空着** —— 用户第三轮要求把归档"归档箱"这类
                                  身份图标也去掉（"不需要名字前面的符号"），归档房只由整行降透明度
                                  与名称上的"已归档只读"tooltip 表达。
                                  占位恒定 13px，所以状态出现/消失、开转/停转都不会让房间名左右跳动。 */}
                              {rState.state ? (
                                <NavTaskMark summary={rState} where={r.name} />
                              ) : (
                                <span className="side-icon-slot" aria-hidden="true" />
                              )}
                              <span className="side-item-label" title={`协调者 ${memberLabel(coord)}`}>
                                {r.name}
                              </span>
                              <span className="side-marks">
                                <NavUnreadDot count={rUnread} where={r.name} />
                              </span>
                            </button>
                          );
                        })}
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
                {/* 行尾 = 待处理**事项数量**（不是"有无"）：用数字徽标，
                    不进"图标 + 感叹号"那套写法（那是状态，不是计数）。
                    计数口径没变，仍是按交付去重后的 pendingAction（v1.12 §10.5 第 7 条）：
                    同一交付牵涉多个文件/ChangeSet/commit 只算 1 项。 */}
                <span className="side-marks">
                  <NavCountBadge count={pendingAction} tone="warn" hint="待你处理" where="待我处理" />
                </span>
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
        const close = () => { setProjectMenuFor(null); setProjectMenuAt(null); };
        const pinned = s.pinnedProjectIds.includes(p.id);
        return (
          <Menu anchor={projectMenuAt} onClose={close}>
            <div className="menu-label">{p.displayName}</div>
            {/* 第一组：显示与位置（都不切换当前页面） */}
            <MenuItem
              icon="pin"
              hint={pinned ? '已置顶' : undefined}
              title={pinned ? '取消置顶：恢复按侧栏顺序排列' : '置顶：排到项目列表前部（不会多出一个入口）'}
              onClick={() => { toggleProjectPinned(p.id); close(); }}
            >
              {pinned ? '取消置顶' : '置顶项目'}
            </MenuItem>
            <MenuItem
              icon="edit"
              title="编辑显示名称与描述；**不会**重命名磁盘目录"
              onClick={() => { setEditInfoFor(p.id); close(); }}
            >
              编辑项目信息…
            </MenuItem>
            <MenuItem
              icon="external-link"
              title="用系统文件管理器打开项目目录（浏览器宿主没有这个能力，会如实说明）"
              onClick={() => { void openProjectInExplorer(p.id); close(); }}
            >
              在资源管理器中打开
            </MenuItem>
            <div className="menu-sep" />
            {/* 第二组：内容入口 */}
            <MenuItem
              icon="users"
              title={`打开「${p.displayName}」的成员管理（同一个页面，项目已定位）`}
              onClick={() => { focusProject(p.id, { announce: false }); navigate(`/project/${p.id}/members`); close(); }}
            >
              成员管理
            </MenuItem>
            <MenuItem
              icon="archive"
              title="在同一页归档管理里只看这个项目的归档内容"
              onClick={() => { navigate(`/archive?project=${p.id}`); close(); }}
            >
              查看本项目归档
            </MenuItem>
            <MenuItem
              icon="settings"
              hint={navActive.projectSettings && p.id === s.activeProjectId ? '当前' : undefined}
              onClick={() => { focusProject(p.id, { announce: false }); navigate(`/project/${p.id}/settings`); close(); }}
            >
              项目设置
            </MenuItem>
            <MenuItem
              icon="folder"
              onClick={() => { navigate(`/project/${p.id}`); close(); }}
            >
              打开项目主页
            </MenuItem>
            <div className="menu-sep" />
            {/* 第三组：生命周期（归档保留历史、移除只解除关联；两者都要二次确认） */}
            <MenuItem
              icon="archive"
              title="归档：退出日常项目列表、历史保留只读；有未结束的工作时会先提示"
              onClick={() => { setArchiveFor(p.id); close(); }}
            >
              归档项目…
            </MenuItem>
            <MenuItem
              icon="trash"
              title="移除：只在应用里移除关联，不删除磁盘文件与历史记录"
              onClick={() => { setRemoveFor(p.id); close(); }}
            >
              移除项目…
            </MenuItem>
          </Menu>
        );
      })() : null}

      {/* 编辑项目信息（§七）：与项目设置页共用同一个动作 updateProjectInfo */}
      {editInfoFor ? (() => {
        const p = s.projects.find((x) => x.id === editInfoFor);
        if (!p) return null;
        return <EditProjectInfoModal project={p} onClose={() => setEditInfoFor(null)} />;
      })() : null}

      {/* 归档项目（§十）：先做生命周期检查，再二次确认 */}
      {archiveFor ? (() => {
        const p = s.projects.find((x) => x.id === archiveFor);
        if (!p) return null;
        const unfinished = unfinishedTasksOfProject(s, p.id);
        return (
          <Modal
            size="sm"
            title={`归档项目「${p.displayName}」`}
            onClose={() => setArchiveFor(null)}
            footer={
              <>
                <div className="spacer" />
                <button className="btn" onClick={() => setArchiveFor(null)}>取消</button>
                <button
                  className="btn primary"
                  disabled={unfinished.length > 0}
                  onClick={() => {
                    const res = archiveProject(p.id);
                    setArchiveFor(null);
                    if (res === 'archived') {
                      /* 归档的是"正在看的项目"时给一个明确落点：归档管理里正是它现在的位置 */
                      navigate(`/archive?project=${p.id}`);
                    }
                  }}
                >
                  归档项目
                </button>
              </>
            }
          >
            {unfinished.length > 0 ? (
              <div className="panel warning">
                <div className="panel-title"><Icon name="alert-triangle" size={13} /> 还有工作没结束，暂时不能归档</div>
                本项目有 <strong>{unfinished.length}</strong> 个未结束的工作（
                {unfinished.slice(0, 4).map((t) => `#${t.roomTaskNumber}`).join('、')}
                {unfinished.length > 4 ? ' 等' : ''}）。归档不会强停它们，请先在房间或任务看板处理。
                <div className="panel-actions">
                  <button className="btn sm" onClick={() => { navigate('/tasks?scope=project&projectId=' + p.id); setArchiveFor(null); }}>
                    去任务看板查看
                  </button>
                </div>
              </div>
            ) : (
              <div className="col" style={{ gap: 10 }}>
                <div className="small muted" style={{ lineHeight: 1.75 }}>
                  归档后：项目退出日常项目列表，历史会话、任务与成果**保留只读**，可在「归档管理」里恢复。
                  其下房间不再接收新消息、不能创建任务，也不会被调度唤醒。
                </div>
                <div className="panel">
                  <div className="panel-title">会影响什么</div>
                  <div className="small muted" style={{ lineHeight: 1.7 }}>
                    · 项目仍在磁盘上，文件一个都不会动；<br />
                    · 单独归档过的房间**不会**跟着项目一起恢复，需要时一个个恢复；<br />
                    · 恢复项目不会自动重放旧的待派发任务。
                  </div>
                </div>
              </div>
            )}
          </Modal>
        );
      })() : null}

      {/* 移除项目（§七）：与"隐藏""归档"区分清楚，且不做不可逆删除 */}
      {removeFor ? (() => {
        const p = s.projects.find((x) => x.id === removeFor);
        if (!p) return null;
        const unfinished = unfinishedTasksOfProject(s, p.id);
        return (
          <Modal
            size="sm"
            title={`移除项目「${p.displayName}」`}
            onClose={() => setRemoveFor(null)}
            footer={
              <>
                <div className="spacer" />
                <button className="btn" onClick={() => setRemoveFor(null)}>取消</button>
                <button
                  className="btn danger"
                  disabled={unfinished.length > 0}
                  onClick={() => {
                    const res = removeProject(p.id);
                    setRemoveFor(null);
                    if (res === 'removed') navigate('/welcome');
                  }}
                >
                  移除项目
                </button>
              </>
            }
          >
            <div className="col" style={{ gap: 10 }}>
              <div className="small muted" style={{ lineHeight: 1.75 }}>
                「移除」= 从应用的项目列表里**解除关联**：不删除磁盘文件、不删除聊天记录、
                任务与成果（原型里数据都还在，可在应用设置里重新关联）。
                只是想让它不出现在侧栏，用顶栏项目管理里的勾选框（隐藏）就够；
                想保留历史但退出日常列表，用「归档项目」。
              </div>
              {unfinished.length > 0 ? (
                <div className="panel warning">
                  <div className="panel-title"><Icon name="alert-triangle" size={13} /> 还有工作没结束</div>
                  本项目有 {unfinished.length} 个未结束的工作，先处理完或改用「归档项目」，避免把还在跑的项目藏起来。
                </div>
              ) : (
                <div className="small faint">目录：{p.rootPath}</div>
              )}
            </div>
          </Modal>
        );
      })() : null}

      {/* 在侧栏项目行点 + 添加对话池：复用项目页那套新建房间流程，项目已绑定 */}
      {createRoomFor ? (
        <CreateRoomModal projectId={createRoomFor} onClose={() => setCreateRoomFor(null)} />
      ) : null}

      {/* 顶栏项目菜单（§17.1/§17.7）：**一个**菜单同时承担两件事——
          勾选框控制"显示在侧栏"，点项目名切换"当前项目"。
          两件事必须分开点击区域：如果点勾选框也切焦点，
          用户就没法"只是想多显示一个项目"而不打断手上的工作。 */}
      {projectMenu ? (
        <Menu anchor={projectMenu} onClose={() => { setProjectMenu(null); setProjectFilter(''); }}>
          <div className="menu-label">项目管理 · 显示在侧栏 / 切换当前项目</div>

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

          {/* 归档与已移除的项目不出现在日常项目管理里（§八）：归档内容去「归档管理」看，
              已移除的项目在应用设置里重新关联。 */}
          {dailyProjects(s)
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

          {dailyProjects(s).length === 0 ? (
            <div className="side-empty" style={{ padding: '6px 10px' }}>没有可用的项目</div>
          ) : null}

          <div className="menu-sep" />
          {/* 「添加项目」按用户要求收进这里（原来挂在侧栏「项目」标题旁的 `+`） */}
          <MenuItem
            icon="plus"
            title="打开本地文件夹作为新项目（原型不写盘，只演示流程与限制说明）"
            onClick={() => { navigate('/welcome'); setProjectMenu(null); }}
          >
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

  /* ---- 私信（第十七批 §三）：一个统一页面，三种入口 ----
     `/dm` = 全部可访问项目（默认）、`/project/:id/dm` = 先筛选到该项目、
     `/dm/:memberId` = 先按成员实体解析项目再打开。旧链接语义不变，共用同一个页面。 */
  m = path.match(/^\/project\/([^/]+)\/dm$/);
  if (m) return <DmPage projectId={m[1]} query={query} />;
  m = path.match(/^\/dm\/([^/]+)$/);
  if (m) return <DmPage memberId={m[1]} query={query} />;
  if (path === '/dm') return <DmPage query={query} />;

  /* ---- 归档管理（第十七批 §九）：三个入口共用这一个页面 ----
     · 侧栏「项目」标题旁的 ⋯；· 应用设置 → 归档管理；· 项目 ⋯ → 查看本项目归档（?project=） */
  if (path === '/archive') return <ArchivePage query={query} />;

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

/**
 * 编辑项目信息（第十七批 §七）。
 *
 * 与「项目设置」页用的是**同一个动作** `updateProjectInfo`（同一份数据、同一套校验），
 * 弹窗只是从项目 ⋯ 菜单直达它。明确写清"不会重命名磁盘目录" —— 显示名称是应用内的，
 * 改名不会动 `rootPath`/`canonicalPath`/目录身份。
 */
function EditProjectInfoModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.displayName);
  const [desc, setDesc] = useState(project.description ?? '');
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
            disabled={!name.trim()}
            onClick={() => {
              if (updateProjectInfo(project.id, { displayName: name, description: desc })) onClose();
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
          <input
            className="input"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="例如：订单表回填与数据修复"
          />
        </div>
        <div className="small faint">目录：{project.rootPath}</div>
      </div>
    </Modal>
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
