import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const loaderModule = '../../src/ui/hifi/loader.ts';
const storeModule = '../../src/ui/hifi/data/store.ts';
const fileModule = '../../src/ui/hifi/preview/fileSource.ts';
const { classifyAttachmentFile, uploadAttachmentFile, attachmentRefsFromDraft } = await import(loaderModule);
const { addUploadItem, getState, setAppearanceState, initDraftPersistence, settleUploadReady } = await import(storeModule);
import { initializeHifiSendPersistence } from '../helpers/hifiSendPersistence.ts';
const { loadFileForResource } = await import(fileModule);

afterEach(() => vi.unstubAllGlobals());

function transport() {
  const sent = vi.fn(async (envelope: { params: { contentBase64?: string }; method: string }) => {
    void envelope;
    return ({
    ok: true, data: { attachmentId: 'a_large', hash: 'hash', revision: 1,
      text: 'full text', originalBytes: 4 * 1024 * 1024,
    },
  }); });
  vi.stubGlobal('window', { zs: { command: sent } });
  return sent;
}

describe('R120 frontend file limits', () => {
  it('uses visible avatars by default and respects the loaded preference', () => {
    expect(getState().ui.showAvatars).toBe(true);
    setAppearanceState(false, {});
    expect(getState().ui.showAvatars).toBe(false);
    setAppearanceState(true, {});
  });

  it.each([
    ['large.txt', 'text'], ['large.png', 'image'], ['large.pdf', 'pdf'],
    ['large.csv', 'csv'], ['large.docx', 'office'], ['large.xlsx', 'office'], ['large.pptx', 'office'],
  ])('classifies %s without a byte ceiling', (name, cls) => {
    expect(classifyAttachmentFile(name, Number.MAX_SAFE_INTEGER)).toEqual({ cls });
  });

  it.each([
    ['large.txt', 256 * 1024 + 1, 'attachment.uploadTextRaw'],
    ['large.png', 8 * 1024 * 1024 + 1, 'attachment.uploadImage'],
    ['large.pdf', 20 * 1024 * 1024 + 1, 'attachment.uploadPdf'],
    ['large.csv', 5 * 1024 * 1024 + 1, 'attachment.uploadCsv'],
    ['large.pptx', 32 * 1024 * 1024 + 1, 'attachment.uploadOffice'],
  ])('sends %s original bytes beyond the former limit', async (name, length, method) => {
    const sent = transport();
    const bytes = new Uint8Array(length).fill(97);
    expect(await uploadAttachmentFile('conv_r120', new File([bytes], name))).toMatchObject({ attachmentId: 'a_large' });
    expect(sent).toHaveBeenCalledOnce();
    const envelope = sent.mock.calls[0]![0];
    expect(envelope.method).toBe(method);
    const uploaded = Buffer.from(envelope.params.contentBase64!, 'base64');
    expect(uploaded.length).toBe(bytes.length);
    expect(createHash('sha256').update(uploaded).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('retains file read and unsupported format errors', async () => {
    const sent = transport();
    const file = new File(['a'], 'read.txt');
    vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('read failed'));
    await expect(uploadAttachmentFile('conv_r120', file)).rejects.toThrow('read failed');
    await expect(uploadAttachmentFile('conv_r120', new File(['a'], 'file.exe'))).rejects.toThrow(/类型/);
    expect(sent).not.toHaveBeenCalled();
  });

  it('keeps every selected attachment in outgoing refs without a count cap', () => {
    initializeHifiSendPersistence({ initDraftPersistence }, 'r120-files');
    for (let i = 0; i < 120; i += 1) {
      addUploadItem({
      uploadId: `up_r120_${i}`, draftKey: 'draft_r120', conversationId: 'conv_r120',
      name: `${i}.txt`, size: 1, status: 'uploading',
    });
      settleUploadReady('draft_r120', `up_r120_${i}`, 'conv_r120', { name: `${i}.txt`, size: 1, attachmentId: `a_r120_${i}`, kind: 'text_file' });
    }
    expect(attachmentRefsFromDraft('draft_r120', 'record_only').refs).toHaveLength(120);
  });

  it('loads full attachment preview through the full-read command', async () => {
    const sent = transport();
    const loaded = await loadFileForResource({ id: 'a_large', title: 'large.txt', formalAttachment: {
      attachmentId: 'a_large', conversationId: 'conv_r120', kind: 'text_file',
    } } as Parameters<typeof loadFileForResource>[0], 1);
    expect(sent.mock.calls[0]![0].method).toBe('attachment.readFull');
    expect(loaded).toMatchObject({ text: 'full text', originalBytes: 4 * 1024 * 1024 });
  });
});
