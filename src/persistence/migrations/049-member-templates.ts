import type { Migration } from '../db.ts';
/** Reusable configuration snapshots are independent of the member-owned agent_profiles. */
export const migration049: Migration = {
    id: 49,
    name: 'independent member configuration templates',
    up(db) {
        db.exec(`CREATE TABLE member_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    },
};
