/**
 * 迁移 034（第二十八轮二）：outbox.stop_generation_at_enqueue——派发意图**入队时**的任务
 * 停止代次快照。领取判定据此区分：意图入队后无新停止（==）=合法（忙碌时沿串行等待，不
 * 静默丢弃）；被新停止超越（>）=旧意图拒绝（不复活）。旧行无快照（-1）回落第二十七轮
 * 保守判定（仅迁移前遗留队列行，重启即清）。
 */
import type { Migration } from '../db.ts';

export const migration034: Migration = {
  id: 34,
  name: 'outbox-stop-generation-at-enqueue',
  up: (db) => {
    db.exec('ALTER TABLE outbox ADD COLUMN stop_generation_at_enqueue INTEGER NOT NULL DEFAULT -1;');
  },
};
