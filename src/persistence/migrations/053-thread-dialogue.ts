import type {Migration} from '../db.ts';

/** New per-message routing/scope and live progress are not understood by older
 * workers. Keep 001–052 immutable and let the existing version gate refuse them. */
export const migration053:Migration={
  id:53,name:'thread dialogue requests and visible runtime progress',
  up(db){db.exec(`
    CREATE TABLE thread_reply_requests (
      message_id TEXT PRIMARY KEY REFERENCES messages(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      member_id TEXT NOT NULL REFERENCES project_members(id),
      source_turn_id TEXT REFERENCES agent_turns(id),
      stop_generation INTEGER NOT NULL,
      input_thread_seq INTEGER NOT NULL CHECK(input_thread_seq>0),
      dispatch_key TEXT NOT NULL UNIQUE,
      route_json TEXT NOT NULL,
      roster_json TEXT NOT NULL,
      write_scope_json TEXT NOT NULL,
      membership_version TEXT NOT NULL,
      source_delivery_id TEXT REFERENCES task_deliveries(id),
      source_task_status TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','blocked','cancelled','unknown')),
      run_id TEXT REFERENCES workflow_runs(id),turn_id TEXT REFERENCES agent_turns(id),
      error_message TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
    );
    CREATE INDEX thread_reply_task_state ON thread_reply_requests(task_id,status);
    CREATE TABLE turn_visible_progress (
      turn_id TEXT PRIMARY KEY REFERENCES agent_turns(id),
      source_message_id TEXT NOT NULL,text TEXT NOT NULL,updated_at INTEGER NOT NULL
    );
  `);},
};
