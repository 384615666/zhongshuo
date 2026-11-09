import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
const sourcePackage = fileURLToPath(new URL('../../packages/dsh-runtime/', import.meta.url));
const { buildDshRuntime } = await import(new URL('../../scripts/build-dsh-runtime.mjs', import.meta.url).href);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs-r210-installer-'));
  roots.push(root);
  const artifacts = join(root, 'artifacts'), bin = join(root, 'bin');
  const appdata = join(root, 'appdata'), localappdata = join(root, 'localappdata'), home = join(root, 'home');
  for (const dir of [bin, join(appdata, 'npm'), localappdata, home]) mkdirSync(dir, { recursive: true });
  await buildDshRuntime(artifacts);
  const script = join(appdata, 'npm', 'fixture.cjs');
  // This local CLI fixture never loads Harness, credentials, or a provider.
  writeFileSync(script, `const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ZS_FIXTURE_TRACE, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log(process.env.ZS_FIXTURE_VERSION || '0.2.2-rc.1'); }
else if (args[0] === 'plugin') {
  fs.cpSync(process.env.ZS_FIXTURE_PACKAGE, path.join(process.env.DSH_HOME, 'profiles/zhongshuo/node_modules/@zhongshuo/dsh-runtime'), { recursive: true });
} else if (args.includes('--zs-probe')) {
  console.log(JSON.stringify({ v:1, type:'probe', runtime:'zhongshuo-dsh', protocol:1, pluginVersion:'0.1.4' }));
} else { process.exitCode = 2; }
`);
  const npmShim = join(appdata, 'npm', 'dsh.cmd');
  writeFileSync(npmShim, '@echo off\r\nnode "%~dp0fixture.cjs" %*\r\n');
  const trace = join(root, 'commands.jsonl'), patch = join(home, 'profiles/zhongshuo/cordis.patch.yml');
  mkdirSync(join(home, 'profiles/zhongshuo'), { recursive: true });
  writeFileSync(patch, '# fixture channels and MCP must remain unchanged\n');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin, APPDATA: appdata, LOCALAPPDATA: localappdata, DSH_HOME: home,
    ZS_FIXTURE_TRACE: trace, ZS_FIXTURE_PACKAGE: sourcePackage };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const run = (mode = '--installer', extra: string[] = []) => spawnSync(process.execPath,
    [join(artifacts, 'setup-deepseek-harness.mjs'), mode, ...extra], { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  const commands = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [];
  return { root, artifacts, bin, appdata, home, npmShim, env, run, commands, patch };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('R210 packaged Harness connector setup, isolated home and fake CLI', () => {
  it('follows the PATH wrapper during installation and avoids repeated plugin installation', async () => {
    const f = await fixture(), before = readFileSync(f.patch);
    writeFileSync(join(f.bin, 'dsh.cmd'), `@echo off\r\ncall "${f.npmShim}" %*\r\n`);
    const first = f.run();
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ status: 'installed', profile: 'zhongshuo', pluginVersion: '0.1.4' });
    expect(f.commands()[1]?.slice(0, 5)).toEqual(['plugin', '--profile', 'zhongshuo', 'add', '--save-exact']);
    const second = f.run();
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ status: 'current', modifiesProfile: false });
    expect(f.commands().filter(args => args[0] === 'plugin')).toHaveLength(1);
    expect(readFileSync(f.patch)).toEqual(before);
  });

  it.each(['--installer', '--install'])('uses a conventional entry when the implicit PATH wrapper is unsupported: %s', async mode => {
    const f = await fixture();
    writeFileSync(join(f.bin, 'dsh.cmd'), '@echo off\r\ncall unrecognized-wrapper %*\r\n');
    const result = f.run(mode);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'installed', profile: 'zhongshuo' });
  });

  it('also handles Explorer PATH that does not contain Harness yet', async () => {
    const f = await fixture(), result = f.run();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'installed' });
  });

  it('does not replace an explicitly chosen unrecognized runtime with another installation', async () => {
    const f = await fixture(), selected = join(f.bin, 'custom.cmd');
    writeFileSync(selected, '@echo off\r\ncall unrecognized-wrapper %*\r\n');
    const result = f.run('--installer', ['--dsh', selected]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('无法解析');
    expect(f.commands()).toEqual([]);
    expect(existsSync(join(f.home, 'connectors'))).toBe(false);
  });

  it('skips only when Harness is absent, not when an installed entry is unrecognized', async () => {
    const f = await fixture();
    rmSync(f.npmShim);
    const absent = f.run();
    expect(absent.status).toBe(0);
    expect(JSON.parse(absent.stdout)).toMatchObject({ status: 'skipped', reason: 'harness-not-installed', modifiesProfile: false });
    writeFileSync(join(f.bin, 'dsh.cmd'), '@echo off\r\ncall unrecognized-wrapper %*\r\n');
    const unsupported = f.run();
    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain('无法解析');
    expect(f.commands()).toEqual([]);
  });

  it('reports an unrecognized fallback entry instead of claiming Harness is absent', async () => {
    const f = await fixture();
    writeFileSync(f.npmShim, '@echo off\r\ncall unrecognized-wrapper %*\r\n');
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('无法解析');
    expect(f.commands()).toEqual([]);
  });

  it('does not report a successful manual repair when Harness is absent', async () => {
    const f = await fixture();
    rmSync(f.npmShim);
    const result = f.run('--install');
    expect(result.status).toBe(1);
    expect(f.commands()).toEqual([]);
    expect(existsSync(join(f.home, 'connectors'))).toBe(false);
  });

  it('rejects a tampered bundled archive before running any discovered CLI', async () => {
    const f = await fixture();
    writeFileSync(join(f.artifacts, 'zhongshuo-dsh-runtime-0.1.4.tgz'), 'tampered fixture');
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum mismatch');
    expect(f.commands()).toEqual([]);
    expect(existsSync(join(f.home, 'connectors'))).toBe(false);
  });

  it('continues to enforce official version compatibility before changing a profile', async () => {
    const f = await fixture();
    f.env.ZS_FIXTURE_VERSION = '99.0.0';
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('supports DSH');
    expect(f.commands()).toEqual([['--version']]);
    expect(existsSync(join(f.home, 'connectors'))).toBe(false);
  });
});
