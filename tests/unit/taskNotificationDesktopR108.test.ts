import { readFileSync } from 'node:fs';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_NOTIFICATION_COMMANDS,
  TASK_NOTIFICATION_IPC,
  type TaskNotificationAttemptView,
  type TaskNotificationDelivery,
} from '../../src/contracts/taskNotifications.ts';
import {
  registerTaskNotificationIpc,
  type TaskNotificationIpcDependencies,
} from '../../src/ui/taskNotificationIpc.ts';

const notification: TaskNotificationDelivery = {
  notificationId: `ntf_${'a'.repeat(32)}`,
  kind: 'task.needs_review',
  title: '众说 · 交付待验收',
  body: '「实现通知链路」已有交付，等待你验收。',
  createdAt: 1_000,
  locator: {
    projectId: 'p1',
    conversationId: 'c1',
    roomId: 'r1',
    threadId: 'th1',
    taskId: 'task1',
    hash: '#task=task1',
  },
};

function attemptFor(stage: 'show_requested' | 'shown' | 'failed' | 'clicked' | 'closed'): TaskNotificationAttemptView {
  const shown = stage === 'shown' || stage === 'clicked';
  return {
    notificationId: notification.notificationId,
    title: notification.title,
    state: stage === 'show_requested' ? 'show_requested' : stage === 'failed' ? 'failed' : shown ? 'shown' : 'show_requested',
    claimRequestedAt: 1_000,
    showRequestedAt: stage === 'show_requested' || shown ? 1_100 : null,
    shownAt: shown ? 1_200 : null,
    failedAt: stage === 'failed' ? 1_200 : null,
    failureReason: stage === 'failed' ? 'native failure' : null,
    clickedAt: stage === 'clicked' ? 1_300 : null,
    closedAt: stage === 'closed' ? 1_300 : null,
  };
}

function ackData(stage: 'show_requested' | 'shown' | 'failed' | 'clicked' | 'closed') {
  const attempt = attemptFor(stage);
  return { notificationId: notification.notificationId, state: attempt.state, attempt };
}

function registeredHandler() {
  let handler: ((event: IpcMainInvokeEvent, payload: unknown) => unknown) | null = null;
  const removeHandler = vi.fn();
  const ipcMain = {
    handle: (_channel: string, next: (event: IpcMainInvokeEvent, payload: unknown) => unknown) => {
      handler = next;
    },
    removeHandler,
  };
  return {
    ipcMain,
    removeHandler,
    invoke: (event: IpcMainInvokeEvent, payload: unknown) => handler!(event, payload),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('electron');
  vi.resetModules();
});

describe('R108 desktop task-notification main bridge', () => {
  it('records show intent, waits for native show/failed events, and routes a trusted click', async () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    const native = {
      on: vi.fn((event: 'show' | 'failed' | 'click' | 'close', callback: (...args: unknown[]) => void) => {
        callbacks.set(event, callback);
      }),
      show: vi.fn(),
    };
    const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === TASK_NOTIFICATION_COMMANDS.claim) {
        return { ok: true, data: { claimed: true, notification } };
      }
      return { ok: true, data: ackData(params['stage'] as 'show_requested' | 'shown' | 'clicked') };
    });
    const webContents = { send: vi.fn() };
    const win = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents,
    };
    const assertTrustedSender = vi.fn();
    const registration = registeredHandler();
    const deps: TaskNotificationIpcDependencies = {
      ipcMain: registration.ipcMain,
      assertTrustedSender,
      sendCommand: send,
      getWindow: () => win,
      createNotification: vi.fn(() => native),
    };
    const dispose = registerTaskNotificationIpc(deps);
    const event = { senderFrame: { url: 'zsres://app/index.html' } } as IpcMainInvokeEvent;

    await expect(registration.invoke(event, notification.notificationId)).resolves.toEqual({
      ok: true,
      notificationId: notification.notificationId,
      state: 'requested',
    });
    expect(assertTrustedSender).toHaveBeenCalledWith(event);
    expect(deps.createNotification).toHaveBeenCalledWith({ title: notification.title, body: notification.body });
    expect(native.show).toHaveBeenCalledOnce();
    expect(send.mock.invocationCallOrder[1]!).toBeLessThan(native.show.mock.invocationCallOrder[0]!);
    expect(send).toHaveBeenNthCalledWith(1, TASK_NOTIFICATION_COMMANDS.claim, {
      notificationId: notification.notificationId,
    });
    expect(send).toHaveBeenNthCalledWith(2, TASK_NOTIFICATION_COMMANDS.ack, {
      notificationId: notification.notificationId,
      stage: 'show_requested',
    });

    expect(send).toHaveBeenCalledTimes(2); // native.show() is void and is not a delivery fact.
    callbacks.get('show')!();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(TASK_NOTIFICATION_COMMANDS.ack, {
        notificationId: notification.notificationId,
        stage: 'shown',
      });
    });

    callbacks.get('click')!();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(TASK_NOTIFICATION_COMMANDS.ack, {
        notificationId: notification.notificationId,
        stage: 'clicked',
      });
    });
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(webContents.send).toHaveBeenCalledWith(TASK_NOTIFICATION_IPC.click, {
      notificationId: notification.notificationId,
      kind: notification.kind,
      locator: notification.locator,
    });

    dispose();
    expect(registration.removeHandler).toHaveBeenCalledWith(TASK_NOTIFICATION_IPC.show);
  });

  it('records native failed events separately from requested and shown', async () => {
    const callbacks = new Map<string, (...args: unknown[]) => void>();
    const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === TASK_NOTIFICATION_COMMANDS.claim) {
        return { ok: true, data: { claimed: true, notification } };
      }
      return { ok: true, data: ackData(params['stage'] as 'show_requested' | 'failed') };
    });
    const registration = registeredHandler();
    registerTaskNotificationIpc({
      ipcMain: registration.ipcMain,
      assertTrustedSender: () => {},
      sendCommand: send,
      getWindow: () => null,
      createNotification: () => ({
        on: (event, callback) => { callbacks.set(event, callback); },
        show: () => {},
      }),
    });
    await registration.invoke({} as IpcMainInvokeEvent, notification.notificationId);
    callbacks.get('failed')!({}, new Error('native failure'));
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(TASK_NOTIFICATION_COMMANDS.ack, {
        notificationId: notification.notificationId,
        stage: 'failed',
        error: 'native failure',
      });
    });
  });

  it('rejects malformed renderer IDs before any daemon claim', async () => {
    const registration = registeredHandler();
    const send = vi.fn();
    registerTaskNotificationIpc({
      ipcMain: registration.ipcMain,
      assertTrustedSender: () => {},
      sendCommand: send,
      getWindow: () => null,
      createNotification: () => ({ on: () => {}, show: () => {} }),
    });
    await expect(registration.invoke(
      { senderFrame: { url: 'zsres://app/' } } as IpcMainInvokeEvent,
      '../../arbitrary-notification-payload',
    )).rejects.toThrow('通知 ID 无效');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('R108 preload and main wiring', () => {
  it('exposes only show(notificationId) and an onClick subscription', async () => {
    const exposeInMainWorld = vi.fn();
    const invoke = vi.fn(async () => ({ ok: true, notificationId: notification.notificationId }));
    const on = vi.fn();
    const removeListener = vi.fn();
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld },
      ipcRenderer: { invoke, on, removeListener },
    }));
    vi.resetModules();
    await import('../../src/ui/preload.ts');

    const exposed = exposeInMainWorld.mock.calls.find(([name]) => name === 'zsTaskNotifications')?.[1] as {
      show: (notificationId: string) => Promise<unknown>;
      onClick: (callback: (event: unknown) => void) => () => void;
    };
    expect(exposed).toBeDefined();
    await exposed.show(notification.notificationId);
    expect(invoke).toHaveBeenCalledWith(TASK_NOTIFICATION_IPC.show, notification.notificationId);

    const callback = vi.fn();
    const off = exposed.onClick(callback);
    expect(on).toHaveBeenCalledWith(TASK_NOTIFICATION_IPC.click, expect.any(Function));
    const listener = on.mock.calls[0]![1] as (_event: unknown, payload: unknown) => void;
    listener({}, { notificationId: notification.notificationId, locator: notification.locator });
    expect(callback).toHaveBeenCalledWith({ notificationId: notification.notificationId, locator: notification.locator });
    off();
    expect(removeListener).toHaveBeenCalledWith(TASK_NOTIFICATION_IPC.click, listener);
  });

  it('uses the tested registration and native Electron Notification in main', () => {
    const source = readFileSync(new URL('../../src/ui/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('registerTaskNotificationIpc({');
    expect(source).toContain('new ElectronNotification({ title, body })');
    expect(source).toContain("app.setAppUserModelId(process.env.ZS_APP_USER_MODEL_ID ?? 'com.zhongshuo.desktop')");
  });
});
