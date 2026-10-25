import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RecoveredSendLocation,
  SendLookupResult,
} from '../../src/contracts/sendRecovery.ts';
import type {
  HifiState,
  PendingSendEnvelope,
} from '../../src/ui/hifi/data/store.ts';
import type * as RouterModule from '../../src/ui/hifi/lib/router.ts';

const routerMock = vi.hoisted(() => ({
  seq: 0,
  navigations: [] as string[],
}));

vi.mock('../../src/ui/hifi/lib/router', async (importOriginal) => {
  const actual = await importOriginal<typeof RouterModule>();
  return {
    ...actual,
    currentNavSeq: () => routerMock.seq,
    navigate: (to: string) => {
      routerMock.navigations.push(to);
    },
  };
});

class MemoryLocalStorage {
  readonly store = new Map<string, string>();
  failing = false;

  get length(): number {
    return this.store.size;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failing) throw new Error('QuotaExceededError: R108 storage full');
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

interface CommandEnvelope {
  protocolVersion: 1;
  commandId: string;
  method: string;
  params: Record<string, unknown>;
}

interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    operationPending?: boolean;
    operationKnownRejected?: boolean;
  };
}

type CommandHandler = (envelope: CommandEnvelope) => Promise<CommandResult>;

const OLD_ATTACHMENT = {
  name: 'old.md',
  size: 10,
  attachmentId: 'att-old',
  revision: 1,
  hash: 'old-hash',
  kind: 'text_file',
};
const NEW_ATTACHMENT = {
  name: 'later.md',
  size: 20,
  attachmentId: 'att-later',
  revision: 1,
  hash: 'later-hash',
  kind: 'text_file',
};

const STORAGE = new MemoryLocalStorage();
const NAMESPACE = 'r108-send-browser|u1';
const STORAGE_KEY = `zs.hifi.persist.${NAMESPACE}`;

function fakeWindow(handler: CommandHandler): {
  window: Window & typeof globalThis;
  command: ReturnType<typeof vi.fn<CommandHandler>>;
} {
  const command = vi.fn<CommandHandler>(handler);
  const listeners = new Map<string, Set<EventListener>>();
  const location = {
    pathname: '/',
    search: '',
    hash: '',
  };
  const windowStub = {
    location,
    history: {
      replaceState: (_data: unknown, _title: string, url: string) => {
        const hashAt = url.indexOf('#');
        location.hash = hashAt >= 0 ? url.slice(hashAt) : '';
      },
    },
    addEventListener: (type: string, listener: EventListener) => {
      const set = listeners.get(type) ?? new Set<EventListener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    setTimeout: (callback: TimerHandler) => {
      if (typeof callback === 'function') callback();
      return 0;
    },
    clearTimeout: () => {},
    zs: {
      command,
      pickFolder: vi.fn(async () => null),
      openPath: vi.fn(async () => ''),
      onDisconnect: vi.fn(),
      onReconnected: vi.fn(),
    },
  };
  return {
    window: windowStub as unknown as Window & typeof globalThis,
    command,
  };
}

async function boot(handler: CommandHandler) {
  vi.resetModules();
  const { window, command } = fakeWindow(handler);
  vi.stubGlobal('window', window);
  const store = await import('../../src/ui/hifi/data/store.ts');
  const loader = await import('../../src/ui/hifi/loader.ts');
  const contract = await import('../../src/contracts/sendRecovery.ts');
  return { store, loader, contract, command };
}

function seedProjection(store: {
  setState: (updater: (state: HifiState) => HifiState) => void;
}): void {
  store.setState((state) => ({
    ...state,
    activeProjectId: 'p1',
    rooms: [{
      id: 'room1',
      conversationId: 'conversation-root',
    } as unknown as HifiState['rooms'][number]],
    threadEntities: {
      thread1: {
        id: 'thread1',
        projectId: 'p1',
        conversationId: 'conversation-thread',
        roomId: 'room1',
      } as unknown as HifiState['threadEntities'][string],
    },
  }));
}

async function createLostSend(): Promise<{
  storage: MemoryLocalStorage;
  env: PendingSendEnvelope;
  draftKey: string;
}> {
  let snapshotAtBridge: string | null = null;
  const first = await boot(async (envelope) => {
    if (envelope.method === 'message.submit') {
      snapshotAtBridge = STORAGE.getItem(STORAGE_KEY);
      throw new Error('socket disconnected before receipt');
    }
    return { ok: true, data: {} };
  });
  seedProjection(first.store);
  first.store.initDraftPersistence(NAMESPACE, 'root-r108');
  first.store.setDraftFull('thread:thread1', {
    body: '原正文，桥前必须完整保存',
    mentions: ['member1'],
    attachments: [OLD_ATTACHMENT],
    access: 'default',
    sendAs: 'ai',
  });
  const draft = first.store.getDraftFull('thread:thread1');
  const env = first.loader.buildThreadEnvelope(
    'cmd-r108-lost',
    'thread1',
    '原正文，桥前必须完整保存',
    'default',
    ['att-old'],
    { mentionIds: ['member1'] },
  );
  env.revAtSend = draft.rev;

  const outcome = await first.loader.sendEnvelope(env);
  expect(outcome.status).toBe('unknown');
  expect(snapshotAtBridge).not.toBeNull();
  const bridgeSnapshot = JSON.parse(snapshotAtBridge!) as {
    outboundLedger: Record<string, Array<PendingSendEnvelope & { stage: string }>>;
    lastSendReferences: Record<string, PendingSendEnvelope & {
      outcome: string;
      payloadHash?: string;
    }>;
  };
  expect(bridgeSnapshot.outboundLedger['thread:thread1']![0]).toMatchObject({
    commandId: 'cmd-r108-lost',
    method: 'message.submit',
    stage: 'sending',
    params: expect.objectContaining({
      target: {
        kind: 'thread',
        projectId: 'p1',
        conversationId: 'conversation-thread',
        threadId: 'thread1',
      },
      body: '原正文，桥前必须完整保存',
      intent: 'default',
      mentions: [{ kind: 'member', memberId: 'member1' }],
      attachmentRefs: ['att-old'],
    }),
  });
  expect(bridgeSnapshot.lastSendReferences['thread:thread1']).toMatchObject({
    commandId: 'cmd-r108-lost',
    outcome: 'sending',
    payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    params: expect.objectContaining({
      target: {
        kind: 'thread',
        projectId: 'p1',
        conversationId: 'conversation-thread',
        threadId: 'thread1',
      },
      body: '原正文，桥前必须完整保存',
      intent: 'default',
      mentions: [{ kind: 'member', memberId: 'member1' }],
      attachmentRefs: ['att-old'],
    }),
  });
  return { storage: STORAGE, env, draftKey: 'thread:thread1' };
}

function lookupResult(
  envelope: CommandEnvelope,
  status: 'found' | 'not-found' | 'expired',
  location?: RecoveredSendLocation,
): SendLookupResult {
  const request = envelope.params.request as {
    commandId: string;
  };
  const payloadHash = String(envelope.params.payloadHash);
  if (status === 'found') {
    return {
      status,
      commandId: request.commandId,
      payloadHash,
      location: location!,
      acceptedAt: 123456,
    };
  }
  return {
    status,
    commandId: request.commandId,
    payloadHash,
    message: status === 'expired' ? '回执已过期' : '未找到原回执',
  };
}

beforeEach(() => {
  STORAGE.clear();
  STORAGE.failing = false;
  routerMock.seq = 0;
  routerMock.navigations.length = 0;
  vi.stubGlobal('localStorage', STORAGE);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('HashChangeEvent', class HashChangeEventStub extends Event {
    constructor(type: string) {
      super(type);
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('R108 browser send recovery store + loader', () => {
  it('builds full root/thread/DM requests through one stable draft-key contract', async () => {
    const handler = vi.fn<CommandHandler>(async () => ({ ok: true, data: {} }));
    const { loader, store } = await boot(handler);
    seedProjection(store);

    const root = loader.buildRoomRootEnvelope(
      'cmd-root',
      'room1',
      'root body',
      'record_only',
      ['member1'],
      ['att-root'],
      { analysisOnly: true },
    );
    const thread = loader.buildThreadEnvelope(
      'cmd-thread',
      'thread1',
      'thread body',
      'default',
      ['att-thread'],
      { mentionIds: ['member2'] },
    );
    const dm = loader.buildDmEnvelope(
      'cmd-dm',
      'conversation-dm',
      'dm body',
      'default',
      ['att-dm'],
    );

    expect(root.params).toMatchObject({
      target: {
        kind: 'room_root',
        projectId: 'p1',
        conversationId: 'conversation-root',
        roomId: 'room1',
      },
      body: 'root body',
      intent: 'record_only',
      mentions: [{ kind: 'member', memberId: 'member1' }],
      attachmentRefs: ['att-root'],
      analysisOnly: true,
    });
    expect(thread.params).toMatchObject({
      target: {
        kind: 'thread',
        projectId: 'p1',
        conversationId: 'conversation-thread',
        threadId: 'thread1',
      },
      body: 'thread body',
      intent: 'default',
      mentions: [{ kind: 'member', memberId: 'member2' }],
      attachmentRefs: ['att-thread'],
    });
    expect(dm.params).toMatchObject({
      target: {
        kind: 'dm',
        projectId: 'p1',
        conversationId: 'conversation-dm',
      },
      body: 'dm body',
      intent: 'default',
      mentions: [],
      attachmentRefs: ['att-dm'],
    });
    expect([
      loader.sendDraftKey(root),
      loader.sendDraftKey(thread),
      loader.sendDraftKey(dm),
    ]).toEqual(['room:room1', 'thread:thread1', 'dm:conversation-dm']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('persists the complete hash-bound envelope before bridge and recovers one original command after reload', async () => {
    const lost = await createLostSend();
    const env = lost.env;
    const expectedHash = await (
      await import('../../src/contracts/sendRecovery.ts')
    ).sendRequestPayloadHash(env);
    expect(env.payloadHash).toBe(expectedHash);

    const persistedBeforeReload = JSON.parse(STORAGE.getItem(STORAGE_KEY)!) as {
      lastSendReferences: Record<string, PendingSendEnvelope & { outcome: string }>;
      outboundLedger: Record<string, Array<PendingSendEnvelope & { stage: string }>>;
    };
    expect(persistedBeforeReload.lastSendReferences['thread:thread1']).toMatchObject({
      commandId: env.commandId,
      payloadHash: expectedHash,
      outcome: 'unknown',
      params: env.params,
    });
    expect(persistedBeforeReload.outboundLedger['thread:thread1']![0]).toMatchObject({
      commandId: env.commandId,
      stage: 'sending',
      params: env.params,
    });

    const noCommands = vi.fn<CommandHandler>(async () => {
      throw new Error('reload must not dispatch');
    });
    const reloaded = await boot(noCommands);
    reloaded.store.initDraftPersistence(NAMESPACE, 'root-r108');
    const pending = reloaded.store.getState().pendingSends['thread:thread1'];
    expect(pending).toMatchObject({
      commandId: env.commandId,
      recovered: true,
      params: env.params,
    });
    expect(reloaded.store.getState().lastSendReferences['thread:thread1']).toMatchObject({
      commandId: env.commandId,
      payloadHash: expectedHash,
      outcome: 'unknown',
    });
    expect(reloaded.store.getState().outboundLedger['thread:thread1']).toBeUndefined();
    expect(noCommands).not.toHaveBeenCalled();
  });

  it('readonly lookup settles the old snapshot once and preserves later edits; accepted queries keep newer drafts', async () => {
    const lost = await createLostSend();
    const env = lost.env;
    const location: RecoveredSendLocation = {
      projectId: 'p1',
      conversationId: 'conversation-thread',
      roomId: 'room1',
      threadId: 'thread1',
      messageId: 'message-accepted',
      taskId: 'task-accepted',
    };
    const calls: CommandEnvelope[] = [];
    const lookupOnly = vi.fn<CommandHandler>(async (envelope) => {
      calls.push(envelope);
      if (envelope.method === 'message.lookupSubmission') {
        return { ok: true, data: lookupResult(envelope, 'found', location) };
      }
      throw new Error(`unexpected command ${envelope.method}`);
    });
    const reloaded = await boot(lookupOnly);
    reloaded.store.initDraftPersistence(NAMESPACE, 'root-r108');

    reloaded.store.setDraftFull('thread:thread1', {
      body: '原正文后续修订（必须保留）',
      mentions: ['member2'],
      attachments: [OLD_ATTACHMENT, NEW_ATTACHMENT],
      access: 'default',
      sendAs: 'ai',
    });
    const found = await reloaded.loader.querySubmittedSend(env);
    expect(found).toMatchObject({ status: 'found', location });
    const settled = reloaded.store.getDraftFull('thread:thread1');
    expect(settled).toMatchObject({
      body: '原正文后续修订（必须保留）',
      mentions: ['member2'],
      attachments: [NEW_ATTACHMENT],
    });
    expect(reloaded.store.getState().pendingSends['thread:thread1']).toBeUndefined();
    expect(reloaded.store.getState().outboundLedger['thread:thread1']).toBeUndefined();
    expect(reloaded.store.getState().lastSendReferences['thread:thread1']).toMatchObject({
      commandId: env.commandId,
      outcome: 'accepted',
      settled: true,
      location,
    });

    reloaded.store.setDraftFull('thread:thread1', {
      body: '第一次查询后继续写的新草稿',
      mentions: ['member3'],
      attachments: [NEW_ATTACHMENT],
      access: 'default',
      sendAs: 'ai',
    });
    const beforeAcceptedAgain = reloaded.store.getDraftFull('thread:thread1');
    expect(await reloaded.loader.querySubmittedSend(env)).toMatchObject({ status: 'found' });
    expect(reloaded.store.getDraftFull('thread:thread1')).toEqual(beforeAcceptedAgain);
    expect(calls.length).toBe(2);
    expect(calls.every((call) => call.method === 'message.lookupSubmission')).toBe(true);
    expect(calls.some((call) => call.method === 'message.submit')).toBe(false);
  });

  it.each(['not-found', 'expired'] as const)(
    'keeps the exact original envelope after %s and never sends with a replacement id',
    async (status) => {
      const lost = await createLostSend();
      const env = lost.env;
      const calls: CommandEnvelope[] = [];
      const lookupOnly = vi.fn<CommandHandler>(async (envelope) => {
        calls.push(envelope);
        return { ok: true, data: lookupResult(envelope, status) };
      });
      const reloaded = await boot(lookupOnly);
      reloaded.store.initDraftPersistence(NAMESPACE, 'root-r108');
      const beforePending = reloaded.store.getState().pendingSends['thread:thread1'];
      const beforeDraft = reloaded.store.getDraftFull('thread:thread1');

      expect(await reloaded.loader.querySubmittedSend(env)).toMatchObject({
        status,
        commandId: env.commandId,
      });
      expect(reloaded.store.getState().pendingSends['thread:thread1']).toEqual(beforePending);
      expect(reloaded.store.getDraftFull('thread:thread1')).toEqual(beforeDraft);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe('message.lookupSubmission');
      expect(calls[0]!.commandId).not.toBe(env.commandId);
      expect((calls[0]!.params.request as { commandId: string }).commandId).toBe(env.commandId);
      expect(calls.some((call) => call.method === 'message.submit')).toBe(false);
    },
  );

  it('keeps the original envelope when lookup transport is unknown and never resends', async () => {
    const lost = await createLostSend();
    const env = lost.env;
    const calls: CommandEnvelope[] = [];
    const lookupUnknown = vi.fn<CommandHandler>(async (envelope) => {
      calls.push(envelope);
      throw new Error('lookup transport disconnected');
    });
    const reloaded = await boot(lookupUnknown);
    reloaded.store.initDraftPersistence(NAMESPACE, 'root-r108');
    const beforePending = reloaded.store.getState().pendingSends['thread:thread1'];
    const beforeDraft = reloaded.store.getDraftFull('thread:thread1');

    await expect(reloaded.loader.querySubmittedSend(env)).rejects.toThrow(/transport disconnected/);
    expect(reloaded.store.getState().pendingSends['thread:thread1']).toEqual(beforePending);
    expect(reloaded.store.getDraftFull('thread:thread1')).toEqual(beforeDraft);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('message.lookupSubmission');
    expect(calls.some((call) => call.method === 'message.submit')).toBe(false);
  });

  it('keeps a late unknown from reversing a confirmed accepted settlement or clearing later draft edits', async () => {
    let rejectOutstandingSend: ((reason?: unknown) => void) | null = null;
    let submittedEnvelope: CommandEnvelope | null = null;
    const location: RecoveredSendLocation = {
      projectId: 'p1',
      conversationId: 'conversation-thread',
      roomId: 'room1',
      threadId: 'thread1',
      messageId: 'message-race-accepted',
      taskId: 'task-race-accepted',
    };
    const calls: CommandEnvelope[] = [];
    const transport = vi.fn<CommandHandler>((envelope) => {
      calls.push(envelope);
      if (envelope.method === 'message.lookupSubmission') {
        return Promise.resolve({
          ok: true,
          data: lookupResult(envelope, 'found', location),
        });
      }
      if (envelope.method === 'message.submit') {
        submittedEnvelope = envelope;
        return new Promise<CommandResult>((_resolve, reject) => {
          rejectOutstandingSend = reject;
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });
    const fx = await boot(transport);
    seedProjection(fx.store);
    fx.store.initDraftPersistence(NAMESPACE, 'root-r108');
    fx.store.setDraftFull('thread:thread1', {
      body: '等待回执的原正文',
      mentions: ['member1'],
      attachments: [OLD_ATTACHMENT],
      access: 'default',
      sendAs: 'ai',
    });
    const draft = fx.store.getDraftFull('thread:thread1');
    const env = fx.loader.buildThreadEnvelope(
      'cmd-r108-late-unknown',
      'thread1',
      '等待回执的原正文',
      'default',
      ['att-old'],
      { mentionIds: ['member1'] },
    );
    env.revAtSend = draft.rev;

    const outstandingSend = fx.loader.sendEnvelope(env);
    await vi.waitFor(() => expect(rejectOutstandingSend).not.toBeNull());
    expect(submittedEnvelope).toMatchObject({
      commandId: env.commandId,
      method: 'message.submit',
      params: env.params,
    });

    expect(await fx.loader.querySubmittedSend(env)).toMatchObject({
      status: 'found',
      location,
    });
    expect(fx.store.getState().lastSendReferences['thread:thread1']).toMatchObject({
      commandId: env.commandId,
      outcome: 'accepted',
      settled: true,
      location,
    });
    expect(fx.store.getState().outboundLedger['thread:thread1']).toBeUndefined();
    expect(fx.store.getState().pendingSends['thread:thread1']).toBeUndefined();

    fx.store.setDraftFull('thread:thread1', {
      body: '查询已确认后、原回执晚到期间的新草稿',
      mentions: ['member2'],
      attachments: [NEW_ATTACHMENT],
      access: 'default',
      sendAs: 'ai',
    });
    const laterDraft = fx.store.getDraftFull('thread:thread1');
    rejectOutstandingSend!(new Error('late socket disconnect after authoritative lookup'));

    expect(await outstandingSend).toMatchObject({
      status: 'ok',
      data: {
        taskId: location.taskId,
        threadId: location.threadId,
        disposition: 'recovered',
      },
    });
    expect(fx.store.getState().lastSendReferences['thread:thread1']).toMatchObject({
      commandId: env.commandId,
      outcome: 'accepted',
      settled: true,
      location,
    });
    expect(fx.store.getState().outboundLedger['thread:thread1']).toBeUndefined();
    expect(fx.store.getState().pendingSends['thread:thread1']).toBeUndefined();
    expect(fx.store.getDraftFull('thread:thread1')).toEqual(laterDraft);
    expect(calls.map((call) => call.method)).toEqual([
      'message.submit',
      'message.lookupSubmission',
    ]);
  });

  it('drops a late cross-project open after user navigation without taking focus', async () => {
    let resolveLookup!: (result: CommandResult) => void;
    const calls: CommandEnvelope[] = [];
    const delayed = vi.fn<CommandHandler>((envelope) => {
      calls.push(envelope);
      return new Promise<CommandResult>((resolve) => {
        resolveLookup = resolve;
      });
    });
    const fx = await boot(delayed);
    fx.store.setState((state) => ({ ...state, activeProjectId: 'project-a' }));
    const location: RecoveredSendLocation = {
      projectId: 'project-b',
      conversationId: 'conversation-b',
      roomId: 'room-b',
      threadId: 'thread-b',
      messageId: 'message-b',
      taskId: 'task-b',
    };

    const opening = fx.loader.openRecoveredSend(location);
    await Promise.resolve();
    expect(calls.map((call) => call.method)).toEqual(['deepLink.resolve']);
    expect(calls[0]!.params).toEqual({ hash: '#msg=message-b' });
    routerMock.seq += 1;
    resolveLookup({
      ok: true,
      data: {
        kind: 'task',
        projectId: 'project-b',
        conversationId: 'conversation-b',
        threadId: 'thread-b',
        taskId: 'task-b',
        rootPath: 'D:/project-b',
      },
    });
    await opening;

    expect(fx.store.getState().activeProjectId).toBe('project-a');
    expect(routerMock.navigations).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(['deepLink.resolve']);
    expect(calls.some((call) => call.method === 'message.submit')).toBe(false);
  });

  it('does not call the bridge when ordinary storage quota blocks pre-send durability', async () => {
    const calls: CommandEnvelope[] = [];
    const bridge = vi.fn<CommandHandler>(async (envelope) => {
      calls.push(envelope);
      return { ok: true, data: {} };
    });
    const fx = await boot(bridge);
    seedProjection(fx.store);
    fx.store.initDraftPersistence(NAMESPACE, 'root-r108');
    fx.store.setDraftFull('thread:thread1', {
      body: 'quota body',
      mentions: [],
      attachments: [],
      access: 'default',
      sendAs: 'ai',
    });
    const env = fx.loader.buildThreadEnvelope(
      'cmd-quota',
      'thread1',
      'quota body',
      'default',
    );
    STORAGE.failing = true;

    expect(await fx.loader.sendEnvelope(env)).toMatchObject({
      status: 'failed',
      code: 'SEND_REFERENCE_NOT_SAVED',
    });
    expect(calls).toEqual([]);
    expect(fx.store.getState().outboundLedger['thread:thread1']).toEqual([]);
    expect(fx.store.getState().draftPersist.error).toContain('持久化失败');
  });
});
