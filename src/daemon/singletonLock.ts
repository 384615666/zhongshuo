/**
 * daemon 单实例锁（§8.3：daemon 采用单实例锁；第二个实例不再启动另一份调度器）。
 * 原子性：O_CREAT|O_EXCL 独占创建——并发启动时只有一个进程能创建成功；
 * 陈旧接管：持有 pid 已死时，先把旧锁原子 rename 移走（仅一个进程能成功），再独占创建。
 * startedAt 留档供诊断（pid 判活为主，§16.4-3 的进程身份核实随 DEV-06 补强）。
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { domainErr, domainOk } from '../contracts/errors.ts';
import type { DomainResult } from '../contracts/errors.ts';

export interface SingletonLockHandle {
  release(): void;
  readonly lockPath: string;
  readonly pid: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryExclusiveCreate(lockPath: string, content: string): boolean {
  try {
    const fd = openSync(lockPath, 'wx');
    try {
      writeSync(fd, content, 0, 'utf8');
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

export function acquireSingletonLock(appDataDir: string): DomainResult<SingletonLockHandle> {
  const lockPath = join(appDataDir, 'daemon.lock');
  mkdirSync(appDataDir, { recursive: true });
  const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });

  // 最多三轮：独占创建 → 判活 → 接管（rename 移走陈旧锁）→ 再独占创建。
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryExclusiveCreate(lockPath, content)) {
      return domainOk({
        lockPath,
        pid: process.pid,
        release() {
          try {
            const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
            if (current.pid === process.pid) rmSync(lockPath);
          } catch {
            // 释放失败不阻塞退出。
          }
        },
      });
    }
    let info: { pid: number } | undefined;
    try {
      info = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
    } catch {
      info = undefined; // 损坏/读到一半：按陈旧处理，走接管
    }
    if (info != null && Number.isFinite(info.pid) && isProcessAlive(info.pid)) {
      return domainErr(
        'WORKSPACE_BUSY',
        `daemon 已在运行（pid=${info.pid}）；第二个实例不再启动另一份调度器（§8.3）`,
      );
    }
    // 持有者已死：原子移走陈旧锁（并发时只有一个 rename 成功），重试独占创建。
    try {
      renameSync(lockPath, `${lockPath}.stale-${Date.now()}-${process.pid}`);
    } catch {
      // 他人已移走：直接进入下一轮创建。
    }
  }
  return domainErr('WORKSPACE_BUSY', '单实例锁竞争失败：并发接管未收敛，请重试启动');
}

/** 测试辅助：当前锁文件内容（诊断/断言用）。 */
export function readSingletonLock(appDataDir: string): { pid: number; startedAt: number } | undefined {
  try {
    return JSON.parse(readFileSync(join(appDataDir, 'daemon.lock'), 'utf8')) as { pid: number; startedAt: number };
  } catch {
    return undefined;
  }
}

/** 测试辅助：写入指定内容的锁文件（模拟陈旧持有者）。 */
export function writeLockFileForTest(appDataDir: string, content: string): void {
  mkdirSync(appDataDir, { recursive: true });
  const fd = openSync(join(appDataDir, 'daemon.lock'), 'w');
  try {
    writeSync(fd, content, 0, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function lockPathOf(appDataDir: string): string {
  return join(appDataDir, 'daemon.lock');
}
