import type { IpcMainInvokeEvent } from 'electron';
import {
  TASK_NOTIFICATION_COMMANDS,
  TASK_NOTIFICATION_IPC,
  taskNotificationAckResultSchema,
  taskNotificationClaimResultSchema,
  taskNotificationIdSchema,
  taskNotificationShowResultSchema,
  type TaskNotificationShowResult,
} from '../contracts/taskNotifications.ts';

interface NativeNotification {
  on(event: 'show' | 'failed' | 'click' | 'close', listener: (...args: unknown[]) => void): void;
  show(): void;
}

interface NotificationWindow {
  isDestroyed(): boolean;
  isMinimized?(): boolean;
  restore?(): void;
  show?(): void;
  focus?(): void;
  webContents: { send(channel: string, payload: unknown): void };
}

interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
}

interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: { message?: string };
}

export interface TaskNotificationIpcDependencies {
  ipcMain: IpcMainLike;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  sendCommand: (method: string, params: Record<string, unknown>) => Promise<CommandResult>;
  getWindow: () => NotificationWindow | null;
  createNotification: (options: { title: string; body: string }) => NativeNotification;
}

/**
 * Registers the main-process side of the desktop notification bridge. The
 * renderer can submit only a notification ID. Main claims the daemon-owned
 * record, validates its complete delivery DTO and locator, then shows a real
 * Electron Notification. Click events therefore contain only trusted data.
 */
export function registerTaskNotificationIpc(deps: TaskNotificationIpcDependencies): () => void {
  const retained = new Set<NativeNotification>();
  const ack = async (
    notificationId: string,
    stage: 'show_requested' | 'shown' | 'failed' | 'clicked' | 'closed',
    error?: string,
  ) => {
    const result = await deps.sendCommand(TASK_NOTIFICATION_COMMANDS.ack, {
      notificationId,
      stage,
      ...(error != null ? { error: error.slice(0, 500) } : {}),
    });
    if (!result.ok) throw new Error(result.error?.message ?? `任务通知 ${stage} 回执失败`);
    return taskNotificationAckResultSchema.parse(result.data);
  };

  deps.ipcMain.handle(TASK_NOTIFICATION_IPC.show, async (event, payload): Promise<TaskNotificationShowResult> => {
    deps.assertTrustedSender(event);
    const notificationId = taskNotificationIdSchema.safeParse(payload);
    if (!notificationId.success) throw new Error('桌面任务通知 ID 无效');

    let claimedId: string | null = null;
    try {
      const claimedResult = await deps.sendCommand(TASK_NOTIFICATION_COMMANDS.claim, {
        notificationId: notificationId.data,
      });
      if (!claimedResult.ok) {
        throw new Error(claimedResult.error?.message ?? '任务通知领取失败');
      }
      const claimed = taskNotificationClaimResultSchema.parse(claimedResult.data);
      if (!claimed.claimed) return { ok: false, reason: claimed.reason };

      const delivery = claimed.notification;
      claimedId = delivery.notificationId;
      // Persist the native-show intent before the void-returning show() call.
      // A claim alone is not an attempted desktop notification.
      const requested = await ack(delivery.notificationId, 'show_requested');
      if (requested.state === 'suppressed') return { ok: false, reason: 'muted' };

      const native = deps.createNotification({ title: delivery.title, body: delivery.body });
      retained.add(native);
      native.on('show', () => {
        void ack(delivery.notificationId, 'shown').catch(() => {});
      });
      native.on('failed', (_event, error) => {
        retained.delete(native);
        void ack(delivery.notificationId, 'failed', error instanceof Error ? error.message : String(error)).catch(() => {});
      });
      native.on('close', () => {
        retained.delete(native);
        void ack(delivery.notificationId, 'closed').catch(() => {});
      });
      native.on('click', () => {
        retained.delete(native);
        void ack(delivery.notificationId, 'clicked').catch(() => {});
        const win = deps.getWindow();
        if (win == null || win.isDestroyed()) return;
        if (win.isMinimized?.()) win.restore?.();
        win.show?.();
        win.focus?.();
        win.webContents.send(TASK_NOTIFICATION_IPC.click, {
          notificationId: delivery.notificationId,
          kind: delivery.kind,
          locator: delivery.locator,
        });
      });
      native.show();
      return taskNotificationShowResultSchema.parse({
        ok: true,
        notificationId: delivery.notificationId,
        state: 'requested',
      });
    } catch (error) {
      if (claimedId != null) {
        await ack(
          claimedId,
          'failed',
          error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        ).catch(() => null);
      }
      throw error;
    }
  });

  return () => deps.ipcMain.removeHandler(TASK_NOTIFICATION_IPC.show);
}
