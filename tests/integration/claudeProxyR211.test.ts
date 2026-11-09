import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeConfiguration } from '../../src/adapter/claude/configuration.ts';
import { ClaudeCliAdapter, claudeLaunchIdentity } from '../../src/adapter/claude/cliAdapter.ts';
import { claudeModelCatalog } from '../../src/daemon/runtimeCatalog.ts';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs-r211-proxy-'));
  roots.push(root);
  const cwd = join(root, 'project'), user = join(root, 'config');
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  mkdirSync(user);
  const settings = join(user, 'settings.json');
  writeFileSync(settings, '{}');
  const env = { CLAUDE_CONFIG_DIR: user, ANTHROPIC_BASE_URL: 'https://provider.example.test/v1' };
  return { root, cwd, user, settings, env };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('R211 Claude transport proxy is not provider or host takeover', () => {
  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'])('accepts supported HTTP(S) transport in %s and preserves it', key => {
    const f = fixture();
    const inherited: NodeJS.ProcessEnv = { ...f.env, [key]: 'http://127.0.0.1:7890' };
    const config = resolveClaudeConfiguration(f.cwd, [], inherited);
    expect(config.reason).toBeNull();
    expect(config.channel).toBe('https://provider.example.test/v1');
    expect(config.env[key]).toBe(inherited[key]);
    expect(config.restrictedEnv[key]).toBe(inherited[key]);
    expect(inherited[key]).toBe('http://127.0.0.1:7890');
  });

  it('accepts a user-settings HTTPS proxy with basic authentication without exposing its value', () => {
    const f = fixture(), proxy = 'https://fixture-user:fixture-password@proxy.example.test:8443';
    writeFileSync(f.settings, JSON.stringify({ env: { HTTPS_PROXY: proxy } }));
    const config = resolveClaudeConfiguration(f.cwd, [], f.env);
    expect(config.reason).toBeNull();
    expect(config.restrictedEnv.HTTPS_PROXY).toBe(proxy);
    expect(config.env.HTTPS_PROXY).toBeUndefined();
    expect(JSON.stringify(config.configurationEvidence)).not.toContain('fixture-password');
  });

  it('does not mistake ALL_PROXY for a provider switch or claim it is an officially supported CLI proxy', () => {
    const f = fixture(), env = { ...f.env, ALL_PROXY: 'socks5://127.0.0.1:1080', HTTPS_PROXY: 'http://127.0.0.1:7890' };
    const config = resolveClaudeConfiguration(f.cwd, [], env);
    expect(config.reason).toBeNull();
    expect(config.env.ALL_PROXY).toBe(env.ALL_PROXY);
    expect(config.restrictedEnv.HTTPS_PROXY).toBe(env.HTTPS_PROXY);
  });

  it.each(['1', 'socks5://proxy.example.test:1080', 'file:///tmp/proxy', 'https://proxy.example.test/?private=query'])('rejects invalid or unsupported HTTP proxy syntax without echoing it: %s', value => {
    const f = fixture(), config = resolveClaudeConfiguration(f.cwd, [], { ...f.env, HTTPS_PROXY: value });
    expect(config.reason).toContain('HTTPS_PROXY');
    expect(config.reason).not.toContain(value);
  });

  it('keeps proxies fingerprinted without changing the v3 fingerprint algorithm', () => {
    const f = fixture(), env = { ...f.env, HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'http://127.0.0.1:7890' };
    const before = resolveClaudeConfiguration(f.cwd, [], env);
    expect(before.reason).toBeNull();
    expect(before.configurationEvidenceVersion).toBe('claude-configuration-v3');
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const) {
      const changed = resolveClaudeConfiguration(f.cwd, [], { ...env, [key]: 'http://127.0.0.1:7891' });
      expect(changed.configurationKey).not.toBe(before.configurationKey);
      expect(changed.configurationEvidence['渠道环境']).not.toBe(before.configurationEvidence['渠道环境']);
    }
    expect(resolveClaudeConfiguration(f.cwd, [], env).configurationKey).toBe(before.configurationKey);
  });

  it('continues to reject unresolved provider/host switches and project trust overrides', () => {
    const f = fixture();
    for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_PROCESS_WRAPPER']) {
      expect(resolveClaudeConfiguration(f.cwd, [], { ...f.env, [key]: '1' }).reason).toContain(key);
    }
    writeFileSync(join(f.cwd, '.claude', 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } }));
    expect(resolveClaudeConfiguration(f.cwd, [], f.env).reason).toContain('渠道覆盖');
  });

  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'])('rejects a queued launch after %s changes, before spawning a child', async key => {
    const f = fixture();
    vi.stubEnv('CLAUDE_CONFIG_DIR', f.user);
    vi.stubEnv(key, 'http://127.0.0.1:7890');
    const executable = join(f.root, 'unused.cjs');
    writeFileSync(executable, '// fingerprint fixture, never executed');
    const options = { executable, model: 'fixture-model' };
    const identity = claudeLaunchIdentity(options, f.cwd);
    let spawns = 0;
    const adapter = new ClaudeCliAdapter(options, () => { spawns++; throw Error('unexpected spawn'); });
    const session = await adapter.openSession({ projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th', sessionGeneration: 0,
      cwd: f.cwd, policyId: 'policy-full-access', writeAccess: { fullAccess: true, modificationAuthorized: true,
        allowedWriteRoots: [], identityKey: 'fixture', launchConfigurationKey: identity.identityKey } });
    try {
      vi.stubEnv(key, 'http://127.0.0.1:7891');
      await expect(adapter.startTurn(session, { turnId: 'turn', dispatchKey: 'dispatch', inputBundleId: 'bundle', text: 'fixture',
        policyId: 'policy-full-access', taskRevision: 0 })).rejects.toThrow('启动配置已变化');
      expect(spawns).toBe(0);
    } finally { await adapter.close(session); }
  });

  it.each(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'https_proxy', 'all_proxy'])('never bypasses %s to query the metadata endpoint directly', async proxyKey => {
    const f = fixture();
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) vi.stubEnv(key, undefined);
    vi.stubEnv('CLAUDE_CONFIG_DIR', f.user);
    writeFileSync(f.settings, JSON.stringify({ model: 'fixture-model', env: {
      ANTHROPIC_BASE_URL: 'https://provider.example.test/v1', ANTHROPIC_AUTH_TOKEN: 'fixture-secret',
      [proxyKey]: 'http://127.0.0.1:7890',
    } }));
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(resolveClaudeConfiguration(f.cwd).reason).toBeNull();
    const result = await claudeModelCatalog(f.cwd);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.models).toContainEqual({ id: 'fixture-model', label: 'fixture-model', source: 'configured' });
    expect(result.warning).toContain('代理');
    expect(result.warning).not.toContain('有效渠道尚不能确定');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });

  it('passes proxies through a real local restricted CLI child without blocking execution or changing host settings', async () => {
    const f = fixture();
    const proxies = { HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', ALL_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1' };
    vi.stubEnv('CLAUDE_CONFIG_DIR', f.user);
    for (const [key, value] of Object.entries(proxies)) vi.stubEnv(key, value);
    const executable = join(f.root, 'local-cli.cjs');
    writeFileSync(executable, `process.stdin.resume();
process.stdin.on('end', () => {
  const expected = ${JSON.stringify(proxies)};
  const intact = Object.entries(expected).every(([key,value]) => process.env[key] === value);
  console.log(JSON.stringify({type:'result',subtype:'success',session_id:'fixture-session',result:intact?'proxies-preserved':'proxy-mismatch'}));
});`);
    const options = { executable, model: 'fixture-model', permissionMode: 'dontAsk' as const };
    const identity = claudeLaunchIdentity(options, f.cwd);
    expect(identity.reason).toBeNull();
    const adapter = new ClaudeCliAdapter(options);
    const session = await adapter.openSession({ projectId: 'p', memberId: 'm', taskId: 't', threadId: 'th', sessionGeneration: 0,
      cwd: f.cwd, policyId: 'policy-project-write', writeAccess: { fullAccess: false, modificationAuthorized: true,
        allowedWriteRoots: [f.cwd], identityKey: 'fixture', launchConfigurationKey: identity.identityKey } });
    try {
      await adapter.startTurn(session, { turnId: 'turn', dispatchKey: 'dispatch', inputBundleId: 'bundle', text: 'local fixture only',
        policyId: 'policy-project-write', taskRevision: 0 });
      let finalText: string | undefined;
      for await (const event of adapter.events(session)) {
        if (event.kind === 'turn.failed') throw Error(event.message);
        if (event.kind === 'turn.completed') { finalText = event.finalText; break; }
      }
      expect(finalText).toBe('proxies-preserved');
      for (const [key, value] of Object.entries(proxies)) expect(process.env[key]).toBe(value);
    } finally { await adapter.close(session); }
  });
});
