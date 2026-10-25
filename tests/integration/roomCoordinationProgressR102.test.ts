import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';
import { DispatchWorker } from '../../src/daemon/dispatchWorker.ts';
import { FakeRuntimeAdapter } from '../../src/adapter/fake/runtimeAdapter.ts';
import { coordinationProgressHint } from '../../src/ui/hifi/lib/coordinationProgressHint.ts';
import {seedExplicitRecipientCoordination} from '../../src/daemon/coordination.ts';
import type { ThreadVisibleProgress } from '../../src/contracts/runtimeProgress.ts';

it('hydrates live child facts in the cold room pool without opening a thread or fetching its history', async () => {
  vi.stubEnv('ZS_ALLOW_FAKE', '1'); vi.stubEnv('ZS_RUNTIME', 'fake');
  const dir = mkdtempSync(join(tmpdir(), 'zs-r102-room-progress-'));
  const project = join(dir, 'project'); mkdirSync(project);
  const db = openDatabase(join(dir, 'state.sqlite'));
  const methods: string[] = [];
  const raw = (method: string, params: unknown) => {
    methods.push(method);
    return dispatchDaemonCommand({ db, appDataDir: dir, localUserId: 'u_local', interruptTurn: async () => {} },
      { protocolVersion: 1, commandId: randomUUID(), method, params }) as Promise<{ ok: boolean; data?: unknown }>;
  };
  const cmd = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await raw(method, params);
    expect(response.ok, JSON.stringify(response)).toBe(true);
    return (response as { data: T }).data;
  };
  const adapter = new FakeRuntimeAdapter({ turnScriptSequencer: () => [
    { kind: 'event', event: { kind: 'tool.started', toolCallId: 'read_input', toolName: 'Read', argumentsSummary: 'input.md' } },
    { kind: 'stall', ms: 60_000 },
  ] });
  const worker = new DispatchWorker({ db, adapter, leaseOwner: 'r102-pool', appDataDir: dir, detachedTurnConsumption: true });
  try {
    const projectId = (await cmd<{ project: { id: string } }>('project.open', { path: project })).project.id;
    const room = (await cmd<{ items: Array<{ id: string; conversationId: string; revision: number }> }>('room.list', { projectId })).items[0]!;
    const members: string[] = [];
    for (const displayName of ['方案主持', '费用复核']) {
      const memberId = (await cmd<{ memberId: string }>('member.create', { projectId, displayName })).memberId;
      members.push(memberId);
      await cmd('member.setRuntime', { memberId, kind: 'fake', permissionMode: 'bypassPermissions' });
    }
    await cmd('room.update', { roomId: room.id, expectedRevision: room.revision, coordinatorMemberId: members[0] });
    const entry = join(dir, 'entry.ts'), bundle = join(dir, 'bundle.mjs');
    writeFileSync(entry, `export * as loader from ${JSON.stringify(resolve('src/ui/hifi/loader.ts').replaceAll('\\', '/'))}; export * as store from ${JSON.stringify(resolve('src/ui/hifi/data/store.ts').replaceAll('\\', '/'))};`);
    await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', outfile: bundle });
    vi.stubGlobal('window', { zs: { command: (env: { method: string; params: unknown }) => raw(env.method, env.params) } });
    const { loader, store } = await import(pathToFileURL(bundle).href) as {
      loader: { openProjectByPath(path: string): Promise<void>; loadRoomPool(roomId: string): Promise<void> };
      store: { getState(): { threadEntities: Record<string, unknown>; threadProgress: Record<string, { items: ThreadVisibleProgress[] }>; tasks: Array<{ id: string; status: string; latestRun?: { status: string } }> } };
    };
    await loader.openProjectByPath(project);
    const sent = await cmd<{ taskId: string; threadId: string }>('message.submit', {
      target: { kind: 'room_root', projectId, roomId: room.id, conversationId: room.conversationId },
      body: '请分别核算，由方案主持统一交付。', intent: 'default',
      mentions: members.map(memberId => ({ kind: 'member', memberId })),
    });
    // Persisted V51 child work must still hydrate after upgrade.
    db.prepare("UPDATE outbox SET status='done' WHERE dispatch_key=?").run(`task:${sent.taskId}:initial`);
    const anchor=db.prepare('SELECT root_message_id FROM tasks WHERE id=?').get(sent.taskId) as {root_message_id:string};
    seedExplicitRecipientCoordination(db,sent.taskId,anchor.root_message_id,'请分别核算，由方案主持统一交付。',members);
    await worker.runOnce();
    await vi.waitFor(() => expect(db.prepare("SELECT count(*) n FROM domain_events WHERE kind='tool.started'").get()).toEqual({ n: 1 }));
    expect(store.getState().threadEntities[sent.threadId]).toBeUndefined();
    methods.length = 0;
    await loader.loadRoomPool(room.id);
    expect(methods).toEqual(['room.pool']);
    const task = store.getState().tasks.find(item => item.id === sent.taskId)!;
    const progress = store.getState().threadProgress[sent.threadId]!.items;
    expect(task.latestRun?.status).toBe('WAITING');
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ status: 'RUNNING', activities: [{ toolCallId: 'read_input', status: 'started' }] });
    expect(coordinationProgressHint(task.status, task.latestRun?.status, progress.map(item => ({ status: item.status, memberName: '方案主持' })))?.label).toBe('成员执行中');
    expect(store.getState().threadEntities[sent.threadId]).toBeUndefined();
  } finally {
    await adapter.closeAllSessions(); await worker.awaitInFlightTurns(2_000); db.close();
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  }
}, 30_000);
