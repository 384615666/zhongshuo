/**
 * 019（第十二轮·五）：runtime_process_registry.identity_source 增列 'managed-job'
 * （REC-LIFE-1 受管生命周期：进程经 Job Object 挂起纳管，登记含受管证据语义——
 * releaseProtection 可按 pid 查受管句柄的 releaseEvidence 解除）。
 * CHECK 约束不可改——重建表搬数据（与 015/018 同做法）。
 */
import type { Migration } from '../db.ts';

export const managedJobIdentityMigration: Migration = {
  id: 19,
  name: 'managed-job-identity-source',
  up: (db) => {
    db.exec(`
      CREATE TABLE runtime_process_registry_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        adapter_kind TEXT NOT NULL,
        process_model TEXT NOT NULL CHECK (process_model IN ('per-turn','shared','none','unknown')),
        pid INTEGER,
        started_at_ms INTEGER,
        identity_source TEXT NOT NULL CHECK (identity_source IN ('os-starttime','pid-only','none','pre-launch','managed-job')),
        registered_at INTEGER NOT NULL,
        closed_at INTEGER,
        note TEXT
      );
      INSERT INTO runtime_process_registry_v2 (id, turn_id, run_id, member_id, adapter_kind, process_model, pid, started_at_ms, identity_source, registered_at, closed_at, note)
        SELECT id, turn_id, run_id, member_id, adapter_kind, process_model, pid, started_at_ms, identity_source, registered_at, closed_at, note FROM runtime_process_registry;
      DROP TABLE runtime_process_registry;
      ALTER TABLE runtime_process_registry_v2 RENAME TO runtime_process_registry;
      CREATE UNIQUE INDEX runtime_process_registry_turn ON runtime_process_registry(turn_id);
    `);
  },
};
