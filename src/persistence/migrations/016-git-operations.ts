/**
 * 第十轮：Git 写操作日志（RT-24）。
 * - 每次经本产品的 Git 写操作一行（stage/unstage/stage_task/commit/commit_undo）；
 * - id=commandId：命令网关回执丢失时按日志核对既成事实（不重复 commit/不误报未执行）；
 * - commit_oid 建索引用于 git.history 的任务/改动集关联（§14.6 每条提交可回溯）。
 * 提交不改变 ChangeSet.application_status 或交付验收状态（§14.3/§14.6 两维度独立）。
 */
import type { Migration } from '../db.ts';

export const gitOperationsMigration: Migration = {
  id: 16,
  name: 'git-operations',
  up: (db) => {
    db.exec(`
      CREATE TABLE git_operations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        action TEXT NOT NULL CHECK (action IN ('stage','unstage','stage_task','commit','commit_undo')),
        task_id TEXT,
        change_set_ids_json TEXT,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        head_before TEXT,
        head_after TEXT,
        commit_oid TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX git_ops_by_project ON git_operations(project_id, created_at);
      CREATE INDEX git_ops_by_commit ON git_operations(commit_oid) WHERE commit_oid IS NOT NULL;
    `);
  },
};
