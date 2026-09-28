/**
 * DEV-12 起步：前像捕获/diff（纯函数，临时 fixture——不对真实项目做任何试验）。
 */
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFilePreimage, diffPreimages } from '../../src/domain/preimage.ts';

const root = mkdtempSync(join(tmpdir(), 'zs-preimage-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('前像捕获与 diff（DEV-12 基础）', () => {
  it('捕获 hash/size；不可读项如实记录不静默跳过', () => {
    const a = join(root, 'a.txt');
    writeFileSync(a, 'hello', 'utf8');
    const cap = captureFilePreimage([a, join(root, 'missing.txt')]);
    expect(cap.entries).toHaveLength(1);
    expect(cap.entries[0]!.size).toBe(5);
    expect(cap.entries[0]!.sha256).toHaveLength(64);
    expect(cap.unreadable).toHaveLength(1); // 前像不完整=显式事实
  });

  it('diff：added/removed/modified 三分类正确', () => {
    const dir = join(root, 'd');
    mkdirSync(dir, { recursive: true });
    const f1 = join(dir, '1.txt');
    const f2 = join(dir, '2.txt');
    const f3 = join(dir, '3.txt');
    writeFileSync(f1, 'v1', 'utf8');
    writeFileSync(f2, 'keep', 'utf8');
    const before = captureFilePreimage([f1, f2]);
    writeFileSync(f1, 'v2', 'utf8'); // modified
    writeFileSync(f3, 'new', 'utf8'); // added
    unlinkSync(f2); // removed
    const after = captureFilePreimage([f1, f2, f3]);
    const diff = diffPreimages(before, after);
    expect(diff.modified).toEqual([f1]);
    expect(diff.added).toEqual([f3]);
    expect(diff.removed).toEqual([f2]);
  });
});
