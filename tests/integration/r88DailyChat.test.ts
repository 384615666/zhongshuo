import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand, type DaemonCommandDeps } from '../../src/daemon/commands.ts';

const roots: string[] = [];
const databases: Array<ReturnType<typeof openDatabase>> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const db of databases.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs-r88-daily-'));
  roots.push(root);
  const project = join(root, 'project');
  mkdirSync(project);
  const db = openDatabase(join(root, 'state.sqlite'));
  databases.push(db);
  const deps: DaemonCommandDeps = { db, localUserId: 'u_local', interruptTurn: async () => {} };
  const raw = async (method: string, params: unknown, commandId: ReturnType<typeof randomUUID> = randomUUID()) =>
    await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId, method, params }) as {
      ok: boolean;
      data: Record<string, unknown>;
      error?: { code: string; message: string };
      replayed?: boolean;
    };
  const cmd = async <T = Record<string, unknown>>(method: string, params: unknown, commandId?: ReturnType<typeof randomUUID>): Promise<T> => {
    const response = await raw(method, params, commandId);
    expect(response.ok, response.error?.message).toBe(true);
    return response.data as T;
  };
  return { root, project, db, deps, raw, cmd };
}

describe('R88 durable appearance and real local default members', () => {
  it('stores bounded user/member avatars and visibility, survives reopen, resets, and rejects missing subjects', async () => {
    const f = await fixture();
    const opened = await f.cmd<{ project: { id: string } }>('project.open', { path: f.project });
    const member = f.db.prepare('SELECT id FROM project_members WHERE project_id=? LIMIT 1').get(opened.project.id) as { id: string };
    expect(await f.cmd('app.appearance.get', {})).toEqual({ showAvatars: false, avatars: {} });
    const png = `data:image/png;base64,${Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).toString('base64')}`;
    await f.cmd('app.appearance.set', { showAvatars: true, avatar: { subject: 'user', dataUrl: png } });
    await f.cmd('app.appearance.set', { avatar: { subject: `member:${member.id}`, dataUrl: png } });
    expect(await f.cmd('app.appearance.get', {})).toMatchObject({ showAvatars: true, avatars: { user: png, [`member:${member.id}`]: png } });
    expect((await f.raw('app.appearance.set', { avatar: { subject: 'member:m_missing', dataUrl: png } })).error?.code).toBe('VALIDATION_INVALID');
    const remote = await dispatchDaemonCommand({ ...f.deps, remoteAudit: { deviceId: 'd1', authEpoch: 1 } }, {
      protocolVersion: 1, commandId: randomUUID(), method: 'app.appearance.set', params: { showAvatars: false },
    });
    expect(remote).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    f.db.close();
    const reopened = openDatabase(join(f.root, 'state.sqlite'));
    databases.push(reopened);
    const read = await dispatchDaemonCommand({ db: reopened, localUserId: 'u_local', interruptTurn: async () => {} }, {
      protocolVersion: 1, commandId: randomUUID(), method: 'app.appearance.get', params: {},
    });
    expect(read).toMatchObject({ ok: true, data: { showAvatars: true } });
    await dispatchDaemonCommand({ db: reopened, localUserId: 'u_local', interruptTurn: async () => {} }, {
      protocolVersion: 1, commandId: randomUUID(), method: 'app.appearance.set', params: { avatar: { subject: 'user', dataUrl: null } },
    });
    const reset = await dispatchDaemonCommand({ db: reopened, localUserId: 'u_local', interruptTurn: async () => {} }, {
      protocolVersion: 1, commandId: randomUUID(), method: 'app.appearance.get', params: {},
    });
    expect(reset).toMatchObject({ ok: true, data: { showAvatars: true } });
    const resetResult = reset as { ok: true; data: { avatars: Record<string, string> } };
    expect(resetResult.data.avatars).not.toHaveProperty('user');
    expect(resetResult.data.avatars[`member:${member.id}`]).toBe(png);
    reopened.close();
  });

  it('discovers the effective Claude/Codex defaults once, preserves old members, replaces only an unused bootstrap placeholder, and stays project-isolated', async () => {
    const f = await fixture();
    const claudeDir = join(f.root, 'claude');
    const codexHome = join(f.root, 'codex');
    mkdirSync(claudeDir);
    mkdirSync(codexHome);
    const claudeSettings = JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek-flash[1M]', ANTHROPIC_AUTH_TOKEN: 'fixture-secret-never-return' } });
    const codexSettings = `model = "ccs-new/deepseek-flash"\nmodel_provider = "custom"\nmodel_reasoning_effort = "max"\n[model_providers.custom]\nbase_url = "http://127.0.0.1:15721/v1"\nwire_api = "responses"\n`;
    writeFileSync(join(claudeDir, 'settings.json'), claudeSettings);
    writeFileSync(join(codexHome, 'config.toml'), codexSettings);
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY', '0');
    const opened = await f.cmd<{ project: { id: string } }>('project.open', { path: f.project });
    const userMember = await f.cmd<{ memberId: string }>('member.create', { projectId: opened.project.id, displayName: '我的助手' });
    const discoveryCommandId = randomUUID();
    const first = await f.cmd<{ created: Array<{ kind: string }>; removedLegacyPlaceholder: boolean; notes: string[] }>(
      'member.discoverDefaults', { projectId: opened.project.id }, discoveryCommandId,
    );
    expect(first.created.map((item) => item.kind).sort(),JSON.stringify(first)).toEqual(['claude', 'codex']);
    expect(first.removedLegacyPlaceholder).toBe(true);
    expect(JSON.stringify(first)).not.toContain('fixture-secret');
    expect(Object.keys(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')))).toEqual(['env']);
    expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(codexSettings);
    const rows = f.db.prepare(`SELECT pm.id,pm.display_name,ri.kind,json_extract(ap.settings_json,'$.model') model
      FROM project_members pm LEFT JOIN agent_profiles ap ON ap.id=pm.profile_id
      LEFT JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id WHERE pm.project_id=? ORDER BY pm.id`).all(opened.project.id) as Array<{ id: string; display_name: string; kind: string | null; model: string | null }>;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: userMember.memberId, display_name: '我的助手', kind: null }),
      expect.objectContaining({ display_name: 'Claude', kind: 'claude', model: 'deepseek-flash' }),
      expect.objectContaining({ display_name: 'Codex', kind: 'codex', model: 'ccs-new/deepseek-flash' }),
    ]));
    expect(rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ display_name: '执行成员' })]));
    expect(rows).toHaveLength(3);
    expect(f.db.prepare('SELECT coordinator_member_id FROM rooms WHERE project_id=?').get(opened.project.id)).toEqual({
      coordinator_member_id: rows.find((row) => row.kind === 'claude')!.id,
    });
    const second = await f.cmd<{ created: unknown[]; existing: unknown[] }>('member.discoverDefaults', { projectId: opened.project.id });
    expect(second.created).toEqual([]);
    expect(second.existing).toHaveLength(2);
    const lateReplay = await f.raw('member.discoverDefaults', { projectId: opened.project.id }, discoveryCommandId);
    expect(lateReplay).toMatchObject({
      ok: true,
      replayed: true,
      data: { created: [{ kind: 'claude' }, { kind: 'codex' }] },
    });
    expect((f.db.prepare('SELECT count(*) count FROM project_members WHERE project_id=?').get(opened.project.id) as { count: number }).count).toBe(3);
    const otherDir = join(f.root, 'other');
    mkdirSync(otherDir);
    const other = await f.cmd<{ project: { id: string } }>('project.open', { path: otherDir });
    const isolated = await f.cmd<{ created: unknown[] }>('member.discoverDefaults', { projectId: other.project.id });
    expect(isolated.created).toHaveLength(2);
    expect(f.db.prepare('SELECT count(*) count FROM project_members WHERE project_id=?').get(other.project.id)).toEqual({ count: 2 });
    expect(f.db.prepare('SELECT count(*) count FROM project_members WHERE project_id=?').get(opened.project.id)).toEqual({ count: 3 });
    expect(f.db.prepare('SELECT count(*) count FROM tasks').get()).toEqual({ count: 0 });
    f.db.close();
    const reopened = openDatabase(join(f.root, 'state.sqlite'));
    databases.push(reopened);
    expect(reopened.prepare('SELECT count(*) count FROM project_members WHERE project_id=?').get(opened.project.id)).toEqual({ count: 3 });
    expect(reopened.prepare('SELECT count(*) count FROM project_members WHERE project_id=?').get(other.project.id)).toEqual({ count: 2 });
  });

  it('preserves a manually named member instead of replacing it with an automatic default', async () => {
    const f = await fixture();
    const claudeDir = join(f.root, 'claude');
    const codexHome = join(f.root, 'codex');
    mkdirSync(claudeDir);
    mkdirSync(codexHome);
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek-flash' } }));
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY', '0');
    const opened = await f.cmd<{ project: { id: string } }>('project.open', { path: f.project });
    const manual = await f.cmd<{ memberId: string }>('member.create', {
      projectId: opened.project.id,
      displayName: 'Claude',
      description: '手工配置，保留原名与说明',
    });
    const discovered = await f.cmd<{
      created: Array<{ kind: string }>;
      existing: Array<{ memberId: string; kind: string; displayName: string }>;
    }>('member.discoverDefaults', { projectId: opened.project.id });
    expect(discovered.created).toEqual([{ memberId: expect.any(String), kind: 'codex', displayName: 'Codex' }]);
    expect(discovered.existing).toEqual([{ memberId: manual.memberId, kind: 'claude', displayName: 'Claude' }]);
    expect(f.db.prepare('SELECT display_name,description FROM project_members WHERE id=?').get(manual.memberId)).toEqual({
      display_name: 'Claude',
      description: '手工配置，保留原名与说明',
    });
    expect(f.db.prepare("SELECT 1 FROM project_members WHERE id=?").get(`m_default_claude_${opened.project.id}`)).toBeUndefined();
  });

  it('keeps the legacy placeholder when a record-only DM depends on its identity', async () => {
    const f = await fixture();
    const claudeDir = join(f.root, 'claude');
    const codexHome = join(f.root, 'codex');
    mkdirSync(claudeDir);
    mkdirSync(codexHome);
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek-flash' } }));
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\n');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY', '0');
    const opened = await f.cmd<{ project: { id: string } }>('project.open', { path: f.project });
    const placeholderId = `m_default_${opened.project.id}_0`;
    const dm = await f.cmd<{ conversationId: string }>('conversation.create', {
      projectId: opened.project.id,
      peerMemberId: placeholderId,
      title: '仅记录私信',
    });
    await f.cmd('message.submit', {
      target: { kind: 'dm', projectId: opened.project.id, conversationId: dm.conversationId },
      body: '这条私人记录必须保留入口',
      intent: 'record_only',
      mentions: [],
    });
    const before = await f.cmd<{ conversations: Array<{ conversationId: string; peerMemberId: string }> }>('conversation.list', {
      projectId: opened.project.id,
    });
    expect(before.conversations).toContainEqual(expect.objectContaining({ conversationId: dm.conversationId, peerMemberId: placeholderId }));

    const discovered = await f.cmd<{ created: Array<{ kind: string }>; removedLegacyPlaceholder: boolean }>('member.discoverDefaults', {
      projectId: opened.project.id,
    });
    expect(discovered.created.map((item) => item.kind).sort()).toEqual(['claude', 'codex']);
    expect(discovered.removedLegacyPlaceholder).toBe(false);
    expect(f.db.prepare('SELECT display_name FROM project_members WHERE id=?').get(placeholderId)).toEqual({ display_name: '执行成员' });
    expect(f.db.prepare("SELECT principal_id FROM dm_participants WHERE conversation_id=? AND principal_type='agent'").get(dm.conversationId)).toEqual({
      principal_id: placeholderId,
    });
    expect((f.db.prepare('SELECT count(*) count FROM messages WHERE conversation_id=?').get(dm.conversationId) as { count: number }).count).toBe(1);
    const after = await f.cmd<{ conversations: Array<{ conversationId: string; peerMemberId: string }> }>('conversation.list', {
      projectId: opened.project.id,
    });
    expect(after.conversations).toContainEqual(expect.objectContaining({ conversationId: dm.conversationId, peerMemberId: placeholderId }));
  });

  it('auto-discovers during product project.open and keeps the same members on reopen', async () => {
    const f = await fixture();
    const claudeDir = join(f.root, 'claude');
    const codexHome = join(f.root, 'codex');
    mkdirSync(claudeDir);
    mkdirSync(codexHome);
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek-flash' } }));
    writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n');
    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY', '1');
    const savedVitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const opened = await f.cmd<{ project: { id: string }; created: boolean }>('project.open', { path: f.project });
      expect(opened.created).toBe(true);
      const rows = f.db.prepare(`SELECT pm.id,pm.display_name,ri.kind FROM project_members pm
        LEFT JOIN agent_profiles ap ON ap.id=pm.profile_id
        LEFT JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id
        WHERE pm.project_id=? ORDER BY pm.id`).all(opened.project.id) as Array<{ id: string; display_name: string; kind: string | null }>;
      expect(rows.map((row) => row.kind).sort()).toEqual(['claude', 'codex']);

      const reopened = await f.cmd<{ project: { id: string }; created: boolean }>('project.open', { path: f.project });
      expect(reopened).toMatchObject({ created: false, project: { id: opened.project.id } });
      expect(f.db.prepare('SELECT count(*) count FROM project_members WHERE project_id=?').get(opened.project.id)).toEqual({ count: 2 });
      expect(f.db.prepare('SELECT count(*) count FROM tasks').get()).toEqual({ count: 0 });
    } finally {
      if (savedVitest == null) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
    }
  });

  it('keeps the same project identity across relocate and reopening a removed project path', async () => {
    const f = await fixture();
    const opened = await f.cmd<{ project: { id: string; revision: number } }>('project.open', { path: f.project });
    const moved = join(f.root, 'moved-project');
    renameSync(f.project, moved);
    const relocated = await f.cmd<{ project: { id: string; revision: number } }>('project.lifecycle', {
      projectId: opened.project.id,
      expectedRevision: opened.project.revision,
      action: 'relocate',
      newRootPath: moved,
    });
    expect(relocated.project.id).toBe(opened.project.id);
    const reopened = await f.cmd<{ project: { id: string; revision: number }; created: boolean }>('project.open', { path: moved });
    expect(reopened).toMatchObject({ created: false, project: { id: opened.project.id } });
    const removed = await f.cmd<{ project: { revision: number } }>('project.lifecycle', {
      projectId: opened.project.id,
      expectedRevision: reopened.project.revision,
      action: 'remove',
    });
    const restored = await f.cmd<{ project: { id: string; revision: number }; created: boolean }>('project.open', { path: moved });
    expect(restored.project.id).toBe(opened.project.id);
    expect(restored.created).toBe(false);
    expect(restored.project.revision).toBeGreaterThan(removed.project.revision);
    expect((f.db.prepare('SELECT count(*) count FROM projects WHERE canonical_path=?').get(moved) as { count: number }).count).toBe(1);
    f.db.close();
  });
});
