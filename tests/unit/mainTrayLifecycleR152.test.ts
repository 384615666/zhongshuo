import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as url from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowsTrayLifecycle } from '../../src/ui/windowsTray.ts';
import * as runtimeMetadataDeadline from '../../src/contracts/runtimeMetadataDeadline.ts';
import * as editContextMenu from '../../src/ui/editContextMenu.ts';
import * as windowsAppIdentity from '../../src/ui/windowsAppIdentity.ts';
import * as localFileActions from '../../src/ui/localFileActions.ts';

// Exercise the actual main module with native process/OS boundaries replaced.
// Transpilation stays in memory: no app bundle, native process or data is created.
const mainCode = ts.transpileModule(readFileSync(new URL('../../src/ui/main.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
}).outputText;
const flush = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };

function harness(options: { ownerPid?: number; ownerMissing?: boolean; trayFails?: boolean; installed?: boolean; singleInstance?: boolean } = {}) {
  const windows: FakeWindow[] = [];
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const writes = new Map<string, string>();
  const nativeQuit = vi.fn();
  const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  const app = Object.assign(new EventEmitter(), {
    setName:vi.fn(), setAppUserModelId: vi.fn(), setPath: vi.fn(), getPath: () => 'C:/fixture', getVersion: () => '9.9.9',
    requestSingleInstanceLock: vi.fn(() => options.singleInstance !== false),
    commandLine: { appendSwitch: vi.fn() }, whenReady: () => Promise.resolve(),
    quit: vi.fn(() => {
      const e = event(); app.emit('before-quit', e);
      if (e.defaultPrevented) return;
      for (const win of windows) if (!win.destroyed) win.close();
      if (windows.some(win => !win.destroyed)) return;
      app.emit('will-quit'); nativeQuit();
    }), exit: vi.fn(),
  });
  class FakeWindow extends EventEmitter {
    destroyed = false;
    minimized = false;
    visible = false;
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(), getURL: () => 'zsres://app/index.html', isLoadingMainFrame: () => false,
      executeJavaScript: vi.fn(async () => true), setWindowOpenHandler: vi.fn(),
      session: { webRequest: { onBeforeRequest: vi.fn() } },
    });
    constructor() { super(); windows.push(this); }
    static getAllWindows() { return windows.filter(win => !win.destroyed); }
    static fromWebContents() { return windows[0] ?? null; }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    minimize = vi.fn(() => { this.minimized = true; });
    restore = vi.fn(() => { this.minimized = false; });
    show = vi.fn(() => { this.visible = true; });
    hide = vi.fn(() => { this.visible = false; });
    focus = vi.fn();
    setMenu = vi.fn();
    setAppDetails = vi.fn();
    getBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
    loadURL = vi.fn(async () => {});
    close() {
      const e = event(); this.emit('close', e);
      if (e.defaultPrevented) return;
      this.destroyed = true; this.emit('closed');
      if (FakeWindow.getAllWindows().length === 0) app.emit('window-all-closed');
    }
  }
  const child = Object.assign(new EventEmitter(), {
    pid: 456, exitCode: null as number | null,
    stderr: new EventEmitter(), stdout: new EventEmitter(), kill: vi.fn(),
  });
  const stop = () => { child.exitCode = 0; child.emit('exit', 0, null); };
  const drain = () => {
    child.stderr.emit('data', Buffer.from('stop-result {"complete":true,"phase":"closed"}\n'));
    child.emit('close', 0, null);
  };
  child.kill.mockImplementation(() => { stop(); drain(); return true; });
  const send = vi.fn(async () => ({ ok: true, data: {} }));
  const pipe = { send, closed: false, close: vi.fn(() => { pipe.closed = true; }) };
  const connect = vi.fn(async () => pipe);
  const spawn = vi.fn(() => child);
  let menu: Array<{ label?: string; click?: () => void }> = [];
  const trays: FakeTray[] = [];
  class FakeTray extends EventEmitter {
    constructor() { super(); if (options.trayFails) throw Error('native tray failed'); trays.push(this); }
    isDestroyed = () => false;
    destroy = vi.fn(); setToolTip = vi.fn(); setContextMenu = vi.fn();
  }
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) };
  const shell = { openPath: vi.fn(async () => '') };
  let ownerAvailable = !options.ownerMissing;
  const electron = {
    app, BrowserWindow: FakeWindow, Tray: FakeTray, Menu: { buildFromTemplate: (items: typeof menu) => { menu = items; return {}; } },
    nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => false, resize: vi.fn(() => ({})) })) },
    dialog, shell, ipcMain: { handle: (name: string, cb: (event: unknown, payload?: unknown) => unknown) => handlers.set(name, cb) },
    protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
    powerMonitor: new EventEmitter(), screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }) },
  };
  const mocks: Record<string, unknown> = {
    './windowsAppIdentity.ts':windowsAppIdentity,
    './editContextMenu.ts': editContextMenu,
    './localOpeners.ts': { detectLocalOpeners: () => [], isOpenableLocalFile: () => false, publicOpeners: () => [] },
    './localFileActions.ts': localFileActions,
    './windowsFileAssociations.ts': { windowsFileAssociations: () => [], openWindowsFileAssociation: vi.fn() },
    '../contracts/runtimeMetadataDeadline.ts': runtimeMetadataDeadline,
    electron, 'node:path': path, 'node:crypto': crypto, 'node:url': url,
    'node:fs': {
      existsSync: (file: string) => file.endsWith('logo.png') || (options.installed && file.endsWith('installed-desktop.json')),
      mkdirSync: vi.fn(), appendFileSync: vi.fn(), readdirSync: () => [],
      readFileSync: (file: string) => {
        if (file.endsWith('owner.json') && ownerAvailable) return JSON.stringify({ pid: options.ownerPid ?? child.pid });
        throw Error('fixture file absent');
      },
      writeFileSync: (file: string, data: string) => writes.set(file, data),
    },
    'node:child_process': { spawn,spawnSync:vi.fn(()=>({status:0})) },
    './windowsTray.ts': { WindowsTrayLifecycle },
    './connectionMonitor.ts': { ConnectionMonitor: class {
      start = vi.fn(); connected = vi.fn(); dispose = vi.fn(); suspend = vi.fn(); resume = vi.fn();
    } },
    '../contracts/daemonIpc.ts': { connectPipe: connect, ensureLocalCredential: () => ({ token: 'fixture' }), daemonPipeNameFor: () => 'fixture-pipe', localUserId: () => 'fixture' },
    '../contracts/atomicFile.ts': { atomicWriteFile: vi.fn() },
    '../contracts/dataCopyJob.ts': {
      reconcileInterruptedDataOperation: vi.fn(), readActiveDataOperation: () => null,
      readDataLocation: (root: string) => root, dataControlPaths: () => ({ root: 'C:/fixture-control' }),
    },
    '../contracts/localDataCopy.ts': {}, './testDisplay.ts': { resolveDisplayPlacement: () => null },
    './taskNotificationIpc.ts': { registerTaskNotificationIpc: () => vi.fn() },
    './installedDesktop.ts': {
      installedDesktopConfiguration: (_args: unknown, env: unknown) => ({ dataRoot: 'C:/fixture', env }), installedDaemonPipe: () => 'fixture-pipe',
    },
  };
  const proc = { env: { ZS_RUNTIME: 'fake', ZS_ALLOW_FAKE: '1', ZS_APP_DATA: 'C:/fixture' }, argv: ['electron'],execPath:'C:/fixture/Zhongshuo.exe', platform: 'win32', pid: 123, stderr: { write: vi.fn() } };
  runInNewContext(mainCode, {
    require: (name: string) => { if (!(name in mocks)) throw Error(`Unexpected dependency ${name}`); return mocks[name]; },
    __dirname: 'C:/fixture/dist/ui', exports: {}, process: proc, URL, Buffer, AbortController, performance,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const invoke = (channel: string, payload?: unknown) => handlers.get(channel)!({ senderFrame: { url: 'zsres://app/index.html' } }, payload);
  const click = (label: string) => menu.find(item => item.label === label)!.click!();
  return { app, windows, child, stop, drain, pipe, send, spawn, connect, writes, nativeQuit, trays, dialog, shell, invoke, click, menu: () => menu, proc, publishOwner: () => { ownerAvailable = true; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('R152 actual main lifecycle wiring', () => {
  it('X hides with no confirmation; minimize and repeat launch restore the same process', async () => {
    const h = harness(); await flush(); const win = h.windows[0]!;
    await h.invoke('zs:window', 'close');
    expect(win.visible).toBe(false); expect(win.destroyed).toBe(false);
    expect(h.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    await h.invoke('zs:window', 'minimize'); expect(win.minimized).toBe(true);
    h.app.emit('second-instance'); expect(win.visible).toBe(true); expect(win.minimized).toBe(false);
    expect(win.focus).toHaveBeenCalledOnce(); expect(h.spawn).toHaveBeenCalledOnce();
  });

  it.each([false, true])('QA daemon.shutdown + Page.close exits once after stdio drain (installed=%s)', async installed => {
    vi.useFakeTimers();
    const h = harness({ installed }); await flush(); const win = h.windows[0]!;
    const reply = await h.invoke('zs:command', { protocolVersion: 1, commandId: 'qa-stop', method: 'daemon.shutdown', params: {} });
    expect(reply).toEqual({ ok: true, data: {} });
    win.close(); await flush();
    expect(win.hide).not.toHaveBeenCalled(); expect(h.nativeQuit).not.toHaveBeenCalled();
    h.stop(); await flush();
    expect(h.nativeQuit).not.toHaveBeenCalled(); // process exit alone does not prove output drained
    h.drain(); await flush();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.nativeQuit).toHaveBeenCalledOnce(); expect(win.destroyed).toBe(true);
    expect(h.pipe.close).toHaveBeenCalledOnce();
    const facts = JSON.parse([...h.writes.values()].find(text => text.includes('requestDelivered'))!);
    expect(facts).toMatchObject({ requestDelivered: true, exited: true, forceKilled: false, daemonStopResult: { complete: true, phase: 'closed' } });
  });

  it('native tray quit and internal app.quit share one physical daemon shutdown', async () => {
    vi.useFakeTimers(); const h = harness(); await flush();
    h.click('退出众说'); h.app.quit(); h.windows[0]!.close(); await flush();
    expect(h.send).toHaveBeenCalledOnce(); expect(h.nativeQuit).not.toHaveBeenCalled();
    h.stop(); h.drain(); await flush();
    expect(h.nativeQuit).toHaveBeenCalledOnce(); expect(h.trays[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('reuses an explicit IPC shutdown still awaiting its acknowledgement', async () => {
    vi.useFakeTimers(); const h = harness(); await flush();
    let acknowledge!: (reply: { ok: boolean; data: object }) => void;
    h.send.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const reply = h.invoke('zs:command', { method: 'daemon.shutdown', params: {} });
    await flush(); h.click('退出众说'); await flush();
    expect(h.send).toHaveBeenCalledOnce(); expect(h.nativeQuit).not.toHaveBeenCalled();
    acknowledge({ ok: true, data: {} }); await reply; h.stop(); h.drain(); await flush();
    expect(h.send).toHaveBeenCalledOnce(); expect(h.nativeQuit).toHaveBeenCalledOnce();
  });

  it('waits briefly for an initial daemon owner file before requesting graceful exit', async () => {
    vi.useFakeTimers(); const h = harness({ ownerMissing: true }); await flush();
    h.click('退出众说'); await flush(); expect(h.send).not.toHaveBeenCalled();
    h.publishOwner(); await vi.advanceTimersByTimeAsync(50); await flush();
    expect(h.send).toHaveBeenCalledOnce();
    h.stop(); h.drain(); await flush();
    expect(h.child.kill).not.toHaveBeenCalled(); expect(h.nativeQuit).toHaveBeenCalledOnce();
  });

  it('reconnects only to its owned daemon if the UI connection has already closed', async () => {
    vi.useFakeTimers(); const h = harness(); await flush();
    h.pipe.closed = true;
    h.connect.mockImplementationOnce(async () => { h.pipe.closed = false; return h.pipe; });
    h.click('退出众说'); await flush();
    expect(h.connect).toHaveBeenCalledTimes(2); expect(h.send).toHaveBeenCalledOnce();
    h.stop(); h.drain(); await flush(); expect(h.nativeQuit).toHaveBeenCalledOnce();
  });

  it('does not start a daemon when app.quit is requested before ready completes', async () => {
    const h = harness(); h.app.quit(); await flush();
    expect(h.spawn).not.toHaveBeenCalled(); expect(h.nativeQuit).toHaveBeenCalledOnce();
    expect(h.writes.size).toBe(0);
  });

  it('a second portable launch yields before opening a window or daemon', async () => {
    const h = harness({ singleInstance: false }); await flush();
    expect(h.app.requestSingleInstanceLock).toHaveBeenCalledOnce();
    expect(h.spawn).not.toHaveBeenCalled(); expect(h.windows).toHaveLength(0);
    expect(h.nativeQuit).toHaveBeenCalledOnce();
  });

  it('does not shut down a pipe whose physical owner differs from the spawned child', async () => {
    vi.useFakeTimers(); const h = harness({ ownerPid: 999 }); await flush();
    h.click('退出众说'); await flush();
    expect(h.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(h.child.kill).toHaveBeenCalledOnce(); expect(h.send).not.toHaveBeenCalled();
    expect(h.nativeQuit).toHaveBeenCalledOnce();
  });

  it('keeps the window and tray reachable if the owned daemon cannot finish or be killed', async () => {
    vi.useFakeTimers(); const h = harness(); await flush();
    h.child.kill.mockReturnValue(false);
    h.click('退出众说'); await flush();
    await vi.advanceTimersByTimeAsync(13_000); await flush();
    expect(h.nativeQuit).not.toHaveBeenCalled();
    expect(h.windows[0]!.visible).toBe(true); expect(h.windows[0]!.destroyed).toBe(false);
    expect(h.trays[0]!.destroy).not.toHaveBeenCalled();
    expect(h.dialog.showMessageBox).toHaveBeenCalledOnce();
    // A later physical close can complete a retry, without another shutdown IPC.
    h.stop(); h.drain(); h.click('退出众说'); await flush();
    expect(h.send).toHaveBeenCalledOnce(); expect(h.nativeQuit).toHaveBeenCalledOnce();
  });

  it('retains a taskbar window with a visible error on native tray creation failure', async () => {
    const h = harness({ trayFails: true }); await flush(); const win = h.windows[0]!;
    await h.invoke('zs:window', 'close');
    expect(win.hide).not.toHaveBeenCalled(); expect(win.minimized).toBe(true);
    expect(win.destroyed).toBe(false); expect(h.dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('tray menu carries the live workspace panel and fixed routes, not the old manual/data entries', async () => {
    const h = harness(); await flush(); const win = h.windows[0]!;
    const labels = h.menu().map(item => item.label).filter((label): label is string => typeof label === 'string');
    expect(labels).toContain('AI 工作台');
    expect(labels.some(label => label.startsWith('众说 9.9.9'))).toBe(true);
    expect(labels).not.toContain('操作手册');
    expect(labels).not.toContain('打开数据目录');
    h.click('设置');
    expect(win.webContents.executeJavaScript.mock.calls).toEqual([
      ["location.hash = '#/settings?section=general'; true"],
    ]);
    expect(() => h.invoke('zs:window', 'quit')).toThrow('未知窗口操作');
  });
});
