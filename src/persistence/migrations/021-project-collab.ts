/**
 * 021（第十七轮三）：项目级协作限制（§17.8 协作限制节——缺席等待+单轮运行时限）。
 * NULL=回落 daemon 全局默认（构造/env）——生效边界：新派发 turn 起读取；在途不变。
 * CAS 沿用 projects.revision（与 task_review_enabled 同款并发冲突语义）。
 */
import type { Migration } from '../db.ts';

export const projectCollabMigration: Migration = {
  id: 21,
  name: 'project-collab-limits',
  up: (db) => {
    db.exec('ALTER TABLE projects ADD COLUMN collab_absence_tolerance_ms INTEGER');
    db.exec('ALTER TABLE projects ADD COLUMN collab_turn_deadline_ms INTEGER');
  },
};
