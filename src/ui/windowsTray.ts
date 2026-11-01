import type { App, BrowserWindow, Menu, MenuItemConstructorOptions, Tray } from 'electron';

type TrayWindow = Pick<BrowserWindow, 'on' | 'isDestroyed' | 'isMinimized' | 'restore' | 'show' | 'hide' | 'focus' | 'minimize'>;
type NativeTray = Pick<Tray, 'on' | 'isDestroyed' | 'destroy' | 'setToolTip' | 'setContextMenu'>;

export interface WindowsTrayDependencies {
  platform: NodeJS.Platform;
  app: Pick<App, 'on' | 'quit'>;
  shutdown: () => Promise<unknown>;
  daemonStopping: () => boolean;
  createTray: (iconPath: string) => NativeTray;
  buildMenu: (items: MenuItemConstructorOptions[]) => Menu;
  openSettings: () => void;
  openManual: () => void;
  openDataDirectory: () => void;
  reportError: (error: unknown) => void;
}

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

  constructor(private readonly deps: WindowsTrayDependencies) {
    deps.app.on('before-quit', event => {
      if (this.quitReady) return;
      event.preventDefault();
      void this.requestQuit();
    });
    deps.app.on('will-quit', () => {
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

  private ensureTray(): boolean {
    if (this.tray != null && !this.tray.isDestroyed()) return true;
    let candidate: NativeTray | null = null;
    try {
      if (this.iconPath == null) throw Error('未找到众说图标');
      candidate = this.deps.createTray(this.iconPath);
      candidate.setToolTip('众说');
      candidate.setContextMenu(this.deps.buildMenu([
        { label: '打开众说', click: () => this.show() },
        { label: '设置', click: () => { this.show(); if (!this.quitting) this.deps.openSettings(); } },
        { label: '操作手册', click: () => { this.show(); if (!this.quitting) this.deps.openManual(); } },
        { label: '打开数据目录', click: () => { if (!this.quitting) this.deps.openDataDirectory(); } },
        { type: 'separator' },
        { label: '退出众说', click: () => { void this.requestQuit(); } },
      ]));
      candidate.on('click', () => this.show());
      candidate.on('double-click', () => this.show());
      if (candidate.isDestroyed()) throw Error('众说托盘图标不可用');
      this.tray = candidate;
      this.trayErrorReported = false;
      return true;
    } catch (error) {
      if (candidate != null && !candidate.isDestroyed()) candidate.destroy();
      this.tray = null;
      if (!this.trayErrorReported) {
        this.trayErrorReported = true;
        this.deps.reportError(error);
      }
      return false;
    }
  }
}
