/**
 * 022（第十七轮四）：real_calls——真实调用护栏持久台账（startTurn 级实际请求边界计数）。
 * 请求前占位（inflight）→ settled；batchId/runtime/模型/归属/状态分列；fake 不产生行
 * （本地/回放零真实调用=零行）。查询面：realCalls.summary 命令。
 */
import type { Migration } from '../db.ts';

export const realCallsMigration: Migration = {
  id: 22,
  name: 'real-calls-ledger',
  up: (db) => {
    db.exec(`CREATE TABLE real_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      model TEXT,
      member_id TEXT,
      task_id TEXT,
      turn_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('inflight','succeeded','failed','interrupted','unknown')),
      detail TEXT,
      created_at INTEGER NOT NULL,
      settled_at INTEGER
    )`);
    db.exec('CREATE INDEX real_calls_batch ON real_calls(batch_id)');
    db.exec('CREATE INDEX real_calls_turn ON real_calls(turn_id)');
  },
};
