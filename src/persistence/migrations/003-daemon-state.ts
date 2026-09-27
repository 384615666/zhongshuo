/**
 * 003 迁移：daemon 状态键值表（派发门禁等运行态标记）。
 * dispatch_gate = 'held'（恢复后等待用户确认继续，§16.4-6/决策 44/E7）| 'open'。
 */
import type { Migration } from '../db.ts';

export const daemonStateMigration: Migration = {
  id: 3,
  name: 'daemon-state-table',
  up: (db) => {
    db.exec(`CREATE TABLE daemon_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  },
};
