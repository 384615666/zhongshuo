/**
 * 029（第二十五轮四）：DEV-18 收藏——通用引用收藏表 saved_refs。
 * 001 预埋的 saved_items 以 message 外键为主键（消息收藏的正式合同位，保留不动）；
 * 链接/任务/交付引用装不进该主键（FK 强绑 messages）——按类别分列进 saved_refs：
 * kind ∈ message|link|task|delivery；PK(viewer,kind,ref) 天然幂等；取消收藏只删本行
 * （不删原内容）；读取时逐条校验目标存在+audience（missing/forbidden 如实呈现）。
 */
import type { Migration } from '../db.ts';

export const savedRefsMigration: Migration = {
  id: 29,
  name: 'saved-refs-for-follow-search-save',
  up: (db) => {
    db.exec(`
      CREATE TABLE saved_refs (
        viewer_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message','link','task','delivery')),
        ref TEXT NOT NULL,
        title TEXT,
        project_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (viewer_id, kind, ref)
      );
      CREATE INDEX saved_refs_by_viewer ON saved_refs(viewer_id, created_at DESC);
    `);
  },
};
