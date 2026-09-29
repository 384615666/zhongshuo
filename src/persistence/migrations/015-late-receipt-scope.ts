/**
 * 015（第九轮）：迟到事件回执重建（作用域键 + 处理结果）。
 *
 * 问题（用户令第九轮二）：013 的回执主键只有 event_key——
 * - 先记回执再应用业务效果的写法，中断后重放会跳过事件、业务效果永久缺失；
 * - eventKey 全局唯一不成立（不同 adapter/session 的键空间互不相干）。
 *
 * 新表：主键 (source_scope, turn_id, event_key)——事件源作用域（adapter kind+会话）+turn
 * 身份+事件键；outcome 记录处理结果（applied/ignored），与业务效果**同一事务**提交
 * （失败=整体回滚，回执不残留——重放重新处理，效果恰好一次）。
 */
import type { Migration } from '../db.ts';

export const lateReceiptScopeMigration: Migration = {
  id: 15,
  name: 'late-receipt-scope-outcome',
  up: (db) => {
    db.exec(`
      DROP TABLE IF EXISTS late_event_receipts;
      CREATE TABLE late_event_receipts (
        source_scope TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('applied','ignored')),
        note TEXT,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (source_scope, turn_id, event_key)
      );
    `);
  },
};
