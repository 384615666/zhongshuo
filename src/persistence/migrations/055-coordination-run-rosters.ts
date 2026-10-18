import type {Migration} from '../db.ts';

/** Per-run explicit-recipient roster. The task-level coordination scope remains for
 * model-planned runs; deterministic multi-recipient sends get their own immutable
 * roster so later mentions cannot rewrite an earlier run's participant facts. */
export const migration055:Migration={
  id:55,
  name:'coordination run rosters',
  up(db){
    db.exec(`CREATE TABLE coordination_run_rosters (
      run_id TEXT PRIMARY KEY REFERENCES coordination_runs(run_id),
      roster_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  },
};
