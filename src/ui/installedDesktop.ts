import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

/** Installed entry owns its environment; a data override must be an explicit argument. */
export function installedDesktopConfiguration(argv: string[], parentEnv: NodeJS.ProcessEnv, localAppData: string) {
  const selected = argv.filter(arg => arg.startsWith('--data-dir='));
  if (selected.length > 1) throw Error('数据目录参数重复。');
  const value = selected[0]?.slice('--data-dir='.length);
  if (value != null && !isAbsolute(value)) throw Error('--data-dir 必须是绝对路径。');
  const dataRoot = resolve(value ?? join(localAppData, 'Zhongshuo', 'data'));
  const env = { ...parentEnv };
  const allowed = new Set(['ZS_DEV25_DEBUG_PORT', 'ZS_TEST_DISPLAY', 'ZS_TEST_WINDOW_BOUNDS', 'ZS_TEST_PLACEMENT_FILE']);
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('ZS_') && !allowed.has(key) || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  env.ZS_RUNTIME = 'claude';
  return { dataRoot, env };
}

export function installedDaemonPipe(dataRoot: string): string {
  const identity = createHash('sha256').update(resolve(dataRoot).toLowerCase()).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\zhongshuo-desktop-${identity}`;
}
