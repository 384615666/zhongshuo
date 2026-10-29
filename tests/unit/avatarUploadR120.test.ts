import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/persistence/db.ts';
import { readAppearance, writeAvatar, writeShowAvatars } from '../../src/daemon/appearance.ts';
// Keep the browser module out of the daemon TypeScript program (which has no DOM lib).
const avatarModule = '../../src/ui/hifi/data/avatarUpload.ts';
const { readAvatarFile } = await import(avatarModule);

afterEach(() => vi.unstubAllGlobals());

const png = `data:image/png;base64,${Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(3 * 1024 * 1024),
]).toString('base64')}`;

function browser(outcome: 'ok' | 'readError' | 'damaged' | 'emptyDimensions' | 'unsupported' = 'ok') {
  vi.stubGlobal('FileReader', class {
    result: string | null = null;
    onload?: () => void;
    onerror?: () => void;
    readAsDataURL() {
      if (outcome === 'readError') { this.onerror?.(); return; }
      this.result = outcome === 'unsupported' ? 'data:image/gif;base64,R0lGODlh' : png.replace('image/png', 'application/octet-stream');
      this.onload?.();
    }
  });
  vi.stubGlobal('Image', class {
    naturalWidth = outcome === 'emptyDimensions' ? 0 : 20000;
    naturalHeight = 16000;
    onload?: () => void;
    onerror?: () => void;
    set src(_value: string) { if (outcome === 'damaged') this.onerror?.(); else this.onload?.(); }
  });
}

describe('R120 avatar upload and preferences', () => {
  it('defaults to visible, preserves explicit false across avatar writes and rereads', () => {
    const db = openDatabase(':memory:');
    try {
      expect(readAppearance(db)).toEqual({ showAvatars: true, avatars: {} });
      expect(db.prepare("SELECT 1 FROM daemon_state WHERE key='appearance:show-avatars'").get()).toBeUndefined();
      writeShowAvatars(db, false);
      writeAvatar(db, 'user', png);
      expect(readAppearance(db)).toEqual({ showAvatars: false, avatars: { user: png } });
      writeShowAvatars(db, true);
      writeAvatar(db, 'user', null);
      expect(readAppearance(db)).toEqual({ showAvatars: true, avatars: {} });
    } finally { db.close(); }
  });

  it('retains backend format/signature checks without modifying the stored avatar on failure', () => {
    const db = openDatabase(':memory:');
    try {
      writeAvatar(db, 'user', png);
      for (const invalid of ['data:image/png;base64,YmFk', 'data:image/jpeg;base64,aVZCT1J3MEtHZ28=', 'https://example.invalid/avatar.png', 'data:image/svg+xml;base64,PHN2Zz4=']) {
        expect(() => writeAvatar(db, 'user', invalid)).toThrow(/有效/);
      }
      expect(readAppearance(db).avatars.user).toBe(png);
    } finally { db.close(); }
  });

  it('reads original bytes over 2 MiB, normalizes missing MIME metadata, accepts large decoded dimensions', async () => {
    browser();
    const file = new File([Buffer.alloc(3 * 1024 * 1024)], 'avatar.png');
    expect(await readAvatarFile(file)).toBe(png);
  });

  it.each(['readError', 'damaged', 'emptyDimensions', 'unsupported'] as const)('rejects %s without saving', async (outcome) => {
    browser(outcome);
    await expect(readAvatarFile(new File(['bad'], 'avatar.png'))).rejects.toThrow(/读取|损坏|无效|PNG/);
  });
});
