/**
 * 迁移 032（第二十七轮五）：agent_turns.stop_generation_snapshot——turn 创建时的任务停止
 * 代次快照。判定「停止是否作用于本 turn」改为 current > snapshot（历史代次不永久禁止新合法
 * 派发——停止结算后绑定提醒的跟进派发不再被领取/执行/迟到输出三层误拦）；旧行无快照（-1）
 * 沿用保守旧语义（current>0 即视为生效）。
 */
import type { Migration } from '../db.ts';

export const migration032: Migration = {
  id: 32,
  name: 'turn-stop-generation-snapshot',
  up: (db) => {
    db.exec('ALTER TABLE agent_turns ADD COLUMN stop_generation_snapshot INTEGER NOT NULL DEFAULT -1;');
  },
};
