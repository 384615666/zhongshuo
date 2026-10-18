import type { Migration } from '../db.ts';

/**
 * R90: preserve per-thread-reply deliberation identity.
 *
 * A thread shares its root task, so the task-level budget from 056 is not a
 * sufficient source for later independent discussions. The request snapshot is
 * authoritative when a run carries a dispatch identity; room-root runs keep the
 * existing 056 behavior because their dispatch identity is NULL.
 */
export const migration057: Migration = {
  id: 57,
  name: 'thread-deliberation-budget-and-dispatch-identity',
  up(db) {
    db.exec(`
      ALTER TABLE thread_reply_requests ADD COLUMN deliberation_budget_json TEXT
        CHECK (deliberation_budget_json IS NULL OR json_valid(deliberation_budget_json));
      ALTER TABLE thread_reply_requests ADD COLUMN dispatch_identity TEXT;
      ALTER TABLE thread_reply_requests ADD COLUMN result_message_id TEXT REFERENCES messages(id);

      UPDATE thread_reply_requests
      SET dispatch_identity = dispatch_key
      WHERE dispatch_identity IS NULL;

      CREATE UNIQUE INDEX thread_reply_dispatch_identity
        ON thread_reply_requests(dispatch_identity)
        WHERE dispatch_identity IS NOT NULL;

      ALTER TABLE workflow_runs ADD COLUMN dispatch_identity TEXT;

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
        SET budget_json = json_set(
          COALESCE(NEW.budget_json, '{}'),
          '$.runMaxTurns',
          json_extract(
            (SELECT deliberation_budget_json FROM tasks WHERE id = NEW.task_id),
            '$.maxTurns'
          )
        )
        WHERE id = NEW.id;
      END;
    `);
  },
};
