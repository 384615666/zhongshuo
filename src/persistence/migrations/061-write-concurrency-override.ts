import type { Migration } from '../db.ts';

/** NULL preserves the existing full-access thread sharing behavior. */
export const migration061: Migration = {
  id: 61,
  name: 'explicit-project-write-concurrency',
  up(db) {
    db.exec(`ALTER TABLE projects ADD COLUMN write_concurrency_override TEXT
      CHECK (write_concurrency_override IN ('single_writer','parallel_writers'));`);
  },
};
