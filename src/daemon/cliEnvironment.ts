import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

function currentWindowsPaths(): string[] {
  if (process.platform !== 'win32') return [];
  const script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Environment]::ExpandEnvironmentVariables(([Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')))";
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024});
  if (result.error || result.status !== 0) throw Error('Windows PATH 读取失败');
  return result.stdout.trim().split(';');
}

/** Refresh only this daemon's search environment after an installer updates PATH.
 * Never writes the registry or changes explicitly saved executable references. */
export function refreshCliSearchPath(readPaths: () => string[] = currentWindowsPaths): string | null {
  try {
    const paths = [...(process.env.PATH ?? '').split(delimiter), ...readPaths()];
    const seen = new Set<string>();
    process.env.PATH = paths.map(path => path.trim().replace(/^"(.*)"$/, '$1')).filter(path => {
      const key = process.platform === 'win32' ? path.toLowerCase() : path;
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }).join(delimiter);
    return null;
  } catch {
    return '系统环境路径暂时无法刷新；若新安装的 CLI 未被发现，请正常退出众说后重新打开再扫描';
  }
}
