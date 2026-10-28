/**
 * 自绘标题栏（第五十四轮 H3 §3——按批准原型 TitleBar 形态的正式接线版）：
 * 经 **portal 挂到 #zs-titlebar**（index.html 独立挂载点，位于 #hifi-root/#legacy-root 之外）
 * ——legacy 接管（body.legacy-on 只隐藏 #hifi-root）与 hifi 样式禁用都不影响本栏；类名与
 * hifi-flag.js 注入的常驻样式（<style data-zs-titlebar>）共享，React 挂载成功即替换最小壳。
 *
 * 窗口控制：window.zsWindow 窄桥（枚举动作经 main 侧 senderFrame 校验，只作用于可信主窗口）；
 * close=win.close() → window-all-closed → shutdownDaemon() 既有优雅收口链（不为无边框绕过）。
 * 浏览器宿主（探针 http 环境）无 zsWindow：保留同样的控件布局，按钮 tooltip 说明能力边界。
 * R90 起正常态只显示品名与当前项目；daemon 在线本身不证明 AI 可回复，
 * 因此不再常驻“已连接/真实任务”。仅启动中或断线等需要处理的事实才出现状态入口。
 *
 * R66 P1（反例=冻结 v3 点「项目」卸载整个 React root）：
 *  - ProjectMenu 的 selector 必须返回**稳定引用**（先取 s.projects 再 useMemo filter——
 *    useSyncExternalStore 合同）；全量扫描同类「内联 .filter selector」仅此一处。
 *  - portal 内容整体包在 TitleBarBoundary 内：标题栏任何渲染错误只降级为**最小控制条**
 *    （名称+拖动+三枚窗口按钮，零 store 订阅），主界面与窗口控制不再被连带卸载；
 *    ProjectMenu 另有一层内边界——菜单异常只关菜单，标题栏其余功能保留。
 *  - 项目入口保留单个“当前项目名 ▾”按钮，菜单内仍可搜索、切换、显隐与打开文件夹。
 */
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { Menu } from './ui';
import { useStore, toast } from '../data/store';
import { switchFocusProject } from '../loader';
import { toggleProjectVisible } from '../data/actions-nav';
import { navigate } from '../lib/router';

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
          <button type="button" className="zs-winbtn" title="最小化" aria-label="最小化" onClick={() => { void d?.minimize(); }}><Icon name="minus" size={12} /></button>
          <button type="button" className="zs-winbtn" title="最大化/还原" aria-label="最大化或还原" onClick={() => { void d?.toggleMaximize(); }}><Icon name="maximize" size={11} /></button>
          <button type="button" className="zs-winbtn close" title="关闭窗口（经既有优雅停机链）" aria-label="关闭窗口" onClick={() => { void d?.close(); }}><Icon name="x" size={12} /></button>
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

  // 正常在线时不占标题栏；只有需要用户处理（或仍在启动）的状态才出现。
  // 文案只描述已取得的连接事实，不把 daemon 连上等同为“AI 可回复”。
  const connectionLabel = conn === 'failed'
    ? '连接恢复失败'
    : conn === 'suspended'
      ? '连接已暂停'
      : conn === 'recovering'
        ? '正在恢复连接'
        : conn === 'offline'
          ? '连接已断开'
          : boot === 'pending'
            ? '正在连接服务'
            : boot === 'failed'
              ? '服务连接失败'
              : null;
  const connectionTone = conn === 'failed' || conn === 'offline' || boot === 'failed' ? 'danger' : 'warning';
  const connectionDetail = [
    connectionLabel,
    connInfo != null && connInfo.length > 0 ? connInfo : null,
    '打开设置查看本地诊断；结果待确认的发送记录会保留，请检查后决定是否重试。',
  ].filter((part): part is string => part != null).join(' · ');
  return createPortal(
    <TitleBarBoundary>
      <div
        className="zs-titlebar"
        data-zs-titlebar-rendered="react"
        data-zs-connection-phase={conn}
        data-zs-boot-phase={boot}
      >
        <span className="zs-tb-name">众说</span>
        {connectionLabel != null ? (
          <button
            type="button"
            className="zs-tb-status zs-tb-no-drag"
            data-tone={connectionTone}
            data-pending={conn === 'recovering' || boot === 'pending' ? '1' : undefined}
            title={connectionDetail}
            aria-label={`${connectionLabel}，打开设置查看本地诊断`}
            onClick={() => navigate('/settings?section=help')}
          >
            <Icon name={conn === 'recovering' || boot === 'pending' ? 'loader' : 'wifi-off'} size={12} />
            <span>{connectionLabel}</span>
          </button>
        ) : null}

        {/* 正常顶栏只保留当前项目入口；搜索、显示/隐藏与打开文件夹仍在同一菜单。 */}
        <button
          type="button"
          className="zs-tb-project zs-tb-no-drag"
          data-zs-project-menu-btn="1"
          data-project-status={project?.status ?? 'none'}
          ref={projectTrigger}
          title={project != null
            ? `切换项目、显示项目或打开文件夹\n当前项目：${project.displayName}（${project.rootPath}）`
            : '打开文件夹添加项目'}
          aria-label={project != null ? `项目管理，当前项目：${project.displayName}` : '项目管理，尚未选择项目'}
          aria-haspopup="menu"
          aria-expanded={pmAt != null}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setPmAt((prev) => (prev == null ? { x: Math.max(8, r.left), y: r.bottom + 6 } : null));
          }}
        >
          <Icon name={project?.status === 'missing' ? 'alert-triangle' : 'folder'} size={12} className={project?.status === 'missing' ? 'warn-icon' : 'faint'} />
          <span className="zs-tb-project-name">{project?.displayName ?? '选择项目'}</span>
          <Icon name="chevron-down" size={11} className="faint" />
        </button>

        <div
          className="zs-tb-drag"
          title="拖动窗口；双击最大化/还原"
          onDoubleClick={() => { void d?.toggleMaximize().then((r) => { if (r.ok && typeof r.maximized === 'boolean') setState((s) => ({ ...s, maximized: r.maximized as boolean })); }); }}
        />
        <button type="button" className="zs-winbtn" title={d == null ? '最小化（桌面客户端可用）' : '最小化'} aria-label="最小化" onClick={() => { void d?.minimize(); }}>
          <Icon name="minus" size={12} />
        </button>
        <button type="button" className="zs-winbtn" title={state.maximized ? '还原' : '最大化'} aria-label={state.maximized ? '还原窗口' : '最大化窗口'} onClick={() => { void d?.toggleMaximize().then((r) => { if (r.ok && typeof r.maximized === 'boolean') setState((s) => ({ ...s, maximized: r.maximized as boolean })); }); }}>
          <Icon name={state.maximized ? 'copy' : 'maximize'} size={11} />
        </button>
        <button type="button" className="zs-winbtn close" title="关闭众说" aria-label="关闭窗口" onClick={() => { void d?.close(); }}>
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
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <span className="truncate" style={{ display: 'block' }}>{p.displayName}</span>
                <span className="small faint" style={{ display: 'block', overflowWrap: 'anywhere' }}>{p.rootPath}</span>
              </span>
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
