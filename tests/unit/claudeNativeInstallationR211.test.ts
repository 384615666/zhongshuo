import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { ClaudeCliAdapter, resolveClaudeExecutable } from '../../src/adapter/claude/cliAdapter.ts';
import { memberExecutableStatus } from '../../src/daemon/memberManagement.ts';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zs-r211-native-'));
  roots.push(root);
  const appdata = join(root, 'appdata');
  const bin = join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'claude.exe'), shim = join(root, 'claude.cmd');
  const placeholder = 'echo "Error: claude native binary not installed." >&2\necho "Run the postinstall manually" >&2\nexit 1\n';
  writeFileSync(executable, placeholder);
  writeFileSync(shim, `@echo off\r\n"${executable}" %*\r\n`);
  vi.stubEnv('APPDATA', appdata);
  return { root, executable, shim, placeholder };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('R211 Claude native package placeholder detection', () => {
  it.each(['default', 'explicit', 'shim'])('rejects the known uninstalled-native placeholder through %s lookup', mode => {
    const f = fixture();
    const selected = mode === 'default' ? undefined : mode === 'explicit' ? f.executable : f.shim;
    expect(() => resolveClaudeExecutable(selected)).toThrow(expect.objectContaining({ code: 'RUNTIME_NOT_FOUND', notStarted: true }));
    expect(() => resolveClaudeExecutable(selected)).toThrow('安装不完整');
    expect(readFileSync(f.executable, 'utf8')).toBe(f.placeholder);
  });

  it('does not report the placeholder as an installed runnable CLI', () => {
    const f = fixture();
    expect(memberExecutableStatus('claude', 'claude').status).toBe('missing');
    expect(memberExecutableStatus('claude', 'claude').reason).toContain('安装不完整');
    expect(memberExecutableStatus('claude', f.executable).status).toBe('missing');
  });

  it('does not mistake arbitrary executable bytes for the specific package placeholder', () => {
    const f = fixture();
    writeFileSync(f.executable, 'MZ fixture binary reference, never executed');
    expect(resolveClaudeExecutable()).toEqual({ command: f.executable, prefixArgs: [] });
  });

  it('rejects a production probe of an incomplete installation without hanging', async () => {
    fixture();
    await expect(new ClaudeCliAdapter().probe()).rejects.toThrow('安装不完整');
  });

  it('does not let host lookup failure throw inside an injected probe close callback', async () => {
    fixture();
    const adapter = new ClaudeCliAdapter({}, () => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => { child.stdout.write('fixture-version\n'); child.emit('close', 0); });
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    expect(await adapter.probe()).toMatchObject({ executable: 'claude', version: 'fixture-version' });
  });
});
