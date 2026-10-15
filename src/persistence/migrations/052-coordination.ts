import type { Migration } from '../db.ts';
/** New workers interpret parent/child dispatch intents; older programs must refuse this root. */
export const migration052: Migration = {
  id: 52, name: 'bounded persistent multi member coordination',
  up(db) {
    db.exec(`
      CREATE TABLE coordination_scopes (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        roster_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE coordination_runs (
        run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        stop_generation INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('planning','running','integrating','completed','blocked','cancelled')),
        plan_json TEXT, integration_run_id TEXT REFERENCES workflow_runs(id),
        error_message TEXT, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX one_live_coordination ON coordination_runs(task_id) WHERE state IN ('planning','running','integrating');
      CREATE TABLE coordination_steps (
        run_id TEXT NOT NULL REFERENCES coordination_runs(run_id),
        step_key TEXT NOT NULL, child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
        role TEXT NOT NULL CHECK(role IN ('analysis','implementation','review')),
        handoff_json TEXT, PRIMARY KEY(run_id,step_key)
      );
    `);
  },
};
