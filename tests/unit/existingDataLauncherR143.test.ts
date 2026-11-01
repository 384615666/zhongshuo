import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Runtime packaging scripts are standalone JavaScript.
import { installExistingDataLauncher } from '../../scripts/install-existing-data-launcher.mjs';
// @ts-expect-error Runtime packaging scripts are standalone JavaScript.
import { prepareExistingDataLaunch } from '../../scripts/existing-data-launcher.mjs';

const roots: string[] = [];
const databaseBytes = 'SQLite format 3\u0000existing-db-bytes';
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs launch 空格 ! & ')); roots.push(root);
  const pkg = join(root, 'new package'), data = join(root, 'existing data');
  mkdirSync(join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node'), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(data, 'state.sqlite'), databaseBytes);
  writeFileSync(join(data, 'local.token'), 'existing-token');
  writeFileSync(join(pkg, 'ZhongshuoDual', 'electron.exe'), 'fixture');
  writeFileSync(join(pkg, 'ZhongshuoDual', 'resources', 'app', 'daemon', 'node', 'node.exe'), 'fixture');
  installExistingDataLauncher(pkg, data);
  return { pkg, data };
}
describe('existing-data launcher', () => {
  it('creates a missing stable pipe identity while keeping the selected data and credentials', () => {
    const { pkg, data } = fixture();
    const first = prepareExistingDataLaunch(pkg, {}), second = prepareExistingDataLaunch(pkg, {});
    expect(first.env.ZS_APP_DATA).toBe(data);
    expect(first.env.ZS_PIPE_NAME).toMatch(/^\\\\\.\\pipe\\zs-daily-[a-f0-9-]+$/);
    expect(second.env.ZS_PIPE_NAME).toBe(first.env.ZS_PIPE_NAME);
    expect(readFileSync(join(data, 'state.sqlite'), 'utf8')).toBe(databaseBytes);
    expect(readFileSync(join(data, 'local.token'), 'utf8')).toBe('existing-token');
    expect(existsSync(join(data, 'root-identity.json'))).toBe(false);
    expect(existsSync(join(pkg, 'server-data'))).toBe(false);
  });
  it('preserves an existing pipe name byte for byte', () => {
    const { pkg, data } = fixture(); const bytes = 'zs-existing-123\r\n';
    writeFileSync(join(data, 'pipe-name.txt'), bytes);
    expect(prepareExistingDataLaunch(pkg, {}).env.ZS_PIPE_NAME).toBe('\\\\.\\pipe\\zs-existing-123');
    expect(readFileSync(join(data, 'pipe-name.txt'), 'utf8')).toBe(bytes);
  });
  it.each(['', '  ', '../wrong', 'bad&name', '\\\\.\\pipe\\full'])('rejects and preserves invalid pipe content %j', value => {
    const { pkg, data } = fixture(); writeFileSync(join(data, 'pipe-name.txt'), value);
    expect(() => prepareExistingDataLaunch(pkg, {})).toThrow('invalid');
    expect(readFileSync(join(data, 'pipe-name.txt'), 'utf8')).toBe(value);
  });
  it('refuses missing data instead of creating an empty replacement', () => {
    const { pkg, data } = fixture(); rmSync(join(data, 'state.sqlite'));
    expect(() => prepareExistingDataLaunch(pkg, {})).toThrow();
    expect(existsSync(join(pkg, 'server-data'))).toBe(false);
    expect(existsSync(join(data, 'pipe-name.txt'))).toBe(false);
  });
  it('clears inherited runtime overrides including mixed case without removing provider configuration', () => {
    const { pkg } = fixture();
    const plan = prepareExistingDataLaunch(pkg, { ZS_APP_DATA: 'wrong', zs_allow_fake: '1', ZS_DAEMON_ENTRY: 'wrong',
      ELECTRON_RUN_AS_NODE: '1', ZS_DEV25_DEBUG_PORT: '9234', ZS_TEST_DISPLAY: '2', DSH_HOME: 'dsh-home', CODEX_HOME: 'codex-home' });
    expect(plan.env).toMatchObject({ ZS_RUNTIME: 'claude', DSH_HOME: 'dsh-home', CODEX_HOME: 'codex-home', ZS_TEST_DISPLAY: '2' });
    expect(plan.env.zs_allow_fake).toBeUndefined(); expect(plan.env.ZS_DAEMON_ENTRY).toBeUndefined();
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined(); expect(plan.args).toEqual(['--remote-debugging-port=9234']);
  });
  it('requires absolute data selection and refuses to change an installed target', () => {
    const { pkg, data } = fixture();
    expect(() => installExistingDataLauncher(pkg, 'relative')).toThrow('absolute');
    const another = join(data, 'another'); mkdirSync(another); writeFileSync(join(another, 'state.sqlite'), databaseBytes);
    expect(() => installExistingDataLauncher(pkg, another)).toThrow('another data');
    expect(prepareExistingDataLaunch(pkg, {}).env.ZS_APP_DATA).toBe(data);
  });
  it.each(['', 'damaged'])('refuses an empty or damaged database %j without creating a pipe', value => {
    const { pkg, data } = fixture(); writeFileSync(join(data, 'state.sqlite'), value);
    expect(() => prepareExistingDataLaunch(pkg, {})).toThrow('SQLite header');
    expect(existsSync(join(data, 'pipe-name.txt'))).toBe(false);
    expect(readFileSync(join(data, 'state.sqlite'), 'utf8')).toBe(value);
  });
  it('reports failure when the application exits zero before connecting', () => {
    const { pkg } = fixture();
    copyFileSync(process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'cmd.exe') : process.execPath, join(pkg, 'ZhongshuoDual', 'electron.exe'));
    const run = spawnSync(process.execPath, [join(pkg, 'existing-data-launcher.mjs')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    expect(run.status).toBe(1);
    expect(readFileSync(join(pkg, 'startup-existing-data.log'), 'utf8')).toContain('exited before the desktop connected');
  });
});
