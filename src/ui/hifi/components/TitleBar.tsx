/**
 * 自绘标题栏（第五十四轮 H3 §3——按批准原型 TitleBar 形态的正式接线版）：
 * 经 **portal 挂到 #zs-titlebar**（index.html 独立挂载点，位于 #hifi-root/#legacy-root 之外）
 * ——legacy 接管（body.legacy-on 只隐藏 #hifi-root）与 hifi 样式禁用都不影响本栏；类名与
 * hifi-flag.js 注入的常驻样式（<style data-zs-titlebar>）共享，React 挂载成功即替换最小壳。
 *
 * 窗口控制：window.zsWindow 窄桥（枚举动作经 main 侧 senderFrame 校验，只作用于可信主窗口）；
 * close=win.close() → window-all-closed → shutdownDaemon() 既有优雅收口链（不为无边框绕过）。
 * 浏览器宿主（探针 http 环境）无 zsWindow：保留同样的控件布局，按钮 tooltip 说明能力边界。
 * R90 起正常态只显示品名；daemon 在线本身不证明 AI 可回复，
 * 因此不再常驻“已连接/真实任务”。仅启动中或断线等需要处理的事实才出现状态入口。
 *
 * R201 第 3 项（用户要求）：去掉品名右侧的「当前项目 ▾ / 切换工作区」组件——项目/工作区
 * 切换统一走侧栏「工作区」按钮与项目列表；标题栏只剩品名、异常连接状态与窗口按钮。
 */
import { Component, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useStore } from '../data/store';
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
          <span className="zs-tb-stat" title="标题栏显示异常；主界面不受影响，重启应用可恢复完整标题栏">标题栏已降级</span>
          <div className="zs-tb-drag" title="拖动窗口；双击最大化/还原" onDoubleClick={() => { void d?.toggleMaximize(); }} />
          <button type="button" className="zs-winbtn" title="最小化" aria-label="最小化" onClick={() => { void d?.minimize(); }}><Icon name="minus" size={12} /></button>
          <button type="button" className="zs-winbtn" title="最大化/还原" aria-label="最大化或还原" onClick={() => { void d?.toggleMaximize(); }}><Icon name="maximize" size={11} /></button>
          <button type="button" className="zs-winbtn close" title="关闭窗口，正常退出程序" aria-label="关闭窗口" onClick={() => { void d?.close(); }}><Icon name="x" size={12} /></button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function TitleBar() {
  const mount = typeof document !== 'undefined' ? document.getElementById('zs-titlebar') : null;
  const boot = useStore((s) => s.boot);
  // 实时连接态（r55）：注册 zs:disconnect/zs:reconnected（main 在管道关闭/重连时推送）——
  // 首启 ready 不再永久等同在线；浏览器宿主收不到事件时保持 online 缺省（按 boot 呈现）。
  const conn = useStore((s) => s.conn);
  const connInfo = useStore((s) => s.connInfo);
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

        <div
          className="zs-tb-drag"
          title="拖动窗口；双击最大化/还原"
          onDoubleClick={() => { void d?.toggleMaximize().then((r) => { if (r.ok && typeof r.maximized === 'boolean') setState((s) => ({ ...s, maximized: r.maximized as boolean })); }); }}
        />
        <button type="button" className="zs-winbtn" title={d == null ? '最小化；桌面客户端可用' : '最小化'} aria-label="最小化" onClick={() => { void d?.minimize(); }}>
          <Icon name="minus" size={12} />
        </button>
        <button type="button" className="zs-winbtn" title={state.maximized ? '还原' : '最大化'} aria-label={state.maximized ? '还原窗口' : '最大化窗口'} onClick={() => { void d?.toggleMaximize().then((r) => { if (r.ok && typeof r.maximized === 'boolean') setState((s) => ({ ...s, maximized: r.maximized as boolean })); }); }}>
          <Icon name={state.maximized ? 'copy' : 'maximize'} size={11} />
        </button>
        <button type="button" className="zs-winbtn close" title="关闭众说" aria-label="关闭窗口" onClick={() => { void d?.close(); }}>
          <Icon name="x" size={12} />
        </button>
      </div>
    </TitleBarBoundary>,
    mount,
  );
}
