/**
 * preload（§16.2）
 *
 * 渲染进程拿不到 Node、拿不到 ipcRenderer，只能调用这里显式列出的方法。
 * 通道名固定写死，渲染层无法传任意 channel —— 这是把"窄接口"真正落地的位置。
 *
 * 用 CJS：Electron 的 preload 在 sandbox/isolated 上下文里最稳的是 CommonJS。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 只允许主进程单向推送的事件，渲染层注册回调用 */
const EVENTS = ['zs:window-state'];

contextBridge.exposeInMainWorld('zhongshuo', {
  /** 标记：渲染层据此判断"运行在真实桌面客户端里"还是"运行在浏览器里" */
  isDesktop: true,
  platform: process.platform,

  window: {
    minimize: () => ipcRenderer.invoke('zs:window-minimize'),
    show: () => ipcRenderer.invoke('zs:window-show'),
    toggleMaximize: () => ipcRenderer.invoke('zs:window-toggle-maximize'),
    close: () => ipcRenderer.invoke('zs:window-close'),
    getState: () => ipcRenderer.invoke('zs:window-state'),
    /** 与关闭（缩托盘）不同：走"退出前确认"流程 */
    requestQuit: () => ipcRenderer.invoke('zs:request-quit'),
    /** 订阅窗口状态；返回取消订阅函数 */
    onStateChange: (cb) => {
      const channel = EVENTS[0];
      const handler = (_e, state) => cb(state);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  /** 原生目录选择器（§8.2） */
  pickDirectory: () => ipcRenderer.invoke('zs:pick-directory'),
  revealPath: (p) => ipcRenderer.invoke('zs:reveal-path', p),
  /** 用系统默认程序打开路径（目录/文件）；返回 {ok, reason}，不猜结果 */
  openPath: (p) => ipcRenderer.invoke('zs:open-path', p),
  openExternal: (url) => ipcRenderer.invoke('zs:open-external', url),

  /** 把运行态摘要同步给主进程，供托盘提示与退出确认使用 */
  reportRuntime: (summary) => ipcRenderer.invoke('zs:report-runtime', summary),
});
