import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Composer,
  pendingIdentityMatches,
} from '../../src/ui/hifi/components/Composer.tsx';
import type {
  PendingSendEnvelope,
  ThreadTaskDetail,
} from '../../src/ui/hifi/data/store.ts';

class MemoryLocalStorage {
  store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

const storage = new MemoryLocalStorage();

async function freshStore() {
  vi.resetModules();
  return import('../../src/ui/hifi/data/store.ts');
}

function roomEnvelope(
  commandId: string,
  analysisOnly: boolean,
  revAtSend?: number,
): PendingSendEnvelope {
  return {
    commandId,
    method: 'message.submit',
    params: {
      target: { kind: 'room_root', roomId: 'r1' },
      body: '只分析这个方案',
      intent: 'default',
      mentions: [],
      analysisOnly,
    },
    targetLabel: 'room:r1',
    at: 1,
    ...(revAtSend !== undefined ? { revAtSend } : {}),
  };
}

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    setTimeout: (fn: () => void) => { fn(); return 0; },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R107 analysis-only Composer request scope', () => {
  it('persists the one-shot room-root flag across a renderer reload', async () => {
    const first = await freshStore();
    first.initDraftPersistence('r107-analysis|user');
    first.setDraftFull('room:r1', {
      body: '只分析这个方案',
      mentions: [],
      attachments: [],
      access: 'default',
      sendAs: 'ai',
      analysisOnly: true,
    });

    const second = await freshStore();
    second.initDraftPersistence('r107-analysis|user');
    expect(second.getDraftFull('room:r1')).toMatchObject({
      body: '只分析这个方案',
      analysisOnly: true,
    });
  });

  it('quarantines malformed draft and envelope values instead of restoring them', async () => {
    storage.setItem('zs.hifi.persist.r107-invalid|user', JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      drafts: {
        'room:bad-string': {
          body: 'bad', mentions: [], attachments: [], access: 'default', sendAs: 'ai', analysisOnly: 'yes',
        },
        'dm:bad-null': {
          body: 'bad', mentions: [], attachments: [], access: 'default', sendAs: 'ai', analysisOnly: null,
        },
      },
      pendingSends: {
        'room:bad-envelope': {
          commandId: 'cmd_bad_analysis',
          method: 'message.submit',
          params: {
            target: { kind: 'room_root', roomId: 'r1' },
            body: 'bad',
            intent: 'default',
            mentions: [],
            analysisOnly: 1,
          },
          targetLabel: 'room:r1',
          at: 1,
        },
      },
      uploadItems: {},
    }));

    const store = await freshStore();
    store.initDraftPersistence('r107-invalid|user');
    expect(store.getDraftFull('room:bad-string').body).toBe('');
    expect(store.getDraftFull('dm:bad-null').body).toBe('');
    expect(store.getState().pendingSends['room:bad-envelope']).toBeUndefined();
    expect(store.getState().draftPersist.recoveryNote ?? '').toContain('损坏草稿 2 条');
    expect(store.getState().draftPersist.recoveryNote ?? '').toContain('损坏未确认信封 1 条');
    expect([...storage.store.keys()].some((key) => key.includes('.quarantine-'))).toBe(true);
  });

  it('treats analysis-only as part of the UNKNOWN envelope identity', () => {
    const envelope = roomEnvelope('cmd_analysis_unknown', true);
    expect(pendingIdentityMatches(envelope, '只分析这个方案', [], 'ai', [], undefined, undefined, undefined, true)).toBe(true);
    expect(pendingIdentityMatches(envelope, '只分析这个方案', [], 'ai', [], undefined, undefined, undefined, false)).toBe(false);

    const legacy = roomEnvelope('cmd_legacy_unknown', false);
    delete legacy.params.analysisOnly;
    expect(pendingIdentityMatches(legacy, '只分析这个方案', [], 'ai', [], undefined, undefined, undefined)).toBe(true);
    expect(pendingIdentityMatches(legacy, '只分析这个方案', [], 'ai', [], undefined, undefined, undefined, true)).toBe(false);
  });

  it('resets analysis-only only when the draft revision did not change', async () => {
    const store = await freshStore();
    store.initDraftPersistence('r107-settle|user');
    store.setDraftFull('room:r1', {
      body: '只分析这个方案',
      mentions: [],
      attachments: [],
      access: 'default',
      sendAs: 'ai',
      analysisOnly: true,
    });
    const unchanged = store.getDraftFull('room:r1');
    const first = roomEnvelope('cmd_analysis_settle', true, unchanged.rev);
    expect(store.settleOutbound('room:r1', first).analysisOnly).toBe(false);

    store.setDraftFull('room:r2', {
      body: '只分析这个方案',
      mentions: [],
      attachments: [],
      access: 'default',
      sendAs: 'ai',
      analysisOnly: true,
    });
    const beforeEdit = store.getDraftFull('room:r2');
    const waiting = roomEnvelope('cmd_analysis_waiting', true, beforeEdit.rev);
    store.setDraftFull('room:r2', {
      body: '只分析这个方案',
      mentions: [],
      attachments: [],
      access: 'default',
      sendAs: 'ai',
      analysisOnly: true,
    });
    expect(store.getDraftFull('room:r2').rev).not.toBe(beforeEdit.rev);
    expect(store.settleOutbound('room:r2', waiting).analysisOnly).toBe(true);
  });

  it('retains analysis-only after explicit failure and UNKNOWN confirmation', async () => {
    const store = await freshStore();
    store.initDraftPersistence('r107-retain|user');
    store.setDraftFull('room:r1', {
      body: '只分析这个方案',
      mentions: [],
      attachments: [],
      access: 'default',
      sendAs: 'ai',
      analysisOnly: true,
    });

    const failed = roomEnvelope('cmd_analysis_failed', true);
    expect(store.stageOutbound('room:r1', failed).ok).toBe(true);
    store.dropOutbound('room:r1', failed);
    expect(store.getDraftFull('room:r1').analysisOnly).toBe(true);

    const unknown = roomEnvelope('cmd_analysis_unknown', true);
    expect(store.stageOutbound('room:r1', unknown).ok).toBe(true);
    store.confirmOutboundUnknown('room:r1', unknown);
    expect(store.getState().pendingSends['room:r1']?.params.analysisOnly).toBe(true);
    expect(store.getDraftFull('room:r1').analysisOnly).toBe(true);
  });

  it('shows the clear one-shot chip only in the room-root Composer', () => {
    const common = {
      draftKey: 'room:r1',
      onSend: () => {},
    };
    const room = renderToStaticMarkup(createElement(Composer, {
      ...common,
      target: { kind: 'room_root', roomId: 'r1' },
    }));
    const thread = renderToStaticMarkup(createElement(Composer, {
      ...common,
      draftKey: 'thread:t1',
      target: { kind: 'thread', roomId: 'r1', threadId: 't1' },
    }));
    const dm = renderToStaticMarkup(createElement(Composer, {
      ...common,
      draftKey: 'dm:c1',
      target: { kind: 'dm', roomId: 'dm:c1', dmId: 'c1' },
    }));

    expect(room).toContain('本次仅分析');
    expect(room).toContain('data-zs-analysis-only="false"');
    expect(thread).not.toContain('本次仅分析');
    expect(dm).not.toContain('本次仅分析');
  });

  it('exposes the parent task-detail pre-dispatch projection type', () => {
    const detail: Pick<ThreadTaskDetail, 'preDispatchFailure'> = { preDispatchFailure: null };
    expect(detail.preDispatchFailure).toBeNull();
  });
});
