import type { Migration } from '../db.ts';

/**
 * Persistent, viewer-scoped desktop notification inbox. The cursor starts at
 * the first poll (initialized to the then-current domain-event high-water mark),
 * so upgrading an existing data root never floods old completions.
 *
 * Delivery state is intentionally independent from task/run state. Each source
 * event can create at most one notification for a viewer, and the unique
 * semantic key makes replay/idempotent command retries harmless.
 */
export const migration059: Migration = {
  id: 59,
  name: 'desktop-task-notifications',
  up(db) {
    db.exec(`
      CREATE TABLE task_notification_cursors (
        viewer_id TEXT PRIMARY KEY,
        last_event_seq INTEGER NOT NULL CHECK (last_event_seq >= 0),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE task_notifications (
        notification_id TEXT PRIMARY KEY,
        viewer_id TEXT NOT NULL,
        source_event_seq INTEGER NOT NULL CHECK (source_event_seq > 0),
        source_event_id TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'task.completed',
          'task.needs_attention',
          'task.needs_input',
          'task.needs_review'
        )),
        project_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        room_id TEXT,
        thread_id TEXT,
        task_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        locator_hash TEXT NOT NULL,
        delivery_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (delivery_state IN ('pending','claimed','show_requested','shown','failed','unknown','suppressed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        claimed_at INTEGER,
        shown_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (viewer_id, source_event_id),
        UNIQUE (viewer_id, source_event_seq),
        UNIQUE (viewer_id, dedupe_key)
      );

      CREATE INDEX task_notifications_pending
        ON task_notifications(viewer_id, delivery_state, source_event_seq);
      CREATE INDEX task_notifications_thread
        ON task_notifications(viewer_id, thread_id, delivery_state);

      CREATE TABLE task_notification_attempts (
        attempt_id TEXT PRIMARY KEY,
        notification_id TEXT NOT NULL UNIQUE REFERENCES task_notifications(notification_id),
        viewer_id TEXT NOT NULL,
        claim_requested_at INTEGER NOT NULL,
        show_requested_at INTEGER,
        shown_at INTEGER,
        failed_at INTEGER,
        failure_reason TEXT,
        clicked_at INTEGER,
        closed_at INTEGER
      );
      CREATE INDEX task_notification_attempts_by_viewer
        ON task_notification_attempts(viewer_id, claim_requested_at DESC);
    `);
  },
};
