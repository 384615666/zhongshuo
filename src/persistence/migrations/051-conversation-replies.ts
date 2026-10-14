import type { Migration } from '../db.ts';
/** Durable per-message ordinary replies. Old workers do not understand their dispatch
 * keys, so a schema version gate is necessary even though old task rows stay intact. */
export const migration051: Migration = {
  id: 51, name: 'durable ordinary conversation reply requests',
  up(db) {
    db.exec(`ALTER TABLE tasks ADD COLUMN response_kind TEXT CHECK(response_kind IN ('conversation','work'));
    UPDATE tasks SET response_kind='work' WHERE EXISTS(SELECT 1 FROM task_deliveries d WHERE d.task_id=tasks.id);
    UPDATE tasks SET response_kind='conversation' WHERE response_kind IS NULL AND EXISTS(SELECT 1 FROM domain_events e WHERE e.task_id=tasks.id AND e.kind='turn.statusChanged' AND CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json,'$.status') END='SUCCEEDED' AND CASE WHEN json_valid(e.payload_json) THEN json_extract(e.payload_json,'$.responseKind') END='conversation');
    CREATE TABLE conversation_reply_requests (
      message_id TEXT PRIMARY KEY REFERENCES messages(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      member_id TEXT NOT NULL REFERENCES project_members(id),
      source_turn_id TEXT NOT NULL REFERENCES agent_turns(id),
      input_thread_seq INTEGER NOT NULL CHECK(input_thread_seq > 0),
      dispatch_key TEXT NOT NULL UNIQUE,
      write_scope_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','blocked','cancelled','unknown')),
      run_id TEXT REFERENCES workflow_runs(id), turn_id TEXT REFERENCES agent_turns(id),
      error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX conversation_reply_task_state ON conversation_reply_requests(task_id,status);`);
  },
};
