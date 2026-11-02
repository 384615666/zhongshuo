import { useEffect, useRef } from 'react';
import {
  TASK_NOTIFICATION_COMMANDS,
  taskNotificationClickSchema,
  taskNotificationPollResultSchema,
  taskNotificationShowResultSchema,
  type TaskNotificationClick,
} from '../../../contracts/taskNotifications.ts';
import { command } from '../bridge';
import { toast, useStore } from '../shell';

interface TaskNotificationRendererBridge {
  show: (notificationId: string) => Promise<unknown>;
  onClick: (callback: (event: unknown) => void) => () => void;
}

function rendererBridge(): TaskNotificationRendererBridge | null {
  return (window as unknown as { zsTaskNotifications?: TaskNotificationRendererBridge }).zsTaskNotifications ?? null;
}

/**
 * Polls the daemon's durable notification inbox one item at a time. Native
 * titles/bodies/locators never enter this path: the renderer receives opaque
 * IDs, while main claims and validates the daemon-owned payload.
 */
export async function showNextTaskNotification(
  bridge: Pick<TaskNotificationRendererBridge, 'show'> | null = rendererBridge(),
  pollCommand: (method: string, params: Record<string, unknown>) => Promise<unknown> = command,
): Promise<'requested' | 'empty' | 'rejected'> {
  if (bridge == null) return 'rejected';
  const raw = await pollCommand(TASK_NOTIFICATION_COMMANDS.poll, { limit: 1 });
  const polled = taskNotificationPollResultSchema.parse(raw);
  const first = polled.items[0];
  if (first == null) return 'empty';
  const shown = taskNotificationShowResultSchema.safeParse(await bridge.show(first.notificationId));
  return shown.success && shown.data.ok ? 'requested' : 'rejected';
}

export async function openTaskNotificationClick(
  input: unknown,
  openDeepLink: (hash: string, threadTab:'replies'|'delivery'|'run') => Promise<void> = async (hash,threadTab) => {
    const { openExternalDeepLink } = await import('../loader');
    await openExternalDeepLink(hash,threadTab);
  },
): Promise<TaskNotificationClick | null> {
  const parsed = taskNotificationClickSchema.safeParse(input);
  if (!parsed.success) return null;
  await openDeepLink(parsed.data.locator.hash,
    parsed.data.kind==='task.needs_review'?'delivery':parsed.data.kind==='task.needs_attention'?'run':'replies');
  return parsed.data;
}

/**
 * Top-level side-effect component. The parent mounts it once; it renders no
 * product UI and never polls models. One item per interval also bounds a burst
 * after a long offline period while the persistent daemon inbox prevents
 * replay duplicates.
 */
export function TaskNotificationController({ intervalMs = 4_000 }: { intervalMs?: number }) {
  const enabled = useStore((s) => s.notificationsEnabled);
  // 用 ref 读开关：切换开关不重建定时器，也不打断正在进行的轮询。
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    let stopped = false;
    let inFlight = false;
    const bridge = rendererBridge();
    if (bridge == null) return;

    const tick = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        if (enabledRef.current) {
          await showNextTaskNotification(bridge);
        } else {
          // 关闭时仍然轮询：daemon 借这次轮询推进事件游标并把关闭期间的通知标记为
          // 已抑制（不会留成 pending），重新开启后不会补发旧通知。这里绝不调用 show。
          await command(TASK_NOTIFICATION_COMMANDS.poll, { limit: 1 });
        }
      } catch {
        // Connection/command failures are already visible through the existing
        // connection state; retry on the next quiet interval.
      } finally {
        inFlight = false;
      }
    };

    const unsubscribe = bridge.onClick((event) => {
      void openTaskNotificationClick(event).catch((error: unknown) => {
        toast(`通知定位失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    });
    void tick();
    const timer = window.setInterval(() => void tick(), Math.max(1_000, intervalMs));
    return () => {
      stopped = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [intervalMs]);

  return null;
}
