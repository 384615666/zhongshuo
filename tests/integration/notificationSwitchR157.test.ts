/**
 * R157 桌面通知总开关（app.settings ui.taskNotifications.enabled）后端回归。
 *
 * 口径：
 * - 未设置 = 开启（保持通知一直以来的默认行为）。
 * - 关闭期间产生的通知不得留成 pending：poll 当场把它标成 suppressed，
 *   避免重新开启后补发关闭期间的旧通知。
 * - 抑制不影响健康统计：health/recentAttempts 照常从真实投递账目读取。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type ZhongshuoDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';
import {
  ackTaskNotification,
  claimTaskNotification,
  pollTaskNotifications,
} from '../../src/daemon/taskNotifications.ts';
import {
  TASK_NOTIFICATIONS_ENABLED_SETTING_KEY,
  parseTaskNotificationsEnabledSetting,
  serializeTaskNotificationsEnabledSetting,
} from '../../src/contracts/taskNotifications.ts';

const VIEWER = 'u_local';
const scratch: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of scratch.splice(0).reverse()) {
    try { cleanup(); } catch { /* Windows 句柄延迟 */ }
  }
});

function seedRoom(db: ZhongshuoDatabase): void {
  db.prepare(
    `INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at)
     VALUES ('p1', '项目', 'D:\\p', 'D:\\p', '{}', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO project_members (id, project_id, display_name, principal_type, enabled)
     VALUES (?, 'p1', '我', 'human', 1), ('a1', 'p1', 'AI', 'agent', 1)`,
  ).run(VIEWER);
  db.prepare(
    `INSERT INTO rooms (id, project_id, name, coordinator_member_id)
     VALUES ('r1', 'p1', '房间', 'a1')`,
  ).run();
  db.prepare(`INSERT INTO room_members (room_id, member_id) VALUES ('r1', ?), ('r1', 'a1')`).run(VIEWER);
  db.prepare(
    `INSERT INTO conversations (id, project_id, kind, room_id, title)
     VALUES ('c1', 'p1', 'room', 'r1', '房间会话')`,
  ).run();
  db.prepare(
    `INSERT INTO messages
       (id, project_id, conversation_id, conversation_seq, room_id, author_type, author_id, body_json, status, created_at)
     VALUES ('m_root', 'p1', 'c1', 1, 'r1', 'human', ?, '{"text":"任务"}', 'final', 0)`,
  ).run(VIEWER);
  db.prepare(
    `INSERT INTO conversation_threads (id, project_id, conversation_id, room_id, anchor_message_id, root_task_id)
     VALUES ('th1', 'p1', 'c1', 'r1', 'm_root', 'task1')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, project_id, conversation_id, kind, room_id, conversation_thread_id, root_message_id,
        room_task_number, owner_member_id, title, status, revision, review_policy)
     VALUES ('task1', 'p1', 'c1', 'room_task', 'r1', 'th1', 'm_root', 1, 'a1',
             '实现通知开关', 'ACTIVE', 0, 'user_review')`,
  ).run();
  db.prepare(
    `INSERT INTO thread_subscriptions (thread_id, viewer_id, followed, muted)
     VALUES ('th1', ?, 1, 0)`,
  ).run(VIEWER);
}

function setTaskStatus(db: ZhongshuoDatabase, taskId: string, status: string, revision: number): void {
  db.prepare('UPDATE tasks SET status = ?, revision = ? WHERE id = ?').run(status, revision, taskId);
}

function appendStatus(
  db: ZhongshuoDatabase,
  input: { eventId: string; taskId: string; status: string; createdAt?: number },
): void {
  db.prepare(
    `INSERT INTO domain_events
       (event_id, schema_version, project_id, conversation_id, thread_id, task_id, kind, payload_json, created_at)
     VALUES (?, 1, 'p1', 'c1', 'th1', ?, 'task.statusChanged', ?, ?)`,
  ).run(
    input.eventId,
    input.taskId,
    JSON.stringify({ status: input.status }),
    input.createdAt ?? 100,
  );
}

type CommandReply = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

async function fixture(): Promise<{
  db: ZhongshuoDatabase;
  reply: (method: string, params: unknown) => Promise<CommandReply>;
  cmd: <T>(method: string, params: unknown) => Promise<T>;
  setEnabled: (value: string) => Promise<void>;
  readEnabled: () => Promise<string | null>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'zs-r157-notify-switch-'));
  const db = openDatabase(':memory:');
  scratch.push(() => db.close(), () => rmSync(dir, { recursive: true, force: true }));
  seedRoom(db);
  const deps: DaemonCommandDeps = {
    db,
    localUserId: VIEWER,
    interruptTurn: async () => {},
    appDataDir: dir,
  };
  const reply = async (method: string, params: unknown): Promise<CommandReply> =>
    await dispatchDaemonCommand(deps, {
      protocolVersion: 1,
      commandId: randomUUID(),
      method,
      params,
    }) as CommandReply;
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const result = await reply(method, params);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.data as T;
  };
  const setEnabled = async (value: string): Promise<void> => {
    await cmd('app.settings.set', { key: TASK_NOTIFICATIONS_ENABLED_SETTING_KEY, value });
  };
  const readEnabled = async (): Promise<string | null> => {
    const result = await cmd<{ values: Record<string, string | null> }>('app.settings.get', {
      keys: [TASK_NOTIFICATIONS_ENABLED_SETTING_KEY],
    });
    return result.values[TASK_NOTIFICATIONS_ENABLED_SETTING_KEY] ?? null;
  };
  return { db, reply, cmd, setEnabled, readEnabled };
}

describe('R157 桌面通知总开关', () => {
  it('未设置总开关时通知照常 pending 并可 claim（未设置=开启）', async () => {
    const f = await fixture();
    expect(await f.readEnabled()).toBe(null);

    expect(pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 1_000).items).toEqual([]);
    setTaskStatus(f.db, 'task1', 'DONE', 1);
    appendStatus(f.db, { eventId: 'r157-default-done', taskId: 'task1', status: 'DONE', createdAt: 2_000 });

    const pending = pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 2_000);
    expect(pending.items).toHaveLength(1);
    expect(f.db.prepare(
      'SELECT delivery_state FROM task_notifications WHERE notification_id = ?',
    ).get(pending.items[0]!.notificationId)).toEqual({ delivery_state: 'pending' });
    expect(claimTaskNotification(f.db, VIEWER, pending.items[0], 2_100).claimed).toBe(true);
  });

  it('关闭后 poll 返回空 items：新通知当场 suppressed 且不留 pending，健康统计照常真实', async () => {
    const f = await fixture();
    pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 1_000);

    // 关闭前先完成一条真实投递，作为“健康统计不被抑制清零”的对照。
    setTaskStatus(f.db, 'task1', 'DONE', 1);
    appendStatus(f.db, { eventId: 'r157-health-done', taskId: 'task1', status: 'DONE', createdAt: 2_000 });
    const first = pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 2_000);
    expect(first.items).toHaveLength(1);
    const claimed = claimTaskNotification(f.db, VIEWER, first.items[0], 2_050);
    if (!claimed.claimed) throw new Error('通知领取失败');
    ackTaskNotification(f.db, VIEWER, { notificationId: claimed.notification.notificationId, stage: 'shown' }, 2_060);

    await f.setEnabled('false');
    expect(await f.readEnabled()).toBe('false');
    setTaskStatus(f.db, 'task1', 'REVIEW', 2);
    appendStatus(f.db, { eventId: 'r157-closed-review', taskId: 'task1', status: 'REVIEW', createdAt: 3_000 });

    const closed = pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 3_000);
    expect(closed.items).toEqual([]);
    expect(closed.hasMore).toBe(false);
    // 健康统计与最近投递照常真实读取，不被抑制清零。
    expect(closed.health).toMatchObject({ attempted: 1, shown: 1, failed: 0, clicked: 0 });
    expect(closed.recentAttempts).toHaveLength(1);
    expect(closed.recentAttempts[0]).toMatchObject({ state: 'shown' });
    // 事件游标照常推进：重新开启后 ingest 也不会把关闭期间的事件再翻出来。
    const closedSeq = (f.db.prepare(
      "SELECT seq FROM domain_events WHERE event_id = 'r157-closed-review'",
    ).get() as { seq: number }).seq;
    expect(closed.scannedThroughSeq).toBe(closedSeq);
    expect(f.db.prepare(
      "SELECT COUNT(*) AS n FROM task_notifications WHERE viewer_id = ? AND delivery_state = 'pending'",
    ).get(VIEWER)).toEqual({ n: 0 });
    expect(f.db.prepare(
      "SELECT delivery_state, last_error FROM task_notifications WHERE viewer_id = ? AND source_event_id = 'r157-closed-review'",
    ).get(VIEWER)).toEqual({ delivery_state: 'suppressed', last_error: '桌面通知已关闭' });

    // 命令面同样返回空 items（renderer 走的就是这条路径）。
    const viaCommand = await f.cmd<{ items: unknown[] }>('taskNotification.poll', { limit: 10 });
    expect(viaCommand.items).toEqual([]);
  });

  it('重新开启后新事件恢复 pending，关闭期间的旧通知保持 suppressed 不补发', async () => {
    const f = await fixture();
    pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 1_000);

    await f.setEnabled('false');
    setTaskStatus(f.db, 'task1', 'DONE', 1);
    appendStatus(f.db, { eventId: 'r157-closed-done', taskId: 'task1', status: 'DONE', createdAt: 2_000 });
    expect(pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 2_000).items).toEqual([]);
    const suppressed = f.db.prepare(
      "SELECT notification_id FROM task_notifications WHERE source_event_id = 'r157-closed-done'",
    ).get() as { notification_id: string };

    await f.setEnabled('true');
    expect(await f.readEnabled()).toBe('true');
    setTaskStatus(f.db, 'task1', 'REVIEW', 2);
    appendStatus(f.db, { eventId: 'r157-reenabled-review', taskId: 'task1', status: 'REVIEW', createdAt: 3_000 });

    const reopened = pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 3_000);
    expect(reopened.items).toHaveLength(1);
    expect(reopened.items[0]!.notificationId).not.toBe(suppressed.notification_id);
    expect(f.db.prepare(
      'SELECT delivery_state, last_error FROM task_notifications WHERE notification_id = ?',
    ).get(suppressed.notification_id)).toEqual({ delivery_state: 'suppressed', last_error: '桌面通知已关闭' });
    expect(f.db.prepare(
      'SELECT delivery_state FROM task_notifications WHERE notification_id = ?',
    ).get(reopened.items[0]!.notificationId)).toEqual({ delivery_state: 'pending' });
    expect(f.db.prepare(
      "SELECT COUNT(*) AS n FROM task_notifications WHERE viewer_id = ? AND delivery_state = 'pending'",
    ).get(VIEWER)).toEqual({ n: 1 });
  });

  it('关闭状态跨多次 poll 不重复生成通知，也不留下 pending', async () => {
    const f = await fixture();
    pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 1_000);
    await f.setEnabled('false');
    setTaskStatus(f.db, 'task1', 'DONE', 1);
    appendStatus(f.db, { eventId: 'r157-idempotent-done', taskId: 'task1', status: 'DONE', createdAt: 2_000 });

    expect(pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 2_000).items).toEqual([]);
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM task_notifications').get();
    expect(pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 2_500).items).toEqual([]);
    expect(pollTaskNotifications(f.db, VIEWER, { limit: 10 }, 3_000).items).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM task_notifications').get()).toEqual(before);
    expect(f.db.prepare(
      "SELECT COUNT(*) AS n FROM task_notifications WHERE delivery_state = 'pending'",
    ).get()).toEqual({ n: 0 });
  });

  it('app.settings：关闭值可读回，非法值按 VALIDATION_INVALID 拒绝且不覆盖已存值', async () => {
    const f = await fixture();
    expect(await f.readEnabled()).toBe(null);
    await f.setEnabled('false');
    expect(await f.readEnabled()).toBe('false');

    const rejected = await f.reply('app.settings.set', {
      key: TASK_NOTIFICATIONS_ENABLED_SETTING_KEY,
      value: 'yes',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatchObject({ code: 'VALIDATION_INVALID' });
    expect(rejected.error?.message).toContain('不接受');
    expect(await f.readEnabled()).toBe('false');

    // 白名单没有放宽：未知键仍被拒绝。
    expect((await f.reply('app.settings.get', { keys: ['not.a.key'] })).ok).toBe(false);
  });

  it('契约：缺省/空值=开启，true/false 互转，非法值显式报错', () => {
    expect(TASK_NOTIFICATIONS_ENABLED_SETTING_KEY).toBe('ui.taskNotifications.enabled');
    expect(parseTaskNotificationsEnabledSetting(null)).toBe(true);
    expect(parseTaskNotificationsEnabledSetting(undefined)).toBe(true);
    expect(parseTaskNotificationsEnabledSetting('')).toBe(true);
    expect(parseTaskNotificationsEnabledSetting('true')).toBe(true);
    expect(parseTaskNotificationsEnabledSetting('false')).toBe(false);
    expect(() => parseTaskNotificationsEnabledSetting('yes')).toThrow(/只接受 true\/false/);
    expect(serializeTaskNotificationsEnabledSetting(true)).toBe('true');
    expect(serializeTaskNotificationsEnabledSetting(false)).toBe('false');
  });
});
