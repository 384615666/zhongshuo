import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Windows distribution icons are always derived from the user's source logo. */
export function brandIco(source = fileURLToPath(new URL('../../logo.png', import.meta.url))) {
  const script = fileURLToPath(new URL('./brand-icon.ps1', import.meta.url));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Source', source],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error(`Cannot convert logo.png to Windows ICO: ${result.error?.message ?? result.stderr?.trim()}`);
  const bytes = Buffer.from(result.stdout.trim(), 'base64');
  if (bytes.length < 118 || bytes.readUInt16LE(2) !== 1 || bytes.readUInt16LE(4) !== 7) throw Error('Invalid generated brand icon');
  return bytes;
}
