/**
 * 026（第二十三轮五）：DEV-23 提醒首版——**增列**（表已由 001 预埋，不改写已发布结构）。
 * reminders 增：title（objective 摘要）/paused_reason（停止-归档-移出的暂停取证）/
 * owner_user（请求者=人，与被唤醒的 owner_member_id 分列）/created_at/updated_at。
 * reminder_occurrences 增：fired_at/outcome（派发结果——预算拒绝等如实）/missed_count
 * （休眠错过合并计数——合同：合并为一个待确认/获准触发，不逐次补跑）。
 * 其余合同列 001 已有：timezone（独立列——时区只用于服务端计算下一次）、
 * schedule_json/next_at（UTC ms）/budget_json/grant_scope_json/source_ref；
 * occurrence 唯一键 (reminder_id, scheduled_at) 001 已建。
 */
import type { Migration } from '../db.ts';

export const remindersMigration: Migration = {
  id: 26,
  name: 'reminders-first-run-columns',
  up: (db) => {
    db.exec(`
      ALTER TABLE reminders ADD COLUMN title TEXT;
      ALTER TABLE reminders ADD COLUMN paused_reason TEXT;
      ALTER TABLE reminders ADD COLUMN owner_user TEXT;
      ALTER TABLE reminders ADD COLUMN created_at INTEGER;
      ALTER TABLE reminders ADD COLUMN updated_at INTEGER;
      ALTER TABLE reminder_occurrences ADD COLUMN fired_at INTEGER;
      ALTER TABLE reminder_occurrences ADD COLUMN outcome TEXT;
      ALTER TABLE reminder_occurrences ADD COLUMN missed_count INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
