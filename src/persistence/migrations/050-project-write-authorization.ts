import type { Migration } from '../db.ts';
/** Explicit project grants; task snapshots prevent later grants elevating queued work. */
export const migration050: Migration = {
  id: 50, name: 'explicit project write authorization',
  up(db) {
    db.exec(`CREATE TABLE project_write_authorizations (
      project_id TEXT PRIMARY KEY REFERENCES projects(id),
      authorized INTEGER NOT NULL DEFAULT 0 CHECK(authorized IN (0,1)),
      canonical_root TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      physical_identity TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    ALTER TABLE tasks ADD COLUMN write_scope_json TEXT NOT NULL DEFAULT '{}';
    CREATE TRIGGER task_write_authorization_snapshot AFTER INSERT ON tasks BEGIN
      UPDATE tasks SET write_scope_json = COALESCE((SELECT json_object(
        'authorized', authorized, 'root', canonical_root, 'revision', revision,
        'memberRevision', (SELECT settings_revision FROM project_members WHERE id=NEW.owner_member_id),
        'memberPermission', (SELECT json_extract(ap.settings_json,'$.permissionMode') FROM project_members pm JOIN agent_profiles ap ON ap.id=pm.profile_id WHERE pm.id=NEW.owner_member_id))
        FROM project_write_authorizations WHERE project_id = NEW.project_id), '{}') WHERE id = NEW.id;
    END;`);
  },
};
