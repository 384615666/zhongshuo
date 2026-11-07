import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectPipe } from '../../src/contracts/daemonIpc.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { startNamedPipeIpc } from '../../src/daemon/namedPipeIpc.ts';
import { openDatabase } from '../../src/persistence/db.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const db = openDatabase(':memory:');
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\zs-r186-${randomUUID()}`
    : join(tmpdir(), `zs-r186-${randomUUID()}.sock`);
  const token = randomUUID();
  const order: string[] = [];
  const gates = new Map<string, { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const server = await startNamedPipeIpc(pipe, async raw => {
    const env = raw as { commandId: string; method: string };
    order.push(env.commandId);
    const gate = gates.get(env.commandId);
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
    }
    if (env.method.startsWith('app.settings.')) {
      return dispatchDaemonCommand({ db, localUserId: 'r186-user', interruptTurn: async () => {} }, raw);
    }
    return { commandId: env.commandId, ok: true, data: env.method };
  }, { authToken: token });
  const client = await connectPipe(pipe, { token, requestTimeoutMs: 1500 });
  cleanups.push(async () => {
    for (const gate of gates.values()) gate.release.resolve();
    client.close();
    await server.close();
    db.close();
  });
  function hold(id: string) {
    const gate = { started: deferred(), release: deferred() };
    gates.set(id, gate);
    return gate;
  }
  function send(commandId: string, method: string, params: Record<string, unknown> = {}) {
    return client.send({ protocolVersion: 1, commandId, method, params }, {
      timeoutMs: method === 'app.settings.get' ? 1500 : 10_000,
    });
  }
  const key = 'ui.taskNotifications.enabled';
  const read = (id: string) => send(id, 'app.settings.get', { keys: [key] });
  const write = (id: string, value: string) => send(id, 'app.settings.set', { key, value });
  return { pipe, order, hold, send, read, write, key };
}

describe('R186 settings reads during slow IPC operations', () => {
  it.each(['message.submit'])(
    'reads persisted settings while %s is pending; other writes keep FIFO', async method => {
      const f = await fixture();
      await expect(f.write('initial-setting', 'false')).resolves.toMatchObject({ ok: true });
      const gate = f.hold('slow');
      const slow = f.send('slow', method);
      await gate.started.promise;
      const nextWrite = f.send('next-write', 'navigation.set');
      try {
        await expect(f.read('settings')).resolves.toMatchObject({
          commandId: 'settings', ok: true, data: { values: { [f.key]: 'false' } },
        });
        expect(f.order).toEqual(['initial-setting', 'slow', 'settings']);
      } finally {
        gate.release.resolve();
        await Promise.allSettled([slow, nextWrite]);
      }
      expect(f.order).toEqual(['initial-setting', 'slow', 'settings', 'next-write']);
    },
  );

  it('waits for preceding settings writes, then reads back without waiting for later metadata', async () => {
    const f = await fixture();
    const sendGate = f.hold('sending');
    const metadataGate = f.hold('metadata');
    const sending = f.send('sending', 'message.submit');
    await sendGate.started.promise;
    const writing = f.write('write-setting', 'false');
    const metadata = f.send('metadata', 'member.runtimeCatalog');
    const reading = f.read('read-back');
    try {
      // This advisory response confirms all earlier frames reached the server.
      await f.send('hint', 'message.writeCapability');
      expect(f.order).toEqual(['sending', 'hint']);
      sendGate.release.resolve();
      await metadataGate.started.promise;
      await expect(writing).resolves.toMatchObject({ commandId: 'write-setting', ok: true });
      await expect(reading).resolves.toMatchObject({
        commandId: 'read-back', ok: true, data: { values: { [f.key]: 'false' } },
      });
    } finally {
      sendGate.release.resolve();
      metadataGate.release.resolve();
      await Promise.allSettled([sending, writing, metadata, reading]);
    }
  });

  it('keeps validation and read-back usable after a rejected settings write', async () => {
    const f = await fixture();
    await expect(f.write('initial-setting', 'false')).resolves.toMatchObject({ ok: true });
    const invalid = f.write('invalid-setting', 'not-a-boolean');
    const reading = f.read('after-rejection');
    await expect(invalid).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_INVALID' } });
    await expect(reading).resolves.toMatchObject({ ok: true, data: { values: { [f.key]: 'false' } } });
    await expect(f.send('invalid-key', 'app.settings.get', { keys: ['secret'] })).resolves.toMatchObject({ ok: false });
  });

  it('requires authentication before accepting independent settings reads', async () => {
    const f = await fixture();
    await expect(connectPipe(f.pipe, { token: 'wrong-token', connectTimeoutMs: 1000 })).rejects.toThrow('握手被拒');
    expect(f.order).toEqual([]);
    await expect(f.read('authenticated')).resolves.toMatchObject({ ok: true, data: { values: { [f.key]: null } } });
  });
});
