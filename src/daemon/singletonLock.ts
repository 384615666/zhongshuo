/**
 * daemon 单实例锁（§8.3：daemon 采用单实例锁；第二个实例不再启动另一份调度器）。
 * 锁文件含 pid 与启动时间；持有进程已死时允许接管（不误杀其他进程，只检测自身锁）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // Windows: OpenProcess 权限不足也抛 EPERM——有 EPERM 说明进程存在。
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireSingletonLock(appDataDir: string): DomainResult<SingletonLockHandle> {
  const lockPath = join(appDataDir, 'daemon.lock');
  mkdirSync(appDataDir, { recursive: true });
  if (existsSync(lockPath)) {
    try {
      const info = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number; startedAt: number };
      if (isProcessAlive(info.pid)) {
        return domainErr(
          'WORKSPACE_BUSY',
          `daemon 已在运行（pid=${info.pid}）；第二个实例不再启动另一份调度器（§8.3）`,
        );
      }
    } catch {
      // 损坏的锁文件（JSON 无效/读取失败）视为陈旧，允许接管。
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
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
