import { describe, expect, it, vi } from 'vitest';

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('../../src/ui/hifi/bridge', () => ({ command }));
import { resolveImageAttachmentAbsolutePath } from '../../src/ui/hifi/lib/imageAttachmentPaths.ts';

describe('R202 image path request lifetime', () => {
  it('merges concurrent requests but revalidates the copy for the next user operation', async () => {
    command.mockReset();
    let complete!: (value: { path: string }) => void;
    command.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const attachment = { attachmentId: 'r202-copy', filename: 'image.png' };
    const first = resolveImageAttachmentAbsolutePath(attachment, null);
    const concurrent = resolveImageAttachmentAbsolutePath(attachment, null);
    expect(command).toHaveBeenCalledTimes(1);
    complete({ path: 'C:\\profile\\image.png' });
    expect(await first).toBe('C:\\profile\\image.png');
    expect(await concurrent).toBe('C:\\profile\\image.png');
    command.mockResolvedValueOnce({ path: 'C:\\profile\\image.png' });
    await resolveImageAttachmentAbsolutePath(attachment, null);
    expect(command).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenLastCalledWith('attachment.absolutePath', { attachmentId: 'r202-copy' });
  });
});
