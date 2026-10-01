/**
 * 028（第二十五轮一）：提醒预算接到**实际调用边界**——触发上限与模型调用预算分离。
 * - reminder_calls：提醒的**调用台账**（每一条归因到提醒的模型调用=一行）。预占在派发/
 *   确认创建时落（status='reserved'），worker 建 turn 时挂钩（turn_id+inflight），终态
 *   settled/failed/unknown 仍计数（保守记账——重启不清零）；仅「任务在 turn 前取消/退款」
 *   走 released。追加执行/格式修复/重派在 worker 建 turn 前经 acquireReminderTurnSlot
 *   统一检查+入账（不能通过新 run 绕开）。
 * - reminders.max_triggers：**触发次数上限**（occurrence 口径——与模型调用预算 budget_json
 *   分列；NULL=按计划自然限制）。
 * - reminders.bound_stop_generation：任务停止代次的**绑定快照**——重查按「保存的绑定事实」
 *   核对：task.stop_generation > bound（绑定后发生新停止）才判 task-stopped；历史停止
 *   （绑定时已存在）不永久禁止新合法提醒。
 */
import type { Migration } from '../db.ts';

export const remindersCallsMigration: Migration = {
  id: 28,
  name: 'reminders-calls-ledger-and-trigger-cap',
  up: (db) => {
    db.exec(`
      CREATE TABLE reminder_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reminder_id TEXT NOT NULL REFERENCES reminders(id),
        task_id TEXT NOT NULL,
        turn_id TEXT,
        dispatch_tag TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'reserved'
          CHECK (status IN ('reserved','inflight','settled','failed','unknown','released')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (reminder_id, dispatch_tag)
      );
      CREATE INDEX reminder_calls_by_reminder ON reminder_calls(reminder_id, status);
      CREATE INDEX reminder_calls_by_task ON reminder_calls(task_id);
      ALTER TABLE reminders ADD COLUMN max_triggers INTEGER;
      ALTER TABLE reminders ADD COLUMN bound_stop_generation INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
