/**
 * PhysicalWriteRootRegistry 单元（DEV-12 修复④）：物理目录写入占位——同目录互斥、
 * junction/父子目录重叠互斥、释放后可再取。B6 派发写档将共用同一约束点。
 */
import { describe, expect, it } from 'vitest';
import { PhysicalWriteRootRegistry } from '../../src/daemon/admission.ts';
import { lockDomainsOverlap } from '../../src/daemon/directoryIdentity.ts';

describe('物理写入占位注册表（DEV-12 修复④）', () => {
  it('同目录互斥；持有者可见；释放后可再取', () => {
    const reg = new PhysicalWriteRootRegistry(lockDomainsOverlap);
    expect(reg.tryAcquire('d:\\proj', 'undo:u1')).toEqual({ granted: true });
    const denied = reg.tryAcquire('d:\\proj', 'undo:u2');
    expect(denied.granted).toBe(false);
    if (!denied.granted) expect(denied.holders[0]).toContain('undo:u1');
    expect(reg.release('d:\\proj')).toBe(true);
    expect(reg.tryAcquire('d:\\proj', 'undo:u2')).toEqual({ granted: true });
  });

  it('父子目录重叠互斥（大小写/分隔符归一）——不能借子目录绕开单写者', () => {
    const reg = new PhysicalWriteRootRegistry(lockDomainsOverlap);
    expect(reg.tryAcquire('d:\\a\\proj', 'turn:t1')).toEqual({ granted: true });
    // 同一物理目录（win32 大小写折叠 + 分隔符差异）与父目录/子目录都被判定重叠。
    expect(reg.tryAcquire('D:/A/Proj', 'undo:u1').granted).toBe(false);
    expect(reg.tryAcquire('d:\\a\\proj\\sub', 'undo:u1').granted).toBe(false); // 子目录
    expect(reg.tryAcquire('d:\\a', 'undo:u1').granted).toBe(false); // 父目录
    // 无重叠目录不受影响。
    expect(reg.tryAcquire('e:\\other', 'undo:u1')).toEqual({ granted: true });
  });
});
