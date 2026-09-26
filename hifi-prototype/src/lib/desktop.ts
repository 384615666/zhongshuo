/**
 * 桌面能力桥（渲染层视角）
 *
 * 同一个渲染层要能在两种宿主里跑：
 *  - Electron 桌面客户端：走 preload 暴露的 window.zhongshuo
 *  - 浏览器（局域网访问/调试）：没有原生能力，降级为无操作 + 明确的提示文案
 *
 * 这样"这是桌面客户端"不是靠界面自称，而是靠真实能力有无来区分。
 */

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  window: {
    minimize: () => Promise<void>;
    /** 从托盘恢复显示；用于通知点击回到窗口等场景 */
    show: () => Promise<WindowState>;
    toggleMaximize: () => Promise<WindowState>;
    close: () => Promise<void>;
    getState: () => Promise<WindowState>;
    requestQuit: () => Promise<void>;
    onStateChange: (cb: (s: WindowState) => void) => () => void;
  };
  pickDirectory: () => Promise<string | null>;
  revealPath: (p: string) => Promise<boolean>;
  /** 用系统默认程序打开路径；返回 null 表示宿主没提供这个能力 */
  openPath: (p: string) => Promise<{ ok: boolean; reason?: string } | null>;
  /** 真实的应用数据目录（Electron userData）；浏览器宿主没有这个概念 */
  appDataDir: () => Promise<string | null>;
  openExternal: (url: string) => Promise<boolean>;
  reportRuntime: (summary: { runningTasks: number; runningTurns: number; detail?: string }) => Promise<boolean>;
}

export interface WindowState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

declare global {
  interface Window {
    zhongshuo?: DesktopBridge;
  }
}

/** 真实桌面桥；不存在则为 null（说明当前跑在浏览器里） */
export function desktop(): DesktopBridge | null {
  return typeof window !== 'undefined' && window.zhongshuo?.isDesktop ? window.zhongshuo : null;
}

export const isDesktop = () => desktop() !== null;

/**
 * 取原生目录选择器。
 * 桌面环境下是真的系统目录选择对话框；浏览器环境返回 null，
 * 调用方据此显示"浏览器里无法打开本地目录"的说明，而不是假装成功。
 */
export async function pickDirectory(): Promise<{ path: string | null; reason?: string }> {
  const d = desktop();
  if (!d) {
    return {
      path: null,
      reason:
        '当前在浏览器中打开，没有原生目录选择器。请用桌面客户端打开本地项目目录；浏览器入口只用于查看与操作已有项目。',
    };
  }
  const path = await d.pickDirectory();
  return { path, reason: path ? undefined : '已取消选择。' };
}

/** 供顶栏关闭按钮使用：桌面里是"缩到托盘"，不是关掉浏览器标签 */
export async function closeWindow(): Promise<'desktop' | 'browser'> {
  const d = desktop();
  if (!d) return 'browser';
  await d.window.close();
  return 'desktop';
}

export async function requestQuit(): Promise<boolean> {
  const d = desktop();
  if (!d) return false;
  await d.window.requestQuit();
  return true;
}

export async function revealPath(p: string): Promise<boolean> {
  const d = desktop();
  if (!d) return false;
  return d.revealPath(p);
}

/**
 * 用系统默认程序打开一个目录（"在资源管理器中打开项目目录"）。
 * 浏览器宿主没有原生能力 → 返回 null，由调用方显示限制说明，不假装打开成功。
 */
export async function openPath(p: string): Promise<{ ok: boolean; reason?: string } | null> {
  const d = desktop();
  if (!d || typeof d.openPath !== 'function') return null;
  return d.openPath(p);
}

/**
 * 真实的应用数据目录。
 *
 * 为什么需要它：应用设置里的「打开目录」不能是假按钮（§2.4）。UI 显示的
 * `<appData>/zhongshuo/` 是文档口径；桌面宿主里能打开的**真实**目录就是
 * Electron 的 userData（原型不写 SQLite，所以这里没有 state.sqlite）。
 * 浏览器宿主没有原生目录 → null，由调用方如实说明限制。
 */
export async function appDataDir(): Promise<string | null> {
  const d = desktop();
  if (!d || typeof d.appDataDir !== 'function') return null;
  return d.appDataDir();
}
