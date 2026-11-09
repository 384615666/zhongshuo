import { createHash } from 'node:crypto';
import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCliExecutable } from '../src/adapter/cli/executable.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const supportedVersions = ['0.2.1-rc.5', '0.2.2-rc.1'];
const supportedVersion = supportedVersions.join(' || ');
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

export async function setupDeepseekHarness(args) {
  if (args.includes('--help') || args.includes('-h')) return { usage: 'node setup-deepseek-harness.mjs --install|--installer|--plan [--artifact-dir DIR] [--dsh PATH | --dsh-js PATH]', profile: 'zhongshuo', dshVersion: supportedVersion };
  const installer = args.includes('--installer');
  if (!args.includes('--install') && !args.includes('--plan') && !installer) throw new Error('Pass --install, --installer (if Harness is present), or read-only --plan.');
  let artifacts = await exists(join(here, 'manifest.json')) ? here : resolve(here, '../dist/dsh-runtime');
  let executable; let script;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--install' || arg === '--plan' || arg === '--installer') continue;
    if (!['--artifact-dir', '--dsh', '--dsh-js'].includes(arg) || !args[i + 1]) throw new Error(`Unknown or incomplete option: ${arg}`);
    const value = args[++i];
    if (arg === '--artifact-dir') artifacts = resolve(value);
    else if (arg === '--dsh') executable = value;
    else script = resolve(value);
  }
  if (executable && script) throw new Error('Choose --dsh or --dsh-js.');
  const manifest = JSON.parse(await readFile(join(artifacts, 'manifest.json'), 'utf8'));
  if (manifest.profile !== 'zhongshuo' || manifest.dshVersion !== supportedVersion || manifest.package !== '@zhongshuo/dsh-runtime' || manifest.protocol !== 1 ||
    typeof manifest.pluginVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.pluginVersion) || manifest.tarball !== `zhongshuo-dsh-runtime-${manifest.pluginVersion}.tgz` ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Incompatible Zhongshuo runtime manifest.');
  const tarball = join(artifacts, manifest.tarball);
  const hash = createHash('sha256').update(await readFile(tarball)).digest('hex');
  if (hash !== manifest.sha256) throw new Error('Runtime archive checksum mismatch.');
  // The package manager records file: dependencies verbatim. Never retain the
  // removable installer/portable/source location in the user's profile manifest.
  const selectedHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const home = resolve(selectedHome.replace(/^~(?=[\\/]|$)/, homedir()));
  const durableDir = join(home, 'connectors', 'zhongshuo', `${manifest.pluginVersion}-${hash.slice(0, 16)}`);
  const durableTarball = join(durableDir, manifest.tarball);
  if (args.includes('--plan')) return { profile: 'zhongshuo', dshVersion: supportedVersion, pluginVersion: manifest.pluginVersion,
    artifactVerified: true, durableTarball, modifiesProfile: false };
  let launch;
  try { launch = script ? { command: process.execPath, prefixArgs: [script] } : resolveCliExecutable('deepseek-harness', executable); }
  catch (error) {
    const canDiscover = failure => ['RUNTIME_NOT_FOUND', 'CAPABILITY_UNSUPPORTED'].includes(failure.code);
    if (executable || script || !canDiscover(error)) throw error;
    // Explorer's PATH can be stale or contain an unfamiliar forwarding shim.
    // Only implicit selection may fall back; an explicit choice stays binding.
    const candidates = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/DeepSeek Harness/DeepSeek Harness.exe'),
      process.env.APPDATA && join(process.env.APPDATA, 'npm/dsh.cmd')].filter(Boolean);
    let candidateError;
    for (const candidate of candidates) {
      if (!await exists(candidate)) continue;
      try { launch = resolveCliExecutable('deepseek-harness', candidate); break; }
      catch (failure) { if (!canDiscover(failure)) throw failure; candidateError = failure; }
    }
    if (!launch) {
      if (candidateError) throw candidateError;
      if (error.code !== 'RUNTIME_NOT_FOUND' || !installer) throw error;
      return { status: 'skipped', reason: 'harness-not-installed', modifiesProfile: false };
    }
  }
  const version = await run(launch, ['--version'], true);
  if (!supportedVersions.includes(version.trim())) throw new Error(`This plugin supports DSH ${supportedVersions.join(' or ')}; install a supported official version separately before setup.`);
  if (installer) {
    const installed = join(home, 'profiles/zhongshuo/node_modules/@zhongshuo/dsh-runtime');
    let matches = true;
    for (const [file, expected] of Object.entries(manifest.files)) {
      try { if (createHash('sha256').update(await readFile(join(installed, file))).digest('hex') !== expected) matches = false; }
      catch { matches = false; }
    }
    // Exact current content needs no package-manager call on later app upgrades.
    if (matches) {
      const frame = JSON.parse(await run(launch, ['--profile', 'zhongshuo', '--zs-probe'], true));
      if (frame.runtime === 'zhongshuo-dsh' && frame.v === 1 && frame.protocol === 1 && frame.type === 'probe' && frame.pluginVersion === manifest.pluginVersion)
        return { status: 'current', profile: 'zhongshuo', pluginVersion: manifest.pluginVersion, modifiesProfile: false };
      throw new Error('Current component probe mismatch.');
    }
  }
  await mkdir(durableDir, { recursive: true });
  const data = await readFile(tarball);
  try { await writeFile(durableTarball, data, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (createHash('sha256').update(await readFile(durableTarball)).digest('hex') !== hash) throw new Error('Persistent runtime archive checksum mismatch; no profile changes were made.');
  // No default/open-design profile flag is accepted from the caller. The official
  // CLI owns profile creation and plugin installation. No CLI is installed here.
  await run(launch, ['plugin', '--profile', 'zhongshuo', 'add', '--save-exact', durableTarball]);
  const probe = await run(launch, ['--profile', 'zhongshuo', '--zs-probe'], true);
  let frame; try { frame = JSON.parse(probe.trim()); } catch { throw new Error('Installed profile did not return a valid probe.'); }
  if (frame.runtime !== 'zhongshuo-dsh' || frame.v !== 1 || frame.protocol !== 1 || frame.type !== 'probe' || frame.pluginVersion !== manifest.pluginVersion) throw new Error('Installed profile probe mismatch.');
  return { status: 'installed', profile: 'zhongshuo', dshVersion: version.trim(), pluginVersion: manifest.pluginVersion, probe: frame };
}

async function run(launch, args, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], { env: launch.env ? { ...process.env, ...launch.env } : undefined,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], windowsHide: true, shell: false });
    const timer = setTimeout(() => child.kill(), args[0] === 'plugin' ? 120_000 : 30_000);
    let text = '';
    child.stdout?.on('data', (chunk) => { text += chunk.toString('utf8'); if (text.length > 1024 * 1024) child.kill(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(text);
      else reject(new Error(`Official DSH command failed (exit ${code}).`));
    });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setupDeepseekHarness(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2)), (error) => { console.error(error.message); process.exitCode = 1; });
}
