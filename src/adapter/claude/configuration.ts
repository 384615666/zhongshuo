import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const routingKey = /^(ANTHROPIC_|CLAUDE_CODE_(?:USE_|HOST_|PROVIDER_|PROCESS_WRAPPER)|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$)/i;
// The CLI rewrites these local UI/usage facts during an ordinary turn. They are
// not launch configuration. Keep all other (including unknown) fields guarded.
const legacyStateKeys = new Set(['numStartups','tipsHistory','promptQueueUseCount','firstStartTime','seenNotifications','changelogLastFetched','hasCompletedOnboarding','lastOnboardingVersion','lastReleaseNotesSeen','tipLifetimeShownCounts','closedIssuesLastChecked','pluginUsage','officialMarketplaceAutoInstallAttempted','officialMarketplaceAutoInstalled','hasSeenAutoModeEntryWarning','hasSeenAutoDefaultNotice','hasResetAutoModeOptInForDefaultOffer','unpinOpus47LaunchEffort','unpinOpus48LaunchEffort','unpinFable5LaunchEffort','opusProMigrationComplete','sonnet1m45MigrationComplete','migrationVersion']);
function stableConfiguration(value:unknown):unknown {
  if(Array.isArray(value))return value.map(stableConfiguration);
  if(value!=null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stableConfiguration(v)]));
  return value;
}
function legacyConfiguration(settings:Record<string,unknown>,cwd:string) {
  const result=Object.fromEntries(Object.entries(settings).filter(([k])=>!legacyStateKeys.has(k)&&k!=='projects'));
  const projects=settings.projects;
  if(projects!=null&&typeof projects==='object'&&!Array.isArray(projects)) {
    const entry=Object.entries(projects).find(([path])=>resolve(path).toLowerCase()===resolve(cwd).toLowerCase());
    if(entry)result.projects={[entry[0]]:entry[1]};
  }else if(projects!=null)result.projects=projects;
  return stableConfiguration(result);
}
/** Read-only launch context. Never exports credentials or changes the CLI's settings sources.
 * Project env can be filtered by CLI trust/provider rules: don't certify a guessed merge.
 * This resolver is consumed both by capability checks and the formal adapter immediately before spawn.
 */
export function resolveClaudeConfiguration(cwd: string, extraArgs: string[] = [], inherited: NodeJS.ProcessEnv = process.env) {
  const env = { ...inherited };
  const configDir = resolve(cwd, env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
  const sources: string[] = [];
  const stamps: string[] = [];
  const reasons: string[] = [];
  let endpoint = env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  let endpointSource = env.ANTHROPIC_BASE_URL == null ? '官方默认' : '进程环境';
  const read = (file: string, label: string, uncertain = false) => {
    try {
      const raw = readFileSync(file, 'utf8');
      const settings = JSON.parse(raw) as { env?: Record<string, unknown>; apiKeyHelper?: unknown; processWrapper?: unknown };
      if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('object required');
      stamps.push(`${file}:${digest(label.includes('旧配置')?JSON.stringify(legacyConfiguration(settings,cwd)):raw)}`); sources.push(label);
      if (settings.env != null && (typeof settings.env !== 'object' || Array.isArray(settings.env))) throw new Error('env object required');
      if (settings.apiKeyHelper != null || settings.processWrapper != null) reasons.push(`${label}含动态凭据或进程包装，无法核实有效渠道`);
      const entries = Object.entries(settings.env ?? {});
      if (uncertain && (label.includes('托管') && Object.keys(settings).length > 0 || entries.some(([key]) => routingKey.test(key)))) {
        reasons.push(`${label}含渠道覆盖；CLI 项目信任或托管过滤结果未核实`);
        return;
      }
      if (!uncertain) for (const [key, value] of entries) {
        if (!['string', 'number', 'boolean'].includes(typeof value)) { reasons.push(`${label}的 env 值无效`); continue; }
        env[key] = String(value);
        if (key === 'ANTHROPIC_BASE_URL') { endpoint = String(value); endpointSource = label; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { stamps.push(`${file}:${label.includes('旧配置')?digest('{}'):'absent'}`); return; }
      reasons.push(`${label}读取或解析失败`); stamps.push(`${file}:unreadable`);
    }
  };
  // CLI also accepts the legacy global config env. Ambiguous authentication pinning is fail-closed.
  read(join(configDir, '.claude.json'), '全局旧配置', true);
  if (env.CLAUDE_CONFIG_DIR == null) read(join(homedir(), '.claude.json'), '用户旧配置', true);
  read(join(configDir, 'settings.json'), env.CLAUDE_CONFIG_DIR == null ? '用户 settings.json' : 'CLAUDE_CONFIG_DIR/settings.json');
  read(join(cwd, '.claude', 'settings.json'), '项目 settings.json', true);
  read(join(cwd, '.claude', 'settings.local.json'), '项目 settings.local.json', true);
  const managedDir = process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
  read(join(managedDir, 'managed-settings.json'), '系统托管配置', true);
  read(join(configDir, 'managed-settings.json'), '缓存托管配置', true);
  try { if (readdirSync(join(managedDir, 'managed-settings.d')).some(f => f.endsWith('.json'))) reasons.push('存在托管配置分片，无法核实最终渠道'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') reasons.push('托管配置目录不可读'); }
  if (process.platform === 'win32') for (const hive of ['HKLM', 'HKCU']) {
    const policy = spawnSync('reg.exe', ['query', `${hive}\\SOFTWARE\\Policies\\ClaudeCode`, '/s'], { windowsHide: true, timeout: 2000 });
    const absentText = policy.stderr == null ? '' : new TextDecoder('gb18030').decode(policy.stderr);
    if (policy.status === 0) { reasons.push('存在 Windows 托管策略，无法核实最终配置'); stamps.push(digest(policy.stdout.toString('hex'))); }
    else if (policy.error || policy.status !== 1 || !/unable to find|cannot find|找不到|不存在/i.test(absentText)) reasons.push('Windows 托管策略读取失败');
  }
  if (extraArgs.some(arg => /^--(?:settings|setting-sources|model|permission-mode|betas|restricted|safe-mode)(?:=|$)/.test(arg))) reasons.push('额外启动参数覆盖配置、模型或权限，尚未认证');
  for (const [key, value] of Object.entries(env)) {
    if (!value || value === '0' || value === 'false') continue;
    if (/^CLAUDE_CODE_(USE_|HOST_|PROVIDER_|PROCESS_WRAPPER)|^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/i.test(key)) reasons.push(`${key}改变渠道或宿主执行，尚未核实`);
  }
  if (env.CLAUDE_CODE_PROJECT_DIR_NAME) reasons.push('自定义项目配置目录未核实');
  if (env.CLAUDE_CONFIG_DIR !== inherited.CLAUDE_CONFIG_DIR) reasons.push('settings.env 重定向配置目录，最终来源未核实');
  if (Object.keys(env).some(key => /^CLAUDE_CODE_SETTINGS|^CLAUDE_CODE_MANAGED_SETTINGS/.test(key) && env[key])) reasons.push('环境包含额外 settings 来源，最终配置未核实');
  if (env.CLAUDE_CONFIG_DIR != null && !env.CLAUDE_CONFIG_DIR.trim()) reasons.push('CLAUDE_CONFIG_DIR 为空，无法核实配置目录');
  let channel = '无法确定';
  try { const url = new URL(endpoint); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid endpoint'); channel = `${url.origin}${url.pathname.replace(/\/$/, '')}`; } catch { reasons.push('有效 endpoint 无效或包含私密参数'); }
  const routing = Object.entries(env).filter(([key]) => routingKey.test(key)).sort(([a], [b]) => a.localeCompare(b));
  return { env: { ...inherited }, restrictedEnv: env, configDir, cwd: resolve(cwd), endpointHash: digest(endpoint), channel: reasons.length ? `无法确定（候选用户渠道：${channel}）` : channel, endpointSource, sources,
    reason: [...new Set(reasons)].join('；') || null,
    configurationKey: digest(JSON.stringify({ configDir, cwd: resolve(cwd), stamps, routing, extraArgs })),
  };
}
