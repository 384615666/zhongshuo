/**
 * 005 迁移：workflow_runs.stage_started_at（M1 DELIBERATE 编排）。
 * 阶段进入时间——E4 缺席容忍按各阶段起算（不使用统一 wall-clock 替代状态）。
 */
import type { Migration } from '../db.ts';

export const runStageStartedAtMigration: Migration = {
  id: 5,
  name: 'run-stage-started-at',
  up: (db) => {
    db.exec(`ALTER TABLE workflow_runs ADD COLUMN stage_started_at INTEGER`);
  },
};
