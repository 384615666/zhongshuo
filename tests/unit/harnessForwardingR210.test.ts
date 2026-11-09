import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentExecutable } from '../../src/adapter/cli/executable.ts';
import { externalRuntimeLaunchIdentity } from '../../src/adapter/cli/configuration.ts';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs-r210-forward-'));
  roots.push(root);
  const executable = join(root, 'Harness Desktop', 'DeepSeek Harness.exe');
  const archive = join(root, 'Harness Desktop', 'resources', 'app.asar');
  const official = join(root, 'Harness Desktop', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  mkdirSync(join(root, 'Harness Desktop', 'resources', 'runtime', 'cli', 'bin'), { recursive: true });
  writeFileSync(executable, 'fixture executable, never run');
  writeFileSync(archive, 'fixture archive');
  writeFileSync(official, '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n' +
    '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\nexit /b %errorlevel%\r\n');
  const wrapper = join(root, 'dsh.cmd');
  writeFileSync(wrapper, `@echo off\r\ncall "${official}" %*\r\n`);
  return { root, executable, archive, official, wrapper };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('R210 static Harness forwarding entry resolution', () => {
  it('resolves the ProgramData-style PATH forwarding shim without launching a shell', () => {
    const f = fixture();
    vi.stubEnv('PATH', f.root);
    expect(resolveAgentExecutable('deepseek-harness')).toEqual({
      command: f.executable,
      prefixArgs: ['--expose-internals', join(f.archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      integrityFiles: [f.wrapper, f.official, f.archive],
    });
  });

  it('supports bounded forwarding chains and dp0-relative paths containing spaces', () => {
    const f = fixture(), middle = join(f.root, 'middle.bat');
    writeFileSync(f.wrapper, '@echo off\r\nsetlocal DisableDelayedExpansion\r\ncall "%~dp0middle.bat" %*\r\nexit /b %errorlevel%\r\n');
    writeFileSync(middle, '@echo off\r\ncall "%~dp0Harness Desktop\\resources\\runtime\\cli\\bin\\dsh.cmd" %*\r\n');
    expect(resolveAgentExecutable('deepseek-harness', f.wrapper)).toMatchObject({
      command: f.executable, integrityFiles: [f.wrapper, middle, f.official, f.archive],
    });
  });

  it('binds every forwarding file and the archive into the launch identity', () => {
    const f = fixture(), options = { executable: f.wrapper };
    vi.stubEnv('DSH_HOME', join(f.root, 'isolated-home'));
    const first = externalRuntimeLaunchIdentity('deepseek-harness', options, f.root).identityKey;
    writeFileSync(f.wrapper, `@echo off\r\n\r\ncall "${f.official}" %*\r\n`);
    const second = externalRuntimeLaunchIdentity('deepseek-harness', options, f.root).identityKey;
    expect(second).not.toBe(first);
    writeFileSync(f.archive, 'updated fixture archive with different bytes');
    expect(externalRuntimeLaunchIdentity('deepseek-harness', options, f.root).identityKey).not.toBe(second);
  });

  it('keeps forwarded JS contents and their package metadata bound to authorization', () => {
    const f = fixture(), shim = join(f.root, 'npm.cmd'), script = join(f.root, 'entry.mjs');
    writeFileSync(f.wrapper, `@echo off\r\ncall "${shim}" %*\r\n`);
    writeFileSync(shim, 'node "%~dp0entry.mjs" %*\r\n');
    writeFileSync(script, '// initial entry');
    const pkg = join(f.root, 'package.json');
    writeFileSync(pkg, '{"version":"1.0.0"}');
    vi.stubEnv('DSH_HOME', join(f.root, 'isolated-home'));
    const key = () => externalRuntimeLaunchIdentity('deepseek-harness', { executable: f.wrapper }, f.root).identityKey;
    const first = key();
    writeFileSync(script, '// changed entry');
    const second = key();
    expect(second).not.toBe(first);
    writeFileSync(pkg, '{"version":"1.0.1"}');
    expect(key()).not.toBe(second);
  });

  it('rejects forwarding cycles before starting any process', () => {
    const f = fixture();
    writeFileSync(f.wrapper, '@echo off\r\ncall "%~dp0dsh.cmd" %*\r\n');
    expect(() => resolveAgentExecutable('deepseek-harness', f.wrapper)).toThrow(/循环|层/);
  });

  it('rejects forwarding depth beyond eight batch files', () => {
    const f = fixture();
    for (let i = 0; i < 9; i++) {
      const path = i === 0 ? f.wrapper : join(f.root, `hop-${i}.cmd`);
      writeFileSync(path, `@echo off\r\ncall "${i === 8 ? f.official : join(f.root, `hop-${i + 1}.cmd`)}" %*\r\n`);
    }
    expect(() => resolveAgentExecutable('deepseek-harness', f.wrapper)).toThrow(/循环|层/);
  });

  it('reports a missing forwarding target as a missing runtime', () => {
    const f = fixture();
    writeFileSync(f.wrapper, '@echo off\r\ncall "%~dp0missing.cmd" %*\r\n');
    expect(() => resolveAgentExecutable('deepseek-harness', f.wrapper)).toThrow(expect.objectContaining({ code: 'RUNTIME_NOT_FOUND', notStarted: true }));
  });

  it.each([
    'set "DSH_HOME=some-other-home"\r\ncall "%~dp0target.cmd" %*',
    'call "%~dp0target.cmd" --profile web %*',
    'call "%~dp0target.cmd" %* & arbitrary-command',
    'call "%UNRESOLVED_ROOT%\\target.cmd" %*',
    'call "%~dp0target.cmd" %*\r\narbitrary-command',
  ])('does not interpret shell operations or silently drop wrapper behavior: %s', body => {
    const f = fixture();
    writeFileSync(f.wrapper, `@echo off\r\n${body}\r\n`);
    expect(() => resolveAgentExecutable('deepseek-harness', f.wrapper)).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED', notStarted: true }));
  });
});
