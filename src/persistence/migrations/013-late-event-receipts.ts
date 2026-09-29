/**
 * 013（第八轮）：迟到事件回执。
 *
 * late_event_receipts：迟到成果泵（recovery.pumpLateEvents）的事件回执——同一 eventKey
 * 只生效一次（交付/预算/状态幂等的第一道闸；第二道=turn 终态 CAS）。泵从 adapter 正式
 * 通道（lateEvents：持久化会话记录/重连存量流）拉取 UNKNOWN turn 截止后到达的终态事件。
 */
import type { Migration } from '../db.ts';

export const lateEventReceiptsMigration: Migration = {
  id: 13,
  name: 'late-event-receipts',
  up: (db) => {
    db.exec(`
      CREATE TABLE late_event_receipts (
        event_key TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
    `);
  },
};
