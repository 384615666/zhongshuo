import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingIdentityMatches } from '../../src/ui/hifi/components/Composer.tsx';

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

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { setTimeout: (fn: () => void) => { fn(); return 0; } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('R90 composer structured document refs', () => {
  it('replaces the @ query with one inline file token and strips the token from model-facing text', async () => {
    const store = await freshStore();
    store.setDraftFull('room:r1', {
      body: '@报告.pdf 请总结', mentions: [], attachments: [], access: 'default', sendAs: 'ai',
    });
    const added = store.addFileRefToDraft('room:r1', 'conv1', {
      attachmentId: 'att_report', name: '报告.pdf', kind: 'pdf_file', revision: 2, hash: 'h2',
    }, { replaceRange: { start: 0, end: '@报告.pdf'.length } });
    expect(added).toEqual({ ok: true, existed: false });
    const draft = store.getDraftFull('room:r1');
    expect(store.stripInlineAttachmentTokens(draft.body)).toBe(' 请总结');
    expect(store.parseInlineBody(draft.body).filter((segment) => segment.kind === 'attachment')).toHaveLength(1);
    expect(draft.attachments).toEqual([
      { name: '报告.pdf', size: 0, attachmentId: 'att_report', hash: 'h2', revision: 2, kind: 'pdf_file' },
    ]);
  });

  it('turns an in-flight upload token into a ready file token at its original body position', async () => {
    const store = await freshStore();
    store.setDraftFull('thread:t1', {
      body: `前文 ${store.inlineAttachmentToken({ kind: 'upload', uploadId: 'upl_1', name: '图.png', fileKind: 'image_file' })} 后文`,
      mentions: [], attachments: [], access: 'default', sendAs: 'ai',
    });
    store.addUploadItem({
      uploadId: 'upl_1', draftKey: 'thread:t1', conversationId: 'conv1',
      name: '图.png', size: 128, status: 'uploading',
    });
    expect(store.settleUploadReady('thread:t1', 'upl_1', 'conv1', {
      name: '图.png', size: 128, attachmentId: 'att_img', revision: 1, hash: 'img-hash', kind: 'image_file',
    })).toBe(true);
    const draft = store.getDraftFull('thread:t1');
    expect(store.stripInlineAttachmentTokens(draft.body)).toBe('前文  后文');
    const token = store.parseInlineBody(draft.body).find((segment) => segment.kind === 'attachment');
    expect(token?.kind === 'attachment' ? token.token : null).toMatchObject({
      kind: 'file', attachmentId: 'att_img', uploadId: 'upl_1', name: '图.png', fileKind: 'image_file', revision: 1,
    });
  });

  it('persists the per-draft deliberation budget and explicit member snapshot', async () => {
    const first = await freshStore();
    first.initDraftPersistence('r90-root|user');
    const token = first.inlineAttachmentToken({
      kind: 'file', attachmentId: 'att_budget', uploadId: 'upl_budget', name: 'brief.md', fileKind: 'text_file', revision: 3,
    });
    first.setDraftFull('room:r2', {
      body: `研讨草稿 ${token}`, mentions: [], attachments: [
        { name: 'brief.md', size: 9, attachmentId: 'att_budget', revision: 3, hash: 'b3', kind: 'text_file' },
      ], access: 'default', sendAs: 'record',
      collaboration: 'deliberate', budgetMaxTurns: 14, deliberateMemberIds: ['m1', 'm2'],
    });
    const second = await freshStore();
    second.initDraftPersistence('r90-root|user');
    expect(second.getDraftFull('room:r2')).toMatchObject({
      body: `研讨草稿 ${token}`,
      collaboration: 'deliberate',
      budgetMaxTurns: 14,
      deliberateMemberIds: ['m1', 'm2'],
    });
    expect(second.parseInlineBody(second.getDraftFull('room:r2').body).some((segment) => segment.kind === 'attachment')).toBe(true);
  });

  it('settles visible text and sent file tokens together after a successful send', async () => {
    const store = await freshStore();
    store.initDraftPersistence('r90-settle|user');
    const token = store.inlineAttachmentToken({
      kind: 'file', attachmentId: 'att_1', uploadId: 'upl_send', name: 'a.md', fileKind: 'text_file', revision: 1,
    });
    store.setDraftFull('room:r3', {
      body: `总结这份文件 ${token}`, mentions: [], attachments: [
        { name: 'a.md', size: 12, attachmentId: 'att_1', revision: 1, kind: 'text_file' },
      ], access: 'default', sendAs: 'ai',
    });
    store.addUploadItem({
      uploadId: 'upl_send', draftKey: 'room:r3', conversationId: 'conv3',
      name: 'a.md', size: 12, status: 'ready', attachmentId: 'att_1', revision: 1, kind: 'text_file',
    });
    const draft = store.getDraftFull('room:r3');
    const env = {
      commandId: 'cmd_r90_settle', method: 'message.submit' as const,
      params: {
        target: { kind: 'room_root', roomId: 'r3' }, body: '总结这份文件',
        intent: 'default' as const, mentions: [], attachmentRefs: ['att_1'],
      },
      targetLabel: 'room:r3', at: Date.now(), revAtSend: draft.rev,
    };
    store.stageOutbound('room:r3', env);
    const settled = store.settleOutbound('room:r3', env);
    expect(settled.body).toBe('');
    expect(settled.attachments).toEqual([]);
    expect(store.getState().uploadItems['room:r3'] ?? []).toEqual([]);
  });

  it('retires attachment refs when their visible file token is deleted from the editor body', async () => {
    const store = await freshStore();
    const readyToken = store.inlineAttachmentToken({
      kind: 'file', attachmentId: 'att_keep', uploadId: 'upl_keep', name: 'keep.md', fileKind: 'text_file', revision: 1,
    });
    const uploadToken = store.inlineAttachmentToken({
      kind: 'upload', uploadId: 'upl_missing', name: 'hidden.pdf',
    });
    const items = [
      { uploadId: 'upl_keep', draftKey: 'room:r4', conversationId: 'conv4', name: 'keep.md', size: 3, status: 'ready' as const, attachmentId: 'att_keep' },
      { uploadId: 'upl_missing', draftKey: 'room:r4', conversationId: 'conv4', name: 'hidden.pdf', size: 9, status: 'uploading' as const },
      { uploadId: 'upl_removed', draftKey: 'room:r4', conversationId: 'conv4', name: 'gone.md', size: 4, status: 'ready' as const, attachmentId: 'att_gone', removed: true },
    ];
    expect(store.staleAttachmentUploadIds(`保留 ${readyToken}，删除 ${uploadToken}`, items)).toEqual([]);
    expect(store.staleAttachmentUploadIds(`只保留 ${readyToken}`, items)).toEqual(['upl_missing']);
    expect(store.staleAttachmentUploadIds('文件气泡都已删除', items)).toEqual(['upl_keep', 'upl_missing']);
  });

  it('normalizes a legacy deliberate UNKNOWN envelope without a budget only when it used the same default', () => {
    const legacy = {
      commandId: 'cmd_legacy_unknown', method: 'message.submit' as const,
      params: {
        target: { kind: 'room_root' as const, roomId: 'r1' },
        body: 'legacy', intent: 'default' as const,
        mentions: [{ kind: 'member' as const, memberId: 'm1' }, { kind: 'member' as const, memberId: 'm2' }],
        collaboration: 'deliberate' as const,
      },
      targetLabel: 'room:r1', at: 1, revAtSend: 1,
    };
    expect(pendingIdentityMatches(legacy, 'legacy', ['m1', 'm2'], 'ai', [], 'deliberate', undefined, 14)).toBe(true);
    expect(pendingIdentityMatches(legacy, 'legacy', ['m1', 'm2'], 'ai', [], 'deliberate', 20, 14)).toBe(false);
    const explicit = { ...legacy, params: { ...legacy.params, deliberationBudget: { maxTurns: 14 } } };
    expect(pendingIdentityMatches(explicit, 'legacy', ['m1', 'm2'], 'ai', [], 'deliberate', 20, 14)).toBe(false);
    expect(pendingIdentityMatches(explicit, 'legacy', ['m1', 'm2'], 'ai', [], 'deliberate', undefined, 14)).toBe(true);
  });
});
