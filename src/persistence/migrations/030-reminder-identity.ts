/**
 * 030（第二十六轮一）：提醒派发与预算的**准确归属**。
 * - reminder_calls 增 dispatch_key：创建该调用格的完整派发键（恢复/对账锚——一个 task 可
 *   被多个提醒绑定，不能按 task 唯一推断来源）。
 * - 跟进派发键升级为完整身份键 `task:{taskId}:reminder:{reminderId}:{scheduledAt}`
 *   （原 `task:{id}:reminder:{scheduledAt}` 缺 reminderId——两个提醒绑定同任务、同刻触发
 *   会撞 outbox 唯一键）。
 */
import type { Migration } from '../db.ts';

export const reminderIdentityMigration: Migration = {
  id: 30,
  name: 'reminder-calls-dispatch-key-identity',
  up: (db) => {
    db.exec(`
      ALTER TABLE reminder_calls ADD COLUMN dispatch_key TEXT;
      CREATE INDEX reminder_calls_by_dispatch ON reminder_calls(dispatch_key);
    `);
  },
};
