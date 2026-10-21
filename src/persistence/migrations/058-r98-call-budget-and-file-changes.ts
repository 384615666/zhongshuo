import type { Migration } from '../db.ts';

/**
 * R98:
 * - Replace the room-root insert trigger with one atomic merge of the numeric
 *   compatibility projection and the frozen policy. Two AFTER INSERT triggers
 *   would depend on trigger order: the older one uses NEW.budget_json and can
 *   erase the policy attached by the newer one. Existing runs remain untouched.
 * - Persist the complete per-message file-change list separately from
 *   openable attachment rows. Unsupported/large files remain visible as facts.
 */
export const migration058: Migration = {
  id: 58,
  name: 'r98-call-budget-and-message-file-changes',
  up(db) {
    db.exec(`
      DROP TRIGGER IF EXISTS workflow_run_call_budget_from_task;
      DROP TRIGGER IF EXISTS workflow_run_deliberation_budget_from_task;
      CREATE TRIGGER workflow_run_deliberation_budget_from_task
      AFTER INSERT ON workflow_runs
      WHEN NEW.mode = 'DELIBERATE'
        AND NEW.dispatch_identity IS NULL
        AND json_type(
          (SELECT deliberation_budget_json FROM tasks WHERE id = NEW.task_id),
          '$.maxTurns'
        ) = 'integer'
        AND json_extract(
          (SELECT deliberation_budget_json FROM tasks WHERE id = NEW.task_id),
          '$.maxTurns'
        ) > 0
      BEGIN
        UPDATE workflow_runs
        SET budget_json = CASE WHEN json_type(
          (SELECT deliberation_budget_json FROM tasks WHERE id = NEW.task_id),
          '$.callBudget'
        ) = 'object' THEN json_set(
          COALESCE(budget_json, '{}'),
          '$.runMaxTurns', json_extract(
            (SELECT deliberation_budget_json FROM tasks WHERE id = NEW.task_id),
            '$.maxTurns'
          ),
          '$.callBudget', json_extract(
            (SELECT deliberation_budget_json FROM tasks WHERE id = NEW.task_id),
            '$.callBudget'
          )
        ) ELSE json_set(
          COALESCE(budget_json, '{}'),
          '$.runMaxTurns', json_extract(
            (SELECT deliberation_budget_json FROM tasks WHERE id = NEW.task_id),
            '$.maxTurns'
          )
        ) END
        WHERE id = NEW.id;
      END;

      CREATE TABLE message_file_changes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        message_id TEXT NOT NULL REFERENCES messages(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        run_id TEXT REFERENCES workflow_runs(id),
        turn_id TEXT REFERENCES agent_turns(id),
        change_set_id TEXT REFERENCES change_sets(id),
        path TEXT NOT NULL,
        display_name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('added','modified','removed','unknown')),
        source TEXT NOT NULL CHECK (source IN ('declared','diff','declared+diff')),
        declared INTEGER NOT NULL CHECK (declared IN (0,1)),
        human_facing INTEGER NOT NULL CHECK (human_facing IN (0,1)),
        before_sha256 TEXT,
        after_sha256 TEXT,
        size_bytes INTEGER,
        added_lines INTEGER CHECK (added_lines IS NULL OR added_lines >= 0),
        removed_lines INTEGER CHECK (removed_lines IS NULL OR removed_lines >= 0),
        artifact_id TEXT REFERENCES artifacts(id),
        created_at INTEGER NOT NULL,
        UNIQUE(message_id, path)
      );
      CREATE INDEX message_file_changes_by_message
        ON message_file_changes(message_id, human_facing, path);
      CREATE INDEX message_file_changes_by_task
        ON message_file_changes(task_id, created_at);
    `);
  },
};
