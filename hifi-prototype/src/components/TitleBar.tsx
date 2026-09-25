/**
 * 自绘标题栏（桌面客户端外壳）
 *
 * 在 Electron 里窗口是无边框的（frame: false），这条件替了系统标题栏，
 * 让原型一眼就是桌面应用而不是网页：
 *  - 最左：折叠/展开侧栏（**唯一入口**，见下）
 *  - 左侧：应用图标 + 名称 + 当前项目
 *  - 中间：整条可拖动区域（-webkit-app-region: drag），双击最大化/还原
 *  - 右侧：原型标注 + 运行状态 + 最小化/最大化/关闭
 *
 * 第二十六批：应用内那条 46px 的顶部工具栏（`.topbar`）**整条去掉了**，
 * 它承载的东西按"外壳职责 / 侧栏职责 / 设置职责"三分：
 *  - **侧栏**：项目选择器移到侧栏最顶部（选择器与它管的项目列表在一起），
 *    全局搜索变成「搜索与收藏」左边的小按钮，「项目全停」留在侧栏底部固定区
 *  - **设置**：主题切换、账号、退出、重置原型数据收进应用设置
 *  - **标题栏**（本文件）：折叠侧栏、原型标注、当前项目、运行状态
 *
 * 为什么这些落在标题栏而不是都塞进设置：
 *  1. **折叠按钮必须在这里**。它此前只存在于顶栏，而侧栏折叠后自身不可见 ——
 *     一起搬进侧栏就会造成"折起来再也打不开"的死状态（`sidebarOpen` 默认 true）。
 *     标题栏属于窗口外壳、永远可见，是唯一不会自己消失的位置。
 *  2. **原型标注要常驻可见**。RT-26⑫ 要求界面自我声明是原型，评审才不会
 *     把假数据当成真实的文件系统/Git/runtime 证据。收进设置等于只有翻设置才看得到。
 *  3. **运行状态是"外壳"信息**。它本来就要汇报给主进程供托盘提示与退出确认用
 *     （§17.4），标题栏是它天然的位置，也不用再单独占一行。
 */

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { ProtoFlag, Tag } from './ui';
import { desktop, type WindowState } from '../lib/desktop';
import { useStore, toast } from '../data/store';
import { activeTasksOfProject } from '../data/selectors';
import { navigate } from '../lib/router';

export function TitleBar({
  sidebarOpen,
  onToggleSidebar,
  onOpenRecovery,
  onOpenProjectMenu,
  projectMenuOpen,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenRecovery: () => void;
  /** 项目管理菜单是否已展开（用于 aria-expanded 与"打开态"底色） */
  projectMenuOpen: boolean;
  /** 打开项目管理菜单（第十七批：项目选择器从侧栏移到顶栏，锚点由调用方按按钮位置算） */
  onOpenProjectMenu: (rect: DOMRect) => void;
}) {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === s.activeProjectId) ?? s.projects[0];
  const [state, setState] = useState<WindowState>({ maximized: false, fullScreen: false, focused: true });
  const [hovered, setHovered] = useState<'min' | 'max' | 'close' | null>(null);

  // 订阅窗口状态，切换最大化按钮图标
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    d.window.getState().then(setState);
    return d.window.onStateChange(setState);
  }, []);

  // 把运行态摘要同步给主进程：托盘提示与退出确认都要用（§17.4）
  const runningTasks = activeTasksOfProject(s, project.id).length;
  const runningTurns = s.turns.filter((t) =>
    ['RUNNING', 'DISPATCHING', 'WAITING_APPROVAL', 'STOPPING'].includes(t.status),
  ).length;
  useEffect(() => {
    const d = desktop();
    if (!d) return;
    d.reportRuntime({
      runningTasks,
      runningTurns,
      detail: project.displayName,
    });
  }, [runningTasks, runningTurns, project.displayName]);

  const d = desktop();

  return (
    <div className="titlebar">
      {/* 折叠/展开侧栏：侧栏折叠后自身不可见，所以这个入口必须在窗口外壳上 */}
      <button
        className="titlebar-icon"
        title={sidebarOpen ? '折叠侧栏' : '展开侧栏'}
        aria-pressed={sidebarOpen}
        onClick={onToggleSidebar}
      >
        <Icon name="panel-left" size={15} />
      </button>

      {/* 第十七批 §二：原来的"软件名称 + 描述"整段换成**项目管理**入口 ——
          项目选择器从侧栏顶部搬到这里，并且按钮本身就显示当前项目名（不能只有一个
          "项目管理"的固定文字）。侧栏折叠后这个入口依然在，所以折叠状态不再需要
          另一套"当前项目"展示（原来那段 `.titlebar-project` 已删除）。
          打开后仍是同一个菜单：搜索、切换当前项目、勾选侧栏显示、打开文件夹添加项目。 */}
      <div className="titlebar-left">
        <button
          className={`titlebar-project-btn${projectMenuOpen ? ' open' : ''}`}
          onClick={(e) => onOpenProjectMenu((e.currentTarget as HTMLElement).getBoundingClientRect())}
          title={
            project
              ? `项目管理：切换当前项目 / 侧栏显示 / 打开文件夹\n当前项目：${project.displayName}（${project.rootPath}）`
              : '项目管理：打开文件夹添加项目'
          }
          aria-haspopup="menu"
          aria-expanded={projectMenuOpen}
        >
          <Icon
            name={project?.status === 'missing' ? 'alert-triangle' : 'folder'}
            size={13}
            className={project?.status === 'missing' ? 'warn-icon' : 'faint'}
          />
          <span className="titlebar-proj-title">项目管理</span>
          {/* 分支芯片放在"项目管理"一侧：用户给的字面格式是「项目管理 · 当前项目名 ▾」，
              项目名后面必须紧跟箭头（视觉复核指出过"箭头没紧跟项目名"） */}
          {project?.isGit ? <Tag plain icon="git-branch">{project.gitBranch}</Tag> : null}
          <span className="titlebar-proj-sep">·</span>
          <span className="strong titlebar-proj-name">{project?.displayName ?? '未选择项目'}</span>
          {project?.status === 'missing' ? <Tag tone="danger">目录失效</Tag> : null}
          <Icon name="chevron-down" size={12} className="faint" />
        </button>
      </div>

      {/* 拖动区：双击最大化/还原 */}
      <div
        className="titlebar-drag"
        onDoubleClick={() => d?.window.toggleMaximize().then(setState)}
      />

      <div className="titlebar-actions">
        {/* 原型标注常驻可见：评审必须一眼看出这是内存假数据（RT-26⑫） */}
        <ProtoFlag />

        {/* 运行状态：点击进当前项目的任务看板。必须显式带 scope 与 projectId，
            否则从聚合看板进来会丢掉当前项目上下文（§17.7 第 5 条） */}
        <button
          className="titlebar-stat"
          onClick={() => navigate(`/tasks?scope=project&projectId=${project.id}`)}
          title={`${project.displayName} 在跑的任务（单项目范围）`}
        >
          <Icon name="activity" size={12} />
          <span className="stat-text">后台任务</span> <strong>{runningTasks}</strong>
          <span className="faint stat-text">· {runningTurns} turn 在跑</span>
        </button>

        {s.startupRecovery.needsAttention ? (
          <button
            className="titlebar-stat warn"
            onClick={onOpenRecovery}
            title="上次退出时有未完成的工作，点开查看恢复检查"
          >
            <Icon name="alert-triangle" size={12} />
            <span className="stat-text">恢复检查</span>
            <Tag tone="warning" icon="clock">{s.startupRecovery.items.length} 项</Tag>
          </button>
        ) : null}

        {!d ? (
          <span className="titlebar-note" title="当前是浏览器宿主，窗口控制与托盘由桌面客户端提供">
            <Icon name="info" size={11} />
            浏览器宿主
          </span>
        ) : null}
        <button
          className="winbtn"
          title="最小化"
          onMouseEnter={() => setHovered('min')}
          onMouseLeave={() => setHovered(null)}
          onClick={() => d?.window.minimize()}
        >
          <Icon name="minus" size={13} strokeWidth={hovered === 'min' ? 2.4 : 1.6} />
        </button>
        <button
          className="winbtn"
          title={state.maximized ? '还原' : '最大化'}
          onMouseEnter={() => setHovered('max')}
          onMouseLeave={() => setHovered(null)}
          onClick={() => d?.window.toggleMaximize().then(setState)}
        >
          <Icon name={state.maximized ? 'copy' : 'maximize'} size={12} strokeWidth={hovered === 'max' ? 2.4 : 1.6} />
        </button>
        <button
          className="winbtn close"
          title="关闭窗口（缩到托盘继续运行；要退出请用托盘菜单）"
          onMouseEnter={() => setHovered('close')}
          onMouseLeave={() => setHovered(null)}
          onClick={() => {
            if (!d) {
              toast('浏览器标签页里没有"缩到托盘"：桌面客户端中点关闭会隐藏到系统托盘，任务继续运行', 'info');
              return;
            }
            d.window.close();
          }}
        >
          <Icon name="x" size={13} strokeWidth={hovered === 'close' ? 2.4 : 1.6} />
        </button>
      </div>
    </div>
  );
}
