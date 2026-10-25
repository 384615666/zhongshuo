import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  TASK_NOTIFICATION_COMMANDS,
  type TaskNotificationClick,
} from '../../src/contracts/taskNotifications.ts';
import {
  openTaskNotificationClick,
  showNextTaskNotification,
  TaskNotificationController,
} from '../../src/ui/hifi/components/TaskNotificationController.tsx';
import {
  notificationMuteReadBackMatches,
  notificationMuteWrite,
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

describe('R108 settings use real thread subscriptions', () => {
  it('writes mute through thread.subscribe and requires exact read-back', () => {
    expect(notificationMuteWrite('th1', true)).toEqual({
      method: 'thread.subscribe',
      params: { threadId: 'th1', mute: true },
    });
    const items = [{ threadId: 'th1', followed: true, muted: true, projectId: 'p1', taskId: 'task1' }];
    expect(notificationMuteReadBackMatches(items, 'th1', true)).toBe(true);
    expect(notificationMuteReadBackMatches(items, 'th1', false)).toBe(false);
    expect(notificationMuteReadBackMatches(items, 'missing', false)).toBe(false);
  });

  it('renders a discoverable real notification settings section instead of prototype preferences', () => {
    const section = renderToStaticMarkup(createElement(SectionNotifications));
    expect(section).toContain('按对话串管理桌面通知与静音');
    expect(section).not.toContain('thread_subscriptions');
    expect(section).toContain('正在读取真实线程静音状态');
    expect(section).toContain('data-zs-notification-settings="1"');
    expect(section).toContain('正在读取桌面投递记录');

    const settings = renderToStaticMarkup(createElement(SettingsPage, {
      query: { section: 'notifications' },
    }));
    expect(settings).toContain('通知');
    expect(settings).toContain('aria-current="page"');
  });
});
