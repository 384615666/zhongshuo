/**
 * 007 迁移：DEV-12 变更前像/非破坏撤销持久化。
 * - change_set_files：before/after 两角色的逐文件三态记录（present/absent/unknown + sha256 +
 *   受管理内容引用 contentRef + contentUnavailable 原因）——撤销决策与「内容级撤销不可用」
 *   的提前呈现都以这些行事实为据；
 * - change_set_undos：撤销意图/逐步进度/失败与冲突结果（支持中断后确定性恢复——按步幂等重验）。
 */
import type { Migration } from '../db.ts';

export const changesetPreimageMigration: Migration = {
  id: 7,
  name: 'changeset-preimage-undo',
  up: (db) => {
    db.exec(`
      CREATE TABLE change_set_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        change_set_id TEXT NOT NULL REFERENCES change_sets(id),
        role TEXT NOT NULL CHECK (role IN ('before','after')),
        path TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('present','absent','unknown')),
        sha256 TEXT,
        size INTEGER,
        content_ref TEXT,
        content_unavailable TEXT,
        error TEXT,
        UNIQUE (change_set_id, role, path)
      );
      CREATE INDEX change_set_files_by_set ON change_set_files(change_set_id, role);

      CREATE TABLE change_set_undos (
        id TEXT PRIMARY KEY,
        change_set_id TEXT NOT NULL REFERENCES change_sets(id),
        status TEXT NOT NULL CHECK (status IN ('in_progress','succeeded','failed','conflict'))
          DEFAULT 'in_progress',
        steps_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        failure_json TEXT,
        summary_json TEXT
      );
      CREATE INDEX change_set_undos_by_set ON change_set_undos(change_set_id);
      CREATE INDEX change_set_undos_active ON change_set_undos(status);
    `);
  },
};
