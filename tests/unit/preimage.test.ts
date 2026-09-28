/**
 * DEV-12 前像三态/内容存储/diff（纯函数，临时 fixture——不对真实项目做任何试验）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, chmodSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFilePreimage, diffPreimages, scanDirectoryFiles, readStoredContent, normalizeWithinRoot } from '../../src/daemon/preimage.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-preimage-'));
const store = join(root, '.store');
const IS_WINDOWS = process.platform === 'win32';
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('前像捕获与 diff（DEV-12 三态基础）', () => {
  it('三态：present（hash/size/内容引用）/ absent（确认不存在）/ unknown（不可读如实记录）', () => {
    const a = join(root, 'a.txt');
    writeFileSync(a, 'hello', 'utf8');
    const locked = join(root, 'locked.txt');
    writeFileSync(locked, 'x', 'utf8');
    if (!IS_WINDOWS) chmodSync(locked, 0o000); // Windows 无 chmod 语义——unknown 用目录项/越界反例覆盖
    const cap = captureFilePreimage(root, ['a.txt', 'missing.txt', ...(IS_WINDOWS ? [] : ['locked.txt'])], { storeDir: store });
    const byPath = new Map(cap.entries.map((e) => [e.path, e]));
    expect(byPath.get('a.txt')).toMatchObject({ state: 'present', size: 5, contentRef: expect.any(String) });
    expect(byPath.get('a.txt')!.sha256).toHaveLength(64);
    expect(byPath.get('missing.txt')!.state).toBe('absent'); // 不存在≠读取失败——新增文件变更前即此态
    if (!IS_WINDOWS) {
      expect(byPath.get('locked.txt')!.state).toBe('unknown'); // 读取失败=未知，不静默、不推导
      expect(byPath.get('locked.txt')!.error).toBeTruthy();
    }
    // 内容存储回读核对（hash 一致才可恢复）。
    const ref = byPath.get('a.txt')!.contentRef!;
    expect(readStoredContent(store, ref)).toEqual({ ok: true, content: Buffer.from('hello', 'utf8') });
    // 篡改存储 → 核对失败（不静默恢复坏内容）。
    writeFileSync(join(store, ref), 'corrupted');
    expect(readStoredContent(store, ref).ok).toBe(false);
  });

  it('diff：added/removed/modified 三分类正确；unknown 不推导增删改（undeterminable）', () => {
    const dir = join(root, 'd');
    mkdirSync(dir, { recursive: true });
    const f1 = join(dir, '1.txt');
    const f2 = join(dir, '2.txt');
    const f3 = join(dir, '3.txt');
    writeFileSync(f1, 'v1', 'utf8');
    writeFileSync(f2, 'keep', 'utf8');
    const before = captureFilePreimage(dir, ['1.txt', '2.txt', '3.txt']);
    writeFileSync(f1, 'v2', 'utf8'); // modified
    writeFileSync(f3, 'new', 'utf8'); // added（before=absent）
    unlinkSync(f2); // removed（after=absent）
    const after = captureFilePreimage(dir, ['1.txt', '2.txt', '3.txt']);
    const diff = diffPreimages(before, after);
    expect(diff.modified).toEqual(['1.txt']);
    expect(diff.added).toEqual(['3.txt']);
    expect(diff.removed).toEqual(['2.txt']);
    // unknown 反例（after 读取失败——非 Windows chmod；Windows 用捕获面缺失反例）：
    const before2 = captureFilePreimage(dir, ['1.txt']);
    const after2 = captureFilePreimage(dir, IS_WINDOWS ? ['1.txt'] : ['1.txt'], IS_WINDOWS ? undefined : undefined);
    void after2;
    const partial = { ...before2, entries: before2.entries.map((e) => (e.path === '1.txt' ? { ...e, state: 'unknown' as const, sha256: undefined, size: undefined } : e)) };
    const diff2 = diffPreimages(before2, partial);
    expect(diff2.undeterminable).toEqual([{ path: '1.txt', reason: expect.stringContaining('未知') }]);
    expect(diff2.added).toEqual([]); // 不能因 unknown 推导删除/新增/修改
  });

  it('大小上限：超限文件保留 hash 但 contentUnavailable（内容级撤销不可用须提前呈现）', () => {
    const dir = join(root, 'cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(64), 'utf8');
    const cap = captureFilePreimage(dir, ['big.txt'], { storeDir: join(root, '.store2'), maxBytes: 16 });
    const e = cap.entries[0]!;
    expect(e.state).toBe('present');
    expect(e.sha256).toHaveLength(64);
    expect(e.contentRef).toBeUndefined();
    expect(e.contentUnavailable).toContain('上限');
  });

  it('路径纪律：越界绝对路径/.. 段拒绝；符号链接指向 root 外不跟随', () => {
    expect(() => normalizeWithinRoot(root, '../outside.txt')).toThrow(/边界|\.\./);
    const outside = mkdtempSync(join(tmpdir(), 'zs-preimage-out-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), '外部内容', 'utf8');
      const link = join(root, 'escape.md');
      try {
        symlinkSync(join(outside, 'secret.txt'), link);
      } catch {
        return; // 无符号链接权限的环境跳过（Windows 开发者模式要求）
      }
      const cap = captureFilePreimage(root, ['escape.md'], { storeDir: store });
      expect(cap.entries[0]!.state).toBe('unknown');
      expect(cap.entries[0]!.error).toContain('symlink-escape');
      expect(existsSync(join(outside, 'secret.txt'))).toBe(true); // 外部文件未被读取/修改
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('目录扫描（非 Git 整目录语义）：递归收集+排除 .git+截断如实标记', () => {
    const dir = join(root, 'scan');
    mkdirSync(join(dir, 'sub', '.git'), { recursive: true });
    writeFileSync(join(dir, 'keep.md'), 'a', 'utf8');
    writeFileSync(join(dir, 'sub', 'b.txt'), 'b', 'utf8');
    writeFileSync(join(dir, 'sub', '.git', 'HEAD'), 'ref', 'utf8'); // 排除项
    const { files, truncated } = scanDirectoryFiles(dir);
    const rel = files.map((f) => f.slice(dir.length + 1).replaceAll('\\', '/')).sort();
    expect(rel).toEqual(['keep.md', 'sub/b.txt']);
    expect(truncated).toBe(false);
    const capped = scanDirectoryFiles(dir, 1);
    expect(capped.truncated).toBe(true); // 上限如实——不假装完整快照
  });

  it('内容存储内容寻址：同内容去重复用；不同内容不同引用', () => {
    const dir = join(root, 'dedup');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'x.txt'), 'same', 'utf8');
    writeFileSync(join(dir, 'y.txt'), 'same', 'utf8');
    writeFileSync(join(dir, 'z.txt'), 'other', 'utf8');
    const cap = captureFilePreimage(dir, ['x.txt', 'y.txt', 'z.txt'], { storeDir: join(root, '.store3') });
    const [x, y, z] = cap.entries;
    expect(x!.contentRef).toBe(y!.contentRef); // 同内容同引用
    expect(x!.contentRef).not.toBe(z!.contentRef);
    expect(readFileSync(join(root, '.store3', x!.contentRef!), 'utf8')).toBe('same');
  });
});
