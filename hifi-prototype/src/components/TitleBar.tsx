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
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenRecovery: () => void;
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

      <div className="titlebar-left">
        <span className="brand-mark" style={{ width: 18, height: 18, fontSize: 10 }}>众</span>
        <span className="titlebar-app">众说</span>
        <span className="titlebar-sep" />
        {/*
          侧栏收起时，把当前项目显示在这里 —— 否则用户看不到"我现在在哪个项目"，
          而切换项目的入口（侧栏顶部的选择器）也一起被收走了。
          侧栏展开时项目选择器就在侧栏顶部，这里就不再重复一遍。
        */}
        {!sidebarOpen && project ? (
          <button
            className="titlebar-project"
            title={`当前项目：${project.displayName}（${project.rootPath}）— 展开侧栏可切换`}
            onClick={onToggleSidebar}
          >
            <Icon name="folder" size={12} />
            <span className="strong">{project.displayName}</span>
            {project.isGit ? <Tag plain icon="git-branch">{project.gitBranch}</Tag> : null}
          </button>
        ) : (
          <span className="titlebar-sub">本地项目群聊多 Agent 协同工作台</span>
        )}
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
