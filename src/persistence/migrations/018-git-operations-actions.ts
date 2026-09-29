/**
 * 018（第十一轮·三）：git_operations 动作枚举扩展（RT-24 剩余功能）。
 *
 * 016 的 action CHECK 只覆盖 stage/unstage/stage_task/commit/commit_undo；本轮新增
 * branch_create/checkout/push/pull/conflict_resolve 需入操作日志（同一意图/恢复协议）。
 * SQLite 不能 ALTER CHECK——重建表（新表结构+数据搬移；列含 017 的 status/request_hash）。
 */
import type { Migration } from '../db.ts';

export const gitOperationsActionsMigration: Migration = {
  id: 18,
  name: 'git-operations-actions',
  up: (db) => {
    db.exec(`
      CREATE TABLE git_operations_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        action TEXT NOT NULL CHECK (action IN ('stage','unstage','stage_task','commit','commit_undo','branch_create','checkout','push','pull','conflict_resolve')),
        task_id TEXT,
        change_set_ids_json TEXT,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        head_before TEXT,
        head_after TEXT,
        commit_oid TEXT,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending','done')),
        request_hash TEXT
      );
      INSERT INTO git_operations_v2 (id, project_id, action, task_id, change_set_ids_json, request_json, result_json, head_before, head_after, commit_oid, created_at, status, request_hash)
        SELECT id, project_id, action, task_id, change_set_ids_json, request_json, result_json, head_before, head_after, commit_oid, created_at, status, request_hash FROM git_operations;
      DROP TABLE git_operations;
      ALTER TABLE git_operations_v2 RENAME TO git_operations;
      CREATE INDEX git_ops_by_project ON git_operations(project_id, created_at);
      CREATE INDEX git_ops_by_commit ON git_operations(commit_oid) WHERE commit_oid IS NOT NULL;
      CREATE INDEX git_ops_pending ON git_operations(status, created_at) WHERE status = 'pending';
    `);
  },
};
