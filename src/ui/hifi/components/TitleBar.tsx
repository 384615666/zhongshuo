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
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useStore } from '../data/store';
import { command } from '../bridge';

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
  const connLabel = conn === 'offline'
    ? `已断开——重连中${connInfo != null && connInfo.length > 0 ? `（${connInfo}）` : ''}`
    : boot === 'pending' ? '连接服务中…' : boot === 'failed' ? '服务连接失败' : '已连接';
  const connOff = conn === 'offline' || boot !== 'ready';
  return createPortal(
    <div className="zs-titlebar" data-zs-titlebar-rendered="react">
      <span className="zs-tb-name">众说</span>
      <span className="zs-tb-stat zs-tb-no-drag" data-zs-conn={conn === 'offline' ? 'offline' : 'online'} title={conn === 'offline' ? `连接已断开，主进程正在重连${connInfo != null && connInfo.length > 0 ? `：${connInfo}` : ''}——命令会以「结果未知」回执，草稿与信封保留` : project != null ? `当前项目：${project.displayName}` : '尚未打开项目'}>
        <span className={connOff ? 'dot-off' : 'dot'} style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5, verticalAlign: 1, background: connOff ? '#c9312e' : '#22a55e' }} />
        {project != null ? `${project.displayName} · ${connLabel}` : connLabel}
      </span>
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
    </div>,
    mount,
  );
}
