/**
 * 027（第二十四轮二）：DEV-23 提醒正式化——授权/恢复/执行链所需列。
 * reminders 增：
 * - auto_dispatch：**显式**自动派发授权（创建时用户明确选择；sourceRef 字符串不是授权事实——
 *   授权只能来自本地入口的显式选择或可信任务链的正式 grant，落库即冻结）。
 * - last_fired_at：上次已处理触发时刻（休眠错过次数从**实际计划**推导：last_fired_at 与
 *   本次 dueAt 之间的计划触发数-1，不依赖预插 occurrence 行）。
 * reminder_occurrences 增：
 * - task_id：本次触发派发的 dm_turn 任务（正式执行链锚点——task/run/turn/预算核对用）。
 * - confirmed_at：awaiting_confirmation→用户确认时刻（确认入口=reminder.confirm 命令）。
 * 表仍为 001 预埋（026 已增列），本迁移只 ALTER——不动已发布结构。
 */
import type { Migration } from '../db.ts';

export const remindersFormalMigration: Migration = {
  id: 27,
  name: 'reminders-formal-dispatch-columns',
  up: (db) => {
    db.exec(`
      ALTER TABLE reminders ADD COLUMN auto_dispatch INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE reminders ADD COLUMN last_fired_at INTEGER;
      ALTER TABLE reminder_occurrences ADD COLUMN task_id TEXT;
      ALTER TABLE reminder_occurrences ADD COLUMN confirmed_at INTEGER;
    `);
  },
};
