/**
 * 迁移 033（第二十七轮六）：attachment_comments——文本/代码/Markdown 附件基础评论。
 * 锚定**评论时资源版本**（artifact_hash+artifact_revision 快照）：资源更新后旧评论明确标旧
 * （stale 由读取时比对当前 hash 得出），行号/选区锚点不漂移到新版（不重算）。
 */
import type { Migration } from '../db.ts';

export const migration033: Migration = {
  id: 33,
  name: 'attachment-comments',
  up: (db) => {
    db.exec(`
      CREATE TABLE attachment_comments (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        author_id TEXT NOT NULL,
        quote TEXT,
        line_from INTEGER,
        line_to INTEGER,
        body TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        artifact_revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX attachment_comments_by_artifact ON attachment_comments(artifact_id, created_at);
    `);
  },
};
