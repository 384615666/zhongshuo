import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { ensureDefaultMembers } from '../../src/daemon/defaultMembers.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-r90-default-project-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('R90 default project bootstrap', () => {
  it('creates one app-managed project/room for an empty root and reuses it idempotently', async () => {
    const db = openDatabase(':memory:');
    const appDataDir = join(root, 'app-default');
    const deps = { db, localUserId: 'u_default', appDataDir, interruptTurn: async () => {} };
    const cmd = async <T>(method: string, params: unknown, id = randomUUID()) => {
      const response = await dispatchDaemonCommand(deps, {
        protocolVersion: 1,
        commandId: `r90-default-${id}`,
        method,
        params,
      }) as { ok: boolean; data: T; error?: { message: string } };
      expect(response.ok, response.error?.message).toBe(true);
      return response.data;
    };

    try {
      const first = await cmd<{
        project: { id: string; displayName: string; rootPath: string } | null;
        created: boolean;
        availableAgentCount: number;
      }>('project.ensureDefault', {});
      expect(first.project).toMatchObject({ displayName: '默认项目' });
      expect(first.created).toBe(true);
      expect(first.availableAgentCount).toBe(0);
      expect(existsSync(join(appDataDir, 'default-project'))).toBe(true);

      const second = await cmd<{
        project: { id: string; displayName: string } | null;
        created: boolean;
      }>('project.ensureDefault', {});
      expect(second.project?.id).toBe(first.project?.id);
      expect(second.created).toBe(false);

      expect(db.prepare("SELECT count(*) n FROM projects WHERE status!='removed'").get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT count(*) n FROM rooms').get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) n FROM conversations WHERE kind='room'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT enabled FROM project_members WHERE display_name='待添加 AI'").get()).toEqual({ enabled: 0 });
      const discovery = ensureDefaultMembers(db, first.project!.id, [{
        kind: 'codex',
        displayName: 'Codex',
        reason: null,
        config: {
          kind: 'codex',
          model: 'synthetic-default-model',
          executable: 'codex',
          permissionMode: 'bypassPermissions',
          effort: 'medium',
        },
      }], false);
      expect(discovery.created).toHaveLength(1);
      expect(discovery.removedLegacyPlaceholder).toBe(true);
      expect(db.prepare("SELECT 1 FROM project_members WHERE display_name='待添加 AI'").get()).toBeUndefined();
      expect(db.prepare(
        "SELECT count(*) n FROM room_members rm JOIN project_members pm ON pm.id=rm.member_id WHERE pm.display_name='Codex' AND pm.enabled=1",
      ).get()).toEqual({ n: 1 });
      const rooms = await cmd<{ items: Array<{ memberIds?: string[] }> }>('room.list', { projectId: first.project!.id });
      expect(rooms.items).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('does not create a default project when an existing user project is present', async () => {
    const db = openDatabase(':memory:');
    const appDataDir = join(root, 'app-existing');
    const userRoot = join(root, 'user-owned-project');
    mkdirSync(userRoot, { recursive: true });
    const deps = { db, localUserId: 'u_existing', appDataDir, interruptTurn: async () => {} };
    const cmd = async <T>(method: string, params: unknown) => {
      const response = await dispatchDaemonCommand(deps, {
        protocolVersion: 1,
        commandId: `r90-existing-${randomUUID()}`,
        method,
        params,
      }) as { ok: boolean; data: T; error?: { message: string } };
      expect(response.ok, response.error?.message).toBe(true);
      return response.data;
    };

    try {
      const existing = await cmd<{ project: { id: string } }>('project.open', { path: userRoot });
      const ensured = await cmd<{
        project: null;
        created: false;
        reason: string;
      }>('project.ensureDefault', {});
      expect(ensured).toMatchObject({ project: null, created: false, reason: 'existing_projects' });
      expect(existsSync(join(appDataDir, 'default-project'))).toBe(false);
      expect(db.prepare('SELECT count(*) n FROM projects').get()).toEqual({ n: 1 });
      expect(existing.project.id).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('reopens an existing project in place when its room id is not the bootstrap default', async () => {
    const db = openDatabase(':memory:');
    const appDataDir = join(root, 'app-custom-room');
    const projectRoot = join(root, 'custom-room-project');
    mkdirSync(projectRoot, { recursive: true });
    const deps = { db, localUserId: 'u_custom_room', appDataDir, interruptTurn: async () => {} };
    const cmd = async <T>(method: string, params: unknown) => {
      const response = await dispatchDaemonCommand(deps, {
        protocolVersion: 1,
        commandId: `r90-custom-room-${randomUUID()}`,
        method,
        params,
      }) as { ok: boolean; data: T; error?: { message: string } };
      expect(response.ok, response.error?.message).toBe(true);
      return response.data;
    };

    try {
      const opened = await cmd<{ project: { id: string } }>('project.open', { path: projectRoot });
      const oldRoom = db.prepare('SELECT id, coordinator_member_id FROM rooms WHERE project_id=?').get(opened.project.id) as {
        id: string;
        coordinator_member_id: string;
      };
      db.transaction(() => {
        db.prepare('DELETE FROM conversations WHERE room_id=?').run(oldRoom.id);
        db.prepare('DELETE FROM room_members WHERE room_id=?').run(oldRoom.id);
        db.prepare('DELETE FROM rooms WHERE id=?').run(oldRoom.id);
        db.prepare("INSERT INTO rooms (id, project_id, name, coordinator_member_id) VALUES ('room_custom', ?, '自建房间', ?)")
          .run(opened.project.id, oldRoom.coordinator_member_id);
        db.prepare('INSERT INTO room_members (room_id, member_id) VALUES (?, ?)')
          .run('room_custom', oldRoom.coordinator_member_id);
        db.prepare("INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('conv_custom', ?, 'room', 'room_custom')")
          .run(opened.project.id);
      })();

      await cmd('project.open', { path: projectRoot });
      expect(db.prepare('SELECT id FROM rooms WHERE project_id=?').all(opened.project.id)).toEqual([{ id: 'room_custom' }]);
      expect(db.prepare('SELECT count(*) n FROM conversations WHERE project_id=?').get(opened.project.id)).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('keeps the same default project after a database reopen', async () => {
    const file = join(root, 'default-reopen.sqlite');
    const appDataDir = join(root, 'app-reopen');
    const firstDb = openDatabase(file);
    const firstDeps = { db: firstDb, localUserId: 'u_reopen', appDataDir, interruptTurn: async () => {} };
    const first = await dispatchDaemonCommand(firstDeps, {
      protocolVersion: 1,
      commandId: 'r90-reopen-first',
      method: 'project.ensureDefault',
      params: {},
    }) as { ok: boolean; data: { project: { id: string } } };
    expect(first.ok).toBe(true);
    firstDb.close();

    const secondDb = openDatabase(file);
    try {
      const second = await dispatchDaemonCommand({ ...firstDeps, db: secondDb }, {
        protocolVersion: 1,
        commandId: 'r90-reopen-second',
        method: 'project.ensureDefault',
        params: {},
      }) as { ok: boolean; data: { project: { id: string } | null; created: boolean } };
      expect(second.ok).toBe(true);
      expect(second.data.project?.id).toBe(first.data.project.id);
      expect(second.data.created).toBe(false);
      expect(secondDb.prepare('SELECT count(*) n FROM projects').get()).toEqual({ n: 1 });
      expect(secondDb.prepare('SELECT count(*) n FROM rooms').get()).toEqual({ n: 1 });
    } finally {
      secondDb.close();
    }
  });
});
