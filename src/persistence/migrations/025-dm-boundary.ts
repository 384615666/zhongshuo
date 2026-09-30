/**
 * 025（第十九轮四/五）：DM 输入水位（provider_session_id 已由 001 预埋，无需增列）。
 * - tasks.input_through_seq：本次用户消息的 conversation_seq 边界——组装历史只取
 *   ≤ 该水位的消息（排队中已保存的后续消息不提前进入前一轮输入；停止/重启/重领边界可解释）。
 */
import type { Migration } from '../db.ts';

export const dmBoundaryMigration: Migration = {
  id: 25,
  name: 'dm-input-boundary',
  up: (db) => {
    db.exec('ALTER TABLE tasks ADD COLUMN input_through_seq INTEGER');
  },
};
