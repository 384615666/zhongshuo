/**
 * 自绘标题栏（第五十四轮 H3 §3——按批准原型 TitleBar 形态的正式接线版）：
 * 经 **portal 挂到 #zs-titlebar**（index.html 独立挂载点，位于 #hifi-root/#legacy-root 之外）
 * ——legacy 接管（body.legacy-on 只隐藏 #hifi-root）与 hifi 样式禁用都不影响本栏；类名与
 * hifi-flag.js 注入的常驻样式（<style data-zs-titlebar>）共享，React 挂载成功即替换最小壳。
 *
 * 窗口控制：window.zsWindow 窄桥（枚举动作经 main 侧 senderFrame 校验，只作用于可信主窗口）；
 * close=win.close() → window-all-closed → shutdownDaemon() 既有优雅收口链（不为无边框绕过）。
 * 浏览器宿主（探针 http 环境）无 zsWindow：如实显示「浏览器宿主」，按钮提示而非假装可用。
 * 状态行只用**真实已取得的服务事实**：当前项目名（store）+ daemon 连接态（boot/断线事件）
 * ——不接入原型种子计数冒充实际运行。
 *
 * R66 P1（反例=冻结 v3 点「项目」卸载整个 React root）：
 *  - ProjectMenu 的 selector 必须返回**稳定引用**（先取 s.projects 再 useMemo filter——
 *    useSyncExternalStore 合同）；全量扫描同类「内联 .filter selector」仅此一处。
 *  - portal 内容整体包在 TitleBarBoundary 内：标题栏任何渲染错误只降级为**最小控制条**
 *    （名称+拖动+三枚窗口按钮，零 store 订阅），主界面与窗口控制不再被连带卸载；
 *    ProjectMenu 另有一层内边界——菜单异常只关菜单，标题栏其余功能保留。
 *  - 项目入口还原原型形态：`项目管理 · [分支] · 当前项目名 ▾` 单按钮开菜单；
 *    「后台任务 N · N turn」状态按钮通过正式 project.taskSummary 读取项目计数（未读显示 —）。
 */
import { Component, useEffect, useMemo, useState,useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Tag,Menu } from './ui';
import { useStore, toast } from '../data/store';
import { command } from '../bridge';
import { switchFocusProject } from '../loader';
import { toggleProjectVisible } from '../data/actions-nav';
import { navigate } from '../lib/router';
import type { ProjectTaskSummary } from '../../../contracts/projectTaskSummary';

interface ZsWindowState { maximized: boolean; fullScreen: boolean; focused: boolean }
type ZsWindowBridge = {
  minimize(): Promise<{ ok: boolean }>;
  toggleMaximize(): Promise<{ ok: boolean; maximized?: boolean }>;
  close(): Promise<{ ok: boolean }>;
  getState(): Promise<{ ok: boolean; state?: ZsWindowState }>;
  onStateChange(cb: (s: ZsWindowState) => void): () => void;
};

function bridge(): ZsWindowBridge | null {
  return (window as unknown as { zsWindow?: ZsWindowBridge }).zsWindow ?? null;
}

/**
 * 标题栏错误边界：portal 内容整体隔离——菜单/状态条任何渲染错误不再卸载 React root
 * （R65 反例根因已修，本层是「任意菜单错误清空主界面」的结构性防护）。
 * 降级形态=最小控制条：零 store 订阅、零菜单，只保留窗口控制（窄桥本身不依赖 React 状态）。
 */
class TitleBarBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  constructor(props: { children: ReactNode }) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error('[hifi] 标题栏渲染错误，降级为最小控制条（主界面不受影响）：', e); }
  render() {
    if (this.state.failed) {
      const d = bridge();
      return (
        <div className="zs-titlebar" data-zs-titlebar-rendered="react" data-zs-titlebar-degraded="1">
          <span className="zs-tb-name">众说</span>
          <span className="zs-tb-stat" title="标题栏渲染出错，已降级为最小控制条；主界面不受影响（可重启应用恢复完整标题栏）">标题栏已降级</span>
          <div className="zs-tb-drag" title="拖动窗口；双击最大化/还原" onDoubleClick={() => { void d?.toggleMaximize(); }} />
          <button className="zs-winbtn" title="最小化" onClick={() => { void d?.minimize(); }}><Icon name="minus" size={12} /></button>
          <button className="zs-winbtn" title="最大化/还原" onClick={() => { void d?.toggleMaximize(); }}><Icon name="maximize" size={11} /></button>
          <button className="zs-winbtn close" title="关闭窗口（经既有优雅停机链）" onClick={() => { void d?.close(); }}><Icon name="x" size={12} /></button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 菜单级内边界：ProjectMenu 自身异常只关菜单并提示，标题栏其余部分不动。 */
class MenuBoundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  constructor(props: { children: ReactNode; name: string }) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error(`[hifi] ${this.props.name} 渲染错误（已关闭菜单，界面其余部分不受影响）：`, e); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function TitleBar() {
  const mount = typeof document !== 'undefined' ? document.getElementById('zs-titlebar') : null;
  const project = useStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null);
  const boot = useStore((s) => s.boot);
  // 实时连接态（r55）：注册 zs:disconnect/zs:reconnected（main 在管道关闭/重连时推送）——
  // 首启 ready 不再永久等同在线；浏览器宿主收不到事件时保持 online 缺省（按 boot 呈现）。
  const conn = useStore((s) => s.conn);
  const connInfo = useStore((s) => s.connInfo);
  /** 派发防护标识（r56：演练包自绘标题栏必须可见「模拟/真实派发」——runtime.status 自述）。 */
  const [guard, setGuard] = useState<{ fakeAllowed: boolean; realDispatchGuard: boolean } | null>(null);
  const [pmAt, setPmAt] = useState<{ x: number; y: number } | null>(null);
  const projectTrigger=useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<ZsWindowState>({ maximized: false, fullScreen: false, focused: true });
  const d = bridge();

  useEffect(() => {
    const b = bridge();
    if (b == null) return;
    void b.getState().then((r) => { if (r.ok && r.state != null) setState(r.state); }).catch(() => { /* 状态读取失败保持默认——按钮仍可用 */ });
    return b.onStateChange(setState);
  }, []);

  // 派发防护状态只在连接就绪后取一次（daemon env 不随运行变化；读取失败不显示标识）。
  useEffect(() => {
    if (boot !== 'ready') return;
    void command<{ dispatchGuard?: { fakeAllowed: boolean; realDispatchGuard: boolean } }>('runtime.status', {})
      .then((r) => { if (r.dispatchGuard != null) setGuard(r.dispatchGuard); })
      .catch(() => { /* 旧 daemon 无该字段/读取失败——不显示标识 */ });
  }, [boot]);

  // portal 不会清空容器——挂载时移除 hifi-flag.js 的最小壳兄弟节点（React 版接管）；
  // React 整体失败卸载时由看门狗 __zsTitlebarMinimal 重建（兜底合同不变）。
  useEffect(() => {
    const mountNode = document.getElementById('zs-titlebar');
    if (mountNode == null) return;
    for (const el of [...mountNode.children]) {
      if (!(el instanceof HTMLElement) || el.getAttribute('data-zs-titlebar-rendered') !== 'react') el.remove();
    }
  }, []);

  if (mount == null) return null; // --no-hifi（原生框）或挂载点缺失——不自绘

  // 连接态合成（r55）：断线优先于 boot（首启后掉线不再显示「已连接」）；重连由 main 负责，
  // 恢复即回到在线。connInfo 为 main 给的断线说明（原样透传）。
  const connLabel = conn === 'failed' ? '恢复失败 · 可查看本地诊断' : conn==='suspended' ? '宿主已挂起' : conn==='recovering' ? '正在恢复连接…' : conn === 'offline'
    ? `已断开——重连中${connInfo != null && connInfo.length > 0 ? `（${connInfo}）` : ''}`
    : boot === 'pending' ? '连接服务中…' : boot === 'failed' ? '服务连接失败' : '已连接';
  const connOff = conn !== 'online' || boot !== 'ready';
  return createPortal(
    <TitleBarBoundary>
      <div className="zs-titlebar" data-zs-titlebar-rendered="react">
        <span className="zs-tb-name">众说</span>
        <span className="zs-tb-stat zs-tb-no-drag" data-zs-conn={connOff ? 'offline' : 'online'} data-zs-connection-phase={conn} title={connOff ? `连接状态：${conn}${connInfo ? ` · ${connInfo}` : ''}；未知结果信封保留，不自动重发。恢复失败可查看设置中的本地诊断。` : project != null ? `当前项目：${project.displayName}` : '尚未打开项目'}>
          <span className={connOff ? 'dot-off' : 'dot'} style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5, verticalAlign: 1, background: connOff ? '#c9312e' : '#22a55e' }} />
          {connLabel}
        </span>

        {/* 项目管理入口（原型第十七批 §二形态）：按钮本身显示当前项目名与分支——
            「项目管理 · [分支] · 项目名 ▾」；点开是同一个菜单（勾选=侧栏显示/点名=切换/
            打开文件夹）。无项目时显示「未选择项目」。 */}
        <button
          className="zs-tb-stat zs-tb-no-drag zs-tb-project"
          data-zs-project-menu-btn="1"
          ref={projectTrigger}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border,#dbe2ea)', borderRadius: 6, padding: '2px 8px' }}
          title={project != null
            ? `项目管理：切换当前项目 / 侧栏显示 / 打开文件夹\n当前项目：${project.displayName}（${project.rootPath}）`
            : '项目管理：打开文件夹添加项目'}
          aria-haspopup="menu"
          aria-expanded={pmAt != null}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPmAt((prev) => (prev == null ? { x: Math.max(8, r.left), y: r.bottom + 6 } : null));
          }}
        >
          <Icon name={project?.status === 'missing' ? 'alert-triangle' : 'folder'} size={12} className={project?.status === 'missing' ? 'warn-icon' : 'faint'} />
          项目管理
          {project?.isGit && project.gitBranch ? <Tag plain icon="git-branch">{project.gitBranch}</Tag> : null}
          <span className="faint">·</span>
          <span style={{ fontWeight: 600 }}>{project?.displayName ?? '未选择项目'}</span>
          <Icon name="chevron-down" size={11} className="faint" />
        </button>

        {/* 后台任务状态（原型形态）：正式项目任务/turn 汇总，受众过滤；未读显示未知，点击进看板。 */}
        <TitleBarStatButton />

        {guard != null ? (
          <span
            className="zs-tb-stat zs-tb-no-drag"
            data-zs-dispatch-guard={guard.fakeAllowed ? 'fake' : 'real'}
            title={guard.fakeAllowed
              ? `演练模式：允许 fake adapter 模拟执行${guard.realDispatchGuard ? '；真实派发防护开启（真实 startTurn 会被拒）' : ''}——零真实模型调用`
              : '正式模式：未启用 fake adapter；派发走真实 runtime 合同'}
            style={{ fontSize: 11, padding: '1px 8px', borderRadius: 999, border: guard.fakeAllowed ? '1px solid var(--warning,#b45309)' : '1px solid var(--border,#dbe2ea)', color: guard.fakeAllowed ? 'var(--warning,#b45309)' : 'var(--text-2,#64748b)' }}
          >
            {guard.fakeAllowed ? '演练·模拟派发' : '真实派发'}
          </span>
        ) : null}
        <div
          className="zs-tb-drag"
          title="拖动窗口；双击最大化/还原"
          onDoubleClick={() => { void d?.toggleMaximize().then((r) => { if (r.ok && typeof r.maximized === 'boolean') setState((s) => ({ ...s, maximized: r.maximized as boolean })); }); }}
        />
        {d == null ? <span className="zs-tb-note">浏览器宿主（窗口控制由桌面客户端提供）</span> : null}
        <button className="zs-winbtn" title={d == null ? '最小化（桌面客户端可用）' : '最小化'} onClick={() => { void d?.minimize(); }}>
          <Icon name="minus" size={12} />
        </button>
        <button className="zs-winbtn" title={state.maximized ? '还原' : '最大化'} onClick={() => { void d?.toggleMaximize().then((r) => { if (r.ok && typeof r.maximized === 'boolean') setState((s) => ({ ...s, maximized: r.maximized as boolean })); }); }}>
          <Icon name={state.maximized ? 'copy' : 'maximize'} size={11} />
        </button>
        <button className="zs-winbtn close" title="关闭窗口（经既有优雅停机链：daemon 收拢后退出）" onClick={() => { void d?.close(); }}>
          <Icon name="x" size={12} />
        </button>
        {pmAt != null ? (
          <MenuBoundary name="项目管理菜单">
            <ProjectMenu anchor={pmAt} trigger={projectTrigger.current} onClose={() => setPmAt(null)} />
          </MenuBoundary>
        ) : null}
      </div>
    </TitleBarBoundary>,
    mount,
  );
}

/** 当前项目持久任务/turn 汇总；项目切换立即隐藏旧范围，失败保留同范围的上次事实。 */
export function TitleBarStatButton() {
  const s = useStore((x) => x);
  const project = s.projects.find((p) => p.id === s.activeProjectId) ?? null;
  const projectId = project?.id;
  const [snapshot, setSnapshot] = useState<ProjectTaskSummary | null>(null);
  const [failure, setFailure] = useState<{ projectId: string; message: string } | null>(null);
  useEffect(() => {
    if (projectId == null) return;
    let alive = true;
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void command<ProjectTaskSummary>('project.taskSummary', { projectId })
        .then((data) => { if (alive && data.projectId === projectId) { setSnapshot(data); setFailure(null); } })
        .catch((e: unknown) => { if (alive) setFailure({ projectId, message: (e as Error).message }); })
        .finally(() => { pending = false; });
    };
    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('legacy-on')) refresh();
    }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [projectId]);
  const facts = snapshot?.projectId === projectId ? snapshot : null;
  const error = failure != null && failure.projectId === projectId ? failure.message : null;
  return (
    <button
      className="zs-tb-stat zs-tb-no-drag"
      data-zs-running-tasks={facts == null ? undefined : String(facts.unfinishedTasks)}
      data-zs-running-turns={facts == null ? undefined : String(facts.activeTurns)}
      title={project != null
        ? `${project.displayName} 的未结束任务与在途 turn（项目范围、受众过滤）${error != null ? `；读取失败：${error}（保留上次事实）` : ''}`
        : '打开项目后显示该项目的任务状态'}
      onClick={() => navigate(project != null ? `/board?scope=project&projectId=${project.id}` : '/board')}
    >
      <Icon name="activity" size={12} />
      后台任务 <strong>{facts?.unfinishedTasks ?? '—'}</strong>
      <span className="faint"> · {facts?.activeTurns ?? '—'} turn</span>
      {error != null ? <span title={error}> · 读取失败</span> : null}
    </button>
  );
}

/** 项目管理下拉（原型 projectMenu：勾选=显示在侧栏；点名=切换当前项目并进入其房间/主页；
 *  +打开文件夹；目录失效时给「重新定位」入口）。 */
function ProjectMenu({ anchor, onClose,trigger }: { anchor: { x: number; y: number }; onClose: () => void;trigger:HTMLElement|null }) {
  // useSyncExternalStore 合同：selector 必须返回稳定引用——先取 s.projects（数组引用随
  // store 版本变化），再用 useMemo 派生过滤结果（R66 P1 根因修复；内联 .filter 每次快照
  // 产生新数组 → getSnapshot 不缓存 → Maximum update depth → 整树卸载）。
  const projectsAll = useStore((s) => s.projects);
  const rooms = useStore((s) => s.rooms);
  const activeId = useStore((s) => s.activeProjectId);
  const visible = useStore((s) => s.visibleProjectIds);
  const [filter, setFilter] = useState('');
  const projects = useMemo(() => projectsAll.filter((p) => p.removedAt == null), [projectsAll]);
  const list = useMemo(
    () => projects.filter((p) => filter.length === 0 || p.displayName.toLowerCase().includes(filter.toLowerCase())),
    [projects, filter],
  );
  return (
    <Menu anchor={anchor} onClose={onClose} trigger={trigger}>
      <div className="menu-label">项目管理 · 显示在侧栏 / 切换当前项目</div>
      <div className="menu-search">
        <Icon name="search" size={12} className="faint" />
        <input className="menu-search-input" placeholder="搜索项目…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
      </div>
      <div className="menu-head row">
        <span className="small faint">显示在侧栏</span>
        <div className="spacer" />
        <span className="small faint">项目</span>
      </div>
      {list.map((p) => {
        const isVisible = visible.includes(p.id);
        const isCurrent = p.id === activeId;
        return (
          <div key={p.id} className="menu-project-row">
            <button
              className={`menu-check${isVisible ? ' on' : ''}${isCurrent ? ' locked' : ''}`}
              aria-pressed={isVisible}
              title={isCurrent ? '当前项目不能隐藏，切换到其他项目后可隐藏' : isVisible ? '从侧栏隐藏（只影响显示）' : '显示在侧栏'}
              onClick={(e) => { e.stopPropagation(); toggleProjectVisible(p.id); }}
            >
              <Icon name={isVisible ? 'check-square' : 'square'} size={13} />
            </button>
            <button
              className="menu-project-name"
              title={p.rootPath}
              onClick={() => {
                const first = rooms.find((r) => r.projectId === p.id && r.archivedAt == null);
                void switchFocusProject(p.id).then((ok) => {
                  if (!ok) { toast('切换失败（未注册）', 'error'); return; }
                  navigate(first ? `/project/${p.id}/room/${first.id}` : `/project/${p.id}`);
                });
                onClose();
              }}
            >
              <Icon name={p.status === 'missing' ? 'alert-triangle' : 'folder'} size={13} />
              <span className="truncate">{p.displayName}</span>
              {isCurrent ? <span className="tag accent">当前</span> : null}
              {p.status === 'missing' ? <span className="tag danger">目录失效</span> : null}
            </button>
          </div>
        );
      })}
      {list.length === 0 ? (
        <div className="side-empty" style={{ padding: '6px 10px' }}>{s_emptyText(filter)}</div>
      ) : null}
      <div className="menu-sep" />
      <button className="menu-item" onClick={() => { onClose(); navigate('/welcome'); }}>
        <Icon name="plus" size={13} /> 打开本地文件夹…
      </button>
      <button className="menu-item" onClick={() => { onClose(); if (activeId !== '') navigate(`/project/${activeId}`); }}>
        <Icon name="refresh" size={13} /> 项目主页（目录失效时重新定位）
      </button>
    </Menu>
  );
}

function s_emptyText(filter: string): string {
  return filter.length > 0 ? '没有匹配的项目' : '还没有注册项目——用下面的「打开本地文件夹…」添加';
}
