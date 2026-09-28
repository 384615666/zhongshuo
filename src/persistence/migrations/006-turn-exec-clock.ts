/**
 * 006 迁移：agent_turns 执行时钟（M1 收口轮二）。
 * exec_started_at=turn.started 时刻；exec_paused_ms=审批/等待输入等暂停累计。
 * E4 absenceGrace 按成员实际执行时间计（不含排队与暂停）；单轮 turnDeadline 走中断分支。
 */
import type { Migration } from '../db.ts';

export const turnExecClockMigration: Migration = {
  id: 6,
  name: 'turn-exec-clock',
  up: (db) => {
    db.exec(`ALTER TABLE agent_turns ADD COLUMN exec_started_at INTEGER`);
    db.exec(`ALTER TABLE agent_turns ADD COLUMN exec_paused_ms INTEGER NOT NULL DEFAULT 0`);
  },
};
