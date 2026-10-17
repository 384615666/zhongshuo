import type {Migration} from '../db.ts';
export const migration054:Migration={id:54,name:'authenticated member message handoffs',up(db){db.exec(`
  CREATE TABLE coordination_messages (
    id TEXT PRIMARY KEY,
    coordination_run_id TEXT NOT NULL REFERENCES coordination_runs(run_id),
    project_id TEXT NOT NULL REFERENCES projects(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),
    thread_id TEXT NOT NULL REFERENCES conversation_threads(id),
    source_turn_id TEXT NOT NULL REFERENCES agent_turns(id),source_index INTEGER NOT NULL,
    source_member_id TEXT NOT NULL REFERENCES project_members(id),target_member_id TEXT NOT NULL REFERENCES project_members(id),
    purpose TEXT NOT NULL CHECK(purpose IN ('ask','review','implement','reply')),
    body TEXT NOT NULL,body_hash TEXT NOT NULL,
    child_task_id TEXT REFERENCES tasks(id),target_turn_id TEXT REFERENCES agent_turns(id),
    target_delivery_id TEXT REFERENCES task_deliveries(id),
    status TEXT NOT NULL CHECK(status IN ('accepted','queued','running','completed','blocked','cancelled')),
    error_message TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    UNIQUE(source_turn_id,source_index),
    UNIQUE(coordination_run_id,source_member_id,target_member_id,purpose,body_hash)
  );
  CREATE INDEX coordination_message_child ON coordination_messages(child_task_id,status);
`);}};
