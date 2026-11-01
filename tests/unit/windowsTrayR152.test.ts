import { EventEmitter } from 'node:events';
import type { Menu, MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { WindowsTrayLifecycle, type WindowsTrayDependencies } from '../../src/ui/windowsTray.ts';

function harness(platform: NodeJS.Platform = 'win32') {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false), isMinimized: vi.fn(() => false),
    restore: vi.fn(), show: vi.fn(), hide: vi.fn(), focus: vi.fn(), minimize: vi.fn(),
  });
  const tray = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false), destroy: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(),
  });
  let menu: MenuItemConstructorOptions[] = [];
  let finishDrain!: () => void;
  const shutdown = vi.fn(() => new Promise<void>(resolve => { finishDrain = resolve; }));
  const deps: WindowsTrayDependencies = {
    platform, app: app as unknown as WindowsTrayDependencies['app'],
    shutdown, daemonStopping: vi.fn(() => false),
    createTray: vi.fn(() => tray as unknown as ReturnType<WindowsTrayDependencies['createTray']>),
    buildMenu: vi.fn(items => { menu = items; return {} as Menu; }),
    openSettings: vi.fn(), openManual: vi.fn(), openDataDirectory: vi.fn(), reportError: vi.fn(),
  };
  const lifecycle = new WindowsTrayLifecycle(deps);
  const attach = (icon: string | null = 'ROOT/logo.png') => lifecycle.attachWindow(win as unknown as Parameters<typeof lifecycle.attachWindow>[0], icon);
  const event = () => ({ preventDefault: vi.fn() });
  const close = () => { const e = event(); win.emit('close', e); return e; };
  const click = (label: string) => menu.find(item => item.label === label)!.click!({} as never, {} as never, {} as never);
  return { app, win, tray, deps, shutdown, lifecycle, attach, event, close, click, finish: () => finishDrain() };
}

describe('R152 Windows native tray lifecycle', () => {
  it('creates a retained branded tray and hides X without stopping background work', () => {
    const h = harness(); h.attach();
    expect(h.deps.createTray).toHaveBeenCalledWith('ROOT/logo.png');
    expect(h.tray.setToolTip).toHaveBeenCalledWith('众说');
    expect(h.tray.setContextMenu).toHaveBeenCalledOnce();
    expect(h.close().preventDefault).toHaveBeenCalledOnce();
    h.close();
    expect(h.win.hide).toHaveBeenCalledTimes(2);
    expect(h.shutdown).not.toHaveBeenCalled();
    expect(h.app.quit).not.toHaveBeenCalled();
    expect(h.tray.destroy).not.toHaveBeenCalled();
    // A normal minimize event has no tray/close side effects.
    h.win.emit('minimize');
    expect(h.win.hide).toHaveBeenCalledTimes(2);
  });

  it.each(['click', 'double-click'])('restores and focuses from native %s', event => {
    const h = harness(); h.attach(); h.close();
    h.win.isMinimized.mockReturnValue(true);
    h.tray.emit(event);
    expect(h.win.restore).toHaveBeenCalledOnce();
    expect(h.win.show).toHaveBeenCalledOnce();
    expect(h.win.focus).toHaveBeenCalledOnce();
    expect(h.shutdown).not.toHaveBeenCalled();
  });

  it('opens existing settings/manual/data actions and supports second-launch show', () => {
    const h = harness(); h.attach();
    h.click('打开众说'); h.click('设置'); h.click('操作手册'); h.click('打开数据目录');
    h.lifecycle.show();
    expect(h.deps.openSettings).toHaveBeenCalledOnce();
    expect(h.deps.openManual).toHaveBeenCalledOnce();
    expect(h.deps.openDataDirectory).toHaveBeenCalledOnce();
    expect(h.win.focus).toHaveBeenCalledTimes(4);
  });

  it('shares one drain across repeated tray exit, app.quit and close during shutdown', async () => {
    const h = harness(); h.attach(); h.close(); h.win.hide.mockClear();
    h.click('退出众说');
    const quit = h.lifecycle.requestQuit();
    expect(h.lifecycle.requestQuit()).toBe(quit);
    const before = h.event(); h.app.emit('before-quit', before);
    expect(before.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(h.shutdown).toHaveBeenCalledOnce();
    expect(h.close().preventDefault).toHaveBeenCalledOnce();
    h.tray.emit('click'); h.click('设置');
    expect(h.deps.openSettings).not.toHaveBeenCalled();
    expect(h.win.hide).not.toHaveBeenCalled();
    expect(h.app.quit).not.toHaveBeenCalled();
    expect(h.tray.destroy).not.toHaveBeenCalled();
    h.finish(); await quit;
    expect(h.app.quit).toHaveBeenCalledOnce();
    expect(h.close().preventDefault).not.toHaveBeenCalled();
    const finalBefore = h.event(); h.app.emit('before-quit', finalBefore);
    expect(finalBefore.preventDefault).not.toHaveBeenCalled();
    h.app.emit('will-quit');
    expect(h.tray.destroy).toHaveBeenCalledOnce();
  });

  it('handles internal/automation app.quit even before a window exists', async () => {
    const h = harness();
    const e = h.event(); h.app.emit('before-quit', e);
    await Promise.resolve();
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(h.shutdown).toHaveBeenCalledOnce();
    h.finish(); await h.lifecycle.requestQuit();
    expect(h.app.quit).toHaveBeenCalledOnce();
    expect(h.deps.createTray).not.toHaveBeenCalled();
  });

  it.each(['query-session-end', 'session-end'])('allows OS %s and starts one bounded drain', async event => {
    const h = harness(); h.attach();
    const e = h.event(); h.win.emit(event, e); h.win.emit(event, e);
    await Promise.resolve();
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(h.shutdown).toHaveBeenCalledOnce();
    h.close(); expect(h.win.hide).not.toHaveBeenCalled();
    h.finish(); await h.lifecycle.requestQuit();
  });

  it('permits actual exit after explicit authenticated daemon shutdown', async () => {
    const h = harness(); h.attach();
    vi.mocked(h.deps.daemonStopping).mockReturnValue(true);
    h.close(); await Promise.resolve();
    expect(h.win.hide).not.toHaveBeenCalled();
    expect(h.shutdown).toHaveBeenCalledOnce();
    h.finish(); await h.lifecycle.requestQuit();
    expect(h.close().preventDefault).not.toHaveBeenCalled();
  });

  it.each(['create', 'configure', 'missing'])('keeps X reachable if tray %s fails and can retry', failure => {
    const h = harness();
    if (failure === 'create') vi.mocked(h.deps.createTray).mockImplementation(() => { throw Error('tray creation failed'); });
    if (failure === 'configure') h.tray.setContextMenu.mockImplementation(() => { throw Error('menu failed'); });
    h.attach(failure === 'missing' ? null : 'ROOT/logo.png');
    h.close(); h.close();
    expect(h.win.hide).not.toHaveBeenCalled();
    expect(h.win.minimize).toHaveBeenCalledTimes(2);
    expect(h.deps.reportError).toHaveBeenCalledOnce();
    expect(h.shutdown).not.toHaveBeenCalled();
    if (failure === 'configure') expect(h.tray.destroy).toHaveBeenCalled();
    if (failure !== 'missing') {
      h.tray.setContextMenu.mockReset();
      vi.mocked(h.deps.createTray).mockReturnValue(h.tray as unknown as ReturnType<WindowsTrayDependencies['createTray']>);
      h.close();
      expect(h.win.hide).toHaveBeenCalledOnce();
    }
  });

  it('recreates a destroyed tray before permitting another hide', () => {
    const h = harness(); h.attach();
    h.tray.isDestroyed.mockReturnValueOnce(true);
    h.close();
    expect(h.deps.createTray).toHaveBeenCalledTimes(2);
    expect(h.win.hide).toHaveBeenCalledOnce();
  });

  it('keeps the application reachable if shutdown rejects', async () => {
    const h = harness(); h.attach(); h.close();
    h.shutdown.mockRejectedValueOnce(Error('drain failed'));
    await h.lifecycle.requestQuit();
    expect(h.app.quit).not.toHaveBeenCalled();
    expect(h.lifecycle.quitting).toBe(false);
    expect(h.win.show).toHaveBeenCalledOnce();
    expect(h.deps.reportError).toHaveBeenCalledOnce();
    expect(h.tray.destroy).not.toHaveBeenCalled();
  });

  it('keeps normal close-to-quit on other platforms without constructing a Windows tray', async () => {
    const h = harness('linux'); h.attach(); h.close(); await Promise.resolve();
    expect(h.deps.createTray).not.toHaveBeenCalled();
    expect(h.win.hide).not.toHaveBeenCalled();
    h.finish(); await h.lifecycle.requestQuit();
    expect(h.app.quit).toHaveBeenCalledOnce();
  });
});
