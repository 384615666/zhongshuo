import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCliExecutable } from '../src/adapter/cli/executable.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const supportedVersion = '0.2.1-rc.5';
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

export async function setupDeepseekHarness(args) {
  if (args.includes('--help') || args.includes('-h')) return { usage: 'node setup-deepseek-harness.mjs --install [--artifact-dir DIR] [--dsh PATH | --dsh-js PATH]', profile: 'zhongshuo', dshVersion: supportedVersion };
  if (!args.includes('--install')) throw new Error('Manual setup only: node setup-deepseek-harness.mjs --install [--artifact-dir DIR] [--dsh PATH | --dsh-js PATH]');
  let artifacts = await exists(join(here, 'manifest.json')) ? here : resolve(here, '../dist/dsh-runtime');
  let executable; let script;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--install') continue;
    if (!['--artifact-dir', '--dsh', '--dsh-js'].includes(arg) || !args[i + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    const value = args[++i];
    if (arg === '--artifact-dir') artifacts = resolve(value);
    else if (arg === '--dsh') executable = value;
    else script = resolve(value);
  }
  if (executable && script) throw new Error('Choose --dsh or --dsh-js.');
  const manifest = JSON.parse(await readFile(join(artifacts, 'manifest.json'), 'utf8'));
  if (manifest.profile !== 'zhongshuo' || manifest.dshVersion !== supportedVersion || manifest.package !== '@zhongshuo/dsh-runtime' || manifest.protocol !== 1 || !/^zhongshuo-dsh-runtime-[\d.]+\.tgz$/.test(manifest.tarball)) throw new Error('Incompatible Zhongshuo runtime manifest.');
  const tarball = join(artifacts, manifest.tarball);
  const hash = createHash('sha256').update(await readFile(tarball)).digest('hex');
  if (hash !== manifest.sha256) throw new Error('Runtime archive checksum mismatch.');
  const launch = script ? { command: process.execPath, prefixArgs: [script] } : resolveCliExecutable('deepseek-harness', executable);
  const version = await run(launch, ['--version'], true);
  if (version.trim() !== supportedVersion) throw new Error(`This plugin supports DSH ${supportedVersion}; install that official version separately before setup.`);
  // No default/open-design profile flag is accepted from the caller. The official
  // CLI owns profile creation and plugin installation. No CLI is installed here.
  await run(launch, ['plugin', '--profile', 'zhongshuo', 'add', '--save-exact', tarball]);
  const probe = await run(launch, ['--profile', 'zhongshuo', '--zs-probe'], true);
  let frame; try { frame = JSON.parse(probe.trim()); } catch { throw new Error('Installed profile did not return a valid probe.'); }
  if (frame.runtime !== 'zhongshuo-dsh' || frame.v !== 1 || frame.protocol !== 1 || frame.type !== 'probe' || frame.pluginVersion !== manifest.pluginVersion) throw new Error('Installed profile probe mismatch.');
  return { profile: 'zhongshuo', dshVersion: supportedVersion, pluginVersion: manifest.pluginVersion, probe: frame };
}

async function run(launch, args, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], { env: launch.env ? { ...process.env, ...launch.env } : undefined,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], windowsHide: true, shell: false });
    let text = '';
    child.stdout?.on('data', (chunk) => { text += chunk.toString('utf8'); if (text.length > 1024 * 1024) child.kill(); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolveRun(text) : reject(new Error(`Official DSH command failed (exit ${code}).`)));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setupDeepseekHarness(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2)), (error) => { console.error(error.message); process.exitCode = 1; });
}
