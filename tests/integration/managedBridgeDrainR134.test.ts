import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { spawnManagedProcess } from '../../src/daemon/managed/jobManager.ts';
import {
  managedActivePollers, managedJobById, managedJobsCount, spawnManagedBridge,
  type ManagedChildProcess,
} from '../../src/daemon/managed/bridge.ts';
import { ClaudeCliAdapter } from '../../src/adapter/claude/cliAdapter.ts';
import type { NormalizedRuntimeEvent } from '../../src/contracts/runtime.ts';

const HIGH_WATER = 1 << 20;
const root = mkdtempSync(join(tmpdir(), 'zs-managed-drain-r134-'));
const fixture = fileURLToPath(new URL('../fixtures/managedBridgeDrainR134.mjs', import.meta.url));
const facts: Record<string, unknown>[] = [];
let sequence = 0;

afterAll(() => {
  const evidenceDir = process.env.ZS_MANAGED_DRAIN_EVIDENCE_DIR;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(join(evidenceDir, 'drain-facts.json'), JSON.stringify({
      platform: process.platform, node: process.version,
      source: fileURLToPath(new URL('../../src/daemon/managed/jobManager.ts', import.meta.url)),
      realModelCalls: 0, facts,
    }, null, 2));
  }
  rmSync(root, { recursive: true, force: true });
});

function argsFor(stdout: Buffer, stderr: Buffer = Buffer.alloc(0)): string[] {
  const stem = join(root, String(sequence++));
  writeFileSync(`${stem}.out`, stdout);
  writeFileSync(`${stem}.err`, stderr);
  return [fixture, `${stem}.out`, `${stem}.err`];
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(10);
  }
}

function readAll(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

function byteFact(expected: Buffer, actual: Buffer): Record<string, unknown> {
  return {
    expectedBytes: expected.length, actualBytes: actual.length,
    expectedSha256: createHash('sha256').update(expected).digest('hex'),
    actualSha256: createHash('sha256').update(actual).digest('hex'),
  };
}

describe.skipIf(process.platform !== 'win32')('R134 real Windows managed pipe drain (no model calls)', () => {
  it('small stdout/stderr: empty live pipes stay open; repeated probes preserve every JSON/UTF8 byte', () => {
    const out = Buffer.from('{"result":"中文😀"}\n');
    const err = Buffer.from('中😀 stderr\n');
    const mp = spawnManagedProcess({ cmd: process.execPath, args: [...argsFor(out, err), 'stdin-eof'], cwd: root });
    try {
      for (let i = 0; i < 8; i++) {
        expect(mp.stdoutDrained()).toBeNull();
        expect(mp.stderrDrained()).toBeNull();
      }
      expect(mp.waitRootExit(0).timedOut).toBe(true);
      mp.endStdin();
      expect(mp.waitRootExit(5000)).toEqual({ code: 0, timedOut: false });
      for (let i = 0; i < 8; i++) {
        expect(mp.stdoutDrained()).toBe(false);
        expect(mp.stderrDrained()).toBe(false);
      }
      expect(mp.bytesRead()).toEqual({ stdout: 0, stderr: 0 });
      const read = (stream: 'stdout' | 'stderr'): Buffer => {
        const chunks: Buffer[] = [];
        for (let i = 0; i < 100; i++) {
          const done = stream === 'stdout' ? mp.stdoutDrained() : mp.stderrDrained();
          if (done === true) return Buffer.concat(chunks);
          expect(done).toBe(false);
          const bytes = stream === 'stdout' ? mp.pollStdoutBytes(1) : mp.pollStderrBytes(1);
          expect(bytes?.length).toBe(1);
          chunks.push(bytes!);
        }
        throw new Error('Small pipe failed to reach EOF');
      };
      const actualOut = read('stdout');
      const actualErr = read('stderr');
      facts.push({ name: 'small native probes', stdout: byteFact(out, actualOut), stderr: byteFact(err, actualErr) });
      expect(actualOut.equals(out)).toBe(true);
      expect(actualErr.equals(err)).toBe(true);
      expect(mp.bytesRead()).toEqual({ stdout: out.length, stderr: err.length });
      expect(mp.stdoutDrained()).toBe(true);
      expect(mp.stderrDrained()).toBe(true);
      expect(mp.pollStdoutBytes()).toBeNull();
      expect(mp.pollStderrBytes()).toBeNull();
    } finally {
      mp.dispose();
    }
  });

  it('small real bridge: normal zero exit and empty stderr reach EOF and close once', async () => {
    const pollersBefore = managedActivePollers();
    const payload = Buffer.from('{"result":"small 中文😀"}\n');
    const child = spawnManagedBridge(process.execPath, argsFor(payload), { cwd: root });
    const events: string[] = [];
    child.on('exit', () => events.push('exit'));
    child.on('close', () => events.push('close'));
    try {
      const [actualOut, actualErr] = await Promise.all([readAll(child.stdout), readAll(child.stderr)]);
      await until(() => events.includes('close'), 'small bridge close');
      facts.push({ name: 'small bridge', ...byteFact(payload, actualOut), stderrBytes: actualErr.length, events, exitCode: child.exitCode });
      expect(actualOut.equals(payload)).toBe(true);
      expect(actualErr.length).toBe(0);
      expect(events).toEqual(['exit', 'close']);
      expect(child.exitCode).toBe(0);
      expect(managedActivePollers()).toBe(pollersBefore);
    } finally {
      child.managed.dispose();
    }
  });

  it('root exited with empty inherited pipes: await writer EOF without early close, then preserve delayed stdout/stderr', async () => {
    const pollersBefore = managedActivePollers();
    const out = Buffer.from('{"result":"delayed 中文😀"}\n');
    const err = Buffer.from('delayed stderr ✓\n');
    const release = join(root, `release-${sequence}`);
    const child = spawnManagedBridge(process.execPath, [...argsFor(out, err), 'inherited-writer', release], { cwd: root });
    const events: string[] = [];
    child.on('exit', () => events.push('exit'));
    child.on('close', () => events.push('close'));
    try {
      await until(() => events.includes('exit'), 'root exit before inherited writer');
      await delay(100);
      expect(events).toEqual(['exit']);
      expect(child.managed.stdoutDrained()).toBeNull();
      expect(child.managed.stderrDrained()).toBeNull();
      expect(child.managed.bytesRead()).toEqual({ stdout: 0, stderr: 0 });
      expect(child.managed.lifecycle().stdioClosed).toBe(false);
      const activeBeforeRelease = child.managed.activeCount();
      expect(activeBeforeRelease).toBeGreaterThanOrEqual(1);
      const output = readAll(child.stdout);
      const errors = readAll(child.stderr);
      writeFileSync(release, 'release synthetic writer');
      const [actualOut, actualErr] = await Promise.all([output, errors]);
      await until(() => events.includes('close'), 'inherited pipe EOF');
      facts.push({ name: 'delayed inherited writer', activeBeforeRelease, stdout: byteFact(out, actualOut), stderr: byteFact(err, actualErr), events });
      expect(actualOut.equals(out)).toBe(true);
      expect(actualErr.equals(err)).toBe(true);
      expect(events).toEqual(['exit', 'close']);
      expect(child.exitCode).toBe(0);
      expect(managedActivePollers()).toBe(pollersBefore);
    } finally {
      child.managed.dispose();
    }
  }, 30_000);

  async function pausedBridge(name: string, out: Buffer, err: Buffer): Promise<void> {
    const pollersBefore = managedActivePollers();
    const jobsBefore = managedJobsCount();
    const child = spawnManagedBridge(process.execPath, argsFor(out, err), { cwd: root });
    const events: string[] = [];
    child.once('exit', () => events.push('exit'));
    child.once('close', () => events.push('close'));
    try {
      // No consumers: Readable reaches its real 1 MiB high water mark. The root
      // exits with the remaining tail in the native pipe, just as in R133.
      await until(() => events.includes('exit'), 'native root exit under backpressure');
      const before = child.managed.bytesRead();
      const buffered = { stdout: child.stdout.readableLength, stderr: child.stderr.readableLength };
      expect(buffered.stdout).toBe(Math.min(out.length, HIGH_WATER));
      expect(buffered.stderr).toBe(Math.min(err.length, HIGH_WATER));
      await delay(140); // Multiple production poll ticks while paused.
      const after = child.managed.bytesRead();
      expect(after).toEqual(before);
      expect(events).toEqual(['exit']);
      expect(child.managed.lifecycle().stdioClosed).toBe(false);
      expect(managedActivePollers()).toBe(pollersBefore + 1);
      const output = readAll(child.stdout);
      const errors = readAll(child.stderr);
      child.stdout.once('end', () => events.push('stdout.end'));
      child.stderr.once('end', () => events.push('stderr.end'));
      const [actualOut, actualErr] = await Promise.all([output, errors]);
      await until(() => events.includes('close'), 'bridge close after drain');
      facts.push({ name, buffered, pausedBytesBefore: before, pausedBytesAfter: after,
        stdout: byteFact(out, actualOut), stderr: byteFact(err, actualErr), events: [...events],
        exitCode: child.exitCode, bytesRead: child.managed.bytesRead() });
      expect(actualOut.equals(out)).toBe(true);
      expect(actualErr.equals(err)).toBe(true);
      expect(child.managed.bytesRead()).toEqual({ stdout: out.length, stderr: err.length });
      expect(child.exitCode).toBe(0);
      expect(events[0]).toBe('exit');
      expect(events.at(-1)).toBe('close');
      expect(events.filter(e => e === 'close')).toHaveLength(1);
      expect(managedActivePollers()).toBe(pollersBefore);
      expect(child.managed.lifecycle()).toMatchObject({ rootExited: true, stdioClosed: true, finalized: false });
      expect(managedJobById(child.managedJobId)).toBe(child.managed);
    } finally {
      child.managed.dispose();
      expect(managedActivePollers()).toBe(pollersBefore);
      expect(managedJobsCount()).toBe(jobsBefore);
    }
  }

  it.each([1, 512, 2048])('stdout and stderr >1MiB with %i byte tails: stalled consumer preserves backpressure and close order', async tail => {
    await pausedBridge(`both streams tail ${tail}`, Buffer.alloc(HIGH_WATER + tail, 0x41), Buffer.alloc(HIGH_WATER + tail, 0x42));
  }, 30_000);

  const jsonPrefix = '{"result":"';
  const boundaryPayloads = [
    { name: 'JSON closing quote at boundary', text: jsonPrefix + 'A'.repeat(HIGH_WATER - jsonPrefix.length) + '"}\n' },
    { name: 'JSON opening brace at boundary', text: ' '.repeat(HIGH_WATER) + '{"result":"中文😀"}\n' },
    { name: 'UTF8 continuation at boundary', text: jsonPrefix + 'A'.repeat(HIGH_WATER - jsonPrefix.length - 1) + '中😀尾"}\n' },
  ];
  it.each(boundaryPayloads)('$name: real bridge preserves JSON and split UTF8 bytes', async ({ name, text }) => {
    const payload = Buffer.from(text);
    expect(() => JSON.parse(text)).not.toThrow();
    await pausedBridge(name, payload, Buffer.from('synthetic stderr ✓\n'));
  }, 30_000);

  it.each(['ascii-result', 'json-quote', 'utf8-start'] as const)('real Claude adapter + managed bridge: %s final text is exact', async mode => {
    const assistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'synthetic progress', id: 'a' }] } }) + '\n';
    const result = (answer: string): string => JSON.stringify({ type: 'result', subtype: 'success', result: answer }) + '\n';
    const prefixBytes = Buffer.byteLength(assistant + result('')) - 3; // trailing quote, brace, newline
    const answer = mode === 'ascii-result'
      ? 'A'.repeat(HIGH_WATER + 2048 - Buffer.byteLength(assistant + result('')))
      : 'A'.repeat(HIGH_WATER - prefixBytes) + (mode === 'utf8-start' ? '中😀尾' : '');
    const payload = Buffer.from(assistant + result(answer));
    const child: ManagedChildProcess = spawnManagedBridge(process.execPath, argsFor(payload), { cwd: root });
    const adapter = new ClaudeCliAdapter({ model: 'synthetic' }, () => child as never);
    const session = await adapter.openSession({ projectId: 'r134-local', memberId: 'r134-local', taskId: 'r134-local', threadId: 'r134-local', sessionGeneration: 0, cwd: root, policyId: 'readonly' });
    let closed = false;
    child.once('close', () => { closed = true; });
    try {
      await adapter.startTurn(session, { turnId: 'r134-stdout', dispatchKey: 'r134-stdout', text: 'synthetic only', inputBundleId: 'r134', taskRevision: 0, policyId: 'readonly' });
      child.stdout.pause();
      await until(() => child.exitCode !== null, 'adapter native root exit');
      expect(child.stdout.readableLength).toBe(HIGH_WATER);
      await delay(140);
      expect(closed).toBe(false);
      const events: NormalizedRuntimeEvent[] = [];
      const drained = (async () => {
        for await (const event of adapter.events(session)) {
          events.push(event);
          if (event.kind === 'process.exited') return;
        }
      })();
      child.stdout.resume();
      await drained;
      await until(() => closed, 'adapter bridge close');
      const completed = events.find(e => e.kind === 'turn.completed');
      const actualText = completed?.kind === 'turn.completed' ? completed.finalText ?? '' : '';
      facts.push({ name: `Claude adapter ${mode}`, ...byteFact(Buffer.from(answer), Buffer.from(actualText)),
        expectedWireBytes: payload.length, bytesRead: child.managed.bytesRead(), exitCode: child.exitCode,
        eventKinds: events.map(e => e.kind) });
      expect(events.filter(e => e.kind === 'turn.completed')).toHaveLength(1);
      expect(events.some(e => e.kind === 'turn.failed')).toBe(false);
      expect(actualText).toBe(answer);
      expect(child.managed.bytesRead().stdout).toBe(payload.length);
      expect(child.exitCode).toBe(0);
    } finally {
      child.managed.dispose();
      await adapter.close(session);
    }
  }, 30_000);
});
