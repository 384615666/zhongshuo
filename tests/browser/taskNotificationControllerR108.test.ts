import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  TASK_NOTIFICATION_COMMANDS,
  TASK_NOTIFICATIONS_ENABLED_SETTING_KEY,
  type TaskNotificationClick,
} from '../../src/contracts/taskNotifications.ts';
import {
  openTaskNotificationClick,
  showNextTaskNotification,
  TaskNotificationController,
} from '../../src/ui/hifi/components/TaskNotificationController.tsx';
import {
  DesktopNotificationsRow,
  desktopNotificationsReadBackMatches,
  desktopNotificationsWrite,
  SectionNotifications,
  SettingsPage,
} from '../../src/ui/hifi/pages/SettingsPage.tsx';

const notificationId = `ntf_${'b'.repeat(32)}`;
const click: TaskNotificationClick = {
  notificationId,
  locator: {
    projectId: 'p1',
    conversationId: 'c1',
    roomId: 'r1',
    threadId: 'th1',
    taskId: 'task1',
    hash: '#task=task1',
  },
};

describe('R108 native task notification renderer controller', () => {
  it('polls one opaque ID and delegates native display to the preload/main bridge', async () => {
    const pollCommand = vi.fn(async (method: string, params: Record<string, unknown>) => {
      expect(method).toBe(TASK_NOTIFICATION_COMMANDS.poll);
      expect(params).toEqual({ limit: 1 });
      return {
        items: [{ notificationId }],
        scannedThroughSeq: 9,
        hasMore: false,
        health: { attempted: 0, showRequested: 0, shown: 0, unknown: 0, failed: 0, clicked: 0 },
        recentAttempts: [],
      };
    });
    const show = vi.fn(async () => ({ ok: true, notificationId, state: 'requested' }));
    await expect(showNextTaskNotification({ show }, pollCommand)).resolves.toBe('requested');
    expect(show).toHaveBeenCalledWith(notificationId);
  });

  it('rejects malformed poll/show payloads without treating them as delivered', async () => {
    const show = vi.fn();
    await expect(showNextTaskNotification(
      { show },
      async () => ({
        items: [{ notificationId: 'arbitrary-payload' }],
        scannedThroughSeq: 1,
        hasMore: false,
        health: { attempted: 0, showRequested: 0, shown: 0, unknown: 0, failed: 0, clicked: 0 },
        recentAttempts: [],
      }),
    )).rejects.toThrow();
    expect(show).not.toHaveBeenCalled();

    await expect(showNextTaskNotification(
      { show: async () => ({ ok: true, notificationId: 'arbitrary-payload' }) },
      async () => ({
        items: [{ notificationId }],
        scannedThroughSeq: 1,
        hasMore: false,
        health: { attempted: 0, showRequested: 0, shown: 0, unknown: 0, failed: 0, clicked: 0 },
        recentAttempts: [],
      }),
    )).resolves.toBe('rejected');
  });

  it('routes only a daemon-validated locator and ignores arbitrary click payloads', async () => {
    const open = vi.fn(async () => {});
    await expect(openTaskNotificationClick(click, open)).resolves.toEqual(click);
    expect(open).toHaveBeenCalledWith('#task=task1','replies');

    const unsafeOpen = vi.fn(async () => {});
    await expect(openTaskNotificationClick({
      notificationId,
      locator: { ...click.locator, hash: 'https://example.com/arbitrary' },
    }, unsafeOpen)).resolves.toBeNull();
    expect(unsafeOpen).not.toHaveBeenCalled();
  });

  it('mounts as a side-effect-only controller', () => {
    expect(renderToStaticMarkup(createElement(TaskNotificationController))).toBe('');
  });

  it.each([
    ['task.completed','replies'],['task.needs_input','replies'],
    ['task.needs_review','delivery'],['task.needs_attention','run'],
  ] as const)('opens %s at its existing task view',async(kind,tab)=>{
    const open=vi.fn(async()=>{});
    await openTaskNotificationClick({...click,kind},open);
    expect(open).toHaveBeenCalledWith('#task=task1',tab);
  });
});

describe('R108 settings use the real desktop notification switch', () => {
  it('renders only the desktop notification master switch (R170: 对话串通知 block deleted)', () => {
    const section = renderToStaticMarkup(createElement(SectionNotifications));
    expect(section).toContain('data-zs-notification-master="1"');
    expect(section).not.toContain('thread_subscriptions');
    // R170：按对话串静音与投递记录整块已删。
    expect(section).not.toContain('对话串通知');
    expect(section).not.toContain('data-zs-notification-settings');
    expect(section).not.toContain('投递记录');
    // R157：开发过程中的操作提示不再出现在用户界面里。
    expect(section).not.toContain('还没有设置过对话串通知');
    expect(section).not.toContain('可在对话串右上角菜单中设置静音');

    // R157：设置改成单页——同一页里既有通知段也有帮助段，没有左侧分区菜单。
    const settings = renderToStaticMarkup(createElement(SettingsPage, {
      query: { section: 'notifications' },
    }));
    expect(settings).toContain('data-settings-section="notifications"');
    expect(settings).toContain('data-settings-section="help"');
    expect(settings).not.toContain('settings-nav');
    expect(settings).not.toContain('aria-current="page"');
  });

  it('writes the desktop notification master switch through app.settings and requires exact read-back', () => {
    expect(desktopNotificationsWrite(false)).toEqual({
      key: TASK_NOTIFICATIONS_ENABLED_SETTING_KEY,
      value: 'false',
    });
    expect(desktopNotificationsWrite(true)).toEqual({
      key: TASK_NOTIFICATIONS_ENABLED_SETTING_KEY,
      value: 'true',
    });
    // 未设置(null)等于开启：不能把「没设置过」读成关闭。
    expect(desktopNotificationsReadBackMatches(null, true)).toBe(true);
    expect(desktopNotificationsReadBackMatches(null, false)).toBe(false);
    expect(desktopNotificationsReadBackMatches('false', false)).toBe(true);
    expect(desktopNotificationsReadBackMatches('true', false)).toBe(false);

    const row = renderToStaticMarkup(createElement(DesktopNotificationsRow));
    expect(row).toContain('data-zs-notification-master="1"');
    expect(row).toContain('data-zs-notification-enabled="true"');
    expect(row).toContain('role="switch"');
  });
});
