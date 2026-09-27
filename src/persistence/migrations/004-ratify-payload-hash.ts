/**
 * 004 迁移：RATIFY 载荷散列（M1 修复轮）。
 * ratification_records 增加 payload_hash——同 resultKey 的重放按“规范化载荷散列”
 * 判定：相同=重放原回执；不同=IDEMPOTENCY_CONFLICT（不得静默当成功重放）。
 */
import type { Migration } from '../db.ts';

export const ratifyPayloadHashMigration: Migration = {
  id: 4,
  name: 'ratify-payload-hash',
  up: (db) => {
    db.exec(`ALTER TABLE ratification_records ADD COLUMN payload_hash TEXT`);
  },
};
