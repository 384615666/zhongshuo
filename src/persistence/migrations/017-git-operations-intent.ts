/**
 * 017（第十一轮）：Git 写操作持久意图。
 *
 * 问题（用户令第十一轮三）：副作用前无持久意图——崩溃后重试只凭提交信息尾标记与父提交，
 * 无法区分「未执行」与「执行到一半」；stage/unstage 重试也无法识别中途外部变化。
 *
 * - status：pending（副作用前写入）/done（结果落库）。旧行默认 done（第十轮已完成的操作）。
 * - request_hash：命令参数 hash——同 commandId 异参数在「日志有、回执无」及恢复分支同样拒绝。
 * - 预期 parent/tree 记在 request_json（commit：expectedHead/expectedTree；恢复核对用）。
 */
import type { Migration } from '../db.ts';

export const gitOperationsIntentMigration: Migration = {
  id: 17,
  name: 'git-operations-intent',
  up: (db) => {
    db.exec(`
      ALTER TABLE git_operations ADD COLUMN status TEXT NOT NULL DEFAULT 'done'
        CHECK (status IN ('pending','done'));
      ALTER TABLE git_operations ADD COLUMN request_hash TEXT;
      CREATE INDEX git_ops_pending ON git_operations(status, created_at) WHERE status = 'pending';
    `);
  },
};
