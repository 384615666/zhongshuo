import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { effectiveTaskWriteAccess } from '../../src/daemon/projectWriteAccess.ts';
import { codexConfigurationIdentity,codexConfigurationIdentityV2 } from '../../src/adapter/codex/configuration.ts';
import { CLAUDE_PROJECT_WRITE_POLICY_HASH } from '../../src/adapter/writeCapability.ts';

type Mode = 'full' | 'scoped';
type RuntimeSnapshot = {
  memberId: string;
  bound: boolean;
  kind: string | null;
  model: string | null;
  installationId: string | null;
  permissionMode: string | null;
  executable: string | null;
  effort?: string | null;
};
type ScopeSnapshot = {
  executionMode?: 'full';
  authorized?: boolean;
  root: string;
  revision?: number;
  physicalIdentity?: string;
  memberRevision?: number;
  memberPermission?: string;
  runtime: RuntimeSnapshot;
  launchIdentity: string;
  launchFingerprintVersion?: number;
};
type Reply<T> = { ok: boolean; data: T; error?: { code: string; message: string } };

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const configText = [
  'model = "fixture-model"',
  'model_provider = "fixture-provider"',
  '[mcp_servers.fixture]',
  'command = "fixture-command"',
  '',
].join('\n');

afterEach(() => {
  vi.unstubAllEnvs();
});

/** HEAD's pre-R106 identity: exact raw file bytes plus the same bounded path/env set. */
function legacyCodexIdentityReference(cwd: string): string {
  const home = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  const paths = new Set([join(home, 'config.toml')]);
  let folder = resolve(cwd);
  for (let n = 0; n < 64; n += 1) {
    paths.add(join(folder, '.codex', 'config.toml'));
    if (dirname(folder) === folder) break;
    folder = dirname(folder);
    if (n === 63) throw Error('Codex 配置层级超出检查范围');
  }
  const facts = [...paths].map((path) => {
    try {
      const stat = statSync(path);
      if (stat.size > 1024 * 1024) throw Error('配置超过有界读取范围');
      return [path, digest(readFileSync(path))];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'absent'];
      throw error;
    }
  });
  const env = Object.entries(process.env)
    .filter(([key]) => /^(CODEX_|OPENAI_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return digest(JSON.stringify({ home, cwd: resolve(cwd), facts, env }));
}

async function createFixture(mode: Mode) {
  const root = mkdtempSync(join(tmpdir(), `zs-r106-codex-scope-${mode}-`));
  const project = join(root, 'project');
  const home = join(root, 'codex-home');
  const data = join(root, 'data');
  for (const path of [project, home, data]) mkdirSync(path, { recursive: true });
  const config = join(home, 'config.toml');
  writeFileSync(config, configText);
  vi.stubEnv('CODEX_HOME', home);

  const db = openDatabase(join(data, 'state.sqlite'));
  const raw = async <T>(method: string, params: unknown): Promise<Reply<T>> =>
    await dispatchDaemonCommand(
      { db, localUserId: 'u_r106_scope', appDataDir: data, interruptTurn: async () => {} },
      { protocolVersion: 1, commandId: randomUUID(), method, params },
    ) as Reply<T>;
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const reply = await raw<T>(method, params);
    expect(reply.ok, JSON.stringify(reply.error)).toBe(true);
    return reply.data;
  };

  const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: project })).project.id;
  const memberId = (await cmd<{ memberId: string }>('member.create', {
    projectId,
    displayName: 'R106 Codex',
  })).memberId;
  await cmd('member.setRuntime', {
    memberId,
    kind: 'codex',
    model: 'fixture-model',
    permissionMode: mode === 'full' ? 'bypassPermissions' : 'acceptEdits',
  });
  if (mode === 'scoped') {
    await cmd('project.writeAccess.set', { projectId, expectedRevision: 0, authorized: true });
  }
  vi.stubEnv('ZS_REAL_DISPATCH_GUARD', '1');

  const room = (await cmd<{ items: Array<{ id: string; conversationId: string }> }>('room.list', { projectId })).items[0]!;
  const submitted = await cmd<{ taskId: string }>('message.submit', {
    target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
    body: `R106 ${mode} legacy Codex scope compatibility`,
    intent: 'default',
    mentions: [{ kind: 'member', memberId }],
  });

  expect(db.prepare('SELECT count(*) n FROM real_calls').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) n FROM agent_turns').get()).toEqual({ n: 0 });

  const close = () => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  const storedScope = () => {
    const row = db.prepare('SELECT write_scope_json FROM tasks WHERE id=?').get(submitted.taskId) as
      | { write_scope_json: string }
      | undefined;
    if (row == null) throw Error('formal task scope missing');
    return row;
  };
  const readScope = (): ScopeSnapshot => JSON.parse(storedScope().write_scope_json) as ScopeSnapshot;
  const writeScope = (scope: ScopeSnapshot) => {
    db.prepare('UPDATE tasks SET write_scope_json=? WHERE id=?').run(JSON.stringify(scope), submitted.taskId);
  };
  const legacyScope = (version:1|2=1): ScopeSnapshot => {
    const scope = readScope();
    const configurationKey = version===2?codexConfigurationIdentityV2(project):legacyCodexIdentityReference(project);
    const root = realpathSync.native(project);
    const launchIdentity = mode === 'full'
      ? digest(JSON.stringify({
        projectId,
        root,
        runtime: scope.runtime,
        mode: 'full',
        configuration: configurationKey,
      }))
      : (() => {
        const grantRow = db.prepare(
          'SELECT authorized,canonical_root,revision,physical_identity FROM project_write_authorizations WHERE project_id=?',
        ).get(projectId) as {
          authorized: number;
          canonical_root: string;
          revision: number;
          physical_identity: string;
        };
        const grant = {
          authorized: grantRow.authorized === 1,
          root: grantRow.canonical_root,
          revision: grantRow.revision,
          physicalIdentity: grantRow.physical_identity,
        };
        return digest(JSON.stringify({
          projectId,
          grant,
          snapshot: {
            authorized: scope.authorized,
            root: scope.root,
            revision: scope.revision,
            memberRevision: scope.memberRevision,
            memberPermission: scope.memberPermission,
          },
          root,
          runtime: scope.runtime,
          configurationKey,
          writable: true,
          writePolicyHash: CLAUDE_PROJECT_WRITE_POLICY_HASH,
        }));
      })();
    const legacy = { ...scope, launchIdentity };
    if(version===2)legacy.launchFingerprintVersion=2;
    else delete legacy.launchFingerprintVersion;
    return legacy;
  };

  return {
    db,
    root,
    project,
    home,
    config,
    projectId,
    memberId,
    taskId: submitted.taskId,
    close,
    storedScope,
    readScope,
    writeScope,
    legacyScope,
  };
}

describe('R106 Codex v1 scope compatibility through formal task persistence', () => {
  it.each(['full','scoped'] as const)('%s keeps a v2 snapshot immutable, including its stricter array/trust comparison',async mode=>{
    const f=await createFixture(mode);
    try{
      const base=configText+'\n[[skills.config]]\npath = "fixture-skill"\nenabled = true\n';
      writeFileSync(f.config,base);f.writeScope(f.legacyScope(2));
      const saved=f.storedScope().write_scope_json;
      expect(effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null).modificationAuthorized).toBe(true);
      expect(f.storedScope().write_scope_json).toBe(saved);
      const other=join(f.root,'other');mkdirSync(other);
      writeFileSync(f.config,`${base}\n[projects."${other.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
      expect(()=>effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null)).toThrow(/已变化/);
      expect(f.storedScope().write_scope_json).toBe(saved);
    }finally{f.close();}
  });

  it.each(['full','scoped'] as const)('%s v3 task survives unrelated trust initialization with configured skills',async mode=>{
    const f=await createFixture(mode);
    try{
      const base=configText+'\n[[skills.config]]\npath = "fixture-skill"\nenabled = true\n';
      writeFileSync(f.config,base);
      // Explicitly authorize the current configuration, as a new send does.
      const scope=f.readScope(),configuration=codexConfigurationIdentity(f.project);
      const v2=f.legacyScope(2);
      // Reuse the same frozen scope fields with the new-version digest.
      if(mode==='full')scope.launchIdentity=digest(JSON.stringify({projectId:f.projectId,root:scope.root,runtime:scope.runtime,mode:'full',configuration}));
      else {
        // scoped digest is obtained from the actual access computation without a prior launch identity.
        const fresh={...scope} as Partial<ScopeSnapshot>;delete fresh.launchIdentity;
        scope.launchIdentity=effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null,JSON.stringify(fresh)).identityKey;
      }
      f.writeScope(scope);const saved=f.storedScope().write_scope_json;
      const other=join(f.root,'other');mkdirSync(other);
      writeFileSync(f.config,`${base}\n[projects."${other.replaceAll('\\','\\\\')}"]\ntrust_level = "trusted"\n`);
      expect(effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null).modificationAuthorized).toBe(true);
      expect(()=>effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null,JSON.stringify(v2))).toThrow(/已变化/);
      writeFileSync(f.config,base.replace('enabled = true','enabled = false'));
      expect(()=>effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null)).toThrow(/已变化/);
      expect(f.storedScope().write_scope_json).toBe(saved);
    }finally{f.close();}
  });
  it.each(['full','scoped'] as const)('%s explicitly versioned v1 also uses the exact old comparison',async mode=>{
    const f=await createFixture(mode);
    try{
      f.writeScope({...f.legacyScope(),launchFingerprintVersion:1});
      const before=f.storedScope().write_scope_json;
      expect(effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null).modificationAuthorized).toBe(true);
      expect(f.storedScope().write_scope_json).toBe(before);
      writeFileSync(f.config,configText.replace('model_provider = "fixture-provider"','model_provider = "changed-provider"'));
      expect(()=>effectiveTaskWriteAccess(f.db,f.taskId,f.memberId,null)).toThrow(/已变化/);
    }finally{f.close();}
  });
  it.each(['full', 'scoped'] as const)(
    '%s legacy scope remains usable while the DB scope stays byte-for-byte unchanged',
    async (mode) => {
      const f = await createFixture(mode);
      try {
        f.writeScope(f.legacyScope());
        const before = f.storedScope().write_scope_json;
        const access = effectiveTaskWriteAccess(f.db, f.taskId, f.memberId, null);
        expect(access.fullAccess).toBe(mode === 'full');
        expect(access.modificationAuthorized).toBe(true);
        expect(access.identityKey).not.toBe((JSON.parse(before) as ScopeSnapshot).launchIdentity);
        expect(f.storedScope().write_scope_json).toBe(before);
      } finally {
        f.close();
      }
    },
  );

  it.each([
    ['full', 'provider'],
    ['full', 'model'],
    ['full', 'mcp'],
    ['full', 'env'],
    ['scoped', 'provider'],
    ['scoped', 'model'],
    ['scoped', 'mcp'],
    ['scoped', 'env'],
  ] as const)('%s legacy scope rejects a real %s change and preserves the stored scope', async (mode, change) => {
    const f = await createFixture(mode);
    try {
      f.writeScope(f.legacyScope());
      const before = f.storedScope().write_scope_json;
      if (change === 'env') {
        vi.stubEnv('CODEX_R106_SCOPE_FIXTURE', 'changed');
      } else {
        const changed = change === 'provider'
          ? configText.replace('model_provider = "fixture-provider"', 'model_provider = "changed-provider"')
          : change === 'model'
            ? configText.replace('model = "fixture-model"', 'model = "changed-model"')
            : configText.replace('command = "fixture-command"', 'command = "changed-command"');
        writeFileSync(f.config, changed);
      }
      expect(() => effectiveTaskWriteAccess(f.db, f.taskId, f.memberId, null)).toThrow(/已变化/);
      expect(f.storedScope().write_scope_json).toBe(before);
    } finally {
      f.close();
    }
  });

  it.each(['full', 'scoped'] as const)(
    '%s legacy scope cannot adopt a v2-equal configuration after a v1-visible unrelated trust append',
    async (mode) => {
      const f = await createFixture(mode);
      try {
        f.writeScope(f.legacyScope());
        const before = f.storedScope().write_scope_json;
        const v2Before = codexConfigurationIdentity(f.project);
        const other = join(f.root, 'unrelated-project');
        mkdirSync(other);
        writeFileSync(
          f.config,
          `${configText}\n[projects."${other.replaceAll('\\', '\\\\')}"]\ntrust_level = "trusted"\n`,
        );
        expect(codexConfigurationIdentity(f.project)).toBe(v2Before);
        expect(() => effectiveTaskWriteAccess(f.db, f.taskId, f.memberId, null)).toThrow(/已变化/);
        expect(f.storedScope().write_scope_json).toBe(before);
      } finally {
        f.close();
      }
    },
  );

  it.each(['full', 'scoped'] as const)(
    '%s newly submitted Codex task opts into v3 and validates normally',
    (mode) => {
      return createFixture(mode).then((f) => {
        try {
          const scope = f.readScope();
          const before = f.storedScope().write_scope_json;
          expect(scope.launchFingerprintVersion).toBe(3);
          expect(scope.launchIdentity).toMatch(/^[a-f0-9]{64}$/);
          const access = effectiveTaskWriteAccess(f.db, f.taskId, f.memberId, null);
          expect(access.fullAccess).toBe(mode === 'full');
          expect(f.storedScope().write_scope_json).toBe(before);
        } finally {
          f.close();
        }
      });
    },
  );

  it.each(['full', 'scoped'] as const)('%s explicit unknown fingerprint version is rejected unchanged', async (mode) => {
    const f = await createFixture(mode);
    try {
      const scope = f.readScope();
      scope.launchFingerprintVersion = 99;
      f.writeScope(scope);
      const before = f.storedScope().write_scope_json;
      expect(() => effectiveTaskWriteAccess(f.db, f.taskId, f.memberId, null))
        .toThrow('执行配置指纹版本不受支持');
      expect(f.storedScope().write_scope_json).toBe(before);
    } finally {
      f.close();
    }
  });
});
