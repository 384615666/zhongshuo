/**
 * 托管存储实链接越界（第二十九轮二）：realpath 实际文件身份核对——
 * - blobstore 根被换成指向外部的 **junction**（Windows 免特权可建）：即使外部目录中有
 *   同 hash 同内容的“合法”文件，也按实际身份拒绝（字符串 resolve 检不出——realpath 检出）；
 * - blobstore 内文件级 symlink（环境允许时）同样拒绝；环境不允许（EPERM）如实跳过；
 * - 命令层（previewText）经同一共享路径拒绝。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readVerifiedCopy, readVerifiedBlob } from '../../src/daemon/attachments.ts';
import { openDatabase } from '../../src/persistence/db.ts';
import { dispatchDaemonCommand } from '../../src/daemon/commands.ts';

process.env.ZS_ALLOW_FAKE = '1';
delete process.env.ZS_APP_DATA;

const tmpRoot = mkdtempSync(join(tmpdir(), 'zs-storelinks-'));
afterAll(() => { for (let i = 0; i < 5; i += 1) { try { rmSync(tmpRoot, { recursive: true, force: true }); break; } catch { /* 句柄延迟 */ } } });

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('readVerified*：实链接身份核对', () => {
  it('blobstore 根为 junction 指向外部（含同 hash 同内容文件）→ 按实际身份拒绝', () => {
    const app = join(tmpRoot, `app-${randomUUID().slice(0, 6)}`);
    mkdirSync(join(app, 'blobstore'), { recursive: true });
    const content = Buffer.from('junction-escape-probe 链接越界探针', 'utf8');
    const hash = sha(content);
    const path = join(app, 'blobstore', `${hash}.txt`);
    writeFileSync(path, content, 'utf8');
    // 正常路径先可读（对照组）。
    const ok0 = readVerifiedCopy(path, hash, join(app, 'blobstore'));
    expect(ok0.ok).toBe(true);
    // 外部目录放入同 hash 同内容文件 → blobstore 换成指向它的 junction。
    const evil = join(tmpRoot, `evil-${randomUUID().slice(0, 6)}`);
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, `${hash}.txt`), content, 'utf8');
    renameSync(join(app, 'blobstore'), join(app, 'blobstore-real')); // 真目录让位
    symlinkSync(evil, join(app, 'blobstore'), 'junction'); // Windows junction 免特权
    const storeRoot = join(app, 'blobstore'); // 字符串路径完全一致（resolve 层无法分辨）
    const r = readVerifiedCopy(join(storeRoot, `${hash}.txt`), hash, storeRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('attachment-out-of-store');
      expect(r.error.message).toContain('链接');
    }
    const rb = readVerifiedBlob(join(app, 'blobstore2', `${hash}.bin`), hash, join(app, 'blobstore2')); // bin 布局同守卫
    expect(rb.ok).toBe(false);
    if (!rb.ok) expect(rb.error.code).toBe('attachment-out-of-store');
    // 还原（后续用例干净）。
    rmSync(join(app, 'blobstore'), { recursive: true, force: true });
    renameSync(join(app, 'blobstore-real'), join(app, 'blobstore'));
    const ok1 = readVerifiedCopy(path, hash, join(app, 'blobstore'));
    expect(ok1.ok).toBe(true);
  });
  it('文件级 symlink（环境允许时）→ 拒绝；EPERM 如实跳过', () => {
    const app = join(tmpRoot, `appf-${randomUUID().slice(0, 6)}`);
    mkdirSync(join(app, 'blobstore'), { recursive: true });
    const content = Buffer.from('file-symlink-probe', 'utf8');
    const hash = sha(content);
    writeFileSync(join(app, 'blobstore', `${hash}.txt`), content, 'utf8');
    const outside = join(tmpRoot, `outside-${randomUUID().slice(0, 6)}.txt`);
    writeFileSync(outside, content, 'utf8');
    try {
      rmSync(join(app, 'blobstore', `${hash}.txt`), { force: true }); // 让位给链接（否则 EEXIST）
      symlinkSync(outside, join(app, 'blobstore', `${hash}.txt`), 'file');
      const r = readVerifiedCopy(join(app, 'blobstore', `${hash}.txt`), hash, join(app, 'blobstore'));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('链接');
    } catch (e) {
      // Windows 无开发者模式：symlink 需特权——junction 用例已覆盖“实际身份”路径，如实跳过。
      expect(['EPERM', 'EACCES']).toContain((e as NodeJS.ErrnoException).code);
    }
  });
  it('命令层 previewText 经同一守卫拒绝 junction 化的存储根', async () => {
    const app = join(tmpRoot, `appc-${randomUUID().slice(0, 6)}`);
    mkdirSync(join(app, 'blobstore'), { recursive: true });
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO projects (id, display_name, root_path, canonical_path, directory_identity, created_at) VALUES ('p1','项目',?,?,'{}',0)`).run(tmpRoot, tmpRoot);
    db.prepare(`INSERT INTO project_members (id, project_id, display_name, principal_type, enabled) VALUES ('mA','p1','Agent甲','agent',1)`).run();
    db.prepare(`INSERT INTO conversations (id, project_id, kind, room_id) VALUES ('dm_a','p1','dm',NULL)`).run();
    db.prepare(`INSERT INTO dm_participants (project_id, conversation_id, principal_type, principal_id) VALUES ('p1','dm_a','human','u_local'),('p1','dm_a','agent','mA')`).run();
    const deps = { db, localUserId: 'u_local', interruptTurn: async () => {}, appDataDir: app };
    const up = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `sl-${randomUUID().slice(0, 8)}`, method: 'attachment.uploadText', params: { conversationId: 'dm_a', filename: '探针.txt', content: '命令层链接越界探针 LINKCMD-44' } }) as { ok: boolean; data?: { attachmentId: string } };
    expect(up.ok).toBe(true);
    const blobPath = (db.prepare('SELECT blob_path FROM artifacts WHERE id = ?').get(up.data!.attachmentId) as { blob_path: string }).blob_path;
    // blobstore → junction 指向外部同内容目录。
    const hash = (db.prepare('SELECT hash FROM artifacts WHERE id = ?').get(up.data!.attachmentId) as { hash: string }).hash;
    const evil = join(tmpRoot, `evilc-${randomUUID().slice(0, 6)}`);
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, `${hash}.txt`), '命令层链接越界探针 LINKCMD-44', 'utf8');
    renameSync(join(app, 'blobstore'), join(app, 'blobstore-real'));
    symlinkSync(evil, join(app, 'blobstore'), 'junction');
    expect(existsSync(blobPath)).toBe(true); // 经 junction 文件仍可见（字符串层无异常）
    const r = await dispatchDaemonCommand(deps, { protocolVersion: 1, commandId: `sl2-${randomUUID().slice(0, 8)}`, method: 'attachment.previewText', params: { attachmentId: up.data!.attachmentId } }) as { ok: boolean; error?: { code: string; message: string } };
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('STORAGE_UNAVAILABLE');
    expect(r.error?.message).toContain('链接');
    db.close();
  });
});

describe('readVerified*：位置无关重定位（r61——数据根/交付包整体搬移）', () => {
  it('记录的绝对路径属旧数据根 → 当前存储根同名文件可读且校验全过', () => {
    const oldRoot = join(tmpRoot, `old-${randomUUID().slice(0, 6)}`, 'server-data');
    const newRoot = join(tmpRoot, `new-${randomUUID().slice(0, 6)}`, 'server-data');
    mkdirSync(join(oldRoot, 'blobstore'), { recursive: true });
    mkdirSync(join(newRoot, 'blobstore'), { recursive: true });
    const content = Buffer.from('relocation-probe 整体搬移探针', 'utf8');
    const hash = sha(content);
    const oldPath = join(oldRoot, 'blobstore', `${hash}.txt`);
    writeFileSync(oldPath, content, 'utf8');
    // 「整体搬移」：旧根整个挪到新位置（包目录复制/移动后 state.sqlite 仍记录旧绝对路径）。
    writeFileSync(join(newRoot, 'blobstore', `${hash}.txt`), content, 'utf8');
    const r = readVerifiedCopy(oldPath, hash, join(newRoot, 'blobstore'));
    expect(r.ok).toBe(true);
    if (r.ok === true) { expect(r.copy.text).toBe(content.toString('utf8')); expect(r.copy.originalBytes).toBe(content.length); }
  });
  it('重定位后当前根文件被改写 → corrupted 拒绝（校验强度不因重定位放松）', () => {
    const oldRoot = join(tmpRoot, `old2-${randomUUID().slice(0, 6)}`, 'server-data');
    const newRoot = join(tmpRoot, `new2-${randomUUID().slice(0, 6)}`, 'server-data');
    mkdirSync(join(oldRoot, 'blobstore'), { recursive: true });
    mkdirSync(join(newRoot, 'blobstore'), { recursive: true });
    const content = Buffer.from('relocation-tamper 探针', 'utf8');
    const hash = sha(content);
    writeFileSync(join(oldRoot, 'blobstore', `${hash}.txt`), content, 'utf8');
    writeFileSync(join(newRoot, 'blobstore', `${hash}.txt`), '被改写的内容——hash 不符', 'utf8');
    const r = readVerifiedCopy(join(oldRoot, 'blobstore', `${hash}.txt`), hash, join(newRoot, 'blobstore'));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.code).toBe('attachment-corrupted');
  });
  it('重定位目标缺失（当前根没有该 hash 文件）→ unreadable 如实报错', () => {
    const oldRoot = join(tmpRoot, `old3-${randomUUID().slice(0, 6)}`, 'server-data');
    const newRoot = join(tmpRoot, `new3-${randomUUID().slice(0, 6)}`, 'server-data');
    mkdirSync(join(oldRoot, 'blobstore'), { recursive: true });
    mkdirSync(join(newRoot, 'blobstore'), { recursive: true });
    const content = Buffer.from('relocation-missing 探针', 'utf8');
    const hash = sha(content);
    writeFileSync(join(oldRoot, 'blobstore', `${hash}.txt`), content, 'utf8');
    const r = readVerifiedCopy(join(oldRoot, 'blobstore', `${hash}.txt`), hash, join(newRoot, 'blobstore'));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.code).toBe('attachment-unreadable');
  });
  it('文件名/布局不是托管形态 → 仍按 out-of-store 拒绝（重定位只认 {hash}.{ext}）', () => {
    const newRoot = join(tmpRoot, `new4-${randomUUID().slice(0, 6)}`, 'server-data');
    mkdirSync(join(newRoot, 'blobstore'), { recursive: true });
    const r = readVerifiedBlob(join(newRoot, 'elsewhere', 'evil.exe'), '0'.repeat(64), join(newRoot, 'blobstore'));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.code).toBe('attachment-out-of-store');
  });
});
