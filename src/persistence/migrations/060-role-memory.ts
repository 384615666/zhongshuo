import type { Migration } from '../db.ts';

/** Additive only: existing task/turn/input records are never backfilled or edited. */
export const migration060: Migration = {
  id: 60,
  name: 'versioned-role-memory',
  up(db) {
    db.exec(`
      CREATE TABLE role_memory_scopes (
        project_id TEXT NOT NULL REFERENCES projects(id),
        member_id TEXT NOT NULL REFERENCES project_members(id),
        conversation_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        PRIMARY KEY (project_id, member_id, conversation_id),
        FOREIGN KEY (project_id, conversation_id) REFERENCES conversations(project_id, id)
      );

      CREATE TABLE role_memory_commits (
        source_turn_id TEXT PRIMARY KEY REFERENCES agent_turns(id),
        project_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source_task_id TEXT NOT NULL REFERENCES tasks(id),
        source_thread_id TEXT REFERENCES conversation_threads(id),
        payload_hash TEXT NOT NULL,
        base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
        revision INTEGER NOT NULL CHECK (revision >= base_revision),
        created_at INTEGER NOT NULL,
        FOREIGN KEY (project_id, member_id, conversation_id)
          REFERENCES role_memory_scopes(project_id, member_id, conversation_id)
      );
      CREATE INDEX role_memory_commits_by_scope
        ON role_memory_commits(project_id, member_id, conversation_id, revision);

      CREATE TABLE role_memory_values (
        source_turn_id TEXT NOT NULL REFERENCES role_memory_commits(source_turn_id),
        key TEXT NOT NULL CHECK (length(trim(key)) > 0),
        text TEXT NOT NULL CHECK (length(trim(text)) > 0),
        PRIMARY KEY (source_turn_id, key, text)
      );
    `);
  },
};
