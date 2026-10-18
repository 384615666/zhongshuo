import type { Migration } from '../db.ts';

/**
 * R90: freeze the user-visible deliberation call budget on the root task.
 *
 * The task column is written inside the same transaction as the message/task/outbox
 * creation. The insert trigger re-applies that value to every new DELIBERATE run,
 * so worker/process options can choose the initial object but cannot override the
 * task snapshot. The trigger is insert-only: later messages create new tasks/runs
 * and cannot mutate an existing run's cap.
 */
export const migration056: Migration = {
  id: 56,
  name: 'task-frozen-deliberation-budget',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN deliberation_budget_json TEXT
        CHECK (deliberation_budget_json IS NULL OR json_valid(deliberation_budget_json));

      CREATE TRIGGER workflow_run_deliberation_budget_from_task
      AFTER INSERT ON workflow_runs
      WHEN NEW.mode = 'DELIBERATE'
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
