/**
 * 031（第二十六轮五）：DEV-24 文本附件首包——artifacts 增列。
 * - source_name：上传时的来源文件名（保留中文/空格——副本内容寻址不依赖文件名）；
 * - created_at：资源创建时刻（版本/重启保持呈现）。
 */
import type { Migration } from '../db.ts';

export const artifactSourceMigration: Migration = {
  id: 31,
  name: 'artifact-source-name-created-at',
  up: (db) => {
    db.exec(`
      ALTER TABLE artifacts ADD COLUMN source_name TEXT;
      ALTER TABLE artifacts ADD COLUMN created_at INTEGER;
    `);
  },
};
