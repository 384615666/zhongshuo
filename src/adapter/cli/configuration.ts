import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveAgentExecutable, type ExternalRuntimeKind } from './executable.ts';

export interface ExternalRuntimeOptions { executable?: string; model?: string; effort?: string; permissionMode?: string }
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stamps = new Map<string, { stamp: string; hash: string }>();
function fileDigest(path: string): string {
  if (!existsSync(path)) return 'absent';
  const stat = statSync(path);
  if (!stat.isFile()) throw Error('运行配置不是文件');
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const prior = stamps.get(path);
  if (prior?.stamp === stamp) return prior.hash;
  const hash = digest(readFileSync(path)); stamps.set(path, { stamp, hash }); return hash;
}
/** Digests bind only launch inputs. Conversation/session files never participate. */
export function externalRuntimeLaunchIdentity(kind: ExternalRuntimeKind, options: ExternalRuntimeOptions, cwd: string) {
  const entry = resolveAgentExecutable(kind, options.executable);
  const launchEvidence: Record<string, string> = {
    '执行程序': digest(JSON.stringify([entry.command, fileDigest(entry.command), entry.prefixArgs,
      (entry.integrityFiles ?? entry.prefixArgs).map(path => [path, fileDigest(path)]),entry.env??null])),
    '模型与权限': digest(JSON.stringify({ kind, model: options.model ?? null, effort: options.effort ?? null, permissionMode: options.permissionMode ?? 'bypassPermissions', protocol: 1 })),
  };
  const home = homedir();
  const expanded = (value: string | undefined, fallback: string) => {
    const selected = value?.trim() || fallback;
    return resolve(selected.replace(/^~(?=[\\/]|$)/, home));
  };
  const dshHome = expanded(process.env.DSH_HOME, join(home, '.dsh'));
  const profile = join(dshHome, 'profiles', 'zhongshuo');
  const piHome = expanded(process.env.PI_CODING_AGENT_DIR, join(home, '.pi', 'agent'));
  const bundle = join(profile, 'node_modules', '@zhongshuo', 'dsh-runtime');
  const paths = kind === 'deepseek-harness'
    ? [join(dshHome, 'cordis.patch.yml'), join(dshHome, 'settings.yaml'), join(dshHome, '.credentials.yaml'), join(dshHome, '.env'), join(cwd, '.env'),
      ...['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(name => join(profile, name)),
      ...['package.json', 'index.mjs', 'backend.mjs', 'protocol.mjs', 'cordis.patch.yml'].map(name => join(bundle, name))]
    : [join(piHome, 'settings.json'), join(piHome, 'models.json'), join(piHome, 'auth.json'), join(cwd, '.pi', 'settings.json'),
      // MCP changes alter the tools available to a queued task or resumed DM.
      // Keep the prior identity for installations with no MCP files at all.
      ...[join(piHome,'mcp.json'),join(cwd,'.pi','mcp.json')].filter(existsSync)];
  const script=entry.prefixArgs.find(arg=>/\.(?:mjs|cjs|js)$/i.test(arg));
  if(script&&!entry.integrityFiles)paths.push(join(dirname(script), 'package.json'), join(dirname(dirname(script)), 'package.json'));
  if(kind==='pi'&&script&&/[\\/]pi-launcher\.js$/i.test(script))paths.push(join(dirname(dirname(script)),'install','current-version'));
  launchEvidence['渠道配置'] = digest(JSON.stringify(paths.map(path => [path, fileDigest(path)])));
  const names = kind === 'deepseek-harness'
    ? ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME', 'DSH_AGENTS_HOME', 'NODE_OPTIONS', 'NODE_PATH']
    : ['PI_CODING_AGENT_DIR', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS', 'NODE_PATH'];
  launchEvidence['渠道环境'] = digest(JSON.stringify(names.map(name => [name, process.env[name] ?? null])));
  const configurationKey = digest(JSON.stringify(launchEvidence));
  return { identityKey: configurationKey, configurationKey, launchEvidence, reason: null as string | null };
}
