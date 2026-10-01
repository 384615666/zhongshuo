/**
 * 迁移 037（第三十轮六）：message_reactions——消息表情反应（本地用户操作；Agent 侧表情属
 * runtime 能力未开放）。唯一键 (message_id, reactor_id, emoji)——同消息同人同表情幂等；
 * 不同表情并存。呈现惰性（消息行点击才拉取）。
 */
import type { Migration } from '../db.ts';

export const migration037: Migration = {
  id: 37,
  name: 'message-reactions',
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS message_reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id),
      reactor_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (message_id, reactor_id, emoji)
    );`);
  },
};
