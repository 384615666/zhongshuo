import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectPipe } from '../../src/contracts/daemonIpc.ts';
import { isRuntimeMetadataRead } from '../../src/contracts/runtimeMetadataDeadline.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { startNamedPipeIpc } from '../../src/daemon/namedPipeIpc.ts';
import { openDatabase } from '../../src/persistence/db.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO projects(id,display_name,root_path,canonical_path,directory_identity,created_at)
    VALUES('project','Before','/fixture','/fixture','{}',0)`).run();
  db.prepare(`INSERT INTO project_members(id,project_id,display_name,principal_type,enabled)
    VALUES('agent','project','AI','agent',1)`).run();
  db.prepare(`INSERT INTO rooms(id,project_id,name,coordinator_member_id) VALUES('room','project','Room','agent')`).run();
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\zs-r187-${randomUUID()}` : join(tmpdir(), `zs-r187-${randomUUID()}.sock`);
  const started = new Map<string, ReturnType<typeof gate>>();
  const held = new Map<string, ReturnType<typeof gate>>();
  const order: string[] = [];
  const server = await startNamedPipeIpc(pipe, async raw => {
    const env = raw as { commandId: string; method: string };
    order.push(env.commandId);
    started.get(env.commandId)?.release();
    await held.get(env.commandId)?.promise;
    if (isRuntimeMetadataRead(env.method)) return { commandId: env.commandId, ok: true, data: { models: [] } };
    return dispatchDaemonCommand({ db, localUserId: 'user', interruptTurn: async () => {} }, raw);
  }, { authToken: 'r187-token' });
  const client = await connectPipe(pipe, { token: 'r187-token', requestTimeoutMs: 1500 });
  cleanups.push(async () => {
    for (const g of held.values()) g.release();
    client.close(); await server.close(); db.close();
  });
  function hold(id: string) { const start = gate(), wait = gate(); started.set(id, start); held.set(id, wait); return { start: start.promise, release: wait.release }; }
  function send(id: string, method: string, params: Record<string, unknown> = {}) {
    return client.send({ protocolVersion: 1, commandId: id, method, params }, { timeoutMs: held.has(id) ? 10_000 : 1500 });
  }
  return { hold, send, order };
}

describe('R187 runtime metadata cannot block ordinary IPC commands', () => {
  it.each(['member.runtimeCatalog', 'member.runtimeOptions'])('serves real room/member/template queries while %s waits', async method => {
    const f = await fixture(), slow = f.hold('slow-metadata');
    const reading = f.send('slow-metadata', method);
    await slow.start;
    try {
      const replies = await Promise.all([
        f.send('rooms-query', 'room.list', { projectId: 'project' }),
        f.send('workload-query', 'project.memberWorkload', { projectId: 'project' }),
        f.send('members-query', 'member.list', { projectId: 'project' }),
        f.send('templates-query', 'memberTemplate.list'),
      ]);
      expect(replies).toMatchObject([
        { commandId: 'rooms-query', ok: true, data: { items: [{ id: 'room' }] } },
        { commandId: 'workload-query', ok: true, data: { items: [{ memberId: 'agent', activeTurns: 0 }] } },
        { commandId: 'members-query', ok: true, data: { items: [{ id: 'agent' }] } },
        { commandId: 'templates-query', ok: true, data: { items: [] } },
      ]);
      // Writes also continue in order; the read process owns no daemon mutation.
      const first = f.send('first-write', 'app.settings.set', { key: 'ui.taskNotifications.enabled', value: 'false' });
      const second = f.send('second-write', 'app.settings.set', { key: 'ui.taskNotifications.enabled', value: 'true' });
      await expect(Promise.all([first, second])).resolves.toMatchObject([{ ok: true }, { ok: true }]);
      expect(f.order.indexOf('first-write')).toBeLessThan(f.order.indexOf('second-write'));
      await expect(f.send('read-setting', 'app.settings.get', { keys: ['ui.taskNotifications.enabled'] })).resolves.toMatchObject({
        ok: true, data: { values: { 'ui.taskNotifications.enabled': 'true' } },
      });
    } finally { slow.release(); await reading; }
  });

  it('waits for preceding writes but does not serialize a second metadata read behind the first', async () => {
    const f = await fixture();
    const writeGate = f.hold('project-write'), catalogGate = f.hold('catalog-read'), optionsGate = f.hold('options-read');
    const writing = f.send('project-write', 'project.update', { projectId: 'project', expectedRevision: 0, displayName: 'After' });
    await writeGate.start;
    const catalog = f.send('catalog-read', 'member.runtimeCatalog');
    const options = f.send('options-read', 'member.runtimeOptions');
    try {
      await f.send('advisory-read', 'message.writeCapability', {});
      expect(f.order).toEqual(['project-write', 'advisory-read']);
      writeGate.release();
      await Promise.all([catalogGate.start, optionsGate.start]);
      await expect(writing).resolves.toMatchObject({ ok: true, data: { project: { displayName: 'After' } } });
      await expect(f.send('still-responsive', 'room.list', { projectId: 'project' })).resolves.toMatchObject({ ok: true });
    } finally {
      writeGate.release(); catalogGate.release(); optionsGate.release();
      await Promise.allSettled([writing, catalog, options]);
    }
  });
});
