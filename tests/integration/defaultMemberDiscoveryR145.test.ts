import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as claudeConfiguration from '../../src/adapter/claude/configuration.ts';
import { discoverLocalMemberDefaults, ensureDefaultMembers } from '../../src/daemon/defaultMembers.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import * as cliEnvironment from '../../src/daemon/cliEnvironment.ts';

const realRefreshPath = cliEnvironment.refreshCliSearchPath;

const roots: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs-r145-discovery-')); roots.push(root);
  const bin = join(root, 'bin'), project = join(root, 'project'), dshHome = join(root, 'dsh');
  for (const dir of [bin, project, dshHome]) mkdirSync(dir);
  for (const name of ['ZS_CLAUDE_MODEL', 'ZS_E2E_MODEL', 'ZS_PI_MODEL', 'ZS_DSH_MODEL', 'ZS_BOOTSTRAP_AGENTS', 'ZS_REAL_DISPATCH_GUARD']) vi.stubEnv(name, undefined);
  vi.stubEnv('PATH', bin); vi.stubEnv('APPDATA', join(root, 'appdata'));
  vi.stubEnv('CODEX_HOME', join(root, 'codex')); vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi')); vi.stubEnv('DSH_HOME', dshHome);
  vi.stubEnv('ZS_DEFAULT_MEMBER_DISCOVERY', '1');
  const persistedPaths: string[] = [];
  vi.spyOn(cliEnvironment, 'refreshCliSearchPath').mockImplementation(() => realRefreshPath(() => persistedPaths));
  // Routing/trust resolution has its own regression suite. Keep discovery tests
  // independent of the developer's registry policies and logged-in providers.
  vi.spyOn(claudeConfiguration, 'resolveClaudeConfiguration').mockReturnValue({
    restrictedEnv: { ANTHROPIC_MODEL: 'fixture-claude' }, reason: null,
  } as unknown as ReturnType<typeof claudeConfiguration.resolveClaudeConfiguration>);
  const install = (kind: 'claude' | 'codex' | 'pi' | 'deepseek-harness') => {
    if (kind === 'claude' && process.platform === 'win32') {
      const native = join(root, 'appdata', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
      mkdirSync(native, {recursive: true}); writeFileSync(join(native, 'claude.exe'), 'never execute');
    } else if (kind === 'codex') {
      writeFileSync(join(bin, 'codex.js'), 'throw Error("discovery must not execute CLI");');
      writeFileSync(join(bin, 'codex.cmd'), `node "${join(bin, 'codex.js')}"`);
      mkdirSync(join(root, 'codex'), {recursive: true}); writeFileSync(join(root, 'codex', 'config.toml'), 'model = "fixture-codex"\n');
    } else {
      const name = kind === 'deepseek-harness' ? 'dsh' : kind;
      writeFileSync(join(bin, name + '.cjs'), 'throw Error("discovery must not execute CLI");');
      writeFileSync(join(bin, name + '.cmd'), `@node "%~dp0${name}.cjs" %*`);
      if (process.platform !== 'win32') writeFileSync(join(bin, name), 'never execute');
    }
  };
  const connector = () => {
    const dir = join(dshHome, 'profiles', 'zhongshuo', 'node_modules', '@zhongshuo', 'dsh-runtime');
    mkdirSync(dir, {recursive: true});
    for (const name of ['package.json', 'index.mjs', 'backend.mjs', 'protocol.mjs']) writeFileSync(join(dir, name), name === 'package.json' ? '{}' : 'never execute');
  };
  const db = openDatabase(':memory:'); databases.push(db);
  const raw = async (method: string, params: unknown, commandId = randomUUID()) =>
    await dispatchDaemonCommand({db, localUserId: 'r145', appDataDir: join(root, 'data'), interruptTurn: async () => {}},
      {protocolVersion: 1, commandId, method, params}) as {ok: boolean; error?: {message: string}; data: Record<string, unknown>; replayed?: boolean};
  const command = async (method: string, params: unknown, commandId = randomUUID()) => {
    const response = await raw(method, params, commandId);
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return response as {ok: true; data: Record<string, unknown>; replayed?: boolean};
  };
  return {root, bin, project, install, connector, db, command, raw, persistedPaths};
}

describe('R145 installed CLI discovery', () => {
  it.skipIf(process.platform !== 'win32')('R211 reports an incomplete Claude native installation instead of creating a runnable default member', () => {
    const f = fixture();
    f.install('claude');
    const executable = join(f.root, 'appdata/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
    writeFileSync(executable, 'echo "Error: claude native binary not installed." >&2\nexit 1\n');
    const result = discoverLocalMemberDefaults(f.project);
    expect(result.candidates.some(candidate => candidate.kind === 'claude')).toBe(false);
    expect(result.notes).toContainEqual(expect.stringContaining('Claude CLI 安装不完整'));
  });

  it('R146 discovers a CLI installed into a newly added Windows PATH while the daemon keeps running', async () => {
    const f = fixture();
    const first = await f.command('project.ensureDefault', {});
    const projectId = (first.data.project as {id: string}).id;
    expect(first.data.availableAgentCount).toBe(0);
    f.install('pi');
    const newBin = join(f.root, 'new installer bin'); mkdirSync(newBin);
    for (const file of ['pi.cmd', 'pi.cjs', ...(process.platform === 'win32' ? [] : ['pi'])]) renameSync(join(f.bin, file), join(newBin, file));
    expect(process.env.PATH).not.toContain(newBin);
    f.persistedPaths.push(newBin);
    const scan = await f.command('member.discoverDefaults', {projectId});
    expect(scan.data.created).toMatchObject([{kind: 'pi'}]);
    expect(process.env.PATH).toContain(newBin);
    const again = await f.command('member.discoverDefaults', {projectId});
    expect(again.data.created).toEqual([]);
    expect(again.data.existing).toHaveLength(1);
  });

  it('R146 repairs the original empty room after first discovering an installed CLI in a new room', async () => {
    const f = fixture();
    const first = await f.command('project.ensureDefault', {});
    const projectId = (first.data.project as {id: string}).id;
    const oldRoom = f.db.prepare('SELECT id FROM rooms').get() as {id: string};
    f.install('pi');
    await f.command('room.create', {projectId, name: '安装后的新房间'});
    await f.command('member.discoverDefaults', {projectId});
    const ready = f.db.prepare(`SELECT r.coordinator_member_id,rm.member_id FROM rooms r
      JOIN room_members rm ON rm.room_id=r.id AND rm.member_id=r.coordinator_member_id
      JOIN project_members pm ON pm.id=rm.member_id WHERE r.id=? AND pm.enabled=1`).get(oldRoom.id);
    expect(ready).toBeDefined();
  });

  it.each(['claude', 'codex', 'deepseek-harness', 'pi'] as const)('R146 %s uninstall preserves history/config and refuses new dispatch; reinstall reuses identity', async kind => {
    const f = fixture(); f.install(kind); if (kind === 'deepseek-harness') f.connector();
    const first = await f.command('project.ensureDefault', {});
    const projectId = (first.data.project as {id: string}).id;
    const room = f.db.prepare('SELECT r.id,c.id conversationId FROM rooms r JOIN conversations c ON c.room_id=r.id').get() as {id: string; conversationId: string};
    const member = f.db.prepare('SELECT id,profile_id,settings_revision FROM project_members WHERE enabled=1').get() as {id: string};
    const snapshot = f.db.prepare('SELECT * FROM project_members WHERE id=?').get(member.id);
    const message = {target: {kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId}, body: '卸载后必须保留的原记录', intent: 'record_only', mentions: []};
    const recordedId = randomUUID(); await f.command('message.submit', message, recordedId);
    const entry = kind === 'claude' && process.platform === 'win32' ? join(f.root, 'appdata/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe') : join(f.bin, kind === 'codex' ? 'codex.js' : kind === 'deepseek-harness' ? 'dsh.cjs' : 'pi.cjs');
    unlinkSync(entry);
    const absent = await f.command('member.runtime', {memberId: member.id});
    expect(absent.data.executableStatus).toMatchObject({status: 'missing'});
    await f.command('member.discoverDefaults', {projectId});
    expect(f.db.prepare('SELECT * FROM project_members WHERE id=?').get(member.id)).toEqual(snapshot);
    const failed = await f.raw('message.submit', {...message, intent: 'default', body: 'CLI 已卸载，不能派发', mentions: [{kind: 'member', memberId: member.id}]});
    expect(failed.ok).toBe(false);
    expect(failed.error?.message).toMatch(/程序|CLI|执行/);
    expect(f.db.prepare('SELECT count(*) n FROM messages').get()).toEqual({n: 1});
    expect(f.db.prepare('SELECT count(*) n FROM tasks').get()).toEqual({n: 0});
    expect((await f.command('message.submit', message, recordedId)).replayed).toBe(true);
    const newRoom = await f.command('room.create', {projectId, name: '卸载后的房间'});
    const unavailableRoster = await f.command('member.list', {projectId, roomId: (newRoom.data.room as {id: string}).id});
    expect(unavailableRoster.data.items).toMatchObject([{id: member.id, runtimeAvailable: false}]);
    f.install(kind);
    const scan = await f.command('member.discoverDefaults', {projectId});
    expect(scan.data.created).toEqual([]);
    expect(scan.data.existing).toMatchObject([{memberId: member.id, kind}]);
    expect((await f.command('member.runtime', {memberId: member.id})).data.executableStatus).toMatchObject({status: 'found'});
    expect(f.db.prepare('SELECT * FROM project_members WHERE id=?').get(member.id)).toEqual(snapshot);
    expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n: 0});
  });

  it('starts with no enabled AI or false Claude/Codex binding when no CLI is installed', async () => {
    const f = fixture();
    expect(discoverLocalMemberDefaults(f.project).candidates).toEqual([]);
    const result = await f.command('project.ensureDefault', {});
    expect(result.data.availableAgentCount).toBe(0);
    expect(f.db.prepare("SELECT count(*) n FROM project_members WHERE enabled=1").get()).toEqual({n: 0});
    expect(f.db.prepare('SELECT count(*) n FROM runtime_installations').get()).toEqual({n: 0});
    const projectId = (result.data.project as {id: string}).id;
    await f.command('room.create', {projectId, name: '没有 CLI 也能建房'});
    await f.command('room.create', {projectId, name: '空名单房间', memberIds: []});
    expect(f.db.prepare('SELECT count(*) n FROM rooms').get()).toEqual({n: 3});
    expect(f.db.prepare('SELECT count(*) n FROM project_members WHERE enabled=1').get()).toEqual({n: 0});
  });

  it('discovers Pi alone and delegates model selection to its configured CLI default', async () => {
    const f = fixture(); f.install('pi');
    const found = discoverLocalMemberDefaults(f.project);
    expect(found.candidates).toMatchObject([{kind: 'pi', config: {model: null, executable: 'pi'}}]);
    const result = await f.command('project.ensureDefault', {});
    expect(result.data.availableAgentCount).toBe(1);
    expect(f.db.prepare('SELECT kind FROM runtime_installations').all()).toEqual([{kind: 'pi'}]);
    expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n: 0});
  });

  it('explains an installed Claude with no resolvable model instead of inventing a model', () => {
    const f = fixture(); f.install('claude');
    vi.mocked(claudeConfiguration.resolveClaudeConfiguration).mockReturnValue({restrictedEnv: {}, reason: null} as unknown as ReturnType<typeof claudeConfiguration.resolveClaudeConfiguration>);
    const found = discoverLocalMemberDefaults(f.project);
    expect(found.candidates).toEqual([]);
    expect(found.notes.join(' ')).toContain('未能确定默认模型');
  });

  it('finds a native Codex installation on PATH even when no npm shim exists', () => {
    const f = fixture();
    writeFileSync(join(f.bin, process.platform === 'win32' ? 'codex.exe' : 'codex'), 'never execute');
    mkdirSync(join(f.root, 'codex')); writeFileSync(join(f.root, 'codex', 'config.toml'), 'model = "native-codex-model"\n');
    expect(discoverLocalMemberDefaults(f.project).candidates).toMatchObject([{kind: 'codex', config: {model: 'native-codex-model'}}]);
  });

  it('does not discover or add local channels through remote project/room creation', async () => {
    const f = fixture(); f.install('pi');
    const remote = async (method: string, params: unknown) => await dispatchDaemonCommand({db: f.db, localUserId: 'r145',
      appDataDir: join(f.root, 'data'), remoteAudit: {deviceId: 'remote', authEpoch: 1}, interruptTurn: async () => {}},
    {protocolVersion: 1, commandId: randomUUID(), method, params}) as {ok: boolean; data: {project: {id: string}}};
    const opened = await remote('project.open', {path: f.project});
    expect(opened.ok).toBe(true);
    expect((await remote('room.create', {projectId: opened.data.project.id, name: '远程新房间'})).ok).toBe(true);
    expect(f.db.prepare('SELECT count(*) n FROM runtime_installations').get()).toEqual({n: 0});
    expect(claudeConfiguration.resolveClaudeConfiguration).not.toHaveBeenCalled();
  });

  it('requires the Harness connector and discovers every supported installed channel without executing it', () => {
    const f = fixture();
    for (const kind of ['claude', 'codex', 'deepseek-harness', 'pi'] as const) f.install(kind);
    expect(discoverLocalMemberDefaults(f.project).notes.join(' ')).toContain('连接组件');
    expect(discoverLocalMemberDefaults(f.project).candidates.map(item => item.kind)).not.toContain('deepseek-harness');
    f.connector();
    expect(discoverLocalMemberDefaults(f.project).candidates.map(item => item.kind)).toEqual(['claude', 'codex', 'deepseek-harness', 'pi']);
  });

  it('rescans at room creation, preserves existing room membership, and replays without duplicate members or rooms', async () => {
    const f = fixture();
    const opened = await f.command('project.open', {path: f.project});
    const projectId = (opened.data.project as {id: string}).id;
    const manual = await f.command('member.create', {projectId, displayName: '自定义 AI'});
    const originalRoom = f.db.prepare('SELECT id FROM rooms').get() as {id: string};
    const originalMembers = f.db.prepare('SELECT member_id FROM room_members WHERE room_id=?').all(originalRoom.id);
    f.install('pi');
    const commandId = randomUUID();
    const created = await f.command('room.create', {projectId, name: '新房间'}, commandId);
    expect(created.data.discovery).toMatchObject({created: ['pi']});
    const roomId = (created.data.room as {id: string}).id;
    expect(f.db.prepare(`SELECT ri.kind FROM room_members rm JOIN project_members pm ON pm.id=rm.member_id
      JOIN agent_profiles ap ON ap.id=pm.profile_id JOIN runtime_installations ri ON ri.id=ap.runtime_installation_id WHERE rm.room_id=?`).all(roomId)).toEqual([{kind: 'pi'}]);
    expect(f.db.prepare('SELECT member_id FROM room_members WHERE room_id=?').all(originalRoom.id)).toEqual(originalMembers);
    expect(f.db.prepare('SELECT display_name,profile_id FROM project_members WHERE id=?').get(manual.data.memberId))
      .toEqual({display_name: '自定义 AI', profile_id: null});
    expect((await f.command('room.create', {projectId, name: '新房间'}, commandId)).replayed).toBe(true);
    expect(f.db.prepare('SELECT count(*) n FROM rooms').get()).toEqual({n: 2});
    expect(f.db.prepare("SELECT count(*) n FROM runtime_installations WHERE kind='pi'").get()).toEqual({n: 1});
    expect(f.db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({n: 0});
  });

  it('honors an explicit room roster and preserves an existing disabled/configured member', async () => {
    const f = fixture();
    const opened = await f.command('project.open', {path: f.project});
    const projectId = (opened.data.project as {id: string}).id;
    const manual = await f.command('member.create', {projectId, displayName: 'Pi'});
    f.install('pi');
    const created = await f.command('room.create', {projectId, name: '手选名单', memberIds: [manual.data.memberId]});
    expect(created.data.discovery).toBeUndefined();
    expect(f.db.prepare('SELECT count(*) n FROM runtime_installations').get()).toEqual({n: 0});
    const candidate = discoverLocalMemberDefaults(f.project).candidates[0]!;
    f.db.prepare('UPDATE project_members SET enabled=0 WHERE id=?').run(manual.data.memberId);
    expect(ensureDefaultMembers(f.db, projectId, [candidate]).created).toEqual([]);
    expect(f.db.prepare('SELECT enabled,profile_id FROM project_members WHERE id=?').get(manual.data.memberId)).toEqual({enabled: 0, profile_id: null});
  });
});
