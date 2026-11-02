import type { App, BrowserWindow, Menu, MenuItemConstructorOptions, Tray } from 'electron';

type TrayWindow = Pick<BrowserWindow, 'on' | 'isDestroyed' | 'isMinimized' | 'isVisible' | 'restore' | 'show' | 'hide' | 'focus' | 'minimize'>;
type NativeTray = Pick<Tray, 'on' | 'isDestroyed' | 'destroy' | 'setToolTip' | 'setContextMenu'>;

/** 一个项目在托盘「AI 工作台」里显示的一行事实。 */
export interface TrayProjectFacts {
  id: string;
  name: string;
  /** 正在执行的 agent turn 数。 */
  activeTurns: number;
  /** 未完成任务数。 */
  unfinishedTasks: number;
}

/** 托盘菜单用的只读快照。读不到时 `updatedAt` 为 null，菜单显示「状态读取中」。 */
export interface TrayMenuFacts {
  projects: TrayProjectFacts[];
  updatedAt: number | null;
}

export interface WindowsTrayDependencies {
  platform: NodeJS.Platform;
  app: Pick<App, 'on' | 'quit' | 'getVersion'>;
  shutdown: () => Promise<unknown>;
  daemonStopping: () => boolean;
  createTray: (iconPath: string) => NativeTray;
  buildMenu: (items: MenuItemConstructorOptions[]) => Menu;
  openSettings: () => void;
  /** 打开渲染器页面（如 '/board'）；main 负责先显示窗口再改 hash。 */
  navigate: (route: string) => void;
  /** 读取托盘看板数据；失败就 reject，菜单退回「状态读取中」，绝不因此报错。 */
  readFacts: () => Promise<TrayMenuFacts>;
  reportError: (error: unknown) => void;
}

const EMPTY_FACTS: TrayMenuFacts = { projects: [], updatedAt: null };

/** Main owns this object for the whole application lifetime, including while hidden.
 * No renderer quit capability is needed: app.quit and internal operations share
 * the same shutdown barrier, and only a completed drain permits native close. */
export class WindowsTrayLifecycle {
  private win: TrayWindow | null = null;
  private tray: NativeTray | null = null;
  private iconPath: string | null = null;
  private quitPromise: Promise<void> | null = null;
  private quitReady = false;
  private quitRequested = false;
  private trayErrorReported = false;
  private facts: TrayMenuFacts = EMPTY_FACTS;
  private factsTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  /** 托盘菜单的刷新周期：只在托盘存活期间跑，且不进入退出流程。 */
  private readonly factsIntervalMs: number;

  constructor(private readonly deps: WindowsTrayDependencies, options: { factsIntervalMs?: number } = {}) {
    this.factsIntervalMs = options.factsIntervalMs ?? 20_000;
    deps.app.on('before-quit', event => {
      if (this.quitReady) return;
      event.preventDefault();
      void this.requestQuit();
    });
    deps.app.on('will-quit', () => {
      this.stopFactsTimer();
      if (this.tray != null && !this.tray.isDestroyed()) this.tray.destroy();
      this.tray = null;
    });
  }

  get quitting(): boolean { return this.quitRequested; }

  attachWindow(win: TrayWindow, iconPath: string | null): void {
    this.win = win;
    this.iconPath = iconPath;
    win.on('close', event => {
      if (this.quitReady) return;
      event.preventDefault();
      if (this.quitRequested) return;
      // Existing authenticated daemon.shutdown + Page.close remains an explicit
      // automation shutdown; an ordinary X never requests daemon shutdown.
      if (this.deps.daemonStopping() || this.deps.platform !== 'win32') {
        void this.requestQuit();
      } else if (this.ensureTray()) {
        win.hide();
      } else {
        // Keep a taskbar entry when no usable tray exists.
        win.minimize();
      }
    });
    // Windows does not emit app.before-quit on logout/restart/shutdown.
    // Do not veto the OS session end; begin the same bounded shutdown immediately.
    win.on('query-session-end', () => { void this.requestQuit(); });
    win.on('session-end', () => { void this.requestQuit(); });
    if (this.deps.platform === 'win32') this.ensureTray();
  }

  show(): void {
    if (this.quitRequested || this.win == null || this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  requestQuit(): Promise<void> {
    this.quitRequested = true;
    this.quitPromise ??= Promise.resolve().then(() => this.deps.shutdown()).then(() => {
      this.quitReady = true;
      this.deps.app.quit();
    }, error => {
      this.quitRequested = false;
      this.quitPromise = null;
      this.show();
      this.deps.reportError(error);
    });
    return this.quitPromise;
  }

  /** 托盘菜单文案（导出便于测试直接断言，不必解析 Electron 模板）。 */
  menuTemplate(): MenuItemConstructorOptions[] {
    const version = this.deps.app.getVersion();
    const { projects, updatedAt } = this.facts;
    const activeTurns = projects.reduce((n, p) => n + p.activeTurns, 0);
    const unfinished = projects.reduce((n, p) => n + p.unfinishedTasks, 0);
    const visible = this.win != null && !this.win.isDestroyed() && this.win.isVisible();
    const status = updatedAt == null
      ? '状态读取中…'
      : projects.length === 0
        ? '还没有打开的项目'
        : `${activeTurns} 个 AI 正在执行 · ${unfinished} 个任务未完成`;

    const projectRows: MenuItemConstructorOptions[] = projects.map(p => ({
      label: `${p.name} · ${p.activeTurns > 0 ? `${p.activeTurns} 个执行中` : '空闲'}${p.unfinishedTasks > 0 ? ` · ${p.unfinishedTasks} 个未完成` : ''}`,
      enabled: false,
    }));

    const workspace: MenuItemConstructorOptions[] = [
      { label: status, enabled: false },
      ...(projectRows.length > 0 ? [{ type: 'separator' as const }, ...projectRows] : []),
      { type: 'separator' },
      { label: '打开任务看板', click: () => this.openRoute('/board') },
      { label: '成员与 AI 设置', click: () => this.openRoute('/members') },
      { label: '待我处理', click: () => this.openRoute('/pending') },
    ];

    return [
      { label: `众说 ${version}`, enabled: false },
      { label: '本地项目群聊式 Agent 协同工作台', enabled: false },
      { type: 'separator' },
      { label: visible ? '隐藏众说窗口' : '打开众说窗口', click: () => { if (visible) this.hideWindow(); else this.show(); } },
      { type: 'separator' },
      { label: 'AI 工作台', submenu: workspace },
      { type: 'separator' },
      { label: '设置', click: () => { this.show(); if (!this.quitting) this.deps.openSettings(); } },
      { type: 'separator' },
      { label: '退出众说', click: () => { void this.requestQuit(); } },
    ];
  }

  private hideWindow(): void {
    if (this.quitRequested || this.win == null || this.win.isDestroyed()) return;
    this.win.hide();
  }

  private openRoute(route: string): void {
    if (this.quitting) return;
    this.show();
    this.deps.navigate(route);
  }

  /** 拉一次看板事实并重绘菜单；失败时保留上一次数字，不弹错误。 */
  private refreshFacts(): void {
    if (this.refreshing || this.tray == null || this.tray.isDestroyed()) return;
    this.refreshing = true;
    void this.deps.readFacts().then(facts => {
      this.facts = facts;
      this.applyMenu();
    }, () => {
      /* 托盘不是数据通道：读不到就沿用旧快照，下次再试 */
    }).finally(() => { this.refreshing = false; });
  }

  private applyMenu(): void {
    if (this.tray == null || this.tray.isDestroyed()) return;
    this.tray.setToolTip(this.tooltip());
    this.tray.setContextMenu(this.deps.buildMenu(this.menuTemplate()));
  }

  private tooltip(): string {
    const { projects, updatedAt } = this.facts;
    if (updatedAt == null) return '众说';
    const activeTurns = projects.reduce((n, p) => n + p.activeTurns, 0);
    return activeTurns > 0 ? `众说 · ${activeTurns} 个 AI 正在执行` : '众说';
  }

  private stopFactsTimer(): void {
    if (this.factsTimer == null) return;
    clearInterval(this.factsTimer);
    this.factsTimer = null;
  }

  private ensureTray(): boolean {
    if (this.tray != null && !this.tray.isDestroyed()) return true;
    let candidate: NativeTray | null = null;
    try {
      if (this.iconPath == null) throw Error('未找到众说图标');
      candidate = this.deps.createTray(this.iconPath);
      candidate.setToolTip('众说');
      candidate.setContextMenu(this.deps.buildMenu(this.menuTemplate()));
      candidate.on('click', () => { this.show(); this.refreshFacts(); });
      candidate.on('double-click', () => this.show());
      if (candidate.isDestroyed()) throw Error('众说托盘图标不可用');
      this.tray = candidate;
      this.trayErrorReported = false;
      this.stopFactsTimer();
      this.factsTimer = setInterval(() => { this.refreshFacts(); }, this.factsIntervalMs);
      this.factsTimer.unref?.();
      return true;
    } catch (error) {
      if (candidate != null && !candidate.isDestroyed()) candidate.destroy();
      this.tray = null;
      this.stopFactsTimer();
      if (!this.trayErrorReported) {
        this.trayErrorReported = true;
        this.deps.reportError(error);
      }
      return false;
    }
  }
}
